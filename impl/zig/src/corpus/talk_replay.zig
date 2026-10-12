//! Replays a Trace Case through talk.h alone, as a Host would: each Host
//! Input becomes the C call that makes it, and the Group's Trace sink collects
//! the lines the Core writes.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const case_setup = northtalk.corpus_case;

const step1_inputs = [_][]const u8{ "load", "deliver", "request", "pump", "vars" };

/// Why talk.h can't replay the case yet, or null.
pub fn supports(a: std.mem.Allocator, setup: []const u8, trace: []const u8) ?[]const u8 {
    const s = case_setup.read(a, setup) catch return "case.toml isn't read";
    for (s.units) |u| {
        if (u.library) return "Libraries are not implemented";
        if (u.grants.len > 0) return "Grants are not implemented";
        if (u.objects.len > 0) return "Host Objects are not implemented";
    }
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "> ")) continue;
        const input = line[2..];
        const name = input[0 .. std.mem.indexOfScalar(u8, input, ' ') orelse input.len];
        for (step1_inputs) |known| {
            if (std.mem.eql(u8, known, name)) break;
        } else return "a Host Input talk.h doesn't make yet";
        if (std.mem.indexOf(u8, input, " limits=") != null or std.mem.indexOf(u8, input, " fuel-slice=") != null or std.mem.indexOf(u8, input, " fuel-cap=") != null) return "limits are not implemented";
        if (std.mem.eql(u8, name, "deliver") or std.mem.eql(u8, name, "request")) {
            const to = field(input, "to") orelse return "a Delivery without a target";
            for (s.units) |u| {
                if (std.mem.eql(u8, u.name, to)) break;
            } else return "Deliveries to objects are not implemented";
        }
    }
    return null;
}

/// The value of `key=` in a Host Input, up to the next ` key=` or the end.
fn field(line: []const u8, key: []const u8) ?[]const u8 {
    var buf: [32]u8 = undefined;
    const needle = std.fmt.bufPrint(&buf, " {s}=", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    const start = at + needle.len;
    var depth: usize = 0;
    var quoted = false;
    var i = start;
    while (i < line.len) : (i += 1) {
        const ch = line[i];
        if (ch == '"') quoted = !quoted;
        if (quoted) continue;
        if (ch == '[' or ch == '{' or ch == '<') depth += 1;
        if ((ch == ']' or ch == '}' or ch == '>') and depth > 0) depth -= 1;
        if (ch == ' ' and depth == 0) {
            const rest = line[i + 1 ..];
            const eq = std.mem.indexOfScalar(u8, rest, '=') orelse continue;
            const sp = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
            if (eq < sp) return line[start..i];
        }
    }
    return line[start..];
}

const Sink = struct {
    gpa: std.mem.Allocator,
    out: std.ArrayList(u8) = .empty,
    failed: bool = false,
};

fn record(context: ?*anyopaque, line: [*c]const u8, len: usize) callconv(.c) void {
    const sink: *Sink = @ptrCast(@alignCast(context.?));
    sink.out.appendSlice(sink.gpa, line[0..len]) catch {
        sink.failed = true;
        return;
    };
    sink.out.append(sink.gpa, '\n') catch {
        sink.failed = true;
    };
}

fn check(code: c.talk_host_error_code) !void {
    if (code != c.TALK_OK) return error.HostError;
}

/// Replays the case in `dir` and returns the Trace the Core wrote.
pub fn replay(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, setup: []const u8, trace: []const u8) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const s = try case_setup.read(a, setup);
    const core = c.talk_new() orelse return error.OutOfMemory;
    defer c.talk_core_release(core);
    var sink: Sink = .{ .gpa = gpa };
    errdefer sink.out.deinit(gpa);
    var group: ?*c.talk_group = null;
    const options: c.talk_group_options = .{ .name = "corpus", .name_len = 6, .trace = record, .trace_context = &sink };
    try check(c.talk_new_group(core, &options, &group));
    defer c.talk_group_release(group);
    var scripts: std.StringHashMapUnmanaged(*c.talk_script) = .empty;
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "> ")) continue;
        const input = line[2..];
        const name_end = std.mem.indexOfScalar(u8, input, ' ') orelse input.len;
        const name = input[0..name_end];
        if (std.mem.eql(u8, name, "load")) {
            const rest = input[name_end + 1 ..];
            const script = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const unit = for (s.units) |u| {
                if (std.mem.eql(u8, u.name, script)) break u;
            } else return error.UnknownScript;
            const source = try dir.readFileAlloc(io, unit.source, a, .unlimited);
            const load: c.talk_load_options = .{ .name = script.ptr, .name_len = script.len, .source = source.ptr, .source_len = source.len };
            var loaded: ?*c.talk_script = null;
            const code = c.talk_load(group, &load, &loaded);
            if (code == c.TALK_LOAD_REFUSED) continue;
            try check(code);
            try scripts.put(a, script, loaded.?);
        } else if (std.mem.eql(u8, name, "deliver") or std.mem.eql(u8, name, "request")) {
            const to = scripts.get(field(input, "to").?) orelse return error.UnknownScript;
            const message = field(input, "message").?;
            var args: std.ArrayList(?*c.talk_value) = .empty;
            defer for (args.items) |v| c.talk_value_release(v);
            if (field(input, "args")) |shown| {
                var list: ?*c.talk_value = null;
                try check(c.talk_parse_display(shown.ptr, shown.len, &list));
                defer c.talk_value_release(list);
                for (0..c.talk_value_len(list)) |i| {
                    var item: ?*c.talk_value = null;
                    try check(c.talk_value_index(list, i + 1, &item));
                    try args.append(a, item);
                }
            }
            const m: c.talk_message = .{ .name = message.ptr, .name_len = message.len, .args = @ptrCast(args.items.ptr), .args_len = args.items.len };
            if (std.mem.eql(u8, name, "deliver")) {
                try check(c.talk_script_deliver(to, &m, null));
            } else {
                var pending: ?*c.talk_pending = null;
                try check(c.talk_script_request(to, &m, null, &pending));
            }
        } else if (std.mem.eql(u8, name, "pump")) {
            const clock = field(input, "clock").?;
            var instant: ?*c.talk_value = null;
            try check(c.talk_parse_display(clock.ptr, clock.len, &instant));
            defer c.talk_value_release(instant);
            var seconds: i64 = 0;
            var nanos: i32 = 0;
            if (!c.talk_value_as_instant(instant, &seconds, &nanos)) return error.BadClock;
            try check(c.talk_pump(group, seconds, nanos, null, null));
        } else if (std.mem.eql(u8, name, "vars")) {
            c.talk_inspect(group);
        } else return error.Unsupported;
    }
    if (sink.failed) return error.OutOfMemory;
    return sink.out.toOwnedSlice(gpa);
}

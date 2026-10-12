//! Replays a Trace Case's Host Inputs against a Group and returns the Trace
//! the Group writes, for comparison with the case's (chapter 11, Normal
//! replay). Step 1 replays loads, Deliveries, Requests, Pumps and `vars`.
const std = @import("std");
const Allocator = std.mem.Allocator;
const machine = @import("../machine/machine.zig");
const case_setup = @import("case.zig");
const display = @import("../display.zig");
const model = @import("../value.zig");
const check = @import("../check/check.zig");

/// The value of `key=` in a Host Input, up to the next ` key=` or the end.
fn field(line: []const u8, key: []const u8) ?[]const u8 {
    var buf: [32]u8 = undefined;
    const needle = std.fmt.bufPrint(&buf, " {s}=", .{key}) catch return null;
    const at = std.mem.indexOf(u8, line, needle) orelse return null;
    const start = at + needle.len;
    // Values may hold spaces; the next key starts with ` <word>=` outside
    // quotes and brackets.
    var depth: usize = 0;
    var quoted = false;
    var i = start;
    while (i < line.len) : (i += 1) {
        const c = line[i];
        if (c == '"') quoted = !quoted;
        if (quoted) continue;
        if (c == '[' or c == '{' or c == '<') depth += 1;
        if ((c == ']' or c == '}' or c == '>') and depth > 0) depth -= 1;
        if (c == ' ' and depth == 0) {
            const rest = line[i + 1 ..];
            const eq = std.mem.indexOfScalar(u8, rest, '=') orelse continue;
            const sp = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
            if (eq < sp) return line[start..i];
        }
    }
    return line[start..];
}

/// Replays the case in `dir`, whose setup and expected Trace are given.
pub fn replay(a: Allocator, gpa: Allocator, io: std.Io, dir: std.Io.Dir, toml: []const u8, expected: []const u8) ![]u8 {
    const setup = case_setup.read(a, toml) catch return error.Unsupported;
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var group = machine.Group.init(gpa, &out.writer);
    defer group.deinit();
    var lines = std.mem.splitScalar(u8, expected, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "> ")) continue;
        const input = line[2..];
        const name_end = std.mem.indexOfScalar(u8, input, ' ') orelse input.len;
        const name = input[0..name_end];
        if (std.mem.eql(u8, name, "load")) {
            const rest = input[name_end + 1 ..];
            const script = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const unit = for (setup.units) |u| {
                if (std.mem.eql(u8, u.name, script)) break u;
            } else return error.Unsupported;
            const source = try dir.readFileAlloc(io, unit.source, a, .unlimited);
            _ = try group.load(script, source, .{ .context = .{ .objects = unit.objects, .grants = unit.grants } });
        } else if (std.mem.eql(u8, name, "deliver") or std.mem.eql(u8, name, "request")) {
            const to = field(input, "to") orelse return error.Unsupported;
            const message = field(input, "message") orelse return error.Unsupported;
            var args: []*model.Value = &.{};
            if (field(input, "args")) |shown| {
                const list = display.parse(gpa, shown, .{}) catch return error.Unsupported;
                defer list.release();
                args = try gpa.alloc(*model.Value, list.data.list.len);
                for (args, list.data.list) |*x, v| x.* = v.retain();
            }
            defer gpa.free(args);
            _ = try group.deliver(to, message, args, std.mem.eql(u8, name, "request"));
        } else if (std.mem.eql(u8, name, "pump")) {
            const clock = model.dates.parseInstant(field(input, "clock") orelse return error.Unsupported) catch return error.Unsupported;
            try group.pump(clock);
        } else if (std.mem.eql(u8, name, "vars")) {
            group.vars();
        } else return error.Unsupported;
    }
    return out.toOwnedSlice();
}

const testing = std.testing;
const trace = @import("trace.zig");

/// The cases step 1's machine replays.
const replayed = [_][]const u8{
    "text-model/host-text-joins-in-nfc",
    "text-model/chunk-read-out-of-range",
    "text-model/chunk-write-padding",
    "text-model/nfc-at-join-seams",
    "text-model/word-chunks-keep-punctuation",
};

test "replayed Trace Cases give their Traces" {
    const io = testing.io;
    var failures: usize = 0;
    for (replayed) |name| {
        var arena: std.heap.ArenaAllocator = .init(testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const path = try std.fmt.allocPrint(a, "../../corpus/{s}", .{name});
        var dir = try std.Io.Dir.cwd().openDir(io, path, .{});
        defer dir.close(io);
        const toml = try dir.readFileAlloc(io, "case.toml", a, .unlimited);
        const expected = try dir.readFileAlloc(io, "case.trace", a, .unlimited);
        const actual = try replay(a, testing.allocator, io, dir, toml, expected);
        defer testing.allocator.free(actual);
        var want = std.mem.splitScalar(u8, expected, '\n');
        var got = std.mem.splitScalar(u8, actual, '\n');
        while (true) {
            const x = nextRecord(&want);
            const y = nextRecord(&got);
            if (x == null and y == null) break;
            if (x == null or y == null or !try trace.matches(a, x.?, y.?)) {
                failures += 1;
                std.debug.print("{s}:\n  expected: {s}\n  actual:   {s}\n", .{ name, x orelse "<end>", y orelse "<end>" });
                break;
            }
        }
    }
    try testing.expectEqual(@as(usize, 0), failures);
}

fn nextRecord(lines: *std.mem.SplitIterator(u8, .scalar)) ?[]const u8 {
    while (lines.next()) |line| if (line.len > 0 and line[0] != '#') return line;
    return null;
}

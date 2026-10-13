//! Replays a Trace Case through talk.h alone, as a Host would: each Host
//! Input becomes the C call that makes it, and the Group's Trace sink collects
//! the lines the Core writes.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const case_setup = northtalk.corpus_case;

const step1_inputs = [_][]const u8{ "load", "deliver", "request", "pump", "vars", "counters", "stub", "stub-effect", "decide", "broadcast", "decide-broadcast", "answer", "fail", "set-parent", "dispose", "add-library", "revoke", "cancel-run", "cancel-delivery", "stop", "rewind-run", "call-value", "reload", "extend", "replace-library", "save", "restore", "settle" };

/// Why talk.h can't replay the case yet, or null.
pub fn supports(a: std.mem.Allocator, setup: []const u8, trace: []const u8) ?[]const u8 {
    const s = case_setup.read(a, setup) catch return "case.toml isn't read";
    if (grantsUnsupported(a, setup)) |why| return why;
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "> ")) continue;
        const input = line[2..];
        const name = input[0 .. std.mem.indexOfScalar(u8, input, ' ') orelse input.len];
        for (step1_inputs) |known| {
            if (std.mem.eql(u8, known, name)) break;
        } else return "a Host Input talk.h doesn't make yet";
        if (std.mem.eql(u8, name, "deliver") or std.mem.eql(u8, name, "request") or std.mem.eql(u8, name, "decide")) {
            const to = field(input, "to") orelse return "a Delivery without a target";
            if (std.mem.startsWith(u8, to, "<object ")) continue;
            for (s.units) |u| {
                if (std.mem.eql(u8, u.name, to)) break;
            } else return "a Delivery to a Script the case doesn't load";
        }
    }
    return null;
}

/// The Standard Capabilities talk.h makes so far.
const standard_made = [_][]const u8{ "clock", "calendar", "locale", "timer", "console", "store", "sqlite", "user" };

/// Why talk.h can't make the case's Grants yet, or null: only Operations the
/// case declares itself and the Standard Capabilities made so far are.
fn grantsUnsupported(a: std.mem.Allocator, setup: []const u8) ?[]const u8 {
    const all = case_setup.tables(a, setup) catch return "case.toml isn't read";
    for (all) |t| {
        if (std.mem.eql(u8, t.header, "[[standard]]")) {
            const which = (case_setup.field(t, "capability") orelse return "a Standard Capability without a name").string;
            for (standard_made) |made| {
                if (std.mem.eql(u8, made, which)) break;
            } else return "a Standard Capability the Core doesn't define";
        }
        if (!std.mem.eql(u8, t.header, "[[operations]]")) continue;
        const mode = case_setup.field(t, "mode") orelse return "an Operation without a mode";
        if (mode != .string) return "an Operation without a mode";
        for ((case_setup.field(t, "args") orelse continue).array) |shape| if (!shapeSupported(shape)) return "object Shapes are not implemented";
    }
    return null;
}

fn shapeSupported(v: case_setup.Value) bool {
    return switch (v) {
        .string => true,
        .table => v.get("object") == null and blk: {
            if (v.get("list")) |x| break :blk shapeSupported(x);
            if (v.get("optional")) |x| break :blk shapeSupported(x);
            if (v.get("oneOf")) |xs| for (xs.array) |x| {
                if (!shapeSupported(x)) break :blk false;
            };
            if (v.get("map")) |fields| for (fields.array) |f| {
                if (!shapeSupported(f.get("shape") orelse break :blk false)) break :blk false;
            };
            break :blk true;
        },
        else => false,
    };
}

/// The Library names a source's `use` lines import.
fn usedLibraries(a: std.mem.Allocator, source: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (!std.mem.startsWith(u8, line, "use ")) continue;
        const from = std.mem.indexOf(u8, line, " from ") orelse continue;
        const rest = line[from + 6 ..];
        try out.append(a, rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len]);
    }
    return out.items;
}

/// Compiles the case's Libraries, each once those it imports are compiled.
fn compileLibraries(a: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, core: ?*c.talk_core, all: []const case_setup.Table, defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def), effects: *Effects, out: *std.StringHashMapUnmanaged(*c.talk_library), declarations: *std.ArrayList(c.talk_load_grant)) !void {
    // The Grant declarations: each Capability the case defines, by its name.
    var it = defs.iterator();
    while (it.next()) |e| {
        var grant: ?*c.talk_grant = null;
        // A coordinated Grant needs a binding of its own.
        var binding: ?*anyopaque = if (std.mem.eql(u8, e.key_ptr.*, "sqlite")) &effects.sqlite_binding else null;
        if (effects.coordinated.contains(e.key_ptr.*)) {
            binding = @ptrCast(@constCast((try a.dupeSentinel(u8, "", 0)).ptr));
            try effects.names.put(a, @intFromPtr(binding), null);
        }
        try check(c.talk_capability_def_grant_all(e.value_ptr.*, binding, &grant));
        try declarations.append(a, .{ .name = e.key_ptr.ptr, .name_len = e.key_ptr.len, .grant = grant });
    }
    var left: std.ArrayList(case_setup.Table) = .empty;
    for (all) |t| if (std.mem.eql(u8, t.header, "[[libraries]]")) try left.append(a, t);
    while (left.items.len > 0) {
        var progressed = false;
        var i: usize = 0;
        while (i < left.items.len) {
            const t = left.items[i];
            const source = try dir.readFileAlloc(io, case_setup.field(t, "source").?.string, a, .unlimited);
            var imports: std.ArrayList(?*c.talk_library) = .empty;
            const ready = for (try usedLibraries(a, source)) |name| {
                const named = for (left.items) |x| {
                    if (std.mem.eql(u8, case_setup.field(x, "name").?.string, name)) break true;
                } else false;
                if (named) break false;
                if (out.get(name)) |l| try imports.append(a, l);
            } else true;
            if (!ready) {
                i += 1;
                continue;
            }
            const name = case_setup.field(t, "name").?.string;
            const label = if (case_setup.field(t, "version")) |v| v.string else "";
            const src: c.talk_library_source = .{ .name = name.ptr, .name_len = name.len, .version = label.ptr, .version_len = label.len, .source = source.ptr, .source_len = source.len };
            var l: ?*c.talk_library = null;
            try check(c.talk_compile_library(core, &src, imports.items.ptr, imports.items.len, declarations.items.ptr, declarations.items.len, &l));
            try out.put(a, name, l.?);
            _ = left.orderedRemove(i);
            progressed = true;
        }
        if (!progressed) return error.MalformedCase;
    }
}

/// The case's Host Objects: their property values, which each Get reads
/// and each Set writes, by object and property.
const ObjectStore = struct {
    a: std.mem.Allocator,
    values: std.AutoHashMapUnmanaged(usize, std.StringHashMapUnmanaged(?*c.talk_value)) = .empty,
    /// Every handle, by `<kind>/<id>`.
    handles: std.StringHashMapUnmanaged(*c.talk_object) = .empty,

    fn deinit(store: *ObjectStore) void {
        var it = store.values.valueIterator();
        while (it.next()) |props| {
            var vs = props.valueIterator();
            while (vs.next()) |v| c.talk_value_release(v.*);
        }
    }

    /// Moves every handle, and the values its properties hold, to the
    /// restored Group's handle with the same kind and id.
    fn moveTo(store: *ObjectStore, group: ?*c.talk_group) !void {
        var it = store.handles.iterator();
        while (it.next()) |e| {
            const key = e.key_ptr.*;
            const slash = std.mem.indexOfScalar(u8, key, '/').?;
            var o: ?*c.talk_object = null;
            if (!c.talk_object_by_id(group, key.ptr, slash, key[slash + 1 ..].ptr, key.len - slash - 1, &o)) continue;
            if (store.values.fetchRemove(@intFromPtr(e.value_ptr.*))) |kv| try store.values.put(store.a, @intFromPtr(o.?), kv.value);
            e.value_ptr.* = o.?;
        }
    }

    /// The handle `<object kind "id">` names.
    fn named(store: *ObjectStore, shown: []const u8) ?*c.talk_object {
        const rest = shown["<object ".len..];
        const sp = std.mem.indexOfScalar(u8, rest, ' ') orelse return null;
        const q = std.mem.lastIndexOfScalar(u8, rest, '"') orelse return null;
        var buf: [256]u8 = undefined;
        const key = std.fmt.bufPrint(&buf, "{s}/{s}", .{ rest[0..sp], rest[sp + 2 .. q] }) catch return null;
        return store.handles.get(key);
    }
};

const PropHost = struct { store: *ObjectStore, name: []const u8 };

fn propGet(context: ?*anyopaque, o: ?*c.talk_object, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
    _ = err;
    cross();
    const h: *PropHost = @ptrCast(@alignCast(context.?));
    const props = h.store.values.getPtr(@intFromPtr(o.?)) orelse return c.TALK_CALL_BROKEN;
    const v = props.get(h.name) orelse return c.TALK_CALL_BROKEN;
    c.talk_value_retain(v);
    result.* = v;
    return c.TALK_CALL_ANSWERED;
}

fn propSet(context: ?*anyopaque, o: ?*c.talk_object, v: ?*const c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
    _ = err;
    cross();
    const h: *PropHost = @ptrCast(@alignCast(context.?));
    const props = h.store.values.getPtr(@intFromPtr(o.?)) orelse return c.TALK_CALL_BROKEN;
    c.talk_value_retain(@constCast(v));
    const old = props.fetchPut(h.store.a, h.name, @constCast(v)) catch return c.TALK_CALL_BROKEN;
    if (old) |x| c.talk_value_release(x.value);
    return c.TALK_CALL_ANSWERED;
}

/// Defines the case's Object Kinds from `[[objectKinds]]` and makes its
/// objects from `[[objects]]`, with their initial property values.
fn defineObjects(a: std.mem.Allocator, core: ?*c.talk_core, group: ?*c.talk_group, all: []const case_setup.Table, store: *ObjectStore) !void {
    var kinds: std.StringHashMapUnmanaged(?*c.talk_object_kind) = .empty;
    for (all, 0..) |t, at| {
        if (!std.mem.eql(u8, t.header, "[[objectKinds]]")) continue;
        const name = case_setup.field(t, "name").?.string;
        // Its properties: an inline list, or `[[objectKinds.props]]` tables
        // right after it.
        var declared: std.ArrayList(case_setup.Value) = .empty;
        if (case_setup.field(t, "props")) |list| try declared.appendSlice(a, list.array);
        for (all[at + 1 ..]) |x| {
            if (!std.mem.eql(u8, x.header, "[[objectKinds.props]]")) break;
            try declared.append(a, .{ .table = x.entries });
        }
        var props: std.ArrayList(c.talk_prop) = .empty;
        for (declared.items) |p| {
            const prop_name = p.get("name").?.string;
            const prop_host = try a.create(PropHost);
            prop_host.* = .{ .store = store, .name = prop_name };
            const read_only = if (p.get("readOnly")) |x| x == .raw and std.mem.eql(u8, x.raw, "true") else false;
            const get_cost = p.get("getCost");
            const set_cost = p.get("setCost");
            try props.append(a, .{
                .name = prop_name.ptr,
                .name_len = prop_name.len,
                .shape = try shapeOf(p.get("shape") orelse .{ .string = "any" }),
                .get = propGet,
                .set = if (read_only) null else propSet,
                .context = prop_host,
                .get_cost = .{ .fuel = number(if (get_cost) |x| x.get("fuel") else null), .alloc = number(if (get_cost) |x| x.get("alloc") else null) },
                .set_cost = .{ .fuel = number(if (set_cost) |x| x.get("fuel") else null), .alloc = number(if (set_cost) |x| x.get("alloc") else null) },
            });
        }
        defer for (props.items) |p| c.talk_shape_release(p.shape);
        const def: c.talk_object_kind_def = .{ .name = name.ptr, .name_len = name.len, .props = props.items.ptr, .props_len = props.items.len };
        var kind: ?*c.talk_object_kind = null;
        try check(c.talk_define_object_kind(core, &def, &kind));
        try kinds.put(a, name, kind);
    }
    for (all) |t| {
        if (!std.mem.eql(u8, t.header, "[[objects]]")) continue;
        const kind = case_setup.field(t, "kind").?.string;
        const id = case_setup.field(t, "id").?.string;
        var o: ?*c.talk_object = null;
        try check(c.talk_group_object(group, kinds.get(kind) orelse return error.MalformedCase, id.ptr, id.len, null, &o));
        try store.handles.put(a, try std.fmt.allocPrint(a, "{s}/{s}", .{ kind, id }), o.?);
        var props: std.StringHashMapUnmanaged(?*c.talk_value) = .empty;
        if (case_setup.field(t, "props")) |given| for (given.table) |e| {
            try props.put(a, e.key, parsed(e.value.string) orelse return error.MalformedCase);
        };
        try store.values.put(a, @intFromPtr(o.?), props);
    }
}

/// The handle a case's `{ kind, id }` table names.
fn objectNamed(store: *ObjectStore, a: std.mem.Allocator, v: case_setup.Value) !*c.talk_object {
    const key = try std.fmt.allocPrint(a, "{s}/{s}", .{ v.get("kind").?.string, v.get("id").?.string });
    return store.handles.get(key) orelse error.MalformedCase;
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
    /// While the runner saves and restores between Pumps, the lines it
    /// causes are left out, and the save ids it takes are counted, so that a
    /// case's own saves keep their ids.
    hidden: bool = false,
    hidden_saves: u64 = 0,
    /// Each of the case's own saves, by the id the Core gave it.
    renamed: std.AutoHashMapUnmanaged(u64, u64) = .empty,
    /// The calls the runner adopted, whose `settle` lines the next Pump
    /// writes as it drains them.
    adopted: std.ArrayList([]const u8) = .empty,

    fn line(sink: *Sink, text: []const u8) !void {
        if (sink.hidden) {
            if (std.mem.startsWith(u8, text, "> save s")) sink.hidden_saves += 1;
            return;
        }
        if (std.mem.startsWith(u8, text, "> settle ") and std.mem.endsWith(u8, text, " how=adopt")) {
            const id = text["> settle ".len .. text.len - " how=adopt".len];
            for (sink.adopted.items, 0..) |x, i| if (std.mem.eql(u8, x, id)) {
                _ = sink.adopted.orderedRemove(i);
                return;
            };
        }
        if (std.mem.startsWith(u8, text, "> save s")) {
            const n = std.fmt.parseInt(u64, text["> save s".len..], 10) catch return sink.out.appendSlice(sink.gpa, text);
            try sink.renamed.put(sink.gpa, n, n - sink.hidden_saves);
            return sink.out.print(sink.gpa, "> save s{d}", .{n - sink.hidden_saves});
        }
        if (std.mem.startsWith(u8, text, "> restore from=s")) {
            const rest = text["> restore from=s".len..];
            const end = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
            const n = std.fmt.parseInt(u64, rest[0..end], 10) catch return sink.out.appendSlice(sink.gpa, text);
            return sink.out.print(sink.gpa, "> restore from=s{d}{s}", .{ sink.renamed.get(n) orelse n, rest[end..] });
        }
        try sink.out.appendSlice(sink.gpa, text);
    }
};

fn record(context: ?*anyopaque, line: [*c]const u8, len: usize) callconv(.c) void {
    const sink: *Sink = @ptrCast(@alignCast(context.?));
    if (sink.hidden) {
        sink.line(line[0..len]) catch {};
        return;
    }
    sink.line(line[0..len]) catch {
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

// ---------------------------------------------------------------- Capabilities

/// What a Stub queues for one call: a result or an error, and a charge.
const Stub = struct { value: ?[]const u8 = null, err: ?[]const u8 = null, charge: ?i64 = null };

/// The runner's Host function for one Operation: its Stubs, in order.
/// The Host Inputs a case makes during a Pump, from inside a Host
/// function: each after the Host crossing whose `call` or `prop` record it
/// follows in the Pump's output, so that it lands there.
const Crossing = struct {
    group: ?*c.talk_group,
    scripts: *std.StringHashMapUnmanaged(*c.talk_script),
    store: *ObjectStore,
    inputs: []const struct { at: usize, line: []const u8 },
    count: usize = 0,
    next: usize = 0,
    failed: bool = false,
};

var crossing: ?*Crossing = null;

/// Counts a Host crossing, and makes the inputs that follow it.
fn cross() void {
    const x = crossing orelse return;
    x.count += 1;
    while (x.next < x.inputs.len and x.inputs[x.next].at == x.count) : (x.next += 1) {
        crossInput(x, x.inputs[x.next].line) catch {
            x.failed = true;
        };
    }
}

/// A Stop, CancelRun or RewindRun made inside a Host function.
fn crossInput(x: *Crossing, line: []const u8) !void {
    const input = line[2..];
    const name_end = std.mem.indexOfScalar(u8, input, ' ') orelse return error.MalformedCase;
    const name = input[0..name_end];
    const rest = input[name_end + 1 ..];
    if (std.mem.eql(u8, name, "set-parent")) {
        const o = x.store.named(field(input, "object") orelse return error.MalformedCase) orelse return error.MalformedCase;
        const shown = field(input, "parent") orelse return error.MalformedCase;
        const parent: ?*c.talk_object = if (std.mem.eql(u8, shown, "nothing")) null else x.store.named(shown) orelse return error.MalformedCase;
        // A refusal at the call is in the Trace as a `refused` record.
        const code = c.talk_set_parent(x.group, o, parent);
        if (code != c.TALK_PARENT_CYCLE and code != c.TALK_INVALID_VALUE) try check(code);
        return;
    }
    if (std.mem.eql(u8, name, "stop")) {
        const script = x.scripts.get(rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase]) orelse return error.UnknownScript;
        var reason: ?*c.talk_value = null;
        const shown = field(input, "reason") orelse return error.MalformedCase;
        try check(c.talk_parse_display(shown.ptr, shown.len, &reason));
        defer c.talk_value_release(reason);
        var text: [*c]const u8 = null;
        var text_len: usize = 0;
        if (!c.talk_value_as_text(reason, &text, &text_len)) return error.MalformedCase;
        return check(c.talk_script_stop(script, text, text_len));
    }
    const script = x.scripts.get(rest[0 .. std.mem.indexOfScalar(u8, rest, '/') orelse return error.MalformedCase]) orelse return error.UnknownScript;
    if (std.mem.eql(u8, name, "cancel-run")) return check(c.talk_script_cancel_run(script, rest.ptr, rest.len));
    if (std.mem.eql(u8, name, "rewind-run")) return check(c.talk_script_rewind_run(script, rest.ptr, rest.len));
    return error.Unsupported;
}

/// The inputs inside a Pump's output in the case, each with the number of
/// Host crossings before it.
fn crossings(a: std.mem.Allocator, trace: []const u8, pump: []const u8) ![]const @typeInfo(@FieldType(Crossing, "inputs")).pointer.child {
    var out: std.ArrayList(@typeInfo(@FieldType(Crossing, "inputs")).pointer.child) = .empty;
    const from = @intFromPtr(pump.ptr) - @intFromPtr(trace.ptr) + pump.len;
    var lines = std.mem.splitScalar(u8, trace[from..], '\n');
    var count: usize = 0;
    while (lines.next()) |l| {
        // A refused Pump has no `pumped` record: the next Pump ends it too.
        if (std.mem.startsWith(u8, l, "pumped ") or std.mem.startsWith(u8, l, "> pump")) break;
        if (std.mem.startsWith(u8, l, "call ") or std.mem.startsWith(u8, l, "prop ")) count += 1;
        if (std.mem.startsWith(u8, l, "> ")) try out.append(a, .{ .at = count, .line = l });
    }
    return out.items;
}

const OperationHost = struct {
    /// Holds what the Host function gives the Core, until the case ends.
    a: std.mem.Allocator,
    /// The suspending calls started, by id, for `answer` and `fail`.
    calls: *std.StringHashMapUnmanaged(?*c.talk_call),
    name: []const u8,
    mode: c.talk_mode,
    stubs: std.ArrayList(Stub) = .empty,
    next: usize = 0,
};

/// The Function Values the runner has received from the Core, in the order
/// it received them: a Run's result, or a Host function's argument.
const Received = struct {
    a: std.mem.Allocator,
    values: std.ArrayList(*c.talk_value) = .empty,

    fn keep(r: *Received, v: ?*c.talk_value) void {
        const x = v orelse return;
        if (c.talk_value_kind(x) != c.TALK_KIND_FUNCTION) return;
        r.values.append(r.a, x) catch return;
        c.talk_value_retain(x);
    }

    /// Keeps the Function Values a worker call's reports carry.
    fn keepReports(r: *Received, reports: ?*c.talk_reports) void {
        var items: [*c]const c.talk_report = null;
        const n = c.talk_reports_items(reports, &items);
        for (items[0..n]) |x| switch (x.kind) {
            c.TALK_REPORT_RUN_END => r.keep(x.as.run_end.result),
            c.TALK_REPORT_UNHANDLED => for (x.as.unhandled.args[0..x.as.unhandled.args_len]) |v| r.keep(v),
            else => {},
        };
    }

    /// The latest one received with this display form, an owned reference.
    fn named(r: *Received, shown: []const u8) ?*c.talk_value {
        var i = r.values.items.len;
        while (i > 0) {
            i -= 1;
            const v = r.values.items[i];
            var text: c.talk_owned_bytes = .{ .data = null, .len = 0 };
            if (c.talk_value_string(v, &text) != c.TALK_OK) continue;
            defer c.talk_owned_bytes_release(&text);
            if (!std.mem.eql(u8, text.data[0..text.len], shown)) continue;
            c.talk_value_retain(v);
            return v;
        }
        return null;
    }

    fn deinit(r: *Received) void {
        for (r.values.items) |v| c.talk_value_release(v);
        r.values.deinit(r.a);
    }
};

var received: ?*Received = null;

/// A value a case line shows. A Host can't build a Function Value, so one
/// shown is the latest the runner received with that display form
/// (chapter 11, Reading values).
fn parsed(shown: []const u8) ?*c.talk_value {
    if (std.mem.startsWith(u8, shown, "<function ")) return (received orelse return null).named(shown);
    var v: ?*c.talk_value = null;
    if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return null;
    return v;
}

fn host(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
    cross();
    if (received) |r| for (args[0..len]) |v| r.keep(v);
    const h: *OperationHost = @ptrCast(@alignCast(context.?));
    const stub: Stub = if (h.next < h.stubs.items.len) blk: {
        h.next += 1;
        break :blk h.stubs.items[h.next - 1];
    } else if (h.mode != c.TALK_IMMEDIATE) .{} else return c.TALK_CALL_BROKEN;
    if (stub.charge) |n| if (n > 0 and c.talk_call_charge(call, n) != c.TALK_OK) return c.TALK_CALL_LIMITED;
    if (h.mode == c.TALK_SUSPENDING and stub.err == null) {
        var id: [*c]const u8 = null;
        var id_len: usize = 0;
        c.talk_call_id(call, &id, &id_len);
        h.calls.put(h.a, id[0..id_len], call) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_STARTED;
    }
    if (stub.err) |shown| return if (scriptError(h.a, shown, err)) c.TALK_CALL_FAILED else c.TALK_CALL_BROKEN;
    if (stub.value) |shown| {
        result.* = parsed(shown) orelse return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }
    // A Stub with no value or error answers Nothing, as a fire-and-forget
    // call does.
    _ = c.talk_nothing(result);
    return c.TALK_CALL_ANSWERED;
}

/// A shown error map as a Script error: its code, message and the rest as
/// Data. False for `{}` or anything else that isn't a Script error.
fn scriptError(a: std.mem.Allocator, shown: []const u8, err: *c.talk_script_error) bool {
    const e = parsed(shown) orelse return false;
    defer c.talk_value_release(e);
    var code_value: ?*c.talk_value = null;
    if (c.talk_value_get(e, "code", 4, &code_value) != c.TALK_OK or code_value == null) return false;
    defer c.talk_value_release(code_value);
    var code: [*c]const u8 = null;
    var code_len: usize = 0;
    if (!c.talk_value_as_text(code_value, &code, &code_len)) return false;
    // The Data: every entry but code and message.
    var pairs: std.ArrayList(c.talk_pair) = .empty;
    var message: ?[]const u8 = null;
    var i: usize = 0;
    var pair: c.talk_pair = undefined;
    while (c.talk_value_entries(e, i, &pair)) : (i += 1) {
        const key = pair.key[0..pair.key_len];
        if (std.mem.eql(u8, key, "code")) continue;
        if (std.mem.eql(u8, key, "message")) {
            var t: [*c]const u8 = null;
            var n: usize = 0;
            if (c.talk_value_as_text(pair.value, &t, &n)) message = t[0..n];
            continue;
        }
        pairs.append(a, pair) catch return false;
    }
    var data: ?*c.talk_value = null;
    if (pairs.items.len > 0 and c.talk_map(pairs.items.ptr, pairs.items.len, &data) != c.TALK_OK) return false;
    // The strings belong to the error value, so they are copied.
    const owned_code = a.dupe(u8, code[0..code_len]) catch return false;
    const owned_message = if (message) |m| a.dupe(u8, m) catch return false else null;
    err.* = .{ .code = owned_code.ptr, .code_len = owned_code.len, .message = if (owned_message) |m| m.ptr else null, .message_len = if (owned_message) |m| m.len else 0, .data = data };
    return true;
}

/// A Standard Operation's Host function: the next Stub for `key`, from the
/// runner's table of Operation hosts, its context.
fn standardHost(comptime key: []const u8) c.talk_operation_fn {
    return struct {
        fn f(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
            const hosts: *std.StringHashMapUnmanaged(*OperationHost) = @ptrCast(@alignCast(context.?));
            const h = hosts.get(key) orelse return c.TALK_CALL_BROKEN;
            return host(h, call, args, len, result, err);
        }
    }.f;
}

/// Defines the case's Standard Capabilities from its `[[standard]]` tables.
fn defineStandard(a: std.mem.Allocator, core: ?*c.talk_core, all: []const case_setup.Table, hosts: *std.StringHashMapUnmanaged(*OperationHost), defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def), calls: *std.StringHashMapUnmanaged(?*c.talk_call), effects: *Effects) !void {
    for (all) |t| {
        if (!std.mem.eql(u8, t.header, "[[standard]]")) continue;
        const which = case_setup.field(t, "capability").?.string;
        var costs: std.ArrayList(c.talk_named_cost) = .empty;
        if (case_setup.field(t, "costs")) |table| for (table.table) |e| {
            try costs.append(a, .{ .name = e.key.ptr, .name_len = e.key.len, .cost = .{ .fuel = number(e.value.get("fuel")), .alloc = number(e.value.get("alloc")) } });
        };
        const all_costs: c.talk_costs = .{ .entries = costs.items.ptr, .len = costs.items.len };
        var def: ?*c.talk_capability_def = null;
        const operations: []const struct { []const u8, c.talk_mode } = if (std.mem.eql(u8, which, "calendar"))
            &.{ .{ "today", c.TALK_IMMEDIATE }, .{ "now", c.TALK_IMMEDIATE }, .{ "toCivil", c.TALK_IMMEDIATE }, .{ "toInstant", c.TALK_IMMEDIATE }, .{ "offset", c.TALK_IMMEDIATE }, .{ "zone", c.TALK_IMMEDIATE } }
        else if (std.mem.eql(u8, which, "locale"))
            &.{ .{ "compare", c.TALK_IMMEDIATE }, .{ "rank", c.TALK_IMMEDIATE }, .{ "upper", c.TALK_IMMEDIATE }, .{ "lower", c.TALK_IMMEDIATE }, .{ "numberSymbols", c.TALK_IMMEDIATE }, .{ "monthNames", c.TALK_IMMEDIATE }, .{ "dayNames", c.TALK_IMMEDIATE }, .{ "tag", c.TALK_IMMEDIATE } }
        else if (std.mem.eql(u8, which, "timer"))
            &.{ .{ "schedule", c.TALK_FIRE_AND_FORGET }, .{ "cancel", c.TALK_FIRE_AND_FORGET } }
        else if (std.mem.eql(u8, which, "console"))
            &.{ .{ "write", c.TALK_FIRE_AND_FORGET }, .{ "read", c.TALK_SUSPENDING } }
        else if (std.mem.eql(u8, which, "user"))
            &.{ .{ "confirm", c.TALK_SUSPENDING }, .{ "choose", c.TALK_SUSPENDING }, .{ "enter", c.TALK_SUSPENDING }, .{ "notify", c.TALK_FIRE_AND_FORGET } }
        else if (std.mem.eql(u8, which, "sqlite"))
            &.{ .{ "query", c.TALK_IMMEDIATE }, .{ "change", c.TALK_IMMEDIATE }, .{ "begin", c.TALK_IMMEDIATE }, .{ "commit", c.TALK_IMMEDIATE }, .{ "rollback", c.TALK_IMMEDIATE } }
        else if (std.mem.eql(u8, which, "store"))
            &.{ .{ "get", c.TALK_IMMEDIATE }, .{ "set", c.TALK_IMMEDIATE }, .{ "delete", c.TALK_IMMEDIATE }, .{ "keys", c.TALK_IMMEDIATE }, .{ "increment", c.TALK_IMMEDIATE }, .{ "swap", c.TALK_IMMEDIATE }, .{ "watch", c.TALK_IMMEDIATE }, .{ "unwatch", c.TALK_IMMEDIATE } }
        else
            &.{};
        for (operations) |op| {
            const h = try a.create(OperationHost);
            h.* = .{ .a = a, .calls = calls, .name = try std.fmt.allocPrint(a, "{s}.{s}", .{ which, op[0] }), .mode = op[1] };
            try hosts.put(a, h.name, h);
        }
        if (std.mem.eql(u8, which, "clock")) {
            try check(c.talk_clock_capability(core, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "calendar")) {
            const impl: c.talk_calendar_impl = .{ .context = hosts, .today = standardHost("calendar.today"), .now = standardHost("calendar.now"), .to_civil = standardHost("calendar.toCivil"), .to_instant = standardHost("calendar.toInstant"), .offset = standardHost("calendar.offset"), .zone = standardHost("calendar.zone") };
            try check(c.talk_calendar_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "locale")) {
            const impl: c.talk_locale_impl = .{ .context = hosts, .compare = standardHost("locale.compare"), .rank = standardHost("locale.rank"), .upper = standardHost("locale.upper"), .lower = standardHost("locale.lower"), .number_symbols = standardHost("locale.numberSymbols"), .month_names = standardHost("locale.monthNames"), .day_names = standardHost("locale.dayNames"), .tag = standardHost("locale.tag") };
            try check(c.talk_locale_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "timer")) {
            const impl: c.talk_timer_impl = .{ .context = hosts, .schedule = standardHost("timer.schedule"), .cancel = standardHost("timer.cancel") };
            try check(c.talk_timer_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "user")) {
            const impl: c.talk_user_impl = .{ .context = hosts, .confirm = standardHost("user.confirm"), .choose = standardHost("user.choose"), .enter = standardHost("user.enter"), .notify = standardHost("user.notify") };
            try check(c.talk_user_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "console")) {
            const impl: c.talk_console_impl = .{ .context = hosts, .write = standardHost("console.write"), .read = standardHost("console.read") };
            try check(c.talk_console_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "store")) {
            // Its coordinator's hooks answer from `stub-effect` lines.
            const impl: c.talk_store_impl = .{ .context = hosts, .get = standardHost("store.get"), .set = standardHost("store.set"), .del = standardHost("store.delete"), .keys = standardHost("store.keys"), .increment = standardHost("store.increment"), .swap = standardHost("store.swap"), .watch = standardHost("store.watch"), .unwatch = standardHost("store.unwatch"), .coordinator = (try effects.lifecycle()).* };
            try check(c.talk_store_capability(core, &impl, &all_costs, &def));
        } else if (std.mem.eql(u8, which, "sqlite")) {
            const context = try a.create(SqliteHost);
            context.* = .{ .hosts = hosts, .effects = effects };
            const impl: c.talk_sqlite_impl = .{ .context = context, .coordinator = databaseCoordinator, .query = sqlHost("sqlite.query"), .change = sqlHost("sqlite.change"), .begin = sqliteHost("sqlite.begin"), .commit = sqliteHost("sqlite.commit"), .rollback = sqliteHost("sqlite.rollback"), .release_rows = null };
            try check(c.talk_sqlite_capability(core, &impl, &all_costs, number(case_setup.field(t, "perRow")), &def));
        } else return error.Unsupported;
        try defs.put(a, which, def);
    }
}

/// A case.toml Shape as a talk.h Shape, owned by the caller.
fn shapeOf(v: case_setup.Value) !?*c.talk_shape {
    switch (v) {
        .string => |name| {
            const kinds = .{
                .{ "any", c.talk_any_shape },               .{ "value", c.talk_value_shape },     .{ "nothing", c.talk_nothing_shape },
                .{ "boolean", c.talk_bool_shape },          .{ "number", c.talk_number_shape },   .{ "text", c.talk_text_shape },
                .{ "bytes", c.talk_bytes_shape },           .{ "instant", c.talk_instant_shape }, .{ "range", c.talk_range_shape },
                .{ "civil date", c.talk_civil_date_shape }, .{ "pattern", c.talk_pattern_shape }, .{ "function", c.talk_function_shape },
            };
            inline for (kinds) |k| if (std.mem.eql(u8, name, k[0])) return @constCast(k[1]());
            return error.UnknownShape;
        },
        .table => {
            var out: ?*c.talk_shape = null;
            if (v.get("quantity")) |u| {
                try check(c.talk_quantity_of(u.string.ptr, u.string.len, &out));
            } else if (v.get("unitKind")) |k| {
                try check(c.talk_quantity_kind(k.string.ptr, k.string.len, &out));
            } else if (v.get("list")) |inner| {
                const s = try shapeOf(inner);
                defer c.talk_shape_release(s);
                try check(c.talk_list_of(s, &out));
            } else if (v.get("optional")) |inner| {
                const s = try shapeOf(inner);
                defer c.talk_shape_release(s);
                try check(c.talk_optional(s, &out));
            } else if (v.get("oneOf")) |xs| {
                var shapes: [16]?*const c.talk_shape = undefined;
                for (xs.array, 0..) |x, i| shapes[i] = try shapeOf(x);
                defer for (shapes[0..xs.array.len]) |x| c.talk_shape_release(x);
                try check(c.talk_one_of(&shapes, xs.array.len, &out));
            } else if (v.get("map")) |fields| {
                var made: [32]c.talk_field = undefined;
                for (fields.array, 0..) |f, i| {
                    const key = f.get("key").?.string;
                    const optional = if (f.get("optional")) |o| o == .raw and std.mem.eql(u8, o.raw, "true") else false;
                    made[i] = .{ .key = key.ptr, .key_len = key.len, .shape = try shapeOf(f.get("shape").?), .optional = optional };
                }
                defer for (made[0..fields.array.len]) |f| c.talk_shape_release(f.shape);
                const open = if (v.get("open")) |o| o == .raw and std.mem.eql(u8, o.raw, "true") else false;
                try check((if (open) &c.talk_open_map else &c.talk_map_shape)(&made, fields.array.len, &out));
            } else return error.UnknownShape;
            return out;
        },
        else => return error.UnknownShape,
    }
}

/// The Trace's Host Inputs in the order the Host made them. A refusal is
/// written at the call, but accepted inputs only when a Pump drains them, so
/// an input refused with `mailbox full` was made after the accepted inputs
/// that follow it, up to the next Pump (chapter 11).
fn hostOrder(a: std.mem.Allocator, trace: []const u8) !std.ArrayList([]const u8) {
    var out: std.ArrayList([]const u8) = .empty;
    var held: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "> ")) continue;
        if (std.mem.startsWith(u8, line, "> pump")) {
            try out.appendSlice(a, held.items);
            held.clearRetainingCapacity();
        }
        const next = lines.peek() orelse "";
        if (std.mem.eql(u8, next, "refused code=\"mailbox full\"")) {
            try held.append(a, line);
            continue;
        }
        try out.append(a, line);
    }
    try out.appendSlice(a, held.items);
    return out;
}

/// A Script's limits: its inline `limits` table, or a `[scripts.limits]`
/// table right after its own.
fn scriptLimits(all: []const case_setup.Table, table: case_setup.Table) []const case_setup.Value.Entry {
    if (case_setup.field(table, "limits")) |given| return given.table;
    for (all, 0..) |t, i| if (t.entries.ptr == table.entries.ptr and i + 1 < all.len and std.mem.eql(u8, all[i + 1].header, "[scripts.limits]")) {
        return all[i + 1].entries;
    };
    return &.{};
}

/// A limit's talk_limits field, by its `ts` name.
fn limitField(ts: []const u8) ?[]const u8 {
    const names = .{
        .{ "fuelPerRun", "fuel_per_run" }, .{ "allocPerRun", "alloc_per_run" }, .{ "persistentState", "persistent_state" },
        .{ "callDepth", "call_depth" },    .{ "patternSize", "pattern_size" },  .{ "mailboxDepth", "mailbox_depth" },
        .{ "maxWaitMs", "max_wait_ms" },   .{ "maxJoin", "max_join" },          .{ "cleanupBudget", "cleanup_budget" },
    };
    inline for (names) |n| if (std.mem.eql(u8, ts, n[0])) return n[1];
    return null;
}

/// An input's `limits={…}` override, each field marked as supplied.
fn overrideOf(input: []const u8, out: *c.talk_limit_override) !bool {
    const at = std.mem.indexOf(u8, input, " limits={") orelse return false;
    const start = at + " limits={".len;
    const end = std.mem.indexOfScalarPos(u8, input, start, '}') orelse return error.MalformedCase;
    var pairs = std.mem.splitSequence(u8, input[start..end], ", ");
    while (pairs.next()) |pair| {
        const colon = std.mem.indexOf(u8, pair, ": ") orelse return error.MalformedCase;
        const v = std.fmt.parseInt(i64, pair[colon + 2 ..], 10) catch return error.MalformedCase;
        const key = pair[0..colon];
        if (std.mem.eql(u8, key, "fuelPerRun")) {
            out.fuel_per_run = v;
            out.set |= c.TALK_OVERRIDE_FUEL_PER_RUN;
        } else if (std.mem.eql(u8, key, "allocPerRun")) {
            out.alloc_per_run = v;
            out.set |= c.TALK_OVERRIDE_ALLOC_PER_RUN;
        } else if (std.mem.eql(u8, key, "maxWaitMs")) {
            out.max_wait_ms = v;
            out.set |= c.TALK_OVERRIDE_MAX_WAIT;
        } else if (std.mem.eql(u8, key, "maxJoin")) {
            out.max_join = v;
            out.set |= c.TALK_OVERRIDE_MAX_JOIN;
        } else return error.MalformedCase;
    }
    return true;
}

fn number(v: ?case_setup.Value) i64 {
    const x = v orelse return 0;
    return if (x == .raw) std.fmt.parseInt(i64, x.raw, 10) catch 0 else 0;
}

/// Defines the case's Capabilities from its `[[operations]]` tables, with
/// one OperationHost each, keyed `<capability>.<operation>`.
/// The case's Segment Coordinators: each Grant's coordinator name, by its
/// binding, one lifecycle per name and one for each Grant without one, and
/// the hook results `stub-effect` queues, by `<script>.<grant>.<phase>`.
const Effects = struct {
    a: std.mem.Allocator,
    names: std.AutoHashMapUnmanaged(usize, ?[]const u8) = .empty,
    shared: std.StringHashMapUnmanaged(*c.talk_segment_lifecycle) = .empty,
    stubs: std.StringHashMapUnmanaged(std.ArrayList(c.talk_effect_status)) = .empty,
    /// The coordinated Capabilities, whose Grants need a binding of their
    /// own.
    coordinated: std.StringHashMapUnmanaged(void) = .empty,
    /// A `sqlite` binding for Grants the case gives none, such as a
    /// Library's declarations.
    sqlite_binding: c.talk_sqlite_binding = .{ .database = "", .database_len = 0, .tables = null, .table_lens = null, .tables_len = 0, .has_tables = false, .max_rows = 0 },

    fn lifecycle(e: *Effects) !*c.talk_segment_lifecycle {
        const l = try e.a.create(c.talk_segment_lifecycle);
        l.* = .{ .begin = hookFor(0), .commit = hookFor(1), .rollback = hookFor(2), .context = e };
        return l;
    }
};

/// The hook for a phase, by its index: the next Stub for the first enrolled
/// Grant. A hook without one is `unknown`.
fn hookFor(comptime phase: comptime_int) c.talk_segment_hook {
    return struct {
        fn f(context: ?*anyopaque, sc: [*c]const c.talk_segment_context) callconv(.c) c.talk_effect_result {
            const e: *Effects = @ptrCast(@alignCast(context.?));
            const x = sc.*;
            var buf: [256]u8 = undefined;
            const key = std.fmt.bufPrint(&buf, "{s}.{s}.{s}", .{ x.script_name[0..x.script_name_len], x.grant_name[0..x.grant_name_len], ([_][]const u8{ "begin", "commit", "rollback" })[phase] }) catch return .{ .status = c.TALK_EFFECT_UNKNOWN };
            const queue = e.stubs.getPtr(key) orelse return .{ .status = c.TALK_EFFECT_UNKNOWN };
            if (queue.items.len == 0) return .{ .status = c.TALK_EFFECT_UNKNOWN };
            return .{ .status = queue.orderedRemove(0) };
        }
    }.f;
}

/// A Grant's coordinator: the one its name shares, or its own.
fn coordinatorFor(context: ?*anyopaque, binding: ?*anyopaque) callconv(.c) [*c]const c.talk_segment_lifecycle {
    const e: *Effects = @ptrCast(@alignCast(context.?));
    const name = e.names.get(@intFromPtr(binding)) orelse return null;
    const n = name orelse return e.lifecycle() catch null;
    if (e.shared.get(n)) |l| return l;
    const l = e.lifecycle() catch return null;
    e.shared.put(e.a, n, l) catch return null;
    return l;
}

/// `sqlite`'s context: the Stubs for its Operations, and the case's Segment
/// Coordinators for its databases.
const SqliteHost = struct { hosts: *std.StringHashMapUnmanaged(*OperationHost), effects: *Effects };

/// A `sqlite` database's coordinator: one per database.
fn databaseCoordinator(context: ?*anyopaque, database: [*c]const u8, len: usize) callconv(.c) [*c]const c.talk_segment_lifecycle {
    const e = @as(*SqliteHost, @ptrCast(@alignCast(context.?))).effects;
    const key = std.fmt.allocPrint(e.a, "sqlite:{s}", .{database[0..len]}) catch return null;
    if (e.shared.get(key)) |l| return l;
    const l = e.lifecycle() catch return null;
    e.shared.put(e.a, key, l) catch return null;
    return l;
}

/// A display value as a SQL value: an integer with no fraction digits that
/// fits 64 bits as `INTEGER`, any other number or `{real: "…"}` as `REAL`,
/// text, Bytes and Nothing. Null for anything else.
fn sqlValueOf(a: std.mem.Allocator, v: ?*c.talk_value) ?c.talk_sql_value {
    var out = std.mem.zeroes(c.talk_sql_value);
    switch (c.talk_value_kind(v)) {
        c.TALK_KIND_NOTHING => out.kind = c.TALK_SQL_NULL,
        c.TALK_KIND_NUMBER => {
            var shown: c.talk_owned_bytes = .{};
            if (c.talk_value_string(v, &shown) != c.TALK_OK) return null;
            defer c.talk_owned_bytes_release(&shown);
            const text = a.dupe(u8, shown.data[0..shown.len]) catch return null;
            if (std.mem.indexOfScalar(u8, text, '.') == null) if (std.fmt.parseInt(i64, text, 10)) |i| {
                out.kind = c.TALK_SQL_INTEGER;
                out.integer = i;
                return out;
            } else |_| {};
            out.kind = c.TALK_SQL_REAL;
            out.real = std.fmt.parseFloat(f64, text) catch return null;
        },
        c.TALK_KIND_TEXT => {
            var t: [*c]const u8 = null;
            var n: usize = 0;
            _ = c.talk_value_as_text(v, &t, &n);
            out.kind = c.TALK_SQL_TEXT;
            out.bytes = (a.dupe(u8, t[0..n]) catch return null).ptr;
            out.len = n;
        },
        c.TALK_KIND_BYTES => {
            var b: c.talk_owned_bytes = .{};
            if (c.talk_value_as_bytes(v, &b) != c.TALK_OK) return null;
            defer c.talk_owned_bytes_release(&b);
            out.kind = c.TALK_SQL_BLOB;
            out.bytes = (a.dupe(u8, b.data[0..b.len]) catch return null).ptr;
            out.len = b.len;
        },
        c.TALK_KIND_MAP => {
            // `{real: "NaN"}` and the like: a double spelled as text.
            var real: ?*c.talk_value = null;
            var pair: c.talk_pair = undefined;
            if (!c.talk_value_entries(v, 0, &pair) or c.talk_value_entries(v, 1, &pair)) return null;
            if (c.talk_value_get(v, "real", 4, &real) != c.TALK_OK or real == null) return null;
            defer c.talk_value_release(real);
            var t: [*c]const u8 = null;
            var n: usize = 0;
            if (!c.talk_value_as_text(real, &t, &n)) return null;
            out.kind = c.TALK_SQL_REAL;
            out.real = std.fmt.parseFloat(f64, t[0..n]) catch return null;
        },
        else => return null,
    }
    return out;
}

/// A Stub's `{columns, rows, changes}` as a result. False for a shape the
/// C layout can't hold, which the Core sees as `host error`.
fn sqlRowsOf(a: std.mem.Allocator, shown: []const u8, rows: *c.talk_sql_rows) bool {
    const v = parsed(shown) orelse return false;
    defer c.talk_value_release(v);
    var columns: ?*c.talk_value = null;
    var list: ?*c.talk_value = null;
    if (c.talk_value_get(v, "columns", 7, &columns) != c.TALK_OK or columns == null) return false;
    defer c.talk_value_release(columns);
    if (c.talk_value_get(v, "rows", 4, &list) != c.TALK_OK or list == null) return false;
    defer c.talk_value_release(list);
    if (c.talk_value_kind(columns) != c.TALK_KIND_LIST or c.talk_value_kind(list) != c.TALK_KIND_LIST) return false;
    const width = c.talk_value_len(columns);
    const names = a.alloc([*c]const u8, width) catch return false;
    const lens = a.alloc(usize, width) catch return false;
    for (0..width) |i| {
        var name: ?*c.talk_value = null;
        if (c.talk_value_index(columns, i + 1, &name) != c.TALK_OK) return false;
        defer c.talk_value_release(name);
        var t: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(name, &t, &n)) return false;
        names[i] = (a.dupe(u8, t[0..n]) catch return false).ptr;
        lens[i] = n;
    }
    const height = c.talk_value_len(list);
    const values = a.alloc(c.talk_sql_value, height * width) catch return false;
    for (0..height) |r| {
        var row: ?*c.talk_value = null;
        if (c.talk_value_index(list, r + 1, &row) != c.TALK_OK) return false;
        defer c.talk_value_release(row);
        if (c.talk_value_kind(row) != c.TALK_KIND_LIST or c.talk_value_len(row) != width) return false;
        for (0..width) |col| {
            var x: ?*c.talk_value = null;
            if (c.talk_value_index(row, col + 1, &x) != c.TALK_OK) return false;
            defer c.talk_value_release(x);
            values[r * width + col] = sqlValueOf(a, x) orelse return false;
        }
    }
    var changes: i64 = 0;
    var n: ?*c.talk_value = null;
    if (c.talk_value_get(v, "changes", 7, &n) == c.TALK_OK and n != null) {
        defer c.talk_value_release(n);
        // A missing key reads as Nothing.
        const d = sqlValueOf(a, n) orelse return false;
        if (d.kind == c.TALK_SQL_INTEGER) changes = d.integer else if (d.kind != c.TALK_SQL_NULL) return false;
    }
    rows.* = .{ .columns = names.ptr, .column_lens = lens.ptr, .columns_len = width, .values = values.ptr, .rows_len = height, .changes = changes };
    return true;
}

/// `query` or `change`: the next Stub for it, as rows or an error.
fn sqlHost(comptime key: []const u8) c.talk_sql_fn {
    return struct {
        fn f(context: ?*anyopaque, call: ?*c.talk_call, sql: [*c]const u8, sql_len: usize, params: [*c]const c.talk_sql_params, max: i64, rows: [*c]c.talk_sql_rows, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
            cross();
            _ = call;
            _ = sql;
            _ = sql_len;
            _ = params;
            _ = max;
            const hosts = @as(*SqliteHost, @ptrCast(@alignCast(context.?))).hosts;
            const h = hosts.get(key) orelse return c.TALK_CALL_BROKEN;
            if (h.next >= h.stubs.items.len) return c.TALK_CALL_BROKEN;
            const stub = h.stubs.items[h.next];
            h.next += 1;
            if (stub.err) |shown| return if (scriptError(h.a, shown, err)) c.TALK_CALL_FAILED else c.TALK_CALL_BROKEN;
            const shown = stub.value orelse return c.TALK_CALL_BROKEN;
            return if (sqlRowsOf(h.a, shown, rows)) c.TALK_CALL_ANSWERED else c.TALK_CALL_BROKEN;
        }
    }.f;
}

/// `sqlite`'s `begin`, `commit` or `rollback`: the next Stub for it.
fn sqliteHost(comptime key: []const u8) c.talk_operation_fn {
    return struct {
        fn f(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
            const hosts = @as(*SqliteHost, @ptrCast(@alignCast(context.?))).hosts;
            const h = hosts.get(key) orelse return c.TALK_CALL_BROKEN;
            return host(h, call, args, len, result, err);
        }
    }.f;
}

fn defineCapabilities(a: std.mem.Allocator, core: ?*c.talk_core, all: []const case_setup.Table, hosts: *std.StringHashMapUnmanaged(*OperationHost), defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def), calls: *std.StringHashMapUnmanaged(?*c.talk_call), effects: *Effects) !void {
    var names: std.ArrayList([]const u8) = .empty;
    for (all) |t| {
        if (!std.mem.eql(u8, t.header, "[[operations]]")) continue;
        const capability = case_setup.field(t, "capability").?.string;
        for (names.items) |n| {
            if (std.mem.eql(u8, n, capability)) break;
        } else try names.append(a, capability);
    }
    for (names.items) |capability| {
        var ops: std.ArrayList(c.talk_operation) = .empty;
        var bound = false;
        for (all) |t| {
            if (!std.mem.eql(u8, t.header, "[[operations]]")) continue;
            if (!std.mem.eql(u8, case_setup.field(t, "capability").?.string, capability)) continue;
            const name = case_setup.field(t, "name").?.string;
            const mode_text = case_setup.field(t, "mode").?.string;
            const mode: c.talk_mode = if (std.mem.eql(u8, mode_text, "fire-and-forget")) c.TALK_FIRE_AND_FORGET else if (std.mem.eql(u8, mode_text, "suspending")) c.TALK_SUSPENDING else c.TALK_IMMEDIATE;
            var args: std.ArrayList(?*const c.talk_shape) = .empty;
            if (case_setup.field(t, "args")) |list| for (list.array) |x| try args.append(a, try shapeOf(x));
            const result: ?*c.talk_shape = if (case_setup.field(t, "result")) |r| try shapeOf(r) else null;
            const cost = case_setup.field(t, "cost");
            var errors: std.ArrayList(c.talk_error_decl) = .empty;
            if (case_setup.field(t, "errors")) |list| for (list.array) |e| {
                const code = e.get("code").?.string;
                var fields: std.ArrayList(c.talk_field) = .empty;
                if (e.get("fields")) |fs| for (fs.array) |f| {
                    const key = f.get("key").?.string;
                    const optional = if (f.get("optional")) |o| o == .raw and std.mem.eql(u8, o.raw, "true") else false;
                    try fields.append(a, .{ .key = key.ptr, .key_len = key.len, .shape = try shapeOf(f.get("shape").?), .optional = optional });
                };
                try errors.append(a, .{ .code = code.ptr, .code_len = code.len, .fields = fields.items.ptr, .fields_len = fields.items.len });
            };
            const h = try a.create(OperationHost);
            h.* = .{ .a = a, .calls = calls, .name = try std.fmt.allocPrint(a, "{s}.{s}", .{ capability, name }), .mode = mode };
            try hosts.put(a, h.name, h);
            const scope: ?*c.talk_scope_decl = if (case_setup.field(t, "scope")) |x| blk: {
                const d = try a.create(c.talk_scope_decl);
                d.* = std.mem.zeroes(c.talk_scope_decl);
                if (x.get("opens")) |v| {
                    d.opens = v.string.ptr;
                    d.opens_len = v.string.len;
                }
                if (x.get("abandon")) |v| {
                    d.abandon = v.string.ptr;
                    d.abandon_len = v.string.len;
                }
                if (x.get("closes")) |v| {
                    d.closes = v.string.ptr;
                    d.closes_len = v.string.len;
                }
                break :blk d;
            } else null;
            const segment_bound = if (case_setup.field(t, "segmentBound")) |b| b == .raw and std.mem.eql(u8, b.raw, "true") else false;
            bound = bound or segment_bound;
            try ops.append(a, .{
                .name = name.ptr,
                .name_len = name.len,
                .args = @ptrCast(args.items.ptr),
                .args_len = args.items.len,
                .result = result,
                .cost = .{ .fuel = number(if (cost) |x| x.get("fuel") else null), .alloc = number(if (cost) |x| x.get("alloc") else null) },
                .mode = mode,
                .max_pending_ms = number(case_setup.field(t, "maxPending")),
                .errors = errors.items.ptr,
                .errors_len = errors.items.len,
                .@"fn" = host,
                .context = h,
                .scope = scope,
                .segment_bound = segment_bound,
            });
        }
        var def: ?*c.talk_capability_def = null;
        if (bound) {
            try effects.coordinated.put(a, capability, {});
            try check(c.talk_define_coordinated_capability(core, capability.ptr, capability.len, ops.items.ptr, ops.items.len, coordinatorFor, effects, &def));
        } else try check(c.talk_define_capability(core, capability.ptr, capability.len, ops.items.ptr, ops.items.len, &def));
        for (ops.items) |op| {
            for (op.args[0..op.args_len]) |x| c.talk_shape_release(x);
            if (op.result) |r| c.talk_shape_release(r);
            for (op.errors[0..op.errors_len]) |e| for (e.fields[0..e.fields_len]) |f| c.talk_shape_release(f.shape);
        }
        try defs.put(a, capability, def);
    }
}

/// A Script's Grants, from its `grants` table.
fn grantsOf(a: std.mem.Allocator, t: case_setup.Table, defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def), effects: *Effects) ![]c.talk_load_grant {
    var out: std.ArrayList(c.talk_load_grant) = .empty;
    const grants = case_setup.field(t, "grants") orelse return out.items;
    for (grants.table) |g| {
        const capability = if (g.value.get("capability")) |x| x.string else g.key;
        const def = defs.get(capability) orelse return error.UnknownCapability;
        var grant: ?*c.talk_grant = null;
        const ops = g.value.get("ops") orelse return error.MalformedCase;
        // A text binding reaches the Host as NUL-terminated text.
        var binding: ?*anyopaque = if (g.value.get("binding")) |b| (if (b == .string) @ptrCast(@constCast((try a.dupeSentinel(u8, b.string, 0)).ptr)) else null) else null;
        // A `sqlite` binding: `{database, tables, maxRows}`.
        if (g.value.get("binding")) |b| if (b == .table) {
            const database = (b.get("database") orelse return error.MalformedCase).string;
            const sb = try a.create(c.talk_sqlite_binding);
            sb.* = .{ .database = database.ptr, .database_len = database.len, .tables = null, .table_lens = null, .tables_len = 0, .has_tables = false, .max_rows = number(b.get("maxRows")) };
            if (b.get("tables")) |tables| {
                const names = try a.alloc([*c]const u8, tables.array.len);
                const lens = try a.alloc(usize, tables.array.len);
                for (tables.array, names, lens) |x, *n, *l| {
                    n.* = x.string.ptr;
                    l.* = x.string.len;
                }
                sb.tables = names.ptr;
                sb.table_lens = lens.ptr;
                sb.tables_len = names.len;
                sb.has_tables = true;
            }
            binding = sb;
        };
        // A coordinated Grant's binding is its own, so it names its
        // coordinator.
        if (effects.coordinated.contains(capability)) {
            if (binding == null) binding = @ptrCast(@constCast((try a.dupeSentinel(u8, "", 0)).ptr));
            try effects.names.put(a, @intFromPtr(binding), if (g.value.get("coordinator")) |x| x.string else null);
        }
        if (ops == .string) {
            try check(c.talk_capability_def_grant_all(def, binding, &grant));
        } else {
            var names: std.ArrayList([*c]const u8) = .empty;
            var lens: std.ArrayList(usize) = .empty;
            for (ops.array) |o| {
                try names.append(a, o.string.ptr);
                try lens.append(a, o.string.len);
            }
            try check(c.talk_capability_def_grant(def, names.items.ptr, lens.items.ptr, names.items.len, binding, &grant));
        }
        try out.append(a, .{ .name = g.key.ptr, .name_len = g.key.len, .grant = grant });
    }
    return out.items;
}

/// The runner's `Grants` function: each Script's Grants as it loaded them,
/// but those `unbound` names.
const Rebinding = struct {
    grants: *std.StringHashMapUnmanaged([]c.talk_load_grant),
    unbound: []const []const u8,

    fn call(context: ?*anyopaque, script: [*c]const u8, script_len: usize, name: [*c]const u8, name_len: usize) callconv(.c) ?*c.talk_grant {
        const r: *Rebinding = @ptrCast(@alignCast(context.?));
        const s = script[0..script_len];
        const n = name[0..name_len];
        for (r.unbound) |u| {
            if (u.len == s.len + 1 + n.len and std.mem.startsWith(u8, u, s) and u[s.len] == '.' and std.mem.endsWith(u8, u, n)) return null;
        }
        const grants = r.grants.get(s) orelse return null;
        for (grants) |g| if (std.mem.eql(u8, g.name[0..g.name_len], n)) return g.grant;
        return null;
    }
};

/// The runner's `Resolve` function: every object but those `disposed`.
const Resolving = struct {
    refused: []const [2][]const u8,

    fn call(context: ?*anyopaque, kind: [*c]const u8, kind_len: usize, id: [*c]const u8, id_len: usize, native: [*c]?*anyopaque) callconv(.c) bool {
        const r: *Resolving = @ptrCast(@alignCast(context.?));
        native.* = null;
        for (r.refused) |x| if (std.mem.eql(u8, x[0], kind[0..kind_len]) and std.mem.eql(u8, x[1], id[0..id_len])) return false;
        return true;
    }
};

/// A Function Value a Request gave the Host, by its display form, owned.
fn heldFunction(a: std.mem.Allocator, requests: []const *c.talk_pending, shown: []const u8) !?*c.talk_value {
    _ = a;
    for (requests) |p| {
        var v: ?*c.talk_value = null;
        try check(c.talk_pending_result(p, &v));
        if (c.talk_value_kind(v) != c.TALK_KIND_FUNCTION) {
            c.talk_value_release(v);
            continue;
        }
        var text: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        try check(c.talk_value_string(v, &text));
        defer c.talk_owned_bytes_release(&text);
        if (std.mem.eql(u8, text.data[0..text.len], shown)) return v;
        c.talk_value_release(v);
    }
    return null;
}

const Restored = struct { group: ?*c.talk_group, adopted: []const struct { id: []const u8, call: ?*c.talk_call } };

/// Saves and restores between two Pumps (chapter 11, Save and restore
/// replays), out of the Trace: the restored Group, with every Grant re-bound,
/// every Host Object resolved and every pending call adopted, or null where
/// the original goes on. That is where the save is refused `effects
/// pending`, where no Pump follows, where the case saves or restores there
/// itself, and where a later answer or failure is for a call the save
/// doesn't hold, whose handle belongs to the old Group.
fn roundTrip(a: std.mem.Allocator, core: ?*c.talk_core, sink: *Sink, group: ?*c.talk_group, later: []const []const u8, libraries: *std.StringHashMapUnmanaged(*c.talk_library), grants: *std.StringHashMapUnmanaged([]c.talk_load_grant)) !?Restored {
    const pumps = for (later) |l| {
        if (std.mem.startsWith(u8, l, "> pump")) break true;
    } else false;
    if (!pumps) return null;
    if (later.len > 0) for ([_][]const u8{ "> save", "> restore", "> settle" }) |x| {
        if (std.mem.startsWith(u8, later[0], x)) return null;
    };
    // A Function Value the Host holds belongs to the original Group.
    for (later) |l| if (std.mem.startsWith(u8, l, "> call-value") or (std.mem.startsWith(u8, l, "> ") and std.mem.indexOf(u8, l, "<function ") != null)) return null;
    sink.hidden = true;
    defer sink.hidden = false;
    var saved: c.talk_owned_bytes = .{ .data = null, .len = 0 };
    const code = c.talk_save(group, &saved);
    if (code == c.TALK_EFFECTS_PENDING) return null;
    try check(code);
    defer c.talk_owned_bytes_release(&saved);
    var given: std.ArrayList(?*c.talk_library) = .empty;
    var it = libraries.valueIterator();
    while (it.next()) |l| try given.append(a, l.*);
    var rebinding: Rebinding = .{ .grants = grants, .unbound = &.{} };
    var resolving: Resolving = .{ .refused = &.{} };
    const options: c.talk_restore_options = .{ .name = "corpus", .name_len = 6, .trace = record, .trace_context = sink, .libraries = @ptrCast(given.items.ptr), .libraries_len = given.items.len, .grants = Rebinding.call, .grants_context = &rebinding, .resolve = Resolving.call, .resolve_context = &resolving, .mismatch = c.TALK_REJECT_MISMATCH, .allocator = null, .memory_cap = 1 << 30 };
    var restored: ?*c.talk_group = null;
    var result: ?*c.talk_restore_result = null;
    try check(c.talk_restore(core, saved.data, saved.len, &options, &restored, &result));
    defer c.talk_restore_result_release(result);
    var pending: [*c]const c.talk_pending_call = null;
    const n = c.talk_restore_result_pending(result, &pending);
    // An answer or failure for a call that isn't pending belongs to the old
    // Group.
    for (later) |l| {
        const rest = if (std.mem.startsWith(u8, l, "> answer ")) l["> answer ".len..] else if (std.mem.startsWith(u8, l, "> fail ")) l["> fail ".len..] else continue;
        const id = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
        for (pending[0..n]) |p| {
            if (std.mem.eql(u8, p.id[0..p.id_len], id)) break;
        } else {
            c.talk_group_release(restored);
            return null;
        }
    }
    const adopted = try a.alloc(@typeInfo(@FieldType(Restored, "adopted")).pointer.child, n);
    for (pending[0..n], adopted) |p, *x| {
        const id = try a.dupe(u8, p.id[0..p.id_len]);
        var call: ?*c.talk_call = null;
        const st: c.talk_settlement = .{ .answer = null, .fail = null, .reissue = false, .adopt = true };
        try check(c.talk_settle(restored, id.ptr, id.len, &st, &call));
        try sink.adopted.append(sink.gpa, id);
        x.* = .{ .id = id, .call = call };
    }
    return .{ .group = restored, .adopted = adopted };
}

/// Points each of the runner's Script handles at a restored Group's.
fn rehandle(scripts: *std.StringHashMapUnmanaged(*c.talk_script), group: ?*c.talk_group) !void {
    var names = scripts.iterator();
    while (names.next()) |e| e.value_ptr.* = c.talk_group_script(group, e.key_ptr.ptr, e.key_ptr.len) orelse return error.UnknownScript;
}

/// The ids of a Trace's `[a, b]` list.
fn idList(a: std.mem.Allocator, shown: []const u8) ![]const []const u8 {
    if (shown.len < 2 or shown[0] != '[') return error.MalformedCase;
    var out: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeSequence(u8, shown[1 .. shown.len - 1], ", ");
    while (it.next()) |x| try out.append(a, x);
    return out.items;
}

/// The kinds and ids of a list of `<object kind "id">`.
fn objectList(a: std.mem.Allocator, shown: []const u8) ![]const [2][]const u8 {
    var out: std.ArrayList([2][]const u8) = .empty;
    var rest = shown;
    while (std.mem.indexOf(u8, rest, "<object ")) |at| {
        const body = rest[at + "<object ".len ..];
        const sp = std.mem.indexOfScalar(u8, body, ' ') orelse return error.MalformedCase;
        const close = std.mem.indexOfScalar(u8, body[sp + 2 ..], '"') orelse return error.MalformedCase;
        try out.append(a, .{ body[0..sp], body[sp + 2 .. sp + 2 + close] });
        rest = body[sp + 2 + close ..];
    }
    return out.items;
}

/// Replays the case in `dir` and returns the Trace the Core wrote.
pub fn replay(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, setup: []const u8, trace: []const u8, round_trip: bool) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const s = try case_setup.read(a, setup);
    const core = c.talk_new() orelse return error.OutOfMemory;
    defer c.talk_core_release(core);
    var sink: Sink = .{ .gpa = gpa };
    errdefer sink.out.deinit(gpa);
    defer sink.renamed.deinit(gpa);
    defer sink.adopted.deinit(gpa);
    var group: ?*c.talk_group = null;
    // Cases at the conformance minimums hold more than the default physical
    // cap allows while they build their values.
    const options: c.talk_group_options = .{ .name = "corpus", .name_len = 6, .trace = record, .trace_context = &sink, .memory_cap = 1 << 30 };
    try check(c.talk_new_group(core, &options, &group));
    defer c.talk_group_release(group);
    var scripts: std.StringHashMapUnmanaged(*c.talk_script) = .empty;
    const all = try case_setup.tables(a, setup);
    var hosts: std.StringHashMapUnmanaged(*OperationHost) = .empty;
    var calls: std.StringHashMapUnmanaged(?*c.talk_call) = .empty;
    var defs: std.StringHashMapUnmanaged(?*c.talk_capability_def) = .empty;
    var effects: Effects = .{ .a = a };
    try defineCapabilities(a, core, all, &hosts, &defs, &calls, &effects);
    try defineStandard(a, core, all, &hosts, &defs, &calls, &effects);
    var store: ObjectStore = .{ .a = a };
    defer store.deinit();
    try defineObjects(a, core, group, all, &store);
    // The version of each Library the runner compiled last, by name.
    var libraries: std.StringHashMapUnmanaged(*c.talk_library) = .empty;
    var declarations: std.ArrayList(c.talk_load_grant) = .empty;
    // Saves by id, each Script's Grants as loaded, which a restore re-binds,
    // and the Groups a restore replaced.
    var saves: std.StringHashMapUnmanaged([]const u8) = .empty;
    var latest: ?[]const u8 = null;
    var script_grants: std.StringHashMapUnmanaged([]c.talk_load_grant) = .empty;
    var retired: std.ArrayList(?*c.talk_group) = .empty;
    // Each Request's future, whose result the Host may hold.
    var requests: std.ArrayList(*c.talk_pending) = .empty;
    defer for (retired.items) |x| c.talk_group_release(x);
    // Released before the Groups that made them.
    var held: Received = .{ .a = gpa };
    received = &held;
    defer {
        received = null;
        held.deinit();
    }
    try compileLibraries(a, io, dir, core, all, &defs, &effects, &libraries, &declarations);
    const order = (try hostOrder(a, trace)).items;
    // The inputs a Host function makes during a Pump, which the main order
    // skips.
    var crossed: std.AutoHashMapUnmanaged(usize, void) = .empty;
    for (order, 0..) |line, at| {
        if (crossed.contains(@intFromPtr(line.ptr))) continue;
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
            const table = for (all) |t| {
                if (std.mem.eql(u8, t.header, "[[scripts]]") and std.mem.eql(u8, case_setup.field(t, "name").?.string, script)) break t;
            } else return error.UnknownScript;
            const grants = try grantsOf(a, table, &defs, &effects);
            try script_grants.put(a, script, grants);
            const as_used = if (case_setup.field(table, "grantsAsUsed")) |x| x == .raw and std.mem.eql(u8, x.raw, "true") else false;
            const owner: ?*c.talk_object = if (case_setup.field(table, "owner")) |x| try objectNamed(&store, a, x) else null;
            var bound: std.ArrayList(c.talk_load_object) = .empty;
            if (case_setup.field(table, "objects")) |given| for (given.table) |e| {
                try bound.append(a, .{ .name = e.key.ptr, .name_len = e.key.len, .object = try objectNamed(&store, a, e.value) });
            };
            var limits: c.talk_limits = std.mem.zeroes(c.talk_limits);
            for (scriptLimits(all, table)) |e| {
                const field_of = limitField(e.key) orelse return error.MalformedCase;
                const v = number(e.value);
                inline for (@typeInfo(c.talk_limits).@"struct".field_names) |f| if (std.mem.eql(u8, f, field_of)) {
                    @field(limits, f) = v;
                };
            }
            const load: c.talk_load_options = .{ .name = script.ptr, .name_len = script.len, .source = source.ptr, .source_len = source.len, .grants = grants.ptr, .grants_len = grants.len, .grants_as_used = as_used, .owner = owner, .objects = bound.items.ptr, .objects_len = bound.items.len, .limits = &limits };
            var loaded: ?*c.talk_script = null;
            const code = c.talk_load(group, &load, &loaded);
            if (code == c.TALK_LOAD_REFUSED) continue;
            try check(code);
            try scripts.put(a, script, loaded.?);
        } else if (std.mem.eql(u8, name, "add-library")) {
            const rest = input[name_end + 1 ..];
            const library = libraries.get(rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len]) orelse return error.MalformedCase;
            // A refusal is in the Trace as a `refused` record.
            const code = c.talk_add_library(group, library);
            if (code != c.TALK_RESERVED_NAME and code != c.TALK_NAME_REUSED and code != c.TALK_LIBRARY_MISMATCH) try check(code);
        } else if (std.mem.eql(u8, name, "reload") or std.mem.eql(u8, name, "extend")) {
            // The source travels in the Trace, its scalars as written.
            const rest = input[name_end + 1 ..];
            const script = scripts.get(rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase]) orelse return error.UnknownScript;
            const source = try northtalk.display.readSource(a, field(input, "source") orelse return error.MalformedCase);
            // A refusal is in the Trace, as `diag` or `refused` records.
            if (std.mem.eql(u8, name, "extend")) {
                const code = c.talk_script_extend(script, source.ptr, source.len);
                if (code != c.TALK_LOAD_REFUSED and code != c.TALK_NAME_REUSED and code != c.TALK_STATE_TOO_LARGE) try check(code);
            } else {
                const carry: c.talk_carry_over = if (std.mem.eql(u8, field(input, "carry") orelse "", "yes")) c.TALK_CARRY_VARIABLES else c.TALK_RESET_VARIABLES;
                const o: c.talk_reload_options = .{ .keep_mailbox = std.mem.eql(u8, field(input, "mailbox") orelse "", "keep") };
                const code = c.talk_script_reload(script, source.ptr, source.len, carry, &o, null);
                if (code != c.TALK_LOAD_REFUSED and code != c.TALK_STATE_TOO_LARGE and code != c.TALK_EFFECT_STATE_UNKNOWN) try check(code);
            }
        } else if (std.mem.eql(u8, name, "replace-library")) {
            const rest = input[name_end + 1 ..];
            const library = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase];
            const replaced = libraries.get(library) orelse return error.MalformedCase;
            const source = try northtalk.display.readSource(a, field(input, "source") orelse return error.MalformedCase);
            var imports: std.ArrayList(?*c.talk_library) = .empty;
            for (try usedLibraries(a, source)) |n| if (libraries.get(n)) |l| try imports.append(a, l);
            var label: [*c]const u8 = null;
            var label_len: usize = 0;
            c.talk_library_version(replaced, &label, &label_len);
            const src: c.talk_library_source = .{ .name = library.ptr, .name_len = library.len, .version = label, .version_len = label_len, .source = source.ptr, .source_len = source.len };
            var l: ?*c.talk_library = null;
            try check(c.talk_compile_library(core, &src, imports.items.ptr, imports.items.len, declarations.items.ptr, declarations.items.len, &l));
            const carry: c.talk_carry_over = if (std.mem.eql(u8, field(input, "carry") orelse "", "yes")) c.TALK_CARRY_VARIABLES else c.TALK_RESET_VARIABLES;
            const code = c.talk_replace_library(group, l, carry, null);
            if (code == c.TALK_OK) {
                try libraries.put(a, library, l.?);
            } else if (code != c.TALK_LOAD_REFUSED and code != c.TALK_STATE_TOO_LARGE) try check(code);
        } else if (std.mem.eql(u8, name, "save")) {
            // The save is kept under the id the Core gives it.
            var saved: c.talk_owned_bytes = .{ .data = null, .len = 0 };
            const code = c.talk_save(group, &saved);
            if (code == c.TALK_EFFECTS_PENDING) continue;
            try check(code);
            defer c.talk_owned_bytes_release(&saved);
            const id = try a.dupe(u8, input[name_end + 1 ..]);
            try saves.put(a, id, try a.dupe(u8, saved.data[0..saved.len]));
            latest = id;
        } else if (std.mem.eql(u8, name, "restore")) {
            const bytes_saved = saves.get(field(input, "from") orelse latest orelse return error.MalformedCase) orelse return error.MalformedCase;
            var withheld: []const []const u8 = &.{};
            if (field(input, "withheld")) |x| withheld = try idList(a, x);
            var given: std.ArrayList(?*c.talk_library) = .empty;
            var it = libraries.iterator();
            while (it.next()) |e| {
                for (withheld) |w| {
                    if (std.mem.eql(u8, w, e.key_ptr.*)) break;
                } else try given.append(a, e.value_ptr.*);
            }
            var rebinding: Rebinding = .{ .grants = &script_grants, .unbound = if (field(input, "unbound")) |x| try idList(a, x) else &.{} };
            var resolving: Resolving = .{ .refused = if (field(input, "disposed")) |x| try objectList(a, x) else &.{} };
            const restore_options: c.talk_restore_options = .{
                .name = "corpus",
                .name_len = 6,
                .trace = record,
                .trace_context = &sink,
                .libraries = @ptrCast(given.items.ptr),
                .libraries_len = given.items.len,
                .grants = Rebinding.call,
                .grants_context = &rebinding,
                .resolve = Resolving.call,
                .resolve_context = &resolving,
                .mismatch = if (std.mem.eql(u8, field(input, "mismatch") orelse "", "variables-only")) c.TALK_VARIABLES_ONLY else c.TALK_REJECT_MISMATCH,
                .allocator = null,
                .memory_cap = 1 << 30,
            };
            var restored: ?*c.talk_group = null;
            var result: ?*c.talk_restore_result = null;
            const code = c.talk_restore(core, bytes_saved.ptr, bytes_saved.len, &restore_options, &restored, &result);
            if (code == c.TALK_SAVE_MISMATCH or code == c.TALK_LOAD_REFUSED or code == c.TALK_STATE_TOO_LARGE) continue;
            try check(code);
            c.talk_restore_result_release(result);
            // The runner goes on with the restored Group; the old one lives
            // until the end, since its handles may still be read.
            try retired.append(a, group);
            group = restored;
            try rehandle(&scripts, group);
            try store.moveTo(group);
        } else if (std.mem.eql(u8, name, "settle")) {
            const rest = input[name_end + 1 ..];
            const id = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase];
            const how = field(input, "how") orelse return error.MalformedCase;
            var st: c.talk_settlement = .{ .answer = null, .fail = null, .reissue = false, .adopt = false };
            var e: c.talk_script_error = undefined;
            var owned_value: ?*c.talk_value = null;
            defer if (owned_value) |v| c.talk_value_release(v);
            if (std.mem.eql(u8, how, "answer")) {
                owned_value = parsed(field(input, "value") orelse return error.MalformedCase) orelse return error.MalformedCase;
                st.answer = owned_value;
            } else if (std.mem.eql(u8, how, "fail")) {
                if (!scriptError(a, field(input, "error") orelse return error.MalformedCase, &e)) return error.MalformedCase;
                st.fail = &e;
            } else if (std.mem.eql(u8, how, "reissue")) {
                st.reissue = true;
            } else if (std.mem.eql(u8, how, "adopt")) {
                st.adopt = true;
            } else return error.MalformedCase;
            defer if (st.fail != null) if (e.data) |d| c.talk_value_release(d);
            var adopted: ?*c.talk_call = null;
            const code = c.talk_settle(group, id.ptr, id.len, &st, &adopted);
            // A refusal is in the Trace as a `refused` record.
            if (code != c.TALK_UNKNOWN_CALL) try check(code);
            if (adopted) |x| try calls.put(a, try a.dupe(u8, id), x);
        } else if (std.mem.eql(u8, name, "set-parent")) {
            const o = store.named(field(input, "object").?) orelse return error.MalformedCase;
            const shown = field(input, "parent").?;
            const parent: ?*c.talk_object = if (std.mem.eql(u8, shown, "nothing")) null else store.named(shown) orelse return error.MalformedCase;
            // A refusal at the call is in the Trace as a `refused` record.
            const code = c.talk_set_parent(group, o, parent);
            if (code != c.TALK_PARENT_CYCLE and code != c.TALK_INVALID_VALUE) try check(code);
        } else if (std.mem.eql(u8, name, "dispose")) {
            try check(c.talk_dispose(group, store.named(field(input, "object").?) orelse return error.MalformedCase));
        } else if (std.mem.eql(u8, name, "deliver") or std.mem.eql(u8, name, "request") or std.mem.eql(u8, name, "decide")) {
            const to_shown = field(input, "to").?;
            const to_object: ?*c.talk_object = if (std.mem.startsWith(u8, to_shown, "<object ")) store.named(to_shown) orelse return error.MalformedCase else null;
            const to = if (to_object != null) null else scripts.get(to_shown) orelse return error.UnknownScript;
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
            var override: c.talk_limit_override = std.mem.zeroes(c.talk_limit_override);
            const has_override = try overrideOf(input, &override);
            const m: c.talk_message = .{ .name = message.ptr, .name_len = message.len, .args = @ptrCast(args.items.ptr), .args_len = args.items.len, .limits = if (has_override) &override else null };
            var pending: ?*c.talk_pending = null;
            var deciding: ?*c.talk_deciding = null;
            const code = if (std.mem.eql(u8, name, "decide"))
                (if (to_object) |o| c.talk_decide(group, o, &m, null, &deciding) else c.talk_script_decide(to, &m, null, &deciding))
            else if (to_object) |o|
                (if (std.mem.eql(u8, name, "deliver")) c.talk_deliver(group, o, &m, null) else c.talk_request(group, o, &m, null, &pending))
            else if (std.mem.eql(u8, name, "deliver"))
                c.talk_script_deliver(to, &m, null)
            else
                c.talk_script_request(to, &m, null, &pending);
            // A refusal at the call is in the Trace, as a `refused` record.
            if (code != c.TALK_INVALID_VALUE and code != c.TALK_ERR_MAILBOX_FULL) try check(code);
            if (pending) |p| try requests.append(a, p);
        } else if (std.mem.eql(u8, name, "call-value")) {
            // The Function Value is one a Request earlier gave the Host.
            const shown = field(input, "fn") orelse return error.MalformedCase;
            const f = try heldFunction(a, requests.items, shown) orelse return error.MalformedCase;
            defer c.talk_value_release(f);
            var args: std.ArrayList(?*c.talk_value) = .empty;
            defer for (args.items) |v| c.talk_value_release(v);
            if (field(input, "args")) |list_shown| {
                var list: ?*c.talk_value = null;
                try check(c.talk_parse_display(list_shown.ptr, list_shown.len, &list));
                defer c.talk_value_release(list);
                for (0..c.talk_value_len(list)) |i| {
                    var item: ?*c.talk_value = null;
                    try check(c.talk_value_index(list, i + 1, &item));
                    try args.append(a, item);
                }
            }
            var override: c.talk_limit_override = std.mem.zeroes(c.talk_limit_override);
            const has_override = try overrideOf(input, &override);
            var pending: ?*c.talk_pending = null;
            try check(c.talk_group_call(group, f, @ptrCast(args.items.ptr), args.items.len, if (has_override) &override else null, null, &pending));
            try requests.append(a, pending.?);
        } else if (std.mem.eql(u8, name, "broadcast") or std.mem.eql(u8, name, "decide-broadcast")) {
            // The Core writes the recipients, when the queue is drained.
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
            var override: c.talk_limit_override = std.mem.zeroes(c.talk_limit_override);
            const has_override = try overrideOf(input, &override);
            const m: c.talk_message = .{ .name = message.ptr, .name_len = message.len, .args = @ptrCast(args.items.ptr), .args_len = args.items.len, .limits = if (has_override) &override else null };
            var deciding: ?*c.talk_deciding = null;
            const code = if (std.mem.eql(u8, name, "broadcast")) c.talk_broadcast(group, &m, null) else c.talk_decide_broadcast(group, &m, null, &deciding);
            if (code != c.TALK_INVALID_VALUE) try check(code);
        } else if (std.mem.eql(u8, name, "pump")) {
            const clock = field(input, "clock").?;
            var instant: ?*c.talk_value = null;
            try check(c.talk_parse_display(clock.ptr, clock.len, &instant));
            defer c.talk_value_release(instant);
            var seconds: i64 = 0;
            var nanos: i32 = 0;
            if (!c.talk_value_as_instant(instant, &seconds, &nanos)) return error.BadClock;
            const pump_options: c.talk_pump_options = .{ .fuel_slice = if (field(input, "fuel-slice")) |x| try std.fmt.parseInt(i64, x, 10) else 0, .fuel_cap = if (field(input, "fuel-cap")) |x| try std.fmt.parseInt(i64, x, 10) else 0 };
            // A refusal is in the Trace as a `refused` record.
            var made: Crossing = .{ .group = group, .scripts = &scripts, .store = &store, .inputs = try crossings(a, trace, line) };
            for (made.inputs) |x| try crossed.put(a, @intFromPtr(x.line.ptr), {});
            crossing = &made;
            var pumped: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
            const code = c.talk_pump(group, seconds, nanos, &pump_options, &pumped);
            crossing = null;
            held.keepReports(pumped.reports);
            c.talk_reports_release(pumped.reports);
            if (made.failed or made.next != made.inputs.len) {
                return error.CrossingInput;
            }
            if (code != c.TALK_CLOCK_BACKWARDS) try check(code);
            if (round_trip) if (try roundTrip(a, core, &sink, group, order[at + 1 ..], &libraries, &script_grants)) |restored| {
                try retired.append(a, group);
                group = restored.group;
                try rehandle(&scripts, group);
                try store.moveTo(group);
                for (restored.adopted) |x| try calls.put(a, x.id, x.call);
            };
        } else if (std.mem.eql(u8, name, "vars")) {
            c.talk_inspect(group);
        } else if (std.mem.eql(u8, name, "stop")) {
            const rest = input[name_end + 1 ..];
            const script = scripts.get(rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase]) orelse return error.UnknownScript;
            var reason: ?*c.talk_value = null;
            const shown = field(input, "reason") orelse return error.MalformedCase;
            try check(c.talk_parse_display(shown.ptr, shown.len, &reason));
            defer c.talk_value_release(reason);
            var text: [*c]const u8 = null;
            var text_len: usize = 0;
            if (!c.talk_value_as_text(reason, &text, &text_len)) return error.MalformedCase;
            try check(c.talk_script_stop(script, text, text_len));
        } else if (std.mem.eql(u8, name, "rewind-run")) {
            const id = input[name_end + 1 ..];
            const script = scripts.get(id[0 .. std.mem.indexOfScalar(u8, id, '/') orelse return error.MalformedCase]) orelse return error.UnknownScript;
            try check(c.talk_script_rewind_run(script, id.ptr, id.len));
        } else if (std.mem.eql(u8, name, "cancel-run")) {
            const id = input[name_end + 1 ..];
            const script = scripts.get(id[0 .. std.mem.indexOfScalar(u8, id, '/') orelse return error.MalformedCase]) orelse return error.UnknownScript;
            try check(c.talk_script_cancel_run(script, id.ptr, id.len));
        } else if (std.mem.eql(u8, name, "cancel-delivery")) {
            const id = input[name_end + 1 ..];
            try check(c.talk_cancel_delivery(group, id.ptr, id.len));
        } else if (std.mem.eql(u8, name, "revoke")) {
            const rest = input[name_end + 1 ..];
            const script_end = std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedCase;
            const script = scripts.get(rest[0..script_end]) orelse return error.UnknownScript;
            const grant = field(input, "grant") orelse return error.MalformedCase;
            try check(c.talk_script_revoke(script, grant.ptr, grant.len));
        } else if (std.mem.eql(u8, name, "counters")) {
            const script = scripts.get(input[name_end + 1 ..]) orelse return error.UnknownScript;
            var read: c.talk_counters = undefined;
            c.talk_script_counters(script, &read);
        } else if (std.mem.eql(u8, name, "answer") or std.mem.eql(u8, name, "fail")) {
            // The Host settles a suspending call it started.
            const rest = input[name_end + 1 ..];
            const id = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const call = calls.get(id) orelse return error.UnknownCall;
            if (std.mem.eql(u8, name, "answer")) {
                const v = parsed(field(input, "value") orelse return error.MalformedCase) orelse return error.MalformedCase;
                defer c.talk_value_release(v);
                if (field(input, "fuel")) |n| {
                    try check(c.talk_call_answer_with_cost(call, v, try std.fmt.parseInt(i64, n, 10)));
                } else try check(c.talk_call_answer(call, v));
            } else {
                var e: c.talk_script_error = undefined;
                if (scriptError(a, field(input, "error") orelse return error.MalformedCase, &e)) {
                    defer if (e.data) |d| c.talk_value_release(d);
                    try check(c.talk_call_fail(call, &e));
                } else try check(c.talk_call_fail(call, null));
            }
        } else if (std.mem.eql(u8, name, "stub")) {
            // The runner's own input: queued for its Operation, and written
            // to the Trace where the case has it.
            const rest = input[name_end + 1 ..];
            const op = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const h = hosts.get(op) orelse return error.UnknownOperation;
            try h.stubs.append(a, .{ .value = field(input, "value"), .err = field(input, "error"), .charge = if (field(input, "charge")) |n| try std.fmt.parseInt(i64, n, 10) else null });
            try sink.out.appendSlice(gpa, line);
            try sink.out.append(gpa, '\n');
        } else if (std.mem.eql(u8, name, "stub-effect")) {
            // A hook result for the participant whose first enrolled Grant
            // is `<script>.<grant>`, written to the Trace where the case has
            // it.
            const rest = input[name_end + 1 ..];
            const who = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const key = try std.fmt.allocPrint(a, "{s}.{s}", .{ who, field(input, "phase") orelse return error.MalformedCase });
            const status_text = field(input, "status") orelse return error.MalformedCase;
            const status: c.talk_effect_status = if (std.mem.eql(u8, status_text, "ok")) c.TALK_EFFECT_OK else if (std.mem.eql(u8, status_text, "failed")) c.TALK_EFFECT_FAILED else c.TALK_EFFECT_UNKNOWN;
            const queue = try effects.stubs.getOrPut(a, key);
            if (!queue.found_existing) queue.value_ptr.* = .empty;
            try queue.value_ptr.append(a, status);
            try sink.out.appendSlice(gpa, line);
            try sink.out.append(gpa, '\n');
        } else return error.Unsupported;
    }
    if (sink.failed) return error.OutOfMemory;
    return sink.out.toOwnedSlice(gpa);
}

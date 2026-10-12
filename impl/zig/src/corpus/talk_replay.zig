//! Replays a Trace Case through talk.h alone, as a Host would: each Host
//! Input becomes the C call that makes it, and the Group's Trace sink collects
//! the lines the Core writes.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const case_setup = northtalk.corpus_case;

const step1_inputs = [_][]const u8{ "load", "deliver", "request", "pump", "vars", "stub" };

/// Why talk.h can't replay the case yet, or null.
pub fn supports(a: std.mem.Allocator, setup: []const u8, trace: []const u8) ?[]const u8 {
    const s = case_setup.read(a, setup) catch return "case.toml isn't read";
    for (s.units) |u| {
        if (u.library) return "Libraries are not implemented";
        if (u.objects.len > 0) return "Host Objects are not implemented";
    }
    if (grantsUnsupported(a, setup)) |why| return why;
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

/// The Standard Capabilities talk.h makes so far.
const standard_made = [_][]const u8{ "clock", "calendar", "locale", "console" };

/// Why talk.h can't make the case's Grants yet, or null: only immediate and
/// fire-and-forget Operations the case declares itself, with no scopes,
/// Segment-bound Operations or Coordinators, are.
fn grantsUnsupported(a: std.mem.Allocator, setup: []const u8) ?[]const u8 {
    const all = case_setup.tables(a, setup) catch return "case.toml isn't read";
    for (all) |t| {
        if (std.mem.eql(u8, t.header, "[[standard]]")) {
            const which = (case_setup.field(t, "capability") orelse return "a Standard Capability without a name").string;
            for (standard_made) |made| {
                if (std.mem.eql(u8, made, which)) break;
            } else return "Standard Capabilities other than clock, calendar, locale and console are not implemented";
        }
        if (!std.mem.eql(u8, t.header, "[[operations]]")) continue;
        const mode = case_setup.field(t, "mode") orelse return "an Operation without a mode";
        if (mode != .string or std.mem.eql(u8, mode.string, "suspending")) return "suspending Operations are not implemented";
        if (case_setup.field(t, "scope") != null or case_setup.field(t, "segmentBound") != null) return "Capability Scopes are not implemented";
        for ((case_setup.field(t, "args") orelse continue).array) |shape| if (!shapeSupported(shape)) return "object Shapes are not implemented";
    }
    for (all) |t| {
        if (!std.mem.eql(u8, t.header, "[[scripts]]")) continue;
        const grants = case_setup.field(t, "grants") orelse continue;
        for (grants.table) |g| {
            if (g.value.get("coordinator") != null) return "Segment Coordinators are not implemented";
            if (case_setup.field(t, "limits") != null) return "limits are not implemented";
        }
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

// ---------------------------------------------------------------- Capabilities

/// What a Stub queues for one call: a result or an error, and a charge.
const Stub = struct { value: ?[]const u8 = null, err: ?[]const u8 = null, charge: ?i64 = null };

/// The runner's Host function for one Operation: its Stubs, in order.
const OperationHost = struct {
    /// Holds what the Host function gives the Core, until the case ends.
    a: std.mem.Allocator,
    name: []const u8,
    mode: c.talk_mode,
    stubs: std.ArrayList(Stub) = .empty,
    next: usize = 0,
};

fn parsed(shown: []const u8) ?*c.talk_value {
    var v: ?*c.talk_value = null;
    if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return null;
    return v;
}

fn host(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
    _ = args;
    _ = len;
    const h: *OperationHost = @ptrCast(@alignCast(context.?));
    const stub: Stub = if (h.next < h.stubs.items.len) blk: {
        h.next += 1;
        break :blk h.stubs.items[h.next - 1];
    } else if (h.mode == c.TALK_FIRE_AND_FORGET) .{} else return c.TALK_CALL_BROKEN;
    if (stub.charge) |n| if (n > 0 and c.talk_call_charge(call, n) != c.TALK_OK) return c.TALK_CALL_LIMITED;
    if (stub.err) |shown| {
        const e = parsed(shown) orelse return c.TALK_CALL_BROKEN;
        defer c.talk_value_release(e);
        var code_value: ?*c.talk_value = null;
        if (c.talk_value_get(e, "code", 4, &code_value) != c.TALK_OK or code_value == null) return c.TALK_CALL_BROKEN;
        defer c.talk_value_release(code_value);
        var code: [*c]const u8 = null;
        var code_len: usize = 0;
        if (!c.talk_value_as_text(code_value, &code, &code_len)) return c.TALK_CALL_BROKEN;
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
            pairs.append(h.a, pair) catch return c.TALK_CALL_BROKEN;
        }
        var data: ?*c.talk_value = null;
        if (pairs.items.len > 0 and c.talk_map(pairs.items.ptr, pairs.items.len, &data) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        // The strings belong to the error value, so they are copied.
        const owned_code = h.a.dupe(u8, code[0..code_len]) catch return c.TALK_CALL_BROKEN;
        const owned_message = if (message) |m| h.a.dupe(u8, m) catch return c.TALK_CALL_BROKEN else null;
        err.* = .{ .code = owned_code.ptr, .code_len = owned_code.len, .message = if (owned_message) |m| m.ptr else null, .message_len = if (owned_message) |m| m.len else 0, .data = data };
        return c.TALK_CALL_FAILED;
    }
    if (stub.value) |shown| {
        result.* = parsed(shown) orelse return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }
    if (h.mode == c.TALK_FIRE_AND_FORGET) {
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }
    return c.TALK_CALL_BROKEN;
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
fn defineStandard(a: std.mem.Allocator, core: ?*c.talk_core, all: []const case_setup.Table, hosts: *std.StringHashMapUnmanaged(*OperationHost), defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def)) !void {
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
        else if (std.mem.eql(u8, which, "console"))
            &.{ .{ "write", c.TALK_FIRE_AND_FORGET }, .{ "read", c.TALK_SUSPENDING } }
        else
            &.{};
        for (operations) |op| {
            const h = try a.create(OperationHost);
            h.* = .{ .a = a, .name = try std.fmt.allocPrint(a, "{s}.{s}", .{ which, op[0] }), .mode = op[1] };
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
        } else if (std.mem.eql(u8, which, "console")) {
            const impl: c.talk_console_impl = .{ .context = hosts, .write = standardHost("console.write"), .read = standardHost("console.read") };
            try check(c.talk_console_capability(core, &impl, &all_costs, &def));
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

fn number(v: ?case_setup.Value) i64 {
    const x = v orelse return 0;
    return if (x == .raw) std.fmt.parseInt(i64, x.raw, 10) catch 0 else 0;
}

/// Defines the case's Capabilities from its `[[operations]]` tables, with
/// one OperationHost each, keyed `<capability>.<operation>`.
fn defineCapabilities(a: std.mem.Allocator, core: ?*c.talk_core, all: []const case_setup.Table, hosts: *std.StringHashMapUnmanaged(*OperationHost), defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def)) !void {
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
            h.* = .{ .a = a, .name = try std.fmt.allocPrint(a, "{s}.{s}", .{ capability, name }), .mode = mode };
            try hosts.put(a, h.name, h);
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
            });
        }
        var def: ?*c.talk_capability_def = null;
        try check(c.talk_define_capability(core, capability.ptr, capability.len, ops.items.ptr, ops.items.len, &def));
        for (ops.items) |op| {
            for (op.args[0..op.args_len]) |x| c.talk_shape_release(x);
            if (op.result) |r| c.talk_shape_release(r);
            for (op.errors[0..op.errors_len]) |e| for (e.fields[0..e.fields_len]) |f| c.talk_shape_release(f.shape);
        }
        try defs.put(a, capability, def);
    }
}

/// A Script's Grants, from its `grants` table.
fn grantsOf(a: std.mem.Allocator, t: case_setup.Table, defs: *std.StringHashMapUnmanaged(?*c.talk_capability_def)) ![]c.talk_load_grant {
    var out: std.ArrayList(c.talk_load_grant) = .empty;
    const grants = case_setup.field(t, "grants") orelse return out.items;
    for (grants.table) |g| {
        const capability = if (g.value.get("capability")) |x| x.string else g.key;
        const def = defs.get(capability) orelse return error.UnknownCapability;
        var grant: ?*c.talk_grant = null;
        const ops = g.value.get("ops") orelse return error.MalformedCase;
        // A text binding reaches the Host as NUL-terminated text.
        const binding: ?*anyopaque = if (g.value.get("binding")) |b| (if (b == .string) @ptrCast(@constCast((try a.dupeSentinel(u8, b.string, 0)).ptr)) else null) else null;
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
    const all = try case_setup.tables(a, setup);
    var hosts: std.StringHashMapUnmanaged(*OperationHost) = .empty;
    var defs: std.StringHashMapUnmanaged(?*c.talk_capability_def) = .empty;
    try defineCapabilities(a, core, all, &hosts, &defs);
    try defineStandard(a, core, all, &hosts, &defs);
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
            const table = for (all) |t| {
                if (std.mem.eql(u8, t.header, "[[scripts]]") and std.mem.eql(u8, case_setup.field(t, "name").?.string, script)) break t;
            } else return error.UnknownScript;
            const grants = try grantsOf(a, table, &defs);
            const as_used = if (case_setup.field(table, "grantsAsUsed")) |x| x == .raw and std.mem.eql(u8, x.raw, "true") else false;
            const load: c.talk_load_options = .{ .name = script.ptr, .name_len = script.len, .source = source.ptr, .source_len = source.len, .grants = grants.ptr, .grants_len = grants.len, .grants_as_used = as_used };
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
        } else if (std.mem.eql(u8, name, "stub")) {
            // The runner's own input: queued for its Operation, and written
            // to the Trace where the case has it.
            const rest = input[name_end + 1 ..];
            const op = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const h = hosts.get(op) orelse return error.UnknownOperation;
            try h.stubs.append(a, .{ .value = field(input, "value"), .err = field(input, "error"), .charge = if (field(input, "charge")) |n| try std.fmt.parseInt(i64, n, 10) else null });
            try sink.out.appendSlice(gpa, line);
            try sink.out.append(gpa, '\n');
        } else return error.Unsupported;
    }
    if (sink.failed) return error.OutOfMemory;
    return sink.out.toOwnedSlice(gpa);
}

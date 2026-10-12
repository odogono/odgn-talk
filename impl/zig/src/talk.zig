//! The C API that include/talk.h declares. Each export keeps talk.h's name and
//! order; tools/zig/api.ts holds talk.h to spec/embedding/talk.go.
//!
//! Returned values own one reference. Decimal pointers and text slices borrow
//! their value; byte, display and encoding results own buffers.
const std = @import("std");
const builtin = @import("builtin");
const model = @import("value.zig");
const display = @import("display.zig");
const encoding = @import("encoding.zig");
const machine = @import("machine/machine.zig");
/// Value constructors take no Core, as talk.go's don't, so values come from
/// one process-wide allocator.
const allocator = if (builtin.target.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.smp_allocator;
pub const Value = model.Value;
pub const Kind = model.Kind;
pub const Decimal = model.Decimal;
pub const Buffer = extern struct { data: ?[*]u8 = null, len: usize = 0 };
pub const Pair = extern struct { key: ?[*]const u8, key_len: usize, value: *Value };
fn bytes(s: ?[*]const u8, len: usize) error{InvalidValue}![]const u8 {
    return if (len == 0) "" else (s orelse return error.InvalidValue)[0..len];
}
fn status(err: anyerror) HostErrorCode {
    return if (err == error.OutOfMemory) .out_of_memory else .invalid_value;
}
fn result(out: *?*Value, r: anyerror!*Value) HostErrorCode {
    out.* = r catch |err| {
        out.* = null;
        return status(err);
    };
    return .ok;
}
fn buffer(out: *Buffer, r: anyerror![]u8) HostErrorCode {
    const s = r catch |err| {
        out.* = .{};
        return status(err);
    };
    out.* = .{ .data = s.ptr, .len = s.len };
    return .ok;
}

export fn talk_nothing(out: *?*Value) HostErrorCode {
    return result(out, model.scalar(allocator, .nothing));
}
export fn talk_bool(b: bool, out: *?*Value) HostErrorCode {
    return result(out, model.scalar(allocator, .{ .bool = b }));
}
export fn talk_text(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    return result(out, model.text(allocator, bytes(s, len) catch return .invalid_value));
}
export fn talk_int(n: i64, out: *?*Value) HostErrorCode {
    return result(out, model.scalar(allocator, .{ .number = Decimal.fromInt(n) }));
}
export fn talk_uint(n: u64, out: *?*Value) HostErrorCode {
    return result(out, model.scalar(allocator, .{ .number = Decimal.fromInt(n) }));
}
export fn talk_from_float(f: f64, out: *?*Value) HostErrorCode {
    out.* = null;
    const n = Decimal.fromFloat(f) catch |err| return status(err);
    return result(out, model.scalar(allocator, .{ .number = n }));
}
export fn talk_dec(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const n = Decimal.parse(bytes(s, len) catch return .invalid_value) catch |err| return status(err);
    return result(out, model.scalar(allocator, .{ .number = n }));
}
export fn talk_quantity(n: *const Decimal, s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    return result(out, model.quantity(allocator, n.*, bytes(s, len) catch return .invalid_value));
}
export fn talk_civil_date(f: model.dates.Fields, out: *?*Value) HostErrorCode {
    out.* = null;
    model.dates.validate(f) catch return .invalid_value;
    return result(out, model.scalar(allocator, .{ .civil_date = f }));
}
export fn talk_parse_civil_date(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const f = model.dates.parseCivil(bytes(s, len) catch return .invalid_value) catch return .invalid_value;
    return result(out, model.scalar(allocator, .{ .civil_date = f }));
}
export fn talk_instant(seconds: i64, nanos: i32, out: *?*Value) HostErrorCode {
    out.* = null;
    const t = model.dates.Instant{ .seconds = seconds, .nanos = nanos };
    model.dates.validateInstant(t) catch return .invalid_value;
    return result(out, model.scalar(allocator, .{ .instant = t }));
}
export fn talk_bytes(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    return result(out, model.bytes(allocator, bytes(s, len) catch return .invalid_value));
}
export fn talk_list(vs: ?[*]const *Value, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const items: []const *Value = if (len == 0) &.{} else (vs orelse return .invalid_value)[0..len];
    return result(out, model.list(allocator, items));
}
export fn talk_map(input: ?[*]const Pair, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const ps: []const Pair = if (len == 0) &.{} else (input orelse return .invalid_value)[0..len];
    const pairs = allocator.alloc(model.Pair, len) catch return .out_of_memory;
    defer allocator.free(pairs);
    for (ps, pairs) |p, *q| q.* = .{ .key = bytes(p.key, p.key_len) catch return .invalid_value, .value = p.value };
    return result(out, model.map(allocator, pairs));
}
export fn talk_range(from: *Value, to: *Value, out: *?*Value) HostErrorCode {
    return result(out, model.range(allocator, from, to));
}
export fn talk_value_kind(v: *const Value) Kind {
    return v.kind();
}
export fn talk_value_as_bool(v: *const Value, out: *bool) bool {
    if (v.data != .bool) return false;
    out.* = v.data.bool;
    return true;
}
export fn talk_value_as_text(v: *const Value, s: *[*]const u8, len: *usize) bool {
    if (v.data != .text) return false;
    s.* = v.data.text.ptr;
    len.* = v.data.text.len;
    return true;
}
export fn talk_value_as_dec(v: *const Value, out: **const Decimal) bool {
    if (v.data != .number) return false;
    out.* = &v.data.number;
    return true;
}
export fn talk_value_as_quantity(v: *const Value, n: **const Decimal, unit: *Buffer) HostErrorCode {
    unit.* = .{};
    if (v.data != .quantity) return .invalid_value;
    n.* = &v.data.quantity.number;
    return buffer(unit, v.data.quantity.unit.string(allocator, false));
}
export fn talk_value_as_civil_date(v: *const Value, out: *model.dates.Fields) bool {
    if (v.data != .civil_date) return false;
    out.* = v.data.civil_date;
    return true;
}
export fn talk_value_as_instant(v: *const Value, seconds: *i64, nanos: *i32) bool {
    if (v.data != .instant) return false;
    seconds.* = v.data.instant.seconds;
    nanos.* = v.data.instant.nanos;
    return true;
}
export fn talk_value_as_bytes(v: *const Value, out: *Buffer) HostErrorCode {
    out.* = .{};
    if (v.data != .bytes) return .invalid_value;
    return buffer(out, allocator.dupe(u8, v.data.bytes));
}
export fn talk_value_as_range(v: *const Value, from: *?*Value, to: *?*Value) bool {
    from.* = null;
    to.* = null;
    if (v.data != .range) return false;
    from.* = v.data.range.from.retain();
    to.* = v.data.range.to.retain();
    return true;
}
export fn talk_value_len(v: *const Value) usize {
    return if (v.data == .list) v.data.list.len else 0;
}
export fn talk_value_index(v: *const Value, index: usize, out: *?*Value) HostErrorCode {
    if (v.data != .list or index == 0 or index > v.data.list.len) return talk_nothing(out);
    out.* = v.data.list[index - 1].retain();
    return .ok;
}
export fn talk_value_get(v: *const Value, s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const k = bytes(s, len) catch return .invalid_value;
    const key = model.text(allocator, k) catch |err| return status(err);
    defer key.release();
    if (v.get(key.data.text)) |item| {
        out.* = item.retain();
        return .ok;
    }
    return talk_nothing(out);
}
export fn talk_value_entries(v: *const Value, index: usize, out: *Pair) bool {
    if (v.data != .map or index >= v.data.map.len) return false;
    const p = v.data.map[index];
    out.* = .{ .key = p.key.ptr, .key_len = p.key.len, .value = p.value.retain() };
    return true;
}
export fn talk_value_pattern_source(v: *const Value, s: *[*]const u8, len: *usize) bool {
    if (v.data != .pattern) return false;
    s.* = v.data.pattern.ptr;
    len.* = v.data.pattern.len;
    return true;
}
export fn talk_value_home_script(v: *const Value, s: *[*]const u8, len: *usize) bool {
    if (v.data != .function) return false;
    s.* = v.data.function.home.ptr;
    len.* = v.data.function.home.len;
    return true;
}
export fn talk_value_string(v: *const Value, out: *Buffer) HostErrorCode {
    return buffer(out, display.string(allocator, v));
}
export fn talk_value_equal(v: *const Value, w: *const Value, out: *bool) HostErrorCode {
    out.* = v.equal(w) catch |err| return status(err);
    return .ok;
}
export fn talk_decimal_string(n: *const Decimal, out: *Buffer) HostErrorCode {
    return buffer(out, n.string(allocator));
}
export fn talk_decimal_int64(n: *const Decimal, out: *i64) HostErrorCode {
    out.* = n.integer(i64) catch return .invalid_value;
    return .ok;
}
export fn talk_decimal_uint64(n: *const Decimal, out: *u64) HostErrorCode {
    out.* = n.integer(u64) catch return .invalid_value;
    return .ok;
}
export fn talk_decimal_float64_lossy(n: *const Decimal) f64 {
    return n.float();
}
export fn talk_encode_value(v: *const Value, out: *Buffer) HostErrorCode {
    return buffer(out, encoding.encode(allocator, v));
}
pub const ResolveObject = *const fn (?*anyopaque, [*]const u8, usize, [*]const u8, usize) callconv(.c) ?*Value;
const ResolveContext = struct { callback: ResolveObject, context: ?*anyopaque };
fn resolveObject(context: ?*anyopaque, kind: []const u8, id: []const u8) model.Error!*Value {
    const r: *ResolveContext = @ptrCast(@alignCast(context.?));
    const v = r.callback(r.context, kind.ptr, kind.len, id.ptr, id.len) orelse return error.InvalidValue;
    if (v.data != .object or !std.mem.eql(u8, v.data.object.kind, kind) or !std.mem.eql(u8, v.data.object.id, id)) return error.InvalidValue;
    return v.retain();
}
export fn talk_decode_value(s: ?[*]const u8, len: usize, resolve: ?ResolveObject, context: ?*anyopaque, out: *?*Value) HostErrorCode {
    out.* = null;
    var r: ResolveContext = undefined;
    var resolver: display.Resolver = .{};
    if (resolve) |callback| {
        r = .{ .callback = callback, .context = context };
        resolver = .{ .context = &r, .object = resolveObject };
    }
    return result(out, encoding.decode(allocator, bytes(s, len) catch return .invalid_value, resolver));
}
// C-only display reader for the corpus and Host diagnostics.
export fn talk_parse_display(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    return result(out, display.parse(allocator, bytes(s, len) catch return .invalid_value, .{}));
}
export fn talk_value_retain(v: *Value) void {
    _ = v.retain();
}
export fn talk_value_release(v: ?*Value) void {
    if (v) |value| value.release();
}
export fn talk_owned_bytes_release(b: *Buffer) void {
    if (b.data) |p| allocator.free(p[0..b.len]);
    b.* = .{};
}

/// talk.h's `talk_host_error_code`, in the same order.
pub const HostErrorCode = enum(c_int) {
    ok = 0,
    clock_backwards,
    parent_cycle,
    duplicate_object_id,
    name_reused,
    reentrant_call,
    wrong_group,
    library_mismatch,
    reserved_name,
    not_adoptable,
    invalid_value,
    invalid_save,
    save_mismatch,
    unknown_call,
    state_too_large,
    effects_pending,
    effect_state_unknown,
    load_refused,
    out_of_memory,
};

// ---------------------------------------------------------------- Groups

pub const Core = struct { gpa: std.mem.Allocator };

pub const TraceSink = ?*const fn (context: ?*anyopaque, line: [*]const u8, len: usize) callconv(.c) void;

pub const GroupOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    trace: TraceSink,
    trace_context: ?*anyopaque,
};

pub const LoadOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    source: ?[*]const u8,
    source_len: usize,
};

pub const Message = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    args: ?[*]const *Value,
    args_len: usize,
};

pub const GroupState = enum(c_int) { idle, sliced, stopped, rewound };

pub const PumpOptions = extern struct { fuel_slice: i64, fuel_cap: i64 };

pub const PumpResult = extern struct { state: GroupState, fuel_used: i64 };

/// A Group and the writer its Trace goes through on its way to the sink.
pub const Group = struct {
    core: *Core,
    group: machine.Group,
    out: std.Io.Writer.Allocating,
    sink: TraceSink,
    context: ?*anyopaque,
    scripts: std.ArrayList(*Script) = .empty,
    pending: std.ArrayList(*Pending) = .empty,

    /// Sends each complete Trace line to the sink.
    fn flush(g: *Group) void {
        const written = g.out.written();
        var start: usize = 0;
        while (std.mem.indexOfScalarPos(u8, written, start, '\n')) |end| {
            if (g.sink) |sink| sink(g.context, written[start..].ptr, end - start);
            start = end + 1;
        }
        const rest = written[start..];
        std.mem.copyForwards(u8, g.out.writer.buffer[0..rest.len], rest);
        g.out.writer.end = rest.len;
    }
};

pub const Script = struct { group: *Group, name: []const u8 };

pub const Pending = struct { group: *Group, id: u64 };

export fn talk_new() ?*Core {
    const c = allocator.create(Core) catch return null;
    c.* = .{ .gpa = allocator };
    return c;
}

export fn talk_core_release(c: ?*Core) void {
    if (c) |core| allocator.destroy(core);
}

export fn talk_new_group(c: *Core, o: *const GroupOptions, out: *?*Group) HostErrorCode {
    out.* = null;
    const g = c.gpa.create(Group) catch return .out_of_memory;
    g.* = .{ .core = c, .group = undefined, .out = .init(c.gpa), .sink = o.trace, .context = o.trace_context };
    g.group = .init(c.gpa, if (o.trace != null) &g.out.writer else null);
    out.* = g;
    return .ok;
}

export fn talk_group_release(g: ?*Group) void {
    const group = g orelse return;
    const gpa = group.core.gpa;
    group.group.deinit();
    group.out.deinit();
    for (group.scripts.items) |s| {
        gpa.free(s.name);
        gpa.destroy(s);
    }
    group.scripts.deinit(gpa);
    for (group.pending.items) |p| gpa.destroy(p);
    group.pending.deinit(gpa);
    gpa.destroy(group);
}

export fn talk_load(g: *Group, o: *const LoadOptions, out: *?*Script) HostErrorCode {
    out.* = null;
    defer g.flush();
    const name = bytes(o.name, o.name_len) catch return .invalid_value;
    const source = bytes(o.source, o.source_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(source)) return .invalid_value;
    for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, name)) return .name_reused;
    const loaded = g.group.load(name, source, .{}) catch |err| return status(err);
    switch (loaded) {
        .refused => return .load_refused,
        .loaded => {},
    }
    const s = g.core.gpa.create(Script) catch return .out_of_memory;
    s.* = .{ .group = g, .name = g.core.gpa.dupe(u8, name) catch return .out_of_memory };
    g.scripts.append(g.core.gpa, s) catch return .out_of_memory;
    out.* = s;
    return .ok;
}

/// Queues a Delivery or Request: its delivery number, or the refusal.
fn queue(s: *Script, m: *const Message, request: bool, id: ?*Buffer, n_out: *u64) HostErrorCode {
    const g = s.group;
    const name = bytes(m.name, m.name_len) catch return .invalid_value;
    const args: []const *Value = if (m.args_len == 0) &.{} else (m.args orelse return .invalid_value)[0..m.args_len];
    const owned = g.core.gpa.alloc(*Value, args.len) catch return .out_of_memory;
    for (owned, args) |*x, v| x.* = v.retain();
    defer g.core.gpa.free(owned);
    const n = g.group.deliver(s.name, name, owned, request) catch {
        for (owned) |v| v.release();
        return .out_of_memory;
    };
    n_out.* = n;
    if (id) |b| {
        const text = std.fmt.allocPrint(allocator, "d{d}", .{n}) catch return .out_of_memory;
        b.* = .{ .data = text.ptr, .len = text.len };
    }
    return .ok;
}

export fn talk_script_deliver(s: *Script, m: *const Message, id: ?*Buffer) HostErrorCode {
    var n: u64 = 0;
    return queue(s, m, false, id, &n);
}

export fn talk_script_request(s: *Script, m: *const Message, id: ?*Buffer, out: *?*Pending) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queue(s, m, true, id, &n);
    if (code != .ok) return code;
    const p = s.group.core.gpa.create(Pending) catch return .out_of_memory;
    p.* = .{ .group = s.group, .id = n };
    s.group.pending.append(s.group.core.gpa, p) catch return .out_of_memory;
    out.* = p;
    return .ok;
}

export fn talk_pending_result(p: *const Pending, out: *?*Value) HostErrorCode {
    if (p.group.group.results.get(p.id)) |v| {
        out.* = v.retain();
        return .ok;
    }
    return result(out, model.scalar(allocator, .nothing));
}

export fn talk_pending_release(p: ?*Pending) void {
    _ = p;
    // A Request's handle lives with its Group, which frees it.
}

export fn talk_pump(g: *Group, seconds: i64, nanos: i32, o: ?*const PumpOptions, out: ?*PumpResult) HostErrorCode {
    _ = o;
    defer g.flush();
    const clock = model.dates.Instant{ .seconds = seconds, .nanos = nanos };
    model.dates.validateInstant(clock) catch return .invalid_value;
    g.group.pump(clock) catch |err| return status(err);
    if (out) |r| r.* = .{ .state = .idle, .fuel_used = @intCast(g.group.pump_fuel) };
    return .ok;
}

export fn talk_inspect(g: *Group) void {
    g.group.vars();
    g.flush();
}

/// Whether `E`'s tags, spelled `prefix` ++ TAG, are the enumerators of
/// talk.h's `typedef enum name`, in order and with nothing else.
fn expectHeaderEnum(comptime E: type, comptime name: []const u8, comptime prefix: []const u8) !void {
    const header = @embedFile("talk.h");
    const start = std.mem.indexOf(u8, header, "typedef enum " ++ name ++ " {") orelse return error.TestUnexpectedResult;
    const end = std.mem.indexOfPos(u8, header, start, "} " ++ name ++ ";") orelse return error.TestUnexpectedResult;
    var enumerators = std.mem.tokenizeAny(u8, header[start..end], " \t\n,{}=0");
    inline for (comptime std.meta.fieldNames(E), 0..) |field, i| {
        // talk.h's enumerators take implicit, consecutive values from 0.
        try std.testing.expectEqual(i, @backingInt(@field(E, field)));
        var expected: [prefix.len + field.len]u8 = undefined;
        @memcpy(expected[0..prefix.len], prefix);
        for (field, expected[prefix.len..]) |c, *upper| upper.* = if (c >= 'a' and c <= 'z') c - 32 else c;
        while (enumerators.next()) |token| {
            if (std.mem.startsWith(u8, token, "TALK_")) {
                try std.testing.expectEqualStrings(&expected, token);
                break;
            }
        } else return error.TestUnexpectedResult;
    }
    while (enumerators.next()) |token| {
        if (std.mem.startsWith(u8, token, "TALK_")) return error.TestUnexpectedResult;
    }
}

test "the Host's text is refused unless UTF-8, and normalised" {
    var out: ?*Value = undefined;
    try std.testing.expectEqual(HostErrorCode.invalid_value, talk_text("\xED\xA0\x80", 3, &out));
    try std.testing.expectEqual(@as(?*Value, null), out);
    try std.testing.expectEqual(HostErrorCode.ok, talk_text("Cafe\u{0301}", 6, &out));
    defer talk_value_release(out);
    var s: [*]const u8 = undefined;
    var len: usize = 0;
    try std.testing.expect(talk_value_as_text(out.?, &s, &len));
    try std.testing.expectEqualStrings("Caf\u{00E9}", s[0..len]);
    var refused: ?*Value = undefined;
    try std.testing.expectEqual(HostErrorCode.invalid_value, talk_text(null, 1, &refused));
    try std.testing.expectEqual(@as(?*Value, null), refused);
}

test "the enums match talk.h's" {
    try expectHeaderEnum(HostErrorCode, "talk_host_error_code", "TALK_");
    try expectHeaderEnum(Kind, "talk_kind", "TALK_KIND_");
    try expectHeaderEnum(GroupState, "talk_group_state", "TALK_");
}

test "a Group loads, pumps and inspects through the exports" {
    const core = talk_new().?;
    defer talk_core_release(core);
    var group: ?*Group = null;
    const options: GroupOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null };
    try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &options, &group));
    defer talk_group_release(group);
    const source = "script variable total = 0\non bump n\n  add n to total\n  return total & \"!\"\nend bump\n";
    const load: LoadOptions = .{ .name = "adder", .name_len = 5, .source = source.ptr, .source_len = source.len };
    var script: ?*Script = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_load(group.?, &load, &script));
    var n: ?*Value = null;
    _ = talk_int(41, &n);
    defer talk_value_release(n);
    const args = [_]*Value{n.?};
    const message: Message = .{ .name = "bump", .name_len = 4, .args = &args, .args_len = 1 };
    var pending: ?*Pending = null;
    var id: Buffer = .{};
    try std.testing.expectEqual(HostErrorCode.ok, talk_script_request(script.?, &message, &id, &pending));
    talk_owned_bytes_release(&id);
    var pumped: PumpResult = undefined;
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, 1790000000, 0, null, &pumped));
    var result_value: ?*Value = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_pending_result(pending.?, &result_value));
    defer talk_value_release(result_value);
    try std.testing.expectEqualStrings("41!", result_value.?.data.text);
}

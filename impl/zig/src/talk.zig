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
const caps = machine.capabilities;
const standard = @import("machine/standard.zig");
const objects = machine.objects;
const group_allocator = @import("machine/group_allocator.zig");
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
    return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.DuplicateObjectId => .duplicate_object_id,
        error.ParentCycle => .parent_cycle,
        error.NameReused => .name_reused,
        error.ReservedName => .reserved_name,
        error.LibraryMismatch => .library_mismatch,
        else => .invalid_value,
    };
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
/// The alignment of `talk_alloc`'s memory, enough for any talk.h struct.
const host_alignment: std.mem.Alignment = .@"16";

/// C only: memory in the Core's address space, for a Host in another, such
/// as a WASM runtime, to pass structs and text through.
export fn talk_alloc(size: usize) ?[*]u8 {
    const memory = allocator.alignedAlloc(u8, host_alignment, @max(size, 1)) catch return null;
    return memory.ptr;
}

export fn talk_free(p: ?[*]u8, size: usize) void {
    const ptr = p orelse return;
    const memory: []align(16) u8 = @alignCast(ptr[0..@max(size, 1)]);
    allocator.free(memory);
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
    err_limit,
    load_refused,
    out_of_memory,
};

// ---------------------------------------------------------------- Groups

pub const Core = struct {
    gpa: std.mem.Allocator,
    definitions: std.ArrayList(*caps.Capability) = .empty,
    bridges: std.ArrayList(*Bridge) = .empty,
    standard: std.ArrayList(*standard.Context) = .empty,
    kinds: std.ArrayList(*objects.Kind) = .empty,
    libraries: std.ArrayList(*machine.Library) = .empty,
    prop_bridges: std.ArrayList(*PropBridge) = .empty,
};

pub const TraceSink = ?*const fn (context: ?*anyopaque, line: [*]const u8, len: usize) callconv(.c) void;

pub const GroupOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    trace: TraceSink,
    trace_context: ?*anyopaque,
    allocator: ?*const HostAllocator = null,
    memory_cap: usize = 0,
};

/// A Host's allocator, which a Group allocates from.
pub const HostAllocator = extern struct {
    context: ?*anyopaque,
    alloc: *const fn (context: ?*anyopaque, size: usize, alignment: usize) callconv(.c) ?*anyopaque,
    free: *const fn (context: ?*anyopaque, ptr: ?*anyopaque, size: usize, alignment: usize) callconv(.c) void,

    /// As a Zig allocator: the Host's functions allocate and free, and
    /// nothing resizes in place.
    fn allocator(h: *const HostAllocator) std.mem.Allocator {
        return .{ .ptr = @constCast(h), .vtable = &.{ .alloc = hostAlloc, .resize = std.mem.Allocator.noResize, .remap = std.mem.Allocator.noRemap, .free = hostFree } };
    }

    fn hostAlloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
        const h: *const HostAllocator = @ptrCast(@alignCast(ctx));
        const p = h.alloc(h.context, len, alignment.toByteUnits()) orelse return null;
        // A Host allocation must honour the alignment asked for.
        if (!alignment.check(@intFromPtr(p))) {
            h.free(h.context, p, len, alignment.toByteUnits());
            return null;
        }
        return @ptrCast(p);
    }

    fn hostFree(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, _: usize) void {
        const h: *const HostAllocator = @ptrCast(@alignCast(ctx));
        h.free(h.context, memory.ptr, memory.len, alignment.toByteUnits());
    }
};

pub const Memory = extern struct { used: usize, peak: usize, cap: usize, refused: bool };

pub const LoadGrant = extern struct { name: ?[*]const u8, name_len: usize, grant: *caps.Grant };

pub const LoadOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    source: ?[*]const u8,
    source_len: usize,
    grants: ?[*]const LoadGrant = null,
    grants_len: usize = 0,
    grants_as_used: bool = false,
    owner: ?*objects.Object = null,
    objects: ?[*]const LoadObject = null,
    objects_len: usize = 0,
};

pub const LoadObject = extern struct { name: ?[*]const u8, name_len: usize, object: *objects.Object };

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
    /// What the Group holds, physically counted and capped.
    memory: group_allocator.GroupAllocator,
    /// The Host's allocator, which `memory` wraps, if it gave one.
    host: ?HostAllocator,
    group: machine.Group,
    out: std.Io.Writer.Allocating,
    sink: TraceSink,
    context: ?*anyopaque,
    scripts: std.ArrayList(*Script) = .empty,
    pending: std.ArrayList(*Pending) = .empty,

    fn owns(g: *Group, o: *const objects.Object) bool {
        for (g.group.objects.items) |x| if (x == o) return true;
        return false;
    }

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
    const core = c orelse return;
    const gpa = core.gpa;
    for (core.definitions.items) |d| {
        for (d.operations) |op| releaseOperation(gpa, op);
        gpa.free(d.operations);
        for (d.grants.items) |g| {
            gpa.free(g.operations);
            gpa.destroy(g);
        }
        d.grants.deinit(gpa);
        gpa.free(d.name);
        gpa.destroy(d);
    }
    core.definitions.deinit(gpa);
    for (core.bridges.items) |b| gpa.destroy(b);
    core.bridges.deinit(gpa);
    for (core.standard.items) |x| gpa.destroy(x);
    core.standard.deinit(gpa);
    for (core.kinds.items) |k| {
        for (k.props) |p| {
            gpa.free(p.name);
            p.shape.release();
        }
        gpa.free(k.props);
        for (k.parent_kinds) |x| gpa.free(x);
        gpa.free(k.parent_kinds);
        gpa.free(k.name);
        gpa.destroy(k);
    }
    core.kinds.deinit(gpa);
    for (core.prop_bridges.items) |b| gpa.destroy(b);
    core.prop_bridges.deinit(gpa);
    for (core.libraries.items) |l| l.destroy();
    core.libraries.deinit(gpa);
    allocator.destroy(core);
}

export fn talk_new_group(c: *Core, o: *const GroupOptions, out: *?*Group) HostErrorCode {
    out.* = null;
    const g = c.gpa.create(Group) catch return .out_of_memory;
    g.* = .{ .core = c, .memory = undefined, .host = if (o.allocator) |h| h.* else null, .group = undefined, .out = undefined, .sink = o.trace, .context = o.trace_context };
    g.memory = .init(if (g.host) |*h| h.allocator() else c.gpa, o.memory_cap);
    const gpa = g.memory.allocator();
    g.out = .init(gpa);
    g.group = .init(gpa, if (o.trace != null) &g.out.writer else null);
    out.* = g;
    return .ok;
}

/// C only: what the Group holds now, the most it has held, its cap, and
/// whether it has refused an allocation.
export fn talk_group_memory(g: *const Group, out: *Memory) void {
    out.* = .{ .used = g.memory.used, .peak = g.memory.peak, .cap = g.memory.cap, .refused = g.memory.refused };
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
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    const name = bytes(o.name, o.name_len) catch return .invalid_value;
    const source = bytes(o.source, o.source_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(source)) return .invalid_value;
    for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, name)) return .name_reused;
    const given: []const LoadGrant = if (o.grants_len == 0) &.{} else (o.grants orelse return .invalid_value)[0..o.grants_len];
    const named = g.core.gpa.alloc(machine.NamedGrant, given.len) catch return .out_of_memory;
    defer g.core.gpa.free(named);
    for (given, named) |x, *n| n.* = .{ .name = bytes(x.name, x.name_len) catch return .invalid_value, .grant = x.grant };
    const objects_in: []const LoadObject = if (o.objects_len == 0) &.{} else (o.objects orelse return .invalid_value)[0..o.objects_len];
    const bound = g.core.gpa.alloc(machine.NamedObject, objects_in.len) catch return .out_of_memory;
    defer g.core.gpa.free(bound);
    for (objects_in, bound) |x, *b| {
        if (!g.owns(x.object)) return .wrong_group;
        b.* = .{ .name = bytes(x.name, x.name_len) catch return .invalid_value, .object = x.object };
    }
    if (o.owner) |owner| if (!g.owns(owner)) return .wrong_group;
    const loaded = g.group.load(name, source, .{ .grants = if (given.len > 0) named else null, .grants_as_used = o.grants_as_used, .owner = o.owner, .objects = bound }) catch |err| return status(err);
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
    if (g.memory.refused) return .out_of_memory;
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

pub const Counters = extern struct { fuel_total: i64, alloc_total: i64, runs: i64, faults: i64, persistent_state: i64, mailbox_len: i64 };

export fn talk_script_counters(s: *Script, out: *Counters) void {
    const g = s.group;
    out.* = std.mem.zeroes(Counters);
    const script = g.group.script(s.name) orelse return;
    const read = g.group.counters(script);
    g.flush();
    out.* = .{ .fuel_total = @intCast(read.fuel_total), .alloc_total = @intCast(read.alloc_total), .runs = @intCast(read.runs), .faults = @intCast(read.faults), .persistent_state = @intCast(read.persistent_state), .mailbox_len = @intCast(read.mailbox_len) };
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
    if (g.memory.refused) return .out_of_memory;
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

// ---------------------------------------------------------------- Shapes

pub const Shape = caps.Shape;

fn kindShape(comptime k: caps.Kind) *const Shape {
    const holder = struct {
        // A kind Shape is never released.
        var shape: Shape = .{ .references = std.math.maxInt(usize) / 2, .allocator = allocator, .data = .{ .kind = k } };
    };
    return &holder.shape;
}

export fn talk_any_shape() *const Shape {
    return kindShape(.any);
}
export fn talk_value_shape() *const Shape {
    return kindShape(.value);
}
export fn talk_nothing_shape() *const Shape {
    return kindShape(.nothing);
}
export fn talk_bool_shape() *const Shape {
    return kindShape(.boolean);
}
export fn talk_number_shape() *const Shape {
    return kindShape(.number);
}
export fn talk_text_shape() *const Shape {
    return kindShape(.text);
}
export fn talk_bytes_shape() *const Shape {
    return kindShape(.bytes);
}
export fn talk_instant_shape() *const Shape {
    return kindShape(.instant);
}
export fn talk_range_shape() *const Shape {
    return kindShape(.range);
}
export fn talk_civil_date_shape() *const Shape {
    return kindShape(.civil_date);
}
export fn talk_pattern_shape() *const Shape {
    return kindShape(.pattern);
}
export fn talk_function_shape() *const Shape {
    return kindShape(.function);
}

pub const Field = extern struct { key: ?[*]const u8, key_len: usize, shape: *const Shape, optional: bool };

fn retained(s: *const Shape) *Shape {
    return @constCast(s).retain();
}

fn shapeResult(out: *?*Shape, r: anyerror!*Shape) HostErrorCode {
    out.* = r catch |err| {
        out.* = null;
        return status(err);
    };
    return .ok;
}

export fn talk_quantity_of(unit: ?[*]const u8, len: usize, out: *?*Shape) HostErrorCode {
    return shapeResult(out, Shape.quantityOf(allocator, bytes(unit, len) catch return .invalid_value));
}
export fn talk_quantity_kind(kind: ?[*]const u8, len: usize, out: *?*Shape) HostErrorCode {
    return shapeResult(out, Shape.quantityKind(allocator, bytes(kind, len) catch return .invalid_value));
}
export fn talk_list_of(inner: *const Shape, out: *?*Shape) HostErrorCode {
    const r = retained(inner);
    return shapeResult(out, Shape.listOf(allocator, r) catch |err| {
        r.release();
        return status(err);
    });
}

/// Copies C fields, retaining their Shapes.
fn fieldsOf(given: []const Field) ![]caps.Field {
    const out = try allocator.alloc(caps.Field, given.len);
    var made: usize = 0;
    errdefer {
        for (out[0..made]) |f| {
            allocator.free(f.key);
            f.shape.release();
        }
        allocator.free(out);
    }
    for (given, out) |f, *x| {
        const key = try allocator.dupe(u8, try bytes(f.key, f.key_len));
        x.* = .{ .key = key, .shape = retained(f.shape), .optional = f.optional };
        made += 1;
    }
    return out;
}

fn mapShape(fields: ?[*]const Field, len: usize, open: bool, out: *?*Shape) HostErrorCode {
    out.* = null;
    const given: []const Field = if (len == 0) &.{} else (fields orelse return .invalid_value)[0..len];
    const copied = fieldsOf(given) catch |err| return status(err);
    return shapeResult(out, Shape.map(allocator, copied, open) catch |err| {
        for (copied) |f| {
            allocator.free(f.key);
            f.shape.release();
        }
        allocator.free(copied);
        return status(err);
    });
}

export fn talk_map_shape(fields: ?[*]const Field, len: usize, out: *?*Shape) HostErrorCode {
    return mapShape(fields, len, false, out);
}
export fn talk_open_map(fields: ?[*]const Field, len: usize, out: *?*Shape) HostErrorCode {
    return mapShape(fields, len, true, out);
}
export fn talk_one_of(shapes: ?[*]const *const Shape, len: usize, out: *?*Shape) HostErrorCode {
    out.* = null;
    const given: []const *const Shape = if (len == 0) &.{} else (shapes orelse return .invalid_value)[0..len];
    const copied = allocator.alloc(*Shape, given.len) catch return .out_of_memory;
    for (given, copied) |x, *c| c.* = retained(x);
    return shapeResult(out, Shape.oneOf(allocator, copied) catch |err| {
        for (copied) |c| c.release();
        allocator.free(copied);
        return status(err);
    });
}
export fn talk_optional(inner: *const Shape, out: *?*Shape) HostErrorCode {
    const r = retained(inner);
    return shapeResult(out, Shape.optional(allocator, r) catch |err| {
        r.release();
        return status(err);
    });
}
export fn talk_shape_release(s: ?*const Shape) void {
    if (s) |shape| @constCast(shape).release();
}

// ---------------------------------------------------------------- Capabilities

pub const Mode = enum(c_int) { immediate, suspending, fire_and_forget };

pub const Cost = extern struct { fuel: i64, alloc: i64 };

pub const ErrorDecl = extern struct { code: ?[*]const u8, code_len: usize, fields: ?[*]const Field, fields_len: usize };

pub const Call = caps.Call;

pub const ScriptError = extern struct { code: ?[*]const u8, code_len: usize, message: ?[*]const u8, message_len: usize, data: ?*Value };

pub const CallEnd = enum(c_int) { answered, failed, limited, broken, started };

pub const OperationFn = ?*const fn (context: ?*anyopaque, call: *Call, args: [*]const *Value, args_len: usize, result: *?*Value, err: *ScriptError) callconv(.c) CallEnd;

pub const Operation = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    args: ?[*]const *const Shape,
    args_len: usize,
    result: ?*const Shape,
    cost: Cost,
    mode: Mode,
    max_pending_ms: i64,
    errors: ?[*]const ErrorDecl,
    errors_len: usize,
    @"fn": OperationFn,
    context: ?*anyopaque,
};

/// A C Host function and its context, behind the Core's Host function.
pub const Bridge = struct { call: *const fn (?*anyopaque, *Call, [*]const *Value, usize, *?*Value, *ScriptError) callconv(.c) CallEnd, context: ?*anyopaque };

fn bridged(context: ?*anyopaque, call: *Call, args: []const *Value) caps.Outcome {
    const b: *Bridge = @ptrCast(@alignCast(context.?));
    var value: ?*Value = null;
    var failure: ScriptError = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    switch (b.call(b.context, call, args.ptr, args.len, &value, &failure)) {
        .answered => return if (value) |v| .{ .value = v } else .broken,
        .started => return .started,
        .limited => return .limited,
        .broken => return .broken,
        .failed => {
            const code = bytes(failure.code, failure.code_len) catch return .broken;
            const message = bytes(failure.message, failure.message_len) catch return .broken;
            const owned_code = call.gpa.dupe(u8, code) catch return .broken;
            const owned_message: ?[]const u8 = if (failure.message == null) null else call.gpa.dupe(u8, message) catch {
                call.gpa.free(owned_code);
                return .broken;
            };
            return .{ .failed = .{ .code = owned_code, .message = owned_message, .data = failure.data } };
        },
    }
}

fn releaseOperation(gpa: std.mem.Allocator, op: caps.Operation) void {
    gpa.free(op.name);
    for (op.args) |x| x.release();
    gpa.free(op.args);
    if (op.result) |r| r.release();
    for (op.errors) |e| {
        gpa.free(e.code);
        for (e.fields) |f| {
            gpa.free(f.key);
            f.shape.release();
        }
        gpa.free(e.fields);
    }
    gpa.free(op.errors);
}

fn operationOf(c: *Core, o: Operation) !caps.Operation {
    const gpa = c.gpa;
    const name = try bytes(o.name, o.name_len);
    for ([_][]const u8{ "ask", "tell", "send", "wait", "end" }) |refused| if (std.mem.eql(u8, name, refused)) return error.InvalidValue;
    if (name.len == 0) return error.InvalidValue;
    const call = o.@"fn" orelse return error.InvalidValue;
    if (o.cost.fuel < 0 or o.cost.alloc < 0) return error.InvalidValue;
    const args_in: []const *const Shape = if (o.args_len == 0) &.{} else (o.args orelse return error.InvalidValue)[0..o.args_len];
    const errors_in: []const ErrorDecl = if (o.errors_len == 0) &.{} else (o.errors orelse return error.InvalidValue)[0..o.errors_len];
    const bridge = try gpa.create(Bridge);
    bridge.* = .{ .call = call, .context = o.context };
    c.bridges.append(gpa, bridge) catch |err| {
        gpa.destroy(bridge);
        return err;
    };
    const args = try gpa.alloc(*Shape, args_in.len);
    for (args_in, args) |x, *y| y.* = retained(x);
    const decls = try gpa.alloc(caps.ErrorDecl, errors_in.len);
    for (errors_in, decls) |e, *d| {
        const fields: []const Field = if (e.fields_len == 0) &.{} else (e.fields orelse return error.InvalidValue)[0..e.fields_len];
        d.* = .{ .code = try gpa.dupe(u8, try bytes(e.code, e.code_len)), .fields = try fieldsOf(fields) };
    }
    return .{
        .name = try gpa.dupe(u8, name),
        .args = args,
        .result = if (o.result) |r| retained(r) else null,
        .cost = .{ .fuel = @intCast(o.cost.fuel), .alloc = @intCast(o.cost.alloc) },
        .mode = switch (o.mode) {
            .immediate => .immediate,
            .suspending => .suspending,
            .fire_and_forget => .fire_and_forget,
        },
        .max_pending_ms = @intCast(@max(o.max_pending_ms, 0)),
        .errors = decls,
        .host = .{ .call = bridged, .context = bridge },
    };
}

export fn talk_define_capability(c: *Core, name: ?[*]const u8, len: usize, ops: ?[*]const Operation, ops_len: usize, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const gpa = c.gpa;
    const n = bytes(name, len) catch return .invalid_value;
    if (n.len == 0) return .invalid_value;
    for (c.definitions.items) |d| if (std.mem.eql(u8, d.name, n)) return .name_reused;
    const given: []const Operation = if (ops_len == 0) &.{} else (ops orelse return .invalid_value)[0..ops_len];
    const operations = gpa.alloc(caps.Operation, given.len) catch return .out_of_memory;
    var made: usize = 0;
    for (given, operations) |o, *x| {
        x.* = operationOf(c, o) catch |err| {
            for (operations[0..made]) |done| releaseOperation(gpa, done);
            gpa.free(operations);
            return status(err);
        };
        made += 1;
    }
    std.mem.sort(caps.Operation, operations, {}, struct {
        fn less(_: void, x: caps.Operation, y: caps.Operation) bool {
            return std.mem.order(u8, x.name, y.name) == .lt;
        }
    }.less);
    for (operations[1..@max(operations.len, 1)], 0..) |op, i| if (std.mem.eql(u8, op.name, operations[i].name)) {
        for (operations) |done| releaseOperation(gpa, done);
        gpa.free(operations);
        return .invalid_value;
    };
    const d = gpa.create(caps.Capability) catch return .out_of_memory;
    d.* = .{ .name = gpa.dupe(u8, n) catch return .out_of_memory, .operations = operations };
    c.definitions.append(gpa, d) catch return .out_of_memory;
    out.* = d;
    return .ok;
}

export fn talk_capability_def_name(d: *const caps.Capability, s: *[*]const u8, len: *usize) void {
    s.* = d.name.ptr;
    len.* = d.name.len;
}

/// A Grant, which its definition owns.
fn grantOf(d: *caps.Capability, kept: []bool, binding: ?*anyopaque, out: *?*caps.Grant) HostErrorCode {
    const g = allocator.create(caps.Grant) catch {
        allocator.free(kept);
        return .out_of_memory;
    };
    g.* = .{ .capability = d, .operations = kept, .binding = binding };
    d.grants.append(allocator, g) catch {
        allocator.free(kept);
        allocator.destroy(g);
        return .out_of_memory;
    };
    out.* = g;
    return .ok;
}

export fn talk_capability_def_grant(d: *caps.Capability, ops: ?[*]const ?[*]const u8, lens: ?[*]const usize, len: usize, binding: ?*anyopaque, out: *?*caps.Grant) HostErrorCode {
    out.* = null;
    const kept = allocator.alloc(bool, d.operations.len) catch return .out_of_memory;
    @memset(kept, false);
    for (0..len) |i| {
        const name = bytes((ops orelse return .invalid_value)[i], (lens orelse return .invalid_value)[i]) catch return .invalid_value;
        const index = d.find(name) orelse {
            allocator.free(kept);
            return .invalid_value;
        };
        kept[index] = true;
    }
    return grantOf(d, kept, binding, out);
}

export fn talk_capability_def_grant_all(d: *caps.Capability, binding: ?*anyopaque, out: *?*caps.Grant) HostErrorCode {
    out.* = null;
    const kept = allocator.alloc(bool, d.operations.len) catch return .out_of_memory;
    @memset(kept, true);
    return grantOf(d, kept, binding, out);
}

export fn talk_grant_capability(g: *const caps.Grant) *caps.Capability {
    return g.capability;
}

export fn talk_grant_binding(g: *const caps.Grant) ?*anyopaque {
    return g.binding;
}

export fn talk_call_id(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.id.ptr;
    len.* = c.id.len;
}
export fn talk_call_script_name(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.script.ptr;
    len.* = c.script.len;
}
export fn talk_call_grant_name(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.grant.ptr;
    len.* = c.grant.len;
}
export fn talk_call_binding(c: *const Call) ?*anyopaque {
    return c.binding;
}
export fn talk_call_now(c: *const Call, seconds: *i64, nanos: *i32) void {
    seconds.* = c.now.seconds;
    nanos.* = c.now.nanos;
}
export fn talk_call_charge(c: *Call, fuel: i64) HostErrorCode {
    if (fuel < 0) return .invalid_value;
    return if (c.charge(@intCast(fuel))) .ok else .err_limit;
}

// ---------------------------------------------------------------- Standard Capabilities

pub const NamedCost = extern struct { name: ?[*]const u8, name_len: usize, cost: Cost };
pub const Costs = extern struct { entries: ?[*]const NamedCost, len: usize };
pub const CalendarImpl = extern struct { context: ?*anyopaque, today: OperationFn, now: OperationFn, to_civil: OperationFn, to_instant: OperationFn, offset: OperationFn, zone: OperationFn };
pub const LocaleImpl = extern struct { context: ?*anyopaque, compare: OperationFn, rank: OperationFn, upper: OperationFn, lower: OperationFn, number_symbols: OperationFn, month_names: OperationFn, day_names: OperationFn, tag: OperationFn };
pub const ConsoleImpl = extern struct { context: ?*anyopaque, write: OperationFn, read: OperationFn };

/// The largest cost component: 2^53 - 1.
const max_cost = 9_007_199_254_740_991;

/// Defines a Standard Capability from a cost per Operation and one C Host
/// function per Operation, in `standard.operations` order.
fn defineStandard(c: *Core, which: standard.Which, fns: []const OperationFn, context: ?*anyopaque, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const gpa = c.gpa;
    const names = standard.operations(which);
    for (c.definitions.items) |d| if (std.mem.eql(u8, d.name, @tagName(which))) return .name_reused;
    const given: []const NamedCost = if (costs) |cs| (if (cs.len == 0) &.{} else (cs.entries orelse return .invalid_value)[0..cs.len]) else &.{};
    var per: [8]caps.Cost = undefined;
    for (names, 0..) |name, i| {
        const entry = for (given) |e| {
            if (std.mem.eql(u8, bytes(e.name, e.name_len) catch return .invalid_value, name)) break e;
        } else return .invalid_value;
        if (entry.cost.fuel < 0 or entry.cost.alloc < 0 or entry.cost.fuel > max_cost or entry.cost.alloc > max_cost) return .invalid_value;
        per[i] = .{ .fuel = @intCast(entry.cost.fuel), .alloc = @intCast(entry.cost.alloc) };
    }
    var impl: [8]?caps.HostFn = @splat(null);
    for (fns, 0..) |f, i| {
        const call = f orelse return .invalid_value;
        const bridge = gpa.create(Bridge) catch return .out_of_memory;
        bridge.* = .{ .call = call, .context = context };
        c.bridges.append(gpa, bridge) catch {
            gpa.destroy(bridge);
            return .out_of_memory;
        };
        impl[i] = .{ .call = bridged, .context = bridge };
    }
    const d = standard.define(gpa, which, impl[0..names.len], per[0..names.len], &c.standard) catch return .out_of_memory;
    c.definitions.append(gpa, d) catch return .out_of_memory;
    out.* = d;
    return .ok;
}

export fn talk_clock_capability(c: *Core, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandard(c, .clock, &.{}, null, costs, out);
}

export fn talk_calendar_capability(c: *Core, impl: *const CalendarImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    // In name order: now, offset, toCivil, toInstant, today, zone.
    return defineStandard(c, .calendar, &.{ impl.now, impl.offset, impl.to_civil, impl.to_instant, impl.today, impl.zone }, impl.context, costs, out);
}

export fn talk_locale_capability(c: *Core, impl: *const LocaleImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    // In name order: compare, dayNames, lower, monthNames, numberSymbols,
    // rank, tag, upper.
    return defineStandard(c, .locale, &.{ impl.compare, impl.day_names, impl.lower, impl.month_names, impl.number_symbols, impl.rank, impl.tag, impl.upper }, impl.context, costs, out);
}

export fn talk_console_capability(c: *Core, impl: *const ConsoleImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandard(c, .console, &.{ impl.read, impl.write }, impl.context, costs, out);
}

// ---------------------------------------------------------------- answers

fn settle(c: *Call, with: machine.Resume) HostErrorCode {
    const g: *machine.Group = @ptrCast(@alignCast(c.group orelse return .unknown_call));
    g.settle(c.id, with) catch return .out_of_memory;
    return .ok;
}

export fn talk_call_answer(c: *Call, v: *Value) HostErrorCode {
    return settle(c, .{ .answer = .{ .value = v.retain(), .fuel = 0 } });
}

export fn talk_call_answer_with_cost(c: *Call, v: *Value, fuel: i64) HostErrorCode {
    if (fuel < 0) return .invalid_value;
    return settle(c, .{ .answer = .{ .value = v.retain(), .fuel = @intCast(fuel) } });
}

export fn talk_call_fail(c: *Call, e: ?*const ScriptError) HostErrorCode {
    const failure = e orelse return settle(c, .broken);
    // The Group frees them, so its allocator makes them.
    const code = c.gpa.dupe(u8, bytes(failure.code, failure.code_len) catch return .invalid_value) catch return .out_of_memory;
    const message: ?[]const u8 = if (failure.message == null) null else c.gpa.dupe(u8, bytes(failure.message, failure.message_len) catch return .invalid_value) catch {
        c.gpa.free(code);
        return .out_of_memory;
    };
    return settle(c, .{ .failed = .{ .code = code, .message = message, .data = if (failure.data) |d| d.retain() else null } });
}

// ---------------------------------------------------------------- Host Objects

pub const PropGetFn = ?*const fn (context: ?*anyopaque, o: *objects.Object, result: *?*Value, err: *ScriptError) callconv(.c) CallEnd;
pub const PropSetFn = ?*const fn (context: ?*anyopaque, o: *objects.Object, v: *const Value, err: *ScriptError) callconv(.c) CallEnd;

pub const Prop = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    shape: ?*const Shape,
    get: PropGetFn,
    set: PropSetFn,
    context: ?*anyopaque,
    get_cost: Cost,
    set_cost: Cost,
};

pub const ObjectKindDef = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    props: ?[*]const Prop,
    props_len: usize,
    parent_kinds: ?[*]const ?[*]const u8,
    parent_kinds_lens: ?[*]const usize,
    parent_kinds_len: usize,
};

/// A C property's Get and Set and their context, behind the Core's.
pub const PropBridge = struct { get: *const fn (?*anyopaque, *objects.Object, *?*Value, *ScriptError) callconv(.c) CallEnd, set: PropSetFn, context: ?*anyopaque };

fn propResult(gpa: std.mem.Allocator, end: CallEnd, value: ?*Value, failure: ScriptError) objects.Result {
    switch (end) {
        .answered => return if (value) |v| .{ .value = v } else .done,
        .failed => {
            const code = bytes(failure.code, failure.code_len) catch return .broken;
            const message = bytes(failure.message, failure.message_len) catch return .broken;
            const owned_code = gpa.dupe(u8, code) catch return .broken;
            const owned_message: ?[]const u8 = if (failure.message == null) null else gpa.dupe(u8, message) catch {
                gpa.free(owned_code);
                return .broken;
            };
            return .{ .failed = .{ .code = owned_code, .message = owned_message, .data = failure.data } };
        },
        else => {
            if (value) |v| v.release();
            return .broken;
        },
    }
}

fn propGet(context: ?*anyopaque, gpa: std.mem.Allocator, o: *objects.Object) objects.Result {
    const b: *PropBridge = @ptrCast(@alignCast(context.?));
    var value: ?*Value = null;
    var failure: ScriptError = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    const end = b.get(b.context, o, &value, &failure);
    const r = propResult(gpa, end, value, failure);
    return if (r == .done) .broken else r;
}

fn propSet(context: ?*anyopaque, gpa: std.mem.Allocator, o: *objects.Object, v: *const Value) objects.Result {
    const b: *PropBridge = @ptrCast(@alignCast(context.?));
    var failure: ScriptError = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    const end = b.set.?(b.context, o, v, &failure);
    return switch (propResult(gpa, end, null, failure)) {
        .value => |x| blk: {
            x.release();
            break :blk .done;
        },
        else => |r| r,
    };
}

/// Defines an Object Kind, once per process: its properties, each with a
/// Shape, a Get and an optional Set.
export fn talk_define_object_kind(c: *Core, def: *const ObjectKindDef, out: *?*objects.Kind) HostErrorCode {
    out.* = null;
    const gpa = c.gpa;
    const name = bytes(def.name, def.name_len) catch return .invalid_value;
    if (name.len == 0) return .invalid_value;
    for (c.kinds.items) |k| if (std.mem.eql(u8, k.name, name)) return .name_reused;
    const given: []const Prop = if (def.props_len == 0) &.{} else (def.props orelse return .invalid_value)[0..def.props_len];
    for (given) |p| {
        _ = bytes(p.name, p.name_len) catch return .invalid_value;
        if (p.shape == null or p.get == null or p.get_cost.fuel < 0 or p.get_cost.alloc < 0 or p.set_cost.fuel < 0 or p.set_cost.alloc < 0) return .invalid_value;
    }
    const parents_in: []const ?[*]const u8 = if (def.parent_kinds_len == 0) &.{} else (def.parent_kinds orelse return .invalid_value)[0..def.parent_kinds_len];
    const lens: []const usize = if (def.parent_kinds_len == 0) &.{} else (def.parent_kinds_lens orelse return .invalid_value)[0..def.parent_kinds_len];
    const k = gpa.create(objects.Kind) catch return .out_of_memory;
    k.* = .{ .name = gpa.dupe(u8, name) catch return .out_of_memory, .props = gpa.alloc(objects.Prop, given.len) catch return .out_of_memory };
    const parents = gpa.alloc([]const u8, parents_in.len) catch return .out_of_memory;
    for (parents_in, lens, parents) |x, len, *y| y.* = gpa.dupe(u8, bytes(x, len) catch "") catch return .out_of_memory;
    k.parent_kinds = parents;
    for (given, k.props) |p, *x| {
        const b = gpa.create(PropBridge) catch return .out_of_memory;
        b.* = .{ .get = p.get.?, .set = p.set, .context = p.context };
        c.prop_bridges.append(gpa, b) catch return .out_of_memory;
        x.* = .{
            .name = gpa.dupe(u8, bytes(p.name, p.name_len) catch unreachable) catch return .out_of_memory,
            .shape = retained(p.shape.?),
            .get = .{ .call = propGet, .context = b },
            .set = if (p.set != null) .{ .call = propSet, .context = b } else null,
            .get_cost = .{ .fuel = @intCast(p.get_cost.fuel), .alloc = @intCast(p.get_cost.alloc) },
            .set_cost = .{ .fuel = @intCast(p.set_cost.fuel), .alloc = @intCast(p.set_cost.alloc) },
        };
    }
    c.kinds.append(gpa, k) catch return .out_of_memory;
    out.* = k;
    return .ok;
}

/// Makes the Group's handle for a Host-owned thing; a duplicate id within
/// its kind is TALK_DUPLICATE_OBJECT_ID.
export fn talk_group_object(g: *Group, kind: *const objects.Kind, id: ?[*]const u8, id_len: usize, native: ?*anyopaque, out: *?*objects.Object) HostErrorCode {
    out.* = null;
    if (g.memory.refused) return .out_of_memory;
    const text = bytes(id, id_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(text)) return .invalid_value;
    out.* = g.group.object(kind, text, native) catch |err| return status(err);
    return .ok;
}

/// The handle with this Object Kind name and id, disposed or not.
export fn talk_object_by_id(g: *Group, kind: ?[*]const u8, kind_len: usize, id: ?[*]const u8, id_len: usize, out: *?*objects.Object) bool {
    out.* = g.group.objectById(bytes(kind, kind_len) catch return false, bytes(id, id_len) catch return false);
    return out.* != null;
}

export fn talk_object_id(o: *const objects.Object, s: *[*]const u8, len: *usize) void {
    s.* = o.id.ptr;
    len.* = o.id.len;
}

export fn talk_object_native(o: *const objects.Object) ?*anyopaque {
    return o.native;
}

/// The object as a Script value, an owned reference.
export fn talk_object_value(o: *const objects.Object, out: *?*Value) HostErrorCode {
    out.* = o.value.retain();
    return .ok;
}

/// The handle a value of kind object is, within the Group that made it.
export fn talk_value_as_object(g: *Group, v: *const Value, out: *?*objects.Object) bool {
    out.* = g.group.objectOf(v);
    return out.* != null;
}

/// Queues SetParent; a cycle is TALK_PARENT_CYCLE and a disposed child
/// TALK_INVALID_VALUE at the call. A NULL parent ends the chain.
export fn talk_set_parent(g: *Group, o: *objects.Object, parent: ?*objects.Object) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    if (!g.owns(o)) return .wrong_group;
    if (parent) |p| if (!g.owns(p)) return .wrong_group;
    defer g.flush();
    g.group.setParent(o, parent) catch |err| return status(err);
    return .ok;
}

export fn talk_dispose(g: *Group, o: *objects.Object) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    if (!g.owns(o)) return .wrong_group;
    g.group.dispose(o) catch |err| return status(err);
    return .ok;
}

fn queueTo(g: *Group, to: *objects.Object, m: *const Message, request: bool, id: ?*Buffer, n_out: *u64) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    if (!g.owns(to)) return .wrong_group;
    const name = bytes(m.name, m.name_len) catch return .invalid_value;
    const args: []const *Value = if (m.args_len == 0) &.{} else (m.args orelse return .invalid_value)[0..m.args_len];
    const owned = g.core.gpa.alloc(*Value, args.len) catch return .out_of_memory;
    for (owned, args) |*x, v| x.* = v.retain();
    defer g.core.gpa.free(owned);
    const n = g.group.deliverTo(to, name, owned, request) catch {
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

/// Queues a Delivery to a Host Object, routed to its nearest Owning Script
/// when the queue is drained.
export fn talk_deliver(g: *Group, to: *objects.Object, m: *const Message, id: ?*Buffer) HostErrorCode {
    var n: u64 = 0;
    return queueTo(g, to, m, false, id, &n);
}

export fn talk_request(g: *Group, to: *objects.Object, m: *const Message, id: ?*Buffer, out: *?*Pending) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queueTo(g, to, m, true, id, &n);
    if (code != .ok) return code;
    const p = g.core.gpa.create(Pending) catch return .out_of_memory;
    p.* = .{ .group = g, .id = n };
    g.pending.append(g.core.gpa, p) catch return .out_of_memory;
    out.* = p;
    return .ok;
}

// ---------------------------------------------------------------- Libraries

pub const LibrarySource = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    version: ?[*]const u8,
    version_len: usize,
    source: ?[*]const u8,
    source_len: usize,
};

/// Compiles a Library once per process. imports must hold every Library
/// its `use` lines name, besides the stdlib's; anything that fails to parse
/// or check is TALK_LOAD_REFUSED. The Library lives as long as the Core.
export fn talk_compile_library(c: *Core, src: *const LibrarySource, imports: ?[*]const *machine.Library, imports_len: usize, declarations: ?[*]const LoadGrant, declarations_len: usize, out: *?*machine.Library) HostErrorCode {
    out.* = null;
    const name = bytes(src.name, src.name_len) catch return .invalid_value;
    const label = bytes(src.version, src.version_len) catch return .invalid_value;
    const source = bytes(src.source, src.source_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(source) or name.len == 0) return .invalid_value;
    const given: []const *machine.Library = if (imports_len == 0) &.{} else (imports orelse return .invalid_value)[0..imports_len];
    const declared: []const LoadGrant = if (declarations_len == 0) &.{} else (declarations orelse return .invalid_value)[0..declarations_len];
    const named = c.gpa.alloc(machine.NamedGrant, declared.len) catch return .out_of_memory;
    defer c.gpa.free(named);
    for (declared, named) |x, *n| n.* = .{ .name = bytes(x.name, x.name_len) catch return .invalid_value, .grant = x.grant };
    const compiled = machine.compileLibrary(c.gpa, name, label, source, given, if (declarations == null) null else named) catch |err| return status(err);
    switch (compiled) {
        .refused => |diags| {
            c.gpa.free(diags);
            return .load_refused;
        },
        .library => |l| {
            c.libraries.append(c.gpa, l) catch {
                l.destroy();
                return .out_of_memory;
            };
            out.* = l;
            return .ok;
        },
    }
}

export fn talk_library_name(l: *const machine.Library, s: *[*]const u8, len: *usize) void {
    s.* = l.name.ptr;
    len.* = l.name.len;
}

export fn talk_library_version(l: *const machine.Library, s: *[*]const u8, len: *usize) void {
    s.* = l.version.ptr;
    len.* = l.version.len;
}

/// The Library's code identity, 32 bytes.
export fn talk_library_identity(l: *const machine.Library, out: *[32]u8) void {
    out.* = l.identity;
}

/// Adds a compiled Library to the Group, a Host Input with its `add-library`
/// record. A stdlib name is TALK_RESERVED_NAME, a name the Group holds
/// TALK_NAME_REUSED, and an import it doesn't hold TALK_LIBRARY_MISMATCH.
export fn talk_add_library(g: *Group, l: *machine.Library) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    g.group.addLibrary(l) catch |err| return status(err);
    return .ok;
}

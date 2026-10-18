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
const snapshot = @import("machine/snapshot.zig");
const caps = machine.capabilities;
const standard = @import("machine/standard.zig");
const sqlite = @import("machine/sqlite.zig");
const objects = machine.objects;
const group_allocator = @import("machine/group_allocator.zig");
const limits_table = @import("generated/limits.zig").limits;
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
pub fn status(err: anyerror) HostErrorCode {
    return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.DuplicateObjectId => .duplicate_object_id,
        error.ParentCycle => .parent_cycle,
        error.NameReused => .name_reused,
        error.ReservedName => .reserved_name,
        error.LibraryMismatch => .library_mismatch,
        error.ReentrantCall => .reentrant_call,
        error.ClockBackwards => .clock_backwards,
        error.EffectStateUnknown => .effect_state_unknown,
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
export fn talk_instant(seconds: i64, micros: i32, out: *?*Value) HostErrorCode {
    out.* = null;
    const t = model.dates.Instant{ .seconds = seconds, .micros = micros };
    model.dates.validateInstant(t) catch return .invalid_value;
    return result(out, model.scalar(allocator, .{ .instant = t }));
}
/// `struct timespec`, whose `time_t` is 64 bits on every target the Core
/// builds for.
pub const Timespec = extern struct { sec: i64, nsec: c_long };
export fn talk_instant_from_time(t: *const Timespec, out: *?*Value) HostErrorCode {
    out.* = null;
    if (t.nsec < 0 or t.nsec >= std.time.ns_per_s) return .invalid_value;
    // Truncated toward the past, so a reading is never later than its time.
    return talk_instant(t.sec, @intCast(@divTrunc(t.nsec, std.time.ns_per_us)), out);
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
export fn talk_kv(key: ?[*]const u8, len: usize, value: *Value) Pair {
    return .{ .key = key, .key_len = len, .value = value };
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
export fn talk_value_as_instant(v: *const Value, seconds: *i64, micros: *i32) bool {
    if (v.data != .instant) return false;
    seconds.* = v.data.instant.seconds;
    micros.* = v.data.instant.micros;
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
    const p = v.data.map.at(index);
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
export fn talk_decode_json(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    return result(out, encoding.decodeJson(allocator, bytes(s, len) catch return .invalid_value));
}
export fn talk_encode_json(v: *const Value, out: *Buffer) HostErrorCode {
    return buffer(out, encoding.encodeJson(allocator, v));
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

pub export fn talk_owned_bytes_release(b: *Buffer) void {
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
    invalid_checkpoint,
    err_limit,
    err_mailbox_full,
    load_refused,
    out_of_memory,
    script_failed,
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
    elements_bridges: std.ArrayList(*ElementsBridge) = .empty,
    mappings: std.ArrayList(*Mapping) = .empty,
    lifecycles: std.ArrayList(*SegmentLifecycle) = .empty,
    /// The Host release hooks Capabilities call, with their contexts.
    releases: std.ArrayList(*Releasing) = .empty,
    sqlite_impls: std.ArrayList(*SqliteImpl) = .empty,
    sql_bridges: std.ArrayList(*SqlBridge) = .empty,
};

pub const TraceSink = ?*const fn (context: ?*anyopaque, line: [*]const u8, len: usize) callconv(.c) void;

pub const GroupOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    trace: TraceSink,
    trace_context: ?*anyopaque,
    allocator: ?*const HostAllocator = null,
    memory_cap: usize = 0,
    /// Seeds the generator `random` draws from (chapter 7, Random numbers).
    seed: u64 = 0,
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
    /// Null for the default limit profile.
    limits: ?*const Limits = null,
};

/// A Script's limits, MaxWait in whole milliseconds. A zero field takes its
/// default, and a negative one is `invalid value`.
pub const Limits = extern struct {
    fuel_per_run: i64 = 0,
    alloc_per_run: i64 = 0,
    persistent_state: i64 = 0,
    call_depth: i64 = 0,
    pattern_size: i64 = 0,
    mailbox_depth: i64 = 0,
    max_wait_ms: i64 = 0,
    max_join: i64 = 0,
    cleanup_budget: i64 = 0,
};

/// Which of a LimitOverride's fields are supplied, zero ones included.
pub const LimitOverrideFields = enum(u8) { fuel_per_run = 1, alloc_per_run = 2, max_wait = 4, max_join = 8 };

/// Tightens a Script's per-Run limits for one Delivery. A nonzero field is
/// always supplied, and a zero one only when `set` marks it.
pub const LimitOverride = extern struct {
    set: u8 = 0,
    fuel_per_run: i64 = 0,
    alloc_per_run: i64 = 0,
    max_wait_ms: i64 = 0,
    max_join: i64 = 0,
};

export fn talk_default_limits(out: *Limits) void {
    const d: machine.Limits = .{};
    out.* = .{ .fuel_per_run = @intCast(d.fuel_per_run), .alloc_per_run = @intCast(d.alloc_per_run), .persistent_state = @intCast(d.persistent_state), .call_depth = @intCast(d.call_depth), .pattern_size = @intCast(d.pattern_size), .mailbox_depth = @intCast(d.mailbox_depth), .max_wait_ms = @intCast(d.max_wait_ms), .max_join = @intCast(d.max_join), .cleanup_budget = @intCast(d.cleanup_budget) };
}

/// A Script's limits from the Host's: zero fields take the defaults. This
/// Core supports exactly the conformance profile, on native and WASI targets.
fn limitsOf(given: ?*const Limits) error{InvalidValue}!machine.Limits {
    var out: machine.Limits = .{};
    const l = given orelse return out;
    inline for (@typeInfo(Limits).@"struct".field_names, 0..) |name, i| {
        const v = @field(l, name);
        if (v < 0 or v > limits_table.limit[i].minimum) return error.InvalidValue;
        if (v > 0) @field(out, name) = @intCast(v);
    }
    return out;
}

/// A Delivery's override from the Host's, or null for none.
fn overrideOf(given: ?*const LimitOverride) error{InvalidValue}!?machine.Override {
    const o = given orelse return null;
    if (o.set & ~@as(u8, 15) != 0) return error.InvalidValue;
    var out: machine.Override = .{};
    var any = false;
    inline for (machine.override_fields) |f| {
        const v = @field(o, f.field);
        if (v < 0) return error.InvalidValue;
        if (v != 0 or o.set & f.bit != 0) {
            @field(out, f.field) = @intCast(v);
            any = true;
        }
    }
    return if (any) out else null;
}

fn refusedOverrideOf(given: ?*const LimitOverride) ?machine.RefusedOverride {
    const o = given orelse return null;
    var out: machine.RefusedOverride = .{};
    inline for (machine.override_fields) |f| {
        const v = @field(o, f.field);
        if (v != 0 or o.set & f.bit != 0) @field(out, f.field) = v;
    }
    return out;
}

pub const LoadObject = extern struct { name: ?[*]const u8, name_len: usize, object: *objects.Object };

pub const Message = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    args: ?[*]const *Value,
    args_len: usize,
    /// Null for no override.
    limits: ?*const LimitOverride = null,
};

pub const GroupState = enum(c_int) { idle, sliced, stopped, rewound };

pub const PumpOptions = extern struct { fuel_slice: i64, fuel_cap: i64 };

pub const PumpResult = extern struct {
    state: GroupState,
    has_next_deadline: bool = false,
    next_deadline_seconds: i64 = 0,
    next_deadline_micros: i32 = 0,
    fuel_used: i64,
    reports: ?*Reports = null,
};

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
    deciding: std.ArrayList(*Deciding) = .empty,
    /// The name it was made with.
    name: []const u8 = "",
    /// The last ScriptNames, which the Host borrows.
    names: std.ArrayList(Id) = .empty,
    /// The last Script.Grants, which the Host borrows, and the Operation
    /// names they point into.
    grants: std.ArrayList(ScriptGrant) = .empty,
    grant_operations: std.ArrayList(Id) = .empty,

    fn owns(g: *Group, o: *const objects.Object) bool {
        for (g.group.objects.items) |x| if (x == o) return true;
        return false;
    }

    /// Sends each complete Trace line to the sink.
    pub fn flush(g: *Group) void {
        g.group.flushChargeRefusals();
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

pub const Verdict = enum(c_int) { allowed, vetoed, undecided };
pub const Outcome = enum(c_int) { completed, errored, limit_fault, cancelled, unhandled_outcome, dropped, effect_failure_outcome };
pub const Veto = extern struct { script: [*]const u8, script_len: usize, run: [*]const u8, run_len: usize, reason: *Value };
pub const UndecidedBy = extern struct { script: [*]const u8, script_len: usize, run: [*]const u8, run_len: usize, outcome: Outcome };
pub const Decided = extern struct {
    delivery: [*]const u8,
    delivery_len: usize,
    broadcast: [*]const u8,
    broadcast_len: usize,
    verdict: Verdict,
    vetoes: [*]const Veto,
    vetoes_len: usize,
    undecided: [*]const UndecidedBy,
    undecided_len: usize,
};

// ---------------------------------------------------------------- reports

pub const Location = extern struct { unit: [*]const u8 = "", unit_len: usize = 0, line: i64 = 0, col: i64 = 0, handler: [*]const u8 = "", handler_len: usize = 0, pc: i64 = 0 };
pub const CleanupFailure = extern struct { code: [*]const u8, code_len: usize, limit: [*]const u8, limit_len: usize };
pub const EffectFailure = extern struct {
    script: [*]const u8,
    script_len: usize,
    run: [*]const u8,
    run_len: usize,
    grant: [*]const u8,
    grant_len: usize,
    segment: [*]const u8,
    segment_len: usize,
    phase: [*]const u8,
    phase_len: usize,
    status: EffectStatus,
    scope: [*]const u8,
    scope_len: usize,
    detail: [*]const u8 = "",
    detail_len: usize = 0,
};
pub const RunEnd = extern struct {
    script: [*]const u8,
    script_len: usize,
    run: [*]const u8,
    run_len: usize,
    delivery: [*]const u8,
    delivery_len: usize,
    broadcast: [*]const u8,
    broadcast_len: usize,
    handler: [*]const u8,
    handler_len: usize,
    fallback: bool,
    outcome: Outcome,
    effect: ?*const EffectFailure,
    cleanup_failed: ?*const CleanupFailure,
    result: ?*Value,
    @"error": ?*const ScriptError,
    limit: [*]const u8,
    limit_len: usize,
    at: Location,
    fuel: i64,
    alloc: i64,
};
pub const Stop = extern struct {
    script: [*]const u8,
    script_len: usize,
    reason: [*]const u8,
    reason_len: usize,
    discarded_runs: [*]const Id,
    discarded_runs_len: usize,
    dropped_messages: [*]const Id,
    dropped_messages_len: usize,
    pending_calls: [*]const Id,
    pending_calls_len: usize,
};
pub const Unhandled = extern struct {
    delivery: [*]const u8,
    delivery_len: usize,
    message: [*]const u8,
    message_len: usize,
    args: [*]const *Value,
    args_len: usize,
    target: ?*objects.Object,
};
pub const OperationRef = machine.OperationRef;
pub const CallFailed = extern struct { script: [*]const u8, script_len: usize, call: [*]const u8, call_len: usize, operation: OperationRef, detail: [*]const u8, detail_len: usize };
pub const HostError = extern struct { code: HostErrorCode, detail: [*]const u8, detail_len: usize };

/// A Host error's chapter 9 code, for a talk.h status.
pub fn hostCodeName(code: HostErrorCode) []const u8 {
    return switch (code) {
        .ok => "",
        .clock_backwards => "clock backwards",
        .parent_cycle => "parent cycle",
        .duplicate_object_id => "duplicate object id",
        .name_reused => "name reused",
        .reentrant_call => "reentrant call",
        .wrong_group => "wrong group",
        .library_mismatch => "library mismatch",
        .reserved_name => "reserved name",
        .not_adoptable => "not adoptable",
        .invalid_value => "invalid value",
        .invalid_save => "invalid save",
        .save_mismatch => "save mismatch",
        .unknown_call => "unknown call",
        .state_too_large => "state too large",
        .effects_pending => "effects pending",
        .effect_state_unknown => "effect state unknown",
        .invalid_checkpoint => "invalid checkpoint",
        .err_limit => "limit",
        .err_mailbox_full => "mailbox full",
        .load_refused => "load error",
        .out_of_memory => "out of memory",
        .script_failed => "script error",
    };
}

/// An error's text: `head`, then `: ` and `tail` when there is one.
fn errorText(out: *Buffer, head: []const u8, tail: []const u8) HostErrorCode {
    const text = if (tail.len == 0) allocator.dupe(u8, head) else std.mem.concat(allocator, u8, &.{ head, ": ", tail });
    return buffer(out, text);
}

export fn talk_host_error_error(e: *const HostError, out: *Buffer) HostErrorCode {
    return errorText(out, hostCodeName(e.code), e.detail[0..e.detail_len]);
}
pub const RunAncestry = extern struct { root_delivery: [*]const u8, root_delivery_len: usize, parent_run: [*]const u8, parent_run_len: usize, parent_call: [*]const u8, parent_call_len: usize };
pub const RunStarted = extern struct {
    ancestry: RunAncestry,
    script: [*]const u8,
    script_len: usize,
    run: [*]const u8,
    run_len: usize,
    delivery: [*]const u8,
    delivery_len: usize,
    selector: [*]const u8,
    selector_len: usize,
    function: ?*Value,
    args: [*]const *Value,
    args_len: usize,
};
pub const RunDiscarded = extern struct { ancestry: RunAncestry, script: [*]const u8, script_len: usize, run: [*]const u8, run_len: usize, reason: [*]const u8, reason_len: usize };
pub const RunAccounting = extern struct { ancestry: RunAncestry, script: [*]const u8, script_len: usize, run: [*]const u8, run_len: usize, fuel: i64, state: [*]const u8, state_len: usize };
pub const CausalWork = extern struct { root_delivery: [*]const u8, root_delivery_len: usize, live_runs: i64, queued_messages: i64, discarded_messages: i64 };
pub const ChargeResult = extern struct { request: [*]const u8, request_len: usize, call: [*]const u8, call_len: usize, fuel: i64, status: [*]const u8, status_len: usize };
pub const ReportKind = enum(c_int) { run_end, stop, unhandled, call_failed, effect_failure, decided, host_error, run_started, run_discarded, run_accounting, causal_work, charge_result };
pub const Report = extern struct {
    kind: ReportKind,
    as: extern union {
        run_end: RunEnd,
        stop: Stop,
        unhandled: Unhandled,
        call_failed: CallFailed,
        effect_failure: EffectFailure,
        decided: Decided,
        host_error: HostError,
        run_started: RunStarted,
        run_discarded: RunDiscarded,
        run_accounting: RunAccounting,
        causal_work: CausalWork,
        charge_result: ChargeResult,
    },
};

/// The reports a worker call hands its caller: the machine's, which own
/// their text and values, and talk.h's view of them.
pub const Reports = struct {
    held: machine.report.Reports,
    items: []Report,
};

/// Takes the reports the Group has collected, as talk.h's view; null when
/// there are none, or the view can't be built.
fn takeReports(g: *Group) ?*Reports {
    g.group.accountingTail();
    if (g.group.reports.list.items.len == 0) return null;
    var held = g.group.reports.take();
    const out = held.arena.allocator().create(Reports) catch {
        held.deinit();
        return null;
    };
    out.* = .{ .held = held, .items = &.{} };
    out.items = viewReports(&out.held) catch {
        var dropped = out.held;
        dropped.deinit();
        return null;
    };
    return out;
}

fn viewReports(held: *machine.report.Reports) ![]Report {
    const a = held.arena.allocator();
    const out = try a.alloc(Report, held.list.items.len);
    for (held.list.items, out) |r, *o| o.* = switch (r) {
        .charge_result => |x| .{ .kind = .charge_result, .as = .{ .charge_result = chargeView(x.request, x.call, x.fuel, x.status) } },
        .run_end => |x| .{ .kind = .run_end, .as = .{ .run_end = .{
            .script = x.script.ptr,
            .script_len = x.script.len,
            .run = x.run.ptr,
            .run_len = x.run.len,
            .delivery = x.delivery.ptr,
            .delivery_len = x.delivery.len,
            .broadcast = x.broadcast.ptr,
            .broadcast_len = x.broadcast.len,
            .handler = x.handler.ptr,
            .handler_len = x.handler.len,
            .fallback = x.fallback,
            .outcome = switch (x.outcome) {
                .completed => .completed,
                .errored => .errored,
                .limit_fault => .limit_fault,
                .cancelled => .cancelled,
                .unhandled => .unhandled_outcome,
                .dropped => .dropped,
                .effect_failure => .effect_failure_outcome,
            },
            .effect = if (x.effect) |f| try one(a, effectView(f)) else null,
            .cleanup_failed = if (x.cleanup_failed) |f| try one(a, CleanupFailure{ .code = f.code.ptr, .code_len = f.code.len, .limit = f.limit.ptr, .limit_len = f.limit.len }) else null,
            .result = x.result,
            .@"error" = if (x.err) |e| try one(a, errorView(e)) else null,
            .limit = x.limit.ptr,
            .limit_len = x.limit.len,
            .at = .{ .unit = x.at.unit.ptr, .unit_len = x.at.unit.len, .line = x.at.line, .col = x.at.column, .handler = x.at.handler.ptr, .handler_len = x.at.handler.len, .pc = x.at.pc },
            .fuel = @intCast(x.fuel),
            .alloc = @intCast(x.alloc),
        } } },
        .stop => |x| .{ .kind = .stop, .as = .{ .stop = .{
            .script = x.script.ptr,
            .script_len = x.script.len,
            .reason = x.reason.ptr,
            .reason_len = x.reason.len,
            .discarded_runs = (try idList(a, x.discarded_runs)).ptr,
            .discarded_runs_len = x.discarded_runs.len,
            .dropped_messages = (try idList(a, x.dropped_messages)).ptr,
            .dropped_messages_len = x.dropped_messages.len,
            .pending_calls = (try idList(a, x.pending_calls)).ptr,
            .pending_calls_len = x.pending_calls.len,
        } } },
        .unhandled => |x| .{ .kind = .unhandled, .as = .{ .unhandled = .{ .delivery = x.delivery.ptr, .delivery_len = x.delivery.len, .message = x.message.ptr, .message_len = x.message.len, .args = x.args.ptr, .args_len = x.args.len, .target = x.target } } },
        .call_failed => |x| .{ .kind = .call_failed, .as = .{ .call_failed = .{
            .script = x.script.ptr,
            .script_len = x.script.len,
            .call = x.call.ptr,
            .call_len = x.call.len,
            .operation = .{ .capability = x.capability.ptr, .capability_len = x.capability.len, .operation = x.operation.ptr, .operation_len = x.operation.len },
            .detail = x.detail.ptr,
            .detail_len = x.detail.len,
        } } },
        .effect_failure => |x| .{ .kind = .effect_failure, .as = .{ .effect_failure = effectView(x) } },
        .decided => |x| blk: {
            const vetoes = try a.alloc(Veto, x.vetoes.len);
            for (x.vetoes, vetoes) |m, *v| v.* = .{ .script = m.script.ptr, .script_len = m.script.len, .run = m.run.ptr, .run_len = m.run.len, .reason = m.reason };
            const undecided = try a.alloc(UndecidedBy, x.undecided.len);
            for (x.undecided, undecided) |m, *u| u.* = .{ .script = m.script.ptr, .script_len = m.script.len, .run = m.run.ptr, .run_len = m.run.len, .outcome = switch (m.outcome) {
                .completed => .completed,
                .errored => .errored,
                .limit_fault => .limit_fault,
                .cancelled => .cancelled,
                .unhandled => .unhandled_outcome,
                .dropped => .dropped,
                .effect_failure => .effect_failure_outcome,
            } };
            break :blk .{ .kind = .decided, .as = .{ .decided = .{
                .delivery = x.delivery.ptr,
                .delivery_len = x.delivery.len,
                .broadcast = x.broadcast.ptr,
                .broadcast_len = x.broadcast.len,
                .verdict = switch (x.verdict) {
                    .allowed => .allowed,
                    .vetoed => .vetoed,
                    .undecided => .undecided,
                },
                .vetoes = vetoes.ptr,
                .vetoes_len = vetoes.len,
                .undecided = undecided.ptr,
                .undecided_len = undecided.len,
            } } };
        },
        .host_error => |x| .{ .kind = .host_error, .as = .{ .host_error = .{ .code = hostErrorCode(x.code), .detail = x.detail.ptr, .detail_len = x.detail.len } } },
        .run_started => |x| .{ .kind = .run_started, .as = .{ .run_started = .{
            .ancestry = ancestryView(x.ancestry),
            .script = x.script.ptr,
            .script_len = x.script.len,
            .run = x.run.ptr,
            .run_len = x.run.len,
            .delivery = x.delivery.ptr,
            .delivery_len = x.delivery.len,
            .selector = x.selector.ptr,
            .selector_len = x.selector.len,
            .function = x.function,
            .args = x.args.ptr,
            .args_len = x.args.len,
        } } },
        .run_discarded => |x| .{ .kind = .run_discarded, .as = .{ .run_discarded = .{ .ancestry = ancestryView(x.ancestry), .script = x.script.ptr, .script_len = x.script.len, .run = x.run.ptr, .run_len = x.run.len, .reason = x.reason.ptr, .reason_len = x.reason.len } } },
        .run_accounting => |x| .{ .kind = .run_accounting, .as = .{ .run_accounting = blk: {
            const state = @tagName(x.state);
            break :blk .{ .ancestry = ancestryView(x.ancestry), .script = x.script.ptr, .script_len = x.script.len, .run = x.run.ptr, .run_len = x.run.len, .fuel = @intCast(x.fuel), .state = state.ptr, .state_len = state.len };
        } } },
        .causal_work => |x| .{ .kind = .causal_work, .as = .{ .causal_work = .{ .root_delivery = x.root.ptr, .root_delivery_len = x.root.len, .live_runs = @intCast(x.live_runs), .queued_messages = @intCast(x.queued_messages), .discarded_messages = @intCast(x.discarded_messages) } } },
    };
    return out;
}

fn chargeView(request: []const u8, call: []const u8, fuel: u64, status_: caps.ChargeStatus) ChargeResult {
    const word = @tagName(status_);
    return .{ .request = request.ptr, .request_len = request.len, .call = call.ptr, .call_len = call.len, .fuel = @intCast(fuel), .status = word.ptr, .status_len = word.len };
}

pub export fn talk_call_request_charge(c: *Call, fuel: i64, out: *?*caps.ChargeRequest) HostErrorCode {
    out.* = null;
    const g: *machine.Group = @ptrCast(@alignCast(c.owner orelse c.group orelse return .invalid_value));
    if (!c.request_eligible or c.automatic) {
        g.refuseCharge(c.id, fuel, fuel >= 0 and fuel <= 9_007_199_254_740_991, "invalid value");
        return .invalid_value;
    }
    out.* = g.requestCharge(c.id, fuel) catch |err| return status(err);
    if (g.on_ready) |ready| ready(g.ready_context);
    return .ok;
}

pub export fn talk_group_on_ready(g: *Group, hook: ?*const fn (?*anyopaque) callconv(.c) void, context: ?*anyopaque) void {
    g.group.on_ready = hook;
    g.group.ready_context = context;
}

pub export fn talk_request_charge(g: *Group, call: ?[*]const u8, len: usize, fuel: i64, out: *?*caps.ChargeRequest) HostErrorCode {
    out.* = null;
    const id = bytes(call, len) catch return .invalid_value;
    out.* = g.group.requestCharge(id, fuel) catch |err| return if (err == error.UnknownCall) .unknown_call else status(err);
    if (g.group.on_ready) |ready| ready(g.group.ready_context);
    return .ok;
}

pub export fn talk_charge_request_id(q: *const caps.ChargeRequest, id: *[*]const u8, len: *usize) void {
    id.* = q.id.ptr;
    len.* = q.id.len;
}

pub export fn talk_charge_request_done(q: *const caps.ChargeRequest) bool {
    return q.done.load(.acquire);
}

pub export fn talk_charge_request_result(q: *const caps.ChargeRequest, out: *ChargeResult) bool {
    if (!q.done.load(.acquire)) return false;
    out.* = chargeView(q.id, q.call, q.fuel, q.status);
    return true;
}

fn ancestryView(x: machine.report.Ancestry) RunAncestry {
    return .{ .root_delivery = x.root.ptr, .root_delivery_len = x.root.len, .parent_run = x.parent_run.ptr, .parent_run_len = x.parent_run.len, .parent_call = x.parent_call.ptr, .parent_call_len = x.parent_call.len };
}

fn one(a: std.mem.Allocator, x: anytype) !*const @TypeOf(x) {
    const p = try a.create(@TypeOf(x));
    p.* = x;
    return p;
}

fn idList(a: std.mem.Allocator, xs: []const []const u8) ![]Id {
    const out = try a.alloc(Id, xs.len);
    for (xs, out) |x, *o| o.* = .{ .data = x.ptr, .len = x.len };
    return out;
}

fn effectView(f: machine.report.EffectFailure) EffectFailure {
    return .{
        .script = f.script.ptr,
        .script_len = f.script.len,
        .run = f.run.ptr,
        .run_len = f.run.len,
        .grant = f.grant.ptr,
        .grant_len = f.grant.len,
        .segment = f.segment.ptr,
        .segment_len = f.segment.len,
        .phase = f.phase.ptr,
        .phase_len = f.phase.len,
        .status = if (std.mem.eql(u8, f.status, "failed")) .failed else .unknown,
        .scope = f.scope.ptr,
        .scope_len = f.scope.len,
    };
}

/// A Script error as talk.h gives it: its code and message, and the error
/// map as its data.
fn errorView(e: *Value) ScriptError {
    const code: []const u8 = if (e.get("code")) |c| if (c.data == .text) c.data.text else "" else "";
    const message: ?[]const u8 = if (e.get("message")) |m| if (m.data == .text) m.data.text else null else null;
    return .{ .code = code.ptr, .code_len = code.len, .message = if (message) |m| m.ptr else null, .message_len = if (message) |m| m.len else 0, .data = e };
}

fn hostErrorCode(code: []const u8) HostErrorCode {
    inline for (@typeInfo(HostErrorCode).@"enum".field_names) |name| {
        const spaced = comptime blk: {
            var b = name[0..name.len].*;
            std.mem.replaceScalar(u8, &b, '_', ' ');
            break :blk b;
        };
        if (std.mem.eql(u8, code, &spaced)) return @field(HostErrorCode, name);
    }
    return .invalid_value;
}

/// Hands the reports a worker call made to `out`, or drops them.
fn giveReports(g: *Group, out: ?*?*Reports) void {
    const taken = takeReports(g);
    if (out) |o| o.* = taken else talk_reports_release(taken);
}

export fn talk_reports_items(r: ?*const Reports, out: *[*]const Report) usize {
    const x = r orelse {
        out.* = &.{};
        return 0;
    };
    out.* = x.items.ptr;
    return x.items.len;
}

export fn talk_reports_release(r: ?*Reports) void {
    const x = r orelse return;
    var held = x.held;
    held.deinit();
}

/// A Decision's future: its Group and delivery id, and the view of its
/// Verdict, made the first time the Host reads it once sealed.
pub const Deciding = struct {
    group: *Group,
    id: u64,
    /// `d<n>`, or for a Broadcast Decision `b<n>`.
    name: []const u8,
    broadcast: bool = false,
    decided: ?Decided = null,
    vetoes: []Veto = &.{},
    undecided: []UndecidedBy = &.{},
};

/// The versions this Core implements, which `hello` reports too.
pub const versions = struct {
    pub const language = @import("generated/version.zig").version.language;
    pub const cost_model = std.fmt.comptimePrint("{d}", .{@import("generated/costs.zig").costs.version});
    pub const unicode = @import("generated/unicode.zig").unicode_version;
    pub const core = "zig/0.0.0";
    pub const save_format = std.fmt.comptimePrint("zig/{d}", .{snapshot.format_version});
};
pub const Versions = extern struct { language: [*]const u8, language_len: usize, cost_model: [*]const u8, cost_model_len: usize, unicode: [*]const u8, unicode_len: usize, core: [*]const u8, core_len: usize, save_format: [*]const u8, save_format_len: usize };

export fn talk_core_versions(out: *Versions) void {
    const v = versions;
    out.* = .{ .language = v.language.ptr, .language_len = v.language.len, .cost_model = v.cost_model.ptr, .cost_model_len = v.cost_model.len, .unicode = v.unicode.ptr, .unicode_len = v.unicode.len, .core = v.core.ptr, .core_len = v.core.len, .save_format = v.save_format.ptr, .save_format_len = v.save_format.len };
}

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
        if (k.elements) |e| e.shape.release();
        for (k.parent_kinds) |x| gpa.free(x);
        gpa.free(k.parent_kinds);
        gpa.free(k.name);
        gpa.destroy(k);
    }
    core.kinds.deinit(gpa);
    for (core.prop_bridges.items) |b| gpa.destroy(b);
    core.prop_bridges.deinit(gpa);
    for (core.elements_bridges.items) |b| gpa.destroy(b);
    core.elements_bridges.deinit(gpa);
    for (core.mappings.items) |m| gpa.destroy(m);
    core.mappings.deinit(gpa);
    for (core.lifecycles.items) |l| gpa.destroy(l);
    core.lifecycles.deinit(gpa);
    for (core.releases.items) |x| gpa.destroy(x);
    core.releases.deinit(gpa);
    for (core.sqlite_impls.items) |x| gpa.destroy(x);
    core.sqlite_impls.deinit(gpa);
    for (core.sql_bridges.items) |x| gpa.destroy(x);
    core.sql_bridges.deinit(gpa);
    for (core.libraries.items) |l| l.destroy();
    core.libraries.deinit(gpa);
    allocator.destroy(core);
}

export fn talk_new_group(c: *Core, o: *const GroupOptions, out: *?*Group) HostErrorCode {
    out.* = null;
    const g = c.gpa.create(Group) catch return .out_of_memory;
    const name = c.gpa.dupe(u8, bytes(o.name, o.name_len) catch {
        c.gpa.destroy(g);
        return .invalid_value;
    }) catch {
        c.gpa.destroy(g);
        return .out_of_memory;
    };
    g.* = .{ .core = c, .memory = undefined, .host = if (o.allocator) |h| h.* else null, .group = undefined, .out = undefined, .sink = o.trace, .context = o.trace_context, .name = name };
    g.memory = .init(if (g.host) |*h| h.allocator() else c.gpa, o.memory_cap);
    const gpa = g.memory.allocator();
    g.out = .init(gpa);
    g.group = .init(gpa, if (o.trace != null) &g.out.writer else null);
    g.group.seed(o.seed);
    out.* = g;
    return .ok;
}

/// C only: what the Group holds now, the most it has held, its cap, and
/// whether it has refused an allocation.
export fn talk_group_memory(g: *const Group, out: *Memory) void {
    out.* = .{ .used = g.memory.used, .peak = g.memory.peak, .cap = g.memory.cap, .refused = g.memory.refused };
}

export fn talk_name(g: *const Group, s: *[*]const u8, len: *usize) void {
    s.* = g.name.ptr;
    len.* = g.name.len;
}

export fn talk_group_release(g: ?*Group) void {
    const group = g orelse return;
    const gpa = group.core.gpa;
    group.group.deinit();
    group.out.deinit();
    group.memory.deinit(); // Cached Value nodes go back last.
    for (group.scripts.items) |s| {
        gpa.free(s.name);
        gpa.destroy(s);
    }
    group.scripts.deinit(gpa);
    for (group.pending.items) |p| gpa.destroy(p);
    group.pending.deinit(gpa);
    for (group.deciding.items) |d| {
        gpa.free(d.name);
        gpa.free(d.vetoes);
        gpa.free(d.undecided);
        gpa.destroy(d);
    }
    group.deciding.deinit(gpa);
    group.names.deinit(gpa);
    group.grants.deinit(gpa);
    group.grant_operations.deinit(gpa);
    gpa.free(group.name);
    gpa.destroy(group);
}

export fn talk_load(g: *Group, o: *const LoadOptions, out: *?*Script) HostErrorCode {
    out.* = null;
    g.group.checkWorker() catch |err| {
        const name = bytes(o.name, o.name_len) catch return status(err);
        const source = bytes(o.source, o.source_len) catch return status(err);
        g.group.refuseWorker(.{ .load = .{ .name = name, .source = source } });
        g.flush();
        return status(err);
    };
    if (g.group.fatal) return .effect_state_unknown;
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    const name = bytes(o.name, o.name_len) catch return .invalid_value;
    const source = bytes(o.source, o.source_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(source)) return .invalid_value;
    for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, name)) {
        g.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "name reused");
        return .name_reused;
    };
    const given: []const LoadGrant = if (o.grants_len == 0) &.{} else (o.grants orelse return .invalid_value)[0..o.grants_len];
    const named = g.core.gpa.alloc(machine.NamedGrant, given.len) catch return .out_of_memory;
    defer g.core.gpa.free(named);
    for (given, named) |x, *n| n.* = .{ .name = bytes(x.name, x.name_len) catch return .invalid_value, .grant = x.grant };
    const objects_in: []const LoadObject = if (o.objects_len == 0) &.{} else (o.objects orelse return .invalid_value)[0..o.objects_len];
    const bound = g.core.gpa.alloc(machine.NamedObject, objects_in.len) catch return .out_of_memory;
    defer g.core.gpa.free(bound);
    for (objects_in, bound) |x, *b| b.* = .{ .name = bytes(x.name, x.name_len) catch return .invalid_value, .object = x.object };
    const limits = limitsOf(o.limits) catch {
        g.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "invalid value");
        return .invalid_value;
    };
    // An owner from another Group, then one disposed or already owning a
    // Script, then a bound Object from another Group, is refused with its
    // records, after the limits, as talk.go does.
    if (o.owner) |owner| {
        if (!g.owns(owner)) {
            g.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "wrong group");
            return .wrong_group;
        }
        if (owner.disposed or owner.owner_of != null) {
            g.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "invalid value");
            return .invalid_value;
        }
    }
    for (objects_in) |x| if (!g.owns(x.object)) {
        g.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "wrong group");
        return .wrong_group;
    };
    const loaded = g.group.load(name, source, .{ .grants = named, .grants_as_used = o.grants_as_used, .owner = o.owner, .objects = bound, .limits = limits }) catch |err| return status(err);
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
/// How a Host Input asks a Script something.
const Asking = enum { deliver, request, decide };

fn queue(s: *Script, m: *const Message, how: Asking, id: ?*Buffer, n_out: *u64) HostErrorCode {
    const g = s.group;
    if (g.memory.refused) return .out_of_memory;
    const name = bytes(m.name, m.name_len) catch return .invalid_value;
    const args: []const *Value = if (m.args_len == 0) &.{} else (m.args orelse return .invalid_value)[0..m.args_len];
    const override = overrideOf(m.limits) catch {
        g.group.refuseOverride(s.name, .{ .id = 0, .message = name, .args = @constCast(args), .request = how == .request, .decision = how == .decide }, refusedOverrideOf(m.limits), "invalid value");
        return .invalid_value;
    };
    const loosens = if (override) |o| (if (g.group.script(s.name)) |target| o.loosens(target.limits) else false) else false;
    if (!machine.hostMessageName(name, args.len) or loosens) {
        g.group.refuseDelivery(s.name, .{ .id = 0, .message = name, .args = @constCast(args), .request = how == .request, .decision = how == .decide, .limits = override }, "invalid value");
        return .invalid_value;
    }
    if (g.group.script(s.name)) |target| if (g.group.mailboxFull(target)) {
        g.group.refuseDelivery(s.name, .{ .id = 0, .message = name, .args = @constCast(args), .request = how == .request, .decision = how == .decide, .limits = override }, "mailbox full");
        return .err_mailbox_full;
    };
    const owned = g.core.gpa.alloc(*Value, args.len) catch return .out_of_memory;
    for (owned, args) |*x, v| x.* = v.retain();
    defer g.core.gpa.free(owned);
    g.group.override = override;
    const n = (if (how == .decide) g.group.decide(s.name, name, owned) else g.group.deliver(s.name, name, owned, how == .request)) catch {
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
    g.group.checkWorker() catch {
        g.group.refuseWorker(.{ .counters = s.name });
        g.flush();
        return;
    };
    const script = g.group.script(s.name) orelse return;
    const read = g.group.counters(script);
    g.flush();
    out.* = .{ .fuel_total = @intCast(read.fuel_total), .alloc_total = @intCast(read.alloc_total), .runs = @intCast(read.runs), .faults = @intCast(read.faults), .persistent_state = @intCast(read.persistent_state), .mailbox_len = @intCast(read.mailbox_len) };
}

pub export fn talk_script_deliver(s: *Script, m: *const Message, id: ?*Buffer) HostErrorCode {
    var n: u64 = 0;
    return queue(s, m, .deliver, id, &n);
}

export fn talk_script_request(s: *Script, m: *const Message, id: ?*Buffer, out: *?*Pending) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queue(s, m, .request, id, &n);
    if (code != .ok) return code;
    const p = s.group.core.gpa.create(Pending) catch return .out_of_memory;
    p.* = .{ .group = s.group, .id = n };
    s.group.pending.append(s.group.core.gpa, p) catch return .out_of_memory;
    out.* = p;
    return .ok;
}

/// Calls a Function Value from the Host, as a Request to its Home Script
/// (talk.go's Group.Call): `*out` settles when a Pump ends its Run. A value
/// this Group didn't make is TALK_INVALID_VALUE; a stale one runs nothing.
export fn talk_group_call(g: *Group, f: *Value, args: ?[*]const *Value, len: usize, limits: ?*const LimitOverride, id: ?*Buffer, out: *?*Pending) HostErrorCode {
    out.* = null;
    if (g.memory.refused) return .out_of_memory;
    if (f.data != .function or g.group.codeOfValue(f) == null) return .invalid_value;
    const given: []const *Value = if (len == 0) &.{} else (args orelse return .invalid_value)[0..len];
    // As a Request to its Home Script: an override may not loosen that
    // Script's limits, and its mailbox must have room (talk.go's Call).
    const home = g.group.script(f.data.function.home);
    const override = overrideOf(limits) catch {
        g.group.refuseCall(f, given, refusedOverrideOf(limits), "invalid value");
        return .invalid_value;
    };
    if (override) |o| if (home) |h| if (o.loosens(h.limits)) {
        g.group.refuseCall(f, given, refusedOverrideOf(limits), "invalid value");
        return .invalid_value;
    };
    if (home) |h| if (g.group.mailboxFull(h)) {
        g.group.refuseCall(f, given, refusedOverrideOf(limits), "mailbox full");
        return .err_mailbox_full;
    };
    g.group.override = override;
    const owned = g.core.gpa.alloc(*Value, given.len) catch return .out_of_memory;
    defer g.core.gpa.free(owned);
    for (owned, given) |*x, v| x.* = v.retain();
    const n = g.group.callFunctionValue(f, owned) catch {
        for (owned) |v| v.release();
        return .out_of_memory;
    };
    if (id) |b| {
        const text = std.fmt.allocPrint(allocator, "d{d}", .{n}) catch return .out_of_memory;
        b.* = .{ .data = text.ptr, .len = text.len };
    }
    const p = g.core.gpa.create(Pending) catch return .out_of_memory;
    p.* = .{ .group = g, .id = n };
    g.pending.append(g.core.gpa, p) catch return .out_of_memory;
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

fn deciding(g: *Group, n: u64, broadcast: bool, out: *?*Deciding) HostErrorCode {
    const gpa = g.core.gpa;
    const d = gpa.create(Deciding) catch return .out_of_memory;
    const name = std.fmt.allocPrint(gpa, "{s}{d}", .{ if (broadcast) "b" else "d", n }) catch {
        gpa.destroy(d);
        return .out_of_memory;
    };
    d.* = .{ .group = g, .id = n, .name = name, .broadcast = broadcast };
    g.deciding.append(gpa, d) catch {
        gpa.free(name);
        gpa.destroy(d);
        return .out_of_memory;
    };
    out.* = d;
    return .ok;
}

export fn talk_script_decide(s: *Script, m: *const Message, id: ?*Buffer, out: *?*Deciding) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queue(s, m, .decide, id, &n);
    if (code != .ok) return code;
    return deciding(s.group, n, false, out);
}

fn sealedOf(d: *const Deciding) ?machine.Decided {
    return (if (d.broadcast) d.group.group.decided_broadcasts else d.group.group.decided).get(d.id);
}

export fn talk_deciding_done(d: *const Deciding) bool {
    return sealedOf(d) != null;
}

export fn talk_deciding_decided(d: *Deciding) ?*const Decided {
    if (d.decided) |*x| return x;
    const sealed = sealedOf(d) orelse return null;
    const gpa = d.group.core.gpa;
    const vetoes = gpa.alloc(Veto, sealed.vetoes.len) catch return null;
    const undecided = gpa.alloc(UndecidedBy, sealed.undecided.len) catch {
        gpa.free(vetoes);
        return null;
    };
    for (sealed.vetoes, vetoes) |m, *v| v.* = .{ .script = m.script.ptr, .script_len = m.script.len, .run = m.run.ptr, .run_len = m.run.len, .reason = m.reason.? };
    const outcomes = [_]struct { []const u8, Outcome }{ .{ "errored", .errored }, .{ "limit fault", .limit_fault }, .{ "cancelled", .cancelled }, .{ "dropped", .dropped }, .{ "effect failed", .effect_failure_outcome } };
    for (sealed.undecided, undecided) |m, *u| {
        const outcome = for (outcomes) |o| {
            if (std.mem.eql(u8, o[0], m.outcome)) break o[1];
        } else .errored;
        u.* = .{ .script = m.script.ptr, .script_len = m.script.len, .run = m.run.ptr, .run_len = m.run.len, .outcome = outcome };
    }
    d.vetoes = vetoes;
    d.undecided = undecided;
    const named: []const u8 = d.name;
    d.decided = .{
        .delivery = if (d.broadcast) "" else named.ptr,
        .delivery_len = if (d.broadcast) 0 else named.len,
        .broadcast = if (d.broadcast) named.ptr else "",
        .broadcast_len = if (d.broadcast) named.len else 0,
        .verdict = @fromBackingInt(@intCast(@backingInt(sealed.verdict))),
        .vetoes = vetoes.ptr,
        .vetoes_len = vetoes.len,
        .undecided = undecided.ptr,
        .undecided_len = undecided.len,
    };
    return &d.decided.?;
}

export fn talk_pending_release(p: ?*Pending) void {
    _ = p;
    // A Request's handle lives with its Group, which frees it.
}

export fn talk_pending_done(p: *const Pending) bool {
    return p.group.group.results.contains(p.id);
}

export fn talk_pump(g: *Group, seconds: i64, micros: i32, o: ?*const PumpOptions, out: ?*PumpResult) HostErrorCode {
    g.group.checkWorker() catch |err| {
        const options = if (o) |x| x.* else PumpOptions{ .fuel_slice = 0, .fuel_cap = 0 };
        const clock = model.dates.Instant{ .seconds = seconds, .micros = micros };
        model.dates.validateInstant(clock) catch return status(err);
        g.group.refuseWorker(.{ .pump = .{ .now = clock, .slice = options.fuel_slice, .cap = options.fuel_cap } });
        g.flush();
        return status(err);
    };
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    const clock = model.dates.Instant{ .seconds = seconds, .micros = micros };
    model.dates.validateInstant(clock) catch return .invalid_value;
    const options: PumpOptions = if (o) |x| x.* else .{ .fuel_slice = 0, .fuel_cap = 0 };
    if (options.fuel_slice < 0 or options.fuel_cap < 0) return .invalid_value;
    g.group.pumpWith(clock, @intCast(options.fuel_slice), @intCast(options.fuel_cap)) catch |err| return status(err);
    // A C Host answers inside its calls, so a crossing pause here is only
    // `defer_crossings`' (a testing aid): take the Pump up again at once.
    while (g.group.pumpPaused()) g.group.resumePump() catch |err| return status(err);
    const reports = takeReports(g);
    const r = out orelse {
        talk_reports_release(reports);
        return .ok;
    };
    r.* = .{ .state = if (g.group.stoppedState()) .stopped else if (g.group.rewound) .rewound else if (g.group.sliced) .sliced else .idle, .fuel_used = @intCast(g.group.pump_fuel), .reports = reports };
    if (g.group.next()) |deadline| {
        r.has_next_deadline = true;
        r.next_deadline_seconds = @intCast(@divFloor(deadline, std.time.us_per_s));
        r.next_deadline_micros = @intCast(@mod(deadline, std.time.us_per_s));
    }
    return .ok;
}

/// Replaces a Library the Group holds, a worker call: the Libraries that
/// import it are recompiled, and the Core owns them; the Scripts that import
/// any of them are stop-and-reloaded. A refusal changes nothing.
export fn talk_replace_library(g: *Group, l: *machine.Library, carry: CarryOver, reports: ?*?*Reports) HostErrorCode {
    if (reports) |r| r.* = null;
    g.group.checkWorker() catch |err| {
        g.group.refuseWorker(.{ .replace_library = .{ .library = l, .carry = carry == .carry_variables } });
        g.flush();
        return status(err);
    };
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    defer giveReports(g, reports);
    const c = g.core;
    // Room for every Library it could recompile, so that once the Group
    // uses them the Core can own them.
    c.libraries.ensureUnusedCapacity(c.gpa, g.group.libraries.items.len) catch return .out_of_memory;
    var replaced = g.group.replaceLibrary(l, carry == .carry_variables, c.gpa) catch |err| return status(err);
    // A C Host answers inside its calls, so a pause here is only
    // `defer_crossings`' (a testing aid): go on at once.
    while (replaced == .paused) replaced = (g.group.resumeWork() catch |err| return status(err)).replace;
    return switch (replaced) {
        .paused => unreachable,
        .replaced => |made| {
            defer g.group.gpa.free(made);
            c.libraries.appendSliceAssumeCapacity(made);
            return .ok;
        },
        .refused => .load_refused,
        .unknown_library => .invalid_value,
        .state_too_large => .state_too_large,
        .stopped => .effect_state_unknown,
    };
}

// ---------------------------------------------------------------- save and restore

/// Saves the Group between Pumps (chapter 10), a worker call: its bytes,
/// which the caller releases, or `effects pending` with no snapshot. Either
/// way the attempt takes the next save id, and its `save` record.
pub export fn talk_save(g: *Group, out: *Buffer) HostErrorCode {
    out.* = .{};
    g.group.checkWorker() catch |err| return status(err);
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    g.group.flushChargeRefusals();
    g.group.saves += 1;
    g.group.write("> save s{d}\n", .{g.group.saves});
    if (snapshot.effectsPending(&g.group)) {
        g.group.write("refused code=\"effects pending\"\n", .{});
        return .effects_pending;
    }
    const print = g.group.groupFingerprint() catch return .out_of_memory;
    const saved = snapshot.save(&g.group, allocator, print) catch |err| {
        if (err == error.EffectsPending) {
            g.group.write("refused code=\"effects pending\"\n", .{});
            return .effects_pending;
        }
        return .out_of_memory;
    };
    out.* = .{ .data = saved.ptr, .len = saved.len };
    return .ok;
}

pub const MismatchPolicy = enum(c_int) { reject_mismatch, variables_only };

pub const RebindFn = ?*const fn (context: ?*anyopaque, script: [*]const u8, script_len: usize, name: [*]const u8, name_len: usize) callconv(.c) ?*caps.Grant;
pub const ResolveFn = ?*const fn (context: ?*anyopaque, kind: [*]const u8, kind_len: usize, id: [*]const u8, id_len: usize, native: *?*anyopaque) callconv(.c) bool;

pub const RestoreOptions = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    trace: TraceSink,
    trace_context: ?*anyopaque,
    libraries: ?[*]const *machine.Library,
    libraries_len: usize,
    grants: RebindFn,
    grants_context: ?*anyopaque,
    resolve: ResolveFn,
    resolve_context: ?*anyopaque,
    mismatch: MismatchPolicy,
    allocator: ?*const HostAllocator,
    memory_cap: usize,
};

pub const PendingCall = extern struct {
    id: [*]const u8,
    id_len: usize,
    script: [*]const u8,
    script_len: usize,
    grant: [*]const u8,
    grant_len: usize,
    operation: [*]const u8,
    operation_len: usize,
};

pub const ObjectRef = extern struct { kind: [*]const u8, kind_len: usize, id: [*]const u8, id_len: usize };

/// What a restore reports, owned by the caller.
pub const RestoreResult = struct {
    gpa: std.mem.Allocator,
    variables_only: bool,
    pending: []PendingCall,
    disposed: []ObjectRef,
    discarded: []Id,
    dropped: []Id,
    abandoned: []Id,
    /// The accounting baseline the restore reports.
    reports: ?*Reports = null,
};

/// An id the Group holds, such as a Run's or a call's.
pub const Id = extern struct { data: [*]const u8, len: usize };

const Bridges = struct {
    core: *Core,
    options: *const RestoreOptions,

    fn rebind(context: ?*anyopaque, script: []const u8, name: []const u8) ?*caps.Grant {
        const b: *const Bridges = @ptrCast(@alignCast(context.?));
        const f = b.options.grants orelse return null;
        return f(b.options.grants_context, script.ptr, script.len, name.ptr, name.len);
    }

    fn resolve(context: ?*anyopaque, kind: []const u8, id: []const u8, native: *?*anyopaque) bool {
        const b: *const Bridges = @ptrCast(@alignCast(context.?));
        const f = b.options.resolve orelse return false;
        return f(b.options.resolve_context, kind.ptr, kind.len, id.ptr, id.len, native);
    }

    fn kindNamed(context: ?*anyopaque, name: []const u8) ?*const objects.Kind {
        const b: *const Bridges = @ptrCast(@alignCast(context.?));
        for (b.core.kinds.items) |k| if (std.mem.eql(u8, k.name, name)) return k;
        return null;
    }
};

/// Builds a new Group from a save (chapter 10, Restoring): one that hasn't
/// been pumped, its restore record in its Trace. Bytes this Core can't
/// read are `invalid save`, and a save that doesn't match `save mismatch`;
/// either way nothing is made.
pub export fn talk_restore(c: *Core, save: ?[*]const u8, len: usize, o: *const RestoreOptions, out: *?*Group, restored: *?*RestoreResult) HostErrorCode {
    out.* = null;
    restored.* = null;
    const bytes_in: []const u8 = if (len == 0) &.{} else (save orelse return .invalid_value)[0..len];
    const given: []const *machine.Library = if (o.libraries_len == 0) &.{} else (o.libraries orelse return .invalid_value)[0..o.libraries_len];
    const group_options: GroupOptions = .{ .name = o.name, .name_len = o.name_len, .trace = o.trace, .trace_context = o.trace_context, .allocator = o.allocator, .memory_cap = o.memory_cap };
    var made: ?*Group = null;
    if (talk_new_group(c, &group_options, &made) != .ok) return .out_of_memory;
    const g = made.?;
    var bridges: Bridges = .{ .core = c, .options = o };
    var report: snapshot.Result = .{};
    const outcome = snapshot.restore(&g.group, bytes_in, .{
        .libraries = given,
        .grants = .{ .context = &bridges, .call = Bridges.rebind },
        .resolve = .{ .context = &bridges, .call = Bridges.resolve },
        .kinds = .{ .context = &bridges, .call = Bridges.kindNamed },
        .variables_only = o.mismatch == .variables_only,
    }, &report) catch |err| {
        g.flush();
        talk_group_release(g);
        return switch (err) {
            error.InvalidSave => .invalid_save,
            error.LoadRefused => .load_refused,
            error.StateTooLarge => .state_too_large,
            error.OutOfMemory => .out_of_memory,
        };
    };
    defer report.deinit(g.group.gpa);
    if (outcome == .mismatch) {
        g.flush();
        talk_group_release(g);
        return .save_mismatch;
    }
    const r = c.gpa.create(RestoreResult) catch {
        talk_group_release(g);
        return .out_of_memory;
    };
    r.* = .{ .gpa = c.gpa, .variables_only = outcome == .variables_only, .pending = &.{}, .disposed = &.{}, .discarded = &.{}, .dropped = &.{}, .abandoned = &.{} };
    const filled = blk: {
        r.pending = c.gpa.alloc(PendingCall, g.group.restored.?.pending.items.len) catch break :blk false;
        for (g.group.restored.?.pending.items, r.pending) |id, *p| {
            const call = g.group.callById(id).?;
            const operation = for (g.group.waits.all()) |w| {
                if (w.call == call) break w.operation;
            } else "";
            p.* = .{ .id = id.ptr, .id_len = id.len, .script = call.script.ptr, .script_len = call.script.len, .grant = call.grant.ptr, .grant_len = call.grant.len, .operation = operation.ptr, .operation_len = operation.len };
        }
        r.disposed = c.gpa.alloc(ObjectRef, report.disposed.len) catch break :blk false;
        inline for (.{ "discarded", "dropped", "abandoned" }) |f| {
            const ids = @field(report, f);
            @field(r, f) = c.gpa.alloc(Id, ids.len) catch break :blk false;
            for (ids, @field(r, f)) |id, *x| x.* = .{ .data = id.ptr, .len = id.len };
        }
        for (report.disposed, r.disposed) |x, *d| d.* = .{ .kind = x.kind.name.ptr, .kind_len = x.kind.name.len, .id = x.id.ptr, .id_len = x.id.len };
        // Each Script gets its handle.
        for (g.group.scripts.items) |s| {
            const h = c.gpa.create(Script) catch break :blk false;
            h.* = .{ .group = g, .name = c.gpa.dupe(u8, s.name) catch {
                c.gpa.destroy(h);
                break :blk false;
            } };
            g.scripts.append(c.gpa, h) catch {
                c.gpa.free(h.name);
                c.gpa.destroy(h);
                break :blk false;
            };
        }
        break :blk true;
    };
    if (!filled) {
        talk_restore_result_release(r);
        talk_group_release(g);
        return .out_of_memory;
    }
    r.reports = takeReports(g);
    g.flush();
    out.* = g;
    restored.* = r;
    return .ok;
}

pub export fn talk_restore_result_variables_only(r: *const RestoreResult) bool {
    return r.variables_only;
}

/// The pending calls, in call id order; each borrows from the Group.
export fn talk_restore_result_pending(r: *const RestoreResult, out: *?[*]const PendingCall) usize {
    out.* = r.pending.ptr;
    return r.pending.len;
}

/// The Host Objects the Host didn't resolve; each borrows from the Group.
export fn talk_restore_result_disposed(r: *const RestoreResult, out: *?[*]const ObjectRef) usize {
    out.* = r.disposed.ptr;
    return r.disposed.len;
}

/// What a variables-only restore discarded: 0 the Runs, 1 the dropped
/// Deliveries, 2 the abandoned calls; each id borrows from the Group.
export fn talk_restore_result_ids(r: *const RestoreResult, which: c_int, out: *?[*]const Id) usize {
    const ids = switch (which) {
        0 => r.discarded,
        1 => r.dropped,
        2 => r.abandoned,
        else => &.{},
    };
    out.* = ids.ptr;
    return ids.len;
}

pub export fn talk_restore_result_release(r: ?*RestoreResult) void {
    const x = r orelse return;
    x.gpa.free(x.pending);
    x.gpa.free(x.disposed);
    x.gpa.free(x.discarded);
    x.gpa.free(x.dropped);
    x.gpa.free(x.abandoned);
    talk_reports_release(x.reports);
    x.gpa.destroy(x);
}

/// C only: the restore's accounting baseline, borrowed from r.
export fn talk_restore_result_reports(r: *const RestoreResult) ?*const Reports {
    return r.reports;
}

pub const Settlement = extern struct {
    answer: ?*Value,
    fail: ?*const ScriptError,
    reissue: bool,
    adopt: bool,
};

/// Settles a restored pending call before the first Pump, queued. A call
/// that isn't pending, one settled already, or any once the first Pump has
/// started, is `unknown call` at the call. Adopt gives the Call the Host
/// answers or fails through.
export fn talk_settle(g: *Group, id: ?[*]const u8, len: usize, st: *const Settlement, adopted: ?*?*Call) HostErrorCode {
    if (adopted) |a| a.* = null;
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    const call_id = bytes(id, len) catch return .invalid_value;
    const chosen = @as(u8, @intFromBool(st.answer != null)) + @intFromBool(st.fail != null) + @intFromBool(st.reissue) + @intFromBool(st.adopt);
    if (chosen != 1) return .invalid_value;
    const how: machine.How = if (st.answer != null) .answer else if (st.fail != null) .fail else if (st.reissue) .reissue else .adopt;
    const gpa = g.group.gpa;
    var shown: ?*Value = null;
    defer if (shown) |v| v.release();
    const with: ?machine.Resume = switch (how) {
        .answer => .{ .answer = .{ .value = st.answer.?.retain(), .fuel = 0 } },
        .fail => blk: {
            const f = st.fail.?;
            const code = gpa.dupe(u8, bytes(f.code, f.code_len) catch return .invalid_value) catch return .out_of_memory;
            const message: ?[]const u8 = if (f.message == null) null else gpa.dupe(u8, bytes(f.message, f.message_len) catch return .invalid_value) catch {
                gpa.free(code);
                return .out_of_memory;
            };
            const failure: machine.Failure = .{ .code = code, .message = message, .data = if (f.data) |d| d.retain() else null };
            shown = machine.failureValue(gpa, failure) catch null;
            break :blk .{ .failed = failure };
        },
        .reissue, .adopt => null,
    };
    g.group.settleRestored(call_id, how, with) catch |err| switch (err) {
        error.UnknownCall => {
            g.group.refuseSettlement(call_id, how, if (how == .answer) st.answer.? else shown);
            return .unknown_call;
        },
        error.NotAdoptable => return .not_adoptable,
        error.OutOfMemory => return .out_of_memory,
    };
    if (how == .adopt) if (adopted) |a| {
        if (g.group.callById(call_id)) |x| a.* = x;
    };
    return .ok;
}

const manifest = @import("machine/manifest.zig");
pub const MessageDecl = extern struct { name: ?[*]const u8, name_len: usize, args: ?[*]const *const Shape, args_len: usize, receivers: ?[*]const *const objects.Kind, receivers_len: usize, description: ?[*]const u8 = null, description_len: usize = 0, examples: ?[*]const ?[*]const u8 = null, examples_lens: ?[*]const usize = null, examples_len: usize = 0 };
pub const ManifestObject = extern struct { name: ?[*]const u8, name_len: usize, kind: *const objects.Kind };
pub const ManifestSpec = extern struct {
    kind: ?[*]const u8,
    kind_len: usize,
    version: ?[*]const u8,
    version_len: usize,
    grants: ?[*]const LoadGrant,
    grants_len: usize,
    libraries: ?[*]const *const machine.Library,
    libraries_len: usize,
    messages: ?[*]const MessageDecl,
    messages_len: usize,
    object_kinds: ?[*]const *const objects.Kind,
    object_kinds_len: usize,
    objects: ?[*]const ManifestObject,
    objects_len: usize,
};

fn listOf(comptime T: type, items: ?[*]const T, len: usize) error{InvalidValue}![]const T {
    return if (len == 0) &.{} else (items orelse return error.InvalidValue)[0..len];
}

fn exportManifest(a: std.mem.Allocator, m: *const ManifestSpec) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const t = arena.allocator();
    const given_grants = try listOf(LoadGrant, m.grants, m.grants_len);
    const grants = try t.alloc(manifest.Grant, given_grants.len);
    for (given_grants, grants) |x, *y| y.* = .{ .name = try bytes(x.name, x.name_len), .grant = x.grant };
    const given_messages = try listOf(MessageDecl, m.messages, m.messages_len);
    const messages = try t.alloc(manifest.Message, given_messages.len);
    for (given_messages, messages) |x, *y| {
        const args = try listOf(*const Shape, x.args, x.args_len);
        const examples = try t.alloc([]const u8, x.examples_len);
        if (x.examples_len > 0) {
            const texts = x.examples orelse return error.InvalidValue;
            const lens = x.examples_lens orelse return error.InvalidValue;
            for (examples, 0..) |*e, i| e.* = try bytes(texts[i], lens[i]);
        }
        y.* = .{ .name = try bytes(x.name, x.name_len), .args = @ptrCast(args), .receivers = try listOf(*const objects.Kind, x.receivers, x.receivers_len), .description = try bytes(x.description, x.description_len), .examples = examples };
    }
    const given_objects = try listOf(ManifestObject, m.objects, m.objects_len);
    const named = try t.alloc(manifest.Object, given_objects.len);
    for (given_objects, named) |x, *y| y.* = .{ .name = try bytes(x.name, x.name_len), .kind = x.kind };
    return manifest.write(a, .{
        .kind = try bytes(m.kind, m.kind_len),
        .version = try bytes(m.version, m.version_len),
        .grants = grants,
        .libraries = try listOf(*const machine.Library, m.libraries, m.libraries_len),
        .messages = messages,
        .object_kinds = try listOf(*const objects.Kind, m.object_kinds, m.object_kinds_len),
        .objects = named,
    });
}

export fn talk_export_manifest(m: *const ManifestSpec, out: *Buffer) HostErrorCode {
    return buffer(out, exportManifest(allocator, m));
}

/// The handle of the Group's Script with that name, or NULL.
pub const FunctionInfo = extern struct { home: [*]const u8, home_len: usize, name: [*]const u8, name_len: usize, required: i64, total: i64, unit: [32]u8, stale: bool };

export fn talk_function_info_of(g: *Group, v: *const Value, out: *FunctionInfo) bool {
    const f = g.group.codeOfValue(v) orelse return false;
    const stale = if (g.group.script(f.home)) |h| h.generation != f.generation else true;
    out.* = .{ .home = f.home.ptr, .home_len = f.home.len, .name = f.name.ptr, .name_len = f.name.len, .required = @intCast(f.required), .total = @intCast(f.total), .unit = f.unit, .stale = stale };
    return true;
}

pub const UnitInfo = extern struct { name: [*]const u8, name_len: usize, source: [*]const u8, source_len: usize, identity: [32]u8 };

export fn talk_script_unit(s: *Script, index: usize, out: *UnitInfo) bool {
    const script = s.group.group.script(s.name) orelse return false;
    if (index == 0) {
        out.* = .{ .name = script.name.ptr, .name_len = script.name.len, .source = script.source.ptr, .source_len = script.source.len, .identity = machine.codeIdentity(script.name, script.source, .script, script.imports) };
        return true;
    }
    if (index > script.extensions.items.len) return false;
    const l = script.extensions.items[index - 1];
    out.* = .{ .name = l.name.ptr, .name_len = l.name.len, .source = l.source.ptr, .source_len = l.source.len, .identity = l.identity };
    return true;
}

/// Group.ScriptNames: the Scripts' names in load order, borrowed from the
/// Group until its next call that loads or restores. Safe inside a Pump; it
/// writes nothing to the Trace.
pub export fn talk_script_names(g: *Group, out: *[*]const Id) usize {
    g.names.clearRetainingCapacity();
    for (g.group.scripts.items) |s| g.names.append(g.core.gpa, .{ .data = s.name.ptr, .len = s.name.len }) catch {
        out.* = g.names.items.ptr;
        return g.names.items.len;
    };
    out.* = g.names.items.ptr;
    return g.names.items.len;
}

pub export fn talk_group_script(g: *Group, name: ?[*]const u8, len: usize) ?*Script {
    const n = bytes(name, len) catch return null;
    for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, n)) return s;
    return null;
}

export fn talk_script_name(s: *const Script, name: *[*]const u8, len: *usize) void {
    name.* = s.name.ptr;
    len.* = s.name.len;
}

pub const ScriptGrant = extern struct { name: [*]const u8, name_len: usize, operations: [*]const Id, operations_len: usize };

fn idLess(_: void, x: Id, y: Id) bool {
    return std.mem.lessThan(u8, x.data[0..x.len], y.data[0..y.len]);
}

/// Script.Grants: each kept name with its kept Operations, sorted, borrowed
/// from the Group until the next call. Empty if it can't allocate.
export fn talk_script_grants(s: *Script, out: *[*]const ScriptGrant) usize {
    const g = s.group;
    const gpa = g.core.gpa;
    g.grants.clearRetainingCapacity();
    g.grant_operations.clearRetainingCapacity();
    out.* = g.grants.items.ptr;
    const script = g.group.script(s.name) orelse return 0;
    for (script.grants) |sg| {
        const start = g.grant_operations.items.len;
        for (sg.grant.capability.operations, sg.kept) |op, kept| if (kept) {
            g.grant_operations.append(gpa, .{ .data = op.name.ptr, .len = op.name.len }) catch return 0;
        };
        std.mem.sort(Id, g.grant_operations.items[start..], {}, idLess);
        g.grants.append(gpa, .{ .name = sg.name.ptr, .name_len = sg.name.len, .operations = undefined, .operations_len = g.grant_operations.items.len - start }) catch return 0;
    }
    // The Operation names are all in place, so the views can point at them.
    var start: usize = 0;
    for (g.grants.items) |*v| {
        v.operations = g.grant_operations.items[start..].ptr;
        start += v.operations_len;
    }
    out.* = g.grants.items.ptr;
    return g.grants.items.len;
}

/// The Group Fingerprint (chapter 9), 32 bytes, a worker call.
export fn talk_fingerprint(g: *Group, out: *[32]u8) HostErrorCode {
    g.group.checkWorker() catch |err| return status(err);
    out.* = g.group.groupFingerprint() catch return .out_of_memory;
    return .ok;
}

pub const RunStatus = enum(c_int) { ready, suspended, parked, preempted };
pub const RunView = extern struct {
    id: [*]const u8,
    id_len: usize,
    status: RunStatus,
    handler: [*]const u8,
    handler_len: usize,
    wait: [*]const u8 = "",
    wait_len: usize = 0,
    has_until: bool = false,
    until_seconds: i64 = 0,
    until_micros: i32 = 0,
    calls: [*]const Id = &.{},
    calls_len: usize = 0,
};
pub const MessageView = extern struct { delivery: [*]const u8, delivery_len: usize, from: [*]const u8, from_len: usize, message: Message };
pub const ScriptView = extern struct {
    disabled_grants: [*]const Id,
    disabled_grants_len: usize,
    name: [*]const u8,
    name_len: usize,
    vars: [*]const Pair,
    vars_len: usize,
    runs: [*]const RunView,
    runs_len: usize,
    mailbox: [*]const MessageView,
    mailbox_len: usize,
};
pub const Inspection = extern struct { scripts: [*]const ScriptView, scripts_len: usize };

/// An Inspection and the arena its views live in. The values it shows are
/// retained until it is released.
const Inspecting = struct {
    view: Inspection,
    arena: std.heap.ArenaAllocator,
    values: std.ArrayList(*Value) = .empty,

    fn value(x: *Inspecting, v: *Value) !*Value {
        try x.values.append(x.arena.allocator(), v);
        return v.retain();
    }
};

export fn talk_inspect(g: *Group, out: ?*?*Inspection) HostErrorCode {
    if (out) |o| o.* = null;
    g.group.checkWorker() catch |err| {
        g.group.refuseWorker(.inspect);
        g.flush();
        return status(err);
    };
    g.group.vars();
    g.flush();
    const o = out orelse return .ok;
    const x = g.group.gpa.create(Inspecting) catch return .out_of_memory;
    x.* = .{ .view = .{ .scripts = &.{}, .scripts_len = 0 }, .arena = .init(g.group.gpa) };
    inspect(&g.group, x) catch {
        talk_inspection_release(&x.view);
        return .out_of_memory;
    };
    o.* = &x.view;
    return .ok;
}

fn inspect(g: *machine.Group, x: *Inspecting) !void {
    const a = x.arena.allocator();
    const scripts = try a.alloc(ScriptView, g.scripts.items.len);
    for (g.scripts.items, scripts) |s, *view| {
        var disabled: std.ArrayList(Id) = .empty;
        for (s.grants) |sg| if (sg.disabled) try disabled.append(a, .{ .data = sg.name.ptr, .len = sg.name.len });
        std.mem.sort(Id, disabled.items, {}, struct {
            fn less(_: void, p: Id, q: Id) bool {
                return std.mem.order(u8, p.data[0..p.len], q.data[0..q.len]) == .lt;
            }
        }.less);
        const vars = try a.alloc(Pair, s.variables.len);
        for (s.variableNames(), s.variables, vars) |name, v, *pair| pair.* = .{ .key = name.ptr, .key_len = name.len, .value = try x.value(v) };
        // Runs in the order they started.
        const live = try a.dupe(*machine.Run, s.live.items);
        std.mem.sort(*machine.Run, live, {}, struct {
            fn less(_: void, p: *machine.Run, q: *machine.Run) bool {
                return runNumber(p.id) < runNumber(q.id);
            }
        }.less);
        const runs = try a.alloc(RunView, live.len);
        for (live, runs) |r, *rv| rv.* = try runView(a, r);
        var mailbox: std.ArrayList(MessageView) = .empty;
        for (s.work.items) |w| switch (w) {
            .message => |d| {
                const delivery: []const u8 = if (d.from == null and d.id > 0) try std.fmt.allocPrint(a, "d{d}", .{d.id}) else "";
                const from: []const u8 = d.from orelse "";
                const args = try a.alloc(*Value, d.args.len);
                for (d.args, args) |v, *arg| arg.* = try x.value(v);
                try mailbox.append(a, .{ .delivery = delivery.ptr, .delivery_len = delivery.len, .from = from.ptr, .from_len = from.len, .message = .{ .name = d.message.ptr, .name_len = d.message.len, .args = args.ptr, .args_len = args.len } });
            },
            .run => {},
        };
        view.* = .{
            .disabled_grants = disabled.items.ptr,
            .disabled_grants_len = disabled.items.len,
            .name = s.name.ptr,
            .name_len = s.name.len,
            .vars = vars.ptr,
            .vars_len = vars.len,
            .runs = runs.ptr,
            .runs_len = runs.len,
            .mailbox = mailbox.items.ptr,
            .mailbox_len = mailbox.items.len,
        };
    }
    x.view = .{ .scripts = scripts.ptr, .scripts_len = scripts.len };
}

fn runNumber(id: []const u8) u64 {
    const at = std.mem.lastIndexOfScalar(u8, id, 'r') orelse return 0;
    return std.fmt.parseInt(u64, id[at + 1 ..], 10) catch 0;
}

/// A live Run as Inspect shows it: preempted mid-Segment, parked by its
/// clause's Queueing Policy, suspended at a wait, or ready to go on.
fn runView(a: std.mem.Allocator, r: *const machine.Run) !RunView {
    const handler: []const u8 = if (r.delivery.function) |f| try display.string(a, f) else r.handler;
    var out: RunView = .{ .id = r.id.ptr, .id_len = r.id.len, .status = .ready, .handler = handler.ptr, .handler_len = handler.len };
    if (r.continuing) {
        out.status = .preempted;
        return out;
    }
    if (r.resume_with != null) return out;
    if (r.parked) {
        out.status = .parked;
        return out;
    }
    out.status = .suspended;
    out.wait = r.suspended_at.ptr;
    out.wait_len = r.suspended_at.len;
    var calls: std.ArrayList(Id) = .empty;
    if (r.waiting) |p| {
        // As the `seg` record shows it: a deadline of its own, never a
        // call's MaxWait.
        if (p.deadline != std.math.maxInt(i128) and ((p.call == null and p.id.len == 0) or p.block)) {
            out.has_until = true;
            out.until_seconds = @intCast(@divFloor(p.deadline, std.time.us_per_s));
            out.until_micros = @intCast(@mod(p.deadline, std.time.us_per_s));
        }
        if (p.call) |c| try calls.append(a, .{ .data = c.id.ptr, .len = c.id.len }) else if (p.id.len > 0) try calls.append(a, .{ .data = p.id.ptr, .len = p.id.len });
    }
    if (r.join) |j| for (j.members.items) |m| if (m.pending) |p| {
        if (p.call) |c| try calls.append(a, .{ .data = c.id.ptr, .len = c.id.len }) else if (p.id.len > 0) try calls.append(a, .{ .data = p.id.ptr, .len = p.id.len });
    };
    out.calls = calls.items.ptr;
    out.calls_len = calls.items.len;
    return out;
}

export fn talk_inspection_release(i: ?*Inspection) void {
    const view = i orelse return;
    const x: *Inspecting = @fieldParentPtr("view", view);
    for (x.values.items) |v| v.release();
    const gpa = x.arena.child_allocator;
    x.arena.deinit();
    gpa.destroy(x);
}

/// The Message Layer (src/message.zig) is a Zig Host of this same API: it
/// calls these exports as Zig functions, through these names.
pub const direct = struct {
    pub const new = talk_new;
    pub const coreRelease = talk_core_release;
    pub const newGroup = talk_new_group;
    pub const groupRelease = talk_group_release;
    pub const load = talk_load;
    pub const groupScript = talk_group_script;
    pub const scriptDeliver = talk_script_deliver;
    pub const scriptRequest = talk_script_request;
    pub const save = talk_save;
    pub const fingerprint = talk_fingerprint;
    pub const callAnswer = talk_call_answer;
    pub const callAnswerWithCost = talk_call_answer_with_cost;
    pub const callFail = talk_call_fail;
    pub const requestCharge = talk_request_charge;
    pub const grant = talk_capability_def_grant;
    pub const grantAll = talk_capability_def_grant_all;
    pub const defineObjectKind = talk_define_object_kind;
    pub const groupObject = talk_group_object;
    pub const setParent = talk_set_parent;
    pub const dispose = talk_dispose;
    pub const objectById = talk_object_by_id;
    pub const deliver = talk_deliver;
    pub const request = talk_request;
    pub const decide = talk_decide;
    pub const scriptDecide = talk_script_decide;
    pub const broadcast = talk_broadcast;
    pub const decideBroadcast = talk_decide_broadcast;
    pub const scriptReload = talk_script_reload;
    pub const scriptExtend = talk_script_extend;
    pub const reportsRelease = talk_reports_release;
    pub const compileLibrary = talk_compile_library;
    pub const loadErrorRelease = talk_load_error_release;
    pub const addLibrary = talk_add_library;
    pub const replaceLibrary = talk_replace_library;
    pub const inspect = talk_inspect;
    pub const inspectionRelease = talk_inspection_release;
    pub const scriptGrants = talk_script_grants;
    pub const restore = talk_restore;
    pub const restoreResultRelease = talk_restore_result_release;
    pub const settle = talk_settle;
    pub const call = talk_group_call;
    pub const exportManifest = talk_export_manifest;
    pub const scriptCounters = talk_script_counters;
    pub const scriptStop = talk_script_stop;
    pub const scriptCancelRun = talk_script_cancel_run;
    pub const scriptRewindRun = talk_script_rewind_run;
    pub const scriptRevoke = talk_script_revoke;
    pub const cancelDelivery = talk_cancel_delivery;
    pub const ownedBytesRelease = talk_owned_bytes_release;
    pub const valueRelease = talk_value_release;
};

/// Defines a Capability from Core Operations whose Host functions are the
/// Core's own Zig functions, for the Message Layer. Takes `operations`
/// (allocated with the Core's allocator) on success only.
pub fn defineCapabilityZig(c: *Core, name: []const u8, operations: []caps.Operation, out: *?*caps.Capability) HostErrorCode {
    return defineCapabilityZigWith(c, name, operations, null, null, out);
}

/// `defineCapabilityZig` with a Segment Coordinator mapping, which a
/// Capability with Segment-bound Operations needs, and a Grant release
/// hook, both the Core's own Zig functions.
pub fn defineCapabilityZigWith(c: *Core, name: []const u8, operations: []caps.Operation, coordinator_of: ?caps.CoordinatorOf, release: ?caps.ReleaseHook, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const gpa = c.gpa;
    if (name.len == 0) return .invalid_value;
    for (c.definitions.items) |d| if (std.mem.eql(u8, d.name, name)) return .name_reused;
    std.mem.sort(caps.Operation, operations, {}, struct {
        fn less(_: void, x: caps.Operation, y: caps.Operation) bool {
            return std.mem.order(u8, x.name, y.name) == .lt;
        }
    }.less);
    for (operations[1..@max(operations.len, 1)], 0..) |op, i| if (std.mem.eql(u8, op.name, operations[i].name)) return .invalid_value;
    const shape: caps.Capability = .{ .name = name, .operations = operations };
    if (!shape.validScopes() or shape.segmentBound() != (coordinator_of != null)) return .invalid_value;
    const d = gpa.create(caps.Capability) catch return .out_of_memory;
    d.* = .{ .name = gpa.dupe(u8, name) catch {
        gpa.destroy(d);
        return .out_of_memory;
    }, .operations = operations, .coordinator_of = coordinator_of, .release = release };
    c.definitions.append(gpa, d) catch {
        gpa.free(d.name);
        gpa.destroy(d);
        return .out_of_memory;
    };
    out.* = d;
    return .ok;
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
    try expectHeaderEnum(Verdict, "talk_verdict", "TALK_");
    try expectHeaderEnum(Outcome, "talk_outcome", "TALK_");
    try expectHeaderEnum(EffectStatus, "talk_effect_status", "TALK_EFFECT_");
    try expectHeaderEnum(ReleaseReason, "talk_release_reason", "TALK_RELEASE_");
    try expectHeaderEnum(ReportKind, "talk_report_kind", "TALK_REPORT_");
    try expectHeaderEnum(RunStatus, "talk_run_status", "TALK_");
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

test "ordinary C Pumps reject backwards seconds and microseconds" {
    const core = talk_new().?;
    defer talk_core_release(core);
    var group: ?*Group = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &GroupOptions{ .name = null, .name_len = 0, .trace = null, .trace_context = null }, &group));
    defer talk_group_release(group);
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, -62135596800, 0, null, null));
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, 2, 2, null, null));
    try std.testing.expectEqual(HostErrorCode.clock_backwards, talk_pump(group.?, 1, 2, null, null));
    try std.testing.expectEqual(HostErrorCode.clock_backwards, talk_pump(group.?, 2, 1, null, null));
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, 2, 2, null, null));
}

test "load honours the supported profile and refuses larger limits without taking a name" {
    const core = talk_new().?;
    defer talk_core_release(core);
    inline for (@typeInfo(Limits).@"struct".field_names, 0..) |name, i| {
        const minimum = limits_table.limit[i].minimum;
        for ([_]i64{ -1, minimum + 1, std.math.maxInt(i64), 0, 1, minimum }) |value| {
            var group: ?*Group = null;
            const options: GroupOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null };
            try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &options, &group));
            defer talk_group_release(group);
            var limits: Limits = .{};
            @field(limits, name) = value;
            const source = "on ping\nend ping\n";
            var load: LoadOptions = .{ .name = "s", .name_len = 1, .source = source.ptr, .source_len = source.len, .limits = &limits };
            var script: ?*Script = null;
            if (value < 0 or value > minimum) {
                const before = group.?.memory.used;
                try std.testing.expectEqual(HostErrorCode.invalid_value, talk_load(group.?, &load, &script));
                try std.testing.expectEqual(@as(?*Script, null), script);
                try std.testing.expectEqual(before, group.?.memory.used);
                try std.testing.expect(!group.?.memory.refused);
                load.limits = null;
            }
            try std.testing.expectEqual(HostErrorCode.ok, talk_load(group.?, &load, &script));
            try std.testing.expect(script != null);
        }
    }
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

pub const ScopeDecl = extern struct { opens: ?[*]const u8, opens_len: usize, abandon: ?[*]const u8, abandon_len: usize, closes: ?[*]const u8, closes_len: usize };

pub const Call = caps.Call;

pub const ScriptError = extern struct { code: ?[*]const u8, code_len: usize, message: ?[*]const u8, message_len: usize, data: ?*Value };

export fn talk_script_error_error(e: *const ScriptError, out: *Buffer) HostErrorCode {
    return errorText(out, bytes(e.code, e.code_len) catch return .invalid_value, if (e.message) |m| m[0..e.message_len] else "");
}

/// `a + b` outside any Run, on a Group of its own that runs nothing.
export fn talk_add(a: *const Value, b: *const Value, out: *?*Value, err: *ScriptError) HostErrorCode {
    out.* = null;
    err.* = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    var g = machine.Group.init(allocator, null);
    defer g.deinit();
    out.* = g.arithmetic(.add, @constCast(a), @constCast(b)) catch |e| {
        if (e != error.Raised) return status(e);
        const f = g.takeFailure() catch |taken| return status(taken);
        err.* = .{ .code = f.code.ptr, .code_len = f.code.len, .message = f.message.ptr, .message_len = f.message.len, .data = f.data };
        return .script_failed;
    };
    return .ok;
}

export fn talk_script_error_release(e: *ScriptError) void {
    if (e.message) |m| allocator.free(m[0..e.message_len]);
    if (e.data) |d| d.release();
    e.* = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
}

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
    scope: ?*const ScopeDecl,
    segment_bound: bool,
    metering: ?[*]const u8 = null,
    metering_len: usize = 0,
    description: ?[*]const u8 = null,
    description_len: usize = 0,
    examples: ?[*]const ?[*]const u8 = null,
    examples_lens: ?[*]const usize = null,
    examples_len: usize = 0,
    command: bool = false,
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
    switch (op.scope) {
        .none => {},
        .opens => |o| {
            gpa.free(o.name);
            gpa.free(o.abandon);
        },
        .closes => |n| gpa.free(n),
    }
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
    gpa.free(op.description);
    for (op.examples) |e| gpa.free(e);
    gpa.free(op.examples);
}

fn operationOf(c: *Core, o: Operation) !caps.Operation {
    const gpa = c.gpa;
    const name = try bytes(o.name, o.name_len);
    for ([_][]const u8{ "ask", "tell", "send", "wait", "end" }) |refused| if (std.mem.eql(u8, name, refused)) return error.InvalidValue;
    if (name.len == 0) return error.InvalidValue;
    const call = o.@"fn" orelse return error.InvalidValue;
    if (o.cost.fuel < 0 or o.cost.alloc < 0) return error.InvalidValue;
    const scope: caps.Scope = if (o.scope) |d| blk: {
        if (d.closes != null) {
            if (d.opens != null or d.abandon != null) return error.InvalidValue;
            break :blk .{ .closes = try bytes(d.closes, d.closes_len) };
        }
        if (d.opens == null or d.abandon == null) return error.InvalidValue;
        break :blk .{ .opens = .{ .name = try bytes(d.opens, d.opens_len), .abandon = try bytes(d.abandon, d.abandon_len) } };
    } else .none;
    const args_in: []const *const Shape = if (o.args_len == 0) &.{} else (o.args orelse return error.InvalidValue)[0..o.args_len];
    const errors_in: []const ErrorDecl = if (o.errors_len == 0) &.{} else (o.errors orelse return error.InvalidValue)[0..o.errors_len];
    const metering: ?caps.Metering = if (o.metering == null and o.metering_len == 0) null else blk: {
        const m = try bytes(o.metering, o.metering_len);
        if (std.mem.eql(u8, m, "read-only")) break :blk .read_only;
        if (std.mem.eql(u8, m, "segment-bound")) break :blk .segment_bound;
        return error.InvalidValue;
    };
    const bridge = try gpa.create(Bridge);
    bridge.* = .{ .call = call, .context = o.context };
    c.bridges.append(gpa, bridge) catch |err| {
        gpa.destroy(bridge);
        return err;
    };
    const args = try gpa.alloc(*Shape, args_in.len);
    for (args_in, args) |x, *y| y.* = retained(x);
    const description = try gpa.dupe(u8, try bytes(o.description, o.description_len));
    var examples: std.ArrayList([]const u8) = .empty;
    if (o.examples_len > 0) {
        const texts = o.examples orelse return error.InvalidValue;
        const lens = o.examples_lens orelse return error.InvalidValue;
        for (0..o.examples_len) |i| try examples.append(gpa, try gpa.dupe(u8, try bytes(texts[i], lens[i])));
    }
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
        .scope = switch (scope) {
            .none => .none,
            .opens => |x| .{ .opens = .{ .name = try gpa.dupe(u8, x.name), .abandon = try gpa.dupe(u8, x.abandon) } },
            .closes => |n| .{ .closes = try gpa.dupe(u8, n) },
        },
        .segment_bound = o.segment_bound,
        .command = o.command,
        .metering = metering,
        .description = description,
        .examples = try examples.toOwnedSlice(gpa),
        .host = .{ .call = bridged, .context = bridge },
    };
}

export fn talk_define_capability(c: *Core, name: ?[*]const u8, len: usize, ops: ?[*]const Operation, ops_len: usize, options: ?[*]const CapabilityOption, options_len: usize, out: *?*caps.Capability) HostErrorCode {
    return defineCapability(c, name, len, ops, ops_len, options, options_len, null, out);
}

export fn talk_define_segment_capability(c: *Core, name: ?[*]const u8, len: usize, ops: ?[*]const Operation, ops_len: usize, lifecycle: ?*const SegmentLifecycle, options: ?[*]const CapabilityOption, options_len: usize, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const l = lifecycle orelse return .invalid_value;
    if (l.begin == null or l.commit == null or l.rollback == null) return .invalid_value;
    return defineCapability(c, name, len, ops, ops_len, options, options_len, .{ .call = ownCoordinator, .context = @constCast(l) }, out);
}

export fn talk_define_coordinated_capability(c: *Core, name: ?[*]const u8, len: usize, ops: ?[*]const Operation, ops_len: usize, coordinator: ?CoordinatorFn, context: ?*anyopaque, options: ?[*]const CapabilityOption, options_len: usize, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const f = coordinator orelse return .invalid_value;
    const m = c.gpa.create(Mapping) catch return .out_of_memory;
    m.* = .{ .call = f, .context = context };
    c.mappings.append(c.gpa, m) catch {
        c.gpa.destroy(m);
        return .out_of_memory;
    };
    return defineCapability(c, name, len, ops, ops_len, options, options_len, .{ .call = mappedCoordinator, .context = m }, out);
}

pub const ReleaseReason = enum(c_int) { stop, reload, revoke, disable };
pub const GrantContext = extern struct {
    group: ?*Group,
    script_name: [*]const u8,
    script_name_len: usize,
    grant_name: [*]const u8,
    grant_name_len: usize,
    binding: ?*anyopaque,
    now_seconds: i64,
    now_micros: i32,
    reason: ReleaseReason,
};
pub const ReleaseHook = *const fn (context: ?*anyopaque, g: *const GrantContext) callconv(.c) void;

/// A Host release hook and its context, which the Core owns.
pub const Releasing = struct { hook: ReleaseHook, context: ?*anyopaque };

fn releaseHook(context: ?*anyopaque, g: *const caps.GrantContext) void {
    const r: *const Releasing = @ptrCast(@alignCast(context.?));
    const machine_group: ?*machine.Group = @ptrCast(@alignCast(g.group));
    r.hook(r.context, &.{
        .group = if (machine_group) |mg| @fieldParentPtr("group", mg) else null,
        .script_name = g.script.ptr,
        .script_name_len = g.script.len,
        .grant_name = g.grant.ptr,
        .grant_name_len = g.grant.len,
        .binding = g.binding,
        .now_seconds = g.now.seconds,
        .now_micros = g.now.micros,
        .reason = switch (g.reason) {
            inline else => |x| @field(ReleaseReason, @tagName(x)),
        },
    });
}

/// Gives a Capability its release hook, before any Grant is made from it.
fn setRelease(c: *Core, def: *caps.Capability, hook: ReleaseHook, context: ?*anyopaque) HostErrorCode {
    if (def.release != null or def.grants.items.len > 0) return .invalid_value;
    const r = c.gpa.create(Releasing) catch return .out_of_memory;
    r.* = .{ .hook = hook, .context = context };
    c.releases.append(c.gpa, r) catch {
        c.gpa.destroy(r);
        return .out_of_memory;
    };
    def.release = .{ .call = releaseHook, .context = r };
    return .ok;
}

pub const CapabilityOption = extern struct { release_hook: ?ReleaseHook, release_context: ?*anyopaque };

export fn talk_with_release_hook(hook: ?ReleaseHook, context: ?*anyopaque) CapabilityOption {
    return .{ .release_hook = hook, .release_context = context };
}

/// Non-exhaustive: a malformed status from the Host is `unknown`.
pub const EffectStatus = enum(c_int) { ok, failed, unknown, _ };
pub const EffectResult = extern struct { status: EffectStatus, detail: ?[*]const u8, detail_len: usize };
pub const SegmentContext = extern struct {
    group: ?*Group,
    script_name: [*]const u8,
    script_name_len: usize,
    run_id: [*]const u8,
    run_id_len: usize,
    grant_name: [*]const u8,
    grant_name_len: usize,
    segment_id: [*]const u8,
    segment_id_len: usize,
    binding: ?*anyopaque,
    now_seconds: i64,
    now_micros: i32,
    grants: [*]const caps.SegmentGrant,
    grants_len: usize,
};
pub const SegmentHook = *const fn (context: ?*anyopaque, s: *const SegmentContext) callconv(.c) EffectResult;
pub const SegmentLifecycle = extern struct { begin: ?SegmentHook, commit: ?SegmentHook, rollback: ?SegmentHook, context: ?*anyopaque };
pub const CoordinatorFn = *const fn (context: ?*anyopaque, binding: ?*anyopaque) callconv(.c) ?*const SegmentLifecycle;

/// A coordinated Capability's mapping from a binding to its coordinator.
pub const Mapping = struct { call: CoordinatorFn, context: ?*anyopaque };

/// Each Grant is its own coordinator, with the Capability's hooks.
fn ownCoordinator(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    return .{ .identity = @intFromPtr(g), .hook = segmentHook, .context = context };
}

/// The Host maps the Grant's binding to a coordinator, compared by address.
fn mappedCoordinator(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    const m: *const Mapping = @ptrCast(@alignCast(context.?));
    const l = m.call(m.context, g.binding) orelse return null;
    if (l.begin == null or l.commit == null or l.rollback == null) return null;
    return .{ .identity = @intFromPtr(l), .hook = segmentHook, .context = @constCast(l) };
}

fn segmentHook(context: ?*anyopaque, phase: caps.Phase, s: *const caps.SegmentContext) caps.EffectStatus {
    const l: *const SegmentLifecycle = @ptrCast(@alignCast(context.?));
    const hook = switch (phase) {
        .begin => l.begin,
        .commit => l.commit,
        .rollback => l.rollback,
    }.?;
    const machine_group: ?*machine.Group = @ptrCast(@alignCast(s.group));
    const ctx: SegmentContext = .{
        .group = if (machine_group) |mg| @fieldParentPtr("group", mg) else null,
        .script_name = s.script.ptr,
        .script_name_len = s.script.len,
        .run_id = s.run.ptr,
        .run_id_len = s.run.len,
        .grant_name = s.grant.ptr,
        .grant_name_len = s.grant.len,
        .segment_id = s.segment.ptr,
        .segment_id_len = s.segment.len,
        .binding = s.binding,
        .now_seconds = s.now.seconds,
        .now_micros = s.now.micros,
        .grants = s.grants.ptr,
        .grants_len = s.grants.len,
    };
    return switch (hook(l.context, &ctx).status) {
        .ok => .ok,
        .failed => .failed,
        .unknown, _ => .unknown,
    };
}

fn defineCapability(c: *Core, name: ?[*]const u8, len: usize, ops: ?[*]const Operation, ops_len: usize, options: ?[*]const CapabilityOption, options_len: usize, coordinator_of: ?caps.CoordinatorOf, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const gpa = c.gpa;
    const n = bytes(name, len) catch return .invalid_value;
    if (n.len == 0) return .invalid_value;
    // At most one release hook.
    const chosen: []const CapabilityOption = if (options_len == 0) &.{} else (options orelse return .invalid_value)[0..options_len];
    var hook: ?CapabilityOption = null;
    for (chosen) |o| {
        if (o.release_hook == null or hook != null) return .invalid_value;
        hook = o;
    }
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
    const shape: caps.Capability = .{ .name = n, .operations = operations };
    // Segment-bound Operations need Segment Coordinators.
    if (!shape.validScopes() or shape.segmentBound() != (coordinator_of != null)) {
        for (operations) |done| releaseOperation(gpa, done);
        gpa.free(operations);
        return .invalid_value;
    }
    const d = gpa.create(caps.Capability) catch return .out_of_memory;
    d.* = .{ .name = gpa.dupe(u8, n) catch return .out_of_memory, .operations = operations, .coordinator_of = coordinator_of };
    c.definitions.append(gpa, d) catch return .out_of_memory;
    if (hook) |h| {
        const code = setRelease(c, d, h.release_hook.?, h.release_context);
        if (code != .ok) return code;
    }
    out.* = d;
    return .ok;
}

export fn talk_capability_def_name(d: *const caps.Capability, s: *[*]const u8, len: *usize) void {
    s.* = d.name.ptr;
    len.* = d.name.len;
}

export fn talk_capability_def_checks(d: *const caps.Capability, out: ?[*]OperationCheck, cap: usize) usize {
    if (out) |checks| for (d.operations[0..@min(cap, d.operations.len)], checks) |op, *x| {
        x.* = .{ .name = op.name.ptr, .name_len = op.name.len, .mode = switch (op.mode) {
            .immediate => .immediate,
            .suspending => .suspending,
            .fire_and_forget => .fire_and_forget,
        }, .args = @ptrCast(op.args.ptr), .args_len = op.args.len, .command = op.command };
    };
    return d.operations.len;
}

/// A Grant, which its definition owns.
fn grantOf(d: *caps.Capability, kept: []bool, binding: ?*anyopaque, out: *?*caps.Grant) HostErrorCode {
    const g = allocator.create(caps.Grant) catch {
        allocator.free(kept);
        return .out_of_memory;
    };
    g.* = .{ .capability = d, .operations = kept, .binding = binding };
    if (d.coordinator_of) |of| g.coordinator = of.call(of.context, g) orelse {
        allocator.free(kept);
        allocator.destroy(g);
        return .invalid_value;
    };
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
    if (!d.keepsAbandonment(kept)) {
        allocator.free(kept);
        return .invalid_value;
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
export fn talk_call_now(c: *const Call, seconds: *i64, micros: *i32) void {
    seconds.* = c.now.seconds;
    micros.* = c.now.micros;
}
export fn talk_call_run_id(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.run.ptr;
    len.* = c.run.len;
}
export fn talk_call_segment_id(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.segment.ptr;
    len.* = c.segment.len;
}
export fn talk_call_scope_name(c: *const Call, s: *[*]const u8, len: *usize) void {
    s.* = c.scope.ptr;
    len.* = c.scope.len;
}
/// The Group that made the call.
pub export fn talk_call_group(c: *const Call) ?*Group {
    const g: *machine.Group = @ptrCast(@alignCast(c.owner orelse c.group orelse return null));
    return @fieldParentPtr("group", g);
}

export fn talk_call_automatic(c: *const Call) bool {
    return c.automatic;
}
export fn talk_call_context(c: *const Call) bool {
    return c.abandoned.load(.acquire);
}
export fn talk_call_charge(c: *Call, fuel: i64) HostErrorCode {
    if (fuel < 0 or fuel > 9_007_199_254_740_991) return .invalid_value;
    return if (c.charge(@intCast(fuel))) .ok else .err_limit;
}

// ---------------------------------------------------------------- Standard Capabilities

pub const NamedCost = extern struct { name: ?[*]const u8, name_len: usize, cost: Cost };
pub const Costs = extern struct { entries: ?[*]const NamedCost, len: usize };
pub const CalendarImpl = extern struct { context: ?*anyopaque, today: OperationFn, now: OperationFn, to_civil: OperationFn, to_instant: OperationFn, offset: OperationFn, zone: OperationFn };
pub const LocaleImpl = extern struct { context: ?*anyopaque, compare: OperationFn, rank: OperationFn, upper: OperationFn, lower: OperationFn, number_symbols: OperationFn, month_names: OperationFn, day_names: OperationFn, tag: OperationFn };
pub const TimerImpl = extern struct { context: ?*anyopaque, schedule: OperationFn, cancel: OperationFn };
pub const ConsoleImpl = extern struct { context: ?*anyopaque, write: OperationFn, read: OperationFn };
pub const UserImpl = extern struct { context: ?*anyopaque, confirm: OperationFn, choose: OperationFn, enter: OperationFn, notify: OperationFn };

/// The largest cost component: 2^53 - 1.
const max_cost = 9_007_199_254_740_991;

/// Defines a Standard Capability from a cost per Operation and one C Host
/// function per Operation, in `standard.operations` order.
fn defineStandard(c: *Core, which: standard.Which, fns: []const OperationFn, context: ?*anyopaque, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandardWith(c, which, fns, &.{}, context, costs, null, out);
}

/// `own` gives a Core Host function for an Operation in place of the
/// bridged C one, by position.
fn defineStandardWith(c: *Core, which: standard.Which, fns: []const OperationFn, own: []const ?caps.HostFn, context: ?*anyopaque, costs: ?*const Costs, coordinator_of: ?caps.CoordinatorOf, out: *?*caps.Capability) HostErrorCode {
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
        if (i < own.len) if (own[i]) |h| {
            impl[i] = h;
            continue;
        };
        const call = f orelse return .invalid_value;
        const bridge = gpa.create(Bridge) catch return .out_of_memory;
        bridge.* = .{ .call = call, .context = context };
        c.bridges.append(gpa, bridge) catch {
            gpa.destroy(bridge);
            return .out_of_memory;
        };
        impl[i] = .{ .call = bridged, .context = bridge };
    }
    const d = standard.define(gpa, which, impl[0..names.len], per[0..names.len], &c.standard, coordinator_of) catch return .out_of_memory;
    c.definitions.append(gpa, d) catch return .out_of_memory;
    out.* = d;
    return .ok;
}

/// Defines a Standard Capability for the Message Layer, each Operation's
/// Host function a Core Zig function from `own`, in name order; `clock`
/// takes none.
pub fn defineStandardZig(c: *Core, which: standard.Which, own: []const ?caps.HostFn, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandardZigWith(c, which, own, costs, null, null, out);
}

/// `defineStandardZig` with `store`'s Segment Coordinator mapping and a
/// Grant release hook, both the Core's own Zig functions.
pub fn defineStandardZigWith(c: *Core, which: standard.Which, own: []const ?caps.HostFn, costs: ?*const Costs, coordinator_of: ?caps.CoordinatorOf, release: ?caps.ReleaseHook, out: *?*caps.Capability) HostErrorCode {
    const none: [8]OperationFn = @splat(null);
    const code = defineStandardWith(c, which, none[0..own.len], own, null, costs, coordinator_of, out);
    if (code != .ok) return code;
    out.*.?.release = release;
    return .ok;
}

pub const StandardWhich = standard.Which;
pub const standardOperations = standard.operations;

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

export fn talk_timer_capability(c: *Core, impl: *const TimerImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandard(c, .timer, &.{ impl.cancel, impl.schedule }, impl.context, costs, out);
}

export fn talk_user_capability(c: *Core, impl: *const UserImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    // In name order: choose, confirm, enter, notify.
    return defineStandard(c, .user, &.{ impl.choose, impl.confirm, impl.enter, impl.notify }, impl.context, costs, out);
}

export fn talk_console_capability(c: *Core, impl: *const ConsoleImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return defineStandard(c, .console, &.{ impl.read, impl.write }, impl.context, costs, out);
}

pub const StoreImpl = extern struct {
    context: ?*anyopaque,
    get: OperationFn,
    set: OperationFn,
    del: OperationFn,
    keys: OperationFn,
    increment: OperationFn,
    swap: OperationFn,
    watch: OperationFn,
    unwatch: OperationFn,
    coordinator: SegmentLifecycle,
    /// Optional.
    release: ?ReleaseHook,
};

/// Every `store` binding maps to the implementation's one coordinator.
fn storeCoordinator(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    _ = g;
    return .{ .identity = @intFromPtr(context.?), .hook = segmentHook, .context = context };
}

/// The Core's own copy of a store coordinator, whose address is its
/// identity: one for each distinct set of hooks and context.
fn storeLifecycle(c: *Core, hooks: SegmentLifecycle) error{ InvalidValue, OutOfMemory }!*SegmentLifecycle {
    if (hooks.begin == null or hooks.commit == null or hooks.rollback == null) return error.InvalidValue;
    for (c.lifecycles.items) |l| if (l.begin == hooks.begin and l.commit == hooks.commit and l.rollback == hooks.rollback and l.context == hooks.context) return l;
    const lifecycle = try c.gpa.create(SegmentLifecycle);
    lifecycle.* = hooks;
    c.lifecycles.append(c.gpa, lifecycle) catch |err| {
        c.gpa.destroy(lifecycle);
        return err;
    };
    return lifecycle;
}

export fn talk_store_coordinator(c: *Core, impl: *const StoreImpl) ?*const SegmentLifecycle {
    return storeLifecycle(c, impl.coordinator) catch null;
}

export fn talk_store_capability(c: *Core, impl: *const StoreImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    const lifecycle = storeLifecycle(c, impl.coordinator) catch |err| return status(err);
    // In name order: delete, get, increment, keys, set, swap, unwatch, watch.
    const code = defineStandardWith(c, .store, &.{ impl.del, impl.get, impl.increment, impl.keys, impl.set, impl.swap, impl.unwatch, impl.watch }, &.{}, impl.context, costs, .{ .call = storeCoordinator, .context = lifecycle }, out);
    if (code != .ok) return code;
    const hook = impl.release orelse return .ok;
    const released = setRelease(c, out.*.?, hook, impl.context);
    if (released != .ok) out.* = null;
    return released;
}

pub const BeforeStep = *const fn (context: ?*anyopaque) callconv(.c) HostErrorCode;

pub const SqlFn = *const fn (context: ?*anyopaque, call: *Call, sql: [*]const u8, sql_len: usize, params: *const sqlite.Params, max: i64, before_step: BeforeStep, step_context: ?*anyopaque, rows: *sqlite.Rows, err: *ScriptError) callconv(.c) CallEnd;
pub const SqliteImpl = extern struct {
    context: ?*anyopaque,
    coordinator: ?*const fn (context: ?*anyopaque, database: [*]const u8, len: usize) callconv(.c) ?*const SegmentLifecycle,
    query: ?SqlFn,
    change: ?SqlFn,
    begin: OperationFn,
    commit: OperationFn,
    rollback: OperationFn,
    release_rows: ?*const fn (context: ?*anyopaque, rows: *sqlite.Rows) callconv(.c) void,
};

/// A `query` or `change` Host function: the implementation, the per-step
/// cost, and which it is.
const SqlBridge = struct { impl: SqliteImpl, per_step: u64, change: bool };

const StepCharge = struct { call: *Call, fuel: u64 };
fn beforeStep(context: ?*anyopaque) callconv(.c) HostErrorCode {
    const step: *StepCharge = @ptrCast(@alignCast(context.?));
    return if (step.call.charge(step.fuel)) .ok else .err_limit;
}

/// The factory supplies authorization before each driver-owned step.
fn sqlCall(context: ?*anyopaque, call: *Call, args: []const *Value) caps.Outcome {
    const b: *const SqlBridge = @ptrCast(@alignCast(context.?));
    const binding = sqlite.bindingOf(call.binding) orelse return .broken;
    const max = sqlite.effectiveMax(args, binding);
    var step: StepCharge = .{ .call = call, .fuel = b.per_step };
    var arena: std.heap.ArenaAllocator = .init(call.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const params = sqlite.params(a, args[1]) catch return .broken;
    var rows: sqlite.Rows = .{};
    var failure: ScriptError = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    const f = (if (b.change) b.impl.change else b.impl.query).?;
    const sql = args[0].data.text;
    switch (f(b.impl.context, call, sql.ptr, sql.len, &params, @intCast(max), beforeStep, &step, &rows, &failure)) {
        .answered => {
            defer if (b.impl.release_rows) |release| release(b.impl.context, &rows);
            return switch (sqlite.convert(call.gpa, a, rows, max, b.change) catch return .broken) {
                .value => |v| .{ .value = v },
                .broken => .broken,
                .failed => |x| blk: {
                    const text = model.text(call.gpa, x.text) catch break :blk .broken;
                    defer text.release();
                    const data = model.map(call.gpa, &.{.{ .key = x.key, .value = text }}) catch break :blk .broken;
                    const code = call.gpa.dupe(u8, x.code) catch {
                        data.release();
                        break :blk .broken;
                    };
                    break :blk .{ .failed = .{ .code = code, .message = null, .data = data } };
                },
            };
        },
        .failed => return failedOutcome(call, failure),
        .limited => return .limited,
        .broken, .started => return .broken,
    }
}

/// A Host function's Script error as an Outcome, its code and message
/// copied.
fn failedOutcome(call: *Call, failure: ScriptError) caps.Outcome {
    const code = bytes(failure.code, failure.code_len) catch return .broken;
    const message = bytes(failure.message, failure.message_len) catch return .broken;
    const owned_code = call.gpa.dupe(u8, code) catch return .broken;
    const owned_message: ?[]const u8 = if (failure.message == null) null else call.gpa.dupe(u8, message) catch {
        call.gpa.free(owned_code);
        return .broken;
    };
    return .{ .failed = .{ .code = owned_code, .message = owned_message, .data = failure.data } };
}

/// Each `sqlite` Grant's coordinator: its binding's database's, which the
/// implementation gives; a malformed binding refuses the Grant.
fn sqliteCoordinator(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    const impl: *const SqliteImpl = @ptrCast(@alignCast(context.?));
    const binding = sqlite.bindingOf(g.binding) orelse return null;
    if (!sqlite.validBinding(binding)) return null;
    const database: [*]const u8 = binding.database orelse "";
    const l = impl.coordinator.?(impl.context, database, binding.database_len) orelse return null;
    if (l.begin == null or l.commit == null or l.rollback == null) return null;
    return .{ .identity = @intFromPtr(l), .hook = segmentHook, .context = @constCast(l) };
}

export fn talk_sqlite_capability(c: *Core, impl: *const SqliteImpl, costs: ?*const Costs, per_step: i64, out: *?*caps.Capability) HostErrorCode {
    return sqliteCapability(c, impl, costs, per_step, true, out);
}

/// The executable corpus still specifies perRow until every Core migrates.
/// Its C replay uses this compatibility factory, never Core internals.
export fn talk_sqlite_legacy_capability(c: *Core, impl: *const SqliteImpl, costs: ?*const Costs, out: *?*caps.Capability) HostErrorCode {
    return sqliteCapability(c, impl, costs, 0, false, out);
}

fn sqliteCapability(c: *Core, impl: *const SqliteImpl, costs: ?*const Costs, per_step: i64, metered: bool, out: *?*caps.Capability) HostErrorCode {
    out.* = null;
    if (per_step < 0 or per_step > sqlite.max_whole) return .invalid_value;
    if (impl.coordinator == null or impl.query == null or impl.change == null) return .invalid_value;
    const gpa = c.gpa;
    const kept = gpa.create(SqliteImpl) catch return .out_of_memory;
    kept.* = impl.*;
    c.sqlite_impls.append(gpa, kept) catch {
        gpa.destroy(kept);
        return .out_of_memory;
    };
    var own: [5]?caps.HostFn = @splat(null);
    // In name order: begin, change, commit, query, rollback.
    for ([_]usize{ 1, 3 }) |i| {
        const bridge = gpa.create(SqlBridge) catch return .out_of_memory;
        bridge.* = .{ .impl = impl.*, .per_step = @intCast(per_step), .change = i == 1 };
        c.sql_bridges.append(gpa, bridge) catch {
            gpa.destroy(bridge);
            return .out_of_memory;
        };
        own[i] = .{ .call = sqlCall, .context = bridge };
    }
    const defined = defineStandardWith(c, .sqlite, &.{ impl.begin, null, impl.commit, null, impl.rollback }, &own, impl.context, costs, .{ .call = sqliteCoordinator, .context = kept }, out);
    if (defined == .ok and metered) {
        out.*.?.operations[1].metering = .segment_bound;
        out.*.?.operations[3].metering = .read_only;
    }
    return defined;
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

pub const ElementCountFn = ?*const fn (context: ?*anyopaque, o: *objects.Object, result: *?*Value, err: *ScriptError) callconv(.c) CallEnd;
pub const ElementAtFn = ?*const fn (context: ?*anyopaque, o: *objects.Object, index: i64, result: *?*Value, err: *ScriptError) callconv(.c) CallEnd;
pub const ElementFindFn = ?*const fn (context: ?*anyopaque, o: *objects.Object, name: [*]const u8, name_len: usize, result: *?*Value, err: *ScriptError) callconv(.c) CallEnd;

/// An Object Kind's Object Collection (#1143).
pub const ObjectElements = extern struct {
    shape: ?*const Shape,
    count: ElementCountFn,
    at: ElementAtFn,
    find: ElementFindFn,
    context: ?*anyopaque,
    count_cost: Cost,
    at_cost: Cost,
    find_cost: Cost,
};

pub const ObjectKindDef = extern struct {
    name: ?[*]const u8,
    name_len: usize,
    props: ?[*]const Prop,
    props_len: usize,
    parent_kinds: ?[*]const ?[*]const u8,
    parent_kinds_lens: ?[*]const usize,
    parent_kinds_len: usize,
    elements: ?*const ObjectElements,
};

/// A C collection's callbacks and their context, behind the Core's.
pub const ElementsBridge = struct {
    count: *const fn (?*anyopaque, *objects.Object, *?*Value, *ScriptError) callconv(.c) CallEnd,
    at: *const fn (?*anyopaque, *objects.Object, i64, *?*Value, *ScriptError) callconv(.c) CallEnd,
    find: *const fn (?*anyopaque, *objects.Object, [*]const u8, usize, *?*Value, *ScriptError) callconv(.c) CallEnd,
    context: ?*anyopaque,
};

// Each answers with an owned result, Nothing included: an answer without
// one is a host error.
fn elementResult(gpa: std.mem.Allocator, end: CallEnd, value: ?*Value, failure: ScriptError) objects.Result {
    const r = propResult(gpa, end, value, failure);
    return if (r == .done) .broken else r;
}

const no_failure: ScriptError = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };

fn elementCount(context: ?*anyopaque, gpa: std.mem.Allocator, o: *objects.Object) objects.Result {
    const b: *ElementsBridge = @ptrCast(@alignCast(context.?));
    var value: ?*Value = null;
    var failure = no_failure;
    const end = b.count(b.context, o, &value, &failure);
    return elementResult(gpa, end, value, failure);
}

fn elementAt(context: ?*anyopaque, gpa: std.mem.Allocator, o: *objects.Object, index: i64) objects.Result {
    const b: *ElementsBridge = @ptrCast(@alignCast(context.?));
    var value: ?*Value = null;
    var failure = no_failure;
    const end = b.at(b.context, o, index, &value, &failure);
    return elementResult(gpa, end, value, failure);
}

fn elementFind(context: ?*anyopaque, gpa: std.mem.Allocator, o: *objects.Object, name: []const u8) objects.Result {
    const b: *ElementsBridge = @ptrCast(@alignCast(context.?));
    var value: ?*Value = null;
    var failure = no_failure;
    const end = b.find(b.context, o, name.ptr, name.len, &value, &failure);
    return elementResult(gpa, end, value, failure);
}

fn validCost(cost: Cost) bool {
    return cost.fuel >= 0 and cost.alloc >= 0;
}

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
    // Its collection's metadata is copied here; a later change to `def`
    // changes nothing.
    var elements: ?objects.Elements = null;
    if (def.elements) |e| {
        const shape = e.shape orelse return .invalid_value;
        if (e.count == null or e.at == null or e.find == null) return .invalid_value;
        if (!validCost(e.count_cost) or !validCost(e.at_cost) or !validCost(e.find_cost)) return .invalid_value;
        if (!objects.validElementShape(shape)) return .invalid_value;
        const b = gpa.create(ElementsBridge) catch return .out_of_memory;
        b.* = .{ .count = e.count.?, .at = e.at.?, .find = e.find.?, .context = e.context };
        c.elements_bridges.append(gpa, b) catch {
            gpa.destroy(b);
            return .out_of_memory;
        };
        elements = .{
            .shape = retained(shape),
            .count = elementCount,
            .at = elementAt,
            .find = elementFind,
            .context = b,
            .count_cost = .{ .fuel = @intCast(e.count_cost.fuel), .alloc = @intCast(e.count_cost.alloc) },
            .at_cost = .{ .fuel = @intCast(e.at_cost.fuel), .alloc = @intCast(e.at_cost.alloc) },
            .find_cost = .{ .fuel = @intCast(e.find_cost.fuel), .alloc = @intCast(e.find_cost.alloc) },
        };
    }
    const k = gpa.create(objects.Kind) catch return .out_of_memory;
    k.* = .{ .name = gpa.dupe(u8, name) catch return .out_of_memory, .props = gpa.alloc(objects.Prop, given.len) catch return .out_of_memory, .elements = elements };
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

/// Zig only, for the corpus runner: the Shape of an object of the kind
/// named, which need not be defined yet, as a collection's own kind isn't.
pub fn objectShapeNamed(name: []const u8) !*Shape {
    return Shape.objectOf(allocator, name);
}

export fn talk_object_shape(k: *const objects.Kind, out: *?*Shape) HostErrorCode {
    return shapeResult(out, Shape.objectOf(allocator, k.name));
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

export fn talk_script_revoke(s: *Script, name: ?[*]const u8, len: usize) HostErrorCode {
    const g = s.group;
    if (g.memory.refused) return .out_of_memory;
    const n = bytes(name, len) catch return .invalid_value;
    g.group.revoke(s.name, n) catch |err| return status(err);
    return .ok;
}

export fn talk_script_stop(s: *Script, reason: ?[*]const u8, len: usize) HostErrorCode {
    const g = s.group;
    if (g.memory.refused) return .out_of_memory;
    const why = bytes(reason, len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(why)) return .invalid_value;
    g.group.stopInput(s.name, why) catch |err| return status(err);
    return .ok;
}

/// talk.h's `talk_carry_over`.
pub const CarryOver = enum(c_int) { reset_variables, carry_variables };

pub const ReloadOptions = extern struct { keep_mailbox: bool };

/// Stop-and-reload, a worker call: refused with the Script unchanged, or
/// stopped and replaced, its `stopped` report in the Trace.
export fn talk_script_reload(s: *Script, source: ?[*]const u8, len: usize, carry: CarryOver, o: ?*const ReloadOptions, reports: ?*?*Reports) HostErrorCode {
    if (reports) |r| r.* = null;
    const g = s.group;
    g.group.checkWorker() catch |err| {
        const src = bytes(source, len) catch return status(err);
        const script = g.group.script(s.name) orelse return status(err);
        g.group.refuseWorker(.{ .reload = .{ .script = script, .source = src, .carry = carry == .carry_variables, .keep_mailbox = if (o) |x| x.keep_mailbox else false } });
        g.flush();
        return status(err);
    };
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    defer giveReports(g, reports);
    const src = bytes(source, len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(src)) return .invalid_value;
    const script = g.group.script(s.name) orelse return .invalid_value;
    const keep = if (o) |x| x.keep_mailbox else false;
    var reloaded = g.group.reload(script, src, carry == .carry_variables, keep) catch |err| return status(err);
    while (reloaded == .paused) reloaded = (g.group.resumeWork() catch |err| return status(err)).reload;
    return switch (reloaded) {
        .paused => unreachable,
        .reloaded => .ok,
        .refused => .load_refused,
        .state_too_large => .state_too_large,
        .stopped => .effect_state_unknown,
    };
}

/// Extend Script, a worker call: the Entry is a new code unit of the
/// Script, or it is refused and the Script unchanged.
export fn talk_script_extend(s: *Script, source: ?[*]const u8, len: usize) HostErrorCode {
    const g = s.group;
    g.group.checkWorker() catch |err| {
        const src = bytes(source, len) catch return status(err);
        const script = g.group.script(s.name) orelse return status(err);
        g.group.refuseWorker(.{ .extend = .{ .script = script, .source = src } });
        g.flush();
        return status(err);
    };
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    const src = bytes(source, len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(src)) return .invalid_value;
    const script = g.group.script(s.name) orelse return .invalid_value;
    return switch (g.group.extend(script, src) catch |err| return status(err)) {
        .extended => .ok,
        .refused => .load_refused,
        .name_reused => .name_reused,
        .state_too_large => .state_too_large,
    };
}

/// RewindRun (ADR 0068): a Run still in its first Segment goes back to its
/// message, at the head of its Script's mailbox. Made in a Pump, it lands at
/// its next Host crossing, and that Pump returns `rewound` at once.
export fn talk_script_rewind_run(s: *Script, id: ?[*]const u8, len: usize) HostErrorCode {
    const g = s.group;
    if (g.memory.refused) return .out_of_memory;
    const run = bytes(id, len) catch return .invalid_value;
    g.group.rewindRunInput(run) catch |err| return status(err);
    return .ok;
}

export fn talk_script_cancel_run(s: *Script, id: ?[*]const u8, len: usize) HostErrorCode {
    const g = s.group;
    if (g.memory.refused) return .out_of_memory;
    const run = bytes(id, len) catch return .invalid_value;
    g.group.cancelRunInput(run) catch |err| return status(err);
    return .ok;
}

export fn talk_cancel_delivery(g: *Group, id: ?[*]const u8, len: usize) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    const text = bytes(id, len) catch return .invalid_value;
    // A Broadcast Decision is cancelled by its broadcast id (chapter 11).
    if (text.len < 2 or (text[0] != 'd' and text[0] != 'b')) return .invalid_value;
    const n = std.fmt.parseInt(u64, text[1..], 10) catch return .invalid_value;
    if (n == 0) return .invalid_value;
    const queued = if (text[0] == 'b') g.group.cancelBroadcastInput(n) else g.group.cancelDeliveryInput(n);
    queued catch |err| return status(err);
    return .ok;
}

export fn talk_dispose(g: *Group, o: *objects.Object) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    if (!g.owns(o)) return .wrong_group;
    g.group.dispose(o) catch |err| return status(err);
    return .ok;
}

fn queueTo(g: *Group, to: *objects.Object, m: *const Message, how: Asking, id: ?*Buffer, n_out: *u64) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    if (!g.owns(to)) return .wrong_group;
    const name = bytes(m.name, m.name_len) catch return .invalid_value;
    const args: []const *Value = if (m.args_len == 0) &.{} else (m.args orelse return .invalid_value)[0..m.args_len];
    const override = overrideOf(m.limits) catch {
        g.group.refuseOverride("", .{ .id = 0, .message = name, .args = @constCast(args), .request = how == .request, .decision = how == .decide, .target = to }, refusedOverrideOf(m.limits), "invalid value");
        return .invalid_value;
    };
    if (!machine.hostMessageName(name, args.len)) {
        g.group.refuseDelivery("", .{ .id = 0, .message = name, .args = @constCast(args), .request = how == .request, .decision = how == .decide, .target = to, .limits = override }, "invalid value");
        return .invalid_value;
    }
    const owned = g.core.gpa.alloc(*Value, args.len) catch return .out_of_memory;
    for (owned, args) |*x, v| x.* = v.retain();
    defer g.core.gpa.free(owned);
    g.group.override = override;
    const n = (if (how == .decide) g.group.decideTo(to, name, owned) else g.group.deliverTo(to, name, owned, how == .request)) catch {
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
    return queueTo(g, to, m, .deliver, id, &n);
}

export fn talk_decide(g: *Group, to: *objects.Object, m: *const Message, id: ?*Buffer, out: *?*Deciding) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queueTo(g, to, m, .decide, id, &n);
    if (code != .ok) return code;
    return deciding(g, n, false, out);
}

fn queueBroadcast(g: *Group, m: *const Message, decision: bool, id: ?*Buffer, n_out: *u64) HostErrorCode {
    if (g.memory.refused) return .out_of_memory;
    const name = bytes(m.name, m.name_len) catch return .invalid_value;
    const args: []const *Value = if (m.args_len == 0) &.{} else (m.args orelse return .invalid_value)[0..m.args_len];
    const parsed = overrideOf(m.limits);
    const override = parsed catch null;
    const bad_override = if (parsed) |o| (if (o) |x| x.loosens(.{}) else false) else |_| true;
    if (!machine.hostMessageName(name, args.len) or bad_override) {
        g.group.refuseBroadcast(name, @constCast(args), decision, refusedOverrideOf(m.limits), "invalid value");
        return .invalid_value;
    }
    const owned = g.core.gpa.alloc(*Value, args.len) catch return .out_of_memory;
    for (owned, args) |*x, v| x.* = v.retain();
    defer g.core.gpa.free(owned);
    g.group.override = override;
    const n = g.group.broadcast(name, owned, decision) catch {
        for (owned) |v| v.release();
        return .out_of_memory;
    };
    n_out.* = n;
    if (id) |b| {
        const text = std.fmt.allocPrint(allocator, "b{d}", .{n}) catch return .out_of_memory;
        b.* = .{ .data = text.ptr, .len = text.len };
    }
    return .ok;
}

export fn talk_broadcast(g: *Group, m: *const Message, id: ?*Buffer) HostErrorCode {
    var n: u64 = 0;
    return queueBroadcast(g, m, false, id, &n);
}

export fn talk_decide_broadcast(g: *Group, m: *const Message, id: ?*Buffer, out: *?*Deciding) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queueBroadcast(g, m, true, id, &n);
    if (code != .ok) return code;
    return deciding(g, n, true, out);
}

export fn talk_request(g: *Group, to: *objects.Object, m: *const Message, id: ?*Buffer, out: *?*Pending) HostErrorCode {
    out.* = null;
    var n: u64 = 0;
    const code = queueTo(g, to, m, .request, id, &n);
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
pub const OperationCheck = extern struct { name: ?[*]const u8, name_len: usize, mode: Mode, args: ?[*]const *const Shape, args_len: usize, command: bool = false };
pub const GrantDecls = extern struct { name: ?[*]const u8, name_len: usize, operations: ?[*]const OperationCheck, operations_len: usize };

/// The declarations as the Core reads them, borrowing the caller's bytes and
/// Shapes, in a.
fn grantDecls(a: std.mem.Allocator, given: []const GrantDecls) ![]caps.GrantDecls {
    const out = try a.alloc(caps.GrantDecls, given.len);
    for (given, out) |g, *x| {
        const checks: []const OperationCheck = if (g.operations_len == 0) &.{} else (g.operations orelse return error.InvalidValue)[0..g.operations_len];
        const ops = try a.alloc(caps.OperationCheck, checks.len);
        for (checks, ops) |o, *y| {
            const args: []const *const Shape = if (o.args_len == 0) &.{} else (o.args orelse return error.InvalidValue)[0..o.args_len];
            y.* = .{ .name = try bytes(o.name, o.name_len), .mode = switch (o.mode) {
                .immediate => .immediate,
                .suspending => .suspending,
                .fire_and_forget => .fire_and_forget,
            }, .args = @ptrCast(args), .command = o.command };
        }
        x.* = .{ .name = try bytes(g.name, g.name_len), .operations = ops };
    }
    return out;
}

export fn talk_compile_library(c: *Core, src: *const LibrarySource, imports: ?[*]const *machine.Library, imports_len: usize, declarations: ?[*]const GrantDecls, declarations_len: usize, out: *?*machine.Library, load_error: ?*?*LoadError) HostErrorCode {
    out.* = null;
    if (load_error) |e| e.* = null;
    const name = bytes(src.name, src.name_len) catch return .invalid_value;
    const label = bytes(src.version, src.version_len) catch return .invalid_value;
    const source = bytes(src.source, src.source_len) catch return .invalid_value;
    if (!std.unicode.utf8ValidateSlice(source) or name.len == 0) return .invalid_value;
    const given: []const *machine.Library = if (imports_len == 0) &.{} else (imports orelse return .invalid_value)[0..imports_len];
    const declared: []const GrantDecls = if (declarations_len == 0) &.{} else (declarations orelse return .invalid_value)[0..declarations_len];
    var scratch: std.heap.ArenaAllocator = .init(c.gpa);
    defer scratch.deinit();
    const named = grantDecls(scratch.allocator(), declared) catch |err| return status(err);
    // NULL declares no Grants: a direct Capability call is then unknown.
    const compiled = machine.compileLibrary(c.gpa, name, label, source, given, named) catch |err| return status(err);
    switch (compiled) {
        .refused => |diags| {
            defer c.gpa.free(diags);
            if (load_error) |e| e.* = loadError(name, diags);
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

pub const Diagnostic = extern struct { code: [*]const u8, code_len: usize, message: [*]const u8 = "", message_len: usize = 0, unit: [*]const u8, unit_len: usize, line: i64, col: i64 };
pub const LoadError = extern struct { diagnostics: [*]const Diagnostic, diagnostics_len: usize };

/// A refusal's diagnostics, in an arena the LoadError heads.
const LoadErrorHeld = struct { view: LoadError, arena: std.heap.ArenaAllocator };

fn loadError(unit: []const u8, diags: []const machine.Diagnostic) ?*LoadError {
    const held = allocator.create(LoadErrorHeld) catch return null;
    held.arena = .init(allocator);
    const a = held.arena.allocator();
    const name = a.dupe(u8, unit) catch return null;
    const out = a.alloc(Diagnostic, diags.len) catch return null;
    for (diags, out) |d, *o| {
        const code = a.dupe(u8, d.code) catch return null;
        o.* = .{ .code = code.ptr, .code_len = code.len, .unit = name.ptr, .unit_len = name.len, .line = d.line, .col = d.column };
    }
    held.view = .{ .diagnostics = out.ptr, .diagnostics_len = out.len };
    return &held.view;
}

export fn talk_load_error_release(e: ?*LoadError) void {
    const view = e orelse return;
    const held: *LoadErrorHeld = @fieldParentPtr("view", view);
    held.arena.deinit();
    allocator.destroy(held);
}

export fn talk_load_error_error(e: *const LoadError, out: *Buffer) HostErrorCode {
    var text: std.Io.Writer.Allocating = .init(allocator);
    defer text.deinit();
    const w = &text.writer;
    for (e.diagnostics[0..e.diagnostics_len], 0..) |d, i| {
        if (i > 0) w.writeByte('\n') catch return .out_of_memory;
        w.print("{s}:{d}:{d}: {s}", .{ d.unit[0..d.unit_len], d.line, d.col, d.code[0..d.code_len] }) catch return .out_of_memory;
        if (d.message_len > 0) w.print(": {s}", .{d.message[0..d.message_len]}) catch return .out_of_memory;
    }
    if (e.diagnostics_len == 0) w.writeAll("load error") catch return .out_of_memory;
    return buffer(out, text.toOwnedSlice());
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

export fn talk_library_imports(l: *const machine.Library, out: *[*]const *machine.Library) usize {
    out.* = l.imports.ptr;
    return l.imports.len;
}

export fn talk_library_needs(l: *const machine.Library, out: *[*]const OperationRef) usize {
    out.* = l.operations.ptr;
    return l.operations.len;
}

/// Adds a compiled Library to the Group, a Host Input with its `add-library`
/// record. A stdlib name is TALK_RESERVED_NAME, a name the Group holds
/// TALK_NAME_REUSED, and an import it doesn't hold TALK_LIBRARY_MISMATCH.
export fn talk_add_library(g: *Group, l: *machine.Library) HostErrorCode {
    g.group.checkWorker() catch |err| {
        g.group.refuseWorker(.{ .add_library = l });
        g.flush();
        return status(err);
    };
    if (g.memory.refused) return .out_of_memory;
    defer g.flush();
    g.group.addLibrary(l) catch |err| return status(err);
    return .ok;
}

// ---------------------------------------------------------------- Run accounting fixtures

// The shared Run accounting fixtures (impl/testdata/run-accounting.json),
// which the Go and TS Cores also replay: each delivers `go` to the Script
// `s`, pumps at the listed Clock readings, and compares every Pump's
// reports as rows, apart from the canonical Trace.

/// A report as the fixture's row: each key's value, shown as JSON.
const Row = std.StringArrayHashMapUnmanaged([]const u8);

fn put(a: std.mem.Allocator, row: *Row, key: []const u8, value: []const u8) !void {
    try row.put(a, key, try std.json.Stringify.valueAlloc(a, value, .{}));
}

fn putAncestry(a: std.mem.Allocator, row: *Row, x: RunAncestry) !void {
    try put(a, row, "rootDelivery", x.root_delivery[0..x.root_delivery_len]);
    if (x.parent_run_len > 0) try put(a, row, "parentRun", x.parent_run[0..x.parent_run_len]);
    if (x.parent_call_len > 0) try put(a, row, "parentCall", x.parent_call[0..x.parent_call_len]);
}

fn actualRow(a: std.mem.Allocator, r: Report) !?Row {
    var row: Row = .empty;
    switch (r.kind) {
        .run_started => {
            const x = r.as.run_started;
            try put(a, &row, "kind", "run started");
            try putAncestry(a, &row, x.ancestry);
            try put(a, &row, "script", x.script[0..x.script_len]);
            try put(a, &row, "run", x.run[0..x.run_len]);
            try put(a, &row, "selector", x.selector[0..x.selector_len]);
            if (x.delivery_len > 0) try put(a, &row, "delivery", x.delivery[0..x.delivery_len]);
            var args: std.ArrayList([]const u8) = .empty;
            for (x.args[0..x.args_len]) |v| {
                var shown: Buffer = .{};
                try std.testing.expectEqual(HostErrorCode.ok, talk_value_string(v, &shown));
                defer talk_owned_bytes_release(&shown);
                try args.append(a, try a.dupe(u8, shown.data.?[0..shown.len]));
            }
            try row.put(a, "args", try std.json.Stringify.valueAlloc(a, args.items, .{}));
        },
        .run_end => {
            const x = r.as.run_end;
            try put(a, &row, "kind", "run end");
            try put(a, &row, "run", x.run[0..x.run_len]);
        },
        .run_accounting => {
            const x = r.as.run_accounting;
            try put(a, &row, "kind", "run accounting");
            try putAncestry(a, &row, x.ancestry);
            try put(a, &row, "script", x.script[0..x.script_len]);
            try put(a, &row, "run", x.run[0..x.run_len]);
            try row.put(a, "fuel", try std.fmt.allocPrint(a, "{d}", .{x.fuel}));
            try put(a, &row, "state", x.state[0..x.state_len]);
        },
        .causal_work => {
            const x = r.as.causal_work;
            try put(a, &row, "kind", "causal work");
            try put(a, &row, "rootDelivery", x.root_delivery[0..x.root_delivery_len]);
            try row.put(a, "liveRuns", try std.fmt.allocPrint(a, "{d}", .{x.live_runs}));
            try row.put(a, "queuedMessages", try std.fmt.allocPrint(a, "{d}", .{x.queued_messages}));
            try row.put(a, "discardedMessages", try std.fmt.allocPrint(a, "{d}", .{x.discarded_messages}));
        },
        else => return null,
    }
    return row;
}

fn expectedRow(a: std.mem.Allocator, v: std.json.Value) !Row {
    var row: Row = .empty;
    var it = v.object.iterator();
    while (it.next()) |e| try row.put(a, e.key_ptr.*, try std.json.Stringify.valueAlloc(a, e.value_ptr.*, .{}));
    return row;
}

fn sameRow(want: Row, got: Row) bool {
    if (want.count() != got.count()) return false;
    var it = want.iterator();
    while (it.next()) |e| {
        const other = got.get(e.key_ptr.*) orelse return false;
        if (!std.mem.eql(u8, e.value_ptr.*, other)) return false;
    }
    return true;
}

fn showRows(rows: []const Row) void {
    for (rows) |row| {
        var it = row.iterator();
        while (it.next()) |e| std.debug.print("{s}={s} ", .{ e.key_ptr.*, e.value_ptr.* });
        std.debug.print("\n", .{});
    }
}

test "the shared Run accounting fixtures" {
    const gpa = std.testing.allocator;
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const data = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../testdata/run-accounting.json", a, .unlimited);
    const cases = try std.json.parseFromSliceLeaky(std.json.Value, a, data, .{});
    for (cases.array.items) |case| {
        const name = case.object.get("name").?.string;
        const source = case.object.get("source").?.string;
        const core = talk_new().?;
        defer talk_core_release(core);
        var group: ?*Group = null;
        const options: GroupOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null };
        try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &options, &group));
        defer talk_group_release(group);
        const load: LoadOptions = .{ .name = "s", .name_len = 1, .source = source.ptr, .source_len = source.len };
        var script: ?*Script = null;
        try std.testing.expectEqual(HostErrorCode.ok, talk_load(group.?, &load, &script));
        const message: Message = .{ .name = "go", .name_len = 2, .args = null, .args_len = 0 };
        try std.testing.expectEqual(HostErrorCode.ok, talk_script_deliver(script.?, &message, null));
        const pumps = case.object.get("pumps").?.array.items;
        const expected = case.object.get("expected").?.array.items;
        for (pumps, expected, 0..) |clock, want, i| {
            const ns = clock.integer;
            var pumped: PumpResult = .{ .state = .idle, .fuel_used = 0 };
            try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, @divFloor(ns, std.time.ns_per_s), @intCast(@divFloor(@mod(ns, std.time.ns_per_s), std.time.ns_per_us)), null, &pumped));
            defer talk_reports_release(pumped.reports);
            var items: [*]const Report = undefined;
            const n = talk_reports_items(pumped.reports, &items);
            var got: std.ArrayList(Row) = .empty;
            for (items[0..n]) |r| if (try actualRow(a, r)) |row| try got.append(a, row);
            var wanted: std.ArrayList(Row) = .empty;
            for (want.array.items) |x| try wanted.append(a, try expectedRow(a, x));
            const same = got.items.len == wanted.items.len and for (wanted.items, got.items) |w, g| {
                if (!sameRow(w, g)) break false;
            } else true;
            if (!same) {
                std.debug.print("{s}, pump {d}\nexpected:\n", .{ name, i });
                showRows(wanted.items);
                std.debug.print("actual:\n", .{});
                showRows(got.items);
                return error.TestUnexpectedResult;
            }
        }
    }
}

/// Each report's kind, and for a discard its reason, for the tests below.
fn reportKinds(a: std.mem.Allocator, reports: ?*const Reports) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var items: [*]const Report = undefined;
    const n = talk_reports_items(reports, &items);
    for (items[0..n]) |r| {
        try out.appendSlice(a, @tagName(r.kind));
        switch (r.kind) {
            .run_discarded => try out.print(a, "({s})", .{r.as.run_discarded.reason[0..r.as.run_discarded.reason_len]}),
            .run_accounting => try out.print(a, "({s} {d})", .{ r.as.run_accounting.state[0..r.as.run_accounting.state_len], r.as.run_accounting.fuel }),
            .causal_work => try out.print(a, "({d} {d} {d})", .{ r.as.causal_work.live_runs, r.as.causal_work.queued_messages, r.as.causal_work.discarded_messages }),
            else => {},
        }
        try out.append(a, ' ');
    }
    return out.items;
}

test "a restore reports its accounting baseline, and a Reload its discards" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const core = talk_new().?;
    defer talk_core_release(core);
    var group: ?*Group = null;
    const options: GroupOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null };
    try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &options, &group));
    defer talk_group_release(group);
    const source = "on go\n wait 1 s\nend go\n";
    const load: LoadOptions = .{ .name = "s", .name_len = 1, .source = source.ptr, .source_len = source.len };
    var script: ?*Script = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_load(group.?, &load, &script));
    const go: Message = .{ .name = "go", .name_len = 2, .args = null, .args_len = 0 };
    try std.testing.expectEqual(HostErrorCode.ok, talk_script_deliver(script.?, &go, null));
    var pumped: PumpResult = .{ .state = .idle, .fuel_used = 0 };
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, 0, 0, null, &pumped));
    talk_reports_release(pumped.reports);
    // A second Delivery waits in the input queue across the save.
    try std.testing.expectEqual(HostErrorCode.ok, talk_script_deliver(script.?, &go, null));
    var saved: Buffer = .{};
    try std.testing.expectEqual(HostErrorCode.ok, talk_save(group.?, &saved));
    defer talk_owned_bytes_release(&saved);
    const restore_options: RestoreOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null, .libraries = null, .libraries_len = 0, .grants = null, .grants_context = null, .resolve = null, .resolve_context = null, .mismatch = .reject_mismatch, .allocator = null, .memory_cap = 0 };
    var restored: ?*Group = null;
    var outcome: ?*RestoreResult = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_restore(core, saved.data, saved.len, &restore_options, &restored, &outcome));
    defer talk_group_release(restored);
    try std.testing.expectEqualStrings("run_accounting(live 15) causal_work(1 0 0) causal_work(0 1 0) ", try reportKinds(a, talk_restore_result_reports(outcome.?)));
    talk_restore_result_release(outcome);
    // Reload discards the live Run. The second Delivery, still in the input
    // queue, is first reported here, the next call that returns reports.
    var reports: ?*Reports = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_script_reload(script.?, source.ptr, source.len, .carry_variables, null, &reports));
    defer talk_reports_release(reports);
    try std.testing.expectEqualStrings("run_discarded(reload) stop run_accounting(discarded 15) causal_work(0 0 0) causal_work(0 1 0) ", try reportKinds(a, reports));
}

test "Inspect shows a preempted Run and the message it sent" {
    const core = talk_new().?;
    defer talk_core_release(core);
    var group: ?*Group = null;
    const options: GroupOptions = .{ .name = "g", .name_len = 1, .trace = null, .trace_context = null };
    try std.testing.expectEqual(HostErrorCode.ok, talk_new_group(core, &options, &group));
    defer talk_group_release(group);
    const source = "on go\n send note with 1 to me\n repeat 100 times\n end repeat\nend go\non note x\nend note\n";
    const load: LoadOptions = .{ .name = "s", .name_len = 1, .source = source.ptr, .source_len = source.len };
    var script: ?*Script = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_load(group.?, &load, &script));
    const go: Message = .{ .name = "go", .name_len = 2, .args = null, .args_len = 0 };
    try std.testing.expectEqual(HostErrorCode.ok, talk_script_deliver(script.?, &go, null));
    const capped: PumpOptions = .{ .fuel_slice = 0, .fuel_cap = 30 };
    try std.testing.expectEqual(HostErrorCode.ok, talk_pump(group.?, 0, 0, &capped, null));
    var inspection: ?*Inspection = null;
    try std.testing.expectEqual(HostErrorCode.ok, talk_inspect(group.?, &inspection));
    defer talk_inspection_release(inspection);
    const view = inspection.?.scripts[0];
    try std.testing.expectEqual(@as(usize, 1), view.runs_len);
    try std.testing.expectEqual(RunStatus.preempted, view.runs[0].status);
    try std.testing.expectEqualStrings("s/r1", view.runs[0].id[0..view.runs[0].id_len]);
    try std.testing.expectEqual(@as(usize, 1), view.mailbox_len);
    const m = view.mailbox[0];
    try std.testing.expectEqualStrings("", m.delivery[0..m.delivery_len]);
    try std.testing.expectEqualStrings("s/r1", m.from[0..m.from_len]);
    try std.testing.expectEqualStrings("note", m.message.name.?[0..m.message.name_len]);
    try std.testing.expectEqual(@as(usize, 1), m.message.args_len);
}

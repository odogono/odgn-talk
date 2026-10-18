//! A Pump's reports (chapter 9, ADR 0015): what the Group tells its Host,
//! beside the Trace, as each Run ends, a Script stops, a message reaches the
//! end of its path, a call fails, an effect fails, a Decision seals or the
//! Pump refuses a queued input. They are collected as they happen and taken
//! whole by the Host call that returns them, so a report outlives the Run or
//! message it describes.
const std = @import("std");
const model = @import("../value.zig");
const objects = @import("objects.zig");
const id_text = @import("../ids.zig");
const Value = model.Value;

/// Where a Run raised its error or faulted.
pub const Location = struct {
    unit: []const u8 = "",
    line: u32 = 0,
    column: u32 = 0,
    handler: []const u8 = "",
    pc: u32 = 0,
};

pub const Outcome = enum { completed, errored, limit_fault, cancelled, unhandled, dropped, effect_failure };

/// How a cancelled Run's cleanup failed: an error's code, or a limit.
pub const CleanupFailure = struct { code: []const u8 = "", limit: []const u8 = "" };

pub const EffectFailure = struct {
    script: []const u8,
    run: []const u8,
    grant: []const u8,
    segment: []const u8,
    phase: []const u8,
    status: []const u8,
    scope: []const u8 = "",
};

pub const RunEnd = struct {
    script: []const u8,
    /// Empty for a Delivery cancelled before it started.
    run: []const u8 = "",
    /// Empty for a Run started by another Script's send.
    delivery: []const u8 = "",
    broadcast: []const u8 = "",
    handler: []const u8 = "",
    fallback: bool = false,
    /// Whether its message went on up the Message Path, by `pass` or with
    /// no clause taking it, so it hasn't answered its asker.
    climbed: bool = false,
    outcome: Outcome,
    effect: ?EffectFailure = null,
    cleanup_failed: ?CleanupFailure = null,
    /// The result of a completed Run.
    result: ?*Value = null,
    /// The error map of an errored one.
    err: ?*Value = null,
    limit: []const u8 = "",
    at: Location = .{},
    fuel: u64 = 0,
    alloc: u64 = 0,
};

pub const Stop = struct {
    script: []const u8,
    reason: []const u8,
    discarded_runs: []const []const u8 = &.{},
    dropped_messages: []const []const u8 = &.{},
    pending_calls: []const []const u8 = &.{},
};

pub const Unhandled = struct {
    /// Empty for a message a Run sent.
    delivery: []const u8 = "",
    message: []const u8,
    args: []const *Value = &.{},
    /// Null for a message addressed to a Script.
    target: ?*objects.Object = null,
};

pub const CallFailed = struct {
    script: []const u8,
    call: []const u8,
    capability: []const u8,
    operation: []const u8,
    detail: []const u8 = "",
};

pub const Veto = struct { script: []const u8, run: []const u8, reason: *Value };
pub const UndecidedBy = struct { script: []const u8, run: []const u8, outcome: Outcome };

pub const Decided = struct {
    delivery: []const u8 = "",
    broadcast: []const u8 = "",
    verdict: enum { allowed, vetoed, undecided },
    vetoes: []const Veto = &.{},
    undecided: []const UndecidedBy = &.{},
};

/// Where a Run's work came from (chapter 9, Run accounting): the Host
/// Delivery at its root, and the Run, and call, that spawned it.
pub const Ancestry = struct {
    root: []const u8,
    parent_run: []const u8 = "",
    parent_call: []const u8 = "",
};

pub const RunStarted = struct {
    ancestry: Ancestry,
    script: []const u8,
    run: []const u8,
    /// Empty unless a Host Delivery started it.
    delivery: []const u8 = "",
    /// Empty for a Function Value invocation, which has `function`.
    selector: []const u8 = "",
    function: ?*Value = null,
    args: []const *Value = &.{},
};

pub const RunDiscarded = struct {
    ancestry: Ancestry,
    script: []const u8,
    run: []const u8,
    /// `stop`, `reload`, `library replacement`, `variables-only restore` or
    /// `rewind`.
    reason: []const u8,
};

pub const RunAccounting = struct {
    ancestry: Ancestry,
    script: []const u8,
    run: []const u8,
    /// Lifetime cumulative.
    fuel: u64,
    state: State,

    pub const State = enum { live, terminal, discarded };
};

pub const CausalWork = struct {
    root: []const u8,
    live_runs: u64,
    queued_messages: u64,
    /// Cumulative lifecycle discards.
    discarded_messages: u64,
};

/// A queued Host Input the Pump refused as it drained it.
pub const HostError = struct { code: []const u8, detail: []const u8 = "" };

pub const ChargeResult = struct { request: []const u8, call: []const u8, fuel: u64, status: @import("capabilities.zig").ChargeStatus };

pub const Report = union(enum) {
    charge_result: ChargeResult,
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
};

/// The reports not yet returned, in the order they happened. Their text
/// lives in an arena, and the values they hold are retained until the
/// reports are released.
pub const Reports = struct {
    arena: std.heap.ArenaAllocator,
    list: std.ArrayList(Report) = .empty,
    held: std.ArrayList(*Value) = .empty,

    pub fn init(gpa: std.mem.Allocator) Reports {
        return .{ .arena = .init(gpa) };
    }

    pub fn deinit(r: *Reports) void {
        for (r.held.items) |v| v.release();
        r.arena.deinit();
        r.* = undefined;
    }

    /// Hands every report collected so far to the caller, and starts again.
    pub fn take(r: *Reports) Reports {
        const taken = r.*;
        r.* = .init(taken.arena.child_allocator);
        return taken;
    }

    pub fn text(r: *Reports, s: []const u8) ![]const u8 {
        return r.arena.allocator().dupe(u8, s);
    }

    /// An id the reports hold, such as `d12`.
    pub fn id(r: *Reports, comptime prefix: []const u8, n: u64) ![]const u8 {
        return id_text.alloc(r.arena.allocator(), "", prefix, n);
    }

    /// A reference to `v` the reports hold.
    pub fn value(r: *Reports, v: *Value) !*Value {
        try r.held.append(r.arena.allocator(), v);
        return v.retain();
    }

    pub fn valueList(r: *Reports, vs: []const *Value) ![]const *Value {
        const out = try r.arena.allocator().alloc(*Value, vs.len);
        for (vs, out) |v, *o| o.* = try r.value(v);
        return out;
    }

    pub fn add(r: *Reports, report: Report) !void {
        // A one-Run Pump makes four: its Run's start, end and accounting,
        // and its causal work. Growing to them one by one copies each.
        if (r.list.capacity == 0) try r.list.ensureTotalCapacityPrecise(r.arena.allocator(), 4);
        try r.list.append(r.arena.allocator(), report);
    }
};

test "reports keep their values until released" {
    const gpa = std.testing.allocator;
    var r: Reports = .init(gpa);
    defer r.deinit();
    const v = try model.text(gpa, "x");
    try r.add(.{ .run_end = .{ .script = try r.text("s"), .outcome = .completed, .result = try r.value(v) } });
    v.release();
    var taken = r.take();
    defer taken.deinit();
    try std.testing.expectEqual(@as(usize, 0), r.list.items.len);
    try std.testing.expectEqualStrings("x", taken.list.items[0].run_end.result.?.data.text);
}

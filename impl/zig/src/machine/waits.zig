//! The Wait table (ADR 0105): pending Waits, suspending Calls, abandonment
//! and retirement. Settlement changes Wait state and returns the Run and
//! Join Member that answered; scheduling and Trace writes belong to the Group.
const std = @import("std");
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const Pending = machine.Pending;
const Run = machine.Run;
const capabilities = @import("capabilities.zig");
const Call = capabilities.Call;
const Lock = @import("queue_lock.zig").Lock;

/// The existing ways a Call's wait ends without consuming its answer.
/// These are internal: neither talk.h nor saves expose them.
pub const AbandonReason = enum {
    cancelled,
    run_destroyed,
    restore_lost,
    timeout,
    join_failed,
    join_ended,
    stopped,
    rewound,
    charge_refused,
    limit,
};

/// No deadline: a `wait for` that can wait for ever.
pub const never: i128 = std.math.maxInt(i128);

pub const Waits = struct {
    /// The Waits, in the order they began.
    pending: std.ArrayList(*Pending) = .empty,
    /// How many deadlines have been set: the next Wait's order.
    timers: u64 = 0,

    /// Suspending Calls still eligible for retirement.
    calls: std.ArrayList(*Call) = .empty,
    /// Retired Calls keep their identity for late Host answers, but no args.
    retired_calls: std.ArrayList(*Call) = .empty,
    call_index: std.StringHashMapUnmanaged(*Call) = .empty,
    issued_calls: @import("issued_calls.zig").IssuedCalls = .{},
    /// A suspending Start kept alive across a transport pause.
    starting_call: ?*Call = null,

    pub fn deinit(w: *Waits, a: Allocator) void {
        w.pending.deinit(a);
        w.issued_calls.deinit(a);
        w.call_index.deinit(a);
        for ([_][]*Call{ w.calls.items, w.retired_calls.items }) |list| for (list) |c| {
            a.free(c.id);
            releaseArgs(a, c);
            a.destroy(c);
        };
        w.calls.deinit(a);
        w.retired_calls.deinit(a);
    }

    pub fn addCall(w: *Waits, a: Allocator, c: *Call) Allocator.Error!void {
        try w.calls.ensureUnusedCapacity(a, 1);
        try w.call_index.put(a, c.id, c);
        w.calls.appendAssumeCapacity(c);
    }

    /// The suspending Call with this id, live or retired.
    pub fn callById(w: *const Waits, id: []const u8) ?*Call {
        return w.call_index.get(id);
    }

    pub fn registerCall(w: *Waits, a: Allocator, input_lock: *Lock, id: []const u8, eligible: bool) !void {
        input_lock.lock();
        defer input_lock.unlock();
        try w.issued_calls.put(a, id, eligible);
    }

    pub fn unissueCall(w: *Waits, a: Allocator, input_lock: *Lock, id: []const u8) void {
        input_lock.lock();
        defer input_lock.unlock();
        w.issued_calls.removeLast(a, id);
    }

    /// Charge admission already holds input_lock across its query and enqueue.
    /// null means unknown; false means issued but ineligible.
    pub fn issuedEligibilityLocked(w: *const Waits, id: []const u8) ?bool {
        return w.issued_calls.get(id);
    }

    pub fn abandon(w: *Waits, c: *Call, reason: AbandonReason) void {
        _ = w;
        // Preserve the first cause if several exit paths visit this Call.
        if (c.abandon_reason == null) c.abandon_reason = reason;
        c.abandoned.store(true, .release);
    }

    pub fn abandonWait(w: *Waits, p: *const Pending, reason: AbandonReason) void {
        if (p.call) |c| w.abandon(c, reason);
    }

    /// Settled answers can still be discarded before a Run consumes them.
    pub fn abandonReady(w: *Waits, run: *Run, reason: AbandonReason) void {
        if (run.resume_with != null) {
            if (run.waited.call) |c| if (!c.settlement_consumed) w.abandon(c, reason);
        }
        if (run.join) |j| for (j.members.items) |m| {
            if (m.with != null) if (m.waited.call) |c| if (!c.settlement_consumed) w.abandon(c, reason);
        };
    }

    /// Marks every discarded Call before any cleanup Host hook can run.
    /// Waits stay intact for the Group's Trace and destruction.
    pub fn abandonRun(w: *Waits, run: *Run, reason: AbandonReason) void {
        w.abandonReady(run, reason);
        if (run.waiting) |p| w.abandonWait(p, reason);
        if (run.join) |j| for (j.members.items) |m| {
            if (m.pending) |p| w.abandonWait(p, reason);
        };
    }

    /// The union of deadline-table and live-Run references, including those
    /// left when a Zig error escapes mid-Segment. `runs` is a fresh iterator
    /// whose next() returns ?*Run; no Group or Script is needed by this module.
    pub fn awaited(w: *const Waits, c: *const Call, runs: anytype) bool {
        for (w.all()) |p| if (p.call == c) return true;
        return awaitedByRun(c, runs);
    }

    /// Whether a live Run still waits on the Call or holds its answer.
    /// Saves use this alone so their bytes stay as before.
    pub fn awaitedByRun(c: *const Call, runs: anytype) bool {
        var it = runs;
        while (it.next()) |r| {
            if (r.waiting) |p| if (p.call == c) return true;
            if (r.waited.call == c) return true;
            if (r.join) |j| for (j.members.items) |m| {
                if (m.waited.call == c) return true;
                if (m.pending) |p| if (p.call == c) return true;
            };
        }
        return false;
    }

    /// Without room to retire a Call it stays live until the next Pump.
    pub fn retireCalls(w: *Waits, a: Allocator, runs: anytype) void {
        if (w.calls.items.len == 0) return;
        var kept: usize = 0;
        for (w.calls.items) |c| {
            const done = (c.settlement_consumed or c.abandoned.load(.acquire)) and w.starting_call != c and !w.awaited(c, runs);
            if (done) if (w.retired_calls.append(a, c)) |_| {
                releaseArgs(a, c);
                c.args = &.{};
                continue;
            } else |_| {};
            w.calls.items[kept] = c;
            kept += 1;
        }
        w.calls.shrinkRetainingCapacity(kept);
    }

    pub const Settlement = struct { run: *Run, member: ?usize, ready: bool };

    /// Consumes the Wait and its answer. A failed Join cuts its pending
    /// siblings immediately; the Group schedules only a ready result.
    pub fn settle(w: *Waits, a: Allocator, p: *Pending, with: machine.Resume) Settlement {
        w.take(p);
        defer destroy(a, p);
        const run = p.run;
        const result: Settlement = .{ .run = run, .member = p.member, .ready = false };
        if (p.member) |index| {
            const join = run.join.?;
            join.members.items[index].with = with;
            const failed = switch (with) {
                .answer, .reply => false,
                else => true,
            };
            const waiting_at_end = std.mem.eql(u8, run.suspended_at, "join-end") and run.resume_with == null;
            if (!waiting_at_end) return result;
            if (failed) {
                run.resume_with = .{ .join_failed = index };
                for (join.members.items) |*x| if (x.pending) |sibling| {
                    w.take(sibling);
                    w.abandonWait(sibling, .join_failed);
                    destroy(a, sibling);
                    x.cut = true;
                };
            } else {
                for (join.members.items) |x| if (x.with == null) return result;
                run.resume_with = .joined;
            }
            if (w.takeRun(run)) |bound| destroy(a, bound);
        } else {
            run.resume_with = with;
            run.waited = .{ .id = if (p.call) |c| c.id else p.id, .block = p.block, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms };
        }
        return .{ .run = run, .member = p.member, .ready = true };
    }

    /// Every Wait, in the order they began.
    pub fn all(w: *const Waits) []const *Pending {
        return w.pending.items;
    }

    /// Counts a deadline set, and returns its order.
    fn order(w: *Waits) u64 {
        w.timers += 1;
        return w.timers;
    }

    /// Adds a Run's own Wait. Of equal deadlines, the earlier added fires
    /// first.
    pub fn add(w: *Waits, a: Allocator, p: *Pending) Allocator.Error!void {
        p.order = w.order();
        try w.pending.append(a, p);
        p.run.waiting = p;
    }

    /// Adds a Join Member's Wait, as the next member of the Run's Join.
    pub fn addMember(w: *Waits, a: Allocator, p: *Pending) Allocator.Error!void {
        const join = p.run.join.?;
        p.order = w.order();
        p.member = join.members.items.len;
        // Both or neither, so a failure leaves no Wait without its member.
        try w.pending.ensureUnusedCapacity(a, 1);
        try join.members.ensureUnusedCapacity(a, 1);
        w.pending.appendAssumeCapacity(p);
        join.members.appendAssumeCapacity(.{ .pending = p, .waited = .{ .id = if (p.call) |c| c.id else p.id, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms } });
    }

    /// Takes a Wait out of the table, keeping the others in order, and
    /// clears its Run's or Join Member's reference to it.
    pub fn take(w: *Waits, p: *Pending) void {
        if (std.mem.indexOfScalar(*Pending, w.pending.items, p)) |i| _ = w.pending.orderedRemove(i);
        if (p.member) |m| {
            if (p.run.join) |join| if (m < join.members.items.len) {
                const member = &join.members.items[m];
                if (member.pending == p) member.pending = null;
            };
        } else if (p.run.waiting == p) p.run.waiting = null;
    }

    /// Takes a Run's own Wait out, if it has one.
    pub fn takeRun(w: *Waits, run: *Run) ?*Pending {
        const p = run.waiting orelse return null;
        w.take(p);
        return p;
    }

    /// The Wait on a suspending Call, by its id.
    pub fn call(w: *const Waits, id: []const u8) ?*Pending {
        for (w.pending.items) |p| if (p.call) |c| if (std.mem.eql(u8, c.id, id)) return p;
        return null;
    }

    /// The Wait of a `send … and wait` for its reply, by its id.
    pub fn reply(w: *const Waits, id: []const u8) ?*Pending {
        for (w.pending.items) |p| if (p.call == null and std.mem.eql(u8, p.id, id)) return p;
        return null;
    }

    /// The Wait due first at `now`: by deadline, then by the order its
    /// deadline was set.
    pub fn due(w: *const Waits, now: i128) ?*Pending {
        var first: ?*Pending = null;
        for (w.pending.items) |p| {
            if (p.deadline > now) continue;
            if (first == null or p.deadline < first.?.deadline or (p.deadline == first.?.deadline and p.order < first.?.order)) first = p;
        }
        return first;
    }

    /// The earliest deadline still pending.
    pub fn next(w: *const Waits) ?i128 {
        var best: ?i128 = null;
        for (w.pending.items) |p| if (p.deadline != never and (best == null or p.deadline < best.?)) {
            // A preempted Run's Join hasn't reached its end, so its members'
            // waits aren't timers yet.
            if (p.member != null and p.run.continuing) continue;
            best = p.deadline;
        };
        return best;
    }
};

fn releaseArgs(a: Allocator, c: *Call) void {
    for (c.args) |v| v.release();
    a.free(c.args);
}

pub fn destroy(a: Allocator, p: *Pending) void {
    if (p.event) |e| releaseEvent(a, e);
    a.destroy(p);
}

pub fn releaseEvent(a: Allocator, e: *machine.EventWait) void {
    releaseBranches(a, e.branches);
    a.destroy(e);
}

pub fn releaseBranches(a: Allocator, branches: []machine.EventBranch) void {
    releaseHeld(a, branches);
    a.free(branches);
}

pub fn releaseHeld(a: Allocator, branches: []const machine.EventBranch) void {
    for (branches) |b| switch (b) {
        .when => |x| {
            if (x.from) |v| v.release();
            for (x.captures) |v| v.release();
            a.free(x.captures);
        },
        .after => {},
    };
}

// Tests on bare Runs, with no Group or Script.

const t = std.testing;

fn bareRun() Run {
    var run: Run = undefined;
    run.waiting = null;
    run.join = null;
    run.continuing = false;
    run.resume_with = null;
    run.waited = .{};
    run.suspended_at = "";
    return run;
}

test "a Run's Wait is referenced while in the table, and cleared when taken" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    var p: Pending = .{ .run = &run, .deadline = 10, .order = 0 };
    try w.add(t.allocator, &p);
    try t.expectEqual(&p, run.waiting.?);
    try t.expectEqual(@as(u64, 1), p.order);
    try t.expectEqual(&p, w.takeRun(&run).?);
    try t.expectEqual(@as(?*Pending, null), run.waiting);
    try t.expectEqual(@as(usize, 0), w.all().len);
    try t.expectEqual(@as(?*Pending, null), w.takeRun(&run));
}

test "taking a Wait keeps the others in the order they began" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var runs = [_]Run{ bareRun(), bareRun(), bareRun() };
    var ps: [3]Pending = undefined;
    for (&ps, &runs) |*p, *r| {
        p.* = .{ .run = r, .deadline = never, .order = 0 };
        try w.add(t.allocator, p);
    }
    w.take(&ps[1]);
    try t.expectEqualSlices(*Pending, &.{ &ps[0], &ps[2] }, w.all());
    try t.expectEqual(@as(?*Pending, null), runs[1].waiting);
    try t.expectEqual(&ps[0], runs[0].waiting.?);
}

test "the Wait due first is by deadline, then by the order its deadline was set" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var runs = [_]Run{ bareRun(), bareRun(), bareRun() };
    var a: Pending = .{ .run = &runs[0], .deadline = 20, .order = 0 };
    var b: Pending = .{ .run = &runs[1], .deadline = 10, .order = 0 };
    var c: Pending = .{ .run = &runs[2], .deadline = 10, .order = 0 };
    try w.add(t.allocator, &a);
    try w.add(t.allocator, &b);
    try w.add(t.allocator, &c);
    try t.expectEqual(@as(?*Pending, null), w.due(5));
    try t.expectEqual(&b, w.due(15).?);
    w.take(&b);
    try t.expectEqual(&c, w.due(15).?);
    w.take(&c);
    try t.expectEqual(@as(?*Pending, null), w.due(15));
    try t.expectEqual(&a, w.due(20).?);
    try t.expectEqual(@as(?i128, 20), w.next());
}

test "a Join Member's Wait is referenced by its member until taken" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    run.join = &join;
    var m0: Pending = .{ .run = &run, .deadline = 30, .order = 0, .id = "r1.c1" };
    var m1: Pending = .{ .run = &run, .deadline = 40, .order = 0, .id = "r1.c2" };
    try w.addMember(t.allocator, &m0);
    try w.addMember(t.allocator, &m1);
    try t.expectEqual(@as(?usize, 1), m1.member);
    try t.expectEqual(&m1, join.members.items[1].pending.?);
    try t.expectEqualStrings("r1.c2", join.members.items[1].waited.id);
    try t.expectEqual(&m0, w.reply("r1.c1").?);
    w.take(&m0);
    try t.expectEqual(@as(?*Pending, null), join.members.items[0].pending);
    try t.expectEqual(&m1, join.members.items[1].pending.?);
    // A member's Wait leaves the Run's own reference alone.
    try t.expectEqual(@as(?*Pending, null), run.waiting);
    // A preempted Run's members aren't timers yet.
    run.continuing = true;
    try t.expectEqual(@as(?i128, null), w.next());
}

const TestRuns = struct {
    runs: []const *Run,
    at: usize = 0,

    pub fn next(it: *TestRuns) ?*Run {
        if (it.at == it.runs.len) return null;
        const run = it.runs[it.at];
        it.at += 1;
        return run;
    }
};

fn testCall(w: *Waits, id: []const u8) !*Call {
    const c = try t.allocator.create(Call);
    errdefer t.allocator.destroy(c);
    const owned = try t.allocator.dupe(u8, id);
    errdefer t.allocator.free(owned);
    c.* = .{ .id = owned, .script = "", .grant = "", .binding = null, .now = .{ .seconds = 0, .micros = 0 }, .left = null, .gpa = t.allocator };
    try w.addCall(t.allocator, c);
    return c;
}

fn testWait(w: *Waits, run: *Run, c: ?*Call, member: bool) !*Pending {
    const p = try t.allocator.create(Pending);
    errdefer t.allocator.destroy(p);
    p.* = .{ .run = run, .call = c, .deadline = 10, .order = 0 };
    if (member) try w.addMember(t.allocator, p) else try w.add(t.allocator, p);
    return p;
}

test "settling a failed Join cuts and abandons siblings and removes its bound" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    run.join = &join;
    run.suspended_at = "join-end";
    const first = try testCall(&w, "s/r1.c1");
    const second = try testCall(&w, "s/r1.c2");
    const p = try testWait(&w, &run, first, true);
    _ = try testWait(&w, &run, second, true);
    _ = try testWait(&w, &run, null, false);
    const settled = w.settle(t.allocator, p, .broken);
    try t.expectEqual(&run, settled.run);
    try t.expectEqual(@as(?usize, 0), settled.member);
    try t.expect(settled.ready);
    try t.expectEqual(@as(usize, 0), run.resume_with.?.join_failed);
    try t.expectEqual(machine.Resume.broken, join.members.items[0].with.?);
    try t.expect(join.members.items[1].cut);
    try t.expectEqual(@as(?*Pending, null), join.members.items[1].pending);
    try t.expectEqual(@as(?*Pending, null), run.waiting);
    try t.expectEqual(@as(usize, 0), w.all().len);
    try t.expect(second.abandoned.load(.acquire));
    try t.expectEqual(AbandonReason.join_failed, second.abandon_reason.?);
    try t.expect(!first.abandoned.load(.acquire));
}

test "Join settlement waits for the end and then every successful member" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    run.join = &join;
    const first = try testWait(&w, &run, null, true);
    const second = try testWait(&w, &run, null, true);
    const value = try @import("../value.zig").scalar(t.allocator, .nothing);
    defer value.release();
    const early = w.settle(t.allocator, first, .{ .reply = value });
    try t.expect(!early.ready);
    try t.expectEqual(@as(?machine.Resume, null), run.resume_with);
    run.suspended_at = "join-end";
    const last = w.settle(t.allocator, second, .{ .reply = value });
    try t.expect(last.ready);
    try t.expectEqual(@as(?usize, 1), last.member);
    try t.expectEqual(machine.Resume.joined, run.resume_with.?);
}

test "Stop marks pending and settled unconsumed Calls before cleanup" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var pending = bareRun();
    const pc = try testCall(&w, "s/r1.c1");
    const p = try testWait(&w, &pending, pc, false);
    defer {
        w.take(p);
        destroy(t.allocator, p);
    }
    var ready = bareRun();
    const rc = try testCall(&w, "s/r2.c1");
    const result = w.settle(t.allocator, try testWait(&w, &ready, rc, false), .broken);
    try t.expect(result.ready);
    try t.expectEqual(@as(?usize, null), result.member);
    w.abandonRun(&pending, .stopped);
    w.abandonRun(&ready, .stopped);
    try t.expect(pc.abandoned.load(.acquire));
    try t.expect(rc.abandoned.load(.acquire));
    try t.expectEqual(AbandonReason.stopped, pc.abandon_reason.?);
    try t.expectEqual(AbandonReason.stopped, rc.abandon_reason.?);
    try t.expectEqual(p, pending.waiting.?);
    // Consumed answers and earlier abandonment causes are left alone.
    const consumed = try testCall(&w, "s/r2.c2");
    consumed.settlement_consumed = true;
    ready.waited.call = consumed;
    w.abandonReady(&ready, .cancelled);
    try t.expect(!consumed.abandoned.load(.acquire));
    w.abandonRun(&pending, .run_destroyed);
    try t.expectEqual(AbandonReason.stopped, pc.abandon_reason.?);
}

test "issued eligibility outlives a refused Charge and its retired Call" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var lock: Lock = .{};
    var run = bareRun();
    const c = try testCall(&w, "s/r1.c1");
    const p = try testWait(&w, &run, c, false);
    try w.registerCall(t.allocator, &lock, c.id, true);
    try w.registerCall(t.allocator, &lock, "s/r1.c2", false);
    try t.expectEqual(true, w.issuedEligibilityLocked(c.id).?);
    try t.expectEqual(false, w.issuedEligibilityLocked("s/r1.c2").?);
    try t.expectEqual(@as(?bool, null), w.issuedEligibilityLocked("s/r1.c3"));
    // Billing stays with the Group; a refused Charge ends the wait as a limit.
    w.abandonWait(p, .limit);
    w.take(p);
    destroy(t.allocator, p);
    w.retireCalls(t.allocator, TestRuns{ .runs = &.{&run} });
    try t.expectEqual(AbandonReason.limit, c.abandon_reason.?);
    try t.expectEqual(@as(usize, 1), w.retired_calls.items.len);
    try t.expectEqual(c, w.callById(c.id).?);
    try t.expectEqual(true, w.issuedEligibilityLocked(c.id).?);
    w.unissueCall(t.allocator, &lock, "s/r1.c2");
    try t.expectEqual(@as(?bool, null), w.issuedEligibilityLocked("s/r1.c2"));
}

test "retirement protects every awaited reference and a starting Call" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    const runs: TestRuns = .{ .runs = &.{&run} };
    const c = try testCall(&w, "s/r1.c1");
    c.settlement_consumed = true;
    // The args must survive until the last reference is gone.
    c.args = try t.allocator.alloc(*@import("../value.zig").Value, 1);
    c.args[0] = try @import("../value.zig").scalar(t.allocator, .nothing);
    var p: Pending = .{ .run = &run, .call = c, .deadline = never, .order = 0 };
    try w.add(t.allocator, &p);
    run.waiting = null; // A table entry left by an error mid-Segment.
    try t.expect(w.awaited(c, TestRuns{ .runs = &.{} }));
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    w.take(&p);
    // Conversely a Run reference must survive without a table entry.
    run.waiting = &p;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    run.waiting = null;
    run.waited.call = c;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    run.waited = .{};
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    try join.members.append(t.allocator, .{ .pending = &p, .waited = .{} });
    run.join = &join;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    join.members.items[0].pending = null;
    join.members.items[0].waited.call = c;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    run.join = null;
    w.starting_call = c;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
    try t.expectEqual(@as(usize, 1), c.args.len);
    w.starting_call = null;
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 0), w.calls.items.len);
    try t.expectEqual(@as(usize, 1), w.retired_calls.items.len);
    try t.expectEqual(@as(usize, 0), c.args.len);
}

//! The Wait table (ADR 0105): pending Waits, suspending Calls, abandonment,
//! retirement, and save export/import. Settlement changes Wait state and
//! returns the Run and Join Member that answered; scheduling and Trace writes
//! belong to the Group.
const std = @import("std");
const sorting = @import("../sort.zig");
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const Pending = machine.Pending;
const Run = machine.Run;
const capabilities = @import("capabilities.zig");
const Call = capabilities.Call;
const issued = @import("issued_calls.zig");
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

/// Mathematical microseconds, including deadlines outside the Clock range.
pub const Ticks = i256;
/// No deadline: a `wait for` that can wait for ever.
pub const never: Ticks = std.math.maxInt(Ticks);

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
    issued_calls: issued.IssuedCalls = .{},
    /// A suspending Start kept alive across a transport pause.
    starting_call: ?*Call = null,

    pub fn deinit(w: *Waits, a: Allocator) void {
        w.pending.deinit(a);
        w.issued_calls.deinit(a);
        w.call_index.deinit(a);
        for ([_][]*Call{ w.calls.items, w.retired_calls.items }) |list| for (list) |c| {
            a.free(c.id);
            a.free(c.site);
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

    /// Frees the retired Calls `keep.holds(id)` refuses, for a Host that
    /// names Calls only by id (#1322). A talk.h Host may hold a `talk_call`
    /// until its Group is released, so only the Message Layer calls this.
    /// A Run's abandonment record borrows its Call's id until written, so
    /// that Call stays. Each freed id stays issued, so a late answer is
    /// still recognised.
    pub fn releaseRetired(w: *Waits, a: Allocator, keep: anytype, runs: anytype) void {
        var kept: usize = 0;
        for (w.retired_calls.items) |c| {
            if (keep.holds(c.id) or recorded(c, runs)) {
                w.retired_calls.items[kept] = c;
                kept += 1;
                continue;
            }
            _ = w.call_index.remove(c.id);
            a.free(c.id);
            a.free(c.site);
            a.destroy(c);
        }
        w.retired_calls.shrinkRetainingCapacity(kept);
    }

    fn recorded(c: *const Call, runs: anytype) bool {
        var it = runs;
        while (it.next()) |r| for (r.abandoned.items) |id| if (id.ptr == c.id.ptr) return true;
        return false;
    }

    /// A borrowed view of the table, plus the compact list of Calls a save
    /// needs. Retired and unreferenced Calls retain no save history (#1126).
    /// The caller holds input_lock throughout export and encoding.
    pub const Export = struct {
        table: *const Waits,
        calls: std.ArrayList(*Call) = .empty,

        pub fn deinit(e: *Export, a: Allocator) void {
            e.calls.deinit(a);
        }

        /// Issued ranges are written in Run-id order, independent of hashing.
        pub fn writeIssued(e: Export, a: Allocator, out: anytype) !void {
            try out.int(e.table.issued_calls.count());
            try e.table.issued_calls.each(a, struct {
                out: @TypeOf(out),
                pub fn run(w: @This(), id: []const u8, ranges: []const issued.Range) !void {
                    try w.out.name(id);
                    try w.out.int(ranges.len);
                    for (ranges) |range| {
                        try w.out.int(range.first);
                        try w.out.int(range.last);
                        try w.out.flag(range.eligible);
                    }
                }
            }{ .out = out });
        }

        /// Waits refer to their Run and optional Join Member in table order.
        pub fn writeOrder(e: Export, out: anytype, runs: []const *Run) !void {
            try out.int(e.table.pending.items.len);
            for (e.table.pending.items) |p| {
                try out.int(std.mem.indexOfScalar(*Run, runs, p.run).?);
                try out.ref(p.member);
            }
        }
    };

    pub fn exportState(w: *const Waits, a: Allocator, runs: anytype) !Export {
        var e: Export = .{ .table = w };
        errdefer e.deinit(a);
        for (w.calls.items) |c| if (w.awaited(c, runs)) try e.calls.append(a, c);
        return e;
    }

    /// Restore is exclusive: no Host can access this table until it finishes.
    pub fn importTimers(w: *Waits, timers: u64) void {
        w.timers = timers;
    }

    pub fn importIssued(w: *Waits, a: Allocator, in: anytype) !void {
        const count = try in.count();
        for (0..count) |_| {
            const run = try a.dupe(u8, try in.name());
            errdefer a.free(run);
            if (run.len == 0 or w.issued_calls.contains(run)) return error.InvalidSave;
            var ranges: std.ArrayList(issued.Range) = .empty;
            errdefer ranges.deinit(a);
            const n = try in.count();
            if (n == 0) return error.InvalidSave;
            for (0..n) |_| {
                const range: issued.Range = .{ .first = try in.int(), .last = try in.int(), .eligible = try in.flag() };
                issued.IssuedCalls.append(&ranges, a, range) catch |err| return switch (err) {
                    error.InvalidCallId => error.InvalidSave,
                    error.OutOfMemory => error.OutOfMemory,
                };
            }
            try w.issued_calls.importRun(a, run, ranges);
        }
    }

    pub const CallContext = struct {
        clock: @import("../value.zig").dates.Instant,
        group: ?*anyopaque,
        owner: ?*anyopaque,
    };

    /// Own the Call before decoding its remaining fields, so a refused save
    /// releases even a partially read Call through the ordinary table teardown.
    pub fn importCall(w: *Waits, a: Allocator, id: []const u8, context: CallContext) !*Call {
        if (w.callById(id) != null) return error.InvalidSave;
        const owned = try a.dupe(u8, id);
        errdefer a.free(owned);
        const c = try a.create(Call);
        errdefer a.destroy(c);
        c.* = .{ .id = owned, .script = "", .grant = "", .binding = null, .now = context.clock, .left = null, .starting = false, .group = context.group, .owner = context.owner, .gpa = a };
        try w.addCall(a, c);
        return c;
    }

    /// Import takes ownership even on invalid member references; Run teardown
    /// must be able to release a partially restored Wait.
    pub fn importWait(w: *Waits, run: *Run, member: ?usize, p: ?*Pending) !void {
        _ = w;
        if (member) |m| run.join.?.members.items[m].pending = p else run.waiting = p;
        if (p) |x| if (x.member != member) return error.InvalidSave;
    }

    /// The Run records own decoded Waits before their global order is read.
    /// Rebuild that order without changing deadlines, counters or back-references.
    pub fn importOrder(w: *Waits, a: Allocator, in: anytype, runs: []const *Run) !void {
        const count = try in.count();
        try w.pending.ensureTotalCapacity(a, count);
        for (0..count) |_| {
            const run = runs[try in.index(runs.len)];
            const p = if (try in.ref(std.math.maxInt(u32))) |m| blk: {
                const join = run.join orelse return error.InvalidSave;
                if (m >= join.members.items.len) return error.InvalidSave;
                break :blk join.members.items[m].pending orelse return error.InvalidSave;
            } else run.waiting orelse return error.InvalidSave;
            if (std.mem.indexOfScalar(*Pending, w.pending.items, p) != null) return error.InvalidSave;
            w.pending.appendAssumeCapacity(p);
        }
    }

    /// The restored Calls still needing a Host decision, in Call-id order.
    pub fn importedPending(w: *const Waits, a: Allocator, calls: []const *Call) !std.ArrayList([]const u8) {
        var ids: std.ArrayList([]const u8) = .empty;
        errdefer ids.deinit(a);
        for (calls) |c| if (w.call(c.id) != null) try ids.append(a, c.id);
        sorting.stable([]const u8, ids.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return machine.callOrder(x, y);
            }
        }.less);
        return ids;
    }

    pub fn hasMeteredWait(w: *const Waits) bool {
        for (w.pending.items) |p| if (p.decl) |op| if (op.metering != null) return true;
        return false;
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
            run.waited = .{ .id = if (p.call) |c| c.id else p.id, .block = p.block, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_us = p.after_us };
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
        join.members.appendAssumeCapacity(.{ .pending = p, .waited = .{ .id = if (p.call) |c| c.id else p.id, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_us = p.after_us } });
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
    /// deadline was set. Of equal deadlines, a Join's Timeout Block wins
    /// over its own members, though its wait is set after theirs.
    pub fn due(w: *const Waits, now: Ticks) ?*Pending {
        var first: ?*Pending = null;
        for (w.pending.items) |p| {
            if (p.deadline > now) continue;
            if (first == null or p.deadline < first.?.deadline or (p.deadline == first.?.deadline and before(p, first.?))) first = p;
        }
        return first;
    }

    fn before(p: *const Pending, q: *const Pending) bool {
        if (p.run == q.run and p.block and p.member == null and q.member != null) return true;
        if (p.run == q.run and q.block and q.member == null and p.member != null) return false;
        return p.order < q.order;
    }

    /// The earliest deadline still pending.
    pub fn next(w: *const Waits) ?Ticks {
        var best: ?Ticks = null;
        for (w.pending.items) |p| if (p.deadline != never and (best == null or p.deadline < best.?)) {
            // A preempted Run's Join hasn't reached its end, so its members'
            // waits aren't timers yet.
            if (p.member != null and machine.run_lifecycle.continuing(p.run)) continue;
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
    run.state = .{ .running = .{} };
    run.resume_with = null;
    run.waited = .{};
    run.abandoned = .empty;
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
    try t.expectEqual(@as(?Ticks, 20), w.next());
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
    run.state = .preempted;
    try t.expectEqual(@as(?Ticks, null), w.next());
}

test "of equal deadlines, a Join's Timeout Block wins over its members" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    var other = bareRun();
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    run.join = &join;
    var m0: Pending = .{ .run = &run, .deadline = 10, .order = 0, .id = "r1.c1" };
    var between: Pending = .{ .run = &other, .deadline = 10, .order = 0, .id = "r2.c1" };
    var block: Pending = .{ .run = &run, .deadline = 10, .order = 0, .block = true };
    try w.addMember(t.allocator, &m0);
    try w.add(t.allocator, &between);
    try w.add(t.allocator, &block);
    // The block takes its first member's place, ahead of a wait set since.
    try t.expectEqual(&block, w.due(10).?);
    w.take(&block);
    try t.expectEqual(&m0, w.due(10).?);
    w.take(&m0);
    try t.expectEqual(&between, w.due(10).?);
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

test "releasing retired Calls keeps those the Host holds and every issued id" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var lock: Lock = .{};
    var run = bareRun();
    const held = try testCall(&w, "s/r1.c1");
    const done = try testCall(&w, "s/r2.c1");
    for ([_]*Call{ held, done }) |c| {
        c.settlement_consumed = true;
        try w.registerCall(t.allocator, &lock, c.id, false);
    }
    w.retireCalls(t.allocator, TestRuns{ .runs = &.{&run} });
    const host = struct {
        fn holds(_: @This(), id: []const u8) bool {
            return std.mem.eql(u8, id, "s/r1.c1");
        }
    }{};
    // An abandonment record not yet written borrows the id.
    defer run.abandoned.deinit(t.allocator);
    try run.abandoned.append(t.allocator, done.id);
    w.releaseRetired(t.allocator, host, TestRuns{ .runs = &.{&run} });
    try t.expectEqual(@as(usize, 2), w.retired_calls.items.len);
    run.abandoned.clearRetainingCapacity();
    w.releaseRetired(t.allocator, host, TestRuns{ .runs = &.{&run} });
    try t.expectEqualSlices(*Call, &.{held}, w.retired_calls.items);
    try t.expectEqual(held, w.callById("s/r1.c1").?);
    try t.expectEqual(@as(?*Call, null), w.callById("s/r2.c1"));
    try t.expectEqual(false, w.issuedEligibilityLocked("s/r2.c1").?);
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

test "save export compacts Call history and uses the same awaited query as retirement" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var run = bareRun();
    const unused = try testCall(&w, "s/r1.c1");
    const ready = try testCall(&w, "s/r1.c2");
    const member = try testCall(&w, "s/r1.c3");
    const pending = try testCall(&w, "s/r1.c4");
    const retired = try testCall(&w, "s/r1.c5");
    retired.settlement_consumed = true;
    run.waited.call = ready;
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    try join.members.append(t.allocator, .{ .pending = null, .waited = .{ .call = member } });
    run.join = &join;
    var p: Pending = .{ .run = &run, .call = pending, .deadline = 10, .order = 0 };
    try w.add(t.allocator, &p);
    defer w.take(&p);
    // Retain a table reference even if a Zig error escaped before the Run
    // recorded it; both retirement and export must protect the same Call.
    run.waiting = null;
    const runs: TestRuns = .{ .runs = &.{&run} };
    w.retireCalls(t.allocator, runs);
    try t.expectEqual(@as(usize, 1), w.retired_calls.items.len);
    w.starting_call = unused;
    var saved = try w.exportState(t.allocator, runs);
    defer saved.deinit(t.allocator);
    try t.expectEqualSlices(*Call, &.{ ready, member, pending }, saved.calls.items);
    try t.expectEqual(@as(u64, 1), saved.table.timers);
    try t.expectEqual(@as(usize, 4), w.calls.items.len);
}

/// A token codec keeps the ordering tests independent of save bytes and Groups.
const TestOrder = struct {
    tokens: std.ArrayList(u64) = .empty,
    at: usize = 0,

    pub fn int(o: *TestOrder, n: u64) !void {
        try o.tokens.append(t.allocator, n);
    }
    pub fn ref(o: *TestOrder, n: ?usize) !void {
        try o.int(if (n) |x| x + 1 else 0);
    }
    pub fn count(i: *TestOrder) !usize {
        if (i.at == i.tokens.items.len) return error.InvalidSave;
        const n = i.tokens.items[i.at];
        i.at += 1;
        return @intCast(n);
    }
    pub fn index(i: *TestOrder, n: usize) !usize {
        const x = try i.count();
        return if (x < n) x else error.InvalidSave;
    }
    pub fn readRef(i: *TestOrder, n: usize) !?usize {
        const x = try i.count();
        if (x == 0) return null;
        return if (x - 1 < n) x - 1 else error.InvalidSave;
    }
};

// Zig has no overloaded methods: this view supplies the input-side ref.
const TestOrderIn = struct {
    data: *TestOrder,

    pub fn count(i: TestOrderIn) !usize {
        return i.data.count();
    }
    pub fn index(i: TestOrderIn, n: usize) !usize {
        return i.data.index(n);
    }
    pub fn ref(i: TestOrderIn, n: usize) !?usize {
        return i.data.readRef(n);
    }
};

test "import preserves Wait order, deadlines and back-references independently of Run order" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    var runs = [_]Run{ bareRun(), bareRun() };
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    runs[1].join = &join;
    try join.members.append(t.allocator, .{ .pending = null, .waited = .{} });
    var own: Pending = .{ .run = &runs[0], .deadline = 10, .order = 9 };
    var member: Pending = .{ .run = &runs[1], .deadline = 10, .order = 3, .member = 0 };
    try w.importWait(&runs[0], null, &own);
    try w.importWait(&runs[1], 0, &member);
    w.importTimers(15);
    // The Join Member began first even though its Run is second.
    var tokens: TestOrder = .{};
    defer tokens.tokens.deinit(t.allocator);
    try tokens.tokens.appendSlice(t.allocator, &.{ 2, 1, 1, 0, 0 });
    const run_list = [_]*Run{ &runs[0], &runs[1] };
    try w.importOrder(t.allocator, TestOrderIn{ .data = &tokens }, &run_list);
    try t.expectEqualSlices(*Pending, &.{ &member, &own }, w.all());
    try t.expectEqual(&member, w.due(10).?);
    try t.expectEqual(&own, runs[0].waiting.?);
    try t.expectEqual(&member, join.members.items[0].pending.?);
    var saved = try w.exportState(t.allocator, TestRuns{ .runs = &run_list });
    defer saved.deinit(t.allocator);
    try t.expectEqual(@as(u64, 15), saved.table.timers);
    var encoded: TestOrder = .{};
    defer encoded.tokens.deinit(t.allocator);
    try saved.writeOrder(&encoded, &run_list);
    try t.expectEqualSlices(u64, tokens.tokens.items, encoded.tokens.items);
    // A duplicate Wait must be refused without appending it twice.
    tokens.at = 0;
    tokens.tokens.items[3] = 1;
    tokens.tokens.items[4] = 1;
    w.pending.clearRetainingCapacity();
    try t.expectError(error.InvalidSave, w.importOrder(t.allocator, TestOrderIn{ .data = &tokens }, &run_list));
    try t.expectEqualSlices(*Pending, &.{&member}, w.all());
    // A bad member reference still belongs to its Run for failure teardown.
    try t.expectError(error.InvalidSave, w.importWait(&runs[0], null, &member));
    try t.expectEqual(&member, runs[0].waiting.?);
}

test "import owns partially decoded Calls and refuses duplicate identities" {
    var w: Waits = .{};
    defer w.deinit(t.allocator);
    const context: Waits.CallContext = .{ .clock = .{ .seconds = 10, .micros = 1 }, .group = null, .owner = null };
    const c = try w.importCall(t.allocator, "s/r1.c1", context);
    try t.expectEqual(c, w.callById("s/r1.c1").?);
    try t.expectEqual(context.clock, c.now);
    try t.expect(!c.starting);
    try t.expectError(error.InvalidSave, w.importCall(t.allocator, "s/r1.c1", context));
    try t.expectEqual(@as(usize, 1), w.calls.items.len);
}

//! The Wait table (ADR 0105): every pending Wait, in the order the Waits
//! began, with its deadline. It sets and clears the references a Run and
//! its Join Members keep to their Waits; no other code writes them. Taking
//! a Wait out leaves it to the Group, which readies its Run, abandons its
//! Call and destroys it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const Pending = machine.Pending;
const Run = machine.Run;

/// No deadline: a `wait for` that can wait for ever.
pub const never: i128 = std.math.maxInt(i128);

pub const Waits = struct {
    /// The Waits, in the order they began.
    pending: std.ArrayList(*Pending) = .empty,
    /// How many deadlines have been set: the next Wait's order.
    timers: u64 = 0,

    pub fn deinit(w: *Waits, a: Allocator) void {
        w.pending.deinit(a);
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

// Tests on bare Runs, with no Group or Script.

const t = std.testing;

fn bareRun() Run {
    var run: Run = undefined;
    run.waiting = null;
    run.join = null;
    run.continuing = false;
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

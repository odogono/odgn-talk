//! Waits in start order, their timer order, and Run/Join back-references.
//! The Group keeps scheduling and Trace writes.
const std = @import("std");
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const capabilities = @import("capabilities.zig");

/// A suspended Run's Wait, with its deadline in microseconds.
pub const Pending = struct {
    /// A `send … and wait`'s call id; a Capability call's is its Call's.
    id: []const u8 = "",
    run: *machine.Run,
    deadline: i128,
    /// Of equal deadlines, the earlier set fires first.
    order: u64,
    call: ?*capabilities.Call = null,
    grant: []const u8 = "",
    operation: []const u8 = "",
    decl: ?*const capabilities.Operation = null,
    after_ms: u64 = 0,
    /// For a Join Member, its index among the Join's members.
    member: ?usize = null,
    /// Whether the deadline is a Timeout Block's, whose `after` it is.
    block: bool = false,
    /// A `wait for`'s branches, and the number of the `after` branch, or 0
    /// for `or d`, that its deadline fires.
    event: ?*machine.EventWait = null,
    branch: u32 = 0,
};

/// Marks a Capability call whose wait ends without its answer abandoned.
pub fn abandonCall(p: *const Pending) void {
    if (p.call) |c| c.abandoned.store(true, .release);
}

pub const Waits = struct {
    pending: std.ArrayList(*Pending) = .empty,
    timers: u64 = 0,

    /// Runs release their Waits before the table. Any entries left after
    /// that were not yet attached to a Run or Join Member.
    pub fn deinit(self: *Waits, a: Allocator) void {
        for (self.pending.items) |p| destroy(a, p);
        self.pending.deinit(a);
    }

    /// Borrows the Waits in insertion order; callers cannot reorder them.
    pub fn items(self: *const Waits) []const *Pending {
        return self.pending.items;
    }

    pub fn order(self: *const Waits) u64 {
        return self.timers;
    }

    /// Takes the Wait's event state, including on allocation refusal.
    pub fn add(self: *Waits, a: Allocator, wait: Pending) !void {
        const p = try self.insert(a, wait);
        p.run.waiting = p;
    }

    /// Starts a Join Member without suspending its Run.
    pub fn addMember(self: *Waits, a: Allocator, run: *machine.Run, wait: Pending) !void {
        const join = run.join.?;
        var member = wait;
        member.member = join.members.items.len;
        const p = try self.insert(a, member);
        errdefer {
            self.remove(p);
            destroy(a, p);
        }
        try join.members.append(a, .{ .pending = p, .waited = .{ .id = if (p.call) |c| c.id else p.id, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms } });
    }

    fn insert(self: *Waits, a: Allocator, wait: Pending) !*Pending {
        const p = a.create(Pending) catch |e| {
            if (wait.event) |event| releaseEvent(a, event);
            return e;
        };
        self.timers += 1;
        p.* = wait;
        p.order = self.timers;
        self.pending.append(a, p) catch |e| {
            destroy(a, p);
            return e;
        };
        return p;
    }

    /// Removes a Wait without disturbing the order of the remaining Waits,
    /// and clears its back-reference. The caller still owns the Wait until
    /// it has finished using its resume/Trace metadata and calls destroy.
    /// Also accepts restored Waits not yet inserted into the table.
    pub fn remove(self: *Waits, p: *Pending) void {
        for (self.pending.items, 0..) |item, i| if (item == p) {
            _ = self.pending.orderedRemove(i);
            break;
        };
        if (p.run.waiting == p) p.run.waiting = null;
        if (p.member) |index| if (p.run.join) |join| {
            if (index < join.members.items.len and join.members.items[index].pending == p) join.members.items[index].pending = null;
        };
    }

    pub fn destroy(a: Allocator, p: *Pending) void {
        if (p.event) |event| releaseEvent(a, event);
        a.destroy(p);
    }

    /// Ends a Wait that won't be answered: detaches it, marks its Call
    /// abandoned and destroys it.
    pub fn abandon(self: *Waits, a: Allocator, p: *Pending) void {
        self.remove(p);
        abandonCall(p);
        destroy(a, p);
    }

    fn releaseEvent(a: Allocator, event: *machine.EventWait) void {
        machine.releaseHeld(event.branches, a);
        a.free(event.branches);
        a.destroy(event);
    }

    pub fn findCall(self: *const Waits, id: []const u8) ?*Pending {
        for (self.pending.items) |p| if (p.call) |call| {
            if (std.mem.eql(u8, call.id, id)) return p;
        };
        return null;
    }

    pub fn findReply(self: *const Waits, id: []const u8) ?*Pending {
        for (self.pending.items) |p| if (p.call == null and std.mem.eql(u8, p.id, id)) return p;
        return null;
    }

    /// The next due Wait, by deadline and then by the order deadlines were
    /// set. Selection leaves the Wait attached until the Group readies it.
    pub fn due(self: *const Waits, now: i128) ?*Pending {
        var first: ?*Pending = null;
        for (self.pending.items) |p| {
            if (p.deadline > now) continue;
            if (first == null or p.deadline < first.?.deadline or (p.deadline == first.?.deadline and p.order < first.?.order)) first = p;
        }
        return first;
    }

    /// Preempted Runs' Join Members aren't timers until the Join's end.
    pub fn next(self: *const Waits) ?i128 {
        var best: ?i128 = null;
        for (self.pending.items) |p| if (p.deadline != std.math.maxInt(i128) and (best == null or p.deadline < best.?)) {
            if (p.member != null and p.run.continuing) continue;
            best = p.deadline;
        };
        return best;
    }

    // The save codec restores back-references before it reads table order.
    // Keep these separate so it preserves the existing bytes and can clean
    // up a partially decoded or refused save through the usual Run teardown.
    pub fn restoreRun(_: *Waits, run: *machine.Run, p: ?*Pending) void {
        run.waiting = p;
    }

    pub fn restoreMember(_: *Waits, run: *machine.Run, index: usize, p: ?*Pending) void {
        run.join.?.members.items[index].pending = p;
    }

    pub fn restoreOrder(self: *Waits, value: u64) void {
        self.timers = value;
    }

    pub fn reserveRestore(self: *Waits, a: Allocator, count: usize) !void {
        try self.pending.ensureTotalCapacity(a, count);
    }

    pub fn restoreEntry(self: *Waits, p: *Pending) error{InvalidSave}!void {
        if (std.mem.indexOfScalar(*Pending, self.pending.items, p) != null) return error.InvalidSave;
        self.pending.appendAssumeCapacity(p);
    }
};

fn bareRun(id: []const u8) machine.Run {
    return .{ .id = id, .script = undefined, .delivery = undefined };
}

test "ordered removal clears only its Run or Join Member reference" {
    const t = std.testing;
    const a = t.allocator;
    var table: Waits = .{};
    defer table.deinit(a);
    var one = bareRun("one");
    var two = bareRun("two");
    var join: machine.Join = .{};
    defer join.members.deinit(a);
    two.join = &join;
    try table.add(a, .{ .run = &one, .deadline = 50, .order = 0 });
    const first = one.waiting.?;
    try table.addMember(a, &two, .{ .run = &two, .id = "reply", .deadline = 30, .order = 0 });
    const middle = join.members.items[0].pending.?;
    try table.add(a, .{ .run = &two, .deadline = 40, .order = 0, .block = true });
    const last = two.waiting.?;
    try t.expectEqual(@as(u64, 3), table.order());
    try t.expectEqual(middle, table.findReply("reply").?);
    table.remove(middle);
    defer Waits.destroy(a, middle);
    try t.expect(join.members.items[0].pending == null);
    try t.expectEqual(last, two.waiting.?);
    try t.expectEqualSlices(*Pending, &.{ first, last }, table.items());
    table.remove(first);
    defer Waits.destroy(a, first);
    try t.expect(one.waiting == null);
    try t.expectEqual(last, two.waiting.?);
    table.remove(last);
    defer Waits.destroy(a, last);
    try t.expect(two.waiting == null);
    try t.expectEqual(@as(usize, 0), table.items().len);
    try t.expect(table.findReply("reply") == null);
    try t.expect(table.next() == null);
}

test "Call lookup distinguishes Calls from replies with the same id" {
    const t = std.testing;
    var table: Waits = .{};
    defer table.deinit(t.allocator);
    var one = bareRun("one");
    var two = bareRun("two");
    var call: capabilities.Call = .{ .id = "one.c1", .script = "", .grant = "", .binding = null, .now = .{ .seconds = 0, .micros = 0 }, .left = null, .gpa = t.allocator };
    try table.add(t.allocator, .{ .run = &one, .id = call.id, .deadline = 50, .order = 0 });
    try table.add(t.allocator, .{ .run = &two, .call = &call, .deadline = 50, .order = 0 });
    try t.expectEqual(two.waiting.?, table.findCall(call.id).?);
    try t.expectEqual(one.waiting.?, table.findReply(call.id).?);
    try t.expect(table.findCall("missing") == null);
    try t.expect(table.findReply("missing") == null);
}

test "due Waits use deadline then timer order, not restored table order" {
    const t = std.testing;
    var table: Waits = .{};
    defer table.deinit(t.allocator);
    var runs = [_]machine.Run{ bareRun("one"), bareRun("two"), bareRun("three"), bareRun("four") };
    const deadlines = [_]i128{ 30, 20, 20, std.math.maxInt(i128) };
    for (&runs, deadlines) |*run, at| try table.add(t.allocator, .{ .run = run, .deadline = at, .order = 0 });
    const first = runs[0].waiting.?;
    const second = runs[1].waiting.?;
    const third = runs[2].waiting.?;
    table.remove(second);
    table.restoreRun(&runs[1], second);
    try table.restoreEntry(second);
    try t.expectEqualSlices(*Pending, &.{ first, third, runs[3].waiting.?, second }, table.items());
    try t.expect(table.due(19) == null);
    try t.expectEqual(@as(?i128, 20), table.next());
    try t.expectEqual(second, table.due(20).?);
    table.remove(second);
    Waits.destroy(t.allocator, second);
    try t.expectEqual(third, table.due(30).?);
    table.remove(third);
    Waits.destroy(t.allocator, third);
    try t.expectEqual(first, table.due(30).?);
    table.remove(first);
    Waits.destroy(t.allocator, first);
    try t.expect(table.next() == null);
    try t.expect(table.due(30) == null);
}

test "next deadline excludes preempted Join Members until their Run continues" {
    const t = std.testing;
    var table: Waits = .{};
    defer table.deinit(t.allocator);
    var run = bareRun("one");
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    run.join = &join;
    run.continuing = true;
    try table.addMember(t.allocator, &run, .{ .run = &run, .deadline = 10, .order = 0 });
    try t.expect(table.next() == null);
    // Due selection preserves the Pump's existing rule, which differs from
    // reporting the next deadline while a Join is preempted.
    try t.expectEqual(join.members.items[0].pending.?, table.due(10).?);
    run.continuing = false;
    try t.expectEqual(@as(?i128, 10), table.next());
}

test "restore attaches before table order, refuses duplicates and continues timer order" {
    const t = std.testing;
    const a = t.allocator;
    var table: Waits = .{};
    defer table.deinit(a);
    var run = bareRun("one");
    var other = bareRun("two");
    var join: machine.Join = .{};
    defer join.members.deinit(a);
    run.join = &join;
    try join.members.append(a, .{ .waited = .{} });
    const p = try a.create(Pending);
    p.* = .{ .run = &run, .deadline = 5, .order = 40, .member = 0 };
    table.restoreMember(&run, 0, p);
    table.restoreOrder(40);
    try table.reserveRestore(a, 1);
    try table.restoreEntry(p);
    try t.expectError(error.InvalidSave, table.restoreEntry(p));
    try table.add(a, .{ .run = &other, .deadline = 5, .order = 0 });
    try t.expectEqual(@as(u64, 41), other.waiting.?.order);
    try t.expectEqual(p, table.due(5).?);
    table.remove(p);
    Waits.destroy(a, p);
    try t.expect(join.members.items[0].pending == null);
    // Refused saves may have attached a Wait before reaching table order.
    const partial = try a.create(Pending);
    partial.* = .{ .run = &run, .deadline = 5, .order = 42 };
    table.restoreRun(&run, partial);
    table.remove(partial);
    Waits.destroy(a, partial);
    try t.expect(run.waiting == null);
}

fn allocationFailures(a: Allocator) !void {
    var table: Waits = .{};
    defer table.deinit(a);
    var run = bareRun("one");
    var join: machine.Join = .{};
    defer join.members.deinit(a);
    run.join = &join;
    const event = try a.create(machine.EventWait);
    const branches = a.alloc(machine.EventBranch, 1) catch |e| {
        a.destroy(event);
        return e;
    };
    branches[0] = .{ .after = 10 };
    event.* = .{ .entry = 0, .branches = branches, .any = false };
    try table.add(a, .{ .run = &run, .deadline = 10, .order = 0, .event = event });
    try table.addMember(a, &run, .{ .run = &run, .deadline = 20, .order = 0 });
}

test "allocation refusal releases Wait and event state" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}

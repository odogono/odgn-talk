//! A Run's lifecycle (ADR 0123): its place in its Script's live Runs and
//! work, the start and end of each Stretch, and the Fuel each Stretch adds
//! to its Script's and its Pump's totals. Which Run goes next and every Trace
//! record belong to the Group.
const std = @import("std");
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const Run = machine.Run;
const Work = machine.Work;

/// A Script's live Runs and its work, which the module keeps a Run's
/// membership of.
pub const Lists = struct {
    live: *std.ArrayList(*Run),
    work: *std.ArrayList(Work),

    pub fn of(s: *machine.Script) Lists {
        return .{ .live = &s.live, .work = &s.work };
    }
};

/// The Fuel totals a Stretch is paid into: its Pump's and its Script's.
pub const Meter = struct {
    pump_fuel: *u64,
    spent: *u64,

    /// Pays Fuel spent outside any Stretch.
    pub fn add(m: Meter, fuel: u64) void {
        m.pump_fuel.* += fuel;
        m.spent.* += fuel;
    }
};

/// What an ended Stretch spent.
pub const Stretch = struct { fuel: u64, alloc: u64 };

/// Removes a Run from its Script's live Runs and from its work.
pub fn detach(run: *Run, lists: Lists) void {
    for (lists.live.items, 0..) |r, i| if (r == run) {
        _ = lists.live.orderedRemove(i);
        break;
    };
    var i: usize = 0;
    while (i < lists.work.items.len) {
        if (lists.work.items[i] == .run and lists.work.items[i].run == run) {
            _ = lists.work.orderedRemove(i);
        } else i += 1;
    }
}

/// Puts a Run live and at the head of its Script's work, to go on before
/// anything else there. On an error the caller drops the Run, which
/// detaches whatever was added.
pub fn requeueAtHead(a: Allocator, run: *Run, lists: Lists) Allocator.Error!void {
    try lists.live.append(a, run);
    try lists.work.insert(a, 0, .{ .run = run });
}

/// Keeps a suspended Run live, off its Script's work until it is ready.
pub fn keepLive(a: Allocator, run: *Run, lists: Lists) Allocator.Error!void {
    try lists.live.append(a, run);
}

/// Starts a Stretch: what the Run has spent so far belongs to earlier ones.
pub fn startStretch(run: *Run) void {
    run.segment_fuel = run.fuel;
    run.segment_alloc = run.alloc;
}

/// The Fuel the Run's current Stretch has spent.
pub inline fn stretchFuel(run: *const Run) u64 {
    return run.fuel - run.segment_fuel;
}

/// Ends a Stretch, paying its Fuel into the Meter. The next Stretch's
/// `startStretch` resets it.
pub fn endStretch(run: *const Run, meter: Meter) Stretch {
    const ended: Stretch = .{ .fuel = stretchFuel(run), .alloc = run.alloc - run.segment_alloc };
    meter.add(ended.fuel);
    return ended;
}

/// Charges a Run paid as it goes, kept out of its current or next
/// Stretch's total.
pub fn charge(run: *Run, meter: Meter, fuel: u64) void {
    run.fuel += fuel;
    run.segment_fuel += fuel;
    meter.add(fuel);
}

/// Where a Run's refused Charge faults it (#1068): a Charge Request drained
/// while its call waits, a Join Member's reissue, or the resume of a
/// reissued call or Join Member that the Run couldn't pay for.
pub const Refusal = union(enum) {
    charge_request,
    join_reissue,
    resumed_limited,
    join_member_limited: usize,
};

/// How a refused Charge's fault goes on, which the Group carries out after
/// its `fault` record.
pub const Fault = struct {
    /// Whether the fault ends the Run's Segment, as a Stretch of its own,
    /// or the Run itself, with no `seg` record.
    end: enum { segment, run },
    /// Whether the Run's Segment base, taken while it waited, is dropped.
    drop_base: bool,
    /// The call the fault abandons, which the Group writes after it.
    abandon: ?[]const u8,
};

/// The refusal a ready Run resumes into, if its wait settled with one.
pub fn refusal(run: *const Run) ?Refusal {
    const with = run.resume_with orelse return null;
    switch (with) {
        .limited => return .resumed_limited,
        .join_failed => |i| {
            const x = run.join.?.members.items[i];
            if (x.with != null and x.with.? == .limited) return .{ .join_member_limited = i };
        },
        else => {},
    }
    return null;
}

/// The one path that faults a Run whose Charge was refused: it settles the
/// Run's state and lists for the fault and says how it ends.
pub fn faultCharge(run: *Run, lists: Lists, how: Refusal) Fault {
    switch (how) {
        // Its rollback may pause at a crossing, so the Group ends the Run
        // once that completes.
        .charge_request => return .{ .end = .run, .drop_base = !run.continuing, .abandon = null },
        .join_reissue => {
            const drop_base = !run.continuing;
            // The fault is a Stretch of its own, as a resume is, with
            // nothing charged in it. An ending that pauses requeues the
            // Run, so it leaves its lists first.
            run.continuing = false;
            startStretch(run);
            detach(run, lists);
            return .{ .end = .segment, .drop_base = drop_base, .abandon = null };
        },
        // Settlement already took the Wait, so the fault names the call.
        .resumed_limited => {
            run.resume_with = null;
            return .{ .end = .segment, .drop_base = false, .abandon = run.waited.id };
        },
        .join_member_limited => |i| {
            run.resume_with = null;
            const x = &run.join.?.members.items[i];
            x.with = null;
            return .{ .end = .segment, .drop_base = false, .abandon = x.waited.id };
        },
    }
}

/// Charges a suspended Run paid as it goes, before its next Stretch, which
/// starts from its Fuel then.
pub fn chargeSuspended(run: *Run, meter: Meter, fuel: u64) void {
    run.fuel += fuel;
    meter.add(fuel);
}

// Tests on bare Runs, with no Group or Script.

const t = std.testing;

fn bareRun() Run {
    var run: Run = undefined;
    run.fuel = 0;
    run.alloc = 0;
    run.segment_fuel = 0;
    run.segment_alloc = 0;
    run.continuing = false;
    run.resume_with = null;
    run.waited = .{};
    run.join = null;
    return run;
}

const TestLists = struct {
    live: std.ArrayList(*Run) = .empty,
    work: std.ArrayList(Work) = .empty,

    fn lists(l: *TestLists) Lists {
        return .{ .live = &l.live, .work = &l.work };
    }

    fn deinit(l: *TestLists) void {
        l.live.deinit(t.allocator);
        l.work.deinit(t.allocator);
    }

    fn runsInWork(l: *const TestLists, run: *const Run) usize {
        var n: usize = 0;
        for (l.work.items) |w| if (w == .run and w.run == run) {
            n += 1;
        };
        return n;
    }
};

test "a Run requeued at the head of its work goes before what was there" {
    var l: TestLists = .{};
    defer l.deinit();
    var first = bareRun();
    var second = bareRun();
    try requeueAtHead(t.allocator, &first, l.lists());
    try requeueAtHead(t.allocator, &second, l.lists());
    try t.expectEqual(&second, l.work.items[0].run);
    try t.expectEqual(&first, l.work.items[1].run);
    try t.expectEqual(@as(usize, 2), l.live.items.len);
}

test "detaching a Run removes it from live and every work entry, and nothing else" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    var other = bareRun();
    try keepLive(t.allocator, &other, l.lists());
    try requeueAtHead(t.allocator, &run, l.lists());
    // An ending paused again at a crossing requeues a Run already queued.
    try l.work.append(t.allocator, .{ .run = &run });
    try l.work.append(t.allocator, .{ .run = &other });
    detach(&run, l.lists());
    try t.expectEqual(@as(usize, 0), l.runsInWork(&run));
    try t.expectEqual(@as(usize, 1), l.runsInWork(&other));
    try t.expectEqual(@as(usize, 1), l.live.items.len);
    try t.expectEqual(&other, l.live.items[0]);
    // Detaching twice finds nothing more to remove.
    detach(&run, l.lists());
    try t.expectEqual(@as(usize, 1), l.work.items.len);
}

test "a suspended Run is kept live but not in its work" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    try keepLive(t.allocator, &run, l.lists());
    try t.expectEqual(@as(usize, 1), l.live.items.len);
    try t.expectEqual(@as(usize, 0), l.work.items.len);
}

test "an ended Stretch pays its Fuel once, and the next starts from zero" {
    var pump: u64 = 0;
    var spent: u64 = 0;
    const meter: Meter = .{ .pump_fuel = &pump, .spent = &spent };
    var run = bareRun();
    run.fuel = 30;
    run.alloc = 7;
    const ended = endStretch(&run, meter);
    try t.expectEqual(Stretch{ .fuel = 30, .alloc = 7 }, ended);
    try t.expectEqual(@as(u64, 30), pump);
    try t.expectEqual(@as(u64, 30), spent);
    startStretch(&run);
    try t.expectEqual(@as(u64, 0), stretchFuel(&run));
    run.fuel += 5;
    try t.expectEqual(Stretch{ .fuel = 5, .alloc = 0 }, endStretch(&run, meter));
    try t.expectEqual(@as(u64, 35), pump);
}

test "a Charge paid as it goes is kept out of the Stretch's total" {
    var pump: u64 = 0;
    var spent: u64 = 0;
    const meter: Meter = .{ .pump_fuel = &pump, .spent = &spent };
    var run = bareRun();
    run.fuel = 10;
    charge(&run, meter, 4);
    try t.expectEqual(@as(u64, 14), run.fuel);
    try t.expectEqual(@as(u64, 10), stretchFuel(&run));
    try t.expectEqual(@as(u64, 4), pump);
    try t.expectEqual(@as(u64, 4), spent);
}

test "a suspended Run's Charge is paid, and its next Stretch starts after it" {
    var pump: u64 = 0;
    var spent: u64 = 0;
    const meter: Meter = .{ .pump_fuel = &pump, .spent = &spent };
    var run = bareRun();
    chargeSuspended(&run, meter, 6);
    try t.expectEqual(@as(u64, 6), run.fuel);
    try t.expectEqual(@as(u64, 6), pump);
    startStretch(&run);
    try t.expectEqual(Stretch{ .fuel = 0, .alloc = 0 }, endStretch(&run, meter));
    try t.expectEqual(@as(u64, 6), pump);
}

test "a Charge refused while its call waits ends the Run, with no Stretch or abandon" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    run.fuel = 40;
    run.segment_fuel = 10;
    try keepLive(t.allocator, &run, l.lists());
    const f = faultCharge(&run, l.lists(), .charge_request);
    try t.expectEqual(.run, f.end);
    try t.expect(f.drop_base);
    try t.expectEqual(@as(?[]const u8, null), f.abandon);
    // The Run stays where it was until it ends; its Stretch is untouched.
    try t.expectEqual(@as(usize, 1), l.live.items.len);
    try t.expectEqual(@as(u64, 30), stretchFuel(&run));
}

test "a Join Member's refused reissue faults in a Stretch of its own, detached" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    run.fuel = 50;
    run.segment_fuel = 20;
    run.continuing = true;
    try requeueAtHead(t.allocator, &run, l.lists());
    const f = faultCharge(&run, l.lists(), .join_reissue);
    try t.expectEqual(.segment, f.end);
    // A preempted Run's base is its Segment's, which the fault rolls back to.
    try t.expect(!f.drop_base);
    try t.expect(!run.continuing);
    try t.expectEqual(@as(u64, 0), stretchFuel(&run));
    try t.expectEqual(@as(usize, 0), l.live.items.len);
    try t.expectEqual(@as(usize, 0), l.work.items.len);
}

test "a resumed refusal names the call it abandons" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    run.waited = .{ .id = "c1" };
    run.resume_with = .limited;
    try t.expectEqual(Refusal.resumed_limited, refusal(&run).?);
    const f = faultCharge(&run, l.lists(), refusal(&run).?);
    try t.expectEqual(.segment, f.end);
    try t.expectEqualStrings("c1", f.abandon.?);
    try t.expectEqual(@as(?machine.Resume, null), run.resume_with);
    try t.expectEqual(@as(?Refusal, null), refusal(&run));
}

test "a Join that failed on a refused member names that member" {
    var l: TestLists = .{};
    defer l.deinit();
    var run = bareRun();
    var join: machine.Join = .{};
    defer join.members.deinit(t.allocator);
    try join.members.append(t.allocator, .{ .pending = null, .waited = .{ .id = "c1" }, .with = .broken });
    try join.members.append(t.allocator, .{ .pending = null, .waited = .{ .id = "c2" }, .with = .limited });
    run.join = &join;
    // A Join failed by another failure isn't a refusal.
    run.resume_with = .{ .join_failed = 0 };
    try t.expectEqual(@as(?Refusal, null), refusal(&run));
    run.resume_with = .{ .join_failed = 1 };
    const f = faultCharge(&run, l.lists(), refusal(&run).?);
    try t.expectEqualStrings("c2", f.abandon.?);
    try t.expectEqual(@as(?machine.Resume, null), join.members.items[1].with);
    try t.expectEqual(@as(?machine.Resume, null), run.resume_with);
}

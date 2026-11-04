//! `wait` in Musical Units (chapter 5) calls the Group's musical clock, the
//! reserved `musical clock` Grant's suspending `wait` (chapter 9, ADR 0166).
const std = @import("std");
const machine = @import("machine.zig");
const caps = @import("capabilities.zig");
const model = @import("../value.zig");
const snapshot = @import("snapshot.zig");
const t = std.testing;
const clock: model.dates.Instant = .{ .seconds = 0, .micros = 0 };

/// A scripted musical clock: it records each call and answers when told.
const Host = struct {
    shape: caps.Shape = .{ .allocator = t.allocator, .data = .{ .kind = .any } },
    args: [1]*caps.Shape = undefined,
    ops: [1]caps.Operation = undefined,
    kept: [1]bool = .{true},
    capability: caps.Capability = undefined,
    grant: caps.Grant = undefined,
    named: [1]machine.NamedGrant = undefined,
    calls: std.ArrayList(*caps.Call) = .empty,

    fn init(h: *Host) void {
        h.args = .{&h.shape};
        h.ops = .{.{ .name = "wait", .args = &h.args, .result = null, .mode = .suspending, .cost = .{}, .host = .{ .call = callback, .context = h } }};
        h.capability = .{ .name = "transport", .operations = &h.ops };
        h.grant = .{ .capability = &h.capability, .operations = &h.kept };
        h.named = .{.{ .name = machine.musical_clock, .grant = &h.grant }};
    }
    fn deinit(h: *Host) void {
        h.calls.deinit(t.allocator);
    }
    fn callback(context: ?*anyopaque, call: *caps.Call, _: []const *model.Value) caps.Outcome {
        const h: *Host = @ptrCast(@alignCast(context.?));
        h.calls.append(t.allocator, call) catch return .broken;
        return .started;
    }
};

fn rebind(context: ?*anyopaque, _: []const u8, _: []const u8) ?*caps.Grant {
    const h: *Host = @ptrCast(@alignCast(context.?));
    return &h.grant;
}

fn contains(trace: *std.Io.Writer.Allocating, text: []const u8) !void {
    if (std.mem.indexOf(u8, trace.written(), text) == null) {
        std.debug.print("missing {s} in:\n{s}", .{ text, trace.written() });
        return error.TestExpectedEqual;
    }
}

fn endReport(g: *machine.Group) !machine.report.RunEnd {
    for (g.reports.list.items) |r| if (r == .run_end) return r.run_end;
    return error.TestExpectedEqual;
}

fn raised(g: *machine.Group) ![]const u8 {
    const end = try endReport(g);
    try t.expectEqual(.errored, end.outcome);
    return end.err.?.get("code").?.data.text;
}

test "a musical wait without a musical clock raises no musical time" {
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    try t.expect(try g.load("s", "on go\n wait 2 bars\nend go\n", .{}) == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    try t.expectEqualStrings("no musical time", try raised(&g));
}

test "a musical wait counts whole bars and beats, 0 or more" {
    var h: Host = .{};
    h.init();
    defer h.deinit();
    for ([_][]const u8{ "1.5 bars", "-1 beat", "1 bar / 4" }) |count| {
        var g: machine.Group = .init(t.allocator, null);
        defer g.deinit();
        const text = try std.fmt.allocPrint(t.allocator, "on go\n wait {s}\nend go\n", .{count});
        defer t.allocator.free(text);
        try t.expect(try g.load("s", text, .{ .grants = &h.named }) == .loaded);
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(clock);
        try t.expectEqualStrings("out of domain", try raised(&g));
        const end = try endReport(&g);
        try t.expectEqualStrings("wait", end.err.?.get("function").?.data.text);
    }
    try t.expectEqual(@as(usize, 0), h.calls.items.len);

    // `wait 0 bars` neither suspends nor calls the clock, and leaves `it`.
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    try t.expect(try g.load("s", "function seven\n return 7\nend seven\non go\n seven()\n wait 0 bars\n wait 4 beats / 2 - 2 beats\n return it\nend go\n", .{ .grants = &h.named }) == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    const end = try endReport(&g);
    try t.expectEqual(.completed, end.outcome);
    try t.expectEqual(@as(u128, 7), end.result.?.data.number.coefficient);
    try t.expectEqual(@as(usize, 0), h.calls.items.len);
}

test "a musical wait calls the musical clock and resumes on its answer" {
    var h: Host = .{};
    h.init();
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    const loaded = try g.load("s", "function seven\n return 7\nend seven\non go\n seven()\n wait 8 bars\n return it\nend go\n", .{ .grants = &h.named, .grants_as_used = true, .limits = .{ .max_wait_ms = 1 } });
    try t.expect(loaded == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    try t.expectEqual(@as(usize, 1), h.calls.items.len);
    try contains(&trace, "call s/r1.c1 op=musical clock.wait args=[8 bars]");
    // No `maxPending` and no `MaxWait`: the wait has no deadline.
    try t.expect(g.nextInstant() == null);
    try g.pump(.{ .seconds = 3600, .micros = 0 });
    try t.expectEqual(@as(usize, 1), loaded.loaded.live.items.len);

    const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
    defer t.allocator.free(bytes);
    var copy: machine.Group = .init(t.allocator, null);
    defer copy.deinit();
    var result: snapshot.Result = .{};
    defer result.deinit(t.allocator);
    try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &h, .call = rebind } }, &result));
    try t.expectEqual(@as(usize, 1), copy.restored.?.pending.items.len);

    // Host revocation can't name the musical clock.
    try g.revoke("s", machine.musical_clock);
    const answer = try model.scalar(t.allocator, .nothing);
    defer answer.release();
    try g.settle(h.calls.items[0].id, .{ .answer = .{ .value = answer.retain(), .fuel = 0 } });
    try g.pump(.{ .seconds = 3601, .micros = 0 });
    const end = try endReport(&g);
    try t.expectEqual(.completed, end.outcome);
    try t.expectEqual(@as(u128, 7), end.result.?.data.number.coefficient);
}

test "Stop abandons a pending musical wait" {
    var h: Host = .{};
    h.init();
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    try t.expect(try g.load("s", "on go\n wait 1 beat\nend go\n", .{ .grants = &h.named }) == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    try g.stopInput("s", "requested");
    try g.pump(clock);
    try contains(&trace, "abandoned=[s/r1.c1]");
}

test "Musical Quantities refuse Compound Units and mixing Kinds" {
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    for ([_][]const u8{ "1 bar / 1 min", "1 bar + 2 beats", "1 bar + 500 ms", "1 bar * 1 bar" }) |expression| {
        const text = try std.fmt.allocPrint(t.allocator, "on go\n return {s}\nend go\n", .{expression});
        defer t.allocator.free(text);
        g.deinit();
        g = .init(t.allocator, null);
        try t.expect(try g.load("s", text, .{}) == .loaded);
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(clock);
        try t.expectEqualStrings("incompatible units", try raised(&g));
    }
}

test "a Timeout Block's deadline ends a musical wait with timeout" {
    var h: Host = .{};
    h.init();
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    try t.expect(try g.load("s", "on go\n with timeout of 1 s\n  wait 4 bars\n end timeout\nend go\n", .{ .grants = &h.named }) == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    try t.expectEqual(@as(i64, 1), g.nextInstant().?.seconds);
    try g.pump(.{ .seconds = 1, .micros = 0 });
    try t.expectEqualStrings("timeout", try raised(&g));
    try contains(&trace, "abandon s/r1.c1");
}

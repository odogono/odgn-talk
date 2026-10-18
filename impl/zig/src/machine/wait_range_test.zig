//! Wait deadlines are mathematical microsecond counts, even outside the
//! Clock range (#1064). They suspend and charge without narrowing to Instants.
const std = @import("std");
const machine = @import("machine.zig");
const snapshot = @import("snapshot.zig");
const t = std.testing;

test "a wait beyond the Clock range suspends and charges without trapping" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    const loaded = try g.load("s", "on nap\n wait 1000000000000000000000000000000000 s\nend nap\n", .{});
    try t.expect(loaded == .loaded);
    _ = try g.deliver("s", "nap", &.{}, true);
    try g.pump(.{ .seconds = 0, .micros = 0 });
    try t.expectEqual(@as(u64, 15), g.pump_fuel);
    try t.expect(g.nextInstant() == null);
    try t.expect(g.next() != null);
    try t.expectEqual(@as(usize, 1), loaded.loaded.live.items.len);
    try t.expect(loaded.loaded.live.items[0].waiting != null);
    try t.expect(std.mem.indexOf(u8, trace.written(), "end=wait") != null);
    try t.expect(std.mem.indexOf(u8, trace.written(), "until=") == null);
    try g.pump(.{ .seconds = 1, .micros = 0 });
    try t.expectEqual(@as(u64, 0), g.pump_fuel);
    const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
    defer t.allocator.free(bytes);
    var restored: machine.Group = .init(t.allocator, null);
    defer restored.deinit();
    var result: snapshot.Result = .{};
    defer result.deinit(t.allocator);
    try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&restored, bytes, .{}, &result));
    try restored.pump(.{ .seconds = 2, .micros = 0 });
    try t.expectEqual(@as(u64, 0), restored.pump_fuel);
    try t.expect(restored.scripts.items[0].live.items[0].waiting != null);
}

test "negative deadlines outside the Clock range retain exact timer order" {
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    try t.expect(try g.load("s", "on nap\n wait for\n after -1000000000000000000000000000000000 s then\n return 1\n after -2000000000000000000000000000000000 s then\n return 2\n end wait\nend nap", .{}) == .loaded);
    _ = try g.deliver("s", "nap", &.{}, true);
    try g.pump(.{ .seconds = 0, .micros = 0 });
    try t.expectEqual(@as(i64, 0), g.nextInstant().?.seconds);
    try t.expectEqual(@as(usize, 1), g.scripts.items[0].live.items.len);
    try g.pump(.{ .seconds = 0, .micros = 0 });
    for (g.reports.list.items) |r| if (r == .run_end) {
        try t.expectEqual(@as(u128, 2), r.run_end.result.?.data.number.coefficient);
        return;
    };
    return error.TestExpectedEqual;
}

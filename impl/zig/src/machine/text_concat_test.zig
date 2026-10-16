//! Text metadata is reconstructed from saved bytes, with the same charges,
//! retained operands and contiguous results at each instruction boundary.
const std = @import("std");
const machine = @import("machine.zig");
const snapshot = @import("snapshot.zig");

test "Text growth keeps exact accounting and old Values through Save/Restore" {
    const a = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    const source =
        \\script variable original = `a\r`
        \\script variable built = ""
        \\on go
        \\  put original into built
        \\  put built & `\nb` into built
        \\  put built & "e" into built
        \\  put built & "́" into built
        \\  put built & "👨‍" into built
        \\  put built & "👩‍👧" into built
        \\  return [original, built, the length of original, the length of built, character 2 of built, character -1 of built]
        \\end go
        \\
    ;
    const loaded = try g.load("s", source, .{});
    if (loaded != .loaded) std.debug.print("{s}\n", .{out.written()});
    try std.testing.expect(loaded == .loaded);
    const requested = try g.deliver("s", "go", &.{}, true);
    const clock: @import("../dates.zig").Instant = .{ .seconds = 0, .micros = 0 };
    for (0..1000) |_| {
        const fingerprint = try g.groupFingerprint();
        const bytes = try snapshot.save(&g, a, fingerprint);
        defer a.free(bytes);
        var copied: std.Io.Writer.Allocating = .init(a);
        defer copied.deinit();
        var copy: machine.Group = .init(a, &copied.writer);
        defer copy.deinit();
        var result: snapshot.Result = .{};
        defer result.deinit(a);
        try std.testing.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{}, &result));
        const resaved = try snapshot.save(&copy, a, fingerprint);
        defer a.free(resaved);
        try std.testing.expectEqualSlices(u8, bytes, resaved);
        out.writer.end = 0;
        copied.writer.end = 0;
        try g.pumpWith(clock, 1, 0);
        try copy.pumpWith(clock, 1, 0);
        try std.testing.expectEqualStrings(out.written(), copied.written());
        if (g.results.get(requested)) |value| {
            try std.testing.expect(try value.equal(copy.results.get(requested).?));
            const items = value.data.list;
            try std.testing.expectEqual(@as(usize, 6), items.len);
            try std.testing.expectEqualStrings("a\r", items[0].data.text);
            try std.testing.expectEqualStrings("a\r\nbé👨‍👩‍👧", items[1].data.text);
            try std.testing.expectEqual(@as(i64, 2), try items[2].data.number.integer(i64));
            try std.testing.expectEqual(@as(i64, 5), try items[3].data.number.integer(i64));
            try std.testing.expectEqualStrings("\r\n", items[4].data.text);
            try std.testing.expectEqualStrings("👨‍👩‍👧", items[5].data.text);
            return;
        }
    }
    std.debug.print("Text growth did not complete: {s}\n", .{out.written()});
    return error.TestUnexpectedResult;
}

//! Local write ownership boundaries: a dead lowering temp still holds a
//! canonical local Value, including across preemption and Save/Restore.
const std = @import("std");
const machine = @import("machine.zig");
const snapshot = @import("snapshot.zig");
const display = @import("../display.zig");
const model = @import("../value.zig");
const testing = std.testing;

test "local List writes retain old wholes at instruction and restored boundaries" {
    const a = testing.allocator;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    const source =
        \\on go
        \\  put [1, 2] into values
        \\  put values into original
        \\  put 3 into item 1 of values
        \\  put 4 into item 2 of values
        \\  wait 1 s
        \\  return [original, values]
        \\end go
        \\
    ;
    const loaded = try g.load("s", source, .{});
    if (loaded != .loaded) std.debug.print("{s}\n", .{out.written()});
    try testing.expect(loaded == .loaded);
    _ = try g.deliver("s", "go", &.{}, false);
    const clock: @import("../dates.zig").Instant = .{ .seconds = 0, .micros = 0 };
    try g.pumpWith(clock, 1, 0);
    var writes: usize = 0;
    var released_temp_seen = false;
    var suspended = false;
    for (0..200) |_| {
        const s = g.script("s").?;
        try testing.expectEqual(@as(usize, 1), s.live.items.len);
        const run = s.live.items[0];
        const frame = &run.frames.items[0];
        const ins = s.unit.code[frame.pc];
        if (ins.op == .chunk_set) {
            // Before chunks.set's own retain: source local, whole temp and
            // operand stack already own the root. Last-use load alone cannot
            // make this unique, even on the second write.
            const whole = frame.stack.items[frame.stack.items.len - 2].value;
            try testing.expect(whole.references >= 3);
            const shown = try display.string(a, whole);
            defer a.free(shown);
            try testing.expectEqualStrings(if (writes == 0) "[1, 2]" else "[3, 2]", shown);
            writes += 1;
        }
        if (ins.op == .wait) {
            // Frame.write has released all of its compile-time temp slots,
            // but [3, 2] still lives in a runtime local after values=[3, 4].
            for (frame.locals, 0..) |v, i| {
                const shown = try display.string(a, v);
                defer a.free(shown);
                if (std.mem.eql(u8, shown, "[3, 2]")) {
                    released_temp_seen = true;
                    const before = g.counters(s).persistent_state;
                    const nothing = try model.scalar(a, .nothing);
                    defer nothing.release();
                    // Simulate retirement without releasing the old owner.
                    // Its canonical logical size must still be represented.
                    frame.locals[i] = nothing;
                    const after = g.counters(s).persistent_state;
                    frame.locals[i] = v;
                    try testing.expectEqual(model.logicalSize(v) - model.logicalSize(nothing), before - after);
                    try testing.expect(before > after);
                }
            }
        }
        const fingerprint = try g.groupFingerprint();
        const bytes = try snapshot.save(&g, a, fingerprint);
        defer a.free(bytes);
        var copied: std.Io.Writer.Allocating = .init(a);
        defer copied.deinit();
        var copy: machine.Group = .init(a, &copied.writer);
        defer copy.deinit();
        var result: snapshot.Result = .{};
        defer result.deinit(a);
        try testing.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{}, &result));
        const restored = copy.script("s").?.live.items[0];
        for (frame.locals, restored.frames.items[0].locals) |v, restored_v| {
            const shown = try display.string(a, v);
            defer a.free(shown);
            const restored_shown = try display.string(a, restored_v);
            defer a.free(restored_shown);
            try testing.expectEqualStrings(shown, restored_shown);
        }
        out.writer.end = 0;
        copied.writer.end = 0;
        try g.pumpWith(clock, 1, 0);
        try copy.pumpWith(clock, 1, 0);
        try testing.expectEqualStrings(out.written(), copied.written());
        if (std.mem.indexOf(u8, out.written(), "pumped state=idle") != null) {
            // Complete both suspended continuations from the same clock.
            out.writer.end = 0;
            copied.writer.end = 0;
            try g.pump(.{ .seconds = 1, .micros = 0 });
            try copy.pump(.{ .seconds = 1, .micros = 0 });
            try testing.expectEqualStrings(out.written(), copied.written());
            try testing.expect(std.mem.indexOf(u8, out.written(), "[[1, 2], [3, 4]]") != null);
            suspended = true;
            break;
        }
    }
    try testing.expectEqual(@as(usize, 2), writes);
    try testing.expect(released_temp_seen);
    try testing.expect(suspended);
}

test "repeated List point writes preserve the original and exact charges across Fuel Slices" {
    const a = testing.allocator;
    const source =
        \\on run n
        \\  put [1, 2, 3, 4, 5, 6, 7, 8] into values
        \\  put values into original
        \\  repeat for each i in 1..n
        \\    put i into item 1 of values
        \\  end repeat
        \\  return item 1 of original + item 1 of values
        \\end run
    ;
    const n = try model.scalar(a, .{ .number = .fromInt(1500) });
    defer n.release();
    for ([_]u64{ 0, 100 }) |slice| {
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var g: machine.Group = .init(a, &out.writer);
        defer g.deinit();
        try testing.expect(try g.load("s", source, .{}) == .loaded);
        var args = [_]*model.Value{n.retain()};
        const requested = try g.deliver("s", "run", &args, true);
        for (0..1000) |_| {
            try g.pumpWith(.{ .seconds = 0, .micros = 0 }, slice, 0);
            if (g.results.get(requested)) |result| {
                try testing.expectEqual(@as(i64, 1501), try result.data.number.integer(i64));
                try testing.expect(std.mem.indexOf(u8, out.written(), "fuel=28553 alloc=24328") != null);
                break;
            }
        } else return error.TestUnexpectedResult;
    }
}

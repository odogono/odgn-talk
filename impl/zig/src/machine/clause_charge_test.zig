//! Dispatch's `clause` rate for a Command Call's clause (chapter 8,
//! Charging): it is charged with the clause body's first instruction, so a
//! first instruction that faults on its own limit charges neither.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");

const testing = std.testing;

test "a Command Call's clause is charged with its body's first instruction" {
    const gpa = testing.allocator;
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    var g: machine.Group = .init(gpa, &out.writer);
    defer g.deinit();
    // `spin` calls itself until the call depth limit, 200 frames. The
    // dispatched clause pays 4 with its first instruction; each of the 199
    // calls that fit pays its own 8, and the clause it enters 4 with that
    // clause's first instruction, which for the 200th frame is the call
    // that faults, so that clause is never charged: 4 + 199 * 8 + 198 * 4.
    try testing.expect(try g.load("s", "on spin\n  spin\nend spin\n", .{}) == .loaded);
    _ = try g.deliver("s", "spin", &.{}, false);
    try g.pump(.{ .seconds = 1790000000, .micros = 0 });
    const trace = out.written();
    if (std.mem.indexOf(u8, trace, "run s/r1 outcome=limit-fault delivery=d1 handler=spin limit=depth fuel=2388 alloc=0") == null) {
        std.debug.print("{s}\n", .{trace});
        return error.TestUnexpectedResult;
    }
}

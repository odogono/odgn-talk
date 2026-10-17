//! An error Run's message metadata belongs to the Run, including local calls.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");
const display = @import("../display.zig");
const testing = std.testing;

test "during survives local clause selection, helper calls and Lambda capture" {
    const source =
        \\script variable fn
        \\script variable caught
        \\on fail x
        \\  throw "mine"
        \\end fail
        \\on error "mine", during msg
        \\  put given: msg into fn
        \\  forward
        \\end error
        \\on forward
        \\  error {code: "local"}
        \\end forward
        \\on error "local" where false, during msg
        \\  throw "unreachable"
        \\end error
        \\on error "local", during msg
        \\  put [msg, fn()] into caught
        \\end error
        \\on read
        \\  return caught
        \\end read
        \\
    ;
    const gpa = testing.allocator;
    for ([_]u64{ 0, 1 }) |slice| {
        var g: machine.Group = .init(gpa, null);
        defer g.deinit();
        try testing.expect(try g.load("s", source, .{}) == .loaded);
        // An internal error carries the failed message, including arguments.
        var args = [_]*model.Value{try model.scalar(gpa, .{ .number = model.Decimal.fromInt(7) })};
        _ = try g.deliver("s", "fail", &args, false);
        try drain(&g, slice);
        try expectCaught(&g, "[{name: \"fail\", args: [7]}, {name: \"fail\", args: [7]}]");

        // A later Host error has no metadata, even after the internal error.
        const code = try model.text(gpa, "mine");
        defer code.release();
        var host_args = [_]*model.Value{try model.map(gpa, &.{.{ .key = "code", .value = code }})};
        _ = try g.deliver("s", "error", &host_args, false);
        try drain(&g, slice);
        try expectCaught(&g, "[nothing, nothing]");
    }
}

fn drain(g: *machine.Group, slice: u64) !void {
    for (0..200) |_| {
        try g.pumpWith(.{ .seconds = 0, .micros = 0 }, slice, slice);
        if (g.script("s").?.live.items.len == 0 and g.script("s").?.work.items.len == 0) return;
    }
    return error.TestUnexpectedResult;
}

fn expectCaught(g: *machine.Group, expected: []const u8) !void {
    const id = try g.deliver("s", "read", &.{}, true);
    try g.pump(.{ .seconds = 0, .micros = 0 });
    const result = g.results.get(id) orelse return error.TestUnexpectedResult;
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try display.write(&out.writer, result);
    try testing.expectEqualStrings(expected, out.written());
}

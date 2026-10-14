//! Reparse canonical Text Pattern sources for the Value Encoding. The
//! matcher's reader (machine/matcher.zig) checks them, keeping open
//! constructs on a heap stack, so nesting is bounded by memory alone.
//! Resolved splices can contain only nested patterns or parenthesized
//! display text.
const std = @import("std");
const model = @import("value.zig");
const matcher = @import("machine/matcher.zig");
/// A pattern value from its canonical source, which must read whole.
pub fn parse(a: std.mem.Allocator, source: []const u8) model.Error!*model.Value {
    const unicode = @import("unicode/unicode.zig");
    if (!unicode.utf8.validate(source)) return error.InvalidValue;
    const normal = try unicode.nfc(a, source);
    errdefer a.free(normal);
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    _ = matcher.read(arena.allocator(), normal, false) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    return model.scalar(a, .{ .pattern = normal });
}
test "canonical sources are reparsed, resolved text splices and deep nesting read" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "<>", "<\"ID-\", 4 digits>", "< <4 digits>, \"x\">", "<last: word, \", \", first: word>", "<(quote & \"x\"), optional digit>", "<one or more of uppercase letters lazily>" }) |s| {
        const v = try parse(a, s);
        defer v.release();
        try std.testing.expectEqualStrings(s, v.data.pattern);
    }
    for ([_][]const u8{ "<nonsense>", "<1.5 digits>", "<optional>", "<line>", "<a map>", "<\"x\",>", "<digit> trailing" }) |s| try std.testing.expectError(error.InvalidValue, parse(a, s));
    var deep: std.ArrayList(u8) = .empty;
    defer deep.deinit(a);
    for (0..10_000) |_| try deep.appendSlice(a, "< ");
    try deep.appendSlice(a, "<digit>");
    try deep.appendNTimes(a, '>', 10_000);
    const v = try parse(a, deep.items);
    defer v.release();
    try std.testing.expectEqualStrings(deep.items, v.data.pattern);
}

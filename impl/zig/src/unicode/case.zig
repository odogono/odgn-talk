//! Simple case folding for `ignoring case`: statuses C and S of
//! CaseFolding.txt, scalar by scalar, with no locale (chapter 3).

const std = @import("std");
const Allocator = std.mem.Allocator;
const properties = @import("properties.zig");
const utf8 = @import("utf8.zig");

pub const fold = properties.fold;

/// The simple case folding of valid UTF-8, newly allocated. The result isn't
/// normalised: `ignoring case` compares foldings as they are.
pub fn foldText(gpa: Allocator, text: []const u8) Allocator.Error![]u8 {
    var size: usize = 0;
    var it: utf8.Iterator = .{ .bytes = text };
    while (it.next()) |scalar| size += utf8.encodedLength(fold(scalar));
    const result = try gpa.alloc(u8, size);
    var at: usize = 0;
    it = .{ .bytes = text };
    while (it.next()) |scalar| at += utf8.encode(fold(scalar), result[at..]);
    return result;
}

test "foldText uses simple foldings only" {
    const gpa = std.testing.allocator;
    const cases = [_][2][]const u8{
        .{ "Hello", "hello" },
        .{ "\u{03A3}\u{03C2}", "\u{03C3}\u{03C3}" },
        .{ "\u{00DF}", "\u{00DF}" }, // ß folds to ss only under status F
        .{ "\u{1E9E}", "\u{00DF}" }, // ẞ folds to ß under status S
        .{ "\u{0130}", "\u{0130}" }, // İ has only F and T foldings
    };
    for (cases) |case| {
        const result = try foldText(gpa, case[0]);
        defer gpa.free(result);
        try std.testing.expectEqualStrings(case[1], result);
    }
}

//! `word` and the `word break` anchor (chapter 4). A Character is White_Space
//! when its first scalar is, and a word is a longest run of Characters that
//! aren't.

const std = @import("std");
const grapheme = @import("grapheme.zig");
const properties = @import("properties.zig");
const utf8 = @import("utf8.zig");

/// Whether the Character starting at `start` of valid UTF-8 is White_Space.
pub fn isWhiteSpaceAt(text: []const u8, start: usize) bool {
    return properties.isWhiteSpace(utf8.decode(text, start));
}

/// Iterates over the words of valid UTF-8 as byte slices.
pub const Iterator = struct {
    text: []const u8,
    i: usize = 0,

    pub fn next(it: *Iterator) ?[]const u8 {
        while (it.i < it.text.len and isWhiteSpaceAt(it.text, it.i)) {
            it.i = grapheme.end(it.text, it.i);
        }
        if (it.i >= it.text.len) return null;
        const start = it.i;
        while (it.i < it.text.len and !isWhiteSpaceAt(it.text, it.i)) {
            it.i = grapheme.end(it.text, it.i);
        }
        return it.text[start..it.i];
    }
};

/// Whether `word break` holds at `at`, a Character boundary of valid UTF-8
/// whose preceding Character starts at `previous` (ignored when `at` is 0):
/// a Character on one side isn't White_Space, and the other side is a
/// White_Space Character or an end of the text.
pub fn isWordBreak(text: []const u8, previous: usize, at: usize) bool {
    const before: ?bool = if (at == 0) null else isWhiteSpaceAt(text, previous);
    const after: ?bool = if (at >= text.len) null else isWhiteSpaceAt(text, at);
    const word_before = before == false;
    const word_after = after == false;
    return word_before != word_after;
}

test "words split on White_Space Characters only" {
    var it: Iterator = .{ .text = " cat, dog\u{3000}e\u{0301}\n" };
    try std.testing.expectEqualStrings("cat,", it.next().?);
    try std.testing.expectEqualStrings("dog", it.next().?);
    try std.testing.expectEqualStrings("e\u{0301}", it.next().?);
    try std.testing.expectEqual(@as(?[]const u8, null), it.next());
    var empty: Iterator = .{ .text = "" };
    try std.testing.expectEqual(@as(?[]const u8, null), empty.next());
}

test "word break holds at either end of every word" {
    const text = "cat, dog";
    var holds: [text.len + 1]bool = undefined;
    var previous: usize = 0;
    var at: usize = 0;
    while (true) {
        holds[at] = isWordBreak(text, previous, at);
        if (at == text.len) break;
        previous = at;
        at = grapheme.end(text, at);
    }
    // Before c, after the comma, before d and after g; never between t and the comma.
    const expected = [_]bool{ true, false, false, false, true, true, false, false, true };
    try std.testing.expectEqualSlices(bool, &expected, &holds);
    try std.testing.expect(!isWordBreak("", 0, 0));
    try std.testing.expect(!isWordBreak("  ", 0, 1));
}

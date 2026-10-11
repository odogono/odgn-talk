//! Character boundaries: UAX #29 extended grapheme clusters, rules GB3 to
//! GB999, over the generated Grapheme_Cluster_Break, Indic_Conjunct_Break
//! and Extended_Pictographic tables.

const std = @import("std");
const properties = @import("properties.zig");
const utf8 = @import("utf8.zig");
const Grapheme = properties.Grapheme;

/// What the scalars since the last break mean for the rules that look back
/// further than one scalar.
const State = struct {
    /// GB9c: a Linker, then any Extend or Linker. Unicode 18's rule needs
    /// no Consonant before the Linker: its test data joins U+0061 U+094D
    /// to a following Consonant.
    linker: bool = false,
    /// GB11: Extended_Pictographic, then Extend, then a ZWJ.
    emoji: enum { none, pictographic, zwj } = .none,
    /// GB12 and GB13: Regional Indicators in a row.
    regional: usize = 0,

    fn advance(state: *State, scalar: u21, property: ?Grapheme) void {
        state.linker = if (properties.indic(scalar)) |indic| switch (indic) {
            .Linker => true,
            .Extend => state.linker,
            .Consonant => false,
        } else false;
        state.emoji = if (properties.isPictographic(scalar))
            .pictographic
        else if (property == .Extend and state.emoji == .pictographic)
            .pictographic
        else if (property == .ZWJ and state.emoji == .pictographic)
            .zwj
        else
            .none;
        state.regional = if (property == .Regional_Indicator) state.regional + 1 else 0;
    }
};

fn isControl(property: ?Grapheme) bool {
    return property == .Control or property == .CR or property == .LF;
}

/// Whether there is no break between `before` and the next scalar, `after`,
/// given the state through `before`.
fn joins(state: State, before: ?Grapheme, after_scalar: u21, after: ?Grapheme) bool {
    if (before == .CR and after == .LF) return true; // GB3
    if (isControl(before) or isControl(after)) return false; // GB4, GB5
    if (before == .L and (after == .L or after == .V or after == .LV or after == .LVT)) return true; // GB6
    if ((before == .LV or before == .V) and (after == .V or after == .T)) return true; // GB7
    if ((before == .LVT or before == .T) and after == .T) return true; // GB8
    if (after == .Extend or after == .ZWJ) return true; // GB9
    if (after == .SpacingMark) return true; // GB9a
    if (before == .Prepend) return true; // GB9b
    if (state.linker and properties.indic(after_scalar) == .Consonant) return true; // GB9c
    if (state.emoji == .zwj and properties.isPictographic(after_scalar)) return true; // GB11
    if (before == .Regional_Indicator and after == .Regional_Indicator) return state.regional % 2 == 1; // GB12, GB13
    return false; // GB999
}

/// The byte offset where the Character starting at `start` of valid UTF-8
/// ends. `start` must be a Character boundary.
pub fn end(text: []const u8, start: usize) usize {
    if (start >= text.len) return text.len;
    var i = start;
    const scalar = utf8.decode(text, i);
    var property = properties.grapheme(scalar);
    var state: State = .{};
    state.advance(scalar, property);
    i += utf8.sequenceLength(text[i]);
    while (i < text.len) {
        const after_scalar = utf8.decode(text, i);
        const after = properties.grapheme(after_scalar);
        if (!joins(state, property, after_scalar, after)) break;
        state.advance(after_scalar, after);
        property = after;
        i += utf8.sequenceLength(text[i]);
    }
    return i;
}

/// Iterates over the Characters of valid UTF-8 as byte slices.
pub const Iterator = struct {
    text: []const u8,
    i: usize = 0,

    pub fn next(it: *Iterator) ?[]const u8 {
        if (it.i >= it.text.len) return null;
        const start = it.i;
        it.i = end(it.text, start);
        return it.text[start..it.i];
    }
};

/// The number of Characters in valid UTF-8.
pub fn count(text: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < text.len) : (n += 1) i = end(text, i);
    return n;
}

test "Characters keep emoji sequences, flags and CR LF whole" {
    const cases = [_]struct { []const u8, usize }{
        .{ "", 0 },
        .{ "abc", 3 },
        .{ "\r\n", 1 },
        .{ "\n\r", 2 },
        .{ "e\u{0301}", 1 },
        .{ "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", 1 },
        .{ "\u{1F1EC}\u{1F1E7}\u{1F1EB}", 2 },
        .{ "\u{0915}\u{094D}\u{0937}", 1 }, // GB9c
    };
    for (cases) |case| try std.testing.expectEqual(case[1], count(case[0]));
}

//! Property lookups over the generated tables, by binary search.

const std = @import("std");
const tables = @import("../generated/unicode.zig");

pub const Category = tables.Category;
pub const Grapheme = tables.Grapheme;
pub const Indic = tables.Indic;

fn find(comptime T: type, ranges: []const T, scalar: u21) ?*const T {
    var low: usize = 0;
    var high: usize = ranges.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        if (scalar < ranges[mid].start) {
            high = mid;
        } else if (scalar > ranges[mid].end) {
            low = mid + 1;
        } else {
            return &ranges[mid];
        }
    }
    return null;
}

fn has(spans: []const tables.Span, scalar: u21) bool {
    return find(tables.Span, spans, scalar) != null;
}

/// The General Category; null is Cn, unassigned.
pub fn category(scalar: u21) ?Category {
    const range = find(tables.Range(Category), &tables.category, scalar) orelse return null;
    return range.value;
}

pub fn combiningClass(scalar: u21) u8 {
    const range = find(tables.Range(u8), &tables.combining, scalar) orelse return 0;
    return range.value;
}

/// The Grapheme_Cluster_Break value; null is Other.
pub fn grapheme(scalar: u21) ?Grapheme {
    const range = find(tables.Range(Grapheme), &tables.grapheme, scalar) orelse return null;
    return range.value;
}

/// The Indic_Conjunct_Break value; null is None.
pub fn indic(scalar: u21) ?Indic {
    const range = find(tables.Range(Indic), &tables.indic, scalar) orelse return null;
    return range.value;
}

pub fn isPictographic(scalar: u21) bool {
    return has(&tables.pictographic, scalar);
}

pub fn isWhiteSpace(scalar: u21) bool {
    return has(&tables.whitespace, scalar);
}

pub fn isCased(scalar: u21) bool {
    return has(&tables.cased, scalar);
}

pub fn isCaseIgnorable(scalar: u21) bool {
    return has(&tables.case_ignorable, scalar);
}

/// The full default uppercase mapping of `scalar`, or null for itself.
pub fn uppercase(scalar: u21) ?[]const u21 {
    return mapping(&tables.uppercase, scalar);
}

/// The full default lowercase mapping of `scalar`, or null for itself.
pub fn lowercase(scalar: u21) ?[]const u21 {
    return mapping(&tables.lowercase, scalar);
}

/// The lowercase of `scalar` where Final_Sigma holds, or null.
pub fn finalSigma(scalar: u21) ?[]const u21 {
    return mapping(&tables.final_sigma, scalar);
}

/// The scalars a sorted mapping table gives `scalar`, or null.
pub fn mapping(table: []const tables.Mapping, scalar: u21) ?[]const u21 {
    var low: usize = 0;
    var high: usize = table.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        if (scalar < table[mid].from) {
            high = mid;
        } else if (scalar > table[mid].from) {
            low = mid + 1;
        } else {
            return table[mid].to;
        }
    }
    return null;
}

/// The canonical decomposition's first level, or null.
pub fn decomposition(scalar: u21) ?[]const u21 {
    return mapping(&tables.decomposition, scalar);
}

/// The primary composite of `first` and `second`, or null.
pub fn composition(first: u21, second: u21) ?u21 {
    const table = &tables.composition;
    var low: usize = 0;
    var high: usize = table.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        const entry = table[mid];
        if (first < entry.first or (first == entry.first and second < entry.second)) {
            high = mid;
        } else if (first > entry.first or second > entry.second) {
            low = mid + 1;
        } else {
            return entry.composed;
        }
    }
    return null;
}

/// The simple case folding (statuses C and S of CaseFolding.txt).
pub fn fold(scalar: u21) u21 {
    const table = &tables.folding;
    var low: usize = 0;
    var high: usize = table.len;
    while (low < high) {
        const mid = low + (high - low) / 2;
        if (scalar < table[mid].from) {
            high = mid;
        } else if (scalar > table[mid].from) {
            low = mid + 1;
        } else {
            return table[mid].to;
        }
    }
    return scalar;
}

test "lookups find the first, last and missing scalars of a table" {
    try std.testing.expectEqual(Category.Lu, category('A').?);
    try std.testing.expectEqual(Category.Cc, category(0).?);
    try std.testing.expectEqual(@as(?Category, null), category(0x0378));
    try std.testing.expectEqual(@as(u8, 230), combiningClass(0x0301));
    try std.testing.expectEqual(@as(u8, 0), combiningClass('a'));
    try std.testing.expectEqual(Grapheme.CR, grapheme('\r').?);
    try std.testing.expectEqual(@as(?Grapheme, null), grapheme('a'));
    try std.testing.expect(isWhiteSpace(' ') and isWhiteSpace(0x3000) and !isWhiteSpace('a'));
    try std.testing.expect(isPictographic(0x1F600));
    try std.testing.expectEqual(@as(u21, 0xC5), composition('A', 0x030A).?);
    try std.testing.expectEqual(@as(?u21, null), composition('A', 'B'));
    try std.testing.expectEqual(@as(u21, 'a'), fold('A'));
    try std.testing.expectEqual(@as(u21, 0x3C3), fold(0x3C2));
    try std.testing.expectEqual(@as(u21, 0x10FFFF), fold(0x10FFFF));
}

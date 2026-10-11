//! NFC (UAX #15): canonical decomposition, canonical ordering, then canonical
//! composition, over the generated decomposition, combining class and
//! composition tables, with Hangul syllables handled algorithmically.

const std = @import("std");
const Allocator = std.mem.Allocator;
const properties = @import("properties.zig");
const utf8 = @import("utf8.zig");

// Hangul syllables (Unicode 3.12).
const s_base = 0xAC00;
const l_base = 0x1100;
const v_base = 0x1161;
const t_base = 0x11A7;
const l_count = 19;
const v_count = 21;
const t_count = 28;
const n_count = v_count * t_count;
const s_count = l_count * n_count;

const Entry = struct { scalar: u21, class: u8 };
const Entries = std.ArrayList(Entry);

fn decompose(gpa: Allocator, out: *Entries, scalar: u21) Allocator.Error!void {
    if (scalar >= s_base and scalar < s_base + s_count) {
        const index = scalar - s_base;
        try out.append(gpa, .{ .scalar = l_base + index / n_count, .class = 0 });
        try out.append(gpa, .{ .scalar = v_base + index % n_count / t_count, .class = 0 });
        if (index % t_count != 0) {
            try out.append(gpa, .{ .scalar = t_base + index % t_count, .class = 0 });
        }
        return;
    }
    if (properties.decomposition(scalar)) |parts| {
        // Recursion follows the table, at most a few levels, never the input.
        for (parts) |part| try decompose(gpa, out, part);
        return;
    }
    try out.append(gpa, .{ .scalar = scalar, .class = properties.combiningClass(scalar) });
}

fn byClass(_: void, a: Entry, b: Entry) bool {
    return a.class < b.class;
}

/// Sorts each run of non-starters by combining class, stably.
fn reorder(entries: []Entry) void {
    var i: usize = 0;
    while (i < entries.len) {
        if (entries[i].class == 0) {
            i += 1;
            continue;
        }
        var end = i + 1;
        while (end < entries.len and entries[end].class != 0) end += 1;
        if (end - i > 1) std.mem.sort(Entry, entries[i..end], {}, byClass);
        i = end;
    }
}

fn compose(first: u21, second: u21) ?u21 {
    if (first >= l_base and first < l_base + l_count and second >= v_base and second < v_base + v_count) {
        return s_base + ((first - l_base) * v_count + second - v_base) * t_count;
    }
    if (first >= s_base and first < s_base + s_count and (first - s_base) % t_count == 0 and
        second > t_base and second < t_base + t_count)
    {
        return first + second - t_base;
    }
    return properties.composition(first, second);
}

/// Composes in place and returns the composed length.
fn recompose(entries: []Entry) usize {
    if (entries.len == 0) return 0;
    var starter: ?usize = if (entries[0].class == 0) 0 else null;
    // The last kept entry's class; 256 when no starter precedes it.
    var last: u16 = if (starter == null) 256 else 0;
    var kept: usize = 1;
    for (entries[1..]) |entry| {
        // An entry is blocked from the starter when one kept between them
        // has a class of zero or at least its own. A class of zero can only
        // be the starter itself.
        if (starter) |s| {
            if (last < entry.class or last == 0) {
                if (compose(entries[s].scalar, entry.scalar)) |composed| {
                    entries[s].scalar = composed;
                    continue;
                }
            }
        }
        if (entry.class == 0) starter = kept;
        last = entry.class;
        entries[kept] = entry;
        kept += 1;
    }
    return kept;
}

/// The NFC form of a sequence of scalars, newly allocated.
pub fn nfcScalars(gpa: Allocator, scalars: []const u21) Allocator.Error![]u21 {
    var entries: Entries = .empty;
    defer entries.deinit(gpa);
    for (scalars) |scalar| try decompose(gpa, &entries, scalar);
    reorder(entries.items);
    const len = recompose(entries.items);
    const result = try gpa.alloc(u21, len);
    for (entries.items[0..len], result) |entry, *scalar| scalar.* = entry.scalar;
    return result;
}

/// The NFC form of valid UTF-8, newly allocated.
pub fn nfc(gpa: Allocator, text: []const u8) Allocator.Error![]u8 {
    if (isAscii(text)) return gpa.dupe(u8, text);
    var entries: Entries = .empty;
    defer entries.deinit(gpa);
    var it: utf8.Iterator = .{ .bytes = text };
    while (it.next()) |scalar| try decompose(gpa, &entries, scalar);
    reorder(entries.items);
    const len = recompose(entries.items);
    var size: usize = 0;
    for (entries.items[0..len]) |entry| size += utf8.encodedLength(entry.scalar);
    const result = try gpa.alloc(u8, size);
    var at: usize = 0;
    for (entries.items[0..len]) |entry| at += utf8.encode(entry.scalar, result[at..]);
    return result;
}

fn isAscii(text: []const u8) bool {
    for (text) |byte| {
        if (byte >= 0x80) return false;
    }
    return true;
}

test "nfc composes, reorders and leaves ASCII alone" {
    const gpa = std.testing.allocator;
    const cases = [_][2][]const u8{
        .{ "abc", "abc" },
        .{ "e\u{0301}", "\u{00E9}" },
        .{ "\u{212B}", "\u{00C5}" }, // a singleton decomposition
        .{ "a\u{0323}\u{0302}", "\u{1EAD}" },
        .{ "a\u{0302}\u{0323}", "\u{1EAD}" }, // reordered, then composed
        .{ "\u{1100}\u{1161}\u{11A8}", "\u{AC01}" }, // Hangul LV then LVT
        .{ "\u{0344}", "\u{0308}\u{0301}" }, // an excluded composition
        .{ "\u{0301}e", "\u{0301}e" }, // a leading non-starter
        .{ "", "" },
    };
    for (cases) |case| {
        const result = try nfc(gpa, case[0]);
        defer gpa.free(result);
        try std.testing.expectEqualStrings(case[1], result);
    }
}

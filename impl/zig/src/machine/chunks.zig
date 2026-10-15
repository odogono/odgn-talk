//! Chunk Expressions and the Built-in properties (chapter 4): reading,
//! writing and deleting chunks of text, lists, integer ranges and Bytes.
//! Each operation reports what the Cost Model's `scanned` counts for it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const display = @import("../display.zig");
const unicode = @import("../unicode/unicode.zig");
const Value = model.Value;

pub const Kind = enum { character, word, line, item, byte, code_point };

/// What a chunk operation raises, with the fields chapter 6 gives it.
pub const Raise = union(enum) {
    /// `wrong kind`, with what was expected.
    wrong_kind: []const u8,
    /// `out of range`, with its field and value.
    out_of_range: struct { field: []const u8, value: *Value },
};

pub const Error = error{ OutOfMemory, Raised };

/// A chunk operation's outcome, besides its value.
pub const Effect = struct {
    scanned: u64 = 0,
    raise: ?Raise = null,
};

/// The spans of a text's chunks, as byte offsets.
pub const Span = struct { start: usize, end: usize };

fn whiteSpaceCharacter(text: []const u8, start: usize) bool {
    return unicode.words.isWhiteSpaceAt(text, start);
}

/// The text's Characters.
fn characters(a: Allocator, text: []const u8) Allocator.Error![]Span {
    var out: std.ArrayList(Span) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const e = unicode.grapheme.end(text, i);
        try out.append(a, .{ .start = i, .end = e });
        i = e;
    }
    return out.items;
}

fn isLineBreak(text: []const u8, c: Span) bool {
    const s = text[c.start..c.end];
    return std.mem.eql(u8, s, "\n") or std.mem.eql(u8, s, "\r") or std.mem.eql(u8, s, "\r\n");
}

/// The spans of each chunk of `kind` in `text`, and the Characters before
/// each chunk's end, for `scanned`.
pub const Segments = struct {
    spans: []Span,
    /// Characters (or code points) from the text's start to each span's end.
    counts: []u64,
    /// All the Characters (or code points).
    total: u64,
};

pub fn segment(a: Allocator, text: []const u8, kind: Kind, delimiter: []const u8) Allocator.Error!Segments {
    var spans: std.ArrayList(Span) = .empty;
    var counts: std.ArrayList(u64) = .empty;
    if (kind == .code_point) {
        var i: usize = 0;
        var n: u64 = 0;
        while (i < text.len) {
            const len = unicode.utf8.sequenceLength(text[i]);
            n += 1;
            try spans.append(a, .{ .start = i, .end = i + len });
            try counts.append(a, n);
            i += len;
        }
        return .{ .spans = spans.items, .counts = counts.items, .total = n };
    }
    const chars = try characters(a, text);
    switch (kind) {
        .character => for (chars, 1..) |c, n| {
            try spans.append(a, c);
            try counts.append(a, n);
        },
        .word => {
            var i: usize = 0;
            while (i < chars.len) {
                if (whiteSpaceCharacter(text, chars[i].start)) {
                    i += 1;
                    continue;
                }
                const first = i;
                while (i < chars.len and !whiteSpaceCharacter(text, chars[i].start)) i += 1;
                try spans.append(a, .{ .start = chars[first].start, .end = chars[i - 1].end });
                try counts.append(a, i);
            }
        },
        .line, .item => {
            // Chunks between delimiters; a delimiter at the very end makes no
            // empty last chunk, and empty text has none.
            const delim_chars = if (kind == .item) try characters(a, delimiter) else &[_]Span{};
            if (chars.len == 0) return .{ .spans = &.{}, .counts = &.{}, .total = 0 };
            var start: usize = 0;
            var i: usize = 0;
            while (i < chars.len) {
                const width = if (kind == .line)
                    (if (isLineBreak(text, chars[i])) @as(usize, 1) else 0)
                else
                    delimiterAt(text, chars, i, delimiter, delim_chars);
                if (width == 0) {
                    i += 1;
                    continue;
                }
                const s = if (start < chars.len) chars[start].start else text.len;
                const e = if (i > start) chars[i - 1].end else s;
                try spans.append(a, .{ .start = s, .end = e });
                try counts.append(a, i);
                i += width;
                start = i;
            }
            if (start < chars.len) {
                try spans.append(a, .{ .start = chars[start].start, .end = text.len });
                try counts.append(a, chars.len);
            }
        },
        .byte => unreachable,
        .code_point => unreachable,
    }
    return .{ .spans = spans.items, .counts = counts.items, .total = chars.len };
}

/// The number of Characters the delimiter covers at Character `i`, or 0.
fn delimiterAt(text: []const u8, chars: []const Span, i: usize, delimiter: []const u8, delim_chars: []const Span) usize {
    if (delim_chars.len == 0 or i + delim_chars.len > chars.len) return 0;
    const s = chars[i].start;
    const e = chars[i + delim_chars.len - 1].end;
    if (!std.mem.eql(u8, text[s..e], delimiter)) return 0;
    // Whole Characters only: the delimiter's own boundaries must match.
    for (delim_chars, 0..) |d, k| {
        if (chars[i + k].end - s != d.end) return 0;
    }
    return delim_chars.len;
}

/// An index or range of indexes, read as chapter 4 says: integers from 1,
/// or from the end when negative.
pub const Index = union(enum) {
    one: i64,
    range: struct { from: i64, to: i64 },
};

/// Reads an index value, or what to raise.
pub fn readIndex(v: *const Value) union(enum) { index: Index, raise: Raise } {
    switch (v.data) {
        .number => |n| {
            const i = n.integer(i64) catch return .{ .raise = .{ .wrong_kind = "integer" } };
            return .{ .index = .{ .one = i } };
        },
        .range => |r| {
            if (r.from.data != .number or r.to.data != .number) return .{ .raise = .{ .wrong_kind = "number" } };
            const from = r.from.data.number.integer(i64) catch return .{ .raise = .{ .wrong_kind = "integer" } };
            const to = r.to.data.number.integer(i64) catch return .{ .raise = .{ .wrong_kind = "integer" } };
            return .{ .index = .{ .range = .{ .from = from, .to = to } } };
        },
        else => return .{ .raise = .{ .wrong_kind = "number" } },
    }
}

/// A position from 1, with a negative one counted from the end.
fn absolute(i: i64, n: usize) i64 {
    return if (i < 0) @as(i64, @intCast(n)) + 1 + i else i;
}

const Covered = struct { first: usize, last: usize };

/// The chunks an index covers, as positions from 1, or null when there are
/// none: out of range, at 0, before the start or reversed.
fn covered(index: Index, n: usize) ?Covered {
    switch (index) {
        .one => |i| {
            const p = absolute(i, n);
            if (p < 1 or p > n) return null;
            return .{ .first = @intCast(p), .last = @intCast(p) };
        },
        .range => |r| {
            const from = absolute(r.from, n);
            const to = absolute(r.to, n);
            if (from > to) return null;
            const first = @max(from, 1);
            const last = @min(to, @as(i64, @intCast(n)));
            if (first > last) return null;
            return .{ .first = @intCast(first), .last = @intCast(last) };
        },
    }
}

/// Forward Character reads need only two byte offsets. Negative bounds use
/// full segmentation so they don't pay for a count followed by another walk.
/// Null selects that fallback; empty text is a completed, missing read.
fn readCharacters(text: []const u8, index: Index, effect: *Effect) ?[]const u8 {
    if (switch (index) {
        .one => |i| i < 0,
        .range => |r| r.from < 0 or r.to < 0,
    }) return null;
    const forward: ?Covered = switch (index) {
        .one => |i| if (i > 0 and i <= text.len) .{ .first = @intCast(i), .last = @intCast(i) } else null,
        .range => |r| if (r.from >= 0 and r.to >= @max(r.from, 1) and @max(r.from, 1) <= text.len)
            .{ .first = @intCast(@max(r.from, 1)), .last = @intCast(@min(r.to, text.len)) }
        else
            null,
    };
    const c = forward orelse {
        // Missing/reversed reads charge the whole input, not zero. Checking
        // byte-length bounds first also keeps i64 indexes safe on wasm32.
        effect.scanned = unicode.grapheme.count(text);
        return "";
    };
    var at: usize = 0;
    var n: usize = 0;
    var start: ?usize = null;
    while (at < text.len and n < c.last) {
        n += 1;
        if (n == c.first) start = at;
        at = unicode.grapheme.end(text, at);
    }
    effect.scanned = n;
    return if (start) |s| text[s..at] else "";
}

pub fn kindName(kind: Kind) []const u8 {
    return switch (kind) {
        .code_point => "code point",
        inline else => |k| @tagName(k),
    };
}

/// Reads one chunk level. `delimiter` is the chain's, for `item`.
pub fn get(a: Allocator, gpa: Allocator, whole: *Value, kind: Kind, index_value: *const Value, delimiter: []const u8, effect: *Effect) Error!*Value {
    const index = switch (readIndex(index_value)) {
        .index => |i| i,
        .raise => |r| {
            effect.raise = r;
            return error.Raised;
        },
    };
    switch (whole.data) {
        .text => |text| {
            if (kind == .byte) return wrongKind(effect, "bytes");
            if (kind == .character) {
                if (readCharacters(text, index, effect)) |part| return model.text(gpa, part) catch error.OutOfMemory;
            }
            const seg = try segment(a, text, kind, delimiter);
            const c = covered(index, seg.spans.len) orelse {
                effect.scanned = seg.total;
                return model.text(gpa, "") catch error.OutOfMemory;
            };
            effect.scanned = seg.counts[c.last - 1];
            return model.text(gpa, text[seg.spans[c.first - 1].start..seg.spans[c.last - 1].end]) catch error.OutOfMemory;
        },
        .list => |items| {
            if (kind != .item) return wrongKind(effect, "text");
            return sequence(gpa, items.len, index, effect, struct {
                items: []*Value,
                fn at(self: @This(), i: usize) *Value {
                    return self.items[i];
                }
            }{ .items = items });
        },
        .range => |r| {
            if (kind != .item or !integerRange(r)) return wrongKind(effect, "text");
            const from = r.from.data.number.integer(i64) catch unreachable;
            const to = r.to.data.number.integer(i64) catch unreachable;
            const n: usize = if (to >= from) @intCast(to - from + 1) else 0;
            const c = covered(index, n) orelse {
                effect.scanned = n;
                return if (index == .one) nothingValue(gpa) else model.list(gpa, &.{}) catch error.OutOfMemory;
            };
            effect.scanned = c.last;
            if (index == .one) return numberValue(gpa, from + @as(i64, @intCast(c.first)) - 1);
            var out: std.ArrayList(*Value) = .empty;
            defer {
                for (out.items) |v| v.release();
                out.deinit(a);
            }
            for (c.first..c.last + 1) |i| try out.append(a, try numberValue(gpa, from + @as(i64, @intCast(i)) - 1));
            return model.list(gpa, out.items) catch error.OutOfMemory;
        },
        .bytes => |b| {
            if (kind != .byte) return wrongKind(effect, "text");
            const c = covered(index, b.len) orelse {
                effect.scanned = b.len;
                return if (index == .one) nothingValue(gpa) else model.bytes(gpa, "") catch error.OutOfMemory;
            };
            effect.scanned = c.last;
            if (index == .one) return numberValue(gpa, b[c.first - 1]);
            return model.bytes(gpa, b[c.first - 1 .. c.last]) catch error.OutOfMemory;
        },
        else => return wrongKind(effect, "text"),
    }
}

fn sequence(gpa: Allocator, n: usize, index: Index, effect: *Effect, src: anytype) Error!*Value {
    const c = covered(index, n) orelse {
        effect.scanned = n;
        return if (index == .one) nothingValue(gpa) else model.list(gpa, &.{}) catch error.OutOfMemory;
    };
    effect.scanned = c.last;
    if (index == .one) return src.at(c.first - 1).retain();
    var out = try gpa.alloc(*Value, c.last - c.first + 1);
    defer gpa.free(out);
    for (c.first..c.last + 1, 0..) |i, k| out[k] = src.at(i - 1);
    return model.list(gpa, out) catch error.OutOfMemory;
}

pub fn integerRange(r: model.Range) bool {
    if (r.from.data != .number or r.to.data != .number) return false;
    _ = r.from.data.number.integer(i64) catch return false;
    _ = r.to.data.number.integer(i64) catch return false;
    return true;
}

fn wrongKind(effect: *Effect, expected: []const u8) Error {
    effect.raise = .{ .wrong_kind = expected };
    return error.Raised;
}

pub fn nothingValue(gpa: Allocator) Error!*Value {
    return model.scalar(gpa, .nothing) catch error.OutOfMemory;
}

pub fn numberValue(gpa: Allocator, n: i64) Error!*Value {
    return model.scalar(gpa, .{ .number = model.Decimal.fromInt(n) }) catch error.OutOfMemory;
}

/// A value's text form (chapter 3): text is itself, anything else its display
/// form.
pub fn textForm(a: Allocator, v: *const Value) Allocator.Error![]const u8 {
    if (v.data == .text) return v.data.text;
    return display.string(a, v) catch error.OutOfMemory;
}

/// Writes one chunk level: the whole with the chunk replaced by `part`.
/// Borrows all input Values and returns an owned result. Even a unique whole
/// must keep its prior contents; callers may retain it in canonical locals.
pub fn set(a: Allocator, gpa: Allocator, whole: *Value, kind: Kind, index_value: *const Value, part: *Value, delimiter: []const u8, effect: *Effect) Error!*Value {
    const index = switch (readIndex(index_value)) {
        .index => |i| i,
        .raise => |r| {
            effect.raise = r;
            return error.Raised;
        },
    };
    switch (whole.data) {
        .text => |text| {
            if (kind == .byte) return wrongKind(effect, "bytes");
            const seg = try segment(a, text, kind, delimiter);
            const n = seg.spans.len;
            try checkWriteIndex(gpa, index, n, kind, index_value, effect);
            const new = try textForm(a, part);
            var out: std.ArrayList(u8) = .empty;
            switch (index) {
                .one => |i| {
                    const p: usize = @intCast(absolute(i, n));
                    if (p > n) {
                        // Past the end: words and Characters raise; items and
                        // lines pad with their delimiter.
                        if (kind != .item and kind != .line) return outOfRange(gpa, kind, index_value, effect);
                        const delim = if (kind == .line) "\n" else delimiter;
                        try out.appendSlice(a, text);
                        var pad = p - n - 1;
                        const ends = if (kind == .line) endsWithLineBreak(text) else std.mem.endsWith(u8, text, delim);
                        if (text.len > 0 and !ends) pad += 1;
                        for (0..pad) |_| try out.appendSlice(a, delim);
                        try out.appendSlice(a, new);
                    } else {
                        const span = seg.spans[p - 1];
                        try out.appendSlice(a, text[0..span.start]);
                        try out.appendSlice(a, new);
                        try out.appendSlice(a, text[span.end..]);
                    }
                },
                .range => {
                    const c = covered(index, n) orelse return outOfRange(gpa, kind, index_value, effect);
                    try out.appendSlice(a, text[0..seg.spans[c.first - 1].start]);
                    try out.appendSlice(a, new);
                    try out.appendSlice(a, text[seg.spans[c.last - 1].end..]);
                },
            }
            return model.text(gpa, out.items) catch error.OutOfMemory;
        },
        .list => |items| {
            if (kind != .item) return wrongKind(effect, "text");
            try checkWriteIndex(gpa, index, items.len, kind, index_value, effect);
            var out: std.ArrayList(*Value) = .empty;
            defer out.deinit(a);
            var nothing: ?*Value = null;
            defer if (nothing) |x| x.release();
            switch (index) {
                .one => |i| {
                    const p: usize = @intCast(absolute(i, items.len));
                    if (p <= items.len) {
                        // `whole` is borrowed: lowering temps, aliases and
                        // Segment rollback bindings must keep their old value.
                        // listSet copies the spine once, directly into the
                        // Group allocator, including for Host-owned Lists.
                        // The retain is load-bearing: it makes every write
                        // here take listSet's copying branch, so dropping it
                        // to reuse unique storage would mutate those holders.
                        var root = whole.retain();
                        errdefer root.release();
                        model.listSet(gpa, &root, p - 1, part) catch return error.OutOfMemory;
                        return root;
                    }
                    try out.appendSlice(a, items);
                    if (p > items.len) {
                        nothing = try nothingValue(gpa);
                        while (out.items.len < p) try out.append(a, nothing.?);
                    }
                    out.items[p - 1] = part;
                },
                .range => {
                    if (part.data != .list) return wrongKind(effect, "list");
                    const c = covered(index, items.len) orelse return outOfRange(gpa, kind, index_value, effect);
                    try out.appendSlice(a, items[0 .. c.first - 1]);
                    try out.appendSlice(a, part.data.list);
                    try out.appendSlice(a, items[c.last..]);
                },
            }
            return model.list(gpa, out.items) catch error.OutOfMemory;
        },
        .bytes => |b| {
            if (kind != .byte) return wrongKind(effect, "text");
            try checkWriteIndex(gpa, index, b.len, kind, index_value, effect);
            var out: std.ArrayList(u8) = .empty;
            switch (index) {
                .one => |i| {
                    const p: usize = @intCast(absolute(i, b.len));
                    // A write never appends.
                    if (p > b.len) return outOfRange(gpa, kind, index_value, effect);
                    if (part.data != .number) return wrongKind(effect, "number");
                    const n = part.data.number.integer(i64) catch return wrongKind(effect, "integer");
                    if (n < 0 or n > 255) {
                        effect.raise = .{ .out_of_range = .{ .field = "byte", .value = part.retain() } };
                        return error.Raised;
                    }
                    try out.appendSlice(a, b);
                    out.items[p - 1] = @intCast(n);
                },
                .range => {
                    if (part.data != .bytes) return wrongKind(effect, "bytes");
                    const c = covered(index, b.len) orelse return outOfRange(gpa, kind, index_value, effect);
                    try out.appendSlice(a, b[0 .. c.first - 1]);
                    try out.appendSlice(a, part.data.bytes);
                    try out.appendSlice(a, b[c.last..]);
                },
            }
            return model.bytes(gpa, out.items) catch error.OutOfMemory;
        },
        else => return wrongKind(effect, "text"),
    }
}

fn endsWithLineBreak(text: []const u8) bool {
    return text.len > 0 and (text[text.len - 1] == '\n' or text[text.len - 1] == '\r');
}

fn checkWriteIndex(gpa: Allocator, index: Index, n: usize, kind: Kind, index_value: *const Value, effect: *Effect) Error!void {
    switch (index) {
        .one => |i| {
            const p = absolute(i, n);
            if (p < 1) return outOfRange(gpa, kind, index_value, effect);
        },
        .range => |r| {
            const from = absolute(r.from, n);
            const to = absolute(r.to, n);
            if (from < 1 or to < 1 or from > to) return outOfRange(gpa, kind, index_value, effect);
        },
    }
}

fn outOfRange(gpa: Allocator, kind: Kind, index_value: *const Value, effect: *Effect) Error {
    const shown: *Value = switch (index_value.data) {
        .range => |r| model.list(gpa, &.{ r.from, r.to }) catch return error.OutOfMemory,
        else => @constCast(index_value).retain(),
    };
    effect.raise = .{ .out_of_range = .{ .field = kindName(kind), .value = shown } };
    return error.Raised;
}

/// Deletes one chunk level, or leaves the whole when the chunk isn't there.
pub fn delete(a: Allocator, gpa: Allocator, whole: *Value, kind: Kind, index_value: *const Value, delimiter: []const u8, effect: *Effect) Error!*Value {
    const index = switch (readIndex(index_value)) {
        .index => |i| i,
        .raise => |r| {
            effect.raise = r;
            return error.Raised;
        },
    };
    switch (whole.data) {
        .text => |text| {
            const seg = try segment(a, text, kind, delimiter);
            const c = covered(index, seg.spans.len) orelse return whole.retain();
            var start = seg.spans[c.first - 1].start;
            var end = seg.spans[c.last - 1].end;
            // The white space or delimiter after it goes too, or before it
            // for the last chunk.
            if (kind == .word or kind == .line or kind == .item) {
                if (c.last < seg.spans.len) {
                    end = seg.spans[c.last].start;
                } else if (c.first > 1) {
                    start = seg.spans[c.first - 2].end;
                } else end = text.len;
            }
            var out: std.ArrayList(u8) = .empty;
            try out.appendSlice(a, text[0..start]);
            try out.appendSlice(a, text[end..]);
            return model.text(gpa, out.items) catch error.OutOfMemory;
        },
        .list => |items| {
            const c = covered(index, items.len) orelse return whole.retain();
            var out: std.ArrayList(*Value) = .empty;
            defer out.deinit(a);
            try out.appendSlice(a, items[0 .. c.first - 1]);
            try out.appendSlice(a, items[c.last..]);
            return model.list(gpa, out.items) catch error.OutOfMemory;
        },
        .bytes => |b| {
            const c = covered(index, b.len) orelse return whole.retain();
            var out: std.ArrayList(u8) = .empty;
            try out.appendSlice(a, b[0 .. c.first - 1]);
            try out.appendSlice(a, b[c.last..]);
            return model.bytes(gpa, out.items) catch error.OutOfMemory;
        },
        else => return wrongKind(effect, "text"),
    }
}

/// Whether a chunk is there, for `delete`'s tests.
pub fn exists(a: Allocator, whole: *const Value, kind: Kind, index_value: *const Value, delimiter: []const u8, effect: *Effect) Error!bool {
    const index = switch (readIndex(index_value)) {
        .index => |i| i,
        .raise => |r| {
            effect.raise = r;
            return error.Raised;
        },
    };
    const n: usize = switch (whole.data) {
        .text => |text| (try segment(a, text, kind, delimiter)).spans.len,
        .list => |items| items.len,
        .bytes => |b| b.len,
        else => return wrongKind(effect, "text"),
    };
    return covered(index, n) != null;
}

/// A Built-in property (chapter 4, Keys and properties).
pub fn property(a: Allocator, gpa: Allocator, v: *Value, name: []const u8, delimiter: []const u8, effect: *Effect) Error!*Value {
    if (std.mem.eql(u8, name, "length")) {
        return switch (v.data) {
            .text => numberValue(gpa, @intCast(model.textCharacters(v))),
            .list => |l| numberValue(gpa, @intCast(l.len)),
            .map => |m| numberValue(gpa, @intCast(m.len)),
            .bytes => |b| numberValue(gpa, @intCast(b.len)),
            .range => |r| if (integerRange(r)) numberValue(gpa, @intCast(rangeLength(r))) else wrongKind(effect, "text"),
            else => wrongKind(effect, "text"),
        };
    }
    if (std.mem.eql(u8, name, "keys") or std.mem.eql(u8, name, "values")) {
        if (v.data != .map) return wrongKind(effect, "map");
        var out: std.ArrayList(*Value) = .empty;
        defer {
            if (std.mem.eql(u8, name, "keys")) for (out.items) |x| x.release();
            out.deinit(a);
        }
        for (v.data.map) |p| try out.append(a, if (std.mem.eql(u8, name, "keys")) model.text(gpa, p.key) catch return error.OutOfMemory else p.value);
        return model.list(gpa, out.items) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "bytes")) {
        if (v.data != .bytes) return wrongKind(effect, "bytes");
        var out: std.ArrayList(*Value) = .empty;
        defer {
            for (out.items) |x| x.release();
            out.deinit(a);
        }
        for (v.data.bytes) |b| try out.append(a, try numberValue(gpa, b));
        return model.list(gpa, out.items) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "items")) switch (v.data) {
        .list => return model.list(gpa, v.data.list) catch error.OutOfMemory,
        .range => |r| {
            if (!integerRange(r)) return wrongKind(effect, "list");
            const from = r.from.data.number.integer(i64) catch unreachable;
            var out: std.ArrayList(*Value) = .empty;
            defer {
                for (out.items) |x| x.release();
                out.deinit(a);
            }
            for (0..rangeLength(r)) |i| try out.append(a, try numberValue(gpa, from + @as(i64, @intCast(i))));
            return model.list(gpa, out.items) catch error.OutOfMemory;
        },
        .text => {},
        else => return wrongKind(effect, "list"),
    };
    const kind: Kind = if (std.mem.eql(u8, name, "items")) .item else if (std.mem.eql(u8, name, "lines")) .line else if (std.mem.eql(u8, name, "words")) .word else if (std.mem.eql(u8, name, "characters")) .character else .code_point;
    if (v.data != .text) return wrongKind(effect, "text");
    const text = v.data.text;
    const seg = try segment(a, text, kind, delimiter);
    var out: std.ArrayList(*Value) = .empty;
    defer {
        for (out.items) |x| x.release();
        out.deinit(a);
    }
    for (seg.spans) |s| try out.append(a, model.text(gpa, text[s.start..s.end]) catch return error.OutOfMemory);
    return model.list(gpa, out.items) catch error.OutOfMemory;
}

fn rangeLength(r: model.Range) usize {
    const from = r.from.data.number.integer(i64) catch unreachable;
    const to = r.to.data.number.integer(i64) catch unreachable;
    return if (to >= from) @intCast(to - from + 1) else 0;
}

const testing = std.testing;

fn readText(text: []const u8, kind: Kind, index: Index, delimiter: []const u8) ![]const u8 {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const whole = try model.text(a, text);
    const iv = switch (index) {
        .one => |i| try numberValue(a, i),
        .range => |r| try model.range(a, try numberValue(a, r.from), try numberValue(a, r.to)),
    };
    var effect: Effect = .{};
    const v = try get(a, a, whole, kind, iv, delimiter, &effect);
    return testing.allocator.dupe(u8, v.data.text);
}

fn expectRead(text: []const u8, kind: Kind, index: Index, delimiter: []const u8, want: []const u8) !void {
    const got = try readText(text, kind, index, delimiter);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(want, got);
}

test "reading chunks of text" {
    try expectRead("abc", .character, .{ .one = 10 }, ",", "");
    try expectRead("one two", .word, .{ .one = 0 }, ",", "");
    try expectRead("a,b", .item, .{ .one = 3 }, ",", "");
    try expectRead("abc", .character, .{ .range = .{ .from = 2, .to = 10 } }, ",", "bc");
    try expectRead("abc", .character, .{ .range = .{ .from = -5, .to = 2 } }, ",", "ab");
    try expectRead("abc", .character, .{ .range = .{ .from = -1, .to = 1 } }, ",", "");
    try expectRead("cat, dog", .word, .{ .one = 1 }, ",", "cat,");
    try expectRead("  cat,  dog.  ", .word, .{ .range = .{ .from = 1, .to = 2 } }, ",", "cat,  dog.");
    try expectRead("a, b", .item, .{ .one = 2 }, ",", " b");
    try expectRead("a,b,c,d,e", .item, .{ .range = .{ .from = 2, .to = 4 } }, ",", "b,c,d");
    try expectRead("x\r\ny\nz\n", .line, .{ .one = -1 }, ",", "z");
    try expectRead("a;;c", .item, .{ .one = 2 }, ";", "");
}

fn testIndex(a: Allocator, index: Index) !*Value {
    return switch (index) {
        .one => |i| numberValue(a, i),
        .range => |r| blk: {
            const from = try numberValue(a, r.from);
            defer from.release();
            const to = try numberValue(a, r.to);
            defer to.release();
            break :blk try model.range(a, from, to);
        },
    };
}

test "Character reads match full segmentation output and scanned input" {
    const texts = [_][]const u8{
        "",           "a",          "NorthTalk rocks!", "a\r\nb\rc\nd", "\n\r",      "\x00\x7f",
        "q\u{0301}a", "a\u{0301}b", "a\u{200d}b",       "\r\u{0301}a",  "\u{0301}a", "\u{0600}ab",
        "é👨‍👩‍👧q́🇬🇧🇫",
        "क्\u{0937}a",
    };
    for (texts) |text| {
        var arena: std.heap.ArenaAllocator = .init(testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const whole = try model.text(a, text);
        const seg = try segment(a, whole.data.text, .character, ",");
        const bound: i64 = @intCast(seg.total + 2);
        var from = -bound;
        while (from <= bound) : (from += 1) {
            var to = -bound;
            while (to <= bound + 1) : (to += 1) {
                const index: Index = if (to == bound + 1) .{ .one = from } else .{ .range = .{ .from = from, .to = to } };
                const iv = try testIndex(a, index);
                var effect: Effect = .{};
                const result = try get(a, testing.allocator, whole, .character, iv, ",", &effect);
                defer result.release();
                const selected = covered(index, seg.spans.len);
                const want = if (selected) |c| whole.data.text[seg.spans[c.first - 1].start..seg.spans[c.last - 1].end] else "";
                try testing.expectEqualStrings(want, result.data.text);
                try testing.expectEqual(if (selected) |c| @as(u64, c.last) else seg.total, effect.scanned);
                try testing.expect(effect.raise == null);
            }
        }
        for ([_]Index{
            .{ .one = std.math.minInt(i64) },                                            .{ .one = std.math.maxInt(i64) },
            .{ .range = .{ .from = std.math.minInt(i64), .to = std.math.maxInt(i64) } },
        }) |index| {
            const iv = try testIndex(a, index);
            var effect: Effect = .{};
            const result = try get(a, testing.allocator, whole, .character, iv, ",", &effect);
            defer result.release();
            const c = covered(index, seg.spans.len);
            try testing.expectEqualStrings(if (c != null) whole.data.text else "", result.data.text);
            try testing.expectEqual(seg.total, effect.scanned);
        }
    }
}

test "forward Character reads need no segmentation storage and still propagate result refusal" {
    const whole = try model.text(testing.allocator, "a\r\nq́👨‍👩‍👧🇬🇧z");
    defer whole.release();
    var buffer: [0]u8 = .{};
    var scratch: std.heap.FixedBufferAllocator = .init(&buffer);
    for ([_]Index{ .{ .one = 3 }, .{ .one = 0 }, .{ .one = 99 }, .{ .range = .{ .from = 2, .to = 5 } } }) |index| {
        const iv = try testIndex(testing.allocator, index);
        defer iv.release();
        var effect: Effect = .{};
        const result = try get(scratch.allocator(), testing.allocator, whole, .character, iv, ",", &effect);
        result.release();
        try testing.expectError(error.OutOfMemory, get(scratch.allocator(), scratch.allocator(), whole, .character, iv, ",", &effect));
    }
}

fn listWriteAllocations(gpa: Allocator) !void {
    const one = try numberValue(gpa, 1);
    defer one.release();
    const negative = try numberValue(gpa, -1);
    defer negative.release();
    const original = try model.list(gpa, &.{ one, one });
    defer original.release();
    var effect: Effect = .{};
    const changed = try set(gpa, gpa, original, .item, negative, original, ",", &effect);
    defer changed.release();
    try testing.expectEqualSlices(*Value, &.{ one, one }, original.data.list);
    try testing.expectEqualSlices(*Value, &.{ one, original }, changed.data.list);
    try testing.expectEqual(@as(u64, 0), effect.scanned);
    try testing.expectEqual(@as(u64, 80), model.contentsSize(changed));
    // Branches and nested insertion keep both earlier versions immutable.
    const branch = try set(gpa, gpa, original, .item, one, changed, ",", &effect);
    defer branch.release();
    try testing.expectEqual(changed, branch.data.list[0]);
    try testing.expectEqual(one, changed.data.list[0]);
    const padded_index = try numberValue(gpa, 4);
    defer padded_index.release();
    const padded = try set(gpa, gpa, original, .item, padded_index, changed, ",", &effect);
    defer padded.release();
    try testing.expectEqual(@as(usize, 4), padded.data.list.len);
    try testing.expectEqual(model.Kind.nothing, padded.data.list[2].kind());
    try testing.expectEqual(changed, padded.data.list[3]);
    const indexes = try model.range(gpa, one, negative);
    defer indexes.release();
    const replaced = try set(gpa, gpa, original, .item, indexes, changed, ",", &effect);
    defer replaced.release();
    try testing.expectEqualSlices(*Value, changed.data.list, replaced.data.list);
}

test "List chunk writes preserve borrowed inputs and free every refused allocation" {
    try listWriteAllocations(testing.allocator);
    try testing.checkAllAllocationFailures(testing.allocator, listWriteAllocations, .{});
}

fn uniqueBorrowedListWrite(gpa: Allocator) !void {
    const one = try numberValue(gpa, 1);
    defer one.release();
    const two = try numberValue(gpa, 2);
    defer two.release();
    const original = try model.list(gpa, &.{one});
    defer original.release();
    // No alias or rank-raising child forces a copy on behalf of this test.
    // The borrowed-input contract alone must preserve the prior version.
    try testing.expectEqual(@as(usize, 1), original.references);
    var effect: Effect = .{};
    const changed = try set(gpa, gpa, original, .item, one, two, ",", &effect);
    defer changed.release();
    try testing.expect(changed != original);
    try testing.expectEqual(one, original.data.list[0]);
    try testing.expectEqual(two, changed.data.list[0]);
}

test "even a unique borrowed List copies for a lower-ranked point replacement" {
    try uniqueBorrowedListWrite(testing.allocator);
    try testing.checkAllAllocationFailures(testing.allocator, uniqueBorrowedListWrite, .{});
}

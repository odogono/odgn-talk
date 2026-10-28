//! The modal lexer of chapter 1. The parser names the mode of every token it
//! asks for, so a token is never lexed twice in two modes. The lexer keeps no
//! position of its own: `next` lexes the token at an offset, so a parser can
//! peek a second token and come back. Fenced text is scanned once, holes and
//! nested literals included, and remembered by its opening offset, so loading
//! stays linear however deeply literals nest.
const std = @import("std");
const Allocator = std.mem.Allocator;
const grammar = @import("../generated/grammar.zig").grammar;
const unit_table = @import("../generated/units.zig").units;
const units = @import("../units.zig");
const utf8 = @import("../unicode/utf8.zig");

/// What the parser expects next, which decides the few characters that
/// change meaning (chapter 1, Modes).
pub const Mode = enum {
    /// `<` opens a Text Pattern and `<<` a Binary Pattern.
    operand,
    /// `<` is less-than and `>>` closes a Binary Pattern.
    operator,
    /// Inside `<…>`: `<` nests and `>` closes, one character at a time.
    pattern,
    /// After a Number: a Unit if one starts here, else as `operator`.
    unit,
    /// After `as`: a Compound Unit if one starts here, else as `operand`.
    conversion,
};

pub const Kind = enum {
    word,
    number,
    unit,
    /// Quoted text, Raw Text or a backtick literal with no hole.
    text,
    /// A backtick literal with at least one Interpolation Hole.
    template,
    /// A line break, ending its line.
    newline,
    /// The end of the source, or of an Interpolation Hole at its `}`.
    eof,
    ellipsis,
    dot_dot,
    ampersand,
    equal,
    not_equal,
    less_equal,
    greater_equal,
    /// `<<` in operator position, which no production accepts.
    shift,
    /// `>>`, outside a Text Pattern.
    binary_close,
    less,
    greater,
    plus,
    minus,
    star,
    slash,
    caret,
    left_paren,
    right_paren,
    left_bracket,
    right_bracket,
    left_brace,
    right_brace,
    comma,
    colon,
    /// `'s`.
    possessive,
    pattern_open,
    pattern_close,
    binary_open,
    /// A lexical error: the parse fails here with `code`, at `offset`, which
    /// for fenced text may lie inside the literal.
    invalid,
};

pub const Token = struct {
    kind: Kind,
    /// Byte offsets of the token in the source. Trivia before it runs from
    /// the previous token's end to `start`.
    start: usize,
    end: usize,
    /// Whether space, a comment or a line start comes straight before it,
    /// which tells a call's `(` from a grouping one.
    space_before: bool,
    /// For `invalid`: the error's code and where it is reported.
    code: Code = .unexpected_token,
    offset: usize = 0,

    pub fn text(self: Token, source: []const u8) []const u8 {
        return source[self.start..self.end];
    }
};

/// The syntax errors of chapter 2, plus the Zig Core's own nesting limit.
pub const Code = enum {
    bad_character,
    unterminated_text,
    bad_unit,
    unit_without_number,
    unexpected_token,
    not_a_container,
    unterminated_interpolation,
    empty_interpolation,
    invalid_text_escape,
    invalid_text_indentation,
    invalid_text_delimiter,
    /// Not in the Spec's catalogue: an implementation limit, like the Go
    /// Core's, so hostile nesting is a load error and never a stack overflow.
    source_nesting_too_deep,

    pub fn spelling(self: Code) []const u8 {
        return switch (self) {
            inline else => |c| comptime blk: {
                const name = @tagName(c);
                var out: [name.len]u8 = undefined;
                for (name, 0..) |ch, i| out[i] = if (ch == '_') ' ' else ch;
                const final = out;
                break :blk &final;
            },
        };
    }
};

comptime {
    // Every Spec code has a spelling here, and nothing else does.
    @setEvalBranchQuota(100_000);
    for (grammar.syntax_error) |e| {
        var found = false;
        for (std.enums.values(Code)) |c| {
            if (std.mem.eql(u8, c.spelling(), e.code)) found = true;
        }
        if (!found) @compileError("grammar.toml syntax error without a Code: " ++ e.code);
    }
    if (std.enums.values(Code).len != grammar.syntax_error.len + 1) @compileError("a Code isn't in grammar.toml");
}

pub const Diagnostic = struct { code: Code, offset: usize };

const Error = error{Syntax} || Allocator.Error;

/// An Interpolation Hole: `${` at `dollar`, its expression from `start` to
/// the `}` at `end`.
pub const Hole = struct { dollar: usize, start: usize, end: usize };

/// A fenced literal, scanned whole. `pieces` are the decoded text between
/// the holes, one more than `holes`, after margin stripping, escapes and
/// line-break folding, and before NFC.
pub const Fenced = struct {
    end: usize,
    pieces: []const []const u8,
    holes: []const Hole,
};

/// What every Lexer over one source shares: hole lexers included.
pub const Shared = struct {
    source: []const u8,
    /// Owns every Fenced literal.
    arena: Allocator,
    fenced: std.AutoHashMapUnmanaged(usize, Fenced) = .empty,
    /// The error a failed scan found, until `next` turns it into a token.
    diagnostic: ?Diagnostic = null,
};

pub const Lexer = struct {
    shared: *Shared,
    /// The offset that ends this lexer's input: the source's end, or a hole's
    /// `}`.
    limit: usize,

    pub fn init(shared: *Shared) Lexer {
        return .{ .shared = shared, .limit = shared.source.len };
    }

    /// A lexer for one hole's expression, ending in `eof` at its `}`.
    pub fn hole(self: Lexer, h: Hole) Lexer {
        return .{ .shared = self.shared, .limit = h.end };
    }

    fn fail(self: Lexer, code: Code, offset: usize) error{Syntax} {
        self.shared.diagnostic = .{ .code = code, .offset = offset };
        return error.Syntax;
    }

    /// The trivia from `pos`: spaces, tabs, comments, and a byte order mark
    /// at the very start.
    pub fn skip(self: Lexer, pos: usize) usize {
        const s = self.shared.source;
        var i = pos;
        if (i == 0 and std.mem.startsWith(u8, s, "\u{feff}")) i = 3;
        while (i < self.limit) {
            switch (s[i]) {
                ' ', '\t' => i += 1,
                '-' => {
                    if (i + 1 >= self.limit or s[i + 1] != '-') return i;
                    while (i < self.limit and s[i] != '\n' and s[i] != '\r') i += 1;
                },
                else => return i,
            }
        }
        return i;
    }

    /// The fenced literal whose opener is at `start`, scanned by `next`.
    pub fn literal(self: Lexer, start: usize) Fenced {
        return self.shared.fenced.get(start).?;
    }

    /// Lexes the token at or after `pos` in `mode`. A lexical error is an
    /// `invalid` token, so a parser peeking past the token it fails at
    /// still reports that one.
    pub fn next(self: Lexer, pos: usize, mode: Mode) Allocator.Error!Token {
        const at = self.skip(pos);
        return self.lex(pos, at, mode) catch |e| switch (e) {
            error.Syntax => {
                const d = self.shared.diagnostic.?;
                self.shared.diagnostic = null;
                return .{ .kind = .invalid, .start = at, .end = at + 1, .space_before = false, .code = d.code, .offset = d.offset };
            },
            else => |other| other,
        };
    }

    fn lex(self: Lexer, pos: usize, at: usize, mode: Mode) Error!Token {
        const s = self.shared.source;
        const space = at > pos or at == 0 or s[at - 1] == '\n' or s[at - 1] == '\r';
        const tok = struct {
            fn make(kind: Kind, start: usize, len: usize, sp: bool) Token {
                return .{ .kind = kind, .start = start, .end = start + len, .space_before = sp };
            }
        }.make;
        if (at >= self.limit) return tok(.eof, self.limit, 0, space);
        const c = s[at];
        switch (c) {
            // A run of line ends is one token, so blank lines cost nothing
            // per line.
            '\n', '\r' => {
                var end = at + 1;
                while (end < self.limit and (s[end] == '\n' or s[end] == '\r')) end += 1;
                return tok(.newline, at, end - at, space);
            },
            '`' => {
                const f = try self.backtick(at);
                return tok(if (f.holes.len == 0) .text else .template, at, f.end - at, space);
            },
            '"' => {
                if (quoteRun(s, at, self.limit) >= 3) {
                    const f = try self.raw(at);
                    return tok(.text, at, f.end - at, space);
                }
                const end = try self.quoted(at);
                return tok(.text, at, end - at, space);
            },
            else => {},
        }
        if (mode == .unit or mode == .conversion) {
            if (try self.unitAt(at, mode)) |len| return tok(.unit, at, len, space);
            return self.lex(pos, at, if (mode == .unit) .operator else .operand);
        }
        if (std.ascii.isDigit(c)) return tok(.number, at, numberLength(s[at..self.limit]), space);
        if (std.ascii.isAlphabetic(c) or c == '_') return tok(.word, at, wordLength(s[at..self.limit]), space);
        const rest = s[at..self.limit];
        if (c == '\'' and rest.len >= 2 and rest[1] == 's' and (rest.len == 2 or !isWordChar(rest[2]))) return tok(.possessive, at, 2, space);
        if (c == '<') {
            if (mode == .pattern) return tok(.pattern_open, at, 1, space);
            if (mode == .operand) {
                return if (std.mem.startsWith(u8, rest, "<<")) tok(.binary_open, at, 2, space) else tok(.pattern_open, at, 1, space);
            }
            if (std.mem.startsWith(u8, rest, "<<")) return tok(.shift, at, 2, space);
            if (std.mem.startsWith(u8, rest, "<=")) return tok(.less_equal, at, 2, space);
            if (std.mem.startsWith(u8, rest, "<>")) return tok(.not_equal, at, 2, space);
            return tok(.less, at, 1, space);
        }
        if (c == '>') {
            if (mode == .pattern) return tok(.pattern_close, at, 1, space);
            if (std.mem.startsWith(u8, rest, ">>")) return tok(.binary_close, at, 2, space);
            if (std.mem.startsWith(u8, rest, ">=")) return tok(.greater_equal, at, 2, space);
            return tok(.greater, at, 1, space);
        }
        if (std.mem.startsWith(u8, rest, "...")) return tok(.ellipsis, at, 3, space);
        if (std.mem.startsWith(u8, rest, "..")) return tok(.dot_dot, at, 2, space);
        const single: ?Kind = switch (c) {
            '&' => .ampersand,
            '=' => .equal,
            '+' => .plus,
            '-' => .minus,
            '*' => .star,
            '/' => .slash,
            '^' => .caret,
            '(' => .left_paren,
            ')' => .right_paren,
            '[' => .left_bracket,
            ']' => .right_bracket,
            '{' => .left_brace,
            '}' => .right_brace,
            ',' => .comma,
            ':' => .colon,
            else => null,
        };
        if (single) |k| return tok(k, at, 1, space);
        return self.fail(.bad_character, at);
    }

    /// The length of the Unit at `at`, if one starts there.
    fn unitAt(self: Lexer, at: usize, mode: Mode) error{Syntax}!?usize {
        const s = self.shared.source[0..self.limit];
        const leading = std.mem.startsWith(u8, s[at..], "1/");
        if (!leading) {
            if (!std.ascii.isAlphabetic(s[at])) return null;
            if (!isUnitName(s[at .. at + wordLength(s[at..])])) return null;
        }
        // The longest run of the Unit shape that no Word character follows.
        var i = at + @as(usize, if (leading) 2 else 0);
        var end: ?usize = null;
        while (true) {
            const letters = i;
            while (i < s.len and std.ascii.isAlphabetic(s[i])) i += 1;
            if (i == letters) break;
            if (i + 1 < s.len and s[i] == '^') {
                var j = i + 1;
                if (s[j] == '-') j += 1;
                const digits = j;
                while (j < s.len and std.ascii.isDigit(s[j])) j += 1;
                if (j > digits) i = j;
            }
            if (i < s.len and isWordChar(s[i])) break;
            end = i;
            if (i < s.len and (s[i] == '*' or s[i] == '/')) i += 1 else break;
        }
        const stop = end orelse return null;
        const text = s[at..stop];
        if (mode == .conversion and std.mem.indexOfAny(u8, text, "*/^") == null) return null;
        if (!validUnit(text)) return self.fail(.bad_unit, at);
        return stop - at;
    }

    /// Ordinary quoted text, closed on its own line.
    fn quoted(self: Lexer, at: usize) error{Syntax}!usize {
        const s = self.shared.source;
        var i = at + 1;
        while (i < self.limit) : (i += 1) switch (s[i]) {
            '"' => return i + 1,
            '\n', '\r' => break,
            else => {},
        };
        return self.fail(.unterminated_text, at);
    }

    fn remember(self: Lexer, at: usize, f: Fenced) Error!Fenced {
        try self.shared.fenced.put(self.shared.arena, at, f);
        return f;
    }

    /// Raw Text from its opening fence at `at`.
    fn raw(self: Lexer, at: usize) Error!Fenced {
        if (self.shared.fenced.get(at)) |f| return f;
        const s = self.shared.source;
        const fence = quoteRun(s, at, self.limit);
        var i = at + fence;
        while (i < self.limit) {
            if (s[i] != '"') {
                i += 1;
                continue;
            }
            const run = quoteRun(s, i, self.limit);
            if (run == fence) {
                const pieces = [_]Piece{.{ .start = at + fence, .end = i }};
                const decoded = try self.fold(at + fence, i, &pieces, false);
                return self.remember(at, .{ .end = i + run, .pieces = decoded, .holes = &.{} });
            }
            if (run > fence) return self.fail(.invalid_text_delimiter, i);
            i += run;
        }
        return self.fail(.unterminated_text, at);
    }

    /// A backtick literal from its opening backtick at `at`, holes and all.
    fn backtick(self: Lexer, at: usize) Error!Fenced {
        if (self.shared.fenced.get(at)) |f| return f;
        const s = self.shared.source;
        const a = self.shared.arena;
        var pieces: std.ArrayList(Piece) = .empty;
        var holes: std.ArrayList(Hole) = .empty;
        var start = at + 1;
        var i = start;
        while (i < self.limit) {
            switch (s[i]) {
                '\\' => {
                    i += 1;
                    if (i < self.limit) i += if (s[i] == '\r' and i + 1 < self.limit and s[i + 1] == '\n') 2 else utf8.sequenceLength(s[i]);
                },
                '`' => {
                    try pieces.append(a, .{ .start = start, .end = i });
                    const decoded = try self.fold(at + 1, i, pieces.items, true);
                    return self.remember(at, .{ .end = i + 1, .pieces = decoded, .holes = holes.items });
                },
                '$' => {
                    if (i + 1 >= self.limit or s[i + 1] != '{') {
                        i += 1;
                        continue;
                    }
                    try pieces.append(a, .{ .start = start, .end = i });
                    const close = try self.holeEnd(i);
                    try holes.append(a, .{ .dollar = i, .start = i + 2, .end = close });
                    start = close + 1;
                    i = start;
                },
                else => i += 1,
            }
        }
        return self.fail(.unterminated_text, at);
    }

    /// The `}` that closes the hole whose `${` is at `dollar`. Nested text
    /// is scanned (and remembered) whole, so its braces don't count.
    fn holeEnd(self: Lexer, dollar: usize) Error!usize {
        const s = self.shared.source;
        var depth: usize = 0;
        var i = dollar + 2;
        var empty = true;
        while (i < self.limit) {
            const c = s[i];
            switch (c) {
                ' ', '\t', '\n', '\r' => {
                    i += 1;
                    continue;
                },
                else => {},
            }
            if (c == '}' and depth == 0) {
                if (empty) return self.fail(.empty_interpolation, dollar);
                return i;
            }
            if (c == '-' and i + 1 < self.limit and s[i + 1] == '-') {
                while (i < self.limit and s[i] != '\n' and s[i] != '\r') i += 1;
                continue;
            }
            empty = false;
            switch (c) {
                '{' => {
                    depth += 1;
                    i += 1;
                },
                '}' => {
                    depth -= 1;
                    i += 1;
                },
                '`' => i = (try self.backtick(i)).end,
                '"' => i = if (quoteRun(s, i, self.limit) >= 3) (try self.raw(i)).end else try self.quoted(i),
                else => i += 1,
            }
        }
        return self.fail(.unterminated_interpolation, dollar);
    }

    const Piece = struct { start: usize, end: usize };

    /// Decodes a fenced literal's pieces: the margin strip, when the opener
    /// ends its line, then line-break folding and, for backticks, escapes.
    /// `open` is the offset after the opener and `close` the closer's.
    fn fold(self: Lexer, open: usize, close: usize, pieces: []const Piece, escapes: bool) Error![]const []const u8 {
        const s = self.shared.source;
        const a = self.shared.arena;
        var margin: ?[]const u8 = null;
        var first = open;
        if (open < close and (s[open] == '\n' or s[open] == '\r')) {
            // Margin-stripped form: the closer's line holds only the margin.
            var line = close;
            while (line > open and s[line - 1] != '\n' and s[line - 1] != '\r') line -= 1;
            for (s[line..close], line..) |ch, k| {
                if (ch != ' ' and ch != '\t') return self.fail(.invalid_text_indentation, k);
            }
            margin = s[line..close];
            first = open + lineBreakLength(s, open);
        }
        const out = try a.alloc([]const u8, pieces.len);
        for (pieces, 0..) |p, n| {
            var start = if (n == 0) first else p.start;
            var end = p.end;
            if (margin) |m| {
                // Drop the line break before the closer's margin.
                if (n == pieces.len - 1) {
                    end -= m.len;
                    if (end > start) end -= if (s[end - 1] == '\n' and end >= start + 2 and s[end - 2] == '\r') 2 else 1;
                    if (end < start) end = start;
                }
            }
            var spans: std.ArrayList(Piece) = .empty;
            var line_start = n == 0 and margin != null;
            var i = start;
            while (i < end) {
                if (line_start) {
                    i = try self.stripMargin(i, end, margin.?);
                    start = i;
                    line_start = false;
                }
                if (i >= end) break;
                if (s[i] == '\n' or s[i] == '\r') {
                    i += lineBreakLength(s, i);
                    if (margin != null) {
                        try spans.append(a, .{ .start = start, .end = @min(i, end) });
                        start = i;
                        line_start = true;
                    }
                    continue;
                }
                i += 1;
            }
            if (start < end) try spans.append(a, .{ .start = start, .end = end });
            out[n] = try self.decode(spans.items, escapes);
        }
        return out;
    }

    /// Skips one margin from a content line at `i`, checking it.
    fn stripMargin(self: Lexer, i: usize, end: usize, margin: []const u8) error{Syntax}!usize {
        const s = self.shared.source;
        var k: usize = 0;
        while (k < margin.len) : (k += 1) {
            const at = i + k;
            // A whitespace-only line shorter than the margin is a prefix of it.
            if (at >= end or s[at] == '\n' or s[at] == '\r') {
                if (at >= end and end < s.len and s[end] == '$') return self.fail(.invalid_text_indentation, at);
                return at;
            }
            if (s[at] != margin[k]) return self.fail(.invalid_text_indentation, at);
        }
        return i + margin.len;
    }

    /// Folds line breaks to LF and, for backticks, decodes escapes.
    fn decode(self: Lexer, spans: []const Piece, escapes: bool) Error![]const u8 {
        const s = self.shared.source;
        var out: std.ArrayList(u8) = .empty;
        const a = self.shared.arena;
        var high: ?struct { value: u21, at: usize } = null;
        for (spans) |span| {
            var i = span.start;
            while (i < span.end) {
                const c = s[i];
                if (c == '\r' or c == '\n') {
                    if (high) |h| return self.fail(.invalid_text_escape, h.at);
                    try out.append(a, '\n');
                    i += lineBreakLength(s, i);
                    continue;
                }
                if (!escapes or c != '\\') {
                    if (high) |h| return self.fail(.invalid_text_escape, h.at);
                    const len = utf8.sequenceLength(c);
                    try out.appendSlice(a, s[i .. i + len]);
                    i += len;
                    continue;
                }
                const e = try self.escape(i, span.end);
                i = e.end;
                const v = e.value orelse continue;
                if (v >= 0xdc00 and v <= 0xdfff) {
                    const h = high orelse return self.fail(.invalid_text_escape, e.at);
                    high = null;
                    try appendScalar(&out, a, 0x10000 + ((h.value - 0xd800) << 10) + (v - 0xdc00));
                    continue;
                }
                if (high) |h| return self.fail(.invalid_text_escape, h.at);
                if (v >= 0xd800 and v <= 0xdbff) {
                    high = .{ .value = v, .at = e.at };
                    continue;
                }
                try appendScalar(&out, a, v);
            }
        }
        if (high) |h| return self.fail(.invalid_text_escape, h.at);
        return out.items;
    }

    const Escape = struct { at: usize, end: usize, value: ?u21 };

    /// The backtick escape whose backslash is at `at`. A line continuation
    /// has no value.
    fn escape(self: Lexer, at: usize, end: usize) error{Syntax}!Escape {
        const s = self.shared.source;
        const i = at + 1;
        if (i >= end) return self.fail(.invalid_text_escape, at);
        const c = s[i];
        const simple: ?u21 = switch (c) {
            'b' => 0x08,
            'f' => 0x0c,
            'n' => 0x0a,
            'r' => 0x0d,
            't' => 0x09,
            'v' => 0x0b,
            else => null,
        };
        if (simple) |v| return .{ .at = at, .end = i + 1, .value = v };
        switch (c) {
            '\n', '\r' => return .{ .at = at, .end = i + lineBreakLength(s, i), .value = null },
            '0' => {
                if (i + 1 < end and std.ascii.isDigit(s[i + 1])) return self.fail(.invalid_text_escape, at);
                return .{ .at = at, .end = i + 1, .value = 0 };
            },
            '1'...'9' => return self.fail(.invalid_text_escape, at),
            'x' => {
                const v = hexValue(s[@min(i + 1, end)..@min(i + 3, end)], 2) orelse return self.fail(.invalid_text_escape, at);
                return .{ .at = at, .end = i + 3, .value = v };
            },
            'u' => {
                if (i + 1 < end and s[i + 1] == '{') {
                    const close = std.mem.indexOfScalarPos(u8, s[0..end], i + 2, '}') orelse return self.fail(.invalid_text_escape, at);
                    const digits = s[i + 2 .. close];
                    if (digits.len == 0) return self.fail(.invalid_text_escape, at);
                    var v: u32 = 0;
                    for (digits) |d| {
                        const h = std.fmt.charToDigit(d, 16) catch return self.fail(.invalid_text_escape, at);
                        v = v * 16 + h;
                        if (v > 0x10ffff) return self.fail(.invalid_text_escape, at);
                    }
                    return .{ .at = at, .end = close + 1, .value = @intCast(v) };
                }
                const v = hexValue(s[@min(i + 1, end)..@min(i + 5, end)], 4) orelse return self.fail(.invalid_text_escape, at);
                return .{ .at = at, .end = i + 5, .value = v };
            },
            else => {
                const v = utf8.decode(s, i);
                // U+2028 and U+2029 continue the line too.
                const len = utf8.sequenceLength(c);
                if (v == 0x2028 or v == 0x2029) return .{ .at = at, .end = i + len, .value = null };
                return .{ .at = at, .end = i + len, .value = v };
            },
        }
    }
};

fn appendScalar(out: *std.ArrayList(u8), a: Allocator, v: u21) Allocator.Error!void {
    var buf: [4]u8 = undefined;
    try out.appendSlice(a, buf[0..utf8.encode(v, &buf)]);
}

fn hexValue(digits: []const u8, len: usize) ?u21 {
    if (digits.len != len) return null;
    var v: u21 = 0;
    for (digits) |d| v = v * 16 + (std.fmt.charToDigit(d, 16) catch return null);
    return v;
}

fn lineBreakLength(s: []const u8, i: usize) usize {
    return if (s[i] == '\r' and i + 1 < s.len and s[i + 1] == '\n') 2 else 1;
}

fn quoteRun(s: []const u8, at: usize, limit: usize) usize {
    var i = at;
    while (i < limit and s[i] == '"') i += 1;
    return i - at;
}

pub fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

fn wordLength(s: []const u8) usize {
    var i: usize = 1;
    while (i < s.len and isWordChar(s[i])) i += 1;
    return i;
}

fn numberLength(s: []const u8) usize {
    if (s.len > 2 and s[0] == '0' and s[1] == 'x' and std.ascii.isHex(s[2])) {
        var i: usize = 3;
        while (i < s.len and std.ascii.isHex(s[i])) i += 1;
        return i;
    }
    var i: usize = 1;
    while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
    if (i + 1 < s.len and s[i] == '.' and std.ascii.isDigit(s[i + 1])) {
        i += 2;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
    }
    return i;
}

/// Whether `word` is a Unit's name or plural in the catalogue.
pub fn isUnitName(word: []const u8) bool {
    return unitIndex(word) != null;
}

fn unitIndex(word: []const u8) ?usize {
    for (unit_table.unit, 0..) |u, i| {
        if (std.mem.eql(u8, word, u.name) or (u.plural != null and std.mem.eql(u8, word, u.plural.?))) return i;
    }
    return null;
}

fn isCalendar(unit: usize) bool {
    for (unit_table.kind) |k| {
        if (std.mem.eql(u8, k.name, unit_table.unit[unit].kind)) return k.calendar orelse false;
    }
    return false;
}

/// A Unit-shaped run is a Unit when every factor is in the catalogue, each
/// exponent is a positive integer, there is at most one `/`, no Unit Kind
/// has two Units, and a Calendar Unit stands alone.
fn validUnit(text: []const u8) bool {
    var slashes: usize = if (std.mem.startsWith(u8, text, "1/")) 1 else 0;
    const body = text[slashes * 2 ..];
    var factors = std.mem.tokenizeAny(u8, body, "*/");
    var count: usize = 0;
    var calendar = false;
    while (factors.next()) |factor| {
        count += 1;
        const caret = std.mem.indexOfScalar(u8, factor, '^');
        const unit = unitIndex(factor[0 .. caret orelse factor.len]) orelse return false;
        if (caret) |c| {
            const exponent = factor[c + 1 ..];
            if (exponent[0] < '1' or exponent[0] > '9') return false;
            if (isCalendar(unit)) return false;
        }
        if (isCalendar(unit)) calendar = true;
    }
    slashes += std.mem.count(u8, body, "/");
    if (slashes > 1) return false;
    if (calendar and (count > 1 or slashes > 0)) return false;
    _ = units.Unit.parse(text) catch return false;
    return true;
}

/// Source positions: a line and a column, both from 1, where a column counts
/// Unicode scalar values and a line break is LF, CR LF or CR.
pub const Lines = struct {
    source: []const u8,
    starts: []const usize,
    /// The last position found, so a run of positions on one long line costs
    /// its length once, not once per position.
    cache: struct { line: usize = 0, offset: usize = 0, column: usize = 1 } = .{},

    pub fn init(a: Allocator, source: []const u8) Allocator.Error!Lines {
        var count: usize = 1;
        var i: usize = 0;
        while (i < source.len) {
            if (source[i] == '\n' or source[i] == '\r') {
                i += lineBreakLength(source, i);
                count += 1;
            } else i += 1;
        }
        const starts = try a.alloc(usize, count);
        starts[0] = 0;
        var next: usize = 1;
        i = 0;
        while (i < source.len) {
            if (source[i] == '\n' or source[i] == '\r') {
                i += lineBreakLength(source, i);
                starts[next] = i;
                next += 1;
            } else i += 1;
        }
        return .{ .source = source, .starts = starts };
    }

    pub fn deinit(self: *Lines, a: Allocator) void {
        a.free(self.starts);
    }

    pub const Position = struct { line: usize, column: usize };

    pub fn position(self: *Lines, offset: usize) Position {
        var lo: usize = 0;
        var hi = self.starts.len - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) / 2;
            if (self.starts[mid] <= offset) lo = mid else hi = mid - 1;
        }
        var from = self.starts[lo];
        var column: usize = 1;
        if (self.cache.line == lo and self.cache.offset <= offset and self.cache.offset >= from) {
            from = self.cache.offset;
            column = self.cache.column;
        }
        for (self.source[from..offset]) |b| {
            if (b & 0xc0 != 0x80) column += 1;
        }
        self.cache = .{ .line = lo, .offset = offset, .column = column };
        return .{ .line = lo + 1, .column = column };
    }
};

const testing = std.testing;

const Fixture = struct {
    arena: std.heap.ArenaAllocator,
    shared: Shared,

    fn init(source: []const u8) *Fixture {
        const f = testing.allocator.create(Fixture) catch unreachable;
        f.* = .{ .arena = .init(testing.allocator), .shared = undefined };
        f.shared = .{ .source = source, .arena = f.arena.allocator() };
        return f;
    }

    fn deinit(f: *Fixture) void {
        f.arena.deinit();
        testing.allocator.destroy(f);
    }

    fn lexer(f: *Fixture) Lexer {
        return .init(&f.shared);
    }

    /// The kinds and texts of every token, lexed in one mode.
    fn all(f: *Fixture, mode: Mode) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        const a = f.arena.allocator();
        var pos: usize = 0;
        while (true) {
            const t = try f.lexer().next(pos, mode);
            if (t.kind == .invalid) {
                f.shared.diagnostic = .{ .code = t.code, .offset = t.offset };
                return error.Syntax;
            }
            if (out.items.len > 0) try out.append(a, ' ');
            try out.print(a, "{s}", .{@tagName(t.kind)});
            if (t.end > t.start and t.kind != .newline) try out.print(a, ":{s}", .{t.text(f.shared.source)});
            if (t.kind == .eof) return out.items;
            pos = t.end;
        }
    }

    fn failure(f: *Fixture, mode: Mode) !struct { code: Code, line: usize, column: usize } {
        _ = f.all(mode) catch |e| {
            try testing.expectEqual(error.Syntax, e);
            const d = f.shared.diagnostic.?;
            var lines: Lines = try .init(testing.allocator, f.shared.source);
            defer lines.deinit(testing.allocator);
            const p = lines.position(d.offset);
            return .{ .code = d.code, .line = p.line, .column = p.column };
        };
        return error.TestUnexpectedResult;
    }
};

fn expectTokens(source: []const u8, mode: Mode, expected: []const u8) !void {
    const f = Fixture.init(source);
    defer f.deinit();
    try testing.expectEqualStrings(expected, try f.all(mode));
}

fn expectFailure(source: []const u8, mode: Mode, code: Code, line: usize, column: usize) !void {
    const f = Fixture.init(source);
    defer f.deinit();
    const got = try f.failure(mode);
    try testing.expectEqual(code, got.code);
    try testing.expectEqual(line, got.line);
    try testing.expectEqual(column, got.column);
}

fn expectPieces(source: []const u8, expected: []const []const u8) !void {
    const f = Fixture.init(source);
    defer f.deinit();
    const t = try f.lexer().next(0, .operand);
    try testing.expect(t.kind == .text or t.kind == .template);
    try testing.expectEqual(source.len, t.end);
    const lit = f.lexer().literal(0);
    try testing.expectEqual(expected.len, lit.pieces.len);
    for (expected, lit.pieces) |e, p| try testing.expectEqualStrings(e, p);
}

test "spelling matches the Spec's codes" {
    try testing.expectEqualStrings("bad character", Code.bad_character.spelling());
    try testing.expectEqualStrings("unterminated interpolation", Code.unterminated_interpolation.spelling());
}

test "words, numbers, punctuators and the longest match" {
    try expectTokens("put 2.50 into x_1", .operator, "word:put number:2.50 word:into word:x_1 eof");
    try expectTokens("0x0D 0xg 1..3 12abc", .operator, "number:0x0D number:0 word:xg number:1 dot_dot:.. number:3 number:12 word:abc eof");
}

test "punctuators in operator position" {
    try expectTokens("... .. & = <> <= >= << >> < > + - * / ^ ( ) [ ] { } , : 's", .operator, "ellipsis:... dot_dot:.. ampersand:& equal:= not_equal:<> less_equal:<= greater_equal:>= shift:<< binary_close:>> less:< greater:> plus:+ minus:- star:* slash:/ caret:^ left_paren:( right_paren:) left_bracket:[ right_bracket:] left_brace:{ right_brace:} comma:, colon:: possessive:'s eof");
}

test "modes change only angle brackets" {
    try expectTokens("<< < <=", .operand, "binary_open:<< pattern_open:< pattern_open:< equal:= eof");
    try expectTokens("<< >>", .pattern, "pattern_open:< pattern_open:< pattern_close:> pattern_close:> eof");
}

test "comments, spaces, line breaks and the byte order mark" {
    try expectTokens("\u{feff}5--3\r\nx\ry\n", .operator, "number:5 newline word:x newline word:y newline eof");
    const f = Fixture.init("f(x) f (x)");
    defer f.deinit();
    const l = f.lexer();
    const name = try l.next(0, .operand);
    try testing.expect(name.space_before);
    try testing.expect(!(try l.next(name.end, .operator)).space_before);
    try testing.expect((try l.next(6, .operator)).space_before);
}

test "possessive and bad characters" {
    try expectTokens("x's y", .operator, "word:x possessive:'s word:y eof");
    try expectFailure("x'st", .operator, .bad_character, 1, 2);
    try expectFailure("put naïve into x", .operator, .bad_character, 1, 7);
    try expectFailure("x \u{feff}", .operator, .bad_character, 1, 3);
    try expectFailure("x . y", .operator, .bad_character, 1, 3);
}

test "quoted text has no escapes and ends on its line" {
    try expectTokens("\"C:\\new\"", .operand, "text:\"C:\\new\" eof");
    try expectFailure("put \"abc into x\nend", .operand, .unterminated_text, 1, 5);
}

test "Units after a Number" {
    try expectTokens("5 s", .unit, "number:5 unit:s eof");
    try expectTokens("60 mi/hr", .unit, "number:60 unit:mi/hr eof");
    try expectTokens("9.81 m/s^2", .unit, "number:9.81 unit:m/s^2 eof");
    try expectTokens("1/s", .unit, "unit:1/s eof");
    try expectTokens("mod", .unit, "word:mod eof");
    try expectTokens("m2", .unit, "word:m2 eof");
    try expectTokens("m*m", .unit, "unit:m*m eof");
    try expectFailure("s^-1", .unit, .bad_unit, 1, 1);
    try expectFailure("USD/month", .unit, .bad_unit, 1, 1);
    try expectFailure("m*ft", .unit, .bad_unit, 1, 1);
    try expectFailure("m*width", .unit, .bad_unit, 1, 1);
    try expectFailure("m/s/s", .unit, .bad_unit, 1, 1);
    try expectFailure("m^0", .unit, .bad_unit, 1, 1);
    try expectFailure("month^1", .unit, .bad_unit, 1, 1);
}

test "only a Compound Unit follows as" {
    try expectTokens("kg", .conversion, "word:kg eof");
    try expectTokens("m/s", .conversion, "unit:m/s eof");
    try expectTokens("m^2", .conversion, "unit:m^2 eof");
    try expectTokens("<", .conversion, "pattern_open:< eof");
}

test "Raw Text" {
    try expectPieces("\"\"\"say \"hi\" \"\" \"\"\"", &.{"say \"hi\" \"\" "});
    try expectPieces("\"\"\"\"a \"\"\" b\"\"\"\"", &.{"a \"\"\" b"});
    try expectPieces("\"\"\"\n  one\r\n\n    two\n  \"\"\"", &.{"one\n\n  two"});
    try expectFailure("constant x = \"\"\"hello\"\"\"\"\n", .operand, .invalid_text_delimiter, 1, 22);
    try expectFailure("x \"\"\"\"\"\"\n", .operand, .unterminated_text, 1, 3);
}

test "backtick escapes" {
    try expectPieces("`\\x41\\u0042\\u{1F600}\\q \\${name}\\r`", &.{"AB\u{1F600}q ${name}\r"});
    try expectPieces("`\\b\\f\\n\\t\\v\\0 \\\\\\``", &.{"\x08\x0c\n\t\x0b\x00 \\`"});
    try expectPieces("`a\\\nb\\\r\nc\\\u{2028}d`", &.{"abcd"});
    try expectPieces("`\\uD83D\\uDE00`", &.{"\u{1F600}"});
    try expectFailure("constant x = `\\uD800`\n", .operand, .invalid_text_escape, 1, 15);
    try expectFailure("`\\uDE00`", .operand, .invalid_text_escape, 1, 2);
    try expectFailure("`\\01`", .operand, .invalid_text_escape, 1, 2);
    try expectFailure("`a\\7`", .operand, .invalid_text_escape, 1, 3);
    try expectFailure("`\\xg1`", .operand, .invalid_text_escape, 1, 2);
    try expectFailure("`\\u{110000}`", .operand, .invalid_text_escape, 1, 2);
    try expectFailure("`\\u{}`", .operand, .invalid_text_escape, 1, 2);
}

test "Interpolation Holes" {
    try expectPieces("`count ${n}`", &.{ "count ", "" });
    try expectPieces("`${1}${2}x`", &.{ "", "", "x" });
    try expectPieces("`a ${ {k: `}${\"}\"}`} } b`", &.{ "a ", " b" });
    const f = Fixture.init("`a ${x -- }\n} b` + 1");
    defer f.deinit();
    const t = try f.lexer().next(0, .operand);
    try testing.expectEqual(Kind.template, t.kind);
    const h = f.lexer().literal(0).holes[0];
    try testing.expectEqual(@as(usize, 3), h.dollar);
    const inner = f.lexer().hole(h);
    const x = try inner.next(h.start, .operand);
    try testing.expectEqualStrings("x", x.text(f.shared.source));
    try testing.expectEqual(Kind.newline, (try inner.next(x.end, .operator)).kind);
    try testing.expectEqual(Kind.eof, (try inner.next(12, .operator)).kind);
    try expectFailure("constant x = `${}`\n", .operand, .empty_interpolation, 1, 15);
    try expectFailure("`${ -- nothing\n }`", .operand, .empty_interpolation, 1, 2);
    try expectFailure("constant x = `hello ${1 +\n", .operand, .unterminated_interpolation, 1, 21);
    try expectFailure("`a ${ `b ", .operand, .unterminated_text, 1, 7);
    try expectFailure("`a ${ \"b }`\n", .operand, .unterminated_text, 1, 7);
    try expectFailure("`abc", .operand, .unterminated_text, 1, 1);
}

test "margin-stripped backticks" {
    try expectPieces("`\n    first\\\n    second\n    `", &.{"firstsecond"});
    try expectPieces("`\n  a ${x}\n  b\n \n\n  `", &.{ "a ", "\nb\n\n" });
    try expectPieces("`inline\n  keeps`", &.{"inline\n  keeps"});
    try expectPieces("`\n\t x  \n\t `", &.{"x  "});
    try expectFailure("constant x = `\n  x\n   `\n", .operand, .invalid_text_indentation, 2, 3);
    try expectFailure("constant x = `\n  first\n  \\u{1f600}`\n", .operand, .invalid_text_indentation, 3, 3);
    try expectFailure("constant x = \"\"\"\n  first\n  \\u{1f600}\"\"\"\n", .operand, .invalid_text_indentation, 3, 3);
    try expectFailure("`\n\tx\n  `", .operand, .invalid_text_indentation, 2, 1);
    try expectFailure("`\n ${x}\n  `", .operand, .invalid_text_indentation, 2, 2);
}

test "positions count scalar values" {
    var lines: Lines = try .init(testing.allocator, "a\r\nbé\u{1F600}x\ry");
    defer lines.deinit(testing.allocator);
    try testing.expectEqual(Lines.Position{ .line = 2, .column = 3 }, lines.position(6));
    try testing.expectEqual(Lines.Position{ .line = 2, .column = 4 }, lines.position(10));
    try testing.expectEqual(Lines.Position{ .line = 3, .column = 1 }, lines.position(12));
    try testing.expectEqual(Lines.Position{ .line = 1, .column = 2 }, lines.position(1));
}

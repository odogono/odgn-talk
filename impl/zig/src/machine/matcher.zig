//! Text Patterns (chapter 4) and the matcher their programs run on (chapter
//! 8, Text Pattern programs). A pattern value holds its canonical source;
//! this module reads it back into elements, splices a template's values in,
//! writes the canonical source of the result, compiles it, and runs the
//! program as chapter 8's Pike VM, counting its `steps`.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const display = @import("../display.zig");
const unicode = @import("../unicode/unicode.zig");
const Value = model.Value;

pub const Class = enum { any, digit, letter, uppercase, lowercase, punctuation, whitespace, nonspace };
pub const Anchor = enum { text_start, text_end, line_start, line_end, word_break };
pub const Repeat = enum { one_or_more, zero_or_more, optional };

/// The keywords, singular and plural.
pub const Keyword = enum {
    character,
    characters,
    digit,
    digits,
    letter,
    letters,
    uppercase_letter,
    uppercase_letters,
    lowercase_letter,
    lowercase_letters,
    punctuation,
    space,
    spaces,
    whitespace,
    word,
    words,
    text,

    fn named(s: []const u8) ?Keyword {
        if (std.mem.indexOfScalar(u8, s, '_') != null) return null;
        return std.meta.stringToEnum(Keyword, s);
    }

    fn source(k: Keyword) []const u8 {
        return switch (k) {
            .uppercase_letter => "uppercase letter",
            .uppercase_letters => "uppercase letters",
            .lowercase_letter => "lowercase letter",
            .lowercase_letters => "lowercase letters",
            inline else => |x| @tagName(x),
        };
    }

    /// A plural's singular, which `n` counts.
    fn singular(k: Keyword) Keyword {
        return switch (k) {
            .characters => .character,
            .digits => .digit,
            .letters => .letter,
            .uppercase_letters => .uppercase_letter,
            .lowercase_letters => .lowercase_letter,
            .spaces => .space,
            else => k,
        };
    }
};

pub const Node = union(enum) {
    /// A text literal, or spliced text.
    literal: []const u8,
    keyword: Keyword,
    /// `a number`.
    number: []const u8,
    anchor: Anchor,
    /// `<…>`.
    group: []Element,
    alternation: []Element,
    repetition: struct { kind: Repeat, atom: *Element },
    count: struct { n: usize, atom: *Element },
    capture: struct { name: []const u8, body: *Element },
    /// A template's `(k)`, from 1.
    splice: usize,
};

pub const Element = struct {
    node: Node,
    as_number: bool = false,
    fold: bool = false,
    lazily: bool = false,
};

// ---------------------------------------------------------------- reading

const Parser = struct {
    reader: display.Reader,
    template: bool,

    fn a(p: *Parser) Allocator {
        return p.reader.allocator;
    }

    fn rest(p: *Parser) []const u8 {
        return p.reader.input[p.reader.pos..];
    }

    fn expect(p: *Parser, s: []const u8) !void {
        if (!p.reader.take(s)) return error.InvalidValue;
    }

    fn name(p: *Parser) []const u8 {
        const s = p.rest();
        var i: usize = 0;
        while (i < s.len and (std.ascii.isAlphanumeric(s[i]) or s[i] == '_')) : (i += 1) {}
        if (i > 0 and std.ascii.isDigit(s[0])) return "";
        p.reader.pos += i;
        return s[0..i];
    }

    fn pattern(p: *Parser) anyerror![]Element {
        try p.expect("<");
        var out: std.ArrayList(Element) = .empty;
        if (p.reader.take(">")) return out.items;
        _ = p.reader.take(" ");
        try out.append(p.a(), try p.alternation());
        while (p.reader.take(", ")) try out.append(p.a(), try p.alternation());
        try p.expect(">");
        return out.items;
    }

    fn alternation(p: *Parser) anyerror!Element {
        const first = try p.element();
        if (!std.mem.startsWith(u8, p.rest(), " or ")) return first;
        var items: std.ArrayList(Element) = .empty;
        try items.append(p.a(), first);
        while (p.reader.take(" or ")) try items.append(p.a(), try p.element());
        return .{ .node = .{ .alternation = items.items } };
    }

    fn element(p: *Parser) anyerror!Element {
        var e: Element = .{ .node = try p.atom() };
        e.as_number = p.reader.take(" as number");
        e.fold = p.reader.take(" ignoring case");
        e.lazily = p.reader.take(" lazily");
        return e;
    }

    fn boxed(p: *Parser, e: Element) !*Element {
        const b = try p.a().create(Element);
        b.* = e;
        return b;
    }

    fn atom(p: *Parser) anyerror!Node {
        const s = p.rest();
        if (s.len == 0) return error.InvalidValue;
        if (s[0] == '<') return .{ .group = try p.pattern() };
        if (s[0] == '(' and p.template) {
            var i: usize = 1;
            while (i < s.len and std.ascii.isDigit(s[i])) : (i += 1) {}
            if (i > 1 and i < s.len and s[i] == ')') {
                p.reader.pos += i + 1;
                return .{ .splice = try std.fmt.parseInt(usize, s[1..i], 10) };
            }
        }
        if (s[0] == '"' or s[0] == '(') {
            const parens = p.reader.take("(");
            const v = try p.reader.read(0);
            defer v.release();
            if (v.data != .text) return error.InvalidValue;
            if (parens) try p.expect(")");
            return .{ .literal = try p.a().dupe(u8, v.data.text) };
        }
        if (std.ascii.isDigit(s[0])) {
            var i: usize = 0;
            while (i < s.len and std.ascii.isDigit(s[i])) : (i += 1) {}
            const n = try std.fmt.parseInt(usize, s[0..i], 10);
            p.reader.pos += i;
            try p.expect(" ");
            return .{ .count = .{ .n = n, .atom = try p.boxed(.{ .node = try p.atom() }) } };
        }
        const word = p.name();
        if (word.len == 0) return error.InvalidValue;
        if (p.reader.take(": ")) return .{ .capture = .{ .name = word, .body = try p.boxed(try p.alternation()) } };
        if (std.mem.eql(u8, word, "optional")) {
            try p.expect(" ");
            return .{ .repetition = .{ .kind = .optional, .atom = try p.boxed(.{ .node = try p.atom() }) } };
        }
        if (std.mem.eql(u8, word, "one") or std.mem.eql(u8, word, "zero")) {
            try p.expect(" or more of ");
            const kind: Repeat = if (word[0] == 'o') .one_or_more else .zero_or_more;
            return .{ .repetition = .{ .kind = kind, .atom = try p.boxed(.{ .node = try p.atom() }) } };
        }
        if (std.mem.eql(u8, word, "a") or std.mem.eql(u8, word, "an")) {
            try p.expect(" number");
            return .{ .number = word };
        }
        if (std.mem.eql(u8, word, "uppercase") or std.mem.eql(u8, word, "lowercase")) {
            try p.expect(" ");
            const plural = p.reader.take("letters");
            if (!plural) try p.expect("letter");
            return .{ .keyword = if (word[0] == 'u')
                (if (plural) .uppercase_letters else .uppercase_letter)
            else if (plural) .lowercase_letters else .lowercase_letter };
        }
        if (std.mem.eql(u8, word, "text") or std.mem.eql(u8, word, "line")) {
            if (p.reader.take(" start")) return .{ .anchor = if (word[0] == 't') .text_start else .line_start };
            if (p.reader.take(" end")) return .{ .anchor = if (word[0] == 't') .text_end else .line_end };
        }
        if (std.mem.eql(u8, word, "word") and p.reader.take(" break")) return .{ .anchor = .word_break };
        const k = Keyword.named(word) orelse return error.InvalidValue;
        return .{ .keyword = k };
    }
};

/// Reads a canonical source, or a template's with `(1)`, `(2)`, … splices,
/// into its top-level elements.
pub fn read(a: Allocator, source: []const u8, template: bool) ![]Element {
    var p: Parser = .{ .reader = .{ .allocator = a, .input = source }, .template = template };
    const out = try p.pattern();
    if (p.reader.pos != source.len) return error.InvalidValue;
    return out;
}

// ---------------------------------------------------------------- splicing

/// What making a pattern raises.
pub const Problem = union(enum) {
    /// A splice that is neither a pattern nor text.
    wrong_kind: *Value,
    /// A splice whose Captures clash, by name or by sitting in a repetition.
    clash: *Value,
};

/// `make-pattern`: the template's elements with each `(k)` replaced by the
/// k-th value, a pattern as a group and text as a literal.
pub fn splice(a: Allocator, template: []const u8, values: []const *Value, problem: *?Problem) ![]Element {
    const elements = try read(a, template, true);
    for (elements) |*e| try spliceInto(a, e, values, problem);
    var names: std.ArrayList([]const u8) = .empty;
    for (elements) |e| if (!try checkCaptures(a, e, false, &names)) {
        problem.* = .{ .clash = firstPattern(values) };
        return error.Raised;
    };
    return elements;
}

fn firstPattern(values: []const *Value) *Value {
    for (values) |v| if (v.data == .pattern) return v;
    return values[0];
}

fn spliceInto(a: Allocator, e: *Element, values: []const *Value, problem: *?Problem) !void {
    switch (e.node) {
        .splice => |k| {
            const v = values[k - 1];
            e.node = switch (v.data) {
                .pattern => |src| .{ .group = try read(a, src, false) },
                .text => |t| .{ .literal = t },
                else => {
                    problem.* = .{ .wrong_kind = v };
                    return error.Raised;
                },
            };
        },
        .group, .alternation => |xs| for (xs) |*x| try spliceInto(a, x, values, problem),
        .repetition => |r| try spliceInto(a, r.atom, values, problem),
        .count => |c| try spliceInto(a, c.atom, values, problem),
        .capture => |c| try spliceInto(a, c.body, values, problem),
        else => {},
    }
}

/// Whether the element's Captures have distinct names and none sits in a
/// repetition.
fn checkCaptures(a: Allocator, e: Element, repeated: bool, names: *std.ArrayList([]const u8)) !bool {
    switch (e.node) {
        .capture => |c| {
            if (repeated) return false;
            for (names.items) |n| if (std.mem.eql(u8, n, c.name)) return false;
            try names.append(a, c.name);
            return checkCaptures(a, c.body.*, repeated, names);
        },
        .group, .alternation => |xs| {
            for (xs) |x| if (!try checkCaptures(a, x, repeated, names)) return false;
            return true;
        },
        .repetition => |r| return checkCaptures(a, r.atom.*, true, names),
        .count => |c| return checkCaptures(a, c.atom.*, repeated or c.n != 1, names),
        else => return true,
    }
}

// ---------------------------------------------------------------- writing

/// The canonical source of a pattern's elements.
pub fn write(a: Allocator, elements: []const Element) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try writeGroup(a, &out, elements);
    return out.items;
}

fn writeGroup(a: Allocator, out: *std.ArrayList(u8), elements: []const Element) !void {
    try out.append(a, '<');
    var first = true;
    for (elements) |e| {
        if (e.node == .group and e.node.group.len == 0 and !e.as_number and !e.fold and !e.lazily) continue;
        if (!first) try out.appendSlice(a, ", ");
        const at = out.items.len;
        try writeElement(a, out, e);
        // A leading group is written `< <`, never `<<`.
        if (first and out.items[at] == '<') try out.insert(a, at, ' ');
        first = false;
    }
    try out.append(a, '>');
}

fn writeElement(a: Allocator, out: *std.ArrayList(u8), e: Element) anyerror!void {
    switch (e.node) {
        .literal => |t| {
            const v = try model.text(a, t);
            defer v.release();
            const shown = try display.string(a, v);
            if (shown[0] == '"' and std.mem.indexOf(u8, shown, " & ") == null) {
                try out.appendSlice(a, shown);
            } else try out.print(a, "({s})", .{shown});
        },
        .keyword => |k| try out.appendSlice(a, k.source()),
        .number => |article| try out.print(a, "{s} number", .{article}),
        .anchor => |k| try out.appendSlice(a, switch (k) {
            .text_start => "text start",
            .text_end => "text end",
            .line_start => "line start",
            .line_end => "line end",
            .word_break => "word break",
        }),
        .group => |xs| try writeGroup(a, out, xs),
        .alternation => |xs| for (xs, 0..) |x, i| {
            if (i > 0) try out.appendSlice(a, " or ");
            try writeElement(a, out, x);
        },
        .repetition => |r| {
            try out.appendSlice(a, switch (r.kind) {
                .one_or_more => "one or more of ",
                .zero_or_more => "zero or more of ",
                .optional => "optional ",
            });
            try writeElement(a, out, r.atom.*);
        },
        .count => |c| {
            try out.print(a, "{d} ", .{c.n});
            try writeElement(a, out, c.atom.*);
        },
        .capture => |c| {
            try out.print(a, "{s}: ", .{c.name});
            try writeElement(a, out, c.body.*);
        },
        .splice => |k| try out.print(a, "({d})", .{k}),
    }
    if (e.as_number) try out.appendSlice(a, " as number");
    if (e.fold) try out.appendSlice(a, " ignoring case");
    if (e.lazily) try out.appendSlice(a, " lazily");
}

// ---------------------------------------------------------------- compiling

pub const Inst = union(enum) {
    /// A Character, or a byte; `folded` is its simple case folding under
    /// `fold`.
    char: struct { c: []const u8, folded: ?[]const u8 },
    class: Class,
    split: [2]u32,
    jump: u32,
    save: u32,
    assert: Anchor,
    match,
};

pub const Capture = struct { name: []const u8, number: bool };

pub const Program = struct {
    code: []Inst,
    captures: []Capture,
};

const Compiler = struct {
    a: Allocator,
    code: std.ArrayList(Inst) = .empty,
    captures: std.ArrayList(Capture) = .empty,

    fn here(c: *Compiler) u32 {
        return @intCast(c.code.items.len);
    }

    fn emit(c: *Compiler, i: Inst) !void {
        try c.code.append(c.a, i);
    }

    fn split(c: *Compiler, at: u32, prefer: u32, other: u32, lazily: bool) void {
        c.code.items[at] = .{ .split = if (lazily) .{ other, prefer } else .{ prefer, other } };
    }

    fn literal(c: *Compiler, text: []const u8, fold: bool) !void {
        var i: usize = 0;
        while (i < text.len) {
            const end = unicode.grapheme.end(text, i);
            const ch = text[i..end];
            try c.emit(.{ .char = .{ .c = ch, .folded = if (fold) try unicode.foldText(c.a, ch) else null } });
            i = end;
        }
    }

    /// One or more of a class: L: class, split L E.
    fn oneOrMore(c: *Compiler, k: Class, lazily: bool) !void {
        const l = c.here();
        try c.emit(.{ .class = k });
        try c.emit(.match);
        c.split(l + 1, l, l + 2, lazily);
    }

    fn word(c: *Compiler, lazily: bool) !void {
        try c.oneOrMore(.nonspace, lazily);
    }

    fn keyword(c: *Compiler, k: Keyword, lazily: bool) !void {
        switch (k) {
            .character => try c.emit(.{ .class = .any }),
            .digit => try c.emit(.{ .class = .digit }),
            .letter => try c.emit(.{ .class = .letter }),
            .uppercase_letter => try c.emit(.{ .class = .uppercase }),
            .lowercase_letter => try c.emit(.{ .class = .lowercase }),
            .punctuation => try c.emit(.{ .class = .punctuation }),
            .whitespace => try c.emit(.{ .class = .whitespace }),
            .space => try c.literal(" ", false),
            .characters, .digits, .letters, .uppercase_letters, .lowercase_letters, .spaces => {
                const l = c.here();
                try c.keyword(k.singular(), false);
                const at = c.here();
                try c.emit(.match);
                c.split(at, l, at + 1, lazily);
            },
            .word => try c.word(lazily),
            .words => {
                try c.word(lazily);
                try c.moreWords(lazily);
            },
            .text => {
                // L: split L+1 E, class any, jump L, E:
                const l = c.here();
                try c.emit(.match);
                try c.emit(.{ .class = .any });
                try c.emit(.{ .jump = l });
                c.split(l, l + 1, c.here(), lazily);
            },
        }
    }

    /// Zero or more of: one or more of `class whitespace`, then `word`.
    fn moreWords(c: *Compiler, lazily: bool) !void {
        const l = c.here();
        try c.emit(.match);
        try c.oneOrMore(.whitespace, lazily);
        try c.word(lazily);
        try c.emit(.{ .jump = l });
        c.split(l, l + 1, c.here(), lazily);
    }

    fn element(c: *Compiler, e: Element, outer_fold: bool) anyerror!void {
        const fold = outer_fold or e.fold;
        switch (e.node) {
            .literal => |t| try c.literal(t, fold),
            .keyword => |k| try c.keyword(k, e.lazily),
            .number => {
                // optional "-", digits, optional: ".", digits
                var l = c.here();
                try c.emit(.match);
                try c.literal("-", false);
                c.split(l, l + 1, c.here(), false);
                try c.oneOrMore(.digit, false);
                l = c.here();
                try c.emit(.match);
                try c.literal(".", false);
                try c.oneOrMore(.digit, false);
                c.split(l, l + 1, c.here(), false);
            },
            .anchor => |k| try c.emit(.{ .assert = k }),
            .group => |xs| for (xs) |x| try c.element(x, fold),
            .alternation => |xs| try c.alternation(xs, fold),
            .repetition => |r| {
                const l = c.here();
                switch (r.kind) {
                    .one_or_more => {
                        try c.element(r.atom.*, fold);
                        const at = c.here();
                        try c.emit(.match);
                        c.split(at, l, at + 1, e.lazily);
                    },
                    .zero_or_more => {
                        try c.emit(.match);
                        try c.element(r.atom.*, fold);
                        try c.emit(.{ .jump = l });
                        c.split(l, l + 1, c.here(), e.lazily);
                    },
                    .optional => {
                        try c.emit(.match);
                        try c.element(r.atom.*, fold);
                        c.split(l, l + 1, c.here(), e.lazily);
                    },
                }
            },
            .count => |n| {
                var atom = n.atom.*;
                atom.lazily = atom.lazily or e.lazily;
                if (atom.node == .keyword and atom.node.keyword == .words) {
                    if (n.n == 0) return;
                    try c.word(atom.lazily);
                    for (1..n.n) |_| {
                        try c.oneOrMore(.whitespace, atom.lazily);
                        try c.word(atom.lazily);
                    }
                    return;
                }
                if (atom.node == .keyword) atom.node.keyword = atom.node.keyword.singular();
                for (0..n.n) |_| try c.element(atom, fold);
            },
            .capture => |cap| {
                const i: u32 = @intCast(c.captures.items.len);
                const body = cap.body.*;
                const number = body.as_number or body.node == .number;
                try c.captures.append(c.a, .{ .name = cap.name, .number = number });
                try c.emit(.{ .save = 2 * i });
                var inner = body;
                inner.lazily = inner.lazily or e.lazily;
                try c.element(inner, fold);
                try c.emit(.{ .save = 2 * i + 1 });
            },
            .splice => return error.InvalidValue,
        }
    }

    /// `a or b or …`: L: split L+1 M, A, jump E, M: the rest, E:
    fn alternation(c: *Compiler, xs: []const Element, fold: bool) anyerror!void {
        if (xs.len == 1) return c.element(xs[0], fold);
        const l = c.here();
        try c.emit(.match);
        try c.element(xs[0], fold);
        const j = c.here();
        try c.emit(.match);
        const m = c.here();
        try c.alternation(xs[1..], fold);
        c.code.items[l] = .{ .split = .{ l + 1, m } };
        c.code.items[j] = .{ .jump = c.here() };
    }
};

/// Compiles a pattern's elements, with every text literal folded under a
/// use-site `ignoring case`.
pub fn compile(a: Allocator, elements: []const Element, fold: bool) !Program {
    var c: Compiler = .{ .a = a };
    for (elements) |e| try c.element(e, fold);
    try c.emit(.match);
    return .{ .code = c.code.items, .captures = c.captures.items };
}

/// The program of a text needle: a `char` per unit, then `match`.
pub fn literalProgram(a: Allocator, units: []const []const u8, fold: bool) !Program {
    const code = try a.alloc(Inst, units.len + 1);
    for (units, 0..) |u, i| code[i] = .{ .char = .{ .c = u, .folded = if (fold) try unicode.foldText(a, u) else null } };
    code[units.len] = .match;
    return .{ .code = code, .captures = &.{} };
}

/// A pattern value's program.
pub fn programOf(a: Allocator, v: *const Value, fold: bool) !Program {
    return compile(a, try read(a, v.data.pattern, false), fold);
}

/// The `program` measure: the size of a pattern value's program.
pub fn programSize(v: *const Value) u64 {
    var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena.deinit();
    const p = programOf(arena.allocator(), v, false) catch return 0;
    return p.code.len;
}

// ---------------------------------------------------------------- running

/// The subject a program runs over: its units, Characters of a text or
/// bytes of Bytes, and their byte offsets.
pub const Subject = struct {
    units: []const []const u8,
    /// The byte offset of each position, `units.len + 1` of them.
    offsets: []const usize,

    pub fn ofText(a: Allocator, text: []const u8) !Subject {
        var units: std.ArrayList([]const u8) = .empty;
        var offsets: std.ArrayList(usize) = .empty;
        var i: usize = 0;
        while (i < text.len) {
            const end = unicode.grapheme.end(text, i);
            try units.append(a, text[i..end]);
            try offsets.append(a, i);
            i = end;
        }
        try offsets.append(a, text.len);
        return .{ .units = units.items, .offsets = offsets.items };
    }

    pub fn ofBytes(a: Allocator, b: []const u8) !Subject {
        const units = try a.alloc([]const u8, b.len);
        const offsets = try a.alloc(usize, b.len + 1);
        for (units, 0..) |*u, i| u.* = b[i .. i + 1];
        for (offsets, 0..) |*o, i| o.* = i;
        return .{ .units = units, .offsets = offsets };
    }
};

pub const Kind = enum { whole, search, prefix, suffix };

pub const Found = struct { start: usize, end: usize, slots: []?usize };

const Thread = struct { pc: u32, start: usize, slots: []?usize };

const Run = struct {
    a: Allocator,
    program: Program,
    subject: Subject,

    fn lineBreak(u: []const u8) bool {
        return std.mem.eql(u8, u, "\n") or std.mem.eql(u8, u, "\r") or std.mem.eql(u8, u, "\r\n");
    }

    fn white(u: []const u8) bool {
        return unicode.properties.isWhiteSpace(unicode.utf8.decode(u, 0));
    }

    fn holds(r: *const Run, k: Anchor, p: usize) bool {
        const us = r.subject.units;
        return switch (k) {
            .text_start => p == 0,
            .text_end => p == us.len,
            .line_start => p == 0 or lineBreak(us[p - 1]),
            .line_end => p == us.len or lineBreak(us[p]),
            .word_break => blk: {
                const word_before = p > 0 and !white(us[p - 1]);
                const word_after = p < us.len and !white(us[p]);
                break :blk word_before != word_after;
            },
        };
    }

    fn satisfies(r: *const Run, i: Inst, u: []const u8) !bool {
        return switch (i) {
            .char => |c| if (c.folded) |f| std.mem.eql(u8, try unicode.foldText(r.a, u), f) else std.mem.eql(u8, u, c.c),
            .class => |k| blk: {
                const s = unicode.utf8.decode(u, 0);
                const cat = unicode.properties.category(s);
                break :blk switch (k) {
                    .any => true,
                    .digit => u.len == 1 and std.ascii.isDigit(u[0]),
                    .letter => if (cat) |g| switch (g) {
                        .Lu, .Ll, .Lt, .Lm, .Lo => true,
                        else => false,
                    } else false,
                    .uppercase => cat == .Lu,
                    .lowercase => cat == .Ll,
                    .punctuation => if (cat) |g| switch (g) {
                        .Pc, .Pd, .Pe, .Pf, .Pi, .Po, .Ps => true,
                        else => false,
                    } else false,
                    .whitespace => white(u),
                    .nonspace => !white(u),
                };
            },
            else => false,
        };
    }

    fn add(r: *const Run, list: *std.ArrayList(Thread), marks: []bool, pc: u32, p: usize, start: usize, slots: []?usize) !void {
        if (marks[pc]) return;
        marks[pc] = true;
        switch (r.program.code[pc]) {
            .jump => |to| try r.add(list, marks, to, p, start, slots),
            .split => |to| {
                try r.add(list, marks, to[0], p, start, slots);
                try r.add(list, marks, to[1], p, start, slots);
            },
            .save => |n| {
                const copy = try r.a.dupe(?usize, slots);
                copy[n] = p;
                try r.add(list, marks, pc + 1, p, start, copy);
            },
            .assert => |k| if (r.holds(k, p)) try r.add(list, marks, pc + 1, p, start, slots),
            .char, .class, .match => try list.append(r.a, .{ .pc = pc, .start = start, .slots = slots }),
        }
    }
};

/// Runs `program` over `subject` from position `from`, adding to `steps`.
/// With `first`, it stops at the first match recorded.
pub fn run(a: Allocator, program: Program, subject: Subject, from: usize, kind: Kind, first: bool, steps: *u64) !?Found {
    const r: Run = .{ .a = a, .program = program, .subject = subject };
    const n = subject.units.len;
    const size = program.code.len;
    var list: std.ArrayList(Thread) = .empty;
    var next: std.ArrayList(Thread) = .empty;
    var marks = try a.alloc(bool, size);
    var next_marks = try a.alloc(bool, size);
    @memset(marks, false);
    const empty = try a.alloc(?usize, 2 * program.captures.len);
    @memset(empty, null);
    var found: ?Found = null;
    var p = from;
    while (true) {
        const seeds = switch (kind) {
            .whole, .prefix => p == from,
            .search, .suffix => found == null,
        };
        if (seeds) try r.add(&list, marks, 0, p, p, empty);
        steps.* += list.items.len;
        next.clearRetainingCapacity();
        @memset(next_marks, false);
        for (list.items) |t| {
            const i = r.program.code[t.pc];
            if (i == .match) {
                if ((kind == .whole or kind == .suffix) and p != n) continue;
                found = .{ .start = t.start, .end = p, .slots = t.slots };
                if (first) return found;
                break;
            }
            if (p < n and try r.satisfies(i, subject.units[p])) try r.add(&next, next_marks, t.pc + 1, p + 1, t.start, t.slots);
        }
        if (p == n) break;
        std.mem.swap(std.ArrayList(Thread), &list, &next);
        std.mem.swap([]bool, &marks, &next_marks);
        p += 1;
        const seeds_next = (kind == .search or kind == .suffix) and found == null;
        if (list.items.len == 0 and !seeds_next) break;
    }
    return found;
}

/// The Match Search: searches one after another, each from where the last
/// match ended, skipping an empty match where the last one ended. With
/// `first`, only the first match.
pub fn matchSearch(a: Allocator, program: Program, subject: Subject, first: bool, steps: *u64) ![]Found {
    var out: std.ArrayList(Found) = .empty;
    var from: usize = 0;
    var last_end: ?usize = null;
    while (from <= subject.units.len) {
        const f = try run(a, program, subject, from, .search, false, steps) orelse break;
        if (f.start == f.end and last_end != null and f.start == last_end.?) {
            from = f.start + 1;
            continue;
        }
        try out.append(a, f);
        if (first) break;
        last_end = f.end;
        from = f.end;
    }
    return out.items;
}

// ---------------------------------------------------------------- results

/// What converting a Capture raises: the text that isn't a number.
pub const Unconverted = struct { text: []const u8 };

fn rangeValue(gpa: Allocator, start: usize, end: usize) !*Value {
    const from = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(@as(i64, @intCast(start + 1))) });
    defer from.release();
    const to = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(@as(i64, @intCast(end))) });
    defer to.release();
    return model.range(gpa, from, to);
}

fn textOf(subject: Subject, text: []const u8, start: usize, end: usize) []const u8 {
    return text[subject.offsets[start]..subject.offsets[end]];
}

/// A Capture's value: its text, or its number, or Nothing if it took no
/// part.
fn captureValue(gpa: Allocator, program: Program, subject: Subject, text: []const u8, f: Found, i: usize, bad: *?Unconverted) !*Value {
    const s = f.slots[2 * i] orelse return model.scalar(gpa, .nothing);
    const e = f.slots[2 * i + 1] orelse return model.scalar(gpa, .nothing);
    const t = textOf(subject, text, s, e);
    if (!program.captures[i].number) return model.text(gpa, t);
    const n = model.Decimal.parse(t) catch {
        bad.* = .{ .text = t };
        return error.Raised;
    };
    return model.scalar(gpa, .{ .number = n });
}

/// The Captures map of a match: each Capture's name and value.
pub fn capturesMap(a: Allocator, gpa: Allocator, program: Program, subject: Subject, text: []const u8, f: Found, bad: *?Unconverted) !*Value {
    const pairs = try a.alloc(model.Pair, program.captures.len);
    var made: usize = 0;
    defer for (pairs[0..made]) |p| p.value.release();
    for (program.captures, 0..) |c, i| {
        pairs[i] = .{ .key = c.name, .value = try captureValue(gpa, program, subject, text, f, i, bad) };
        made += 1;
    }
    return model.map(gpa, pairs);
}

/// A Match: `text`, `range`, `captures` and `ranges`.
pub fn matchMap(a: Allocator, gpa: Allocator, program: Program, subject: Subject, text: []const u8, f: Found, bad: *?Unconverted) !*Value {
    const matched = try model.text(gpa, textOf(subject, text, f.start, f.end));
    defer matched.release();
    const range = try rangeValue(gpa, f.start, f.end);
    defer range.release();
    const captures = try capturesMap(a, gpa, program, subject, text, f, bad);
    defer captures.release();
    const pairs = try a.alloc(model.Pair, program.captures.len);
    var made: usize = 0;
    defer for (pairs[0..made]) |p| p.value.release();
    for (program.captures, 0..) |c, i| {
        const s = f.slots[2 * i];
        const e = f.slots[2 * i + 1];
        pairs[i] = .{ .key = c.name, .value = if (s != null and e != null) try rangeValue(gpa, s.?, e.?) else try model.scalar(gpa, .nothing) };
        made += 1;
    }
    const ranges = try model.map(gpa, pairs);
    defer ranges.release();
    return model.map(gpa, &.{
        .{ .key = "text", .value = matched },
        .{ .key = "range", .value = range },
        .{ .key = "captures", .value = captures },
        .{ .key = "ranges", .value = ranges },
    });
}

const testing = std.testing;

fn measure(source: []const u8, text: []const u8, kind: Kind, first: bool) !struct { u64, ?Found } {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const program = try compile(a, try read(a, source, false), false);
    var n: u64 = 0;
    const f = try run(a, program, try Subject.ofText(a, text), 0, kind, first, &n);
    return .{ n, if (f) |x| .{ .start = x.start, .end = x.end, .slots = &.{} } else null };
}

test "chapter 8's example programs and steps" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try compile(a, try read(a, "<\"$\", digits>", false), false);
    try testing.expectEqual(@as(usize, 4), p.code.len);
    try testing.expectEqualDeep(Inst{ .split = .{ 1, 3 } }, p.code[2]);
    const lazy = try compile(a, try read(a, "<\"$\", digits lazily>", false), false);
    try testing.expectEqualDeep(Inst{ .split = .{ 3, 1 } }, lazy.code[2]);
    const greedy = try measure("<\"$\", digits>", "$895", .search, false);
    try testing.expectEqual(@as(u64, 10), greedy[0]);
    try testing.expectEqual(@as(usize, 4), greedy[1].?.end);
    const lazily = try measure("<\"$\", digits lazily>", "$895", .search, false);
    try testing.expectEqual(@as(u64, 6), lazily[0]);
    try testing.expectEqual(@as(usize, 2), lazily[1].?.end);
}

test "canonical sources survive reading and writing" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "<>", "<\"ID-\", 4 digits>", "< <4 digits>, \"x\">", "<last: word, \", \", first: word>", "<(quote & \"x\"), optional digit>", "<one or more of uppercase letters lazily>", "<n: digits as number, text end>" }) |s| {
        try testing.expectEqualStrings(s, try write(a, try read(a, s, false)));
    }
}

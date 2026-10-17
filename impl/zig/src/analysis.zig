//! Session language analysis (chapter 9, Language analysis): what a Session
//! Host asks of the Core's front end without loading anything. An Entry's
//! kind, completeness and leading documentation, a source's declarations,
//! the implicit Script Variables an Entry binds, and the catalogue that
//! `:describe`, `:apropos` and `:inspect` read. The Message Layer's
//! `analysis-v1` exchanges serve it to Hosts outside the Core.
const std = @import("std");
const Allocator = std.mem.Allocator;
const lexer = @import("syntax/lexer.zig");
const ast = @import("syntax/ast.zig");
const parser = @import("syntax/parser.zig");
const check = @import("check/check.zig");
const machine = @import("machine/machine.zig");

/// The normative `:inspect` reader (session-observation.md).
pub const inspect_reader = @embedFile("inspect-reader");

pub const builtins = @import("generated/stdlib.zig").stdlib.builtin;
pub const libraries = @import("generated/stdlib_sources.zig").sources;

pub const Kind = enum { empty, declaration, statement, expression };

/// How a leading `--|` block attaches: to the declaration straight after
/// it, to nothing yet, or there is none (a blank line detaches one).
pub const Doc = enum { none, pending, attached };

/// An Entry's first syntax error, positioned in the Entry's own text.
pub const Problem = struct {
    code: []const u8,
    line: usize,
    column: usize,
    /// More lines could complete the Entry at a Session prompt.
    incomplete: bool,
    /// A whole statement or expression was followed by more input.
    trailing: bool,
};

pub const Import = struct { name: []const u8, local: []const u8 };

/// A declaration as tooling shows it.
pub const Declared = struct {
    kind: []const u8,
    /// Its name; a Handler's Selector, or `any message`; a `use` line's
    /// Library.
    name: []const u8,
    /// A Handler's first Name, which starts a Command Call.
    word: ?[]const u8 = null,
    private: bool,
    /// Byte offsets of its first token and the end of its last, before the
    /// next declaration, and their lines.
    start: usize,
    end: usize,
    line: usize,
    end_line: usize,
    /// Its head, without a trailing comment or an initializer.
    signature: []const u8,
    /// The `--|` block straight before it.
    doc: []const u8,
    /// A function's required and total parameter counts.
    arity: ?[2]usize = null,
    /// A Script Variable's initializer text.
    initializer: ?[]const u8 = null,
    /// Byte offset just after `=`, for an in-process Host retaining the
    /// original whitespace and comments when it generates an assignment.
    initializer_start: ?usize = null,
    /// A `use` line's imports.
    imports: []const Import = &.{},
};

pub const Entry = struct {
    kind: Kind,
    doc: Doc,
    problem: ?Problem = null,
    /// A declaration Entry's declarations, in order.
    declarations: []const Declared = &.{},
    /// The names a statement or expression binds that become Script
    /// Variables, in the order first bound.
    implicit: []const []const u8 = &.{},
};

const statement_words = [_][]const u8{ "if", "repeat", "match", "try", "wait", "tell", "put", "let", "set", "add", "subtract", "multiply", "divide", "delete", "send", "ask", "return", "veto", "pass", "exit", "throw", "replace" };
const declaration_words = [_][]const u8{ "on", "function", "private", "use", "constant" };

const Words = struct { first: []const u8, second: []const u8 };

fn firstWords(line: []const u8) Words {
    var words = std.mem.tokenizeAny(u8, std.mem.trimStart(u8, line, " \t"), " \t(");
    return .{ .first = words.next() orelse "", .second = words.next() orelse "" };
}

fn isOneOf(w: []const u8, words: []const []const u8) bool {
    for (words) |x| if (std.mem.eql(u8, x, w)) return true;
    return false;
}

fn isDeclaration(w: Words) bool {
    return isOneOf(w.first, &declaration_words) or (std.mem.eql(u8, w.first, "script") and std.mem.eql(u8, w.second, "variable"));
}

/// Whether an Entry is a statement, by its first words, rather than an
/// expression (chapter 2, Entries). `handlers` are the first Names of the
/// Session Script's Handlers.
fn isStatement(w: Words, handlers: []const []const u8) bool {
    return isOneOf(w.first, &statement_words) or
        (std.mem.eql(u8, w.first, "with") and std.mem.eql(u8, w.second, "timeout")) or
        (std.mem.eql(u8, w.first, "choose") and std.mem.eql(u8, w.second, "offer")) or
        (std.mem.eql(u8, w.first, "next") and std.mem.eql(u8, w.second, "repeat")) or
        std.mem.eql(u8, w.first, "say") or isOneOf(w.first, handlers);
}

fn isDocLine(line: []const u8) bool {
    return std.mem.startsWith(u8, std.mem.trimStart(u8, line, " \t"), "--|");
}

fn isBlank(line: []const u8) bool {
    return std.mem.trim(u8, line, " \t\r").len == 0;
}

/// Classifies one Entry, without loading it. `handlers` are the first
/// Names of the Session Script's Handlers; `bound` are the names the
/// Script already has, which an Entry's implicit names exclude.
pub fn entry(arena: Allocator, text: []const u8, handlers: []const []const u8, bound: []const []const u8) Allocator.Error!Entry {
    const lines = try splitLines(arena, text);
    var i: usize = 0;
    while (i < lines.len and isBlank(lines[i])) i += 1;
    var doc: Doc = .none;
    if (i < lines.len and isDocLine(lines[i])) {
        while (i < lines.len and isDocLine(lines[i])) i += 1;
        doc = .attached;
        if (i < lines.len and isBlank(lines[i])) doc = .none;
        while (i < lines.len and isBlank(lines[i])) i += 1;
        if (i == lines.len) return .{ .kind = .empty, .doc = .pending };
    }
    if (i == lines.len) return .{ .kind = .empty, .doc = .none };
    const w = firstWords(lines[i]);
    if (isDeclaration(w)) {
        const tree = switch (try parser.parse(arena, text)) {
            .tree => |t| t,
            .failure => |d| return .{ .kind = .declaration, .doc = doc, .problem = try problem(arena, text, d, false) },
        };
        return .{ .kind = .declaration, .doc = doc, .declarations = try declarationsIn(arena, &tree) };
    }
    const expression = !isStatement(w, handlers);
    var result = try executable(arena, text, expression, bound);
    result.doc = doc;
    return result;
}

/// Reads executable input in the requested mode. `:inspect` always reads an
/// expression, while a Session's generated assignments are statements.
pub fn executable(arena: Allocator, text: []const u8, expression: bool, bound: []const []const u8) Allocator.Error!Entry {
    const kind: Kind = if (expression) .expression else .statement;
    const r = try parser.parseEntryEnd(arena, text, expression);
    if (r.failure) |d| return .{ .kind = kind, .doc = .none, .problem = try problem(arena, text, d, r.trailing) };
    return .{ .kind = kind, .doc = .none, .implicit = try implicitNames(arena, text, expression, bound) };
}

fn problem(arena: Allocator, text: []const u8, d: parser.Diagnostic, trailing: bool) Allocator.Error!Problem {
    var lines = try lexer.Lines.init(arena, text);
    const at = lines.position(d.offset);
    return .{ .code = d.code.spelling(), .line = at.line, .column = at.column, .incomplete = !ended(text, d, trailing), .trailing = trailing };
}

/// Whether a failed parse leaves nothing to wait for: it failed after the
/// Entry ended, or before the end of the source and not inside a fenced
/// literal or hole (chapter 12, Fenced text in sessions and tooling).
fn ended(text: []const u8, d: parser.Diagnostic, trailing: bool) bool {
    if (trailing) return true;
    switch (d.code) {
        .unterminated_interpolation => return false,
        .unterminated_text => return !(std.mem.startsWith(u8, text[d.offset..], "\"\"\"") or std.mem.startsWith(u8, text[d.offset..], "`")),
        else => {},
    }
    return d.offset < std.mem.trimEnd(u8, text, " \t\n").len;
}

/// The names a statement or expression binds as a Container's root or a
/// Capture, that `bound` doesn't have, as the Core will check its
/// extension.
pub fn implicitNames(arena: Allocator, text: []const u8, expression: bool, bound: []const []const u8) Allocator.Error![]const []const u8 {
    const name = "entry";
    var source: std.ArrayList(u8) = .empty;
    for (bound) |b| try source.print(arena, "script variable {s}\n", .{b});
    try source.print(arena, "on {s}\n{s}{s}\nend {s}\n", .{ name, if (expression) "return " else "", text, name });
    const tree = switch (try parser.parse(arena, source.items)) {
        .tree => |t| t,
        .failure => return &.{},
    };
    const result = try check.check(arena, &tree, .{ .collect_roots = true });
    for (result.bodies, 0..) |b, i| if (b.kind == .handler) {
        const d = tree.declarations[b.declaration orelse continue];
        if (d.data != .handler or !std.mem.eql(u8, tree.text(d.data.handler.name), name)) continue;
        const roots = result.roots.get(@intCast(i)) orelse return &.{};
        return roots.items;
    };
    return &.{};
}

/// Every declaration of a source, in order, or its first syntax error.
pub fn declarations(arena: Allocator, source: []const u8) Allocator.Error!union(enum) { declarations: []const Declared, problem: Problem } {
    return switch (try parser.parse(arena, source)) {
        .tree => |t| .{ .declarations = try declarationsIn(arena, &t) },
        .failure => |d| .{ .problem = try problem(arena, source, d, false) },
    };
}

fn declarationsIn(arena: Allocator, tree: *const ast.Tree) Allocator.Error![]const Declared {
    const source = tree.source;
    var lines = try lexer.Lines.init(arena, source);
    const all_lines = try splitLines(arena, source);
    var out: std.ArrayList(Declared) = .empty;
    for (tree.declarations, 0..) |d, k| {
        const first = firstToken(d);
        const start = tree.tokens[first].start;
        const limit = if (k + 1 < tree.declarations.len) tree.tokens[firstToken(tree.declarations[k + 1])].start else source.len;
        var end = tree.tokens[first].end;
        for (tree.tokens[first..]) |t| {
            if (t.start >= limit) break;
            if (t.kind != .newline and t.kind != .eof) end = @max(end, t.end);
        }
        const line = lines.position(start).line;
        const end_line = lines.position(end).line;
        const head_end = headEnd(tree, first);
        var x: Declared = .{ .kind = "", .name = "", .private = d.private != null, .start = start, .end = end, .line = line, .end_line = end_line, .signature = "", .doc = try docBefore(arena, all_lines, line - 1) };
        switch (d.data) {
            .handler => |h| {
                x.kind = "handler";
                x.name = if (h.fallback) "any message" else try selectorText(arena, tree, h);
                if (!h.fallback) x.word = tree.text(h.name);
                x.signature = source[tree.tokens[h.on].start..head_end];
            },
            .function => |f| {
                var required: usize = 0;
                for (f.params) |p| {
                    if (p.default == null) required += 1;
                }
                x.kind = "function";
                x.name = tree.text(f.name);
                x.signature = source[tree.tokens[f.keyword].start..head_end];
                x.arity = .{ required, f.params.len };
            },
            .constant => |c| {
                x.kind = "constant";
                x.name = tree.text(c.name);
                x.signature = try std.fmt.allocPrint(arena, "constant {s}", .{x.name});
            },
            .script_variable => |v| {
                x.kind = "variable";
                x.name = tree.text(v.name);
                x.signature = try std.fmt.allocPrint(arena, "script variable {s}", .{x.name});
                if (v.value != null) {
                    // The text after `=`.
                    var t = v.name + 1;
                    while (t < tree.tokens.len and tree.tokens[t].kind != .equal) t += 1;
                    if (t < tree.tokens.len) {
                        x.initializer_start = tree.tokens[t].end;
                        x.initializer = std.mem.trim(u8, source[tree.tokens[t].end..end], " \t");
                    }
                }
            },
            .use => |u| {
                x.kind = "use";
                x.name = tree.text(u.library);
                x.signature = source[start..head_end];
                var imports: std.ArrayList(Import) = .empty;
                for (u.names) |n| try imports.append(arena, .{ .name = tree.text(n), .local = if (u.rename) |r| tree.text(r) else tree.text(n) });
                x.imports = imports.items;
            },
        }
        try out.append(arena, x);
    }
    return out.items;
}

fn firstToken(d: ast.Declaration) usize {
    if (d.private) |p| return p;
    return switch (d.data) {
        .handler => |h| h.on,
        .function => |f| f.keyword,
        .constant => |k| k.keyword,
        .script_variable => |v| v.keyword,
        .use => |u| u.keyword,
    };
}

fn splitLines(arena: Allocator, source: []const u8) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, source, '\n');
    while (it.next()) |l| try out.append(arena, std.mem.trimEnd(u8, l, "\r"));
    return out.items;
}

/// The `--|` block straight before line `index` (0-based): each line
/// without its indentation, `--|` and one space, joined with LF.
fn docBefore(arena: Allocator, lines: []const []const u8, index: usize) Allocator.Error![]const u8 {
    var from = index;
    while (from > 0 and isDocLine(lines[from - 1])) from -= 1;
    var out: std.ArrayList(u8) = .empty;
    for (lines[from..index], 0..) |l, i| {
        if (i > 0) try out.append(arena, '\n');
        var t = std.mem.trimStart(u8, l, " \t")[3..];
        if (t.len > 0 and t[0] == ' ') t = t[1..];
        try out.appendSlice(arena, t);
    }
    return out.items;
}

/// Where a declaration's head ends: its last token before the first line
/// break after `first`.
fn headEnd(tree: *const ast.Tree, first: usize) usize {
    var t = first;
    while (t + 1 < tree.tokens.len and tree.tokens[t + 1].kind != .newline and tree.tokens[t + 1].kind != .eof) t += 1;
    return tree.tokens[t].end;
}

fn selectorText(arena: Allocator, tree: *const ast.Tree, h: ast.Handler) Allocator.Error![]const u8 {
    if (h.labels.len == 0) return tree.text(h.name);
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, tree.text(h.name));
    try out.append(arena, ':');
    for (h.labels) |l| try out.print(arena, "{s}:", .{tree.text(l)});
    return out.items;
}

/// Whether a `send` could compute this message name for `arity` arguments
/// (chapter 5, Sending; ADR 0057).
pub fn validMessageName(name: []const u8, arity: usize) bool {
    return machine.messageName(name, arity);
}

test "an Entry's kind, documentation and implicit names" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const put = try entry(a, "if true then\n  put 1 into total\n  put 2 into count\nend if", &.{}, &.{"count"});
    try std.testing.expectEqual(Kind.statement, put.kind);
    try std.testing.expectEqual(@as(usize, 1), put.implicit.len);
    try std.testing.expectEqualStrings("total", put.implicit[0]);
    try std.testing.expectEqual(Kind.statement, (try entry(a, "greet \"x\"", &.{"greet"}, &.{})).kind);
    try std.testing.expectEqual(Kind.expression, (try entry(a, "greet", &.{}, &.{})).kind);
    try std.testing.expectEqual(Doc.pending, (try entry(a, "--| Doubles.", &.{}, &.{})).doc);
    const documented = try entry(a, "--| Doubles.\nfunction double x\n  return x * 2\nend double", &.{}, &.{});
    try std.testing.expectEqual(Doc.attached, documented.doc);
    try std.testing.expectEqual(Kind.declaration, documented.kind);
    try std.testing.expectEqualStrings("Doubles.", documented.declarations[0].doc);
    try std.testing.expectEqualStrings("function double x", documented.declarations[0].signature);
    try std.testing.expectEqual(Doc.none, (try entry(a, "--| Detached.\n\n1 + 1", &.{}, &.{})).doc);
    const open = (try entry(a, "if true then\n  say 1", &.{}, &.{})).problem.?;
    try std.testing.expect(open.incomplete);
    const trailing = (try entry(a, "1 + 1 2", &.{}, &.{})).problem.?;
    try std.testing.expect(trailing.trailing and !trailing.incomplete);
}

test "a source's declarations" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try declarations(a, "use upper from text as up\n\non greet who to x\n  say who\nend greet\nscript variable n = 1 + 2\n");
    const ds = r.declarations;
    try std.testing.expectEqual(@as(usize, 3), ds.len);
    try std.testing.expectEqualStrings("text", ds[0].name);
    try std.testing.expectEqualStrings("up", ds[0].imports[0].local);
    try std.testing.expectEqualStrings("greet:to:", ds[1].name);
    try std.testing.expectEqualStrings("greet", ds[1].word.?);
    try std.testing.expectEqual(@as(usize, 3), ds[1].line);
    try std.testing.expectEqual(@as(usize, 5), ds[1].end_line);
    try std.testing.expectEqualStrings("1 + 2", ds[2].initializer.?);
    try std.testing.expect(validMessageName("greet:to:", 2));
    try std.testing.expect(!validMessageName("greet:to:", 1));
}

test "declaration metadata preserves source spans, defaults, imports and documentation" {
    const t = std.testing;
    var arena: std.heap.ArenaAllocator = .init(t.allocator);
    defer arena.deinit();
    const source =
        "--| Café.\n" ++
        "--| With a default.\n" ++
        "private function scale x, factor = 2\n return x * factor\nend scale\n" ++
        "\nconstant answer = 42\n" ++
        "script variable total =  1 + 2 -- keep the source\n" ++
        "use upper from text as up\n" ++
        "on any message m\n return nothing\nend any message\n";
    const result = try declarations(arena.allocator(), source);
    try t.expect(result == .declarations);
    const ds = result.declarations;
    try t.expectEqual(@as(usize, 5), ds.len);
    const f = ds[0];
    try t.expect(f.private);
    try t.expectEqualStrings("Café.\nWith a default.", f.doc);
    try t.expectEqual([2]usize{ 1, 2 }, f.arity.?);
    try t.expectEqualStrings("private function scale x, factor = 2\n return x * factor\nend scale", source[f.start..f.end]);
    try t.expectEqual(@as(usize, 3), f.line);
    try t.expectEqual(@as(usize, 5), f.end_line);
    try t.expectEqualStrings("constant", ds[1].kind);
    try t.expectEqualStrings("constant answer", ds[1].signature);
    try t.expectEqualStrings("", ds[1].doc);
    try t.expectEqualStrings("1 + 2", ds[2].initializer.?);
    try t.expect(std.mem.startsWith(u8, source[ds[2].initializer_start.?..], "  1 + 2 -- keep the source"));
    try t.expectEqualStrings("upper", ds[3].imports[0].name);
    try t.expectEqualStrings("up", ds[3].imports[0].local);
    try t.expectEqualStrings("any message", ds[4].name);
    try t.expect(ds[4].word == null);
}

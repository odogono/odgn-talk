//! The predictive parser of chapter 2. It reads at most two tokens ahead,
//! never backtracks, and names the lexer mode of every token it asks for.
//! The first syntax error stops the parse, with its code and position; no
//! recovery is attempted (ADR 0028).
const std = @import("std");
const Allocator = std.mem.Allocator;
const grammar = @import("../generated/grammar.zig").grammar;
const lexer = @import("lexer.zig");
const ast = @import("ast.zig");
const Token = lexer.Token;
const Mode = lexer.Mode;
const Kind = lexer.Kind;
const Tok = ast.Tok;
const Expr = ast.Expr;
const Pattern = ast.Pattern;
const Stmt = ast.Stmt;

/// How deep source may nest: recursive regions while parsing, and the depth
/// of an expression tree. An implementation limit, like the Go Core's, so
/// that hostile source ends in `source nesting too deep`, never a stack
/// overflow, natively or on `wasm32-wasi`.
pub const max_depth = 128;

pub const Diagnostic = lexer.Diagnostic;

pub const Result = union(enum) {
    tree: ast.Tree,
    failure: Diagnostic,
};

/// Parses a Script or Library. Everything is allocated in `arena`, which
/// owns the tree.
pub fn parse(arena: Allocator, source: []const u8) Allocator.Error!Result {
    const shared = try arena.create(lexer.Shared);
    shared.* = .{ .source = source, .arena = arena };
    var p: Parser = .{ .a = arena, .lex = .init(shared) };
    try p.brackets.ensureTotalCapacity(arena, 16);
    try p.nl_base.append(arena, 0);
    const declarations = p.sourceUnit() catch |e| switch (e) {
        error.Syntax => return .{ .failure = p.failure.? },
        error.OutOfMemory => return error.OutOfMemory,
    };
    return .{ .tree = .{
        .source = source,
        .tokens = p.tokens.items,
        .declarations = declarations,
        .shared = shared,
    } };
}

const Error = error{Syntax} || Allocator.Error;

fn wordSet(comptime lists: []const []const []const u8) type {
    return struct {
        fn has(word: []const u8) bool {
            inline for (lists) |list| {
                inline for (list) |w| if (std.mem.eql(u8, w, word)) return true;
            }
            return false;
        }
    };
}

const reserved = wordSet(&.{grammar.reserved});
const follow = wordSet(&.{grammar.follow});
const ordinals = wordSet(&.{grammar.ordinals});
const label_reserved = wordSet(&.{grammar.labels.reserved});
const label_excluded = wordSet(&.{grammar.labels.excluded});
const pattern_keywords = wordSet(&.{grammar.text_patterns.keywords});
const integer_types = wordSet(&.{grammar.binary_patterns.integer_types});
const size_units = wordSet(&.{grammar.binary_patterns.size_units});
const byte_orders = wordSet(&.{grammar.binary_patterns.byte_orders});

/// The first words of the Text Pattern classes: `lowercase`, `uppercase`.
const class_cases = blk: {
    @setEvalBranchQuota(10_000);
    var out: []const []const u8 = &.{};
    for (grammar.text_patterns.classes) |c| {
        const first = c[0..std.mem.indexOfScalar(u8, c, ' ').?];
        for (out) |o| {
            if (std.mem.eql(u8, o, first)) break;
        } else out = out ++ .{first};
    }
    break :blk out;
};

const properties = struct {
    fn has(word: []const u8) bool {
        inline for (grammar.properties) |p| {
            if (comptime std.mem.indexOfScalar(u8, p, ' ') == null) {
                if (std.mem.eql(u8, p, word)) return true;
            }
        }
        return false;
    }
};

/// A chunk kind, from its singular or plural; `code` stands for `code point`.
fn chunkKind(word: []const u8, plural: ?*bool) ?ast.ChunkKind {
    inline for (grammar.chunk) |c| {
        const kind: ast.ChunkKind = comptime blk: {
            var name: [c.singular.len]u8 = undefined;
            for (c.singular, 0..) |ch, i| name[i] = if (ch == ' ') '_' else ch;
            const final = name;
            break :blk std.meta.stringToEnum(ast.ChunkKind, &final).?;
        };
        if (comptime std.mem.indexOfScalar(u8, c.singular, ' ') == null) {
            if (std.mem.eql(u8, word, c.singular)) {
                if (plural) |pl| pl.* = false;
                return kind;
            }
            if (std.mem.eql(u8, word, c.plural)) {
                if (plural) |pl| pl.* = true;
                return kind;
            }
        }
    }
    return null;
}

fn isSingular(word: []const u8) bool {
    var plural = false;
    return chunkKind(word, &plural) != null and !plural;
}

const continuing_words = [_][]const u8{ "and", "or", "is", "mod", "div", "contains", "matches", "with", "be", "contain", "match", "than", "least", "most" };
const block_keywords = [_][]const u8{ "if", "repeat", "match", "try", "wait", "tell", "timeout" };
const operand_words = [_][]const u8{ "the", "not", "true", "false", "nothing", "it", "me", "given", "replace" };

fn among(word: []const u8, comptime list: []const []const u8) bool {
    inline for (list) |w| if (std.mem.eql(u8, w, word)) return true;
    return false;
}

const Buffered = struct { tok: Token, mode: Mode, start: usize };

const Parser = struct {
    a: Allocator,
    lex: lexer.Lexer,
    tokens: std.ArrayList(Token) = .empty,
    /// The source offset after the last consumed token.
    offset: usize = 0,
    prev: ?struct { tok: Token, mode: Mode } = null,
    buf: [2]Buffered = undefined,
    buffered: usize = 0,
    /// The open brackets, innermost last.
    brackets: std.ArrayList(Kind) = .empty,
    /// A line break is skipped only while more brackets are open than the
    /// top of this stack. A Lambda head and a block Lambda body push theirs.
    nl_base: std.ArrayList(usize) = .empty,
    /// Inside a `<< … >>` build value, where `as uint16` is a field type.
    build: usize = 0,
    /// Inside a parenthesised Binary Pattern size, where `^n` is allowed.
    size: usize = 0,
    /// The offset of a Whose Clause condition's first token.
    whose_key_at: ?usize = null,
    depth: usize = 0,
    failure: ?Diagnostic = null,

    // ------------------------------------------------------------ tokens

    fn opens(t: Token) bool {
        return switch (t.kind) {
            .pattern_open, .binary_open, .left_paren, .left_bracket, .left_brace => true,
            else => false,
        };
    }

    fn closes(t: Token, top: ?Kind) bool {
        const want: Kind = switch (t.kind) {
            .pattern_close => .pattern_open,
            .right_paren => .left_paren,
            .right_bracket => .left_bracket,
            .right_brace => .left_brace,
            .binary_close => .binary_open,
            else => return false,
        };
        return top == want;
    }

    fn innermost(p: *Parser) ?Kind {
        return if (p.brackets.items.len == 0) null else p.brackets.items[p.brackets.items.len - 1];
    }

    fn word(p: *Parser, t: Token) []const u8 {
        return t.text(p.lex.shared.source);
    }

    /// Whether a line goes on past a line break after `t`: after a comma,
    /// or a binary operator lexed in operator position (chapter 1, Lines).
    fn continues(p: *Parser, t: Token, mode: Mode) bool {
        if (t.kind == .comma) return true;
        if (mode != .operator and mode != .unit) return false;
        return switch (t.kind) {
            .word => among(p.word(t), &continuing_words),
            .possessive, .right_paren, .right_bracket, .right_brace, .binary_close, .colon => false,
            .ellipsis, .dot_dot, .ampersand, .equal, .not_equal, .less_equal, .greater_equal, .shift, .less, .greater, .plus, .minus, .star, .slash, .caret => true,
            else => false,
        };
    }

    fn lexAt(p: *Parser, start: usize, mode: Mode, before: ?Token, before_mode: Mode, depth: usize) Allocator.Error!Buffered {
        var at = start;
        while (true) {
            const t = try p.lex.next(at, mode);
            const base = p.nl_base.items[p.nl_base.items.len - 1];
            if (t.kind == .newline and (depth > base or (before != null and p.continues(before.?, before_mode)))) {
                at = t.end;
                continue;
            }
            return .{ .tok = t, .mode = mode, .start = start };
        }
    }

    fn depthAt(p: *Parser, k: usize) usize {
        var d = p.brackets.items.len;
        if (k == 1) {
            const t0 = p.buf[0].tok;
            if (opens(t0)) d += 1 else if (closes(t0, p.innermost())) d -= 1;
        }
        return d;
    }

    fn fill(p: *Parser, k: usize, mode: Mode) Allocator.Error!void {
        const start = if (k == 0) p.offset else p.buf[0].tok.end;
        const before: ?Token = if (k == 0) (if (p.prev) |v| v.tok else null) else p.buf[0].tok;
        const before_mode: Mode = if (k == 0) (if (p.prev) |v| v.mode else .operand) else p.buf[0].mode;
        p.buf[k] = try p.lexAt(start, mode, before, before_mode, p.depthAt(k));
    }

    fn peekAt(p: *Parser, k: usize, mode: Mode) Allocator.Error!Token {
        while (p.buffered <= k) {
            try p.fill(p.buffered, mode);
            p.buffered += 1;
        }
        const b = p.buf[k];
        if (b.mode != mode and b.tok.kind != .newline and b.tok.kind != .eof) {
            // Asked again in another mode: lex afresh, and forget what
            // followed it.
            const before: ?Token = if (k == 0) (if (p.prev) |v| v.tok else null) else p.buf[0].tok;
            const before_mode: Mode = if (k == 0) (if (p.prev) |v| v.mode else .operand) else p.buf[0].mode;
            p.buf[k] = try p.lexAt(b.start, mode, before, before_mode, p.depthAt(k));
            p.buffered = k + 1;
        }
        return p.buf[k].tok;
    }

    fn peek(p: *Parser, mode: Mode) Allocator.Error!Token {
        return p.peekAt(0, mode);
    }

    /// The second token, for one of grammar.toml's two-token decisions.
    fn peek2(p: *Parser, comptime decision: []const u8, mode: Mode) Allocator.Error!Token {
        comptime {
            for (grammar.decision) |d| {
                if (std.mem.eql(u8, d.name, decision)) break;
            } else @compileError("not a decision in grammar.toml: " ++ decision);
        }
        return p.peekAt(1, mode);
    }

    fn push(p: *Parser, t: Token) Allocator.Error!Tok {
        try p.tokens.append(p.a, t);
        return @intCast(p.tokens.items.len - 1);
    }

    /// Consumes the next token, recording the line breaks skipped before it.
    fn next(p: *Parser, mode: Mode) Error!Tok {
        const t = try p.peek(mode);
        if (t.kind == .invalid) return p.failAt(t);
        while (p.offset < t.start) {
            const nl = try p.lex.next(p.offset, .operator);
            if (nl.kind != .newline or nl.start >= t.start) break;
            _ = try p.push(nl);
            p.offset = nl.end;
        }
        p.buf[0] = p.buf[1];
        p.buffered -|= 1;
        p.offset = t.end;
        p.prev = .{ .tok = t, .mode = mode };
        if (opens(t)) {
            try p.brackets.append(p.a, t.kind);
        } else if (closes(t, p.innermost())) {
            _ = p.brackets.pop();
        }
        return p.push(t);
    }

    fn failCode(p: *Parser, code: lexer.Code, offset: usize) error{Syntax} {
        if (p.failure == null) p.failure = .{ .code = code, .offset = offset };
        return error.Syntax;
    }

    fn failAt(p: *Parser, t: Token) error{Syntax} {
        if (t.kind == .invalid) return p.failCode(t.code, t.offset);
        return p.failCode(.unexpected_token, t.start);
    }

    fn fail(p: *Parser, mode: Mode) Error {
        return p.failAt(try p.peek(mode));
    }

    fn enter(p: *Parser, at: usize) error{Syntax}!void {
        p.depth += 1;
        if (p.depth > max_depth) return p.failCode(.source_nesting_too_deep, at);
    }

    fn leave(p: *Parser) void {
        p.depth -= 1;
    }

    fn isWord(p: *Parser, t: Token, w: []const u8) bool {
        return t.kind == .word and std.mem.eql(u8, p.word(t), w);
    }

    fn isName(p: *Parser, t: Token) bool {
        if (t.kind != .word) return false;
        const w = p.word(t);
        return !reserved.has(w) and !std.mem.eql(u8, w, "_");
    }

    fn isLabel(p: *Parser, t: Token) bool {
        if (t.kind != .word) return false;
        const w = p.word(t);
        return (p.isName(t) or label_reserved.has(w)) and !label_excluded.has(w);
    }

    fn atWord(p: *Parser, w: []const u8, mode: Mode) Allocator.Error!bool {
        return p.isWord(try p.peek(mode), w);
    }

    fn atKind(p: *Parser, k: Kind, mode: Mode) Allocator.Error!bool {
        return (try p.peek(mode)).kind == k;
    }

    fn atEnd(p: *Parser, mode: Mode) Allocator.Error!bool {
        const t = try p.peek(mode);
        return t.kind == .newline or t.kind == .eof;
    }

    fn expectWord(p: *Parser, w: []const u8, mode: Mode) Error!Tok {
        if (!try p.atWord(w, mode)) return p.fail(mode);
        return p.next(mode);
    }

    fn expect(p: *Parser, k: Kind, mode: Mode) Error!Tok {
        if (!try p.atKind(k, mode)) return p.fail(mode);
        return p.next(mode);
    }

    fn name(p: *Parser, mode: Mode) Error!Tok {
        if (!p.isName(try p.peek(mode))) return p.fail(mode);
        return p.next(mode);
    }

    /// A Handler, message or event name: any Name but `all`.
    fn messageName(p: *Parser) Error!Tok {
        if (try p.atWord("all", .operand)) return p.fail(.operand);
        return p.name(.operand);
    }

    fn endOfStatement(p: *Parser) Error!void {
        const t = try p.peek(.operator);
        if (t.kind == .eof) return;
        if (t.kind != .newline) return p.failAt(t);
        _ = try p.next(.operator);
    }

    fn skipNewlines(p: *Parser) Error!void {
        while ((try p.peek(.operand)).kind == .newline) _ = try p.next(.operand);
    }

    /// A bare `end`, or `end` and the Name or keyword of its block.
    fn endSuffix(p: *Parser, suffix: []const u8) Error!void {
        const t = try p.peek(.operand);
        if (t.kind == .newline or t.kind == .eof) return;
        if (!p.isWord(t, suffix)) return p.failAt(t);
        _ = try p.next(.operand);
    }

    fn startsExpr(p: *Parser, t: Token) bool {
        return switch (t.kind) {
            .number, .text, .template, .pattern_open, .binary_open, .left_paren, .left_bracket, .left_brace, .minus => true,
            .word => p.isName(t) or among(p.word(t), &operand_words),
            else => false,
        };
    }

    fn list(p: *Parser, comptime T: type, items: *std.ArrayList(T)) Allocator.Error![]const T {
        return items.toOwnedSlice(p.a);
    }

    fn create(p: *Parser, comptime T: type, value: T) Allocator.Error!*T {
        const ptr = try p.a.create(T);
        ptr.* = value;
        return ptr;
    }

    /// A new expression, refused when its tree grows too deep.
    fn mk(p: *Parser, pos: Tok, data: Expr.Data, kids: []const ?*const Expr) Error!*Expr {
        var depth: u16 = 0;
        for (kids) |k| {
            if (k) |e| depth = @max(depth, e.depth);
        }
        depth += 1;
        if (depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[pos].start);
        return p.create(Expr, .{ .pos = pos, .depth = depth, .data = data });
    }

    // ------------------------------------------------------------ top level

    fn sourceUnit(p: *Parser) Error![]const ast.Declaration {
        var out: std.ArrayList(ast.Declaration) = .empty;
        try p.skipNewlines();
        while ((try p.peek(.operand)).kind != .eof) {
            try out.append(p.a, try p.declaration());
            try p.skipNewlines();
        }
        _ = try p.next(.operand);
        return p.list(ast.Declaration, &out);
    }

    fn declaration(p: *Parser) Error!ast.Declaration {
        var private: ?Tok = null;
        if (try p.atWord("private", .operand)) {
            private = try p.next(.operand);
            const u = try p.peek(.operand);
            if (!(p.isWord(u, "on") or p.isWord(u, "function") or p.isWord(u, "constant"))) return p.failAt(u);
        }
        const t = try p.peek(.operand);
        if (p.isWord(t, "on")) return .{ .private = private, .data = .{ .handler = try p.handler() } };
        if (p.isWord(t, "function")) return .{ .private = private, .data = .{ .function = try p.function() } };
        if (p.isWord(t, "use")) return .{ .private = null, .data = .{ .use = try p.use() } };
        if (p.isWord(t, "constant")) {
            const keyword = try p.next(.operand);
            const n = try p.name(.operand);
            _ = try p.expect(.equal, .operator);
            const value = try p.expr();
            try p.endOfStatement();
            return .{ .private = private, .data = .{ .constant = .{ .keyword = keyword, .name = n, .value = value } } };
        }
        if (p.isWord(t, "script") and p.isWord(try p.peek2("script-variable", .operand), "variable")) {
            const keyword = try p.next(.operand);
            _ = try p.next(.operand);
            const n = try p.name(.operand);
            var value: ?*Expr = null;
            if (try p.atKind(.equal, .operator)) {
                _ = try p.next(.operator);
                value = try p.expr();
            }
            try p.endOfStatement();
            return .{ .private = null, .data = .{ .script_variable = .{ .keyword = keyword, .name = n, .value = value } } };
        }
        return p.failAt(t);
    }

    fn use(p: *Parser) Error!ast.Use {
        const keyword = try p.next(.operand);
        var names: std.ArrayList(Tok) = .empty;
        try names.append(p.a, try p.name(.operand));
        while (try p.atKind(.comma, .operator)) {
            _ = try p.next(.operator);
            try names.append(p.a, try p.name(.operand));
        }
        _ = try p.expectWord("from", .operator);
        const library = try p.name(.operand);
        var rename: ?Tok = null;
        // `as` renames a single imported name only.
        if (names.items.len == 1 and try p.atWord("as", .operator)) {
            _ = try p.next(.operator);
            rename = try p.name(.operand);
        }
        try p.endOfStatement();
        return .{ .keyword = keyword, .names = try p.list(Tok, &names), .library = library, .rename = rename };
    }

    fn atAnyMessage(p: *Parser) Allocator.Error!bool {
        return try p.atWord("any", .operand) and p.isWord(try p.peek2("any-message", .operand), "message");
    }

    fn handler(p: *Parser) Error!ast.Handler {
        const on = try p.next(.operand);
        const fallback = try p.atAnyMessage();
        var handler_name: Tok = undefined;
        if (fallback) {
            handler_name = try p.next(.operand);
            _ = try p.next(.operand);
        } else handler_name = try p.messageName();
        var params: std.ArrayList(*Pattern) = .empty;
        var labels: std.ArrayList(Tok) = .empty;
        var suffixes: std.ArrayList(Tok) = .empty;
        var guard: ?ast.Guard = null;
        var during: ?Tok = null;
        const t = try p.peek(.operand);
        if (fallback) {
            try params.append(p.a, try p.pattern());
        } else if (!(t.kind == .newline or t.kind == .eof or p.isWord(t, "where") or t.kind == .comma)) {
            try params.append(p.a, try p.pattern());
            while (p.isLabel(try p.peek(.operator))) {
                try labels.append(p.a, try p.next(.operand));
                try params.append(p.a, try p.pattern());
            }
        }
        // Parameters, then a Guard, then suffixes. After a comma, a suffix
        // word is always a suffix.
        var in_params = params.items.len > 0 and !fallback;
        var can_guard = true;
        while (true) {
            const c = try p.peek(.operator);
            if (in_params and p.isLabel(c)) return p.failAt(c);
            if (can_guard and p.isWord(c, "where")) {
                guard = try p.guardClause();
                in_params = false;
                can_guard = false;
                continue;
            }
            if (c.kind != .comma) break;
            _ = try p.next(.operator);
            const w = try p.peek(.operand);
            if (w.kind == .word and among(p.word(w), &.{ "queued", "dropping", "replacing", "deciding" })) {
                try suffixes.append(p.a, try p.next(.operand));
                in_params = false;
                can_guard = false;
            } else if (p.isWord(w, "during") and p.isName(try p.peek2("during", .operand))) {
                try suffixes.append(p.a, try p.next(.operand));
                during = try p.next(.operand);
                in_params = false;
                can_guard = false;
            } else if (fallback and guard == null and suffixes.items.len == 0) {
                return p.failAt(w);
            } else if (in_params and labels.items.len > 0) {
                return p.failAt(w);
            } else if (in_params) {
                try params.append(p.a, try p.pattern());
            } else return p.failAt(w);
        }
        try p.endOfStatement();
        const body = try p.block(&.{ "end", "finally" });
        var fin: ?ast.Finally = null;
        if (try p.atWord("finally", .operand)) {
            const keyword = try p.next(.operand);
            try p.endOfStatement();
            fin = .{ .keyword = keyword, .body = try p.block(&.{"end"}) };
        }
        const end = try p.expectWord("end", .operand);
        if (!fallback) {
            try p.endSuffix(p.word(p.tokens.items[handler_name]));
        } else if (try p.atAnyMessage()) {
            _ = try p.next(.operand);
            _ = try p.next(.operand);
        } else if (!try p.atEnd(.operand)) return p.fail(.operand);
        try p.endOfStatement();
        return .{
            .on = on,
            .fallback = fallback,
            .name = handler_name,
            .labels = try p.list(Tok, &labels),
            .params = try p.list(*Pattern, &params),
            .guard = guard,
            .suffixes = try p.list(Tok, &suffixes),
            .during = during,
            .body = body,
            .finally = fin,
            .end = end,
        };
    }

    fn guardClause(p: *Parser) Error!ast.Guard {
        const where = try p.next(.operator);
        return .{ .where = where, .condition = try p.expr() };
    }

    fn function(p: *Parser) Error!ast.Function {
        const keyword = try p.next(.operand);
        const n = try p.name(.operand);
        var params: std.ArrayList(ast.Parameter) = .empty;
        if (!try p.atEnd(.operand)) {
            while (true) {
                const param = try p.name(.operand);
                var default: ?*Expr = null;
                if (try p.atKind(.equal, .operator)) {
                    _ = try p.next(.operator);
                    default = try p.expr();
                }
                try params.append(p.a, .{ .name = param, .default = default });
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        try p.endOfStatement();
        const body = try p.block(&.{"end"});
        const end = try p.expectWord("end", .operand);
        try p.endSuffix(p.word(p.tokens.items[n]));
        try p.endOfStatement();
        return .{ .keyword = keyword, .name = n, .params = try p.list(ast.Parameter, &params), .body = body, .end = end };
    }

    // ------------------------------------------------------------ statements

    fn block(p: *Parser, terms: []const []const u8) Error!ast.Block {
        const first = try p.peek(.operand);
        try p.enter(first.start);
        defer p.leave();
        var out: std.ArrayList(*Stmt) = .empty;
        while (true) {
            try p.skipNewlines();
            const t = try p.peek(.operand);
            if (t.kind == .eof) return p.failAt(t);
            if (t.kind == .word) {
                for (terms) |term| if (std.mem.eql(u8, p.word(t), term)) return p.list(*Stmt, &out);
            }
            try out.append(p.a, try p.statement());
            try p.endOfStatement();
        }
    }

    /// A branch body: a line break and a block, or one statement on the line.
    fn branchBody(p: *Parser, terms: []const []const u8) Error!ast.Block {
        if (try p.atEnd(.operator)) {
            try p.endOfStatement();
            return p.block(terms);
        }
        const s = try p.simpleStatement();
        try p.endOfStatement();
        const out = try p.a.alloc(*Stmt, 1);
        out[0] = s;
        return out;
    }

    fn stmt(p: *Parser, first: Tok, data: Stmt.Data) Allocator.Error!*Stmt {
        return p.create(Stmt, .{ .first = first, .data = data });
    }

    fn statement(p: *Parser) Error!*Stmt {
        const t = try p.peek(.operand);
        if (p.isWord(t, "if")) return p.ifStatement();
        if (p.isWord(t, "repeat")) return p.repeat();
        if (p.isWord(t, "match")) return p.match();
        if (p.isWord(t, "try")) return p.tryStatement();
        if (p.isWord(t, "wait")) return p.wait(true);
        if (p.isWord(t, "tell")) return p.tell();
        if (p.isWord(t, "with") and p.isWord(try p.peek2("with-timeout", .operand), "timeout")) return p.timeoutBlock();
        return p.simpleStatement();
    }

    fn simpleStatement(p: *Parser) Error!*Stmt {
        const t = try p.peek(.operand);
        if (t.kind != .word) return p.failAt(t);
        const w = p.word(t);
        if (std.mem.eql(u8, w, "put")) {
            const first = try p.next(.operand);
            var spread = false;
            if (try p.atKind(.ellipsis, .operand)) {
                _ = try p.next(.operand);
                spread = true;
            }
            const value = try p.expr();
            const prep = try p.peek(.operator);
            const place: @FieldType(ast.Put, "place") = if (!spread and p.isWord(prep, "into")) .into else if (p.isWord(prep, "after")) .after else if (p.isWord(prep, "before")) .before else return p.failAt(prep);
            const place_token = try p.next(.operator);
            return p.stmt(first, .{ .put = .{ .spread = spread, .value = value, .place = place, .place_token = place_token, .target = try p.container() } });
        }
        if (std.mem.eql(u8, w, "let")) {
            const first = try p.next(.operand);
            const pat = try p.pattern();
            _ = try p.expectWord("be", .operator);
            return p.stmt(first, .{ .let = .{ .pattern = pat, .value = try p.expr() } });
        }
        if (std.mem.eql(u8, w, "set")) {
            const first = try p.next(.operand);
            const target = try p.container();
            _ = try p.expectWord("to", .operator);
            return p.stmt(first, .{ .set = .{ .target = target, .value = try p.expr() } });
        }
        if (std.mem.eql(u8, w, "add") or std.mem.eql(u8, w, "subtract")) {
            const first = try p.next(.operand);
            const value = try p.expr();
            const add = std.mem.eql(u8, w, "add");
            _ = try p.expectWord(if (add) "to" else "from", .operator);
            return p.stmt(first, .{ .arithmetic = .{ .op = if (add) .add else .subtract, .value = value, .target = try p.container() } });
        }
        if (std.mem.eql(u8, w, "multiply") or std.mem.eql(u8, w, "divide")) {
            const first = try p.next(.operand);
            const target = try p.container();
            _ = try p.expectWord("by", .operator);
            return p.stmt(first, .{ .arithmetic = .{ .op = if (std.mem.eql(u8, w, "multiply")) .multiply else .divide, .target = target, .value = try p.expr() } });
        }
        if (std.mem.eql(u8, w, "delete")) {
            const first = try p.next(.operand);
            return p.stmt(first, .{ .delete = try p.container() });
        }
        if (std.mem.eql(u8, w, "send")) return p.send();
        if (std.mem.eql(u8, w, "ask") or std.mem.eql(u8, w, "tell")) {
            const first = try p.next(.operand);
            const target = try p.expr();
            _ = try p.expectWord("to", .operator);
            const ask = std.mem.eql(u8, w, "ask");
            var op = try p.operation(ask);
            op.target = target;
            return p.stmt(first, if (ask) .{ .ask = op } else .{ .tell = op });
        }
        if (std.mem.eql(u8, w, "wait")) return p.wait(false);
        if (std.mem.eql(u8, w, "return") or std.mem.eql(u8, w, "veto")) {
            const first = try p.next(.operand);
            const value: ?*Expr = if (p.startsExpr(try p.peek(.operand))) try p.expr() else null;
            return p.stmt(first, if (std.mem.eql(u8, w, "return")) .{ .@"return" = value } else .{ .veto = value });
        }
        if (std.mem.eql(u8, w, "pass")) {
            const first = try p.next(.operand);
            if (try p.atAnyMessage()) {
                const any = try p.next(.operand);
                _ = try p.next(.operand);
                return p.stmt(first, .{ .pass = .{ .any = true, .name = any, .labels = &.{} } });
            }
            const n = try p.messageName();
            var labels: std.ArrayList(Tok) = .empty;
            while (p.isLabel(try p.peek(.operator))) try labels.append(p.a, try p.next(.operand));
            return p.stmt(first, .{ .pass = .{ .any = false, .name = n, .labels = try p.list(Tok, &labels) } });
        }
        if (std.mem.eql(u8, w, "exit")) {
            const first = try p.next(.operand);
            _ = try p.expectWord("repeat", .operand);
            return p.stmt(first, .exit_repeat);
        }
        if (std.mem.eql(u8, w, "throw")) {
            const first = try p.next(.operand);
            return p.stmt(first, .{ .throw = try p.expr() });
        }
        if (std.mem.eql(u8, w, "replace")) {
            const r = try p.replace(true);
            return p.stmt(r.keyword, .{ .replace = r });
        }
        if (std.mem.eql(u8, w, "choose") and p.isWord(try p.peek2("choose-offer", .operand), "offer")) return p.chooseOffer();
        if (std.mem.eql(u8, w, "next") and p.isWord(try p.peek2("next-repeat", .operand), "repeat")) {
            const first = try p.next(.operand);
            _ = try p.next(.operand);
            return p.stmt(first, .next_repeat);
        }
        if (reserved.has(w) or std.mem.eql(u8, w, "_")) return p.failAt(t);
        // A Command Call, or a call statement `f(x)`.
        const n = try p.next(.operand);
        const open = try p.peek(.operand);
        if (open.kind == .left_paren and !open.space_before) {
            const c = try p.call(n);
            return p.stmt(n, .{ .call = .{ .call = c, .wait = try p.andWait() } });
        }
        var command = try p.commandPhrase(n);
        command.wait = try p.andWait();
        return p.stmt(n, .{ .command = command });
    }

    fn commandPhrase(p: *Parser, n: Tok) Error!ast.Command {
        var args: std.ArrayList(*Expr) = .empty;
        var labels: std.ArrayList(Tok) = .empty;
        if (p.startsExpr(try p.peek(.operand))) {
            try args.append(p.a, try p.expr());
            if (try p.atKind(.comma, .operator)) {
                while (try p.atKind(.comma, .operator)) {
                    _ = try p.next(.operator);
                    try args.append(p.a, try p.expr());
                }
            } else {
                while (p.isLabel(try p.peek(.operator))) {
                    try labels.append(p.a, try p.next(.operand));
                    try args.append(p.a, try p.expr());
                }
            }
        }
        return .{ .name = n, .labels = try p.list(Tok, &labels), .args = try p.list(*Expr, &args), .wait = null };
    }

    fn exprList(p: *Parser) Error![]const *Expr {
        var out: std.ArrayList(*Expr) = .empty;
        try out.append(p.a, try p.expr());
        while (try p.atKind(.comma, .operator)) {
            _ = try p.next(.operator);
            try out.append(p.a, try p.expr());
        }
        return p.list(*Expr, &out);
    }

    /// A Container: a Name, or a Chunk Expression or key path rooted in one.
    /// Parentheses keep the path; a Built-in property anywhere on it is
    /// `not a container` (ADR 0079).
    fn container(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        if (!p.startsExpr(t)) return p.failAt(t);
        const e = try p.chunkLevel();
        var root = e;
        while (true) {
            root = switch (root.data) {
                .name => break,
                .chunk => |c| c.of,
                .key => |k| k.base,
                .group => |g| g,
                else => return p.failCode(.not_a_container, t.start),
            };
        }
        return e;
    }

    fn andWait(p: *Parser) Error!?Tok {
        if (try p.atWord("and", .operator) and p.isWord(try p.peek2("and-wait", .operand), "wait")) {
            const and_token = try p.next(.operator);
            _ = try p.next(.operand);
            return and_token;
        }
        return null;
    }

    fn send(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        // `send to <target>: <command phrase>`.
        if (try p.atWord("to", .operand)) {
            _ = try p.next(.operand);
            const target = try p.expr();
            _ = try p.expect(.colon, .operator);
            const phrase = try p.commandPhrase(try p.messageName());
            const args = try p.a.alloc(ast.ListItem, phrase.args.len);
            for (phrase.args, args) |arg, *item| item.* = .{ .spread = null, .value = arg };
            return p.stmt(first, .{ .send = .{ .name = phrase.name, .computed = null, .labels = phrase.labels, .args = args, .target = target, .target_first = true, .wait = try p.andWait() } });
        }
        var n: ?Tok = null;
        var computed: ?*Expr = null;
        if (try p.atKind(.left_paren, .operand)) {
            _ = try p.next(.operand);
            computed = try p.nested(expr);
            _ = try p.expect(.right_paren, .operator);
        } else n = try p.messageName();
        var args: std.ArrayList(ast.ListItem) = .empty;
        if (try p.atWord("with", .operand)) {
            _ = try p.next(.operand);
            while (true) {
                var spread: ?Tok = null;
                if (try p.atKind(.ellipsis, .operand)) spread = try p.next(.operand);
                try args.append(p.a, .{ .spread = spread, .value = try p.expr() });
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        _ = try p.expectWord("to", .operator);
        const target = try p.expr();
        return p.stmt(first, .{ .send = .{ .name = n, .computed = computed, .labels = &.{}, .args = try p.list(ast.ListItem, &args), .target = target, .target_first = false, .wait = try p.andWait() } });
    }

    /// An Operation name, any word, then its arguments and, where allowed,
    /// `and wait`.
    fn operation(p: *Parser, waits: bool) Error!ast.Operation {
        const t = try p.peek(.operand);
        if (t.kind != .word or p.isWord(t, "_")) return p.failAt(t);
        const op = try p.next(.operand);
        const args: []const *Expr = if (p.startsExpr(try p.peek(.operand))) try p.exprList() else &.{};
        return .{ .target = null, .operation = op, .args = args, .wait = if (waits) try p.andWait() else null };
    }

    fn tell(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        const target = try p.expr();
        if (!try p.atEnd(.operator)) {
            _ = try p.expectWord("to", .operator);
            var op = try p.operation(false);
            op.target = target;
            return p.stmt(first, .{ .tell = op });
        }
        try p.endOfStatement();
        var lines: std.ArrayList(ast.Operation) = .empty;
        while (true) {
            try p.skipNewlines();
            const t = try p.peek(.operand);
            if (t.kind == .eof) return p.failAt(t);
            if (p.isWord(t, "end")) break;
            try lines.append(p.a, try p.operation(true));
            try p.endOfStatement();
        }
        const end = try p.next(.operand);
        try p.endSuffix("tell");
        return p.stmt(first, .{ .tell_block = .{ .target = target, .lines = try p.list(ast.Operation, &lines), .end = end } });
    }

    fn timeoutBlock(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        _ = try p.next(.operand);
        _ = try p.expectWord("of", .operand);
        const duration = try p.expr();
        const t = try p.peek(.operator);
        if (t.kind != .newline) return p.failAt(t);
        try p.endOfStatement();
        const b = try p.block(&.{"end"});
        const end = try p.expectWord("end", .operand);
        try p.endSuffix("timeout");
        return p.stmt(first, .{ .timeout = .{ .duration = duration, .body = b, .end = end } });
    }

    fn wait(p: *Parser, block_allowed: bool) Error!*Stmt {
        const first = try p.next(.operand);
        if (!try p.atWord("for", .operand)) return p.stmt(first, .{ .wait = try p.expr() });
        _ = try p.next(.operand);
        if (!block_allowed and (try p.atWord("all", .operand) or try p.atEnd(.operand))) return p.fail(.operand);
        if (try p.atWord("all", .operand)) {
            _ = try p.next(.operand);
            const t = try p.peek(.operator);
            if (t.kind != .newline) return p.failAt(t);
            try p.endOfStatement();
            const b = try p.block(&.{"end"});
            const end = try p.expectWord("end", .operand);
            try p.endSuffix("wait");
            return p.stmt(first, .{ .join = .{ .body = b, .end = end } });
        }
        if (try p.atEnd(.operand)) {
            try p.endOfStatement();
            var branches: std.ArrayList(ast.WaitBranch) = .empty;
            while (true) {
                try p.skipNewlines();
                const t = try p.peek(.operand);
                if (p.isWord(t, "when")) {
                    const keyword = try p.next(.operand);
                    const ev = try p.event();
                    var guard: ?ast.Guard = null;
                    if (try p.atWord("where", .operator)) guard = try p.guardClause();
                    _ = try p.expectWord("then", .operator);
                    try branches.append(p.a, .{ .keyword = keyword, .data = .{ .when = .{ .event = ev, .guard = guard } }, .body = try p.branchBody(&.{ "when", "after", "end" }) });
                } else if (p.isWord(t, "after")) {
                    const keyword = try p.next(.operand);
                    const d = try p.expr();
                    _ = try p.expectWord("then", .operator);
                    try branches.append(p.a, .{ .keyword = keyword, .data = .{ .after = d }, .body = try p.branchBody(&.{ "when", "after", "end" }) });
                } else if (p.isWord(t, "end")) {
                    const end = try p.next(.operand);
                    try p.endSuffix("wait");
                    return p.stmt(first, .{ .wait_block = .{ .branches = try p.list(ast.WaitBranch, &branches), .end = end } });
                } else return p.failAt(t);
            }
        }
        const ev = try p.event();
        var timeout: ?*Expr = null;
        if (try p.atWord("or", .operator)) {
            _ = try p.next(.operator);
            timeout = try p.expr();
        }
        return p.stmt(first, .{ .wait_for = .{ .event = ev, .timeout = timeout } });
    }

    fn atFrom(p: *Parser) Allocator.Error!bool {
        return try p.atWord("from", .operator) and p.startsExpr(try p.peek2("wait-from", .operand));
    }

    fn event(p: *Parser) Error!ast.Event {
        const n = try p.messageName();
        var patterns: std.ArrayList(*Pattern) = .empty;
        var labels: std.ArrayList(Tok) = .empty;
        var from: ?*Expr = null;
        const t = try p.peek(.operand);
        if (!(t.kind == .newline or t.kind == .eof or p.isWord(t, "where") or p.isWord(t, "then") or p.isWord(t, "or") or try p.atFrom())) {
            try patterns.append(p.a, try p.pattern());
            while (p.isLabel(try p.peek(.operator))) {
                try labels.append(p.a, try p.next(.operand));
                try patterns.append(p.a, try p.pattern());
            }
            while (labels.items.len == 0 and try p.atKind(.comma, .operator)) {
                _ = try p.next(.operator);
                try patterns.append(p.a, try p.pattern());
            }
        }
        if (try p.atFrom()) {
            _ = try p.next(.operator);
            // A postfix-level operand, so `… from b or 30 s` leaves `or` to
            // the timeout.
            from = try p.chunkLevel();
        }
        return .{ .name = n, .labels = try p.list(Tok, &labels), .patterns = try p.list(*Pattern, &patterns), .from = from };
    }

    fn ifStatement(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        const condition = try p.expr();
        _ = try p.expectWord("then", .operator);
        var arms: std.ArrayList(ast.Arm) = .empty;
        if (!try p.atEnd(.operator)) {
            const then = try p.simpleStatement();
            const one = try p.a.alloc(*Stmt, 1);
            one[0] = then;
            try arms.append(p.a, .{ .keyword = first, .condition = condition, .body = one });
            var else_body: ?ast.Block = null;
            if (try p.atWord("else", .operator)) {
                _ = try p.next(.operator);
                const other = try p.a.alloc(*Stmt, 1);
                other[0] = try p.simpleStatement();
                else_body = other;
            }
            return p.stmt(first, .{ .@"if" = .{ .arms = try p.list(ast.Arm, &arms), .@"else" = else_body, .one_line = true, .end = null } });
        }
        try p.endOfStatement();
        try arms.append(p.a, .{ .keyword = first, .condition = condition, .body = try p.block(&.{ "else", "end" }) });
        var else_body: ?ast.Block = null;
        while (try p.atWord("else", .operand)) {
            const keyword = try p.next(.operand);
            if (try p.atWord("if", .operand)) {
                _ = try p.next(.operand);
                const c = try p.expr();
                _ = try p.expectWord("then", .operator);
                try p.endOfStatement();
                try arms.append(p.a, .{ .keyword = keyword, .condition = c, .body = try p.block(&.{ "else", "end" }) });
                continue;
            }
            try p.endOfStatement();
            else_body = try p.block(&.{"end"});
            break;
        }
        const end = try p.expectWord("end", .operand);
        try p.endSuffix("if");
        return p.stmt(first, .{ .@"if" = .{ .arms = try p.list(ast.Arm, &arms), .@"else" = else_body, .one_line = false, .end = end } });
    }

    fn repeat(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        const t = try p.peek(.operand);
        var r: ast.Repeat = .{ .head = .forever, .collecting = null, .body = &.{}, .end = undefined };
        if (p.isWord(t, "for")) {
            _ = try p.next(.operand);
            _ = try p.expectWord("each", .operand);
            const pat = try p.pattern();
            _ = try p.expectWord("in", .operator);
            r.head = .{ .for_each = .{ .pattern = pat, .source = try p.expr() } };
        } else if (p.isWord(t, "while")) {
            _ = try p.next(.operand);
            r.head = .{ .@"while" = try p.expr() };
        } else if (p.isWord(t, "until")) {
            _ = try p.next(.operand);
            r.head = .{ .until = try p.expr() };
        } else if (p.isWord(t, "forever")) {
            _ = try p.next(.operand);
        } else {
            const n = try p.expr();
            _ = try p.expectWord("times", .operator);
            r.head = .{ .times = n };
        }
        // `collecting` is in the FOLLOW set, so the head has ended before it.
        if (try p.atWord("collecting", .operator)) {
            const keyword = try p.next(.operator);
            const value = try p.expr();
            _ = try p.expectWord("into", .operator);
            r.collecting = .{ .keyword = keyword, .value = value, .into = try p.name(.operand) };
        }
        try p.endOfStatement();
        r.body = try p.block(&.{"end"});
        r.end = try p.expectWord("end", .operand);
        try p.endSuffix("repeat");
        return p.stmt(first, .{ .repeat = r });
    }

    fn match(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        const subject = try p.expr();
        const ignoring = try p.ignoringCase(.operator);
        try p.endOfStatement();
        var branches: std.ArrayList(ast.When) = .empty;
        var else_body: ?ast.Block = null;
        while (true) {
            try p.skipNewlines();
            const t = try p.peek(.operand);
            if (p.isWord(t, "when") and else_body == null) {
                const keyword = try p.next(.operand);
                var contains = false;
                if (try p.atWord("contains", .operand) and (try p.peek2("when-contains", .operand)).kind == .pattern_open) {
                    _ = try p.next(.operand);
                    contains = true;
                }
                const pat = try p.pattern();
                var guard: ?ast.Guard = null;
                if (try p.atWord("where", .operator)) guard = try p.guardClause();
                _ = try p.expectWord("then", .operator);
                try branches.append(p.a, .{ .keyword = keyword, .contains = contains, .pattern = pat, .guard = guard, .body = try p.branchBody(&.{ "when", "else", "end" }) });
            } else if (p.isWord(t, "else") and else_body == null) {
                _ = try p.next(.operand);
                else_body = try p.branchBody(&.{"end"});
            } else if (p.isWord(t, "end")) {
                const end = try p.next(.operand);
                try p.endSuffix("match");
                return p.stmt(first, .{ .match = .{ .subject = subject, .ignoring = ignoring, .branches = try p.list(ast.When, &branches), .@"else" = else_body, .end = end } });
            } else return p.failAt(t);
        }
    }

    fn tryStatement(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        try p.endOfStatement();
        const b = try p.block(&.{ "offer", "catch", "finally", "end" });
        var offers: std.ArrayList(ast.Offer) = .empty;
        while (try p.atWord("offer", .operand)) {
            const keyword = try p.next(.operand);
            const n = try p.name(.operand);
            var params: std.ArrayList(Tok) = .empty;
            if (!try p.atEnd(.operand)) {
                try params.append(p.a, try p.name(.operand));
                while (try p.atKind(.comma, .operator)) {
                    _ = try p.next(.operator);
                    try params.append(p.a, try p.name(.operand));
                }
            }
            try p.endOfStatement();
            try offers.append(p.a, .{ .keyword = keyword, .name = n, .params = try p.list(Tok, &params), .body = try p.block(&.{ "offer", "catch", "finally", "end" }) });
        }
        var catches: std.ArrayList(ast.Catch) = .empty;
        while (try p.atWord("catch", .operand)) {
            const keyword = try p.next(.operand);
            const pat = try p.pattern();
            var recovery: ?Tok = null;
            if (try p.atWord("before", .operator)) {
                recovery = try p.next(.operator);
                _ = try p.expectWord("unwind", .operand);
            }
            var guard: ?ast.Guard = null;
            if (try p.atWord("where", .operator)) guard = try p.guardClause();
            try p.endOfStatement();
            try catches.append(p.a, .{ .keyword = keyword, .pattern = pat, .recovery = recovery, .guard = guard, .body = try p.block(&.{ "catch", "finally", "end" }) });
        }
        var fin: ?ast.Finally = null;
        if (try p.atWord("finally", .operand)) {
            const keyword = try p.next(.operand);
            try p.endOfStatement();
            fin = .{ .keyword = keyword, .body = try p.block(&.{"end"}) };
        }
        const end = try p.expectWord("end", .operand);
        try p.endSuffix("try");
        return p.stmt(first, .{ .@"try" = .{ .body = b, .offers = try p.list(ast.Offer, &offers), .catches = try p.list(ast.Catch, &catches), .finally = fin, .end = end } });
    }

    fn chooseOffer(p: *Parser) Error!*Stmt {
        const first = try p.next(.operand);
        _ = try p.next(.operand);
        const n = try p.name(.operand);
        var args: []const *Expr = &.{};
        const open = try p.peek(.operator);
        if (open.kind == .left_paren and !open.space_before) {
            _ = try p.next(.operator);
            if (!try p.atKind(.right_paren, .operand)) args = try p.nested(exprList);
            _ = try p.expect(.right_paren, .operator);
        }
        return p.stmt(first, .{ .choose = .{ .name = n, .args = args } });
    }

    /// `replace [first] <p> in c with e`. As a statement `c` is a Container.
    fn replace(p: *Parser, statement_form: bool) Error!ast.Replace {
        const keyword = try p.next(.operand);
        var first: ?Tok = null;
        if (try p.atWord("first", .operand) and !p.isWord(try p.peek2("replace-first", .operand), "in")) first = try p.next(.operand);
        const pat = try p.chunkLevel();
        _ = try p.expectWord("in", .operator);
        const target = if (statement_form) try p.container() else try p.orExpr();
        _ = try p.expectWord("with", .operator);
        const value = if (statement_form) try p.expr() else try p.concat();
        return .{ .keyword = keyword, .first = first, .pattern = pat, .target = target, .value = value };
    }

    fn ignoringCase(p: *Parser, mode: Mode) Error!?Tok {
        if (try p.atWord("ignoring", mode) and p.isWord(try p.peek2("ignoring-case", mode), "case")) {
            const t = try p.next(mode);
            _ = try p.next(mode);
            return t;
        }
        return null;
    }

    // ------------------------------------------------------------ expressions

    /// Runs `f` outside any build value, where `as uint16` is a conversion
    /// again.
    fn nested(p: *Parser, comptime f: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
        const saved = p.build;
        p.build = 0;
        defer p.build = saved;
        return f(p);
    }

    fn expr(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        try p.enter(t.start);
        defer p.leave();
        if (p.isWord(t, "given")) return p.lambda();
        // A Whose Clause is a whole Expression, as a Lambda is.
        if (p.isWord(t, "every")) {
            const n = try p.peek2("every-chunk", .operator);
            if (n.kind == .word and (isSingular(p.word(n)) or p.isWord(n, "code"))) return p.everyHead();
        }
        const e = try p.orExpr();
        if (e.data == .chunk and e.data.chunk.ordinal != null and try p.atWord("whose", .operator)) {
            const op = try p.next(.operator);
            const condition = try p.whoseCondition();
            return p.mk(op, .{ .whose = .{ .whose = op, .every = false, .word = e.pos, .kind = e.data.chunk.kind, .source = e.data.chunk.of, .delimiter = e.data.chunk.delimiter, .delimited = e.data.chunk.delimited, .ordinal = e, .condition = condition } }, &.{ e, condition });
        }
        return e;
    }

    fn lambda(p: *Parser) Error!*Expr {
        const given = try p.next(.operand);
        try p.nl_base.append(p.a, p.brackets.items.len);
        var params: std.ArrayList(*Pattern) = .empty;
        const t0 = try p.peek(.operand);
        if (!(t0.kind == .colon or t0.kind == .newline or t0.kind == .eof)) {
            try params.append(p.a, try p.pattern());
            while (try p.atKind(.comma, .operator)) {
                _ = try p.next(.operator);
                try params.append(p.a, try p.pattern());
            }
        }
        const t = try p.peek(.operator);
        if (t.kind == .colon) {
            _ = try p.next(.operator);
            _ = p.nl_base.pop();
            const e = try p.expr();
            return p.mk(given, .{ .lambda = .{ .given = given, .params = try p.list(*Pattern, &params), .body = .{ .expr = e }, .end = null } }, &.{e});
        }
        if (t.kind != .newline) return p.failAt(t);
        try p.endOfStatement();
        const b = try p.block(&.{"end"});
        const end = try p.expectWord("end", .operand);
        // Restore the enclosing bracket continuations before peeking past a
        // bare `end`.
        _ = p.nl_base.pop();
        p.buffered = 0;
        const suffix = try p.peek(.operator);
        const end_tok = p.tokens.items[end];
        const same_line = std.mem.indexOfAny(u8, p.lex.shared.source[end_tok.end..suffix.start], "\r\n") == null;
        if (same_line and suffix.kind == .word and (p.isWord(suffix, "given") or among(p.word(suffix), &block_keywords))) {
            if (!p.isWord(suffix, "given")) return p.failAt(suffix);
            _ = try p.next(.operator);
        }
        return p.mk(given, .{ .lambda = .{ .given = given, .params = try p.list(*Pattern, &params), .body = .{ .block = b }, .end = end } }, &.{});
    }

    fn binary(p: *Parser, pos: Tok, op: ast.BinaryOp, left: *Expr, right: *Expr, negated: bool) Error!*Expr {
        return p.mk(pos, .{ .binary = .{ .op = op, .left = left, .right = right, .negated = negated, .ignoring = null } }, &.{ left, right });
    }

    fn orExpr(p: *Parser) Error!*Expr {
        var l = try p.andExpr();
        while (try p.atWord("or", .operator)) {
            const op = try p.next(.operator);
            l = try p.binary(op, .@"or", l, try p.andExpr(), false);
        }
        return l;
    }

    fn andExpr(p: *Parser) Error!*Expr {
        var l = try p.notExpr();
        while (try p.atWord("and", .operator) and !p.isWord(try p.peek2("and-wait", .operand), "wait")) {
            const op = try p.next(.operator);
            l = try p.binary(op, .@"and", l, try p.notExpr(), false);
        }
        return l;
    }

    fn notExpr(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        if (p.isWord(t, "not")) {
            try p.enter(t.start);
            defer p.leave();
            const op = try p.next(.operand);
            const e = try p.notExpr();
            return p.mk(op, .{ .not = e }, &.{e});
        }
        return p.comparison();
    }

    fn comparison(p: *Parser) Error!*Expr {
        const l = try p.concat();
        const t = try p.peek(.operator);
        var node: *Expr = undefined;
        const symbol: ?ast.BinaryOp = switch (t.kind) {
            .equal => .equal,
            .not_equal => .not_equal,
            .less => .less,
            .greater => .greater,
            .less_equal => .less_equal,
            .greater_equal => .greater_equal,
            else => null,
        };
        if (symbol) |op| {
            const pos = try p.next(.operator);
            node = try p.binary(pos, op, l, try p.concat(), false);
        } else if (p.isWord(t, "is")) {
            const pos = try p.next(.operator);
            var negated = false;
            if (try p.atWord("not", .operand)) {
                _ = try p.next(.operand);
                negated = true;
            }
            const u = try p.peek(.operand);
            if (p.isWord(u, "in")) {
                _ = try p.next(.operand);
                node = try p.binary(pos, .is_in, l, try p.concat(), negated);
            } else if ((p.isWord(u, "a") or p.isWord(u, "an")) and p.isKindWord(try p.peek2("is-a", .operator))) {
                _ = try p.next(.operand);
                const k = try p.kind(.operand);
                node = try p.mk(pos, .{ .is_kind = .{ .value = l, .kind = k, .negated = negated, .ignoring = null } }, &.{l});
            } else if (p.isWord(u, "empty")) {
                _ = try p.next(.operand);
                node = try p.mk(pos, .{ .is_empty = .{ .value = l, .negated = negated, .ignoring = null } }, &.{l});
            } else if ((p.isWord(u, "greater") or p.isWord(u, "less") or p.isWord(u, "at")) and blk: {
                const n = try p.peek2("ordering-words", .operator);
                break :blk if (p.isWord(u, "at")) p.isWord(n, "least") or p.isWord(n, "most") else p.isWord(n, "than");
            }) {
                _ = try p.next(.operator);
                const w = try p.next(.operator);
                const second = p.word(p.tokens.items[w]);
                const op: ast.BinaryOp = if (p.isWord(u, "greater")) .greater else if (p.isWord(u, "less")) .less else if (std.mem.eql(u8, second, "least")) .greater_equal else .less_equal;
                node = try p.binary(pos, op, l, try p.concat(), negated);
            } else {
                node = try p.binary(pos, .equal, l, try p.concat(), negated);
            }
        } else if (p.isWord(t, "can") and p.isWord(try p.peek2("can-be", .operator), "be")) {
            const pos = try p.next(.operator);
            _ = try p.next(.operator);
            if (try p.atWord("a", .operand) or try p.atWord("an", .operand)) _ = try p.next(.operand);
            const k = try p.kind(.operand);
            node = try p.mk(pos, .{ .can_be = .{ .value = l, .kind = k, .ignoring = null } }, &.{l});
        } else if (p.isWord(t, "contains") or p.isWord(t, "matches")) {
            const pos = try p.next(.operator);
            node = try p.binary(pos, if (p.isWord(t, "contains")) .contains else .matches, l, try p.concat(), false);
        } else if ((p.isWord(t, "begins") or p.isWord(t, "ends")) and p.isWord(try p.peek2("begins-with", .operator), "with")) {
            const pos = try p.next(.operator);
            _ = try p.next(.operator);
            node = try p.binary(pos, if (p.isWord(t, "begins")) .begins_with else .ends_with, l, try p.concat(), false);
        } else if (p.isWord(t, "comes") and blk: {
            const n = try p.peek2("comes", .operator);
            break :blk p.isWord(n, "before") or p.isWord(n, "after");
        }) {
            const pos = try p.next(.operator);
            const w = try p.next(.operator);
            node = try p.binary(pos, if (std.mem.eql(u8, p.word(p.tokens.items[w]), "before")) .less else .greater, l, try p.concat(), false);
        } else if (p.isWord(t, "does") and p.isWord(try p.peek2("does-not", .operator), "not")) {
            const pos = try p.next(.operator);
            _ = try p.next(.operator);
            const w = try p.peek(.operator);
            const op: ast.BinaryOp = if (p.isWord(w, "contain")) .contains else if (p.isWord(w, "begin")) .begins_with else if (p.isWord(w, "end")) .ends_with else if (p.isWord(w, "match")) .matches else return p.failAt(w);
            _ = try p.next(.operator);
            if (op == .begins_with or op == .ends_with) _ = try p.expectWord("with", .operator);
            node = try p.binary(pos, op, l, try p.concat(), true);
        } else return l;
        if (try p.ignoringCase(.operator)) |ig| {
            switch (node.data) {
                .binary => |*b| b.ignoring = ig,
                .is_kind => |*k| k.ignoring = ig,
                .is_empty => |*k| k.ignoring = ig,
                .can_be => |*k| k.ignoring = ig,
                else => unreachable,
            }
        }
        return node;
    }

    fn concat(p: *Parser) Error!*Expr {
        var l = try p.range();
        while (try p.atKind(.ampersand, .operator)) {
            const op = try p.next(.operator);
            l = try p.binary(op, .concat, l, try p.range(), false);
        }
        return l;
    }

    fn range(p: *Parser) Error!*Expr {
        const l = try p.additive();
        if (try p.atKind(.dot_dot, .operator)) {
            const op = try p.next(.operator);
            return p.binary(op, .range, l, try p.additive(), false);
        }
        return l;
    }

    fn additive(p: *Parser) Error!*Expr {
        var l = try p.multiplicative();
        while (true) {
            const t = try p.peek(.operator);
            const op: ast.BinaryOp = switch (t.kind) {
                .plus => .add,
                .minus => .subtract,
                else => return l,
            };
            const pos = try p.next(.operator);
            l = try p.binary(pos, op, l, try p.multiplicative(), false);
        }
    }

    fn multiplicative(p: *Parser) Error!*Expr {
        var l = try p.power();
        while (true) {
            const t = try p.peek(.operator);
            const op: ast.BinaryOp = switch (t.kind) {
                .star => .multiply,
                .slash => .divide,
                .word => if (p.isWord(t, "mod")) .mod else if (p.isWord(t, "div")) .div else return l,
                else => return l,
            };
            const pos = try p.next(.operator);
            l = try p.binary(pos, op, l, try p.power(), false);
        }
    }

    fn power(p: *Parser) Error!*Expr {
        const l = try p.unary();
        if (try p.atKind(.caret, .operator)) {
            const t = try p.peek(.operator);
            try p.enter(t.start);
            defer p.leave();
            const op = try p.next(.operator);
            return p.binary(op, .power, l, try p.power(), false);
        }
        return l;
    }

    fn unary(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        if (t.kind == .minus) {
            try p.enter(t.start);
            defer p.leave();
            const op = try p.next(.operand);
            const e = try p.unary();
            return p.mk(op, .{ .negate = e }, &.{e});
        }
        return p.conversion();
    }

    /// Postfix `as`: tighter than every binary operator, looser than `of`,
    /// `'s` and calls.
    fn conversion(p: *Parser) Error!*Expr {
        var e = try p.chunkLevel();
        while (try p.atWord("as", .operator)) {
            if (p.build > 0) {
                // A field type starts with an integer type or a size.
                const n = try p.peek2("as-in-build", .conversion);
                if ((n.kind == .word and integer_types.has(p.word(n))) or n.kind == .number or n.kind == .left_paren or n.kind == .caret) return e;
            }
            const op = try p.next(.operator);
            const t = try p.peek(.conversion);
            if (t.kind == .unit or t.kind == .invalid) {
                const u = try p.next(.conversion);
                e = try p.mk(op, .{ .conversion = .{ .value = e, .kind = null, .unit = u } }, &.{e});
            } else {
                const k = try p.kind(.operand);
                e = try p.mk(op, .{ .conversion = .{ .value = e, .kind = k, .unit = null } }, &.{e});
            }
        }
        return e;
    }

    fn isKindWord(p: *Parser, t: Token) bool {
        return p.isName(t) or p.isWord(t, "function");
    }

    fn kind(p: *Parser, mode: Mode) Error!ast.Kind {
        const t = try p.peek(mode);
        if (!p.isKindWord(t)) return p.failAt(t);
        if (p.isWord(t, "civil") and p.isWord(try p.peek2("kind", if (mode == .operand) .operator else mode), "date")) {
            const n = try p.next(mode);
            _ = try p.next(mode);
            return .{ .name = n, .civil_date = true };
        }
        return .{ .name = try p.next(mode), .civil_date = false };
    }

    fn isPluralProperty(p: *Parser, e: *const Expr) bool {
        const pr = e.data.property;
        if (pr.code_points) return true;
        var plural = false;
        return chunkKind(p.word(p.tokens.items[pr.name]), &plural) != null and plural;
    }

    /// A postfix expression, and a `delimited by` for the outermost Chunk
    /// Expression of an `of` chain.
    fn chunkLevel(p: *Parser) Error!*Expr {
        const e = try p.postfix(try p.primary());
        if (try p.atWord("delimited", .operator) and p.isWord(try p.peek2("delimited-by", .operator), "by")) {
            const ok = switch (e.data) {
                .chunk => true,
                .property => p.isPluralProperty(e),
                else => false,
            };
            if (!ok) return p.fail(.operator);
            const delimited = try p.next(.operator);
            _ = try p.next(.operand);
            const d = try p.postfix(try p.primary());
            switch (e.data) {
                .chunk => |*c| {
                    c.delimiter = d;
                    c.delimited = delimited;
                },
                .property => |*pr| {
                    pr.delimiter = d;
                    pr.delimited = delimited;
                },
                else => unreachable,
            }
            e.depth = @max(e.depth, d.depth + 1);
            if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[delimited].start);
        }
        return e;
    }

    fn postfix(p: *Parser, base: *Expr) Error!*Expr {
        var e = base;
        while (try p.atKind(.possessive, .operator)) {
            const op = try p.next(.operator);
            e = try p.keyOrProperty(op, e);
        }
        return e;
    }

    /// After `'s` or `the`: any word, Reserved Words included, or `code
    /// points`; a Built-in property name reads the property.
    fn keyOrProperty(p: *Parser, pos: Tok, base: ?*Expr) Error!*Expr {
        const t = try p.peek(.operand);
        if (t.kind != .word) return p.failAt(t);
        var code_points = false;
        var key: Tok = undefined;
        if (p.isWord(t, "code") and p.isWord(try p.peek2("code-point", .operator), "points")) {
            key = try p.next(.operand);
            _ = try p.next(.operand);
            code_points = true;
        } else key = try p.next(.operand);
        const b = base orelse blk: {
            _ = try p.expectWord("of", .operator);
            break :blk try p.postfix(try p.primary());
        };
        if (code_points or properties.has(p.word(p.tokens.items[key]))) {
            return p.mk(pos, .{ .property = .{ .base = b, .name = key, .code_points = code_points, .delimiter = null, .delimited = null } }, &.{b});
        }
        return p.mk(pos, .{ .key = .{ .base = b, .key = key, .computed = null } }, &.{b});
    }

    fn call(p: *Parser, n: Tok) Error!*Expr {
        _ = try p.next(.operator);
        var args: []const *Expr = &.{};
        if (!try p.atKind(.right_paren, .operand)) args = try p.nested(exprList);
        _ = try p.expect(.right_paren, .operator);
        var depth: u16 = 0;
        for (args) |arg| depth = @max(depth, arg.depth);
        const e = try p.mk(n, .{ .call = .{ .name = n, .args = args } }, &.{});
        e.depth = depth + 1;
        if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[n].start);
        return e;
    }

    /// After a chunk word: does the next token start its index?
    fn startsIndex(p: *Parser, t: Token) bool {
        return switch (t.kind) {
            .number, .text, .template, .minus, .left_bracket => true,
            .left_paren => t.space_before,
            .word => (p.isName(t) or p.isWord(t, "the") or p.isWord(t, "it") or p.isWord(t, "me")) and !follow.has(p.word(t)),
            else => false,
        };
    }

    fn primary(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        try p.enter(t.start);
        defer p.leave();
        switch (t.kind) {
            .number => {
                const n = try p.next(.operand);
                const u = try p.peek(.unit);
                if (u.kind == .unit or u.kind == .invalid) {
                    const unit = try p.next(.unit);
                    return p.mk(n, .{ .quantity = .{ .number = n, .unit = unit } }, &.{});
                }
                return p.mk(n, .{ .number = n }, &.{});
            },
            .text => {
                const n = try p.next(.operand);
                return p.mk(n, .{ .text = n }, &.{});
            },
            .template => return p.template(),
            .pattern_open => {
                const tp = try p.textPattern();
                return p.mk(tp.open, .{ .text_pattern = tp }, &.{});
            },
            .binary_open => return p.bytesBuild(),
            .left_paren => {
                const open = try p.next(.operand);
                const e = try p.nested(expr);
                _ = try p.expect(.right_paren, .operator);
                return p.mk(open, .{ .group = e }, &.{e});
            },
            .left_bracket => return p.listLiteral(),
            .left_brace => return p.mapLiteral(),
            .caret => if (p.size > 0) {
                const pos = try p.next(.operand);
                const n = try p.name(.operand);
                return p.mk(pos, .{ .pin = n }, &.{});
            },
            .word => return p.wordPrimary(t),
            else => {},
        }
        return p.failAt(t);
    }

    /// A backtick literal with holes: its pieces become tokens around each
    /// hole's, and each hole is parsed as an expression ending at its `}`.
    fn template(p: *Parser) Error!*Expr {
        const t = try p.peek(.operand);
        const lit = p.lex.literal(t.start);
        // Consume the whole literal, then lay its pieces out as tokens.
        _ = try p.next(.operand);
        _ = p.tokens.pop();
        p.buffered = 0;
        const outer = p.lex;
        const saved_brackets = p.brackets;
        const saved_base = p.nl_base;
        const saved_prev = p.prev;
        const saved_build = p.build;
        const saved_whose = p.whose_key_at;
        var holes = try p.a.alloc(*Expr, lit.holes.len);
        var open: Tok = undefined;
        var start = t.start;
        var depth: u16 = 0;
        for (lit.holes, 0..) |h, i| {
            const piece = try p.push(.{ .kind = .template, .start = start, .end = h.start, .space_before = i == 0 and t.space_before });
            if (i == 0) open = piece;
            p.lex = outer.hole(h);
            p.offset = h.start;
            p.buffered = 0;
            p.prev = null;
            p.build = 0;
            p.brackets = .empty;
            try p.brackets.append(p.a, .left_brace);
            p.nl_base = .empty;
            try p.nl_base.append(p.a, 0);
            holes[i] = try p.expr();
            depth = @max(depth, holes[i].depth);
            const end = try p.peek(.operator);
            if (end.kind != .eof) return p.failAt(end);
            // Record the line breaks before the `}`.
            while (p.offset < h.end) {
                const nl = try p.lex.next(p.offset, .operator);
                if (nl.kind != .newline) break;
                _ = try p.push(nl);
                p.offset = nl.end;
            }
            start = h.end;
        }
        _ = try p.push(.{ .kind = .template, .start = start, .end = t.end, .space_before = false });
        p.lex = outer;
        p.offset = t.end;
        p.buffered = 0;
        p.brackets = saved_brackets;
        p.nl_base = saved_base;
        p.prev = saved_prev;
        p.build = saved_build;
        p.whose_key_at = saved_whose;
        const e = try p.mk(open, .{ .template = .{ .open = open, .holes = holes } }, &.{});
        e.depth = depth + 1;
        if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, t.start);
        return e;
    }

    fn wordPrimary(p: *Parser, t: Token) Error!*Expr {
        const w = p.word(t);
        inline for (.{ "true", "false", "nothing", "it", "me" }) |v| {
            if (std.mem.eql(u8, w, v)) {
                const n = try p.next(.operand);
                return p.mk(n, .{ .word = @field(ast.Word, v) }, &.{});
            }
        }
        if (std.mem.eql(u8, w, "the")) return p.the();
        if (std.mem.eql(u8, w, "replace")) {
            const r = try p.replace(false);
            return p.mk(r.keyword, .{ .replace = r }, &.{ r.pattern, r.target, r.value });
        }
        if (!p.isName(t)) return p.failAt(t);
        if (std.mem.eql(u8, w, "every")) {
            if (p.isWord(try p.peek2("every-match", .operator), "match")) {
                const pos = try p.next(.operand);
                _ = try p.next(.operand);
                _ = try p.expectWord("of", .operator);
                const pat = try p.chunkLevel();
                _ = try p.expectWord("in", .operator);
                const source = try p.concat();
                return p.mk(pos, .{ .match_search = .{ .pattern = pat, .source = source } }, &.{ pat, source });
            }
        } else if (std.mem.eql(u8, w, "code")) {
            const n = try p.peek2("code-point", .operator);
            if (p.isWord(n, "point") or p.isWord(n, "points")) {
                const pos = try p.next(.operand);
                _ = try p.next(.operand);
                return p.chunk(pos, .code_point);
            }
        } else if (chunkKind(w, null)) |k| {
            if (p.startsIndex(try p.peek2("chunk-word", .operator))) {
                const pos = try p.next(.operand);
                return p.chunk(pos, k);
            }
        }
        const n = try p.next(.operand);
        const open = try p.peek(.operator);
        if (open.kind == .left_paren and !open.space_before) return p.call(n);
        if (p.whose_key_at == t.start) return p.mk(n, .{ .whose_key = n }, &.{});
        return p.mk(n, .{ .name = n }, &.{});
    }

    /// `every item of xs whose c`.
    fn everyHead(p: *Parser) Error!*Expr {
        _ = try p.next(.operand);
        const w = try p.next(.operand);
        var k: ast.ChunkKind = undefined;
        if (std.mem.eql(u8, p.word(p.tokens.items[w]), "code")) {
            _ = try p.expectWord("point", .operand);
            k = .code_point;
        } else k = chunkKind(p.word(p.tokens.items[w]), null).?;
        _ = try p.expectWord("of", .operator);
        const source = try p.postfix(try p.primary());
        var delimiter: ?*Expr = null;
        var delimited: ?Tok = null;
        if (try p.atWord("delimited", .operator) and p.isWord(try p.peek2("delimited-by", .operator), "by")) {
            delimited = try p.next(.operator);
            _ = try p.next(.operand);
            delimiter = try p.postfix(try p.primary());
        }
        const op = try p.expectWord("whose", .operator);
        const condition = try p.whoseCondition();
        return p.mk(op, .{ .whose = .{ .whose = op, .every = true, .word = w, .kind = k, .source = source, .delimiter = delimiter, .delimited = delimited, .ordinal = null, .condition = condition } }, &.{ source, delimiter, condition });
    }

    /// A Name operand that is the condition's first token is a Whose Key.
    fn whoseCondition(p: *Parser) Error!*Expr {
        p.whose_key_at = (try p.peek(.operand)).start;
        return p.expr();
    }

    fn chunk(p: *Parser, pos: Tok, k: ast.ChunkKind) Error!*Expr {
        const index = try p.range();
        _ = try p.expectWord("of", .operator);
        const of = try p.postfix(try p.primary());
        return p.mk(pos, .{ .chunk = .{ .kind = k, .index = index, .ordinal = null, .of = of, .delimiter = null, .delimited = null } }, &.{ index, of });
    }

    fn the(p: *Parser) Error!*Expr {
        const pos = try p.next(.operand);
        const t = try p.peek(.operand);
        if (t.kind == .left_paren) {
            _ = try p.next(.operand);
            const key = try p.nested(expr);
            _ = try p.expect(.right_paren, .operator);
            _ = try p.expectWord("of", .operator);
            const base = try p.postfix(try p.primary());
            return p.mk(pos, .{ .key = .{ .base = base, .key = null, .computed = key } }, &.{ key, base });
        }
        if (t.kind == .text) {
            const key = try p.next(.operand);
            _ = try p.expectWord("of", .operator);
            const base = try p.postfix(try p.primary());
            return p.mk(pos, .{ .key = .{ .base = base, .key = key, .computed = null } }, &.{base});
        }
        const is_target = p.isWord(t, "target");
        if (t.kind == .word and (is_target or ordinals.has(p.word(t)))) {
            const n = if (is_target) try p.peek2("target", .operator) else try p.peek2("ordinal", .operator);
            if (is_target and !p.isWord(n, "of")) {
                _ = try p.next(.operand);
                return p.mk(pos, .target, &.{});
            }
            if (!is_target and n.kind == .word and (isSingular(p.word(n)) or p.isWord(n, "code"))) {
                const ordinal = try p.next(.operand);
                const w = try p.next(.operand);
                var k: ast.ChunkKind = undefined;
                if (std.mem.eql(u8, p.word(p.tokens.items[w]), "code")) {
                    _ = try p.expectWord("point", .operand);
                    k = .code_point;
                } else k = chunkKind(p.word(p.tokens.items[w]), null).?;
                _ = try p.expectWord("of", .operator);
                const of = try p.postfix(try p.primary());
                return p.mk(w, .{ .chunk = .{ .kind = k, .index = null, .ordinal = ordinal, .of = of, .delimiter = null, .delimited = null } }, &.{of});
            }
        }
        return p.keyOrProperty(pos, null);
    }

    fn listLiteral(p: *Parser) Error!*Expr {
        const open = try p.next(.operand);
        var items: std.ArrayList(ast.ListItem) = .empty;
        var depth: u16 = 0;
        if (!try p.atKind(.right_bracket, .operand)) {
            while (true) {
                var spread: ?Tok = null;
                if (try p.atKind(.ellipsis, .operand)) spread = try p.next(.operand);
                const e = try p.nested(expr);
                depth = @max(depth, e.depth);
                try items.append(p.a, .{ .spread = spread, .value = e });
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        _ = try p.expect(.right_bracket, .operator);
        const e = try p.mk(open, .{ .list = try p.list(ast.ListItem, &items) }, &.{});
        e.depth = depth + 1;
        if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[open].start);
        return e;
    }

    /// A word other than `offer`, or a text, followed by `:`.
    fn mapKey(p: *Parser) Error!Tok {
        const t = try p.peek(.operand);
        if ((t.kind == .text or (t.kind == .word and !p.isWord(t, "offer"))) and (try p.peek2("map-key", .operator)).kind == .colon) {
            const key = try p.next(.operand);
            _ = try p.next(.operator);
            return key;
        }
        return p.failAt(t);
    }

    fn mapLiteral(p: *Parser) Error!*Expr {
        const open = try p.next(.operand);
        var entries: std.ArrayList(ast.MapEntry) = .empty;
        var depth: u16 = 0;
        if (!try p.atKind(.right_brace, .operand)) {
            while (true) {
                const key = try p.mapKey();
                const e = try p.nested(expr);
                depth = @max(depth, e.depth);
                try entries.append(p.a, .{ .key = key, .value = e });
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        _ = try p.expect(.right_brace, .operator);
        const e = try p.mk(open, .{ .map = try p.list(ast.MapEntry, &entries) }, &.{});
        e.depth = depth + 1;
        if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[open].start);
        return e;
    }

    // ------------------------------------------------------------ Destructuring

    fn pattern(p: *Parser) Error!*Pattern {
        const t = try p.peek(.operand);
        try p.enter(t.start);
        defer p.leave();
        const pat = try p.patternPrimary();
        if (try p.atWord("as", .operator)) {
            _ = try p.next(.operator);
            pat.bind_as = try p.name(.operand);
        }
        return pat;
    }

    fn newPattern(p: *Parser, first: Tok, data: @FieldType(Pattern, "data")) Allocator.Error!*Pattern {
        return p.create(Pattern, .{ .first = first, .bind_as = null, .data = data });
    }

    fn patternPrimary(p: *Parser) Error!*Pattern {
        const t = try p.peek(.operand);
        switch (t.kind) {
            .left_bracket => {
                const open = try p.next(.operand);
                var items: std.ArrayList(ast.ListPatternItem) = .empty;
                if (!try p.atKind(.right_bracket, .operand)) {
                    while (true) {
                        if (try p.atKind(.ellipsis, .operand)) {
                            const e = try p.next(.operand);
                            const n: ?Tok = if (p.isName(try p.peek(.operand))) try p.next(.operand) else null;
                            try items.append(p.a, .{ .rest = .{ .ellipsis = e, .name = n } });
                        } else try items.append(p.a, .{ .pattern = try p.pattern() });
                        if (!try p.atKind(.comma, .operator)) break;
                        _ = try p.next(.operator);
                    }
                }
                _ = try p.expect(.right_bracket, .operator);
                return p.newPattern(open, .{ .list = try p.list(ast.ListPatternItem, &items) });
            },
            .left_brace => {
                const open = try p.next(.operand);
                var entries: std.ArrayList(ast.MapPatternEntry) = .empty;
                if (!try p.atKind(.right_brace, .operand)) {
                    while (true) {
                        const k = try p.peek(.operand);
                        if (k.kind == .word and (try p.peek2("map-key", .operator)).kind != .colon) {
                            try entries.append(p.a, .{ .key = try p.name(.operand), .pattern = null });
                        } else {
                            const key = try p.mapKey();
                            try entries.append(p.a, .{ .key = key, .pattern = try p.pattern() });
                        }
                        if (!try p.atKind(.comma, .operator)) break;
                        _ = try p.next(.operator);
                    }
                }
                _ = try p.expect(.right_brace, .operator);
                return p.newPattern(open, .{ .map = try p.list(ast.MapPatternEntry, &entries) });
            },
            .pattern_open => {
                const tp = try p.textPattern();
                return p.newPattern(tp.open, .{ .text = tp });
            },
            .binary_open => {
                const open = try p.next(.operand);
                return p.newPattern(open, .{ .binary = try p.binaryPattern() });
            },
            .caret => {
                const caret = try p.next(.operand);
                return p.newPattern(caret, .{ .pin = try p.name(.operand) });
            },
            .text => {
                const v = try p.next(.operand);
                return p.newPattern(v, .{ .literal = .{ .minus = null, .value = v, .unit = null } });
            },
            .minus, .number => {
                var minus: ?Tok = null;
                if (t.kind == .minus) minus = try p.next(.operand);
                if (!try p.atKind(.number, .operand)) return p.fail(.operand);
                const v = try p.next(.operand);
                const u = try p.peek(.unit);
                const unit: ?Tok = if (u.kind == .unit or u.kind == .invalid) try p.next(.unit) else null;
                return p.newPattern(minus orelse v, .{ .literal = .{ .minus = minus, .value = v, .unit = unit } });
            },
            .word => {
                if (p.isWord(t, "true") or p.isWord(t, "false") or p.isWord(t, "nothing")) {
                    const v = try p.next(.operand);
                    return p.newPattern(v, .{ .literal = .{ .minus = null, .value = v, .unit = null } });
                }
                if (p.isWord(t, "_")) {
                    const v = try p.next(.operand);
                    return p.newPattern(v, .wildcard);
                }
                if (p.isName(t)) {
                    const v = try p.next(.operand);
                    return p.newPattern(v, .{ .name = v });
                }
            },
            else => {},
        }
        return p.failAt(t);
    }

    // ------------------------------------------------------------ Text Patterns

    fn textPattern(p: *Parser) Error!*ast.TextPattern {
        const open = try p.next(.operand);
        return p.textPatternAfter(open);
    }

    fn textPatternAfter(p: *Parser, open: Tok) Error!*ast.TextPattern {
        var elements: std.ArrayList(*ast.PatternElement) = .empty;
        if ((try p.peek(.pattern)).kind != .pattern_close) {
            try elements.append(p.a, try p.alternation());
            while (try p.atKind(.comma, .pattern)) {
                _ = try p.next(.pattern);
                try elements.append(p.a, try p.alternation());
            }
        }
        const close = try p.expect(.pattern_close, .pattern);
        return p.create(ast.TextPattern, .{ .open = open, .elements = try p.list(*ast.PatternElement, &elements), .close = close });
    }

    fn element(p: *Parser, first: Tok, data: @FieldType(ast.PatternElement, "data")) Allocator.Error!*ast.PatternElement {
        return p.create(ast.PatternElement, .{ .first = first, .data = data });
    }

    fn alternation(p: *Parser) Error!*ast.PatternElement {
        const l = try p.modified();
        if (!try p.atWord("or", .pattern)) return l;
        var items: std.ArrayList(*ast.PatternElement) = .empty;
        try items.append(p.a, l);
        while (try p.atWord("or", .pattern)) {
            _ = try p.next(.pattern);
            try items.append(p.a, try p.modified());
        }
        return p.element(l.first, .{ .alternation = try p.list(*ast.PatternElement, &items) });
    }

    fn modified(p: *Parser) Error!*ast.PatternElement {
        var e = try p.atom();
        while (true) {
            const t = try p.peek(.pattern);
            if (p.isWord(t, "as")) {
                const keyword = try p.next(.pattern);
                e = try p.element(e.first, .{ .modified = .{ .atom = e, .modifier = .{ .as = .{ .keyword = keyword, .kind = try p.kind(.pattern) } } } });
            } else if (p.isWord(t, "lazily")) {
                const keyword = try p.next(.pattern);
                e = try p.element(e.first, .{ .modified = .{ .atom = e, .modifier = .{ .lazily = keyword } } });
            } else if (try p.ignoringCase(.pattern)) |ig| {
                e = try p.element(e.first, .{ .modified = .{ .atom = e, .modifier = .{ .ignoring = ig } } });
            } else return e;
        }
    }

    fn atom(p: *Parser) Error!*ast.PatternElement {
        const t = try p.peek(.pattern);
        try p.enter(t.start);
        defer p.leave();
        switch (t.kind) {
            .text => {
                const v = try p.next(.pattern);
                return p.element(v, .{ .text = v });
            },
            .number => {
                const n = try p.next(.pattern);
                return p.element(n, .{ .count = .{ .number = n, .atom = try p.atom() } });
            },
            .pattern_open => {
                const open = try p.next(.pattern);
                return p.element(open, .{ .group = try p.textPatternAfter(open) });
            },
            .left_paren => {
                const open = try p.next(.pattern);
                const e = try p.nested(expr);
                _ = try p.expect(.right_paren, .operator);
                return p.element(open, .{ .splice = e });
            },
            .word => {},
            else => return p.failAt(t),
        }
        const n = try p.peek2("capture", .pattern);
        if (n.kind == .colon) {
            if (!p.isName(t)) return p.failAt(t);
            const capture = try p.next(.pattern);
            _ = try p.next(.pattern);
            return p.element(capture, .{ .capture = .{ .name = capture, .alternation = try p.alternation() } });
        }
        const w = p.word(t);
        inline for (grammar.text_patterns.anchors) |anchor| {
            const space = comptime std.mem.indexOfScalar(u8, anchor, ' ').?;
            if (std.mem.eql(u8, w, anchor[0..space]) and p.isWord(n, anchor[space + 1 ..])) {
                const first = try p.next(.pattern);
                const second = try p.next(.pattern);
                return p.element(first, .{ .anchor = .{ .first = first, .second = second } });
            }
        }
        if (among(w, class_cases)) {
            const case = try p.next(.pattern);
            const c = try p.peek(.pattern);
            var ok = false;
            inline for (grammar.text_patterns.classes) |class| {
                const space = comptime std.mem.indexOfScalar(u8, class, ' ').?;
                if (std.mem.eql(u8, w, class[0..space]) and p.isWord(c, class[space + 1 ..])) ok = true;
            }
            if (!ok) return p.failAt(c);
            const letters = try p.next(.pattern);
            return p.element(case, .{ .class = .{ .case = case, .letters = letters } });
        }
        if (std.mem.eql(u8, w, "one") or std.mem.eql(u8, w, "zero")) {
            const first = try p.next(.pattern);
            _ = try p.expectWord("or", .pattern);
            _ = try p.expectWord("more", .pattern);
            _ = try p.expectWord("of", .pattern);
            return p.element(first, .{ .repetition = .{ .kind = if (std.mem.eql(u8, w, "one")) .one_or_more else .zero_or_more, .atom = try p.atom() } });
        }
        if (std.mem.eql(u8, w, "optional")) {
            const first = try p.next(.pattern);
            return p.element(first, .{ .repetition = .{ .kind = .optional, .atom = try p.atom() } });
        }
        if (std.mem.eql(u8, w, "a") or std.mem.eql(u8, w, "an")) {
            const article = try p.next(.pattern);
            return p.element(article, .{ .typed = .{ .article = article, .kind = try p.kind(.pattern) } });
        }
        if (pattern_keywords.has(w)) {
            const v = try p.next(.pattern);
            return p.element(v, .{ .keyword = v });
        }
        return p.failAt(t);
    }

    // ------------------------------------------------------------ Binary Patterns

    fn binaryPattern(p: *Parser) Error![]const ast.BinaryField {
        var fields: std.ArrayList(ast.BinaryField) = .empty;
        if (!try p.atKind(.binary_close, .operator)) {
            while (true) {
                try fields.append(p.a, try p.binaryField());
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        _ = try p.expect(.binary_close, .operator);
        return p.list(ast.BinaryField, &fields);
    }

    fn binaryField(p: *Parser) Error!ast.BinaryField {
        const t = try p.peek(.operand);
        switch (t.kind) {
            .ellipsis => {
                const first = try p.next(.operand);
                const n = try p.peek(.operator);
                const rest_name: ?Tok = if (p.isName(n) and !p.isWord(n, "as")) try p.next(.operator) else null;
                return .{ .first = first, .data = .{ .rest = .{ .name = rest_name, .as_text = try p.asText() } } };
            },
            .number, .text => {
                const v = try p.next(.operand);
                return .{ .first = v, .data = .{ .literal = v } };
            },
            .word => if ((try p.peek2("binary-field", .operator)).kind == .colon) {
                if (!p.isName(t) and !p.isWord(t, "_")) return p.failAt(t);
                const n = try p.next(.operand);
                _ = try p.next(.operator);
                return .{ .first = n, .data = .{ .field = .{ .name = n, .type = try p.fieldType() } } };
            },
            else => {},
        }
        return p.failAt(t);
    }

    fn asText(p: *Parser) Error!bool {
        if (!try p.atWord("as", .operator)) return false;
        _ = try p.next(.operator);
        _ = try p.expectWord("text", .operand);
        return true;
    }

    fn fieldType(p: *Parser) Error!ast.FieldType {
        const t = try p.peek(.operand);
        if (t.kind == .word and integer_types.has(p.word(t))) {
            const n = try p.next(.operand);
            const o = try p.peek(.operator);
            const order: ?Tok = if (o.kind == .word and byte_orders.has(p.word(o))) try p.next(.operator) else null;
            return .{ .integer = .{ .name = n, .order = order } };
        }
        var size: ast.Size = undefined;
        if (t.kind == .number) {
            size = .{ .number = try p.next(.operand) };
        } else if (t.kind == .caret) {
            _ = try p.next(.operand);
            size = .{ .pin = try p.name(.operand) };
        } else if (t.kind == .left_paren) {
            _ = try p.next(.operand);
            p.size += 1;
            const e = p.expr();
            p.size -= 1;
            size = .{ .expr = try e };
            _ = try p.expect(.right_paren, .operator);
        } else if (p.isName(t)) {
            size = .{ .name = try p.next(.operand) };
        } else return p.failAt(t);
        const u = try p.peek(.operator);
        if (!(u.kind == .word and size_units.has(p.word(u)))) return p.failAt(u);
        const unit = try p.next(.operator);
        return .{ .sized = .{ .size = size, .unit = unit, .as_text = try p.asText() } };
    }

    fn bytesBuild(p: *Parser) Error!*Expr {
        const open = try p.next(.operand);
        var fields: std.ArrayList(ast.BuildField) = .empty;
        var depth: u16 = 0;
        if (!try p.atKind(.binary_close, .operand)) {
            while (true) {
                const first_index: Tok = @intCast(p.tokens.items.len);
                p.build += 1;
                const value = p.concat();
                p.build -= 1;
                const v = try value;
                depth = @max(depth, v.depth);
                var ty: ?ast.FieldType = null;
                if (try p.atWord("as", .operator)) {
                    _ = try p.next(.operator);
                    ty = try p.fieldType();
                }
                try fields.append(p.a, .{ .first = firstToken(p, first_index), .value = v, .type = ty });
                if (!try p.atKind(.comma, .operator)) break;
                _ = try p.next(.operator);
            }
        }
        _ = try p.expect(.binary_close, .operator);
        const e = try p.mk(open, .{ .build = try p.list(ast.BuildField, &fields) }, &.{});
        e.depth = depth + 1;
        if (e.depth > max_depth) return p.failCode(.source_nesting_too_deep, p.tokens.items[open].start);
        return e;
    }

    /// The first token consumed at or after index `from`, skipping line
    /// breaks.
    fn firstToken(p: *Parser, from: Tok) Tok {
        var i = from;
        while (i < p.tokens.items.len and p.tokens.items[i].kind == .newline) i += 1;
        return i;
    }
};

// ---------------------------------------------------------------- tests

const testing = std.testing;

const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    result: Result,

    fn deinit(self: *Parsed) void {
        self.arena.deinit();
    }
};

fn parseForTest(source: []const u8) !Parsed {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    errdefer arena.deinit();
    const result = try parse(arena.allocator(), source);
    return .{ .arena = arena, .result = result };
}

/// `parses`, or the first error as `<code> at <line>:<col>`.
fn outcome(a: Allocator, source: []const u8) ![]const u8 {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const result = try parse(arena.allocator(), source);
    switch (result) {
        .tree => |tree| {
            // The tree is lossless.
            var out: std.Io.Writer.Allocating = .init(a);
            defer out.deinit();
            try tree.reconstruct(&out.writer);
            try testing.expectEqualStrings(source, out.written());
            var last: usize = 0;
            for (tree.tokens) |t| {
                try testing.expect(t.start >= last);
                last = t.end;
            }
            return a.dupe(u8, "parses");
        },
        .failure => |d| {
            var lines: lexer.Lines = try .init(a, source);
            defer lines.deinit(a);
            const pos = lines.position(d.offset);
            return std.fmt.allocPrint(a, "{s} at {d}:{d}", .{ d.code.spelling(), pos.line, pos.column });
        },
    }
}

fn expectOutcome(source: []const u8, expected: []const u8) !void {
    const got = try outcome(testing.allocator, source);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(expected, got);
}

test "declarations and statements parse losslessly" {
    try expectOutcome(
        \\use pad, trim from text
        \\use sum from list as total
        \\script variable visits = 0
        \\constant welcome = "Hello" -- a comment
        \\
        \\function tax amount, rate = 0.2
        \\  return amount * rate
        \\end tax
        \\on handle {type: "invoice", amount: a} as inv where a > 1000
        \\  send review with inv to approvals
        \\end handle
        \\on move piece to square where square is not "e1", queued
        \\  put square into the location of piece
        \\  move knight to "e4" and wait
        \\  send to board: move knight to "e4"
        \\  wait for move p to sq or 30 s
        \\end move
    , "parses");
}

test "expressions and operands" {
    try expectOutcome(
        \\on t
        \\  put word 2 of line 3 of report into w
        \\  put characters 2..4 of w into mid
        \\  put the last word of s into tail
        \\  put the length of the words of s into count
        \\  put person's age into a
        \\  put the "full name" of person into fn
        \\  put item 2 of "a;b;c" delimited by ";" into b
        \\  put [...fruit, "plums"] into more
        \\  put every match of <digits> in "a1 b22" into hits
        \\  put 9.81 m/s^2 into g
        \\  put x as m/s into v
        \\  if x is not a number and y is at least 3 ignoring case then say "no"
        \\  put `a ${1 + `b ${2}`} c` into t
        \\  put every item of xs whose amount > 1 into big
        \\  put map(xs, given r: r * 2, 2) into ys
        \\  put << 0x02, id as uint32, x as int16, b as (n) bytes >> into packet
        \\  put [1, 2,
        \\       3] into listed
        \\  put "Total: " &
        \\      42 into label
        \\end t
    , "parses");
}

test "blocks" {
    try expectOutcome(
        \\on t
        \\  if the length of fruit > 3 then say "lots" else say "a few"
        \\  repeat for each [k, v] in pairs collecting k into ks
        \\    if v is empty then next repeat
        \\    say k
        \\  end repeat
        \\  match msg
        \\    when <"ID-", num: 4 digits as number> then put num into id
        \\    when contains <"WARN"> then tell log to write msg
        \\    else put nothing into id
        \\  end match
        \\  wait for all
        \\    repeat for each s in stations
        \\      send allReadings with s to me and wait
        \\    end repeat
        \\  end wait
        \\  try
        \\    throw "x"
        \\  offer skip
        \\    put 1 into x
        \\  catch {code: c} before unwind where c is "x"
        \\    choose offer skip
        \\  finally
        \\    say "done"
        \\  end try
        \\  tell http
        \\    put url, {json: order} and wait
        \\  end tell
        \\  with timeout of 5 s
        \\    wait for reply
        \\  end timeout
        \\  wait for
        \\    when click from okButton then say "ok"
        \\    after 30 s then say "late"
        \\  end wait
        \\  put given x
        \\    return x
        \\  end into f
        \\end t
        \\on any message m
        \\  pass any message
        \\end any message
    , "parses");
}

test "first syntax errors" {
    try expectOutcome("on t\n  put 5 into\nend t\n", "unexpected token at 2:13");
    try expectOutcome("on t\n  put 1 into 3\nend t\n", "not a container at 2:14");
    try expectOutcome("on t\n  put a = b = c into x\nend t\n", "unexpected token at 2:13");
    try expectOutcome("script ?\n", "unexpected token at 1:1");
    try expectOutcome("on t\n  put \"abc into x\nend t\n", "unterminated text at 2:7");
    try expectOutcome("constant x = `${}`\n", "empty interpolation at 1:15");
    try expectOutcome("constant x = `${1 2}`\n", "unexpected token at 1:19");
    try expectOutcome("put 1 into x\n", "unexpected token at 1:1");
    try expectOutcome("on t\n  put 5 s^-1 into x\nend t\n", "bad unit at 2:9");
}

test "a Container never passes through a Built-in property" {
    const statements = [_][2][]const u8{
        .{ "put 1 into ", "" },
        .{ "put 1 before ", "" },
        .{ "put 1 after ", "" },
        .{ "put ...[1] after ", "" },
        .{ "set ", " to 1" },
        .{ "add 1 to ", "" },
        .{ "subtract 1 from ", "" },
        .{ "multiply ", " by 2" },
        .{ "divide ", " by 2" },
        .{ "delete ", "" },
        .{ "replace \"a\" in ", " with \"b\"" },
    };
    var buf: [128]u8 = undefined;
    var want: [64]u8 = undefined;
    for (grammar.properties) |property| for (statements) |s| {
        const source = try std.fmt.bufPrint(&buf, "on t x\n  {s}the {s} of x{s}\nend t\n", .{ s[0], property, s[1] });
        try expectOutcome(source, try std.fmt.bufPrint(&want, "not a container at 2:{d}", .{3 + s[0].len}));
    };
    // Intermediate, possessive, parenthesized, multiple and delimited levels.
    for ([_][]const u8{
        "item 1 of the items of x",
        "x's length",
        "(the length of x)",
        "the length of the items of x",
        "the items of x delimited by \",\"",
        "the foo of item 1 of the items of x",
    }) |target| {
        try expectOutcome(try std.fmt.bufPrint(&buf, "on t x\n  set {s} to 1\nend t\n", .{target}), "not a container at 2:7");
    }
    // Keys, and property reads that select the target or give the value.
    for ([_][]const u8{
        "put 1 into the \"length\" of x",
        "put 1 into the (\"length\") of x",
        "put 1 into the (the length of x) of x",
        "put 1 into item (the length of x) of x",
        "put 1 into item 1 of x delimited by (the length of x)",
        "put the length of x into x",
        "set the \"length\" of x to 1",
        "set the (\"length\") of x to 1",
        "put 1 into (the \"length\" of x)",
        "put 1 into item 1 of (x)",
    }) |statement| {
        try expectOutcome(try std.fmt.bufPrint(&buf, "on t x\n  {s}\nend t\n", .{statement}), "parses");
    }
    // The syntax error comes before the root's `can't write` and the value's
    // `unknown name`.
    try expectOutcome("constant x = 1\non t\n  put missing into the length of x\nend t\n", "not a container at 3:20");
}

test "deep nesting is a load error, not a stack overflow" {
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(testing.allocator);
    try source.appendSlice(testing.allocator, "constant x = ");
    for (0..100_000) |_| try source.append(testing.allocator, '(');
    try expectOutcome(source.items, "source nesting too deep at 1:78");
    source.clearRetainingCapacity();
    try source.appendSlice(testing.allocator, "constant x = 1");
    for (0..100_000) |_| try source.appendSlice(testing.allocator, " + 1");
    const got = try outcome(testing.allocator, source.items);
    defer testing.allocator.free(got);
    try testing.expect(std.mem.startsWith(u8, got, "source nesting too deep"));
}

test "the broken cases' first errors" {
    const broken = std.Io.Dir.cwd().readFileAlloc(testing.io, "../../tools/grammar/broken.talk", testing.allocator, .unlimited) catch |e| {
        std.debug.print("../../tools/grammar/broken.talk: {s}\n", .{@errorName(e)});
        return e;
    };
    defer testing.allocator.free(broken);
    var cases: usize = 0;
    var failures: usize = 0;
    var it = std.mem.splitSequence(u8, broken, "-- case: ");
    _ = it.next();
    while (it.next()) |chunk| {
        const title_end = std.mem.indexOfScalar(u8, chunk, '\n').?;
        const rest = chunk[title_end + 1 ..];
        const expect_prefix = "-- expect: ";
        if (!std.mem.startsWith(u8, rest, expect_prefix)) continue;
        const expect_end = std.mem.indexOfScalar(u8, rest, '\n').?;
        const expected = rest[expect_prefix.len..expect_end];
        const source = rest[expect_end + 1 ..];
        cases += 1;
        const got = try outcome(testing.allocator, source);
        defer testing.allocator.free(got);
        if (!std.mem.eql(u8, got, expected)) {
            failures += 1;
            std.debug.print("case {s}: expected {s}, got {s}\n", .{ chunk[0..title_end], expected, got });
        }
    }
    try testing.expect(cases > 50);
    try testing.expectEqual(@as(usize, 0), failures);
}

test "every corpus source parses losslessly, or fails as its case expects" {
    const gpa = testing.allocator;
    const io = testing.io;
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(gpa);
    defer walker.deinit();
    var files: usize = 0;
    var failures: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.endsWith(u8, entry.basename, ".talk")) {
        files += 1;
        const source = try dir.readFileAlloc(io, entry.path, gpa, .unlimited);
        defer gpa.free(source);
        const got = try outcome(gpa, source);
        defer gpa.free(got);
        if (std.mem.eql(u8, got, "parses")) continue;
        // A syntax error is its case's: `diag <script> code="…" pos=L:C`.
        const at = std.mem.lastIndexOf(u8, got, " at ").?;
        const trace_path = try std.fmt.allocPrint(gpa, "{s}/case.trace", .{std.fs.path.dirname(entry.path).?});
        defer gpa.free(trace_path);
        const trace = dir.readFileAlloc(io, trace_path, gpa, .unlimited) catch "";
        defer if (trace.len > 0) gpa.free(trace);
        const line = try std.fmt.allocPrint(gpa, "diag {s} code=\"{s}\" pos={s}\n", .{ entry.basename[0 .. entry.basename.len - 5], got[0..at], got[at + 4 ..] });
        defer gpa.free(line);
        if (std.mem.indexOf(u8, trace, line) == null) {
            std.debug.print("{s}: {s}\n", .{ entry.path, got });
            failures += 1;
        }
    };
    try testing.expect(files > 100);
    try testing.expectEqual(@as(usize, 0), failures);
}

//! The checker: chapter 2's load-time diagnostics over a parsed unit, and the
//! name resolution and locals the lowering reads. Each rule is stated in the
//! chapter that owns it; `diagnostics.toml` gives its code and position.
//! Every diagnostic is reported, ordered by position and then by the order of
//! the codes in the catalogue.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ast = @import("../syntax/ast.zig");
const lexer = @import("../syntax/lexer.zig");
const catalogue = @import("../generated/diagnostics.zig").diagnostics;
const stdlib = @import("../generated/stdlib.zig").stdlib;
const grammar = @import("../generated/grammar.zig").grammar;
const unicode = @import("../unicode/unicode.zig");
const Tok = ast.Tok;
const Expr = ast.Expr;
const Pattern = ast.Pattern;
const Stmt = ast.Stmt;

/// The load-time diagnostics, in `diagnostics.toml`'s order.
pub const Code = enum {
    unknown_name,
    not_a_value,
    name_clash,
    duplicate_name,
    duplicate_offer,
    not_in_recovery,
    leaves_recovery_catch,
    duplicate_key,
    unknown_kind,
    no_conversion,
    bad_number,
    pattern_too_large,
    wrong_argument_count,
    wrong_argument,
    unknown_operation,
    wrong_mode,
    missing_and_wait,
    needless_and_wait,
    cant_suspend_here,
    unknown_import,
    import_cycle,
    missing_grant,
    not_in_a_library,
    not_in_a_script,
    not_in_a_lambda,
    not_in_a_guard,
    not_in_a_whose,
    not_in_a_join,
    empty_join,
    not_in_a_timeout,
    empty_timeout,
    leaves_finally,
    outside_a_loop,
    veto_outside_a_decision,
    after_a_suspension,
    wrong_message,
    bad_suffixes,
    cant_write,
    not_a_property,
    not_constant,
    default_order,
    initialiser_failed,
    nothing_to_fold,
    no_item_chunk,
    capture_in_repetition,
    rest_not_last,
    bits_not_whole_bytes,

    pub fn spelling(self: Code) []const u8 {
        return catalogue.diagnostic[@backingInt(self)].code;
    }
};

comptime {
    @setEvalBranchQuota(100_000);
    if (catalogue.diagnostic.len != std.enums.values(Code).len) @compileError("diagnostics.toml and Code differ");
    for (catalogue.diagnostic, std.enums.values(Code)) |d, c| {
        var name: [d.code.len]u8 = undefined;
        var n: usize = 0;
        for (d.code) |ch| switch (ch) {
            '\'' => {},
            ' ' => {
                name[n] = '_';
                n += 1;
            },
            else => {
                name[n] = ch;
                n += 1;
            },
        };
        if (!std.mem.eql(u8, name[0..n], @tagName(c))) @compileError("diagnostics.toml order differs at " ++ d.code);
    }
}

pub const Diagnostic = struct { code: Code, offset: usize };

/// What the Host and the Group tell the loader.
pub const Context = struct {
    /// Checking a Library rather than a Script.
    library: bool = false,
    /// The well-known objects the Host binds.
    objects: []const Object = &.{},
    /// The Script's Grants. Null when the checker isn't told them, as in a
    /// syntax-only check: then Capability calls aren't checked.
    grants: ?[]const Grant = null,
    /// The Libraries the Group holds, besides the stdlib's.
    libraries: []const Library = &.{},
    /// The Object Kind of the object the Script owns, which `me` is.
    owner: ?[]const u8 = null,
    /// Whether `key` of an Object Kind can be set; null when it isn't known.
    writable: ?Writable = null,
    /// For a Script's extension: the names the Script already has, which
    /// resolve as its own Script Variables or as imports (chapter 8, Code
    /// units).
    inherited: []const Inherited = &.{},
};

/// A name an extension inherits: a Script Variable, or a Constant, function
/// or Handler linked from the code unit `unit` that declares it, `@<unit>`,
/// or from the Library a `use` line imported it from.
pub const Inherited = struct {
    /// The name the Script uses.
    name: []const u8,
    variable: bool = false,
    unit: []const u8 = "",
    /// What the unit exports it as: its own name there, kind and arity.
    export_: Export = .{ .name = "", .kind = .function },
};

pub const Writable = struct {
    context: *const anyopaque,
    call: *const fn (context: *const anyopaque, kind: []const u8, key: []const u8) ?bool,
};

pub const Object = struct { name: []const u8, kind: []const u8 };

pub const Mode = enum { immediate, suspending, fire_and_forget };

pub const Operation = struct {
    name: []const u8,
    mode: Mode,
    required: usize,
    total: usize,
    /// Whether the argument at an index takes a literal; null when the
    /// Shapes aren't known.
    accepts: ?Accepts = null,
};

/// A literal argument, as the loader sees it: its kind, a Quantity's Unit,
/// or a map's keys.
pub const Literal = union(enum) {
    number,
    text,
    boolean,
    nothing,
    quantity: []const u8,
    list,
    map: []const []const u8,
};

pub const Accepts = struct {
    context: *const anyopaque,
    call: *const fn (context: *const anyopaque, index: usize, literal: Literal) bool,
};

pub const Grant = struct { name: []const u8, operations: []const Operation };

pub const Export = struct {
    name: []const u8,
    kind: enum { function, constant, handler },
    /// For a function: its parameters without defaults, and all of them.
    required: usize = 0,
    total: usize = 0,
    may_suspend: bool = false,
};

pub const Library = struct { name: []const u8, exports: []const Export };

/// What a Name refers to (chapter 4, Resolving a name).
pub const Ref = union(enum) {
    /// A local of the body, its parameters included.
    local,
    /// A local of an enclosing body, captured by a Lambda.
    captured,
    variable: u32,
    /// The unit's own Constant, by declaration.
    constant: u32,
    /// A name imported by a `use` line, by declaration.
    imported: u32,
    /// The unit's own function, by declaration.
    function: u32,
    /// A Handler of the unit, by its first clause's declaration.
    handler: u32,
    object: u32,
    builtin_constant: u32,
    builtin_function: u32,
    /// A Script, as a `send`'s receiver or a `wait for`'s `from`.
    script,
};

pub const BodyKind = enum { init, function, handler, fallback, lambda };

pub const Body = struct {
    kind: BodyKind,
    /// The declaration, or for a Lambda its expression.
    declaration: ?u32,
    lambda: ?*const Expr,
    /// The body's locals other than its parameters, in the order their first
    /// binding sites appear.
    locals: []const []const u8,
    /// Each local's first binding site, parallel to `locals`.
    binding: []const Tok = &.{},
    /// A Lambda's captures, in the order its code first names them.
    captures: []const []const u8,
    may_suspend: bool,
};

/// A Capability call a unit makes, for a Library's `needs` (chapter 7,
/// Grants and `needs`): the Grant name as written, the Operation, its form
/// and its arguments.
pub const Need = struct {
    grant: []const u8,
    operation: []const u8,
    ask: bool,
    line: bool,
    waits: bool,
    args: usize,
    literals: []const ?Literal,
};

/// What a Script's Grants make of one of its Libraries' calls, as the
/// checker would of the Script's own: null when it is fine.
pub fn needProblem(n: Need, grants: []const Grant) ?Code {
    const g = for (grants) |g| {
        if (std.mem.eql(u8, g.name, n.grant)) break g;
    } else return .missing_grant;
    const o = for (g.operations) |o| {
        if (std.mem.eql(u8, o.name, n.operation)) break o;
    } else return .missing_grant;
    if (n.args < o.required or n.args > o.total) return .wrong_argument_count;
    if (o.accepts) |accepts| for (n.literals, 0..) |lit, i| {
        const l = lit orelse continue;
        if (!accepts.call(accepts.context, i, l)) return .wrong_argument;
    };
    const ok = if (n.line)
        n.waits == (o.mode == .suspending)
    else if (n.ask)
        (o.mode == .immediate and !n.waits) or (o.mode == .suspending and n.waits)
    else
        o.mode == .fire_and_forget;
    return if (ok) null else .wrong_mode;
}

pub const Result = struct {
    diagnostics: []const Diagnostic,
    /// Every Capability call, in source order.
    needs: []const Need = &.{},
    /// Every Name operand, call name and Container root, by token.
    refs: std.AutoHashMapUnmanaged(Tok, Ref),
    bodies: []const Body,
    /// Whether each Handler selector may suspend.
    suspends: std.StringHashMapUnmanaged(bool),
};

/// Checks a parsed unit. Everything is allocated in `arena`.
pub fn check(arena: Allocator, tree: *const ast.Tree, context: Context) Allocator.Error!Result {
    var c: Checker = .{ .a = arena, .tree = tree, .context = context };
    try c.run();
    std.mem.sort(Diagnostic, c.diagnostics.items, {}, struct {
        fn less(_: void, x: Diagnostic, y: Diagnostic) bool {
            if (x.offset != y.offset) return x.offset < y.offset;
            return @backingInt(x.code) < @backingInt(y.code);
        }
    }.less);
    // One per construct: the same code at the same position once.
    var out: std.ArrayList(Diagnostic) = .empty;
    for (c.diagnostics.items) |d| {
        if (out.items.len > 0 and out.items[out.items.len - 1].code == d.code and out.items[out.items.len - 1].offset == d.offset) continue;
        try out.append(arena, d);
    }
    return .{ .diagnostics = out.items, .needs = c.needs.items, .refs = c.refs, .bodies = c.bodies.items, .suspends = c.suspends };
}

/// What a checked Library exports: every top-level definition that isn't
/// `private`, with each function's arity and whether each Handler may
/// suspend.
pub fn exports(arena: Allocator, tree: *const ast.Tree, result: *const Result) Allocator.Error![]const Export {
    var out: std.ArrayList(Export) = .empty;
    for (tree.declarations) |d| {
        if (d.private != null) continue;
        switch (d.data) {
            .function => |f| {
                var required: usize = 0;
                for (f.params) |p| {
                    if (p.default == null) required += 1;
                }
                try out.append(arena, .{ .name = tree.text(f.name), .kind = .function, .required = required, .total = f.params.len });
            },
            .constant => |k| try out.append(arena, .{ .name = tree.text(k.name), .kind = .constant }),
            .handler => |h| {
                if (h.fallback) continue;
                const name = tree.text(h.name);
                var may_suspend = false;
                var it = result.suspends.iterator();
                while (it.next()) |e| {
                    const sel = e.key_ptr.*;
                    const word = sel[0 .. std.mem.indexOfScalar(u8, sel, ':') orelse sel.len];
                    if (std.mem.eql(u8, word, name) and e.value_ptr.*) may_suspend = true;
                }
                for (out.items) |*x| {
                    if (x.kind == .handler and std.mem.eql(u8, x.name, name)) break;
                } else try out.append(arena, .{ .name = name, .kind = .handler, .may_suspend = may_suspend });
            },
            else => {},
        }
    }
    return out.items;
}

// ---------------------------------------------------------------- word lists

const kind_names = [_][]const u8{ "nothing", "boolean", "number", "quantity", "text", "bytes", "list", "map", "range", "instant", "pattern", "function", "object" };
const convertible = [_][]const u8{ "text", "number", "bytes", "instant" };

fn among(word: []const u8, list: []const []const u8) bool {
    for (list) |w| if (std.mem.eql(u8, w, word)) return true;
    return false;
}

fn builtin(name: []const u8) ?struct { index: u32, constant: bool } {
    for (stdlib.builtin, 0..) |b, i| {
        if (std.mem.eql(u8, b.name, name)) return .{ .index = @intCast(i), .constant = std.mem.eql(u8, b.group, "constants") };
    }
    return null;
}

/// A stdlib or Group Library's exports, with each stdlib function's arity
/// read from its `call` in stdlib.toml.
pub fn libraryExport(context: Context, library: []const u8, name: []const u8) ?Export {
    for (context.libraries) |l| {
        if (!std.mem.eql(u8, l.name, library)) continue;
        for (l.exports) |e| if (std.mem.eql(u8, e.name, name)) return e;
        return null;
    }
    for (stdlib.@"export") |e| {
        if (!std.mem.eql(u8, e.library, library) or !std.mem.eql(u8, e.name, name)) continue;
        const open = std.mem.indexOfScalar(u8, e.call, '(') orelse return .{ .name = name, .kind = .constant };
        const params = e.call[open + 1 .. std.mem.lastIndexOfScalar(u8, e.call, ')').?];
        var required: usize = 0;
        var total: usize = 0;
        if (std.mem.trim(u8, params, " ").len > 0) {
            var it = std.mem.splitScalar(u8, params, ',');
            while (it.next()) |param| {
                total += 1;
                if (std.mem.indexOfScalar(u8, param, '=') == null) required += 1;
            }
        }
        return .{ .name = name, .kind = .function, .required = required, .total = total };
    }
    return null;
}

pub fn hasLibrary(context: Context, library: []const u8) bool {
    for (context.libraries) |l| if (std.mem.eql(u8, l.name, library)) return true;
    return among(library, stdlib.libraries);
}

// ---------------------------------------------------------------- the checker

const Function = struct { decl: u32, required: usize, total: usize };

const Handler = struct {
    /// The first clause's declaration.
    decl: u32,
    clauses: std.ArrayList(u32) = .empty,
    may_suspend: bool = false,
    /// Reached by a local Command Call or a function-style call.
    called: bool = false,
};

const Import = struct { decl: u32, name: Tok, export_: ?Export };

/// What a body records for the suspension analysis.
const Site = struct {
    kind: enum {
        /// `wait`, `wait for`, `send … and wait`, `ask … and wait`, a Join's
        /// end, `f(x) and wait`.
        intrinsic,
        /// A Command Call to a Handler of the unit: a Suspension Point when
        /// that Handler may suspend.
        command,
        /// A function-style call: never one, but an error when its callee
        /// may suspend.
        function_style,
    },
    token: Tok,
    /// For calls: the callee's selector.
    target: []const u8 = "",
    waits: bool = false,
    /// Inside a `finally` block or a Recovery Catch.
    forbidden: bool = false,
};

const Scope = struct {
    kind: BodyKind,
    parent: ?*Scope,
    /// Locals by name: parameters and binding sites.
    locals: std.StringHashMapUnmanaged(void) = .empty,
    order: std.ArrayList([]const u8) = .empty,
    order_tokens: std.ArrayList(Tok) = .empty,
    /// The names a binding site in this body binds through a pattern, as
    /// opposed to a Container root: a Lambda's own locals.
    captures: std.ArrayList([]const u8) = .empty,
    sites: std.ArrayList(Site) = .empty,
    /// The handler's selector, for a Handler body.
    selector: []const u8 = "",
    handler: ?*const ast.Handler = null,
    body: u32 = 0,
};

/// Where a statement sits, for the context rules.
const Where = struct {
    loops: u32 = 0,
    /// The loop count where an enclosing `finally` block, Recovery Catch or
    /// Join starts, if any.
    finally: ?u32 = null,
    recovery: ?u32 = null,
    choose: bool = false,
    join: ?u32 = null,
    join_try: bool = false,
    timeout: bool = false,
    collecting: []const []const u8 = &.{},
};

/// What an expression sits in, for the expression rules.
const In = enum { normal, guard, whose, initialiser };

const Checker = struct {
    a: Allocator,
    tree: *const ast.Tree,
    context: Context,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    needs: std.ArrayList(Need) = .empty,
    refs: std.AutoHashMapUnmanaged(Tok, Ref) = .empty,
    bodies: std.ArrayList(Body) = .empty,
    suspends: std.StringHashMapUnmanaged(bool) = .empty,

    variables: std.StringHashMapUnmanaged(u32) = .empty,
    constants: std.StringHashMapUnmanaged(u32) = .empty,
    functions: std.StringHashMapUnmanaged(Function) = .empty,
    handlers: std.StringArrayHashMapUnmanaged(Handler) = .empty,
    /// Handler names, the first word of each selector.
    handler_names: std.StringHashMapUnmanaged(u32) = .empty,
    imports: std.StringHashMapUnmanaged(Import) = .empty,
    /// In an initialiser: the Constants declared so far.
    constants_above: u32 = 0,
    /// The first offending token of the initialiser being checked.
    not_constant: ?Tok = null,
    scopes: std.ArrayList(*Scope) = .empty,
    /// Join Members counted while a Join's body is checked.
    members: usize = 0,
    /// Each function's body, by name.
    function_scopes: std.StringHashMapUnmanaged(*Scope) = .empty,

    fn report(c: *Checker, code: Code, t: Tok) Allocator.Error!void {
        try c.diagnostics.append(c.a, .{ .code = code, .offset = c.tree.tokens[t].start });
    }

    fn text(c: *Checker, t: Tok) []const u8 {
        return c.tree.text(t);
    }

    fn start(c: *Checker, t: Tok) usize {
        return c.tree.tokens[t].start;
    }

    fn selector(c: *Checker, name: Tok, labels: []const Tok) Allocator.Error![]const u8 {
        if (labels.len == 0) return c.text(name);
        var out: std.ArrayList(u8) = .empty;
        try out.appendSlice(c.a, c.text(name));
        try out.append(c.a, ':');
        for (labels) |l| {
            try out.appendSlice(c.a, c.text(l));
            try out.append(c.a, ':');
        }
        return out.items;
    }

    /// A text literal token's value, before NFC.
    fn literalText(c: *Checker, t: Tok) []const u8 {
        const tok = c.tree.tokens[t];
        const s = c.tree.text(t);
        if (s[0] == '"' and !std.mem.startsWith(u8, s, "\"\"\"")) return s[1 .. s.len - 1];
        return c.tree.shared.fenced.get(tok.start).?.pieces[0];
    }

    // ------------------------------------------------------------ unit level

    fn run(c: *Checker) Allocator.Error!void {
        const decls = c.tree.declarations;
        // An extension's inherited names come first: its Script Variables
        // number on from the Script's.
        for (c.context.inherited) |x| {
            if (x.variable) {
                try c.variables.put(c.a, x.name, @intCast(c.variables.count()));
            } else try c.imports.put(c.a, x.name, .{ .decl = std.math.maxInt(u32), .name = 0, .export_ = x.export_ });
        }
        // The unit's names, and their clashes.
        for (decls, 0..) |*d, i| {
            const index: u32 = @intCast(i);
            if (d.private) |p| if (!c.context.library) try c.report(.not_in_a_script, p);
            switch (d.data) {
                .script_variable => |v| {
                    if (c.context.library) try c.report(.not_in_a_library, v.keyword);
                    try c.variables.put(c.a, c.text(v.name), @intCast(c.variables.count()));
                },
                .constant => |k| try c.constants.put(c.a, c.text(k.name), index),
                .function => |f| {
                    var required: usize = 0;
                    var seen_default = false;
                    for (f.params) |p| {
                        if (p.default != null) seen_default = true else {
                            required += 1;
                            if (seen_default) try c.report(.default_order, p.name);
                        }
                    }
                    try c.functions.put(c.a, c.text(f.name), .{ .decl = index, .required = required, .total = f.params.len });
                },
                .handler => |h| {
                    if (h.fallback and c.context.library) try c.report(.not_in_a_library, h.on);
                    const sel = if (h.fallback) "any message" else try c.selector(h.name, h.labels);
                    const entry = try c.handlers.getOrPut(c.a, sel);
                    if (!entry.found_existing) entry.value_ptr.* = .{ .decl = index };
                    try entry.value_ptr.clauses.append(c.a, index);
                    if (!h.fallback) {
                        const n = try c.handler_names.getOrPut(c.a, c.text(h.name));
                        if (!n.found_existing) n.value_ptr.* = index;
                    }
                },
                .use => |u| {
                    const library = c.text(u.library);
                    const known = hasLibrary(c.context, library);
                    if (!known) try c.report(.unknown_import, u.library);
                    for (u.names) |n| {
                        const name = c.text(n);
                        const ex = if (known) libraryExport(c.context, library, name) else null;
                        // A name the Library doesn't export binds nothing, so
                        // its uses are unknown names.
                        if (known and ex == null) {
                            try c.report(.unknown_import, n);
                            continue;
                        }
                        const local = if (u.rename) |r| r else n;
                        const entry = try c.imports.getOrPut(c.a, c.text(local));
                        if (entry.found_existing) {
                            try c.report(.name_clash, local);
                        } else entry.value_ptr.* = .{ .decl = index, .name = local, .export_ = ex };
                    }
                },
            }
        }
        try c.unitClashes();
        // The initialiser: each Script Variable's and Constant's value and
        // each parameter default, in source order.
        const init = try c.newScope(.init, null);
        init.body = try c.addBody(.init, null, null);
        for (decls, 0..) |*d, i| {
            switch (d.data) {
                .script_variable => |v| if (v.value) |e| try c.initialiser(init, e, @intCast(i)),
                .constant => |k| try c.initialiser(init, k.value, @intCast(i)),
                else => {},
            }
        }
        for (decls, 0..) |*d, i| {
            if (d.data == .function) for (d.data.function.params) |p| if (p.default) |e| try c.initialiser(init, e, @intCast(i));
        }
        try c.finishBody(init);
        // Each function and Handler Clause.
        for (decls, 0..) |*d, i| {
            switch (d.data) {
                .function => |*f| try c.function(f, @intCast(i)),
                .handler => |*h| try c.handlerClause(h, @intCast(i)),
                else => {},
            }
        }
        try c.suspension();
    }

    fn unitClashes(c: *Checker) Allocator.Error!void {
        for (c.tree.declarations) |d| switch (d.data) {
            // A Script Variable named like a function or an Import: at the
            // later of the two.
            .script_variable => |v| {
                const name = c.text(v.name);
                if (c.functions.get(name)) |f| try c.report(.name_clash, later(v.name, c.tree.declarations[f.decl].data.function.name));
                if (c.imports.get(name)) |im| try c.report(.name_clash, later(v.name, im.name));
            },
            else => {},
        };
        // An imported name named like a local Handler, function, Constant,
        // Script Variable or well-known object: at its name in the `use` line.
        var it = c.imports.iterator();
        while (it.next()) |e| {
            const name = e.key_ptr.*;
            if (c.functions.contains(name) or c.constants.contains(name) or c.variables.contains(name) or c.handler_names.contains(name) or c.objectIndex(name) != null) {
                try c.report(.name_clash, e.value_ptr.name);
            }
        }
    }

    fn later(x: Tok, y: Tok) Tok {
        return @max(x, y);
    }

    fn objectIndex(c: *Checker, name: []const u8) ?u32 {
        for (c.context.objects, 0..) |o, i| if (std.mem.eql(u8, o.name, name)) return @intCast(i);
        return null;
    }

    fn newScope(c: *Checker, kind: BodyKind, parent: ?*Scope) Allocator.Error!*Scope {
        const s = try c.a.create(Scope);
        s.* = .{ .kind = kind, .parent = parent };
        return s;
    }

    fn addBody(c: *Checker, kind: BodyKind, decl: ?u32, made_by: ?*const Expr) Allocator.Error!u32 {
        try c.bodies.append(c.a, .{ .kind = kind, .declaration = decl, .lambda = made_by, .locals = &.{}, .captures = &.{}, .may_suspend = false });
        return @intCast(c.bodies.items.len - 1);
    }

    fn finishBody(c: *Checker, s: *Scope) Allocator.Error!void {
        const b = &c.bodies.items[s.body];
        b.locals = s.order.items;
        b.binding = s.order_tokens.items;
        b.captures = s.captures.items;
        try c.scopes.append(c.a, s);
    }

    fn initialiser(c: *Checker, s: *Scope, e: *const Expr, decl: u32) Allocator.Error!void {
        c.constants_above = decl;
        c.not_constant = null;
        try c.expr(s, e, .initialiser);
        if (c.not_constant) |t| try c.report(.not_constant, t);
    }

    fn function(c: *Checker, f: *const ast.Function, decl: u32) Allocator.Error!void {
        const s = try c.newScope(.function, null);
        s.body = try c.addBody(.function, decl, null);
        for (f.params) |p| try c.param(s, p.name);
        try c.collectBlock(s, f.body);
        try c.block(s, f.body, .{});
        try c.finishBody(s);
        try c.function_scopes.put(c.a, c.text(f.name), s);
    }

    fn handlerClause(c: *Checker, h: *const ast.Handler, decl: u32) Allocator.Error!void {
        const s = try c.newScope(if (h.fallback) .fallback else .handler, null);
        s.body = try c.addBody(s.kind, decl, null);
        s.handler = h;
        s.selector = if (h.fallback) "any message" else try c.selector(h.name, h.labels);
        try c.suffixes(h);
        for (h.params) |p| try c.collectPattern(s, p, true);
        // `, during msg` binds the message that failed.
        if (h.during) |d| {
            try c.bind(s, d, true);
            try c.refs.put(c.a, d, .local);
        }
        if (h.guard) |g| try c.collectExpr(s, g.condition);
        try c.collectBlock(s, h.body);
        if (h.finally) |f| try c.collectBlock(s, f.body);
        for (h.params) |p| try c.pattern(s, p);
        if (h.guard) |g| try c.expr(s, g.condition, .guard);
        try c.block(s, h.body, .{});
        if (h.finally) |f| try c.block(s, f.body, .{ .finally = 0 });
        try c.finishBody(s);
    }

    fn suffixes(c: *Checker, h: *const ast.Handler) Allocator.Error!void {
        var policy: ?[]const u8 = null;
        var seen: std.ArrayList([]const u8) = .empty;
        var decides = false;
        var queued = false;
        for (h.suffixes) |t| {
            const w = c.text(t);
            var bad = among(w, seen.items);
            if (among(w, &.{ "queued", "dropping", "replacing" })) {
                if (policy != null and !bad) bad = true;
                policy = w;
            }
            if (std.mem.eql(u8, w, "queued")) {
                if (decides) bad = true;
                queued = true;
            }
            if (std.mem.eql(u8, w, "deciding")) {
                if (queued or h.fallback) bad = true;
                decides = true;
            }
            if (std.mem.eql(u8, w, "during") and (h.fallback or !std.mem.eql(u8, c.text(h.name), "error") or h.labels.len > 0)) bad = true;
            try seen.append(c.a, w);
            if (bad) {
                try c.report(.bad_suffixes, t);
                return;
            }
        }
    }

    fn deciding(c: *Checker, h: *const ast.Handler) bool {
        for (h.suffixes) |t| if (std.mem.eql(u8, c.text(t), "deciding")) return true;
        return false;
    }

    // ------------------------------------------------------------ locals

    fn param(c: *Checker, s: *Scope, t: Tok) Allocator.Error!void {
        try c.bind(s, t, true);
    }

    /// Records a binding site. Patterns' names clash with Script Variables,
    /// Constants and well-known objects; every variable clashes with a
    /// function or an Import.
    fn bind(c: *Checker, s: *Scope, t: Tok, pattern_name: bool) Allocator.Error!void {
        const name = c.text(t);
        if (pattern_name) {
            if (c.variables.contains(name) or c.constants.contains(name) or c.objectIndex(name) != null) {
                try c.report(.name_clash, c.laterThanDeclaration(t, name));
            }
        }
        if (c.functions.get(name)) |f| try c.report(.name_clash, later(t, c.tree.declarations[f.decl].data.function.name));
        if (c.imports.get(name)) |im| try c.report(.name_clash, later(t, im.name));
        const entry = try s.locals.getOrPut(c.a, name);
        if (!entry.found_existing) {
            try s.order.append(c.a, name);
            try s.order_tokens.append(c.a, t);
        }
    }

    fn laterThanDeclaration(c: *Checker, t: Tok, name: []const u8) Tok {
        for (c.tree.declarations) |d| switch (d.data) {
            .script_variable => |v| if (std.mem.eql(u8, c.text(v.name), name)) return later(t, v.name),
            .constant => |k| if (std.mem.eql(u8, c.text(k.name), name)) return later(t, k.name),
            else => {},
        };
        return t;
    }

    /// Whether a Container root binds a new local here: it isn't a Script
    /// Variable, a Constant, or a local of an enclosing body.
    fn rootBinds(c: *Checker, s: *Scope, name: []const u8) bool {
        if (s.locals.contains(name)) return false;
        var p = s.parent;
        while (p) |scope| : (p = scope.parent) if (scope.locals.contains(name)) return false;
        return !c.variables.contains(name) and !c.constants.contains(name);
    }

    /// Collects a body's binding sites, in source order, without entering
    /// Lambdas.
    fn collectBlock(c: *Checker, s: *Scope, b: ast.Block) Allocator.Error!void {
        for (b) |st| try c.collectStmt(s, st);
    }

    fn collectRoot(c: *Checker, s: *Scope, target: *const Expr) Allocator.Error!void {
        var e = target;
        while (true) e = switch (e.data) {
            .chunk => |ch| ch.of,
            .key => |k| k.base,
            .group => |g| g,
            .name => |t| {
                if (c.rootBinds(s, c.text(t))) try c.bind(s, t, false);
                return;
            },
            else => return,
        };
    }

    fn collectStmt(c: *Checker, s: *Scope, st: *const Stmt) Allocator.Error!void {
        switch (st.data) {
            .put => |p| {
                try c.collectExpr(s, p.value);
                try c.collectRoot(s, p.target);
            },
            .let => |l| {
                try c.collectExpr(s, l.value);
                try c.collectPattern(s, l.pattern, true);
            },
            .set => |set| try c.collectExpr(s, set.value),
            .arithmetic => |ar| {
                try c.collectExpr(s, ar.value);
                try c.collectRoot(s, ar.target);
            },
            .send => |snd| {
                if (snd.computed) |e| try c.collectExpr(s, e);
                for (snd.args) |arg| try c.collectExpr(s, arg.value);
                try c.collectExpr(s, snd.target);
            },
            .ask, .tell => |op| try c.collectExprs(s, op.args),
            .tell_block => |tb| for (tb.lines) |line| try c.collectExprs(s, line.args),
            .@"return", .veto => |v| if (v) |e| try c.collectExpr(s, e),
            .throw, .wait => |e| try c.collectExpr(s, e),
            .choose => |ch| try c.collectExprs(s, ch.args),
            .call => |cs| try c.collectExpr(s, cs.call),
            .command => |cmd| try c.collectExprs(s, cmd.args),
            .delete => |e| try c.collectRoot(s, e),
            .replace => |r| {
                try c.collectCaptures(s, r.pattern);
                try c.collectRoot(s, r.target);
            },
            .wait_for => |w| for (w.event.patterns) |p| try c.collectPattern(s, p, true),
            .wait_block => |w| for (w.branches) |br| {
                switch (br.data) {
                    .when => |wh| for (wh.event.patterns) |p| try c.collectPattern(s, p, true),
                    .after => {},
                }
                try c.collectBlock(s, br.body);
            },
            .join => |j| try c.collectBlock(s, j.body),
            .@"if" => |f| {
                for (f.arms) |arm| {
                    try c.collectExpr(s, arm.condition);
                    try c.collectBlock(s, arm.body);
                }
                if (f.@"else") |b| try c.collectBlock(s, b);
            },
            .repeat => |r| {
                switch (r.head) {
                    .for_each => |fe| {
                        try c.collectExpr(s, fe.source);
                        try c.collectPattern(s, fe.pattern, true);
                    },
                    .@"while", .until, .times => |e| try c.collectExpr(s, e),
                    .forever => {},
                }
                if (r.collecting) |col| {
                    try c.bind(s, col.into, true);
                    try c.collectExpr(s, col.value);
                }
                try c.collectBlock(s, r.body);
            },
            .match => |m| {
                try c.collectExpr(s, m.subject);
                for (m.branches) |br| {
                    try c.collectPattern(s, br.pattern, true);
                    try c.collectBlock(s, br.body);
                }
                if (m.@"else") |b| try c.collectBlock(s, b);
            },
            .@"try" => |t| {
                try c.collectBlock(s, t.body);
                for (t.offers) |o| {
                    for (o.params) |p| try c.bind(s, p, true);
                    try c.collectBlock(s, o.body);
                }
                for (t.catches) |k| {
                    try c.collectPattern(s, k.pattern, true);
                    try c.collectBlock(s, k.body);
                }
                if (t.finally) |f| try c.collectBlock(s, f.body);
            },
            .timeout => |t| {
                try c.collectExpr(s, t.duration);
                try c.collectBlock(s, t.body);
            },
            else => {},
        }
    }

    /// The binding sites inside an expression: the Captures a `replace`
    /// expression writes. Lambdas bind in their own bodies.
    fn collectExpr(c: *Checker, s: *Scope, e: *const Expr) Allocator.Error!void {
        switch (e.data) {
            .replace => |r| {
                try c.collectExpr(s, r.pattern);
                try c.collectExpr(s, r.target);
                try c.collectCaptures(s, r.pattern);
                try c.collectExpr(s, r.value);
            },
            .lambda, .number, .quantity, .text, .word, .target, .name, .whose_key, .pin, .text_pattern => {},
            .template => |t| for (t.holes) |h| try c.collectExpr(s, h),
            .group, .not, .negate => |x| try c.collectExpr(s, x),
            .binary => |b| {
                try c.collectExpr(s, b.left);
                try c.collectExpr(s, b.right);
            },
            .is_kind => |k| try c.collectExpr(s, k.value),
            .is_empty => |k| try c.collectExpr(s, k.value),
            .can_be => |k| try c.collectExpr(s, k.value),
            .conversion => |k| try c.collectExpr(s, k.value),
            inline .key, .optional_key => |k| {
                if (k.computed) |x| try c.collectExpr(s, x);
                try c.collectExpr(s, k.base);
            },
            .property => |p| {
                try c.collectExpr(s, p.base);
                if (p.delimiter) |d| try c.collectExpr(s, d);
            },
            .chunk => |ch| {
                if (ch.index) |i| try c.collectExpr(s, i);
                try c.collectExpr(s, ch.of);
                if (ch.delimiter) |d| try c.collectExpr(s, d);
            },
            .whose => |w| {
                if (w.ordinal) |o| try c.collectExpr(s, o) else try c.collectExpr(s, w.source);
                if (w.ordinal == null) if (w.delimiter) |d| try c.collectExpr(s, d);
                try c.collectExpr(s, w.condition);
            },
            .list => |items| for (items) |i| try c.collectExpr(s, i.value),
            .map => |entries| for (entries) |m| try c.collectExpr(s, m.value),
            .build => |fields| for (fields) |f| try c.collectExpr(s, f.value),
            .match_search => |m| {
                try c.collectExpr(s, m.pattern);
                try c.collectExpr(s, m.source);
            },
            .call => |call| for (call.args) |x| try c.collectExpr(s, x),
        }
    }

    fn collectExprs(c: *Checker, s: *Scope, es: []const *Expr) Allocator.Error!void {
        for (es) |e| try c.collectExpr(s, e);
    }

    /// The Captures a `replace` writes, when its pattern is a literal.
    fn collectCaptures(c: *Checker, s: *Scope, e: *const Expr) Allocator.Error!void {
        if (e.data != .text_pattern) return;
        for (e.data.text_pattern.elements) |el| try c.collectElement(s, el);
    }

    fn collectPattern(c: *Checker, s: *Scope, p: *const Pattern, _: bool) Allocator.Error!void {
        switch (p.data) {
            .name => |t| try c.bind(s, t, true),
            .list => |items| for (items) |item| switch (item) {
                .pattern => |q| try c.collectPattern(s, q, true),
                .rest => |r| if (r.name) |n| try c.bind(s, n, true),
            },
            .map => |entries| for (entries) |e| {
                if (e.pattern) |q| try c.collectPattern(s, q, true) else try c.bind(s, e.key, true);
            },
            .text => |tp| for (tp.elements) |el| try c.collectElement(s, el),
            .binary => |fields| for (fields) |f| switch (f.data) {
                .rest => |r| if (r.name) |n| try c.bind(s, n, true),
                .field => |fl| if (!std.mem.eql(u8, c.text(fl.name), "_")) try c.bind(s, fl.name, true),
                .literal => {},
            },
            else => {},
        }
        if (p.bind_as) |n| try c.bind(s, n, true);
    }

    fn collectElement(c: *Checker, s: *Scope, el: *const ast.PatternElement) Allocator.Error!void {
        switch (el.data) {
            .capture => |cap| {
                try c.bind(s, cap.name, true);
                try c.collectElement(s, cap.alternation);
            },
            .count => |n| try c.collectElement(s, n.atom),
            .group => |g| for (g.elements) |e| try c.collectElement(s, e),
            .repetition => |r| try c.collectElement(s, r.atom),
            .alternation => |items| for (items) |e| try c.collectElement(s, e),
            .modified => |m| try c.collectElement(s, m.atom),
            else => {},
        }
    }

    // ------------------------------------------------------------ resolution

    fn resolve(c: *Checker, s: *Scope, t: Tok) Allocator.Error!?Ref {
        const name = c.text(t);
        if (s.locals.contains(name)) return .local;
        var p = s.parent;
        while (p) |scope| : (p = scope.parent) {
            if (scope.locals.contains(name)) {
                try c.capture(s, name);
                return .captured;
            }
        }
        if (c.variables.get(name)) |v| return .{ .variable = v };
        if (c.constants.get(name)) |k| return .{ .constant = k };
        if (c.imports.get(name)) |im| return .{ .imported = im.decl };
        if (c.functions.get(name)) |f| return .{ .function = f.decl };
        if (c.handler_names.get(name)) |h| return .{ .handler = h };
        if (c.objectIndex(name)) |o| return .{ .object = o };
        if (builtin(name)) |b| return if (b.constant) .{ .builtin_constant = b.index } else .{ .builtin_function = b.index };
        return null;
    }

    /// Records a capture in this Lambda and every Lambda between it and the
    /// body that owns the local.
    fn capture(c: *Checker, s: *Scope, name: []const u8) Allocator.Error!void {
        var scope: ?*Scope = s;
        while (scope) |sc| : (scope = sc.parent) {
            if (sc.locals.contains(name)) return;
            if (!among(name, sc.captures.items)) try sc.captures.append(c.a, name);
        }
    }

    // ------------------------------------------------------------ statements

    fn block(c: *Checker, s: *Scope, b: ast.Block, w: Where) Allocator.Error!void {
        for (b) |st| try c.stmt(s, st, w);
    }

    fn site(c: *Checker, s: *Scope, kind: @FieldType(Site, "kind"), t: Tok, target: []const u8, waits: bool, w: Where) Allocator.Error!void {
        try s.sites.append(c.a, .{ .kind = kind, .token = t, .target = target, .waits = waits, .forbidden = w.finally != null or w.recovery != null });
    }

    /// `wait`, `wait for`, a Join, and every other written wait: refused in a
    /// Join's body, where the Join's end is the only Suspension Point.
    fn intrinsic(c: *Checker, s: *Scope, t: Tok, w: Where) Allocator.Error!void {
        try c.site(s, .intrinsic, t, "", true, w);
    }

    fn stmt(c: *Checker, s: *Scope, st: *const Stmt, w: Where) Allocator.Error!void {
        const first = st.first;
        switch (st.data) {
            .put => |p| {
                try c.expr(s, p.value, .normal);
                try c.container(s, p.target, w);
            },
            .let => |l| {
                try c.expr(s, l.value, .normal);
                try c.pattern(s, l.pattern);
                try c.collectingBinds(s, l.pattern, w);
            },
            .set => |set| {
                try c.setTarget(s, first, set.target);
                try c.expr(s, set.value, .normal);
            },
            .arithmetic => |ar| {
                try c.expr(s, ar.value, .normal);
                try c.container(s, ar.target, w);
            },
            .delete => |e| try c.container(s, e, w),
            .send => |snd| {
                if (c.context.library) try c.report(.not_in_a_library, first);
                if (snd.computed) |e| try c.expr(s, e, .normal);
                for (snd.args) |arg| try c.expr(s, arg.value, .normal);
                try c.receiver(s, snd.target);
                if (snd.wait != null) try c.member(s, first, w);
            },
            .ask => |op| {
                if (op.target) |t| try c.grantTarget(s, t);
                for (op.args) |arg| try c.expr(s, arg, .normal);
                try c.capability(first, op, true, false);
                if (op.wait != null) try c.member(s, first, w);
            },
            .tell => |op| {
                if (op.target) |t| try c.grantTarget(s, t);
                for (op.args) |arg| try c.expr(s, arg, .normal);
                try c.capability(first, op, false, false);
            },
            .tell_block => |tb| {
                try c.grantTarget(s, tb.target);
                for (tb.lines) |line| {
                    for (line.args) |arg| try c.expr(s, arg, .normal);
                    var op = line;
                    op.target = tb.target;
                    try c.capability(line.operation, op, false, true);
                    if (line.wait != null and c.lineSuspends(op)) try c.member(s, line.operation, w);
                }
            },
            .@"return", .veto => |value| {
                if (value) |e| try c.expr(s, e, .normal);
                try c.leaving(first, w);
                if (st.data == .veto) {
                    if (c.context.library) try c.report(.not_in_a_library, first);
                    try c.vetoAllowed(s, first);
                }
            },
            .pass => |p| {
                if (c.context.library) try c.report(.not_in_a_library, first);
                if (s.kind == .lambda) try c.report(.not_in_a_lambda, first);
                try c.leaving(first, w);
                try c.passName(s, p);
            },
            .exit_repeat, .next_repeat => {
                if (w.loops == 0) {
                    try c.report(.outside_a_loop, first);
                } else {
                    if (w.finally) |base| if (base >= w.loops) try c.report(.leaves_finally, first);
                    if (w.recovery) |base| if (base >= w.loops) try c.report(.leaves_recovery_catch, first);
                    if (w.join) |base| if (base >= w.loops) try c.report(.not_in_a_join, first);
                }
            },
            .throw => |e| try c.expr(s, e, .normal),
            .replace => |r| {
                try c.expr(s, r.pattern, .normal);
                try c.container(s, r.target, w);
                try c.expr(s, r.value, .normal);
            },
            .choose => |ch| {
                if (!w.choose) try c.report(.not_in_recovery, first);
                for (ch.args) |arg| try c.expr(s, arg, .normal);
            },
            .call => |cs| {
                const call = cs.call.data.call;
                try c.callExpr(s, cs.call, .normal, cs.wait != null);
                if (cs.wait != null) {
                    try c.intrinsic(s, first, w);
                    if (w.join != null) try c.report(.not_in_a_join, first);
                    if (w.timeout) try c.report(.not_in_a_timeout, first);
                }
                _ = call;
            },
            .command => |cmd| try c.command(s, first, cmd, w),
            .wait => |e| {
                try c.expr(s, e, .normal);
                try c.intrinsic(s, first, w);
                if (w.join != null) try c.report(.not_in_a_join, first);
            },
            .wait_for => |wf| {
                if (c.context.library) try c.report(.not_in_a_library, first);
                try c.event(s, wf.event);
                if (wf.timeout) |e| try c.expr(s, e, .normal);
                try c.intrinsic(s, first, w);
                if (w.join != null) try c.report(.not_in_a_join, first);
            },
            .wait_block => |wb| {
                if (c.context.library) try c.report(.not_in_a_library, first);
                if (w.join != null) try c.report(.not_in_a_join, first);
                try c.intrinsic(s, first, w);
                for (wb.branches) |br| {
                    switch (br.data) {
                        .when => |wh| {
                            try c.event(s, wh.event);
                            if (wh.guard) |g| try c.expr(s, g.condition, .guard);
                        },
                        .after => |e| try c.expr(s, e, .normal),
                    }
                    try c.block(s, br.body, w);
                }
            },
            .join => |j| {
                if (w.join != null) try c.report(.not_in_a_join, first);
                try c.intrinsic(s, first, w);
                var inner = w;
                inner.join = w.loops;
                inner.join_try = false;
                const before = c.members;
                c.members = 0;
                try c.block(s, j.body, inner);
                if (c.members == 0) try c.report(.empty_join, first);
                c.members = before + c.members;
            },
            .@"if" => |f| {
                for (f.arms) |arm| {
                    try c.expr(s, arm.condition, .normal);
                    try c.block(s, arm.body, w);
                }
                if (f.@"else") |b| try c.block(s, b, w);
            },
            .repeat => |r| {
                switch (r.head) {
                    .for_each => |fe| {
                        try c.expr(s, fe.source, .normal);
                        try c.pattern(s, fe.pattern);
                        try c.collectingBinds(s, fe.pattern, w);
                    },
                    .@"while", .until, .times => |e| try c.expr(s, e, .normal),
                    .forever => {},
                }
                var inner = w;
                inner.loops += 1;
                if (r.collecting) |col| {
                    // The target is written by the loop alone.
                    if (among(c.text(col.into), w.collecting)) try c.report(.cant_write, col.into);
                    if (r.head == .for_each and c.patternBinds(r.head.for_each.pattern, c.text(col.into))) try c.report(.name_clash, col.into);
                    var names: std.ArrayList([]const u8) = .empty;
                    try names.appendSlice(c.a, w.collecting);
                    try names.append(c.a, c.text(col.into));
                    inner.collecting = names.items;
                    try c.refs.put(c.a, col.into, .local);
                    try c.block(s, r.body, inner);
                    try c.expr(s, col.value, .normal);
                } else try c.block(s, r.body, inner);
            },
            .match => |m| {
                try c.expr(s, m.subject, .normal);
                for (m.branches) |br| {
                    try c.pattern(s, br.pattern);
                    try c.collectingBinds(s, br.pattern, w);
                    if (br.guard) |g| try c.expr(s, g.condition, .guard);
                    try c.block(s, br.body, w);
                }
                if (m.@"else") |b| try c.block(s, b, w);
            },
            .@"try" => |t| {
                var inner = w;
                if (w.join != null) inner.join_try = true;
                try c.block(s, t.body, inner);
                var offers: std.ArrayList([]const u8) = .empty;
                for (t.offers) |o| {
                    if (among(c.text(o.name), offers.items)) try c.report(.duplicate_offer, o.name);
                    try offers.append(c.a, c.text(o.name));
                    var params: std.ArrayList([]const u8) = .empty;
                    for (o.params) |p| {
                        if (among(c.text(p), params.items)) try c.report(.duplicate_name, p);
                        try params.append(c.a, c.text(p));
                        try c.refs.put(c.a, p, .local);
                    }
                    try c.block(s, o.body, inner);
                }
                for (t.catches) |k| {
                    try c.pattern(s, k.pattern);
                    try c.collectingBinds(s, k.pattern, w);
                    if (k.guard) |g| try c.expr(s, g.condition, .guard);
                    var body_where = inner;
                    if (k.recovery != null) {
                        body_where.recovery = w.loops;
                        body_where.choose = true;
                    }
                    try c.block(s, k.body, body_where);
                }
                if (t.finally) |f| {
                    var fw = w;
                    fw.finally = w.loops;
                    try c.block(s, f.body, fw);
                }
            },
            .timeout => |t| {
                try c.expr(s, t.duration, .normal);
                var inner = w;
                inner.timeout = true;
                const sites = s.sites.items.len;
                try c.block(s, t.body, inner);
                var any = false;
                for (s.sites.items[sites..]) |x| {
                    if (x.kind == .intrinsic or (x.kind == .command and x.waits)) any = true;
                }
                if (!any or w.join != null) try c.report(.empty_timeout, first);
            },
        }
    }

    /// An `ask … and wait` or `send … and wait`: a Join Member inside a
    /// Join's body, and a Suspension Point outside one.
    fn member(c: *Checker, s: *Scope, t: Tok, w: Where) Allocator.Error!void {
        if (w.join != null) {
            c.members += 1;
            if (w.join_try) try c.report(.not_in_a_join, t);
        } else try c.intrinsic(s, t, w);
    }

    /// `return`, `veto` and `pass` leave the body, so not from a `finally`
    /// block, a Recovery Catch or a Join.
    fn leaving(c: *Checker, t: Tok, w: Where) Allocator.Error!void {
        if (w.finally != null) try c.report(.leaves_finally, t);
        if (w.recovery != null) try c.report(.leaves_recovery_catch, t);
        if (w.join != null) try c.report(.not_in_a_join, t);
    }

    fn vetoAllowed(c: *Checker, s: *Scope, t: Tok) Allocator.Error!void {
        const ok = s.kind == .handler and s.handler != null and c.deciding(s.handler.?);
        if (!ok) try c.report(.veto_outside_a_decision, t);
    }

    fn passName(c: *Checker, s: *Scope, p: ast.Pass) Allocator.Error!void {
        if (s.kind == .lambda) return;
        if (p.any) {
            if (s.kind != .fallback) try c.report(.wrong_message, p.name);
            return;
        }
        if (s.kind != .handler) return c.report(.wrong_message, p.name);
        const sel = try c.selector(p.name, p.labels);
        if (!std.mem.eql(u8, sel, s.selector)) try c.report(.wrong_message, p.name);
    }

    fn command(c: *Checker, s: *Scope, first: Tok, cmd: ast.Command, w: Where) Allocator.Error!void {
        for (cmd.args) |arg| try c.expr(s, arg, .normal);
        const sel = try c.selector(cmd.name, cmd.labels);
        const waits = cmd.wait != null;
        if (waits) {
            if (w.join != null) try c.report(.not_in_a_join, first);
            if (w.timeout) try c.report(.not_in_a_timeout, first);
        }
        if (c.handlers.getPtr(sel)) |h| {
            h.called = true;
            try c.site(s, .command, cmd.name, sel, waits, w);
            return;
        }
        if (c.importedHandler(c.text(cmd.name))) |ex| {
            if (ex.may_suspend and !waits) try c.report(.missing_and_wait, cmd.name);
            if (!ex.may_suspend and waits) try c.report(.needless_and_wait, cmd.name);
            if (ex.may_suspend) try c.intrinsic(s, first, w);
            return;
        }
        if (std.mem.eql(u8, sel, "say")) {
            // `say x` is `tell console to write x`.
            try c.needs.append(c.a, .{ .grant = "console", .operation = "write", .ask = false, .line = false, .waits = waits, .args = cmd.args.len, .literals = &.{} });
            if (c.context.grants != null) {
                const console = c.grant("console");
                const write = if (console) |g| for (g.operations) |o| {
                    if (std.mem.eql(u8, o.name, "write")) break true;
                } else false else false;
                if (!write) try c.report(.unknown_operation, cmd.name);
            }
            if (cmd.args.len != 1) try c.report(.wrong_argument_count, cmd.name);
            if (waits) try c.report(.needless_and_wait, cmd.name);
            return;
        }
        // Sent up the Message Path: `send … and wait` with `and wait`.
        if (waits) try c.intrinsic(s, first, w);
    }

    fn importedHandler(c: *Checker, sel: []const u8) ?Export {
        const im = c.imports.get(sel) orelse return null;
        const ex = im.export_ orelse return null;
        return if (ex.kind == .handler) ex else null;
    }

    fn receiver(c: *Checker, s: *Scope, e: *const Expr) Allocator.Error!void {
        // A Name that resolves to nothing names a Script.
        if (e.data == .name) {
            if (try c.resolve(s, e.data.name)) |r| {
                try c.refs.put(c.a, e.data.name, r);
                try c.nameValue(e.data.name, r);
            } else try c.refs.put(c.a, e.data.name, .script);
            return;
        }
        try c.expr(s, e, .normal);
    }

    fn grantTarget(c: *Checker, s: *Scope, e: *const Expr) Allocator.Error!void {
        _ = s;
        // The name after `ask` or `tell` is a Grant, not a value, and nothing
        // else names one.
        if (e.data != .name) try c.report(.unknown_operation, e.pos);
    }

    fn grant(c: *Checker, name: []const u8) ?Grant {
        const grants = c.context.grants orelse return null;
        for (grants) |g| if (std.mem.eql(u8, g.name, name)) return g;
        return null;
    }

    fn lineSuspends(c: *Checker, op: ast.Operation) bool {
        if (op.target != null and op.target.?.data != .name) return true;
        const target = op.target orelse return true;
        if (target.data != .name) return true;
        const g = c.grant(c.text(target.data.name)) orelse return true;
        for (g.operations) |o| if (std.mem.eql(u8, o.name, c.text(op.operation))) return o.mode == .suspending;
        return true;
    }

    /// Checks a Capability call against the Grant, when the Grants are known.
    fn capability(c: *Checker, keyword: Tok, op: ast.Operation, ask: bool, line: bool) Allocator.Error!void {
        const target = op.target orelse return;
        if (target.data != .name) return;
        const literals = try c.a.alloc(?Literal, op.args.len);
        for (op.args, literals) |arg, *l| l.* = try c.literal(arg);
        var need: Need = .{ .grant = c.text(target.data.name), .operation = c.text(op.operation), .ask = ask, .line = line, .waits = op.wait != null, .args = op.args.len, .literals = literals };
        // A `tell` block's line is lowered by its declared mode, so a
        // Library's need is the form it was compiled to.
        if (line) if (c.grant(need.grant)) |g| for (g.operations) |o| if (std.mem.eql(u8, o.name, need.operation)) {
            need.line = false;
            need.ask = o.mode != .fire_and_forget;
            need.waits = o.mode == .suspending;
        };
        try c.needs.append(c.a, need);
        if (c.context.grants == null) return;
        const g = c.grant(c.text(target.data.name)) orelse return c.report(.unknown_operation, target.data.name);
        const o = for (g.operations) |o| {
            if (std.mem.eql(u8, o.name, c.text(op.operation))) break o;
        } else return c.report(.unknown_operation, op.operation);
        if (op.args.len < o.required or op.args.len > o.total) {
            try c.report(.wrong_argument_count, op.operation);
        } else if (o.accepts) |accepts| for (op.args, 0..) |arg, i| {
            const lit = try c.literal(arg) orelse continue;
            if (!accepts.call(accepts.context, i, lit)) try c.report(.wrong_argument, arg.pos);
        };
        const waits = op.wait != null;
        const ok = if (line)
            waits == (o.mode == .suspending)
        else if (ask)
            (o.mode == .immediate and !waits) or (o.mode == .suspending and waits)
        else
            o.mode == .fire_and_forget;
        if (!ok) try c.report(.wrong_mode, if (line) op.operation else keyword);
    }

    /// A literal argument's kind, or null for anything else: the loader
    /// infers nothing beyond literals.
    fn literal(c: *Checker, e: *const Expr) Allocator.Error!?Literal {
        return switch (e.data) {
            .number => .number,
            .text => .text,
            .quantity => |q| .{ .quantity = c.text(q.unit) },
            .word => |w| switch (w) {
                .true, .false => .boolean,
                .nothing => .nothing,
                else => null,
            },
            .group => |inner| c.literal(inner),
            .list => .list,
            .map => |entries| blk: {
                const keys = try c.a.alloc([]const u8, entries.len);
                for (entries, keys) |entry, *k| {
                    const tok = c.tree.tokens[entry.key];
                    k.* = try unicode.nfc(c.a, if (tok.kind == .text) c.literalText(entry.key) else c.text(entry.key));
                }
                break :blk .{ .map = keys };
            },
            else => null,
        };
    }

    fn event(c: *Checker, s: *Scope, ev: ast.Event) Allocator.Error!void {
        for (ev.patterns) |p| try c.pattern(s, p);
        if (ev.from) |e| try c.receiver(s, e);
    }

    /// A pattern in a collecting `repeat`'s body may not bind its target.
    fn collectingBinds(c: *Checker, s: *Scope, p: *const Pattern, w: Where) Allocator.Error!void {
        _ = s;
        for (w.collecting) |name| {
            if (c.patternBindsAt(p, name)) |t| try c.report(.cant_write, t);
        }
    }

    fn patternBinds(c: *Checker, p: *const Pattern, name: []const u8) bool {
        return c.patternBindsAt(p, name) != null;
    }

    fn patternBindsAt(c: *Checker, p: *const Pattern, name: []const u8) ?Tok {
        var names: std.ArrayList(Tok) = .empty;
        c.patternNames(p, &names) catch return null;
        for (names.items) |t| if (std.mem.eql(u8, c.text(t), name)) return t;
        return null;
    }

    fn patternNames(c: *Checker, p: *const Pattern, out: *std.ArrayList(Tok)) Allocator.Error!void {
        switch (p.data) {
            .name => |t| try out.append(c.a, t),
            .list => |items| for (items) |item| switch (item) {
                .pattern => |q| try c.patternNames(q, out),
                .rest => |r| if (r.name) |n| try out.append(c.a, n),
            },
            .map => |entries| for (entries) |e| {
                if (e.pattern) |q| try c.patternNames(q, out) else try out.append(c.a, e.key);
            },
            .text => |tp| for (tp.elements) |el| try c.elementNames(el, out),
            .binary => |fields| for (fields) |f| switch (f.data) {
                .rest => |r| if (r.name) |n| try out.append(c.a, n),
                .field => |fl| if (!std.mem.eql(u8, c.text(fl.name), "_")) try out.append(c.a, fl.name),
                .literal => {},
            },
            else => {},
        }
        if (p.bind_as) |n| try out.append(c.a, n);
    }

    fn elementNames(c: *Checker, el: *const ast.PatternElement, out: *std.ArrayList(Tok)) Allocator.Error!void {
        switch (el.data) {
            .capture => |cap| {
                try out.append(c.a, cap.name);
                try c.elementNames(cap.alternation, out);
            },
            .count => |n| try c.elementNames(n.atom, out),
            .group => |g| for (g.elements) |e| try c.elementNames(e, out),
            .repetition => |r| try c.elementNames(r.atom, out),
            .alternation => |items| for (items) |e| try c.elementNames(e, out),
            .modified => |m| try c.elementNames(m.atom, out),
            else => {},
        }
    }

    /// A Container: rooted in a local or a Script Variable, never a
    /// Constant, a captured local or a collecting target.
    fn container(c: *Checker, s: *Scope, target: *const Expr, w: Where) Allocator.Error!void {
        var e = target;
        while (true) {
            switch (e.data) {
                .chunk => |ch| {
                    if (ch.index) |i| try c.expr(s, i, .normal);
                    if (ch.delimiter) |d| try c.expr(s, d, .normal);
                    try c.chunkChain(e);
                    e = ch.of;
                },
                .key => |k| {
                    if (k.computed) |k2| try c.expr(s, k2, .normal);
                    e = k.base;
                },
                .group => |g| e = g,
                .name => |t| {
                    const name = c.text(t);
                    const r = try c.resolve(s, t) orelse Ref.local;
                    try c.refs.put(c.a, t, r);
                    switch (r) {
                        .constant, .imported => try c.report(.cant_write, t),
                        .captured => try c.report(.cant_write, t),
                        else => {},
                    }
                    if (among(name, w.collecting)) try c.report(.cant_write, t);
                    return;
                },
                else => return c.expr(s, e, .normal),
            }
        }
    }

    /// `set` writes a key of a Host Object: never a bare variable, and never
    /// a property the Host says is read-only.
    fn setTarget(c: *Checker, s: *Scope, keyword: Tok, target: *const Expr) Allocator.Error!void {
        var e = target;
        while (e.data == .group) e = e.data.group;
        switch (e.data) {
            .name => {
                try c.report(.not_a_property, keyword);
                try c.expr(s, target, .normal);
                return;
            },
            .key => |k| {
                try c.expr(s, target, .normal);
                const kind = c.knownKind(s, k.base) orelse return;
                const key = c.literalKey(k.key, k.computed) orelse return;
                const writable = c.context.writable orelse return;
                if (writable.call(writable.context, kind, key) != true) try c.report(.cant_write, keyword);
            },
            else => try c.expr(s, target, .normal),
        }
    }

    /// A key spelt in the source: a word, a text, or a bracketed text.
    fn literalKey(c: *Checker, key: ?Tok, computed: ?*const Expr) ?[]const u8 {
        if (key) |t| {
            const tok = c.tree.tokens[t];
            return if (tok.kind == .text) c.literalText(t) else c.text(t);
        }
        var e = computed orelse return null;
        while (e.data == .group) e = e.data.group;
        return if (e.data == .text) c.literalText(e.data.text) else null;
    }

    /// The Object Kind of a well-known object, written by name.
    fn knownKind(c: *Checker, s: *Scope, base: *const Expr) ?[]const u8 {
        var e = base;
        while (e.data == .group) e = e.data.group;
        if (e.data == .word and e.data.word == .me) return c.context.owner;
        if (e.data != .name) return null;
        const name = c.text(e.data.name);
        if (s.locals.contains(name)) return null;
        const i = c.objectIndex(name) orelse return null;
        return c.context.objects[i].kind;
    }

    /// A Host Object known at load: `me`, `the target` or a well-known name.
    fn knownObject(c: *Checker, s: *Scope, base: *const Expr) bool {
        var e = base;
        while (e.data == .group) e = e.data.group;
        return switch (e.data) {
            .word => |w| w == .me,
            .target => true,
            .name => c.knownKind(s, e) != null,
            else => false,
        };
    }

    // ------------------------------------------------------------ patterns

    fn pattern(c: *Checker, s: *Scope, p: *const Pattern) Allocator.Error!void {
        var names: std.ArrayList(Tok) = .empty;
        try c.patternNames(p, &names);
        for (names.items, 0..) |t, i| {
            try c.refs.put(c.a, t, .local);
            for (names.items[0..i]) |u| {
                if (std.mem.eql(u8, c.text(t), c.text(u))) {
                    try c.report(.duplicate_name, t);
                    break;
                }
            }
        }
        try c.patternRules(s, p);
    }

    fn patternRules(c: *Checker, s: *Scope, p: *const Pattern) Allocator.Error!void {
        switch (p.data) {
            .pin => |t| {
                if (try c.resolve(s, t)) |r| try c.refs.put(c.a, t, r) else try c.report(.unknown_name, t);
            },
            .literal => |l| {
                const tok = c.tree.tokens[l.value];
                if (tok.kind == .number) try c.number(l.value);
            },
            .list => |items| for (items, 0..) |item, i| switch (item) {
                .pattern => |q| try c.patternRules(s, q),
                .rest => |r| if (i + 1 != items.len) try c.report(.rest_not_last, r.ellipsis),
            },
            .map => |entries| for (entries) |e| if (e.pattern) |q| try c.patternRules(s, q),
            .text => |tp| try c.textPattern(s, tp),
            .binary => |fields| try c.binaryPattern(s, fields),
            else => {},
        }
    }

    fn binaryPattern(c: *Checker, s: *Scope, fields: []const ast.BinaryField) Allocator.Error!void {
        var bound: std.ArrayList([]const u8) = .empty;
        var run_first: ?Tok = null;
        var run_bits: u64 = 0;
        for (fields, 0..) |f, i| {
            var bits: ?u64 = null;
            switch (f.data) {
                .rest => if (i + 1 != fields.len) try c.report(.rest_not_last, f.first),
                .literal => |t| if (c.tree.tokens[t].kind == .number) try c.number(t),
                .field => |fl| {
                    switch (fl.type) {
                        .sized => |sz| {
                            try c.size(s, sz.size, bound.items);
                            if (std.mem.startsWith(u8, c.text(sz.unit), "bit")) bits = c.sizeBits(sz.size);
                        },
                        .integer => {},
                    }
                    if (!std.mem.eql(u8, c.text(fl.name), "_")) try bound.append(c.a, c.text(fl.name));
                },
            }
            try c.bitRun(&run_first, &run_bits, bits, f.first);
        }
        try c.bitRun(&run_first, &run_bits, null, 0);
    }

    /// Bit fields in a row must add up to whole bytes.
    fn bitRun(c: *Checker, first: *?Tok, total: *u64, bits: ?u64, t: Tok) Allocator.Error!void {
        if (bits) |b| {
            if (first.* == null) first.* = t;
            total.* +|= b;
            return;
        }
        if (first.*) |f| if (total.* % 8 != 0) try c.report(.bits_not_whole_bytes, f);
        first.* = null;
        total.* = 0;
    }

    fn sizeBits(c: *Checker, sz: ast.Size) u64 {
        return switch (sz) {
            .number => |t| std.fmt.parseInt(u64, c.text(t), 0) catch std.math.maxInt(u64),
            else => 0,
        };
    }

    fn size(c: *Checker, s: *Scope, sz: ast.Size, bound: []const []const u8) Allocator.Error!void {
        switch (sz) {
            .number => |t| try c.number(t),
            .name => |t| {
                if (!among(c.text(t), bound)) try c.report(.unknown_name, t);
                try c.refs.put(c.a, t, .local);
            },
            .pin => |t| if (try c.resolve(s, t)) |r| try c.refs.put(c.a, t, r) else try c.report(.unknown_name, t),
            .expr => |e| try c.sizeExpr(s, e, bound),
        }
    }

    /// A bracketed size: arithmetic over literals, names bound earlier in the
    /// pattern, and pins.
    fn sizeExpr(c: *Checker, s: *Scope, e: *const Expr, bound: []const []const u8) Allocator.Error!void {
        switch (e.data) {
            .name => |t| {
                if (!among(c.text(t), bound)) try c.report(.unknown_name, t);
                try c.refs.put(c.a, t, .local);
            },
            .pin => |t| if (try c.resolve(s, t)) |r| try c.refs.put(c.a, t, r) else try c.report(.unknown_name, t),
            .group => |g| try c.sizeExpr(s, g, bound),
            .binary => |b| {
                try c.sizeExpr(s, b.left, bound);
                try c.sizeExpr(s, b.right, bound);
            },
            .negate => |n| try c.sizeExpr(s, n, bound),
            else => try c.expr(s, e, .normal),
        }
    }

    // ------------------------------------------------------------ Text Patterns

    fn textPattern(c: *Checker, s: *Scope, tp: *const ast.TextPattern) Allocator.Error!void {
        var captures: std.ArrayList([]const u8) = .empty;
        for (tp.elements) |el| try c.element(s, el, false, &captures);
    }

    fn element(c: *Checker, s: *Scope, el: *const ast.PatternElement, repeated: bool, captures: *std.ArrayList([]const u8)) Allocator.Error!void {
        switch (el.data) {
            .text, .anchor, .class, .keyword => {},
            .count => |n| {
                try c.number(n.number);
                try c.element(s, n.atom, true, captures);
            },
            .group => |g| for (g.elements) |e| try c.element(s, e, repeated, captures),
            .splice => |e| try c.expr(s, e, .normal),
            .capture => |cap| {
                if (repeated) try c.report(.capture_in_repetition, cap.name);
                if (among(c.text(cap.name), captures.items)) try c.report(.duplicate_name, cap.name);
                try captures.append(c.a, c.text(cap.name));
                try c.element(s, cap.alternation, repeated, captures);
            },
            .repetition => |r| try c.element(s, r.atom, true, captures),
            .typed => |ty| if (!std.mem.eql(u8, c.text(ty.kind.name), "number") or ty.kind.civil_date) try c.report(.unknown_kind, ty.kind.name),
            .alternation => |items| for (items) |e| try c.element(s, e, repeated, captures),
            .modified => |m| {
                try c.element(s, m.atom, repeated, captures);
                switch (m.modifier) {
                    .as => |as| {
                        const k = c.text(as.kind.name);
                        if (as.kind.civil_date or !std.mem.eql(u8, k, "number")) {
                            if (as.kind.civil_date or among(k, &kind_names)) try c.report(.no_conversion, as.keyword) else try c.report(.unknown_kind, as.kind.name);
                        } else if (!c.digitsOnly(m.atom) and !isNumberElement(m.atom)) try c.report(.no_conversion, as.keyword);
                    },
                    else => {},
                }
            },
        }
    }

    fn isNumberElement(el: *const ast.PatternElement) bool {
        return el.data == .typed;
    }

    /// An element that matches nothing but one or more ASCII digits.
    fn digitsOnly(c: *Checker, el: *const ast.PatternElement) bool {
        return switch (el.data) {
            .text => |t| blk: {
                const v = c.literalText(t);
                if (v.len == 0) break :blk false;
                for (v) |ch| if (!std.ascii.isDigit(ch)) break :blk false;
                break :blk true;
            },
            .keyword => |t| std.mem.eql(u8, c.text(t), "digit") or std.mem.eql(u8, c.text(t), "digits"),
            .count => |n| !std.mem.eql(u8, std.mem.trimStart(u8, c.text(n.number), "0"), "") and c.digitsOnly(n.atom),
            .repetition => |r| r.kind == .one_or_more and c.digitsOnly(r.atom),
            .group => |g| blk: {
                if (g.elements.len == 0) break :blk false;
                for (g.elements) |e| if (!c.digitsOnly(e)) break :blk false;
                break :blk true;
            },
            .alternation => |items| blk: {
                for (items) |e| if (!c.digitsOnly(e)) break :blk false;
                break :blk true;
            },
            .modified => |m| switch (m.modifier) {
                .as => false,
                else => c.digitsOnly(m.atom),
            },
            else => false,
        };
    }

    // ------------------------------------------------------------ expressions

    /// A number literal over the limits of chapter 3.
    fn number(c: *Checker, t: Tok) Allocator.Error!void {
        const s = c.text(t);
        if (std.mem.startsWith(u8, s, "0x")) {
            const v = std.fmt.parseInt(u128, s[2..], 16) catch return c.report(.bad_number, t);
            if (v >= std.math.pow(u128, 10, 34)) try c.report(.bad_number, t);
            return;
        }
        const dot = std.mem.indexOfScalar(u8, s, '.');
        const whole = std.mem.trimStart(u8, s[0 .. dot orelse s.len], "0");
        const fraction = if (dot) |d| s[d + 1 ..] else "";
        const digits = if (whole.len > 0) whole.len + fraction.len else std.mem.trimStart(u8, fraction, "0").len;
        if (whole.len > 34 or digits > 34 or fraction.len > 6176) try c.report(.bad_number, t);
    }

    fn kindTest(c: *Checker, k: ast.Kind) Allocator.Error!void {
        if (k.civil_date) return;
        const name = c.text(k.name);
        if (among(name, &kind_names) or std.mem.eql(u8, name, "integer")) return;
        try c.report(.unknown_kind, k.name);
    }

    /// `as` or `can be`: a kind with a conversion, or a Unit.
    fn conversionKind(c: *Checker, keyword: Tok, k: ast.Kind) Allocator.Error!void {
        if (k.civil_date) return;
        const name = c.text(k.name);
        if (among(name, &convertible) or lexer.isUnitName(name)) return;
        if (among(name, &kind_names)) return c.report(.no_conversion, keyword);
        try c.report(.unknown_kind, k.name);
    }

    fn nameValue(c: *Checker, t: Tok, r: Ref) Allocator.Error!void {
        switch (r) {
            .handler, .builtin_function => try c.report(.not_a_value, t),
            .imported => |d| {
                _ = d;
                if (c.imports.get(c.text(t))) |im| if (im.export_) |ex| if (ex.kind == .handler) try c.report(.not_a_value, t);
            },
            else => {},
        }
    }

    /// In an initialiser, a Name may be only a Constant declared above it,
    /// an imported Constant, or a Built-in.
    fn constantName(c: *Checker, t: Tok, r: Ref) void {
        const ok = switch (r) {
            .constant => |d| d < c.constants_above,
            .imported => true,
            .builtin_constant, .builtin_function => true,
            else => false,
        };
        if (!ok) c.notConstant(t);
    }

    fn notConstant(c: *Checker, t: Tok) void {
        if (c.not_constant == null or t < c.not_constant.?) c.not_constant = t;
    }

    fn expr(c: *Checker, s: *Scope, e: *const Expr, in: In) Allocator.Error!void {
        switch (e.data) {
            .number => |t| try c.number(t),
            .quantity => |q| try c.number(q.number),
            .text, .target => {},
            .template => |tm| for (tm.holes) |h| try c.expr(s, h, in),
            .word => |w| {
                // Initialisers and defaults run outside a body, so `it`
                // has no local binding. Lambda bodies use `.normal`.
                if (in == .initialiser and w == .it) try c.report(.unknown_name, e.pos);
                if (in == .initialiser and (w == .it or w == .me)) c.notConstant(e.pos);
                if (w == .me and c.context.library) try c.report(.not_in_a_library, e.pos);
            },
            .name => |t| {
                if (try c.resolve(s, t)) |r| {
                    try c.refs.put(c.a, t, r);
                    try c.nameValue(t, r);
                    if (in == .initialiser) c.constantName(t, r);
                } else {
                    try c.report(.unknown_name, t);
                    if (in == .initialiser) c.notConstant(t);
                }
            },
            .whose_key => {},
            .group => |g| try c.expr(s, g, in),
            .binary => |b| {
                try c.expr(s, b.left, in);
                try c.expr(s, b.right, in);
            },
            .is_kind => |k| {
                try c.expr(s, k.value, in);
                try c.kindTest(k.kind);
                if (k.ignoring) |ig| try c.report(.nothing_to_fold, ig);
            },
            .is_empty => |k| {
                try c.expr(s, k.value, in);
                if (k.ignoring) |ig| try c.report(.nothing_to_fold, ig);
            },
            .can_be => |k| {
                try c.expr(s, k.value, in);
                try c.conversionKind(e.pos, k.kind);
                if (k.ignoring) |ig| try c.report(.nothing_to_fold, ig);
            },
            .not, .negate => |x| try c.expr(s, x, in),
            .conversion => |cv| {
                try c.expr(s, cv.value, in);
                if (cv.kind) |k| try c.conversionKind(e.pos, k);
            },
            .key => |k| {
                if (k.computed) |x| try c.expr(s, x, in);
                try c.expr(s, k.base, in);
                if (in == .guard and c.knownObject(s, k.base)) {
                    const key = c.literalKey(k.key, k.computed);
                    if (key == null or !std.mem.eql(u8, key.?, "id")) try c.report(.not_in_a_guard, e.pos);
                }
            },
            // A map-only read that never crosses to the Host, so it is no
            // Host property access, even of a known Object.
            .optional_key => |k| {
                if (k.computed) |x| try c.expr(s, x, in);
                try c.expr(s, k.base, in);
            },
            .property => |p| {
                try c.expr(s, p.base, in);
                if (p.delimiter) |d| {
                    try c.expr(s, d, in);
                    if (!std.mem.eql(u8, c.text(p.name), "items")) try c.report(.no_item_chunk, p.delimited.?);
                }
            },
            .chunk => |ch| {
                if (ch.index) |i| try c.expr(s, i, in);
                try c.expr(s, ch.of, in);
                if (ch.delimiter) |d| {
                    try c.expr(s, d, in);
                    try c.chunkChain(e);
                }
            },
            .whose => |wh| {
                if (wh.ordinal) |o| try c.expr(s, o, in) else {
                    try c.expr(s, wh.source, in);
                    if (wh.delimiter) |d| {
                        try c.expr(s, d, in);
                        if (wh.kind != .item and !c.chainHasItem(wh.source)) try c.report(.no_item_chunk, wh.delimited.?);
                    }
                }
                try c.expr(s, wh.condition, if (in == .normal) .whose else in);
            },
            .list => |items| for (items) |item| try c.expr(s, item.value, in),
            .map => |entries| {
                var keys: std.ArrayList([]const u8) = .empty;
                for (entries) |entry| {
                    const tok = c.tree.tokens[entry.key];
                    const raw = if (tok.kind == .text) c.literalText(entry.key) else c.text(entry.key);
                    const key = try unicode.nfc(c.a, raw);
                    if (among(key, keys.items)) try c.report(.duplicate_key, entry.key);
                    try keys.append(c.a, key);
                    try c.expr(s, entry.value, in);
                }
            },
            .text_pattern => |tp| try c.textPattern(s, tp),
            .build => |fields| {
                var first: ?Tok = null;
                var bits: u64 = 0;
                for (fields) |f| {
                    try c.expr(s, f.value, in);
                    var field_bits: ?u64 = null;
                    if (f.type) |ty| switch (ty) {
                        .sized => |sz| {
                            try c.buildSize(s, sz.size, in);
                            if (std.mem.startsWith(u8, c.text(sz.unit), "bit")) field_bits = c.sizeBits(sz.size);
                        },
                        .integer => {},
                    };
                    try c.bitRun(&first, &bits, field_bits, f.first);
                }
                try c.bitRun(&first, &bits, null, 0);
            },
            .match_search => |m| {
                try c.expr(s, m.pattern, in);
                try c.expr(s, m.source, in);
            },
            .replace => |r| {
                try c.expr(s, r.pattern, in);
                try c.expr(s, r.target, in);
                try c.expr(s, r.value, in);
            },
            .call => try c.callExpr(s, e, in, false),
            .lambda => |l| try c.lambda(s, e, l, in),
            .pin => |t| if (try c.resolve(s, t)) |r| try c.refs.put(c.a, t, r) else try c.report(.unknown_name, t),
        }
        if (e.data == .target) {
            if (s.kind == .lambda) try c.report(.not_in_a_lambda, e.pos);
            if (c.context.library) try c.report(.not_in_a_library, e.pos);
            if (in == .initialiser) c.notConstant(e.pos);
        }
    }

    fn buildSize(c: *Checker, s: *Scope, sz: ast.Size, in: In) Allocator.Error!void {
        switch (sz) {
            .number => |t| try c.number(t),
            .name, .pin => |t| if (try c.resolve(s, t)) |r| try c.refs.put(c.a, t, r) else try c.report(.unknown_name, t),
            .expr => |e| try c.expr(s, e, in),
        }
    }

    /// `delimited by` needs an `item` chunk somewhere in its chain.
    fn chunkChain(c: *Checker, e: *const Expr) Allocator.Error!void {
        const ch = e.data.chunk;
        const delimited = ch.delimited orelse return;
        if (!c.chainHasItem(e)) try c.report(.no_item_chunk, delimited);
    }

    fn chainHasItem(c: *Checker, e: *const Expr) bool {
        var x = e;
        while (true) switch (x.data) {
            .chunk => |ch| {
                if (ch.kind == .item) return true;
                x = ch.of;
            },
            .property => |p| return std.mem.eql(u8, c.text(p.name), "items"),
            else => return false,
        };
    }

    fn callExpr(c: *Checker, s: *Scope, e: *const Expr, in: In, waits: bool) Allocator.Error!void {
        const call = e.data.call;
        for (call.args) |arg| try c.expr(s, arg, in);
        const r = try c.resolve(s, call.name) orelse {
            try c.report(.unknown_name, call.name);
            if (in == .initialiser) c.notConstant(call.name);
            return;
        };
        try c.refs.put(c.a, call.name, r);
        const name = c.text(call.name);
        switch (r) {
            .builtin_function => {},
            .function => {
                const f = c.functions.get(name).?;
                if (call.args.len < f.required or call.args.len > f.total) try c.report(.wrong_argument_count, call.name);
                try c.site(s, .function_style, call.name, name, waits, .{});
            },
            .handler => {
                if (c.handlers.getPtr(name)) |h| h.called = true;
                try c.site(s, .function_style, call.name, name, waits, .{});
            },
            .imported => {
                const ex = c.imports.get(name).?.export_;
                if (ex) |x| {
                    if (x.kind == .function and (call.args.len < x.required or call.args.len > x.total)) try c.report(.wrong_argument_count, call.name);
                    if (x.may_suspend) try c.report(.cant_suspend_here, call.name);
                }
            },
            else => {},
        }
        switch (in) {
            .guard => if (r != .builtin_function) try c.report(.not_in_a_guard, call.name),
            .whose => if (r != .builtin_function) try c.report(.not_in_a_whose, call.name),
            .initialiser => if (r != .builtin_function) c.notConstant(call.name),
            .normal => {},
        }
    }

    fn lambda(c: *Checker, s: *Scope, e: *const Expr, l: ast.Lambda, in: In) Allocator.Error!void {
        switch (in) {
            .guard => try c.report(.not_in_a_guard, l.given),
            .whose => try c.report(.not_in_a_whose, l.given),
            // A Lambda's body isn't evaluated where it is made.
            .initialiser, .normal => {},
        }
        const inner = try c.newScope(.lambda, s);
        inner.body = try c.addBody(.lambda, null, e);
        for (l.params) |p| try c.collectPattern(inner, p, true);
        switch (l.body) {
            .block => |b| try c.collectBlock(inner, b),
            .expr => {},
        }
        for (l.params) |p| try c.pattern(inner, p);
        switch (l.body) {
            .block => |b| try c.block(inner, b, .{}),
            .expr => |x| try c.expr(inner, x, .normal),
        }
        try c.finishBody(inner);
        // A Lambda's captures are loaded where it is made.
        for (inner.captures.items) |name| {
            if (!s.locals.contains(name)) try c.capture(s, name);
        }
    }

    // ------------------------------------------------------------ suspension

    /// Which Handlers may suspend, over the call graph to a fixpoint, and the
    /// diagnostics that depend on it.
    fn suspension(c: *Checker) Allocator.Error!void {
        // A Handler may suspend when a clause holds a written Suspension
        // Point, or a Command Call to a Handler that may.
        var changed = true;
        while (changed) {
            changed = false;
            for (c.scopes.items) |s| {
                if (s.kind != .handler and s.kind != .fallback) continue;
                const h = c.handlers.getPtr(s.selector) orelse continue;
                if (h.may_suspend) continue;
                for (s.sites.items) |x| {
                    const suspends = switch (x.kind) {
                        .intrinsic => true,
                        .command => if (c.handlers.get(x.target)) |g| g.may_suspend else false,
                        .function_style => false,
                    };
                    if (suspends) {
                        h.may_suspend = true;
                        changed = true;
                        break;
                    }
                }
            }
        }
        var it = c.handlers.iterator();
        while (it.next()) |e| try c.suspends.put(c.a, e.key_ptr.*, e.value_ptr.may_suspend);
        for (c.scopes.items) |s| {
            const body = &c.bodies.items[s.body];
            for (s.sites.items) |x| {
                const suspends = switch (x.kind) {
                    .intrinsic => true,
                    .command => blk: {
                        const g = c.handlers.get(x.target).?;
                        if (g.may_suspend and !x.waits) try c.report(.missing_and_wait, x.token);
                        if (!g.may_suspend and x.waits) try c.report(.needless_and_wait, x.token);
                        break :blk g.may_suspend;
                    },
                    .function_style => blk: {
                        if (c.reaches(x.target)) try c.report(.cant_suspend_here, x.token);
                        break :blk false;
                    },
                };
                if (!suspends) continue;
                body.may_suspend = true;
                if (x.forbidden or s.kind == .function) try c.report(.cant_suspend_here, x.token);
            }
        }
        // A deciding Handler's `veto` and `pass` come before any Suspension
        // Point; a Handler reached by a local call holds no Decision.
        for (c.scopes.items) |s| {
            const h = s.handler orelse continue;
            if (s.kind != .handler or !c.deciding(h)) continue;
            if (c.handlers.get(s.selector)) |info| if (info.called) {
                try c.vetoes(h.body);
            };
            _ = try c.flow(s, h.body, false);
        }
    }

    /// Whether a function-style call to `name` can reach a Suspension Point.
    fn reaches(c: *Checker, name: []const u8) bool {
        if (c.handlers.get(name)) |h| return h.may_suspend;
        const s = c.function_scopes.get(name) orelse return false;
        for (s.sites.items) |x| switch (x.kind) {
            .intrinsic => return true,
            .command => if (c.handlers.get(x.target)) |g| if (g.may_suspend) return true,
            .function_style => {},
        };
        return false;
    }

    fn vetoes(c: *Checker, b: ast.Block) Allocator.Error!void {
        for (b) |st| switch (st.data) {
            .veto => try c.report(.veto_outside_a_decision, st.first),
            .@"if" => |f| {
                for (f.arms) |arm| try c.vetoes(arm.body);
                if (f.@"else") |e| try c.vetoes(e);
            },
            .repeat => |r| try c.vetoes(r.body),
            .match => |m| {
                for (m.branches) |br| try c.vetoes(br.body);
                if (m.@"else") |e| try c.vetoes(e);
            },
            .@"try" => |t| {
                try c.vetoes(t.body);
                for (t.catches) |k| try c.vetoes(k.body);
                if (t.finally) |f| try c.vetoes(f.body);
            },
            else => {},
        };
    }

    /// Whether a Suspension Point may have been reached after `b`, given
    /// whether one may have been before it; reports `veto` and `pass` after
    /// one.
    fn flow(c: *Checker, s: *Scope, b: ast.Block, before: bool) Allocator.Error!bool {
        var state = before;
        for (b) |st| state = try c.flowStmt(s, st, state);
        return state;
    }

    fn flowStmt(c: *Checker, s: *Scope, st: *const Stmt, before: bool) Allocator.Error!bool {
        switch (st.data) {
            .veto, .pass => {
                if (before) try c.report(.after_a_suspension, st.first);
                return before;
            },
            .wait, .wait_for, .join => return true,
            .wait_block => |wb| {
                var out = true;
                for (wb.branches) |br| out = try c.flow(s, br.body, true) or out;
                return out;
            },
            .send => |snd| return before or snd.wait != null,
            .ask => |op| return before or op.wait != null,
            .tell_block => |tb| {
                for (tb.lines) |line| if (line.wait != null) return true;
                return before;
            },
            .call => |cs| return before or cs.wait != null,
            .command => |cmd| {
                const sel = try c.selector(cmd.name, cmd.labels);
                if (c.handlers.get(sel)) |g| return before or g.may_suspend;
                return before or cmd.wait != null;
            },
            .@"if" => |f| {
                var out = before;
                for (f.arms) |arm| out = try c.flow(s, arm.body, before) or out;
                if (f.@"else") |e| out = try c.flow(s, e, before) or out;
                return out;
            },
            .repeat => |r| {
                const once = try c.flow(s, r.body, before);
                // A later pass starts after an earlier one.
                return try c.flow(s, r.body, before or once) or before;
            },
            .match => |m| {
                var out = before;
                for (m.branches) |br| out = try c.flow(s, br.body, before) or out;
                if (m.@"else") |e| out = try c.flow(s, e, before) or out;
                return out;
            },
            .@"try" => |t| {
                const body = try c.flow(s, t.body, before);
                var out = body;
                for (t.offers) |o| out = try c.flow(s, o.body, body) or out;
                for (t.catches) |k| out = try c.flow(s, k.body, body) or out;
                if (t.finally) |f| out = try c.flow(s, f.body, out);
                return out;
            },
            .timeout => |t| return c.flow(s, t.body, before),
            else => return before,
        }
    }
};

// ---------------------------------------------------------------- tests

const testing = std.testing;
const parser = @import("../syntax/parser.zig");

/// The diagnostics of `source`, as `code at line:col` lines, or the first
/// syntax error.
fn diagnose(a: Allocator, source: []const u8, context: Context) ![]const u8 {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const result = try parser.parse(arena.allocator(), source);
    var lines: lexer.Lines = try .init(arena.allocator(), source);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    switch (result) {
        .failure => |d| {
            const p = lines.position(d.offset);
            try out.print(a, "{s} at {d}:{d}\n", .{ d.code.spelling(), p.line, p.column });
        },
        .tree => |*tree| {
            const checked = try check(arena.allocator(), tree, context);
            for (checked.diagnostics) |d| {
                const p = lines.position(d.offset);
                try out.print(a, "{s} at {d}:{d}\n", .{ d.code.spelling(), p.line, p.column });
            }
        },
    }
    return out.toOwnedSlice(a);
}

fn expectDiagnostics(source: []const u8, context: Context, expected: []const u8) !void {
    const got = try diagnose(testing.allocator, source, context);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(expected, got);
}

test "names resolve, and unknown ones are reported" {
    try expectDiagnostics(
        \\script variable seen = 0
        \\constant limit = 10
        \\function double x
        \\  return x * 2
        \\end double
        \\on t y
        \\  put double(y) + limit + seen + pi into z
        \\  put z into seen
        \\  return absent
        \\end t
    , .{}, "unknown name at 9:10\n");
}

test "Lambdas capture and may not write captured locals" {
    try expectDiagnostics(
        \\on t
        \\  put 3 into k
        \\  put given x: x * k into triple
        \\  put given
        \\    put 1 into k
        \\    pass t
        \\  end into bad
        \\end t
    , .{}, "can't write at 5:16\nnot in a lambda at 6:5\n");
}

test "the may-suspend analysis" {
    try expectDiagnostics(
        \\on slow
        \\  wait 1 s
        \\end slow
        \\on viaSlow
        \\  slow and wait
        \\end viaSlow
        \\on quick
        \\end quick
        \\on t
        \\  viaSlow
        \\  quick and wait
        \\  put slow() into x
        \\  try
        \\  finally
        \\    viaSlow and wait
        \\  end try
        \\end t
        \\on beforeMove m, deciding
        \\  wait 1 s
        \\  veto "late"
        \\end beforeMove
        \\function f
        \\  return 1
        \\  veto
        \\end f
    , .{}, "missing and wait at 10:3\nneedless and wait at 11:3\ncan't suspend here at 12:7\ncan't suspend here at 15:5\nafter a suspension at 20:3\nveto outside a decision at 24:3\n");
}

test "Capability calls against the Script's Grants" {
    const grants = [_]Grant{.{ .name = "feed", .operations = &.{
        .{ .name = "fetch", .mode = .suspending, .required = 0, .total = 1 },
        .{ .name = "now", .mode = .immediate, .required = 0, .total = 0 },
        .{ .name = "log", .mode = .fire_and_forget, .required = 1, .total = 1 },
    } }};
    try expectDiagnostics(
        \\on t
        \\  ask feed to fetch and wait
        \\  ask feed to fetch
        \\  ask feed to now
        \\  tell feed to now
        \\  tell feed to log 1, 2
        \\  ask other to x
        \\  ask feed to absent
        \\  say 1
        \\end t
    , .{ .grants = &grants }, "wrong mode at 3:3\nwrong mode at 5:3\nwrong argument count at 6:16\nunknown operation at 7:7\nunknown operation at 8:15\nunknown operation at 9:3\n");
}

test "both sides of otherwise and an optional read's operands are checked" {
    // An unselected fallback's call is still `not in a guard`.
    try expectDiagnostics("function f x\nreturn x\nend\non t x where true otherwise f(x)\nend\n", .{}, "not in a guard at 4:29\n");
    try expectDiagnostics("function f x\nreturn x\nend\non t x where f(x) otherwise true\nend\n", .{}, "not in a guard at 4:14\n");
    // An optional read of a known Host Object is no Host property access:
    // it fails at runtime, and the ordinary `id` read stays allowed.
    const objects: []const Object = &.{.{ .name = "warehouse", .kind = "store" }};
    try expectDiagnostics("on t where the optional label of warehouse is \"w1\"\nend\n", .{ .objects = objects }, "");
    try expectDiagnostics("on t where the optional id of warehouse is \"w1\"\nend\n", .{ .objects = objects }, "");
    try expectDiagnostics("on t where the id of warehouse is \"w1\"\nend\n", .{ .objects = objects }, "");
    try expectDiagnostics("on t where the label of warehouse is \"w1\"\nend\n", .{ .objects = objects }, "not in a guard at 1:12\n");
    try expectDiagnostics("on t\nreturn absent otherwise 1\nend\n", .{}, "unknown name at 2:8\n");
    try expectDiagnostics("on t\nreturn 1 otherwise absent\nend\n", .{}, "unknown name at 2:20\n");
    try expectDiagnostics("on t\nreturn the optional k of absent\nend\n", .{}, "unknown name at 2:26\n");
    try expectDiagnostics("on t\nreturn the optional (absent) of nothing\nend\n", .{}, "unknown name at 2:22\n");
}

test "an unknown name in an initialiser is also not constant" {
    try expectDiagnostics("constant x = unknown\n", .{}, "unknown name at 1:14\nnot constant at 1:14\n");
    try expectDiagnostics("constant x = 1 + unknown\n", .{}, "unknown name at 1:18\nnot constant at 1:18\n");
    try expectDiagnostics("constant x = [unknown]\n", .{}, "unknown name at 1:15\nnot constant at 1:15\n");
    try expectDiagnostics("constant x = 1 otherwise unknown\n", .{}, "unknown name at 1:26\nnot constant at 1:26\n");
    try expectDiagnostics("constant x = unknown(1)\n", .{}, "unknown name at 1:14\nnot constant at 1:14\n");
    try expectDiagnostics("script variable v = unknown\n", .{}, "unknown name at 1:21\nnot constant at 1:21\n");
    try expectDiagnostics("function f a = unknown\nreturn a\nend\n", .{}, "unknown name at 1:16\nnot constant at 1:16\n");
    // `not constant` names only the first token that isn't allowed.
    try expectDiagnostics("script variable v = 1\nconstant x = v + unknown\n", .{}, "not constant at 2:14\nunknown name at 2:18\n");
}

test "it outside a body is an unknown name" {
    try expectDiagnostics("constant x = it\n", .{}, "unknown name at 1:14\nnot constant at 1:14\n");
    try expectDiagnostics("script variable x = it\n", .{}, "unknown name at 1:21\nnot constant at 1:21\n");
    try expectDiagnostics("function f x = it\nreturn it\nend\n", .{}, "unknown name at 1:16\nnot constant at 1:16\n");
    try expectDiagnostics("script variable v = 1\nconstant x = [v, it, it]\n", .{}, "not constant at 2:15\nunknown name at 2:18\nunknown name at 2:22\n");
    try expectDiagnostics("script variable v = 1\nscript variable x = v otherwise it\n", .{}, "not constant at 2:21\nunknown name at 2:33\n");
    try expectDiagnostics("script variable v = 1\nfunction f x = v + it\nreturn it\nend\n", .{}, "not constant at 2:16\nunknown name at 2:20\n");
    try expectDiagnostics("constant x = it otherwise it\n", .{}, "unknown name at 1:14\nnot constant at 1:14\nunknown name at 1:27\n");
    try expectDiagnostics("on t\nreturn it\nend\nfunction f\nreturn it\nend\n", .{}, "");
    try expectDiagnostics("constant f = given: given: it\nfunction g x = given: it\nreturn it\nend\n", .{}, "");
}

test "otherwise and optional reads are eligible where their operands are" {
    for ([_][]const u8{
        "constant fallback = 3\nconstant x = nothing otherwise fallback\n",
        "constant m = {a: 1}\nconstant x = the optional a of m otherwise 0\n",
        "script variable x = the optional a of nothing otherwise 1\n",
        "function f a = nothing otherwise 1\nreturn a\nend\n",
        "on t xs\nreturn every item of xs whose the optional active of it otherwise false\nend\n",
        "on t\nput 1 into otherwise\nreturn otherwise\nend\n",
        "function otherwise x\nreturn x\nend\non t\nreturn otherwise(2)\nend\n",
        "on t\nreturn {otherwise: 1, optional: 2}\nend\n",
    }) |source| try expectDiagnostics(source, .{}, "");
    try expectDiagnostics("script variable v = 1\nconstant x = nothing otherwise v\n", .{}, "not constant at 2:32\n");
    try expectDiagnostics("script variable v = 1\nconstant x = the optional a of v\n", .{}, "not constant at 2:32\n");
    try expectDiagnostics("function f x\nreturn x\nend\nconstant y = nothing otherwise f(1)\n", .{}, "not constant at 4:32\n");
    try expectDiagnostics("on t xs\nreturn every item of xs whose it otherwise f(it)\nend\nfunction f x\nreturn x\nend\n", .{}, "not in a whose at 2:44\n");
}

/// The diagnostics a case's Trace expects of one unit, as `diagnose` writes
/// them.
fn expectedDiagnostics(a: Allocator, trace: []const u8, unit: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    const prefix = try std.fmt.allocPrint(a, "diag {s} code=\"", .{unit});
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, prefix)) {
        const rest = line[prefix.len..];
        const q = std.mem.indexOfScalar(u8, rest, '"').?;
        const pos = std.mem.indexOf(u8, rest, "pos=").?;
        try out.print(a, "{s} at {s}\n", .{ rest[0..q], rest[pos + 4 ..] });
    };
    return out.items;
}

/// Checks a unit, giving its diagnostics as text and, for a Library, its
/// exports.
fn checkUnit(a: Allocator, source: []const u8, context: Context, exported: ?*[]const Export) ![]const u8 {
    const result = try parser.parse(a, source);
    var lines: lexer.Lines = try .init(a, source);
    var out: std.ArrayList(u8) = .empty;
    switch (result) {
        .failure => |d| {
            const p = lines.position(d.offset);
            try out.print(a, "{s} at {d}:{d}\n", .{ d.code.spelling(), p.line, p.column });
        },
        .tree => |*tree| {
            const checked = try check(a, tree, context);
            for (checked.diagnostics) |d| {
                const p = lines.position(d.offset);
                try out.print(a, "{s} at {d}:{d}\n", .{ d.code.spelling(), p.line, p.column });
            }
            if (exported) |e| e.* = try exports(a, tree, &checked);
        },
    }
    return out.items;
}

test "every corpus unit gives the diagnostics its case expects" {
    const io = testing.io;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(testing.allocator);
    defer walker.deinit();
    var failures: usize = 0;
    var units: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.eql(u8, entry.basename, "case.toml")) {
        const case = std.fs.path.dirname(entry.path) orelse continue;
        // Cases whose diagnostics need an Operation's Shapes, a Text Pattern
        // program, a run, a Library's calls held to its importer's Grants, or
        // a Grant revoked before a Reload: the runner's. Object-kind
        // declarations (`*-properties`, `implicit-property-targets`) are too.
        if (among(case, &.{
            "load-diagnostics/object-properties",       "load-diagnostics/pattern-too-large",         "load-diagnostics/initialiser-failed",
            "text-patterns/pattern-size-literal-limit", "capabilities/effect-reload-carry",           "capabilities/effect-replace-library",
            "capabilities/load-checks",                 "capabilities/revoke-in-flight",              "libraries/caller-capabilities",
            "libraries/needs-transitive",               "reload/replacement-transitive",              "tell-block/library",
            "examples/tenants-globex",                  "load-diagnostics/implicit-property-targets",
        })) continue;
        const toml = try dir.readFileAlloc(io, entry.path, a, .unlimited);
        const trace = dir.readFileAlloc(io, try std.fmt.allocPrint(a, "{s}/case.trace", .{case}), a, .unlimited) catch "";
        const all = (try @import("../corpus/case.zig").read(a, toml)).units;
        // Libraries first, until each sees the exports of those it imports.
        var libraries: std.ArrayList(Library) = .empty;
        for (all) |u| if (u.library) try libraries.append(a, .{ .name = u.name, .exports = &.{} });
        for (0..libraries.items.len + 1) |_| {
            var i: usize = 0;
            for (all) |u| if (u.library) {
                const source = try dir.readFileAlloc(io, try std.fmt.allocPrint(a, "{s}/{s}", .{ case, u.source }), a, .unlimited);
                var exported: []const Export = &.{};
                _ = try checkUnit(a, source, .{ .library = true, .libraries = libraries.items }, &exported);
                libraries.items[i].exports = exported;
                i += 1;
            };
        }
        for (all) |u| {
            if (u.source.len == 0) continue;
            const source = try dir.readFileAlloc(io, try std.fmt.allocPrint(a, "{s}/{s}", .{ case, u.source }), a, .unlimited);
            const got = try checkUnit(a, source, .{ .library = u.library, .objects = u.objects, .grants = if (u.library) null else u.grants, .libraries = libraries.items }, null);
            const expected = try expectedDiagnostics(a, trace, u.name);
            units += 1;
            if (!std.mem.eql(u8, got, expected)) {
                failures += 1;
                std.debug.print("{s}/{s}:\n  expected:\n{s}  got:\n{s}", .{ case, u.source, expected, got });
            }
        }
    };
    try testing.expect(units > 400);
    try testing.expectEqual(@as(usize, 0), failures);
}

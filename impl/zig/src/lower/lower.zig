//! The normative lowering of chapter 8: a checked unit becomes a code unit
//! of `machine.toml`'s instructions, with its constant pool, definitions,
//! variables, objects, bodies, Unwind Table, offer records and event table,
//! and the source map. `disassemble` prints the canonical disassembly that
//! Disassembly Cases pin. The instructions' byte encoding is the Zig Core's
//! own (ADR 0009); nothing outside `src/` depends on this representation.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ast = @import("../syntax/ast.zig");
const lexer = @import("../syntax/lexer.zig");
const check = @import("../check/check.zig");
const machine = @import("../generated/machine.zig").machine;
const Opcode = @import("../generated/opcodes.zig").Opcode;
const stdlib = @import("../generated/stdlib.zig").stdlib;
const model = @import("../value.zig");
const display = @import("../display.zig");
const unicode = @import("../unicode/unicode.zig");
const Tok = ast.Tok;
const Expr = ast.Expr;
const Pattern = ast.Pattern;
const Stmt = ast.Stmt;

pub const Operand = union(enum) {
    int: i64,
    text: []const u8,
    /// A label of the body being lowered, resolved to an index when the
    /// body is laid out.
    label: u32,
};

pub const Position = struct { line: u32, column: u32 };

pub const Instruction = struct {
    op: Opcode,
    operands: []const Operand,
    position: Position,
    /// What the `constant`, `local`, `variable` and `body` operands name.
    note: []const u8,
};

pub const BodyKind = enum { init, function, handler, fallback, lambda, event };

pub const Body = struct {
    kind: BodyKind,
    name: []const u8,
    clause: ?u32 = null,
    /// Each parameter as the disassembly shows it.
    params: []const []const u8,
    captures: u32 = 0,
    /// The slot of the first capture, and each capture's name, in slot
    /// order.
    capture_slot: u32 = 0,
    capture_names: []const []const u8 = &.{},
    /// A Handler Clause's Queueing Policy.
    policy: Policy = .none,
    /// Whether the clause is `, deciding`, so it holds a Decision's Verdict.
    deciding: bool = false,
    locals: u32,
    /// For an `on error` clause with `, during name`: that name's slot.
    during: ?u32 = null,
    may_suspend: bool,
    first: u32,
    last: u32,
};

pub const Policy = enum { none, queued, dropping, replacing };

pub const Unwind = struct {
    first: u32,
    last: u32,
    kind: enum { @"catch", finally, guard, offer },
    target: u32,
    depth: u32,
};

/// One offer of a record: its Name, its action's entry and the slots its
/// parameters bind.
pub const Offer = struct { name: []const u8, entry: u32, binds: []const u32 };

pub const OfferRecord = struct {
    body: u32,
    depth: u32,
    end: u32,
    offers: []const Offer,
};

pub const Branch = union(enum) {
    when: struct { message: []const u8, from: bool, body: ?u32, captures: u32, binds: []const u32 },
    after,
};

pub const Event = struct { branches: []const Branch, timeout: bool };

/// A code unit (chapter 8, Code units).
pub const Unit = struct {
    name: []const u8,
    library: bool,
    /// Each constant in the display form, and what the machine holds for it.
    constants: []const []const u8,
    values: []const Constant,
    definitions: []const []const u8,
    variables: []const []const u8,
    objects: []const []const u8,
    bodies: []const Body,
    code: []const Instruction,
    unwind: []const Unwind,
    offers: []const OfferRecord,
    events: []const Event,
};

pub const Mode = check.Mode;

/// What a constant is to the machine: a value, or one of the constants that
/// aren't Script values (chapter 11, In a disassembly).
pub const Constant = union(enum) {
    value: *model.Value,
    /// A Built-in Constant, by name.
    builtin: []const u8,
    /// A map literal's keys.
    keys: []const []const u8,
    /// A Text Pattern's canonical source, or a template's with `(1)`, `(2)`.
    pattern: []const u8,
    /// A run of bit fields' widths.
    widths: []const u32,
};

pub const Options = struct {
    /// The unit's name: its Script's or Library's.
    name: []const u8,
    /// The context the unit was checked in. Its Grants give each
    /// Operation's mode, which picks `ask`, `ask-wait` or `tell`.
    context: check.Context = .{},
    /// What the constant pool's values are made with, so they can outlive
    /// the lowering; the arena when null. The caller then releases each
    /// `Constant.value` once.
    values: ?Allocator = null,
};

/// Lowers a checked unit with no diagnostics. Everything is allocated in
/// `arena`.
pub fn lower(arena: Allocator, tree: *const ast.Tree, checked: *const check.Result, options: Options) Allocator.Error!Unit {
    var l: Lowerer = .{
        .a = arena,
        .tree = tree,
        .checked = checked,
        .options = options,
        .lines = try .init(arena, tree.source),
    };
    // The pool's values outlive the arena, so a refusal releases them.
    errdefer if (options.values != null) for (l.values.items) |c| if (c == .value) c.value.release();
    try l.run();
    return l.finish();
}

// ---------------------------------------------------------------- the unit

const Import = struct { library: []const u8, name: []const u8, kind: @FieldType(check.Export, "kind") };

const BodyCode = struct {
    info: Body,
    code: std.ArrayList(Instruction),
    labels: std.ArrayList(?u32),
    unwind: std.ArrayList(Unwind),
    offers: std.ArrayList(OfferRecord),
};

const Lowerer = struct {
    a: Allocator,
    tree: *const ast.Tree,
    checked: *const check.Result,
    options: Options,
    lines: lexer.Lines,
    constants: std.ArrayList([]const u8) = .empty,
    values: std.ArrayList(Constant) = .empty,
    constant_index: std.StringHashMapUnmanaged(u32) = .empty,
    definitions: std.ArrayList([]const u8) = .empty,
    variables: std.ArrayList([]const u8) = .empty,
    objects: std.ArrayList([]const u8) = .empty,
    bodies: std.ArrayList(?*BodyCode) = .empty,
    events: std.ArrayList(Event) = .empty,
    imports: std.StringHashMapUnmanaged(Import) = .empty,
    /// The definition index of each own Constant and parameter default.
    definition_index: std.StringHashMapUnmanaged(u32) = .empty,
    functions: std.StringHashMapUnmanaged(u32) = .empty,
    /// The next clause number of each Handler selector.
    clauses: std.StringHashMapUnmanaged(u32) = .empty,

    fn position(l: *Lowerer, t: Tok) Position {
        const p = l.lines.position(l.tree.tokens[t].start);
        return .{ .line = @intCast(p.line), .column = @intCast(p.column) };
    }

    fn text(l: *Lowerer, t: Tok) []const u8 {
        return l.tree.text(t);
    }

    /// The allocator of the constant pool's values.
    fn va(l: *Lowerer) Allocator {
        return l.options.values orelse l.a;
    }

    fn print(l: *Lowerer, comptime fmt: []const u8, args: anytype) Allocator.Error![]const u8 {
        return std.fmt.allocPrint(l.a, fmt, args);
    }

    /// A constant's pool index, adding it on first use. `key` tells apart
    /// constants that display alike, such as the text `"` and `quote`, and
    /// its first letter says what the machine holds for it.
    fn constant(l: *Lowerer, key: []const u8, shown: []const u8) Allocator.Error!u32 {
        return l.constantWith(key, shown, null);
    }

    fn constantWith(l: *Lowerer, key: []const u8, shown: []const u8, v: ?*model.Value) Allocator.Error!u32 {
        // It takes `v`, so a refusal releases it.
        errdefer if (v) |x| if (l.options.values != null) x.release();
        const entry = try l.constant_index.getOrPut(l.a, key);
        if (!entry.found_existing) {
            entry.value_ptr.* = @intCast(l.constants.items.len);
            try l.constants.append(l.a, shown);
            const value = try l.constantValue(key, shown, v);
            l.values.append(l.a, value) catch |e| {
                // `v` itself is released above.
                if (value == .value and v == null and l.options.values != null) value.value.release();
                return e;
            };
        } else if (v) |x| x.release();
        return entry.value_ptr.*;
    }

    fn constantValue(l: *Lowerer, key: []const u8, shown: []const u8, v: ?*model.Value) Allocator.Error!Constant {
        const oom = error.OutOfMemory;
        if (v) |x| return .{ .value = x };
        if (std.mem.eql(u8, key, "nothing")) return .{ .value = model.scalar(l.va(), .nothing) catch return oom };
        if (std.mem.eql(u8, key, "true")) return .{ .value = model.scalar(l.va(), .{ .bool = true }) catch return oom };
        if (std.mem.eql(u8, key, "false")) return .{ .value = model.scalar(l.va(), .{ .bool = false }) catch return oom };
        if (std.mem.eql(u8, key, "bytes")) return .{ .value = model.bytes(l.va(), "") catch return oom };
        switch (key[0]) {
            'n' => return .{ .value = model.scalar(l.va(), .{ .number = model.Decimal.parse(shown) catch unreachable }) catch return oom },
            'b' => return .{ .builtin = shown },
            'p' => return .{ .pattern = shown },
            'k' => {
                // A key list, written as a list of texts.
                const list = display.parse(l.a, shown, .{}) catch return oom;
                const keys = try l.a.alloc([]const u8, list.data.list.len);
                for (list.data.list, keys) |item, *k| k.* = item.data.text;
                return .{ .keys = keys };
            },
            'w' => {
                var widths: std.ArrayList(u32) = .empty;
                var it = std.mem.tokenizeAny(u8, shown, "[], ");
                while (it.next()) |w| try widths.append(l.a, std.fmt.parseInt(u32, w, 10) catch unreachable);
                return .{ .widths = widths.items };
            },
            else => unreachable,
        }
    }

    /// Pools a value it takes.
    fn valueConstant(l: *Lowerer, v: *model.Value) Allocator.Error!u32 {
        const key = blk: {
            errdefer if (l.options.values != null) v.release();
            const shown = display.string(l.a, v) catch return error.OutOfMemory;
            break :blk .{ try l.print("v{s}", .{shown}), shown };
        };
        return l.constantWith(key[0], key[1], v);
    }

    fn object(l: *Lowerer, name: []const u8) Allocator.Error![]const u8 {
        for (l.objects.items) |o| if (std.mem.eql(u8, o, name)) return name;
        try l.objects.append(l.a, name);
        return name;
    }

    fn newBody(l: *Lowerer, info: Body) Allocator.Error!*BodyCode {
        const b = try l.a.create(BodyCode);
        b.* = .{ .info = info, .code = .empty, .labels = .empty, .unwind = .empty, .offers = .empty };
        return b;
    }

    /// Reserves the next body index for a Lambda or event test, reached by
    /// the lowering.
    fn reserve(l: *Lowerer) Allocator.Error!u32 {
        try l.bodies.append(l.a, null);
        return @intCast(l.bodies.items.len - 1);
    }

    fn run(l: *Lowerer) Allocator.Error!void {
        const decls = l.tree.declarations;
        // An extension's inherited names: the Script's Variables first, and
        // its Constants as the first definitions, each linked from the unit
        // that declares it (chapter 8, Code units).
        for (l.options.context.inherited) |x| {
            if (x.variable) {
                try l.variables.append(l.a, x.name);
                continue;
            }
            try l.imports.put(l.a, x.name, .{ .library = x.unit, .name = x.export_.name, .kind = x.export_.kind });
            if (x.export_.kind == .constant) try l.definitions.append(l.a, try l.print("{s}:{s}", .{ x.unit, x.export_.name }));
        }
        // Imports, by local name.
        for (decls) |d| if (d.data == .use) {
            const u = d.data.use;
            const library = l.text(u.library);
            for (u.names) |n| {
                const name = l.text(n);
                const ex = check.libraryExport(l.options.context, library, name);
                const local = if (u.rename) |r| l.text(r) else name;
                try l.imports.put(l.a, local, .{ .library = library, .name = name, .kind = if (ex) |e| e.kind else .function });
            }
        };
        // Definitions: imported and own Constants in source order, then
        // parameter defaults.
        for (decls) |d| switch (d.data) {
            .use => |u| for (u.names) |n| {
                const local = if (u.rename) |r| l.text(r) else l.text(n);
                const im = l.imports.get(local).?;
                if (im.kind == .constant) try l.definitions.append(l.a, try l.print("{s}:{s}", .{ im.library, im.name }));
            },
            .constant => |k| {
                try l.definition_index.put(l.a, l.text(k.name), @intCast(l.definitions.items.len));
                try l.definitions.append(l.a, l.text(k.name));
            },
            else => {},
        };
        for (decls) |d| if (d.data == .function) {
            const f = d.data.function;
            for (f.params) |p| if (p.default != null) {
                const name = try l.print("{s}.{s}", .{ l.text(f.name), l.text(p.name) });
                try l.definition_index.put(l.a, name, @intCast(l.definitions.items.len));
                try l.definitions.append(l.a, name);
            };
        };
        for (decls) |d| if (d.data == .script_variable) try l.variables.append(l.a, l.text(d.data.script_variable.name));
        // Body numbers: the initialiser, then each function and clause.
        var index: u32 = 1;
        for (decls) |d| switch (d.data) {
            .function => |f| {
                try l.functions.put(l.a, l.text(f.name), index);
                index += 1;
            },
            .handler => index += 1,
            else => {},
        };
        try l.bodies.appendNTimes(l.a, null, index);
        try l.initialiser();
        var next: u32 = 1;
        for (decls, 0..) |*d, i| switch (d.data) {
            .function => |*f| {
                l.bodies.items[next] = try l.function(f, @intCast(i));
                next += 1;
            },
            .handler => |*h| {
                l.bodies.items[next] = try l.handlerClause(h, @intCast(i));
                next += 1;
            },
            else => {},
        };
    }

    fn checkerBody(l: *Lowerer, kind: check.BodyKind, decl: ?u32, lambda: ?*const Expr) *const check.Body {
        for (l.checked.bodies) |*b| {
            if (b.kind != kind) continue;
            if (lambda) |e| {
                if (b.lambda == e) return b;
            } else if (b.declaration == decl) return b;
        }
        unreachable;
    }

    fn initialiser(l: *Lowerer) Allocator.Error!void {
        const cb = l.checkerBody(.init, null, null);
        var f = try Frame.init(l, .init, "initialiser", cb);
        try f.finishSlots();
        for (l.tree.declarations) |d| switch (d.data) {
            .script_variable => |v| if (v.value) |e| {
                try f.expr(e);
                try f.emit(.store_var, &.{.{ .int = l.variableIndex(l.text(v.name)) }}, v.keyword, l.text(v.name));
            },
            .constant => |k| {
                try f.expr(k.value);
                try f.emit(.store_definition, &.{.{ .text = l.text(k.name) }}, k.keyword, "");
            },
            else => {},
        };
        for (l.tree.declarations) |d| if (d.data == .function) {
            const fun = d.data.function;
            for (fun.params) |p| if (p.default) |e| {
                try f.expr(e);
                try f.emit(.store_definition, &.{.{ .text = try l.print("{s}.{s}", .{ l.text(fun.name), l.text(p.name) }) }}, p.name, "");
            };
        };
        try f.endAt(.{ .line = 1, .column = 1 });
        l.bodies.items[0] = try f.done(&.{});
    }

    fn variableIndex(l: *Lowerer, name: []const u8) i64 {
        for (l.variables.items, 0..) |v, i| if (std.mem.eql(u8, v, name)) return @intCast(i);
        unreachable;
    }

    fn function(l: *Lowerer, fun: *const ast.Function, decl: u32) Allocator.Error!*BodyCode {
        const cb = l.checkerBody(.function, decl, null);
        var f = try Frame.init(l, .function, l.text(fun.name), cb);
        var params: std.ArrayList([]const u8) = .empty;
        for (fun.params) |p| {
            _ = try f.addSlot(l.text(p.name));
            if (p.default != null) {
                const def = l.definition_index.get(try l.print("{s}.{s}", .{ l.text(fun.name), l.text(p.name) })).?;
                try params.append(l.a, try l.print("{s} = {d}", .{ l.text(p.name), def }));
            } else try params.append(l.a, l.text(p.name));
        }
        try f.finishSlots();
        try f.block(fun.body);
        try f.endAt(l.position(fun.end));
        return f.done(params.items);
    }

    fn handlerClause(l: *Lowerer, h: *const ast.Handler, decl: u32) Allocator.Error!*BodyCode {
        const kind: check.BodyKind = if (h.fallback) .fallback else .handler;
        const cb = l.checkerBody(kind, decl, null);
        const name = if (h.fallback) "any message" else try l.selector(h.name, h.labels);
        var f = try Frame.init(l, if (h.fallback) .fallback else .handler, name, cb);
        const counter = try l.clauses.getOrPut(l.a, name);
        if (!counter.found_existing) counter.value_ptr.* = 0;
        counter.value_ptr.* += 1;
        f.body.info.clause = counter.value_ptr.*;
        for (h.suffixes) |t| {
            if (std.meta.stringToEnum(Policy, l.text(t))) |p| f.body.info.policy = p;
            if (std.mem.eql(u8, l.text(t), "deciding")) f.body.info.deciding = true;
        }
        f.handler = h;
        const params = try f.parameters(h.params);
        try f.finishSlots();
        if (h.during) |d| f.body.info.during = f.names.get(l.text(d));
        const fail = try f.newLabel();
        // A guard region: the parameter patterns, then the Guard.
        const start = f.pc();
        for (h.params, 0..) |p, i| {
            if (p.data == .name and p.bind_as == null) continue;
            // `on error "timeout"` is short for `on error {code: "timeout"}`,
            // as in `catch`.
            if (i == 0 and !h.fallback and std.mem.eql(u8, name, "error") and f.isCodeShorthand(p)) {
                try f.codeShorthand(p, 1, fail);
                continue;
            }
            try f.testPattern(p, @intCast(i + 1), fail, .direct, false);
        }
        if (h.guard) |g| try f.guard(g, fail);
        if (f.pc() > start) try f.body.unwind.append(l.a, .{ .first = start, .last = f.pc() - 1, .kind = .guard, .target = 0, .depth = 0 });
        const guard_entry = if (f.pc() > start) f.body.unwind.items.len - 1 else null;
        if (h.finally) |fin| {
            try f.tryStatement(.{ .body = h.body, .offers = &.{}, .catches = &.{}, .finally = fin, .end = h.end }, fin.keyword);
        } else try f.block(h.body);
        try f.endAt(l.position(h.end));
        try f.mark(fail);
        try f.emitAt(.clause_fail, &.{}, l.position(h.end), "");
        if (guard_entry) |g| f.body.unwind.items[g].target = f.labelPc(fail);
        return f.done(params);
    }

    /// An Operation's mode from the Script's Grants; immediate when unknown.
    fn operationMode(l: *Lowerer, grant: []const u8, operation: []const u8) Mode {
        const grants = l.options.context.grants orelse return .immediate;
        for (grants) |g| {
            if (!std.mem.eql(u8, g.name, grant)) continue;
            for (g.operations) |o| if (std.mem.eql(u8, o.name, operation)) return o.mode;
        }
        return .immediate;
    }

    fn importedHandler(l: *Lowerer, name: []const u8) bool {
        const im = l.imports.get(name) orelse return false;
        return im.kind == .handler;
    }

    fn selector(l: *Lowerer, name: Tok, labels: []const Tok) Allocator.Error![]const u8 {
        if (labels.len == 0) return l.text(name);
        var out: std.ArrayList(u8) = .empty;
        try out.appendSlice(l.a, l.text(name));
        try out.append(l.a, ':');
        for (labels) |t| {
            try out.appendSlice(l.a, l.text(t));
            try out.append(l.a, ':');
        }
        return out.items;
    }

    /// Lays out the bodies' code in body order, resolving labels.
    fn finish(l: *Lowerer) Allocator.Error!Unit {
        var code: std.ArrayList(Instruction) = .empty;
        var bodies: std.ArrayList(Body) = .empty;
        var unwind: std.ArrayList(Unwind) = .empty;
        var offers: std.ArrayList(OfferRecord) = .empty;
        for (l.bodies.items, 0..) |maybe, body_index| {
            const b = maybe.?;
            const base: u32 = @intCast(code.items.len);
            for (b.code.items) |ins| {
                var copy = ins;
                const ops = try l.a.dupe(Operand, ins.operands);
                for (ops) |*o| if (o.* == .label) {
                    const target = base + b.labels.items[o.label].?;
                    o.* = .{ .int = target };
                };
                copy.operands = ops;
                try code.append(l.a, copy);
            }
            var info = b.info;
            info.first = base;
            info.last = @intCast(code.items.len - 1);
            for (b.code.items) |ins| {
                if (machine.instruction[@backingInt(ins.op)].suspends) info.may_suspend = true;
            }
            try bodies.append(l.a, info);
            for (b.unwind.items) |u| {
                var e = u;
                e.first += base;
                e.last += base;
                if (e.kind != .offer) e.target += base;
                try unwind.append(l.a, e);
            }
            for (b.offers.items) |o| {
                var r = o;
                r.body = @intCast(body_index);
                r.end += base;
                const entries = try l.a.dupe(Offer, o.offers);
                for (entries) |*e| e.entry += base;
                r.offers = entries;
                try offers.append(l.a, r);
            }
        }
        // Offer entries name records by their index in the unit.
        var seen: u32 = 0;
        for (unwind.items) |*u| if (u.kind == .offer) {
            u.target = seen;
            seen += 1;
        };
        return .{
            .name = l.options.name,
            .library = l.options.context.library,
            .constants = l.constants.items,
            .values = l.values.items,
            .definitions = l.definitions.items,
            .variables = l.variables.items,
            .objects = l.objects.items,
            .bodies = bodies.items,
            .code = code.items,
            .unwind = unwind.items,
            .offers = offers.items,
            .events = l.events.items,
        };
    }
};

// ---------------------------------------------------------------- a body

/// A Container level, from the root out.
const Level = struct {
    expr: *const Expr,
    /// The index or computed key's temp.
    index: ?u32 = null,
    /// The whole above this level's value, read into a temp.
    whole: ?u32 = null,
};

/// What leaving a construct needs: a `finally` block to copy or a Timeout
/// Block to end.
const Exit = union(enum) {
    /// A `try`: its `finally` block, if it has one.
    finally: struct { block: ?ast.Block, try_index: usize },
    timeout,
    /// A loop: where `next repeat` and `exit repeat` go.
    loop: struct { next: u32, exit: u32, iterator: bool },
};

/// A `try` being lowered: its spans and the copies cut out of them.
const TryState = struct {
    exclusions: std.ArrayList([2]u32) = .empty,
};

const Binding = enum { direct, temps };

const Frame = struct {
    l: *Lowerer,
    body: *BodyCode,
    kind: BodyKind,
    checker: ?*const check.Body,
    slots: std.ArrayList([]const u8) = .empty,
    names: std.StringHashMapUnmanaged(u32) = .empty,
    first_temp: u32 = 0,
    temp_base: u32 = 0,
    in_use: std.ArrayList(bool) = .empty,
    exits: std.ArrayList(Exit) = .empty,
    tries: std.ArrayList(TryState) = .empty,
    /// Iterators and deadlines on the operand stack.
    depth: u32 = 0,
    join: bool = false,
    handler: ?*const ast.Handler = null,
    /// Temp bindings of the pattern being tested: the name's temp.
    pending: std.ArrayList(struct { name: []const u8, temp: u32 }) = .empty,
    /// In a Whose Clause's condition: the chunk's temp, which `it` reads.
    whose_it: ?u32 = null,
    /// The capture names of a Lambda or event test, in slot order.
    capture_names: []const []const u8 = &.{},

    fn init(l: *Lowerer, kind: BodyKind, name: []const u8, checker: ?*const check.Body) Allocator.Error!Frame {
        const b = try l.newBody(.{ .kind = kind, .name = name, .params = &.{}, .locals = 0, .may_suspend = false, .first = 0, .last = 0 });
        var f: Frame = .{ .l = l, .body = b, .kind = kind, .checker = checker };
        _ = try f.addSlot("it");
        return f;
    }

    fn addSlot(f: *Frame, name: []const u8) Allocator.Error!u32 {
        if (f.names.get(name)) |s| return s;
        const s: u32 = @intCast(f.slots.items.len);
        try f.slots.append(f.l.a, name);
        try f.names.put(f.l.a, name, s);
        return s;
    }

    /// One slot per parameter: a plain name's own, else an argument slot;
    /// then the names the patterns bind, left to right.
    fn parameters(f: *Frame, params: []const *Pattern) Allocator.Error![]const []const u8 {
        var shown: std.ArrayList([]const u8) = .empty;
        for (params) |p| {
            if (p.data == .name and p.bind_as == null) {
                _ = try f.addSlot(f.l.text(p.data.name));
                try shown.append(f.l.a, f.l.text(p.data.name));
            } else {
                const s: u32 = @intCast(f.slots.items.len);
                try f.slots.append(f.l.a, try f.l.print("({d})", .{s}));
                try shown.append(f.l.a, "…");
            }
        }
        for (params) |p| {
            var names: std.ArrayList(Tok) = .empty;
            try patternNames(f.l, p, &names);
            for (names.items) |t| _ = try f.addSlot(f.l.text(t));
        }
        return shown.items;
    }

    /// The captures, then the body's other locals in the order of their
    /// first binding sites, then the temps.
    fn finishSlots(f: *Frame) Allocator.Error!void {
        if (f.checker) |cb| {
            f.capture_names = cb.captures;
            f.body.info.capture_names = cb.captures;
            f.body.info.capture_slot = @intCast(f.slots.items.len);
            for (cb.captures) |c| _ = try f.addSlot(c);
            f.body.info.captures = @intCast(cb.captures.len);
            const order = try f.l.a.alloc(usize, cb.locals.len);
            for (order, 0..) |*o, i| o.* = i;
            std.mem.sort(usize, order, cb, struct {
                fn less(b: *const check.Body, x: usize, y: usize) bool {
                    return b.binding[x] < b.binding[y];
                }
            }.less);
            for (order) |i| _ = try f.addSlot(cb.locals[i]);
        }
        f.first_temp = @intCast(f.slots.items.len);
        f.temp_base = f.first_temp;
    }

    fn temp(f: *Frame) Allocator.Error!u32 {
        var s = f.temp_base;
        while (s < f.slots.items.len) : (s += 1) {
            const i = s - f.first_temp;
            if (i < f.in_use.items.len and !f.in_use.items[i]) break;
        }
        if (s == f.slots.items.len) try f.slots.append(f.l.a, try f.l.print("({d})", .{s}));
        const i = s - f.first_temp;
        while (f.in_use.items.len <= i) try f.in_use.append(f.l.a, false);
        f.in_use.items[i] = true;
        return s;
    }

    fn release(f: *Frame, s: u32) void {
        f.in_use.items[s - f.first_temp] = false;
    }

    fn pc(f: *Frame) u32 {
        return @intCast(f.body.code.items.len);
    }

    fn newLabel(f: *Frame) Allocator.Error!u32 {
        try f.body.labels.append(f.l.a, null);
        return @intCast(f.body.labels.items.len - 1);
    }

    fn mark(f: *Frame, label: u32) Allocator.Error!void {
        f.body.labels.items[label] = f.pc();
    }

    fn labelPc(f: *Frame, label: u32) u32 {
        return f.body.labels.items[label].?;
    }

    fn emitAt(f: *Frame, op: Opcode, operands: []const Operand, at: Position, note: []const u8) Allocator.Error!void {
        try f.body.code.append(f.l.a, .{ .op = op, .operands = try f.l.a.dupe(Operand, operands), .position = at, .note = note });
    }

    fn emit(f: *Frame, op: Opcode, operands: []const Operand, at: Tok, note: []const u8) Allocator.Error!void {
        try f.emitAt(op, operands, f.l.position(at), note);
    }

    fn slotName(f: *Frame, s: u32) []const u8 {
        return f.slots.items[s];
    }

    fn load(f: *Frame, s: u32, at: Tok) Allocator.Error!void {
        try f.emit(.load, &.{.{ .int = s }}, at, f.slotName(s));
    }

    fn store(f: *Frame, s: u32, at: Tok) Allocator.Error!void {
        try f.emit(.store, &.{.{ .int = s }}, at, f.slotName(s));
    }

    fn constAt(f: *Frame, index: u32, at: Tok) Allocator.Error!void {
        try f.emit(.@"const", &.{.{ .int = index }}, at, f.l.constants.items[index]);
    }

    fn jump(f: *Frame, op: Opcode, label: u32, at: Tok) Allocator.Error!void {
        try f.emit(op, &.{.{ .label = label }}, at, "");
    }

    fn nothing(f: *Frame) Allocator.Error!u32 {
        return f.l.constant("nothing", "nothing");
    }

    /// A body's closing `const nothing` and `return`.
    fn endAt(f: *Frame, at: Position) Allocator.Error!void {
        const n = try f.nothing();
        try f.emitAt(.@"const", &.{.{ .int = n }}, at, f.l.constants.items[n]);
        try f.emitAt(.@"return", &.{}, at, "");
    }

    fn done(f: *Frame, params: []const []const u8) Allocator.Error!*BodyCode {
        f.body.info.params = params;
        f.body.info.locals = @intCast(f.slots.items.len);
        return f.body;
    }

    // ------------------------------------------------------------ statements

    fn block(f: *Frame, b: ast.Block) Allocator.Error!void {
        for (b) |st| try f.stmt(st);
    }

    fn stmt(f: *Frame, st: *const Stmt) Allocator.Error!void {
        const first = st.first;
        switch (st.data) {
            .put => |p| try f.write(first, p.target, .{ .put = p }),
            .let => |let| {
                try f.expr(let.value);
                const t = try f.temp();
                try f.store(t, first);
                const fail = try f.newLabel();
                const ok = try f.newLabel();
                try f.testPattern(let.pattern, t, fail, .temps, false);
                f.release(t);
                try f.moves(first);
                try f.jump(.jump, ok, first);
                try f.mark(fail);
                try f.raise("no match", first);
                try f.mark(ok);
            },
            .set => |x| try f.set(first, x.target, x.value),
            .arithmetic => |ar| try f.write(first, ar.target, .{ .arithmetic = ar }),
            .delete => |e| try f.delete(first, e),
            .send => |s| try f.send(first, s),
            .ask => |op| try f.operation(first, op, true, false),
            .tell => |op| try f.operation(first, op, false, false),
            .tell_block => |tb| for (tb.lines) |line| {
                var op = line;
                op.target = tb.target;
                try f.operation(line.operation, op, false, true);
            },
            .@"return", .veto => |value| {
                if (value) |e| try f.expr(e) else try f.constAt(try f.nothing(), first);
                try f.leave(first, if (st.data == .veto) .veto else .@"return");
            },
            .pass => |p| {
                const name = if (p.any) "any message" else try f.l.selector(p.name, p.labels);
                try f.leave(first, .{ .pass = name });
            },
            .exit_repeat, .next_repeat => try f.loopJump(first, st.data == .next_repeat),
            .throw => |e| {
                try f.expr(e);
                try f.emit(.throw, &.{}, first, "");
            },
            .replace => |r| try f.write(first, r.target, .{ .replace = r }),
            .choose => |c| {
                for (c.args) |arg| try f.expr(arg);
                try f.emit(.choose_offer, &.{ .{ .text = f.l.text(c.name) }, .{ .int = @intCast(c.args.len) } }, first, "");
            },
            .call => |cs| {
                try f.call(cs.call, cs.wait != null);
                try f.store(0, first);
            },
            .command => |c| try f.command(first, c),
            .wait => |e| {
                try f.expr(e);
                try f.emit(.wait, &.{}, first, "");
            },
            .wait_for => |w| try f.waitFor(first, w),
            .wait_block => |w| try f.waitBlock(first, w),
            .join => |j| {
                try f.emit(.join_start, &.{}, first, "");
                const saved = f.join;
                f.join = true;
                try f.block(j.body);
                f.join = saved;
                try f.emit(.join_end, &.{}, j.end, "");
                try f.store(0, first);
            },
            .@"if" => |i| try f.ifStatement(first, i),
            .repeat => |r| try f.repeat(first, r),
            .match => |m| try f.match(first, m),
            .@"try" => |t| try f.tryStatement(t, first),
            .timeout => |t| {
                try f.expr(t.duration);
                try f.emit(.timeout_start, &.{}, first, "");
                f.depth += 1;
                try f.exits.append(f.l.a, .timeout);
                try f.block(t.body);
                _ = f.exits.pop();
                f.depth -= 1;
                try f.emit(.timeout_end, &.{}, first, "");
            },
        }
    }

    fn raise(f: *Frame, code: []const u8, at: Tok) Allocator.Error!void {
        try f.emit(.raise, &.{.{ .text = code }}, at, "");
    }

    /// The temp bindings' `move`s into their names' slots, in binding
    /// order.
    fn moves(f: *Frame, at: Tok) Allocator.Error!void {
        for (f.pending.items) |b| {
            const s = f.names.get(b.name).?;
            try f.emit(.move, &.{ .{ .int = b.temp }, .{ .int = s } }, at, try f.l.print("{s}, {s}", .{ f.slotName(b.temp), f.slotName(s) }));
            f.release(b.temp);
        }
        f.pending.clearRetainingCapacity();
    }

    const Leave = union(enum) { @"return", veto, pass: []const u8 };

    /// `return`, `veto` and `pass` leave the body through every open
    /// `finally` block, innermost first.
    fn leave(f: *Frame, at: Tok, how: Leave) Allocator.Error!void {
        const op: Opcode = switch (how) {
            .@"return" => .@"return",
            .veto => .veto,
            .pass => .pass,
        };
        const operands: []const Operand = switch (how) {
            .pass => |m| &.{.{ .text = m }},
            else => &.{},
        };
        const outer = f.outermostFinally(0) orelse return f.emit(op, operands, at, "");
        var t: ?u32 = null;
        if (how != .pass) {
            t = try f.temp();
            try f.store(t.?, at);
        }
        const start = f.pc();
        try f.copies(0, at);
        if (t) |x| try f.load(x, at);
        try f.emit(op, operands, at, "");
        if (t) |x| f.release(x);
        f.exclude(outer, start);
    }

    /// The `exits` index of the outermost `try` from `from` in whose
    /// `finally` block an exit copies.
    fn outermostFinally(f: *Frame, from: usize) ?usize {
        for (f.exits.items[from..], from..) |e, i| switch (e) {
            .finally => |fin| if (fin.block != null) return i,
            else => {},
        };
        return null;
    }

    /// Copies, innermost first, every `finally` block and Timeout Block end
    /// from the innermost open construct out to index `outer` of `exits`.
    fn copies(f: *Frame, outer: usize, at: Tok) Allocator.Error!void {
        var i = f.exits.items.len;
        while (i > outer) {
            i -= 1;
            switch (f.exits.items[i]) {
                .finally => |fin| if (fin.block) |b| {
                    // The copy runs with only the constructs outside it open.
                    const all = f.exits;
                    const exits = try f.l.a.dupe(Exit, f.exits.items[0..i]);
                    f.exits = .fromOwnedSlice(exits);
                    try f.block(b);
                    f.exits = all;
                },
                .timeout => try f.emit(.timeout_end, &.{}, at, ""),
                .loop => {},
            }
        }
    }

    /// Cuts the instructions from `start` to here out of the spans of every
    /// `try` from `exits` index `outer` in.
    fn exclude(f: *Frame, outer: usize, start: u32) void {
        for (f.exits.items[outer..]) |e| switch (e) {
            .finally => |fin| f.tries.items[fin.try_index].exclusions.append(f.l.a, .{ start, f.pc() }) catch {},
            else => {},
        };
    }

    fn loopJump(f: *Frame, at: Tok, next_pass: bool) Allocator.Error!void {
        var i = f.exits.items.len;
        while (i > 0) {
            i -= 1;
            if (f.exits.items[i] == .loop) break;
        }
        const loop = f.exits.items[i].loop;
        const start = f.pc();
        try f.copies(i + 1, at);
        try f.jump(.jump, if (next_pass) loop.next else loop.exit, at);
        if (f.outermostFinally(i + 1)) |outer| f.exclude(outer, start);
    }

    fn guard(f: *Frame, g: ast.Guard, fail: u32) Allocator.Error!void {
        try f.expr(g.condition);
        try f.jump(.branch_false, fail, exprFirst(f.l, g.condition));
    }

    fn ifStatement(f: *Frame, first: Tok, i: ast.If) Allocator.Error!void {
        const end = try f.newLabel();
        for (i.arms, 0..) |arm, n| {
            const next_arm = try f.newLabel();
            try f.expr(arm.condition);
            try f.jump(.branch_false, next_arm, first);
            try f.block(arm.body);
            const last = n + 1 == i.arms.len;
            if (!last or i.@"else" != null) try f.jump(.jump, end, first);
            try f.mark(next_arm);
        }
        if (i.@"else") |b| try f.block(b);
        try f.mark(end);
    }

    fn repeat(f: *Frame, first: Tok, r: ast.Repeat) Allocator.Error!void {
        var collect: ?u32 = null;
        if (r.collecting) |c| {
            try f.emit(.list, &.{.{ .int = 0 }}, c.keyword, "");
            collect = f.names.get(f.l.text(c.into)).?;
            try f.store(collect.?, c.keyword);
        }
        const top = try f.newLabel();
        const exit = try f.newLabel();
        var iterator = false;
        switch (r.head) {
            .for_each => |fe| {
                try f.expr(fe.source);
                try f.emit(.iterate, &.{}, first, "");
                iterator = true;
                f.depth += 1;
                try f.mark(top);
                try f.jump(.next, exit, first);
                const p = fe.pattern;
                if (p.data == .name and p.bind_as == null) {
                    try f.store(f.names.get(f.l.text(p.data.name)).?, first);
                } else {
                    const t = try f.temp();
                    try f.store(t, first);
                    const fail = try f.newLabel();
                    const ok = try f.newLabel();
                    try f.testPattern(p, t, fail, .temps, false);
                    f.release(t);
                    try f.moves(first);
                    try f.jump(.jump, ok, first);
                    try f.mark(fail);
                    try f.raise("no match", first);
                    try f.mark(ok);
                }
            },
            .times => |e| {
                try f.expr(e);
                try f.emit(.iterate_times, &.{}, first, "");
                iterator = true;
                f.depth += 1;
                try f.mark(top);
                try f.jump(.next, exit, first);
                try f.emit(.pop, &.{}, first, "");
            },
            .@"while", .until => |e| {
                try f.mark(top);
                try f.expr(e);
                try f.jump(if (r.head == .@"while") .branch_false else .branch_true, exit, first);
            },
            .forever => try f.mark(top),
        }
        try f.exits.append(f.l.a, .{ .loop = .{ .next = top, .exit = exit, .iterator = iterator } });
        try f.block(r.body);
        _ = f.exits.pop();
        if (r.collecting) |c| {
            try f.load(collect.?, c.keyword);
            try f.expr(c.value);
            try f.emit(.list_append, &.{}, c.keyword, "");
            try f.store(collect.?, c.keyword);
        }
        try f.jump(.jump, top, first);
        try f.mark(exit);
        if (iterator) {
            try f.emit(.pop, &.{}, first, "");
            f.depth -= 1;
        }
    }

    fn match(f: *Frame, first: Tok, m: ast.Match) Allocator.Error!void {
        try f.expr(m.subject);
        const t = try f.temp();
        try f.store(t, first);
        const end = try f.newLabel();
        const fold = m.ignoring != null;
        for (m.branches) |br| {
            const fail = try f.newLabel();
            const start = f.pc();
            if (br.contains) {
                try f.load(t, br.pattern.first);
                try f.textPatternValue(br.pattern.data.text);
                try f.emit(.match_search, if (fold) &.{ .{ .text = "fold" }, .{ .label = fail } } else &.{.{ .label = fail }}, br.pattern.first, "");
                try f.captures(br.pattern.data.text, br.pattern.first, .temps);
            } else try f.testPattern(br.pattern, t, fail, .temps, fold);
            if (br.guard) |g| try f.guard(g, fail);
            try f.body.unwind.append(f.l.a, .{ .first = start, .last = f.pc() - 1, .kind = .guard, .target = fail, .depth = f.depth });
            const entry = f.body.unwind.items.len - 1;
            try f.moves(br.keyword);
            try f.block(br.body);
            try f.jump(.jump, end, br.keyword);
            try f.mark(fail);
            f.body.unwind.items[entry].target = f.labelPc(fail);
        }
        if (m.@"else") |b| try f.block(b);
        try f.mark(end);
        f.release(t);
    }

    // ------------------------------------------------------------ try

    /// Whether an error pattern is a text literal, short for `{code: "…"}`.
    fn isCodeShorthand(f: *Frame, p: *const ast.Pattern) bool {
        return p.data == .literal and f.l.tree.tokens[p.data.literal.value].kind == .text;
    }

    /// Tests the error in `slot` as `{code: "…"}`, for a text literal head.
    fn codeShorthand(f: *Frame, p: *const ast.Pattern, slot: u32, fail: u32) Allocator.Error!void {
        const l = f.l;
        try f.load(slot, p.first);
        try f.jump(.test_map, fail, p.first);
        try f.load(slot, p.first);
        try f.emit(.map_get, &.{ .{ .text = "\"code\"" }, .{ .label = fail } }, p.first, "");
        const tmp = try f.temp();
        try f.store(tmp, p.first);
        try f.load(tmp, p.first);
        const k = try f.literalConstant(p.data.literal);
        try f.emit(.test_constant, &.{ .{ .int = k }, .{ .label = fail } }, p.first, l.constants.items[k]);
        f.release(tmp);
    }

    fn tryStatement(f: *Frame, t: ast.Try, at: Tok) Allocator.Error!void {
        const l = f.l;
        const index = f.tries.items.len;
        try f.tries.append(l.a, .{});
        const fin: ?ast.Block = if (t.finally) |x| x.body else null;
        const after = try f.newLabel();
        // The protected body, with this `try` open.
        try f.exits.append(l.a, .{ .finally = .{ .block = fin, .try_index = index } });
        const body_start = f.pc();
        try f.block(t.body);
        const body_end = f.pc();
        // The normal path: a copy of the `finally` block, then the jump.
        try f.normalExit(fin, index, after, at);
        // The catch handler.
        var guards: std.ArrayList(Unwind) = .empty;
        var handler_start: u32 = 0;
        var handler_end: u32 = 0;
        if (t.catches.len > 0) {
            handler_start = f.pc();
            // Dispatch scratch slots come after every temp the body used.
            const saved_base = f.temp_base;
            f.temp_base = @intCast(f.slots.items.len);
            const err = try f.temp();
            try f.store(err, t.catches[0].keyword);
            for (t.catches) |c| {
                const fail = try f.newLabel();
                const start = f.pc();
                if (f.isCodeShorthand(c.pattern)) {
                    try f.codeShorthand(c.pattern, err, fail);
                } else try f.testPattern(c.pattern, err, fail, .temps, false);
                if (c.guard) |g| try f.guard(g, fail);
                try guards.append(l.a, .{ .first = start, .last = f.pc() - 1, .kind = .guard, .target = 0, .depth = f.depth });
                if (c.recovery == null) {
                    try f.emit(.catch_accept, &.{}, c.keyword, "");
                    try f.moves(c.keyword);
                    try f.block(c.body);
                    try f.normalExit(fin, index, after, c.keyword);
                } else {
                    // A Recovery Catch falls through to the next clause.
                    try f.moves(c.keyword);
                    try f.block(c.body);
                }
                try f.mark(fail);
                guards.items[guards.items.len - 1].target = f.labelPc(fail);
            }
            try f.emit(.catch_next, &.{}, t.catches[t.catches.len - 1].keyword, "");
            handler_end = f.pc();
            f.release(err);
            f.temp_base = saved_base;
        }
        // Offer actions, outside their own catch and offer ranges.
        var offer_entries: std.ArrayList(Offer) = .empty;
        const actions_start = f.pc();
        for (t.offers) |o| {
            var binds: std.ArrayList(u32) = .empty;
            for (o.params) |p| try binds.append(l.a, f.names.get(l.text(p)).?);
            try offer_entries.append(l.a, .{ .name = l.text(o.name), .entry = f.pc(), .binds = binds.items });
            try f.block(o.body);
            try f.normalExit(fin, index, after, o.keyword);
        }
        const actions_end = f.pc();
        _ = f.exits.pop();
        // The cleanup copy.
        var cleanup: u32 = 0;
        if (fin) |b| {
            cleanup = f.pc();
            try f.block(b);
            try f.emit(.end_cleanup, &.{}, at, "");
        }
        try f.mark(after);
        const excluded = f.tries.items[index].exclusions.items;
        if (t.catches.len > 0) try f.spans(.@"catch", body_start, body_end, excluded, handler_start, f.depth);
        try f.body.unwind.appendSlice(l.a, guards.items);
        if (t.offers.len > 0) {
            try f.spans(.offer, body_start, body_end, excluded, 0, f.depth);
            try f.body.offers.append(l.a, .{ .body = 0, .depth = f.depth, .end = f.labelPc(after), .offers = offer_entries.items });
        }
        if (fin != null) {
            try f.spans(.finally, body_start, body_end, excluded, cleanup, f.depth);
            if (t.catches.len > 0) try f.spans(.finally, handler_start + 1, handler_end, excluded, cleanup, f.depth);
            if (actions_end > actions_start) try f.spans(.finally, actions_start, actions_end, excluded, cleanup, f.depth);
        }
    }

    /// Leaving a `try` part normally: a copy of its `finally` block and the
    /// jump past it, both outside its spans.
    fn normalExit(f: *Frame, fin: ?ast.Block, index: usize, after: u32, at: Tok) Allocator.Error!void {
        const start = f.pc();
        if (fin) |b| {
            const open = f.exits.pop().?;
            try f.block(b);
            try f.exits.append(f.l.a, open);
        }
        try f.jump(.jump, after, at);
        try f.tries.items[index].exclusions.append(f.l.a, .{ start, f.pc() });
    }

    /// Entries for `[from, to)` less the excluded ranges, one per span.
    fn spans(f: *Frame, kind: @FieldType(Unwind, "kind"), from: u32, to: u32, excluded: []const [2]u32, target: u32, depth: u32) Allocator.Error!void {
        var s = from;
        while (s < to) {
            var cut: ?[2]u32 = null;
            for (excluded) |x| {
                if (x[1] > s and x[0] < to and (cut == null or x[0] < cut.?[0])) {
                    if (x[0] <= s) {
                        cut = x;
                        break;
                    }
                    cut = x;
                }
            }
            if (cut) |x| {
                if (x[0] <= s) {
                    s = x[1];
                    continue;
                }
                try f.body.unwind.append(f.l.a, .{ .first = s, .last = x[0] - 1, .kind = kind, .target = target, .depth = depth });
                s = x[1];
            } else {
                try f.body.unwind.append(f.l.a, .{ .first = s, .last = to - 1, .kind = kind, .target = target, .depth = depth });
                break;
            }
        }
    }

    // ------------------------------------------------------------ calls and effects

    fn command(f: *Frame, first: Tok, c: ast.Command) Allocator.Error!void {
        const l = f.l;
        const name = try l.selector(c.name, c.labels);
        if (std.mem.eql(u8, name, "say") and !l.checked.suspends.contains("say")) {
            for (c.args) |arg| try f.expr(arg);
            try f.emit(.tell, &.{ .{ .text = "console" }, .{ .text = "write" }, .{ .int = @intCast(c.args.len) } }, first, "");
            return;
        }
        for (c.args) |arg| try f.expr(arg);
        const n: i64 = @intCast(c.args.len);
        const waits = c.wait != null;
        if (l.checked.suspends.contains(name) or l.importedHandler(l.text(c.name))) {
            try f.emit(if (waits) .call_handler_wait else .call_handler, &.{ .{ .text = name }, .{ .int = n } }, first, "");
            try f.store(0, first);
        } else if (waits) {
            try f.emit(.send_up_wait, &.{ .{ .text = name }, .{ .int = n } }, first, "");
            try f.store(0, first);
        } else try f.emit(.send_up, &.{ .{ .text = name }, .{ .int = n } }, first, "");
    }

    fn send(f: *Frame, first: Tok, s: ast.Send) Allocator.Error!void {
        const l = f.l;
        const waits = s.wait != null;
        var spread = false;
        for (s.args) |arg| if (arg.spread != null) {
            spread = true;
        };
        const name: ?[]const u8 = if (s.name) |n| try l.selector(n, s.labels) else null;
        if (spread) {
            if (s.computed) |e| try f.expr(e) else try f.constAt(try f.textConstant(name.?), first);
            try f.emit(.list, &.{.{ .int = 0 }}, first, "");
            for (s.args) |arg| {
                try f.expr(arg.value);
                try f.emit(if (arg.spread != null) .list_extend else .list_append, &.{}, first, "");
            }
            try f.receiver(s.target);
            if (f.join and waits) return f.emit(.join_send_spread, &.{}, first, "");
            try f.emit(if (waits) .send_spread_wait else .send_spread, &.{}, first, "");
            if (waits) try f.store(0, first);
            return;
        }
        if (s.computed) |e| try f.expr(e);
        for (s.args) |arg| try f.expr(arg.value);
        try f.receiver(s.target);
        const n: i64 = @intCast(s.args.len);
        if (s.computed != null) {
            if (f.join and waits) return f.emit(.join_send_named, &.{.{ .int = n }}, first, "");
            try f.emit(if (waits) .send_named_wait else .send_named, &.{.{ .int = n }}, first, "");
        } else {
            if (f.join and waits) return f.emit(.join_send, &.{ .{ .text = name.? }, .{ .int = n } }, first, "");
            try f.emit(if (waits) .send_wait else .send, &.{ .{ .text = name.? }, .{ .int = n } }, first, "");
        }
        if (waits) try f.store(0, first);
    }

    /// A `send`'s receiver or a `wait for`'s `from`: a Name that resolves to
    /// nothing names a Script.
    fn receiver(f: *Frame, e: *const Expr) Allocator.Error!void {
        if (e.data == .name) if (f.l.checked.refs.get(e.data.name)) |r| if (r == .script) {
            const name = try f.l.object(f.l.text(e.data.name));
            return f.emit(.load_object, &.{.{ .text = name }}, e.pos, "");
        };
        try f.expr(e);
    }

    fn operation(f: *Frame, at: Tok, op: ast.Operation, ask: bool, line: bool) Allocator.Error!void {
        const l = f.l;
        const grant = l.text(op.target.?.data.name);
        const name = l.text(op.operation);
        for (op.args) |arg| try f.expr(arg);
        const n: i64 = @intCast(op.args.len);
        const operands: []const Operand = &.{ .{ .text = grant }, .{ .text = name }, .{ .int = n } };
        const mode = l.operationMode(grant, name);
        const waits = op.wait != null;
        if (!ask and !line) return f.emit(.tell, operands, at, "");
        if (line and !waits and mode == .fire_and_forget) return f.emit(.tell, operands, at, "");
        if (waits) {
            if (f.join) return f.emit(.join_ask, operands, at, "");
            try f.emit(.ask_wait, operands, at, "");
        } else try f.emit(.ask, operands, at, "");
        try f.store(0, at);
    }

    fn waitFor(f: *Frame, first: Tok, w: ast.WaitFor) Allocator.Error!void {
        const branch = try f.eventBranch(w.event, null, first);
        if (w.timeout) |e| try f.expr(e);
        const index: i64 = @intCast(f.l.events.items.len);
        const branches = try f.l.a.alloc(Branch, 1);
        branches[0] = branch;
        try f.l.events.append(f.l.a, .{ .branches = branches, .timeout = w.timeout != null });
        try f.emit(.wait_for, &.{.{ .int = index }}, first, "");
        try f.store(0, first);
    }

    fn waitBlock(f: *Frame, first: Tok, w: ast.WaitBlock) Allocator.Error!void {
        var branches: std.ArrayList(Branch) = .empty;
        for (w.branches) |br| switch (br.data) {
            .when => |wh| try branches.append(f.l.a, try f.eventBranch(wh.event, wh.guard, br.keyword)),
            .after => |e| {
                try f.expr(e);
                try branches.append(f.l.a, .after);
            },
        };
        const index: i64 = @intCast(f.l.events.items.len);
        try f.l.events.append(f.l.a, .{ .branches = branches.items, .timeout = false });
        try f.emit(.wait_for_any, &.{.{ .int = index }}, first, "");
        const t = try f.temp();
        try f.store(t, first);
        try f.store(0, first);
        const end = try f.newLabel();
        for (w.branches, 0..) |br, i| {
            const fail = try f.newLabel();
            try f.load(t, br.keyword);
            try f.constAt(try f.numberConstant(try f.l.print("{d}", .{i + 1})), br.keyword);
            try f.emit(.equal, &.{}, br.keyword, "");
            try f.jump(.branch_false, fail, br.keyword);
            try f.block(br.body);
            try f.jump(.jump, end, br.keyword);
            try f.mark(fail);
        }
        try f.mark(end);
        f.release(t);
    }

    /// One `when` branch: its `from`, the loads of its captures, its entry
    /// and its test body.
    fn eventBranch(f: *Frame, ev: ast.Event, guard_clause: ?ast.Guard, at: Tok) Allocator.Error!Branch {
        const l = f.l;
        if (ev.from) |e| try f.receiver(e);
        const message = try l.selector(ev.name, ev.labels);
        if (ev.patterns.len == 0 and guard_clause == null) return .{ .when = .{ .message = message, .from = ev.from != null, .body = null, .captures = 0, .binds = &.{} } };
        // Captures: the locals of this body the patterns and Guard read.
        var bound: std.ArrayList(Tok) = .empty;
        for (ev.patterns) |p| try patternNames(l, p, &bound);
        var reads: std.ArrayList([]const u8) = .empty;
        for (ev.patterns) |p| try patternReads(l, p, &reads);
        if (guard_clause) |g| try exprReads(l, g.condition, &reads);
        var captured: std.ArrayList([]const u8) = .empty;
        for (reads.items) |name| {
            var own = false;
            for (bound.items) |b| if (std.mem.eql(u8, l.text(b), name)) {
                own = true;
            };
            if (own or among(name, captured.items)) continue;
            if (f.names.get(name) == null) continue;
            try captured.append(l.a, name);
        }
        for (captured.items) |name| try f.load(f.names.get(name).?, at);
        const body_index = try l.reserve();
        var e = try Frame.init(l, .event, message, null);
        const params = try e.parameters(ev.patterns);
        e.capture_names = captured.items;
        e.body.info.capture_names = captured.items;
        e.body.info.capture_slot = @intCast(e.slots.items.len);
        for (captured.items) |name| _ = try e.addSlot(name);
        e.body.info.captures = @intCast(captured.items.len);
        e.first_temp = @intCast(e.slots.items.len);
        e.temp_base = e.first_temp;
        const fail = try e.newLabel();
        const start = e.pc();
        for (ev.patterns, 0..) |p, i| {
            if (p.data == .name and p.bind_as == null) continue;
            try e.testPattern(p, @intCast(i + 1), fail, .direct, false);
        }
        if (guard_clause) |g| try e.guard(g, fail);
        if (e.pc() > start) try e.body.unwind.append(l.a, .{ .first = start, .last = e.pc() - 1, .kind = .guard, .target = 0, .depth = 0 });
        const entry = if (e.pc() > start) e.body.unwind.items.len - 1 else null;
        var binds: std.ArrayList(u32) = .empty;
        for (bound.items) |b| {
            try e.load(e.names.get(l.text(b)).?, at);
            try binds.append(l.a, f.names.get(l.text(b)).?);
        }
        try e.emit(.list, &.{.{ .int = @intCast(bound.items.len) }}, at, "");
        try e.emit(.@"return", &.{}, at, "");
        try e.mark(fail);
        try e.emit(.clause_fail, &.{}, at, "");
        if (entry) |g| e.body.unwind.items[g].target = e.labelPc(fail);
        l.bodies.items[body_index] = try e.done(params);
        return .{ .when = .{ .message = message, .from = ev.from != null, .body = body_index, .captures = @intCast(captured.items.len), .binds = binds.items } };
    }

    /// A call: `f(a, …)`, with `and wait` for `call-value-wait`.
    fn call(f: *Frame, e: *const Expr, waits: bool) Allocator.Error!void {
        const l = f.l;
        const c = e.data.call;
        const name = l.text(c.name);
        const n: i64 = @intCast(c.args.len);
        const r = l.checked.refs.get(c.name).?;
        const value_call = switch (r) {
            .local, .captured, .variable, .constant, .object, .script => true,
            .imported => l.imports.get(name).?.kind == .constant,
            else => false,
        };
        switch (value_call) {
            true => {
                try f.nameValue(c.name, r);
                for (c.args) |arg| try f.expr(arg);
                try f.emit(if (waits) .call_value_wait else .call_value, &.{.{ .int = n }}, c.name, "");
                return;
            },
            false => {},
        }
        for (c.args) |arg| try f.expr(arg);
        switch (r) {
            .function => {
                const body = l.functions.get(name).?;
                try f.emit(.call, &.{ .{ .int = body }, .{ .int = n } }, c.name, name);
            },
            .handler => try f.emit(.call_handler, &.{ .{ .text = name }, .{ .int = n } }, c.name, ""),
            .imported => {
                const im = l.imports.get(name).?;
                if (im.kind == .handler) {
                    try f.emit(.call_handler, &.{ .{ .text = im.name }, .{ .int = n } }, c.name, "");
                } else try f.emit(.call_import, &.{ .{ .text = try l.print("{s}:{s}", .{ im.library, im.name }) }, .{ .int = n } }, c.name, "");
            },
            .builtin_function => try f.emit(.call_builtin, &.{ .{ .text = name }, .{ .int = n } }, c.name, ""),
            else => unreachable,
        }
    }

    // ------------------------------------------------------------ containers

    const Write = union(enum) {
        put: ast.Put,
        arithmetic: ast.Arithmetic,
        replace: ast.Replace,
    };

    /// The levels of a Container, from the root's next level out to the
    /// leaf, and its root.
    fn levels(f: *Frame, target: *const Expr, out: *std.ArrayList(Level)) Allocator.Error!*const Expr {
        var e = target;
        while (true) switch (e.data) {
            .chunk => |c| {
                try out.insert(f.l.a, 0, .{ .expr = e });
                e = c.of;
            },
            .key => |k| {
                try out.insert(f.l.a, 0, .{ .expr = e });
                e = k.base;
            },
            .group => |g| e = g,
            else => return e,
        };
    }

    fn levelTok(e: *const Expr) Tok {
        return e.pos;
    }

    fn rootLoad(f: *Frame, root: *const Expr, at: Tok) Allocator.Error!void {
        const name = root.data.name;
        const r = f.l.checked.refs.get(name) orelse check.Ref.local;
        switch (r) {
            .variable => |v| try f.emit(.load_var, &.{.{ .int = v }}, at, f.l.text(name)),
            else => try f.load(f.names.get(f.l.text(name)).?, at),
        }
    }

    fn rootStore(f: *Frame, root: *const Expr, at: Tok) Allocator.Error!void {
        const name = root.data.name;
        const r = f.l.checked.refs.get(name) orelse check.Ref.local;
        switch (r) {
            .variable => |v| try f.emit(.store_var, &.{.{ .int = v }}, at, f.l.text(name)),
            else => try f.store(f.names.get(f.l.text(name)).?, at),
        }
    }

    /// A Container's chain delimiter: the outermost chunk's.
    fn chainDelimiter(target: *const Expr) ?*const Expr {
        return switch (target.data) {
            .chunk => |c| c.delimiter,
            else => null,
        };
    }

    /// One store to the root (chapter 8, Containers).
    fn write(f: *Frame, first: Tok, target: *const Expr, how: Write) Allocator.Error!void {
        var lv: std.ArrayList(Level) = .empty;
        const root = try f.levels(target, &lv);
        const items = lv.items;
        // 1. What the statement evaluates first, into `v`.
        var v: ?u32 = null;
        switch (how) {
            .put => |p| {
                try f.expr(p.value);
                if (items.len == 0 and p.place == .into) return f.rootStore(root, first);
                v = try f.temp();
                try f.store(v.?, first);
            },
            .arithmetic => |ar| if (ar.op == .add or ar.op == .subtract) {
                try f.expr(ar.value);
                v = try f.temp();
                try f.store(v.?, first);
            },
            .replace => |r| {
                try f.expr(r.pattern);
                v = try f.temp();
                try f.store(v.?, first);
            },
        }
        // 2. Each level's index or computed key, from the leaf back.
        try f.indices(items);
        // 3. The delimiter.
        const delim = try f.delimiter(items);
        // 4. The root, and each whole down to the level above the leaf.
        var wholes: std.ArrayList(u32) = .empty;
        if (items.len > 0) {
            const w0 = try f.temp();
            try f.rootLoad(root, first);
            try f.store(w0, first);
            try wholes.append(f.l.a, w0);
            for (items[0 .. items.len - 1], 0..) |level, i| {
                try f.readLevel(level, wholes.items[i], delim);
                const w = try f.temp();
                try f.store(w, level.expr.pos);
                try wholes.append(f.l.a, w);
            }
        }
        // 5. Each level's operands, then the new part, then the sets.
        for (items, 0..) |level, i| try f.levelOperands(level, wholes.items[i]);
        switch (how) {
            .put => |p| {
                if (p.place != .into) try f.oldValue(root, items, wholes.items, delim, first);
                try f.load(v.?, first);
                if (p.place != .into) {
                    const op: Opcode = if (p.place == .after) (if (p.spread) .append_all else .append) else (if (p.spread) .prepend_all else .prepend);
                    try f.emit(op, &.{}, first, "");
                }
            },
            .arithmetic => |ar| {
                try f.oldValue(root, items, wholes.items, delim, first);
                if (ar.op == .multiply or ar.op == .divide) {
                    try f.expr(ar.value);
                    v = try f.temp();
                    try f.store(v.?, first);
                }
                try f.load(v.?, first);
                try f.emit(switch (ar.op) {
                    .add => .add,
                    .subtract => .subtract,
                    .multiply => .multiply,
                    .divide => .divide,
                }, &.{}, first, "");
            },
            .replace => |r| {
                try f.load(v.?, first);
                try f.oldValue(root, items, wholes.items, delim, first);
                try f.replaceLoop(r, first);
            },
        }
        var k = items.len;
        while (k > 0) {
            k -= 1;
            try f.setLevel(items[k], delim);
        }
        try f.rootStore(root, first);
        // 6. Every temp is released.
        for (items) |level| if (level.index) |x| f.release(x);
        for (wholes.items) |w| f.release(w);
        if (delim) |d| f.release(d);
        if (v) |x| f.release(x);
    }

    /// Each level's index or computed key, from the last level back.
    fn indices(f: *Frame, items: []Level) Allocator.Error!void {
        var i = items.len;
        while (i > 0) {
            i -= 1;
            const e = items[i].expr;
            switch (e.data) {
                .chunk => |c| {
                    try f.chunkIndex(c, e.pos);
                    items[i].index = try f.temp();
                    try f.store(items[i].index.?, e.pos);
                },
                .key => |k| if (k.computed) |x| {
                    try f.expr(x);
                    items[i].index = try f.temp();
                    try f.store(items[i].index.?, e.pos);
                },
                else => {},
            }
        }
    }

    /// The delimiter of the outermost level's `delimited by`, into a temp.
    fn delimiter(f: *Frame, items: []Level) Allocator.Error!?u32 {
        if (items.len == 0) return null;
        const outer = items[items.len - 1].expr;
        const d = chainDelimiter(outer) orelse return null;
        try f.expr(d);
        const t = try f.temp();
        try f.store(t, outer.pos);
        return t;
    }

    /// The leaf's old value: the root's `load`, or its index or key temp,
    /// the whole above it and its read.
    fn oldValue(f: *Frame, root: *const Expr, items: []Level, wholes: []const u32, delim: ?u32, first: Tok) Allocator.Error!void {
        if (items.len == 0) return f.rootLoad(root, first);
        try f.readLevel(items[items.len - 1], wholes[items.len - 1], delim);
    }

    /// Reads one level of a Container into the next whole.
    fn readLevel(f: *Frame, level: Level, whole: u32, delim: ?u32) Allocator.Error!void {
        const e = level.expr;
        switch (e.data) {
            .chunk => |c| {
                try f.load(level.index.?, e.pos);
                try f.load(whole, e.pos);
                if (c.kind == .item and delim != null) {
                    try f.load(delim.?, e.pos);
                    try f.emit(.chunk_get_delimited, &.{.{ .text = "item" }}, e.pos, "");
                } else try f.emit(.chunk_get, &.{.{ .text = chunkName(c.kind) }}, e.pos, "");
            },
            .key => |k| {
                if (k.computed != null) {
                    try f.load(level.index.?, e.pos);
                    try f.load(whole, e.pos);
                    try f.emit(.get_key_computed, &.{}, e.pos, "");
                } else {
                    try f.load(whole, e.pos);
                    try f.emit(.get_key, &.{.{ .text = try f.keyText(k.key.?) }}, e.pos, "");
                }
            },
            else => unreachable,
        }
    }

    /// A level's index or key temp and the whole above it, before the next
    /// level's write.
    fn levelOperands(f: *Frame, level: Level, whole: u32) Allocator.Error!void {
        const e = level.expr;
        switch (e.data) {
            .chunk => {
                try f.load(level.index.?, e.pos);
                try f.load(whole, e.pos);
            },
            .key => |k| {
                if (k.computed != null) try f.load(level.index.?, e.pos);
                try f.load(whole, e.pos);
            },
            else => unreachable,
        }
    }

    fn setLevel(f: *Frame, level: Level, delim: ?u32) Allocator.Error!void {
        const e = level.expr;
        switch (e.data) {
            .chunk => |c| {
                if (c.kind == .item and delim != null) {
                    try f.load(delim.?, e.pos);
                    try f.emit(.chunk_set_delimited, &.{.{ .text = "item" }}, e.pos, "");
                } else try f.emit(.chunk_set, &.{.{ .text = chunkName(c.kind) }}, e.pos, "");
            },
            .key => |k| {
                if (k.computed != null) {
                    try f.emit(.set_key_computed, &.{}, e.pos, "");
                } else try f.emit(.set_key, &.{.{ .text = try f.keyText(k.key.?) }}, e.pos, "");
            },
            else => unreachable,
        }
    }

    fn delete(f: *Frame, first: Tok, target: *const Expr) Allocator.Error!void {
        var lv: std.ArrayList(Level) = .empty;
        const root = try f.levels(target, &lv);
        const items = lv.items;
        if (items.len == 0) {
            try f.constAt(try f.nothing(), first);
            return f.rootStore(root, first);
        }
        // The write for the Container one level up, with the leaf's index or
        // computed key evaluated first.
        const leaf = &items[items.len - 1];
        try f.indices(items[items.len - 1 ..]);
        const up = items[0 .. items.len - 1];
        try f.indices(up);
        const chain_delim = chainDelimiter(leaf.expr);
        var delim: ?u32 = null;
        if (up.len > 0) if (chain_delim) |d| {
            try f.expr(d);
            delim = try f.temp();
            try f.store(delim.?, up[up.len - 1].expr.pos);
        };
        const skip = try f.newLabel();
        var wholes: std.ArrayList(u32) = .empty;
        if (up.len > 0) {
            const w0 = try f.temp();
            try f.rootLoad(root, first);
            try f.store(w0, first);
            try wholes.append(f.l.a, w0);
            // Every level, the last included, is tested before it is read.
            for (up, 0..) |level, i| {
                try f.testLevel(level, wholes.items[i], delim, skip);
                try f.readLevel(level, wholes.items[i], delim);
                const w = try f.temp();
                try f.store(w, level.expr.pos);
                try wholes.append(f.l.a, w);
            }
            for (up, 0..) |level, i| try f.levelOperands(level, wholes.items[i]);
        }
        // The new part.
        const e = leaf.expr;
        switch (e.data) {
            .chunk => |c| {
                try f.load(leaf.index.?, e.pos);
                if (up.len > 0) try f.load(wholes.items[up.len], up[up.len - 1].expr.pos) else try f.rootLoad(root, first);
                if (c.kind == .item and chain_delim != null) {
                    try f.expr(chain_delim.?);
                    try f.emit(.chunk_delete_delimited, &.{.{ .text = "item" }}, e.pos, "");
                } else try f.emit(.chunk_delete, &.{.{ .text = chunkName(c.kind) }}, e.pos, "");
            },
            .key => |k| {
                if (k.computed != null) try f.load(leaf.index.?, e.pos);
                if (up.len > 0) try f.load(wholes.items[up.len], up[up.len - 1].expr.pos) else try f.rootLoad(root, first);
                if (k.computed != null) {
                    try f.emit(.delete_key_computed, &.{}, e.pos, "");
                } else try f.emit(.delete_key, &.{.{ .text = try f.keyText(k.key.?) }}, e.pos, "");
            },
            else => unreachable,
        }
        var k = up.len;
        while (k > 0) {
            k -= 1;
            try f.setLevel(up[k], delim);
        }
        try f.rootStore(root, first);
        try f.mark(skip);
        for (items) |level| if (level.index) |x| f.release(x);
        for (wholes.items) |w| f.release(w);
        if (delim) |d| f.release(d);
    }

    fn testLevel(f: *Frame, level: Level, whole: u32, delim: ?u32, skip: u32) Allocator.Error!void {
        const e = level.expr;
        switch (e.data) {
            .chunk => |c| {
                try f.load(level.index.?, e.pos);
                try f.load(whole, e.pos);
                if (c.kind == .item and delim != null) {
                    try f.load(delim.?, e.pos);
                    try f.emit(.test_chunk_delimited, &.{ .{ .text = "item" }, .{ .label = skip } }, e.pos, "");
                } else try f.emit(.test_chunk, &.{ .{ .text = chunkName(c.kind) }, .{ .label = skip } }, e.pos, "");
            },
            .key => |k| {
                if (k.computed != null) {
                    try f.load(level.index.?, e.pos);
                    try f.load(whole, e.pos);
                    try f.emit(.test_key_computed, &.{.{ .label = skip }}, e.pos, "");
                } else {
                    try f.load(whole, e.pos);
                    try f.emit(.test_key, &.{ .{ .text = try f.keyText(k.key.?) }, .{ .label = skip } }, e.pos, "");
                }
            },
            else => unreachable,
        }
    }

    fn set(f: *Frame, first: Tok, target: *const Expr, value: *const Expr) Allocator.Error!void {
        var e = target;
        while (e.data == .group) e = e.data.group;
        const k = e.data.key;
        if (k.computed) |x| try f.expr(x);
        try f.expr(k.base);
        try f.expr(value);
        if (k.computed != null) {
            try f.emit(.set_property_computed, &.{}, first, "");
        } else try f.emit(.set_property, &.{.{ .text = try f.keyText(k.key.?) }}, first, "");
    }

    /// With the pattern and the text on the stack, the replacement loop.
    fn replaceLoop(f: *Frame, r: ast.Replace, at: Tok) Allocator.Error!void {
        try f.emit(.replace_start, &.{.{ .int = if (r.first != null) 1 else 0 }}, at, "");
        const top = try f.newLabel();
        const end = try f.newLabel();
        try f.mark(top);
        try f.jump(.replace_next, end, at);
        const t = try f.temp();
        try f.store(t, at);
        if (r.pattern.data == .text_pattern) {
            var names: std.ArrayList(Tok) = .empty;
            for (r.pattern.data.text_pattern.elements) |el| try elementNames(f.l, el, &names);
            for (names.items) |n| {
                try f.load(t, at);
                try f.emit(.get_key, &.{.{ .text = "\"captures\"" }}, at, "");
                try f.emit(.get_key, &.{.{ .text = try f.keyText(n) }}, at, "");
                try f.store(f.names.get(f.l.text(n)).?, at);
            }
        }
        f.release(t);
        try f.expr(r.value);
        try f.emit(.replace_put, &.{}, at, "");
        try f.jump(.jump, top, at);
        try f.mark(end);
        try f.emit(.replace_end, &.{}, at, "");
    }

    // ------------------------------------------------------------ patterns

    /// Tests the value in slot `s` against `p`, jumping to `fail`.
    fn testPattern(f: *Frame, p: *const Pattern, s: u32, fail: u32, binding: Binding, fold: bool) Allocator.Error!void {
        const l = f.l;
        const at = p.first;
        switch (p.data) {
            .name => |t| {
                try f.load(s, at);
                try f.bindName(t, binding, at);
            },
            .wildcard => {},
            .pin => |t| {
                try f.load(s, at);
                try f.nameValueAt(t, l.checked.refs.get(t).?, at);
                try f.jump(.test_equal, fail, at);
            },
            .literal => |lit| {
                try f.load(s, at);
                const c = try f.literalConstant(lit);
                const note = l.constants.items[c];
                if (fold) {
                    try f.emit(.test_constant, &.{ .{ .int = c }, .{ .text = "fold" }, .{ .label = fail } }, at, note);
                } else try f.emit(.test_constant, &.{ .{ .int = c }, .{ .label = fail } }, at, note);
            },
            .list => |items| {
                var count: i64 = 0;
                var rest = false;
                for (items) |item| switch (item) {
                    .pattern => count += 1,
                    .rest => rest = true,
                };
                try f.load(s, at);
                try f.emit(if (rest) .test_list_at_least else .test_list, &.{ .{ .int = count }, .{ .label = fail } }, at, "");
                var n: i64 = 0;
                for (items) |item| switch (item) {
                    .pattern => |q| {
                        n += 1;
                        try f.load(s, at);
                        try f.emit(.list_item, &.{.{ .int = n }}, at, "");
                        try f.subPattern(q, fail, binding, fold);
                    },
                    .rest => |r| {
                        try f.load(s, at);
                        try f.emit(.list_rest, &.{.{ .int = count + 1 }}, at, "");
                        if (r.name) |name| try f.bindName(name, binding, at) else try f.emit(.pop, &.{}, at, "");
                    },
                };
            },
            .map => |entries| {
                try f.load(s, at);
                try f.jump(.test_map, fail, at);
                for (entries) |entry| {
                    try f.load(s, at);
                    try f.emit(.map_get, &.{ .{ .text = try f.keyText(entry.key) }, .{ .label = fail } }, at, "");
                    if (entry.pattern) |q| try f.subPattern(q, fail, binding, fold) else try f.bindName(entry.key, binding, entry.key);
                }
            },
            .text => |tp| {
                try f.load(s, at);
                try f.textPatternValue(tp);
                try f.emit(.match_whole, if (fold) &.{ .{ .text = "fold" }, .{ .label = fail } } else &.{.{ .label = fail }}, at, "");
                try f.captures(tp, at, binding);
            },
            .binary => |fields| try f.binaryPattern(fields, s, fail, binding, at),
        }
        if (p.bind_as) |n| {
            try f.load(s, at);
            try f.bindName(n, binding, at);
        }
    }

    /// The Captures a whole or searching match writes, from the Captures map
    /// on the stack.
    fn captures(f: *Frame, tp: *const ast.TextPattern, at: Tok, binding: Binding) Allocator.Error!void {
        var names: std.ArrayList(Tok) = .empty;
        for (tp.elements) |el| try elementNames(f.l, el, &names);
        if (names.items.len == 0) return f.emit(.pop, &.{}, at, "");
        const t = try f.temp();
        try f.store(t, at);
        for (names.items) |n| {
            try f.load(t, at);
            try f.emit(.get_key, &.{.{ .text = try f.keyText(n) }}, at, "");
            try f.bindName(n, binding, at);
        }
        f.release(t);
    }

    /// A sub-pattern, with its value on the stack.
    fn subPattern(f: *Frame, q: *const Pattern, fail: u32, binding: Binding, fold: bool) Allocator.Error!void {
        if (q.data == .name and q.bind_as == null) return f.bindName(q.data.name, binding, q.first);
        if (q.data == .wildcard and q.bind_as == null) return f.emit(.pop, &.{}, q.first, "");
        const t = try f.temp();
        try f.store(t, q.first);
        try f.testPattern(q, t, fail, binding, fold);
        f.release(t);
    }

    /// Stores the value on the stack into a name's binding: its slot, or a
    /// new temp moved there once the pattern has passed.
    fn bindName(f: *Frame, name: Tok, binding: Binding, at: Tok) Allocator.Error!void {
        const n = f.l.text(name);
        switch (binding) {
            .direct => try f.store(f.names.get(n).?, at),
            .temps => {
                const t = try f.temp();
                try f.store(t, at);
                try f.pending.append(f.l.a, .{ .name = n, .temp = t });
            },
        }
    }

    /// A pinned or bound name a pattern reads, from its temp while the
    /// pattern is tested.
    fn pendingTemp(f: *Frame, name: []const u8) ?u32 {
        var i = f.pending.items.len;
        while (i > 0) {
            i -= 1;
            if (std.mem.eql(u8, f.pending.items[i].name, name)) return f.pending.items[i].temp;
        }
        return null;
    }

    fn binaryPattern(f: *Frame, fields: []const ast.BinaryField, s: u32, fail: u32, binding: Binding, at: Tok) Allocator.Error!void {
        const l = f.l;
        try f.load(s, at);
        try f.jump(.bin_start, fail, at);
        var rest = false;
        var i: usize = 0;
        while (i < fields.len) {
            const field = fields[i];
            switch (field.data) {
                .literal => |t| {
                    const c = try f.bytesLiteral(t);
                    try f.emit(.bin_literal, &.{ .{ .int = c }, .{ .label = fail } }, field.first, l.constants.items[c]);
                    i += 1;
                },
                .rest => |r| {
                    try f.jump(.bin_rest, fail, field.first);
                    const last = &f.body.code.items[f.body.code.items.len - 1];
                    last.operands = try l.a.dupe(Operand, &.{ .{ .text = if (r.as_text) "bytes as text" else "bytes" }, .{ .label = fail } });
                    if (r.name) |n| try f.bindName(n, binding, field.first) else try f.emit(.pop, &.{}, field.first, "");
                    rest = true;
                    i += 1;
                },
                .field => |fl| switch (fl.type) {
                    .integer => |it| {
                        try f.emit(.bin_int, &.{ .{ .text = try integerField(l, it) }, .{ .label = fail } }, field.first, "");
                        if (std.mem.eql(u8, l.text(fl.name), "_")) try f.emit(.pop, &.{}, field.first, "") else try f.bindName(fl.name, binding, field.first);
                        i += 1;
                    },
                    .sized => |sz| {
                        if (std.mem.startsWith(u8, l.text(sz.unit), "bit")) {
                            // A run of bit fields.
                            var widths: std.ArrayList(u8) = .empty;
                            try widths.append(l.a, '[');
                            var j = i;
                            while (j < fields.len and isBitField(l, fields[j])) : (j += 1) {
                                if (j > i) try widths.appendSlice(l.a, ", ");
                                try widths.appendSlice(l.a, l.text(fields[j].data.field.type.sized.size.number));
                            }
                            try widths.append(l.a, ']');
                            const c = try l.constant(try l.print("w{s}", .{widths.items}), widths.items);
                            try f.emit(.bin_bits, &.{ .{ .int = c }, .{ .int = @intCast(j - i) }, .{ .label = fail } }, field.first, l.constants.items[c]);
                            var k = j;
                            while (k > i) {
                                k -= 1;
                                const fk = fields[k].data.field;
                                if (std.mem.eql(u8, l.text(fk.name), "_")) try f.emit(.pop, &.{}, fields[k].first, "") else try f.bindName(fk.name, binding, fields[k].first);
                            }
                            i = j;
                        } else {
                            try f.size(sz.size, field.first);
                            try f.emit(.bin_bytes, &.{ .{ .text = if (sz.as_text) "bytes as text" else "bytes" }, .{ .label = fail } }, field.first, "");
                            if (std.mem.eql(u8, l.text(fl.name), "_")) try f.emit(.pop, &.{}, field.first, "") else try f.bindName(fl.name, binding, field.first);
                            i += 1;
                        }
                    },
                },
            }
        }
        if (!rest) try f.jump(.bin_end, fail, at);
    }

    fn size(f: *Frame, sz: ast.Size, at: Tok) Allocator.Error!void {
        switch (sz) {
            .number => |t| try f.constAt(try f.numberConstant(try canonicalNumber(f.l, f.l.text(t))), at),
            .pin => |t| try f.nameValueAt(t, f.l.checked.refs.get(t).?, at),
            .name => |t| {
                const n = f.l.text(t);
                if (f.pendingTemp(n)) |tmp| try f.load(tmp, at) else try f.load(f.names.get(n).?, at);
            },
            .expr => |e| try f.expr(e),
        }
    }

    // ------------------------------------------------------------ expressions

    fn textConstant(f: *Frame, raw: []const u8) Allocator.Error!u32 {
        const v = model.text(f.l.va(), raw) catch return error.OutOfMemory;
        return f.l.valueConstant(v);
    }

    fn numberConstant(f: *Frame, canonical: []const u8) Allocator.Error!u32 {
        return f.l.constant(try f.l.print("n{s}", .{canonical}), canonical);
    }

    fn literalConstant(f: *Frame, lit: @FieldType(@FieldType(Pattern, "data"), "literal")) Allocator.Error!u32 {
        const l = f.l;
        const tok = l.tree.tokens[lit.value];
        switch (tok.kind) {
            .text => return f.textConstant(literalText(l, lit.value)),
            .number => {
                var n = parseNumber(l, l.text(lit.value));
                if (lit.minus != null) n = n.negate();
                if (lit.unit) |u| return l.valueConstant(model.quantity(l.va(), n, l.text(u)) catch return error.OutOfMemory);
                return l.valueConstant(model.scalar(l.va(), .{ .number = n }) catch return error.OutOfMemory);
            },
            else => {
                const w = l.text(lit.value);
                return l.constant(w, w);
            },
        }
    }

    fn bytesLiteral(f: *Frame, t: Tok) Allocator.Error!u32 {
        const l = f.l;
        if (l.tree.tokens[t].kind == .text) return f.textConstant(literalText(l, t));
        return f.numberConstant(try canonicalNumber(l, l.text(t)));
    }

    fn keyText(f: *Frame, t: Tok) Allocator.Error![]const u8 {
        const l = f.l;
        return f.keyTextOf(if (l.tree.tokens[t].kind == .text) literalText(l, t) else l.text(t));
    }

    /// A key as text in the display form.
    fn keyTextOf(f: *Frame, raw: []const u8) Allocator.Error![]const u8 {
        const l = f.l;
        const v = model.text(l.a, raw) catch return error.OutOfMemory;
        defer v.release();
        return display.string(l.a, v) catch return error.OutOfMemory;
    }

    fn propertyName(f: *Frame, p: anytype) Allocator.Error![]const u8 {
        return if (p.code_points) "code points" else f.l.text(p.name);
    }

    fn nameValue(f: *Frame, t: Tok, r: check.Ref) Allocator.Error!void {
        return f.nameValueAt(t, r, t);
    }

    /// A Name's value, placed at `t`.
    fn nameValueAt(f: *Frame, name_token: Tok, r: check.Ref, t: Tok) Allocator.Error!void {
        const l = f.l;
        const name = l.text(name_token);
        switch (r) {
            .local, .captured => {
                if (f.pendingTemp(name)) |tmp| return f.load(tmp, t);
                try f.load(f.names.get(name).?, t);
            },
            .variable => |v| try f.emit(.load_var, &.{.{ .int = v }}, t, name),
            .constant => try f.emit(.load_definition, &.{.{ .text = name }}, t, ""),
            .imported => {
                const im = l.imports.get(name).?;
                const shown = try l.print("{s}:{s}", .{ im.library, im.name });
                if (im.kind == .constant) {
                    try f.emit(.load_definition, &.{.{ .text = shown }}, t, "");
                } else try f.emit(.make_imported_function, &.{.{ .text = shown }}, t, "");
            },
            .function => {
                const body = l.functions.get(name).?;
                try f.emit(.make_function, &.{.{ .int = body }}, t, name);
            },
            .object, .script => try f.emit(.load_object, &.{.{ .text = try l.object(name) }}, t, ""),
            .builtin_constant => try f.constAt(try l.constant(try l.print("b{s}", .{name}), name), t),
            .handler, .builtin_function => unreachable,
        }
    }

    fn chunkIndex(f: *Frame, c: ast.Chunk, at: Tok) Allocator.Error!void {
        if (c.index) |i| return f.expr(i);
        try f.constAt(try f.numberConstant(ordinalIndex(f.l.text(c.ordinal.?))), at);
    }

    fn expr(f: *Frame, e: *const Expr) Allocator.Error!void {
        const l = f.l;
        const at = e.pos;
        switch (e.data) {
            .number => |t| try f.constAt(try f.numberConstant(try canonicalNumber(l, l.text(t))), t),
            .quantity => |q| try f.constAt(try l.valueConstant(model.quantity(l.va(), parseNumber(l, l.text(q.number)), l.text(q.unit)) catch return error.OutOfMemory), q.number),
            .text => |t| try f.constAt(try f.textConstant(literalText(l, t)), t),
            .template => |tm| {
                const tok = l.tree.tokens[tm.open];
                const lit = l.tree.shared.fenced.get(tok.start).?;
                try f.constAt(try f.textConstant(lit.pieces[0]), tm.open);
                for (tm.holes, lit.holes, 1..) |h, hole, i| {
                    try f.expr(h);
                    const dollar = l.lines.position(hole.dollar);
                    const pos: Position = .{ .line = @intCast(dollar.line), .column = @intCast(dollar.column) };
                    try f.emitAt(.concat, &.{}, pos, "");
                    if (lit.pieces[i].len > 0) {
                        const c = try f.textConstant(lit.pieces[i]);
                        try f.emitAt(.@"const", &.{.{ .int = c }}, pos, l.constants.items[c]);
                        try f.emitAt(.concat, &.{}, pos, "");
                    }
                }
            },
            .word => |w| switch (w) {
                .true, .false, .nothing => {
                    const name = @tagName(w);
                    try f.constAt(try l.constant(name, name), at);
                },
                .it => try f.load(f.whose_it orelse 0, at),
                .me => try f.emit(.me, &.{}, at, ""),
            },
            .target => try f.emit(.target, &.{}, at, ""),
            .name => |t| try f.nameValue(t, l.checked.refs.get(t).?),
            .whose_key => |t| {
                try f.load(f.whose_it.?, t);
                if (properties(l.text(t))) {
                    try f.emit(.property, &.{.{ .text = l.text(t) }}, t, "");
                } else try f.emit(.get_key, &.{.{ .text = try f.keyText(t) }}, t, "");
            },
            .group => |g| try f.expr(g),
            .binary => |b| try f.binary(e, b),
            .is_kind => |k| {
                try f.expr(k.value);
                try f.emit(.is_kind, &.{.{ .text = try f.kindText(k.kind) }}, at, "");
                if (k.negated) try f.emit(.not, &.{}, at, "");
            },
            .is_empty => |k| {
                try f.expr(k.value);
                try f.emit(.is_empty, &.{}, at, "");
                if (k.negated) try f.emit(.not, &.{}, at, "");
            },
            .can_be => |k| {
                try f.expr(k.value);
                try f.emit(.can_convert, &.{.{ .text = try f.kindText(k.kind) }}, at, "");
            },
            .not => |x| {
                try f.expr(x);
                try f.emit(.not, &.{}, at, "");
            },
            .negate => |x| {
                try f.expr(x);
                try f.emit(.negate, &.{}, at, "");
            },
            .conversion => |c| {
                try f.expr(c.value);
                const kind = if (c.unit) |u| l.text(u) else try f.kindText(c.kind.?);
                try f.emit(.convert, &.{.{ .text = kind }}, at, "");
            },
            .key => |k| {
                if (k.computed) |x| {
                    try f.expr(x);
                    try f.expr(k.base);
                    try f.emit(.get_key_computed, &.{}, at, "");
                } else {
                    try f.expr(k.base);
                    try f.emit(.get_key, &.{.{ .text = try f.keyText(k.key.?) }}, at, "");
                }
            },
            .property => |p| {
                try f.expr(p.base);
                if (p.delimiter) |d| {
                    try f.expr(d);
                    try f.emit(.property_delimited, &.{.{ .text = try f.propertyName(p) }}, at, "");
                } else try f.emit(.property, &.{.{ .text = try f.propertyName(p) }}, at, "");
            },
            .chunk => try f.chunkExpr(e, null),
            .whose => |w| try f.whose(w),
            .list => |items| {
                var spread = false;
                for (items) |item| if (item.spread != null) {
                    spread = true;
                };
                if (spread) {
                    try f.emit(.list, &.{.{ .int = 0 }}, at, "");
                    for (items) |item| {
                        try f.expr(item.value);
                        try f.emit(if (item.spread != null) .list_extend else .list_append, &.{}, at, "");
                    }
                } else {
                    for (items) |item| try f.expr(item.value);
                    try f.emit(.list, &.{.{ .int = @intCast(items.len) }}, at, "");
                }
            },
            .map => |entries| {
                var keys: std.ArrayList(u8) = .empty;
                try keys.append(l.a, '[');
                for (entries, 0..) |entry, i| {
                    if (i > 0) try keys.appendSlice(l.a, ", ");
                    try keys.appendSlice(l.a, try f.keyText(entry.key));
                }
                try keys.append(l.a, ']');
                for (entries) |entry| try f.expr(entry.value);
                const c = try l.constant(try l.print("k{s}", .{keys.items}), keys.items);
                try f.emit(.map, &.{ .{ .int = c }, .{ .int = @intCast(entries.len) } }, at, l.constants.items[c]);
            },
            .text_pattern => |tp| try f.textPatternValue(tp),
            .build => |fields| try f.build(e, fields),
            .match_search => |m| {
                try f.expr(m.pattern);
                try f.expr(m.source);
                try f.emit(.match_all, &.{}, at, "");
            },
            .replace => |r| {
                try f.expr(r.pattern);
                try f.expr(r.target);
                try f.replaceLoop(r, at);
            },
            .call => try f.call(e, false),
            .lambda => |lam| try f.lambda(e, lam),
            .pin => |t| try f.nameValue(t, l.checked.refs.get(t).?),
        }
    }

    fn kindText(f: *Frame, k: ast.Kind) Allocator.Error![]const u8 {
        return if (k.civil_date) "civil date" else f.l.text(k.name);
    }

    fn binary(f: *Frame, e: *const Expr, b: ast.Binary) Allocator.Error!void {
        const at = e.pos;
        switch (b.op) {
            .@"and", .@"or" => {
                const short = try f.newLabel();
                const end = try f.newLabel();
                try f.expr(b.left);
                try f.jump(if (b.op == .@"and") .branch_false else .branch_true, short, at);
                try f.expr(b.right);
                try f.emit(.check_boolean, &.{}, at, "");
                try f.jump(.jump, end, at);
                try f.mark(short);
                const word = if (b.op == .@"and") "false" else "true";
                try f.constAt(try f.l.constant(word, word), at);
                try f.mark(end);
                return;
            },
            else => {},
        }
        try f.expr(b.left);
        try f.expr(b.right);
        const fold: []const Operand = if (b.ignoring != null) &.{.{ .text = "fold" }} else &.{};
        var negate = b.negated;
        const op: Opcode = switch (b.op) {
            .equal => blk: {
                if (b.negated) {
                    negate = false;
                    break :blk .not_equal;
                }
                break :blk .equal;
            },
            .not_equal => .not_equal,
            .less => .less,
            .greater => .greater,
            .less_equal => .less_or_equal,
            .greater_equal => .greater_or_equal,
            .contains => .contains,
            .matches => .matches,
            .begins_with => .begins_with,
            .ends_with => .ends_with,
            .is_in => .member,
            .concat => .concat,
            .range => .range,
            .add => .add,
            .subtract => .subtract,
            .multiply => .multiply,
            .divide => .divide,
            .mod => .mod,
            .div => .div,
            .power => .power,
            .@"and", .@"or" => unreachable,
        };
        const takes_fold = switch (op) {
            .equal, .not_equal, .less, .greater, .less_or_equal, .greater_or_equal, .member, .contains, .begins_with, .ends_with, .matches => true,
            else => false,
        };
        try f.emit(op, if (takes_fold) fold else &.{}, at, "");
        if (negate) try f.emit(.not, &.{}, at, "");
    }

    /// A Chunk Expression chain, with its delimiter kept in a temp; a Whose
    /// Clause keeps that temp.
    fn chunkExpr(f: *Frame, e: *const Expr, keep: ?*?u32) Allocator.Error!void {
        var chain: std.ArrayList(*const Expr) = .empty;
        var x = e;
        while (x.data == .chunk) {
            try chain.append(f.l.a, x);
            x = x.data.chunk.of;
            if (x.data == .chunk and x.data.chunk.delimiter != null) break;
        }
        for (chain.items) |level| try f.chunkIndex(level.data.chunk, level.pos);
        try f.expr(x);
        const outer = chain.items[0];
        var delim: ?u32 = null;
        if (outer.data.chunk.delimiter) |d| {
            try f.expr(d);
            delim = try f.temp();
            try f.store(delim.?, outer.pos);
        }
        var i = chain.items.len;
        while (i > 0) {
            i -= 1;
            const level = chain.items[i];
            const c = level.data.chunk;
            if (c.kind == .item and delim != null) {
                try f.load(delim.?, level.pos);
                try f.emit(.chunk_get_delimited, &.{.{ .text = "item" }}, level.pos, "");
            } else try f.emit(.chunk_get, &.{.{ .text = chunkName(c.kind) }}, level.pos, "");
        }
        if (keep) |k| {
            k.* = delim;
        } else if (delim) |d| f.release(d);
    }

    fn whose(f: *Frame, w: ast.Whose) Allocator.Error!void {
        const l = f.l;
        const at = w.whose;
        const r = try f.temp();
        var counter: ?u32 = null;
        var ordinal: ?[]const u8 = null;
        if (w.every) {
            try f.emit(.list, &.{.{ .int = 0 }}, at, "");
        } else {
            try f.constAt(try f.nothing(), at);
            ordinal = l.text(w.ordinal.?.data.chunk.ordinal.?);
        }
        try f.store(r, at);
        if (ordinal) |o| if (!std.mem.eql(u8, o, "first") and !std.mem.eql(u8, o, "last")) {
            counter = try f.temp();
            try f.constAt(try f.numberConstant(ordinalIndex(o)), w.word);
            try f.store(counter.?, at);
        };
        // The walk.
        const plural = pluralName(w.kind);
        var delim: ?u32 = null;
        if (w.delimiter) |d| {
            if (w.source.data == .chunk) {
                // The source as a Chunk Expression with the delimiter, keeping
                // its temp.
                try f.chunkWithDelimiter(w.source, d, &delim);
                try f.load(delim.?, at);
                try f.emit(.property_delimited, &.{.{ .text = plural }}, w.word, "");
            } else {
                try f.expr(w.source);
                try f.expr(d);
                try f.emit(.property_delimited, &.{.{ .text = plural }}, w.word, "");
            }
        } else {
            try f.expr(w.source);
            try f.emit(.property, &.{.{ .text = plural }}, w.word, "");
        }
        try f.emit(.iterate, &.{}, at, "");
        f.depth += 1;
        const top = try f.newLabel();
        const end = try f.newLabel();
        try f.mark(top);
        try f.jump(.next, end, at);
        const t = try f.temp();
        try f.store(t, at);
        const saved = f.whose_it;
        f.whose_it = t;
        try f.expr(w.condition);
        f.whose_it = saved;
        try f.jump(.branch_false, top, at);
        if (w.every) {
            try f.load(r, at);
            try f.load(t, at);
            try f.emit(.list_append, &.{}, at, "");
            try f.store(r, at);
            try f.jump(.jump, top, at);
        } else if (std.mem.eql(u8, ordinal.?, "last")) {
            try f.load(t, at);
            try f.store(r, at);
            try f.jump(.jump, top, at);
        } else if (std.mem.eql(u8, ordinal.?, "first")) {
            try f.load(t, at);
            try f.store(r, at);
            try f.jump(.jump, end, at);
        } else {
            const k = counter.?;
            try f.load(k, at);
            try f.constAt(try f.numberConstant("1"), at);
            try f.emit(.subtract, &.{}, at, "");
            try f.store(k, at);
            try f.load(k, at);
            try f.constAt(try f.numberConstant("0"), at);
            try f.emit(.equal, &.{}, at, "");
            try f.jump(.branch_false, top, at);
            try f.load(t, at);
            try f.store(r, at);
            try f.jump(.jump, end, at);
        }
        try f.mark(end);
        try f.emit(.pop, &.{}, at, "");
        f.depth -= 1;
        try f.load(r, at);
        f.release(t);
        if (delim) |d| f.release(d);
        if (counter) |k| f.release(k);
        f.release(r);
    }

    /// `x` lowered as a Chunk Expression with `delimited by d`, keeping the
    /// delimiter's temp.
    fn chunkWithDelimiter(f: *Frame, source: *const Expr, d: *const Expr, keep: *?u32) Allocator.Error!void {
        var copy = source.*;
        copy.data.chunk.delimiter = @constCast(d);
        try f.chunkExpr(&copy, keep);
    }

    fn build(f: *Frame, e: *const Expr, fields: []const ast.BuildField) Allocator.Error!void {
        const l = f.l;
        try f.constAt(try l.constant("bytes", "<<>>"), e.pos);
        var i: usize = 0;
        while (i < fields.len) {
            const field = fields[i];
            if (field.type) |ty| switch (ty) {
                .sized => |sz| if (std.mem.startsWith(u8, l.text(sz.unit), "bit")) {
                    var widths: std.ArrayList(u8) = .empty;
                    try widths.append(l.a, '[');
                    var j = i;
                    while (j < fields.len and fields[j].type != null and fields[j].type.? == .sized and std.mem.startsWith(u8, l.text(fields[j].type.?.sized.unit), "bit")) : (j += 1) {
                        if (j > i) try widths.appendSlice(l.a, ", ");
                        try widths.appendSlice(l.a, try canonicalNumber(l, l.text(fields[j].type.?.sized.size.number)));
                        try f.expr(fields[j].value);
                    }
                    try widths.append(l.a, ']');
                    const c = try l.constant(try l.print("w{s}", .{widths.items}), widths.items);
                    try f.emit(.bytes_bits, &.{ .{ .int = c }, .{ .int = @intCast(j - i) } }, field.first, l.constants.items[c]);
                    i = j;
                    continue;
                } else {
                    try f.expr(field.value);
                    try f.size(sz.size, field.first);
                    try f.emit(.bytes_sized, &.{.{ .text = if (sz.as_text) "bytes as text" else "bytes" }}, field.first, "");
                    i += 1;
                    continue;
                },
                .integer => |it| {
                    try f.expr(field.value);
                    try f.emit(.bytes_field, &.{.{ .text = try integerField(l, it) }}, field.first, "");
                    i += 1;
                    continue;
                },
            };
            try f.expr(field.value);
            try f.emit(.bytes_field, &.{.{ .text = "value" }}, field.first, "");
            i += 1;
        }
    }

    fn lambda(f: *Frame, e: *const Expr, lam: ast.Lambda) Allocator.Error!void {
        const l = f.l;
        const cb = l.checkerBody(.lambda, null, e);
        const p = l.position(lam.given);
        const name = try l.print("{s}:{d}:{d}", .{ f.body.info.name, p.line, p.column });
        // Number the body now, so nested Lambdas follow it.
        const index = try l.reserve();
        var inner = try Frame.init(l, .lambda, name, cb);
        const params = try inner.parameters(lam.params);
        try inner.finishSlots();
        const fail = try inner.newLabel();
        var patterns = false;
        for (lam.params, 0..) |q, i| {
            if (q.data == .name and q.bind_as == null) continue;
            patterns = true;
            try inner.testPattern(q, @intCast(i + 1), fail, .direct, false);
        }
        switch (lam.body) {
            .expr => |x| {
                try inner.expr(x);
                try inner.emit(.@"return", &.{}, lam.given, "");
            },
            .block => |b| {
                try inner.block(b);
                try inner.endAt(l.position(lam.end.?));
            },
        }
        if (patterns) {
            try inner.mark(fail);
            try inner.raise("no match", lam.given);
        }
        l.bodies.items[index] = try inner.done(params);
        // Its captures, loaded where it is made.
        for (cb.captures) |c| {
            if (f.pendingTemp(c)) |tmp| try f.load(tmp, lam.given) else try f.load(f.names.get(c).?, lam.given);
        }
        try f.emit(.make_closure, &.{ .{ .int = index }, .{ .int = @intCast(cb.captures.len) } }, lam.given, name);
    }

    // ------------------------------------------------------------ Text Patterns

    /// A Text Pattern: `const` of it, or its splices and `make-pattern`.
    fn textPatternValue(f: *Frame, tp: *const ast.TextPattern) Allocator.Error!void {
        const l = f.l;
        var splices: std.ArrayList(*const Expr) = .empty;
        var source: std.ArrayList(u8) = .empty;
        try canonicalPattern(l, tp, &source, &splices, true);
        if (splices.items.len == 0) {
            const c = try l.constant(try l.print("p{s}", .{source.items}), source.items);
            return f.constAt(c, tp.open);
        }
        for (splices.items) |s| try f.expr(s);
        const c = try l.constant(try l.print("p{s}", .{source.items}), source.items);
        try f.emit(.make_pattern, &.{ .{ .int = c }, .{ .int = @intCast(splices.items.len) } }, tp.open, l.constants.items[c]);
    }
};

// ---------------------------------------------------------------- helpers

fn among(word: []const u8, list: []const []const u8) bool {
    for (list) |w| if (std.mem.eql(u8, w, word)) return true;
    return false;
}

fn properties(word: []const u8) bool {
    return among(word, &.{ "length", "keys", "values", "items", "lines", "words", "characters", "bytes" });
}

fn chunkName(k: ast.ChunkKind) []const u8 {
    return switch (k) {
        .code_point => "code point",
        inline else => |x| @tagName(x),
    };
}

fn pluralName(k: ast.ChunkKind) []const u8 {
    return switch (k) {
        .character => "characters",
        .word => "words",
        .line => "lines",
        .item => "items",
        .byte => "bytes",
        .code_point => "code points",
    };
}

fn ordinalIndex(o: []const u8) []const u8 {
    const names = [_][]const u8{ "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth" };
    const digits = [_][]const u8{ "1", "2", "3", "4", "5", "6", "7", "8", "9", "10" };
    for (names, digits) |n, d| if (std.mem.eql(u8, n, o)) return d;
    return "-1";
}

fn isBitField(l: *Lowerer, f: ast.BinaryField) bool {
    if (f.data != .field) return false;
    const ty = f.data.field.type;
    return ty == .sized and std.mem.startsWith(u8, l.text(ty.sized.unit), "bit");
}

fn integerField(l: *Lowerer, it: anytype) Allocator.Error![]const u8 {
    if (it.order) |o| return l.print("{s} {s}", .{ l.text(it.name), l.text(o) });
    return l.text(it.name);
}

fn literalText(l: *Lowerer, t: Tok) []const u8 {
    const tok = l.tree.tokens[t];
    const s = l.tree.text(t);
    if (s[0] == '"' and !std.mem.startsWith(u8, s, "\"\"\"")) return s[1 .. s.len - 1];
    return l.tree.shared.fenced.get(tok.start).?.pieces[0];
}

fn parseNumber(l: *Lowerer, s: []const u8) model.Decimal {
    if (std.mem.startsWith(u8, s, "0x")) {
        const v = std.fmt.parseInt(u128, s[2..], 16) catch unreachable;
        const digits = std.fmt.allocPrint(l.a, "{d}", .{v}) catch unreachable;
        return model.Decimal.parse(digits) catch unreachable;
    }
    return model.Decimal.parse(s) catch unreachable;
}

fn canonicalNumber(l: *Lowerer, s: []const u8) Allocator.Error![]const u8 {
    return parseNumber(l, s).string(l.a) catch error.OutOfMemory;
}

fn exprFirst(l: *Lowerer, e: *const Expr) Tok {
    _ = l;
    var x = e;
    while (true) x = switch (x.data) {
        .binary => |b| b.left,
        .is_kind => |k| k.value,
        .is_empty => |k| k.value,
        .can_be => |k| k.value,
        .conversion => |c| c.value,
        else => return x.pos,
    };
}

fn patternNames(l: *Lowerer, p: *const Pattern, out: *std.ArrayList(Tok)) Allocator.Error!void {
    switch (p.data) {
        .name => |t| try out.append(l.a, t),
        .list => |items| for (items) |item| switch (item) {
            .pattern => |q| try patternNames(l, q, out),
            .rest => |r| if (r.name) |n| try out.append(l.a, n),
        },
        .map => |entries| for (entries) |e| {
            if (e.pattern) |q| try patternNames(l, q, out) else try out.append(l.a, e.key);
        },
        .text => |tp| for (tp.elements) |el| try elementNames(l, el, out),
        .binary => |fields| for (fields) |f| switch (f.data) {
            .rest => |r| if (r.name) |n| try out.append(l.a, n),
            .field => |fl| if (!std.mem.eql(u8, l.text(fl.name), "_")) try out.append(l.a, fl.name),
            .literal => {},
        },
        else => {},
    }
    if (p.bind_as) |n| try out.append(l.a, n);
}

fn elementNames(l: *Lowerer, el: *const ast.PatternElement, out: *std.ArrayList(Tok)) Allocator.Error!void {
    switch (el.data) {
        .capture => |cap| {
            try out.append(l.a, cap.name);
            try elementNames(l, cap.alternation, out);
        },
        .count => |n| try elementNames(l, n.atom, out),
        .group => |g| for (g.elements) |e| try elementNames(l, e, out),
        .repetition => |r| try elementNames(l, r.atom, out),
        .alternation => |items| for (items) |e| try elementNames(l, e, out),
        .modified => |m| try elementNames(l, m.atom, out),
        else => {},
    }
}

/// The names of locals a pattern reads: its pins and sizes.
fn patternReads(l: *Lowerer, p: *const Pattern, out: *std.ArrayList([]const u8)) Allocator.Error!void {
    switch (p.data) {
        .pin => |t| try out.append(l.a, l.text(t)),
        .list => |items| for (items) |item| switch (item) {
            .pattern => |q| try patternReads(l, q, out),
            .rest => {},
        },
        .map => |entries| for (entries) |e| if (e.pattern) |q| try patternReads(l, q, out),
        .binary => |fields| for (fields) |f| switch (f.data) {
            .field => |fl| switch (fl.type) {
                .sized => |sz| switch (sz.size) {
                    .pin => |t| try out.append(l.a, l.text(t)),
                    .expr => |e| try exprReads(l, e, out),
                    else => {},
                },
                else => {},
            },
            else => {},
        },
        else => {},
    }
}

/// The local names an expression reads, in order, outside Lambdas.
fn exprReads(l: *Lowerer, e: *const Expr, out: *std.ArrayList([]const u8)) Allocator.Error!void {
    switch (e.data) {
        .name, .pin => |t| if (l.checked.refs.get(t)) |r| if (r == .local or r == .captured) try out.append(l.a, l.text(t)),
        .group, .not, .negate => |x| try exprReads(l, x, out),
        .binary => |b| {
            try exprReads(l, b.left, out);
            try exprReads(l, b.right, out);
        },
        .is_kind => |k| try exprReads(l, k.value, out),
        .is_empty => |k| try exprReads(l, k.value, out),
        .can_be => |k| try exprReads(l, k.value, out),
        .conversion => |c| try exprReads(l, c.value, out),
        .key => |k| {
            if (k.computed) |x| try exprReads(l, x, out);
            try exprReads(l, k.base, out);
        },
        .property => |p| {
            try exprReads(l, p.base, out);
            if (p.delimiter) |d| try exprReads(l, d, out);
        },
        .chunk => |c| {
            if (c.index) |i| try exprReads(l, i, out);
            try exprReads(l, c.of, out);
            if (c.delimiter) |d| try exprReads(l, d, out);
        },
        .list => |items| for (items) |i| try exprReads(l, i.value, out),
        .map => |entries| for (entries) |m| try exprReads(l, m.value, out),
        .call => |c| {
            if (l.checked.refs.get(c.name)) |r| if (r == .local or r == .captured) try out.append(l.a, l.text(c.name));
            for (c.args) |x| try exprReads(l, x, out);
        },
        .template => |t| for (t.holes) |h| try exprReads(l, h, out),
        .match_search => |m| {
            try exprReads(l, m.pattern, out);
            try exprReads(l, m.source, out);
        },
        .whose => |w| {
            if (w.ordinal) |o| try exprReads(l, o, out) else try exprReads(l, w.source, out);
            try exprReads(l, w.condition, out);
        },
        else => {},
    }
}

/// A Text Pattern's canonical source (chapter 11), with each splice as
/// `(1)`, `(2)`, … when `template`.
fn canonicalPattern(l: *Lowerer, tp: *const ast.TextPattern, out: *std.ArrayList(u8), splices: *std.ArrayList(*const Expr), top: bool) Allocator.Error!void {
    _ = top;
    try out.append(l.a, '<');
    var first = true;
    for (tp.elements) |el| {
        if (el.data == .group and el.data.group.elements.len == 0) continue;
        if (!first) try out.appendSlice(l.a, ", ") else if (el.data == .group or (el.data == .splice and false)) try out.append(l.a, ' ');
        first = false;
        try canonicalElement(l, el, out, splices);
    }
    try out.append(l.a, '>');
}

fn canonicalElement(l: *Lowerer, el: *const ast.PatternElement, out: *std.ArrayList(u8), splices: *std.ArrayList(*const Expr)) Allocator.Error!void {
    switch (el.data) {
        .text => |t| {
            const v = model.text(l.a, literalText(l, t)) catch return error.OutOfMemory;
            defer v.release();
            const shown = display.string(l.a, v) catch return error.OutOfMemory;
            if (shown[0] == '"' and std.mem.indexOf(u8, shown, " & ") == null) {
                try out.appendSlice(l.a, shown);
            } else try out.print(l.a, "({s})", .{shown});
        },
        .count => |n| {
            try out.print(l.a, "{s} ", .{try canonicalNumber(l, l.text(n.number))});
            try canonicalElement(l, n.atom, out, splices);
        },
        .group => |g| try canonicalPattern(l, g, out, splices, false),
        .splice => |e| {
            try splices.append(l.a, e);
            try out.print(l.a, "({d})", .{splices.items.len});
        },
        .capture => |c| {
            try out.print(l.a, "{s}: ", .{l.text(c.name)});
            try canonicalElement(l, c.alternation, out, splices);
        },
        .anchor => |a| try out.print(l.a, "{s} {s}", .{ l.text(a.first), l.text(a.second) }),
        .class => |c| try out.print(l.a, "{s} {s}", .{ l.text(c.case), l.text(c.letters) }),
        .repetition => |r| {
            try out.appendSlice(l.a, switch (r.kind) {
                .one_or_more => "one or more of ",
                .zero_or_more => "zero or more of ",
                .optional => "optional ",
            });
            try canonicalElement(l, r.atom, out, splices);
        },
        .typed => |t| try out.print(l.a, "{s} {s}", .{ l.text(t.article), l.text(t.kind.name) }),
        .keyword => |t| try out.appendSlice(l.a, l.text(t)),
        .alternation => |items| for (items, 0..) |e, i| {
            if (i > 0) try out.appendSlice(l.a, " or ");
            try canonicalElement(l, e, out, splices);
        },
        .modified => {
            // The suffixes, once each, in the order `as number`, `ignoring
            // case`, `lazily`.
            var atom = el;
            var as_number = false;
            var ignoring = false;
            var lazily = false;
            while (atom.data == .modified) {
                switch (atom.data.modified.modifier) {
                    .as => as_number = true,
                    .ignoring => ignoring = true,
                    .lazily => lazily = true,
                }
                atom = atom.data.modified.atom;
            }
            try canonicalElement(l, atom, out, splices);
            if (as_number) try out.appendSlice(l.a, " as number");
            if (ignoring) try out.appendSlice(l.a, " ignoring case");
            if (lazily) try out.appendSlice(l.a, " lazily");
        },
    }
}

// ---------------------------------------------------------------- disassembly

/// The canonical disassembly (chapter 8).
pub fn disassemble(unit: *const Unit, w: *std.Io.Writer) std.Io.Writer.Error!void {
    try w.print("unit {s} {s}\n", .{ unit.name, if (unit.library) "library" else "script" });
    if (unit.constants.len > 0) {
        try w.writeAll("constants\n");
        for (unit.constants, 0..) |c, i| try w.print("  {d} {s}\n", .{ i, c });
    }
    try listSection(w, "definitions", unit.definitions);
    try listSection(w, "variables", unit.variables);
    try listSection(w, "objects", unit.objects);
    try w.writeAll("bodies\n");
    for (unit.bodies, 0..) |b, i| {
        try w.print("  {d} {s} {s}", .{ i, @tagName(b.kind), b.name });
        if (b.clause) |c| try w.print(" clause {d}", .{c});
        try w.writeAll(" (");
        for (b.params, 0..) |p, j| {
            if (j > 0) try w.writeAll(", ");
            try w.writeAll(p);
        }
        try w.writeAll(")");
        if (b.captures > 0) try w.print(" captures {d}", .{b.captures});
        try w.print(" locals {d}", .{b.locals});
        if (b.may_suspend) try w.writeAll(" may suspend");
        try w.print(" {d:0>4}..{d:0>4}\n", .{ b.first, b.last });
    }
    try w.writeAll("code\n");
    for (unit.code, 0..) |ins, pc| {
        const meta = machine.instruction[@backingInt(ins.op)];
        try w.print("  {d:0>4} {d}:{d} {s}", .{ pc, ins.position.line, ins.position.column, meta.name });
        var kinds: [4][]const u8 = undefined;
        var n: usize = 0;
        for (meta.operands) |k| {
            const optional = std.mem.endsWith(u8, k, "?");
            if (optional and ins.operands.len < meta.operands.len) continue;
            kinds[n] = if (optional) k[0 .. k.len - 1] else k;
            n += 1;
        }
        for (ins.operands, 0..) |o, i| {
            switch (o) {
                .int => |v| if (i < n and std.mem.eql(u8, kinds[i], "label")) try w.print(" {d:0>4}", .{@as(u64, @intCast(v))}) else try w.print(" {d}", .{v}),
                .text => |t| try w.print(" {s}", .{t}),
                .label => unreachable,
            }
        }
        if (ins.note.len > 0) try w.print(" ; {s}", .{ins.note});
        try w.writeAll("\n");
    }
    if (unit.unwind.len > 0) {
        try w.writeAll("unwind\n");
        for (unit.unwind) |u| {
            if (u.kind == .offer) {
                try w.print("  {d:0>4}..{d:0>4} offer -> entry {d} depth {d}\n", .{ u.first, u.last, u.target, u.depth });
            } else try w.print("  {d:0>4}..{d:0>4} {s} -> {d:0>4} depth {d}\n", .{ u.first, u.last, @tagName(u.kind), u.target, u.depth });
        }
    }
    if (unit.offers.len > 0) {
        try w.writeAll("offers\n");
        for (unit.offers, 0..) |o, i| {
            try w.print("  {d} body {d} depth {d} end {d:0>4}\n", .{ i, o.body, o.depth, o.end });
            for (o.offers) |e| {
                try w.print("    offer {s} -> {d:0>4} binds [", .{ e.name, e.entry });
                for (e.binds, 0..) |s, j| {
                    if (j > 0) try w.writeAll(", ");
                    try w.print("{d}", .{s});
                }
                try w.writeAll("]\n");
            }
        }
    }
    if (unit.events.len > 0) {
        try w.writeAll("events\n");
        for (unit.events, 0..) |e, i| {
            try w.print("  {d} ", .{i});
            for (e.branches, 0..) |br, j| {
                if (j > 0) try w.writeAll("; ");
                switch (br) {
                    .after => try w.writeAll("after"),
                    .when => |wh| {
                        try w.print("when {s}", .{wh.message});
                        if (wh.from) try w.writeAll(" from");
                        if (wh.body) |b| try w.print(" body {d}", .{b});
                        if (wh.captures > 0) try w.print(" captures {d}", .{wh.captures});
                        if (wh.binds.len > 0) {
                            try w.writeAll(" binds ");
                            for (wh.binds, 0..) |s, k| {
                                if (k > 0) try w.writeAll(", ");
                                try w.print("{d}", .{s});
                            }
                        }
                    },
                }
            }
            if (e.timeout) try w.writeAll("; or");
            try w.writeAll("\n");
        }
    }
}

fn listSection(w: *std.Io.Writer, title: []const u8, items: []const []const u8) std.Io.Writer.Error!void {
    if (items.len == 0) return;
    try w.print("{s}\n", .{title});
    for (items, 0..) |item, i| try w.print("  {d} {s}\n", .{ i, item });
}

// ---------------------------------------------------------------- tests

const testing = std.testing;
const parser = @import("../syntax/parser.zig");

test "every corpus unit that checks clean lowers, with every label placed" {
    const io = testing.io;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(testing.allocator);
    defer walker.deinit();
    var lowered: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.endsWith(u8, entry.basename, ".talk")) {
        const source = try dir.readFileAlloc(io, entry.path, a, .unlimited);
        const parsed = try parser.parse(a, source);
        if (parsed != .tree) continue;
        const tree = &parsed.tree;
        // Without its case's Libraries and objects, a unit may not check; a
        // Library is tried as one too.
        for ([_]bool{ false, true }) |library| {
            const context: check.Context = .{ .library = library };
            const checked = try check.check(a, tree, context);
            if (checked.diagnostics.len > 0) continue;
            const unit = try lower(a, tree, &checked, .{ .name = "u", .context = context });
            for (unit.code) |ins| for (ins.operands) |o| try testing.expect(o != .label);
            var out: std.Io.Writer.Allocating = .init(a);
            try disassemble(&unit, &out.writer);
            lowered += 1;
            break;
        }
    };
    try testing.expect(lowered > 300);
}

test "parenthesized Containers and calls through a Constant lower" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const source =
        \\constant twice = given x: x * 2
        \\on t x
        \\  put 1 into (the "length" of x)
        \\  delete item 1 of (x)
        \\  put 2 into item (the length of x) of x
        \\  return twice(3)
        \\end t
    ;
    const parsed = try parser.parse(a, source);
    const checked = try check.check(a, &parsed.tree, .{});
    try testing.expectEqual(@as(usize, 0), checked.diagnostics.len);
    const unit = try lower(a, &parsed.tree, &checked, .{ .name = "t" });
    var out: std.Io.Writer.Allocating = .init(a);
    try disassemble(&unit, &out.writer);
    try testing.expect(std.mem.indexOf(u8, out.written(), "set-key \"length\"") != null);
    try testing.expect(std.mem.indexOf(u8, out.written(), "chunk-delete item") != null);
    try testing.expect(std.mem.indexOf(u8, out.written(), "property length") != null);
    try testing.expect(std.mem.indexOf(u8, out.written(), "load-definition twice") != null);
    try testing.expect(std.mem.indexOf(u8, out.written(), "call-value 1") != null);
}

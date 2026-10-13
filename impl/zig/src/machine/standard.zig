//! The Standard Capabilities (chapter 7): `clock`, `calendar`, `locale`,
//! `timer`, `console`, `store`, `sqlite` and `user`, with the declarations the chapter fixes. Each factory takes the
//! Host's implementation, one Host function per Operation, and a cost per
//! Operation. The Core makes the chapter's own checks: option words and
//! Locale tags before a call, which are charged nothing, and the result rules
//! after it, or after the answer to a suspending call, whose failure is
//! `host error`. The Host function receives the
//! resolved arguments: defaults filled and the optional positions told apart.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const caps = @import("capabilities.zig");
const grammar = @import("../generated/grammar.zig").grammar;
const sqlite = @import("sqlite.zig");
const Value = model.Value;
const Shape = caps.Shape;

/// The Standard Capabilities this Core defines so far.
pub const Which = enum { clock, calendar, locale, timer, console, store, sqlite, user };

/// Each one's Operations, in name order, as its declarations list them.
pub fn operations(which: Which) []const []const u8 {
    return switch (which) {
        .clock => &.{"now"},
        .calendar => &.{ "now", "offset", "toCivil", "toInstant", "today", "zone" },
        .locale => &.{ "compare", "dayNames", "lower", "monthNames", "numberSymbols", "rank", "tag", "upper" },
        .timer => &.{ "cancel", "schedule" },
        .console => &.{ "read", "write" },
        .store => &.{ "delete", "get", "increment", "keys", "set", "swap", "unwatch", "watch" },
        .sqlite => &.{ "begin", "change", "commit", "query", "rollback" },
        .user => &.{ "choose", "confirm", "enter", "notify" },
    };
}

/// `store`'s Segment-bound Operations, which write when the Segment
/// commits.
fn storeWrite(name: []const u8) bool {
    for ([_][]const u8{ "set", "delete", "increment", "swap" }) |w| if (std.mem.eql(u8, w, name)) return true;
    return false;
}

/// The context of one Standard Operation's Host function: which it is, and
/// the Host's implementation.
pub const Context = struct {
    gpa: Allocator,
    which: Which,
    name: []const u8,
    impl: caps.HostFn,
};

const Kinds = struct {
    fn kind(gpa: Allocator, k: caps.Kind) !*Shape {
        return Shape.kind(gpa, k);
    }
    fn optionalText(gpa: Allocator) !*Shape {
        return Shape.optional(gpa, try Shape.kind(gpa, .text));
    }
    /// A closed options map whose fields are all optional.
    fn options(gpa: Allocator, comptime fields: []const struct { []const u8, caps.Kind }) !*Shape {
        const out = try gpa.alloc(caps.Field, fields.len);
        inline for (fields, 0..) |f, i| out[i] = .{ .key = try gpa.dupe(u8, f[0]), .shape = try Shape.kind(gpa, f[1]), .optional = true };
        return Shape.map(gpa, out, false);
    }
    /// An Optional choice of the options map or text.
    fn optionsOrText(gpa: Allocator, comptime fields: []const struct { []const u8, caps.Kind }) !*Shape {
        const choice = try gpa.alloc(*Shape, 2);
        choice[0] = try options(gpa, fields);
        choice[1] = try Shape.kind(gpa, .text);
        return Shape.optional(gpa, try Shape.oneOf(gpa, choice));
    }
};

const collation = [_]struct { []const u8, caps.Kind }{ .{ "sensitivity", .text }, .{ "numeric", .boolean } };
const names = [_]struct { []const u8, caps.Kind }{ .{ "width", .text }, .{ "form", .text } };

/// The declaration of one Standard Operation, without its cost and Host
/// function.
fn declare(gpa: Allocator, which: Which, name: []const u8) !caps.Operation {
    var args: std.ArrayList(*Shape) = .empty;
    var result: ?*Shape = null;
    var mode: caps.Mode = .immediate;
    var errors: []const []const u8 = &.{};
    var max_pending: u64 = 0;
    const eq = struct {
        fn f(x: []const u8, y: []const u8) bool {
            return std.mem.eql(u8, x, y);
        }
    }.f;
    switch (which) {
        .clock => result = try Kinds.kind(gpa, .instant),
        .calendar => {
            errors = &.{"unknown zone"};
            if (eq(name, "toCivil") or eq(name, "offset")) try args.append(gpa, try Kinds.kind(gpa, .instant));
            if (eq(name, "toInstant")) {
                try args.append(gpa, try Kinds.kind(gpa, .civil_date));
                try args.append(gpa, try Kinds.optionalText(gpa));
                errors = &.{ "unknown zone", "ambiguous time" };
            }
            try args.append(gpa, try Kinds.optionalText(gpa));
            result = if (eq(name, "toInstant"))
                try Kinds.kind(gpa, .instant)
            else if (eq(name, "offset"))
                try Shape.quantityOf(gpa, "s")
            else if (eq(name, "zone"))
                try Kinds.kind(gpa, .text)
            else
                try Kinds.kind(gpa, .civil_date);
        },
        .locale => {
            if (eq(name, "compare")) {
                try args.append(gpa, try Kinds.kind(gpa, .text));
                try args.append(gpa, try Kinds.kind(gpa, .text));
                try args.append(gpa, try Kinds.optionsOrText(gpa, &collation));
                result = try Kinds.kind(gpa, .number);
            } else if (eq(name, "rank")) {
                try args.append(gpa, try Shape.listOf(gpa, try Kinds.kind(gpa, .text)));
                try args.append(gpa, try Kinds.optionsOrText(gpa, &collation));
                result = try Kinds.kind(gpa, .any);
            } else if (eq(name, "upper") or eq(name, "lower")) {
                try args.append(gpa, try Kinds.kind(gpa, .text));
                result = try Kinds.kind(gpa, .text);
            } else if (eq(name, "monthNames") or eq(name, "dayNames")) {
                try args.append(gpa, try Kinds.optionsOrText(gpa, &names));
                result = try Shape.listOf(gpa, try Kinds.kind(gpa, .text));
            } else if (eq(name, "numberSymbols")) {
                result = try Kinds.kind(gpa, .any);
            } else {
                result = try Kinds.kind(gpa, .text);
            }
            try args.append(gpa, try Kinds.optionalText(gpa));
        },
        .store => {
            const any = struct {
                fn f(g: Allocator) !*Shape {
                    return Shape.kind(g, .any);
                }
            }.f;
            const text = try Kinds.kind(gpa, .text);
            try args.append(gpa, text);
            if (eq(name, "get")) {
                try args.append(gpa, try Shape.optional(gpa, try any(gpa)));
                result = try any(gpa);
                errors = &.{"invalid key"};
            } else if (eq(name, "set")) {
                try args.append(gpa, try any(gpa));
                result = try Kinds.kind(gpa, .nothing);
                errors = &.{ "invalid key", "can't store", "store full", "store busy" };
            } else if (eq(name, "delete")) {
                result = try Kinds.kind(gpa, .nothing);
                errors = &.{ "invalid key", "store busy" };
            } else if (eq(name, "keys")) {
                // Its one argument is an Optional prefix.
                args.items[0] = try Shape.optional(gpa, text);
                result = try Shape.listOf(gpa, try Kinds.kind(gpa, .text));
            } else if (eq(name, "increment")) {
                const by = try gpa.alloc(*Shape, 2);
                by[0] = try Kinds.kind(gpa, .number);
                by[1] = try Kinds.kind(gpa, .quantity);
                try args.append(gpa, try Shape.optional(gpa, try Shape.oneOf(gpa, by)));
                const gives = try gpa.alloc(*Shape, 2);
                gives[0] = try Kinds.kind(gpa, .number);
                gives[1] = try Kinds.kind(gpa, .quantity);
                result = try Shape.oneOf(gpa, gives);
                errors = &.{ "invalid key", "wrong kind", "incompatible units", "overflow", "store full", "store busy" };
            } else if (eq(name, "swap")) {
                try args.append(gpa, try any(gpa));
                try args.append(gpa, try any(gpa));
                result = try Kinds.kind(gpa, .boolean);
                errors = &.{ "invalid key", "can't store", "store full", "store busy" };
            } else if (eq(name, "watch")) {
                try args.append(gpa, try Kinds.kind(gpa, .text));
                try args.append(gpa, try Kinds.optionalText(gpa));
                result = try Kinds.kind(gpa, .nothing);
                errors = &.{ "invalid watch", "watch limit" };
            } else {
                result = try Kinds.kind(gpa, .nothing);
                errors = &.{"invalid watch"};
            }
        },
        .sqlite => if (eq(name, "query") or eq(name, "change")) {
            try args.append(gpa, try Kinds.kind(gpa, .text));
            try args.append(gpa, try Kinds.kind(gpa, .any));
            try args.append(gpa, try Shape.optional(gpa, try Kinds.kind(gpa, .number)));
            if (eq(name, "query")) {
                result = try Shape.listOf(gpa, try Kinds.kind(gpa, .any));
                errors = &.{ "sql", "not read-only", "too many rows", "unrepresentable", "out of range" };
            } else {
                result = try Kinds.kind(gpa, .any);
                errors = &.{ "sql", "constraint", "sqlite busy", "too many rows", "unrepresentable", "out of range" };
            }
        } else {
            result = try Kinds.kind(gpa, .nothing);
            errors = if (eq(name, "begin")) &.{ "sqlite busy", "scope already open", "scope in join" } else &.{"scope not open"};
        },
        .timer => {
            try args.append(gpa, try Kinds.kind(gpa, .text));
            if (eq(name, "schedule")) {
                try args.append(gpa, try Kinds.kind(gpa, .instant));
                try args.append(gpa, try Kinds.kind(gpa, .text));
                try args.append(gpa, try Shape.listOf(gpa, try Kinds.kind(gpa, .any)));
            }
            mode = .fire_and_forget;
        },
        .user => {
            if (eq(name, "choose")) {
                try args.append(gpa, try Shape.listOf(gpa, try Kinds.kind(gpa, .text)));
                try args.append(gpa, try Shape.optional(gpa, try Kinds.options(gpa, &.{ .{ "prompt", .text }, .{ "multiple", .boolean } })));
                result = try Kinds.kind(gpa, .any);
                errors = &.{ "user busy", "out of domain" };
            } else {
                try args.append(gpa, try Kinds.kind(gpa, .text));
                if (eq(name, "enter")) {
                    try args.append(gpa, try Shape.optional(gpa, try Kinds.options(gpa, &.{.{ "default", .text }})));
                    result = try Kinds.optionalText(gpa);
                } else if (eq(name, "notify")) {
                    try args.append(gpa, try Shape.optional(gpa, try Kinds.options(gpa, &.{.{ "title", .text }})));
                } else {
                    result = try Kinds.kind(gpa, .boolean);
                }
                if (!eq(name, "notify")) errors = &.{"user busy"};
            }
            if (eq(name, "notify")) {
                mode = .fire_and_forget;
            } else {
                // As long as console's read: a person can take their time.
                mode = .suspending;
                max_pending = 2_147_483_647;
            }
        },
        .console => if (eq(name, "write")) {
            try args.append(gpa, try Kinds.kind(gpa, .value));
            mode = .fire_and_forget;
        } else {
            result = try Kinds.kind(gpa, .text);
            mode = .suspending;
            max_pending = 2_147_483_647;
        },
    }
    const decls = try gpa.alloc(caps.ErrorDecl, errors.len);
    for (errors, decls) |code, *d| {
        // The catalogue's fields, with the kinds the chapter gives them. The
        // `store` codes declare none, as the other Cores' declarations do; a
        // Fail's fields are still held to the catalogue.
        const fields: []const struct { []const u8, caps.Kind } = if (which == .store)
            &.{}
        else if (std.mem.eql(u8, code, "unknown zone"))
            &.{.{ "zone", .text }}
        else if (std.mem.eql(u8, code, "ambiguous time"))
            &.{ .{ "civil", .civil_date }, .{ "zone", .text } }
        else if (std.mem.eql(u8, code, "can't store"))
            &.{.{ "kind", .text }}
        else if (std.mem.eql(u8, code, "store full") or std.mem.eql(u8, code, "watch limit"))
            &.{.{ "limit", .text }}
        else if (std.mem.eql(u8, code, "store busy"))
            &.{.{ "key", .text }}
        else if (std.mem.eql(u8, code, "invalid watch"))
            &.{.{ "field", .text }}
        else if (std.mem.eql(u8, code, "wrong kind"))
            &.{ .{ "expected", .text }, .{ "got", .text }, .{ "value", .value } }
        else if (std.mem.eql(u8, code, "incompatible units"))
            &.{ .{ "left", .text }, .{ "right", .text } }
        else if (std.mem.eql(u8, code, "overflow"))
            &.{.{ "operator", .text }}
        else if (std.mem.eql(u8, code, "sql"))
            &.{.{ "reason", .text }}
        else if (std.mem.eql(u8, code, "constraint"))
            &.{.{ "kind", .text }}
        else if (std.mem.eql(u8, code, "too many rows"))
            &.{.{ "max", .number }}
        else if (std.mem.eql(u8, code, "unrepresentable"))
            &.{.{ "column", .text }}
        else if (std.mem.eql(u8, code, "out of domain"))
            &.{ .{ "function", .text }, .{ "value", .value } }
        else
            &.{};
        const out = try gpa.alloc(caps.Field, fields.len);
        for (fields, out) |f, *x| x.* = .{ .key = try gpa.dupe(u8, f[0]), .shape = try Shape.kind(gpa, f[1]) };
        // The limits each quota error may name (chapter 6).
        const choice: ?caps.Choice = if (std.mem.eql(u8, code, "store full"))
            .{ .field = "limit", .words = &.{ "size", "keys", "value" } }
        else if (std.mem.eql(u8, code, "watch limit"))
            .{ .field = "limit", .words = &.{ "watches", "size", "pending" } }
        else if (std.mem.eql(u8, code, "constraint"))
            .{ .field = "kind", .words = &.{ "unique", "primary key", "not null", "check", "foreign key", "datatype", "trigger", "other" } }
        else
            null;
        const core = for ([_][]const u8{ "invalid key", "invalid watch", "out of domain", "out of range", "scope already open", "scope in join", "scope not open" }) |x| {
            if (std.mem.eql(u8, x, code)) break true;
        } else false;
        d.* = .{ .code = try gpa.dupe(u8, code), .fields = out, .choice = choice, .core = core };
    }
    return .{
        .name = try gpa.dupe(u8, name),
        .args = try args.toOwnedSlice(gpa),
        .result = result,
        .mode = mode,
        .max_pending_ms = max_pending,
        .errors = decls,
        .closed_errors = true,
        .segment_bound = (which == .store and storeWrite(name)) or (which == .sqlite and !eq(name, "query")),
        // Owned, as every definition's scope names are.
        .scope = if (which != .sqlite) .none else if (eq(name, "begin"))
            .{ .opens = .{ .name = try gpa.dupe(u8, "transaction"), .abandon = try gpa.dupe(u8, "rollback") } }
        else if (eq(name, "commit") or eq(name, "rollback"))
            .{ .closes = try gpa.dupe(u8, "transaction") }
        else
            .none,
        .host = undefined,
        .before = switch (which) {
            .calendar => if (eq(name, "toInstant")) beforeToInstant else null,
            .locale => beforeLocale,
            .store => if (eq(name, "keys")) null else beforeStore,
            .sqlite => if (eq(name, "query") or eq(name, "change")) beforeSqlite else null,
            .user => if (eq(name, "choose")) beforeChoose else null,
            else => null,
        },
        .after = switch (which) {
            .calendar => afterCalendar,
            .locale => afterLocale,
            .user => if (eq(name, "choose")) afterChoose else null,
            else => null,
        },
    };
}

/// Makes a Standard Capability. `impl` holds a Host function for each of
/// its Operations, in `operations` order, and `costs` a cost for each; the
/// contexts the Operations need are appended to `contexts`, which the
/// caller frees with the definition.
/// A Capability with Segment-bound Operations, `store`, also takes how its
/// Grants map to Segment Coordinators.
pub fn define(gpa: Allocator, which: Which, impl: []const ?caps.HostFn, costs: []const caps.Cost, contexts: *std.ArrayList(*Context), coordinator_of: ?caps.CoordinatorOf) !*caps.Capability {
    const ops = operations(which);
    const out = try gpa.alloc(caps.Operation, ops.len);
    for (ops, out, 0..) |name, *op, i| {
        op.* = try declare(gpa, which, name);
        op.cost = costs[i];
        const context = try gpa.create(Context);
        context.* = .{ .gpa = gpa, .which = which, .name = op.name, .impl = impl[i] orelse .{ .call = refuse } };
        try contexts.append(gpa, context);
        op.host = .{ .call = resolved, .context = context };
    }
    const c = try gpa.create(caps.Capability);
    c.* = .{ .name = try gpa.dupe(u8, @tagName(which)), .operations = out, .coordinator_of = coordinator_of };
    return c;
}

fn refuse(_: ?*anyopaque, _: *caps.Call, _: []const *Value) caps.Outcome {
    return .broken;
}

const disambiguations = [_][]const u8{ "compatible", "earlier", "later", "reject" };

fn among(word: []const u8, list: []const []const u8) bool {
    for (list) |w| if (std.mem.eql(u8, w, word)) return true;
    return false;
}

fn isText(v: *const Value, list: []const []const u8) bool {
    return v.data == .text and among(v.data.text, list);
}

/// A Locale call's optional positions: the options map and the tag.
const LocaleArgs = struct { options: ?*Value, tag: ?*Value, misplaced: ?*Value = null };

fn localeArgs(op: *const caps.Operation, args: []const *Value) LocaleArgs {
    const required = op.required();
    const optional = args[required..];
    if (op.args.len - required == 1) return .{ .options = null, .tag = if (optional.len > 0) optional[0] else null };
    return switch (optional.len) {
        0 => .{ .options = null, .tag = null },
        1 => if (optional[0].data == .text) .{ .options = null, .tag = optional[0] } else .{ .options = optional[0], .tag = null },
        else => .{ .options = optional[0], .tag = optional[1], .misplaced = if (optional[0].data == .text) optional[0] else null },
    };
}

fn beforeToInstant(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    _ = a;
    _ = op;
    _ = binding;
    const civil = args[0];
    if (!civil.data.civil_date.has_time) return .{ .out_of_domain = civil };
    if (args.len == 3 and args[1].data == .text and !isText(args[1], &disambiguations)) return .{ .out_of_domain = args[1] };
    return null;
}

/// `choose`'s own check: at least one item to choose from.
fn beforeChoose(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    _ = a;
    _ = op;
    _ = binding;
    return if (args[0].data.list.len == 0) .{ .out_of_domain = args[0] } else null;
}

/// A `choose` answer: Nothing, one of the items, or with `multiple: true` a
/// list that is a subsequence of them, no position taken twice.
fn afterChoose(op: *const caps.Operation, args: []const *Value, result: *const Value) bool {
    _ = op;
    if (result.data == .nothing) return true;
    const items = args[0].data.list;
    const multiple = blk: {
        if (args.len < 2 or args[1].data != .map) break :blk false;
        const m = args[1].get("multiple") orelse break :blk false;
        break :blk m.data == .bool and m.data.bool;
    };
    if (!multiple) {
        if (result.data != .text) return false;
        for (items) |x| if (std.mem.eql(u8, x.data.text, result.data.text)) return true;
        return false;
    }
    if (result.data != .list) return false;
    // Each chosen item matches a later position than the one before.
    var at: usize = 0;
    for (result.data.list) |chosen| {
        if (chosen.data != .text) return false;
        while (at < items.len and !std.mem.eql(u8, items[at].data.text, chosen.data.text)) at += 1;
        if (at == items.len) return false;
        at += 1;
    }
    return true;
}

fn beforeSqlite(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    _ = op;
    return sqlite.check(a, args, binding);
}

/// `store`'s own checks: a nonempty key, or for the watch Operations a
/// nonempty name and a plain Name as the effective message.
fn beforeStore(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    _ = a;
    _ = binding;
    const watching = std.mem.eql(u8, op.name, "watch") or std.mem.eql(u8, op.name, "unwatch");
    if (!watching) return if (args[0].data.text.len == 0) .invalid_key else null;
    if (args[0].data.text.len == 0) return .{ .invalid_watch = "name" };
    if (std.mem.eql(u8, op.name, "watch") and !plainName(effectiveMessage(args))) return .{ .invalid_watch = "message" };
    return null;
}

/// `watch`'s message, `storeChanged` when omitted or Nothing.
fn effectiveMessage(args: []const *Value) []const u8 {
    if (args.len > 2 and args[2].data == .text) return args[2].data.text;
    return "storeChanged";
}

/// A plain Name: an identifier word that isn't a Reserved Word, `_` or
/// `all`, and so no Selector.
fn plainName(w: []const u8) bool {
    if (w.len == 0) return false;
    if (!(std.ascii.isAlphabetic(w[0]) or w[0] == '_' or w[0] >= 0x80)) return false;
    for (w) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_' or c >= 0x80)) return false;
    if (std.mem.eql(u8, w, "all") or std.mem.eql(u8, w, "_")) return false;
    for (grammar.reserved) |r| if (std.mem.eql(u8, r, w)) return false;
    return true;
}

fn beforeLocale(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    _ = a;
    const given = localeArgs(op, args);
    if (given.misplaced) |v| return .{ .out_of_domain = v };
    if (given.options) |o| if (o.data == .map) for (o.data.map) |p| {
        const words: []const []const u8 = if (std.mem.eql(u8, p.key, "sensitivity"))
            &.{ "base", "accent", "case", "variant" }
        else if (std.mem.eql(u8, p.key, "width"))
            &.{ "long", "short", "narrow" }
        else if (std.mem.eql(u8, p.key, "form"))
            &.{ "format", "standalone" }
        else
            continue;
        if (!isText(p.value, words)) return .{ .out_of_domain = p.value };
    };
    const tag: []const u8 = if (given.tag) |t| (if (t.data == .text) t.data.text else defaultTag(binding)) else defaultTag(binding);
    if (!wellFormed(tag)) return .{ .bad_locale = tag };
    return null;
}

/// The Grant's default Locale tag: its binding, as NUL-terminated text, or
/// the root Locale.
fn defaultTag(binding: ?*anyopaque) []const u8 {
    const b = binding orelse return "und";
    return std.mem.span(@as([*:0]const u8, @ptrCast(b)));
}

fn afterCalendar(op: *const caps.Operation, args: []const *Value, result: *const Value) bool {
    _ = args;
    if (result.data != .civil_date) return true;
    const time = result.data.civil_date.has_time;
    return if (std.mem.eql(u8, op.name, "today")) !time else time;
}

fn integerOf(v: *const Value) ?i64 {
    if (v.data != .number) return null;
    return v.data.number.integer(i64) catch null;
}

fn texts(v: *const Value, n: usize) bool {
    if (v.data != .list or v.data.list.len != n) return false;
    for (v.data.list) |x| if (x.data != .text or x.data.text.len == 0) return false;
    return true;
}

fn afterLocale(op: *const caps.Operation, args: []const *Value, result: *const Value) bool {
    const name = op.name;
    if (std.mem.eql(u8, name, "compare")) {
        const n = integerOf(result) orelse return false;
        return n >= -1 and n <= 1;
    }
    if (std.mem.eql(u8, name, "monthNames")) return texts(result, 12);
    if (std.mem.eql(u8, name, "dayNames")) return texts(result, 7);
    if (std.mem.eql(u8, name, "tag")) return wellFormed(result.data.text);
    if (std.mem.eql(u8, name, "numberSymbols")) {
        if (result.data != .map or result.data.map.len != 7) return false;
        for ([_][]const u8{ "decimal", "group", "minus" }) |k| {
            const v = result.get(k) orelse return false;
            if (v.data != .text or v.data.text.len == 0) return false;
        }
        if (!texts(result.get("digits") orelse return false, 10)) return false;
        for ([_][]const u8{ "primaryGroup", "secondaryGroup", "minGrouping" }) |k| {
            const n = integerOf(result.get(k) orelse return false) orelse return false;
            if (n < 1) return false;
        }
        return true;
    }
    if (std.mem.eql(u8, name, "rank")) {
        // Keys exactly the distinct texts, and ranks dense from 1.
        if (result.data != .map) return false;
        const given = args[0].data.list;
        for (given) |t| if (result.get(t.data.text) == null) return false;
        for (result.data.map) |p| {
            for (given) |t| {
                if (std.mem.eql(u8, t.data.text, p.key)) break;
            } else return false;
        }
        var top: i64 = 0;
        for (result.data.map) |p| {
            const n = integerOf(p.value) orelse return false;
            if (n < 1 or n > @as(i64, @intCast(result.data.map.len))) return false;
            top = @max(top, n);
        }
        var r: i64 = 1;
        while (r <= top) : (r += 1) {
            for (result.data.map) |p| {
                if (integerOf(p.value).? == r) break;
            } else return false;
        }
        return true;
    }
    return true;
}

/// The Host function the Core runs for a Standard Operation: it answers
/// `clock.now` itself, and otherwise resolves the arguments and calls the
/// Host's.
fn resolved(context: ?*anyopaque, call: *caps.Call, args: []const *Value) caps.Outcome {
    const ctx: *Context = @ptrCast(@alignCast(context.?));
    const gpa = ctx.gpa;
    if (ctx.which == .clock) return .{ .value = model.scalar(gpa, .{ .instant = call.now }) catch return .broken };
    var made: std.ArrayList(*Value) = .empty;
    defer {
        for (made.items) |v| v.release();
        made.deinit(gpa);
    }
    var out: std.ArrayList(*Value) = .empty;
    defer out.deinit(gpa);
    resolve(ctx, args, &out, &made) catch return .broken;
    return ctx.impl.call(ctx.impl.context, call, out.items);
}

fn resolve(ctx: *Context, args: []const *Value, out: *std.ArrayList(*Value), made: *std.ArrayList(*Value)) !void {
    const gpa = ctx.gpa;
    const fresh = struct {
        fn f(g: Allocator, m: *std.ArrayList(*Value), v: *Value) !*Value {
            try m.append(g, v);
            return v;
        }
    }.f;
    const nothing = try fresh(gpa, made, try model.scalar(gpa, .nothing));
    switch (ctx.which) {
        .clock => {},
        .timer, .console, .sqlite => try out.appendSlice(gpa, args),
        .user => {
            // The message or items, then each option, in the order the
            // Host function takes them: an omitted text is empty, and an
            // omitted `multiple` false.
            try out.append(gpa, args[0]);
            const options: ?*Value = if (args.len > 1 and args[1].data == .map) args[1] else null;
            const fields: []const []const u8 = if (std.mem.eql(u8, ctx.name, "choose"))
                &.{ "prompt", "multiple" }
            else if (std.mem.eql(u8, ctx.name, "enter"))
                &.{"default"}
            else if (std.mem.eql(u8, ctx.name, "notify"))
                &.{"title"}
            else
                &.{};
            for (fields) |f| {
                const given = if (options) |o| o.get(f) else null;
                try out.append(gpa, given orelse if (std.mem.eql(u8, f, "multiple"))
                    try fresh(gpa, made, try model.scalar(gpa, .{ .bool = false }))
                else
                    try fresh(gpa, made, try model.text(gpa, "")));
            }
        },
        .store => {
            // Each omitted default: get's and increment's Nothing, keys'
            // empty prefix, and watch's effective message.
            const name = ctx.name;
            try out.appendSlice(gpa, args);
            if ((std.mem.eql(u8, name, "get") or std.mem.eql(u8, name, "increment")) and args.len == 1) try out.append(gpa, nothing);
            if (std.mem.eql(u8, name, "keys") and (args.len == 0 or args[0].data == .nothing)) {
                const all = try fresh(gpa, made, try model.text(gpa, ""));
                if (args.len == 0) try out.append(gpa, all) else out.items[0] = all;
            }
            if (std.mem.eql(u8, name, "watch")) {
                const message = try fresh(gpa, made, try model.text(gpa, effectiveMessage(args)));
                if (args.len > 2) out.items[2] = message else try out.append(gpa, message);
            }
        },
        .calendar => {
            const name = ctx.name;
            const zone_at: usize = if (std.mem.eql(u8, name, "toInstant")) 1 else if (std.mem.eql(u8, name, "toCivil") or std.mem.eql(u8, name, "offset")) 1 else 0;
            try out.appendSlice(gpa, args[0..zone_at]);
            if (std.mem.eql(u8, name, "toInstant")) {
                // The disambiguation and the zone, told apart by count.
                var how: *Value = try fresh(gpa, made, try model.text(gpa, "compatible"));
                var zone: *Value = nothing;
                if (args.len == 3) {
                    if (args[1].data == .text) how = args[1];
                    zone = args[2];
                } else if (args.len == 2) {
                    if (isText(args[1], &disambiguations)) how = args[1] else zone = args[1];
                }
                try out.append(gpa, how);
                try out.append(gpa, zone);
            } else try out.append(gpa, if (args.len > zone_at) args[zone_at] else nothing);
        },
        .locale => {
            const op_args = args[0..@min(args.len, requiredLocale(ctx.name))];
            try out.appendSlice(gpa, op_args);
            const fields: ?[]const struct { []const u8, []const u8 } = if (std.mem.eql(u8, ctx.name, "compare") or std.mem.eql(u8, ctx.name, "rank"))
                &.{ .{ "sensitivity", "variant" }, .{ "numeric", "" } }
            else if (std.mem.eql(u8, ctx.name, "monthNames") or std.mem.eql(u8, ctx.name, "dayNames"))
                &.{ .{ "width", "long" }, .{ "form", "format" } }
            else
                null;
            const required = requiredLocale(ctx.name);
            const optional = args[@min(args.len, required)..];
            var options: ?*Value = null;
            var tag: ?*Value = null;
            if (fields == null) {
                if (optional.len > 0) tag = optional[0];
            } else switch (optional.len) {
                0 => {},
                1 => if (optional[0].data == .text) {
                    tag = optional[0];
                } else {
                    options = optional[0];
                },
                else => {
                    options = optional[0];
                    tag = optional[1];
                },
            }
            if (fields) |fs| {
                // The complete options map, defaults filled, in order.
                var pairs: [2]model.Pair = undefined;
                for (fs, 0..) |f, i| {
                    const given = if (options) |o| (if (o.data == .map) o.get(f[0]) else null) else null;
                    pairs[i] = .{ .key = f[0], .value = given orelse if (f[1].len == 0)
                        try fresh(gpa, made, try model.scalar(gpa, .{ .bool = false }))
                    else
                        try fresh(gpa, made, try model.text(gpa, f[1])) };
                }
                try out.append(gpa, try fresh(gpa, made, try model.map(gpa, &pairs)));
            }
            try out.append(gpa, if (tag) |t| (if (t.data == .text) t else nothing) else nothing);
        },
    }
}

fn requiredLocale(name: []const u8) usize {
    if (std.mem.eql(u8, name, "compare")) return 2;
    if (std.mem.eql(u8, name, "rank") or std.mem.eql(u8, name, "upper") or std.mem.eql(u8, name, "lower")) return 1;
    return 0;
}

// ---------------------------------------------------------------- tags

fn alpha(s: []const u8) bool {
    for (s) |c| if (!std.ascii.isAlphabetic(c)) return false;
    return true;
}

fn digits(s: []const u8) bool {
    for (s) |c| if (!std.ascii.isDigit(c)) return false;
    return true;
}

fn alnum(s: []const u8) bool {
    for (s) |c| if (!std.ascii.isAlphanumeric(c)) return false;
    return true;
}

const grandfathered = [_][]const u8{
    "en-gb-oed",   "i-ami",  "i-bnn",  "i-default", "i-enochian", "i-hak",     "i-klingon",  "i-lux",     "i-mingo",
    "i-navajo",    "i-pwn",  "i-tao",  "i-tay",     "i-tsu",      "sgn-be-fr", "sgn-be-nl",  "sgn-ch-de", "art-lojban",
    "cel-gaulish", "no-bok", "no-nyn", "zh-guoyu",  "zh-hakka",   "zh-min",    "zh-min-nan", "zh-xiang",
};

/// Whether `tag` is well-formed BCP 47: RFC 5646 section 2.1's ABNF, case
/// insensitive, with private-use and grandfathered tags.
pub fn wellFormed(tag: []const u8) bool {
    for (grandfathered) |g| if (std.ascii.eqlIgnoreCase(g, tag)) return true;
    var parts: [64][]const u8 = undefined;
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, tag, '-');
    while (it.next()) |p| {
        if (n == parts.len or p.len == 0 or p.len > 8 or !alnum(p)) return false;
        parts[n] = p;
        n += 1;
    }
    const ps = parts[0..n];
    var i: usize = 0;
    if (privateUse(ps)) return true;
    // language: 2-3 ALPHA with up to three extlangs, or 4-8 ALPHA.
    const lang = ps[0];
    if (!alpha(lang) or lang.len < 2) return false;
    i = 1;
    if (lang.len <= 3) {
        var ext: usize = 0;
        while (i < n and ext < 3 and ps[i].len == 3 and alpha(ps[i])) : (i += 1) ext += 1;
    }
    if (i < n and ps[i].len == 4 and alpha(ps[i])) i += 1;
    if (i < n and ((ps[i].len == 2 and alpha(ps[i])) or (ps[i].len == 3 and digits(ps[i])))) i += 1;
    while (i < n and ((ps[i].len >= 5) or (ps[i].len == 4 and std.ascii.isDigit(ps[i][0])))) : (i += 1) {}
    while (i < n and ps[i].len == 1 and !std.ascii.eqlIgnoreCase(ps[i], "x")) {
        i += 1;
        var subtags: usize = 0;
        while (i < n and ps[i].len >= 2) : (i += 1) subtags += 1;
        if (subtags == 0) return false;
    }
    if (i < n) return privateUse(ps[i..]);
    return true;
}

fn privateUse(ps: []const []const u8) bool {
    if (ps.len < 2 or !std.ascii.eqlIgnoreCase(ps[0], "x")) return false;
    return true;
}

test "BCP 47 well-formedness" {
    for ([_][]const u8{ "en", "en-GB", "de-CH-1996", "zh-Hant-TW", "qzz-QZ", "und", "x-private", "en-US-u-co-phonebk", "i-klingon", "sr-Latn-RS", "es-419" }) |t| try std.testing.expect(wellFormed(t));
    for ([_][]const u8{ "en_US", "", "e", "en-", "toolongtag", "en-u", "x", "en-GB-x" }) |t| try std.testing.expect(!wellFormed(t));
}

test "store's Operation Declarations, as the Group Fingerprint and the Host Manifest give them" {
    // The declarations the other Cores' Host Manifest gives for a store
    // Grant: the codes the Host fails with, with no fields, and none the
    // Core raises itself.
    const fingerprint = @import("fingerprint.zig");
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var contexts: std.ArrayList(*Context) = .empty;
    const ops = operations(.store);
    const impl = try a.alloc(?caps.HostFn, ops.len);
    @memset(impl, null);
    const costs = try a.alloc(caps.Cost, ops.len);
    for (ops, costs) |name, *x| {
        const cheap = std.mem.eql(u8, name, "get") or std.mem.eql(u8, name, "keys") or std.mem.eql(u8, name, "unwatch");
        x.* = .{ .fuel = if (cheap) 2 else 4, .alloc = 0 };
    }
    const capability = try define(a, .store, impl, costs, &contexts, null);
    const kept = try a.alloc(bool, ops.len);
    @memset(kept, true);
    try std.testing.expectEqualStrings("{\"capability\":\"store\",\"operations\":[{\"name\":\"delete\",\"mode\":\"immediate\",\"args\":[\"text\"],\"result\":\"nothing\",\"cost\":{\"fuel\":4,\"alloc\":0},\"errors\":[{\"code\":\"store busy\",\"fields\":[]}],\"segmentBound\":true},{\"name\":\"get\",\"mode\":\"immediate\",\"args\":[\"text\",{\"optional\":\"any\"}],\"result\":\"any\",\"cost\":{\"fuel\":2,\"alloc\":0},\"errors\":[]},{\"name\":\"increment\",\"mode\":\"immediate\",\"args\":[\"text\",{\"optional\":{\"oneOf\":[\"number\",\"quantity\"]}}],\"result\":{\"oneOf\":[\"number\",\"quantity\"]},\"cost\":{\"fuel\":4,\"alloc\":0},\"errors\":[{\"code\":\"incompatible units\",\"fields\":[]},{\"code\":\"overflow\",\"fields\":[]},{\"code\":\"store busy\",\"fields\":[]},{\"code\":\"store full\",\"fields\":[]},{\"code\":\"wrong kind\",\"fields\":[]}],\"segmentBound\":true},{\"name\":\"keys\",\"mode\":\"immediate\",\"args\":[{\"optional\":\"text\"}],\"result\":{\"list\":\"text\"},\"cost\":{\"fuel\":2,\"alloc\":0},\"errors\":[]},{\"name\":\"set\",\"mode\":\"immediate\",\"args\":[\"text\",\"any\"],\"result\":\"nothing\",\"cost\":{\"fuel\":4,\"alloc\":0},\"errors\":[{\"code\":\"can't store\",\"fields\":[]},{\"code\":\"store busy\",\"fields\":[]},{\"code\":\"store full\",\"fields\":[]}],\"segmentBound\":true},{\"name\":\"swap\",\"mode\":\"immediate\",\"args\":[\"text\",\"any\",\"any\"],\"result\":\"boolean\",\"cost\":{\"fuel\":4,\"alloc\":0},\"errors\":[{\"code\":\"can't store\",\"fields\":[]},{\"code\":\"store busy\",\"fields\":[]},{\"code\":\"store full\",\"fields\":[]}],\"segmentBound\":true},{\"name\":\"unwatch\",\"mode\":\"immediate\",\"args\":[\"text\"],\"result\":\"nothing\",\"cost\":{\"fuel\":2,\"alloc\":0},\"errors\":[]},{\"name\":\"watch\",\"mode\":\"immediate\",\"args\":[\"text\",\"text\",{\"optional\":\"text\"}],\"result\":\"nothing\",\"cost\":{\"fuel\":4,\"alloc\":0},\"errors\":[{\"code\":\"watch limit\",\"fields\":[]}]}]}", try fingerprint.grantJson(a, capability, kept));
}

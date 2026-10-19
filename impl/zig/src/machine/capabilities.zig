//! Capabilities (chapter 9): Shapes, Operation Declarations, Capability
//! definitions and Grants, and the checks the Core makes at a call: each
//! argument against its Shape before the Host function runs, the result
//! against the result Shape, and a `Fail` against the Operation's declared
//! codes and the reserved keys (chapter 6, Errors from Capabilities).
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const units = @import("../units.zig");
const check = @import("../check/check.zig");
const grammar = @import("../generated/grammar.zig").grammar;
const Value = model.Value;

pub const Mode = check.Mode;

/// The kinds a kind-name Shape takes.
pub const Kind = enum {
    any,
    value,
    nothing,
    boolean,
    number,
    text,
    bytes,
    instant,
    range,
    civil_date,
    pattern,
    function,
    /// Any Quantity, as `store`'s `increment` takes; only the Core's own
    /// declarations use it.
    quantity,
    /// Any list, map or Host Object, from a Script Shape's kind name
    /// (chapter 7); Host declarations spell those with wrappers instead.
    list,
    map,
    object,

    pub fn name(k: Kind) []const u8 {
        return switch (k) {
            .civil_date => "civil date",
            inline else => |x| @tagName(x),
        };
    }

    pub fn named(s: []const u8) ?Kind {
        if (std.mem.eql(u8, s, "civil date")) return .civil_date;
        if (std.mem.eql(u8, s, "civil_date") or std.mem.eql(u8, s, "quantity") or std.mem.eql(u8, s, "list") or std.mem.eql(u8, s, "map") or std.mem.eql(u8, s, "object")) return null;
        return std.meta.stringToEnum(Kind, s);
    }
};

pub const Field = struct { key: []const u8, shape: *Shape, optional: bool = false };

/// A Shape, immutable once made and reference-counted, so a Host can share
/// one between declarations.
pub const Shape = struct {
    references: usize = 1,
    allocator: Allocator,
    data: union(enum) {
        kind: Kind,
        quantity_of: struct { text: []const u8, unit: units.Unit },
        quantity_kind: []const u8,
        list: *Shape,
        map: struct { fields: []Field, open: bool },
        object: []const u8,
        one_of: []*Shape,
        optional: *Shape,
    },

    pub fn retain(s: *Shape) *Shape {
        s.references += 1;
        return s;
    }

    pub fn release(s: *Shape) void {
        s.references -= 1;
        if (s.references > 0) return;
        const a = s.allocator;
        switch (s.data) {
            .kind => {},
            .quantity_of => |q| a.free(q.text),
            .quantity_kind, .object => |t| a.free(t),
            .list, .optional => |inner| inner.release(),
            .map => |m| {
                for (m.fields) |f| {
                    a.free(f.key);
                    f.shape.release();
                }
                a.free(m.fields);
            },
            .one_of => |xs| {
                for (xs) |x| x.release();
                a.free(xs);
            },
        }
        a.destroy(s);
    }

    fn make(a: Allocator, data: @FieldType(Shape, "data")) !*Shape {
        const s = try a.create(Shape);
        s.* = .{ .allocator = a, .data = data };
        return s;
    }

    pub fn kind(a: Allocator, k: Kind) !*Shape {
        return make(a, .{ .kind = k });
    }

    /// A Quantity in exactly the Unit `text` names.
    pub fn quantityOf(a: Allocator, text: []const u8) !*Shape {
        const unit = units.Unit.parse(text) catch return error.InvalidValue;
        const copy = try a.dupe(u8, text);
        errdefer a.free(copy);
        return make(a, .{ .quantity_of = .{ .text = copy, .unit = unit } });
    }

    /// A Quantity of any Unit of the Unit Kind `kind`.
    pub fn quantityKind(a: Allocator, kind_name: []const u8) !*Shape {
        for (units.table.kind) |k| {
            if (std.mem.eql(u8, k.name, kind_name)) break;
        } else return error.InvalidValue;
        const copy = try a.dupe(u8, kind_name);
        errdefer a.free(copy);
        return make(a, .{ .quantity_kind = copy });
    }

    /// A Host Object of the Object Kind `kind_name`.
    pub fn objectOf(a: Allocator, kind_name: []const u8) !*Shape {
        const copy = try a.dupe(u8, kind_name);
        errdefer a.free(copy);
        return make(a, .{ .object = copy });
    }

    /// Takes `inner`.
    pub fn listOf(a: Allocator, inner: *Shape) !*Shape {
        return make(a, .{ .list = inner });
    }

    /// Takes `inner`.
    pub fn optional(a: Allocator, inner: *Shape) !*Shape {
        return make(a, .{ .optional = inner });
    }

    /// Takes the fields, whose keys must be allocated with `a`.
    pub fn map(a: Allocator, fields: []Field, open: bool) !*Shape {
        return make(a, .{ .map = .{ .fields = fields, .open = open } });
    }

    /// Takes the Shapes, a slice allocated with `a`.
    pub fn oneOf(a: Allocator, shapes: []*Shape) !*Shape {
        return make(a, .{ .one_of = shapes });
    }

    /// What the Shape expects, as `wrong kind` writes it.
    pub fn expected(s: *const Shape, a: Allocator) ![]const u8 {
        return switch (s.data) {
            .kind => |k| k.name(),
            .quantity_of => |q| q.text,
            .quantity_kind => |k| k,
            .list => "list",
            .map => "map",
            .object => |k| k,
            .one_of => |xs| blk: {
                var out: std.ArrayList(u8) = .empty;
                for (xs, 0..) |x, i| {
                    if (i > 0) try out.appendSlice(a, " or ");
                    try out.appendSlice(a, try x.expected(a));
                }
                break :blk out.items;
            },
            .optional => |inner| try std.fmt.allocPrint(a, "{s} or nothing", .{try inner.expected(a)}),
        };
    }

    /// Whether an argument in this position may be left off: an outer
    /// Optional.
    pub fn omittable(s: *const Shape) bool {
        return s.data == .optional;
    }
};

/// The first node of a value that breaks a Shape.
pub const Mismatch = union(enum) {
    /// `wrong kind`: what was expected, what the node is, and its path.
    wrong_kind: struct { expected: []const u8, got: []const u8, value: *Value, path: []const *Value },
    /// `not encodable`: a Function Value found by an `any` or open-map data scan.
    not_encodable: struct { path: []const *Value },
};

const Checker = struct {
    a: Allocator,
    gpa: Allocator,
    path: std.ArrayList(*Value) = .empty,
    /// Path values live in the scratch list until the caller copies them.
    kept: std.ArrayList(*Value) = .empty,

    fn got(c: *Checker, s: *const Shape, v: *const Value) ![]const u8 {
        if ((s.data == .quantity_of or s.data == .quantity_kind) and v.data == .quantity) {
            return try v.data.quantity.unit.string(c.a, false);
        }
        return switch (v.data) {
            .bool => "boolean",
            .civil_date => "civil date",
            else => @tagName(v.data),
        };
    }

    fn wrong(c: *Checker, s: *const Shape, v: *Value) !Mismatch {
        return .{ .wrong_kind = .{ .expected = try s.expected(c.a), .got = try c.got(s, v), .value = v, .path = try c.a.dupe(*Value, c.path.items) } };
    }

    fn missing(c: *Checker, s: *const Shape) !Mismatch {
        const v = try model.scalar(c.gpa, .nothing);
        try c.keep(v);
        return .{ .wrong_kind = .{ .expected = try s.expected(c.a), .got = "nothing", .value = v, .path = try c.a.dupe(*Value, c.path.items) } };
    }

    fn keep(c: *Checker, v: *Value) !void {
        try c.kept.append(c.a, v);
    }

    fn enter(c: *Checker, key: union(enum) { index: usize, key: []const u8 }) !void {
        const v = switch (key) {
            .index => |i| try model.scalar(c.gpa, .{ .number = model.Decimal.fromInt(@as(i64, @intCast(i))) }),
            .key => |k| try model.text(c.gpa, k),
        };
        try c.keep(v);
        try c.path.append(c.a, v);
    }

    fn leave(c: *Checker) void {
        _ = c.path.pop();
    }

    /// A Function Value anywhere in `v`, for a data Shape, searched depth
    /// first from a heap work list. Its path is made only when one is found.
    fn function(c: *Checker, root: *Value) !?Mismatch {
        const Step = union(enum) { none, index: usize, key: []const u8 };
        const Frame = struct { v: *Value, step: Step = .none, next: usize = 0 };
        var stack: std.ArrayList(Frame) = .empty;
        defer stack.deinit(c.a);
        try stack.append(c.a, .{ .v = root });
        while (stack.items.len > 0) {
            const top = &stack.items[stack.items.len - 1];
            if (top.v.data == .function) {
                for (stack.items) |f| switch (f.step) {
                    .none => {},
                    .index => |i| try c.enter(.{ .index = i }),
                    .key => |k| try c.enter(.{ .key = k }),
                };
                return .{ .not_encodable = .{ .path = try c.a.dupe(*Value, c.path.items) } };
            }
            const i = top.next;
            const child: ?Frame = switch (top.v.data) {
                .list => |xs| if (i < xs.len) .{ .v = xs[i], .step = .{ .index = i + 1 } } else null,
                .map => |pairs| if (i < pairs.len) .{ .v = pairs.at(i).value, .step = .{ .key = pairs.at(i).key } } else null,
                .range => |r| if (i < 2) .{ .v = if (i == 0) r.from else r.to } else null,
                else => null,
            };
            if (child) |f| {
                top.next += 1;
                try stack.append(c.a, f);
            } else _ = stack.pop();
        }
        return null;
    }

    fn shape(c: *Checker, s: *const Shape, v: *Value) anyerror!?Mismatch {
        switch (s.data) {
            .kind => |k| {
                switch (k) {
                    .value => return null,
                    .function => return if (v.data == .function) null else try c.wrong(s, v),
                    .any => return c.function(v),
                    else => {},
                }
                const ok = switch (k) {
                    .nothing => v.data == .nothing,
                    .boolean => v.data == .bool,
                    .number => v.data == .number,
                    .text => v.data == .text,
                    .bytes => v.data == .bytes,
                    .instant => v.data == .instant,
                    .range => v.data == .range,
                    .civil_date => v.data == .civil_date,
                    .pattern => v.data == .pattern,
                    .quantity => v.data == .quantity,
                    .list => v.data == .list,
                    .map => v.data == .map,
                    .object => v.data == .object,
                    .any, .value, .function => unreachable,
                };
                return if (ok) null else try c.wrong(s, v);
            },
            .quantity_of => |q| {
                if (v.data == .quantity and std.meta.eql(v.data.quantity.unit, q.unit)) return null;
                return try c.wrong(s, v);
            },
            .quantity_kind => |name| {
                if (v.data == .quantity and ofKind(v.data.quantity.unit, name)) return null;
                return try c.wrong(s, v);
            },
            .object => {
                if (v.data == .object and std.mem.eql(u8, v.data.object.kind, s.data.object)) return null;
                return try c.wrong(s, v);
            },
            .list => |inner| {
                if (v.data != .list) return try c.wrong(s, v);
                for (v.data.list, 1..) |x, i| {
                    try c.enter(.{ .index = i });
                    if (try c.shape(inner, x)) |m| return m;
                    c.leave();
                }
                return null;
            },
            .map => |m| {
                if (v.data != .map) return try c.wrong(s, v);
                for (m.fields) |f| {
                    try c.enter(.{ .key = f.key });
                    if (v.get(f.key)) |x| {
                        if (try c.shape(f.shape, x)) |bad| return bad;
                    } else if (!f.optional) return try c.missing(f.shape);
                    c.leave();
                }
                if (m.open) {
                    // An open map's other entries are data.
                    for (0..v.data.map.len) |map_index| {
                        const p = v.data.map.at(map_index);
                        if (field(m.fields, p.key) != null) continue;
                        try c.enter(.{ .key = p.key });
                        if (try c.function(p.value)) |bad| return bad;
                        c.leave();
                    }
                    return null;
                }
                for (0..v.data.map.len) |map_index| {
                    const p = v.data.map.at(map_index);
                    if (field(m.fields, p.key) != null) continue;
                    try c.enter(.{ .key = p.key });
                    const nothing_shape: Shape = .{ .allocator = c.a, .data = .{ .kind = .nothing } };
                    return try c.wrong(&nothing_shape, p.value);
                }
                return null;
            },
            .one_of => |xs| {
                for (xs) |x| {
                    const depth = c.path.items.len;
                    if (try c.shape(x, v) == null) return null;
                    c.path.shrinkRetainingCapacity(depth);
                }
                return try c.wrong(s, v);
            },
            .optional => |inner| {
                if (v.data == .nothing) return null;
                const depth = c.path.items.len;
                var bad = try c.shape(inner, v) orelse return null;
                // A mismatch at this node expects the Shape or Nothing.
                if (bad == .wrong_kind and bad.wrong_kind.path.len == depth) bad.wrong_kind.expected = try s.expected(c.a);
                return bad;
            },
        }
    }
};

fn field(fields: []const Field, key: []const u8) ?Field {
    for (fields) |f| if (std.mem.eql(u8, f.key, key)) return f;
    return null;
}

pub fn ofKind(unit: units.Unit, name: []const u8) bool {
    var found = false;
    for (unit.slots, units.table.kind) |s, k| {
        if (s.exponent == 0) continue;
        if (found or s.exponent != 1 or !std.mem.eql(u8, k.name, name)) return false;
        found = true;
    }
    return found;
}

/// Checks `v` against `s`. The mismatch's strings and path live in `a`;
/// its values are owned by `gpa` and released with `releaseKept`.
pub const Checked = struct {
    mismatch: ?Mismatch,
    kept: []*Value,

    pub fn release(c: Checked) void {
        for (c.kept) |v| v.release();
    }
};

pub fn checkValue(a: Allocator, gpa: Allocator, s: *const Shape, v: *Value) !Checked {
    var c: Checker = .{ .a = a, .gpa = gpa };
    const m = try c.shape(s, v);
    return .{ .mismatch = m, .kept = c.kept.items };
}

// ---------------------------------------------------------------- declarations

pub const Cost = struct { fuel: u64 = 0, alloc: u64 = 0 };

pub const ErrorDecl = struct {
    code: []const u8,
    fields: []Field,
    /// A field whose text must be one of the chapter's words, such as
    /// `store full`'s `limit`.
    choice: ?Choice = null,
    /// A code the Core raises itself, such as `invalid key`, which a Host
    /// may not fail with.
    core: bool = false,
};

pub const Choice = struct { field: []const u8, words: []const []const u8 };

/// What an Operation's Host function gives back.
pub const Outcome = union(enum) {
    /// A result, owned by the caller. A fire-and-forget call's is dropped.
    value: *Value,
    /// A Script error: its code, message and Data, which it owns.
    failed: struct { code: []const u8, message: ?[]const u8, data: ?*Value },
    /// A suspending call started; its answer comes later.
    started,
    /// `Charge` couldn't be covered, so the work wasn't done.
    limited,
    /// Any other failure, which the Script sees as `host error`.
    broken,
    /// The Host cannot answer inside this call (the Message Layer): the
    /// instruction is rewound and the Pump pauses at the crossing, to
    /// re-make the call once the answer is at hand.
    deferred,
};

/// A Host function: Do for an immediate Operation, Fire for a
/// fire-and-forget one.
pub const HostFn = struct {
    call: *const fn (context: ?*anyopaque, c: *Call, args: []const *Value) Outcome,
    context: ?*anyopaque = null,
};

/// An Operation's place in a Capability Scope's lifecycle
/// (embedding/scoped-effects.md): none, opening the named scope with its
/// abandonment Operation, or closing it.
pub const Scope = union(enum) {
    none,
    opens: struct { name: []const u8, abandon: []const u8 },
    closes: []const u8,

    /// The scope it opens or closes, or null.
    pub fn name(s: Scope) ?[]const u8 {
        return switch (s) {
            .none => null,
            .opens => |o| o.name,
            .closes => |n| n,
        };
    }
};

pub const Metering = enum { read_only, segment_bound };

/// Whether a word is a Reserved Word (chapter 1).
fn reservedWord(word: []const u8) bool {
    for (grammar.reserved) |r| if (std.mem.eql(u8, r, word)) return true;
    return false;
}

pub const Operation = struct {
    name: []const u8,
    args: []*Shape,
    /// Null for a fire-and-forget Operation.
    result: ?*Shape,
    cost: Cost = .{},
    mode: Mode,
    max_pending_ms: u64 = 0,
    /// The declared codes; empty when the Operation lists none.
    errors: []ErrorDecl = &.{},
    /// Whether the list is enforced even when empty, as for a Standard
    /// Capability, whose every undeclared failure is `host error`.
    closed_errors: bool = false,
    catalogue_errors: bool = false,
    failure: ?*const fn (code: []const u8, data: ?*const Value) bool = null,
    scope: Scope = .none,
    /// Whether its effects join the Segment's participant, deferred to the
    /// Segment's outcome.
    segment_bound: bool = false,
    /// Also callable as a Host Command, by its name alone (ADR 0094).
    command: bool = false,
    metering: ?Metering = null,
    /// For the Host Manifest only: plain text, and source texts that each
    /// call the Operation. Empty is none.
    description: []const u8 = "",
    examples: []const []const u8 = &.{},
    host: HostFn,
    /// The Core's own checks after the Shapes, before the call is charged:
    /// a Standard Capability's option words and Locale tags.
    before: ?*const fn (a: Allocator, op: *const Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?Problem = null,
    /// The Core's own checks of a result beyond its Shape; false makes the
    /// call `host error`.
    after: ?*const fn (op: *const Operation, args: []const *Value, result: *const Value) bool = null,

    /// The arguments a call must supply: up to the outer Optional suffix.
    pub fn required(op: Operation) usize {
        var n = op.args.len;
        while (n > 0 and op.args[n - 1].omittable()) n -= 1;
        return n;
    }
};

/// What the Core's own checks before a call raise.
pub const Problem = union(enum) {
    /// `out of domain`, with `function` the Operation's name.
    out_of_domain: *Value,
    /// `bad locale`, with the tag.
    bad_locale: []const u8,
    /// `invalid key`: a `store` key that is empty text.
    invalid_key,
    /// `wrong kind` or `not encodable` at an argument, as a Shape check
    /// raises it; the caller releases `keep`, a path value it made.
    mismatch: struct { bad: Mismatch, position: usize, keep: ?*Value = null },
    /// `out of range`, with the field and its value.
    out_of_range: struct { field: []const u8, value: *Value },
    /// `invalid watch`, with the field that is wrong: `name` or `message`.
    invalid_watch: []const u8,
};

/// A Segment Coordinator's hooks (embedding/scoped-effects.md).
pub const Phase = enum { begin, commit, rollback };

/// `deferred` is only for a crossing that may defer (`deferrable`): the
/// Host can't answer inside the call (the Message Layer), so the Core
/// pauses there and makes the same call again once the answer is at hand.
pub const EffectStatus = enum { ok, failed, unknown, deferred };

/// A Grant enrolled in a Segment's participant, laid out as talk.h's
/// `talk_segment_grant`.
pub const SegmentGrant = extern struct { name: [*]const u8, name_len: usize, binding: ?*anyopaque };

/// What a hook is told: whose Segment it is, the first enrolled Grant and
/// every enrolled Grant, in enrollment order.
pub const SegmentContext = struct {
    group: ?*anyopaque,
    script: []const u8,
    run: []const u8,
    segment: []const u8,
    grant: []const u8,
    binding: ?*anyopaque,
    now: model.dates.Instant,
    grants: []const SegmentGrant,
    /// Whether the hook may answer `deferred`.
    deferrable: bool = false,
};

/// A Segment Coordinator: Grants with the same `identity` share a
/// Segment's participant.
pub const Coordinator = struct {
    identity: usize,
    hook: *const fn (context: ?*anyopaque, phase: Phase, s: *const SegmentContext) EffectStatus,
    context: ?*anyopaque,
};

/// How a Capability with Segment-bound Operations maps a new Grant to its
/// Coordinator; null refuses the Grant.
pub const CoordinatorOf = struct {
    call: *const fn (context: ?*anyopaque, g: *const Grant) ?Coordinator,
    context: ?*anyopaque,
};

/// A Capability's definition: its Operations, ordered by name.
/// Why a Script's named Grant stops being effective (chapter 9).
pub const ReleaseReason = enum { stop, reload, revoke, disable };

/// What a release hook is told: whose Grant it was, its binding, the
/// Group's last Clock reading and why.
pub const GrantContext = struct {
    group: ?*anyopaque,
    script: []const u8,
    grant: []const u8,
    binding: ?*anyopaque,
    now: model.dates.Instant,
    reason: ReleaseReason,
};

/// A Capability's Grant release hook: Host work with no result, cost or
/// Trace record, which can't refuse.
pub const ReleaseHook = struct {
    call: *const fn (context: ?*anyopaque, g: *const GrantContext) void,
    context: ?*anyopaque,
};

pub const Capability = struct {
    name: []const u8,
    operations: []Operation,
    /// The Grants made from it, which it owns.
    grants: std.ArrayList(*Grant) = .empty,
    /// For a Capability with Segment-bound Operations, how each Grant gets
    /// its Segment Coordinator.
    coordinator_of: ?CoordinatorOf = null,
    release: ?ReleaseHook = null,

    /// Whether any of its Operations is Segment-bound.
    pub fn segmentBound(c: *const Capability) bool {
        for (c.operations) |op| if (op.segment_bound) return true;
        return false;
    }

    pub fn find(c: *const Capability, name: []const u8) ?usize {
        for (c.operations, 0..) |op, i| if (std.mem.eql(u8, op.name, name)) return i;
        return null;
    }

    /// Whether the scope declarations hold together: each lifecycle
    /// Operation is immediate and names an identifier word, and each
    /// opener's abandonment Operation is one of this Capability's that
    /// closes the same scope, takes no arguments and returns Nothing, the
    /// same one for every opener of that scope. No Operation that is a
    /// Reserved Word is a Host Command, since a Command Call can't start
    /// with one (ADR 0094).
    pub fn validScopes(c: *const Capability) bool {
        for (c.operations) |op| {
            if (op.command and reservedWord(op.name)) return false;
            if (op.segment_bound and op.mode != .immediate) return false;
            if (op.metering) |metering| switch (metering) {
                .read_only => if (op.mode == .fire_and_forget or op.segment_bound or op.scope != .none) return false,
                .segment_bound => if (op.mode != .immediate or !op.segment_bound) return false,
            };
            // Every lifecycle Operation of a scope agrees on being
            // Segment-bound.
            const name = op.scope.name() orelse continue;
            for (c.operations) |other| if (other.scope.name()) |n| if (std.mem.eql(u8, n, name) and other.segment_bound != op.segment_bound) return false;
        }
        for (c.operations) |op| switch (op.scope) {
            .none => {},
            .closes => |n| if (op.mode != .immediate or !scopeWord(n)) return false,
            .opens => |o| {
                if (op.mode != .immediate or !scopeWord(o.name)) return false;
                const target = c.operations[c.find(o.abandon) orelse return false];
                if (target.scope != .closes or !std.mem.eql(u8, target.scope.closes, o.name)) return false;
                if (target.args.len != 0) return false;
                const result = target.result orelse return false;
                if (result.data != .kind or result.data.kind != .nothing) return false;
                for (c.operations) |other| if (other.scope == .opens and std.mem.eql(u8, other.scope.opens.name, o.name) and !std.mem.eql(u8, other.scope.opens.abandon, o.abandon)) return false;
            },
        };
        return true;
    }

    /// Whether a Grant keeping `kept` keeps every kept opener's abandonment
    /// Operation.
    pub fn keepsAbandonment(c: *const Capability, kept: []const bool) bool {
        for (c.operations, kept) |op, k| if (k and op.scope == .opens and !kept[c.find(op.scope.opens.abandon).?]) return false;
        return true;
    }
};

/// A scope name: a nonempty identifier word.
fn scopeWord(s: []const u8) bool {
    if (s.len == 0 or std.ascii.isDigit(s[0])) return false;
    for (s) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '_') return false;
    return true;
}

/// A reusable Grant: a set of a Capability's Operations and the Host's
/// binding.
pub const Grant = struct {
    capability: *Capability,
    /// Which Operations, by index into the Capability's.
    operations: []bool,
    binding: ?*anyopaque = null,
    /// Its Segment Coordinator, mapped once when it is made.
    coordinator: ?Coordinator = null,
};

/// What an Operation's Host function receives.
pub const ChargeStatus = enum { accepted, limit, inactive };
pub const ChargeRequest = struct {
    id: []const u8,
    call: []const u8,
    fuel: u64,
    status: ChargeStatus = .inactive,
    done: std.atomic.Value(bool) = .init(false),
    processed: bool = false,
    fault_run: ?*anyopaque = null,
};

pub const Call = struct {
    id: []const u8,
    script: []const u8,
    grant: []const u8,
    binding: ?*anyopaque,
    /// The Pump's Clock reading.
    now: model.dates.Instant,
    /// What `Charge` drew.
    charged: u64 = 0,
    request_eligible: bool = false,
    /// Saved call site, including the particular Join Member.
    at_unit: []const u8 = "",
    at_pc: u32 = 0,
    at_line: u32 = 0,
    at_column: u32 = 0,
    /// The Fuel the Run has left after the declared cost; null when there
    /// is no limit.
    left: ?u64,
    /// Whether the Operation is still starting, the only time `Charge` is
    /// legal.
    starting: bool = true,
    /// For a suspending call, the Group its answer goes to.
    group: ?*anyopaque = null,
    /// The Group that made the call, whatever its mode.
    owner: ?*anyopaque = null,
    run: []const u8 = "",
    /// The current Segment's id, `<run>.s<N>`.
    segment: []const u8 = "",
    /// The scope a lifecycle Operation opens or closes, or empty.
    scope: []const u8 = "",
    /// Whether the Core is abandoning a scope, when `Charge` is a Host
    /// contract failure.
    automatic: bool = false,
    /// A refused charge is latched for the entire callback.
    charge_refused: bool = false,
    /// Whether an automatic call may answer `deferred`; an Operation's own
    /// call always may.
    deferrable: bool = true,
    /// A suspending call's arguments, kept when its Operation checks the
    /// answer against them; the Group releases them.
    args: []*Value = &.{},
    /// The Group's allocator, which owns a failure's code and message.
    gpa: std.mem.Allocator,
    /// Whether its wait ended without its answer: a failed Join, a
    /// cancelled Run, a stop, a timeout or a lost restore. The Host may
    /// read it from any thread.
    abandoned: std.atomic.Value(bool) = .init(false),
    /// The resuming Run has consumed its queued settlement.
    settlement_consumed: bool = false,
    /// Whether `at_unit` and `segment` are the Group allocator's, freed
    /// with the Call, rather than borrowed.
    owns_place: bool = false,
    /// Core-only diagnostic state; never exported to Hosts or saved.
    abandon_reason: ?@import("waits.zig").AbandonReason = null,

    /// Draws Fuel before the work; false when the Run can't cover it.
    pub fn charge(c: *Call, fuel: u64) bool {
        if (c.automatic) {
            c.charge_refused = true;
            return false;
        }
        if (!c.starting or c.charge_refused) return false;
        if (c.left) |left| if (fuel > left -| c.charged) {
            c.charge_refused = true;
            return false;
        };
        c.charged += fuel;
        return true;
    }
};

/// The reserved keys a `Fail`'s Data may not use (chapter 6).
pub const reserved = [_][]const u8{ "code", "message", "at", "capability", "operation", "index", "during", "deadline" };

const errors_table = @import("../generated/errors.zig");

fn catalogued(code: []const u8) bool {
    for (errors_table.errors.@"error") |e| if (std.mem.eql(u8, e.code, code)) return true;
    return false;
}

/// Whether a property's failure is well formed: as an Operation's that
/// declares no codes.
pub fn validPropFailure(code: []const u8, data: ?*const Value) bool {
    if (data) |d| switch (d.data) {
        .nothing => {},
        .map => |pairs| for (0..pairs.len) |map_index| {
            const p = pairs.at(map_index);
            for (reserved) |r| if (std.mem.eql(u8, r, p.key)) return false;
        },
        else => return false,
    };
    return !catalogued(code);
}

/// Whether a `Fail` is well formed for its Operation: a map or Nothing for
/// Data, no reserved key, no catalogue code, and a declared code when the
/// Operation lists its codes.
pub fn validFailure(op: Operation, code: []const u8, data: ?*const Value) bool {
    if (op.failure) |validate| if (!validate(code, data)) return false;
    if (data) |d| switch (d.data) {
        .nothing => {},
        .map => |pairs| for (0..pairs.len) |map_index| {
            const p = pairs.at(map_index);
            for (reserved) |r| if (std.mem.eql(u8, r, p.key)) return false;
        },
        else => return false,
    };
    if (op.errors.len == 0) return !op.closed_errors and !catalogued(code);
    for (op.errors) |e| if (std.mem.eql(u8, e.code, code)) {
        if (e.core) return false;
        // A catalogue code only a Standard Capability may declare, and its
        // fields are the catalogue's.
        const entry = catalogueEntry(code) orelse return true;
        if (!op.catalogue_errors) return false;
        const pairs: model.Map = if (data) |d| (if (d.data == .map) d.data.map else model.Map.empty) else model.Map.empty;
        for (entry.fields) |f| {
            for (0..pairs.len) |map_index| {
                const p = pairs.at(map_index);
                if (std.mem.eql(u8, p.key, f)) break;
            } else return false;
        }
        for (e.fields) |f| {
            const v = for (0..pairs.len) |map_index| {
                const p = pairs.at(map_index);
                if (std.mem.eql(u8, p.key, f.key)) break p.value;
            } else continue;
            if (!kindOf(f.shape, v)) return false;
        }
        if (e.choice) |choice| {
            const v = for (0..pairs.len) |map_index| {
                const p = pairs.at(map_index);
                if (std.mem.eql(u8, p.key, choice.field)) break p.value;
            } else return false;
            if (v.data != .text) return false;
            for (choice.words) |w| {
                if (std.mem.eql(u8, w, v.data.text)) break;
            } else return false;
        }
        for (0..pairs.len) |map_index| {
            const p = pairs.at(map_index);
            const listed = for (entry.fields) |f| {
                if (std.mem.eql(u8, p.key, f)) break true;
            } else if (entry.optional) |opt| for (opt) |f| {
                if (std.mem.eql(u8, p.key, f)) break true;
            } else false else false;
            if (!listed) return false;
        }
        return true;
    };
    return false;
}

/// Whether a value has a kind Shape's kind; any other Shape takes it.
fn kindOf(s: *const Shape, v: *const Value) bool {
    if (s.data != .kind) return true;
    return switch (s.data.kind) {
        .text => v.data == .text,
        .civil_date => v.data == .civil_date,
        .number => v.data == .number,
        else => true,
    };
}

fn catalogueEntry(code: []const u8) ?errors_table.ErrorsTableErrorEntry {
    for (errors_table.errors.@"error") |e| if (std.mem.eql(u8, e.code, code)) return e;
    return null;
}

fn acceptsLiteral(context: *const anyopaque, index: usize, literal: check.Literal) bool {
    const op: *const Operation = @ptrCast(@alignCast(context));
    if (index >= op.args.len) return true;
    return shapeTakes(op.args[index], literal);
}

/// Whether a Shape takes a literal of this kind (chapter 9, Shapes: at load).
fn shapeTakes(s: *const Shape, literal: check.Literal) bool {
    return switch (s.data) {
        .kind => |k| switch (k) {
            .any, .value => true,
            .nothing => literal == .nothing,
            .boolean => literal == .boolean,
            .number => literal == .number,
            .text => literal == .text,
            .quantity => literal == .quantity,
            else => false,
        },
        .quantity_of => |q| literal == .quantity and blk: {
            const u = units.Unit.parse(literal.quantity) catch break :blk false;
            break :blk std.meta.eql(u, q.unit);
        },
        .quantity_kind => |name| literal == .quantity and blk: {
            const u = units.Unit.parse(literal.quantity) catch break :blk false;
            break :blk ofKind(u, name);
        },
        .list => literal == .list,
        .map => |m| literal == .map and blk: {
            if (m.open) break :blk true;
            for (literal.map) |key| if (field(m.fields, key) == null) break :blk false;
            for (m.fields) |f| {
                if (f.optional) continue;
                for (literal.map) |key| {
                    if (std.mem.eql(u8, key, f.key)) break;
                } else break :blk false;
            }
            break :blk true;
        },
        .object => false,
        .one_of => |xs| for (xs) |x| {
            if (shapeTakes(x, literal)) break true;
        } else false,
        .optional => |inner| literal == .nothing or shapeTakes(inner, literal),
    };
}

/// The checker's view of a Grant's Operations.
pub fn checkOperations(a: Allocator, g: *const Grant) ![]check.Operation {
    var out: std.ArrayList(check.Operation) = .empty;
    for (g.capability.operations, g.operations, 0..) |op, kept, i| {
        if (!kept) continue;
        try out.append(a, .{ .name = op.name, .mode = op.mode, .required = op.required(), .total = op.args.len, .accepts = .{ .context = &g.capability.operations[i], .call = acceptsLiteral }, .command = op.command });
    }
    return out.items;
}

/// An Operation's compile-time mode and argument Shapes, which a Library's
/// Capability calls are checked and lowered against.
pub const OperationCheck = struct { name: []const u8, mode: Mode, args: []const *Shape, command: bool = false };
/// A Grant's declarations, by the name the source uses.
pub const GrantDecls = struct { name: []const u8, operations: []const OperationCheck };

/// The declarations as the checker reads them; each borrows its check.
pub fn declaredOperations(a: Allocator, checks: []const OperationCheck) ![]check.Operation {
    const out = try a.alloc(check.Operation, checks.len);
    for (checks, out) |*c, *x| {
        var required = c.args.len;
        while (required > 0 and c.args[required - 1].omittable()) required -= 1;
        x.* = .{ .name = c.name, .mode = c.mode, .required = required, .total = c.args.len, .accepts = .{ .context = c, .call = acceptsDeclared }, .command = c.command };
    }
    return out;
}

fn acceptsDeclared(context: *const anyopaque, index: usize, literal: check.Literal) bool {
    const c: *const OperationCheck = @ptrCast(@alignCast(context));
    if (index >= c.args.len) return true;
    return shapeTakes(c.args[index], literal);
}

const testing = std.testing;

test "Shapes name what they expect and find the first node that breaks them" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const gpa = testing.allocator;
    const text = try Shape.kind(gpa, .text);
    const tags = try Shape.listOf(gpa, text.retain());
    const kg = try Shape.optional(gpa, try Shape.quantityOf(gpa, "kg"));
    const fields = try gpa.alloc(Field, 3);
    fields[0] = .{ .key = try gpa.dupe(u8, "name"), .shape = text };
    fields[1] = .{ .key = try gpa.dupe(u8, "tags"), .shape = tags };
    fields[2] = .{ .key = try gpa.dupe(u8, "weight"), .shape = kg, .optional = true };
    const form = try Shape.map(gpa, fields, false);
    defer form.release();
    try testing.expectEqualStrings("kg or nothing", try kg.expected(a));

    const v = try @import("../display.zig").parse(gpa, "{name: \"a\", tags: [\"x\", 3]}", .{});
    defer v.release();
    const r = try checkValue(a, gpa, form, v);
    defer r.release();
    const bad = r.mismatch.?.wrong_kind;
    try testing.expectEqualStrings("text", bad.expected);
    try testing.expectEqualStrings("number", bad.got);
    try testing.expectEqual(@as(usize, 2), bad.path.len);

    const ok = try @import("../display.zig").parse(gpa, "{name: \"a\", tags: [], weight: 2 kg}", .{});
    defer ok.release();
    const fine = try checkValue(a, gpa, form, ok);
    defer fine.release();
    try testing.expect(fine.mismatch == null);
}

test "Function Values under scalar Shapes are wrong kind" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const gpa = testing.allocator;
    const text = try Shape.kind(gpa, .text);
    defer text.release();
    const captures = try model.list(gpa, &.{});
    defer captures.release();
    const f = try model.function(gpa, "s", "given x: x", 1, captures);
    defer f.release();
    const checked = try checkValue(a, gpa, text, f);
    defer checked.release();
    try testing.expect(checked.mismatch.? == .wrong_kind);
    try testing.expectEqualStrings("function", checked.mismatch.?.wrong_kind.got);
}

test "Quantity diagnostics use the Unit only for Quantity Shapes" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const gpa = testing.allocator;
    const text = try Shape.kind(gpa, .text);
    defer text.release();
    const q = try @import("../display.zig").parse(gpa, "5 m", .{});
    defer q.release();
    const checked = try checkValue(a, gpa, text, q);
    defer checked.release();
    try testing.expectEqualStrings("quantity", checked.mismatch.?.wrong_kind.got);
}

//! Reference-counted, acyclic values with copy-on-write containers. Every
//! node remembers its allocator; constructors retain children and copy bytes.
const std = @import("std");
const unicode = @import("unicode/unicode.zig");
pub const decimal = @import("decimal/decimal.zig");
pub const Decimal = decimal.Decimal;
pub const units = @import("units.zig");
pub const dates = @import("dates.zig");
/// Every refusal a value operation can report.
pub const Error = units.Error || error{ TooDeep, CantCompare, NotEncodable };
/// The deepest nesting a value may have; deeper construction is refused.
pub const max_depth = 128;
/// talk.h's `talk_kind`, in the same order.
pub const Kind = enum(c_int) { nothing, bool, number, quantity, text, bytes, list, map, range, instant, civil_date, pattern, function, object };
/// One map entry. A key is NFC text, unique within its map.
pub const Pair = struct { key: []const u8, value: *Value };
/// A number with a non-empty Unit.
pub const Quantity = struct { number: Decimal, unit: units.Unit };
/// A range between two numbers, or two Quantities of compatible Units.
pub const Range = struct { from: *Value, to: *Value };
/// A Host Object, compared by `identity`, which its Group assigns.
pub const Object = struct { kind: []const u8, id: []const u8, identity: usize };
/// A Function Value: its display source, home Script and captured values.
pub const Function = struct { display: []const u8, home: []const u8, identity: usize, captures: *Value };
/// A value's payload, one variant per Kind. Slices and children are owned.
pub const Data = union(Kind) {
    nothing: void,
    bool: bool,
    number: Decimal,
    quantity: Quantity,
    text: []const u8,
    bytes: []const u8,
    list: []*Value,
    map: []Pair,
    range: Range,
    instant: dates.Instant,
    civil_date: dates.Fields,
    pattern: []const u8,
    function: Function,
    object: Object,
};
/// One reference-counted, immutable node. Release each owned reference once.
pub const Value = struct {
    references: usize = 1,
    allocator: std.mem.Allocator,
    depth: usize = 1,
    data: Data,
    /// The kind of the value's payload.
    pub fn kind(self: *const Value) Kind {
        return std.meta.activeTag(self.data);
    }
    /// Acquires another reference and returns the same value.
    pub fn retain(self: *Value) *Value {
        self.references += 1;
        return self;
    }
    /// Ends one reference, freeing the node and its children with the last.
    pub fn release(self: *Value) void {
        self.references -= 1;
        if (self.references != 0) return;
        const gpa = self.allocator;
        switch (self.data) {
            .text, .bytes, .pattern => |s| gpa.free(s),
            .list => |items| {
                for (items) |v| v.release();
                gpa.free(items);
            },
            .map => |pairs| {
                for (pairs) |p| {
                    gpa.free(p.key);
                    p.value.release();
                }
                gpa.free(pairs);
            },
            .range => |r| {
                r.from.release();
                r.to.release();
            },
            .object => |o| {
                gpa.free(o.kind);
                gpa.free(o.id);
            },
            .function => |f| {
                gpa.free(f.display);
                gpa.free(f.home);
                f.captures.release();
            },
            else => {},
        }
        gpa.destroy(self);
    }
    /// The value a map holds under the NFC `key`, borrowed, or null.
    pub fn get(self: *const Value, key: []const u8) ?*Value {
        if (self.data != .map) return null;
        for (self.data.map) |p| if (std.mem.eql(u8, p.key, key)) return p.value;
        return null;
    }
    /// Script equality: numbers by value, Quantities in Base Units, maps
    /// regardless of order, Objects and Functions by identity.
    pub fn equal(self: *const Value, other: *const Value) Error!bool {
        if (self.kind() != other.kind()) return false;
        return switch (self.data) {
            .nothing => true,
            .bool => |b| b == other.data.bool,
            .number => |n| Decimal.order(n, other.data.number) == .eq,
            .quantity => |q| blk: {
                const r = other.data.quantity;
                if (!q.unit.compatible(r.unit)) break :blk false;
                break :blk Decimal.order(try q.unit.comparisonBase(self.allocator, q.number), try r.unit.comparisonBase(self.allocator, r.number)) == .eq;
            },
            .text, .bytes, .pattern => |s| std.mem.eql(u8, s, switch (other.data) {
                .text, .bytes, .pattern => |v| v,
                else => unreachable,
            }),
            .list => |xs| blk: {
                const ys = other.data.list;
                if (xs.len != ys.len) break :blk false;
                for (xs, ys) |x, y| if (!try x.equal(y)) break :blk false;
                break :blk true;
            },
            .map => |xs| blk: {
                if (xs.len != other.data.map.len) break :blk false;
                for (xs) |x| {
                    const y = other.get(x.key) orelse break :blk false;
                    if (!try x.value.equal(y)) break :blk false;
                }
                break :blk true;
            },
            .range => |r| try r.from.equal(other.data.range.from) and try r.to.equal(other.data.range.to),
            .instant => |t| t.seconds == other.data.instant.seconds and t.nanos == other.data.instant.nanos,
            .civil_date => |f| std.meta.eql(f, other.data.civil_date),
            .object => |o| o.identity == other.data.object.identity,
            .function => |f| f.identity == other.data.function.identity and std.mem.eql(u8, f.home, other.data.function.home) and try f.captures.equal(other.data.function.captures),
        };
    }
    /// Script ordering, refused with CantCompare for unordered kinds or
    /// incompatible Units.
    pub fn order(self: *const Value, other: *const Value) Error!std.math.Order {
        if (self.kind() != other.kind()) return error.CantCompare;
        return switch (self.data) {
            .number => |n| Decimal.order(n, other.data.number),
            .quantity => |q| blk: {
                const r = other.data.quantity;
                if (!q.unit.compatible(r.unit)) return error.CantCompare;
                break :blk Decimal.order(try q.unit.comparisonBase(self.allocator, q.number), try r.unit.comparisonBase(self.allocator, r.number));
            },
            .text => |s| std.mem.order(u8, s, other.data.text), // UTF-8 preserves scalar order.
            .bytes => |s| std.mem.order(u8, s, other.data.bytes),
            .list => |xs| blk: {
                const ys = other.data.list;
                for (xs[0..@min(xs.len, ys.len)], ys[0..@min(xs.len, ys.len)]) |x, y| if (!try x.equal(y)) break :blk try x.order(y);
                break :blk std.math.order(xs.len, ys.len);
            },
            .instant => |t| blk: {
                const r = other.data.instant;
                const o = std.math.order(t.seconds, r.seconds);
                break :blk if (o == .eq) std.math.order(t.nanos, r.nanos) else o;
            },
            .civil_date => |f| blk: {
                const r = other.data.civil_date;
                if (f.has_time != r.has_time) return error.CantCompare;
                const o = std.math.order(dates.seconds(f), dates.seconds(r));
                break :blk if (o == .eq) std.math.order(f.nanosecond, r.nanosecond) else o;
            },
            else => error.CantCompare,
        };
    }
};
/// A value with no children, which takes ownership of `data`'s slices.
pub fn scalar(gpa: std.mem.Allocator, data: Data) !*Value {
    const v = try gpa.create(Value);
    v.* = .{ .allocator = gpa, .data = data };
    return v;
}
/// Text from UTF-8, normalised to NFC. Invalid UTF-8 is refused.
pub fn text(gpa: std.mem.Allocator, s: []const u8) Error!*Value {
    if (!unicode.utf8.validate(s)) return error.InvalidValue;
    const normal = try unicode.nfc(gpa, s);
    errdefer gpa.free(normal);
    return scalar(gpa, .{ .text = normal });
}
/// Bytes, copied from `s`.
pub fn bytes(gpa: std.mem.Allocator, s: []const u8) Error!*Value {
    const copy = try gpa.dupe(u8, s);
    errdefer gpa.free(copy);
    return scalar(gpa, .{ .bytes = copy });
}
/// A list that retains each item.
pub fn list(gpa: std.mem.Allocator, items: []const *Value) Error!*Value {
    var depth: usize = 1;
    for (items) |v| depth = @max(depth, v.depth + 1);
    if (depth > max_depth) return error.TooDeep;
    const copy = try gpa.dupe(*Value, items);
    errdefer gpa.free(copy);
    const v = try scalar(gpa, .{ .list = copy });
    v.depth = depth;
    for (items) |item| _ = item.retain();
    return v;
}
/// A map in insertion order that retains each value and copies each key as
/// NFC. A key duplicated after normalisation is refused.
pub fn map(gpa: std.mem.Allocator, pairs: []const Pair) Error!*Value {
    var depth: usize = 1;
    for (pairs) |p| depth = @max(depth, p.value.depth + 1);
    if (depth > max_depth) return error.TooDeep;
    var out: std.ArrayList(Pair) = .empty;
    errdefer {
        for (out.items) |p| {
            gpa.free(p.key);
            p.value.release();
        }
        out.deinit(gpa);
    }
    for (pairs) |p| {
        if (!unicode.utf8.validate(p.key)) return error.InvalidValue;
        const key = try unicode.nfc(gpa, p.key);
        errdefer gpa.free(key);
        for (out.items) |old| if (std.mem.eql(u8, old.key, key)) return error.InvalidValue;
        try out.append(gpa, .{ .key = key, .value = p.value });
        _ = p.value.retain();
    }
    const v = try gpa.create(Value);
    errdefer gpa.destroy(v);
    v.* = .{ .allocator = gpa, .data = .{ .map = try out.toOwnedSlice(gpa) }, .depth = depth };
    return v;
}
/// A range that retains both ends, which must be numbers or compatible
/// Quantities.
pub fn range(gpa: std.mem.Allocator, from: *Value, to: *Value) Error!*Value {
    if (from.kind() != to.kind() or (from.data != .number and from.data != .quantity)) return error.InvalidValue;
    if (from.data == .quantity and !from.data.quantity.unit.compatible(to.data.quantity.unit)) return error.IncompatibleUnits;
    const v = try scalar(gpa, .{ .range = .{ .from = from, .to = to } });
    v.depth = @max(from.depth, to.depth) + 1;
    _ = from.retain();
    _ = to.retain();
    return v;
}
/// A Quantity from a number and Unit source; an empty Unit gives a number.
pub fn quantity(gpa: std.mem.Allocator, n: Decimal, unit: []const u8) Error!*Value {
    const normalized = try units.Unit.parseQuantity(gpa, n, unit);
    return scalar(gpa, if (normalized.unit.empty()) .{ .number = normalized.number } else .{ .quantity = .{ .number = normalized.number, .unit = normalized.unit } });
}
/// Consumes one reference to the old root only on success. A changed root
/// cannot form a cycle, even when a caller inserts the old root into itself.
pub fn listSet(root: **Value, index: usize, item: *Value) Error!void {
    const old = root.*;
    if (old.data != .list or index >= old.data.list.len) return error.InvalidValue;
    // A unique container can be changed in place unless the new child could
    // contain it. Shared containers copy their spine, retaining every child.
    if (old.references == 1 and !contains(item, old)) {
        if (item.depth + 1 > max_depth) return error.TooDeep;
        _ = item.retain();
        old.data.list[index].release();
        old.data.list[index] = item;
        old.depth = 1;
        for (old.data.list) |v| old.depth = @max(old.depth, v.depth + 1);
    } else {
        const v = try list(old.allocator, old.data.list);
        errdefer v.release();
        if (item.depth + 1 > max_depth) return error.TooDeep;
        _ = item.retain();
        v.data.list[index].release();
        v.data.list[index] = item;
        v.depth = @max(v.depth, item.depth + 1);
        root.* = v;
        old.release();
    }
}
fn contains(v: *Value, target: *Value) bool {
    if (v == target) return true;
    return switch (v.data) {
        .list => |xs| blk: {
            for (xs) |x| if (contains(x, target)) break :blk true;
            break :blk false;
        },
        .map => |xs| blk: {
            for (xs) |x| if (contains(x.value, target)) break :blk true;
            break :blk false;
        },
        .range => |r| contains(r.from, target) or contains(r.to, target),
        .function => |f| contains(f.captures, target),
        else => false,
    };
}
test "copy-on-write never changes an alias and every reference is freed" {
    const gpa = std.testing.allocator;
    const one = try scalar(gpa, .{ .number = try Decimal.parse("1") });
    defer one.release();
    const two = try scalar(gpa, .{ .number = try Decimal.parse("2") });
    defer two.release();
    const original = try list(gpa, &.{one});
    defer original.release();
    var copy = original.retain();
    defer copy.release();
    try listSet(&copy, 0, two);
    try std.testing.expect(try original.data.list[0].equal(one));
    try std.testing.expect(try copy.data.list[0].equal(two));
    try listSet(&copy, 0, copy); // An immutable previous version, never a cycle.
    try std.testing.expect(copy.data.list[0] != copy);
}
test "NFC duplicate keys and map equality independent of order" {
    const gpa = std.testing.allocator;
    const n = try scalar(gpa, .nothing);
    defer n.release();
    try std.testing.expectError(error.InvalidValue, map(gpa, &.{ .{ .key = "é", .value = n }, .{ .key = "e\u{0301}", .value = n } }));
    const x = try map(gpa, &.{ .{ .key = "a", .value = n }, .{ .key = "b", .value = n } });
    defer x.release();
    const y = try map(gpa, &.{ .{ .key = "b", .value = n }, .{ .key = "a", .value = n } });
    defer y.release();
    try std.testing.expect(try x.equal(y));
}

/// A map write keeps an existing key's position and appends a new key last.
/// The prior root stays immutable, including self-insertion.
pub fn mapSet(root: **Value, key: []const u8, item: *Value) Error!void {
    const old = root.*;
    if (old.data != .map) return error.InvalidValue;
    const gpa = old.allocator;
    const normalized = try text(gpa, key);
    defer normalized.release();
    var pairs: std.ArrayList(Pair) = .empty;
    defer pairs.deinit(gpa);
    try pairs.appendSlice(gpa, old.data.map);
    var found = false;
    for (pairs.items) |*p| if (std.mem.eql(u8, p.key, normalized.data.text)) {
        p.value = item;
        found = true;
        break;
    };
    if (!found) try pairs.append(gpa, .{ .key = normalized.data.text, .value = item });
    const next = try map(gpa, pairs.items);
    root.* = next;
    old.release();
}
/// Applies `op` to numbers or Quantities, converting through Base Units.
pub fn arithmetic(gpa: std.mem.Allocator, op: decimal.Operator, x: *Value, y: *Value) Error!*Value {
    if (x.data == .number and y.data == .number) return scalar(gpa, .{ .number = try decimal.calculate(gpa, op, x.data.number, y.data.number) });
    if (op == .div or op == .mod) return error.InvalidValue;
    if (op == .add or op == .subtract) {
        if (x.data != .quantity or y.data != .quantity) return error.InvalidValue;
        const l = x.data.quantity;
        const r = y.data.quantity;
        if (!l.unit.compatible(r.unit)) return error.IncompatibleUnits;
        const rhs = try l.unit.fromBase(gpa, try r.unit.toBase(gpa, r.number));
        return scalar(gpa, .{ .quantity = .{ .number = try decimal.calculate(gpa, op, l.number, rhs), .unit = l.unit } });
    }
    const l: Quantity = switch (x.data) {
        .quantity => |q| q,
        .number => |n| .{ .number = n, .unit = .{} },
        else => return error.InvalidValue,
    };
    const r: Quantity = switch (y.data) {
        .quantity => |q| q,
        .number => |n| .{ .number = n, .unit = .{} },
        else => return error.InvalidValue,
    };
    const u = try units.Unit.combine(l.unit, r.unit, op == .divide);
    const base = try decimal.calculate(gpa, op, try l.unit.toBase(gpa, l.number), try r.unit.toBase(gpa, r.number));
    const n = try u.fromBase(gpa, base);
    return scalar(gpa, if (u.empty()) .{ .number = n } else .{ .quantity = .{ .number = n, .unit = u } });
}

test "quantity arithmetic follows kind-order Base Unit factors" {
    const gpa = std.testing.allocator;
    const examples = .{
        .{ decimal.Operator.add, "5 kg", "250 g", "5.250 kg" },
        .{ decimal.Operator.divide, "4 yd", "2 ft", "6" },
        .{ decimal.Operator.multiply, "2 m", "3 ft", "1.8288 m^2" },
        .{ decimal.Operator.multiply, "100 EUR", "1.1 USD/EUR", "110.0 USD" },
        .{ decimal.Operator.multiply, "60 mi/hr", "2 hr", "120.0 mi" },
    };
    inline for (examples) |example| {
        const display = @import("display.zig");
        const x = try display.parse(gpa, example[1], .{});
        defer x.release();
        const y = try display.parse(gpa, example[2], .{});
        defer y.release();
        const result = try arithmetic(gpa, example[0], x, y);
        defer result.release();
        const s = try display.string(gpa, result);
        defer gpa.free(s);
        try std.testing.expectEqualStrings(example[3], s);
    }
    const x = try quantity(gpa, try Decimal.parse("1000000000000000000000000000000000"), "km");
    defer x.release();
    const y = try quantity(gpa, try Decimal.parse("1000000000000000000000000000000000"), "m");
    defer y.release();
    try std.testing.expectEqual(std.math.Order.gt, try x.order(y));
    try std.testing.expect(!try x.equal(y));
}
test "equality never errors and ordering follows Value Semantics" {
    const gpa = std.testing.allocator;
    const display = @import("display.zig");
    const equal = .{
        .{ "1.0", "1", true },
        .{ "1", "\"1\"", false },
        .{ "5", "5 kg", false },
        .{ "nothing", "\"\"", false },
        .{ "5 kg", "5000 g", true },
        .{ "1 L", "1000 mL", true },
        .{ "5 kg", "5 m", false },
        .{ "1 month", "30 days", false },
        .{ "2026-09-27", "2026-09-27T00:00:00", false },
        .{ "[1, 2]", "[1.00, 2]", true },
        .{ "1..2", "1.0..2", true },
    };
    inline for (equal) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectEqual(example[2], try x.equal(y));
    }
    const less = .{
        .{ "1", "2" },
        .{ "999 g", "1 kg" },
        .{ "\"Zebra\"", "\"apple\"" },
        .{ "\"ab\"", "\"abc\"" },
        .{ "<<0x01, 0xFF>>", "<<0x02>>" },
        .{ "<<0x01>>", "<<0x01, 0x00>>" },
        .{ "1969-12-31T23:59:59.999999999Z", "1970-01-01T00:00:00Z" },
        .{ "2026-09-26", "2026-09-27" },
        .{ "2026-09-27T14:30:00", "2026-09-27T14:30:00.5" },
        .{ "[1, \"b\"]", "[2, \"a\"]" },
        .{ "[1, 2]", "[1, 2, 0]" },
    };
    inline for (less) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectEqual(std.math.Order.lt, try x.order(y));
        try std.testing.expectEqual(std.math.Order.gt, try y.order(x));
    }
    const unordered = .{
        .{ "1", "\"1\"" },
        .{ "5 kg", "5 m" },
        .{ "2026-09-27", "2026-09-27T00:00:00" },
        .{ "true", "false" },
        .{ "nothing", "nothing" },
        .{ "{a: 1}", "{a: 2}" },
        .{ "1..2", "1..3" },
        .{ "[1, \"a\"]", "[1, 2]" },
    };
    inline for (unordered) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectError(error.CantCompare, x.order(y));
    }
}
test "map copy-on-write and preserved insertion order" {
    const gpa = std.testing.allocator;
    const n = try scalar(gpa, .nothing);
    defer n.release();
    const original = try map(gpa, &.{.{ .key = "a", .value = n }});
    defer original.release();
    var copy = original.retain();
    defer copy.release();
    try mapSet(&copy, "b", n);
    try mapSet(&copy, "a", copy);
    try std.testing.expect(original.get("b") == null);
    try std.testing.expectEqualStrings("a", copy.data.map[0].key);
    try std.testing.expectEqualStrings("b", copy.data.map[1].key);
    try std.testing.expect(copy.get("a").? != copy);
}

/// Objects are made by a Group, not a Host value constructor. These identity
/// fields are the seam for step 1.4's handles and the encoding resolver.
pub fn object(gpa: std.mem.Allocator, kind: []const u8, id: []const u8, identity: usize) Error!*Value {
    if (!unicode.utf8.validate(kind) or !unicode.utf8.validate(id)) return error.InvalidValue;
    const k = try gpa.dupe(u8, kind);
    errdefer gpa.free(k);
    const s = try unicode.nfc(gpa, id);
    errdefer gpa.free(s);
    return scalar(gpa, .{ .object = .{ .kind = k, .id = s, .identity = identity } });
}
/// A Function Value that retains its captures.
pub fn function(gpa: std.mem.Allocator, home: []const u8, source: []const u8, identity: usize, captures: *Value) Error!*Value {
    if (captures.depth + 1 > max_depth) return error.TooDeep;
    const h = try gpa.dupe(u8, home);
    errdefer gpa.free(h);
    const s = try gpa.dupe(u8, source);
    errdefer gpa.free(s);
    const v = try scalar(gpa, .{ .function = .{ .home = h, .display = s, .identity = identity, .captures = captures } });
    _ = captures.retain();
    v.depth = captures.depth + 1;
    return v;
}

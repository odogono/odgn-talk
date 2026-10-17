//! Host Objects (spec chapter 9, Host Objects; ADRs 0012 and 0016): Object
//! Kinds and their properties, and the Group's handles, with the parents
//! the Core holds and each object's Owning Script.
const std = @import("std");
const model = @import("../value.zig");
const capabilities = @import("capabilities.zig");

const Allocator = std.mem.Allocator;
const Value = model.Value;

/// What a property's Get or Set gave.
pub const Result = union(enum) {
    /// A Get's value, owned by the caller.
    value: *Value,
    /// A Set that took its value.
    done,
    /// A Script error: its code, message and Data, which it owns.
    failed: @FieldType(capabilities.Outcome, "failed"),
    /// Any other failure, which the Script sees as `host error`.
    broken,
    /// The Host cannot answer inside this call (the Message Layer): the
    /// Pump pauses at the crossing.
    deferred,
};

pub const Get = struct {
    /// `gpa` owns a failure's code and message.
    call: *const fn (context: ?*anyopaque, gpa: Allocator, o: *Object) Result,
    context: ?*anyopaque = null,
};

pub const Set = struct {
    call: *const fn (context: ?*anyopaque, gpa: Allocator, o: *Object, v: *const Value) Result,
    context: ?*anyopaque = null,
};

/// A property: its Shape, its Get, and its Set, or none when it is
/// read-only, each with a cost.
pub const Prop = struct {
    name: []const u8,
    shape: *capabilities.Shape,
    get: Get,
    set: ?Set = null,
    get_cost: capabilities.Cost = .{},
    set_cost: capabilities.Cost = .{},
};

/// An Object Kind's ordered, named collection of Host Objects (#1143),
/// read by `element s of o` and `the number of elements of o`. Its
/// callbacks are synchronous and read-only, like a property's Get: `at`
/// gets a nonzero index, negative from the end, and `find` a borrowed name.
pub const Elements = struct {
    /// An Object Shape, or a choice of Object Shapes of distinct kinds.
    shape: *capabilities.Shape,
    count: *const fn (context: ?*anyopaque, gpa: Allocator, o: *Object) Result,
    at: *const fn (context: ?*anyopaque, gpa: Allocator, o: *Object, index: i64) Result,
    find: *const fn (context: ?*anyopaque, gpa: Allocator, o: *Object, name: []const u8) Result,
    context: ?*anyopaque = null,
    count_cost: capabilities.Cost = .{},
    at_cost: capabilities.Cost = .{},
    find_cost: capabilities.Cost = .{},
};

/// The three collection calls, each recorded as a `prop` with this `op`.
pub const ElementOp = enum {
    count,
    at,
    find,

    /// Its `operation` in a failure: `elements.count` and so on.
    pub fn operation(op: ElementOp) []const u8 {
        return switch (op) {
            .count => "elements.count",
            .at => "elements.at",
            .find => "elements.find",
        };
    }
};

/// Whether a collection's Shape is an Object Shape, or a nonempty choice
/// of Object Shapes with distinct Object Kind names.
pub fn validElementShape(shape: *const capabilities.Shape) bool {
    switch (shape.data) {
        .object => return true,
        .one_of => |xs| {
            if (xs.len == 0) return false;
            for (xs, 0..) |x, i| {
                if (x.data != .object) return false;
                for (xs[0..i]) |y| if (std.mem.eql(u8, x.data.object, y.data.object)) return false;
            }
            return true;
        },
        else => return false,
    }
}

/// The largest collection count and position, 2^53 - 1.
pub const max_elements: u64 = 9_007_199_254_740_991;

/// A Decimal's whole value, saturated past `max_elements`, or null when it
/// is fractional.
pub fn wholeMagnitude(d: model.Decimal) ?u64 {
    var n = d.coefficient;
    var exp = d.exponent;
    while (exp < 0) : (exp += 1) {
        if (n % 10 != 0) return null;
        n /= 10;
    }
    while (exp > 0 and n <= max_elements) : (exp -= 1) n *= 10;
    return if (n > max_elements) max_elements + 1 else @intCast(n);
}

/// An Object Kind, defined once per process.
pub const Kind = struct {
    name: []const u8,
    props: []Prop,
    /// For the Host Manifest only; `SetParent` doesn't check it.
    parent_kinds: []const []const u8 = &.{},
    /// Its Object Collection, if it has one (#1143).
    elements: ?Elements = null,

    pub fn prop(k: *const Kind, name: []const u8) ?*const Prop {
        for (k.props) |*p| if (std.mem.eql(u8, p.name, name)) return p;
        return null;
    }

    /// Whether a property can be set: null when the kind has no such
    /// property, which the checker treats as read-only too.
    pub fn writable(k: *const Kind, name: []const u8) bool {
        const p = k.prop(name) orelse return false;
        return p.set != null;
    }
};

/// A Group's handle for a Host-owned thing.
pub const Object = struct {
    kind: *const Kind,
    id: []const u8,
    native: ?*anyopaque,
    /// The object as a Script value, whose identity is this handle.
    value: *Value,
    parent: ?*Object = null,
    disposed: bool = false,
    /// The Script it is the owner of, by name, set when that Script loads.
    owner_of: ?[]const u8 = null,

    pub fn make(gpa: Allocator, kind: *const Kind, id: []const u8, native: ?*anyopaque) !*Object {
        const o = try gpa.create(Object);
        errdefer gpa.destroy(o);
        const own = try gpa.dupe(u8, id);
        errdefer gpa.free(own);
        o.* = .{ .kind = kind, .id = own, .native = native, .value = undefined };
        o.value = try model.object(gpa, kind.name, id, @intFromPtr(o));
        return o;
    }

    pub fn destroy(o: *Object, gpa: Allocator) void {
        o.value.release();
        gpa.free(o.id);
        if (o.owner_of) |s| gpa.free(s);
        gpa.destroy(o);
    }

    /// Whether making `parent` its parent would close a cycle.
    pub fn wouldCycle(o: *const Object, parent: ?*const Object) bool {
        var p = parent;
        while (p) |x| : (p = x.parent) if (x == o) return true;
        return false;
    }

    /// The nearest object on its path, itself included, that has an Owning
    /// Script, skipping disposed objects.
    pub fn owned(o: *Object) ?*Object {
        var p: ?*Object = o;
        while (p) |x| : (p = x.parent) if (!x.disposed and x.owner_of != null) return x;
        return null;
    }
};

test "a collection Shape is objects of distinct kinds" {
    const gpa = std.testing.allocator;
    const page = try gpa.create(capabilities.Shape);
    page.* = .{ .allocator = gpa, .data = .{ .object = try gpa.dupe(u8, "page") } };
    defer page.release();
    try std.testing.expect(validElementShape(page));
    const number = try gpa.create(capabilities.Shape);
    number.* = .{ .allocator = gpa, .data = .{ .kind = .number } };
    defer number.release();
    try std.testing.expect(!validElementShape(number));
    var twice = [_]*capabilities.Shape{ page, page };
    const choice: capabilities.Shape = .{ .allocator = gpa, .data = .{ .one_of = &twice } };
    try std.testing.expect(!validElementShape(&choice));
    var empty = [_]*capabilities.Shape{};
    const none: capabilities.Shape = .{ .allocator = gpa, .data = .{ .one_of = &empty } };
    try std.testing.expect(!validElementShape(&none));
}

test "a whole magnitude saturates and refuses fractions" {
    try std.testing.expectEqual(@as(?u64, 3), wholeMagnitude(try model.Decimal.parse("3.0")));
    try std.testing.expectEqual(@as(?u64, null), wholeMagnitude(try model.Decimal.parse("2.5")));
    try std.testing.expectEqual(@as(?u64, max_elements), wholeMagnitude(try model.Decimal.parse("9007199254740991")));
    try std.testing.expectEqual(@as(?u64, max_elements + 1), wholeMagnitude(try model.Decimal.parse("9007199254740992")));
}

test "a path skips disposed objects and stops at the first owner" {
    const gpa = std.testing.allocator;
    var kind: Kind = .{ .name = "room", .props = &.{} };
    const top = try Object.make(gpa, &kind, "top", null);
    defer top.destroy(gpa);
    const mid = try Object.make(gpa, &kind, "mid", null);
    defer mid.destroy(gpa);
    const leaf = try Object.make(gpa, &kind, "leaf", null);
    defer leaf.destroy(gpa);
    leaf.parent = mid;
    mid.parent = top;
    try std.testing.expect(leaf.owned() == null);
    top.owner_of = try gpa.dupe(u8, "t");
    mid.owner_of = try gpa.dupe(u8, "m");
    try std.testing.expect(leaf.owned().? == mid);
    mid.disposed = true;
    try std.testing.expect(leaf.owned().? == top);
    try std.testing.expect(top.wouldCycle(leaf));
    try std.testing.expect(!leaf.wouldCycle(top));
}

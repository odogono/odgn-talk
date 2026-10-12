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
};

pub const Get = struct {
    call: *const fn (context: ?*anyopaque, o: *Object) Result,
    context: ?*anyopaque = null,
};

pub const Set = struct {
    call: *const fn (context: ?*anyopaque, o: *Object, v: *const Value) Result,
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

/// An Object Kind, defined once per process.
pub const Kind = struct {
    name: []const u8,
    props: []Prop,
    /// For the Host Manifest only; `SetParent` doesn't check it.
    parent_kinds: []const []const u8 = &.{},

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

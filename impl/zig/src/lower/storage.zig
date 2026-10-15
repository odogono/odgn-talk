//! Copy executable code and its metadata out of compiler working storage.
//! These are trees of slices and plain records; only constant-pool Values
//! are separately owned. Their references are transferred, never retained
//! by this copy, and the caller releases them if copying fails.
const std = @import("std");
const Value = @import("../value.zig").Value;

pub fn copy(a: std.mem.Allocator, value: anytype) std.mem.Allocator.Error!@TypeOf(value) {
    const T = @TypeOf(value);
    if (T == *Value) return value;
    switch (@typeInfo(T)) {
        .pointer => |p| {
            if (p.size == .one) {
                const out = try a.create(p.child);
                out.* = try copy(a, value.*);
                return out;
            }
            if (p.size != .slice) @compileError("unsupported code storage pointer");
            const out = try a.alloc(p.child, value.len);
            for (value, out) |x, *y| y.* = try copy(a, x);
            return out;
        },
        .@"struct" => |s| {
            var out: T = undefined;
            inline for (s.field_names) |name| @field(out, name) = try copy(a, @field(value, name));
            return out;
        },
        .@"union" => {
            return switch (value) {
                inline else => |x, tag| @unionInit(T, @tagName(tag), try copy(a, x)),
            };
        },
        .optional => return if (value) |x| try copy(a, x) else null,
        .array => {
            var out: T = undefined;
            for (value, &out) |x, *y| y.* = try copy(a, x);
            return out;
        },
        .int, .bool, .@"enum", .void => return value,
        else => @compileError("unsupported code storage: " ++ @typeName(T)),
    }
}

fn descriptorCopyAllocationTest(a: std.mem.Allocator) !void {
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const units = @import("../units.zig");
    const descriptor = units.Descriptor.init(try units.Unit.parse("mL/ft^3"));
    const held = try copy(arena.allocator(), @as([]const units.Descriptor, &.{descriptor}));
    const number = try @import("../decimal/decimal.zig").Decimal.parse("2.50");
    try std.testing.expectEqual(try descriptor.unit.toBase(a, number), try held[0].plan.execute(a, number, false, false));
}

test "code-owned Unit descriptors are counted and every copy refusal frees working storage" {
    const units = @import("../units.zig");
    const counted = @import("../machine/group_allocator.zig");
    const descriptor = units.Descriptor.init(try units.Unit.parse("mL/ft^3"));
    var cap = counted.GroupAllocator.init(std.testing.allocator, @sizeOf(units.Descriptor) - 1);
    defer cap.deinit();
    try std.testing.expectError(error.OutOfMemory, copy(cap.allocator(), @as([]const units.Descriptor, &.{descriptor})));
    try std.testing.expectEqual(@as(usize, 0), cap.used);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, descriptorCopyAllocationTest, .{});
}

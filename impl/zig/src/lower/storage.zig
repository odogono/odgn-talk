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
            if (p.size != .slice) @compileError("code storage may only borrow Value pointers");
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
        .int, .bool, .@"enum", .void => return value,
        else => @compileError("unsupported code storage: " ++ @typeName(T)),
    }
}

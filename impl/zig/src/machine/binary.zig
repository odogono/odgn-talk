//! Binary Patterns and Bytes builds (chapter 4): fields written into Bytes,
//! and a reader that takes fields off Bytes, left to right, without
//! searching or backtracking.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const Value = model.Value;

/// What a build field raises.
pub const Raise = union(enum) {
    wrong_kind: struct { expected: []const u8, got: *const Value },
    out_of_range: struct { field: []const u8, value: *const Value },
};

pub const Error = error{ OutOfMemory, Raised };

/// An integer field type: `uint16`, `int32 little` and so on.
pub const IntType = struct { bits: u16, signed: bool, little: bool, name: []const u8 };

pub fn intType(type_name: []const u8) IntType {
    var it = std.mem.splitScalar(u8, type_name, ' ');
    const name = it.next().?;
    const order = it.next();
    const signed = name[0] == 'i';
    const width = std.fmt.parseInt(u16, name[if (signed) 3 else 4..], 10) catch 8;
    return .{ .bits = width, .signed = signed, .little = order != null and std.mem.eql(u8, order.?, "little"), .name = name };
}

/// A number that is an integer, as i128, or what to raise.
fn integer(v: *const Value, raise: *?Raise) ?i128 {
    if (v.data != .number) {
        raise.* = .{ .wrong_kind = .{ .expected = "number", .got = v } };
        return null;
    }
    const n = v.data.number.integer(i128) catch {
        raise.* = .{ .wrong_kind = .{ .expected = "integer", .got = v } };
        return null;
    };
    return n;
}

fn appendInt(a: Allocator, out: *std.ArrayList(u8), n: u128, bytes: usize, little: bool) !void {
    var i: usize = 0;
    while (i < bytes) : (i += 1) {
        const shift: u7 = @intCast(8 * (if (little) i else bytes - 1 - i));
        try out.append(a, @truncate(n >> shift));
    }
}

/// `bytes-field`: one field of a build, appended to `so_far`.
pub fn field(a: Allocator, gpa: Allocator, so_far: []const u8, type_name: []const u8, v: *const Value, raise: *?Raise) Error!*Value {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, so_far);
    if (std.mem.eql(u8, type_name, "value")) {
        switch (v.data) {
            .number => {
                const n = integer(v, raise) orelse return error.Raised;
                if (n < 0 or n > 255) {
                    raise.* = .{ .out_of_range = .{ .field = "byte", .value = v } };
                    return error.Raised;
                }
                try out.append(a, @intCast(n));
            },
            .text => |t| try out.appendSlice(a, t),
            .bytes => |b| try out.appendSlice(a, b),
            else => {
                raise.* = .{ .wrong_kind = .{ .expected = "bytes", .got = v } };
                return error.Raised;
            },
        }
    } else {
        const t = intType(type_name);
        const n = integer(v, raise) orelse return error.Raised;
        const min: i128 = if (t.signed) -(@as(i128, 1) << @intCast(t.bits - 1)) else 0;
        const max: i128 = if (t.signed) (@as(i128, 1) << @intCast(t.bits - 1)) - 1 else (@as(i128, 1) << @intCast(t.bits)) - 1;
        if (n < min or n > max) {
            raise.* = .{ .out_of_range = .{ .field = t.name, .value = v } };
            return error.Raised;
        }
        const u: u128 = @bitCast(n);
        try appendInt(a, &out, u, t.bits / 8, t.little);
    }
    return model.bytes(gpa, out.items) catch error.OutOfMemory;
}

/// `bytes-sized`: `v as n bytes`, or `as n bytes as text`.
pub fn sized(a: Allocator, gpa: Allocator, so_far: []const u8, unit: []const u8, v: *const Value, size: *const Value, raise: *?Raise) Error!*Value {
    const as_text = std.mem.eql(u8, unit, "bytes as text");
    const n = integer(size, raise) orelse return error.Raised;
    const content: []const u8 = if (as_text) switch (v.data) {
        .text => |t| t,
        else => {
            raise.* = .{ .wrong_kind = .{ .expected = "text", .got = v } };
            return error.Raised;
        },
    } else switch (v.data) {
        .bytes => |b| b,
        else => {
            raise.* = .{ .wrong_kind = .{ .expected = "bytes", .got = v } };
            return error.Raised;
        },
    };
    if (n < 0 or content.len != n) {
        raise.* = .{ .out_of_range = .{ .field = unit, .value = v } };
        return error.Raised;
    }
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, so_far);
    try out.appendSlice(a, content);
    return model.bytes(gpa, out.items) catch error.OutOfMemory;
}

/// `bytes-bits`: a run of bit fields, most significant bit first.
pub fn bits(a: Allocator, gpa: Allocator, so_far: []const u8, widths: []const u32, values: []const *Value, raise: *?Raise) Error!*Value {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, so_far);
    var acc: u128 = 0;
    var filled: u32 = 0;
    for (values, widths) |v, w| {
        const n = integer(v, raise) orelse return error.Raised;
        if (n < 0 or n >= (@as(i128, 1) << @intCast(w))) {
            const name = try std.fmt.allocPrint(a, "{d} bits", .{w});
            raise.* = .{ .out_of_range = .{ .field = name, .value = v } };
            return error.Raised;
        }
        acc = (acc << @intCast(w)) | @as(u128, @intCast(n));
        filled += w;
        while (filled >= 8) {
            filled -= 8;
            try out.append(a, @truncate(acc >> @intCast(filled)));
        }
    }
    return model.bytes(gpa, out.items) catch error.OutOfMemory;
}

/// A reader over Bytes: its position, in bytes, and the bits of the current
/// byte a bit field run has used.
pub const Reader = struct {
    references: usize = 1,
    subject: *Value,
    position: usize = 0,

    pub fn rest(r: *const Reader) []const u8 {
        return r.subject.data.bytes[r.position..];
    }
};

/// Reads an integer field, or null when the bytes run out.
pub fn readInt(r: *Reader, type_name: []const u8) ?i128 {
    const t = intType(type_name);
    const n = t.bits / 8;
    const rest = r.rest();
    if (rest.len < n) return null;
    var u: u128 = 0;
    for (0..n) |i| {
        const b: u128 = rest[if (t.little) n - 1 - i else i];
        u = (u << 8) | b;
    }
    r.position += n;
    if (t.signed and t.bits < 128 and (u >> @intCast(t.bits - 1)) & 1 == 1) {
        return @as(i128, @intCast(u)) - (@as(i128, 1) << @intCast(t.bits));
    }
    return @intCast(u);
}

/// Reads a run of bit fields, or null when the bytes run out.
pub fn readBits(a: Allocator, r: *Reader, widths: []const u32) !?[]u128 {
    var total: u32 = 0;
    for (widths) |w| total += w;
    const n = total / 8;
    const rest = r.rest();
    if (rest.len < n) return null;
    var acc: u128 = 0;
    for (rest[0..n]) |b| acc = (acc << 8) | b;
    const out = try a.alloc(u128, widths.len);
    var left = total;
    for (widths, out) |w, *o| {
        left -= w;
        o.* = (acc >> @intCast(left)) & ((@as(u128, 1) << @intCast(w)) - 1);
    }
    r.position += n;
    return out;
}

/// Whether text is strict UTF-8, for `as text`.
pub fn validText(b: []const u8) bool {
    return unicode.utf8.validate(b);
}

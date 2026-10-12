//! Conversions (chapter 3): `as` and `can be`. A conversion that doesn't
//! apply gives null, which `as` raises as `can't convert`.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const chunks = @import("chunks.zig");
const Value = model.Value;
const Decimal = model.Decimal;

/// Converts `v` to the kind or Unit `target`, as written after `as`.
pub fn convert(a: Allocator, gpa: Allocator, v: *Value, target: []const u8) !?*Value {
    if (std.mem.eql(u8, target, "text")) return switch (v.data) {
        .bytes => |b| if (unicode.utf8.validate(b)) try model.text(gpa, b) else null,
        else => try model.text(gpa, try chunks.textForm(a, v)),
    };
    if (std.mem.eql(u8, target, "number")) return switch (v.data) {
        .number => v.retain(),
        .text => |t| blk: {
            const n = Decimal.parse(t) catch break :blk null;
            break :blk try model.scalar(gpa, .{ .number = n });
        },
        else => null,
    };
    if (std.mem.eql(u8, target, "bytes")) return switch (v.data) {
        .bytes => v.retain(),
        .text => |t| try model.bytes(gpa, t),
        else => null,
    };
    if (std.mem.eql(u8, target, "civil date")) return switch (v.data) {
        .civil_date => v.retain(),
        .text => |t| blk: {
            const f = model.dates.parseCivil(std.mem.trim(u8, t, " \t\r\n")) catch break :blk null;
            break :blk try model.scalar(gpa, .{ .civil_date = f });
        },
        else => null,
    };
    if (std.mem.eql(u8, target, "instant")) return switch (v.data) {
        .instant => v.retain(),
        .text => |t| blk: {
            const i = model.dates.parseInstant(std.mem.trim(u8, t, " \t\r\n")) catch break :blk null;
            break :blk try model.scalar(gpa, .{ .instant = i });
        },
        else => null,
    };
    // A Unit.
    const unit = model.units.Unit.parse(target) catch return null;
    const source: struct { number: Decimal, unit: ?model.units.Unit } = switch (v.data) {
        .number => |n| .{ .number = n, .unit = null },
        .quantity => |q| .{ .number = q.number, .unit = q.unit },
        .text => |t| blk: {
            const s = std.mem.trim(u8, t, " \t\r\n");
            var end: usize = 0;
            while (end < s.len and (std.ascii.isDigit(s[end]) or s[end] == '.' or s[end] == '-')) end += 1;
            const n = Decimal.parse(s[0..end]) catch return null;
            const rest = std.mem.trim(u8, s[end..], " ");
            if (rest.len == 0) break :blk .{ .number = n, .unit = null };
            const q = model.units.Unit.parseQuantity(a, n, rest) catch return null;
            break :blk .{ .number = q.number, .unit = q.unit };
        },
        else => return null,
    };
    const n = if (source.unit) |from| blk: {
        if (!from.compatible(unit)) return null;
        break :blk unit.fromBase(a, from.toBase(a, source.number) catch return null) catch return null;
    } else source.number;
    return try model.scalar(gpa, .{ .quantity = .{ .number = n, .unit = unit } });
}

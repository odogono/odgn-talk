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
    return prepared(a, gpa, v, target, null);
}

/// Uses code-owned metadata when Load verified a static Unit target.
pub fn prepared(a: Allocator, gpa: Allocator, v: *Value, target: []const u8, descriptor: ?*const model.units.Descriptor) !?*Value {
    if (descriptor) |d| if (v.data == .number or v.data == .quantity) {
        const q = numericUnit(a, v, d) orelse return null;
        return try model.scalar(gpa, .{ .quantity = q });
    };
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
    var parsed_unit: model.units.Unit = undefined;
    const unit: *const model.units.Unit = if (descriptor) |d| &d.unit else blk: {
        parsed_unit = model.units.Unit.parse(target) catch return null;
        break :blk &parsed_unit;
    };
    var text_unit: model.units.Unit = undefined;
    const source: struct { number: Decimal, unit: ?*const model.units.Unit } = switch (v.data) {
        .number => |n| .{ .number = n, .unit = null },
        .quantity => |*q| .{ .number = q.number, .unit = &q.unit },
        .text => |t| blk: {
            const s = std.mem.trim(u8, t, " \t\r\n");
            var end: usize = 0;
            while (end < s.len and (std.ascii.isDigit(s[end]) or s[end] == '.' or s[end] == '-')) end += 1;
            const n = Decimal.parse(s[0..end]) catch return null;
            const rest = std.mem.trim(u8, s[end..], " ");
            if (rest.len == 0) break :blk .{ .number = n, .unit = null };
            const q = model.units.Unit.parseQuantity(a, n, rest) catch return null;
            text_unit = q.unit;
            break :blk .{ .number = q.number, .unit = &text_unit };
        },
        else => return null,
    };
    const n = if (source.unit) |from| blk: {
        if (descriptor) |d| {
            if (!std.mem.eql(i64, &from.dimensions(), &d.dimensions)) return null;
            break :blk d.plan.execute(a, from.toBase(a, source.number) catch return null, true, false) catch return null;
        }
        if (!from.compatible(unit)) return null;
        break :blk unit.fromBase(a, from.toBase(a, source.number) catch return null) catch return null;
    } else source.number;
    return try model.scalar(gpa, .{ .quantity = .{ .number = n, .unit = unit.* } });
}

/// A verified Unit target applied to a Number or Quantity, before allocating
/// its result node. Preserve the source-to-Base and Base-to-target steps.
pub fn numericUnit(a: Allocator, v: *const Value, descriptor: *const model.units.Descriptor) ?model.Quantity {
    const n = switch (v.data) {
        .number => |n| n,
        .quantity => |*q| blk: {
            if (!std.mem.eql(i64, &q.unit.dimensions(), &descriptor.dimensions)) return null;
            const base = q.unit.toBase(a, q.number) catch return null;
            break :blk descriptor.plan.execute(a, base, true, false) catch return null;
        },
        else => return null,
    };
    return .{ .number = n, .unit = descriptor.unit };
}

test "numeric Unit results agree with dynamic conversion including zero rounding and refusal" {
    const a = std.testing.allocator;
    for ([_]Decimal{
        .{ .exponent = -3 },
        try Decimal.parse("-2.50"),
        try Decimal.parse("9999999999999999999999999999999999"),
        .{ .coefficient = 3, .exponent = -6176 },
    }) |n| {
        for ([_][]const u8{ "", "mm", "degF", "mL" }) |source| {
            const v = if (source.len == 0) try model.scalar(a, .{ .number = n }) else try model.quantity(a, n, source);
            defer v.release();
            for ([_][]const u8{ "m", "mm", "degC", "L", "m^2", "month" }) |target| {
                const descriptor = model.units.Descriptor.init(try model.units.Unit.parse(target));
                const expected = try convert(a, a, v, target);
                defer if (expected) |value| value.release();
                const result = numericUnit(a, v, &descriptor);
                try std.testing.expectEqual(expected != null, result != null);
                if (expected) |value| try std.testing.expectEqual(value.data.quantity, result.?);
            }
        }
    }
}

test "prepared targets preserve conversion outcomes for numbers Quantities and text" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "2.50", "-3 degF", "0 mL", "1 m*cm", "not a quantity" }) |text| {
        const v = try model.text(a, text);
        defer v.release();
        for ([_][]const u8{ "mm", "degC", "L", "m^2", "month" }) |target| {
            const descriptor = model.units.Descriptor.init(try model.units.Unit.parse(target));
            const original = try convert(a, a, v, target);
            defer if (original) |value| value.release();
            const planned = try prepared(a, a, v, target, &descriptor);
            defer if (planned) |value| value.release();
            try std.testing.expectEqual(original != null, planned != null);
            if (original) |value| {
                try std.testing.expectEqual(value.data.quantity.number, planned.?.data.quantity.number);
                try std.testing.expectEqual(value.data.quantity.unit, planned.?.data.quantity.unit);
            }
        }
    }
    const number = try model.scalar(a, .{ .number = try Decimal.parse("2.50") });
    defer number.release();
    try std.testing.expectEqual(@as(?*Value, null), try prepared(a, a, number, "m*cm", null));
    const quantity = try model.quantity(a, try Decimal.parse("2.50"), "degF");
    defer quantity.release();
    const descriptor = model.units.Descriptor.init(try model.units.Unit.parse("degC"));
    const original = (try convert(a, a, quantity, "degC")).?;
    defer original.release();
    const planned = (try prepared(a, a, quantity, "degC", &descriptor)).?;
    defer planned.release();
    try std.testing.expectEqual(original.data.quantity.number, planned.data.quantity.number);
}

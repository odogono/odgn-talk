//! Unit slots and factors come only from units.toml's generated catalogue.
const std = @import("std");
pub const table = @import("generated/units.zig").units;
const dec = @import("decimal/decimal.zig");
const Decimal = dec.Decimal;
/// Every refusal a Unit operation can report.
pub const Error = dec.Error || error{IncompatibleUnits};
/// One Unit Kind's factor: the catalogue Unit spelt in it and its power.
pub const Slot = struct { unit: usize = 0, exponent: i32 = 0 };
// Derive immutable numeric factors from the generated catalogue at compile
// time. Keep the two ratio factors and every Kind factor as separate steps.
const unit_factors = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.unit.len]Decimal = undefined;
    for (table.unit, 0..) |u, i| result[i] = Decimal.parse(u.factor orelse "1") catch unreachable;
    break :blk result;
};
const kind_factors = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.kind.len]?Decimal = undefined;
    for (table.kind, 0..) |k, i| result[i] = if (k.factor) |f| Decimal.parse(f) catch unreachable else null;
    break :blk result;
};
const ratio_numerator = Decimal.fromInt(@as(u8, 5));
const ratio_denominator = Decimal.fromInt(@as(u8, 9));
/// Each Unit Kind's base dimension, as the slot of the Kind whose dimension it
/// is and a power, read from the catalogue's `dimension` (volume's
/// "length^3" counts three times in length's slot). Calendar duration has no
/// dimension and counts in its own slot.
const kind_dimensions = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.kind.len]struct { slot: usize, power: i64 } = undefined;
    for (table.kind, 0..) |k, i| {
        const dimension = k.dimension orelse {
            result[i] = .{ .slot = i, .power = 1 };
            continue;
        };
        const caret = std.mem.indexOfScalar(u8, dimension, '^');
        const name = dimension[0 .. caret orelse dimension.len];
        const power = if (caret) |c| std.fmt.parseInt(i64, dimension[c + 1 ..], 10) catch unreachable else 1;
        const slot = for (table.kind, 0..) |base, j| {
            if (base.dimension != null and std.mem.eql(u8, base.dimension.?, name)) break j;
        } else unreachable;
        result[i] = .{ .slot = slot, .power = power };
    }
    break :blk result;
};
/// A Unit in normal form: one slot per Unit Kind, in the catalogue's Kind
/// order, with a zero exponent where the Kind is absent.
pub const Unit = struct {
    slots: [table.kind.len]Slot = @splat(.{}),
    /// Whether no Kind is present, as for a plain number.
    pub fn empty(self: Unit) bool {
        for (self.slots) |s| if (s.exponent != 0) return false;
        return true;
    }
    /// Refuses a calendar Unit raised to a power or in a Compound Unit.
    pub fn validate(self: Unit) Error!void {
        var calendar = false;
        var count: usize = 0;
        for (self.slots, table.kind) |s, k| if (s.exponent != 0) {
            count += 1;
            if (k.calendar orelse false) {
                if (s.exponent != 1) return error.IncompatibleUnits;
                calendar = true;
            }
        };
        if (calendar and count != 1) return error.IncompatibleUnits;
    }
    /// Reads canonical Unit text, refusing a slot spelt two ways.
    pub fn parse(input: []const u8) Error!Unit {
        var result: Unit = .{};
        var pos: usize = 0;
        var denominator = false;
        if (std.mem.startsWith(u8, input, "1/")) {
            pos = 2;
            denominator = true;
        }
        if (input.len == 0 or pos == input.len) return error.InvalidValue;
        while (pos < input.len) {
            const start = pos;
            while (pos < input.len and std.ascii.isAlphabetic(input[pos])) : (pos += 1) {}
            if (pos == start) return error.InvalidValue;
            const name = input[start..pos];
            var found: ?usize = null;
            for (table.unit, 0..) |u, i| if (std.mem.eql(u8, name, u.name) or (u.plural != null and std.mem.eql(u8, name, u.plural.?))) {
                found = i;
                break;
            };
            const i = found orelse return error.InvalidValue;
            var exponent: i32 = 1;
            if (pos < input.len and input[pos] == '^') {
                pos += 1;
                const begin = pos;
                while (pos < input.len and std.ascii.isDigit(input[pos])) : (pos += 1) {}
                exponent = std.fmt.parseInt(i32, input[begin..pos], 10) catch return error.InvalidValue;
                if (exponent <= 0) return error.InvalidValue;
            }
            if (denominator) exponent = -exponent;
            const kind = kindIndex(i);
            const s = &result.slots[kind];
            // Mixed spellings in one slot require a numeric conversion.
            // parseQuantity handles them before canonicalizing.
            if (s.exponent != 0 and s.unit != i) return error.IncompatibleUnits;
            s.unit = i;
            s.exponent = std.math.add(i32, s.exponent, exponent) catch return error.InvalidValue;
            if (pos == input.len) break;
            if (input[pos] == '/' and !denominator) denominator = true else if (input[pos] != '*') return error.InvalidValue;
            pos += 1;
            if (pos == input.len) return error.InvalidValue;
        }
        try result.validate();
        return result;
    }
    /// A source Unit can repeat a slot with different spellings. Its numeric
    /// factor is normalized into the first spelling kept in that slot.
    pub fn parseQuantity(a: std.mem.Allocator, n: Decimal, input: []const u8) Error!struct { number: Decimal, unit: Unit } {
        var terms: std.ArrayList(Unit) = .empty;
        defer terms.deinit(a);
        var result: Unit = .{};
        var pos: usize = 0;
        var denominator = false;
        var changed = false;
        var calendar = false;
        if (std.mem.startsWith(u8, input, "1/")) {
            pos = 2;
            denominator = true;
        }
        if (pos == input.len) return error.InvalidValue;
        while (pos < input.len) {
            const start = pos;
            while (pos < input.len and input[pos] != '*' and input[pos] != '/') : (pos += 1) {}
            if (pos == start) return error.InvalidValue;
            const token = input[start..pos];
            var term = try Unit.parse(token);
            if (denominator) for (&term.slots) |*slot| {
                slot.exponent = -slot.exponent;
            };
            for (term.slots, 0..) |slot, k| if (slot.exponent != 0) {
                calendar = calendar or (table.kind[k].calendar orelse false);
                const old = &result.slots[k];
                if (old.exponent != 0 and old.unit != slot.unit) changed = true;
                if (old.exponent == 0) old.unit = slot.unit;
                old.exponent = std.math.add(i32, old.exponent, slot.exponent) catch return error.InvalidValue;
            };
            try terms.append(a, term);
            if (pos == input.len) break;
            if (input[pos] == '/') {
                if (denominator) return error.InvalidValue;
                denominator = true;
            }
            pos += 1;
            if (pos == input.len) return error.InvalidValue;
        }
        if (calendar and terms.items.len != 1) return error.IncompatibleUnits;
        try result.validate();
        var value = n;
        if (changed) {
            // Convert the written factors in kind order, then convert out
            // into the normalized slots. Every factor gets its own rounding.
            for ([_]bool{ true, false }) |numerator_phase| for (0..table.kind.len) |kind| for (terms.items) |term| {
                const slot = term.slots[kind];
                if (slot.exponent == 0) continue;
                const u = table.unit[slot.unit];
                const op: dec.Operator = if (numerator_phase) .multiply else .divide;
                const applies = (slot.exponent > 0) == numerator_phase;
                for (0..@abs(slot.exponent)) |_| {
                    if (u.ratio != null) {
                        value = try dec.calculate(a, op, value, if (applies) ratio_numerator else ratio_denominator);
                    } else if (applies) {
                        value = try dec.calculate(a, op, value, unit_factors[slot.unit]);
                    }
                    if (kind_factors[kind]) |extra| if (applies) {
                        value = try dec.calculate(a, op, value, extra);
                    };
                }
            };
            value = try result.fromBase(a, value);
        }
        return .{ .number = value, .unit = result };
    }
    /// The canonical text, owned by the caller. `plural` spells a lone word
    /// Unit in the plural.
    pub fn string(self: Unit, a: std.mem.Allocator, plural: bool) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var count: usize = 0;
        for (self.slots) |s| if (s.exponent != 0) {
            count += 1;
        };
        var written = false;
        for (self.slots) |s| if (s.exponent > 0) {
            if (written) try out.writer.writeByte('*');
            try factor(&out.writer, s, plural and count == 1 and s.exponent == 1);
            written = true;
        };
        var any = false;
        for (self.slots) |s| if (s.exponent < 0) {
            any = true;
        };
        if (any) {
            if (!written) try out.writer.writeByte('1');
            try out.writer.writeByte('/');
            written = false;
            for (self.slots) |s| if (s.exponent < 0) {
                if (written) try out.writer.writeByte('*');
                try factor(&out.writer, s, false);
                written = true;
            };
        }
        return out.toOwnedSlice();
    }
    /// The power of each base dimension, indexed by the slot that holds it.
    pub fn dimensions(self: Unit) [table.kind.len]i64 {
        var result: [table.kind.len]i64 = @splat(0);
        for (self.slots, kind_dimensions) |s, d| result[d.slot] += @as(i64, s.exponent) * d.power;
        return result;
    }
    /// Whether both Units have the same dimensions, so convert to each other.
    pub fn compatible(self: Unit, other: Unit) bool {
        return std.mem.eql(i64, &self.dimensions(), &other.dimensions());
    }
    /// The product of two Units, or their quotient when `divide` is set.
    pub fn combine(left: Unit, right: Unit, divide: bool) Error!Unit {
        var result = left;
        for (right.slots, 0..) |s, i| {
            if (result.slots[i].exponent == 0) result.slots[i].unit = s.unit;
            result.slots[i].exponent = std.math.add(i32, result.slots[i].exponent, if (divide) -s.exponent else s.exponent) catch return error.InvalidValue;
        }
        try result.validate();
        return result;
    }
    /// Converts `n`, measured in this Unit, into Base Units.
    pub fn toBase(self: Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, false, false);
    }
    /// Converts `n`, measured in Base Units, into this Unit.
    pub fn fromBase(self: Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, true, false);
    }
    /// Converts `n` into Base Units for comparison only: intermediates may
    /// exceed the Script number range.
    pub fn comparisonBase(self: Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, false, true);
    }
    fn convert(self: Unit, a: std.mem.Allocator, n: Decimal, from_base: bool, comptime comparison: bool) Error!Decimal {
        const calculate = if (comparison) dec.calculateUnbounded else dec.calculate;
        var value = n;
        // Numerator factors precede denominator factors, both in kind order;
        // converting from Base Units reverses the phases.
        for (0..2) |step| {
            const numerator_phase = (step == 0) != from_base;
            const op: dec.Operator = if (numerator_phase != from_base) .multiply else .divide;
            for (self.slots, 0..) |s, k| {
                if (s.exponent == 0) continue;
                const u = table.unit[s.unit];
                const count: u32 = @intCast(@abs(s.exponent));
                const applies = (s.exponent > 0) == numerator_phase;
                for (0..count) |_| {
                    if (u.ratio != null) {
                        value = try calculate(a, op, value, if (applies) ratio_numerator else ratio_denominator);
                    } else if (applies) {
                        value = try calculate(a, op, value, unit_factors[s.unit]);
                    }
                    if (kind_factors[k]) |extra| if (applies) {
                        value = try calculate(a, op, value, extra);
                    };
                }
            }
        }
        return value;
    }
};
fn kindIndex(i: usize) usize {
    for (table.kind, 0..) |k, n| if (std.mem.eql(u8, k.name, table.unit[i].kind)) return n;
    unreachable;
}
fn factor(w: *std.Io.Writer, s: Slot, plural: bool) !void {
    const u = table.unit[s.unit];
    try w.writeAll(if (plural) u.plural orelse u.name else u.name);
    if (@abs(s.exponent) != 1) try w.print("^{d}", .{@abs(s.exponent)});
}

test "source units normalize repeated slots and reject calendar compounds" {
    const a = std.testing.allocator;
    const q = try Unit.parseQuantity(a, try Decimal.parse("2"), "m*cm");
    const s = try q.unit.string(a, false);
    defer a.free(s);
    try std.testing.expectEqualStrings("m^2", s);
    try std.testing.expectEqual(std.math.Order.eq, Decimal.order(q.number, try Decimal.parse("0.02")));
    const ratio = try Unit.parseQuantity(a, try Decimal.parse("1"), "m/cm");
    try std.testing.expect(ratio.unit.empty());
    try std.testing.expectEqual(std.math.Order.eq, Decimal.order(ratio.number, try Decimal.parse("100")));
    try std.testing.expectError(error.IncompatibleUnits, Unit.parseQuantity(a, try Decimal.parse("1"), "month/month"));
}

fn conversionAllocationTest(a: std.mem.Allocator, unit: Unit, n: Decimal) !void {
    _ = try unit.toBase(a, n);
    _ = try unit.fromBase(a, n);
}

test "compiled Unit factors preserve sequential rounding and quantum" {
    const a = std.testing.allocator;
    const examples = .{
        .{ "kg", &[_][]const u8{"1"}, &[_][]const u8{} },
        .{ "mm", &[_][]const u8{"0.001"}, &[_][]const u8{} },
        .{ "mL", &[_][]const u8{ "0.001", "0.001" }, &[_][]const u8{} },
        .{ "degF", &[_][]const u8{"5"}, &[_][]const u8{"9"} },
        .{ "1/degF", &[_][]const u8{"9"}, &[_][]const u8{"5"} },
        .{ "kg*mi^2/hr", &[_][]const u8{ "1", "1609.344", "1609.344" }, &[_][]const u8{"3600"} },
        .{ "mL/ft^3", &[_][]const u8{ "0.001", "0.001" }, &[_][]const u8{ "0.3048", "0.3048", "0.3048" } },
    };
    const numbers = [_]Decimal{
        .{ .exponent = -6176 },
        try Decimal.parse("-2.50"),
        try Decimal.parse("9999999999999999999999999999999999"),
        .{ .coefficient = 1, .exponent = -6176 },
        .{ .coefficient = 3, .exponent = -6176 },
    };
    inline for (examples) |example| {
        const unit = try Unit.parse(example[0]);
        for (numbers) |n| for ([_]bool{ false, true }) |from_base| {
            const expected: Error!Decimal = blk: {
                var value = n;
                const numerator = if (from_base) example[2] else example[1];
                const denominator = if (from_base) example[1] else example[2];
                for (numerator) |f| value = dec.calculate(a, .multiply, value, try Decimal.parse(f)) catch |err| break :blk err;
                for (denominator) |f| value = dec.calculate(a, .divide, value, try Decimal.parse(f)) catch |err| break :blk err;
                break :blk value;
            };
            const actual = unit.convert(a, n, from_base, false);
            if (expected) |value| {
                try std.testing.expectEqual(value, try actual);
            } else |err| try std.testing.expectError(err, actual);
        };
    }
    // Factor one preserves the input quantum without any scratch requests.
    var refusing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    const n = try Decimal.parse("2.50");
    try std.testing.expectEqual(n, try (try Unit.parse("kg")).toBase(refusing.allocator(), n));
    try std.testing.expectEqual(n, try (try Unit.parse("kg")).fromBase(refusing.allocator(), n));
    try std.testing.expect(!refusing.has_induced_failure);
    // Repeating division and subnormal multiplication still visit the general
    // path; fail every scratch request and verify all preceding work is freed.
    try std.testing.checkAllAllocationFailures(a, conversionAllocationTest, .{ try Unit.parse("degF"), n });
    try std.testing.checkAllAllocationFailures(a, conversionAllocationTest, .{ try Unit.parse("mm"), Decimal{ .coefficient = 5, .exponent = -6176 } });
}

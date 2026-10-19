//! Unit slots and factors come only from units.toml's generated catalogue.
const std = @import("std");
pub const table = @import("generated/units.zig").units;
const dec = @import("decimal/decimal.zig");
const Decimal = dec.Decimal;
/// Every refusal a Unit operation can report.
pub const Error = dec.Error || error{IncompatibleUnits};
/// One Unit Kind's factor: the catalogue Unit spelt in it and its power.
pub const Slot = struct { unit: std.math.IntFittingRange(0, table.unit.len - 1) = 0, exponent: i32 = 0 };
const Mask = std.math.IntFittingRange(0, (1 << table.kind.len) - 1);
fn bit(kind: usize) Mask {
    return @as(Mask, 1) << @intCast(kind);
}
fn nextKind(mask: *Mask) usize {
    const kind = @ctz(mask.*);
    mask.* &= mask.* - 1;
    return kind;
}
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
// A single Kind can be converted without visiting either phase when every
// step is an exact factor of one. Do not cancel nontrivial factors: their
// separate rounding and intermediate overflows are observable.
const identity_units = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.unit.len]bool = undefined;
    for (table.unit, unit_factors, 0..) |u, factor_value, i| {
        const extra = kind_factors[kindIndex(i)];
        result[i] = u.ratio == null and factor_value.coefficient == 1 and factor_value.exponent == 0 and
            (extra == null or (extra.?.coefficient == 1 and extra.?.exponent == 0));
    }
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
    /// Derived alongside the slots by parse/parseQuantity/combine; do not
    /// mutate slots independently. Never serialized or logically charged.
    active: Mask = 0,
    fn index(self: *Unit) void {
        self.active = 0;
        for (self.slots, 0..) |slot, k| if (slot.exponent != 0) {
            self.active |= bit(k);
        };
    }
    /// Whether no Kind is present, as for a plain number.
    pub fn empty(self: *const Unit) bool {
        return self.active == 0;
    }
    /// Refuses a calendar Unit raised to a power or in a Compound Unit.
    pub fn validate(self: *const Unit) Error!void {
        const calendars = comptime blk: {
            var mask: Mask = 0;
            for (table.kind, 0..) |kind, k| if (kind.calendar orelse false) {
                mask |= bit(k);
            };
            break :blk mask;
        };
        const calendar = self.active & calendars;
        if (calendar != 0 and (@popCount(self.active) != 1 or self.slots[@ctz(calendar)].exponent != 1)) return error.IncompatibleUnits;
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
            s.unit = @intCast(i);
            s.exponent = std.math.add(i32, s.exponent, exponent) catch return error.InvalidValue;
            if (pos == input.len) break;
            if (input[pos] == '/' and !denominator) denominator = true else if (input[pos] != '*') return error.InvalidValue;
            pos += 1;
            if (pos == input.len) return error.InvalidValue;
        }
        result.index();
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
        result.index();
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
                        value = try applyFactor(dec.calculate, a, op, value, unit_factors[slot.unit]);
                    }
                    if (kind_factors[kind]) |extra| if (applies) {
                        value = try applyFactor(dec.calculate, a, op, value, extra);
                    };
                }
            };
            value = try result.fromBase(a, value);
        }
        return .{ .number = value, .unit = result };
    }
    /// The canonical text, owned by the caller. `plural` spells a lone word
    /// Unit in the plural.
    pub fn string(self: *const Unit, a: std.mem.Allocator, plural: bool) ![]u8 {
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
    pub fn dimensions(self: *const Unit) [table.kind.len]i64 {
        var result: [table.kind.len]i64 = @splat(0);
        var mask = self.active;
        while (mask != 0) {
            const k = nextKind(&mask);
            const s = self.slots[k];
            const d = kind_dimensions[k];
            result[d.slot] += @as(i64, s.exponent) * d.power;
        }
        return result;
    }
    /// Whether both Units have the same dimensions, so convert to each other.
    pub fn compatible(self: *const Unit, other: *const Unit) bool {
        return std.mem.eql(i64, &self.dimensions(), &other.dimensions());
    }
    /// The product of two Units, or their quotient when `divide` is set.
    pub fn combine(left: *const Unit, right: *const Unit, divide: bool) Error!Unit {
        var result = left.*;
        var mask = right.active;
        while (mask != 0) {
            const i = nextKind(&mask);
            const s = right.slots[i];
            if (result.slots[i].exponent == 0) result.slots[i].unit = s.unit;
            result.slots[i].exponent = std.math.add(i32, result.slots[i].exponent, if (divide) -s.exponent else s.exponent) catch return error.InvalidValue;
            if (result.slots[i].exponent == 0) result.active &= ~bit(i) else result.active |= bit(i);
        }
        try result.validate();
        return result;
    }
    /// Converts `n`, measured in this Unit, into Base Units.
    pub fn toBase(self: *const Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, false, false);
    }
    /// Converts `n`, measured in Base Units, into this Unit.
    pub fn fromBase(self: *const Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, true, false);
    }
    /// Converts `n` into Base Units for comparison only: intermediates may
    /// exceed the Script number range.
    pub fn comparisonBase(self: *const Unit, a: std.mem.Allocator, n: Decimal) Error!Decimal {
        return self.convert(a, n, false, true);
    }
    fn convert(self: *const Unit, a: std.mem.Allocator, n: Decimal, from_base: bool, comptime comparison: bool) Error!Decimal {
        if (self.active == 0) return n;
        // As in applyFactor, a zero or a positive exponent must still pass
        // through Decimal arithmetic for sign/quantum/exponent clamping.
        const calculate = if (comparison) dec.calculateUnbounded else dec.calculate;
        var value = n;
        if (@popCount(self.active) == 1) {
            const k = @ctz(self.active);
            const s = self.slots[k];
            if (n.coefficient != 0 and n.exponent <= 0 and identity_units[s.unit]) return n;
            // A lone non-ratio Kind has work in exactly one phase. Keep
            // each unit/Kind factor and repetition separate, in the same
            // order; ratio Units still need both phases below.
            if (table.unit[s.unit].ratio == null) {
                const op: dec.Operator = if ((s.exponent > 0) != from_base) .multiply else .divide;
                for (0..@abs(s.exponent)) |_| {
                    value = try applyFactor(calculate, a, op, value, unit_factors[s.unit]);
                    if (kind_factors[k]) |extra| value = try applyFactor(calculate, a, op, value, extra);
                }
                return value;
            }
        }
        // Numerator factors precede denominator factors, both in kind order;
        // converting from Base Units reverses the phases.
        for (0..2) |step| {
            const numerator_phase = (step == 0) != from_base;
            const op: dec.Operator = if (numerator_phase != from_base) .multiply else .divide;
            var mask = self.active;
            while (mask != 0) {
                const k = nextKind(&mask);
                const s = self.slots[k];
                const u = table.unit[s.unit];
                const count: u32 = @intCast(@abs(s.exponent));
                const applies = (s.exponent > 0) == numerator_phase;
                for (0..count) |_| {
                    if (u.ratio != null) {
                        value = try calculate(a, op, value, if (applies) ratio_numerator else ratio_denominator);
                    } else if (applies) {
                        value = try applyFactor(calculate, a, op, value, unit_factors[s.unit]);
                    }
                    if (kind_factors[k]) |extra| if (applies) {
                        value = try applyFactor(calculate, a, op, value, extra);
                    };
                }
            }
        }
        return value;
    }
};
/// Verified static target metadata, owned by its code unit. Each run keeps
/// the factor pair and repetition count, so exponents never expand storage.
pub const Descriptor = struct {
    unit: Unit,
    dimensions: [table.kind.len]i64,
    plan: Plan,
    pub fn init(unit: Unit) Descriptor {
        return .{ .unit = unit, .dimensions = unit.dimensions(), .plan = Plan.init(&unit) };
    }
};
const plan_factors = blk: {
    var factors: [table.unit.len + table.kind.len + 2]Decimal = undefined;
    for (unit_factors, 0..) |factor_value, i| factors[i] = factor_value;
    for (kind_factors, 0..) |factor_value, i| factors[table.unit.len + i] = factor_value orelse Decimal.fromInt(@as(u8, 1));
    factors[factors.len - 2] = ratio_numerator;
    factors[factors.len - 1] = ratio_denominator;
    break :blk factors;
};
pub const Plan = struct {
    const Factor = std.math.IntFittingRange(0, plan_factors.len - 1);
    const Run = struct { first: Factor = 0, second: ?Factor = null, count: u32 = 0 };
    runs: [2 * table.kind.len]Run = @splat(.{}),
    numerator_end: u8 = 0,
    len: u8 = 0,
    pub fn init(unit: *const Unit) Plan {
        var plan: Plan = .{};
        for ([_]bool{ true, false }) |numerator| {
            var mask = unit.active;
            while (mask != 0) {
                const k = nextKind(&mask);
                const slot = unit.slots[k];
                const applies = (slot.exponent > 0) == numerator;
                const ratio = table.unit[slot.unit].ratio != null;
                if (!applies and !ratio) continue;
                plan.runs[plan.len] = .{
                    .first = if (ratio) @intCast(plan_factors.len - (if (applies) @as(usize, 2) else 1)) else slot.unit,
                    .second = if (applies and kind_factors[k] != null) @intCast(table.unit.len + k) else null,
                    .count = @intCast(@abs(slot.exponent)),
                };
                plan.len += 1;
            }
            if (numerator) plan.numerator_end = plan.len;
        }
        return plan;
    }
    /// Executes exactly the Unit conversion sequence, with bounded or
    /// comparison-only unbounded Decimal intermediates.
    pub fn execute(self: *const Plan, a: std.mem.Allocator, n: Decimal, from_base: bool, comptime comparison: bool) Error!Decimal {
        const calculate = if (comparison) dec.calculateUnbounded else dec.calculate;
        var value = n;
        const numerator = self.runs[0..self.numerator_end];
        const denominator = self.runs[self.numerator_end..self.len];
        const phases: [2][]const Run = if (from_base) .{ denominator, numerator } else .{ numerator, denominator };
        for (phases, 0..) |runs, phase| {
            const op: dec.Operator = if (phase == 0) .multiply else .divide;
            for (runs) |run| for (0..run.count) |_| {
                value = try applyFactor(calculate, a, op, value, plan_factors[run.first]);
                if (run.second) |extra| value = try applyFactor(calculate, a, op, value, plan_factors[extra]);
            };
        }
        return value;
    }
};
/// One conversion step. A factor of exactly 1 leaves a nonzero value with a
/// representable exponent unchanged, so it is skipped; zeros and positive
/// exponents still go through `calculate` for exponent clamping.
fn applyFactor(calculate: anytype, a: std.mem.Allocator, op: dec.Operator, value: Decimal, f: Decimal) Error!Decimal {
    if (f.coefficient == 1 and f.exponent == 0 and !f.negative and value.coefficient != 0 and value.exponent <= 0) return value;
    return calculate(a, op, value, f);
}
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

// The pre-metadata traversal remains an independent differential oracle.
fn originalConversion(self: *const Unit, a: std.mem.Allocator, n: Decimal, from_base: bool, comptime comparison: bool) Error!Decimal {
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
                    value = try applyFactor(calculate, a, op, value, unit_factors[s.unit]);
                }
                if (kind_factors[k]) |extra| if (applies) {
                    value = try applyFactor(calculate, a, op, value, extra);
                };
            }
        }
    }
    return value;
}

fn checkConversionResult(expected: Error!Decimal, actual: Error!Decimal) !void {
    if (expected) |number| {
        try std.testing.expectEqual(number, try actual);
    } else |err| try std.testing.expectError(err, actual);
}
fn plannedAllocationTest(a: std.mem.Allocator, unit: Unit, n: Decimal) !void {
    const plan = Plan.init(&unit);
    _ = try plan.execute(a, n, false, false);
    _ = try plan.execute(a, n, true, false);
    _ = try plan.execute(a, n, false, true);
}
test "sparse and planned conversion agree with original steps including unbounded comparison" {
    const a = std.testing.allocator;
    const numbers = [_]Decimal{
        .{ .exponent = -6176 },
        .{ .negative = true, .exponent = -6176 },
        .{ .coefficient = 1, .exponent = 2 },
        .{ .coefficient = 0, .exponent = 2 },
        try Decimal.parse("-2.50"),
        try Decimal.parse("9999999999999999999999999999999999"),
        .{ .coefficient = 3, .exponent = -6176 },
    };
    var examples: std.ArrayList(Unit) = .empty;
    defer examples.deinit(a);
    for (table.unit) |unit| try examples.append(a, try Unit.parse(unit.name));
    for ([_][]const u8{ "1/degF", "degF^3/hr", "mL/ft^3", "kg*mi^2/hr", "mL^2/degF^2", "m^3/L", "m/m", "m^2", "1/m^2", "month", "year" }) |text| try examples.append(a, try Unit.parse(text));
    for (examples.items) |unit| {
        const descriptor = Descriptor.init(unit);
        var dimensions: [table.kind.len]i64 = @splat(0);
        for (unit.slots, kind_dimensions) |slot, dimension| dimensions[dimension.slot] += @as(i64, slot.exponent) * dimension.power;
        try std.testing.expectEqual(dimensions, descriptor.dimensions);
        for (numbers) |n| for ([_]bool{ false, true }) |from_base| {
            try checkConversionResult(originalConversion(&unit, a, n, from_base, false), unit.convert(a, n, from_base, false));
            try checkConversionResult(originalConversion(&unit, a, n, from_base, false), descriptor.plan.execute(a, n, from_base, false));
            try checkConversionResult(originalConversion(&unit, a, n, from_base, true), unit.convert(a, n, from_base, true));
            try checkConversionResult(originalConversion(&unit, a, n, from_base, true), descriptor.plan.execute(a, n, from_base, true));
        };
    }
    // i32 exponent extremes keep bounded metadata; no expanded factor list.
    const huge = try Unit.parse("m^2147483647");
    try std.testing.expectEqual(@as(i64, 2147483647), huge.dimensions()[1]);
    try std.testing.expectEqual(@as(u8, 1), Plan.init(&huge).len);
    try std.testing.expectError(error.InvalidValue, Unit.combine(&huge, &huge, false));
    const inverse = try Unit.parse("1/m^2147483647");
    const cancelled = try Unit.combine(&huge, &inverse, false);
    try std.testing.expect(cancelled.empty());
    const month = try Unit.parse("month");
    const metre = try Unit.parse("m");
    try std.testing.expectError(error.IncompatibleUnits, Unit.combine(&month, &metre, false));
    try std.testing.expectError(error.IncompatibleUnits, Unit.parseQuantity(a, try Decimal.parse("1"), "month/month"));
    try std.testing.checkAllAllocationFailures(a, plannedAllocationTest, .{ try Unit.parse("degF"), try Decimal.parse("2.50") });
    try std.testing.checkAllAllocationFailures(a, plannedAllocationTest, .{ try Unit.parse("mL/ft^3"), numbers[6] });
}

test "sparse combinations preserve catalogue products quotients and calendar refusals" {
    for (table.unit) |left| for (table.unit) |right| {
        const l = try Unit.parse(left.name);
        const r = try Unit.parse(right.name);
        for ([_]bool{ false, true }) |divide| {
            var reference = l;
            var calendar = false;
            var present: usize = 0;
            for (r.slots, 0..) |slot, k| {
                if (reference.slots[k].exponent == 0) reference.slots[k].unit = slot.unit;
                reference.slots[k].exponent += if (divide) -slot.exponent else slot.exponent;
            }
            var invalid = false;
            for (reference.slots, table.kind) |slot, kind| if (slot.exponent != 0) {
                present += 1;
                if (kind.calendar orelse false) {
                    calendar = true;
                    invalid = invalid or slot.exponent != 1;
                }
            };
            invalid = invalid or (calendar and present != 1);
            if (invalid) {
                try std.testing.expectError(error.IncompatibleUnits, Unit.combine(&l, &r, divide));
            } else {
                const result = try Unit.combine(&l, &r, divide);
                for (reference.slots, result.slots) |expected, actual| {
                    try std.testing.expectEqual(expected.exponent, actual.exponent);
                    if (expected.exponent != 0) try std.testing.expectEqual(expected.unit, actual.unit);
                }
                reference.index();
                try std.testing.expectEqual(reference.active, result.active);
                try std.testing.expectEqual(reference.dimensions(), result.dimensions());
            }
        }
    };
}

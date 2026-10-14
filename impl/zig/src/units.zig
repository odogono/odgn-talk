//! Unit slots and factors come only from units.toml's generated catalogue.
const std = @import("std");
pub const table = @import("generated/units.zig").units;
const dec = @import("decimal/decimal.zig");
const Decimal = dec.Decimal;
/// Every refusal a Unit operation can report.
pub const Error = dec.Error || error{IncompatibleUnits};
/// One Unit Kind's factor: the catalogue Unit spelt in it and its power.
pub const Slot = struct { unit: usize = 0, exponent: i32 = 0 };
/// The catalogue's factor strings, parsed once at compile time. Conversions
/// apply these Decimals step by step instead of re-reading their text.
const unit_factors = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.unit.len]Decimal = undefined;
    for (table.unit, 0..) |u, i| result[i] = Decimal.parse(u.factor orelse "1") catch unreachable;
    break :blk result;
};
const kind_factors = blk: {
    @setEvalBranchQuota(100_000);
    var result: [table.kind.len]?Decimal = @splat(null);
    for (table.kind, 0..) |k, i| {
        if (k.factor) |f| result[i] = Decimal.parse(f) catch unreachable;
    }
    break :blk result;
};
/// The `degF` ratio's factors, as the catalogue's only `ratio`.
const ratio_numerator = Decimal{ .coefficient = 5 };
const ratio_denominator = Decimal{ .coefficient = 9 };
/// One conversion step, rounded as every step is. A factor of exactly 1 at
/// exponent 0 leaves a nonzero value unchanged, coefficient, exponent and
/// sign alike, for both operators, so that step needs no calculation at
/// all; a zero value still goes through `calculate` for its exponent
/// clamping. Power-of-ten factors need no step of their own here: the
/// Decimal operators already take their exact paths for them.
fn applyFactor(a: std.mem.Allocator, comptime comparison: bool, op: dec.Operator, value: Decimal, f: Decimal) Error!Decimal {
    if (value.coefficient != 0 and f.coefficient == 1 and f.exponent == 0 and !f.negative) return value;
    const calculate = if (comparison) dec.calculateUnbounded else dec.calculate;
    return calculate(a, op, value, f);
}
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
                        value = try applyFactor(a, false, op, value, if (applies) ratio_numerator else ratio_denominator);
                    } else if (applies) {
                        value = try applyFactor(a, false, op, value, unit_factors[slot.unit]);
                    }
                    if (kind_factors[kind]) |extra| if (applies) {
                        value = try applyFactor(a, false, op, value, extra);
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
                        value = try applyFactor(a, comparison, op, value, if (applies) ratio_numerator else ratio_denominator);
                    } else if (applies) {
                        value = try applyFactor(a, comparison, op, value, unit_factors[s.unit]);
                    }
                    if (kind_factors[k]) |extra| if (applies) {
                        value = try applyFactor(a, comparison, op, value, extra);
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

test "pre-parsed factors match the catalogue text" {
    for (table.unit, unit_factors) |u, parsed| {
        try std.testing.expectEqual(try Decimal.parse(u.factor orelse "1"), parsed);
    }
    for (table.kind, kind_factors) |k, parsed| {
        if (k.factor) |text| try std.testing.expectEqual(try Decimal.parse(text), parsed.?) else try std.testing.expect(parsed == null);
    }
}

test "factor-one conversions are allocation-free and preserve the value" {
    const a = std.testing.allocator;
    const value = try Decimal.parse("2.50");
    for ([_][]const u8{ "kg", "m", "s", "month", "USD", "kg*m/s" }) |name| {
        const unit = try Unit.parse(name);
        var refusing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
        try std.testing.expectEqual(value, try unit.toBase(refusing.allocator(), value));
        try std.testing.expectEqual(value, try unit.fromBase(refusing.allocator(), value));
        try std.testing.expectEqual(value, try unit.comparisonBase(refusing.allocator(), value));
        try std.testing.expect(!refusing.has_induced_failure);
    }
    // A zero value keeps calculate's exponent clamping, not the shortcut.
    const kg = try Unit.parse("kg");
    try std.testing.expectEqual(Decimal{}, try kg.comparisonBase(a, .{ .exponent = 5 }));
    try std.testing.expectEqual(try Decimal.parse("0.00"), try kg.fromBase(a, try Decimal.parse("0.00")));
}

fn convertAllocationTest(a: std.mem.Allocator, unit: Unit, n: Decimal) !void {
    _ = try unit.toBase(a, n);
}

test "compound conversions keep factor order and clean up on refusal" {
    const a = std.testing.allocator;
    // Numerator factors precede denominator factors, each rounded in turn:
    // 9 degF is (9 * 5) / 9 in Base Units, and a litre also takes its
    // Kind's 0.001 factor after its own factor of 1.
    try std.testing.expectEqual(try Decimal.parse("5"), try (try Unit.parse("degF")).toBase(a, try Decimal.parse("9")));
    try std.testing.expectEqual(try Decimal.parse("0.001"), try (try Unit.parse("L")).toBase(a, try Decimal.parse("1")));
    try std.testing.expectEqual(std.math.Order.eq, Decimal.order(try (try Unit.parse("mL")).toBase(a, try Decimal.parse("1000")), try Decimal.parse("0.001")));
    const speed = try Unit.parse("mi/hr");
    const base = try speed.toBase(a, try Decimal.parse("60"));
    try std.testing.expectEqual(std.math.Order.eq, Decimal.order(try speed.fromBase(a, base), try Decimal.parse("60")));
    // 1 degF needs the general division path (5 / 9 does not terminate):
    // refusal propagates and every partial allocation is freed.
    const deg_f = try Unit.parse("degF");
    const one = try Decimal.parse("1");
    var refusing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    try std.testing.expectError(error.OutOfMemory, deg_f.toBase(refusing.allocator(), one));
    try std.testing.checkAllAllocationFailures(a, convertAllocationTest, .{ deg_f, one });
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

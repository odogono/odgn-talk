//! Cost Model 0 (chapter 8): each instruction's Fuel and allocation from its
//! rate's formula, and the logical sizes the Allocation Budget and Persistent
//! State count.
const std = @import("std");
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const rates = @import("../generated/rates.zig");
const machine = @import("../generated/machine.zig").machine;
const Opcode = @import("../generated/opcodes.zig").Opcode;
const matcher = @import("matcher.zig");
const Value = model.Value;

/// What one instruction's formulas measure. The values are owned references.
pub const Measures = struct {
    restricted_refusal: bool = false,
    input: ?*Value = null,
    result: ?*Value = null,
    scanned: u64 = 0,
    count: u64 = 0,
    /// The Text Pattern matcher's steps (chapter 8, Running).
    steps: u64 = 0,
    /// A Built-in's rate key, `builtin.<name>`, in place of `call-builtin`'s.
    builtin: []const u8 = "",
    args: []const *Value = &.{},
    /// Allocation beyond the formula's: `bin-bits`'s later values, whose
    /// sizes add to the first's, and an Operation's declared allocation.
    alloc_extra: u64 = 0,
    /// Fuel beyond the formula's: what a Host function drew with `Charge`.
    fuel_extra: u64 = 0,
    /// An Operation's declared Fuel.
    declared: u64 = 0,
    /// Set when nothing is charged, as for a Capability argument that
    /// breaks its Shape.
    uncharged: bool = false,
    /// Set once a Capability call has reached its Host function, whose
    /// Fuel stays spent if converting its result faults on allocation.
    reached_host: bool = false,

    pub fn release(self: *Measures) void {
        if (self.input) |v| v.release();
        if (self.result) |v| v.release();
        self.* = .{};
    }
};

pub const Charge = rates.Charge;

fn find(key: []const u8) ?*const rates.CostRate {
    var lo: usize = 0;
    var hi: usize = rates.cost_rates.len;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        switch (std.mem.order(u8, rates.cost_rates[mid].key, key)) {
            .eq => return &rates.cost_rates[mid],
            .lt => lo = mid + 1,
            .gt => hi = mid,
        }
    }
    return null;
}

/// An instruction's charge by its rate key.
pub fn charge(key: []const u8, m: *const Measures) Charge {
    var buf: [64]u8 = undefined;
    const full = if (m.builtin.len > 0) std.fmt.bufPrint(&buf, "builtin.{s}", .{m.builtin}) catch key else key;
    return chargeRateGeneric(find(full), m);
}

// Resolve the generated opcode-to-rate mapping once, without adding metadata
// to code units, frames or snapshots. Null preserves charge's missing-rate
// behavior for instructions whose rate is supplied dynamically.
const instruction_rates = blk: {
    @setEvalBranchQuota(100_000);
    var out: [machine.instruction.len]?*const rates.CostRate = undefined;
    for (machine.instruction, 0..) |ins, i| out[i] = find(ins.cost);
    break :blk out;
};

/// The same charge at an instruction boundary, with its static rate already
/// resolved. Built-ins still use their measured name; restricted refusals use
/// their own rate. Generated evaluators specialize static formulas; dynamic
/// Built-ins and unsupported formulas keep the generic evaluator.
pub fn chargeInstruction(op: Opcode, m: *const Measures) Charge {
    if (m.builtin.len > 0) return charge(if (m.restricted_refusal) "restricted-refusal" else m.builtin, m);
    const rate = if (m.restricted_refusal) comptime find("restricted-refusal") else instruction_rates[@backingInt(op)];
    return chargeRate(rate, m);
}

// Each instruction's charge when its formulas measure nothing: no subject,
// and zero scanned, count, steps and declared Fuel.
const unmeasured_charges = blk: {
    @setEvalBranchQuota(100_000);
    var out: [machine.instruction.len]Charge = undefined;
    for (instruction_rates, 0..) |rate, i| out[i] = chargeRateGeneric(rate, &.{});
    break :blk out;
};

/// `chargeInstruction(op, &.{})`, read from a table.
pub fn chargeUnmeasured(op: Opcode) Charge {
    return unmeasured_charges[@backingInt(op)];
}

fn chargeRate(found: ?*const rates.CostRate, m: *const Measures) Charge {
    const rate = found orelse return .{ .fuel = 0, .alloc = 0 };
    if (rate.formula) |formula| {
        const base = rates.evaluateSpecialized(formula, m, measure);
        return .{ .fuel = base.fuel + m.fuel_extra, .alloc = base.alloc + m.alloc_extra };
    }
    return chargeRateGeneric(rate, m);
}

// The term interpreter remains independent of generated evaluators: it is the
// oracle for differential tests and the fallback for keyed/dynamic charging.
fn chargeRateGeneric(found: ?*const rates.CostRate, m: *const Measures) Charge {
    const rate = found orelse return .{ .fuel = 0, .alloc = 0 };
    return .{ .fuel = evaluate(rate.fuel, m) + m.fuel_extra, .alloc = evaluate(rate.alloc, m) + m.alloc_extra };
}

fn evaluate(terms: []const rates.CostTerm, m: *const Measures) u64 {
    var total: u64 = 0;
    for (terms) |t| {
        const subject: ?*const Value = switch (t.subject) {
            rates.subject_input => m.input,
            rates.subject_result => m.result,
            rates.subject_none => null,
            else => blk: {
                const i: usize = @intCast(t.subject - rates.subject_x1);
                break :blk if (i < m.args.len) m.args[i] else null;
            },
        };
        const measured: u64 = switch (t.measure) {
            rates.measure_constant => 1,
            rates.measure_scanned => m.scanned,
            rates.measure_count => m.count,
            rates.measure_steps => m.steps,
            rates.measure_declared => m.declared,
            else => if (subject) |v| measure(t.measure, v) else 0,
        };
        const n = @as(u64, @intCast(t.factor)) * measured;
        const d: u64 = @intCast(t.divisor);
        total += (n + d - 1) / d;
    }
    return total;
}

inline fn measure(which: u8, v: *const Value) u64 {
    return switch (which) {
        rates.measure_size => size(v),
        rates.measure_contents => contents(v),
        rates.measure_characters => if (v.data == .text) model.textCharacters(v) else 0,
        rates.measure_scalars => if (v.data == .text) (if (v.text_ascii) v.data.text.len else scalars(v.data.text)) else 0,
        rates.measure_utf8 => if (v.data == .text) v.data.text.len else 0,
        rates.measure_bytes => if (v.data == .bytes) v.data.bytes.len else 0,
        rates.measure_items => items(v),
        rates.measure_entries => if (v.data == .map) v.data.map.len else 0,
        rates.measure_program => if (v.data == .pattern) matcher.programSize(v) else 0,
        rates.measure_digits => switch (v.data) {
            .number => |n| digits(n.coefficient),
            .quantity => |q| digits(q.number.coefficient),
            else => 0,
        },
        else => 0,
    };
}

fn scalars(text: []const u8) u64 {
    var n: u64 = 0;
    for (text) |b| {
        if (b & 0xc0 != 0x80) n += 1;
    }
    return n;
}

fn digits(c: u128) u64 {
    var n: u64 = 1;
    // Most coefficients fit 64 bits, whose division is much cheaper.
    if (c <= std.math.maxInt(u64)) {
        var y: u64 = @intCast(c);
        while (y >= 10) : (y /= 10) n += 1;
        return n;
    }
    var x = c;
    while (x >= 10) : (x /= 10) n += 1;
    return n;
}

fn items(v: *const Value) u64 {
    return switch (v.data) {
        .list => |l| l.len,
        .range => |r| blk: {
            const from = if (r.from.data == .number) r.from.data.number.integer(i64) catch break :blk 0 else break :blk 0;
            const to = if (r.to.data == .number) r.to.data.number.integer(i64) catch break :blk 0 else break :blk 0;
            break :blk if (to >= from) @intCast(to - from + 1) else 0;
        },
        else => 0,
    };
}

/// The logical size of a container's contents, or a Function's captured
/// values (chapter 8, Logical sizes). Values keep it as they are built.
pub fn contents(v: *const Value) u64 {
    return model.contentsSize(v);
}

/// A value's logical size (chapter 8, Logical sizes), read without walking
/// its children.
pub fn size(v: *const Value) u64 {
    return model.logicalSize(v);
}

test "resolved instruction rates agree with keyed charging and dynamic overrides" {
    const gpa = std.testing.allocator;
    const number = try model.scalar(gpa, .{ .number = try model.Decimal.parse("123456789.25") });
    defer number.release();
    const text = try model.text(gpa, "café👋abcdefghijklmnopqrstuvwxyz");
    defer text.release();
    const list = try model.list(gpa, &.{ number, text });
    defer list.release();
    const args = [_]*Value{ number, text, list };
    // Exercise every opcode against the original keyed path, with populated
    // measures, absent subjects, restricted refusals, and Built-in overrides.
    // Nonzero extras also cover the pre-Host and partial-result charge paths.
    for ([_]?*Value{ null, number, text, list }) |value| {
        for ([_]bool{ false, true }) |restricted| {
            for ([_][]const u8{ "", "abs", "rangeStart", "not-a-builtin", "a-builtin-name-longer-than-the-charge-buffer-which-must-use-the-fallback-key" }) |builtin| {
                const m: Measures = .{
                    .input = value,
                    .result = value,
                    .args = &args,
                    .scanned = 17,
                    .count = 19,
                    .steps = 23,
                    .declared = 29,
                    .fuel_extra = 31,
                    .alloc_extra = 37,
                    .restricted_refusal = restricted,
                    .builtin = builtin,
                };
                for (machine.instruction, 0..) |ins, i| {
                    const op: Opcode = @fromBackingInt(@intCast(i));
                    const key = if (restricted) "restricted-refusal" else if (builtin.len > 0) builtin else ins.cost;
                    try std.testing.expectEqualDeep(charge(key, &m), chargeInstruction(op, &m));
                }
            }
        }
    }
}

test "Text metadata preserves exact scalar and Character measures and concat charges" {
    const gpa = std.testing.allocator;
    const samples = [_][]const u8{ "", "\r", "\n", "\r\n", "abcdefghijklmnop\r\n", "e\u{301}", "\u{1100}\u{1161}", "👨‍👩‍👧🇬🇧", "q́" };
    for (samples) |left| {
        for (samples) |right| {
            const l = try model.text(gpa, left);
            defer l.release();
            const r = try model.text(gpa, right);
            defer r.release();
            const joined = try model.concatTextValues(gpa, l, r);
            defer joined.release();
            // Independent decoding and segmentation, with no metadata use.
            var it: unicode.utf8.Iterator = .{ .bytes = joined.data.text };
            var count: u64 = 0;
            while (it.next() != null) count += 1;
            try std.testing.expectEqual(count, measure(rates.measure_scalars, joined));
            try std.testing.expectEqual(@as(u64, unicode.grapheme.count(joined.data.text)), measure(rates.measure_characters, joined));
            const m: Measures = .{ .result = joined };
            const expected: Charge = .{ .fuel = 3 + (count + 15) / 16, .alloc = 16 + joined.data.text.len };
            try std.testing.expectEqualDeep(expected, charge("concat", &m));
            try std.testing.expectEqualDeep(expected, chargeInstruction(.concat, &m));
        }
    }
}

// Compare complete rate pairs, including rates not used by any opcode. The
// keyed path must remain an interpreter oracle, rather than comparing two
// calls through the same generated evaluator.
fn expectRateAgreement(m: *const Measures) !void {
    for (&rates.cost_rates) |*rate| {
        try std.testing.expectEqualDeep(chargeRateGeneric(rate, m), chargeRate(rate, m));
    }
    try std.testing.expectEqualDeep(chargeRateGeneric(null, m), chargeRate(null, m));
}

test "every generated rate agrees with the interpreter for independently missing and populated subjects" {
    const a = std.testing.allocator;
    var values: std.ArrayList(*Value) = .empty;
    defer {
        for (values.items) |v| v.release();
        values.deinit(a);
    }
    try values.append(a, try model.scalar(a, .nothing));
    try values.append(a, try model.scalar(a, .{ .bool = true }));
    for ([_][]const u8{ "0", "9999999", "10000000", "99999999", "100000000", "9999999999999999", "10000000000000000", "9999999999999999999999999999999999" }) |decimal| {
        try values.append(a, try model.scalar(a, .{ .number = try model.Decimal.parse(decimal) }));
        try values.append(a, try model.quantity(a, try model.Decimal.parse(decimal), "m"));
    }
    for ([_]usize{ 0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33 }) |n| {
        const data = try a.alloc(u8, n);
        defer a.free(data);
        @memset(data, 'a');
        try values.append(a, try model.text(a, data));
        try values.append(a, try model.bytes(a, data));
        const children = try a.alloc(*Value, n);
        defer a.free(children);
        @memset(children, values.items[0]);
        try values.append(a, try model.list(a, children));
    }
    try values.append(a, try model.text(a, "café👨‍👩‍👧‍👦🇫🇷"));
    try values.append(a, try model.map(a, &.{ .{ .key = "é", .value = values.items[2] }, .{ .key = "x", .value = values.items[3] } }));
    const from = try model.scalar(a, .{ .number = try model.Decimal.parse("1") });
    defer from.release();
    const to = try model.scalar(a, .{ .number = try model.Decimal.parse("17") });
    defer to.release();
    try values.append(a, try model.range(a, from, to));
    try values.append(a, try model.range(a, to, from));
    try values.append(a, try model.scalar(a, .{ .pattern = try a.dupe(u8, "[digit]+") }));
    // All argument prefixes test missing x1/x2/x3 independently of input and
    // result, and every kind reaches every measure in the generic Built-ins.
    const args = [_]*Value{ values.items[2], values.items[3], values.items[0] };
    for (0..values.items.len + 1) |i| {
        for (0..values.items.len + 1) |j| {
            var m: Measures = .{
                .input = if (i == 0) null else values.items[i - 1],
                .result = if (j == 0) null else values.items[j - 1],
                .scanned = 17,
                .count = 33,
                .steps = 9,
                .declared = 31,
                .fuel_extra = 37,
                .alloc_extra = 41,
            };
            try expectRateAgreement(&m);
            // reached_host and uncharged belong to the caller's boundary
            // decisions; the evaluator must not silently change their charge.
            m.reached_host = true;
            m.uncharged = true;
            for (0..args.len + 1) |n| {
                m.args = args[0..n];
                try expectRateAgreement(&m);
            }
        }
    }
    for (values.items) |v| {
        const all_args = [_]*Value{ v, v, v };
        const m: Measures = .{ .args = &all_args };
        try expectRateAgreement(&m);
    }
}

test "generated rounding, factors, large measures and Host extras preserve checked arithmetic" {
    for ([_]u64{ 0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33, (1 << 56) - 1, (1 << 62) - 1 }) |n| {
        const m: Measures = .{ .scanned = n, .count = n, .steps = n, .declared = n, .fuel_extra = 43, .alloc_extra = 47 };
        try expectRateAgreement(&m);
    }
    for (&rates.cost_rates) |*rate| {
        const empty: Measures = .{};
        const base = chargeRateGeneric(rate, &empty);
        const m: Measures = .{ .fuel_extra = std.math.maxInt(u64) - base.fuel - 1, .alloc_extra = std.math.maxInt(u64) - base.alloc - 1 };
        try std.testing.expectEqualDeep(Charge{ .fuel = std.math.maxInt(u64) - 1, .alloc = std.math.maxInt(u64) - 1 }, chargeRate(rate, &m));
        try std.testing.expectEqualDeep(chargeRateGeneric(rate, &m), chargeRate(rate, &m));
    }
    // A failed Host conversion evaluates the pre-result charge again, keeping
    // declared and drawn Fuel; the machine still owns refusal ordering.
    const result = try model.text(std.testing.allocator, "result conversion");
    defer result.release();
    var m: Measures = .{ .result = result, .declared = 101, .fuel_extra = 103, .alloc_extra = 107, .reached_host = true };
    try expectRateAgreement(&m);
    m.result = null;
    try expectRateAgreement(&m);
}

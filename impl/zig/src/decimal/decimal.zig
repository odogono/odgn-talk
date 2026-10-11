//! Chapter 3 decimals. Inputs are counted before arithmetic; operators round
//! their exact rational result once, then choose the nearest ideal exponent.
const std = @import("std");
const utf8 = @import("../unicode/utf8.zig");
const properties = @import("../unicode/properties.zig");
const Big = std.math.big.int.Managed;
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidValue, Overflow, DivisionByZero, OutOfMemory };
/// 10^34: every coefficient is below it, so a Decimal has at most 34 digits.
const coefficient_limit: u128 = 10000000000000000000000000000000000;

pub fn trim(s: []const u8) []const u8 {
    if (!utf8.validate(s)) return s;
    var first: usize = 0;
    var last: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const cp = utf8.decode(s, i);
        const end = i + utf8.sequenceLength(s[i]);
        if (!properties.isWhiteSpace(cp)) {
            last = end;
        } else if (last == 0) {
            first = end;
        }
        i = end;
    }
    return s[first..@max(first, last)];
}

pub const Decimal = struct {
    coefficient: u128 = 0,
    exponent: i32 = 0,
    negative: bool = false,

    pub fn parse(input: []const u8) Error!Decimal {
        const s = trim(input);
        if (s.len == 0) return error.InvalidValue;
        var start: usize = if (s[0] == '-') 1 else 0;
        const neg = start == 1;
        if (start == s.len) return error.InvalidValue;
        if (std.mem.startsWith(u8, s[start..], "0x")) {
            start += 2;
            if (start == s.len) return error.InvalidValue;
            // At most 29 nonzero-leading hex digits fit the decimal limit.
            while (start < s.len and s[start] == '0') : (start += 1) {}
            if (s.len - start > 29) return error.InvalidValue;
            var n: u128 = 0;
            for (s[start..]) |c| {
                const digit = std.fmt.charToDigit(c, 16) catch return error.InvalidValue;
                n = n * 16 + digit;
                if (n >= coefficient_limit) return error.InvalidValue;
            }
            return .{ .coefficient = n, .negative = neg and n != 0 };
        }
        var dot: ?usize = null;
        var significant: usize = 0;
        var seen = false;
        // This scan never multiplies. Even a million significant digits cost
        // only one pass and cannot grow an arbitrary-precision integer.
        for (s[start..], start..) |c, i| {
            if (c == '.') {
                if (dot != null or i == start or i + 1 == s.len) return error.InvalidValue;
                dot = i;
            } else if (c >= '0' and c <= '9') {
                seen = seen or c != '0';
                if (seen) significant += 1;
            } else return error.InvalidValue;
        }
        const fraction = if (dot) |d| s.len - d - 1 else 0;
        if (significant > 34 or fraction > 6176) return error.InvalidValue;
        var n: u128 = 0;
        for (s[start..]) |c| {
            if (c != '.') n = n * 10 + (c - '0');
        }
        if (n >= coefficient_limit) return error.InvalidValue;
        return .{ .coefficient = n, .exponent = -@as(i32, @intCast(fraction)), .negative = neg and n != 0 };
    }

    pub fn fromInt(n: anytype) Decimal {
        return .{ .coefficient = @intCast(if (n < 0) -@as(i128, n) else @as(i128, n)), .negative = n < 0 };
    }

    pub fn fromFloat(f: f64) Error!Decimal {
        if (!std.math.isFinite(f) or @abs(f) >= 1e34) return error.InvalidValue;
        if (f == 0) return .{};
        var buf: [512]u8 = undefined;
        const s = std.fmt.bufPrint(&buf, "{d}", .{f}) catch unreachable;
        if (std.mem.indexOfAny(u8, s, "eE")) |e| {
            const exp = std.fmt.parseInt(i32, s[e + 1 ..], 10) catch return error.InvalidValue;
            var d = try parse(s[0..e]);
            d.exponent += exp;
            while (d.exponent > 0) : (d.exponent -= 1) d.coefficient *= 10;
            return d;
        }
        return parse(s);
    }

    pub fn string(self: Decimal, a: Allocator) ![]u8 {
        var buf: [40]u8 = undefined;
        const digits = std.fmt.bufPrint(&buf, "{d}", .{self.coefficient}) catch unreachable;
        const places: usize = @intCast(-self.exponent);
        const whole = if (digits.len > places) digits.len - places else 1;
        const size = @intFromBool(self.negative) + whole + (if (places > 0) places + 1 else 0);
        const out = try a.alloc(u8, size);
        var pos: usize = 0;
        if (self.negative) {
            out[0] = '-';
            pos = 1;
        }
        if (places == 0) {
            @memcpy(out[pos..], digits);
            return out;
        }
        if (digits.len > places) {
            @memcpy(out[pos..][0..whole], digits[0..whole]);
            pos += whole;
            out[pos] = '.';
            pos += 1;
            @memcpy(out[pos..], digits[whole..]);
        } else {
            out[pos] = '0';
            out[pos + 1] = '.';
            pos += 2;
            const zeros = places - digits.len;
            @memset(out[pos..][0..zeros], '0');
            pos += zeros;
            @memcpy(out[pos..], digits);
        }
        return out;
    }

    pub fn integer(self: Decimal, comptime T: type) Error!T {
        var n = self.coefficient;
        var exp = self.exponent;
        while (exp < 0) : (exp += 1) {
            if (n % 10 != 0) return error.InvalidValue;
            n /= 10;
        }
        const signed: i128 = if (self.negative) -@as(i128, @intCast(n)) else @intCast(n);
        return std.math.cast(T, signed) orelse error.InvalidValue;
    }

    pub fn float(self: Decimal) f64 {
        var buf: [64]u8 = undefined;
        const s = std.fmt.bufPrint(&buf, "{s}{d}e{d}", .{ if (self.negative) "-" else "", self.coefficient, self.exponent }) catch unreachable;
        return std.fmt.parseFloat(f64, s) catch unreachable;
    }

    pub fn negate(self: Decimal) Decimal {
        var d = self;
        d.negative = d.coefficient != 0 and !d.negative;
        return d;
    }

    pub fn order(a: Decimal, b: Decimal) std.math.Order {
        if (a.coefficient == 0 and b.coefficient == 0) return .eq;
        if (a.negative != b.negative) return if (a.negative) .lt else .gt;
        // Compare padded decimal digits, without allocating or scaling a
        // 6176-place coefficient into a bounded machine integer.
        var aa: [40]u8 = undefined;
        var bb: [40]u8 = undefined;
        const x = std.fmt.bufPrint(&aa, "{d}", .{a.coefficient}) catch unreachable;
        const y = std.fmt.bufPrint(&bb, "{d}", .{b.coefficient}) catch unreachable;
        var result: std.math.Order = .eq;
        if (a.coefficient == 0) result = .lt else if (b.coefficient == 0) result = .gt else {
            result = std.math.order(@as(i32, @intCast(x.len)) + a.exponent, @as(i32, @intCast(y.len)) + b.exponent);
            if (result == .eq) {
                for (0..@max(x.len, y.len)) |i| {
                    result = std.math.order(if (i < x.len) x[i] else @as(u8, '0'), if (i < y.len) y[i] else @as(u8, '0'));
                    if (result != .eq) break;
                }
            }
        }
        return if (a.negative) result.invert() else result;
    }
};

fn scale(n: *Big, places: u32) !void {
    if (places == 0) return;
    var ten = try Big.initSet(n.allocator, @as(u8, 10));
    defer ten.deinit();
    var factor = try Big.init(n.allocator);
    defer factor.deinit();
    try factor.pow(&ten, places);
    try n.mul(n, &factor);
}

fn digitCount(n: Big) error{OutOfMemory}!i32 {
    const s = n.toString(n.allocator, 10, .lower) catch |err| return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => unreachable,
    };
    defer n.allocator.free(s);
    return @intCast(s.len - @intFromBool(s[0] == '-'));
}

/// Finish |n/d| * 10^exp. Both integers are positive. Rounding uses the
/// quotient and exact remainder, so ties and subnormals have one rounding.
fn finish(n: *Big, d: *Big, exp: i32, ideal: i32, negative: bool, bounded: bool) Error!Decimal {
    const a = n.allocator;
    if (n.toConst().eqlZero()) return .{ .exponent = std.math.clamp(ideal, -6176, 0) };
    var order = (try digitCount(n.*)) - (try digitCount(d.*));
    var probe = try n.clone();
    defer probe.deinit();
    var divisor = try d.clone();
    defer divisor.deinit();
    if (order >= 0) try scale(&divisor, @intCast(order)) else try scale(&probe, @intCast(-order));
    if (Big.order(probe, divisor) == .lt) order -= 1;
    var target = @max(-6176, exp + order - 33);
    // Anything this large will overflow after rounding too.
    if (bounded and exp + order >= 34) return error.Overflow;
    if (target < exp) try scale(n, @intCast(exp - target)) else try scale(d, @intCast(target - exp));
    var q = try Big.init(a);
    defer q.deinit();
    var r = try Big.init(a);
    defer r.deinit();
    try Big.divTrunc(&q, &r, n, d);
    try r.add(&r, &r);
    const comparison = Big.order(r, d.*);
    if (comparison == .gt or (comparison == .eq and q.isOdd())) try q.addScalar(&q, @as(u8, 1));
    var c = q.toInt(u128) catch return error.Overflow;
    if (c >= coefficient_limit) {
        c /= 10;
        target += 1;
    }
    while (target < (if (bounded) @min(ideal, 0) else ideal) and c % 10 == 0) : (target += 1) c /= 10;
    while (target > @max(ideal, -6176) and c < coefficient_limit / 10) : (target -= 1) c *= 10;
    while (bounded and target > 0) : (target -= 1) {
        if (c >= coefficient_limit / 10) return error.Overflow;
        c *= 10;
    }
    return .{ .coefficient = c, .exponent = target, .negative = negative and c != 0 };
}

pub const Operator = enum { add, subtract, multiply, divide, div, mod };
pub fn calculate(a: Allocator, op: Operator, x: Decimal, y: Decimal) Error!Decimal {
    return calculateInternal(a, op, x, y, true);
}
/// Only for quantity comparison in Base Units: intermediate magnitudes may
/// exceed the Script number range, while retaining the specified precision.
pub fn calculateUnbounded(a: Allocator, op: Operator, x: Decimal, y: Decimal) Error!Decimal {
    return calculateInternal(a, op, x, y, false);
}
fn calculateInternal(a: Allocator, op: Operator, x: Decimal, y: Decimal, bounded: bool) Error!Decimal {
    var n = try Big.initSet(a, x.coefficient);
    defer n.deinit();
    var m = try Big.initSet(a, y.coefficient);
    defer m.deinit();
    var d = try Big.initSet(a, @as(u8, 1));
    defer d.deinit();
    var exp: i32 = undefined;
    var neg = x.negative != y.negative;
    switch (op) {
        .add, .subtract, .mod, .div => {
            exp = @min(x.exponent, y.exponent);
            try scale(&n, @intCast(x.exponent - exp));
            try scale(&m, @intCast(y.exponent - exp));
            if (op == .add or op == .subtract) {
                n.setSign(!x.negative);
                m.setSign(!(y.negative != (op == .subtract)));
                try n.add(&n, &m);
                neg = !n.isPositive();
                n.setSign(true);
            } else {
                if (y.coefficient == 0) return error.DivisionByZero;
                var q = try Big.init(a);
                defer q.deinit();
                var r = try Big.init(a);
                defer r.deinit();
                try Big.divTrunc(&q, &r, &n, &m);
                if (op == .div) {
                    try n.copy(q.toConst());
                    exp = 0;
                } else {
                    try n.copy(r.toConst());
                    neg = x.negative;
                }
            }
        },
        .multiply => {
            exp = x.exponent + y.exponent;
            try n.mul(&n, &m);
        },
        .divide => {
            if (y.coefficient == 0) return error.DivisionByZero;
            exp = x.exponent - y.exponent;
            try d.copy(m.toConst());
        },
    }
    return finish(&n, &d, exp, exp, neg, bounded);
}

pub fn power(a: Allocator, x: Decimal, exponent: i32) Error!Decimal {
    if (exponent == 0) return Decimal.fromInt(@as(i64, 1));
    if (x.coefficient == 0) {
        if (exponent < 0) return error.DivisionByZero;
        return .{ .exponent = @intCast(@max(-6176, @as(i64, x.exponent) * exponent)) };
    }
    const count: u32 = @intCast(@abs(@as(i64, exponent)));
    var base = try Big.initSet(a, x.coefficient);
    defer base.deinit();
    var n = try Big.init(a);
    defer n.deinit();
    var d = try Big.initSet(a, @as(u8, 1));
    defer d.deinit();
    try n.pow(&base, count);
    const exp64 = @as(i64, x.exponent) * count;
    const exp = std.math.cast(i32, exp64) orelse return error.Overflow;
    if (exponent < 0) std.mem.swap(Big, &n, &d);
    return finish(&n, &d, if (exponent < 0) -exp else exp, if (exponent < 0) -exp else exp, x.negative and count % 2 == 1, true);
}

test "input limits and linear rejection before arithmetic" {
    const a = std.testing.allocator;
    const huge = try a.alloc(u8, 1_000_000);
    defer a.free(huge);
    @memset(huge, '9');
    try std.testing.expectError(error.InvalidValue, Decimal.parse(huge));
    for ([_][]const u8{ "", "+1", "1e3", ".5", "1.", "0x", "NaN", "10000000000000000000000000000000000" }) |s| try std.testing.expectError(error.InvalidValue, Decimal.parse(s));
    try std.testing.expectEqualStrings("2.50", tryString(try Decimal.parse("\u{2003}002.50\u{2003}")));
}
// Test helper uses a fixed buffer so the testing allocator can detect all
// temporary arbitrary-precision allocations in the operators.
fn tryString(d: Decimal) []const u8 {
    const Helper = struct {
        var buffer: [6200]u8 = undefined;
    };
    var fba = std.heap.FixedBufferAllocator.init(&Helper.buffer);
    return d.string(fba.allocator()) catch unreachable;
}
test "exact operators, trailing zeros and half-even" {
    const examples = .{
        .{ Operator.add, "0.1", "0.2", "0.3" },
        .{ Operator.multiply, "2.50", "3", "7.50" },
        .{ Operator.divide, "10", "4", "2.5" },
        .{ Operator.divide, "7.50", "3", "2.50" },
        .{ Operator.divide, "1", "0.01", "100" },
        .{ Operator.divide, "1", "3", "0.3333333333333333333333333333333333" },
        .{ Operator.divide, "2", "3", "0.6666666666666666666666666666666667" },
        .{ Operator.mod, "-7.5", "2", "-1.5" },
        .{ Operator.div, "-7.5", "2", "-3" },
    };
    inline for (examples) |ex| {
        const result = try calculate(std.testing.allocator, ex[0], try Decimal.parse(ex[1]), try Decimal.parse(ex[2]));
        try std.testing.expectEqualStrings(ex[3], tryString(result));
    }
    try std.testing.expectEqualStrings("1024", tryString(try power(std.testing.allocator, try Decimal.parse("2"), 10)));
    try std.testing.expectEqualStrings("0.125", tryString(try power(std.testing.allocator, try Decimal.parse("2"), -3)));
    try std.testing.expectError(error.DivisionByZero, calculate(std.testing.allocator, .divide, .{}, .{}));
    try std.testing.expectError(error.Overflow, calculate(std.testing.allocator, .multiply, try Decimal.parse("9999999999999999999999999999999999"), try Decimal.parse("2")));
}

test "half-even at the fraction boundary, size after rounding, conversions" {
    const a = std.testing.allocator;
    const smallest = Decimal{ .coefficient = 1, .exponent = -6176 };
    const even = try calculate(a, .divide, smallest, Decimal.fromInt(@as(i32, 2)));
    try std.testing.expectEqual(@as(u128, 0), even.coefficient);
    try std.testing.expectEqual(@as(i32, -6176), even.exponent);
    const odd = try calculate(a, .divide, .{ .coefficient = 3, .exponent = -6176 }, Decimal.fromInt(@as(i32, 2)));
    try std.testing.expectEqual(@as(u128, 2), odd.coefficient);
    try std.testing.expectError(error.Overflow, calculate(a, .add, try Decimal.parse("9999999999999999999999999999999999"), try Decimal.parse("0.5")));
    try std.testing.expectEqual(@as(i64, std.math.minInt(i64)), (try Decimal.parse("-9223372036854775808.0")).integer(i64));
    try std.testing.expectEqual(@as(u64, std.math.maxInt(u64)), (try Decimal.parse("18446744073709551615")).integer(u64));
    try std.testing.expectError(error.InvalidValue, (try Decimal.parse("1.01")).integer(i64));
    try std.testing.expectError(error.InvalidValue, (try Decimal.parse("-1")).integer(u64));
    try std.testing.expectError(error.InvalidValue, Decimal.fromFloat(std.math.inf(f64)));
    try std.testing.expectError(error.InvalidValue, Decimal.fromFloat(std.math.nan(f64)));
    try std.testing.expectEqualStrings("0.1", tryString(try Decimal.fromFloat(0.1)));
    try std.testing.expectEqualStrings("0", tryString(try Decimal.fromFloat(-0.0)));
    for ([_]f64{ 0.1, 0.3, 1e23, 1e-300, std.math.nextAfter(f64, 1e34, 0), 1.2345678901234567 }) |f| try std.testing.expectEqual(f, (try Decimal.fromFloat(f)).float());
    const fraction = try a.alloc(u8, 6179);
    defer a.free(fraction);
    @memset(fraction, '0');
    fraction[1] = '.';
    fraction[fraction.len - 1] = '1';
    try std.testing.expectError(error.InvalidValue, Decimal.parse(fraction));
}

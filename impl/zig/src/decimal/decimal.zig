//! Chapter 3 decimals. Inputs are counted before arithmetic; operators round
//! their exact rational result once, then choose the nearest ideal exponent.
const std = @import("std");
const utf8 = @import("../unicode/utf8.zig");
const properties = @import("../unicode/properties.zig");
pub const Big = std.math.big.int.Managed;
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidValue, Overflow, DivisionByZero, OutOfDomain, OutOfMemory };
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
pub fn finish(n: *Big, d: *Big, exp: i32, ideal: i32, negative: bool, bounded: bool) Error!Decimal {
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

/// `x ^ y`, which is also `power(x, y)` (chapter 7). An integer `y`, whatever
/// its exponent, gives the exact power rounded once, at the exponent nearest
/// `y` times `x`'s. Any other `y` gives `x ^ y` correctly rounded, with
/// trailing zeros after the point dropped. `OutOfDomain` is a negative `x`
/// with a noninteger `y`; the caller names `x` as the value.
pub fn power(a: Allocator, x: Decimal, y: Decimal) Error!Decimal {
    if (y.integer(i128)) |n| return integerPower(a, x, n) else |_| {}
    if (x.negative) return error.OutOfDomain;
    if (x.coefficient == 0) return if (y.negative) error.DivisionByZero else .{};
    if (try rationalPower(a, x, y)) |exact| return exact;
    return approximatePower(a, x, y, 0, false);
}

/// Past this many factors, a power of a base that isn't a power of ten is
/// approximated. Its exact value then has more than 36 digits, or an endless
/// expansion, so it is neither representable nor a tie.
const exact_power_limit = 200;

/// `x` ^ `n`. Powers of ten are exact at any `n`, and so are other bases up
/// to the limit. Beyond it, overflow and underflow come from magnitudes, so
/// even `n` near 10^34 costs no more than a short approximation.
fn integerPower(a: Allocator, x: Decimal, n: i128) Error!Decimal {
    if (n == 0) return .{ .coefficient = 1 };
    const ideal = n * x.exponent;
    const negative = x.negative and @rem(n, 2) != 0;
    if (x.coefficient == 0) {
        if (n < 0) return error.DivisionByZero;
        return zero(ideal);
    }
    const r = reduce(x);
    if (r.coefficient == 1) return powerOfTen(a, @as(i128, r.exponent) * n, ideal, negative);
    if (@abs(n) <= exact_power_limit) return exactPower(a, r.coefficient, r.exponent, n, ideal, negative);
    return approximatePower(a, .{ .coefficient = r.coefficient, .exponent = r.exponent }, .{ .coefficient = @abs(n), .negative = n < 0 }, ideal, negative);
}

/// `x` without trailing zeros in its coefficient.
pub fn reduce(x: Decimal) Decimal {
    var r = x;
    while (r.coefficient % 10 == 0) : (r.exponent += 1) r.coefficient /= 10;
    return r;
}

/// A zero result, at the representable exponent nearest `ideal`.
fn zero(ideal: i128) Decimal {
    return .{ .exponent = @intCast(std.math.clamp(ideal, -6176, 0)) };
}

/// `finish` behaves the same for any ideal exponent beyond these bounds.
fn clampIdeal(ideal: i128) i32 {
    return @intCast(std.math.clamp(ideal, -6177, 1));
}

/// 10^`e`, exact. At or below 10^-6177 it rounds to zero.
fn powerOfTen(a: Allocator, e: i128, ideal: i128, negative: bool) Error!Decimal {
    if (e >= 34) return error.Overflow;
    if (e <= -6177) return zero(ideal);
    var n = try Big.initSet(a, @as(u8, 1));
    defer n.deinit();
    var d = try Big.initSet(a, @as(u8, 1));
    defer d.deinit();
    return finish(&n, &d, @intCast(e), clampIdeal(ideal), negative, true);
}

/// (`base` * 10^`e`)^`p`, exact and then rounded once, for |`p`| at most
/// `exact_power_limit`. The digit counts settle overflow and underflow first,
/// so `finish` never scales by more than a few thousand digits.
fn exactPower(a: Allocator, base: u128, e: i32, p: i128, ideal: i128, negative: bool) Error!Decimal {
    var b = try Big.initSet(a, base);
    defer b.deinit();
    var n = try Big.init(a);
    defer n.deinit();
    var d = try Big.initSet(a, @as(u8, 1));
    defer d.deinit();
    try n.pow(&b, @intCast(@abs(p)));
    if (p < 0) n.swap(&d);
    const exp = @as(i128, e) * p;
    const digits = @as(i128, try digitCount(n)) - try digitCount(d);
    // n/d lies strictly between 10^(digits-1) and 10^(digits+1).
    if (digits - 1 + exp >= 34) return error.Overflow;
    if (digits + 1 + exp <= -6177) return zero(ideal);
    return finish(&n, &d, @intCast(exp), clampIdeal(ideal), negative, true);
}

/// The exact result of a noninteger power, when there is one: `x` is then
/// r^q for a decimal r and `y` = p/q in lowest terms. Every tie is among
/// these, so the approximation below never has to find one.
fn rationalPower(a: Allocator, x: Decimal, y: Decimal) Error!?Decimal {
    const r = reduce(x);
    const places: u32 = @intCast(-y.exponent);
    const numerator: i128 = if (y.negative) -@as(i128, @intCast(y.coefficient)) else @intCast(y.coefficient);
    if (r.coefficient == 1) {
        // 10^(e*y) is exact when e*y is an integer, and irrational otherwise.
        const e = @as(i128, r.exponent) * numerator;
        if (e == 0) return try powerOfTen(a, 0, 0, false);
        if (places > 38) return null;
        const scale_by = std.math.powi(i128, 10, places) catch unreachable;
        if (@rem(e, scale_by) != 0) return null;
        return try powerOfTen(a, @divExact(e, scale_by), 0, false);
    }
    // r^q is below 2^113 for an integer r of 2 or more, so q is at most 112.
    // A denominator 10^38 or more leaves q above 10^4 after any common factor.
    if (places > 37) return null;
    const denominator = std.math.powi(u128, 10, places) catch unreachable;
    const common = std.math.gcd(y.coefficient, denominator);
    const q = denominator / common;
    if (q > 112) return null;
    const p = @divExact(numerator, @as(i128, @intCast(common)));
    if (@rem(r.exponent, @as(i32, @intCast(q))) != 0) return null;
    const root = integerRoot(r.coefficient, @intCast(q)) orelse return null;
    // Beyond the limit r^p has more than 36 digits, or an endless expansion,
    // so it is neither exact nor a tie, and the approximation settles it.
    if (@abs(p) > exact_power_limit) return null;
    return try exactPower(a, root, @divExact(r.exponent, @as(i32, @intCast(q))), p, 0, false);
}

/// The integer r with r^q = `c`, if there is one.
fn integerRoot(c: u128, q: u32) ?u128 {
    var lo: u128 = 1;
    var hi: u128 = @as(u128, 1) << @intCast(113 / q + 1);
    while (lo <= hi) {
        const mid = lo + (hi - lo) / 2;
        var acc: u128 = 1;
        var over = false;
        for (0..q) |_| {
            acc = std.math.mul(u128, acc, mid) catch {
                over = true;
                break;
            };
            if (acc > c) {
                over = true;
                break;
            }
        }
        if (!over and acc == c) return mid;
        if (over) hi = mid - 1 else lo = mid + 1;
    }
    return null;
}

/// Bits of relative precision the bounds aim for: 34 digits are under 113.
const target_bits = 128;
/// Extra bits, doubled on each refinement. At the last, a refinement costs
/// about a quarter of a second, and the bounds could still disagree only for
/// a result within a relative 2^-16000 of a tie that isn't one (exact ties
/// are found beforehand). None is known; the lower bound's rounding is taken.
const first_guard = 64;
const last_guard = 64 << 8;

/// `x` ^ `y` for positive `x`, as e^(y ln x), by Ziv's method: bound the
/// result between two dyadic rationals, round both, and refine until they
/// round alike. Rounding is monotonic, so the result between rounds alike
/// too. The caller has excluded exact ties. Every step works in fixed point
/// with `p` fraction bits and carries a proven bound on its error in units of
/// 2^-p (ulps).
fn approximatePower(a: Allocator, x: Decimal, y: Decimal, ideal: i128, negative: bool) Error!Decimal {
    // |y| < 2^y_bits: the error in ln x grows by |y| in y ln x.
    const y_bits: usize = @intCast(@max(0, @as(i64, 128 - @clz(y.coefficient)) - @divFloor(@as(i64, -y.exponent) * 33219, 10000)));
    var guard: usize = first_guard;
    while (true) : (guard *= 2) {
        const p = target_bits + y_bits + guard;
        var ln = try Logarithm.init(a, x, p);
        defer ln.deinit();

        // t = y ln x, with error |y| errL + 1, from truncation.
        var t = try Big.initSet(a, y.coefficient);
        defer t.deinit();
        try t.mul(&t, &ln.value);
        var t_err = try Big.initSet(a, y.coefficient);
        defer t_err.deinit();
        try t_err.mul(&t_err, &ln.err);
        if (y.exponent < 0) {
            var ten = try Big.initSet(a, @as(u8, 10));
            defer ten.deinit();
            var divisor = try Big.init(a);
            defer divisor.deinit();
            try divisor.pow(&ten, @intCast(-y.exponent));
            var rem = try Big.init(a);
            defer rem.deinit();
            var q = try Big.init(a);
            defer q.deinit();
            try Big.divTrunc(&q, &rem, &t, &divisor);
            t.swap(&q);
            try Big.divTrunc(&q, &rem, &t_err, &divisor);
            t_err.swap(&q);
        }
        if (y.negative) t.negate();
        try t_err.addScalar(&t_err, @as(u8, 2));

        // e^79 > 10^34 overflows. e^-14227 < 10^-6178 rounds to zero.
        var bound = try Big.initSet(a, @as(u8, 79));
        defer bound.deinit();
        try bound.shiftLeft(&bound, p);
        var edge = try Big.init(a);
        defer edge.deinit();
        try edge.sub(&t, &t_err);
        if (Big.order(edge, bound) != .lt) return error.Overflow;
        try bound.set(@as(i16, -14227));
        try bound.shiftLeft(&bound, p);
        try edge.add(&t, &t_err);
        if (Big.order(edge, bound) != .gt) return zero(ideal);

        // t = k ln 2 + r, |r| <= ln 2 / 2. e^t = 2^k e^r.
        var half = try Big.init(a);
        defer half.deinit();
        try half.shiftRight(&ln.ln2, 1);
        try half.add(&half, &t);
        var k_big = try Big.init(a);
        defer k_big.deinit();
        var r = try Big.init(a);
        defer r.deinit();
        try Big.divFloor(&k_big, &r, &half, &ln.ln2);
        // |t| < 14227 here, so |k| < 20526.
        const k = k_big.toInt(i32) catch unreachable;
        try r.mul(&k_big, &ln.ln2);
        try r.sub(&t, &r);
        var r_err = try Big.initSet(a, @as(u64, @abs(k)) * ln.ln2_err);
        defer r_err.deinit();
        try r_err.add(&r_err, &t_err);
        // The error term for e^r below needs r's error well under 1.
        if (r_err.toConst().bitCountAbs() + 8 >= p) continue;

        var e = try exponential(a, &r, p);
        defer e.value.deinit();
        // |e^r' - e^r| <= e^0.36 |r' - r| < 2 r_err.
        try r_err.shiftLeft(&r_err, 1);
        try r_err.addScalar(&r_err, e.err);
        var lo = try Big.init(a);
        defer lo.deinit();
        try lo.sub(&e.value, &r_err);
        var hi = try Big.init(a);
        defer hi.deinit();
        try hi.add(&e.value, &r_err);
        if (!lo.isPositive() or lo.eqlZero()) continue;

        const low = try roundBound(a, &lo, k, p, ideal, negative);
        const high = try roundBound(a, &hi, k, p, ideal, negative);
        if (low == null and high == null) return error.Overflow;
        if (low != null and high != null and std.meta.eql(low.?, high.?)) return low.?;
        if (guard >= last_guard) return low orelse error.Overflow;
    }
}

/// Rounds `m` * 2^`k` * 2^-`p`, or null when that overflows.
fn roundBound(a: Allocator, m: *const Big, k: i32, p: usize, ideal: i128, negative: bool) Error!?Decimal {
    var n = try Big.init(a);
    defer n.deinit();
    try n.shiftLeft(m, @intCast(@max(k, 0)));
    var d = try Big.initSet(a, @as(u8, 1));
    defer d.deinit();
    try d.shiftLeft(&d, p + @as(usize, @intCast(@max(-k, 0))));
    return finish(&n, &d, 0, clampIdeal(ideal), negative, true) catch |err| switch (err) {
        error.Overflow => null,
        else => err,
    };
}

/// ln x, ln 2, and their error bounds, in fixed point with `p` fraction bits.
pub const Logarithm = struct {
    value: Big,
    err: Big,
    ln2: Big,
    ln2_err: u64,

    /// x = m 2^k 10^e with 1 <= m < 2, so ln x = ln m + k ln 2 + e ln 10,
    /// where ln 10 = 3 ln 2 + ln 1.25. Each logarithm is 2 atanh((m-1)/(m+1)),
    /// whose argument is below 1/3.
    pub fn init(a: Allocator, x: Decimal, p: usize) Error!Logarithm {
        const k: u7 = @intCast(127 - @clz(x.coefficient));
        const low = @as(u128, 1) << k;
        var ln2 = try logOfRatio(a, 1, 3, p);
        errdefer ln2.value.deinit();
        var ln10 = try logOfRatio(a, 1, 9, p);
        defer ln10.value.deinit();
        var lnm = try logOfRatio(a, x.coefficient - low, x.coefficient + low, p);
        defer lnm.value.deinit();
        var scaled = try Big.initSet(a, @as(u8, 3));
        defer scaled.deinit();
        try scaled.mul(&scaled, &ln2.value);
        try ln10.value.add(&ln10.value, &scaled);
        const ln10_err = 3 * ln2.err + ln10.err;

        var value = try Big.initSet(a, k);
        errdefer value.deinit();
        try value.mul(&value, &ln2.value);
        try value.add(&value, &lnm.value);
        try scaled.set(x.exponent);
        try scaled.mul(&scaled, &ln10.value);
        try value.add(&value, &scaled);
        const err = try Big.initSet(a, lnm.err + @as(u64, k) * ln2.err + @as(u64, @abs(x.exponent)) * ln10_err);
        return .{ .value = value, .err = err, .ln2 = ln2.value, .ln2_err = ln2.err };
    }

    fn deinit(self: *Logarithm) void {
        self.value.deinit();
        self.err.deinit();
        self.ln2.deinit();
    }
};

pub const Approximation = struct { value: Big, err: u64 };

/// 2 atanh(`num`/`den`) = ln((den+num)/(den-num)), for 0 <= num/den <= 1/3,
/// as z + z^3/3 + z^5/5 + ... Each computed power of z stays within 2 ulps,
/// since z^2 < 1/9 shrinks the error it carries, so each term adds at most
/// 3 ulps; the tail past the last nonzero power adds at most 3 more.
pub fn logOfRatio(a: Allocator, num: u128, den: u128, p: usize) Error!Approximation {
    var z = try Big.initSet(a, num);
    defer z.deinit();
    try z.shiftLeft(&z, p);
    var divisor = try Big.initSet(a, den);
    defer divisor.deinit();
    var q = try Big.init(a);
    defer q.deinit();
    var rem = try Big.init(a);
    defer rem.deinit();
    try Big.divTrunc(&q, &rem, &z, &divisor);
    z.swap(&q);
    var z2 = try Big.init(a);
    defer z2.deinit();
    try z2.mul(&z, &z);
    try z2.shiftRight(&z2, p);
    var sum = try Big.init(a);
    errdefer sum.deinit();
    var terms: u64 = 0;
    while (!z.eqlZero()) : (terms += 1) {
        try divisor.set(2 * terms + 1);
        try Big.divTrunc(&q, &rem, &z, &divisor);
        try sum.add(&sum, &q);
        try z.mul(&z, &z2);
        try z.shiftRight(&z, p);
    }
    try sum.shiftLeft(&sum, 1);
    return .{ .value = sum, .err = 2 * (3 * terms + 3) };
}

/// e^r for |r| <= 0.36, ignoring the error in `r` itself, as 1 + r + r^2/2!
/// + ... Each computed term stays within 2 ulps, since |r|/j < 1/2 shrinks
/// the error it carries; the tail past the last nonzero term adds at most 4.
fn exponential(a: Allocator, r: *const Big, p: usize) Error!Approximation {
    var sum = try Big.initSet(a, @as(u8, 1));
    errdefer sum.deinit();
    try sum.shiftLeft(&sum, p);
    var term = try sum.clone();
    defer term.deinit();
    var divisor = try Big.init(a);
    defer divisor.deinit();
    var q = try Big.init(a);
    defer q.deinit();
    var rem = try Big.init(a);
    defer rem.deinit();
    var terms: u64 = 1;
    while (true) : (terms += 1) {
        try term.mul(&term, r);
        try term.shiftRight(&term, p);
        try divisor.set(terms);
        try Big.divTrunc(&q, &rem, &term, &divisor);
        term.swap(&q);
        if (term.eqlZero()) break;
        try sum.add(&sum, &term);
    }
    return .{ .value = sum, .err = 2 * terms + 4 };
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

fn expectPower(expected: []const u8, x: []const u8, y: []const u8) !void {
    const result = try power(std.testing.allocator, try Decimal.parse(x), try Decimal.parse(y));
    try std.testing.expectEqualStrings(expected, tryString(result));
}

test "integer powers: exact, at the ideal exponent, and beyond 32 bits" {
    const a = std.testing.allocator;
    const examples = .{
        .{ "1024", "2", "10" },
        .{ "0.125", "2", "-3" },
        .{ "6.2500", "2.50", "2" },
        .{ "6.2500", "2.50", "2.0" },
        .{ "0.000729000000", "0.30", "6" },
        .{ "-8", "-2", "3" },
        .{ "1", "0", "0" },
        .{ "1", "2.50", "0" },
        .{ "0.000000", "0.00", "3" },
        // One rounding of 1/x^2, then the ideal exponent drops a zero.
        .{ "0.00000000000000000000000000000000000000000000000000000000000000141120702278906548369082988329103", "26619790638836058291578488305659", "-2" },
        // Past the exact limit: approximated, but still one rounding.
        .{ "6848746554171001272653397.900183052", "1.1", "600" },
        .{ "0.0000000000000000000000000000000000000000000000000000000000003111507638930570853572032026890062", "0.5", "201" },
        .{ "1.000000000000000000000000000000000", "1.00", "5000000000" },
        .{ "-1", "-1", "5000000001" },
        .{ "22026.46579480671651695790064528411", "1.000000000000000000000000000000001", "9999999999999999999999999999999999" },
        .{ "-22026.46579480671651695790064528411", "-1.000000000000000000000000000000001", "9999999999999999999999999999999999" },
    };
    inline for (examples) |ex| try expectPower(ex[0], ex[1], ex[2]);
    try std.testing.expectError(error.DivisionByZero, power(a, .{}, try Decimal.parse("-1")));
    try std.testing.expectError(error.DivisionByZero, power(a, .{}, try Decimal.parse("-5000000000")));
    try std.testing.expectError(error.Overflow, power(a, try Decimal.parse("2"), try Decimal.parse("5000000000")));
    try std.testing.expectError(error.Overflow, power(a, try Decimal.parse("0.5"), try Decimal.parse("-9999999999999999999999999999999999")));
    // Too small to keep: zero, at the representable exponent nearest the ideal.
    for ([_][2][]const u8{ .{ "0.5", "5000000000" }, .{ "0.1", "7000" }, .{ "0.00", "5000000000" } }) |ex| {
        const tiny = try power(a, try Decimal.parse(ex[0]), try Decimal.parse(ex[1]));
        try std.testing.expectEqual(Decimal{ .exponent = -6176 }, tiny);
    }
}

test "noninteger powers are correctly rounded, with trailing zeros dropped" {
    const a = std.testing.allocator;
    const examples = .{
        .{ "1.414213562373095048801688724209698", "2", "0.5" },
        .{ "9772372209558106826970760069615612", "10", "33.99" },
        .{ "1.999999999861370563892815468255625", "8", "0.3333333333" },
        .{ "9999999999999999999999999999999770", "10", "33.99999999999999999999999999999999" },
        .{ "2.71828182845904523536028747135266", "1.000000000000000000000000000000001", "999999999999999999999999999999999.5" },
        // Exact results.
        .{ "2", "4.00", "0.5" },
        .{ "8", "0.25", "-1.5" },
        .{ "1.728", "1.44", "1.5" },
        .{ "8", "16", "0.75" },
        .{ "1", "1.00", "-0.5" },
        .{ "0", "0", "0.5" },
        // Exact ties, rounded half-even: x = (A / 10^12)^2 and A^3 has 35 digits.
        .{ "0.02700000000135000000002250000000012", "0.090000000003000000000025", "1.5" },
        .{ "0.02700000000405000000020250000000338", "0.090000000009000000000225", "1.5" },
        // Too small to keep, and settled from the magnitude alone.
        .{ "0", "10", "-6176.5" },
        .{ "0", "0.5", "999999999999999999999999999999999.5" },
    };
    inline for (examples) |ex| try expectPower(ex[0], ex[1], ex[2]);
    var smallest = Decimal{ .coefficient = 1, .exponent = -6176 };
    try std.testing.expectEqual(Decimal{ .coefficient = 1, .exponent = -3088 }, try power(a, smallest, try Decimal.parse("0.5")));
    smallest.coefficient = 9999999999999999999999999999999999;
    try std.testing.expectError(error.Overflow, power(a, smallest, try Decimal.parse("-0.5")));
    try std.testing.expectError(error.OutOfDomain, power(a, try Decimal.parse("-8"), try Decimal.parse("0.5")));
    try std.testing.expectError(error.DivisionByZero, power(a, .{}, try Decimal.parse("-0.5")));
    try std.testing.expectError(error.Overflow, power(a, try Decimal.parse("10"), try Decimal.parse("34.001")));
    try std.testing.expectError(error.Overflow, power(a, try Decimal.parse("2"), try Decimal.parse("999999999999999999999999999999999.5")));
}

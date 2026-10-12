//! The correctly rounded Built-ins of chapter 7 (Numbers): `exp`, `ln`,
//! `log10` and the trigonometric functions, each the exact value rounded
//! half-even to 34 significant digits with trailing zeros after the point
//! dropped. `sqrt` and `power` are `decimal.power`'s.
//!
//! Every value is an interval [lo, hi] in fixed point with `p` fraction bits
//! that holds the exact value: each operation rounds its lower bound down
//! and its upper bound up, and each series adds a bound on its tail. By
//! Ziv's method, an attempt rounds both bounds and, if they round alike,
//! that is the result, since rounding is monotonic; otherwise it retries
//! with twice the guard bits. Exact results (`exp(0)`, `ln(1)`, a power of
//! ten's `log10`, `sin(0)` and the like) are found first, and no other
//! result of these functions at a decimal argument is a tie.
const std = @import("std");
const decimal = @import("decimal.zig");
const Allocator = std.mem.Allocator;
const Big = decimal.Big;
const Decimal = decimal.Decimal;

pub const Error = decimal.Error;

pub const Function = enum { exp, ln, log10, sin, cos, tan, asin, acos, atan };

/// Bits of relative precision the bounds aim for, beyond the argument's
/// own integer bits; guard bits double from the first to the last attempt.
const target_bits = 128;
const first_guard = 64;
const last_guard = 64 << 8;

/// `f(x)`, correctly rounded. `error.OutOfDomain` outside its domain, and
/// `error.Overflow` for a result of 10^34 or more in magnitude.
pub fn call(gpa: Allocator, f: Function, x: Decimal) Error!Decimal {
    if (try exactly(f, x)) |r| return r;
    const extra = integerBits(x);
    var guard: usize = first_guard;
    while (true) : (guard *= 2) {
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        const c: Ctx = .{ .a = arena.allocator(), .p = target_bits + extra + guard };
        const attempt = try c.evaluate(f, x);
        if (try c.rounded(attempt, guard >= last_guard)) |r| return r;
    }
}

/// `atan2(y, x)`: the angle of (x, y), above -pi and at most pi.
pub fn atan2(gpa: Allocator, y: Decimal, x: Decimal) Error!Decimal {
    if (y.coefficient == 0) {
        if (x.coefficient == 0) return error.OutOfDomain;
        if (!x.negative) return .{};
    }
    const extra = @max(integerBits(x), integerBits(y));
    var guard: usize = first_guard;
    while (true) : (guard *= 2) {
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        const c: Ctx = .{ .a = arena.allocator(), .p = target_bits + 2 * extra + guard };
        const attempt = try c.angle(y, x);
        if (try c.rounded(attempt, guard >= last_guard)) |r| return r;
    }
}

/// The results that are exact, and the domain errors.
fn exactly(f: Function, x: Decimal) Error!?Decimal {
    const zero = x.coefficient == 0;
    const one: Decimal = .{ .coefficient = 1 };
    const unit = x.coefficient != 0 and decimal.reduce(x).coefficient == 1 and decimal.reduce(x).exponent == 0;
    switch (f) {
        .exp => if (zero) return one,
        .ln, .log10 => {
            if (zero or x.negative) return error.OutOfDomain;
            if (unit) return .{};
            if (f == .log10) {
                // 10^e is exact; any other number's logarithm is irrational.
                const r = decimal.reduce(x);
                if (r.coefficient == 1) return Decimal.fromInt(r.exponent);
            }
        },
        .sin, .tan, .atan => if (zero) return .{},
        .cos => if (zero) return one,
        .asin, .acos => {
            if (x.order(one) == .gt or x.order(one.negate()) == .lt) return error.OutOfDomain;
            if (f == .asin and zero) return .{};
            if (f == .acos and unit and !x.negative) return .{};
        },
    }
    return null;
}

/// The bits of `x`'s integer part, which argument reduction needs as well.
fn integerBits(x: Decimal) usize {
    const digits: i64 = @intCast(std.fmt.count("{d}", .{x.coefficient}));
    const integer = digits + x.exponent;
    if (integer <= 0) return 0;
    return @intCast(@divFloor(integer * 3322, 1000) + 1);
}

const Interval = struct { lo: Big, hi: Big };

/// A result interval and the power of two it is scaled by.
const Attempt = struct { value: Interval, scale: i64 = 0 };

const Ctx = struct {
    a: Allocator,
    p: usize,

    fn big(c: Ctx, v: anytype) !Big {
        return Big.initSet(c.a, v);
    }

    fn copy(c: Ctx, v: Big) !Big {
        _ = c;
        return v.clone();
    }

    fn point(c: Ctx, v: Big) !Interval {
        return .{ .lo = try c.copy(v), .hi = try c.copy(v) };
    }

    /// The integer `n` as an interval.
    fn int(c: Ctx, n: i64) !Interval {
        var v = try c.big(n);
        try v.shiftLeft(&v, c.p);
        return c.point(v);
    }

    fn floorDiv(c: Ctx, x: Big, d: Big) !Big {
        var q = try Big.init(c.a);
        var r = try Big.init(c.a);
        try Big.divFloor(&q, &r, &x, &d);
        return q;
    }

    fn ceilDiv(c: Ctx, x: Big, d: Big) !Big {
        var n = try c.copy(x);
        n.negate();
        var q = try c.floorDiv(n, d);
        q.negate();
        return q;
    }

    fn floorShr(c: Ctx, x: Big, s: usize) !Big {
        var r = try Big.init(c.a);
        try r.shiftRight(&x, s);
        return r;
    }

    fn ceilShr(c: Ctx, x: Big, s: usize) !Big {
        var n = try c.copy(x);
        n.negate();
        var r = try c.floorShr(n, s);
        r.negate();
        return r;
    }

    /// A decimal as an interval: num * 2^p / 10^-e, rounded outward.
    fn decimalValue(c: Ctx, d: Decimal) !Interval {
        var num = try c.big(d.coefficient);
        try num.shiftLeft(&num, c.p);
        if (d.negative) num.negate();
        var den = try c.big(@as(u8, 1));
        if (d.exponent < 0) {
            var ten = try c.big(@as(u8, 10));
            try den.pow(&ten, @intCast(-d.exponent));
        } else if (d.exponent > 0) {
            var ten = try c.big(@as(u8, 10));
            var f = try Big.init(c.a);
            try f.pow(&ten, @intCast(d.exponent));
            try num.mul(&num, &f);
        }
        return .{ .lo = try c.floorDiv(num, den), .hi = try c.ceilDiv(num, den) };
    }

    fn add(c: Ctx, x: Interval, y: Interval) !Interval {
        var lo = try Big.init(c.a);
        try lo.add(&x.lo, &y.lo);
        var hi = try Big.init(c.a);
        try hi.add(&x.hi, &y.hi);
        return .{ .lo = lo, .hi = hi };
    }

    fn neg(c: Ctx, x: Interval) !Interval {
        var lo = try c.copy(x.hi);
        lo.negate();
        var hi = try c.copy(x.lo);
        hi.negate();
        return .{ .lo = lo, .hi = hi };
    }

    fn sub(c: Ctx, x: Interval, y: Interval) !Interval {
        return c.add(x, try c.neg(y));
    }

    /// The least and greatest of four exact values.
    fn extremes(products: [4]Big) struct { Big, Big } {
        var low = products[0];
        var high = products[0];
        for (products[1..]) |v| {
            if (Big.order(v, low) == .lt) low = v;
            if (Big.order(v, high) == .gt) high = v;
        }
        return .{ low, high };
    }

    fn mul(c: Ctx, x: Interval, y: Interval) !Interval {
        var products: [4]Big = undefined;
        for ([_]Big{ x.lo, x.lo, x.hi, x.hi }, [_]Big{ y.lo, y.hi, y.lo, y.hi }, &products) |l, r, *out| {
            out.* = try Big.init(c.a);
            try out.mul(&l, &r);
        }
        const low, const high = extremes(products);
        return .{ .lo = try c.floorShr(low, c.p), .hi = try c.ceilShr(high, c.p) };
    }

    /// `x` / `y`, for an interval `y` that doesn't hold zero.
    fn div(c: Ctx, x: Interval, y: Interval) !Interval {
        var lows: [4]Big = undefined;
        var highs: [4]Big = undefined;
        var i: usize = 0;
        for ([_]Big{ x.lo, x.hi }) |n| for ([_]Big{ y.lo, y.hi }) |d| {
            var scaled = try c.copy(n);
            try scaled.shiftLeft(&scaled, c.p);
            var den = try c.copy(d);
            // divFloor wants a positive divisor.
            if (!den.isPositive()) {
                den.negate();
                scaled.negate();
            }
            lows[i] = try c.floorDiv(scaled, den);
            highs[i] = try c.ceilDiv(scaled, den);
            i += 1;
        };
        const low, _ = extremes(lows);
        _, const high = extremes(highs);
        return .{ .lo = low, .hi = high };
    }

    fn divInt(c: Ctx, x: Interval, n: u64) !Interval {
        const d = try c.big(n);
        return .{ .lo = try c.floorDiv(x.lo, d), .hi = try c.ceilDiv(x.hi, d) };
    }

    fn mulBig(c: Ctx, x: Interval, k: Big) !Interval {
        var lo = try Big.init(c.a);
        try lo.mul(&x.lo, &k);
        var hi = try Big.init(c.a);
        try hi.mul(&x.hi, &k);
        if (!k.isPositive() and !k.eqlZero()) return .{ .lo = hi, .hi = lo };
        return .{ .lo = lo, .hi = hi };
    }

    /// The square root of an interval that is at least zero.
    fn sqrt(c: Ctx, x: Interval) !Interval {
        var lo = try c.copy(x.lo);
        // A lower bound below zero only widens the result's.
        if (!lo.isPositive()) try lo.set(@as(u8, 0));
        try lo.shiftLeft(&lo, c.p);
        var r = try Big.init(c.a);
        r.sqrt(&lo) catch return error.OutOfMemory;
        var hi = try c.copy(x.hi);
        if (!hi.isPositive()) try hi.set(@as(u8, 0));
        try hi.shiftLeft(&hi, c.p);
        var s = try Big.init(c.a);
        s.sqrt(&hi) catch return error.OutOfMemory;
        try s.addScalar(&s, @as(u8, 1));
        return .{ .lo = r, .hi = s };
    }

    fn widen(c: Ctx, x: Interval, ulps: u64) !Interval {
        var lo = try c.copy(x.lo);
        try lo.addScalar(&lo, -@as(i64, @intCast(ulps)));
        var hi = try c.copy(x.hi);
        try hi.addScalar(&hi, ulps);
        return .{ .lo = lo, .hi = hi };
    }

    /// Whether every value of `x` is at most one ulp in magnitude.
    fn tiny(c: Ctx, x: Interval) !bool {
        const one = try c.big(@as(u8, 1));
        var neg_one = try c.big(@as(i8, -1));
        _ = &neg_one;
        return Big.order(x.hi, one) != .gt and Big.order(x.lo, neg_one) != .lt;
    }

    fn positive(x: Interval) bool {
        return x.lo.isPositive() and !x.lo.eqlZero();
    }

    fn negative(x: Interval) bool {
        return !x.hi.isPositive() and !x.hi.eqlZero();
    }

    // ------------------------------------------------------------ series

    /// sin r for |r| < 0.8: r - r^3/3! + r^5/5! - ..., each term the last
    /// times -r^2/((2k)(2k+1)), until a term is within an ulp; the terms
    /// fall by more than half each, so the tail is within two.
    fn sinSeries(c: Ctx, r: Interval) !Interval {
        const r2 = try c.mul(r, r);
        var sum = r;
        var term = r;
        var k: u64 = 1;
        while (!try c.tiny(term)) : (k += 1) {
            term = try c.neg(try c.divInt(try c.mul(term, r2), (2 * k) * (2 * k + 1)));
            sum = try c.add(sum, term);
        }
        return c.widen(sum, 2);
    }

    /// cos r for |r| < 0.8: 1 - r^2/2! + r^4/4! - ...
    fn cosSeries(c: Ctx, r: Interval) !Interval {
        const r2 = try c.mul(r, r);
        var sum = try c.int(1);
        var term = sum;
        var k: u64 = 1;
        while (!try c.tiny(term)) : (k += 1) {
            term = try c.neg(try c.divInt(try c.mul(term, r2), (2 * k - 1) * (2 * k)));
            sum = try c.add(sum, term);
        }
        return c.widen(sum, 2);
    }

    /// atan r for |r| < 0.25: r - r^3/3 + r^5/5 - ...
    fn atanSeries(c: Ctx, r: Interval) !Interval {
        const r2 = try c.mul(r, r);
        var sum = r;
        var power = r;
        var k: u64 = 1;
        while (true) : (k += 1) {
            power = try c.neg(try c.mul(power, r2));
            const term = try c.divInt(power, 2 * k + 1);
            if (try c.tiny(term)) break;
            sum = try c.add(sum, term);
        }
        return c.widen(sum, 2);
    }

    /// e^r for |r| < 0.36: 1 + r + r^2/2! + ...
    fn expSeries(c: Ctx, r: Interval) !Interval {
        var sum = try c.int(1);
        var term = sum;
        var k: u64 = 1;
        while (!try c.tiny(term)) : (k += 1) {
            term = try c.divInt(try c.mul(term, r), k);
            sum = try c.add(sum, term);
        }
        return c.widen(sum, 2);
    }

    /// atan(1/n) for an integer n of 5 or more, by its series.
    fn atanInverse(c: Ctx, n: u64) !Interval {
        var power = try c.divInt(try c.int(1), n);
        var sum = power;
        var k: u64 = 1;
        while (true) : (k += 1) {
            power = try c.neg(try c.divInt(power, n * n));
            const term = try c.divInt(power, 2 * k + 1);
            if (try c.tiny(term)) break;
            sum = try c.add(sum, term);
        }
        return c.widen(sum, 2);
    }

    /// pi = 16 atan(1/5) - 4 atan(1/239) (Machin).
    fn pi(c: Ctx) !Interval {
        const four = try c.big(@as(u8, 4));
        const sixteen = try c.big(@as(u8, 16));
        return c.sub(try c.mulBig(try c.atanInverse(5), sixteen), try c.mulBig(try c.atanInverse(239), four));
    }

    fn fromApproximation(c: Ctx, value: Big, err: Big) !Interval {
        var lo = try Big.init(c.a);
        try lo.sub(&value, &err);
        var hi = try Big.init(c.a);
        try hi.add(&value, &err);
        return .{ .lo = lo, .hi = hi };
    }

    fn ln(c: Ctx, x: Decimal) !Interval {
        const l = try decimal.Logarithm.init(c.a, x, c.p);
        return c.fromApproximation(l.value, l.err);
    }

    fn ln2(c: Ctx) !Interval {
        const l = try decimal.logOfRatio(c.a, 1, 3, c.p);
        return c.fromApproximation(l.value, try c.big(l.err));
    }

    // ------------------------------------------------------------ functions

    fn evaluate(c: Ctx, f: Function, x: Decimal) !Attempt {
        return switch (f) {
            .exp => c.exp(x),
            .ln => .{ .value = try c.ln(x) },
            .log10 => .{ .value = try c.div(try c.ln(x), try c.ln(Decimal.fromInt(10))) },
            .sin, .cos, .tan => .{ .value = try c.trig(f, x) },
            .atan => .{ .value = try c.atan(try c.decimalValue(x)) },
            .asin => .{ .value = try c.asin(x) },
            .acos => .{ .value = try c.sub(try c.divInt(try c.pi(), 2), try c.asin(x)) },
        };
    }

    /// e^x = 2^k e^r, with r = x - k ln 2 and |r| about ln 2 / 2 at most.
    fn exp(c: Ctx, x: Decimal) !Attempt {
        // e^79 > 10^34 overflows; e^-14228 < 10^-6179 rounds to zero.
        if (x.order(Decimal.fromInt(79)) != .lt) return error.Overflow;
        if (x.order(Decimal.fromInt(-14228)) != .gt) return .{ .value = try c.int(0) };
        const xi = try c.decimalValue(x);
        const l2 = try c.ln2();
        var shifted = try c.copy(xi.lo);
        var half = try c.floorShr(l2.lo, 1);
        _ = &half;
        try shifted.add(&shifted, &half);
        const k = try c.floorDiv(shifted, l2.lo);
        const r = try c.sub(xi, try c.mulBig(l2, k));
        return .{ .value = try c.expSeries(r), .scale = k.toInt(i64) catch unreachable };
    }

    /// sin, cos or tan of x = k pi/2 + r, with r near the reduced range.
    fn trig(c: Ctx, f: Function, x: Decimal) !Interval {
        const xi = try c.decimalValue(x);
        const half_pi = try c.divInt(try c.pi(), 2);
        var shifted = try c.copy(xi.lo);
        const quarter = try c.floorShr(half_pi.lo, 1);
        try shifted.add(&shifted, &quarter);
        const k = try c.floorDiv(shifted, half_pi.lo);
        const r = try c.sub(xi, try c.mulBig(half_pi, k));
        var four = try c.big(@as(u8, 4));
        var q = try Big.init(c.a);
        var m = try Big.init(c.a);
        try Big.divFloor(&q, &m, &k, &four);
        const quadrant = m.toInt(u2) catch unreachable;
        const s = try c.sinSeries(r);
        const co = try c.cosSeries(r);
        // sin(r + k pi/2) and cos(r + k pi/2) by k mod 4.
        const sin_x = switch (quadrant) {
            0 => s,
            1 => co,
            2 => try c.neg(s),
            3 => try c.neg(co),
        };
        const cos_x = switch (quadrant) {
            0 => co,
            1 => try c.neg(s),
            2 => try c.neg(co),
            3 => s,
        };
        return switch (f) {
            .sin => sin_x,
            .cos => cos_x,
            else => {
                if (!positive(cos_x) and !negative(cos_x)) return c.widen(try c.int(0), std.math.maxInt(u32));
                return c.div(sin_x, cos_x);
            },
        };
    }

    /// atan t: past 1 in magnitude, as ±pi/2 - atan(1/t); then halved twice
    /// by atan t = 2 atan(t / (1 + sqrt(1 + t^2))) into the series' range.
    fn atan(c: Ctx, t: Interval) !Interval {
        const one = try c.int(1);
        const above = Big.order(t.lo, one.lo) == .gt;
        const below = blk: {
            var neg_one = try c.copy(one.lo);
            neg_one.negate();
            break :blk Big.order(t.hi, neg_one) == .lt;
        };
        var y = if (above or below) try c.div(one, t) else t;
        for (0..2) |_| {
            const root = try c.sqrt(try c.add(one, try c.mul(y, y)));
            y = try c.div(y, try c.add(one, root));
        }
        const four = try c.big(@as(u8, 4));
        const core = try c.mulBig(try c.atanSeries(y), four);
        if (!above and !below) return core;
        const half_pi = try c.divInt(try c.pi(), 2);
        return if (above) c.sub(half_pi, core) else c.sub(try c.neg(half_pi), core);
    }

    /// asin x = atan(x / sqrt(1 - x^2)), and ±pi/2 at ±1.
    fn asin(c: Ctx, x: Decimal) !Interval {
        const one = Decimal.fromInt(1);
        if (x.order(one) == .eq) return c.divInt(try c.pi(), 2);
        if (x.order(one.negate()) == .eq) return c.neg(try c.divInt(try c.pi(), 2));
        if (x.coefficient == 0) return c.int(0);
        const xi = try c.decimalValue(x);
        const rest = try c.sub(try c.int(1), try c.mul(xi, xi));
        // So near 1 that the bound reaches 0: a retry adds bits.
        if (!positive(rest)) return c.widen(try c.int(0), std.math.maxInt(u32));
        return c.atan(try c.div(xi, try c.sqrt(rest)));
    }

    /// atan2(y, x) for (x, y) not on the positive x-axis or at the origin.
    fn angle(c: Ctx, y: Decimal, x: Decimal) !Attempt {
        const pi_value = try c.pi();
        if (x.coefficient == 0) {
            const half_pi = try c.divInt(pi_value, 2);
            return .{ .value = if (y.negative) try c.neg(half_pi) else half_pi };
        }
        if (y.coefficient == 0) return .{ .value = pi_value };
        const t = try c.atan(try c.div(try c.decimalValue(y), try c.decimalValue(x)));
        if (!x.negative) return .{ .value = t };
        return .{ .value = if (y.negative) try c.sub(t, pi_value) else try c.add(t, pi_value) };
    }

    // ------------------------------------------------------------ rounding

    /// Both bounds of `v` * 2^scale rounded, or null when they differ and
    /// a retry can tell them apart; at the last attempt, the lower bound's.
    fn rounded(c: Ctx, v: Attempt, last: bool) Error!?Decimal {
        const iv = v.value;
        if (!positive(iv) and !negative(iv)) {
            // An interval holding zero: only a retry can settle the sign.
            if (last) return error.Overflow;
            return null;
        }
        const neg_result = negative(iv);
        var low = try c.copy(if (neg_result) iv.hi else iv.lo);
        var high = try c.copy(if (neg_result) iv.lo else iv.hi);
        if (neg_result) {
            low.negate();
            high.negate();
        }
        const a = try c.bound(low, v.scale, neg_result);
        const b = try c.bound(high, v.scale, neg_result);
        if (a == null and b == null) return error.Overflow;
        if (a != null and b != null and std.meta.eql(a.?, b.?)) return a.?;
        if (last) return a orelse error.Overflow;
        return null;
    }

    /// Rounds |m| * 2^scale * 2^-p, or null when that overflows.
    fn bound(c: Ctx, m: Big, scale: i64, neg_result: bool) Error!?Decimal {
        var n = try c.copy(m);
        try n.shiftLeft(&n, @intCast(@max(scale, 0)));
        var d = try c.big(@as(u8, 1));
        try d.shiftLeft(&d, c.p + @as(usize, @intCast(@max(-scale, 0))));
        return decimal.finish(&n, &d, 0, 0, neg_result, true) catch |err| switch (err) {
            error.Overflow => null,
            else => err,
        };
    }
};

fn expectCall(f: Function, x: []const u8, want: []const u8) !void {
    const gpa = std.testing.allocator;
    const r = try call(gpa, f, try Decimal.parse(x));
    const shown = try r.string(gpa);
    defer gpa.free(shown);
    try std.testing.expectEqualStrings(want, shown);
}

test "correctly rounded to 34 digits, exact where the value is" {
    try expectCall(.exp, "0", "1");
    try expectCall(.exp, "1", "2.718281828459045235360287471352662");
    try expectCall(.ln, "2", "0.6931471805599453094172321214581766");
    try expectCall(.ln, "1", "0");
    try expectCall(.log10, "1000", "3");
    try expectCall(.log10, "2", "0.301029995663981195213738894724493");
    try expectCall(.sin, "1", "0.841470984807896506652502321630299");
    try expectCall(.cos, "1", "0.5403023058681397174009366074429766");
    try expectCall(.tan, "1", "1.55740772465490223050697480745836");
    try expectCall(.atan, "1", "0.7853981633974483096156608458198757");
    try expectCall(.asin, "1", "1.570796326794896619231321691639751");
    try expectCall(.acos, "-1", "3.141592653589793238462643383279503");
    try expectCall(.sin, "0", "0");
    // Checked against mpmath at 160 digits: a reduction by about 6.4e33
    // quarter turns, a cosine within 5e-10 of -1, a tangent near its pole,
    // an arcsine near 1, and atan2 in the third and second quadrants.
    try expectCall(.sin, "9999999999999999999999999999999999", "0.2414430295482752256999762633270003");
    try expectCall(.cos, "355", "-0.9999999995456589801659358416927541");
    try expectCall(.tan, "1.570796326794896619231321691639751", "2261938930836633226244288822199802");
    try expectCall(.asin, "0.9999999999999999999999999999999999", "1.570796326794896605089186067908801");
    const gpa = std.testing.allocator;
    for ([_][3][]const u8{ .{ "-1", "-1", "-2.356194490192344928846982537459627" }, .{ "0.0001", "-1000000", "3.141592653489793238462643383279836" } }) |c| {
        const r = try atan2(gpa, try Decimal.parse(c[0]), try Decimal.parse(c[1]));
        const shown = try r.string(gpa);
        defer gpa.free(shown);
        try std.testing.expectEqualStrings(c[2], shown);
    }
    try std.testing.expectError(error.OutOfDomain, call(std.testing.allocator, .ln, Decimal.fromInt(0)));
    try std.testing.expectError(error.Overflow, call(std.testing.allocator, .exp, Decimal.fromInt(100)));
}

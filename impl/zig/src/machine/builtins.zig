//! The Built-in functions and Constants that need no Handler, Library or
//! Capability machinery (chapter 7), with their errors.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const stdlib = @import("../generated/stdlib.zig").stdlib;
const costs = @import("costs.zig");
const matcher = @import("matcher.zig");
const transcendental = @import("../decimal/transcendental.zig");
const Value = model.Value;

/// An error a Built-in raises: its code and fields, owned.
pub const Raised = struct {
    code: []const u8 = "",
    fields: [4]model.Pair = undefined,
    len: usize = 0,
};

pub const Error = error{ OutOfMemory, Raised };

/// Records an error to raise, with text fields and, optionally, a value.
fn fill(r: *Raised, gpa: Allocator, code: []const u8, fields: []const struct { []const u8, []const u8 }, value: ?*Value) Error {
    r.code = code;
    for (fields) |f| {
        r.fields[r.len] = .{ .key = f[0], .value = model.text(gpa, f[1]) catch return error.OutOfMemory };
        r.len += 1;
    }
    if (value) |v| {
        r.fields[r.len] = .{ .key = "value", .value = v.retain() };
        r.len += 1;
    }
    return error.Raised;
}

fn raise(r: *Raised, gpa: Allocator, code: []const u8, fields: []const struct { []const u8, []const u8 }) Error {
    return fill(r, gpa, code, fields, null);
}

fn wrongKind(r: *Raised, gpa: Allocator, expected: []const u8, got: *Value) Error {
    return fill(r, gpa, "wrong kind", &.{ .{ "expected", expected }, .{ "got", kindName(got) } }, got);
}

fn kindName(v: *const Value) []const u8 {
    return switch (v.data) {
        .nothing => "nothing",
        .bool => "boolean",
        .civil_date => "civil date",
        inline else => |_, k| @tagName(k),
    };
}

/// A Built-in Constant's value, from stdlib.toml.
pub fn constant(gpa: Allocator, name: []const u8) !*Value {
    for (stdlib.builtin) |b| {
        if (!std.mem.eql(u8, b.name, name)) continue;
        if (std.mem.startsWith(u8, b.call, "U+")) {
            const cp = std.fmt.parseInt(u21, b.call[2..], 16) catch unreachable;
            var buf: [4]u8 = undefined;
            return model.text(gpa, buf[0..unicode.utf8.encode(cp, &buf)]);
        }
        return model.scalar(gpa, .{ .number = model.Decimal.parse(b.call) catch unreachable });
    }
    unreachable;
}

/// Calls a Built-in function.
pub fn call(a: Allocator, gpa: Allocator, name: []const u8, args: []*Value, raised: *Raised, m: *costs.Measures) Error!*Value {
    m.args = args;
    if (std.mem.eql(u8, name, "offset")) {
        // The leftmost match's start, from a search run to its end.
        const needle, const s = .{ args[0], args[1] };
        const program = switch (needle.data) {
            .pattern => matcher.programOf(a, needle, false) catch return error.OutOfMemory,
            .text => |t| try matcher.literalProgram(a, (try matcher.Subject.ofText(a, t)).units, false),
            else => return wrongKind(raised, gpa, "pattern", needle),
        };
        if (s.data != .text) return wrongKind(raised, gpa, "text", s);
        const found = try matcher.run(a, program, try matcher.Subject.ofText(a, s.data.text), 0, .search, false, &m.steps);
        return model.scalar(gpa, .{ .number = model.Decimal.fromInt(@as(i64, if (found) |f| @intCast(f.start + 1) else 0)) }) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "fromCodePoint")) {
        const x = args[0];
        if (x.data != .number) return wrongKind(raised, gpa, "number", x);
        const n = x.data.number.integer(i64) catch return wrongKind(raised, gpa, "integer", x);
        if (n < 0 or n > 0x10ffff or (n >= 0xd800 and n <= 0xdfff)) return fill(raised, gpa, "out of domain", &.{}, x);
        var buf: [4]u8 = undefined;
        return model.text(gpa, buf[0..unicode.utf8.encode(@intCast(n), &buf)]) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "codePoint")) {
        const x = args[0];
        if (x.data != .text) return wrongKind(raised, gpa, "text", x);
        const t = x.data.text;
        if (t.len == 0 or unicode.utf8.sequenceLength(t[0]) != t.len) return fill(raised, gpa, "out of domain", &.{}, x);
        return model.scalar(gpa, .{ .number = model.Decimal.fromInt(@as(i64, unicode.utf8.decode(t, 0))) }) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "kindOf")) return model.text(gpa, kindName(args[0])) catch error.OutOfMemory;
    if (std.mem.eql(u8, name, "abs")) {
        const x = args[0];
        return switch (x.data) {
            .number => |n| model.scalar(gpa, .{ .number = .{ .coefficient = n.coefficient, .exponent = n.exponent } }) catch error.OutOfMemory,
            .quantity => |q| model.scalar(gpa, .{ .quantity = .{ .number = .{ .coefficient = q.number.coefficient, .exponent = q.number.exponent }, .unit = q.unit } }) catch error.OutOfMemory,
            else => wrongKind(raised, gpa, "number", x),
        };
    }
    if (std.mem.eql(u8, name, "rangeStart") or std.mem.eql(u8, name, "rangeEnd")) {
        const x = args[0];
        if (x.data != .range) return wrongKind(raised, gpa, "range", x);
        return if (std.mem.eql(u8, name, "rangeStart")) x.data.range.from.retain() else x.data.range.to.retain();
    }
    if (exactName(name)) |mode| return exact(gpa, name, mode, args, raised);
    if (std.meta.stringToEnum(transcendental.Function, name)) |f| {
        const x = args[0];
        if (x.data != .number) return wrongKind(raised, gpa, "number", x);
        const r = transcendental.call(gpa, f, x.data.number) catch |e| return mathError(gpa, name, e, x, raised);
        return model.scalar(gpa, .{ .number = r }) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "sqrt") or std.mem.eql(u8, name, "power")) {
        // sqrt(x) is x^0.5, so both are `power`'s, exact where it is.
        const x = args[0];
        if (x.data != .number) return wrongKind(raised, gpa, "number", x);
        const y = if (args.len > 1) args[1] else null;
        if (y) |v| if (v.data != .number) return wrongKind(raised, gpa, "number", v);
        const exponent = if (y) |v| v.data.number else model.Decimal{ .coefficient = 5, .exponent = -1 };
        if (y == null and x.data.number.negative) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, x);
        const r = model.decimal.power(a, x.data.number, exponent) catch |e| return mathError(gpa, name, e, x, raised);
        return model.scalar(gpa, .{ .number = r }) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "atan2")) {
        const y = args[0];
        const x = args[1];
        if (y.data != .number) return wrongKind(raised, gpa, "number", y);
        if (x.data != .number) return wrongKind(raised, gpa, "number", x);
        const r = transcendental.atan2(gpa, y.data.number, x.data.number) catch |e| switch (e) {
            // `value` is 0 for atan2(0, 0).
            error.OutOfDomain => return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, try numberValue(gpa, 0)),
            else => return mathError(gpa, name, e, x, raised),
        };
        return model.scalar(gpa, .{ .number = r }) catch error.OutOfMemory;
    }
    if (std.mem.eql(u8, name, "min") or std.mem.eql(u8, name, "max")) return extreme(gpa, name, args[0], raised, m);
    if (std.mem.eql(u8, name, "upper") or std.mem.eql(u8, name, "lower")) {
        const x = args[0];
        if (x.data != .text) return wrongKind(raised, gpa, "text", x);
        const mapped = caseMapped(a, x.data.text, std.mem.eql(u8, name, "upper")) catch return error.OutOfMemory;
        const nfc = unicode.nfc(a, mapped) catch return error.OutOfMemory;
        return model.text(gpa, nfc) catch error.OutOfMemory;
    }
    if (dateField(name)) |field| return dateValue(gpa, name, field, args[0], raised);
    if (std.mem.eql(u8, name, "toCivil") or std.mem.eql(u8, name, "toInstant")) return civilOrInstant(a, gpa, name, args, raised);
    if (std.mem.startsWith(u8, name, "fromFloat") or std.mem.startsWith(u8, name, "toFloat")) return float(gpa, name, args, raised);
    if (std.mem.eql(u8, name, "conforms") or std.mem.eql(u8, name, "check") or std.mem.eql(u8, name, "explain")) return shapeCall(a, gpa, name, args, raised, m);
    return raise(raised, gpa, "not implemented", &.{});
}

// ------------------------------------------------------------ Shape checks

const shape_check = @import("shape_check.zig");

/// `conforms`, `check` and `explain` (chapter 7): the definition is
/// validated first, and failed work is charged through `m.scanned`.
fn shapeCall(a: Allocator, gpa: Allocator, name: []const u8, args: []*Value, raised: *Raised, m: *costs.Measures) Error!*Value {
    const explain = std.mem.eql(u8, name, "explain");
    const outcome = shape_check.run(a, gpa, args[0], args[1], !explain) catch return error.OutOfMemory;
    defer outcome.release();
    m.scanned = outcome.scanned;
    if (outcome.definition_error) |e| {
        raised.code = "invalid shape";
        raised.fields[0] = .{ .key = "reason", .value = model.text(gpa, e.reason) catch return error.OutOfMemory };
        raised.fields[1] = .{ .key = "path", .value = shape_check.pathList(gpa, e.path) catch return error.OutOfMemory };
        raised.fields[2] = .{ .key = "value", .value = e.value.retain() };
        raised.len = 3;
        return error.Raised;
    }
    if (std.mem.eql(u8, name, "conforms")) {
        return model.scalar(gpa, .{ .bool = outcome.diagnostics.len == 0 }) catch return error.OutOfMemory;
    }
    if (explain) {
        var records: std.ArrayList(*Value) = .empty;
        defer records.deinit(a);
        for (outcome.diagnostics) |d| {
            records.append(a, shape_check.record(gpa, d) catch return error.OutOfMemory) catch return error.OutOfMemory;
        }
        const list = model.list(gpa, records.items) catch return error.OutOfMemory;
        for (records.items) |r| r.release();
        return list;
    }
    if (outcome.diagnostics.len == 0) return args[0].retain();
    const d = outcome.diagnostics[0];
    if (d.unencodable) {
        raised.code = "not encodable";
        raised.fields[0] = .{ .key = "kind", .value = model.text(gpa, d.got) catch return error.OutOfMemory };
        raised.fields[1] = .{ .key = "path", .value = shape_check.pathList(gpa, d.path) catch return error.OutOfMemory };
        raised.len = 2;
        return error.Raised;
    }
    raised.code = "wrong kind";
    raised.fields[0] = .{ .key = "expected", .value = model.text(gpa, d.expected) catch return error.OutOfMemory };
    raised.fields[1] = .{ .key = "got", .value = model.text(gpa, d.got) catch return error.OutOfMemory };
    raised.fields[2] = .{ .key = "value", .value = d.value.retain() };
    raised.len = 3;
    if (d.path.len > 0) {
        raised.fields[3] = .{ .key = "path", .value = shape_check.pathList(gpa, d.path) catch return error.OutOfMemory };
        raised.len = 4;
    }
    return error.Raised;
}

// ---------------------------------------------------------------- numbers

/// A correctly rounded function's errors: `out of domain` with the
/// argument, `overflow` naming the function, and `division by zero`.
fn mathError(gpa: Allocator, name: []const u8, e: anyerror, x: *Value, raised: *Raised) Error {
    return switch (e) {
        error.OutOfDomain => fill(raised, gpa, "out of domain", &.{.{ "function", name }}, x),
        error.Overflow => raise(raised, gpa, "overflow", &.{.{ "operator", name }}),
        error.DivisionByZero => raise(raised, gpa, "division by zero", &.{}),
        error.OutOfMemory => error.OutOfMemory,
        else => wrongKind(raised, gpa, "number", x),
    };
}

const Mode = enum { half_up, half_even, up, down, floor, ceiling };

/// `floor`, `ceiling`, `truncate` and `round`, which are exact.
fn exactName(name: []const u8) ?Mode {
    if (std.mem.eql(u8, name, "floor")) return .floor;
    if (std.mem.eql(u8, name, "ceiling")) return .ceiling;
    if (std.mem.eql(u8, name, "truncate")) return .down;
    if (std.mem.eql(u8, name, "round")) return .half_up;
    return null;
}

fn exact(gpa: Allocator, name: []const u8, default: Mode, args: []*Value, raised: *Raised) Error!*Value {
    const x = args[0];
    const number = switch (x.data) {
        .number => |n| n,
        .quantity => |q| q.number,
        else => return wrongKind(raised, gpa, "number", x),
    };
    var places: u32 = 0;
    var mode = default;
    if (std.mem.eql(u8, name, "round")) {
        if (args.len > 1) {
            const p = args[1];
            if (p.data != .number) return wrongKind(raised, gpa, "number", p);
            const n = p.data.number.integer(i64) catch return wrongKind(raised, gpa, "integer", p);
            if (n < 0 or n > 6176) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, p);
            places = @intCast(n);
        }
        if (args.len > 2) {
            const t = args[2];
            if (t.data != .text) return wrongKind(raised, gpa, "text", t);
            const modes = [_]struct { []const u8, Mode }{ .{ "half up", .half_up }, .{ "half even", .half_even }, .{ "up", .up }, .{ "down", .down }, .{ "floor", .floor }, .{ "ceiling", .ceiling } };
            mode = for (modes) |md| {
                if (std.mem.eql(u8, md[0], t.data.text)) break md[1];
            } else return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, t);
        }
    }
    const r = rounded(number, places, mode) catch return raise(raised, gpa, "overflow", &.{.{ "operator", name }});
    return switch (x.data) {
        .quantity => |q| model.scalar(gpa, .{ .quantity = .{ .number = r, .unit = q.unit } }) catch error.OutOfMemory,
        else => model.scalar(gpa, .{ .number = r }) catch error.OutOfMemory,
    };
}

const coefficient_limit: u128 = std.math.pow(u128, 10, 34);

/// `d` rounded to exactly `places` digits after the point by `mode`.
fn rounded(d: model.Decimal, places: u32, mode: Mode) error{Overflow}!model.Decimal {
    const target = -@as(i32, @intCast(places));
    if (d.exponent >= target) {
        const shift: u32 = @intCast(d.exponent - target);
        if (d.coefficient == 0) return .{ .exponent = target };
        if (shift > 33) return error.Overflow;
        const c = std.math.mul(u128, d.coefficient, std.math.pow(u128, 10, shift)) catch return error.Overflow;
        if (c >= coefficient_limit) return error.Overflow;
        return .{ .coefficient = c, .exponent = target, .negative = d.negative };
    }
    const k: u32 = @intCast(target - d.exponent);
    var q: u128 = 0;
    // How the dropped digits compare with half of a unit: -1, 0 or 1, and
    // whether any is nonzero.
    var half: std.math.Order = .lt;
    var dropped = d.coefficient != 0;
    if (k <= 38) {
        const div = std.math.pow(u128, 10, k);
        q = d.coefficient / div;
        const r = d.coefficient % div;
        dropped = r != 0;
        half = std.math.order(r, div / 2);
    }
    const up = switch (mode) {
        .down => false,
        .up => dropped,
        .floor => d.negative and dropped,
        .ceiling => !d.negative and dropped,
        .half_up => half != .lt,
        .half_even => half == .gt or (half == .eq and q % 2 == 1),
    };
    if (up) q += 1;
    if (q >= coefficient_limit) return error.Overflow;
    return .{ .coefficient = q, .exponent = target, .negative = d.negative and q != 0 };
}

/// `min` and `max`: the first least or greatest item under `<`.
fn extreme(gpa: Allocator, name: []const u8, xs: *Value, raised: *Raised, m: *costs.Measures) Error!*Value {
    if (xs.data != .list) return wrongKind(raised, gpa, "list", xs);
    const items = xs.data.list;
    if (items.len == 0) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, xs);
    const want: std.math.Order = if (std.mem.eql(u8, name, "min")) .lt else .gt;
    var best = items[0];
    m.scanned = 1;
    var comparer = model.Comparer.init(gpa);
    defer comparer.deinit();
    for (items[1..]) |x| {
        m.scanned +|= 1 +| (comparer.scanned(x, best) catch 0);
        const o = comparer.order(x, best) catch {
            raised.code = "can't compare";
            raised.fields[0] = .{ .key = "left", .value = x.retain() };
            raised.fields[1] = .{ .key = "right", .value = best.retain() };
            raised.len = 2;
            return error.Raised;
        };
        if (o == want) best = x;
    }
    return best.retain();
}

/// Unicode full default case mapping; `lower` maps a capital sigma that
/// ends a word to the final sigma (Final_Sigma).
pub fn caseMapped(a: Allocator, s: []const u8, upper: bool) ![]u8 {
    const props = unicode.properties;
    var scalars: std.ArrayList(u21) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        const n = unicode.utf8.sequenceLength(s[i]);
        try scalars.append(a, unicode.utf8.decode(s, i));
        i += n;
    }
    var out: std.ArrayList(u8) = .empty;
    for (scalars.items, 0..) |c, at| {
        var mapped: []const u21 = &.{c};
        if (upper) {
            if (props.uppercase(c)) |to| mapped = to;
        } else if (c == 0x03A3 and finalSigma(scalars.items, at)) {
            mapped = props.finalSigma(c).?;
        } else if (props.lowercase(c)) |to| mapped = to;
        for (mapped) |x| {
            var buf: [4]u8 = undefined;
            try out.appendSlice(a, buf[0..unicode.utf8.encode(x, &buf)]);
        }
    }
    return out.items;
}

/// Whether the sigma at `at` follows a cased letter and precedes none,
/// skipping case-ignorable ones either side.
fn finalSigma(scalars: []const u21, at: usize) bool {
    const props = unicode.properties;
    var before = false;
    var i = at;
    while (i > 0) {
        i -= 1;
        if (props.isCaseIgnorable(scalars[i])) continue;
        before = props.isCased(scalars[i]);
        break;
    }
    if (!before) return false;
    for (scalars[at + 1 ..]) |c| {
        if (props.isCaseIgnorable(c)) continue;
        return !props.isCased(c);
    }
    return true;
}

// ---------------------------------------------------------------- dates

const Field = enum { year, month, day, hour, minute, second, nanosecond, weekday, day_of_year, iso_week, iso_week_year, has_time };

fn dateField(name: []const u8) ?Field {
    const names = [_]struct { []const u8, Field }{ .{ "year", .year }, .{ "month", .month }, .{ "day", .day }, .{ "hour", .hour }, .{ "minute", .minute }, .{ "second", .second }, .{ "nanosecond", .nanosecond }, .{ "weekday", .weekday }, .{ "dayOfYear", .day_of_year }, .{ "isoWeek", .iso_week }, .{ "isoWeekYear", .iso_week_year }, .{ "hasTime", .has_time } };
    for (names) |n| if (std.mem.eql(u8, n[0], name)) return n[1];
    return null;
}

fn numberValue(gpa: Allocator, n: i64) Error!*Value {
    return model.scalar(gpa, .{ .number = model.Decimal.fromInt(n) }) catch error.OutOfMemory;
}

/// Days since 1970-01-01 of a date's day.
fn epochDay(f: model.dates.Fields) i64 {
    var day = f;
    day.has_time = false;
    day.hour = 0;
    day.minute = 0;
    day.second = 0;
    return @divFloor(model.dates.seconds(day), 86400);
}

/// The ISO weekday, 1 for Monday to 7 for Sunday: 1970-01-01 was a Thursday.
fn isoWeekday(f: model.dates.Fields) i64 {
    return @mod(epochDay(f) + 3, 7) + 1;
}

fn dayOfYear(f: model.dates.Fields) i64 {
    return epochDay(f) - epochDay(.{ .year = f.year, .month = 1, .day = 1 }) + 1;
}

/// ISO 8601 weeks in a year: 53 when it starts on a Thursday, or on a
/// Wednesday in a leap year.
fn weeksIn(year: c_int) i64 {
    const first = isoWeekday(.{ .year = year, .month = 1, .day = 1 });
    const leap = @mod(year, 4) == 0 and (@mod(year, 100) != 0 or @mod(year, 400) == 0);
    return if (first == 4 or (leap and first == 3)) 53 else 52;
}

fn isoWeek(f: model.dates.Fields) struct { week: i64, year: i64 } {
    const week = @divFloor(dayOfYear(f) - isoWeekday(f) + 10, 7);
    if (week < 1) return .{ .week = weeksIn(f.year - 1), .year = f.year - 1 };
    if (week > weeksIn(f.year)) return .{ .week = 1, .year = f.year + 1 };
    return .{ .week = week, .year = f.year };
}

fn dateValue(gpa: Allocator, name: []const u8, field: Field, d: *Value, raised: *Raised) Error!*Value {
    if (d.data != .civil_date) return wrongKind(raised, gpa, "civil date", d);
    const f = d.data.civil_date;
    switch (field) {
        .hour, .minute, .second, .nanosecond => if (!f.has_time) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, d),
        else => {},
    }
    return switch (field) {
        .year => numberValue(gpa, f.year),
        .month => numberValue(gpa, f.month),
        .day => numberValue(gpa, f.day),
        .hour => numberValue(gpa, f.hour),
        .minute => numberValue(gpa, f.minute),
        .second => numberValue(gpa, f.second),
        .nanosecond => numberValue(gpa, f.nanosecond),
        .weekday => numberValue(gpa, isoWeekday(f)),
        .day_of_year => numberValue(gpa, dayOfYear(f)),
        .iso_week => numberValue(gpa, isoWeek(f).week),
        .iso_week_year => numberValue(gpa, isoWeek(f).year),
        .has_time => model.scalar(gpa, .{ .bool = f.has_time }) catch error.OutOfMemory,
    };
}

/// A fixed offset from UTC in seconds: an exact duration that is a whole
/// number of minutes, less than 24 hr in magnitude.
fn offsetSeconds(a: Allocator, v: *const Value) ?i64 {
    if (v.data != .quantity) return null;
    const q = v.data.quantity;
    const second = @import("../units.zig").Unit.parse("s") catch return null;
    if (!q.unit.compatible(&second)) return null;
    const base = q.unit.toBase(a, q.number) catch return null;
    if (base.exponent < 0) {
        var c = base.coefficient;
        var e = base.exponent;
        while (e < 0) : (e += 1) {
            if (c % 10 != 0) return null;
            c /= 10;
        }
        if (c > 86400) return null;
        const n: i64 = @intCast(c);
        return checkMinutes(if (base.negative) -n else n);
    }
    if (base.exponent > 5 or base.coefficient > 86400) return null;
    const n: i64 = @intCast(base.coefficient * std.math.pow(u128, 10, @intCast(base.exponent)));
    return checkMinutes(if (base.negative) -n else n);
}

fn checkMinutes(n: i64) ?i64 {
    if (@mod(n, 60) != 0 or @abs(n) >= 86400) return null;
    return n;
}

fn civilOrInstant(a: Allocator, gpa: Allocator, name: []const u8, args: []*Value, raised: *Raised) Error!*Value {
    const civil = std.mem.eql(u8, name, "toCivil");
    const x = args[0];
    if (civil and x.data != .instant) return wrongKind(raised, gpa, "instant", x);
    if (!civil and x.data != .civil_date) return wrongKind(raised, gpa, "civil date", x);
    if (args[1].data != .quantity) return wrongKind(raised, gpa, "quantity", args[1]);
    const offset = offsetSeconds(a, args[1]) orelse return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, args[1]);
    if (civil) {
        const t = x.data.instant;
        if (yearOf(t.seconds + offset) < 1 or yearOf(t.seconds + offset) > 9999) return outOfRange(gpa, t.seconds + offset, raised);
        const f = model.dates.fields(.{ .seconds = t.seconds + offset, .nanos = t.nanos });
        return model.scalar(gpa, .{ .civil_date = f }) catch error.OutOfMemory;
    }
    const f = x.data.civil_date;
    if (!f.has_time) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, x);
    const t: model.dates.Instant = .{ .seconds = model.dates.seconds(f) - offset, .nanos = f.nanosecond };
    model.dates.validateInstant(t) catch return outOfRange(gpa, t.seconds, raised);
    return model.scalar(gpa, .{ .instant = t }) catch error.OutOfMemory;
}

/// The proleptic Gregorian year of a moment, for any second.
pub fn yearOf(seconds: i64) i64 {
    // Days from 0000-03-01, in 400-year eras (Hinnant's civil_from_days).
    const z = @divFloor(seconds, 86400) + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const month = if (mp < 10) mp + 3 else mp - 9;
    return yoe + era * 400 + @intFromBool(month <= 2);
}

fn outOfRange(gpa: Allocator, seconds: i64, raised: *Raised) Error {
    raised.code = "out of range";
    raised.fields[0] = .{ .key = "field", .value = model.text(gpa, "year") catch return error.OutOfMemory };
    raised.fields[1] = .{ .key = "value", .value = try numberValue(gpa, yearOf(seconds)) };
    raised.len = 2;
    return error.Raised;
}

// ---------------------------------------------------------------- floats

fn float(gpa: Allocator, name: []const u8, args: []*Value, raised: *Raised) Error!*Value {
    const wide = std.mem.endsWith(u8, name, "64");
    var little = false;
    if (args.len > 1) {
        const o = args[1];
        if (o.data != .text) return wrongKind(raised, gpa, "text", o);
        if (std.mem.eql(u8, o.data.text, "little")) {
            little = true;
        } else if (!std.mem.eql(u8, o.data.text, "big")) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, o);
    }
    const endian: std.builtin.Endian = if (little) .little else .big;
    if (std.mem.startsWith(u8, name, "from")) {
        const b = args[0];
        if (b.data != .bytes) return wrongKind(raised, gpa, "bytes", b);
        const bytes = b.data.bytes;
        if (bytes.len != @as(usize, if (wide) 8 else 4)) return fill(raised, gpa, "out of domain", &.{.{ "function", name }}, b);
        var buf: [64]u8 = undefined;
        // The shortest decimal that reads back as the same float.
        const shown = if (wide) blk: {
            const f: f64 = @bitCast(std.mem.readInt(u64, bytes[0..8], endian));
            if (!std.math.isFinite(f) or @abs(f) >= 1e34) return fill(raised, gpa, "can't convert", &.{.{ "to", "number" }}, b);
            break :blk std.fmt.bufPrint(&buf, "{d}", .{if (f == 0) 0 else f}) catch unreachable;
        } else blk: {
            const f: f32 = @bitCast(std.mem.readInt(u32, bytes[0..4], endian));
            if (!std.math.isFinite(f)) return fill(raised, gpa, "can't convert", &.{.{ "to", "number" }}, b);
            break :blk std.fmt.bufPrint(&buf, "{d}", .{if (f == 0) 0 else f}) catch unreachable;
        };
        return model.scalar(gpa, .{ .number = fromShortest(shown) catch return fill(raised, gpa, "can't convert", &.{.{ "to", "number" }}, b) }) catch error.OutOfMemory;
    }
    const n = args[0];
    if (n.data != .number) return wrongKind(raised, gpa, "number", n);
    var text: [64]u8 = undefined;
    var fba: std.heap.FixedBufferAllocator = .init(&text);
    const digits = n.data.number.string(fba.allocator()) catch return error.OutOfMemory;
    // Nearest, ties to even, from the exact decimal text.
    if (wide) {
        const f = std.fmt.parseFloat(f64, digits) catch unreachable;
        var out: [8]u8 = undefined;
        std.mem.writeInt(u64, &out, @bitCast(f), endian);
        return model.bytes(gpa, &out) catch error.OutOfMemory;
    }
    const f = std.fmt.parseFloat(f32, digits) catch unreachable;
    var out: [4]u8 = undefined;
    std.mem.writeInt(u32, &out, @bitCast(f), endian);
    return model.bytes(gpa, &out) catch error.OutOfMemory;
}

/// A float's shortest decimal text, which may use an exponent, as a number.
fn fromShortest(s: []const u8) !model.Decimal {
    if (std.mem.indexOfAny(u8, s, "eE")) |e| {
        const exp = try std.fmt.parseInt(i32, s[e + 1 ..], 10);
        var d = try model.Decimal.parse(s[0..e]);
        d.exponent += exp;
        while (d.exponent > 0) : (d.exponent -= 1) d.coefficient *= 10;
        if (d.coefficient >= coefficient_limit or d.exponent < -6176) return error.InvalidValue;
        return d;
    }
    return model.Decimal.parse(s);
}

test "rounding modes are the General Decimal Arithmetic's" {
    const d = model.Decimal.parse;
    const cases = .{
        .{ "2.5", 0, Mode.half_up, "3" },
        .{ "-2.5", 0, Mode.half_up, "-3" },
        .{ "2.5", 0, Mode.half_even, "2" },
        .{ "-2.5", 0, Mode.floor, "-3" },
        .{ "2.1", 0, Mode.ceiling, "3" },
        .{ "-2.9", 0, Mode.down, "-2" },
        .{ "2.567", 2, Mode.half_up, "2.57" },
        .{ "3", 2, Mode.half_up, "3.00" },
        .{ "-0.4", 0, Mode.half_up, "0" },
    };
    inline for (cases) |c| {
        const r = try rounded(try d(c[0]), c[1], c[2]);
        const shown = try r.string(std.testing.allocator);
        defer std.testing.allocator.free(shown);
        try std.testing.expectEqualStrings(c[3], shown);
    }
    try std.testing.expectError(error.Overflow, rounded(try d("9999999999999999999999999999999999"), 1, .half_up));
}

test "upper and lower use full mappings and the final sigma" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("SS", try caseMapped(a, "ß", true));
    try std.testing.expectEqualStrings("όσος", try caseMapped(a, "ΌΣΟΣ", false));
    try std.testing.expectEqualStrings("σ", try caseMapped(a, "Σ", false));
}

test "ISO weeks and the years of any moment" {
    try std.testing.expectEqual(@as(i64, 2020), isoWeek(.{ .year = 2021, .month = 1, .day = 1 }).year);
    try std.testing.expectEqual(@as(i64, 53), isoWeek(.{ .year = 2021, .month = 1, .day = 1 }).week);
    try std.testing.expectEqual(@as(i64, 1), isoWeek(.{ .year = 2024, .month = 12, .day = 30 }).week);
    try std.testing.expectEqual(@as(i64, 4), isoWeekday(.{ .year = 1970, .month = 1, .day = 1 }));
    try std.testing.expectEqual(@as(i64, 1970), yearOf(0));
    try std.testing.expectEqual(@as(i64, 10000), yearOf(253402300800));
    try std.testing.expectEqual(@as(i64, 0), yearOf(-62135596801));
}

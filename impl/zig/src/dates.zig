//! Proleptic Gregorian dates and Unix instants, without locale or zone data.
const std = @import("std");
const decimal = @import("decimal/decimal.zig");
pub const Fields = extern struct {
    year: c_int,
    month: c_int,
    day: c_int,
    has_time: bool = false,
    hour: c_int = 0,
    minute: c_int = 0,
    second: c_int = 0,
    nanosecond: c_int = 0,
};
pub const Instant = struct { seconds: i64, nanos: i32 };
const Error = error{InvalidValue};
fn leap(y: i32) bool {
    return @mod(y, 4) == 0 and (@mod(y, 100) != 0 or @mod(y, 400) == 0);
}
fn monthLength(y: i32, m: i32) i32 {
    const days = [_]i32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return days[@intCast(m - 1)] + @as(i32, @intFromBool(m == 2 and leap(y)));
}
pub fn validate(f: Fields) Error!void {
    if (f.year < 1 or f.year > 9999 or f.month < 1 or f.month > 12 or f.day < 1 or f.day > monthLength(f.year, f.month)) return error.InvalidValue;
    if (f.hour < 0 or f.hour > 23 or f.minute < 0 or f.minute > 59 or f.second < 0 or f.second > 59 or f.nanosecond < 0 or f.nanosecond >= 1_000_000_000) return error.InvalidValue;
    if (!f.has_time and (f.hour != 0 or f.minute != 0 or f.second != 0 or f.nanosecond != 0)) return error.InvalidValue;
}
fn number(s: []const u8) Error!i32 {
    for (s) |c| if (c < '0' or c > '9') return error.InvalidValue;
    return std.fmt.parseInt(i32, s, 10) catch error.InvalidValue;
}
pub fn parseCivil(input: []const u8) Error!Fields {
    const s = decimal.trim(input);
    if (s.len < 10 or s[4] != '-' or s[7] != '-') return error.InvalidValue;
    var f: Fields = .{ .year = try number(s[0..4]), .month = try number(s[5..7]), .day = try number(s[8..10]) };
    if (s.len > 10) {
        if (s.len < 19 or s[10] != 'T' or s[13] != ':' or s[16] != ':') return error.InvalidValue;
        f.has_time = true;
        f.hour = try number(s[11..13]);
        f.minute = try number(s[14..16]);
        f.second = try number(s[17..19]);
        if (s.len > 19) {
            if (s[19] != '.' or s.len < 21 or s.len > 29) return error.InvalidValue;
            f.nanosecond = try number(s[20..]);
            for (s.len - 20..9) |_| f.nanosecond *= 10;
        }
    }
    try validate(f);
    return f;
}
fn daysBeforeYear(y: i32) i64 {
    const n: i64 = y - 1;
    return n * 365 + @divFloor(n, 4) - @divFloor(n, 100) + @divFloor(n, 400);
}
pub fn seconds(f: Fields) i64 {
    var day = daysBeforeYear(f.year) - daysBeforeYear(1970) + f.day - 1;
    var m: i32 = 1;
    while (m < f.month) : (m += 1) day += monthLength(f.year, m);
    return day * 86400 + @as(i64, f.hour) * 3600 + f.minute * 60 + f.second;
}
pub fn validateInstant(t: Instant) Error!void {
    if (t.seconds < -62135596800 or t.seconds > 253402300799 or t.nanos < 0 or t.nanos >= 1_000_000_000) return error.InvalidValue;
}
pub fn fields(t: Instant) Fields {
    const day = @divFloor(t.seconds, 86400) + daysBeforeYear(1970);
    var low: i32 = 1;
    var high: i32 = 10000;
    while (low + 1 < high) {
        const mid = low + @divTrunc(high - low, 2);
        if (daysBeforeYear(mid) <= day) low = mid else high = mid;
    }
    var remaining = day - daysBeforeYear(low);
    var m: i32 = 1;
    while (remaining >= monthLength(low, m)) : (m += 1) remaining -= monthLength(low, m);
    const time = @mod(t.seconds, 86400);
    return .{ .year = low, .month = m, .day = @intCast(remaining + 1), .has_time = true, .hour = @intCast(@divTrunc(time, 3600)), .minute = @intCast(@divTrunc(@mod(time, 3600), 60)), .second = @intCast(@mod(time, 60)), .nanosecond = t.nanos };
}
pub fn parseInstant(input: []const u8) Error!Instant {
    const s = decimal.trim(input);
    var end = s.len;
    var offset: i32 = 0;
    if (s.len > 0 and s[s.len - 1] == 'Z') end -= 1 else {
        if (s.len < 25) return error.InvalidValue;
        end -= 6;
        if ((s[end] != '+' and s[end] != '-') or s[end + 3] != ':') return error.InvalidValue;
        const h = try number(s[end + 1 .. end + 3]);
        const m = try number(s[end + 4 ..]);
        if (h >= 24 or m >= 60) return error.InvalidValue;
        offset = (h * 60 + m) * 60 * @as(i32, if (s[end] == '-') -1 else 1);
    }
    const f = try parseCivil(s[0..end]);
    if (!f.has_time) return error.InvalidValue;
    const t: Instant = .{ .seconds = seconds(f) - offset, .nanos = f.nanosecond };
    try validateInstant(t);
    return t;
}
/// The `as civil date` text of valid fields, or RFC 3339 in UTC with the
/// shortest fraction when `instant` is set. The caller owns the result.
pub fn string(a: std.mem.Allocator, f: Fields, instant: bool) error{OutOfMemory}![]u8 {
    var buf: [64]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buf);
    // 64 bytes hold the longest form, 30 bytes, so the writes cannot fail.
    write(&writer, f, instant) catch unreachable;
    return a.dupe(u8, writer.buffered());
}
fn write(writer: *std.Io.Writer, f: Fields, instant: bool) !void {
    try writer.print("{d:0>4}-{d:0>2}-{d:0>2}", .{ @as(u32, @intCast(f.year)), @as(u32, @intCast(f.month)), @as(u32, @intCast(f.day)) });
    if (f.has_time) {
        try writer.print("T{d:0>2}:{d:0>2}:{d:0>2}", .{ @as(u32, @intCast(f.hour)), @as(u32, @intCast(f.minute)), @as(u32, @intCast(f.second)) });
        if (f.nanosecond != 0) {
            var fraction: [9]u8 = undefined;
            _ = try std.fmt.bufPrint(&fraction, "{d:0>9}", .{@as(u32, @intCast(f.nanosecond))});
            var len: usize = 9;
            while (fraction[len - 1] == '0') len -= 1;
            try writer.writeByte('.');
            try writer.writeAll(fraction[0..len]);
        }
    }
    if (instant) try writer.writeByte('Z');
}
test "date validation, negative epoch and offset normalization" {
    try std.testing.expectError(error.InvalidValue, parseCivil("2026-02-30"));
    try std.testing.expectError(error.InvalidValue, parseCivil("2026-09-27T23:59:60"));
    const t = try parseInstant("1969-12-31T23:59:59.999999999Z");
    try std.testing.expectEqual(@as(i64, -1), t.seconds);
    const s = try string(std.testing.allocator, fields(t), true);
    defer std.testing.allocator.free(s);
    try std.testing.expectEqualStrings("1969-12-31T23:59:59.999999999Z", s);
    try std.testing.expectEqual(@as(i64, 0), (try parseInstant("1970-01-01T01:00:00+01:00")).seconds);
}

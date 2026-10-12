//! The Built-in functions and Constants that need no Handler, Library or
//! Capability machinery (chapter 7), with their errors.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const stdlib = @import("../generated/stdlib.zig").stdlib;
const costs = @import("costs.zig");
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
    _ = a;
    m.args = args;
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
    return raise(raised, gpa, "not implemented", &.{});
}

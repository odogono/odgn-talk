//! Proposed Request/Pump Value items. This codec has no transport dependency.
//! See spec/embedding/request-pump-binary.md; negotiation remains experimental.
const std = @import("std");
const model = @import("value.zig");
const unicode = @import("unicode/unicode.zig");
const display = @import("display.zig");
const Allocator = std.mem.Allocator;
const Value = model.Value;

pub const FunctionWriter = struct {
    context: ?*anyopaque = null,
    /// An owned List containing the 3-, 6-, or 7-item Function payload.
    payload: *const fn (?*anyopaque, Allocator, *const Value) anyerror!*Value,
};

fn uint(out: *std.ArrayList(u8), a: Allocator, value: u128) !void {
    var n = value;
    while (n >= 128) : (n >>= 7) try out.append(a, @as(u8, @truncate(n)) | 128);
    try out.append(a, @intCast(n));
}
fn text(out: *std.ArrayList(u8), a: Allocator, s: []const u8) !void {
    try uint(out, a, s.len);
    try out.appendSlice(a, s);
}
fn taggedText(out: *std.ArrayList(u8), a: Allocator, s: []const u8) !void {
    try out.append(a, 5);
    try text(out, a, s);
}
fn number(out: *std.ArrayList(u8), a: Allocator, n: model.Decimal) !void {
    if (n.exponent == 0 and ((!n.negative and n.coefficient <= std.math.maxInt(u64)) or (n.negative and n.coefficient <= @as(u128, 1) << 64))) {
        try out.append(a, if (n.negative and n.coefficient != 0) 16 else 3);
        try uint(out, a, n.coefficient);
    } else {
        const s = try n.string(a);
        defer a.free(s);
        try out.append(a, 4);
        try text(out, a, s);
    }
}

pub const EncodeOptions = struct { functions: ?FunctionWriter = null, core_errors: bool = false, function_metadata: bool = false };

pub fn encode(a: Allocator, root: *const Value, options: EncodeOptions) ![]u8 {
    // Decimal/Unit formatting uses an allocating Writer. Its WriteFailed is
    // allocation refusal here, never external I/O or malformed input.
    return encodeInner(a, root, options) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else err;
}

fn encodeInner(a: Allocator, root: *const Value, options: EncodeOptions) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    const Step = union(enum) { value: *const Value, key: []const u8 };
    var stack: std.ArrayList(Step) = .empty;
    defer stack.deinit(a);
    var held: std.ArrayList(*Value) = .empty;
    defer {
        for (held.items) |v| v.release();
        held.deinit(a);
    }
    try stack.append(a, .{ .value = root });
    while (stack.pop()) |step| {
        if (step == .key) {
            try taggedText(&out, a, step.key);
            continue;
        }
        const v = step.value;
        switch (v.data) {
            .nothing => try out.append(a, 0),
            .bool => |b| try out.append(a, if (b) 2 else 1),
            .number => |n| try number(&out, a, n),
            .text => |s| try taggedText(&out, a, s),
            .bytes => |b| {
                try out.append(a, 8);
                try text(&out, a, b);
            },
            .list => |xs| {
                try out.append(a, 6);
                try uint(&out, a, xs.len);
                var i = xs.len;
                while (i > 0) {
                    i -= 1;
                    try stack.append(a, .{ .value = xs[i] });
                }
            },
            .map => |pairs| {
                try out.append(a, if (v.core_message and options.core_errors) 17 else 7);
                try uint(&out, a, pairs.len);
                var i = pairs.len;
                while (i > 0) {
                    i -= 1;
                    const p = pairs.at(i);
                    try stack.append(a, .{ .value = p.value });
                    try stack.append(a, .{ .key = p.key });
                }
            },
            .quantity => |q| {
                try out.append(a, 9);
                try number(&out, a, q.number);
                const s = try q.unit.string(a, false);
                defer a.free(s);
                try taggedText(&out, a, s);
            },
            .range => |r| {
                try out.append(a, 10);
                try stack.append(a, .{ .value = r.to });
                try stack.append(a, .{ .value = r.from });
            },
            .instant => |t| {
                const n: i64 = t.seconds * 1000000 + t.micros;
                const bits: u64 = @bitCast(n);
                try out.append(a, 11);
                try uint(&out, a, (bits << 1) ^ @as(u64, @bitCast(n >> 63)));
            },
            .civil_date => |d| {
                const s = try model.dates.string(a, d, false);
                defer a.free(s);
                try out.append(a, 12);
                try text(&out, a, s);
            },
            .pattern => |s| {
                try out.append(a, 13);
                try text(&out, a, s);
            },
            .object => |o| {
                try out.append(a, 14);
                try taggedText(&out, a, o.kind);
                try taggedText(&out, a, o.id);
            },
            .function => {
                const f = options.functions orelse return error.InvalidValue;
                const payload = try f.payload(f.context, a, v);
                held.append(a, payload) catch |e| {
                    payload.release();
                    return e;
                };
                if (payload.data != .list) return error.InvalidValue;
                const xs = payload.data.list;
                try validateFunction(xs);
                if (xs.len > 3 and !options.function_metadata) return error.InvalidValue;
                try out.append(a, if (xs.len == 3) 15 else 19);
                if (xs.len != 3) try uint(&out, a, xs.len);
                var i = xs.len;
                while (i > 0) {
                    i -= 1;
                    try stack.append(a, .{ .value = xs[i] });
                }
            },
        }
    }
    return out.toOwnedSlice(a);
}

fn validateFunction(xs: []const *Value) !void {
    if (xs.len != 3 and xs.len != 6 and xs.len != 7) return error.InvalidValue;
    for (xs[0..3]) |v| if (v.data != .text) return error.InvalidValue;
    if (xs.len >= 6) {
        if (xs[3].data != .nothing and xs[3].data != .text) return error.InvalidValue;
        if (xs[4].data != .number or xs[5].data != .number) return error.InvalidValue;
        const required = xs[4].data.number.integer(u64) catch return error.InvalidValue;
        const total = xs[5].data.number.integer(u64) catch return error.InvalidValue;
        if (xs[4].data.number.exponent != 0 or xs[5].data.number.exponent != 0 or required > total) return error.InvalidValue;
    }
    if (xs.len == 7 and (xs[6].data != .bytes or xs[6].data.bytes.len != 32)) return error.InvalidValue;
}

const Reader = struct {
    a: Allocator,
    data: []const u8,
    at: usize = 0,
    fn uint(r: *Reader) !u128 {
        var n: u128 = 0;
        var shift: u7 = 0;
        var count: usize = 0;
        while (r.at < r.data.len and count < 10) : (count += 1) {
            const b = r.data[r.at];
            r.at += 1;
            n |= @as(u128, b & 127) << shift;
            if (b < 128) {
                if (count > 0 and b == 0) return error.InvalidValue;
                return n;
            }
            shift += 7;
        }
        return error.InvalidValue;
    }
    fn bytes(r: *Reader) ![]const u8 {
        const n = try r.uint();
        if (n > r.data.len - r.at) return error.InvalidValue;
        const end = r.at + @as(usize, @intCast(n));
        const b = r.data[r.at..end];
        r.at = end;
        return b;
    }
    fn text(r: *Reader) ![]const u8 {
        const s = try r.bytes();
        if (!unicode.utf8.validate(s)) return error.InvalidValue;
        const normalized = try unicode.nfc(r.a, s);
        defer r.a.free(normalized);
        if (!std.mem.eql(u8, normalized, s)) return error.InvalidValue;
        return s;
    }
};
const Container = struct {
    tag: u8,
    remaining: usize,
    values: std.ArrayList(*Value) = .empty,
    fn deinit(c: *Container, a: Allocator) void {
        for (c.values.items) |v| v.release();
        c.values.deinit(a);
    }
};
fn finish(a: Allocator, c: *Container, resolver: display.Resolver) !*Value {
    const xs = c.values.items;
    switch (c.tag) {
        6 => return model.list(a, xs),
        7, 17 => {
            if (c.tag == 17 and !resolver.core_error) return error.InvalidValue;
            const pairs = try a.alloc(model.Pair, xs.len / 2);
            defer a.free(pairs);
            for (pairs, 0..) |*p, i| {
                if (xs[i * 2].data != .text) return error.InvalidValue;
                p.* = .{ .key = xs[i * 2].data.text, .value = xs[i * 2 + 1] };
            }
            if (c.tag == 17) {
                var has_message = false;
                for (pairs) |p| {
                    if (std.mem.eql(u8, p.key, "message") and p.value.data == .text) has_message = true;
                }
                if (!has_message) return error.InvalidValue;
            }
            const v = try model.map(a, pairs);
            v.core_message = c.tag == 17;
            return v;
        },
        9 => {
            if (xs[0].data != .number or xs[1].data != .text) return error.InvalidValue;
            const v = try model.quantity(a, xs[0].data.number, xs[1].data.text);
            errdefer v.release();
            if (v.data != .quantity) return error.InvalidValue;
            const unit = try v.data.quantity.unit.string(a, false);
            defer a.free(unit);
            if (!std.mem.eql(u8, unit, xs[1].data.text)) return error.InvalidValue;
            const before = try xs[0].data.number.string(a);
            defer a.free(before);
            const after = try v.data.quantity.number.string(a);
            defer a.free(after);
            if (!std.mem.eql(u8, before, after)) return error.InvalidValue;
            return v;
        },
        10 => return model.range(a, xs[0], xs[1]),
        14 => {
            if (xs[0].data != .text or xs[1].data != .text) return error.InvalidValue;
            const f = resolver.object orelse return error.InvalidValue;
            return f(resolver.context, xs[0].data.text, xs[1].data.text);
        },
        15, 19 => {
            try validateFunction(xs);
            const f = resolver.function_token orelse return error.InvalidValue;
            return f(resolver.context, xs[0].data.text, xs[1].data.text, xs[2].data.text);
        },
        else => return error.InvalidValue,
    }
}

pub const DecodeOptions = struct { resolver: display.Resolver = .{}, function_metadata: bool = false };

pub fn decode(a: Allocator, data: []const u8, options: DecodeOptions) !*Value {
    return decodeInner(a, data, options) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else err;
}

fn decodeInner(a: Allocator, data: []const u8, options: DecodeOptions) !*Value {
    const resolver = options.resolver;
    var r: Reader = .{ .a = a, .data = data };
    var stack: std.ArrayList(Container) = .empty;
    defer {
        for (stack.items) |*c| c.deinit(a);
        stack.deinit(a);
    }
    while (true) {
        if (r.at == data.len) return error.InvalidValue;
        const tag = data[r.at];
        r.at += 1;
        var children: ?usize = null;
        var v: ?*Value = null;
        errdefer if (v) |value| value.release();
        switch (tag) {
            0 => v = try model.scalar(a, .nothing),
            1, 2 => v = try model.scalar(a, .{ .bool = tag == 2 }),
            3, 16 => {
                const n = try r.uint();
                if ((tag == 3 and n > std.math.maxInt(u64)) or (tag == 16 and (n == 0 or n > @as(u128, 1) << 64))) return error.InvalidValue;
                v = try model.scalar(a, .{ .number = model.Decimal.fromInt(if (tag == 16) -@as(i128, @intCast(n)) else @as(i128, @intCast(n))) });
            },
            4 => {
                const s = try r.text();
                const n = try model.Decimal.parse(s);
                const canonical = try n.string(a);
                defer a.free(canonical);
                if (!std.mem.eql(u8, s, canonical)) return error.InvalidValue;
                if (n.exponent == 0 and ((!n.negative and n.coefficient <= std.math.maxInt(u64)) or (n.negative and n.coefficient <= @as(u128, 1) << 64))) return error.InvalidValue;
                v = try model.scalar(a, .{ .number = n });
            },
            5 => v = try model.text(a, try r.text()),
            6, 7, 17, 19 => {
                var n = try r.uint();
                if (tag == 19 and (!options.function_metadata or (n != 6 and n != 7))) return error.InvalidValue;
                if (tag == 7 or tag == 17) n *= 2;
                if (n > data.len - r.at) return error.InvalidValue;
                children = @intCast(n);
            },
            8 => v = try model.bytes(a, try r.bytes()),
            9, 10, 14 => children = 2,
            15 => children = 3,
            11 => {
                const u = try r.uint();
                if (u > std.math.maxInt(u64)) return error.InvalidValue;
                const n: i128 = @as(i128, @intCast(u >> 1)) ^ -@as(i128, @intCast(u & 1));
                const seconds = @divFloor(n, 1000000);
                if (seconds < -62135596800 or seconds > 253402300799) return error.InvalidValue;
                const t: model.dates.Instant = .{ .seconds = @intCast(seconds), .micros = @intCast(@mod(n, 1000000)) };
                try model.dates.validateInstant(t);
                v = try model.scalar(a, .{ .instant = t });
            },
            12 => {
                const s = try r.text();
                const d = try model.dates.parseCivil(s);
                const canonical = try model.dates.string(a, d, false);
                defer a.free(canonical);
                if (!std.mem.eql(u8, s, canonical)) return error.InvalidValue;
                v = try model.scalar(a, .{ .civil_date = d });
            },
            13 => {
                const s = try r.text();
                v = try @import("pattern.zig").parse(a, s);
                if (!std.mem.eql(u8, s, v.?.data.pattern)) return error.InvalidValue;
            },
            else => return error.InvalidValue,
        }
        if (children) |count| {
            if (count != 0) {
                try stack.append(a, .{ .tag = tag, .remaining = count });
                continue;
            }
            var c: Container = .{ .tag = tag, .remaining = 0 };
            v = try finish(a, &c, resolver);
        }
        while (true) {
            if (stack.items.len == 0) {
                if (r.at != data.len) return error.InvalidValue;
                return v.?;
            }
            const c = &stack.items[stack.items.len - 1];
            try c.values.append(a, v.?);
            v = null;
            c.remaining -= 1;
            if (c.remaining != 0) break;
            v = try finish(a, c, resolver);
            c.deinit(a);
            _ = stack.pop();
        }
    }
}

test "canonical binary integers and malformed input" {
    const a = std.testing.allocator;
    for ([_][]const u8{ &.{ 3, 0 }, &.{ 3, 128, 1 }, &.{ 16, 1 }, &.{ 16, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2 }, &.{ 4, 4, '1', '.', '2', '5' }, &.{ 4, 3, '0', '.', '0' }, &.{ 4, 4, '0', '.', '0', '0' }, &.{ 4, 4, '1', '.', '0', '0' } }) |wire| {
        const v = try decode(a, wire, .{});
        defer v.release();
        const back = try encode(a, v, .{});
        defer a.free(back);
        try std.testing.expectEqualSlices(u8, wire, back);
    }
    for ([_][]const u8{ &.{}, &.{ 3, 128, 0 }, &.{ 16, 0 }, &.{ 4, 1, '1' }, &.{ 0, 0 }, &.{ 5, 3, 'e', 0xcc, 0x81 }, &.{ 7, 2, 5, 1, 'a', 0, 5, 1, 'a', 0 }, &.{ 19, 3, 0, 0, 0 } }) |wire| {
        try std.testing.expectError(error.InvalidValue, decode(a, wire, .{}));
    }
}

test "binary deep containers have no fixed depth limit" {
    const a = std.testing.allocator;
    var wire: std.ArrayList(u8) = .empty;
    defer wire.deinit(a);
    for (0..20000) |_| try wire.appendSlice(a, &.{ 6, 1 });
    try wire.append(a, 0);
    const v = try decode(a, wire.items, .{});
    defer v.release();
    const back = try encode(a, v, .{});
    defer a.free(back);
    try std.testing.expectEqualSlices(u8, wire.items, back);
}

test "binary values preserve canonical forms and core error markers" {
    const a = std.testing.allocator;
    for ([_][]const u8{
        &.{0},                                                           &.{1},                &.{2},       &.{ 5, 2, 0xc3, 0xa9 },                                         &.{ 8, 2, 0, 255 },
        &.{ 9, 3, 2, 5, 2, 'm', 's' },                                   &.{ 10, 3, 1, 3, 3 }, &.{ 11, 1 }, &.{ 12, 10, '2', '0', '2', '6', '-', '1', '0', '-', '1', '8' }, &.{ 13, 7, '<', 'd', 'i', 'g', 'i', 't', '>' },
        &.{ 17, 1, 5, 7, 'm', 'e', 's', 's', 'a', 'g', 'e', 5, 1, 'x' },
    }) |wire| {
        const v = try decode(a, wire, .{ .resolver = .{ .core_error = true } });
        defer v.release();
        const back = try encode(a, v, .{ .core_errors = true });
        defer a.free(back);
        try std.testing.expectEqualSlices(u8, wire, back);
    }
    try std.testing.expectError(error.InvalidValue, decode(a, &.{ 17, 0 }, .{ .resolver = .{ .core_error = true } }));
    try std.testing.expectError(error.InvalidValue, decode(a, &.{ 17, 1, 5, 7, 'm', 'e', 's', 's', 'a', 'g', 'e', 5, 1, 'x' }, .{}));
}

test "binary decoder releases partially built containers on truncation" {
    const a = std.testing.allocator;
    const wire = [_]u8{ 6, 2, 8, 3, 1, 2, 3, 3, 244, 3 };
    for (0..wire.len) |end| try std.testing.expectError(error.InvalidValue, decode(a, wire[0..end], .{}));
}

test "binary allocation failure cleans every partially constructed value" {
    const Check = struct {
        fn run(a: Allocator) !void {
            const wire = [_]u8{ 7, 1, 5, 1, 'x', 6, 2, 8, 2, 0, 255, 9, 3, 2, 5, 2, 'm', 's' };
            const v = try decode(a, &wire, .{});
            defer v.release();
            const back = try encode(a, v, .{});
            defer a.free(back);
            try std.testing.expectEqualSlices(u8, &wire, back);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Check.run, .{});
}

//! Shared-vector semantic checks for the framing and Value codecs. Expected
//! fields come from reviewed JSON trees, never from another local writer.
const std = @import("std");
const rp = @import("request_pump.zig");
const env = @import("generated/envelope.zig");
const binary = @import("binary_value.zig");
const encoding = @import("encoding.zig");
const model = @import("value.zig");
const Json = std.json.Value;
const Allocator = std.mem.Allocator;

const Values = struct {
    a: Allocator,
    tokens: std.StringHashMap(usize),
    fn object(ctx: ?*anyopaque, kind: []const u8, id: []const u8) model.Error!*model.Value {
        const self: *Values = @ptrCast(@alignCast(ctx.?));
        return model.object(self.a, kind, id, 1);
    }
    fn function(ctx: ?*anyopaque, home: []const u8, display: []const u8, token: []const u8) model.Error!*model.Value {
        const self: *Values = @ptrCast(@alignCast(ctx.?));
        const entry = try self.tokens.getOrPut(token);
        if (!entry.found_existing) entry.value_ptr.* = self.tokens.count();
        const captures = try model.list(self.a, &.{});
        defer captures.release();
        return model.function(self.a, home, display, entry.value_ptr.*, captures);
    }
    fn payload(ctx: ?*anyopaque, a: Allocator, value: *const model.Value) !*model.Value {
        const self: *Values = @ptrCast(@alignCast(ctx.?));
        const f = value.data.function;
        var entries = self.tokens.iterator();
        const token = while (entries.next()) |e| {
            if (e.value_ptr.* == f.identity) break e.key_ptr.*;
        } else return error.InvalidValue;
        const home = try model.text(a, f.home);
        defer home.release();
        const display = try model.text(a, f.display);
        defer display.release();
        const handle = try model.text(a, token);
        defer handle.release();
        return model.list(a, &.{ home, display, handle });
    }
};

fn get(j: Json, name: []const u8) Json {
    return if (j == .object) j.object.get(name) orelse .null else .null;
}
fn entryFor(entries: []const env.Entry, tag: u8) !env.Entry {
    for (entries) |entry| if (entry.tag == tag) return entry;
    return error.UnknownTag;
}
fn equalName(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

pub fn check() !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const Vector = struct { name: []const u8, tag: u8, direction: []const u8, hex: []const u8, tree: []const u8 };
    const vectors = try std.json.parseFromSlice([]Vector, a, @embedFile("envelope-frames"), .{});
    for (vectors.value) |vector| {
        errdefer std.debug.print("shared vector: {s}\n", .{vector.name});
        const data = try a.alloc(u8, vector.hex.len / 2);
        _ = try std.fmt.hexToBytes(data, vector.hex);
        const entry = try entryFor(env.messages, vector.tag);
        try std.testing.expectEqualStrings(if (entry.direction == .host_to_guest) "host-to-guest" else "guest-to-host", vector.direction);
        const tree = (try std.json.parseFromSlice(Json, a, vector.tree, .{ .parse_numbers = false })).value;
        var flat: std.json.ObjectMap = .empty;
        var pairs = tree.object.iterator();
        while (pairs.next()) |pair| {
            if (equalName(pair.key_ptr.*, "need") or (equalName(pair.key_ptr.*, "ok") and get(tree, "m") == .null)) {
                var inner = pair.value_ptr.object.iterator();
                while (inner.next()) |p| try flat.put(a, p.key_ptr.*, p.value_ptr.*);
            } else try flat.put(a, pair.key_ptr.*, pair.value_ptr.*);
        }
        if (equalName(entry.name, "op-result") or equalName(entry.name, "prop-result")) {
            for ([_][]const u8{ "result", "value", "started", "done", "fail", "limit", "hostError", "ok" }) |outcome| {
                if (flat.get(outcome)) |value| {
                    try flat.put(a, "outcome", .{ .string = outcome });
                    if (equalName(outcome, "fail")) {
                        try flat.put(a, "value", get(value, "data"));
                        try flat.put(a, "code", get(value, "code"));
                        try flat.put(a, "message", get(value, "message"));
                    } else if (equalName(outcome, "result") or equalName(outcome, "value")) try flat.put(a, "value", value);
                    break;
                }
            }
        } else if (equalName(entry.name, "prop")) {
            try flat.put(a, "set", .{ .bool = flat.contains("value") });
            try flat.put(a, "object", get(flat.get("object").?, "$object"));
        }
        var values: Values = .{ .a = a, .tokens = std.StringHashMap(usize).init(a) };
        var r: rp.Reader = .{ .data = data, .at = 6 };
        var w = rp.Writer.init(a);
        try w.header();
        try w.byte(entry.tag);
        try record(a, &values, &w, &r, entry.fields, .{ .object = flat });
        try std.testing.expect(r.done());
        try std.testing.expectEqualSlices(u8, data, w.out.items);
    }
}

fn record(a: Allocator, values: *Values, w: *rp.Writer, r: *rp.Reader, fields: []const env.Field, expected: Json) anyerror!void {
    try std.testing.expectEqual(rp.tag.list, try r.byte());
    try std.testing.expectEqual(fields.len, try r.uint());
    try w.list(fields.len);
    for (fields) |field| {
        const value = get(expected, field.name);
        if (field.kind == .reports and value != .null) {
            try std.testing.expectEqual(rp.tag.list, try r.byte());
            const n = try r.uint();
            try std.testing.expectEqual(value.array.items.len, n);
            try w.list(n);
            for (value.array.items) |report| {
                const tag = try r.byte();
                const entry = try entryFor(env.reports, tag);
                try std.testing.expectEqualStrings(entry.name, get(report, "kind").string);
                try w.byte(tag);
                try record(a, values, w, r, entry.fields, report);
            }
        } else if (field.kind == .settlements and value != .null) {
            try std.testing.expectEqual(rp.tag.list, try r.byte());
            const n = try r.uint();
            try std.testing.expectEqual(value.array.items.len, n);
            try w.list(n);
            for (value.array.items) |settlement| try record(a, values, w, r, env.settlement, settlement);
        } else try item(a, values, w, try r.skip(), value, field.kind, field.name, "");
    }
}

fn item(a: Allocator, values: *Values, w: *rp.Writer, span: []const u8, expected: Json, kind: env.Kind, key: []const u8, parent: []const u8) anyerror!void {
    if (expected == .null) {
        try std.testing.expectEqualSlices(u8, &.{0}, span);
        try w.byte(0);
        return;
    }
    if (kind == .value) {
        const resolver: @import("display.zig").Resolver = .{ .context = values, .object = Values.object, .function_token = Values.function };
        const want = try encoding.decodeParsed(a, expected, resolver);
        defer want.release();
        const decoded = try binary.decode(a, span, .{ .resolver = resolver });
        defer decoded.release();
        try std.testing.expect(try want.equal(decoded));
        const canonical = try binary.encode(a, want, .{ .functions = .{ .context = values, .payload = Values.payload } });
        try std.testing.expectEqualSlices(u8, canonical, span);
        try binary.append(a, &w.out, decoded, .{ .functions = .{ .context = values, .payload = Values.payload } });
        return;
    }
    if (kind == .instant) {
        const got = try rp.instantOf(span);
        const want = try model.dates.parseInstant(expected.string);
        try std.testing.expectEqual(want, got);
        try w.instant(got);
        return;
    }
    if (expected == .object) {
        var r: rp.Reader = .{ .data = span };
        try std.testing.expectEqual(rp.tag.map, try r.byte());
        try std.testing.expectEqual(expected.object.count(), try r.uint());
        try w.begin(&.{}, false);
        var entries = expected.object.iterator();
        while (entries.next()) |pair| {
            try std.testing.expectEqual(rp.tag.text, try r.byte());
            const name = try r.bytes();
            try std.testing.expectEqualStrings(pair.key_ptr.*, name);
            try w.key(name);
            const nested: env.Kind = if (equalName(name, "args")) .values else if (equalName(name, "fn") or equalName(name, "result") or equalName(name, "error") or equalName(name, "object") or equalName(name, "target") or (equalName(name, "reason") and (equalName(key, "vetoes") or equalName(parent, "vetoes")))) .value else .record;
            try item(a, values, w, try r.skip(), pair.value_ptr.*, nested, name, key);
        }
        try w.end();
        try std.testing.expect(r.done());
        return;
    }
    if (expected == .array) {
        const xs = try rp.listOf(span, a);
        try std.testing.expectEqual(expected.array.items.len, xs.len);
        try w.list(xs.len);
        for (xs, expected.array.items) |x, e| try item(a, values, w, x, e, if (kind == .values) .value else .record, "", key);
        return;
    }
    switch (expected) {
        .string => |s| {
            const got = try rp.ptextOf(span);
            try std.testing.expectEqualStrings(s, got);
            try w.ptext(got);
        },
        .bool => |b| {
            try std.testing.expectEqualSlices(u8, &.{if (b) 2 else 1}, span);
            try w.byte(if (b) 2 else 1);
        },
        .number_string => |s| {
            if (kind == .uint) {
                const got = try rp.uintOf(span);
                try std.testing.expectEqual(try std.fmt.parseInt(u64, s, 10), got);
                try w.int(got);
            } else {
                const got = (try rp.intOf(span)).?;
                try std.testing.expectEqual(try std.fmt.parseInt(i64, s, 10), got);
                try w.int(got);
            }
        },
        else => return error.UnexpectedJson,
    }
}

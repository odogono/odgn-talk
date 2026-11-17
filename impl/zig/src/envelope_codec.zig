//! Decodes a message's generated record (generated/envelope.zig) from
//! either layout by walking its declaration at comptime (ADR 0183), so a
//! fields-layout frame and a JSON frame of the same message reach the
//! Message Layer as one typed value.
//!
//! Each record field's Zig type picks how it is read: `i64` is chapter 9's
//! integer, `[]const u8` protocol text, `?bool` a flag and
//! `?std.json.Value` an opaque tree the handler reads itself. A type a
//! record uses that has no reader here is a compile error, so a message
//! moved onto this codec can't silently skip a field.
const std = @import("std");
const envelope = @import("generated/envelope.zig");
const rp = @import("request_pump.zig");

const Allocator = std.mem.Allocator;
const Json = std.json.Value;

/// An integer a JSON frame spells, from its number text: a JSON integer,
/// or a string holding one (chapter 9's integer encoding).
pub fn jsonInt(j: Json) ?i64 {
    const text = switch (j) {
        .number_string => |s| s,
        .string => |s| s,
        .integer => |n| return n,
        else => return null,
    };
    return std.fmt.parseInt(i64, text, 10) catch null;
}

/// The record `T` from a JSON frame, or null when a required field is
/// absent or of another kind. A flag of another kind reads as absent, and
/// an opaque field keeps whatever the frame gave, `null` included.
pub fn fromJson(comptime T: type, msg: Json) ?T {
    if (msg != .object) return null;
    var out: T = undefined;
    const info = @typeInfo(T).@"struct";
    inline for (info.field_names, info.field_types) |name, F| {
        const given = msg.object.get(name);
        @field(out, name) = switch (F) {
            i64 => jsonInt(given orelse return null) orelse return null,
            []const u8 => if (given) |j| (if (j == .string) j.string else return null) else return null,
            ?bool => if (given) |j| (if (j == .bool) j.bool else null) else null,
            ?Json => given,
            else => @compileError("no JSON reader for " ++ @typeName(T) ++ "." ++ name),
        };
    }
    return out;
}

/// Why a fields-layout record was refused: the record itself, a required
/// integer or text, or an optional field's item.
pub const FieldsError = error{ Malformed, Trailing, NoInt, MissingText, NotProtocolText, BadItem, OutOfMemory };

/// The record `T` of `message` from its fields-layout payload (after the
/// tag byte). Required fields are checked in catalogue order before any
/// item is decoded, and `ref` is set as soon as a required `ref` is read,
/// so a later refusal can name it.
pub fn fromFields(comptime T: type, comptime message: rp.Message, a: Allocator, payload: []const u8, ref: *i64) FieldsError!T {
    const entry = comptime entryOf(message);
    var spans: [entry.fields.len]?[]const u8 = undefined;
    var r: rp.Reader = .{ .data = payload };
    r.record(rp.fields(message), true, &spans) catch return error.Malformed;
    if (!r.done()) return error.Trailing;
    var out: T = undefined;
    inline for (entry.fields, spans) |f, span| {
        if (!f.required) continue;
        switch (@FieldType(T, f.name)) {
            i64 => {
                @field(out, f.name) = (rp.intOf(span orelse return error.NoInt) catch null) orelse return error.NoInt;
                if (comptime std.mem.eql(u8, f.name, "ref")) ref.* = out.ref;
            },
            []const u8 => {
                const bytes = span orelse return error.MissingText;
                if (bytes[0] != rp.tag.protocol_text) return error.NotProtocolText;
            },
            else => @compileError("no required fields reader for " ++ @typeName(T) ++ "." ++ f.name),
        }
    }
    inline for (entry.fields, spans) |f, span| {
        switch (@FieldType(T, f.name)) {
            i64 => {},
            []const u8 => @field(out, f.name) = rp.ptextOf(span.?) catch return error.BadItem,
            ?bool => @field(out, f.name) = if (span) |bytes| switch (try item(a, bytes)) {
                .bool => |b| b,
                else => null,
            } else null,
            ?Json => @field(out, f.name) = if (span) |bytes| try item(a, bytes) else null,
            else => @compileError("no fields reader for " ++ @typeName(T) ++ "." ++ f.name),
        }
    }
    return out;
}

fn entryOf(comptime message: rp.Message) envelope.Entry {
    for (envelope.messages) |e| if (e.tag == @backingInt(message)) return e;
    unreachable;
}

fn item(a: Allocator, span: []const u8) FieldsError!Json {
    return protocolTree(a, span) catch |err| if (err == error.OutOfMemory) error.OutOfMemory else error.BadItem;
}

/// A fields-layout item of protocol items only (Load metadata) as the tree
/// its JSON spelling parses to, without JSON scanning or escaping. The work
/// list also handles hostile nesting without using the WASI stack.
pub fn protocolTree(a: Allocator, span: []const u8) rp.Error!Json {
    const Work = struct { span: []const u8, out: *Json };
    var result: Json = .null;
    var work: std.ArrayList(Work) = .empty;
    defer work.deinit(a);
    try work.append(a, .{ .span = span, .out = &result });
    while (work.pop()) |next| {
        var r: rp.Reader = .{ .data = next.span };
        switch (try r.byte()) {
            0 => next.out.* = .null,
            1 => next.out.* = .{ .bool = false },
            2 => next.out.* = .{ .bool = true },
            3 => {
                const n = try r.uint();
                next.out.* = if (n <= std.math.maxInt(i64)) .{ .integer = @intCast(n) } else .{ .number_string = try std.fmt.allocPrint(a, "{d}", .{n}) };
            },
            0x10 => {
                const n = (try rp.intOf(next.span)) orelse return error.Malformed;
                next.out.* = .{ .integer = n };
                r.at = r.data.len;
            },
            0x12 => {
                next.out.* = .{ .string = try rp.ptextOf(next.span) };
                r.at = r.data.len;
            },
            6 => {
                const n = try r.uint();
                if (n > r.data.len - r.at) return error.Malformed;
                var list = std.array_list.Managed(Json).init(a);
                try list.resize(@intCast(n));
                next.out.* = .{ .array = list };
                for (list.items) |*slot| try work.append(a, .{ .span = try r.skip(), .out = slot });
            },
            7 => {
                const n = try r.uint();
                if (n > (r.data.len - r.at) / 2) return error.Malformed;
                var map: std.json.ObjectMap = .empty;
                try map.ensureTotalCapacity(a, @intCast(n));
                for (0..@intCast(n)) |_| {
                    if (try r.byte() != rp.tag.text) return error.Malformed;
                    const key = try r.bytes();
                    if (!std.unicode.utf8ValidateSlice(key)) return error.Malformed;
                    const kv = try map.getOrPut(a, key);
                    if (kv.found_existing) return error.Malformed;
                    try work.append(a, .{ .span = try r.skip(), .out = kv.value_ptr });
                }
                next.out.* = .{ .object = map };
            },
            else => return error.Malformed,
        }
        if (!r.done()) return error.Malformed;
    }
    return result;
}

test "both layouts of each shared Load vector decode to the same typed Load" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const Vector = struct { name: []const u8, tag: ?u8 = null, direction: ?[]const u8 = null, hex: ?[]const u8 = null, tree: []const u8, message: ?[]const u8 = null, view: ?[]const u8 = null };
    const vectors = try std.json.parseFromSliceLeaky([]Vector, a, @embedFile("envelope-frames"), .{});
    var checked: usize = 0;
    for (vectors) |vector| {
        if (vector.tag != @backingInt(rp.Message.load)) continue;
        errdefer std.debug.print("Load vector: {s}\n", .{vector.name});
        const frame = try a.alloc(u8, vector.hex.?.len / 2);
        _ = try std.fmt.hexToBytes(frame, vector.hex.?);
        var ref: i64 = 0;
        const from_fields = try fromFields(envelope.Load, .load, a, frame[rp.prefix.len + 2 ..], &ref);
        const tree = try std.json.parseFromSliceLeaky(Json, a, vector.tree, .{ .parse_numbers = false });
        const from_json = fromJson(envelope.Load, tree).?;
        try std.testing.expectEqual(from_json.ref, ref);
        const options: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };
        try std.testing.expectEqualStrings(
            try std.json.Stringify.valueAlloc(a, from_json, options),
            try std.json.Stringify.valueAlloc(a, from_fields, options),
        );
        checked += 1;
    }
    try std.testing.expect(checked >= 2);
}

test "a fields-layout Load names what it lacks, in catalogue order" {
    const a = std.testing.allocator;
    var ref: i64 = 0;
    // A positional record of the right width, every item Nothing.
    var w = rp.Writer.init(a);
    defer w.out.deinit(a);
    try w.list(rp.fields(rp.Message.load).len);
    for (rp.fields(rp.Message.load)) |_| try w.byte(rp.tag.nothing);
    try std.testing.expectError(error.NoInt, fromFields(envelope.Load, .load, a, w.out.items, &ref));
    try std.testing.expectError(error.Malformed, fromFields(envelope.Load, .load, a, &.{rp.tag.list}, &ref));
}

test "a JSON Load lacking a required field is no record; a mistyped flag reads as absent" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const missing = try std.json.parseFromSliceLeaky(Json, a, "{\"ref\":1,\"group\":\"g\",\"name\":\"s\"}", .{ .parse_numbers = false });
    try std.testing.expect(fromJson(envelope.Load, missing) == null);
    const flag = try std.json.parseFromSliceLeaky(Json, a, "{\"ref\":\"2\",\"group\":\"g\",\"name\":\"s\",\"source\":\"\",\"grantsAsUsed\":1,\"owner\":null}", .{ .parse_numbers = false });
    const load = fromJson(envelope.Load, flag).?;
    try std.testing.expectEqual(@as(i64, 2), load.ref);
    try std.testing.expect(load.grantsAsUsed == null);
    try std.testing.expect(load.owner.? == .null);
}

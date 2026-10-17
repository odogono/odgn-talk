//! Chapter 9's deterministic, lossless JSON Value Encoding. Values are
//! written and built from heap work lists, so nesting is bounded by memory
//! rather than the native stack; decimal tokens never pass through binary
//! floats.
const std = @import("std");
const model = @import("value.zig");
const display = @import("display.zig");
const Value = model.Value;
const Json = std.json.Value;
/// Every refusal the writer can report, including the writer's own failure.
pub const Error = model.Error || error{WriteFailed};
/// 2^53: integers below it in magnitude are plain JSON numbers, which every
/// JSON reader holds exactly; larger ones and fractions are `$dec`.
pub const plain_integer_limit: u128 = 9007199254740992;
pub fn quoted(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| switch (c) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        0...31 => try w.print("\\u00{x:0>2}", .{c}),
        else => try w.writeByte(c),
    };
    try w.writeByte('"');
}
fn tag(w: *std.Io.Writer, name: []const u8) !void {
    try w.writeAll("{\"$");
    try w.writeAll(name);
    try w.writeAll("\":");
}
/// One step of writing a container: a value, literal punctuation, or a
/// quoted key.
const Step = union(enum) { value: *const Value, punctuation: []const u8, key: []const u8 };

/// How the message layer writes a Function Value; storage has none.
pub const FunctionWriter = struct {
    context: ?*anyopaque,
    write: *const fn (?*anyopaque, *std.Io.Writer, *const Value) Error!void,
};

/// Writes `v`'s Value Encoding. A Function at any depth is NotEncodable.
pub fn write(w: *std.Io.Writer, root: *const Value) Error!void {
    return writeWith(w, root, null);
}

/// Writes `v`'s Value Encoding, each Function through `functions`, or
/// NotEncodable without it.
pub fn writeWith(w: *std.Io.Writer, root: *const Value, functions: ?FunctionWriter) Error!void {
    return writeWire(w, root, functions, false);
}

/// Message Layer encoding with optional Core-message provenance. Storage and
/// ordinary Value Encoding never carry this metadata.
pub fn writeWire(w: *std.Io.Writer, root: *const Value, functions: ?FunctionWriter, core_messages: bool) Error!void {
    const gpa = root.allocator;
    var steps: std.ArrayList(Step) = .empty;
    defer steps.deinit(gpa);
    try steps.append(gpa, .{ .value = root });
    while (steps.pop()) |step| switch (step) {
        .punctuation => |p| try w.writeAll(p),
        .key => |k| try quoted(w, k),
        .value => |v| try writeOne(w, v, gpa, &steps, functions, core_messages),
    };
}

/// Writes a scalar, or opens a container and pushes its parts last first.
fn writeOne(w: *std.Io.Writer, v: *const Value, gpa: std.mem.Allocator, steps: *std.ArrayList(Step), functions: ?FunctionWriter, core_messages: bool) Error!void {
    const a = v.allocator;
    switch (v.data) {
        .nothing => try w.writeAll("null"),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .text => |s| try quoted(w, s),
        .number => |n| {
            const s = try n.string(a);
            defer a.free(s);
            if (n.exponent == 0 and n.coefficient < plain_integer_limit) try w.writeAll(s) else {
                try tag(w, "dec");
                try quoted(w, s);
                try w.writeByte('}');
            }
        },
        .quantity => |q| {
            const s = try q.number.string(a);
            defer a.free(s);
            const u = try q.unit.string(a, false);
            defer a.free(u);
            try tag(w, "quantity");
            try w.writeByte('[');
            try quoted(w, s);
            try w.writeByte(',');
            try quoted(w, u);
            try w.writeAll("]}");
        },
        .bytes => |b| {
            const codec = std.base64.standard.Encoder;
            const out = try a.alloc(u8, codec.calcSize(b.len));
            defer a.free(out);
            const encoded = codec.encode(out, b);
            try tag(w, "bytes");
            try quoted(w, encoded);
            try w.writeByte('}');
        },
        .list => |xs| {
            try w.writeByte('[');
            try steps.ensureUnusedCapacity(gpa, 2 * xs.len + 1);
            steps.appendAssumeCapacity(.{ .punctuation = "]" });
            var i = xs.len;
            while (i > 0) {
                i -= 1;
                steps.appendAssumeCapacity(.{ .value = xs[i] });
                if (i > 0) steps.appendAssumeCapacity(.{ .punctuation = "," });
            }
        },
        .map => |xs| {
            if (core_messages and v.core_message) {
                try tag(w, "coreMessage");
                try steps.append(gpa, .{ .punctuation = "}" });
            }
            var escaped = false;
            for (0..xs.len) |map_index| {
                const p = xs.at(map_index);
                if (p.key.len > 0 and p.key[0] == '$') {
                    escaped = true;
                    break;
                }
            }
            if (escaped) {
                try tag(w, "map");
                try w.writeByte('[');
            } else try w.writeByte('{');
            try steps.ensureUnusedCapacity(gpa, 6 * xs.len + 1);
            steps.appendAssumeCapacity(.{ .punctuation = if (escaped) "]}" else "}" });
            var i = xs.len;
            while (i > 0) {
                i -= 1;
                const p = xs.at(i);
                if (escaped) steps.appendAssumeCapacity(.{ .punctuation = "]" });
                steps.appendAssumeCapacity(.{ .value = p.value });
                steps.appendAssumeCapacity(.{ .punctuation = if (escaped) "," else ":" });
                steps.appendAssumeCapacity(.{ .key = p.key });
                if (escaped) steps.appendAssumeCapacity(.{ .punctuation = "[" });
                if (i > 0) steps.appendAssumeCapacity(.{ .punctuation = "," });
            }
        },
        .range => |r| {
            try tag(w, "range");
            try w.writeByte('[');
            try steps.ensureUnusedCapacity(gpa, 4);
            steps.appendAssumeCapacity(.{ .punctuation = "]}" });
            steps.appendAssumeCapacity(.{ .value = r.to });
            steps.appendAssumeCapacity(.{ .punctuation = "," });
            steps.appendAssumeCapacity(.{ .value = r.from });
        },
        .civil_date => |f| {
            const s = try model.dates.string(a, f, false);
            defer a.free(s);
            try tag(w, "date");
            try quoted(w, s);
            try w.writeByte('}');
        },
        .instant => |t| {
            const s = try model.dates.string(a, model.dates.fields(t), true);
            defer a.free(s);
            try tag(w, "instant");
            try quoted(w, s);
            try w.writeByte('}');
        },
        .pattern => |s| {
            try tag(w, "pattern");
            try quoted(w, s);
            try w.writeByte('}');
        },
        .object => |o| {
            try tag(w, "object");
            try w.writeByte('[');
            try quoted(w, o.kind);
            try w.writeByte(',');
            try quoted(w, o.id);
            try w.writeAll("]}");
        },
        .function => {
            const f = functions orelse return error.NotEncodable;
            try f.write(f.context, w, v);
        },
    }
}
/// `v`'s Value Encoding, owned by the caller.
pub fn encode(a: std.mem.Allocator, v: *const Value) Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    write(&out.writer, v) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else err;
    return out.toOwnedSlice();
}
fn string(j: Json) model.Error![]const u8 {
    return if (j == .string) j.string else error.InvalidValue;
}
fn pair(j: Json) model.Error![]Json {
    if (j != .array or j.array.items.len != 2) return error.InvalidValue;
    return j.array.items;
}
/// Writes a leaf as the input spelled it: a plain number's text, or a tag
/// whose payload is a string or a pair of strings. Escapes are JSON syntax, so
/// they are compared decoded.
fn writeSpelled(w: *std.Io.Writer, name: []const u8, payload: Json) !void {
    if (name.len == 0) return w.writeAll(payload.number_string);
    try tag(w, name[1..]);
    switch (payload) {
        .string => |text| try quoted(w, text),
        .array => |array| {
            try w.writeByte('[');
            for (array.items, 0..) |item, i| {
                if (i > 0) try w.writeByte(',');
                try quoted(w, item.string);
            }
            try w.writeByte(']');
        },
        else => unreachable,
    }
    try w.writeByte('}');
}
/// Takes ownership of a decoded leaf and refuses it, releasing it, unless
/// encoding it gives back exactly what the input spelled: decoding accepts
/// only the forms the encoder writes (chapter 9).
fn canonical(a: std.mem.Allocator, v: *Value, name: []const u8, payload: Json) model.Error!*Value {
    errdefer v.release();
    const actual = encode(a, v) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    defer a.free(actual);
    var spelled: std.Io.Writer.Allocating = .init(a);
    defer spelled.deinit();
    writeSpelled(&spelled.writer, name, payload) catch return error.OutOfMemory;
    if (!std.mem.eql(u8, actual, spelled.written())) return error.InvalidValue;
    return v;
}
/// Which JSON a builder reads: the Value Encoding, or chapter 7's plain JSON.
const Mode = enum { encoding, plain };

/// A list, map or range whose children are still being built.
const Building = struct {
    kind: enum { list, map, range },
    /// Items, a range's two ends, a plain map's member values, or a `$map`
    /// payload's `[key, value]` pairs.
    children: []const Json,
    /// A plain map's member names.
    keys: []const []const u8 = &.{},
    tagged: bool = false,
    next: usize = 0,
    key: []const u8 = "",
    escaped: bool = false,
    items: std.ArrayList(*Value) = .empty,
    pairs: std.ArrayList(model.Pair) = .empty,

    fn deinit(b: *Building, a: std.mem.Allocator) void {
        for (b.items.items) |v| v.release();
        b.items.deinit(a);
        for (b.pairs.items) |p| p.value.release();
        b.pairs.deinit(a);
    }
};

/// A leaf's value, or a container to build from its children.
const Start = union(enum) { value: *Value, building: Building };

/// Builds a Value from parsed JSON. Containers wait on a heap stack.
fn build(a: std.mem.Allocator, root: Json, r: display.Resolver, mode: Mode) model.Error!*Value {
    var stack: std.ArrayList(Building) = .empty;
    defer {
        for (stack.items) |*b| b.deinit(a);
        stack.deinit(a);
    }
    var next = try startValue(a, root, r, mode);
    while (true) {
        var v = switch (next) {
            .value => |v| v,
            .building => |b| {
                try stack.append(a, b);
                next = try startValue(a, try nextChild(&stack.items[stack.items.len - 1], mode), r, mode);
                continue;
            },
        };
        // Hand the value to the container it belongs to, finishing each
        // container whose last child it is.
        while (true) {
            if (stack.items.len == 0) return v;
            const top = &stack.items[stack.items.len - 1];
            switch (top.kind) {
                .list, .range => top.items.append(a, v) catch {
                    v.release();
                    return error.OutOfMemory;
                },
                .map => top.pairs.append(a, .{ .key = top.key, .value = v }) catch {
                    v.release();
                    return error.OutOfMemory;
                },
            }
            if (top.next < top.children.len) {
                next = try startValue(a, try nextChild(top, mode), r, mode);
                break;
            }
            v = switch (top.kind) {
                .list => try model.list(a, top.items.items),
                .range => try model.range(a, top.items.items[0], top.items.items[1]),
                .map => blk: {
                    if (top.tagged and !top.escaped) return error.InvalidValue;
                    break :blk try model.map(a, top.pairs.items);
                },
            };
            var done = stack.pop().?;
            done.deinit(a);
        }
    }
}

/// The next child to build, its map key checked and noted.
fn nextChild(b: *Building, mode: Mode) model.Error!Json {
    const i = b.next;
    b.next += 1;
    if (b.kind != .map) return b.children[i];
    if (b.tagged) {
        const p = try pair(b.children[i]);
        const k = try string(p[0]);
        if (k.len > 0 and k[0] == '$') b.escaped = true;
        b.key = k;
        return p[1];
    }
    const k = b.keys[i];
    switch (mode) {
        .encoding => if (k.len > 0 and k[0] == '$') return error.InvalidValue,
        .plain => if (!@import("unicode/utf8.zig").validate(k)) return error.InvalidValue,
    }
    b.key = k;
    return b.children[i];
}

fn startValue(a: std.mem.Allocator, j: Json, r: display.Resolver, mode: Mode) model.Error!Start {
    switch (j) {
        .array => |array| {
            if (array.items.len == 0) return .{ .value = try model.list(a, &.{}) };
            return .{ .building = .{ .kind = .list, .children = array.items } };
        },
        .object => |object| {
            if (mode == .encoding and object.count() == 1) {
                const name = object.keys()[0];
                const payload = object.values()[0];
                if (std.mem.eql(u8, name, "$range")) return .{ .building = .{ .kind = .range, .children = try pair(payload) } };
                if (std.mem.eql(u8, name, "$map")) {
                    if (payload != .array) return error.InvalidValue;
                    // A map with no `$` key is written as a plain object.
                    if (payload.array.items.len == 0) return error.InvalidValue;
                    return .{ .building = .{ .kind = .map, .children = payload.array.items, .tagged = true } };
                }
                if (name.len > 0 and name[0] == '$') return .{ .value = try taggedLeaf(a, name, payload, r) };
            }
            if (object.count() == 0) return .{ .value = try model.map(a, &.{}) };
            return .{ .building = .{ .kind = .map, .children = object.values(), .keys = object.keys() } };
        },
        else => return .{ .value = try switch (mode) {
            .encoding => fromJsonLeaf(a, j),
            .plain => fromPlainLeaf(a, j),
        } },
    }
}

fn fromJsonLeaf(a: std.mem.Allocator, j: Json) model.Error!*Value {
    return switch (j) {
        .null => model.scalar(a, .nothing),
        .bool => |b| model.scalar(a, .{ .bool = b }),
        .string => |s| model.text(a, s),
        .number_string => |s| canonical(a, try model.scalar(a, .{ .number = try model.Decimal.parse(s) }), "", j),
        else => error.InvalidValue,
    };
}

/// A one-member object whose name is a `$` tag other than `$range` or
/// `$map`. An unknown tag is refused, as a plain object's `$` key is.
fn taggedLeaf(a: std.mem.Allocator, name: []const u8, payload: Json, r: display.Resolver) model.Error!*Value {
    if (std.mem.eql(u8, name, "$dec")) return canonical(a, try model.scalar(a, .{ .number = try model.Decimal.parse(try string(payload)) }), name, payload);
    if (std.mem.eql(u8, name, "$quantity")) {
        const p = try pair(payload);
        return canonical(a, try model.quantity(a, try model.Decimal.parse(try string(p[0])), try string(p[1])), name, payload);
    }
    if (std.mem.eql(u8, name, "$date")) return canonical(a, try model.scalar(a, .{ .civil_date = try model.dates.parseCivil(try string(payload)) }), name, payload);
    if (std.mem.eql(u8, name, "$instant")) return canonical(a, try model.scalar(a, .{ .instant = try model.dates.parseInstant(try string(payload)) }), name, payload);
    if (std.mem.eql(u8, name, "$bytes")) {
        const s = try string(payload);
        const decoder = std.base64.standard.Decoder;
        const len = decoder.calcSizeForSlice(s) catch return error.InvalidValue;
        const b = try a.alloc(u8, len);
        defer a.free(b);
        decoder.decode(b, s) catch return error.InvalidValue;
        return canonical(a, try model.bytes(a, b), name, payload);
    }
    if (std.mem.eql(u8, name, "$object")) {
        const p = try pair(payload);
        const resolve = r.object orelse return error.InvalidValue;
        return resolve(r.context, try string(p[0]), try string(p[1]));
    }
    if (std.mem.eql(u8, name, "$function")) {
        const resolve = r.function_token orelse return error.InvalidValue;
        if (payload != .array) return error.InvalidValue;
        const parts = payload.array.items;
        if (parts.len != 3 and parts.len != 6 and parts.len != 7) return error.InvalidValue;
        if (parts.len >= 6) {
            if (parts[3] != .null and parts[3] != .string) return error.InvalidValue;
            // Metadata is descriptive; only the token resolves the Function.
            const required = try functionArity(parts[4]);
            const total = try functionArity(parts[5]);
            if (required > total) return error.InvalidValue;
        }
        if (parts.len == 7) {
            const unit = try decodeParsed(a, parts[6], .{});
            defer unit.release();
            if (unit.data != .bytes or unit.data.bytes.len != 32) return error.InvalidValue;
        }
        return resolve(r.context, try string(parts[0]), try string(parts[1]), try string(parts[2]));
    }
    if (std.mem.eql(u8, name, "$sessionFunction")) {
        const resolve = r.session_function orelse return error.InvalidValue;
        return resolve(r.context, try string(payload));
    }
    if (std.mem.eql(u8, name, "$pattern")) {
        return canonical(a, try @import("pattern.zig").parse(a, try string(payload)), name, payload);
    }
    return error.InvalidValue;
}

fn functionArity(j: Json) model.Error!u64 {
    return switch (j) {
        .integer => |n| if (n >= 0) @intCast(n) else error.InvalidValue,
        .number_string => |s| std.fmt.parseInt(u64, s, 10) catch error.InvalidValue,
        else => error.InvalidValue,
    };
}
/// Reads one Value Encoding, refusing invalid UTF-8, duplicate keys,
/// unknown tags and any number, tag or payload
/// the encoder would not write. JSON white space and string escapes are
/// syntax, and text is normalised to NFC as `talk_text` does. Host Objects
/// come from `r`.
pub fn decode(a: std.mem.Allocator, s: []const u8, r: display.Resolver) model.Error!*Value {
    if (!@import("unicode/utf8.zig").validate(s)) return error.InvalidValue;
    const parsed = std.json.parseFromSlice(Json, a, s, .{ .parse_numbers = false, .duplicate_field_behavior = .@"error" }) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    defer parsed.deinit();
    return decodeParsed(a, parsed.value, r);
}

/// Builds a Value directly from a parsed frame, without recursively writing
/// and reparsing its JSON. The caller owns the JSON; the Value owns its data.
pub fn decodeParsed(a: std.mem.Allocator, j: Json, r: display.Resolver) model.Error!*Value {
    return build(a, j, r, .encoding);
}
/// Chapter 7's JSON mapping, the one rule for plain JSON that the `json`
/// Library follows too: a text's `"` and `\`, its short escapes and its
/// other characters below U+0020 escaped, every other character as itself.
fn plainQuoted(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| switch (c) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        8 => try w.writeAll("\\b"),
        9 => try w.writeAll("\\t"),
        10 => try w.writeAll("\\n"),
        12 => try w.writeAll("\\f"),
        13 => try w.writeAll("\\r"),
        0...7, 11, 14...31 => try w.print("\\u00{x:0>2}", .{c}),
        else => try w.writeByte(c),
    };
    try w.writeByte('"');
}
fn writePlain(w: *std.Io.Writer, root: *const Value) Error!void {
    const gpa = root.allocator;
    var steps: std.ArrayList(Step) = .empty;
    defer steps.deinit(gpa);
    try steps.append(gpa, .{ .value = root });
    while (steps.pop()) |step| switch (step) {
        .punctuation => |p| try w.writeAll(p),
        .key => |k| try plainQuoted(w, k),
        .value => |v| switch (v.data) {
            .nothing => try w.writeAll("null"),
            .bool => |b| try w.writeAll(if (b) "true" else "false"),
            .number => |n| {
                const s = try n.string(v.allocator);
                defer v.allocator.free(s);
                try w.writeAll(s);
            },
            .text => |s| try plainQuoted(w, s),
            .list => |xs| {
                try w.writeByte('[');
                try steps.ensureUnusedCapacity(gpa, 2 * xs.len + 1);
                steps.appendAssumeCapacity(.{ .punctuation = "]" });
                var i = xs.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = xs[i] });
                    if (i > 0) steps.appendAssumeCapacity(.{ .punctuation = "," });
                }
            },
            .map => |xs| {
                try w.writeByte('{');
                try steps.ensureUnusedCapacity(gpa, 4 * xs.len + 1);
                steps.appendAssumeCapacity(.{ .punctuation = "}" });
                var i = xs.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = xs.at(i).value });
                    steps.appendAssumeCapacity(.{ .punctuation = ":" });
                    steps.appendAssumeCapacity(.{ .key = xs.at(i).key });
                    if (i > 0) steps.appendAssumeCapacity(.{ .punctuation = "," });
                }
            },
            else => return error.NotEncodable,
        },
    };
}
/// `v` as compact plain JSON, owned by the caller. A kind JSON has no form
/// for, at any depth, is NotEncodable (chapter 7, Encoding).
pub fn encodeJson(a: std.mem.Allocator, v: *const Value) Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    writePlain(&out.writer, v) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else err;
    return out.toOwnedSlice();
}
/// A JSON number read exactly: its exponent applied, and a positive result
/// exponent rescaled to 0, so `1e5` is 100000 and `2.50e1` is 25.0. One past
/// the number limits is InvalidValue (chapter 7, Decoding).
fn plainNumber(a: std.mem.Allocator, s: []const u8) model.Error!model.Decimal {
    var i: usize = 0;
    const negative = s[0] == '-';
    if (negative) i += 1;
    const whole_start = i;
    while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
    const whole = s[whole_start..i];
    var fraction: []const u8 = "";
    if (i < s.len and s[i] == '.') {
        const start = i + 1;
        i = start;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        fraction = s[start..i];
    }
    var exp_negative = false;
    var exp_digits: []const u8 = "";
    if (i < s.len and (s[i] == 'e' or s[i] == 'E')) {
        i += 1;
        if (s[i] == '+' or s[i] == '-') {
            exp_negative = s[i] == '-';
            i += 1;
        }
        exp_digits = std.mem.trimStart(u8, s[i..], "0");
    }
    const digits = try std.mem.concat(a, u8, &.{ whole, fraction });
    defer a.free(digits);
    const significant = std.mem.trimStart(u8, digits, "0");
    if (exp_digits.len > 9) {
        if (significant.len == 0 and !exp_negative) return model.Decimal.parse("0");
        return error.InvalidValue;
    }
    var e: i64 = if (exp_digits.len == 0) 0 else std.fmt.parseInt(i64, exp_digits, 10) catch unreachable;
    if (exp_negative) e = -e;
    const q = e - @as(i64, @intCast(fraction.len));
    if (significant.len == 0 and q >= 0) return model.Decimal.parse("0");
    if (significant.len > 34) return error.InvalidValue;
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(a);
    if (negative) try text.append(a, '-');
    if (q >= 0) {
        if (significant.len + @as(usize, @intCast(q)) > 34) return error.InvalidValue;
        try text.appendSlice(a, significant);
        try text.appendNTimes(a, '0', @intCast(q));
    } else {
        if (-q > 6176) return error.InvalidValue;
        const places: usize = @intCast(-q);
        // The whole part keeps one digit, a zero if it has no other.
        const kept = significant[0..@min(significant.len, significant.len -| places)];
        if (kept.len == 0) try text.append(a, '0') else try text.appendSlice(a, kept);
        try text.append(a, '.');
        if (places > significant.len) try text.appendNTimes(a, '0', places - significant.len);
        try text.appendSlice(a, significant[kept.len..]);
    }
    return model.Decimal.parse(text.items);
}
fn fromPlainLeaf(a: std.mem.Allocator, j: Json) model.Error!*Value {
    return switch (j) {
        .null => model.scalar(a, .nothing),
        .bool => |b| model.scalar(a, .{ .bool = b }),
        .string => |s| {
            if (!@import("unicode/utf8.zig").validate(s)) return error.InvalidValue;
            return model.text(a, s);
        },
        .number_string => |s| model.scalar(a, .{ .number = try plainNumber(a, s) }),
        else => error.InvalidValue,
    };
}
/// Reads one plain JSON value by chapter 7's mapping: numbers exactly, text
/// normalised to NFC, and an object's members in order. Invalid JSON, a lone
/// surrogate, two names equal after NFC and a number past the limits are
/// InvalidValue.
pub fn decodeJson(a: std.mem.Allocator, s: []const u8) model.Error!*Value {
    if (!@import("unicode/utf8.zig").validate(s)) return error.InvalidValue;
    const parsed = std.json.parseFromSlice(Json, a, s, .{ .parse_numbers = false, .duplicate_field_behavior = .@"error" }) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    defer parsed.deinit();
    return build(a, parsed.value, .{}, .plain);
}
test "lossless encoding, escaping, map tags and strict Base64" {
    const a = std.testing.allocator;
    const cases = .{
        .{ "7.50", "{\"$dec\":\"7.50\"}" },                                                                                                        .{ "9007199254740992", "{\"$dec\":\"9007199254740992\"}" },                       .{ "{\"$ref\": 1}", "{\"$map\":[[\"$ref\",1]]}" },
        .{ "[<<0xFB, 0xFF>>, 3 m..7 cm]", "[{\"$bytes\":\"+/8=\"},{\"$range\":[{\"$quantity\":[\"3\",\"m\"]},{\"$quantity\":[\"7\",\"cm\"]}]}]" }, .{ "newline & tab & fromCodePoint(0) & quote", "\"\\u000a\\u0009\\u0000\\\"\"" },
    };
    inline for (cases) |c| {
        const v = try display.parse(a, c[0], .{});
        defer v.release();
        const s = try encode(a, v);
        defer a.free(s);
        try std.testing.expectEqualStrings(c[1], s);
        const copy = try decode(a, s, .{});
        defer copy.release();
        try std.testing.expect(try v.equal(copy));
        const again = try encode(a, copy);
        defer a.free(again);
        try std.testing.expectEqualStrings(s, again);
    }
    for ([_][]const u8{ "{\"$bytes\":\"AB==\"}", "{\"$bytes\":\"AQ\"}", "{\"$bytes\":\"AQ===\"}", "{\"$wat\":0}", "{\"a\":1,\"a\":2}", "{\"$range\":[1,true]}" }) |s| try std.testing.expectError(error.InvalidValue, decode(a, s, .{}));
    const unclosed = try a.alloc(u8, 300);
    defer a.free(unclosed);
    @memset(unclosed, '[');
    try std.testing.expectError(error.InvalidValue, decode(a, unclosed, .{}));
}

fn allocationRoundTrip(a: std.mem.Allocator) !void {
    const v = try display.parse(a, "{\"$key\": [\"é\" & quote, <<0x01>>, 2.50 GBP, 2026-09-27]}", .{});
    defer v.release();
    const encoded = try encode(a, v);
    defer a.free(encoded);
    const copy = try decode(a, encoded, .{});
    defer copy.release();
    const rendered = try display.string(a, copy);
    defer a.free(rendered);
    const reparsed = try display.parse(a, rendered, .{});
    defer reparsed.release();
    try std.testing.expect(try v.equal(reparsed));
}
/// Passes allocations through but never grows or shrinks one in place.
/// Whether the testing allocator can resize in place depends on where it
/// placed the block, which varies between runs on some platforms (macOS);
/// a growth that can't becomes one more allocation, and
/// `checkAllAllocationFailures` needs the same allocations every run.
const NoInPlaceResize = struct {
    child: std.mem.Allocator,

    fn allocator(n: *NoInPlaceResize) std.mem.Allocator {
        return .{ .ptr = n, .vtable = &.{ .alloc = alloc, .resize = std.mem.Allocator.noResize, .remap = std.mem.Allocator.noRemap, .free = free } };
    }
    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const n: *NoInPlaceResize = @ptrCast(@alignCast(ctx));
        return n.child.rawAlloc(len, alignment, ra);
    }
    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const n: *NoInPlaceResize = @ptrCast(@alignCast(ctx));
        n.child.rawFree(memory, alignment, ra);
    }
};

test "every allocation failure cleans up partially built values" {
    var fixed: NoInPlaceResize = .{ .child = std.testing.allocator };
    try std.testing.checkAllAllocationFailures(fixed.allocator(), allocationRoundTrip, .{});
    for ([_][]const u8{ "{a: 1,}", "{a: 1 broken}", "[1,]", "{a: [1, 2}" }) |s| try std.testing.expectError(error.InvalidValue, display.parse(std.testing.allocator, s, .{}));
}

fn testResolveObject(context: ?*anyopaque, kind: []const u8, id: []const u8) model.Error!*Value {
    const v: *Value = @ptrCast(@alignCast(context.?));
    if (!std.mem.eql(u8, kind, v.data.object.kind) or !std.mem.eql(u8, id, v.data.object.id)) return error.InvalidValue;
    return v.retain();
}
test "pattern and object encoding round trips; functions including nested are refused" {
    const a = std.testing.allocator;
    const pattern = try @import("pattern.zig").parse(a, "<\"ID-\", 4 digits>");
    defer pattern.release();
    const object = try model.object(a, "item", "object-slot-183", 42);
    defer object.release();
    const object_list = try model.list(a, &.{ object, pattern });
    defer object_list.release();
    const encoded = try encode(a, object_list);
    defer a.free(encoded);
    try std.testing.expectEqualStrings("[{\"$object\":[\"item\",\"object-slot-183\"]},{\"$pattern\":\"<\\\"ID-\\\", 4 digits>\"}]", encoded);
    const copy = try decode(a, encoded, .{ .context = object, .object = testResolveObject });
    defer copy.release();
    try std.testing.expect(try object_list.equal(copy));
    const captures = try model.map(a, &.{});
    defer captures.release();
    const function = try model.function(a, "weather", "<function weather:tax>", 7, captures);
    defer function.release();
    const source = try display.string(a, function);
    defer a.free(source);
    try std.testing.expectEqualStrings("<function weather:tax>", source);
    try std.testing.expectError(error.NotEncodable, encode(a, function));
    const nested = try model.list(a, &.{function});
    defer nested.release();
    try std.testing.expectError(error.NotEncodable, encode(a, nested));
    try std.testing.expectError(error.InvalidValue, decode(a, "{\"$pattern\":\"<nonsense>\"}", .{}));
    try std.testing.expectError(error.InvalidValue, decode(a, "{\"$object\":[\"item\",\"missing\"]}", .{ .context = object, .object = testResolveObject }));
}

test "decoding refuses every form the encoder would not write" {
    // Session references are Transcript-only, never durable Value Encoding
    // or Message Layer Function tokens.
    try std.testing.expectError(error.InvalidValue, decode(std.testing.allocator, "{\"$sessionFunction\":\"f1\"}", .{}));
    const noncanonical = [_][]const u8{
        "{\"$dec\":\"0x0A\"}",                         "{\"$dec\":\"01\"}",
        "{\"$dec\":\"3\"}",                            "{\"$dec\":\"-9007199254740991\"}",
        "1.0",                                         "-0",
        "1e2",                                         "01",
        "{\"$quantity\":[\"3\",\"days\"]}",            "{\"$quantity\":[\"1\",\"m/m\"]}",
        "{\"$quantity\":[\"2.5E0\",\"m\"]}",           "{\"$instant\":\"1970-01-01T01:00:00+01:00\"}",
        "{\"$instant\":\"1970-01-01T00:00:00.500Z\"}", "{\"$instant\":\"1970-01-01T00:00:00.0Z\"}",
        "{\"$date\":\"2026-09-27T00:00:00.0\"}",       "{\"$map\":[[\"a\",1]]}",
        "{\"$map\":[]}",
    };
    for (noncanonical) |s| {
        if (decode(std.testing.allocator, s, .{})) |v| {
            v.release();
            std.debug.print("accepted {s}\n", .{s});
            return error.TestUnexpectedResult;
        } else |err| try std.testing.expectEqual(error.InvalidValue, err);
    }
}
test "JSON syntax and text normalisation are not canonical forms" {
    const a = std.testing.allocator;
    const cases = .{
        .{ " [ 1 , {\"$dec\" : \"7.50\"} ] ", "[1,{\"$dec\":\"7.50\"}]" },
        .{ "{\"$dec\":\"\\u0037.50\"}", "{\"$dec\":\"7.50\"}" },
        .{ "\"Cafe\\u0301\"", "\"Caf\u{e9}\"" },
    };
    inline for (cases) |c| {
        const v = try decode(a, c[0], .{});
        defer v.release();
        const s = try encode(a, v);
        defer a.free(s);
        try std.testing.expectEqualStrings(c[1], s);
    }
}

test "every encodable kind round trips through encode and decode" {
    const gpa = std.testing.allocator;
    const object = try model.object(gpa, "item", "slot-1", 1);
    defer object.release();
    const resolver: display.Resolver = .{ .context = object, .object = testResolveObject };
    const sources = [_][]const u8{ "nothing", "true", "false", "42", "-9007199254740991", "7.50", "2.50 GBP", "\"Café\"", "<<0x00, 0xFF>>", "[1, [\"a\"]]", "{a: 1, \"$b\": [nothing]}", "1..10", "1970-01-01T00:00:00.5Z", "2026-09-27", "2026-09-27T14:30:00.25" };
    var seen = std.EnumSet(model.Kind).empty;
    var values: std.ArrayList(*Value) = .empty;
    defer {
        for (values.items) |v| v.release();
        values.deinit(gpa);
    }
    for (sources) |source| {
        const v = try display.parse(gpa, source, .{});
        errdefer v.release();
        try values.append(gpa, v);
    }
    try values.append(gpa, try @import("pattern.zig").parse(gpa, "<\"ID-\", 4 digits>"));
    try values.append(gpa, object.retain());
    for (values.items) |v| {
        seen.insert(v.kind());
        const encoded = try encode(gpa, v);
        defer gpa.free(encoded);
        const copy = try decode(gpa, encoded, resolver);
        defer copy.release();
        try std.testing.expectEqual(v.kind(), copy.kind());
        try std.testing.expect(try v.equal(copy));
        const again = try encode(gpa, copy);
        defer gpa.free(again);
        try std.testing.expectEqualStrings(encoded, again);
    }
    // Functions are the one kind with no encoding.
    var expected = std.EnumSet(model.Kind).full;
    expected.remove(.function);
    try std.testing.expect(seen.eql(expected));
}

test "plain JSON reads numbers exactly and writes chapter 7's escapes" {
    const a = std.testing.allocator;
    const reads = .{
        .{ " {\"name\": \"Ann\", \"scores\": [2.50, null]} ", "{name: \"Ann\", scores: [2.50, nothing]}" },
        .{ "1e5", "100000" },
        .{ "2.50e1", "25.0" },
        .{ "-0", "0" },
        .{ "0.05e1", "0.5" },
        .{ "12.345e-5", "0.00012345" },
        .{ "0e99999999999", "0" },
        .{ "\"Cafe\\u0301\"", "\"Café\"" },
        .{ "\"\\ud83d\\ude00\"", "\"😀\"" },
    };
    inline for (reads) |c| {
        const v = try decodeJson(a, c[0]);
        defer v.release();
        const want = try display.parse(a, c[1], .{});
        defer want.release();
        const got = try display.string(a, v);
        defer a.free(got);
        const expected = try display.string(a, want);
        defer a.free(expected);
        try std.testing.expectEqualStrings(expected, got);
    }
    for ([_][]const u8{ "\"\\ud800\"", "\"a\x01\"", "{\"e\\u0301\":1,\"\\u00e9\":2}", "1e34", "0.1e-6176", "01", "[1,]", "1 2", "1e-99999999999" }) |s| {
        if (decodeJson(a, s)) |v| {
            v.release();
            std.debug.print("accepted {s}\n", .{s});
            return error.TestUnexpectedResult;
        } else |err| try std.testing.expectEqual(error.InvalidValue, err);
    }
    const v = try display.parse(a, "{name: \"Ann\", scores: [2.50, nothing], s: fromCodePoint(8) & tab & fromCodePoint(31) & quote & \"\\\"}", .{});
    defer v.release();
    const s = try encodeJson(a, v);
    defer a.free(s);
    try std.testing.expectEqualStrings("{\"name\":\"Ann\",\"scores\":[2.50,null],\"s\":\"\\b\\t\\u001f\\\"\\\\\"}", s);
    const q = try display.parse(a, "{total: 5 kg}", .{});
    defer q.release();
    try std.testing.expectError(error.NotEncodable, encodeJson(a, q));
}

/// Runs `f` on a thread with a small stack, so recursion on a value's depth
/// would overflow it.
fn onSmallStack(comptime f: fn () anyerror!void) !void {
    var result: anyerror!void = {};
    const t = try std.Thread.spawn(.{ .stack_size = 256 * 1024 }, struct {
        fn go(out: *anyerror!void) void {
            out.* = f();
        }
    }.go, .{&result});
    t.join();
    return result;
}

/// Maps and lists nested `depth` deep, alternately `{x: …}` and `[…]`,
/// around `leaf`, with their logical size.
fn deepValue(a: std.mem.Allocator, depth: usize, leaf: *Value) !struct { *Value, u64 } {
    var v = leaf.retain();
    errdefer v.release();
    var size = model.logicalSize(leaf);
    for (0..depth) |i| {
        const next = if (i % 2 == 0) try model.map(a, &.{.{ .key = "x", .value = v }}) else try model.list(a, &.{v});
        size += if (i % 2 == 0) 16 + 8 + 16 + 1 else 16 + 8;
        v.release();
        v = next;
    }
    return .{ v, size };
}

fn deepValues() !void {
    const a = std.testing.allocator;
    const depth = 100_000;
    const one = try model.scalar(a, .{ .number = model.Decimal.fromInt(@as(i64, 1)) });
    defer one.release();
    const two = try model.scalar(a, .{ .number = model.Decimal.fromInt(@as(i64, 2)) });
    defer two.release();
    const x, const size = try deepValue(a, depth, one);
    defer x.release();
    const y, _ = try deepValue(a, depth, one);
    defer y.release();
    const z, _ = try deepValue(a, depth, two);
    defer z.release();
    try std.testing.expectEqual(size, model.logicalSize(x));
    try std.testing.expect(try x.equal(y));
    try std.testing.expect(!try x.equal(z));
    // Lists order by their first unequal item, however deep; maps don't.
    var lx = one.retain();
    defer lx.release();
    var lz = two.retain();
    defer lz.release();
    for (0..depth) |_| {
        const nx = try model.list(a, &.{lx});
        lx.release();
        lx = nx;
        const nz = try model.list(a, &.{ lz, one });
        lz.release();
        lz = nz;
    }
    try std.testing.expectEqual(std.math.Order.lt, try lx.order(lz));
    try std.testing.expectEqual(std.math.Order.gt, try lz.order(lx));
    try std.testing.expectError(error.CantCompare, x.order(z));

    // Display, the Value Encoding and plain JSON each round trip.
    const shown = try display.string(a, x);
    defer a.free(shown);
    try std.testing.expect(std.mem.startsWith(u8, shown, "[{x: [{x: "));
    const parsed = try display.parse(a, shown, .{});
    defer parsed.release();
    try std.testing.expect(try x.equal(parsed));
    const encoded = try encode(a, x);
    defer a.free(encoded);
    const decoded = try decode(a, encoded, .{});
    defer decoded.release();
    try std.testing.expect(try x.equal(decoded));
    const json = try encodeJson(a, x);
    defer a.free(json);
    try std.testing.expectEqualStrings(encoded, json);
    const plain = try decodeJson(a, json);
    defer plain.release();
    try std.testing.expect(try x.equal(plain));

    // A Function Value deep inside is still refused.
    const captures = try model.map(a, &.{});
    defer captures.release();
    const function = try model.function(a, "home", "<function f>", 1, captures);
    defer function.release();
    const holder, _ = try deepValue(a, depth, function);
    defer holder.release();
    try std.testing.expectError(error.NotEncodable, encode(a, holder));
    try std.testing.expectError(error.NotEncodable, encodeJson(a, holder));
}

test "values nested 100,000 deep build, measure, compare, show, encode and free on a small stack" {
    try onSmallStack(deepValues);
}

fn deepRoundTripAllocations(a: std.mem.Allocator) !void {
    const leaf = try model.scalar(a, .nothing);
    defer leaf.release();
    const v, _ = try deepValue(a, 12, leaf);
    defer v.release();
    const shown = try display.string(a, v);
    defer a.free(shown);
    const parsed = try display.parse(a, shown, .{});
    defer parsed.release();
    const encoded = try encode(a, v);
    defer a.free(encoded);
    const decoded = try decode(a, encoded, .{});
    defer decoded.release();
    const plain = try decodeJson(a, encoded);
    defer plain.release();
    try std.testing.expect(try v.equal(decoded));
}

test "deep reading and building free everything after any allocation failure" {
    var fixed: NoInPlaceResize = .{ .child = std.testing.allocator };
    try std.testing.checkAllAllocationFailures(fixed.allocator(), deepRoundTripAllocations, .{});
}

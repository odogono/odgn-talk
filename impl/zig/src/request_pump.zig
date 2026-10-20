//! Envelope items for the proposed binary Request/Pump exchanges
//! (spec/embedding/request-pump-binary.md, proposed ADR 0110). Values inside
//! an envelope use binary_value.zig; this file has no Session dependency.
const std = @import("std");
const binary_value = @import("binary_value.zig");
const model = @import("value.zig");
const envelope = @import("generated/envelope.zig");
const Allocator = std.mem.Allocator;

pub const prefix = "NTB\x01";
pub const feature_load = envelope.features[3];

pub const feature_fields = envelope.features[0];

/// The layout byte after the prefix: the fields layout, the only one.
pub const layout_fields: u8 = 0x01;

pub const tag = struct {
    pub const nothing: u8 = 0x00;
    pub const false_: u8 = 0x01;
    pub const true_: u8 = 0x02;
    pub const integer: u8 = 0x03;
    pub const text: u8 = 0x05;
    pub const list: u8 = 0x06;
    pub const map: u8 = 0x07;
    pub const instant: u8 = 0x0b;
    pub const negative: u8 = 0x10;
    pub const protocol_text: u8 = 0x12;
};

fn messageTag(comptime name: []const u8) u8 {
    for (envelope.messages) |entry| if (std.mem.eql(u8, entry.name, name)) return entry.tag;
    @compileError("unknown envelope message: " ++ name);
}
fn reportTag(comptime name: []const u8) u8 {
    for (envelope.reports) |entry| if (std.mem.eql(u8, entry.name, name)) return entry.tag;
    @compileError("unknown envelope Report: " ++ name);
}

/// Request/Pump inputs and replies, by message tag.
pub const Message = enum(u8) {
    request = messageTag("request"),
    call = messageTag("call"),
    pump = messageTag("pump"),
    request_pump = messageTag("request-pump"),
    call_pump = messageTag("call-pump"),
    /// `settlements-fields-v1` (#1320): a Pump preceded by queued settlements.
    settle_pump = messageTag("settle-pump"),
    load = messageTag("load"),
    admission = messageTag("admission"),
    completion = messageTag("completion"),

    /// Whether the input runs a Pump.
    pub fn pumps(m: Message) bool {
        return m == .pump or m == .request_pump or m == .call_pump or m == .settle_pump;
    }
};

/// `settlements-fields-v1` (#1320): a Host's queued `answer` and `fail`
/// inputs cross inside the `settle-pump` that would drain them.
pub const feature_settlements = envelope.features[2];
/// One settlement, positionally. `outcome` is `answer` or `fail`; `value`
/// is the answer or the failure's Data; `fuel` an answer's late cost; `code`
/// and `message` a failure's, with no `code` failing the call as broken.
pub const settlement_fields = fieldNames(envelope.settlement);

/// A specialized Report's tag and positional fields.
pub const Report = enum(u8) {
    run_end = reportTag("run end"),
    run_started = reportTag("run started"),
    run_discarded = reportTag("run discarded"),
    run_accounting = reportTag("run accounting"),
    causal_work = reportTag("causal work"),
    stop = reportTag("stop"),
    unhandled = reportTag("unhandled"),
    call_failed = reportTag("call failed"),
    effect_failure = reportTag("effect failure"),
    decided = reportTag("decided"),
    host_error = reportTag("host error"),
    charge_result = reportTag("charge result"),

    /// The JSON Report's `kind`, from the generated catalogue.
    pub fn kind(r: Report) []const u8 {
        return report_entries[@backingInt(r)].?.name;
    }
};

/// `callbacks-fields-v1` (#1311): Host callback needs and their results
/// cross as fields-layout frames.
pub const feature_callbacks = envelope.features[1];

/// A callback need's or result's message tag and positional fields. A need
/// ends with its notices, so they can be filled in after it is written.
pub const Callback = enum(u8) {
    op_result = messageTag("op-result"),
    prop_result = messageTag("prop-result"),
    effect_result = messageTag("effect-result"),
    release_result = messageTag("release-result"),
    op = messageTag("op"),
    prop = messageTag("prop"),
    effect = messageTag("effect"),
    release = messageTag("release"),

    /// A result's tag, or null for a need's.
    pub fn result(t: u8) ?Callback {
        const c = std.enums.fromInt(Callback, t) orelse return null;
        return if (t < 0x80) c else null;
    }
};

// Field-name projections are evaluated at compile time. The framing writer
// retains its name slices without allocating or copying a catalogue per frame.
fn fieldNames(comptime schema: []const envelope.Field) []const []const u8 {
    return &struct {
        const names = blk: {
            var out: [schema.len][]const u8 = undefined;
            for (schema, 0..) |field, i| out[i] = field.name;
            break :blk out;
        };
    }.names;
}
const message_names = blk: {
    var out: [256][]const []const u8 = @splat(&.{});
    for (envelope.messages) |entry| out[entry.tag] = fieldNames(entry.fields);
    break :blk out;
};
const report_names = blk: {
    var out: [256][]const []const u8 = @splat(&.{});
    for (envelope.reports) |entry| out[entry.tag] = fieldNames(entry.fields);
    break :blk out;
};
const report_entries = blk: {
    var out: [256]?*const envelope.Entry = @splat(null);
    for (envelope.reports) |*entry| out[entry.tag] = entry;
    break :blk out;
};

pub fn fields(message: anytype) []const []const u8 {
    return if (@TypeOf(message) == Report) report_names[@backingInt(message)] else message_names[@backingInt(message)];
}

pub const Error = error{ Malformed, OutOfMemory };

/// Field names are usually the same literal as the table's.
fn sameName(x: []const u8, y: []const u8) bool {
    return (x.ptr == y.ptr and x.len == y.len) or std.mem.eql(u8, x, y);
}

/// Writes one frame. A record is a map (named fields, absent ones omitted)
/// or, for messages and Reports, a list whose
/// positions are the record's field names (absent ones Nothing).
pub const Writer = struct {
    a: Allocator,
    out: std.ArrayList(u8) = .empty,
    records: std.ArrayList(Record) = .empty,

    const Record = struct { at: usize, names: []const []const u8, next: usize = 0, count: usize = 0, positional: bool };

    pub fn init(a: Allocator) Writer {
        return .{ .a = a };
    }
    pub fn deinit(w: *Writer) void {
        w.out.deinit(w.a);
        w.records.deinit(w.a);
    }
    pub fn finish(w: *Writer) Allocator.Error![]u8 {
        std.debug.assert(w.records.items.len == 0);
        return w.out.toOwnedSlice(w.a);
    }

    pub fn header(w: *Writer) Allocator.Error!void {
        try w.out.appendSlice(w.a, prefix);
        try w.out.append(w.a, layout_fields);
    }
    pub fn byte(w: *Writer, b: u8) Allocator.Error!void {
        try w.out.append(w.a, b);
    }
    pub fn raw(w: *Writer, bytes: []const u8) Allocator.Error!void {
        try w.out.appendSlice(w.a, bytes);
    }
    /// One item header, a tag then an unsigned LEB128, and its bytes,
    /// written together into reserved capacity: on `wasm32`, appending byte
    /// by byte, and short `memory.copy` calls, cost more than the encoding.
    /// A tag, its count and its bytes. Counts are u64: a u128 count costs
    /// 128-bit arithmetic on wasm32 for every field (#1103), so only `int`
    /// takes the wide path.
    fn tagged(w: *Writer, t: u8, n0: u64, bytes: []const u8) Allocator.Error!void {
        try w.out.ensureUnusedCapacity(w.a, 11 + bytes.len);
        const out = w.out.unusedCapacitySlice();
        out[0] = t;
        var len: usize = 1;
        var n = n0;
        while (n >= 128) : (n >>= 7) {
            out[len] = @as(u8, @truncate(n)) | 128;
            len += 1;
        }
        out[len] = @intCast(n);
        len += 1;
        if (bytes.len <= 16) {
            for (bytes, out[len..][0..bytes.len]) |b, *o| o.* = b;
        } else @memcpy(out[len..][0..bytes.len], bytes);
        w.out.items.len += len + bytes.len;
    }

    fn taggedWide(w: *Writer, t: u8, n0: u128) Allocator.Error!void {
        if (std.math.cast(u64, n0)) |small| return w.tagged(t, small, "");
        try w.out.ensureUnusedCapacity(w.a, 20);
        const out = w.out.unusedCapacitySlice();
        out[0] = t;
        var len: usize = 1;
        var n = n0;
        while (n >= 128) : (n >>= 7) {
            out[len] = @as(u8, @truncate(n)) | 128;
            len += 1;
        }
        out[len] = @intCast(n);
        w.out.items.len += len + 1;
    }

    /// Opens a record. Every record has at most 16 fields, so a map's
    /// count is one byte, written when the record ends.
    pub fn begin(w: *Writer, names: []const []const u8, positional: bool) Allocator.Error!void {
        try w.out.append(w.a, if (positional) tag.list else tag.map);
        try w.records.append(w.a, .{ .at = w.out.items.len, .names = names, .positional = positional });
        try w.out.append(w.a, if (positional) @intCast(names.len) else 0);
    }
    /// Names the next field. Positional fields come in table order; any
    /// skipped field is written as Nothing.
    pub fn key(w: *Writer, name: []const u8) Allocator.Error!void {
        const r = &w.records.items[w.records.items.len - 1];
        if (!r.positional) {
            r.count += 1;
            try w.tagged(tag.text, name.len, name);
            return;
        }
        while (r.next < r.names.len and !sameName(r.names[r.next], name)) : (r.next += 1) try w.out.append(w.a, tag.nothing);
        std.debug.assert(r.next < r.names.len);
        r.next += 1;
    }
    /// Writes `n` consecutive positional fields from `first`, already encoded.
    pub fn fieldsRaw(w: *Writer, first: []const u8, n: usize, bytes: []const u8) Allocator.Error!void {
        try w.key(first);
        try w.raw(bytes);
        const r = &w.records.items[w.records.items.len - 1];
        std.debug.assert(r.positional and r.next + n - 1 <= r.names.len);
        r.next += n - 1;
    }
    pub fn end(w: *Writer) Allocator.Error!void {
        const r = w.records.pop().?;
        if (r.positional) {
            for (r.next..r.names.len) |_| try w.out.append(w.a, tag.nothing);
        } else {
            std.debug.assert(r.count < 128);
            w.out.items[r.at] = @intCast(r.count);
        }
    }

    pub fn nothing(w: *Writer) Allocator.Error!void {
        try w.out.append(w.a, tag.nothing);
    }
    pub fn boolean(w: *Writer, b: bool) Allocator.Error!void {
        try w.out.append(w.a, if (b) tag.true_ else tag.false_);
    }
    pub fn int(w: *Writer, n: i128) Allocator.Error!void {
        if (n < 0) {
            try w.taggedWide(tag.negative, @intCast(-n));
        } else {
            try w.taggedWide(tag.integer, @intCast(n));
        }
    }
    /// Protocol text: UTF-8 the Core wrote, never NFC-normalized.
    pub fn ptext(w: *Writer, s: []const u8) Allocator.Error!void {
        try w.tagged(tag.protocol_text, s.len, s);
    }
    pub fn ptexts(w: *Writer, xs: []const []const u8) Allocator.Error!void {
        try w.list(xs.len);
        for (xs) |x| try w.ptext(x);
    }
    pub fn list(w: *Writer, n: usize) Allocator.Error!void {
        try w.tagged(tag.list, n, "");
    }
    pub fn instant(w: *Writer, t: model.dates.Instant) Allocator.Error!void {
        const n: i64 = t.seconds * 1000000 + t.micros;
        const bits: u64 = @bitCast(n);
        try w.tagged(tag.instant, (bits << 1) ^ @as(u64, @bitCast(n >> 63)), "");
    }
    pub fn value(w: *Writer, v: *const Value, options: binary_value.EncodeOptions) (Allocator.Error || error{InvalidValue})!void {
        const mark = w.out.items.len;
        binary_value.append(w.a, &w.out, v, options) catch |e| {
            w.out.shrinkRetainingCapacity(mark);
            return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
        };
    }
};
const Value = model.Value;

/// Reads a frame's envelope. Spans are whole items, validated only for
/// structure; Values in them are decoded later by binary_value.zig.
pub const Reader = struct {
    data: []const u8,
    at: usize = 0,

    pub fn done(r: *const Reader) bool {
        return r.at == r.data.len;
    }
    pub fn byte(r: *Reader) Error!u8 {
        if (r.at >= r.data.len) return error.Malformed;
        r.at += 1;
        return r.data[r.at - 1];
    }
    pub fn uint(r: *Reader) Error!u64 {
        return r.leb(u64);
    }
    fn leb(r: *Reader, comptime T: type) Error!T {
        var n: T = 0;
        var shift: u7 = 0;
        var count: usize = 0;
        while (count < 10) : (count += 1) {
            const b = try r.byte();
            if (shift == 63 and b > std.math.maxInt(T) >> 63) return error.Malformed;
            n |= @as(T, b & 127) << @intCast(shift);
            if (b < 128) {
                if (count > 0 and b == 0) return error.Malformed;
                return n;
            }
            shift += 7;
        }
        return error.Malformed;
    }
    fn negativeMagnitude(r: *Reader) Error!u65 {
        const n = try r.leb(u65);
        if (n == 0 or n > @as(u65, 1) << 64) return error.Malformed;
        return n;
    }
    pub fn bytes(r: *Reader) Error![]const u8 {
        const n = try r.uint();
        if (n > r.data.len - r.at) return error.Malformed;
        const end = r.at + @as(usize, @intCast(n));
        defer r.at = end;
        return r.data[r.at..end];
    }

    /// The span of the next whole item, of any tag this experiment uses.
    pub fn skip(r: *Reader) Error![]const u8 {
        const start = r.at;
        var pending: usize = 1;
        while (pending > 0) {
            pending -= 1;
            const t = try r.byte();
            switch (t) {
                0x00, 0x01, 0x02 => {},
                0x03, 0x0b => _ = try r.uint(),
                0x10 => _ = try r.negativeMagnitude(),
                0x04, 0x05, 0x08, 0x0c, 0x0d, 0x12 => _ = try r.bytes(),
                0x06, 0x07, 0x11, 0x13 => {
                    const n = try r.uint();
                    // Every item is at least one byte: a larger count is truncated.
                    const items = if (t == 0x07 or t == 0x11) n *| 2 else n;
                    if (t == 0x13 and n != 6 and n != 7) return error.Malformed;
                    if (items > r.data.len - r.at) return error.Malformed;
                    pending += @intCast(items);
                },
                0x09, 0x0a, 0x0e => pending += 2,
                0x0f => pending += 3,
                else => return error.Malformed,
            }
        }
        return r.data[start..r.at];
    }

    /// Reads a record into `out`, indexed like `names`: a map of known,
    /// unrepeated text keys, or a list of exactly `names.len` items. A
    /// Nothing item is an absent field.
    pub fn record(r: *Reader, names: []const []const u8, positional: bool, out: []?[]const u8) Error!void {
        std.debug.assert(out.len == names.len);
        @memset(out, null);
        const t = try r.byte();
        if (positional) {
            if (t != tag.list or try r.uint() != names.len) return error.Malformed;
            for (out) |*slot| {
                const span = try r.skip();
                slot.* = if (span.len == 1 and span[0] == tag.nothing) null else span;
            }
            return;
        }
        if (t != tag.map) return error.Malformed;
        const n = try r.uint();
        if (n > names.len) return error.Malformed;
        var seen: [32]bool = @splat(false);
        for (0..@intCast(n)) |_| {
            if (try r.byte() != tag.text) return error.Malformed;
            const k = try r.bytes();
            const i = for (names, 0..) |name, i| {
                if (std.mem.eql(u8, name, k)) break i;
            } else return error.Malformed;
            if (seen[i]) return error.Malformed;
            seen[i] = true;
            const span = try r.skip();
            out[i] = if (span.len == 1 and span[0] == tag.nothing) null else span;
        }
    }
};

fn whole(span: []const u8) Reader {
    return .{ .data = span };
}

/// Protocol text, which must be UTF-8 but is not normalized.
pub fn ptextOf(span: []const u8) Error![]const u8 {
    var r = whole(span);
    if (try r.byte() != tag.protocol_text) return error.Malformed;
    const s = try r.bytes();
    if (!r.done() or !std.unicode.utf8ValidateSlice(s)) return error.Malformed;
    return s;
}

pub fn uintOf(span: []const u8) Error!u64 {
    var r = whole(span);
    if (try r.byte() != tag.integer) return error.Malformed;
    const n = try r.uint();
    if (!r.done()) return error.Malformed;
    return n;
}

/// An integer item of either sign, as i64; outside i64 is null.
pub fn intOf(span: []const u8) Error!?i64 {
    var r = whole(span);
    const t = try r.byte();
    if (t != tag.integer and t != tag.negative) return error.Malformed;
    const n = if (t == tag.negative) try r.negativeMagnitude() else @as(u65, try r.uint());
    if (!r.done()) return error.Malformed;
    if (t == tag.integer) return if (n > std.math.maxInt(i64)) null else @intCast(n);
    return if (n > @as(u64, 1) << 63) null else @intCast(-@as(i128, n));
}

pub fn instantOf(span: []const u8) Error!model.dates.Instant {
    var r = whole(span);
    if (try r.byte() != tag.instant) return error.Malformed;
    const u = try r.uint();
    if (!r.done()) return error.Malformed;
    const n: i128 = @as(i128, @intCast(u >> 1)) ^ -@as(i128, @intCast(u & 1));
    const seconds = @divFloor(n, 1000000);
    if (seconds < -62135596800 or seconds > 253402300799) return error.Malformed;
    return .{ .seconds = @intCast(seconds), .micros = @intCast(@mod(n, 1000000)) };
}

/// The items of a list span.
pub fn listOf(span: []const u8, a: Allocator) Error![][]const u8 {
    var r = whole(span);
    if (try r.byte() != tag.list) return error.Malformed;
    const n = try r.uint();
    if (n > span.len) return error.Malformed;
    const items = try a.alloc([]const u8, @intCast(n));
    errdefer a.free(items);
    for (items) |*item| item.* = try r.skip();
    if (!r.done()) return error.Malformed;
    return items;
}

pub fn isList(span: []const u8) bool {
    return span.len > 0 and span[0] == tag.list;
}
pub fn isMap(span: []const u8) bool {
    return span.len > 0 and span[0] == tag.map;
}

test "positional records fill skipped fields with Nothing" {
    const a = std.testing.allocator;
    var w = Writer.init(a);
    defer w.deinit();
    try w.begin(fields(Report.host_error), true);
    try w.key("detail");
    try w.ptext("x");
    try w.end();
    try w.begin(&.{ "a", "b" }, false);
    try w.key("b");
    try w.int(-2);
    try w.end();
    try std.testing.expectEqualSlices(u8, &.{ 6, 2, 0, 0x12, 1, 'x', 7, 1, 5, 1, 'b', 0x10, 2 }, w.out.items);

    var r: Reader = .{ .data = w.out.items };
    var out: [2]?[]const u8 = undefined;
    try r.record(fields(Report.host_error), true, &out);
    try std.testing.expect(out[0] == null);
    try std.testing.expectEqualStrings("x", try ptextOf(out[1].?));
    try r.record(&.{ "a", "b" }, false, &out);
    try std.testing.expect(out[0] == null);
    try std.testing.expectEqual(@as(?i64, -2), try intOf(out[1].?));
    try std.testing.expect(r.done());
}

test "envelope reader refuses malformed records" {
    const names: []const []const u8 = &.{ "a", "b" };
    var out: [2]?[]const u8 = undefined;
    for ([_][]const u8{
        &.{ 6, 1, 0 }, // wrong positional length
        &.{ 7, 1, 5, 1, 'c', 0 }, // unknown key
        &.{ 7, 2, 5, 1, 'a', 0, 5, 1, 'a', 0 }, // repeated key
        &.{ 7, 1, 0x12, 1, 'a', 0 }, // key not a text item
        &.{ 7, 1, 5, 1, 'a', 0x14 }, // unknown tag
        &.{ 7, 1, 5, 1, 'a', 3, 128, 0 }, // overlong LEB128
        &.{ 7, 1, 5, 1, 'a', 6, 200, 1 }, // truncated list
    }) |data| {
        var r: Reader = .{ .data = data };
        try std.testing.expectError(error.Malformed, r.record(names, data[0] == 6, &out));
    }
    try std.testing.expectError(error.Malformed, ptextOf(&.{ 0x12, 1, 0xff }));
    try std.testing.expectError(error.Malformed, uintOf(&.{ 3, 1, 0 }));
    try std.testing.expectError(error.Malformed, intOf(&.{ 0x10, 0 }));
}

test "instants round-trip through the writer and reader" {
    const a = std.testing.allocator;
    for ([_]model.dates.Instant{ .{ .seconds = 0, .micros = 0 }, .{ .seconds = -1, .micros = 999999 }, .{ .seconds = 1792310400, .micros = 12 } }) |t| {
        var w = Writer.init(a);
        defer w.deinit();
        try w.instant(t);
        try std.testing.expectEqual(t, try instantOf(w.out.items));
    }
}

test "shared binary Value vectors cross the envelope" {
    const a = std.testing.allocator;
    const Vector = struct { json: []const u8, hex: []const u8 };
    const parsed = try std.json.parseFromSlice([]Vector, a, @embedFile("request-pump-vectors"), .{});
    defer parsed.deinit();
    for (parsed.value) |vector| {
        const want = try a.alloc(u8, vector.hex.len / 2);
        defer a.free(want);
        _ = try std.fmt.hexToBytes(want, vector.hex);
        const v = try @import("encoding.zig").decode(a, vector.json, .{});
        defer v.release();
        var w = Writer.init(a);
        defer w.deinit();
        try w.value(v, .{});
        try std.testing.expectEqualSlices(u8, want, w.out.items);
        var r: Reader = .{ .data = want };
        const span = try r.skip();
        try std.testing.expect(r.done());
        const back = try binary_value.decode(a, span, .{});
        defer back.release();
        const again = try binary_value.encode(a, back, .{});
        defer a.free(again);
        try std.testing.expectEqualSlices(u8, want, again);
    }
}

test "shared fields frame vectors decode and re-encode every field" {
    try @import("envelope_vectors_test.zig").check();
}

test "envelope integer bounds and canonical magnitudes" {
    for ([_][]const u8{
        &.{ 0x10, 0 }, // Negative zero.
        &.{ 0x10, 129, 128, 128, 128, 128, 128, 128, 128, 128, 2 }, // 2^64 + 1.
        &.{ 0x10, 128, 128, 128, 128, 128, 128, 128, 128, 128, 3 }, // Above 2^64.
        &.{ 0x10, 128, 128, 128, 128, 128, 128, 128, 128, 128, 130, 0 }, // Overlong 2^64.
        &.{ 0x10, 128, 128, 128, 128, 128, 128, 128, 128, 128 }, // Truncated.
        &.{ 0x10, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128 }, // Unterminated.
        &.{ 0x03, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2 }, // Positive 2^64.
        &.{ 0x0b, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2 }, // Instant above u64.
        &.{ 0x06, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2 }, // Count above u64.
    }) |wire| {
        var r: Reader = .{ .data = wire };
        try std.testing.expectError(error.Malformed, r.skip());
    }
    const boundary = [_]u8{ 0x10, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2 };
    try std.testing.expectEqual(@as(?i64, null), try intOf(&boundary));
}

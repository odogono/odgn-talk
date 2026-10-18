//! Envelope items for the proposed binary Request/Pump exchanges
//! (spec/embedding/request-pump-binary.md, proposed ADR 0110). Values inside
//! an envelope use binary_value.zig; this file has no Session dependency.
const std = @import("std");
const binary_value = @import("binary_value.zig");
const model = @import("value.zig");
const Allocator = std.mem.Allocator;

pub const prefix = "NTB\x01";
pub const feature_map = "request-pump-map-v1";
pub const feature_fields = "request-pump-fields-v1";

pub const Layout = enum(u8) { map = 0, fields = 1 };

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

/// Inputs and replies of the fields candidate, by message tag.
pub const Message = enum(u8) {
    request = 0x01,
    call = 0x02,
    pump = 0x03,
    request_pump = 0x04,
    call_pump = 0x05,
    admission = 0x81,
    completion = 0x82,

    /// The map candidate's `m`.
    pub fn name(m: Message) []const u8 {
        return switch (m) {
            .request => "request",
            .call => "call",
            .pump => "pump",
            .request_pump => "request-pump",
            .call_pump => "call-pump",
            .admission, .completion => "",
        };
    }

    pub fn fields(m: Message) []const []const u8 {
        return switch (m) {
            .request => &.{ "ref", "group", "to", "message" },
            .call => &.{ "ref", "group", "fn", "args", "limits" },
            .pump => &.{ "ref", "group", "now", "fuelSlice", "fuelCap" },
            .request_pump => &.{ "ref", "group", "token", "to", "message", "now", "fuelSlice", "fuelCap" },
            .call_pump => &.{ "ref", "group", "token", "fn", "args", "limits", "now", "fuelSlice", "fuelCap" },
            .admission => &.{ "ref", "delivery", "err", "abandoned", "settled", "trace" },
            .completion => &.{ "ref", "delivery", "token", "state", "nextDeadline", "fuelUsed", "reports", "gone", "err", "abandoned", "settled", "trace" },
        };
    }

    pub fn ofName(s: []const u8) ?Message {
        for ([_]Message{ .request, .call, .pump, .request_pump, .call_pump }) |m| {
            if (std.mem.eql(u8, s, m.name())) return m;
        }
        return null;
    }

    /// Every field any input may carry, for the map candidate's first pass.
    pub const input_fields: []const []const u8 = &.{ "m", "ref", "group", "token", "to", "message", "fn", "args", "limits", "now", "fuelSlice", "fuelCap" };
};

/// A specialized Report's tag and positional fields.
pub const Report = enum(u8) {
    run_end = 0x01,
    run_started = 0x02,
    run_discarded = 0x03,
    run_accounting = 0x04,
    causal_work = 0x05,
    stop = 0x06,
    unhandled = 0x07,
    call_failed = 0x08,
    effect_failure = 0x09,
    decided = 0x0a,
    host_error = 0x0b,
    charge_result = 0x0c,

    pub fn fields(r: Report) []const []const u8 {
        return switch (r) {
            .run_end => &.{ "script", "run", "delivery", "broadcast", "handler", "fallback", "climbed", "outcome", "result", "error", "limit", "effect", "cleanupFailed", "at", "fuel", "alloc" },
            .run_started => &.{ "script", "run", "args", "rootDelivery", "parentRun", "parentCall", "delivery", "selector", "fn" },
            .run_discarded => &.{ "script", "run", "reason", "rootDelivery", "parentRun", "parentCall" },
            .run_accounting => &.{ "script", "run", "fuel", "state", "rootDelivery", "parentRun", "parentCall" },
            .causal_work => &.{ "rootDelivery", "liveRuns", "queuedMessages", "discardedMessages" },
            .stop => &.{ "script", "reason", "discardedRuns", "droppedMessages", "pendingCalls" },
            .unhandled => &.{ "delivery", "message", "target" },
            .call_failed => &.{ "script", "call", "operation", "detail" },
            .effect_failure => &.{ "script", "run", "grant", "segment", "phase", "status", "scope" },
            .decided => &.{ "delivery", "broadcast", "verdict", "vetoes", "undecided" },
            .host_error => &.{ "code", "detail" },
            .charge_result => &.{ "request", "call", "fuel", "status" },
        };
    }

    /// The map candidate's `kind`, as the JSON Report writes it.
    pub fn kind(r: Report) []const u8 {
        return switch (r) {
            .run_end => "run end",
            .run_started => "run started",
            .run_discarded => "run discarded",
            .run_accounting => "run accounting",
            .causal_work => "causal work",
            .stop => "stop",
            .unhandled => "unhandled",
            .call_failed => "call failed",
            .effect_failure => "effect failure",
            .decided => "decided",
            .host_error => "host error",
            .charge_result => "charge result",
        };
    }
};

pub const Error = error{ Malformed, OutOfMemory };

/// Writes one frame. A record is a map (named fields, absent ones omitted)
/// or, for the fields candidate's messages and Reports, a list whose
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

    pub fn header(w: *Writer, layout: Layout) Allocator.Error!void {
        try w.out.appendSlice(w.a, prefix);
        try w.out.append(w.a, @backingInt(layout));
    }
    pub fn byte(w: *Writer, b: u8) Allocator.Error!void {
        try w.out.append(w.a, b);
    }
    pub fn raw(w: *Writer, bytes: []const u8) Allocator.Error!void {
        try w.out.appendSlice(w.a, bytes);
    }
    fn leb(w: *Writer, n0: u128) Allocator.Error!void {
        var n = n0;
        while (n >= 128) : (n >>= 7) try w.out.append(w.a, @as(u8, @truncate(n)) | 128);
        try w.out.append(w.a, @intCast(n));
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
            try w.out.append(w.a, tag.text);
            try w.leb(name.len);
            try w.out.appendSlice(w.a, name);
            return;
        }
        while (r.next < r.names.len and !std.mem.eql(u8, r.names[r.next], name)) : (r.next += 1) try w.out.append(w.a, tag.nothing);
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
            try w.out.append(w.a, tag.negative);
            try w.leb(@intCast(-n));
        } else {
            try w.out.append(w.a, tag.integer);
            try w.leb(@intCast(n));
        }
    }
    /// Protocol text: UTF-8 the Core wrote, never NFC-normalized.
    pub fn ptext(w: *Writer, s: []const u8) Allocator.Error!void {
        try w.out.append(w.a, tag.protocol_text);
        try w.leb(s.len);
        try w.out.appendSlice(w.a, s);
    }
    pub fn ptexts(w: *Writer, xs: []const []const u8) Allocator.Error!void {
        try w.list(xs.len);
        for (xs) |x| try w.ptext(x);
    }
    pub fn list(w: *Writer, n: usize) Allocator.Error!void {
        try w.out.append(w.a, tag.list);
        try w.leb(n);
    }
    pub fn instant(w: *Writer, t: model.dates.Instant) Allocator.Error!void {
        const n: i64 = t.seconds * 1000000 + t.micros;
        const bits: u64 = @bitCast(n);
        try w.out.append(w.a, tag.instant);
        try w.leb((bits << 1) ^ @as(u64, @bitCast(n >> 63)));
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
        var n: u64 = 0;
        var shift: u7 = 0;
        var count: usize = 0;
        while (count < 10) : (count += 1) {
            const b = try r.byte();
            if (shift == 63 and b > 1) return error.Malformed;
            n |= @as(u64, b & 127) << @intCast(shift);
            if (b < 128) {
                if (count > 0 and b == 0) return error.Malformed;
                return n;
            }
            shift += 7;
        }
        return error.Malformed;
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
                0x10 => if (try r.uint() == 0) return error.Malformed,
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
    const n = try r.uint();
    if (!r.done() or (t == tag.negative and n == 0)) return error.Malformed;
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
    try w.begin(Report.host_error.fields(), true);
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
    try r.record(Report.host_error.fields(), true, &out);
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

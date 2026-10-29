//! Save and restore (chapter 10): the save format every Core writes and
//! reads, so a save restores on either Core (ADR 0144).
//!
//! A save is a header followed by tagged sections, each with its own
//! SHA-256 (`spec/data/save-format.toml`). Sections are written to one
//! buffer, each hashed once as it ends; the State Fingerprint and the body
//! digest come from those digests. The state holds every Library by
//! identity, every Script by its identities, sources and values, every Run
//! with its frames, error control and wait, and the Group's queues and
//! counters. Code is never saved: a restore compiles each Script's sources
//! again, against the Libraries the Host passes, and checks them against the
//! save before it trusts a single code position. Pointers between parts are
//! indices, and the internal values a dispatch activation shares (iterators,
//! readers and replacements) are saved once and referred to after.
const std = @import("std");
const sorting = @import("../sort.zig");
const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;
const machine = @import("machine.zig");
const model = @import("../value.zig");
const display = @import("../display.zig");
const lower = @import("../lower/lower.zig");
const binary = @import("binary.zig");
const capabilities = @import("capabilities.zig");
const objects = @import("objects.zig");
const fingerprint = @import("fingerprint.zig");
const verify = @import("verify.zig");
const version = @import("../generated/version.zig").version;
const cost_model = @import("../generated/costs.zig").costs;
const limits_table = @import("../generated/limits.zig").limits;

const Value = model.Value;
const Group = machine.Group;
const Script = machine.Script;
const Run = machine.Run;
const Library = machine.Library;
const Frame = machine.Frame;
const Slot = machine.Slot;
const Pending = machine.Pending;

const magic = "NTSV";
/// The save format this Core reads and writes; it reads no other.
pub const format_version: u32 = 1;

/// The sections, by tag; every one but `sources` is required.
const Section = enum(u8) { texts = 1, group, libraries, objects, functions, calls, scripts, runs, work, waits, inputs, decisions, accounting, sources };
const last_required: u8 = @backingInt(Section.accounting);

pub const Error = error{
    InvalidSave,
    /// A variables-only restore whose Script no longer loads; its
    /// diagnostics are in the Trace.
    LoadRefused,
    /// A variables-only restore whose carried Script Variables pass a
    /// Script's Persistent State cap.
    StateTooLarge,
} || Allocator.Error;

// ---------------------------------------------------------------- encoding

/// The bytes a save is written to.
const Out = struct {
    gpa: Allocator,
    bytes: std.ArrayList(u8) = .empty,
    /// The save's `texts` table, which `name` adds to.
    names: ?*Names = null,

    fn byte(o: *Out, b: u8) !void {
        try o.bytes.append(o.gpa, b);
    }

    /// An unsigned LEB128 integer.
    pub fn int(o: *Out, v: anytype) !void {
        var x: u128 = @intCast(v);
        while (true) {
            const low: u8 = @intCast(x & 0x7f);
            x >>= 7;
            if (x == 0) return o.byte(low);
            try o.byte(low | 0x80);
        }
    }

    /// A signed LEB128 integer.
    fn signed(o: *Out, v: anytype) !void {
        var x: i256 = v;
        while (true) {
            const low: u8 = @intCast(x & 0x7f);
            x >>= 7;
            if ((x == 0 and low & 0x40 == 0) or (x == -1 and low & 0x40 != 0)) return o.byte(low);
            try o.byte(low | 0x80);
        }
    }

    fn instant(o: *Out, t: model.dates.Instant) !void {
        try o.signed(t.seconds);
        try o.int(t.micros);
    }

    pub fn flag(o: *Out, b: bool) !void {
        try o.byte(@intFromBool(b));
    }

    pub fn str(o: *Out, s: []const u8) !void {
        try o.int(s.len);
        try o.bytes.appendSlice(o.gpa, s);
    }

    fn optStr(o: *Out, s: ?[]const u8) !void {
        try o.flag(s != null);
        if (s) |x| try o.str(x);
    }

    /// A text as its position in the `texts` table.
    pub fn name(o: *Out, s: []const u8) !void {
        try o.int(try o.names.?.add(o.gpa, s));
    }

    fn optName(o: *Out, s: ?[]const u8) !void {
        try o.flag(s != null);
        if (s) |x| try o.name(x);
    }

    /// An optional index, as 0 for none and the index plus 1 otherwise.
    pub fn ref(o: *Out, i: ?usize) !void {
        try o.int(if (i) |x| x + 1 else 0);
    }
};

/// The `texts` table being written: each distinct text once, numbered as
/// first met. It keeps its own copy of each.
const Names = struct {
    list: std.ArrayList([]const u8) = .empty,
    seen: std.StringHashMapUnmanaged(usize) = .empty,

    fn deinit(t: *Names, gpa: Allocator) void {
        for (t.list.items) |x| gpa.free(x);
        t.list.deinit(gpa);
        t.seen.deinit(gpa);
    }

    fn add(t: *Names, gpa: Allocator, s: []const u8) !usize {
        if (t.seen.get(s)) |at| return at;
        const copy = try gpa.dupe(u8, s);
        errdefer gpa.free(copy);
        try t.list.ensureUnusedCapacity(gpa, 1);
        try t.seen.put(gpa, copy, t.list.items.len);
        t.list.appendAssumeCapacity(copy);
        return t.list.items.len - 1;
    }
};

/// A table of encoded entries, each written once: an entry whose bytes
/// equal an earlier one's is that one.
const Shared = struct {
    entries: std.ArrayList([]u8) = .empty,
    seen: std.StringHashMapUnmanaged(usize) = .empty,

    fn deinit(t: *Shared, gpa: Allocator) void {
        for (t.entries.items) |e| gpa.free(e);
        t.entries.deinit(gpa);
        t.seen.deinit(gpa);
    }

    /// The entry `bytes` is, adding it if it is new; takes `bytes`.
    fn add(t: *Shared, gpa: Allocator, bytes: []u8) !usize {
        if (t.seen.get(bytes)) |at| {
            gpa.free(bytes);
            return at;
        }
        errdefer gpa.free(bytes);
        try t.entries.ensureUnusedCapacity(gpa, 1);
        try t.seen.put(gpa, bytes, t.entries.items.len);
        t.entries.appendAssumeCapacity(bytes);
        return t.entries.items.len - 1;
    }

    fn write(t: *const Shared, o: *Out) !void {
        try o.int(t.entries.items.len);
        for (t.entries.items) |e| try o.bytes.appendSlice(o.gpa, e);
    }
};

/// A save being read. Every read is checked, so bytes that run short or
/// say something impossible are `invalid save`, never a crash.
const In = struct {
    bytes: []const u8,
    pos: usize = 0,
    /// The `texts` section's table, borrowed from `bytes`.
    names: []const []const u8 = &.{},

    /// A text, by its position in the `texts` table.
    pub fn name(i: *In) Error![]const u8 {
        return i.names[try i.index(i.names.len)];
    }

    fn optName(i: *In) Error!?[]const u8 {
        return if (try i.flag()) try i.name() else null;
    }

    /// A byte enum's value below `n`.
    fn enumByte(i: *In, n: usize) Error!usize {
        const b = try i.byte();
        return if (b < n) b else error.InvalidSave;
    }

    fn byte(i: *In) Error!u8 {
        if (i.pos >= i.bytes.len) return error.InvalidSave;
        i.pos += 1;
        return i.bytes[i.pos - 1];
    }

    fn digest(i: *In) Error![32]u8 {
        if (i.bytes.len - i.pos < 32) return error.InvalidSave;
        defer i.pos += 32;
        return i.bytes[i.pos..][0..32].*;
    }

    /// An integer no counter, id or charge of a real save comes near, so
    /// the machine's arithmetic on it never overflows.
    pub fn int(i: *In) Error!u64 {
        const v = try i.wide();
        if (v > 1 << 56) return error.InvalidSave;
        return v;
    }

    fn wide(i: *In) Error!u64 {
        return std.math.cast(u64, try i.unsigned(u128)) orelse error.InvalidSave;
    }

    /// An unsigned LEB128 integer of `T`, in its shortest form.
    fn unsigned(i: *In, comptime T: type) Error!T {
        var out: T = 0;
        var shift: usize = 0;
        while (true) {
            const b = try i.byte();
            const low: T = b & 0x7f;
            if (shift >= @bitSizeOf(T) or (low << @intCast(shift)) >> @intCast(shift) != low) return error.InvalidSave;
            out |= low << @intCast(shift);
            if (b & 0x80 == 0) {
                if (b == 0 and shift > 0) return error.InvalidSave;
                return out;
            }
            shift += 7;
        }
    }

    /// A signed LEB128 integer of `T`, in its shortest form.
    fn signed(i: *In, comptime T: type) Error!T {
        var out: i256 = 0;
        var shift: usize = 0;
        var b: u8 = 0;
        while (true) {
            b = try i.byte();
            if (shift > 256) return error.InvalidSave;
            out |= @as(i256, b & 0x7f) << @intCast(shift);
            shift += 7;
            if (b & 0x80 == 0) break;
        }
        // Sign-extend, then refuse a longer form than needed.
        if (shift < 256 and b & 0x40 != 0) out |= @as(i256, -1) << @intCast(shift);
        if (shift > 7) {
            const prev = i.bytes[i.pos - 2];
            if ((b == 0 and prev & 0x40 == 0) or (b == 0x7f and prev & 0x40 != 0)) return error.InvalidSave;
        }
        return std.math.cast(T, out) orelse error.InvalidSave;
    }

    fn small(i: *In, comptime T: type) Error!T {
        return std.math.cast(T, try i.int()) orelse error.InvalidSave;
    }

    /// A count of things each at least one byte long, so it can't promise
    /// more than the save holds.
    pub fn count(i: *In) Error!usize {
        const n = try i.int();
        if (n > i.bytes.len - i.pos) return error.InvalidSave;
        return @intCast(n);
    }

    fn instant(i: *In) Error!model.dates.Instant {
        const seconds = try i.signed(i64);
        const micros = try i.int();
        if (micros >= std.time.us_per_s) return error.InvalidSave;
        return .{ .seconds = seconds, .micros = @intCast(micros) };
    }

    pub fn flag(i: *In) Error!bool {
        return switch (try i.byte()) {
            0 => false,
            1 => true,
            else => error.InvalidSave,
        };
    }

    /// Text borrowed from the save, which must be UTF-8.
    pub fn str(i: *In) Error![]const u8 {
        const n = try i.count();
        const s = i.bytes[i.pos .. i.pos + n];
        i.pos += n;
        if (!std.unicode.utf8ValidateSlice(s)) return error.InvalidSave;
        return s;
    }

    fn optStr(i: *In) Error!?[]const u8 {
        return if (try i.flag()) try i.str() else null;
    }

    /// An optional index below `n`.
    pub fn ref(i: *In, n: usize) Error!?usize {
        const v = try i.int();
        if (v == 0) return null;
        if (v - 1 >= n) return error.InvalidSave;
        return @intCast(v - 1);
    }

    /// An index below `n`.
    pub fn index(i: *In, n: usize) Error!usize {
        const v = try i.int();
        if (v >= n) return error.InvalidSave;
        return @intCast(v);
    }

    /// The end of a section, which its fields must account for.
    fn end(i: *In) Error!void {
        if (i.pos != i.bytes.len) return error.InvalidSave;
    }
};

// ---------------------------------------------------------------- values

/// A value's tag is its Kind, in talk.h's order, which `save-format.toml`
/// numbers the same way.
const Tag = model.Kind;

/// What a save's values refer to: Host Objects and Function Value code, by
/// their index in the save.
const Tables = struct {
    objects: []const *objects.Object,
    functions: []const *machine.FunctionCode,
    /// While saving, the code the save reaches, numbered as first met.
    met: ?*Met = null,

    fn objectIndex(t: Tables, identity: usize) ?usize {
        for (t.objects, 0..) |o, i| if (@intFromPtr(o) == identity) return i;
        return null;
    }

    fn functionIndex(t: Tables, identity: usize) ?usize {
        for (t.functions, 0..) |f, i| if (@intFromPtr(f) == identity) return i;
        return null;
    }

    /// A written Function Value's code index: its place among the code the
    /// writer has met so far, or the next one.
    fn meet(t: Tables, gpa: Allocator, identity: usize) !?usize {
        const m = t.met orelse return t.functionIndex(identity);
        if (m.index.get(identity)) |at| return at;
        const at = t.functionIndex(identity) orelse return null;
        try m.codes.ensureUnusedCapacity(gpa, 1);
        try m.index.put(gpa, identity, m.codes.items.len);
        m.codes.appendAssumeCapacity(t.functions[at]);
        return m.codes.items.len - 1;
    }
};

/// The Function Value code a save reaches, in the order the writer first
/// meets it (chapter 10, functions).
const Met = struct {
    codes: std.ArrayList(*machine.FunctionCode) = .empty,
    index: std.AutoHashMapUnmanaged(usize, usize) = .empty,

    fn deinit(m: *Met, gpa: Allocator) void {
        m.codes.deinit(gpa);
        m.index.deinit(gpa);
    }
};

/// One step of writing a value: a value, or a map key before its value.
const WriteStep = union(enum) { value: *const Value, key: []const u8 };

fn marks(v: *const Value) u8 {
    return @as(u8, @intFromBool(v.core_message)) | @as(u8, @intFromBool(v.script_name)) << 1;
}

fn decimal(o: *Out, d: model.Decimal) !void {
    try o.flag(d.negative);
    try o.int(d.coefficient);
    try o.signed(d.exponent);
}

fn civil(o: *Out, f: model.dates.Fields) !void {
    try o.signed(f.year);
    try o.int(f.month);
    try o.int(f.day);
    try o.flag(f.has_time);
    if (f.has_time) {
        try o.int(f.hour);
        try o.int(f.minute);
        try o.int(f.second);
        try o.int(f.microsecond);
    }
}

/// A Quantity's Unit as its display form shows it: plural unless the
/// magnitude is 1 or -1.
fn unitText(gpa: Allocator, q: model.Quantity) ![]u8 {
    const one = model.Decimal.order(q.number, model.Decimal.fromInt(@as(i32, 1))) == .eq or model.Decimal.order(q.number, model.Decimal.fromInt(@as(i32, -1))) == .eq;
    return q.unit.string(gpa, !one) catch error.OutOfMemory;
}

/// A Script value. Containers push their children on a heap work list, so
/// a deep value never deepens the native stack.
fn writeValue(o: *Out, t: Tables, root: *const Value) !void {
    var steps: std.ArrayList(WriteStep) = .empty;
    defer steps.deinit(o.gpa);
    try steps.append(o.gpa, .{ .value = root });
    while (steps.pop()) |step| {
        const v = switch (step) {
            .key => |k| {
                try o.name(k);
                continue;
            },
            .value => |v| v,
        };
        try o.byte(@intCast(@backingInt(v.kind())));
        switch (v.data) {
            .nothing => {},
            .bool => |b| try o.flag(b),
            .number => |n| try decimal(o, n),
            .quantity => |q| {
                try decimal(o, q.number);
                const u = try unitText(o.gpa, q);
                defer o.gpa.free(u);
                try o.name(u);
            },
            .text => |s| {
                try o.byte(marks(v));
                try o.str(s);
            },
            .bytes => |s| try o.str(s),
            .list => |items| {
                try o.int(items.len);
                try steps.ensureUnusedCapacity(o.gpa, items.len);
                var i = items.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = items[i] });
                }
            },
            .map => |pairs| {
                try o.byte(marks(v));
                try o.int(pairs.len);
                try steps.ensureUnusedCapacity(o.gpa, 2 * pairs.len);
                var i = pairs.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = pairs.at(i).value });
                    steps.appendAssumeCapacity(.{ .key = pairs.at(i).key });
                }
            },
            .range => |r| {
                try steps.ensureUnusedCapacity(o.gpa, 2);
                steps.appendAssumeCapacity(.{ .value = r.to });
                steps.appendAssumeCapacity(.{ .value = r.from });
            },
            .instant => |x| try o.instant(x),
            .civil_date => |f| try civil(o, f),
            .pattern => |s| try o.str(s),
            .function => |f| {
                // A value this Group didn't make is gone: none of its code.
                const code = try t.meet(o.gpa, f.identity);
                try o.ref(code);
                try o.name(f.display);
                // A value with code takes its home from it.
                if (code) |c| std.debug.assert(std.mem.eql(u8, f.home, t.met.?.codes.items[c].home)) else try o.name(f.home);
                try steps.append(o.gpa, .{ .value = f.captures });
            },
            .object => |x| try o.int(t.objectIndex(x.identity) orelse return error.OutOfMemory),
        }
    }
}

/// A container whose children are still being read.
const Reading = struct {
    kind: union(enum) {
        list,
        map: u8,
        range,
        function: struct { code: ?usize, shown: []const u8, home: []const u8 },
    },
    /// How many children it has; a Function has its captures alone.
    len: usize,
    items: std.ArrayList(*Value) = .empty,
    keys: std.ArrayList([]const u8) = .empty,

    fn deinit(r: *Reading, gpa: Allocator) void {
        for (r.items.items) |x| x.release();
        r.items.deinit(gpa);
        r.keys.deinit(gpa);
    }
};

/// A Script value. Open containers wait on a heap stack, so a deep value
/// never deepens the native stack.
fn readValue(i: *In, gpa: Allocator, t: Tables) Error!*Value {
    var stack: std.ArrayList(Reading) = .empty;
    defer {
        for (stack.items) |*r| r.deinit(gpa);
        stack.deinit(gpa);
    }
    while (true) {
        var v = (try readOne(i, gpa, t, &stack)) orelse continue;
        // Hand the value to the container it belongs to, finishing each
        // container whose last child it is.
        while (true) {
            if (stack.items.len == 0) return v;
            const top = &stack.items[stack.items.len - 1];
            top.items.append(gpa, v) catch {
                v.release();
                return error.OutOfMemory;
            };
            if (top.items.items.len < top.len) {
                if (top.kind == .map) try top.keys.append(gpa, try i.name());
                break;
            }
            v = try finish(gpa, t, top);
            var done = stack.pop().?;
            done.deinit(gpa);
        }
    }
}

/// A finished container, from its children.
fn finish(gpa: Allocator, t: Tables, r: *Reading) Error!*Value {
    switch (r.kind) {
        .list => return model.list(gpa, r.items.items) catch |e| return valueError(e),
        .range => return model.range(gpa, r.items.items[0], r.items.items[1]) catch |e| return valueError(e),
        .map => |flags| {
            const pairs = try gpa.alloc(model.Pair, r.items.items.len);
            defer gpa.free(pairs);
            for (pairs, r.keys.items, r.items.items) |*p, k, x| p.* = .{ .key = k, .value = x };
            const v = model.map(gpa, pairs) catch |e| return valueError(e);
            v.core_message = flags & 1 != 0;
            v.script_name = flags & 2 != 0;
            return v;
        },
        .function => |f| {
            const captures = r.items.items[0];
            if (captures.data != .map) return error.InvalidSave;
            // A value whose code this Group never had stays gone.
            const identity: usize = if (f.code) |c| @intFromPtr(t.functions[c]) else 0;
            return model.function(gpa, f.home, f.shown, identity, captures) catch |e| return valueError(e);
        },
    }
}

fn readDecimal(i: *In) Error!model.Decimal {
    const negative = try i.flag();
    const coefficient = try i.unsigned(u128);
    const exponent = try i.signed(i32);
    if (coefficient >= 10000000000000000000000000000000000 or exponent < -6176 or exponent > 0) return error.InvalidSave;
    return .{ .negative = negative, .coefficient = coefficient, .exponent = exponent };
}

fn readCivil(i: *In) Error!model.dates.Fields {
    var f: model.dates.Fields = .{ .year = try i.signed(c_int), .month = try i.small(c_int), .day = try i.small(c_int) };
    if (try i.flag()) {
        f.has_time = true;
        f.hour = try i.small(c_int);
        f.minute = try i.small(c_int);
        f.second = try i.small(c_int);
        f.microsecond = try i.small(c_int);
    }
    model.dates.validate(f) catch return error.InvalidSave;
    return f;
}

fn marked(v: *Value, flags: u8) *Value {
    v.core_message = flags & 1 != 0;
    v.script_name = flags & 2 != 0;
    return v;
}

/// Reads a leaf, an empty container, or opens a container and returns null.
fn readOne(i: *In, gpa: Allocator, t: Tables, stack: *std.ArrayList(Reading)) Error!?*Value {
    const tag = std.enums.fromInt(Tag, @as(c_int, try i.byte())) orelse return error.InvalidSave;
    return switch (tag) {
        .nothing => model.scalar(gpa, .nothing),
        .bool => model.scalar(gpa, .{ .bool = try i.flag() }),
        .number => model.scalar(gpa, .{ .number = try readDecimal(i) }),
        .quantity => blk: {
            const n = try readDecimal(i);
            const unit = try i.name();
            const v = model.quantity(gpa, n, unit) catch |e| return valueError(e);
            if (v.data != .quantity or !std.meta.eql(v.data.quantity.number, n)) {
                v.release();
                return error.InvalidSave;
            }
            break :blk v;
        },
        .text => blk: {
            const flags = try i.byte();
            if (flags > 3) return error.InvalidSave;
            const v = model.text(gpa, try i.str()) catch |e| return valueError(e);
            break :blk marked(v, flags);
        },
        .bytes => blk: {
            const n = try i.count();
            const s = i.bytes[i.pos .. i.pos + n];
            i.pos += n;
            break :blk model.bytes(gpa, s) catch |e| return valueError(e);
        },
        .list => blk: {
            const n = try i.count();
            if (n == 0) break :blk model.list(gpa, &.{}) catch |e| return valueError(e);
            try stack.append(gpa, .{ .kind = .list, .len = n });
            break :blk null;
        },
        .map => blk: {
            const flags = try i.byte();
            if (flags > 3) return error.InvalidSave;
            const n = try i.count();
            if (n == 0) {
                const v = model.map(gpa, &.{}) catch |e| return valueError(e);
                break :blk marked(v, flags);
            }
            try stack.append(gpa, .{ .kind = .{ .map = flags }, .len = n });
            const top = &stack.items[stack.items.len - 1];
            try top.keys.append(gpa, try i.name());
            break :blk null;
        },
        .range => blk: {
            try stack.append(gpa, .{ .kind = .range, .len = 2 });
            break :blk null;
        },
        .instant => blk: {
            const x = try i.instant();
            model.dates.validateInstant(x) catch return error.InvalidSave;
            break :blk model.scalar(gpa, .{ .instant = x });
        },
        .civil_date => model.scalar(gpa, .{ .civil_date = try readCivil(i) }),
        .pattern => @import("../pattern.zig").parse(gpa, try i.str()) catch |e| return valueError(e),
        .function => blk: {
            const code = try i.ref(t.functions.len);
            const shown = try i.name();
            const home = if (code) |c| t.functions[c].home else try i.name();
            try stack.append(gpa, .{ .kind = .{ .function = .{ .code = code, .shown = shown, .home = home } }, .len = 1 });
            break :blk null;
        },
        .object => t.objects[try i.index(t.objects.len)].value.retain(),
    };
}

/// A mathematical deadline, which may lie outside the Instant range.
fn deadline(i: *In) Error!machine.DeadlineTicks {
    const at = try i.signed(machine.DeadlineTicks);
    // A 34-digit base duration scaled to microseconds, plus a Clock.
    if (@abs(at) > 10000000000000000000000000000000000000000 + 253402300800000000) return error.InvalidSave;
    return at;
}

fn duration(i: *In) Error!machine.DeadlineTicks {
    const us = try i.signed(machine.DeadlineTicks);
    var n = @abs(us);
    var exponent: i32 = -6;
    while (exponent < 0 and n % 10 == 0) : (exponent += 1) n /= 10;
    if (n >= 10000000000000000000000000000000000) return error.InvalidSave;
    return us;
}

fn valueError(e: anyerror) Error {
    return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidSave;
}

fn writeValues(o: *Out, t: Tables, vs: []const *Value) !void {
    try o.int(vs.len);
    for (vs) |v| try writeValue(o, t, v);
}

/// Values the caller owns, all or none.
fn readValues(i: *In, gpa: Allocator, t: Tables) Error![]*Value {
    const n = try i.count();
    const out = try gpa.alloc(*Value, n);
    var made: usize = 0;
    errdefer {
        for (out[0..made]) |v| v.release();
        gpa.free(out);
    }
    for (out) |*v| {
        v.* = try readValue(i, gpa, t);
        made += 1;
    }
    return out;
}

fn optValue(o: *Out, t: Tables, v: ?*const Value) !void {
    try o.flag(v != null);
    if (v) |x| try writeValue(o, t, x);
}

fn readOptValue(i: *In, gpa: Allocator, t: Tables) Error!?*Value {
    return if (try i.flag()) try readValue(i, gpa, t) else null;
}

// ---------------------------------------------------------------- saving

/// Where code is, relative to a Script: its own unit, one of its
/// extensions, a Library the Group holds, or a stdlib Library by name.
const UnitTag = enum(u8) { own, extension, library, stdlib };

const Saving = struct {
    o: Out,
    g: *Group,
    tables: Tables,
    runs: std.ArrayList(*Run) = .empty,
    waits: machine.wait_table.Waits.Export,
    /// The internal values a dispatch activation shares, saved once.
    iterators: std.ArrayList(*machine.Iterator) = .empty,
    readers: std.ArrayList(*binary.Reader) = .empty,
    replacements: std.ArrayList(*machine.Replacement) = .empty,
    /// Each Run's segment base, in the `runs` section's `bases`.
    bases: std.AutoHashMapUnmanaged(*const Run, usize) = .empty,

    fn deinit(s: *Saving) void {
        const gpa = s.o.gpa;
        s.bases.deinit(gpa);
        s.runs.deinit(gpa);
        s.waits.deinit(gpa);
        s.iterators.deinit(gpa);
        s.readers.deinit(gpa);
        s.replacements.deinit(gpa);
    }

    fn value(s: *Saving, v: *const Value) !void {
        try writeValue(&s.o, s.tables, v);
    }

    fn values(s: *Saving, vs: []const *Value) !void {
        try writeValues(&s.o, s.tables, vs);
    }

    fn unit(s: *Saving, script: *const Script, library: ?*Library) !void {
        const l = library orelse return s.o.byte(@backingInt(UnitTag.own));
        if (l.extension > 0) {
            try s.o.byte(@backingInt(UnitTag.extension));
            return s.o.int(std.mem.indexOfScalar(*Library, script.extensions.items, l).?);
        }
        if (l.stdlib) {
            try s.o.byte(@backingInt(UnitTag.stdlib));
            return s.o.name(l.name);
        }
        try s.o.byte(@backingInt(UnitTag.library));
        try s.o.int(std.mem.indexOfScalar(*Library, s.g.libraries.items, l).?);
    }

    fn object(s: *Saving, o: ?*const objects.Object) !void {
        try s.o.ref(if (o) |x| s.tables.objectIndex(@intFromPtr(x)) else null);
    }

    fn call(s: *Saving, c: ?*capabilities.Call) !void {
        try s.o.ref(if (c) |x| std.mem.indexOfScalar(*capabilities.Call, s.waits.calls.items, x) else null);
    }

    fn slots(s: *Saving, stack: []const Slot) !void {
        try s.o.int(stack.len);
        for (stack) |slot| switch (slot) {
            .value => |v| {
                try s.o.byte(0);
                try s.value(v);
            },
            .iterator => |it| {
                try s.o.byte(1);
                if (std.mem.indexOfScalar(*machine.Iterator, s.iterators.items, it)) |i| {
                    try s.o.ref(i);
                    continue;
                }
                try s.o.ref(null);
                try s.iterators.append(s.o.gpa, it);
                try optValue(&s.o, s.tables, it.subject);
                try s.o.int(it.position);
                try s.o.int(it.left);
            },
            .reader => |r| {
                try s.o.byte(2);
                if (std.mem.indexOfScalar(*binary.Reader, s.readers.items, r)) |i| {
                    try s.o.ref(i);
                    continue;
                }
                try s.o.ref(null);
                try s.readers.append(s.o.gpa, r);
                try s.value(r.subject);
                try s.o.int(r.position);
            },
            .replacement => |r| {
                try s.o.byte(3);
                if (std.mem.indexOfScalar(*machine.Replacement, s.replacements.items, r)) |i| {
                    try s.o.ref(i);
                    continue;
                }
                try s.o.ref(null);
                try s.replacements.append(s.o.gpa, r);
                try s.value(r.text);
                try s.value(r.matches);
                try s.o.int(r.spans.len);
                for (r.spans) |span| {
                    try s.o.int(span[0]);
                    try s.o.int(span[1]);
                }
                try s.o.int(r.next);
                try s.o.int(r.position);
                try s.o.str(r.pieces.items);
            },
            .deadline => |d| {
                try s.o.byte(4);
                try s.o.signed(d.deadline.at);
                try s.o.signed(d.deadline.us);
            },
        };
    }

    fn frames(s: *Saving, run: *const Run, fs: []const Frame) !void {
        try s.o.int(fs.len);
        for (fs) |f| {
            try s.unit(run.script, f.library);
            try s.o.int(f.body);
            try s.o.int(f.pc);
            try s.values(f.locals);
            try s.slots(f.stack.items);
            try s.o.flag(f.called);
            try s.o.flag(f.restricted);
        }
    }

    fn limit(s: *Saving, l: ?machine.Limit) !void {
        try s.o.flag(l != null);
        if (l) |x| {
            try s.o.int(x.frame);
            try s.o.int(x.entry);
        }
    }

    fn search(s: *Saving, x: machine.Search) !void {
        try s.o.int(x.frame);
        try s.o.int(x.entry);
        try s.o.int(x.raised);
        try s.limit(x.limit);
        try s.o.int(x.position);
        try s.limit(x.skip);
    }

    fn control(s: *Saving, run: *const Run, c: machine.Control) !void {
        switch (c) {
            .dispatch => |d| {
                try s.o.byte(0);
                try s.value(d.err);
                try s.o.int(d.owner);
                try s.o.int(d.place);
                try s.frames(run, d.held);
                try s.slots(d.owner_stack.items);
                try s.o.int(d.owner_pc);
                try s.search(d.search);
            },
            .cleanup => |u| {
                try s.o.byte(1);
                try s.value(u.err);
                try s.o.int(u.cleanups.items.len);
                for (u.cleanups.items) |x| {
                    try s.o.int(x.frame);
                    try s.o.int(x.target);
                    try s.o.int(x.depth);
                    try s.o.int(x.entry);
                    try s.o.flag(x.leave);
                }
                try s.o.int(u.next);
                try s.o.flag(u.left);
                try s.o.int(u.failed);
                try s.o.flag(u.failed_frame != null);
                if (u.failed_frame) |f| try s.o.int(f);
                try s.frames(run, u.held.items);
                switch (u.then) {
                    .accept => |a| {
                        try s.o.byte(0);
                        try s.o.int(a.frame);
                        try s.o.int(a.pc);
                        try s.slots(a.stack.items);
                    },
                    .end => try s.o.byte(1),
                    .cancel => try s.o.byte(2),
                    .transfer => |t| {
                        try s.o.byte(3);
                        try s.o.int(t.frame);
                        try s.o.int(t.offer_entry);
                        try s.o.int(t.record);
                        try s.o.int(t.offer);
                        try s.values(t.args);
                        try s.o.int(t.attempt);
                        try s.limit(t.limit);
                    },
                    .search => |x| {
                        try s.o.byte(4);
                        try s.search(x);
                    },
                }
            },
        }
    }

    fn failure(s: *Saving, f: machine.Failure) !void {
        try s.o.name(f.code);
        try s.o.optName(f.message);
        try optValue(&s.o, s.tables, f.data);
    }

    fn resumeWith(s: *Saving, r: ?machine.Resume) !void {
        const with = r orelse return s.o.byte(0);
        try s.o.byte(@as(u8, @backingInt(std.meta.activeTag(with))) + 1);
        switch (with) {
            .answer => |a| {
                try s.value(a.value);
                try s.o.int(a.fuel);
            },
            .failed => |f| try s.failure(f),
            .reply => |v| try s.value(v),
            .event => |e| {
                try optValue(&s.o, s.tables, e.message);
                try s.o.int(e.branch);
                try s.o.int(e.binds);
            },
            .send_failed => |x| {
                try s.o.str(x.reason);
                try optValue(&s.o, s.tables, x.err);
            },
            .join_failed => |i| try s.o.int(i),
            // This Core keeps no Host-only failure detail.
            .broken => try s.o.flag(false),
            .timeout, .woke, .joined, .unparked, .cancelled, .lost, .limited, .revoked => {},
        }
    }

    fn waited(s: *Saving, w: machine.Waited) !void {
        try s.o.name(w.id);
        try s.o.flag(w.block);
        try s.call(w.call);
        try s.o.name(w.grant);
        try s.o.name(w.operation);
        try s.o.flag(w.decl != null);
        try s.o.signed(w.after_us);
    }

    fn pending(s: *Saving, run: *const Run, p: ?*const Pending) !void {
        const x = p orelse return s.o.flag(false);
        try s.o.flag(true);
        try s.o.name(x.id);
        try s.o.flag(x.deadline != machine.wait_table.never);
        if (x.deadline != machine.wait_table.never) try s.o.signed(x.deadline);
        try s.o.int(x.order);
        try s.call(x.call);
        try s.o.name(x.grant);
        try s.o.name(x.operation);
        try s.o.flag(x.decl != null);
        try s.o.signed(x.after_us);
        try s.o.ref(x.member);
        try s.o.flag(x.block);
        try s.o.int(x.branch);
        try s.o.flag(x.event != null);
        if (x.event) |e| {
            try s.unit(run.script, e.library);
            try s.o.int(e.entry);
            try s.o.flag(e.any);
            try s.o.int(e.branches.len);
            for (e.branches) |b| switch (b) {
                .when => |w| {
                    try s.o.byte(0);
                    try optValue(&s.o, s.tables, w.from);
                    try s.values(w.captures);
                },
                .after => |at| {
                    try s.o.byte(1);
                    try s.o.signed(at);
                },
            };
        }
    }

    fn override(s: *Saving, o: ?machine.Override) !void {
        try s.o.flag(o != null);
        const x = o orelse return;
        inline for (.{ x.fuel_per_run, x.alloc_per_run, x.max_wait_ms, x.max_join }) |v| {
            try s.o.flag(v != null);
            if (v) |n| try s.o.int(n);
        }
    }

    fn delivery(s: *Saving, d: machine.Delivery) !void {
        try s.o.int(d.id);
        try s.o.int(d.root);
        try s.o.name(d.message);
        try s.values(d.args);
        try s.o.flag(d.request);
        try optValue(&s.o, s.tables, d.during);
        try s.o.optName(d.from);
        try s.o.flag(d.internal_error);
        try s.o.flag(d.waits);
        try s.object(d.target);
        try s.object(d.at);
        try optValue(&s.o, s.tables, d.function);
        try s.o.flag(d.decision);
        try s.o.flag(d.decides);
        try s.o.int(d.broadcast);
        try s.override(d.limits);
        try s.object(d.passed_by);
    }

    fn limits(s: *Saving, l: machine.Limits) !void {
        try s.o.int(@typeInfo(machine.Limits).@"struct".field_names.len);
        inline for (@typeInfo(machine.Limits).@"struct".field_names) |f| try s.o.int(@field(l, f));
    }

    fn oneRun(s: *Saving, r: *const Run) !void {
        try s.o.name(r.id);
        try s.o.int(r.order);
        try s.o.flag(r.reported_fuel != null);
        if (r.reported_fuel) |f| try s.o.int(f);
        try s.o.int(r.fuel);
        try s.o.int(r.alloc);
        try s.delivery(r.delivery);
        try s.o.name(r.handler);
        try s.o.int(r.clause);
        try s.limits(r.limits);
        try s.o.int(r.clause_fuel);
        try s.o.flag(r.preempted_in != null);
        if (r.preempted_in) |p| {
            try s.unit(r.script, p.library);
            try s.o.int(p.body);
            try s.o.flag(p.fallback);
        }
        try s.o.flag(machine.run_lifecycle.continuing(r));
        try s.o.int(r.clauses_seen);
        try s.o.flag(r.cleanup_from != null);
        if (r.cleanup_from) |x| try s.o.int(x);
        try s.o.flag(r.cleanup_limited);
        try s.o.int(r.controls.items.len);
        for (r.controls.items) |c| try s.control(r, c);
        try s.o.int(r.attempts);
        try s.o.int(r.calls);
        try s.o.int(r.segment_fuel);
        try s.o.int(r.segment_alloc);
        try s.o.flag(r.started);
        try s.pending(r, r.waiting);
        try s.resumeWith(r.resume_with);
        try s.o.name(r.suspended_at);
        try s.waited(r.waited);
        try s.o.flag(r.raised_at != null);
        if (r.raised_at) |p| {
            try s.o.int(p.line);
            try s.o.int(p.column);
        }
        try s.o.flag(r.join != null);
        if (r.join) |j| {
            try s.o.int(j.frame);
            try s.o.int(j.start);
            try s.o.int(j.members.items.len);
            for (j.members.items) |m| {
                try s.o.int(m.frame);
                try s.o.int(m.start);
                try s.pending(r, m.pending);
                try s.waited(m.waited);
                try s.resumeWith(m.with);
                try s.o.flag(m.cut);
            }
        }
        try s.o.flag(r.clause_body != null);
        if (r.clause_body) |b| {
            try s.unit(r.script, r.clause_unit);
            try s.o.int(b);
        }
        try s.o.flag(r.fallback);
        try s.o.flag(r.select_at != null);
        if (r.select_at) |x| try s.o.int(x);
        try s.o.flag(r.state == .parked);
        try s.o.int(r.abandoned.items.len);
        for (r.abandoned.items) |id| try s.o.name(id);
        try s.o.int(r.base);
        try s.o.int(r.segments);
        try s.o.flag(r.verdict);
        try s.o.ref(s.bases.get(r));
        try s.frames(r, r.frames.items);
    }

    fn mark(s: *Saving, m: machine.Mark) !void {
        try s.o.name(m.script);
        try s.o.name(m.run);
        try optValue(&s.o, s.tables, m.reason);
        try s.o.byte(outcomeByte(m.outcome));
    }

    fn input(s: *Saving, x: machine.Input) !void {
        // A charge request has no tag: it refuses the save.
        if (x == .charge_request) return error.EffectsPending;
        try s.o.byte(@as(u8, @backingInt(std.meta.activeTag(x))) - 1);
        switch (x) {
            .charge_request => unreachable,
            .deliver => |d| {
                try s.o.name(d.script);
                try s.delivery(d.delivery);
            },
            .set_parent => |p| {
                try s.object(p.object);
                try s.object(p.parent);
            },
            .dispose => |o| try s.object(o),
            .settle => |st| {
                try s.o.name(st.id);
                try s.resumeWith(st.with);
            },
            .broadcast => |b| {
                try s.o.int(b.id);
                try s.o.name(b.message);
                try s.values(b.args);
                try s.o.flag(b.decision);
                try s.override(b.limits);
                // Recipients are found as the queue is drained, so a queued
                // Broadcast has none yet.
            },
            .revoke => |r| {
                try s.o.name(r.script);
                try s.o.name(r.grant);
            },
            .cancel_run, .rewind_run => |id| try s.o.name(id),
            .stop => |st| {
                try s.o.name(st.script);
                try s.o.name(st.reason);
            },
            .cancel_delivery, .cancel_broadcast => |id| try s.o.int(id),
            // A settlement is queued only after a restore, before the
            // first Pump; a save then holds the restored calls again, and
            // its settlements with how they settle (#1055).
            .settlement => |st| {
                try s.o.name(st.id);
                try s.o.byte(@backingInt(st.how));
                try s.resumeWith(st.with);
            },
        }
    }
};

/// Whether saving must refuse with `effects pending`: a live Capability
/// Scope or Segment participant, or effect uncertainty that stopped the
/// Group (ADR 0049).
pub fn effectsPending(g: *const Group) bool {
    if (g.fatal) return true;
    @constCast(g).input_lock.lock();
    defer @constCast(g).input_lock.unlock();
    for (g.charge_requests.items) |q| if (!q.done.load(.acquire)) return true;
    if (g.waits.hasMeteredWait()) return true;
    for (g.scripts.items) |s| for (s.live.items) |r| {
        if (r.scopes.items.len > 0 or r.participant != null) return true;
    };
    return false;
}

/// A save's frame: its header fields and where each section's body is.
const Header = struct {
    language: []const u8,
    costs: u64,
    print: [32]u8,
    saves: u64,
    state: [32]u8,
    /// Each known section's body, by tag; null when it is absent.
    bodies: [@backingInt(Section.sources) + 1]?[]const u8 = @splat(null),
};

/// Reads a save's header and section frames, checking the body digest and
/// that the State Fingerprint matches the section digests. Section bodies
/// are hashed only when `bodies` is set. Another magic, including this
/// Core's formats from before ADR 0144, is `invalid save`; this magic at
/// another version is `Mismatch`.
fn readFrame(bytes: []const u8, bodies: bool) error{ InvalidSave, Mismatch }!Header {
    var i: In = .{ .bytes = bytes };
    if (bytes.len < magic.len or !std.mem.eql(u8, bytes[0..magic.len], magic)) return error.InvalidSave;
    i.pos = magic.len;
    if ((i.int() catch return error.InvalidSave) != format_version) return error.Mismatch;
    var f: Header = .{ .language = undefined, .costs = undefined, .print = undefined, .saves = undefined, .state = undefined };
    f.language = i.str() catch return error.InvalidSave;
    f.costs = i.int() catch return error.InvalidSave;
    f.print = i.digest() catch return error.InvalidSave;
    f.saves = i.int() catch return error.InvalidSave;
    f.state = i.digest() catch return error.InvalidSave;
    var body: Sha256 = .init(.{});
    body.update(bytes[0..i.pos]);
    const given = i.digest() catch return error.InvalidSave;
    var state: Sha256 = .init(.{});
    const n = i.count() catch return error.InvalidSave;
    var last: u8 = 0;
    for (0..n) |_| {
        const tag = i.byte() catch return error.InvalidSave;
        const flags = i.byte() catch return error.InvalidSave;
        const len = i.count() catch return error.InvalidSave;
        const digest = i.digest() catch return error.InvalidSave;
        if (tag <= last or flags > 1 or len > i.bytes.len - i.pos) return error.InvalidSave;
        last = tag;
        const known = std.enums.fromInt(Section, tag);
        // A known section's flag must say what it is; an unknown required
        // one can't be read.
        if (known) |k| {
            if ((flags == 1) != (k == .sources)) return error.InvalidSave;
        } else if (flags == 0) return error.InvalidSave;
        const content = i.bytes[i.pos..][0..len];
        i.pos += len;
        if (bodies or known == null) {
            var d: [32]u8 = undefined;
            Sha256.hash(content, &d, .{});
            if (!std.mem.eql(u8, &d, &digest)) return error.InvalidSave;
        }
        if (known) |k| f.bodies[@backingInt(k)] = content;
        body.update(&.{ tag, flags });
        body.update(&digest);
        if (flags == 0) {
            state.update(&.{tag});
            state.update(&digest);
        }
    }
    if (i.pos != i.bytes.len) return error.InvalidSave;
    for (1..last_required + 1) |t| if (f.bodies[t] == null) return error.InvalidSave;
    if (!std.mem.eql(u8, &body.finalResult(), &given)) return error.InvalidSave;
    if (!std.mem.eql(u8, &state.finalResult(), &f.state)) return error.InvalidSave;
    return f;
}

/// The State Fingerprint of a save's bytes (ADR 0142), read from its header
/// without decoding its sections: the SHA-256 of each required section's
/// tag and digest. Every part of a section is a function of the state, Host
/// Objects by kind, id, parent and disposal, so the restored Group's save
/// gives the same.
pub fn stateFingerprint(bytes: []const u8) error{ InvalidSave, Mismatch }![32]u8 {
    return (try readFrame(bytes, false)).state;
}

/// A live Group's State Fingerprint: its save's, taken without advancing
/// the save id counter or writing to the Trace.
pub fn liveStateFingerprint(g: *Group, gpa: Allocator) ![32]u8 {
    const bytes = try save(g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    return stateFingerprint(bytes) catch unreachable;
}

/// A section being written: where its body starts in `Saving.o`.
const Written = struct { tag: Section, start: usize, end: usize = 0, digest: [32]u8 = undefined };

/// The save's bytes, which `gpa` owns. Saving changes nothing in the Group
/// but its save id counter, which the caller has already advanced.
pub fn save(g: *Group, gpa: Allocator, print: [32]u8) ![]u8 {
    if (effectsPending(g)) return error.EffectsPending;
    g.input_lock.lock();
    defer g.input_lock.unlock();
    for (g.charge_requests.items) |q| if (!q.done.load(.acquire)) return error.EffectsPending;
    var met: Met = .{};
    defer met.deinit(gpa);
    var names: Names = .{};
    defer names.deinit(gpa);
    var s: Saving = .{ .o = .{ .gpa = gpa, .names = &names }, .g = g, .tables = .{ .objects = g.objects.items, .functions = g.functions.items, .met = &met }, .waits = try g.waits.exportState(gpa, g.liveRuns()) };
    defer s.deinit();
    defer s.o.bytes.deinit(gpa);
    const o = &s.o;
    var sections: [@backingInt(Section.sources)]Written = undefined;
    var n: usize = 0;
    const Sections = struct {
        fn begin(list: []Written, at: *usize, out: *Out, tag: Section) void {
            list[at.*] = .{ .tag = tag, .start = out.bytes.items.len };
        }
        fn end(list: []Written, at: *usize, out: *Out) void {
            const w = &list[at.*];
            w.end = out.bytes.items.len;
            Sha256.hash(out.bytes.items[w.start..w.end], &w.digest, .{});
            at.* += 1;
        }
    };
    // 2: the Group's counters and issued call ids.
    Sections.begin(&sections, &n, o, .group);
    try o.str(g.name);
    try o.instant(g.clock);
    try o.int(g.deliveries);
    try o.int(g.broadcasts);
    try o.int(s.waits.table.timers);
    try o.int(g.run_order);
    try o.int(g.charge_counter);
    try o.int(g.random_state);
    try s.waits.writeIssued(gpa, o);
    Sections.end(&sections, &n, o);
    // 3: Libraries, by identity.
    Sections.begin(&sections, &n, o, .libraries);
    try o.int(g.libraries.items.len);
    for (g.libraries.items) |l| {
        try o.name(l.name);
        try o.name(l.version);
        try o.bytes.appendSlice(gpa, &l.identity);
    }
    Sections.end(&sections, &n, o);
    // 4: Host Objects, by kind and id; a parent comes by index.
    Sections.begin(&sections, &n, o, .objects);
    try o.int(g.objects.items.len);
    for (g.objects.items) |x| {
        try o.name(x.kind.name);
        try o.name(x.id);
        try s.object(x.parent);
        try o.flag(x.disposed);
        try o.optName(x.owner_of);
    }
    Sections.end(&sections, &n, o);
    // 6: the calls a Run still waits on, with their arguments.
    Sections.begin(&sections, &n, o, .calls);
    try o.int(s.waits.calls.items.len);
    for (s.waits.calls.items) |c| {
        try o.name(c.id);
        try o.name(c.script);
        try o.name(c.grant);
        try o.name(c.run);
        try o.name(c.segment);
        try o.instant(c.now);
        try s.values(c.args);
        // Every Zig Host call can be adopted, as a TS `start` call can.
        try o.flag(c.adoptable);
        try o.int(c.charged);
        // Its call site, where a refused reissue faults (#1068).
        try o.name(c.at_unit);
        try o.int(c.at_pc);
        try o.int(c.at_line);
        try o.int(c.at_column);
    }
    Sections.end(&sections, &n, o);
    // 7: each Script, in load order, by its code identities.
    Sections.begin(&sections, &n, o, .scripts);
    // The Grants' declarations, each written once, in the order the Grants
    // first meet them.
    var declarations: Shared = .{};
    defer declarations.deinit(gpa);
    var grants: std.ArrayList(usize) = .empty;
    defer grants.deinit(gpa);
    for (g.scripts.items) |x| for (x.grants) |sg| {
        var d: Out = .{ .gpa = gpa, .names = o.names };
        errdefer d.bytes.deinit(gpa);
        const json = sg.declarations orelse try fingerprint.grantJson(gpa, sg.grant.capability, sg.kept);
        defer if (sg.declarations == null) gpa.free(json);
        try d.str(json);
        // The kept Operations, with what a Grant the restore can't re-bind
        // still needs for checking code against.
        try d.name(sg.grant.capability.name);
        var kept: usize = 0;
        for (sg.kept) |k| kept += @intFromBool(k);
        try d.int(kept);
        for (sg.grant.capability.operations, sg.kept) |op, k| if (k) {
            try d.name(op.name);
            try d.byte(@backingInt(op.mode));
            try d.int(op.required());
            try d.int(op.args.len);
            try d.flag(op.command);
            try d.int(op.labels.len);
            for (op.labels) |l| try d.name(l);
        };
        try grants.append(gpa, try declarations.add(gpa, try d.bytes.toOwnedSlice(gpa)));
    };
    try declarations.write(o);
    try o.int(g.scripts.items.len);
    var at: usize = 0;
    for (g.scripts.items) |x| {
        defer at += x.grants.len;
        try o.name(x.name);
        try o.bytes.appendSlice(gpa, &machine.codeIdentity(x.name, x.source, .script, x.imports));
        try o.int(x.extensions.items.len);
        for (x.extensions.items) |e| try o.bytes.appendSlice(gpa, &e.identity);
        try s.limits(x.limits);
        try o.int(x.grants.len);
        for (x.grants, at..) |sg, k| {
            try o.name(sg.name);
            try o.int(grants.items[k]);
            try o.flag(sg.revoked);
            try o.flag(sg.disabled);
        }
        try s.object(x.owner);
        try o.int(x.objects.len);
        for (x.objects) |nm| {
            try o.name(nm.name);
            try s.object(nm.object);
        }
        try o.int(x.variableNames().len);
        for (x.variableNames()) |nm| try o.name(nm);
        try s.values(x.variables);
        // The base unit's definitions, then each extension's, as one list.
        var definitions = x.definitions.len;
        for (x.extensions.items) |e| definitions += e.definitions.len;
        try o.int(definitions);
        for (x.definitions) |v| try s.value(v);
        for (x.extensions.items) |e| for (e.definitions) |v| try s.value(v);
        try o.int(x.runs);
        try o.int(x.fuel_total);
        try o.int(x.alloc_total);
        try o.int(x.faults);
        try o.int(x.debt);
        try o.optName(x.stopped);
    }
    Sections.end(&sections, &n, o);
    // 8: how many Runs each Script has, then every Run, Script by Script,
    // in each one's live order.
    Sections.begin(&sections, &n, o, .runs);
    for (g.scripts.items) |x| try s.runs.appendSlice(gpa, x.live.items);
    try o.int(g.scripts.items.len);
    for (g.scripts.items) |x| try o.int(x.live.items.len);
    // The segment bases, each written once, in the order the Runs first
    // meet them. Writing a repeat meets no new Function Value.
    var bases: Shared = .{};
    defer bases.deinit(gpa);
    for (s.runs.items) |r| if (r.segment_base) |b| {
        var d: Out = .{ .gpa = gpa, .names = o.names };
        errdefer d.bytes.deinit(gpa);
        try writeValues(&d, s.tables, b);
        try s.bases.put(gpa, r, try bases.add(gpa, try d.bytes.toOwnedSlice(gpa)));
    };
    try bases.write(o);
    try o.int(s.runs.items.len);
    for (s.runs.items) |r| try s.oneRun(r);
    Sections.end(&sections, &n, o);
    // 9: each Script's work, in order.
    Sections.begin(&sections, &n, o, .work);
    try o.int(g.scripts.items.len);
    for (g.scripts.items) |x| {
        try o.int(x.work.items.len);
        for (x.work.items) |w| switch (w) {
            .message => |d| {
                try o.byte(0);
                try s.delivery(d);
            },
            .run => |r| {
                try o.byte(1);
                try o.int(std.mem.indexOfScalar(*Run, s.runs.items, r).?);
            },
        };
    }
    Sections.end(&sections, &n, o);
    // 10: every pending wait, in the order it was set, each by its Run and,
    // for a Join Member, its member.
    Sections.begin(&sections, &n, o, .waits);
    try s.waits.writeOrder(o, s.runs.items);
    Sections.end(&sections, &n, o);
    // 11: the Host inputs queued for the next Pump.
    Sections.begin(&sections, &n, o, .inputs);
    try o.int(g.inputs.items.len);
    for (g.inputs.items) |x| try s.input(x);
    Sections.end(&sections, &n, o);
    // 12: Broadcast Decisions some recipient hasn't sealed, by id: a hash
    // map's order depends on its insertion history, which a restore
    // doesn't keep. Then those a variables-only restore left for the first
    // Pump.
    Sections.begin(&sections, &n, o, .decisions);
    const open = try sortedKeys(machine.OpenBroadcast, gpa, g.open_broadcasts);
    defer gpa.free(open);
    try o.int(open.len);
    for (open) |id| {
        const e = g.open_broadcasts.getPtr(id).?;
        try o.int(id);
        try o.int(e.deliveries.len);
        for (e.deliveries, e.parts) |d, part| {
            try o.int(d);
            const p = part orelse {
                try o.byte(0);
                continue;
            };
            switch (p) {
                .allowed => try o.byte(1),
                .vetoed => |m| {
                    try o.byte(2);
                    try s.mark(m);
                },
                .undecided => |m| {
                    try o.byte(3);
                    try s.mark(m);
                },
            }
        }
    }
    try o.int(g.deferred.items.len);
    for (g.deferred.items) |x| {
        try o.int(x.id);
        try o.int(x.broadcast);
        try o.flag(x.mark != null);
        if (x.mark) |m| try s.mark(m);
    }
    Sections.end(&sections, &n, o);
    // 13: Run accounting: each root's discarded messages, and the roots
    // whose work changed since the last report (chapter 9, Run accounting).
    Sections.begin(&sections, &n, o, .accounting);
    const discards = try sortedKeys(u64, gpa, g.root_discards);
    defer gpa.free(discards);
    try o.int(discards.len);
    for (discards) |root| {
        try o.int(root);
        try o.int(g.root_discards.get(root).?);
    }
    try o.int(g.changed_roots.count());
    for (g.changed_roots.keys()) |root| try o.int(root);
    Sections.end(&sections, &n, o);
    // 14: the sources, since this Core writes only Embedded-source
    // Snapshots.
    Sections.begin(&sections, &n, o, .sources);
    try o.int(g.scripts.items.len);
    for (g.scripts.items) |x| {
        try o.str(x.source);
        try o.int(x.extensions.items.len);
        for (x.extensions.items) |e| try o.str(e.source);
    }
    Sections.end(&sections, &n, o);

    // 5: Function Value code, only what the save reaches, numbered as the
    // other sections first met it; a stale value's keeps only what it still
    // answers. Its bytes follow the others', and the frames go in tag order.
    Sections.begin(&sections, &n, o, .functions);
    try o.int(met.codes.items.len);
    for (met.codes.items) |f| {
        try o.name(f.home);
        try o.name(f.name);
        try o.int(f.required);
        try o.int(f.total);
        try o.bytes.appendSlice(gpa, &f.unit);
        const home = g.script(f.home);
        const live = if (home) |h| h.generation == f.generation else false;
        try o.flag(live);
        if (live) {
            try s.unit(home.?, f.library);
            try o.int(f.body);
        }
    }
    Sections.end(&sections, &n, o);
    // 1: every text the others name, numbered as first met, so written
    // last of all and framed first.
    Sections.begin(&sections, &n, o, .texts);
    try o.int(names.list.items.len);
    for (names.list.items) |x| try o.str(x);
    Sections.end(&sections, &n, o);
    std.mem.sort(Written, sections[0..n], {}, struct {
        fn less(_: void, x: Written, y: Written) bool {
            return @backingInt(x.tag) < @backingInt(y.tag);
        }
    }.less);

    // The header, then each section's frame and body.
    var h: Out = .{ .gpa = gpa };
    errdefer h.bytes.deinit(gpa);
    var frames: usize = 0;
    for (sections[0..n]) |w| frames += 2 + 10 + 32 + (w.end - w.start);
    try h.bytes.ensureTotalCapacity(gpa, 128 + version.language.len + frames);
    try h.bytes.appendSlice(gpa, magic);
    try h.int(format_version);
    try h.str(version.language);
    try h.int(cost_model.version);
    try h.bytes.appendSlice(gpa, &print);
    try h.int(g.saves);
    var state: Sha256 = .init(.{});
    for (sections[0..n]) |w| if (w.tag != .sources) {
        state.update(&.{@backingInt(w.tag)});
        state.update(&w.digest);
    };
    try h.bytes.appendSlice(gpa, &state.finalResult());
    var body: Sha256 = .init(.{});
    body.update(h.bytes.items);
    for (sections[0..n]) |w| {
        body.update(&.{ @backingInt(w.tag), @intFromBool(w.tag == .sources) });
        body.update(&w.digest);
    }
    try h.bytes.appendSlice(gpa, &body.finalResult());
    try h.int(n);
    for (sections[0..n]) |w| {
        try h.byte(@backingInt(w.tag));
        try h.flag(w.tag == .sources);
        try h.int(w.end - w.start);
        try h.bytes.appendSlice(gpa, &w.digest);
        try h.bytes.appendSlice(gpa, o.bytes.items[w.start..w.end]);
    }
    return h.bytes.toOwnedSlice(gpa);
}

/// A Mark's outcomes, by their byte.
const outcomes = [_][]const u8{ "vetoed", "errored", "limit fault", "cancelled", "dropped", "stopped" };

fn outcomeByte(outcome: []const u8) u8 {
    for (outcomes, 0..) |x, b| if (std.mem.eql(u8, x, outcome)) return @intCast(b);
    unreachable;
}

fn modeName(m: capabilities.Mode) []const u8 {
    return switch (m) {
        .immediate => "immediate",
        .suspending => "suspending",
        .fire_and_forget => "fire-and-forget",
    };
}

/// A map's keys in ascending order, so a save doesn't depend on hash order.
fn sortedKeys(comptime V: type, gpa: Allocator, map: std.AutoHashMapUnmanaged(u64, V)) ![]u64 {
    const keys = try gpa.alloc(u64, map.count());
    var it = map.keyIterator();
    var n: usize = 0;
    while (it.next()) |k| : (n += 1) keys[n] = k.*;
    std.mem.sort(u64, keys, {}, std.sort.asc(u64));
    return keys;
}

// ---------------------------------------------------------------- restoring

/// The Host's `Grants` function: a Script's named Grant re-bound, or null.
pub const Rebind = struct {
    context: ?*anyopaque = null,
    call: *const fn (context: ?*anyopaque, script: []const u8, name: []const u8) ?*capabilities.Grant,
};

/// The Host's `Resolve` function: false for an id it can't resolve.
pub const Resolve = struct {
    context: ?*anyopaque = null,
    call: *const fn (context: ?*anyopaque, kind: []const u8, id: []const u8, native: *?*anyopaque) bool,
};

/// The Object Kinds the Core has defined, by name.
pub const Kinds = struct {
    context: ?*anyopaque = null,
    call: *const fn (context: ?*anyopaque, name: []const u8) ?*const objects.Kind,
};

pub const Options = struct {
    /// The compiled Libraries the Host passes, matched by identity.
    libraries: []const *Library = &.{},
    grants: ?Rebind = null,
    resolve: ?Resolve = null,
    kinds: ?Kinds = null,
    /// The `VariablesOnly` mismatch policy, rather than `RejectMismatch`.
    variables_only: bool = false,
    /// The `ReloadChanged` mismatch policy: a Partial Restore when only
    /// Script code changed, and a variables-only restore otherwise.
    reload_changed: bool = false,
};

pub const Outcome = enum { full, partial, variables_only, mismatch };

/// What a restore reports beside its Group: the Host Objects that didn't
/// resolve, which `gpa` owns; the pending calls are the Group's
/// `restored.pending`.
pub const Result = struct {
    disposed: []*objects.Object = &.{},
    /// For a Partial Restore, the Scripts it rebuilt, in load order.
    reloaded: []const []const u8 = &.{},
    /// For a variables-only or Partial Restore, what it discarded, by id.
    discarded: []const []const u8 = &.{},
    dropped: []const []const u8 = &.{},
    abandoned: []const []const u8 = &.{},

    pub fn deinit(x: *Result, gpa: Allocator) void {
        gpa.free(x.disposed);
        gpa.free(x.reloaded);
        gpa.free(x.discarded);
        gpa.free(x.dropped);
        gpa.free(x.abandoned);
    }
};

/// A saved Grant declaration, shared by the Grants that refer to it.
const SavedDeclaration = struct {
    json: []const u8,
    capability: []const u8,
    ops: []SavedOperation,
};

/// A saved Grant, kept until its Script is built.
const SavedGrant = struct {
    name: []const u8,
    json: []const u8,
    capability: []const u8,
    ops: []SavedOperation,
    revoked: bool,
    disabled: bool,
};

const SavedOperation = struct { name: []const u8, mode: capabilities.Mode, required: usize, total: usize, command: bool, labels: []const []const u8 };

const Restoring = struct {
    i: In,
    g: *Group,
    options: Options,
    tables: Tables,
    /// Each saved Library, matched to one the Host passed, or null.
    libraries: []?*Library,
    runs: std.ArrayList(*Run) = .empty,
    calls: []*capabilities.Call = &.{},
    /// The `scripts` section's Grant declarations.
    declarations: []const SavedDeclaration = &.{},
    /// The `runs` section's segment bases, each read once.
    bases: [][]*Value = &.{},
    iterators: std.ArrayList(*machine.Iterator) = .empty,
    readers: std.ArrayList(*binary.Reader) = .empty,
    replacements: std.ArrayList(*machine.Replacement) = .empty,
    /// The Grants the Host didn't re-bind, as `<script>.<name>`.
    unbound: std.ArrayList([]const u8) = .empty,
    mismatch: bool = false,
    /// A mismatch other than in Script code, such as a version or a Grant,
    /// which no Partial Restore can take.
    fixed: bool = false,
    /// A variables-only restore reads Runs only to discard them, against
    /// code that may no longer match: no code position is trusted or used.
    skim: bool = false,
    /// Each unit's stack shapes, made once.
    shapes: std.AutoHashMapUnmanaged(*const lower.Unit, verify.Shapes) = .empty,
    shape_arena: ?std.heap.ArenaAllocator = null,

    fn gpa(r: *Restoring) Allocator {
        return r.g.gpa;
    }

    fn grantMismatch(r: *Restoring) void {
        r.mismatch = true;
        r.fixed = true;
    }

    fn keep(r: *Restoring) Allocator {
        return r.g.keep.allocator();
    }

    fn deinit(r: *Restoring) void {
        const a = r.gpa();
        r.runs.deinit(a);
        r.iterators.deinit(a);
        r.readers.deinit(a);
        r.replacements.deinit(a);
        r.unbound.deinit(a);
        a.free(r.libraries);
        r.shapes.deinit(a);
        if (r.shape_arena) |*x| x.deinit();
    }

    /// Text a part of the Group borrows.
    fn kept(r: *Restoring) Error![]const u8 {
        return r.keep().dupe(u8, try r.i.str());
    }

    fn owned(r: *Restoring) Error![]const u8 {
        return r.gpa().dupe(u8, try r.i.str());
    }

    fn keptName(r: *Restoring) Error![]const u8 {
        return r.keep().dupe(u8, try r.i.name());
    }

    fn ownedName(r: *Restoring) Error![]const u8 {
        return r.gpa().dupe(u8, try r.i.name());
    }

    fn value(r: *Restoring) Error!*Value {
        return readValue(&r.i, r.gpa(), r.tables);
    }

    fn optValue(r: *Restoring) Error!?*Value {
        return readOptValue(&r.i, r.gpa(), r.tables);
    }

    fn values(r: *Restoring) Error![]*Value {
        return readValues(&r.i, r.gpa(), r.tables);
    }

    fn object(r: *Restoring) Error!?*objects.Object {
        const i = try r.i.ref(r.g.objects.items.len) orelse return null;
        return r.g.objects.items[i];
    }

    fn call(r: *Restoring) Error!?*capabilities.Call {
        const i = try r.i.ref(r.calls.len) orelse return null;
        return r.calls[i];
    }

    /// A unit relative to `s`: null for its own.
    fn unit(r: *Restoring, s: *const Script) Error!?*Library {
        const tag = std.enums.fromInt(UnitTag, try r.i.byte()) orelse return error.InvalidSave;
        if (r.skim) {
            switch (tag) {
                .own => {},
                .extension, .library => _ = try r.i.int(),
                .stdlib => _ = try r.i.name(),
            }
            return null;
        }
        return switch (tag) {
            .own => null,
            .extension => s.extensions.items[try r.i.index(s.extensions.items.len)],
            .library => r.libraries[try r.i.index(r.libraries.len)] orelse error.InvalidSave,
            .stdlib => machine.stdlibLibrary(try r.i.name()) orelse error.InvalidSave,
        };
    }

    /// A Script's limits, which the Host set, and may set high.
    fn limits(r: *Restoring) Error!machine.Limits {
        var l: machine.Limits = .{};
        if (try r.i.int() != @typeInfo(machine.Limits).@"struct".field_names.len) return error.InvalidSave;
        inline for (@typeInfo(machine.Limits).@"struct".field_names) |f| {
            @field(l, f) = try r.i.wide();
            if (@field(l, f) > 1 << 62) return error.InvalidSave;
        }
        return l;
    }

    fn override(r: *Restoring) Error!?machine.Override {
        if (!try r.i.flag()) return null;
        var o: machine.Override = .{};
        inline for (.{ "fuel_per_run", "alloc_per_run", "max_wait_ms", "max_join" }) |f| {
            if (try r.i.flag()) @field(o, f) = try r.i.int();
        }
        return o;
    }

    /// A Delivery the caller owns.
    fn delivery(r: *Restoring) Error!machine.Delivery {
        const a = r.gpa();
        const id = try r.i.int();
        const root = try r.i.int();
        var d: machine.Delivery = .{ .id = id, .root = root, .message = try r.ownedName(), .args = &.{}, .request = false };
        errdefer r.g.releaseDelivery(d);
        d.args = try r.values();
        d.request = try r.i.flag();
        d.during = try r.optValue();
        if (try r.i.optName()) |x| d.from = try a.dupe(u8, x);
        d.internal_error = try r.i.flag();
        d.waits = try r.i.flag();
        d.target = try r.object();
        d.at = try r.object();
        d.function = try r.optValue();
        if (d.function) |f| if (f.data != .function) return error.InvalidSave;
        d.decision = try r.i.flag();
        d.decides = try r.i.flag();
        d.broadcast = try r.i.int();
        d.limits = try r.override();
        d.passed_by = try r.object();
        // Saved Deliveries are still open. Completion is process-local
        // ownership state and does not change the save format.
        d.completion = try machine.Delivery.Completion.create(a);
        return d;
    }

    fn failure(r: *Restoring) Error!machine.Failure {
        const a = r.gpa();
        const code = try r.ownedName();
        errdefer a.free(code);
        const message = if (try r.i.optName()) |m| try a.dupe(u8, m) else null;
        errdefer if (message) |m| a.free(m);
        return .{ .code = code, .message = message, .data = try r.optValue() };
    }

    /// A Resume the caller owns.
    fn resumeWith(r: *Restoring) Error!?machine.Resume {
        const tag = try r.i.byte();
        if (tag == 0) return null;
        const Tag2 = std.meta.Tag(machine.Resume);
        const t = std.enums.fromInt(Tag2, tag - 1) orelse return error.InvalidSave;
        return switch (t) {
            .answer => blk: {
                const v = try r.value();
                break :blk .{ .answer = .{ .value = v, .fuel = r.i.int() catch |e| {
                    v.release();
                    return e;
                } } };
            },
            .failed => .{ .failed = try r.failure() },
            .reply => .{ .reply = try r.value() },
            .event => blk: {
                const m = try r.optValue();
                errdefer if (m) |v| v.release();
                break :blk .{ .event = .{ .message = m, .branch = try r.i.small(u32), .binds = try r.i.small(u32) } };
            },
            .send_failed => blk: {
                const reason = try r.kept();
                break :blk .{ .send_failed = .{ .reason = reason, .err = try r.optValue() } };
            },
            .join_failed => .{ .join_failed = try r.i.small(usize) },
            .broken => blk: {
                // A Host-only detail another Core kept, which this one drops.
                _ = try r.i.optStr();
                break :blk .broken;
            },
            inline .timeout, .woke, .joined, .unparked, .cancelled, .lost, .limited, .revoked => |x| x,
        };
    }

    /// The Operation a Script's Grant names, for a wait's declaration.
    fn decl(r: *Restoring, s: *const Script, grant: []const u8, operation: []const u8) Error!?*const capabilities.Operation {
        if (r.skim) return null;
        const sg = s.grant(grant) orelse return error.InvalidSave;
        const i = sg.grant.capability.find(operation) orelse return error.InvalidSave;
        return &sg.grant.capability.operations[i];
    }

    fn waited(r: *Restoring, s: *const Script) Error!machine.Waited {
        var w: machine.Waited = .{ .id = try r.keptName() };
        w.block = try r.i.flag();
        w.call = try r.call();
        w.grant = try r.keptName();
        w.operation = try r.keptName();
        if (try r.i.flag()) w.decl = try r.decl(s, w.grant, w.operation);
        w.after_us = try duration(&r.i);
        return w;
    }

    /// A wait, owned by the caller, for `run`.
    fn pending(r: *Restoring, run: *Run) Error!?*Pending {
        if (!try r.i.flag()) return null;
        const a = r.gpa();
        const p = try a.create(Pending);
        p.* = .{ .run = run, .deadline = 0, .order = 0 };
        errdefer r.g.destroyPending(p);
        p.id = try r.keptName();
        p.deadline = if (try r.i.flag()) try deadline(&r.i) else machine.wait_table.never;
        p.order = try r.i.int();
        p.call = try r.call();
        if (p.call) |c| c.setDelivery(machine.Group.hostDelivery(run.delivery));
        p.grant = try r.keptName();
        p.operation = try r.keptName();
        if (try r.i.flag()) p.decl = try r.decl(run.script, p.grant, p.operation);
        p.after_us = try duration(&r.i);
        p.member = try r.i.ref(std.math.maxInt(u32));
        p.block = try r.i.flag();
        p.branch = try r.i.small(u32);
        if (try r.i.flag()) {
            const library = try r.unit(run.script);
            const entry = try r.i.small(u32);
            const any = try r.i.flag();
            const n = try r.i.count();
            if (!r.skim) {
                const events = run.script.unitIn(library).events;
                if (entry >= events.len or n != events[entry].branches.len) return error.InvalidSave;
            }
            const branches = try a.alloc(machine.EventBranch, n);
            var made: usize = 0;
            errdefer {
                machine.wait_table.releaseHeld(r.g.gpa, branches[0..made]);
                a.free(branches);
            }
            for (branches) |*b| {
                b.* = switch (try r.i.byte()) {
                    0 => blk: {
                        const from = try r.optValue();
                        errdefer if (from) |v| v.release();
                        break :blk .{ .when = .{ .from = from, .captures = try r.values() } };
                    },
                    1 => .{ .after = try deadline(&r.i) },
                    else => return error.InvalidSave,
                };
                made += 1;
            }
            const e = try a.create(machine.EventWait);
            e.* = .{ .library = library, .entry = entry, .branches = branches, .any = any };
            p.event = e;
        }
        return p;
    }

    /// Operand stack slots, owned by the caller.
    fn slots(r: *Restoring, out: *std.ArrayList(Slot)) Error!void {
        const a = r.gpa();
        const n = try r.i.count();
        try out.ensureTotalCapacity(a, n);
        for (0..n) |_| {
            const slot: Slot = switch (try r.i.byte()) {
                0 => .{ .value = try r.value() },
                1 => if (try r.i.ref(r.iterators.items.len)) |i| blk: {
                    r.iterators.items[i].references += 1;
                    break :blk .{ .iterator = r.iterators.items[i] };
                } else blk: {
                    const subject = try r.optValue();
                    errdefer if (subject) |v| v.release();
                    const it = try a.create(machine.Iterator);
                    it.* = .{ .subject = subject };
                    errdefer a.destroy(it);
                    it.position = try r.i.small(usize);
                    it.left = try r.i.int();
                    // What `iterate` makes: a list, or a range of whole
                    // numbers, and a place within it.
                    if (subject) |v| switch (v.data) {
                        .list => |items| if (it.position > items.len) return error.InvalidSave,
                        .range => |range| {
                            if (range.from.data != .number or range.to.data != .number) return error.InvalidSave;
                            const from = range.from.data.number.integer(i64) catch return error.InvalidSave;
                            const to = range.to.data.number.integer(i64) catch return error.InvalidSave;
                            const span: u64 = if (to >= from) @intCast(@as(i128, to) - from + 1) else 0;
                            if (it.position > span) return error.InvalidSave;
                        },
                        else => return error.InvalidSave,
                    };
                    try r.iterators.append(a, it);
                    break :blk .{ .iterator = it };
                },
                2 => if (try r.i.ref(r.readers.items.len)) |i| blk: {
                    r.readers.items[i].references += 1;
                    break :blk .{ .reader = r.readers.items[i] };
                } else blk: {
                    const subject = try r.value();
                    errdefer subject.release();
                    if (subject.data != .bytes) return error.InvalidSave;
                    const position = try r.i.small(usize);
                    if (position > subject.data.bytes.len) return error.InvalidSave;
                    const x = try a.create(binary.Reader);
                    x.* = .{ .subject = subject, .position = position };
                    errdefer a.destroy(x);
                    try r.readers.append(a, x);
                    break :blk .{ .reader = x };
                },
                3 => if (try r.i.ref(r.replacements.items.len)) |i| blk: {
                    r.replacements.items[i].references += 1;
                    break :blk .{ .replacement = r.replacements.items[i] };
                } else blk: {
                    const text = try r.value();
                    errdefer text.release();
                    const matches = try r.value();
                    errdefer matches.release();
                    if (text.data != .text or matches.data != .list) return error.InvalidSave;
                    const spans = try a.alloc([2]usize, try r.i.count());
                    errdefer a.free(spans);
                    for (spans) |*sp| {
                        sp.* = .{ try r.i.small(usize), try r.i.small(usize) };
                        if (sp[0] > sp[1] or sp[1] > text.data.text.len) return error.InvalidSave;
                    }
                    if (spans.len != matches.data.list.len) return error.InvalidSave;
                    const next = try r.i.small(usize);
                    const position = try r.i.small(usize);
                    if (next > spans.len or position > text.data.text.len) return error.InvalidSave;
                    const x = try a.create(machine.Replacement);
                    x.* = .{ .text = text, .matches = matches, .spans = spans, .next = next, .position = position };
                    errdefer a.destroy(x);
                    try x.pieces.appendSlice(a, try r.i.str());
                    errdefer x.pieces.deinit(a);
                    try r.replacements.append(a, x);
                    break :blk .{ .replacement = x };
                },
                4 => blk: {
                    const d: machine.Deadline = .{ .at = try deadline(&r.i), .us = try duration(&r.i) };
                    const box = try a.create(machine.DeadlineBox);
                    box.* = .{ .deadline = d };
                    break :blk .{ .deadline = box };
                },
                else => return error.InvalidSave,
            };
            out.appendAssumeCapacity(slot);
        }
    }

    /// Frames, each checked against its unit's code, appended to `out`,
    /// which owns them as they are made.
    fn frames(r: *Restoring, run: *Run, out: *std.ArrayList(Frame)) Error!void {
        const a = r.gpa();
        const n = try r.i.count();
        try out.ensureTotalCapacity(a, out.items.len + n);
        for (0..n) |_| {
            const library = try r.unit(run.script);
            const body = try r.i.small(u32);
            const pc = try r.i.small(u32);
            const locals = try r.values();
            var f: Frame = .{ .library = library, .body = body, .pc = pc, .locals = locals };
            out.appendAssumeCapacity(f);
            const placed = &out.items[out.items.len - 1];
            if (!r.skim) {
                const unit_code = run.script.unitIn(library);
                if (body >= unit_code.bodies.len) return error.InvalidSave;
                const b = unit_code.bodies[body];
                if (pc < b.first or pc > b.last or locals.len != b.locals) return error.InvalidSave;
            }
            try r.slots(&placed.stack);
            placed.called = try r.i.flag();
            placed.restricted = try r.i.flag();
            f = placed.*;
        }
    }

    fn limit(r: *Restoring) Error!?machine.Limit {
        if (!try r.i.flag()) return null;
        return .{ .frame = try r.i.small(usize), .entry = try r.i.small(usize) };
    }

    fn search(r: *Restoring) Error!machine.Search {
        return .{ .frame = try r.i.small(usize), .entry = try r.i.small(usize), .raised = try r.i.small(u32), .limit = try r.limit(), .position = try r.i.small(usize), .skip = try r.limit() };
    }

    /// One error control, appended to the Run's, which owns it as it is
    /// made.
    fn control(r: *Restoring, run: *Run) Error!void {
        const a = r.gpa();
        switch (try r.i.byte()) {
            0 => {
                const err = try r.value();
                try run.controls.append(a, .{ .dispatch = .{ .err = err, .owner = 0, .place = 0, .held = &.{}, .owner_stack = .empty, .owner_pc = 0, .search = undefined } });
                const d = &run.controls.items[run.controls.items.len - 1].dispatch;
                d.search = .{ .frame = 0, .entry = 0, .raised = 0, .limit = null, .position = 0 };
                d.owner = try r.i.small(usize);
                d.place = try r.i.small(u32);
                var held: std.ArrayList(Frame) = .empty;
                defer {
                    d.held = held.toOwnedSlice(a) catch blk: {
                        for (held.items) |*f| releaseFrame(r.g, f);
                        held.deinit(a);
                        break :blk &.{};
                    };
                }
                try r.frames(run, &held);
                try r.slots(&d.owner_stack);
                d.owner_pc = try r.i.small(u32);
                d.search = try r.search();
                if (d.owner >= run.frames.items.len + 1024) return error.InvalidSave;
            },
            1 => {
                const err = try r.value();
                try run.controls.append(a, .{ .cleanup = .{ .err = err, .cleanups = .empty, .then = .end } });
                const u = &run.controls.items[run.controls.items.len - 1].cleanup;
                const n = try r.i.count();
                try u.cleanups.ensureTotalCapacity(a, n);
                for (0..n) |_| u.cleanups.appendAssumeCapacity(.{ .frame = try r.i.small(usize), .target = try r.i.small(u32), .depth = try r.i.small(u32), .entry = try r.i.small(usize), .leave = try r.i.flag() });
                u.next = try r.i.small(usize);
                if (u.next > n) return error.InvalidSave;
                u.left = try r.i.flag();
                u.failed = try r.i.int();
                if (try r.i.flag()) u.failed_frame = try r.i.small(usize);
                try r.frames(run, &u.held);
                switch (try r.i.byte()) {
                    0 => {
                        u.then = .{ .accept = .{ .frame = try r.i.small(usize), .pc = try r.i.small(u32), .stack = .empty } };
                        try r.slots(&u.then.accept.stack);
                    },
                    1 => u.then = .end,
                    2 => u.then = .cancel,
                    3 => {
                        u.then = .{ .transfer = .{ .frame = try r.i.small(usize), .offer_entry = try r.i.small(usize), .record = try r.i.small(u32), .offer = try r.i.small(u32), .args = &.{}, .attempt = 0, .limit = null } };
                        u.then.transfer.args = try r.values();
                        u.then.transfer.attempt = try r.i.int();
                        u.then.transfer.limit = try r.limit();
                    },
                    4 => u.then = .{ .search = try r.search() },
                    else => return error.InvalidSave,
                }
            },
            else => return error.InvalidSave,
        }
    }

    /// One Run of `s`, appended to the Script's live Runs, which own it as
    /// it is made.
    fn oneRun(r: *Restoring, s: *Script) Error!void {
        const a = r.gpa();
        const id = try r.ownedName();
        // Its number must name it as the Script's.
        if (!std.mem.startsWith(u8, id, s.name) or id.len < s.name.len + 3 or !std.mem.eql(u8, id[s.name.len .. s.name.len + 2], "/r")) {
            a.free(id);
            return error.InvalidSave;
        }
        const x = a.create(Run) catch |e| {
            a.free(id);
            return e;
        };
        x.* = .{ .id = id, .script = s, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
        x.delivery.message = a.dupe(u8, "") catch |e| {
            a.free(id);
            a.destroy(x);
            return e;
        };
        s.live.append(a, x) catch |e| {
            r.g.endRun(x, .dropped) catch unreachable;
            return e;
        };
        try r.runs.append(a, x);
        x.order = try r.i.int();
        if (try r.i.flag()) x.reported_fuel = try r.i.int();
        x.fuel = try r.i.int();
        x.alloc = try r.i.int();
        const d = try r.delivery();
        r.g.releaseDelivery(x.delivery);
        x.delivery = d;
        const handler = try r.i.name();
        x.handler = if (std.mem.eql(u8, handler, d.message)) d.message else try r.keep().dupe(u8, handler);
        x.clause = try r.i.small(u32);
        x.limits = try r.limits();
        x.clause_fuel = try r.i.int();
        if (try r.i.flag()) {
            const library = try r.unit(s);
            const body = try r.i.small(u32);
            if (!r.skim and body >= s.unitIn(library).bodies.len) return error.InvalidSave;
            x.preempted_in = .{ .library = library, .body = body, .fallback = try r.i.flag() };
        }
        const preempted = try r.i.flag();
        x.clauses_seen = try r.i.small(u32);
        if (try r.i.flag()) x.cleanup_from = try r.i.int();
        x.cleanup_limited = try r.i.flag();
        const controls = try r.i.count();
        for (0..controls) |_| try r.control(x);
        x.attempts = try r.i.int();
        x.calls = try r.i.small(u32);
        x.segment_fuel = try r.i.int();
        x.segment_alloc = try r.i.int();
        x.started = try r.i.flag();
        try r.g.waits.importWait(x, null, try r.pending(x));
        x.resume_with = try r.resumeWith();
        x.suspended_at = try r.keptName();
        x.waited = try r.waited(s);
        if (try r.i.flag()) x.raised_at = .{ .line = try r.i.small(u32), .column = try r.i.small(u32) };
        if (try r.i.flag()) {
            const j = try a.create(machine.Join);
            j.* = .{ .frame = try r.i.small(usize), .start = try r.i.small(u32) };
            x.join = j;
            const n = try r.i.count();
            for (0..n) |m| {
                try j.members.append(a, .{ .pending = null, .waited = .{} });
                const member = &j.members.items[m];
                member.frame = try r.i.small(usize);
                member.start = try r.i.small(u32);
                try r.g.waits.importWait(x, m, try r.pending(x));
                member.waited = try r.waited(s);
                member.with = try r.resumeWith();
                member.cut = try r.i.flag();
            }
        }
        if (x.resume_with) |w| if (w == .join_failed) {
            const j = x.join orelse return error.InvalidSave;
            if (w.join_failed >= j.members.items.len) return error.InvalidSave;
        };
        if (try r.i.flag()) {
            const library = try r.unit(s);
            const body = try r.i.small(u32);
            if (!r.skim and body >= s.unitIn(library).bodies.len) return error.InvalidSave;
            x.clause_body = body;
            x.clause_unit = library;
        }
        x.fallback = try r.i.flag();
        if (try r.i.flag()) x.select_at = try r.i.small(u32);
        try machine.run_lifecycle.restore(x, preempted, try r.i.flag());
        const abandoned = try r.i.count();
        for (0..abandoned) |_| try x.abandoned.append(a, try r.keptName());
        x.base = try r.i.small(usize);
        x.segments = try r.i.small(u32);
        x.verdict = try r.i.flag();
        if (try r.i.ref(r.bases.len)) |at| {
            const base = try a.dupe(*Value, r.bases[at]);
            for (base) |v| _ = v.retain();
            x.segment_base = base;
            if (!r.skim and base.len > s.variables.len) return error.InvalidSave;
        }
        try r.frames(x, &x.frames);
        // Each dispatch's held frames return to the Run's, which keeps
        // room for them.
        var room = x.frames.items.len;
        for (x.controls.items) |c| if (c == .dispatch) {
            room = @max(room, c.dispatch.owner + 1 + c.dispatch.held.len);
        };
        try x.frames.ensureTotalCapacity(a, room);
        // A nonzero base is only an event test's, inside a Pump.
        if (x.base != 0) return error.InvalidSave;
        if (x.waiting != null and x.frames.items.len == 0) return error.InvalidSave;
        if (!r.skim) try r.checkRun(x);
    }

    fn shapesOf(r: *Restoring, code: *const lower.Unit) Error!verify.Shapes {
        if (r.shapes.get(code)) |x| return x;
        if (r.shape_arena == null) r.shape_arena = .init(r.gpa());
        const x = try verify.shapes(r.shape_arena.?.allocator(), code);
        try r.shapes.put(r.gpa(), code, x);
        return x;
    }

    /// The shape a frame's stack must have at `pc`, less its last `less`
    /// slots, which an instruction already made will push.
    fn expected(r: *Restoring, code: *const lower.Unit, pc: u32, less: usize) Error![]const verify.Kind {
        const shapes = try r.shapesOf(code);
        if (shapes.conflicts > 0) return error.InvalidSave;
        const shape = shapes.at[pc] orelse return error.InvalidSave;
        return r.cut(shape, less);
    }

    /// Under error control a frame may stop just after an instruction that
    /// never goes on, such as a `throw`: its stack is what that instruction
    /// left once it popped.
    fn expectedRaised(r: *Restoring, code: *const lower.Unit, pc: u32) Error![]const verify.Kind {
        const shapes = try r.shapesOf(code);
        if (shapes.conflicts > 0) return error.InvalidSave;
        if (shapes.at[pc]) |shape| return shape;
        if (pc == 0) return error.InvalidSave;
        const before = shapes.at[pc - 1] orelse return error.InvalidSave;
        const pops = verify.popCount(code, code.code[pc - 1]) orelse return error.InvalidSave;
        if (pops > before.len) return error.InvalidSave;
        return before[0 .. before.len - pops];
    }

    fn cut(r: *Restoring, shape: []const verify.Kind, less: usize) Error![]const verify.Kind {
        _ = r;
        if (less > shape.len) return error.InvalidSave;
        for (shape[shape.len - less ..]) |k| if (k != .value) return error.InvalidSave;
        return shape[0 .. shape.len - less];
    }

    fn kinds(stack: []const Slot, want: []const verify.Kind, prefix: bool) bool {
        if (stack.len > want.len or (!prefix and stack.len != want.len)) return false;
        for (stack, want[0..stack.len]) |slot, k| if (@as(verify.Kind, switch (slot) {
            .value => .value,
            .iterator => .iterator,
            .reader => .reader,
            .replacement => .replacement,
            .deadline => .deadline,
        }) != k) return false;
        return true;
    }

    /// A search's bounds: frames at or below `top`, and entries within
    /// their units' Unwind Tables.
    fn checkSearch(r: *Restoring, run: *const Run, x: machine.Search, top: usize) Error!void {
        _ = r;
        const fs = run.frames.items;
        if (x.frame >= fs.len or x.entry > run.script.unitIn(fs[x.frame].library).unwind.len) return error.InvalidSave;
        if (x.limit) |b| {
            if (b.frame > top or b.frame >= fs.len) return error.InvalidSave;
            if (b.entry > run.script.unitIn(fs[b.frame].library).unwind.len) return error.InvalidSave;
        }
        // A failed recovery policy can leave a skip marker in a frame
        // retained above the next catch's owner.
        if (x.skip) |b| {
            const frame = heldFrame(run, b.frame) orelse return error.InvalidSave;
            if (b.entry > run.script.unitIn(frame.library).unwind.len) return error.InvalidSave;
        }
    }

    /// Control validation (chapter 10, Restoring): each frame's stack is
    /// the one its code expects there. A frame below the top waits for a
    /// call's result; a suspended Run's top frame for its Suspension
    /// Point's. In a catch dispatch or cleanup, where frames are held aside
    /// and stacks cut back, each stack must still be a prefix of its code's,
    /// and every frame and entry it names in bounds.
    fn checkRun(r: *Restoring, run: *Run) Error!void {
        const fs = run.frames.items;
        if (run.join) |j| for (j.members.items) |m| {
            if (m.frame >= fs.len or m.frame != j.frame) return error.InvalidSave;
            const f = &fs[m.frame];
            const code = run.script.unitIn(f.library);
            if (m.start >= code.code.len) return error.InvalidSave;
            if (j.start >= code.code.len or code.code[j.start].op != .join_start) return error.InvalidSave;
            var end = j.start;
            while (end < code.code.len and code.code[end].op != .join_end) : (end += 1) {}
            if (m.start <= j.start or m.start >= end) return error.InvalidSave;
            const ins = code.code[m.start];
            const offset: usize = switch (ins.op) {
                .join_ask => 3,
                .join_send => 2,
                .join_send_named => 1,
                .join_send_spread => 0,
                else => return error.InvalidSave,
            };
            const body = code.bodies[f.body];
            if (m.start < body.first or m.start >= body.last) return error.InvalidSave;
            if (ins.operands.len != offset) {
                if (ins.operands.len != offset + 2) return error.InvalidSave;
                const kind = ins.operands[offset].text;
                if (!std.mem.eql(u8, kind, "local") and !std.mem.eql(u8, kind, "variable")) return error.InvalidSave;
                if (ins.operands[offset + 1].int < 0) return error.InvalidSave;
                const t = machine.memberTarget(run, m).?;
                if (t.variable) {
                    if (t.index >= run.script.variables.len) return error.InvalidSave;
                } else if (t.index == 0 or t.index >= f.locals.len) return error.InvalidSave;
            }
        };
        const controlled = run.controls.items.len > 0;
        for (fs, 0..) |*f, n| {
            const code = run.script.unitIn(f.library);
            const top = n == fs.len - 1;
            var less: usize = 0;
            if (!top) {
                if (f.pc == 0) return error.InvalidSave;
                switch (code.code[f.pc - 1].op) {
                    .call, .call_import, .call_handler, .call_handler_wait, .call_value, .call_restricted, .call_value_wait => less = 1,
                    else => if (!controlled) return error.InvalidSave,
                }
            } else if (!machine.run_lifecycle.continuing(run) and f.pc > 0) {
                // Suspended at the instruction before, which pushes what it
                // waited for when the Run resumes.
                const ins = code.code[f.pc - 1];
                if (@import("../generated/machine.zig").machine.instruction[@backingInt(ins.op)].suspends) less = verify.pushCount(code, ins) orelse return error.InvalidSave;
            }
            const want = if (controlled) try r.expectedRaised(code, f.pc) else try r.expected(code, f.pc, less);
            if (!kinds(f.stack.items, want, controlled)) return error.InvalidSave;
        }
        for (run.controls.items) |c| switch (c) {
            .dispatch => |d| {
                if (d.owner >= fs.len) return error.InvalidSave;
                // Its search goes on after the catch that owns it.
                const owner_code = run.script.unitIn(fs[d.owner].library);
                if (d.search.frame != d.owner or d.search.entry == 0 or d.search.entry > owner_code.unwind.len) return error.InvalidSave;
                if (owner_code.unwind[d.search.entry - 1].kind != .@"catch") return error.InvalidSave;
                // `raised` belongs to the original failing frame, which may
                // be retained Library code rather than the catching Script.
                const failed_code = if (d.held.len > 0) run.script.unitIn(d.held[d.held.len - 1].library) else owner_code;
                if (d.place >= owner_code.code.len or d.search.raised >= failed_code.code.len) return error.InvalidSave;
                if (d.search.position > d.owner + 1 + d.held.len) return error.InvalidSave;
                try r.checkSearch(run, d.search, d.owner);
                for (d.held) |*f| {
                    const code = run.script.unitIn(f.library);
                    if (!kinds(f.stack.items, try r.expectedRaised(code, f.pc), true)) return error.InvalidSave;
                }
                const owner = fs[d.owner];
                const code = run.script.unitIn(owner.library);
                if (d.owner_pc >= code.code.len) return error.InvalidSave;
                if (!kinds(d.owner_stack.items, try r.expectedRaised(code, d.owner_pc), true)) return error.InvalidSave;
            },
            .cleanup => |u| {
                for (u.held.items) |*f| {
                    const code = run.script.unitIn(f.library);
                    if (!kinds(f.stack.items, try r.expectedRaised(code, f.pc), true)) return error.InvalidSave;
                }
                for (u.cleanups.items) |x| {
                    if (x.frame >= fs.len) return error.InvalidSave;
                    const code = run.script.unitIn(fs[x.frame].library);
                    if (x.target >= code.code.len or x.entry >= code.unwind.len) return error.InvalidSave;
                }
                switch (u.then) {
                    .accept => |acc| {
                        if (acc.frame >= fs.len) return error.InvalidSave;
                        const code = run.script.unitIn(fs[acc.frame].library);
                        if (acc.pc >= code.code.len) return error.InvalidSave;
                        if (!kinds(acc.stack.items, try r.expectedRaised(code, acc.pc), true)) return error.InvalidSave;
                    },
                    .transfer => |t| {
                        // The offering frame may be held aside by the
                        // dispatch whose policy chose it.
                        const offering = heldFrame(run, t.frame) orelse return error.InvalidSave;
                        const code = run.script.unitIn(offering.library);
                        if (t.offer_entry >= code.unwind.len or t.record >= code.offers.len or t.offer >= code.offers[t.record].offers.len) return error.InvalidSave;
                    },
                    .search => |x| {
                        if (x.frame >= fs.len) return error.InvalidSave;
                        try r.checkSearch(run, x, x.frame);
                    },
                    .end, .cancel => {},
                }
            },
        };
    }

    /// The Run's frame at `index`, counting the frames each dispatch holds
    /// aside above its owner.
    fn heldFrame(run: *const Run, index: usize) ?*const Frame {
        if (index < run.frames.items.len) return &run.frames.items[index];
        for (run.controls.items) |*c| if (c.* == .dispatch) {
            const d = &c.dispatch;
            if (index > d.owner and index - d.owner - 1 < d.held.len) return &d.held[index - d.owner - 1];
        };
        return null;
    }

    /// A queued Host Input the caller owns.
    fn input(r: *Restoring) Error!machine.Input {
        const a = r.gpa();
        const Tag3 = std.meta.Tag(machine.Input);
        const tag = try r.i.byte();
        if (tag == 255) return error.InvalidSave;
        const t = std.enums.fromInt(Tag3, tag + 1) orelse return error.InvalidSave;
        return switch (t) {
            .charge_request => error.InvalidSave,
            .deliver => blk: {
                const script = try r.ownedName();
                errdefer a.free(script);
                break :blk .{ .deliver = .{ .script = script, .delivery = try r.delivery() } };
            },
            .set_parent => .{ .set_parent = .{ .object = try r.object() orelse return error.InvalidSave, .parent = try r.object() } },
            .dispose => .{ .dispose = try r.object() orelse return error.InvalidSave },
            .settle => blk: {
                const id = try r.ownedName();
                errdefer a.free(id);
                break :blk .{ .settle = .{ .id = id, .with = try r.resumeWith() orelse return error.InvalidSave } };
            },
            .broadcast => blk: {
                const id = try r.i.int();
                const message = try r.ownedName();
                errdefer a.free(message);
                const args = try r.values();
                errdefer machine.releaseValues(args, a);
                break :blk .{ .broadcast = .{ .id = id, .message = message, .args = args, .decision = try r.i.flag(), .limits = try r.override() } };
            },
            .revoke => blk: {
                const script = try r.ownedName();
                errdefer a.free(script);
                break :blk .{ .revoke = .{ .script = script, .grant = try r.ownedName() } };
            },
            .cancel_run => .{ .cancel_run = try r.ownedName() },
            .rewind_run => .{ .rewind_run = try r.ownedName() },
            .stop => blk: {
                const script = try r.ownedName();
                errdefer a.free(script);
                break :blk .{ .stop = .{ .script = script, .reason = try r.ownedName() } };
            },
            .cancel_delivery => .{ .cancel_delivery = try r.i.int() },
            .cancel_broadcast => .{ .cancel_broadcast = try r.i.int() },
            // A save taken before a restored Group's first Pump keeps its
            // queued settlements; restore checks their calls still pend.
            .settlement => blk: {
                const id = try r.ownedName();
                errdefer a.free(id);
                const how = std.enums.fromInt(machine.How, try r.i.byte()) orelse return error.InvalidSave;
                const with = try r.resumeWith();
                const valued = how == .answer or how == .fail;
                if (valued != (with != null)) {
                    if (with) |w| r.g.releaseResume(w);
                    return error.InvalidSave;
                }
                break :blk .{ .settlement = .{ .id = id, .how = how, .with = with } };
            },
        };
    }

    fn mark(r: *Restoring) Error!machine.Mark {
        const a = r.gpa();
        const script = try r.ownedName();
        errdefer a.free(script);
        const run_id = try r.ownedName();
        errdefer a.free(run_id);
        const reason = try r.optValue();
        errdefer if (reason) |v| v.release();
        return .{ .script = script, .run = run_id, .reason = reason, .outcome = outcomes[try r.i.enumByte(outcomes.len)] };
    }
};

fn releaseFrame(g: *Group, f: *Frame) void {
    for (f.locals) |v| v.release();
    g.gpa.free(f.locals);
    for (f.stack.items) |slot| slot.release(g.gpa);
    f.stack.deinit(g.gpa);
}

/// A placeholder for a Grant the restore couldn't re-bind: enough of its
/// saved Operations to check and lower code against, and a Host function
/// nothing reaches, since the Grant is revoked.
fn placeholder(g: *Group, saved: SavedGrant) !*capabilities.Grant {
    const a = g.keep.allocator();
    const ops = try a.alloc(capabilities.Operation, saved.ops.len);
    for (saved.ops, ops) |o, *op| {
        const args = try a.alloc(*capabilities.Shape, o.total);
        for (args, 0..) |*s, i| {
            const any = try capabilities.Shape.kind(a, .any);
            s.* = if (i < o.required) any else try capabilities.Shape.optional(a, any);
        }
        const result: ?*capabilities.Shape = if (o.mode == .fire_and_forget) null else try capabilities.Shape.kind(a, .any);
        const labels = try a.alloc([]const u8, o.labels.len);
        for (o.labels, labels) |l, *x| x.* = try a.dupe(u8, l);
        op.* = .{ .name = try a.dupe(u8, o.name), .args = args, .result = result, .mode = o.mode, .command = o.command, .labels = labels, .host = .{ .call = unbound } };
    }
    const capability = try a.create(capabilities.Capability);
    capability.* = .{ .name = try a.dupe(u8, saved.capability), .operations = ops };
    const grant = try a.create(capabilities.Grant);
    const all = try a.alloc(bool, ops.len);
    @memset(all, true);
    grant.* = .{ .capability = capability, .operations = all };
    return grant;
}

fn unbound(context: ?*anyopaque, c: *capabilities.Call, args: []const *Value) capabilities.Outcome {
    _ = context;
    _ = c;
    _ = args;
    return .broken;
}

/// A Script as saved, its Grants re-bound, until it is built: as first
/// compiled for a full restore, or rebuilt for a variables-only one. Its
/// text is the Group's `keep`; its values are released unless taken.
const Saved = struct {
    name: []const u8,
    /// Its code identity when saved, with its extensions'.
    identity: [32]u8,
    /// Its base unit's identity, and each extension's.
    base: [32]u8,
    extension_identities: []const [32]u8,
    /// Its sources, from the `sources` section.
    source: []const u8,
    extensions: []const []const u8,
    limits: machine.Limits,
    grants: []machine.ScriptGrant,
    effects: bool,
    owner: ?*objects.Object,
    objects: []machine.NamedObject,
    variable_names: []const []const u8,
    variables: []*Value,
    /// The base unit's definitions, then each extension's.
    definitions: []*Value,
    runs: u64,
    fuel_total: u64,
    alloc_total: u64,
    faults: u64,
    debt: u64,
    stopped: ?[]const u8,

    fn release(x: *Saved, gpa: Allocator) void {
        machine.releaseValues(x.variables, gpa);
        machine.releaseValues(x.definitions, gpa);
        x.variables = &.{};
        x.definitions = &.{};
    }
};

/// Reads one entry of the `scripts` section's Grant declarations.
fn readDeclaration(r: *Restoring) Error!SavedDeclaration {
    const k = r.keep();
    const i = &r.i;
    const json = try r.kept();
    const capability = try r.keptName();
    const ops = try k.alloc(SavedOperation, try i.count());
    for (ops) |*o| {
        o.name = try r.keptName();
        o.mode = std.enums.values(capabilities.Mode)[try i.enumByte(std.enums.values(capabilities.Mode).len)];
        o.required = try i.small(usize);
        o.total = try i.small(usize);
        o.command = try i.flag();
        const labels = try k.alloc([]const u8, try i.count());
        for (labels) |*l| l.* = try r.keptName();
        o.labels = labels;
    }
    return .{ .json = json, .capability = capability, .ops = ops };
}

/// Reads a Script's saved state, re-binding its Grants: each the Host
/// returns must match its saved declarations, and each it doesn't is kept
/// revoked with them.
fn readSaved(r: *Restoring, out: *Saved) Error!void {
    const a = r.gpa();
    const k = r.keep();
    const i = &r.i;
    out.* = .{ .name = "", .identity = undefined, .base = undefined, .extension_identities = &.{}, .source = "", .extensions = &.{}, .limits = .{}, .grants = &.{}, .effects = false, .owner = null, .objects = &.{}, .variable_names = &.{}, .variables = &.{}, .definitions = &.{}, .runs = 0, .fuel_total = 0, .alloc_total = 0, .faults = 0, .debt = 0, .stopped = null };
    errdefer out.release(a);
    out.name = try r.keptName();
    out.base = try i.digest();
    out.identity = out.base;
    const extensions = try k.alloc([32]u8, try i.count());
    for (extensions) |*x| {
        x.* = try i.digest();
        out.identity = machine.extendedIdentity(out.identity, x.*);
    }
    out.extension_identities = extensions;
    out.limits = try r.limits();
    const grants = try k.alloc(machine.ScriptGrant, try i.count());
    for (grants) |*sg| {
        const saved: SavedGrant = blk: {
            const name = try r.keptName();
            const d = r.declarations[try i.index(r.declarations.len)];
            break :blk .{ .name = name, .json = d.json, .capability = d.capability, .ops = d.ops, .revoked = try i.flag(), .disabled = try i.flag() };
        };
        const rebound: ?*capabilities.Grant = if (r.options.grants) |x| x.call(x.context, out.name, saved.name) else null;
        if (rebound) |grant| {
            // Only the saved Operations, whose declarations must match.
            const kept = try k.alloc(bool, grant.capability.operations.len);
            @memset(kept, false);
            for (saved.ops) |o| {
                const at = grant.capability.find(o.name) orelse {
                    r.grantMismatch();
                    continue;
                };
                if (!grant.operations[at]) r.grantMismatch();
                kept[at] = true;
            }
            if (!std.mem.eql(u8, grant.capability.name, saved.capability)) r.grantMismatch();
            const json = try fingerprint.grantJson(a, grant.capability, kept);
            defer a.free(json);
            if (!std.mem.eql(u8, json, saved.json)) r.grantMismatch();
            sg.* = .{ .name = saved.name, .grant = grant, .kept = kept, .revoked = saved.revoked, .disabled = saved.disabled };
        } else {
            try r.unbound.append(a, try std.fmt.allocPrint(k, "{s}.{s}", .{ out.name, saved.name }));
            const grant = try placeholder(r.g, saved);
            const kept = try k.alloc(bool, saved.ops.len);
            @memset(kept, true);
            sg.* = .{ .name = saved.name, .grant = grant, .kept = kept, .revoked = true, .disabled = saved.disabled, .declarations = saved.json };
        }
        if (sg.grant.coordinator != null) out.effects = true;
    }
    out.grants = grants;
    out.owner = try r.object();
    const named = try k.alloc(machine.NamedObject, try i.count());
    for (named) |*x| x.* = .{ .name = try r.keptName(), .object = try r.object() orelse return error.InvalidSave };
    out.objects = named;
    const names = try k.alloc([]const u8, try i.count());
    for (names) |*x| x.* = try r.keptName();
    out.variable_names = names;
    out.variables = try r.values();
    if (out.variables.len != names.len) return error.InvalidSave;
    out.definitions = try r.values();
    out.runs = try i.int();
    out.fuel_total = try i.int();
    out.alloc_total = try i.int();
    out.faults = try i.int();
    out.debt = try i.int();
    out.stopped = if (try i.optName()) |x| try k.dupe(u8, x) else null;
}

/// A new Script of the Group with a saved Script's name, Grants, objects,
/// limits and counters, and no code yet.
fn newScript(r: *Restoring, saved: *const Saved) Error!*Script {
    const a = r.gpa();
    for (r.g.scripts.items) |x| if (std.mem.eql(u8, x.name, saved.name)) return error.InvalidSave;
    const s = try a.create(Script);
    r.g.generations += 1;
    s.* = .{ .name = saved.name, .identity = undefined, .arena = .init(a), .code = .init(a), .unit = undefined, .variables = &.{}, .definitions = &.{}, .generation = r.g.generations, .limits = saved.limits, .grants = saved.grants, .effects = saved.effects, .owner = saved.owner, .objects = saved.objects, .runs = saved.runs, .fuel_total = saved.fuel_total, .alloc_total = saved.alloc_total, .faults = saved.faults };
    s.unit.values = &.{};
    r.g.scripts.append(a, s) catch |e| {
        r.g.destroyScript(s);
        return e;
    };
    s.source = s.code.allocator().dupe(u8, saved.source) catch |e| return e;
    return s;
}

/// Builds a saved Script as first compiled, without running an
/// initialiser: false when it no longer compiles, a mismatch.
fn buildSaved(r: *Restoring, saved: *const Saved) Error!bool {
    const s = try newScript(r, saved);
    return r.g.compileSaved(s, saved.extensions) catch |e| valueError(e);
}

/// Puts a fully restored Script's saved values in place.
fn fillSaved(r: *Restoring, s: *Script, saved: *Saved) Error!void {
    if (saved.variables.len != s.variableNames().len) return error.InvalidSave;
    for (saved.variable_names, s.variableNames()) |x, y| if (!std.mem.eql(u8, x, y)) return error.InvalidSave;
    var total = s.unit.definitions.len;
    for (s.extensions.items) |x| total += x.unit.definitions.len;
    if (saved.definitions.len != total) return error.InvalidSave;
    const a = r.gpa();
    // Each extension's definitions are its own slice, taken out of the
    // saved list before the base unit keeps the rest.
    const parts = try a.alloc([]*Value, s.extensions.items.len);
    var made: usize = 0;
    defer a.free(parts);
    errdefer for (parts[0..made]) |p| a.free(p);
    var at = s.unit.definitions.len;
    for (s.extensions.items, parts) |x, *p| {
        p.* = try a.dupe(*Value, saved.definitions[at..][0..x.unit.definitions.len]);
        made += 1;
        at += x.unit.definitions.len;
    }
    const base = try a.dupe(*Value, saved.definitions[0..s.unit.definitions.len]);
    machine.releaseValues(s.variables, a);
    machine.releaseValues(s.definitions, a);
    s.variables = saved.variables;
    s.definitions = base;
    for (parts, s.extensions.items) |p, x| x.definitions = p;
    a.free(saved.definitions);
    saved.variables = &.{};
    saved.definitions = &.{};
    s.debt = saved.debt;
    if (saved.stopped) |x| s.stopped = try a.dupe(u8, x);
}

/// Rebuilds a saved Script for a variables-only restore, from its saved
/// source and then each extension, against the Core's current versions, the
/// Libraries given and the Grants re-bound, running its initialisers. A
/// Script that no longer loads fails the restore.
fn rebuildSaved(r: *Restoring, saved: *const Saved) Error!*Script {
    const s = try newScript(r, saved);
    const g = r.g;
    const ca = s.code.allocator();
    var parsed = try g.parseCode(ca, s.source);
    defer parsed.deinit();
    s.imports = parsed.imports;
    if (!(g.buildCode(s, s, &parsed, saved.extensions, true) catch |e| return valueError(e))) return error.LoadRefused;
    s.identity = machine.codeIdentity(s.name, s.source, .script, s.imports);
    for (s.extensions.items) |x| s.identity = machine.extendedIdentity(s.identity, x.identity);
    return s;
}

/// Restores a save into `g`, a new Group nothing has used (chapter 10,
/// Restoring). A save this Core can't read is `invalid save`; one that
/// doesn't match is `.mismatch`. Either way the caller ends `g`, which then
/// holds nothing the Host must release.
pub fn restore(g: *Group, bytes: []const u8, options: Options, result: *Result) Error!Outcome {
    const header = readFrame(bytes, true) catch return error.InvalidSave;
    var r: Restoring = .{ .i = undefined, .g = g, .options = options, .tables = undefined, .libraries = &.{} };
    defer r.deinit();
    const i = &r.i;
    const a = g.gpa;
    const language = header.language;
    const costs_version = header.costs;
    const saved_print = header.print;
    g.saves = header.saves;
    // Each section is read whole, its fields accounting for every byte.
    const sectionAt = struct {
        fn at(h: *const Header, in: *In, tag: Section) Error!void {
            if (in.bytes.len > 0 or in.pos > 0) try in.end();
            in.* = .{ .bytes = h.bodies[@backingInt(tag)].?, .names = in.names };
        }
    }.at;
    r.i = .{ .bytes = &.{} };
    // The texts the other sections name, first.
    try sectionAt(&header, i, .texts);
    const names = try a.alloc([]const u8, try i.count());
    defer a.free(names);
    for (names) |*x| x.* = try i.str();
    i.names = names;
    try sectionAt(&header, i, .group);
    // A restored Group's saves keep its save's name, whatever the Host
    // names it, so its State Fingerprint equals its save's.
    g.name = try r.kept();
    g.clock = try i.instant();
    g.deliveries = try i.int();
    g.broadcasts = try i.int();
    g.waits.importTimers(try i.int());
    g.run_order = try i.int();
    g.charge_counter = try i.int();
    g.random_state = try i.wide();
    try g.waits.importIssued(a, i);
    try sectionAt(&header, i, .libraries);
    if (!std.mem.eql(u8, language, version.language) or costs_version != cost_model.version) {
        r.mismatch = true;
        r.fixed = true;
    }
    // Libraries, matched by identity to those the Host passes.
    r.libraries = try a.alloc(?*Library, try i.count());
    @memset(r.libraries, null);
    var withheld: std.ArrayList([]const u8) = .empty;
    defer withheld.deinit(a);
    // A variables-only restore rebuilds against the Library given under
    // each saved name, whatever its identity.
    var named: std.ArrayList(*Library) = .empty;
    defer named.deinit(a);
    for (r.libraries) |*l| {
        const name = try i.name();
        _ = try i.name();
        if (i.bytes.len - i.pos < 32) return error.InvalidSave;
        const identity = i.bytes[i.pos..][0..32];
        i.pos += 32;
        const given = for (options.libraries) |x| {
            if (std.mem.eql(u8, x.name, name)) break x;
        } else null;
        if (given) |x| {
            try named.append(a, x);
            if (std.mem.eql(u8, &x.identity, identity)) {
                l.* = x;
                try g.libraries.append(a, x);
            } else r.mismatch = true;
        } else {
            r.mismatch = true;
            try withheld.append(a, name);
        }
    }
    // Host Objects, resolved once the save is known to be good.
    try sectionAt(&header, i, .objects);
    const object_count = try i.count();
    const parents = try a.alloc(?usize, object_count);
    defer a.free(parents);
    for (parents) |*parent| {
        const kind_name = try i.name();
        const kind: *const objects.Kind = (if (options.kinds) |k| k.call(k.context, kind_name) else null) orelse blk: {
            // A kind the Core no longer defines: its objects can only be
            // disposed.
            const k = try g.keep.allocator().create(objects.Kind);
            k.* = .{ .name = try g.keep.allocator().dupe(u8, kind_name), .props = &.{} };
            break :blk k;
        };
        const id = try i.name();
        for (g.objects.items) |x| if (std.mem.eql(u8, x.kind.name, kind.name) and std.mem.eql(u8, x.id, id)) return error.InvalidSave;
        const o = objects.Object.make(a, kind, id, null) catch |e| return valueError(e);
        g.objects.append(a, o) catch |e| {
            o.destroy(a);
            return e;
        };
        parent.* = try i.ref(object_count);
        o.disposed = try i.flag();
        if (try i.optName()) |x| o.owner_of = try a.dupe(u8, x);
    }
    for (g.objects.items, parents) |o, p| {
        if (p) |x| o.parent = g.objects.items[x];
    }
    for (g.objects.items) |o| if (o.wouldCycle(o.parent)) return error.InvalidSave;
    // Function Value code; a live one's unit is placed once the Scripts
    // are built.
    try sectionAt(&header, i, .functions);
    const code_count = try i.count();
    const Place = struct { tag: UnitTag = .own, index: usize = 0, name: []const u8 = "", body: u32 = 0, live: bool = false };
    const places = try a.alloc(Place, code_count);
    defer a.free(places);
    for (places) |*place| {
        const home_text = try i.name();
        const name_text = try i.name();
        const home = try a.dupe(u8, home_text);
        const name = a.dupe(u8, name_text) catch |e| {
            a.free(home);
            return e;
        };
        const f = a.create(machine.FunctionCode) catch |e| {
            a.free(home);
            a.free(name);
            return e;
        };
        f.* = .{ .home = home, .library = null, .body = 0, .generation = 0, .name = name };
        g.functions.append(a, f) catch |e| {
            a.free(home);
            a.free(name);
            a.destroy(f);
            return e;
        };
        f.required = try i.small(usize);
        f.total = try i.small(usize);
        if (i.bytes.len - i.pos < 32) return error.InvalidSave;
        f.unit = i.bytes[i.pos..][0..32].*;
        i.pos += 32;
        place.* = .{};
        if (try i.flag()) {
            place.live = true;
            place.tag = std.enums.fromInt(UnitTag, try i.byte()) orelse return error.InvalidSave;
            switch (place.tag) {
                .own => {},
                .extension, .library => place.index = try i.small(usize),
                .stdlib => place.name = try i.name(),
            }
            place.body = try i.small(u32);
        }
    }
    r.tables = .{ .objects = g.objects.items, .functions = g.functions.items };
    // The calls Runs wait on.
    try sectionAt(&header, i, .calls);
    const calls = try a.alloc(*capabilities.Call, try i.count());
    defer a.free(calls);
    for (calls) |*c| {
        const x = try g.waits.importCall(a, try i.name(), .{ .clock = g.clock, .group = g, .owner = g });
        x.script = try r.keptName();
        x.grant = try r.keptName();
        x.run = try r.keptName();
        // The Segment which established the wait, within the Call's Run.
        x.segment = try r.keptName();
        if (!std.mem.startsWith(u8, x.segment, x.run) or !std.mem.startsWith(u8, x.segment[x.run.len..], ".s")) return error.InvalidSave;
        x.now = try i.instant();
        model.dates.validateInstant(x.now) catch return error.InvalidSave;
        if (machine.micros(x.now) > machine.micros(g.clock)) return error.InvalidSave;
        x.args = try r.values();
        x.adoptable = try i.flag();
        x.charged = try i.int();
        x.at_unit = try r.keptName();
        x.at_pc = try i.small(u32);
        x.at_line = try i.small(u32);
        x.at_column = try i.small(u32);
        c.* = x;
    }
    r.calls = calls;
    // The Scripts, read whole, then compiled again as first compiled.
    try sectionAt(&header, i, .scripts);
    const declarations = try r.keep().alloc(SavedDeclaration, try i.count());
    for (declarations) |*d| d.* = try readDeclaration(&r);
    r.declarations = declarations;
    const script_count = try i.count();
    const saved = try a.alloc(Saved, script_count);
    var read: usize = 0;
    defer {
        for (saved[0..read]) |*x| x.release(a);
        a.free(saved);
    }
    for (saved) |*x| {
        try readSaved(&r, x);
        read += 1;
    }
    try i.end();
    // Their sources. An External-source Snapshot can't be restored here: a
    // missing bundle, so a mismatch whatever the policy (chapter 10).
    const sources = header.bodies[@backingInt(Section.sources)] orelse {
        if (g.trace) |w| w.print("> restore from=s{d} fingerprint={x} mode=variables-only\nrefused code=\"save mismatch\"\n", .{ g.saves, saved_print }) catch {};
        return .mismatch;
    };
    r.i = .{ .bytes = sources, .names = names };
    if (try i.count() != saved.len) return error.InvalidSave;
    for (saved) |*x| {
        x.source = try r.kept();
        const extensions = try r.keep().alloc([]const u8, try i.count());
        if (extensions.len != x.extension_identities.len) return error.InvalidSave;
        for (extensions) |*e| e.* = try r.kept();
        x.extensions = extensions;
    }
    for (saved) |*x| if (!try buildSaved(&r, x)) {
        r.mismatch = true;
        break;
    };
    // Versions: the Fingerprint of what this Group now is.
    if (!r.mismatch and !std.mem.eql(u8, &(try g.groupFingerprint()), &saved_print)) r.mismatch = true;
    if (r.mismatch and !options.variables_only and !options.reload_changed) {
        if (g.trace) |w| {
            w.print("> restore from=s{d}", .{g.saves}) catch {};
            writeIds(w, "unbound", r.unbound.items);
            writeIds(w, "withheld", withheld.items);
            w.print(" fingerprint={x} mode=variables-only\nrefused code=\"save mismatch\"\n", .{saved_print}) catch {};
        }
        return .mismatch;
    }
    // A Partial Restore takes a mismatch only in Script code.
    const partial = r.mismatch and options.reload_changed and !r.fixed;
    const variables_only = r.mismatch and !partial;
    // Each Script rebuilt from new code: under a Partial Restore, those whose code changed.
    const reloading = try a.alloc(bool, saved.len);
    defer a.free(reloading);
    @memset(reloading, variables_only);
    if (r.mismatch) {
        // Each Script rebuilt, against what the Host passes now: under a
        // Partial Restore, as first compiled when its code identity still
        // matches, and otherwise as a variables-only restore rebuilds it.
        while (g.scripts.pop()) |x| g.destroyScript(x);
        g.libraries.clearRetainingCapacity();
        try g.libraries.appendSlice(a, named.items);
        for (saved, reloading) |*x, *c| {
            if (partial) {
                const built = try buildSaved(&r, x);
                if (built and std.mem.eql(u8, &g.scripts.getLast().identity, &x.identity)) continue;
                g.destroyScript(g.scripts.pop().?);
                c.* = true;
            }
            _ = try rebuildSaved(&r, x);
        }
        r.skim = variables_only;
    }
    if (!variables_only) for (g.scripts.items, saved, reloading) |x, *y, c| if (!c) try fillSaved(&r, x, y);
    for (g.scripts.items) |s| {
        if (s.owner) |o| if (o.owner_of == null or !std.mem.eql(u8, o.owner_of.?, s.name)) return error.InvalidSave;
    }
    // Function Value code, placed in its Home Script's units; after a
    // variables-only restore every one is stale, and after a Partial
    // Restore every one whose Home Script changed.
    if (!variables_only) for (g.functions.items, places) |f, place| {
        if (!place.live) continue;
        const home = g.script(f.home) orelse continue;
        if (reloading[std.mem.indexOfScalar(*Script, g.scripts.items, home).?]) continue;
        f.library = switch (place.tag) {
            .own => null,
            .extension => if (place.index < home.extensions.items.len) home.extensions.items[place.index] else return error.InvalidSave,
            .library => if (place.index < r.libraries.len) r.libraries[place.index] orelse return error.InvalidSave else return error.InvalidSave,
            .stdlib => machine.stdlibLibrary(place.name) orelse return error.InvalidSave,
        };
        if (place.body >= home.unitIn(f.library).bodies.len) return error.InvalidSave;
        f.body = place.body;
        f.generation = home.generation;
    };
    // Every Run, Script by Script; a changed Script's are read only to be
    // discarded.
    try sectionAt(&header, i, .runs);
    if (try i.count() != g.scripts.items.len) return error.InvalidSave;
    const per_script = try a.alloc(usize, g.scripts.items.len);
    defer a.free(per_script);
    var total_runs: usize = 0;
    for (per_script) |*n| {
        n.* = try i.count();
        total_runs += n.*;
    }
    const bases = try a.alloc([]*Value, try i.count());
    var bases_read: usize = 0;
    defer {
        for (bases[0..bases_read]) |b| machine.releaseValues(b, a);
        a.free(bases);
    }
    for (bases) |*b| {
        b.* = try r.values();
        bases_read += 1;
    }
    r.bases = bases;
    if (try i.count() != total_runs) return error.InvalidSave;
    for (g.scripts.items, reloading, per_script) |s, c, n| {
        r.skim = c;
        for (0..n) |_| try r.oneRun(s);
    }
    r.skim = variables_only;
    try sectionAt(&header, i, .work);
    if (try i.count() != g.scripts.items.len) return error.InvalidSave;
    for (g.scripts.items) |s| {
        const n = try i.count();
        try s.work.ensureTotalCapacity(a, n);
        for (0..n) |_| switch (try i.byte()) {
            0 => s.work.appendAssumeCapacity(.{ .message = try r.delivery() }),
            1 => {
                const x = r.runs.items[try i.index(r.runs.items.len)];
                if (x.script != s) return error.InvalidSave;
                // Ready with what it waited for, or preempted, and once.
                if (!machine.run_lifecycle.continuing(x) and x.resume_with == null) return error.InvalidSave;
                for (s.work.items) |w| if (w == .run and w.run == x) return error.InvalidSave;
                s.work.appendAssumeCapacity(.{ .run = x });
            },
            else => return error.InvalidSave,
        };
    }
    // The waits, in the order they were set, each once.
    try sectionAt(&header, i, .waits);
    try g.waits.importOrder(a, i, r.runs.items);
    try sectionAt(&header, i, .inputs);
    const inputs = try i.count();
    for (0..inputs) |_| {
        const x = try r.input();
        g.inputs.append(a, x) catch |e| {
            var one = [_]machine.Input{x};
            g.releaseInputs(&one);
            return e;
        };
    }
    try sectionAt(&header, i, .decisions);
    const open = try i.count();
    for (0..open) |_| {
        const id = try i.int();
        const n = try i.count();
        const deliveries = try a.alloc(u64, n);
        const parts = a.alloc(?machine.Part, n) catch |e| {
            a.free(deliveries);
            return e;
        };
        @memset(parts, null);
        const entry: machine.OpenBroadcast = .{ .deliveries = deliveries, .parts = parts };
        g.open_broadcasts.put(a, id, entry) catch |e| {
            g.releaseOpen(entry);
            return e;
        };
        for (deliveries, parts) |*d, *part| {
            d.* = try i.int();
            part.* = switch (try i.byte()) {
                0 => null,
                1 => .allowed,
                2 => .{ .vetoed = try r.mark() },
                3 => .{ .undecided = try r.mark() },
                else => return error.InvalidSave,
            };
        }
    }
    const deferred = try i.count();
    try g.deferred.ensureTotalCapacity(a, deferred);
    for (0..deferred) |_| {
        const id = try i.int();
        const broadcast = try i.int();
        const mark = if (try i.flag()) try r.mark() else null;
        g.deferred.appendAssumeCapacity(.{ .id = id, .broadcast = broadcast, .mark = mark });
    }
    try sectionAt(&header, i, .accounting);
    const discards = try i.count();
    for (0..discards) |_| {
        const root = try i.int();
        try g.root_discards.put(a, root, try i.int());
    }
    const changed = try i.count();
    for (0..changed) |_| try g.changed_roots.put(a, try i.int(), {});
    if (i.pos != i.bytes.len) return error.InvalidSave;
    // Each call's Grant binding.
    for (calls) |c| {
        const s = g.script(c.script) orelse return error.InvalidSave;
        if (s.grant(c.grant)) |sg| c.binding = sg.grant.binding;
    }
    var discarded: Discarded = .{};
    defer discarded.deinit(a);
    var reloaded: std.ArrayList([]const u8) = .empty;
    defer reloaded.deinit(a);
    if (variables_only) try discard(&r, saved, &discarded) else {
        if (partial) try reload(&r, saved, reloading, &discarded, &reloaded);
        baseline(g);
    }
    // The calls that still pend.
    var pending_ids = try g.waits.importedPending(a, calls);
    errdefer pending_ids.deinit(a);
    g.restored = .{ .pending = pending_ids, .clock = g.clock };
    // Settlements queued before the save settle restored calls, once each.
    // On refusal the pending ids go with errdefer, and nothing else here.
    errdefer if (g.restored) |*x| {
        x.settled.deinit(a);
        g.restored = null;
    };
    for (g.inputs.items) |x| if (x == .settlement) {
        const restored = &g.restored.?;
        const id = for (restored.pending.items) |p| {
            if (std.mem.eql(u8, p, x.settlement.id)) break p;
        } else return error.InvalidSave;
        for (restored.settled.items) |done| if (std.mem.eql(u8, done, id)) return error.InvalidSave;
        try restored.settled.append(a, id);
    };
    // Host Objects: each the Host can't resolve restores disposed.
    var disposed: std.ArrayList(*objects.Object) = .empty;
    errdefer disposed.deinit(a);
    for (g.objects.items) |o| {
        if (o.disposed) continue;
        var native: ?*anyopaque = null;
        const found = if (options.resolve) |x| x.call(x.context, o.kind.name, o.id, &native) else false;
        if (found) o.native = native else {
            o.disposed = true;
            try disposed.append(a, o);
        }
    }
    result.disposed = try disposed.toOwnedSlice(a);
    result.reloaded = try reloaded.toOwnedSlice(a);
    result.discarded = try discarded.runs.toOwnedSlice(a);
    result.dropped = try discarded.dropped.toOwnedSlice(a);
    result.abandoned = try discarded.abandoned.toOwnedSlice(a);
    if (g.trace) |w| {
        w.print("> restore from=s{d}", .{g.saves}) catch {};
        if (options.reload_changed) w.writeAll(" mismatch=reload-changed") catch {} else if (options.variables_only) w.writeAll(" mismatch=variables-only") catch {};
        writeIds(w, "unbound", r.unbound.items);
        writeIds(w, "withheld", withheld.items);
        w.print(" fingerprint={x} mode={s}", .{ saved_print, if (variables_only) "variables-only" else if (partial) "partial" else "full" }) catch {};
        writeIds(w, "reloaded", result.reloaded);
        writeIds(w, "pending", g.restored.?.pending.items);
        if (result.disposed.len > 0) {
            w.writeAll(" disposed=[") catch {};
            for (result.disposed, 0..) |o, n| {
                if (n > 0) w.writeAll(", ") catch {};
                display.writeTrace(w, o.value) catch {};
            }
            w.writeAll("]") catch {};
        }
        writeIds(w, "discarded", result.discarded);
        writeIds(w, "dropped", result.dropped);
        writeIds(w, "abandoned", result.abandoned);
        w.writeAll("\n") catch {};
    }
    return if (variables_only) .variables_only else if (partial) .partial else .full;
}

/// A full restore's accounting baseline (chapter 9, Run accounting): every
/// saved live Run's accounting and every active root's work, reported by
/// the restore without its Runs' `run started`.
fn baseline(g: *Group) void {
    for (g.scripts.items) |s| {
        for (s.live.items) |run| {
            run.reported_fuel = null;
            g.markRoot(machine.rootOf(run.delivery));
        }
        for (s.work.items) |w| switch (w) {
            .message => |d| g.markRoot(machine.rootOf(d)),
            .run => {},
        };
    }
    for (g.inputs.items) |x| switch (x) {
        .deliver => |d| g.markRoot(machine.rootOf(d.delivery)),
        else => {},
    };
}

/// What a variables-only restore discarded, by id, in order; the ids are
/// the Group's `keep`.
const Discarded = struct {
    runs: std.ArrayList([]const u8) = .empty,
    dropped: std.ArrayList([]const u8) = .empty,
    abandoned: std.ArrayList([]const u8) = .empty,

    fn deinit(d: *Discarded, gpa: Allocator) void {
        d.runs.deinit(gpa);
        d.dropped.deinit(gpa);
        d.abandoned.deinit(gpa);
    }
};

/// A variables-only restore's discarding (chapter 10, Variables-only
/// restore): every Run, with no `finally`, its Fuel kept in its Script's
/// counters; the mailboxes, the input queue and the Fuel Slice debt; and
/// every pending call. Each Script Variable the new code still declares
/// takes its saved value, as a preempted Run's rollback would leave it,
/// and each open Decision settles undecided at the first Pump.
fn discard(r: *Restoring, saved: []const Saved, out: *Discarded) Error!void {
    const g = r.g;
    const a = r.gpa();
    const k = r.keep();
    var dropped: std.ArrayList(u64) = .empty;
    defer dropped.deinit(a);
    // The Wait table includes ordinary waits and Join Members. Script
    // calls keep their id on the Wait; timers and events have no call id.
    for (g.waits.all()) |p| {
        const id = if (p.call) |c| c.id else p.id;
        if (id.len > 0) try out.abandoned.append(a, try k.dupe(u8, id));
    }
    for (g.scripts.items, saved) |s, *x| {
        var runs: std.ArrayList(*Run) = .empty;
        defer runs.deinit(a);
        try carry(r, s, x, &runs);
        for (runs.items) |run| {
            g.discardRun(run, "variables-only restore");
            try out.runs.append(a, try k.dupe(u8, run.id));
            s.fuel_total += run.fuel;
            s.alloc_total += run.alloc;
            if (run.verdict or run.delivery.decision) try defer_(g, run.delivery, s.name, run.id);
        }
        for (runs.items) |run| g.endRun(run, .discarded) catch unreachable;
        for (s.work.items) |w| switch (w) {
            .message => |d| {
                if (d.from == null and d.id > 0) try dropped.append(a, d.id);
                if (d.decision) try defer_(g, d, s.name, "");
                g.discardMessage(d);
                g.releaseDelivery(d);
            },
            .run => {},
        };
        s.work.clearRetainingCapacity();
    }
    // The input queue: each queued call's line is written before the
    // restore's, since it is never drained.
    for (g.inputs.items) |x| {
        g.writeInput(x);
        switch (x) {
            .deliver => |d| {
                if (d.delivery.id > 0) try dropped.append(a, d.delivery.id);
                if (d.delivery.decision) try defer_(g, d.delivery, d.script, "");
                g.discardMessage(d.delivery);
            },
            .broadcast => |b| if (b.decision) try g.deferred.append(a, .{ .id = b.id }),
            else => {},
        }
    }
    g.releaseInputs(g.inputs.items);
    g.inputs.clearRetainingCapacity();
    sorting.stable(u64, dropped.items, {}, std.sort.asc(u64));
    for (dropped.items) |id| try out.dropped.append(a, try std.fmt.allocPrint(k, "d{d}", .{id}));
    sorting.stable([]const u8, out.abandoned.items, {}, struct {
        fn less(_: void, p: []const u8, q: []const u8) bool {
            return machine.callOrder(p, q);
        }
    }.less);
}

/// Each Script Variable a rebuilt Script declares takes its saved value, as
/// a preempted Run's rollback would leave it; `runs` gets the Script's
/// restored Runs in the order they started. Over its Persistent State cap,
/// the restore fails.
fn carry(r: *Restoring, s: *Script, x: *const Saved, runs: *std.ArrayList(*Run)) Error!void {
    const a = r.gpa();
    try runs.appendSlice(a, s.live.items);
    sorting.stable(*Run, runs.items, {}, struct {
        fn less(_: void, p: *Run, q: *Run) bool {
            return runNumber(p.id) < runNumber(q.id);
        }
    }.less);
    // The prospective post-rollback view of the saved variables.
    const view = try a.dupe(*Value, x.variables);
    defer a.free(view);
    for (runs.items) |run| if (machine.run_lifecycle.continuing(run)) if (run.segment_base) |base| {
        if (base.len > view.len) return error.InvalidSave;
        @memcpy(view[0..base.len], base);
    };
    for (s.variableNames(), s.variables) |name, *v| {
        for (x.variable_names, view) |old, value| if (std.mem.eql(u8, old, name)) {
            v.*.release();
            v.* = value.retain();
            break;
        };
    }
    var state: u64 = 0;
    for (s.variables) |v| state += machine.costs.size(v);
    if (state > s.limits.persistent_state) return error.StateTooLarge;
}

/// A Partial Restore's Reloads (chapter 10, Partial Restore): each changed
/// Script, in load order, carries its Script Variables over as a Reload with
/// `CarryVariables` would, and its saved Runs and mailbox end as that
/// Reload's Stop would end them, with no Host hook. Those waiting on them
/// get `send failed`, reason `stopped`, and each open Decision settles
/// undecided at the first Pump.
fn reload(r: *Restoring, saved: []const Saved, changed: []const bool, out: *Discarded, reloaded: *std.ArrayList([]const u8)) Error!void {
    const g = r.g;
    const a = r.gpa();
    const k = r.keep();
    var decisions: machine.Group.DeliveryDecisions = .empty;
    defer decisions.deinit(a);
    var dropped: std.ArrayList(u64) = .empty;
    defer dropped.deinit(a);
    for (g.scripts.items, saved, changed) |s, *x, c| {
        if (!c) continue;
        try reloaded.append(a, s.name);
        // The calls and waits its Runs abandon, in call id order.
        const calls = out.abandoned.items.len;
        for (g.waits.all()) |p| if (p.run.script == s) {
            const id = if (p.call) |call| call.id else p.id;
            if (id.len > 0) try out.abandoned.append(a, try k.dupe(u8, id));
        };
        sorting.stable([]const u8, out.abandoned.items[calls..], {}, struct {
            fn less(_: void, p: []const u8, q: []const u8) bool {
                return machine.callOrder(p, q);
            }
        }.less);
        var runs: std.ArrayList(*Run) = .empty;
        defer runs.deinit(a);
        try carry(r, s, x, &runs);
        // Its ready Runs end below, with the rest.
        var at: usize = 0;
        while (at < s.work.items.len) {
            if (s.work.items[at] == .run) _ = s.work.orderedRemove(at) else at += 1;
        }
        const ended = out.runs.items.len;
        for (runs.items) |run| {
            const id = try k.dupe(u8, run.id);
            try out.runs.append(a, id);
            g.endRun(run, .{ .stopped = .{ .decisions = &decisions, .discard = "reload", .run_id = id } }) catch |e| return valueError(e);
        }
        const messages = dropped.items.len;
        while (s.work.items.len > 0) {
            const d = s.work.orderedRemove(0).message;
            if (d.from == null and d.id > 0) try dropped.append(a, d.id);
            g.dropRestored(s, d, &decisions) catch |e| return valueError(e);
        }
        try g.reportStop(s.name, "reload", out.runs.items[ended..], dropped.items[messages..], out.abandoned.items[calls..]);
    }
    // A queued settlement of a call the changed Scripts abandoned settles
    // nothing.
    var at: usize = 0;
    while (at < g.inputs.items.len) {
        const x = g.inputs.items[at];
        const abandoned = x == .settlement and for (out.abandoned.items) |id| {
            if (std.mem.eql(u8, id, x.settlement.id)) break true;
        } else false;
        if (abandoned) {
            var one = [_]machine.Input{g.inputs.orderedRemove(at)};
            g.releaseInputs(&one);
        } else at += 1;
    }
    for (decisions.items) |x| switch (x.part) {
        .undecided => |m| try defer_(g, .{ .id = x.id, .broadcast = x.broadcast, .message = "", .args = &.{}, .request = false }, m.script, m.run),
        else => {},
    };
    sorting.stable(u64, dropped.items, {}, std.sort.asc(u64));
    for (dropped.items) |id| try out.dropped.append(a, try std.fmt.allocPrint(k, "d{d}", .{id}));
    sorting.stable([]const u8, out.abandoned.items, {}, struct {
        fn less(_: void, p: []const u8, q: []const u8) bool {
            return machine.callOrder(p, q);
        }
    }.less);
}

/// Defers an open Decision's undecided part to the first Pump.
fn defer_(g: *Group, d: machine.Delivery, script: []const u8, run: []const u8) !void {
    const a = g.gpa;
    const s = try a.dupe(u8, script);
    errdefer a.free(s);
    const r = try a.dupe(u8, run);
    errdefer a.free(r);
    try g.deferred.append(a, .{ .id = d.id, .broadcast = d.broadcast, .mark = .{ .script = s, .run = r, .outcome = "cancelled" } });
}

fn runNumber(id: []const u8) u64 {
    const at = std.mem.lastIndexOfScalar(u8, id, 'r') orelse return 0;
    return std.fmt.parseInt(u64, id[at + 1 ..], 10) catch 0;
}

fn writeIds(w: *std.Io.Writer, key: []const u8, ids: []const []const u8) void {
    if (ids.len == 0) return;
    w.print(" {s}=[", .{key}) catch {};
    for (ids, 0..) |id, n| w.print("{s}{s}", .{ if (n > 0) ", " else "", id }) catch {};
    w.writeAll("]") catch {};
}

// ---------------------------------------------------------------- tests

const testing = std.testing;

/// A Group with Runs suspended in a `wait`, a `send … and wait` pair, a
/// `wait for`, a Function Value and a queued Delivery.
fn busyGroup(gpa: Allocator) !Group {
    var g: Group = .init(gpa, null);
    errdefer g.deinit();
    const a =
        \\script variable log = []
        \\script variable f = nothing
        \\on go n
        \\  put (given x: x + n) into f
        \\  repeat for each i in [1, 2, 3]
        \\    send note with i to b and wait
        \\    put it after log
        \\  end repeat
        \\end go
        \\on nap
        \\  wait 5 s
        \\  put "woke" after log
        \\end nap
        \\on watch
        \\  wait for ping n or 9 s
        \\  put it after log
        \\end watch
        \\
    ;
    const b =
        \\on note n
        \\  wait 1 s
        \\  return n * 2
        \\end note
        \\
    ;
    try testing.expect(try g.load("a", a, .{}) == .loaded);
    try testing.expect(try g.load("b", b, .{}) == .loaded);
    const seven = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(7) });
    var args = [_]*Value{seven};
    _ = try g.deliver("a", "go", &args, false);
    _ = try g.deliver("a", "nap", &.{}, false);
    _ = try g.deliver("a", "watch", &.{}, false);
    try g.pump(.{ .seconds = 1790000000, .micros = 0 });
    _ = try g.deliver("a", "nap", &.{}, false);
    return g;
}

test "a save that doesn't match is refused under RejectMismatch, and nothing is made" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const other = try save(&g, gpa, @splat(0));
    defer gpa.free(other);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    try testing.expectEqual(Outcome.mismatch, try restore(&restored, other, .{}, &result));
}

test "prior snapshot layouts are refused" {
    const gpa = testing.allocator;
    var g: Group = .init(gpa, null);
    defer g.deinit();
    const bytes = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    // Format 17, the Zig Core's last before ADR 0144, and others.
    @memcpy(bytes[0..magic.len], "NTZS");
    for ([_]u8{ 8, 11, 17 }) |old| {
        bytes[magic.len] = old;
        for ([_]bool{ false, true }) |variables_only| {
            var restored: Group = .init(gpa, null);
            defer restored.deinit();
            var result: Result = .{};
            defer result.deinit(gpa);
            try testing.expectError(error.InvalidSave, restore(&restored, bytes, .{ .variables_only = variables_only }, &result));
        }
    }
}

test "pending Calls retain their crossing Clock and Segment through restore" {
    const Host = struct {
        fn start(_: ?*anyopaque, _: *capabilities.Call, _: []const *Value) capabilities.Outcome {
            return .started;
        }
        fn rebind(context: ?*anyopaque, _: []const u8, _: []const u8) ?*capabilities.Grant {
            return @ptrCast(@alignCast(context.?));
        }
    };
    const gpa = testing.allocator;
    var shape: capabilities.Shape = .{ .allocator = gpa, .data = .{ .kind = .any } };
    var ops = [_]capabilities.Operation{.{ .name = "fetch", .args = &.{}, .result = &shape, .mode = .suspending, .cost = .{ .fuel = 7 }, .host = .{ .call = Host.start } }};
    var cap: capabilities.Capability = .{ .name = "api", .operations = &ops };
    var kept = [_]bool{true};
    var grant: capabilities.Grant = .{ .capability = &cap, .operations = &kept };
    const named = [_]machine.NamedGrant{.{ .name = "api", .grant = &grant }};
    const original: model.dates.Instant = .{ .seconds = -1, .micros = 123456 };
    const later: model.dates.Instant = .{ .seconds = 0, .micros = 654321 };
    const resumed: model.dates.Instant = .{ .seconds = 1, .micros = 999999 };
    for ([_]bool{ false, true }) |join| {
        var g: Group = .init(gpa, null);
        defer g.deinit();
        // Both calls originate in Segment 2, after an ordinary wait. The
        // Join is saved with its Segment still open at a Fuel preemption.
        const source = if (join)
            "script variable n = 0\non go\n wait 1 s\n add 1 to n\n wait for all\n ask api to fetch and wait\n add 2 to n\n end wait\nend go\n"
        else
            "on go\n wait 1 s\n ask api to fetch and wait\n return it\nend go\n";
        try testing.expect(try g.load("s", source, .{ .grants = &named }) == .loaded);
        _ = try g.deliver("s", "go", &.{}, false);
        try g.pump(.{ .seconds = -2, .micros = 123456 });
        try g.pumpWith(original, if (join) 40 else 0, 0);
        try testing.expectEqual(@as(usize, 1), g.waits.pending.items.len);
        try testing.expectEqual(join, machine.run_lifecycle.continuing(g.waits.pending.items[0].run));
        const call = g.waits.pending.items[0].call.?;
        try testing.expectEqualStrings("s/r1.s2", call.segment);
        // The ordinary wait stays pending across multiple later Pumps.
        // Keep the Join preempted by spending only one instruction's Fuel.
        try g.pumpWith(later, if (join) 1 else 0, 0);
        if (!join) try g.pump(.{ .seconds = 0, .micros = 999999 });
        try testing.expectEqual(join, machine.run_lifecycle.continuing(g.waits.pending.items[0].run));
        try testing.expectEqualStrings("s/r1.s2", call.segment);
        const bytes = try save(&g, gpa, try g.groupFingerprint());
        defer gpa.free(bytes);
        for ([_]machine.How{ .adopt, .reissue }) |how| {
            var copy: Group = .init(gpa, null);
            defer copy.deinit();
            var result: Result = .{};
            defer result.deinit(gpa);
            try testing.expectEqual(Outcome.full, try restore(&copy, bytes, .{ .grants = .{ .context = &grant, .call = Host.rebind } }, &result));
            try testing.expectEqual(@as(usize, 1), copy.restored.?.pending.items.len);
            const restored = copy.callById(call.id).?;
            try testing.expectEqualStrings(call.segment, restored.segment);
            try testing.expectEqual(original, restored.now);
            const again = try save(&copy, gpa, try copy.groupFingerprint());
            defer gpa.free(again);
            try testing.expectEqualSlices(u8, bytes, again);
            // A TS `run` call, which a TS save marks, can't be adopted.
            restored.adoptable = false;
            if (how == .adopt) try testing.expectError(error.NotAdoptable, copy.settleRestored(call.id, how, null));
            restored.adoptable = true;
            try copy.settleRestored(call.id, how, null);
            try testing.expectEqual(original, restored.now);
            try copy.pumpWith(resumed, if (join) 1 else 0, 0);
            try testing.expectEqual(if (how == .adopt) original else resumed, restored.now);
            try testing.expectEqualStrings(call.segment, restored.segment);
        }
        // Malformed timestamps with valid save digests must be refused.
        for ([_]model.dates.Instant{
            .{ .seconds = std.math.maxInt(i64), .micros = 0 },
            .{ .seconds = -1, .micros = 1000000 },
            .{ .seconds = 2, .micros = 0 }, // After the saved Group Clock.
        }) |invalid| {
            call.now = invalid;
            const corrupt = try save(&g, gpa, try g.groupFingerprint());
            defer gpa.free(corrupt);
            var copy: Group = .init(gpa, null);
            defer copy.deinit();
            var result: Result = .{};
            defer result.deinit(gpa);
            try testing.expectError(error.InvalidSave, restore(&copy, corrupt, .{ .grants = .{ .context = &grant, .call = Host.rebind } }, &result));
        }
    }
}

test "a variables-only restore keeps Script Variables and discards the rest" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    // A withheld nothing still mismatches when the Fingerprint differs: a
    // save from another Group shape is forced here by a bad fingerprint.
    const good = try save(&g, gpa, @splat(0));
    defer gpa.free(good);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.variables_only, try restore(&restored, good, .{ .variables_only = true }, &result));
    try testing.expectEqual(@as(usize, 4), result.discarded.len);
    try testing.expectEqual(@as(usize, 1), result.dropped.len);
    try testing.expectEqual(@as(usize, 1), result.abandoned.len);
    try testing.expectEqualStrings("a/r1.c1", result.abandoned[0]);
    for (restored.scripts.items) |x| try testing.expectEqual(@as(usize, 0), x.live.items.len);
    try testing.expectEqual(@as(usize, 0), restored.waits.all().len);
    try restored.pump(.{ .seconds = 1790000010, .micros = 0 });
}

test "a save from language 1.0-rc.2 is a mismatch, refused or restored variables-only" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const old = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(old);
    // Same-length versions keep the string's length prefix; re-sign the bytes.
    const previous = "1.0-rc.2";
    try testing.expectEqual(previous.len, version.language.len);
    const at = std.mem.indexOf(u8, old, version.language).?;
    @memcpy(old[at..][0..previous.len], previous);
    reseal(old);
    var refused: Group = .init(gpa, null);
    defer refused.deinit();
    var none: Result = .{};
    try testing.expectEqual(Outcome.mismatch, try restore(&refused, old, .{}, &none));
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.variables_only, try restore(&restored, old, .{ .variables_only = true }, &result));
    try testing.expectEqual(@as(usize, 4), result.discarded.len);
    try testing.expectEqual(@as(usize, 1), result.dropped.len);
}

test "Argument Labels are in the Group Fingerprint and restore's declaration matching (ADR 0115)" {
    const gpa = testing.allocator;
    const Host = struct {
        fn call(_: ?*anyopaque, c: *capabilities.Call, _: []const *Value) capabilities.Outcome {
            return .{ .value = model.text(c.gpa, "moved") catch return .broken };
        }
        fn rebind(context: ?*anyopaque, _: []const u8, _: []const u8) ?*capabilities.Grant {
            return @ptrCast(@alignCast(context.?));
        }
    };
    var text: capabilities.Shape = .{ .allocator = gpa, .data = .{ .kind = .text } };
    var args = [_]*capabilities.Shape{ &text, &text };
    var ops = [_]capabilities.Operation{.{ .name = "move", .args = &args, .labels = &.{"to"}, .result = &text, .mode = .immediate, .host = .{ .call = Host.call } }};
    var capability: capabilities.Capability = .{ .name = "world", .operations = &ops };
    try testing.expect(capability.validScopes());
    var kept = [_]bool{true};
    var grant: capabilities.Grant = .{ .capability = &capability, .operations = &kept };
    const json = try fingerprint.grantJson(gpa, &capability, &kept);
    defer gpa.free(json);
    try testing.expectEqualStrings("{\"capability\":\"world\",\"operations\":[{\"name\":\"move\",\"mode\":\"immediate\",\"args\":[\"text\",\"text\"],\"labels\":[\"to\"],\"result\":\"text\",\"cost\":{\"fuel\":0,\"alloc\":0}}]}", json);
    var g: Group = .init(gpa, null);
    defer g.deinit();
    const named = [_]machine.NamedGrant{.{ .name = "world", .grant = &grant }};
    try testing.expect(try g.load("s", "on go\n  ask world to move \"a\" to \"b\"\n  return it\nend go\n", .{ .grants = &named }) == .loaded);
    const print = try g.groupFingerprint();
    const bytes = try save(&g, gpa, print);
    defer gpa.free(bytes);
    var same: Group = .init(gpa, null);
    defer same.deinit();
    var restored: Result = .{};
    defer restored.deinit(gpa);
    try testing.expectEqual(Outcome.full, try restore(&same, bytes, .{ .grants = .{ .context = &grant, .call = Host.rebind } }, &restored));
    // Unbound, the saved declarations still check the labelled call.
    var unbound_group: Group = .init(gpa, null);
    defer unbound_group.deinit();
    var unbound_result: Result = .{};
    defer unbound_result.deinit(gpa);
    try testing.expectEqual(Outcome.full, try restore(&unbound_group, bytes, .{}, &unbound_result));
    // Labels that differ, or none, are a declaration mismatch.
    for ([_][]const []const u8{ &.{"toward"}, &.{} }) |labels| {
        ops[0].labels = labels;
        var other: Group = .init(gpa, null);
        defer other.deinit();
        var refused: Result = .{};
        defer refused.deinit(gpa);
        try testing.expectEqual(Outcome.mismatch, try restore(&other, bytes, .{ .grants = .{ .context = &grant, .call = Host.rebind } }, &refused));
    }
    ops[0].labels = &.{"to"};
    try testing.expectEqualSlices(u8, &print, &(try g.groupFingerprint()));
    // A wrong length, or a word that can't be a label, isn't valid.
    for ([_][]const []const u8{ &.{ "to", "by" }, &.{"from"}, &.{"with"}, &.{"otherwise"}, &.{"if"}, &.{"two words"}, &.{""}, &.{"9x"} }) |labels| {
        ops[0].labels = labels;
        try testing.expect(!capability.validScopes());
    }
    ops[0].labels = &.{"_x"};
    try testing.expect(capability.validScopes());
}

test "a save restores to the same save, and a restored Group goes on" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const print = try g.groupFingerprint();
    const first = try save(&g, gpa, print);
    defer gpa.free(first);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    try testing.expectEqual(Outcome.full, try restore(&restored, first, .{}, &result));
    defer result.deinit(gpa);
    const again = try save(&restored, gpa, print);
    defer gpa.free(again);
    try testing.expectEqualSlices(u8, first, again);
    // It runs on, each Run where it was.
    try restored.pump(.{ .seconds = 1790000010, .micros = 0 });
    try g.pump(.{ .seconds = 1790000010, .micros = 0 });
    const x = try save(&g, gpa, print);
    defer gpa.free(x);
    const y = try save(&restored, gpa, print);
    defer gpa.free(y);
    try testing.expectEqualSlices(u8, x, y);
}

test "Map updates retain insertion order and originals across restore and Segment rollback" {
    const gpa = testing.allocator;
    var group: Group = .init(gpa, null);
    defer group.deinit();
    const source =
        \\script variable values = {"é": 1, tail: 2}
        \\script variable original = nothing
        \\on edit
        \\  put values into original
        \\  put values into values's self
        \\  put 3 into the ("é") of values
        \\  wait 1 s
        \\  put 4 into values's tail
        \\end edit
        \\on fault
        \\  put 5 into values's tail
        \\  repeat forever
        \\  end repeat
        \\end fault
        \\
    ;
    try testing.expect(try group.load("s", source, .{ .limits = .{ .fuel_per_run = 10_000 } }) == .loaded);
    _ = try group.deliver("s", "edit", &.{}, false);
    try group.pump(.{ .seconds = 1790000000, .micros = 0 });
    const saved = try save(&group, gpa, try group.groupFingerprint());
    defer gpa.free(saved);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.full, try restore(&restored, saved, .{}, &result));
    const original = try display.parse(gpa, "{\"é\": 1, tail: 2}", .{});
    defer original.release();
    for ([_]*Group{ &group, &restored }) |g| {
        try g.pump(.{ .seconds = 1790000001, .micros = 0 });
        const script = g.script("s").?;
        const values = script.variables[0].retain();
        defer values.release();
        try testing.expect(try original.equal(script.variables[1]));
        try testing.expect(try original.equal(values.get("self").?));
        try testing.expectEqualStrings("é", values.data.map.at(0).key);
        try testing.expectEqualStrings("tail", values.data.map.at(1).key);
        try testing.expectEqualStrings("self", values.data.map.at(2).key);
        try testing.expectEqual(std.math.Order.eq, model.Decimal.order(model.Decimal.fromInt(3), values.get("é").?.data.number));
        try testing.expectEqual(std.math.Order.eq, model.Decimal.order(model.Decimal.fromInt(4), values.get("tail").?.data.number));
        _ = try g.deliver("s", "fault", &.{}, false);
        try g.pump(.{ .seconds = 1790000002, .micros = 0 });
        try testing.expect(try values.equal(script.variables[0]));
    }
}

test "a corrupt or hostile save is refused, never a crash" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const good = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(good);
    const bad = try gpa.dupe(u8, good);
    defer gpa.free(bad);
    // Every truncation, and every byte changed, with the digest made good
    // again, as a hostile save would.
    var n: usize = 0;
    while (n < good.len) : (n += 1) {
        for ([_]u8{ 0x01, 0x80, 0xff }) |flip| {
            @memcpy(bad, good);
            bad[n] ^= flip;
            reseal(bad);
            // Both policies: a variables-only restore reads Runs only to
            // discard them.
            for ([_]bool{ false, true }) |variables_only| {
                var restored: Group = .init(gpa, null);
                defer restored.deinit();
                var result: Result = .{};
                if (restore(&restored, bad, .{ .variables_only = variables_only }, &result)) |_| result.deinit(gpa) else |_| {}
            }
        }
        var restored: Group = .init(gpa, null);
        defer restored.deinit();
        var result: Result = .{};
        try testing.expectError(error.InvalidSave, restore(&restored, good[0..n], .{}, &result));
    }
}

test "a save or restore refused at any allocation leaves nothing behind" {
    const GroupAllocator = @import("group_allocator.zig").GroupAllocator;
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const print = try g.groupFingerprint();
    const good = try save(&g, gpa, print);
    defer gpa.free(good);
    var cap: usize = 1024;
    var finished = false;
    while (!finished) : (cap += 64) {
        var memory: GroupAllocator = .init(gpa, cap);
        defer memory.deinit();
        var restored: Group = .init(memory.allocator(), null);
        defer restored.deinit();
        var result: Result = .{};
        finished = blk: {
            const outcome = restore(&restored, good, .{}, &result) catch |e| {
                if (e != error.OutOfMemory) return e;
                break :blk false;
            };
            result.deinit(memory.allocator());
            try testing.expectEqual(Outcome.full, outcome);
            const again = save(&restored, memory.allocator(), print) catch break :blk false;
            defer memory.allocator().free(again);
            try testing.expectEqualSlices(u8, good, again);
            break :blk true;
        };
    }
}

/// A Group with more state in its Runs: an iterator and a Timeout Block's
/// deadline held across a `wait`, a parked Run, a Join of two sends, a
/// `wait` inside a `catch`, and a Run preempted in the middle of a loop.
fn richGroup(gpa: Allocator) !Group {
    var g: Group = .init(gpa, null);
    errdefer g.deinit();
    const a =
        \\script variable log = []
        \\on loop
        \\  repeat for each i in [1, 2, 3]
        \\    with timeout of 9 s
        \\      wait 1 s
        \\    end timeout
        \\    put i after log
        \\  end repeat
        \\end loop
        \\on busy n, queued
        \\  wait 2 s
        \\  put n after log
        \\end busy
        \\on fan
        \\  wait for all
        \\    send note with 1 to b and wait
        \\    send note with 2 to b and wait
        \\  end wait
        \\  put it after log
        \\end fan
        \\on fix
        \\  try
        \\    throw {code: "x"}
        \\  catch e
        \\    wait 1 s
        \\    put e after log
        \\  end try
        \\end fix
        \\on spin
        \\  repeat for each i in [1, 2, 3, 4, 5, 6, 7, 8, 9]
        \\    put i after log
        \\  end repeat
        \\end spin
        \\
    ;
    const b =
        \\on note n
        \\  wait 1 s
        \\  return n * 2
        \\end note
        \\
    ;
    try testing.expect(try g.load("a", a, .{}) == .loaded);
    try testing.expect(try g.load("b", b, .{}) == .loaded);
    for ([_][]const u8{ "loop", "fan", "fix" }) |m| _ = try g.deliver("a", m, &.{}, false);
    for (0..2) |k| {
        const n = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(@as(i64, @intCast(k))) });
        var args = [_]*Value{n};
        _ = try g.deliver("a", "busy", &args, false);
    }
    _ = try g.deliver("a", "spin", &.{}, false);
    // A Fuel cap that stops `spin` in the middle of its loop.
    try g.pumpWith(.{ .seconds = 1790000000, .micros = 0 }, 0, 140);
    return g;
}

/// Makes a changed save's digests good again, as a hostile save would:
/// each section's, the State Fingerprint and the body digest. Bytes whose
/// frames no longer parse are left as they are.
fn reseal(bytes: []u8) void {
    var i: In = .{ .bytes = bytes, .pos = magic.len };
    _ = i.int() catch return;
    _ = i.str() catch return;
    _ = i.int() catch return;
    _ = i.digest() catch return;
    _ = i.int() catch return;
    const state_at = i.pos;
    _ = i.digest() catch return;
    const body_at = i.pos;
    _ = i.digest() catch return;
    var state: Sha256 = .init(.{});
    const n = i.int() catch return;
    for (0..n) |_| {
        const tag = i.byte() catch return;
        const flags = i.byte() catch return;
        const len = i.int() catch return;
        const at = i.pos;
        _ = i.digest() catch return;
        if (len > bytes.len - i.pos) return;
        Sha256.hash(bytes[i.pos..][0..len], bytes[at..][0..32], .{});
        i.pos += len;
        if (flags == 0) {
            state.update(&.{tag});
            state.update(bytes[at..][0..32]);
        }
    }
    bytes[state_at..][0..32].* = state.finalResult();
    // The body digest covers the State Fingerprint, so it comes after.
    var again: Sha256 = .init(.{});
    again.update(bytes[0..body_at]);
    var j: In = .{ .bytes = bytes, .pos = body_at + 32 };
    const m = j.int() catch return;
    for (0..m) |_| {
        const tag = j.byte() catch return;
        const flags = j.byte() catch return;
        const len = j.int() catch return;
        const d = j.digest() catch return;
        j.pos += len;
        again.update(&.{ tag, flags });
        again.update(&d);
    }
    bytes[body_at..][0..32].* = again.finalResult();
}

/// Restores a mutated save and, if it restores, runs it: it must refuse or
/// run, never crash.
fn hostile(gpa: Allocator, bad: []u8) !void {
    reseal(bad);
    for ([_]Options{ .{}, .{ .variables_only = true }, .{ .reload_changed = true } }) |options| {
        var restored: Group = .init(gpa, null);
        defer restored.deinit();
        var result: Result = .{};
        const outcome = restore(&restored, bad, options, &result) catch continue;
        result.deinit(gpa);
        if (outcome == .mismatch) continue;
        _ = restored.deliver("a", "spin", &.{}, false) catch {};
        restored.pump(.{ .seconds = 1790000001, .micros = 0 }) catch {};
        restored.pump(.{ .seconds = 1790000020, .micros = 0 }) catch {};
    }
}

test "a hostile save that restores runs without a crash" {
    const gpa = testing.allocator;
    var prng: std.Random.DefaultPrng = .init(628);
    const random = prng.random();
    for ([_]*const fn (Allocator) anyerror!Group{ busyGroup, richGroup }) |make| {
        var g = try make(gpa);
        defer g.deinit();
        const good = try save(&g, gpa, try g.groupFingerprint());
        defer gpa.free(good);
        const bad = try gpa.dupe(u8, good);
        defer gpa.free(bad);
        // Every byte changed, and then random changes of a few bytes.
        for (0..good.len) |n| for ([_]u8{ 0x01, 0x02, 0x80, 0xff }) |flip| {
            @memcpy(bad, good);
            bad[n] ^= flip;
            try hostile(gpa, bad);
        };
        for (0..3000) |_| {
            @memcpy(bad, good);
            for (0..random.intRangeAtMost(usize, 1, 4)) |_| bad[random.uintLessThan(usize, good.len)] = random.int(u8);
            try hostile(gpa, bad);
        }
    }
}

fn deepSaveValue() !void {
    const gpa = std.testing.allocator;
    const tables: Tables = .{ .objects = &.{}, .functions = &.{} };
    var v = try model.text(gpa, "leaf");
    defer v.release();
    for (0..100_000) |i| {
        const next = if (i % 2 == 0) try model.map(gpa, &.{.{ .key = "x", .value = v }}) else try model.list(gpa, &.{v});
        v.release();
        v = next;
    }
    var names: Names = .{};
    defer names.deinit(gpa);
    var o: Out = .{ .gpa = gpa, .names = &names };
    defer o.bytes.deinit(gpa);
    try writeValue(&o, tables, v);
    var i: In = .{ .bytes = o.bytes.items, .names = names.list.items };
    const copy = try readValue(&i, gpa, tables);
    defer copy.release();
    try std.testing.expectEqual(o.bytes.items.len, i.pos);
    try std.testing.expect(try v.equal(copy));
    // A truncated save is refused, and what was read is freed.
    var cut: In = .{ .bytes = o.bytes.items[0 .. o.bytes.items.len - 1], .names = names.list.items };
    try std.testing.expectError(error.InvalidSave, readValue(&cut, gpa, tables));
}

test "a value nested 100,000 deep saves and restores on a small stack" {
    var result: anyerror!void = {};
    const t = try std.Thread.spawn(.{ .stack_size = 256 * 1024 }, struct {
        fn go(out: *anyerror!void) void {
            out.* = deepSaveValue();
        }
    }.go, .{&result});
    t.join();
    try result;
}

test "shared Map blocks save as ordered values and restore across rollback" {
    const gpa = testing.allocator;
    var group: Group = .init(gpa, null);
    defer group.deinit();
    const source =
        \\script variable values = {}
        \\script variable original = nothing
        \\on edit
        \\  repeat for each i in 1..65
        \\    put i into the (i as text) of values
        \\  end repeat
        \\  put values into original
        \\  put values into values's self
        \\  wait 1 s
        \\  put 99 into the ("32") of values
        \\end edit
        \\on fault
        \\  delete the ("1") of values
        \\  repeat forever
        \\  end repeat
        \\end fault
    ;
    try testing.expect(try group.load("s", source, .{ .limits = .{ .fuel_per_run = 10_000 } }) == .loaded);
    _ = try group.deliver("s", "edit", &.{}, false);
    try group.pump(.{ .seconds = 1790000000, .micros = 0 });
    const saved = try save(&group, gpa, try group.groupFingerprint());
    defer gpa.free(saved);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.full, try restore(&restored, saved, .{}, &result));
    const saved_again = try save(&restored, gpa, try restored.groupFingerprint());
    defer gpa.free(saved_again);
    try testing.expectEqualSlices(u8, saved, saved_again);
    for ([_]*Group{ &group, &restored }) |g| {
        try g.pump(.{ .seconds = 1790000001, .micros = 0 });
        const script = g.script("s").?;
        const values = script.variables[0].retain();
        defer values.release();
        try testing.expectEqual(@as(usize, 66), values.data.map.len);
        try testing.expect(try values.get("self").?.equal(script.variables[1]));
        try testing.expectEqualStrings("1", values.data.map.at(0).key);
        try testing.expectEqualStrings("self", values.data.map.at(65).key);
        try testing.expectEqual(std.math.Order.eq, model.Decimal.order(model.Decimal.fromInt(99), values.get("32").?.data.number));
        _ = try g.deliver("s", "fault", &.{}, false);
        try g.pump(.{ .seconds = 1790000002, .micros = 0 });
        try testing.expect(try values.equal(script.variables[0]));
    }
}

test "Join destination associations require their original frame and member instruction" {
    const gpa = testing.allocator;
    var g: Group = .init(gpa, null);
    defer g.deinit();
    const source = "on go\n wait for all\n  send slow to me into x and wait\n end wait\nend go\non slow\n wait 1 s\n return 1\nend slow";
    try testing.expect(try g.load("s", source, .{}) == .loaded);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(.{ .seconds = 1790000000, .micros = 0 });
    const join = g.script("s").?.live.items[0].join.?;
    const original = join.members.items[0];
    for ([_]bool{ false, true }) |owner| {
        join.members.items[0] = original;
        if (owner) join.members.items[0].frame = 999 else join.members.items[0].start = 0;
        const corrupt = try save(&g, gpa, try g.groupFingerprint());
        defer gpa.free(corrupt);
        var copy: Group = .init(gpa, null);
        defer copy.deinit();
        var result: Result = .{};
        defer result.deinit(gpa);
        try testing.expectError(error.InvalidSave, restore(&copy, corrupt, .{}, &result));
    }
}

test "the State Fingerprint leaves out the save id counter and survives restore (ADR 0142)" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const live = try liveStateFingerprint(&g, gpa);
    const print = try g.groupFingerprint();
    g.saves += 1;
    const first = try save(&g, gpa, print);
    defer gpa.free(first);
    g.saves += 1;
    const second = try save(&g, gpa, print);
    defer gpa.free(second);
    try testing.expect(!std.mem.eql(u8, first, second));
    try testing.expectEqual(live, try stateFingerprint(first));
    try testing.expectEqual(live, try stateFingerprint(second));
    try testing.expectEqual(live, try liveStateFingerprint(&g, gpa));
    try testing.expectEqual(@as(u64, 2), g.saves);
    // Save, restore, save.
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    try testing.expectEqual(Outcome.full, try restore(&restored, first, .{}, &result));
    defer result.deinit(gpa);
    try testing.expectEqual(live, try liveStateFingerprint(&restored, gpa));
    const again = try save(&restored, gpa, print);
    defer gpa.free(again);
    try testing.expectEqual(live, try stateFingerprint(again));
    // One differing Script Variable changes it.
    const a = g.script("a").?;
    const old = a.variables[0];
    a.variables[0] = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(1) });
    const changed = try liveStateFingerprint(&g, gpa);
    a.variables[0].release();
    a.variables[0] = old;
    try testing.expect(!std.mem.eql(u8, &live, &changed));
    try testing.expectEqual(live, try liveStateFingerprint(&g, gpa));
}

test "open Broadcast Decisions and root discards save in key order, so a restore saves the same bytes" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    // Keys put in descending order: a rebuilt hash map iterates them differently.
    var k: u64 = 40;
    while (k > 1) : (k -= 1) {
        const deliveries = try gpa.alloc(u64, 0);
        const parts = try gpa.alloc(?machine.Part, 0);
        try g.open_broadcasts.put(gpa, 1000 + k, .{ .deliveries = deliveries, .parts = parts });
        try g.root_discards.put(gpa, 2000 + k, k);
    }
    const print = try g.groupFingerprint();
    const first = try save(&g, gpa, print);
    defer gpa.free(first);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    try testing.expectEqual(Outcome.full, try restore(&restored, first, .{}, &result));
    defer result.deinit(gpa);
    const again = try save(&restored, gpa, print);
    defer gpa.free(again);
    try testing.expectEqualSlices(u8, first, again);
    try testing.expectEqual(try stateFingerprint(first), try liveStateFingerprint(&restored, gpa));
}

test "the State Fingerprint refuses bytes it can't read and other save formats" {
    const gpa = testing.allocator;
    var g: Group = .init(gpa, null);
    defer g.deinit();
    const bytes = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    try testing.expectError(error.InvalidSave, stateFingerprint(bytes[0..10]));
    // A State Fingerprint that doesn't match the section digests.
    const state = magic.len + 2 + version.language.len + 1 + 32 + 1;
    bytes[state] ^= 1;
    try testing.expectError(error.InvalidSave, stateFingerprint(bytes));
    bytes[state] ^= 1;
    bytes[magic.len] = format_version + 1;
    reseal(bytes);
    try testing.expectError(error.Mismatch, stateFingerprint(bytes));
}

test "a Partial Restore rebuilds only the Scripts whose code changed (ADR 0143)" {
    const gpa = testing.allocator;
    const first = try machine.compileLibrary(gpa, "lib", "1", "function k\n  return 1\nend k\n", &.{}, null);
    defer first.library.destroy();
    const second = try machine.compileLibrary(gpa, "lib", "1", "function k\n  return 2\nend k\n", &.{}, null);
    defer second.library.destroy();
    var g: Group = .init(gpa, null);
    defer g.deinit();
    try g.addLibrary(first.library);
    const a =
        \\use k from lib
        \\script variable n = 10
        \\on go
        \\  put n + k() into n
        \\  wait 5 s
        \\  return n
        \\end go
        \\
    ;
    const b =
        \\script variable m = 0
        \\on tick
        \\  wait 5 s
        \\  put 1 into m
        \\end tick
        \\on query
        \\  send go to a and wait
        \\  put it into m
        \\end query
        \\
    ;
    try testing.expect(try g.load("a", a, .{}) == .loaded);
    try testing.expect(try g.load("b", b, .{}) == .loaded);
    _ = try g.deliver("b", "tick", &.{}, false);
    _ = try g.deliver("b", "query", &.{}, false);
    const start: model.dates.Instant = .{ .seconds = 1790000000, .micros = 0 };
    try g.pump(start);
    try testing.expectEqual(@as(usize, 1), g.script("a").?.live.items.len);
    try testing.expectEqual(@as(usize, 2), g.script("b").?.live.items.len);
    const bytes = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    // The same Library restores in full, and a changed one is refused
    // without a policy.
    for ([_]*Library{ first.library, second.library }) |given| {
        var copy: Group = .init(gpa, null);
        defer copy.deinit();
        var result: Result = .{};
        defer result.deinit(gpa);
        const expected: Outcome = if (given == first.library) .full else .mismatch;
        try testing.expectEqual(expected, try restore(&copy, bytes, .{ .libraries = &.{given} }, &result));
    }
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.partial, try restore(&restored, bytes, .{ .libraries = &.{second.library}, .reload_changed = true }, &result));
    try testing.expectEqual(@as(usize, 1), result.reloaded.len);
    try testing.expectEqualStrings("a", result.reloaded[0]);
    try testing.expectEqual(@as(usize, 1), result.discarded.len);
    try testing.expect(std.mem.startsWith(u8, result.discarded[0], "a/r"));
    const ra = restored.script("a").?;
    const rb = restored.script("b").?;
    try testing.expectEqual(@as(usize, 0), ra.live.items.len);
    try testing.expectEqual(@as(usize, 2), rb.live.items.len);
    // The carried Script Variable, and the sender told `send failed`.
    try testing.expectEqual(@as(i64, 11), try ra.variables[0].data.number.integer(i64));
    try testing.expectEqual(@as(usize, 1), rb.work.items.len);
    // `stop` with reason `reload`, after the discarded Run's report.
    var stops: usize = 0;
    for (restored.reports.list.items) |x| if (x == .stop) {
        stops += 1;
        try testing.expectEqualStrings("a", x.stop.script);
        try testing.expectEqualStrings("reload", x.stop.reason);
        try testing.expectEqual(@as(usize, 1), x.stop.discarded_runs.len);
    };
    try testing.expectEqual(@as(usize, 1), stops);
    // The matched Script's Run goes on, and the changed Script runs its new
    // code.
    try restored.pump(.{ .seconds = start.seconds + 10, .micros = 0 });
    try testing.expectEqual(@as(usize, 0), rb.live.items.len);
    try testing.expectEqual(@as(i64, 1), try rb.variables[0].data.number.integer(i64));
    const asked = try restored.deliver("a", "go", &.{}, true);
    try restored.pump(.{ .seconds = start.seconds + 20, .micros = 0 });
    try restored.pump(.{ .seconds = start.seconds + 30, .micros = 0 });
    try testing.expectEqual(@as(i64, 13), try restored.results.get(asked).?.data.number.integer(i64));
    // Refused at any allocation, it leaves nothing behind.
    const GroupAllocator = @import("group_allocator.zig").GroupAllocator;
    var cap: usize = 1024;
    var finished = false;
    while (!finished) : (cap += 64) {
        var memory: GroupAllocator = .init(gpa, cap);
        defer memory.deinit();
        var copy: Group = .init(memory.allocator(), null);
        defer copy.deinit();
        var partial: Result = .{};
        const outcome = restore(&copy, bytes, .{ .libraries = &.{second.library}, .reload_changed = true }, &partial) catch |e| {
            if (e != error.OutOfMemory) return e;
            continue;
        };
        partial.deinit(memory.allocator());
        try testing.expectEqual(Outcome.partial, outcome);
        finished = true;
    }
}

test "Numbers, Quantities, Ranges, dates and Patterns save as structured values and restore exactly" {
    const gpa = testing.allocator;
    var g: Group = .init(gpa, null);
    defer g.deinit();
    try testing.expect(try g.load("s", "script variable kept = []\non keep x\n  put x after kept\nend keep\n", .{}) == .loaded);
    const exact = try model.Decimal.parse("1.50");
    var made: [9]*Value = undefined;
    made[0] = try model.scalar(gpa, .{ .number = exact });
    made[1] = try model.scalar(gpa, .{ .number = try model.Decimal.parse("-1.5") });
    made[2] = try model.quantity(gpa, try model.Decimal.parse("3"), "inches");
    made[3] = try model.quantity(gpa, try model.Decimal.parse("1"), "inch");
    made[4] = try model.range(gpa, made[0], made[1]);
    made[5] = try model.scalar(gpa, .{ .instant = .{ .seconds = -1, .micros = 5 } });
    made[6] = try model.scalar(gpa, .{ .civil_date = .{ .year = 2026, .month = 10, .day = 28 } });
    made[7] = try model.scalar(gpa, .{ .civil_date = .{ .year = 1, .month = 2, .day = 3, .has_time = true, .hour = 4, .minute = 5, .second = 6, .microsecond = 7 } });
    made[8] = try @import("../pattern.zig").parse(gpa, "<\"ID-\", 4 digits>");
    for (made) |v| {
        var args = [_]*Value{v};
        _ = try g.deliver("s", "keep", &args, false);
    }
    try g.pump(.{ .seconds = 1790000000, .micros = 0 });
    const print = try g.groupFingerprint();
    const bytes = try save(&g, gpa, print);
    defer gpa.free(bytes);
    // `1.50` keeps its exponent: tag 2, not negative, 150, then -2.
    try testing.expect(std.mem.indexOf(u8, bytes, &.{ 2, 0, 0x96, 0x01, 0x7e }) != null);
    // `3 inches`: its Unit as its display form shows it, in `texts`.
    try testing.expect(std.mem.indexOf(u8, bytes, &[_]u8{6} ++ "inches") != null);
    var restored: Group = .init(gpa, null);
    defer restored.deinit();
    var result: Result = .{};
    defer result.deinit(gpa);
    try testing.expectEqual(Outcome.full, try restore(&restored, bytes, .{}, &result));
    const again = try save(&restored, gpa, print);
    defer gpa.free(again);
    try testing.expectEqualSlices(u8, bytes, again);
    var shown: std.Io.Writer.Allocating = .init(gpa);
    defer shown.deinit();
    try display.write(&shown.writer, restored.scripts.items[0].variables[0]);
    try testing.expectEqualStrings("[1.50, -1.5, 3 inches, 1 inch, 1.50..-1.5, 1969-12-31T23:59:59.000005Z, 2026-10-28, 0001-02-03T04:05:06.000007, <\"ID-\", 4 digits>]", shown.written());
}

test "an External-source Snapshot has the same State Fingerprint, and restores only as a missing bundle" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    const bytes = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    // Drop the `sources` section, the last, from the frame.
    const count_at = magic.len + 2 + version.language.len + 1 + 32 + 1 + 32 + 32;
    try testing.expectEqual(@as(u8, 14), bytes[count_at]);
    var i: In = .{ .bytes = bytes, .pos = count_at + 1 };
    for (0..13) |_| {
        i.pos += 2;
        const len = try i.int();
        i.pos += 32 + len;
    }
    try testing.expectEqual(@backingInt(Section.sources), bytes[i.pos]);
    const external = try gpa.dupe(u8, bytes[0..i.pos]);
    defer gpa.free(external);
    external[count_at] = 13;
    reseal(external);
    try testing.expectEqual(try stateFingerprint(bytes), try stateFingerprint(external));
    for ([_]Options{ .{}, .{ .variables_only = true }, .{ .reload_changed = true } }) |options| {
        var restored: Group = .init(gpa, null);
        defer restored.deinit();
        var result: Result = .{};
        try testing.expectEqual(Outcome.mismatch, try restore(&restored, external, options, &result));
    }
}

test "a save's header and section frames follow the save format" {
    const gpa = testing.allocator;
    var g = try busyGroup(gpa);
    defer g.deinit();
    g.name = "lobby";
    const bytes = try save(&g, gpa, try g.groupFingerprint());
    defer gpa.free(bytes);
    try testing.expectEqualStrings("NTSV", bytes[0..4]);
    try testing.expectEqual(@as(u8, 1), bytes[4]);
    const header = try readFrame(bytes, true);
    for (header.bodies[1..], 1..) |b, t| try testing.expect(b != null or t > @backingInt(Section.sources));
    // The Group's name leads the `group` section.
    try testing.expectEqualStrings("\x05lobby", header.bodies[@backingInt(Section.group)].?[0..6]);
    // An unknown optional section is skipped; an unknown required one is
    // refused.
    for ([_]u8{ 1, 0 }) |flags| {
        var more: std.ArrayList(u8) = .empty;
        defer more.deinit(gpa);
        try more.appendSlice(gpa, bytes);
        try more.appendSlice(gpa, &.{ 200, flags, 0 });
        try more.appendSlice(gpa, &@as([32]u8, @splat(0)));
        const count_at = magic.len + 2 + version.language.len + 1 + 32 + 1 + 32 + 32;
        more.items[count_at] += 1;
        reseal(more.items);
        var restored: Group = .init(gpa, null);
        defer restored.deinit();
        var result: Result = .{};
        if (flags == 1) {
            try testing.expectEqual(Outcome.full, try restore(&restored, more.items, .{}, &result));
            result.deinit(gpa);
        } else try testing.expectError(error.InvalidSave, restore(&restored, more.items, .{}, &result));
    }
}

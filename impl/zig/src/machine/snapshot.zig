//! Save and restore (chapter 10): the Zig Core's own save format, which only
//! the Zig Core reads (ADR 0008).
//!
//! A save is a header, the Group's state as plain data, and the SHA-256 of
//! everything before it. The state holds every Library by identity, every
//! Script by its sources and its values, every Run with its frames, error
//! control and wait, and the Group's queues and counters. Code is never
//! saved: a restore compiles each Script's sources again, against the
//! Libraries the Host passes, and checks them against the save before it
//! trusts a single code position. Pointers between parts are indices, and
//! the internal values a dispatch activation shares (iterators, readers and
//! replacements) are saved once and referred to after.
const std = @import("std");
const sorting = @import("../sort.zig");
const Allocator = std.mem.Allocator;
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

const magic = "NTZS";
/// The save format this Core reads and writes; it reads no other.
pub const format_version: u32 = 15;

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

    fn byte(o: *Out, b: u8) !void {
        try o.bytes.append(o.gpa, b);
    }

    /// An unsigned LEB128 integer.
    pub fn int(o: *Out, v: u64) !void {
        var x = v;
        while (true) {
            const low: u8 = @intCast(x & 0x7f);
            x >>= 7;
            if (x == 0) return o.byte(low);
            try o.byte(low | 0x80);
        }
    }

    fn signed(o: *Out, v: i256) !void {
        var buf: [32]u8 = undefined;
        std.mem.writeInt(i256, &buf, v, .little);
        try o.bytes.appendSlice(o.gpa, &buf);
    }

    fn instant(o: *Out, t: model.dates.Instant) !void {
        try o.signed(t.seconds);
        try o.int(@intCast(t.micros));
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

    /// An optional index, as 0 for none and the index plus 1 otherwise.
    pub fn ref(o: *Out, i: ?usize) !void {
        try o.int(if (i) |x| x + 1 else 0);
    }
};

/// A save being read. Every read is checked, so bytes that run short or
/// say something impossible are `invalid save`, never a crash.
const In = struct {
    bytes: []const u8,
    pos: usize = 0,

    fn byte(i: *In) Error!u8 {
        if (i.pos >= i.bytes.len) return error.InvalidSave;
        i.pos += 1;
        return i.bytes[i.pos - 1];
    }

    /// An integer no counter, id or charge of a real save comes near, so
    /// the machine's arithmetic on it never overflows.
    pub fn int(i: *In) Error!u64 {
        const v = try i.wide();
        if (v > 1 << 56) return error.InvalidSave;
        return v;
    }

    fn wide(i: *In) Error!u64 {
        var out: u64 = 0;
        var shift: u7 = 0;
        while (true) {
            const b = try i.byte();
            if (shift == 63 and b > 1) return error.InvalidSave;
            out |= @as(u64, b & 0x7f) << @intCast(shift);
            if (b & 0x80 == 0) return out;
            shift += 7;
            if (shift > 63) return error.InvalidSave;
        }
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

    fn signed(i: *In) Error!i256 {
        if (i.bytes.len - i.pos < 32) return error.InvalidSave;
        const v = std.mem.readInt(i256, i.bytes[i.pos..][0..32], .little);
        i.pos += 32;
        return v;
    }

    fn instant(i: *In) Error!model.dates.Instant {
        const seconds = std.math.cast(i64, try i.signed()) orelse return error.InvalidSave;
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
};

// ---------------------------------------------------------------- values

const Tag = enum(u8) { nothing, bool, text, bytes, list, map, function, object, shown };

/// What a save's values refer to: Host Objects and Function Value code, by
/// their index in the save.
const Tables = struct {
    objects: []const *objects.Object,
    functions: []const *machine.FunctionCode,

    fn objectIndex(t: Tables, identity: usize) ?usize {
        for (t.objects, 0..) |o, i| if (@intFromPtr(o) == identity) return i;
        return null;
    }

    fn functionIndex(t: Tables, identity: usize) ?usize {
        for (t.functions, 0..) |f, i| if (@intFromPtr(f) == identity) return i;
        return null;
    }
};

/// One step of writing a value: a value, or a map key before its value.
const WriteStep = union(enum) { value: *const Value, key: []const u8 };

/// A Script value. Containers push their children on a heap work list, so
/// a deep value never deepens the native stack.
fn writeValue(o: *Out, t: Tables, root: *const Value) !void {
    var steps: std.ArrayList(WriteStep) = .empty;
    defer steps.deinit(o.gpa);
    try steps.append(o.gpa, .{ .value = root });
    while (steps.pop()) |step| {
        const v = switch (step) {
            .key => |k| {
                try o.str(k);
                continue;
            },
            .value => |v| v,
        };
        var flags: u8 = 0;
        if (v.core_message) flags |= 1;
        if (v.script_name) flags |= 2;
        switch (v.data) {
            .nothing => try o.byte(@backingInt(Tag.nothing)),
            .bool => |b| {
                try o.byte(@backingInt(Tag.bool));
                try o.flag(b);
            },
            .text => |s| {
                try o.byte(@backingInt(Tag.text));
                try o.byte(flags);
                try o.str(s);
            },
            .bytes => |s| {
                try o.byte(@backingInt(Tag.bytes));
                try o.str(s);
            },
            .list => |items| {
                try o.byte(@backingInt(Tag.list));
                try o.int(items.len);
                try steps.ensureUnusedCapacity(o.gpa, items.len);
                var i = items.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = items[i] });
                }
            },
            .map => |pairs| {
                try o.byte(@backingInt(Tag.map));
                try o.byte(flags);
                try o.int(pairs.len);
                try steps.ensureUnusedCapacity(o.gpa, 2 * pairs.len);
                var i = pairs.len;
                while (i > 0) {
                    i -= 1;
                    steps.appendAssumeCapacity(.{ .value = pairs.at(i).value });
                    steps.appendAssumeCapacity(.{ .key = pairs.at(i).key });
                }
            },
            .function => |f| {
                try o.byte(@backingInt(Tag.function));
                // A value this Group didn't make is gone: none of its code.
                try o.ref(t.functionIndex(f.identity));
                try o.str(f.display);
                try o.str(f.home);
                try steps.append(o.gpa, .{ .value = f.captures });
            },
            .object => |x| {
                try o.byte(@backingInt(Tag.object));
                try o.int(t.objectIndex(x.identity) orelse return error.OutOfMemory);
            },
            // Numbers, Quantities, ranges, Instants, dates and Text Patterns
            // round-trip through the display form.
            else => {
                try o.byte(@backingInt(Tag.shown));
                var shown: std.Io.Writer.Allocating = .init(o.gpa);
                defer shown.deinit();
                display.write(&shown.writer, v) catch return error.OutOfMemory;
                try o.str(shown.written());
            },
        }
    }
}

/// A container whose children are still being read.
const Reading = struct {
    kind: union(enum) {
        list,
        map: u8,
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
                if (top.kind == .map) try top.keys.append(gpa, try i.str());
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

/// Reads a leaf, an empty container, or opens a container and returns null.
fn readOne(i: *In, gpa: Allocator, t: Tables, stack: *std.ArrayList(Reading)) Error!?*Value {
    const tag = std.enums.fromInt(Tag, try i.byte()) orelse return error.InvalidSave;
    return switch (tag) {
        .nothing => model.scalar(gpa, .nothing),
        .bool => model.scalar(gpa, .{ .bool = try i.flag() }),
        .text => blk: {
            const flags = try i.byte();
            if (flags > 3) return error.InvalidSave;
            const v = model.text(gpa, try i.str()) catch |e| return valueError(e);
            v.core_message = flags & 1 != 0;
            v.script_name = flags & 2 != 0;
            break :blk v;
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
                v.core_message = flags & 1 != 0;
                v.script_name = flags & 2 != 0;
                break :blk v;
            }
            try stack.append(gpa, .{ .kind = .{ .map = flags }, .len = n });
            const top = &stack.items[stack.items.len - 1];
            try top.keys.append(gpa, try i.str());
            break :blk null;
        },
        .function => blk: {
            const code = try i.ref(t.functions.len);
            const shown = try i.str();
            const home = try i.str();
            try stack.append(gpa, .{ .kind = .{ .function = .{ .code = code, .shown = shown, .home = home } }, .len = 1 });
            break :blk null;
        },
        .object => t.objects[try i.index(t.objects.len)].value.retain(),
        .shown => blk: {
            const v = display.parse(gpa, try i.str(), .{}) catch |e| return valueError(e);
            switch (v.data) {
                .number, .quantity, .range, .instant, .civil_date, .pattern => {},
                else => {
                    v.release();
                    return error.InvalidSave;
                },
            }
            break :blk v;
        },
    };
}

/// A mathematical deadline, which may lie outside the Instant range.
fn deadline(i: *In) Error!machine.DeadlineTicks {
    const at = try i.signed();
    // A 34-digit base duration scaled to microseconds, plus a Clock.
    if (at != @import("waits.zig").never and @abs(at) > 10000000000000000000000000000000000000000 + 253402300800000000) return error.InvalidSave;
    return at;
}

fn duration(i: *In) Error!machine.DeadlineTicks {
    const us = try i.signed();
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

    fn deinit(s: *Saving) void {
        const gpa = s.o.gpa;
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
            return s.o.str(l.name);
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
        try s.o.str(f.code);
        try s.o.optStr(f.message);
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
            .broken, .timeout, .woke, .joined, .unparked, .cancelled, .lost, .limited, .revoked => {},
        }
    }

    fn waited(s: *Saving, w: machine.Waited) !void {
        try s.o.str(w.id);
        try s.o.flag(w.block);
        try s.call(w.call);
        try s.o.str(w.grant);
        try s.o.str(w.operation);
        try s.o.flag(w.decl != null);
        try s.o.signed(w.after_us);
    }

    fn pending(s: *Saving, run: *const Run, p: ?*const Pending) !void {
        const x = p orelse return s.o.flag(false);
        try s.o.flag(true);
        try s.o.str(x.id);
        try s.o.signed(x.deadline);
        try s.o.int(x.order);
        try s.call(x.call);
        try s.o.str(x.grant);
        try s.o.str(x.operation);
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
        try s.o.str(d.message);
        try s.values(d.args);
        try s.o.flag(d.request);
        try optValue(&s.o, s.tables, d.during);
        try s.o.optStr(d.from);
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
        inline for (@typeInfo(machine.Limits).@"struct".field_names) |f| try s.o.int(@field(l, f));
    }

    fn oneRun(s: *Saving, r: *const Run) !void {
        try s.o.str(r.id);
        try s.o.int(r.order);
        try s.o.flag(r.reported_fuel != null);
        if (r.reported_fuel) |f| try s.o.int(f);
        try s.o.int(r.fuel);
        try s.o.int(r.alloc);
        try s.delivery(r.delivery);
        try s.o.str(r.handler);
        try s.o.int(r.clause);
        try s.limits(r.limits);
        try s.o.int(r.clause_fuel);
        try s.o.flag(r.preempted_in != null);
        if (r.preempted_in) |p| {
            try s.unit(r.script, p.library);
            try s.o.int(p.body);
            try s.o.flag(p.fallback);
        }
        try s.o.flag(r.continuing);
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
        try s.o.str(r.suspended_at);
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
            try s.o.int(b);
            try s.unit(r.script, r.clause_unit);
        }
        try s.o.flag(r.fallback);
        try s.o.flag(r.select_at != null);
        if (r.select_at) |x| try s.o.int(x);
        try s.o.flag(r.parked);
        try s.o.int(r.abandoned.items.len);
        for (r.abandoned.items) |id| try s.o.str(id);
        try s.o.int(r.base);
        try s.o.int(r.segments);
        try s.o.flag(r.verdict);
        try s.o.flag(r.segment_base != null);
        if (r.segment_base) |b| try s.values(b);
        try s.frames(r, r.frames.items);
    }

    fn mark(s: *Saving, m: machine.Mark) !void {
        try s.o.str(m.script);
        try s.o.str(m.run);
        try optValue(&s.o, s.tables, m.reason);
        try s.o.str(m.outcome);
    }

    fn input(s: *Saving, x: machine.Input) !void {
        try s.o.byte(@backingInt(std.meta.activeTag(x)));
        switch (x) {
            .charge_request => return error.EffectsPending,
            .deliver => |d| {
                try s.o.str(d.script);
                try s.delivery(d.delivery);
            },
            .set_parent => |p| {
                try s.object(p.object);
                try s.object(p.parent);
            },
            .dispose => |o| try s.object(o),
            .settle => |st| {
                try s.o.str(st.id);
                try s.resumeWith(st.with);
            },
            .broadcast => |b| {
                try s.o.int(b.id);
                try s.o.str(b.message);
                try s.values(b.args);
                try s.o.flag(b.decision);
                try s.override(b.limits);
                // Recipients are found as the queue is drained, so a queued
                // Broadcast has none yet.
            },
            .revoke => |r| {
                try s.o.str(r.script);
                try s.o.str(r.grant);
            },
            .cancel_run, .rewind_run => |id| try s.o.str(id),
            .stop => |st| {
                try s.o.str(st.script);
                try s.o.str(st.reason);
            },
            .cancel_delivery, .cancel_broadcast => |id| try s.o.int(id),
            // A settlement is queued only after a restore, before the
            // first Pump; a save then would hold the restored calls again.
            .settlement => |st| {
                try s.o.str(st.id);
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

/// The save's bytes, which `gpa` owns. Saving changes nothing in the Group
/// but its save id counter, which the caller has already advanced.
pub fn save(g: *Group, gpa: Allocator, print: [32]u8) ![]u8 {
    if (effectsPending(g)) return error.EffectsPending;
    g.input_lock.lock();
    defer g.input_lock.unlock();
    for (g.charge_requests.items) |q| if (!q.done.load(.acquire)) return error.EffectsPending;
    var s: Saving = .{ .o = .{ .gpa = gpa }, .g = g, .tables = .{ .objects = g.objects.items, .functions = g.functions.items }, .waits = try g.waits.exportState(gpa, g.liveRuns()) };
    defer s.deinit();
    errdefer s.o.bytes.deinit(gpa);
    const o = &s.o;
    try o.bytes.appendSlice(gpa, magic);
    try o.int(format_version);
    try o.str(version.language);
    try o.int(cost_model.version);
    try o.bytes.appendSlice(gpa, &print);
    try o.int(g.saves);
    try o.instant(g.clock);
    try o.int(g.deliveries);
    try o.int(g.broadcasts);
    try o.int(s.waits.table.timers);
    try o.int(g.run_order);
    try o.int(g.charge_counter);
    try o.int(g.random_state);
    try s.waits.writeIssued(gpa, o);
    // Libraries, by identity.
    try o.int(g.libraries.items.len);
    for (g.libraries.items) |l| {
        try o.str(l.name);
        try o.str(l.version);
        try o.bytes.appendSlice(gpa, &l.identity);
    }
    // Host Objects, by kind and id; a parent comes by index.
    try o.int(g.objects.items.len);
    for (g.objects.items) |x| {
        try o.str(x.kind.name);
        try o.str(x.id);
        try s.object(x.parent);
        try o.flag(x.disposed);
        try o.optStr(x.owner_of);
    }
    // Function Value code: a stale value's keeps only what it still
    // answers.
    try o.int(g.functions.items.len);
    for (g.functions.items) |f| {
        try o.str(f.home);
        try o.str(f.name);
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
    // The calls a Run still waits on, with their arguments.
    try o.int(s.waits.calls.items.len);
    for (s.waits.calls.items) |c| {
        try o.str(c.id);
        try o.str(c.script);
        try o.str(c.grant);
        try o.str(c.run);
        try o.str(c.segment);
        try o.instant(c.now);
        try s.values(c.args);
        try o.int(c.charged);
    }
    // Each Script, in load order.
    try o.int(g.scripts.items.len);
    for (g.scripts.items) |x| {
        try o.str(x.name);
        try o.bytes.appendSlice(gpa, &x.identity);
        try o.str(x.source);
        try o.int(x.extensions.items.len);
        for (x.extensions.items) |e| try o.str(e.source);
        try s.limits(x.limits);
        try o.int(x.grants.len);
        for (x.grants) |sg| {
            try o.str(sg.name);
            const json = sg.declarations orelse try fingerprint.grantJson(gpa, sg.grant.capability, sg.kept);
            defer if (sg.declarations == null) gpa.free(json);
            try o.str(json);
            // The kept Operations, with what a Grant the restore can't
            // re-bind still needs for checking code against.
            try o.str(sg.grant.capability.name);
            var kept: usize = 0;
            for (sg.kept) |k| kept += @intFromBool(k);
            try o.int(kept);
            for (sg.grant.capability.operations, sg.kept) |op, k| if (k) {
                try o.str(op.name);
                try o.byte(@backingInt(op.mode));
                try o.int(op.required());
                try o.int(op.args.len);
                try o.flag(op.command);
                try o.int(op.labels.len);
                for (op.labels) |l| try o.str(l);
            };
            try o.flag(sg.revoked);
            try o.flag(sg.disabled);
        }
        try s.object(x.owner);
        try o.int(x.objects.len);
        for (x.objects) |n| {
            try o.str(n.name);
            try s.object(n.object);
        }
        try o.int(x.variableNames().len);
        for (x.variableNames()) |n| try o.str(n);
        try s.values(x.variables);
        try s.values(x.definitions);
        for (x.extensions.items) |e| try s.values(e.definitions);
        try o.int(x.runs);
        try o.int(x.fuel_total);
        try o.int(x.alloc_total);
        try o.int(x.faults);
        try o.int(x.debt);
        try o.optStr(x.stopped);
    }
    // Every Run, Script by Script, in each one's live order.
    for (g.scripts.items) |x| try s.runs.appendSlice(gpa, x.live.items);
    for (g.scripts.items) |x| {
        try o.int(x.live.items.len);
        for (x.live.items) |r| try s.oneRun(r);
    }
    // Each Script's work, in order.
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
    // The waits with deadlines, in the order they were set: each by its Run
    // and, for a Join Member, its member.
    try s.waits.writeOrder(o, s.runs.items);
    try o.int(g.ids.items.len);
    for (g.ids.items) |id| try o.str(id);
    try o.int(g.inputs.items.len);
    for (g.inputs.items) |x| try s.input(x);
    // Broadcast Decisions some recipient hasn't sealed.
    try o.int(g.open_broadcasts.count());
    var open = g.open_broadcasts.iterator();
    while (open.next()) |e| {
        try o.int(e.key_ptr.*);
        try o.int(e.value_ptr.deliveries.len);
        for (e.value_ptr.deliveries, e.value_ptr.parts) |d, part| {
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
    // Decisions a variables-only restore left for the first Pump.
    try o.int(g.deferred.items.len);
    for (g.deferred.items) |x| {
        try o.int(x.id);
        try o.int(x.broadcast);
        try o.flag(x.mark != null);
        if (x.mark) |m| try s.mark(m);
    }
    // Run accounting: each root's discarded messages, and the roots whose
    // work changed since the last report (chapter 9, Run accounting).
    try o.int(g.root_discards.count());
    var discards = g.root_discards.iterator();
    while (discards.next()) |e| {
        try o.int(e.key_ptr.*);
        try o.int(e.value_ptr.*);
    }
    try o.int(g.changed_roots.count());
    for (g.changed_roots.keys()) |root| try o.int(root);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(o.bytes.items, &digest, .{});
    try o.bytes.appendSlice(gpa, &digest);
    return o.bytes.toOwnedSlice(gpa);
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
};

pub const Outcome = enum { full, variables_only, mismatch };

/// What a restore reports beside its Group: the Host Objects that didn't
/// resolve, which `gpa` owns; the pending calls are the Group's
/// `restored.pending`.
pub const Result = struct {
    disposed: []*objects.Object = &.{},
    /// For a variables-only restore, what it discarded, by id.
    discarded: []const []const u8 = &.{},
    dropped: []const []const u8 = &.{},
    abandoned: []const []const u8 = &.{},

    pub fn deinit(x: *Result, gpa: Allocator) void {
        gpa.free(x.disposed);
        gpa.free(x.discarded);
        gpa.free(x.dropped);
        gpa.free(x.abandoned);
    }
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
    iterators: std.ArrayList(*machine.Iterator) = .empty,
    readers: std.ArrayList(*binary.Reader) = .empty,
    replacements: std.ArrayList(*machine.Replacement) = .empty,
    /// The Grants the Host didn't re-bind, as `<script>.<name>`.
    unbound: std.ArrayList([]const u8) = .empty,
    mismatch: bool = false,
    /// A variables-only restore reads Runs only to discard them, against
    /// code that may no longer match: no code position is trusted or used.
    skim: bool = false,
    /// Each unit's stack shapes, made once.
    shapes: std.AutoHashMapUnmanaged(*const lower.Unit, verify.Shapes) = .empty,
    shape_arena: ?std.heap.ArenaAllocator = null,

    fn gpa(r: *Restoring) Allocator {
        return r.g.gpa;
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
                .stdlib => _ = try r.i.str(),
            }
            return null;
        }
        return switch (tag) {
            .own => null,
            .extension => s.extensions.items[try r.i.index(s.extensions.items.len)],
            .library => r.libraries[try r.i.index(r.libraries.len)] orelse error.InvalidSave,
            .stdlib => machine.stdlibLibrary(try r.i.str()) orelse error.InvalidSave,
        };
    }

    /// A Script's limits, which the Host set, and may set high.
    fn limits(r: *Restoring) Error!machine.Limits {
        var l: machine.Limits = .{};
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
        var d: machine.Delivery = .{ .id = id, .root = root, .message = try r.owned(), .args = &.{}, .request = false };
        errdefer r.g.releaseDelivery(d);
        d.args = try r.values();
        d.request = try r.i.flag();
        d.during = try r.optValue();
        if (try r.i.optStr()) |x| d.from = try a.dupe(u8, x);
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
        const code = try r.owned();
        errdefer a.free(code);
        const message = if (try r.i.optStr()) |m| try a.dupe(u8, m) else null;
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
            inline .broken, .timeout, .woke, .joined, .unparked, .cancelled, .lost, .limited, .revoked => |x| x,
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
        var w: machine.Waited = .{ .id = try r.kept() };
        w.block = try r.i.flag();
        w.call = try r.call();
        w.grant = try r.kept();
        w.operation = try r.kept();
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
        p.id = try r.kept();
        p.deadline = try deadline(&r.i);
        p.order = try r.i.int();
        p.call = try r.call();
        p.grant = try r.kept();
        p.operation = try r.kept();
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
        const id = try r.owned();
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
        const handler = try r.i.str();
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
        x.continuing = try r.i.flag();
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
        x.suspended_at = try r.kept();
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
            const body = try r.i.small(u32);
            const library = try r.unit(s);
            if (!r.skim and body >= s.unitIn(library).bodies.len) return error.InvalidSave;
            x.clause_body = body;
            x.clause_unit = library;
        }
        x.fallback = try r.i.flag();
        if (try r.i.flag()) x.select_at = try r.i.small(u32);
        x.parked = try r.i.flag();
        const abandoned = try r.i.count();
        for (0..abandoned) |_| try x.abandoned.append(a, try r.kept());
        x.base = try r.i.small(usize);
        x.segments = try r.i.small(u32);
        x.verdict = try r.i.flag();
        if (try r.i.flag()) {
            const base = try r.values();
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
            } else if (!run.continuing and f.pc > 0) {
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
        const t = std.enums.fromInt(Tag3, try r.i.byte()) orelse return error.InvalidSave;
        return switch (t) {
            .charge_request => error.InvalidSave,
            .deliver => blk: {
                const script = try r.owned();
                errdefer a.free(script);
                break :blk .{ .deliver = .{ .script = script, .delivery = try r.delivery() } };
            },
            .set_parent => .{ .set_parent = .{ .object = try r.object() orelse return error.InvalidSave, .parent = try r.object() } },
            .dispose => .{ .dispose = try r.object() orelse return error.InvalidSave },
            .settle => blk: {
                const id = try r.owned();
                errdefer a.free(id);
                break :blk .{ .settle = .{ .id = id, .with = try r.resumeWith() orelse return error.InvalidSave } };
            },
            .broadcast => blk: {
                const id = try r.i.int();
                const message = try r.owned();
                errdefer a.free(message);
                const args = try r.values();
                errdefer machine.releaseValues(args, a);
                break :blk .{ .broadcast = .{ .id = id, .message = message, .args = args, .decision = try r.i.flag(), .limits = try r.override() } };
            },
            .revoke => blk: {
                const script = try r.owned();
                errdefer a.free(script);
                break :blk .{ .revoke = .{ .script = script, .grant = try r.owned() } };
            },
            .cancel_run => .{ .cancel_run = try r.owned() },
            .rewind_run => .{ .rewind_run = try r.owned() },
            .stop => blk: {
                const script = try r.owned();
                errdefer a.free(script);
                break :blk .{ .stop = .{ .script = script, .reason = try r.owned() } };
            },
            .cancel_delivery => .{ .cancel_delivery = try r.i.int() },
            .cancel_broadcast => .{ .cancel_broadcast = try r.i.int() },
            // A save is taken before any settlement is drained, and a
            // restored Group's settlements are its own.
            .settlement => error.InvalidSave,
        };
    }

    fn mark(r: *Restoring) Error!machine.Mark {
        const a = r.gpa();
        const script = try r.owned();
        errdefer a.free(script);
        const run_id = try r.owned();
        errdefer a.free(run_id);
        const reason = try r.optValue();
        errdefer if (reason) |v| v.release();
        return .{ .script = script, .run = run_id, .reason = reason, .outcome = try r.kept() };
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
    source: []const u8,
    extensions: []const []const u8,
    limits: machine.Limits,
    grants: []machine.ScriptGrant,
    effects: bool,
    owner: ?*objects.Object,
    objects: []machine.NamedObject,
    variable_names: []const []const u8,
    variables: []*Value,
    definitions: []*Value,
    extension_definitions: [][]*Value,
    runs: u64,
    fuel_total: u64,
    alloc_total: u64,
    faults: u64,
    debt: u64,
    stopped: ?[]const u8,

    fn release(x: *Saved, gpa: Allocator) void {
        machine.releaseValues(x.variables, gpa);
        machine.releaseValues(x.definitions, gpa);
        for (x.extension_definitions) |d| machine.releaseValues(d, gpa);
        gpa.free(x.extension_definitions);
        x.variables = &.{};
        x.definitions = &.{};
        x.extension_definitions = &.{};
    }
};

/// Reads a Script's saved state, re-binding its Grants: each the Host
/// returns must match its saved declarations, and each it doesn't is kept
/// revoked with them.
fn readSaved(r: *Restoring, out: *Saved) Error!void {
    const a = r.gpa();
    const k = r.keep();
    const i = &r.i;
    out.* = .{ .name = "", .source = "", .extensions = &.{}, .limits = .{}, .grants = &.{}, .effects = false, .owner = null, .objects = &.{}, .variable_names = &.{}, .variables = &.{}, .definitions = &.{}, .extension_definitions = &.{}, .runs = 0, .fuel_total = 0, .alloc_total = 0, .faults = 0, .debt = 0, .stopped = null };
    errdefer out.release(a);
    out.name = try r.kept();
    if (i.bytes.len - i.pos < 32) return error.InvalidSave;
    i.pos += 32;
    out.source = try r.kept();
    const extensions = try k.alloc([]const u8, try i.count());
    for (extensions) |*x| x.* = try r.kept();
    out.extensions = extensions;
    out.limits = try r.limits();
    const grants = try k.alloc(machine.ScriptGrant, try i.count());
    for (grants) |*sg| {
        const saved: SavedGrant = blk: {
            const name = try r.kept();
            const json = try r.kept();
            const capability = try r.kept();
            const ops = try k.alloc(SavedOperation, try i.count());
            for (ops) |*o| {
                o.name = try r.kept();
                o.mode = std.enums.fromInt(capabilities.Mode, try i.byte()) orelse return error.InvalidSave;
                o.required = try i.small(usize);
                o.total = try i.small(usize);
                o.command = try i.flag();
                const labels = try k.alloc([]const u8, try i.count());
                for (labels) |*l| l.* = try r.kept();
                o.labels = labels;
            }
            break :blk .{ .name = name, .json = json, .capability = capability, .ops = ops, .revoked = try i.flag(), .disabled = try i.flag() };
        };
        const rebound: ?*capabilities.Grant = if (r.options.grants) |x| x.call(x.context, out.name, saved.name) else null;
        if (rebound) |grant| {
            // Only the saved Operations, whose declarations must match.
            const kept = try k.alloc(bool, grant.capability.operations.len);
            @memset(kept, false);
            for (saved.ops) |o| {
                const at = grant.capability.find(o.name) orelse {
                    r.mismatch = true;
                    continue;
                };
                if (!grant.operations[at]) r.mismatch = true;
                kept[at] = true;
            }
            if (!std.mem.eql(u8, grant.capability.name, saved.capability)) r.mismatch = true;
            const json = try fingerprint.grantJson(a, grant.capability, kept);
            defer a.free(json);
            if (!std.mem.eql(u8, json, saved.json)) r.mismatch = true;
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
    for (named) |*x| x.* = .{ .name = try r.kept(), .object = try r.object() orelse return error.InvalidSave };
    out.objects = named;
    const names = try k.alloc([]const u8, try i.count());
    for (names) |*x| x.* = try r.kept();
    out.variable_names = names;
    out.variables = try r.values();
    if (out.variables.len != names.len) return error.InvalidSave;
    out.definitions = try r.values();
    out.extension_definitions = try a.alloc([]*Value, extensions.len);
    @memset(out.extension_definitions, &.{});
    for (out.extension_definitions) |*d| d.* = try r.values();
    out.runs = try i.int();
    out.fuel_total = try i.int();
    out.alloc_total = try i.int();
    out.faults = try i.int();
    out.debt = try i.int();
    out.stopped = if (try i.optStr()) |x| try k.dupe(u8, x) else null;
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
    if (saved.definitions.len != s.unit.definitions.len) return error.InvalidSave;
    if (saved.extension_definitions.len != s.extensions.items.len) return error.InvalidSave;
    for (saved.extension_definitions, s.extensions.items) |d, x| if (d.len != x.unit.definitions.len) return error.InvalidSave;
    const a = r.gpa();
    machine.releaseValues(s.variables, a);
    machine.releaseValues(s.definitions, a);
    s.variables = saved.variables;
    s.definitions = saved.definitions;
    for (saved.extension_definitions, s.extensions.items) |d, x| x.definitions = d;
    a.free(saved.extension_definitions);
    saved.variables = &.{};
    saved.definitions = &.{};
    saved.extension_definitions = &.{};
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
    if (bytes.len < magic.len + 32) return error.InvalidSave;
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes[0 .. bytes.len - 32], &digest, .{});
    if (!std.mem.eql(u8, &digest, bytes[bytes.len - 32 ..])) return error.InvalidSave;
    var r: Restoring = .{ .i = .{ .bytes = bytes[0 .. bytes.len - 32] }, .g = g, .options = options, .tables = undefined, .libraries = &.{} };
    defer r.deinit();
    const i = &r.i;
    const a = g.gpa;
    if (!std.mem.eql(u8, bytes[0..magic.len], magic)) return error.InvalidSave;
    i.pos = magic.len;
    if (try i.int() != format_version) return error.InvalidSave;
    const language = try i.str();
    const costs_version = try i.int();
    if (i.bytes.len - i.pos < 32) return error.InvalidSave;
    const saved_print = i.bytes[i.pos..][0..32].*;
    i.pos += 32;
    g.saves = try i.int();
    g.clock = try i.instant();
    g.deliveries = try i.int();
    g.broadcasts = try i.int();
    g.waits.importTimers(try i.int());
    g.run_order = try i.int();
    g.charge_counter = try i.int();
    g.random_state = try i.wide();
    try g.waits.importIssued(a, i);
    if (!std.mem.eql(u8, language, version.language) or costs_version != cost_model.version) r.mismatch = true;
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
        const name = try i.str();
        _ = try i.str();
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
    const object_count = try i.count();
    const parents = try a.alloc(?usize, object_count);
    defer a.free(parents);
    for (parents) |*parent| {
        const kind_name = try i.str();
        const kind: *const objects.Kind = (if (options.kinds) |k| k.call(k.context, kind_name) else null) orelse blk: {
            // A kind the Core no longer defines: its objects can only be
            // disposed.
            const k = try g.keep.allocator().create(objects.Kind);
            k.* = .{ .name = try g.keep.allocator().dupe(u8, kind_name), .props = &.{} };
            break :blk k;
        };
        const id = try i.str();
        for (g.objects.items) |x| if (std.mem.eql(u8, x.kind.name, kind.name) and std.mem.eql(u8, x.id, id)) return error.InvalidSave;
        const o = objects.Object.make(a, kind, id, null) catch |e| return valueError(e);
        g.objects.append(a, o) catch |e| {
            o.destroy(a);
            return e;
        };
        parent.* = try i.ref(object_count);
        o.disposed = try i.flag();
        if (try i.optStr()) |x| o.owner_of = try a.dupe(u8, x);
    }
    for (g.objects.items, parents) |o, p| {
        if (p) |x| o.parent = g.objects.items[x];
    }
    for (g.objects.items) |o| if (o.wouldCycle(o.parent)) return error.InvalidSave;
    // Function Value code; a live one's unit is placed once the Scripts
    // are built.
    const code_count = try i.count();
    const Place = struct { tag: UnitTag = .own, index: usize = 0, name: []const u8 = "", body: u32 = 0, live: bool = false };
    const places = try a.alloc(Place, code_count);
    defer a.free(places);
    for (places) |*place| {
        const home_text = try i.str();
        const name_text = try i.str();
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
                .stdlib => place.name = try i.str(),
            }
            place.body = try i.small(u32);
        }
    }
    r.tables = .{ .objects = g.objects.items, .functions = g.functions.items };
    // The calls Runs wait on.
    const calls = try a.alloc(*capabilities.Call, try i.count());
    defer a.free(calls);
    for (calls) |*c| {
        const x = try g.waits.importCall(a, try i.str(), .{ .clock = g.clock, .group = g, .owner = g });
        x.script = try r.kept();
        x.grant = try r.kept();
        x.run = try r.kept();
        // The Segment which established the wait, within the Call's Run.
        x.segment = try r.kept();
        if (!std.mem.startsWith(u8, x.segment, x.run) or !std.mem.startsWith(u8, x.segment[x.run.len..], ".s")) return error.InvalidSave;
        x.now = try i.instant();
        model.dates.validateInstant(x.now) catch return error.InvalidSave;
        if (machine.micros(x.now) > machine.micros(g.clock)) return error.InvalidSave;
        x.args = try r.values();
        x.charged = try i.int();
        c.* = x;
    }
    r.calls = calls;
    // The Scripts, read whole, then compiled again as first compiled.
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
    for (saved) |*x| if (!try buildSaved(&r, x)) {
        r.mismatch = true;
        break;
    };
    // Versions: the Fingerprint of what this Group now is.
    if (!r.mismatch and !std.mem.eql(u8, &(try g.groupFingerprint()), &saved_print)) r.mismatch = true;
    if (r.mismatch and !options.variables_only) {
        if (g.trace) |w| {
            w.print("> restore from=s{d}", .{g.saves}) catch {};
            writeIds(w, "unbound", r.unbound.items);
            writeIds(w, "withheld", withheld.items);
            w.print(" fingerprint={x} mode=variables-only\nrefused code=\"save mismatch\"\n", .{saved_print}) catch {};
        }
        return .mismatch;
    }
    const variables_only = r.mismatch;
    if (variables_only) {
        // Each Script rebuilt, against what the Host passes now.
        while (g.scripts.pop()) |x| g.destroyScript(x);
        g.libraries.clearRetainingCapacity();
        try g.libraries.appendSlice(a, named.items);
        for (saved) |*x| _ = try rebuildSaved(&r, x);
        r.skim = true;
    } else for (g.scripts.items, saved) |x, *y| try fillSaved(&r, x, y);
    for (g.scripts.items) |s| {
        if (s.owner) |o| if (o.owner_of == null or !std.mem.eql(u8, o.owner_of.?, s.name)) return error.InvalidSave;
    }
    // Function Value code, placed in its Home Script's units; after a
    // variables-only restore every one is stale.
    if (!variables_only) for (g.functions.items, places) |f, place| {
        if (!place.live) continue;
        const home = g.script(f.home) orelse continue;
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
    // Every Run, Script by Script.
    for (g.scripts.items) |s| {
        const n = try i.count();
        for (0..n) |_| try r.oneRun(s);
    }
    for (g.scripts.items) |s| {
        const n = try i.count();
        try s.work.ensureTotalCapacity(a, n);
        for (0..n) |_| switch (try i.byte()) {
            0 => s.work.appendAssumeCapacity(.{ .message = try r.delivery() }),
            1 => {
                const x = r.runs.items[try i.index(r.runs.items.len)];
                if (x.script != s) return error.InvalidSave;
                // Ready with what it waited for, or preempted, and once.
                if (!x.continuing and x.resume_with == null) return error.InvalidSave;
                for (s.work.items) |w| if (w == .run and w.run == x) return error.InvalidSave;
                s.work.appendAssumeCapacity(.{ .run = x });
            },
            else => return error.InvalidSave,
        };
    }
    // The waits, in the order they were set, each once.
    try g.waits.importOrder(a, i, r.runs.items);
    const ids = try i.count();
    for (0..ids) |_| {
        const id = try a.dupe(u8, try i.str());
        g.ids.append(a, id) catch |e| {
            a.free(id);
            return e;
        };
    }
    const inputs = try i.count();
    for (0..inputs) |_| {
        const x = try r.input();
        g.inputs.append(a, x) catch |e| {
            var one = [_]machine.Input{x};
            g.releaseInputs(&one);
            return e;
        };
    }
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
    if (variables_only) try discard(&r, saved, &discarded) else baseline(g);
    // The calls that still pend.
    var pending_ids = try g.waits.importedPending(a, calls);
    errdefer pending_ids.deinit(a);
    g.restored = .{ .pending = pending_ids, .clock = g.clock };
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
    result.discarded = try discarded.runs.toOwnedSlice(a);
    result.dropped = try discarded.dropped.toOwnedSlice(a);
    result.abandoned = try discarded.abandoned.toOwnedSlice(a);
    if (g.trace) |w| {
        w.print("> restore from=s{d}", .{g.saves}) catch {};
        if (options.variables_only) w.writeAll(" mismatch=variables-only") catch {};
        writeIds(w, "unbound", r.unbound.items);
        writeIds(w, "withheld", withheld.items);
        w.print(" fingerprint={x} mode={s}", .{ saved_print, if (variables_only) "variables-only" else "full" }) catch {};
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
    return if (variables_only) .variables_only else .full;
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
        try runs.appendSlice(a, s.live.items);
        sorting.stable(*Run, runs.items, {}, struct {
            fn less(_: void, p: *Run, q: *Run) bool {
                return runNumber(p.id) < runNumber(q.id);
            }
        }.less);
        // The prospective post-rollback view of the saved variables.
        const view = try a.dupe(*Value, x.variables);
        defer a.free(view);
        for (runs.items) |run| if (run.continuing) if (run.segment_base) |base| {
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
    for ([_]u8{ 8, 9, 10, 11 }) |old| {
        // These versions have one-byte LEB128 headers. Give the otherwise
        // valid save a legacy header and a matching integrity digest.
        bytes[magic.len] = old;
        std.crypto.hash.sha2.Sha256.hash(bytes[0 .. bytes.len - 32], bytes[bytes.len - 32 ..][0..32], .{});
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
        try testing.expectEqual(join, g.waits.pending.items[0].run.continuing);
        const call = g.waits.pending.items[0].call.?;
        try testing.expectEqualStrings("s/r1.s2", call.segment);
        // The ordinary wait stays pending across multiple later Pumps.
        // Keep the Join preempted by spending only one instruction's Fuel.
        try g.pumpWith(later, if (join) 1 else 0, 0);
        if (!join) try g.pump(.{ .seconds = 0, .micros = 999999 });
        try testing.expectEqual(join, g.waits.pending.items[0].run.continuing);
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
    std.crypto.hash.sha2.Sha256.hash(old[0 .. old.len - 32], old[old.len - 32 ..][0..32], .{});
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
            if (n >= good.len - 32) continue;
            bad[n] ^= flip;
            std.crypto.hash.sha2.Sha256.hash(bad[0 .. bad.len - 32], bad[bad.len - 32 ..][0..32], .{});
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

/// Restores a mutated save and, if it restores, runs it: it must refuse or
/// run, never crash.
fn hostile(gpa: Allocator, bad: []u8) !void {
    std.crypto.hash.sha2.Sha256.hash(bad[0 .. bad.len - 32], bad[bad.len - 32 ..][0..32], .{});
    for ([_]bool{ false, true }) |variables_only| {
        var restored: Group = .init(gpa, null);
        defer restored.deinit();
        var result: Result = .{};
        const outcome = restore(&restored, bad, .{ .variables_only = variables_only }, &result) catch continue;
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
        for (0..good.len - 32) |n| for ([_]u8{ 0x01, 0x02, 0x80, 0xff }) |flip| {
            @memcpy(bad, good);
            bad[n] ^= flip;
            try hostile(gpa, bad);
        };
        for (0..3000) |_| {
            @memcpy(bad, good);
            for (0..random.intRangeAtMost(usize, 1, 4)) |_| bad[random.uintLessThan(usize, good.len - 32)] = random.int(u8);
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
    var o: Out = .{ .gpa = gpa };
    defer o.bytes.deinit(gpa);
    try writeValue(&o, tables, v);
    var i: In = .{ .bytes = o.bytes.items };
    const copy = try readValue(&i, gpa, tables);
    defer copy.release();
    try std.testing.expectEqual(o.bytes.items.len, i.pos);
    try std.testing.expect(try v.equal(copy));
    // A truncated save is refused, and what was read is freed.
    var cut: In = .{ .bytes = o.bytes.items[0 .. o.bytes.items.len - 1] };
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

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
const Allocator = std.mem.Allocator;
const machine = @import("machine.zig");
const model = @import("../value.zig");
const display = @import("../display.zig");
const lower = @import("../lower/lower.zig");
const binary = @import("binary.zig");
const capabilities = @import("capabilities.zig");
const objects = @import("objects.zig");
const fingerprint = @import("fingerprint.zig");
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
pub const format_version: u32 = 1;

pub const Error = error{InvalidSave} || Allocator.Error;

// ---------------------------------------------------------------- encoding

/// The bytes a save is written to.
const Out = struct {
    gpa: Allocator,
    bytes: std.ArrayList(u8) = .empty,

    fn byte(o: *Out, b: u8) !void {
        try o.bytes.append(o.gpa, b);
    }

    /// An unsigned LEB128 integer.
    fn int(o: *Out, v: u64) !void {
        var x = v;
        while (true) {
            const low: u8 = @intCast(x & 0x7f);
            x >>= 7;
            if (x == 0) return o.byte(low);
            try o.byte(low | 0x80);
        }
    }

    fn signed(o: *Out, v: i128) !void {
        var buf: [16]u8 = undefined;
        std.mem.writeInt(i128, &buf, v, .little);
        try o.bytes.appendSlice(o.gpa, &buf);
    }

    fn flag(o: *Out, b: bool) !void {
        try o.byte(@intFromBool(b));
    }

    fn str(o: *Out, s: []const u8) !void {
        try o.int(s.len);
        try o.bytes.appendSlice(o.gpa, s);
    }

    fn optStr(o: *Out, s: ?[]const u8) !void {
        try o.flag(s != null);
        if (s) |x| try o.str(x);
    }

    /// An optional index, as 0 for none and the index plus 1 otherwise.
    fn ref(o: *Out, i: ?usize) !void {
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

    fn int(i: *In) Error!u64 {
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
    fn count(i: *In) Error!usize {
        const n = try i.int();
        if (n > i.bytes.len - i.pos) return error.InvalidSave;
        return @intCast(n);
    }

    fn signed(i: *In) Error!i128 {
        if (i.bytes.len - i.pos < 16) return error.InvalidSave;
        const v = std.mem.readInt(i128, i.bytes[i.pos..][0..16], .little);
        i.pos += 16;
        return v;
    }

    fn flag(i: *In) Error!bool {
        return switch (try i.byte()) {
            0 => false,
            1 => true,
            else => error.InvalidSave,
        };
    }

    /// Text borrowed from the save, which must be UTF-8.
    fn str(i: *In) Error![]const u8 {
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
    fn ref(i: *In, n: usize) Error!?usize {
        const v = try i.int();
        if (v == 0) return null;
        if (v - 1 >= n) return error.InvalidSave;
        return @intCast(v - 1);
    }

    /// An index below `n`.
    fn index(i: *In, n: usize) Error!usize {
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

/// A Script value. Containers nest as values do, so this recurses no deeper
/// than a value may nest.
fn writeValue(o: *Out, t: Tables, v: *const Value) !void {
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
            for (items) |x| try writeValue(o, t, x);
        },
        .map => |pairs| {
            try o.byte(@backingInt(Tag.map));
            try o.byte(flags);
            try o.int(pairs.len);
            for (pairs) |p| {
                try o.str(p.key);
                try writeValue(o, t, p.value);
            }
        },
        .function => |f| {
            try o.byte(@backingInt(Tag.function));
            // A value this Group didn't make is gone: none of its code.
            try o.ref(t.functionIndex(f.identity));
            try o.str(f.display);
            try o.str(f.home);
            try writeValue(o, t, f.captures);
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

fn readValue(i: *In, gpa: Allocator, t: Tables, depth: usize) Error!*Value {
    if (depth >= model.max_depth) return error.InvalidSave;
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
            const items = try gpa.alloc(*Value, n);
            defer gpa.free(items);
            var made: usize = 0;
            defer for (items[0..made]) |x| x.release();
            for (items) |*x| {
                x.* = try readValue(i, gpa, t, depth + 1);
                made += 1;
            }
            break :blk model.list(gpa, items) catch |e| return valueError(e);
        },
        .map => blk: {
            const flags = try i.byte();
            if (flags > 3) return error.InvalidSave;
            const n = try i.count();
            const pairs = try gpa.alloc(model.Pair, n);
            defer gpa.free(pairs);
            var made: usize = 0;
            defer for (pairs[0..made]) |p| p.value.release();
            for (pairs) |*p| {
                const key = try i.str();
                p.* = .{ .key = key, .value = try readValue(i, gpa, t, depth + 1) };
                made += 1;
            }
            const v = model.map(gpa, pairs) catch |e| return valueError(e);
            v.core_message = flags & 1 != 0;
            v.script_name = flags & 2 != 0;
            break :blk v;
        },
        .function => blk: {
            const code = try i.ref(t.functions.len);
            const shown = try i.str();
            const home = try i.str();
            const captures = try readValue(i, gpa, t, depth + 1);
            defer captures.release();
            if (captures.data != .map) return error.InvalidSave;
            // A value whose code this Group never had stays gone.
            const identity: usize = if (code) |c| @intFromPtr(t.functions[c]) else 0;
            break :blk model.function(gpa, home, shown, identity, captures) catch |e| return valueError(e);
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
        v.* = try readValue(i, gpa, t, 0);
        made += 1;
    }
    return out;
}

fn optValue(o: *Out, t: Tables, v: ?*const Value) !void {
    try o.flag(v != null);
    if (v) |x| try writeValue(o, t, x);
}

fn readOptValue(i: *In, gpa: Allocator, t: Tables) Error!?*Value {
    return if (try i.flag()) try readValue(i, gpa, t, 0) else null;
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
    calls: std.ArrayList(*capabilities.Call) = .empty,
    /// The internal values a dispatch activation shares, saved once.
    iterators: std.ArrayList(*machine.Iterator) = .empty,
    readers: std.ArrayList(*binary.Reader) = .empty,
    replacements: std.ArrayList(*machine.Replacement) = .empty,

    fn deinit(s: *Saving) void {
        const gpa = s.o.gpa;
        s.runs.deinit(gpa);
        s.calls.deinit(gpa);
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
        try s.o.ref(if (c) |x| std.mem.indexOfScalar(*capabilities.Call, s.calls.items, x) else null);
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
                try s.o.signed(d.at);
                try s.o.int(d.ms);
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
        try s.o.int(w.after_ms);
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
        try s.o.int(x.after_ms);
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
            try s.o.int(j.members.items.len);
            for (j.members.items) |m| {
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
            .cancel_run => |id| try s.o.str(id),
            .stop => |st| {
                try s.o.str(st.script);
                try s.o.str(st.reason);
            },
            .cancel_delivery => |id| try s.o.int(id),
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
    for (g.scripts.items) |s| for (s.live.items) |r| {
        if (r.scopes.items.len > 0 or r.participant != null) return true;
    };
    return false;
}

/// The save's bytes, which `gpa` owns. Saving changes nothing in the Group
/// but its save id counter, which the caller has already advanced.
pub fn save(g: *Group, gpa: Allocator, print: [32]u8) ![]u8 {
    var s: Saving = .{ .o = .{ .gpa = gpa }, .g = g, .tables = .{ .objects = g.objects.items, .functions = g.functions.items } };
    defer s.deinit();
    errdefer s.o.bytes.deinit(gpa);
    const o = &s.o;
    try o.bytes.appendSlice(gpa, magic);
    try o.int(format_version);
    try o.str(version.language);
    try o.int(cost_model.version);
    try o.bytes.appendSlice(gpa, &print);
    try o.int(g.saves);
    try o.signed(g.clock.seconds);
    try o.int(@intCast(g.clock.nanos));
    try o.int(g.deliveries);
    try o.int(g.broadcasts);
    try o.int(g.timers);
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
        const home = g.script(f.home);
        const live = if (home) |h| h.generation == f.generation else false;
        try o.flag(live);
        if (live) {
            try s.unit(home.?, f.library);
            try o.int(f.body);
        }
    }
    // The calls a Run still waits on, with their arguments.
    for (g.calls.items) |c| if (waitedOn(g, c)) try s.calls.append(gpa, c);
    try o.int(s.calls.items.len);
    for (s.calls.items) |c| {
        try o.str(c.id);
        try o.str(c.script);
        try o.str(c.grant);
        try o.str(c.run);
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
    try o.int(g.pending.items.len);
    for (g.pending.items) |p| {
        try o.int(std.mem.indexOfScalar(*Run, s.runs.items, p.run).?);
        try o.ref(p.member);
    }
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
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(o.bytes.items, &digest, .{});
    try o.bytes.appendSlice(gpa, &digest);
    return o.bytes.toOwnedSlice(gpa);
}

/// Whether a Run still waits on the call, or is ready with its answer.
fn waitedOn(g: *const Group, c: *const capabilities.Call) bool {
    for (g.scripts.items) |s| for (s.live.items) |r| {
        if (r.waiting) |p| if (p.call == c) return true;
        if (r.waited.call == c) return true;
        if (r.join) |j| for (j.members.items) |m| {
            if (m.waited.call == c) return true;
            if (m.pending) |p| if (p.call == c) return true;
        };
    };
    return false;
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

pub const Outcome = enum { full, mismatch };

/// What a restore reports beside its Group: the Host Objects that didn't
/// resolve, which `gpa` owns; the pending calls are the Group's
/// `restored.pending`.
pub const Result = struct {
    disposed: []*objects.Object = &.{},
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

const SavedOperation = struct { name: []const u8, mode: capabilities.Mode, required: usize, total: usize };

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
    }

    /// Text a part of the Group borrows.
    fn kept(r: *Restoring) Error![]const u8 {
        return r.keep().dupe(u8, try r.i.str());
    }

    fn owned(r: *Restoring) Error![]const u8 {
        return r.gpa().dupe(u8, try r.i.str());
    }

    fn value(r: *Restoring) Error!*Value {
        return readValue(&r.i, r.gpa(), r.tables, 0);
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
        return switch (tag) {
            .own => null,
            .extension => s.extensions.items[try r.i.index(s.extensions.items.len)],
            .library => r.libraries[try r.i.index(r.libraries.len)] orelse error.InvalidSave,
            .stdlib => machine.stdlibLibrary(try r.i.str()) orelse error.InvalidSave,
        };
    }

    fn limits(r: *Restoring) Error!machine.Limits {
        var l: machine.Limits = .{};
        inline for (@typeInfo(machine.Limits).@"struct".field_names) |f| @field(l, f) = try r.i.int();
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
        var d: machine.Delivery = .{ .id = try r.i.int(), .message = try r.owned(), .args = &.{}, .request = false };
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
    fn decl(r: *Restoring, s: *const Script, grant: []const u8, operation: []const u8) Error!*const capabilities.Operation {
        _ = r;
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
        w.after_ms = try r.i.int();
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
        p.deadline = try r.i.signed();
        p.order = try r.i.int();
        p.call = try r.call();
        p.grant = try r.kept();
        p.operation = try r.kept();
        if (try r.i.flag()) p.decl = try r.decl(run.script, p.grant, p.operation);
        p.after_ms = try r.i.int();
        p.member = try r.i.ref(std.math.maxInt(u32));
        p.block = try r.i.flag();
        p.branch = try r.i.small(u32);
        if (try r.i.flag()) {
            const library = try r.unit(run.script);
            const entry = try r.i.small(u32);
            const events = run.script.unitIn(library).events;
            if (entry >= events.len) return error.InvalidSave;
            const any = try r.i.flag();
            const n = try r.i.count();
            if (n != events[entry].branches.len) return error.InvalidSave;
            const branches = try a.alloc(machine.EventBranch, n);
            var made: usize = 0;
            errdefer {
                r.g.releaseHeld(branches[0..made]);
                a.free(branches);
            }
            for (branches) |*b| {
                b.* = switch (try r.i.byte()) {
                    0 => blk: {
                        const from = try r.optValue();
                        errdefer if (from) |v| v.release();
                        break :blk .{ .when = .{ .from = from, .captures = try r.values() } };
                    },
                    1 => .{ .after = try r.i.signed() },
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
                4 => .{ .deadline = .{ .at = try r.i.signed(), .ms = try r.i.int() } },
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
            const unit_code = run.script.unitIn(library);
            const body = try r.i.small(u32);
            if (body >= unit_code.bodies.len) return error.InvalidSave;
            const b = unit_code.bodies[body];
            const pc = try r.i.small(u32);
            if (pc < b.first or pc > b.last) return error.InvalidSave;
            const locals = try r.values();
            var f: Frame = .{ .library = library, .body = body, .pc = pc, .locals = locals };
            out.appendAssumeCapacity(f);
            const placed = &out.items[out.items.len - 1];
            if (locals.len != b.locals) return error.InvalidSave;
            try r.slots(&placed.stack);
            placed.called = try r.i.flag();
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
            r.g.destroyRun(x);
            return e;
        };
        try r.runs.append(a, x);
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
            if (body >= s.unitIn(library).bodies.len) return error.InvalidSave;
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
        x.waiting = try r.pending(x);
        x.resume_with = try r.resumeWith();
        x.suspended_at = try r.kept();
        x.waited = try r.waited(s);
        if (try r.i.flag()) x.raised_at = .{ .line = try r.i.small(u32), .column = try r.i.small(u32) };
        if (try r.i.flag()) {
            const j = try a.create(machine.Join);
            j.* = .{};
            x.join = j;
            const n = try r.i.count();
            for (0..n) |m| {
                try j.members.append(a, .{ .pending = null, .waited = .{} });
                const member = &j.members.items[m];
                member.pending = try r.pending(x);
                if (member.pending) |p| if (p.member == null or p.member.? != m) return error.InvalidSave;
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
            if (body >= s.unitIn(library).bodies.len) return error.InvalidSave;
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
            if (base.len > s.variables.len) return error.InvalidSave;
        }
        try r.frames(x, &x.frames);
        if (x.base > x.frames.items.len) return error.InvalidSave;
        if (x.waiting != null and x.frames.items.len == 0) return error.InvalidSave;
    }

    /// A queued Host Input the caller owns.
    fn input(r: *Restoring) Error!machine.Input {
        const a = r.gpa();
        const Tag3 = std.meta.Tag(machine.Input);
        const t = std.enums.fromInt(Tag3, try r.i.byte()) orelse return error.InvalidSave;
        return switch (t) {
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
            .stop => blk: {
                const script = try r.owned();
                errdefer a.free(script);
                break :blk .{ .stop = .{ .script = script, .reason = try r.owned() } };
            },
            .cancel_delivery => .{ .cancel_delivery = try r.i.int() },
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
        op.* = .{ .name = try a.dupe(u8, o.name), .args = args, .result = result, .mode = o.mode, .host = .{ .call = unbound } };
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

/// Builds a restored Script from its saved state, compiled again: null
/// when it no longer compiles, a mismatch. `g` owns it once it returns.
fn readScript(r: *Restoring, generation: u64) Error!?*Script {
    const a = r.gpa();
    const i = &r.i;
    const s = try a.create(Script);
    s.* = .{ .name = "", .identity = undefined, .arena = .init(a), .code = .init(a), .unit = undefined, .variables = &.{}, .definitions = &.{}, .generation = generation };
    s.unit.values = &.{};
    var joined = false;
    errdefer if (!joined) r.g.destroyScript(s);
    const sa = s.arena.allocator();
    s.name = try sa.dupe(u8, try i.str());
    for (r.g.scripts.items) |x| if (std.mem.eql(u8, x.name, s.name)) return error.InvalidSave;
    if (i.bytes.len - i.pos < 32) return error.InvalidSave;
    i.pos += 32;
    s.source = try s.code.allocator().dupe(u8, try i.str());
    const extensions = try sa.alloc([]const u8, try i.count());
    for (extensions) |*x| x.* = try sa.dupe(u8, try i.str());
    s.limits = try r.limits();
    // Its Grants, re-bound by the Host, or kept revoked with their saved
    // declarations.
    const grants = try sa.alloc(machine.ScriptGrant, try i.count());
    for (grants) |*sg| {
        const saved: SavedGrant = blk: {
            const name = try sa.dupe(u8, try i.str());
            const json = try sa.dupe(u8, try i.str());
            const capability = try sa.dupe(u8, try i.str());
            const ops = try sa.alloc(SavedOperation, try i.count());
            for (ops) |*o| o.* = .{ .name = try sa.dupe(u8, try i.str()), .mode = std.enums.fromInt(capabilities.Mode, try i.byte()) orelse return error.InvalidSave, .required = try i.small(usize), .total = try i.small(usize) };
            break :blk .{ .name = name, .json = json, .capability = capability, .ops = ops, .revoked = try i.flag(), .disabled = try i.flag() };
        };
        const rebound: ?*capabilities.Grant = if (r.options.grants) |x| x.call(x.context, s.name, saved.name) else null;
        if (rebound) |grant| {
            // Only the saved Operations, whose declarations must match.
            const kept = try sa.alloc(bool, grant.capability.operations.len);
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
            try r.unbound.append(a, try std.fmt.allocPrint(r.keep(), "{s}.{s}", .{ s.name, saved.name }));
            const grant = try placeholder(r.g, saved);
            const kept = try sa.alloc(bool, saved.ops.len);
            @memset(kept, true);
            sg.* = .{ .name = saved.name, .grant = grant, .kept = kept, .revoked = true, .disabled = saved.disabled, .declarations = saved.json };
        }
        if (sg.grant.coordinator != null) s.effects = true;
    }
    s.grants = grants;
    s.owner = try r.object();
    s.objects = try sa.alloc(machine.NamedObject, try i.count());
    for (s.objects) |*x| x.* = .{ .name = try sa.dupe(u8, try i.str()), .object = try r.object() orelse return error.InvalidSave };
    // The code, as first compiled: a Script that no longer compiles
    // against these Libraries and Grants is a mismatch.
    if (!(r.g.compileSaved(s, extensions) catch |e| return valueError(e))) {
        r.mismatch = true;
        r.g.destroyScript(s);
        joined = true;
        return null;
    }
    s.variables = try r.values();
    if (s.variables.len != s.variableNames().len) return error.InvalidSave;
    s.definitions = try r.values();
    if (s.definitions.len != s.unit.definitions.len) return error.InvalidSave;
    for (s.extensions.items) |x| {
        x.definitions = try r.values();
        if (x.definitions.len != x.unit.definitions.len) return error.InvalidSave;
    }
    s.runs = try i.int();
    s.fuel_total = try i.int();
    s.alloc_total = try i.int();
    s.faults = try i.int();
    s.debt = try i.int();
    if (try i.optStr()) |reason| s.stopped = try a.dupe(u8, reason);
    try r.g.scripts.append(a, s);
    joined = true;
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
    const seconds = try i.signed();
    const nanos = try i.int();
    if (nanos >= std.time.ns_per_s) return error.InvalidSave;
    g.clock = .{ .seconds = std.math.cast(i64, seconds) orelse return error.InvalidSave, .nanos = @intCast(nanos) };
    g.deliveries = try i.int();
    g.broadcasts = try i.int();
    g.timers = try i.int();
    if (!std.mem.eql(u8, language, version.language) or costs_version != cost_model.version) r.mismatch = true;
    // Libraries, matched by identity to those the Host passes.
    r.libraries = try a.alloc(?*Library, try i.count());
    @memset(r.libraries, null);
    var withheld: std.ArrayList([]const u8) = .empty;
    defer withheld.deinit(a);
    for (r.libraries) |*l| {
        const name = try i.str();
        _ = try i.str();
        if (i.bytes.len - i.pos < 32) return error.InvalidSave;
        const identity = i.bytes[i.pos..][0..32];
        i.pos += 32;
        l.* = for (options.libraries) |x| {
            if (std.mem.eql(u8, &x.identity, identity) and std.mem.eql(u8, x.name, name)) break x;
        } else null;
        if (l.* == null) {
            r.mismatch = true;
            try withheld.append(a, name);
        } else try g.libraries.append(a, l.*.?);
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
    for (calls, 0..) |*c, n| {
        const id = try a.dupe(u8, try i.str());
        const x = a.create(capabilities.Call) catch |e| {
            a.free(id);
            return e;
        };
        x.* = .{ .id = id, .script = "", .grant = "", .binding = null, .now = g.clock, .left = null, .starting = false, .group = g, .gpa = a };
        g.calls.append(a, x) catch |e| {
            a.free(id);
            a.destroy(x);
            return e;
        };
        x.script = try r.kept();
        x.grant = try r.kept();
        x.run = try r.kept();
        x.args = try r.values();
        x.charged = try i.int();
        for (calls[0..n]) |y| if (std.mem.eql(u8, y.id, id)) return error.InvalidSave;
        c.* = x;
    }
    r.calls = calls;
    // The Scripts, compiled again.
    const script_count = try i.count();
    for (0..script_count) |_| {
        g.generations += 1;
        if (try readScript(&r, g.generations) == null) return .mismatch;
    }
    // Versions: the Fingerprint of what this Group now is.
    if (!std.mem.eql(u8, &(try g.groupFingerprint()), &saved_print)) r.mismatch = true;
    if (r.mismatch) {
        if (g.trace) |w| {
            w.print("> restore from=s{d}", .{g.saves}) catch {};
            writeIds(w, "unbound", r.unbound.items);
            writeIds(w, "withheld", withheld.items);
            w.print(" fingerprint={x}\nrefused code=\"save mismatch\"\n", .{saved_print}) catch {};
        }
        return .mismatch;
    }
    for (g.scripts.items) |s| {
        if (s.owner) |o| if (o.owner_of == null or !std.mem.eql(u8, o.owner_of.?, s.name)) return error.InvalidSave;
    }
    // Function Value code, placed in its Home Script's units.
    for (g.functions.items, places) |f, place| {
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
    }
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
                s.work.appendAssumeCapacity(.{ .run = x });
            },
            else => return error.InvalidSave,
        };
    }
    // The waits, in the order they were set, each once.
    const pending_count = try i.count();
    try g.pending.ensureTotalCapacity(a, pending_count);
    for (0..pending_count) |_| {
        const x = r.runs.items[try i.index(r.runs.items.len)];
        const p = if (try i.ref(std.math.maxInt(u32))) |m| blk: {
            const j = x.join orelse return error.InvalidSave;
            if (m >= j.members.items.len) return error.InvalidSave;
            break :blk j.members.items[m].pending orelse return error.InvalidSave;
        } else x.waiting orelse return error.InvalidSave;
        if (std.mem.indexOfScalar(*Pending, g.pending.items, p) != null) return error.InvalidSave;
        g.pending.appendAssumeCapacity(p);
    }
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
    if (i.pos != i.bytes.len) return error.InvalidSave;
    // The calls that still pend, with their Grants' bindings.
    var pending_ids: std.ArrayList([]const u8) = .empty;
    errdefer pending_ids.deinit(a);
    for (calls) |c| {
        const s = g.script(c.script) orelse return error.InvalidSave;
        if (s.grant(c.grant)) |sg| c.binding = sg.grant.binding;
        for (g.pending.items) |p| if (p.call == c) {
            try pending_ids.append(a, c.id);
            break;
        };
    }
    std.mem.sort([]const u8, pending_ids.items, {}, struct {
        fn less(_: void, x: []const u8, y: []const u8) bool {
            return machine.callOrder(x, y);
        }
    }.less);
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
    if (g.trace) |w| {
        w.print("> restore from=s{d}", .{g.saves}) catch {};
        if (options.variables_only) w.writeAll(" mismatch=variables-only") catch {};
        writeIds(w, "unbound", r.unbound.items);
        writeIds(w, "withheld", withheld.items);
        w.print(" fingerprint={x} mode=full", .{saved_print}) catch {};
        writeIds(w, "pending", g.restored.?.pending.items);
        if (result.disposed.len > 0) {
            w.writeAll(" disposed=[") catch {};
            for (result.disposed, 0..) |o, n| {
                if (n > 0) w.writeAll(", ") catch {};
                display.writeTrace(w, o.value) catch {};
            }
            w.writeAll("]") catch {};
        }
        w.writeAll("\n") catch {};
    }
    return .full;
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
        \\  wait for ping x where x > 1 or 9 s
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
    _ = try g.load("a", a, .{});
    _ = try g.load("b", b, .{});
    const seven = try model.scalar(gpa, .{ .number = model.Decimal.fromInt(7) });
    var args = [_]*Value{seven};
    _ = try g.deliver("a", "go", &args, false);
    _ = try g.deliver("a", "nap", &.{}, false);
    _ = try g.deliver("a", "watch", &.{}, false);
    try g.pump(.{ .seconds = 1790000000, .nanos = 0 });
    _ = try g.deliver("a", "nap", &.{}, false);
    return g;
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
    defer gpa.free(result.disposed);
    const again = try save(&restored, gpa, print);
    defer gpa.free(again);
    try testing.expectEqualSlices(u8, first, again);
    // It runs on, each Run where it was.
    try restored.pump(.{ .seconds = 1790000010, .nanos = 0 });
    try g.pump(.{ .seconds = 1790000010, .nanos = 0 });
    const x = try save(&g, gpa, print);
    defer gpa.free(x);
    const y = try save(&restored, gpa, print);
    defer gpa.free(y);
    try testing.expectEqualSlices(u8, x, y);
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
            var restored: Group = .init(gpa, null);
            defer restored.deinit();
            var result: Result = .{};
            if (restore(&restored, bad, .{}, &result)) |_| gpa.free(result.disposed) else |_| {}
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
        var restored: Group = .init(memory.allocator(), null);
        defer restored.deinit();
        var result: Result = .{};
        finished = blk: {
            const outcome = restore(&restored, good, .{}, &result) catch |e| {
                if (e != error.OutOfMemory) return e;
                break :blk false;
            };
            memory.allocator().free(result.disposed);
            try testing.expectEqual(Outcome.full, outcome);
            const again = save(&restored, memory.allocator(), print) catch break :blk false;
            defer memory.allocator().free(again);
            try testing.expectEqualSlices(u8, good, again);
            break :blk true;
        };
    }
}

//! The Message Layer (spec chapter 9): the language-neutral form of the
//! embedding interface, as JSON frames over `talk_buffer`/`talk_send` in
//! the `wasm32-wasi` build. The layer is a Zig Host of talk.zig's API; a
//! Pump that reaches a Host Operation or property pauses at the crossing
//! (machine.Group.resumePump) and its `need` is the Pump's reply, which
//! the Host answers with the matching result under the same `ref`.
//!
//! Protocol errors (an unknown message, a malformed frame, an unexpected
//! `ref`) are the transport's, outside parity: they are answered
//! `{"kind":"protocol error","detail":…}` and the instance carries on.
const std = @import("std");
const builtin = @import("builtin");
const model = @import("value.zig");
const display = @import("display.zig");
const encoding = @import("encoding.zig");
const machine = @import("machine/machine.zig");
const caps = machine.capabilities;
const objects = machine.objects;
const talk = @import("talk.zig");
const generated_diagnostics = @import("generated/diagnostics.zig");

const Allocator = std.mem.Allocator;
const Value = model.Value;
const Json = std.json.Value;
const Direct = talk.direct;

/// The largest frame a Host may write, as the harnesses measure it.
pub const max_frame: usize = 64 << 20;
/// The deepest JSON in a frame, its envelope included.
const max_depth: usize = 64;

const protocol_version: i64 = 1;

const quoted = encoding.quoted;

fn field(obj: Json, name: []const u8) ?Json {
    if (obj != .object) return null;
    return obj.object.get(name);
}

fn asText(j: ?Json) ?[]const u8 {
    const v = j orelse return null;
    return if (v == .string) v.string else null;
}

fn asBool(j: ?Json) ?bool {
    const v = j orelse return null;
    return if (v == .bool) v.bool else null;
}

/// An integer a frame spells, from its number text: a JSON integer, or a
/// string holding one (chapter 9's integer encoding).
fn asInt(j: ?Json) ?i64 {
    const v = j orelse return null;
    const text = switch (v) {
        .number_string => |s| s,
        .string => |s| s,
        .integer => |n| return n,
        else => return null,
    };
    return std.fmt.parseInt(i64, text, 10) catch null;
}

fn asU64(j: ?Json) ?u64 {
    const n = asInt(j) orelse return null;
    return if (n < 0) null else @intCast(n);
}

/// Writes an integer as chapter 9 encodes it: a JSON integer below 2^53,
/// else its decimal text in a string.
fn writeInt(w: *std.Io.Writer, n: i128) !void {
    if (@abs(n) < encoding.plain_integer_limit) {
        try w.print("{d}", .{@as(i64, @intCast(n))});
    } else {
        try w.print("\"{d}\"", .{n});
    }
}

/// A Group the Host made, by its handle.
const GroupEntry = struct {
    gpa: Allocator,
    name: []u8,
    group: *talk.Group,
    /// Whether replies carry `trace`.
    traced: bool,
    /// Trace lines not yet carried by a reply, from the sink.
    pending_trace: std.ArrayList([]u8) = .empty,
};

/// What an `op-result` or `prop-result` brought back, for the re-made
/// call to consume.
const Answer = struct {
    kind: enum { result, started, done, fail, limit, host_error },
    value: ?*Value = null,
    code: []const u8 = "",
    message: ?[]const u8 = null,
    data: ?*Value = null,
    charged: u64 = 0,

    fn release(a: *Answer, gpa: Allocator) void {
        if (a.value) |v| v.release();
        if (a.data) |v| v.release();
        if (a.code.len > 0) gpa.free(a.code);
        if (a.message) |m| gpa.free(m);
        a.* = undefined;
    }
};

/// The crossing a Pump paused at, until its result comes back.
const Need = struct {
    kind: enum { op, prop },
    /// The paused Pump's Group.
    entry: *GroupEntry,
    // An op's fields.
    call: []u8,
    script: []u8,
    run: []u8,
    segment: []u8,
    grant: []u8,
    capability: []u8,
    operation: []u8,
    mode: caps.Mode = .immediate,
    scope: []u8,
    automatic: bool = false,
    /// The Run's Fuel left after the declared cost; null for an automatic
    /// call or an unlimited one.
    fuel_left: ?u64 = null,
    now: model.dates.Instant,
    args: []*Value,
    // A prop's fields.
    object_kind: []u8,
    object_id: []u8,
    prop: []u8,
    /// The value a set brings; null reads the property.
    value: ?*Value = null,

    fn release(n: *Need, gpa: Allocator) void {
        for ([_][]u8{ n.call, n.script, n.run, n.segment, n.grant, n.capability, n.operation, n.scope, n.object_kind, n.object_id, n.prop }) |s| gpa.free(s);
        for (n.args) |v| v.release();
        gpa.free(n.args);
        if (n.value) |v| v.release();
        n.* = undefined;
    }
};

/// One instance's Message Layer state: its Core, and the Handles the Host
/// holds. Created whole by `Session.init`; the wasm exports keep one in
/// `instance`.
pub const Session = struct {
    gpa: Allocator,
    core: *talk.Core,
    grants: std.ArrayList(*caps.Grant) = .empty,
    groups: std.ArrayList(*GroupEntry) = .empty,
    /// Per-Operation and per-property Host contexts, owned here.
    op_contexts: std.ArrayList(*OpContext) = .empty,
    prop_contexts: std.ArrayList(*PropContext) = .empty,
    /// Whether a Pump is running, so a load's initialiser cannot defer.
    in_pump: bool = false,
    /// The Pump paused at a crossing: its `ref` and its need.
    paused_ref: ?i64 = null,
    need: ?Need = null,
    answer: ?Answer = null,
    /// OOM inside a Host function, which cannot report it there.
    oom: bool = false,
    /// The Group whose Pump is running, which a need belongs to.
    pumping_entry: ?*GroupEntry = null,

    pub fn init(gpa: Allocator) ?*Session {
        const s = gpa.create(Session) catch return null;
        const core = Direct.new() orelse {
            gpa.destroy(s);
            return null;
        };
        s.* = .{ .gpa = gpa, .core = core };
        return s;
    }

    pub fn deinit(s: *Session) void {
        const gpa = s.gpa;
        if (s.need) |*n| n.release(gpa);
        if (s.answer) |*a| a.release(gpa);
        for (s.groups.items) |e| {
            Direct.groupRelease(e.group);
            for (e.pending_trace.items) |line| gpa.free(line);
            e.pending_trace.deinit(gpa);
            gpa.free(e.name);
            gpa.destroy(e);
        }
        s.groups.deinit(gpa);
        s.grants.deinit(gpa);
        for (s.op_contexts.items) |c| {
            gpa.free(c.capability);
            gpa.free(c.operation);
            gpa.destroy(c);
        }
        s.op_contexts.deinit(gpa);
        for (s.prop_contexts.items) |c| {
            gpa.free(c.kind);
            gpa.free(c.prop);
            gpa.destroy(c);
        }
        s.prop_contexts.deinit(gpa);
        Direct.coreRelease(s.core);
        gpa.destroy(s);
    }

    fn groupNamed(s: *Session, name: []const u8) ?*GroupEntry {
        for (s.groups.items) |e| if (std.mem.eql(u8, e.name, name)) return e;
        return null;
    }

    fn capabilityNamed(s: *Session, name: []const u8) ?*caps.Capability {
        for (s.core.definitions.items) |d| if (std.mem.eql(u8, d.name, name)) return d;
        return null;
    }
};

/// An Operation's identity, which its `op` need carries.
const OpContext = struct {
    session: *Session,
    capability: []u8,
    operation: []u8,
    mode: caps.Mode,
};

/// A property's identity, which its `prop` need carries.
const PropContext = struct {
    session: *Session,
    kind: []u8,
    prop: []u8,
};

/// A reply under construction.
const Out = struct {
    buf: std.Io.Writer.Allocating,

    fn init(gpa: Allocator) Out {
        return .{ .buf = .init(gpa) };
    }
    fn w(o: *Out) *std.Io.Writer {
        return &o.buf.writer;
    }
    fn raw(o: *Out, s: []const u8) Allocator.Error!void {
        o.w().writeAll(s) catch return error.OutOfMemory;
    }
    fn key(o: *Out, name: []const u8) Allocator.Error!void {
        try o.text(name);
        try o.raw(":");
    }
    fn text(o: *Out, s: []const u8) Allocator.Error!void {
        quoted(o.w(), s) catch return error.OutOfMemory;
    }
    fn int(o: *Out, n: i128) Allocator.Error!void {
        writeInt(o.w(), n) catch return error.OutOfMemory;
    }
    fn value(o: *Out, v: *const Value) (Allocator.Error || error{NotEncodable})!void {
        encoding.write(o.w(), v) catch |e| return if (e == error.NotEncodable) error.NotEncodable else error.OutOfMemory;
    }
    /// `{"$bytes":…}`, chapter 9's byte-string encoding.
    fn bytesTag(o: *Out, gpa: Allocator, b: []const u8) Allocator.Error!void {
        const codec = std.base64.standard.Encoder;
        const encoded = try gpa.alloc(u8, codec.calcSize(b.len));
        defer gpa.free(encoded);
        try o.raw("{\"$bytes\":");
        try o.text(codec.encode(encoded, b));
        try o.raw("}");
    }
    fn instant(o: *Out, gpa: Allocator, t: model.dates.Instant) Allocator.Error!void {
        const s = model.dates.string(gpa, model.dates.fields(t), true) catch return error.OutOfMemory;
        defer gpa.free(s);
        try o.text(s);
    }
    fn finish(o: *Out) Allocator.Error![]u8 {
        return o.buf.toOwnedSlice();
    }
    fn deinit(o: *Out) void {
        o.buf.deinit();
    }
};

fn protocolError(gpa: Allocator, ref: i64, detail: []const u8) []u8 {
    var o = Out.init(gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"err\":{\"kind\":\"protocol error\",\"detail\":") catch {};
    o.text(detail) catch {};
    o.raw("}}") catch {};
    return o.finish() catch @constCast("{\"ref\":0,\"err\":{\"kind\":\"protocol error\",\"detail\":\"out of memory\"}}");
}

fn hostError(gpa: Allocator, ref: i64, code: talk.HostErrorCode) []u8 {
    if (code == .err_mailbox_full) {
        var o = Out.init(gpa);
        defer o.deinit();
        o.raw("{\"ref\":") catch {};
        o.int(ref) catch {};
        o.raw(",\"err\":{\"kind\":\"mailbox full\"}}") catch {};
        return o.finish() catch protocolError(gpa, ref, "out of memory");
    }
    var o = Out.init(gpa);
    defer o.deinit();
    const name = talk.hostCodeName(code);
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"err\":{\"kind\":\"host error\",\"code\":") catch {};
    o.text(name) catch {};
    o.raw(",\"detail\":") catch {};
    o.text(name) catch {};
    o.raw("}}") catch {};
    return o.finish() catch protocolError(gpa, ref, "out of memory");
}

/// The Trace sink each Group is made with: its lines collect on the
/// entry, to be carried by the next reply when the Group traces, and to
/// give a load its diagnostics either way.
fn traceSink(context: ?*anyopaque, line: [*]const u8, len: usize) callconv(.c) void {
    const e: *GroupEntry = @ptrCast(@alignCast(context.?));
    const owned = e.gpa.dupe(u8, line[0..len]) catch return;
    e.pending_trace.append(e.gpa, owned) catch e.gpa.free(owned);
}

/// Takes the entry's collected Trace lines.
fn takeTrace(e: *GroupEntry) []const []u8 {
    const lines = e.pending_trace.toOwnedSlice(e.gpa) catch {
        for (e.pending_trace.items) |l| e.gpa.free(l);
        e.pending_trace.clearRetainingCapacity();
        return &.{};
    };
    e.pending_trace = .empty;
    return lines;
}

fn freeTrace(gpa: Allocator, lines: []const []u8) void {
    for (lines) |l| gpa.free(l);
    gpa.free(lines);
}

/// A diagnostic's message: its catalogue sentence (wording is outside
/// parity), or the code itself for a syntax error.
fn diagnosticMessage(code: []const u8) []const u8 {
    for (generated_diagnostics.diagnostics.diagnostic) |d| if (std.mem.eql(u8, d.code, code)) return d.raised_when;
    return code;
}

/// The `load error` reply for a refused load, from the `diag` records
/// its Trace made: `diag <unit> code="…" pos=<line>:<col>`.
fn loadError(gpa: Allocator, ref: i64, lines: []const []u8) []u8 {
    var o = Out.init(gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"err\":{\"kind\":\"load error\",\"diagnostics\":[") catch {};
    var first = true;
    for (lines) |line| {
        if (!std.mem.startsWith(u8, line, "diag ")) continue;
        const code_at = std.mem.indexOf(u8, line, " code=\"") orelse continue;
        const unit = line[5..code_at];
        const rest = line[code_at + 7 ..];
        const code_end = std.mem.indexOfScalar(u8, rest, '"') orelse continue;
        const code = rest[0..code_end];
        const pos_at = std.mem.indexOf(u8, rest, " pos=") orelse continue;
        const pos = rest[pos_at + 5 ..];
        const colon = std.mem.indexOfScalar(u8, pos, ':') orelse continue;
        const line_no = std.fmt.parseInt(i64, pos[0..colon], 10) catch continue;
        const col = std.fmt.parseInt(i64, pos[colon + 1 ..], 10) catch continue;
        if (!first) o.raw(",") catch {};
        first = false;
        o.raw("{\"code\":") catch {};
        o.text(code) catch {};
        o.raw(",\"message\":") catch {};
        o.text(diagnosticMessage(code)) catch {};
        o.raw(",\"unit\":") catch {};
        o.text(unit) catch {};
        o.raw(",\"line\":") catch {};
        o.int(line_no) catch {};
        o.raw(",\"col\":") catch {};
        o.int(col) catch {};
        o.raw("}") catch {};
    }
    o.raw("]}}") catch {};
    return o.finish() catch protocolError(gpa, ref, "out of memory");
}

/// Resolves `{"$object":[kind,id]}` against a Group's handles.
fn resolveObject(context: ?*anyopaque, kind: []const u8, id: []const u8) model.Error!*Value {
    const e: *GroupEntry = @ptrCast(@alignCast(context orelse return error.InvalidValue));
    for (e.group.group.objects.items) |o| {
        if (std.mem.eql(u8, o.kind.name, kind) and std.mem.eql(u8, o.id, id)) return o.value.retain();
    }
    return error.InvalidValue;
}

/// Reads a Value Encoding held in a parsed frame, against `entry`'s
/// Group (or no Group, for `add`).
fn decodeValue(gpa: Allocator, j: Json, entry: ?*GroupEntry) model.Error!*Value {
    var text: std.Io.Writer.Allocating = .init(gpa);
    defer text.deinit();
    text.writer.print("{f}", .{std.json.fmt(j, .{})}) catch return error.OutOfMemory;
    return encoding.decode(gpa, text.written(), .{
        .context = if (entry) |e| @ptrCast(e) else null,
        .object = if (entry != null) resolveObject else null,
    });
}

const Invalid = error{InvalidValue};

/// A Shape from its data-model JSON (the Host Manifest's, chapter 9).
/// Allocated with `a`, which its parts keep.
fn shapeOf(a: Allocator, j: Json, depth: usize) (Allocator.Error || Invalid)!*caps.Shape {
    if (depth > 32) return error.InvalidValue;
    switch (j) {
        .string => |s| {
            const k = caps.Kind.named(s) orelse return error.InvalidValue;
            return caps.Shape.kind(a, k) catch return error.OutOfMemory;
        },
        .object => |obj| {
            if (obj.get("quantity")) |u| {
                const t = asText(u) orelse return error.InvalidValue;
                return caps.Shape.quantityOf(a, t) catch |e| if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
            }
            if (obj.get("unitKind")) |u| {
                const t = asText(u) orelse return error.InvalidValue;
                return caps.Shape.quantityKind(a, t) catch |e| if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
            }
            if (obj.get("object")) |u| {
                const t = asText(u) orelse return error.InvalidValue;
                return caps.Shape.objectOf(a, t);
            }
            if (obj.get("list")) |u| {
                const inner = try shapeOf(a, u, depth + 1);
                errdefer inner.release();
                return caps.Shape.listOf(a, inner);
            }
            if (obj.get("optional")) |u| {
                const inner = try shapeOf(a, u, depth + 1);
                errdefer inner.release();
                return caps.Shape.optional(a, inner);
            }
            if (obj.get("oneOf")) |u| {
                if (u != .array) return error.InvalidValue;
                const shapes = try a.alloc(*caps.Shape, u.array.items.len);
                var made: usize = 0;
                errdefer {
                    for (shapes[0..made]) |x| x.release();
                    a.free(shapes);
                }
                for (u.array.items, shapes) |item, *slot| {
                    slot.* = try shapeOf(a, item, depth + 1);
                    made += 1;
                }
                return caps.Shape.oneOf(a, shapes);
            }
            if (obj.get("map")) |u| {
                if (u != .array) return error.InvalidValue;
                const fields = try a.alloc(caps.Field, u.array.items.len);
                var made: usize = 0;
                errdefer {
                    for (fields[0..made]) |f| {
                        a.free(f.key);
                        f.shape.release();
                    }
                    a.free(fields);
                }
                for (u.array.items, fields) |item, *slot| {
                    const key = asText(field(item, "key")) orelse return error.InvalidValue;
                    slot.* = .{
                        .key = try a.dupe(u8, key),
                        .shape = shapeOf(a, field(item, "shape") orelse return error.InvalidValue, depth + 1) catch |e| {
                            a.free(slot.key);
                            return e;
                        },
                        .optional = asBool(field(item, "optional")) orelse false,
                    };
                    made += 1;
                }
                return caps.Shape.map(a, fields, asBool(obj.get("open")) orelse false);
            }
            return error.InvalidValue;
        },
        else => return error.InvalidValue,
    }
}

fn costOf(j: ?Json) Invalid!caps.Cost {
    const v = j orelse return .{};
    if (v != .object) return error.InvalidValue;
    const fuel = asU64(v.object.get("fuel")) orelse return error.InvalidValue;
    const alloc = if (v.object.get("alloc")) |x| asU64(x) orelse return error.InvalidValue else 0;
    return .{ .fuel = fuel, .alloc = alloc };
}

fn modeOf(j: ?Json) Invalid!caps.Mode {
    const s = asText(j) orelse return error.InvalidValue;
    if (std.mem.eql(u8, s, "immediate")) return .immediate;
    if (std.mem.eql(u8, s, "suspending")) return .suspending;
    if (std.mem.eql(u8, s, "fire-and-forget")) return .fire_and_forget;
    return error.InvalidValue;
}

/// A Script's limits, from a load's `limits` object.
fn limitsOf(j: ?Json, out: *talk.Limits) Invalid!?*talk.Limits {
    const v = j orelse return null;
    if (v != .object) return error.InvalidValue;
    out.* = .{};
    var any = false;
    inline for (.{ .{ "fuelPerRun", "fuel_per_run" }, .{ "allocPerRun", "alloc_per_run" }, .{ "persistentState", "persistent_state" }, .{ "callDepth", "call_depth" }, .{ "patternSize", "pattern_size" }, .{ "mailboxDepth", "mailbox_depth" }, .{ "maxWaitMs", "max_wait_ms" }, .{ "maxJoin", "max_join" }, .{ "cleanupBudget", "cleanup_budget" } }) |pair| {
        if (v.object.get(pair[0])) |x| {
            const n = asInt(x) orelse return error.InvalidValue;
            if (n < 0) return error.InvalidValue;
            @field(out.*, pair[1]) = n;
            any = true;
        }
    }
    return if (any) out else null;
}

/// One Delivery's limit override, from a message's `limits` object: a
/// present key is supplied, a zero included.
fn overrideOf(j: ?Json, out: *talk.LimitOverride) Invalid!?*talk.LimitOverride {
    const v = j orelse return null;
    if (v != .object) return error.InvalidValue;
    out.* = .{};
    var any = false;
    inline for (.{ .{ "fuelPerRun", "fuel_per_run", 1 }, .{ "allocPerRun", "alloc_per_run", 2 }, .{ "maxWaitMs", "max_wait_ms", 4 }, .{ "maxJoin", "max_join", 8 } }) |t| {
        if (v.object.get(t[0])) |x| {
            const n = asInt(x) orelse return error.InvalidValue;
            if (n < 0) return error.InvalidValue;
            @field(out.*, t[1]) = n;
            out.set |= t[2];
            any = true;
        }
    }
    return if (any) out else null;
}

/// The Operation Host function of every Capability the layer defines:
/// with an answer at hand it gives it; without one it records the need
/// and defers, pausing the Pump at the crossing.
fn opCall(context: ?*anyopaque, call: *caps.Call, args: []const *Value) caps.Outcome {
    const oc: *OpContext = @ptrCast(@alignCast(context.?));
    const s = oc.session;
    if (s.answer) |*a| {
        const answer = a.*;
        s.answer = null;
        // A result answers only an immediate Operation, started only a
        // suspending one, done only a fire-and-forget one.
        const fits = switch (answer.kind) {
            .result => oc.mode == .immediate,
            .started => oc.mode == .suspending,
            .done => oc.mode == .fire_and_forget,
            .fail, .limit, .host_error => true,
        };
        if (!fits) {
            _ = call.charge(answer.charged);
            var copy = answer;
            copy.release(s.gpa);
            return .broken;
        }
        switch (answer.kind) {
            .result => {
                if (!call.charge(answer.charged)) {
                    var copy = answer;
                    copy.release(s.gpa);
                    return .limited;
                }
                return .{ .value = answer.value.? };
            },
            .started => {
                if (!call.charge(answer.charged)) return .limited;
                return .started;
            },
            .done => {
                if (!call.charge(answer.charged)) return .limited;
                const nothing = model.scalar(call.gpa, .nothing) catch return .broken;
                return .{ .value = nothing };
            },
            .fail => {
                if (!call.charge(answer.charged)) {
                    var copy = answer;
                    copy.release(s.gpa);
                    return .limited;
                }
                // The Group frees a failure's text, so its allocator
                // makes it.
                const code = call.gpa.dupe(u8, answer.code) catch {
                    var copy = answer;
                    copy.release(s.gpa);
                    return .broken;
                };
                const message: ?[]const u8 = if (answer.message) |m| (call.gpa.dupe(u8, m) catch {
                    call.gpa.free(code);
                    var copy = answer;
                    copy.release(s.gpa);
                    return .broken;
                }) else null;
                const data = answer.data;
                var copy = answer;
                copy.data = null;
                copy.release(s.gpa);
                return .{ .failed = .{ .code = code, .message = message, .data = data } };
            },
            .limit => {
                _ = call.charge(answer.charged);
                return .limited;
            },
            .host_error => {
                _ = call.charge(answer.charged);
                return .broken;
            },
        }
    }
    if (!s.in_pump) return .broken;
    s.need = need: {
        const gpa = s.gpa;
        var n: Need = .{
            .kind = .op,
            .entry = s.pumping_entry.?,
            .call = gpa.dupe(u8, call.id) catch return .broken,
            .script = undefined,
            .run = undefined,
            .segment = undefined,
            .grant = undefined,
            .capability = undefined,
            .operation = undefined,
            .scope = undefined,
            .now = call.now,
            .args = &.{},
            .object_kind = &.{},
            .object_id = &.{},
            .prop = &.{},
        };
        n.script = gpa.dupe(u8, call.script) catch return .broken;
        n.run = gpa.dupe(u8, call.run) catch return .broken;
        n.segment = gpa.dupe(u8, call.segment) catch return .broken;
        n.grant = gpa.dupe(u8, call.grant) catch return .broken;
        n.capability = gpa.dupe(u8, oc.capability) catch return .broken;
        n.operation = gpa.dupe(u8, oc.operation) catch return .broken;
        n.scope = gpa.dupe(u8, call.scope) catch return .broken;
        n.mode = oc.mode;
        n.automatic = call.automatic;
        n.fuel_left = if (call.automatic) null else call.left;
        const kept = gpa.alloc(*Value, args.len) catch return .broken;
        for (args, kept) |v, *slot| slot.* = v.retain();
        n.args = kept;
        break :need n;
    };
    return .deferred;
}

fn propAnswer(s: *Session, gpa: Allocator) ?objects.Result {
    const a = &(s.answer orelse return null);
    const answer = a.*;
    s.answer = null;
    switch (answer.kind) {
        .result => return .{ .value = answer.value.? },
        .done => return .done,
        .fail => {
            const code = gpa.dupe(u8, answer.code) catch {
                var copy = answer;
                copy.release(s.gpa);
                return .broken;
            };
            const message: ?[]const u8 = if (answer.message) |m| (gpa.dupe(u8, m) catch {
                gpa.free(code);
                var copy = answer;
                copy.release(s.gpa);
                return .broken;
            }) else null;
            const data = answer.data;
            var copy = answer;
            copy.data = null;
            copy.release(s.gpa);
            return .{ .failed = .{ .code = code, .message = message, .data = data } };
        },
        else => {
            var copy = answer;
            copy.release(s.gpa);
            return .broken;
        },
    }
}

fn propNeed(s: *Session, pc: *PropContext, o: *objects.Object, value: ?*Value) objects.Result {
    if (!s.in_pump) return .broken;
    const gpa = s.gpa;
    s.need = .{
        .kind = .prop,
        .entry = s.pumping_entry.?,
        .call = &.{},
        .script = &.{},
        .run = &.{},
        .segment = &.{},
        .grant = &.{},
        .capability = &.{},
        .operation = &.{},
        .scope = &.{},
        .now = .{ .seconds = 0, .nanos = 0 },
        .args = &.{},
        .object_kind = gpa.dupe(u8, o.kind.name) catch return .broken,
        .object_id = gpa.dupe(u8, o.id) catch return .broken,
        .prop = gpa.dupe(u8, pc.prop) catch return .broken,
        .value = if (value) |v| v.retain() else null,
    };
    return .deferred;
}

fn propGet(context: ?*anyopaque, gpa: Allocator, o: *objects.Object) objects.Result {
    const pc: *PropContext = @ptrCast(@alignCast(context.?));
    if (propAnswer(pc.session, gpa)) |r| return r;
    return propNeed(pc.session, pc, o, null);
}

fn propSet(context: ?*anyopaque, gpa: Allocator, o: *objects.Object, v: *const Value) objects.Result {
    const pc: *PropContext = @ptrCast(@alignCast(context.?));
    if (propAnswer(pc.session, gpa)) |r| return r;
    return propNeed(pc.session, pc, o, @constCast(v));
}

/// Frees an Operation this layer built but no Capability took, with the
/// allocator its parts were made with (the Core's).
fn releaseOp(a: Allocator, op: caps.Operation) void {
    a.free(op.name);
    for (op.args) |x| x.release();
    a.free(op.args);
    if (op.result) |r| r.release();
    for (op.errors) |e| {
        a.free(e.code);
        for (e.fields) |f| {
            a.free(f.key);
            f.shape.release();
        }
        a.free(e.fields);
    }
    a.free(op.errors);
    a.free(op.description);
    for (op.examples) |e| a.free(e);
    a.free(op.examples);
}

/// One Operation from its declaration JSON, its Host function the
/// layer's. Scope and Segment-bound declarations are refused: their
/// lifecycle needs are later work.
fn operationOf(s: *Session, capability: []const u8, j: Json) (Allocator.Error || Invalid)!caps.Operation {
    const a = s.core.gpa;
    if (j != .object) return error.InvalidValue;
    const name = asText(j.object.get("name")) orelse return error.InvalidValue;
    if (name.len == 0) return error.InvalidValue;
    for ([_][]const u8{ "ask", "tell", "send", "wait", "end" }) |refused| if (std.mem.eql(u8, name, refused)) return error.InvalidValue;
    if (j.object.get("scope") != null) return error.InvalidValue;
    if (asBool(j.object.get("segmentBound")) orelse false) return error.InvalidValue;
    const mode = try modeOf(j.object.get("mode"));
    var args: []*caps.Shape = &.{};
    var args_made: usize = 0;
    errdefer {
        for (args[0..args_made]) |x| x.release();
        a.free(args);
    }
    if (j.object.get("args")) |given| {
        if (given != .array) return error.InvalidValue;
        args = try a.alloc(*caps.Shape, given.array.items.len);
        for (given.array.items, args) |item, *slot| {
            slot.* = try shapeOf(a, item, 0);
            args_made += 1;
        }
    }
    var result_shape: ?*caps.Shape = null;
    errdefer if (result_shape) |r| r.release();
    if (j.object.get("result")) |given| result_shape = try shapeOf(a, given, 0);
    var errors: []caps.ErrorDecl = &.{};
    var errors_made: usize = 0;
    errdefer {
        for (errors[0..errors_made]) |e| {
            a.free(e.code);
            for (e.fields) |f| {
                a.free(f.key);
                f.shape.release();
            }
            a.free(e.fields);
        }
        a.free(errors);
    }
    var closed = false;
    if (j.object.get("errors")) |given| {
        if (given != .array) return error.InvalidValue;
        closed = true;
        errors = try a.alloc(caps.ErrorDecl, given.array.items.len);
        for (given.array.items, errors) |item, *slot| {
            const code = asText(field(item, "code")) orelse return error.InvalidValue;
            slot.* = .{ .code = try a.dupe(u8, code), .fields = &.{} };
            errors_made += 1;
            if (field(item, "fields")) |fs| {
                if (fs != .array) return error.InvalidValue;
                const fields = try a.alloc(caps.Field, fs.array.items.len);
                var fmade: usize = 0;
                errdefer {
                    for (fields[0..fmade]) |f| {
                        a.free(f.key);
                        f.shape.release();
                    }
                    a.free(fields);
                }
                for (fs.array.items, fields) |fitem, *fslot| {
                    const key = asText(field(fitem, "key")) orelse return error.InvalidValue;
                    fslot.* = .{
                        .key = try a.dupe(u8, key),
                        .shape = shapeOf(a, field(fitem, "shape") orelse return error.InvalidValue, 0) catch |e| {
                            a.free(fslot.key);
                            return e;
                        },
                        .optional = asBool(field(fitem, "optional")) orelse false,
                    };
                    fmade += 1;
                }
                slot.fields = fields;
            }
        }
    }
    // Documentation for the Host Manifest only (ADR 0076): carried
    // unparsed, and refused when it isn't text / a list of text.
    var description: []const u8 = "";
    errdefer a.free(description);
    if (j.object.get("description")) |given| {
        description = try a.dupe(u8, asText(given) orelse return error.InvalidValue);
    }
    var examples: [][]const u8 = &.{};
    var examples_made: usize = 0;
    errdefer {
        for (examples[0..examples_made]) |e| a.free(e);
        a.free(examples);
    }
    if (j.object.get("examples")) |given| {
        if (given != .array) return error.InvalidValue;
        examples = try a.alloc([]const u8, given.array.items.len);
        for (given.array.items, examples) |item, *slot| {
            slot.* = try a.dupe(u8, asText(item) orelse return error.InvalidValue);
            examples_made += 1;
        }
    }
    const oc = try s.gpa.create(OpContext);
    oc.* = .{
        .session = s,
        .capability = try s.gpa.dupe(u8, capability),
        .operation = try s.gpa.dupe(u8, name),
        .mode = mode,
    };
    s.op_contexts.append(s.gpa, oc) catch {
        s.gpa.free(oc.capability);
        s.gpa.free(oc.operation);
        s.gpa.destroy(oc);
        return error.OutOfMemory;
    };
    return .{
        .name = try a.dupe(u8, name),
        .args = args,
        .result = result_shape,
        .cost = try costOf(j.object.get("cost")),
        .mode = mode,
        .max_pending_ms = if (j.object.get("maxPending")) |x| asU64(x) orelse return error.InvalidValue else 0,
        .errors = errors,
        .closed_errors = closed,
        .description = description,
        .examples = examples,
        .host = .{ .call = opCall, .context = oc },
    };
}

/// Starts an `ok` reply; the caller writes its fields (comma-led), then
/// `finishOk` adds any Trace and closes it.
fn beginOk(o: *Out, ref: i64) Allocator.Error!void {
    try o.raw("{\"ref\":");
    try o.int(ref);
    try o.raw(",\"ok\":{");
}

fn finishOk(s: *Session, o: *Out, entry: ?*GroupEntry) []u8 {
    if (entry) |e| {
        e.group.flush();
        const lines = takeTrace(e);
        defer freeTrace(s.gpa, lines);
        if (e.traced and lines.len > 0) {
            o.raw(",\"trace\":[") catch {};
            for (lines, 0..) |line, i| {
                if (i > 0) o.raw(",") catch {};
                o.text(line) catch {};
            }
            o.raw("]") catch {};
        }
    }
    o.raw("}}") catch {};
    return o.finish() catch oomReply();
}

const oom_text = "{\"ref\":0,\"err\":{\"kind\":\"protocol error\",\"detail\":\"out of memory\"}}";
var oom_buf: [oom_text.len]u8 = oom_text.*;
fn oomReply() []u8 {
    return &oom_buf;
}
/// Frees a reply `handle` made, which the OOM reply above is not.
pub fn freeReply(gpa: Allocator, reply: []u8) void {
    if (reply.ptr != &oom_buf) gpa.free(reply);
}

/// The Group a message names.
fn groupOf(s: *Session, msg: Json) ?*GroupEntry {
    const name = asText(field(msg, "group")) orelse return null;
    return s.groupNamed(name);
}

fn modeName(m: caps.Mode) []const u8 {
    return switch (m) {
        .immediate => "immediate",
        .suspending => "suspending",
        .fire_and_forget => "fire-and-forget",
    };
}

/// The `need` reply a paused Pump gets.
fn needReply(s: *Session, ref: i64) []u8 {
    const n = &s.need.?;
    var o = Out.init(s.gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"need\":{") catch {};
    switch (n.kind) {
        .op => {
            o.raw("\"m\":\"op\",\"call\":") catch {};
            o.text(n.call) catch {};
            o.raw(",\"script\":") catch {};
            o.text(n.script) catch {};
            o.raw(",\"run\":") catch {};
            o.text(n.run) catch {};
            o.raw(",\"segment\":") catch {};
            o.text(n.segment) catch {};
            o.raw(",\"grant\":") catch {};
            o.text(n.grant) catch {};
            o.raw(",\"capability\":") catch {};
            o.text(n.capability) catch {};
            o.raw(",\"operation\":") catch {};
            o.text(n.operation) catch {};
            o.raw(",\"mode\":") catch {};
            o.text(modeName(n.mode)) catch {};
            o.raw(",\"now\":") catch {};
            o.instant(s.gpa, n.now) catch {};
            o.raw(",\"args\":[") catch {};
            for (n.args, 0..) |v, i| {
                if (i > 0) o.raw(",") catch {};
                o.value(v) catch {};
            }
            o.raw("]") catch {};
            if (n.scope.len > 0) {
                o.raw(",\"scope\":") catch {};
                o.text(n.scope) catch {};
            }
            o.raw(",\"automatic\":") catch {};
            o.raw(if (n.automatic) "true" else "false") catch {};
            if (n.fuel_left) |left| {
                o.raw(",\"fuelLeft\":") catch {};
                o.int(left) catch {};
            }
        },
        .prop => {
            o.raw("\"m\":\"prop\",\"object\":{\"$object\":[") catch {};
            o.text(n.object_kind) catch {};
            o.raw(",") catch {};
            o.text(n.object_id) catch {};
            o.raw("]},\"prop\":") catch {};
            o.text(n.prop) catch {};
            if (n.value) |v| {
                o.raw(",\"value\":") catch {};
                o.value(v) catch {};
            }
        },
    }
    o.raw("}}") catch {};
    return o.finish() catch oomReply();
}

/// The Reports a Pump made, taken from the Group, as chapter 9 encodes them.
fn writeReports(o: *Out, entry: *GroupEntry) Allocator.Error!void {
    var held = entry.group.group.reports.take();
    defer held.deinit();
    try o.raw(",\"reports\":[");
    for (held.list.items, 0..) |r, i| {
        if (i > 0) try o.raw(",");
        try writeReport(o, r);
    }
    try o.raw("]");
}

/// A field whose empty text means absent.
fn optionalText(o: *Out, name: []const u8, s: []const u8) Allocator.Error!void {
    if (s.len == 0) return;
    try o.raw(",\"");
    try o.raw(name);
    try o.raw("\":");
    try o.text(s);
}

fn reportValue(o: *Out, v: *const Value) Allocator.Error!void {
    o.value(v) catch |e| switch (e) {
        error.NotEncodable => try o.raw("null"),
        error.OutOfMemory => return error.OutOfMemory,
    };
}

fn textList(o: *Out, xs: []const []const u8) Allocator.Error!void {
    try o.raw("[");
    for (xs, 0..) |x, i| {
        if (i > 0) try o.raw(",");
        try o.text(x);
    }
    try o.raw("]");
}

fn outcomeWord(outcome: machine.report.Outcome) []const u8 {
    return switch (outcome) {
        .completed => "completed",
        .errored => "errored",
        .limit_fault => "limit fault",
        .cancelled => "cancelled",
        .unhandled => "unhandled",
        .dropped => "dropped",
        .effect_failure => "effect failed",
    };
}

/// An effect failure's fields, after the caller's opening brace.
fn effectFields(o: *Out, e: machine.report.EffectFailure) Allocator.Error!void {
    try o.raw("\"script\":");
    try o.text(e.script);
    try o.raw(",\"run\":");
    try o.text(e.run);
    try o.raw(",\"grant\":");
    try o.text(e.grant);
    try o.raw(",\"segment\":");
    try o.text(e.segment);
    try o.raw(",\"phase\":");
    try o.text(e.phase);
    try o.raw(",\"status\":");
    try o.text(e.status);
    try optionalText(o, "scope", e.scope);
}

/// Where a Run's work came from, as fields after the caller's others.
fn ancestryFields(o: *Out, a: machine.report.Ancestry) Allocator.Error!void {
    try o.raw(",\"rootDelivery\":");
    try o.text(a.root);
    try optionalText(o, "parentRun", a.parent_run);
    try optionalText(o, "parentCall", a.parent_call);
}

fn writeReport(o: *Out, report: machine.report.Report) Allocator.Error!void {
    switch (report) {
        .run_end => |r| {
            try o.raw("{\"kind\":\"run end\",\"script\":");
            try o.text(r.script);
            try optionalText(o, "run", r.run);
            try optionalText(o, "delivery", r.delivery);
            try optionalText(o, "broadcast", r.broadcast);
            try optionalText(o, "handler", r.handler);
            if (r.fallback) try o.raw(",\"fallback\":true");
            try o.raw(",\"outcome\":");
            try o.text(outcomeWord(r.outcome));
            if (r.result) |v| {
                try o.raw(",\"result\":");
                try reportValue(o, v);
            }
            if (r.err) |v| {
                try o.raw(",\"error\":");
                try reportValue(o, v);
            }
            try optionalText(o, "limit", r.limit);
            if (r.effect) |e| {
                try o.raw(",\"effect\":{");
                try effectFields(o, e);
                try o.raw("}");
            }
            if (r.cleanup_failed) |c| {
                try o.raw(",\"cleanupFailed\":{");
                if (c.code.len > 0) {
                    try o.raw("\"code\":");
                    try o.text(c.code);
                } else {
                    try o.raw("\"limit\":");
                    try o.text(c.limit);
                }
                try o.raw("}");
            }
            if (r.at.unit.len > 0) {
                try o.raw(",\"at\":{\"unit\":");
                try o.text(r.at.unit);
                try o.raw(",\"line\":");
                try o.int(r.at.line);
                try o.raw(",\"col\":");
                try o.int(r.at.column);
                try o.raw(",\"handler\":");
                try o.text(r.at.handler);
                try o.raw(",\"pc\":");
                try o.int(r.at.pc);
                try o.raw("}");
            }
            try o.raw(",\"fuel\":");
            try o.int(r.fuel);
            try o.raw(",\"alloc\":");
            try o.int(r.alloc);
            try o.raw("}");
        },
        .stop => |r| {
            try o.raw("{\"kind\":\"stop\",\"script\":");
            try o.text(r.script);
            try o.raw(",\"reason\":");
            try o.text(r.reason);
            try o.raw(",\"discardedRuns\":");
            try textList(o, r.discarded_runs);
            try o.raw(",\"droppedMessages\":");
            try textList(o, r.dropped_messages);
            try o.raw(",\"pendingCalls\":");
            try textList(o, r.pending_calls);
            try o.raw("}");
        },
        .unhandled => |r| {
            try o.raw("{\"kind\":\"unhandled\",\"delivery\":");
            try o.text(r.delivery);
            try o.raw(",\"message\":{\"name\":");
            try o.text(r.message);
            try o.raw(",\"args\":[");
            for (r.args, 0..) |v, i| {
                if (i > 0) try o.raw(",");
                try reportValue(o, v);
            }
            try o.raw("]}");
            if (r.target) |t| {
                try o.raw(",\"target\":");
                try reportValue(o, t.value);
            }
            try o.raw("}");
        },
        .call_failed => |r| {
            try o.raw("{\"kind\":\"call failed\",\"script\":");
            try o.text(r.script);
            try o.raw(",\"call\":");
            try o.text(r.call);
            try o.raw(",\"operation\":{\"capability\":");
            try o.text(r.capability);
            try o.raw(",\"operation\":");
            try o.text(r.operation);
            try o.raw("},\"detail\":");
            try o.text(r.detail);
            try o.raw("}");
        },
        .effect_failure => |e| {
            try o.raw("{\"kind\":\"effect failure\",");
            try effectFields(o, e);
            try o.raw("}");
        },
        .decided => |r| {
            try o.raw("{\"kind\":\"decided\"");
            try optionalText(o, "delivery", r.delivery);
            try optionalText(o, "broadcast", r.broadcast);
            try o.raw(",\"verdict\":");
            try o.text(@tagName(r.verdict));
            try o.raw(",\"vetoes\":[");
            for (r.vetoes, 0..) |v, i| {
                if (i > 0) try o.raw(",");
                try o.raw("{\"script\":");
                try o.text(v.script);
                try o.raw(",\"run\":");
                try o.text(v.run);
                try o.raw(",\"reason\":");
                try reportValue(o, v.reason);
                try o.raw("}");
            }
            try o.raw("],\"undecided\":[");
            for (r.undecided, 0..) |u, i| {
                if (i > 0) try o.raw(",");
                try o.raw("{\"script\":");
                try o.text(u.script);
                try o.raw(",\"run\":");
                try o.text(u.run);
                try o.raw(",\"outcome\":");
                try o.text(outcomeWord(u.outcome));
                try o.raw("}");
            }
            try o.raw("]}");
        },
        .run_started => |r| {
            try o.raw("{\"kind\":\"run started\",\"script\":");
            try o.text(r.script);
            try o.raw(",\"run\":");
            try o.text(r.run);
            try o.raw(",\"args\":[");
            for (r.args, 0..) |v, i| {
                if (i > 0) try o.raw(",");
                try reportValue(o, v);
            }
            try o.raw("]");
            try ancestryFields(o, r.ancestry);
            try optionalText(o, "delivery", r.delivery);
            try optionalText(o, "selector", r.selector);
            if (r.function) |f| {
                try o.raw(",\"fn\":");
                try reportValue(o, f);
            }
            try o.raw("}");
        },
        .run_discarded => |r| {
            try o.raw("{\"kind\":\"run discarded\",\"script\":");
            try o.text(r.script);
            try o.raw(",\"run\":");
            try o.text(r.run);
            try o.raw(",\"reason\":");
            try o.text(r.reason);
            try ancestryFields(o, r.ancestry);
            try o.raw("}");
        },
        .run_accounting => |r| {
            try o.raw("{\"kind\":\"run accounting\",\"script\":");
            try o.text(r.script);
            try o.raw(",\"run\":");
            try o.text(r.run);
            try o.raw(",\"fuel\":");
            try o.int(r.fuel);
            try o.raw(",\"state\":");
            try o.text(@tagName(r.state));
            try ancestryFields(o, r.ancestry);
            try o.raw("}");
        },
        .causal_work => |r| {
            try o.raw("{\"kind\":\"causal work\",\"rootDelivery\":");
            try o.text(r.root);
            try o.raw(",\"liveRuns\":");
            try o.int(r.live_runs);
            try o.raw(",\"queuedMessages\":");
            try o.int(r.queued_messages);
            try o.raw(",\"discardedMessages\":");
            try o.int(r.discarded_messages);
            try o.raw("}");
        },
        .host_error => |r| {
            try o.raw("{\"kind\":\"host error\",\"code\":");
            try o.text(r.code);
            try optionalText(o, "detail", r.detail);
            try o.raw("}");
        },
    }
}

fn pumpOk(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    var o = Out.init(s.gpa);
    defer o.deinit();
    const mg = &entry.group.group;
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"state\":") catch {};
    o.text(if (mg.stoppedState()) "stopped" else if (mg.rewound) "rewound" else if (mg.sliced) "sliced" else "idle") catch {};
    o.raw(",\"nextDeadline\":") catch {};
    if (mg.next()) |deadline| {
        const at: model.dates.Instant = .{ .seconds = @intCast(@divFloor(deadline, std.time.ns_per_s)), .nanos = @intCast(@mod(deadline, std.time.ns_per_s)) };
        o.instant(s.gpa, at) catch return oomReply();
    } else o.raw("null") catch {};
    o.raw(",\"fuelUsed\":") catch {};
    o.int(mg.pump_fuel) catch {};
    writeReports(&o, entry) catch return oomReply();
    o.raw(",\"abandoned\":[]") catch {};
    return finishOk(s, &o, entry);
}

/// Runs or resumes a Pump until it ends or pauses at a crossing, and
/// writes its reply.
fn runPump(s: *Session, ref: i64, entry: *GroupEntry, resuming: bool, now: model.dates.Instant, slice: u64, cap: u64) []u8 {
    if (entry.group.memory.refused) return hostError(s.gpa, ref, .out_of_memory);
    s.in_pump = true;
    s.pumping_entry = entry;
    defer {
        s.in_pump = false;
        s.pumping_entry = null;
    }
    const mg = &entry.group.group;
    if (resuming) mg.resumePump() catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value) else mg.pumpWith(now, slice, cap) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    entry.group.flush();
    if (mg.pumpPaused()) {
        s.paused_ref = ref;
        return needReply(s, ref);
    }
    return pumpOk(s, ref, entry);
}

/// An error Data map's value, from a result's `fail`/`error` object.
fn failureOf(s: *Session, entry: ?*GroupEntry, j: Json, answer: *Answer) (Allocator.Error || Invalid)!void {
    const code = asText(field(j, "code")) orelse return error.InvalidValue;
    answer.code = try s.gpa.dupe(u8, code);
    errdefer {
        s.gpa.free(answer.code);
        answer.code = "";
    }
    if (asText(field(j, "message"))) |m| answer.message = try s.gpa.dupe(u8, m);
    errdefer if (answer.message) |m| {
        s.gpa.free(m);
        answer.message = null;
    };
    if (field(j, "data")) |d| if (d != .null) {
        answer.data = decodeValue(s.gpa, d, entry) catch |e| return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    };
}

/// Answers the paused Pump's need and resumes it.
fn answerNeed(s: *Session, msg: Json, ref: i64, is_prop: bool) []u8 {
    const need = s.need.?;
    const entry = need.entry;
    var answer: Answer = .{ .kind = .host_error };
    answer.charged = asU64(field(msg, "charged")) orelse 0;
    if (is_prop) {
        if (field(msg, "value")) |v| {
            answer.kind = .result;
            answer.value = decodeValue(s.gpa, v, entry) catch return hostError(s.gpa, ref, .invalid_value);
        } else if (field(msg, "ok") != null) {
            answer.kind = .done;
        } else if (field(msg, "fail")) |f| {
            answer.kind = .fail;
            failureOf(s, entry, f, &answer) catch return hostError(s.gpa, ref, .invalid_value);
        } else if (field(msg, "hostError") != null) {
            answer.kind = .host_error;
        } else return protocolError(s.gpa, ref, "a prop-result with no outcome");
    } else {
        if (field(msg, "result")) |v| {
            answer.kind = .result;
            answer.value = decodeValue(s.gpa, v, entry) catch return hostError(s.gpa, ref, .invalid_value);
        } else if (field(msg, "started") != null) {
            answer.kind = .started;
        } else if (field(msg, "done") != null) {
            answer.kind = .done;
        } else if (field(msg, "fail")) |f| {
            answer.kind = .fail;
            failureOf(s, entry, f, &answer) catch return hostError(s.gpa, ref, .invalid_value);
        } else if (field(msg, "limit") != null) {
            answer.kind = .limit;
        } else if (field(msg, "hostError") != null) {
            answer.kind = .host_error;
        } else return protocolError(s.gpa, ref, "an op-result with no outcome");
    }
    s.answer = answer;
    var spent = need;
    s.need = null;
    s.paused_ref = null;
    spent.release(s.gpa);
    return runPump(s, ref, entry, true, .{ .seconds = 0, .nanos = 0 }, 0, 0);
}

fn helloReply(s: *Session, ref: i64) []u8 {
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    const v = talk.versions;
    o.raw("\"language\":") catch {};
    o.text(v.language) catch {};
    o.raw(",\"costModel\":") catch {};
    o.text(v.cost_model) catch {};
    o.raw(",\"unicode\":") catch {};
    o.text(v.unicode) catch {};
    o.raw(",\"core\":") catch {};
    o.text(v.core) catch {};
    o.raw(",\"saveFormat\":") catch {};
    o.text(v.save_format) catch return oomReply();
    return finishOk(s, &o, null);
}

fn kindName(v: *const Value) []const u8 {
    return switch (v.data) {
        .nothing => "nothing",
        .bool => "boolean",
        .number => "number",
        .quantity => "quantity",
        .text => "text",
        .bytes => "bytes",
        .list => "list",
        .map => "map",
        .range => "range",
        .civil_date => "civil date",
        .instant => "instant",
        .pattern => "pattern",
        .object => "object",
        .function => "function",
    };
}

/// `add`: the `+` rules outside a Run. A failure is `fail` inside `ok`;
/// a value that does not decode is a host error.
fn addReply(s: *Session, msg: Json, ref: i64) []u8 {
    const gpa = s.gpa;
    const aj = field(msg, "a") orelse return hostError(gpa, ref, .invalid_value);
    const bj = field(msg, "b") orelse return hostError(gpa, ref, .invalid_value);
    const a = decodeValue(gpa, aj, null) catch |e| return hostError(gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    defer a.release();
    const b = decodeValue(gpa, bj, null) catch |e| return hostError(gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    defer b.release();
    var o = Out.init(gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    const r = model.arithmetic(gpa, .add, a, b) catch |e| {
        const code: []const u8 = switch (e) {
            error.IncompatibleUnits => "incompatible units",
            error.Overflow => "overflow",
            error.OutOfMemory => return hostError(gpa, ref, .out_of_memory),
            else => "wrong kind",
        };
        o.raw("\"fail\":{\"code\":") catch {};
        o.text(code) catch {};
        o.raw(",\"message\":") catch {};
        o.text(code) catch {};
        o.raw(",\"data\":{") catch {};
        if (std.mem.eql(u8, code, "wrong kind")) {
            const bad = if (a.data != .number and a.data != .quantity) a else b;
            o.raw("\"expected\":\"number\",\"got\":") catch {};
            o.text(kindName(bad)) catch {};
            o.raw(",\"value\":") catch {};
            o.value(bad) catch {};
        }
        o.raw("}}") catch {};
        return finishOk(s, &o, null);
    };
    defer r.release();
    o.raw("\"value\":") catch {};
    o.value(r) catch return oomReply();
    return finishOk(s, &o, null);
}

fn defineCapabilityReply(s: *Session, msg: Json, ref: i64) []u8 {
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    if (asBool(field(msg, "segmentLifecycle")) orelse false) return hostError(s.gpa, ref, .invalid_value);
    if (asBool(field(msg, "release")) orelse false) return hostError(s.gpa, ref, .invalid_value);
    const ops_j = field(msg, "ops") orelse return hostError(s.gpa, ref, .invalid_value);
    if (ops_j != .array) return hostError(s.gpa, ref, .invalid_value);
    const a = s.core.gpa;
    const ops = a.alloc(caps.Operation, ops_j.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
    var made: usize = 0;
    for (ops_j.array.items, ops) |item, *slot| {
        slot.* = operationOf(s, name, item) catch |e| {
            for (ops[0..made]) |op| releaseOp(a, op);
            a.free(ops);
            return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
        };
        made += 1;
    }
    var def: ?*caps.Capability = null;
    const code = talk.defineCapabilityZig(s.core, name, ops, &def);
    if (code != .ok) {
        for (ops) |op| releaseOp(a, op);
        a.free(ops);
        return hostError(s.gpa, ref, code);
    }
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, null);
}

fn grantReply(s: *Session, msg: Json, ref: i64) []u8 {
    const capability = asText(field(msg, "capability")) orelse return hostError(s.gpa, ref, .invalid_value);
    if (field(msg, "coordinator") != null) return hostError(s.gpa, ref, .invalid_value);
    const def = s.capabilityNamed(capability) orelse return hostError(s.gpa, ref, .invalid_value);
    var grant: ?*caps.Grant = null;
    const ops_j = field(msg, "ops") orelse return hostError(s.gpa, ref, .invalid_value);
    const code = blk: {
        if (asText(ops_j)) |word| {
            if (!std.mem.eql(u8, word, "all")) return hostError(s.gpa, ref, .invalid_value);
            break :blk Direct.grantAll(def, null, &grant);
        }
        if (ops_j != .array) return hostError(s.gpa, ref, .invalid_value);
        const names = s.gpa.alloc(?[*]const u8, ops_j.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
        defer s.gpa.free(names);
        const lens = s.gpa.alloc(usize, ops_j.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
        defer s.gpa.free(lens);
        for (ops_j.array.items, names, lens) |item, *n, *l| {
            const t = asText(item) orelse return hostError(s.gpa, ref, .invalid_value);
            n.* = t.ptr;
            l.* = t.len;
        }
        break :blk Direct.grant(def, if (names.len == 0) null else names.ptr, if (lens.len == 0) null else lens.ptr, names.len, null, &grant);
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    s.grants.append(s.gpa, grant.?) catch return hostError(s.gpa, ref, .out_of_memory);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"grant\":") catch {};
    o.int(@intCast(s.grants.items.len)) catch {};
    return finishOk(s, &o, null);
}

fn newGroupReply(s: *Session, msg: Json, ref: i64) []u8 {
    const group_handle = asText(field(msg, "group")) orelse asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const name = asText(field(msg, "name")) orelse group_handle;
    if (s.groupNamed(group_handle) != null) return hostError(s.gpa, ref, .name_reused);
    const entry = s.gpa.create(GroupEntry) catch return hostError(s.gpa, ref, .out_of_memory);
    entry.* = .{
        .gpa = s.gpa,
        .name = s.gpa.dupe(u8, group_handle) catch {
            s.gpa.destroy(entry);
            return hostError(s.gpa, ref, .out_of_memory);
        },
        .group = undefined,
        .traced = asBool(field(msg, "trace")) orelse false,
    };
    var group: ?*talk.Group = null;
    // No physical cap below the runtime's: over WASI the Host's store
    // limit is the backstop, as it is for the Go reactor, and the logical
    // budgets still charge every Run.
    const options: talk.GroupOptions = .{ .name = name.ptr, .name_len = name.len, .trace = traceSink, .trace_context = entry, .memory_cap = std.math.maxInt(usize) };
    const code = Direct.newGroup(s.core, &options, &group);
    if (code != .ok) {
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return hostError(s.gpa, ref, code);
    }
    entry.group = group.?;
    s.groups.append(s.gpa, entry) catch return hostError(s.gpa, ref, .out_of_memory);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

fn loadReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    const owner = if (field(msg, "owner")) |j| objectOf(entry, j) orelse return hostError(s.gpa, ref, .invalid_value) else null;
    var load_objects: []talk.LoadObject = &.{};
    defer s.gpa.free(load_objects);
    if (field(msg, "objects")) |given| {
        if (given != .object) return hostError(s.gpa, ref, .invalid_value);
        load_objects = s.gpa.alloc(talk.LoadObject, given.object.count()) catch return hostError(s.gpa, ref, .out_of_memory);
        for (given.object.keys(), given.object.values(), load_objects) |k, v, *slot| {
            const object = objectOf(entry, v) orelse return hostError(s.gpa, ref, .invalid_value);
            slot.* = .{ .name = k.ptr, .name_len = k.len, .object = object };
        }
    }
    var load_grants: []talk.LoadGrant = &.{};
    defer s.gpa.free(load_grants);
    if (field(msg, "grants")) |g| {
        if (g != .object) return hostError(s.gpa, ref, .invalid_value);
        load_grants = s.gpa.alloc(talk.LoadGrant, g.object.count()) catch return hostError(s.gpa, ref, .out_of_memory);
        for (g.object.keys(), g.object.values(), load_grants) |k, v, *slot| {
            const h = asInt(v) orelse return hostError(s.gpa, ref, .invalid_value);
            if (h < 1 or h > @as(i64, @intCast(s.grants.items.len))) return hostError(s.gpa, ref, .invalid_value);
            slot.* = .{ .name = k.ptr, .name_len = k.len, .grant = s.grants.items[@intCast(h - 1)] };
        }
    }
    var limits_slot: talk.Limits = undefined;
    const limits = limitsOf(field(msg, "limits"), &limits_slot) catch return hostError(s.gpa, ref, .invalid_value);
    // Trace lines from earlier work are not this load's.
    entry.group.flush();
    freeTrace(s.gpa, takeTrace(entry));
    var script: ?*talk.Script = null;
    const options: talk.LoadOptions = .{
        .name = name.ptr,
        .name_len = name.len,
        .source = source.ptr,
        .source_len = source.len,
        .grants = if (load_grants.len == 0) null else load_grants.ptr,
        .grants_len = load_grants.len,
        .grants_as_used = asBool(field(msg, "grantsAsUsed")) orelse false,
        .owner = owner,
        .objects = if (load_objects.len == 0) null else load_objects.ptr,
        .objects_len = load_objects.len,
        .limits = limits,
    };
    const code = Direct.load(entry.group, &options, &script);
    entry.group.flush();
    if (code == .load_refused) {
        const lines = takeTrace(entry);
        defer freeTrace(s.gpa, lines);
        return loadError(s.gpa, ref, lines);
    }
    if (code != .ok) {
        freeTrace(s.gpa, takeTrace(entry));
        return hostError(s.gpa, ref, code);
    }
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"script\":") catch {};
    o.text(name) catch {};
    return finishOk(s, &o, entry);
}

/// How a queued message asks: `deliver`, `request`, `decide` or `broadcast`.
const Asking = enum { deliver, request, decide, broadcast };

fn queuedReply(s: *Session, msg: Json, ref: i64, how: Asking) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    // A Broadcast, or a Broadcast Decision, has no `to`; otherwise `to`
    // names a Script or a Host Object, never both.
    const to_all = how == .broadcast or (how == .decide and (asBool(field(msg, "broadcast")) orelse false));
    var script: ?*talk.Script = null;
    var target: ?*objects.Object = null;
    if (to_all) {
        if (field(msg, "to") != null) return hostError(s.gpa, ref, .invalid_value);
    } else {
        const to = field(msg, "to") orelse return hostError(s.gpa, ref, .invalid_value);
        if (field(to, "script")) |j| {
            if (field(to, "object") != null) return hostError(s.gpa, ref, .invalid_value);
            const script_name = asText(j) orelse return hostError(s.gpa, ref, .invalid_value);
            script = Direct.groupScript(entry.group, script_name.ptr, script_name.len) orelse return hostError(s.gpa, ref, .invalid_value);
        } else {
            target = objectOf(entry, field(to, "object") orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value);
        }
    }
    const message = field(msg, "message") orelse return hostError(s.gpa, ref, .invalid_value);
    const mname = asText(field(message, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    var args: []*Value = &.{};
    defer {
        for (args) |v| v.release();
        s.gpa.free(args);
    }
    if (field(message, "args")) |given| {
        if (given != .array) return hostError(s.gpa, ref, .invalid_value);
        args = s.gpa.alloc(*Value, given.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
        var made: usize = 0;
        for (given.array.items, args) |item, *slot| {
            slot.* = decodeValue(s.gpa, item, entry) catch |e| {
                for (args[0..made]) |v| v.release();
                s.gpa.free(args);
                args = &.{};
                return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
            };
            made += 1;
        }
    }
    var override_slot: talk.LimitOverride = undefined;
    const override = overrideOf(field(message, "limits"), &override_slot) catch return hostError(s.gpa, ref, .invalid_value);
    const m: talk.Message = .{ .name = mname.ptr, .name_len = mname.len, .args = if (args.len == 0) null else args.ptr, .args_len = args.len, .limits = override };
    var id: talk.Buffer = .{};
    // Pending Requests and Decisions belong to the Group, which reports
    // how they end; the handles aren't needed here.
    var pending: ?*talk.Pending = null;
    var deciding: ?*talk.Deciding = null;
    const code = switch (how) {
        .deliver => if (script) |sc| Direct.scriptDeliver(sc, &m, &id) else Direct.deliver(entry.group, target.?, &m, &id),
        .request => if (script) |sc| Direct.scriptRequest(sc, &m, &id, &pending) else Direct.request(entry.group, target.?, &m, &id, &pending),
        .decide => if (to_all) Direct.decideBroadcast(entry.group, &m, &id, &deciding) else if (script) |sc| Direct.scriptDecide(sc, &m, &id, &deciding) else Direct.decide(entry.group, target.?, &m, &id, &deciding),
        .broadcast => Direct.broadcast(entry.group, &m, &id),
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    defer Direct.ownedBytesRelease(&id);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw(if (to_all) "\"broadcast\":" else "\"delivery\":") catch {};
    o.text(if (id.data) |d| d[0..id.len] else "") catch {};
    return finishOk(s, &o, entry);
}

fn pumpReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const now_text = asText(field(msg, "now")) orelse return hostError(s.gpa, ref, .invalid_value);
    const now = model.dates.parseInstant(now_text) catch return hostError(s.gpa, ref, .invalid_value);
    model.dates.validateInstant(now) catch return hostError(s.gpa, ref, .invalid_value);
    const slice = if (field(msg, "fuelSlice")) |x| asU64(x) orelse return hostError(s.gpa, ref, .invalid_value) else 0;
    const cap = if (field(msg, "fuelCap")) |x| asU64(x) orelse return hostError(s.gpa, ref, .invalid_value) else 0;
    return runPump(s, ref, entry, false, now, slice, cap);
}

/// Settles a suspending call the Host started (`answer` / `fail`).
fn settleReply(s: *Session, msg: Json, ref: i64, is_fail: bool) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const call_id = asText(field(msg, "call")) orelse return hostError(s.gpa, ref, .invalid_value);
    var call: ?*caps.Call = null;
    for (entry.group.group.calls.items) |c| if (std.mem.eql(u8, c.id, call_id)) {
        call = c;
    };
    const c = call orelse return hostError(s.gpa, ref, .unknown_call);
    const code = if (is_fail) blk: {
        const e = field(msg, "error") orelse break :blk Direct.callFail(c, null);
        const ecode = asText(field(e, "code")) orelse return hostError(s.gpa, ref, .invalid_value);
        const emessage = asText(field(e, "message"));
        var data: ?*Value = null;
        if (field(e, "data")) |d| if (d != .null) {
            data = decodeValue(s.gpa, d, entry) catch return hostError(s.gpa, ref, .invalid_value);
        };
        defer if (data) |d| d.release();
        const failure: talk.ScriptError = .{ .code = ecode.ptr, .code_len = ecode.len, .message = if (emessage) |m| m.ptr else null, .message_len = if (emessage) |m| m.len else 0, .data = data };
        break :blk Direct.callFail(c, &failure);
    } else blk: {
        const vj = field(msg, "value") orelse return hostError(s.gpa, ref, .invalid_value);
        const v = decodeValue(s.gpa, vj, entry) catch return hostError(s.gpa, ref, .invalid_value);
        defer v.release();
        break :blk Direct.callAnswer(c, v);
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

fn saveReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    var buf: talk.Buffer = .{};
    const code = Direct.save(entry.group, &buf);
    if (code != .ok) return hostError(s.gpa, ref, code);
    defer Direct.ownedBytesRelease(&buf);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"save\":") catch {};
    o.bytesTag(s.gpa, if (buf.data) |d| d[0..buf.len] else "") catch return oomReply();
    return finishOk(s, &o, entry);
}

fn fingerprintReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    var print: [32]u8 = undefined;
    const code = Direct.fingerprint(entry.group, &print);
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"fingerprint\":") catch {};
    o.bytesTag(s.gpa, &print) catch return oomReply();
    return finishOk(s, &o, entry);
}

fn defineObjectKindReply(s: *Session, msg: Json, ref: i64) []u8 {
    const a = s.core.gpa;
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    if (name.len == 0) return hostError(s.gpa, ref, .invalid_value);
    for (s.core.kinds.items) |k| if (std.mem.eql(u8, k.name, name)) return hostError(s.gpa, ref, .name_reused);
    const props_j = field(msg, "props") orelse return hostError(s.gpa, ref, .invalid_value);
    if (props_j != .array) return hostError(s.gpa, ref, .invalid_value);
    const props = a.alloc(objects.Prop, props_j.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
    var made: usize = 0;
    var failed = false;
    for (props_j.array.items, props) |item, *slot| {
        const pname = asText(field(item, "name")) orelse {
            failed = true;
            break;
        };
        const shape = shapeOf(a, field(item, "shape") orelse {
            failed = true;
            break;
        }, 0) catch {
            failed = true;
            break;
        };
        const pc = s.gpa.create(PropContext) catch {
            shape.release();
            failed = true;
            break;
        };
        pc.* = .{ .session = s, .kind = s.gpa.dupe(u8, name) catch {
            shape.release();
            s.gpa.destroy(pc);
            failed = true;
            break;
        }, .prop = s.gpa.dupe(u8, pname) catch {
            shape.release();
            s.gpa.free(pc.kind);
            s.gpa.destroy(pc);
            failed = true;
            break;
        } };
        s.prop_contexts.append(s.gpa, pc) catch {
            shape.release();
            failed = true;
            break;
        };
        slot.* = .{
            .name = a.dupe(u8, pname) catch {
                shape.release();
                failed = true;
                break;
            },
            .shape = shape,
            .get = .{ .call = propGet, .context = pc },
            .set = if (asBool(field(item, "readOnly")) orelse false) null else .{ .call = propSet, .context = pc },
            .get_cost = costOf(field(item, "getCost")) catch {
                shape.release();
                failed = true;
                break;
            },
            .set_cost = costOf(field(item, "setCost")) catch {
                shape.release();
                failed = true;
                break;
            },
        };
        made += 1;
    }
    if (failed) {
        for (props[0..made]) |p| {
            a.free(p.name);
            p.shape.release();
        }
        a.free(props);
        return hostError(s.gpa, ref, .invalid_value);
    }
    var parents: [][]const u8 = &.{};
    if (field(msg, "parentKinds")) |given| {
        if (given != .array) return hostError(s.gpa, ref, .invalid_value);
        parents = a.alloc([]const u8, given.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
        for (given.array.items, parents) |item, *slot| {
            const t = asText(item) orelse return hostError(s.gpa, ref, .invalid_value);
            slot.* = a.dupe(u8, t) catch return hostError(s.gpa, ref, .out_of_memory);
        }
    }
    const kind = a.create(objects.Kind) catch return hostError(s.gpa, ref, .out_of_memory);
    kind.* = .{ .name = a.dupe(u8, name) catch return hostError(s.gpa, ref, .out_of_memory), .props = props, .parent_kinds = parents };
    s.core.kinds.append(a, kind) catch return hostError(s.gpa, ref, .out_of_memory);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, null);
}

fn kindNamed(s: *Session, name: []const u8) ?*objects.Kind {
    for (s.core.kinds.items) |k| if (std.mem.eql(u8, k.name, name)) return k;
    return null;
}

fn objectReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const kind_name = asText(field(msg, "kind")) orelse return hostError(s.gpa, ref, .invalid_value);
    const id = asText(field(msg, "id")) orelse return hostError(s.gpa, ref, .invalid_value);
    const kind = kindNamed(s, kind_name) orelse return hostError(s.gpa, ref, .invalid_value);
    var object: ?*objects.Object = null;
    const code = Direct.groupObject(entry.group, kind, id.ptr, id.len, null, &object);
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// The Host Object `{"$object":[kind,id]}` names in `entry`'s Group,
/// disposed or not; null if the Group never made it.
fn objectOf(entry: *GroupEntry, j: Json) ?*objects.Object {
    const pair = field(j, "$object") orelse return null;
    if (pair != .array or pair.array.items.len != 2) return null;
    const kind = asText(pair.array.items[0]) orelse return null;
    const id = asText(pair.array.items[1]) orelse return null;
    var out: ?*objects.Object = null;
    return if (Direct.objectById(entry.group, kind.ptr, kind.len, id.ptr, id.len, &out)) out else null;
}

/// `set-parent` (a missing or null `parent` ends the chain) and `dispose`.
fn objectInputReply(s: *Session, msg: Json, ref: i64, is_dispose: bool) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const object = objectOf(entry, field(msg, "object") orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value);
    const code = if (is_dispose) Direct.dispose(entry.group, object) else blk: {
        const parent = if (field(msg, "parent")) |j| (if (j == .null) null else objectOf(entry, j) orelse return hostError(s.gpa, ref, .invalid_value)) else null;
        break :blk Direct.setParent(entry.group, object, parent);
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// The Script a message names, in its Group.
fn scriptOf(entry: *GroupEntry, msg: Json) ?*talk.Script {
    const name = asText(field(msg, "script")) orelse return null;
    return Direct.groupScript(entry.group, name.ptr, name.len);
}

fn countersReply(s: *Session, msg: Json, ref: i64) []u8 {
    // The shared reactor harness (tools/wasi/check.py) holds both
    // reactors to a protocol error for counters naming a Group or
    // Script the instance doesn't hold.
    const entry = groupOf(s, msg) orelse return protocolError(s.gpa, ref, "unknown group");
    const script = scriptOf(entry, msg) orelse return protocolError(s.gpa, ref, "unknown script");
    var read: talk.Counters = undefined;
    Direct.scriptCounters(script, &read);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"fuelTotal\":") catch {};
    o.int(read.fuel_total) catch {};
    o.raw(",\"allocTotal\":") catch {};
    o.int(read.alloc_total) catch {};
    o.raw(",\"runs\":") catch {};
    o.int(read.runs) catch {};
    o.raw(",\"faults\":") catch {};
    o.int(read.faults) catch {};
    o.raw(",\"persistentState\":") catch {};
    o.int(read.persistent_state) catch {};
    o.raw(",\"mailboxLen\":") catch {};
    o.int(read.mailbox_len) catch {};
    return finishOk(s, &o, entry);
}

/// `stop`, `cancel-run`, `rewind-run` and `revoke`: Host Inputs that land
/// at the next Pump (or its next crossing), queued by the Core call.
fn scriptControlReply(s: *Session, msg: Json, ref: i64, kind: enum { stop, cancel_run, rewind_run, revoke }) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const script = scriptOf(entry, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const code = switch (kind) {
        .stop => blk: {
            const reason = asText(field(msg, "reason")) orelse break :blk talk.HostErrorCode.invalid_value;
            break :blk Direct.scriptStop(script, reason.ptr, reason.len);
        },
        .cancel_run => blk: {
            const run = asText(field(msg, "run")) orelse break :blk talk.HostErrorCode.invalid_value;
            break :blk Direct.scriptCancelRun(script, run.ptr, run.len);
        },
        .rewind_run => blk: {
            const run = asText(field(msg, "run")) orelse break :blk talk.HostErrorCode.invalid_value;
            break :blk Direct.scriptRewindRun(script, run.ptr, run.len);
        },
        .revoke => blk: {
            const grant = asText(field(msg, "grant")) orelse break :blk talk.HostErrorCode.invalid_value;
            break :blk Direct.scriptRevoke(script, grant.ptr, grant.len);
        },
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

fn cancelDeliveryReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const delivery = asText(field(msg, "delivery")) orelse return hostError(s.gpa, ref, .invalid_value);
    const code = Direct.cancelDelivery(entry.group, delivery.ptr, delivery.len);
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// A frame's JSON nesting, brackets outside strings.
fn frameDepth(frame: []const u8) usize {
    var depth: usize = 0;
    var peak: usize = 0;
    var in_string = false;
    var escaped = false;
    for (frame) |c| {
        if (in_string) {
            if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') in_string = false;
        } else if (c == '"') in_string = true else if (c == '[' or c == '{') {
            depth += 1;
            peak = @max(peak, depth);
        } else if (c == ']' or c == '}') depth -|= 1;
    }
    return peak;
}

/// Handles one frame and returns its reply frame, owned by the caller
/// (free it with `freeReply`). Never fails: a malformed frame is a
/// protocol error, and the instance carries on.
pub fn handle(s: *Session, frame: []const u8) []u8 {
    if (!std.unicode.utf8ValidateSlice(frame)) return protocolError(s.gpa, 0, "the frame is not UTF-8");
    if (frameDepth(frame) > max_depth) return protocolError(s.gpa, 0, "the frame nests too deep");
    const parsed = std.json.parseFromSlice(Json, s.gpa, frame, .{ .parse_numbers = false, .max_value_len = max_frame }) catch |e| return if (e == error.OutOfMemory) oomReply() else protocolError(s.gpa, 0, "the frame is not JSON");
    defer parsed.deinit();
    const msg = parsed.value;
    if (msg != .object) return protocolError(s.gpa, 0, "the frame is not an object");
    const ref = asInt(field(msg, "ref")) orelse return protocolError(s.gpa, 0, "no ref");
    const m = asText(field(msg, "m")) orelse return protocolError(s.gpa, ref, "no message name");
    if (s.paused_ref) |paused| {
        const is_op = std.mem.eql(u8, m, "op-result");
        const is_prop = std.mem.eql(u8, m, "prop-result");
        if (ref != paused or !is_op and !is_prop) return protocolError(s.gpa, ref, "a Pump is waiting for its result");
        if (is_op != (s.need.?.kind == .op)) return protocolError(s.gpa, ref, "the result does not match the need");
        return answerNeed(s, msg, ref, is_prop);
    }
    if (std.mem.eql(u8, m, "hello")) {
        if ((asInt(field(msg, "protocol")) orelse -1) != protocol_version) return protocolError(s.gpa, ref, "unknown protocol");
        return helloReply(s, ref);
    } else if (std.mem.eql(u8, m, "add")) {
        return addReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "define-capability")) {
        return defineCapabilityReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "grant")) {
        return grantReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "new-group")) {
        return newGroupReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "load")) {
        return loadReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "deliver")) {
        return queuedReply(s, msg, ref, .deliver);
    } else if (std.mem.eql(u8, m, "request")) {
        return queuedReply(s, msg, ref, .request);
    } else if (std.mem.eql(u8, m, "decide")) {
        return queuedReply(s, msg, ref, .decide);
    } else if (std.mem.eql(u8, m, "broadcast")) {
        return queuedReply(s, msg, ref, .broadcast);
    } else if (std.mem.eql(u8, m, "pump")) {
        return pumpReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "answer")) {
        return settleReply(s, msg, ref, false);
    } else if (std.mem.eql(u8, m, "fail")) {
        return settleReply(s, msg, ref, true);
    } else if (std.mem.eql(u8, m, "save")) {
        return saveReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "fingerprint")) {
        return fingerprintReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "define-object-kind")) {
        return defineObjectKindReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "object")) {
        return objectReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "set-parent")) {
        return objectInputReply(s, msg, ref, false);
    } else if (std.mem.eql(u8, m, "dispose")) {
        return objectInputReply(s, msg, ref, true);
    } else if (std.mem.eql(u8, m, "counters")) {
        return countersReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "stop")) {
        return scriptControlReply(s, msg, ref, .stop);
    } else if (std.mem.eql(u8, m, "cancel-run")) {
        return scriptControlReply(s, msg, ref, .cancel_run);
    } else if (std.mem.eql(u8, m, "rewind-run")) {
        return scriptControlReply(s, msg, ref, .rewind_run);
    } else if (std.mem.eql(u8, m, "revoke")) {
        return scriptControlReply(s, msg, ref, .revoke);
    } else if (std.mem.eql(u8, m, "cancel-delivery")) {
        return cancelDeliveryReply(s, msg, ref);
    }
    return protocolError(s.gpa, ref, "unknown or unsupported message");
}

// ---------------------------------------------------------- wasm exports

const export_allocator = if (builtin.target.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.smp_allocator;
var instance: ?*Session = null;
var in_buffer: []u8 = &.{};
var reply_buffer: []u8 = &.{};

fn session() ?*Session {
    if (instance == null) instance = Session.init(export_allocator);
    return instance;
}

fn bufferExport(n: usize) callconv(.c) usize {
    if (n == 0 or n > max_frame) return 0;
    if (in_buffer.len < n) {
        const grown = export_allocator.alloc(u8, n) catch return 0;
        export_allocator.free(in_buffer);
        in_buffer = grown;
    }
    return @intFromPtr(in_buffer.ptr);
}

fn sendExport(n: usize) callconv(.c) u64 {
    const s = session() orelse return 0;
    const reply = if (n == 0 or n > in_buffer.len)
        protocolError(s.gpa, 0, "no frame of that length")
    else
        handle(s, in_buffer[0..n]);
    const kept = export_allocator.dupe(u8, reply) catch return 0;
    freeReply(s.gpa, reply);
    export_allocator.free(reply_buffer);
    reply_buffer = kept;
    return (@as(u64, @intCast(@intFromPtr(reply_buffer.ptr))) << 32) | @as(u64, @intCast(reply_buffer.len));
}

fn initializeExport() callconv(.c) void {
    _ = session();
}

comptime {
    if (builtin.target.os.tag == .wasi) {
        @export(&bufferExport, .{ .name = "talk_buffer" });
        @export(&sendExport, .{ .name = "talk_send" });
        @export(&initializeExport, .{ .name = "_initialize" });
    }
}

// ------------------------------------------------------------------ tests

const Client = struct {
    s: *Session,
    arena: std.heap.ArenaAllocator,

    fn init(s: *Session) Client {
        return .{ .s = s, .arena = .init(std.testing.allocator) };
    }
    fn deinit(c: *Client) void {
        c.arena.deinit();
    }
    /// Sends a frame whose first format argument is its ref.
    fn send(c: *Client, comptime fmt: []const u8, args: anytype) !Json {
        return c.common(args[0], fmt, args);
    }
    /// Sends a result under a paused Pump's ref.
    fn sendRef(c: *Client, ref: i64, comptime fmt: []const u8, args: anytype) !Json {
        return c.common(ref, fmt, args);
    }
    fn common(c: *Client, r: i64, comptime fmt: []const u8, args: anytype) !Json {
        const a = c.arena.allocator();
        const frame = try std.fmt.allocPrint(a, fmt, args);
        const reply = handle(c.s, frame);
        defer freeReply(c.s.gpa, reply);
        const parsed = try std.json.parseFromSlice(Json, a, reply, .{});
        try std.testing.expectEqual(@as(i64, r), parsed.value.object.get("ref").?.integer);
        return parsed.value;
    }
};

fn okOf(reply: Json) !Json {
    return reply.object.get("ok") orelse error.TestUnexpectedResult;
}
fn errKind(reply: Json) ![]const u8 {
    const e = reply.object.get("err") orelse return error.TestUnexpectedResult;
    return e.object.get("kind").?.string;
}
fn runEnd(reply: Json) !Json {
    const reports = (try okOf(reply)).object.get("reports").?.array.items;
    for (reports) |r| if (std.mem.eql(u8, r.object.get("kind").?.string, "run end")) return r;
    return error.TestUnexpectedResult;
}

test "hello, framing refusals, and a Pump with no Operations" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{1}));
    try std.testing.expectEqualStrings("zig/0.0.0", hello.object.get("core").?.string);
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":2}}", .{2})));
    for ([_][]const u8{ "{", "[]", "{\"m\":\"nope\",\"ref\":9}", "{\"ref\":9}" }) |frame| {
        const reply = handle(s, frame);
        defer freeReply(gpa, reply);
        try std.testing.expect(std.mem.indexOf(u8, reply, "\"protocol error\"") != null);
    }
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on ping\\nreturn 42\\nend ping\\n\"}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"ping\"}}}}", .{5}));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6}));
    try std.testing.expectEqualStrings("completed", end.object.get("outcome").?.string);
    try std.testing.expectEqual(@as(i64, 42), end.object.get("result").?.integer);
    const add = try okOf(try c.send("{{\"m\":\"add\",\"ref\":{d},\"a\":20,\"b\":22}}", .{7}));
    try std.testing.expectEqual(@as(i64, 42), add.object.get("value").?.integer);
    const refused = try okOf(try c.send("{{\"m\":\"add\",\"ref\":{d},\"a\":[],\"b\":1}}", .{8}));
    try std.testing.expectEqualStrings("wrong kind", refused.object.get("fail").?.object.get("code").?.string);
}

test "an immediate op pauses the Pump and resumes on its result" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"double\",\"mode\":\"immediate\",\"args\":[\"number\"],\"result\":\"number\",\"cost\":{{\"fuel\":7}}}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"limits\":{{\"fuelPerRun\":1000}},\"source\":\"on double n\\n  ask api to double n\\n  return it + 1\\nend double\\n\"}}", .{ 4, grant.object.get("grant").?.integer }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"double\",\"args\":[20]}}}}", .{5}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    const need = pumped.object.get("need").?;
    try std.testing.expectEqualStrings("op", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("double", need.object.get("operation").?.string);
    try std.testing.expectEqual(@as(i64, 20), need.object.get("args").?.array.items[0].integer);
    const left = need.object.get("fuelLeft").?.integer;
    try std.testing.expect(left > 0 and left < 1000);
    // A wrong ref and another message are refused; the Pump stays parked.
    const stray = try c.sendRef(99, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":40}}", .{99});
    try std.testing.expectEqualStrings("protocol error", try errKind(stray));
    const other = try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{7});
    try std.testing.expectEqualStrings("protocol error", try errKind(other));
    const done = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":40,\"charged\":3}}", .{6});
    const end = try runEnd(done);
    try std.testing.expectEqualStrings("completed", end.object.get("outcome").?.string);
    try std.testing.expectEqual(@as(i64, 41), end.object.get("result").?.integer);
    var charged_seen = false;
    for ((try okOf(done)).object.get("trace").?.array.items) |line| {
        if (std.mem.indexOf(u8, line.string, "charged=3") != null) charged_seen = true;
    }
    try std.testing.expect(charged_seen);
}

test "a suspending op starts, is answered, and completes on the next Pump" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"result\":\"number\",\"maxPending\":5000}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on fetch\\n  ask api to fetch and wait\\n  return it\\nend fetch\\n\"}}", .{ 4, grant.object.get("grant").?.integer }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"fetch\"}}}}", .{5}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    const need = pumped.object.get("need").?;
    try std.testing.expectEqualStrings("suspending", need.object.get("mode").?.string);
    const call = need.object.get("call").?.string;
    const parked = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"started\":true}}", .{6}));
    // Parked, the Run has started but not ended.
    for (parked.object.get("reports").?.array.items) |r|
        try std.testing.expect(!std.mem.eql(u8, "run end", r.object.get("kind").?.string));
    _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"value\":37}}", .{ 7, call }));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8}));
    try std.testing.expectEqual(@as(i64, 37), end.object.get("result").?.integer);
}

test "a prop need, a load error's diagnostics, and a fault that loses nothing" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"thing\",\"props\":[{{\"name\":\"size\",\"shape\":\"number\",\"readOnly\":true}}]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"thing\",\"id\":\"t1\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on probe o\\n  return the size of o\\nend probe\\non spin\\n  repeat forever\\n  end repeat\\nend spin\\n\"}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"probe\",\"args\":[{{\"$object\":[\"thing\",\"t1\"]}}]}}}}", .{5}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    const need = pumped.object.get("need").?;
    try std.testing.expectEqualStrings("prop", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("size", need.object.get("prop").?.string);
    const done = try c.sendRef(6, "{{\"m\":\"prop-result\",\"ref\":{d},\"value\":9}}", .{6});
    try std.testing.expectEqual(@as(i64, 9), (try runEnd(done)).object.get("result").?.integer);
    // Deeply nested source is a load error with its diagnostic.
    const deep = try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"deep\",\"source\":\"on deep\\nreturn ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((1))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))\\nend deep\\n\"}}", .{7});
    const errj = deep.object.get("err").?;
    try std.testing.expectEqualStrings("load error", errj.object.get("kind").?.string);
    try std.testing.expectEqualStrings("source nesting too deep", errj.object.get("diagnostics").?.array.items[0].object.get("code").?.string);
    // A runaway Script faults on Fuel; the instance answers afterwards.
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"spin\"}}}}", .{8}));
    const spun = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{9}));
    try std.testing.expectEqualStrings("limit fault", spun.object.get("outcome").?.string);
    try std.testing.expectEqualStrings("fuel", spun.object.get("limit").?.string);
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{10}));
}

test "define-capability carries Operation documentation and refuses other kinds" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // Documentation of the wrong kind is refused (chapter 9, ADR 0076).
    const invalid = [_][]const u8{
        "\"description\":null", "\"description\":42",      "\"description\":[]",
        "\"examples\":null",    "\"examples\":\"source\"", "\"examples\":[null]",
        "\"examples\":[1]",
    };
    for (invalid, 0..) |fields, i| {
        const reply = try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"bad{d}\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"cost\":{{\"fuel\":0}},{s}}}]}}", .{ @as(i64, @intCast(i + 1)), i, fields });
        try std.testing.expect(reply.object.get("ok") == null);
    }
    // Empty is none; the text is carried unparsed for the Host Manifest.
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"empty\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"cost\":{{\"fuel\":0}},\"description\":\"\",\"examples\":[]}}]}}", .{90}));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"cost\":{{\"fuel\":0}},\"description\":\"plain *text*\",\"examples\":[\"not parsed as NorthTalk\",\"\"]}}]}}", .{91}));
    const op = s.capabilityNamed("api").?.operations[0];
    try std.testing.expectEqualStrings("plain *text*", op.description);
    try std.testing.expectEqual(@as(usize, 2), op.examples.len);
    try std.testing.expectEqualStrings("not parsed as NorthTalk", op.examples[0]);
    try std.testing.expectEqualStrings("", op.examples[1]);
    const undocumented = s.capabilityNamed("empty").?.operations[0];
    try std.testing.expectEqualStrings("", undocumented.description);
    try std.testing.expectEqual(@as(usize, 0), undocumented.examples.len);
}

test "counters, cancel-delivery, revoke and stop" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"double\",\"mode\":\"immediate\",\"args\":[\"number\"],\"result\":\"number\"}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on ping\\nreturn 42\\nend ping\\non double n\\n  ask api to double n\\n  return it\\nend double\\n\"}}", .{ 4, grant.object.get("grant").?.integer }));
    // Counters naming no Group this instance holds is a protocol error,
    // as the shared reactor harness (tools/wasi/check.py) holds both
    // reactors to.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"counters\",\"ref\":{d},\"group\":\"nope\",\"script\":\"s\"}}", .{5})));
    // A Delivery cancelled in the mailbox never runs: it is reported
    // cancelled, with no Run.
    const queued = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"ping\"}}}}", .{6}));
    _ = try okOf(try c.send("{{\"m\":\"cancel-delivery\",\"ref\":{d},\"group\":\"g\",\"delivery\":\"{s}\"}}", .{ 7, queued.object.get("delivery").?.string }));
    const cancelled = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8}));
    try std.testing.expectEqualStrings("cancelled", cancelled.object.get("outcome").?.string);
    // A completed Run is counted.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"ping\"}}}}", .{9}));
    _ = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}));
    const counters = try okOf(try c.send("{{\"m\":\"counters\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{11}));
    try std.testing.expectEqual(@as(i64, 1), counters.object.get("runs").?.integer);
    try std.testing.expect(counters.object.get("fuelTotal").?.integer > 0);
    try std.testing.expectEqual(@as(i64, 0), counters.object.get("faults").?.integer);
    try std.testing.expectEqual(@as(i64, 0), counters.object.get("mailboxLen").?.integer);
    // A revoked Grant's calls fail in the Run, with no need.
    _ = try okOf(try c.send("{{\"m\":\"revoke\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"grant\":\"api\"}}", .{12}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"double\",\"args\":[1]}}}}", .{13}));
    const revoked = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{14}));
    try std.testing.expectEqualStrings("errored", revoked.object.get("outcome").?.string);
    try std.testing.expectEqualStrings("capability revoked", revoked.object.get("error").?.object.get("code").?.string);
    // Stop lands at the next Pump, with its report.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}}", .{15}));
    const stopped = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{16}));
    var saw_stop = false;
    for (stopped.object.get("reports").?.array.items) |r| {
        if (std.mem.eql(u8, "stop", r.object.get("kind").?.string)) {
            try std.testing.expectEqualStrings("done", r.object.get("reason").?.string);
            saw_stop = true;
        }
    }
    try std.testing.expect(saw_stop);
}

fn startedRun(reply: Json) ![]const u8 {
    const reports = (try okOf(reply)).object.get("reports").?.array.items;
    for (reports) |r| if (std.mem.eql(u8, r.object.get("kind").?.string, "run started")) return r.object.get("run").?.string;
    return error.TestUnexpectedResult;
}

test "rewind-run restarts a sliced Run and cancel-run ends it" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on spin\\n  repeat forever\\n  end repeat\\nend spin\\n\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"spin\"}}}}", .{3}));
    // A small Fuel Slice preempts the Run in its first Segment.
    const sliced = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\",\"fuelSlice\":500}}", .{4});
    try std.testing.expectEqualStrings("sliced", (try okOf(sliced)).object.get("state").?.string);
    const run = try startedRun(sliced);
    // Rewinding it puts its message back: the Pump that lands the
    // rewind returns rewound at once, and the next starts a new Run
    // for the message, and slices again.
    _ = try okOf(try c.send("{{\"m\":\"rewind-run\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"run\":\"{s}\"}}", .{ 5, run }));
    const rewound = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\",\"fuelSlice\":500}}", .{6});
    try std.testing.expectEqualStrings("rewound", (try okOf(rewound)).object.get("state").?.string);
    const resliced = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\",\"fuelSlice\":500}}", .{7});
    try std.testing.expectEqualStrings("sliced", (try okOf(resliced)).object.get("state").?.string);
    const rerun = try startedRun(resliced);
    try std.testing.expect(!std.mem.eql(u8, run, rerun));
    const counters = try okOf(try c.send("{{\"m\":\"counters\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{8}));
    try std.testing.expectEqual(@as(i64, 2), counters.object.get("runs").?.integer);
    // Cancelling the restarted Run ends it cancelled at the next Pump.
    _ = try okOf(try c.send("{{\"m\":\"cancel-run\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"run\":\"{s}\"}}", .{ 9, rerun }));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}));
    try std.testing.expectEqualStrings("cancelled", end.object.get("outcome").?.string);
}

test "Host Objects route Deliveries to their owner, take parents, and stop it when disposed" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"room\",\"props\":[]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"room\",\"id\":\"hall\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"room\",\"id\":\"lamp\"}}", .{4}));
    // An unknown handle is refused before the Core sees it.
    const unknown = try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"owner\":{{\"$object\":[\"room\",\"nowhere\"]}},\"source\":\"\"}}", .{5});
    try std.testing.expectEqualStrings("host error", try errKind(unknown));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"owner\":{{\"$object\":[\"room\",\"hall\"]}},\"objects\":{{\"lamp\":{{\"$object\":[\"room\",\"lamp\"]}}}},\"source\":\"on ping\\n  return the id of lamp\\nend ping\\n\"}}", .{6}));
    // The lamp, parented to the hall, routes to the hall's Owning Script.
    _ = try okOf(try c.send("{{\"m\":\"set-parent\",\"ref\":{d},\"group\":\"g\",\"object\":{{\"$object\":[\"room\",\"lamp\"]}},\"parent\":{{\"$object\":[\"room\",\"hall\"]}}}}", .{7}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"object\":{{\"$object\":[\"room\",\"lamp\"]}}}},\"message\":{{\"name\":\"ping\"}}}}", .{9}));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}));
    try std.testing.expectEqualStrings("completed", end.object.get("outcome").?.string);
    try std.testing.expectEqualStrings("s", end.object.get("script").?.string);
    try std.testing.expectEqualStrings("lamp", end.object.get("result").?.string);
    // With the parent applied, the reverse is a cycle at admission.
    const cycle = try c.send("{{\"m\":\"set-parent\",\"ref\":{d},\"group\":\"g\",\"object\":{{\"$object\":[\"room\",\"hall\"]}},\"parent\":{{\"$object\":[\"room\",\"lamp\"]}}}}", .{8});
    try std.testing.expectEqualStrings("parent cycle", cycle.object.get("err").?.object.get("code").?.string);
    // `to` names one target.
    const both = try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\",\"object\":{{\"$object\":[\"room\",\"hall\"]}}}},\"message\":{{\"name\":\"ping\"}}}}", .{11});
    try std.testing.expectEqualStrings("host error", try errKind(both));
    // Disposing the owner stops its Owning Script.
    _ = try okOf(try c.send("{{\"m\":\"dispose\",\"ref\":{d},\"group\":\"g\",\"object\":{{\"$object\":[\"room\",\"hall\"]}}}}", .{12}));
    const pumped = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{13}));
    var stopped = false;
    for (pumped.object.get("reports").?.array.items) |r| {
        if (std.mem.eql(u8, "stop", r.object.get("kind").?.string)) stopped = true;
    }
    try std.testing.expect(stopped);
}

test "a Broadcast, Decisions to a Script, an object and every Script, and a Pump's next deadline" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"room\",\"props\":[]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"room\",\"id\":\"hall\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"owner\":{{\"$object\":[\"room\",\"hall\"]}},\"source\":\"script variable heard = 0\\non hello\\n  put heard + 1 into heard\\nend hello\\non enter, deciding\\n  veto \\\"locked\\\"\\nend enter\\non nap\\n  wait 2 s\\nend nap\\n\"}}", .{4}));
    const sent = try okOf(try c.send("{{\"m\":\"broadcast\",\"ref\":{d},\"group\":\"g\",\"message\":{{\"name\":\"hello\"}}}}", .{5}));
    try std.testing.expectEqualStrings("b", sent.object.get("broadcast").?.string[0..1]);
    // A Broadcast has no `to`.
    const aimed = try c.send("{{\"m\":\"broadcast\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"hello\"}}}}", .{6});
    try std.testing.expectEqualStrings("host error", try errKind(aimed));
    const to_script = try okOf(try c.send("{{\"m\":\"decide\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"enter\"}}}}", .{7}));
    const to_object = try okOf(try c.send("{{\"m\":\"decide\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"object\":{{\"$object\":[\"room\",\"hall\"]}}}},\"message\":{{\"name\":\"enter\"}}}}", .{8}));
    const to_all = try okOf(try c.send("{{\"m\":\"decide\",\"ref\":{d},\"group\":\"g\",\"broadcast\":true,\"message\":{{\"name\":\"enter\"}}}}", .{9}));
    try std.testing.expectEqualStrings("b", to_all.object.get("broadcast").?.string[0..1]);
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"nap\"}}}}", .{10}));
    const pumped = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{11}));
    var vetoed: usize = 0;
    var ids: [3][]const u8 = undefined;
    for (pumped.object.get("reports").?.array.items) |r| {
        if (!std.mem.eql(u8, "decided", r.object.get("kind").?.string)) continue;
        try std.testing.expectEqualStrings("vetoed", r.object.get("verdict").?.string);
        ids[vetoed] = if (r.object.get("broadcast")) |b| b.string else r.object.get("delivery").?.string;
        vetoed += 1;
    }
    try std.testing.expectEqual(@as(usize, 3), vetoed);
    try std.testing.expectEqualStrings(to_script.object.get("delivery").?.string, ids[0]);
    try std.testing.expectEqualStrings(to_object.object.get("delivery").?.string, ids[1]);
    try std.testing.expectEqualStrings(to_all.object.get("broadcast").?.string, ids[2]);
    // The napping Run's wait is the next deadline; with none left it is null.
    try std.testing.expectEqualStrings("2026-10-10T12:00:02Z", pumped.object.get("nextDeadline").?.string);
    const woke = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:02Z\"}}", .{12}));
    try std.testing.expect(woke.object.get("nextDeadline").? == .null);
}

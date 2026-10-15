//! The Message Layer (spec chapter 9): the language-neutral form of the
//! embedding interface, as JSON frames over native stdio or
//! `talk_buffer`/`talk_send` in the `wasm32-wasi` build.
//! The layer is a Zig Host of talk.zig's API; a
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
    /// Whether the last value read held another Group's Function Value.
    wrong_group: bool = false,
    /// The calls the Host answered `started`, or adopted, and hasn't
    /// answered or failed: those the Core abandons are listed in the next
    /// reply's `abandoned`, once.
    started: std.ArrayList([]u8) = .empty,

    /// Remembers a call the Host is working on.
    fn track(e: *GroupEntry, id: []const u8) void {
        const owned = e.gpa.dupe(u8, id) catch return;
        e.started.append(e.gpa, owned) catch e.gpa.free(owned);
    }

    /// Forgets a call the Host has answered or failed.
    fn untrack(e: *GroupEntry, id: []const u8) void {
        for (e.started.items, 0..) |x, i| if (std.mem.eql(u8, x, id)) {
            e.gpa.free(e.started.orderedRemove(i));
            return;
        };
    }

    /// Writes `,"abandoned":[…]`: the tracked calls the Core has abandoned
    /// since the last reply, in call id order, each forgotten once listed.
    fn writeAbandoned(e: *GroupEntry, o: *Out) Allocator.Error!void {
        var listed: std.ArrayList([]u8) = .empty;
        defer {
            for (listed.items) |x| e.gpa.free(x);
            listed.deinit(e.gpa);
        }
        var i: usize = 0;
        while (i < e.started.items.len) {
            const id = e.started.items[i];
            const abandoned = for (e.group.group.calls.items) |c| {
                if (std.mem.eql(u8, c.id, id)) break c.abandoned.load(.acquire);
            } else false;
            if (abandoned) {
                try listed.append(e.gpa, e.started.orderedRemove(i));
            } else i += 1;
        }
        std.mem.sort([]u8, listed.items, {}, struct {
            fn less(_: void, x: []u8, y: []u8) bool {
                return machine.callOrder(x, y);
            }
        }.less);
        try o.raw(",\"abandoned\":[");
        for (listed.items, 0..) |id, k| {
            if (k > 0) try o.raw(",");
            try o.text(id);
        }
        try o.raw("]");
    }
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
    kind: enum { op, prop, effect },
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
    // An effect's fields, with `script`, `run`, `segment`, `grant` and
    // `now`: every enrolled Grant, the named Coordinator, and the phase.
    grants: [][]u8 = &.{},
    coordinator: ?[]u8 = null,
    phase: caps.Phase = .begin,

    fn release(n: *Need, gpa: Allocator) void {
        for ([_][]u8{ n.call, n.script, n.run, n.segment, n.grant, n.capability, n.operation, n.scope, n.object_kind, n.object_id, n.prop }) |s| gpa.free(s);
        for (n.grants) |g| gpa.free(g);
        gpa.free(n.grants);
        if (n.coordinator) |c| gpa.free(c);
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
    /// Whether a Reload or library replacement is ending the old code's
    /// Runs, where a lifecycle crossing may send a need too.
    in_work: bool = false,
    /// A Reload or library replacement paused for a need, which the
    /// answer goes on with instead of a Pump.
    work_paused: bool = false,
    /// The Pump paused at a crossing: its `ref` and its need.
    paused_ref: ?i64 = null,
    need: ?Need = null,
    answer: ?Answer = null,
    /// OOM inside a Host function, which cannot report it there.
    oom: bool = false,
    /// The Group whose Pump is running, which a need belongs to.
    pumping_entry: ?*GroupEntry = null,
    exchange_entry: ?*GroupEntry = null,
    exchange_pump: bool = false,
    /// A `restore` waiting for its `resolve-result`.
    restoring: ?Restoring = null,
    /// What an `effect-result` brought back, for the re-made hook.
    effect_answer: ?caps.EffectStatus = null,
    /// Grant releases the Core made, sent as `release` needs before the
    /// reply they came before; `held` is that reply.
    releases: std.ArrayList(Release) = .empty,
    held: ?[]u8 = null,
    held_ref: i64 = 0,
    admitting: bool = false,
    release_continuation: bool = false,
    /// Lifecycle contexts, owned here: one per Segment Capability, and one
    /// per named Segment Coordinator.
    effect_contexts: std.ArrayList(*EffectContext) = .empty,

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
        if (s.restoring) |*r| r.deinit();
        for (s.releases.items) |*r| r.deinit(gpa);
        s.releases.deinit(gpa);
        if (s.held) |h| gpa.free(h);
        for (s.effect_contexts.items) |c| {
            if (c.coordinator) |n| gpa.free(n);
            gpa.destroy(c);
        }
        s.effect_contexts.deinit(gpa);
        if (s.answer) |*a| a.release(gpa);
        for (s.groups.items) |e| {
            Direct.groupRelease(e.group);
            for (e.pending_trace.items) |line| gpa.free(line);
            for (e.started.items) |x| gpa.free(x);
            e.started.deinit(gpa);
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

/// A Segment Coordinator's context: a Segment Capability's own, which
/// gives each Grant its own Coordinator, or a named one, which every Grant
/// given that name shares and which its `effect` needs carry.
const EffectContext = struct {
    session: *Session,
    coordinator: ?[]u8 = null,
};

/// A Grant release the Core made, waiting to be sent as a `release` need.
const Release = struct {
    script: []u8,
    grant: []u8,
    reason: caps.ReleaseReason,
    now: model.dates.Instant,

    fn deinit(r: *Release, gpa: Allocator) void {
        gpa.free(r.script);
        gpa.free(r.grant);
    }
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
        const functions: ?encoding.FunctionWriter = if (handling) |s| .{ .context = s, .write = writeFunction } else null;
        encoding.writeWith(o.w(), v, functions) catch |e| return if (e == error.NotEncodable) error.NotEncodable else error.OutOfMemory;
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
        writeDiagnostic(&o, &first, code, unit, line_no, col);
    }
    o.raw("]}}") catch {};
    return o.finish() catch protocolError(gpa, ref, "out of memory");
}

/// The `load error` reply for a refused Library, from the Core's LoadError.
fn libraryLoadError(gpa: Allocator, ref: i64, e: *const talk.LoadError) []u8 {
    var o = Out.init(gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"err\":{\"kind\":\"load error\",\"diagnostics\":[") catch {};
    var first = true;
    for (e.diagnostics[0..e.diagnostics_len]) |d| writeDiagnostic(&o, &first, d.code[0..d.code_len], d.unit[0..d.unit_len], d.line, d.col);
    o.raw("]}}") catch {};
    return o.finish() catch protocolError(gpa, ref, "out of memory");
}

fn writeDiagnostic(o: *Out, first: *bool, code: []const u8, unit: []const u8, line: i64, col: i64) void {
    if (!first.*) o.raw(",") catch {};
    first.* = false;
    o.raw("{\"code\":") catch {};
    o.text(code) catch {};
    o.raw(",\"message\":") catch {};
    o.text(diagnosticMessage(code)) catch {};
    o.raw(",\"unit\":") catch {};
    o.text(unit) catch {};
    o.raw(",\"line\":") catch {};
    o.int(line) catch {};
    o.raw(",\"col\":") catch {};
    o.int(col) catch {};
    o.raw("}") catch {};
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
    if (entry) |e| e.wrong_group = false;
    return encoding.decodeParsed(gpa, j, resolverOf(entry));
}

fn resolverOf(entry: ?*GroupEntry) display.Resolver {
    return .{
        .context = if (entry) |e| @ptrCast(e) else null,
        .object = if (entry != null) resolveObject else null,
        .function_token = if (entry != null) resolveFunction else null,
    };
}

/// The host error for a value `decodeValue` refused.
fn decodeError(e: model.Error, entry: ?*GroupEntry) talk.HostErrorCode {
    if (e == error.OutOfMemory) return .out_of_memory;
    if (entry) |x| if (x.wrong_group) return .wrong_group;
    return .invalid_value;
}

/// The Session whose frame `handle` is reading, which writes Function
/// Values' tokens.
var handling: ?*Session = null;

/// `{"$function": [home, display, token]}`. The token is the base64 of
/// `{"g": group, "f": code, "d": display, "c": captures}`: the Group's
/// handle, the index of the value's code in it, and its captures, so
/// reading it needs nothing the Host must release.
fn writeFunction(context: ?*anyopaque, w: *std.Io.Writer, v: *const Value) encoding.Error!void {
    const s: *Session = @ptrCast(@alignCast(context.?));
    const f = v.data.function;
    var at: ?struct { *GroupEntry, usize } = null;
    for (s.groups.items) |e| {
        for (e.group.group.functions.items, 0..) |code, i| if (@intFromPtr(code) == f.identity) {
            at = .{ e, i };
        };
    }
    const found = at orelse return error.NotEncodable;
    var inner: std.Io.Writer.Allocating = .init(s.gpa);
    defer inner.deinit();
    const iw = &inner.writer;
    iw.writeAll("{\"g\":") catch return error.OutOfMemory;
    std.json.Stringify.value(found[0].name, .{}, iw) catch return error.OutOfMemory;
    iw.print(",\"f\":{d},\"d\":", .{found[1]}) catch return error.OutOfMemory;
    std.json.Stringify.value(f.display, .{}, iw) catch return error.OutOfMemory;
    iw.writeAll(",\"c\":") catch return error.OutOfMemory;
    try encoding.writeWith(iw, f.captures, .{ .context = s, .write = writeFunction });
    iw.writeAll("}") catch return error.OutOfMemory;
    const codec = std.base64.standard.Encoder;
    const token = try s.gpa.alloc(u8, codec.calcSize(inner.written().len));
    defer s.gpa.free(token);
    _ = codec.encode(token, inner.written());
    w.writeAll("{\"$function\":[") catch return error.WriteFailed;
    std.json.Stringify.value(f.home, .{}, w) catch return error.WriteFailed;
    w.writeAll(",") catch return error.WriteFailed;
    std.json.Stringify.value(f.display, .{}, w) catch return error.WriteFailed;
    w.writeAll(",") catch return error.WriteFailed;
    std.json.Stringify.value(token, .{}, w) catch return error.WriteFailed;
    w.writeAll("]}") catch return error.WriteFailed;
}

/// Reads a `$function` token against `context`'s Group: another Group's is
/// `wrong group`, and anything this layer didn't write is invalid.
fn resolveFunction(context: ?*anyopaque, home: []const u8, shown: []const u8, token: []const u8) model.Error!*Value {
    _ = home;
    _ = shown;
    const e: *GroupEntry = @ptrCast(@alignCast(context orelse return error.InvalidValue));
    const gpa = e.gpa;
    const codec = std.base64.standard.Decoder;
    const raw = try gpa.alloc(u8, codec.calcSizeForSlice(token) catch return error.InvalidValue);
    defer gpa.free(raw);
    codec.decode(raw, token) catch return error.InvalidValue;
    const parsed = std.json.parseFromSlice(Json, gpa, raw, .{ .parse_numbers = false }) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    defer parsed.deinit();
    const g = asText(field(parsed.value, "g")) orelse return error.InvalidValue;
    if (!std.mem.eql(u8, g, e.name)) {
        e.wrong_group = true;
        return error.InvalidValue;
    }
    const index = asU64(field(parsed.value, "f") orelse return error.InvalidValue) orelse return error.InvalidValue;
    const functions = e.group.group.functions.items;
    if (index >= functions.len) return error.InvalidValue;
    const code = functions[@intCast(index)];
    const display_text = asText(field(parsed.value, "d")) orelse return error.InvalidValue;
    const captures = try encoding.decodeParsed(gpa, field(parsed.value, "c") orelse return error.InvalidValue, resolverOf(e));
    defer captures.release();
    return model.function(gpa, code.home, display_text, @intFromPtr(code), captures);
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
/// An answer's `charged`. An automatic call's is zero, and draws nothing:
/// any charge it tries is a Host contract failure.
fn chargeAnswer(call: *caps.Call, charged: u64) bool {
    if (call.automatic and charged == 0) return true;
    return call.charge(charged);
}

fn opCall(context: ?*anyopaque, call: *caps.Call, args: []const *Value) caps.Outcome {
    const oc: *OpContext = @ptrCast(@alignCast(context.?));
    const s = oc.session;
    if (s.pumping_entry) |e| if (e.group.group.release_pause) return .deferred;
    if (s.answer) |*a| {
        s.pumping_entry.?.group.group.answering_crossing = false;
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
            _ = chargeAnswer(call, answer.charged);
            var copy = answer;
            copy.release(s.gpa);
            return .broken;
        }
        switch (answer.kind) {
            .result => {
                if (!chargeAnswer(call, answer.charged)) {
                    var copy = answer;
                    copy.release(s.gpa);
                    return .limited;
                }
                return .{ .value = answer.value.? };
            },
            .started => {
                if (!chargeAnswer(call, answer.charged)) return .limited;
                // The Host works on it now, until it answers or the Core
                // abandons it.
                if (s.pumping_entry) |e| e.track(call.id);
                return .started;
            },
            .done => {
                if (!chargeAnswer(call, answer.charged)) return .limited;
                const nothing = model.scalar(call.gpa, .nothing) catch return .broken;
                return .{ .value = nothing };
            },
            .fail => {
                if (!chargeAnswer(call, answer.charged)) {
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
                _ = chargeAnswer(call, answer.charged);
                return .limited;
            },
            .host_error => {
                _ = chargeAnswer(call, answer.charged);
                return .broken;
            },
        }
    }
    // An automatic call where its crossing can't pause has no answer.
    if (!(s.in_pump or s.in_work) or !call.deferrable) return .broken;
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

/// The named Segment Coordinator's context, made the first time.
fn namedCoordinator(s: *Session, name: []const u8) Allocator.Error!*EffectContext {
    for (s.effect_contexts.items) |c| if (c.coordinator) |n| if (std.mem.eql(u8, n, name)) return c;
    const owned = try s.gpa.dupe(u8, name);
    errdefer s.gpa.free(owned);
    const c = try s.gpa.create(EffectContext);
    errdefer s.gpa.destroy(c);
    c.* = .{ .session = s, .coordinator = owned };
    try s.effect_contexts.append(s.gpa, c);
    return c;
}

/// Every `store` Grant's Segment Coordinator: the one implementation's.
fn storeCoordinatorOf(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    _ = g;
    return .{ .identity = @intFromPtr(context.?), .hook = effectHook, .context = context };
}

/// Each Grant's Segment Coordinator: its named one, or its own.
fn coordinatorOf(context: ?*anyopaque, g: *const caps.Grant) ?caps.Coordinator {
    if (g.binding) |b| return .{ .identity = @intFromPtr(b), .hook = effectHook, .context = b };
    return .{ .identity = @intFromPtr(g), .hook = effectHook, .context = context };
}

/// A Segment lifecycle hook: the `effect-result` an `effect` need brought
/// back, or else that need, and a pause at the crossing. One that can't
/// pause has no answer, which leaves its state unknown.
fn effectHook(context: ?*anyopaque, phase: caps.Phase, sc: *const caps.SegmentContext) caps.EffectStatus {
    const ec: *EffectContext = @ptrCast(@alignCast(context.?));
    const s = ec.session;
    if (s.pumping_entry) |e| if (e.group.group.release_pause) return .deferred;
    if (s.effect_answer) |status| {
        s.pumping_entry.?.group.group.answering_crossing = false;
        s.effect_answer = null;
        return status;
    }
    if (!(s.in_pump or s.in_work) or !sc.deferrable) return .unknown;
    const gpa = s.gpa;
    var n: Need = .{
        .kind = .effect,
        .entry = s.pumping_entry.?,
        .call = &.{},
        .script = &.{},
        .run = &.{},
        .segment = &.{},
        .grant = &.{},
        .capability = &.{},
        .operation = &.{},
        .scope = &.{},
        .now = sc.now,
        .args = &.{},
        .object_kind = &.{},
        .object_id = &.{},
        .prop = &.{},
        .phase = phase,
    };
    fill: {
        n.script = gpa.dupe(u8, sc.script) catch break :fill;
        n.run = gpa.dupe(u8, sc.run) catch break :fill;
        n.segment = gpa.dupe(u8, sc.segment) catch break :fill;
        n.grant = gpa.dupe(u8, sc.grant) catch break :fill;
        if (ec.coordinator) |c| n.coordinator = gpa.dupe(u8, c) catch break :fill;
        const names = gpa.alloc([]u8, sc.grants.len) catch break :fill;
        var made: usize = 0;
        for (sc.grants, names) |g, *x| {
            x.* = gpa.dupe(u8, g.name[0..g.name_len]) catch {
                for (names[0..made]) |y| gpa.free(y);
                gpa.free(names);
                break :fill;
            };
            made += 1;
        }
        n.grants = names;
        s.need = n;
        return .deferred;
    }
    n.release(gpa);
    return .unknown;
}

/// The Grant release hook: queued, and sent as a `release` need before
/// the reply it comes before. It has no result and can't refuse.
fn releaseHook(context: ?*anyopaque, gc: *const caps.GrantContext) void {
    const s: *Session = @ptrCast(@alignCast(context.?));
    const script = s.gpa.dupe(u8, gc.script) catch return;
    const grant = s.gpa.dupe(u8, gc.grant) catch {
        s.gpa.free(script);
        return;
    };
    s.releases.append(s.gpa, .{ .script = script, .grant = grant, .reason = gc.reason, .now = gc.now }) catch {
        s.gpa.free(script);
        s.gpa.free(grant);
        return;
    };
    if (s.in_pump or s.in_work) s.pumping_entry.?.group.group.release_pause = true;
}

fn propAnswer(s: *Session, gpa: Allocator) ?objects.Result {
    const a = &(s.answer orelse return null);
    s.pumping_entry.?.group.group.answering_crossing = false;
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
    switch (op.scope) {
        .none => {},
        .opens => |x| {
            a.free(x.name);
            a.free(x.abandon);
        },
        .closes => |x| a.free(x),
    }
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
/// layer's. The Core validates mode, metering, scope and Segment-bound
/// combinations when the Capability is defined.
fn operationOf(s: *Session, capability: []const u8, j: Json) (Allocator.Error || Invalid)!caps.Operation {
    const a = s.core.gpa;
    if (j != .object) return error.InvalidValue;
    const name = asText(j.object.get("name")) orelse return error.InvalidValue;
    if (name.len == 0) return error.InvalidValue;
    for ([_][]const u8{ "ask", "tell", "send", "wait", "end" }) |refused| if (std.mem.eql(u8, name, refused)) return error.InvalidValue;
    const segment_bound = if (j.object.get("segmentBound")) |b| asBool(b) orelse return error.InvalidValue else false;
    const mode = try modeOf(j.object.get("mode"));
    const metering: ?caps.Metering = if (j.object.get("metering")) |v| blk: {
        const m = asText(v) orelse return error.InvalidValue;
        if (std.mem.eql(u8, m, "read-only")) break :blk .read_only;
        if (std.mem.eql(u8, m, "segment-bound")) break :blk .segment_bound;
        return error.InvalidValue;
    } else null;
    var scope: caps.Scope = .none;
    errdefer switch (scope) {
        .none => {},
        .opens => |x| {
            a.free(x.name);
            a.free(x.abandon);
        },
        .closes => |x| a.free(x),
    };
    if (j.object.get("scope")) |given| {
        if (asText(field(given, "closes"))) |closes| {
            scope = .{ .closes = try a.dupe(u8, closes) };
        } else {
            const opens = asText(field(given, "opens")) orelse return error.InvalidValue;
            const abandon = asText(field(given, "abandon")) orelse return error.InvalidValue;
            const owned = try a.dupe(u8, opens);
            scope = .{ .opens = .{ .name = owned, .abandon = a.dupe(u8, abandon) catch {
                a.free(owned);
                return error.OutOfMemory;
            } } };
        }
    }
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
        .scope = scope,
        .segment_bound = segment_bound,
        .metering = metering,
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
    if (if (s.admitting) null else entry) |e| {
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
        .effect => {
            o.raw("\"m\":\"effect\",\"script\":") catch {};
            o.text(n.script) catch {};
            o.raw(",\"run\":") catch {};
            o.text(n.run) catch {};
            o.raw(",\"segment\":") catch {};
            o.text(n.segment) catch {};
            o.raw(",\"grant\":") catch {};
            o.text(n.grant) catch {};
            o.raw(",\"grants\":[") catch {};
            for (n.grants, 0..) |g, i| {
                if (i > 0) o.raw(",") catch {};
                o.text(g) catch {};
            }
            o.raw("]") catch {};
            if (n.coordinator) |c| {
                o.raw(",\"coordinator\":") catch {};
                o.text(c) catch {};
            }
            o.raw(",\"phase\":") catch {};
            o.text(@tagName(n.phase)) catch {};
            o.raw(",\"now\":") catch {};
            o.instant(s.gpa, n.now) catch {};
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
    // The accounting tail first, as talk.h's report calls write it: its
    // rows for ended Runs are held in the reports being taken.
    entry.group.group.accountingTail();
    var held = entry.group.group.reports.take();
    defer held.deinit();
    try o.raw(",");
    try writeHeld(o, &held);
}

/// The `reports` field, from reports already taken from the Group.
fn writeHeld(o: *Out, held: *const machine.report.Reports) Allocator.Error!void {
    try o.raw("\"reports\":[");
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
        .charge_result => |r| {
            try o.raw("{\"kind\":\"charge result\",\"request\":");
            try o.text(r.request);
            try o.raw(",\"call\":");
            try o.text(r.call);
            try o.raw(",\"fuel\":");
            try o.int(r.fuel);
            try o.raw(",\"status\":");
            try o.text(@tagName(r.status));
            try o.raw("}");
        },
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
    entry.writeAbandoned(&o) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// Runs or resumes a Pump until it ends or pauses at a crossing, and
/// writes its reply.
fn runPump(s: *Session, ref: i64, entry: *GroupEntry, resuming: bool, now: model.dates.Instant, slice: u64, cap: u64) []u8 {
    if (entry.group.memory.refused) return hostError(s.gpa, ref, .out_of_memory);
    s.in_pump = true;
    s.exchange_pump = true;
    s.exchange_entry = entry;
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
        return pausedReply(s, ref);
    }
    return holdForReleases(s, ref, pumpOk(s, ref, entry));
}

/// A release may be the only reason execution paused: its acknowledgement
/// resumes the saved worker rather than returning a precomputed final reply.
fn pausedReply(s: *Session, ref: i64) []u8 {
    if (s.need != null) return holdForReleases(s, ref, needReply(s, ref));
    std.debug.assert(s.releases.items.len > 0);
    s.release_continuation = true;
    return holdForReleases(s, ref, s.gpa.dupe(u8, "") catch return oomReply());
}

/// Sends the Core's queued Grant releases before `reply`: the first as a
/// `release` need, holding `reply` until the last `release-result`.
fn holdForReleases(s: *Session, ref: i64, reply: []u8) []u8 {
    if (s.releases.items.len == 0) {
        if (s.paused_ref == null) s.exchange_entry = null;
        return reply;
    }
    s.held = reply;
    s.held_ref = ref;
    return releaseNeed(s, ref);
}

fn releaseNeed(s: *Session, ref: i64) []u8 {
    const r = s.releases.items[0];
    var o = Out.init(s.gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"need\":{\"m\":\"release\",\"script\":") catch {};
    o.text(r.script) catch {};
    o.raw(",\"grant\":") catch {};
    o.text(r.grant) catch {};
    o.raw(",\"reason\":") catch {};
    o.text(@tagName(r.reason)) catch {};
    o.raw(",\"now\":") catch {};
    o.instant(s.gpa, r.now) catch {};
    o.raw("}}") catch {};
    return o.finish() catch oomReply();
}

/// `release-result`: the next release, or the held reply.
fn releaseResultReply(s: *Session, ref: i64) []u8 {
    var done = s.releases.orderedRemove(0);
    done.deinit(s.gpa);
    if (s.releases.items.len > 0) return releaseNeed(s, ref);
    const reply = s.held.?;
    s.held = null;
    if (s.release_continuation) {
        s.release_continuation = false;
        s.gpa.free(reply);
        s.paused_ref = null;
        const entry = s.exchange_entry.?;
        entry.group.group.release_pause = false;
        if (s.work_paused) {
            s.work_paused = false;
            return runWork(s, ref, entry, .resumed);
        }
        return runPump(s, ref, entry, true, .{ .seconds = 0, .nanos = 0 }, 0, 0);
    }
    if (s.exchange_entry) |e| e.group.group.release_pause = false;
    if (s.paused_ref == null) s.exchange_entry = null;
    return reply;
}

/// `effect-result`: `status` of `ok`, `failed` or `unknown`; anything
/// else is `unknown`, as is a malformed reply. The re-made hook takes it.
fn answerEffect(s: *Session, msg: Json, ref: i64) []u8 {
    const given = asText(field(msg, "status")) orelse "unknown";
    const status: caps.EffectStatus = if (std.mem.eql(u8, given, "ok")) .ok else if (std.mem.eql(u8, given, "failed")) .failed else .unknown;
    var spent = s.need.?;
    const entry = spent.entry;
    s.need = null;
    s.paused_ref = null;
    spent.release(s.gpa);
    s.effect_answer = status;
    return resumeAnswered(s, ref, entry);
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
    if (field(msg, "charged")) |v| {
        answer.charged = asU64(v) orelse return hostError(s.gpa, ref, .invalid_value);
        if (answer.charged > 9_007_199_254_740_991) return hostError(s.gpa, ref, .invalid_value);
    }
    if (is_prop) {
        if (field(msg, "value")) |v| {
            answer.kind = .result;
            answer.value = decodeValue(s.gpa, v, entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
        } else if (field(msg, "ok") != null) {
            answer.kind = .done;
        } else if (field(msg, "fail")) |f| {
            answer.kind = .fail;
            failureOf(s, entry, f, &answer) catch |e| {
                if (e == error.OutOfMemory) return hostError(s.gpa, ref, .out_of_memory);
                answer.kind = .host_error;
            };
        } else if (field(msg, "hostError") != null) {
            answer.kind = .host_error;
        } else return protocolError(s.gpa, ref, "a prop-result with no outcome");
    } else {
        if (field(msg, "limit")) |v| {
            if (!(asBool(v) orelse false)) return hostError(s.gpa, ref, .invalid_value);
            answer.kind = .limit;
        } else if (field(msg, "result")) |v| {
            answer.kind = .result;
            answer.value = decodeValue(s.gpa, v, entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
        } else if (field(msg, "started") != null) {
            answer.kind = .started;
        } else if (field(msg, "done") != null) {
            answer.kind = .done;
        } else if (field(msg, "fail")) |f| {
            answer.kind = .fail;
            failureOf(s, entry, f, &answer) catch |e| {
                if (e == error.OutOfMemory) return hostError(s.gpa, ref, .out_of_memory);
                answer.kind = .host_error;
            };
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
    return resumeAnswered(s, ref, entry);
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
    o.raw(",\"features\":[\"paused-inputs-v1\"]") catch return oomReply();
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
    const lifecycle = asBool(field(msg, "segmentLifecycle")) orelse false;
    const releasing = asBool(field(msg, "release")) orelse false;
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
    // A Segment Capability gives each Grant its own Coordinator, unless
    // the Grant names a shared one; its hooks reach the Host as `effect`
    // needs, and its release hook as `release` needs.
    var coordinator_of: ?caps.CoordinatorOf = null;
    if (lifecycle) {
        const own = s.gpa.create(EffectContext) catch return hostError(s.gpa, ref, .out_of_memory);
        own.* = .{ .session = s };
        s.effect_contexts.append(s.gpa, own) catch {
            s.gpa.destroy(own);
            return hostError(s.gpa, ref, .out_of_memory);
        };
        coordinator_of = .{ .call = coordinatorOf, .context = own };
    }
    const release: ?caps.ReleaseHook = if (releasing) .{ .call = releaseHook, .context = s } else null;
    var def: ?*caps.Capability = null;
    const code = talk.defineCapabilityZigWith(s.core, name, ops, coordinator_of, release, &def);
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
    const def = s.capabilityNamed(capability) orelse return hostError(s.gpa, ref, .invalid_value);
    // A named Segment Coordinator, shared by every Grant given the name,
    // rides on the Grant's binding.
    var binding: ?*anyopaque = null;
    if (field(msg, "coordinator")) |j| {
        const named = asText(j) orelse return hostError(s.gpa, ref, .invalid_value);
        if (def.coordinator_of == null) return hostError(s.gpa, ref, .invalid_value);
        binding = namedCoordinator(s, named) catch return hostError(s.gpa, ref, .out_of_memory);
    }
    var grant: ?*caps.Grant = null;
    const ops_j = field(msg, "ops") orelse return hostError(s.gpa, ref, .invalid_value);
    const code = blk: {
        if (asText(ops_j)) |word| {
            if (!std.mem.eql(u8, word, "all")) return hostError(s.gpa, ref, .invalid_value);
            break :blk Direct.grantAll(def, binding, &grant);
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
        break :blk Direct.grant(def, if (names.len == 0) null else names.ptr, if (lens.len == 0) null else lens.ptr, names.len, binding, &grant);
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
                return hostError(s.gpa, ref, decodeError(e, entry));
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
fn requestChargeReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const call = asText(field(msg, "call")) orelse return hostError(s.gpa, ref, .invalid_value);
    // A non-whole amount uses an invalid sentinel, preserving enqueue validation/Trace.
    const fuel = asInt(field(msg, "fuel")) orelse -1;
    var request: ?*caps.ChargeRequest = null;
    const code = Direct.requestCharge(entry.group, call.ptr, call.len, fuel, &request);
    if (code != .ok) {
        entry.group.flush();
        return hostError(s.gpa, ref, code);
    }
    const q = request.?;
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"request\":") catch return oomReply();
    o.text(q.id) catch return oomReply();
    return finishOk(s, &o, entry);
}

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
            data = decodeValue(s.gpa, d, entry) catch |err| return hostError(s.gpa, ref, decodeError(err, entry));
        };
        defer if (data) |d| d.release();
        const failure: talk.ScriptError = .{ .code = ecode.ptr, .code_len = ecode.len, .message = if (emessage) |m| m.ptr else null, .message_len = if (emessage) |m| m.len else 0, .data = data };
        break :blk Direct.callFail(c, &failure);
    } else blk: {
        const vj = field(msg, "value") orelse return hostError(s.gpa, ref, .invalid_value);
        const v = decodeValue(s.gpa, vj, entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
        defer v.release();
        break :blk Direct.callAnswer(c, v);
    };
    if (code != .ok) return hostError(s.gpa, ref, code);
    entry.untrack(call_id);
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

/// `reload` (`source`, `carry`, optional `keepMailbox`) and `extend`
/// (`source`). A refused source is a load error with its diagnostics.
fn changeCodeReply(s: *Session, msg: Json, ref: i64, is_extend: bool) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const script = scriptOf(entry, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    var carry: talk.CarryOver = .reset_variables;
    var options: talk.ReloadOptions = .{ .keep_mailbox = false };
    if (!is_extend) {
        carry = carryOf(field(msg, "carry")) orelse return hostError(s.gpa, ref, .invalid_value);
        if (field(msg, "keepMailbox")) |k| options.keep_mailbox = asBool(k) orelse return hostError(s.gpa, ref, .invalid_value);
    }
    // Trace lines from earlier work are not this change's.
    entry.group.flush();
    freeTrace(s.gpa, takeTrace(entry));
    if (!is_extend) {
        if (!std.unicode.utf8ValidateSlice(source)) return hostError(s.gpa, ref, .invalid_value);
        const target = entry.group.group.script(script.name) orelse return hostError(s.gpa, ref, .invalid_value);
        return runWork(s, ref, entry, .{ .reload = .{ .script = target, .source = source, .carry = carry == .carry_variables, .keep_mailbox = options.keep_mailbox } });
    }
    const code = Direct.scriptExtend(script, source.ptr, source.len);
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
    return holdForReleases(s, ref, finishOk(s, &o, entry));
}

/// The compiled Library a `{"$bytes": …}` identity names, Core-wide.
fn libraryOf(s: *Session, j: Json) ?*machine.Library {
    const text = asText(field(j, "$bytes")) orelse return null;
    const codec = std.base64.standard.Decoder;
    if ((codec.calcSizeForSlice(text) catch return null) != 32) return null;
    var identity: [32]u8 = undefined;
    codec.decode(&identity, text) catch return null;
    for (s.core.libraries.items) |l| if (std.mem.eql(u8, &l.identity, &identity)) return l;
    return null;
}

/// `compile-library`: `name`, `version`, `source`, `imports` (identities)
/// and `declarations` (`{grant: {operation: {mode, args}}}`), replying the
/// Library's `identity` and `needs`.
fn compileLibraryReply(s: *Session, msg: Json, ref: i64) []u8 {
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const version = asText(field(msg, "version")) orelse "";
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    var scratch: std.heap.ArenaAllocator = .init(s.gpa);
    defer scratch.deinit();
    const a = scratch.allocator();
    var imports: []*machine.Library = &.{};
    if (field(msg, "imports")) |given| {
        if (given != .array) return hostError(s.gpa, ref, .invalid_value);
        imports = a.alloc(*machine.Library, given.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
        for (given.array.items, imports) |item, *slot| slot.* = libraryOf(s, item) orelse return hostError(s.gpa, ref, .invalid_value);
    }
    // Shapes are reference counted; the arena holds the list of them.
    var shapes: std.ArrayList(*caps.Shape) = .empty;
    defer for (shapes.items) |x| x.release();
    var declared: ?[]talk.GrantDecls = null;
    if (field(msg, "declarations")) |given| {
        if (given != .object) return hostError(s.gpa, ref, .invalid_value);
        const grants = a.alloc(talk.GrantDecls, given.object.count()) catch return hostError(s.gpa, ref, .out_of_memory);
        for (given.object.keys(), given.object.values(), grants) |grant, ops_json, *g| {
            if (ops_json != .object) return hostError(s.gpa, ref, .invalid_value);
            const ops = a.alloc(talk.OperationCheck, ops_json.object.count()) catch return hostError(s.gpa, ref, .out_of_memory);
            for (ops_json.object.keys(), ops_json.object.values(), ops) |op, decl, *slot| {
                const mode = modeOf(field(decl, "mode")) catch return hostError(s.gpa, ref, .invalid_value);
                const args_json = field(decl, "args") orelse Json{ .array = .init(a) };
                if (args_json != .array) return hostError(s.gpa, ref, .invalid_value);
                const args = a.alloc(*const caps.Shape, args_json.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
                for (args_json.array.items, args) |item, *arg| {
                    const shape = shapeOf(s.gpa, item, 0) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
                    shapes.append(a, shape) catch {
                        shape.release();
                        return hostError(s.gpa, ref, .out_of_memory);
                    };
                    arg.* = shape;
                }
                slot.* = .{ .name = op.ptr, .name_len = op.len, .mode = std.meta.stringToEnum(talk.Mode, @tagName(mode)).?, .args = args.ptr, .args_len = args.len };
            }
            g.* = .{ .name = grant.ptr, .name_len = grant.len, .operations = ops.ptr, .operations_len = ops.len };
        }
        declared = grants;
    }
    const src: talk.LibrarySource = .{ .name = name.ptr, .name_len = name.len, .version = version.ptr, .version_len = version.len, .source = source.ptr, .source_len = source.len };
    var library: ?*machine.Library = null;
    var load_error: ?*talk.LoadError = null;
    defer Direct.loadErrorRelease(load_error);
    const code = Direct.compileLibrary(s.core, &src, imports.ptr, imports.len, if (declared) |d| d.ptr else null, if (declared) |d| d.len else 0, &library, &load_error);
    if (code == .load_refused) if (load_error) |e| return libraryLoadError(s.gpa, ref, e);
    if (code != .ok) return hostError(s.gpa, ref, code);
    const l = library.?;
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"identity\":") catch {};
    o.bytesTag(s.gpa, &l.identity) catch return oomReply();
    o.raw(",\"needs\":[") catch {};
    for (l.operations, 0..) |r, i| {
        if (i > 0) o.raw(",") catch {};
        o.raw("{\"capability\":") catch {};
        o.text(r.capability[0..r.capability_len]) catch {};
        o.raw(",\"operation\":") catch {};
        o.text(r.operation[0..r.operation_len]) catch {};
        o.raw("}") catch {};
    }
    o.raw("]") catch {};
    return finishOk(s, &o, null);
}

/// `add-library` (`identity`) and `replace-library` (`identity`, `carry`),
/// the latter replying with `reports`.
fn libraryInputReply(s: *Session, msg: Json, ref: i64, is_replace: bool) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const library = libraryOf(s, field(msg, "identity") orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value);
    if (!is_replace) {
        const code = Direct.addLibrary(entry.group, library);
        if (code != .ok) return hostError(s.gpa, ref, code);
        var o = Out.init(s.gpa);
        defer o.deinit();
        beginOk(&o, ref) catch return oomReply();
        return holdForReleases(s, ref, finishOk(s, &o, entry));
    }
    const carry = carryOf(field(msg, "carry")) orelse return hostError(s.gpa, ref, .invalid_value);
    entry.group.flush();
    freeTrace(s.gpa, takeTrace(entry));
    return runWork(s, ref, entry, .{ .replace = .{ .library = library, .carry = carry == .carry_variables } });
}

/// A Reload or library replacement to start, or one paused to go on with.
const Work = union(enum) {
    reload: struct { script: *machine.Script, source: []const u8, carry: bool, keep_mailbox: bool },
    replace: struct { library: *machine.Library, carry: bool },
    resumed,
};

/// Runs a Reload or library replacement, or goes on with a paused one,
/// where a lifecycle crossing as it ends the old code's Runs may pause
/// for a need; its reply is that need, or the outcome.
fn runWork(s: *Session, ref: i64, entry: *GroupEntry, work: Work) []u8 {
    if (entry.group.memory.refused) return hostError(s.gpa, ref, .out_of_memory);
    const mg = &entry.group.group;
    const c = s.core;
    s.in_work = true;
    s.exchange_pump = false;
    s.exchange_entry = entry;
    s.pumping_entry = entry;
    defer {
        s.in_work = false;
        s.pumping_entry = null;
    }
    const outcome: machine.Group.Resumed = switch (work) {
        .reload => |x| .{ .reload = mg.reload(x.script, x.source, x.carry, x.keep_mailbox) catch |e| return hostError(s.gpa, ref, talk.status(e)) },
        .replace => |x| blk: {
            // Room for every Library it could recompile, which the Core
            // owns once the Group uses them.
            c.libraries.ensureUnusedCapacity(c.gpa, mg.libraries.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
            break :blk .{ .replace = mg.replaceLibrary(x.library, x.carry, c.gpa) catch |e| return hostError(s.gpa, ref, talk.status(e)) };
        },
        .resumed => mg.resumeWork() catch |e| return hostError(s.gpa, ref, talk.status(e)),
    };
    entry.group.flush();
    const paused = switch (outcome) {
        .reload => |r| r == .paused,
        .replace => |r| r == .paused,
    };
    if (paused) {
        s.paused_ref = ref;
        s.work_paused = true;
        return pausedReply(s, ref);
    }
    switch (outcome) {
        .reload => |r| switch (r) {
            .reloaded => {},
            .refused => return workRefused(s, ref, entry),
            .state_too_large => return workError(s, ref, entry, .state_too_large),
            .stopped => return workError(s, ref, entry, .effect_state_unknown),
            .paused => unreachable,
        },
        .replace => |r| switch (r) {
            .replaced => |made| {
                defer mg.gpa.free(made);
                c.libraries.ensureUnusedCapacity(c.gpa, made.len) catch return hostError(s.gpa, ref, .out_of_memory);
                c.libraries.appendSliceAssumeCapacity(made);
            },
            .refused => return workRefused(s, ref, entry),
            .unknown_library => return workError(s, ref, entry, .invalid_value),
            .state_too_large => return workError(s, ref, entry, .state_too_large),
            .stopped => return workError(s, ref, entry, .effect_state_unknown),
            .paused => unreachable,
        },
    }
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    mg.accountingTail();
    var held = mg.reports.take();
    defer held.deinit();
    writeHeld(&o, &held) catch return oomReply();
    entry.writeAbandoned(&o) catch return oomReply();
    return holdForReleases(s, ref, finishOk(s, &o, entry));
}

fn workRefused(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    const lines = takeTrace(entry);
    defer freeTrace(s.gpa, lines);
    return loadError(s.gpa, ref, lines);
}

fn workError(s: *Session, ref: i64, entry: *GroupEntry, code: talk.HostErrorCode) []u8 {
    freeTrace(s.gpa, takeTrace(entry));
    return holdForReleases(s, ref, hostError(s.gpa, ref, code));
}

/// After an answer, the paused Reload or library replacement goes on, or
/// else the paused Pump.
fn resumeAnswered(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    entry.group.group.answering_crossing = true;
    if (s.work_paused) {
        s.work_paused = false;
        return runWork(s, ref, entry, .resumed);
    }
    return runPump(s, ref, entry, true, .{ .seconds = 0, .nanos = 0 }, 0, 0);
}

/// `talk.ts`'s CarryOver text.
fn carryOf(j: ?Json) ?talk.CarryOver {
    const given = asText(j) orelse return null;
    if (std.mem.eql(u8, given, "carry variables")) return .carry_variables;
    if (std.mem.eql(u8, given, "reset variables")) return .reset_variables;
    return null;
}

/// `inspect`: every Script's variables, live Runs and mailbox, as
/// `talk.ts`'s Inspection.
fn inspectReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    var inspection: ?*talk.Inspection = null;
    const code = Direct.inspect(entry.group, &inspection);
    if (code != .ok) return hostError(s.gpa, ref, code);
    defer Direct.inspectionRelease(inspection);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    writeInspection(&o, s.gpa, inspection.?) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    return finishOk(s, &o, entry);
}

fn writeInspection(o: *Out, gpa: Allocator, i: *const talk.Inspection) (Allocator.Error || error{NotEncodable})!void {
    try o.raw("\"scripts\":[");
    for (i.scripts[0..i.scripts_len], 0..) |sv, n| {
        if (n > 0) try o.raw(",");
        try o.raw("{\"name\":");
        try o.text(sv.name[0..sv.name_len]);
        if (sv.disabled_grants_len > 0) {
            try o.raw(",\"disabledGrants\":[");
            for (sv.disabled_grants[0..sv.disabled_grants_len], 0..) |g, k| {
                if (k > 0) try o.raw(",");
                try o.text(g.data[0..g.len]);
            }
            try o.raw("]");
        }
        try o.raw(",\"vars\":[");
        for (sv.vars[0..sv.vars_len], 0..) |pair, k| {
            if (k > 0) try o.raw(",");
            try o.raw("[");
            try o.text(pair.key.?[0..pair.key_len]);
            try o.raw(",");
            try o.value(pair.value);
            try o.raw("]");
        }
        try o.raw("],\"runs\":[");
        for (sv.runs[0..sv.runs_len], 0..) |r, k| {
            if (k > 0) try o.raw(",");
            try o.raw("{\"id\":");
            try o.text(r.id[0..r.id_len]);
            try o.raw(",\"status\":");
            try o.text(@tagName(r.status));
            try o.raw(",\"handler\":");
            try o.text(r.handler[0..r.handler_len]);
            if (r.status == .suspended) {
                try o.raw(",\"wait\":");
                try o.text(r.wait[0..r.wait_len]);
                if (r.has_until) {
                    try o.raw(",\"until\":");
                    try o.instant(gpa, .{ .seconds = r.until_seconds, .nanos = r.until_nanos });
                }
                try o.raw(",\"calls\":[");
                for (r.calls[0..r.calls_len], 0..) |c, m| {
                    if (m > 0) try o.raw(",");
                    try o.text(c.data[0..c.len]);
                }
                try o.raw("]");
            }
            try o.raw("}");
        }
        try o.raw("],\"mailbox\":[");
        for (sv.mailbox[0..sv.mailbox_len], 0..) |mv, k| {
            if (k > 0) try o.raw(",");
            try o.raw("{");
            if (mv.delivery_len > 0) {
                try o.raw("\"delivery\":");
                try o.text(mv.delivery[0..mv.delivery_len]);
                try o.raw(",");
            }
            if (mv.from_len > 0) {
                try o.raw("\"from\":");
                try o.text(mv.from[0..mv.from_len]);
                try o.raw(",");
            }
            try o.raw("\"message\":{\"name\":");
            try o.text(mv.message.name.?[0..mv.message.name_len]);
            try o.raw(",\"args\":[");
            const args: []const *Value = if (mv.message.args_len == 0) &.{} else mv.message.args.?[0..mv.message.args_len];
            for (args, 0..) |v, m| {
                if (m > 0) try o.raw(",");
                try o.value(v);
            }
            try o.raw("]}}");
        }
        try o.raw("]}");
    }
    try o.raw("]");
}

/// `grants`: each name the Script keeps, with its kept Operations, as the
/// reply's fields.
fn grantsReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const script = scriptOf(entry, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    var views: [*]const talk.ScriptGrant = undefined;
    const n = Direct.scriptGrants(script, &views);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    for (views[0..n], 0..) |g, k| {
        if (k > 0) o.raw(",") catch {};
        o.text(g.name[0..g.name_len]) catch {};
        o.raw(":[") catch {};
        for (g.operations[0..g.operations_len], 0..) |op, m| {
            if (m > 0) o.raw(",") catch {};
            o.text(op.data[0..op.len]) catch {};
        }
        o.raw("]") catch {};
    }
    return finishOk(s, &o, entry);
}

/// The Grants and Host Objects a restore asks the Host for, as the Core
/// asks for them, and, once the Host has answered, the answers.
const Resolving = struct {
    gpa: Allocator,
    grants: std.ArrayList([2][]u8) = .empty,
    objects: std.ArrayList([2][]u8) = .empty,
    answered: bool = false,
    grant_answers: []?*caps.Grant = &.{},
    object_answers: []bool = &.{},
    oom: bool = false,

    fn deinit(r: *Resolving) void {
        for ([_]*std.ArrayList([2][]u8){ &r.grants, &r.objects }) |list| {
            for (list.items) |pair| {
                r.gpa.free(pair[0]);
                r.gpa.free(pair[1]);
            }
            list.deinit(r.gpa);
        }
        r.gpa.free(r.grant_answers);
        r.gpa.free(r.object_answers);
    }

    /// The index of `(a, b)` in `list`, recorded on first sight when the
    /// Host hasn't answered yet.
    fn index(r: *Resolving, list: *std.ArrayList([2][]u8), a: []const u8, b: []const u8) ?usize {
        for (list.items, 0..) |pair, i| if (std.mem.eql(u8, pair[0], a) and std.mem.eql(u8, pair[1], b)) return i;
        if (r.answered) return null;
        const x = r.gpa.dupe(u8, a) catch {
            r.oom = true;
            return null;
        };
        const y = r.gpa.dupe(u8, b) catch {
            r.gpa.free(x);
            r.oom = true;
            return null;
        };
        list.append(r.gpa, .{ x, y }) catch {
            r.gpa.free(x);
            r.gpa.free(y);
            r.oom = true;
            return null;
        };
        return null;
    }

    fn rebind(context: ?*anyopaque, script: [*]const u8, script_len: usize, name: [*]const u8, name_len: usize) callconv(.c) ?*caps.Grant {
        const r: *Resolving = @ptrCast(@alignCast(context.?));
        const i = r.index(&r.grants, script[0..script_len], name[0..name_len]) orelse return null;
        return r.grant_answers[i];
    }

    fn resolve(context: ?*anyopaque, kind: [*]const u8, kind_len: usize, id: [*]const u8, id_len: usize, native: *?*anyopaque) callconv(.c) bool {
        const r: *Resolving = @ptrCast(@alignCast(context.?));
        native.* = null;
        const i = r.index(&r.objects, kind[0..kind_len], id[0..id_len]) orelse return false;
        return r.object_answers[i];
    }
};

/// A `restore` whose `resolve` need is open: its frame, read again when
/// the Host answers, and what the Core asked for.
const Restoring = struct {
    ref: i64,
    frame: []u8,
    resolving: Resolving,

    fn deinit(r: *Restoring) void {
        r.resolving.gpa.free(r.frame);
        r.resolving.deinit();
    }
};

/// The fields `restore` reads: the save, the Libraries by identity and the
/// mismatch policy.
const RestoreRequest = struct {
    save: []u8,
    libraries: []*machine.Library,
    mismatch: talk.MismatchPolicy,

    fn of(s: *Session, msg: Json) ?RestoreRequest {
        const text = asText(field(field(msg, "save") orelse return null, "$bytes")) orelse return null;
        const codec = std.base64.standard.Decoder;
        const save = s.gpa.alloc(u8, codec.calcSizeForSlice(text) catch return null) catch return null;
        codec.decode(save, text) catch {
            s.gpa.free(save);
            return null;
        };
        var libraries: []*machine.Library = &.{};
        if (field(msg, "libraries")) |given| {
            if (given != .array) {
                s.gpa.free(save);
                return null;
            }
            libraries = s.gpa.alloc(*machine.Library, given.array.items.len) catch {
                s.gpa.free(save);
                return null;
            };
            for (given.array.items, libraries) |item, *slot| slot.* = libraryOf(s, item) orelse {
                s.gpa.free(libraries);
                s.gpa.free(save);
                return null;
            };
        }
        const policy = asText(field(msg, "mismatch")) orelse "reject";
        const mismatch: talk.MismatchPolicy = if (std.mem.eql(u8, policy, "reject")) .reject_mismatch else if (std.mem.eql(u8, policy, "variables only")) .variables_only else {
            s.gpa.free(libraries);
            s.gpa.free(save);
            return null;
        };
        return .{ .save = save, .libraries = libraries, .mismatch = mismatch };
    }

    fn deinit(r: RestoreRequest, gpa: Allocator) void {
        gpa.free(r.save);
        gpa.free(r.libraries);
    }
};

/// `restore`: a first pass records every Grant and Host Object the Core
/// asks for, answering none; the `resolve` need asks the Host for them,
/// and `resolve-result` restores again with its answers. A restore that
/// asks for nothing replies at once.
fn restoreReply(s: *Session, msg: Json, ref: i64, frame: []const u8) []u8 {
    const handle_name = asText(field(msg, "group")) orelse asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    if (s.groupNamed(handle_name) != null) return hostError(s.gpa, ref, .name_reused);
    const request = RestoreRequest.of(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    defer request.deinit(s.gpa);
    var resolving: Resolving = .{ .gpa = s.gpa };
    var group: ?*talk.Group = null;
    var result: ?*talk.RestoreResult = null;
    const options: talk.RestoreOptions = .{ .name = handle_name.ptr, .name_len = handle_name.len, .trace = null, .trace_context = null, .libraries = request.libraries.ptr, .libraries_len = request.libraries.len, .grants = Resolving.rebind, .grants_context = &resolving, .resolve = Resolving.resolve, .resolve_context = &resolving, .mismatch = request.mismatch, .allocator = null, .memory_cap = std.math.maxInt(usize) };
    const code = Direct.restore(s.core, request.save.ptr, request.save.len, &options, &group, &result);
    Direct.restoreResultRelease(result);
    if (group) |g| Direct.groupRelease(g);
    if (resolving.oom) {
        resolving.deinit();
        return hostError(s.gpa, ref, .out_of_memory);
    }
    if (code != .ok) {
        resolving.deinit();
        return hostError(s.gpa, ref, code);
    }
    resolving.answered = true;
    if (resolving.grants.items.len == 0 and resolving.objects.items.len == 0) {
        defer resolving.deinit();
        return restoreWith(s, msg, ref, &resolving);
    }
    const kept = s.gpa.dupe(u8, frame) catch {
        resolving.deinit();
        return hostError(s.gpa, ref, .out_of_memory);
    };
    s.restoring = .{ .ref = ref, .frame = kept, .resolving = resolving };
    var o = Out.init(s.gpa);
    defer o.deinit();
    o.raw("{\"ref\":") catch {};
    o.int(ref) catch {};
    o.raw(",\"need\":{\"m\":\"resolve\",\"grants\":[") catch {};
    for (resolving.grants.items, 0..) |pair, i| {
        if (i > 0) o.raw(",") catch {};
        o.raw("[") catch {};
        o.text(pair[0]) catch {};
        o.raw(",") catch {};
        o.text(pair[1]) catch {};
        o.raw("]") catch {};
    }
    o.raw("],\"objects\":[") catch {};
    for (resolving.objects.items, 0..) |pair, i| {
        if (i > 0) o.raw(",") catch {};
        o.raw("[") catch {};
        o.text(pair[0]) catch {};
        o.raw(",") catch {};
        o.text(pair[1]) catch {};
        o.raw("]") catch {};
    }
    o.raw("]}}") catch {};
    return o.finish() catch oomReply();
}

/// `resolve-result`: `grants`, a handle or null for each asked, and
/// `objects`, a boolean for each, in the need's order.
fn resolveResultReply(s: *Session, msg: Json, ref: i64) []u8 {
    var restoring = s.restoring.?;
    s.restoring = null;
    defer restoring.deinit();
    const r = &restoring.resolving;
    const grants = field(msg, "grants") orelse Json{ .null = {} };
    const objects_given = field(msg, "objects") orelse Json{ .null = {} };
    if (grants != .array or grants.array.items.len != r.grants.items.len) return hostError(s.gpa, ref, .invalid_value);
    if (objects_given != .array or objects_given.array.items.len != r.objects.items.len) return hostError(s.gpa, ref, .invalid_value);
    r.grant_answers = s.gpa.alloc(?*caps.Grant, grants.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
    for (grants.array.items, r.grant_answers) |g, *slot| {
        if (g == .null) {
            slot.* = null;
            continue;
        }
        const h = asInt(g) orelse return hostError(s.gpa, ref, .invalid_value);
        if (h < 1 or h > @as(i64, @intCast(s.grants.items.len))) return hostError(s.gpa, ref, .invalid_value);
        slot.* = s.grants.items[@intCast(h - 1)];
    }
    r.object_answers = s.gpa.alloc(bool, objects_given.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
    for (objects_given.array.items, r.object_answers) |b, *slot| slot.* = asBool(b) orelse return hostError(s.gpa, ref, .invalid_value);
    const parsed = std.json.parseFromSlice(Json, s.gpa, restoring.frame, .{ .parse_numbers = false, .max_value_len = max_frame }) catch return hostError(s.gpa, ref, .out_of_memory);
    defer parsed.deinit();
    return restoreWith(s, parsed.value, ref, r);
}

/// Restores for real, with the Host's answers, and replies with the
/// result.
fn restoreWith(s: *Session, msg: Json, ref: i64, r: *Resolving) []u8 {
    const handle_name = asText(field(msg, "group")) orelse asText(field(msg, "name")).?;
    if (s.groupNamed(handle_name) != null) return hostError(s.gpa, ref, .name_reused);
    const name = asText(field(msg, "name")) orelse handle_name;
    const request = RestoreRequest.of(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    defer request.deinit(s.gpa);
    const entry = s.gpa.create(GroupEntry) catch return hostError(s.gpa, ref, .out_of_memory);
    entry.* = .{ .gpa = s.gpa, .name = s.gpa.dupe(u8, handle_name) catch {
        s.gpa.destroy(entry);
        return hostError(s.gpa, ref, .out_of_memory);
    }, .group = undefined, .traced = asBool(field(msg, "trace")) orelse false };
    var group: ?*talk.Group = null;
    var result: ?*talk.RestoreResult = null;
    const options: talk.RestoreOptions = .{ .name = name.ptr, .name_len = name.len, .trace = traceSink, .trace_context = entry, .libraries = request.libraries.ptr, .libraries_len = request.libraries.len, .grants = Resolving.rebind, .grants_context = r, .resolve = Resolving.resolve, .resolve_context = r, .mismatch = request.mismatch, .allocator = null, .memory_cap = std.math.maxInt(usize) };
    const code = Direct.restore(s.core, request.save.ptr, request.save.len, &options, &group, &result);
    if (code != .ok) {
        for (entry.pending_trace.items) |line| s.gpa.free(line);
        entry.pending_trace.deinit(s.gpa);
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return hostError(s.gpa, ref, code);
    }
    defer Direct.restoreResultRelease(result);
    entry.group = group.?;
    s.groups.append(s.gpa, entry) catch {
        Direct.groupRelease(entry.group);
        for (entry.pending_trace.items) |line| s.gpa.free(line);
        entry.pending_trace.deinit(s.gpa);
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return hostError(s.gpa, ref, .out_of_memory);
    };
    const res = result.?;
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    writeRestored(&o, entry, res) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    return finishOk(s, &o, entry);
}

fn writeRestored(o: *Out, entry: *GroupEntry, res: *const talk.RestoreResult) (Allocator.Error || error{NotEncodable})!void {
    try o.raw("\"variablesOnly\":");
    try o.raw(if (res.variables_only) "true" else "false");
    try o.raw(",\"pending\":[");
    for (res.pending, 0..) |p, i| {
        if (i > 0) try o.raw(",");
        const id = p.id[0..p.id_len];
        try o.raw("{\"call\":");
        try o.text(id);
        try o.raw(",\"script\":");
        try o.text(p.script[0..p.script_len]);
        try o.raw(",\"grant\":");
        try o.text(p.grant[0..p.grant_len]);
        try o.raw(",\"operation\":");
        try o.text(p.operation[0..p.operation_len]);
        try o.raw(",\"args\":[");
        for (entry.group.group.calls.items) |c| if (std.mem.eql(u8, c.id, id)) {
            for (c.args, 0..) |v, k| {
                if (k > 0) try o.raw(",");
                try o.value(v);
            }
        };
        try o.raw("]}");
    }
    try o.raw("],\"disposed\":[");
    for (res.disposed, 0..) |d, i| {
        if (i > 0) try o.raw(",");
        try o.raw("[");
        try o.text(d.kind[0..d.kind_len]);
        try o.raw(",");
        try o.text(d.id[0..d.id_len]);
        try o.raw("]");
    }
    try o.raw("]");
    inline for (.{ .{ "discardedRuns", "discarded" }, .{ "droppedMessages", "dropped" }, .{ "abandonedCalls", "abandoned" } }) |f| {
        try o.raw(",\"" ++ f[0] ++ "\":[");
        for (@field(res, f[1]), 0..) |id, i| {
            if (i > 0) try o.raw(",");
            try o.text(id.data[0..id.len]);
        }
        try o.raw("]");
    }
    try o.raw(",");
    if (res.reports) |reports| try writeHeld(o, &reports.held) else try o.raw("\"reports\":[]");
}

/// `settle`: a restored pending call's `settlement`, `{answer}`, `{fail}`,
/// `{reissue: true}` or `{adopt: true}`; an adopted call is then answered
/// with `answer` or `fail`.
fn settleRestoredReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const call_id = asText(field(msg, "call")) orelse return hostError(s.gpa, ref, .invalid_value);
    const given = field(msg, "settlement") orelse return hostError(s.gpa, ref, .invalid_value);
    if (given != .object or given.object.count() != 1) return hostError(s.gpa, ref, .invalid_value);
    var st: talk.Settlement = .{ .answer = null, .fail = null, .reissue = false, .adopt = false };
    var answer: ?*Value = null;
    defer if (answer) |v| v.release();
    var data: ?*Value = null;
    defer if (data) |v| v.release();
    var failure: talk.ScriptError = undefined;
    if (field(given, "answer")) |j| {
        answer = decodeValue(s.gpa, j, entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
        st.answer = answer;
    } else if (field(given, "fail")) |e| {
        const ecode = asText(field(e, "code")) orelse return hostError(s.gpa, ref, .invalid_value);
        const emessage = asText(field(e, "message"));
        if (field(e, "data")) |d| if (d != .null) {
            data = decodeValue(s.gpa, d, entry) catch |err| return hostError(s.gpa, ref, decodeError(err, entry));
        };
        failure = .{ .code = ecode.ptr, .code_len = ecode.len, .message = if (emessage) |m| m.ptr else null, .message_len = if (emessage) |m| m.len else 0, .data = data };
        st.fail = &failure;
    } else if (field(given, "reissue")) |j| {
        st.reissue = asBool(j) orelse false;
    } else if (field(given, "adopt")) |j| {
        st.adopt = asBool(j) orelse false;
    }
    var adopted: ?*caps.Call = null;
    const code = Direct.settle(entry.group, call_id.ptr, call_id.len, &st, &adopted);
    if (code != .ok) return hostError(s.gpa, ref, code);
    // An adopted call is the Host's to answer, like a started one.
    if (st.adopt) entry.track(call_id);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// `call`: a Request to a Function Value's Home Script, with `fn`, `args`
/// and `limits`.
fn callReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const f = decodeValue(s.gpa, field(msg, "fn") orelse return hostError(s.gpa, ref, .invalid_value), entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
    defer f.release();
    var args: std.ArrayList(*Value) = .empty;
    defer {
        for (args.items) |v| v.release();
        args.deinit(s.gpa);
    }
    if (field(msg, "args")) |given| {
        if (given != .array) return hostError(s.gpa, ref, .invalid_value);
        for (given.array.items) |item| {
            const v = decodeValue(s.gpa, item, entry) catch |e| return hostError(s.gpa, ref, decodeError(e, entry));
            args.append(s.gpa, v) catch {
                v.release();
                return hostError(s.gpa, ref, .out_of_memory);
            };
        }
    }
    var override_slot: talk.LimitOverride = undefined;
    const override = overrideOf(field(msg, "limits"), &override_slot) catch return hostError(s.gpa, ref, .invalid_value);
    var id: talk.Buffer = .{};
    var pending: ?*talk.Pending = null;
    const code = Direct.call(entry.group, f, args.items.ptr, args.items.len, override, &id, &pending);
    if (code != .ok) return hostError(s.gpa, ref, code);
    defer Direct.ownedBytesRelease(&id);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"delivery\":") catch {};
    o.text(if (id.data) |d| d[0..id.len] else "") catch {};
    return finishOk(s, &o, entry);
}

/// `export-manifest`: `kind`, `version`, `grants` (`{name: handle}`),
/// `libraries` (identities), `messages` (`[{name, args, receivers}]`),
/// `objectKinds` (names) and `objects` (`{name: kind}`), replying the
/// Host Manifest's bytes.
fn exportManifestReply(s: *Session, msg: Json, ref: i64) []u8 {
    var scratch: std.heap.ArenaAllocator = .init(s.gpa);
    defer scratch.deinit();
    const a = scratch.allocator();
    var shapes: std.ArrayList(*caps.Shape) = .empty;
    defer for (shapes.items) |x| x.release();
    const spec = manifestSpecOf(s, a, msg, &shapes) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    var buf: talk.Buffer = .{};
    const code = Direct.exportManifest(&spec, &buf);
    if (code != .ok) return hostError(s.gpa, ref, code);
    defer Direct.ownedBytesRelease(&buf);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"manifest\":") catch {};
    o.bytesTag(s.gpa, if (buf.data) |d| d[0..buf.len] else "") catch return oomReply();
    return finishOk(s, &o, null);
}

fn manifestSpecOf(s: *Session, a: Allocator, msg: Json, shapes: *std.ArrayList(*caps.Shape)) (Allocator.Error || Invalid)!talk.ManifestSpec {
    const kind = asText(field(msg, "kind")) orelse return error.InvalidValue;
    const version = asText(field(msg, "version")) orelse return error.InvalidValue;
    var grants: []talk.LoadGrant = &.{};
    if (field(msg, "grants")) |g| {
        if (g != .object) return error.InvalidValue;
        grants = try a.alloc(talk.LoadGrant, g.object.count());
        for (g.object.keys(), g.object.values(), grants) |k, v, *slot| {
            const h = asInt(v) orelse return error.InvalidValue;
            if (h < 1 or h > @as(i64, @intCast(s.grants.items.len))) return error.InvalidValue;
            slot.* = .{ .name = k.ptr, .name_len = k.len, .grant = s.grants.items[@intCast(h - 1)] };
        }
    }
    var libraries: []*const machine.Library = &.{};
    if (field(msg, "libraries")) |given| {
        if (given != .array) return error.InvalidValue;
        libraries = try a.alloc(*const machine.Library, given.array.items.len);
        for (given.array.items, libraries) |item, *slot| slot.* = libraryOf(s, item) orelse return error.InvalidValue;
    }
    var messages: []talk.MessageDecl = &.{};
    if (field(msg, "messages")) |given| {
        if (given != .array) return error.InvalidValue;
        messages = try a.alloc(talk.MessageDecl, given.array.items.len);
        for (given.array.items, messages) |item, *slot| {
            const name = asText(field(item, "name")) orelse return error.InvalidValue;
            const args_json = field(item, "args") orelse Json{ .array = .init(a) };
            if (args_json != .array) return error.InvalidValue;
            const args = try a.alloc(*const caps.Shape, args_json.array.items.len);
            for (args_json.array.items, args) |arg, *x| {
                const shape = try shapeOf(s.gpa, arg, 0);
                shapes.append(a, shape) catch |e| {
                    shape.release();
                    return e;
                };
                x.* = shape;
            }
            const receivers_json = field(item, "receivers") orelse Json{ .array = .init(a) };
            if (receivers_json != .array) return error.InvalidValue;
            const receivers = try a.alloc(*const objects.Kind, receivers_json.array.items.len);
            for (receivers_json.array.items, receivers) |r, *x| x.* = kindNamed(s, asText(r) orelse return error.InvalidValue) orelse return error.InvalidValue;
            slot.* = .{ .name = name.ptr, .name_len = name.len, .args = args.ptr, .args_len = args.len, .receivers = receivers.ptr, .receivers_len = receivers.len };
        }
    }
    var kinds: []*const objects.Kind = &.{};
    if (field(msg, "objectKinds")) |given| {
        if (given != .array) return error.InvalidValue;
        kinds = try a.alloc(*const objects.Kind, given.array.items.len);
        for (given.array.items, kinds) |k, *x| x.* = kindNamed(s, asText(k) orelse return error.InvalidValue) orelse return error.InvalidValue;
    }
    var well_known: []talk.ManifestObject = &.{};
    if (field(msg, "objects")) |given| {
        if (given != .object) return error.InvalidValue;
        well_known = try a.alloc(talk.ManifestObject, given.object.count());
        for (given.object.keys(), given.object.values(), well_known) |k, v, *slot| {
            const kind_of = kindNamed(s, asText(v) orelse return error.InvalidValue) orelse return error.InvalidValue;
            slot.* = .{ .name = k.ptr, .name_len = k.len, .kind = kind_of };
        }
    }
    return .{ .kind = kind.ptr, .kind_len = kind.len, .version = version.ptr, .version_len = version.len, .grants = grants.ptr, .grants_len = grants.len, .libraries = libraries.ptr, .libraries_len = libraries.len, .messages = messages.ptr, .messages_len = messages.len, .object_kinds = kinds.ptr, .object_kinds_len = kinds.len, .objects = well_known.ptr, .objects_len = well_known.len };
}

/// An Operation's context, owned by the Session; its mode is set once the
/// Capability is defined.
fn newOpContext(s: *Session, capability: []const u8, operation: []const u8) Allocator.Error!*OpContext {
    const cap = try s.gpa.dupe(u8, capability);
    errdefer s.gpa.free(cap);
    const op = try s.gpa.dupe(u8, operation);
    errdefer s.gpa.free(op);
    const oc = try s.gpa.create(OpContext);
    errdefer s.gpa.destroy(oc);
    oc.* = .{ .session = s, .capability = cap, .operation = op, .mode = .immediate };
    try s.op_contexts.append(s.gpa, oc);
    return oc;
}

/// `standard-capability`: `name` and `costs` (`{operation: {fuel,
/// alloc}}`). Each Operation the Host implements reaches it as an `op`
/// need, as a defined Capability's does; `clock` is the Core's own.
/// `store` waits on its lifecycle needs, and `sqlite` isn't offered.
fn standardCapabilityReply(s: *Session, msg: Json, ref: i64) []u8 {
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const which = std.meta.stringToEnum(talk.StandardWhich, name) orelse return hostError(s.gpa, ref, .invalid_value);
    if (which == .sqlite) return protocolError(s.gpa, ref, "unknown or unsupported message");
    const names = talk.standardOperations(which);
    const given = field(msg, "costs") orelse return hostError(s.gpa, ref, .invalid_value);
    if (given != .object) return hostError(s.gpa, ref, .invalid_value);
    var entries: std.ArrayList(talk.NamedCost) = .empty;
    defer entries.deinit(s.gpa);
    for (given.object.keys(), given.object.values()) |k, v| {
        const fuel = asInt(field(v, "fuel") orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value);
        const alloc = if (field(v, "alloc")) |x| asInt(x) orelse return hostError(s.gpa, ref, .invalid_value) else 0;
        entries.append(s.gpa, .{ .name = k.ptr, .name_len = k.len, .cost = .{ .fuel = fuel, .alloc = alloc } }) catch return hostError(s.gpa, ref, .out_of_memory);
    }
    const costs: talk.Costs = .{ .entries = entries.items.ptr, .len = entries.items.len };
    // The Core answers `clock.now` itself.
    const hosted = if (which == .clock) 0 else names.len;
    var own: [8]?caps.HostFn = @splat(null);
    var made: [8]*OpContext = undefined;
    for (names[0..hosted], 0..) |op, i| {
        made[i] = newOpContext(s, name, op) catch return hostError(s.gpa, ref, .out_of_memory);
        own[i] = .{ .call = opCall, .context = made[i] };
    }
    // `store`'s lifecycle hooks are one Coordinator's, whatever the
    // binding, and reach the Host as `effect` needs; its release hook as
    // `release` needs.
    var coordinator_of: ?caps.CoordinatorOf = null;
    var release: ?caps.ReleaseHook = null;
    if (which == .store) {
        const one = s.gpa.create(EffectContext) catch return hostError(s.gpa, ref, .out_of_memory);
        one.* = .{ .session = s };
        s.effect_contexts.append(s.gpa, one) catch {
            s.gpa.destroy(one);
            return hostError(s.gpa, ref, .out_of_memory);
        };
        coordinator_of = .{ .call = storeCoordinatorOf, .context = one };
        release = .{ .call = releaseHook, .context = s };
    }
    var def: ?*caps.Capability = null;
    const code = talk.defineStandardZigWith(s.core, which, own[0..hosted], &costs, coordinator_of, release, &def);
    if (code != .ok) return hostError(s.gpa, ref, code);
    // Each context takes its Operation's declared mode.
    for (made[0..hosted]) |oc| for (def.?.operations) |op| if (std.mem.eql(u8, op.name, oc.operation)) {
        oc.mode = op.mode;
    };
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, null);
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

/// Handles one frame and returns its reply frame, owned by the caller
/// (free it with `freeReply`). Never fails: a malformed frame is a
/// protocol error, and the instance carries on.
pub fn handle(s: *Session, frame: []const u8) []u8 {
    handling = s;
    defer handling = null;
    if (!std.unicode.utf8ValidateSlice(frame)) return protocolError(s.gpa, 0, "the frame is not UTF-8");
    const parsed = std.json.parseFromSlice(Json, s.gpa, frame, .{ .parse_numbers = false, .max_value_len = max_frame }) catch |e| return if (e == error.OutOfMemory) oomReply() else protocolError(s.gpa, 0, "the frame is not JSON");
    defer parsed.deinit();
    const msg = parsed.value;
    if (msg != .object) return protocolError(s.gpa, 0, "the frame is not an object");
    const ref = asInt(field(msg, "ref")) orelse return protocolError(s.gpa, 0, "no ref");
    const m = asText(field(msg, "m")) orelse return protocolError(s.gpa, ref, "no message name");
    if (s.restoring) |r| {
        if (ref != r.ref or !std.mem.eql(u8, m, "resolve-result")) return protocolError(s.gpa, ref, "a restore is waiting for its resolve-result");
        return resolveResultReply(s, msg, ref);
    }
    // Releases go first: each `release` need waits for its
    // `release-result`, then the reply they came before.
    if (s.held != null) {
        if (ref != s.held_ref or !std.mem.eql(u8, m, "release-result")) return pausedAdmission(s, msg, ref, m, s.held_ref);
        return releaseResultReply(s, ref);
    }
    if (s.paused_ref) |paused| {
        const want: []const u8 = switch (s.need.?.kind) {
            .op => "op-result",
            .prop => "prop-result",
            .effect => "effect-result",
        };
        if (ref != paused) return pausedAdmission(s, msg, ref, m, paused);
        if (!std.mem.eql(u8, m, want)) {
            if (std.mem.eql(u8, m, "op-result") or std.mem.eql(u8, m, "prop-result") or std.mem.eql(u8, m, "effect-result")) return protocolError(s.gpa, ref, "the result does not match the need");
            return protocolError(s.gpa, ref, "a Pump is waiting for its result");
        }
        if (s.need.?.kind == .effect) return answerEffect(s, msg, ref);
        return answerNeed(s, msg, ref, s.need.?.kind == .prop);
    }
    return dispatch(s, msg, ref, m, frame);
}

fn dispatch(s: *Session, msg: Json, ref: i64, m: []const u8, frame: []const u8) []u8 {
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
    } else if (std.mem.eql(u8, m, "request-charge")) {
        return requestChargeReply(s, msg, ref);
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
    } else if (std.mem.eql(u8, m, "compile-library")) {
        return compileLibraryReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "add-library")) {
        return libraryInputReply(s, msg, ref, false);
    } else if (std.mem.eql(u8, m, "replace-library")) {
        return libraryInputReply(s, msg, ref, true);
    } else if (std.mem.eql(u8, m, "reload")) {
        return changeCodeReply(s, msg, ref, false);
    } else if (std.mem.eql(u8, m, "extend")) {
        return changeCodeReply(s, msg, ref, true);
    } else if (std.mem.eql(u8, m, "standard-capability")) {
        return standardCapabilityReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "export-manifest")) {
        return exportManifestReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "call")) {
        return callReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "restore")) {
        return restoreReply(s, msg, ref, frame);
    } else if (std.mem.eql(u8, m, "settle")) {
        return settleRestoredReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "inspect")) {
        return inspectReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "grants")) {
        return grantsReply(s, msg, ref);
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

fn messageIn(m: []const u8, names: []const []const u8) bool {
    for (names) |name| if (std.mem.eql(u8, m, name)) return true;
    return false;
}

fn pausedAdmission(s: *Session, msg: Json, ref: i64, m: []const u8, worker_ref: i64) []u8 {
    if (ref == worker_ref) return protocolError(s.gpa, ref, "the worker ref is reserved for its result");
    const entry = s.exchange_entry orelse return protocolError(s.gpa, ref, "no paused worker");
    const group = groupOf(s, msg) orelse return protocolError(s.gpa, ref, "a paused input must address the worker's Group");
    if (group != entry) return protocolError(s.gpa, ref, "a paused input must address the worker's Group");
    const worker = messageIn(m, &.{ "load", "reload", "extend", "add-library", "replace-library", "pump", "save", "fingerprint", "inspect", "grants", "counters" });
    if (!worker and !messageIn(m, &.{ "deliver", "request", "broadcast", "decide", "call", "set-parent", "dispose", "stop", "cancel-run", "rewind-run", "revoke", "answer", "fail", "cancel-delivery", "request-charge", "settle", "object" })) return protocolError(s.gpa, ref, "a worker is waiting for its result");
    const mg = &entry.group.group;
    const pumping = mg.pumping;
    const trace = mg.trace;
    // A WASM export has returned, but its Host callback has not. Admission
    // must use the same control queue and Trace hold as native callbacks.
    mg.pumping = s.exchange_pump;
    if (mg.pumping and mg.held_trace == null and trace != null) {
        if (mg.held == null) mg.held = .init(mg.gpa);
        mg.held_trace = trace;
    }
    if (mg.held_trace != null) mg.trace = &mg.held.?.writer;
    s.admitting = true;
    defer {
        s.admitting = false;
        mg.pumping = pumping;
        mg.trace = trace;
    }
    if (worker) {
        recordWorkerRefusal(s, entry, msg, m);
        return hostError(s.gpa, ref, .reentrant_call);
    }
    return dispatch(s, msg, ref, m, &.{});
}

fn recordWorkerRefusal(s: *Session, entry: *GroupEntry, msg: Json, m: []const u8) void {
    const g = &entry.group.group;
    if (std.mem.eql(u8, m, "pump")) {
        const now = model.dates.parseInstant(asText(field(msg, "now")) orelse return) catch return;
        g.refuseWorker(.{ .pump = .{ .now = now, .slice = asInt(field(msg, "fuelSlice")) orelse 0, .cap = asInt(field(msg, "fuelCap")) orelse 0 } });
    } else if (std.mem.eql(u8, m, "load")) {
        g.refuseWorker(.{ .load = .{ .name = asText(field(msg, "name")) orelse return, .source = asText(field(msg, "source")) orelse return } });
    } else if (std.mem.eql(u8, m, "inspect")) {
        g.refuseWorker(.inspect);
    } else if (std.mem.eql(u8, m, "counters")) {
        g.refuseWorker(.{ .counters = asText(field(msg, "script")) orelse return });
    } else if (std.mem.eql(u8, m, "reload") or std.mem.eql(u8, m, "extend")) {
        const script = g.script(asText(field(msg, "script")) orelse return) orelse return;
        const source = asText(field(msg, "source")) orelse return;
        if (std.mem.eql(u8, m, "extend")) {
            g.refuseWorker(.{ .extend = .{ .script = script, .source = source } });
        } else {
            const carry = carryOf(field(msg, "carry")) orelse return;
            g.refuseWorker(.{ .reload = .{ .script = script, .source = source, .carry = carry == .carry_variables, .keep_mailbox = asBool(field(msg, "keepMailbox")) orelse false } });
        }
    } else if (std.mem.eql(u8, m, "add-library") or std.mem.eql(u8, m, "replace-library")) {
        const library = libraryOf(s, field(msg, "identity") orelse return) orelse return;
        if (std.mem.eql(u8, m, "add-library")) {
            g.refuseWorker(.{ .add_library = library });
        } else {
            const carry = carryOf(field(msg, "carry")) orelse return;
            g.refuseWorker(.{ .replace_library = .{ .library = library, .carry = carry == .carry_variables } });
        }
    }
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
        const parsed = std.json.parseFromSlice(Json, a, reply, .{}) catch |e| {
            std.debug.print("unparsable reply to {s}: {s}\n", .{ frame, reply });
            return e;
        };
        try std.testing.expectEqual(@as(i64, r), parsed.value.object.get("ref").?.integer);
        return parsed.value;
    }
};

fn okOf(reply: Json) !Json {
    return reply.object.get("ok") orelse unexpected(reply);
}
fn errKind(reply: Json) ![]const u8 {
    const e = reply.object.get("err") orelse return unexpected(reply);
    return e.object.get("kind").?.string;
}
/// Fails a test, printing the reply it didn't expect.
fn unexpected(reply: Json) error{TestUnexpectedResult} {
    std.debug.print("unexpected reply: {f}\n", .{std.json.fmt(reply, .{})});
    return error.TestUnexpectedResult;
}
fn runEnd(reply: Json) !Json {
    const reports = (try okOf(reply)).object.get("reports").?.array.items;
    for (reports) |r| if (std.mem.eql(u8, r.object.get("kind").?.string, "run end")) return r;
    return unexpected(reply);
}

/// JSON containers around one leaf; the envelope adds another level.
fn nestedJson(a: Allocator, depth: usize, objects_only: bool) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    for (0..depth) |_| try out.writer.writeAll(if (objects_only) "{\"a\":" else "[");
    try out.writer.writeByte('1');
    for (0..depth) |_| try out.writer.writeAll(if (objects_only) "}" else "]");
    return out.toOwnedSlice();
}

test "worker refusals during a paused callback keep Trace after its return" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try pausedFixture(&c, "immediate", "on go\n ask api to read\n return it\nend go", false);
    const inputs = [_][]const u8{
        "{\"m\":\"pump\",\"ref\":7,\"group\":\"g\",\"now\":\"2026-10-14T12:00:00Z\"}",
        "{\"m\":\"load\",\"ref\":8,\"group\":\"g\",\"name\":\"nested\",\"source\":\"\"}",
        "{\"m\":\"inspect\",\"ref\":9,\"group\":\"g\"}",
        "{\"m\":\"save\",\"ref\":10,\"group\":\"g\"}",
    };
    for (inputs, 7..) |input, ref| {
        const refused = try c.common(@intCast(ref), "{s}", .{input});
        try std.testing.expectEqualStrings("reentrant call", refused.object.get("err").?.object.get("code").?.string);
        try std.testing.expect(refused.object.get("trace") == null);
    }
    const completed = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"result\":42}}", .{});
    const done = try okOf(completed);
    var called = false;
    var refused_count: usize = 0;
    for (done.object.get("trace").?.array.items) |line| {
        if (std.mem.startsWith(u8, line.string, "call s/r1.c1")) called = true;
        if (std.mem.eql(u8, line.string, "refused code=\"reentrant call\"")) {
            try std.testing.expect(called);
            refused_count += 1;
        }
        try std.testing.expect(!std.mem.startsWith(u8, line.string, "> save"));
    }
    try std.testing.expectEqual(@as(usize, 3), refused_count);
    try std.testing.expectEqual(@as(i64, 42), (try runEnd(completed)).object.get("result").?.integer);
}

test "property Host failure reports retain setter input without a call-failed Trace record" {
    for ([_]bool{ false, true }) |set| {
        const s = Session.init(std.testing.allocator).?;
        defer s.deinit();
        var c = Client.init(s);
        defer c.deinit();
        _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"box\",\"props\":[{{\"name\":\"value\",\"shape\":\"number\"}}]}}", .{1}));
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{2}));
        _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"box\",\"id\":\"one\"}}", .{3}));
        const source = if (set) "on go o\n set the value of o to 7\nend go" else "on go o\n return the value of o\nend go";
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":{f}}}", .{ 4, std.json.fmt(source, .{}) }));
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\",\"args\":[{{\"$object\":[\"box\",\"one\"]}}]}}}}", .{5}));
        _ = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-14T12:00:00Z\"}}", .{6});
        const done = try okOf(try c.sendRef(6, "{{\"m\":\"prop-result\",\"ref\":6,\"hostError\":\"broken\"}}", .{}));
        var failures: usize = 0;
        for (done.object.get("reports").?.array.items) |r| {
            if (!std.mem.eql(u8, r.object.get("kind").?.string, "call failed")) continue;
            failures += 1;
            try std.testing.expectEqualStrings("s", r.object.get("script").?.string);
            try std.testing.expectEqualStrings("", r.object.get("call").?.string);
            try std.testing.expectEqualStrings("box", r.object.get("operation").?.object.get("capability").?.string);
        }
        try std.testing.expectEqual(@as(usize, 1), failures);
        var recorded = false;
        for (done.object.get("trace").?.array.items) |line| {
            try std.testing.expect(!std.mem.startsWith(u8, line.string, "call-failed"));
            if (std.mem.startsWith(u8, line.string, "prop ")) {
                recorded = true;
                if (set) try std.testing.expect(std.mem.indexOf(u8, line.string, "op=set value=7 error={}") != null);
            }
        }
        try std.testing.expect(recorded);
    }
}

test "incoming frames have no nesting cap and preserve the Session" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    for ([_]bool{ false, true }) |objects_only| {
        for ([_]usize{ 63, 64, 10_000, 100_000 }) |depth| {
            const nested = try nestedJson(gpa, depth, objects_only);
            defer gpa.free(nested);
            const reply = try c.common(1, "{{\"m\":\"hello\",\"ref\":1,\"protocol\":1,\"ignored\":{s}}}", .{nested});
            _ = try okOf(reply);
            const decoded = try okOf(try c.send("{{\"m\":\"add\",\"ref\":{d},\"a\":{s},\"b\":1}}", .{ 2, nested }));
            try std.testing.expectEqualStrings("wrong kind", decoded.object.get("fail").?.object.get("code").?.string);
            _ = try okOf(try c.send("{{\"m\":\"add\",\"ref\":{d},\"a\":20,\"b\":22}}", .{3}));
        }
    }
    // Brackets, escaped quotes and backslashes inside a string are text.
    const text = try nestedJson(gpa, 1000, false);
    defer gpa.free(text);
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"ignored\":\"{s}\\\"\\\\\"}}", .{ 4, text }));
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

/// A small real transport fixture for paused-input tests; refs 1..6 set up
/// and start the Pump, and callback inputs use their own refs.
fn pausedFixture(c: *Client, mode: []const u8, source: []const u8, metered: bool) !Json {
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{0}));
    try std.testing.expectEqualStrings("paused-inputs-v1", hello.object.get("features").?.array.items[0].string);
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"{s}\",\"result\":\"number\"{s}}}]}}", .{ 1, mode, if (metered) ",\"metering\":\"read-only\"" else "" }));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":{f}}}", .{ 4, grant.object.get("grant").?.integer, std.json.fmt(source, .{}) }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    return pumped.object.get("need") orelse unexpected(pumped);
}

test "paused callback inputs land after the callback record and before conversion" {
    for ([_][]const u8{ "\"result\":7", "\"result\":\"bad\"", "\"hostError\":\"broken\"", "\"fail\":{\"code\":\"bad\",\"data\":{}}" }) |answer| {
        const s = Session.init(std.testing.allocator).?;
        defer s.deinit();
        var c = Client.init(s);
        defer c.deinit();
        _ = try pausedFixture(&c, "immediate", "script variable n=0\non go\n put 9 into n\n ask api to read\n put 8 into n\n return n\nend go", false);
        const admitted = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"crossing\"}}", .{7}));
        try std.testing.expect(admitted.object.get("trace") == null);
        const done = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,{s}}}", .{answer}));
        try std.testing.expectEqualStrings("stopped", done.object.get("state").?.string);
        var called = false;
        var stopped = false;
        for (done.object.get("trace").?.array.items) |line| {
            if (std.mem.startsWith(u8, line.string, "call s/r1.c1")) called = true;
            if (std.mem.startsWith(u8, line.string, "> stop s")) {
                try std.testing.expect(called);
                stopped = true;
            }
            try std.testing.expect(!std.mem.startsWith(u8, line.string, "call-failed"));
        }
        try std.testing.expect(stopped);
        const inspected = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{8}));
        const vars = inspected.object.get("scripts").?.array.items[0].object.get("vars").?.array.items;
        try std.testing.expectEqual(@as(i64, 0), vars[0].array.items[1].integer);
    }
}

test "an Answer and metered charge during Start wait for the next Pump" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const need = try pausedFixture(&c, "suspending", "on go\n ask api to read and wait\n return it\nend go", true);
    const id = need.object.get("call").?.string;
    const charged = try okOf(try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":1}}", .{ 7, id }));
    try std.testing.expectEqualStrings("q1", charged.object.get("request").?.string);
    _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"value\":7}}", .{ 8, id }));
    const parked = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"started\":true}}", .{}));
    for (parked.object.get("reports").?.array.items) |r| try std.testing.expect(!std.mem.eql(u8, r.object.get("kind").?.string, "run end"));
    const done = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{9});
    const end = try runEnd(done);
    try std.testing.expectEqual(@as(i64, 7), end.object.get("result").?.integer);
    const reports = (try okOf(done)).object.get("reports").?.array.items;
    try std.testing.expectEqualStrings("charge result", reports[0].object.get("kind").?.string);
    try std.testing.expectEqualStrings("accepted", reports[0].object.get("status").?.string);
}

test "paused cancellation and Rewind retain rollback and accounting" {
    for ([_][]const u8{ "cancel-run", "rewind-run", "stop" }) |control| {
        for ([_][]const u8{ "immediate", "suspending" }) |mode| {
            const s = Session.init(std.testing.allocator).?;
            defer s.deinit();
            var c = Client.init(s);
            defer c.deinit();
            const suspending = std.mem.eql(u8, mode, "suspending");
            const source = if (suspending) "script variable n=0\non go\n put 9 into n\n ask api to read and wait\n put 8 into n\n return n\nend go" else "script variable n=0\non go\n put 9 into n\n ask api to read\n put 8 into n\n return n\nend go";
            _ = try pausedFixture(&c, mode, source, false);
            _ = try okOf(try c.sendRef(7, "{{\"m\":\"{s}\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"run\":\"s/r1\",\"reason\":\"crossing\"}}", .{ control, 7 }));
            const done = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,{s}}}", .{if (suspending) "\"started\":true" else "\"result\":7"}));
            const rewind = std.mem.eql(u8, control, "rewind-run");
            try std.testing.expectEqualStrings(if (rewind) "rewound" else if (std.mem.eql(u8, control, "stop")) "stopped" else "idle", done.object.get("state").?.string);
            const inspected = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{8}));
            const script = inspected.object.get("scripts").?.array.items[0];
            try std.testing.expectEqual(@as(i64, 0), script.object.get("vars").?.array.items[0].array.items[1].integer);
            if (rewind) try std.testing.expectEqual(@as(usize, 1), script.object.get("mailbox").?.array.items.len);
        }
    }
}

test "a different Run's deferred cleanup retains the original Host return until release" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"resource\",\"segmentLifecycle\":true,\"release\":true,\"ops\":[{{\"name\":\"open\",\"mode\":\"immediate\",\"result\":\"nothing\",\"segmentBound\":true,\"scope\":{{\"opens\":\"file\",\"abandon\":\"close\"}}}},{{\"name\":\"close\",\"mode\":\"immediate\",\"result\":\"nothing\",\"segmentBound\":true,\"scope\":{{\"closes\":\"file\"}}}}]}}", .{1}));
    const resource = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"resource\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"result\":\"number\"}}]}}", .{3}));
    const api = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{4}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"other\",\"grants\":{{\"r\":{d}}},\"source\":\"on hold\\n ask r to open\\n repeat forever\\n end repeat\\nend hold\"}}", .{ 6, resource }));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"script variable n=0\\non go\\n ask api to read\\n put 8 into n\\n return n\\nend go\"}}", .{ 7, api }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"other\"}},\"message\":{{\"name\":\"hold\"}}}}", .{8}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{9}));
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\",\"fuelSlice\":20}}", .{10});
    try std.testing.expectEqualStrings("begin", reply.object.get("need").?.object.get("phase").?.string);
    reply = try c.sendRef(10, "{{\"m\":\"effect-result\",\"ref\":10,\"status\":\"ok\"}}", .{});
    try std.testing.expectEqualStrings("open", reply.object.get("need").?.object.get("operation").?.string);
    reply = try c.sendRef(10, "{{\"m\":\"op-result\",\"ref\":10,\"result\":null}}", .{});
    try std.testing.expectEqualStrings("read", reply.object.get("need").?.object.get("operation").?.string);
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"other\",\"reason\":\"cleanup\"}}", .{11}));
    reply = try c.sendRef(10, "{{\"m\":\"op-result\",\"ref\":10,\"result\":7}}", .{});
    try std.testing.expectEqualStrings("close", reply.object.get("need").?.object.get("operation").?.string);
    reply = try c.sendRef(10, "{{\"m\":\"op-result\",\"ref\":10,\"result\":null}}", .{});
    try std.testing.expectEqualStrings("rollback", reply.object.get("need").?.object.get("phase").?.string);
    reply = try c.sendRef(10, "{{\"m\":\"effect-result\",\"ref\":10,\"status\":\"ok\"}}", .{});
    try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
    // A callback-generated Stop must be admitted before s executes its next instruction.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"release\"}}", .{12}));
    const done = try okOf(try c.sendRef(10, "{{\"m\":\"release-result\",\"ref\":10}}", .{}));
    var calls: usize = 0;
    for (done.object.get("trace").?.array.items) |line| if (std.mem.startsWith(u8, line.string, "call s/r1.c1")) {
        calls += 1;
    };
    try std.testing.expectEqual(@as(usize, 1), calls);
    const inspected = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{13}));
    const script = inspected.object.get("scripts").?.array.items[1];
    try std.testing.expectEqual(@as(i64, 0), script.object.get("vars").?.array.items[0].array.items[1].integer);
}

test "property callbacks admit Stop before valid or invalid return conversion" {
    for ([_]bool{ false, true }) |set| {
        for ([_][]const u8{ "\"value\":7", "\"value\":\"wrong\"", "\"hostError\":\"broken\"", "\"fail\":{\"code\":\"bad\",\"data\":17}", "\"fail\":{}" }) |outcome| {
            const s = Session.init(std.testing.allocator).?;
            defer s.deinit();
            var c = Client.init(s);
            defer c.deinit();
            _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"box\",\"props\":[{{\"name\":\"value\",\"shape\":\"number\"}}]}}", .{1}));
            _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{2}));
            _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"box\",\"id\":\"one\"}}", .{3}));
            const source = if (set) "script variable n=0\non go o\n put 9 into n\n set the value of o to 7\n put 8 into n\nend go" else "script variable n=0\non go o\n put 9 into n\n put the value of o into n\n put 8 into n\nend go";
            _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":{f}}}", .{ 4, std.json.fmt(source, .{}) }));
            _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\",\"args\":[{{\"$object\":[\"box\",\"one\"]}}]}}}}", .{5}));
            const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
            try std.testing.expectEqualStrings("prop", pumped.object.get("need").?.object.get("m").?.string);
            _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"box\",\"id\":\"two\"}}", .{7}));
            const refused = try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{8});
            try std.testing.expectEqualStrings("reentrant call", refused.object.get("err").?.object.get("code").?.string);
            _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"property\"}}", .{9}));
            const done = try okOf(try c.sendRef(6, "{{\"m\":\"prop-result\",\"ref\":6,{s}}}", .{outcome}));
            try std.testing.expectEqualStrings("stopped", done.object.get("state").?.string);
            const inspected = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{10}));
            try std.testing.expectEqual(@as(i64, 0), inspected.object.get("scripts").?.array.items[0].object.get("vars").?.array.items[0].array.items[1].integer);
        }
    }
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
    const nested = try nestedJson(gpa, 100_000, false);
    defer gpa.free(nested);
    const rejected = try c.common(0, "{{\"m\":\"op-result\",\"ref\":6,\"result\":{s}", .{nested});
    try std.testing.expectEqualStrings("protocol error", try errKind(rejected));
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

test "reload carries or resets variables, extend adds a handler, and a refused source is a load error" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"script variable n = 5\\non bump\\n  put n + 1 into n\\n  return n\\nend bump\\n\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"bump\"}}}}", .{3}));
    const first = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{4});
    try std.testing.expectEqual(@as(i64, 6), (try runEnd(first)).object.get("result").?.integer);
    // The Pump returns its ended Run's accounting row itself, not a later
    // reply after its reports are freed.
    var accounted = false;
    for ((try okOf(first)).object.get("reports").?.array.items) |r| {
        if (std.mem.eql(u8, "run accounting", r.object.get("kind").?.string)) {
            try std.testing.expectEqualStrings("s", r.object.get("script").?.string);
            accounted = true;
        }
    }
    if (!accounted) return unexpected(first);
    // Carried, n stays 6 under the new code; reset, it starts again at 5.
    const reloaded = try okOf(try c.send("{{\"m\":\"reload\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"carry\":\"carry variables\",\"source\":\"script variable n = 5\\non bump\\n  put n + 10 into n\\n  return n\\nend bump\\n\"}}", .{5}));
    if (reloaded.object.get("reports").? != .array) return unexpected(reloaded);
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"bump\"}}}}", .{6}));
    try std.testing.expectEqual(@as(i64, 16), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{7}))).object.get("result").?.integer);
    _ = try okOf(try c.send("{{\"m\":\"reload\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"carry\":\"reset variables\",\"keepMailbox\":true,\"source\":\"script variable n = 5\\non bump\\n  put n + 10 into n\\n  return n\\nend bump\\n\"}}", .{8}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"bump\"}}}}", .{9}));
    try std.testing.expectEqual(@as(i64, 15), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:02Z\"}}", .{10}))).object.get("result").?.integer);
    // An unknown carry and a source that doesn't compile are refused.
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"reload\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"carry\":\"keep\",\"source\":\"\"}}", .{11})));
    const broken = try c.send("{{\"m\":\"reload\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"carry\":\"reset variables\",\"source\":\"on bump\\n\"}}", .{12});
    try std.testing.expectEqualStrings("load error", try errKind(broken));
    if (broken.object.get("err").?.object.get("diagnostics").?.array.items.len == 0) return unexpected(broken);
    // Extend adds a handler beside the code it has.
    const extended = try okOf(try c.send("{{\"m\":\"extend\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"source\":\"on peek\\n  return n\\nend peek\\n\"}}", .{13}));
    if (extended.object.get("reports") != null) return unexpected(extended);
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"peek\"}}}}", .{14}));
    try std.testing.expectEqual(@as(i64, 15), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:03Z\"}}", .{15}))).object.get("result").?.integer);
}

test "compile-library gives identity and needs, add-library serves a load, and replace-library reloads its users" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const v1 = try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"util\",\"version\":\"1\",\"source\":\"function scale n\\n  return n * 2\\nend scale\\n\"}}", .{1}));
    try std.testing.expectEqual(@as(usize, 0), v1.object.get("needs").?.array.items.len);
    const id1 = v1.object.get("identity").?.object.get("$bytes").?.string;
    const v2 = try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"util\",\"version\":\"2\",\"source\":\"function scale n\\n  return n * 3\\nend scale\\n\"}}", .{2}));
    const id2 = v2.object.get("identity").?.object.get("$bytes").?.string;
    try std.testing.expect(!std.mem.eql(u8, id1, id2));
    // A declared Grant's Operation used by the Library is one of its needs.
    const asks = try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"asks\",\"version\":\"1\",\"declarations\":{{\"api\":{{\"double\":{{\"mode\":\"immediate\",\"args\":[\"number\"]}}}}}},\"source\":\"function twice n\\n  ask api to double n\\n  return it\\nend twice\\n\"}}", .{3}));
    const needs = asks.object.get("needs").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), needs.len);
    try std.testing.expectEqualStrings("double", needs[0].object.get("operation").?.string);
    const broken = try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"bad\",\"version\":\"1\",\"source\":\"function f\\n\"}}", .{4});
    try std.testing.expectEqualStrings("load error", try errKind(broken));
    try std.testing.expect(broken.object.get("err").?.object.get("diagnostics").?.array.items.len > 0);
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"x\",\"version\":\"1\",\"imports\":[{{\"$bytes\":\"AAAA\"}}],\"source\":\"\"}}", .{5})));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{6}));
    _ = try okOf(try c.send("{{\"m\":\"add-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}}}}", .{ 7, id1 }));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"use scale from util\\non go\\n  return scale(5)\\nend go\\n\"}}", .{8}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{9}));
    try std.testing.expectEqual(@as(i64, 10), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}))).object.get("result").?.integer);
    const replaced = try okOf(try c.send("{{\"m\":\"replace-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}},\"carry\":\"carry variables\"}}", .{ 11, id2 }));
    try std.testing.expect(replaced.object.get("reports").? == .array);
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{12}));
    try std.testing.expectEqual(@as(i64, 15), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{13}))).object.get("result").?.integer);
}

test "inspect shows variables, a suspended Run and the mailbox, and grants lists kept Operations" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"zap\",\"mode\":\"immediate\",\"result\":\"nothing\"}},{{\"name\":\"add\",\"mode\":\"immediate\",\"result\":\"nothing\"}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"script variable n = 7\\non nap x, queued\\n  wait 2 s\\nend nap\\n\"}}", .{ 4, grant.object.get("grant").?.integer }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"nap\",\"args\":[1]}}}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"nap\",\"args\":[2]}}}}", .{6}));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{7}));
    const seen = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{8}));
    const scripts = seen.object.get("scripts").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), scripts.len);
    const view = scripts[0];
    try std.testing.expectEqualStrings("s", view.object.get("name").?.string);
    try std.testing.expect(view.object.get("disabledGrants") == null);
    const vars = view.object.get("vars").?.array.items;
    try std.testing.expectEqualStrings("n", vars[0].array.items[0].string);
    try std.testing.expectEqual(@as(i64, 7), vars[0].array.items[1].integer);
    // The second `queued` message's Run starts and parks behind the first.
    const runs = view.object.get("runs").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), runs.len);
    try std.testing.expectEqualStrings("suspended", runs[0].object.get("status").?.string);
    try std.testing.expectEqualStrings("nap", runs[0].object.get("handler").?.string);
    try std.testing.expectEqualStrings("2026-10-10T12:00:02Z", runs[0].object.get("until").?.string);
    try std.testing.expectEqualStrings("parked", runs[1].object.get("status").?.string);
    try std.testing.expect(runs[1].object.get("until") == null);
    try std.testing.expectEqual(@as(usize, 0), view.object.get("mailbox").?.array.items.len);
    // Behind a Run a Fuel Slice preempted, a message waits in the mailbox.
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"t\",\"source\":\"on spin\\n  repeat 100 times\\n  end repeat\\nend spin\\non ping x\\nend ping\\n\"}}", .{11}));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"t\"}},\"message\":{{\"name\":\"spin\"}}}}", .{12}));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"t\"}},\"message\":{{\"name\":\"ping\",\"args\":[\"hi\"]}}}}", .{13}));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\",\"fuelSlice\":5}}", .{14}));
    const later = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{15}));
    const t = later.object.get("scripts").?.array.items[1];
    try std.testing.expectEqualStrings("preempted", t.object.get("runs").?.array.items[0].object.get("status").?.string);
    const mailbox = t.object.get("mailbox").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), mailbox.len);
    try std.testing.expectEqualStrings("d4", mailbox[0].object.get("delivery").?.string);
    try std.testing.expect(mailbox[0].object.get("from") == null);
    try std.testing.expectEqualStrings("ping", mailbox[0].object.get("message").?.object.get("name").?.string);
    try std.testing.expectEqualStrings("hi", mailbox[0].object.get("message").?.object.get("args").?.array.items[0].string);
    const grants = try okOf(try c.send("{{\"m\":\"grants\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{9}));
    const ops = grants.object.get("api").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), ops.len);
    try std.testing.expectEqualStrings("add", ops[0].string);
    try std.testing.expectEqualStrings("zap", ops[1].string);
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"grants\",\"ref\":{d},\"group\":\"g\",\"script\":\"nobody\"}}", .{16})));
}

test "restore asks the Host to resolve Grants and objects, then settle answers a pending call" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"args\":[\"number\"],\"result\":\"number\",\"maxPending\":5000}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"room\",\"props\":[]}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"room\",\"id\":\"hall\"}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"owner\":{{\"$object\":[\"room\",\"hall\"]}},\"grants\":{{\"api\":{d}}},\"source\":\"on fetch\\n  ask api to fetch 9 and wait\\n  return it\\nend fetch\\n\"}}", .{ 6, grant }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"fetch\"}}}}", .{7}));
    _ = (try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8})).object.get("need").?;
    _ = try okOf(try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":{d},\"started\":true}}", .{8}));
    const save = (try okOf(try c.send("{{\"m\":\"save\",\"ref\":{d},\"group\":\"g\"}}", .{9}))).object.get("save").?.object.get("$bytes").?.string;

    // The Core asks for the Script's Grant and its owner.
    const asked = try c.send("{{\"m\":\"restore\",\"ref\":{d},\"group\":\"g2\",\"name\":\"g\",\"save\":{{\"$bytes\":\"{s}\"}}}}", .{ 10, save });
    const need = asked.object.get("need") orelse return unexpected(asked);
    try std.testing.expectEqualStrings("resolve", need.object.get("m").?.string);
    const grants = need.object.get("grants").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), grants.len);
    try std.testing.expectEqualStrings("s", grants[0].array.items[0].string);
    try std.testing.expectEqualStrings("api", grants[0].array.items[1].string);
    const objs = need.object.get("objects").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), objs.len);
    try std.testing.expectEqualStrings("hall", objs[0].array.items[1].string);
    // Nothing else is read until the Host answers.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{11})));
    const restored = try okOf(try c.sendRef(10, "{{\"m\":\"resolve-result\",\"ref\":{d},\"grants\":[{d}],\"objects\":[true]}}", .{ 10, grant }));
    try std.testing.expect(restored.object.get("variablesOnly").?.bool == false);
    try std.testing.expectEqual(@as(usize, 0), restored.object.get("disposed").?.array.items.len);
    const pending = restored.object.get("pending").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), pending.len);
    try std.testing.expectEqualStrings("s", pending[0].object.get("script").?.string);
    try std.testing.expectEqualStrings("api", pending[0].object.get("grant").?.string);
    try std.testing.expectEqualStrings("fetch", pending[0].object.get("operation").?.string);
    try std.testing.expectEqual(@as(i64, 9), pending[0].object.get("args").?.array.items[0].integer);
    const call = pending[0].object.get("call").?.string;
    _ = try okOf(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"g2\",\"call\":\"{s}\",\"settlement\":{{\"answer\":42}}}}", .{ 12, call }));
    // Settled once only.
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"g2\",\"call\":\"{s}\",\"settlement\":{{\"answer\":1}}}}", .{ 13, call })));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g2\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{14}));
    try std.testing.expectEqual(@as(i64, 42), end.object.get("result").?.integer);

    // An object the Host doesn't resolve restores disposed; a failed
    // settlement ends the Run with its error.
    _ = (try c.send("{{\"m\":\"restore\",\"ref\":{d},\"group\":\"g3\",\"name\":\"g\",\"save\":{{\"$bytes\":\"{s}\"}}}}", .{ 15, save })).object.get("need").?;
    const lost = try okOf(try c.sendRef(15, "{{\"m\":\"resolve-result\",\"ref\":{d},\"grants\":[{d}],\"objects\":[false]}}", .{ 15, grant }));
    const disposed = lost.object.get("disposed").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), disposed.len);
    try std.testing.expectEqualStrings("room", disposed[0].array.items[0].string);
    const call3 = lost.object.get("pending").?.array.items[0].object.get("call").?.string;
    _ = try okOf(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"g3\",\"call\":\"{s}\",\"settlement\":{{\"fail\":{{\"code\":\"nope\",\"message\":\"no\"}}}}}}", .{ 16, call3 }));
    const failed = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g3\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{17}));
    try std.testing.expectEqualStrings("errored", failed.object.get("outcome").?.string);
    try std.testing.expectEqualStrings("nope", failed.object.get("error").?.object.get("code").?.string);

    // A Group with nothing to resolve restores at once, its Variables kept.
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"plain\",\"name\":\"plain\"}}", .{19}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"plain\",\"name\":\"p\",\"source\":\"script variable n = 3\\non peek\\n  return n\\nend peek\\n\"}}", .{20}));
    const plain = (try okOf(try c.send("{{\"m\":\"save\",\"ref\":{d},\"group\":\"plain\"}}", .{21}))).object.get("save").?.object.get("$bytes").?.string;
    const direct = try okOf(try c.send("{{\"m\":\"restore\",\"ref\":{d},\"group\":\"plain2\",\"name\":\"plain\",\"save\":{{\"$bytes\":\"{s}\"}}}}", .{ 22, plain }));
    try std.testing.expectEqual(@as(usize, 0), direct.object.get("pending").?.array.items.len);
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"plain2\",\"to\":{{\"script\":\"p\"}},\"message\":{{\"name\":\"peek\"}}}}", .{23}));
    try std.testing.expectEqual(@as(i64, 3), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"plain2\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{24}))).object.get("result").?.integer);

    // A save the Core can't read is refused, with no need.
    const bad = try c.send("{{\"m\":\"restore\",\"ref\":{d},\"group\":\"g4\",\"save\":{{\"$bytes\":\"AAAA\"}}}}", .{18});
    try std.testing.expectEqualStrings("invalid save", bad.object.get("err").?.object.get("code").?.string);
}

test "Function Values cross as $function tokens, are called with call, and stay in their Group" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on make n\\n  return given x: x + n\\nend make\\n\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"make\",\"args\":[5]}}}}", .{3}));
    const made = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{4}));
    const tag = made.object.get("result").?.object.get("$function") orelse return unexpected(made);
    const parts = tag.array.items;
    try std.testing.expectEqualStrings("s", parts[0].string);
    try std.testing.expect(parts[2].string.len > 0);
    var fn_json: std.Io.Writer.Allocating = .init(gpa);
    defer fn_json.deinit();
    try fn_json.writer.print("{f}", .{std.json.fmt(made.object.get("result").?, .{})});
    // Called, it runs in its Home Script with its capture.
    _ = try okOf(try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{s},\"args\":[3]}}", .{ 5, fn_json.written() }));
    const called = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{6}));
    try std.testing.expectEqualStrings("completed", called.object.get("outcome").?.string);
    try std.testing.expectEqual(@as(i64, 8), called.object.get("result").?.integer);
    // Inside a message's arguments it crosses back as the same value.
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"t\",\"source\":\"on use f\\n  f(10) and wait\\n  return it\\nend use\\n\"}}", .{7}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"t\"}},\"message\":{{\"name\":\"use\",\"args\":[{s}]}}}}", .{ 8, fn_json.written() }));
    const used = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:02Z\"}}", .{9}));
    try std.testing.expectEqual(@as(i64, 15), used.object.get("result").?.integer);
    // Another Group refuses it, and a token this layer didn't write is invalid.
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"h\",\"name\":\"h\"}}", .{10}));
    const other = try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"h\",\"fn\":{s}}}", .{ 11, fn_json.written() });
    try std.testing.expectEqualStrings("wrong group", other.object.get("err").?.object.get("code").?.string);
    const forged = try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{{\"$function\":[\"s\",\"x\",\"bm9wZQ==\"]}}}}", .{12});
    try std.testing.expectEqualStrings("invalid value", forged.object.get("err").?.object.get("code").?.string);
}

test "export-manifest writes the Host Manifest's bytes, the same each time" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"double\",\"mode\":\"immediate\",\"args\":[\"number\"],\"result\":\"number\",\"description\":\"Doubles.\"}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"room\",\"props\":[]}}", .{3}));
    const lib = (try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"util\",\"version\":\"1\",\"source\":\"function one\\n  return 1\\nend one\\n\"}}", .{4}))).object.get("identity").?.object.get("$bytes").?.string;
    const frame = "{{\"m\":\"export-manifest\",\"ref\":{d},\"kind\":\"door\",\"version\":\"2\",\"grants\":{{\"api\":{d}}},\"libraries\":[{{\"$bytes\":\"{s}\"}}],\"messages\":[{{\"name\":\"open\",\"args\":[\"text\"],\"receivers\":[\"room\"]}}],\"objectKinds\":[\"room\"],\"objects\":{{\"here\":\"room\"}}}}";
    const first = (try okOf(try c.send(frame, .{ 5, grant, lib }))).object.get("manifest").?.object.get("$bytes").?.string;
    const second = (try okOf(try c.send(frame, .{ 6, grant, lib }))).object.get("manifest").?.object.get("$bytes").?.string;
    try std.testing.expectEqualStrings(first, second);
    const codec = std.base64.standard.Decoder;
    const raw = try gpa.alloc(u8, try codec.calcSizeForSlice(first));
    defer gpa.free(raw);
    try codec.decode(raw, first);
    const manifest = try std.json.parseFromSlice(Json, gpa, raw, .{});
    defer manifest.deinit();
    const m = manifest.value.object;
    try std.testing.expectEqualStrings("door", m.get("kind").?.string);
    try std.testing.expectEqualStrings("2", m.get("version").?.string);
    try std.testing.expectEqualStrings("api", m.get("grants").?.array.items[0].object.get("name").?.string);
    try std.testing.expectEqualStrings("util", m.get("libraries").?.array.items[0].object.get("name").?.string);
    try std.testing.expectEqualStrings("open", m.get("messages").?.array.items[0].object.get("name").?.string);
    try std.testing.expectEqualStrings("room", m.get("objectKinds").?.array.items[0].object.get("name").?.string);
    try std.testing.expectEqualStrings("here", m.get("objects").?.array.items[0].object.get("name").?.string);
    try std.testing.expect(std.mem.indexOf(u8, raw, "Doubles.") != null);
    const unknown = try c.send("{{\"m\":\"export-manifest\",\"ref\":{d},\"kind\":\"door\",\"version\":\"2\",\"objectKinds\":[\"nowhere\"]}}", .{7});
    try std.testing.expectEqualStrings("host error", try errKind(unknown));
}

test "standard-capability: the Core answers clock, and console reaches the Host as op needs" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // Every Operation needs its cost.
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"standard-capability\",\"ref\":{d},\"name\":\"console\",\"costs\":{{\"write\":{{\"fuel\":1}}}}}}", .{1})));
    _ = try okOf(try c.send("{{\"m\":\"standard-capability\",\"ref\":{d},\"name\":\"clock\",\"costs\":{{\"now\":{{\"fuel\":1}}}}}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"standard-capability\",\"ref\":{d},\"name\":\"console\",\"costs\":{{\"write\":{{\"fuel\":2}},\"read\":{{\"fuel\":2}}}}}}", .{3}));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"standard-capability\",\"ref\":{d},\"name\":\"sqlite\",\"costs\":{{}}}}", .{4})));
    const clock = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"clock\",\"ops\":\"all\"}}", .{5}))).object.get("grant").?.integer;
    const console = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"console\",\"ops\":\"all\"}}", .{6}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{7}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"clock\":{d},\"console\":{d}}},\"source\":\"on go\\n  say \\\"hi\\\"\\n  ask clock to now\\n  return it\\nend go\\n\"}}", .{ 8, clock, console }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{9}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10});
    const need = pumped.object.get("need") orelse return unexpected(pumped);
    try std.testing.expectEqualStrings("console", need.object.get("capability").?.string);
    try std.testing.expectEqualStrings("write", need.object.get("operation").?.string);
    try std.testing.expectEqualStrings("hi", need.object.get("args").?.array.items[0].string);
    const mode = need.object.get("mode").?.string;
    const answer = if (std.mem.eql(u8, mode, "fire-and-forget")) "\"done\":true" else "\"result\":null";
    const done = try c.sendRef(10, "{{\"m\":\"op-result\",\"ref\":{d},{s}}}", .{ 10, answer });
    const end = try runEnd(done);
    try std.testing.expectEqualStrings("completed", end.object.get("outcome").?.string);
    try std.testing.expectEqualStrings("2026-10-10T12:00:00Z", end.object.get("result").?.object.get("$instant").?.string);
}

test "Segment lifecycle and scope abandonment reach the Host as effect and op needs, and a Stop's releases go first" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // `capabilities/effect-completion`'s resource, with its release hook.
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"resource\",\"segmentLifecycle\":true,\"release\":true,\"ops\":[" ++
        "{{\"name\":\"open\",\"mode\":\"immediate\",\"result\":\"nothing\",\"cost\":{{\"fuel\":1}},\"scope\":{{\"opens\":\"file\",\"abandon\":\"close\"}},\"segmentBound\":true}}," ++
        "{{\"name\":\"close\",\"mode\":\"immediate\",\"result\":\"nothing\",\"cost\":{{\"fuel\":1}},\"scope\":{{\"closes\":\"file\"}},\"segmentBound\":true}}," ++
        "{{\"name\":\"write\",\"mode\":\"immediate\",\"result\":\"nothing\",\"cost\":{{\"fuel\":1}},\"segmentBound\":true}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"resource\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"r\":{d}}},\"source\":\"script variable count = 0\\non go\\nask r to open\\nask r to write\\nput 2 into count\\nend go\\n\"}}", .{ 4, grant }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
    // begin, open, write, the automatic close, then commit.
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-02T00:00:00Z\"}}", .{6});
    var need = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("effect", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("begin", need.object.get("phase").?.string);
    try std.testing.expectEqualStrings("r", need.object.get("grants").?.array.items[0].string);
    // An effect need takes only an effect-result.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{6})));
    reply = try c.sendRef(6, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}", .{6});
    for ([_][]const u8{ "open", "write", "close" }) |op| {
        need = reply.object.get("need") orelse return unexpected(reply);
        try std.testing.expectEqualStrings("op", need.object.get("m").?.string);
        try std.testing.expectEqualStrings(op, need.object.get("operation").?.string);
        try std.testing.expectEqual(std.mem.eql(u8, op, "close"), need.object.get("automatic").?.bool);
        reply = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{6});
    }
    need = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("commit", need.object.get("phase").?.string);
    const done = try okOf(try c.sendRef(6, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}", .{6}));
    // The Trace is the corpus case's, byte for byte.
    const expected = [_][]const u8{
        "effect s/r1.s1 grant=r phase=begin status=ok",
        "call s/r1.c1 op=r.open args=[] result=nothing",
        "scope s/r1.c1 grant=r name=file action=opened",
        "call s/r1.c2 op=r.write args=[] result=nothing",
        "call s/r1.c3 op=r.close args=[] result=nothing automatic=yes",
        "scope s/r1.c3 grant=r name=file action=abandoned",
        "effect s/r1.s1 grant=r phase=commit status=ok",
        "seg s/r1 start delivery=d1 handler=go clause=1 fuel=36 alloc=16 state=16 end=return",
        "run s/r1 outcome=completed delivery=d1 handler=go fuel=36 alloc=16",
        "pumped state=idle fuel=36",
    };
    var seen: std.ArrayList([]const u8) = .empty;
    defer seen.deinit(gpa);
    for (done.object.get("trace").?.array.items) |line| if (!std.mem.startsWith(u8, line.string, ">")) try seen.append(gpa, line.string);
    try std.testing.expectEqual(expected.len, seen.items.len);
    for (expected, seen.items) |want, got| try std.testing.expectEqualStrings(want, got);
    // A Stop releases the Grant before the Pump's reply.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}}", .{7}));
    reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-02T00:00:01Z\"}}", .{8});
    need = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("release", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("r", need.object.get("grant").?.string);
    try std.testing.expectEqualStrings("stop", need.object.get("reason").?.string);
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{9})));
    const stopped = try okOf(try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":{d}}}", .{8}));
    var stop_seen = false;
    for (stopped.object.get("reports").?.array.items) |r| {
        if (std.mem.eql(u8, "stop", r.object.get("kind").?.string)) stop_seen = true;
    }
    try std.testing.expect(stop_seen);
}

test "a reload's lifecycle crossings reach the Host as needs before its reply" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // `capabilities/effect-reload-carry`'s resource and Script.
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"resource\",\"segmentLifecycle\":true,\"ops\":[" ++
        "{{\"name\":\"open\",\"mode\":\"immediate\",\"result\":\"nothing\",\"cost\":{{\"fuel\":1}},\"scope\":{{\"opens\":\"file\",\"abandon\":\"close\"}},\"segmentBound\":true}}," ++
        "{{\"name\":\"close\",\"mode\":\"immediate\",\"result\":\"nothing\",\"cost\":{{\"fuel\":1}},\"scope\":{{\"closes\":\"file\"}},\"segmentBound\":true}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"resource\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"r\":{d}}},\"source\":\"script variable count = 0\\non go\\nask r to open\\nput 2 into count\\nrepeat forever\\nend repeat\\nend go\\n\"}}", .{ 4, grant }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
    // The Run opens its scope and is preempted mid-Segment.
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-02T00:00:00Z\",\"fuelSlice\":40}}", .{6});
    reply = try c.sendRef(6, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}", .{6});
    const sliced = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{6}));
    try std.testing.expectEqualStrings("sliced", sliced.object.get("state").?.string);
    // Reloading it abandons the scope and rolls the Segment back first.
    reply = try c.send("{{\"m\":\"reload\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"carry\":\"carry variables\",\"source\":\"script variable count = 0\\non go\\nreturn count\\nend go\"}}", .{7});
    var need = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("close", need.object.get("operation").?.string);
    try std.testing.expect(need.object.get("automatic").?.bool);
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{8})));
    reply = try c.sendRef(7, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{7});
    need = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("effect", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("rollback", need.object.get("phase").?.string);
    const reloaded = try okOf(try c.sendRef(7, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}", .{7}));
    try std.testing.expect(reloaded.object.get("reports").? == .array);
    // The Trace is the corpus case's from the abandonment to the stop.
    const expected = [_][]const u8{
        "call s/r1.c2 op=r.close args=[] result=nothing automatic=yes",
        "scope s/r1.c2 grant=r name=file action=abandoned",
        "effect s/r1.s1 grant=r phase=rollback status=ok",
        "stopped s reason=\"reload\" discarded=[s/r1]",
    };
    var seen: std.ArrayList([]const u8) = .empty;
    defer seen.deinit(gpa);
    for (reloaded.object.get("trace").?.array.items) |line| if (!std.mem.startsWith(u8, line.string, ">")) try seen.append(gpa, line.string);
    try std.testing.expectEqual(expected.len, seen.items.len);
    for (expected, seen.items) |want, got| try std.testing.expectEqualStrings(want, got);
    // The new code runs, its Variable carried.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{9}));
    try std.testing.expectEqual(@as(i64, 0), (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-02T00:00:00Z\"}}", .{10}))).object.get("result").?.integer);
}

test "fatal Library replacement waits for release and returns effect state unknown" {
    for ([_][]const u8{ "failed", "unknown" }) |status| {
        const s = Session.init(std.testing.allocator).?;
        defer s.deinit();
        var c = Client.init(s);
        defer c.deinit();
        _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"resource\",\"segmentLifecycle\":true,\"release\":true,\"ops\":[{{\"name\":\"write\",\"mode\":\"immediate\",\"result\":\"nothing\",\"segmentBound\":true}}]}}", .{1}));
        const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"resource\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
        const old = (try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"user\",\"source\":\"function one\\nreturn 1\\nend one\\n\"}}", .{3}))).object.get("identity").?.object.get("$bytes").?.string;
        const fresh = (try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"user\",\"source\":\"function one\\nreturn 2\\nend one\\n\"}}", .{4}))).object.get("identity").?.object.get("$bytes").?.string;
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{5}));
        _ = try okOf(try c.send("{{\"m\":\"add-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}}}}", .{ 6, old }));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"r\":{d}}},\"source\":\"use one from user\\non go\\nask r to write\\nrepeat forever\\nend repeat\\nend go\\n\"}}", .{ 7, grant }));
        _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{8}));
        var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-02T00:00:00Z\",\"fuelSlice\":40}}", .{9});
        try std.testing.expectEqualStrings("begin", reply.object.get("need").?.object.get("phase").?.string);
        reply = try c.sendRef(9, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}", .{9});
        try std.testing.expectEqualStrings("write", reply.object.get("need").?.object.get("operation").?.string);
        _ = try okOf(try c.sendRef(9, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{9}));
        reply = try c.send("{{\"m\":\"replace-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}},\"carry\":\"carry variables\"}}", .{ 10, fresh });
        try std.testing.expectEqualStrings("rollback", reply.object.get("need").?.object.get("phase").?.string);
        reply = try c.sendRef(10, "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"{s}\"}}", .{ 10, status });
        try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
        const failed = try c.sendRef(10, "{{\"m\":\"release-result\",\"ref\":{d}}}", .{10});
        try std.testing.expectEqualStrings("host error", try errKind(failed));
        try std.testing.expectEqualStrings("effect state unknown", failed.object.get("err").?.object.get("code").?.string);
        // The Group keeps its original Library; replacement did not succeed.
        try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"next\",\"source\":\"on go\\nend go\\n\"}}", .{11})));
    }
}

test "store reaches the Host as op and effect needs, its Trace the corpus case's" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // `capabilities/standard-store`, answered as its stubs are.
    const source = try std.Io.Dir.cwd().readFileAlloc(io, "../../corpus/capabilities/standard-store/s.talk", gpa, .unlimited);
    defer gpa.free(source);
    var source_json: std.Io.Writer.Allocating = .init(gpa);
    defer source_json.deinit();
    try std.json.Stringify.value(source, .{}, &source_json.writer);
    _ = try okOf(try c.send("{{\"m\":\"standard-capability\",\"ref\":{d},\"name\":\"store\",\"costs\":{{\"watch\":{{\"fuel\":4}},\"unwatch\":{{\"fuel\":2}},\"get\":{{\"fuel\":2}},\"keys\":{{\"fuel\":2}},\"set\":{{\"fuel\":4}},\"delete\":{{\"fuel\":4}},\"increment\":{{\"fuel\":4}},\"swap\":{{\"fuel\":4,\"alloc\":3}}}}}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"store\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"st\":{d}}},\"source\":{s}}}", .{ 4, grant, source_json.written() }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"save\",\"args\":[\"ann\",9]}}}}", .{5}));
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-07T12:00:00Z\"}}", .{6});
    const answers = [_]struct { need: []const u8, answer: []const u8 }{
        .{ .need = "get", .answer = "{{\"m\":\"op-result\",\"ref\":{d},\"result\":7}}" },
        .{ .need = "begin", .answer = "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}" },
        .{ .need = "set", .answer = "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}" },
        .{ .need = "increment", .answer = "{{\"m\":\"op-result\",\"ref\":{d},\"result\":1}}" },
        .{ .need = "increment", .answer = "{{\"m\":\"op-result\",\"ref\":{d},\"result\":{{\"$quantity\":[\"2.5\",\"km\"]}}}}" },
        .{ .need = "swap", .answer = "{{\"m\":\"op-result\",\"ref\":{d},\"result\":true}}" },
        .{ .need = "commit", .answer = "{{\"m\":\"effect-result\",\"ref\":{d},\"status\":\"ok\"}}" },
    };
    inline for (answers) |step| {
        const need = reply.object.get("need") orelse return unexpected(reply);
        const named = need.object.get("operation") orelse need.object.get("phase").?;
        try std.testing.expectEqualStrings(step.need, named.string);
        reply = try c.sendRef(6, step.answer, .{6});
    }
    const done = try okOf(reply);
    const expected = [_][]const u8{
        "call s/r1.c1 op=st.get args=[\"best\", 0] result=7",
        "effect s/r1.s1 grant=st phase=begin status=ok",
        "call s/r1.c2 op=st.set args=[\"best\", 9] result=nothing",
        "call s/r1.c3 op=st.increment args=[\"plays\"] result=1",
        "call s/r1.c4 op=st.increment args=[\"distance\", 2.5 km] result=2.5 km",
        "call s/r1.c5 op=st.swap args=[\"first\", nothing, \"ann\"] result=true",
        "effect s/r1.s1 grant=st phase=commit status=ok",
        "seg s/r1 start delivery=d1 handler=save clause=1 fuel=103 alloc=75 state=8 end=return",
        "run s/r1 outcome=completed delivery=d1 handler=save fuel=103 alloc=75",
        "pumped state=idle fuel=103",
    };
    var seen: std.ArrayList([]const u8) = .empty;
    defer seen.deinit(gpa);
    for (done.object.get("trace").?.array.items) |line| if (!std.mem.startsWith(u8, line.string, ">")) try seen.append(gpa, line.string);
    try std.testing.expectEqual(expected.len, seen.items.len);
    for (expected, seen.items) |want, got| try std.testing.expectEqualStrings(want, got);
    // Its release hook reaches the Host as a stop releases the Grant.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}}", .{7}));
    reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-07T12:00:01Z\"}}", .{8});
    const release = reply.object.get("need") orelse return unexpected(reply);
    try std.testing.expectEqualStrings("release", release.object.get("m").?.string);
    try std.testing.expectEqualStrings("st", release.object.get("grant").?.string);
    _ = try okOf(try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":{d}}}", .{8}));
}

test "a started call the Core abandons is listed once in abandoned; an answered one never" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"result\":\"number\",\"maxPending\":1000}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on fetch\\n  ask api to fetch and wait\\n  return it\\nend fetch\\n\"}}", .{ 4, grant }));
    // Two calls, both started.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"fetch\"}}}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"fetch\"}}}}", .{6}));
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{7});
    var calls: [2][]const u8 = undefined;
    for (&calls) |*id| {
        const need = reply.object.get("need") orelse return unexpected(reply);
        id.* = need.object.get("call").?.string;
        reply = try c.sendRef(7, "{{\"m\":\"op-result\",\"ref\":{d},\"started\":true}}", .{7});
    }
    try std.testing.expectEqual(@as(usize, 0), (try okOf(reply)).object.get("abandoned").?.array.items.len);
    // The second is answered; the first outlives its maxPending.
    _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"value\":1}}", .{ 8, calls[1] }));
    const timed_out = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:02Z\"}}", .{9}));
    const abandoned = timed_out.object.get("abandoned").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), abandoned.len);
    try std.testing.expectEqualStrings(calls[0], abandoned[0].string);
    // Listed once.
    const after = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:03Z\"}}", .{10}));
    try std.testing.expectEqual(@as(usize, 0), after.object.get("abandoned").?.array.items.len);
}

fn startMetered(c: *Client, immediate: bool) ![]const u8 {
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"{s}\",\"metering\":\"read-only\",\"result\":\"number\",\"maxPending\":5000}}]}}", .{ 1, if (immediate) "immediate" else "suspending" }));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"limits\":{{\"fuelPerRun\":1000}},\"source\":\"on fetch\\n  ask api to fetch{s}\\n  return it\\nend fetch\\n\"}}", .{ 4, grant.object.get("grant").?.integer, if (immediate) "" else " and wait" }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"fetch\"}}}}", .{5}));
    const reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    const call = reply.object.get("need").?.object.get("call").?.string;
    if (!immediate) _ = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"started\":true}}", .{6}));
    return call;
}
fn chargeReport(reply: Json) !Json {
    const ok = try okOf(reply);
    for (ok.object.get("reports").?.array.items) |r| if (std.mem.eql(u8, "charge result", r.object.get("kind").?.string)) return r;
    return unexpected(reply);
}

test "request-charge enqueues only; validates amounts and overlap; reports accepted, limit, inactive" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const call = try startMetered(&c, false);
    const saved = try c.send("{{\"m\":\"save\",\"ref\":{d},\"group\":\"g\"}}", .{7});
    try std.testing.expectEqualStrings("effects pending", saved.object.get("err").?.object.get("code").?.string);
    for ([_][]const u8{ "-1", "1.5", "9007199254740992", "null", "\"invalid\"" }) |fuel| {
        const invalid = try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":{s}}}", .{ 8, call, fuel });
        try std.testing.expectEqualStrings("invalid value", invalid.object.get("err").?.object.get("code").?.string);
    }
    const enqueue = try okOf(try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":19}}", .{ 9, call }));
    try std.testing.expectEqualStrings("q1", enqueue.object.get("request").?.string);
    const overlap = try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":0}}", .{ 10, call });
    try std.testing.expectEqualStrings("invalid value", overlap.object.get("err").?.object.get("code").?.string);
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{11});
    const accepted = try chargeReport(pumped);
    try std.testing.expectEqualStrings("accepted", accepted.object.get("status").?.string);
    try std.testing.expectEqual(@as(i64, 19), accepted.object.get("fuel").?.integer);
    try std.testing.expectEqual(@as(i64, 19), (try okOf(pumped)).object.get("fuelUsed").?.integer);
    _ = try okOf(try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":1000}}", .{ 12, call }));
    const refused = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{13});
    try std.testing.expectEqualStrings("limit", (try chargeReport(refused)).object.get("status").?.string);
    try std.testing.expectEqualStrings("limit fault", (try runEnd(refused)).object.get("outcome").?.string);
    try std.testing.expectEqual(@as(usize, 1), (try okOf(refused)).object.get("abandoned").?.array.items.len);
    for ((try okOf(refused)).object.get("trace").?.array.items) |line| try std.testing.expect(!std.mem.startsWith(u8, line.string, "seg "));
    _ = try okOf(try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"fuel\":3}}", .{ 14, call }));
    const inactive = try chargeReport(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{15}));
    try std.testing.expectEqualStrings("inactive", inactive.object.get("status").?.string);
    const unknown = try c.send("{{\"m\":\"request-charge\",\"ref\":{d},\"group\":\"g\",\"call\":\"never.c1\",\"fuel\":3}}", .{16});
    try std.testing.expectEqualStrings("unknown call", unknown.object.get("err").?.object.get("code").?.string);
    _ = try okOf(try c.send("{{\"m\":\"save\",\"ref\":{d},\"group\":\"g\"}}", .{17}));
}

test "op-result limit overrides a supplied result and retains its charged prefix" {
    for ([_]i64{ 0, 23 }) |prefix| {
        const s = Session.init(std.testing.allocator).?;
        defer s.deinit();
        var c = Client.init(s);
        defer c.deinit();
        _ = try startMetered(&c, true);
        const reply = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":{d},\"limit\":true,\"charged\":{d},\"result\":42}}", .{ 6, prefix });
        const end = try runEnd(reply);
        try std.testing.expectEqualStrings("limit fault", end.object.get("outcome").?.string);
        var refused_seen = false;
        for ((try okOf(reply)).object.get("trace").?.array.items) |line| if (std.mem.startsWith(u8, line.string, "call ")) {
            try std.testing.expect(std.mem.indexOf(u8, line.string, "charge-refused=yes") != null);
            try std.testing.expect(std.mem.indexOf(u8, line.string, "result=") == null);
            refused_seen = true;
        };
        try std.testing.expect(refused_seen);
    }
}

const crossing_test = @import("machine/crossing_test.zig");

/// Compare native callback controls with wire inputs admitted while actual
/// Message Layer Operation and property needs are outstanding.
const CrossingScenario = enum { ordinary, cleanup, other_run };

fn crossingParity(crossing: crossing_test.Crossing, control: crossing_test.Control, result: crossing_test.Return, transported: bool, scenario: CrossingScenario) ![]u8 {
    const cleanup = scenario == .cleanup;
    const other_run = scenario == .other_run;
    const t = std.testing;
    const a = t.allocator;
    const s = Session.init(a).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"{s}\",\"result\":\"number\",\"cost\":{{\"fuel\":7}}}}]}}", .{ 1, if (crossing == .suspending) @as([]const u8, "suspending") else "immediate" }));
    const granted = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"thing\",\"props\":[{{\"name\":\"size\",\"shape\":\"number\",\"getCost\":{{\"fuel\":7}},\"setCost\":{{\"fuel\":7}}}}]}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"trace\":true}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"thing\",\"id\":\"o\"}}", .{5}));
    const src = try std.json.Stringify.valueAlloc(a, if (cleanup) crossing_test.cleanupSource(crossing) else crossing_test.source(crossing), .{});
    defer a.free(src);
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":{s}}}", .{ 6, granted.object.get("grant").?.integer, src }));
    const entry = s.groups.items[0];
    const g = &entry.group.group;
    if (other_run) {
        _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"work\",\"segmentLifecycle\":true,\"ops\":[{{\"name\":\"touch\",\"mode\":\"immediate\",\"result\":\"number\",\"segmentBound\":true}}]}}", .{12}));
        const work = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"work\",\"ops\":\"all\"}}", .{13}));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"a\",\"grants\":{{\"work\":{d}}},\"source\":\"script variable n = 0\\non hold\\nput 9 into n\\nask work to touch\\nrepeat forever\\nend repeat\\nend hold\\n\"}}", .{ 14, work.object.get("grant").?.integer }));
        _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"a\"}},\"message\":{{\"name\":\"hold\"}}}}", .{15}));
        if (!transported) {
            const NativeWork = struct {
                fn call(_: ?*anyopaque, call_: *caps.Call, _: []const *Value) caps.Outcome {
                    return .{ .value = model.scalar(call_.gpa, .{ .number = .fromInt(7) }) catch return .broken };
                }
                fn hook(_: ?*anyopaque, _: caps.Phase, _: *const caps.SegmentContext) caps.EffectStatus {
                    return .ok;
                }
            };
            s.capabilityNamed("work").?.operations[0].host = .{ .call = NativeWork.call };
            s.grants.items[1].coordinator.?.hook = NativeWork.hook;
        }
        var warm = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"1970-01-01T00:00:00Z\",\"fuelSlice\":45}}", .{16});
        var needs: usize = 0;
        while (warm.object.get("need")) |need| {
            needs += 1;
            try t.expect(needs <= 2);
            warm = if (std.mem.eql(u8, need.object.get("m").?.string, "effect"))
                try c.sendRef(16, "{{\"m\":\"effect-result\",\"ref\":16,\"status\":\"ok\"}}", .{})
            else
                try c.sendRef(16, "{{\"m\":\"op-result\",\"ref\":16,\"result\":7}}", .{});
        }
        _ = try okOf(warm);
    }
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\",\"args\":[{{\"$object\":[\"thing\",\"o\"]}}]}}}}", .{7}));
    var host: crossing_test.Host = .{ .g = g, .control = control, .result = result, .target = if (other_run) (if (control == .stop) "a" else "a/r1") else null };
    const Native = struct {
        host: *crossing_test.Host,
        entry: *GroupEntry,
        fn call(context: ?*anyopaque, call_: *caps.Call, args: []const *Value) caps.Outcome {
            const n: *@This() = @ptrCast(@alignCast(context.?));
            const outcome = crossing_test.Host.call(n.host, call_, args);
            if (outcome == .started) n.entry.track(call_.id);
            return outcome;
        }
    };
    var native: Native = .{ .host = &host, .entry = entry };
    if (!transported) {
        s.capabilityNamed("api").?.operations[0].host = .{ .call = Native.call, .context = &native };
        const prop = &g.objects.items[0].kind.props[0];
        prop.get = .{ .call = crossing_test.Host.get, .context = &host };
        prop.set = .{ .call = crossing_test.Host.set, .context = &host };
    }
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"1970-01-01T00:00:00Z\"}}", .{8});
    if (cleanup) {
        _ = try okOf(reply);
        _ = try okOf(try c.send("{{\"m\":\"cancel-run\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"run\":\"s/r1\"}}", .{11}));
        reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"1970-01-01T00:00:00Z\"}}", .{8});
    }
    if (transported) {
        const need = reply.object.get("need").?;
        if (control != .none) {
            const name: []const u8 = switch (control) {
                .stop => "stop",
                .cancel => "cancel-run",
                .rewind => "rewind-run",
                .none => unreachable,
            };
            _ = try okOf(try c.sendRef(17, "{{\"m\":\"{s}\",\"ref\":17,\"group\":\"g\",\"script\":\"{s}\",\"run\":\"{s}/r1\",\"reason\":\"crossing\"}}", .{ name, if (other_run) @as([]const u8, "a") else "s", if (other_run) @as([]const u8, "a") else "s" }));
        }
        const is_prop = crossing == .get or crossing == .set;
        const outcome: []const u8 = switch (result) {
            .value => if (crossing == .set) "\"ok\":true" else if (is_prop) "\"value\":7" else "\"result\":7",
            .wrong_shape => if (is_prop) "\"value\":true" else "\"result\":true",
            .started => "\"started\":true",
            .failure => "\"fail\":{\"code\":\"oops\"}",
            .invalid_failure => "\"fail\":{\"code\":\"timeout\"}",
            .duplicate_failure => "\"fail\":{\"code\":\"oops\",\"data\":{\"code\":\"duplicate\"}}",
            .broken => "\"hostError\":true",
            .refused => unreachable,
        };
        try t.expectEqualStrings(if (is_prop) "prop" else "op", need.object.get("m").?.string);
        reply = try c.sendRef(8, "{{\"m\":\"{s}-result\",\"ref\":8,{s}}}", .{ if (is_prop) @as([]const u8, "prop") else "op", outcome });
    }
    var releases: usize = 0;
    while (reply.object.get("need")) |need| {
        releases += 1;
        try t.expect(releases <= 2);
        if (std.mem.eql(u8, need.object.get("m").?.string, "effect")) {
            try t.expect(other_run);
            reply = try c.sendRef(8, "{{\"m\":\"effect-result\",\"ref\":8,\"status\":\"ok\"}}", .{});
        } else {
            try t.expectEqualStrings("release", need.object.get("m").?.string);
            reply = try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":8}}", .{});
        }
    }
    _ = try okOf(reply);
    // Include state, complete Reports/accounting/abandonment, exact Trace,
    // and cumulative Fuel/allocation counters in the comparison.
    const view = try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{9});
    const counters = try c.send("{{\"m\":\"counters\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{10});
    return std.json.Stringify.valueAlloc(a, .{ reply, view, counters }, .{});
}

test "callback return landing has native and Message Layer parity" {
    const t = std.testing;
    for (std.enums.values(crossing_test.Crossing)) |crossing| for (std.enums.values(crossing_test.Control)) |control| for ([_]crossing_test.Return{ .value, .wrong_shape, .failure, .invalid_failure, .duplicate_failure, .broken, .started }) |result| {
        if (crossing == .suspending and (result == .value or result == .wrong_shape)) continue;
        if (crossing != .suspending and result == .started) continue;
        const native = try crossingParity(crossing, control, result, false, .ordinary);
        defer t.allocator.free(native);
        const transported = try crossingParity(crossing, control, result, true, .ordinary);
        defer t.allocator.free(transported);
        try t.expectEqualStrings(native, transported);
    };
}

test "cancellation cleanup failures have native and Message Layer parity" {
    const t = std.testing;
    for ([_]crossing_test.Crossing{ .immediate, .get, .set }) |crossing| for ([_]crossing_test.Return{ .value, .wrong_shape, .failure, .invalid_failure, .duplicate_failure, .broken }) |result| {
        const native = try crossingParity(crossing, .none, result, false, .cleanup);
        defer t.allocator.free(native);
        const transported = try crossingParity(crossing, .none, result, true, .cleanup);
        defer t.allocator.free(transported);
        try t.expectEqualStrings(native, transported);
    };
}

test "callback return through another Run's rollback has native and Message Layer parity" {
    const t = std.testing;
    for (std.enums.values(crossing_test.Crossing)) |crossing| for ([_]crossing_test.Control{ .stop, .cancel, .rewind }) |control| for ([_]crossing_test.Return{ .value, .wrong_shape, .failure, .duplicate_failure, .broken, .started }) |result| {
        if (crossing == .suspending and (result == .value or result == .wrong_shape)) continue;
        if (crossing != .suspending and result == .started) continue;
        const native = try crossingParity(crossing, control, result, false, .other_run);
        defer t.allocator.free(native);
        const transported = try crossingParity(crossing, control, result, true, .other_run);
        defer t.allocator.free(transported);
        try t.expectEqualStrings(native, transported);
    };
}

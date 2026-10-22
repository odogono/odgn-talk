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
const sorting = @import("sort.zig");
const builtin = @import("builtin");
const model = @import("value.zig");
const display = @import("display.zig");
const encoding = @import("encoding.zig");
const machine = @import("machine/machine.zig");
const caps = machine.capabilities;
const objects = machine.objects;
const talk = @import("talk.zig");
const standard = @import("machine/standard.zig");
const sqlite = @import("machine/sqlite.zig");
const generated_diagnostics = @import("generated/diagnostics.zig");
const analysis = @import("analysis.zig");
const binary_value = @import("binary_value.zig");
const rp = @import("request_pump.zig");
const exchange = @import("exchange.zig");

const Allocator = std.mem.Allocator;
const Value = model.Value;
const Json = std.json.Value;
const Direct = talk.direct;

/// The largest frame a Host may write, as the harnesses measure it.
pub const max_frame: usize = 64 << 20;
const max_message: usize = 0x7fffffff;
const more_chunks: usize = 0x80000000;
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

/// A Group's seed, 0 to 2^64 - 1, in chapter 9's integer encoding.
fn asSeed(j: Json) ?u64 {
    return switch (j) {
        .integer => |n| std.math.cast(u64, n),
        .number_string, .string => |t| std.fmt.parseInt(u64, t, 10) catch null,
        else => null,
    };
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
    /// Whether `run end` reports carry `climbed` (`climb-v1`).
    climb: bool = false,
    /// Whether Pump replies list stale Function Value calls (`function-gone-v1`).
    gone: bool = false,
    /// Trace lines not yet carried by a reply, from the sink.
    pending_trace: std.ArrayList([]u8) = .empty,
    inline_trace: ?InlineTrace = null,
    /// Whether the last value read held another Group's Function Value.
    wrong_group: bool = false,
    /// The calls the Host answered `started`, or adopted, and hasn't
    /// answered or failed: those the Core abandons are listed in the next
    /// reply's `abandoned`, once.
    started: std.ArrayList([]u8) = .empty,
    /// `group-exchanges-v1`: this Group's exchange while another's is loaded.
    parked: Exchange = .{},

    /// Frees the entry and its Group, which no exchange may still name.
    fn destroy(e: *GroupEntry) void {
        const gpa = e.gpa;
        e.parked.deinit(gpa);
        Direct.groupRelease(e.group);
        for (e.pending_trace.items) |line| gpa.free(line);
        for (e.started.items) |x| gpa.free(x);
        e.started.deinit(gpa);
        e.pending_trace.deinit(gpa);
        if (e.inline_trace) |*t| {
            t.bytes.deinit(gpa);
            for (t.diagnostics.items) |line| gpa.free(line);
            t.diagnostics.deinit(gpa);
        }
        gpa.free(e.name);
        gpa.destroy(e);
    }

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

    fn isAbandoned(e: *GroupEntry, id: []const u8) bool {
        const c = e.group.group.callById(id) orelse return false;
        return c.abandoned.load(.acquire);
    }

    /// Writes actual abandonments in Call order without consuming them:
    /// a reply allocation failure must leave the notification available.
    fn writeAbandoned(e: *GroupEntry, o: *Out) Allocator.Error!void {
        var listed: std.ArrayList([]const u8) = .empty;
        defer listed.deinit(e.gpa);
        try e.abandonedIds(&listed);
        try o.raw(",\"abandoned\":[");
        for (listed.items, 0..) |id, k| {
            if (k > 0) try o.raw(",");
            try o.text(id);
        }
        try o.raw("]");
    }

    /// Actual abandonments in Call order, borrowed from `started`.
    fn abandonedIds(e: *GroupEntry, listed: *std.ArrayList([]const u8)) Allocator.Error!void {
        for (e.started.items) |id| if (e.isAbandoned(id)) try listed.append(e.gpa, id);
        sorting.stable([]const u8, listed.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return machine.callOrder(x, y);
            }
        }.less);
    }

    /// A queued answer is no longer cancellable only once its Run consumes it.
    fn settledIds(e: *GroupEntry, listed: *std.ArrayList([]const u8)) Allocator.Error!void {
        for (e.started.items) |id| {
            const c = e.group.group.callById(id) orelse continue;
            if (!c.settlement_consumed or c.abandoned.load(.acquire)) continue;
            try listed.append(e.gpa, id);
        }
    }

    fn writeSettled(e: *GroupEntry, o: *Out) Allocator.Error!void {
        var listed: std.ArrayList([]const u8) = .empty;
        defer listed.deinit(e.gpa);
        try e.settledIds(&listed);
        try o.raw(",\"settled\":[");
        for (listed.items, 0..) |id, k| {
            if (k > 0) try o.raw(",");
            try o.text(id);
        }
        try o.raw("]");
    }

    /// Called only once the complete reply has been serialized successfully.
    fn forgetAbandoned(e: *GroupEntry) void {
        var i: usize = 0;
        while (i < e.started.items.len) {
            const c = e.group.group.callById(e.started.items[i]);
            if (c != null and (c.?.settlement_consumed or c.?.abandoned.load(.acquire))) {
                e.gpa.free(e.started.orderedRemove(i));
            } else i += 1;
        }
    }

    /// Whether the Host is still working on this call.
    pub fn holds(e: *const GroupEntry, id: []const u8) bool {
        for (e.started.items) |x| if (std.mem.eql(u8, x, id)) return true;
        return false;
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

    pub fn release(a: *Answer, gpa: Allocator) void {
        if (a.value) |v| v.release();
        if (a.data) |v| v.release();
        if (a.code.len > 0) gpa.free(a.code);
        if (a.message) |m| gpa.free(m);
        a.* = undefined;
    }
};

/// The crossing a Pump paused at, until its result comes back.
const Need = struct {
    kind: exchange.Crossing,
    /// The paused Pump's Group.
    entry: *GroupEntry,
    /// When not empty, the one allocation an op's texts are slices of.
    packed_texts: []u8 = &.{},
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
    /// An Object Collection call's `op` and selector (#1143).
    op: ?[]const u8 = null,
    selector: ?*Value = null,
    // An effect's fields, with `script`, `run`, `segment`, `grant` and
    // `now`: every enrolled Grant, the named Coordinator, and the phase.
    grants: [][]u8 = &.{},
    coordinator: ?[]u8 = null,
    phase: caps.Phase = .begin,

    pub fn release(n: *Need, gpa: Allocator) void {
        if (n.packed_texts.len != 0) {
            gpa.free(n.packed_texts);
        } else for ([_][]u8{ n.call, n.script, n.run, n.segment, n.grant, n.capability, n.operation, n.scope }) |s| gpa.free(s);
        for ([_][]u8{ n.object_kind, n.object_id, n.prop }) |s| gpa.free(s);
        for (n.grants) |g| gpa.free(g);
        gpa.free(n.grants);
        if (n.coordinator) |c| gpa.free(c);
        for (n.args) |v| v.release();
        gpa.free(n.args);
        if (n.value) |v| v.release();
        if (n.selector) |v| v.release();
        n.* = undefined;
    }
};

const layer = @This();

/// A Host-started worker exchange (`exchange.zig`): a Pump, Reload or
/// library replacement that may pause for needs and Grant releases before
/// its final reply.
const Exchange = exchange.Exchange(struct {
    pub const Entry = *GroupEntry;
    pub const Need = layer.Need;
    pub const Answer = layer.Answer;
    pub const Held = HeldReply;
    pub const Release = layer.Release;
    pub const Bin = BinExchange;
    pub const EffectStatus = caps.EffectStatus;

    pub fn releasePaused(e: *GroupEntry) bool {
        return e.group.group.releasePaused();
    }
    pub fn pauseForRelease(e: *GroupEntry) void {
        e.group.group.pauseForRelease();
    }
    pub fn clearReleasePause(e: *GroupEntry) void {
        e.group.group.clearReleasePause();
    }
    pub fn tracePaused(e: *GroupEntry) bool {
        return e.group.group.tracePaused();
    }
    pub fn clearTracePause(e: *GroupEntry) void {
        e.group.group.clearTracePause();
    }
    pub fn beginAnswer(e: *GroupEntry) void {
        e.group.group.beginAnswer();
    }
    pub fn answerTaken(e: *GroupEntry) void {
        e.group.group.answerTaken();
    }
});

/// One instance's Message Layer state: its Core, and the Handles the Host
/// holds. Created whole by `Session.init`; the wasm exports keep one in
/// `instance`.
pub const Session = struct {
    gpa: Allocator,
    core: *talk.Core,
    grants: std.ArrayList(*caps.Grant) = .empty,
    capability_handles: std.ArrayList(struct { name: []u8, definition: *caps.Capability }) = .empty,
    /// The Groups by handle, each keyed by its entry's own `name`. Nothing
    /// depends on their order, so `drop-group` swaps the last one in.
    groups: std.StringArrayHashMapUnmanaged(*GroupEntry) = .empty,
    /// Per-Operation and per-property Host contexts, owned here.
    op_contexts: std.ArrayList(*OpContext) = .empty,
    prop_contexts: std.ArrayList(*PropContext) = .empty,
    /// The exchange of the Group the current frame addresses. Without
    /// `group-exchanges-v1` it is the Session's only exchange; with it,
    /// each Group parks its own in its entry while another's is loaded.
    x: Exchange = .{},
    /// The Group whose exchange is loaded in `x`; null for the Session's.
    x_owner: ?*GroupEntry = null,
    /// `group-exchanges-v1`: each Group has its own exchange.
    group_exchanges: bool = false,
    /// `object-elements-v1`: Object Kinds may declare a collection (#1143).
    object_elements: bool = false,
    /// OOM inside a Host function, which cannot report it there.
    oom: bool = false,
    /// A `restore` waiting for its `resolve-result`.
    restoring: ?Restoring = null,
    admitting: bool = false,
    /// Opted in at hello: notify before the next callback, once across replies.
    early_abandoned: bool = false,
    crossing_trace: bool = false,
    /// A transport can serve queued inputs on the current guest stack.
    inline_io: ?*const fn ([]const u8) ?[]const u8 = null,
    inline_inputs: bool = false,
    chunked_wasi: bool = false,
    inline_active: bool = false,
    active_ref: i64 = 0,
    /// `climb-v1`: a `run end` whose message climbed says so.
    climb: bool = false,
    /// `function-gone-v1`: a Pump reply lists stale Function Value calls.
    gone: bool = false,
    /// `function-metadata-v1`: Function Values carry name, arity and source identity.
    function_metadata: bool = false,
    /// `core-message-v1`: Core-raised error maps cross as `$coreError`.
    core_errors: bool = false,
    /// `analysis-v1`: the language analysis exchanges are open.
    analysis: bool = false,
    /// `queued-inputs-v1`: Trace-silent pending Host Input queries.
    queued_inputs: bool = false,
    reply_error: bool = false,
    /// `request-pump-fields-v1` (#1245): Request/Pump inputs may cross as
    /// binary fields-layout frames.
    request_pump: bool = false,
    /// `callbacks-fields-v1` (#1311): callback needs and results are binary.
    callbacks: bool = false,
    /// `settlements-fields-v1` (#1320): `settle-pump` carries queued settlements.
    settlements: bool = false,
    load_fields: bool = false,
    /// `queue-fields-v1` (#1374): queued Deliveries cross in binary.
    queue_fields: bool = false,
    /// Combined exchanges' correlation tokens, bound until their final reply.
    bindings: std.ArrayList(Binding) = .empty,
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
        s.x.deinit(gpa);
        for (s.bindings.items) |b| gpa.free(b.delivery);
        s.bindings.deinit(gpa);
        if (s.restoring) |*r| r.deinit();
        for (s.effect_contexts.items) |c| {
            if (c.coordinator) |n| gpa.free(n);
            if (c.locale) |n| gpa.free(n);
            gpa.destroy(c);
        }
        s.effect_contexts.deinit(gpa);
        for (s.groups.values()) |e| e.destroy();
        s.groups.deinit(gpa);
        s.grants.deinit(gpa);
        for (s.capability_handles.items) |h| gpa.free(h.name);
        s.capability_handles.deinit(gpa);
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
        return s.groups.get(name);
    }

    fn capabilityNamed(s: *Session, name: []const u8) ?*caps.Capability {
        for (s.capability_handles.items) |h| if (std.mem.eql(u8, h.name, name)) return h.definition;
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
    before: @FieldType(caps.Operation, "before") = null,
    standard: ?standard.Which = null,
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
    shared: ?*EffectContext = null,
    locale: ?[]u8 = null,
    sqlite_binding: sqlite.Binding = .{ .database = null, .database_len = 0, .max_rows = 0 },
};

/// A Grant release the Core made, waiting to be sent as a `release` need.
const Release = struct {
    script: []u8,
    grant: []u8,
    reason: caps.ReleaseReason,
    now: model.dates.Instant,

    pub fn deinit(r: *Release, gpa: Allocator) void {
        gpa.free(r.script);
        gpa.free(r.grant);
    }
};

/// A reply under construction.
const Out = struct {
    buf: std.Io.Writer.Allocating,
    /// Whether `run end` reports carry `climbed` (`climb-v1`).
    climbed: bool = false,

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
        return o.valueWith(v, if (handling) |s| s.core_errors else false);
    }
    /// A Value Encoding, marking Core-raised error maps only when `core_errors`.
    fn valueWith(o: *Out, v: *const Value, core_errors: bool) (Allocator.Error || error{NotEncodable})!void {
        const functions: ?encoding.FunctionWriter = if (handling) |s| .{ .context = s, .write = writeFunction, .core_error = core_errors } else null;
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
    if (handling) |s| s.reply_error = true;
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
    if (handling) |s| s.reply_error = true;
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
        .core_error = if (handling) |s| s.core_errors else false,
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

/// `{"$function": [home, display, token]}`, with name and arity appended
/// under `function-metadata-v1`. The token is the base64 of
/// `{"g": group, "f": code, "d": display, "c": captures}`: the Group's
/// handle, the index of the value's code in it, and its captures, so
/// reading it needs nothing the Host must release.
fn writeFunction(context: ?*anyopaque, w: *std.Io.Writer, v: *const Value) encoding.Error!void {
    const s: *Session = @ptrCast(@alignCast(context.?));
    return writeFunctionWith(s, w, v, s.function_metadata);
}

// Tokens keep their original representation even when captured Functions
// cross a Session that has opted into metadata. Negotiation changes no identity.
fn writeFunctionLegacy(context: ?*anyopaque, w: *std.Io.Writer, v: *const Value) encoding.Error!void {
    return writeFunctionWith(@ptrCast(@alignCast(context.?)), w, v, false);
}

/// Where a Function Value's code is, and its token, owned by `s.gpa`.
const FunctionToken = struct { entry: *GroupEntry, index: usize, token: []u8 };

fn functionToken(s: *Session, v: *const Value) encoding.Error!FunctionToken {
    const f = v.data.function;
    var at: ?struct { *GroupEntry, usize } = null;
    for (s.groups.values()) |e| {
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
    try encoding.writeWith(iw, f.captures, .{ .context = s, .write = writeFunctionLegacy, .core_error = token_core_errors });
    iw.writeAll("}") catch return error.OutOfMemory;
    const codec = std.base64.standard.Encoder;
    const token = try s.gpa.alloc(u8, codec.calcSize(inner.written().len));
    _ = codec.encode(token, inner.written());
    return .{ .entry = found[0], .index = found[1], .token = token };
}

fn writeFunctionWith(s: *Session, w: *std.Io.Writer, v: *const Value, metadata: bool) encoding.Error!void {
    const f = v.data.function;
    const found = try functionToken(s, v);
    defer s.gpa.free(found.token);
    const token = found.token;
    w.writeAll("{\"$function\":[") catch return error.WriteFailed;
    std.json.Stringify.value(f.home, .{}, w) catch return error.WriteFailed;
    w.writeAll(",") catch return error.WriteFailed;
    std.json.Stringify.value(f.display, .{}, w) catch return error.WriteFailed;
    w.writeAll(",") catch return error.WriteFailed;
    std.json.Stringify.value(token, .{}, w) catch return error.WriteFailed;
    if (metadata) {
        const code = found.entry.group.group.functions.items[found.index];
        w.writeAll(",") catch return error.WriteFailed;
        if (code.name.len == 0) {
            w.writeAll("null") catch return error.WriteFailed;
        } else std.json.Stringify.value(code.name, .{}, w) catch return error.WriteFailed;
        w.print(",{d},{d}", .{ code.required, code.total }) catch return error.WriteFailed;
        w.writeAll(",{\"$bytes\":\"") catch return error.WriteFailed;
        var encoded: [44]u8 = undefined;
        w.writeAll(std.base64.standard.Encoder.encode(&encoded, &code.unit)) catch return error.WriteFailed;
        w.writeAll("\"}") catch return error.WriteFailed;
    }
    w.writeAll("]}") catch return error.WriteFailed;
}

/// A token's captures always mark Core-raised errors, whatever was
/// negotiated: the token is this layer's own, written and read here.
const token_core_errors = true;

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
    var captured = resolverOf(e);
    captured.core_error = token_core_errors;
    const captures = try encoding.decodeParsed(gpa, field(parsed.value, "c") orelse return error.InvalidValue, captured);
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
    inline for (machine.override_fields) |t| {
        if (v.object.get(t.ts)) |x| {
            const n = asInt(x) orelse return error.InvalidValue;
            if (n < 0) return error.InvalidValue;
            @field(out.*, t.field) = n;
            out.set |= t.bit;
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
    if (s.x.releasePaused()) return .deferred;
    if (s.x.takeAnswer()) |answer| {
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
                if (s.x.runningEntry()) |e| e.track(call.id);
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
    if (!s.x.canDefer(.op) or !call.deferrable) return .broken;
    s.x.cross(need: {
        const gpa = s.gpa;
        // One allocation holds every text the need carries (#1103).
        const texts = [_][]const u8{ call.id, call.script, call.run, call.segment, call.grant, oc.capability, oc.operation, call.scope };
        var total: usize = 0;
        for (texts) |t| total += t.len;
        const packed_texts = gpa.alloc(u8, total) catch return .broken;
        var slices: [texts.len][]u8 = undefined;
        var at: usize = 0;
        for (texts, &slices) |t, *slot| {
            slot.* = packed_texts[at..][0..t.len];
            @memcpy(slot.*, t);
            at += t.len;
        }
        var n: Need = .{
            .kind = .op,
            .entry = s.x.runningEntry().?,
            .packed_texts = packed_texts,
            .call = slices[0],
            .script = slices[1],
            .run = slices[2],
            .segment = slices[3],
            .grant = slices[4],
            .capability = slices[5],
            .operation = slices[6],
            .scope = slices[7],
            .now = call.now,
            .args = &.{},
            .object_kind = &.{},
            .object_id = &.{},
            .prop = &.{},
        };
        n.mode = oc.mode;
        n.automatic = call.automatic;
        n.fuel_left = if (call.automatic) null else call.left;
        const kept = gpa.alloc(*Value, args.len) catch {
            gpa.free(packed_texts);
            return .broken;
        };
        for (args, kept) |v, *slot| slot.* = v.retain();
        n.args = kept;
        break :need n;
    });
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
    if (g.binding) |b| {
        const ec: *EffectContext = @ptrCast(@alignCast(b));
        const shared = ec.shared orelse ec;
        return .{ .identity = @intFromPtr(shared), .hook = effectHook, .context = shared };
    }
    return .{ .identity = @intFromPtr(g), .hook = effectHook, .context = context };
}

/// A Segment lifecycle hook: the `effect-result` an `effect` need brought
/// back, or else that need, and a pause at the crossing. One that can't
/// pause has no answer, which leaves its state unknown.
fn effectHook(context: ?*anyopaque, phase: caps.Phase, sc: *const caps.SegmentContext) caps.EffectStatus {
    const ec: *EffectContext = @ptrCast(@alignCast(context.?));
    const s = ec.session;
    if (s.x.releasePaused()) return .deferred;
    if (s.x.takeEffectAnswer()) |status| return status;
    if (!s.x.canDefer(.effect) or !sc.deferrable) return .unknown;
    const gpa = s.gpa;
    var n: Need = .{
        .kind = .effect,
        .entry = s.x.runningEntry().?,
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
        s.x.cross(n);
        return .deferred;
    }
    n.release(gpa);
    return .unknown;
}

/// The Grant release hook: queued, and sent as a `release` need before
/// the reply it comes before. It has no result and can't refuse.
fn releaseHook(context: ?*anyopaque, gc: *const caps.GrantContext) void {
    const s: *Session = @ptrCast(@alignCast(context.?));
    const entry = switch (s.x.route(s.inline_inputs and !s.inline_active)) {
        .inline_to => |e| e,
        .drop => return,
        .queue => null,
    };
    if (entry) |e| {
        var o = Out.init(s.gpa);
        defer o.deinit();
        o.raw("{\"need\":{\"m\":\"release\",\"script\":") catch return;
        o.text(gc.script) catch return;
        o.raw(",\"grant\":") catch return;
        o.text(gc.grant) catch return;
        o.raw(",\"reason\":") catch return;
        o.text(@tagName(gc.reason)) catch return;
        o.raw(",\"now\":") catch return;
        o.instant(s.gpa, gc.now) catch return;
        o.raw("}}") catch return;
        inlineRound(s, e, o.buf.written());
        return;
    }
    const script = s.gpa.dupe(u8, gc.script) catch return;
    const grant = s.gpa.dupe(u8, gc.grant) catch {
        s.gpa.free(script);
        return;
    };
    s.x.queue(s.gpa, .{ .script = script, .grant = grant, .reason = gc.reason, .now = gc.now }) catch {
        s.gpa.free(script);
        s.gpa.free(grant);
    };
}

fn propAnswer(s: *Session, gpa: Allocator) ?objects.Result {
    const answer = s.x.takeAnswer() orelse return null;
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
    if (!s.x.canDefer(.prop)) return .broken;
    const gpa = s.gpa;
    s.x.cross(.{
        .kind = .prop,
        .entry = s.x.runningEntry().?,
        .call = &.{},
        .script = &.{},
        .run = &.{},
        .segment = &.{},
        .grant = &.{},
        .capability = &.{},
        .operation = &.{},
        .scope = &.{},
        .now = .{ .seconds = 0, .micros = 0 },
        .args = &.{},
        .object_kind = gpa.dupe(u8, o.kind.name) catch return .broken,
        .object_id = gpa.dupe(u8, o.id) catch return .broken,
        .prop = gpa.dupe(u8, pc.prop) catch return .broken,
        .value = if (value) |v| v.retain() else null,
    });
    return .deferred;
}

/// An Object Collection call (#1143): the interim `prop` need with `prop`
/// `elements`, its `op` and, for `at` and `find`, its selector.
fn elementNeed(s: *Session, pc: *PropContext, o: *objects.Object, op: []const u8, selector: ?*Value) objects.Result {
    const r = propNeed(s, pc, o, null);
    if (r == .deferred) {
        s.x.crossing().op = op;
        s.x.crossing().selector = selector;
    } else if (selector) |v| v.release();
    return r;
}

fn elementCount(context: ?*anyopaque, gpa: Allocator, o: *objects.Object) objects.Result {
    const pc: *PropContext = @ptrCast(@alignCast(context.?));
    if (propAnswer(pc.session, gpa)) |r| return r;
    return elementNeed(pc.session, pc, o, "count", null);
}

fn elementAt(context: ?*anyopaque, gpa: Allocator, o: *objects.Object, index: i64) objects.Result {
    const pc: *PropContext = @ptrCast(@alignCast(context.?));
    if (propAnswer(pc.session, gpa)) |r| return r;
    const selector = model.scalar(pc.session.gpa, .{ .number = model.Decimal.fromInt(index) }) catch return .broken;
    return elementNeed(pc.session, pc, o, "at", selector);
}

fn elementFind(context: ?*anyopaque, gpa: Allocator, o: *objects.Object, name: []const u8) objects.Result {
    const pc: *PropContext = @ptrCast(@alignCast(context.?));
    if (propAnswer(pc.session, gpa)) |r| return r;
    const selector = model.text(pc.session.gpa, name) catch return .broken;
    return elementNeed(pc.session, pc, o, "find", selector);
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
    for (op.labels) |l| a.free(l);
    a.free(op.labels);
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
    const command = if (j.object.get("command")) |b| asBool(b) orelse return error.InvalidValue else false;
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
    // Argument Labels (ADR 0115): a list of text, whose words and length
    // the Core checks when the Capability is defined.
    const labels = try labelsOf(a, j.object.get("labels"));
    errdefer {
        for (labels) |l| a.free(l);
        a.free(labels);
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
        .command = command,
        .labels = labels,
        .metering = metering,
        .host = .{ .call = opCall, .context = oc },
    };
}

/// An Operation Declaration's `labels`, copied: absent is none, and
/// anything but a list of text is refused.
fn labelsOf(a: Allocator, given: ?Json) (Allocator.Error || Invalid)![]const []const u8 {
    const j = given orelse return &.{};
    if (j != .array) return error.InvalidValue;
    const out = try a.alloc([]const u8, j.array.items.len);
    var made: usize = 0;
    errdefer {
        for (out[0..made]) |l| a.free(l);
        a.free(out);
    }
    for (j.array.items, out) |item, *slot| {
        slot.* = try a.dupe(u8, asText(item) orelse return error.InvalidValue);
        made += 1;
    }
    return out;
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
            // An `ok` with no other fields has just opened its brace.
            const so_far = o.buf.written();
            o.raw(if (so_far.len > 0 and so_far[so_far.len - 1] == '{') "\"trace\":[" else ",\"trace\":[") catch {};
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
    if (s.callbacks) return binNeed(s, ref) catch oomReply();
    const n = s.x.openNeed();
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
            if (n.op) |op| {
                o.raw(",\"op\":") catch {};
                o.text(op) catch {};
            }
            if (n.selector) |v| {
                o.raw(",\"selector\":") catch {};
                o.value(v) catch {};
            }
        },
    }
    o.raw("}}") catch {};
    return o.finish() catch oomReply();
}

/// The Reports a Pump made, taken from the Group, as chapter 9 encodes them.
fn writeReports(o: *Out, entry: *GroupEntry) Allocator.Error!void {
    o.climbed = entry.climb;
    // Stale Function Value calls rejected `function gone` with no report.
    const gone = entry.group.group.goneCalls();
    defer entry.group.group.clearGoneCalls();
    if (entry.gone) {
        try o.raw(",\"gone\":[");
        for (gone, 0..) |id, i| {
            if (i > 0) try o.raw(",");
            try o.raw("\"d");
            try o.int(id);
            try o.raw("\"");
        }
        try o.raw("]");
    }
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
        try writeReport(o, r, o.climbed);
    }
    try o.raw("]");
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

/// Each Report's fields, in order, written once for both layouts. `e` is a
/// `JsonReport` or a `BinReport`: an encoder with `key`, `text`, `int`,
/// `boolean`, `texts`, `value` (a Value Encoding field), `plain` (an error
/// record, never core-marked), `map`/`endMap` and `list`/`item`/`endList`.
fn reportFields(e: anytype, report: machine.report.Report, climbed: bool) Allocator.Error!void {
    switch (report) {
        .charge_result => |r| {
            try e.key("request");
            try e.text(r.request);
            try e.key("call");
            try e.text(r.call);
            try e.key("fuel");
            try e.int(r.fuel);
            try e.key("status");
            try e.text(@tagName(r.status));
        },
        .run_end => |r| {
            try e.key("script");
            try e.text(r.script);
            try optionalField(e, "run", r.run);
            try optionalField(e, "delivery", r.delivery);
            try optionalField(e, "broadcast", r.broadcast);
            try optionalField(e, "handler", r.handler);
            if (r.fallback) {
                try e.key("fallback");
                try e.boolean(true);
            }
            if (climbed and r.climbed) {
                try e.key("climbed");
                try e.boolean(true);
            }
            try e.key("outcome");
            try e.text(outcomeWord(r.outcome));
            if (r.result) |v| {
                try e.key("result");
                try e.value(v);
            }
            if (r.err) |v| {
                // `error` is a plain error record, not a Value Encoding
                // field, so `core-message-v1` leaves it unmarked.
                try e.key("error");
                try e.plain(v);
            }
            try optionalField(e, "limit", r.limit);
            if (r.effect) |x| {
                try e.key("effect");
                try e.map();
                try effectFields(e, x);
                try e.endMap();
            }
            if (r.cleanup_failed) |c| {
                try e.key("cleanupFailed");
                try e.map();
                if (c.code.len > 0) {
                    try e.key("code");
                    try e.text(c.code);
                } else {
                    try e.key("limit");
                    try e.text(c.limit);
                }
                try e.endMap();
            }
            if (r.at.unit.len > 0) {
                try e.key("at");
                try e.map();
                try e.key("unit");
                try e.text(r.at.unit);
                try e.key("line");
                try e.int(r.at.line);
                try e.key("col");
                try e.int(r.at.column);
                try e.key("handler");
                try e.text(r.at.handler);
                try e.key("pc");
                try e.int(r.at.pc);
                try e.endMap();
            }
            try e.key("fuel");
            try e.int(r.fuel);
            try e.key("alloc");
            try e.int(r.alloc);
        },
        .stop => |r| {
            try e.key("script");
            try e.text(r.script);
            try e.key("reason");
            try e.text(r.reason);
            try e.key("discardedRuns");
            try e.texts(r.discarded_runs);
            try e.key("droppedMessages");
            try e.texts(r.dropped_messages);
            try e.key("pendingCalls");
            try e.texts(r.pending_calls);
        },
        .unhandled => |r| {
            try e.key("delivery");
            try e.text(r.delivery);
            try e.key("message");
            try e.map();
            try e.key("name");
            try e.text(r.message);
            try e.key("args");
            try values(e, r.args);
            try e.endMap();
            if (r.target) |t| {
                try e.key("target");
                try e.value(t.value);
            }
        },
        .call_failed => |r| {
            try e.key("script");
            try e.text(r.script);
            try e.key("call");
            try e.text(r.call);
            try e.key("operation");
            try e.map();
            try e.key("capability");
            try e.text(r.capability);
            try e.key("operation");
            try e.text(r.operation);
            try e.endMap();
            try e.key("detail");
            try e.text(r.detail);
        },
        .effect_failure => |x| try effectFields(e, x),
        .decided => |r| {
            try optionalField(e, "delivery", r.delivery);
            try optionalField(e, "broadcast", r.broadcast);
            try e.key("verdict");
            try e.text(@tagName(r.verdict));
            try e.key("vetoes");
            try e.list(r.vetoes.len);
            for (r.vetoes) |v| {
                try e.item();
                try e.map();
                try e.key("script");
                try e.text(v.script);
                try e.key("run");
                try e.text(v.run);
                try e.key("reason");
                try e.value(v.reason);
                try e.endMap();
            }
            try e.endList();
            try e.key("undecided");
            try e.list(r.undecided.len);
            for (r.undecided) |u| {
                try e.item();
                try e.map();
                try e.key("script");
                try e.text(u.script);
                try e.key("run");
                try e.text(u.run);
                try e.key("outcome");
                try e.text(outcomeWord(u.outcome));
                try e.endMap();
            }
            try e.endList();
        },
        .run_started => |r| {
            try e.key("script");
            try e.text(r.script);
            try e.key("run");
            try e.text(r.run);
            try e.key("args");
            try values(e, r.args);
            try ancestryFields(e, r.ancestry);
            try optionalField(e, "delivery", r.delivery);
            try optionalField(e, "selector", r.selector);
            if (r.function) |f| {
                try e.key("fn");
                try e.value(f);
            }
        },
        .run_discarded => |r| {
            try e.key("script");
            try e.text(r.script);
            try e.key("run");
            try e.text(r.run);
            try e.key("reason");
            try e.text(r.reason);
            try ancestryFields(e, r.ancestry);
        },
        .run_accounting => |r| {
            try e.key("script");
            try e.text(r.script);
            try e.key("run");
            try e.text(r.run);
            try e.key("fuel");
            try e.int(r.fuel);
            try e.key("state");
            try e.text(@tagName(r.state));
            try ancestryFields(e, r.ancestry);
        },
        .causal_work => |r| {
            try e.key("rootDelivery");
            try e.text(r.root);
            try e.key("liveRuns");
            try e.int(r.live_runs);
            try e.key("queuedMessages");
            try e.int(r.queued_messages);
            try e.key("discardedMessages");
            try e.int(r.discarded_messages);
        },
        .host_error => |r| {
            try e.key("code");
            try e.text(r.code);
            try optionalField(e, "detail", r.detail);
        },
    }
}

/// A text field a Report leaves out when it is empty.
fn optionalField(e: anytype, comptime name: []const u8, text: []const u8) Allocator.Error!void {
    if (text.len == 0) return;
    try e.key(name);
    try e.text(text);
}

fn values(e: anytype, vs: []const *Value) Allocator.Error!void {
    try e.list(vs.len);
    for (vs) |v| {
        try e.item();
        try e.value(v);
    }
    try e.endList();
}

fn effectFields(e: anytype, x: machine.report.EffectFailure) Allocator.Error!void {
    try e.key("script");
    try e.text(x.script);
    try e.key("run");
    try e.text(x.run);
    try e.key("grant");
    try e.text(x.grant);
    try e.key("segment");
    try e.text(x.segment);
    try e.key("phase");
    try e.text(x.phase);
    try e.key("status");
    try e.text(x.status);
    try optionalField(e, "scope", x.scope);
}

fn ancestryFields(e: anytype, a: machine.report.Ancestry) Allocator.Error!void {
    try e.key("rootDelivery");
    try e.text(a.root);
    try optionalField(e, "parentRun", a.parent_run);
    try optionalField(e, "parentCall", a.parent_call);
}

/// The JSON layout's Report encoder: an object led by its `kind`.
const JsonReport = struct {
    o: *Out,
    /// Whether the open container at each depth has an entry yet.
    started: [8]bool = @splat(false),
    depth: usize = 0,

    fn open(j: *JsonReport, s: []const u8) Allocator.Error!void {
        try j.o.raw(s);
        j.depth += 1;
        j.started[j.depth] = false;
    }

    fn close(j: *JsonReport, s: []const u8) Allocator.Error!void {
        j.depth -= 1;
        try j.o.raw(s);
    }

    fn entry(j: *JsonReport) Allocator.Error!void {
        if (j.started[j.depth]) try j.o.raw(",");
        j.started[j.depth] = true;
    }

    fn key(j: *JsonReport, comptime name: []const u8) Allocator.Error!void {
        const first = !j.started[j.depth];
        j.started[j.depth] = true;
        try j.o.raw(if (first) "\"" ++ name ++ "\":" else ",\"" ++ name ++ "\":");
    }

    fn text(j: *JsonReport, s: []const u8) Allocator.Error!void {
        try j.o.text(s);
    }

    fn int(j: *JsonReport, n: i128) Allocator.Error!void {
        try j.o.int(n);
    }

    fn boolean(j: *JsonReport, b: bool) Allocator.Error!void {
        try j.o.raw(if (b) "true" else "false");
    }

    fn texts(j: *JsonReport, xs: []const []const u8) Allocator.Error!void {
        try textList(j.o, xs);
    }

    fn value(j: *JsonReport, v: *const Value) Allocator.Error!void {
        try reportValue(j.o, v);
    }

    fn plain(j: *JsonReport, v: *const Value) Allocator.Error!void {
        j.o.valueWith(v, false) catch |e| switch (e) {
            error.NotEncodable => try j.o.raw("null"),
            error.OutOfMemory => return error.OutOfMemory,
        };
    }

    fn map(j: *JsonReport) Allocator.Error!void {
        try j.open("{");
    }

    fn endMap(j: *JsonReport) Allocator.Error!void {
        try j.close("}");
    }

    fn list(j: *JsonReport, _: usize) Allocator.Error!void {
        try j.open("[");
    }

    fn item(j: *JsonReport) Allocator.Error!void {
        try j.entry();
    }

    fn endList(j: *JsonReport) Allocator.Error!void {
        try j.close("]");
    }
};

/// The fields layout's Report encoder: a positional record after its tag.
const BinReport = struct {
    w: *rp.Writer,
    s: *Session,

    fn key(b: BinReport, comptime name: []const u8) Allocator.Error!void {
        try b.w.key(name);
    }

    fn text(b: BinReport, s: []const u8) Allocator.Error!void {
        try b.w.ptext(s);
    }

    fn int(b: BinReport, n: i128) Allocator.Error!void {
        try b.w.int(n);
    }

    fn boolean(b: BinReport, v: bool) Allocator.Error!void {
        try b.w.boolean(v);
    }

    fn texts(b: BinReport, xs: []const []const u8) Allocator.Error!void {
        try b.w.ptexts(xs);
    }

    fn value(b: BinReport, v: *const Value) Allocator.Error!void {
        try binValue(b.w, b.s, v, b.s.core_errors);
    }

    fn plain(b: BinReport, v: *const Value) Allocator.Error!void {
        try binValue(b.w, b.s, v, false);
    }

    fn map(b: BinReport) Allocator.Error!void {
        try b.w.begin(&.{}, false);
    }

    fn endMap(b: BinReport) Allocator.Error!void {
        try b.w.end();
    }

    fn list(b: BinReport, n: usize) Allocator.Error!void {
        try b.w.list(n);
    }

    fn item(_: BinReport) Allocator.Error!void {}

    fn endList(_: BinReport) Allocator.Error!void {}
};

fn reportKind(report: machine.report.Report) rp.Report {
    return switch (report) {
        inline else => |_, tag| @field(rp.Report, @tagName(tag)),
    };
}

fn writeReport(o: *Out, report: machine.report.Report, climbed: bool) Allocator.Error!void {
    var j: JsonReport = .{ .o = o };
    try o.raw("{\"kind\":");
    try o.text(reportKind(report).kind());
    j.started[0] = true;
    try reportFields(&j, report, climbed);
    try o.raw("}");
}

fn pumpOk(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    var o = Out.init(s.gpa);
    defer o.deinit();
    const mg = &entry.group.group;
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"state\":") catch {};
    o.text(if (mg.stoppedState()) "stopped" else if (mg.rewound) "rewound" else if (mg.sliced) "sliced" else "idle") catch {};
    o.raw(",\"nextDeadline\":") catch {};
    if (mg.nextInstant()) |at| {
        o.instant(s.gpa, at) catch return oomReply();
    } else o.raw("null") catch {};
    o.raw(",\"fuelUsed\":") catch {};
    o.int(mg.pump_fuel) catch {};
    writeReports(&o, entry) catch return oomReply();
    return finishOk(s, &o, entry);
}

/// Runs or resumes a Pump until it ends or pauses at a crossing, and
/// writes its reply.
fn runPump(s: *Session, ref: i64, entry: *GroupEntry, resuming: bool, now: model.dates.Instant, slice: u64, cap: u64) []u8 {
    if (entry.group.memory.refused) return pumpFailure(s, ref, entry, .out_of_memory);
    s.x.start(entry, .pump);
    defer s.x.stop(s.gpa);
    const mg = &entry.group.group;
    mg.observe_crossings = s.crossing_trace and entry.traced;
    // Load/change-code workers still need the sink for diagnostics when
    // Trace is disabled. A Pump has no load diagnostics: avoid formatting
    // and retaining records that finishOk would immediately discard.
    const trace = mg.trace;
    if (!entry.traced) mg.trace = null;
    defer if (!entry.traced) {
        mg.trace = trace;
    };
    // The Host names calls only by id and has heard of every retired one
    // it isn't still working on. Between Pumps every Run is live, so none
    // borrows a released id (#1322).
    if (!resuming) mg.waits.releaseRetired(mg.gpa, entry, mg.liveRuns());
    if (resuming) mg.resumePump() catch |e| return pumpFailure(s, ref, entry, talk.status(e)) else mg.pumpWith(now, slice, cap) catch |e| return pumpFailure(s, ref, entry, talk.status(e));
    entry.group.flush();
    if (mg.pumpPaused()) return pausedReply(s, ref);
    if (s.x.bin != null) return holdBinary(s, ref, entry, binaryPumpOk(s, entry) catch {
        endBinary(s);
        return oomReply();
    });
    return holdForReleases(s, ref, entry, pumpOk(s, ref, entry), .ok);
}

/// A worker paused under `ref`: its need, behind any Grant releases; the
/// crossing's Trace; or a release that was the only reason it paused, whose
/// acknowledgement resumes the worker.
fn pausedReply(s: *Session, ref: i64) []u8 {
    const entry = s.x.entry.?;
    switch (s.x.pause(ref)) {
        .need => {
            const reply = holdForReleases(s, ref, entry, needReply(s, ref), .outer);
            return if (s.crossing_trace) withTrace(s, entry, reply) else reply;
        },
        .trace => {
            var o = Out.init(s.gpa);
            defer o.deinit();
            o.raw("{\"ref\":") catch return oomReply();
            o.int(ref) catch return oomReply();
            o.raw(",\"need\":{\"m\":\"trace\"}}") catch return oomReply();
            const reply = o.finish() catch return oomReply();
            return withTrace(s, entry, withAbandoned(s, entry, reply, .outer));
        },
        .release => return releaseNeed(s, ref),
    }
}

/// Opt-in outer Trace for needs and errors. Consumed only after the complete
/// envelope is allocated; legacy final-ok Trace remains unchanged.
fn withTrace(s: *Session, entry: *GroupEntry, reply: []u8) []u8 {
    if (reply.ptr == &oom_buf or !entry.traced) return reply;
    entry.group.flush();
    return withBufferedTrace(s, entry, reply);
}

// A failed restore has already released its Group, but its Trace belongs
// to the error reply just as a successful restore's does.
fn withBufferedTrace(s: *Session, entry: *GroupEntry, reply: []u8) []u8 {
    if (reply.ptr == &oom_buf or !entry.traced or entry.pending_trace.items.len == 0) return reply;
    if (isBinNeed(reply)) {
        // The need's last field is its Trace, written Nothing.
        var w = rp.Writer.init(s.gpa);
        defer w.deinit();
        w.raw(reply[0 .. reply.len - 1]) catch return oomReply();
        binTrace(&w, entry.pending_trace.items) catch return oomReply();
        const emitted = w.finish() catch return oomReply();
        freeReply(s.gpa, reply);
        freeTrace(s.gpa, takeTrace(entry));
        return emitted;
    }
    defer freeReply(s.gpa, reply);
    var o = Out.init(s.gpa);
    defer o.deinit();
    o.raw(reply[0 .. reply.len - 1]) catch return oomReply();
    o.raw(",\"trace\":[") catch return oomReply();
    for (entry.pending_trace.items, 0..) |line, i| {
        if (i > 0) o.raw(",") catch return oomReply();
        o.text(line) catch return oomReply();
    }
    o.raw("]}") catch return oomReply();
    const emitted = o.finish() catch return oomReply();
    freeTrace(s.gpa, takeTrace(entry));
    return emitted;
}

const ReplyFields = enum { ok, outer, plain };
const HeldReply = struct {
    frame: []u8,
    entry: *GroupEntry,
    fields: ReplyFields,
    /// A binary exchange's final reply, assembled when it is sent.
    bin: ?BinFinal = null,

    pub fn deinit(h: *HeldReply, gpa: Allocator) void {
        gpa.free(h.frame);
        if (h.bin) |*b| b.deinit(gpa);
    }
};

/// Attach abandonment only to the reply being emitted, after release ordering
/// is settled. A held reply must not consume notifications before its release.
fn withAbandoned(s: *Session, entry: *GroupEntry, reply: []u8, fields: ReplyFields) []u8 {
    if (reply.ptr == &oom_buf or fields == .plain or (fields == .outer and !s.early_abandoned)) return reply;
    if (isBinNeed(reply)) {
        const emitted = binNoticed(s, entry, reply) catch return oomReply();
        freeReply(s.gpa, reply);
        entry.forgetAbandoned();
        return emitted;
    }
    defer freeReply(s.gpa, reply);
    var o = Out.init(s.gpa);
    defer o.deinit();
    // Builders close either the ok object plus its envelope, or just the
    // envelope after an interim need / error. Preserve all existing fields.
    const closes: usize = if (fields == .ok) 2 else 1;
    o.raw(reply[0 .. reply.len - closes]) catch return oomReply();
    entry.writeAbandoned(&o) catch return oomReply();
    if (s.crossing_trace) entry.writeSettled(&o) catch return oomReply();
    o.raw(reply[reply.len - closes ..]) catch return oomReply();
    const emitted = o.finish() catch return oomReply();
    entry.forgetAbandoned();
    return emitted;
}

/// Sends queued Grant releases before `reply`, holding its abandonment
/// notifications until the first reply actually reaches the Host.
fn holdForReleases(s: *Session, ref: i64, entry: *GroupEntry, reply: []u8, fields: ReplyFields) []u8 {
    if (!s.x.hold(ref, .{ .frame = reply, .entry = entry, .fields = fields })) return withAbandoned(s, entry, reply, fields);
    return releaseNeed(s, ref);
}

fn releaseNeed(s: *Session, ref: i64) []u8 {
    const r = s.x.nextRelease().*;
    if (s.callbacks) {
        const frame = binRelease(s, ref, r) catch return oomReply();
        return withAbandoned(s, s.x.releasing(), frame, .outer);
    }
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
    return withAbandoned(s, s.x.releasing(), o.finish() catch return oomReply(), .outer);
}

/// `release-result`: the next release, the held reply, or the worker that
/// paused for the releases.
fn releaseResultReply(s: *Session, ref: i64) []u8 {
    switch (s.x.releaseAcknowledged(s.gpa)) {
        .next_release => return releaseNeed(s, ref),
        .resume_worker => |r| return goOn(s, ref, r),
        .reply => |reply| {
            if (reply.bin) |fin| {
                s.gpa.free(reply.frame);
                return emitFinal(s, reply.entry, ref, fin, true);
            }
            return withAbandoned(s, reply.entry, reply.frame, reply.fields);
        },
    }
}

/// `effect-result`: `status` of `ok`, `failed` or `unknown`; anything
/// else is `unknown`, as is a malformed reply. The re-made hook takes it.
fn answerEffect(s: *Session, msg: Json, ref: i64) []u8 {
    const given = asText(field(msg, "status")) orelse "unknown";
    const status: caps.EffectStatus = if (std.mem.eql(u8, given, "ok")) .ok else if (std.mem.eql(u8, given, "failed")) .failed else .unknown;
    return resumeEffect(s, ref, status);
}

fn resumeEffect(s: *Session, ref: i64, status: caps.EffectStatus) []u8 {
    return goOn(s, ref, s.x.effectAnswered(s.gpa, status));
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
    const entry = s.x.openNeed().entry;
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
    return resumeNeed(s, ref, answer);
}

/// Hands the paused Pump its need's answer and resumes it.
fn resumeNeed(s: *Session, ref: i64, answer: Answer) []u8 {
    return goOn(s, ref, s.x.answered(s.gpa, answer));
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
    o.raw(",\"features\":[\"paused-inputs-v1\",\"abandoned-before-needs-v1\",\"crossing-trace-v1\",\"climb-v1\",\"function-gone-v1\",\"function-metadata-v1\",\"core-message-v1\",\"standard-refinements-v1\",\"restore-bindings-v1\",\"analysis-v1\",\"group-exchanges-v1\",\"object-elements-v1\",\"queued-inputs-v1\"") catch return oomReply();
    if (builtin.target.os.tag == .wasi) o.raw(",\"chunked-wasi-v1\"") catch return oomReply();
    if (s.inline_io != null) o.raw(",\"inline-inputs-v1\"") catch return oomReply();
    o.raw(",\"" ++ rp.feature_fields ++ "\",\"" ++ rp.feature_callbacks ++ "\",\"" ++ rp.feature_settlements ++ "\",\"" ++ rp.feature_load ++ "\",\"" ++ rp.feature_queue ++ "\"]") catch return oomReply();
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
// ------------------------------------------------------------ analysis-v1

/// Text names a frame lists, or an empty list for an absent field.
fn textNames(a: Allocator, j: ?Json) error{ OutOfMemory, InvalidValue }![]const []const u8 {
    const v = j orelse return &.{};
    if (v != .array) return error.InvalidValue;
    const out = try a.alloc([]const u8, v.array.items.len);
    for (v.array.items, out) |x, *name| name.* = asText(x) orelse return error.InvalidValue;
    return out;
}

fn writeProblem(o: *Out, p: analysis.Problem) Allocator.Error!void {
    try o.raw("{\"code\":");
    try o.text(p.code);
    try o.raw(",\"line\":");
    try o.int(p.line);
    try o.raw(",\"col\":");
    try o.int(p.column);
    try o.raw(if (p.incomplete) ",\"incomplete\":true" else ",\"incomplete\":false");
    try o.raw(if (p.trailing) ",\"trailing\":true}" else ",\"trailing\":false}");
}

fn writeDeclarations(o: *Out, ds: []const analysis.Declared) Allocator.Error!void {
    try o.raw("[");
    for (ds, 0..) |d, i| {
        if (i > 0) try o.raw(",");
        try o.raw("{\"kind\":");
        try o.text(d.kind);
        try o.raw(",\"name\":");
        try o.text(d.name);
        if (d.word) |x| {
            try o.raw(",\"word\":");
            try o.text(x);
        }
        try o.raw(if (d.private) ",\"private\":true" else ",\"private\":false");
        try o.raw(",\"span\":{\"start\":");
        try o.int(d.start);
        try o.raw(",\"end\":");
        try o.int(d.end);
        try o.raw(",\"line\":");
        try o.int(d.line);
        try o.raw(",\"endLine\":");
        try o.int(d.end_line);
        try o.raw("},\"signature\":");
        try o.text(d.signature);
        try o.raw(",\"doc\":");
        try o.text(d.doc);
        if (d.arity) |x| {
            try o.raw(",\"arity\":[");
            try o.int(x[0]);
            try o.raw(",");
            try o.int(x[1]);
            try o.raw("]");
        }
        if (d.initializer) |x| {
            try o.raw(",\"initializer\":");
            try o.text(x);
        }
        if (std.mem.eql(u8, d.kind, "use")) {
            try o.raw(",\"imports\":[");
            for (d.imports, 0..) |u, j| {
                if (j > 0) try o.raw(",");
                try o.raw("{\"name\":");
                try o.text(u.name);
                try o.raw(",\"local\":");
                try o.text(u.local);
                try o.raw("}");
            }
            try o.raw("]");
        }
        try o.raw("}");
    }
    try o.raw("]");
}

fn analyzeEntryReply(s: *Session, msg: Json, ref: i64) []u8 {
    var arena: std.heap.ArenaAllocator = .init(s.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    const handlers = textNames(a, field(msg, "handlers")) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    const bound = textNames(a, field(msg, "bound")) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
    const e = analysis.entry(a, source, handlers, bound) catch return hostError(s.gpa, ref, .out_of_memory);
    var o = Out.init(s.gpa);
    defer o.deinit();
    writeEntry(&o, ref, e) catch return oomReply();
    return finishOk(s, &o, null);
}

fn writeEntry(o: *Out, ref: i64, e: analysis.Entry) Allocator.Error!void {
    try beginOk(o, ref);
    try o.raw("\"kind\":");
    try o.text(@tagName(e.kind));
    try o.raw(",\"doc\":");
    try o.text(@tagName(e.doc));
    if (e.problem) |p| {
        try o.raw(",\"problem\":");
        try writeProblem(o, p);
    }
    try o.raw(",\"declarations\":");
    try writeDeclarations(o, e.declarations);
    try o.raw(",\"implicit\":");
    try textList(o, e.implicit);
}

fn analyzeSourceReply(s: *Session, msg: Json, ref: i64) []u8 {
    var arena: std.heap.ArenaAllocator = .init(s.gpa);
    defer arena.deinit();
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    const r = analysis.declarations(arena.allocator(), source) catch return hostError(s.gpa, ref, .out_of_memory);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    switch (r) {
        .declarations => |ds| {
            o.raw("\"declarations\":") catch return oomReply();
            writeDeclarations(&o, ds) catch return oomReply();
        },
        .problem => |p| {
            o.raw("\"problem\":") catch return oomReply();
            writeProblem(&o, p) catch return oomReply();
        },
    }
    return finishOk(s, &o, null);
}

fn analysisCatalogueReply(s: *Session, ref: i64) []u8 {
    var o = Out.init(s.gpa);
    defer o.deinit();
    writeCatalogue(&o, ref) catch return oomReply();
    return finishOk(s, &o, null);
}

fn writeCatalogue(o: *Out, ref: i64) Allocator.Error!void {
    try beginOk(o, ref);
    try o.raw("\"builtins\":[");
    for (analysis.builtins, 0..) |b, i| {
        if (i > 0) try o.raw(",");
        try o.raw("{\"name\":");
        try o.text(b.name);
        try o.raw(",\"call\":");
        try o.text(b.call);
        try o.raw(",\"gives\":");
        try o.text(b.gives);
        try o.raw("}");
    }
    try o.raw("],\"libraries\":[");
    for (analysis.libraries, 0..) |l, i| {
        if (i > 0) try o.raw(",");
        try o.raw("{\"name\":");
        try o.text(l.name);
        try o.raw(",\"source\":");
        try o.text(l.source);
        try o.raw("}");
    }
    try o.raw("],\"inspectReader\":");
    try o.text(analysis.inspect_reader);
}

fn messageNameReply(s: *Session, msg: Json, ref: i64) []u8 {
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const arity = asInt(field(msg, "arity")) orelse return hostError(s.gpa, ref, .invalid_value);
    if (arity < 0) return hostError(s.gpa, ref, .invalid_value);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw(if (analysis.validMessageName(name, @intCast(arity))) "\"valid\":true" else "\"valid\":false") catch return oomReply();
    return finishOk(s, &o, null);
}

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

// Adapter declarations retain their own raw-argument Host functions. Only the
// fixed factory's precharge/result/failure refinements are borrowed.
fn adapterBefore(a: Allocator, op: *const caps.Operation, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    const oc: *OpContext = @ptrCast(@alignCast(op.host.context.?));
    var translated = binding;
    if (binding) |b| {
        const ec: *EffectContext = @ptrCast(@alignCast(b));
        if (oc.standard == .locale) return standard.localeCheck(a, op, args, ec.locale orelse "und");
        if (oc.standard == .sqlite) translated = &ec.sqlite_binding;
    }
    return oc.before.?(a, op, args, translated);
}

fn adapterStandardOperation(s: *Session, capability: []const u8, which: standard.Which, j: Json) (Allocator.Error || Invalid)!caps.Operation {
    const name = asText(field(j, "name")) orelse return error.InvalidValue;
    for (standard.operations(which)) |n| {
        if (std.mem.eql(u8, n, name)) break;
    } else return error.InvalidValue;
    // Store includes the Core-only any-Quantity Shape. Other adapters retain
    // their public factory Shapes, including optional user option values.
    var op = if (which == .store) try standard.declare(s.core.gpa, which, name) else try operationOf(s, capability, j);
    errdefer releaseOp(s.core.gpa, op);
    if (which != .store) {
        var template = try standard.declare(s.core.gpa, which, name);
        const errors = op.errors;
        op.errors = template.errors;
        template.errors = errors;
        op.before = template.before;
        op.after = template.after;
        op.catalogue_errors = true;
        releaseOp(s.core.gpa, template);
    }
    op.cost = try costOf(field(j, "cost"));
    op.command = asBool(field(j, "command")) orelse false;
    const oc = if (which == .store) try newOpContext(s, capability, name) else @as(*OpContext, @ptrCast(@alignCast(op.host.context.?)));
    oc.mode = op.mode;
    oc.standard = which;
    oc.before = op.before;
    op.host = .{ .call = opCall, .context = oc };
    if (op.before != null) op.before = adapterBefore;
    return op;
}

fn defineCapabilityReply(s: *Session, msg: Json, ref: i64) []u8 {
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const wire_handle = if (field(msg, "handle")) |h| asText(h) orelse return hostError(s.gpa, ref, .invalid_value) else name;
    if (name.len == 0 or wire_handle.len == 0) return hostError(s.gpa, ref, .invalid_value);
    for (s.capability_handles.items) |h| if (std.mem.eql(u8, h.name, wire_handle)) return hostError(s.gpa, ref, .name_reused);
    const lifecycle = asBool(field(msg, "segmentLifecycle")) orelse false;
    const releasing = asBool(field(msg, "release")) orelse false;
    const ops_j = field(msg, "ops") orelse return hostError(s.gpa, ref, .invalid_value);
    if (ops_j != .array) return hostError(s.gpa, ref, .invalid_value);
    const which: ?standard.Which = if (field(msg, "standard")) |v| std.meta.stringToEnum(standard.Which, asText(v) orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value) else null;
    if (which) |w| {
        switch (w) {
            .calendar, .locale, .store, .sqlite, .user => {},
            else => return hostError(s.gpa, ref, .invalid_value),
        }
        if (ops_j.array.items.len != standard.operations(w).len) return hostError(s.gpa, ref, .invalid_value);
    }
    const a = s.core.gpa;
    const declaration_name = a.dupe(u8, name) catch return hostError(s.gpa, ref, .out_of_memory);
    var installed = false;
    defer if (!installed) a.free(declaration_name);
    const owned_handle = s.gpa.dupe(u8, wire_handle) catch return hostError(s.gpa, ref, .out_of_memory);
    defer if (!installed) s.gpa.free(owned_handle);
    s.capability_handles.ensureUnusedCapacity(s.gpa, 1) catch return hostError(s.gpa, ref, .out_of_memory);
    const ops = a.alloc(caps.Operation, ops_j.array.items.len) catch return hostError(s.gpa, ref, .out_of_memory);
    var made: usize = 0;
    for (ops_j.array.items, ops) |item, *slot| {
        slot.* = (if (which) |w| adapterStandardOperation(s, wire_handle, w, item) else operationOf(s, wire_handle, item)) catch |e| {
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
    const code = talk.defineCapabilityZigWith(s.core, wire_handle, ops, coordinator_of, release, &def);
    if (code != .ok) {
        for (ops) |op| releaseOp(a, op);
        a.free(ops);
        return hostError(s.gpa, ref, code);
    }
    a.free(def.?.name);
    def.?.name = declaration_name;
    s.capability_handles.appendAssumeCapacity(.{ .name = owned_handle, .definition = def.? });
    installed = true;
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
    if (field(msg, "locale") != null or field(msg, "maxRows") != null) {
        const ec = s.gpa.create(EffectContext) catch return hostError(s.gpa, ref, .out_of_memory);
        ec.* = .{ .session = s, .shared = if (binding) |b| @ptrCast(@alignCast(b)) else null };
        s.effect_contexts.append(s.gpa, ec) catch {
            s.gpa.destroy(ec);
            return hostError(s.gpa, ref, .out_of_memory);
        };
        if (field(msg, "locale")) |v| ec.locale = s.gpa.dupe(u8, asText(v) orelse return hostError(s.gpa, ref, .invalid_value)) catch return hostError(s.gpa, ref, .out_of_memory);
        if (field(msg, "maxRows")) |v| {
            const rows = asInt(v) orelse return hostError(s.gpa, ref, .invalid_value);
            if (rows < 0 or rows > sqlite.max_whole) return hostError(s.gpa, ref, .invalid_value);
            ec.sqlite_binding.max_rows = rows;
        }
        binding = ec;
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
    const code = createGroup(s, msg);
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    const handle_name = asText(field(msg, "group")) orelse asText(field(msg, "name")).?;
    return finishOk(s, &o, s.groupNamed(handle_name));
}

fn createGroup(s: *Session, msg: Json) talk.HostErrorCode {
    const group_handle = asText(field(msg, "group")) orelse asText(field(msg, "name")) orelse return .invalid_value;
    const name = asText(field(msg, "name")) orelse group_handle;
    if (s.groupNamed(group_handle) != null) return .name_reused;
    const entry = s.gpa.create(GroupEntry) catch return .out_of_memory;
    entry.* = .{
        .gpa = s.gpa,
        .name = s.gpa.dupe(u8, group_handle) catch {
            s.gpa.destroy(entry);
            return .out_of_memory;
        },
        .group = undefined,
        .traced = asBool(field(msg, "trace")) orelse false,
        .climb = s.climb,
        .gone = s.gone,
    };
    var group: ?*talk.Group = null;
    // No physical cap below the runtime's: over WASI the Host's store
    // limit is the backstop, as it is for the Go reactor, and the logical
    // budgets still charge every Run.
    const seed: u64 = if (field(msg, "seed")) |j| asSeed(j) orelse {
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return .invalid_value;
    } else 0;
    const options: talk.GroupOptions = .{ .name = name.ptr, .name_len = name.len, .trace = traceSink, .trace_context = entry, .memory_cap = std.math.maxInt(usize), .seed = seed };
    const code = Direct.newGroup(s.core, &options, &group);
    if (code != .ok) {
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return code;
    }
    entry.group = group.?;
    if (s.inline_inputs) {
        entry.inline_trace = .{ .session = s, .entry = entry };
        if (entry.traced) entry.group.group.trace = &entry.inline_trace.?.writer;
        entry.group.group.host_poll = inlinePoll;
        entry.group.group.host_poll_context = &entry.inline_trace.?;
    }
    s.groups.put(s.gpa, entry.name, entry) catch {
        entry.destroy();
        return .out_of_memory;
    };
    return .ok;
}

fn loadReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const name = asText(field(msg, "name")) orelse return hostError(s.gpa, ref, .invalid_value);
    const source = asText(field(msg, "source")) orelse return hostError(s.gpa, ref, .invalid_value);
    // An Object this Group never made is another Group's handle, which a
    // binding can name only by a placeholder: it is refused as wrong group.
    var foreign = false;
    const owner = if (field(msg, "owner")) |j| objectOf(entry, j) else null;
    const foreign_owner = field(msg, "owner") != null and owner == null;
    var load_objects: []talk.LoadObject = &.{};
    defer s.gpa.free(load_objects);
    var bound: usize = 0;
    if (field(msg, "objects")) |given| {
        if (given != .object) return hostError(s.gpa, ref, .invalid_value);
        load_objects = s.gpa.alloc(talk.LoadObject, given.object.count()) catch return hostError(s.gpa, ref, .out_of_memory);
        for (given.object.keys(), given.object.values()) |k, v| {
            const object = objectOf(entry, v) orelse {
                foreign = true;
                continue;
            };
            load_objects[bound] = .{ .name = k.ptr, .name_len = k.len, .object = object };
            bound += 1;
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
    const limits = limitsOf(field(msg, "limits"), &limits_slot) catch {
        entry.group.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "invalid value");
        return hostError(s.gpa, ref, .invalid_value);
    };
    // talk_load checks the owner before the bindings; a placeholder owner
    // can't reach it.
    if (foreign_owner or (foreign and !(if (owner) |ow| ow.disposed or ow.owner_of != null else false))) {
        entry.group.group.refuseWorkerWithCode(.{ .load = .{ .name = name, .source = source } }, "wrong group");
        return hostError(s.gpa, ref, .wrong_group);
    }
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
        .objects = if (bound == 0) null else load_objects.ptr,
        .objects_len = bound,
        .limits = limits,
    };
    const code = Direct.load(entry.group, &options, &script);
    entry.group.flush();
    if (code == .load_refused) {
        if (s.crossing_trace) return entryLoadError(s, ref, entry);
        const lines = takeTrace(entry);
        defer freeTrace(s.gpa, lines);
        return loadError(s.gpa, ref, lines);
    }
    if (code != .ok) {
        if (!s.crossing_trace) freeTrace(s.gpa, takeTrace(entry));
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

/// Who a queued input addresses: every Script, one Script or a Host Object.
const Target = union(enum) { all, script: *talk.Script, object: *objects.Object };

/// A message's `limits`: none, a representable override, or the sentinel
/// for one the binding can't represent, refused with the fields it read.
const Override = union(enum) { none, given: talk.LimitOverride, refused: ?machine.RefusedOverride };

/// An admitted input's owned id, or why it was refused.
const Admitted = union(enum) { id: talk.Buffer, code: talk.HostErrorCode };

fn overrideOfJson(j: ?Json) Override {
    var slot: talk.LimitOverride = undefined;
    const o = overrideOf(j, &slot) catch {
        // Any non-map override, such as `[]`, is a sentinel for one the
        // adapter can't represent; it is written as the empty override.
        var refused: machine.RefusedOverride = .{};
        if (j) |raw| if (raw == .object) {
            inline for (machine.override_fields) |f| {
                if (raw.object.get(f.ts)) |x| @field(refused, f.field) = asInt(x);
            }
        };
        return .{ .refused = refused };
    };
    return if (o) |x| .{ .given = x.* } else .none;
}

fn queuedReply(s: *Session, msg: Json, ref: i64, how: Asking) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    // A Broadcast, or a Broadcast Decision, has no `to`; otherwise `to`
    // names a Script or a Host Object, never both.
    const to_all = how == .broadcast or (how == .decide and (asBool(field(msg, "broadcast")) orelse false));
    var target: Target = .all;
    if (to_all) {
        if (field(msg, "to") != null) return hostError(s.gpa, ref, .invalid_value);
    } else {
        const to = field(msg, "to") orelse return hostError(s.gpa, ref, .invalid_value);
        if (field(to, "script")) |j| {
            if (field(to, "object") != null) return hostError(s.gpa, ref, .invalid_value);
            const script_name = asText(j) orelse return hostError(s.gpa, ref, .invalid_value);
            target = .{ .script = Direct.groupScript(entry.group, script_name.ptr, script_name.len) orelse return hostError(s.gpa, ref, .invalid_value) };
        } else {
            target = .{ .object = objectOf(entry, field(to, "object") orelse return hostError(s.gpa, ref, .invalid_value)) orelse return hostError(s.gpa, ref, .invalid_value) };
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
    var id = switch (admit(entry, .{ .how = .{ .queued = how }, .target = target, .name = mname, .args = args, .limits = overrideOfJson(field(message, "limits")) })) {
        .id => |id| id,
        .code => |code| return hostError(s.gpa, ref, code),
    };
    defer Direct.ownedBytesRelease(&id);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw(if (to_all) "\"broadcast\":" else "\"delivery\":") catch {};
    o.text(if (id.data) |d| d[0..id.len] else "") catch {};
    return finishOk(s, &o, entry);
}

/// An input that admits work, decoded from either layout: a queued
/// Delivery, Broadcast or Decision, or a Function Value call.
const Admission = struct {
    how: union(enum) { queued: Asking, call: *Value },
    target: Target = .all,
    name: []const u8 = "",
    args: []*Value,
    limits: Override,
};

fn admit(entry: *GroupEntry, a: Admission) Admitted {
    return switch (a.how) {
        .queued => |how| admitQueued(entry, how, a.target, a.name, a.args, a.limits),
        .call => |f| admitCall(entry, f, a.args, a.limits),
    };
}

/// Admits a Delivery, Request, Decision or Broadcast with the ordinary
/// checks and records, whichever frame carried it.
fn admitQueued(entry: *GroupEntry, how: Asking, target: Target, mname: []const u8, args: []*Value, limits: Override) Admitted {
    var override_slot: talk.LimitOverride = undefined;
    const override: ?*talk.LimitOverride = switch (limits) {
        .none => null,
        .given => |o| blk: {
            override_slot = o;
            break :blk &override_slot;
        },
        .refused => |refused| {
            if (target == .all) {
                entry.group.group.refuseBroadcast(mname, args, how == .decide, refused, "invalid value");
            } else if (how != .broadcast) {
                const d: machine.Delivery = .{ .id = 0, .message = mname, .args = args, .request = how == .request, .decision = how == .decide, .target = if (target == .object) target.object else null };
                entry.group.group.refuseOverride(if (target == .script) target.script.name else "", d, refused, "invalid value");
            }
            return .{ .code = .invalid_value };
        },
    };
    const m: talk.Message = .{ .name = mname.ptr, .name_len = mname.len, .args = if (args.len == 0) null else args.ptr, .args_len = args.len, .limits = override };
    var id: talk.Buffer = .{};
    // Pending Requests and Decisions belong to the Group, which reports
    // how they end; the handles aren't needed here.
    var pending: ?*talk.Pending = null;
    var deciding: ?*talk.Deciding = null;
    const code = switch (how) {
        .deliver => switch (target) {
            .script => |sc| Direct.scriptDeliver(sc, &m, &id),
            .object => |o| Direct.deliver(entry.group, o, &m, &id),
            .all => unreachable,
        },
        .request => switch (target) {
            .script => |sc| Direct.scriptRequest(sc, &m, &id, &pending),
            .object => |o| Direct.request(entry.group, o, &m, &id, &pending),
            .all => unreachable,
        },
        .decide => switch (target) {
            .all => Direct.decideBroadcast(entry.group, &m, &id, &deciding),
            .script => |sc| Direct.scriptDecide(sc, &m, &id, &deciding),
            .object => |o| Direct.decide(entry.group, o, &m, &id, &deciding),
        },
        .broadcast => Direct.broadcast(entry.group, &m, &id),
    };
    if (code != .ok) return .{ .code = code };
    // Nothing reads a Request's result through its handle here.
    Direct.pendingRelease(pending);
    return .{ .id = id };
}

fn pumpReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    endBinary(s);
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
    // A released call's answer is queued by id and ignored at drain, as a
    // retained one's is (#1322).
    var late: caps.Call = undefined;
    const c = entry.group.group.callById(call_id) orelse blk: {
        if (!entry.group.group.issued(call_id)) return hostError(s.gpa, ref, .unknown_call);
        late = .{ .id = call_id, .script = "", .grant = "", .binding = null, .now = .{ .seconds = 0, .micros = 0 }, .left = null, .group = &entry.group.group, .gpa = entry.group.group.gpa };
        break :blk &late;
    };
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
        const fuel = if (field(msg, "fuel")) |f| asInt(f) orelse return hostError(s.gpa, ref, .invalid_value) else 0;
        if (fuel < 0 or fuel > 9_007_199_254_740_991) return hostError(s.gpa, ref, .invalid_value);
        break :blk Direct.callAnswerWithCost(c, v, fuel);
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
    // Its Object Collection, only after `object-elements-v1` (#1143).
    var elements: ?objects.Elements = null;
    if (field(msg, "elements")) |e| if (e != .null) {
        if (!s.object_elements) return protocolError(s.gpa, ref, "an Object Collection needs object-elements-v1");
        if (e != .object) return hostError(s.gpa, ref, .invalid_value);
        const count_cost = costOf(field(e, "countCost") orelse return hostError(s.gpa, ref, .invalid_value)) catch return hostError(s.gpa, ref, .invalid_value);
        const at_cost = costOf(field(e, "atCost") orelse return hostError(s.gpa, ref, .invalid_value)) catch return hostError(s.gpa, ref, .invalid_value);
        const find_cost = costOf(field(e, "findCost") orelse return hostError(s.gpa, ref, .invalid_value)) catch return hostError(s.gpa, ref, .invalid_value);
        const shape = shapeOf(a, field(e, "shape") orelse return hostError(s.gpa, ref, .invalid_value), 0) catch return hostError(s.gpa, ref, .invalid_value);
        if (!objects.validElementShape(shape)) {
            shape.release();
            return hostError(s.gpa, ref, .invalid_value);
        }
        const pc = s.gpa.create(PropContext) catch {
            shape.release();
            return hostError(s.gpa, ref, .out_of_memory);
        };
        pc.* = .{ .session = s, .kind = s.gpa.dupe(u8, name) catch "", .prop = s.gpa.dupe(u8, "elements") catch "" };
        s.prop_contexts.append(s.gpa, pc) catch {
            shape.release();
            return hostError(s.gpa, ref, .out_of_memory);
        };
        elements = .{ .shape = shape, .count = elementCount, .at = elementAt, .find = elementFind, .context = pc, .count_cost = count_cost, .at_cost = at_cost, .find_cost = find_cost };
    };
    const kind = a.create(objects.Kind) catch return hostError(s.gpa, ref, .out_of_memory);
    kind.* = .{ .name = a.dupe(u8, name) catch return hostError(s.gpa, ref, .out_of_memory), .props = props, .parent_kinds = parents, .elements = elements };
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
        if (s.crossing_trace) return entryLoadError(s, ref, entry);
        const lines = takeTrace(entry);
        defer freeTrace(s.gpa, lines);
        return loadError(s.gpa, ref, lines);
    }
    if (code != .ok) {
        if (!s.crossing_trace) freeTrace(s.gpa, takeTrace(entry));
        return hostError(s.gpa, ref, code);
    }
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return holdForReleases(s, ref, entry, finishOk(s, &o, entry), .plain);
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
                const command = if (field(decl, "command")) |b| asBool(b) orelse return hostError(s.gpa, ref, .invalid_value) else false;
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
                const labels = labelsOf(a, field(decl, "labels")) catch |e| return hostError(s.gpa, ref, if (e == error.OutOfMemory) .out_of_memory else .invalid_value);
                const label_ptrs = a.alloc(?[*]const u8, labels.len) catch return hostError(s.gpa, ref, .out_of_memory);
                const label_lens = a.alloc(usize, labels.len) catch return hostError(s.gpa, ref, .out_of_memory);
                for (labels, label_ptrs, label_lens) |l, *x, *n| {
                    x.* = l.ptr;
                    n.* = l.len;
                }
                slot.* = .{ .name = op.ptr, .name_len = op.len, .mode = std.meta.stringToEnum(talk.Mode, @tagName(mode)).?, .args = args.ptr, .args_len = args.len, .command = command, .labels = label_ptrs.ptr, .labels_lens = label_lens.ptr, .labels_len = labels.len };
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
        return holdForReleases(s, ref, entry, finishOk(s, &o, entry), .plain);
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
    s.x.start(entry, .work);
    defer s.x.stop(s.gpa);
    const outcome: machine.Group.Resumed = switch (work) {
        .reload => |x| .{ .reload = mg.reload(x.script, x.source, x.carry, x.keep_mailbox) catch |e| {
            entry.group.flush();
            return workError(s, ref, entry, talk.status(e));
        } },
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
    if (paused) return pausedReply(s, ref);
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
    o.climbed = entry.climb;
    writeHeld(&o, &held) catch return oomReply();
    return holdForReleases(s, ref, entry, finishOk(s, &o, entry), .ok);
}

fn workRefused(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    // As a refused Load: the error reply publishes its diagnostic records.
    if (s.crossing_trace) return entryLoadError(s, ref, entry);
    const lines = takeTrace(entry);
    defer freeTrace(s.gpa, lines);
    return loadError(s.gpa, ref, lines);
}

fn workError(s: *Session, ref: i64, entry: *GroupEntry, code: talk.HostErrorCode) []u8 {
    // The error reply publishes its refusal records to an opted-in Host.
    if (!s.crossing_trace) freeTrace(s.gpa, takeTrace(entry));
    return holdForReleases(s, ref, entry, hostError(s.gpa, ref, code), .outer);
}

/// The paused Reload or library replacement goes on, or else the paused
/// Pump.
fn goOn(s: *Session, ref: i64, r: Exchange.Resume) []u8 {
    return switch (r.worker) {
        .work => runWork(s, ref, r.entry, .resumed),
        .pump => runPump(s, ref, r.entry, true, .{ .seconds = 0, .micros = 0 }, 0, 0),
    };
}

/// `talk.ts`'s CarryOver text.
fn carryOf(j: ?Json) ?talk.CarryOver {
    const given = asText(j) orelse return null;
    if (std.mem.eql(u8, given, "carry variables")) return .carry_variables;
    if (std.mem.eql(u8, given, "reset variables")) return .reset_variables;
    return null;
}

/// Reads the input queue without a vars snapshot, Trace or execution.
fn queuedInputsReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw(if (entry.group.group.inputs.items.len > 0) "\"queued\":true" else "\"queued\":false") catch return oomReply();
    return finishOk(s, &o, null);
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
                    try o.instant(gpa, .{ .seconds = r.until_seconds, .micros = r.until_micros });
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
    var probe: GroupEntry = .{ .gpa = s.gpa, .name = &.{}, .group = undefined, .traced = asBool(field(msg, "trace")) orelse false };
    defer freeTrace(s.gpa, takeTrace(&probe));
    const options: talk.RestoreOptions = .{ .name = handle_name.ptr, .name_len = handle_name.len, .trace = traceSink, .trace_context = &probe, .libraries = request.libraries.ptr, .libraries_len = request.libraries.len, .grants = Resolving.rebind, .grants_context = &resolving, .resolve = Resolving.resolve, .resolve_context = &resolving, .mismatch = request.mismatch, .allocator = null, .memory_cap = std.math.maxInt(usize) };
    const code = Direct.restore(s.core, request.save.ptr, request.save.len, &options, &group, &result);
    Direct.restoreResultRelease(result);
    if (group) |g| Direct.groupRelease(g);
    if (resolving.oom) {
        resolving.deinit();
        return hostError(s.gpa, ref, .out_of_memory);
    }
    if (code != .ok) {
        resolving.deinit();
        return restoreError(s, &probe, ref, code);
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
    const parsed = std.json.parseFromSlice(Json, s.gpa, restoring.frame, .{ .parse_numbers = false, .max_value_len = restoring.frame.len }) catch return hostError(s.gpa, ref, .out_of_memory);
    defer parsed.deinit();
    return restoreWith(s, parsed.value, ref, r);
}

// Restore failures have no retained Group for handle() to find. Preserve
// their records here, including failures rejected before a restore record.
fn restoreError(s: *Session, entry: *GroupEntry, ref: i64, code: talk.HostErrorCode) []u8 {
    if (entry.traced and (entry.pending_trace.items.len == 0 or !std.mem.startsWith(u8, entry.pending_trace.items[entry.pending_trace.items.len - 1], "refused "))) {
        const line = std.fmt.allocPrint(s.gpa, "refused code=\"{s}\"", .{talk.hostCodeName(code)}) catch return oomReply();
        entry.pending_trace.append(s.gpa, line) catch {
            s.gpa.free(line);
            return oomReply();
        };
    }
    return withBufferedTrace(s, entry, hostError(s.gpa, ref, code));
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
    }, .group = undefined, .traced = asBool(field(msg, "trace")) orelse false, .climb = s.climb, .gone = s.gone };
    var group: ?*talk.Group = null;
    var result: ?*talk.RestoreResult = null;
    const options: talk.RestoreOptions = .{ .name = name.ptr, .name_len = name.len, .trace = traceSink, .trace_context = entry, .libraries = request.libraries.ptr, .libraries_len = request.libraries.len, .grants = Resolving.rebind, .grants_context = r, .resolve = Resolving.resolve, .resolve_context = r, .mismatch = request.mismatch, .allocator = null, .memory_cap = std.math.maxInt(usize) };
    const code = Direct.restore(s.core, request.save.ptr, request.save.len, &options, &group, &result);
    if (code != .ok) {
        const reply = restoreError(s, entry, ref, code);
        for (entry.pending_trace.items) |line| s.gpa.free(line);
        entry.pending_trace.deinit(s.gpa);
        s.gpa.free(entry.name);
        s.gpa.destroy(entry);
        return reply;
    }
    defer Direct.restoreResultRelease(result);
    entry.group = group.?;
    if (s.inline_inputs) {
        entry.inline_trace = .{ .session = s, .entry = entry };
        if (entry.traced) entry.group.group.trace = &entry.inline_trace.?.writer;
        entry.group.group.host_poll = inlinePoll;
        entry.group.group.host_poll_context = &entry.inline_trace.?;
    }
    s.groups.put(s.gpa, entry.name, entry) catch {
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
    // Host wrappers need handles for Scripts without pending Calls, and
    // Objects which were already disposed (and so needed no resolution).
    try o.raw("\"scripts\":[");
    for (entry.group.group.scripts.items, 0..) |script, i| {
        if (i > 0) try o.raw(",");
        try o.text(script.name);
    }
    try o.raw("],\"objects\":[");
    for (entry.group.group.objects.items, 0..) |object, i| {
        if (i > 0) try o.raw(",");
        try o.raw("[");
        try o.text(object.kind.name);
        try o.raw(",");
        try o.text(object.id);
        try o.raw("]");
    }
    try o.raw("],\"variablesOnly\":");
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
        if (entry.group.group.callById(id)) |c| {
            for (c.args, 0..) |v, k| {
                if (k > 0) try o.raw(",");
                try o.value(v);
            }
        }
        try o.raw("]");
        if (entry.group.group.callById(id)) |c| {
            if (entry.group.group.script(c.script)) |script| if (script.grant(c.grant)) |grant| {
                try o.raw(",\"capability\":");
                try o.text(grant.grant.capability.name);
            };
            try o.raw(",\"run\":");
            try o.text(c.run);
            try o.raw(",\"segment\":");
            try o.text(c.segment);
            try o.raw(",\"now\":");
            try o.instant(entry.gpa, c.now);
        }
        try o.raw("}");
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
    o.climbed = entry.climb;
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
    var id = switch (admit(entry, .{ .how = .{ .call = f }, .args = args.items, .limits = overrideOfJson(field(msg, "limits")) })) {
        .id => |id| id,
        .code => |code| return hostError(s.gpa, ref, code),
    };
    defer Direct.ownedBytesRelease(&id);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"delivery\":") catch {};
    o.text(if (id.data) |d| d[0..id.len] else "") catch {};
    return finishOk(s, &o, entry);
}

/// Admits a Function call with the ordinary checks and records. Staleness
/// is found at the drain, and arity when it runs.
fn admitCall(entry: *GroupEntry, f: *Value, args: []*Value, limits: Override) Admitted {
    var override_slot: talk.LimitOverride = undefined;
    const override: ?*talk.LimitOverride = switch (limits) {
        .none => null,
        .given => |o| blk: {
            override_slot = o;
            break :blk &override_slot;
        },
        .refused => |refused| {
            // The sentinel for an override the binding can't represent.
            entry.group.group.refuseCall(f, args, refused, "invalid value");
            return .{ .code = .invalid_value };
        },
    };
    var id: talk.Buffer = .{};
    var pending: ?*talk.Pending = null;
    const code = Direct.call(entry.group, f, args.ptr, args.len, override, &id, &pending);
    if (code != .ok) return .{ .code = code };
    Direct.pendingRelease(pending);
    return .{ .id = id };
}

/// `export-manifest`: `kind`, `version`, `grants` (`{name: handle}`),
/// `libraries` (identities), `messages` (`[{name, args, receivers,
/// description?, examples?}]`),
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
            const description = if (field(item, "description")) |d| asText(d) orelse return error.InvalidValue else "";
            const examples_json = field(item, "examples") orelse Json{ .array = .init(a) };
            if (examples_json != .array) return error.InvalidValue;
            const examples = try a.alloc(?[*]const u8, examples_json.array.items.len);
            const examples_lens = try a.alloc(usize, examples_json.array.items.len);
            for (examples_json.array.items, examples, examples_lens) |e, *x, *n| {
                const text = asText(e) orelse return error.InvalidValue;
                x.* = text.ptr;
                n.* = text.len;
            }
            slot.* = .{ .name = name.ptr, .name_len = name.len, .args = args.ptr, .args_len = args.len, .receivers = receivers.ptr, .receivers_len = receivers.len, .description = description.ptr, .description_len = description.len, .examples = examples.ptr, .examples_lens = examples_lens.ptr, .examples_len = examples.len };
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

/// Current Script/extension sources and their transitive Library sources.
fn scriptUnitsReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const script = scriptOf(entry, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const home = entry.group.group.script(script.name) orelse return hostError(s.gpa, ref, .invalid_value);
    var libraries: std.ArrayList(*machine.Library) = .empty;
    defer libraries.deinit(s.gpa);
    libraries.appendSlice(s.gpa, home.extensions.items) catch return oomReply();
    libraries.appendSlice(s.gpa, home.imports) catch return oomReply();
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    o.raw("\"units\":[") catch return oomReply();
    writeSourceUnit(&o, s.gpa, home.name, home.source, machine.codeIdentity(home.name, home.source, .script, home.imports)) catch return oomReply();
    var i: usize = 0;
    while (i < libraries.items.len) : (i += 1) {
        const library = libraries.items[i];
        o.raw(",") catch return oomReply();
        writeSourceUnit(&o, s.gpa, library.name, library.source, library.identity) catch return oomReply();
        for (library.imports) |imported| {
            if (std.mem.indexOfScalar(*machine.Library, libraries.items, imported) == null) libraries.append(s.gpa, imported) catch return oomReply();
        }
    }
    o.raw("]") catch return oomReply();
    // This query observes source only: no vars snapshot, Trace or execution.
    return finishOk(s, &o, null);
}

fn writeSourceUnit(o: *Out, gpa: Allocator, name: []const u8, source: []const u8, identity: [32]u8) Allocator.Error!void {
    try o.raw("{\"name\":");
    try o.text(name);
    try o.raw(",\"source\":");
    try o.text(source);
    try o.raw(",\"identity\":");
    try o.bytesTag(gpa, &identity);
    try o.raw("}");
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
    s.reply_error = false;
    const previous_ref = s.active_ref;
    defer s.active_ref = previous_ref;
    // The binary prefix is not JSON: identify it before UTF-8 or JSON.
    if (std.mem.startsWith(u8, frame, rp.prefix[0..3])) return handleBinary(s, frame);
    const reply = handleFrame(s, frame);
    if (!s.crossing_trace or !s.reply_error) return reply;
    // Errors retain the records made by the refused Host Input. Callback
    // records held in the machine are still held until their crossing returns.
    const parsed = std.json.parseFromSlice(Json, s.gpa, frame, .{ .parse_numbers = false, .max_value_len = frame.len }) catch return reply;
    defer parsed.deinit();
    const entry = groupOf(s, parsed.value) orelse return reply;
    return withTrace(s, entry, reply);
}

fn handleFrame(s: *Session, frame: []const u8) []u8 {
    handling = s;
    defer handling = null;
    if (!std.unicode.utf8ValidateSlice(frame)) return protocolError(s.gpa, 0, "the frame is not UTF-8");
    const parsed = std.json.parseFromSlice(Json, s.gpa, frame, .{ .parse_numbers = false, .max_value_len = frame.len }) catch |e| return if (e == error.OutOfMemory) oomReply() else protocolError(s.gpa, 0, "the frame is not JSON");
    defer parsed.deinit();
    const msg = parsed.value;
    if (msg != .object) return protocolError(s.gpa, 0, "the frame is not an object");
    const ref = asInt(field(msg, "ref")) orelse return protocolError(s.gpa, 0, "no ref");
    const m = asText(field(msg, "m")) orelse return protocolError(s.gpa, ref, "no message name");
    return handleMessage(s, msg, ref, m, frame);
}

fn handleMessage(s: *Session, msg: Json, ref: i64, m: []const u8, frame: []const u8) []u8 {
    s.active_ref = ref;
    if (s.group_exchanges and s.restoring == null) {
        // Each Group's exchange gates only that Group's frames. A frame
        // naming no Group, or one not made yet, waits on no exchange.
        if (groupOf(s, msg)) |entry| {
            loadExchange(s, entry);
        } else if (std.mem.eql(u8, m, "restore") and anyExchangeOpen(s)) {
            return protocolError(s.gpa, ref, "a Group's exchange is open");
        } else if (!messageIn(m, &.{ "op-result", "prop-result", "effect-result", "trace-result", "release-result", "resolve-result" })) {
            return dispatch(s, msg, ref, m, frame);
        }
    }
    if (s.restoring) |r| {
        // Binding callbacks may declare and select a fresh Grant before
        // answering. No Group work is admitted into the restore.
        if (ref != r.ref and std.mem.eql(u8, m, "define-capability")) return defineCapabilityReply(s, msg, ref);
        if (ref != r.ref and std.mem.eql(u8, m, "grant")) return grantReply(s, msg, ref);
        if (ref != r.ref or !std.mem.eql(u8, m, "resolve-result")) return protocolError(s.gpa, ref, "a restore is waiting for its resolve-result");
        return resolveResultReply(s, msg, ref);
    }
    switch (s.x.gate(ref, jsonFrame(m), .json)) {
        .dispatch => {},
        .admit => |worker_ref| return pausedAdmission(s, msg, ref, m, s.x.paused(worker_ref)),
        .refuse => |why| return protocolError(s.gpa, ref, refusalDetail(why)),
        .result => |kind| return if (kind == .effect) answerEffect(s, msg, ref) else answerNeed(s, msg, ref, kind == .prop),
        .trace_result => return goOn(s, ref, s.x.traceTaken()),
        .release_result => return releaseResultReply(s, ref),
    }
    // The binding may have refused a worker while this export was still
    // running, then reached this boundary before servicing its queued frame.
    if (s.inline_inputs and (asBool(field(msg, "refuseWorker")) orelse false)) {
        const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
        if (!messageIn(m, &.{ "load", "reload", "extend", "add-library", "replace-library", "pump", "save", "fingerprint", "inspect", "grants", "counters" })) return protocolError(s.gpa, ref, "refuseWorker requires a worker message");
        recordWorkerRefusal(s, entry, msg, m);
        return hostError(s.gpa, ref, .reentrant_call);
    }
    return dispatch(s, msg, ref, m, frame);
}

fn dispatch(s: *Session, msg: Json, ref: i64, m: []const u8, frame: []const u8) []u8 {
    if (std.mem.eql(u8, m, "hello")) {
        if ((asInt(field(msg, "protocol")) orelse -1) != protocol_version) return protocolError(s.gpa, ref, "unknown protocol");
        if (field(msg, "features")) |features| {
            if (features != .array) return protocolError(s.gpa, ref, "features must be text names");
            var early = s.early_abandoned;
            var crossing_trace = s.crossing_trace;
            var climb = s.climb;
            var gone = s.gone;
            var function_metadata = s.function_metadata;
            var core_errors = s.core_errors;
            var inline_inputs = s.inline_inputs;
            var chunked_wasi = s.chunked_wasi;
            var analyses = s.analysis;
            var group_exchanges = s.group_exchanges;
            var object_elements = s.object_elements;
            var queued_inputs = s.queued_inputs;
            var request_pump = s.request_pump;
            var callbacks = s.callbacks;
            var settlements = s.settlements;
            var load_fields = s.load_fields;
            var queue_fields = s.queue_fields;
            for (features.array.items) |feature| {
                const name = asText(feature) orelse return protocolError(s.gpa, ref, "features must be text names");
                if (std.mem.eql(u8, name, rp.feature_fields)) {
                    // It does not imply `binary-frames-v1`, which this Core lacks.
                    request_pump = true;
                } else if (std.mem.eql(u8, name, rp.feature_load)) {
                    load_fields = true;
                } else if (std.mem.eql(u8, name, rp.feature_callbacks)) {
                    callbacks = true;
                } else if (std.mem.eql(u8, name, rp.feature_settlements)) {
                    settlements = true;
                } else if (std.mem.eql(u8, name, rp.feature_queue)) {
                    queue_fields = true;
                } else if (std.mem.eql(u8, name, "abandoned-before-needs-v1")) {
                    early = true;
                } else if (std.mem.eql(u8, name, "crossing-trace-v1")) {
                    crossing_trace = true;
                } else if (std.mem.eql(u8, name, "climb-v1")) {
                    climb = true;
                } else if (std.mem.eql(u8, name, "function-gone-v1")) {
                    gone = true;
                } else if (std.mem.eql(u8, name, "function-metadata-v1")) {
                    function_metadata = true;
                } else if (std.mem.eql(u8, name, "core-message-v1")) {
                    core_errors = true;
                } else if (std.mem.eql(u8, name, "analysis-v1")) {
                    analyses = true;
                } else if (std.mem.eql(u8, name, "group-exchanges-v1")) {
                    group_exchanges = true;
                } else if (std.mem.eql(u8, name, "queued-inputs-v1")) {
                    queued_inputs = true;
                } else if (std.mem.eql(u8, name, "object-elements-v1")) {
                    object_elements = true;
                } else if (std.mem.eql(u8, name, "chunked-wasi-v1") and builtin.target.os.tag == .wasi) {
                    chunked_wasi = true;
                } else if (std.mem.eql(u8, name, "inline-inputs-v1") and s.inline_io != null) {
                    inline_inputs = true;
                } else if (std.mem.eql(u8, name, "standard-refinements-v1")) {
                    // This feature adds declaration and binding fields, with no per-Group state.
                } else if (!std.mem.eql(u8, name, "paused-inputs-v1") and !std.mem.eql(u8, name, "restore-bindings-v1")) return protocolError(s.gpa, ref, "unsupported feature");
            }
            if (settlements and !request_pump) return protocolError(s.gpa, ref, "settlements-fields-v1 needs request-pump-fields-v1");
            if (queue_fields and !request_pump) return protocolError(s.gpa, ref, "queue-fields-v1 needs request-pump-fields-v1");
            s.request_pump = request_pump;
            s.callbacks = callbacks;
            s.settlements = settlements;
            s.load_fields = load_fields;
            s.queue_fields = queue_fields;
            s.early_abandoned = early;
            s.crossing_trace = crossing_trace;
            s.climb = climb;
            s.gone = gone;
            s.function_metadata = function_metadata;
            s.core_errors = core_errors;
            s.inline_inputs = inline_inputs;
            s.chunked_wasi = chunked_wasi;
            s.analysis = analyses;
            s.group_exchanges = group_exchanges;
            s.object_elements = object_elements;
            s.queued_inputs = queued_inputs;
        }
        return helloReply(s, ref);
    } else if (std.mem.eql(u8, m, "add")) {
        return addReply(s, msg, ref);
    } else if (s.analysis and std.mem.eql(u8, m, "analyze-entry")) {
        return analyzeEntryReply(s, msg, ref);
    } else if (s.analysis and std.mem.eql(u8, m, "analyze-source")) {
        return analyzeSourceReply(s, msg, ref);
    } else if (s.analysis and std.mem.eql(u8, m, "analysis-catalogue")) {
        return analysisCatalogueReply(s, ref);
    } else if (s.analysis and std.mem.eql(u8, m, "message-name")) {
        return messageNameReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "define-capability")) {
        return defineCapabilityReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "grant")) {
        return grantReply(s, msg, ref);
    } else if (std.mem.eql(u8, m, "new-group")) {
        return newGroupReply(s, msg, ref);
    } else if (s.group_exchanges and std.mem.eql(u8, m, "drop-group")) {
        return dropGroupReply(s, msg, ref);
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
    } else if (s.function_metadata and std.mem.eql(u8, m, "script-units")) {
        return scriptUnitsReply(s, msg, ref);
    } else if (s.queued_inputs and std.mem.eql(u8, m, "queued-inputs")) {
        return queuedInputsReply(s, msg, ref);
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
    } else if (s.request_pump and std.mem.eql(u8, m, "cancel-correlated")) {
        return cancelCorrelatedReply(s, msg, ref);
    }
    return protocolError(s.gpa, ref, "unknown or unsupported message");
}

/// A JSON frame as an exchange's gate sees it.
fn jsonFrame(m: []const u8) exchange.Frame {
    const results = [_]struct { []const u8, exchange.Result }{
        .{ "op-result", .op },
        .{ "prop-result", .prop },
        .{ "effect-result", .effect },
        .{ "trace-result", .trace },
        .{ "release-result", .release },
    };
    for (results) |r| if (std.mem.eql(u8, m, r[0])) return .{ .result = r[1] };
    return .input;
}

/// A refused frame's protocol error detail, in either layout.
fn refusalDetail(why: exchange.Refusal) []const u8 {
    return switch (why) {
        .kind_mismatch => "the result does not match the need",
        .result_pending => "a Pump is waiting for its result",
        .trace_pending => "a crossing is waiting for trace-result",
        .release_pending => "a Grant release is waiting for its release-result",
        .wrong_ref, .reserved_ref => "the worker ref is reserved for its result",
        .not_open => "unknown or unsupported message",
        .no_worker => "no paused worker",
        .other_group => "a paused input must address the worker's Group",
        .not_admitted => "a worker is waiting for its result",
    };
}

fn messageIn(m: []const u8, names: []const []const u8) bool {
    for (names) |name| if (std.mem.eql(u8, m, name)) return true;
    return false;
}

/// Loads `entry`'s exchange into `s.x`, parking the one loaded before
/// in its own Group's entry.
fn loadExchange(s: *Session, entry: *GroupEntry) void {
    const owner = s.x_owner orelse s.x.entry;
    if (owner != entry) {
        // With no owner the loaded exchange has never been used.
        if (owner) |o| o.parked = s.x;
        s.x = entry.parked;
        entry.parked = .{};
    }
    s.x_owner = entry;
}

fn anyExchangeOpen(s: *Session) bool {
    if (s.x.open()) return true;
    for (s.groups.values()) |e| if (e.parked.open()) return true;
    return false;
}

/// `drop-group`: frees a Group with no open exchange, running nothing.
fn dropGroupReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    if (s.x_owner == entry) {
        if (s.x.open()) return protocolError(s.gpa, ref, "the Group's exchange is open");
        s.x.deinit(s.gpa);
        s.x_owner = null;
    }
    _ = s.groups.swapRemove(entry.name);
    unbindGroup(s, entry);
    entry.destroy();
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, null);
}

const PausedWorker = exchange.Paused(*GroupEntry);

fn pausedAdmission(s: *Session, msg: Json, ref: i64, m: []const u8, paused: PausedWorker) []u8 {
    const input: exchange.Input = if (messageIn(m, &.{ "load", "reload", "extend", "add-library", "replace-library", "pump", "save", "fingerprint", "inspect", "grants", "counters" }))
        .worker
    else if (messageIn(m, &.{ "deliver", "request", "broadcast", "decide", "call", "set-parent", "dispose", "stop", "cancel-run", "rewind-run", "revoke", "answer", "fail", "cancel-delivery", "cancel-correlated", "queued-inputs", "request-charge", "settle", "object" }))
        .admitted
    else
        .other;
    switch (paused.admission(ref, groupOf(s, msg), input)) {
        .refuse => |why| return protocolError(s.gpa, ref, refusalDetail(why)),
        .refuse_worker => |entry| {
            const held = enterPaused(s, entry, paused.worker);
            defer leavePaused(s, held);
            recordWorkerRefusal(s, entry, msg, m);
            return hostError(s.gpa, ref, .reentrant_call);
        },
        .admit => |entry| {
            const held = enterPaused(s, entry, paused.worker);
            defer leavePaused(s, held);
            return dispatch(s, msg, ref, m, &.{});
        },
    }
}

/// What admission during a paused worker changes, to restore after it.
const Paused = struct { entry: *GroupEntry, pumping: bool, trace: ?*std.Io.Writer, old_inline: bool };

/// A WASM export has returned, but its Host callback has not. Admission
/// must use the same control queue and Trace hold as native callbacks.
fn enterPaused(s: *Session, entry: *GroupEntry, worker: exchange.Worker) Paused {
    const mg = &entry.group.group;
    const held: Paused = .{ .entry = entry, .pumping = mg.pumping, .trace = mg.trace, .old_inline = mg.inline_admitting };
    mg.pumping = worker == .pump;
    mg.holdCallbackTrace(held.trace, !s.inline_active);
    s.admitting = true;
    mg.inline_admitting = s.inline_active;
    return held;
}

fn leavePaused(s: *Session, held: Paused) void {
    const mg = &held.entry.group.group;
    mg.inline_admitting = held.old_inline;
    s.admitting = false;
    mg.pumping = held.pumping;
    mg.trace = held.trace;
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

// ------------------------------------- binary Request/Pump exchanges (#1245)

/// A binary exchange; a combined one's delivery and token, which its
/// final reply carries and then retires.
const BinExchange = struct {
    delivery: ?[]u8 = null,
    token: u64 = 0,

    /// Frees its delivery; the Session's binding of its token stays.
    pub fn deinit(b: *BinExchange, gpa: Allocator) void {
        if (b.delivery) |d| gpa.free(d);
    }
};

/// A binary final Pump reply's parts, assembled with its abandonment
/// notices only when it is sent. `ok` is the completion's state … gone
/// items.
const BinFinal = struct {
    ok: ?[]u8 = null,
    err: ?[]u8 = null,
    trace: ?[]u8 = null,

    fn deinit(f: *BinFinal, gpa: Allocator) void {
        for ([_]?[]u8{ f.ok, f.err, f.trace }) |b| if (b) |x| gpa.free(x);
        f.* = .{};
    }
};

/// A combined exchange's token, bound to its admitted delivery.
const Binding = struct { token: u64, entry: *GroupEntry, delivery: []u8 };

fn bindingOf(s: *Session, token: u64) ?usize {
    for (s.bindings.items, 0..) |b, i| if (b.token == token) return i;
    return null;
}

/// Forgets a Group's bindings when the Group is dropped.
fn unbindGroup(s: *Session, entry: *GroupEntry) void {
    var i: usize = 0;
    while (i < s.bindings.items.len) {
        if (s.bindings.items[i].entry == entry) {
            s.gpa.free(s.bindings.orderedRemove(i).delivery);
        } else i += 1;
    }
}

/// Ends the loaded binary exchange, retiring its token.
fn endBinary(s: *Session) void {
    const b = s.x.bin orelse return;
    s.x.bin = null;
    if (b.token != 0) if (bindingOf(s, b.token)) |i| s.gpa.free(s.bindings.orderedRemove(i).delivery);
    if (b.delivery) |d| s.gpa.free(d);
}

fn binOptions(s: *Session, core_errors: bool) binary_value.EncodeOptions {
    return .{ .functions = .{ .context = s, .payload = functionPayload }, .core_errors = core_errors, .function_metadata = s.function_metadata };
}

/// The binary Function payload: home, display and token, then under
/// `function-metadata-v1` name, arity and the raw source identity.
fn functionPayload(context: ?*anyopaque, a: Allocator, v: *const Value) anyerror!*Value {
    const s: *Session = @ptrCast(@alignCast(context.?));
    const t = functionToken(s, v) catch |e| return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    defer s.gpa.free(t.token);
    const f = v.data.function;
    var items: [7]*Value = undefined;
    var n: usize = 0;
    defer for (items[0..n]) |x| x.release();
    items[n] = try model.text(a, f.home);
    n += 1;
    items[n] = try model.text(a, f.display);
    n += 1;
    items[n] = try model.text(a, t.token);
    n += 1;
    if (s.function_metadata) {
        const code = t.entry.group.group.functions.items[t.index];
        items[n] = if (code.name.len == 0) try model.scalar(a, .nothing) else try model.text(a, code.name);
        n += 1;
        items[n] = try model.scalar(a, .{ .number = model.Decimal.fromInt(code.required) });
        n += 1;
        items[n] = try model.scalar(a, .{ .number = model.Decimal.fromInt(code.total) });
        n += 1;
        items[n] = try model.bytes(a, &code.unit);
        n += 1;
    }
    return model.list(a, items[0..n]);
}

/// A Value a reply can't encode is Nothing, as JSON's is `null`.
fn binValue(w: *rp.Writer, s: *Session, v: *const Value, core_errors: bool) Allocator.Error!void {
    w.value(v, binOptions(s, core_errors)) catch |e| switch (e) {
        error.InvalidValue => try w.nothing(),
        error.OutOfMemory => return error.OutOfMemory,
    };
}

/// One Report: its report tag and positional list. Nested records keep
/// their ordinary map shapes.
fn binReport(w: *rp.Writer, s: *Session, report: machine.report.Report, climbed: bool) Allocator.Error!void {
    const kind = reportKind(report);
    try w.byte(@backingInt(kind));
    try w.begin(rp.fields(kind), true);
    try reportFields(BinReport{ .w = w, .s = s }, report, climbed);
    try w.end();
}

/// An ordinary error object: `kind`, and a host error's `code` and `detail`.
fn binError(w: *rp.Writer, code: talk.HostErrorCode) Allocator.Error!void {
    try w.begin(&.{}, false);
    try w.key("kind");
    if (code == .err_mailbox_full) {
        try w.ptext("mailbox full");
    } else {
        const name = talk.hostCodeName(code);
        try w.ptext("host error");
        try w.key("code");
        try w.ptext(name);
        try w.key("detail");
        try w.ptext(name);
    }
    try w.end();
}

fn binTrace(w: *rp.Writer, lines: []const []const u8) Allocator.Error!void {
    try w.ptexts(lines);
}

/// The Trace an error reply carries: only to an opted-in Host, as JSON's.
fn errorTrace(s: *Session, entry: ?*GroupEntry) Allocator.Error!?[]u8 {
    const e = entry orelse return null;
    if (!s.crossing_trace) return null;
    e.group.flush();
    if (!e.traced or e.pending_trace.items.len == 0) return null;
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try binTrace(&w, e.pending_trace.items);
    const out = try w.finish();
    freeTrace(s.gpa, takeTrace(e));
    return out;
}

/// The Trace a successful reply carries, taken as finishOk takes it.
fn okTrace(s: *Session, entry: *GroupEntry) Allocator.Error!?[]u8 {
    if (s.admitting) return null;
    entry.group.flush();
    const lines = takeTrace(entry);
    defer freeTrace(s.gpa, lines);
    if (!entry.traced or lines.len == 0) return null;
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try binTrace(&w, lines);
    return try w.finish();
}

/// An admission reply, `81`.
fn binAdmission(s: *Session, ref: i64, entry: ?*GroupEntry, admitted: Admitted) []u8 {
    return binAdmissionOrError(s, ref, entry, admitted) catch oomReply();
}

fn binAdmissionOrError(s: *Session, ref: i64, entry: ?*GroupEntry, admitted: Admitted) Allocator.Error![]u8 {
    const trace = switch (admitted) {
        .id => try okTrace(s, entry.?),
        .code => try errorTrace(s, entry),
    };
    defer if (trace) |t| s.gpa.free(t);
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try w.header();
    try w.byte(@backingInt(rp.Message.admission));
    try w.begin(rp.fields(rp.Message.admission), true);
    try w.key("ref");
    try w.int(ref);
    switch (admitted) {
        .id => |id| {
            const text = if (id.data) |d| d[0..id.len] else "";
            try w.key("delivery");
            try w.ptext(text);
        },
        .code => |code| {
            try w.key("err");
            try binError(&w, code);
        },
    }
    if (trace) |t| {
        try w.key("trace");
        try w.raw(t);
    }
    try w.end();
    return w.finish();
}

/// The Pump outcome a final reply carries, as pumpOk and finishOk write it.
fn binaryPumpOk(s: *Session, entry: *GroupEntry) Allocator.Error!BinFinal {
    const mg = &entry.group.group;
    // Stale Function Value calls rejected `function gone` with no report.
    var gone = rp.Writer.init(s.gpa);
    defer gone.deinit();
    {
        const ids = mg.goneCalls();
        defer mg.clearGoneCalls();
        if (entry.gone) {
            try gone.list(ids.len);
            var buf: [24]u8 = undefined;
            for (ids) |id| try gone.ptext(std.fmt.bufPrint(&buf, "d{d}", .{id}) catch unreachable);
        }
    }
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    // A one-Run Pump's reply is about 170 bytes; growing to it costs more
    // than the bytes.
    try w.out.ensureTotalCapacityPrecise(s.gpa, 256);
    try w.ptext(if (mg.stoppedState()) "stopped" else if (mg.rewound) "rewound" else if (mg.sliced) "sliced" else "idle");
    if (mg.nextInstant()) |at| {
        try w.instant(at);
    } else try w.nothing();
    try w.int(mg.pump_fuel);
    // The accounting tail first, as the JSON reply writes it.
    mg.accountingTail();
    var held = mg.reports.take();
    defer held.deinit();
    try w.list(held.list.items.len);
    for (held.list.items) |r| try binReport(&w, s, r, entry.climb);
    if (entry.gone) {
        try w.raw(gone.out.items);
    } else try w.nothing();
    var fin: BinFinal = .{};
    errdefer fin.deinit(s.gpa);
    fin.trace = try okTrace(s, entry);
    fin.ok = try w.finish();
    return fin;
}

/// A final reply that is the Pump's refusal, whether it never started or
/// an admitted combined input stays queued.
fn pumpFailure(s: *Session, ref: i64, entry: *GroupEntry, code: talk.HostErrorCode) []u8 {
    if (s.x.bin == null) return hostError(s.gpa, ref, code);
    var fin: BinFinal = .{};
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    binError(&w, code) catch return oomReply();
    fin.err = w.finish() catch return oomReply();
    fin.trace = errorTrace(s, entry) catch {
        fin.deinit(s.gpa);
        return oomReply();
    };
    return emitFinal(s, entry, ref, fin, false);
}

/// As holdForReleases: Grant releases go before the final reply.
fn holdBinary(s: *Session, ref: i64, entry: *GroupEntry, fin: BinFinal) []u8 {
    if (!s.x.hold(ref, .{ .frame = &.{}, .entry = entry, .fields = .ok, .bin = fin })) return emitFinal(s, entry, ref, fin, true);
    return releaseNeed(s, ref);
}

/// Sends a binary exchange's final reply, `82`. It ends the exchange and
/// retires its token.
fn emitFinal(s: *Session, entry: *GroupEntry, ref: i64, fin_in: BinFinal, abandoned: bool) []u8 {
    var fin = fin_in;
    defer fin.deinit(s.gpa);
    const reply = finalFrame(s, entry, ref, &fin, abandoned) catch return oomReply();
    if (abandoned) entry.forgetAbandoned();
    endBinary(s);
    return reply;
}

fn finalFrame(s: *Session, entry: ?*GroupEntry, ref: i64, fin: *const BinFinal, abandoned: bool) Allocator.Error![]u8 {
    const b = s.x.bin.?;
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try w.out.ensureTotalCapacityPrecise(s.gpa, 64 + if (fin.ok) |ok| ok.len else 0);
    try w.header();
    try w.byte(@backingInt(rp.Message.completion));
    try w.begin(rp.fields(rp.Message.completion), true);
    try w.key("ref");
    try w.int(ref);
    if (b.delivery) |d| {
        try w.key("delivery");
        try w.ptext(d);
    }
    if (b.token != 0) {
        try w.key("token");
        try w.int(b.token);
    }
    if (fin.ok) |ok| try w.fieldsRaw("state", 5, ok);
    if (fin.err) |e| {
        try w.key("err");
        try w.raw(e);
    }
    if (abandoned) {
        var ids: std.ArrayList([]const u8) = .empty;
        defer ids.deinit(s.gpa);
        try entry.?.abandonedIds(&ids);
        try w.key("abandoned");
        try w.ptexts(ids.items);
        if (s.crossing_trace) {
            ids.clearRetainingCapacity();
            try entry.?.settledIds(&ids);
            try w.key("settled");
            try w.ptexts(ids.items);
        }
    }
    if (fin.trace) |t| {
        try w.key("trace");
        try w.raw(t);
    }
    try w.end();
    return w.finish();
}

/// A binary input, validated whole before anything executes.
const BinInput = struct {
    m: rp.Message,
    ref: i64,
    entry: *GroupEntry,
    token: u64 = 0,
    target: Target = .all,
    name: []const u8 = "",
    args: []*Value = &.{},
    function: ?*Value = null,
    limits: Override = .none,
    now: model.dates.Instant = .{ .seconds = 0, .micros = 0 },
    slice: u64 = 0,
    cap: u64 = 0,
    /// A combined input's Pump inputs it can't use: admitted, its Pump is
    /// then refused, as an ordinary Pump with them would be.
    pump_refusal: ?talk.HostErrorCode = null,
    /// A `settle-pump`'s settlements, applied in order before its Pump.
    settlements: []Settlement = &.{},

    /// What an admitting input asks for; a combined input admits as its
    /// Request or call does.
    fn admission(in: *const BinInput) Admission {
        const how: @FieldType(Admission, "how") = switch (in.m) {
            .request, .request_pump => .{ .queued = .request },
            .deliver => .{ .queued = .deliver },
            .broadcast => .{ .queued = .broadcast },
            .decide => .{ .queued = .decide },
            .call, .call_pump => .{ .call = in.function.? },
            else => unreachable,
        };
        return .{ .how = how, .target = if (in.m == .broadcast) .all else in.target, .name = in.name, .args = in.args, .limits = in.limits };
    }

    fn deinit(in: *BinInput, gpa: Allocator) void {
        for (in.args) |v| v.release();
        gpa.free(in.args);
        if (in.function) |f| f.release();
        releaseSettlements(gpa, in.settlements);
    }
};

/// A queued `answer` or `fail`, as its JSON input would carry it.
const Settlement = struct {
    call: []const u8,
    group: *machine.Group,
    fail: bool,
    /// The answer, or the failure's Data.
    value: ?*Value,
    fuel: i64,
    /// A failure's code; none fails the call as broken.
    code: ?[]const u8,
    message: ?[]const u8,
};

fn releaseSettlements(gpa: Allocator, settlements: []Settlement) void {
    for (settlements) |st| if (st.value) |v| v.release();
    gpa.free(settlements);
}

const BinRead = union(enum) { input: BinInput, reply: []u8 };

/// A refusal before execution, in the reply format of the input's exchange.
fn binRefusal(s: *Session, m: rp.Message, ref: i64, entry: ?*GroupEntry, code: talk.HostErrorCode) []u8 {
    if (m != .pump and m != .settle_pump) return binAdmission(s, ref, entry, .{ .code = code });
    const saved = s.x.bin;
    s.x.bin = .{};
    defer s.x.bin = saved;
    var fin: BinFinal = .{};
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    binError(&w, code) catch return oomReply();
    fin.err = w.finish() catch return oomReply();
    fin.trace = errorTrace(s, entry) catch {
        fin.deinit(s.gpa);
        return oomReply();
    };
    defer fin.deinit(s.gpa);
    return finalFrame(s, entry, ref, &fin, false) catch oomReply();
}

fn handleBinary(s: *Session, frame: []const u8) []u8 {
    handling = s;
    defer handling = null;
    if (!std.mem.startsWith(u8, frame, rp.prefix)) return protocolError(s.gpa, 0, "unknown binary frame version");
    if (s.callbacks and frame.len > rp.prefix.len + 1 and frame[rp.prefix.len] == rp.layout_fields) {
        if (rp.Callback.result(frame[rp.prefix.len + 1])) |c| return handleCallbackResult(s, c, frame[rp.prefix.len + 2 ..]);
    }
    if (frame.len > rp.prefix.len + 1 and frame[rp.prefix.len] == rp.layout_fields and frame[rp.prefix.len + 1] == @backingInt(rp.Message.load)) {
        if (!s.load_fields) return protocolError(s.gpa, 0, "load-fields-v1 was not negotiated");
        return handleBinaryLoad(s, frame[rp.prefix.len + 2 ..]);
    }
    if (!s.request_pump) return protocolError(s.gpa, 0, "binary frames were not negotiated");
    if (frame.len < rp.prefix.len + 1 or frame[rp.prefix.len] != rp.layout_fields) return protocolError(s.gpa, 0, "the binary layout was not negotiated");
    var in = switch (readBinary(s, frame[rp.prefix.len + 1 ..])) {
        .input => |in| in,
        .reply => |reply| return reply,
    };
    defer in.deinit(s.gpa);
    s.active_ref = in.ref;
    const ref = in.ref;
    if (s.group_exchanges and s.restoring == null) loadExchange(s, in.entry);
    if (s.restoring != null) return protocolError(s.gpa, ref, "a restore is waiting for its resolve-result");
    return switch (s.x.gate(ref, .input, .binary)) {
        .dispatch => binaryDispatch(s, &in),
        .admit => |worker_ref| binaryPaused(s, &in, s.x.paused(worker_ref)),
        .refuse, .result, .trace_result, .release_result => unreachable,
    };
}

/// Load metadata uses protocol items only. Build the existing validation
/// tree without JSON scanning or escaping. The work list also handles hostile
/// nesting without using the WASI stack.
fn loadProtocol(a: Allocator, span: []const u8) rp.Error!Json {
    const ProtocolWork = struct { span: []const u8, out: *Json };
    var result: Json = .null;
    var work: std.ArrayList(ProtocolWork) = .empty;
    defer work.deinit(a);
    try work.append(a, .{ .span = span, .out = &result });
    while (work.pop()) |item| {
        var r: rp.Reader = .{ .data = item.span };
        switch (try r.byte()) {
            0 => item.out.* = .null,
            1 => item.out.* = .{ .bool = false },
            2 => item.out.* = .{ .bool = true },
            3 => {
                const n = try r.uint();
                item.out.* = if (n <= std.math.maxInt(i64)) .{ .integer = @intCast(n) } else .{ .number_string = try std.fmt.allocPrint(a, "{d}", .{n}) };
            },
            0x10 => {
                const n = (try rp.intOf(item.span)) orelse return error.Malformed;
                item.out.* = .{ .integer = n };
                r.at = r.data.len;
            },
            0x12 => {
                item.out.* = .{ .string = try rp.ptextOf(item.span) };
                r.at = r.data.len;
            },
            6 => {
                const n = try r.uint();
                if (n > r.data.len - r.at) return error.Malformed;
                var list = std.array_list.Managed(Json).init(a);
                try list.resize(@intCast(n));
                item.out.* = .{ .array = list };
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
                item.out.* = .{ .object = map };
            },
            else => return error.Malformed,
        }
        if (!r.done()) return error.Malformed;
    }
    return result;
}

fn handleBinaryLoad(s: *Session, payload: []const u8) []u8 {
    var arena = std.heap.ArenaAllocator.init(s.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const names = rp.fields(rp.Message.load);
    var spans: [11]?[]const u8 = undefined;
    var r: rp.Reader = .{ .data = payload };
    r.record(names, true, &spans) catch return protocolError(s.gpa, 0, "malformed Load frame");
    if (!r.done()) return protocolError(s.gpa, 0, "bytes after the Load frame");
    const ref = (rp.intOf(spans[0] orelse return protocolError(s.gpa, 0, "no ref")) catch null) orelse return protocolError(s.gpa, 0, "no ref");
    s.active_ref = ref;
    for (spans[1..4]) |span| {
        const bytes = span orelse return protocolError(s.gpa, ref, "missing Load text");
        if (bytes[0] != rp.tag.protocol_text) return protocolError(s.gpa, ref, "Load text requires protocol text");
    }
    var map: std.json.ObjectMap = .empty;
    for (names, spans) |name, span| {
        if (span) |bytes| map.put(a, name, loadProtocol(a, bytes) catch |err| return if (err == error.OutOfMemory) oomReply() else protocolError(s.gpa, ref, "malformed Load metadata")) catch return oomReply();
    }
    const msg: Json = .{ .object = map };
    if (field(msg, "newGroup")) |init| {
        if (s.restoring != null) return protocolError(s.gpa, ref, "a restore is waiting for its resolve-result");
        if (!s.group_exchanges and anyExchangeOpen(s)) return protocolError(s.gpa, ref, "a Group's exchange is open");
        if (init != .object) return hostError(s.gpa, ref, .invalid_value);
        var options = init;
        options.object.put(a, "group", field(msg, "group") orelse return hostError(s.gpa, ref, .invalid_value)) catch return oomReply();
        const code = createGroup(s, options);
        if (code != .ok) return hostError(s.gpa, ref, code);
    }
    const reply = handleMessage(s, msg, ref, "load", &.{});
    if (!s.crossing_trace or !s.reply_error) return reply;
    return withTrace(s, groupOf(s, msg) orelse return reply, reply);
}

/// As pausedAdmission: inputs join the paused worker's queue; another
/// worker, combined ones included, is refused before admission.
fn binaryPaused(s: *Session, in: *BinInput, paused: PausedWorker) []u8 {
    switch (paused.admission(in.ref, in.entry, if (in.m.pumps()) .worker else .admitted)) {
        .refuse => |why| return protocolError(s.gpa, in.ref, refusalDetail(why)),
        .refuse_worker => |entry| {
            const held = enterPaused(s, entry, paused.worker);
            defer leavePaused(s, held);
            entry.group.group.refuseWorker(.{ .pump = .{ .now = in.now, .slice = @intCast(@min(in.slice, std.math.maxInt(i64))), .cap = @intCast(@min(in.cap, std.math.maxInt(i64))) } });
            return binRefusal(s, in.m, in.ref, entry, .reentrant_call);
        },
        .admit => |entry| {
            const held = enterPaused(s, entry, paused.worker);
            defer leavePaused(s, held);
            return binaryDispatch(s, in);
        },
    }
}

fn binaryDispatch(s: *Session, in: *BinInput) []u8 {
    const entry = in.entry;
    switch (in.m) {
        .request, .deliver, .broadcast, .decide, .call => return binAdmissionOwned(s, in.ref, entry, admit(entry, in.admission())),
        .pump, .settle_pump => {
            const code = applySettlements(in.settlements);
            if (code != .ok) return binRefusal(s, in.m, in.ref, entry, code);
            endBinary(s);
            s.x.bin = .{};
            return runPump(s, in.ref, entry, false, in.now, in.slice, in.cap);
        },
        .request_pump, .call_pump => {
            if (bindingOf(s, in.token) != null) return protocolError(s.gpa, in.ref, "the token is already bound");
            const admitted = admit(entry, in.admission());
            var id = switch (admitted) {
                .id => |id| id,
                .code => return binAdmission(s, in.ref, entry, admitted),
            };
            defer Direct.ownedBytesRelease(&id);
            const text = if (id.data) |d| d[0..id.len] else "";
            // Bind before anything runs or reaches a callback.
            const delivery = s.gpa.dupe(u8, text) catch return oomReply();
            const bound = s.gpa.dupe(u8, text) catch {
                s.gpa.free(delivery);
                return oomReply();
            };
            s.bindings.append(s.gpa, .{ .token = in.token, .entry = entry, .delivery = bound }) catch {
                s.gpa.free(delivery);
                s.gpa.free(bound);
                return oomReply();
            };
            endBinary(s);
            s.x.bin = .{ .delivery = delivery, .token = in.token };
            if (in.pump_refusal) |code| return pumpFailure(s, in.ref, entry, code);
            return runPump(s, in.ref, entry, false, in.now, in.slice, in.cap);
        },
        .load, .admission, .completion => unreachable,
    }
}

fn binAdmissionOwned(s: *Session, ref: i64, entry: *GroupEntry, admitted: Admitted) []u8 {
    var a = admitted;
    defer if (a == .id) Direct.ownedBytesRelease(&a.id);
    return binAdmission(s, ref, entry, a);
}

/// Reads and validates a whole binary input. A malformed envelope is a
/// JSON protocol error; a well-formed input refused before execution gets
/// its exchange's binary reply.
fn readBinary(s: *Session, payload: []const u8) BinRead {
    var spans: [12]?[]const u8 = undefined;
    var r: rp.Reader = .{ .data = payload };
    const message_tag = r.byte() catch return .{ .reply = protocolError(s.gpa, 0, "malformed binary frame") };
    const m = std.enums.fromInt(rp.Message, message_tag) orelse return .{ .reply = protocolError(s.gpa, 0, "unknown binary message") };
    if (m == .load or m == .admission or m == .completion) return .{ .reply = protocolError(s.gpa, 0, "unknown binary message") };
    r.record(rp.fields(m), true, spans[0..rp.fields(m).len]) catch return .{ .reply = protocolError(s.gpa, 0, "malformed binary frame") };
    if (m == .settle_pump and !s.settlements) return .{ .reply = protocolError(s.gpa, 0, "unknown binary message") };
    if (m.queued() and !s.queue_fields) return .{ .reply = protocolError(s.gpa, 0, "unknown binary message") };
    const names = rp.fields(m);
    const Get = struct {
        names: []const []const u8,
        spans: []const ?[]const u8,
        fn get(g: @This(), k: []const u8) ?[]const u8 {
            for (g.names, 0..) |n, i| if (std.mem.eql(u8, n, k)) return g.spans[i];
            return null;
        }
    };
    const g: Get = .{ .names = names, .spans = spans[0..names.len] };
    if (!r.done()) return .{ .reply = protocolError(s.gpa, 0, "bytes after the frame's item") };
    const ref = (rp.intOf(g.get("ref") orelse return .{ .reply = protocolError(s.gpa, 0, "no ref") }) catch null) orelse return .{ .reply = protocolError(s.gpa, 0, "no ref") };
    const group = rp.ptextOf(g.get("group") orelse return .{ .reply = binRefusal(s, m, ref, null, .invalid_value) }) catch return malformedFrame(s, ref);
    const entry = s.groupNamed(group) orelse return .{ .reply = binRefusal(s, m, ref, null, .invalid_value) };
    var in: BinInput = .{ .m = m, .ref = ref, .entry = entry };
    var ok = false;
    defer if (!ok) in.deinit(s.gpa);
    const refuse = struct {
        fn code(s_: *Session, in_: *const BinInput, c: talk.HostErrorCode) BinRead {
            return .{ .reply = binRefusal(s_, in_.m, in_.ref, in_.entry, c) };
        }
    };
    if (m == .request_pump or m == .call_pump) {
        in.token = rp.uintOf(g.get("token") orelse return malformedFrame(s, ref)) catch return malformedFrame(s, ref);
        if (in.token == 0) return malformedFrame(s, ref);
    }
    // A Broadcast, or a Broadcast Decision, has no `to`; as in JSON.
    const to_all = m == .broadcast or (m == .decide and ((rp.boolOf(g.get("broadcast")) catch return malformedFrame(s, ref)) orelse false));
    if (to_all and m == .decide and g.get("to") != null) return refuse.code(s, &in, .invalid_value);
    if (m == .request or m == .request_pump or m.queued()) {
        if (!to_all) {
            const to = g.get("to") orelse return refuse.code(s, &in, .invalid_value);
            var t: [2]?[]const u8 = undefined;
            var tr: rp.Reader = .{ .data = to };
            tr.record(&.{ "script", "object" }, false, &t) catch return malformedFrame(s, ref);
            if ((t[0] == null) == (t[1] == null)) return refuse.code(s, &in, .invalid_value);
            if (t[0]) |span| {
                const name = rp.ptextOf(span) catch return malformedFrame(s, ref);
                in.target = .{ .script = Direct.groupScript(entry.group, name.ptr, name.len) orelse return refuse.code(s, &in, .invalid_value) };
            } else {
                entry.wrong_group = false;
                const v = binary_value.decode(s.gpa, t[1].?, .{ .resolver = resolverOf(entry), .function_metadata = s.function_metadata }) catch |e| return refuse.code(s, &in, binDecodeError(e, entry));
                defer v.release();
                if (v.data != .object) return refuse.code(s, &in, .invalid_value);
                in.target = .{ .object = objectNamed(entry, v.data.object.kind, v.data.object.id) orelse return refuse.code(s, &in, .invalid_value) };
            }
        }
        const message = g.get("message") orelse return refuse.code(s, &in, .invalid_value);
        var mf: [3]?[]const u8 = undefined;
        var mr: rp.Reader = .{ .data = message };
        mr.record(&.{ "name", "args", "limits" }, false, &mf) catch return malformedFrame(s, ref);
        in.name = rp.ptextOf(mf[0] orelse return refuse.code(s, &in, .invalid_value)) catch return malformedFrame(s, ref);
        if (readArgs(s, entry, mf[1], &in.args)) |code| return refuse.code(s, &in, code);
        in.limits = (overrideOfBinary(mf[2]) catch return malformedFrame(s, ref));
    } else if (m == .call or m == .call_pump) {
        const span = g.get("fn") orelse return refuse.code(s, &in, .invalid_value);
        entry.wrong_group = false;
        in.function = binary_value.decode(s.gpa, span, .{ .resolver = resolverOf(entry), .function_metadata = s.function_metadata }) catch |e| return refuse.code(s, &in, binDecodeError(e, entry));
        if (readArgs(s, entry, g.get("args"), &in.args)) |code| return refuse.code(s, &in, code);
        in.limits = (overrideOfBinary(g.get("limits")) catch return malformedFrame(s, ref));
    }
    if (m.pumps()) {
        if (pumpInputs(&in, g.get("now"), g.get("fuelSlice"), g.get("fuelCap"))) |code| {
            if (m == .pump or m == .settle_pump) return refuse.code(s, &in, code);
            in.pump_refusal = code;
        }
    }
    if (m == .settle_pump) {
        const code = readSettlements(s, entry, g.get("settlements"), &in.settlements) catch return malformedFrame(s, ref);
        if (code) |c| return refuse.code(s, &in, c);
    }
    ok = true;
    return .{ .input = in };
}

fn malformedFrame(s: *Session, ref: i64) BinRead {
    return .{ .reply = protocolError(s.gpa, ref, "malformed binary frame") };
}

/// The host error for a binary Value decodeValue's rules refuse.
fn binDecodeError(e: anyerror, entry: *GroupEntry) talk.HostErrorCode {
    if (e == error.OutOfMemory) return .out_of_memory;
    if (entry.wrong_group) return .wrong_group;
    return .invalid_value;
}

/// Reads a Pump's Clock and Fuel options; the refusal code, or null.
fn pumpInputs(in: *BinInput, now: ?[]const u8, slice: ?[]const u8, cap: ?[]const u8) ?talk.HostErrorCode {
    in.now = rp.instantOf(now orelse return .invalid_value) catch return .invalid_value;
    model.dates.validateInstant(in.now) catch return .invalid_value;
    if (slice) |x| in.slice = rp.uintOf(x) catch return .invalid_value;
    if (cap) |x| in.cap = rp.uintOf(x) catch return .invalid_value;
    return null;
}

/// Decodes a `settle-pump`'s settlements into `out`, every call found and
/// Value decoded before any is applied; the refusal code, or null.
fn readSettlements(s: *Session, entry: *GroupEntry, span: ?[]const u8, out: *[]Settlement) rp.Error!?talk.HostErrorCode {
    const given = span orelse return null;
    const items = try rp.listOf(given, s.gpa);
    defer s.gpa.free(items);
    const list = try s.gpa.alloc(Settlement, items.len);
    var made: usize = 0;
    // Releases the decoded ones, and the whole list, on any refusal.
    errdefer abandonSettlements(s.gpa, list, made);
    for (items) |item| {
        var f: [rp.settlement_fields.len]?[]const u8 = undefined;
        var r: rp.Reader = .{ .data = item };
        try r.record(rp.settlement_fields, true, &f);
        if (!r.done()) return error.Malformed;
        const id = try rp.ptextOf(f[0] orelse return error.Malformed);
        const outcome = try rp.ptextOf(f[1] orelse return error.Malformed);
        const fail = std.mem.eql(u8, outcome, "fail");
        if (!fail and !std.mem.eql(u8, outcome, "answer")) return error.Malformed;
        const fuel: i64 = if (f[3]) |x| (try rp.intOf(x)) orelse return error.Malformed else 0;
        const code = if (f[4]) |x| try rp.ptextOf(x) else null;
        const message = if (f[5]) |x| try rp.ptextOf(x) else null;
        if (fail and (f[3] != null or (code == null and (message != null or f[2] != null))) or !fail and (code != null or message != null)) return error.Malformed;
        if (fuel < 0 or fuel > 9_007_199_254_740_991) return error.Malformed;
        // Released calls are still known by id; late settlements are queued
        // and ignored at drain, just as their JSON forms are (#1322).
        if (entry.group.group.callById(id) == null and !entry.group.group.issued(id)) {
            abandonSettlements(s.gpa, list, made);
            return .unknown_call;
        }
        var value: ?*Value = null;
        if (f[2] != null or !fail) {
            entry.wrong_group = false;
            value = binary_value.decode(s.gpa, f[2] orelse &.{rp.tag.nothing}, .{ .resolver = resolverOf(entry), .function_metadata = s.function_metadata }) catch |e| {
                abandonSettlements(s.gpa, list, made);
                return binDecodeError(e, entry);
            };
        }
        list[made] = .{ .call = id, .group = &entry.group.group, .fail = fail, .value = value, .fuel = fuel, .code = code, .message = message };
        made += 1;
    }
    out.* = list;
    return null;
}

fn abandonSettlements(gpa: Allocator, list: []Settlement, made: usize) void {
    for (list[0..made]) |st| if (st.value) |v| v.release();
    gpa.free(list);
}

fn applySettlements(settlements: []const Settlement) talk.HostErrorCode {
    for (settlements) |st| {
        var call: caps.Call = .{ .id = st.call, .script = "", .grant = "", .binding = null, .now = .{ .seconds = 0, .micros = 0 }, .left = null, .group = st.group, .gpa = st.group.gpa };
        const code = if (st.fail) blk: {
            const c = st.code orelse break :blk Direct.callFail(&call, null);
            const failure: talk.ScriptError = .{ .code = c.ptr, .code_len = c.len, .message = if (st.message) |m| m.ptr else null, .message_len = if (st.message) |m| m.len else 0, .data = st.value };
            break :blk Direct.callFail(&call, &failure);
        } else Direct.callAnswerWithCost(&call, st.value.?, st.fuel);
        if (code != .ok) return code;
    }
    return .ok;
}

/// A Host Object by kind and id, as objectOf finds one.
fn objectNamed(entry: *GroupEntry, kind: []const u8, id: []const u8) ?*objects.Object {
    var out: ?*objects.Object = null;
    return if (Direct.objectById(entry.group, kind.ptr, kind.len, id.ptr, id.len, &out)) out else null;
}

/// Decodes a list of Values into `out`; the refusal code, or null.
fn readArgs(s: *Session, entry: *GroupEntry, span: ?[]const u8, out: *[]*Value) ?talk.HostErrorCode {
    const given = span orelse return null;
    if (!rp.isList(given)) return .invalid_value;
    const items = rp.listOf(given, s.gpa) catch |e| return if (e == error.OutOfMemory) .out_of_memory else .invalid_value;
    defer s.gpa.free(items);
    const args = s.gpa.alloc(*Value, items.len) catch return .out_of_memory;
    var made: usize = 0;
    for (items, args) |item, *slot| {
        entry.wrong_group = false;
        slot.* = binary_value.decode(s.gpa, item, .{ .resolver = resolverOf(entry), .function_metadata = s.function_metadata }) catch |e| {
            for (args[0..made]) |v| v.release();
            s.gpa.free(args);
            return binDecodeError(e, entry);
        };
        made += 1;
    }
    out.* = args;
    return null;
}

/// A binary `limits`: a map of integer fields, or any other item as the
/// sentinel for an override the binding can't represent.
fn overrideOfBinary(span: ?[]const u8) rp.Error!Override {
    const given = span orelse return .none;
    if (!rp.isMap(given)) return .{ .refused = .{} };
    const names = comptime blk: {
        var xs: [machine.override_fields.len][]const u8 = undefined;
        for (machine.override_fields, 0..) |f, i| xs[i] = f.ts;
        const out = xs;
        break :blk &out;
    };
    var fields: [names.len]?[]const u8 = undefined;
    var r: rp.Reader = .{ .data = given };
    try r.record(names, false, &fields);
    var o: talk.LimitOverride = .{};
    var refused: machine.RefusedOverride = .{};
    var bad = false;
    var any = false;
    inline for (machine.override_fields, 0..) |f, i| if (fields[i]) |x| {
        const n = rp.intOf(x) catch null;
        @field(refused, f.field) = n;
        if (n == null or n.? < 0) {
            bad = true;
        } else {
            @field(o, f.field) = n.?;
            o.set |= f.bit;
            any = true;
        }
    };
    if (bad) return .{ .refused = refused };
    return if (any) .{ .given = o } else .none;
}

/// `cancel-correlated`: cancels a combined input by its token, exactly as
/// `cancel-delivery` cancels its delivery.
fn cancelCorrelatedReply(s: *Session, msg: Json, ref: i64) []u8 {
    const entry = groupOf(s, msg) orelse return hostError(s.gpa, ref, .invalid_value);
    const token = asU64(field(msg, "token")) orelse return protocolError(s.gpa, ref, "a token is a positive integer");
    const i = bindingOf(s, token) orelse return protocolError(s.gpa, ref, "an unknown or retired token");
    const b = s.bindings.items[i];
    if (b.entry != entry) return protocolError(s.gpa, ref, "the token belongs to another Group");
    const code = Direct.cancelDelivery(entry.group, b.delivery.ptr, b.delivery.len);
    if (code != .ok) return hostError(s.gpa, ref, code);
    var o = Out.init(s.gpa);
    defer o.deinit();
    beginOk(&o, ref) catch return oomReply();
    return finishOk(s, &o, entry);
}

// ------------------------------------ binary callback exchanges (#1311)

/// Whether `reply` is a binary callback need, whose notices come last.
fn isBinNeed(reply: []const u8) bool {
    return reply.len > rp.prefix.len + 1 and std.mem.startsWith(u8, reply, rp.prefix) and reply[rp.prefix.len + 1] >= @backingInt(rp.Callback.op);
}

/// A binary need with its abandonment notices in place of the Nothing
/// `abandoned` and `settled` it was written with; `trace` stays last.
fn binNoticed(s: *Session, entry: *GroupEntry, reply: []const u8) Allocator.Error![]u8 {
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try w.out.ensureTotalCapacity(s.gpa, reply.len + 16);
    try w.raw(reply[0 .. reply.len - 3]);
    var ids: std.ArrayList([]const u8) = .empty;
    defer ids.deinit(s.gpa);
    try entry.abandonedIds(&ids);
    try w.ptexts(ids.items);
    if (s.crossing_trace) {
        ids.clearRetainingCapacity();
        try entry.settledIds(&ids);
        try w.ptexts(ids.items);
    } else try w.nothing();
    try w.raw(reply[reply.len - 1 ..]);
    return w.finish();
}

fn binNeedValue(s: *Session, w: *rp.Writer, v: *const Value) Allocator.Error!void {
    // A Value the Core can't encode crosses as Nothing, as in Reports.
    w.value(v, binOptions(s, s.core_errors)) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidValue => try w.nothing(),
    };
}

/// The binary `need` a paused Pump gets: an op, prop or effect frame.
fn binNeed(s: *Session, ref: i64) Allocator.Error![]u8 {
    const n = s.x.openNeed();
    const c: rp.Callback = switch (n.kind) {
        .op => .op,
        .prop => .prop,
        .effect => .effect,
    };
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try w.out.ensureTotalCapacity(s.gpa, 160);
    try w.header();
    try w.byte(@backingInt(c));
    try w.begin(rp.fields(c), true);
    try w.key("ref");
    try w.int(ref);
    switch (n.kind) {
        .op => {
            try w.key("call");
            try w.ptext(n.call);
            try w.key("script");
            try w.ptext(n.script);
            try w.key("run");
            try w.ptext(n.run);
            try w.key("segment");
            try w.ptext(n.segment);
            try w.key("grant");
            try w.ptext(n.grant);
            try w.key("capability");
            try w.ptext(n.capability);
            try w.key("operation");
            try w.ptext(n.operation);
            try w.key("mode");
            try w.ptext(modeName(n.mode));
            try w.key("now");
            try w.instant(n.now);
            try w.key("args");
            try w.list(n.args.len);
            for (n.args) |v| try binNeedValue(s, &w, v);
            if (n.scope.len > 0) {
                try w.key("scope");
                try w.ptext(n.scope);
            }
            try w.key("automatic");
            try w.boolean(n.automatic);
            if (n.fuel_left) |left| {
                try w.key("fuelLeft");
                try w.int(left);
            }
        },
        .effect => {
            try w.key("script");
            try w.ptext(n.script);
            try w.key("run");
            try w.ptext(n.run);
            try w.key("segment");
            try w.ptext(n.segment);
            try w.key("grant");
            try w.ptext(n.grant);
            try w.key("grants");
            try w.list(n.grants.len);
            for (n.grants) |g| try w.ptext(g);
            if (n.coordinator) |co| {
                try w.key("coordinator");
                try w.ptext(co);
            }
            try w.key("phase");
            try w.ptext(@tagName(n.phase));
            try w.key("now");
            try w.instant(n.now);
        },
        .prop => {
            try w.key("object");
            try w.list(2);
            try w.ptext(n.object_kind);
            try w.ptext(n.object_id);
            try w.key("prop");
            try w.ptext(n.prop);
            if (n.value) |v| {
                // `set` tells a setter from a getter, since Nothing is absent.
                try w.key("set");
                try w.boolean(true);
                try w.key("value");
                try binNeedValue(s, &w, v);
            }
            if (n.op) |op| {
                try w.key("op");
                try w.ptext(op);
            }
            if (n.selector) |v| {
                try w.key("selector");
                try binNeedValue(s, &w, v);
            }
        },
    }
    try w.end();
    return w.finish();
}

/// A binary Grant `release` need.
fn binRelease(s: *Session, ref: i64, r: Release) Allocator.Error![]u8 {
    var w = rp.Writer.init(s.gpa);
    defer w.deinit();
    try w.header();
    try w.byte(@backingInt(rp.Callback.release));
    try w.begin(rp.fields(rp.Callback.release), true);
    try w.key("ref");
    try w.int(ref);
    try w.key("script");
    try w.ptext(r.script);
    try w.key("grant");
    try w.ptext(r.grant);
    try w.key("reason");
    try w.ptext(@tagName(r.reason));
    try w.key("now");
    try w.instant(r.now);
    try w.end();
    return w.finish();
}

/// A binary callback result: validated whole, then gated as handleFrame
/// gates its JSON form, and answered as that form is.
fn handleCallbackResult(s: *Session, c: rp.Callback, payload: []const u8) []u8 {
    var spans: [7]?[]const u8 = undefined;
    const names = rp.fields(c);
    var r: rp.Reader = .{ .data = payload };
    r.record(names, true, spans[0..names.len]) catch return protocolError(s.gpa, 0, "malformed binary frame");
    if (!r.done()) return protocolError(s.gpa, 0, "bytes after the frame's item");
    const ref = (rp.intOf(spans[0] orelse return protocolError(s.gpa, 0, "no ref")) catch null) orelse return protocolError(s.gpa, 0, "no ref");
    s.active_ref = ref;
    const group = rp.ptextOf(spans[1] orelse return protocolError(s.gpa, ref, "no group")) catch return protocolError(s.gpa, ref, "malformed binary frame");
    const entry = s.groupNamed(group) orelse return protocolError(s.gpa, ref, "an unknown group");
    if (s.group_exchanges and s.restoring == null) loadExchange(s, entry);
    if (s.restoring != null) return protocolError(s.gpa, ref, "a restore is waiting for its resolve-result");
    const result: exchange.Result = switch (c) {
        .op_result => .op,
        .prop_result => .prop,
        .effect_result => .effect,
        .release_result => .release,
        .op, .prop, .effect, .release => unreachable,
    };
    switch (s.x.gate(ref, .{ .result = result }, .binary)) {
        .refuse => |why| return protocolError(s.gpa, ref, refusalDetail(why)),
        .release_result => return releaseResultReply(s, ref),
        .result => {},
        .dispatch, .admit, .trace_result => unreachable,
    }
    if (c == .effect_result) {
        const given = if (spans[2]) |x| rp.ptextOf(x) catch "unknown" else "unknown";
        const status: caps.EffectStatus = if (std.mem.eql(u8, given, "ok")) .ok else if (std.mem.eql(u8, given, "failed")) .failed else .unknown;
        return resumeEffect(s, ref, status);
    }
    var answer: Answer = .{ .kind = .host_error };
    if (spans[6]) |x| {
        answer.charged = rp.uintOf(x) catch return hostError(s.gpa, ref, .invalid_value);
        if (answer.charged > 9_007_199_254_740_991) return hostError(s.gpa, ref, .invalid_value);
    }
    const outcome = rp.ptextOf(spans[2] orelse return protocolError(s.gpa, ref, "a callback result with no outcome")) catch return protocolError(s.gpa, ref, "malformed binary frame");
    const decode = struct {
        fn value(s_: *Session, e: *GroupEntry, span: ?[]const u8) anyerror!*Value {
            const x = span orelse return model.scalar(s_.gpa, .nothing);
            e.wrong_group = false;
            return binary_value.decode(s_.gpa, x, .{ .resolver = resolverOf(e), .function_metadata = s_.function_metadata });
        }
    };
    const is_prop = c == .prop_result;
    if (std.mem.eql(u8, outcome, if (is_prop) "value" else "result")) {
        answer.kind = .result;
        answer.value = decode.value(s, entry, spans[3]) catch |e| return hostError(s.gpa, ref, binDecodeError(e, entry));
    } else if (std.mem.eql(u8, outcome, "fail")) {
        answer.kind = .fail;
        binFailure(s, entry, spans[4], spans[5], spans[3], &answer) catch |e| {
            if (e == error.OutOfMemory) return hostError(s.gpa, ref, .out_of_memory);
            const charged = answer.charged;
            answer.release(s.gpa);
            answer = .{ .kind = .host_error, .charged = charged };
        };
    } else if (std.mem.eql(u8, outcome, "hostError")) {
        answer.kind = .host_error;
    } else if (is_prop and std.mem.eql(u8, outcome, "ok")) {
        answer.kind = .done;
    } else if (!is_prop and std.mem.eql(u8, outcome, "started")) {
        answer.kind = .started;
    } else if (!is_prop and std.mem.eql(u8, outcome, "done")) {
        answer.kind = .done;
    } else if (!is_prop and std.mem.eql(u8, outcome, "limit")) {
        answer.kind = .limit;
    } else return protocolError(s.gpa, ref, "a callback result with an unknown outcome");
    return resumeNeed(s, ref, answer);
}

/// A binary `fail`: its code and optional message as protocol text, and
/// its optional Data as a Value.
fn binFailure(s: *Session, entry: *GroupEntry, code: ?[]const u8, message: ?[]const u8, data: ?[]const u8, answer: *Answer) (Allocator.Error || Invalid)!void {
    const c = rp.ptextOf(code orelse return error.InvalidValue) catch return error.InvalidValue;
    answer.code = try s.gpa.dupe(u8, c);
    if (message) |m| answer.message = try s.gpa.dupe(u8, rp.ptextOf(m) catch return error.InvalidValue);
    if (data) |d| {
        entry.wrong_group = false;
        answer.data = binary_value.decode(s.gpa, d, .{ .resolver = resolverOf(entry), .function_metadata = s.function_metadata }) catch |e| return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
    }
}

// ---------------------------------------------------------- wasm exports

const export_allocator = @import("process_allocator.zig").allocator;
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
    if (chunk_input.items.len != 0 or reply_at < reply_buffer.len) @trap();
    s.inline_io = wasiInline;
    const reply = if (n == 0 or n > in_buffer.len)
        protocolError(s.gpa, 0, "no frame of that length")
    else
        handle(s, in_buffer[0..n]);
    // The Session allocates with export_allocator, so its reply is kept
    // as is until the next export, not copied.
    freeReply(export_allocator, reply_buffer);
    reply_buffer = reply;
    reply_at = reply_buffer.len;
    return (@as(u64, @intCast(@intFromPtr(reply_buffer.ptr))) << 32) | @as(u64, @intCast(reply_buffer.len));
}

// Only negotiated WASI callers use these exports. Intermediate input chunks
// never reach the dispatcher. The reply retains its existing ownership until
// the following request starts; readers advance through bounded windows.
var chunk_input: std.ArrayList(u8) = .empty;
var reply_at: usize = 0;

fn nextReplyChunk() u64 {
    if (reply_at >= reply_buffer.len) return 0;
    const n = @min(max_frame, reply_buffer.len - reply_at);
    const ptr = @intFromPtr(reply_buffer.ptr + reply_at);
    reply_at += n;
    const count = n | (if (reply_at < reply_buffer.len) more_chunks else @as(usize, 0));
    return (@as(u64, @intCast(ptr)) << 32) | @as(u64, @intCast(count));
}

fn chunkExport(tagged: usize) callconv(.c) u64 {
    const s = session() orelse return 0;
    if (!s.chunked_wasi or reply_at < reply_buffer.len) @trap();
    const n = tagged & ~more_chunks;
    if (n == 0 or n > max_frame or n > in_buffer.len or chunk_input.items.len > max_message - n) @trap();
    const more = tagged & more_chunks != 0;
    if (chunk_input.items.len == 0) {
        freeReply(export_allocator, reply_buffer);
        reply_buffer = &.{};
        reply_at = 0;
    }
    // The common single-chunk path needs no extra input copy.
    if (more or chunk_input.items.len != 0) {
        chunk_input.appendSlice(export_allocator, in_buffer[0..n]) catch @trap();
        if (more) return 0;
    }
    s.inline_io = wasiInline;
    const input = if (chunk_input.items.len != 0) chunk_input.items else in_buffer[0..n];
    reply_buffer = handle(s, input);
    if (reply_buffer.len > max_message) @trap();
    chunk_input.deinit(export_allocator);
    chunk_input = .empty;
    reply_at = 0;
    return nextReplyChunk();
}

fn nextReplyExport() callconv(.c) u64 {
    const s = session() orelse return 0;
    if (!s.chunked_wasi) return 0;
    return nextReplyChunk();
}

fn initializeExport() callconv(.c) void {
    _ = session();
}

comptime {
    if (builtin.target.os.tag == .wasi) {
        @export(&bufferExport, .{ .name = "talk_buffer" });
        @export(&sendExport, .{ .name = "talk_send" });
        @export(&chunkExport, .{ .name = "talk_send_chunk" });
        @export(&nextReplyExport, .{ .name = "talk_reply_next" });
        @export(&initializeExport, .{ .name = "_initialize" });
    }
}

fn entryLoadError(s: *Session, ref: i64, entry: *GroupEntry) []u8 {
    if (entry.inline_trace) |*t| if (entry.traced) {
        defer {
            for (t.diagnostics.items) |line| s.gpa.free(line);
            t.diagnostics.clearRetainingCapacity();
        }
        return loadError(s.gpa, ref, t.diagnostics.items);
    };
    return loadError(s.gpa, ref, entry.pending_trace.items);
}

/// Streaming Trace writer used only by inline-inputs-v1. It calls the Host
/// after a complete record, while its producing stack is still alive.
const InlineTrace = struct {
    writer: std.Io.Writer = .{ .buffer = &.{}, .vtable = &.{ .drain = drain } },
    session: *Session,
    entry: *GroupEntry,
    bytes: std.ArrayList(u8) = .empty,
    diagnostics: std.ArrayList([]u8) = .empty,

    fn append(t: *InlineTrace, bytes: []const u8) std.Io.Writer.Error!void {
        var rest = bytes;
        while (std.mem.indexOfScalar(u8, rest, '\n')) |end| {
            t.bytes.appendSlice(t.entry.gpa, rest[0..end]) catch return error.WriteFailed;
            const line = t.bytes.toOwnedSlice(t.entry.gpa) catch return error.WriteFailed;
            defer t.entry.gpa.free(line);
            rest = rest[end + 1 ..];
            if (std.mem.startsWith(u8, line, "diag ")) {
                const own = t.entry.gpa.dupe(u8, line) catch return error.WriteFailed;
                t.diagnostics.append(t.entry.gpa, own) catch {
                    t.entry.gpa.free(own);
                    return error.WriteFailed;
                };
            }
            if (t.session.inline_active and t.entry.group.group.delaysRecords()) {
                const own = t.entry.gpa.dupe(u8, line) catch return error.WriteFailed;
                t.entry.group.group.delayRecord(own) catch {
                    t.entry.gpa.free(own);
                    return error.WriteFailed;
                };
            } else if (t.session.inline_active) {
                const own = t.entry.gpa.dupe(u8, line) catch return error.WriteFailed;
                t.entry.pending_trace.append(t.entry.gpa, own) catch {
                    t.entry.gpa.free(own);
                    return error.WriteFailed;
                };
            } else {
                var event = Out.init(t.entry.gpa);
                defer event.deinit();
                event.raw("{\"trace\":[") catch return error.WriteFailed;
                event.text(line) catch return error.WriteFailed;
                event.raw("]}") catch return error.WriteFailed;
                inlineRound(t.session, t.entry, event.buf.written());
            }
        }
        t.bytes.appendSlice(t.entry.gpa, rest) catch return error.WriteFailed;
    }

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const t: *InlineTrace = @alignCast(@fieldParentPtr("writer", w));
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |bytes| {
            try t.append(bytes);
            n += bytes.len;
        }
        const last = data[data.len - 1];
        for (0..splat) |_| try t.append(last);
        return n + last.len * splat;
    }
};

fn inlinePoll(context: ?*anyopaque) void {
    const t: *InlineTrace = @ptrCast(@alignCast(context.?));
    if (!t.session.inline_active) inlineRound(t.session, t.entry, "{\"poll\":true}");
}

/// Admission executes here, on the original guest stack, never by reentering
/// talk_send. The producing worker cannot advance until the sink acknowledges.
fn inlineRound(s: *Session, entry: *GroupEntry, event: []const u8) void {
    const io = s.inline_io orelse return;
    s.inline_active = true;
    defer s.inline_active = false;
    const owned = s.gpa.dupe(u8, event) catch return;
    const observed = withAbandoned(s, entry, owned, .outer);
    defer freeReply(s.gpa, observed);
    var incoming = io(observed) orelse return;
    while (true) {
        // Most rounds are idle polls, which the Host answers `null`.
        if (std.mem.eql(u8, incoming, "null")) return;
        const parsed = std.json.parseFromSlice(Json, s.gpa, incoming, .{ .allocate = .alloc_always, .parse_numbers = false, .max_value_len = incoming.len }) catch @trap();
        defer parsed.deinit();
        if (parsed.value == .null) return;
        const msg = parsed.value;
        const ref = asInt(field(msg, "ref")) orelse @trap();
        const m = asText(field(msg, "m")) orelse @trap();
        // Admission joins the producing worker, whichever exchange is open.
        const producing: PausedWorker = .{ .ref = s.active_ref, .entry = entry, .worker = if (entry.group.group.pumping) .pump else .work };
        const reply = withTrace(s, entry, pausedAdmission(s, msg, ref, m, producing));
        defer freeReply(s.gpa, reply);
        var out = Out.init(s.gpa);
        defer out.deinit();
        out.raw("{\"reply\":") catch return;
        out.raw(reply) catch return;
        out.raw("}") catch return;
        incoming = io(out.buf.written()) orelse return;
    }
}

// The reactor's optional inline transport uses framed WASI stdio. Hosts which
// do not negotiate it never read or write stdio from talk_send.
var inline_buffer: std.ArrayList(u8) = .empty;
fn wasiInline(event: []const u8) ?[]const u8 {
    if (builtin.target.os.tag != .wasi) return null;
    const wasi = std.os.wasi;
    // Each WASI call crosses into the Host, so the header and event go in
    // one gathered write, and the reply usually arrives in one read.
    const chunked = session().?.chunked_wasi;
    if (event.len > (if (chunked) max_message else max_frame)) @trap();
    var at: usize = 0;
    while (at < event.len) {
        const n = @min(max_frame, event.len - at);
        var header: [4]u8 = undefined;
        const count = n | (if (at + n < event.len) more_chunks else @as(usize, 0));
        std.mem.writeInt(u32, &header, @intCast(count), .big);
        var parts = [_]wasi.ciovec_t{ .{ .base = &header, .len = header.len }, .{ .base = event.ptr + at, .len = n } };
        var first: usize = 0;
        var skipped: usize = 0;
        while (first < parts.len) {
            var written: usize = 0;
            if (wasi.fd_write(1, parts[first..].ptr, parts.len - first, &written) != .SUCCESS or written == 0) @trap();
            skipped += written;
            while (first < parts.len and skipped >= parts[first].len) {
                skipped -= parts[first].len;
                first += 1;
            }
            if (first < parts.len) {
                parts[first].base += skipped;
                parts[first].len -= skipped;
                skipped = 0;
            }
        }
        at += n;
    }
    if (inline_buffer.capacity > max_frame) {
        inline_buffer.deinit(export_allocator);
        inline_buffer = .empty;
    } else inline_buffer.clearRetainingCapacity();
    var input: WasiInlineInput = .{};
    while (true) {
        var header: [4]u8 = undefined;
        if (!input.read(&header)) @trap();
        const count = std.mem.readInt(u32, &header, .big);
        const more = chunked and count & more_chunks != 0;
        const size = if (chunked) count & ~more_chunks else count;
        if (size == 0 or size > max_frame or inline_buffer.items.len > max_message - size) @trap();
        const start = inline_buffer.items.len;
        inline_buffer.resize(export_allocator, start + size) catch @trap();
        if (!input.read(inline_buffer.items[start..])) @trap();
        if (!more) {
            if (input.start != input.end) @trap();
            return inline_buffer.items;
        }
    }
}

// Read small acknowledgements with their header in one WASI call, as before
// chunking. Keep prefetched bytes when a short chunk ends inside that read.
const WasiInlineInput = struct {
    buffer: [256]u8 = undefined,
    start: usize = 0,
    end: usize = 0,

    fn read(r: *WasiInlineInput, bytes: []u8) bool {
        var rest = bytes;
        while (rest.len > 0) {
            if (r.start < r.end) {
                const n = @min(rest.len, r.end - r.start);
                @memcpy(rest[0..n], r.buffer[r.start..][0..n]);
                r.start += n;
                rest = rest[n..];
            } else if (rest.len > r.buffer.len) {
                return wasiRead(rest);
            } else {
                const vec = [_]std.os.wasi.iovec_t{.{ .base = &r.buffer, .len = r.buffer.len }};
                var n: usize = 0;
                if (std.os.wasi.fd_read(0, &vec, 1, &n) != .SUCCESS or n == 0) return false;
                r.start = 0;
                r.end = n;
            }
        }
        return true;
    }
};

fn wasiRead(bytes: []u8) bool {
    if (builtin.target.os.tag != .wasi) return false;
    var at: usize = 0;
    while (at < bytes.len) {
        const vec = [_]std.os.wasi.iovec_t{.{ .base = bytes[at..].ptr, .len = bytes.len - at }};
        var n: usize = 0;
        if (std.os.wasi.fd_read(0, &vec, 1, &n) != .SUCCESS or n == 0) return false;
        at += n;
    }
    return true;
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

test "untraced Pump skips machine Trace formatting but keeps Reports" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"name\":\"g\",\"trace\":false}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on ping n\\n return n + 1\\nend ping\\n\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"ping\",\"args\":[41]}}}}", .{4}));
    const entry = s.groupNamed("g").?;
    var capture: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer capture.deinit();
    const trace = entry.group.group.trace;
    entry.group.group.trace = &capture.writer;
    defer entry.group.group.trace = trace;
    const reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-17T12:00:00Z\"}}", .{5});
    const ended = try runEnd(reply);
    try std.testing.expectEqual(@as(i64, 42), ended.object.get("result").?.integer);
    try std.testing.expectEqual(@as(usize, 0), capture.written().len);
    try std.testing.expectEqual(@as(?*std.Io.Writer, &capture.writer), entry.group.group.trace);
}

test "queued-inputs reads the owning Group without execution or Trace" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"g\"}}", .{1})));
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"queued-inputs-v1\",\"group-exchanges-v1\"]}}", .{2}));
    for ([_]bool{ false, true }) |traced| {
        const name: []const u8 = if (traced) "traced" else "silent";
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"{s}\",\"trace\":{s}}}", .{ 3, name, if (traced) "true" else "false" }));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"{s}\",\"name\":\"s\",\"source\":\"on go\\n return 7\\nend go\"}}", .{ 4, name }));
        const empty = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"{s}\"}}", .{ 5, name }));
        try std.testing.expect(!empty.object.get("queued").?.bool);
        try std.testing.expect(empty.object.get("trace") == null);
        _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"{s}\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{ 6, name }));
        for (0..2) |_| {
            const queued = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"{s}\"}}", .{ 7, name }));
            try std.testing.expect(queued.object.get("queued").?.bool);
            try std.testing.expect(queued.object.get("trace") == null);
        }
        // A refused Pump must leave the queued input observable.
        try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"{s}\",\"now\":\"2026-10-10T12:00:00Z\",\"fuelCap\":-1}}", .{ 8, name })));
        const retained = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"{s}\"}}", .{ 9, name }));
        try std.testing.expect(retained.object.get("queued").?.bool);
        _ = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"{s}\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{ 10, name }));
        const drained = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"{s}\"}}", .{ 11, name }));
        try std.testing.expect(!drained.object.get("queued").?.bool);
        try std.testing.expect(drained.object.get("trace") == null);
    }
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"silent\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{12}));
    const other = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"traced\"}}", .{13}));
    try std.testing.expect(!other.object.get("queued").?.bool);
    const own = try okOf(try c.send("{{\"m\":\"queued-inputs\",\"ref\":{d},\"group\":\"silent\"}}", .{14}));
    try std.testing.expect(own.object.get("queued").?.bool);
}

test "backwards Pump preserves queued work and the first Clock may predate Unix" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"trace\":true}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on go\\n return 7\\nend go\\n\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"0001-01-01T00:00:00Z\"}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T00:00:00.000002Z\"}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{6}));
    const seven = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T00:00:00.0000030Z\"}}", .{9});
    try std.testing.expectEqualStrings("invalid value", seven.object.get("err").?.object.get("code").?.string);
    const refused = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T00:00:00.000001Z\"}}", .{7});
    try std.testing.expectEqualStrings("host error", try errKind(refused));
    try std.testing.expectEqualStrings("clock backwards", refused.object.get("err").?.object.get("code").?.string);
    const done = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T00:00:00.000002Z\"}}", .{8});
    try std.testing.expectEqual(@as(i64, 7), (try runEnd(done)).object.get("result").?.integer);
    const lines = (try okOf(done)).object.get("trace").?.array.items;
    try std.testing.expectEqualStrings("refused code=\"clock backwards\"", lines[1].string);
    try std.testing.expect(std.mem.startsWith(u8, lines[2].string, "> request "));
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

test "settled deferred calls leave nothing behind and a late answer is still ignored (#1322)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"abandoned-before-needs-v1\",\"crossing-trace-v1\"]}}", .{0}));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"suspending\",\"result\":\"number\"}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go\\n ask api to read and wait\\n return it + 1\\nend go\"}}", .{ 4, grant.object.get("grant").?.integer }));
    const entry = s.groupNamed("g").?;
    for (0..50) |_| {
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
        const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
        const id = (pumped.object.get("need") orelse return unexpected(pumped)).object.get("call").?.string;
        _ = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"started\":true}}", .{}));
        _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"value\":41}}", .{ 7, id }));
        const done = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8});
        try std.testing.expectEqual(@as(i64, 42), (try runEnd(done)).object.get("result").?.integer);
    }
    // The Host has heard every call settle, so the Group keeps none of them.
    try std.testing.expectEqual(@as(usize, 0), entry.started.items.len);
    try std.testing.expect(entry.group.group.waits.retired_calls.items.len <= 1);
    try std.testing.expect(entry.group.group.waits.call_index.count() <= 1);
    // Every Run made the same one call, so their issued ids share one Span.
    try std.testing.expectEqual(@as(usize, 0), entry.group.group.waits.issued_calls.runs.count());
    try std.testing.expectEqual(@as(usize, 1), entry.group.group.waits.issued_calls.spans.get("s/r").?.items.len);
    // A late answer to a released call is still known, and ignored.
    _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"s/r1.c1\",\"value\":1}}", .{9}));
    const late = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10});
    try std.testing.expectEqualStrings("idle", (try okOf(late)).object.get("state").?.string);
    // A call the Group never issued is still unknown.
    const unknown = try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"s/r999.c1\",\"value\":1}}", .{11});
    try std.testing.expect(unknown.object.get("err") != null);
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

test "a Result Target holds a resumed answer and is untouched when the ask raises (ADR 0112)" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"result\":\"number\",\"maxPending\":5000}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    const source = "script variable last = 5\non got\n  put 1 into got\n  try\n    ask api to fetch into got and wait\n  catch e\n    return got\n  end try\n  return got\nend got\non keep\n  ask api to fetch into last and wait\nend keep\non peek\n  return last\nend peek\n";
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":{f}}}", .{ 4, grant.object.get("grant").?.integer, std.json.fmt(source, .{}) }));
    var ref: i64 = 5;
    // Each case: the Handler, the call's settlement, and the target's value
    // after: `got` returns its local, `peek` reads `keep`'s Script Variable.
    for ([_]struct { []const u8, []const u8, i64 }{
        .{ "got", "\"m\":\"answer\",\"value\":37", 37 },
        .{ "got", "\"m\":\"fail\",\"error\":{\"code\":\"nope\"}", 1 },
        .{ "keep", "\"m\":\"answer\",\"value\":9", 9 },
        .{ "keep", "\"m\":\"fail\",\"error\":{\"code\":\"nope\"}", 9 },
    }) |case| {
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"{s}\"}}}}", .{ ref, case[0] }));
        const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{ref + 1});
        const call = pumped.object.get("need").?.object.get("call").?.string;
        _ = try okOf(try c.sendRef(ref + 1, "{{\"m\":\"op-result\",\"ref\":{d},\"started\":true}}", .{ref + 1}));
        _ = try okOf(try c.sendRef(ref + 2, "{{{s},\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\"}}", .{ case[1], ref + 2, call }));
        var end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{ref + 3}));
        if (std.mem.eql(u8, case[0], "keep")) {
            _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"peek\"}}}}", .{ref + 4}));
            end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{ref + 5}));
        }
        try std.testing.expectEqual(case[2], end.object.get("result").?.integer);
        ref += 6;
    }
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

test "object-elements-v1: a collection declaration and its prop needs (#1143)" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const kind = "{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"page\",\"props\":[],\"elements\":{{\"shape\":{{\"object\":\"rect\"}},\"countCost\":{{\"fuel\":1}},\"atCost\":{{\"fuel\":1}},\"findCost\":{{\"fuel\":2}}}}}}";
    // Without opt-in, a collection is refused rather than stripped.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send(kind, .{1})));
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"object-elements-v1\"]}}", .{2}));
    var offered = false;
    for (hello.object.get("features").?.array.items) |f| offered = offered or std.mem.eql(u8, f.string, "object-elements-v1");
    try std.testing.expect(offered);
    _ = try okOf(try c.send(kind, .{3}));
    _ = try okOf(try c.send("{{\"m\":\"define-object-kind\",\"ref\":{d},\"name\":\"rect\",\"props\":[]}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"page\",\"id\":\"p\"}}", .{6}));
    _ = try okOf(try c.send("{{\"m\":\"object\",\"ref\":{d},\"group\":\"g\",\"kind\":\"rect\",\"id\":\"r\"}}", .{7}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on probe o\\n  return [the number of elements of o, element -1 of o, element \\\"a\\\" of o]\\nend probe\\n\"}}", .{8}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"probe\",\"args\":[{{\"$object\":[\"page\",\"p\"]}}]}}}}", .{9}));
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10});
    var need = reply.object.get("need").?;
    try std.testing.expectEqualStrings("elements", need.object.get("prop").?.string);
    try std.testing.expectEqualStrings("count", need.object.get("op").?.string);
    try std.testing.expect(need.object.get("selector") == null);
    reply = try c.sendRef(10, "{{\"m\":\"prop-result\",\"ref\":{d},\"value\":1}}", .{10});
    need = reply.object.get("need").?;
    try std.testing.expectEqualStrings("at", need.object.get("op").?.string);
    try std.testing.expectEqual(@as(i64, -1), need.object.get("selector").?.integer);
    reply = try c.sendRef(10, "{{\"m\":\"prop-result\",\"ref\":{d},\"value\":{{\"$object\":[\"rect\",\"r\"]}}}}", .{10});
    need = reply.object.get("need").?;
    try std.testing.expectEqualStrings("find", need.object.get("op").?.string);
    try std.testing.expectEqualStrings("a", need.object.get("selector").?.string);
    const done = try c.sendRef(10, "{{\"m\":\"prop-result\",\"ref\":{d},\"value\":null}}", .{10});
    const end = try runEnd(done);
    try std.testing.expectEqualStrings("completed", end.object.get("outcome").?.string);
    const items = end.object.get("result").?.array.items;
    try std.testing.expectEqual(@as(i64, 1), items[0].integer);
    try std.testing.expect(items[2] == .null);
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
    // Later Pumps must not replace the pending Call's original Clock.
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00.5Z\"}}", .{80}));
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
    // Group work stays blocked, while a fresh declaration and Grant can
    // be registered for this restore without changing its public name.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{11})));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"handle\":\"new-api\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"args\":[\"number\"],\"result\":\"number\",\"maxPending\":5000}}]}}", .{90}));
    const rebound = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"new-api\",\"ops\":\"all\"}}", .{91}))).object.get("grant").?.integer;
    const restored = try okOf(try c.sendRef(10, "{{\"m\":\"resolve-result\",\"ref\":{d},\"grants\":[{d}],\"objects\":[true]}}", .{ 10, rebound }));
    try std.testing.expect(restored.object.get("variablesOnly").?.bool == false);
    try std.testing.expectEqual(@as(usize, 0), restored.object.get("disposed").?.array.items.len);
    const pending = restored.object.get("pending").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), pending.len);
    try std.testing.expectEqualStrings("s", pending[0].object.get("script").?.string);
    try std.testing.expectEqualStrings("api", pending[0].object.get("grant").?.string);
    try std.testing.expectEqualStrings("fetch", pending[0].object.get("operation").?.string);
    try std.testing.expectEqualStrings("s/r1", pending[0].object.get("run").?.string);
    try std.testing.expectEqualStrings("s/r1.s1", pending[0].object.get("segment").?.string);
    try std.testing.expectEqualStrings("2026-10-10T12:00:00Z", pending[0].object.get("now").?.string);
    try std.testing.expectEqualStrings("api", pending[0].object.get("capability").?.string);
    try std.testing.expectEqualStrings("s", restored.object.get("scripts").?.array.items[0].string);
    try std.testing.expectEqualStrings("hall", restored.object.get("objects").?.array.items[0].array.items[1].string);
    try std.testing.expectEqual(@as(i64, 9), pending[0].object.get("args").?.array.items[0].integer);
    const call = pending[0].object.get("call").?.string;
    _ = try okOf(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"g2\",\"call\":\"{s}\",\"settlement\":{{\"answer\":42}}}}", .{ 12, call }));
    // Settled once only.
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"g2\",\"call\":\"{s}\",\"settlement\":{{\"answer\":1}}}}", .{ 13, call })));
    const end = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g2\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{14}));
    try std.testing.expectEqual(@as(i64, 42), end.object.get("result").?.integer);

    // Reissued Start keeps its Call and pauses until the Host acknowledges it.
    const restore_again = try c.send("{{\"m\":\"restore\",\"ref\":{d},\"group\":\"reissued\",\"name\":\"g\",\"save\":{{\"$bytes\":\"{s}\"}}}}", .{ 30, save });
    _ = restore_again.object.get("need").?;
    const again = try okOf(try c.sendRef(30, "{{\"m\":\"resolve-result\",\"ref\":30,\"grants\":[{d}],\"objects\":[true]}}", .{grant}));
    const reissued = again.object.get("pending").?.array.items[0].object.get("call").?.string;
    const settled_again = try okOf(try c.send("{{\"m\":\"settle\",\"ref\":{d},\"group\":\"reissued\",\"call\":\"{s}\",\"settlement\":{{\"reissue\":true}}}}", .{ 31, reissued }));
    _ = settled_again;
    const starting = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"reissued\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{32});
    const start_need = starting.object.get("need") orelse return unexpected(starting);
    try std.testing.expectEqualStrings("op", start_need.object.get("m").?.string);
    try std.testing.expectEqualStrings(call, start_need.object.get("call").?.string);
    const waiting = try okOf(try c.sendRef(32, "{{\"m\":\"op-result\",\"ref\":32,\"started\":true}}", .{}));
    for (waiting.object.get("reports").?.array.items) |r| try std.testing.expect(!std.mem.eql(u8, r.object.get("kind").?.string, "run end"));
    const answer_again = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"reissued\",\"call\":\"{s}\",\"value\":42}}", .{ 33, reissued }));
    _ = answer_again;
    const answered_again = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"reissued\",\"now\":\"2026-10-10T12:00:01Z\"}}", .{34});
    try std.testing.expectEqual(@as(i64, 42), (try runEnd(answered_again)).object.get("result").?.integer);

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
    try std.testing.expectEqual(@as(usize, 3), parts.len);
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

test "Function error during retains the original opaque token and arguments" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\"}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"script variable caught\\non make n\\n return given x\\n  throw {{code: \\\"mine\\\", value: n + x}}\\n end given\\nend make\\non error e, during msg\\n put msg into caught\\nend error\\n\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"make\",\"args\":[11]}}}}", .{3}));
    const made = (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{4}))).object.get("result").?;
    const fn_json = try std.fmt.allocPrint(c.arena.allocator(), "{f}", .{std.json.fmt(made, .{})});
    _ = try okOf(try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{s},\"args\":[7]}}", .{ 5, fn_json }));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6}));
    const view = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{7}));
    const caught = view.object.get("scripts").?.array.items[0].object.get("vars").?.array.items[0].array.items[1];
    try std.testing.expectEqual(@as(usize, 2), caught.object.count());
    const retained = caught.object.get("fn") orelse return unexpected(caught);
    try std.testing.expectEqualStrings(made.object.get("$function").?.array.items[2].string, retained.object.get("$function").?.array.items[2].string);
    try std.testing.expectEqual(@as(i64, 7), caught.object.get("args").?.array.items[0].integer);
    // The field is still a callable token, rather than a reconstructed display.
    const retained_json = try std.fmt.allocPrint(c.arena.allocator(), "{f}", .{std.json.fmt(retained, .{})});
    _ = try okOf(try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{s},\"args\":[7]}}", .{ 8, retained_json }));
    const failed = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{9}));
    try std.testing.expectEqualStrings("errored", failed.object.get("outcome").?.string);
    try std.testing.expectEqual(@as(i64, 18), failed.object.get("error").?.object.get("value").?.integer);
}

test "core-message-v1 marks Core-raised error maps as $coreError" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\"}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on raised\\n try\\n return 1 / 0\\n catch e\\n return e\\n end try\\nend raised\\non thrown\\n return {{code: \\\"x\\\", message: \\\"mine\\\"}}\\nend thrown\\non echo x\\n return x\\nend echo\"}}", .{2}));
    const raised = "{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"raised\"}}}}";
    const pump = "{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}";
    _ = try okOf(try c.send(raised, .{3}));
    const plain = (try runEnd(try c.send(pump, .{4}))).object.get("result").?;
    try std.testing.expectEqualStrings("division by zero", plain.object.get("code").?.string);
    try std.testing.expect(plain.object.get("message") != null);
    const unnegotiated = try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"echo\",\"args\":[{{\"$coreError\":[[\"code\",\"x\"],[\"message\",\"m\"]]}}]}}}}", .{5});
    try std.testing.expect(unnegotiated.object.get("err") != null);
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"core-message-v1\"]}}", .{6}));
    _ = try okOf(try c.send(raised, .{7}));
    const marked = (try runEnd(try c.send(pump, .{8}))).object.get("result").?.object.get("$coreError").?.array.items;
    try std.testing.expectEqualStrings("code", marked[0].array.items[0].string);
    try std.testing.expectEqualStrings("division by zero", marked[0].array.items[1].string);
    // A Script's own `message` is data, so its map stays plain.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"thrown\"}}}}", .{9}));
    const own = (try runEnd(try c.send(pump, .{10}))).object.get("result").?;
    try std.testing.expectEqualStrings("mine", own.object.get("message").?.string);
    // The mark survives the Host sending the map back.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"echo\",\"args\":[{{\"$coreError\":[[\"code\",\"x\"],[\"message\",\"m\"]]}}]}}}}", .{11}));
    const echoed = (try runEnd(try c.send(pump, .{12}))).object.get("result").?;
    try std.testing.expect(echoed.object.get("$coreError") != null);
    // A `$coreError` without a text `message` is refused.
    const bare = try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"echo\",\"args\":[{{\"$coreError\":[[\"code\",\"x\"]]}}]}}}}", .{13});
    try std.testing.expect(bare.object.get("err") != null);
}

test "function-metadata-v1 adds names and arities without changing opaque tokens" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\"}}", .{1}));
    // The last Lambda captures a Function, so its token must also stay stable
    // when metadata is enabled for nested Function Values.
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"script variable fs\\nfunction double n, m = 1\\n return n * 2\\nend double\\non make\\n put double into f\\n put [f, given [x, y], z: x + y + z, given: 1, given n: f(n)] into fs\\n return fs\\nend make\\non echo x\\n return x\\nend echo\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"make\"}}}}", .{3}));
    const legacy = (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{4}))).object.get("result").?.array.items;
    const unnegotiated = try c.send("{{\"m\":\"script-units\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{40});
    try std.testing.expectEqualStrings("protocol error", try errKind(unnegotiated));
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"function-metadata-v1\"]}}", .{5}));
    var advertised = false;
    for (hello.object.get("features").?.array.items) |f| {
        if (std.mem.eql(u8, f.string, "function-metadata-v1")) advertised = true;
    }
    try std.testing.expect(advertised);
    const sources = try okOf(try c.send("{{\"m\":\"script-units\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\"}}", .{41}));
    try std.testing.expect(sources.object.get("trace") == null);
    const units = sources.object.get("units").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), units.len);
    try std.testing.expectEqualStrings("s", units[0].object.get("name").?.string);
    try std.testing.expect(std.mem.indexOf(u8, units[0].object.get("source").?.string, "function double") != null);
    const seen = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{6}));
    const functions = seen.object.get("scripts").?.array.items[0].object.get("vars").?.array.items[0].array.items[1].array.items;
    for (functions, legacy, 0..) |f, old, i| {
        const parts = f.object.get("$function").?.array.items;
        try std.testing.expectEqual(@as(usize, 7), parts.len);
        try std.testing.expectEqualStrings(units[0].object.get("identity").?.object.get("$bytes").?.string, parts[6].object.get("$bytes").?.string);
        try std.testing.expectEqualStrings(old.object.get("$function").?.array.items[2].string, parts[2].string);
        if (i == 0) {
            try std.testing.expectEqualStrings("double", parts[3].string);
        } else try std.testing.expect(parts[3] == .null);
        try std.testing.expectEqual(([_]i64{ 1, 2, 0, 1 })[i], parts[4].integer);
        try std.testing.expectEqual(([_]i64{ 2, 2, 0, 1 })[i], parts[5].integer);
    }
    var json: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer json.deinit();
    try json.writer.print("{f}", .{std.json.fmt(functions[0], .{})});
    // Both the original three-item form and the extended form remain valid
    // Host inputs.
    _ = try okOf(try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{s},\"args\":[3]}}", .{ 7, json.written() }));
    const called = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8}));
    try std.testing.expectEqual(@as(i64, 6), called.object.get("result").?.integer);
    const token = legacy[0].object.get("$function").?.array.items[2].string;
    _ = try okOf(try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{{\"$function\":[\"s\",\"ignored\",\"{s}\"]}},\"args\":[3]}}", .{ 9, token }));
    const original = try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}));
    try std.testing.expectEqual(@as(i64, 6), original.object.get("result").?.integer);
    // Returned metadata cannot change the Function identified by a token.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"echo\",\"args\":[{{\"$function\":[\"s\",\"ignored\",\"{s}\",null,0,0]}}]}}}}", .{ 11, token }));
    const echoed = (try runEnd(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{12}))).object.get("result").?.object.get("$function").?.array.items;
    try std.testing.expectEqualStrings("double", echoed[3].string);
    try std.testing.expectEqual(@as(i64, 1), echoed[4].integer);
    try std.testing.expectEqual(@as(i64, 2), echoed[5].integer);
    for ([_][]const u8{ "true,1,1", "null,-1,1", "null,2,1", "null,1.5,2", "null,1,1,1" }) |metadata| {
        const refused = try c.send("{{\"m\":\"call\",\"ref\":{d},\"group\":\"g\",\"fn\":{{\"$function\":[\"s\",\"ignored\",\"{s}\",{s}]}}}}", .{ 13, token, metadata });
        try std.testing.expectEqualStrings("invalid value", refused.object.get("err").?.object.get("code").?.string);
    }
}

test "a Host Command's `command` flag is declared, validated and called through frames" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{0}));
    // Only a Boolean, and never on a Reserved Word.
    for ([_][]const u8{ "{\"name\":\"read\",\"mode\":\"immediate\",\"result\":\"number\",\"command\":\"yes\"}", "{\"name\":\"if\",\"mode\":\"immediate\",\"result\":\"number\",\"command\":true}" }) |op| {
        const refused = try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"bad\",\"ops\":[{s}]}}", .{ 1, op });
        try std.testing.expectEqualStrings("invalid value", refused.object.get("err").?.object.get("code").?.string);
    }
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"result\":\"number\",\"command\":true}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go\\n read\\n return it\\nend go\"}}", .{ 4, grant.object.get("grant").?.integer }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{6});
    _ = pumped.object.get("need") orelse return unexpected(pumped);
    const end = try runEnd(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"result\":7}}", .{}));
    try std.testing.expectEqual(@as(i64, 7), end.object.get("result").?.integer);
    // A Library resolves it against its declarations, which carry the flag.
    const frame = "{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"{s}\",\"version\":\"1\",\"source\":\"function f\\n  read\\n  return it\\nend f\\n\",\"declarations\":{{\"api\":{{\"read\":{{\"mode\":\"immediate\",\"command\":{s}}}}}}}}}";
    _ = try okOf(try c.send(frame, .{ 7, "util", "true" }));
    const bad = try c.send(frame, .{ 8, "other", "1" });
    try std.testing.expectEqualStrings("invalid value", bad.object.get("err").?.object.get("code").?.string);
}

test "Argument Labels are declared, validated and checked through frames (ADR 0115)" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{0}));
    // Only a list of Argument Label words, one per argument after the first.
    for ([_][]const u8{ "\"to\"", "[\"to\",\"by\"]", "[\"from\"]", "[\"with\"]", "[\"if\"]", "[1]", "[\"a b\"]" }) |labels| {
        const refused = try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"bad\",\"ops\":[{{\"name\":\"move\",\"mode\":\"immediate\",\"args\":[\"text\",\"text\"],\"result\":\"text\",\"labels\":{s}}}]}}", .{ 1, labels });
        try std.testing.expectEqualStrings("invalid value", refused.object.get("err").?.object.get("code").?.string);
    }
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"none\",\"ops\":[{{\"name\":\"move\",\"mode\":\"immediate\",\"args\":[\"text\",\"text\"],\"result\":\"text\",\"labels\":[]}}]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"world\",\"ops\":[{{\"name\":\"move\",\"mode\":\"immediate\",\"args\":[\"text\",\"text\"],\"result\":\"text\",\"labels\":[\"to\"]}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"world\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    const broken = try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"bad\",\"grants\":{{\"world\":{d}}},\"source\":\"on go\\n  ask world to move 1 at \\\"b\\\"\\nend go\"}}", .{ 4, grant });
    const diagnostics = broken.object.get("err").?.object.get("diagnostics").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), diagnostics.len);
    try std.testing.expectEqualStrings("wrong argument", diagnostics[0].object.get("code").?.string);
    try std.testing.expectEqualStrings("wrong labels", diagnostics[1].object.get("code").?.string);
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"world\":{d}}},\"source\":\"on go\\n  ask world to move \\\"a\\\" to \\\"b\\\"\\n  return it\\nend go\"}}", .{ 5, grant }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{6}));
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{7});
    // The op need is positional, as for `move "a", "b"`.
    const need = pumped.object.get("need") orelse return unexpected(pumped);
    try std.testing.expectEqual(@as(usize, 2), need.object.get("args").?.array.items.len);
    const end = try runEnd(try c.sendRef(7, "{{\"m\":\"op-result\",\"ref\":7,\"result\":\"moved\"}}", .{}));
    try std.testing.expectEqualStrings("moved", end.object.get("result").?.string);
    // A Library is checked against its declarations' labels, and they must
    // be valid.
    const frame = "{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"{s}\",\"version\":\"1\",\"source\":\"on route a, b\\n  ask world to move a to b\\n  return it\\nend route\\n\",\"declarations\":{{\"world\":{{\"move\":{{\"mode\":\"immediate\",\"args\":[\"text\",\"text\"],\"labels\":{s}}}}}}}}}";
    _ = try okOf(try c.send(frame, .{ 8, "router", "[\"to\"]" }));
    const refused = try c.send(frame, .{ 9, "other", "[\"toward\"]" });
    try std.testing.expect(refused.object.get("err").?.object.get("diagnostics").?.array.items.len == 1);
    const invalid = try c.send(frame, .{ 10, "third", "[\"with\"]" });
    try std.testing.expectEqualStrings("invalid value", invalid.object.get("err").?.object.get("code").?.string);
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
    const frame = "{{\"m\":\"export-manifest\",\"ref\":{d},\"kind\":\"door\",\"version\":\"2\",\"grants\":{{\"api\":{d}}},\"libraries\":[{{\"$bytes\":\"{s}\"}}],\"messages\":[{{\"name\":\"open\",\"args\":[\"text\"],\"receivers\":[\"room\"],\"description\":\"Opens the door.\",\"examples\":[\"open \\\"now\\\"\"]}}],\"objectKinds\":[\"room\"],\"objects\":{{\"here\":\"room\"}}}}";
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
    const open = m.get("messages").?.array.items[0].object;
    try std.testing.expectEqualStrings("Opens the door.", open.get("description").?.string);
    try std.testing.expectEqualStrings("open \"now\"", open.get("examples").?.array.items[0].string);
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

test "Library replacement finishes after the importer's release hook" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"release\":true,\"ops\":[{{\"name\":\"touch\",\"mode\":\"immediate\",\"result\":\"nothing\"}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    const old = (try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"user\",\"source\":\"function one\\nreturn 1\\nend one\\n\"}}", .{3}))).object.get("identity").?.object.get("$bytes").?.string;
    const fresh = (try okOf(try c.send("{{\"m\":\"compile-library\",\"ref\":{d},\"name\":\"user\",\"source\":\"function one\\nreturn 2\\nend one\\n\"}}", .{4}))).object.get("identity").?.object.get("$bytes").?.string;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{5}));
    _ = try okOf(try c.send("{{\"m\":\"add-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}}}}", .{ 6, old }));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"use one from user\\non go\\nask api to touch\\nreturn one()\\nend go\\n\"}}", .{ 7, grant }));
    const reply = try c.send("{{\"m\":\"replace-library\",\"ref\":{d},\"group\":\"g\",\"identity\":{{\"$bytes\":\"{s}\"}},\"carry\":\"reset variables\"}}", .{ 8, fresh });
    try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
    try std.testing.expectEqualStrings("reload", reply.object.get("need").?.object.get("reason").?.string);
    const done = try okOf(try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":{d}}}", .{8}));
    try std.testing.expect(done.object.get("reports").? == .array);
    // The importer was reloaded against the new Library, not left stopped.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{9}));
    var pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10});
    try std.testing.expectEqualStrings("touch", pumped.object.get("need").?.object.get("operation").?.string);
    pumped = try c.sendRef(10, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":null}}", .{10});
    try std.testing.expectEqual(@as(i64, 2), (try runEnd(pumped)).object.get("result").?.integer);
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

test "hello opt-in publishes abandonment on release before a held final reply" {
    for ([_]bool{ false, true }) |early| {
        const session_instance = Session.init(std.testing.allocator).?;
        defer session_instance.deinit();
        var c = Client.init(session_instance);
        defer c.deinit();
        // A refused feature list must not partially enable its valid prefix.
        const refused = try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"abandoned-before-needs-v1\",\"unknown\"]}}", .{0});
        try std.testing.expectEqualStrings("protocol error", try errKind(refused));
        if (early) {
            const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"abandoned-before-needs-v1\"]}}", .{0}));
            var advertised = false;
            for (hello.object.get("features").?.array.items) |feature| if (std.mem.eql(u8, feature.string, "abandoned-before-needs-v1")) {
                advertised = true;
            };
            try std.testing.expect(advertised);
            // Version refresh does not revoke an already activated feature.
            _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{0}));
        }
        const defined = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"release\":true,\"ops\":[{{\"name\":\"read\",\"mode\":\"suspending\",\"result\":\"number\"}}]}}", .{1}));
        _ = defined;
        const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
        const created = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
        _ = created;
        const loaded = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go\\n ask api to read and wait\\nend go\"}}", .{ 4, grant.object.get("grant").?.integer }));
        _ = loaded;
        const requested = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
        _ = requested;
        const started = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T12:00:00Z\"}}", .{6});
        const call = started.object.get("need").?.object.get("call").?.string;
        _ = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"started\":true}}", .{}));
        const stopped = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}}", .{7}));
        _ = stopped;
        const releasing = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T12:00:00Z\"}}", .{8});
        try std.testing.expectEqualStrings("release", releasing.object.get("need").?.object.get("m").?.string);
        if (early) {
            const ids = releasing.object.get("abandoned").?.array.items;
            try std.testing.expectEqual(@as(usize, 1), ids.len);
            try std.testing.expectEqualStrings(call, ids[0].string);
        } else try std.testing.expect(releasing.object.get("abandoned") == null);
        const wrong = try c.sendRef(9, "{{\"m\":\"release-result\",\"ref\":9}}", .{});
        try std.testing.expectEqualStrings("protocol error", try errKind(wrong));
        try std.testing.expect(wrong.object.get("abandoned") == null);
        const done = try okOf(try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":8}}", .{}));
        const final_ids = done.object.get("abandoned").?.array.items;
        try std.testing.expectEqual(@as(usize, if (early) 0 else 1), final_ids.len);
        if (!early) try std.testing.expectEqualStrings(call, final_ids[0].string);
    }
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
    const entry = s.groups.values()[0];
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

/// Replay the max-join-minimum pattern through actual Operation and Trace needs.
/// Return all Pump records, whose order and accounting must not depend on opt-in.
fn joinLimitTrace(observe: bool, limit: usize, members: usize) ![]u8 {
    const t = std.testing;
    const s = Session.init(t.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":{s}}}", .{ 0, if (observe) @as([]const u8, "[\"crossing-trace-v1\"]") else "[]" }));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"feed\",\"ops\":[{{\"name\":\"fetch\",\"mode\":\"suspending\",\"args\":[\"number\"],\"result\":\"number\"}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"feed\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"trace\":true}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"fanout\",\"limits\":{{\"maxJoin\":{d}}},\"grants\":{{\"feed\":{d}}},\"source\":\"on fan k\\n  wait for all\\n    repeat for each i in 1..k\\n      ask feed to fetch i and wait\\n    end repeat\\n  end wait\\n  return it\\nend fan\\n\"}}", .{ 4, limit, grant }));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"fanout\"}},\"message\":{{\"name\":\"fan\",\"args\":[{d}]}}}}", .{ 5, members }));
    var out: std.Io.Writer.Allocating = .init(t.allocator);
    defer out.deinit();
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"1970-01-01T00:00:00Z\"}}", .{6});
    var calls: usize = 0;
    var observations: usize = 0;
    while (true) {
        const body = reply.object.get("ok") orelse reply;
        if (body.object.get("trace")) |lines| for (lines.array.items) |line| try out.writer.print("{s}\n", .{line.string});
        const need = reply.object.get("need") orelse break;
        if (std.mem.eql(u8, need.object.get("m").?.string, "trace")) {
            observations += 1;
            try t.expect(observe and observations <= calls);
            reply = try c.sendRef(6, "{{\"m\":\"trace-result\",\"ref\":6}}", .{});
        } else {
            try t.expectEqualStrings("op", need.object.get("m").?.string);
            calls += 1;
            try t.expect(calls <= @min(limit, members));
            try t.expectEqual(@as(i64, @intCast(calls)), need.object.get("args").?.array.items[0].integer);
            reply = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"started\":true}}", .{});
        }
    }
    const done = try okOf(reply);
    try t.expectEqual(@min(limit, members), calls);
    try t.expectEqual(if (observe) calls else 0, observations);
    if (members > limit) {
        const end = try runEnd(reply);
        try t.expectEqualStrings("limit fault", end.object.get("outcome").?.string);
        try t.expectEqualStrings("join", end.object.get("limit").?.string);
    } else {
        for (done.object.get("reports").?.array.items) |report| {
            if (std.mem.eql(u8, report.object.get("kind").?.string, "run end")) return unexpected(reply);
        }
        try t.expect(std.mem.indexOf(u8, out.written(), "end=join-end") != null);
    }
    // Chapter 6's conformance minimum, including the issue's Fuel figures.
    if (limit == 256 and members >= limit) {
        try t.expectEqual(@as(i64, if (members == limit) 3873 else 3864), done.object.get("fuelUsed").?.integer);
    }
    return out.toOwnedSlice();
}

test "crossing Trace observation preserves the exact Join limit" {
    // Limit 2 covers each boundary; 256 pins the issue's Fuel figures.
    for ([_][2]usize{ .{ 2, 1 }, .{ 2, 2 }, .{ 2, 3 }, .{ 256, 256 }, .{ 256, 257 } }) |case| {
        const limit, const members = case;
        const ordinary = try joinLimitTrace(false, limit, members);
        defer std.testing.allocator.free(ordinary);
        const observed = try joinLimitTrace(true, limit, members);
        defer std.testing.allocator.free(observed);
        try std.testing.expectEqualStrings(ordinary, observed);
    }
}

test "opt-in Operation Trace observation admits controls before result conversion" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"crossing-trace-v1\"]}}", .{0}));
    const need = try pausedFixture(&c, "immediate", "script variable n = 0\non go\n put 8 into n\n ask api to read\n return n\nend go", false);
    _ = need;
    const observed = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"result\":\"wrong Shape\"}}", .{});
    try std.testing.expectEqualStrings("trace", observed.object.get("need").?.object.get("m").?.string);
    const lines = observed.object.get("trace").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), lines.len);
    try std.testing.expect(std.mem.startsWith(u8, lines[0].string, "call s/r1.c1"));
    const wrong = try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"result\":1}}", .{});
    try std.testing.expectEqualStrings("protocol error", wrong.object.get("err").?.object.get("kind").?.string);
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"Trace sink\"}}", .{7}));
    const done = try c.sendRef(6, "{{\"m\":\"trace-result\",\"ref\":6}}", .{});
    for ((try okOf(done)).object.get("reports").?.array.items) |r| {
        try std.testing.expect(!std.mem.eql(u8, r.object.get("kind").?.string, "call failed"));
    }
    const inspected = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{8}));
    const vars = inspected.object.get("scripts").?.array.items[0].object.get("vars").?.array.items;
    try std.testing.expectEqual(@as(i64, 0), vars[0].array.items[1].integer);
}

test "opt-in error replies carry their own Trace before another input" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"crossing-trace-v1\"]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"trace\":true}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T12:00:00Z\"}}", .{3}));
    const refused = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-14T12:00:00Z\"}}", .{4});
    try std.testing.expectEqualStrings("clock backwards", refused.object.get("err").?.object.get("code").?.string);
    const lines = refused.object.get("trace").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), lines.len);
    try std.testing.expectEqualStrings("refused code=\"clock backwards\"", lines[1].string);
    const after = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g\"}}", .{5}));
    try std.testing.expectEqual(@as(usize, 1), after.object.get("trace").?.array.items.len);
}

test "an enqueued answer keeps cancellation observable until its Run consumes it" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"abandoned-before-needs-v1\"]}}", .{0}));
    const need = try pausedFixture(&c, "suspending", "on go\n ask api to read and wait\nend go", false);
    const id = need.object.get("call").?.string;
    _ = try okOf(try c.sendRef(6, "{{\"m\":\"op-result\",\"ref\":6,\"started\":true}}", .{}));
    _ = try okOf(try c.send("{{\"m\":\"answer\",\"ref\":{d},\"group\":\"g\",\"call\":\"{s}\",\"value\":1}}", .{ 7, id }));
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}}", .{8}));
    const done = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{9}));
    const ids = done.object.get("abandoned").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), ids.len);
    try std.testing.expectEqualStrings(id, ids[0].string);
    const after = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10}));
    try std.testing.expectEqual(@as(usize, 0), after.object.get("abandoned").?.array.items.len);
}

test "inline input admission observes complete records before the producer advances" {
    const Host = struct {
        var events: std.ArrayList([]u8) = .empty;
        var stopped: bool = false;
        fn exchange(event: []const u8) ?[]const u8 {
            const own = std.testing.allocator.dupe(u8, event) catch return null;
            events.append(std.testing.allocator, own) catch {
                std.testing.allocator.free(own);
                return null;
            };
            if (!stopped and std.mem.indexOf(u8, event, "> pump clock=") != null) {
                stopped = true;
                return "{\"m\":\"stop\",\"ref\":80,\"group\":\"g\",\"script\":\"s\",\"reason\":\"sink\"}";
            }
            return "null";
        }
    };
    Host.events = .empty;
    Host.stopped = false;
    defer {
        for (Host.events.items) |event| std.testing.allocator.free(event);
        Host.events.deinit(std.testing.allocator);
    }
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    s.inline_io = Host.exchange;
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"inline-inputs-v1\"]}}", .{1}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"trace\":true}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on go\\n return 7\\nend go\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{4}));
    const pumped = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-15T12:00:00Z\"}}", .{5}));
    try std.testing.expectEqualStrings("stopped", pumped.object.get("state").?.string);
    const want = [_][]const u8{ "> load ", "> request ", "> pump ", "seg ", "run ", "> stop ", "stopped ", "pumped " };
    var at: usize = 0;
    var replies: usize = 0;
    for (Host.events.items) |event| {
        const parsed = try std.json.parseFromSlice(Json, std.testing.allocator, event, .{});
        defer parsed.deinit();
        if (parsed.value.object.get("reply")) |reply| {
            try std.testing.expectEqual(@as(i64, 80), reply.object.get("ref").?.integer);
            _ = try okOf(reply);
            replies += 1;
        }
        if (parsed.value.object.get("trace")) |lines| for (lines.array.items) |line| {
            try std.testing.expect(at < want.len);
            try std.testing.expect(std.mem.startsWith(u8, line.string, want[at]));
            at += 1;
        };
    }
    try std.testing.expectEqual(want.len, at);
    try std.testing.expectEqual(@as(usize, 1), replies);
    // A worker refused by the binding during an export stays refused even
    // when its frame is serviced at the export's completed boundary.
    const late = try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"late\",\"source\":\"\",\"refuseWorker\":true}}", .{6});
    try std.testing.expectEqualStrings("reentrant call", late.object.get("err").?.object.get("code").?.string);
    try std.testing.expect(Direct.groupScript(s.groupNamed("g").?.group, "late", 4) == null);
}

test "analysis-v1 serves Session language analysis after opt-in" {
    const t = std.testing;
    const s = Session.init(t.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    // Closed until the Host asks for it.
    try t.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"analyze-entry\",\"ref\":{d},\"source\":\"1\"}}", .{0})));
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"analysis-v1\"]}}", .{1}));
    const put = try okOf(try c.send("{{\"m\":\"analyze-entry\",\"ref\":{d},\"source\":\"greet total\",\"handlers\":[\"greet\"],\"bound\":[]}}", .{2}));
    try t.expectEqualStrings("statement", put.object.get("kind").?.string);
    try t.expectEqualStrings("none", put.object.get("doc").?.string);
    const roots = try okOf(try c.send("{{\"m\":\"analyze-entry\",\"ref\":{d},\"source\":\"put 1 into total\",\"bound\":[\"count\"]}}", .{3}));
    try t.expectEqualStrings("total", roots.object.get("implicit").?.array.items[0].string);
    const open = try okOf(try c.send("{{\"m\":\"analyze-entry\",\"ref\":{d},\"source\":\"--| Doubles.\\nfunction double x\"}}", .{4}));
    try t.expectEqualStrings("attached", open.object.get("doc").?.string);
    try t.expect(open.object.get("problem").?.object.get("incomplete").?.bool);
    const decls = try okOf(try c.send("{{\"m\":\"analyze-source\",\"ref\":{d},\"source\":\"--| Doubles.\\nfunction double x\\n  return x * 2\\nend double\\n\"}}", .{5}));
    const d = decls.object.get("declarations").?.array.items[0].object;
    try t.expectEqualStrings("function double x", d.get("signature").?.string);
    try t.expectEqualStrings("Doubles.", d.get("doc").?.string);
    try t.expectEqual(@as(i64, 4), d.get("span").?.object.get("endLine").?.integer);
    const catalogue = try okOf(try c.send("{{\"m\":\"analysis-catalogue\",\"ref\":{d}}}", .{6}));
    try t.expect(catalogue.object.get("builtins").?.array.items.len > 0);
    try t.expect(catalogue.object.get("libraries").?.array.items.len > 0);
    try t.expect(std.mem.indexOf(u8, catalogue.object.get("inspectReader").?.string, "entry0") != null);
    const named = try okOf(try c.send("{{\"m\":\"message-name\",\"ref\":{d},\"name\":\"move:to:\",\"arity\":2}}", .{7}));
    try t.expect(named.object.get("valid").?.bool);
    try t.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"analyze-entry\",\"ref\":{d},\"source\":\"1\",\"bound\":[1]}}", .{8})));
}

test "every analysis exchange requires opt-in and validates its fields" {
    const t = std.testing;
    const s = Session.init(t.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const requests = [_][]const u8{
        "\"m\":\"analyze-entry\",\"source\":\"1\"",
        "\"m\":\"analyze-source\",\"source\":\"\"",
        "\"m\":\"analysis-catalogue\"",
        "\"m\":\"message-name\",\"name\":\"go\",\"arity\":0",
    };
    // An ordinary hello advertises the feature but does not open it.
    const hello = try okOf(try c.send("{{\"ref\":{d},\"m\":\"hello\",\"protocol\":1}}", .{1}));
    var advertised = false;
    for (hello.object.get("features").?.array.items) |f| {
        if (std.mem.eql(u8, f.string, "analysis-v1")) advertised = true;
    }
    try t.expect(advertised);
    for (requests) |request| {
        try t.expectEqualStrings("protocol error", try errKind(try c.send("{{\"ref\":{d},{s}}}", .{ 2, request })));
    }
    _ = try okOf(try c.send("{{\"ref\":{d},\"m\":\"hello\",\"protocol\":1,\"features\":[\"analysis-v1\"]}}", .{3}));
    const malformed = [_][]const u8{
        "\"m\":\"analyze-entry\"",
        "\"m\":\"analyze-entry\",\"source\":1",
        "\"m\":\"analyze-entry\",\"source\":\"1\",\"handlers\":null",
        "\"m\":\"analyze-entry\",\"source\":\"1\",\"handlers\":[false]",
        "\"m\":\"analyze-entry\",\"source\":\"1\",\"bound\":\"x\"",
        "\"m\":\"analyze-entry\",\"source\":\"1\",\"bound\":[1]",
        "\"m\":\"analyze-source\"",
        "\"m\":\"analyze-source\",\"source\":[]",
        "\"m\":\"message-name\",\"arity\":0",
        "\"m\":\"message-name\",\"name\":1,\"arity\":0",
        "\"m\":\"message-name\",\"name\":\"go\"",
        "\"m\":\"message-name\",\"name\":\"go\",\"arity\":-1",
        "\"m\":\"message-name\",\"name\":\"go\",\"arity\":1.5",
    };
    for (malformed) |request| {
        const reply = try c.send("{{\"ref\":{d},{s}}}", .{ 4, request });
        try t.expectEqualStrings("host error", try errKind(reply));
        try t.expectEqualStrings("invalid value", reply.object.get("err").?.object.get("code").?.string);
    }
    // Refusals leave every exchange usable, without creating a Group or Trace.
    for (requests) |request| {
        const reply = try c.send("{{\"ref\":{d},{s}}}", .{ 5, request });
        _ = try okOf(reply);
        if (reply.object.get("trace")) |lines| try t.expectEqual(@as(usize, 0), lines.array.items.len);
    }
    try t.expectEqual(@as(usize, 0), s.groups.count());
}

test "analysis reports positioned syntax errors and ordered implicit bindings" {
    const t = std.testing;
    const s = Session.init(t.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"ref\":{d},\"m\":\"hello\",\"protocol\":1,\"features\":[\"analysis-v1\"]}}", .{1}));
    const entry_error = try okOf(try c.send("{{\"ref\":{d},\"m\":\"analyze-entry\",\"source\":\"if true then\\nput 1 into\"}}", .{2}));
    const p = entry_error.object.get("problem").?.object;
    try t.expect(p.get("code").?.string.len > 0);
    try t.expectEqual(@as(i64, 2), p.get("line").?.integer);
    try t.expectEqual(@as(i64, 11), p.get("col").?.integer);
    try t.expect(p.get("incomplete").?.bool);
    try t.expect(!p.get("trailing").?.bool);
    const source_error = try okOf(try c.send("{{\"ref\":{d},\"m\":\"analyze-source\",\"source\":\"constant x = 1\\nconstant y = )\"}}", .{3}));
    const q = source_error.object.get("problem").?.object;
    try t.expectEqual(@as(i64, 2), q.get("line").?.integer);
    try t.expectEqual(@as(i64, 14), q.get("col").?.integer);
    try t.expect(!q.get("incomplete").?.bool);
    try t.expect(source_error.object.get("declarations") == null);
    const roots = try okOf(try c.send("{{\"ref\":{d},\"m\":\"analyze-entry\",\"source\":\"if true then\\n put 1 into z\\n put 2 into existing\\n put 3 into a\\n put 4 into z\\nend if\",\"bound\":[\"existing\"]}}", .{4}));
    const names = roots.object.get("implicit").?.array.items;
    try t.expectEqual(@as(usize, 2), names.len);
    try t.expectEqualStrings("z", names[0].string);
    try t.expectEqualStrings("a", names[1].string);
    const trailing = try okOf(try c.send("{{\"ref\":{d},\"m\":\"analyze-entry\",\"source\":\"1 2\"}}", .{5}));
    try t.expect(trailing.object.get("problem").?.object.get("trailing").?.bool);
    const pending = try okOf(try c.send("{{\"ref\":{d},\"m\":\"analyze-entry\",\"source\":\"--| Documentation.\"}}", .{6}));
    try t.expectEqualStrings("empty", pending.object.get("kind").?.string);
    try t.expectEqualStrings("pending", pending.object.get("doc").?.string);
}

test "message-name validates names, labels and argument counts" {
    const t = std.testing;
    const s = Session.init(t.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"ref\":{d},\"m\":\"hello\",\"protocol\":1,\"features\":[\"analysis-v1\"]}}", .{1}));
    for ([_]struct { name: []const u8, arity: usize, valid: bool }{
        .{ .name = "go", .arity = 0, .valid = true },
        .{ .name = "go", .arity = 3, .valid = true },
        .{ .name = "move:to:", .arity = 2, .valid = true },
        .{ .name = "move:to:", .arity = 1, .valid = false },
        .{ .name = "move:", .arity = 1, .valid = false },
        .{ .name = "move:to", .arity = 2, .valid = false },
        .{ .name = "", .arity = 0, .valid = false },
        .{ .name = "two words", .arity = 0, .valid = false },
        .{ .name = "if", .arity = 0, .valid = false },
    }) |case| {
        const reply = try okOf(try c.send("{{\"ref\":{d},\"m\":\"message-name\",\"name\":\"{s}\",\"arity\":{d}}}", .{ 2, case.name, case.arity }));
        try t.expectEqual(case.valid, reply.object.get("valid").?.bool);
    }
}

test "group-exchanges-v1 pauses each Group's Pump on its own and drop-group frees an idle Group" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"group-exchanges-v1\"]}}", .{1}));
    var offered = false;
    for (hello.object.get("features").?.array.items) |f| offered = offered or std.mem.eql(u8, f.string, "group-exchanges-v1");
    try std.testing.expect(offered);
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"double\",\"mode\":\"immediate\",\"args\":[\"number\"],\"result\":\"number\"}}]}}", .{2}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{3}))).object.get("grant").?.integer;
    inline for (.{ "a", "b" }, 0..) |g, i| {
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"name\":\"" ++ g ++ "\",\"trace\":false}}", .{10 + i}));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on double n\\n  ask api to double n\\n  return it + 1\\nend double\\n\"}}", .{ 20 + i, grant }));
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"double\",\"args\":[{d}]}}}}", .{ 30 + i, 10 * (i + 1) }));
    }
    // Both Groups pause at their crossings at once.
    const a = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"a\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{40});
    try std.testing.expectEqual(@as(i64, 10), a.object.get("need").?.object.get("args").?.array.items[0].integer);
    const b = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"b\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{41});
    try std.testing.expectEqual(@as(i64, 20), b.object.get("need").?.object.get("args").?.array.items[0].integer);
    // The paused Group refuses another worker; Core-level frames carry on;
    // a restore and dropping a paused Group wait for every exchange.
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"a\"}}", .{42})));
    _ = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{43}));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"restore\",\"ref\":{d},\"name\":\"r\",\"save\":{{\"$bytes\":\"\"}},\"libraries\":[],\"mismatch\":\"reject\",\"trace\":false}}", .{44})));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"drop-group\",\"ref\":{d},\"group\":\"a\"}}", .{45})));
    // Results land in the exchange their Group names, in either order.
    const done_b = try c.sendRef(41, "{{\"m\":\"op-result\",\"ref\":{d},\"group\":\"b\",\"result\":40}}", .{41});
    try std.testing.expectEqual(@as(i64, 41), (try runEnd(done_b)).object.get("result").?.integer);
    const done_a = try c.sendRef(40, "{{\"m\":\"op-result\",\"ref\":{d},\"group\":\"a\",\"result\":20}}", .{40});
    try std.testing.expectEqual(@as(i64, 21), (try runEnd(done_a)).object.get("result").?.integer);
    // An idle Group drops; its handle is then unknown, and reusable.
    _ = try okOf(try c.send("{{\"m\":\"drop-group\",\"ref\":{d},\"group\":\"a\"}}", .{50}));
    try std.testing.expectEqualStrings("host error", try errKind(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"a\"}}", .{51})));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"a\",\"name\":\"a\",\"trace\":false}}", .{52}));
    _ = try okOf(try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"b\"}}", .{53}));
}

test "without group-exchanges-v1 one paused Pump holds every Group and drop-group is unknown" {
    const gpa = std.testing.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"double\",\"mode\":\"immediate\",\"args\":[\"number\"],\"result\":\"number\"}}]}}", .{1}));
    const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}))).object.get("grant").?.integer;
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"drop-group\",\"ref\":{d},\"group\":\"a\"}}", .{3})));
    inline for (.{ "a", "b" }, 0..) |g, i| {
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"name\":\"" ++ g ++ "\",\"trace\":false}}", .{10 + i}));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on double n\\n  ask api to double n\\n  return it + 1\\nend double\\n\"}}", .{ 20 + i, grant }));
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"" ++ g ++ "\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"double\",\"args\":[1]}}}}", .{30 + i}));
    }
    _ = (try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"a\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{40})).object.get("need").?;
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"b\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{41})));
    _ = try runEnd(try c.sendRef(40, "{{\"m\":\"op-result\",\"ref\":{d},\"result\":2}}", .{40}));
}

// ------------------------------------- binary Request/Pump exchange tests

/// Views a binary reply as JSON: records by their field names, Reports
/// with their JSON `kind`, and Value items other than scalars as
/// `{"$raw": bytes}`. A JSON reply is parsed as it is.
fn binReply(c: *Client, frame: []const u8) !Json {
    const a = c.arena.allocator();
    const sent = handle(c.s, frame);
    defer freeReply(c.s.gpa, sent);
    const reply = try a.dupe(u8, sent);
    if (!std.mem.startsWith(u8, reply, rp.prefix)) return (try std.json.parseFromSlice(Json, a, reply, .{})).value;
    try std.testing.expectEqual(rp.layout_fields, reply[rp.prefix.len]);
    var r: rp.Reader = .{ .data = reply[rp.prefix.len + 1 ..] };
    var v: Json = undefined;
    if (reply[rp.prefix.len + 1] >= @backingInt(rp.Callback.op)) {
        // A callback need, viewed as its JSON envelope.
        const c_ = std.enums.fromInt(rp.Callback, try r.byte()) orelse return error.TestUnexpectedResult;
        var need = try viewRecord(a, &r, rp.fields(c_));
        try std.testing.expect(r.done());
        v = .{ .object = .empty };
        for ([_][]const u8{ "ref", "abandoned", "settled", "trace" }) |k| if (need.object.fetchSwapRemove(k)) |kv| try v.object.put(a, k, kv.value);
        try need.object.put(a, "m", .{ .string = @tagName(c_) });
        try v.object.put(a, "need", need);
        try v.object.put(a, "binary", .{ .string = "need" });
        return v;
    }
    const m = std.enums.fromInt(rp.Message, try r.byte()) orelse return error.TestUnexpectedResult;
    v = try viewRecord(a, &r, rp.fields(m));
    try v.object.put(a, "binary", .{ .string = if (m == .admission) "admission" else "completion" });
    try std.testing.expect(r.done());
    return v;
}

fn viewRecord(a: Allocator, r: *rp.Reader, names: []const []const u8) anyerror!Json {
    if (try r.byte() != rp.tag.list or try r.uint() != names.len) return error.TestUnexpectedResult;
    var obj: std.json.ObjectMap = .empty;
    for (names) |n| {
        const v = try viewItem(a, r, std.mem.eql(u8, n, "reports"));
        if (v != .null) try obj.put(a, n, v);
    }
    return .{ .object = obj };
}

fn viewItem(a: Allocator, r: *rp.Reader, positional_reports: bool) anyerror!Json {
    const start = r.at;
    switch (try r.byte()) {
        0x00 => return .null,
        0x01 => return .{ .bool = false },
        0x02 => return .{ .bool = true },
        0x03 => return .{ .integer = @intCast(try r.uint()) },
        0x10 => return .{ .integer = -@as(i64, @intCast(try r.uint())) },
        0x04, 0x05, 0x12 => return .{ .string = try r.bytes() },
        0x0b => {
            const u = try r.uint();
            return .{ .integer = @as(i64, @intCast(u >> 1)) ^ -@as(i64, @intCast(u & 1)) };
        },
        0x06 => {
            var xs = std.json.Array.init(a);
            for (0..try r.uint()) |_| {
                if (positional_reports) {
                    const kind = std.enums.fromInt(rp.Report, try r.byte()) orelse return error.TestUnexpectedResult;
                    var rec = try viewRecord(a, r, rp.fields(kind));
                    try rec.object.put(a, "kind", .{ .string = kind.kind() });
                    try xs.append(rec);
                } else try xs.append(try viewItem(a, r, false));
            }
            return .{ .array = xs };
        },
        0x07 => {
            var obj: std.json.ObjectMap = .empty;
            for (0..try r.uint()) |_| {
                if (try r.byte() != rp.tag.text) return error.TestUnexpectedResult;
                const k = try r.bytes();
                try obj.put(a, k, try viewItem(a, r, false));
            }
            return .{ .object = obj };
        },
        else => {
            r.at = start;
            var obj: std.json.ObjectMap = .empty;
            try obj.put(a, "$raw", .{ .string = try r.skip() });
            return .{ .object = obj };
        },
    }
}

/// Starts a binary input frame.
fn binInput(w: *rp.Writer, m: rp.Message, ref: i64, group: []const u8) !void {
    try w.header();
    try w.byte(@backingInt(m));
    try w.begin(rp.fields(m), true);
    try w.key("ref");
    try w.int(ref);
    try w.key("group");
    try w.ptext(group);
}

/// A Request or request-pump input, with the Script, message and arguments.
fn binRequest(a: Allocator, m: rp.Message, ref: i64, token: u64, script: []const u8, name: []const u8, args: []const i64, now_s: i64) ![]u8 {
    return binRequestTo(a, m, ref, "g", token, script, name, args, now_s);
}

fn binRequestTo(a: Allocator, m: rp.Message, ref: i64, group: []const u8, token: u64, script: []const u8, name: []const u8, args: []const i64, now_s: i64) ![]u8 {
    var w = rp.Writer.init(a);
    defer w.deinit();
    try binInput(&w, m, ref, group);
    if (token != 0) {
        try w.key("token");
        try w.int(token);
    }
    try w.key("to");
    try w.begin(&.{}, false);
    try w.key("script");
    try w.ptext(script);
    try w.end();
    try w.key("message");
    try w.begin(&.{}, false);
    try w.key("name");
    try w.ptext(name);
    try w.key("args");
    try w.list(args.len);
    for (args) |n| try w.int(n);
    try w.end();
    if (m.pumps()) {
        try w.key("now");
        try w.instant(.{ .seconds = now_s, .micros = 0 });
    }
    try w.end();
    return w.finish();
}

fn binPump(a: Allocator, ref: i64, now_s: i64) ![]u8 {
    var w = rp.Writer.init(a);
    defer w.deinit();
    try binInput(&w, .pump, ref, "g");
    try w.key("now");
    try w.instant(.{ .seconds = now_s, .micros = 0 });
    try w.end();
    return w.finish();
}

fn binHello(c: *Client, ref: i64, feature: []const u8) !Json {
    return c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"crossing-trace-v1\",\"function-metadata-v1\",\"core-message-v1\",\"group-exchanges-v1\",\"{s}\"]}}", .{ ref, feature });
}

fn reportOf(reply: Json, kind: []const u8) !Json {
    const ok = reply.object.get("ok") orelse reply;
    for (ok.object.get("reports").?.array.items) |r| if (std.mem.eql(u8, r.object.get("kind").?.string, kind)) return r;
    return unexpected(reply);
}

const now_2026: i64 = 1791633600;

/// A binary callback result, with an integer `value` if any.
fn binResult(a: Allocator, c: rp.Callback, ref: i64, outcome: ?[]const u8, value: ?i64) ![]u8 {
    var w = rp.Writer.init(a);
    try w.header();
    try w.byte(@backingInt(c));
    try w.begin(rp.fields(c), true);
    try w.key("ref");
    try w.int(ref);
    try w.key("group");
    try w.ptext("g");
    if (outcome) |o| {
        try w.key(if (c == .effect_result) "status" else "outcome");
        try w.ptext(o);
    }
    if (value) |n| {
        try w.key("value");
        try w.int(n);
    }
    try w.end();
    return w.finish();
}

test "callbacks-fields-v1: op and release needs and their results cross in binary (#1311)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    // A result before negotiation is a protocol error.
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binResult(a, .op_result, 1, "result", 1))));
    const hello = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"callbacks-fields-v1\",\"crossing-trace-v1\",\"abandoned-before-needs-v1\"]}}", .{1}));
    var offered = false;
    for (hello.object.get("features").?.array.items) |f| offered = offered or std.mem.eql(u8, f.string, rp.feature_callbacks);
    try std.testing.expect(offered and s.callbacks and !s.request_pump);
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"args\":[\"number\",\"text\"],\"result\":\"number\"}}],\"release\":true}}", .{2}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{4}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go n\\n ask api to read n, \\\"x\\\"\\n return it\\nend go\"}}", .{ 5, grant.object.get("grant").?.integer }));
    for (0..2) |round| {
        _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\",\"args\":[4]}}}}", .{6}));
        const pumped = try binReply(&c, "{\"m\":\"pump\",\"ref\":7,\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}");
        errdefer std.debug.print("need: {f}\n", .{std.json.fmt(pumped, .{})});
        try std.testing.expectEqualStrings("need", pumped.object.get("binary").?.string);
        try std.testing.expectEqual(@as(i64, 7), pumped.object.get("ref").?.integer);
        try std.testing.expect(pumped.object.get("abandoned").? == .array and pumped.object.get("settled").? == .array);
        const need = pumped.object.get("need").?;
        try std.testing.expectEqualStrings("op", need.object.get("m").?.string);
        try std.testing.expectEqualStrings("read", need.object.get("operation").?.string);
        try std.testing.expectEqualStrings("immediate", need.object.get("mode").?.string);
        try std.testing.expectEqual(@as(i64, 4), need.object.get("args").?.array.items[0].integer);
        try std.testing.expectEqualStrings("x", need.object.get("args").?.array.items[1].string);
        try std.testing.expectEqual(@as(i64, 1791633600000000), need.object.get("now").?.integer);
        try std.testing.expectEqual(false, need.object.get("automatic").?.bool);
        // A mismatched result or another ref is refused; the need stays open.
        try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binResult(a, .prop_result, 7, "value", 1))));
        try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binResult(a, .op_result, 8, "result", 1))));
        try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binResult(a, .op_result, 7, "nonsense", 1))));
        // The binary result resumes it; the JSON form still does, too.
        var done = if (round == 0)
            try binReply(&c, try binResult(a, .op_result, 7, "result", 41))
        else
            try binReply(&c, "{\"m\":\"op-result\",\"ref\":7,\"group\":\"g\",\"result\":41}");
        while (done.object.get("need")) |n| {
            try std.testing.expectEqualStrings("trace", n.object.get("m").?.string);
            done = try binReply(&c, "{\"m\":\"trace-result\",\"ref\":7,\"group\":\"g\"}");
        }
        try std.testing.expectEqual(@as(i64, 41), (try reportOf(done, "run end")).object.get("result").?.integer);
    }
    // A Stop's Grant release is a binary need, answered in binary.
    _ = try okOf(try binReply(&c, "{\"m\":\"stop\",\"ref\":8,\"group\":\"g\",\"script\":\"s\",\"reason\":\"done\"}"));
    const stopped = try binReply(&c, "{\"m\":\"pump\",\"ref\":9,\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}");
    errdefer std.debug.print("stop: {f}\n", .{std.json.fmt(stopped, .{})});
    const release = stopped.object.get("need") orelse return unexpected(stopped);
    try std.testing.expectEqualStrings("release", release.object.get("m").?.string);
    try std.testing.expectEqualStrings("api", release.object.get("grant").?.string);
    try std.testing.expectEqualStrings("stop", release.object.get("reason").?.string);
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binResult(a, .op_result, 9, "result", 1))));
    _ = try okOf(try binReply(&c, try binResult(a, .release_result, 9, null, null)));
}

/// A protocol error's detail.
fn refusalOf(reply: Json) ![]const u8 {
    try std.testing.expectEqualStrings("protocol error", try errKind(reply));
    return reply.object.get("err").?.object.get("detail").?.string;
}

/// Scripts `s`, which asks `api` twice, and `t` and `u`, whose Grants'
/// releases a Stop queues, in traced Group `g`; refs 1..6 set up.
fn exchangeFixture(c: *Client, features: []const u8) !void {
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[{s}]}}", .{ 1, features }));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"release\":true,\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"result\":\"number\"}}]}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{3}));
    for ([_][]const u8{ "s", "t", "u" }) |name| {
        const grant = (try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{4}))).object.get("grant").?.integer;
        const source = if (std.mem.eql(u8, name, "s")) "on go\\n ask api to read\\n ask api to read\\n return it\\nend go" else "on idle\\nend idle";
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"{s}\",\"grants\":{{\"api\":{d}}},\"source\":\"{s}\"}}", .{ 5, name, grant, source }));
    }
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{6}));
}

test "a paused JSON exchange's refusals, and Pumps paused for Grant releases (#1481)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    try exchangeFixture(&c, "\"crossing-trace-v1\"");
    // A Stop between exchanges runs in the Pump, whose Grant release
    // pauses it before its first need.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"t\",\"reason\":\"done\"}}", .{7}));
    var reply = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8});
    errdefer std.debug.print("last: {f}\n", .{std.json.fmt(reply, .{})});
    try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
    // Awaiting the release: other inputs go through paused admission.
    try std.testing.expectEqualStrings("the worker ref is reserved for its result", try refusalOf(try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":1}}", .{})));
    try std.testing.expectEqualStrings("a paused input must address the worker's Group", try refusalOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1}}", .{9})));
    try std.testing.expectEqualStrings("a worker is waiting for its result", try refusalOf(try c.send("{{\"m\":\"release-result\",\"ref\":{d},\"group\":\"g\"}}", .{9})));
    _ = try okOf(try c.send("{{\"m\":\"deliver\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"t\"}},\"message\":{{\"name\":\"idle\"}}}}", .{9}));
    reply = try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":8}}", .{});
    try std.testing.expectEqualStrings("op", reply.object.get("need").?.object.get("m").?.string);
    // Awaiting the op's result: a result under another ref is an input.
    try std.testing.expectEqualStrings("a worker is waiting for its result", try refusalOf(try c.send("{{\"m\":\"op-result\",\"ref\":{d},\"group\":\"g\",\"result\":1}}", .{9})));
    try std.testing.expectEqualStrings("a paused input must address the worker's Group", try refusalOf(try c.send("{{\"m\":\"op-result\",\"ref\":{d},\"result\":1}}", .{9})));
    try std.testing.expectEqualStrings("the result does not match the need", try refusalOf(try c.sendRef(8, "{{\"m\":\"prop-result\",\"ref\":8,\"value\":1}}", .{})));
    try std.testing.expectEqualStrings("the result does not match the need", try refusalOf(try c.sendRef(8, "{{\"m\":\"effect-result\",\"ref\":8,\"status\":\"ok\"}}", .{})));
    for ([_][]const u8{ "release-result", "trace-result", "deliver" }) |m| {
        try std.testing.expectEqualStrings("a Pump is waiting for its result", try refusalOf(try c.sendRef(8, "{{\"m\":\"{s}\",\"ref\":8,\"group\":\"g\"}}", .{m})));
    }
    // A Stop admitted while paused runs when the Pump goes on, after the
    // crossing's Trace, and its release pauses the Pump again.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"u\",\"reason\":\"done\"}}", .{10}));
    reply = try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":1}}", .{});
    // Awaiting the crossing's Trace.
    try std.testing.expectEqualStrings("trace", reply.object.get("need").?.object.get("m").?.string);
    try std.testing.expectEqualStrings("a crossing is waiting for trace-result", try refusalOf(try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":1}}", .{})));
    try std.testing.expectEqualStrings("a worker is waiting for its result", try refusalOf(try c.send("{{\"m\":\"trace-result\",\"ref\":{d},\"group\":\"g\"}}", .{9})));
    reply = try c.sendRef(8, "{{\"m\":\"trace-result\",\"ref\":8,\"group\":\"g\"}}", .{});
    try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
    try std.testing.expectEqualStrings("u", reply.object.get("need").?.object.get("script").?.string);
    try std.testing.expectEqualStrings("the worker ref is reserved for its result", try refusalOf(try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":1}}", .{})));
    reply = try c.sendRef(8, "{{\"m\":\"release-result\",\"ref\":8}}", .{});
    try std.testing.expectEqualStrings("op", reply.object.get("need").?.object.get("m").?.string);
    reply = try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":2}}", .{});
    while (reply.object.get("need")) |n| {
        try std.testing.expectEqualStrings("trace", n.object.get("m").?.string);
        reply = try c.sendRef(8, "{{\"m\":\"trace-result\",\"ref\":8,\"group\":\"g\"}}", .{});
    }
    try std.testing.expectEqual(@as(i64, 2), (try runEnd(reply)).object.get("result").?.integer);
    // With nothing open, a result is not a message the Session knows.
    try std.testing.expectEqualStrings("unknown or unsupported message", try refusalOf(try c.sendRef(8, "{{\"m\":\"op-result\",\"ref\":8,\"result\":2}}", .{})));
}

test "a paused binary exchange's refusals keep their own wording (#1481)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    try exchangeFixture(&c, "\"callbacks-fields-v1\",\"crossing-trace-v1\"");
    var reply = try binReply(&c, "{\"m\":\"pump\",\"ref\":7,\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}");
    errdefer std.debug.print("last: {f}\n", .{std.json.fmt(reply, .{})});
    try std.testing.expectEqualStrings("op", reply.object.get("need").?.object.get("m").?.string);
    // Awaiting the op's result: the ref is checked before the kind.
    try std.testing.expectEqualStrings("the worker ref is reserved for its result", try refusalOf(try binReply(&c, try binResult(a, .op_result, 8, "result", 1))));
    try std.testing.expectEqualStrings("the worker ref is reserved for its result", try refusalOf(try binReply(&c, try binResult(a, .prop_result, 8, "value", 1))));
    try std.testing.expectEqualStrings("the result does not match the need", try refusalOf(try binReply(&c, try binResult(a, .prop_result, 7, "value", 1))));
    try std.testing.expectEqualStrings("the result does not match the need", try refusalOf(try binReply(&c, try binResult(a, .effect_result, 7, "ok", null))));
    try std.testing.expectEqualStrings("a Pump is waiting for its result", try refusalOf(try binReply(&c, try binResult(a, .release_result, 7, null, null))));
    reply = try binReply(&c, try binResult(a, .op_result, 7, "result", 1));
    // Awaiting the crossing's Trace, which only JSON answers.
    try std.testing.expectEqualStrings("trace", reply.object.get("need").?.object.get("m").?.string);
    try std.testing.expectEqualStrings("a crossing is waiting for trace-result", try refusalOf(try binReply(&c, try binResult(a, .op_result, 7, "result", 1))));
    try std.testing.expectEqualStrings("the worker ref is reserved for its result", try refusalOf(try binReply(&c, try binResult(a, .op_result, 8, "result", 1))));
    reply = try binReply(&c, "{\"m\":\"trace-result\",\"ref\":7,\"group\":\"g\"}");
    try std.testing.expectEqualStrings("op", reply.object.get("need").?.object.get("m").?.string);
    reply = try binReply(&c, try binResult(a, .op_result, 7, "result", 2));
    while (reply.object.get("need")) |n| {
        try std.testing.expectEqualStrings("trace", n.object.get("m").?.string);
        reply = try binReply(&c, "{\"m\":\"trace-result\",\"ref\":7,\"group\":\"g\"}");
    }
    _ = try okOf(reply);
    // A final reply held behind a Grant release: only its result is taken.
    _ = try okOf(try c.send("{{\"m\":\"stop\",\"ref\":{d},\"group\":\"g\",\"script\":\"t\",\"reason\":\"done\"}}", .{8}));
    reply = try binReply(&c, "{\"m\":\"pump\",\"ref\":9,\"group\":\"g\",\"now\":\"2026-10-10T12:00:01Z\"}");
    try std.testing.expectEqualStrings("release", reply.object.get("need").?.object.get("m").?.string);
    for ([_]i64{ 9, 10 }) |ref| {
        try std.testing.expectEqualStrings("a Grant release is waiting for its release-result", try refusalOf(try binReply(&c, try binResult(a, .op_result, ref, "result", 1))));
        try std.testing.expectEqualStrings("a Grant release is waiting for its release-result", try refusalOf(try binReply(&c, try binResult(a, .release_result, ref + 1, null, null))));
    }
    _ = try okOf(try binReply(&c, try binResult(a, .release_result, 9, null, null)));
    // With nothing open, a binary result is not a message the Session knows.
    try std.testing.expectEqualStrings("unknown or unsupported message", try refusalOf(try binReply(&c, try binResult(a, .op_result, 9, "result", 1))));
}

/// A settle-pump with one settlement of `call`, or with `outcome` malformed.
fn binSettlePump(a: Allocator, ref: i64, call: []const u8, outcome: []const u8, value: i64) ![]u8 {
    var w = rp.Writer.init(a);
    defer w.deinit();
    try binInput(&w, .settle_pump, ref, "g");
    try w.key("now");
    try w.instant(.{ .seconds = now_2026, .micros = 0 });
    try w.key("settlements");
    try w.list(1);
    try w.begin(rp.settlement_fields, true);
    try w.key("call");
    try w.ptext(call);
    try w.key("outcome");
    try w.ptext(outcome);
    try w.key("value");
    try w.int(value);
    try w.end();
    try w.end();
    return w.finish();
}

/// A `queue-fields-v1` input to `script`, or to all with `script` null.
fn binQueued(a: Allocator, m: rp.Message, ref: i64, script: ?[]const u8, name: []const u8, broadcast: ?bool) ![]u8 {
    var w = rp.Writer.init(a);
    defer w.deinit();
    try binInput(&w, m, ref, "g");
    if (script) |sc| {
        try w.key("to");
        try w.begin(&.{}, false);
        try w.key("script");
        try w.ptext(sc);
        try w.end();
    }
    try w.key("message");
    try w.begin(&.{}, false);
    try w.key("name");
    try w.ptext(name);
    try w.key("args");
    try w.list(0);
    try w.end();
    if (broadcast) |b| {
        try w.key("broadcast");
        try w.byte(if (b) rp.tag.true_ else rp.tag.false_);
    }
    try w.end();
    return w.finish();
}

test "queue-fields-v1: queued Deliveries, Broadcasts and Decisions admit in binary (#1374)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    // It needs the fields layout, and the inputs need it negotiated.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"queue-fields-v1\"]}}", .{1})));
    _ = try okOf(try binHello(&c, 2, "request-pump-fields-v1"));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{3}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on ping\\n return 1\\nend ping\"}}", .{4}));
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binQueued(a, .deliver, 5, "s", "ping", null))));
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"crossing-trace-v1\",\"function-metadata-v1\",\"core-message-v1\",\"group-exchanges-v1\",\"request-pump-fields-v1\",\"queue-fields-v1\"]}}", .{6}));
    try std.testing.expect(s.queue_fields);

    const delivered = try binReply(&c, try binQueued(a, .deliver, 7, "s", "ping", null));
    errdefer std.debug.print("delivered: {f}\n", .{std.json.fmt(delivered, .{})});
    try std.testing.expectEqualStrings("admission", delivered.object.get("binary").?.string);
    const id = delivered.object.get("delivery").?.string;
    const pumped = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{8});
    try std.testing.expectEqualStrings(id, (try reportOf(pumped, "run end")).object.get("delivery").?.string);

    // A Broadcast's admission names the Broadcast id.
    const broadcast = try binReply(&c, try binQueued(a, .broadcast, 9, null, "ping", null));
    errdefer std.debug.print("broadcast: {f}\n", .{std.json.fmt(broadcast, .{})});
    const all = try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{10});
    try std.testing.expectEqualStrings(broadcast.object.get("delivery").?.string, (try reportOf(all, "run end")).object.get("broadcast").?.string);

    // Decisions, to a Script and to all, are admitted with their ids.
    const decided = try binReply(&c, try binQueued(a, .decide, 11, "s", "ping", null));
    try std.testing.expect(decided.object.get("delivery") != null);
    const to_all = try binReply(&c, try binQueued(a, .decide, 12, null, "ping", true));
    try std.testing.expect(to_all.object.get("delivery") != null);

    // Refusals keep their JSON codes, in the admission reply.
    for ([_]struct { []const u8, ?[]const u8, ?bool }{
        .{ "unknown Script", "nobody", null },
        .{ "a Broadcast Decision with a target", "s", true },
        .{ "a Decision with no target", null, false },
    }) |case| {
        errdefer std.debug.print("case: {s}\n", .{case[0]});
        const refused = try binReply(&c, try binQueued(a, .decide, 13, case[1], "ping", case[2]));
        try std.testing.expectEqualStrings("invalid value", refused.object.get("err").?.object.get("code").?.string);
    }
}

test "settlements-fields-v1: a settle-pump applies its settlements, then Pumps (#1320)" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    // It needs the fields layout, and a settle-pump needs it negotiated.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"settlements-fields-v1\"]}}", .{1})));
    _ = try okOf(try binHello(&c, 2, "request-pump-fields-v1"));
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binSettlePump(a, 3, "x", "answer", 1))));
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"crossing-trace-v1\",\"function-metadata-v1\",\"core-message-v1\",\"request-pump-fields-v1\",\"settlements-fields-v1\"]}}", .{4}));
    try std.testing.expect(s.settlements);
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"suspending\",\"args\":[],\"result\":\"number\"}}]}}", .{5}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{6}));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{7}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go\\n ask api to read and wait\\n return it + 1\\nend go\"}}", .{ 8, grant.object.get("grant").?.integer }));
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\",\"args\":[]}}}}", .{9}));
    const pumped = try binReply(&c, "{\"m\":\"pump\",\"ref\":10,\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}");
    const need = pumped.object.get("need") orelse return unexpected(pumped);
    const call = need.object.get("call").?.string;
    _ = try binReply(&c, "{\"m\":\"op-result\",\"ref\":10,\"group\":\"g\",\"started\":true}");
    // A malformed settlement is a protocol error, and an unknown call
    // refuses the Pump; neither applies anything.
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binSettlePump(a, 11, call, "nonsense", 41))));
    const refused = try binReply(&c, try binSettlePump(a, 12, "s.r9.c1", "answer", 41));
    errdefer std.debug.print("refused: {f}\n", .{std.json.fmt(refused, .{})});
    try std.testing.expectEqualStrings("unknown call", refused.object.get("err").?.object.get("code").?.string);
    const done = try binReply(&c, try binSettlePump(a, 13, call, "answer", 41));
    errdefer std.debug.print("done: {f}\n", .{std.json.fmt(done, .{})});
    try std.testing.expectEqual(@as(i64, 42), (try reportOf(done, "run end")).object.get("result").?.integer);
    // A later Pump releases the retired call. Its id remains known, so a
    // late binary answer is accepted and ignored just like a JSON answer.
    _ = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{14}));
    try std.testing.expect(s.groupNamed("g").?.group.group.callById("s/r1.c1") == null);
    const late = try binReply(&c, try binSettlePump(a, 15, "s/r1.c1", "answer", 1));
    try std.testing.expectEqualStrings("idle", late.object.get("state").?.string);
}

test "request-pump negotiation is required, and the map layout is unknown" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{1}));
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binPump(a, 2, now_2026))));
    // The retired map layout is refused as any unknown feature is.
    const unknown = try binHello(&c, 3, "request-pump-nonsense-v1");
    const map = try binHello(&c, 3, "request-pump-map-v1");
    try std.testing.expectEqualStrings("protocol error", try errKind(map));
    try std.testing.expectEqualStrings(try std.fmt.allocPrint(a, "{f}", .{std.json.fmt(unknown, .{})}), try std.fmt.allocPrint(a, "{f}", .{std.json.fmt(map, .{})}));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"request-pump-fields-v1\",\"binary-frames-v1\"]}}", .{4})));
    try std.testing.expect(!s.request_pump);
    const hello = try okOf(try binHello(&c, 5, "request-pump-fields-v1"));
    var offered: usize = 0;
    for (hello.object.get("features").?.array.items) |f| {
        if (std.mem.eql(u8, f.string, rp.feature_fields)) offered += 1;
        try std.testing.expect(!std.mem.eql(u8, f.string, "request-pump-map-v1"));
    }
    try std.testing.expectEqual(@as(usize, 1), offered);
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[]}}", .{8}));
    try std.testing.expect(s.request_pump);
    // Layout byte 00, another version and a lone prefix are refused.
    const map_frame = try binPump(a, 9, now_2026);
    map_frame[rp.prefix.len] = 0x00;
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, map_frame)));
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, "NTB\x02\x00\x00")));
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, "NTB\x01")));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"g\",\"token\":1}}", .{10})));
    // The fields layout still works.
    try std.testing.expectEqualStrings("completion", (try binReply(&c, try binPump(a, 11, now_2026))).object.get("binary").?.string);
}

test "binary Requests, Pumps and combined Requests" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    _ = try okOf(try binHello(&c, 1, rp.feature_fields));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\",\"trace\":true}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on inc n\\n  return n + 1\\nend inc\\n\"}}", .{3}));
    // An ordinary Request is admitted.
    const admitted = try binReply(&c, try binRequest(a, .request, 4, 0, "s", "inc", &.{-3}, 0));
    const adm = admitted;
    try std.testing.expectEqualStrings("d1", adm.object.get("delivery").?.string);
    // Its Pump ends in a binary completion carrying typed Reports.
    const pumped = try binReply(&c, try binPump(a, 5, now_2026));
    try std.testing.expectEqual(@as(i64, 5), pumped.object.get("ref").?.integer);
    const ok = pumped;
    try std.testing.expectEqualStrings("idle", ok.object.get("state").?.string);
    try std.testing.expect(pumped.object.get("delivery") == null and pumped.object.get("token") == null);
    try std.testing.expectEqual(@as(usize, 0), pumped.object.get("abandoned").?.array.items.len);
    const end = try reportOf(pumped, "run end");
    try std.testing.expectEqualStrings("d1", end.object.get("delivery").?.string);
    try std.testing.expectEqual(@as(i64, -2), end.object.get("result").?.integer);
    // A combined Request admits once, Pumps once, and carries its token.
    const both = try binReply(&c, try binRequest(a, .request_pump, 6, 41, "s", "inc", &.{1}, now_2026 + 1));
    errdefer std.debug.print("combined reply: {f}\n", .{std.json.fmt(both, .{})});
    try std.testing.expectEqualStrings("d2", both.object.get("delivery").?.string);
    try std.testing.expectEqual(@as(i64, 41), both.object.get("token").?.integer);
    try std.testing.expectEqual(@as(i64, 2), (try reportOf(both, "run end")).object.get("result").?.integer);
    var traced_request = false;
    const trace = both.object.get("trace").?.array.items;
    for (trace) |line| {
        if (std.mem.startsWith(u8, line.string, "> request d2 to=s")) traced_request = true;
        try std.testing.expect(!std.mem.containsAtLeast(u8, line.string, 1, "request-pump"));
    }
    try std.testing.expect(traced_request);
    // Its token is retired with its final reply.
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"g\",\"token\":41}}", .{7})));
    try std.testing.expectEqual(@as(usize, 0), s.bindings.items.len);
    // A Function Value crosses back into call-pump as its own item.
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"m\",\"source\":\"on make n\\n  return given x: x + n\\nend make\\n\"}}", .{8}));
    const made = try binReply(&c, try binRequest(a, .request_pump, 9, 42, "m", "make", &.{5}, now_2026 + 2));
    const raw = (try reportOf(made, "run end")).object.get("result").?.object.get("$raw").?.string;
    try std.testing.expectEqual(@as(u8, 0x13), raw[0]);
    var w = rp.Writer.init(a);
    try binInput(&w, .call_pump, 10, "g");
    try w.key("token");
    try w.int(43);
    try w.key("fn");
    try w.raw(raw);
    try w.key("args");
    try w.list(1);
    try w.int(3);
    try w.key("now");
    try w.instant(.{ .seconds = now_2026 + 3, .micros = 0 });
    try w.end();
    const called = try binReply(&c, try w.finish());
    try std.testing.expectEqualStrings("d4", called.object.get("delivery").?.string);
    try std.testing.expectEqual(@as(i64, 8), (try reportOf(called, "run end")).object.get("result").?.integer);
}

test "malformed binary frames are JSON protocol errors and change nothing" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    _ = try okOf(try binHello(&c, 1, rp.feature_fields));
    _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g\",\"name\":\"g\"}}", .{2}));
    _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"g\",\"name\":\"s\",\"source\":\"on inc n\\n  return n + 1\\nend inc\\n\"}}", .{3}));
    const good = try binRequest(a, .request_pump, 4, 9, "s", "inc", &.{1}, now_2026);
    const extra = try std.mem.concat(a, u8, &.{ good, &.{0} });
    const wrong_tag = try a.dupe(u8, good);
    wrong_tag[rp.prefix.len + 1] = 0x81;
    const short = good[0 .. good.len - 1];
    const bad_count = try a.dupe(u8, good);
    bad_count[rp.prefix.len + 3] -= 1;
    for ([_][]const u8{ extra, wrong_tag, short, bad_count, "NTB\x01\x01\x7f" }) |frame| {
        const reply = try binReply(&c, frame);
        try std.testing.expectEqualStrings("protocol error", try errKind(reply));
    }
    // A duplicate or zero token, before admission.
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binRequest(a, .request_pump, 5, 0, "s", "inc", &.{1}, now_2026))));
    // A refused admission neither Pumps nor binds its token.
    const refused = try binReply(&c, try binRequest(a, .request_pump, 6, 9, "nobody", "inc", &.{1}, now_2026));
    try std.testing.expectEqualStrings("admission", refused.object.get("binary").?.string);
    try std.testing.expectEqualStrings("invalid value", refused.object.get("err").?.object.get("code").?.string);
    try std.testing.expectEqual(@as(usize, 0), s.bindings.items.len);
    // Nothing consumed a delivery id.
    const both = try binReply(&c, good);
    try std.testing.expectEqualStrings("d1", both.object.get("delivery").?.string);
}

test "a combined exchange pauses at JSON needs, takes token cancellation and ends in binary" {
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const a = c.arena.allocator();
    _ = try okOf(try binHello(&c, 0, rp.feature_fields));
    _ = try okOf(try c.send("{{\"m\":\"define-capability\",\"ref\":{d},\"name\":\"api\",\"ops\":[{{\"name\":\"read\",\"mode\":\"immediate\",\"result\":\"number\"}}]}}", .{1}));
    const grant = try okOf(try c.send("{{\"m\":\"grant\",\"ref\":{d},\"capability\":\"api\",\"ops\":\"all\"}}", .{2}));
    for ([_][]const u8{ "g", "h" }) |group| {
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"{s}\",\"name\":\"{s}\",\"trace\":true}}", .{ 3, group, group }));
        _ = try okOf(try c.send("{{\"m\":\"load\",\"ref\":{d},\"group\":\"{s}\",\"name\":\"s\",\"grants\":{{\"api\":{d}}},\"source\":\"on go\\n ask api to read\\n return it\\nend go\\non inc n\\n return n + 1\\nend inc\"}}", .{ 4, group, grant.object.get("grant").?.integer }));
    }
    // Earlier work stays ahead: the combined input waits behind it.
    _ = try okOf(try c.send("{{\"m\":\"request\",\"ref\":{d},\"group\":\"g\",\"to\":{{\"script\":\"s\"}},\"message\":{{\"name\":\"go\"}}}}", .{5}));
    const need = try binReply(&c, try binRequest(a, .request_pump, 6, 77, "s", "inc", &.{1}, now_2026));
    try std.testing.expectEqualStrings("op", need.object.get("need").?.object.get("m").?.string);
    try std.testing.expectEqual(@as(usize, 1), s.bindings.items.len);
    // The token is active: a duplicate is refused, another Group can't use it.
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, try binRequestTo(a, .request_pump, 7, "h", 77, "s", "inc", &.{}, now_2026))));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"h\",\"token\":77}}", .{8})));
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"g\",\"token\":78}}", .{9})));
    // A competing Pump, ordinary or combined, is refused before admission.
    const competing = try binReply(&c, try binPump(a, 10, now_2026));
    try std.testing.expectEqualStrings("reentrant call", competing.object.get("err").?.object.get("code").?.string);
    const competing_both = try binReply(&c, try binRequest(a, .request_pump, 11, 79, "s", "inc", &.{}, now_2026));
    try std.testing.expectEqualStrings("reentrant call", competing_both.object.get("err").?.object.get("code").?.string);
    try std.testing.expectEqual(@as(usize, 1), s.bindings.items.len);
    // Cancellation by token is admitted while the worker waits at its need.
    _ = try okOf(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"g\",\"token\":77}}", .{12}));
    // The JSON result resumes it; the final reply is binary, carrying the token.
    var done = try binReply(&c, "{\"m\":\"op-result\",\"ref\":6,\"group\":\"g\",\"result\":7}");
    // Crossing Trace pauses add further JSON continuations.
    while (done.object.get("need")) |n| {
        try std.testing.expectEqualStrings("trace", n.object.get("m").?.string);
        done = try binReply(&c, "{\"m\":\"trace-result\",\"ref\":6,\"group\":\"g\"}");
    }
    try std.testing.expectEqualStrings("d2", done.object.get("delivery").?.string);
    try std.testing.expectEqual(@as(i64, 77), done.object.get("token").?.integer);
    try std.testing.expectEqual(@as(i64, 7), (try reportOf(done, "run end")).object.get("result").?.integer);
    try std.testing.expectEqual(@as(usize, 0), s.bindings.items.len);
    try std.testing.expectEqualStrings("protocol error", try errKind(try c.send("{{\"m\":\"cancel-correlated\",\"ref\":{d},\"group\":\"g\",\"token\":77}}", .{13})));
    // A later JSON Pump replies in JSON. As cancel-delivery, the queued
    // cancellation lands at its drain, with cancel-delivery's own record.
    const next = try okOf(try c.send("{{\"m\":\"pump\",\"ref\":{d},\"group\":\"g\",\"now\":\"2026-10-10T12:00:00Z\"}}", .{14}));
    var cancelled = false;
    for (next.object.get("trace").?.array.items) |line| {
        if (std.mem.eql(u8, line.string, "> cancel-delivery d2")) cancelled = true;
    }
    if (!cancelled) return unexpected(next);
}

test "drop-group and lookup stay exact with many live Groups" {
    const t = std.testing;
    const gpa = t.allocator;
    const s = Session.init(gpa).?;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"group-exchanges-v1\"]}}", .{1}));
    const n = 600;
    var ref: i64 = 10;
    for (0..n) |i| {
        ref += 1;
        _ = try okOf(try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g{d}\",\"name\":\"g{d}\",\"trace\":false}}", .{ ref, i, i }));
    }
    // Drop the first, the last and every third Group between, last first.
    var i: usize = n;
    while (i > 0) {
        i -= 1;
        if (i % 3 != 0 and i != n - 1) continue;
        ref += 1;
        _ = try okOf(try c.send("{{\"m\":\"drop-group\",\"ref\":{d},\"group\":\"g{d}\"}}", .{ ref, i }));
    }
    // Every survivor still answers to its handle; every dropped handle is
    // unknown and free to reuse.
    for (0..n) |k| {
        const dropped = k % 3 == 0 or k == n - 1;
        ref += 1;
        const reply = try c.send("{{\"m\":\"inspect\",\"ref\":{d},\"group\":\"g{d}\"}}", .{ ref, k });
        if (dropped) try t.expectEqualStrings("host error", try errKind(reply)) else _ = try okOf(reply);
        ref += 1;
        const again = try c.send("{{\"m\":\"new-group\",\"ref\":{d},\"group\":\"g{d}\",\"name\":\"g{d}\",\"trace\":false}}", .{ ref, k, k });
        if (dropped) _ = try okOf(again) else try t.expectEqualStrings("host error", try errKind(again));
    }
    try t.expectEqual(@as(usize, n), s.groups.count());
}

fn binLoadFrame(a: Allocator, ref: i64, name: []const u8, source: []const u8, create: bool) ![]u8 {
    var w = rp.Writer.init(a);
    defer w.deinit();
    try binInput(&w, .load, ref, "g");
    try w.key("name");
    try w.ptext(name);
    try w.key("source");
    try w.ptext(source);
    if (create) {
        try w.key("newGroup");
        try w.begin(&.{}, false);
        try w.key("name");
        try w.ptext("tenant");
        try w.key("trace");
        try w.boolean(true);
        try w.end();
    }
    try w.end();
    return w.finish();
}

test "load-fields-v1 creates once, keeps refused-load diagnostics and recovers from malformed frames" {
    const a = std.testing.allocator;
    const s = Session.init(a) orelse return error.OutOfMemory;
    defer s.deinit();
    var c = Client.init(s);
    defer c.deinit();
    const source = "on ping\n return 1\nend ping\n";
    const first = try binLoadFrame(a, 2, "s", source, true);
    defer a.free(first);
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, first)));
    try std.testing.expectEqual(@as(usize, 0), s.groups.count());
    _ = try okOf(try c.send("{{\"m\":\"hello\",\"ref\":{d},\"protocol\":1,\"features\":[\"load-fields-v1\",\"crossing-trace-v1\",\"group-exchanges-v1\"]}}", .{1}));
    _ = try okOf(try binReply(&c, first));
    try std.testing.expectEqual(@as(usize, 1), s.groups.count());
    try std.testing.expectEqualStrings("host error", try errKind(try binReply(&c, first)));
    const broken = try binLoadFrame(a, 3, "broken", "on x\n return (\nend x\n", false);
    defer a.free(broken);
    const refused = try binReply(&c, broken);
    try std.testing.expectEqualStrings("load error", try errKind(refused));
    try std.testing.expect((field(refused, "trace") orelse return error.TestUnexpectedResult).array.items.len > 0);
    const later = try binLoadFrame(a, 4, "later", source, false);
    defer a.free(later);
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, later[0 .. later.len - 1])));
    const invalid = try binLoadFrame(a, 5, "invalid", &.{0xff}, false);
    defer a.free(invalid);
    try std.testing.expectEqualStrings("protocol error", try errKind(try binReply(&c, invalid)));
    _ = try okOf(try binReply(&c, later));
    try std.testing.expect(Direct.groupScript(s.groupNamed("g").?.group, "later", 5) != null);
}

/// A Report of each kind with every optional field it can carry.
fn reportSample(a: Allocator, comptime kind: std.meta.Tag(machine.report.Report)) !machine.report.Report {
    const R = machine.report;
    const ancestry: R.Ancestry = .{ .root = "d1", .parent_run = "r1", .parent_call = "c1" };
    return switch (kind) {
        .charge_result => .{ .charge_result = .{ .request = "q1", .call = "c1", .fuel = 7, .status = .accepted } },
        .run_end => .{ .run_end = .{
            .script = "s",
            .run = "r1",
            .delivery = "d1",
            .broadcast = "b1",
            .handler = "ping",
            .fallback = true,
            .climbed = true,
            .outcome = .effect_failure,
            .effect = .{ .script = "s", .run = "r1", .grant = "g", .segment = "1", .phase = "commit", .status = "unknown", .scope = "run" },
            .cleanup_failed = .{ .limit = "fuel" },
            .result = try model.text(a, "done"),
            .err = try model.map(a, try a.dupe(model.Pair, &.{.{ .key = "code", .value = try model.text(a, "boom") }})),
            .limit = "fuel",
            .at = .{ .unit = "s", .line = 3, .column = 5, .handler = "ping", .pc = 9 },
            .fuel = 11,
            .alloc = 13,
        } },
        .stop => .{ .stop = .{ .script = "s", .reason = "stop", .discarded_runs = &.{ "r1", "r2" }, .dropped_messages = &.{"d2"}, .pending_calls = &.{} } },
        .unhandled => .{ .unhandled = .{ .delivery = "d1", .message = "ping", .args = try a.dupe(*Value, &.{ try model.text(a, "x"), try model.text(a, "y") }) } },
        .call_failed => .{ .call_failed = .{ .script = "s", .call = "c1", .capability = "Clock", .operation = "now", .detail = "broken" } },
        .effect_failure => .{ .effect_failure = .{ .script = "s", .run = "r1", .grant = "g", .segment = "1", .phase = "commit", .status = "unknown", .scope = "run" } },
        .decided => .{ .decided = .{
            .broadcast = "b1",
            .verdict = .vetoed,
            .vetoes = try a.dupe(R.Veto, &.{.{ .script = "s", .run = "r1", .reason = try model.text(a, "no") }}),
            .undecided = &.{.{ .script = "t", .run = "r2", .outcome = .errored }},
        } },
        .host_error => .{ .host_error = .{ .code = "mailbox full", .detail = "s" } },
        .run_started => .{ .run_started = .{ .ancestry = ancestry, .script = "s", .run = "r1", .delivery = "d1", .selector = "ping", .args = try a.dupe(*Value, &.{try model.text(a, "x")}) } },
        .run_discarded => .{ .run_discarded = .{ .ancestry = ancestry, .script = "s", .run = "r1", .reason = "reload" } },
        .run_accounting => .{ .run_accounting = .{ .ancestry = ancestry, .script = "s", .run = "r1", .fuel = 5, .state = .terminal } },
        .causal_work => .{ .causal_work = .{ .root = "d1", .live_runs = 1, .queued_messages = 2, .discarded_messages = 3 } },
    };
}

test "every Report decodes to the same fields in the JSON and fields layouts" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const s = Session.init(std.testing.allocator).?;
    defer s.deinit();
    inline for (@typeInfo(machine.report.Report).@"union".field_names) |name| {
        const report = try reportSample(a, @field(std.meta.Tag(machine.report.Report), name));
        errdefer std.debug.print("Report: {s}\n", .{name});
        var o = Out.init(a);
        try writeReport(&o, report, true);
        const json = try o.finish();
        const tree = (try std.json.parseFromSlice(Json, a, json, .{ .parse_numbers = false })).value;
        var w = rp.Writer.init(a);
        try binReport(&w, s, report, true);
        try @import("envelope_vectors_test.zig").checkReport(a, w.out.items, tree);
    }
}

//! The Session Host (chapter 12): an ordinary Host, over talk.h, that turns
//! Entries and Session Commands into Host Inputs to a Group named `session`
//! holding one Script, `session`, and prints what chapter 12 says. It follows
//! its Runs through their reports and its Group's Trace, never `Inspect()`,
//! and asks a Driver for everything from outside: Clock readings, typed
//! lines, prompt answers, and where its output and Trace go. A REPL drives it
//! live; the corpus runner drives it from a Session Transcript.
//!
//! Host Objects come from a Transcript's `%` envelopes, or live from an
//! embedder (#2276): it `declare`s Object Kinds, identities and initial
//! bindings as envelopes, and answers each crossing through `Driver.prop`
//! while the Pump waits at a Crossing Pause. The session records every
//! envelope a replay reads through `Driver.record`.
//!
//! A driver that `suspends` (the reactor's `session-v1`, ADR 0180) never
//! blocks: a Host call that would wait for a line, a prompt's answer, a
//! deadline or a crossing's answer stays open, and `resumeCall` goes on
//! with it. A `write` or `resolve` it can't answer yet abandons the command,
//! which runs again from its start once it can.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const transcript = @import("transcript.zig");
const store = @import("store.zig");
/// The normative `:inspect` reader (session-observation.md).
const reader_template = northtalk.analysis.inspect_reader;

const Allocator = std.mem.Allocator;
const analysis = northtalk.analysis;

pub const Instant = struct {
    seconds: i64,
    micros: i32,

    fn us(i: Instant) i128 {
        return @as(i128, i.seconds) * std.time.us_per_s + i.micros;
    }

    fn fromMicros(n: i128) Instant {
        return .{ .seconds = @intCast(@divFloor(n, std.time.us_per_s)), .micros = @intCast(@mod(n, std.time.us_per_s)) };
    }

    fn before(x: Instant, y: Instant) bool {
        return x.us() < y.us();
    }
};

/// What a built-in Capability answered: a value, or a failure, each in the
/// display form.
pub const Answer = struct { shown: []const u8, fail: bool };

/// A `user` prompt's answer while another waits (chapter 12, Prompts).
pub const user_busy: Answer = .{ .shown = "{code: \"user busy\", message: \"Another prompt is waiting for an answer\"}", .fail = true };

/// Everything from outside the session.
pub const Driver = struct {
    context: *anyopaque,
    /// The real Clock reading for a Pump; null when there is none, which in a
    /// replay means the Transcript has no `@` here.
    reading: *const fn (context: *anyopaque) ?Instant,
    /// The line the user typed for `console`'s `read`, or null.
    line: *const fn (context: *anyopaque) ?[]const u8,
    /// The answer to a built-in Capability's call, if there is one now.
    /// `busy` when a `user` prompt is already waiting, so the call is
    /// answered at once, `user_busy` unless the driver has another answer.
    answer: *const fn (context: *anyopaque, call: []const u8, busy: bool) ?Answer,
    /// An output line, as printed.
    output: *const fn (context: *anyopaque, line: []const u8) void,
    /// A line of the Group's Trace.
    trace: *const fn (context: *anyopaque, line: []const u8) void,
    /// A file `:export <directory>` or `:store save` writes; false if it
    /// can't. A driver that `suspends` may answer null: the command is
    /// abandoned, and runs again from its start once the driver has the
    /// answer.
    write: *const fn (context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) ?bool,
    /// The next recorded object crossing envelope here, or null.
    crossing: *const fn (context: *anyopaque) ?[]const u8,
    /// Consumes the crossing `crossing` gave.
    take: *const fn (context: *anyopaque) void,
    /// Under a real Clock, waits until the foreground's next deadline, before
    /// the Pump for it; a replay's readings come from the Transcript. A
    /// driver that `suspends` is never asked.
    sleep: *const fn (context: *anyopaque, until: Instant) void,
    /// Live Host Objects (#2276), all null in a replay. The answer to a
    /// crossing: chapter 9's `prop` need as JSON in, its `prop-result`
    /// (`{"value": V}`, `{"ok": true}`, `{"fail": {…}}` or
    /// `{"hostError": true}`) out. Before answering, the driver may
    /// `declare` an identity the answer names. A driver that `suspends` may
    /// answer null: the Host call stops, the Pump waiting at its Crossing
    /// Pause, until `resumeCall`.
    prop: ?*const fn (context: *anyopaque, need: []const u8) ?[]const u8 = null,
    /// A live Restore's resolver: the identities it asks for, as JSON
    /// `[[kind, id], …]` sorted by kind then id, in; a JSON array with a
    /// boolean for each, whether it still resolves, out. Null, from a driver
    /// that `suspends`, abandons `:restore` as `write` does.
    resolve: ?*const fn (context: *anyopaque, objects: []const u8) ?[]const u8 = null,
    /// An object envelope the live session recorded, for the Transcript.
    record: ?*const fn (context: *anyopaque, envelope: []const u8) void = null,
    /// Whether the driver answers later rather than block (`session-v1`,
    /// ADR 0180): a Host call that would wait for a line, a prompt's
    /// answer, a deadline, or a `null` answer stays open instead, and
    /// `submit`, `deadline` and `resumeCall` fail with `error.Suspended`
    /// until the driver can go on.
    suspends: bool = false,
};

/// What an open Host call waits for (`Driver.suspends`).
pub const Waiting = enum {
    /// Nothing: the session takes an Entry or Session Command.
    prompt,
    /// A line for the foreground's `console` `read`.
    read,
    /// An answer to the foreground's `user` prompt.
    user,
    /// The foreground's next deadline, under a real Clock.
    deadline,
    /// The driver's answer to a crossing, or to a `write` or `resolve`.
    need,
};

/// How an open Host call goes on.
pub const Resume = enum {
    /// The driver has its line, its prompt answer or its need's answer.
    answered,
    /// A deadline came: Pump, as a sleeping REPL would on waking.
    wake,
    /// The person typed something else: the foreground's wait ends, as a
    /// replay ends it when the Transcript reads on.
    abandon,
};

/// A `user` prompt as the person sees it (chapter 12, Prompts): `confirm`,
/// `choose` or `enter`, with an omitted message, prompt or default empty.
pub const Prompt = struct {
    call: []const u8,
    kind: []const u8,
    message: []const u8 = "",
    prompt: []const u8 = "",
    fallback: []const u8 = "",
    items: []const []const u8 = &.{},
    multiple: bool = false,
};

const Mode = enum { immediate, suspending, fire_and_forget };

/// A mock Operation, with its queued Stubs.
const Mock = struct {
    session: *Session,
    capability: []const u8,
    operation: []const u8,
    mode: Mode,
    /// A suspending mock declared `read-only`, whose calls `:charge` takes.
    metered: bool = false,
    stubs: std.ArrayList(Stub) = .empty,
};

const Stub = struct { shown: []const u8, fail: bool };

/// A `:grant`: the name, the Capability and its binding.
const GrantSpec = struct { name: []const u8, capability: []const u8, binding: ?[]const u8 };

/// A declaration of the session source: its text, its kind and the names it
/// declares.
const Decl = struct {
    text: []const u8,
    kind: Kind,
    /// Its name, or for `use` its names as the Script sees them.
    names: []const []const u8,
    /// For `use`: the imported names, the Library and the rename.
    use: ?Use = null,
    /// For a script variable: its initialiser's text, after `=`, if any.
    init: ?[]const u8 = null,
    /// For a Handler: its Selector's first word, which an Entry calls it by.
    word: []const u8 = "",

    const Kind = enum { handler, function, constant, variable, use, fallback };
    const Use = struct { names: []const []const u8, library: []const u8, rename: ?[]const u8 };
};

/// Where an Entry's extension unit is, for its positions: its unit name,
/// the lines before the Entry's first, and whether `return ` comes before
/// its first line.
const EntryUnit = struct { unit: []const u8, handler: []const u8, lines: u32, expression: bool };

const PendingKind = enum { mock, read, prompt };
const PendingCall = struct { id: []const u8, run: []const u8, kind: PendingKind, call: ?*c.talk_call, mock: ?*Mock = null, prompt: ?Prompt = null };

/// What an open Host call stopped for (`Driver.suspends`).
const Open = enum { read, user, deadline, crossing, rerun };

/// A Pump stopped at a Crossing Pause: its reading, its result so far,
/// whether it is one of the Pumps for admitted Notifications, and the
/// state the Host call's own Pump left.
const OpenPump = struct { at: Instant, result: c.talk_pump_result, notifying: bool, state: c.talk_group_state };

/// A `:fix` whose rewind Pump stopped at a crossing: the Run and the
/// declarations its Reload puts in place.
const Fixing = struct { run: []const u8, decls: []const Decl };

/// A Run the Session Host knows has not ended.
const RunInfo = struct { id: []const u8, entry: ?u64 = null };

/// The foreground: the Entry's Run while its Host call goes on.
const Foreground = struct { run: ?[]const u8 = null, delivery: []const u8, entry: u64, expression: bool, inspect: bool = false, ended: bool = false };

/// What `:save` keeps beside the Group.
const Checkpoint = struct {
    bytes: []const u8,
    decls: []const Decl,
    next_entry: u64,
    extensions: u32,
    units: []const EntryUnit,
    entry_runs: []const RunEntry,
    limits: Limits,
    clock: Clock,
    stubs: []const []const Stub,
    observing: Observing,
};

const RunEntry = struct { run: []const u8, entry: u64, expression: bool, inspect: bool = false };

/// A Fuel Measurement: an Entry's root Delivery and every Run spawned from
/// it, each counted at its latest cumulative Fuel.
const Measurement = struct {
    entry: []const u8,
    root: []const u8,
    members: std.StringArrayHashMapUnmanaged(i64) = .empty,
    live: i64 = 0,
    queued: i64 = 0,
    interrupted: bool = false,
    settled: bool = false,
    /// Whether its final row has been printed.
    final: bool = false,
    /// Whether the Host call in progress started it.
    started: bool = false,

    fn fuel(m: *const Measurement) i64 {
        var n: i64 = 0;
        for (m.members.values()) |f| n += f;
        return n;
    }
};

const Observing = struct {
    filters: std.StringArrayHashMapUnmanaged(void) = .empty,
    /// Each traced Run's Selector.
    latched: std.StringArrayHashMapUnmanaged([]const u8) = .empty,
    measurements: std.ArrayList(Measurement) = .empty,

    fn clone(o: *const Observing, a: Allocator) !Observing {
        var out: Observing = .{ .filters = try o.filters.clone(a), .latched = try o.latched.clone(a) };
        for (o.measurements.items) |m| {
            var copy = m;
            copy.members = try m.members.clone(a);
            try out.measurements.append(a, copy);
        }
        return out;
    }
};

pub const Limits = struct {
    fuel_per_run: ?i64 = null,
    alloc_per_run: ?i64 = null,
    max_wait_ms: ?i64 = null,
    max_join: ?i64 = null,
};

pub const Clock = union(enum) { real, virtual: Instant };

pub const Session = struct {
    gpa: Allocator,
    /// Owns everything the session keeps for its whole life.
    arena: std.heap.ArenaAllocator,
    driver: Driver,
    core: *c.talk_core,
    group: ?*c.talk_group = null,
    script: ?*c.talk_script = null,
    started: bool = false,
    clock: Clock = .real,
    /// The last Pump's Clock reading.
    last: ?Instant = null,
    /// The last Pump's next deadline, if it left one.
    next_deadline: ?Instant = null,
    grants: std.ArrayList(GrantSpec) = .empty,
    mocks: std.ArrayList(*Mock) = .empty,
    defs: std.StringHashMapUnmanaged(*c.talk_capability_def) = .empty,
    console_def: ?*c.talk_capability_def = null,
    user_def: ?*c.talk_capability_def = null,
    /// The Grants the Script loaded with, which a restore re-binds.
    loaded: std.ArrayList(c.talk_load_grant) = .empty,
    decls: std.ArrayList(Decl) = .empty,
    next_entry: u64 = 1,
    /// The Script's extensions since its last load or Reload.
    extensions: u32 = 0,
    units: std.ArrayList(EntryUnit) = .empty,
    /// The Entries' Runs, which a later echo or error names.
    entry_runs: std.ArrayList(RunEntry) = .empty,
    limits: Limits = .{},
    live: std.ArrayList(RunInfo) = .empty,
    pending: std.ArrayList(PendingCall) = .empty,
    foreground: ?Foreground = null,
    /// The Run the last `unhandled` run end named, for its line.
    unhandled_run: ?[]const u8 = null,
    saves: std.StringArrayHashMapUnmanaged(Checkpoint) = .empty,
    libraries: std.StringArrayHashMapUnmanaged(Library) = .empty,
    /// This Host call's output lines, printed at its end.
    out: std.ArrayList([]const u8) = .empty,
    /// Output a Host function made in a Pump, by call id, which the call's
    /// Trace record places.
    held: std.StringArrayHashMapUnmanaged(Held) = .empty,
    /// The Trace lines of the Host call in progress.
    trace_lines: std.ArrayList([]const u8) = .empty,
    /// Whether a Host function queued a Host Input in the Pump.
    queued: bool = false,
    /// Each Run's last `seg` end reason and whether it had a deadline.
    waits: std.StringHashMapUnmanaged(Wait) = .empty,
    /// The Session Stores, and the router their watches go through.
    router: *c.talk_router,
    stores: store.Stores,
    /// Whether the router admitted a Notification since this was cleared.
    admitted: bool = false,
    /// Every unit's source the session has seen, by code identity.
    sources: std.AutoHashMapUnmanaged([32]u8, UnitSource) = .empty,
    /// Observation (session-observation.md): trace filters, the Runs they
    /// latched, and Fuel Measurements.
    observing: Observing = .{},
    /// This Host call's trace rows, which follow its ordinary output.
    trace_out: std.ArrayList([]const u8) = .empty,
    /// Whether the Entry being run is measured, by `:fuel`.
    measuring: bool = false,
    /// Object crossings: the recorded Object Kinds, the identities
    /// registered before the Group was made, the initial bindings, and the
    /// Function Values exposed under each handle.
    kinds: std.StringHashMapUnmanaged(KindInfo) = .empty,
    objects: std.ArrayList(ObjectRef) = .empty,
    setup: std.ArrayList(SetupBinding) = .empty,
    handles: std.StringHashMapUnmanaged(*c.talk_value) = .empty,
    /// The object an `:inspect` Run returned, for its reader Run.
    reader: ?*c.talk_value = null,
    /// A Restore's recorded resolver outcomes, and how many it used.
    resolved: ?[]const std.json.Value = null,
    resolved_used: usize = 0,
    /// A live Restore's answers, by identity.
    resolving: std.ArrayList(Resolution) = .empty,
    /// The recording's counters (session-observation.md), which a Restore
    /// doesn't rewind: property crossings, Value exposures and Function
    /// handles.
    crossed: u64 = 0,
    exposures: u64 = 0,
    handle_count: u64 = 0,
    /// The handle each exposed Function Value was last given, by its
    /// address, for writing it in a crossing.
    supplied: std.AutoHashMapUnmanaged(usize, []const u8) = .empty,
    /// A suspending driver's open Host call (`session-v1`, ADR 0180): what
    /// it waits for, and the input it is for, which runs again from its
    /// start after a `write` or `resolve` answer. The caller keeps the
    /// input alive until the call ends.
    open: ?Open = null,
    current: ?transcript.Input = null,
    /// Every call the Group issued to the session, by id, waiting or not,
    /// which a Host action may answer or fail; a late reply is recorded and
    /// ignored. A Restore's new Group starts it again.
    issued: std.StringHashMapUnmanaged(*c.talk_call) = .empty,
    /// The Pump an open crossing stopped, and that crossing's `prop` need,
    /// once its `property-begin` is recorded.
    open_pump: ?OpenPump = null,
    crossing_need: ?[]const u8 = null,
    fixing: ?Fixing = null,
    /// Whether `endCall`'s own Pump is the one going on.
    ending: bool = false,
    /// How the open call resumes: Pump at the deadline, or end the wait.
    wake: bool = false,
    abandon: bool = false,

    const ObjectRef = struct { kind: []const u8, id: []const u8 };
    const Resolution = struct { kind: []const u8, id: []const u8, resolved: bool = false };
    const SetupBinding = struct { name: []const u8, kind: []const u8, id: []const u8 };

    const Library = struct { source: []const u8, library: *c.talk_library };
    const UnitSource = struct { name: []const u8, source: []const u8 };
    const Held = struct { run: []const u8, lines: std.ArrayList([]const u8) = .empty };
    const Wait = struct { reason: []const u8, until: bool };

    pub fn init(gpa: Allocator, driver: Driver) !*Session {
        const s = try gpa.create(Session);
        errdefer gpa.destroy(s);
        const options: c.talk_router_options = .{ .context = s, .admitted = admittedHook, .limits = watchLimits, .revision = revisionOf, .store_of = storeOf };
        const router = c.talk_router_new(&options) orelse return error.OutOfMemory;
        s.* = .{ .gpa = gpa, .arena = .init(gpa), .driver = driver, .core = c.talk_new() orelse return error.OutOfMemory, .router = router, .stores = .init(gpa, router) };
        return s;
    }

    pub fn deinit(s: *Session) void {
        if (s.group) |g| {
            c.talk_router_detach(s.router, g);
            c.talk_group_release(g);
        }
        c.talk_router_free(s.router);
        s.stores.deinit();
        c.talk_core_release(s.core);
        s.arena.deinit();
        s.gpa.destroy(s);
    }

    // ------------------------------------------------------------ the router's Host side

    fn admittedHook(context: ?*anyopaque, g: ?*c.talk_group) callconv(.c) void {
        _ = g;
        const s: *Session = @ptrCast(@alignCast(context.?));
        s.admitted = true;
    }

    /// Each Session Store's watch limits (chapter 12, The Session Store).
    fn watchLimits(context: ?*anyopaque, name: [*c]const u8, len: usize) callconv(.c) c.talk_watch_limits {
        _ = context;
        _ = name;
        _ = len;
        return .{ .watches = 100, .watch_size = 65_536, .pending = 1_000, .pending_size = 1_048_576 };
    }

    fn revisionOf(context: ?*anyopaque, name: [*c]const u8, len: usize, out: [*c][*c]const u8, out_len: [*c]usize) callconv(.c) void {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const text = s.stores.named(name[0..len]).revision_text;
        out.* = text.ptr;
        out_len.* = text.len;
    }

    fn storeOf(context: ?*anyopaque, binding: ?*anyopaque, out: [*c][*c]const u8, out_len: [*c]usize) callconv(.c) bool {
        _ = context;
        const name: []const u8 = if (binding) |b| std.mem.span(@as([*:0]const u8, @ptrCast(b))) else "default";
        out.* = name.ptr;
        out_len.* = name.len;
        return true;
    }

    fn alloc(s: *Session) Allocator {
        return s.arena.allocator();
    }

    fn dupe(s: *Session, x: []const u8) []const u8 {
        return s.alloc().dupe(u8, x) catch @panic("out of memory");
    }

    fn print(s: *Session, comptime fmt: []const u8, args: anytype) []const u8 {
        return std.fmt.allocPrint(s.alloc(), fmt, args) catch @panic("out of memory");
    }

    // ------------------------------------------------------------ output

    fn say(s: *Session, line: []const u8) void {
        s.out.append(s.alloc(), s.dupe(line)) catch {};
    }

    fn sayf(s: *Session, comptime fmt: []const u8, args: anytype) void {
        s.out.append(s.alloc(), s.print(fmt, args)) catch {};
    }

    /// Ends a Host call: its lines, in order.
    fn flush(s: *Session) void {
        s.flushLines();
        // Fuel rows: once after the Host call that started a measurement
        // yields or completes, and again when one settles later.
        for (s.observing.measurements.items) |*m| {
            if (m.started or (m.settled and !m.final)) {
                s.driver.output(s.driver.context, s.fuelRow(m));
                if (m.settled) m.final = true;
            }
            m.started = false;
        }
    }

    fn flushLines(s: *Session) void {
        for (s.out.items) |line| s.driver.output(s.driver.context, line);
        s.out.clearRetainingCapacity();
        for (s.trace_out.items) |line| s.driver.output(s.driver.context, line);
        s.trace_out.clearRetainingCapacity();
    }

    /// The Host call yields to a wait of its foreground: its lines so far,
    /// then the pending row of each measurement it started (session
    /// observation, Fuel measurements).
    fn yieldRows(s: *Session) void {
        s.flushLines();
        for (s.observing.measurements.items) |*m| {
            if (!m.started) continue;
            m.started = false;
            s.driver.output(s.driver.context, s.fuelRow(m));
            if (m.settled) m.final = true;
        }
    }

    fn fuelRow(s: *Session, m: *const Measurement) []const u8 {
        const state = if (!m.settled) "pending" else if (m.interrupted) "interrupted" else "complete";
        return s.print("fuel {{entry: {s}, fuel: {d}, state: {s}, interrupted: {}, runs: {d}, queued: {d}}}", .{ s.textShown(m.entry), m.fuel(), s.textShown(state), m.interrupted, m.live, m.queued });
    }

    /// The prefix a Run's lines take: none for the foreground Run, and
    /// `[<run>] ` for any other.
    fn prefix(s: *Session, run: []const u8) []const u8 {
        if (s.foreground) |f| if (!f.ended) if (f.run) |r| if (std.mem.eql(u8, r, run)) return "";
        return s.print("[{s}] ", .{run});
    }

    /// Lines a Host function printed for a Run: a text's lines each, so a
    /// line break inside it starts a new one.
    fn hold(s: *Session, call: []const u8, run: []const u8, text: []const u8) void {
        const e = s.held.getOrPut(s.alloc(), s.dupe(call)) catch return;
        if (!e.found_existing) e.value_ptr.* = .{ .run = s.dupe(run) };
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |l| e.value_ptr.lines.append(s.alloc(), s.dupe(l)) catch {};
    }

    /// Prints what a Host function held, now that its Run's place is known.
    fn sayHeld(s: *Session, h: Held) void {
        const p = s.prefix(h.run);
        for (h.lines.items) |l| s.sayf("{s}{s}", .{ p, l });
    }

    // ------------------------------------------------------------ the Trace

    fn traceSink(context: ?*anyopaque, line: [*c]const u8, len: usize) callconv(.c) void {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const text = line[0..len];
        s.driver.trace(s.driver.context, text);
        s.trace_lines.append(s.alloc(), s.dupe(text)) catch {};
        // An Operation call's arguments are a Value exposure
        // (session-observation.md), numbered as its record arrives.
        if (std.mem.startsWith(u8, text, "call ")) s.exposures += 1;
        // A Run's Segment end, which says whether it waits for a deadline.
        if (std.mem.startsWith(u8, text, "seg ") or std.mem.startsWith(u8, text, "preempt ")) {
            const rest = text[std.mem.indexOfScalar(u8, text, ' ').? + 1 ..];
            const run = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            const reason = field(text, "end") orelse "";
            s.waits.put(s.alloc(), s.dupe(run), .{ .reason = s.dupe(reason), .until = field(text, "until") != null }) catch {};
        }
    }

    /// Writes a line into the Trace, as the runner writes `stub` lines.
    fn writeTrace(s: *Session, line: []const u8) void {
        s.driver.trace(s.driver.context, line);
    }

    // ------------------------------------------------------------ starting

    /// Starts the session at its first Entry or Session Command other than
    /// `:grant` and `:mock`: the Group, its Grants, and the Session Script
    /// loaded from empty source.
    fn start(s: *Session) !void {
        if (s.started) return;
        s.started = true;
        const options: c.talk_group_options = .{ .name = "session", .name_len = 7, .trace = traceSink, .trace_context = s, .allocator = null, .memory_cap = 0 };
        var group: ?*c.talk_group = null;
        try check_(c.talk_new_group(s.core, &options, &group));
        s.group = group;
        // console, with both Operations, at no cost.
        const console_costs = [_]c.talk_named_cost{ .{ .name = "write", .name_len = 5, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "read", .name_len = 4, .cost = .{ .fuel = 0, .alloc = 0 } } };
        const console: c.talk_console_impl = .{ .context = s, .write = consoleWrite, .read = consoleRead };
        var def: ?*c.talk_capability_def = null;
        try check_(c.talk_console_capability(s.core, &console, &.{ .entries = &console_costs, .len = 2 }, &def));
        s.console_def = def;
        var grant: ?*c.talk_grant = null;
        try check_(c.talk_capability_def_grant_all(def, null, &grant));
        try s.loaded.append(s.alloc(), .{ .name = "console", .name_len = 7, .grant = grant });
        for (s.grants.items) |g| {
            const d = try s.definition(g.capability);
            var made: ?*c.talk_grant = null;
            const binding: ?*anyopaque = if (g.binding) |b| @ptrCast(@constCast((try s.alloc().dupeSentinel(u8, b, 0)).ptr)) else null;
            try check_(c.talk_capability_def_grant_all(d, binding, &made));
            try s.loaded.append(s.alloc(), .{ .name = g.name.ptr, .name_len = g.name.len, .grant = made });
        }
        for (s.mocks.items) |m| {
            // A mock grants its Capability under its own name, once.
            const named = for (s.loaded.items) |l| {
                if (std.mem.eql(u8, l.name[0..l.name_len], m.capability)) break true;
            } else false;
            if (named) continue;
            const d = try s.definition(m.capability);
            var made: ?*c.talk_grant = null;
            try check_(c.talk_capability_def_grant_all(d, null, &made));
            try s.loaded.append(s.alloc(), .{ .name = m.capability.ptr, .name_len = m.capability.len, .grant = made });
        }
        // Recorded objects, as dummy native identities, and the initial
        // bindings.
        for (s.objects.items) |o| _ = try s.objectOf(o.kind, o.id);
        var bound: std.ArrayList(c.talk_load_object) = .empty;
        for (s.setup.items) |b| try bound.append(s.alloc(), .{ .name = b.name.ptr, .name_len = b.name.len, .object = try s.objectOf(b.kind, b.id) });
        const load: c.talk_load_options = .{ .name = "session", .name_len = 7, .source = "", .source_len = 0, .grants = s.loaded.items.ptr, .grants_len = s.loaded.items.len, .grants_as_used = false, .forbid_suspension = false, .owner = null, .objects = bound.items.ptr, .objects_len = bound.items.len, .limits = null };
        var script: ?*c.talk_script = null;
        try check_(c.talk_load(s.group, &load, &script));
        s.script = script;
        s.harvest();
    }

    /// The Capability a `:grant` or a mock names, defined once.
    fn definition(s: *Session, capability: []const u8) !*c.talk_capability_def {
        if (s.defs.get(capability)) |d| return d;
        var def: ?*c.talk_capability_def = null;
        if (std.mem.eql(u8, capability, "store")) {
            def = try s.stores.capability(s.core);
        } else if (std.mem.eql(u8, capability, "clock")) {
            // `now` reads the Pump's Clock reading, at no cost.
            const costs = [_]c.talk_named_cost{.{ .name = "now", .name_len = 3, .cost = .{ .fuel = 0, .alloc = 0 } }};
            try check_(c.talk_clock_capability(s.core, &.{ .entries = &costs, .len = 1 }, &def));
        } else if (std.mem.eql(u8, capability, "user")) {
            const costs = [_]c.talk_named_cost{ .{ .name = "confirm", .name_len = 7, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "choose", .name_len = 6, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "enter", .name_len = 5, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "notify", .name_len = 6, .cost = .{ .fuel = 0, .alloc = 0 } } };
            const impl: c.talk_user_impl = .{ .context = s, .confirm = userConfirm, .choose = userChoose, .enter = userEnter, .notify = userNotify };
            try check_(c.talk_user_capability(s.core, &impl, &.{ .entries = &costs, .len = 4 }, &def));
        } else {
            // A mock Capability: its Operations, each with eight Optional
            // `any` arguments and any result, costing nothing.
            var ops: std.ArrayList(c.talk_operation) = .empty;
            const optional = blk: {
                var shape: ?*c.talk_shape = null;
                try check_(c.talk_optional(c.talk_any_shape(), &shape));
                break :blk shape;
            };
            const args = try s.alloc().alloc(?*const c.talk_shape, 8);
            for (args) |*x| x.* = optional;
            for (s.mocks.items) |m| if (std.mem.eql(u8, m.capability, capability)) {
                try ops.append(s.alloc(), .{
                    .name = m.operation.ptr,
                    .name_len = m.operation.len,
                    .args = @ptrCast(args.ptr),
                    .args_len = 8,
                    .result = if (m.mode == .fire_and_forget) null else c.talk_any_shape(),
                    .cost = .{ .fuel = 0, .alloc = 0 },
                    .mode = switch (m.mode) {
                        .immediate => c.TALK_IMMEDIATE,
                        .suspending => c.TALK_SUSPENDING,
                        .fire_and_forget => c.TALK_FIRE_AND_FORGET,
                    },
                    .max_pending_ms = 0,
                    .errors = null,
                    .errors_len = 0,
                    .@"fn" = mockCall,
                    .context = m,
                    .scope = null,
                    .segment_bound = false,
                    .metering = if (m.metered) "read-only" else null,
                    .metering_len = if (m.metered) "read-only".len else 0,
                });
            };
            try check_(c.talk_define_capability(s.core, capability.ptr, capability.len, ops.items.ptr, ops.items.len, null, 0, &def));
        }
        try s.defs.put(s.alloc(), s.dupe(capability), def.?);
        return def.?;
    }

    // ------------------------------------------------------------ Host functions

    /// Keeps a suspending call for a Host action's answer.
    fn issue(s: *Session, call: ?*c.talk_call) void {
        const x = call orelse return;
        s.issued.put(s.alloc(), s.dupe(callId(x)), x) catch {};
    }

    fn callId(call: ?*c.talk_call) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        c.talk_call_id(call, &p, &n);
        return p[0..n];
    }

    fn callRun(call: ?*c.talk_call) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        c.talk_call_run_id(call, &p, &n);
        return p[0..n];
    }

    fn consoleWrite(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        const s: *Session = @ptrCast(@alignCast(context.?));
        if (len >= 1) s.hold(callId(call), callRun(call), s.textForm(args[0]));
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn consoleRead(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = args;
        _ = len;
        _ = result;
        _ = err;
        const s: *Session = @ptrCast(@alignCast(context.?));
        s.pending.append(s.alloc(), .{ .id = s.dupe(callId(call)), .run = s.dupe(callRun(call)), .kind = .read, .call = call }) catch return c.TALK_CALL_BROKEN;
        s.issue(call);
        return c.TALK_CALL_STARTED;
    }

    /// A user prompt: one at a time, so another while one waits is `user
    /// busy`; otherwise answered now if the driver has the answer, or it
    /// waits for the person.
    fn userConfirm(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        return userPrompt("confirm", context, call, args, len, result, err);
    }

    fn userChoose(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        return userPrompt("choose", context, call, args, len, result, err);
    }

    fn userEnter(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        return userPrompt("enter", context, call, args, len, result, err);
    }

    fn userPrompt(kind: []const u8, context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const id = callId(call);
        // One at a time: the next while one waits is `user busy`, which is
        // its answer at once.
        const busy = for (s.pending.items) |p| {
            if (p.kind == .prompt) break true;
        } else false;
        if (busy) {
            const ans = s.driver.answer(s.driver.context, id, true) orelse user_busy;
            return s.answerNow(ans, result, err);
        }
        const described = s.promptOf(id, kind, args[0..len]) catch return c.TALK_CALL_BROKEN;
        s.pending.append(s.alloc(), .{ .id = s.dupe(id), .run = s.dupe(callRun(call)), .kind = .prompt, .call = call, .prompt = described }) catch return c.TALK_CALL_BROKEN;
        s.issue(call);
        return c.TALK_CALL_STARTED;
    }

    /// A prompt as the person sees it, from its Operation's arguments
    /// (talk.h's `talk_user_impl`): `confirm`'s message; `choose`'s items,
    /// prompt and multiple; `enter`'s message and default.
    fn promptOf(s: *Session, id: []const u8, kind: []const u8, args: []const ?*c.talk_value) !Prompt {
        var p: Prompt = .{ .call = s.dupe(id), .kind = kind };
        if (args.len == 0) return p;
        if (std.mem.eql(u8, kind, "choose")) {
            var items: std.ArrayList([]const u8) = .empty;
            for (1..c.talk_value_len(args[0]) + 1) |i| {
                var item: ?*c.talk_value = null;
                try check_(c.talk_value_index(args[0], i, &item));
                defer c.talk_value_release(item);
                try items.append(s.alloc(), s.textForm(item));
            }
            p.items = items.items;
            if (args.len >= 2) p.prompt = s.textForm(args[1]);
            var yes = false;
            if (args.len >= 3 and c.talk_value_as_bool(args[2], &yes)) p.multiple = yes;
            return p;
        }
        p.message = s.textForm(args[0]);
        if (std.mem.eql(u8, kind, "enter") and args.len >= 2) p.fallback = s.textForm(args[1]);
        return p;
    }

    fn answerNow(s: *Session, ans: Answer, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        if (ans.fail) {
            if (!s.scriptError(ans.shown, err)) return c.TALK_CALL_BROKEN;
            return c.TALK_CALL_FAILED;
        }
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(ans.shown.ptr, ans.shown.len, &v) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        result.* = v;
        return c.TALK_CALL_ANSWERED;
    }

    fn userNotify(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        const s: *Session = @ptrCast(@alignCast(context.?));
        const message = if (len >= 1) s.textForm(args[0]) else "";
        const title = if (len >= 2) s.textForm(args[1]) else "";
        const text = if (title.len > 0) s.print("* {s}: {s}", .{ title, message }) else s.print("* {s}", .{message});
        s.hold(callId(call), callRun(call), text);
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn mockCall(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const m: *Mock = @ptrCast(@alignCast(context.?));
        const s = m.session;
        const id = callId(call);
        var shown: std.ArrayList(u8) = .empty;
        shown.append(s.alloc(), '[') catch {};
        for (args[0..len], 0..) |v, i| {
            if (i > 0) shown.appendSlice(s.alloc(), ", ") catch {};
            shown.appendSlice(s.alloc(), s.display(v)) catch {};
        }
        shown.append(s.alloc(), ']') catch {};
        s.hold(id, callRun(call), s.print("call {s} {s}.{s} {s}", .{ id, m.capability, m.operation, shown.items }));
        switch (m.mode) {
            .fire_and_forget => {
                _ = c.talk_nothing(result);
                return c.TALK_CALL_ANSWERED;
            },
            .suspending => {
                s.pending.append(s.alloc(), .{ .id = s.dupe(id), .run = s.dupe(callRun(call)), .kind = .mock, .call = call, .mock = m }) catch return c.TALK_CALL_BROKEN;
                s.issue(call);
                return c.TALK_CALL_STARTED;
            },
            .immediate => {
                if (m.stubs.items.len == 0) return c.TALK_CALL_BROKEN;
                const stub = m.stubs.orderedRemove(0);
                return s.answerNow(.{ .shown = stub.shown, .fail = stub.fail }, result, err);
            },
        }
    }

    // ------------------------------------------------------------ values

    fn display(s: *Session, v: ?*const c.talk_value) []const u8 {
        var buf: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_value_string(v, &buf) != c.TALK_OK) return "";
        defer c.talk_owned_bytes_release(&buf);
        return s.dupe(buf.data[0..buf.len]);
    }

    fn textForm(s: *Session, v: ?*const c.talk_value) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        if (c.talk_value_as_text(v, &p, &n)) return s.dupe(p[0..n]);
        return s.display(v);
    }

    /// A shown error map as a Script error: its code, message and the rest
    /// as Data.
    fn scriptError(s: *Session, shown: []const u8, err: *c.talk_script_error) bool {
        var e: ?*c.talk_value = null;
        if (c.talk_parse_display(shown.ptr, shown.len, &e) != c.TALK_OK) return false;
        defer c.talk_value_release(e);
        var code_value: ?*c.talk_value = null;
        if (c.talk_value_get(e, "code", 4, &code_value) != c.TALK_OK or code_value == null) return false;
        defer c.talk_value_release(code_value);
        var p: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(code_value, &p, &n)) return false;
        const code = s.dupe(p[0..n]);
        var message: ?[]const u8 = null;
        var pairs: std.ArrayList(c.talk_pair) = .empty;
        var i: usize = 0;
        var pair: c.talk_pair = undefined;
        while (c.talk_value_entries(e, i, &pair)) : (i += 1) {
            const key = pair.key[0..pair.key_len];
            if (std.mem.eql(u8, key, "code")) continue;
            if (std.mem.eql(u8, key, "message")) {
                if (c.talk_value_as_text(pair.value, &p, &n)) message = s.dupe(p[0..n]);
                continue;
            }
            pairs.append(s.alloc(), .{ .key = s.dupe(key).ptr, .key_len = key.len, .value = pair.value }) catch return false;
        }
        var data: ?*c.talk_value = null;
        if (c.talk_map(pairs.items.ptr, pairs.items.len, &data) != c.TALK_OK) return false;
        err.* = .{ .code = code.ptr, .code_len = code.len, .message = if (message) |m| m.ptr else null, .message_len = if (message) |m| m.len else 0, .data = data };
        return true;
    }

    /// An error map as Session lines show it: without `message` and `at`.
    fn errorShown(s: *Session, e: ?*const c.talk_value) []const u8 {
        var pairs: std.ArrayList(c.talk_pair) = .empty;
        var i: usize = 0;
        var pair: c.talk_pair = undefined;
        while (c.talk_value_entries(e, i, &pair)) : (i += 1) {
            const key = pair.key[0..pair.key_len];
            if (std.mem.eql(u8, key, "message") or std.mem.eql(u8, key, "at")) continue;
            pairs.append(s.alloc(), pair) catch {};
        }
        var shown: ?*c.talk_value = null;
        if (c.talk_map(pairs.items.ptr, pairs.items.len, &shown) != c.TALK_OK) return "{}";
        defer c.talk_value_release(shown);
        return s.display(shown);
    }

    // ------------------------------------------------------------ positions

    /// `<line>:<column>` in an Entry's own lines, or `<unit>:<line>:<column>`.
    fn where(s: *Session, unit: []const u8, line: i64, column: i64) []const u8 {
        for (s.units.items) |u| if (std.mem.eql(u8, u.unit, unit)) {
            const l = line - u.lines;
            if (l >= 1) {
                const col = if (l == 1 and u.expression) column - 7 else column;
                return s.print("{d}:{d}", .{ l, col });
            }
        };
        return s.print("{s}:{d}:{d}", .{ unit, line, column });
    }

    fn errorWhere(s: *Session, e: ?*const c.talk_value) []const u8 {
        var at: ?*c.talk_value = null;
        if (c.talk_value_get(e, "at", 2, &at) != c.TALK_OK or at == null) return "";
        defer c.talk_value_release(at);
        const unit = s.getText(at, "unit") orelse return "";
        const line = s.getInt(at, "line") orelse return "";
        const column = s.getInt(at, "column") orelse return "";
        return s.where(unit, line, column);
    }

    fn getText(s: *Session, v: ?*const c.talk_value, key: []const u8) ?[]const u8 {
        var x: ?*c.talk_value = null;
        if (c.talk_value_get(v, key.ptr, key.len, &x) != c.TALK_OK or x == null) return null;
        defer c.talk_value_release(x);
        var p: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(x, &p, &n)) return null;
        return s.dupe(p[0..n]);
    }

    fn getInt(s: *Session, v: ?*const c.talk_value, key: []const u8) ?i64 {
        _ = s;
        var x: ?*c.talk_value = null;
        if (c.talk_value_get(v, key.ptr, key.len, &x) != c.TALK_OK or x == null) return null;
        defer c.talk_value_release(x);
        var d: ?*const c.talk_decimal = null;
        if (!c.talk_value_as_dec(x, &d)) return null;
        var n: i64 = 0;
        if (c.talk_decimal_int64(d, &n) != c.TALK_OK) return null;
        return n;
    }

    // ------------------------------------------------------------ Pumps

    fn readingFor(s: *Session) ?Instant {
        switch (s.clock) {
            .virtual => |v| return v,
            .real => {
                var r = s.driver.reading(s.driver.context) orelse return null;
                // A real reading earlier than the last Pump's is taken as it.
                if (s.last) |l| if (r.before(l)) {
                    r = l;
                };
                return r;
            },
        }
    }

    /// Runs one Pump at the session's Clock, then follows its Runs through
    /// its reports and Trace. False when there is no reading for it.
    fn pump(s: *Session) !bool {
        const at = s.readingFor() orelse return false;
        try s.pumpAt(at);
        return true;
    }

    fn pumpAt(s: *Session, at: Instant) !void {
        _ = try s.pumpState(at);
    }

    /// A Pump at `at`, and the state it left the Group in.
    fn pumpState(s: *Session, at: Instant) !c.talk_group_state {
        s.trace_lines.clearRetainingCapacity();
        s.queued = false;
        var result: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
        const code = c.talk_pump(s.group, at.seconds, at.micros, null, &result);
        s.last = at;
        if (code != c.TALK_OK) {
            c.talk_reports_release(result.reports);
            return error.HostError;
        }
        const state = try s.settle(at, result, false, undefined);
        try s.notifications(at, state);
        return state;
    }

    /// A Pump's crossings, then its deadline and its Runs. A crossing a
    /// suspending driver answers later leaves the Pump open, its reports
    /// kept, until `finishPump`.
    fn settle(s: *Session, at: Instant, pumped: c.talk_pump_result, notifying: bool, state: c.talk_group_state) !c.talk_group_state {
        var result = pumped;
        s.answerCrossings(&result) catch |err| {
            if (err == error.Suspended) {
                s.open_pump = .{ .at = at, .result = result, .notifying = notifying, .state = if (notifying) state else result.state };
            } else c.talk_reports_release(result.reports);
            return err;
        };
        defer c.talk_reports_release(result.reports);
        s.deadlineOf(result);
        s.follow(result.reports);
        return result.state;
    }

    /// The rest of a Pump an open crossing stopped, once the driver has its
    /// answer; the state the Host call's own Pump left.
    fn finishPump(s: *Session) !c.talk_group_state {
        const p = s.open_pump.?;
        s.open_pump = null;
        const state = try s.settle(p.at, p.result, p.notifying, p.state);
        const own = if (p.notifying) p.state else state;
        try s.notifications(p.at, own);
        return own;
    }

    fn deadlineOf(s: *Session, result: c.talk_pump_result) void {
        s.next_deadline = if (result.has_next_deadline) .{ .seconds = result.next_deadline_seconds, .micros = result.next_deadline_micros } else null;
    }

    /// When the session next pumps by itself, under a real Clock: the last
    /// Pump's next deadline (chapter 12, The foreground).
    pub fn nextDeadline(s: *const Session) ?Instant {
        if (s.clock != .real) return null;
        return s.next_deadline;
    }

    /// After each Pump: the router's retry, then, while the router admitted
    /// a Notification and Host Inputs are queued, Pumps at the same reading
    /// (chapter 12, Session Store Notifications).
    fn notifications(s: *Session, at: Instant, state: c.talk_group_state) !void {
        while (true) {
            const pending = c.talk_router_pumped(s.router, s.group);
            _ = pending;
            if (!s.admitted) return;
            s.admitted = false;
            s.trace_lines.clearRetainingCapacity();
            var result: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
            const code = c.talk_pump(s.group, at.seconds, at.micros, null, &result);
            if (code != c.TALK_OK) {
                c.talk_reports_release(result.reports);
                return error.HostError;
            }
            _ = try s.settle(at, result, true, state);
        }
    }

    /// Follows a Host call's Runs: its reports, placed by its Trace, so the
    /// lines come in the order the Runs made them.
    fn follow(s: *Session, reports: ?*c.talk_reports) void {
        var items: [*c]const c.talk_report = null;
        const n = c.talk_reports_items(reports, &items);
        for (items[0..n]) |r| s.exposeReport(r);
        // Lifecycle first: Runs started and discarded.
        for (items[0..n]) |r| switch (r.kind) {
            c.TALK_REPORT_RUN_STARTED => {
                const x = r.as.run_started;
                s.live.append(s.alloc(), .{ .id = s.dupe(x.run[0..x.run_len]) }) catch {};
                if (s.foreground) |*f| if (f.run == null and std.mem.eql(u8, x.delivery[0..x.delivery_len], f.delivery)) {
                    f.run = s.dupe(x.run[0..x.run_len]);
                    s.entry_runs.append(s.alloc(), .{ .run = f.run.?, .entry = f.entry, .expression = f.expression, .inspect = f.inspect }) catch {};
                };
            },
            else => {},
        };
        var ends: usize = 0;
        var unhandled: usize = 0;
        for (s.trace_lines.items) |line| {
            if (std.mem.startsWith(u8, line, "call ")) {
                const rest = line[5..];
                const id = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
                if (s.held.fetchOrderedRemove(id)) |kv| s.sayHeld(kv.value);
            } else if (std.mem.startsWith(u8, line, "run ")) {
                const report = nthOf(items[0..n], c.TALK_REPORT_RUN_END, ends) orelse continue;
                ends += 1;
                s.runEnded(report.as.run_end);
            } else if (std.mem.startsWith(u8, line, "unhandled ")) {
                const report = nthOf(items[0..n], c.TALK_REPORT_UNHANDLED, unhandled) orelse continue;
                unhandled += 1;
                const x = report.as.unhandled;
                var shown: std.ArrayList(u8) = .empty;
                shown.append(s.alloc(), '[') catch {};
                for (x.args[0..x.args_len], 0..) |v, i| {
                    if (i > 0) shown.appendSlice(s.alloc(), ", ") catch {};
                    shown.appendSlice(s.alloc(), s.display(v)) catch {};
                }
                shown.append(s.alloc(), ']') catch {};
                const p = if (s.unhandled_run) |run| s.prefix(run) else "";
                s.sayf("{s}! unhandled {s} {s}", .{ p, x.message[0..x.message_len], shown.items });
                s.unhandled_run = null;
            }
        }
        // Output no Trace record placed, in call order.
        for (s.held.values()) |h| s.sayHeld(h);
        s.held.clearRetainingCapacity();
        for (items[0..n]) |r| switch (r.kind) {
            c.TALK_REPORT_RUN_DISCARDED => {
                const x = r.as.run_discarded;
                const reason = x.reason[0..x.reason_len];
                s.forget(x.run[0..x.run_len]);
                if (!std.mem.eql(u8, reason, "rewind")) s.sayf("! discarded {s}", .{x.run[0..x.run_len]});
                s.measureDiscard(x);
            },
            else => {},
        };
        // Trace rows, in lifecycle order.
        for (items[0..n]) |r| switch (r.kind) {
            c.TALK_REPORT_RUN_STARTED => s.traceStart(r.as.run_started),
            c.TALK_REPORT_RUN_END => s.traceEnd(r.as.run_end),
            c.TALK_REPORT_RUN_DISCARDED => s.traceDiscarded(r.as.run_discarded),
            else => {},
        };
        s.measure(items[0..n]);
    }

    fn nthOf(items: []const c.talk_report, kind: c.talk_report_kind, n: usize) ?*const c.talk_report {
        var k: usize = 0;
        for (items) |*r| if (r.kind == kind) {
            if (k == n) return r;
            k += 1;
        };
        return null;
    }

    fn forget(s: *Session, run: []const u8) void {
        for (s.live.items, 0..) |r, i| if (std.mem.eql(u8, r.id, run)) {
            _ = s.live.orderedRemove(i);
            break;
        };
        var i: usize = 0;
        while (i < s.pending.items.len) {
            if (std.mem.eql(u8, s.pending.items[i].run, run)) {
                _ = s.pending.orderedRemove(i);
            } else i += 1;
        }
    }

    fn entryOf(s: *Session, run: []const u8) ?RunEntry {
        for (s.entry_runs.items) |e| if (std.mem.eql(u8, e.run, run)) return e;
        return null;
    }

    /// The lines a Run's end prints: an expression Entry's value, an error,
    /// a Limit Fault, a cancellation, or the Run an `unhandled` line names.
    fn runEnded(s: *Session, x: c.talk_run_end) void {
        const run = x.run[0..x.run_len];
        defer s.forget(run);
        if (s.foreground) |*f| if (f.run) |r| if (std.mem.eql(u8, r, run)) {
            defer f.ended = true;
            s.endLines(x, run);
            return;
        };
        s.endLines(x, run);
    }

    fn endLines(s: *Session, x: c.talk_run_end, run: []const u8) void {
        if (run.len == 0) return;
        const p = s.prefix(run);
        switch (x.outcome) {
            c.TALK_COMPLETED => if (s.entryOf(run)) |e| if (e.inspect) {
                s.valueRows(x.result);
                var o: ?*c.talk_object = null;
                if (c.talk_value_as_object(s.group, x.result, &o)) {
                    c.talk_value_retain(x.result);
                    s.reader = x.result;
                }
            } else if (e.expression) {
                s.sayf("{s}{s}", .{ p, s.display(x.result) });
            },
            c.TALK_ERRORED => {
                const e = x.@"error".*.data;
                s.sayf("{s}! error {s} at {s}", .{ p, s.errorShown(e), s.errorWhere(e) });
            },
            c.TALK_LIMIT_FAULT => s.sayf("{s}! limit fault {s} at {s}", .{ p, x.limit[0..x.limit_len], s.where(x.at.unit[0..x.at.unit_len], x.at.line, x.at.col) }),
            c.TALK_CANCELLED => s.sayf("{s}! cancelled", .{p}),
            c.TALK_UNHANDLED_OUTCOME => s.unhandled_run = s.dupe(run),
            else => {},
        }
    }

    /// The foreground's Host call after its Pump: while the Entry's Run
    /// hasn't ended, answer its `read` or prompt, or under a real Clock
    /// sleep to a deadline it waits for alone, and pump again; otherwise
    /// the Run goes on in the background.
    fn foregroundLoop(s: *Session) !void {
        while (true) {
            const f = s.foreground orelse return;
            if (f.ended) return;
            const run = f.run orelse return;
            const asked = s.pendingOf(run);
            const deadline_wait = s.clock == .real and if (s.waits.get(run)) |w| w.until or asked != null else false;
            if (asked != null or deadline_wait) s.yieldRows();
            if (asked) |i| {
                const p = s.pending.items[i];
                switch (p.kind) {
                    .read => if (s.driver.line(s.driver.context)) |l| {
                        _ = s.pending.orderedRemove(i);
                        var v: ?*c.talk_value = null;
                        try check_(c.talk_text(l.ptr, l.len, &v));
                        defer c.talk_value_release(v);
                        try check_(c.talk_call_answer(p.call, v));
                        if (!try s.pump()) return;
                        continue;
                    },
                    .prompt => if (s.driver.answer(s.driver.context, p.id, false)) |ans| {
                        _ = s.pending.orderedRemove(i);
                        try s.settleCall(p.call, ans);
                        if (!try s.pump()) return;
                        continue;
                    },
                    .mock => return,
                }
            }
            // A suspending driver doesn't block: the call stays open for
            // its line, its answer or its deadline, and is woken to Pump,
            // or abandoned when something else is typed.
            if (s.driver.suspends) {
                const open: Open = if (asked) |i| (if (s.pending.items[i].kind == .read) .read else .user) else if (deadline_wait) .deadline else return;
                if (s.abandon) return;
                if (s.wake and deadline_wait) {
                    s.wake = false;
                    if (!try s.pump()) return;
                    continue;
                }
                s.wake = false;
                return s.suspendCall(open);
            }
            // A deadline under a real Clock: sleep to it, and pump.
            if (deadline_wait) {
                if (s.next_deadline) |until| s.driver.sleep(s.driver.context, until);
                if (!try s.pump()) return;
                continue;
            }
            return;
        }
    }

    fn pendingOf(s: *Session, run: []const u8) ?usize {
        for (s.pending.items, 0..) |p, i| if (std.mem.eql(u8, p.run, run)) return i;
        return null;
    }

    fn settleCall(s: *Session, call: ?*c.talk_call, ans: Answer) !void {
        if (ans.fail) {
            var e: c.talk_script_error = undefined;
            if (s.scriptError(ans.shown, &e)) {
                defer if (e.data) |d| c.talk_value_release(d);
                return check_(c.talk_call_fail(call, &e));
            }
            return check_(c.talk_call_fail(call, null));
        }
        var v: ?*c.talk_value = null;
        try check_(c.talk_parse_display(ans.shown.ptr, ans.shown.len, &v));
        defer c.talk_value_release(v);
        try check_(c.talk_call_answer(call, v));
    }

    /// Ends a Host call: the foreground goes to the background, and when a
    /// Host function queued a Host Input, one more Pump, as its own Host
    /// call.
    fn endCall(s: *Session) !void {
        if (s.ending) {
            // Its own Pump stopped at a crossing, and has now gone on.
            s.ending = false;
            s.flush();
            return;
        }
        s.foreground = null;
        s.flush();
        if (s.queued) {
            s.queued = false;
            s.ending = true;
            const pumped = try s.pump();
            s.ending = false;
            if (pumped) s.flush();
        }
    }

    /// A Pump the Session Host makes at a deadline, as a Transcript's `@`
    /// line outside any other Host call records.
    pub fn deadline(s: *Session, at: Instant) !void {
        if (s.open != null) return error.CallOpen;
        try s.start();
        try s.pumpAt(at);
        try s.endCall();
    }

    // ------------------------------------------------------------ open Host calls

    /// Leaves the Host call open for a suspending driver.
    fn suspendCall(s: *Session, open: Open) error{Suspended} {
        s.open = open;
        if (open == .rerun) {
            // The command runs again from its start: what it said so far
            // goes, and so does a live Restore's first pass.
            s.out.clearRetainingCapacity();
            s.trace_out.clearRetainingCapacity();
            s.resolving.clearRetainingCapacity();
        }
        return error.Suspended;
    }

    /// What the session waits for.
    pub fn waiting(s: *const Session) Waiting {
        const open = s.open orelse return .prompt;
        return switch (open) {
            .read => .read,
            .user => .user,
            .deadline => .deadline,
            .crossing, .rerun => .need,
        };
    }

    /// The foreground's waiting `user` prompt, while the call waits for it.
    pub fn prompt(s: *const Session) ?Prompt {
        if (s.open != .user) return null;
        const f = s.foreground orelse return null;
        const run = f.run orelse return null;
        for (s.pending.items) |p| if (p.kind == .prompt and std.mem.eql(u8, p.run, run)) return p.prompt orelse .{ .call = p.id, .kind = "" };
        return null;
    }

    /// Goes on with the open Host call. Fails with `error.Suspended` if it
    /// stops again.
    pub fn resumeCall(s: *Session, how: Resume) !void {
        const open = s.open orelse return error.NoCallOpen;
        switch (how) {
            .answered => if (open == .deadline) return error.NoCallOpen,
            .wake, .abandon => if (open == .crossing or open == .rerun) return error.NoCallOpen,
        }
        s.open = null;
        if (open == .rerun) return s.submit(s.current.?);
        s.wake = how == .wake;
        s.abandon = how == .abandon;
        defer {
            s.wake = false;
            s.abandon = false;
        }
        try s.continueCall();
    }

    /// The rest of a Host call after the Pump or wait it stopped at: each
    /// Host call's Pumps are in tail position, or are followed by the
    /// foreground's loop, an `:inspect` reader's rows, or a `:fix` Reload,
    /// so this is the rest of any of them.
    fn continueCall(s: *Session) !void {
        if (s.open_pump != null) {
            const state = try s.finishPump();
            if (s.fixing) |f| {
                s.fixing = null;
                try s.fixAfterRewind(state, f);
            }
        }
        try s.foregroundLoop();
        try s.readerRows();
        try s.endCall();
        s.current = null;
    }

    // ------------------------------------------------------------ input

    /// Whether a REPL has the whole of an Entry or Session Command in
    /// `text`, or should wait for more lines (chapter 12, Fenced text in
    /// sessions and tooling): an Entry waits while its syntax ends early or
    /// a fenced literal or hole is open, and so does the expression or Entry
    /// of `:inspect` and `:fuel`. Any other command is one line.
    pub fn complete(s: *Session, text: []const u8) !bool {
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const ta = arena.allocator();
        const trimmed = std.mem.trimStart(u8, text, " \t\n");
        if (trimmed.len == 0) return true;
        if (trimmed[0] == ':') {
            const end = std.mem.indexOfAny(u8, trimmed, " \t\n") orelse return true;
            const name = trimmed[0..end];
            const rest = std.mem.trim(u8, trimmed[end..], " \t\n");
            if (rest.len == 0) return true;
            if (std.mem.eql(u8, name, ":inspect")) {
                const e = try analysis.executable(ta, rest, true, &.{});
                return if (e.problem) |p| !p.incomplete else true;
            }
            if (std.mem.eql(u8, name, ":fuel")) return s.complete(rest);
            return true;
        }
        const e = try s.analyzeEntry(ta, trimmed);
        if (e.doc == .pending) return false;
        return if (e.problem) |p| !p.incomplete else true;
    }

    /// Supplies the Session Script's names to the same analysis the Message
    /// Layer serves. All returned slices live in `ta` or `text`.
    fn analyzeEntry(s: *Session, ta: Allocator, text: []const u8) !analysis.Entry {
        var handlers: std.ArrayList([]const u8) = .empty;
        for (s.decls.items) |d| if (d.kind == .handler) try handlers.append(ta, d.word);
        return analysis.entry(ta, text, handlers.items, try s.boundNames(ta));
    }

    /// Gives the session one Entry or Session Command, with the `|` lines a
    /// Transcript records after it.
    pub fn submit(s: *Session, input: transcript.Input) !void {
        if (s.open) |open| switch (open) {
            // What was typed instead of the line, the answer or the wait.
            .read, .user, .deadline => {
                s.open = null;
                s.abandon = true;
                defer s.abandon = false;
                try s.continueCall();
            },
            .crossing, .rerun => return error.CallOpen,
        };
        s.current = input;
        if (input.first.len > 0 and input.first[0] == ':') {
            try s.command(input);
        } else {
            try s.start();
            try s.entry(input);
        }
        try s.endCall();
        s.current = null;
    }

    // ------------------------------------------------------------ Entries

    fn sayProblem(s: *Session, p: analysis.Problem) void {
        s.sayf("! {s} at {d}:{d}", .{ p.code, p.line, p.column });
    }

    /// Text naming a Session Command rather than an Entry.
    fn isCommand(text: []const u8) bool {
        return std.mem.startsWith(u8, std.mem.trimStart(u8, text, " \t\n"), ":");
    }

    fn entryText(input: transcript.Input, ea: Allocator) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        try out.appendSlice(ea, input.first);
        for (input.more) |l| {
            try out.append(ea, '\n');
            try out.appendSlice(ea, l);
        }
        return out.items;
    }

    fn isOneOf(w: []const u8, words: []const []const u8) bool {
        for (words) |x| if (std.mem.eql(u8, x, w)) return true;
        return false;
    }

    fn entry(s: *Session, input: transcript.Input) !void {
        const text = try entryText(input, s.alloc());
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const e = try s.analyzeEntry(arena.allocator(), text);
        if (e.doc == .pending) return s.say("! bad arguments");
        if (e.doc == .attached) {
            if (e.kind != .declaration) return s.say("! bad arguments");
            if (e.declarations.len > 0 and std.mem.eql(u8, e.declarations[0].kind, "use")) return s.say("! bad arguments");
        }
        if (e.kind == .declaration) return s.declaration(text);
        _ = try s.runEntry(text, e.kind == .expression);
    }

    /// `:inspect <expression>`: one expression, run as an ordinary Entry,
    /// whose value is described in rows rather than echoed.
    fn inspectExpression(s: *Session, rest: []const u8, more: []const []const u8) !void {
        const text = try entryText(.{ .first = rest, .more = more }, s.alloc());
        if (isCommand(text)) return s.say("! bad arguments");
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        // A Handler's name may also name a value. `:inspect` always reads
        // that value as an expression, rather than as a Command Call.
        const e = try analysis.entry(arena.allocator(), text, &.{}, try s.boundNames(arena.allocator()));
        if (e.doc != .none or e.kind != .expression) return s.say("! bad arguments");
        if (e.problem) |p| if (p.trailing) return s.say("! bad arguments");
        _ = try s.runAs(text, true, true);
    }

    /// Whether the Session Script has a Handler whose Selector starts with
    /// this Name.
    fn handlerStarting(s: *Session, name: []const u8) bool {
        for (s.decls.items) |d| if (d.kind == .handler and std.mem.eql(u8, d.word, name)) return true;
        return false;
    }

    const Ran = enum { refused, ran };

    /// Runs a statement or expression as `entry<n>`: its implicit Script
    /// Variables and Handler extend the Script, which is then requested and
    /// pumped.
    fn runEntry(s: *Session, text: []const u8, expression: bool) !Ran {
        return s.runAs(text, expression, false);
    }

    fn runAs(s: *Session, text: []const u8, expression: bool, inspect: bool) !Ran {
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const ta = arena.allocator();
        const n = s.freeEntry();
        const name = s.print("entry{d}", .{n});
        // Its syntax and implicit bindings, in the Entry's own positions.
        const e = try analysis.executable(ta, text, expression, try s.boundNames(ta));
        if (e.problem) |p| {
            s.sayProblem(p);
            return .refused;
        }
        const roots = e.implicit;
        var source: std.ArrayList(u8) = .empty;
        for (roots) |r| try source.print(ta, "script variable {s}\n", .{r});
        try source.print(ta, "on {s}\n{s}{s}\nend {s}\n", .{ name, if (expression) "return " else "", text, name });
        const unit = s.print("session+{d}", .{s.extensions + 1});
        const units_before = s.units.items.len;
        try s.units.append(s.alloc(), .{ .unit = unit, .handler = name, .lines = @intCast(roots.len + 1), .expression = expression });
        const mark = s.trace_lines.items.len;
        const code = c.talk_script_extend(s.script, source.items.ptr, source.items.len);
        if (code != c.TALK_OK) {
            s.units.shrinkRetainingCapacity(units_before);
            s.diagnostics(mark, unit, @intCast(roots.len + 1), expression, false);
            return .refused;
        }
        s.extensions += 1;
        s.harvest();
        s.next_entry = n + 1;
        for (roots) |r| try s.decls.append(s.alloc(), .{ .text = s.print("script variable {s}", .{r}), .kind = .variable, .names = try s.alloc().dupe([]const u8, &.{s.dupe(r)}) });
        // Requested with the `:limits` override, and pumped.
        var override = s.limitOverride();
        const message: c.talk_message = .{ .name = name.ptr, .name_len = name.len, .args = null, .args_len = 0, .limits = if (override.set != 0) &override else null };
        var id: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        var pending: ?*c.talk_pending = null;
        try check_(c.talk_script_request(s.script, &message, &id, &pending));
        const delivery = s.dupe(id.data[0..id.len]);
        c.talk_owned_bytes_release(&id);
        s.foreground = .{ .delivery = delivery, .entry = n, .expression = expression, .inspect = inspect };
        if (s.measuring) try s.observing.measurements.append(s.alloc(), .{ .entry = name, .root = delivery, .started = true });
        if (!try s.pump()) return .ran;
        try s.foregroundLoop();
        try s.readerRows();
        return .ran;
    }

    /// An `:inspect` object's rows, by its reader Run, once its own Run has ended.
    fn readerRows(s: *Session) !void {
        if (s.reader) |v| {
            s.reader = null;
            defer c.talk_value_release(v);
            try s.readProperties(v);
        }
    }

    /// The `:limits` override an Entry's Delivery carries.
    fn limitOverride(s: *Session) c.talk_limit_override {
        var override: c.talk_limit_override = std.mem.zeroes(c.talk_limit_override);
        if (s.limits.fuel_per_run) |x| {
            override.set |= 1;
            override.fuel_per_run = x;
        }
        if (s.limits.alloc_per_run) |x| {
            override.set |= 2;
            override.alloc_per_run = x;
        }
        if (s.limits.max_wait_ms) |x| {
            override.set |= 4;
            override.max_wait_ms = x;
        }
        if (s.limits.max_join) |x| {
            override.set |= 8;
            override.max_join = x;
        }
        return override;
    }

    /// The smallest number above the last one used that the Script has no
    /// name for.
    fn freeEntry(s: *Session) u64 {
        var n = s.next_entry;
        while (s.hasName(s.print("entry{d}", .{n}))) n += 1;
        return n;
    }

    fn hasName(s: *Session, name: []const u8) bool {
        for (s.decls.items) |d| for (d.names) |x| if (std.mem.eql(u8, x, name)) return true;
        return false;
    }

    /// Names already bound in the Session Script, excluded from implicit
    /// Script Variable discovery.
    fn boundNames(s: *Session, ta: Allocator) ![]const []const u8 {
        var bound: std.ArrayList([]const u8) = .empty;
        for (s.decls.items) |d| switch (d.kind) {
            .variable, .constant => try bound.append(ta, d.names[0]),
            else => {},
        };
        return bound.items;
    }

    /// Prints a load's diagnostics, from its `diag` records since `mark`:
    /// in the Entry's own lines, taking off the `lines` before its first and
    /// `return ` before an expression's, or with `labelled` as
    /// `<unit>:<line>:<column>`.
    fn diagnostics(s: *Session, mark: usize, unit: []const u8, lines: i64, expression: bool, labelled: bool) void {
        for (s.trace_lines.items[mark..]) |line| {
            if (!std.mem.startsWith(u8, line, "diag ")) continue;
            const rest = line[5..];
            const in = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
            if (!std.mem.eql(u8, in, unit)) continue;
            const code = std.mem.trim(u8, field(line, "code") orelse continue, "\"");
            const pos = field(line, "pos") orelse continue;
            const colon = std.mem.indexOfScalar(u8, pos, ':') orelse continue;
            const l = (std.fmt.parseInt(i64, pos[0..colon], 10) catch continue) - lines;
            var col = std.fmt.parseInt(i64, pos[colon + 1 ..], 10) catch continue;
            if (expression and l == 1) col -= 7;
            if (labelled) s.sayf("! {s} at {s}:{d}:{d}", .{ code, unit, l, col }) else s.sayf("! {s} at {d}:{d}", .{ code, l, col });
        }
    }

    // ------------------------------------------------------------ declarations

    /// Copies shared declaration metadata into the Session Source's lifetime.
    fn describeDecl(s: *Session, d: analysis.Declared, text: []const u8, source_start: usize) !Decl {
        const sa = s.alloc();
        if (std.mem.eql(u8, d.kind, "use")) {
            var imported: std.ArrayList([]const u8) = .empty;
            var names: std.ArrayList([]const u8) = .empty;
            var rename: ?[]const u8 = null;
            for (d.imports) |n| {
                try imported.append(sa, s.dupe(n.name));
                try names.append(sa, s.dupe(n.local));
                if (!std.mem.eql(u8, n.name, n.local)) rename = s.dupe(n.local);
            }
            return .{ .text = text, .kind = .use, .names = names.items, .use = .{ .names = imported.items, .library = s.dupe(d.name), .rename = rename } };
        }
        const kind: Decl.Kind = if (std.mem.eql(u8, d.kind, "handler"))
            (if (d.word == null) .fallback else .handler)
        else
            std.meta.stringToEnum(Decl.Kind, d.kind).?;
        return .{
            .text = text,
            .kind = kind,
            .names = try sa.dupe([]const u8, &.{s.dupe(d.name)}),
            .word = if (d.word) |w| s.dupe(w) else "",
            .init = if (d.initializer_start) |at| s.dupe(text[at - source_start ..]) else null,
        };
    }

    fn sessionSource(s: *Session, decls: []const Decl) []const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (decls) |d| {
            out.appendSlice(s.alloc(), d.text) catch {};
            out.append(s.alloc(), '\n') catch {};
        }
        return out.items;
    }

    fn declIndex(s: *Session, kind: Decl.Kind, name: []const u8) ?usize {
        for (s.decls.items, 0..) |d, i| {
            if (d.kind != kind) continue;
            for (d.names) |n| if (std.mem.eql(u8, n, name)) return i;
        }
        return null;
    }

    fn declaration(s: *Session, text: []const u8) !void {
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const ta = arena.allocator();
        const ds = switch (try analysis.declarations(ta, text)) {
            .declarations => |ds| ds,
            .problem => |p| return s.sayProblem(p),
        };
        if (ds.len != 1) return s.say("! bad arguments");
        const decl = try s.describeDecl(ds[0], s.dupe(text), 0);
        // A Script Variable the Script has: its initialiser is set in the
        // session source, and `put e into x` runs as a statement.
        if (decl.kind == .variable) if (s.declIndex(.variable, decl.names[0])) |i| {
            s.decls.items[i] = decl;
            const put = if (decl.init) |e| s.print("put {s} into {s}", .{ e, decl.names[0] }) else s.print("put nothing into {s}", .{decl.names[0]});
            _ = try s.runEntry(put, false);
            return;
        };
        const reused = for (decl.names) |n| {
            if (s.hasName(n)) break true;
        } else false;
        if (!reused) {
            // New names extend the Script, with the Entry as its source.
            const unit = s.print("session+{d}", .{s.extensions + 1});
            const mark = s.trace_lines.items.len;
            if (c.talk_script_extend(s.script, text.ptr, text.len) != c.TALK_OK) {
                s.diagnostics(mark, unit, 0, false, false);
                return;
            }
            s.extensions += 1;
            s.harvest();
            try s.decls.append(s.alloc(), decl);
            return;
        }
        const placed = try s.redefined(decl);
        const source = s.sessionSource(placed.decls);
        const mark = s.trace_lines.items.len;
        var reports: ?*c.talk_reports = null;
        const code = c.talk_script_reload(s.script, source.ptr, source.len, c.TALK_CARRY_VARIABLES, null, &reports);
        defer c.talk_reports_release(reports);
        if (code != c.TALK_OK) {
            // A Reload that fails leaves the session source as it was.
            s.diagnostics(mark, "session", placed.offset, false, false);
            return;
        }
        s.decls = .fromOwnedSlice(placed.decls);
        s.extensions = 0;
        s.harvest();
        s.follow(reports);
    }

    /// The session source with a redefinition in place (chapter 12,
    /// Declarations), and the lines before it.
    fn redefined(s: *Session, decl: Decl) !struct { decls: []Decl, offset: i64 } {
        const sa = s.alloc();
        var next: std.ArrayList(Decl) = .empty;
        var placed = false;
        var offset: i64 = 0;
        for (s.decls.items) |d| {
            if (decl.kind == .use and d.kind == .use) {
                // `use` takes the names it reuses out of earlier `use`
                // lines, dropping any line left empty.
                var kept: std.ArrayList([]const u8) = .empty;
                for (d.use.?.names) |n| {
                    const seen = d.use.?.rename orelse n;
                    const taken = for (decl.names) |x| {
                        if (std.mem.eql(u8, x, seen)) break true;
                    } else false;
                    if (!taken) try kept.append(sa, n);
                }
                if (kept.items.len == 0) continue;
                if (kept.items.len == d.use.?.names.len) {
                    try next.append(sa, d);
                    continue;
                }
                var t: std.ArrayList(u8) = .empty;
                try t.appendSlice(sa, "use ");
                for (kept.items, 0..) |n, k| try t.print(sa, "{s}{s}", .{ if (k > 0) ", " else "", n });
                try t.print(sa, " from {s}", .{d.use.?.library});
                var copy = d;
                copy.text = t.items;
                copy.names = kept.items;
                copy.use = .{ .names = kept.items, .library = d.use.?.library, .rename = null };
                try next.append(sa, copy);
                continue;
            }
            const same = decl.kind != .use and d.kind == decl.kind and std.mem.eql(u8, d.names[0], decl.names[0]);
            if (same) {
                // Every clause of a Handler goes, the first one's place kept.
                if (!placed) {
                    offset = lineCount(s.sessionSource(next.items));
                    try next.append(sa, decl);
                    placed = true;
                }
                continue;
            }
            try next.append(sa, d);
        }
        if (!placed) {
            offset = lineCount(s.sessionSource(next.items));
            try next.append(sa, decl);
        }
        return .{ .decls = next.items, .offset = offset };
    }

    fn lineCount(text: []const u8) i64 {
        return @intCast(std.mem.count(u8, text, "\n"));
    }

    // ------------------------------------------------------------ commands

    fn command(s: *Session, input: transcript.Input) !void {
        var words: std.ArrayList([]const u8) = .empty;
        var it = std.mem.tokenizeAny(u8, input.first, " \t");
        while (it.next()) |w| try words.append(s.alloc(), w);
        const name = words.items[0];
        const args = words.items[1..];
        const rest = std.mem.trim(u8, input.first[name.len..], " \t");
        // `:help` and `:quit` aren't recorded, and print nothing here.
        if (std.mem.eql(u8, name, ":help") or std.mem.eql(u8, name, ":quit")) return;
        if (std.mem.eql(u8, name, ":grant")) return s.grantCommand(args);
        if (std.mem.eql(u8, name, ":mock")) return s.mockCommand(args);
        try s.start();
        if (std.mem.eql(u8, name, ":stub")) return s.stubCommand(args, rest);
        if (std.mem.eql(u8, name, ":answer") or std.mem.eql(u8, name, ":fail")) return s.answerCommand(name, args, rest);
        if (std.mem.eql(u8, name, ":charge")) return s.chargeCommand(args);
        if (std.mem.eql(u8, name, ":clock")) return s.clockCommand(args, rest);
        if (std.mem.eql(u8, name, ":limits")) return s.limitsCommand(args);
        if (std.mem.eql(u8, name, ":cancel")) return s.cancelCommand(args);
        if (std.mem.eql(u8, name, ":runs") or std.mem.eql(u8, name, ":mailbox") or std.mem.eql(u8, name, ":vars")) {
            if (args.len > 0) return s.say("! bad arguments");
            return s.inspectCommand(name);
        }
        if (std.mem.eql(u8, name, ":save")) return s.saveCommand(args);
        if (std.mem.eql(u8, name, ":restore")) return s.restoreCommand(args);
        if (std.mem.eql(u8, name, ":library")) return s.libraryCommand(args, input.more);
        if (std.mem.eql(u8, name, ":script")) return s.scriptCommand(args, input.more);
        if (std.mem.eql(u8, name, ":export")) return s.exportCommand(args);
        if (std.mem.eql(u8, name, ":fix")) return s.fixCommand(args, input.more);
        if (std.mem.eql(u8, name, ":store")) return s.storeCommand(args, input.more);
        if (std.mem.eql(u8, name, ":describe")) return s.describeCommand(rest);
        if (std.mem.eql(u8, name, ":apropos")) return s.aproposCommand(rest);
        if (std.mem.eql(u8, name, ":inspect")) return s.inspectExpression(rest, input.more);
        if (std.mem.eql(u8, name, ":trace")) return s.traceCommand(rest);
        if (std.mem.eql(u8, name, ":untrace")) return s.untraceCommand(rest);
        if (std.mem.eql(u8, name, ":fuel")) return s.fuelCommand(rest, input.more);
        s.say("! unknown command");
    }

    const reserved_capabilities = [_][]const u8{ "clock", "calendar", "locale", "store", "user", "console" };

    fn grantCommand(s: *Session, args: []const []const u8) !void {
        if (args.len < 2 or args.len > 3) return s.say("! bad arguments");
        const capability = args[1];
        const mocked = for (s.mocks.items) |m| {
            if (std.mem.eql(u8, m.capability, capability)) break true;
        } else false;
        const is_store = std.mem.eql(u8, capability, "store");
        const builtin = std.mem.eql(u8, capability, "clock") or std.mem.eql(u8, capability, "user") or is_store;
        if (!mocked and !builtin) return s.say("! bad arguments");
        // Only `calendar`, `locale` and `store` take a binding.
        if (args.len == 3 and !is_store) return s.say("! bad arguments");
        if (s.started) return s.say("! session started");
        const binding: ?[]const u8 = if (is_store) (if (args.len == 3) s.dupe(args[2]) else "default") else null;
        try s.grants.append(s.alloc(), .{ .name = s.dupe(args[0]), .capability = s.dupe(capability), .binding = binding });
    }

    fn mockCommand(s: *Session, args: []const []const u8) !void {
        if (args.len != 2 and args.len != 3) return s.say("! bad arguments");
        const dot = std.mem.indexOfScalar(u8, args[0], '.') orelse return s.say("! bad arguments");
        const capability = args[0][0..dot];
        const operation = args[0][dot + 1 ..];
        if (capability.len == 0 or operation.len == 0) return s.say("! bad arguments");
        if (isOneOf(capability, &reserved_capabilities)) return s.say("! bad arguments");
        const mode: Mode = if (std.mem.eql(u8, args[1], "immediate")) .immediate else if (std.mem.eql(u8, args[1], "suspending")) .suspending else if (std.mem.eql(u8, args[1], "fire-and-forget")) .fire_and_forget else return s.say("! bad arguments");
        // Only a suspending mock may be metered (Metered Operations).
        const metered = args.len == 3;
        if (metered and (mode != .suspending or !std.mem.eql(u8, args[2], "read-only"))) return s.say("! bad arguments");
        if (s.started) return s.say("! session started");
        const m = try s.alloc().create(Mock);
        m.* = .{ .session = s, .capability = s.dupe(capability), .operation = s.dupe(operation), .mode = mode, .metered = metered };
        try s.mocks.append(s.alloc(), m);
    }

    fn mockOf(s: *Session, ref: []const u8) ?*Mock {
        const dot = std.mem.indexOfScalar(u8, ref, '.') orelse return null;
        for (s.mocks.items) |m| if (std.mem.eql(u8, m.capability, ref[0..dot]) and std.mem.eql(u8, m.operation, ref[dot + 1 ..])) return m;
        return null;
    }

    /// Whether `shown` reads as a value in the display form.
    fn readsAsValue(shown: []const u8) bool {
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return false;
        c.talk_value_release(v);
        return true;
    }

    /// Whether `shown` is an error map: a map with a text `code`.
    fn readsAsError(s: *Session, shown: []const u8) bool {
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return false;
        defer c.talk_value_release(v);
        return s.getText(v, "code") != null;
    }

    fn stubCommand(s: *Session, args: []const []const u8, rest: []const u8) !void {
        if (args.len < 2) return s.say("! bad arguments");
        const m = s.mockOf(args[0]) orelse return s.say("! bad arguments");
        if (m.mode != .immediate) return s.say("! bad arguments");
        var shown = std.mem.trim(u8, rest[args[0].len..], " \t");
        const fail = std.mem.startsWith(u8, shown, "fail ");
        if (fail) shown = std.mem.trim(u8, shown[5..], " \t");
        if (fail and !s.readsAsError(shown)) return s.say("! bad arguments");
        if (!fail and !readsAsValue(shown)) return s.say("! bad arguments");
        try m.stubs.append(s.alloc(), .{ .shown = s.dupe(shown), .fail = fail });
        // The Stub is in the Trace where it was entered, as a Trace Case's
        // runner writes it.
        s.writeTrace(s.print("> stub {s}.{s} {s}={s}", .{ m.capability, m.operation, if (fail) "error" else "value", shown }));
    }

    fn answerCommand(s: *Session, name: []const u8, args: []const []const u8, rest: []const u8) !void {
        const fail = std.mem.eql(u8, name, ":fail");
        if (args.len < 2) return s.say("! bad arguments");
        const shown = std.mem.trim(u8, rest[args[0].len..], " \t");
        if (fail and !s.readsAsError(shown)) return s.say("! bad arguments");
        if (!fail and !readsAsValue(shown)) return s.say("! bad arguments");
        const i = for (s.pending.items, 0..) |p, k| {
            if (p.kind == .mock and std.mem.eql(u8, p.id, args[0])) break k;
        } else return s.say("! no such call");
        const p = s.pending.orderedRemove(i);
        try s.settleCall(p.call, .{ .shown = shown, .fail = fail });
        _ = try s.pump();
    }

    /// Queues a charge request for a pending mock call, then pumps, as
    /// `:answer` does; the Trace records the request and its outcome.
    fn chargeCommand(s: *Session, args: []const []const u8) !void {
        if (args.len != 2) return s.say("! bad arguments");
        const fuel = wholeFuel(args[1]) orelse return s.say("! bad arguments");
        const p = for (s.pending.items) |p| {
            if (p.kind == .mock and std.mem.eql(u8, p.id, args[0])) break p;
        } else return s.say("! no such call");
        var request: ?*c.talk_charge_request = null;
        const code = c.talk_call_request_charge(p.call, fuel, &request);
        if (code != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(code)});
        _ = try s.pump();
    }

    /// A whole Fuel amount, written in canonical digits.
    fn wholeFuel(text: []const u8) ?i64 {
        if (text.len == 0 or (text[0] == '0' and text.len > 1)) return null;
        const n = std.fmt.parseInt(i64, text, 10) catch return null;
        if (n < 0 or n > 9_007_199_254_740_991 or text[0] == '+') return null;
        return n;
    }

    fn instantText(s: *Session, i: Instant) []const u8 {
        var v: ?*c.talk_value = null;
        if (c.talk_instant(i.seconds, i.micros, &v) != c.TALK_OK) return "";
        defer c.talk_value_release(v);
        return s.display(v);
    }

    fn clockCommand(s: *Session, args: []const []const u8, rest: []const u8) !void {
        if (args.len == 0) {
            switch (s.clock) {
                .virtual => |v| s.sayf("virtual {s}", .{s.instantText(v)}),
                .real => if (s.last) |l| s.sayf("real {s}", .{s.instantText(l)}) else s.say("real"),
            }
            return;
        }
        if (std.mem.eql(u8, args[0], "real")) {
            if (args.len != 1) return s.say("! bad arguments");
            s.clock = .real;
            return;
        }
        if (std.mem.eql(u8, args[0], "virtual")) {
            if (args.len > 2) return s.say("! bad arguments");
            const at: Instant = if (args.len == 2) blk: {
                var v: ?*c.talk_value = null;
                if (c.talk_parse_display(args[1].ptr, args[1].len, &v) != c.TALK_OK) return s.say("! bad arguments");
                defer c.talk_value_release(v);
                var i: Instant = undefined;
                if (!c.talk_value_as_instant(v, &i.seconds, &i.micros)) return s.say("! bad arguments");
                break :blk i;
            } else s.last orelse return s.say("! bad arguments");
            if (s.last) |l| if (at.before(l)) return s.say("! clock backwards");
            s.clock = .{ .virtual = at };
            return;
        }
        if (std.mem.eql(u8, args[0], "advance")) {
            if (args.len < 2) return s.say("! bad arguments");
            const virtual = switch (s.clock) {
                .virtual => |v| v,
                .real => return s.say("! clock is real"),
            };
            const by = exactDuration(std.mem.trim(u8, rest["advance".len..], " \t")) orelse return s.say("! bad arguments");
            s.clock = .{ .virtual = Instant.fromMicros(virtual.us() + by) };
            _ = try s.pump();
            return;
        }
        s.say("! bad arguments");
    }

    /// An exact, non-negative duration in microseconds, from a Quantity in
    /// the display form, rounded half-even to whole microseconds (chapter 3,
    /// Exact durations). A negative duration is refused before rounding.
    fn exactDuration(shown: []const u8) ?i128 {
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return null;
        defer c.talk_value_release(v);
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v.?));
        if (value.data != .quantity) return null;
        const q = value.data.quantity;
        const second = northtalk.units.Unit.parse("s") catch return null;
        if (!q.unit.compatible(&second)) return null;
        var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
        defer arena.deinit();
        const base = q.unit.toBase(arena.allocator(), q.number) catch return null;
        if (base.negative and base.coefficient != 0) return null;
        var n: i128 = std.math.cast(i128, base.coefficient) orelse return null;
        var e: i32 = base.exponent + 6;
        while (e > 0) : (e -= 1) n = std.math.mul(i128, n, 10) catch return null;
        if (e < -34) return 0;
        if (e < 0) {
            const divisor = std.math.powi(i128, 10, -e) catch return 0;
            const whole = @divTrunc(n, divisor);
            const twice = 2 * @rem(n, divisor);
            n = whole + @intFromBool(twice > divisor or (twice == divisor and @rem(whole, 2) == 1));
        }
        return n;
    }

    const limit_names = [_][]const u8{ "fuelPerRun", "allocPerRun", "maxWaitMs", "maxJoin" };

    fn limitsCommand(s: *Session, args: []const []const u8) !void {
        var defaults: c.talk_limits = undefined;
        c.talk_default_limits(&defaults);
        const base = [_]i64{ defaults.fuel_per_run, defaults.alloc_per_run, defaults.max_wait_ms, defaults.max_join };
        const current = [_]?i64{ s.limits.fuel_per_run, s.limits.alloc_per_run, s.limits.max_wait_ms, s.limits.max_join };
        if (args.len == 0) {
            for (limit_names, base, current) |n, b, x| s.sayf("{s} {d}", .{ n, x orelse b });
            return;
        }
        if (args.len == 1 and std.mem.eql(u8, args[0], "reset")) {
            s.limits = .{};
            return;
        }
        if (args.len != 2) return s.say("! bad arguments");
        const i = for (limit_names, 0..) |n, k| {
            if (std.mem.eql(u8, n, args[0])) break k;
        } else return s.say("! bad arguments");
        const value = std.fmt.parseInt(i64, args[1], 10) catch return s.say("! bad arguments");
        if (value < 0) return s.say("! bad arguments");
        if (value > base[i]) return s.say("! invalid value");
        switch (i) {
            0 => s.limits.fuel_per_run = value,
            1 => s.limits.alloc_per_run = value,
            2 => s.limits.max_wait_ms = value,
            else => s.limits.max_join = value,
        }
    }

    fn isLive(s: *Session, run: []const u8) bool {
        for (s.live.items) |r| if (std.mem.eql(u8, r.id, run)) return true;
        return false;
    }

    fn cancelCommand(s: *Session, args: []const []const u8) !void {
        if (args.len > 1) return s.say("! bad arguments");
        const run: []const u8 = if (args.len == 1) args[0] else blk: {
            const last = s.lastEntryRun() orelse return s.say("! no such run");
            break :blk last;
        };
        if (!std.mem.startsWith(u8, run, "session/") or !s.isLive(run)) return s.say("! no such run");
        try check_(c.talk_script_cancel_run(s.script, run.ptr, run.len));
        _ = try s.pump();
    }

    fn lastEntryRun(s: *Session) ?[]const u8 {
        const items = s.entry_runs.items;
        if (items.len == 0) return null;
        return items[items.len - 1].run;
    }

    /// `:runs`, `:mailbox` and `:vars`, rendered from `Inspect()`.
    fn inspectCommand(s: *Session, name: []const u8) !void {
        var inspection: ?*c.talk_inspection = null;
        try check_(c.talk_inspect(s.group, &inspection));
        defer c.talk_inspection_release(inspection);
        s.exposeSnapshot(inspection.?);
        const all = inspection.?.scripts[0..inspection.?.scripts_len];
        const view = for (all) |*v| {
            if (std.mem.eql(u8, v.name[0..v.name_len], "session")) break v;
        } else return;
        if (std.mem.eql(u8, name, ":vars")) {
            for (view.vars[0..view.vars_len]) |p| s.sayf("{s} = {s}", .{ p.key[0..p.key_len], s.display(p.value) });
            return;
        }
        // `:runs` and `:mailbox` cover every Script in the Group, the Session
        // Script's first (ADR 0170).
        var views: std.ArrayList(*const c.talk_script_view) = .empty;
        try views.append(s.alloc(), view);
        for (all) |*v| if (v != view) try views.append(s.alloc(), v);
        if (std.mem.eql(u8, name, ":runs")) {
            for (views.items) |sv| for (sv.runs[0..sv.runs_len]) |r| {
                var line: std.ArrayList(u8) = .empty;
                const status = switch (r.status) {
                    c.TALK_READY => "ready",
                    c.TALK_SUSPENDED => "suspended",
                    c.TALK_PARKED => "parked",
                    else => "preempted",
                };
                try line.print(s.alloc(), "{s} {s} {s}", .{ r.id[0..r.id_len], status, r.handler[0..r.handler_len] });
                if (r.status == c.TALK_SUSPENDED) {
                    try line.print(s.alloc(), " {s}", .{r.wait[0..r.wait_len]});
                    if (r.has_until) try line.print(s.alloc(), " until {s}", .{s.instantText(.{ .seconds = r.until_seconds, .micros = r.until_micros })});
                    for (r.calls[0..r.calls_len]) |id| try line.print(s.alloc(), " {s}", .{id.data[0..id.len]});
                }
                s.say(line.items);
            };
            return;
        }
        for (views.items) |sv| for (sv.mailbox[0..sv.mailbox_len]) |m| {
            var shown: std.ArrayList(u8) = .empty;
            try shown.append(s.alloc(), '[');
            for (m.message.args[0..m.message.args_len], 0..) |v, i| {
                if (i > 0) try shown.appendSlice(s.alloc(), ", ");
                try shown.appendSlice(s.alloc(), s.display(v));
            }
            try shown.append(s.alloc(), ']');
            const who = if (m.delivery_len > 0) m.delivery[0..m.delivery_len] else m.from[0..m.from_len];
            s.sayf("{s} {s} {s}", .{ who, m.message.name[0..m.message.name_len], shown.items });
        };
    }

    // ------------------------------------------------------------ save and restore

    fn saveCommand(s: *Session, args: []const []const u8) !void {
        if (args.len > 1) return s.say("! bad arguments");
        const name = if (args.len == 1) args[0] else "default";
        // A Store Notification checkpoint: the Group's save and its routing.
        var saved: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        const code = c.talk_router_save(s.router, s.group, &saved);
        if (code != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(code)});
        defer c.talk_owned_bytes_release(&saved);
        var stubs: std.ArrayList([]const Stub) = .empty;
        for (s.mocks.items) |m| try stubs.append(s.alloc(), try s.alloc().dupe(Stub, m.stubs.items));
        try s.saves.put(s.alloc(), s.dupe(name), .{
            .bytes = s.dupe(saved.data[0..saved.len]),
            .decls = try s.alloc().dupe(Decl, s.decls.items),
            .next_entry = s.next_entry,
            .extensions = s.extensions,
            .units = try s.alloc().dupe(EntryUnit, s.units.items),
            .entry_runs = try s.alloc().dupe(RunEntry, s.entry_runs.items),
            .limits = s.limits,
            .clock = s.clock,
            .stubs = stubs.items,
            .observing = try s.observing.clone(s.alloc()),
        });
        s.sayf("saved {s}", .{name});
    }

    fn rebind(context: ?*anyopaque, script: [*c]const u8, script_len: usize, name: [*c]const u8, name_len: usize) callconv(.c) ?*c.talk_grant {
        _ = script;
        _ = script_len;
        const s: *Session = @ptrCast(@alignCast(context.?));
        for (s.loaded.items) |l| if (std.mem.eql(u8, l.name[0..l.name_len], name[0..name_len])) return l.grant;
        return null;
    }

    fn restoreCommand(s: *Session, args: []const []const u8) !void {
        if (args.len > 1) return s.say("! bad arguments");
        const name = if (args.len == 1) args[0] else "default";
        const saved = s.saves.get(name) orelse return s.say("! no such save");
        var libraries: std.ArrayList(?*c.talk_library) = .empty;
        for (s.libraries.values()) |l| try libraries.append(s.alloc(), l.library);
        const options: c.talk_restore_options = .{ .name = "session", .name_len = 7, .trace = traceSink, .trace_context = s, .libraries = @ptrCast(libraries.items.ptr), .libraries_len = libraries.items.len, .grants = rebind, .grants_context = s, .resolve = restoreResolve, .resolve_context = s, .mismatch = c.TALK_REJECT_MISMATCH, .keep_mailbox = false, .allocator = null, .memory_cap = 0 };
        var group: ?*c.talk_group = null;
        var result: ?*c.talk_restore_result = null;
        var routing: ?*c.talk_routing_result = null;
        s.trace_lines.clearRetainingCapacity();
        s.admitted = false;
        s.resolved = null;
        s.resolved_used = 0;
        if (s.liveObjects()) try s.askResolver(saved.bytes, options);
        const code = c.talk_router_restore(s.router, s.core, saved.bytes.ptr, saved.bytes.len, &options, &group, &result, &routing);
        if (code != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(code)});
        if (s.resolved) |r| if (s.resolved_used != r.len) return error.MalformedTranscript;
        if (s.resolving.items.len > 0) s.recordResolved();
        defer c.talk_restore_result_release(result);
        c.talk_routing_result_release(routing);
        // The Group it replaces goes, detached from the router; the
        // session's own state comes back.
        if (s.group) |old| {
            c.talk_router_detach(s.router, old);
            c.talk_group_release(old);
        }
        s.group = group;
        s.script = c.talk_group_script(group, "session", 7);
        // Handles from the old Group are invalid.
        var handles = s.handles.valueIterator();
        while (handles.next()) |h| c.talk_value_release(h.*);
        s.handles.clearRetainingCapacity();
        s.supplied.clearRetainingCapacity();
        s.harvest();
        s.decls = .fromOwnedSlice(try s.alloc().dupe(Decl, saved.decls));
        s.next_entry = saved.next_entry;
        s.extensions = saved.extensions;
        s.units = .fromOwnedSlice(try s.alloc().dupe(EntryUnit, saved.units));
        s.entry_runs = .fromOwnedSlice(try s.alloc().dupe(RunEntry, saved.entry_runs));
        s.limits = saved.limits;
        s.clock = saved.clock;
        for (s.mocks.items, saved.stubs) |m, stubs| m.stubs = .fromOwnedSlice(try s.alloc().dupe(Stub, stubs));
        // Observation state is replaced: each pending measurement is
        // abandoned, after the ordinary restore output.
        var abandoned: std.ArrayList([]const u8) = .empty;
        for (s.observing.measurements.items) |m| if (!m.settled) try abandoned.append(s.alloc(), m.entry);
        s.observing = try saved.observing.clone(s.alloc());
        s.live.clearRetainingCapacity();
        s.pending.clearRetainingCapacity();
        s.issued.clearRetainingCapacity();
        s.waits.clearRetainingCapacity();
        s.sayf("restored {s}", .{name});
        // Every pending call is adopted, and a mock's answered by `:answer`.
        var pending: [*c]const c.talk_pending_call = null;
        const n = c.talk_restore_result_pending(result, &pending);
        for (pending[0..n]) |p| {
            const id = p.id[0..p.id_len];
            var adopted: ?*c.talk_call = null;
            const settlement: c.talk_settlement = .{ .answer = null, .fail = null, .reissue = false, .adopt = true };
            try check_(c.talk_settle(group, id.ptr, id.len, &settlement, &adopted));
            const run = id[0 .. std.mem.lastIndexOf(u8, id, ".c") orelse id.len];
            const capability = p.grant[0..p.grant_len];
            const kind: PendingKind = if (std.mem.eql(u8, capability, "console")) .read else if (std.mem.eql(u8, capability, "user")) .prompt else .mock;
            try s.pending.append(s.alloc(), .{ .id = s.dupe(id), .run = s.dupe(run), .kind = kind, .call = adopted });
            if (adopted) |x| s.issue(x);
            s.queued = true;
        }
        s.baseline(c.talk_restore_result_reports(result));
        for (abandoned.items) |e| s.sayf("fuel abandoned {s}", .{s.textShown(e)});
        // Markers for Stores changed since the save are pumped for as the
        // Pump `:restore` causes.
        if (s.admitted) {
            s.admitted = false;
            s.queued = false;
            _ = try s.pump();
        }
    }

    /// `:store [<store>]`, `:store load [<store>]` with the file's lines,
    /// `:store save <path> [<store>]` and `:store clear [<store>]`.
    fn storeCommand(s: *Session, args: []const []const u8, lines: []const []const u8) !void {
        const load = args.len > 0 and std.mem.eql(u8, args[0], "load");
        // Only `:store load` takes `|` lines.
        if (!load and lines.len > 0) return s.say("! bad arguments");
        if (args.len == 0 or (args.len == 1 and !isOneOf(args[0], &.{ "load", "save", "clear" }))) {
            const name = if (args.len == 1) args[0] else "default";
            for (try s.stores.sorted(name)) |k| {
                const v = s.stores.valueOf(name, k) orelse continue;
                defer c.talk_value_release(v);
                var key: ?*c.talk_value = null;
                try check_(c.talk_text(k.ptr, k.len, &key));
                defer c.talk_value_release(key);
                s.sayf("{s} = {s}", .{ s.display(key), s.display(v) });
            }
            return;
        }
        if (load) {
            if (args.len > 2 or lines.len == 0) return s.say("! bad arguments");
            const name = if (args.len == 2) args[1] else "default";
            s.admitted = false;
            const n = try s.stores.load(name, s.sourceOf(lines)) orelse return s.say("! bad arguments");
            s.sayf("loaded {d} keys", .{n});
            return s.pumpForAdmitted();
        }
        if (std.mem.eql(u8, args[0], "clear")) {
            if (args.len > 2) return s.say("! bad arguments");
            const name = if (args.len == 2) args[1] else "default";
            s.admitted = false;
            try s.stores.clear(name);
            s.sayf("cleared {s}", .{name});
            return s.pumpForAdmitted();
        }
        // `:store save <path> [<store>]`: the contents as one JSON object,
        // in key order, with no white space.
        if (!std.mem.eql(u8, args[0], "save") or args.len < 2 or args.len > 3) return s.say("! bad arguments");
        const name = if (args.len == 3) args[2] else "default";
        var json: std.ArrayList(u8) = .empty;
        try json.append(s.alloc(), '{');
        for (try s.stores.sorted(name), 0..) |k, i| {
            const v = s.stores.valueOf(name, k) orelse continue;
            defer c.talk_value_release(v);
            var key: ?*c.talk_value = null;
            try check_(c.talk_text(k.ptr, k.len, &key));
            defer c.talk_value_release(key);
            var ek: c.talk_owned_bytes = .{ .data = null, .len = 0 };
            try check_(c.talk_encode_value(key, &ek));
            defer c.talk_owned_bytes_release(&ek);
            var ev: c.talk_owned_bytes = .{ .data = null, .len = 0 };
            try check_(c.talk_encode_value(v, &ev));
            defer c.talk_owned_bytes_release(&ev);
            if (i > 0) try json.append(s.alloc(), ',');
            try json.print(s.alloc(), "{s}:{s}", .{ ek.data[0..ek.len], ev.data[0..ev.len] });
        }
        try json.append(s.alloc(), '}');
        const dir = std.fs.path.dirname(args[1]) orelse ".";
        const file = std.fs.path.basename(args[1]);
        if (!(s.driver.write(s.driver.context, dir, file, json.items) orelse return s.suspendCall(.rerun))) return s.say("! bad arguments");
        s.sayf("wrote {s}", .{args[1]});
    }

    /// The Pump a Host-originated commit causes when the router admitted a
    /// Notification for it.
    fn pumpForAdmitted(s: *Session) !void {
        if (!s.admitted) return;
        s.admitted = false;
        _ = try s.pump();
    }

    /// A restore's accounting baseline: its live Runs, and the Runs a
    /// variables-only restore discarded.
    fn baseline(s: *Session, reports: ?*const c.talk_reports) void {
        var items: [*c]const c.talk_report = null;
        const n = c.talk_reports_items(reports, &items);
        for (items[0..n]) |r| switch (r.kind) {
            c.TALK_REPORT_RUN_ACCOUNTING => {
                const x = r.as.run_accounting;
                if (std.mem.eql(u8, x.state[0..x.state_len], "live")) s.live.append(s.alloc(), .{ .id = s.dupe(x.run[0..x.run_len]) }) catch {};
            },
            c.TALK_REPORT_RUN_DISCARDED => {
                const x = r.as.run_discarded;
                s.sayf("! discarded {s}", .{x.run[0..x.run_len]});
            },
            else => {},
        };
    }

    // ------------------------------------------------------------ Libraries and export

    /// A Library's source: its lines, each ended by an LF.
    fn sourceOf(s: *Session, lines: []const []const u8) []const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (lines) |l| {
            out.appendSlice(s.alloc(), l) catch {};
            out.append(s.alloc(), '\n') catch {};
        }
        return out.items;
    }

    fn libraryCommand(s: *Session, args: []const []const u8, lines: []const []const u8) !void {
        if (args.len != 2 or lines.len == 0) return s.say("! bad arguments");
        const add = std.mem.eql(u8, args[0], "add");
        if (!add and !std.mem.eql(u8, args[0], "replace")) return s.say("! bad arguments");
        const name = args[1];
        if (add and s.libraries.contains(name)) return s.say("! name reused");
        if (!add and !s.libraries.contains(name)) return s.say("! library mismatch");
        const source = s.sourceOf(lines);
        var imports: std.ArrayList(?*c.talk_library) = .empty;
        for (s.libraries.values()) |l| try imports.append(s.alloc(), l.library);
        const src: c.talk_library_source = .{ .name = name.ptr, .name_len = name.len, .version = "1", .version_len = 1, .source = source.ptr, .source_len = source.len };
        var library: ?*c.talk_library = null;
        var refused: ?*c.talk_load_error = null;
        const declarations = try s.libraryDeclarations();
        const code = c.talk_compile_library(s.core, &src, @ptrCast(imports.items.ptr), imports.items.len, declarations.ptr, declarations.len, &library, &refused);
        if (code != c.TALK_OK) {
            defer c.talk_load_error_release(refused);
            // Each diagnostic as `<library>:<line>:<column>`.
            if (refused) |e| for (e.diagnostics[0..e.diagnostics_len]) |d| s.sayf("! {s} at {s}:{d}:{d}", .{ d.code[0..d.code_len], d.unit[0..d.unit_len], d.line, d.col });
            if (code != c.TALK_LOAD_REFUSED) s.sayf("! {s}", .{hostErrorName(code)});
            return;
        }
        if (add) {
            const added = c.talk_add_library(s.group, library);
            if (added != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(added)});
        } else {
            var reports: ?*c.talk_reports = null;
            const replaced = c.talk_replace_library(s.group, library, c.TALK_CARRY_VARIABLES, null, &reports);
            defer c.talk_reports_release(reports);
            if (replaced != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(replaced)});
            s.follow(reports);
        }
        try s.libraries.put(s.alloc(), s.dupe(name), .{ .source = source, .library = library.? });
        s.harvestLibrary(library, name, source);
        s.harvest();
    }

    /// The Operation Declarations a Library is checked against: `console`,
    /// so `say` is `console.write`, and each Capability granted or mocked,
    /// by its Capability name (chapter 7, `needs`).
    fn libraryDeclarations(s: *Session) ![]const c.talk_grant_decls {
        var out: std.ArrayList(c.talk_grant_decls) = .empty;
        try s.appendDeclarations(&out, "console", s.console_def);
        var it = s.defs.iterator();
        while (it.next()) |e| try s.appendDeclarations(&out, e.key_ptr.*, e.value_ptr.*);
        return out.items;
    }

    fn appendDeclarations(s: *Session, out: *std.ArrayList(c.talk_grant_decls), name: []const u8, def: ?*c.talk_capability_def) !void {
        const checks = try s.alloc().alloc(c.talk_operation_check, c.talk_capability_def_checks(def, null, 0));
        _ = c.talk_capability_def_checks(def, checks.ptr, checks.len);
        try out.append(s.alloc(), .{ .name = name.ptr, .name_len = name.len, .operations = checks.ptr, .operations_len = checks.len });
    }

    /// `:script add <name>`, with the Script's source on the lines after it
    /// (ADR 0170): the Script joins the session's Group with the Session
    /// Script's Grants, owning no Host Object, and Entries reach it only by
    /// message.
    fn scriptCommand(s: *Session, args: []const []const u8, lines: []const []const u8) !void {
        if (args.len != 2 or lines.len == 0 or !std.mem.eql(u8, args[0], "add")) return s.say("! bad arguments");
        const name = args[1];
        if (std.mem.eql(u8, name, "session") or c.talk_group_script(s.group, name.ptr, name.len) != null) return s.say("! name reused");
        const source = s.sourceOf(lines);
        var bound: std.ArrayList(c.talk_load_object) = .empty;
        for (s.setup.items) |b| try bound.append(s.alloc(), .{ .name = b.name.ptr, .name_len = b.name.len, .object = try s.objectOf(b.kind, b.id) });
        const load: c.talk_load_options = .{ .name = name.ptr, .name_len = name.len, .source = source.ptr, .source_len = source.len, .grants = s.loaded.items.ptr, .grants_len = s.loaded.items.len, .grants_as_used = true, .forbid_suspension = false, .owner = null, .objects = bound.items.ptr, .objects_len = bound.items.len, .limits = null };
        const mark = s.trace_lines.items.len;
        var script: ?*c.talk_script = null;
        const code = c.talk_load(s.group, &load, &script);
        if (code == c.TALK_LOAD_REFUSED) return s.diagnostics(mark, name, 0, false, true);
        if (code != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(code)});
        _ = try s.pump();
    }

    fn exportCommand(s: *Session, args: []const []const u8) !void {
        if (args.len > 1) return s.say("! bad arguments");
        const source = s.sessionSource(s.decls.items);
        if (args.len == 0) {
            var lines = std.mem.splitScalar(u8, std.mem.trimEnd(u8, source, "\n"), '\n');
            if (source.len > 0) while (lines.next()) |l| s.say(l);
            return;
        }
        if (!(s.driver.write(s.driver.context, args[0], "session.talk", source) orelse return s.suspendCall(.rerun))) return s.say("! bad arguments");
        s.say("wrote session.talk");
        for (s.libraries.keys(), s.libraries.values()) |name, l| {
            const file = s.print("{s}.talk", .{name});
            if (!(s.driver.write(s.driver.context, args[0], file, l.source) orelse return s.suspendCall(.rerun))) return s.say("! bad arguments");
            s.sayf("wrote {s}", .{file});
        }
    }

    /// `:fix <run>` (ADR 0072): a Rewind of a Run that hasn't passed a
    /// Suspension Point, then a Reload with the file's declarations in place
    /// and the mailbox kept, so the message runs again on the new code.
    fn fixCommand(s: *Session, args: []const []const u8, lines: []const []const u8) !void {
        if (args.len != 1 or lines.len == 0) return s.say("! bad arguments");
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const ta = arena.allocator();
        const source = s.sourceOf(lines);
        const ds = switch (try analysis.declarations(ta, source)) {
            .declarations => |ds| ds,
            .problem => |p| return s.sayProblem(p),
        };
        if (ds.len == 0) return s.say("! bad arguments");
        const run = args[0];
        if (!std.mem.startsWith(u8, run, "session/") or !s.isLive(run)) return s.say("! no such run");
        // Keep the source lines, including documentation, with each declaration.
        var decls: std.ArrayList(Decl) = .empty;
        var from: usize = 0;
        var source_start: usize = 0;
        for (ds) |d| {
            var start_line = from + 1;
            while (start_line <= d.end_line and std.mem.trim(u8, lines[start_line - 1], " \t").len == 0) start_line += 1;
            for (lines[from .. start_line - 1]) |l| source_start += l.len + 1;
            const text = try std.mem.join(s.alloc(), "\n", lines[start_line - 1 .. d.end_line]);
            from = d.end_line;
            try decls.append(ta, try s.describeDecl(d, text, source_start));
            source_start += text.len + 1;
        }
        // The Rewind.
        try check_(c.talk_script_rewind_run(s.script, run.ptr, run.len));
        const at = s.readingFor() orelse return;
        const fixing: Fixing = .{ .run = s.dupe(run), .decls = try s.alloc().dupe(Decl, decls.items) };
        const state = s.pumpState(at) catch |err| {
            if (err == error.Suspended) s.fixing = fixing;
            return err;
        };
        try s.fixAfterRewind(state, fixing);
    }

    /// `:fix` after its rewind Pump: the Reload, and the Pump that runs the
    /// message again.
    fn fixAfterRewind(s: *Session, state: c.talk_group_state, fixing: Fixing) !void {
        const run = fixing.run;
        const decls = fixing.decls;
        if (state != c.TALK_REWOUND) return s.say("! not rewindable");
        s.sayf("! rewound {s}", .{run});
        // The Reload, with each declaration in the session source as a
        // redefinition or a new name would put it.
        const saved = try s.alloc().dupe(Decl, s.decls.items);
        for (decls) |d| {
            if (d.kind == .variable) if (s.declIndex(.variable, d.names[0])) |k| {
                s.decls.items[k] = d;
                continue;
            };
            const placed = try s.redefined(d);
            s.decls = .fromOwnedSlice(placed.decls);
        }
        const text = s.sessionSource(s.decls.items);
        const mark = s.trace_lines.items.len;
        var reports: ?*c.talk_reports = null;
        const options: c.talk_reload_options = .{ .keep_mailbox = true };
        const code = c.talk_script_reload(s.script, text.ptr, text.len, c.TALK_CARRY_VARIABLES, &options, &reports);
        defer c.talk_reports_release(reports);
        if (code != c.TALK_OK) {
            s.decls = .fromOwnedSlice(saved);
            s.diagnostics(mark, "session", 0, false, true);
        } else {
            s.extensions = 0;
            s.harvest();
            s.follow(reports);
        }
        // The message runs again.
        _ = try s.pump();
    }

    // ------------------------------------------------------------ sources

    /// Keeps each of the Session Script's units' sources by code identity,
    /// so documentation outlives a Reload for the Function Values that
    /// still refer to it.
    fn harvest(s: *Session) void {
        const script = s.script orelse return;
        var i: usize = 0;
        var info: c.talk_unit_info = undefined;
        while (c.talk_script_unit(script, i, &info)) : (i += 1) {
            if (s.sources.contains(info.identity)) continue;
            s.sources.put(s.alloc(), info.identity, .{ .name = s.dupe(info.name[0..info.name_len]), .source = s.dupe(info.source[0..info.source_len]) }) catch {};
        }
    }

    fn harvestLibrary(s: *Session, library: ?*c.talk_library, name: []const u8, source: []const u8) void {
        var id: [32]u8 = undefined;
        c.talk_library_identity(library, &id);
        s.sources.put(s.alloc(), id, .{ .name = s.dupe(name), .source = s.dupe(source) }) catch {};
    }

    /// A Library's source: a user Library's, or a stdlib Library's.
    fn librarySource(s: *Session, name: []const u8) ?[]const u8 {
        if (s.libraries.get(name)) |l| return l.source;
        for (analysis.libraries) |src| if (std.mem.eql(u8, src.name, name)) return src.source;
        return null;
    }

    fn librarySourceByIdentity(s: *Session, unit: [32]u8) ?UnitSource {
        if (s.sources.get(unit)) |u| return u;
        for (analysis.libraries) |src| {
            const l = northtalk.machine.stdlibLibrary(src.name) orelse continue;
            if (std.mem.eql(u8, &l.identity, &unit)) return .{ .name = src.name, .source = src.source };
        }
        return null;
    }

    // ------------------------------------------------------------ declarations in source

    /// A declaration as tooling shows it: its kind, its name, for a Handler
    /// its Selector, its signature and its documentation.
    const Shown = struct {
        kind: []const u8,
        name: []const u8,
        signature: []const u8,
        doc: []const u8,
        private: bool,
        required: usize = 0,
        total: usize = 0,
    };

    /// Every declaration of a source but its `use` lines, in order.
    fn declarationsOf(s: *Session, source: []const u8) ![]Shown {
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const ds = switch (try analysis.declarations(arena.allocator(), source)) {
            .declarations => |ds| ds,
            .problem => return &.{},
        };
        var out: std.ArrayList(Shown) = .empty;
        for (ds) |d| {
            if (std.mem.eql(u8, d.kind, "use")) continue;
            const arity = d.arity orelse .{ 0, 0 };
            try out.append(s.alloc(), .{ .kind = s.dupe(d.kind), .name = s.dupe(d.name), .signature = s.dupe(d.signature), .doc = s.dupe(d.doc), .private = d.private, .required = arity[0], .total = arity[1] });
        }
        return out.items;
    }

    // ------------------------------------------------------------ shown values

    fn textShown(s: *Session, text: []const u8) []const u8 {
        var v: ?*c.talk_value = null;
        if (c.talk_text(text.ptr, text.len, &v) != c.TALK_OK) return "\"\"";
        defer c.talk_value_release(v);
        return s.display(v);
    }

    /// A target map: `{name, origin}`, or `{library, name, origin}`.
    fn targetShown(s: *Session, library: ?[]const u8, name: []const u8, origin: []const u8) []const u8 {
        if (library) |l| return s.print("{{library: {s}, name: {s}, origin: {s}}}", .{ s.textShown(l), s.textShown(name), s.textShown(origin) });
        return s.print("{{name: {s}, origin: {s}}}", .{ s.textShown(name), s.textShown(origin) });
    }

    /// The rows a value gets: its kind and display form, its size, a map's
    /// fields, and a Function Value's name, arity, Home Script and
    /// documentation.
    fn valueRows(s: *Session, v: ?*const c.talk_value) void {
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v.?));
        s.sayf("value {{kind: {s}, value: {s}}}", .{ s.textShown(northtalk.machine.kindName(value)), s.display(v) });
        switch (value.data) {
            .list => |items| s.sayf("size {d}", .{items.len}),
            .map => |pairs| s.sayf("size {d}", .{pairs.len}),
            .bytes => |b| s.sayf("size {d}", .{b.len}),
            .text => |t| s.sayf("size {d}", .{northtalk.unicode.grapheme.count(t)}),
            else => {},
        }
        if (value.data == .map) {
            const pairs = value.data.map.copyEntries(s.alloc()) catch return;
            std.mem.sort(northtalk.value.Pair, pairs, {}, struct {
                fn less(_: void, x: northtalk.value.Pair, y: northtalk.value.Pair) bool {
                    return std.mem.order(u8, x.key, y.key) == .lt;
                }
            }.less);
            for (pairs) |p| s.sayf("field {s} = {s}", .{ s.textShown(p.key), s.display(@ptrCast(p.value)) });
        }
        if (value.data == .function) {
            var info: c.talk_function_info = undefined;
            if (!c.talk_function_info_of(s.group, v, &info)) return;
            const name = info.name[0..info.name_len];
            const shown_name = if (name.len == 0) "nothing" else s.textShown(name);
            s.sayf("function {{name: {s}, arity: {d}..{d}, home: {s}}}", .{ shown_name, info.required, info.total, s.textShown(info.home[0..info.home_len]) });
            var doc: []const u8 = "";
            if (name.len > 0) if (s.librarySourceByIdentity(info.unit)) |u| {
                const decls = s.declarationsOf(u.source) catch &.{};
                for (decls) |d| if (std.mem.eql(u8, d.kind, "function") and std.mem.eql(u8, d.name, name)) {
                    doc = d.doc;
                    break;
                };
            };
            s.sayf("doc {s}", .{s.textShown(doc)});
        }
        // A Host Object's rows, for `:inspect` and passive describe alike.
        if (value.data == .object) s.objectRows(v);
    }

    // ------------------------------------------------------------ :describe

    const Target = struct { name: []const u8, origin: enum { any, session, builtin, library }, library: ?[]const u8 = null };

    /// A describe target: a name or Selector, or a target map.
    fn parseTarget(s: *Session, rest: []const u8) ?Target {
        if (rest.len == 0) return null;
        if (rest[0] != '{') {
            if (std.mem.indexOfAny(u8, rest, " \t") != null) return null;
            return .{ .name = rest, .origin = .any };
        }
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(rest.ptr, rest.len, &v) != c.TALK_OK) return null;
        defer c.talk_value_release(v);
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v.?));
        if (value.data != .map) return null;
        var name: ?[]const u8 = null;
        var origin: ?[]const u8 = null;
        var library: ?[]const u8 = null;
        for (0..value.data.map.len) |map_index| {
            const p = value.data.map.at(map_index);
            if (p.value.data != .text) return null;
            const t = s.dupe(p.value.data.text);
            if (std.mem.eql(u8, p.key, "name")) name = t else if (std.mem.eql(u8, p.key, "origin")) origin = t else if (std.mem.eql(u8, p.key, "library")) library = t else return null;
        }
        const n = name orelse return null;
        const o = origin orelse return null;
        if (std.mem.eql(u8, o, "session") and library == null) return .{ .name = n, .origin = .session };
        if (std.mem.eql(u8, o, "builtin") and library == null) return .{ .name = n, .origin = .builtin };
        if (std.mem.eql(u8, o, "library")) if (library) |l| return .{ .name = n, .origin = .library, .library = l };
        return null;
    }

    const Builtin = struct { name: []const u8, call: []const u8, gives: []const u8 };

    fn builtinNamed(name: []const u8) ?Builtin {
        for (analysis.builtins) |b| if (std.mem.eql(u8, b.name, name)) return .{ .name = b.name, .call = b.call, .gives = b.gives };
        return null;
    }

    /// What a current name binds in the session source: a declaration of
    /// the Session Script's own, or a `use` alias with its Library.
    const Binding = struct { decls: []const Shown, library: ?[]const u8 = null };

    fn currentBinding(s: *Session, name: []const u8) !?Binding {
        const source = s.sessionSource(s.decls.items);
        var found: std.ArrayList(Shown) = .empty;
        for (try s.declarationsOf(source)) |d| if (std.mem.eql(u8, d.name, name)) try found.append(s.alloc(), d);
        if (found.items.len > 0) return .{ .decls = found.items };
        for (s.decls.items) |d| if (d.kind == .use) {
            const u = d.use.?;
            for (u.names) |n| {
                const seen = u.rename orelse n;
                if (!std.mem.eql(u8, seen, name)) continue;
                const lib = s.librarySource(u.library) orelse continue;
                var exported: std.ArrayList(Shown) = .empty;
                for (try s.declarationsOf(lib)) |x| if (!x.private and std.mem.eql(u8, x.name, n)) try exported.append(s.alloc(), x);
                if (exported.items.len > 0) return .{ .decls = exported.items, .library = u.library };
            }
        };
        return null;
    }

    fn describeCommand(s: *Session, rest: []const u8) !void {
        const target = s.parseTarget(rest) orelse return s.say("! bad arguments");
        switch (target.origin) {
            .any, .session => {
                if (try s.currentBinding(target.name)) |b| return s.describeBinding(target.name, b);
                if (target.origin == .any) if (builtinNamed(target.name)) |b| return s.describeBuiltin(b);
                return s.say("! no such name");
            },
            .builtin => {
                const b = builtinNamed(target.name) orelse return s.say("! no such name");
                return s.describeBuiltin(b);
            },
            .library => {
                const lib = target.library.?;
                const source = s.librarySource(lib) orelse return s.say("! no such name");
                var any = false;
                var clause: usize = 0;
                for (try s.declarationsOf(source)) |d| {
                    if (d.private or !std.mem.eql(u8, d.name, target.name)) continue;
                    any = true;
                    clause += 1;
                    s.describeRow(s.targetShown(lib, target.name, "library"), lib, d, clause);
                }
                if (!any) s.say("! no such name");
            },
        }
    }

    fn describeBuiltin(s: *Session, b: Builtin) void {
        s.sayf("describe {{target: {s}, origin: \"builtin\", declaration: \"builtin\", signature: {s}}}", .{ s.targetShown(null, b.name, "builtin"), s.textShown(b.call) });
        s.sayf("doc {s}", .{s.textShown(b.gives)});
    }

    fn describeRow(s: *Session, target: []const u8, origin: []const u8, d: Shown, clause: usize) void {
        if (std.mem.eql(u8, d.kind, "handler")) {
            s.sayf("describe {{target: {s}, origin: {s}, declaration: \"handler\", signature: {s}, clause: {d}}}", .{ target, s.textShown(origin), s.textShown(d.signature), clause });
        } else s.sayf("describe {{target: {s}, origin: {s}, declaration: {s}, signature: {s}}}", .{ target, s.textShown(origin), s.textShown(d.kind), s.textShown(d.signature) });
        s.sayf("doc {s}", .{s.textShown(d.doc)});
        if (std.mem.eql(u8, d.kind, "function")) s.sayf("arity {d}..{d}", .{ d.required, d.total });
    }

    fn describeBinding(s: *Session, name: []const u8, b: Binding) !void {
        const target = s.targetShown(null, name, "session");
        const origin = b.library orelse "session";
        var clause: usize = 0;
        for (b.decls) |d| {
            clause += 1;
            s.describeRow(target, origin, d, clause);
            // A Script Variable's value comes from one explicit `vars` Host
            // Input.
            if (std.mem.eql(u8, d.kind, "variable")) {
                var inspection: ?*c.talk_inspection = null;
                try check_(c.talk_inspect(s.group, &inspection));
                defer c.talk_inspection_release(inspection);
                s.exposeSnapshot(inspection.?);
                for (inspection.?.scripts[0..inspection.?.scripts_len]) |view| {
                    if (!std.mem.eql(u8, view.name[0..view.name_len], "session")) continue;
                    for (view.vars[0..view.vars_len]) |p| if (std.mem.eql(u8, p.key[0..p.key_len], name)) s.valueRows(p.value);
                }
            }
        }
    }

    // ------------------------------------------------------------ :apropos

    const Found = struct { name: []const u8, rank: u8, library: []const u8, line: []const u8, docs: []const []const u8 };

    fn lowered(s: *Session, text: []const u8) []const u8 {
        const mapped = northtalk.builtins.caseMapped(s.alloc(), text, false) catch return text;
        return northtalk.unicode.nfc(s.alloc(), mapped) catch mapped;
    }

    fn docLines(s: *Session, decls: []const Shown) []const []const u8 {
        var out: std.ArrayList([]const u8) = .empty;
        if (decls.len > 0 and std.mem.eql(u8, decls[0].kind, "handler")) {
            for (decls, 1..) |d, n| out.append(s.alloc(), s.print("doc {d} {s}", .{ n, s.textShown(d.doc) })) catch {};
        } else if (decls.len > 0) out.append(s.alloc(), s.print("doc {s}", .{s.textShown(decls[0].doc)})) catch {};
        return out.items;
    }

    fn aproposCommand(s: *Session, rest: []const u8) !void {
        var query: []const u8 = rest;
        if (rest.len > 0 and rest[0] == '"') {
            var v: ?*c.talk_value = null;
            if (c.talk_parse_display(rest.ptr, rest.len, &v) != c.TALK_OK) return s.say("! bad arguments");
            defer c.talk_value_release(v);
            var p: [*c]const u8 = null;
            var n: usize = 0;
            if (!c.talk_value_as_text(v, &p, &n)) return s.say("! bad arguments");
            query = s.dupe(p[0..n]);
        }
        const q = s.lowered(query);
        var found: std.ArrayList(Found) = .empty;
        // Current bindings: the session's declarations, by name, and its
        // `use` aliases.
        const source = s.sessionSource(s.decls.items);
        const own = try s.declarationsOf(source);
        var seen: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (own) |d| {
            if (seen.contains(d.name)) continue;
            try seen.put(s.alloc(), d.name, {});
            var same: std.ArrayList(Shown) = .empty;
            for (own) |x| if (std.mem.eql(u8, x.name, d.name)) try same.append(s.alloc(), x);
            try found.append(s.alloc(), .{ .name = d.name, .rank = 0, .library = "", .line = s.print("name {{target: {s}, origin: \"session\", available: true, import: nothing}}", .{s.targetShown(null, d.name, "session")}), .docs = s.docLines(same.items) });
        }
        for (s.decls.items) |d| if (d.kind == .use) {
            const u = d.use.?;
            for (u.names) |n| {
                const alias = u.rename orelse n;
                if (seen.contains(alias)) continue;
                const binding = try s.currentBinding(alias) orelse continue;
                try seen.put(s.alloc(), alias, {});
                try found.append(s.alloc(), .{ .name = alias, .rank = 0, .library = "", .line = s.print("name {{target: {s}, origin: {s}, available: true, import: nothing}}", .{ s.targetShown(null, alias, "session"), s.textShown(u.library) }), .docs = s.docLines(binding.decls) });
            }
        };
        // Built-ins, even when shadowed.
        for (analysis.builtins) |b| {
            const available = !seen.contains(b.name);
            try found.append(s.alloc(), .{ .name = b.name, .rank = 1, .library = "", .line = s.print("name {{target: {s}, origin: \"builtin\", available: {}, import: nothing}}", .{ s.targetShown(null, b.name, "builtin"), available }), .docs = try s.alloc().dupe([]const u8, &.{s.print("doc {s}", .{s.textShown(b.gives)})}) });
        }
        // Every registered Library's public exports, imported or not.
        var libs: std.ArrayList([]const u8) = .empty;
        for (analysis.libraries) |src| try libs.append(s.alloc(), src.name);
        for (s.libraries.keys()) |k| try libs.append(s.alloc(), k);
        for (libs.items) |lib| {
            const lsource = s.librarySource(lib) orelse continue;
            const decls = try s.declarationsOf(lsource);
            var names: std.StringArrayHashMapUnmanaged(void) = .empty;
            for (decls) |d| if (!d.private and !std.mem.eql(u8, d.kind, "variable")) try names.put(s.alloc(), d.name, {});
            for (names.keys()) |name| {
                var same: std.ArrayList(Shown) = .empty;
                for (decls) |x| if (!x.private and std.mem.eql(u8, x.name, name)) try same.append(s.alloc(), x);
                const imported = s.importsAs(lib, name);
                const available = imported and true;
                const import_shown = if (imported) "nothing" else s.textShown(s.print("use {s} from {s}", .{ name, lib }));
                try found.append(s.alloc(), .{ .name = name, .rank = 2, .library = lib, .line = s.print("name {{target: {s}, origin: {s}, available: {}, import: {s}}}", .{ s.targetShown(lib, name, "library"), s.textShown(lib), available, import_shown }), .docs = s.docLines(same.items) });
            }
        }
        std.mem.sort(Found, found.items, {}, struct {
            fn less(_: void, x: Found, y: Found) bool {
                switch (std.mem.order(u8, x.name, y.name)) {
                    .lt => return true,
                    .gt => return false,
                    .eq => {},
                }
                if (x.rank != y.rank) return x.rank < y.rank;
                return std.mem.order(u8, x.library, y.library) == .lt;
            }
        }.less);
        for (found.items) |f| {
            if (std.mem.indexOf(u8, s.lowered(f.name), q) == null) continue;
            s.say(f.line);
            for (f.docs) |d| s.say(d);
        }
    }

    /// Whether the session imports a Library's export under its own name.
    fn importsAs(s: *Session, library: []const u8, name: []const u8) bool {
        for (s.decls.items) |d| if (d.kind == .use) {
            const u = d.use.?;
            if (!std.mem.eql(u8, u.library, library) or u.rename != null) continue;
            for (u.names) |n| if (std.mem.eql(u8, n, name)) return true;
        };
        return false;
    }

    // ------------------------------------------------------------ :trace and :fuel

    fn argsShown(s: *Session, args: []const ?*c.talk_value) []const u8 {
        var out: std.ArrayList(u8) = .empty;
        out.append(s.alloc(), '[') catch {};
        for (args, 0..) |v, i| {
            if (i > 0) out.appendSlice(s.alloc(), ", ") catch {};
            out.appendSlice(s.alloc(), s.withoutCoreMessage(v)) catch {};
        }
        out.append(s.alloc(), ']') catch {};
        return out.items;
    }

    /// A value's display form, with every Core-written error `message` left
    /// out at any depth, since its wording is outside parity (chapter 11,
    /// Errors).
    fn withoutCoreMessage(s: *Session, v: ?*const c.talk_value) []const u8 {
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v.?));
        const shown = s.stripCoreMessages(value, 0) catch return s.display(v);
        const out = shown orelse return s.display(v);
        defer out.release();
        return s.display(@ptrCast(out));
    }

    /// Nesting past this depth is shown as it is.
    const strip_depth = 256;

    /// A copy of `v` without Core-written `message` keys, or null when it
    /// holds none.
    fn stripCoreMessages(s: *Session, v: *const northtalk.value.Value, depth: usize) northtalk.value.Error!?*northtalk.value.Value {
        if (depth >= strip_depth) return null;
        const V = northtalk.value;
        switch (v.data) {
            .list => |items| {
                var copy: ?[]*V.Value = null;
                defer if (copy) |xs| {
                    for (xs) |x| x.release();
                    s.gpa.free(xs);
                };
                for (items, 0..) |item, i| {
                    const stripped = try s.stripCoreMessages(item, depth + 1) orelse {
                        if (copy) |xs| xs[i] = item.retain();
                        continue;
                    };
                    if (copy == null) {
                        const xs = s.gpa.alloc(*V.Value, items.len) catch |e| {
                            stripped.release();
                            return e;
                        };
                        for (items[0..i], xs[0..i]) |x, *y| y.* = x.retain();
                        copy = xs;
                    }
                    copy.?[i] = stripped;
                }
                const xs = copy orelse return null;
                return try V.list(s.gpa, xs);
            },
            .map => |m| {
                var pairs: std.ArrayList(V.Pair) = .empty;
                defer {
                    for (pairs.items) |p| p.value.release();
                    pairs.deinit(s.gpa);
                }
                var changed = false;
                for (0..m.len) |i| {
                    const p = m.at(i);
                    if (v.core_message and std.mem.eql(u8, p.key, "message")) {
                        changed = true;
                        continue;
                    }
                    const stripped = try s.stripCoreMessages(p.value, depth + 1);
                    changed = changed or stripped != null;
                    pairs.append(s.gpa, .{ .key = p.key, .value = stripped orelse p.value.retain() }) catch |e| {
                        (stripped orelse p.value).release();
                        return e;
                    };
                }
                if (!changed) return null;
                return try V.map(s.gpa, pairs.items);
            },
            else => return null,
        }
    }

    /// At dispatch, a Run whose message's Selector a filter names is latched.
    fn traceStart(s: *Session, x: c.talk_run_started) void {
        const selector = x.selector[0..x.selector_len];
        if (selector.len == 0 or !s.observing.filters.contains(selector)) return;
        const run = s.dupe(x.run[0..x.run_len]);
        s.observing.latched.put(s.alloc(), run, s.dupe(selector)) catch return;
        s.trace_out.append(s.alloc(), s.print("trace start {{script: {s}, run: {s}, selector: {s}, args: {s}}}", .{ s.textShown(x.script[0..x.script_len]), s.textShown(run), s.textShown(selector), s.argsShown(@ptrCast(x.args[0..x.args_len])) })) catch {};
    }

    fn traceEnd(s: *Session, x: c.talk_run_end) void {
        const run = x.run[0..x.run_len];
        const kv = s.observing.latched.fetchOrderedRemove(run) orelse return;
        const head = s.print("trace end {{script: {s}, run: {s}, selector: {s}, outcome: ", .{ s.textShown(x.script[0..x.script_len]), s.textShown(run), s.textShown(kv.value) });
        const tail = switch (x.outcome) {
            c.TALK_COMPLETED => s.print("\"completed\", result: {s}}}", .{s.withoutCoreMessage(x.result)}),
            c.TALK_ERRORED => s.print("\"errored\", error: {s}}}", .{s.errorShown(x.@"error".*.data)}),
            c.TALK_LIMIT_FAULT => s.print("\"limit fault\", limit: {s}}}", .{s.textShown(x.limit[0..x.limit_len])}),
            c.TALK_CANCELLED => "\"cancelled\"}",
            c.TALK_UNHANDLED_OUTCOME => "\"unhandled\"}",
            c.TALK_DROPPED => "\"dropped\"}",
            else => "\"effect failed\"}",
        };
        s.trace_out.append(s.alloc(), s.print("{s}{s}", .{ head, tail })) catch {};
    }

    fn traceDiscarded(s: *Session, x: c.talk_run_discarded) void {
        const run = x.run[0..x.run_len];
        const kv = s.observing.latched.fetchOrderedRemove(run) orelse return;
        s.trace_out.append(s.alloc(), s.print("trace end {{script: {s}, run: {s}, selector: {s}, outcome: \"discarded\", reason: {s}}}", .{ s.textShown(x.script[0..x.script_len]), s.textShown(run), s.textShown(kv.value), s.textShown(x.reason[0..x.reason_len]) })) catch {};
    }

    fn measurementOf(s: *Session, root: []const u8) ?*Measurement {
        for (s.observing.measurements.items) |*m| if (!m.settled and std.mem.eql(u8, m.root, root)) return m;
        return null;
    }

    /// A lifecycle discard of a member interrupts its measurement.
    fn measureDiscard(s: *Session, x: c.talk_run_discarded) void {
        const m = s.measurementOf(x.ancestry.root_delivery[0..x.ancestry.root_delivery_len]) orelse return;
        if (!std.mem.eql(u8, x.reason[0..x.reason_len], "rewind")) m.interrupted = true;
    }

    /// Each member's latest Fuel, and each root's work, from the accounting
    /// tail.
    fn measure(s: *Session, reports: []const c.talk_report) void {
        for (reports) |r| switch (r.kind) {
            c.TALK_REPORT_RUN_ACCOUNTING => {
                const x = r.as.run_accounting;
                const m = s.measurementOf(x.ancestry.root_delivery[0..x.ancestry.root_delivery_len]) orelse continue;
                m.members.put(s.alloc(), s.dupe(x.run[0..x.run_len]), x.fuel) catch {};
            },
            c.TALK_REPORT_CAUSAL_WORK => {
                const x = r.as.causal_work;
                const m = s.measurementOf(x.root_delivery[0..x.root_delivery_len]) orelse continue;
                m.live = x.live_runs;
                m.queued = x.queued_messages;
                if (x.live_runs == 0 and x.queued_messages == 0) m.settled = true;
            },
            else => {},
        };
    }

    /// A Selector, as `:trace` takes it: a Name, or Names each ended by `:`.
    fn validSelector(text: []const u8) bool {
        return analysis.validMessageName(text, std.mem.count(u8, text, ":"));
    }

    fn traceCommand(s: *Session, rest: []const u8) !void {
        if (rest.len == 0) {
            const names = try s.alloc().dupe([]const u8, s.observing.filters.keys());
            std.mem.sort([]const u8, names, {}, struct {
                fn less(_: void, x: []const u8, y: []const u8) bool {
                    return std.mem.order(u8, x, y) == .lt;
                }
            }.less);
            for (names) |n| s.sayf("trace {s}", .{s.textShown(n)});
            return;
        }
        if (!validSelector(rest)) return s.say("! bad arguments");
        try s.observing.filters.put(s.alloc(), s.dupe(rest), {});
    }

    fn untraceCommand(s: *Session, rest: []const u8) !void {
        if (rest.len == 0) {
            s.observing.filters.clearRetainingCapacity();
            return;
        }
        if (!validSelector(rest)) return s.say("! bad arguments");
        _ = s.observing.filters.orderedRemove(rest);
    }

    /// `:fuel` lists every measurement; `:fuel <entry>` measures an
    /// executable Entry and everything it spawns.
    fn fuelCommand(s: *Session, rest: []const u8, more: []const []const u8) !void {
        if (rest.len == 0 and more.len == 0) {
            for (s.observing.measurements.items) |*m| s.say(s.fuelRow(m));
            return;
        }
        const text = try entryText(.{ .first = rest, .more = more }, s.alloc());
        if (isCommand(text)) return s.say("! bad arguments");
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        const e = try s.analyzeEntry(arena.allocator(), text);
        if (e.doc != .none or e.kind == .declaration or e.kind == .empty) return s.say("! bad arguments");
        s.measuring = true;
        defer s.measuring = false;
        _ = try s.runEntry(text, e.kind == .expression);
    }
    // ------------------------------------------------------------ object crossings

    /// A recorded Object Kind: its handle, and each property's declaration
    /// as the Transcript gives it.
    /// A defined Object Kind; `text` is a live declaration's envelope.
    const KindInfo = struct { name: []const u8, kind: *c.talk_object_kind, props: []PropInfo, text: []const u8 = "" };
    const PropInfo = struct { name: []const u8, shape: []const u8, read_only: bool, get: [2]i64, set: [2]i64, session: *Session, kind: []const u8 };

    fn parseJson(s: *Session, text: []const u8) ?std.json.Value {
        // Keep embedded Value Encoding numbers exact and let the decoder
        // check their canonical spelling, just as talk_decode_value does.
        return std.json.parseFromSliceLeaky(std.json.Value, s.alloc(), text, .{ .parse_numbers = false, .duplicate_field_behavior = .@"error" }) catch null;
    }

    fn jsonText(v: std.json.Value, key: []const u8) []const u8 {
        if (v != .object) return "";
        const x = v.object.get(key) orelse return "";
        return if (x == .string) x.string else "";
    }

    fn jsonInt(v: std.json.Value, key: []const u8) i64 {
        if (v != .object) return 0;
        const x = v.object.get(key) orelse return 0;
        return switch (x) {
            .integer => |n| n,
            .string, .number_string => |t| std.fmt.parseInt(i64, t, 10) catch 0,
            else => 0,
        };
    }

    fn costOf(v: ?std.json.Value) [2]i64 {
        const x = v orelse return .{ 0, 0 };
        return .{ jsonInt(x, "fuel"), jsonInt(x, "alloc") };
    }

    /// The next recorded crossing, if the Transcript has one here.
    fn peekCrossing(s: *Session) ?std.json.Value {
        const text = s.driver.crossing(s.driver.context) orelse return null;
        return s.parseJson(text);
    }

    fn takeCrossing(s: *Session) void {
        s.driver.take(s.driver.context);
    }

    /// A top-level crossing envelope, between Host calls.
    pub fn crossing(s: *Session, text: []const u8) !void {
        const v = s.parseJson(text) orelse return error.MalformedTranscript;
        const kind = jsonText(v, "type");
        if (std.mem.eql(u8, kind, "kind")) return s.defineKind(v);
        if (std.mem.eql(u8, kind, "object")) return s.registerObject(v.object.get("object").?);
        if (std.mem.eql(u8, kind, "setup")) {
            var it = v.object.get("objects").?.object.iterator();
            while (it.next()) |e| try s.setup.append(s.alloc(), .{ .name = s.dupe(e.key_ptr.*), .kind = s.dupe(jsonText(e.value_ptr.*, "kind")), .id = s.dupe(jsonText(e.value_ptr.*, "id")) });
            return;
        }
        if (std.mem.eql(u8, kind, "input")) {
            try s.start();
            try s.hostInput(v);
            return;
        }
        return error.MalformedTranscript;
    }

    /// A live embedder's declaration (#2276): a `kind`, `object` or `setup`
    /// envelope, as session-observation.md writes it. The session checks
    /// it, applies it as a replay would, and records it; an identical
    /// repeat is redundant and not recorded again. Inside a `prop` answer
    /// the driver declares any identity its answer names first.
    pub fn declare(s: *Session, text: []const u8) !void {
        if (!s.liveObjects()) return error.NotLive;
        const v = s.parseJson(text) orelse return error.MalformedEnvelope;
        if (!s.canonical(v, text)) return error.MalformedEnvelope;
        const kind = jsonText(v, "type");
        if (std.mem.eql(u8, kind, "kind")) {
            if (!fieldsAre(v, &.{ "name", "parentKinds", "props", "type" }, &.{"elements"})) return error.MalformedEnvelope;
            if (s.kinds.get(jsonText(v, "name"))) |k| {
                if (std.mem.eql(u8, k.text, text)) return;
                return error.ConflictingKind;
            }
            try s.defineKind(v);
            s.kinds.getPtr(jsonText(v, "name")).?.text = s.dupe(text);
        } else if (std.mem.eql(u8, kind, "object")) {
            if (!fieldsAre(v, &.{ "object", "type" }, &.{})) return error.MalformedEnvelope;
            const ref = v.object.get("object").?;
            if (!fieldsAre(ref, &.{ "id", "kind" }, &.{}) or jsonText(ref, "id").len == 0) return error.MalformedEnvelope;
            if (s.kinds.get(jsonText(ref, "kind")) == null) return error.UnknownKind;
            if (s.registered(jsonText(ref, "kind"), jsonText(ref, "id"))) return;
            try s.registerObject(ref);
        } else if (std.mem.eql(u8, kind, "setup")) {
            if (!fieldsAre(v, &.{ "objects", "type" }, &.{}) or s.group != null) return error.MalformedEnvelope;
            const objects = v.object.get("objects").?;
            if (objects != .object) return error.MalformedEnvelope;
            for (objects.object.values()) |ref| if (!s.registered(jsonText(ref, "kind"), jsonText(ref, "id"))) return error.UnknownObject;
            try s.crossing(text);
        } else return error.MalformedEnvelope;
        s.recordEnvelope(text);
    }

    fn registered(s: *const Session, kind: []const u8, id: []const u8) bool {
        for (s.objects.items) |o| if (std.mem.eql(u8, o.kind, kind) and std.mem.eql(u8, o.id, id)) return true;
        return false;
    }

    /// Whether `v`, an envelope, has exactly the fields `required` and
    /// perhaps some of `optional`.
    fn fieldsAre(v: std.json.Value, required: []const []const u8, optional: []const []const u8) bool {
        if (v != .object) return false;
        for (required) |k| if (v.object.get(k) == null) return false;
        var it = v.object.iterator();
        next: while (it.next()) |e| {
            for (required) |k| if (std.mem.eql(u8, k, e.key_ptr.*)) continue :next;
            for (optional) |k| if (std.mem.eql(u8, k, e.key_ptr.*)) continue :next;
            return false;
        }
        return true;
    }

    /// Whether `text` is `v` written compactly with every object's keys in
    /// code-point order, as a declaration envelope must be.
    fn canonical(s: *Session, v: std.json.Value, text: []const u8) bool {
        if (!sortedKeys(v)) return false;
        const again = std.json.Stringify.valueAlloc(s.alloc(), v, .{}) catch return false;
        return std.mem.eql(u8, again, text);
    }

    fn sortedKeys(v: std.json.Value) bool {
        switch (v) {
            .object => |o| {
                const keys = o.keys();
                for (keys, 0..) |k, i| if (i > 0 and std.mem.order(u8, keys[i - 1], k) != .lt) return false;
                for (o.values()) |x| if (!sortedKeys(x)) return false;
            },
            .array => |a| for (a.items) |x| if (!sortedKeys(x)) return false,
            else => {},
        }
        return true;
    }

    /// A collection's Shape, an Object Shape or a choice of them, owned.
    fn elementShape(s: *Session, shape: std.json.Value) !*c.talk_shape {
        if (shape != .object) return error.MalformedTranscript;
        if (shape.object.get("object")) |k| {
            if (k != .string) return error.MalformedTranscript;
            return @ptrCast(try northtalk.talk.objectShapeNamed(k.string));
        }
        const choices = (shape.object.get("oneOf") orelse return error.MalformedTranscript).array.items;
        const made = try s.alloc().alloc(?*const c.talk_shape, choices.len);
        var done: usize = 0;
        defer for (made[0..done]) |x| c.talk_shape_release(x);
        for (choices, made) |x, *m| {
            m.* = try s.elementShape(x);
            done += 1;
        }
        var out: ?*c.talk_shape = null;
        try check_(c.talk_one_of(made.ptr, made.len, &out));
        return out.?;
    }

    fn elementCount(context: ?*anyopaque, o: ?*c.talk_object, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const s: *Session = @ptrCast(@alignCast(context.?));
        if (s.liveObjects()) return c.TALK_CALL_STARTED;
        return s.replayed(crossingOf(o, "elements", "count"), result, err);
    }

    fn elementAt(context: ?*anyopaque, o: ?*c.talk_object, index: i64, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const s: *Session = @ptrCast(@alignCast(context.?));
        if (s.liveObjects()) return c.TALK_CALL_STARTED;
        var x = crossingOf(o, "elements", "at");
        x.selector = .{ .index = index };
        return s.replayed(x, result, err);
    }

    fn elementFind(context: ?*anyopaque, o: ?*c.talk_object, name: [*c]const u8, name_len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const s: *Session = @ptrCast(@alignCast(context.?));
        if (s.liveObjects()) return c.TALK_CALL_STARTED;
        var x = crossingOf(o, "elements", "find");
        x.selector = .{ .name = name[0..name_len] };
        return s.replayed(x, result, err);
    }

    /// A property's Shape: a named one, or its data-model JSON, which the
    /// caller releases once the kind is defined (`owned`).
    fn shapeOf(s: *Session, shape: std.json.Value, owned: *std.ArrayList(*c.talk_shape)) !*const c.talk_shape {
        if (shape == .string) {
            const names = [_]struct { []const u8, *const fn () callconv(.c) ?*const c.talk_shape }{
                .{ "any", c.talk_any_shape },               .{ "value", c.talk_value_shape },     .{ "nothing", c.talk_nothing_shape },
                .{ "boolean", c.talk_bool_shape },          .{ "number", c.talk_number_shape },   .{ "text", c.talk_text_shape },
                .{ "bytes", c.talk_bytes_shape },           .{ "instant", c.talk_instant_shape }, .{ "range", c.talk_range_shape },
                .{ "civil date", c.talk_civil_date_shape }, .{ "pattern", c.talk_pattern_shape }, .{ "function", c.talk_function_shape },
            };
            for (names) |n| if (std.mem.eql(u8, n[0], shape.string)) return n[1]().?;
        }
        const made: *c.talk_shape = @ptrCast(northtalk.talk.shapeFromJson(shape) catch return error.MalformedTranscript);
        try owned.append(s.alloc(), made);
        return made;
    }

    fn defineKind(s: *Session, v: std.json.Value) !void {
        const name = s.dupe(jsonText(v, "name"));
        const props_json = (v.object.get("props") orelse return error.MalformedTranscript).array.items;
        const infos = try s.alloc().alloc(PropInfo, props_json.len);
        const props = try s.alloc().alloc(c.talk_prop, props_json.len);
        var shapes: std.ArrayList(*c.talk_shape) = .empty;
        defer for (shapes.items) |x| c.talk_shape_release(x);
        for (props_json, infos, props) |p, *info, *prop| {
            const read_only = if (p.object.get("readOnly")) |r| r == .bool and r.bool else true;
            const shape_value = p.object.get("shape") orelse std.json.Value{ .string = "any" };
            var shape_text: std.Io.Writer.Allocating = .init(s.alloc());
            try std.json.Stringify.value(shape_value, .{}, &shape_text.writer);
            info.* = .{ .name = s.dupe(jsonText(p, "name")), .shape = shape_text.written(), .read_only = read_only, .get = costOf(p.object.get("getCost")), .set = costOf(p.object.get("setCost")), .session = s, .kind = name };
            prop.* = .{
                .name = info.name.ptr,
                .name_len = info.name.len,
                .shape = try s.shapeOf(shape_value, &shapes),
                .get = propGet,
                .set = if (read_only) null else propSet,
                .context = info,
                .get_cost = .{ .fuel = info.get[0], .alloc = info.get[1] },
                .set_cost = .{ .fuel = info.set[0], .alloc = info.set[1] },
            };
        }
        // Its Object Collection (#1143), whose callbacks the recorded
        // `property-begin` crossings answer as a getter's do.
        var elements: c.talk_object_elements = undefined;
        const declared = v.object.get("elements");
        if (declared) |e| {
            const cost = struct {
                fn of(x: ?std.json.Value) c.talk_cost {
                    const pair = costOf(x);
                    return .{ .fuel = pair[0], .alloc = pair[1] };
                }
            }.of;
            elements = .{
                .shape = try s.elementShape(e.object.get("shape") orelse return error.MalformedTranscript),
                .count = elementCount,
                .at = elementAt,
                .find = elementFind,
                .context = s,
                .count_cost = cost(e.object.get("countCost")),
                .at_cost = cost(e.object.get("atCost")),
                .find_cost = cost(e.object.get("findCost")),
            };
        }
        defer if (declared != null) c.talk_shape_release(elements.shape);
        // Its parent kinds, for the Host Manifest.
        const parents_json: []const std.json.Value = if (v.object.get("parentKinds")) |p| (if (p == .array) p.array.items else return error.MalformedTranscript) else &.{};
        const parents = try s.alloc().alloc([*c]const u8, parents_json.len);
        const parent_lens = try s.alloc().alloc(usize, parents_json.len);
        for (parents_json, parents, parent_lens) |x, *ptr, *len| {
            if (x != .string) return error.MalformedTranscript;
            ptr.* = x.string.ptr;
            len.* = x.string.len;
        }
        const def: c.talk_object_kind_def = .{ .name = name.ptr, .name_len = name.len, .props = props.ptr, .props_len = props.len, .parent_kinds = if (parents.len > 0) parents.ptr else null, .parent_kinds_lens = if (parents.len > 0) parent_lens.ptr else null, .parent_kinds_len = parents.len, .elements = if (declared != null) &elements else null };
        var kind: ?*c.talk_object_kind = null;
        try check_(c.talk_define_object_kind(s.core, &def, &kind));
        try s.kinds.put(s.alloc(), name, .{ .name = name, .kind = kind.?, .props = infos });
    }

    /// An object's handle in the Group, made the first time it is named.
    fn registerObject(s: *Session, ref: std.json.Value) !void {
        const kind = s.dupe(jsonText(ref, "kind"));
        const id = s.dupe(jsonText(ref, "id"));
        try s.objects.append(s.alloc(), .{ .kind = kind, .id = id });
        if (s.group != null) _ = try s.objectOf(kind, id);
    }

    fn objectOf(s: *Session, kind: []const u8, id: []const u8) !?*c.talk_object {
        const g = s.group orelse return null;
        var o: ?*c.talk_object = null;
        if (c.talk_object_by_id(g, kind.ptr, kind.len, id.ptr, id.len, &o)) return o;
        const k = s.kinds.get(kind) orelse return null;
        // A dummy native identity; replay never calls the original Host.
        try check_(c.talk_group_object(g, k.kind, id.ptr, id.len, @ptrFromInt(1), &o));
        return o;
    }

    fn objectRef(s: *Session, ref: std.json.Value) !?*c.talk_object {
        if (ref != .object) return null;
        return s.objectOf(jsonText(ref, "kind"), jsonText(ref, "id"));
    }

    fn resolveObject(context: ?*anyopaque, kind: []const u8, id: []const u8) northtalk.value.Error!*northtalk.value.Value {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const o = (s.objectOf(kind, id) catch return error.InvalidValue) orelse return error.InvalidValue;
        var v: ?*c.talk_value = null;
        if (c.talk_object_value(o, &v) != c.TALK_OK) return error.InvalidValue;
        // talk_object_value returns the owned reference the decoder needs.
        return @ptrCast(@alignCast(v.?));
    }

    fn resolveFunction(context: ?*anyopaque, handle: []const u8) northtalk.value.Error!*northtalk.value.Value {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const v: *northtalk.value.Value = @ptrCast(@alignCast(s.handles.get(handle) orelse return error.InvalidValue));
        if (v.data != .function) return error.InvalidValue;
        return v.retain();
    }

    /// A Restore's resolver: each object as the recorded `resolve`
    /// envelope says.
    fn restoreResolve(context: ?*anyopaque, kind: [*c]const u8, kind_len: usize, id: [*c]const u8, id_len: usize, native: [*c]?*anyopaque) callconv(.c) bool {
        const s: *Session = @ptrCast(@alignCast(context.?));
        if (s.liveObjects()) {
            for (s.resolving.items) |r| if (std.mem.eql(u8, r.kind, kind[0..kind_len]) and std.mem.eql(u8, r.id, id[0..id_len])) {
                if (r.resolved) native.* = @ptrFromInt(1);
                return r.resolved;
            };
            return false;
        }
        if (s.resolved == null) {
            const record = s.peekCrossing() orelse return false;
            if (!std.mem.eql(u8, jsonText(record, "type"), "resolve")) return false;
            s.takeCrossing();
            s.resolved = record.object.get("objects").?.array.items;
        }
        for (s.resolved.?) |r| {
            const o = r.object.get("object").?;
            if (!std.mem.eql(u8, jsonText(o, "kind"), kind[0..kind_len]) or !std.mem.eql(u8, jsonText(o, "id"), id[0..id_len])) continue;
            s.resolved_used += 1;
            const yes = r.object.get("resolved").?;
            if (yes != .bool or !yes.bool) return false;
            native.* = @ptrFromInt(1);
            return true;
        }
        return false;
    }

    /// A live Restore's first pass, which makes nothing and writes no
    /// Trace: the identities the save binds, which the driver resolves at
    /// once, as the reactor's `restore` asks its Host (#2276).
    fn askResolver(s: *Session, bytes: []const u8, options: c.talk_restore_options) !void {
        s.resolving.clearRetainingCapacity();
        var probe = options;
        probe.trace = null;
        probe.trace_context = null;
        probe.resolve = collectResolve;
        probe.resolve_context = s;
        var group: ?*c.talk_group = null;
        var result: ?*c.talk_restore_result = null;
        var routing: ?*c.talk_routing_result = null;
        // A checkpoint is the router's; the Group it makes goes at once.
        _ = c.talk_router_restore(s.router, s.core, bytes.ptr, bytes.len, &probe, &group, &result, &routing);
        c.talk_routing_result_release(routing);
        c.talk_restore_result_release(result);
        if (group) |g| {
            c.talk_router_detach(s.router, g);
            c.talk_group_release(g);
        }
        if (s.resolving.items.len == 0) return;
        std.mem.sort(Resolution, s.resolving.items, {}, struct {
            fn less(_: void, x: Resolution, y: Resolution) bool {
                const by_kind = std.mem.order(u8, x.kind, y.kind);
                return by_kind == .lt or (by_kind == .eq and std.mem.order(u8, x.id, y.id) == .lt);
            }
        }.less);
        var out: std.Io.Writer.Allocating = .init(s.alloc());
        try out.writer.writeAll("[");
        for (s.resolving.items, 0..) |r, i| {
            if (i > 0) try out.writer.writeAll(",");
            try out.writer.writeAll("[");
            try northtalk.encoding.quoted(&out.writer, r.kind);
            try out.writer.writeAll(",");
            try northtalk.encoding.quoted(&out.writer, r.id);
            try out.writer.writeAll("]");
        }
        try out.writer.writeAll("]");
        const answer = s.parseJson(s.driver.resolve.?(s.driver.context, out.written()) orelse return s.suspendCall(.rerun));
        const answers: []const std.json.Value = if (answer) |a| (if (a == .array) a.array.items else &.{}) else &.{};
        for (s.resolving.items, 0..) |*r, i| r.resolved = i < answers.len and answers.len == s.resolving.items.len and answers[i] == .bool and answers[i].bool;
    }

    fn collectResolve(context: ?*anyopaque, kind: [*c]const u8, kind_len: usize, id: [*c]const u8, id_len: usize, native: [*c]?*anyopaque) callconv(.c) bool {
        _ = native;
        const s: *Session = @ptrCast(@alignCast(context.?));
        for (s.resolving.items) |r| if (std.mem.eql(u8, r.kind, kind[0..kind_len]) and std.mem.eql(u8, r.id, id[0..id_len])) return false;
        s.resolving.append(s.alloc(), .{ .kind = s.dupe(kind[0..kind_len]), .id = s.dupe(id[0..id_len]) }) catch {};
        return false;
    }

    /// The live Restore's `resolve` envelope: each outcome, by kind then id.
    fn recordResolved(s: *Session) void {
        var out: std.Io.Writer.Allocating = .init(s.alloc());
        const w = &out.writer;
        w.writeAll("{\"objects\":[") catch return;
        for (s.resolving.items, 0..) |r, i| {
            if (i > 0) w.writeAll(",") catch return;
            w.writeAll("{\"object\":") catch return;
            writeRef(w, r.kind, r.id) catch return;
            w.print(",\"resolved\":{}}}", .{r.resolved}) catch return;
        }
        w.writeAll("],\"type\":\"resolve\"}") catch return;
        s.recordEnvelope(out.written());
        s.resolving.clearRetainingCapacity();
    }

    /// A Value from a crossing's JSON: the Value Encoding, with each
    /// `{"$sessionFunction": <handle>}` the Function Value it names.
    fn valueOf(s: *Session, v: std.json.Value) !?*c.talk_value {
        const out = northtalk.encoding.decodeParsed(s.gpa, v, .{
            .context = s,
            .object = resolveObject,
            .session_function = resolveFunction,
        }) catch |err| return if (err == error.OutOfMemory) err else null;
        return @ptrCast(out);
    }

    /// One step of a `function` record's `path`: a list index, or a map
    /// key or record field name.
    const Step = union(enum) { index: usize, key: []const u8 };

    /// Starts a Value exposure, numbered in observation order from 1.
    fn exposure(s: *Session) u64 {
        s.exposures += 1;
        return s.exposures;
    }

    /// A callback's arguments, as one exposure whose paths start at the
    /// argument list.
    fn expose(s: *Session, values: []const ?*const c.talk_value) void {
        const n = s.exposure();
        for (values, 0..) |v, i| s.exposeAt(v, n, &.{.{ .index = i }});
    }

    /// Each Function Value leaf under `maybe`, depth first and in order,
    /// at `prefix` and below: a replay binds the handle its recorded
    /// `function` envelope names, and a live session records one.
    fn exposeAt(s: *Session, maybe: ?*const c.talk_value, n: u64, at: []const Step) void {
        const root = maybe orelse return;
        const Item = struct { value: *const northtalk.value.Value, path: []const Step };
        var stack: std.ArrayList(Item) = .empty;
        stack.append(s.alloc(), .{ .value = @ptrCast(@alignCast(root)), .path = at }) catch return;
        while (stack.pop()) |item| switch (item.value.data) {
            .function => s.functionLeaf(item.value, n, item.path),
            .list => |items| {
                var i = items.len;
                while (i > 0) {
                    i -= 1;
                    const path = std.mem.concat(s.alloc(), Step, &.{ item.path, &.{.{ .index = i }} }) catch return;
                    stack.append(s.alloc(), .{ .value = items[i], .path = path }) catch return;
                }
            },
            .map => |pairs| {
                var i = pairs.len;
                while (i > 0) {
                    i -= 1;
                    const pair = pairs.at(i);
                    const path = std.mem.concat(s.alloc(), Step, &.{ item.path, &.{.{ .key = pair.key }} }) catch return;
                    stack.append(s.alloc(), .{ .value = pair.value, .path = path }) catch return;
                }
            },
            else => {},
        };
    }

    fn functionLeaf(s: *Session, value: *const northtalk.value.Value, n: u64, path: []const Step) void {
        const v: *c.talk_value = @ptrCast(@constCast(value));
        var handle: []const u8 = undefined;
        if (s.liveObjects()) {
            s.handle_count += 1;
            handle = s.print("f{d}", .{s.handle_count});
            var out: std.Io.Writer.Allocating = .init(s.alloc());
            const w = &out.writer;
            w.print("{{\"exposure\":{d},\"handle\":\"{s}\",\"path\":[", .{ n, handle }) catch return;
            for (path, 0..) |step, i| {
                if (i > 0) w.writeAll(",") catch return;
                switch (step) {
                    .index => |x| w.print("{d}", .{x}) catch return,
                    .key => |k| northtalk.encoding.quoted(w, k) catch return,
                }
            }
            w.writeAll("],\"type\":\"function\"}") catch return;
            s.recordEnvelope(out.written());
        } else {
            const record = s.peekCrossing() orelse return;
            if (!std.mem.eql(u8, jsonText(record, "type"), "function")) return;
            s.takeCrossing();
            handle = s.dupe(jsonText(record, "handle"));
        }
        c.talk_value_retain(v);
        s.handles.put(s.alloc(), handle, v) catch {};
        s.supplied.put(s.alloc(), @intFromPtr(value), handle) catch {};
    }

    /// A report, as one exposure whose paths start at the report.
    fn exposeReport(s: *Session, r: c.talk_report) void {
        const n = s.exposure();
        switch (r.kind) {
            c.TALK_REPORT_RUN_STARTED => {
                const x = r.as.run_started;
                s.exposeAt(x.function, n, &.{.{ .key = "fn" }});
                for (x.args[0..x.args_len], 0..) |a, i| s.exposeAt(a, n, &.{ .{ .key = "args" }, .{ .index = i } });
            },
            c.TALK_REPORT_RUN_END => {
                const x = r.as.run_end;
                s.exposeAt(x.result, n, &.{.{ .key = "result" }});
                if (x.@"error") |e| s.exposeAt(e.*.data, n, &.{ .{ .key = "error" }, .{ .key = "data" } });
            },
            c.TALK_REPORT_UNHANDLED => for (r.as.unhandled.args[0..r.as.unhandled.args_len], 0..) |a, i| s.exposeAt(a, n, &.{ .{ .key = "message" }, .{ .key = "args" }, .{ .index = i } }),
            else => {},
        }
    }

    /// A Script Snapshot's variables, as one exposure whose paths start at
    /// the Script names.
    fn exposeSnapshot(s: *Session, inspection: *const c.talk_inspection) void {
        const n = s.exposure();
        for (inspection.scripts[0..inspection.scripts_len]) |view| {
            const script = view.name[0..view.name_len];
            for (view.vars[0..view.vars_len]) |p| s.exposeAt(p.value, n, &.{ .{ .key = script }, .{ .key = p.key[0..p.key_len] } });
        }
    }

    /// A Host action an external Host made, or one a property callback made
    /// while it ran, which its Pump drains.
    /// A recorded Host action, replayed: performed at its place, its
    /// reply the same as the recording's (session-observation.md).
    fn hostInput(s: *Session, envelope: std.json.Value) !void {
        const reply = try s.perform(envelope.object.get("request") orelse return error.MalformedTranscript);
        const recorded = std.json.Stringify.valueAlloc(s.alloc(), envelope.object.get("reply") orelse return error.MalformedTranscript, .{}) catch return error.OutOfMemory;
        if (!std.mem.eql(u8, reply, recorded)) return error.MalformedTranscript;
    }

    /// A live embedder's Host action (#2284): an `input` envelope with its
    /// `request` alone. The session performs it, at once, and records it
    /// with its reply; during a crossing it lands before the crossing's
    /// end, and the Host call Pumps once more for it.
    pub fn act(s: *Session, text: []const u8) !void {
        const request = try s.actionOf(text);
        try s.start();
        const reply = s.perform(request) catch |err| return if (err == error.MalformedTranscript) error.MalformedEnvelope else err;
        const request_text = try std.json.Stringify.valueAlloc(s.alloc(), request, .{});
        s.recordEnvelope(s.print("{{\"reply\":{s},\"request\":{s},\"type\":\"input\"}}", .{ reply, request_text }));
        if (s.crossing_need != null) s.queued = true;
    }

    /// A live Host action's request, checked as far as it can be without
    /// performing it: the envelope's and the request's fields and their
    /// types. Its Values keep their own key order, as a map's insertion
    /// order; only the envelope's and request's own keys are sorted.
    fn actionOf(s: *Session, text: []const u8) !std.json.Value {
        if (!s.liveObjects()) return error.NotLive;
        const v = s.parseJson(text) orelse return error.MalformedEnvelope;
        if (!fieldsAre(v, &.{ "request", "type" }, &.{}) or !std.mem.eql(u8, jsonText(v, "type"), "input")) return error.MalformedEnvelope;
        const request = v.object.get("request").?;
        if (!shallowSorted(v) or !shallowSorted(request)) return error.MalformedEnvelope;
        const again = try std.json.Stringify.valueAlloc(s.alloc(), v, .{});
        if (!std.mem.eql(u8, again, text)) return error.MalformedEnvelope;
        _ = actionFieldsOf(request) orelse return error.MalformedEnvelope;
        return request;
    }

    fn shallowSorted(v: std.json.Value) bool {
        if (v != .object) return false;
        const keys = v.object.keys();
        for (keys, 0..) |k, i| if (i > 0 and std.mem.order(u8, keys[i - 1], k) != .lt) return false;
        return true;
    }

    /// An envelope a live embedder hands the session: a declaration, or a
    /// Host action's `input` with its `request` alone.
    pub fn receive(s: *Session, text: []const u8) !void {
        const v = s.parseJson(text) orelse return error.MalformedEnvelope;
        return if (std.mem.eql(u8, jsonText(v, "type"), "input")) s.act(text) else s.declare(text);
    }

    /// Checks envelopes a live embedder hands over together, as far as
    /// `receive` would without applying them, so a malformed one refuses
    /// the batch before any is applied.
    pub fn checkReceived(s: *Session, texts: []const []const u8) !void {
        for (texts) |text| {
            const v = s.parseJson(text) orelse return error.MalformedEnvelope;
            if (std.mem.eql(u8, jsonText(v, "type"), "input")) {
                _ = try s.actionOf(text);
            } else if (!s.canonical(v, text)) return error.MalformedEnvelope;
        }
    }

    const Action = enum { set_parent, dispose, deliver, request, cancel_delivery, broadcast, call, decide, answer, fail, settle, stop, cancel_run, revoke };

    /// Each Host action: its name, and its fields, required then optional.
    const action_fields = [_]struct { action: Action, kind: []const u8, required: []const []const u8, optional: []const []const u8 = &.{} }{
        .{ .action = .set_parent, .kind = "set-parent", .required = &.{ "kind", "object", "parent" } },
        .{ .action = .dispose, .kind = "dispose", .required = &.{ "kind", "object" } },
        .{ .action = .deliver, .kind = "deliver", .required = &.{ "kind", "message", "to" } },
        .{ .action = .request, .kind = "request", .required = &.{ "kind", "message", "to" } },
        .{ .action = .cancel_delivery, .kind = "cancel-delivery", .required = &.{ "delivery", "kind" } },
        .{ .action = .broadcast, .kind = "broadcast", .required = &.{ "kind", "message" } },
        .{ .action = .call, .kind = "call", .required = &.{ "args", "fn", "kind" }, .optional = &.{"limits"} },
        .{ .action = .decide, .kind = "decide", .required = &.{ "kind", "message" }, .optional = &.{ "broadcast", "to" } },
        .{ .action = .answer, .kind = "answer", .required = &.{ "call", "kind", "value" }, .optional = &.{"fuel"} },
        .{ .action = .fail, .kind = "fail", .required = &.{ "call", "error", "kind" } },
        .{ .action = .settle, .kind = "settle", .required = &.{ "call", "kind", "settlement" } },
        .{ .action = .stop, .kind = "stop", .required = &.{ "kind", "reason", "script" } },
        .{ .action = .cancel_run, .kind = "cancel-run", .required = &.{ "kind", "run", "script" } },
        .{ .action = .revoke, .kind = "revoke", .required = &.{ "grant", "kind", "script" } },
    };

    /// A request's action, when its fields are exactly that action's and
    /// carry chapter 9's worker types.
    fn actionFieldsOf(request: std.json.Value) ?Action {
        if (request != .object) return null;
        const kind = jsonText(request, "kind");
        const f = for (action_fields) |f| {
            if (std.mem.eql(u8, f.kind, kind)) break f;
        } else return null;
        if (!fieldsAre(request, f.required, f.optional)) return null;
        for ([_][]const u8{ "script", "run", "grant", "delivery", "call", "reason" }) |k| if (request.object.get(k)) |x| if (x != .string) return null;
        for ([_][]const u8{ "message", "to", "settlement", "error", "limits" }) |k| if (request.object.get(k)) |x| if (x != .object) return null;
        if (request.object.get("object")) |x| if (!isRef(x)) return null;
        if (request.object.get("parent")) |x| if (x != .null and !isRef(x)) return null;
        if (request.object.get("args")) |x| if (x != .array) return null;
        if (request.object.get("broadcast")) |x| if (x != .bool or !x.bool) return null;
        if (request.object.get("fuel")) |x| if (jsonInt(request, "fuel") < 0 or x == .bool) return null;
        if (f.action == .decide and (request.object.get("to") == null) == (request.object.get("broadcast") == null)) return null;
        return f.action;
    }

    fn isRef(v: std.json.Value) bool {
        return fieldsAre(v, &.{ "id", "kind" }, &.{}) and v.object.get("id").? == .string and v.object.get("kind").? == .string;
    }

    /// An object a live action names, which must have been declared; a
    /// replay's are all registered from the Transcript.
    fn actionObject(s: *Session, ref: std.json.Value) !?*c.talk_object {
        if (s.liveObjects() and !s.registered(jsonText(ref, "kind"), jsonText(ref, "id"))) return null;
        return s.objectRef(ref);
    }

    /// Performs a Host action's normalized worker request on the session's
    /// Group, as chapter 9's worker messages do, and gives its reply's
    /// text: `{"ok":{…}}` with the delivery or broadcast id it made, or
    /// `{"error":<Host error code>}`, the synchronous refusal. A request
    /// that isn't one is a malformed Transcript.
    fn perform(s: *Session, request: std.json.Value) ![]const u8 {
        const bad = error.MalformedTranscript;
        const action = actionFieldsOf(request) orelse return bad;
        try s.start();
        const g = s.group.?;
        var id: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        defer c.talk_owned_bytes_release(&id);
        // The payload's id field, if the action made one.
        var made: ?[]const u8 = null;
        const code: c.talk_host_error_code = switch (action) {
            .set_parent => code: {
                const o = try s.actionObject(request.object.get("object").?) orelse return bad;
                const p = request.object.get("parent").?;
                const parent = if (p == .null) null else try s.actionObject(p) orelse return bad;
                break :code c.talk_set_parent(g, o, parent);
            },
            .dispose => c.talk_dispose(g, try s.actionObject(request.object.get("object").?) orelse return bad),
            .broadcast, .deliver, .request, .decide => code: {
                var m: ActionMessage = undefined;
                try s.messageOf(request.object.get("message").?, &m);
                defer m.release();
                var deciding: ?*c.talk_deciding = null;
                var pending: ?*c.talk_pending = null;
                defer if (pending) |x| c.talk_pending_release(x);
                if (action == .broadcast or request.object.get("broadcast") != null) {
                    made = "broadcast";
                    break :code if (action == .broadcast) c.talk_broadcast(g, &m.message, &id) else c.talk_decide_broadcast(g, &m.message, &id, &deciding);
                }
                made = "delivery";
                const to = request.object.get("to").?;
                if (to.object.count() != 1) return bad;
                if (to.object.get("script")) |name| {
                    if (name != .string) return bad;
                    const script = c.talk_group_script(g, name.string.ptr, name.string.len) orelse return bad;
                    break :code switch (action) {
                        .deliver => c.talk_script_deliver(script, &m.message, &id),
                        .request => c.talk_script_request(script, &m.message, &id, &pending),
                        else => c.talk_script_decide(script, &m.message, &id, &deciding),
                    };
                }
                const ref = to.object.get("object") orelse return bad;
                if (!isRef(ref)) return bad;
                const o = try s.actionObject(ref) orelse return bad;
                break :code switch (action) {
                    .deliver => c.talk_deliver(g, o, &m.message, &id),
                    .request => c.talk_request(g, o, &m.message, &id, &pending),
                    else => c.talk_decide(g, o, &m.message, &id, &deciding),
                };
            },
            .call => code: {
                var limits = try limitsOf(request.object.get("limits"));
                const fn_value = try s.valueOf(request.object.get("fn").?) orelse return bad;
                defer c.talk_value_release(fn_value);
                const args = try s.argsOf(request.object.get("args"));
                defer for (args) |x| c.talk_value_release(x);
                var pending: ?*c.talk_pending = null;
                defer if (pending) |x| c.talk_pending_release(x);
                made = "delivery";
                break :code c.talk_group_call(g, fn_value, @ptrCast(args.ptr), args.len, if (limits.set != 0) &limits else null, &id, &pending);
            },
            .cancel_delivery => code: {
                const delivery = jsonText(request, "delivery");
                break :code c.talk_cancel_delivery(g, delivery.ptr, delivery.len);
            },
            .stop, .cancel_run, .revoke => code: {
                const name = jsonText(request, "script");
                const script = c.talk_group_script(g, name.ptr, name.len) orelse return bad;
                break :code switch (action) {
                    .stop => c.talk_script_stop(script, jsonText(request, "reason").ptr, jsonText(request, "reason").len),
                    .revoke => c.talk_script_revoke(script, jsonText(request, "grant").ptr, jsonText(request, "grant").len),
                    else => c.talk_script_cancel_run(script, jsonText(request, "run").ptr, jsonText(request, "run").len),
                };
            },
            .answer, .fail => code: {
                // A call the session's Group issued, still waiting or not:
                // a late reply is recorded and ignored at the drain.
                const call = s.issued.get(jsonText(request, "call")) orelse break :code c.TALK_UNKNOWN_CALL;
                const done = if (action == .answer) done: {
                    const value = try s.valueOf(request.object.get("value").?) orelse return bad;
                    defer c.talk_value_release(value);
                    const fuel = if (request.object.get("fuel") != null) jsonInt(request, "fuel") else 0;
                    break :done if (fuel > 0) c.talk_call_answer_with_cost(call, value, fuel) else c.talk_call_answer(call, value);
                } else done: {
                    var e = try s.failureOf(request.object.get("error").?);
                    defer c.talk_value_release(e.data);
                    break :done c.talk_call_fail(call, &e);
                };
                if (done == c.TALK_OK) for (s.pending.items, 0..) |p, i| if (p.call == call) {
                    _ = s.pending.orderedRemove(i);
                    break;
                };
                break :code done;
            },
            .settle => code: {
                const settlement = request.object.get("settlement").?;
                if (settlement.object.count() != 1) return bad;
                var answer: ?*c.talk_value = null;
                defer if (answer) |x| c.talk_value_release(x);
                var failure: ?c.talk_script_error = null;
                defer if (failure) |f| c.talk_value_release(f.data);
                var how: c.talk_settlement = .{ .answer = null, .fail = null, .reissue = false, .adopt = false };
                if (settlement.object.get("answer")) |x| {
                    answer = try s.valueOf(x) orelse return bad;
                    how.answer = answer;
                } else if (settlement.object.get("fail")) |x| {
                    failure = try s.failureOf(x);
                    how.fail = &failure.?;
                } else if (settlement.object.get("reissue")) |x| {
                    if (x != .bool or !x.bool) return bad;
                    how.reissue = true;
                } else if (settlement.object.get("adopt")) |x| {
                    if (x != .bool or !x.bool) return bad;
                    how.adopt = true;
                } else return bad;
                const call = jsonText(request, "call");
                var adopted: ?*c.talk_call = null;
                break :code c.talk_settle(g, call.ptr, call.len, &how, &adopted);
            },
        };
        if (code != c.TALK_OK) return s.print("{{\"error\":\"{s}\"}}", .{hostErrorName(code)});
        const field_name = made orelse return "{\"ok\":{}}";
        return s.print("{{\"ok\":{{\"{s}\":\"{s}\"}}}}", .{ field_name, id.data[0..id.len] });
    }

    /// A Host action's message: its name, its arguments and its limits.
    const ActionMessage = struct {
        message: c.talk_message,
        args: []?*c.talk_value,
        limits: c.talk_limit_override,

        fn release(m: *ActionMessage) void {
            for (m.args) |x| c.talk_value_release(x);
        }
    };

    /// Fills `m` in place, so its message can point at its own limits.
    fn messageOf(s: *Session, v: std.json.Value, m: *ActionMessage) !void {
        if (!fieldsAre(v, &.{"name"}, &.{ "args", "limits" })) return error.MalformedTranscript;
        const name = v.object.get("name").?;
        if (name != .string) return error.MalformedTranscript;
        if (v.object.get("args")) |a| if (a != .array) return error.MalformedTranscript;
        m.limits = try limitsOf(v.object.get("limits"));
        m.args = try s.argsOf(v.object.get("args"));
        m.message = .{ .name = name.string.ptr, .name_len = name.string.len, .args = @ptrCast(m.args.ptr), .args_len = m.args.len, .limits = if (m.limits.set != 0) &m.limits else null };
    }

    fn limitsOf(v: ?std.json.Value) !c.talk_limit_override {
        var out = std.mem.zeroes(c.talk_limit_override);
        const x = v orelse return out;
        if (!fieldsAre(x, &.{}, &.{ "allocPerRun", "fuelPerRun", "maxJoin", "maxWaitMs" })) return error.MalformedTranscript;
        for (x.object.values()) |n| if (n != .integer and n != .number_string) return error.MalformedTranscript;
        if (x.object.get("fuelPerRun") != null) {
            out.set |= 1;
            out.fuel_per_run = jsonInt(x, "fuelPerRun");
        }
        if (x.object.get("allocPerRun") != null) {
            out.set |= 2;
            out.alloc_per_run = jsonInt(x, "allocPerRun");
        }
        if (x.object.get("maxWaitMs") != null) {
            out.set |= 4;
            out.max_wait_ms = jsonInt(x, "maxWaitMs");
        }
        if (x.object.get("maxJoin") != null) {
            out.set |= 8;
            out.max_join = jsonInt(x, "maxJoin");
        }
        return out;
    }

    /// A Script error from `{code, message, data (V)}`; the caller
    /// releases its data.
    fn failureOf(s: *Session, v: std.json.Value) !c.talk_script_error {
        if (!fieldsAre(v, &.{ "code", "data", "message" }, &.{})) return error.MalformedTranscript;
        const code = v.object.get("code").?;
        const message = v.object.get("message").?;
        if (code != .string or message != .string) return error.MalformedTranscript;
        const data = try s.valueOf(v.object.get("data").?) orelse return error.MalformedTranscript;
        return .{ .code = code.string.ptr, .code_len = code.string.len, .message = message.string.ptr, .message_len = message.string.len, .data = data };
    }

    fn argsOf(s: *Session, list: ?std.json.Value) ![]?*c.talk_value {
        const items = if (list) |l| l.array.items else &.{};
        const out = try s.alloc().alloc(?*c.talk_value, items.len);
        var done: usize = 0;
        errdefer for (out[0..done]) |v| c.talk_value_release(v);
        for (items, out) |x, *o| {
            o.* = try s.valueOf(x);
            done += 1;
        }
        return out;
    }

    /// The crossings a property callback recorded, up to its end: objects
    /// it registered and actions it made, then its reply. Its
    /// `property-begin` must be exactly `begin`, what a live session
    /// would have recorded.
    fn callbackReply(s: *Session, begin: []const u8) ?std.json.Value {
        const text = s.driver.crossing(s.driver.context) orelse return null;
        if (!std.mem.eql(u8, text, begin)) return null;
        s.takeCrossing();
        while (s.peekCrossing()) |x| {
            const t = jsonText(x, "type");
            s.takeCrossing();
            if (std.mem.eql(u8, t, "property-end")) {
                if (jsonInt(x, "crossing") != s.crossed) return null;
                return x.object.get("reply");
            }
            if (std.mem.eql(u8, t, "object")) s.registerObject(x.object.get("object").?) catch {};
            if (std.mem.eql(u8, t, "kind")) s.defineKind(x) catch {};
            if (std.mem.eql(u8, t, "input")) {
                s.hostInput(x) catch return null;
                s.queued = true;
            }
        }
        return null;
    }

    fn replyEnd(s: *Session, reply: std.json.Value, result: ?[*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        if (reply != .object) return c.TALK_CALL_BROKEN;
        if (reply.object.get("value")) |v| {
            const value = (s.valueOf(v) catch return c.TALK_CALL_BROKEN) orelse return c.TALK_CALL_BROKEN;
            if (result) |r| r.* = value else c.talk_value_release(value);
            return c.TALK_CALL_ANSWERED;
        }
        if (reply.object.get("ok") != null) return c.TALK_CALL_ANSWERED;
        if (reply.object.get("fail")) |f| {
            const code = s.dupe(jsonText(f, "code"));
            const message: ?[]const u8 = if (f.object.get("message")) |m| s.dupe(m.string) else null;
            const data = if (f.object.get("data")) |d| (s.valueOf(d) catch null) else null;
            err.* = .{ .code = code.ptr, .code_len = code.len, .message = if (message) |m| m.ptr else null, .message_len = if (message) |m| m.len else 0, .data = data };
            return c.TALK_CALL_FAILED;
        }
        return c.TALK_CALL_BROKEN;
    }

    /// What a crossing's `selector` is: `at`'s index or `find`'s name.
    const Selector = union(enum) { index: i64, name: []const u8 };

    /// One property or collection callback, as its `property-begin` and
    /// its `prop` need describe it.
    const Crossing = struct {
        kind: []const u8,
        id: []const u8,
        property: []const u8,
        operation: []const u8,
        value: ?*const c.talk_value = null,
        selector: ?Selector = null,
    };

    fn crossingOf(o: ?*c.talk_object, property: []const u8, operation: []const u8) Crossing {
        const object: *const northtalk.machine.objects.Object = @ptrCast(@alignCast(o.?));
        return .{ .kind = object.kind.name, .id = object.id, .property = property, .operation = operation };
    }

    /// A Value's encoding in a crossing: each Function Value as the handle
    /// its last exposure gave it.
    fn writeValue(s: *Session, w: *std.Io.Writer, v: *const c.talk_value) !void {
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v));
        try northtalk.encoding.writeWith(w, value, .{ .context = s, .write = writeFunction });
    }

    fn writeFunction(context: ?*anyopaque, w: *std.Io.Writer, v: *const northtalk.value.Value) northtalk.encoding.Error!void {
        const s: *Session = @ptrCast(@alignCast(context.?));
        const handle = s.supplied.get(@intFromPtr(v)) orelse return error.NotEncodable;
        try w.writeAll("{\"$sessionFunction\":");
        try northtalk.encoding.quoted(w, handle);
        try w.writeAll("}");
    }

    fn writeRef(w: *std.Io.Writer, kind: []const u8, id: []const u8) !void {
        try w.writeAll("{\"id\":");
        try northtalk.encoding.quoted(w, id);
        try w.writeAll(",\"kind\":");
        try northtalk.encoding.quoted(w, kind);
        try w.writeAll("}");
    }

    fn writeSelector(w: *std.Io.Writer, x: Selector) !void {
        switch (x) {
            .index => |i| try w.print("{d}", .{i}),
            .name => |t| try northtalk.encoding.quoted(w, t),
        }
    }

    /// The crossing's `property-begin` envelope, numbered `n`.
    fn beginText(s: *Session, n: u64, x: Crossing) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(s.alloc());
        const w = &out.writer;
        try w.print("{{\"crossing\":{d},\"object\":", .{n});
        try writeRef(w, x.kind, x.id);
        try w.writeAll(",\"operation\":");
        try northtalk.encoding.quoted(w, x.operation);
        try w.writeAll(",\"property\":");
        try northtalk.encoding.quoted(w, x.property);
        if (x.selector) |sel| {
            try w.writeAll(",\"selector\":");
            try writeSelector(w, sel);
        }
        try w.writeAll(",\"type\":\"property-begin\"");
        if (x.value) |v| {
            try w.writeAll(",\"value\":");
            try s.writeValue(w, v);
        }
        try w.writeAll("}");
        return out.written();
    }

    /// The crossing as chapter 9's `prop` need.
    fn needText(s: *Session, x: Crossing) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(s.alloc());
        const w = &out.writer;
        try w.writeAll("{\"m\":\"prop\",\"object\":{\"$object\":[");
        try northtalk.encoding.quoted(w, x.kind);
        try w.writeAll(",");
        try northtalk.encoding.quoted(w, x.id);
        try w.writeAll("]},\"prop\":");
        try northtalk.encoding.quoted(w, x.property);
        if (x.value) |v| {
            try w.writeAll(",\"value\":");
            try s.writeValue(w, v);
        }
        if (x.selector != null or std.mem.eql(u8, x.property, "elements")) {
            try w.writeAll(",\"op\":");
            try northtalk.encoding.quoted(w, x.operation);
        }
        if (x.selector) |sel| {
            try w.writeAll(",\"selector\":");
            try writeSelector(w, sel);
        }
        try w.writeAll("}");
        return out.written();
    }

    /// A replayed callback: the recorded reply to exactly this crossing.
    fn replayed(s: *Session, x: Crossing, result: ?[*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        s.crossed += 1;
        const begin = s.beginText(s.crossed, x) catch return c.TALK_CALL_BROKEN;
        const reply = s.callbackReply(begin) orelse return c.TALK_CALL_BROKEN;
        return s.replyEnd(reply, result, err);
    }

    fn propGet(context: ?*anyopaque, o: ?*c.talk_object, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const info: *PropInfo = @ptrCast(@alignCast(context.?));
        const s = info.session;
        // Live, the Pump pauses here and `answerCrossings` asks the driver.
        if (s.liveObjects()) return c.TALK_CALL_STARTED;
        return s.replayed(crossingOf(o, info.name, "get"), result, err);
    }

    fn propSet(context: ?*anyopaque, o: ?*c.talk_object, v: ?*const c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const info: *PropInfo = @ptrCast(@alignCast(context.?));
        const s = info.session;
        if (s.liveObjects()) return c.TALK_CALL_STARTED;
        // The setter's argument is an exposure, before the callback.
        s.expose(&.{v});
        var x = crossingOf(o, info.name, "set");
        x.value = v;
        return s.replayed(x, null, err);
    }

    /// Each crossing a live Pump paused at (#2276): its `property-begin`,
    /// the driver's answer to its `prop` need, and its `property-end`; then
    /// the Pump goes on, until it ends.
    fn answerCrossings(s: *Session, result: *c.talk_pump_result) !void {
        while (result.state == c.TALK_CROSSING) {
            var pause: c.talk_crossing = undefined;
            if (!c.talk_group_crossing(s.group, &pause)) return error.HostError;
            const operation: []const u8 = switch (pause.op) {
                c.TALK_CROSSING_GET => "get",
                c.TALK_CROSSING_SET => "set",
                c.TALK_CROSSING_COUNT => "count",
                c.TALK_CROSSING_AT => "at",
                else => "find",
            };
            var x = crossingOf(pause.object, pause.prop[0..pause.prop_len], operation);
            switch (pause.op) {
                c.TALK_CROSSING_SET => x.value = pause.value,
                c.TALK_CROSSING_AT => x.selector = .{ .index = pause.index },
                c.TALK_CROSSING_FIND => x.selector = .{ .name = pause.name[0..pause.name_len] },
                else => {},
            }
            // Begun once, though a suspending driver may be asked again.
            const need = s.crossing_need orelse begin: {
                if (x.value) |v| s.expose(&.{v});
                s.crossed += 1;
                s.recordEnvelope(try s.beginText(s.crossed, x));
                const text = try s.needText(x);
                s.crossing_need = text;
                break :begin text;
            };
            const answered = s.driver.prop.?(s.driver.context, need) orelse return s.suspendCall(.crossing);
            s.crossing_need = null;
            const reply = s.parseJson(answered) orelse std.json.Value{ .null = {} };
            const valid = validReply(reply, pause.op == c.TALK_CROSSING_SET);
            var end: std.Io.Writer.Allocating = .init(s.alloc());
            try end.writer.print("{{\"crossing\":{d},\"reply\":", .{s.crossed});
            if (valid) try std.json.Stringify.value(reply, .{}, &end.writer) else try end.writer.writeAll("{\"hostError\":true}");
            try end.writer.writeAll(",\"type\":\"property-end\"}");
            s.recordEnvelope(end.written());
            var value: ?*c.talk_value = null;
            var err = std.mem.zeroes(c.talk_script_error);
            const ended: c.talk_call_end = if (valid) s.replyEnd(reply, if (pause.op == c.TALK_CROSSING_SET) null else &value, &err) else c.TALK_CALL_BROKEN;
            try check_(c.talk_crossing_answer(s.group, ended, value, &err, result));
        }
    }

    /// Whether `reply` is exactly one `prop-result` alternative a Get (or a
    /// collection call) or a Set may give.
    fn validReply(reply: std.json.Value, set: bool) bool {
        if (reply != .object or reply.object.count() != 1) return false;
        if (reply.object.get("value") != null) return !set;
        if (reply.object.get("ok")) |x| return set and x == .bool and x.bool;
        if (reply.object.get("hostError")) |x| return x == .bool and x.bool;
        const f = reply.object.get("fail") orelse return false;
        if (f != .object) return false;
        const code = f.object.get("code") orelse return false;
        if (code != .string) return false;
        var it = f.object.iterator();
        while (it.next()) |e| {
            const k = e.key_ptr.*;
            if (std.mem.eql(u8, k, "message")) {
                if (e.value_ptr.* != .string) return false;
            } else if (!std.mem.eql(u8, k, "code") and !std.mem.eql(u8, k, "data")) return false;
        }
        return true;
    }

    fn liveObjects(s: *const Session) bool {
        return s.driver.prop != null;
    }

    fn recordEnvelope(s: *Session, envelope: []const u8) void {
        if (s.driver.record) |f| f(s.driver.context, envelope);
    }

    /// An object's rows: its kind, id and whether it is disposed, then each
    /// declared property in name order.
    fn objectRows(s: *Session, v: ?*const c.talk_value) void {
        var o: ?*c.talk_object = null;
        if (!c.talk_value_as_object(s.group, v, &o)) return;
        const object: *const northtalk.machine.objects.Object = @ptrCast(@alignCast(o.?));
        s.sayf("object {{kind: {s}, id: {s}, disposed: {}}}", .{ s.textShown(object.kind.name), s.textShown(object.id), object.disposed });
        const info = s.kinds.get(object.kind.name) orelse return;
        const props = s.alloc().dupe(PropInfo, info.props) catch return;
        std.mem.sort(PropInfo, props, {}, struct {
            fn less(_: void, x: PropInfo, y: PropInfo) bool {
                return std.mem.order(u8, x.name, y.name) == .lt;
            }
        }.less);
        for (props) |p| {
            var shape: ?*c.talk_value = null;
            const shown_shape = if (c.talk_decode_value(p.shape.ptr, p.shape.len, null, null, &shape) == c.TALK_OK) blk: {
                defer c.talk_value_release(shape);
                break :blk s.display(shape);
            } else s.textShown(p.shape);
            const set = if (p.read_only) "nothing" else s.print("{{fuel: {d}, alloc: {d}}}", .{ p.set[0], p.set[1] });
            s.sayf("property {{name: {s}, shape: {s}, readOnly: {}, getCost: {{fuel: {d}, alloc: {d}}}, setCost: {s}}}", .{ s.textShown(p.name), shown_shape, p.read_only, p.get[0], p.get[1], set });
        }
    }

    /// `:inspect`'s second Run: the normative reader, extended under the
    /// first free `entry<n>` and requested with the object and its readable
    /// property names in order.
    fn readProperties(s: *Session, v: ?*c.talk_value) !void {
        var o: ?*c.talk_object = null;
        if (!c.talk_value_as_object(s.group, v, &o)) return;
        const object: *const northtalk.machine.objects.Object = @ptrCast(@alignCast(o.?));
        const info = s.kinds.get(object.kind.name) orelse return;
        var names: std.ArrayList([]const u8) = .empty;
        for (info.props) |p| try names.append(s.alloc(), p.name);
        std.mem.sort([]const u8, names.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.order(u8, x, y) == .lt;
            }
        }.less);
        var n = s.next_entry;
        while (true) : (n += 1) {
            const stem = s.print("entry{d}", .{n});
            const words = [_][]const u8{ "", "Object", "Names", "Name", "Row", "Error", "Clean", "Key" };
            const taken = for (words) |w| {
                const id = s.print("{s}{s}", .{ stem, w });
                if (s.hasName(id) or s.handlerStarting(id)) break true;
            } else false;
            if (!taken) break;
        }
        const stem = s.print("entry{d}", .{n});
        var source: std.ArrayList(u8) = .empty;
        var rest: []const u8 = reader_template;
        while (std.mem.indexOf(u8, rest, "entry0")) |at| {
            try source.appendSlice(s.alloc(), rest[0..at]);
            try source.appendSlice(s.alloc(), stem);
            rest = rest[at + "entry0".len ..];
        }
        try source.appendSlice(s.alloc(), rest);
        if (c.talk_script_extend(s.script, source.items.ptr, source.items.len) != c.TALK_OK) return;
        s.extensions += 1;
        s.harvest();
        s.next_entry = n + 1;
        const selector = s.print("{s}:to:", .{stem});
        var name_values: std.ArrayList(?*c.talk_value) = .empty;
        defer for (name_values.items) |x| c.talk_value_release(x);
        for (names.items) |x| {
            var t: ?*c.talk_value = null;
            try check_(c.talk_text(x.ptr, x.len, &t));
            try name_values.append(s.alloc(), t);
        }
        var list: ?*c.talk_value = null;
        try check_(c.talk_list(@ptrCast(name_values.items.ptr), name_values.items.len, &list));
        defer c.talk_value_release(list);
        const args = [_]?*c.talk_value{ v, list };
        var override = s.limitOverride();
        const message: c.talk_message = .{ .name = selector.ptr, .name_len = selector.len, .args = @ptrCast(&args), .args_len = 2, .limits = if (override.set != 0) &override else null };
        var id: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        var pending: ?*c.talk_pending = null;
        try check_(c.talk_script_request(s.script, &message, &id, &pending));
        const delivery = s.dupe(id.data[0..id.len]);
        c.talk_owned_bytes_release(&id);
        s.foreground = .{ .delivery = delivery, .entry = n, .expression = false };
        if (!try s.pump()) return;
        try s.foregroundLoop();
    }
};

fn hostErrorName(code: c.talk_host_error_code) []const u8 {
    return switch (code) {
        c.TALK_CLOCK_BACKWARDS => "clock backwards",
        c.TALK_PARENT_CYCLE => "parent cycle",
        c.TALK_DUPLICATE_OBJECT_ID => "duplicate object id",
        c.TALK_NAME_REUSED => "name reused",
        c.TALK_REENTRANT_CALL => "reentrant call",
        c.TALK_WRONG_GROUP => "wrong group",
        c.TALK_LIBRARY_MISMATCH => "library mismatch",
        c.TALK_RESERVED_NAME => "reserved name",
        c.TALK_NOT_ADOPTABLE => "not adoptable",
        c.TALK_INVALID_VALUE => "invalid value",
        c.TALK_INVALID_SAVE => "invalid save",
        c.TALK_SAVE_MISMATCH => "save mismatch",
        c.TALK_UNKNOWN_CALL => "unknown call",
        c.TALK_STATE_TOO_LARGE => "state too large",
        c.TALK_EFFECTS_PENDING => "effects pending",
        c.TALK_EFFECT_STATE_UNKNOWN => "effect state unknown",
        c.TALK_INVALID_CHECKPOINT => "invalid checkpoint",
        c.TALK_ERR_MAILBOX_FULL => "mailbox full",
        else => "host error",
    };
}

fn check_(code: c.talk_host_error_code) !void {
    if (code != c.TALK_OK) return error.HostError;
}

/// A `key=value` field of a Trace record, the value up to the next space
/// outside quotes or brackets.
fn field(line: []const u8, key: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (std.mem.indexOfPos(u8, line, i, key)) |at| {
        i = at + 1;
        if (at > 0 and line[at - 1] != ' ') continue;
        if (at + key.len >= line.len or line[at + key.len] != '=') continue;
        const start = at + key.len + 1;
        var depth: i32 = 0;
        var quoted = false;
        var j = start;
        while (j < line.len) : (j += 1) {
            const ch = line[j];
            if (quoted) {
                if (ch == '"') quoted = false;
                continue;
            }
            switch (ch) {
                '"' => quoted = true,
                '[', '{', '(' => depth += 1,
                ']', '}', ')' => depth -= 1,
                ' ' => if (depth == 0) break,
                else => {},
            }
        }
        return line[start..j];
    }
    return null;
}

test "an Entry is complete when its syntax doesn't end early" {
    // `complete` reads only the allocator and the session source's
    // declarations.
    var s: Session = undefined;
    s.gpa = std.testing.allocator;
    s.decls = .empty;
    const waits = [_][]const u8{ "on greet name", "on greet name\n  say \"hi \" & name", "put [1,", "--| Docs.", "say \"\"\"\n  fenced", "say `a ${1 +", ":inspect {a:", ":fuel put [1," };
    for (waits) |t| try std.testing.expect(!try s.complete(t));
    const whole = [_][]const u8{ "on greet name\n  say \"hi \" & name\nend greet", "1 + 2", ":vars", ":library add x lib.talk", "say \"abc", "1 2", ":inspect 1\n2", "put [1, 2] into xs" };
    for (whole) |t| try std.testing.expect(try s.complete(t));
}

/// A Session with only what valueOf needs: the arena and Function handles.
fn testSession(a: Allocator) Session {
    var s: Session = undefined;
    s.gpa = a;
    s.arena = .init(a);
    s.handles = .empty;
    return s;
}

/// A Function Value registered under handle `f1`.
fn testFunction(s: *Session, a: Allocator) !*northtalk.value.Value {
    const captures = try northtalk.value.map(a, &.{});
    defer captures.release();
    const function = try northtalk.value.function(a, "session", "<function f>", 1, captures);
    errdefer function.release();
    try s.handles.put(s.alloc(), "f1", @ptrCast(function));
    return function;
}

fn deepSessionValue() !void {
    const a = std.testing.allocator;
    var s = testSession(a);
    defer s.arena.deinit();
    const function = try testFunction(&s, a);
    defer function.release();

    const parsed = try std.json.parseFromSlice(std.json.Value, s.alloc(),
        \\[{"$sessionFunction":"f1"}, null, "text", [], {}]
    , .{});
    var json = parsed.value;
    const depth = 100_000;
    for (0..depth) |i| {
        if (i % 2 == 0) {
            var object: std.json.ObjectMap = .{};
            try object.put(s.alloc(), "x", json);
            json = .{ .object = object };
        } else {
            var array: std.json.Array = .init(s.alloc());
            try array.append(json);
            json = .{ .array = array };
        }
    }
    const out = (try s.valueOf(json)) orelse return error.TestUnexpectedResult;
    defer c.talk_value_release(out);
    var value: *const northtalk.value.Value = @ptrCast(@alignCast(out));
    var left: usize = depth;
    while (left > 0) {
        left -= 1;
        if (left % 2 == 0) {
            try std.testing.expect(value.data == .map);
            try std.testing.expectEqual(@as(usize, 1), value.data.map.len);
            try std.testing.expectEqualStrings("x", value.data.map.at(0).key);
            value = value.data.map.at(0).value;
        } else {
            try std.testing.expect(value.data == .list);
            try std.testing.expectEqual(@as(usize, 1), value.data.list.len);
            value = value.data.list[0];
        }
    }
    try std.testing.expect(value.data == .list);
    const items = value.data.list;
    try std.testing.expectEqual(@as(usize, 5), items.len);
    try std.testing.expect(items[0] == function);
    try std.testing.expect(items[1].data == .nothing);
    try std.testing.expectEqualStrings("text", items[2].data.text);
    try std.testing.expectEqual(@as(usize, 0), items[3].data.list.len);
    try std.testing.expectEqual(@as(usize, 0), items[4].data.map.len);
}

test "a crossing Value nested 100,000 deep resolves Function handles on a small stack" {
    var result: anyerror!void = {};
    const t = try std.Thread.spawn(.{ .stack_size = 256 * 1024 }, struct {
        fn go(out: *anyerror!void) void {
            out.* = deepSessionValue();
        }
    }.go, .{&result});
    t.join();
    try result;
}

fn sessionHandleAllocations(a: Allocator, scenario: enum { value, unknown, arguments }) !void {
    var s = testSession(a);
    defer s.arena.deinit();
    // Keep the Function on the testing allocator so every decoder failure
    // must release the references it resolved before running out of memory.
    const function = try testFunction(&s, std.testing.allocator);
    defer function.release();
    const parsed = try std.json.parseFromSlice(std.json.Value, s.alloc(), if (scenario == .unknown)
        \\[{"x":[{"$sessionFunction":"f1"},null]}, {"$sessionFunction":"missing"}]
    else
        \\[{"x":[{"$sessionFunction":"f1"},null]}, {"$sessionFunction":"f1"}, {"$map":[["$sessionFunction","literal"],["a\"b",true]]}]
    , .{});
    if (scenario == .arguments) {
        const args = try s.argsOf(parsed.value);
        defer for (args) |v| c.talk_value_release(v);
        const first: *const northtalk.value.Value = @ptrCast(@alignCast(args[0].?));
        try std.testing.expect(first.data.map.at(0).value.data.list[0] == function);
        try std.testing.expect(args[1] == @as(*c.talk_value, @ptrCast(function)));
        return;
    }
    const maybe = try s.valueOf(parsed.value);
    defer c.talk_value_release(maybe);
    if (scenario == .unknown) {
        try std.testing.expect(maybe == null);
        try std.testing.expectEqual(@as(usize, 1), function.references);
        return;
    }
    const out = maybe orelse return error.TestUnexpectedResult;
    const value: *const northtalk.value.Value = @ptrCast(@alignCast(out));
    const items = value.data.list;
    try std.testing.expect(items[0].data.map.at(0).value.data.list[0] == function);
    try std.testing.expect(items[1] == function);
    try std.testing.expectEqualStrings("$sessionFunction", items[2].data.map.at(0).key);
    try std.testing.expectEqualStrings("literal", items[2].data.map.at(0).value.data.text);
    try std.testing.expectEqualStrings("a\"b", items[2].data.map.at(1).key);
    try std.testing.expect(items[2].data.map.at(1).value.data.bool);
}

test "Session handle decoding releases completed children after every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, sessionHandleAllocations, .{.value});
}

test "an unresolved Session handle releases children even under allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, sessionHandleAllocations, .{.unknown});
}

test "crossing arguments release earlier Values after every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, sessionHandleAllocations, .{.arguments});
}

test "crossing text beginning with a control-character prefix stays text" {
    const a = std.testing.allocator;
    var s = testSession(a);
    defer s.arena.deinit();
    const function = try testFunction(&s, a);
    defer function.release();
    const parsed = try std.json.parseFromSlice(std.json.Value, s.alloc(),
        \\["\u0001session-function:missing", "\u0001session-function:f1", {"$sessionFunction":"f1"}]
    , .{});
    const out = (try s.valueOf(parsed.value)) orelse return error.TestUnexpectedResult;
    defer c.talk_value_release(out);
    const value: *const northtalk.value.Value = @ptrCast(@alignCast(out));
    try std.testing.expectEqualStrings("\u{1}session-function:missing", value.data.list[0].data.text);
    try std.testing.expectEqualStrings("\u{1}session-function:f1", value.data.list[1].data.text);
    try std.testing.expect(value.data.list[2] == function);
}

test "crossing Values retain exact number spelling and envelope costs" {
    const a = std.testing.allocator;
    var s = testSession(a);
    defer s.arena.deinit();
    const text =
        \\[-9007199254740991,9007199254740991,{"$dec":"9007199254740993"}]
    ;
    const json = s.parseJson(text) orelse return error.TestUnexpectedResult;
    const out = (try s.valueOf(json)) orelse return error.TestUnexpectedResult;
    defer c.talk_value_release(out);
    var encoded: c.talk_owned_bytes = .{};
    try std.testing.expect(c.talk_encode_value(out, &encoded) == c.TALK_OK);
    defer c.talk_owned_bytes_release(&encoded);
    try std.testing.expectEqualStrings(text, encoded.data[0..encoded.len]);
    const costs = s.parseJson(
        \\{"fuel":42,"alloc":"9007199254740993"}
    ) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual([2]i64{ 42, 9007199254740993 }, Session.costOf(costs));
    for ([_][]const u8{
        "1.0", "1e0", "9007199254740993",
        \\{"$sessionFunction":1}
        ,
        \\{"$sessionFunction":null}
        ,
        \\{"$sessionFunction":[]}
        ,
        \\{"$sessionFunction":"missing"}
        ,
    }) |invalid| {
        const value = s.parseJson(invalid) orelse return error.TestUnexpectedResult;
        try std.testing.expect((try s.valueOf(value)) == null);
    }
}

//! The Session Host (chapter 12): an ordinary Host, over talk.h, that turns
//! Entries and Session Commands into Host Inputs to a Group named `session`
//! holding one Script, `session`, and prints what chapter 12 says. It follows
//! its Runs through their reports and its Group's Trace, never `Inspect()`,
//! and asks a Driver for everything from outside: Clock readings, typed
//! lines, prompt answers, and where its output and Trace go. A REPL drives it
//! live; the corpus runner drives it from a Session Transcript.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const transcript = @import("transcript.zig");
const store = @import("store.zig");
/// The normative `:inspect` reader (session-observation.md).
const reader_template = northtalk.analysis.inspect_reader;

const Allocator = std.mem.Allocator;
const parser = northtalk.syntax.parser;
const lexer = northtalk.syntax.lexer;
const ast = northtalk.syntax.ast;
const check = northtalk.check;
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
    /// A file `:export <directory>` writes; false if it can't.
    write: *const fn (context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) bool,
    /// The next recorded object crossing envelope here, or null.
    crossing: *const fn (context: *anyopaque) ?[]const u8,
    /// Consumes the crossing `crossing` gave.
    take: *const fn (context: *anyopaque) void,
    /// Under a real Clock, waits until the foreground's next deadline, before
    /// the Pump for it; a replay's readings come from the Transcript.
    sleep: *const fn (context: *anyopaque, until: Instant) void,
};

const Mode = enum { immediate, suspending, fire_and_forget };

/// A mock Operation, with its queued Stubs.
const Mock = struct {
    session: *Session,
    capability: []const u8,
    operation: []const u8,
    mode: Mode,
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
const PendingCall = struct { id: []const u8, run: []const u8, kind: PendingKind, call: ?*c.talk_call, mock: ?*Mock = null };

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
    /// A Restore's recorded resolver outcomes.
    resolved: ?[]const std.json.Value = null,

    const ObjectRef = struct { kind: []const u8, id: []const u8 };
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
        for (s.out.items) |line| s.driver.output(s.driver.context, line);
        s.out.clearRetainingCapacity();
        for (s.trace_out.items) |line| s.driver.output(s.driver.context, line);
        s.trace_out.clearRetainingCapacity();
        // Fuel rows: once after the Host call that started a measurement,
        // and again when one settles later.
        for (s.observing.measurements.items) |*m| {
            if (m.started or (m.settled and !m.final)) {
                s.driver.output(s.driver.context, s.fuelRow(m));
                if (m.settled) m.final = true;
            }
            m.started = false;
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
        const load: c.talk_load_options = .{ .name = "session", .name_len = 7, .source = "", .source_len = 0, .grants = s.loaded.items.ptr, .grants_len = s.loaded.items.len, .grants_as_used = false, .owner = null, .objects = bound.items.ptr, .objects_len = bound.items.len, .limits = null };
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
        } else if (std.mem.eql(u8, capability, "user")) {
            const costs = [_]c.talk_named_cost{ .{ .name = "confirm", .name_len = 7, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "choose", .name_len = 6, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "enter", .name_len = 5, .cost = .{ .fuel = 0, .alloc = 0 } }, .{ .name = "notify", .name_len = 6, .cost = .{ .fuel = 0, .alloc = 0 } } };
            const impl: c.talk_user_impl = .{ .context = s, .confirm = userPrompt, .choose = userPrompt, .enter = userPrompt, .notify = userNotify };
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
                });
            };
            try check_(c.talk_define_capability(s.core, capability.ptr, capability.len, ops.items.ptr, ops.items.len, null, 0, &def));
        }
        try s.defs.put(s.alloc(), s.dupe(capability), def.?);
        return def.?;
    }

    // ------------------------------------------------------------ Host functions

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
        return c.TALK_CALL_STARTED;
    }

    /// A user prompt: one at a time, so another while one waits is `user
    /// busy`; otherwise answered now if the driver has the answer, or it
    /// waits for the person.
    fn userPrompt(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = args;
        _ = len;
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
        s.pending.append(s.alloc(), .{ .id = s.dupe(id), .run = s.dupe(callRun(call)), .kind = .prompt, .call = call }) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_STARTED;
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
        defer c.talk_reports_release(result.reports);
        s.last = at;
        if (code != c.TALK_OK) return error.HostError;
        s.deadlineOf(result);
        s.follow(result.reports);
        try s.notifications(at);
        return result.state;
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
    fn notifications(s: *Session, at: Instant) !void {
        while (true) {
            const pending = c.talk_router_pumped(s.router, s.group);
            _ = pending;
            if (!s.admitted) return;
            s.admitted = false;
            s.trace_lines.clearRetainingCapacity();
            var result: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
            const code = c.talk_pump(s.group, at.seconds, at.micros, null, &result);
            defer c.talk_reports_release(result.reports);
            if (code != c.TALK_OK) return error.HostError;
            s.deadlineOf(result);
            s.follow(result.reports);
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
                    s.objectRows(x.result);
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
            if (s.pendingOf(run)) |i| {
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
            // A deadline under a real Clock: sleep to it, and pump.
            if (s.clock == .real) if (s.waits.get(run)) |w| if (w.until or s.pendingOf(run) != null) {
                if (s.next_deadline) |until| s.driver.sleep(s.driver.context, until);
                if (!try s.pump()) return;
                continue;
            };
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
        s.foreground = null;
        s.flush();
        if (s.queued) {
            s.queued = false;
            if (try s.pump()) s.flush();
        }
    }

    /// A Pump the Session Host makes at a deadline, as a Transcript's `@`
    /// line outside any other Host call records.
    pub fn deadline(s: *Session, at: Instant) !void {
        try s.start();
        try s.pumpAt(at);
        try s.endCall();
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
                const r = try parser.parseEntryEnd(ta, rest, true);
                return ended(rest, r.failure, r.trailing);
            }
            if (std.mem.eql(u8, name, ":fuel")) return s.complete(rest);
            return true;
        }
        // A `--|` block waits for the declaration it documents.
        const lines = try splitLines(ta, trimmed);
        var i: usize = 0;
        while (i < lines.len and (std.mem.startsWith(u8, std.mem.trimStart(u8, lines[i], " \t"), "--|") or std.mem.trim(u8, lines[i], " \t").len == 0)) i += 1;
        if (i == lines.len) return false;
        const w = firstWords(lines[i]);
        if (isDeclaration(w)) return switch (try parser.parse(ta, trimmed)) {
            .tree => true,
            .failure => |d| ended(trimmed, d, false),
        };
        const statement = s.isStatement(w);
        const r = try parser.parseEntryEnd(ta, trimmed, !statement);
        return ended(trimmed, r.failure, r.trailing);
    }

    /// Whether a parse leaves nothing to wait for: it succeeded, or failed
    /// before the end of the source and not inside a fenced literal or hole.
    fn ended(text: []const u8, failure: ?parser.Diagnostic, trailing: bool) bool {
        return analysis.ended(text, failure orelse return true, trailing);
    }

    /// Gives the session one Entry or Session Command, with the `|` lines a
    /// Transcript records after it.
    pub fn submit(s: *Session, input: transcript.Input) !void {
        if (input.first.len > 0 and input.first[0] == ':') {
            try s.command(input);
        } else {
            try s.start();
            try s.entry(input);
        }
        try s.endCall();
    }

    // ------------------------------------------------------------ Entries

    const statement_words = [_][]const u8{ "if", "repeat", "match", "try", "wait", "tell", "put", "let", "set", "add", "subtract", "multiply", "divide", "delete", "send", "ask", "return", "veto", "pass", "exit", "throw", "replace" };
    const declaration_words = [_][]const u8{ "on", "function", "private", "use", "constant" };

    fn entryText(input: transcript.Input, ea: Allocator) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        try out.appendSlice(ea, input.first);
        for (input.more) |l| {
            try out.append(ea, '\n');
            try out.appendSlice(ea, l);
        }
        return out.items;
    }

    /// The first word of an Entry, after any leading `--|` lines.
    fn firstWords(text: []const u8) struct { first: []const u8, second: []const u8, doc: bool } {
        var lines = std.mem.splitScalar(u8, text, '\n');
        var doc = false;
        while (lines.next()) |l| {
            const t = std.mem.trimStart(u8, l, " \t");
            if (std.mem.startsWith(u8, t, "--|")) {
                doc = true;
                continue;
            }
            var words = std.mem.tokenizeAny(u8, t, " \t(");
            const first = words.next() orelse "";
            const second = words.next() orelse "";
            return .{ .first = first, .second = second, .doc = doc };
        }
        return .{ .first = "", .second = "", .doc = doc };
    }

    fn isOneOf(w: []const u8, words: []const []const u8) bool {
        for (words) |x| if (std.mem.eql(u8, x, w)) return true;
        return false;
    }

    fn isDeclaration(w: anytype) bool {
        return isOneOf(w.first, &declaration_words) or (std.mem.eql(u8, w.first, "script") and std.mem.eql(u8, w.second, "variable"));
    }

    fn entry(s: *Session, input: transcript.Input) !void {
        const text = try entryText(input, s.alloc());
        // What decides the Entry: its first line after any `--|` block.
        var deciding = text;
        // A leading `--|` block documents the declaration straight after it.
        // A blank line detaches it; before anything else it is refused.
        const lines = try splitLines(s.alloc(), text);
        var i: usize = 0;
        while (i < lines.len and std.mem.startsWith(u8, std.mem.trimStart(u8, lines[i], " \t"), "--|")) i += 1;
        if (i > 0) {
            if (i == lines.len) return s.say("! bad arguments");
            if (std.mem.trim(u8, lines[i], " \t").len == 0) {
                while (i < lines.len and std.mem.trim(u8, lines[i], " \t").len == 0) i += 1;
                if (i == lines.len) return s.say("! bad arguments");
                deciding = try std.mem.join(s.alloc(), "\n", lines[i..]);
            } else {
                const w = firstWords(lines[i]);
                if (!isDeclaration(w) or std.mem.eql(u8, w.first, "use")) return s.say("! bad arguments");
                return s.declaration(text);
            }
        }
        const w = firstWords(deciding);
        if (isDeclaration(w)) return s.declaration(text);
        const statement = s.isStatement(w);
        _ = try s.runEntry(text, !statement);
    }

    /// `:inspect <expression>`: one expression, run as an ordinary Entry,
    /// whose value is described in rows rather than echoed.
    fn inspectExpression(s: *Session, rest: []const u8, more: []const []const u8) !void {
        var text: std.ArrayList(u8) = .empty;
        try text.appendSlice(s.alloc(), rest);
        for (more) |l| {
            try text.append(s.alloc(), '\n');
            try text.appendSlice(s.alloc(), l);
        }
        if (std.mem.trim(u8, text.items, " \t\n").len == 0) return s.say("! bad arguments");
        const w = firstWords(text.items);
        if (w.doc or isDeclaration(w) or isOneOf(w.first, &statement_words) or w.first[0] == ':') return s.say("! bad arguments");
        // Trailing input after the expression is refused.
        var arena: std.heap.ArenaAllocator = .init(s.gpa);
        defer arena.deinit();
        if ((try parser.parseEntryEnd(arena.allocator(), text.items, true)).trailing) return s.say("! bad arguments");
        _ = try s.runAs(text.items, true, true);
    }

    /// Whether an Entry is a statement, by its first words, rather than an
    /// expression (chapter 2, Entries).
    fn isStatement(s: *Session, w: anytype) bool {
        return isOneOf(w.first, &statement_words) or
            (std.mem.eql(u8, w.first, "with") and std.mem.eql(u8, w.second, "timeout")) or
            (std.mem.eql(u8, w.first, "choose") and std.mem.eql(u8, w.second, "offer")) or
            (std.mem.eql(u8, w.first, "next") and std.mem.eql(u8, w.second, "repeat")) or
            std.mem.eql(u8, w.first, "say") or s.handlerStarting(w.first);
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
        // Its syntax, on its own: the end of the Entry ends its last line.
        if (try parser.parseEntry(ta, text, expression)) |d| {
            var lines = try lexer.Lines.init(ta, text);
            const at = lines.position(d.offset);
            s.sayf("! {s} at {d}:{d}", .{ d.code.spelling(), at.line, at.column });
            return .refused;
        }
        // The names it binds that become Script Variables.
        const roots = try s.implicitNames(ta, text, expression);
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
        if (s.reader) |v| {
            s.reader = null;
            defer c.talk_value_release(v);
            try s.readProperties(v);
        }
        return .ran;
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

    /// The names an Entry binds as a Container's root or a Capture, that
    /// the Script doesn't have: checked against its Script Variables and
    /// Constants, as the Core will check the extension.
    fn implicitNames(s: *Session, ta: Allocator, text: []const u8, expression: bool) ![]const []const u8 {
        var bound: std.ArrayList([]const u8) = .empty;
        for (s.decls.items) |d| switch (d.kind) {
            .variable, .constant => try bound.append(ta, d.names[0]),
            else => {},
        };
        return analysis.implicitNames(ta, text, expression, bound.items);
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

    /// A parsed declaration's kind and names, and for `use` and `script
    /// variable` what the session source needs.
    fn describeDecl(s: *Session, tree: *const ast.Tree, d: ast.Declaration, text: []const u8) !Decl {
        const sa = s.alloc();
        switch (d.data) {
            .handler => |h| {
                if (h.fallback) return .{ .text = text, .kind = .fallback, .names = try sa.dupe([]const u8, &.{"any message"}) };
                var selector: std.ArrayList(u8) = .empty;
                try selector.appendSlice(sa, tree.text(h.name));
                if (h.labels.len > 0) {
                    try selector.append(sa, ':');
                    for (h.labels) |l| try selector.print(sa, "{s}:", .{tree.text(l)});
                }
                return .{ .text = text, .kind = .handler, .names = try sa.dupe([]const u8, &.{selector.items}), .word = s.dupe(tree.text(h.name)) };
            },
            .function => |f| return .{ .text = text, .kind = .function, .names = try sa.dupe([]const u8, &.{s.dupe(tree.text(f.name))}) },
            .constant => |k| return .{ .text = text, .kind = .constant, .names = try sa.dupe([]const u8, &.{s.dupe(tree.text(k.name))}) },
            .script_variable => |v| {
                var initialiser: ?[]const u8 = null;
                if (v.value != null) {
                    // The text after `=`.
                    var t = v.name + 1;
                    while (t < tree.tokens.len and tree.tokens[t].kind != .equal) t += 1;
                    if (t < tree.tokens.len) initialiser = s.dupe(text[tree.tokens[t].end..]);
                }
                return .{ .text = text, .kind = .variable, .names = try sa.dupe([]const u8, &.{s.dupe(tree.text(v.name))}), .init = initialiser };
            },
            .use => |u| {
                var imported: std.ArrayList([]const u8) = .empty;
                for (u.names) |n| try imported.append(sa, s.dupe(tree.text(n)));
                const rename: ?[]const u8 = if (u.rename) |r| s.dupe(tree.text(r)) else null;
                const names = if (rename) |r| try sa.dupe([]const u8, &.{r}) else imported.items;
                return .{ .text = text, .kind = .use, .names = names, .use = .{ .names = imported.items, .library = s.dupe(tree.text(u.library)), .rename = rename } };
            },
        }
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
        const tree = switch (try parser.parse(ta, text)) {
            .tree => |t| t,
            .failure => |d| {
                var lines = try lexer.Lines.init(ta, text);
                const at = lines.position(d.offset);
                s.sayf("! {s} at {d}:{d}", .{ d.code.spelling(), at.line, at.column });
                return;
            },
        };
        if (tree.declarations.len != 1) {
            s.say("! bad arguments");
            return;
        }
        const decl = try s.describeDecl(&tree, tree.declarations[0], s.dupe(text));
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
        const builtin = std.mem.eql(u8, capability, "user") or is_store;
        if (!mocked and !builtin) return s.say("! bad arguments");
        // Only `calendar`, `locale` and `store` take a binding.
        if (args.len == 3 and !is_store) return s.say("! bad arguments");
        if (s.started) return s.say("! session started");
        const binding: ?[]const u8 = if (is_store) (if (args.len == 3) s.dupe(args[2]) else "default") else null;
        try s.grants.append(s.alloc(), .{ .name = s.dupe(args[0]), .capability = s.dupe(capability), .binding = binding });
    }

    fn mockCommand(s: *Session, args: []const []const u8) !void {
        if (args.len != 2) return s.say("! bad arguments");
        const dot = std.mem.indexOfScalar(u8, args[0], '.') orelse return s.say("! bad arguments");
        const capability = args[0][0..dot];
        const operation = args[0][dot + 1 ..];
        if (capability.len == 0 or operation.len == 0) return s.say("! bad arguments");
        if (isOneOf(capability, &reserved_capabilities)) return s.say("! bad arguments");
        const mode: Mode = if (std.mem.eql(u8, args[1], "immediate")) .immediate else if (std.mem.eql(u8, args[1], "suspending")) .suspending else if (std.mem.eql(u8, args[1], "fire-and-forget")) .fire_and_forget else return s.say("! bad arguments");
        if (s.started) return s.say("! session started");
        const m = try s.alloc().create(Mock);
        m.* = .{ .session = s, .capability = s.dupe(capability), .operation = s.dupe(operation), .mode = mode };
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
    /// the display form.
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
        while (e < 0) : (e += 1) {
            if (@mod(n, 10) != 0) return null;
            n = @divExact(n, 10);
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
        const view = for (inspection.?.scripts[0..inspection.?.scripts_len]) |*v| {
            if (std.mem.eql(u8, v.name[0..v.name_len], "session")) break v;
        } else return;
        if (std.mem.eql(u8, name, ":vars")) {
            for (view.vars[0..view.vars_len]) |p| s.sayf("{s} = {s}", .{ p.key[0..p.key_len], s.display(p.value) });
            return;
        }
        if (std.mem.eql(u8, name, ":runs")) {
            for (view.runs[0..view.runs_len]) |r| {
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
            }
            return;
        }
        for (view.mailbox[0..view.mailbox_len]) |m| {
            var shown: std.ArrayList(u8) = .empty;
            try shown.append(s.alloc(), '[');
            for (m.message.args[0..m.message.args_len], 0..) |v, i| {
                if (i > 0) try shown.appendSlice(s.alloc(), ", ");
                try shown.appendSlice(s.alloc(), s.display(v));
            }
            try shown.append(s.alloc(), ']');
            const who = if (m.delivery_len > 0) m.delivery[0..m.delivery_len] else m.from[0..m.from_len];
            s.sayf("{s} {s} {s}", .{ who, m.message.name[0..m.message.name_len], shown.items });
        }
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
        const options: c.talk_restore_options = .{ .name = "session", .name_len = 7, .trace = traceSink, .trace_context = s, .libraries = @ptrCast(libraries.items.ptr), .libraries_len = libraries.items.len, .grants = rebind, .grants_context = s, .resolve = restoreResolve, .resolve_context = s, .mismatch = c.TALK_REJECT_MISMATCH, .allocator = null, .memory_cap = 0 };
        var group: ?*c.talk_group = null;
        var result: ?*c.talk_restore_result = null;
        var routing: ?*c.talk_routing_result = null;
        s.trace_lines.clearRetainingCapacity();
        s.admitted = false;
        s.resolved = null;
        const code = c.talk_router_restore(s.router, s.core, saved.bytes.ptr, saved.bytes.len, &options, &group, &result, &routing);
        if (code != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(code)});
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
        if (std.mem.eql(u8, args[0], "load")) {
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
        if (args.len < 2 or args.len > 3) return s.say("! bad arguments");
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
        if (!s.driver.write(s.driver.context, dir, file, json.items)) return s.say("! bad arguments");
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
        const code = c.talk_compile_library(s.core, &src, @ptrCast(imports.items.ptr), imports.items.len, null, 0, &library, &refused);
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
            const replaced = c.talk_replace_library(s.group, library, c.TALK_CARRY_VARIABLES, &reports);
            defer c.talk_reports_release(reports);
            if (replaced != c.TALK_OK) return s.sayf("! {s}", .{hostErrorName(replaced)});
            s.follow(reports);
        }
        try s.libraries.put(s.alloc(), s.dupe(name), .{ .source = source, .library = library.? });
        s.harvestLibrary(library, name, source);
        s.harvest();
    }

    fn exportCommand(s: *Session, args: []const []const u8) !void {
        if (args.len > 1) return s.say("! bad arguments");
        const source = s.sessionSource(s.decls.items);
        if (args.len == 0) {
            var lines = std.mem.splitScalar(u8, std.mem.trimEnd(u8, source, "\n"), '\n');
            if (source.len > 0) while (lines.next()) |l| s.say(l);
            return;
        }
        if (!s.driver.write(s.driver.context, args[0], "session.talk", source)) return s.say("! bad arguments");
        s.say("wrote session.talk");
        for (s.libraries.keys(), s.libraries.values()) |name, l| {
            const file = s.print("{s}.talk", .{name});
            if (!s.driver.write(s.driver.context, args[0], file, l.source)) return s.say("! bad arguments");
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
        const tree = switch (try parser.parse(ta, source)) {
            .tree => |t| t,
            .failure => |d| {
                var at_lines = try lexer.Lines.init(ta, source);
                const at = at_lines.position(d.offset);
                return s.sayf("! {s} at {d}:{d}", .{ d.code.spelling(), at.line, at.column });
            },
        };
        if (tree.declarations.len == 0) return s.say("! bad arguments");
        const run = args[0];
        if (!std.mem.startsWith(u8, run, "session/") or !s.isLive(run)) return s.say("! no such run");
        // Each declaration's lines: from the line after the last one's last
        // line, without the blank lines at their start, to its own last.
        var decls: std.ArrayList(Decl) = .empty;
        var file_lines = try lexer.Lines.init(ta, source);
        var from: usize = 0;
        for (0..tree.declarations.len) |i| {
            const next_first: usize = if (i + 1 < tree.declarations.len) firstToken(tree.declarations[i + 1]) else tree.tokens.len - 1;
            var last = next_first - 1;
            while (last > 0 and tree.tokens[last].kind == .newline) last -= 1;
            const last_line = file_lines.position(tree.tokens[last].start).line;
            var start_line = from + 1;
            while (start_line <= last_line and std.mem.trim(u8, lines[start_line - 1], " \t").len == 0) start_line += 1;
            var text: std.ArrayList(u8) = .empty;
            for (lines[start_line - 1 .. last_line], 0..) |l, k| {
                if (k > 0) try text.append(s.alloc(), '\n');
                try text.appendSlice(s.alloc(), l);
            }
            from = last_line;
            const one = switch (try parser.parse(ta, text.items)) {
                .tree => |t| t,
                .failure => return s.say("! bad arguments"),
            };
            try decls.append(ta, try s.describeDecl(&one, one.declarations[0], text.items));
        }
        // The Rewind.
        try check_(c.talk_script_rewind_run(s.script, run.ptr, run.len));
        const at = s.readingFor() orelse return;
        if (try s.pumpState(at) != c.TALK_REWOUND) return s.say("! not rewindable");
        s.sayf("! rewound {s}", .{run});
        // The Reload, with each declaration in the session source as a
        // redefinition or a new name would put it.
        const saved = try s.alloc().dupe(Decl, s.decls.items);
        for (decls.items) |d| {
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

    fn firstToken(d: ast.Declaration) usize {
        if (d.private) |p| return p;
        return switch (d.data) {
            .handler => |h| h.on,
            .function => |f| f.keyword,
            .constant => |k| k.keyword,
            .script_variable => |v| v.keyword,
            .use => |u| u.keyword,
        };
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
        for (northtalk.generated.stdlib_sources.sources) |src| if (std.mem.eql(u8, src.name, name)) return src.source;
        return null;
    }

    fn librarySourceByIdentity(s: *Session, unit: [32]u8) ?UnitSource {
        if (s.sources.get(unit)) |u| return u;
        for (northtalk.generated.stdlib_sources.sources) |src| {
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

    fn splitLines(ta: Allocator, source: []const u8) ![]const []const u8 {
        var out: std.ArrayList([]const u8) = .empty;
        var it = std.mem.splitScalar(u8, source, '\n');
        while (it.next()) |l| try out.append(ta, std.mem.trimEnd(u8, l, "\r"));
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
        for (northtalk.generated.stdlib.stdlib.builtin) |b| if (std.mem.eql(u8, b.name, name)) return .{ .name = b.name, .call = b.call, .gives = b.gives };
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
        for (northtalk.generated.stdlib.stdlib.builtin) |b| {
            const available = !seen.contains(b.name);
            try found.append(s.alloc(), .{ .name = b.name, .rank = 1, .library = "", .line = s.print("name {{target: {s}, origin: \"builtin\", available: {}, import: nothing}}", .{ s.targetShown(null, b.name, "builtin"), available }), .docs = try s.alloc().dupe([]const u8, &.{s.print("doc {s}", .{s.textShown(b.gives)})}) });
        }
        // Every registered Library's public exports, imported or not.
        var libs: std.ArrayList([]const u8) = .empty;
        for (northtalk.generated.stdlib_sources.sources) |src| try libs.append(s.alloc(), src.name);
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

    /// A value's display form, an error map's Core-written `message` left
    /// out, since its wording is outside parity.
    fn withoutCoreMessage(s: *Session, v: ?*const c.talk_value) []const u8 {
        const value: *const northtalk.value.Value = @ptrCast(@alignCast(v.?));
        if (value.data != .map or !value.core_message) return s.display(v);
        var pairs: std.ArrayList(c.talk_pair) = .empty;
        var i: usize = 0;
        var pair: c.talk_pair = undefined;
        while (c.talk_value_entries(v, i, &pair)) : (i += 1) {
            if (std.mem.eql(u8, pair.key[0..pair.key_len], "message")) continue;
            pairs.append(s.alloc(), pair) catch {};
        }
        var shown: ?*c.talk_value = null;
        if (c.talk_map(pairs.items.ptr, pairs.items.len, &shown) != c.TALK_OK) return s.display(v);
        defer c.talk_value_release(shown);
        return s.display(shown);
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
            c.TALK_COMPLETED => s.print("\"completed\", result: {s}}}", .{s.display(x.result)}),
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
        if (text.len == 0) return false;
        if (std.mem.indexOfScalar(u8, text, ':') == null) return isName(text);
        if (text[text.len - 1] != ':') return false;
        var parts = std.mem.splitScalar(u8, text[0 .. text.len - 1], ':');
        var n: usize = 0;
        while (parts.next()) |p| {
            if (!isName(p)) return false;
            n += 1;
        }
        return n >= 2;
    }

    fn isName(w: []const u8) bool {
        if (w.len == 0) return false;
        for (w, 0..) |ch, i| {
            const ok = std.ascii.isAlphabetic(ch) or ch == '_' or ch >= 0x80 or (i > 0 and std.ascii.isDigit(ch));
            if (!ok) return false;
        }
        return true;
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
        var text: std.ArrayList(u8) = .empty;
        try text.appendSlice(s.alloc(), rest);
        for (more) |l| {
            try text.append(s.alloc(), '\n');
            try text.appendSlice(s.alloc(), l);
        }
        const w = firstWords(text.items);
        if (w.doc or isDeclaration(w) or (w.first.len > 0 and w.first[0] == ':')) return s.say("! bad arguments");
        const statement = s.isStatement(w);
        s.measuring = true;
        defer s.measuring = false;
        _ = try s.runEntry(text.items, !statement);
    }
    // ------------------------------------------------------------ object crossings

    /// A recorded Object Kind: its handle, and each property's declaration
    /// as the Transcript gives it.
    const KindInfo = struct { name: []const u8, kind: *c.talk_object_kind, props: []PropInfo };
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
            try s.hostInput(v.object.get("request").?);
            return;
        }
        return error.MalformedTranscript;
    }

    fn shapeOf(s: *Session, shape: std.json.Value) !*const c.talk_shape {
        _ = s;
        if (shape == .string) {
            const names = [_]struct { []const u8, *const fn () callconv(.c) ?*const c.talk_shape }{
                .{ "any", c.talk_any_shape },               .{ "value", c.talk_value_shape },     .{ "nothing", c.talk_nothing_shape },
                .{ "boolean", c.talk_bool_shape },          .{ "number", c.talk_number_shape },   .{ "text", c.talk_text_shape },
                .{ "bytes", c.talk_bytes_shape },           .{ "instant", c.talk_instant_shape }, .{ "range", c.talk_range_shape },
                .{ "civil date", c.talk_civil_date_shape }, .{ "pattern", c.talk_pattern_shape }, .{ "function", c.talk_function_shape },
            };
            for (names) |n| if (std.mem.eql(u8, n[0], shape.string)) return n[1]().?;
        }
        return c.talk_any_shape().?;
    }

    fn defineKind(s: *Session, v: std.json.Value) !void {
        const name = s.dupe(jsonText(v, "name"));
        const props_json = v.object.get("props").?.array.items;
        const infos = try s.alloc().alloc(PropInfo, props_json.len);
        const props = try s.alloc().alloc(c.talk_prop, props_json.len);
        for (props_json, infos, props) |p, *info, *prop| {
            const read_only = if (p.object.get("readOnly")) |r| r == .bool and r.bool else true;
            const shape_value = p.object.get("shape") orelse std.json.Value{ .string = "any" };
            var shape_text: std.Io.Writer.Allocating = .init(s.alloc());
            try std.json.Stringify.value(shape_value, .{}, &shape_text.writer);
            info.* = .{ .name = s.dupe(jsonText(p, "name")), .shape = shape_text.written(), .read_only = read_only, .get = costOf(p.object.get("getCost")), .set = costOf(p.object.get("setCost")), .session = s, .kind = name };
            prop.* = .{
                .name = info.name.ptr,
                .name_len = info.name.len,
                .shape = try s.shapeOf(shape_value),
                .get = propGet,
                .set = if (read_only) null else propSet,
                .context = info,
                .get_cost = .{ .fuel = info.get[0], .alloc = info.get[1] },
                .set_cost = .{ .fuel = info.set[0], .alloc = info.set[1] },
            };
        }
        const def: c.talk_object_kind_def = .{ .name = name.ptr, .name_len = name.len, .props = props.ptr, .props_len = props.len, .parent_kinds = null, .parent_kinds_lens = null, .parent_kinds_len = 0 };
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
        if (s.resolved == null) {
            const record = s.peekCrossing() orelse return false;
            if (!std.mem.eql(u8, jsonText(record, "type"), "resolve")) return false;
            s.takeCrossing();
            s.resolved = record.object.get("objects").?.array.items;
        }
        for (s.resolved.?) |r| {
            const o = r.object.get("object").?;
            if (!std.mem.eql(u8, jsonText(o, "kind"), kind[0..kind_len]) or !std.mem.eql(u8, jsonText(o, "id"), id[0..id_len])) continue;
            const yes = r.object.get("resolved").?;
            if (yes != .bool or !yes.bool) return false;
            native.* = @ptrFromInt(1);
            return true;
        }
        return false;
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

    /// A Value exposure: each Function Value leaf, depth first, binds the
    /// handle its recorded `function` envelope names.
    fn expose(s: *Session, values: []const ?*const c.talk_value) void {
        for (values) |v| s.exposeOne(v orelse continue);
    }

    fn exposeOne(s: *Session, maybe: ?*const c.talk_value) void {
        const root = maybe orelse return;
        // Depth first and in order, from a heap work list: children are
        // pushed last first.
        var stack: std.ArrayList(*const northtalk.value.Value) = .empty;
        stack.append(s.alloc(), @ptrCast(@alignCast(root))) catch return;
        while (stack.pop()) |value| switch (value.data) {
            .function => {
                const record = s.peekCrossing() orelse continue;
                if (!std.mem.eql(u8, jsonText(record, "type"), "function")) continue;
                s.takeCrossing();
                const v: *c.talk_value = @ptrCast(@constCast(value));
                c.talk_value_retain(v);
                s.handles.put(s.alloc(), s.dupe(jsonText(record, "handle")), v) catch {};
            },
            .list => |items| {
                var i = items.len;
                while (i > 0) {
                    i -= 1;
                    stack.append(s.alloc(), items[i]) catch return;
                }
            },
            .map => |pairs| {
                var i = pairs.len;
                while (i > 0) {
                    i -= 1;
                    stack.append(s.alloc(), pairs.at(i).value) catch return;
                }
            },
            else => {},
        };
    }

    /// A report's Values, as one exposure.
    fn exposeReport(s: *Session, r: c.talk_report) void {
        switch (r.kind) {
            c.TALK_REPORT_RUN_STARTED => {
                const x = r.as.run_started;
                s.exposeOne(x.function);
                for (x.args[0..x.args_len]) |a| s.exposeOne(a);
            },
            c.TALK_REPORT_RUN_END => {
                const x = r.as.run_end;
                s.exposeOne(x.result);
                if (x.@"error") |e| s.exposeOne(e.*.data);
            },
            c.TALK_REPORT_UNHANDLED => for (r.as.unhandled.args[0..r.as.unhandled.args_len]) |a| s.exposeOne(a),
            else => {},
        }
    }

    /// A Host action an external Host made, or one a property callback made
    /// while it ran, which its Pump drains.
    fn hostInput(s: *Session, request: std.json.Value) !void {
        const kind = jsonText(request, "kind");
        const g = s.group orelse return;
        if (std.mem.eql(u8, kind, "set-parent")) {
            const o = try s.objectRef(request.object.get("object").?) orelse return;
            const parent = if (request.object.get("parent")) |p| try s.objectRef(p) else null;
            _ = c.talk_set_parent(g, o, parent);
        } else if (std.mem.eql(u8, kind, "dispose")) {
            const o = try s.objectRef(request.object.get("object").?) orelse return;
            _ = c.talk_dispose(g, o);
        } else if (std.mem.eql(u8, kind, "deliver")) {
            const message = request.object.get("message").?;
            const name = jsonText(message, "name");
            const args = try s.argsOf(message.object.get("args"));
            const m: c.talk_message = .{ .name = name.ptr, .name_len = name.len, .args = @ptrCast(args.ptr), .args_len = args.len, .limits = null };
            const to = request.object.get("to").?;
            if (to.object.get("script")) |script| {
                const target = c.talk_group_script(g, script.string.ptr, script.string.len) orelse return;
                _ = c.talk_script_deliver(target, &m, null);
            } else if (try s.objectRef(to.object.get("object") orelse return)) |o| {
                _ = c.talk_deliver(g, o, &m, null);
            }
            for (args) |a| c.talk_value_release(a);
        } else if (std.mem.eql(u8, kind, "call")) {
            const fn_value = try s.valueOf(request.object.get("fn").?) orelse return;
            defer c.talk_value_release(fn_value);
            const args = try s.argsOf(request.object.get("args"));
            defer for (args) |a| c.talk_value_release(a);
            var pending: ?*c.talk_pending = null;
            _ = c.talk_group_call(g, fn_value, @ptrCast(args.ptr), args.len, null, null, &pending);
            if (pending) |p| c.talk_pending_release(p);
        }
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
    /// it registered and actions it made, then its reply.
    fn callbackReply(s: *Session) ?std.json.Value {
        const begin = s.peekCrossing() orelse return null;
        if (!std.mem.eql(u8, jsonText(begin, "type"), "property-begin")) return null;
        s.takeCrossing();
        while (s.peekCrossing()) |x| {
            const t = jsonText(x, "type");
            s.takeCrossing();
            if (std.mem.eql(u8, t, "property-end")) return x.object.get("reply");
            if (std.mem.eql(u8, t, "object")) s.registerObject(x.object.get("object").?) catch {};
            if (std.mem.eql(u8, t, "kind")) s.defineKind(x) catch {};
            if (std.mem.eql(u8, t, "input")) {
                s.hostInput(x.object.get("request").?) catch {};
                s.queued = true;
            }
        }
        return null;
    }

    fn replyEnd(s: *Session, reply: std.json.Value, result: ?[*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
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

    fn propGet(context: ?*anyopaque, o: ?*c.talk_object, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = o;
        const info: *PropInfo = @ptrCast(@alignCast(context.?));
        const s = info.session;
        const reply = s.callbackReply() orelse return c.TALK_CALL_BROKEN;
        return s.replyEnd(reply, result, err);
    }

    fn propSet(context: ?*anyopaque, o: ?*c.talk_object, v: ?*const c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = o;
        const info: *PropInfo = @ptrCast(@alignCast(context.?));
        const s = info.session;
        // The setter's argument is an exposure, before the callback.
        s.expose(&.{v});
        const reply = s.callbackReply() orelse return c.TALK_CALL_BROKEN;
        return s.replyEnd(reply, null, err);
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

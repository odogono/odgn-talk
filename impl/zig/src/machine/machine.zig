//! The Abstract Machine of chapter 8, step 1's part of it: a Group of
//! Scripts, each with its code unit and Script Variables, Deliveries and
//! Requests drained by a Pump, Handler dispatch, and a run loop over lowered
//! code that charges Fuel and allocation by Cost Model 0 at every instruction
//! and writes the Trace. Frames live on the heap, so the run loop never
//! recurses on Script-controlled depth.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const display = @import("../display.zig");
const unicode = @import("../unicode/unicode.zig");
const lower = @import("../lower/lower.zig");
const check = @import("../check/check.zig");
const parser = @import("../syntax/parser.zig");
const lexer = @import("../syntax/lexer.zig");
const ast = @import("../syntax/ast.zig");
const chunks = @import("chunks.zig");
const costs = @import("costs.zig");
const builtins = @import("builtins.zig");
const binary = @import("binary.zig");
const conversions = @import("convert.zig");
const matcher = @import("matcher.zig");
const units = @import("../units.zig");
pub const capabilities = @import("capabilities.zig");
const machine_table = @import("../generated/machine.zig").machine;
const version = @import("../generated/version.zig").version;
const cost_model = @import("../generated/costs.zig").costs;
const Opcode = @import("../generated/opcodes.zig").Opcode;
const Value = model.Value;

/// Something on a frame's operand stack: a Script value, or one of the
/// internal values only instructions see.
/// A Timeout Block's deadline, in nanoseconds, and its duration in ms.
pub const Deadline = struct { at: i128, ms: u64 };

pub const Slot = union(enum) {
    value: *Value,
    iterator: *Iterator,
    reader: *binary.Reader,
    replacement: *Replacement,
    /// A Timeout Block's deadline, below the block's body.
    deadline: Deadline,

    fn release(self: Slot, gpa: Allocator) void {
        switch (self) {
            .value => |v| v.release(),
            .iterator => |it| {
                it.references -= 1;
                if (it.references > 0) return;
                if (it.subject) |s| s.release();
                gpa.destroy(it);
            },
            .reader => |r| {
                r.references -= 1;
                if (r.references > 0) return;
                r.subject.release();
                gpa.destroy(r);
            },
            .replacement => |r| {
                r.references -= 1;
                if (r.references > 0) return;
                r.text.release();
                r.matches.release();
                gpa.free(r.spans);
                r.pieces.deinit(gpa);
                gpa.destroy(r);
            },
            .deadline => {},
        }
    }
};

/// `replace`'s state (chapter 8): the text, its Matches, the next one, and
/// the pieces so far.
pub const Replacement = struct {
    references: usize = 1,
    text: *Value,
    /// The list of Matches.
    matches: *Value,
    /// Each Match's byte offsets in the text.
    spans: [][2]usize,
    next: usize = 0,
    /// Where the text not yet copied starts, in bytes.
    position: usize = 0,
    pieces: std.ArrayList(u8) = .empty,
};

/// A list or range snapshot and a position, or a count left.
pub const Iterator = struct {
    /// A dispatch activation's copy of the owner's prefix shares it.
    references: usize = 1,
    subject: ?*Value,
    position: usize = 0,
    left: u64 = 0,
};

pub const Frame = struct {
    body: u32,
    pc: u32,
    locals: []*Value,
    stack: std.ArrayList(Slot) = .empty,
};

pub const Delivery = struct {
    id: u64,
    message: []const u8,
    args: []*Value,
    request: bool,
    /// For an `error` message: the message the failed Run was handling, as
    /// `{name, args}`, which `, during` binds.
    during: ?*Value = null,
    /// The Run that sent the message, or for a `send … and wait` its call
    /// id; for an `error` message, the Run that errored.
    from: ?[]const u8 = null,
    /// An `error` message the Core sends a Script about its own Run.
    internal_error: bool = false,
    /// A `send … and wait`, whose sender waits on the call `from`.
    waits: bool = false,
};

pub const Run = struct {
    id: []const u8,
    script: *Script,
    frames: std.ArrayList(Frame) = .empty,
    fuel: u64 = 0,
    alloc: u64 = 0,
    delivery: Delivery,
    handler: []const u8 = "",
    clause: u32 = 0,
    /// The error being unwound, with the `finally` blocks still to run.
    unwinding: ?Unwinding = null,
    /// Capability calls made, which number their ids.
    calls: u32 = 0,
    /// The Fuel and allocation when its current Segment began.
    segment_fuel: u64 = 0,
    segment_alloc: u64 = 0,
    /// Whether its first Segment has been written.
    started: bool = false,
    /// What it waits on while suspended.
    waiting: ?*Pending = null,
    /// What it resumes with once ready.
    resume_with: ?Resume = null,
    /// The Suspension Point it is suspended at, as `seg … end=` writes it.
    suspended_at: []const u8 = "",
    /// Once ready, what it waited on.
    waited: Waited = .{},
    /// The Join it is in, from `join-start` to its closing `end`.
    join: ?*Join = null,
    /// The frame count at which running stops: 0, or while a pending
    /// `wait for`'s test body runs, the frames below it.
    base: usize = 0,
};

/// A Join's members, in start order.
pub const Join = struct {
    members: std.ArrayList(Member) = .empty,
};

pub const Member = struct {
    /// What it waits on, until it settles.
    pending: ?*Pending,
    waited: Waited,
    /// How it settled, once it has.
    with: ?Resume = null,
};

/// What a ready Run waited on, which its resume names.
pub const Waited = struct {
    id: []const u8 = "",
    block: bool = false,
    call: ?*capabilities.Call = null,
    grant: []const u8 = "",
    operation: []const u8 = "",
    decl: ?*const capabilities.Operation = null,
    after_ms: u64 = 0,
};

/// A Run's settled wait, which it resumes with.
pub const Resume = union(enum) {
    /// An answer, and any cost that came with it.
    answer: struct { value: *Value, fuel: u64 },
    /// A `Fail` with a Script error.
    failed: Failure,
    /// A failure that wasn't a Script error.
    broken,
    /// Its deadline passed.
    timeout,
    /// A `wait` ran out.
    woke,
    /// The reply to a `send … and wait`.
    reply: *Value,
    /// A `wait for` that fired: the message, or Nothing for a timeout or
    /// an `after`, and the branch's number.
    event: struct { message: ?*Value, branch: u32, binds: u32 = 0 },
    /// A `send … and wait` that got no reply, and why.
    send_failed: struct { reason: []const u8, err: ?*Value },
    /// Every member of its Join answered.
    joined,
    /// A member of its Join failed first: its index, from 0.
    join_failed: usize,
};

pub const Failure = struct { code: []const u8, message: ?[]const u8, data: ?*Value };

/// A suspended Run's wait, with its deadline in nanoseconds: a suspending
/// Capability call or a `wait`.
pub const Pending = struct {
    /// A `send … and wait`'s call id; a Capability call's is its Call's.
    id: []const u8 = "",
    run: *Run,
    deadline: i128,
    /// Of equal deadlines, the earlier set fires first.
    order: u64,
    call: ?*capabilities.Call = null,
    grant: []const u8 = "",
    operation: []const u8 = "",
    decl: ?*const capabilities.Operation = null,
    after_ms: u64 = 0,
    /// For a Join Member, its index among the Join's members.
    member: ?usize = null,
    /// Whether the deadline is a Timeout Block's, whose `after` it is.
    block: bool = false,
    /// A `wait for`'s branches, and the number of the `after` branch, or 0
    /// for `or d`, that its deadline fires.
    event: ?*EventWait = null,
    branch: u32 = 0,
};

/// A pending `wait for` (chapter 8, The event table): its entry, and what
/// each branch popped.
pub const EventWait = struct {
    entry: u32,
    branches: []EventBranch,
    /// Whether it is the block form, which pushes the branch's number.
    any: bool,
};

/// A `when` branch's `from` and captured values, or an `after` branch's
/// deadline.
pub const EventBranch = union(enum) {
    when: struct { from: ?*Value, captures: []*Value },
    after: i128,
};

/// No deadline: a `wait for` that can wait for ever.
const never: i128 = std.math.maxInt(i128);

/// A Script's work: a message for dispatch, or a Run ready to resume.
pub const Work = union(enum) { message: Delivery, run: *Run };

/// An accepted catch: its frame, where it goes on, and its dispatch
/// activation's stack, which becomes the frame's.
pub const Accept = struct { frame: usize, pc: u32, stack: std.ArrayList(Slot) };

pub const Cleanup = struct { frame: usize, target: u32, depth: u32 };

pub const Then = union(enum) { accept: Accept, end };

pub const Unwinding = struct {
    err: *Value,
    cleanups: std.ArrayList(Cleanup),
    next: usize = 0,
    then: Then,
};

pub const Script = struct {
    name: []const u8,
    identity: [32]u8,
    /// The arena that owns the source, tree and code unit.
    arena: std.heap.ArenaAllocator,
    unit: lower.Unit,
    variables: []*Value,
    definitions: []*Value,
    /// Its work, in the order each became ready.
    work: std.ArrayList(Work) = .empty,
    /// Its Runs that are suspended or ready, which its state counts.
    live: std.ArrayList(*Run) = .empty,
    runs: u64 = 0,
    /// The Script's Grants, by the name it uses, with the Operations it
    /// keeps.
    grants: []ScriptGrant = &.{},

    fn grant(s: *const Script, name: []const u8) ?ScriptGrant {
        for (s.grants) |g| if (std.mem.eql(u8, g.name, name)) return g;
        return null;
    }
};

/// A Grant the Host binds at Load, by the name the Script uses.
pub const NamedGrant = struct { name: []const u8, grant: *capabilities.Grant };

/// A Script's Grant: the Operations it keeps, by index into its
/// Capability's.
pub const ScriptGrant = struct { name: []const u8, grant: *capabilities.Grant, kept: []bool };

/// What a Script is loaded with.
pub const LoadOptions = struct {
    context: check.Context = .{},
    /// The Grants, which also give the checker its view of them.
    grants: ?[]const NamedGrant = null,
    /// Keep only the granted Operations the Script uses.
    grants_as_used: bool = false,
};

pub const LoadResult = union(enum) {
    loaded: *Script,
    /// The diagnostics, as `diag` records were written.
    refused: usize,
};

const Input = union(enum) {
    deliver: struct { script: []const u8, delivery: Delivery },
    /// An answer or failure for a suspending call, by its id.
    settle: struct { id: []const u8, with: Resume },
};

pub const Group = struct {
    gpa: Allocator,
    scripts: std.ArrayList(*Script) = .empty,
    inputs: std.ArrayList(Input) = .empty,
    deliveries: u64 = 0,
    trace: ?*std.Io.Writer,
    /// Reusable scratch memory for a single instruction.
    scratch: std.heap.ArenaAllocator,
    /// The Fuel of the Pump in progress.
    pump_fuel: u64 = 0,
    /// Request results by delivery id, for the Host.
    results: std.AutoHashMapUnmanaged(u64, *Value) = .empty,
    /// The error an instruction raised, until the run loop takes it.
    pending_error: ?*Value = null,
    /// Whether the Core raised it, so it gets a `message`.
    pending_core: bool = false,
    /// The last Pump's Clock reading, which a Capability call reads.
    clock: model.dates.Instant = .{ .seconds = 0, .nanos = 0 },
    /// The waits with deadlines, and how many have been set.
    pending: std.ArrayList(*Pending) = .empty,
    timers: u64 = 0,
    /// Suspending calls, which the Host may answer until the Group ends.
    calls: std.ArrayList(*capabilities.Call) = .empty,
    /// The call ids of `send … and wait`, which waits and records name.
    ids: std.ArrayList([]u8) = .empty,

    pub fn init(gpa: Allocator, trace: ?*std.Io.Writer) Group {
        return .{ .gpa = gpa, .trace = trace, .scratch = .init(gpa) };
    }

    pub fn deinit(g: *Group) void {
        for (g.inputs.items) |input| switch (input) {
            .deliver => |d| {
                releaseAll(d.delivery.args, g.gpa);
                g.gpa.free(d.script);
                g.gpa.free(d.delivery.message);
            },
            .settle => |x| {
                g.gpa.free(x.id);
                g.releaseResume(x.with);
            },
        };
        g.inputs.deinit(g.gpa);
        for (g.calls.items) |c| {
            g.gpa.free(c.id);
            g.gpa.destroy(c);
        }
        g.calls.deinit(g.gpa);
        for (g.ids.items) |id| g.gpa.free(id);
        g.ids.deinit(g.gpa);
        for (g.scripts.items) |s| {
            for (s.variables) |v| v.release();
            g.gpa.free(s.variables);
            for (s.definitions) |v| v.release();
            g.gpa.free(s.definitions);
            for (s.work.items) |w| switch (w) {
                .message => |d| g.releaseDelivery(d),
                .run => {},
            };
            s.work.deinit(g.gpa);
            for (s.live.items) |r| g.destroyRun(r);
            s.live.deinit(g.gpa);
            for (s.unit.values) |v| if (v == .value) v.value.release();
            s.arena.deinit();
            g.gpa.destroy(s);
        }
        g.scripts.deinit(g.gpa);
        // A live Run removed its own wait; any left belongs to none.
        for (g.pending.items) |p| g.destroyPending(p);
        g.pending.deinit(g.gpa);
        var it = g.results.valueIterator();
        while (it.next()) |v| v.*.release();
        g.results.deinit(g.gpa);
        g.scratch.deinit();
    }

    fn write(g: *Group, comptime fmt: []const u8, args: anytype) void {
        const w = g.trace orelse return;
        w.print(fmt, args) catch {};
    }

    /// Loads a Script: parses, checks and lowers it, and runs its
    /// initialiser. Writes the `load` record and any `diag` records.
    pub fn load(g: *Group, name: []const u8, source: []const u8, options: LoadOptions) !LoadResult {
        const s = try g.gpa.create(Script);
        s.* = .{ .name = undefined, .identity = codeIdentity(name, source), .arena = .init(g.gpa), .unit = undefined, .variables = &.{}, .definitions = &.{} };
        const a = s.arena.allocator();
        s.name = try a.dupe(u8, name);
        const src = try a.dupe(u8, source);
        g.write("> load {s} identity={x}\n", .{ name, s.identity });
        var lines: lexer.Lines = try .init(a, src);
        const parsed = try parser.parse(a, src);
        const tree = switch (parsed) {
            .failure => |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ name, d.code.spelling(), p.line, p.column });
                s.arena.deinit();
                g.gpa.destroy(s);
                return .{ .refused = 1 };
            },
            .tree => |t| t,
        };
        const t = try a.create(ast.Tree);
        t.* = tree;
        var context = options.context;
        if (options.grants) |named| {
            const viewed = try a.alloc(check.Grant, named.len);
            for (named, viewed) |n, *v| v.* = .{ .name = try a.dupe(u8, n.name), .operations = try capabilities.checkOperations(a, n.grant) };
            context.grants = viewed;
        }
        const checked = try check.check(a, t, context);
        if (checked.diagnostics.len > 0) {
            for (checked.diagnostics) |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ name, d.code.spelling(), p.line, p.column });
            }
            s.arena.deinit();
            g.gpa.destroy(s);
            return .{ .refused = checked.diagnostics.len };
        }
        s.unit = try lower.lower(a, t, &checked, .{ .name = s.name, .context = context, .values = g.gpa });
        if (options.grants) |named| s.grants = try keptGrants(a, named, &s.unit, options.grants_as_used);
        s.variables = try g.gpa.alloc(*Value, s.unit.variables.len);
        for (s.variables) |*v| v.* = try nothing(g.gpa);
        s.definitions = try g.gpa.alloc(*Value, s.unit.definitions.len);
        for (s.definitions) |*v| v.* = try nothing(g.gpa);
        try g.scripts.append(g.gpa, s);
        // The initialiser runs once, uncharged.
        var run: Run = .{ .id = "", .script = s, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
        defer run.frames.deinit(g.gpa);
        try g.pushFrame(&run, 0, &.{});
        switch (try g.execute(&run, false)) {
            .returned, .errored => |v| v.release(),
            else => {},
        }
        return .{ .loaded = s };
    }

    fn script(g: *Group, name: []const u8) ?*Script {
        for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, name)) return s;
        return null;
    }

    /// Queues a Delivery to the Script `to`. Takes the arguments.
    pub fn deliver(g: *Group, to: []const u8, message: []const u8, args: []*Value, request: bool) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        try g.inputs.append(g.gpa, .{ .deliver = .{ .script = try g.gpa.dupe(u8, to), .delivery = .{ .id = id, .message = try g.gpa.dupe(u8, message), .args = try g.gpa.dupe(*Value, args), .request = request } } });
        return id;
    }

    /// Queues an answer or failure for the suspending call `id`. Takes it.
    pub fn settle(g: *Group, id: []const u8, with: Resume) !void {
        try g.inputs.append(g.gpa, .{ .settle = .{ .id = try g.gpa.dupe(u8, id), .with = with } });
    }

    fn releaseResume(g: *Group, with: Resume) void {
        switch (with) {
            .answer => |x| x.value.release(),
            .failed => |f| {
                g.gpa.free(f.code);
                if (f.message) |m| g.gpa.free(m);
                if (f.data) |d| d.release();
            },
            .reply => |v| v.release(),
            .send_failed => |x| if (x.err) |e| e.release(),
            .event => |x| if (x.message) |v| v.release(),
            else => {},
        }
    }

    fn releaseDelivery(g: *Group, d: Delivery) void {
        releaseAll(d.args, g.gpa);
        g.gpa.free(d.message);
        if (d.during) |x| x.release();
        if (d.from) |x| g.gpa.free(x);
    }

    fn destroyPending(g: *Group, p: *Pending) void {
        if (p.event) |e| {
            for (e.branches) |b| switch (b) {
                .when => |x| {
                    if (x.from) |v| v.release();
                    releaseAll(x.captures, g.gpa);
                },
                .after => {},
            };
            g.gpa.free(e.branches);
            g.gpa.destroy(e);
        }
        g.gpa.destroy(p);
    }

    fn destroyRun(g: *Group, run: *Run) void {
        if (run.waiting) |p| {
            for (g.pending.items, 0..) |x, i| if (x == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            g.destroyPending(p);
        }
        if (run.resume_with) |r| g.releaseResume(r);
        g.dropJoin(run);
        while (run.frames.items.len > 0) g.popFrame(run);
        run.frames.deinit(g.gpa);
        g.releaseDelivery(run.delivery);
        g.gpa.free(run.id);
        g.gpa.destroy(run);
    }

    /// Writes a queued Host Input as the Trace's `>` line.
    fn writeInput(g: *Group, input: Input) void {
        const out = g.trace orelse return;
        switch (input) {
            .deliver => |d| {
                out.print("> {s} d{d} to={s} message={s}", .{ if (d.delivery.request) "request" else "deliver", d.delivery.id, d.script, d.delivery.message }) catch {};
                if (d.delivery.args.len > 0) {
                    out.writeAll(" args=[") catch {};
                    for (d.delivery.args, 0..) |v, i| {
                        if (i > 0) out.writeAll(", ") catch {};
                        display.writeTrace(out, v) catch {};
                    }
                    out.writeAll("]") catch {};
                }
            },
            .settle => |x| switch (x.with) {
                .answer => |a| {
                    out.print("> answer {s} value=", .{x.id}) catch {};
                    display.writeTrace(out, a.value) catch {};
                    if (a.fuel > 0) out.print(" fuel={d}", .{a.fuel}) catch {};
                },
                .failed => |f| {
                    out.print("> fail {s} error=", .{x.id}) catch {};
                    const shown = failureMap(g.gpa, f) catch null;
                    defer if (shown) |v| v.release();
                    if (shown) |v| display.writeTrace(out, v) catch {};
                },
                else => out.print("> fail {s} error={{}}", .{x.id}) catch {},
            },
        }
        out.writeAll("\n") catch {};
    }

    /// A Pump: the queued inputs are written and drained, due timers fire,
    /// then Scripts take turns until none has work.
    pub fn pump(g: *Group, clock: model.dates.Instant) !void {
        g.clock = clock;
        for (g.inputs.items) |input| g.writeInput(input);
        const shown = try model.dates.string(g.scratch.allocator(), model.dates.fields(clock), true);
        g.write("> pump clock={s}\n", .{shown});
        g.pump_fuel = 0;
        for (g.inputs.items) |input| switch (input) {
            .deliver => |d| {
                defer g.gpa.free(d.script);
                const s = g.script(d.script) orelse {
                    g.releaseDelivery(d.delivery);
                    continue;
                };
                try s.work.append(g.gpa, .{ .message = d.delivery });
            },
            .settle => |x| {
                defer g.gpa.free(x.id);
                const index = for (g.pending.items, 0..) |p, i| {
                    if (p.call) |c| if (std.mem.eql(u8, c.id, x.id)) break i;
                } else null;
                const i = index orelse {
                    // Its Run no longer waits on it: recorded and ignored.
                    g.write("note {s} kind=late-answer\n", .{x.id});
                    g.releaseResume(x.with);
                    continue;
                };
                const p = g.pending.orderedRemove(i);
                try g.ready(p, x.with);
            },
        };
        g.inputs.clearRetainingCapacity();
        // Due timers, in deadline order, then the order they were set.
        const now = nanos(clock);
        while (true) {
            var first: ?usize = null;
            for (g.pending.items, 0..) |p, i| {
                if (p.deadline > now) continue;
                if (first == null or p.deadline < g.pending.items[first.?].deadline or (p.deadline == g.pending.items[first.?].deadline and p.order < g.pending.items[first.?].order)) first = i;
            }
            const i = first orelse break;
            const p = g.pending.orderedRemove(i);
            const with: Resume = if (p.call != null or p.id.len > 0 or p.block) .timeout else if (p.event != null) .{ .event = .{ .message = null, .branch = p.branch } } else .woke;
            try g.ready(p, with);
        }
        // Turns: each Script with work, in load order, round and round.
        var busy = true;
        while (busy) {
            busy = false;
            for (g.scripts.items) |s| {
                if (s.work.items.len == 0) continue;
                busy = true;
                switch (s.work.orderedRemove(0)) {
                    .message => |d| {
                        try g.observe(s, d);
                        try g.startRun(s, d);
                    },
                    .run => |r| try g.resumeRun(s, r),
                }
            }
        }
        g.write("pumped state=idle fuel={d}", .{g.pump_fuel});
        if (g.next()) |deadline| {
            const at: model.dates.Instant = .{ .seconds = @intCast(@divFloor(deadline, std.time.ns_per_s)), .nanos = @intCast(@mod(deadline, std.time.ns_per_s)) };
            const text = try model.dates.string(g.scratch.allocator(), model.dates.fields(at), true);
            g.write(" next={s}", .{text});
        }
        g.write("\n", .{});
    }

    /// The earliest deadline still pending.
    fn next(g: *Group) ?i128 {
        var best: ?i128 = null;
        for (g.pending.items) |p| if (p.deadline != never and (best == null or p.deadline < best.?)) {
            best = p.deadline;
        };
        return best;
    }

    /// A settled wait: its Run becomes ready, at the back of its Script's
    /// work.
    fn ready(g: *Group, p: *Pending, with: Resume) !void {
        const run = p.run;
        if (p.member) |index| {
            // A Join Member: the Run is ready when every member has
            // answered, or when the first fails.
            defer g.destroyPending(p);
            const join = run.join.?;
            const member = &join.members.items[index];
            member.pending = null;
            member.with = with;
            const failed = switch (with) {
                .answer, .reply => false,
                else => true,
            };
            const waiting_at_end = std.mem.eql(u8, run.suspended_at, "join-end") and run.resume_with == null;
            if (!waiting_at_end) return;
            if (failed) {
                run.resume_with = .{ .join_failed = index };
            } else {
                for (join.members.items) |x| if (x.with == null) return;
                run.resume_with = .joined;
            }
            // The Join's Timeout Block no longer bounds it.
            if (run.waiting) |w| {
                for (g.pending.items, 0..) |y, i| if (y == w) {
                    _ = g.pending.orderedRemove(i);
                    break;
                };
                g.destroyPending(w);
            }
            run.waiting = null;
            try run.script.work.append(g.gpa, .{ .run = run });
            return;
        }
        run.resume_with = with;
        run.waiting = null;
        defer g.destroyPending(p);
        run.waited = .{ .id = if (p.call) |c| c.id else p.id, .block = p.block, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms };
        try run.script.work.append(g.gpa, .{ .run = run });
    }

    /// Writes a `vars` record for each Script.
    pub fn vars(g: *Group) void {
        g.write("> vars\n", .{});
        const w = g.trace orelse return;
        for (g.scripts.items) |s| {
            w.print("vars {s}", .{s.name}) catch {};
            for (s.unit.variables, s.variables) |name, v| {
                w.print(" {s}=", .{name}) catch {};
                display.writeTrace(w, v) catch {};
            }
            w.writeAll("\n") catch {};
        }
    }

    // ------------------------------------------------------------ dispatch

    /// The start keys of a Run's first Stretch and its `run` record: its
    /// Delivery, or the Run whose error it handles.
    fn writeOrigin(w: *std.Io.Writer, d: Delivery) void {
        if (d.from) |from| w.print(" from={s}", .{from}) catch {} else w.print(" delivery=d{d}", .{d.id}) catch {};
    }

    /// Starts a Run for a message: dispatch tries each clause of the
    /// Handler, in order, whose parameter count fits.
    fn startRun(g: *Group, s: *Script, d: Delivery) !void {
        // An `error` message with no `on error` is dropped unseen.
        if (d.internal_error) {
            const any = for (s.unit.bodies) |b| {
                if (b.kind == .handler and std.mem.eql(u8, b.name, "error")) break true;
            } else false;
            if (!any) return g.releaseDelivery(d);
        }
        s.runs += 1;
        const run = try g.gpa.create(Run);
        run.* = .{ .id = try std.fmt.allocPrint(g.gpa, "{s}/r{d}", .{ s.name, s.runs }), .script = s, .delivery = d, .handler = d.message };
        var clause: u32 = 0;
        var outcome: Outcome = .unhandled;
        for (s.unit.bodies, 0..) |b, i| {
            if (b.kind != .handler or !std.mem.eql(u8, b.name, d.message)) continue;
            clause += 1;
            if (b.params.len != d.args.len) continue;
            run.clause = clause;
            try g.pushFrame(run, @intCast(i), d.args);
            if (b.during) |slot| if (d.during) |during| {
                const f = &run.frames.items[run.frames.items.len - 1];
                f.locals[slot].release();
                f.locals[slot] = during.retain();
            };
            // Dispatch charges the clause at the body's first instruction.
            run.fuel += 4;
            outcome = try g.execute(run, true);
            if (outcome != .clause_failed) break;
            outcome = .unhandled;
        }
        try g.endSegment(s, run, outcome);
    }

    /// Resumes a ready Run with what settled its wait.
    fn resumeRun(g: *Group, s: *Script, run: *Run) !void {
        for (s.live.items, 0..) |r, i| if (r == run) {
            _ = s.live.orderedRemove(i);
            break;
        };
        run.segment_fuel = run.fuel;
        run.segment_alloc = run.alloc;
        const with = run.resume_with.?;
        run.resume_with = null;
        const waited = run.waited;
        const frame = &run.frames.items[run.frames.items.len - 1];
        const pc = frame.pc - 1;
        const ins = s.unit.code[pc];
        var outcome: ?Outcome = null;
        const raised: ?*Value = try g.resumeWith(run, frame, with, waited, pc, ins);
        if (raised) |err| {
            outcome = try g.unwind(run, err, pc, ins, true);
            if (with == .timeout and waited.id.len > 0) g.write("abandon {s}\n", .{waited.id});
        }
        try g.endSegment(s, run, outcome orelse try g.execute(run, true));
    }

    /// What a resumed Run's wait gave: a value pushed, or an error raised.
    fn resumeWith(g: *Group, run: *Run, frame: *Frame, with: Resume, waited: Waited, pc: u32, ins: lower.Instruction) !?*Value {
        const gpa = g.gpa;
        switch (with) {
            .woke => return null,
            .joined => {
                // Each answer, converted and charged in start order, then
                // the list of them.
                const join = run.join.?;
                const values = try gpa.alloc(*Value, join.members.items.len);
                defer gpa.free(values);
                var made: usize = 0;
                defer for (values[0..made]) |v| v.release();
                for (join.members.items, 0..) |*x, i| {
                    const w = x.with.?;
                    x.with = null;
                    const err = try g.resumeWith(run, frame, w, x.waited, pc, ins);
                    if (err) |e| {
                        defer e.release();
                        const at = try chunks.numberValue(gpa, @intCast(i + 1));
                        defer at.release();
                        return try withKey(gpa, e, "index", at);
                    }
                    values[i] = (frame.stack.pop() orelse unreachable).value;
                    made += 1;
                }
                const list = try model.list(gpa, values);
                run.alloc += costs.size(list);
                g.dropJoin(run);
                try frame.stack.append(gpa, .{ .value = list });
                return null;
            },
            .join_failed => |index| {
                const join = run.join.?;
                const x = &join.members.items[index];
                const w = x.with.?;
                if (w != .timeout) x.with = null;
                const e = (try g.resumeWith(run, frame, w, x.waited, pc, ins)).?;
                defer e.release();
                const at = try chunks.numberValue(gpa, @intCast(index + 1));
                defer at.release();
                return try withKey(gpa, e, "index", at);
            },
            .event => |x| {
                try frame.stack.append(gpa, .{ .value = x.message orelse try nothing(gpa) });
                if (ins.op == .wait_for_any) try frame.stack.append(gpa, .{ .value = try chunks.numberValue(gpa, x.branch) });
                return null;
            },
            .reply => |v| {
                // A reply charges nothing more.
                try frame.stack.append(gpa, .{ .value = v });
                return null;
            },
            .send_failed => |x| {
                defer if (x.err) |e| e.release();
                const reason = try model.text(gpa, x.reason);
                defer reason.release();
                if (x.err) |e| return try g.resumeRaise(run, pc, ins, g.raise("send failed", &.{ .{ .key = "reason", .value = reason }, .{ .key = "error", .value = e } }));
                return try g.resumeRaise(run, pc, ins, g.raise("send failed", &.{.{ .key = "reason", .value = reason }}));
            },
            .answer => |x| {
                defer x.value.release();
                const decl = waited.decl.?;
                const ok = blk: {
                    const result_shape = decl.result orelse break :blk true;
                    const checked = try capabilities.checkValue(g.scratch.allocator(), gpa, result_shape, x.value);
                    defer checked.release();
                    break :blk checked.mismatch == null;
                };
                if (!ok) return try g.resumeRaise(run, pc, ins, g.hostErrorAt(waited));
                // Only the rate's terms over the result, and the answer's
                // own cost.
                const size = costs.size(x.value);
                run.fuel += (size + 31) / 32 + x.fuel;
                run.alloc += size;
                try frame.stack.append(gpa, .{ .value = x.value.retain() });
                return null;
            },
            .failed => |f| {
                defer g.releaseResume(with);
                const decl = waited.decl.?;
                if (!capabilities.validFailure(decl.*, f.code, f.data)) return try g.resumeRaise(run, pc, ins, g.hostErrorAt(waited));
                // Its Data is converted as a result is, an empty map when
                // it has none.
                const size: u64 = if (f.data) |d| costs.size(d) else 16;
                run.fuel += (size + 31) / 32;
                run.alloc += size;
                var pairs: std.ArrayList(model.Pair) = .empty;
                defer pairs.deinit(gpa);
                const code = try model.text(gpa, f.code);
                defer code.release();
                try pairs.append(gpa, .{ .key = "code", .value = code });
                const message: ?*Value = if (f.message) |t| try model.text(gpa, t) else null;
                defer if (message) |t| t.release();
                if (message) |t| try pairs.append(gpa, .{ .key = "message", .value = t });
                if (f.data) |d| if (d.data == .map) try pairs.appendSlice(gpa, d.data.map);
                const capability = try model.text(gpa, waited.grant);
                defer capability.release();
                const op_value = try model.text(gpa, waited.operation);
                defer op_value.release();
                try pairs.append(gpa, .{ .key = "capability", .value = capability });
                try pairs.append(gpa, .{ .key = "operation", .value = op_value });
                g.pending_error = try model.map(gpa, pairs.items);
                g.pending_core = false;
                return try g.completeError(run, pc, ins);
            },
            .broken => return try g.resumeRaise(run, pc, ins, g.hostErrorAt(waited)),
            .timeout => {
                const after = try model.scalar(gpa, .{ .quantity = .{ .number = model.Decimal.fromInt(@as(i64, @intCast(waited.after_ms))), .unit = units.Unit.parse("ms") catch unreachable } });
                defer after.release();
                const yes = try model.scalar(gpa, .{ .bool = true });
                defer yes.release();
                if (waited.call == null) {
                    if (waited.block) return try g.resumeRaise(run, pc, ins, g.raise("timeout", &.{ .{ .key = "after", .value = after }, .{ .key = "deadline", .value = yes } }));
                    return try g.resumeRaise(run, pc, ins, g.raise("timeout", &.{.{ .key = "after", .value = after }}));
                }
                const capability = try model.text(gpa, waited.grant);
                defer capability.release();
                const op_value = try model.text(gpa, waited.operation);
                defer op_value.release();
                if (waited.block) return try g.resumeRaise(run, pc, ins, g.raise("timeout", &.{ .{ .key = "after", .value = after }, .{ .key = "capability", .value = capability }, .{ .key = "operation", .value = op_value }, .{ .key = "deadline", .value = yes } }));
                return try g.resumeRaise(run, pc, ins, g.raise("timeout", &.{ .{ .key = "after", .value = after }, .{ .key = "capability", .value = capability }, .{ .key = "operation", .value = op_value } }));
            },
        }
    }

    /// `send` and its forms (chapter 5, Sending): the message goes to the
    /// back of the receiving Script's work, and with `and wait` the Run
    /// suspends until the reply.
    fn send(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        const ops = ins.operands;
        const member = switch (ins.op) {
            .join_send, .join_send_named, .join_send_spread => true,
            else => false,
        };
        const waits = member or switch (ins.op) {
            .send_wait, .send_named_wait, .send_spread_wait => true,
            else => false,
        };
        const receiver = pop(frame);
        defer receiver.release();
        var args: std.ArrayList(*Value) = .empty;
        defer {
            for (args.items) |v| v.release();
            args.deinit(gpa);
        }
        var name_value: ?*Value = null;
        defer if (name_value) |v| v.release();
        var name: []const u8 = undefined;
        switch (ins.op) {
            .send, .send_wait, .join_send => {
                const n: usize = @intCast(ops[1].int);
                try args.resize(gpa, n);
                var i = n;
                while (i > 0) {
                    i -= 1;
                    args.items[i] = pop(frame);
                }
                name = ops[0].text;
            },
            .send_named, .send_named_wait, .join_send_named => {
                const n: usize = @intCast(ops[0].int);
                try args.resize(gpa, n);
                var i = n;
                while (i > 0) {
                    i -= 1;
                    args.items[i] = pop(frame);
                }
                name_value = pop(frame);
            },
            else => {
                const list = pop(frame);
                defer list.release();
                name_value = pop(frame);
                if (list.data != .list) return g.wrongKind("list", list);
                for (list.data.list) |v| try args.append(gpa, v.retain());
            },
        }
        if (name_value) |v| {
            if (v.data != .text) return g.wrongKind("text", v);
            if (!messageName(v.data.text, args.items.len)) {
                const n = try chunks.numberValue(gpa, @intCast(args.items.len));
                defer n.release();
                return g.raise("bad message name", &.{ .{ .key = "name", .value = v }, .{ .key = "arguments", .value = n } });
            }
            name = v.data.text;
        }
        if (waits and !member) if (blockDeadline(frame)) |b| if (b.at <= nanos(g.clock)) {
            m.uncharged = true;
            return g.raiseDeadline(b, null);
        };
        // The receiver: `me`, with no object, is the Script itself.
        const to: *Script = switch (receiver.data) {
            .nothing => run.script,
            .text => |t| g.script(t) orelse return g.raise("object gone", &.{.{ .key = "object", .value = receiver }}),
            else => return g.raise("not implemented", &.{}),
        };
        var size: u64 = 32;
        for (args.items) |v| size += costs.size(v);
        m.fuel_extra = (size + 31) / 32;
        m.alloc_extra = size;
        const from: []const u8 = if (waits) blk: {
            run.calls += 1;
            const id = try std.fmt.allocPrint(gpa, "{s}.c{d}", .{ run.id, run.calls });
            try g.ids.append(gpa, id);
            break :blk id;
        } else run.id;
        if (g.trace) |out| {
            out.print("send {s} to={s} message={s}", .{ from, to.name, name }) catch {};
            writeArgs(out, args.items);
            if (waits) out.writeAll(if (member) " wait=join" else " wait=yes") catch {};
            out.writeAll("\n") catch {};
        }
        const owned = try gpa.dupe(*Value, args.items);
        args.clearRetainingCapacity();
        try to.work.append(gpa, .{ .message = .{ .id = 0, .message = try gpa.dupe(u8, name), .args = owned, .request = false, .from = try gpa.dupe(u8, from), .waits = waits } });
        if (!waits) return .next;
        if (member) {
            try g.startMember(run, .{ .id = from, .run = run, .deadline = nanos(g.clock) + @as(i128, default_max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = default_max_wait_ms });
            return .next;
        }
        try g.suspendRun(run, "send-wait", .{ .id = from, .run = run, .deadline = nanos(g.clock) + @as(i128, default_max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = default_max_wait_ms });
        return .suspended;
    }

    /// Settles the wait of the sender of `d`, if it still waits; otherwise
    /// the reply is dropped.
    fn reply(g: *Group, d: Delivery, with: Resume) !void {
        const id = d.from orelse return g.releaseResume(with);
        for (g.pending.items, 0..) |p, i| if (p.call == null and std.mem.eql(u8, p.id, id)) {
            _ = g.pending.orderedRemove(i);
            return g.ready(p, with);
        };
        g.releaseResume(with);
    }

    /// `timeout` for a Timeout Block's deadline, with `capability` and
    /// `operation` for a Capability call.
    fn raiseDeadline(g: *Group, d: Deadline, where: ?[]const model.Pair) error{ Raised, OutOfMemory } {
        const gpa = g.gpa;
        const after = model.scalar(gpa, .{ .quantity = .{ .number = model.Decimal.fromInt(@as(i64, @intCast(d.ms))), .unit = units.Unit.parse("ms") catch unreachable } }) catch return error.OutOfMemory;
        defer after.release();
        const yes = model.scalar(gpa, .{ .bool = true }) catch return error.OutOfMemory;
        defer yes.release();
        var fields: std.ArrayList(model.Pair) = .empty;
        defer fields.deinit(gpa);
        fields.append(gpa, .{ .key = "after", .value = after }) catch return error.OutOfMemory;
        if (where) |w| fields.appendSlice(gpa, w) catch return error.OutOfMemory;
        fields.append(gpa, .{ .key = "deadline", .value = yes }) catch return error.OutOfMemory;
        return g.raise("timeout", fields.items);
    }

    /// `wrong kind` for a duration that isn't exact.
    fn notDuration(g: *Group, d: *Value) error{ Raised, OutOfMemory } {
        if (d.data == .quantity) {
            const e = model.text(g.gpa, "s") catch return error.OutOfMemory;
            defer e.release();
            const got = model.text(g.gpa, d.data.quantity.unit.string(g.scratch.allocator(), false) catch return error.OutOfMemory) catch return error.OutOfMemory;
            defer got.release();
            return g.raise("wrong kind", &.{ .{ .key = "expected", .value = e }, .{ .key = "got", .value = got }, .{ .key = "value", .value = d } });
        }
        return g.wrongKind("quantity", d);
    }

    /// `wait-for` and `wait-for-any` (chapter 5, `wait for` a message):
    /// takes the values its entry's branches popped, and suspends until a
    /// message matches a branch, an `after` passes or the timeout does.
    fn waitFor(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        const index: u32 = @intCast(ins.operands[0].int);
        const entry = run.script.unit.events[index];
        var count: usize = @intFromBool(entry.timeout);
        for (entry.branches) |b| count += switch (b) {
            .when => |w| @as(usize, @intFromBool(w.from)) + w.captures,
            .after => 1,
        };
        const popped = try gpa.alloc(*Value, count);
        defer releaseAll(popped, gpa);
        const first = frame.stack.items.len - count;
        for (frame.stack.items[first..], popped) |slot, *v| v.* = slot.value;
        frame.stack.shrinkRetainingCapacity(first);
        // Each `from` names a Script, and each duration is exact.
        const now = nanos(g.clock);
        var deadline: i128 = never;
        var fires: u32 = 0;
        var at: usize = 0;
        for (entry.branches, 1..) |b, number| switch (b) {
            .when => |w| {
                if (w.from) {
                    if (popped[at].data != .text) return g.wrongKind("object", popped[at]);
                }
                at += @as(usize, @intFromBool(w.from)) + w.captures;
            },
            .after => {
                const ns = waitMillis(popped[at]) orelse return g.notDuration(popped[at]);
                at += 1;
                if (now + ns < deadline) {
                    deadline = now + ns;
                    fires = @intCast(number);
                }
            },
        };
        if (entry.timeout) {
            const ns = waitMillis(popped[at]) orelse return g.notDuration(popped[at]);
            deadline = now + ns;
        }
        if (blockDeadline(frame)) |b| if (b.at <= now) {
            m.uncharged = true;
            return g.raiseDeadline(b, null);
        };
        const branches = try gpa.alloc(EventBranch, entry.branches.len);
        at = 0;
        for (entry.branches, branches) |b, *held| switch (b) {
            .when => |w| {
                const from: ?*Value = if (w.from) popped[at].retain() else null;
                if (w.from) at += 1;
                const captures = try gpa.alloc(*Value, w.captures);
                for (captures, popped[at .. at + w.captures]) |*c, v| c.* = v.retain();
                at += w.captures;
                held.* = .{ .when = .{ .from = from, .captures = captures } };
            },
            .after => {
                held.* = .{ .after = now + waitMillis(popped[at]).? };
                at += 1;
            },
        };
        const event = try gpa.create(EventWait);
        event.* = .{ .entry = index, .branches = branches, .any = ins.op == .wait_for_any };
        try g.suspendRun(run, if (event.any) "wait-for-any" else "wait-for", .{ .run = run, .deadline = deadline, .order = 0, .event = event, .branch = fires });
        return .suspended;
    }

    /// Observation before dispatch: every pending `wait for` in the Script
    /// that the message matches makes its Run ready, in the order the waits
    /// began.
    fn observe(g: *Group, s: *Script, d: Delivery) !void {
        var waits: std.ArrayList(*Pending) = .empty;
        defer waits.deinit(g.gpa);
        for (g.pending.items) |p| if (p.event != null and p.run.script == s) try waits.append(g.gpa, p);
        if (waits.items.len == 0) return;
        const message = try g.messageMap(d);
        defer message.release();
        for (waits.items) |p| {
            const branch = try g.eventMatch(p, d) orelse continue;
            for (g.pending.items, 0..) |y, i| if (y == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            const binds: u32 = switch (g.eventEntry(p).branches[branch - 1]) {
                .when => |w| @intCast(w.binds.len),
                .after => 0,
            };
            try g.ready(p, .{ .event = .{ .message = message.retain(), .branch = branch, .binds = binds } });
        }
    }

    fn eventEntry(g: *Group, p: *const Pending) lower.Event {
        _ = g;
        return p.run.script.unit.events[p.event.?.entry];
    }

    /// The number of the first `when` branch of a pending `wait for` that
    /// a message matches, having bound its names, or null.
    fn eventMatch(g: *Group, p: *Pending, d: Delivery) !?u32 {
        const run = p.run;
        const unit = &run.script.unit;
        const event = p.event.?;
        for (unit.events[event.entry].branches, event.branches, 1..) |b, held, number| {
            const w = switch (b) {
                .when => |w| w,
                .after => continue,
            };
            if (!std.mem.eql(u8, w.message, d.message)) continue;
            const arity = if (w.body) |body| unit.bodies[body].params.len else 0;
            if (arity != d.args.len) continue;
            // `from` a Script: that Script sent it.
            if (held.when.from) |from| {
                const sender = d.from orelse continue;
                const end = std.mem.indexOfScalar(u8, sender, '/') orelse sender.len;
                if (!std.mem.eql(u8, sender[0..end], from.data.text)) continue;
            }
            if (w.body) |body| {
                const values = try g.eventTest(run, body, d.args, held.when.captures) orelse continue;
                defer values.release();
                const frame = &run.frames.items[run.frames.items.len - 1];
                for (w.binds, values.data.list) |slot, v| {
                    frame.locals[slot].release();
                    frame.locals[slot] = v.retain();
                }
            }
            return @intCast(number);
        }
        return null;
    }

    /// Runs a `when` branch's test body on its waiting Run, which it
    /// charges: the values its names bind, or null if it fails.
    fn eventTest(g: *Group, run: *Run, body: u32, args: []const *Value, captures: []const *Value) !?*Value {
        const base = run.frames.items.len;
        try g.pushFrame(run, body, args);
        const frame = &run.frames.items[base];
        const first = run.script.unit.bodies[body].capture_slot;
        for (captures, first..) |v, slot| {
            frame.locals[slot].release();
            frame.locals[slot] = v.retain();
        }
        const fuel = run.fuel;
        run.base = base;
        defer run.base = 0;
        const outcome = try g.execute(run, true);
        g.pump_fuel += run.fuel - fuel;
        return switch (outcome) {
            .returned => |v| v,
            .errored => |e| blk: {
                e.release();
                break :blk null;
            },
            else => null,
        };
    }

    /// Starts a Join Member: its wait is pending, but the Run goes on.
    fn startMember(g: *Group, run: *Run, wait: Pending) !void {
        const join = run.join.?;
        const p = try g.gpa.create(Pending);
        g.timers += 1;
        p.* = wait;
        p.order = g.timers;
        p.member = join.members.items.len;
        try g.pending.append(g.gpa, p);
        try join.members.append(g.gpa, .{ .pending = p, .waited = .{ .id = if (p.call) |c| c.id else p.id, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms } });
    }

    /// Abandons a Join's members still pending, or timed out, in start
    /// order, writing an `abandon` record for each, and ends the Join.
    fn abandonJoin(g: *Group, run: *Run) void {
        const join = run.join orelse return;
        for (join.members.items) |x| {
            const abandoned = x.pending != null or (x.with != null and x.with.? == .timeout);
            if (abandoned) g.write("abandon {s}\n", .{x.waited.id});
        }
        g.dropJoin(run);
    }

    /// Ends a Join, dropping its members' waits and answers.
    fn dropJoin(g: *Group, run: *Run) void {
        const join = run.join orelse return;
        for (join.members.items) |x| {
            if (x.pending) |p| {
                for (g.pending.items, 0..) |y, i| if (y == p) {
                    _ = g.pending.orderedRemove(i);
                    break;
                };
                g.destroyPending(p);
            }
            if (x.with) |w| g.releaseResume(w);
        }
        join.members.deinit(g.gpa);
        g.gpa.destroy(join);
        run.join = null;
    }

    /// Suspends a Run at a Suspension Point, with its wait.
    fn suspendRun(g: *Group, run: *Run, at: []const u8, wait: Pending) !void {
        const p = try g.gpa.create(Pending);
        g.timers += 1;
        p.* = wait;
        // The innermost Timeout Block's deadline bounds it, and wins a tie.
        if (blockDeadline(&run.frames.items[run.frames.items.len - 1])) |d| if (d.at <= p.deadline) {
            p.deadline = d.at;
            p.block = true;
            p.after_ms = d.ms;
        };
        p.order = g.timers;
        try g.pending.append(g.gpa, p);
        run.waiting = p;
        run.suspended_at = at;
    }

    /// `call-failed`, then `host error`, for a suspending call.
    fn hostErrorAt(g: *Group, waited: Waited) error{ Raised, OutOfMemory } {
        const gpa = g.gpa;
        const capability = model.text(gpa, waited.grant) catch return error.OutOfMemory;
        defer capability.release();
        const op_value = model.text(gpa, waited.operation) catch return error.OutOfMemory;
        defer op_value.release();
        return g.hostError(waited.call.?.id, waited.grant, waited.operation, &.{ .{ .key = "capability", .value = capability }, .{ .key = "operation", .value = op_value } });
    }

    /// Completes an error raised at the Suspension Point a Run resumes at.
    fn resumeRaise(g: *Group, run: *Run, pc: u32, ins: lower.Instruction, raised: error{ Raised, OutOfMemory }) !?*Value {
        return switch (raised) {
            error.Raised => try g.completeError(run, pc, ins),
            error.OutOfMemory => error.OutOfMemory,
        };
    }

    /// Ends a Segment: writes `seg`, and either keeps the suspended Run or
    /// finishes it with its `run` record.
    fn endSegment(g: *Group, s: *Script, run: *Run, outcome: Outcome) !void {
        const fuel = run.fuel - run.segment_fuel;
        const alloc = run.alloc - run.segment_alloc;
        g.pump_fuel += fuel;
        if (outcome == .suspended) try s.live.append(g.gpa, run);
        const state = g.persistentState(s);
        const d = run.delivery;
        if (g.trace) |out| {
            out.print("seg {s} {s}", .{ run.id, if (run.started) "resume" else "start" }) catch {};
            if (!run.started) {
                writeOrigin(out, d);
                // An unhandled Run names its Handler only if the Script has
                // one.
                if (g.hasHandler(s, run.handler)) out.print(" handler={s}", .{run.handler}) catch {};
                if (outcome != .unhandled and outcome != .clause_failed) out.print(" clause={d}", .{run.clause}) catch {};
            }
            const end: []const u8 = switch (outcome) {
                .returned => "return",
                .errored => "error",
                .faulted => "fault",
                .suspended => run.suspended_at,
                .unhandled, .clause_failed => "unhandled",
            };
            out.print(" fuel={d} alloc={d} state={d} end={s}", .{ fuel, alloc, state, end }) catch {};
            if (outcome == .suspended) if (run.waiting) |p| if (p.deadline != never and ((p.call == null and p.id.len == 0) or p.block)) {
                const at: model.dates.Instant = .{ .seconds = @intCast(@divFloor(p.deadline, std.time.ns_per_s)), .nanos = @intCast(@mod(p.deadline, std.time.ns_per_s)) };
                const text = model.dates.string(g.scratch.allocator(), model.dates.fields(at), true) catch "";
                out.print(" until={s}", .{text}) catch {};
            };
            out.writeAll("\n") catch {};
        }
        run.started = true;
        if (outcome == .suspended) {
            run.segment_fuel = run.fuel;
            run.segment_alloc = run.alloc;
            return;
        }
        if (g.trace) |out| {
            const word: []const u8 = switch (outcome) {
                .returned => "completed",
                .errored => "errored",
                .faulted => "limit-fault",
                .unhandled, .clause_failed => "unhandled",
                .suspended => unreachable,
            };
            out.print("run {s} outcome={s}", .{ run.id, word }) catch {};
            // A `run` record names a Host Delivery, never a sender.
            if (d.from == null) out.print(" delivery=d{d}", .{d.id}) catch {};
            if (g.hasHandler(s, run.handler)) out.print(" handler={s}", .{run.handler}) catch {};
            switch (outcome) {
                .returned => |v| if (v.data != .nothing) {
                    out.writeAll(" value=") catch {};
                    display.writeTrace(out, v) catch {};
                },
                .errored => |e| {
                    out.writeAll(" error=") catch {};
                    display.writeTrace(out, e) catch {};
                },
                .faulted => out.writeAll(" limit=fuel") catch {},
                else => {},
            }
            out.print(" fuel={d} alloc={d}\n", .{ run.fuel, run.alloc }) catch {};
            // A message no Handler took climbs past a Script with no owner:
            // the `unhandled` report.
            if (outcome == .unhandled or outcome == .clause_failed) {
                out.writeAll("unhandled") catch {};
                if (d.from == null) out.print(" d{d}", .{d.id}) catch {};
                out.print(" message={s}", .{d.message}) catch {};
                writeArgs(out, d.args);
                out.writeAll("\n") catch {};
            }
        }
        switch (outcome) {
            .returned => |v| if (d.waits) {
                try g.reply(d, .{ .reply = v });
            } else if (d.request) try g.results.put(g.gpa, d.id, v) else v.release(),
            .faulted => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "limit fault", .err = null } }),
            .unhandled, .clause_failed => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "unhandled", .err = null } }),
            .errored => |e| {
                // An uncaught error sends the Script its `error` message,
                // unless the Run was handling one.
                if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "errored", .err = e.retain() } });
                if (!d.internal_error) {
                    const during = try g.messageMap(d);
                    const args = try g.gpa.alloc(*Value, 1);
                    args[0] = e;
                    try s.work.append(g.gpa, .{ .message = .{ .id = 0, .message = try g.gpa.dupe(u8, "error"), .args = args, .request = false, .during = during, .from = try g.gpa.dupe(u8, run.id), .internal_error = true } });
                } else e.release();
            },
            else => {},
        }
        g.destroyRun(run);
    }

    fn hasHandler(g: *Group, s: *const Script, name: []const u8) bool {
        _ = g;
        for (s.unit.bodies) |b| if (b.kind == .handler and std.mem.eql(u8, b.name, name)) return true;
        return false;
    }

    /// A message as `{name, args}`, for `, during`.
    fn messageMap(g: *Group, d: Delivery) !*Value {
        const name = try model.text(g.gpa, d.message);
        defer name.release();
        const args = try model.list(g.gpa, d.args);
        defer args.release();
        return model.map(g.gpa, &.{ .{ .key = "name", .value = name }, .{ .key = "args", .value = args } });
    }

    /// The Script's Persistent State at a Segment's end: its Script
    /// Variables, its mailbox, and its suspended and ready Runs.
    fn persistentState(g: *Group, s: *Script) u64 {
        var total: u64 = 0;
        for (s.variables) |v| total += costs.size(v);
        for (s.work.items) |w| switch (w) {
            .message => |d| {
                var contents: u64 = 0;
                for (d.args) |v| contents += costs.size(v);
                total += 32 + contents;
            },
            .run => {},
        };
        for (s.live.items) |r| total += g.runSize(r);
        return total;
    }

    /// A retained Run's size: its frames and its pending call or deadline.
    fn runSize(g: *Group, run: *const Run) u64 {
        _ = g;
        var total: u64 = 96;
        for (run.frames.items) |f| {
            total += 64 + 8 * f.locals.len;
            for (f.locals) |v| total += costs.size(v);
            for (f.stack.items) |slot| total += switch (slot) {
                .value => |v| costs.size(v),
                .iterator => |it| 24 + if (it.subject) |v| costs.size(v) else 0,
                .reader => |r| 24 + costs.size(r.subject),
                .replacement => |r| 32 + costs.size(r.text) + costs.contents(r.matches),
                .deadline => 40,
            };
        }
        if (run.waiting) |p| if (p.call != null or p.id.len > 0) {
            total += 48;
        };
        // A pending `wait for`'s captured values; a named Script is not a
        // value.
        if (run.waiting) |p| if (p.event) |e| for (e.branches) |b| switch (b) {
            .when => |x| for (x.captures) |v| {
                total += costs.size(v);
            },
            .after => {},
        };
        // A Join's pending members, and the answers that came early; once
        // a member has failed, only its failure.
        if (run.join) |join| {
            if (run.resume_with != null and run.resume_with.? == .join_failed) {
                total += retained(join.members.items[run.resume_with.?.join_failed].with.?);
            } else for (join.members.items) |x| {
                if (x.pending != null) total += 48;
                if (x.with) |w| total += retained(w);
            }
        }
        // A ready Run retains what it resumes with in place of its call.
        if (run.resume_with) |r| total += retained(r);
        return total;
    }

    fn pushFrame(g: *Group, run: *Run, body: u32, args: []const *Value) !void {
        const b = run.script.unit.bodies[body];
        const locals = try g.gpa.alloc(*Value, b.locals);
        for (locals, 0..) |*l, i| {
            l.* = if (i >= 1 and i <= args.len) args[i - 1].retain() else try nothing(g.gpa);
        }
        try run.frames.append(g.gpa, .{ .body = body, .pc = b.first, .locals = locals });
    }

    fn popFrame(g: *Group, run: *Run) void {
        var f = run.frames.pop().?;
        for (f.locals) |v| v.release();
        g.gpa.free(f.locals);
        for (f.stack.items) |slot| slot.release(g.gpa);
        f.stack.deinit(g.gpa);
    }

    // ------------------------------------------------------------ running

    const Outcome = union(enum) {
        returned: *Value,
        errored: *Value,
        clause_failed,
        unhandled,
        faulted,
        /// It suspended, at `run.suspended_at`.
        suspended,
    };

    /// Runs until the bottom frame returns. `charged` is false for the
    /// initialiser, which costs nothing.
    fn execute(g: *Group, run: *Run, charged: bool) !Outcome {
        while (true) {
            _ = g.scratch.reset(.retain_capacity);
            const frame = &run.frames.items[run.frames.items.len - 1];
            const pc = frame.pc;
            const ins = run.script.unit.code[pc];
            frame.pc += 1;
            var charge: costs.Measures = .{};
            const done = g.instruction(run, frame, ins, &charge) catch |e| switch (e) {
                error.Raised => blk: {
                    const err = try g.completeError(run, pc, ins);
                    break :blk Step{ .raised = err };
                },
                else => |other| return other,
            };
            if (charged and !charge.uncharged) {
                const key = costKey(ins, &charge);
                const cost = costs.charge(key, &charge);
                run.fuel += cost.fuel;
                run.alloc += cost.alloc;
                // The default Fuel per Run. Limits and their rollback are
                // step 4's; this bound keeps every Run finite until then.
                if (run.fuel > fuel_per_run and run.base == 0) {
                    charge.release();
                    switch (done) {
                        .returned, .raised => |v| v.release(),
                        else => {},
                    }
                    g.write("fault {s} limit=fuel at={s}:{d} pos={d}:{d}\n", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column });
                    g.abandonUnwinding(run);
                    while (run.frames.items.len > 0) g.popFrame(run);
                    return .faulted;
                }
            }
            charge.release();
            switch (done) {
                .next => {},
                .returned => |v| {
                    g.popFrame(run);
                    if (run.frames.items.len == run.base) return .{ .returned = v };
                    const caller = &run.frames.items[run.frames.items.len - 1];
                    try caller.stack.append(g.gpa, .{ .value = v });
                },
                .clause_failed => {
                    g.popFrame(run);
                    return .clause_failed;
                },
                .raised => |err| {
                    if (try g.unwind(run, err, pc, ins, charged)) |end| return end;
                },
                .end_cleanup => if (try g.nextCleanup(run)) |end| return end,
                .guard_value => |v| {
                    defer v.release();
                    if (g.guardEntry(run, pc)) |entry| {
                        if (g.trace) |w| {
                            w.print("guard-skip {s} at={s}:{d} pos={d}:{d} value=", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column }) catch {};
                            display.writeTrace(w, v) catch {};
                            w.writeAll("\n") catch {};
                        }
                        try g.cutStack(run, run.frames.items.len - 1, entry.depth);
                        run.frames.items[run.frames.items.len - 1].pc = entry.target;
                    }
                },
                .suspended => return .suspended,
                .catch_accept, .catch_next => unreachable,
            }
        }
    }

    /// Completes the error an instruction raised: a Core-raised one gets its
    /// `message` and its fields in catalogue order, and every one its `at`,
    /// unless it has one.
    fn completeError(g: *Group, run: *Run, pc: u32, ins: lower.Instruction) !*Value {
        _ = pc;
        const raw = g.pending_error.?;
        g.pending_error = null;
        defer raw.release();
        const frame = &run.frames.items[run.frames.items.len - 1];
        const at = try g.atMap(run, frame.body, ins);
        defer at.release();
        var pairs: std.ArrayList(model.Pair) = .empty;
        defer pairs.deinit(g.gpa);
        var message: ?*Value = null;
        defer if (message) |m| m.release();
        if (g.pending_core) {
            g.pending_core = false;
            const code = raw.get("code").?;
            try pairs.append(g.gpa, .{ .key = "code", .value = code });
            const entry = errorEntry(code.data.text);
            message = try model.text(g.gpa, try g.messageText(entry, raw));
            try pairs.append(g.gpa, .{ .key = "message", .value = message.? });
            if (entry) |e| {
                for (e.fields) |f| if (raw.get(f)) |v| try pairs.append(g.gpa, .{ .key = f, .value = v });
                if (e.optional) |opt| for (opt) |f| if (raw.get(f)) |v| try pairs.append(g.gpa, .{ .key = f, .value = v });
            }
            for (raw.data.map) |p| {
                const listed = for (pairs.items) |q| {
                    if (std.mem.eql(u8, q.key, p.key)) break true;
                } else false;
                if (!listed) try pairs.append(g.gpa, p);
            }
        } else {
            try pairs.appendSlice(g.gpa, raw.data.map);
            if (raw.get("at") != null) return raw.retain();
        }
        try pairs.append(g.gpa, .{ .key = "at", .value = at });
        const full = try model.map(g.gpa, pairs.items);
        full.core_message = message != null;
        return full;
    }

    fn messageText(g: *Group, entry: ?errors_table.ErrorsTableErrorEntry, raw: *Value) ![]const u8 {
        const a = g.scratch.allocator();
        const template = if (entry) |e| e.message else return raw.get("code").?.data.text;
        var out: std.ArrayList(u8) = .empty;
        var i: usize = 0;
        while (i < template.len) {
            if (template[i] == '{') if (std.mem.indexOfScalarPos(u8, template, i, '}')) |close| {
                if (raw.get(template[i + 1 .. close])) |v| try out.appendSlice(a, try display.string(a, v));
                i = close + 1;
                continue;
            };
            try out.append(a, template[i]);
            i += 1;
        }
        return out.items;
    }

    /// `{unit, handler, line, column}` for an instruction of a body.
    fn atMap(g: *Group, run: *Run, body: u32, ins: lower.Instruction) !*Value {
        const b = run.script.unit.bodies[body];
        var handler = b.name;
        // A Lambda's or event test's errors name the body it is written in.
        if (b.kind == .lambda) {
            while (std.mem.lastIndexOfScalar(u8, handler, ':')) |colon| {
                const tail = handler[colon + 1 ..];
                if (tail.len == 0 or !std.ascii.isDigit(tail[0])) break;
                const before = handler[0..colon];
                const c2 = std.mem.lastIndexOfScalar(u8, before, ':') orelse break;
                handler = before[0..c2];
            }
        }
        const unit = try model.text(g.gpa, run.script.name);
        defer unit.release();
        const h = try model.text(g.gpa, handler);
        defer h.release();
        const line = try chunks.numberValue(g.gpa, ins.position.line);
        defer line.release();
        const column = try chunks.numberValue(g.gpa, ins.position.column);
        defer column.release();
        return model.map(g.gpa, &.{ .{ .key = "unit", .value = unit }, .{ .key = "handler", .value = h }, .{ .key = "line", .value = line }, .{ .key = "column", .value = column } });
    }

    fn writeRaise(g: *Group, run: *Run, err: *Value, pc: u32, ins: lower.Instruction) void {
        const w = g.trace orelse return;
        const code = err.get("code") orelse return;
        w.print("raise {s} code=", .{run.id}) catch {};
        display.writeTrace(w, code) catch {};
        w.print(" at={s}:{d} pos={d}:{d}\n", .{ run.script.name, pc, ins.position.line, ins.position.column }) catch {};
    }

    // ------------------------------------------------------------ unwinding

    fn covers(e: lower.Unwind, pc: u32) bool {
        return e.first <= pc and pc <= e.last;
    }

    /// The guard region of the top frame covering `pc`.
    fn guardEntry(g: *Group, run: *Run, pc: u32) ?lower.Unwind {
        _ = g;
        for (run.script.unit.unwind) |e| if (e.kind == .guard and covers(e, pc)) return e;
        return null;
    }

    /// The pc a frame is at: the raising instruction for the top frame, the
    /// call it waits on for a caller.
    fn framePc(run: *Run, index: usize, raised: u32) u32 {
        if (index == run.frames.items.len - 1) return raised;
        return run.frames.items[index].pc - 1;
    }

    /// Cuts a frame's operand stack to `depth` slots.
    fn cutStack(g: *Group, run: *Run, index: usize, depth: u32) !void {
        const f = &run.frames.items[index];
        while (f.stack.items.len > depth) f.stack.pop().?.release(g.gpa);
    }

    /// Takes a raised error: a guard region skips its clause; otherwise a
    /// two-phase catch search runs each catch's tests before anything is
    /// discarded, then the exited `finally` blocks run, innermost first.
    /// Returns the Run's end, if the error ends it.
    fn unwind(g: *Group, run: *Run, err: *Value, pc: u32, ins: lower.Instruction, charged: bool) !?Outcome {
        const top = run.frames.items.len - 1;
        if (g.guardEntry(run, pc)) |entry| {
            defer err.release();
            if (g.trace) |w| {
                w.print("guard-skip {s} at={s}:{d} pos={d}:{d} code=", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column }) catch {};
                display.writeTrace(w, err.get("code").?) catch {};
                w.writeAll("\n") catch {};
            }
            try g.cutStack(run, top, entry.depth);
            run.frames.items[top].pc = entry.target;
            return null;
        }
        // An error raised while unwinding replaces the one in flight, which
        // becomes its `during`.
        var current = err;
        if (run.unwinding) |*u| {
            if (current.get("during") == null) {
                const with = try withKey(g.gpa, current, "during", u.err);
                current.release();
                current = with;
            }
            g.abandonUnwinding(run);
        }
        g.writeRaise(run, current, pc, ins);
        // An error leaving a Join abandons its members still pending.
        g.abandonJoin(run);
        return g.search(run, current, pc, top, charged);
    }

    fn search(g: *Group, run: *Run, err: *Value, pc: u32, from: usize, charged: bool) !?Outcome {
        const unit = &run.script.unit;
        var position: usize = from + 1;
        var index: usize = from + 1;
        while (index > 0) {
            index -= 1;
            const fpc = framePc(run, index, pc);
            const body = unit.bodies[run.frames.items[index].body];
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .@"catch" or !covers(e, fpc) or e.first < body.first or e.last > body.last) continue;
                // Each search step charges the frames it leaves.
                if (charged) run.fuel += 4 * (position - 1 - index);
                position = index + 1;
                switch (try g.dispatchCatch(run, index, e, err, charged)) {
                    .declined => continue,
                    .accepted => |acc| {
                        try g.startCleanup(run, err, index, fpc, ei, pc, .{ .accept = acc });
                        return g.nextCleanup(run);
                    },
                }
            }
        }
        if (charged) run.fuel += 4 * position;
        try g.startCleanup(run, err, null, 0, 0, pc, .end);
        return g.nextCleanup(run);
    }

    const Dispatch = union(enum) { accepted: Accept, declined };

    /// Runs a catch's tests in a dispatch activation of frame `index`: its
    /// own operand stack, the owner's iterator prefix and the error, over the
    /// owner's locals. Frames above it are held aside meanwhile.
    fn dispatchCatch(g: *Group, run: *Run, index: usize, entry: lower.Unwind, err: *Value, charged: bool) !Dispatch {
        const held_len = run.frames.items.len - index - 1;
        const held = try g.gpa.dupe(Frame, run.frames.items[index + 1 ..]);
        defer g.gpa.free(held);
        run.frames.shrinkRetainingCapacity(index + 1);
        const owner = &run.frames.items[index];
        const owner_stack = owner.stack;
        const owner_pc = owner.pc;
        var activation: std.ArrayList(Slot) = .empty;
        for (owner_stack.items[0..@min(entry.depth, owner_stack.items.len)]) |slot| try activation.append(g.gpa, retainSlot(slot));
        try activation.append(g.gpa, .{ .value = err.retain() });
        owner.stack = activation;
        owner.pc = entry.target;
        const result: Dispatch = while (true) {
            _ = g.scratch.reset(.retain_capacity);
            const f = &run.frames.items[index];
            const pc = f.pc;
            const ins = run.script.unit.code[pc];
            f.pc += 1;
            var charge: costs.Measures = .{};
            const done = g.instruction(run, f, ins, &charge) catch |e| switch (e) {
                error.Raised => blk: {
                    const raised = try g.completeError(run, pc, ins);
                    break :blk Step{ .raised = raised };
                },
                else => |other| return other,
            };
            if (charged) {
                const cost = costs.charge(costKey(ins, &charge), &charge);
                run.fuel += cost.fuel;
                run.alloc += cost.alloc;
            }
            charge.release();
            switch (done) {
                .next => {},
                .catch_accept => break .{ .accepted = .{ .frame = index, .pc = f.pc, .stack = f.stack } },
                .catch_next => {
                    for (f.stack.items) |slot| slot.release(g.gpa);
                    f.stack.deinit(g.gpa);
                    break .declined;
                },
                .raised => |raised| {
                    // An error in a clause's tests skips the clause.
                    defer raised.release();
                    if (g.guardEntry(run, pc)) |guard| {
                        if (g.trace) |w| {
                            w.print("guard-skip {s} at={s}:{d} pos={d}:{d} code=", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column }) catch {};
                            display.writeTrace(w, raised.get("code").?) catch {};
                            w.writeAll("\n") catch {};
                        }
                        try g.cutStack(run, index, guard.depth + 1);
                        f.pc = guard.target;
                    } else {
                        for (f.stack.items) |slot| slot.release(g.gpa);
                        f.stack.deinit(g.gpa);
                        break .declined;
                    }
                },
                .guard_value => |v| {
                    defer v.release();
                    if (g.guardEntry(run, pc)) |guard| {
                        if (g.trace) |w| {
                            w.print("guard-skip {s} at={s}:{d} pos={d}:{d} value=", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column }) catch {};
                            display.writeTrace(w, v) catch {};
                            w.writeAll("\n") catch {};
                        }
                        try g.cutStack(run, index, guard.depth + 1);
                        f.pc = guard.target;
                    }
                },
                .returned, .clause_failed, .end_cleanup, .suspended => unreachable,
            }
        };
        // The owner keeps its own stack until acceptance moves it on.
        const f = &run.frames.items[index];
        f.stack = owner_stack;
        f.pc = owner_pc;
        try run.frames.appendSlice(g.gpa, held[0..held_len]);
        return result;
    }

    /// Schedules the `finally` blocks an error leaves: every one covering the
    /// held frames' places, innermost first, then the ones nested in the
    /// catching `try` of its own frame, then what follows.
    fn startCleanup(g: *Group, run: *Run, err: *Value, catching: ?usize, catch_pc: u32, catch_entry: usize, raised: u32, then: Then) !void {
        const unit = &run.script.unit;
        var cleanups: std.ArrayList(Cleanup) = .empty;
        var index = run.frames.items.len;
        const lowest = catching orelse 0;
        while (index > lowest) {
            index -= 1;
            const fpc = if (catching != null and index == catching.?) catch_pc else framePc(run, index, raised);
            const body = unit.bodies[run.frames.items[index].body];
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .finally or !covers(e, fpc) or e.first < body.first or e.last > body.last) continue;
                if (catching != null and index == catching.? and ei > catch_entry) continue;
                try cleanups.append(g.gpa, .{ .frame = index, .target = e.target, .depth = e.depth });
            }
        }
        run.unwinding = .{ .err = err, .cleanups = cleanups, .then = then };
    }

    /// Runs the next scheduled `finally` block, or what follows the last.
    fn nextCleanup(g: *Group, run: *Run) !?Outcome {
        var u = &(run.unwinding orelse return null);
        if (u.next < u.cleanups.items.len) {
            const c = u.cleanups.items[u.next];
            u.next += 1;
            while (run.frames.items.len > c.frame + 1) g.popFrame(run);
            try g.cutStack(run, c.frame, c.depth);
            run.frames.items[c.frame].pc = c.target;
            return null;
        }
        const then = u.then;
        const err = u.err;
        u.cleanups.deinit(g.gpa);
        run.unwinding = null;
        switch (then) {
            .accept => |acc| {
                err.release();
                while (run.frames.items.len > acc.frame + 1) g.popFrame(run);
                const f = &run.frames.items[acc.frame];
                for (f.stack.items) |slot| slot.release(g.gpa);
                f.stack.deinit(g.gpa);
                f.stack = acc.stack;
                f.pc = acc.pc;
                return null;
            },
            .end => {
                while (run.frames.items.len > 0) g.popFrame(run);
                return .{ .errored = err };
            },
        }
    }

    fn abandonUnwinding(g: *Group, run: *Run) void {
        var u = run.unwinding orelse return;
        switch (u.then) {
            .accept => |acc| {
                var stack = acc.stack;
                for (stack.items) |slot| slot.release(g.gpa);
                stack.deinit(g.gpa);
            },
            .end => {},
        }
        u.err.release();
        u.cleanups.deinit(g.gpa);
        run.unwinding = null;
    }

    const Step = union(enum) {
        next,
        returned: *Value,
        clause_failed,
        raised: *Value,
        catch_accept,
        catch_next,
        end_cleanup,
        /// A Guard gave something other than a boolean.
        guard_value: *Value,
        /// It suspended at a Suspension Point.
        suspended,
    };

    fn push(g: *Group, frame: *Frame, v: *Value) !void {
        try frame.stack.append(g.gpa, .{ .value = v });
    }

    fn pop(frame: *Frame) *Value {
        return frame.stack.pop().?.value;
    }

    /// Raises a catalogue error with its fields.
    fn raise(g: *Group, code: []const u8, fields: []const model.Pair) error{ Raised, OutOfMemory } {
        var pairs: std.ArrayList(model.Pair) = .empty;
        defer pairs.deinit(g.gpa);
        const code_value = model.text(g.gpa, code) catch return error.OutOfMemory;
        defer code_value.release();
        pairs.append(g.gpa, .{ .key = "code", .value = code_value }) catch return error.OutOfMemory;
        pairs.appendSlice(g.gpa, fields) catch return error.OutOfMemory;
        g.pending_error = model.map(g.gpa, pairs.items) catch return error.OutOfMemory;
        g.pending_core = true;
        return error.Raised;
    }

    fn raiseChunk(g: *Group, effect: chunks.Effect, got: ?*const Value) error{ Raised, OutOfMemory } {
        switch (effect.raise.?) {
            .wrong_kind => |expected| {
                const e = model.text(g.gpa, expected) catch return error.OutOfMemory;
                defer e.release();
                const k = model.text(g.gpa, if (got) |v| kindName(v) else "nothing") catch return error.OutOfMemory;
                defer k.release();
                if (got) |v| return g.raise("wrong kind", &.{ .{ .key = "expected", .value = e }, .{ .key = "got", .value = k }, .{ .key = "value", .value = @constCast(v) } });
                return g.raise("wrong kind", &.{ .{ .key = "expected", .value = e }, .{ .key = "got", .value = k } });
            },
            .out_of_range => |o| {
                defer o.value.release();
                const f = model.text(g.gpa, o.field) catch return error.OutOfMemory;
                defer f.release();
                return g.raise("out of range", &.{ .{ .key = "field", .value = f }, .{ .key = "value", .value = o.value } });
            },
        }
    }

    fn instruction(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        const a = g.scratch.allocator();
        const unit = &run.script.unit;
        const ops = ins.operands;
        switch (ins.op) {
            .@"const" => {
                const v = try g.constant(unit, @intCast(ops[0].int));
                try g.push(frame, v);
            },
            .pop => frame.stack.pop().?.release(gpa),
            .load => try g.push(frame, frame.locals[@intCast(ops[0].int)].retain()),
            .store => {
                const s: usize = @intCast(ops[0].int);
                frame.locals[s].release();
                frame.locals[s] = pop(frame);
            },
            .move => {
                const from: usize = @intCast(ops[0].int);
                const to: usize = @intCast(ops[1].int);
                frame.locals[to].release();
                frame.locals[to] = frame.locals[from].retain();
            },
            .load_var => try g.push(frame, run.script.variables[@intCast(ops[0].int)].retain()),
            .store_var => {
                const s: usize = @intCast(ops[0].int);
                run.script.variables[s].release();
                run.script.variables[s] = pop(frame);
            },
            .load_definition => {
                const i = definitionIndex(unit, ops[0].text);
                try g.push(frame, run.script.definitions[i].retain());
            },
            .store_definition => {
                const i = definitionIndex(unit, ops[0].text);
                run.script.definitions[i].release();
                run.script.definitions[i] = pop(frame);
            },
            .me, .target => try g.push(frame, try nothing(gpa)),
            .jump => frame.pc = @intCast(ops[0].int),
            .branch_false, .branch_true => {
                const v = pop(frame);
                if (v.data != .bool) {
                    // A Guard that isn't a boolean skips its clause.
                    if (ins.op == .branch_false and g.guardEntry(run, frame.pc - 1) != null) return .{ .guard_value = v };
                    defer v.release();
                    return g.wrongKind("boolean", v);
                }
                defer v.release();
                if (v.data.bool == (ins.op == .branch_true)) frame.pc = @intCast(ops[0].int);
            },
            .check_boolean => {
                const v = frame.stack.items[frame.stack.items.len - 1].value;
                if (v.data != .bool) return g.wrongKind("boolean", v);
            },
            .not => {
                const v = pop(frame);
                defer v.release();
                if (v.data != .bool) return g.wrongKind("boolean", v);
                try g.push(frame, try boolean(gpa, !v.data.bool));
            },
            .add, .subtract, .multiply, .divide, .div, .mod => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const op: model.decimal.Operator = switch (ins.op) {
                    .add => .add,
                    .subtract => .subtract,
                    .multiply => .multiply,
                    .divide => .divide,
                    .div => .div,
                    else => .mod,
                };
                const r = model.arithmetic(gpa, op, x, y) catch |e| return g.arithmeticError(e, x, y);
                m.result = r.retain();
                try g.push(frame, r);
            },
            .negate => {
                const x = pop(frame);
                defer x.release();
                const r: *Value = switch (x.data) {
                    .number => |n| try model.scalar(gpa, .{ .number = n.negate() }),
                    .quantity => |q| try model.scalar(gpa, .{ .quantity = .{ .number = q.number.negate(), .unit = q.unit } }),
                    else => return g.wrongKind("number", x),
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .concat => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const joined = try std.mem.concat(a, u8, &.{ try chunks.textForm(a, x), try chunks.textForm(a, y) });
                const r = model.text(gpa, joined) catch return error.OutOfMemory;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .range => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const r = model.range(gpa, x, y) catch return g.wrongKind("number", if (x.data != .number and x.data != .quantity) x else y);
                m.result = r.retain();
                try g.push(frame, r);
            },
            .equal, .not_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                m.scanned = compared(a, x, y);
                const same = x.equal(y) catch false;
                try g.push(frame, try boolean(gpa, if (ins.op == .equal) same else !same));
            },
            .less, .greater, .less_or_equal, .greater_or_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                m.scanned = compared(a, x, y);
                const order = x.order(y) catch {
                    return g.raise("can't compare", &.{});
                };
                const r = switch (ins.op) {
                    .less => order == .lt,
                    .greater => order == .gt,
                    .less_or_equal => order != .gt,
                    else => order != .lt,
                };
                try g.push(frame, try boolean(gpa, r));
            },
            .is_empty => {
                const x = pop(frame);
                defer x.release();
                const empty = switch (x.data) {
                    .nothing => true,
                    .text => |t| t.len == 0,
                    .list => |l| l.len == 0,
                    .map => |mp| mp.len == 0,
                    .bytes => |b| b.len == 0,
                    else => false,
                };
                try g.push(frame, try boolean(gpa, empty));
            },
            .is_kind => {
                const x = pop(frame);
                defer x.release();
                const want = ops[0].text;
                const is = if (std.mem.eql(u8, want, "integer"))
                    x.data == .number and (if (x.data.number.integer(i64)) |_| true else |_| false)
                else
                    std.mem.eql(u8, kindName(x), want);
                try g.push(frame, try boolean(gpa, is));
            },
            .convert, .can_convert => {
                const v = pop(frame);
                defer v.release();
                m.input = v.retain();
                const r = conversions.convert(a, gpa, v, ops[0].text) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    else => null,
                };
                if (ins.op == .can_convert) {
                    if (r) |x| x.release();
                    try g.push(frame, try boolean(gpa, r != null));
                } else {
                    const out = r orelse {
                        const to = try model.text(gpa, ops[0].text);
                        defer to.release();
                        return g.raise("can't convert", &.{ .{ .key = "value", .value = v }, .{ .key = "to", .value = to } });
                    };
                    m.result = out.retain();
                    try g.push(frame, out);
                }
            },
            .contains, .begins_with, .ends_with => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const kind: matcher.Kind = switch (ins.op) {
                    .contains => .search,
                    .begins_with => .prefix,
                    else => .suffix,
                };
                const fold = ops.len == 1;
                const subject, const program = if (x.data == .bytes and y.data == .bytes) .{
                    try matcher.Subject.ofBytes(a, x.data.bytes),
                    try matcher.literalProgram(a, (try matcher.Subject.ofBytes(a, y.data.bytes)).units, false),
                } else blk: {
                    if (x.data != .text) return g.wrongKind("text", x);
                    break :blk .{ try matcher.Subject.ofText(a, x.data.text), try g.needle(a, y, fold) };
                };
                const found = try matcher.run(a, program, subject, 0, kind, true, &m.steps);
                try g.push(frame, try boolean(gpa, found != null));
            },
            .matches => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                if (x.data != .text) return g.wrongKind("text", x);
                const program = try g.needle(a, y, ops.len == 1);
                const found = try matcher.run(a, program, try matcher.Subject.ofText(a, x.data.text), 0, .whole, true, &m.steps);
                try g.push(frame, try boolean(gpa, found != null));
            },
            .match_whole, .match_search => {
                const p = pop(frame);
                defer p.release();
                const v = pop(frame);
                defer v.release();
                const label: u32 = @intCast(ops[ops.len - 1].int);
                if (v.data != .text or (p.data != .pattern and p.data != .text)) {
                    frame.pc = label;
                    return .next;
                }
                const program = try g.needle(a, p, ops.len == 2);
                const subject = try matcher.Subject.ofText(a, v.data.text);
                const kind: matcher.Kind = if (ins.op == .match_whole) .whole else .search;
                const found = try matcher.run(a, program, subject, 0, kind, false, &m.steps) orelse {
                    frame.pc = label;
                    return .next;
                };
                var bad: ?matcher.Unconverted = null;
                const captures = matcher.capturesMap(a, gpa, program, subject, v.data.text, found, &bad) catch |err| return g.unconverted(err, bad);
                m.result = captures.retain();
                try g.push(frame, captures);
            },
            .match_all => {
                const t = pop(frame);
                defer t.release();
                const p = pop(frame);
                defer p.release();
                if (t.data != .text) return g.wrongKind("text", t);
                const program = try g.needle(a, p, false);
                const subject = try matcher.Subject.ofText(a, t.data.text);
                const list = try g.matchList(a, program, subject, t.data.text, false, &m.steps, null);
                m.result = list.retain();
                try g.push(frame, list);
            },
            .make_pattern => {
                const n: usize = @intCast(ops[1].int);
                const values = try a.alloc(*Value, n);
                var i = n;
                while (i > 0) {
                    i -= 1;
                    values[i] = pop(frame);
                }
                defer for (values) |v| v.release();
                const template = unit.values[@intCast(ops[0].int)].pattern;
                var problem: ?matcher.Problem = null;
                const elements = matcher.splice(a, template, values, &problem) catch |err| switch (err) {
                    error.Raised => switch (problem.?) {
                        .wrong_kind => |v| return g.wrongKind("pattern", v),
                        .clash => |v| {
                            const to = model.text(gpa, "pattern") catch return error.OutOfMemory;
                            defer to.release();
                            return g.raise("can't convert", &.{ .{ .key = "value", .value = v }, .{ .key = "to", .value = to } });
                        },
                    },
                    else => return error.OutOfMemory,
                };
                const source = matcher.write(a, elements) catch return error.OutOfMemory;
                const r = model.scalar(gpa, .{ .pattern = try gpa.dupe(u8, source) }) catch return error.OutOfMemory;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .replace_start => {
                const t = pop(frame);
                const p = pop(frame);
                defer p.release();
                if (t.data != .text) {
                    defer t.release();
                    return g.wrongKind("text", t);
                }
                const program = g.needle(a, p, false) catch |err| {
                    t.release();
                    return err;
                };
                const subject = try matcher.Subject.ofText(a, t.data.text);
                var spans: std.ArrayList([2]usize) = .empty;
                const list = g.matchList(a, program, subject, t.data.text, ops[0].int == 1, &m.steps, &spans) catch |err| {
                    t.release();
                    return err;
                };
                const r = try gpa.create(Replacement);
                r.* = .{ .text = t, .matches = list, .spans = try gpa.dupe([2]usize, spans.items) };
                // A replacement holds its text and each Match.
                m.alloc_extra = 32 + costs.size(t) + costs.contents(list);
                try frame.stack.append(gpa, .{ .replacement = r });
            },
            .replace_next => {
                const r = frame.stack.items[frame.stack.items.len - 1].replacement;
                const items = r.matches.data.list;
                if (r.next >= items.len) {
                    frame.pc = @intCast(ops[0].int);
                    return .next;
                }
                r.next += 1;
                try g.push(frame, items[r.next - 1].retain());
            },
            .replace_put => {
                const v = pop(frame);
                defer v.release();
                const r = frame.stack.items[frame.stack.items.len - 1].replacement;
                const span = r.spans[r.next - 1];
                try r.pieces.appendSlice(gpa, r.text.data.text[r.position..span[0]]);
                try r.pieces.appendSlice(gpa, try chunks.textForm(a, v));
                r.position = span[1];
            },
            .replace_end => {
                const slot = frame.stack.pop().?;
                defer slot.release(gpa);
                const r = slot.replacement;
                const joined = try std.mem.concat(a, u8, &.{ r.pieces.items, r.text.data.text[r.position..] });
                const out = model.text(gpa, joined) catch return error.OutOfMemory;
                m.result = out.retain();
                try g.push(frame, out);
            },
            .ask, .tell, .ask_wait, .join_ask => return g.operation(run, frame, ins, m),
            .timeout_start => {
                const d = pop(frame);
                defer d.release();
                const ns = waitMillis(d) orelse return g.notDuration(d);
                const own: Deadline = .{ .at = nanos(g.clock) + ns, .ms = @intCast(@max(@divTrunc(ns, std.time.ns_per_ms), 0)) };
                // An enclosing block's deadline that is no later stays.
                const deadline = if (blockDeadline(frame)) |outer| (if (outer.at <= own.at) outer else own) else own;
                try frame.stack.append(gpa, .{ .deadline = deadline });
            },
            .timeout_end => frame.stack.pop().?.release(gpa),
            .join_start => {
                const join = try gpa.create(Join);
                join.* = .{};
                run.join = join;
            },
            .join_end => {
                const join = run.join.?;
                if (blockDeadline(frame)) |d| if (d.at <= nanos(g.clock)) {
                    // Already past: abandon the members, then raise.
                    m.uncharged = true;
                    g.abandonJoin(run);
                    return g.raiseDeadline(d, null);
                };
                if (join.members.items.len == 0) {
                    g.dropJoin(run);
                    const empty = try model.list(gpa, &.{});
                    m.result = empty.retain();
                    try g.push(frame, empty);
                    return .next;
                }
                run.suspended_at = "join-end";
                // Answers that all came before the end make it ready at once.
                var failed: ?usize = null;
                var all = true;
                for (join.members.items, 0..) |x, i| {
                    const w = x.with orelse {
                        all = false;
                        continue;
                    };
                    switch (w) {
                        .answer, .reply => {},
                        else => if (failed == null) {
                            failed = i;
                        },
                    }
                }
                if (failed) |i| {
                    run.resume_with = .{ .join_failed = i };
                    try run.script.work.append(gpa, .{ .run = run });
                } else if (all) {
                    run.resume_with = .joined;
                    try run.script.work.append(gpa, .{ .run = run });
                } else if (blockDeadline(frame)) |d| {
                    // A Timeout Block bounds the whole Join.
                    try g.suspendRun(run, "join-end", .{ .run = run, .deadline = d.at, .order = 0 });
                }
                return .suspended;
            },
            .send, .send_wait, .send_named, .send_named_wait, .send_spread, .send_spread_wait, .join_send, .join_send_named, .join_send_spread => return g.send(run, frame, ins, m),
            // A Script named as a receiver is its name; Host Objects come
            // later.
            .load_object => try g.push(frame, try model.text(gpa, ops[0].text)),

            .wait_for, .wait_for_any => return g.waitFor(run, frame, ins, m),
            .wait => {
                const d = pop(frame);
                defer d.release();
                const ns = waitMillis(d) orelse {
                    if (d.data == .quantity) {
                        const e = try model.text(gpa, "s");
                        defer e.release();
                        const got = try model.text(gpa, try d.data.quantity.unit.string(a, false));
                        defer got.release();
                        return g.raise("wrong kind", &.{ .{ .key = "expected", .value = e }, .{ .key = "got", .value = got }, .{ .key = "value", .value = d } });
                    }
                    return g.wrongKind("quantity", d);
                };
                if (blockDeadline(frame)) |b| if (b.at <= nanos(g.clock)) {
                    m.uncharged = true;
                    return g.raiseDeadline(b, null);
                };
                try g.suspendRun(run, "wait", .{ .run = run, .deadline = nanos(g.clock) + ns, .order = 0 });
                return .suspended;
            },
            .get_key, .get_key_computed => {
                const base = pop(frame);
                defer base.release();
                var key: []const u8 = undefined;
                var key_value: ?*Value = null;
                defer if (key_value) |k| k.release();
                if (ins.op == .get_key) key = try keyOperand(a, ops[0].text) else {
                    key_value = pop(frame);
                    if (key_value.?.data != .text) return g.wrongKind("text", key_value.?);
                    key = key_value.?.data.text;
                }
                if (base.data != .map) return g.wrongKind("map", base);
                const v = base.get(key) orelse try nothing(gpa);
                try g.push(frame, if (base.get(key)) |found| found.retain() else v);
            },
            .property, .property_delimited => {
                var delimiter: []const u8 = ",";
                var d: ?*Value = null;
                defer if (d) |x| x.release();
                if (ins.op == .property_delimited) d = pop(frame);
                const base = pop(frame);
                defer base.release();
                // Charged on its subject even when the delimiter raises.
                m.input = base.retain();
                if (d) |x| delimiter = try g.delimiterText(x);
                var effect: chunks.Effect = .{};
                const r = chunks.property(a, gpa, base, ops[0].text, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, base),
                    else => |other| return other,
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .chunk_get, .chunk_get_delimited => {
                var delimiter: []const u8 = ",";
                var d: ?*Value = null;
                defer if (d) |x| x.release();
                if (ins.op == .chunk_get_delimited) {
                    d = pop(frame);
                    delimiter = try g.delimiterText(d.?);
                }
                const whole = pop(frame);
                defer whole.release();
                const index = pop(frame);
                defer index.release();
                var effect: chunks.Effect = .{};
                const r = chunks.get(a, gpa, whole, chunkKind(ops[0].text), index, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, if (effect.raise.? == .wrong_kind and whole.data == .text) index else whole),
                    else => |other| return other,
                };
                m.scanned = effect.scanned;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .chunk_set, .chunk_set_delimited => {
                var delimiter: []const u8 = ",";
                var d: ?*Value = null;
                defer if (d) |x| x.release();
                if (ins.op == .chunk_set_delimited) {
                    d = pop(frame);
                    delimiter = try g.delimiterText(d.?);
                }
                const part = pop(frame);
                defer part.release();
                const whole = pop(frame);
                defer whole.release();
                const index = pop(frame);
                defer index.release();
                var effect: chunks.Effect = .{};
                // Charged on its inputs even when it raises.
                m.input = part.retain();
                const r = chunks.set(a, gpa, whole, chunkKind(ops[0].text), index, part, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, whole),
                    else => |other| return other,
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .chunk_delete, .chunk_delete_delimited => {
                var delimiter: []const u8 = ",";
                var d: ?*Value = null;
                defer if (d) |x| x.release();
                if (ins.op == .chunk_delete_delimited) {
                    d = pop(frame);
                    delimiter = try g.delimiterText(d.?);
                }
                const whole = pop(frame);
                defer whole.release();
                const index = pop(frame);
                defer index.release();
                var effect: chunks.Effect = .{};
                const r = chunks.delete(a, gpa, whole, chunkKind(ops[0].text), index, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, whole),
                    else => |other| return other,
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .test_chunk, .test_chunk_delimited => {
                var delimiter: []const u8 = ",";
                var d: ?*Value = null;
                defer if (d) |x| x.release();
                if (ins.op == .test_chunk_delimited) {
                    d = pop(frame);
                    delimiter = try g.delimiterText(d.?);
                }
                const whole = pop(frame);
                defer whole.release();
                const index = pop(frame);
                defer index.release();
                var effect: chunks.Effect = .{};
                const there = chunks.exists(a, whole, chunkKind(ops[0].text), index, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, whole),
                    else => |other| return other,
                };
                if (!there) frame.pc = @intCast(ops[1].int);
            },
            .test_key, .test_key_computed => {
                const base = pop(frame);
                defer base.release();
                var key_value: ?*Value = null;
                defer if (key_value) |k| k.release();
                const key = if (ins.op == .test_key) try keyOperand(a, ops[0].text) else blk: {
                    key_value = pop(frame);
                    break :blk key_value.?.data.text;
                };
                if (base.data != .map) return g.wrongKind("map", base);
                if (base.get(key) == null) frame.pc = @intCast(ops[ops.len - 1].int);
            },
            .set_key, .set_key_computed => {
                const v = pop(frame);
                const base = pop(frame);
                var key_value: ?*Value = null;
                defer if (key_value) |k| k.release();
                const key = if (ins.op == .set_key) try keyOperand(a, ops[0].text) else blk: {
                    key_value = pop(frame);
                    if (key_value.?.data != .text) {
                        v.release();
                        base.release();
                        return g.wrongKind("text", key_value.?);
                    }
                    break :blk key_value.?.data.text;
                };
                if (base.data != .map) {
                    v.release();
                    defer base.release();
                    return g.wrongKind("map", base);
                }
                var root = base;
                model.mapSet(&root, key, v) catch return error.OutOfMemory;
                m.input = v;
                m.result = root.retain();
                try g.push(frame, root);
            },
            .delete_key, .delete_key_computed => {
                const base = pop(frame);
                defer base.release();
                var key_value: ?*Value = null;
                defer if (key_value) |k| k.release();
                const key = if (ins.op == .delete_key) try keyOperand(a, ops[0].text) else blk: {
                    key_value = pop(frame);
                    break :blk key_value.?.data.text;
                };
                if (base.data != .map) return g.wrongKind("map", base);
                var pairs: std.ArrayList(model.Pair) = .empty;
                for (base.data.map) |p| if (!std.mem.eql(u8, p.key, key)) try pairs.append(a, p);
                try g.push(frame, model.map(gpa, pairs.items) catch return error.OutOfMemory);
            },
            .append, .prepend, .append_all, .prepend_all => {
                const v = pop(frame);
                defer v.release();
                const whole = pop(frame);
                defer whole.release();
                const after = ins.op == .append or ins.op == .append_all;
                const r: *Value = switch (whole.data) {
                    .list => |items| blk: {
                        var out: std.ArrayList(*Value) = .empty;
                        if (ins.op == .append_all or ins.op == .prepend_all) {
                            if (v.data != .list) return g.wrongKind("list", v);
                            if (after) {
                                try out.appendSlice(a, items);
                                try out.appendSlice(a, v.data.list);
                            } else {
                                try out.appendSlice(a, v.data.list);
                                try out.appendSlice(a, items);
                            }
                        } else if (after) {
                            try out.appendSlice(a, items);
                            try out.append(a, v);
                        } else {
                            try out.append(a, v);
                            try out.appendSlice(a, items);
                        }
                        break :blk model.list(gpa, out.items) catch return error.OutOfMemory;
                    },
                    .text => |t| blk: {
                        if (ins.op == .append_all or ins.op == .prepend_all) return g.wrongKind("list", whole);
                        const part = try chunks.textForm(a, v);
                        const joined = if (after) try std.mem.concat(a, u8, &.{ t, part }) else try std.mem.concat(a, u8, &.{ part, t });
                        break :blk model.text(gpa, joined) catch return error.OutOfMemory;
                    },
                    else => return g.wrongKind("text", whole),
                };
                m.input = v.retain();
                m.result = r.retain();
                try g.push(frame, r);
            },
            .list => {
                const n: usize = @intCast(ops[0].int);
                const items = try a.alloc(*Value, n);
                for (0..n) |i| items[n - 1 - i] = pop(frame);
                defer for (items) |v| v.release();
                const r = model.list(gpa, items) catch return error.OutOfMemory;
                m.count = n;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .list_append, .list_extend => {
                const v = pop(frame);
                defer v.release();
                const l = pop(frame);
                defer l.release();
                var out: std.ArrayList(*Value) = .empty;
                try out.appendSlice(a, l.data.list);
                if (ins.op == .list_extend) {
                    if (v.data != .list) return g.wrongKind("list", v);
                    try out.appendSlice(a, v.data.list);
                } else try out.append(a, v);
                const r = model.list(gpa, out.items) catch return error.OutOfMemory;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .map => {
                const keys = unit.values[@intCast(ops[0].int)].keys;
                const n: usize = @intCast(ops[1].int);
                const vals = try a.alloc(*Value, n);
                for (0..n) |i| vals[n - 1 - i] = pop(frame);
                defer for (vals) |v| v.release();
                const pairs = try a.alloc(model.Pair, n);
                for (pairs, keys, vals) |*p, k, v| p.* = .{ .key = k, .value = v };
                const r = model.map(gpa, pairs) catch return error.OutOfMemory;
                m.count = n;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .iterate, .iterate_times => {
                const v = pop(frame);
                const it = try gpa.create(Iterator);
                if (ins.op == .iterate_times) {
                    defer v.release();
                    if (v.data != .number) return g.wrongKind("number", v);
                    it.* = .{ .subject = null, .left = v.data.number.integer(u64) catch 0 };
                } else {
                    switch (v.data) {
                        .list => {},
                        .range => |r| if (!chunks.integerRange(r)) {
                            gpa.destroy(it);
                            defer v.release();
                            return g.wrongKind("list", v);
                        },
                        else => {
                            gpa.destroy(it);
                            defer v.release();
                            return g.wrongKind("list", v);
                        },
                    }
                    it.* = .{ .subject = v };
                }
                try frame.stack.append(gpa, .{ .iterator = it });
            },
            .next => {
                const it = frame.stack.items[frame.stack.items.len - 1].iterator;
                const item: ?*Value = blk: {
                    const subject = it.subject orelse {
                        if (it.left == 0) break :blk null;
                        it.left -= 1;
                        break :blk try nothing(gpa);
                    };
                    switch (subject.data) {
                        .list => |items| {
                            if (it.position >= items.len) break :blk null;
                            it.position += 1;
                            break :blk items[it.position - 1].retain();
                        },
                        .range => |r| {
                            const from = r.from.data.number.integer(i64) catch unreachable;
                            const to = r.to.data.number.integer(i64) catch unreachable;
                            const p = from + @as(i64, @intCast(it.position));
                            if (p > to) break :blk null;
                            it.position += 1;
                            break :blk try chunks.numberValue(gpa, p);
                        },
                        else => unreachable,
                    }
                };
                if (item) |v| try g.push(frame, v) else frame.pc = @intCast(ops[0].int);
            },
            .call => {
                const body: u32 = @intCast(ops[0].int);
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                try g.pushFrame(run, body, args);
                // Defaults fill the parameters a call leaves off.
                const callee = &run.frames.items[run.frames.items.len - 1];
                const params = unit.bodies[body].params;
                for (params[n..], n + 1..) |p, slot| {
                    const eq = std.mem.indexOf(u8, p, " = ") orelse continue;
                    const def = std.fmt.parseInt(usize, p[eq + 3 ..], 10) catch continue;
                    callee.locals[slot].release();
                    callee.locals[slot] = run.script.definitions[def].retain();
                }
            },
            .call_builtin => {
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                var raised: builtins.Raised = .{};
                const r = builtins.call(a, gpa, ops[0].text, args, &raised, m) catch |e| switch (e) {
                    error.Raised => return g.raiseBuiltin(raised),
                    else => |other| return other,
                };
                m.builtin = ops[0].text;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .test_constant => {
                const v = pop(frame);
                defer v.release();
                const c = try g.constant(unit, @intCast(ops[0].int));
                defer c.release();
                const fold = ops.len == 3;
                m.scanned = compared(a, v, c);
                if (!(try equalFolded(a, v, c, fold))) frame.pc = @intCast(ops[ops.len - 1].int);
            },
            .test_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                m.scanned = compared(a, x, y);
                if (!(x.equal(y) catch false)) frame.pc = @intCast(ops[0].int);
            },
            .test_list, .test_list_at_least => {
                const v = pop(frame);
                defer v.release();
                const n: usize = @intCast(ops[0].int);
                const ok = v.data == .list and (if (ins.op == .test_list) v.data.list.len == n else v.data.list.len >= n);
                if (!ok) frame.pc = @intCast(ops[1].int);
            },
            .list_item => {
                const v = pop(frame);
                defer v.release();
                try g.push(frame, v.data.list[@intCast(ops[0].int - 1)].retain());
            },
            .list_rest => {
                const v = pop(frame);
                defer v.release();
                const from: usize = @intCast(ops[0].int - 1);
                const r = model.list(gpa, v.data.list[@min(from, v.data.list.len)..]) catch return error.OutOfMemory;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .test_map => {
                const v = pop(frame);
                defer v.release();
                if (v.data != .map) frame.pc = @intCast(ops[0].int);
            },
            .map_get => {
                const v = pop(frame);
                defer v.release();
                const key = try keyOperand(a, ops[0].text);
                if (v.get(key)) |found| try g.push(frame, found.retain()) else frame.pc = @intCast(ops[1].int);
            },
            .bytes_field, .bytes_sized, .bytes_bits => {
                var problem: ?binary.Raise = null;
                var values: std.ArrayList(*Value) = .empty;
                defer for (values.items) |v| v.release();
                const n: usize = switch (ins.op) {
                    .bytes_field => 1,
                    .bytes_sized => 2,
                    else => @intCast(ops[1].int),
                };
                for (0..n) |_| try values.insert(a, 0, pop(frame));
                const so_far = pop(frame);
                defer so_far.release();
                const r = switch (ins.op) {
                    .bytes_field => blk: {
                        m.input = values.items[0].retain();
                        break :blk binary.field(a, gpa, so_far.data.bytes, ops[0].text, values.items[0], &problem);
                    },
                    .bytes_sized => blk: {
                        m.input = values.items[0].retain();
                        break :blk binary.sized(a, gpa, so_far.data.bytes, ops[0].text, values.items[0], values.items[1], &problem);
                    },
                    else => binary.bits(a, gpa, so_far.data.bytes, unit.values[@intCast(ops[0].int)].widths, values.items, &problem),
                } catch |e| switch (e) {
                    error.Raised => return g.raiseBinary(problem.?),
                    else => |other| return other,
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .bin_start => {
                const v = pop(frame);
                if (v.data != .bytes) {
                    v.release();
                    frame.pc = @intCast(ops[0].int);
                } else {
                    const r = try gpa.create(binary.Reader);
                    r.* = .{ .subject = v };
                    try frame.stack.append(gpa, .{ .reader = r });
                }
            },
            .bin_literal, .bin_int, .bin_bits, .bin_bytes, .bin_rest, .bin_end => {
                const fail: u32 = @intCast(ops[ops.len - 1].int);
                var size: ?*Value = null;
                defer if (size) |x| x.release();
                if (ins.op == .bin_bytes) size = pop(frame);
                const reader = frame.stack.items[frame.stack.items.len - 1].reader;
                const ok = try g.readField(run, frame, ins, reader, size, m);
                if (!ok) {
                    frame.stack.pop().?.release(gpa);
                    frame.pc = fail;
                }
            },
            .@"return" => return .{ .returned = pop(frame) },
            .catch_accept => return .catch_accept,
            .catch_next => return .catch_next,
            .end_cleanup => return .end_cleanup,
            .clause_fail => return .clause_failed,
            .raise => return g.raise(ops[0].text, &.{}),
            .throw => {
                const v = pop(frame);
                defer v.release();
                g.pending_error = switch (v.data) {
                    .map => v.retain(),
                    .text => blk: {
                        const code = v.retain();
                        defer code.release();
                        break :blk model.map(gpa, &.{.{ .key = "code", .value = code }}) catch return error.OutOfMemory;
                    },
                    else => return g.raise("bad throw", &.{}),
                };
                return error.Raised;
            },
            else => return g.raise("not implemented", &.{}),
        }
        return .next;
    }

    fn raiseBinary(g: *Group, r: binary.Raise) error{ Raised, OutOfMemory } {
        switch (r) {
            .wrong_kind => |w| return g.wrongKind(w.expected, w.got),
            .out_of_range => |o| {
                const f = model.text(g.gpa, o.field) catch return error.OutOfMemory;
                defer f.release();
                return g.raise("out of range", &.{ .{ .key = "field", .value = f }, .{ .key = "value", .value = @constCast(o.value) } });
            },
        }
    }

    /// One field of a Binary Pattern, read off the reader on the stack:
    /// false when it doesn't match, so the pattern fails.
    fn readField(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, r: *binary.Reader, size: ?*Value, m: *costs.Measures) !bool {
        const gpa = g.gpa;
        const unit = &run.script.unit;
        const ops = ins.operands;
        switch (ins.op) {
            .bin_literal => {
                const c = try g.constant(unit, @intCast(ops[0].int));
                defer c.release();
                const want: []const u8 = switch (c.data) {
                    .text => |t| t,
                    .number => |n| blk: {
                        const b = n.integer(u8) catch return false;
                        break :blk &[_]u8{b};
                    },
                    else => return false,
                };
                if (!std.mem.startsWith(u8, r.rest(), want)) return false;
                r.position += want.len;
            },
            .bin_int => {
                const n = binary.readInt(r, ops[0].text) orelse return false;
                const v = try model.scalar(gpa, .{ .number = model.Decimal{ .coefficient = @intCast(@abs(n)), .negative = n < 0 } });
                m.result = v.retain();
                try g.push(frame, v);
            },
            .bin_bits => {
                const widths = unit.values[@intCast(ops[0].int)].widths;
                const values = (try binary.readBits(g.scratch.allocator(), r, widths)) orelse return false;
                for (values, 0..) |n, i| {
                    const v = try model.scalar(gpa, .{ .number = model.Decimal{ .coefficient = n } });
                    if (i == 0) m.result = v.retain() else m.alloc_extra += costs.size(v);
                    try g.push(frame, v);
                }
            },
            .bin_bytes => {
                const s = size.?;
                if (s.data != .number) return false;
                const n = s.data.number.integer(i64) catch return false;
                if (n < 0 or r.rest().len < n) return false;
                const taken = r.rest()[0..@intCast(n)];
                const v = if (std.mem.eql(u8, ops[0].text, "bytes as text")) blk: {
                    if (!binary.validText(taken)) return false;
                    break :blk try model.text(gpa, taken);
                } else try model.bytes(gpa, taken);
                r.position += @intCast(n);
                m.result = v.retain();
                try g.push(frame, v);
            },
            .bin_rest => {
                const taken = r.rest();
                const v = if (std.mem.eql(u8, ops[0].text, "bytes as text")) blk: {
                    if (!binary.validText(taken)) return false;
                    break :blk try model.text(gpa, taken);
                } else try model.bytes(gpa, taken);
                frame.stack.pop().?.release(gpa);
                m.result = v.retain();
                try g.push(frame, v);
            },
            .bin_end => {
                const done = r.rest().len == 0;
                frame.stack.pop().?.release(gpa);
                if (!done) {
                    // The reader is gone already: jump without popping again.
                    frame.pc = @intCast(ops[0].int);
                }
                return true;
            },
            else => unreachable,
        }
        return true;
    }

    fn raiseBuiltin(g: *Group, raised: builtins.Raised) error{ Raised, OutOfMemory } {
        defer for (raised.fields[0..raised.len]) |f| f.value.release();
        return g.raise(raised.code, raised.fields[0..raised.len]);
    }

    fn arithmeticError(g: *Group, e: model.Error, x: *Value, y: *Value) error{ Raised, OutOfMemory } {
        return switch (e) {
            error.DivisionByZero => g.raise("division by zero", &.{}),
            error.IncompatibleUnits => g.raise("incompatible units", &.{}),
            error.Overflow => g.raise("overflow", &.{}),
            error.OutOfMemory => error.OutOfMemory,
            else => g.wrongKind("number", if (x.data != .number and x.data != .quantity) x else y),
        };
    }

    /// `ask` and `tell`: an immediate or fire-and-forget Capability call
    /// (chapter 9, Capabilities). Each argument is checked against its Shape
    /// first, and a mismatch is charged nothing. The declared cost is
    /// charged before the Host function runs, and the call is recorded.
    fn operation(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        const a = g.scratch.allocator();
        const ops = ins.operands;
        const grant_name = ops[0].text;
        const op_name = ops[1].text;
        const n: usize = @intCast(ops[2].int);
        const args = try a.alloc(*Value, n);
        var i = n;
        while (i > 0) {
            i -= 1;
            args[i] = pop(frame);
        }
        defer for (args) |v| v.release();
        const granted = run.script.grant(grant_name) orelse return g.raise("not implemented", &.{});
        const index = granted.grant.capability.find(op_name) orelse return g.raise("not implemented", &.{});
        const decl = granted.grant.capability.operations[index];
        const where = [_]model.Pair{
            .{ .key = "capability", .value = try model.text(gpa, grant_name) },
            .{ .key = "operation", .value = try model.text(gpa, op_name) },
        };
        defer for (where) |p| p.value.release();

        // Arguments, depth-first in order.
        for (args, decl.args[0..n], 1..) |v, shape, position| {
            const checked = try capabilities.checkValue(a, gpa, shape, v);
            defer checked.release();
            const bad = checked.mismatch orelse continue;
            m.uncharged = true;
            return g.raiseMismatch(bad, position, &where);
        }

        if (ins.op == .ask_wait) if (blockDeadline(frame)) |b| if (b.at <= nanos(g.clock)) {
            m.uncharged = true;
            return g.raiseDeadline(b, &where);
        };
        // The Core's own checks, charged nothing either.
        if (decl.before) |before| if (try before(a, &granted.grant.capability.operations[index], args, granted.grant.binding)) |problem| {
            m.uncharged = true;
            switch (problem) {
                .out_of_domain => |v| {
                    const function = try model.text(gpa, op_name);
                    defer function.release();
                    return g.raise("out of domain", &.{ .{ .key = "function", .value = function }, .{ .key = "value", .value = v } });
                },
                .bad_locale => |tag| {
                    const locale = try model.text(gpa, tag);
                    defer locale.release();
                    return g.raise("bad locale", &.{.{ .key = "locale", .value = locale }});
                },
            }
        };

        run.calls += 1;
        const id = try std.fmt.allocPrint(a, "{s}.c{d}", .{ run.id, run.calls });
        const left: ?u64 = if (run.fuel + decl.cost.fuel >= fuel_per_run) 0 else fuel_per_run - run.fuel - decl.cost.fuel;
        var local: capabilities.Call = .{ .id = id, .script = run.script.name, .grant = grant_name, .binding = granted.grant.binding, .now = g.clock, .left = left };
        // A suspending call outlives the instruction: the Host answers it
        // later, through the Group.
        const suspending = decl.mode == .suspending;
        const call: *capabilities.Call = if (suspending) blk: {
            const c = try gpa.create(capabilities.Call);
            c.* = local;
            c.id = gpa.dupe(u8, id) catch |err| {
                gpa.destroy(c);
                return err;
            };
            c.group = g;
            try g.calls.append(gpa, c);
            break :blk c;
        } else &local;
        const outcome = decl.host.call(decl.host.context, call, args);
        call.starting = false;
        m.declared = decl.cost.fuel;
        m.fuel_extra = call.charged;
        m.alloc_extra = decl.cost.alloc;
        // The record: `call <id> op=<grant>.<op> args=[…]`, then the result
        // or error, and `charged`.
        const record = struct {
            fn write(gr: *Group, call_id: []const u8, grant: []const u8, operation_name: []const u8, values: []const *Value, key: []const u8, shown: ?*const Value, charged: u64) void {
                const w = gr.trace orelse return;
                w.print("call {s} op={s}.{s} args=[", .{ call_id, grant, operation_name }) catch {};
                for (values, 0..) |v, k| {
                    if (k > 0) w.writeAll(", ") catch {};
                    display.writeTrace(w, v) catch {};
                }
                w.writeAll("]") catch {};
                if (shown) |v| {
                    w.print(" {s}=", .{key}) catch {};
                    display.writeTrace(w, v) catch {};
                }
                if (charged > 0) w.print(" charged={d}", .{charged}) catch {};
                w.writeAll("\n") catch {};
            }
        }.write;
        const empty = try model.map(gpa, &.{});
        defer empty.release();
        if (suspending) switch (outcome) {
            .value, .started => {
                if (outcome == .value) outcome.value.release();
                record(g, id, grant_name, op_name, args, "", null, call.charged);
                const after_ms = if (decl.max_pending_ms > 0) decl.max_pending_ms else default_max_wait_ms;
                if (ins.op == .join_ask) {
                    try g.startMember(run, .{ .run = run, .deadline = nanos(g.clock) + @as(i128, after_ms) * std.time.ns_per_ms, .order = 0, .call = call, .grant = grant_name, .operation = op_name, .decl = &granted.grant.capability.operations[index], .after_ms = after_ms });
                    return .next;
                }
                try g.suspendRun(run, "ask-wait", .{ .run = run, .deadline = nanos(g.clock) + @as(i128, after_ms) * std.time.ns_per_ms, .order = 0, .call = call, .grant = grant_name, .operation = op_name, .decl = &granted.grant.capability.operations[index], .after_ms = after_ms });
                return .suspended;
            },
            else => {},
        };
        switch (outcome) {
            .started => {
                record(g, id, grant_name, op_name, args, "error", empty, call.charged);
                return g.hostError(id, grant_name, op_name, &where);
            },
            .value => |v| {
                if (decl.mode == .fire_and_forget) {
                    v.release();
                    record(g, id, grant_name, op_name, args, "", null, call.charged);
                    return .next;
                }
                const ok = blk: {
                    const result_shape = decl.result orelse break :blk true;
                    const checked = try capabilities.checkValue(a, gpa, result_shape, v);
                    defer checked.release();
                    if (checked.mismatch != null) break :blk false;
                    const after = decl.after orelse break :blk true;
                    break :blk after(&granted.grant.capability.operations[index], args, v);
                };
                if (!ok) {
                    v.release();
                    record(g, id, grant_name, op_name, args, "error", empty, call.charged);
                    return g.hostError(id, grant_name, op_name, &where);
                }
                record(g, id, grant_name, op_name, args, "result", v, call.charged);
                m.result = v.retain();
                try g.push(frame, v);
            },
            .failed => |f| {
                defer gpa.free(f.code);
                defer if (f.message) |t| gpa.free(t);
                defer if (f.data) |d| d.release();
                var pairs: std.ArrayList(model.Pair) = .empty;
                defer pairs.deinit(gpa);
                const code = try model.text(gpa, f.code);
                defer code.release();
                try pairs.append(gpa, .{ .key = "code", .value = code });
                const message: ?*Value = if (f.message) |t| try model.text(gpa, t) else null;
                defer if (message) |t| t.release();
                if (message) |t| try pairs.append(gpa, .{ .key = "message", .value = t });
                if (f.data) |d| if (d.data == .map) try pairs.appendSlice(gpa, d.data.map);
                const shown = model.map(gpa, pairs.items) catch {
                    record(g, id, grant_name, op_name, args, "error", empty, call.charged);
                    return g.hostError(id, grant_name, op_name, &where);
                };
                defer shown.release();
                record(g, id, grant_name, op_name, args, "error", shown, call.charged);
                if (!capabilities.validFailure(decl, f.code, f.data)) return g.hostError(id, grant_name, op_name, &where);
                // Its Data is converted as a result is, an empty map when
                // it has none.
                m.result = if (f.data) |d| d.retain() else empty.retain();
                try pairs.appendSlice(gpa, &where);
                g.pending_error = try model.map(gpa, pairs.items);
                g.pending_core = false;
                return error.Raised;
            },
            .broken => {
                record(g, id, grant_name, op_name, args, "error", empty, call.charged);
                return g.hostError(id, grant_name, op_name, &where);
            },
            .limited => {
                record(g, id, grant_name, op_name, args, "", null, 0);
                m.fuel_extra = fuel_per_run;
            },
        }
        return .next;
    }

    /// A Host failure: a `call-failed` report, then `host error`.
    fn hostError(g: *Group, id: []const u8, grant: []const u8, operation_name: []const u8, where: []const model.Pair) error{ Raised, OutOfMemory } {
        g.write("call-failed {s} op={s}.{s}\n", .{ id, grant, operation_name });
        return g.raise("host error", where);
    }

    /// `wrong kind` or `not encodable` for an argument that breaks its Shape.
    fn raiseMismatch(g: *Group, bad: capabilities.Mismatch, position: usize, where: []const model.Pair) error{ Raised, OutOfMemory } {
        const gpa = g.gpa;
        switch (bad) {
            .wrong_kind => |w| {
                const expected = model.text(gpa, w.expected) catch return error.OutOfMemory;
                defer expected.release();
                const got = model.text(gpa, w.got) catch return error.OutOfMemory;
                defer got.release();
                const argument = chunks.numberValue(gpa, @intCast(position)) catch return error.OutOfMemory;
                defer argument.release();
                var fields: std.ArrayList(model.Pair) = .empty;
                defer fields.deinit(gpa);
                fields.appendSlice(gpa, &.{ .{ .key = "expected", .value = expected }, .{ .key = "got", .value = got }, .{ .key = "value", .value = w.value } }) catch return error.OutOfMemory;
                fields.appendSlice(gpa, where) catch return error.OutOfMemory;
                fields.append(gpa, .{ .key = "argument", .value = argument }) catch return error.OutOfMemory;
                var path: ?*Value = null;
                defer if (path) |p| p.release();
                if (w.path.len > 0) {
                    path = model.list(gpa, @constCast(w.path)) catch return error.OutOfMemory;
                    fields.append(gpa, .{ .key = "path", .value = path.? }) catch return error.OutOfMemory;
                }
                return g.raise("wrong kind", fields.items);
            },
            .not_encodable => |e| {
                const kind = model.text(gpa, "function") catch return error.OutOfMemory;
                defer kind.release();
                const items = gpa.alloc(*Value, e.path.len + 1) catch return error.OutOfMemory;
                defer gpa.free(items);
                items[0] = chunks.numberValue(gpa, @intCast(position)) catch return error.OutOfMemory;
                defer items[0].release();
                @memcpy(items[1..], e.path);
                const path = model.list(gpa, items) catch return error.OutOfMemory;
                defer path.release();
                return g.raise("not encodable", &.{ .{ .key = "kind", .value = kind }, .{ .key = "path", .value = path } });
            },
        }
    }

    /// The program of a needle: a Text Pattern's, or a text's as a literal.
    fn needle(g: *Group, a: Allocator, v: *const Value, fold: bool) !matcher.Program {
        return switch (v.data) {
            .pattern => matcher.programOf(a, v, fold) catch return error.OutOfMemory,
            .text => |t| matcher.literalProgram(a, (try matcher.Subject.ofText(a, t)).units, fold),
            else => g.wrongKind("pattern", v),
        };
    }

    /// The Match Search's Matches as a list, and their byte spans.
    fn matchList(g: *Group, a: Allocator, program: matcher.Program, subject: matcher.Subject, text: []const u8, first: bool, steps: *u64, spans: ?*std.ArrayList([2]usize)) !*Value {
        const found = try matcher.matchSearch(a, program, subject, first, steps);
        const items = try a.alloc(*Value, found.len);
        var made: usize = 0;
        defer for (items[0..made]) |v| v.release();
        for (found) |f| {
            var bad: ?matcher.Unconverted = null;
            items[made] = matcher.matchMap(a, g.gpa, program, subject, text, f, &bad) catch |err| return g.unconverted(err, bad);
            made += 1;
            if (spans) |s| try s.append(a, .{ subject.offsets[f.start], subject.offsets[f.end] });
        }
        return model.list(g.gpa, items) catch error.OutOfMemory;
    }

    /// A Capture whose text isn't a number raises `can't convert`.
    fn unconverted(g: *Group, err: anyerror, bad: ?matcher.Unconverted) error{ Raised, OutOfMemory } {
        if (err != error.Raised) return error.OutOfMemory;
        const v = model.text(g.gpa, bad.?.text) catch return error.OutOfMemory;
        defer v.release();
        const to = model.text(g.gpa, "number") catch return error.OutOfMemory;
        defer to.release();
        return g.raise("can't convert", &.{ .{ .key = "value", .value = v }, .{ .key = "to", .value = to } });
    }

    fn wrongKind(g: *Group, expected: []const u8, got: *const Value) error{ Raised, OutOfMemory } {
        const e = model.text(g.gpa, expected) catch return error.OutOfMemory;
        defer e.release();
        const k = model.text(g.gpa, kindName(got)) catch return error.OutOfMemory;
        defer k.release();
        return g.raise("wrong kind", &.{ .{ .key = "expected", .value = e }, .{ .key = "got", .value = k }, .{ .key = "value", .value = @constCast(got) } });
    }

    fn delimiterText(g: *Group, d: *Value) ![]const u8 {
        if (d.data != .text) return g.wrongKind("text", d);
        if (d.data.text.len == 0) {
            const f = model.text(g.gpa, "delimiter") catch return error.OutOfMemory;
            defer f.release();
            return g.raise("out of range", &.{ .{ .key = "field", .value = f }, .{ .key = "value", .value = d } });
        }
        return d.data.text;
    }

    /// A constant as a value, made for the Built-in Constants.
    fn constant(g: *Group, unit: *const lower.Unit, i: usize) !*Value {
        return switch (unit.values[i]) {
            .value => |v| v.retain(),
            .builtin => |name| builtins.constant(g.gpa, name),
            .pattern => |source| blk: {
                const copy = try g.gpa.dupe(u8, source);
                break :blk model.scalar(g.gpa, .{ .pattern = copy }) catch {
                    g.gpa.free(copy);
                    return error.OutOfMemory;
                };
            },
            else => g.raise("not implemented", &.{}),
        };
    }
};

fn costKey(ins: lower.Instruction, m: *const costs.Measures) []const u8 {
    if (m.builtin.len > 0) return m.builtin;
    return machine_table.instruction[@backingInt(ins.op)].cost;
}

/// The pairs `compare` scans: Characters of texts through the first that
/// differs, or to the end of the shorter.
fn compared(a: Allocator, x: *const Value, y: *const Value) u64 {
    if (x.data == .text and y.data == .text) {
        var i: usize = 0;
        var j: usize = 0;
        var n: u64 = 0;
        const s = x.data.text;
        const t = y.data.text;
        while (i < s.len and j < t.len) {
            const ei = unicode.grapheme.end(s, i);
            const ej = unicode.grapheme.end(t, j);
            n += 1;
            if (!std.mem.eql(u8, s[i..ei], t[j..ej])) return n;
            i = ei;
            j = ej;
        }
        return n;
    }
    _ = a;
    if (x.data == .bytes and y.data == .bytes) {
        const b = x.data.bytes;
        const c = y.data.bytes;
        for (0..@min(b.len, c.len)) |i| if (b[i] != c[i]) return i + 1;
        return @min(b.len, c.len);
    }
    if (x.data == .list and y.data == .list) return @min(x.data.list.len, y.data.list.len);
    return 0;
}

const errors_table = @import("../generated/errors.zig");

fn errorEntry(code: []const u8) ?errors_table.ErrorsTableErrorEntry {
    for (errors_table.errors.@"error") |e| if (std.mem.eql(u8, e.code, code)) return e;
    return null;
}

/// The Script's Grants. With `as_used`, each keeps only the Operations the
/// code calls through it.
fn keptGrants(a: Allocator, named: []const NamedGrant, unit: *const lower.Unit, as_used: bool) ![]ScriptGrant {
    var out: std.ArrayList(ScriptGrant) = .empty;
    for (named) |n| {
        const kept = try a.dupe(bool, n.grant.operations);
        if (as_used) {
            for (kept, n.grant.capability.operations) |*k, op| {
                if (!k.*) continue;
                k.* = for (unit.code) |ins| switch (ins.op) {
                    .ask, .tell, .ask_wait, .join_ask => if (std.mem.eql(u8, ins.operands[0].text, n.name) and std.mem.eql(u8, ins.operands[1].text, op.name)) break true,
                    else => {},
                } else false;
            }
            if (std.mem.indexOfScalar(bool, kept, true) == null) continue;
        }
        try out.append(a, .{ .name = try a.dupe(u8, n.name), .grant = n.grant, .kept = kept });
    }
    return out.items;
}

fn retainSlot(slot: Slot) Slot {
    return switch (slot) {
        .value => |v| .{ .value = v.retain() },
        .iterator => |it| blk: {
            it.references += 1;
            break :blk .{ .iterator = it };
        },
        .reader => |r| blk: {
            r.references += 1;
            break :blk .{ .reader = r };
        },
        .replacement => |r| blk: {
            r.references += 1;
            break :blk .{ .replacement = r };
        },
        .deadline => slot,
    };
}

/// A map with `key` added at its end.
fn withKey(gpa: Allocator, map: *Value, key: []const u8, value: *Value) !*Value {
    var pairs: std.ArrayList(model.Pair) = .empty;
    defer pairs.deinit(gpa);
    try pairs.appendSlice(gpa, map.data.map);
    try pairs.append(gpa, .{ .key = key, .value = value });
    const out = try model.map(gpa, pairs.items);
    out.core_message = map.core_message;
    return out;
}

/// `=` between two values, comparing texts by simple case folding under
/// `ignoring case`.
fn equalFolded(a: Allocator, x: *const Value, y: *const Value, fold: bool) !bool {
    if (fold and x.data == .text and y.data == .text) {
        const fx = try unicode.foldText(a, x.data.text);
        const fy = try unicode.foldText(a, y.data.text);
        return std.mem.eql(u8, fx, fy);
    }
    return x.equal(y) catch false;
}

fn definitionIndex(unit: *const lower.Unit, name: []const u8) usize {
    for (unit.definitions, 0..) |d, i| if (std.mem.eql(u8, d, name)) return i;
    unreachable;
}

fn chunkKind(name: []const u8) chunks.Kind {
    if (std.mem.eql(u8, name, "code point")) return .code_point;
    return std.meta.stringToEnum(chunks.Kind, name).?;
}

/// A key operand, from its display form.
fn keyOperand(a: Allocator, shown: []const u8) ![]const u8 {
    const v = display.parse(a, shown, .{}) catch return error.OutOfMemory;
    return v.data.text;
}

pub fn kindName(v: *const Value) []const u8 {
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
        .instant => "instant",
        .civil_date => "civil date",
        .pattern => "pattern",
        .function => "function",
        .object => "object",
    };
}

fn nothing(gpa: Allocator) !*Value {
    return model.scalar(gpa, .nothing);
}

fn boolean(gpa: Allocator, b: bool) !*Value {
    return model.scalar(gpa, .{ .bool = b });
}

fn releaseAll(values: []*Value, gpa: Allocator) void {
    for (values) |v| v.release();
    gpa.free(values);
}

const fuel_per_run = 10_000_000;

/// A Script's code identity (chapter 9).
pub fn codeIdentity(name: []const u8, source: []const u8) [32]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [64]u8 = undefined;
    h.update(std.fmt.bufPrint(&buf, "odgn-talk code identity 1\n{s}\n{d}\nscript\n", .{ version.language, cost_model.version }) catch unreachable);
    h.update(name);
    h.update("\nsource\n");
    h.update(source);
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

/// MaxWait's default, for a suspending call whose Operation sets no
/// `maxPending`, until step 4 brings per-Script limits.
const default_max_wait_ms = 30_000;

/// An Instant in nanoseconds since the epoch.
fn nanos(t: model.dates.Instant) i128 {
    return @as(i128, t.seconds) * std.time.ns_per_s + t.nanos;
}

/// An exact duration in nanoseconds, rounded half to even, or null for
/// anything else.
fn waitMillis(d: *const Value) ?i128 {
    if (d.data != .quantity) return null;
    const q = d.data.quantity;
    const second = units.Unit.parse("s") catch return null;
    if (!q.unit.compatible(second)) return null;
    var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena.deinit();
    const base = q.unit.toBase(arena.allocator(), q.number) catch return null;
    var n: i128 = @intCast(base.coefficient);
    var e: i32 = base.exponent + 9;
    const cap: i128 = std.math.maxInt(i96);
    while (e > 0) : (e -= 1) n = if (n > @divTrunc(cap, 10)) cap else n * 10;
    if (e < 0) {
        var divisor: i128 = 1;
        while (e < 0) : (e += 1) {
            if (divisor > @divTrunc(cap, 10)) return if (base.negative) 0 else 0;
            divisor *= 10;
        }
        const whole = @divTrunc(n, divisor);
        const rest = n - whole * divisor;
        n = whole;
        if (rest * 2 > divisor or (rest * 2 == divisor and @mod(whole, 2) == 1)) n += 1;
    }
    return if (base.negative) -n else n;
}

/// A `Fail`'s error as the Trace shows it: code, message, then its Data.
fn failureMap(gpa: Allocator, f: Failure) !*Value {
    var pairs: std.ArrayList(model.Pair) = .empty;
    defer pairs.deinit(gpa);
    const code = try model.text(gpa, f.code);
    defer code.release();
    try pairs.append(gpa, .{ .key = "code", .value = code });
    const message: ?*Value = if (f.message) |t| try model.text(gpa, t) else null;
    defer if (message) |t| t.release();
    if (message) |t| try pairs.append(gpa, .{ .key = "message", .value = t });
    if (f.data) |d| if (d.data == .map) try pairs.appendSlice(gpa, d.data.map);
    return model.map(gpa, pairs.items);
}

/// What a settled wait retains: an answer or reply, a failure's Data (an
/// empty map when it has none), a failed send's error, or a matched
/// event's message and a slot for each value its test bound.
fn retained(r: Resume) u64 {
    return switch (r) {
        .answer => |x| costs.size(x.value),
        .reply => |v| costs.size(v),
        .send_failed => |x| if (x.err) |e| costs.size(e) else 0,
        .failed => |f| if (f.data) |d| costs.size(d) else 16,
        .event => |x| (if (x.message) |v| costs.size(v) else 0) + 8 * @as(u64, x.binds),
        else => 0,
    };
}

/// Writes ` args=[…]`, or nothing for no arguments.
fn writeArgs(out: *std.Io.Writer, args: []const *Value) void {
    if (args.len == 0) return;
    out.writeAll(" args=[") catch {};
    for (args, 0..) |v, i| {
        if (i > 0) out.writeAll(", ") catch {};
        display.writeTrace(out, v) catch {};
    }
    out.writeAll("]") catch {};
}

const grammar = @import("../generated/grammar.zig").grammar;

fn nameWord(w: []const u8) bool {
    if (w.len == 0) return false;
    if (!(std.ascii.isAlphabetic(w[0]) or w[0] == '_' or w[0] >= 0x80)) return false;
    for (w) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_' or c >= 0x80)) return false;
    if (std.mem.eql(u8, w, "all") or std.mem.eql(u8, w, "_")) return false;
    for (grammar.reserved) |r| if (std.mem.eql(u8, r, w)) return false;
    return true;
}

fn labelWord(w: []const u8) bool {
    for (grammar.labels.excluded) |x| if (std.mem.eql(u8, x, w)) return false;
    for (grammar.labels.reserved) |x| if (std.mem.eql(u8, x, w)) return true;
    return nameWord(w);
}

/// Whether a computed message name is a Name for any count, or a Selector
/// with one part per argument (chapter 5, Sending).
fn messageName(name: []const u8, count: usize) bool {
    if (std.mem.indexOfScalar(u8, name, ':') == null) return nameWord(name);
    if (name[name.len - 1] != ':') return false;
    var parts: usize = 0;
    var it = std.mem.splitScalar(u8, name[0 .. name.len - 1], ':');
    while (it.next()) |part| {
        // A label after the first part may be a Reserved Word the labels
        // allow, such as `to`, but never an excluded one.
        const label = parts > 0 and labelWord(part);
        if (!label and !nameWord(part)) return false;
        parts += 1;
    }
    return parts == count;
}

/// The innermost Timeout Block's deadline on a frame's stack.
fn blockDeadline(frame: *const Frame) ?Deadline {
    var i = frame.stack.items.len;
    while (i > 0) {
        i -= 1;
        if (frame.stack.items[i] == .deadline) return frame.stack.items[i].deadline;
    }
    return null;
}

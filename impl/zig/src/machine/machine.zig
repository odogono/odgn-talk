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
const lower = @import("../lower/lower.zig");
const check = @import("../check/check.zig");
const parser = @import("../syntax/parser.zig");
const lexer = @import("../syntax/lexer.zig");
const ast = @import("../syntax/ast.zig");
const chunks = @import("chunks.zig");
const scratch_arena = @import("scratch.zig");
pub const costs = @import("costs.zig");
const builtins = @import("builtins.zig");
const binary = @import("binary.zig");
const conversions = @import("convert.zig");
const matcher = @import("matcher.zig");
const units = @import("../units.zig");
pub const capabilities = @import("capabilities.zig");
pub const fingerprint = @import("fingerprint.zig");
pub const snapshot = @import("snapshot.zig");
pub const verify = @import("verify.zig");
pub const objects = @import("objects.zig");
pub const report = @import("reports.zig");
const machine_table = @import("../generated/machine.zig").machine;
const version = @import("../generated/version.zig").version;
const cost_model = @import("../generated/costs.zig").costs;
const Opcode = @import("../generated/opcodes.zig").Opcode;
const stdlib_sources = @import("../generated/stdlib_sources.zig").sources;
const limits_table = @import("../generated/limits.zig").limits;
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

    pub fn release(self: Slot, gpa: Allocator) void {
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
    restricted: bool = false,
    /// The Library whose code it runs, or null for its Script's.
    library: ?*Library = null,
    body: u32,
    pc: u32,
    locals: []*Value,
    stack: std.ArrayList(Slot) = .empty,
    /// Whether a Command Call pushed it, so that its `clause-fail` tries
    /// the Handler's next clause.
    called: bool = false,
};

pub const Delivery = struct {
    id: u64,
    /// The Host Delivery whose work this message is (chapter 9, Run
    /// accounting): 0 for a Host Delivery, which is its own root.
    root: u64 = 0,
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
    /// The Host Object it was delivered to, which stays `the target` all
    /// the way up the path; null for a message to a Script.
    target: ?*objects.Object = null,
    /// For a message on an object's path, the object whose path it reads
    /// when it reaches the head of a mailbox: its Target, or after a climb,
    /// the parent of the object whose Owning Script passed it on.
    at: ?*objects.Object = null,
    /// A foreign Function Value call: the Function Value its Run calls,
    /// with the arguments, in place of a Handler.
    function: ?*Value = null,
    /// A Decision whose Verdict is still open: it travels with the message
    /// until a clause takes it, a `wait for` takes it, or its path ends.
    decision: bool = false,
    /// A Decision's message, open or not, which never reaches a Fallback.
    decides: bool = false,
    /// The broadcast id of a Broadcast's recipient, or 0. A Broadcast never
    /// climbs, never reaches a Fallback and is never `unhandled`.
    broadcast: u64 = 0,
    /// The Host's override of the per-Run limits, for a Host Delivery.
    limits: ?Override = null,
    /// After a climb, the object whose Owning Script passed it on: its
    /// parent, read when the message reaches the head of a mailbox, is
    /// where it goes next.
    passed_by: ?*objects.Object = null,
};

/// A Handler's Selector: its name, then `:` and each Argument Label
/// followed by `:`.
fn handlerSelector(a: Allocator, t: *const ast.Tree, h: ast.Handler) ![]const u8 {
    if (h.labels.len == 0) return t.text(h.name);
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, t.text(h.name));
    try out.append(a, ':');
    for (h.labels) |l| try out.print(a, "{s}:", .{t.text(l)});
    return out.items;
}

/// The Host Delivery at a message's root.
pub fn rootOf(d: Delivery) u64 {
    return if (d.root != 0) d.root else d.id;
}

/// A Decision's Verdict (chapter 5, Decisions).
pub const Verdict = enum { allowed, vetoed, undecided };

/// A recipient's veto, with its reason, or how it left a Decision
/// undecided.
pub const Mark = struct {
    script: []const u8,
    run: []const u8,
    /// A veto's reason.
    reason: ?*Value = null,
    /// How an undecided Run ended.
    outcome: []const u8 = "",
};

/// One recipient's part in a Decision.
pub const Part = union(enum) { allowed, vetoed: Mark, undecided: Mark };

/// A sealed Decision, which the Host reads by its delivery or broadcast
/// id: every veto and every undecided recipient, in recipient order.
pub const Decided = struct {
    verdict: Verdict,
    vetoes: []Mark = &.{},
    undecided: []Mark = &.{},
};

/// A Broadcast Decision some recipient hasn't sealed: each recipient's
/// delivery id and, once sealed, its part.
pub const OpenBroadcast = struct { deliveries: []u64, parts: []?Part };

pub const Run = struct {
    id: []const u8,
    script: *Script,
    /// When it was made among the Group's Runs, which orders its accounting.
    order: u64 = 0,
    /// The Fuel its last `run accounting` report gave, or null before one.
    reported_fuel: ?u64 = null,
    frames: std.ArrayList(Frame) = .empty,
    fuel: u64 = 0,
    alloc: u64 = 0,
    delivery: Delivery,
    handler: []const u8 = "",
    clause: u32 = 0,
    /// Its limits: its Script's, tightened by its Delivery's override.
    limits: Limits = .{},
    /// The `clause` rate dispatch charges with the next instruction.
    clause_fuel: u64 = 0,
    /// The `clause` rate of a clause a Command Call just tried, which its
    /// body's first instruction pays.
    called_clause: u64 = 0,
    /// Preempted in a clause's patterns or Guard: the clause, and whether it
    /// is a Fallback's, from which dispatch goes on.
    preempted_in: ?struct { library: ?*Library, body: u32, fallback: bool } = null,
    /// Whether its next Stretch continues it after a preemption.
    continuing: bool = false,
    /// Named clauses dispatch has counted so far.
    clauses_seen: u32 = 0,
    /// A cancelled Run's Fuel when its cleanup began, which the Cleanup
    /// Budget, not Fuel per Run, bounds from there.
    cleanup_from: ?u64 = null,
    /// Whether a limit ended its cleanup, which rolls the cleanup back.
    cleanup_limited: bool = false,
    /// Its error control: catch dispatches and cleanups, innermost last.
    controls: std.ArrayList(Control) = .empty,
    /// Recovery Offer choices made, which number their records.
    attempts: u64 = 0,
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
    /// Where its last error was raised, which an initialiser's
    /// `initialiser failed` diagnostic names.
    raised_at: ?lower.Position = null,
    /// Where its last error was raised, or it faulted, for its `run end`
    /// report.
    end_at: report.Location = .{},
    /// Keeps the last error's handler alive after a catch releases the error.
    end_handler: ?*Value = null,
    /// How a limit or an error ended its cleanup, once cancelled: the
    /// limit, or the error's code, which it holds.
    cleanup_limit: []const u8 = "",
    cleanup_code: ?*Value = null,
    /// The Join it is in, from `join-start` to its closing `end`.
    join: ?*Join = null,
    /// The body of the Handler Clause it was dispatched to, whose Queueing
    /// Policy it follows.
    clause_body: ?u32 = null,
    /// The unit that body is in: an extension, or null for its Script's own.
    clause_unit: ?*Library = null,
    /// Whether a Fallback clause took its message.
    fallback: bool = false,
    /// While it is dispatched, the pc in its clause body where the clause's
    /// patterns and Guard have passed.
    select_at: ?u32 = null,
    /// Whether it waits in its clause's queue, under `, queued`.
    parked: bool = false,
    /// The calls a cancellation abandoned, which its first cleanup Stretch's
    /// `seg` or `preempt` names; the ids are the Group's.
    abandoned: std.ArrayList([]const u8) = .empty,
    /// The frame count at which running stops: 0, or while a pending
    /// `wait for`'s test body runs, the frames below it.
    base: usize = 0,
    /// Its occupied Capability Scope slots, in opening order.
    scopes: std.ArrayList(OpenScope) = .empty,
    /// The Segments it has ended, so its current one is `.s<segments + 1>`.
    segments: u32 = 0,
    /// Whether it holds its Decision's open Verdict, from a `, deciding`
    /// clause's selection to the end of its first Segment.
    verdict: bool = false,
    /// Its Segment's participant, once a Segment-bound call enrolls one.
    participant: ?Participant = null,
    /// Its record flags before a crossing pause, which the pause leaves
    /// unchanged.
    crossed: ?struct { started: bool, continuing: bool } = null,
    /// An answered `begin` whose follow-up crossing deferred, so the
    /// re-made call doesn't ask for it again.
    begun: ?capabilities.EffectStatus = null,
    /// Its Segment's end, paused at a lifecycle crossing: the outcome it
    /// ended with and how far its cleanup has got.
    ending: ?Ending = null,
    /// A drained Stop, cancellation or Rewind's rollback of its Segment,
    /// paused at a lifecycle crossing.
    cleanup: ?Ending = null,
    /// Cancellation landed in a callback; its rollback may itself pause.
    crossing_cancel: bool = false,
    /// A callback already returned, but landing another Run's control is
    /// waiting for lifecycle acknowledgement. Replaying the instruction
    /// classifies this owned return without invoking or recording it twice.
    returned_op: ?struct { outcome: capabilities.Outcome, charged: u64, valid: bool } = null,
    returned_prop: ?objects.Result = null,
    /// Its Script's Variables when its Segment began, which a failed commit
    /// restores; only for a Script with Segment-bound Operations.
    segment_base: ?[]*Value = null,
    /// A Stop, cancellation or Rewind that landed while it ran, which ends
    /// its Stretch before its next instruction; a Stop's reason is owned.
    landed: ?union(enum) { stop: []const u8, cancel, rewind } = null,
};

/// A Segment's participant: its Segment Coordinator and the Grants enrolled
/// in it, in enrollment order.
/// A Segment end paused at a lifecycle crossing (embedding/scoped-effects.md).
pub const Ending = struct {
    outcome: Group.Outcome,
    stage: enum { abandon, finalize, commit_rollback, rollback } = .abandon,
    /// The first failed abandonment on a participating Grant.
    prevented: ?EffectFailure = null,
    /// A failed commit, which its rollback follows.
    failure: ?EffectFailure = null,
    /// Whether the effects' state is unknown, which stops the Group once
    /// the lifecycle completes, not while a crossing is paused.
    fatal: bool = false,
};

pub const Participant = struct {
    coordinator: capabilities.Coordinator,
    grants: std.ArrayList(*ScriptGrant) = .empty,
};

/// An effect failure that ends a Run `effect failed` (chapter 6, Effect
/// failures).
pub const EffectFailure = struct { grant: []const u8, phase: []const u8, status: []const u8, scope: ?[]const u8 = null };

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
    /// Whether another member's failure failed the Join first, so it no
    /// longer waits and a later answer for it is late.
    cut: bool = false,
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
    /// It leaves its clause's queue, to run from its first instruction.
    unparked,
    /// It was cancelled, and runs its `finally` blocks.
    cancelled,
    /// A restored call no settlement reached by the first Pump.
    lost,
    /// A reissued call whose `Charge` the Run couldn't cover: it faults at
    /// the call.
    limited,
    /// A reissued call through a Grant the restore couldn't re-bind.
    revoked,
};

pub const Failure = struct { code: []const u8, message: ?[]const u8, data: ?*Value };

/// A suspended Run's wait, with its deadline in nanoseconds: a suspending
/// Capability call or a `wait`.
/// Marks a Capability call whose wait ends without its answer abandoned.
fn abandonCall(p: *const Pending) void {
    if (p.call) |c| c.abandoned.store(true, .release);
}

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
    /// Its entry in the event table of the unit it is in: an extension's,
    /// or null for its Script's own.
    library: ?*Library = null,
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

/// A `finally` block a cleanup runs: its frame, its cleanup copy, the
/// stack depth it starts at and its entry. `leave` ends the dispatch under
/// the cleanup, once a policy's own `finally` blocks have run.
pub const Cleanup = struct { frame: usize = 0, target: u32 = 0, depth: u32 = 0, entry: usize = 0, leave: bool = false };

/// A chosen Recovery Offer, entered once the cleanup it waits on ends:
/// the offering frame, its `offer` entry, its record and its place in it.
pub const Transfer = struct { frame: usize, offer_entry: usize, record: u32, offer: u32, args: []*Value, attempt: u64, limit: ?Limit };

/// What a cleanup does after its last `finally` block.
pub const Then = union(enum) { accept: Accept, end, cancel, transfer: Transfer, search: Search };

/// A search bound: down to `frame`, and in it only the entries before
/// `entry`, which lie inside the policy or `finally` block that bounds it.
pub const Limit = struct { frame: usize, entry: usize };

/// Where a catch search is: the frame and the first entry in it still to
/// test, the top frame's place, its bound, the frames below `position`
/// it has yet to charge for leaving, and the entries `skip` says already
/// ran their `finally` blocks.
pub const Search = struct { frame: usize, entry: usize, raised: u32, limit: ?Limit, position: usize, skip: ?Limit = null };

/// A catch's tests, or a Recovery policy, running in a dispatch activation
/// of frame `owner`. The failed frames above it are held aside; the owner's
/// own stack and pc wait in `owner_stack` and `owner_pc`. `search` goes on
/// from the next entry when the catch declines.
pub const Dispatch = struct {
    err: *Value,
    owner: usize,
    place: u32,
    held: []Frame,
    owner_stack: std.ArrayList(Slot),
    owner_pc: u32,
    search: Search,
};

/// A Run's error control, innermost last (chapter 8, The Unwind Table).
pub const Control = union(enum) { dispatch: Dispatch, cleanup: Unwinding };

pub const Unwinding = struct {
    err: *Value,
    cleanups: std.ArrayList(Cleanup),
    next: usize = 0,
    then: Then,
    /// Whether its `leave` has ended the dispatch under it.
    left: bool = false,
    /// The logical size of the operand stack its cleanup copy cut from
    /// the failed continuation of frame `failed_frame`, which stays
    /// retained while the cleanup runs (chapter 8, Pending cleanup state).
    failed: u64 = 0,
    failed_frame: ?usize = null,
};

pub const Script = struct {
    name: []const u8,
    identity: [32]u8,
    /// The arena that owns its name, Grants and objects.
    arena: std.heap.ArenaAllocator,
    /// The arena that owns its source and code unit, which a Reload
    /// replaces.
    code: std.heap.ArenaAllocator,
    source: []const u8 = "",
    unit: lower.Unit,
    /// Its extensions, in the order made, each a code unit of its own
    /// (chapter 10, Extend Script). It owns them.
    extensions: std.ArrayList(*Library) = .empty,
    /// Its code's generation, which a Reload replaces: a Function Value made
    /// under an older one is stale.
    generation: u64 = 0,
    /// The names its units declare or import, in the order declared, as an
    /// extension inherits them; in `code`.
    names: std.ArrayList(check.Inherited) = .empty,
    variables: []*Value,
    definitions: []*Value,
    /// Its work, in the order each became ready.
    work: std.ArrayList(Work) = .empty,
    /// Its Runs that are suspended or ready, which its state counts.
    live: std.ArrayList(*Run) = .empty,
    /// Whether any of its Grants has Segment-bound Operations, so its Runs
    /// keep a Segment base.
    effects: bool = false,
    runs: u64 = 0,
    /// The Fuel and allocation of its Runs that have ended, and how many
    /// ended in a Limit Fault, for its Counters.
    fuel_total: u64 = 0,
    alloc_total: u64 = 0,
    faults: u64 = 0,
    /// The Script's Grants, by the name it uses, with the Operations it
    /// keeps.
    grants: []ScriptGrant = &.{},
    /// The object it is the Owning Script of, which is `me`.
    owner: ?*objects.Object = null,
    /// Its well-known objects, by name.
    objects: []NamedObject = &.{},
    /// The Libraries its `use` lines import.
    imports: []*Library = &.{},
    limits: Limits = .{},
    /// This Pump's Fuel Slice, less the debt it pays, and the Fuel its Runs
    /// have spent in this Pump; the overrun it carries to its next Pump.
    allowance: u64 = 0,
    spent: u64 = 0,
    debt: u64 = 0,
    /// Why it was stopped, once it has been; Stop is sticky.
    stopped: ?[]const u8 = null,

    pub fn object(s: *const Script, name: []const u8) ?*objects.Object {
        for (s.objects) |o| if (std.mem.eql(u8, o.name, name)) return o.object;
        return null;
    }

    pub fn grant(s: *const Script, name: []const u8) ?*ScriptGrant {
        for (s.grants) |*g| if (std.mem.eql(u8, g.name, name)) return g;
        return null;
    }

    /// Every Script Variable's name, in its variables table's order: the
    /// newest unit's table, since an extension's starts with the Script's.
    pub fn variableNames(s: *const Script) []const []const u8 {
        if (s.extensions.items.len > 0) return s.extensions.items[s.extensions.items.len - 1].unit.variables;
        return s.unit.variables;
    }

    /// The unit holding the Handler or Fallback `name`, null for the
    /// Script's own: none, or its first.
    pub fn handlerUnit(s: *const Script, name: []const u8, kind: lower.BodyKind) ?Place {
        for (s.unit.bodies) |b| if (b.kind == kind and std.mem.eql(u8, b.name, name)) return .{ .library = null };
        for (s.extensions.items) |x| for (x.unit.bodies) |b| if (b.kind == kind and std.mem.eql(u8, b.name, name)) return .{ .library = x };
        return null;
    }

    /// One of its units: its own for null, or an extension.
    pub fn unitIn(s: *const Script, library: ?*Library) *const lower.Unit {
        return if (library) |l| &l.unit else &s.unit;
    }

    /// Whether one of its units declares or imports the name.
    pub fn hasName(s: *const Script, name: []const u8) bool {
        for (s.variableNames()) |n| if (std.mem.eql(u8, n, name)) return true;
        for (s.names.items) |n| if (std.mem.eql(u8, n.name, name)) return true;
        return false;
    }

    /// An extension's definition's value: `@<unit>:<name>`, a Constant of
    /// one of the Script's units, or an imported Library's.
    fn inheritedDefinition(s: *const Script, d: []const u8, imports: []const *Library) !?*Value {
        const colon = std.mem.indexOfScalar(u8, d, ':') orelse return null;
        if (d[0] != '@') return importedDefinition(imports, d);
        const unit = d[1..colon];
        const name = d[colon + 1 ..];
        const from: struct { names: []const []const u8, values: []*Value } = if (std.mem.eql(u8, unit, s.name)) .{ .names = s.unit.definitions, .values = s.definitions } else for (s.extensions.items) |x| {
            if (std.mem.eql(u8, x.name, unit)) break .{ .names = x.unit.definitions, .values = x.definitions };
        } else return null;
        for (from.names, from.values) |n, v| if (std.mem.eql(u8, n, name)) return v.retain();
        return null;
    }
};

/// Whether any of `imports` is one of `old` that `next` replaces.
fn changed(imports: []const *Library, old: []const *Library, given: []const *Library) bool {
    for (imports) |im| if (std.mem.indexOfScalar(*Library, old, im)) |j| if (given[j] != old[j]) return true;
    return false;
}

/// Call id order: Script name first, then the numeric Run counter, then the
/// numeric call counter, as in `shop/r2.c10`.
pub fn callOrder(x: []const u8, y: []const u8) bool {
    const Parts = struct {
        script: []const u8,
        run: u64,
        call: u64,
        fn of(id: []const u8) @This() {
            const slash = std.mem.lastIndexOfScalar(u8, id, '/') orelse return .{ .script = id, .run = 0, .call = 0 };
            const dot = std.mem.lastIndexOfScalar(u8, id, '.') orelse id.len;
            const run = std.fmt.parseInt(u64, id[slash + 2 .. @max(dot, slash + 2)], 10) catch 0;
            const call = if (dot + 2 <= id.len) std.fmt.parseInt(u64, id[dot + 2 ..], 10) catch 0 else 0;
            return .{ .script = id[0..slash], .run = run, .call = call };
        }
    };
    const a = Parts.of(x);
    const b = Parts.of(y);
    switch (std.mem.order(u8, a.script, b.script)) {
        .lt => return true,
        .gt => return false,
        .eq => {},
    }
    if (a.run != b.run) return a.run < b.run;
    return a.call < b.call;
}

/// An extended Script's code identity (chapter 10, Extend Script).
pub fn extendedIdentity(previous: [32]u8, extension: [32]u8) [32]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(&std.fmt.bytesToHex(previous, .lower));
    h.update("\nextend\n");
    h.update(&std.fmt.bytesToHex(extension, .lower));
    h.update("\n");
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

/// Where code is: a Library's or extension's unit, or for null its Run's
/// Script's own.
pub const Place = struct { library: ?*Library };

/// A compiled Library (chapter 7): its code unit, its Constants, which are
/// pure and so shared by every Group that holds it, and the Libraries it
/// imports. A Core compiles each once.
pub const Library = struct {
    gpa: Allocator,
    arena: std.heap.ArenaAllocator,
    name: []const u8,
    version: []const u8,
    source: []const u8,
    identity: [32]u8,
    unit: lower.Unit,
    definitions: []*Value,
    /// The Libraries its `use` lines import, in the order first named.
    imports: []*Library,
    exports: []const check.Export,
    /// Every Capability call it makes, through its imports too.
    needs: []const check.Need,
    /// Its `needs` as the Host reads them: each Grant name and Operation
    /// once, sorted by both (chapter 7).
    operations: []const OperationRef = &.{},
    stdlib: bool = false,
    /// The Grant declarations it was compiled against, which recompiling it
    /// for a replaced import uses again; null for none. It holds a
    /// reference to each Shape.
    declarations: ?[]const capabilities.GrantDecls = null,
    /// For a Script's extension, its number since the Script's last Load or
    /// Reload, which names it `<script>+<n>`; 0 for a Library.
    extension: u32 = 0,

    pub fn destroy(l: *Library) void {
        releaseDeclarations(l.declarations);
        for (l.definitions) |v| v.release();
        l.gpa.free(l.definitions);
        for (l.unit.values) |v| if (v == .value) v.value.release();
        var arena = l.arena;
        l.gpa.destroy(l);
        arena.deinit();
    }

    fn function(l: *const Library, name: []const u8) ?u32 {
        for (l.unit.bodies, 0..) |b, i| if (b.kind == .function and std.mem.eql(u8, b.name, name)) return @intCast(i);
        return null;
    }

    fn handler(l: *const Library, name: []const u8) bool {
        for (l.unit.bodies) |b| if (b.kind == .handler and std.mem.eql(u8, b.name, name)) return true;
        return false;
    }
};

pub const Compiled = union(enum) {
    library: *Library,
    /// The source failed to parse or check: its diagnostics.
    refused: []const Diagnostic,
};

/// A diagnostic with its position, as a `diag` record writes it.
pub const Diagnostic = struct { code: []const u8, line: u32, column: u32 };

/// Compiles a Library against the Libraries it imports, which must hold
/// every one its `use` lines name besides the stdlib's.
pub fn compileLibrary(gpa: Allocator, name: []const u8, label: []const u8, source: []const u8, given: []const *Library, declarations: ?[]const capabilities.GrantDecls) !Compiled {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    var owns_arena = true;
    defer if (owns_arena) arena.deinit();
    const kept = arena.allocator();
    var scratch: std.heap.ArenaAllocator = .init(gpa);
    defer scratch.deinit();
    const a = scratch.allocator();
    const src = try kept.dupe(u8, source);
    var lines: lexer.Lines = try .init(a, src);
    const refused = struct {
        fn one(al: Allocator, ls: *lexer.Lines, code: []const u8, offset: usize) ![]const Diagnostic {
            const p = ls.position(offset);
            const out = try al.alloc(Diagnostic, 1);
            out[0] = .{ .code = code, .line = @intCast(p.line), .column = @intCast(p.column) };
            return out;
        }
    };
    const tree = switch (try parser.parseWithScratch(a, gpa, src)) {
        .failure => |d| {
            const diags = try refused.one(gpa, &lines, d.code.spelling(), d.offset);
            return .{ .refused = diags };
        },
        .tree => |t| t,
    };
    const t = try a.create(ast.Tree);
    t.* = tree;
    const imports = try resolveImports(kept, t, given);
    var views: std.ArrayList(check.Library) = .empty;
    for (given) |l| try views.append(a, .{ .name = l.name, .exports = l.exports });
    var context: check.Context = .{ .library = true, .libraries = views.items };
    // Grant declarations by the names its source uses: the modes and
    // Shapes its Capability calls are checked and lowered against.
    // They are kept, their Shapes retained, for recompiling it.
    var shapes_kept = false;
    const grant_declarations: ?[]const capabilities.GrantDecls = if (declarations) |named| blk: {
        const declared = try kept.alloc(capabilities.GrantDecls, named.len);
        for (named, declared) |n, *k| {
            const checks = try kept.alloc(capabilities.OperationCheck, n.operations.len);
            for (n.operations, checks) |o, *x| x.* = .{ .name = try kept.dupe(u8, o.name), .mode = o.mode, .args = try kept.dupe(*capabilities.Shape, o.args) };
            k.* = .{ .name = try kept.dupe(u8, n.name), .operations = checks };
        }
        for (declared) |k| for (k.operations) |o| for (o.args) |x| {
            _ = x.retain();
        };
        shapes_kept = true;
        break :blk declared;
    } else null;
    // Until the Library holds them, on a refusal too.
    defer if (shapes_kept) releaseDeclarations(grant_declarations);
    if (grant_declarations) |named| {
        const viewed = try a.alloc(check.Grant, named.len);
        for (named, viewed) |n, *v| v.* = .{ .name = n.name, .operations = try capabilities.declaredOperations(a, n.operations) };
        context.grants = viewed;
    }
    const checked = try check.check(a, t, context);
    if (checked.diagnostics.len > 0) {
        const diags = try gpa.alloc(Diagnostic, checked.diagnostics.len);
        for (checked.diagnostics, diags) |d, *x| {
            const p = lines.position(d.offset);
            x.* = .{ .code = d.code.spelling(), .line = @intCast(p.line), .column = @intCast(p.column) };
        }
        return .{ .refused = diags };
    }
    const own_name = try kept.dupe(u8, name);
    const temporary = try lower.lower(a, t, &checked, .{ .name = own_name, .context = context, .values = gpa, .scratch = gpa });
    var owns_values = true;
    errdefer if (owns_values) for (temporary.values) |v| if (v == .value) v.value.release();
    const storage = @import("../lower/storage.zig");
    const unit = try storage.copy(kept, temporary);
    const exports_view = try check.exportsWithScratch(gpa, gpa, t, &checked);
    defer gpa.free(exports_view);
    const exported = try storage.copy(kept, exports_view);
    var needs: std.ArrayList(check.Need) = .empty;
    try needs.appendSlice(a, checked.needs);
    for (imports) |l| try needs.appendSlice(a, l.needs);
    const held_needs = try storage.copy(kept, needs.items);
    const operations = try operationRefs(kept, held_needs);
    const version_label = try kept.dupe(u8, label);
    const l = try gpa.create(Library);
    l.* = .{
        .gpa = gpa,
        .arena = arena,
        .name = own_name,
        .version = version_label,
        .source = src,
        .identity = codeIdentity(name, source, .library, imports),
        .unit = unit,
        .definitions = &.{},
        .imports = imports,
        .exports = exported,
        .needs = held_needs,
        .operations = operations,
        .declarations = grant_declarations,
    };
    owns_arena = false;
    owns_values = false;
    shapes_kept = false;
    errdefer l.destroy();
    // Its Constants and defaults: its initialiser, which may use only
    // literals, Constants and Built-ins, run once.
    var group: Group = .init(gpa, null);
    defer group.deinit();
    l.definitions = try group.newValues(unit.definitions.len, unit.definitions, imports);
    var host: Script = .{ .name = own_name, .identity = l.identity, .arena = .init(gpa), .code = .init(gpa), .unit = unit, .variables = &.{}, .definitions = l.definitions };
    var run: Run = .{ .id = "", .script = &host, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
    defer {
        group.abandonUnwinding(&run);
        while (run.frames.items.len > 0) group.popFrame(&run);
        run.frames.deinit(gpa);
        if (run.end_handler) |h| h.release();
    }
    try group.pushFrame(&run, 0, &.{});
    switch (try group.execute(&run, false)) {
        .returned => |v| v.release(),
        .errored => |v| {
            // `initialiser failed`, at the raising instruction.
            v.release();
            const at = run.raised_at orelse lower.Position{ .line = 1, .column = 1 };
            const diags = try gpa.alloc(Diagnostic, 1);
            diags[0] = .{ .code = "initialiser failed", .line = at.line, .column = at.column };
            l.destroy();
            return .{ .refused = diags };
        },
        else => {},
    }
    return .{ .library = l };
}

/// The Libraries a unit's `use` lines name, in the order first named: from
/// those given, or the stdlib's.
fn resolveImports(a: Allocator, t: *const ast.Tree, given: []const *Library) ![]*Library {
    var out: std.ArrayList(*Library) = .empty;
    for (t.declarations) |d| if (d.data == .use) {
        const name = t.text(d.data.use.library);
        const found = for (given) |l| {
            if (std.mem.eql(u8, l.name, name)) break l;
        } else stdlibLibrary(name) orelse continue;
        for (out.items) |x| {
            if (x == found) break;
        } else try out.append(a, found);
    };
    return out.items;
}

/// An imported Constant's value, for a definition named `<library>:<name>`.
fn importedDefinition(imports: []const *Library, d: []const u8) !?*Value {
    const colon = std.mem.indexOfScalar(u8, d, ':') orelse return null;
    for (imports) |l| if (std.mem.eql(u8, l.name, d[0..colon])) {
        for (l.unit.definitions, l.definitions) |n, v| if (std.mem.eql(u8, n, d[colon + 1 ..])) return v.retain();
    };
    return null;
}

/// The process's allocator for the stdlib Libraries, which live as long as
/// the process.
const process_allocator = if (@import("builtin").target.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.smp_allocator;
var stdlib_compiled: [stdlib_sources.len]?*Library = @splat(null);

/// A stdlib Library, compiled the first time a unit imports it.
pub fn stdlibLibrary(name: []const u8) ?*Library {
    for (stdlib_sources, 0..) |src, i| {
        if (!std.mem.eql(u8, src.name, name)) continue;
        if (stdlib_compiled[i]) |l| return l;
        const compiled = compileLibrary(process_allocator, src.name, version.language, src.source, &.{}, null) catch return null;
        switch (compiled) {
            .library => |l| {
                l.stdlib = true;
                lower.lowerStdlibIntrinsics(&l.unit);
                stdlib_compiled[i] = l;
                return l;
            },
            .refused => return null,
        }
    }
    return null;
}

/// The code a Function Value runs: its Home Script, the unit its body is
/// in, a Library's or else the Home Script's own, and the body. A Group
/// keeps one for each, so a value's identity says which.
pub const FunctionCode = struct {
    home: []const u8,
    library: ?*Library,
    body: u32,
    /// Its Home Script's code generation when it was made.
    generation: u64,
    /// What `functionName` and `functionArity` read, which a stale value
    /// still answers: its name, empty for a Lambda, and its parameters
    /// without defaults and in all.
    name: []const u8 = "",
    required: usize = 0,
    total: usize = 0,
    /// The code identity of the unit that defines it, which a Host's tooling
    /// finds its source and documentation by, stale or not.
    unit: [32]u8 = @splat(0),
};

/// The messages waiting in a Script's mailbox; its Runs don't count.
/// A Run's number, from its id `<script>/r<n>`.
fn runNumber(id: []const u8) u64 {
    const at = std.mem.lastIndexOfScalar(u8, id, 'r') orelse return 0;
    return std.fmt.parseInt(u64, id[at + 1 ..], 10) catch 0;
}

/// Text in the Trace's quoted form.
fn writeText(out: *std.Io.Writer, text: []const u8) void {
    out.writeByte('"') catch {};
    for (text) |c| switch (c) {
        '"' => out.writeAll("\\\"") catch {},
        '\\' => out.writeAll("\\\\") catch {},
        else => out.writeByte(c) catch {},
    };
    out.writeByte('"') catch {};
}

/// The Fuel a Run may still spend: what its Fuel per Run leaves, or in a
/// cancelled Run's cleanup, what its Cleanup Budget leaves.
fn fuelLeft(run: *const Run) u64 {
    if (run.cleanup_from) |from| return run.limits.cleanup_budget -| (run.fuel - from);
    return run.limits.fuel_per_run -| run.fuel;
}

/// The operands an instruction is about to pop, retained until it ends,
/// so that an Error-mode cleanup can count them on the failed
/// continuation's stack. Only an instruction in a `finally` block's scope
/// in its own frame needs them; `throw`'s operand becomes its Error.
const Operands = struct {
    buffer: [8]Slot = undefined,
    more: []Slot = &.{},
    len: usize = 0,

    fn take(o: *Operands, gpa: Allocator, unit: *const lower.Unit, frame: *const Frame, pc: u32, ins: lower.Instruction) !void {
        if (ins.op == .throw or frame.stack.items.len == 0) return;
        const protected = for (unit.unwind) |e| {
            if (e.kind == .finally and e.first <= pc and pc <= e.last) break true;
        } else false;
        if (!protected) return;
        const n = verify.popCount(unit, ins) orelse return;
        if (n == 0 or n > frame.stack.items.len) return;
        const out = if (n <= o.buffer.len) o.buffer[0..n] else blk: {
            o.more = try gpa.alloc(Slot, n);
            break :blk o.more;
        };
        for (out, frame.stack.items[frame.stack.items.len - n ..]) |*x, slot| x.* = retainSlot(slot);
        o.len = n;
    }

    fn slots(o: *const Operands) []const Slot {
        return if (o.more.len > 0) o.more else o.buffer[0..o.len];
    }

    fn release(o: *Operands, gpa: Allocator) void {
        for (o.slots()) |slot| slot.release(gpa);
        if (o.more.len > 0) gpa.free(o.more);
        // Only these fields describe live slots. take writes every retained
        // slot before publishing len; resetting the unused buffer needlessly
        // copies bytes that describe no owned state.
        o.more = &.{};
        o.len = 0;
    }
};

test "operand storage is reusable after inline, overflow, empty and refused retention" {
    const gpa = std.testing.allocator;
    const value = try model.text(gpa, "retained operand");
    defer value.release();
    const unit: lower.Unit = .{
        .name = "test",
        .library = false,
        .constants = &.{},
        .values = &.{},
        .definitions = &.{},
        .variables = &.{},
        .objects = &.{},
        .bodies = &.{},
        .code = &.{},
        .offers = &.{},
        .events = &.{},
        .unwind = &.{.{ .first = 0, .last = 0, .kind = .finally, .target = 1, .depth = 0 }},
    };
    var stack: [9]Slot = @splat(.{ .value = value });
    var frame: Frame = .{ .body = 0, .pc = 0, .locals = &.{} };
    frame.stack.items = &stack;
    var held: Operands = .{};
    defer held.release(gpa);
    // Change between overflow and inline storage, then skip retention with
    // stale bytes still present. Only live slots may be read or released.
    for ([_]i64{ 9, 8, 1, 0, 9, 1 }) |n| {
        const ins: lower.Instruction = .{ .op = .list, .operands = &.{.{ .int = n }}, .position = .{ .line = 1, .column = 1 }, .note = "" };
        try held.take(gpa, &unit, &frame, 0, ins);
        try std.testing.expectEqual(@as(usize, @intCast(n)), held.slots().len);
        try std.testing.expectEqual(@as(usize, @intCast(n)) + 1, value.references);
        // Every live retained slot remains readable until release.
        for (held.slots()) |slot| try std.testing.expectEqualStrings("retained operand", slot.value.data.text);
        held.release(gpa);
        try std.testing.expectEqual(@as(usize, 1), value.references);
        try std.testing.expectEqual(@as(usize, 0), held.slots().len);
    }
    const ins: lower.Instruction = .{ .op = .list, .operands = &.{.{ .int = 9 }}, .position = .{ .line = 1, .column = 1 }, .note = "" };
    var failing: std.testing.FailingAllocator = .init(gpa, .{ .fail_index = 0 });
    try std.testing.expectError(error.OutOfMemory, held.take(failing.allocator(), &unit, &frame, 0, ins));
    held.release(gpa);
    try held.take(gpa, &unit, &frame, 1, ins); // outside the finally scope
    held.release(gpa);
    var thrown = ins;
    thrown.op = .throw;
    try held.take(gpa, &unit, &frame, 0, thrown);
    held.release(gpa);
    try std.testing.expectEqual(@as(usize, 1), value.references);
    try held.take(gpa, &unit, &frame, 0, ins);
    try std.testing.expectEqual(@as(usize, 10), value.references);
}

/// A retained frame's size: its slots, their values and its operand stack.
fn frameSize(f: *const Frame) u64 {
    return frameHeader(f) + stackSize(f.stack.items);
}

/// A frame's size without its operand stack: its header and locals.
fn frameHeader(f: *const Frame) u64 {
    var total: u64 = 64 + 8 * f.locals.len;
    for (f.locals) |v| total += costs.size(v);
    return total;
}

/// The size of a stack's first `n` slots.
fn prefixSize(stack: []const Slot, n: u32) u64 {
    return stackSize(stack[0..@min(n, stack.len)]);
}

/// The stack prefix the `finally` entries of frame `f` covering `place`
/// need, only those before `before` if given, or null when none does.
fn finallyPrefix(run: *const Run, f: *const Frame, place: u32, before: ?usize) ?u32 {
    const unit = unitOf(run, f);
    const body = unit.bodies[f.body];
    var depth: ?u32 = null;
    for (unit.unwind, 0..) |e, ei| {
        if (e.kind != .finally or e.first > place or place > e.last) continue;
        if (e.first < body.first or e.last > body.last) continue;
        if (before) |b| if (ei >= b) continue;
        depth = @max(depth orelse 0, e.depth);
    }
    return depth;
}

fn stackSize(stack: []const Slot) u64 {
    var total: u64 = 0;
    for (stack) |slot| total += switch (slot) {
        .value => |v| if (v.script_name) 0 else costs.size(v),
        .iterator => |it| 24 + if (it.subject) |v| costs.size(v) else 0,
        .reader => |r| 24 + costs.size(r.subject),
        .replacement => |r| 32 + costs.size(r.text) + costs.contents(r.matches),
        .deadline => 40,
    };
    return total;
}

fn mailboxLen(s: *const Script) u64 {
    var n: u64 = 0;
    for (s.work.items) |w| if (w == .message) {
        n += 1;
    };
    return n;
}

/// A limit's default, by its `ts` name in `limits.toml`.
fn limitDefault(comptime ts: []const u8) u64 {
    for (limits_table.limit) |l| if (std.mem.eql(u8, l.ts, ts)) return @intCast(l.default);
    unreachable;
}

/// A Script's limits (chapter 6, Limits): MaxWait in whole milliseconds,
/// and every other limit in its own unit.
pub const Limits = struct {
    fuel_per_run: u64 = limitDefault("fuelPerRun"),
    alloc_per_run: u64 = limitDefault("allocPerRun"),
    persistent_state: u64 = limitDefault("persistentState"),
    call_depth: u64 = limitDefault("callDepth"),
    pattern_size: u64 = limitDefault("patternSize"),
    mailbox_depth: u64 = limitDefault("mailboxDepth"),
    max_wait_ms: u64 = limitDefault("maxWaitMs"),
    max_join: u64 = limitDefault("maxJoin"),
    cleanup_budget: u64 = limitDefault("cleanupBudget"),
};

/// A Script's limits in `limits.toml`'s order.
fn limitValues(l: Limits) [limits_table.limit.len]u64 {
    var out: [limits_table.limit.len]u64 = undefined;
    inline for (@typeInfo(Limits).@"struct".field_names, 0..) |f, i| out[i] = @field(l, f);
    return out;
}

/// A Delivery's override of the per-Run limits it may tighten.
pub const Override = struct {
    fuel_per_run: ?u64 = null,
    alloc_per_run: ?u64 = null,
    max_wait_ms: ?u64 = null,
    max_join: ?u64 = null,

    /// Whether it would loosen one of `l`.
    pub fn loosens(o: Override, l: Limits) bool {
        if (o.fuel_per_run) |x| if (x > l.fuel_per_run) return true;
        if (o.alloc_per_run) |x| if (x > l.alloc_per_run) return true;
        if (o.max_wait_ms) |x| if (x > l.max_wait_ms) return true;
        if (o.max_join) |x| if (x > l.max_join) return true;
        return false;
    }

    /// `l` tightened by it.
    fn apply(o: ?Override, l: Limits) Limits {
        var out = l;
        const x = o orelse return out;
        if (x.fuel_per_run) |v| out.fuel_per_run = v;
        if (x.alloc_per_run) |v| out.alloc_per_run = v;
        if (x.max_wait_ms) |v| out.max_wait_ms = v;
        if (x.max_join) |v| out.max_join = v;
        return out;
    }

    /// Its Trace form: a map from each limit's `ts` name, in
    /// `limits.toml`'s order.
    pub fn write(o: Override, w: *std.Io.Writer) void {
        w.writeAll(" limits={") catch {};
        var first = true;
        inline for (.{ .{ "fuelPerRun", o.fuel_per_run }, .{ "allocPerRun", o.alloc_per_run }, .{ "maxWaitMs", o.max_wait_ms }, .{ "maxJoin", o.max_join } }) |f| if (f[1]) |v| {
            w.print("{s}{s}: {d}", .{ if (first) "" else ", ", f[0], v }) catch {};
            first = false;
        };
        w.writeAll("}") catch {};
    }
};

/// Admission can refuse negative values which an executable Override cannot hold.
pub const RefusedOverride = struct {
    fuel_per_run: ?i64 = null,
    alloc_per_run: ?i64 = null,
    max_wait_ms: ?i64 = null,
    max_join: ?i64 = null,

    pub fn write(o: RefusedOverride, w: *std.Io.Writer) void {
        w.writeAll(" limits={") catch {};
        var first = true;
        inline for (.{ .{ "fuelPerRun", o.fuel_per_run }, .{ "allocPerRun", o.alloc_per_run }, .{ "maxWaitMs", o.max_wait_ms }, .{ "maxJoin", o.max_join } }) |f| if (f[1]) |v| {
            w.print("{s}{s}: {d}", .{ if (first) "" else ", ", f[0], v }) catch {};
            first = false;
        };
        w.writeAll("}") catch {};
    }
};

/// What preempted a Run: its Script's Fuel Slice or the Group's Fuel cap.
pub const Preemption = enum { slice, cap, crossing };

/// The limit a Limit Fault names.
pub const Fault = enum { fuel, alloc, persistent, depth, pattern, join, cleanup };

/// The positions of a unit's Text Pattern literals, those with no splices,
/// whose programs run over `limit` instructions, counting every copy of a
/// counted repetition.
fn oversizedPatterns(a: Allocator, unit: *const lower.Unit, limit: u64) ![]lower.Position {
    var out: std.ArrayList(lower.Position) = .empty;
    for (unit.code) |ins| {
        if (ins.op != .@"const") continue;
        const c = unit.values[@intCast(ins.operands[0].int)];
        if (c != .pattern) continue;
        const elements = matcher.read(a, c.pattern, false) catch continue;
        const program = matcher.compile(a, elements, false) catch continue;
        if (program.code.len > limit) try out.append(a, ins.position);
    }
    return out.items;
}

/// A well-known object the Host binds at Load, by name.
pub const NamedObject = struct { name: []const u8, object: *objects.Object };

/// A Grant the Host binds at Load, by the name the Script uses.
fn releaseDeclarations(declarations: ?[]const capabilities.GrantDecls) void {
    for (declarations orelse return) |k| for (k.operations) |o| for (o.args) |x| x.release();
}

pub const NamedGrant = struct { name: []const u8, grant: *capabilities.Grant };

/// An Operation by the Grant name that calls it, laid out as talk.h's
/// `talk_operation_ref`.
pub const OperationRef = extern struct { capability: [*]const u8, capability_len: usize, operation: [*]const u8, operation_len: usize };

fn refLess(_: void, x: OperationRef, y: OperationRef) bool {
    return switch (std.mem.order(u8, x.capability[0..x.capability_len], y.capability[0..y.capability_len])) {
        .lt => true,
        .gt => false,
        .eq => std.mem.lessThan(u8, x.operation[0..x.operation_len], y.operation[0..y.operation_len]),
    };
}

/// Each distinct Grant name and Operation of `needs`, sorted in code-point
/// order, which UTF-8's byte order is.
fn operationRefs(a: Allocator, needs: []const check.Need) ![]const OperationRef {
    var refs: std.ArrayList(OperationRef) = .empty;
    for (needs) |n| {
        const ref: OperationRef = .{ .capability = n.grant.ptr, .capability_len = n.grant.len, .operation = n.operation.ptr, .operation_len = n.operation.len };
        for (refs.items) |r| {
            if (!refLess({}, r, ref) and !refLess({}, ref, r)) break;
        } else try refs.append(a, ref);
    }
    std.mem.sort(OperationRef, refs.items, {}, refLess);
    return refs.items;
}

/// A Script's Grant: the Operations it keeps, by index into its
/// Capability's.
/// A Script's named Grant. `disabled` is set when automatic abandonment
/// through it fails, and refuses later calls with `capability disabled`;
/// `revoked` is set by a `revoke` Host Input, and refuses them with
/// `capability revoked`.
pub const ScriptGrant = struct {
    name: []const u8,
    grant: *capabilities.Grant,
    kept: []bool,
    disabled: bool = false,
    revoked: bool = false,
    /// For a Grant a restore couldn't re-bind, its saved Capability and
    /// declarations as the Group Fingerprint writes them.
    declarations: ?[]const u8 = null,
};

/// An occupied Capability Scope slot: its named Grant, its scope and the
/// index of its abandonment Operation.
pub const OpenScope = struct { grant: *ScriptGrant, name: []const u8, abandon: usize };

/// What a Script is loaded with.
pub const LoadOptions = struct {
    context: check.Context = .{},
    /// The Grants, which also give the checker its view of them.
    grants: ?[]const NamedGrant = null,
    /// Keep only the granted Operations the Script uses.
    grants_as_used: bool = false,
    /// The object the Script becomes the Owning Script of.
    owner: ?*objects.Object = null,
    /// Its well-known objects, which also give the checker their kinds.
    objects: []const NamedObject = &.{},
    limits: Limits = .{},
};

pub const LoadResult = union(enum) {
    loaded: *Script,
    /// The diagnostics, as `diag` records were written.
    refused: usize,
};

/// An open Decision a variables-only restore discarded: its delivery and
/// broadcast ids, and its recipient's mark, owned; or a Broadcast Decision
/// dropped before it had recipients, with none.
pub const Deferred = struct { id: u64, broadcast: u64 = 0, mark: ?Mark = null };

/// What a restored Group keeps until its first Pump (chapter 10, Settling
/// pending calls): the calls still pending, in call id order, and those
/// already settled.
pub const Restored = struct {
    pending: std.ArrayList([]const u8) = .empty,
    settled: std.ArrayList([]const u8) = .empty,
    clock: model.dates.Instant,

    pub fn deinit(r: *Restored, gpa: Allocator) void {
        r.pending.deinit(gpa);
        r.settled.deinit(gpa);
    }
};

/// A Host Input made during a Pump that lands at a Host crossing, and
/// whether its line is already written.
pub const Landing = struct { input: Input, written: bool };

/// How the Host settles a restored pending call.
pub const How = enum { answer, fail, reissue, adopt };

pub const Input = union(enum) {
    charge_request: *capabilities.ChargeRequest,
    /// A restored pending call's settlement, by its owned id; an answer's or
    /// failure's Resume.
    settlement: struct { id: []const u8, how: How, with: ?Resume },
    /// A Delivery to a Script, or with an empty name, to its Target.
    deliver: struct { script: []const u8, delivery: Delivery },
    set_parent: struct { object: *objects.Object, parent: ?*objects.Object },
    dispose: *objects.Object,
    /// An answer or failure for a suspending call, by its id.
    settle: struct { id: []const u8, with: Resume },
    /// A Broadcast, or a Broadcast Decision. Its recipients, each with its
    /// delivery id, are found when the queue is drained.
    broadcast: Broadcast,
    /// Revokes a Script's named Grant; both names are owned.
    revoke: struct { script: []const u8, grant: []const u8 },
    /// Cancels a Run, by its owned id.
    cancel_run: []const u8,
    /// Rewinds a Run in its first Segment to its message, by its owned id.
    rewind_run: []const u8,
    /// Stops a Script, with an owned name and reason.
    stop: struct { script: []const u8, reason: []const u8 },
    /// Cancels a Delivery's Run, or the Delivery itself if it is still in
    /// a mailbox.
    cancel_delivery: u64,
};

pub const Broadcast = struct {
    id: u64,
    message: []const u8,
    args: []*Value,
    decision: bool,
    recipients: ?[]Recipient = null,
    limits: ?Override = null,
};

/// A Broadcast's recipient: its Script and its own delivery id.
pub const Recipient = struct { script: *Script, delivery: u64 };

pub const Group = struct {
    gpa: Allocator,
    /// This Pump's Fuel Slice and Fuel cap; 0 for none.
    slice: u64 = 0,
    cap: u64 = 0,
    /// Whether this Pump ended with work its slices or cap left undone.
    sliced: bool = false,
    /// Set when an effect's state is unknown: every Script stops, and the
    /// Group with them.
    fatal: bool = false,
    /// The override the next queued Host Delivery or Broadcast takes.
    override: ?Override = null,
    /// The limit an instruction found passed, with `error.LimitFault`.
    pending_fault: ?Fault = null,
    /// The instruction the run loop is at, where a search it drives faults.
    driving: struct { unit: []const u8 = "", pc: u32 = 0, ins: lower.Instruction = undefined } = .{},
    scripts: std.ArrayList(*Script) = .empty,
    inputs: std.ArrayList(Input) = .empty,
    input_lock: @import("queue_lock.zig").Lock = .{},
    batch: std.ArrayList(Input) = .empty,
    on_ready: ?*const fn (?*anyopaque) callconv(.c) void = null,
    ready_context: ?*anyopaque = null,
    refused_charges: std.ArrayList(struct { call: []const u8, fuel: i64, valid: bool, code: []const u8 }) = .empty,
    deliveries: u64 = 0,
    trace: ?*std.Io.Writer,
    /// Reusable scratch memory for a single instruction.
    scratch: std.heap.ArenaAllocator,
    /// The Fuel of the Pump in progress.
    pump_fuel: u64 = 0,
    /// Request results by delivery id, for the Host.
    results: std.AutoHashMapUnmanaged(u64, *Value) = .empty,
    /// Sealed Decisions by delivery id, and Broadcast Decisions by broadcast
    /// id, for the Host.
    decided: std.AutoHashMapUnmanaged(u64, Decided) = .empty,
    decided_broadcasts: std.AutoHashMapUnmanaged(u64, Decided) = .empty,
    open_broadcasts: std.AutoHashMapUnmanaged(u64, OpenBroadcast) = .empty,
    broadcasts: u64 = 0,
    /// The error an instruction raised, until the run loop takes it.
    pending_error: ?*Value = null,
    /// Whether the Core raised it, so it gets a `message`.
    pending_core: bool = false,
    /// The logical size of the operands of the instruction whose Error is
    /// being unwound, which its failed continuation keeps.
    failing_operands: u64 = 0,
    /// The last Pump's Clock reading, which a Capability call reads.
    clock: model.dates.Instant = .{ .seconds = 0, .nanos = 0 },
    /// No lower bound until the first Pump; Restore supplies its saved bound.
    observed_clock: ?model.dates.Instant = null,
    /// The waits with deadlines, and how many have been set.
    pending: std.ArrayList(*Pending) = .empty,
    timers: u64 = 0,
    /// Suspending calls, which the Host may answer until the Group ends.
    calls: std.ArrayList(*capabilities.Call) = .empty,
    charge_counter: u64 = 0,
    charge_requests: std.ArrayList(*capabilities.ChargeRequest) = .empty,
    /// Every issued id, including immediate/ineligible calls, for transport validation.
    issued_calls: std.StringHashMapUnmanaged(bool) = .empty,
    /// The call ids of `send … and wait`, which waits and records name.
    ids: std.ArrayList([]u8) = .empty,
    /// The Host Objects the Group has handles for, in the order made.
    objects: std.ArrayList(*objects.Object) = .empty,
    /// The Libraries the Host added, besides the stdlib's, which it holds
    /// but doesn't own.
    libraries: std.ArrayList(*Library) = .empty,
    /// The code of each Function Value made, by identity.
    functions: std.ArrayList(*FunctionCode) = .empty,
    /// The code generations given out, so that each is new.
    generations: u64 = 0,
    /// The save attempts made, which number them `s1`, `s2`, …
    saves: u64 = 0,
    /// Whether a Pump is running: a Stop, CancelRun or RewindRun made then
    /// lands at its next Host crossing, or at its end, rather than waiting
    /// for the next Pump (chapter 9, Threads and the input queue).
    pumping: bool = false,
    /// A Host function deferred, so this Pump pauses mid-turn for its
    /// answer; `resumePump` takes the turns up again (the Message Layer).
    crossing_pause: bool = false,
    /// Message Layer opt-in: observe Operation records before landing.
    observe_crossings: bool = false,
    trace_pause: bool = false,
    /// The transport is about to re-enter the callback that paused it.
    /// Its queued controls must follow that callback's record, not land
    /// at the start of the re-made instruction.
    answering_crossing: bool = false,
    /// A suspending Start kept alive across the transport pause.
    starting_call: ?*capabilities.Call = null,
    /// A transport release callback must be acknowledged before more Host
    /// callbacks or Script instructions run. Native hooks leave this false.
    release_pause: bool = false,
    landing_paused: bool = false,
    landing_active: bool = false,
    landing_run: ?*Run = null,
    /// A testing aid: each lifecycle crossing that may defer does so once,
    /// then calls the Host when it is made again, as the Message Layer's
    /// Hosts do. A Trace must not change with it.
    defer_crossings: bool = false,
    deferred_once: bool = false,
    /// Whether the Pump is draining its input queue, where a lifecycle
    /// crossing may defer: the input stays at the queue's head, and
    /// `resumePump` drains on from it.
    draining: bool = false,
    /// Whether a Reload or library replacement is ending the old code's
    /// Runs, where a lifecycle crossing may defer too: the call returns
    /// `paused`, and `resumeWork` goes on from `paused_work`.
    reworking: bool = false,
    paused_work: ?PausedWork = null,
    /// The next Script to take a turn, kept across a crossing pause.
    turn_at: usize = 0,
    landing: std.ArrayList(Landing) = .empty,
    /// What a Host function wrote to the Trace while it ran, inside a Pump:
    /// it follows the crossing's own records.
    held: ?std.Io.Writer.Allocating = null,
    held_trace: ?*std.Io.Writer = null,
    /// Whether a Rewind landed in this Pump, which returns at once.
    rewound: bool = false,
    /// For a restored Group until its first Pump: its pending calls, and the
    /// Clock reading that Pump must not go back before.
    restored: ?Restored = null,
    /// Settle admission closes as the first Pump starts, including while
    /// that Pump is paused in a reissued Start callback.
    settlements_closed: bool = false,
    /// The open Decisions a variables-only restore discarded or dropped,
    /// which its first Pump settles undecided, in delivery id order.
    deferred: std.ArrayList(Deferred) = .empty,
    /// Text a restore rebuilt that the Group's parts borrow, and the
    /// placeholder Capabilities of Grants it couldn't re-bind.
    keep: std.heap.ArenaAllocator,
    /// The reports not yet returned to the Host.
    reports: report.Reports,
    /// The Runs made, which order them for accounting.
    run_order: u64 = 0,
    /// The Runs ended or discarded since the last accounting tail, as their
    /// last report rows.
    ended: std.ArrayList(Ended) = .empty,
    /// The roots whose work changed since the last accounting tail.
    changed_roots: std.AutoArrayHashMapUnmanaged(u64, void) = .empty,
    /// Each root's queued messages a lifecycle discarded, cumulatively.
    root_discards: std.AutoHashMapUnmanaged(u64, u64) = .empty,

    pub fn init(gpa: Allocator, trace: ?*std.Io.Writer) Group {
        return .{ .gpa = gpa, .trace = trace, .scratch = .init(gpa), .keep = .init(gpa), .reports = .init(gpa) };
    }

    /// Worker calls cannot reenter a Pump or code-change lifecycle callback.
    pub fn checkWorker(g: *const Group) error{ReentrantCall}!void {
        if (g.pumping or g.reworking or g.crossing_pause or g.paused_work != null) return error.ReentrantCall;
    }

    fn checkCodeChange(g: *const Group) error{ ReentrantCall, EffectStateUnknown }!void {
        try g.checkWorker();
        if (g.fatal) return error.EffectStateUnknown;
    }

    pub fn deinit(g: *Group) void {
        // A Reload or library replacement left paused holds its built code.
        if (g.paused_work) |work| switch (work) {
            .reload => |x| g.dropFresh(x.fresh),
            .replace => |x| {
                g.dropRebuilt(x.rebuilt);
                for (x.made) |l| l.destroy();
                g.gpa.free(x.made);
                g.gpa.free(x.libraries);
            },
        };
        g.releaseInputs(g.inputs.items);
        for (g.landing.items) |x| g.releaseInputs(&.{x.input});
        g.landing.deinit(g.gpa);
        if (g.held) |*h| h.deinit();
        g.inputs.deinit(g.gpa);
        g.releaseInputs(g.batch.items);
        g.batch.deinit(g.gpa);
        for (g.refused_charges.items) |x| g.gpa.free(x.call);
        g.refused_charges.deinit(g.gpa);
        for (g.objects.items) |o| o.destroy(g.gpa);
        g.objects.deinit(g.gpa);
        g.libraries.deinit(g.gpa);
        for (g.functions.items) |f| {
            g.gpa.free(f.home);
            g.gpa.free(f.name);
            g.gpa.destroy(f);
        }
        g.functions.deinit(g.gpa);
        for (g.charge_requests.items) |q| {
            g.gpa.free(q.id);
            g.gpa.free(q.call);
            g.gpa.destroy(q);
        }
        g.charge_requests.deinit(g.gpa);
        var issued = g.issued_calls.keyIterator();
        while (issued.next()) |id| g.gpa.free(id.*);
        g.issued_calls.deinit(g.gpa);
        for (g.ids.items) |id| g.gpa.free(id);
        g.ids.deinit(g.gpa);
        for (g.scripts.items) |s| g.destroyScript(s);
        g.scripts.deinit(g.gpa);
        // A live Run removed its own wait; any left belongs to none.
        for (g.pending.items) |p| g.destroyPending(p);
        g.pending.deinit(g.gpa);
        for (g.calls.items) |c| {
            g.gpa.free(c.id);
            releaseAll(c.args, g.gpa);
            g.gpa.destroy(c);
        }
        g.calls.deinit(g.gpa);
        // An error raised as an allocation was refused, never taken.
        if (g.pending_error) |e| e.release();
        var it = g.results.valueIterator();
        while (it.next()) |v| v.*.release();
        g.results.deinit(g.gpa);
        inline for (.{ &g.decided, &g.decided_broadcasts }) |map| {
            var decided = map.valueIterator();
            while (decided.next()) |x| g.releaseDecided(x.*);
            map.deinit(g.gpa);
        }
        var open = g.open_broadcasts.valueIterator();
        while (open.next()) |x| g.releaseOpen(x.*);
        g.open_broadcasts.deinit(g.gpa);
        if (g.restored) |*r| r.deinit(g.gpa);
        for (g.deferred.items) |x| if (x.mark) |m| g.releaseMark(m);
        g.deferred.deinit(g.gpa);
        g.scratch.deinit();
        g.keep.deinit();
        g.reports.deinit();
        g.ended.deinit(g.gpa);
        g.changed_roots.deinit(g.gpa);
        g.root_discards.deinit(g.gpa);
    }

    /// Adds a report. Reports are observations: one the Group can't keep is
    /// left out, and execution goes on.
    pub fn addReport(g: *Group, r: report.Report) void {
        g.reports.add(r) catch {};
    }

    // ------------------------------------------------------------ Run accounting

    /// A Run ended or discarded since the last accounting tail, as its row.
    pub const Ended = struct { order: u64, script: []const u8, run: []const u8, ancestry: report.Ancestry, fuel: u64, state: report.RunAccounting.State };

    /// A root whose work changed, for the next accounting tail.
    pub fn markRoot(g: *Group, root: u64) void {
        if (root == 0) return;
        g.changed_roots.put(g.gpa, root, {}) catch {};
    }

    /// A message's ancestry, as the reports hold it: its root, and the Run,
    /// or the call of a Run, that sent it.
    fn ancestry(g: *Group, d: Delivery) !report.Ancestry {
        const r = &g.reports;
        var out: report.Ancestry = .{ .root = try r.print("d{d}", .{rootOf(d)}) };
        const from = d.from orelse return out;
        // A call id is its Run's id, `.c` and a number.
        if (std.mem.lastIndexOf(u8, from, ".c")) |dot| if (dot + 2 < from.len and std.ascii.isDigit(from[dot + 2])) {
            out.parent_run = try r.text(from[0..dot]);
            out.parent_call = try r.text(from);
            return out;
        };
        out.parent_run = try r.text(from);
        return out;
    }

    /// `run started`, as a new Run dispatches, which also places it in the
    /// order of the Group's Runs.
    fn reportRunStarted(g: *Group, s: *const Script, run: *Run) void {
        g.run_order += 1;
        run.order = g.run_order;
        const d = run.delivery;
        g.markRoot(rootOf(d));
        const r = &g.reports;
        const started: report.RunStarted = .{
            .ancestry = g.ancestry(d) catch return,
            .script = r.text(s.name) catch return,
            .run = r.text(run.id) catch return,
            .delivery = if (d.from == null and d.id > 0) r.print("d{d}", .{d.id}) catch return else "",
            .selector = if (d.function == null) r.text(d.message) catch return else "",
            .function = if (d.function) |f| r.value(f) catch return else null,
            .args = r.valueList(d.args) catch return,
        };
        g.addReport(.{ .run_started = started });
    }

    /// A Run's last accounting row, as it ends or is discarded.
    fn endRow(g: *Group, run: *const Run, state: report.RunAccounting.State) void {
        const d = run.delivery;
        g.markRoot(rootOf(d));
        const r = &g.reports;
        g.ended.append(g.gpa, .{
            .order = run.order,
            .script = r.text(run.script.name) catch return,
            .run = r.text(run.id) catch return,
            .ancestry = g.ancestry(d) catch return,
            .fuel = run.fuel,
            .state = state,
        }) catch {};
    }

    /// `run discarded`, for a live Run discarded without a `run end`.
    pub fn discardRun(g: *Group, run: *const Run, reason: []const u8) void {
        const r = &g.reports;
        if (g.ancestry(run.delivery)) |a| {
            g.addReport(.{ .run_discarded = .{ .ancestry = a, .script = r.text(run.script.name) catch "", .run = r.text(run.id) catch "", .reason = reason } });
        } else |_| {}
        g.endRow(run, .discarded);
    }

    /// Counts a queued message a lifecycle discarded against its root.
    pub fn discardMessage(g: *Group, d: Delivery) void {
        const root = rootOf(d);
        if (root == 0) return;
        g.markRoot(root);
        const e = g.root_discards.getOrPut(g.gpa, root) catch return;
        if (!e.found_existing) e.value_ptr.* = 0;
        e.value_ptr.* += 1;
    }

    /// The accounting tail of a Host call (chapter 9, Run accounting): a
    /// `run accounting` row for every Run started, charged, ended or
    /// discarded since the last, in the order the Runs were made, then
    /// `causal work` for every root that changed, in admission order.
    pub fn accountingTail(g: *Group) void {
        g.writeTail() catch {};
        g.ended.clearRetainingCapacity();
        g.changed_roots.clearRetainingCapacity();
    }

    fn writeTail(g: *Group) !void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        var rows: std.ArrayList(Ended) = .empty;
        defer rows.deinit(g.gpa);
        try rows.appendSlice(g.gpa, g.ended.items);
        const r = &g.reports;
        for (g.scripts.items) |s| for (s.live.items) |run| {
            if (run.reported_fuel) |f| if (f == run.fuel) continue;
            try rows.append(g.gpa, .{ .order = run.order, .script = try r.text(s.name), .run = try r.text(run.id), .ancestry = try g.ancestry(run.delivery), .fuel = run.fuel, .state = .live });
            run.reported_fuel = run.fuel;
            g.markRoot(rootOf(run.delivery));
        };
        std.mem.sort(Ended, rows.items, {}, struct {
            fn less(_: void, x: Ended, y: Ended) bool {
                return x.order < y.order;
            }
        }.less);
        for (rows.items) |x| try r.add(.{ .run_accounting = .{ .ancestry = x.ancestry, .script = x.script, .run = x.run, .fuel = x.fuel, .state = x.state } });
        const roots = g.changed_roots.keys();
        std.mem.sort(u64, roots, {}, std.sort.asc(u64));
        for (roots) |root| {
            var live: u64 = 0;
            var queued: u64 = 0;
            for (g.scripts.items) |s| {
                for (s.live.items) |run| live += @intFromBool(rootOf(run.delivery) == root);
                for (s.work.items) |w| switch (w) {
                    .message => |d| queued += @intFromBool(rootOf(d) == root),
                    .run => {},
                };
            }
            for (g.inputs.items) |input| switch (input) {
                .deliver => |x| queued += @intFromBool(rootOf(x.delivery) == root),
                else => {},
            };
            try r.add(.{ .causal_work = .{ .root = try r.print("d{d}", .{root}), .live_runs = live, .queued_messages = queued, .discarded_messages = g.root_discards.get(root) orelse 0 } });
        }
    }

    /// Releases queued Host Inputs never drained.
    pub fn releaseInputs(g: *Group, inputs: []const Input) void {
        for (inputs) |input| switch (input) {
            .deliver => |d| {
                g.releaseDelivery(d.delivery);
                g.gpa.free(d.script);
            },
            .settle => |x| {
                g.gpa.free(x.id);
                g.releaseResume(x.with);
            },
            .broadcast => |b| g.releaseBroadcast(b),
            .revoke => |x| {
                g.gpa.free(x.script);
                g.gpa.free(x.grant);
            },
            .cancel_run, .rewind_run => |id| g.gpa.free(id),
            .settlement => |x| {
                g.gpa.free(x.id);
                if (x.with) |w| g.releaseResume(w);
            },
            .stop => |x| {
                g.gpa.free(x.script);
                g.gpa.free(x.reason);
            },
            .set_parent, .dispose, .cancel_delivery, .charge_request => {},
        };
    }

    pub fn write(g: *Group, comptime fmt: []const u8, args: anytype) void {
        const w = g.trace orelse return;
        w.print(fmt, args) catch {};
    }

    /// Loads a Script: parses, checks and lowers it, and runs its
    /// initialiser. Writes the `load` record and any `diag` records.
    pub fn load(g: *Group, name: []const u8, source: []const u8, options: LoadOptions) !LoadResult {
        try g.checkCodeChange();
        const s = try g.gpa.create(Script);
        s.* = .{ .name = undefined, .identity = undefined, .arena = .init(g.gpa), .code = .init(g.gpa), .unit = undefined, .variables = &.{}, .definitions = &.{}, .limits = options.limits };
        // Until it joins the Group, a refusal leaves nothing of it behind.
        var lowered = false;
        var joined = false;
        errdefer if (!joined) {
            if (lowered) for (s.unit.values) |v| if (v == .value) v.value.release();
            releaseAll(s.variables, g.gpa);
            releaseAll(s.definitions, g.gpa);
            s.code.deinit();
            s.arena.deinit();
            g.gpa.destroy(s);
        };
        const a = s.arena.allocator();
        const ca = s.code.allocator();
        s.name = try a.dupe(u8, name);
        s.source = try ca.dupe(u8, source);
        var parsed = try g.parseCode(ca, s.source);
        defer parsed.deinit();
        s.imports = parsed.imports;
        s.identity = codeIdentity(name, source, .script, s.imports);
        g.write("> load {s} identity={x}\n", .{ name, s.identity });
        const pa = parsed.arena.allocator();
        var context = try g.codeContext(pa, options.context, options.objects, options.owner);
        if (options.grants) |named| {
            const viewed = try pa.alloc(check.Grant, named.len);
            for (named, viewed) |n, *v| v.* = .{ .name = try pa.dupe(u8, n.name), .operations = try capabilities.checkOperations(pa, n.grant) };
            context.grants = viewed;
        }
        var refused: usize = 0;
        const code = try g.lowerCode(ca, name, s.name, &parsed, context, s.limits.pattern_size, &refused) orelse {
            s.code.deinit();
            s.arena.deinit();
            g.gpa.destroy(s);
            return .{ .refused = refused };
        };
        s.unit = code.unit;
        lowered = true;
        try s.names.appendSlice(ca, code.names);
        if (options.grants) |named| s.grants = try keptGrants(a, named, &s.unit, s.imports, options.grants_as_used);
        for (s.grants) |sg| if (sg.grant.coordinator != null) {
            s.effects = true;
        };
        s.objects = try a.alloc(NamedObject, options.objects.len);
        for (options.objects, s.objects) |o, *x| x.* = .{ .name = try a.dupe(u8, o.name), .object = o.object };
        s.variables = try g.newValues(s.unit.variables.len, &.{}, &.{});
        s.definitions = try g.newValues(s.unit.definitions.len, s.unit.definitions, s.imports);
        g.generations += 1;
        s.generation = g.generations;
        const owner_of: ?[]u8 = if (options.owner != null) try g.gpa.dupe(u8, s.name) else null;
        g.scripts.append(g.gpa, s) catch |e| {
            if (owner_of) |x| g.gpa.free(x);
            return e;
        };
        joined = true;
        if (options.owner) |o| {
            s.owner = o;
            if (o.owner_of) |old| g.gpa.free(old);
            o.owner_of = owner_of;
        }
        // An initialiser that raises takes the Script out of the Group.
        if (!try g.initialise(s, null, name)) {
            _ = g.scripts.pop();
            if (s.owner) |o| if (o.owner_of) |x| {
                g.gpa.free(x);
                o.owner_of = null;
            };
            g.destroyScript(s);
            return .{ .refused = 1 };
        }
        return .{ .loaded = s };
    }

    /// A Script's or extension's temporary parse, and the Libraries its
    /// `use` lines import. The import slice lives in the caller's code
    /// storage; the tree and line index live only until `deinit`.
    pub const Parsed = struct {
        arena: std.heap.ArenaAllocator,
        lines: lexer.Lines,
        result: parser.Result,
        imports: []*Library,

        pub fn deinit(self: *Parsed) void {
            var arena = self.arena;
            self.arena = .init(arena.child_allocator);
            arena.deinit();
        }
    };

    pub fn parseCode(g: *Group, a: Allocator, source: []const u8) !Parsed {
        var arena: std.heap.ArenaAllocator = .init(g.gpa);
        errdefer arena.deinit();
        const scratch = arena.allocator();
        const lines: lexer.Lines = try .init(scratch, source);
        const result = try parser.parseWithScratch(scratch, g.gpa, source);
        const imports: []*Library = if (result == .tree) try resolveImports(a, &result.tree, g.libraries.items) else &.{};
        return .{ .arena = arena, .lines = lines, .result = result, .imports = imports };
    }

    /// What a Script's code is checked against, from `base`: its well-known
    /// objects and owner, and the Libraries the Group holds.
    pub fn codeContext(g: *Group, a: Allocator, base: check.Context, bound: []const NamedObject, owner: ?*objects.Object) !check.Context {
        var context = base;
        var held: std.ArrayList(check.Library) = .empty;
        for (g.libraries.items) |l| try held.append(a, .{ .name = l.name, .exports = l.exports });
        context.libraries = held.items;
        const views = try a.alloc(check.Object, bound.len);
        for (bound, views) |o, *v| v.* = .{ .name = try a.dupe(u8, o.name), .kind = o.object.kind.name };
        context.objects = views;
        if (owner) |o| context.owner = o.kind.name;
        const kinds = try a.create(KindsView);
        kinds.* = .{ .objects = bound, .owner = owner };
        context.writable = .{ .context = kinds, .call = KindsView.writable };
        return context;
    }

    /// A lowered unit, and the names it declares or imports, as an
    /// extension inherits them.
    pub const Lowered = struct { unit: lower.Unit, names: []const check.Inherited };

    /// Checks and lowers parsed code in `a`, writing its `diag` records
    /// under `label`: null when refused, with how many in `refused`. A
    /// successful lowering releases the parse storage before keeping code.
    pub fn lowerCode(g: *Group, a: Allocator, label: []const u8, unit_name: []const u8, parsed: *Parsed, context: check.Context, pattern_size: u64, refused: *usize) !?Lowered {
        var arena: std.heap.ArenaAllocator = .init(g.gpa);
        defer arena.deinit();
        const scratch = arena.allocator();
        var checking: std.heap.ArenaAllocator = .init(g.gpa);
        defer checking.deinit();
        var lines = parsed.lines;
        const tree = switch (parsed.result) {
            .failure => |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ label, d.code.spelling(), p.line, p.column });
                refused.* = 1;
                return null;
            },
            .tree => |t| t,
        };
        const t = try scratch.create(ast.Tree);
        t.* = tree;
        const checked = try check.check(checking.allocator(), t, context);
        var diagnostics: std.ArrayList(check.Diagnostic) = .empty;
        try diagnostics.appendSlice(scratch, checked.diagnostics);
        try g.libraryNeeds(scratch, t, context.grants orelse &.{}, &diagnostics);
        std.mem.sort(check.Diagnostic, diagnostics.items, {}, struct {
            fn less(_: void, x: check.Diagnostic, y: check.Diagnostic) bool {
                return x.offset < y.offset;
            }
        }.less);
        if (diagnostics.items.len > 0) {
            for (diagnostics.items) |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ label, d.code.spelling(), p.line, p.column });
            }
            refused.* = diagnostics.items.len;
            return null;
        }
        const unit = try lower.lower(scratch, t, &checked, .{ .name = unit_name, .context = context, .values = g.gpa, .scratch = g.gpa });
        // Its constant pool's values are the Group's until the caller holds
        // the unit.
        errdefer for (unit.values) |v| if (v == .value) v.value.release();
        // A Text Pattern literal over the Script's `patternSize` is a load
        // error, at its opening `<`.
        const oversized = try oversizedPatterns(scratch, &unit, pattern_size);
        if (oversized.len > 0) {
            for (oversized) |p| g.write("diag {s} code=\"pattern too large\" pos={d}:{d}\n", .{ label, p.line, p.column });
            for (unit.values) |v| if (v == .value) v.value.release();
            refused.* = oversized.len;
            return null;
        }
        // What it declares, linked from `@<unit>`, and what its `use` lines
        // import, linked from their Libraries.
        var names: std.ArrayList(check.Inherited) = .empty;
        defer names.deinit(g.gpa);
        const link = try std.fmt.allocPrint(scratch, "@{s}", .{unit_name});
        const exported = try check.exportsWithScratch(g.gpa, g.gpa, t, &checked);
        defer g.gpa.free(exported);
        for (exported) |e| try names.append(g.gpa, .{ .name = e.name, .unit = link, .export_ = e });
        for (t.declarations) |d| if (d.data == .use) {
            const u = d.data.use;
            const library = t.text(u.library);
            for (u.names) |n| {
                const ex = check.libraryExport(context, library, t.text(n)) orelse continue;
                try names.append(g.gpa, .{ .name = t.text(u.rename orelse n), .unit = library, .export_ = ex });
            }
        };
        // Lowered code and names borrow only the source or the checker
        // and lowering storage now. Drop the tree before retaining code.
        parsed.deinit();
        const held = try @import("../lower/storage.zig").copy(a, Lowered{ .unit = unit, .names = names.items });
        return held;
    }

    /// Runs a unit's initialiser once, uncharged: false, with its
    /// `initialiser failed` diagnostic under `label`, when it raises.
    fn initialise(g: *Group, s: *Script, library: ?*Library, label: []const u8) !bool {
        // It runs between Pumps, so no Fuel Slice or Fuel cap preempts it.
        const slice = g.slice;
        const cap = g.cap;
        g.slice = 0;
        g.cap = 0;
        var run: Run = .{ .id = "", .script = s, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
        defer {
            g.slice = slice;
            g.cap = cap;
            g.abandonUnwinding(&run);
            while (run.frames.items.len > 0) g.popFrame(&run);
            run.frames.deinit(g.gpa);
            if (run.end_handler) |h| h.release();
        }
        try g.pushFrameIn(&run, library, 0, &.{});
        switch (try g.execute(&run, false)) {
            .returned => |v| v.release(),
            .errored => |v| {
                // `initialiser failed`, at the raising instruction.
                v.release();
                const at = run.raised_at orelse lower.Position{ .line = 1, .column = 1 };
                g.write("diag {s} code=\"initialiser failed\" pos={d}:{d}\n", .{ label, at.line, at.column });
                return false;
            },
            else => {},
        }
        return true;
    }

    /// The Grants an extension or a Reload is checked against: the
    /// Script's unrevoked ones, each with only the Operations it keeps
    /// (chapter 9, Revoking).
    /// A restore sees the revoked ones too, as the code was checked first.
    pub fn keptView(a: Allocator, grants: []const ScriptGrant, revoked: bool) ![]check.Grant {
        var out: std.ArrayList(check.Grant) = .empty;
        for (grants) |sg| {
            if (sg.revoked and !revoked) continue;
            const v = try out.addOne(a);
            var ops: std.ArrayList(check.Operation) = .empty;
            const all = try capabilities.checkOperations(a, sg.grant);
            var at: usize = 0;
            for (sg.grant.operations, sg.kept) |offered, kept| {
                if (!offered) continue;
                if (kept) try ops.append(a, all[at]);
                at += 1;
            }
            v.* = .{ .name = sg.name, .operations = ops.items };
        }
        return out.items;
    }

    /// Releases a Script's code: its unit's constants, its extensions and
    /// the arena that holds them.
    pub fn dropCode(g: *Group, s: *Script) void {
        for (s.extensions.items) |x| x.destroy();
        s.extensions.deinit(g.gpa);
        for (s.unit.values) |v| if (v == .value) v.value.release();
        s.code.deinit();
    }

    pub const ExtendResult = enum { extended, refused, name_reused, state_too_large };

    /// Extend Script (chapter 10): compiles an Entry as a new code unit of
    /// the Script, whose names resolve to the Script's as well as its own,
    /// and runs its initialiser. A LoadError, a name the Script already has,
    /// or a Persistent State over its cap leaves the Script unchanged.
    pub fn extend(g: *Group, s: *Script, source: []const u8) !ExtendResult {
        try g.checkCodeChange();
        return g.addExtension(s, source, .input);
    }

    /// How an extension is added: as the Host Input `extend`, rebuilding a
    /// Script whose cap is checked later, or restoring one whose values come
    /// from a save.
    pub const Adding = enum { input, rebuild, rebuild_restored, restore };

    /// Adds an extension to `s`. As an input it writes its record and
    /// refuses a reused name or a Persistent State over the cap; restoring
    /// runs no initialiser and leaves its definitions to the save.
    pub fn addExtension(g: *Group, s: *Script, source: []const u8, how: Adding) !ExtendResult {
        const input = how == .input;
        const number: u32 = @intCast(s.extensions.items.len + 1);
        const l = try g.gpa.create(Library);
        l.* = .{ .gpa = g.gpa, .arena = .init(g.gpa), .name = "", .version = "", .source = "", .identity = undefined, .unit = undefined, .definitions = &.{}, .imports = &.{}, .exports = &.{}, .needs = &.{}, .extension = number };
        var kept = false;
        var lowered = false;
        defer if (!kept) {
            if (lowered) for (l.unit.values) |v| if (v == .value) v.value.release();
            releaseAll(l.definitions, g.gpa);
            var arena = l.arena;
            g.gpa.destroy(l);
            arena.deinit();
        };
        const a = l.arena.allocator();
        l.name = try std.fmt.allocPrint(a, "{s}+{d}", .{ s.name, number });
        l.source = try a.dupe(u8, source);
        var parsed = try g.parseCode(a, l.source);
        defer parsed.deinit();
        l.identity = codeIdentity(s.name, source, .extension, parsed.imports);
        const identity = extendedIdentity(s.identity, l.identity);
        if (input) if (g.trace) |out| {
            out.print("> extend {s} source=", .{s.name}) catch {};
            display.writeSource(out, source) catch {};
            out.print(" identity={x}\n", .{identity}) catch {};
        };
        // Only new names: one the Script has, a Handler's included, is
        // refused before checking.
        if (input and parsed.result == .tree) {
            const t = &parsed.result.tree;
            for (t.declarations) |d| {
                const reused = switch (d.data) {
                    .script_variable => |v| s.hasName(t.text(v.name)),
                    .constant => |k| s.hasName(t.text(k.name)),
                    .function => |f| s.hasName(t.text(f.name)),
                    // A Handler is reused only by its Selector: `on move x`
                    // and `on move x to y` are two names.
                    .handler => |h| if (h.fallback) s.handlerUnit("any message", .fallback) != null else s.handlerUnit(try handlerSelector(a, t, h), .handler) != null,
                    .use => |u| for (u.names) |n| {
                        if (s.hasName(t.text(u.rename orelse n))) break true;
                    } else false,
                };
                if (reused) {
                    g.write("refused code=\"name reused\"\n", .{});
                    return .name_reused;
                }
            }
        }
        const pa = parsed.arena.allocator();
        var inherited: std.ArrayList(check.Inherited) = .empty;
        for (s.variableNames()) |n| try inherited.append(pa, .{ .name = n, .variable = true });
        try inherited.appendSlice(pa, s.names.items);
        var context = try g.codeContext(pa, .{}, s.objects, s.owner);
        context.grants = try keptView(pa, s.grants, how == .restore or how == .rebuild_restored);
        context.inherited = inherited.items;
        var refused: usize = 0;
        const code = try g.lowerCode(a, l.name, l.name, &parsed, context, s.limits.pattern_size, &refused) orelse return .refused;
        l.unit = code.unit;
        lowered = true;
        // It links the Libraries the Script's units import, besides its own.
        var imports: std.ArrayList(*Library) = .empty;
        try imports.appendSlice(a, parsed.imports);
        for (s.imports) |x| {
            if (std.mem.indexOfScalar(*Library, imports.items, x) == null) try imports.append(a, x);
        }
        for (s.extensions.items) |x| for (x.imports) |y| {
            if (std.mem.indexOfScalar(*Library, imports.items, y) == null) try imports.append(a, y);
        };
        l.imports = imports.items;
        if (how == .restore) {
            try s.names.ensureUnusedCapacity(s.code.allocator(), code.names.len);
            try s.extensions.append(g.gpa, l);
            s.names.appendSliceAssumeCapacity(code.names);
            s.identity = identity;
            kept = true;
            return .extended;
        }
        l.definitions = try g.gpa.alloc(*Value, l.unit.definitions.len);
        var made: usize = 0;
        errdefer {
            for (l.definitions[0..made]) |v| v.release();
            g.gpa.free(l.definitions);
            l.definitions = &.{};
        }
        for (l.definitions, l.unit.definitions) |*v, name| {
            v.* = try s.inheritedDefinition(name, l.imports) orelse try nothing(g.gpa);
            made += 1;
        }
        // Its Script Variables join the Script's, Nothing until its
        // initialiser runs; a refusal takes them out again.
        const old = s.variables;
        const grown = try g.gpa.alloc(*Value, l.unit.variables.len);
        var filled: usize = 0;
        errdefer {
            for (grown[0..filled]) |v| v.release();
            g.gpa.free(grown);
        }
        for (grown, 0..) |*v, i| {
            v.* = if (i < old.len) old[i].retain() else try nothing(g.gpa);
            filled += 1;
        }
        s.variables = grown;
        const ok = blk: {
            errdefer s.variables = old;
            if (!try g.initialise(s, l, l.name)) break :blk ExtendResult.refused;
            if (input and g.persistentState(s) > s.limits.persistent_state) {
                g.write("refused code=\"state too large\"\n", .{});
                break :blk ExtendResult.state_too_large;
            }
            break :blk ExtendResult.extended;
        };
        if (ok != .extended) {
            s.variables = old;
            releaseAll(grown, g.gpa);
            return ok;
        }
        releaseAll(old, g.gpa);
        try s.names.ensureUnusedCapacity(s.code.allocator(), code.names.len);
        try s.extensions.append(g.gpa, l);
        s.names.appendSliceAssumeCapacity(code.names);
        s.identity = identity;
        kept = true;
        return .extended;
    }

    pub const ReloadResult = enum { reloaded, refused, state_too_large, stopped, paused };

    /// A Reload or library replacement paused at a lifecycle crossing as it
    /// ended the old code's Runs, after its checks: the code it built, and
    /// for a replacement, the Scripts still to replace from `next`.
    pub const PausedWork = union(enum) {
        reload: struct { script: *Script, fresh: *Script, keep_mailbox: bool },
        replace: struct { rebuilt: []Rebuilt, next: usize, made: []*Library, libraries: []*Library },
    };
    pub const Rebuilt = struct { script: *Script, fresh: *Script };

    /// What a paused Reload or library replacement finished with.
    pub const Resumed = union(enum) { reload: ReloadResult, replace: ReplaceResult };

    /// Goes on with a paused Reload or library replacement, from the
    /// crossing it paused at; it may pause again.
    pub fn resumeWork(g: *Group) !Resumed {
        const work = g.paused_work.?;
        g.paused_work = null;
        switch (work) {
            .reload => |x| {
                const result = g.finishReload(x.script, x.fresh, x.keep_mailbox) catch |e| {
                    g.dropFresh(x.fresh);
                    return e;
                };
                if (result != .paused) g.dropFresh(x.fresh);
                return .{ .reload = result };
            },
            .replace => |x| return .{ .replace = try g.finishReplace(x.rebuilt, x.next, x.made, x.libraries) },
        }
    }

    /// Stop-and-reload (chapter 10, Reload): checks the new source and runs
    /// its initialiser, carries Script Variables over if asked, then stops
    /// the Script with reason `reload` and replaces its code and every
    /// extension at once. A refusal leaves the Script unchanged.
    pub fn reload(g: *Group, s: *Script, source: []const u8, carry: bool, keep_mailbox: bool) !ReloadResult {
        try g.checkCodeChange();
        const fresh = try g.newCode(s);
        // A paused Reload keeps its built code until it resumes.
        var owned = true;
        defer if (owned) g.dropFresh(fresh);
        const ca = fresh.code.allocator();
        fresh.source = try ca.dupe(u8, source);
        var parsed = try g.parseCode(ca, fresh.source);
        defer parsed.deinit();
        fresh.imports = parsed.imports;
        fresh.identity = codeIdentity(s.name, source, .script, fresh.imports);
        if (g.trace) |out| {
            out.print("> reload {s} carry={s}", .{ s.name, if (carry) "yes" else "no" }) catch {};
            if (keep_mailbox) out.writeAll(" mailbox=keep") catch {};
            out.writeAll(" source=") catch {};
            display.writeSource(out, source) catch {};
            out.print(" identity={x}\n", .{fresh.identity}) catch {};
        }
        if (!try g.buildCode(s, fresh, &parsed, &.{}, false)) return .refused;
        if (carry) try g.carryOver(s, fresh);
        if (g.carriedState(s, fresh, keep_mailbox) > s.limits.persistent_state) {
            g.write("refused code=\"state too large\"\n", .{});
            return .state_too_large;
        }
        // Checked, its termination may pause: the built code waits with it.
        const result = try g.finishReload(s, fresh, keep_mailbox);
        if (result == .paused) owned = false;
        return result;
    }

    /// A checked Reload's termination and replacement. Paused at a
    /// lifecycle crossing, it keeps `fresh` in `paused_work`; otherwise
    /// `fresh` is the caller's to drop.
    fn finishReload(g: *Group, s: *Script, fresh: *Script, keep_mailbox: bool) !ReloadResult {
        g.reworking = true;
        defer g.reworking = false;
        const replaced = g.replaceCode(s, fresh, keep_mailbox, "reload") catch |e| {
            if (e != error.Deferred) return e;
            g.paused_work = .{ .reload = .{ .script = s, .fresh = fresh, .keep_mailbox = keep_mailbox } };
            return .paused;
        };
        return if (replaced) .reloaded else .stopped;
    }

    /// A detached Script for building new code for `s`: its name, Grants,
    /// objects and limits, and a new generation.
    fn newCode(g: *Group, s: *Script) !*Script {
        const fresh = try g.gpa.create(Script);
        g.generations += 1;
        fresh.* = .{ .name = s.name, .identity = undefined, .arena = undefined, .code = .init(g.gpa), .unit = undefined, .variables = &.{}, .definitions = &.{}, .grants = s.grants, .owner = s.owner, .objects = s.objects, .limits = s.limits, .effects = s.effects, .generation = g.generations };
        fresh.unit.values = &.{};
        return fresh;
    }

    /// Releases a detached Script and whatever code it still holds.
    fn dropFresh(g: *Group, fresh: *Script) void {
        releaseAll(fresh.variables, g.gpa);
        releaseAll(fresh.definitions, g.gpa);
        g.dropCode(fresh);
        g.gpa.destroy(fresh);
    }

    /// Checks and lowers a detached Script's source, against the Script's
    /// kept Grants, objects and owner, runs its initialiser, and adds each
    /// of `extensions` in order: false, its diagnostics written, if any
    /// refuses.
    /// A variables-only restore checks against its revoked Grants too, which
    /// still bind their names.
    pub fn buildCode(g: *Group, s: *Script, fresh: *Script, parsed: *Parsed, extensions: []const []const u8, revoked: bool) !bool {
        const ca = fresh.code.allocator();
        const pa = parsed.arena.allocator();
        var context = try g.codeContext(pa, .{}, s.objects, s.owner);
        context.grants = try keptView(pa, s.grants, revoked);
        var refused: usize = 0;
        const code = try g.lowerCode(ca, s.name, s.name, parsed, context, s.limits.pattern_size, &refused) orelse return false;
        fresh.unit = code.unit;
        try fresh.names.appendSlice(ca, code.names);
        fresh.variables = try g.newValues(fresh.unit.variables.len, &.{}, &.{});
        fresh.definitions = try g.newValues(fresh.unit.definitions.len, fresh.unit.definitions, fresh.imports);
        if (!try g.initialise(fresh, null, s.name)) return false;
        for (extensions) |x| if (try g.addExtension(fresh, x, if (revoked) .rebuild_restored else .rebuild) != .extended) return false;
        return true;
    }

    /// Compiles a restored Script's source and extensions as they were
    /// first compiled, against all its Grants, without running an
    /// initialiser or writing the Trace: false if any no longer compiles.
    pub fn compileSaved(g: *Group, s: *Script, extensions: []const []const u8) !bool {
        const trace = g.trace;
        g.trace = null;
        defer g.trace = trace;
        const ca = s.code.allocator();
        var parsed = try g.parseCode(ca, s.source);
        defer parsed.deinit();
        s.imports = parsed.imports;
        s.identity = codeIdentity(s.name, s.source, .script, s.imports);
        const pa = parsed.arena.allocator();
        var context = try g.codeContext(pa, .{}, s.objects, s.owner);
        context.grants = try keptView(pa, s.grants, true);
        var refused: usize = 0;
        const code = try g.lowerCode(ca, s.name, s.name, &parsed, context, s.limits.pattern_size, &refused) orelse return false;
        s.unit = code.unit;
        try s.names.appendSlice(ca, code.names);
        for (extensions) |x| if (try g.addExtension(s, x, .restore) != .extended) return false;
        return true;
    }

    /// Carries each Script Variable both codes declare over by name, from
    /// the Script's prospective post-rollback view: a Run stopped in the
    /// middle of its Segment gives back its Segment's base.
    fn carryOver(g: *Group, s: *Script, fresh: *Script) !void {
        const view = try g.gpa.dupe(*Value, s.variables);
        defer g.gpa.free(view);
        var runs: std.ArrayList(*Run) = .empty;
        defer runs.deinit(g.gpa);
        try runs.appendSlice(g.gpa, s.live.items);
        std.mem.sort(*Run, runs.items, {}, struct {
            fn less(_: void, x: *Run, y: *Run) bool {
                return runNumber(x.id) < runNumber(y.id);
            }
        }.less);
        for (runs.items) |r| if (r.continuing) if (r.segment_base) |base| {
            @memcpy(view[0..base.len], base);
        };
        for (fresh.variableNames(), fresh.variables) |name, *v| {
            for (s.variableNames(), view) |old, x| if (std.mem.eql(u8, old, name)) {
                v.*.release();
                v.* = x.retain();
                break;
            };
        }
    }

    /// The Persistent State the Script would keep with the new code's
    /// Script Variables, and its mailbox if it keeps it.
    fn carriedState(g: *Group, s: *Script, fresh: *Script, keep_mailbox: bool) u64 {
        _ = g;
        var total: u64 = 0;
        for (fresh.variables) |v| total += costs.size(v);
        if (keep_mailbox) for (s.work.items) |w| switch (w) {
            .message => |d| {
                var contents: u64 = 0;
                for (d.args) |v| contents += costs.size(v);
                if (d.function) |f| contents += costs.size(f);
                total += 32 + contents;
            },
            .run => {},
        };
        return total;
    }

    /// Stops the Script with reason `reload` and puts the new code and
    /// Script Variables in place of the old, all at once: false if the stop
    /// stopped the Group, which prevents replacing it.
    fn replaceCode(g: *Group, s: *Script, fresh: *Script, keep_mailbox: bool, discard: []const u8) !bool {
        // A stopped Script has nothing left to stop; Reload isn't sticky, so
        // it takes new messages after.
        if (s.stopped == null) try g.stopScript(s, "reload", null, .{ .keep_mailbox = keep_mailbox, .release = .reload, .discard = discard });
        if (g.release_pause) return error.Deferred;
        // A stop that left an effect's state unknown stopped the Group, and
        // prevents replacing it. Made again after a pause, this finishes
        // stopping any Script whose stop paused.
        if (g.fatal) {
            for (g.scripts.items) |x| try g.stopScript(x, "effect state unknown", null, .{});
            return false;
        }
        if (s.stopped) |reason| {
            g.gpa.free(reason);
            s.stopped = null;
        }
        // The revoked Grants the new code was checked without go.
        var kept: usize = 0;
        for (s.grants) |sg| if (!sg.revoked) {
            s.grants[kept] = sg;
            kept += 1;
        };
        s.grants = s.grants[0..kept];
        releaseAll(s.variables, g.gpa);
        releaseAll(s.definitions, g.gpa);
        g.dropCode(s);
        s.code = fresh.code;
        s.source = fresh.source;
        s.unit = fresh.unit;
        s.imports = fresh.imports;
        s.extensions = fresh.extensions;
        s.names = fresh.names;
        s.variables = fresh.variables;
        s.definitions = fresh.definitions;
        s.identity = fresh.identity;
        s.generation = fresh.generation;
        // The detached Script holds nothing now.
        fresh.code = .init(g.gpa);
        fresh.unit.values = &.{};
        fresh.extensions = .empty;
        fresh.variables = &.{};
        fresh.definitions = &.{};
        return true;
    }

    pub const ReplaceResult = union(enum) {
        /// The Libraries recompiled for it, which the caller owns.
        replaced: []*Library,
        refused,
        unknown_library,
        state_too_large,
        /// Fatal termination stopped the Group without publishing new code.
        stopped,
        /// Paused at a lifecycle crossing: `resumeWork` goes on.
        paused,
    };

    /// Replaces a Library the Group holds (chapter 7): recompiles every
    /// Library that imports it, directly or through another, from the source
    /// the Group holds, then stop-and-reloads every Script that imports any
    /// of them, its extensions too, in load order, as one Host Input. If any
    /// fails, nothing changes. `compiler` makes the recompiled Libraries,
    /// which outlive the Group.
    pub fn replaceLibrary(g: *Group, l: *Library, carry: bool, compiler: Allocator) !ReplaceResult {
        try g.checkCodeChange();
        if (g.trace) |out| {
            out.print("> replace-library {s} carry={s} source=", .{ l.name, if (carry) "yes" else "no" }) catch {};
            display.writeSource(out, l.source) catch {};
            out.print(" identity={x}\n", .{l.identity}) catch {};
        }
        const at = for (g.libraries.items, 0..) |x, i| {
            if (std.mem.eql(u8, x.name, l.name)) break i;
        } else return .unknown_library;
        // The Group's Libraries with the replacements in place.
        const given = try g.gpa.dupe(*Library, g.libraries.items);
        var owns_given = true;
        defer if (owns_given) g.gpa.free(given);
        const old = try g.gpa.dupe(*Library, g.libraries.items);
        defer g.gpa.free(old);
        given[at] = l;
        var made: std.ArrayList(*Library) = .empty;
        errdefer {
            for (made.items) |x| x.destroy();
            made.deinit(g.gpa);
        }
        // Libraries are held only after what they import, so one pass in
        // order recompiles each dependant after its imports.
        var failed = false;
        for (old, 0..) |x, i| {
            if (i == at) continue;
            if (!changed(x.imports, old, given)) continue;
            const compiled = try compileLibrary(compiler, x.name, x.version, x.source, given, x.declarations);
            switch (compiled) {
                .library => |y| {
                    try made.append(g.gpa, y);
                    given[i] = y;
                },
                .refused => |diags| {
                    defer compiler.free(diags);
                    for (diags) |d| g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ x.name, d.code, d.line, d.column });
                    failed = true;
                },
            }
        }
        if (failed) {
            for (made.items) |x| x.destroy();
            made.deinit(g.gpa);
            return .refused;
        }
        // Each importing Script is rebuilt against them, its extensions too.
        var rebuilt: std.ArrayList(Rebuilt) = .empty;
        defer {
            for (rebuilt.items) |x| g.dropFresh(x.fresh);
            rebuilt.deinit(g.gpa);
        }
        const outcome: ?ReplaceResult = blk: {
            @memcpy(g.libraries.items, given);
            defer @memcpy(g.libraries.items, old);
            for (g.scripts.items) |s| {
                const uses = changed(s.imports, old, given) or for (s.extensions.items) |x| {
                    if (changed(x.imports, old, given)) break true;
                } else false;
                if (!uses) continue;
                const fresh = try g.newCode(s);
                rebuilt.append(g.gpa, .{ .script = s, .fresh = fresh }) catch |e| {
                    g.dropFresh(fresh);
                    return e;
                };
                const ca = fresh.code.allocator();
                fresh.source = try ca.dupe(u8, s.source);
                var parsed = try g.parseCode(ca, fresh.source);
                defer parsed.deinit();
                fresh.imports = parsed.imports;
                const sources = try ca.alloc([]const u8, s.extensions.items.len);
                for (s.extensions.items, sources) |x, *src| src.* = try ca.dupe(u8, x.source);
                if (!try g.buildCode(s, fresh, &parsed, sources, false)) break :blk .refused;
                fresh.identity = codeIdentity(s.name, s.source, .script, fresh.imports);
                for (fresh.extensions.items) |x| fresh.identity = extendedIdentity(fresh.identity, x.identity);
                if (carry) try g.carryOver(s, fresh);
                if (g.carriedState(s, fresh, false) > s.limits.persistent_state) {
                    g.write("refused code=\"state too large\"\n", .{});
                    break :blk .state_too_large;
                }
            }
            break :blk null;
        };
        if (outcome) |o| {
            for (made.items) |x| x.destroy();
            made.deinit(g.gpa);
            return o;
        }
        // Checked, the replacements' terminations may pause: the built code
        // and the recompiled Libraries wait with them.
        const owned_made = try made.toOwnedSlice(g.gpa);
        const pending = rebuilt.toOwnedSlice(g.gpa) catch |e| {
            for (owned_made) |x| x.destroy();
            g.gpa.free(owned_made);
            return e;
        };
        owns_given = false;
        return g.finishReplace(pending, 0, owned_made, given);
    }

    /// A checked library replacement's terminations and replacements, from
    /// the Script at `from`. Paused at a lifecycle crossing, it keeps its
    /// state in `paused_work`; otherwise it frees `rebuilt` and gives
    /// `made` to the caller.
    fn finishReplace(g: *Group, rebuilt: []Rebuilt, from: usize, made: []*Library, libraries: []*Library) !ReplaceResult {
        g.reworking = true;
        defer g.reworking = false;
        var paused = false;
        var published = false;
        defer if (!paused) {
            g.dropRebuilt(rebuilt);
            g.gpa.free(libraries);
            if (!published) {
                for (made) |l| l.destroy();
                g.gpa.free(made);
            }
        };
        var i = from;
        while (i < rebuilt.len) : (i += 1) {
            const x = rebuilt[i];
            // Terminate every old Script before publishing any new code.
            // A fatal stop may itself pause while cleaning up other Scripts.
            g.stopScript(x.script, "reload", null, .{ .release = .reload, .discard = "library replacement" }) catch |e| {
                if (e == error.Deferred) {
                    g.paused_work = .{ .replace = .{ .rebuilt = rebuilt, .next = i, .made = made, .libraries = libraries } };
                    paused = true;
                    return .paused;
                }
                return e;
            };
            if (g.fatal) break;
        }
        if (g.fatal) {
            for (g.scripts.items) |s| g.stopScript(s, "effect state unknown", null, .{}) catch |e| {
                if (e == error.Deferred) {
                    g.paused_work = .{ .replace = .{ .rebuilt = rebuilt, .next = i, .made = made, .libraries = libraries } };
                    paused = true;
                    return .paused;
                }
                return e;
            };
            return .stopped;
        }
        @memcpy(g.libraries.items, libraries);
        for (rebuilt) |x| {
            const replaced = try g.replaceCode(x.script, x.fresh, false, "library replacement");
            std.debug.assert(replaced);
        }
        published = true;
        return .{ .replaced = made };
    }

    fn dropRebuilt(g: *Group, rebuilt: []Rebuilt) void {
        for (rebuilt) |x| g.dropFresh(x.fresh);
        g.gpa.free(rebuilt);
    }

    /// `n` Script values: Nothing, or for a definition named
    /// `<library>:<name>`, that imported Constant's value. All or none.
    pub fn newValues(g: *Group, n: usize, names: []const []const u8, imports: []const *Library) ![]*Value {
        const out = try g.gpa.alloc(*Value, n);
        var made: usize = 0;
        errdefer {
            for (out[0..made]) |v| v.release();
            g.gpa.free(out);
        }
        for (out, 0..) |*v, i| {
            v.* = (if (i < names.len) try importedDefinition(imports, names[i]) else null) orelse try nothing(g.gpa);
            made += 1;
        }
        return out;
    }

    /// Checks the `needs` of every Library a Script imports, directly or
    /// through another, against its Grants, reporting at each `use` line:
    /// one `missing grant` per distinct Operation, and each other problem
    /// per call.
    fn libraryNeeds(g: *Group, a: Allocator, t: *const ast.Tree, grants: []const check.Grant, out: *std.ArrayList(check.Diagnostic)) !void {
        for (t.declarations) |d| if (d.data == .use) {
            const u = d.data.use;
            const name = t.text(u.library);
            const l = for (g.libraries.items) |x| {
                if (std.mem.eql(u8, x.name, name)) break x;
            } else stdlibLibrary(name) orelse continue;
            const offset = t.tokens[u.keyword].start;
            var missing: std.ArrayList(check.Need) = .empty;
            for (l.needs) |n| {
                const code = check.needProblem(n, grants) orelse continue;
                if (code == .missing_grant) {
                    const seen = for (missing.items) |m| {
                        if (std.mem.eql(u8, m.grant, n.grant) and std.mem.eql(u8, m.operation, n.operation)) break true;
                    } else false;
                    if (seen) continue;
                    try missing.append(a, n);
                }
                try out.append(a, .{ .code = code, .offset = offset });
            }
        };
    }

    /// Refused worker inputs still belong to the Trace. This only formats
    /// their metadata: it runs no Script code and changes no Group state.
    pub const WorkerInput = union(enum) {
        pump: struct { now: model.dates.Instant, slice: i64 = 0, cap: i64 = 0 },
        load: struct { name: []const u8, source: []const u8 },
        reload: struct { script: *Script, source: []const u8, carry: bool, keep_mailbox: bool },
        extend: struct { script: *Script, source: []const u8 },
        add_library: *Library,
        replace_library: struct { library: *Library, carry: bool },
        inspect,
        counters: []const u8,
    };

    pub fn refuseWorker(g: *Group, input: WorkerInput) void {
        g.refuseWorkerWithCode(input, "reentrant call");
    }

    /// Early API validation still records the attempted Host Input.
    pub fn refuseWorkerWithCode(g: *Group, input: WorkerInput, code: []const u8) void {
        const out = g.trace orelse return;
        var arena: std.heap.ArenaAllocator = .init(g.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        switch (input) {
            .pump => |p| {
                const shown = model.dates.string(a, model.dates.fields(p.now), true) catch return;
                out.print("> pump clock={s}", .{shown}) catch {};
                if (p.slice > 0) out.print(" fuel-slice={d}", .{p.slice}) catch {};
                if (p.cap > 0) out.print(" fuel-cap={d}", .{p.cap}) catch {};
            },
            .inspect => out.writeAll("> vars") catch {},
            .counters => |name| out.print("> counters {s}", .{name}) catch {},
            .load => |l| {
                var parsed = g.parseCode(a, l.source) catch return;
                defer parsed.deinit();
                out.print("> load {s} identity={x}", .{ l.name, codeIdentity(l.name, l.source, .script, parsed.imports) }) catch {};
            },
            .reload => |r| {
                var parsed = g.parseCode(a, r.source) catch return;
                defer parsed.deinit();
                out.print("> reload {s} carry={s}", .{ r.script.name, if (r.carry) "yes" else "no" }) catch {};
                if (r.keep_mailbox) out.writeAll(" mailbox=keep") catch {};
                out.writeAll(" source=") catch {};
                display.writeSource(out, r.source) catch {};
                out.print(" identity={x}", .{codeIdentity(r.script.name, r.source, .script, parsed.imports)}) catch {};
            },
            .extend => |e| {
                var parsed = g.parseCode(a, e.source) catch return;
                defer parsed.deinit();
                out.print("> extend {s} source=", .{e.script.name}) catch {};
                display.writeSource(out, e.source) catch {};
                out.print(" identity={x}", .{extendedIdentity(e.script.identity, codeIdentity(e.script.name, e.source, .extension, parsed.imports))}) catch {};
            },
            .add_library => |l| out.print("> add-library {s} identity={x}", .{ l.name, l.identity }) catch {},
            .replace_library => |r| {
                out.print("> replace-library {s} carry={s} source=", .{ r.library.name, if (r.carry) "yes" else "no" }) catch {};
                display.writeSource(out, r.library.source) catch {};
                out.print(" identity={x}", .{r.library.identity}) catch {};
            },
        }
        out.print("\nrefused code=\"{s}\"\n", .{code}) catch {};
    }

    /// Registers a compiled Library with the Group, writing the
    /// `add-library` input and any refusal: a stdlib name is `reserved
    /// name`, a name the Group holds `name reused`, and an import the Group
    /// doesn't hold with the same identity `library mismatch`.
    pub fn addLibrary(g: *Group, l: *Library) !void {
        try g.checkWorker();
        g.write("> add-library {s} identity={x}\n", .{ l.name, l.identity });
        const refusal: ?[]const u8 = blk: {
            for (stdlib_sources) |src| if (std.mem.eql(u8, src.name, l.name)) break :blk "reserved name";
            for (g.libraries.items) |x| if (std.mem.eql(u8, x.name, l.name)) break :blk "name reused";
            for (l.imports) |im| {
                if (im.stdlib) continue;
                const held = for (g.libraries.items) |x| {
                    if (x == im or std.mem.eql(u8, &x.identity, &im.identity)) break true;
                } else false;
                if (!held) break :blk "library mismatch";
            }
            break :blk null;
        };
        if (refusal) |code| {
            g.write("refused code=\"{s}\"\n", .{code});
            if (std.mem.eql(u8, code, "reserved name")) return error.ReservedName;
            if (std.mem.eql(u8, code, "name reused")) return error.NameReused;
            return error.LibraryMismatch;
        }
        try g.libraries.append(g.gpa, l);
    }

    /// The Object Kinds the checker sees through a Script's objects.
    const KindsView = struct {
        objects: []const NamedObject,
        owner: ?*objects.Object,

        fn writable(context: *const anyopaque, kind: []const u8, key: []const u8) ?bool {
            const v: *const KindsView = @ptrCast(@alignCast(context));
            if (v.owner) |o| if (std.mem.eql(u8, o.kind.name, kind)) return o.kind.writable(key);
            for (v.objects) |o| if (std.mem.eql(u8, o.object.kind.name, kind)) return o.object.kind.writable(key);
            return null;
        }
    };

    /// Makes a handle for a Host-owned thing; a duplicate id within its
    /// kind is refused.
    pub fn object(g: *Group, kind: *const objects.Kind, id: []const u8, native: ?*anyopaque) !*objects.Object {
        if (g.objectById(kind.name, id) != null) return error.DuplicateObjectId;
        const o = try objects.Object.make(g.gpa, kind, id, native);
        errdefer o.destroy(g.gpa);
        try g.objects.append(g.gpa, o);
        return o;
    }

    pub fn objectById(g: *Group, kind: []const u8, id: []const u8) ?*objects.Object {
        for (g.objects.items) |o| if (std.mem.eql(u8, o.kind.name, kind) and std.mem.eql(u8, o.id, id)) return o;
        return null;
    }

    /// The handle a Script value is, if it is one of this Group's objects.
    pub fn objectOf(g: *Group, v: *const Value) ?*objects.Object {
        if (v.data != .object) return null;
        for (g.objects.items) |o| if (@intFromPtr(o) == v.data.object.identity) return o;
        return null;
    }

    /// Queues `SetParent`. A cycle or a disposed child is refused at the
    /// call, against the parents as they stand, with the input and a
    /// `refused` record; it is checked again when drained.
    pub fn setParent(g: *Group, o: *objects.Object, parent: ?*objects.Object) !void {
        const input: Input = .{ .set_parent = .{ .object = o, .parent = parent } };
        if (parentRefusal(o, parent)) |code| {
            g.writeInput(input);
            g.write("refused code=\"{s}\"\n", .{code});
            return if (std.mem.eql(u8, code, "parent cycle")) error.ParentCycle else error.InvalidValue;
        }
        try g.enqueue(input);
    }

    fn parentRefusal(o: *const objects.Object, parent: ?*const objects.Object) ?[]const u8 {
        if (o.disposed) return "invalid value";
        if (o.wouldCycle(parent)) return "parent cycle";
        return null;
    }

    /// Queues `CancelRun` for a Run, by its id. One that has ended, or never
    /// existed, is still recorded, and does nothing.
    pub fn cancelRunInput(g: *Group, id: []const u8) !void {
        const owned = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(owned);
        try g.queueLanding(.{ .cancel_run = owned });
    }

    /// Queues RewindRun (ADR 0068).
    pub fn rewindRunInput(g: *Group, id: []const u8) !void {
        const owned = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(owned);
        try g.queueLanding(.{ .rewind_run = owned });
    }

    /// Lands what the Host made during a Pump, each with its input line, at
    /// a Host crossing of `running` or between turns. One for the running
    /// Run ends its Stretch before its next instruction.
    fn land(g: *Group, running: ?*Run) !void {
        g.landing_active = true;
        defer g.landing_active = false;
        g.flushHeld();
        while (g.landing.items.len > 0) {
            const entry = &g.landing.items[0];
            if (!entry.written) {
                g.writeInput(entry.input);
                entry.written = true;
            }
            const input = entry.input;
            g.landing_run = running;
            g.landOne(input, running) catch |e| {
                if (e == error.Deferred) g.landing_paused = true;
                return e;
            };
            g.landing_paused = false;
            _ = g.landing.orderedRemove(0);
            g.releaseInputs(&.{input});
            if (g.release_pause) return;
        }
        g.landing_run = null;
    }

    fn landOne(g: *Group, input: Input, running: ?*Run) !void {
        switch (input) {
            .stop => |x| {
                const target = g.script(x.script) orelse return;
                if (running) |r| if (r.script == target) {
                    if (target.stopped == null and r.landed == null) r.landed = .{ .stop = try g.gpa.dupe(u8, x.reason) };
                    return;
                };
                try g.stopScript(target, x.reason, null, .{});
            },
            .cancel_run => |id| {
                if (running) |r| if (std.mem.eql(u8, r.id, id)) {
                    if (r.landed == null and r.cleanup_from == null) r.landed = .cancel;
                    return;
                };
                for (g.scripts.items) |x| for (x.live.items) |r| if (std.mem.eql(u8, r.id, id)) {
                    try g.cancel(x, r);
                    return;
                };
            },
            .rewind_run => |id| try g.rewind(id, running),
            else => unreachable,
        }
    }

    /// Lands what the Host made at a crossing of the running Run: true if
    /// it ends the Run's Stretch.
    fn landedAt(g: *Group, run: *Run) !bool {
        g.flushHeld();
        if (g.trace_pause) return error.Deferred;
        if (g.landing.items.len == 0) return run.landed != null;
        try g.land(run);
        return run.landed != null;
    }

    /// RewindRun (ADR 0068): a Run still in its first Segment goes back to
    /// its message; any other, or one that has ended, is noted.
    fn rewind(g: *Group, id: []const u8, running: ?*Run) !void {
        if (running) |r| if (std.mem.eql(u8, r.id, id)) {
            if (r.segments == 0 and r.landed == null and r.cleanup_from == null) {
                r.landed = .rewind;
            } else g.write("note {s} kind=not-rewindable\n", .{id});
            return;
        };
        for (g.scripts.items) |s| for (s.live.items, 0..) |r, i| if (std.mem.eql(u8, r.id, id)) {
            // A Run parked at dispatch hasn't begun its clause.
            const first = r.segments == 0 or r.parked or (r.resume_with != null and r.resume_with.? == .unparked);
            if (!first or r.cleanup_from != null or (r.resume_with != null and r.resume_with.? != .unparked)) {
                g.write("note {s} kind=not-rewindable\n", .{id});
                return;
            }
            // Its rollback first, which may defer while draining.
            try g.cleanupLifecycle(r);
            // Preempted or parked: it has no Stretch to end.
            _ = s.live.orderedRemove(i);
            var k: usize = 0;
            while (k < s.work.items.len) {
                if (s.work.items[k] == .run and s.work.items[k].run == r) {
                    _ = s.work.orderedRemove(k);
                } else k += 1;
            }
            if (!r.parked) g.restoreBase(r);
            try g.putBack(s, r);
            g.dropRewound(r);
            return;
        };
        g.write("note {s} kind=not-rewindable\n", .{id});
    }

    /// A rewound Run's message goes back to the head of its Script's
    /// mailbox as it left it: its ids, its place on its path, and an open
    /// Decision still open. Its Fuel isn't refunded, and the Pump returns.
    fn putBack(g: *Group, s: *Script, r: *Run) !void {
        var d = r.delivery;
        if (r.verdict) {
            r.verdict = false;
            d.decision = true;
        }
        try s.work.insert(g.gpa, 0, .{ .message = d });
        r.delivery.decision = d.decision;
        s.fuel_total += r.fuel;
        s.alloc_total += r.alloc;
        g.rewound = true;
    }

    /// A cancellation that landed while the Run ran: its Segment rolls back,
    /// then its `finally` blocks run on its Cleanup Budget.
    fn landedCancel(g: *Group, run: *Run) !Outcome {
        run.crossing_cancel = true;
        if (run.cleanup == null) run.cleanup = .{ .outcome = .stopped };
        _ = g.lifecycle(run, &run.cleanup.?, true) catch return .{ .preempted = .crossing };
        run.cleanup = null;
        run.crossing_cancel = false;
        // A successful Start is pending before controls land. Cancel it
        // before finally runs, retaining its abandonment record exactly once.
        if (run.waiting) |p| {
            for (g.pending.items, 0..) |item, i| if (item == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            abandonCall(p);
            if (p.call) |c| try run.abandoned.append(g.gpa, c.id);
            g.destroyPending(p);
            run.waiting = null;
        }
        if (run.join) |join| for (join.members.items) |x| if (x.pending != null) {
            try run.abandoned.append(g.gpa, x.waited.id);
        };
        g.dropJoin(run);
        g.restoreBase(run);
        return g.startCancel(run);
    }

    /// Ends a rewound Run, whose message is back in its mailbox.
    fn dropRewound(g: *Group, r: *Run) void {
        g.discardRun(r, "rewind");
        r.delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false };
        g.destroyRun(r);
    }

    /// A Stop, CancelRun or RewindRun: made during a Pump, it lands at the
    /// next Host crossing; otherwise the next Pump drains it.
    fn queueLanding(g: *Group, input: Input) !void {
        if (!g.pumping) return g.enqueue(input);
        try g.landing.append(g.gpa, .{ .input = input, .written = g.held_trace != null });
        // Made in a Host function, it is written where it was made, after
        // the crossing's records.
        if (g.held_trace != null) g.writeInput(input);
    }

    /// While a Host function runs inside a Pump, what is written to the
    /// Trace is held, to follow the crossing's own records. Returns the
    /// Trace to put back.
    fn holdTrace(g: *Group) ?*std.Io.Writer {
        const trace = g.trace;
        if (!g.pumping or trace == null or g.held_trace != null) return trace;
        if (g.held == null) g.held = .init(g.gpa);
        g.held_trace = trace;
        g.trace = &g.held.?.writer;
        return trace;
    }

    /// Writes what a Host function wrote, after its crossing's records.
    fn flushHeld(g: *Group) void {
        g.held_trace = null;
        const h = if (g.held) |*x| x else return;
        const out = g.trace orelse return;
        out.writeAll(h.written()) catch {};
        h.clearRetainingCapacity();
    }

    /// Queues cancelling a Delivery, by its delivery number.
    pub fn cancelDeliveryInput(g: *Group, id: u64) !void {
        try g.enqueue(.{ .cancel_delivery = id });
    }

    /// Cancels a Delivery: the Run it started, or, still in a mailbox, the
    /// Delivery itself, which is reported cancelled with no Run.
    fn cancelDelivery(g: *Group, id: u64) !void {
        for (g.scripts.items) |x| for (x.live.items) |r| if (r.delivery.id == id and r.delivery.from == null) {
            return g.cancel(x, r);
        };
        for (g.scripts.items) |x| for (x.work.items, 0..) |w, i| switch (w) {
            .message => |d| if (d.id == id and d.from == null) {
                _ = x.work.orderedRemove(i);
                if (g.trace) |out| {
                    out.print("run outcome=cancelled delivery=d{d}", .{id}) catch {};
                    if (d.function) |f| {
                        out.writeAll(" fn=") catch {};
                        display.writeTrace(out, f) catch {};
                    }
                    out.writeAll(" fuel=0 alloc=0\n") catch {};
                }
                g.addReport(.{ .run_end = .{ .script = g.reports.text(x.name) catch "", .delivery = g.reports.print("d{d}", .{id}) catch "", .outcome = .cancelled } });
                if (d.decision) try g.takePart(d, .{ .undecided = .{ .script = x.name, .run = "", .outcome = "cancelled" } });
                g.releaseDelivery(d);
                return;
            },
            .run => {},
        };
    }

    /// Cancels a Run that isn't running (chapter 6, Cancellation and Stop).
    /// A preempted Run, in the middle of its Segment, has its scopes
    /// abandoned and its Segment and participant rolled back here. Its
    /// pending calls are abandoned, and its `finally` blocks run in its
    /// Script's turn, where a Run already in the queue keeps its place.
    fn cancel(g: *Group, s: *Script, r: *Run) !void {
        if (r.resume_with) |w| if (w == .cancelled) return;
        abandonReadyCalls(r);
        // Its rollback first, which may defer while draining: nothing else
        // changes until it completes.
        if (r.continuing) try g.cleanupLifecycle(r);
        if (r.resume_with) |w| g.releaseResume(w);
        const queued = r.resume_with != null or r.continuing;
        if (r.continuing) {
            g.restoreBase(r);
            r.preempted_in = null;
            // Its cleanup is a Segment of its own.
            r.segments += 1;
        }
        if (r.waiting) |p| {
            for (g.pending.items, 0..) |y, i| if (y == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            abandonCall(p);
            const id = if (p.call) |c| c.id else p.id;
            if (id.len > 0) try r.abandoned.append(g.gpa, id);
            g.destroyPending(p);
            r.waiting = null;
        }
        // A Join's members still pending, in start order.
        if (r.join) |join| for (join.members.items) |x| if (x.pending != null) {
            try r.abandoned.append(g.gpa, x.waited.id);
        };
        g.dropJoin(r);
        r.parked = false;
        r.resume_with = .cancelled;
        if (!queued) try s.work.append(g.gpa, .{ .run = r });
    }

    /// Starts a cancelled Run's cleanup: its `finally` blocks, once,
    /// innermost first, on the Cleanup Budget; nothing is unwound.
    fn startCancel(g: *Group, run: *Run) !Outcome {
        run.cleanup_from = run.fuel;
        const top = &run.frames.items[run.frames.items.len - 1];
        // A preempted Run's place is the instruction it would run next.
        const place = if (run.continuing) top.pc else top.pc -| 1;
        var cleanups: std.ArrayList(Cleanup) = .empty;
        errdefer cleanups.deinit(g.gpa);
        // A cleanup it was preempted in ends. A catch dispatch it was
        // preempted in runs its policy's own `finally` blocks, then leaves,
        // bringing its failed frames back with theirs.
        while (run.controls.items.len > 0 and run.controls.items[run.controls.items.len - 1] == .cleanup) {
            var c = run.controls.pop().?;
            g.disposeControl(&c);
        }
        if (run.controls.items.len > 0) {
            const d = run.controls.items[run.controls.items.len - 1].dispatch;
            try g.collect(run, &cleanups, d.owner, d.search.entry - 1, null, place);
            try cleanups.append(g.gpa, .{ .leave = true });
        } else try g.collect(run, &cleanups, 0, null, null, place);
        try g.startCleanup(run, try nothing(g.gpa), cleanups, .cancel);
        return (try g.nextCleanup(run, true)) orelse try g.execute(run, true);
    }

    /// Ends a cancelled Run's cleanup that failed: the rest of it doesn't
    /// run, and the Run still ends `cancelled`.
    fn cleanupFailed(g: *Group, run: *Run) Outcome {
        g.abandonUnwinding(run);
        while (run.frames.items.len > 0) g.popFrame(run);
        return .cancelled;
    }

    /// Queues `Revoke` for a Script's named Grant. A Script or name the
    /// Group doesn't know is still recorded, and does nothing.
    pub fn revoke(g: *Group, script_name: []const u8, grant_name: []const u8) !void {
        const s = try g.gpa.dupe(u8, script_name);
        errdefer g.gpa.free(s);
        const n = try g.gpa.dupe(u8, grant_name);
        errdefer g.gpa.free(n);
        try g.enqueue(.{ .revoke = .{ .script = s, .grant = n } });
    }

    /// Calls a named Grant's release hook, if its Capability has one.
    fn releaseGrant(g: *Group, s: *const Script, sg: *const ScriptGrant, reason: capabilities.ReleaseReason) void {
        const release = sg.grant.capability.release orelse return;
        release.call(release.context, &.{ .group = g, .script = s.name, .grant = sg.name, .binding = sg.grant.binding, .now = g.clock, .reason = reason });
    }

    pub fn dispose(g: *Group, o: *objects.Object) !void {
        try g.enqueue(.{ .dispose = o });
    }

    /// Queues a Delivery to a Host Object, routed when it is drained.
    pub fn deliverTo(g: *Group, to: *objects.Object, message: []const u8, args: []*Value, request: bool) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        try g.queueDelivery("", .{ .id = id, .message = message, .args = args, .request = request, .target = to, .at = to });
        return id;
    }

    /// Queues a Delivery Input with its own copies of the names and the
    /// argument list; a refusal leaves none of them behind.
    fn queueDelivery(g: *Group, to: []const u8, d: Delivery) !void {
        g.markRoot(rootOf(d));
        const script_name = try g.gpa.dupe(u8, to);
        errdefer g.gpa.free(script_name);
        var copy = d;
        copy.limits = g.override;
        g.override = null;
        copy.message = try g.gpa.dupe(u8, d.message);
        errdefer g.gpa.free(copy.message);
        copy.args = try g.gpa.dupe(*Value, d.args);
        errdefer g.gpa.free(copy.args);
        try g.enqueue(.{ .deliver = .{ .script = script_name, .delivery = copy } });
    }

    /// Whether a Host Delivery to `s` would overfill its mailbox, counting
    /// the Deliveries already queued to it.
    pub fn mailboxFull(g: *Group, s: *const Script) bool {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        var n = mailboxLen(s);
        for ([_][]const Input{ g.inputs.items, g.batch.items }) |queue| for (queue) |input| switch (input) {
            .deliver => |d| if (d.delivery.target == null and std.mem.eql(u8, d.script, s.name)) {
                n += 1;
            },
            else => {},
        };
        return n >= s.limits.mailbox_depth;
    }

    pub fn script(g: *Group, name: []const u8) ?*Script {
        for (g.scripts.items) |s| if (std.mem.eql(u8, s.name, name)) return s;
        return null;
    }

    /// Queues a Delivery to the Script `to`. Takes the arguments.
    /// Queues a Host call of a Function Value (chapter 9, Function Values):
    /// a Request to its Home Script. Takes the arguments.
    pub fn callFunctionValue(g: *Group, fv: *Value, args: []*Value) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        const f = fv.retain();
        errdefer f.release();
        try g.queueDelivery(fv.data.function.home, .{ .id = id, .message = "", .args = args, .request = true, .function = f });
        return id;
    }

    pub fn deliver(g: *Group, to: []const u8, message: []const u8, args: []*Value, request: bool) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        try g.queueDelivery(to, .{ .id = id, .message = message, .args = args, .request = request });
        return id;
    }

    /// Queues a Broadcast, or with `decision` a Broadcast Decision. Takes
    /// the arguments.
    pub fn broadcast(g: *Group, message: []const u8, args: []*Value, decision: bool) !u64 {
        const name = try g.gpa.dupe(u8, message);
        errdefer g.gpa.free(name);
        const copy = try g.gpa.dupe(*Value, args);
        errdefer g.gpa.free(copy);
        g.broadcasts += 1;
        try g.enqueue(.{ .broadcast = .{ .id = g.broadcasts, .message = name, .args = copy, .decision = decision, .limits = g.override } });
        g.override = null;
        return g.broadcasts;
    }

    /// Writes a Broadcast the Host call refused, with no id, then its
    /// `refused` record.
    pub fn refuseBroadcast(g: *Group, message: []const u8, args: []*Value, decision: bool, limits: ?RefusedOverride, code: []const u8) void {
        const out = g.trace orelse return;
        out.print("> {s} message={s}", .{ if (decision) "decide-broadcast" else "broadcast", message }) catch {};
        writeArgs(out, args);
        if (limits) |o| o.write(out);
        out.print("\nrefused code=\"{s}\"\n", .{code}) catch {};
    }

    pub fn releaseBroadcast(g: *Group, b: Broadcast) void {
        g.gpa.free(b.message);
        releaseAll(b.args, g.gpa);
        if (b.recipients) |r| g.gpa.free(r);
    }

    /// Whether a Script wants a Broadcast's message: it has a Handler for
    /// it, or a `wait for` pending on it. A Fallback doesn't count.
    fn wants(g: *Group, s: *const Script, message: []const u8, cancelled: []const *const Run) bool {
        if (s.handlerUnit(message, .handler) != null) return true;
        for (g.pending.items) |p| {
            const event = p.event orelse continue;
            if (p.run.script != s or std.mem.indexOfScalar(*const Run, cancelled, p.run) != null) continue;
            for (s.unitIn(event.library).events[event.entry].branches) |b| switch (b) {
                .when => |w| if (std.mem.eql(u8, w.message, message)) return true,
                .after => {},
            };
        }
        return false;
    }

    /// Finds a Broadcast's recipients, in load order, each with its own
    /// delivery id.
    fn resolveBroadcast(g: *Group, b: *Broadcast, stopping: []const *const Script, cancelled: []const *const Run) !void {
        if (b.recipients != null) return;
        var out: std.ArrayList(Recipient) = .empty;
        errdefer out.deinit(g.gpa);
        for (g.scripts.items) |s| if (s.stopped == null and std.mem.indexOfScalar(*const Script, stopping, s) == null and g.wants(s, b.message, cancelled)) {
            try out.append(g.gpa, .{ .script = s, .delivery = g.deliveries + 1 });
            g.deliveries += 1;
        };
        b.recipients = try out.toOwnedSlice(g.gpa);
    }

    /// Posts a Broadcast to each recipient. A Broadcast Decision with none
    /// is allowed at once.
    fn drainBroadcast(g: *Group, b: Broadcast) !void {
        defer g.releaseBroadcast(b);
        const recipients = b.recipients.?;
        if (b.decision) {
            if (recipients.len == 0) return g.seal(b.id, true, &.{});
            const deliveries = try g.gpa.alloc(u64, recipients.len);
            errdefer g.gpa.free(deliveries);
            for (recipients, deliveries) |r, *x| x.* = r.delivery;
            const parts = try g.gpa.alloc(?Part, recipients.len);
            errdefer g.gpa.free(parts);
            @memset(parts, null);
            try g.open_broadcasts.put(g.gpa, b.id, .{ .deliveries = deliveries, .parts = parts });
        }
        for (recipients) |r| {
            const message = try g.gpa.dupe(u8, b.message);
            errdefer g.gpa.free(message);
            const args = try g.gpa.dupe(*Value, b.args);
            for (args) |v| _ = v.retain();
            var limits = b.limits;
            if (limits) |*o| {
                inline for (.{ "fuel_per_run", "alloc_per_run", "max_wait_ms", "max_join" }) |f| {
                    if (@field(o, f)) |v| @field(o, f) = @min(v, @field(r.script.limits, f));
                }
            }
            try g.post(r.script, .{ .id = r.delivery, .message = message, .args = args, .request = false, .decision = b.decision, .decides = b.decision, .broadcast = b.id, .limits = limits });
        }
    }

    /// Writes a Delivery, Request or Decision the Host call refused, with
    /// no id, then its `refused` record.
    pub fn refuseDelivery(g: *Group, to: []const u8, d: Delivery, code: []const u8) void {
        g.writeInput(.{ .deliver = .{ .script = to, .delivery = d } });
        g.write("refused code=\"{s}\"\n", .{code});
    }

    /// Queues a Decision to the Script `to`. Takes the arguments.
    pub fn decide(g: *Group, to: []const u8, message: []const u8, args: []*Value) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        try g.queueDelivery(to, .{ .id = id, .message = message, .args = args, .request = false, .decision = true, .decides = true });
        return id;
    }

    /// Queues a Decision to a Host Object, routed when it is drained.
    pub fn decideTo(g: *Group, to: *objects.Object, message: []const u8, args: []*Value) !u64 {
        g.deliveries += 1;
        const id = g.deliveries;
        try g.queueDelivery("", .{ .id = id, .message = message, .args = args, .request = false, .decision = true, .decides = true, .target = to, .at = to });
        return id;
    }

    /// Queues an answer or failure for the suspending call `id`. Takes it.
    pub fn settle(g: *Group, id: []const u8, with: Resume) !void {
        const copy = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(copy);
        try g.enqueue(.{ .settle = .{ .id = copy, .with = with } });
    }

    pub fn releaseResume(g: *Group, with: Resume) void {
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

    pub fn releaseDelivery(g: *Group, d: Delivery) void {
        g.markRoot(rootOf(d));
        if (d.function) |f| f.release();
        releaseAll(d.args, g.gpa);
        g.gpa.free(d.message);
        if (d.during) |x| x.release();
        if (d.from) |x| g.gpa.free(x);
    }

    pub fn destroyScript(g: *Group, s: *Script) void {
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
        if (s.stopped) |reason| g.gpa.free(reason);
        g.dropCode(s);
        s.arena.deinit();
        g.gpa.destroy(s);
    }

    pub fn destroyPending(g: *Group, p: *Pending) void {
        if (p.event) |e| g.releaseEvent(e);
        g.gpa.destroy(p);
    }

    pub fn releaseEvent(g: *Group, e: *EventWait) void {
        g.releaseBranches(e.branches);
        g.gpa.destroy(e);
    }

    fn releaseBranches(g: *Group, branches: []EventBranch) void {
        g.releaseHeld(branches);
        g.gpa.free(branches);
    }

    /// What each branch holds, without the branches themselves.
    pub fn releaseHeld(g: *Group, branches: []const EventBranch) void {
        for (branches) |b| switch (b) {
            .when => |x| {
                if (x.from) |v| v.release();
                releaseAll(x.captures, g.gpa);
            },
            .after => {},
        };
    }

    pub fn destroyRun(g: *Group, run: *Run) void {
        if (run.returned_op) |r| g.releaseHostOutcome(r.outcome);
        if (run.returned_prop) |r| g.releasePropResult(r);
        if (run.waiting) |p| {
            for (g.pending.items, 0..) |x, i| if (x == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            abandonCall(p);
            g.destroyPending(p);
        }
        if (run.resume_with) |r| g.releaseResume(r);
        if (run.ending) |e| switch (e.outcome) {
            .returned, .errored, .vetoed => |v| v.release(),
            else => {},
        };
        g.abandonUnwinding(run);
        g.dropJoin(run);
        run.scopes.deinit(g.gpa);
        if (run.participant) |*p| p.grants.deinit(g.gpa);
        g.dropBase(run);
        if (run.cleanup_code) |c| c.release();
        if (run.end_handler) |h| h.release();
        run.abandoned.deinit(g.gpa);
        while (run.frames.items.len > 0) g.popFrame(run);
        run.frames.deinit(g.gpa);
        g.releaseDelivery(run.delivery);
        g.gpa.free(run.id);
        g.gpa.destroy(run);
    }

    /// Writes a queued Host Input as the Trace's `>` line.
    pub fn writeInput(g: *Group, input: Input) void {
        const out = g.trace orelse return;
        switch (input) {
            .deliver => |d| if (d.delivery.function) |f| {
                // A Host call of a Function Value.
                out.print("> call-value d{d} fn=", .{d.delivery.id}) catch {};
                display.writeTrace(out, f) catch {};
                writeArgs(out, d.delivery.args);
                if (d.delivery.limits) |o| o.write(out);
            } else {
                out.print("> {s}", .{if (d.delivery.decision) "decide" else if (d.delivery.request) "request" else "deliver"}) catch {};
                // A refused Delivery never had an id.
                if (d.delivery.id > 0) out.print(" d{d}", .{d.delivery.id}) catch {};
                out.writeAll(" to=") catch {};
                if (d.delivery.target) |o| display.writeTrace(out, o.value) catch {} else out.writeAll(d.script) catch {};
                out.print(" message={s}", .{d.delivery.message}) catch {};
                if (d.delivery.args.len > 0) {
                    out.writeAll(" args=[") catch {};
                    for (d.delivery.args, 0..) |v, i| {
                        if (i > 0) out.writeAll(", ") catch {};
                        display.writeTrace(out, v) catch {};
                    }
                    out.writeAll("]") catch {};
                }
                if (d.delivery.limits) |o| o.write(out);
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
            .settlement => |x| {
                out.print("> settle {s} how={s}", .{ x.id, @tagName(x.how) }) catch {};
                if (x.with) |w| switch (w) {
                    .answer => |a| {
                        out.writeAll(" value=") catch {};
                        display.writeTrace(out, a.value) catch {};
                    },
                    .failed => |f| {
                        out.writeAll(" error=") catch {};
                        const shown = failureMap(g.gpa, f) catch null;
                        defer if (shown) |v| v.release();
                        if (shown) |v| display.writeTrace(out, v) catch {};
                    },
                    else => {},
                };
            },
            .set_parent => |x| {
                out.writeAll("> set-parent object=") catch {};
                display.writeTrace(out, x.object.value) catch {};
                out.writeAll(" parent=") catch {};
                if (x.parent) |p| display.writeTrace(out, p.value) catch {} else out.writeAll("nothing") catch {};
            },
            .dispose => |o| {
                out.writeAll("> dispose object=") catch {};
                display.writeTrace(out, o.value) catch {};
            },
            .charge_request => |q| out.print("> charge-request {s} {s} fuel={d}", .{ q.call, q.id, q.fuel }) catch {},
            .revoke => |x| out.print("> revoke {s} grant={s}", .{ x.script, x.grant }) catch {},
            .cancel_run => |id| out.print("> cancel-run {s}", .{id}) catch {},
            .rewind_run => |id| out.print("> rewind-run {s}", .{id}) catch {},
            .stop => |x| {
                out.print("> stop {s} reason=", .{x.script}) catch {};
                writeText(out, x.reason);
            },
            .cancel_delivery => |id| out.print("> cancel-delivery d{d}", .{id}) catch {},
            .broadcast => |b| {
                out.print("> {s}", .{if (b.decision) "decide-broadcast" else "broadcast"}) catch {};
                // A refused Broadcast never had an id.
                if (b.id > 0) out.print(" b{d}", .{b.id}) catch {};
                out.print(" message={s}", .{b.message}) catch {};
                writeArgs(out, b.args);
                if (b.limits) |o| o.write(out);
                const recipients = b.recipients orelse &.{};
                if (recipients.len > 0) {
                    out.writeAll(" recipients=[") catch {};
                    for (recipients, 0..) |r, i| out.print("{s}{s}:d{d}", .{ if (i > 0) ", " else "", r.script.name, r.delivery }) catch {};
                    out.writeAll("]") catch {};
                }
            },
        }
        out.writeAll("\n") catch {};
    }

    /// A Pump: the queued inputs are written and drained, due timers fire,
    /// then Scripts take turns until none has work.
    pub fn pump(g: *Group, clock: model.dates.Instant) !void {
        return g.pumpWith(clock, 0, 0);
    }

    /// A Pump with a Fuel Slice per Script and a Fuel cap for the Group, 0
    /// for none (chapter 5, Fuel Slices).
    pub fn pumpWith(g: *Group, clock: model.dates.Instant, slice: u64, cap: u64) !void {
        try g.checkWorker();
        const previous = g.observed_clock orelse if (g.restored) |r| r.clock else null;
        if (previous) |last| if (clock.seconds < last.seconds or (clock.seconds == last.seconds and clock.nanos < last.nanos)) {
            g.refusePump(clock, @intCast(slice), @intCast(cap));
            return error.ClockBackwards;
        };
        g.observed_clock = clock;
        g.pumping = true;
        defer g.pumping = false;
        g.rewound = false;
        g.flushChargeRefusals();
        g.clock = clock;
        g.slice = slice;
        g.cap = cap;
        g.sliced = false;
        g.input_lock.lock();
        g.settlements_closed = true;
        std.mem.swap(std.ArrayList(Input), &g.inputs, &g.batch);
        g.input_lock.unlock();
        // A Broadcast's recipients are those that want it now, as the queue
        // is drained.
        // A Stop, or a disposal that stops a Script, queued before a
        // Broadcast leaves that Script out of its recipients.
        var stopping: std.ArrayList(*const Script) = .empty;
        defer stopping.deinit(g.gpa);
        var cancelled: std.ArrayList(*const Run) = .empty;
        defer cancelled.deinit(g.gpa);
        for (g.batch.items) |*input| switch (input.*) {
            .broadcast => |*b| try g.resolveBroadcast(b, stopping.items, cancelled.items),
            .cancel_run => |id| {
                for (g.scripts.items) |x| for (x.live.items) |r| if (std.mem.eql(u8, r.id, id)) try cancelled.append(g.gpa, r);
            },
            .cancel_delivery => |id| {
                for (g.scripts.items) |x| for (x.live.items) |r| if (r.delivery.id == id and r.delivery.from == null) try cancelled.append(g.gpa, r);
            },
            .stop => |x| if (g.script(x.script)) |target| try stopping.append(g.gpa, target),
            .dispose => |o| for (g.scripts.items) |x| if (x.owner == o) try stopping.append(g.gpa, x),
            else => {},
        };
        for (g.batch.items) |input| g.writeInput(input);
        const shown = try model.dates.string(g.scratch.allocator(), model.dates.fields(clock), true);
        g.write("> pump clock={s}", .{shown});
        if (slice > 0) g.write(" fuel-slice={d}", .{slice});
        if (cap > 0) g.write(" fuel-cap={d}", .{cap});
        g.write("\n", .{});
        g.pump_fuel = 0;
        // Each Script's slice in this Pump is what its debt leaves of it.
        for (g.scripts.items) |x| {
            x.spent = 0;
            if (slice == 0) continue;
            const paid = @min(x.debt, slice);
            x.allowance = slice - paid;
            x.debt -= paid;
        }
        try g.drain();
    }

    fn enqueue(g: *Group, input: Input) !void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        try g.inputs.append(g.gpa, input);
    }

    fn registerCall(g: *Group, id: []const u8, eligible: bool) !void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        if (g.issued_calls.contains(id)) return;
        const own = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(own);
        try g.issued_calls.put(g.gpa, own, eligible);
    }

    fn unissueCall(g: *Group, id: []const u8) void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        if (g.issued_calls.fetchRemove(id)) |entry| g.gpa.free(entry.key);
    }

    pub fn requestCharge(g: *Group, id: []const u8, fuel: i64) !*capabilities.ChargeRequest {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        const valid_amount = fuel >= 0 and fuel <= 9_007_199_254_740_991;
        const eligible = g.issued_calls.get(id) orelse {
            g.refuseChargeLocked(id, fuel, valid_amount, "unknown call");
            return error.UnknownCall;
        };
        if (!valid_amount or !eligible) {
            g.refuseChargeLocked(id, fuel, valid_amount, "invalid value");
            return error.InvalidValue;
        }
        for (g.charge_requests.items) |q| if (std.mem.eql(u8, q.call, id) and !q.done.load(.acquire)) {
            g.refuseChargeLocked(id, fuel, true, "invalid value");
            return error.InvalidValue;
        };
        const q = try g.gpa.create(capabilities.ChargeRequest);
        errdefer g.gpa.destroy(q);
        const request = try std.fmt.allocPrint(g.gpa, "q{d}", .{g.charge_counter + 1});
        errdefer g.gpa.free(request);
        const call = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(call);
        q.* = .{ .id = request, .call = call, .fuel = @intCast(fuel) };
        try g.charge_requests.append(g.gpa, q);
        errdefer _ = g.charge_requests.pop();
        try g.inputs.append(g.gpa, .{ .charge_request = q });
        g.charge_counter += 1;
        return q;
    }

    pub fn refuseCharge(g: *Group, id: []const u8, fuel: i64, valid: bool, code: []const u8) void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        g.refuseChargeLocked(id, fuel, valid, code);
    }

    fn refuseChargeLocked(g: *Group, id: []const u8, fuel: i64, valid: bool, code: []const u8) void {
        // A foreign thread must not write the worker's Trace writer/arena.
        const call = g.gpa.dupe(u8, id) catch return;
        g.refused_charges.append(g.gpa, .{ .call = call, .fuel = fuel, .valid = valid, .code = code }) catch g.gpa.free(call);
    }

    pub fn flushChargeRefusals(g: *Group) void {
        g.input_lock.lock();
        const rows = g.refused_charges;
        g.refused_charges = .empty;
        g.input_lock.unlock();
        var owned = rows;
        defer owned.deinit(g.gpa);
        for (rows.items) |x| {
            defer g.gpa.free(x.call);
            g.write("> charge-request {s} fuel=", .{x.call});
            if (x.valid) g.write("{d}", .{x.fuel}) else g.write("\"invalid\"", .{});
            g.write("\nrefused code=\"{s}\"\n", .{x.code});
        }
    }

    fn drainCharge(g: *Group, q: *capabilities.ChargeRequest) !void {
        if (!q.processed) {
            const pending = for (g.pending.items) |p| {
                if (p.call) |c| if (std.mem.eql(u8, c.id, q.call)) break p;
            } else null;
            q.status = if (pending) |p| (if (q.fuel <= fuelLeft(p.run)) .accepted else .limit) else .inactive;
            q.processed = true;
            g.write("charge-result {s} {s} fuel={d} status={s}\n", .{ q.call, q.id, q.fuel, @tagName(q.status) });
            try g.reports.add(.{ .charge_result = .{ .request = try g.reports.text(q.id), .call = try g.reports.text(q.call), .fuel = q.fuel, .status = q.status } });
            if (pending) |p| {
                const run = p.run;
                if (q.status == .accepted) {
                    run.fuel += q.fuel;
                    // Keep queued charges out of the next Stretch's total.
                    run.segment_fuel += q.fuel;
                    run.script.spent += q.fuel;
                    g.pump_fuel += q.fuel;
                    g.markRoot(rootOf(run.delivery));
                } else {
                    const c = p.call.?;
                    var ins: lower.Instruction = undefined;
                    ins.position = .{ .line = c.at_line, .column = c.at_column };
                    if (!run.continuing) g.dropBase(run);
                    _ = g.limitFault(run, .fuel, c.at_unit, c.at_pc, ins);
                    q.fault_run = run;
                }
            }
        }
        if (q.fault_run) |ptr| {
            const run: *Run = @ptrCast(@alignCast(ptr));
            try g.cleanupLifecycle(run);
            const s = run.script;
            for (s.live.items, 0..) |r, i| if (r == run) {
                _ = s.live.orderedRemove(i);
                break;
            };
            var i: usize = 0;
            while (i < s.work.items.len) {
                if (s.work.items[i] == .run and s.work.items[i].run == run) {
                    _ = s.work.orderedRemove(i);
                } else i += 1;
            }
            q.fault_run = null;
            if (g.fatal) {
                try g.stopGroup(run);
                g.destroyRun(run);
                return;
            }
            try g.finishRun(s, run, .{ .faulted = .fuel }, g.segmentId(run));
        }
    }

    fn settleChargeRequests(g: *Group) void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        for (g.charge_requests.items) |q| if (q.processed and q.fault_run == null) q.done.store(true, .release);
    }

    /// Drains the input queue from its head, each input taken once it has
    /// run. One deferred at a lifecycle crossing stays at the head, and the
    /// Pump pauses; `resumePump` drains on from it.
    fn drain(g: *Group) !void {
        g.draining = true;
        while (g.batch.items.len > 0) {
            const input = g.batch.items[0];
            // These may defer, so the drain keeps their text until they've
            // run; the others' arms take what they own.
            const kept = switch (input) {
                .stop, .cancel_run, .rewind_run => true,
                .settlement => |x| x.how == .reissue,
                else => false,
            };
            g.drainOne(input) catch |e| {
                if (e == error.Deferred) {
                    g.crossing_pause = true;
                    return;
                }
                // Refused partway, the input taken is gone from the queue,
                // and the rest stay for `deinit`.
                _ = g.batch.orderedRemove(0);
                if (kept) g.releaseInputs(&.{input});
                g.draining = false;
                return e;
            };
            _ = g.batch.orderedRemove(0);
            if (kept) g.releaseInputs(&.{input});
            // Reissued Start is a Host crossing. Land its controls before
            // another settlement can invoke a sibling Start. The input is
            // already consumed, so deferred cleanup resumes only the landing.
            if (input == .settlement and input.settlement.how == .reissue) {
                g.land(null) catch |e| {
                    if (e != error.Deferred) return e;
                    g.crossing_pause = true;
                    return;
                };
            }
            if (g.release_pause) {
                g.crossing_pause = true;
                return;
            }
        }
        g.draining = false;
        try g.afterDrain();
    }

    fn drainOne(g: *Group, input: Input) !void {
        switch (input) {
            .charge_request => |q| try g.drainCharge(q),
            .deliver => |d| {
                defer g.gpa.free(d.script);
                if (d.delivery.target != null) {
                    try g.route(d.delivery);
                    return;
                }
                const s = g.script(d.script) orelse {
                    g.releaseDelivery(d.delivery);
                    return;
                };
                // A Host call of a Function Value that's gone, or whose Home
                // Script is stopped, runs nothing.
                if (d.delivery.function) |f| if (s.stopped != null or g.codeOf(f) == null or g.functionBody(g.codeOf(f).?) == null) {
                    g.write("note d{d} kind=function-gone\n", .{d.delivery.id});
                    g.releaseDelivery(d.delivery);
                    return;
                };
                try g.post(s, d.delivery);
            },
            .set_parent => |x| {
                // Checked again against what earlier inputs left.
                if (parentRefusal(x.object, x.parent)) |code| {
                    g.write("refused code=\"{s}\"\n", .{code});
                    g.addReport(.{ .host_error = .{ .code = code } });
                } else x.object.parent = x.parent;
            },
            .dispose => |o| {
                o.disposed = true;
                // Disposing a Script's owner stops it, in this same input.
                for (g.scripts.items) |x| if (x.owner == o) try g.stopScript(x, "owner disposed", null, .{});
            },
            .cancel_run => |id| {
                for (g.scripts.items) |x| for (x.live.items) |r| if (std.mem.eql(u8, r.id, id)) {
                    try g.cancel(x, r);
                    break;
                };
            },
            .cancel_delivery => |id| try g.cancelDelivery(id),
            .rewind_run => |id| try g.rewind(id, null),
            .stop => |x| {
                // A repeated Stop does nothing, and keeps the first reason.
                const target = g.script(x.script) orelse return;
                try g.stopScript(target, x.reason, null, .{});
            },
            .revoke => |x| {
                defer g.gpa.free(x.script);
                defer g.gpa.free(x.grant);
                // The first revocation of a name the Script keeps releases
                // it; any other does nothing.
                const s = g.script(x.script) orelse return;
                const sg = s.grant(x.grant) orelse return;
                if (sg.revoked) return;
                sg.revoked = true;
                g.releaseGrant(s, sg, .revoke);
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
                    return;
                };
                const p = g.pending.orderedRemove(i);
                try g.ready(p, x.with);
            },
            .broadcast => |b| try g.drainBroadcast(b),
            .settlement => |x| {
                defer if (x.how != .reissue) g.gpa.free(x.id);
                switch (x.how) {
                    .answer, .fail => {
                        const index = for (g.pending.items, 0..) |p, i| {
                            if (p.call) |c| if (std.mem.eql(u8, c.id, x.id)) break i;
                        } else null;
                        const i = index orelse {
                            g.releaseResume(x.with.?);
                            return;
                        };
                        try g.ready(g.pending.orderedRemove(i), x.with.?);
                    },
                    .reissue => try g.reissue(x.id),
                    .adopt => {},
                }
            },
        }
    }

    /// The Pump after its inputs: a restore's lost calls, discarded
    /// Decisions, due timers, then the turns.
    fn afterDrain(g: *Group) !void {
        // After a restore's settlements, every call still unsettled is
        // lost, in call id order, before any timer fires.
        if (g.restored) |*r| {
            defer {
                r.deinit(g.gpa);
                g.restored = null;
            }
            for (r.pending.items) |id| {
                for (r.settled.items) |x| {
                    if (std.mem.eql(u8, x, id)) break;
                } else for (g.pending.items, 0..) |p, i| {
                    const c = p.call orelse continue;
                    if (!std.mem.eql(u8, c.id, id)) continue;
                    abandonCall(p);
                    try g.ready(g.pending.orderedRemove(i), .lost);
                    break;
                }
            }
        }
        // The open Decisions a variables-only restore discarded settle
        // undecided, `cancelled`, before any Stretch.
        if (g.deferred.items.len > 0) {
            std.mem.sort(Deferred, g.deferred.items, {}, struct {
                fn less(_: void, x: Deferred, y: Deferred) bool {
                    return x.id < y.id;
                }
            }.less);
            defer g.deferred.clearRetainingCapacity();
            for (g.deferred.items) |*x| {
                const m = x.mark orelse {
                    try g.sealAs(x.id, true, &.{}, .undecided);
                    continue;
                };
                x.mark = null;
                defer g.releaseMark(m);
                try g.takePart(.{ .id = x.id, .message = "", .args = &.{}, .request = false, .decision = true, .broadcast = x.broadcast }, .{ .undecided = m });
            }
        }
        // Due timers, in deadline order, then the order they were set; a
        // Rewind drained returns at once.
        const now = nanos(g.clock);
        while (!g.rewound) {
            var first: ?usize = null;
            for (g.pending.items, 0..) |p, i| {
                if (p.deadline > now) continue;
                if (first == null or p.deadline < g.pending.items[first.?].deadline or (p.deadline == g.pending.items[first.?].deadline and p.order < g.pending.items[first.?].order)) first = i;
            }
            const i = first orelse break;
            const p = g.pending.orderedRemove(i);
            const with: Resume = if (p.call != null or p.id.len > 0 or p.block) .timeout else if (p.event != null) .{ .event = .{ .message = null, .branch = p.branch } } else .woke;
            abandonCall(p);
            try g.ready(p, with);
        }
        g.turn_at = 0;
        try g.turns();
    }

    /// Takes a Pump paused at a Host crossing up again: the same turns,
    /// with the same Clock, slice and cap, and no second `pump` record.
    pub fn resumePump(g: *Group) !void {
        g.pumping = true;
        defer g.pumping = false;
        g.crossing_pause = false;
        if (g.landing_paused) g.land(g.landing_run) catch |e| {
            if (e != error.Deferred) return e;
            g.crossing_pause = true;
            return;
        };
        if (g.release_pause) {
            g.crossing_pause = true;
            return;
        }
        if (g.draining) return g.drain();
        try g.turns();
    }

    /// Whether the Pump in progress paused at a Host crossing.
    pub fn pumpPaused(g: *const Group) bool {
        return g.crossing_pause;
    }

    // Turns: each Script with work, in load order, round and round,
    // until the work is done, every Script with work has spent its slice
    // or the Group has spent its cap. A crossing pause returns at once,
    // its tail unwritten.
    fn turns(g: *Group) !void {
        var busy = true;
        turns: while (busy) {
            busy = false;
            while (g.turn_at < g.scripts.items.len) {
                const s = g.scripts.items[g.turn_at];
                g.turn_at += 1;
                // What landed during the last turn, and a Rewind, which
                // ends the Pump.
                if (!g.answering_crossing and g.landing.items.len > 0) g.land(null) catch |e| {
                    if (e != error.Deferred) return e;
                    g.crossing_pause = true;
                    g.turn_at -= 1;
                    return;
                };
                if (g.release_pause) {
                    g.crossing_pause = true;
                    g.turn_at -= 1;
                    return;
                }
                // A Rewind of another Run ends this Pump after the active
                // callback and its Segment finalization finish, including
                // continuations paused at lifecycle crossings.
                const resuming_crossing = s.work.items.len > 0 and s.work.items[0] == .run and (s.work.items[0].run.crossed != null or s.work.items[0].run.ending != null);
                if (g.rewound and !resuming_crossing) break :turns;
                if (s.work.items.len == 0) continue;
                if (g.fatal) break :turns;
                if (g.cap > 0 and g.pump_fuel >= g.cap) {
                    g.sliced = true;
                    break :turns;
                }
                if (g.slice > 0 and s.spent >= s.allowance) {
                    g.sliced = true;
                    continue;
                }
                busy = true;
                switch (s.work.orderedRemove(0)) {
                    .message => |head| {
                        // The path is walked when the message reaches the
                        // head of the mailbox: it may have moved, and a
                        // climb reads the parent it climbs to now.
                        var d = head;
                        if (d.passed_by) |p| d.at = p.parent orelse {
                            try g.unhandled(d);
                            continue;
                        };
                        if (d.at) |at| {
                            const owner = at.owned() orelse {
                                try g.unhandled(d);
                                continue;
                            };
                            const to = g.script(owner.owner_of.?).?;
                            if (to != s) {
                                try g.post(to, d);
                                continue;
                            }
                        }
                        // A `wait for` that takes a Decision allows it.
                        // Refused before its Run takes it, the message goes.
                        var taken = d;
                        const seen = g.observe(s, d) catch |e| {
                            g.releaseDelivery(d);
                            return e;
                        };
                        if (seen and d.decision) {
                            taken.decision = false;
                            g.takePart(d, .allowed) catch |e| {
                                g.releaseDelivery(d);
                                return e;
                            };
                        }
                        try g.startRun(s, taken);
                    },
                    .run => |r| try g.resumeRun(s, r),
                }
                if (g.crossing_pause) {
                    // Resume at this Script: its parked Run heads its work.
                    g.turn_at -= 1;
                    return;
                }
                if (g.release_pause) {
                    g.crossing_pause = true;
                    return;
                }
            }
            g.turn_at = 0;
        }
        g.land(null) catch |e| {
            if (e != error.Deferred) return e;
            g.crossing_pause = true;
            return;
        };
        if (g.release_pause) {
            g.crossing_pause = true;
            return;
        }
        // A slice overrun is carried to the Script's next Pump as debt.
        if (g.slice > 0) for (g.scripts.items) |x| {
            if (x.spent > x.allowance) x.debt += x.spent - x.allowance;
        };
        g.write("pumped state={s} fuel={d}", .{ if (g.stoppedState()) "stopped" else if (g.rewound) "rewound" else if (g.sliced) "sliced" else "idle", g.pump_fuel });
        if (g.next()) |deadline| {
            const at: model.dates.Instant = .{ .seconds = @intCast(@divFloor(deadline, std.time.ns_per_s)), .nanos = @intCast(@mod(deadline, std.time.ns_per_s)) };
            const text = try model.dates.string(g.scratch.allocator(), model.dates.fields(at), true);
            g.write(" next={s}", .{text});
        }
        g.write("\n", .{});
        g.settleChargeRequests();
    }

    /// The earliest deadline still pending.
    pub fn next(g: *Group) ?i128 {
        var best: ?i128 = null;
        for (g.pending.items) |p| if (p.deadline != never and (best == null or p.deadline < best.?)) {
            // A preempted Run's Join hasn't reached its end, so its members'
            // waits aren't timers yet.
            if (p.member != null and p.run.continuing) continue;
            best = p.deadline;
        };
        return best;
    }

    /// A settled wait: its Run becomes ready, at the back of its Script's
    /// work.
    pub fn ready(g: *Group, p: *Pending, with: Resume) !void {
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
                // The other members stop waiting now; the Run abandons them
                // when it resumes.
                for (join.members.items) |*x| if (x.pending) |w| {
                    for (g.pending.items, 0..) |y, i| if (y == w) {
                        _ = g.pending.orderedRemove(i);
                        break;
                    };
                    abandonCall(w);
                    g.destroyPending(w);
                    x.pending = null;
                    x.cut = true;
                };
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

    /// A Script's Counters (chapter 9, Script counters): its lifetime work,
    /// live Runs included, and its current state. Reading them charges
    /// nothing and drains no Host Inputs.
    pub const Counters = struct { fuel_total: u64, alloc_total: u64, runs: u64, faults: u64, persistent_state: u64, mailbox_len: u64 };

    /// Reads a Script's Counters, writing the `counters` Host Input and its
    /// record.
    pub fn counters(g: *Group, s: *Script) Counters {
        var out: Counters = .{ .fuel_total = s.fuel_total, .alloc_total = s.alloc_total, .runs = s.runs, .faults = s.faults, .persistent_state = g.persistentState(s), .mailbox_len = 0 };
        for (s.live.items) |r| {
            out.fuel_total += r.fuel;
            out.alloc_total += r.alloc;
        }
        for (s.work.items) |w| if (w == .message) {
            out.mailbox_len += 1;
        };
        g.write("> counters {s}\ncounters {s} fuel={d} alloc={d} runs={d} faults={d} state={d} mailbox={d}\n", .{ s.name, s.name, out.fuel_total, out.alloc_total, out.runs, out.faults, out.persistent_state, out.mailbox_len });
        return out;
    }

    /// The Group Fingerprint (chapter 9): its Libraries, and each Script's
    /// identity, Grants and limits.
    pub fn groupFingerprint(g: *Group) ![32]u8 {
        var arena: std.heap.ArenaAllocator = .init(g.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const libraries = try a.alloc(fingerprint.Library, g.libraries.items.len);
        for (g.libraries.items, libraries) |l, *x| x.* = .{ .name = l.name, .identity = l.identity };
        const scripts = try a.alloc(fingerprint.Script, g.scripts.items.len);
        for (g.scripts.items, scripts) |s, *x| {
            const grants = try a.alloc(fingerprint.Grant, s.grants.len);
            for (s.grants, grants) |sg, *y| y.* = .{ .name = sg.name, .json = sg.declarations orelse try fingerprint.grantJson(a, sg.grant.capability, sg.kept) };
            x.* = .{ .name = s.name, .identity = s.identity, .grants = grants, .limits = limitValues(s.limits) };
        }
        return fingerprint.compute(libraries, scripts);
    }

    pub const SettleError = error{ UnknownCall, NotAdoptable, OutOfMemory };

    /// Queues a restored pending call's settlement (chapter 10, Settling
    /// pending calls). A call id that isn't pending, one settled already, or
    /// any once the first Pump has started, is `unknown call` at the call,
    /// and queues nothing. Takes `with`, an answer's or failure's Resume.
    pub fn settleRestored(g: *Group, id: []const u8, how: How, with: ?Resume) SettleError!void {
        g.input_lock.lock();
        defer g.input_lock.unlock();
        errdefer if (with) |w| g.releaseResume(w);
        if (g.settlements_closed) return error.UnknownCall;
        const r = if (g.restored) |*x| x else return error.UnknownCall;
        for (r.pending.items) |p| {
            if (std.mem.eql(u8, p, id)) break;
        } else return error.UnknownCall;
        for (r.settled.items) |x| if (std.mem.eql(u8, x, id)) return error.UnknownCall;
        const own = try g.gpa.dupe(u8, id);
        errdefer g.gpa.free(own);
        try r.settled.ensureUnusedCapacity(g.gpa, 1);
        try g.inputs.append(g.gpa, .{ .settlement = .{ .id = own, .how = how, .with = with } });
        // The settled list borrows the pending list's id.
        for (r.pending.items) |p| if (std.mem.eql(u8, p, id)) r.settled.appendAssumeCapacity(p);
    }

    /// A refused settlement, with its record: written at the call, with the
    /// ids the Host supplied.
    pub fn refuseSettlement(g: *Group, id: []const u8, how: How, value: ?*const Value) void {
        const out = g.trace orelse return;
        out.print("> settle {s} how={s}", .{ id, @tagName(how) }) catch {};
        if (value) |v| {
            out.writeAll(if (how == .answer) " value=" else " error=") catch {};
            display.writeTrace(out, v) catch {};
        }
        out.writeAll("\nrefused code=\"unknown call\"\n") catch {};
    }

    /// Reissue (chapter 10): runs the pending call's Operation's Start again,
    /// with its saved arguments and its Grant's binding, under the same call
    /// id and this Pump's Clock. Its declared cost isn't charged again; a
    /// `Charge` draws Fuel from the Run as it would at the call.
    fn reissue(g: *Group, id: []const u8) !void {
        const index = for (g.pending.items, 0..) |p, i| {
            if (p.call) |c| if (std.mem.eql(u8, c.id, id)) break i;
        } else return;
        const p = g.pending.items[index];
        const run = p.run;
        const c = p.call.?;
        // A Grant the restore couldn't re-bind fails it, never reaching a
        // Host; a revocation since doesn't, since the call was in flight.
        const sg = run.script.grant(p.grant) orelse return g.ready(g.pending.orderedRemove(index), .revoked);
        if (sg.declarations != null) return g.ready(g.pending.orderedRemove(index), .revoked);
        const decl = p.decl.?;
        c.starting = true;
        c.charged = 0;
        c.now = g.clock;
        c.binding = sg.grant.binding;
        c.left = run.limits.fuel_per_run -| run.fuel;
        c.deferrable = true;
        const held = g.holdTrace();
        const outcome = decl.host.call(decl.host.context, c, c.args);
        g.flushChargeRefusals();
        g.trace = held;
        if (outcome == .deferred) return error.Deferred;
        c.starting = false;
        run.fuel += c.charged;
        g.pump_fuel += c.charged;
        run.script.spent += c.charged;
        if (g.trace) |w| {
            w.print("call {s} op={s}.{s} args=[", .{ id, p.grant, p.operation }) catch {};
            for (c.args, 0..) |v, k| {
                if (k > 0) w.writeAll(", ") catch {};
                display.writeTrace(w, v) catch {};
            }
            w.writeAll("]") catch {};
            if (c.charged > 0) w.print(" charged={d}", .{c.charged}) catch {};
            w.writeAll("\n") catch {};
        }
        g.flushHeld();
        switch (outcome) {
            .started => {},
            .value => |v| try g.ready(g.pending.orderedRemove(index), .{ .answer = .{ .value = v, .fuel = 0 } }),
            .failed => |f| try g.ready(g.pending.orderedRemove(index), .{ .failed = .{ .code = f.code, .message = f.message, .data = f.data } }),
            .limited => try g.ready(g.pending.orderedRemove(index), .limited),
            else => try g.ready(g.pending.orderedRemove(index), .broken),
        }
    }

    /// A Pump refused at the call, with its record, which drains nothing.
    pub fn refusePump(g: *Group, clock: model.dates.Instant, slice: i64, cap: i64) void {
        const shown = model.dates.string(g.scratch.allocator(), model.dates.fields(clock), true) catch return;
        g.write("> pump clock={s}", .{shown});
        if (slice > 0) g.write(" fuel-slice={d}", .{slice});
        if (cap > 0) g.write(" fuel-cap={d}", .{cap});
        g.write("\nrefused code=\"clock backwards\"\n", .{});
    }

    /// Writes a `vars` record for each Script.
    pub fn vars(g: *Group) void {
        g.write("> vars\n", .{});
        const w = g.trace orelse return;
        for (g.scripts.items) |s| {
            w.print("vars {s}", .{s.name}) catch {};
            for (s.variableNames(), s.variables) |name, v| {
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
        if (d.broadcast > 0) w.print(" broadcast=b{d}", .{d.broadcast}) catch {};
    }

    /// Starts a Run for a message: dispatch tries each clause of the
    /// Handler, in order, whose parameter count fits.
    fn startRun(g: *Group, s: *Script, d: Delivery) !void {
        // An `error` message with no `on error` is dropped unseen.
        if (d.internal_error) {
            if (s.handlerUnit("error", .handler) == null) return g.releaseDelivery(d);
        }
        s.runs += 1;
        const run = g.gpa.create(Run) catch |e| {
            g.releaseDelivery(d);
            return e;
        };
        const id = std.fmt.allocPrint(g.gpa, "{s}/r{d}", .{ s.name, s.runs }) catch |e| {
            g.gpa.destroy(run);
            g.releaseDelivery(d);
            return e;
        };
        run.* = .{ .id = id, .script = s, .delivery = d, .handler = d.message, .limits = Override.apply(d.limits, s.limits) };
        g.reportRunStarted(s, run);
        g.takeBase(run) catch |e| {
            g.destroyRun(run);
            return e;
        };
        // A Run that can't go on, as when the Group's allocator refuses,
        // is dropped whole.
        const outcome = g.dispatchRun(s, run, d) catch |e| {
            g.destroyRun(run);
            return e;
        };
        if (outcome == .preempted) return g.preempt(s, run, outcome.preempted);
        try g.endSegment(s, run, outcome);
    }

    /// A new Run's first Segment: a foreign call's frame, or dispatch to
    /// its clauses and then the Fallback's.
    fn dispatchRun(g: *Group, s: *Script, run: *Run, d: Delivery) !Outcome {
        if (d.function) |fv| {
            // A foreign call: one frame, no Handler Clause, so no `clause`.
            const code = g.codeOf(fv).?;
            // A Host call with the wrong number of arguments raises at the
            // function's first instruction, before anything runs.
            if (d.args.len < code.required or d.args.len > code.total) {
                try g.pushFrameIn(run, code.library, code.body, &.{});
                const first = run.frames.items[0].pc;
                const ins = s.unitIn(code.library).code[first];
                switch (g.raise("wrong arity", &.{})) {
                    error.Raised => {},
                    error.OutOfMemory => return error.OutOfMemory,
                }
                const err = try g.completeError(run, first, ins);
                if (try g.unwind(run, err, first, ins, false)) |end| return end;
                return g.execute(run, true);
            }
            try g.callFunction(run, code.library, code.body, d.args);
            const callee = &run.frames.items[run.frames.items.len - 1];
            const body = g.functionBody(code).?;
            for (0..fv.data.function.captures.data.map.len, body.capture_slot..) |i, slot| {
                const p = fv.data.function.captures.data.map.at(i);
                callee.locals[slot].release();
                callee.locals[slot] = p.value.retain();
            }
            return g.execute(run, true);
        }
        return g.dispatchFrom(s, run, d, 0, false);
    }

    /// Tries the Handler's clauses from body `from`, then the Fallback's, or
    /// with `fallback` the Fallback's from `from`. A Run preempted in a
    /// clause's patterns or Guard goes on from the next one.
    fn dispatchFrom(g: *Group, s: *Script, run: *Run, d: Delivery, from: usize, fallback: bool) !Outcome {
        // A Handler's clauses, and the Fallback's, are each in one unit.
        if (!fallback) if (s.handlerUnit(d.message, .handler)) |place| {
            for (s.unitIn(place.library).bodies[from..], from..) |b, i| {
                if (b.kind != .handler or !std.mem.eql(u8, b.name, d.message)) continue;
                run.clauses_seen += 1;
                if (b.params.len != d.args.len) continue;
                run.clause = run.clauses_seen;
                if (try g.tryClause(s, run, place.library, @intCast(i), d.args, d.during, false)) |end| return end;
            }
        };
        if (!fallback) {
            // No named clause took it: the Fallback's clauses, with the
            // message map, built without charge. A Broadcast, a Decision and
            // an `error` message never reach them.
            if (d.internal_error or d.decides or d.broadcast != 0) return .unhandled;
        }
        const place = s.handlerUnit("any message", .fallback) orelse return .unhandled;
        const message = try g.messageMap(d);
        defer message.release();
        for (s.unitIn(place.library).bodies[if (fallback) from else 0..], if (fallback) from else 0..) |b, i| {
            if (b.kind != .fallback) continue;
            run.fallback = true;
            run.clause = b.clause orelse 1;
            if (try g.tryClause(s, run, place.library, @intCast(i), &.{message}, null, true)) |end| return end;
        }
        return .unhandled;
    }

    /// Goes on with a preempted Run: its dispatch, if a clause's patterns or
    /// Guard were running, or else its body.
    fn continueRun(g: *Group, s: *Script, run: *Run) !Outcome {
        if (run.resume_with) |w| if (w == .cancelled) {
            run.resume_with = null;
            return g.startCancel(run);
        };
        const in = run.preempted_in orelse return g.execute(run, true);
        run.preempted_in = null;
        const outcome = try g.execute(run, true);
        if (try g.afterGuard(s, run, in.library, in.body, outcome, in.fallback)) |end| return end;
        return g.dispatchFrom(s, run, run.delivery, in.body + 1, in.fallback);
    }

    /// Tries one clause for a Run being dispatched, charging it: null if
    /// its patterns or Guard fail. Once they pass, its Queueing Policy
    /// applies while another Run of the clause hasn't ended.
    /// A selected clause takes its Run's Decision: a `, deciding` clause
    /// holds the Verdict, and any other allows it at dispatch.
    fn takeVerdict(g: *Group, run: *Run, deciding: bool) !void {
        if (!run.delivery.decision) return;
        run.delivery.decision = false;
        if (deciding) run.verdict = true else try g.takePart(run.delivery, .allowed);
    }

    fn tryClause(g: *Group, s: *Script, run: *Run, library: ?*Library, body: u32, args: []const *Value, during: ?*Value, fallback: bool) !?Outcome {
        const unit = s.unitIn(library);
        const b = unit.bodies[body];
        run.clause_body = body;
        run.clause_unit = library;
        try g.pushFrameIn(run, library, body, args);
        if (b.during) |slot| if (during) |x| {
            const f = &run.frames.items[run.frames.items.len - 1];
            f.locals[slot].release();
            f.locals[slot] = x.retain();
        };
        // Dispatch charges the clause at the body's first instruction,
        // together with that instruction's own charge.
        run.clause_fuel = 4;
        run.select_at = b.first;
        for (unit.unwind) |e| if (e.kind == .guard and e.first == b.first) {
            run.select_at = e.last + 1;
        };
        return g.afterGuard(s, run, library, body, try g.execute(run, true), fallback);
    }

    /// What follows a clause's patterns and Guard: its Queueing Policy and
    /// its body once they pass, or null when they fail.
    fn afterGuard(g: *Group, s: *Script, run: *Run, library: ?*Library, body: u32, first: Outcome, fallback: bool) !?Outcome {
        const b = s.unitIn(library).bodies[body];
        var outcome = first;
        if (outcome == .preempted and run.select_at != null) run.preempted_in = .{ .library = library, .body = body, .fallback = fallback };
        if (outcome == .selected) {
            // A clause with no patterns or Guard is tried at its body's first
            // instruction, which pays the `clause` rate. A Run that parks or
            // is dropped here pays it now; one that goes on pays it with that
            // instruction's fixed rate. A Run that can't faults there, before
            // the clause is taken.
            const waits = g.clauseBusy(s, library, body) and (b.policy == .queued or b.policy == .dropping);
            if (run.clause_fuel > 0) {
                const f = &run.frames.items[run.frames.items.len - 1];
                const head = unitOf(run, f).code[f.pc];
                var none: costs.Measures = .{};
                const need = run.clause_fuel + if (waits) 0 else costs.chargeInstruction(head.op, &none).fuel;
                if (need > fuelLeft(run)) return g.limitFault(run, .fuel, unitName(run, f), f.pc, head);
            }
            if (waits) {
                run.fuel += run.clause_fuel;
                run.clause_fuel = 0;
            }
            if (g.clauseBusy(s, library, body)) switch (b.policy) {
                .queued => {
                    // Parking is a suspension, which measures the Script's
                    // Persistent State with the Run.
                    if (g.persistentState(s) + g.runSize(run) > s.limits.persistent_state) {
                        const f = &run.frames.items[run.frames.items.len - 1];
                        return g.limitFault(run, .persistent, unitName(run, f), f.pc, unitOf(run, f).code[f.pc]);
                    }
                    try g.takeVerdict(run, b.deciding);
                    run.parked = true;
                    run.suspended_at = "park";
                    return .suspended;
                },
                .dropping => {
                    // A dropped Run ends, which measures the Script's
                    // Persistent State without it.
                    if (g.persistentState(s) > s.limits.persistent_state) {
                        const f = &run.frames.items[run.frames.items.len - 1];
                        return g.limitFault(run, .persistent, unitName(run, f), f.pc, unitOf(run, f).code[f.pc]);
                    }
                    return .dropped;
                },
                .replacing => try g.cancelClause(s, library, body),
                .none => {},
            };
            try g.takeVerdict(run, b.deciding);
            outcome = try g.execute(run, true);
        }
        if (outcome == .clause_failed) {
            run.clause_body = null;
            return null;
        }
        return outcome;
    }

    /// Whether the running Run must stop before its next instruction: its
    /// Script's slice spent, or else the Group's cap.
    fn preemption(g: *Group, run: *const Run) ?Preemption {
        const stretch = run.fuel - run.segment_fuel;
        if (g.slice > 0 and run.script.spent + stretch >= run.script.allowance) return .slice;
        if (g.cap > 0 and g.pump_fuel + stretch >= g.cap) return .cap;
        return null;
    }

    /// Ends a preempted Run's Stretch with its `preempt` record. It stays at
    /// the head of its Script's work, in the middle of its Segment.
    fn preempt(g: *Group, s: *Script, run: *Run, by: Preemption) !void {
        // A crossing pause is the transport's, not the Run's: it ends no
        // Stretch and writes no record, and the Pump stops here instead of
        // taking another turn. The Run goes on as if it hadn't paused.
        if (by == .crossing) {
            g.crossing_pause = true;
            run.crossed = .{ .started = run.started, .continuing = run.continuing };
            run.continuing = true;
            return g.park(s, run);
        }
        const fuel = run.fuel - run.segment_fuel;
        const alloc = run.alloc - run.segment_alloc;
        g.pump_fuel += fuel;
        s.spent += fuel;
        {
            if (g.trace) |out| {
                out.print("preempt {s} {s}", .{ run.id, if (run.continuing) "continue" else if (run.started) "resume" else "start" }) catch {};
                if (!run.started) g.writeStart(out, s, run, run.clause_body != null);
                out.print(" by={s} fuel={d} alloc={d}\n", .{ @tagName(by), fuel, alloc }) catch {};
            }
            g.writeAbandoned(run);
        }
        run.started = true;
        run.continuing = true;
        run.segment_fuel = run.fuel;
        run.segment_alloc = run.alloc;
        return g.park(s, run);
    }

    /// Puts a Run at the head of its Script's work, live.
    fn park(g: *Group, s: *Script, run: *Run) !void {
        s.live.append(g.gpa, run) catch |e| {
            g.destroyRun(run);
            return e;
        };
        s.work.insert(g.gpa, 0, .{ .run = run }) catch |e| {
            _ = s.live.pop();
            g.destroyRun(run);
            return e;
        };
    }

    /// A cancellation's abandoned calls, once, after its first cleanup
    /// Stretch.
    fn writeAbandoned(g: *Group, run: *Run) void {
        for (run.abandoned.items) |id| g.write("abandon {s}\n", .{id});
        run.abandoned.clearAndFree(g.gpa);
    }

    /// A first Stretch's start keys.
    fn writeStart(g: *Group, out: *std.Io.Writer, s: *Script, run: *const Run, clause: bool) void {
        const d = run.delivery;
        writeOrigin(out, d);
        // An unhandled Run names its Handler only if the Script has one.
        if (run.fallback or g.hasHandler(s, run.handler)) out.print(" handler={s}", .{run.handler}) catch {};
        if (run.fallback) out.writeAll(" fallback=yes") catch {};
        if (d.function) |f| {
            out.writeAll(" fn=") catch {};
            display.writeTrace(out, f) catch {};
        }
        if (d.function == null and clause) out.print(" clause={d}", .{run.clause}) catch {};
    }

    /// Resumes a ready Run with what settled its wait.
    fn resumeRun(g: *Group, s: *Script, run: *Run) !void {
        for (s.live.items, 0..) |r, i| if (r == run) {
            _ = s.live.orderedRemove(i);
            break;
        };
        // A Segment end paused at a lifecycle crossing goes on from there.
        if (run.ending) |e| return g.endSegment(s, run, e.outcome);
        // A Run paused at a crossing makes the same instruction again, in
        // the same Stretch, its records as if it hadn't paused.
        if (run.crossed) |was| {
            run.crossed = null;
            run.started = was.started;
            run.continuing = was.continuing;
            const outcome = (if (run.crossing_cancel) g.landedCancel(run) else g.continueRun(s, run)) catch |e| {
                g.destroyRun(run);
                return e;
            };
            if (outcome == .preempted) return g.preempt(s, run, outcome.preempted);
            return g.endSegment(s, run, outcome);
        }
        run.segment_fuel = run.fuel;
        run.segment_alloc = run.alloc;
        // A preempted Run goes on in the same Segment.
        const outcome = if (run.continuing) g.continueRun(s, run) catch |e| {
            g.destroyRun(run);
            return e;
        } else blk: {
            g.takeBase(run) catch |e| {
                g.destroyRun(run);
                return e;
            };
            break :blk g.resumed(run) catch |e| {
                g.destroyRun(run);
                return e;
            };
        };
        if (outcome == .preempted) return g.preempt(s, run, outcome.preempted);
        try g.endSegment(s, run, outcome);
    }

    /// A resumed Run's Segment, from what settled its wait.
    fn resumed(g: *Group, run: *Run) !Outcome {
        const with = run.resume_with.?;
        run.resume_with = null;
        switch (with) {
            .unparked => return g.execute(run, true),
            .cancelled => return g.startCancel(run),
            else => {},
        }
        const waited = run.waited;
        const frame = &run.frames.items[run.frames.items.len - 1];
        const pc = frame.pc - 1;
        const ins = unitOf(run, frame).code[pc];
        // A reissue the Run couldn't pay for faults at its call, which is
        // abandoned.
        if (with == .limited) {
            const end = g.limitFault(run, .fuel, unitName(run, frame), pc, ins);
            g.write("abandon {s}\n", .{waited.id});
            return end;
        }
        const fuel = run.fuel;
        const alloc = run.alloc;
        const raised: ?*Value = g.resumeWith(run, frame, with, waited, pc, ins) catch |err| {
            if (err != error.LimitFault) return err;
            const limit = g.pending_fault.?;
            g.pending_fault = null;
            return g.limitFault(run, limit, unitName(run, frame), pc, ins);
        };
        // An answer whose cost takes the Run over its Fuel faults at its
        // call, and isn't charged.
        if (raised == null and run.cleanup_from == null and run.fuel > fuel and run.fuel > run.limits.fuel_per_run) {
            run.fuel = fuel;
            run.alloc = alloc;
            return g.limitFault(run, .fuel, unitName(run, frame), pc, ins);
        }
        if (raised) |err| {
            const outcome = try g.unwind(run, err, pc, ins, true);
            if (with == .timeout and waited.id.len > 0) g.write("abandon {s}\n", .{waited.id});
            if (outcome) |end| return end;
        }
        return g.execute(run, true);
    }

    /// Settlement conversion is atomic for both answers and failures: a
    /// rejected conversion neither charges nor enters Script error recovery.
    fn payResumeConversion(g: *Group, run: *Run, fuel: u64, alloc: u64) !void {
        if (fuel > fuelLeft(run)) return g.faultOn(.fuel);
        if (run.alloc + alloc > run.limits.alloc_per_run) return g.faultOn(.alloc);
        run.fuel += fuel;
        run.alloc += alloc;
    }

    /// What a resumed Run's wait gave: a value pushed, or an error raised.
    fn resumeWith(g: *Group, run: *Run, frame: *Frame, with: Resume, waited: Waited, pc: u32, ins: lower.Instruction) !?*Value {
        if (waited.call) |c| c.settlement_consumed = true;
        const gpa = g.gpa;
        switch (with) {
            .woke => return null,
            // resumeRun handles these before any wait's value.
            .unparked, .cancelled, .limited => unreachable,
            .lost => return try g.resumeRaise(run, pc, ins, g.raise("call lost", &.{})),
            .revoked => {
                const where = [_]model.Pair{
                    .{ .key = "capability", .value = try model.text(gpa, waited.grant) },
                    .{ .key = "operation", .value = try model.text(gpa, waited.operation) },
                };
                defer for (where) |p| p.value.release();
                return try g.resumeRaise(run, pc, ins, g.raise("capability revoked", &where));
            },
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
                try g.push(frame, list);
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
                try g.push(frame, x.message orelse try nothing(gpa));
                if (ins.op == .wait_for_any) try g.push(frame, try chunks.numberValue(gpa, x.branch));
                return null;
            },
            .reply => |v| {
                // A reply charges nothing more.
                try g.push(frame, v);
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
                    if (checked.mismatch != null) break :blk false;
                    const after = decl.after orelse break :blk true;
                    break :blk after(decl, waited.call.?.args, x.value);
                };
                // The arguments were kept only for that check.
                const call = waited.call.?;
                releaseAll(call.args, gpa);
                call.args = &.{};
                if (!ok) return try g.resumeRaise(run, pc, ins, g.hostErrorAt(waited));
                // Only the rate's terms over the result, and the answer's
                // own cost.
                const size = costs.size(x.value);
                try g.payResumeConversion(run, (size + 31) / 32 + x.fuel, size);
                try g.push(frame, x.value.retain());
                return null;
            },
            .failed => |f| {
                defer g.releaseResume(with);
                const decl = waited.decl.?;
                if (!capabilities.validFailure(decl.*, f.code, f.data)) return try g.resumeRaise(run, pc, ins, g.hostErrorAt(waited));
                // Its Data is converted as a result is, an empty map when
                // it has none.
                const size: u64 = if (f.data) |d| costs.size(d) else 16;
                try g.payResumeConversion(run, (size + 31) / 32, size);
                var pairs: std.ArrayList(model.Pair) = .empty;
                defer pairs.deinit(gpa);
                const code = try model.text(gpa, f.code);
                defer code.release();
                try pairs.append(gpa, .{ .key = "code", .value = code });
                const message: ?*Value = if (f.message) |t| try model.text(gpa, t) else null;
                defer if (message) |t| t.release();
                if (message) |t| try pairs.append(gpa, .{ .key = "message", .value = t });
                if (f.data) |d| if (d.data == .map) try d.data.map.appendTo(gpa, &pairs);
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
            .send_wait, .send_named_wait, .send_spread_wait, .send_up_wait => true,
            else => false,
        };
        // A Command Call with no Handler has no receiver: it climbs.
        const up = ins.op == .send_up or ins.op == .send_up_wait;
        const receiver = if (up) try nothing(gpa) else pop(frame);
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
            .send, .send_wait, .join_send, .send_up, .send_up_wait => {
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
        if (waits and !member and run.scopes.items.len > 0) {
            m.uncharged = true;
            return g.refuseOpenScope(run);
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
        // The receiver: `me`, with no object, is the Script itself; a Host
        // Object's message goes to its nearest Owning Script; a climb goes
        // on from the parent of the Script's owner.
        var target: ?*objects.Object = null;
        var at: ?*objects.Object = null;
        var to: ?*Script = null;
        if (up) {
            target = run.script.owner;
            at = if (target) |o| o.parent else null;
            if (at) |x| if (x.owned()) |owner| {
                to = g.script(owner.owner_of.?);
            };
        } else switch (receiver.data) {
            .nothing => to = run.script,
            .text => |t| to = g.script(t) orelse return g.raise("object gone", &.{.{ .key = "object", .value = receiver }}),
            .object => {
                const o = g.objectOf(receiver) orelse return g.raise("object gone", &.{.{ .key = "object", .value = receiver }});
                if (o.disposed) return g.raise("object gone", &.{.{ .key = "object", .value = receiver }});
                target = o;
                at = o;
                if (o.owned()) |owner| to = g.script(owner.owner_of.?);
            },
            else => return g.wrongKind("object", receiver),
        }
        var size: u64 = 32;
        for (args.items) |v| size += costs.size(v);
        m.fuel_extra = (size + 31) / 32;
        m.alloc_extra = size;
        // No Owning Script on its path: `unhandled`, and nothing is sent.
        const dest = to orelse {
            if (g.trace) |out| {
                out.print("unhandled message={s}", .{name}) catch {};
                writeArgs(out, args.items);
                if (target) |o| {
                    out.writeAll(" target=") catch {};
                    display.writeTrace(out, o.value) catch {};
                }
                out.writeAll("\n") catch {};
            }
            if (!waits) return .next;
            const reason = try model.text(gpa, "unhandled");
            defer reason.release();
            return g.raise("send failed", &.{.{ .key = "reason", .value = reason }});
        };
        // A full mailbox refuses the send, which starts no call.
        if (mailboxLen(dest) >= dest.limits.mailbox_depth) {
            const shown = try model.text(gpa, dest.name);
            defer shown.release();
            return g.raise("mailbox full", &.{.{ .key = "to", .value = shown }});
        }
        const from: []const u8 = if (waits) blk: {
            run.calls += 1;
            const id = try std.fmt.allocPrint(gpa, "{s}.c{d}", .{ run.id, run.calls });
            g.ids.append(gpa, id) catch |e| {
                gpa.free(id);
                return e;
            };
            break :blk id;
        } else run.id;
        if (g.trace) |out| {
            out.print("send {s} to=", .{from}) catch {};
            if (!up and target != null) display.writeTrace(out, target.?.value) catch {} else out.writeAll(dest.name) catch {};
            out.print(" message={s}", .{name}) catch {};
            writeArgs(out, args.items);
            if (waits) out.writeAll(if (member) " wait=join" else " wait=yes") catch {};
            out.writeAll("\n") catch {};
        }
        const owned = try gpa.dupe(*Value, args.items);
        args.clearRetainingCapacity();
        var d = try g.newDelivery(name, owned, from, rootOf(run.delivery));
        d.waits = waits;
        d.target = target;
        d.at = at;
        try g.post(dest, d);
        if (!waits) return .next;
        if (member) {
            try g.startMember(run, .{ .id = from, .run = run, .deadline = nanos(g.clock) + @as(i128, run.limits.max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = run.limits.max_wait_ms });
            return .next;
        }
        try g.suspendRun(run, "send-wait", .{ .id = from, .run = run, .deadline = nanos(g.clock) + @as(i128, run.limits.max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = run.limits.max_wait_ms });
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
        const entry = unitOf(run, frame).events[index];
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
        if (run.scopes.items.len > 0) {
            m.uncharged = true;
            return g.refuseOpenScope(run);
        }
        // Each `from` names a Script, and each duration is exact.
        const now = nanos(g.clock);
        var deadline: i128 = never;
        var fires: u32 = 0;
        var at: usize = 0;
        for (entry.branches, 1..) |b, number| switch (b) {
            .when => |w| {
                if (w.from) {
                    if (popped[at].data != .text and popped[at].data != .object) return g.wrongKind("object", popped[at]);
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
        // Refused partway, the branches held so far are released, until the
        // wait owns them.
        var made: usize = 0;
        var owned = true;
        errdefer if (owned) {
            g.releaseHeld(branches[0..made]);
            gpa.free(branches);
        };
        at = 0;
        for (entry.branches, branches) |b, *held| {
            switch (b) {
                .when => |w| {
                    const captures = try gpa.alloc(*Value, w.captures);
                    const from: ?*Value = if (w.from) popped[at].retain() else null;
                    if (w.from) at += 1;
                    for (captures, popped[at .. at + w.captures]) |*c, v| c.* = v.retain();
                    at += w.captures;
                    held.* = .{ .when = .{ .from = from, .captures = captures } };
                },
                .after => {
                    held.* = .{ .after = now + waitMillis(popped[at]).? };
                    at += 1;
                },
            }
            made += 1;
        }
        const event = try gpa.create(EventWait);
        owned = false;
        event.* = .{ .library = frame.library, .entry = index, .branches = branches, .any = ins.op == .wait_for_any };
        try g.suspendRun(run, if (event.any) "wait-for-any" else "wait-for", .{ .run = run, .deadline = deadline, .order = 0, .event = event, .branch = fires });
        return .suspended;
    }

    /// Observation before dispatch: every pending `wait for` in the Script
    /// that the message matches makes its Run ready, in the order the waits
    /// began.
    /// Readies each `wait for` the message satisfies; true if any took it.
    fn observe(g: *Group, s: *Script, d: Delivery) !bool {
        var waits: std.ArrayList(*Pending) = .empty;
        defer waits.deinit(g.gpa);
        for (g.pending.items) |p| if (p.event != null and p.run.script == s) try waits.append(g.gpa, p);
        if (waits.items.len == 0) return false;
        var taken = false;
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
            taken = true;
        }
        return taken;
    }

    pub fn releaseMark(g: *Group, m: Mark) void {
        g.gpa.free(m.script);
        g.gpa.free(m.run);
        if (m.reason) |v| v.release();
    }

    pub fn releaseDecided(g: *Group, x: Decided) void {
        for (x.vetoes) |m| g.releaseMark(m);
        for (x.undecided) |m| g.releaseMark(m);
        g.gpa.free(x.vetoes);
        g.gpa.free(x.undecided);
    }

    pub fn releaseOpen(g: *Group, x: OpenBroadcast) void {
        for (x.parts) |part| if (part) |q| switch (q) {
            .allowed => {},
            .vetoed, .undecided => |m| g.releaseMark(m),
        };
        g.gpa.free(x.parts);
        g.gpa.free(x.deliveries);
    }

    /// A Mark of the Group's own, with copied names and a retained reason.
    fn ownMark(g: *Group, m: Mark) !Mark {
        const name = try g.gpa.dupe(u8, m.script);
        errdefer g.gpa.free(name);
        const run_id = try g.gpa.dupe(u8, m.run);
        if (m.reason) |v| _ = v.retain();
        return .{ .script = name, .run = run_id, .reason = m.reason, .outcome = m.outcome };
    }

    /// A recipient's part in the Decision its Delivery carries. A single
    /// Decision is sealed at once; a Broadcast Decision once every
    /// recipient has its part.
    fn takePart(g: *Group, d: Delivery, part: Part) !void {
        var owned: Part = switch (part) {
            .allowed => .allowed,
            .vetoed => |m| .{ .vetoed = try g.ownMark(m) },
            .undecided => |m| .{ .undecided = try g.ownMark(m) },
        };
        if (d.broadcast == 0) {
            const parts = [_]?Part{owned};
            return g.seal(d.id, false, &parts);
        }
        const open = g.open_broadcasts.getPtr(d.broadcast) orelse {
            switch (owned) {
                .allowed => {},
                .vetoed, .undecided => |*m| g.releaseMark(m.*),
            }
            return;
        };
        const i = std.mem.indexOfScalar(u64, open.deliveries, d.id).?;
        open.parts[i] = owned;
        for (open.parts) |x| if (x == null) return;
        const done = g.open_broadcasts.fetchRemove(d.broadcast).?.value;
        defer {
            g.gpa.free(done.parts);
            g.gpa.free(done.deliveries);
        }
        try g.seal(d.broadcast, true, done.parts);
    }

    /// Seals a Decision from its recipients' parts, which it takes, with
    /// its `decided` record, and keeps it for the Host: vetoed if any
    /// recipient vetoed, undecided if none did but one was undecided, and
    /// allowed otherwise.
    fn seal(g: *Group, id: u64, is_broadcast: bool, parts: []const ?Part) !void {
        return g.sealAs(id, is_broadcast, parts, null);
    }

    /// Seals with a Verdict the parts don't give: a dropped Broadcast
    /// Decision's, undecided with empty lists.
    fn sealAs(g: *Group, id: u64, is_broadcast: bool, parts: []const ?Part, verdict: ?Verdict) !void {
        var vetoes: std.ArrayList(Mark) = .empty;
        var undecided: std.ArrayList(Mark) = .empty;
        for (parts) |part| switch (part.?) {
            .allowed => {},
            .vetoed => |m| vetoes.append(g.gpa, m) catch |e| {
                g.releaseMark(m);
                return e;
            },
            .undecided => |m| undecided.append(g.gpa, m) catch |e| {
                g.releaseMark(m);
                return e;
            },
        };
        const decided: Decided = .{
            .verdict = verdict orelse if (vetoes.items.len > 0) .vetoed else if (undecided.items.len > 0) .undecided else .allowed,
            .vetoes = vetoes.toOwnedSlice(g.gpa) catch &.{},
            .undecided = undecided.toOwnedSlice(g.gpa) catch &.{},
        };
        if (g.trace) |w| {
            w.print("decided {s}{d} verdict={s}", .{ if (is_broadcast) "b" else "d", id, @tagName(decided.verdict) }) catch {};
            if (decided.vetoes.len > 0) {
                w.writeAll(" vetoes=[") catch {};
                for (decided.vetoes, 0..) |m, i| {
                    if (i > 0) w.writeAll(", ") catch {};
                    w.print("{{script: \"{s}\", run: \"{s}\", reason: ", .{ m.script, m.run }) catch {};
                    display.writeTrace(w, m.reason.?) catch {};
                    w.writeAll("}") catch {};
                }
                w.writeAll("]") catch {};
            }
            if (decided.undecided.len > 0) {
                w.writeAll(" undecided=[") catch {};
                for (decided.undecided, 0..) |m, i| {
                    if (i > 0) w.writeAll(", ") catch {};
                    w.print("{{script: \"{s}\"", .{m.script}) catch {};
                    if (m.run.len > 0) w.print(", run: \"{s}\"", .{m.run}) catch {};
                    w.print(", outcome: \"{s}\"}}", .{m.outcome}) catch {};
                }
                w.writeAll("]") catch {};
            }
            w.writeAll("\n") catch {};
        }
        g.reportDecided(id, is_broadcast, decided) catch {};
        (if (is_broadcast) &g.decided_broadcasts else &g.decided).put(g.gpa, id, decided) catch |e| {
            g.releaseDecided(decided);
            return e;
        };
    }

    fn reportDecided(g: *Group, id: u64, is_broadcast: bool, decided: Decided) !void {
        const r = &g.reports;
        const a = r.arena.allocator();
        const vetoes = try a.alloc(report.Veto, decided.vetoes.len);
        for (decided.vetoes, vetoes) |m, *x| x.* = .{ .script = try r.text(m.script), .run = try r.text(m.run), .reason = try r.value(m.reason.?) };
        const undecided = try a.alloc(report.UndecidedBy, decided.undecided.len);
        for (decided.undecided, undecided) |m, *x| x.* = .{ .script = try r.text(m.script), .run = try r.text(m.run), .outcome = undecidedOutcome(m.outcome) };
        try r.add(.{ .decided = .{
            .delivery = if (is_broadcast) "" else try r.print("d{d}", .{id}),
            .broadcast = if (is_broadcast) try r.print("b{d}", .{id}) else "",
            .verdict = switch (decided.verdict) {
                .allowed => .allowed,
                .vetoed => .vetoed,
                .undecided => .undecided,
            },
            .vetoes = vetoes,
            .undecided = undecided,
        } });
    }

    fn undecidedOutcome(how: []const u8) report.Outcome {
        const words = [_]struct { []const u8, report.Outcome }{ .{ "errored", .errored }, .{ "limit fault", .limit_fault }, .{ "cancelled", .cancelled }, .{ "effect failed", .effect_failure }, .{ "dropped", .dropped } };
        for (words) |w| if (std.mem.eql(u8, w[0], how)) return w[1];
        return .cancelled;
    }

    fn eventEntry(g: *Group, p: *const Pending) lower.Event {
        _ = g;
        return p.run.script.unitIn(p.event.?.library).events[p.event.?.entry];
    }

    /// The number of the first `when` branch of a pending `wait for` that
    /// a message matches, having bound its names, or null.
    fn eventMatch(g: *Group, p: *Pending, d: Delivery) !?u32 {
        const run = p.run;
        const event = p.event.?;
        const unit = run.script.unitIn(event.library);
        for (unit.events[event.entry].branches, event.branches, 1..) |b, held, number| {
            const w = switch (b) {
                .when => |w| w,
                .after => continue,
            };
            if (!std.mem.eql(u8, w.message, d.message)) continue;
            const arity = if (w.body) |body| unit.bodies[body].params.len else 0;
            if (arity != d.args.len) continue;
            // `from` an object: the message's Target is that object.
            if (held.when.from) |from| if (from.data == .object) {
                const target = d.target orelse run.script.owner orelse continue;
                if (target.value.data.object.identity != from.data.object.identity) continue;
            } else {
                // `from` a Script: that Script sent it.
                const sender = d.from orelse continue;
                const end = std.mem.indexOfScalar(u8, sender, '/') orelse sender.len;
                if (!std.mem.eql(u8, sender[0..end], from.data.text)) continue;
            };
            if (w.body) |body| {
                const values = try g.eventTest(run, event.library, body, d.args, held.when.captures) orelse continue;
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
    fn eventTest(g: *Group, run: *Run, library: ?*Library, body: u32, args: []const *Value, captures: []const *Value) !?*Value {
        const base = run.frames.items.len;
        try g.pushFrameIn(run, library, body, args);
        const frame = &run.frames.items[base];
        const first = run.script.unitIn(library).bodies[body].capture_slot;
        for (captures, first..) |v, slot| {
            frame.locals[slot].release();
            frame.locals[slot] = v.retain();
        }
        const fuel = run.fuel;
        run.base = base;
        defer run.base = 0;
        const outcome = try g.execute(run, true);
        g.pump_fuel += run.fuel - fuel;
        run.script.spent += run.fuel - fuel;
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
        g.pending.append(g.gpa, p) catch |e| {
            g.destroyPending(p);
            return e;
        };
        try join.members.append(g.gpa, .{ .pending = p, .waited = .{ .id = if (p.call) |c| c.id else p.id, .call = p.call, .grant = p.grant, .operation = p.operation, .decl = p.decl, .after_ms = p.after_ms } });
    }

    /// Abandons a Join's members still pending, or timed out, in start
    /// order, writing an `abandon` record for each, and ends the Join.
    /// MaxJoin: a Join Member past it faults at its statement.
    fn checkJoin(g: *Group, run: *Run) error{LimitFault}!void {
        const join = run.join orelse return;
        if (join.members.items.len >= run.limits.max_join) return g.faultOn(.join);
    }

    fn abandonJoin(g: *Group, run: *Run) void {
        const join = run.join orelse return;
        for (join.members.items) |x| {
            // A member still pending, or one whose failure the fail-fast
            // raise didn't take, is abandoned.
            const abandoned = x.pending != null or x.cut or (x.with != null and switch (x.with.?) {
                .answer, .reply => false,
                else => true,
            });
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
                abandonCall(p);
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
        const p = g.gpa.create(Pending) catch |e| {
            if (wait.event) |ev| g.releaseEvent(ev);
            return e;
        };
        g.timers += 1;
        p.* = wait;
        // The innermost Timeout Block's deadline bounds it, and wins a tie.
        if (blockDeadline(&run.frames.items[run.frames.items.len - 1])) |d| if (d.at <= p.deadline) {
            p.deadline = d.at;
            p.block = true;
            p.after_ms = d.ms;
        };
        p.order = g.timers;
        g.pending.append(g.gpa, p) catch |e| {
            g.destroyPending(p);
            return e;
        };
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
    /// Keeps the Script's Variables as the new Segment's base, for a Script
    /// with Segment-bound Operations.
    fn takeBase(g: *Group, run: *Run) !void {
        g.dropBase(run);
        const base = try g.gpa.dupe(*Value, run.script.variables);
        for (base) |v| _ = v.retain();
        run.segment_base = base;
    }

    fn dropBase(g: *Group, run: *Run) void {
        const base = run.segment_base orelse return;
        releaseAll(base, g.gpa);
        run.segment_base = null;
    }

    /// Puts the Script's Variables back as they were when the Segment began.
    fn restoreBase(g: *Group, run: *Run) void {
        const base = run.segment_base orelse return;
        for (run.script.variables[0..base.len], base) |*v, b| {
            v.*.release();
            v.* = b.retain();
        }
        _ = g;
    }

    /// Calls a participant hook, with an `effect` record. `begin` sees only
    /// the first enrolled Grant.
    fn hook(g: *Group, run: *Run, phase: capabilities.Phase) capabilities.EffectStatus {
        return g.hookWith(run, phase, false);
    }

    /// `hook`, which may answer `deferred` when `deferrable`: nothing is
    /// written, and the caller pauses to make the same call again.
    fn hookWith(g: *Group, run: *Run, phase: capabilities.Phase, deferrable: bool) capabilities.EffectStatus {
        if (deferrable and g.release_pause) return .deferred;
        const p = &run.participant.?;
        const a = g.scratch.allocator();
        const enrolled = if (phase == .begin) p.grants.items[0..1] else p.grants.items;
        const grants = a.alloc(capabilities.SegmentGrant, enrolled.len) catch return .unknown;
        for (enrolled, grants) |sg, *x| x.* = .{ .name = sg.name.ptr, .name_len = sg.name.len, .binding = sg.grant.binding };
        const first = p.grants.items[0];
        const segment = g.segmentId(run);
        const context: capabilities.SegmentContext = .{ .group = g, .script = run.script.name, .run = run.id, .segment = segment, .grant = first.name, .binding = first.grant.binding, .now = g.clock, .grants = grants, .deferrable = deferrable };
        if (deferrable and g.deferOnce()) return .deferred;
        var status = p.coordinator.hook(p.coordinator.context, phase, &context);
        if (status == .deferred) {
            if (deferrable) return .deferred;
            // A Host that defers where it may not has broken its contract,
            // which leaves the effects' state unknown.
            status = .unknown;
        }
        g.write("effect {s} grant={s} phase={s} status={s}\n", .{ segment, first.name, @tagName(phase), @tagName(status) });
        if (status != .ok) {
            g.write("effect-failure {s} grant={s} segment={s} phase={s} status={s}\n", .{ run.id, first.name, segment, @tagName(phase), @tagName(status) });
            g.reportEffectFailure(run, first.name, segment, @tagName(phase), @tagName(status), "");
        }
        return status;
    }

    fn reportEffectFailure(g: *Group, run: *const Run, grant: []const u8, segment: []const u8, phase: []const u8, status: []const u8, scope: []const u8) void {
        const r = &g.reports;
        g.addReport(.{ .effect_failure = .{ .script = r.text(run.script.name) catch "", .run = r.text(run.id) catch "", .grant = r.text(grant) catch "", .segment = r.text(segment) catch "", .phase = phase, .status = status, .scope = r.text(scope) catch "" } });
    }

    /// Ends the participant, if there is one: a commit when `commit` is
    /// set, else a rollback. A commit that fails is rolled back. Returns
    /// the failure that ends the Run `effect failed`, if one does.
    fn finalize(g: *Group, run: *Run, commit: bool) ?EffectFailure {
        if (run.participant == null) return null;
        defer {
            run.participant.?.grants.deinit(g.gpa);
            run.participant = null;
        }
        const first = run.participant.?.grants.items[0].name;
        // An uncertain commit, or a rollback that doesn't succeed, leaves the
        // effects' state unknown, which stops the Group.
        if (commit) {
            const status = g.hook(run, .commit);
            if (status == .ok) return null;
            if (status == .unknown) g.fatal = true;
            if (g.hook(run, .rollback) != .ok) g.fatal = true;
            return .{ .grant = first, .phase = "commit", .status = @tagName(status) };
        }
        if (g.hook(run, .rollback) != .ok) g.fatal = true;
        return null;
    }

    /// Enrolls the call's Grant in the Segment's participant before a
    /// Segment-bound Operation runs, beginning one for the Segment's first.
    /// A failed `begin` leaves none, and raises `host error`.
    fn enroll(g: *Group, run: *Run, granted: *ScriptGrant, where: []const model.Pair) !void {
        if (run.participant) |*p| {
            if (std.mem.indexOfScalar(*ScriptGrant, p.grants.items, granted) == null) try p.grants.append(g.gpa, granted);
            return;
        }
        run.participant = .{ .coordinator = granted.grant.coordinator.? };
        try run.participant.?.grants.append(g.gpa, granted);
        // A deferred crossing leaves no participant; the re-made call
        // enrolls again, taking an answered `begin` from `run.begun`.
        const status = run.begun orelse g.hookWith(run, .begin, true);
        if (status == .deferred) {
            run.participant.?.grants.deinit(g.gpa);
            run.participant = null;
            return error.Deferred;
        }
        run.begun = null;
        if (status == .ok) return;
        // An uncertain begin may have acquired something: after a rollback
        // attempt, it stops the Group.
        if (status == .unknown) {
            if (g.hookWith(run, .rollback, true) == .deferred) {
                run.begun = status;
                run.participant.?.grants.deinit(g.gpa);
                run.participant = null;
                return error.Deferred;
            }
            run.participant.?.grants.deinit(g.gpa);
            run.participant = null;
            g.fatal = true;
            return error.GroupStop;
        }
        run.participant.?.grants.deinit(g.gpa);
        run.participant = null;
        return g.raise("host error", where);
    }

    /// `segment participant conflict` for a Segment-bound call through a
    /// Grant whose coordinator isn't the participant's.
    fn participantConflict(g: *Group, run: *const Run, granted: *const ScriptGrant, where: []const model.Pair) error{ Raised, OutOfMemory }!void {
        const p = run.participant orelse return;
        if (p.coordinator.identity == granted.grant.coordinator.?.identity) return;
        const participant = model.text(g.gpa, p.grants.items[0].name) catch return error.OutOfMemory;
        defer participant.release();
        return g.raise("segment participant conflict", &.{ where[0], where[1], .{ .key = "participant", .value = participant } });
    }

    /// The current Segment's id, `<run>.s<N>`.
    fn segmentId(g: *Group, run: *const Run) []const u8 {
        return std.fmt.allocPrint(g.scratch.allocator(), "{s}.s{d}", .{ run.id, run.segments + 1 }) catch "";
    }

    /// Automatic abandonment as a Run ends: each occupied slot's
    /// abandonment Operation, newest first, as a Host call that charges
    /// nothing. A failure reports `effect-failure` and disables the Grant.
    /// Returns the first failure on a Grant in the Segment's participant,
    /// which prevents its commit.
    fn abandonScopes(g: *Group, run: *Run) ?EffectFailure {
        var prevented: ?EffectFailure = null;
        g.abandonScopesWith(run, false, &prevented) catch unreachable;
        return prevented;
    }

    /// `abandonScopes`, where each abandonment call may answer `deferred`
    /// when `deferrable`: its slot stays, and the same call is made again.
    fn abandonScopesWith(g: *Group, run: *Run, deferrable: bool, prevented: *?EffectFailure) error{Deferred}!void {
        const a = g.scratch.allocator();
        while (run.scopes.items.len > 0) {
            if (deferrable and g.release_pause) return error.Deferred;
            const slot = run.scopes.items[run.scopes.items.len - 1];
            const capability = slot.grant.grant.capability;
            const op = &capability.operations[slot.abandon];
            run.calls += 1;
            const id = std.fmt.allocPrint(a, "{s}.c{d}", .{ run.id, run.calls }) catch "";
            const segment = g.segmentId(run);
            var call: capabilities.Call = .{ .id = id, .script = run.script.name, .grant = slot.grant.name, .binding = slot.grant.grant.binding, .now = g.clock, .left = 0, .starting = false, .gpa = g.gpa, .owner = g, .run = run.id, .segment = segment, .scope = slot.name, .automatic = true, .deferrable = deferrable };
            // An allocation refusal already makes the C worker refuse;
            // otherwise keep automatic ids as issued/ineligible too.
            g.registerCall(id, false) catch {};
            const outcome: capabilities.Outcome = if (deferrable and g.deferOnce()) .deferred else op.host.call(op.host.context, &call, &.{});
            if (outcome == .deferred and deferrable) {
                g.unissueCall(id);
                run.calls -= 1;
                return error.Deferred;
            }
            _ = run.scopes.pop();
            const result: ?*Value = if (outcome == .value) outcome.value else null;
            defer if (result) |v| v.release();
            switch (outcome) {
                .failed => |f| {
                    g.gpa.free(f.code);
                    if (f.message) |t| g.gpa.free(t);
                    if (f.data) |d| d.release();
                },
                else => {},
            }
            const ok = result != null and !call.charge_refused;
            if (g.trace) |w| {
                w.print("call {s} op={s}.{s} args=[]", .{ id, slot.grant.name, op.name }) catch {};
                if (ok) {
                    w.writeAll(" result=") catch {};
                    display.writeTrace(w, result.?) catch {};
                } else w.writeAll(" error={}") catch {};
                w.writeAll(" automatic=yes\n") catch {};
                w.print("scope {s} grant={s} name={s} action={s}\n", .{ id, slot.grant.name, slot.name, if (ok) "abandoned" else "failed" }) catch {};
                if (!ok) w.print("effect-failure {s} grant={s} segment={s} phase=abandon status=unknown scope={s}\n", .{ run.id, slot.grant.name, segment, slot.name }) catch {};
            }
            if (!ok) g.reportEffectFailure(run, slot.grant.name, segment, "abandon", "unknown", slot.name);
            if (!ok) {
                slot.grant.disabled = true;
                g.releaseGrant(run.script, slot.grant, .disable);
                const participating = if (run.participant) |pt| std.mem.indexOfScalar(*ScriptGrant, pt.grants.items, slot.grant) != null else false;
                if (participating and prevented.* == null) prevented.* = .{ .grant = slot.grant.name, .phase = "abandon", .status = "unknown", .scope = slot.name };
            }
        }
    }

    /// `scope open` at a boundary that would suspend while a scope is open,
    /// naming the newest.
    fn refuseOpenScope(g: *Group, run: *const Run) error{ Raised, OutOfMemory } {
        const newest = run.scopes.getLast();
        const capability = model.text(g.gpa, newest.grant.name) catch return error.OutOfMemory;
        defer capability.release();
        const scope = model.text(g.gpa, newest.name) catch return error.OutOfMemory;
        defer scope.release();
        return g.raise("scope open", &.{ .{ .key = "capability", .value = capability }, .{ .key = "scope", .value = scope } });
    }

    /// The `run end` report of a Run that ended.
    fn reportRunEnd(g: *Group, s: *const Script, run: *const Run, outcome: Outcome, segment: []const u8) !void {
        const r = &g.reports;
        const d = run.delivery;
        var end: report.RunEnd = .{ .script = try r.text(s.name), .run = try r.text(run.id), .outcome = .completed, .fallback = run.fallback, .fuel = run.fuel, .alloc = run.alloc };
        if (d.from == null) end.delivery = try r.print("d{d}", .{d.id});
        if (d.broadcast > 0) end.broadcast = try r.print("b{d}", .{d.broadcast});
        if (run.fallback or g.hasHandler(s, run.handler)) end.handler = try r.text(run.handler);
        const at: report.Location = .{ .unit = try r.text(run.end_at.unit), .line = run.end_at.line, .column = run.end_at.column, .handler = try r.text(run.end_at.handler), .pc = run.end_at.pc };
        switch (outcome) {
            .returned => |v| end.result = try r.value(v),
            .passed, .vetoed => {
                const none = try nothing(g.gpa);
                defer none.release();
                end.result = try r.value(none);
            },
            .errored => |e| {
                end.outcome = .errored;
                end.err = try r.value(e);
                end.at = at;
            },
            .faulted => |l| {
                end.outcome = .limit_fault;
                end.limit = @tagName(l);
                end.at = at;
            },
            .unhandled, .clause_failed => end.outcome = .unhandled,
            .dropped => end.outcome = .dropped,
            .cancelled => {
                end.outcome = .cancelled;
                if (run.cleanup_code != null or run.cleanup_limit.len > 0) end.cleanup_failed = .{
                    .code = if (run.cleanup_code) |c| try r.text(c.data.text) else "",
                    .limit = run.cleanup_limit,
                };
            },
            .effect_failed => |f| {
                end.outcome = .effect_failure;
                end.effect = .{ .script = end.script, .run = end.run, .grant = try r.text(f.grant), .segment = try r.text(segment), .phase = try r.text(f.phase), .status = try r.text(f.status), .scope = if (f.scope) |n| try r.text(n) else "" };
            },
            .suspended, .selected, .preempted, .stopped, .rewound => unreachable,
        }
        try r.add(.{ .run_end = end });
    }

    /// A Segment end's lifecycle: abandon leftover scopes, then commit the
    /// participant if they permit it, or roll it back. Each crossing may
    /// defer; `run.ending` keeps how far it got, so none is made twice.
    /// Returns the failure that ends the Run `effect failed`, if one does.
    fn lifecycle(g: *Group, run: *Run, e: *Ending, deferrable: bool) error{Deferred}!?EffectFailure {
        if (e.stage == .abandon) {
            if (e.outcome != .suspended) try g.abandonScopesWith(run, deferrable, &e.prevented);
            e.stage = .finalize;
        }
        if (run.participant == null) return e.prevented;
        const first = run.participant.?.grants.items[0].name;
        if (e.stage == .finalize) {
            // A cancelled Run's cleanup Segment commits, unless a limit
            // ended it.
            const outcome = e.outcome;
            const commits = e.prevented == null and outcome != .faulted and outcome != .stopped and outcome != .rewound and !(outcome == .cancelled and run.cleanup_limited);
            if (commits) {
                const status = g.hookWith(run, .commit, deferrable);
                if (status == .deferred) return error.Deferred;
                if (status == .ok) return g.endParticipant(run, e, null);
                // An uncertain commit, or a rollback that doesn't succeed,
                // leaves the effects' state unknown, which stops the Group.
                if (status == .unknown) e.fatal = true;
                e.failure = .{ .grant = first, .phase = "commit", .status = @tagName(status) };
                e.stage = .commit_rollback;
            } else e.stage = .rollback;
        }
        const status = g.hookWith(run, .rollback, deferrable);
        if (status == .deferred) return error.Deferred;
        if (status != .ok) e.fatal = true;
        if (e.stage == .commit_rollback) return g.endParticipant(run, e, e.failure);
        return g.endParticipant(run, e, e.prevented);
    }

    /// A Run's Segment rolled back for a drained Stop, cancellation or
    /// Rewind: its scopes abandoned and its participant rolled back. While
    /// draining, each crossing may defer, with progress in `run.cleanup`.
    fn abandonReadyCalls(run: *Run) void {
        if (run.resume_with != null) {
            if (run.waited.call) |c| if (!c.settlement_consumed) {
                c.abandoned.store(true, .release);
            };
        }
        if (run.join) |j| for (j.members.items) |m| {
            if (m.with != null) if (m.waited.call) |c| if (!c.settlement_consumed) {
                c.abandoned.store(true, .release);
            };
        };
    }

    fn cleanupLifecycle(g: *Group, run: *Run) error{Deferred}!void {
        abandonReadyCalls(run);
        if (run.cleanup == null) run.cleanup = .{ .outcome = .stopped };
        _ = try g.lifecycle(run, &run.cleanup.?, g.draining or g.reworking or g.landing_active);
        run.cleanup = null;
    }

    /// Whether `defer_crossings` defers this crossing: every other call.
    fn deferOnce(g: *Group) bool {
        if (!g.defer_crossings) return false;
        g.deferred_once = !g.deferred_once;
        return g.deferred_once;
    }

    fn endParticipant(g: *Group, run: *Run, e: *const Ending, failure: ?EffectFailure) ?EffectFailure {
        run.participant.?.grants.deinit(g.gpa);
        run.participant = null;
        if (e.fatal) g.fatal = true;
        return failure;
    }

    /// Parks a Run whose Segment end deferred at a lifecycle crossing at
    /// the head of its Script's work, as a crossing pause, with its Fuel
    /// and allocation still its Segment's.
    fn pauseEnding(g: *Group, s: *Script, run: *Run) !void {
        g.crossing_pause = true;
        return g.park(s, run);
    }

    fn endSegment(g: *Group, s: *Script, run: *Run, ended: Outcome) !void {
        if (run.ending == null) run.ending = .{ .outcome = ended };
        const lifecycle_failure = g.lifecycle(run, &run.ending.?, true) catch return g.pauseEnding(s, run);
        var outcome = run.ending.?.outcome;
        run.ending = null;
        const segment = g.segmentId(run);
        var failure: ?EffectFailure = lifecycle_failure;
        // An effect whose state is unknown stops the Group with this Run.
        if (g.fatal and outcome != .stopped and outcome != .rewound) {
            failure = null;
            switch (outcome) {
                .returned, .errored, .vetoed => |v| v.release(),
                else => {},
            }
            outcome = .stopped;
        }
        if (failure) |f| {
            g.restoreBase(run);
            if (outcome == .suspended) if (run.waiting) |p| if (p.call) |c| g.write("abandon {s}\n", .{c.id});
            switch (outcome) {
                .returned, .errored, .vetoed => |v| v.release(),
                else => {},
            }
            outcome = .{ .effect_failed = f };
        }
        // `pass` hands an open Verdict up the Message Path with the message.
        if (run.verdict and outcome == .passed) {
            run.verdict = false;
            run.delivery.decision = true;
        }
        const fuel = run.fuel - run.segment_fuel;
        const alloc = run.alloc - run.segment_alloc;
        g.pump_fuel += fuel;
        s.spent += fuel;
        // A Rewind rolls its Segment back as a Limit Fault would, and puts
        // its message back.
        if (outcome == .rewound) {
            g.restoreBase(run);
            g.putBack(s, run) catch |e| {
                g.destroyRun(run);
                return e;
            };
        }
        if (outcome == .suspended) s.live.append(g.gpa, run) catch |e| {
            g.destroyRun(run);
            return e;
        };
        const state = g.persistentState(s);
        const d = run.delivery;
        if (g.trace) |out| {
            out.print("seg {s} {s}", .{ run.id, if (run.continuing) "continue" else if (run.started) "resume" else "start" }) catch {};
            if (!run.started) g.writeStart(out, s, run, outcome != .unhandled and outcome != .clause_failed);
            const end: []const u8 = switch (outcome) {
                .returned => "return",
                .errored => "error",
                .faulted => "fault",
                .suspended => run.suspended_at,
                .unhandled, .clause_failed => "unhandled",
                .dropped => "dropped",
                .cancelled => "cancel",
                .passed => "pass",
                .effect_failed => "effect-failed",
                .vetoed => "veto",
                .stopped => "stop",
                .rewound => "rewind",
                .selected, .preempted => unreachable,
            };
            out.print(" fuel={d} alloc={d} state={d} end={s}", .{ fuel, alloc, state, end }) catch {};
            if (outcome == .vetoed and outcome.vetoed.data != .nothing) {
                out.writeAll(" value=") catch {};
                display.writeTrace(out, outcome.vetoed) catch {};
            }
            if (outcome == .suspended) if (run.waiting) |p| if (p.deadline != never and ((p.call == null and p.id.len == 0) or p.block)) {
                const at: model.dates.Instant = .{ .seconds = @intCast(@divFloor(p.deadline, std.time.ns_per_s)), .nanos = @intCast(@mod(p.deadline, std.time.ns_per_s)) };
                const text = model.dates.string(g.scratch.allocator(), model.dates.fields(at), true) catch "";
                out.print(" until={s}", .{text}) catch {};
            };
            out.writeAll("\n") catch {};
            if (outcome == .cancelled) g.writeAbandoned(run);
        }
        // A Stop that landed stops its Script, this Run with it; otherwise
        // stopping the Group discards this Run with every other.
        if (outcome == .stopped) {
            if (run.landed) |l| if (l == .stop) {
                defer g.gpa.free(l.stop);
                run.landed = null;
                g.stopScript(s, l.stop, run, .{}) catch |e| {
                    g.destroyRun(run);
                    return e;
                };
                g.destroyRun(run);
                return;
            };
            try g.stopGroup(run);
            g.destroyRun(run);
            return;
        }
        if (outcome == .rewound) {
            g.dropRewound(run);
            return;
        }
        // The end of the first Segment seals a held Verdict: `veto` vetoes
        // it, and suspending or ending without one allows it.
        if (run.verdict) switch (outcome) {
            .returned, .suspended => {
                run.verdict = false;
                try g.takePart(d, .allowed);
            },
            .vetoed => |reason| {
                run.verdict = false;
                try g.takePart(d, .{ .vetoed = .{ .script = s.name, .run = run.id, .reason = reason } });
            },
            else => {},
        };
        run.started = true;
        run.continuing = false;
        run.segments += 1;
        if (outcome == .suspended) {
            run.segment_fuel = run.fuel;
            run.segment_alloc = run.alloc;
            return;
        }
        try g.finishRun(s, run, outcome, segment);
    }

    fn finishRun(g: *Group, s: *Script, run: *Run, outcome: Outcome, segment: []const u8) !void {
        const d = run.delivery;
        if (g.trace) |out| {
            const word: []const u8 = switch (outcome) {
                .returned, .passed, .vetoed => "completed",
                .errored => "errored",
                .faulted => "limit-fault",
                .unhandled, .clause_failed => "unhandled",
                .dropped => "dropped",
                .cancelled => "cancelled",
                .effect_failed => "effect-failed",
                .suspended, .selected, .preempted, .stopped, .rewound => unreachable,
            };
            out.print("run {s} outcome={s}", .{ run.id, word }) catch {};
            // A `run` record names a Host Delivery, never a sender.
            if (d.from == null) out.print(" delivery=d{d}", .{d.id}) catch {};
            if (d.broadcast > 0) out.print(" broadcast=b{d}", .{d.broadcast}) catch {};
            if (run.fallback or g.hasHandler(s, run.handler)) out.print(" handler={s}", .{run.handler}) catch {};
            if (run.fallback) out.writeAll(" fallback=yes") catch {};
            if (d.function) |f| {
                out.writeAll(" fn=") catch {};
                display.writeTrace(out, f) catch {};
            }
            switch (outcome) {
                .returned => |v| if (v.data != .nothing) {
                    out.writeAll(" value=") catch {};
                    display.writeTrace(out, v) catch {};
                },
                .errored => |e| {
                    out.writeAll(" error=") catch {};
                    display.writeTrace(out, e) catch {};
                },
                .faulted => |l| out.print(" limit={s}", .{@tagName(l)}) catch {},
                .effect_failed => |f| {
                    out.print(" effect={{grant: \"{s}\", segment: \"{s}\", phase: \"{s}\", status: \"{s}\"", .{ f.grant, segment, f.phase, f.status }) catch {};
                    if (f.scope) |n| out.print(", scope: \"{s}\"", .{n}) catch {};
                    out.writeAll("}") catch {};
                },
                else => {},
            }
            out.print(" fuel={d} alloc={d}\n", .{ run.fuel, run.alloc }) catch {};
        }
        g.reportRunEnd(s, run, outcome, segment) catch {};
        g.endRow(run, .terminal);
        // A Run that ends before sealing its Verdict, or a dropped
        // Decision, leaves it undecided.
        if (run.verdict or (d.decision and (outcome == .dropped or outcome == .faulted))) {
            const how: []const u8 = switch (outcome) {
                .errored => "errored",
                .faulted => "limit fault",
                .cancelled => "cancelled",
                .effect_failed => "effect failed",
                .dropped => "dropped",
                else => "",
            };
            if (how.len > 0) {
                run.verdict = false;
                try g.takePart(d, .{ .undecided = .{ .script = s.name, .run = run.id, .outcome = how } });
            }
        }
        s.fuel_total += run.fuel;
        s.alloc_total += run.alloc;
        if (outcome == .faulted) s.faults += 1;
        switch (outcome) {
            .returned => |v| if (d.waits) {
                try g.reply(d, .{ .reply = v });
            } else if (d.request) try g.results.put(g.gpa, d.id, v) else v.release(),
            .faulted => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "limit fault", .err = null } }),
            // A message no clause took, or one passed, climbs the path.
            // A Broadcast never climbs: its open Verdict is allowed here.
            .unhandled, .clause_failed, .passed => if (d.broadcast == 0) {
                try g.climb(s, d);
            } else if (d.decision) try g.takePart(d, .allowed),
            .dropped => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "dropped", .err = null } }),
            .cancelled => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "cancelled", .err = null } }),
            .effect_failed => if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "effect failed", .err = null } }),
            // `veto` ends the Run with result Nothing.
            .vetoed => |reason| {
                reason.release();
                const v = try nothing(g.gpa);
                if (d.waits) {
                    try g.reply(d, .{ .reply = v });
                } else if (d.request) try g.results.put(g.gpa, d.id, v) else v.release();
            },
            .errored => |e| {
                // An uncaught error sends the Script its `error` message,
                // unless the Run was handling one.
                if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "errored", .err = e.retain() } });
                // A Run handling an `error` message, the Core's or a Host's,
                // sends none: there is no chain.
                if (!d.internal_error and !std.mem.eql(u8, d.message, "error")) {
                    const args = g.gpa.alloc(*Value, 1) catch |err| {
                        e.release();
                        return err;
                    };
                    args[0] = e;
                    var message = try g.newDelivery("error", args, run.id, rootOf(run.delivery));
                    message.during = g.messageMap(d) catch |err| {
                        g.releaseDelivery(message);
                        return err;
                    };
                    message.internal_error = true;
                    try g.post(s, message);
                } else e.release();
            },
            else => {},
        }
        // The first Run parked behind it in its `, queued` clause becomes
        // ready, behind any `error` message.
        if (run.clause_body) |body| for (s.live.items) |r| if (r.parked and r.clause_body.? == body and r.clause_unit == run.clause_unit) {
            r.parked = false;
            r.resume_with = .unparked;
            try s.work.append(g.gpa, .{ .run = r });
            break;
        };
        g.destroyRun(run);
    }

    /// A message from a Run, which takes `args`: all or nothing.
    fn newDelivery(g: *Group, name: []const u8, args: []*Value, from: []const u8, root: u64) !Delivery {
        errdefer releaseAll(args, g.gpa);
        const message = try g.gpa.dupe(u8, name);
        errdefer g.gpa.free(message);
        return .{ .id = 0, .root = root, .message = message, .args = args, .request = false, .from = try g.gpa.dupe(u8, from) };
    }

    /// Stops a Script (chapter 6, Cancellation and Stop): each of its Runs,
    /// `running` too, in the order they started, has its scopes abandoned
    /// and its participant rolled back, and one in the middle of its Segment
    /// its Script Variables too; then they are discarded with no `finally`,
    /// and its mailbox's messages dropped. Those waiting on them get `send
    /// failed`, reason `stopped`, and an open Decision settles undecided. The
    /// Script's Grants are released, and its `stopped` record lists what
    /// went. A stopped Script stays stopped.
    /// How a Stop goes: a Reload's keeps the mailbox if asked, and releases
    /// the Script's Grants with reason `reload`.
    const StopHow = struct { keep_mailbox: bool = false, release: capabilities.ReleaseReason = .stop, discard: []const u8 = "stop" };

    fn stopScript(g: *Group, s: *Script, reason: []const u8, running: ?*Run, how: StopHow) !void {
        if (s.stopped != null) return;
        var runs: std.ArrayList(*Run) = .empty;
        defer runs.deinit(g.gpa);
        try runs.appendSlice(g.gpa, s.live.items);
        if (running) |r| try runs.append(g.gpa, r);
        std.mem.sort(*Run, runs.items, {}, struct {
            fn less(_: void, x: *Run, y: *Run) bool {
                return runNumber(x.id) < runNumber(y.id);
            }
        }.less);
        // Every Run's rollback first, which may defer while draining:
        // nothing else changes until they complete.
        for (runs.items) |r| try g.cleanupLifecycle(r);
        s.stopped = try g.gpa.dupe(u8, reason);
        var discarded: std.ArrayList(u8) = .empty;
        defer discarded.deinit(g.gpa);
        var discarded_ids: std.ArrayList([]const u8) = .empty;
        defer discarded_ids.deinit(g.gpa);
        var dropped_ids: std.ArrayList(u64) = .empty;
        defer dropped_ids.deinit(g.gpa);
        // The pending calls the discarded Runs abandon, in call id order.
        var abandoned: std.ArrayList([]const u8) = .empty;
        defer abandoned.deinit(g.gpa);
        for (runs.items) |r| {
            if (r.waiting) |p| if (p.call) |c| try abandoned.append(g.gpa, c.id);
            if (r.join) |j| for (j.members.items) |m| if (m.pending) |p| if (p.call) |c| try abandoned.append(g.gpa, c.id);
        }
        std.mem.sort([]const u8, abandoned.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return callOrder(x, y);
            }
        }.less);
        for (runs.items) |r| {
            if (r == running or r.continuing) g.restoreBase(r);
            if (discarded.items.len > 0) try discarded.appendSlice(g.gpa, ", ");
            try discarded.appendSlice(g.gpa, r.id);
            try discarded_ids.append(g.gpa, r.id);
            g.discardRun(r, how.discard);
            const d = r.delivery;
            if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "stopped", .err = null } });
            s.fuel_total += r.fuel;
            s.alloc_total += r.alloc;
        }
        var dropped: std.ArrayList(u8) = .empty;
        defer dropped.deinit(g.gpa);
        if (!how.keep_mailbox) for (s.work.items) |w| switch (w) {
            .message => |d| if (blk: {
                g.discardMessage(d);
                break :blk d.from == null and d.id > 0;
            }) {
                if (dropped.items.len > 0) try dropped.appendSlice(g.gpa, ", ");
                try dropped.print(g.gpa, "d{d}", .{d.id});
                try dropped_ids.append(g.gpa, d.id);
            },
            .run => {},
        };
        // The running Run's caller ends it; the rest go once their Decisions
        // settle.
        s.live.clearRetainingCapacity();
        // Its named Grants are released, in code-point order of their names.
        const order = try g.gpa.alloc(*const ScriptGrant, s.grants.len);
        defer g.gpa.free(order);
        for (s.grants, order) |*sg, *o| o.* = sg;
        std.mem.sort(*const ScriptGrant, order, {}, struct {
            fn less(_: void, x: *const ScriptGrant, y: *const ScriptGrant) bool {
                return std.mem.order(u8, x.name, y.name) == .lt;
            }
        }.less);
        for (order) |sg| g.releaseGrant(s, sg, how.release);
        // A rollback that failed leaves an effect's state unknown, which
        // stops the Group: this Script with that reason.
        const fatal = g.fatal and !std.mem.eql(u8, reason, "effect state unknown");
        if (fatal) {
            g.gpa.free(s.stopped.?);
            s.stopped = try g.gpa.dupe(u8, "effect state unknown");
        }
        const why = s.stopped.?;
        if (g.trace) |out| {
            out.print("stopped {s} reason=", .{s.name}) catch {};
            writeText(out, why);
            if (discarded.items.len > 0) out.print(" discarded=[{s}]", .{discarded.items}) catch {};
            if (dropped.items.len > 0) out.print(" dropped=[{s}]", .{dropped.items}) catch {};
            for (abandoned.items, 0..) |id, i| out.print("{s}{s}", .{ if (i == 0) " abandoned=[" else ", ", id }) catch {};
            if (abandoned.items.len > 0) out.writeAll("]") catch {};
            out.writeAll("\n") catch {};
        }
        g.reportStop(s.name, why, discarded_ids.items, dropped_ids.items, abandoned.items) catch {};
        // The open Decisions settle undecided, `cancelled`, after the
        // `stopped` record.
        for (runs.items) |r| if (r.verdict or r.delivery.decision) {
            r.verdict = false;
            try g.takePart(r.delivery, .{ .undecided = .{ .script = s.name, .run = r.id, .outcome = "cancelled" } });
        };
        if (how.keep_mailbox) {
            // The messages stay, their senders waiting; the Runs go.
            var kept: usize = 0;
            for (s.work.items) |w| if (w == .message) {
                s.work.items[kept] = w;
                kept += 1;
            };
            s.work.shrinkRetainingCapacity(kept);
        } else {
            for (s.work.items) |w| switch (w) {
                .message => |d| try g.settleDropped(s, d),
                .run => {},
            };
            s.work.clearRetainingCapacity();
        }
        for (runs.items) |r| if (r != running) g.destroyRun(r);
        if (fatal) for (g.scripts.items) |x| try g.stopScript(x, "effect state unknown", null, .{});
    }

    fn reportStop(g: *Group, script_name: []const u8, reason: []const u8, discarded: []const []const u8, dropped: []const u64, pending: []const []const u8) !void {
        const r = &g.reports;
        const a = r.arena.allocator();
        const runs = try a.alloc([]const u8, discarded.len);
        for (discarded, runs) |id, *x| x.* = try r.text(id);
        const messages = try a.alloc([]const u8, dropped.len);
        for (dropped, messages) |id, *x| x.* = try r.print("d{d}", .{id});
        const calls = try a.alloc([]const u8, pending.len);
        for (pending, calls) |id, *x| x.* = try r.text(id);
        try r.add(.{ .stop = .{ .script = try r.text(script_name), .reason = try r.text(reason), .discarded_runs = runs, .dropped_messages = messages, .pending_calls = calls } });
    }

    /// A message a stopped Script won't run: its sender gets `send failed`,
    /// reason `stopped`, and its Decision settles undecided, `cancelled`.
    fn settleDropped(g: *Group, s: *Script, d: Delivery) !void {
        if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "stopped", .err = null } });
        if (d.decision) try g.takePart(d, .{ .undecided = .{ .script = s.name, .run = "", .outcome = "cancelled" } });
        g.releaseDelivery(d);
    }

    /// A Delivery reaching a stopped Script is dropped; a Host's is listed
    /// in another `stopped` record under the Script's reason.
    fn dropStopped(g: *Group, s: *Script, reason: []const u8, d: Delivery) !void {
        if (d.from == null and d.id > 0) if (g.trace) |out| {
            out.print("stopped {s} reason=", .{s.name}) catch {};
            writeText(out, reason);
            out.print(" dropped=[d{d}]\n", .{d.id}) catch {};
        };
        if (d.from == null and d.id > 0) g.reportStop(s.name, reason, &.{}, &.{d.id}, &.{}) catch {};
        g.discardMessage(d);
        try g.settleDropped(s, d);
    }

    /// Stops the Group, for an effect whose state is unknown: every Script,
    /// with the running Run discarded in its own.
    fn stopGroup(g: *Group, running: *Run) !void {
        for (g.scripts.items) |x| try g.stopScript(x, "effect state unknown", if (x == running.script) running else null, .{});
    }

    /// Whether the Group is stopped: by an effect whose state is unknown, or
    /// with every one of its Scripts stopped.
    pub fn stoppedState(g: *const Group) bool {
        if (g.fatal) return true;
        if (g.scripts.items.len == 0) return false;
        for (g.scripts.items) |x| if (x.stopped == null) return false;
        return true;
    }

    /// Queues `Stop` for a Script.
    pub fn stopInput(g: *Group, script_name: []const u8, reason: []const u8) !void {
        const n = try g.gpa.dupe(u8, script_name);
        errdefer g.gpa.free(n);
        const why = try g.gpa.dupe(u8, reason);
        errdefer g.gpa.free(why);
        try g.queueLanding(.{ .stop = .{ .script = n, .reason = why } });
    }

    /// Puts a message at the back of a Script's mailbox; refused, the
    /// message is released.
    fn post(g: *Group, s: *Script, d: Delivery) !void {
        g.markRoot(rootOf(d));
        if (s.stopped) |reason| return g.dropStopped(s, reason, d);
        s.work.append(g.gpa, .{ .message = d }) catch |e| {
            g.releaseDelivery(d);
            return e;
        };
    }

    /// Routes a Delivery to an object to its nearest Owning Script, or
    /// reports it `unhandled`. Takes it.
    fn route(g: *Group, d: Delivery) !void {
        const owner = d.at.?.owned() orelse return g.unhandled(d);
        try g.post(g.script(owner.owner_of.?).?, d);
    }

    /// The end of a message's path: the `unhandled` report, and `send
    /// failed` for a sender that waits. Takes it.
    fn unhandled(g: *Group, d: Delivery) !void {
        if (g.trace) |out| {
            out.writeAll("unhandled") catch {};
            if (d.from == null and d.id > 0) out.print(" d{d}", .{d.id}) catch {};
            out.print(" message={s}", .{d.message}) catch {};
            writeArgs(out, d.args);
            if (d.target) |o| {
                out.writeAll(" target=") catch {};
                display.writeTrace(out, o.value) catch {};
            }
            out.writeAll("\n") catch {};
        }
        g.reportUnhandled(d) catch {};
        defer g.releaseDelivery(d);
        if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "unhandled", .err = null } });
        // A Decision that reaches the end of its path is allowed.
        if (d.decision) try g.takePart(d, .allowed);
    }

    fn reportUnhandled(g: *Group, d: Delivery) !void {
        const r = &g.reports;
        try r.add(.{ .unhandled = .{
            .delivery = if (d.from == null and d.id > 0) try r.print("d{d}", .{d.id}) else "",
            .message = try r.text(d.message),
            .args = try r.valueList(d.args),
            .target = d.target,
        } });
    }

    /// A message no Run of `s` ended goes on from the parent of the object
    /// whose Owning Script received it, behind the messages already in the
    /// next Owning Script's mailbox. Copies it.
    fn climb(g: *Group, s: *Script, d: Delivery) !void {
        const handled = if (d.at) |at| at.owned() else s.owner;
        // An `error` message no clause matched is dropped: it never climbs
        // and isn't reported as `unhandled`.
        if (d.internal_error) return;
        var copy = try g.copyDelivery(d);
        const from = handled orelse return g.unhandled(copy);
        // A message to a Script climbs from its owner, which stays its
        // Target, `the target`, the rest of the way.
        if (copy.target == null) copy.target = from;
        const parent = from.parent orelse return g.unhandled(copy);
        var moved = copy;
        moved.at = parent;
        moved.passed_by = handled;
        try g.route(moved);
    }

    fn copyDelivery(g: *Group, d: Delivery) !Delivery {
        const gpa = g.gpa;
        const args = try gpa.dupe(*Value, d.args);
        for (args) |v| _ = v.retain();
        var out = d;
        out.args = args;
        out.message = try gpa.dupe(u8, d.message);
        out.from = if (d.from) |x| try gpa.dupe(u8, x) else null;
        out.during = if (d.during) |x| x.retain() else null;
        out.function = if (d.function) |x| x.retain() else null;
        return out;
    }

    /// Whether a Run of the clause hasn't ended.
    fn clauseBusy(g: *Group, s: *Script, library: ?*Library, body: u32) bool {
        _ = g;
        for (s.live.items) |r| if (r.clause_body != null and r.clause_body.? == body and r.clause_unit == library) return true;
        return false;
    }

    /// `, replacing`: cancels every Run of the clause that hasn't ended.
    /// What each waits on is abandoned now, and its cleanup runs in its
    /// Script's turn (chapter 6, Cancellation and Stop).
    fn cancelClause(g: *Group, s: *Script, library: ?*Library, body: u32) !void {
        for (s.live.items) |r| {
            if (r.clause_body == null or r.clause_body.? != body or r.clause_unit != library) continue;
            try g.cancel(s, r);
        }
    }

    fn hasHandler(g: *Group, s: *const Script, name: []const u8) bool {
        _ = g;
        return s.handlerUnit(name, .handler) != null;
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
                if (d.function) |f| contents += costs.size(f);
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
        // A cancellation's cleanup keeps only the frames and activations
        // it still needs; the dispatches it interrupted are gone.
        var cancelling: ?usize = null;
        for (run.controls.items, 0..) |c, i| if (c == .cleanup and c.cleanup.then == .cancel) {
            cancelling = i;
            break;
        };
        // A cancellation not yet started keeps the same: every cleanup is
        // still ahead of it, and the cleanups it was preempted in end.
        const pending_cancel = cancelling == null and run.resume_with != null and run.resume_with.? == .cancelled;
        if (pending_cancel) {
            var k = run.controls.items.len;
            while (k > 0 and run.controls.items[k - 1] == .cleanup) k -= 1;
            cancelling = k;
            total += cancelSize(run, run.frames.items.len, run.controls.items[0..k]);
        } else if (cancelling) |k| {
            const u = &run.controls.items[k].cleanup;
            const running: usize = if (u.next > 0 and !u.cleanups.items[u.next - 1].leave) u.cleanups.items[u.next - 1].frame else run.frames.items.len;
            total += cancelSize(run, running, run.controls.items[0..k]);
        } else for (run.frames.items) |*f| {
            total += frameSize(f);
        }
        if (run.waiting) |p| if (p.call != null or p.id.len > 0) {
            total += 48;
        };
        // A pending `wait for`'s `from` objects and captured values; a named
        // Script is not a value.
        if (run.waiting) |p| if (p.event) |e| for (e.branches) |b| switch (b) {
            .when => |x| {
                if (x.from) |v| if (v.data == .object) {
                    total += costs.size(v);
                };
                for (x.captures) |v| total += costs.size(v);
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
        // A preempted Run's catch dispatches: each context with its Error,
        // its activation, the owner's own stack and the failed frames it
        // holds aside. A pending cleanup has no size of its own; it keeps
        // its Error's context, an acceptance's activation, a transfer's
        // arguments and the failed continuation's operands (chapter 8,
        // Pending cleanup state).
        // Its interrupted dispatch contexts are gone, and the cleanups it
        // was preempted in end when it starts.
        if (pending_cancel) return total;
        for (run.controls.items, 0..) |c, i| switch (c) {
            .dispatch => |d| {
                if (cancelling) |k| if (i < k) continue;
                total += 96 + costs.size(d.err) + 48;
                total += stackSize(d.owner_stack.items);
                for (d.held) |*f| total += frameSize(f);
            },
            .cleanup => |u| switch (u.then) {
                .cancel => {},
                .accept => |acc| total += 96 + costs.size(u.err) + 48 + stackSize(acc.stack.items) + u.failed,
                .end, .search => total += 96 + costs.size(u.err) + u.failed,
                .transfer => |t| {
                    // Until its `leave`, the dispatch under it holds the
                    // context.
                    if (u.left) total += 96 + costs.size(u.err);
                    total += 8 * t.args.len + u.failed;
                    for (t.args) |v| total += costs.size(v);
                },
            },
        };
        return total;
    }

    /// The frames and dispatch activations a cancellation's remaining
    /// cleanup needs, with frame `running` running its cleanup and
    /// `dispatches` the controls it interrupted (chapter 8, Pending cleanup
    /// state). The running cleanup copy, and what it calls, keep
    /// their whole stacks; each interrupted stack keeps only the prefix
    /// its `finally` entries need, and an owner or activation none of them
    /// needs is gone. The interrupted dispatch contexts count nothing.
    fn cancelSize(run: *const Run, running: usize, dispatches: []const Control) u64 {
        var total: u64 = 0;
        for (run.frames.items, 0..) |*f, i| {
            if (i > running) {
                total += frameSize(f);
                continue;
            }
            var kept = false;
            var part: u64 = 0;
            // The owner's own continuation is under its first dispatch;
            // each activation's under the next, the last's in the frame.
            var own_stack: []const Slot = f.stack.items;
            var own_place: u32 = f.pc -| 1;
            var previous: ?*const Dispatch = null;
            for (dispatches) |*c| if (c.* == .dispatch and c.dispatch.owner == i) {
                const d = &c.dispatch;
                if (previous) |p| {
                    if (finallyPrefix(run, f, d.place, p.search.entry - 1)) |n| {
                        part += 48 + prefixSize(d.owner_stack.items, n);
                        kept = true;
                    }
                } else {
                    own_stack = d.owner_stack.items;
                    own_place = d.place;
                }
                previous = d;
                for (d.held, 0..) |*h, hi| {
                    const place = if (hi == d.held.len - 1) d.search.raised else h.pc -| 1;
                    if (finallyPrefix(run, h, place, null)) |n| total += frameHeader(h) + prefixSize(h.stack.items, n);
                }
            };
            if (previous) |p| {
                if (i == running) {
                    part += 48 + stackSize(f.stack.items);
                    kept = true;
                } else if (finallyPrefix(run, f, f.pc -| 1, p.search.entry - 1)) |n| {
                    part += 48 + prefixSize(f.stack.items, n);
                    kept = true;
                }
            }
            if (i == running and previous == null) {
                part += stackSize(f.stack.items);
                kept = true;
            } else if (finallyPrefix(run, f, own_place, null)) |n| {
                part += prefixSize(own_stack, n);
                kept = true;
            }
            if (kept) total += frameHeader(f) + part;
        }
        return total;
    }

    /// The Group's record of a Function Value's code, made once.
    pub fn functionCode(g: *Group, home: *const Script, library: ?*Library, body: u32) !*FunctionCode {
        for (g.functions.items) |f| if (f.library == library and f.body == body and f.generation == home.generation and std.mem.eql(u8, f.home, home.name)) return f;
        const b = home.unitIn(library).bodies[body];
        var required: usize = 0;
        for (b.params) |p| {
            if (std.mem.indexOf(u8, p, " = ") == null) required += 1;
        }
        const f = try g.gpa.create(FunctionCode);
        errdefer g.gpa.destroy(f);
        const name = try g.gpa.dupe(u8, if (b.kind == .lambda) "" else b.name);
        errdefer g.gpa.free(name);
        const unit = if (library) |l| l.identity else codeIdentity(home.name, home.source, .script, home.imports);
        f.* = .{ .home = try g.gpa.dupe(u8, home.name), .library = library, .body = body, .generation = home.generation, .name = name, .required = required, .total = b.params.len, .unit = unit };
        errdefer g.gpa.free(f.home);
        try g.functions.append(g.gpa, f);
        return f;
    }

    /// The code of a Function Value this Group made.
    pub fn codeOfValue(g: *Group, v: *const Value) ?*FunctionCode {
        return g.codeOf(v);
    }

    fn codeOf(g: *Group, v: *const Value) ?*FunctionCode {
        if (v.data != .function) return null;
        for (g.functions.items) |f| if (@intFromPtr(f) == v.data.function.identity) return f;
        return null;
    }

    /// The body a Function Value runs, or null once it is stale: its Home
    /// Script has gone or been reloaded since it was made.
    fn functionBody(g: *Group, f: *const FunctionCode) ?lower.Body {
        const home = g.script(f.home) orelse return null;
        if (home.generation != f.generation) return null;
        return home.unitIn(f.library).bodies[f.body];
    }

    /// A Function Value: `<function home:where {captures}>`, where `where`
    /// is a Library's name and `:` before its function's name or the
    /// Lambda's position.
    fn functionValue(g: *Group, run: *Run, library: ?*Library, body: u32, where: []const u8, captures: *Value) !*Value {
        const f = try g.functionCode(run.script, library, body);
        var shown: std.Io.Writer.Allocating = .init(g.scratch.allocator());
        // An extension's Lambda is placed by the extension's unit name; its
        // named functions, like the Script's own, by the Script's.
        const extension = if (library) |l| l.extension > 0 else false;
        if (extension and library.?.unit.bodies[body].kind == .lambda) {
            try shown.writer.print("<function {s}:", .{library.?.name});
        } else {
            try shown.writer.print("<function {s}:", .{run.script.name});
            if (library) |l| if (!extension) try shown.writer.print("{s}:", .{l.name});
        }
        try shown.writer.writeAll(where);
        if (captures.data.map.len > 0) {
            try shown.writer.writeByte(' ');
            display.write(&shown.writer, captures) catch return error.OutOfMemory;
        }
        try shown.writer.writeByte('>');
        return model.function(g.gpa, run.script.name, shown.written(), @intFromPtr(f), captures) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => g.raise("too deep", &.{}),
        };
    }

    /// `call-value` and `call-value-wait`: a Function Value whose Home
    /// Script is this one runs in the caller's Run, with its captures.
    fn callValue(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction) !Step {
        const n: usize = if (ins.op == .call_restricted) 1 else @intCast(ins.operands[0].int);
        const args = try g.scratch.allocator().alloc(*Value, n);
        for (0..n) |i| args[n - 1 - i] = pop(frame);
        defer for (args) |v| v.release();
        const fv = pop(frame);
        defer fv.release();
        if (fv.data != .function) return g.wrongKind("function", fv);
        const code = g.codeOf(fv) orelse return g.raise("function gone", &.{});
        const body = g.functionBody(code) orelse return g.raise("function gone", &.{});
        const waits = ins.op == .call_value_wait;
        // Another Script's Function Value is a message to it, which only
        // `and wait` may send; one that may suspend needs `and wait` too.
        const foreign = !std.mem.eql(u8, code.home, run.script.name);
        if ((foreign or body.may_suspend) and !waits) return g.raise("would suspend", &.{});
        var required: usize = 0;
        for (body.params) |p| {
            if (std.mem.indexOf(u8, p, " = ") == null) required += 1;
        }
        if (n < required or n > body.params.len) return g.raise("wrong arity", &.{});
        if (foreign) {
            if (run.scopes.items.len > 0) return g.refuseOpenScope(run);
            // A message to the Home Script, whose reply ends the wait.
            const home = g.script(code.home) orelse return g.raise("function gone", &.{});
            run.calls += 1;
            const id = try std.fmt.allocPrint(g.gpa, "{s}.c{d}", .{ run.id, run.calls });
            g.ids.append(g.gpa, id) catch |e| {
                g.gpa.free(id);
                return e;
            };
            if (g.trace) |out| {
                out.print("send {s} to={s} fn=", .{ id, home.name }) catch {};
                display.writeTrace(out, fv) catch {};
                writeArgs(out, args);
                out.writeAll(" wait=yes\n") catch {};
            }
            const owned = try g.gpa.alloc(*Value, n);
            for (owned, args) |*x, v| x.* = v.retain();
            var d = try g.newDelivery("", owned, id, rootOf(run.delivery));
            d.waits = true;
            d.function = fv.retain();
            try g.post(home, d);
            try g.suspendRun(run, "call-value-wait", .{ .id = id, .run = run, .deadline = nanos(g.clock) + @as(i128, run.limits.max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = run.limits.max_wait_ms });
            return .suspended;
        }
        try g.callFunction(run, code.library, code.body, args);
        const callee = &run.frames.items[run.frames.items.len - 1];
        if (ins.op == .call_restricted) callee.restricted = true;
        for (0..fv.data.function.captures.data.map.len, body.capture_slot..) |i, slot| {
            const p = fv.data.function.captures.data.map.at(i);
            callee.locals[slot].release();
            callee.locals[slot] = p.value.retain();
        }
        return .next;
    }

    /// Calls a function body of a unit: a new frame, with the defaults of
    /// the parameters the call leaves off.
    fn callFunction(g: *Group, run: *Run, library: ?*Library, body: u32, args: []const *Value) !void {
        try g.pushFrameIn(run, library, body, args);
        const callee = &run.frames.items[run.frames.items.len - 1];
        const params = unitOf(run, callee).bodies[body].params;
        for (params[args.len..], args.len + 1..) |p, slot| {
            const eq = std.mem.indexOf(u8, p, " = ") orelse continue;
            const def = std.fmt.parseInt(usize, p[eq + 3 ..], 10) catch continue;
            callee.locals[slot].release();
            callee.locals[slot] = definitionsOf(run, callee)[def].retain();
        }
    }

    /// Pushes the first clause of the Handler `name` from body `from` on
    /// whose parameter count fits, charging it, or returns false.
    fn nextClause(g: *Group, run: *Run, library: ?*Library, name: []const u8, from: usize, args: []const *Value) !bool {
        const bodies = if (library) |l| l.unit.bodies else run.script.unit.bodies;
        for (bodies[from..], from..) |b, i| {
            if (b.kind != .handler or !std.mem.eql(u8, b.name, name) or b.params.len != args.len) continue;
            try g.pushFrameIn(run, library, @intCast(i), args);
            run.frames.items[run.frames.items.len - 1].called = true;
            // The clause rate, charged with the clause body's first
            // instruction: never, if that instruction faults on its own
            // limit (chapter 8, Charging).
            run.called_clause += 4;
            return true;
        }
        return false;
    }

    fn pushFrame(g: *Group, run: *Run, body: u32, args: []const *Value) !void {
        return g.pushFrameIn(run, null, body, args);
    }

    /// Pushes a frame for a body of a Library's code, or with none, of the
    /// Run's Script.
    fn pushFrameIn(g: *Group, run: *Run, library: ?*Library, body: u32, args: []const *Value) !void {
        // A call that would pass the call depth faults at the call.
        if (run.frames.items.len >= run.script.limits.call_depth) return g.faultOn(.depth);
        const b = (if (library) |l| &l.unit else &run.script.unit).bodies[body];
        const locals = try g.gpa.alloc(*Value, b.locals);
        var made: usize = 0;
        // Unbound locals share this call's immutable Nothing. Each slot
        // still owns a reference; replacing one cannot change another.
        var empty: ?*Value = null;
        errdefer {
            for (locals[0..made]) |v| v.release();
            g.gpa.free(locals);
        }
        for (locals, 0..) |*l, i| {
            l.* = if (i >= 1 and i <= args.len) args[i - 1].retain() else if (empty) |v| v.retain() else blk: {
                const v = try nothing(g.gpa);
                empty = v;
                break :blk v;
            };
            made += 1;
        }
        const restricted = run.frames.items.len > 0 and run.frames.items[run.frames.items.len - 1].restricted;
        try run.frames.append(g.gpa, .{ .library = library, .body = body, .pc = b.first, .locals = locals, .restricted = restricted });
    }

    fn popFrame(g: *Group, run: *Run) void {
        var f = run.frames.pop().?;
        for (f.locals) |v| v.release();
        @import("group_allocator.zig").freeFrameBuffer(g.gpa, *Value, f.locals);
        for (f.stack.items) |slot| slot.release(g.gpa);
        @import("group_allocator.zig").freeFrameBuffer(g.gpa, Slot, f.stack.allocatedSlice());
    }

    // ------------------------------------------------------------ running

    const Outcome = union(enum) {
        returned: *Value,
        errored: *Value,
        clause_failed,
        unhandled,
        faulted: Fault,
        /// It suspended, at `run.suspended_at`.
        suspended,
        /// Its `, dropping` clause was busy.
        dropped,
        /// Dispatch reached the end of its clause's patterns and Guard.
        selected,
        /// It reached `pass`: the message goes on up the path.
        passed,
        cancelled,
        /// Its participant's commit failed, or failed abandonment on a
        /// participating Grant prevented it.
        effect_failed: EffectFailure,
        /// It reached `veto`, with its reason.
        vetoed: *Value,
        /// Its Script's Fuel Slice or the Group's Fuel cap is spent, so it
        /// stops before its next instruction, in the middle of its Segment.
        preempted: Preemption,
        /// The Group stopped while it ran, or a Stop of its Script landed,
        /// discarding it.
        stopped,
        /// A Rewind landed while it ran in its first Segment.
        rewound,
    };

    /// Runs until the bottom frame returns. `charged` is false for the
    /// initialiser, which costs nothing.
    fn execute(g: *Group, run: *Run, charged: bool) !Outcome {
        // Reuse the inline storage within this execution. The per-instruction
        // defer releases its owners and clears its metadata on every path.
        var held: Operands = .{};
        while (true) {
            if (g.release_pause) return .{ .preempted = .crossing };
            scratch_arena.reset(&g.scratch);
            // A clause a Command Call tried pays its rate with the clause
            // body's first instruction, this one.
            run.clause_fuel += run.called_clause;
            run.called_clause = 0;
            const frame = &run.frames.items[run.frames.items.len - 1];
            const pc = frame.pc;
            if (run.select_at) |at| if (run.frames.items.len == 1 and pc == at) {
                run.select_at = null;
                return .selected;
            };
            // What landed at the last Host crossing, between instructions.
            if (!g.answering_crossing) g.flushHeld();
            if (!g.answering_crossing and g.landing.items.len > 0 and run.base == 0 and run.id.len > 0) {
                g.land(run) catch |e| {
                    if (e != error.Deferred) return e;
                    return .{ .preempted = .crossing };
                };
            }
            if (g.release_pause) return .{ .preempted = .crossing };
            {
                if (if (run.returned_op == null and run.returned_prop == null) run.landed else null) |l| switch (l) {
                    .stop => return .stopped,
                    .rewind => return .rewound,
                    .cancel => {
                        run.landed = null;
                        return g.landedCancel(run);
                    },
                };
            }
            // Preemption, only between instructions.
            if (run.base == 0) if (g.preemption(run)) |by| return .{ .preempted = by };
            const ins = unitOf(run, frame).code[pc];
            // The instruction may move the frames, so its unit's name is
            // taken first.
            const at_unit = unitName(run, frame);
            g.driving = .{ .unit = at_unit, .pc = pc, .ins = ins };
            // Its operands, which stay on its failed continuation's stack
            // if it fails in a `finally` block's scope (chapter 8, Pending
            // cleanup state).
            try held.take(g.gpa, unitOf(run, frame), frame, pc, ins);
            defer held.release(g.gpa);
            frame.pc += 1;
            var charge: costs.Measures = .{};
            const done = g.instruction(run, frame, ins, &charge) catch |e| switch (e) {
                error.Raised => blk: {
                    const err = g.completeError(run, pc, ins) catch |other| {
                        charge.release();
                        return other;
                    };
                    break :blk Step{ .raised = err };
                },
                error.Landed => {
                    // A Stop, cancellation or Rewind that landed at this
                    // crossing: the call keeps its charge.
                    if (charged) {
                        const spent = costs.chargeInstruction(ins.op, &charge);
                        run.fuel += spent.fuel + run.clause_fuel;
                        run.alloc += spent.alloc;
                        run.clause_fuel = 0;
                    }
                    charge.release();
                    return switch (run.landed.?) {
                        .stop => .stopped,
                        .rewind => .rewound,
                        .cancel => blk: {
                            run.landed = null;
                            break :blk g.landedCancel(run);
                        },
                    };
                },
                error.GroupStop => {
                    // The call that stopped the Group keeps its charge.
                    if (charged) {
                        const spent = costs.chargeInstruction(ins.op, &charge);
                        run.fuel += spent.fuel + run.clause_fuel;
                        run.alloc += spent.alloc;
                        run.clause_fuel = 0;
                    }
                    charge.release();
                    return .stopped;
                },
                error.LimitFault => {
                    // The instruction's own limit, checked before its charge.
                    charge.release();
                    const limit = g.pending_fault.?;
                    g.pending_fault = null;
                    return g.limitFault(run, limit, at_unit, pc, ins);
                },
                else => |other| {
                    // Refused: the values the measures hold go too.
                    charge.release();
                    return other;
                },
            };
            if (done == .crossing) {
                // The Host deferred: the instruction has not happened.
                // Rewind it and pause like a preemption, in the Segment.
                run.frames.items[run.frames.items.len - 1].pc = pc;
                charge.release();
                return .{ .preempted = .crossing };
            }
            // An instruction charged nothing still pays dispatch's `clause`
            // rate.
            if (charged and charge.uncharged) {
                run.fuel += run.clause_fuel;
                run.clause_fuel = 0;
            }
            if (charged and !charge.uncharged) {
                var cost = costs.chargeInstruction(ins.op, &charge);
                const clause_fuel = run.clause_fuel;
                cost.fuel += clause_fuel;
                run.clause_fuel = 0;
                // A Run-ending `return`, `pass` or `veto` measures the
                // Script's Persistent State, without the Run, before its
                // charge; any instruction faults on a charge it can't cover.
                const ending = switch (done) {
                    .returned => run.frames.items.len - 1 == run.base,
                    .passed, .vetoed => true,
                    else => false,
                };
                const over: ?Fault = if (run.base > 0)
                    null
                else if (ending and g.persistentState(run.script) > run.script.limits.persistent_state)
                    .persistent
                else if (cost.fuel > fuelLeft(run))
                    .fuel
                else if (run.alloc + cost.alloc > run.limits.alloc_per_run)
                    .alloc
                else
                    null;
                if (over) |limit| {
                    // A Capability call that reached the Host keeps its
                    // charge before its result's conversion.
                    if ((limit == .alloc or limit == .fuel) and charge.reached_host) {
                        var before = charge;
                        before.result = null;
                        run.fuel += costs.chargeInstruction(ins.op, &before).fuel + clause_fuel;
                    }
                    charge.release();
                    switch (done) {
                        .returned, .raised, .vetoed => |v| v.release(),
                        .transfer => |t| releaseAll(t.args, g.gpa),
                        else => {},
                    }
                    return g.limitFault(run, limit, at_unit, pc, ins);
                }
                run.fuel += cost.fuel;
                run.alloc += cost.alloc;
                // A suspension measures it with the Run, after the charge
                // and any Host effect.
                if (done == .suspended and run.base == 0 and g.persistentState(run.script) + g.runSize(run) > run.script.limits.persistent_state) {
                    charge.release();
                    return g.limitFault(run, .persistent, at_unit, pc, ins);
                }
            }
            charge.release();
            switch (done) {
                .crossing => unreachable,
                .next => {},
                .returned => |v| {
                    g.popFrame(run);
                    if (run.frames.items.len == run.base) return .{ .returned = v };
                    const caller = &run.frames.items[run.frames.items.len - 1];
                    try g.push(caller, v);
                },
                .clause_failed => {
                    const failed = &run.frames.items[run.frames.items.len - 1];
                    if (!failed.called or run.frames.items.len - 1 <= run.base) {
                        g.popFrame(run);
                        return .clause_failed;
                    }
                    // A Command Call's clause failed: try the next, or
                    // raise `no match` at the call.
                    const body = failed.body;
                    const library = failed.library;
                    const failed_unit = unitOf(run, failed);
                    const n = failed_unit.bodies[body].params.len;
                    const args = try g.gpa.alloc(*Value, n);
                    defer releaseAll(args, g.gpa);
                    for (args, failed.locals[1 .. n + 1]) |*x, v| x.* = v.retain();
                    g.popFrame(run);
                    if (try g.nextClause(run, library, failed_unit.bodies[body].name, body + 1, args)) continue;
                    const caller = &run.frames.items[run.frames.items.len - 1];
                    const call_pc = caller.pc - 1;
                    const call_ins = unitOf(run, caller).code[call_pc];
                    switch (g.raise("no match", &.{})) {
                        error.Raised => {},
                        error.OutOfMemory => return error.OutOfMemory,
                    }
                    const err = try g.completeError(run, call_pc, call_ins);
                    if (try g.unwind(run, err, call_pc, call_ins, charged)) |end| return end;
                },
                .raised => |err| {
                    g.failing_operands = stackSize(held.slots());
                    defer g.failing_operands = 0;
                    if (try g.unwind(run, err, pc, ins, charged)) |end| return end;
                },
                .end_cleanup => {
                    // A `finally` block an uncaught error ran raises it
                    // again as it goes on.
                    if (run.controls.items.len > 0) switch (run.controls.items[run.controls.items.len - 1]) {
                        .cleanup => |u| if (u.then == .end) g.writeRaise(run, u.err, pc, ins),
                        .dispatch => {},
                    };
                    if (try g.nextCleanup(run, charged)) |end| return end;
                },
                .catch_accept => if (try g.catchAccept(run, charged)) |end| return end,
                .catch_next => if (try g.catchNext(run, charged)) |end| return end,
                .transfer => |t| if (try g.startTransfer(run, t, pc, charged)) |end| return end,
                .guard_value => |v| {
                    defer v.release();
                    if (g.guardEntry(run, pc)) |entry| {
                        if (g.trace) |w| {
                            w.print("guard-skip {s} at={s}:{d} pos={d}:{d} value=", .{ run.id, topName(run), pc, ins.position.line, ins.position.column }) catch {};
                            display.writeTrace(w, v) catch {};
                            w.writeAll("\n") catch {};
                        }
                        try g.cutStack(run, run.frames.items.len - 1, entry.depth);
                        run.frames.items[run.frames.items.len - 1].pc = entry.target;
                    }
                },
                .suspended => return .suspended,
                .passed => {
                    while (run.frames.items.len > 0) g.popFrame(run);
                    return .passed;
                },
                .vetoed => |v| {
                    while (run.frames.items.len > 0) g.popFrame(run);
                    return .{ .vetoed = v };
                },
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
        // An error raised in stdlib code looks like a Built-in's: its `at`
        // names the call into the stdlib, and the Core adds its `message`.
        var index = run.frames.items.len - 1;
        var at_ins = ins;
        while (index > 0) : (index -= 1) {
            const l = run.frames.items[index].library orelse break;
            if (!l.stdlib) break;
            g.pending_core = true;
            const caller = &run.frames.items[index - 1];
            at_ins = unitOf(run, caller).code[caller.pc - 1];
        }
        const at = try g.atMap(run, &run.frames.items[index], at_ins);
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
            for (0..raw.data.map.len) |map_index| {
                const p = raw.data.map.at(map_index);
                const listed = for (pairs.items) |q| {
                    if (std.mem.eql(u8, q.key, p.key)) break true;
                } else false;
                if (!listed) try pairs.append(g.gpa, p);
            }
        } else {
            try raw.data.map.appendTo(g.gpa, &pairs);
            if (raw.get("at") != null) return raw.retain();
        }
        try pairs.append(g.gpa, .{ .key = "at", .value = at });
        const full = try model.map(g.gpa, pairs.items);
        full.core_message = message != null;
        return full;
    }

    /// A Core error raised outside any Run, as a Host's ScriptError sees
    /// it: its catalogue code and message, and its other fields in catalogue
    /// order. The caller owns the message and the data.
    pub fn takeFailure(g: *Group) !struct { code: []const u8, message: []u8, data: *Value } {
        const raw = g.pending_error.?;
        defer {
            raw.release();
            g.pending_error = null;
            g.pending_core = false;
        }
        const entry = errorEntry(raw.get("code").?.data.text) orelse return error.InvalidValue;
        const message = try g.gpa.dupe(u8, try g.messageText(entry, raw));
        errdefer g.gpa.free(message);
        var pairs: std.ArrayList(model.Pair) = .empty;
        defer pairs.deinit(g.gpa);
        for (entry.fields) |f| if (raw.get(f)) |v| try pairs.append(g.gpa, .{ .key = f, .value = v });
        if (entry.optional) |opt| for (opt) |f| if (raw.get(f)) |v| try pairs.append(g.gpa, .{ .key = f, .value = v });
        for (0..raw.data.map.len) |map_index| {
            const p = raw.data.map.at(map_index);
            const listed = std.mem.eql(u8, p.key, "code") or for (pairs.items) |q| {
                if (std.mem.eql(u8, q.key, p.key)) break true;
            } else false;
            if (!listed) try pairs.append(g.gpa, p);
        }
        return .{ .code = entry.code, .message = message, .data = try model.map(g.gpa, pairs.items) };
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
    fn atMap(g: *Group, run: *Run, frame: *const Frame, ins: lower.Instruction) !*Value {
        const b = unitOf(run, frame).bodies[frame.body];
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
        const unit = try model.text(g.gpa, unitName(run, frame));
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
        run.raised_at = ins.position;
        const held_handler = if (err.get("at")) |at| at.get("handler") else null;
        if (held_handler) |h| _ = h.retain();
        if (run.end_handler) |h| h.release();
        run.end_handler = held_handler;
        const handler = if (held_handler) |h| if (h.data == .text) h.data.text else "" else "";
        run.end_at = .{ .unit = topName(run), .line = ins.position.line, .column = ins.position.column, .handler = handler, .pc = pc };
        // An initialiser's error is the unit's load diagnostic, not a
        // `raise` record.
        if (run.id.len == 0) return;
        const w = g.trace orelse return;
        const code = err.get("code") orelse return;
        w.print("raise {s} code=", .{run.id}) catch {};
        display.writeTrace(w, code) catch {};
        w.print(" at={s}:{d} pos={d}:{d}\n", .{ topName(run), pc, ins.position.line, ins.position.column }) catch {};
    }

    // ------------------------------------------------------------ unwinding

    fn covers(e: lower.Unwind, pc: u32) bool {
        return e.first <= pc and pc <= e.last;
    }

    /// The guard region of the top frame covering `pc`.
    fn guardEntry(g: *Group, run: *Run, pc: u32) ?lower.Unwind {
        _ = g;
        for (unitOf(run, &run.frames.items[run.frames.items.len - 1]).unwind) |e| if (e.kind == .guard and covers(e, pc)) return e;
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

    /// Whether entry `ei` of frame `index`'s unit is one a search or a
    /// cleanup may use: in the frame's own body, inside `limit` at its
    /// frame, and not one `skip` has already done.
    fn usable(run: *Run, index: usize, e: lower.Unwind, ei: usize, limit: ?Limit, skip: ?Limit) bool {
        const unit = unitOf(run, &run.frames.items[index]);
        const body = unit.bodies[run.frames.items[index].body];
        if (e.first < body.first or e.last > body.last) return false;
        if (limit) |l| if (index == l.frame and ei >= l.entry) return false;
        if (skip) |s| if (index == s.frame and ei < s.entry) return false;
        return true;
    }

    /// The innermost control bounding an error raised now: a dispatch's
    /// policy, or the `finally` block a cleanup is running.
    fn limitOf(run: *Run) ?Limit {
        const c = if (run.controls.items.len > 0) &run.controls.items[run.controls.items.len - 1] else return null;
        return switch (c.*) {
            .dispatch => |d| .{ .frame = d.owner, .entry = d.search.entry - 1 },
            .cleanup => |u| if (u.next > 0 and !u.cleanups.items[u.next - 1].leave)
                .{ .frame = u.cleanups.items[u.next - 1].frame, .entry = u.cleanups.items[u.next - 1].entry }
            else
                null,
        };
    }

    /// Takes a raised error: a guard region skips its clause; otherwise a
    /// two-phase catch search runs each catch's tests before anything is
    /// discarded, then the exited `finally` blocks run, innermost first.
    /// An error inside a Recovery policy or a `finally` block a cleanup is
    /// running searches only inside it first. Returns the Run's end, if the
    /// error ends it.
    fn unwind(g: *Group, run: *Run, err: *Value, pc: u32, ins: lower.Instruction, charged: bool) !?Outcome {
        const top = run.frames.items.len - 1;
        if (g.guardEntry(run, pc)) |entry| {
            defer err.release();
            if (g.trace) |w| {
                w.print("guard-skip {s} at={s}:{d} pos={d}:{d} code=", .{ run.id, topName(run), pc, ins.position.line, ins.position.column }) catch {};
                display.writeTrace(w, err.get("code").?) catch {};
                w.writeAll("\n") catch {};
            }
            try g.cutStack(run, top, entry.depth);
            run.frames.items[top].pc = entry.target;
            return null;
        }
        g.raiseRecord(run, err, pc, ins);
        return g.search(run, err, .{ .frame = top, .entry = 0, .raised = pc, .limit = limitOf(run), .position = top + 1 }, charged);
    }

    /// Charges `unwind` for frames a search leaves, as part of the charge of
    /// the instruction driving it, which faults if the Run can't cover it.
    fn chargeUnwind(g: *Group, run: *Run, fuel: u64) ?Outcome {
        if (run.base == 0 and fuel > fuelLeft(run)) {
            const d = g.driving;
            return g.limitFault(run, .fuel, d.unit, d.pc, d.ins);
        }
        run.fuel += fuel;
        return null;
    }

    /// A raise's record, and its Join's members abandoned: an error leaving
    /// a Join abandons the members still pending.
    fn raiseRecord(g: *Group, run: *Run, err: *Value, pc: u32, ins: lower.Instruction) void {
        g.writeRaise(run, err, pc, ins);
        g.abandonJoin(run);
    }

    /// Searches for a catch from `s`'s frame and entry outward, within its
    /// limit. A covering catch starts its dispatch, and the run loop runs
    /// its tests. Takes `err`.
    fn search(g: *Group, run: *Run, err: *Value, s: Search, charged: bool) Allocator.Error!?Outcome {
        var position = s.position;
        const lowest = if (s.limit) |l| l.frame else 0;
        var index = s.frame + 1;
        while (index > lowest) {
            index -= 1;
            const unit = unitOf(run, &run.frames.items[index]);
            const fpc = framePc(run, index, s.raised);
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .@"catch" or !covers(e, fpc)) continue;
                if (index == s.frame and ei < s.entry) continue;
                if (!usable(run, index, e, ei, s.limit, null)) continue;
                // Each search step charges the frames it leaves.
                if (charged) if (g.chargeUnwind(run, 4 * (position -| (index + 1)))) |end| {
                    err.release();
                    return end;
                };
                position = index + 1;
                try g.beginDispatch(run, err, index, e, .{ .frame = index, .entry = ei + 1, .raised = s.raised, .limit = s.limit, .position = position, .skip = s.skip });
                return null;
            }
        }
        if (s.limit == null) {
            if (charged) if (g.chargeUnwind(run, 4 * position)) |end| {
                err.release();
                return end;
            };
            var cleanups: std.ArrayList(Cleanup) = .empty;
            errdefer cleanups.deinit(g.gpa);
            try g.collect(run, &cleanups, 0, null, s.skip, s.raised);
            try g.startCleanup(run, err, cleanups, .end);
            // The failing frame's continuation keeps the failed
            // instruction's operands.
            if (g.failing_operands > 0) {
                const u = &run.controls.items[run.controls.items.len - 1].cleanup;
                const top = run.frames.items.len - 1;
                u.failed = stackSize(run.frames.items[top].stack.items) + g.failing_operands;
                u.failed_frame = top;
                g.failing_operands = 0;
            }
            return g.nextCleanup(run, charged);
        }
        // It escapes the control that bounds it.
        const bound = &run.controls.items[run.controls.items.len - 1];
        switch (bound.*) {
            .dispatch => return g.abortRecovery(run, err, s.raised, position, s.skip, charged),
            .cleanup => |*u| {
                // An error ending a cancelled Run's cleanup keeps its
                // writes; the rest of the cleanup doesn't run.
                if (u.then == .cancel) {
                    if (run.cleanup_code == null) run.cleanup_code = err.get("code").?.retain();
                    if (g.trace) |w| {
                        w.print("cleanup-failed {s} code=", .{run.id}) catch {};
                        display.writeTrace(w, err.get("code").?) catch {};
                        w.writeAll("\n") catch {};
                    }
                    err.release();
                    return g.cleanupFailed(run);
                }
                const at = u.cleanups.items[u.next - 1];
                // An aborted policy's own `finally` blocks run in its
                // activation, which this search leaves as a frame.
                if (charged and u.then == .search and !u.left) if (g.chargeUnwind(run, 4)) |end| {
                    err.release();
                    return end;
                };
                const replaced = try withDuring(g.gpa, err, u.err);
                err.release();
                var popped = run.controls.pop().?;
                g.disposeControl(&popped);
                return g.search(run, replaced, .{ .frame = at.frame, .entry = at.entry, .raised = s.raised, .limit = limitOf(run), .position = position }, charged);
            },
        }
    }

    /// Starts a catch's tests in a dispatch activation of frame `owner`: its
    /// own operand stack, the owner's iterator prefix and the error, over
    /// the owner's locals. The failed frames above it are held aside, and
    /// stay retained, until the dispatch ends.
    fn beginDispatch(g: *Group, run: *Run, err: *Value, owner: usize, entry: lower.Unwind, s: Search) !void {
        errdefer err.release();
        const held = try g.gpa.dupe(Frame, run.frames.items[owner + 1 ..]);
        errdefer g.gpa.free(held);
        try run.controls.ensureUnusedCapacity(g.gpa, 1);
        var activation: std.ArrayList(Slot) = .empty;
        errdefer {
            for (activation.items) |slot| slot.release(g.gpa);
            activation.deinit(g.gpa);
        }
        const f = &run.frames.items[owner];
        for (f.stack.items[0..@min(entry.depth, f.stack.items.len)]) |slot| try activation.append(g.gpa, retainSlot(slot));
        try activation.append(g.gpa, .{ .value = err.retain() });
        run.frames.shrinkRetainingCapacity(owner + 1);
        run.controls.appendAssumeCapacity(.{ .dispatch = .{ .err = err, .owner = owner, .place = framePcHeld(run, owner, held, s.raised), .held = held, .owner_stack = f.stack, .owner_pc = f.pc, .search = s } });
        f.stack = activation;
        f.pc = entry.target;
    }

    /// An owner's place, with the frames above it held aside.
    fn framePcHeld(run: *Run, owner: usize, held: []const Frame, raised: u32) u32 {
        if (held.len == 0) return raised;
        return run.frames.items[owner].pc - 1;
    }

    /// Ends the top dispatch: the owner gets its own stack and place back,
    /// and the held frames return. Returns it, the caller owning its error.
    fn endDispatch(g: *Group, run: *Run) Dispatch {
        const d = run.controls.pop().?.dispatch;
        const f = &run.frames.items[d.owner];
        for (f.stack.items) |slot| slot.release(g.gpa);
        f.stack.deinit(g.gpa);
        f.stack = d.owner_stack;
        f.pc = d.owner_pc;
        // The frames were held from this list, so there is room.
        run.frames.appendSliceAssumeCapacity(d.held);
        g.gpa.free(d.held);
        return d;
    }

    /// `catch-next`: the search goes on outward from the next entry.
    fn catchNext(g: *Group, run: *Run, charged: bool) !?Outcome {
        const d = g.endDispatch(run);
        return g.search(run, d.err, d.search, charged);
    }

    /// `catch-accept`: the exited `finally` blocks run, innermost first,
    /// then the owner goes on at the binding moves with the activation's
    /// stack.
    fn catchAccept(g: *Group, run: *Run, charged: bool) !?Outcome {
        const d = &run.controls.items[run.controls.items.len - 1].dispatch;
        const f = &run.frames.items[d.owner];
        const accept: Accept = .{ .frame = d.owner, .pc = f.pc, .stack = f.stack };
        // The activation's stack goes with the acceptance.
        f.stack = .empty;
        const ended = g.endDispatch(run);
        var cleanups: std.ArrayList(Cleanup) = .empty;
        errdefer cleanups.deinit(g.gpa);
        try g.collect(run, &cleanups, ended.owner, ended.search.entry - 1, ended.search.skip, ended.search.raised);
        try g.startCleanup(run, ended.err, cleanups, .{ .accept = accept });
        return g.nextCleanup(run, charged);
    }

    /// An error escaping a Recovery policy: its original error becomes the
    /// new one's `during`, the policy's exited `finally` blocks and then
    /// the failure's run, and the search goes on outward from the catching
    /// `try`, past its other catches.
    fn abortRecovery(g: *Group, run: *Run, err: *Value, raised: u32, position: usize, skip: ?Limit, charged: bool) Allocator.Error!?Outcome {
        const d = &run.controls.items[run.controls.items.len - 1].dispatch;
        const replaced = try withDuring(g.gpa, err, d.err);
        err.release();
        errdefer replaced.release();
        var cleanups: std.ArrayList(Cleanup) = .empty;
        errdefer cleanups.deinit(g.gpa);
        try g.collect(run, &cleanups, d.owner, d.search.entry - 1, skip, raised);
        try cleanups.append(g.gpa, .{ .leave = true });
        // The search goes on from where the policy failed, which is outside
        // the catching `try`'s own offers.
        var then = d.search;
        then.position = position;
        then.raised = if (run.frames.items.len - 1 == d.owner) raised else run.frames.items[d.owner].pc - 1;
        try g.startCleanup(run, replaced, cleanups, .{ .search = then });
        return g.nextCleanup(run, charged);
    }

    /// Appends the `finally` entries covering each frame's place from the
    /// top down to `low`, innermost first: in `low`, only those before
    /// `before`, and none `skip` has run.
    fn collect(g: *Group, run: *Run, list: *std.ArrayList(Cleanup), low: usize, before: ?usize, skip: ?Limit, raised: u32) !void {
        var index = run.frames.items.len;
        const limit: ?Limit = if (before) |b| .{ .frame = low, .entry = b } else null;
        while (index > low) {
            index -= 1;
            const unit = unitOf(run, &run.frames.items[index]);
            const fpc = framePc(run, index, raised);
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .finally or !covers(e, fpc)) continue;
                if (!usable(run, index, e, ei, limit, skip)) continue;
                try list.append(g.gpa, .{ .frame = index, .target = e.target, .depth = e.depth, .entry = ei });
            }
        }
    }

    /// Pushes a cleanup: its `finally` blocks run for `err`, then `then`.
    /// Takes `err` and `cleanups`.
    fn startCleanup(g: *Group, run: *Run, err: *Value, cleanups: std.ArrayList(Cleanup), then: Then) !void {
        run.controls.append(g.gpa, .{ .cleanup = .{ .err = err, .cleanups = cleanups, .then = then } }) catch |e| {
            var c: Control = .{ .cleanup = .{ .err = err, .cleanups = cleanups, .then = then } };
            g.disposeControl(&c);
            return e;
        };
    }

    /// Runs the next scheduled `finally` block, or what follows the last.
    fn nextCleanup(g: *Group, run: *Run, charged: bool) Allocator.Error!?Outcome {
        while (true) {
            if (run.controls.items.len == 0) return null;
            const u = &run.controls.items[run.controls.items.len - 1].cleanup;
            if (u.next < u.cleanups.items.len) {
                const c = u.cleanups.items[u.next];
                u.next += 1;
                if (c.leave) {
                    try g.leaveDispatch(run);
                    continue;
                }
                while (run.frames.items.len > c.frame + 1) g.popFrame(run);
                // Entering cleanup doesn't replace the failed continuation's
                // operands; a cancellation keeps only the prefix.
                if (u.then != .cancel and u.failed_frame != c.frame) {
                    u.failed = stackSize(run.frames.items[c.frame].stack.items);
                    u.failed_frame = c.frame;
                }
                try g.cutStack(run, c.frame, c.depth);
                run.frames.items[c.frame].pc = c.target;
                return null;
            }
            var done = run.controls.pop().?.cleanup;
            done.cleanups.deinit(g.gpa);
            switch (done.then) {
                .accept => |acc| {
                    done.err.release();
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
                    return .{ .errored = done.err };
                },
                .cancel => {
                    done.err.release();
                    while (run.frames.items.len > 0) g.popFrame(run);
                    return .cancelled;
                },
                .transfer => |t| {
                    done.err.release();
                    defer releaseAll(t.args, g.gpa);
                    try g.enterOffer(run, t);
                    return null;
                },
                .search => |s| {
                    // The frames above the catching one are gone; it goes on
                    // from its own place.
                    while (run.frames.items.len > s.frame + 1) g.popFrame(run);
                    return g.search(run, done.err, .{ .frame = s.frame, .entry = s.entry, .raised = s.raised, .limit = s.limit, .position = s.position, .skip = .{ .frame = s.frame, .entry = s.entry } }, charged);
                },
            }
        }
    }

    /// Ends the dispatch under the running cleanup once its policy's own
    /// `finally` blocks have run, and schedules the failure's: down to the
    /// offering frame for a transfer, or to the catching one for an abort.
    fn leaveDispatch(g: *Group, run: *Run) !void {
        const u_index = run.controls.items.len - 1;
        const d_index = u_index - 1;
        // Moved to the top, so the dispatch can end as the top control.
        std.mem.swap(Control, &run.controls.items[u_index], &run.controls.items[d_index]);
        const raised = run.controls.items[u_index].dispatch.search.raised;
        const ended = g.endDispatch(run);
        const u = &run.controls.items[d_index].cleanup;
        u.left = true;
        var more: std.ArrayList(Cleanup) = .empty;
        defer more.deinit(g.gpa);
        switch (u.then) {
            .transfer => |t| try g.collect(run, &more, t.frame, t.offer_entry, null, raised),
            // A cancellation's cleanup goes on to the next dispatch's
            // policy, which it leaves in turn, or to the Run's first frame.
            .cancel => if (d_index > 0 and run.controls.items[d_index - 1] == .dispatch) {
                const outer = run.controls.items[d_index - 1].dispatch;
                try g.collect(run, &more, outer.owner, outer.search.entry - 1, null, raised);
                try more.append(g.gpa, .{ .leave = true });
            } else try g.collect(run, &more, 0, null, null, raised),
            else => try g.collect(run, &more, ended.owner, ended.search.entry - 1, null, raised),
        }
        // The cleanup holds its own error.
        ended.err.release();
        try u.cleanups.insertSlice(g.gpa, u.next, more.items);
    }

    /// Releases a control's own resources, for a Run that is dropped or a
    /// control that is abandoned.
    fn disposeControl(g: *Group, c: *Control) void {
        switch (c.*) {
            .dispatch => |*d| {
                d.err.release();
                for (d.owner_stack.items) |slot| slot.release(g.gpa);
                d.owner_stack.deinit(g.gpa);
                for (d.held) |*f| {
                    for (f.locals) |v| v.release();
                    g.gpa.free(f.locals);
                    for (f.stack.items) |slot| slot.release(g.gpa);
                    f.stack.deinit(g.gpa);
                }
                g.gpa.free(d.held);
            },
            .cleanup => |*u| {
                switch (u.then) {
                    .accept => |acc| {
                        var stack = acc.stack;
                        for (stack.items) |slot| slot.release(g.gpa);
                        stack.deinit(g.gpa);
                    },
                    .transfer => |t| releaseAll(t.args, g.gpa),
                    .end, .cancel, .search => {},
                }
                u.err.release();
                u.cleanups.deinit(g.gpa);
            },
        }
    }

    /// Drops every control, innermost first, for a Run that ends without
    /// them.
    fn abandonUnwinding(g: *Group, run: *Run) void {
        while (run.controls.pop()) |c| {
            var x = c;
            g.disposeControl(&x);
        }
        run.controls.deinit(g.gpa);
        run.controls = .empty;
    }

    // ------------------------------------------------------------ offers

    /// The innermost dispatch, whose failure chain offers are chosen from.
    fn recovery(run: *Run) ?*Dispatch {
        var i = run.controls.items.len;
        while (i > 0) {
            i -= 1;
            switch (run.controls.items[i]) {
                .dispatch => |*d| return d,
                .cleanup => {},
            }
        }
        return null;
    }

    /// The current recovery's failure chain: the innermost dispatch's, or
    /// once a transfer's dispatch has ended, the frames its cleanup is
    /// leaving, whose offers stay eligible until the action is entered.
    const Chain = union(enum) { dispatch: *const Dispatch, frames: ?Limit };

    fn chainOf(run: *Run) ?Chain {
        var i = run.controls.items.len;
        while (i > 0) {
            i -= 1;
            switch (run.controls.items[i]) {
                .dispatch => |*d| return .{ .dispatch = d },
                .cleanup => |u| if (u.left and u.then == .transfer) return .{ .frames = u.then.transfer.limit },
            }
        }
        return null;
    }

    /// A found offer: its frame, counted with the held frames back in
    /// place, its `offer` entry and record, and its place in the record.
    const Found = struct { frame: usize, entry: usize, record: u32, offer: u32 };

    /// Looks `name` up in a dispatch's failure chain: the held frames, the
    /// owner at its place, then the frames below it within its limit,
    /// innermost first, each try's offers in source order. `examined`
    /// counts the frames scanned.
    fn lookupOffer(run: *Run, chain: Chain, name: []const u8, examined: *u64) ?Found {
        const d = switch (chain) {
            .dispatch => |d| d,
            .frames => |limit| return lookupFrames(run, limit, name, examined),
        };
        const lowest = if (d.search.limit) |l| l.frame else 0;
        var level: usize = d.owner + d.held.len + 1;
        while (level > lowest) {
            level -= 1;
            examined.* += 1;
            // The frame at this level, and its place in the failure.
            const frame: *const Frame = if (level > d.owner) &d.held[level - d.owner - 1] else &run.frames.items[level];
            const place: u32 = if (level == d.owner + d.held.len) d.search.raised else if (level >= d.owner) (if (level == d.owner) d.place else frame.pc - 1) else frame.pc - 1;
            const unit = unitOf(run, frame);
            const body = unit.bodies[frame.body];
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .offer or !covers(e, place)) continue;
                if (e.first < body.first or e.last > body.last) continue;
                if (d.search.limit) |l| if (level == l.frame and ei >= l.entry) continue;
                for (unit.offers[e.target].offers, 0..) |o, j| if (std.mem.eql(u8, o.name, name)) return .{ .frame = level, .entry = ei, .record = e.target, .offer = @intCast(j) };
            }
        }
        return null;
    }

    /// Looks `name` up in the Run's frames, innermost first, each at the
    /// instruction it is running or waiting on.
    fn lookupFrames(run: *Run, limit: ?Limit, name: []const u8, examined: *u64) ?Found {
        const lowest = if (limit) |l| l.frame else 0;
        var level = run.frames.items.len;
        while (level > lowest) {
            level -= 1;
            examined.* += 1;
            const frame = &run.frames.items[level];
            const place = frame.pc - 1;
            const unit = unitOf(run, frame);
            for (unit.unwind, 0..) |e, ei| {
                if (e.kind != .offer or !covers(e, place)) continue;
                if (!usable(run, level, e, ei, limit, null)) continue;
                for (unit.offers[e.target].offers, 0..) |o, j| if (std.mem.eql(u8, o.name, name)) return .{ .frame = level, .entry = ei, .record = e.target, .offer = @intCast(j) };
            }
        }
        return null;
    }

    /// `choose-offer`: the nearest offer named `name` in the failure chain,
    /// with exactly `args.len` parameters. Its policy's own `finally`
    /// blocks run, then the failure's down to the offering `try`, then the
    /// action is entered. Takes `args`.
    fn chooseOffer(g: *Group, run: *Run, name: []const u8, args: []*Value, pc: u32, ins: lower.Instruction, m: *costs.Measures) !Step {
        m.count = args.len;
        const d = recovery(run) orelse {
            releaseAll(args, g.gpa);
            return g.raiseUnavailable(name);
        };
        var examined: u64 = 0;
        const found = lookupOffer(run, .{ .dispatch = d }, name, &examined);
        m.fuel_extra = 4 * examined;
        const f = found orelse {
            releaseAll(args, g.gpa);
            return g.raiseUnavailable(name);
        };
        const frame: *const Frame = if (f.frame > d.owner) &d.held[f.frame - d.owner - 1] else &run.frames.items[f.frame];
        const offer = unitOf(run, frame).offers[f.record].offers[f.offer];
        if (offer.binds.len != args.len) {
            releaseAll(args, g.gpa);
            return g.raise("wrong arity", &.{});
        }
        run.attempts += 1;
        if (g.trace) |w| {
            w.print("offer-chosen {s} attempt={d} name=", .{ run.id, run.attempts }) catch {};
            const shown_name = try model.text(g.gpa, name);
            defer shown_name.release();
            display.writeTrace(w, shown_name) catch {};
            w.print(" at={s}:{d} target={s}:{d}", .{ topName(run), pc, unitName(run, frame), offer.entry }) catch {};
            if (args.len > 0) {
                w.writeAll(" args=") catch {};
                const shown = try model.list(g.gpa, args);
                defer shown.release();
                display.writeTrace(w, shown) catch {};
            }
            w.writeAll("\n") catch {};
        }
        _ = ins;
        return .{ .transfer = .{ .frame = f.frame, .offer_entry = f.entry, .record = f.record, .offer = f.offer, .args = args, .attempt = run.attempts, .limit = d.search.limit } };
    }

    fn raiseUnavailable(g: *Group, name: []const u8) error{ Raised, OutOfMemory } {
        const n = model.text(g.gpa, name) catch return error.OutOfMemory;
        defer n.release();
        return g.raise("offer unavailable", &.{.{ .key = "name", .value = n }});
    }

    /// Starts a chosen transfer: the policy's own `finally` blocks, then
    /// the failure's, then the action.
    fn startTransfer(g: *Group, run: *Run, t: Transfer, pc: u32, charged: bool) !?Outcome {
        errdefer releaseAll(t.args, g.gpa);
        const d = recovery(run).?;
        var cleanups: std.ArrayList(Cleanup) = .empty;
        errdefer cleanups.deinit(g.gpa);
        try g.collect(run, &cleanups, d.owner, d.search.entry - 1, null, pc);
        try cleanups.append(g.gpa, .{ .leave = true });
        const err = d.err.retain();
        try g.startCleanup(run, err, cleanups, .{ .transfer = t });
        return g.nextCleanup(run, charged);
    }

    /// Enters a chosen action: the frames above its `try` are gone, its
    /// parameters bind at once, and it starts at its entry.
    fn enterOffer(g: *Group, run: *Run, t: Transfer) !void {
        while (run.frames.items.len > t.frame + 1) g.popFrame(run);
        const f = &run.frames.items[t.frame];
        const unit = unitOf(run, f);
        const record = unit.offers[t.record];
        const offer = record.offers[t.offer];
        try g.cutStack(run, t.frame, record.depth);
        for (offer.binds, t.args) |slot, v| {
            f.locals[slot].release();
            f.locals[slot] = v.retain();
        }
        f.pc = offer.entry;
        g.write("offer-entered {s} attempt={d} target={s}:{d}\n", .{ run.id, t.attempt, unitName(run, f), offer.entry });
    }

    /// `offerAvailable`: whether the current recovery's failure chain
    /// offers a valid Name, with the frames it scanned.
    fn offerAvailable(g: *Group, run: *Run, args: []const *Value, m: *costs.Measures) !*Value {
        m.builtin = "offerAvailable";
        m.args = args;
        if (args[0].data != .text) return g.wrongKind("text", args[0]);
        const name = args[0].data.text;
        const chain = chainOf(run) orelse return boolean(g.gpa, false);
        if (!validName(name)) return boolean(g.gpa, false);
        var examined: u64 = 0;
        const found = lookupOffer(run, chain, name, &examined);
        m.fuel_extra = 4 * examined;
        return boolean(g.gpa, found != null);
    }

    /// A Limit Fault at an instruction: its `fault` record, naming the
    /// Script Variables the rollback changes back, then the Segment's
    /// bindings restored, its pending calls abandoned and its frames gone.
    /// Nothing of the instruction's charge is made.
    fn limitFault(g: *Group, run: *Run, limit: Fault, unit: []const u8, pc: u32, ins: lower.Instruction) Outcome {
        // A limit during a cancelled Run's cleanup ends the cleanup, and
        // rolls back its writes.
        if (run.cleanup_from != null) {
            // The Fuel a cleanup runs out of is its Cleanup Budget.
            g.write("cleanup-failed {s} limit={s}\n", .{ run.id, @tagName(if (limit == .fuel) .cleanup else limit) });
            run.cleanup_limit = @tagName(if (limit == .fuel) .cleanup else limit);
            g.restoreBase(run);
            run.cleanup_limited = true;
            return g.cleanupFailed(run);
        }
        run.end_at = .{ .unit = unit, .line = ins.position.line, .column = ins.position.column, .handler = run.handler, .pc = pc };
        if (g.trace) |w| {
            w.print("fault {s} limit={s} at={s}:{d} pos={d}:{d}", .{ run.id, @tagName(limit), unit, pc, ins.position.line, ins.position.column }) catch {};
            if (run.segment_base) |base| {
                var first = true;
                // Variables an extension added since the Segment began
                // aren't in its base.
                for (run.script.variables[0..base.len], base, run.script.variableNames()[0..base.len]) |v, b, name| {
                    if (v == b or (v.equal(b) catch false)) continue;
                    w.print("{s}{s}", .{ if (first) " rollback=[" else ", ", name }) catch {};
                    first = false;
                }
                if (!first) w.writeAll("]") catch {};
            }
            w.writeAll("\n") catch {};
        }
        g.restoreBase(run);
        // A suspension's wait goes with the Run.
        if (run.waiting) |p| {
            // A call or a send that waits for a reply is abandoned.
            if (run.join == null) {
                const call_id = if (p.call) |c| c.id else p.id;
                if (call_id.len > 0) g.write("abandon {s}\n", .{call_id});
            }
            for (g.pending.items, 0..) |x, i| if (x == p) {
                _ = g.pending.orderedRemove(i);
                break;
            };
            abandonCall(p);
            g.destroyPending(p);
            run.waiting = null;
        }
        g.abandonJoin(run);
        g.abandonUnwinding(run);
        while (run.frames.items.len > 0) g.popFrame(run);
        return .{ .faulted = limit };
    }

    /// Faults the current instruction on its own limit.
    fn faultOn(g: *Group, limit: Fault) error{LimitFault} {
        g.pending_fault = limit;
        return error.LimitFault;
    }

    const Step = union(enum) {
        next,
        returned: *Value,
        clause_failed,
        raised: *Value,
        catch_accept,
        catch_next,
        end_cleanup,
        /// A valid Recovery Offer choice, to transfer to.
        transfer: Transfer,
        /// A Guard gave something other than a boolean.
        guard_value: *Value,
        /// It suspended at a Suspension Point.
        suspended,
        /// It reached `pass`.
        passed,
        /// It reached `veto`, with its reason.
        vetoed: *Value,
        /// A Host function deferred (the Message Layer): rewind this
        /// instruction and pause the Pump at the crossing.
        crossing,
    };

    /// Pushes a value the frame takes; refused, the value is released.
    fn push(g: *Group, frame: *Frame, v: *Value) !void {
        frame.stack.append(g.gpa, .{ .value = v }) catch |e| {
            v.release();
            return e;
        };
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
        if (frame.restricted and restrictedOperation(frame, ins)) {
            m.restricted_refusal = true;
            // Match the ordinary failed-instruction stack shape. execute has
            // retained these operands for any pending cleanup continuation.
            const count = verify.popCount(unitOf(run, frame), ins).?;
            for (0..count) |_| frame.stack.pop().?.release(g.gpa);
            const name = machine_table.instruction[@backingInt(ins.op)].name;
            const v = try model.text(g.gpa, name);
            defer v.release();
            return g.raise("restricted operation", &.{.{ .key = "instruction", .value = v }});
        }
        const gpa = g.gpa;
        const a = g.scratch.allocator();
        const unit = unitOf(run, frame);
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
                // A write it can't pay for faults before it writes, so the
                // rollback doesn't see it.
                var none: costs.Measures = .{};
                if (run.base == 0 and run.clause_fuel + costs.chargeInstruction(.store_var, &none).fuel > fuelLeft(run)) return g.faultOn(.fuel);
                const s: usize = @intCast(ops[0].int);
                run.script.variables[s].release();
                run.script.variables[s] = pop(frame);
            },
            .load_definition => {
                const i = definitionIndex(unit, ops[0].text);
                try g.push(frame, definitionsOf(run, frame)[i].retain());
            },
            .store_definition => {
                const i = definitionIndex(unit, ops[0].text);
                definitionsOf(run, frame)[i].release();
                definitionsOf(run, frame)[i] = pop(frame);
            },
            // `me` is the owner; `the target` the object the message was
            // delivered to, or for a message to a Script, its owner.
            .me => try g.push(frame, if (run.script.owner) |o| o.value.retain() else try nothing(gpa)),
            .target => {
                const o = run.delivery.target orelse run.script.owner;
                try g.push(frame, if (o) |x| x.value.retain() else try nothing(gpa));
            },
            .pass => return .passed,
            .veto => {
                // A Run that holds no open Verdict just ends.
                if (!run.verdict) g.write("note {s} kind=no-verdict\n", .{run.id});
                return .{ .vetoed = pop(frame) };
            },
            .send_up, .send_up_wait => return g.send(run, frame, ins, m),
            .set_property, .set_property_computed => return g.setProperty(run, frame, ins, m),
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
            // Leaves its operand on both edges, unconverted.
            .branch_not_nothing => {
                const v = frame.stack.items[frame.stack.items.len - 1].value;
                if (v.data != .nothing) frame.pc = @intCast(ops[0].int);
            },
            .check_boolean => {
                const v = frame.stack.items[frame.stack.items.len - 1].value;
                if (v.data != .bool) return g.wrongKind("boolean", v);
            },
            .not => {
                const v = pop(frame);
                defer v.release();
                if (v.data != .bool) return g.wrongKind("boolean", v);
                const r = try boolean(gpa, !v.data.bool);
                m.result = r.retain();
                try g.push(frame, r);
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
                const r = try g.arithmetic(op, x, y);
                m.result = r.retain();
                try g.push(frame, r);
            },
            .power => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const r = try g.raisePower(x, y);
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
                const r = if (x.data == .text and y.data == .text)
                    model.concatTextValues(gpa, x, y) catch return error.OutOfMemory
                else
                    model.concatText(gpa, try chunks.textForm(a, x), try chunks.textForm(a, y)) catch return error.OutOfMemory;
                m.result = r.retain();
                try g.push(frame, r);
            },
            .range => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                const r = model.range(gpa, x, y) catch |e| return switch (e) {
                    error.IncompatibleUnits => g.arithmeticError(e, x, y),
                    else => g.wrongKind("number", if (x.data != .number and x.data != .quantity) x else y),
                };
                m.result = r.retain();
                try g.push(frame, r);
            },
            .equal, .not_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                var comparer = model.Comparer.initFolded(a, ops.len == 1);
                defer comparer.deinit();
                m.scanned = comparer.scanned(x, y) catch 0;
                const same = comparer.equal(x, y) catch false;
                try g.push(frame, try boolean(gpa, if (ins.op == .equal) same else !same));
            },
            .less, .greater, .less_or_equal, .greater_or_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                var comparer = model.Comparer.initFolded(a, ops.len == 1);
                defer comparer.deinit();
                m.scanned = comparer.scanned(x, y) catch 0;
                const order = comparer.order(x, y) catch {
                    return g.raise("can't compare", &.{ .{ .key = "left", .value = x }, .{ .key = "right", .value = y } });
                };
                const r = switch (ins.op) {
                    .less => order == .lt,
                    .greater => order == .gt,
                    .less_or_equal => order != .gt,
                    else => order != .lt,
                };
                try g.push(frame, try boolean(gpa, r));
            },
            .member => {
                // `x is in xs`: an element of the list equal to `x`, or
                // `a <= x and x <= b` over a range.
                const xs = pop(frame);
                defer xs.release();
                const x = pop(frame);
                defer x.release();
                m.input = xs.retain();
                const found = switch (xs.data) {
                    .list => |items| blk: {
                        var comparer = model.Comparer.initFolded(a, ops.len == 1);
                        defer comparer.deinit();
                        var scanned: u64 = 0;
                        for (items) |item| {
                            scanned +|= 1;
                            if (try comparer.equal(x, item)) {
                                m.scanned = scanned +| (comparer.selfScan(x) catch 0);
                                break :blk true;
                            }
                            scanned +|= comparer.scanned(x, item) catch 0;
                        }
                        m.scanned = scanned;
                        break :blk false;
                    },
                    .range => |r| blk: {
                        m.scanned = 2;
                        const low = x.order(r.from) catch return g.raise("can't compare", &.{ .{ .key = "left", .value = x }, .{ .key = "right", .value = r.from } });
                        const high = x.order(r.to) catch return g.raise("can't compare", &.{ .{ .key = "left", .value = x }, .{ .key = "right", .value = r.to } });
                        break :blk low != .lt and high != .gt;
                    },
                    else => return g.wrongKind("list", xs),
                };
                try g.push(frame, try boolean(gpa, found));
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
                const r = try boolean(gpa, empty);
                m.result = r.retain();
                try g.push(frame, r);
            },
            .is_kind => {
                const x = pop(frame);
                defer x.release();
                const want = ops[0].text;
                const is = if (std.mem.eql(u8, want, "integer"))
                    x.data == .number and (if (x.data.number.integer(i64)) |_| true else |_| false)
                else
                    std.mem.eql(u8, kindName(x), want);
                // An `operator`: its boolean is a new value.
                const r = try boolean(gpa, is);
                m.result = r.retain();
                try g.push(frame, r);
            },
            .convert, .can_convert => {
                const v = pop(frame);
                defer v.release();
                m.input = v.retain();
                const target = if (ops[0] == .unit_target) ops[0].unit_target.text else ops[0].text;
                const descriptor = if (ops[0] == .unit_target) &ops[0].unit_target.descriptor else null;
                const r = conversions.prepared(a, gpa, v, target, descriptor) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    else => null,
                };
                if (ins.op == .can_convert) {
                    if (r) |x| x.release();
                    try g.push(frame, try boolean(gpa, r != null));
                } else {
                    const out = r orelse {
                        const to = try model.text(gpa, target);
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
                // Its own limit: a program over the Text Pattern size
                // faults, uncharged.
                if (matcher.programSize(r) > run.script.limits.pattern_size) {
                    r.release();
                    return g.faultOn(.pattern);
                }
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
            .ask, .tell, .ask_wait => return g.operation(run, frame, ins, m),
            .join_ask => {
                try g.checkJoin(run);
                return g.operation(run, frame, ins, m);
            },
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
                if (run.scopes.items.len > 0) {
                    m.uncharged = true;
                    return g.refuseOpenScope(run);
                }
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
            .send, .send_wait, .send_named, .send_named_wait, .send_spread, .send_spread_wait => return g.send(run, frame, ins, m),
            .join_send, .join_send_named, .join_send_spread => {
                try g.checkJoin(run);
                return g.send(run, frame, ins, m);
            },
            // A Script named as a receiver is its name; Host Objects come
            // later.
            .load_object => {
                const v = if (run.script.object(ops[0].text)) |o| o.value.retain() else blk: {
                    const name = try model.text(gpa, ops[0].text);
                    name.script_name = true;
                    break :blk name;
                };
                try g.push(frame, v);
            },

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
                if (run.scopes.items.len > 0) {
                    m.uncharged = true;
                    return g.refuseOpenScope(run);
                }
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
                if (base.data == .object) {
                    // `id` is the Core's; in a Guard, nothing else reads.
                    if (std.mem.eql(u8, key, "id")) {
                        const id = try model.text(gpa, base.data.object.id);
                        try g.push(frame, id);
                        return .next;
                    }
                    if (g.guardEntry(run, frame.pc - 1) == null) if (g.objectOf(base)) |o| {
                        const step = try g.getProperty(run, frame, o, key, m);
                        if (step == .crossing) {
                            // Put the operands back, in their order.
                            if (key_value) |k| try g.push(frame, k.retain());
                            try g.push(frame, base.retain());
                        }
                        return step;
                    };
                }
                if (base.data != .map) return g.wrongKind("map", base);
                const v = base.get(key) orelse try nothing(gpa);
                try g.push(frame, if (base.get(key)) |found| found.retain() else v);
            },
            // A map-only read: Nothing reads as Nothing, and every Host
            // Object, even for `id`, is a wrong kind with no Host call.
            .get_optional_key, .get_optional_key_computed => {
                const base = pop(frame);
                defer base.release();
                var key: []const u8 = undefined;
                var key_value: ?*Value = null;
                defer if (key_value) |k| k.release();
                if (ins.op == .get_optional_key) key = try keyOperand(a, ops[0].text) else {
                    key_value = pop(frame);
                    if (key_value.?.data != .text) return g.wrongKind("text", key_value.?);
                    key = key_value.?.data.text;
                }
                switch (base.data) {
                    .nothing => try g.push(frame, base.retain()),
                    .map => try g.push(frame, if (base.get(key)) |found| found.retain() else try nothing(gpa)),
                    else => return g.wrongKind("map", base),
                }
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
                try g.push(frame, model.mapDelete(gpa, base, key) catch return error.OutOfMemory);
            },
            .append, .prepend, .append_all, .prepend_all => {
                const v = pop(frame);
                defer v.release();
                const whole = pop(frame);
                defer whole.release();
                const after = ins.op == .append or ins.op == .append_all;
                const r: *Value = switch (whole.data) {
                    .list => blk: {
                        if (ins.op == .append_all or ins.op == .prepend_all) {
                            if (v.data != .list) return g.wrongKind("list", v);
                            break :blk model.listGrow(gpa, whole, v.data.list, after) catch return error.OutOfMemory;
                        }
                        break :blk model.listGrow(gpa, whole, &.{v}, after) catch return error.OutOfMemory;
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
                if (ins.op == .list_extend and v.data != .list) return g.wrongKind("list", v);
                const items = if (ins.op == .list_extend) v.data.list else &.{v};
                const r = model.listGrow(gpa, l, items, true) catch return error.OutOfMemory;
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
                try g.callFunction(run, frame.library, body, args);
            },
            .make_closure => {
                // A Lambda: its captures by name, in slot order.
                const body: u32 = @intCast(ops[0].int);
                const n: usize = @intCast(ops[1].int);
                const names = unit.bodies[body].capture_names;
                const pairs = try a.alloc(model.Pair, n);
                var i = n;
                while (i > 0) {
                    i -= 1;
                    pairs[i] = .{ .key = names[i], .value = pop(frame) };
                }
                defer for (pairs) |p| p.value.release();
                const captures = try model.map(gpa, pairs);
                defer captures.release();
                const where = try std.fmt.allocPrint(a, "{d}:{d}", .{ ins.position.line, ins.position.column });
                const v = try g.functionValue(run, frame.library, body, where, captures);
                m.count = n;
                m.result = v.retain();
                try g.push(frame, v);
            },
            .make_function, .make_imported_function => {
                // A named function's bare name: the unit's own, or an
                // imported one, `<library>:<name>`.
                var library = frame.library;
                var body: u32 = undefined;
                var name: []const u8 = undefined;
                if (ins.op == .make_function) {
                    body = @intCast(ops[0].int);
                    name = unit.bodies[body].name;
                } else {
                    const colon = std.mem.lastIndexOfScalar(u8, ops[0].text, ':').?;
                    library = (importPlace(run, frame, ops[0].text[0..colon]) orelse return g.raise("not implemented", &.{})).library;
                    name = ops[0].text[colon + 1 ..];
                    body = functionIn(run.script.unitIn(library), name) orelse return g.raise("not implemented", &.{});
                }
                const captures = try model.map(gpa, &.{});
                defer captures.release();
                const v = try g.functionValue(run, library, body, name, captures);
                m.result = v.retain();
                try g.push(frame, v);
            },
            .call_value, .call_restricted, .call_value_wait => return g.callValue(run, frame, ins),
            .call_import => {
                // `<library>:<name>`: a function of a Library the unit
                // imports, run in the caller's Run.
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                const colon = std.mem.lastIndexOfScalar(u8, ops[0].text, ':').?;
                const library = (importPlace(run, frame, ops[0].text[0..colon]) orelse return g.raise("not implemented", &.{})).library;
                const body = functionIn(run.script.unitIn(library), ops[0].text[colon + 1 ..]) orelse return g.raise("not implemented", &.{});
                try g.callFunction(run, library, body, args);
            },
            .call_handler, .call_handler_wait => {
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                // The unit's own Handler, or one of its Script's other units',
                // or else one it imports.
                const name = ops[0].text;
                var library: ?*Library = frame.library;
                const own = for (unit.bodies) |b| {
                    if (b.kind == .handler and std.mem.eql(u8, b.name, name)) break true;
                } else false;
                const script_code = if (frame.library) |l| l.extension > 0 else true;
                if (!own) library = if (script_code and run.script.handlerUnit(name, .handler) != null) run.script.handlerUnit(name, .handler).?.library else for (importsOf(run, frame)) |l| {
                    if (l.handler(name)) break l;
                } else return g.raise("no match", &.{});
                if (!try g.nextClause(run, library, name, 0, args)) return g.raise("no match", &.{});
            },
            .call_builtin => {
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                // The Core holds an object's kind and whether it is disposed.
                // A Function Value's arity and name are in its code.
                if (std.mem.eql(u8, ops[0].text, "functionArity") or std.mem.eql(u8, ops[0].text, "functionName")) {
                    m.builtin = ops[0].text;
                    m.args = args;
                    if (args[0].data != .function) return g.wrongKind("function", args[0]);
                    // A stale value still answers both.
                    const code = g.codeOf(args[0]) orelse return g.raise("function gone", &.{});
                    const r = if (std.mem.eql(u8, ops[0].text, "functionName"))
                        (if (code.name.len == 0) try nothing(gpa) else try model.text(gpa, code.name))
                    else blk: {
                        const low = try chunks.numberValue(gpa, @intCast(code.required));
                        defer low.release();
                        const high = try chunks.numberValue(gpa, @intCast(code.total));
                        defer high.release();
                        break :blk try model.range(gpa, low, high);
                    };
                    m.result = r.retain();
                    try g.push(frame, r);
                    return .next;
                }
                const object_builtin = std.mem.eql(u8, ops[0].text, "isDisposed") or std.mem.eql(u8, ops[0].text, "objectKind");
                if (object_builtin) {
                    m.builtin = ops[0].text;
                    m.args = args;
                    if (args[0].data != .object) return g.wrongKind("object", args[0]);
                    const o = g.objectOf(args[0]);
                    const r = if (std.mem.eql(u8, ops[0].text, "isDisposed"))
                        try boolean(gpa, if (o) |x| x.disposed else false)
                    else
                        try model.text(gpa, args[0].data.object.kind);
                    m.builtin = ops[0].text;
                    m.args = args;
                    m.result = r.retain();
                    try g.push(frame, r);
                    return .next;
                }
                if (std.mem.eql(u8, ops[0].text, "offerAvailable")) {
                    const r = try g.offerAvailable(run, args, m);
                    m.result = r.retain();
                    try g.push(frame, r);
                    return .next;
                }
                var raised: builtins.Raised = .{};
                // A Built-in that raises still pays its rate.
                m.builtin = ops[0].text;
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
                var comparer = model.Comparer.initFolded(a, fold);
                defer comparer.deinit();
                m.scanned = comparer.scanned(v, c) catch 0;
                if (!(try comparer.equal(v, c))) frame.pc = @intCast(ops[ops.len - 1].int);
            },
            .test_equal => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                var comparer = model.Comparer.init(a);
                defer comparer.deinit();
                m.scanned = comparer.scanned(x, y) catch 0;
                if (!(comparer.equal(x, y) catch false)) frame.pc = @intCast(ops[0].int);
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
            .choose_offer => {
                const n: usize = @intCast(ops[1].int);
                const args = try g.gpa.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                return g.chooseOffer(run, ops[0].text, args, frame.pc - 1, ins, m);
            },
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
        const unit = unitOf(run, frame);
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

    /// `+` and `-` with a date (chapter 3, Date arithmetic): an exact
    /// duration in whole nanoseconds, or a calendar one in whole months, or
    /// the difference of two dates of one kind.
    fn dateArithmetic(g: *Group, subtract: bool, x: *Value, y: *Value) !*Value {
        const gpa = g.gpa;
        const a = g.scratch.allocator();
        const x_date = x.data == .instant or x.data == .civil_date;
        if (!x_date) return g.wrongKind(kindName(x), y);
        const date_only = x.data == .civil_date and !x.data.civil_date.has_time;
        switch (y.data) {
            .quantity => |q| {
                const second = units.Unit.parse("s") catch unreachable;
                const month = units.Unit.parse("month") catch unreachable;
                const takes = if (date_only) "day" else "s";
                if (q.unit.compatible(&month) and x.data == .civil_date) {
                    const months = q.unit.toBase(a, q.number) catch return error.OutOfMemory;
                    const n = months.integer(i64) catch return g.incompatible("month", q.unit);
                    return g.addMonths(x, if (subtract) -n else n);
                }
                if (!q.unit.compatible(&second)) return g.incompatible(takes, q.unit);
                var ns = waitMillis(y).?;
                if (subtract) ns = -ns;
                switch (x.data) {
                    .instant => |t| {
                        const total = @as(i128, t.seconds) * std.time.ns_per_s + t.nanos + ns;
                        const out: model.dates.Instant = .{ .seconds = @intCast(@divFloor(total, std.time.ns_per_s)), .nanos = @intCast(@mod(total, std.time.ns_per_s)) };
                        model.dates.validateInstant(out) catch return g.dateOutOfRange(@divFloor(total, std.time.ns_per_s));
                        return model.scalar(gpa, .{ .instant = out });
                    },
                    else => {
                        const f = x.data.civil_date;
                        if (date_only and @mod(ns, std.time.ns_per_day) != 0) return g.incompatible("day", q.unit);
                        const total = @as(i128, model.dates.seconds(f)) * std.time.ns_per_s + f.nanosecond + ns;
                        if (total < -62135596800 * @as(i128, std.time.ns_per_s) or total >= 253402300800 * @as(i128, std.time.ns_per_s)) return g.dateOutOfRange(@divFloor(total, std.time.ns_per_s));
                        var out = model.dates.fields(.{ .seconds = @intCast(@divFloor(total, std.time.ns_per_s)), .nanos = @intCast(@mod(total, std.time.ns_per_s)) });
                        out.has_time = f.has_time;
                        return model.scalar(gpa, .{ .civil_date = out });
                    },
                }
            },
            .instant, .civil_date => {
                const same = std.meta.activeTag(x.data) == std.meta.activeTag(y.data) and (x.data != .civil_date or x.data.civil_date.has_time == y.data.civil_date.has_time);
                if (!subtract) return g.wrongKind("quantity", y);
                if (!same) return g.wrongKind(kindName(x), y);
                if (date_only) {
                    const days = @divFloor(model.dates.seconds(x.data.civil_date) - model.dates.seconds(y.data.civil_date), 86400);
                    return model.scalar(gpa, .{ .quantity = .{ .number = model.Decimal.fromInt(days), .unit = units.Unit.parse("day") catch unreachable } });
                }
                const ns = instantNanos(x) - instantNanos(y);
                // Exact, with no more places than it needs.
                var n: model.Decimal = .{ .coefficient = @intCast(@abs(ns)), .exponent = -9, .negative = ns < 0 };
                while (n.exponent < 0 and n.coefficient % 10 == 0) {
                    n.coefficient /= 10;
                    n.exponent += 1;
                }
                if (n.coefficient == 0) n.exponent = 0;
                return model.scalar(gpa, .{ .quantity = .{ .number = n, .unit = units.Unit.parse("s") catch unreachable } });
            },
            else => return g.wrongKind(if (subtract) kindName(x) else "quantity", y),
        }
    }

    fn instantNanos(v: *const Value) i128 {
        return switch (v.data) {
            .instant => |t| @as(i128, t.seconds) * std.time.ns_per_s + t.nanos,
            else => @as(i128, model.dates.seconds(v.data.civil_date)) * std.time.ns_per_s + v.data.civil_date.nanosecond,
        };
    }

    /// A Civil Date moved by whole months, its day clamped to the month's
    /// last, its time kept.
    fn addMonths(g: *Group, x: *Value, months: i64) !*Value {
        var f = x.data.civil_date;
        const index = @as(i64, f.year) * 12 + (f.month - 1) + months;
        const year = @divFloor(index, 12);
        if (year < 1 or year > 9999) return g.yearOutOfRange(year);
        f.year = @intCast(year);
        f.month = @intCast(@mod(index, 12) + 1);
        while (true) {
            model.dates.validate(f) catch {
                f.day -= 1;
                continue;
            };
            break;
        }
        return model.scalar(g.gpa, .{ .civil_date = f });
    }

    fn incompatible(g: *Group, left: []const u8, right: units.Unit) error{ Raised, OutOfMemory } {
        const l = model.text(g.gpa, left) catch return error.OutOfMemory;
        defer l.release();
        const r = model.text(g.gpa, right.string(g.scratch.allocator(), false) catch return error.OutOfMemory) catch return error.OutOfMemory;
        defer r.release();
        return g.raise("incompatible units", &.{ .{ .key = "left", .value = l }, .{ .key = "right", .value = r } });
    }

    /// `out of range` for a date at `seconds` since the epoch, with the
    /// year it would have.
    fn dateOutOfRange(g: *Group, seconds: i128) error{ Raised, OutOfMemory } {
        return g.yearOutOfRange(builtins.yearOf(@intCast(seconds)));
    }

    fn yearOutOfRange(g: *Group, year: i64) error{ Raised, OutOfMemory } {
        const field = model.text(g.gpa, "year") catch return error.OutOfMemory;
        defer field.release();
        const value = chunks.numberValue(g.gpa, year) catch return error.OutOfMemory;
        defer value.release();
        return g.raise("out of range", &.{ .{ .key = "field", .value = field }, .{ .key = "value", .value = value } });
    }

    /// `a ^ b`: an exact power for an integer `b`, else `power(a, b)`'s
    /// result and domain; a Quantity takes only a positive integer.
    fn raisePower(g: *Group, x: *Value, y: *Value) !*Value {
        const gpa = g.gpa;
        const a = g.scratch.allocator();
        if (y.data == .quantity) return g.wrongKind("number", y);
        if (y.data != .number) return g.wrongKind("number", y);
        const overflow = struct {
            fn raise(gr: *Group) error{ Raised, OutOfMemory } {
                const op = model.text(gr.gpa, "^") catch return error.OutOfMemory;
                defer op.release();
                return gr.raise("overflow", &.{.{ .key = "operator", .value = op }});
            }
        }.raise;
        switch (x.data) {
            .number => |n| {
                const r = model.decimal.power(a, n, y.data.number) catch |e| return switch (e) {
                    error.OutOfDomain => blk: {
                        const function = model.text(gpa, "power") catch return error.OutOfMemory;
                        defer function.release();
                        break :blk g.raise("out of domain", &.{ .{ .key = "function", .value = function }, .{ .key = "value", .value = x } });
                    },
                    error.DivisionByZero => g.raise("division by zero", &.{}),
                    error.Overflow => overflow(g),
                    error.OutOfMemory => error.OutOfMemory,
                    else => g.wrongKind("number", x),
                };
                return model.scalar(gpa, .{ .number = r });
            },
            .quantity => |q| {
                const n = y.data.number.integer(i64) catch return g.wrongKind("integer", y);
                if (n < 1) return g.wrongKind("integer", y);
                var unit = q.unit;
                var i: i64 = 1;
                while (i < n) : (i += 1) unit = units.Unit.combine(&unit, &q.unit, false) catch return g.incompatible(q.unit.string(a, false) catch return error.OutOfMemory, units.Unit.parse("1") catch q.unit);
                const r = model.decimal.power(a, q.number, y.data.number) catch |e| return switch (e) {
                    error.Overflow => overflow(g),
                    error.OutOfMemory => error.OutOfMemory,
                    else => g.wrongKind("number", x),
                };
                return model.scalar(gpa, .{ .quantity = .{ .number = r, .unit = unit } });
            },
            else => return g.wrongKind("number", x),
        }
    }

    fn raiseBuiltin(g: *Group, raised: builtins.Raised) error{ Raised, OutOfMemory } {
        defer for (raised.fields[0..raised.len]) |f| f.value.release();
        return g.raise(raised.code, raised.fields[0..raised.len]);
    }

    /// `x op y` for the arithmetic operators, dates included (chapter 4).
    /// An error is raised into `pending_error`, so `Add` uses it outside
    /// any Run too.
    pub fn arithmetic(g: *Group, op: model.decimal.Operator, x: *Value, y: *Value) !*Value {
        const dated = x.data == .instant or x.data == .civil_date or y.data == .instant or y.data == .civil_date;
        if (dated and (op == .add or op == .subtract)) return g.dateArithmetic(op == .subtract, x, y);
        return model.arithmetic(g.gpa, op, x, y) catch |e| return g.arithmeticError(e, x, y);
    }

    fn arithmeticError(g: *Group, e: model.Error, x: *Value, y: *Value) error{ Raised, OutOfMemory } {
        return switch (e) {
            error.DivisionByZero => g.raise("division by zero", &.{}),
            error.IncompatibleUnits => blk: {
                // `left` and `right` are the two Units.
                if (x.data == .quantity and y.data == .quantity) {
                    const a = g.scratch.allocator();
                    const left = model.text(g.gpa, x.data.quantity.unit.string(a, false) catch return error.OutOfMemory) catch return error.OutOfMemory;
                    defer left.release();
                    const right = model.text(g.gpa, y.data.quantity.unit.string(a, false) catch return error.OutOfMemory) catch return error.OutOfMemory;
                    defer right.release();
                    break :blk g.raise("incompatible units", &.{ .{ .key = "left", .value = left }, .{ .key = "right", .value = right } });
                }
                break :blk g.raise("incompatible units", &.{});
            },
            error.Overflow => g.raise("overflow", &.{}),
            error.OutOfMemory => error.OutOfMemory,
            // A Quantity takes a Quantity: a plain number added to one is
            // the wrong kind for it.
            else => if (x.data == .quantity and y.data == .number) g.wrongKind("quantity", y) else g.wrongKind("number", if (x.data != .number and x.data != .quantity) x else y),
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
        if (granted.disabled) {
            m.uncharged = true;
            return g.raise("capability disabled", &where);
        }
        if (granted.revoked) {
            m.uncharged = true;
            return g.raise("capability revoked", &where);
        }

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
                .invalid_key => return g.raise("invalid key", &.{}),
                .mismatch => |x| {
                    defer if (x.keep) |v| v.release();
                    return g.raiseMismatch(x.bad, x.position, &where);
                },
                .out_of_range => |x| {
                    const field = try model.text(gpa, x.field);
                    defer field.release();
                    return g.raise("out of range", &.{ .{ .key = "field", .value = field }, .{ .key = "value", .value = x.value } });
                },
                .invalid_watch => |which| {
                    const field = try model.text(gpa, which);
                    defer field.release();
                    return g.raise("invalid watch", &.{.{ .key = "field", .value = field }});
                },
            }
        };
        // The scope checks, charged nothing either.
        if (decl.mode == .suspending and run.scopes.items.len > 0) {
            m.uncharged = true;
            return g.refuseOpenScope(run);
        }
        if (if (run.returned_op == null) decl.scope.name() else null) |scope_name| {
            const occupied = g.scopeSlot(run, granted, scope_name) != null;
            const refusal: ?[]const u8 = switch (decl.scope) {
                .opens => if (run.join != null) "scope in join" else if (occupied) "scope already open" else null,
                .closes => if (occupied) null else "scope not open",
                .none => unreachable,
            };
            if (refusal) |code| {
                m.uncharged = true;
                const scope = try model.text(gpa, scope_name);
                defer scope.release();
                return g.raise(code, &.{ where[0], where[1], .{ .key = "scope", .value = scope } });
            }
        }
        if (decl.segment_bound and run.returned_op == null) {
            m.uncharged = true;
            try g.participantConflict(run, granted, &where);
            m.uncharged = false;
            // A failed begin leaves the call's declared cost spent.
            m.declared = decl.cost.fuel;
            m.alloc_extra = decl.cost.alloc;
            g.enroll(run, granted, &where) catch |err| {
                if (err != error.Deferred) return err;
                // The instruction is made again once the Host answers.
                for (args) |v| try g.push(frame, v.retain());
                return .crossing;
            };
        }

        // A Run that can't cover the declared cost faults before the Host
        // is called.
        // The call's charge before its result: its rate with the declared
        // cost, and dispatch's `clause` rate when it is the first
        // instruction.
        m.declared = decl.cost.fuel;
        m.alloc_extra = decl.cost.alloc;
        const before = costs.chargeInstruction(ins.op, m);
        if (run.base == 0 and before.fuel + run.clause_fuel > fuelLeft(run)) return g.faultOn(.fuel);
        if (run.base == 0 and (run.alloc + before.alloc > run.limits.alloc_per_run)) return g.faultOn(.alloc);
        run.calls += 1;
        const id = try std.fmt.allocPrint(a, "{s}.c{d}", .{ run.id, run.calls });
        const left: ?u64 = fuelLeft(run) -| (if (decl.metering != null) before.fuel + run.clause_fuel else decl.cost.fuel);
        var local: capabilities.Call = .{ .id = id, .script = run.script.name, .grant = grant_name, .binding = granted.grant.binding, .now = g.clock, .left = left, .gpa = g.gpa, .owner = g, .run = run.id, .segment = g.segmentId(run), .scope = decl.scope.name() orelse "", .request_eligible = decl.mode == .suspending and decl.metering == .read_only, .at_unit = unitName(run, frame), .at_pc = frame.pc - 1, .at_line = ins.position.line, .at_column = ins.position.column };
        // A suspending call outlives the instruction: the Host answers it
        // later, through the Group.
        const suspending = decl.mode == .suspending;
        const call: *capabilities.Call = if (suspending) blk: {
            if (g.starting_call) |c| {
                std.debug.assert(std.mem.eql(u8, c.id, id));
                g.starting_call = null;
                break :blk c;
            }
            const c = try gpa.create(capabilities.Call);
            c.* = local;
            c.id = gpa.dupe(u8, id) catch |err| {
                gpa.destroy(c);
                return err;
            };
            c.group = g;
            c.at_unit = try g.keep.allocator().dupe(u8, local.at_unit);
            g.calls.append(gpa, c) catch |err| {
                gpa.free(c.id);
                gpa.destroy(c);
                return err;
            };
            // Its arguments, for the answer's check and for a save, which
            // a restore may reissue it with.
            c.args = try gpa.dupe(*Value, args);
            for (c.args) |v| _ = v.retain();
            break :blk c;
        } else &local;
        try g.registerCall(id, suspending and decl.metering == .read_only);
        const returned = run.returned_op;
        run.returned_op = null;
        const outcome = if (returned) |r| blk: {
            call.charged = r.charged;
            break :blk r.outcome;
        } else blk: {
            const held = g.holdTrace();
            const result = decl.host.call(decl.host.context, call, args);
            g.flushChargeRefusals();
            g.trace = held;
            break :blk result;
        };
        if (outcome == .deferred) {
            // The same instruction will be made again, but the Host can
            // already answer or request a charge against its issued id.
            run.calls -= 1;
            if (suspending) g.starting_call = call;
            for (args) |v| try g.push(frame, v.retain());
            return .crossing;
        }
        call.starting = false;
        m.reached_host = true;
        m.declared = decl.cost.fuel;
        m.fuel_extra = call.charged;
        m.alloc_extra = decl.cost.alloc;
        // The record: `call <id> op=<grant>.<op> args=[…]`, then the result
        // or error, and `charged`.
        const record = struct {
            fn write(gr: *Group, call_id: []const u8, grant: []const u8, operation_name: []const u8, values: []const *Value, key: []const u8, shown: ?*const Value, charged: u64, refused: bool) void {
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
                if (refused) w.writeAll(" charge-refused=yes") catch {};
                w.writeAll("\n") catch {};
            }
        }.write;
        const empty = try model.map(gpa, &.{});
        defer empty.release();
        if (call.charge_refused or outcome == .limited) {
            switch (outcome) {
                .value => |v| v.release(),
                .failed => |f| {
                    gpa.free(f.code);
                    if (f.message) |t| gpa.free(t);
                    if (f.data) |d| d.release();
                },
                else => {},
            }
            record(g, id, grant_name, op_name, args, "", null, call.charged, decl.metering != null);
            const spent = costs.chargeInstruction(ins.op, m);
            run.fuel += spent.fuel + run.clause_fuel;
            run.clause_fuel = 0;
            run.alloc += spent.alloc;
            return g.faultOn(.fuel);
        }
        var owned = true;
        defer if (owned) g.releaseHostOutcome(outcome);
        var valid = if (returned) |r| r.valid else true;
        const pending = suspending and (outcome == .value or outcome == .started);
        if (returned == null) {
            switch (outcome) {
                .value => |v| {
                    if (pending or decl.mode == .fire_and_forget) {
                        record(g, id, grant_name, op_name, args, "", null, call.charged, false);
                    } else {
                        if (decl.result) |shape| {
                            const checked = try capabilities.checkValue(a, gpa, shape, v);
                            defer checked.release();
                            valid = checked.mismatch == null;
                        }
                        if (valid) if (decl.after) |after| {
                            valid = after(&granted.grant.capability.operations[index], args, v);
                        };
                        record(g, id, grant_name, op_name, args, if (valid) "result" else "error", if (valid) v else empty, call.charged, false);
                        try g.acknowledge(run, granted, decl.scope, id);
                    }
                },
                .started => record(g, id, grant_name, op_name, args, if (pending) "" else "error", if (pending) null else empty, call.charged, false),
                .failed => |f| {
                    const malformed_data = if (f.data) |d| d.data != .map and d.data != .nothing else false;
                    const shown = if (malformed_data) null else failureMap(gpa, .{ .code = f.code, .message = f.message, .data = f.data }) catch null;
                    defer if (shown) |v| v.release();
                    valid = shown != null;
                    record(g, id, grant_name, op_name, args, "error", shown orelse empty, call.charged, false);
                },
                .broken => record(g, id, grant_name, op_name, args, "error", empty, call.charged, false),
                .deferred, .limited => unreachable,
            }
            // Install a started Call before landing so interruption can
            // abandon it, without committing the Segment first.
            if (pending) {
                const after_ms = if (decl.max_pending_ms > 0) decl.max_pending_ms else run.limits.max_wait_ms;
                const wait: Pending = .{ .run = run, .deadline = nanos(g.clock) + @as(i128, after_ms) * std.time.ns_per_ms, .order = 0, .call = call, .grant = grant_name, .operation = op_name, .decl = &granted.grant.capability.operations[index], .after_ms = after_ms };
                if (ins.op == .join_ask) try g.startMember(run, wait) else try g.suspendRun(run, "ask-wait", wait);
            }
        }
        if (returned != null) g.answering_crossing = false;
        if (returned == null and g.observe_crossings) g.trace_pause = true;
        const interrupted = g.landedAt(run) catch |err| {
            if (err != error.Deferred) return err;
            run.returned_op = .{ .outcome = outcome, .charged = call.charged, .valid = valid };
            owned = false;
            run.calls -= 1;
            if (suspending) g.starting_call = call;
            for (args) |v| try g.push(frame, v.retain());
            return .crossing;
        };
        if (interrupted) return error.Landed;
        if (pending) return if (ins.op == .join_ask) .next else .suspended;
        if (!valid) return g.hostError(id, grant_name, op_name, &where);
        switch (outcome) {
            .value => |v| {
                if (decl.mode == .fire_and_forget) return .next;
                m.result = v.retain();
                try g.push(frame, v);
                owned = false;
            },
            .failed => |f| {
                if (!capabilities.validFailure(decl, f.code, f.data)) return g.hostError(id, grant_name, op_name, &where);
                const shown = try failureMap(gpa, .{ .code = f.code, .message = f.message, .data = f.data });
                defer shown.release();
                var pairs: std.ArrayList(model.Pair) = .empty;
                defer pairs.deinit(gpa);
                try shown.data.map.appendTo(gpa, &pairs);
                try pairs.appendSlice(gpa, &where);
                m.result = if (f.data) |d| d.retain() else empty.retain();
                g.pending_error = try model.map(gpa, pairs.items);
                g.pending_core = false;
                return error.Raised;
            },
            .started, .broken => return g.hostError(id, grant_name, op_name, &where),
            .deferred, .limited => unreachable,
        }
        return .next;
    }

    fn releaseHostOutcome(g: *Group, outcome: capabilities.Outcome) void {
        switch (outcome) {
            .value => |v| v.release(),
            .failed => |f| {
                g.gpa.free(f.code);
                if (f.message) |m| g.gpa.free(m);
                if (f.data) |d| d.release();
            },
            else => {},
        }
    }

    /// The slot a Run occupies through the named Grant for a scope, by
    /// index.
    fn scopeSlot(g: *Group, run: *const Run, granted: *const ScriptGrant, name: []const u8) ?usize {
        _ = g;
        for (run.scopes.items, 0..) |slot, i| if (slot.grant == granted and std.mem.eql(u8, slot.name, name)) return i;
        return null;
    }

    /// A Host return acknowledges a lifecycle Operation's opening or
    /// closing at once, before its result is converted, with a `scope`
    /// record.
    fn acknowledge(g: *Group, run: *Run, granted: *ScriptGrant, scope: capabilities.Scope, id: []const u8) !void {
        const action = switch (scope) {
            .none => return,
            .opens => |o| blk: {
                try run.scopes.append(g.gpa, .{ .grant = granted, .name = o.name, .abandon = granted.grant.capability.find(o.abandon).? });
                break :blk "opened";
            },
            .closes => |n| blk: {
                _ = run.scopes.orderedRemove(g.scopeSlot(run, granted, n).?);
                break :blk "closed";
            },
        };
        if (g.trace) |w| w.print("scope {s} grant={s} name={s} action={s}\n", .{ id, granted.name, scope.name().?, action }) catch {};
    }

    /// `the k of o` on a Host Object: its Kind's Get, with a `prop` record,
    /// charged as an immediate Operation's result is. A key the kind
    /// doesn't define reads as Nothing.
    fn getProperty(g: *Group, run: *Run, frame: *Frame, o: *objects.Object, key: []const u8, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        if (o.disposed) return g.raise("object gone", &.{.{ .key = "object", .value = o.value }});
        const prop = o.kind.prop(key) orelse {
            try g.push(frame, try nothing(gpa));
            return .next;
        };
        const returned = run.returned_prop;
        run.returned_prop = null;
        const outcome = if (returned) |r| r else blk: {
            const held = g.holdTrace();
            const result = prop.get.call(prop.get.context, gpa, o);
            g.flushChargeRefusals();
            g.trace = held;
            break :blk result;
        };
        if (outcome == .deferred) return .crossing;
        var owned = true;
        defer if (owned) g.releasePropResult(outcome);
        m.fuel_extra = prop.get_cost.fuel;
        m.alloc_extra = prop.get_cost.alloc;
        var valid = true;
        if (outcome == .value) {
            const checked = try capabilities.checkValue(g.scratch.allocator(), gpa, prop.shape, outcome.value);
            defer checked.release();
            valid = checked.mismatch == null;
        }
        if (returned == null) try g.recordPropertyReturn(run, o, key, "get", outcome, valid, null);
        const interrupted = g.landedAt(run) catch |err| {
            if (err != error.Deferred) return err;
            run.returned_prop = outcome;
            owned = false;
            return .crossing;
        };
        if (interrupted) return error.Landed;
        if (!valid) return g.propError(run, o, key);
        switch (outcome) {
            .value => |v| {
                const size = costs.size(v);
                m.fuel_extra += (size + 31) / 32;
                m.alloc_extra += size;
                try g.push(frame, v);
                owned = false;
                return .next;
            },
            .failed => |f| {
                owned = false;
                return g.propFailed(run, o, key, .{ .code = f.code, .message = f.message, .data = f.data }, m);
            },
            else => return g.propError(run, o, key),
        }
    }

    fn recordPropertyReturn(g: *Group, run: *Run, o: *objects.Object, key: []const u8, op: []const u8, result: objects.Result, valid: bool, input: ?*Value) !void {
        switch (result) {
            .value, .done => g.propRecord(run, o, key, op, if (valid and (input != null or result == .value)) "value" else "error", if (!valid) null else input orelse if (result == .value) result.value else null, null),
            .failed => |f| {
                const malformed_data = if (f.data) |d| d.data != .map and d.data != .nothing else false;
                const shown = if (malformed_data) null else failureMap(g.gpa, .{ .code = f.code, .message = f.message, .data = f.data }) catch null;
                defer if (shown) |v| v.release();
                g.propRecord(run, o, key, op, "error", shown, input);
            },
            else => g.propRecord(run, o, key, op, "error", null, input),
        }
    }

    /// A property's failure, which it takes: recorded with its code,
    /// message and Data, and raised as an Operation's is, with `capability`
    /// the Object Kind and `operation` the property. One that isn't well
    /// formed is `host error`.
    fn propFailed(g: *Group, run: *Run, o: *objects.Object, key: []const u8, f: Failure, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        defer gpa.free(f.code);
        defer if (f.message) |t| gpa.free(t);
        defer if (f.data) |d| d.release();
        const shown = failureMap(gpa, f) catch return g.propError(run, o, key);
        defer shown.release();
        if (!capabilities.validPropFailure(f.code, f.data)) return g.propError(run, o, key);
        // Its Data is converted as a value read is, an empty map when it
        // has none.
        const empty = try model.map(gpa, &.{});
        defer empty.release();
        const size = costs.size(f.data orelse empty);
        m.fuel_extra += (size + 31) / 32;
        m.alloc_extra += size;
        const capability = try model.text(gpa, o.kind.name);
        defer capability.release();
        const operation_name = try model.text(gpa, key);
        defer operation_name.release();
        var pairs: std.ArrayList(model.Pair) = .empty;
        defer pairs.deinit(gpa);
        try shown.data.map.appendTo(gpa, &pairs);
        try pairs.appendSlice(gpa, &.{ .{ .key = "capability", .value = capability }, .{ .key = "operation", .value = operation_name } });
        g.pending_error = try model.map(gpa, pairs.items);
        g.pending_core = false;
        return error.Raised;
    }

    /// `set the k of o to e`: the value is checked against the property's
    /// Shape before its Kind's Set runs.
    fn setProperty(g: *Group, run: *Run, frame: *Frame, ins: lower.Instruction, m: *costs.Measures) !Step {
        const gpa = g.gpa;
        const value = pop(frame);
        defer value.release();
        const base = pop(frame);
        defer base.release();
        var key_value: ?*Value = null;
        defer if (key_value) |k| k.release();
        var key: []const u8 = undefined;
        if (ins.op == .set_property) key = try keyOperand(g.scratch.allocator(), ins.operands[0].text) else {
            key_value = pop(frame);
            if (key_value.?.data != .text) return g.wrongKind("text", key_value.?);
            key = key_value.?.data.text;
        }
        const o = g.objectOf(base) orelse return g.wrongKind("object", base);
        // A disposed object or a read-only property pays only the
        // instruction's rate; a value that breaks the Shape, nothing.
        if (o.disposed) return g.raise("object gone", &.{.{ .key = "object", .value = o.value }});
        const prop = o.kind.prop(key) orelse return g.raise("read only", &.{});
        const set = prop.set orelse return g.raise("read only", &.{});
        const checked = try capabilities.checkValue(g.scratch.allocator(), gpa, prop.shape, value);
        defer checked.release();
        if (checked.mismatch) |bad| {
            m.uncharged = true;
            return g.raiseMismatchAt(bad);
        }
        m.input = value.retain();
        const returned = run.returned_prop;
        run.returned_prop = null;
        const outcome = if (returned) |r| r else blk: {
            const held = g.holdTrace();
            const result = set.call(set.context, gpa, o, value);
            g.flushChargeRefusals();
            g.trace = held;
            break :blk result;
        };
        var owned = true;
        defer if (owned) g.releasePropResult(outcome);
        m.fuel_extra = prop.set_cost.fuel;
        m.alloc_extra = prop.set_cost.alloc;
        if (outcome != .deferred and returned == null) try g.recordPropertyReturn(run, o, key, "set", outcome, true, value);
        const interrupted = if (outcome == .deferred) null else g.landedAt(run) catch |err| blk: {
            if (err != error.Deferred) return err;
            run.returned_prop = outcome;
            owned = false;
            break :blk null;
        };
        if (interrupted == null) {
            if (key_value) |k| try g.push(frame, k.retain());
            try g.push(frame, base.retain());
            try g.push(frame, value.retain());
            return .crossing;
        }
        if (interrupted.?) return error.Landed;
        switch (outcome) {
            .done, .value => return .next,
            .failed => |f| {
                owned = false;
                return g.propFailed(run, o, key, .{ .code = f.code, .message = f.message, .data = f.data }, m);
            },
            else => return g.propError(run, o, key),
        }
    }

    fn releasePropResult(g: *Group, r: objects.Result) void {
        switch (r) {
            .value => |v| v.release(),
            .failed => |f| {
                g.gpa.free(f.code);
                if (f.message) |t| g.gpa.free(t);
                if (f.data) |d| d.release();
            },
            else => {},
        }
    }

    /// `prop <run> object= name= op= value=|error=`.
    fn propRecord(g: *Group, run: *Run, o: *objects.Object, key: []const u8, op: []const u8, what: []const u8, v: ?*const Value, input: ?*const Value) void {
        const out = g.trace orelse return;
        out.print("prop {s} object=", .{run.id}) catch {};
        display.writeTrace(out, o.value) catch {};
        out.print(" name={s} op={s}", .{ key, op }) catch {};
        if (input) |x| {
            out.writeAll(" value=") catch {};
            display.writeTrace(out, x) catch {};
        }
        out.print(" {s}=", .{what}) catch {};
        if (v) |x| display.writeTrace(out, x) catch {} else out.writeAll("{}") catch {};
        out.writeAll("\n") catch {};
    }

    /// A property's failure raises as an Operation's does, with
    /// `capability` the Object Kind and `operation` the property.
    fn propError(g: *Group, run: *Run, o: *objects.Object, key: []const u8) error{ Raised, OutOfMemory } {
        // Properties have no Call id and no call-failed Trace record, but
        // their Host failures still reach the embedding Host as Reports.
        const r = &g.reports;
        g.addReport(.{ .call_failed = .{
            .script = r.text(run.script.name) catch "",
            .call = "",
            .capability = r.text(o.kind.name) catch "",
            .operation = r.text(key) catch "",
            .detail = "invalid property result or Host failure",
        } });
        const capability = model.text(g.gpa, o.kind.name) catch return error.OutOfMemory;
        defer capability.release();
        const operation_name = model.text(g.gpa, key) catch return error.OutOfMemory;
        defer operation_name.release();
        return g.raise("host error", &.{ .{ .key = "capability", .value = capability }, .{ .key = "operation", .value = operation_name } });
    }

    /// `wrong kind` for a value that breaks a property's Shape.
    fn raiseMismatchAt(g: *Group, bad: capabilities.Mismatch) error{ Raised, OutOfMemory } {
        return switch (bad) {
            .wrong_kind => |w| blk: {
                const expected = model.text(g.gpa, w.expected) catch return error.OutOfMemory;
                defer expected.release();
                const got = model.text(g.gpa, w.got) catch return error.OutOfMemory;
                defer got.release();
                break :blk g.raise("wrong kind", &.{ .{ .key = "expected", .value = expected }, .{ .key = "got", .value = got }, .{ .key = "value", .value = w.value } });
            },
            else => g.raise("wrong kind", &.{}),
        };
    }

    /// A Host failure: a `call-failed` report, then `host error`.
    fn hostError(g: *Group, id: []const u8, grant: []const u8, operation_name: []const u8, where: []const model.Pair) error{ Raised, OutOfMemory } {
        g.write("call-failed {s} op={s}.{s}\n", .{ id, grant, operation_name });
        const r = &g.reports;
        const script_name = id[0 .. std.mem.indexOfScalar(u8, id, '/') orelse 0];
        const definition = if (g.script(script_name)) |owner_script| if (owner_script.grant(grant)) |named| named.grant.capability.name else grant else grant;
        g.addReport(.{ .call_failed = .{ .script = r.text(script_name) catch "", .call = r.text(id) catch "", .capability = r.text(definition) catch "", .operation = r.text(operation_name) catch "" } });
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

fn restrictedOperation(frame: *const Frame, ins: lower.Instruction) bool {
    return switch (ins.op) {
        .load_var, .store_var, .store_definition, .load_object, .me, .target, .set_property, .set_property_computed, .ask, .ask_wait, .tell, .send, .send_wait, .send_named, .send_named_wait, .send_spread, .send_spread_wait, .send_up, .send_up_wait, .wait, .wait_for, .wait_for_any, .join_start, .join_ask, .join_send, .join_send_named, .join_send_spread, .join_end, .timeout_start, .timeout_end, .call_value_wait, .call_handler_wait, .veto, .pass, .choose_offer => true,
        .call_builtin => std.mem.eql(u8, ins.operands[0].text, "isDisposed") or std.mem.eql(u8, ins.operands[0].text, "offerAvailable"),
        .get_key, .get_key_computed => blk: {
            const stack = frame.stack.items;
            if (stack[stack.len - 1].value.data != .object) break :blk false;
            // Literal key operands are canonical display text, including quotes.
            if (ins.op == .get_key) break :blk !std.mem.eql(u8, ins.operands[0].text, "\"id\"");
            const key = stack[stack.len - 2].value;
            break :blk key.data != .text or !std.mem.eql(u8, key.data.text, "id");
        },
        else => false,
    };
}

const errors_table = @import("../generated/errors.zig");

fn errorEntry(code: []const u8) ?errors_table.ErrorsTableErrorEntry {
    for (errors_table.errors.@"error") |e| if (std.mem.eql(u8, e.code, code)) return e;
    return null;
}

/// The Script's Grants. With `as_used`, each keeps only the Operations the
/// code calls through it.
/// The Script's Grants; as used, only the Operations its code or its
/// Libraries' `needs` call.
fn keptGrants(a: Allocator, named: []const NamedGrant, unit: *const lower.Unit, imports: []const *Library, as_used: bool) ![]ScriptGrant {
    var out: std.ArrayList(ScriptGrant) = .empty;
    for (named) |n| {
        const kept = try a.dupe(bool, n.grant.operations);
        if (as_used) {
            for (kept, n.grant.capability.operations) |*k, op| {
                if (!k.*) continue;
                k.* = for (unit.code) |ins| switch (ins.op) {
                    .ask, .tell, .ask_wait, .join_ask => if (std.mem.eql(u8, ins.operands[0].text, n.name) and std.mem.eql(u8, ins.operands[1].text, op.name)) break true,
                    else => {},
                } else needed(imports, n.name, op.name);
            }
            // A kept opener keeps its abandonment Operation.
            const ops = n.grant.capability.operations;
            for (ops, 0..) |op, i| if (kept[i] and op.scope == .opens) {
                kept[n.grant.capability.find(op.scope.opens.abandon).?] = true;
            };
            if (std.mem.indexOfScalar(bool, kept, true) == null) continue;
        }
        try out.append(a, .{ .name = try a.dupe(u8, n.name), .grant = n.grant, .kept = kept });
    }
    return out.items;
}

/// Whether a Library's `needs` call the Operation through the Grant name.
fn needed(imports: []const *Library, grant: []const u8, operation: []const u8) bool {
    for (imports) |l| for (l.needs) |need| {
        if (std.mem.eql(u8, need.grant, grant) and std.mem.eql(u8, need.operation, operation)) return true;
    };
    return false;
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
/// `err` with `during` added, unless it has one.
fn withDuring(gpa: Allocator, err: *Value, during: *Value) Allocator.Error!*Value {
    if (err.get("during") != null) return err.retain();
    // Adding a key to a map can only run out of memory.
    return withKey(gpa, err, "during", during) catch return error.OutOfMemory;
}

/// An ordinary Name: an identifier word that isn't a Reserved Word or `_`.
fn validName(w: []const u8) bool {
    if (w.len == 0 or std.mem.eql(u8, w, "_")) return false;
    if (!(std.ascii.isAlphabetic(w[0]) or w[0] == '_' or w[0] >= 0x80)) return false;
    for (w) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_' or c >= 0x80)) return false;
    for (grammar.reserved) |x| if (std.mem.eql(u8, x, w)) return false;
    return true;
}

fn withKey(gpa: Allocator, map: *Value, key: []const u8, value: *Value) !*Value {
    var pairs: std.ArrayList(model.Pair) = .empty;
    defer pairs.deinit(gpa);
    try map.data.map.appendTo(gpa, &pairs);
    try pairs.append(gpa, .{ .key = key, .value = value });
    const out = try model.map(gpa, pairs.items);
    out.core_message = map.core_message;
    return out;
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

pub const releaseValues = releaseAll;

fn releaseAll(values: []*Value, gpa: Allocator) void {
    for (values) |v| v.release();
    gpa.free(values);
}

/// A Script's code identity (chapter 9).
pub fn codeIdentity(name: []const u8, source: []const u8, kind: enum { script, library, extension }, imports: []const *const Library) [32]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [64]u8 = undefined;
    h.update(std.fmt.bufPrint(&buf, "odgn-talk code identity 1\n{s}\n{d}\n{s}\n", .{ version.language, cost_model.version, @tagName(kind) }) catch unreachable);
    h.update(name);
    h.update("\n");
    // Each imported Library's identity, once, in the order first named.
    for (imports) |l| {
        h.update(&std.fmt.bytesToHex(l.identity, .lower));
        h.update("\n");
    }
    h.update("source\n");
    h.update(source);
    var out: [32]u8 = undefined;
    h.final(&out);
    return out;
}

/// MaxWait's default, for a suspending call whose Operation sets no
/// `maxPending`, until step 4 brings per-Script limits.
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
    if (!q.unit.compatible(&second)) return null;
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
pub const failureValue = failureMap;

fn failureMap(gpa: Allocator, f: Failure) !*Value {
    var pairs: std.ArrayList(model.Pair) = .empty;
    defer pairs.deinit(gpa);
    const code = try model.text(gpa, f.code);
    defer code.release();
    try pairs.append(gpa, .{ .key = "code", .value = code });
    const message: ?*Value = if (f.message) |t| try model.text(gpa, t) else null;
    defer if (message) |t| t.release();
    if (message) |t| try pairs.append(gpa, .{ .key = "message", .value = t });
    if (f.data) |d| if (d.data == .map) try d.data.map.appendTo(gpa, &pairs);
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
/// Whether a Host may send a message by this name with `count` arguments:
/// one with a `:` must be a Selector of two or more parts, one argument per
/// part (chapter 9, Selectors).
pub fn hostMessageName(name: []const u8, count: usize) bool {
    if (std.mem.indexOfScalar(u8, name, ':') == null) return true;
    return count >= 2 and messageName(name, count);
}

pub fn messageName(name: []const u8, count: usize) bool {
    if (std.mem.indexOfScalar(u8, name, ':') == null) return nameWord(name);
    if (name[name.len - 1] != ':') return false;
    var parts: usize = 0;
    var it = std.mem.splitScalar(u8, name[0 .. name.len - 1], ':');
    while (it.next()) |part| {
        // A label after the first part may be a Reserved Word the labels
        // allow, such as `to`, but never an excluded one.
        if (!(if (parts > 0) labelWord(part) else nameWord(part))) return false;
        parts += 1;
    }
    // A message with no labels keeps its plain name, so a Selector has two
    // parts or more.
    return parts >= 2 and parts == count;
}

/// The code a frame runs: its Library's, or its Run's Script's.
fn unitOf(run: *const Run, frame: *const Frame) *const lower.Unit {
    return if (frame.library) |l| &l.unit else &run.script.unit;
}

fn definitionsOf(run: *const Run, frame: *const Frame) []*Value {
    return if (frame.library) |l| l.definitions else run.script.definitions;
}

fn unitName(run: *const Run, frame: *const Frame) []const u8 {
    return if (frame.library) |l| l.name else run.script.name;
}

/// The unit name of the Run's top frame, as `at=` names it.
fn topName(run: *const Run) []const u8 {
    return unitName(run, &run.frames.items[run.frames.items.len - 1]);
}

fn importsOf(run: *const Run, frame: *const Frame) []*Library {
    return if (frame.library) |l| l.imports else run.script.imports;
}

fn importOf(run: *const Run, frame: *const Frame, name: []const u8) ?*Library {
    for (importsOf(run, frame)) |l| if (std.mem.eql(u8, l.name, name)) return l;
    return null;
}

/// The unit an import names: `@<unit>`, one of its Run's Script's own units,
/// or a Library the frame's unit imports.
fn importPlace(run: *const Run, frame: *const Frame, name: []const u8) ?Place {
    if (name.len == 0 or name[0] != '@') return .{ .library = importOf(run, frame, name) orelse return null };
    const s = run.script;
    if (std.mem.eql(u8, name[1..], s.name)) return .{ .library = null };
    for (s.extensions.items) |x| if (std.mem.eql(u8, name[1..], x.name)) return .{ .library = x };
    return null;
}

/// A unit's function by name.
fn functionIn(unit: *const lower.Unit, name: []const u8) ?u32 {
    for (unit.bodies, 0..) |b, i| if (b.kind == .function and std.mem.eql(u8, b.name, name)) return @intCast(i);
    return null;
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

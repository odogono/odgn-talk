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
pub const objects = @import("objects.zig");
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
    /// Preempted in a clause's patterns or Guard: the clause, and whether it
    /// is a Fallback's, from which dispatch goes on.
    preempted_in: ?struct { body: u32, fallback: bool } = null,
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
    /// The Join it is in, from `join-start` to its closing `end`.
    join: ?*Join = null,
    /// The body of the Handler Clause it was dispatched to, whose Queueing
    /// Policy it follows.
    clause_body: ?u32 = null,
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
    /// Its Script's Variables when its Segment began, which a failed commit
    /// restores; only for a Script with Segment-bound Operations.
    segment_base: ?[]*Value = null,
};

/// A Segment's participant: its Segment Coordinator and the Grants enrolled
/// in it, in enrollment order.
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

    fn object(s: *const Script, name: []const u8) ?*objects.Object {
        for (s.objects) |o| if (std.mem.eql(u8, o.name, name)) return o.object;
        return null;
    }

    fn grant(s: *const Script, name: []const u8) ?*ScriptGrant {
        for (s.grants) |*g| if (std.mem.eql(u8, g.name, name)) return g;
        return null;
    }
};

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
    stdlib: bool = false,

    pub fn destroy(l: *Library) void {
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
pub fn compileLibrary(gpa: Allocator, name: []const u8, label: []const u8, source: []const u8, given: []const *Library, declarations: ?[]const NamedGrant) !Compiled {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();
    const src = try a.dupe(u8, source);
    var lines: lexer.Lines = try .init(a, src);
    const refused = struct {
        fn one(al: Allocator, ls: *lexer.Lines, code: []const u8, offset: usize) ![]const Diagnostic {
            const p = ls.position(offset);
            const out = try al.alloc(Diagnostic, 1);
            out[0] = .{ .code = code, .line = @intCast(p.line), .column = @intCast(p.column) };
            return out;
        }
    };
    const tree = switch (try parser.parse(a, src)) {
        .failure => |d| {
            const diags = try refused.one(gpa, &lines, d.code.spelling(), d.offset);
            arena.deinit();
            return .{ .refused = diags };
        },
        .tree => |t| t,
    };
    const t = try a.create(ast.Tree);
    t.* = tree;
    const imports = try resolveImports(a, t, given);
    var views: std.ArrayList(check.Library) = .empty;
    for (given) |l| try views.append(a, .{ .name = l.name, .exports = l.exports });
    var context: check.Context = .{ .library = true, .libraries = views.items };
    // Grant declarations by the names its source uses: the modes and
    // Shapes its Capability calls are checked and lowered against.
    if (declarations) |named| {
        const viewed = try a.alloc(check.Grant, named.len);
        for (named, viewed) |n, *v| v.* = .{ .name = try a.dupe(u8, n.name), .operations = try capabilities.checkOperations(a, n.grant) };
        context.grants = viewed;
    }
    const checked = try check.check(a, t, context);
    if (checked.diagnostics.len > 0) {
        const diags = try gpa.alloc(Diagnostic, checked.diagnostics.len);
        for (checked.diagnostics, diags) |d, *x| {
            const p = lines.position(d.offset);
            x.* = .{ .code = d.code.spelling(), .line = @intCast(p.line), .column = @intCast(p.column) };
        }
        arena.deinit();
        return .{ .refused = diags };
    }
    const own_name = try a.dupe(u8, name);
    const unit = try lower.lower(a, t, &checked, .{ .name = own_name, .context = context, .values = gpa });
    var needs: std.ArrayList(check.Need) = .empty;
    try needs.appendSlice(a, checked.needs);
    for (imports) |l| try needs.appendSlice(a, l.needs);
    const l = try gpa.create(Library);
    l.* = .{
        .gpa = gpa,
        .arena = arena,
        .name = own_name,
        .version = try a.dupe(u8, label),
        .source = src,
        .identity = codeIdentity(name, source, .library, imports),
        .unit = unit,
        .definitions = &.{},
        .imports = imports,
        .exports = try check.exports(a, t, &checked),
        .needs = needs.items,
    };
    // Its Constants and defaults: its initialiser, which may use only
    // literals, Constants and Built-ins, run once.
    l.definitions = try gpa.alloc(*Value, unit.definitions.len);
    for (l.definitions, unit.definitions) |*v, d| v.* = try importedDefinition(gpa, imports, d) orelse try nothing(gpa);
    var group: Group = .init(gpa, null);
    defer group.deinit();
    var host: Script = .{ .name = own_name, .identity = l.identity, .arena = .init(gpa), .unit = unit, .variables = &.{}, .definitions = l.definitions };
    var run: Run = .{ .id = "", .script = &host, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
    defer run.frames.deinit(gpa);
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
fn importedDefinition(gpa: Allocator, imports: []const *Library, d: []const u8) !?*Value {
    _ = gpa;
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

/// A retained frame's size: its slots, their values and its operand stack.
fn frameSize(f: *const Frame) u64 {
    var total: u64 = 64 + 8 * f.locals.len;
    for (f.locals) |v| total += costs.size(v);
    return total + stackSize(f.stack.items);
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
    fn write(o: Override, w: *std.Io.Writer) void {
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
pub const Preemption = enum { slice, cap };

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
pub const NamedGrant = struct { name: []const u8, grant: *capabilities.Grant };

/// A Script's Grant: the Operations it keeps, by index into its
/// Capability's.
/// A Script's named Grant. `disabled` is set when automatic abandonment
/// through it fails, and refuses later calls with `capability disabled`;
/// `revoked` is set by a `revoke` Host Input, and refuses them with
/// `capability revoked`.
pub const ScriptGrant = struct { name: []const u8, grant: *capabilities.Grant, kept: []bool, disabled: bool = false, revoked: bool = false };

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

const Input = union(enum) {
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
    /// Stops a Script, with an owned name and reason.
    stop: struct { script: []const u8, reason: []const u8 },
    /// Cancels a Delivery's Run, or the Delivery itself if it is still in
    /// a mailbox.
    cancel_delivery: u64,
};

const Broadcast = struct {
    id: u64,
    message: []const u8,
    args: []*Value,
    decision: bool,
    recipients: ?[]Recipient = null,
    limits: ?Override = null,
};

/// A Broadcast's recipient: its Script and its own delivery id.
const Recipient = struct { script: *Script, delivery: u64 };

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
    /// The last Pump's Clock reading, which a Capability call reads.
    clock: model.dates.Instant = .{ .seconds = 0, .nanos = 0 },
    /// The waits with deadlines, and how many have been set.
    pending: std.ArrayList(*Pending) = .empty,
    timers: u64 = 0,
    /// Suspending calls, which the Host may answer until the Group ends.
    calls: std.ArrayList(*capabilities.Call) = .empty,
    /// The call ids of `send … and wait`, which waits and records name.
    ids: std.ArrayList([]u8) = .empty,
    /// The Host Objects the Group has handles for, in the order made.
    objects: std.ArrayList(*objects.Object) = .empty,
    /// The Libraries the Host added, besides the stdlib's, which it holds
    /// but doesn't own.
    libraries: std.ArrayList(*Library) = .empty,
    /// The code of each Function Value made, by identity.
    functions: std.ArrayList(*FunctionCode) = .empty,

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
            .broadcast => |b| g.releaseBroadcast(b),
            .revoke => |x| {
                g.gpa.free(x.script);
                g.gpa.free(x.grant);
            },
            .cancel_run => |id| g.gpa.free(id),
            .stop => |x| {
                g.gpa.free(x.script);
                g.gpa.free(x.reason);
            },
            .set_parent, .dispose, .cancel_delivery => {},
        };
        g.inputs.deinit(g.gpa);
        for (g.objects.items) |o| o.destroy(g.gpa);
        g.objects.deinit(g.gpa);
        g.libraries.deinit(g.gpa);
        for (g.functions.items) |f| {
            g.gpa.free(f.home);
            g.gpa.destroy(f);
        }
        g.functions.deinit(g.gpa);
        for (g.calls.items) |c| {
            g.gpa.free(c.id);
            releaseAll(c.args, g.gpa);
            g.gpa.destroy(c);
        }
        g.calls.deinit(g.gpa);
        for (g.ids.items) |id| g.gpa.free(id);
        g.ids.deinit(g.gpa);
        for (g.scripts.items) |s| g.destroyScript(s);
        g.scripts.deinit(g.gpa);
        // A live Run removed its own wait; any left belongs to none.
        for (g.pending.items) |p| g.destroyPending(p);
        g.pending.deinit(g.gpa);
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
        s.* = .{ .name = undefined, .identity = codeIdentity(name, source, .script, &.{}), .arena = .init(g.gpa), .unit = undefined, .variables = &.{}, .definitions = &.{}, .limits = options.limits };
        // Until it joins the Group, a refusal leaves nothing of it behind.
        var lowered = false;
        var joined = false;
        errdefer if (!joined) {
            if (lowered) for (s.unit.values) |v| if (v == .value) v.value.release();
            releaseAll(s.variables, g.gpa);
            releaseAll(s.definitions, g.gpa);
            s.arena.deinit();
            g.gpa.destroy(s);
        };
        const a = s.arena.allocator();
        s.name = try a.dupe(u8, name);
        const src = try a.dupe(u8, source);
        var lines: lexer.Lines = try .init(a, src);
        const parsed = try parser.parse(a, src);
        // A Script's identity covers the Libraries it imports that the
        // Group holds; one that doesn't parse names none.
        if (parsed == .tree) {
            s.imports = try resolveImports(a, &parsed.tree, g.libraries.items);
            s.identity = codeIdentity(name, source, .script, s.imports);
        }
        g.write("> load {s} identity={x}\n", .{ name, s.identity });
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
        var held: std.ArrayList(check.Library) = .empty;
        for (g.libraries.items) |l| try held.append(a, .{ .name = l.name, .exports = l.exports });
        context.libraries = held.items;
        const views = try a.alloc(check.Object, options.objects.len);
        for (options.objects, views) |o, *v| v.* = .{ .name = try a.dupe(u8, o.name), .kind = o.object.kind.name };
        context.objects = views;
        if (options.owner) |o| context.owner = o.kind.name;
        const kinds = try a.create(KindsView);
        kinds.* = .{ .objects = options.objects, .owner = options.owner };
        context.writable = .{ .context = kinds, .call = KindsView.writable };
        if (options.grants) |named| {
            const viewed = try a.alloc(check.Grant, named.len);
            for (named, viewed) |n, *v| v.* = .{ .name = try a.dupe(u8, n.name), .operations = try capabilities.checkOperations(a, n.grant) };
            context.grants = viewed;
        }
        const checked = try check.check(a, t, context);
        var diagnostics: std.ArrayList(check.Diagnostic) = .empty;
        try diagnostics.appendSlice(a, checked.diagnostics);
        try g.libraryNeeds(a, t, context.grants orelse &.{}, &diagnostics);
        std.mem.sort(check.Diagnostic, diagnostics.items, {}, struct {
            fn less(_: void, x: check.Diagnostic, y: check.Diagnostic) bool {
                return x.offset < y.offset;
            }
        }.less);
        if (diagnostics.items.len > 0) {
            for (diagnostics.items) |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ name, d.code.spelling(), p.line, p.column });
            }
            s.arena.deinit();
            g.gpa.destroy(s);
            return .{ .refused = diagnostics.items.len };
        }
        s.unit = try lower.lower(a, t, &checked, .{ .name = s.name, .context = context, .values = g.gpa });
        lowered = true;
        // A Text Pattern literal over the Script's `patternSize` is a load
        // error, at its opening `<`.
        const oversized = try oversizedPatterns(a, &s.unit, s.limits.pattern_size);
        if (oversized.len > 0) {
            for (oversized) |p| g.write("diag {s} code=\"pattern too large\" pos={d}:{d}\n", .{ name, p.line, p.column });
            for (s.unit.values) |v| if (v == .value) v.value.release();
            s.arena.deinit();
            g.gpa.destroy(s);
            return .{ .refused = oversized.len };
        }
        if (options.grants) |named| s.grants = try keptGrants(a, named, &s.unit, s.imports, options.grants_as_used);
        for (s.grants) |sg| if (sg.grant.coordinator != null) {
            s.effects = true;
        };
        s.objects = try a.alloc(NamedObject, options.objects.len);
        for (options.objects, s.objects) |o, *x| x.* = .{ .name = try a.dupe(u8, o.name), .object = o.object };
        s.variables = try g.newValues(s.unit.variables.len, &.{}, &.{});
        s.definitions = try g.newValues(s.unit.definitions.len, s.unit.definitions, s.imports);
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
        // The initialiser runs once, uncharged.
        var run: Run = .{ .id = "", .script = s, .delivery = .{ .id = 0, .message = "", .args = &.{}, .request = false } };
        defer {
            g.abandonUnwinding(&run);
            while (run.frames.items.len > 0) g.popFrame(&run);
            run.frames.deinit(g.gpa);
        }
        try g.pushFrame(&run, 0, &.{});
        switch (try g.execute(&run, false)) {
            .returned => |v| v.release(),
            .errored => |v| {
                // `initialiser failed`, at the raising instruction: the
                // Script leaves the Group.
                v.release();
                const at = run.raised_at orelse lower.Position{ .line = 1, .column = 1 };
                g.write("diag {s} code=\"initialiser failed\" pos={d}:{d}\n", .{ name, at.line, at.column });
                _ = g.scripts.pop();
                if (s.owner) |o| if (o.owner_of) |x| {
                    g.gpa.free(x);
                    o.owner_of = null;
                };
                g.destroyScript(s);
                return .{ .refused = 1 };
            },
            else => {},
        }
        return .{ .loaded = s };
    }

    /// `n` Script values: Nothing, or for a definition named
    /// `<library>:<name>`, that imported Constant's value. All or none.
    fn newValues(g: *Group, n: usize, names: []const []const u8, imports: []const *Library) ![]*Value {
        const out = try g.gpa.alloc(*Value, n);
        var made: usize = 0;
        errdefer {
            for (out[0..made]) |v| v.release();
            g.gpa.free(out);
        }
        for (out, 0..) |*v, i| {
            v.* = (if (i < names.len) try importedDefinition(g.gpa, imports, names[i]) else null) orelse try nothing(g.gpa);
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

    /// Registers a compiled Library with the Group, writing the
    /// `add-library` input and any refusal: a stdlib name is `reserved
    /// name`, a name the Group holds `name reused`, and an import the Group
    /// doesn't hold with the same identity `library mismatch`.
    pub fn addLibrary(g: *Group, l: *Library) !void {
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
        try g.inputs.append(g.gpa, input);
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
        try g.inputs.append(g.gpa, .{ .cancel_run = owned });
    }

    /// Queues cancelling a Delivery, by its delivery number.
    pub fn cancelDeliveryInput(g: *Group, id: u64) !void {
        try g.inputs.append(g.gpa, .{ .cancel_delivery = id });
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
                g.write("run outcome=cancelled delivery=d{d} fuel=0 alloc=0\n", .{id});
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
        if (r.resume_with) |w| switch (w) {
            .cancelled => return,
            else => g.releaseResume(w),
        };
        const queued = r.resume_with != null or r.continuing;
        if (r.continuing) {
            _ = g.abandonScopes(r);
            _ = g.finalize(r, false);
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
        try g.inputs.append(g.gpa, .{ .revoke = .{ .script = s, .grant = n } });
    }

    /// Calls a named Grant's release hook, if its Capability has one.
    fn releaseGrant(g: *Group, s: *const Script, sg: *const ScriptGrant, reason: capabilities.ReleaseReason) void {
        const release = sg.grant.capability.release orelse return;
        release.call(release.context, &.{ .group = g, .script = s.name, .grant = sg.name, .binding = sg.grant.binding, .now = g.clock, .reason = reason });
    }

    pub fn dispose(g: *Group, o: *objects.Object) !void {
        try g.inputs.append(g.gpa, .{ .dispose = o });
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
        const script_name = try g.gpa.dupe(u8, to);
        errdefer g.gpa.free(script_name);
        var copy = d;
        copy.limits = g.override;
        g.override = null;
        copy.message = try g.gpa.dupe(u8, d.message);
        errdefer g.gpa.free(copy.message);
        copy.args = try g.gpa.dupe(*Value, d.args);
        errdefer g.gpa.free(copy.args);
        try g.inputs.append(g.gpa, .{ .deliver = .{ .script = script_name, .delivery = copy } });
    }

    /// Whether a Host Delivery to `s` would overfill its mailbox, counting
    /// the Deliveries already queued to it.
    pub fn mailboxFull(g: *Group, s: *const Script) bool {
        var n = mailboxLen(s);
        for (g.inputs.items) |input| switch (input) {
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
        try g.inputs.append(g.gpa, .{ .broadcast = .{ .id = g.broadcasts, .message = name, .args = copy, .decision = decision, .limits = g.override } });
        g.override = null;
        return g.broadcasts;
    }

    /// Writes a Broadcast the Host call refused, with no id, then its
    /// `refused` record.
    pub fn refuseBroadcast(g: *Group, message: []const u8, args: []*Value, decision: bool, code: []const u8) void {
        g.writeInput(.{ .broadcast = .{ .id = 0, .message = message, .args = args, .decision = decision } });
        g.write("refused code=\"{s}\"\n", .{code});
    }

    fn releaseBroadcast(g: *Group, b: Broadcast) void {
        g.gpa.free(b.message);
        releaseAll(b.args, g.gpa);
        if (b.recipients) |r| g.gpa.free(r);
    }

    /// Whether a Script wants a Broadcast's message: it has a Handler for
    /// it, or a `wait for` pending on it. A Fallback doesn't count.
    fn wants(g: *Group, s: *const Script, message: []const u8) bool {
        for (s.unit.bodies) |b| if (b.kind == .handler and std.mem.eql(u8, b.name, message)) return true;
        for (g.pending.items) |p| {
            const event = p.event orelse continue;
            if (p.run.script != s) continue;
            for (s.unit.events[event.entry].branches) |b| switch (b) {
                .when => |w| if (std.mem.eql(u8, w.message, message)) return true,
                .after => {},
            };
        }
        return false;
    }

    /// Finds a Broadcast's recipients, in load order, each with its own
    /// delivery id.
    fn resolveBroadcast(g: *Group, b: *Broadcast, stopping: []const *const Script) !void {
        if (b.recipients != null) return;
        var out: std.ArrayList(Recipient) = .empty;
        errdefer out.deinit(g.gpa);
        for (g.scripts.items) |s| if (s.stopped == null and std.mem.indexOfScalar(*const Script, stopping, s) == null and g.wants(s, b.message)) {
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
            try g.post(r.script, .{ .id = r.delivery, .message = message, .args = args, .request = false, .decision = b.decision, .decides = b.decision, .broadcast = b.id, .limits = b.limits });
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
        try g.inputs.append(g.gpa, .{ .settle = .{ .id = copy, .with = with } });
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
        if (d.function) |f| f.release();
        releaseAll(d.args, g.gpa);
        g.gpa.free(d.message);
        if (d.during) |x| x.release();
        if (d.from) |x| g.gpa.free(x);
    }

    fn destroyScript(g: *Group, s: *Script) void {
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
        for (s.unit.values) |v| if (v == .value) v.value.release();
        s.arena.deinit();
        g.gpa.destroy(s);
    }

    fn destroyPending(g: *Group, p: *Pending) void {
        if (p.event) |e| g.releaseEvent(e);
        g.gpa.destroy(p);
    }

    fn releaseEvent(g: *Group, e: *EventWait) void {
        g.releaseBranches(e.branches);
        g.gpa.destroy(e);
    }

    fn releaseBranches(g: *Group, branches: []EventBranch) void {
        g.releaseHeld(branches);
        g.gpa.free(branches);
    }

    /// What each branch holds, without the branches themselves.
    fn releaseHeld(g: *Group, branches: []const EventBranch) void {
        for (branches) |b| switch (b) {
            .when => |x| {
                if (x.from) |v| v.release();
                releaseAll(x.captures, g.gpa);
            },
            .after => {},
        };
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
        g.abandonUnwinding(run);
        g.dropJoin(run);
        run.scopes.deinit(g.gpa);
        if (run.participant) |*p| p.grants.deinit(g.gpa);
        g.dropBase(run);
        run.abandoned.deinit(g.gpa);
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
            .revoke => |x| out.print("> revoke {s} grant={s}", .{ x.script, x.grant }) catch {},
            .cancel_run => |id| out.print("> cancel-run {s}", .{id}) catch {},
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
        g.clock = clock;
        g.slice = slice;
        g.cap = cap;
        g.sliced = false;
        // A Broadcast's recipients are those that want it now, as the queue
        // is drained.
        // A Stop, or a disposal that stops a Script, queued before a
        // Broadcast leaves that Script out of its recipients.
        var stopping: std.ArrayList(*const Script) = .empty;
        defer stopping.deinit(g.gpa);
        for (g.inputs.items) |*input| switch (input.*) {
            .broadcast => |*b| try g.resolveBroadcast(b, stopping.items),
            .stop => |x| if (g.script(x.script)) |target| try stopping.append(g.gpa, target),
            .dispose => |o| for (g.scripts.items) |x| if (x.owner == o) try stopping.append(g.gpa, x),
            else => {},
        };
        for (g.inputs.items) |input| g.writeInput(input);
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
        // Refused partway, the inputs already taken are gone from the queue,
        // and the rest stay for `deinit`.
        var consumed: usize = 0;
        errdefer {
            const rest = g.inputs.items.len - consumed;
            std.mem.copyForwards(Input, g.inputs.items[0..rest], g.inputs.items[consumed..]);
            g.inputs.shrinkRetainingCapacity(rest);
        }
        for (g.inputs.items) |input| switch (blk: {
            consumed += 1;
            break :blk input;
        }) {
            .deliver => |d| {
                defer g.gpa.free(d.script);
                if (d.delivery.target != null) {
                    try g.route(d.delivery);
                    continue;
                }
                const s = g.script(d.script) orelse {
                    g.releaseDelivery(d.delivery);
                    continue;
                };
                try g.post(s, d.delivery);
            },
            .set_parent => |x| {
                // Checked again against what earlier inputs left.
                if (parentRefusal(x.object, x.parent)) |code| {
                    g.write("refused code=\"{s}\"\n", .{code});
                } else x.object.parent = x.parent;
            },
            .dispose => |o| {
                o.disposed = true;
                // Disposing a Script's owner stops it, in this same input.
                for (g.scripts.items) |x| if (x.owner == o) try g.stopScript(x, "owner disposed", null);
            },
            .cancel_run => |id| {
                defer g.gpa.free(id);
                for (g.scripts.items) |x| for (x.live.items) |r| if (std.mem.eql(u8, r.id, id)) {
                    try g.cancel(x, r);
                    break;
                };
            },
            .cancel_delivery => |id| try g.cancelDelivery(id),
            .stop => |x| {
                defer g.gpa.free(x.script);
                defer g.gpa.free(x.reason);
                // A repeated Stop does nothing, and keeps the first reason.
                const target = g.script(x.script) orelse continue;
                try g.stopScript(target, x.reason, null);
            },
            .revoke => |x| {
                defer g.gpa.free(x.script);
                defer g.gpa.free(x.grant);
                // The first revocation of a name the Script keeps releases
                // it; any other does nothing.
                const s = g.script(x.script) orelse continue;
                const sg = s.grant(x.grant) orelse continue;
                if (sg.revoked) continue;
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
                    continue;
                };
                const p = g.pending.orderedRemove(i);
                try g.ready(p, x.with);
            },
            .broadcast => |b| try g.drainBroadcast(b),
        };
        g.inputs.clearRetainingCapacity();
        consumed = 0;
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
        // Turns: each Script with work, in load order, round and round,
        // until the work is done, every Script with work has spent its slice
        // or the Group has spent its cap.
        var busy = true;
        turns: while (busy) {
            busy = false;
            for (g.scripts.items) |s| {
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
                        var taken = d;
                        if (try g.observe(s, d) and d.decision) {
                            taken.decision = false;
                            try g.takePart(d, .allowed);
                        }
                        try g.startRun(s, taken);
                    },
                    .run => |r| try g.resumeRun(s, r),
                }
            }
        }
        // A slice overrun is carried to the Script's next Pump as debt.
        if (slice > 0) for (g.scripts.items) |x| {
            if (x.spent > x.allowance) x.debt += x.spent - x.allowance;
        };
        g.write("pumped state={s} fuel={d}", .{ if (g.stoppedState()) "stopped" else if (g.sliced) "sliced" else "idle", g.pump_fuel });
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
            // A preempted Run's Join hasn't reached its end, so its members'
            // waits aren't timers yet.
            if (p.member != null and p.run.continuing) continue;
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
        if (d.broadcast > 0) w.print(" broadcast=b{d}", .{d.broadcast}) catch {};
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
            try g.callFunction(run, code.library, code.body, d.args);
            const callee = &run.frames.items[run.frames.items.len - 1];
            const body = g.functionBody(code).?;
            for (fv.data.function.captures.data.map, body.capture_slot..) |p, slot| {
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
        if (!fallback) {
            for (s.unit.bodies[from..], from..) |b, i| {
                if (b.kind != .handler or !std.mem.eql(u8, b.name, d.message)) continue;
                run.clauses_seen += 1;
                if (b.params.len != d.args.len) continue;
                run.clause = run.clauses_seen;
                if (try g.tryClause(s, run, @intCast(i), d.args, d.during, false)) |end| return end;
            }
            // No named clause took it: the Fallback's clauses, with the
            // message map, built without charge. A Broadcast, a Decision and
            // an `error` message never reach them.
            if (d.internal_error or d.decides or d.broadcast != 0) return .unhandled;
        }
        const message = try g.messageMap(d);
        defer message.release();
        for (s.unit.bodies[if (fallback) from else 0..], if (fallback) from else 0..) |b, i| {
            if (b.kind != .fallback) continue;
            run.fallback = true;
            run.clause = b.clause orelse 1;
            if (try g.tryClause(s, run, @intCast(i), &.{message}, null, true)) |end| return end;
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
        if (try g.afterGuard(s, run, in.body, outcome, in.fallback)) |end| return end;
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

    fn tryClause(g: *Group, s: *Script, run: *Run, body: u32, args: []const *Value, during: ?*Value, fallback: bool) !?Outcome {
        const b = s.unit.bodies[body];
        run.clause_body = body;
        try g.pushFrame(run, body, args);
        if (b.during) |slot| if (during) |x| {
            const f = &run.frames.items[run.frames.items.len - 1];
            f.locals[slot].release();
            f.locals[slot] = x.retain();
        };
        // Dispatch charges the clause at the body's first instruction,
        // together with that instruction's own charge.
        run.clause_fuel = 4;
        run.select_at = b.first;
        for (s.unit.unwind) |e| if (e.kind == .guard and e.first == b.first) {
            run.select_at = e.last + 1;
        };
        return g.afterGuard(s, run, body, try g.execute(run, true), fallback);
    }

    /// What follows a clause's patterns and Guard: its Queueing Policy and
    /// its body once they pass, or null when they fail.
    fn afterGuard(g: *Group, s: *Script, run: *Run, body: u32, first: Outcome, fallback: bool) !?Outcome {
        const b = s.unit.bodies[body];
        var outcome = first;
        if (outcome == .preempted and run.select_at != null) run.preempted_in = .{ .body = body, .fallback = fallback };
        if (outcome == .selected) {
            // A clause with no patterns or Guard is tried at its body's first
            // instruction, which pays the `clause` rate. A Run that parks or
            // is dropped here pays it now; one that goes on pays it with that
            // instruction's fixed rate. A Run that can't faults there, before
            // the clause is taken.
            const waits = g.clauseBusy(s, body) and (b.policy == .queued or b.policy == .dropping);
            if (run.clause_fuel > 0) {
                const f = &run.frames.items[run.frames.items.len - 1];
                const head = unitOf(run, f).code[f.pc];
                var none: costs.Measures = .{};
                const need = run.clause_fuel + if (waits) 0 else costs.charge(costKey(head, &none), &none).fuel;
                if (need > fuelLeft(run)) return g.limitFault(run, .fuel, unitName(run, f), f.pc, head);
            }
            if (waits) {
                run.fuel += run.clause_fuel;
                run.clause_fuel = 0;
            }
            if (g.clauseBusy(s, body)) switch (b.policy) {
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
                .replacing => try g.cancelClause(s, body),
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
        const fuel = run.fuel - run.segment_fuel;
        const alloc = run.alloc - run.segment_alloc;
        g.pump_fuel += fuel;
        s.spent += fuel;
        if (g.trace) |out| {
            out.print("preempt {s} {s}", .{ run.id, if (run.continuing) "continue" else if (run.started) "resume" else "start" }) catch {};
            if (!run.started) g.writeStart(out, s, run, run.clause_body != null);
            out.print(" by={s} fuel={d} alloc={d}\n", .{ @tagName(by), fuel, alloc }) catch {};
        }
        g.writeAbandoned(run);
        run.started = true;
        run.continuing = true;
        run.segment_fuel = run.fuel;
        run.segment_alloc = run.alloc;
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
        const raised: ?*Value = try g.resumeWith(run, frame, with, waited, pc, ins);
        if (raised) |err| {
            const outcome = try g.unwind(run, err, pc, ins, true);
            if (with == .timeout and waited.id.len > 0) g.write("abandon {s}\n", .{waited.id});
            if (outcome) |end| return end;
        }
        return g.execute(run, true);
    }

    /// What a resumed Run's wait gave: a value pushed, or an error raised.
    fn resumeWith(g: *Group, run: *Run, frame: *Frame, with: Resume, waited: Waited, pc: u32, ins: lower.Instruction) !?*Value {
        const gpa = g.gpa;
        switch (with) {
            .woke => return null,
            // resumeRun handles these before any wait's value.
            .unparked, .cancelled => unreachable,
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
                run.fuel += (size + 31) / 32 + x.fuel;
                run.alloc += size;
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
        var d = try g.newDelivery(name, owned, from);
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
        event.* = .{ .entry = index, .branches = branches, .any = ins.op == .wait_for_any };
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

    fn releaseMark(g: *Group, m: Mark) void {
        g.gpa.free(m.script);
        g.gpa.free(m.run);
        if (m.reason) |v| v.release();
    }

    fn releaseDecided(g: *Group, x: Decided) void {
        for (x.vetoes) |m| g.releaseMark(m);
        for (x.undecided) |m| g.releaseMark(m);
        g.gpa.free(x.vetoes);
        g.gpa.free(x.undecided);
    }

    fn releaseOpen(g: *Group, x: OpenBroadcast) void {
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
            .verdict = if (vetoes.items.len > 0) .vetoed else if (undecided.items.len > 0) .undecided else .allowed,
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
        (if (is_broadcast) &g.decided_broadcasts else &g.decided).put(g.gpa, id, decided) catch |e| {
            g.releaseDecided(decided);
            return e;
        };
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
            const abandoned = x.pending != null or (x.with != null and switch (x.with.?) {
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
        for (run.script.variables, base) |*v, b| {
            v.*.release();
            v.* = b.retain();
        }
        _ = g;
    }

    /// Calls a participant hook, with an `effect` record. `begin` sees only
    /// the first enrolled Grant.
    fn hook(g: *Group, run: *Run, phase: capabilities.Phase) capabilities.EffectStatus {
        const p = &run.participant.?;
        const a = g.scratch.allocator();
        const enrolled = if (phase == .begin) p.grants.items[0..1] else p.grants.items;
        const grants = a.alloc(capabilities.SegmentGrant, enrolled.len) catch return .unknown;
        for (enrolled, grants) |sg, *x| x.* = .{ .name = sg.name.ptr, .name_len = sg.name.len, .binding = sg.grant.binding };
        const first = p.grants.items[0];
        const segment = g.segmentId(run);
        const context: capabilities.SegmentContext = .{ .group = g, .script = run.script.name, .run = run.id, .segment = segment, .grant = first.name, .binding = first.grant.binding, .now = g.clock, .grants = grants };
        const status = p.coordinator.hook(p.coordinator.context, phase, &context);
        g.write("effect {s} grant={s} phase={s} status={s}\n", .{ segment, first.name, @tagName(phase), @tagName(status) });
        if (status != .ok) g.write("effect-failure {s} grant={s} segment={s} phase={s} status={s}\n", .{ run.id, first.name, segment, @tagName(phase), @tagName(status) });
        return status;
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
        const status = g.hook(run, .begin);
        if (status == .ok) return;
        // An uncertain begin may have acquired something: after a rollback
        // attempt, it stops the Group.
        if (status == .unknown) {
            _ = g.hook(run, .rollback);
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
        const a = g.scratch.allocator();
        var prevented: ?EffectFailure = null;
        while (run.scopes.pop()) |slot| {
            const capability = slot.grant.grant.capability;
            const op = &capability.operations[slot.abandon];
            run.calls += 1;
            const id = std.fmt.allocPrint(a, "{s}.c{d}", .{ run.id, run.calls }) catch "";
            const segment = g.segmentId(run);
            var call: capabilities.Call = .{ .id = id, .script = run.script.name, .grant = slot.grant.name, .binding = slot.grant.grant.binding, .now = g.clock, .left = 0, .starting = false, .gpa = g.gpa, .run = run.id, .segment = segment, .scope = slot.name, .automatic = true };
            const outcome = op.host.call(op.host.context, &call, &.{});
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
            if (!ok) {
                slot.grant.disabled = true;
                g.releaseGrant(run.script, slot.grant, .disable);
                const participating = if (run.participant) |pt| std.mem.indexOfScalar(*ScriptGrant, pt.grants.items, slot.grant) != null else false;
                if (participating and prevented == null) prevented = .{ .grant = slot.grant.name, .phase = "abandon", .status = "unknown", .scope = slot.name };
            }
        }
        return prevented;
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

    fn endSegment(g: *Group, s: *Script, run: *Run, ended: Outcome) !void {
        var outcome = ended;
        const segment = g.segmentId(run);
        // Abandon leftover scopes, then commit the participant if they
        // permit it, or roll it back.
        var failure: ?EffectFailure = if (outcome != .suspended) g.abandonScopes(run) else null;
        // A cancelled Run's cleanup Segment commits, unless a limit ended it.
        const commits = failure == null and outcome != .faulted and outcome != .stopped and !(outcome == .cancelled and run.cleanup_limited);
        if (g.finalize(run, commits)) |f| failure = f;
        // An effect whose state is unknown stops the Group with this Run.
        if (g.fatal and outcome != .stopped) {
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
        // Stopping the Group discards this Run with every other.
        if (outcome == .stopped) {
            try g.stopGroup(run);
            g.destroyRun(run);
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
        if (g.trace) |out| {
            const word: []const u8 = switch (outcome) {
                .returned, .passed, .vetoed => "completed",
                .errored => "errored",
                .faulted => "limit-fault",
                .unhandled, .clause_failed => "unhandled",
                .dropped => "dropped",
                .cancelled => "cancelled",
                .effect_failed => "effect-failed",
                .suspended, .selected, .preempted, .stopped => unreachable,
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
                    var message = try g.newDelivery("error", args, run.id);
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
        if (run.clause_body) |body| for (s.live.items) |r| if (r.parked and r.clause_body.? == body) {
            r.parked = false;
            r.resume_with = .unparked;
            try s.work.append(g.gpa, .{ .run = r });
            break;
        };
        g.destroyRun(run);
    }

    /// A message from a Run, which takes `args`: all or nothing.
    fn newDelivery(g: *Group, name: []const u8, args: []*Value, from: []const u8) !Delivery {
        errdefer releaseAll(args, g.gpa);
        const message = try g.gpa.dupe(u8, name);
        errdefer g.gpa.free(message);
        return .{ .id = 0, .message = message, .args = args, .request = false, .from = try g.gpa.dupe(u8, from) };
    }

    /// Stops a Script (chapter 6, Cancellation and Stop): each of its Runs,
    /// `running` too, in the order they started, has its scopes abandoned
    /// and its participant rolled back, and one in the middle of its Segment
    /// its Script Variables too; then they are discarded with no `finally`,
    /// and its mailbox's messages dropped. Those waiting on them get `send
    /// failed`, reason `stopped`, and an open Decision settles undecided. The
    /// Script's Grants are released, and its `stopped` record lists what
    /// went. A stopped Script stays stopped.
    fn stopScript(g: *Group, s: *Script, reason: []const u8, running: ?*Run) !void {
        if (s.stopped != null) return;
        s.stopped = try g.gpa.dupe(u8, reason);
        var runs: std.ArrayList(*Run) = .empty;
        defer runs.deinit(g.gpa);
        try runs.appendSlice(g.gpa, s.live.items);
        if (running) |r| try runs.append(g.gpa, r);
        std.mem.sort(*Run, runs.items, {}, struct {
            fn less(_: void, x: *Run, y: *Run) bool {
                return runNumber(x.id) < runNumber(y.id);
            }
        }.less);
        var discarded: std.ArrayList(u8) = .empty;
        defer discarded.deinit(g.gpa);
        for (runs.items) |r| {
            _ = g.abandonScopes(r);
            if (g.finalize(r, false)) |_| {}
            if (r == running or r.continuing) g.restoreBase(r);
            if (discarded.items.len > 0) try discarded.appendSlice(g.gpa, ", ");
            try discarded.appendSlice(g.gpa, r.id);
            const d = r.delivery;
            if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "stopped", .err = null } });
            s.fuel_total += r.fuel;
            s.alloc_total += r.alloc;
        }
        var dropped: std.ArrayList(u8) = .empty;
        defer dropped.deinit(g.gpa);
        for (s.work.items) |w| switch (w) {
            .message => |d| if (d.from == null and d.id > 0) {
                if (dropped.items.len > 0) try dropped.appendSlice(g.gpa, ", ");
                try dropped.print(g.gpa, "d{d}", .{d.id});
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
        for (order) |sg| g.releaseGrant(s, sg, .stop);
        if (g.trace) |out| {
            out.print("stopped {s} reason=", .{s.name}) catch {};
            writeText(out, reason);
            if (discarded.items.len > 0) out.print(" discarded=[{s}]", .{discarded.items}) catch {};
            if (dropped.items.len > 0) out.print(" dropped=[{s}]", .{dropped.items}) catch {};
            out.writeAll("\n") catch {};
        }
        // The open Decisions settle undecided, `cancelled`, after the
        // `stopped` record.
        for (runs.items) |r| if (r.verdict or r.delivery.decision) {
            r.verdict = false;
            try g.takePart(r.delivery, .{ .undecided = .{ .script = s.name, .run = r.id, .outcome = "cancelled" } });
        };
        for (s.work.items) |w| switch (w) {
            .message => |d| try g.settleDropped(s, d),
            .run => {},
        };
        s.work.clearRetainingCapacity();
        for (runs.items) |r| if (r != running) g.destroyRun(r);
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
        try g.settleDropped(s, d);
    }

    /// Stops the Group, for an effect whose state is unknown: every Script,
    /// with the running Run discarded in its own.
    fn stopGroup(g: *Group, running: *Run) !void {
        for (g.scripts.items) |x| try g.stopScript(x, "effect state unknown", if (x == running.script) running else null);
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
        try g.inputs.append(g.gpa, .{ .stop = .{ .script = n, .reason = why } });
    }

    /// Puts a message at the back of a Script's mailbox; refused, the
    /// message is released.
    fn post(g: *Group, s: *Script, d: Delivery) !void {
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
        if (d.waits) try g.reply(d, .{ .send_failed = .{ .reason = "unhandled", .err = null } });
        // A Decision that reaches the end of its path is allowed.
        if (d.decision) g.takePart(d, .allowed) catch |e| {
            g.releaseDelivery(d);
            return e;
        };
        g.releaseDelivery(d);
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
    fn clauseBusy(g: *Group, s: *Script, body: u32) bool {
        _ = g;
        for (s.live.items) |r| if (r.clause_body != null and r.clause_body.? == body) return true;
        return false;
    }

    /// `, replacing`: cancels every Run of the clause that hasn't ended.
    /// What each waits on is abandoned now, and its cleanup runs in its
    /// Script's turn (chapter 6, Cancellation and Stop).
    fn cancelClause(g: *Group, s: *Script, body: u32) !void {
        for (s.live.items) |r| {
            if (r.clause_body == null or r.clause_body.? != body) continue;
            try g.cancel(s, r);
        }
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
        for (run.frames.items) |*f| total += frameSize(f);
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
        // holds aside.
        for (run.controls.items) |c| switch (c) {
            .dispatch => |d| {
                total += 96 + costs.size(d.err) + 48;
                total += stackSize(d.owner_stack.items);
                for (d.held) |*f| total += frameSize(f);
            },
            .cleanup => {},
        };
        return total;
    }

    /// The Group's record of a Function Value's code, made once.
    fn functionCode(g: *Group, home: []const u8, library: ?*Library, body: u32) !*FunctionCode {
        for (g.functions.items) |f| if (f.library == library and f.body == body and std.mem.eql(u8, f.home, home)) return f;
        const f = try g.gpa.create(FunctionCode);
        errdefer g.gpa.destroy(f);
        f.* = .{ .home = try g.gpa.dupe(u8, home), .library = library, .body = body };
        try g.functions.append(g.gpa, f);
        return f;
    }

    /// The code of a Function Value this Group made.
    fn codeOf(g: *Group, v: *const Value) ?*FunctionCode {
        if (v.data != .function) return null;
        for (g.functions.items) |f| if (@intFromPtr(f) == v.data.function.identity) return f;
        return null;
    }

    fn functionBody(g: *Group, f: *const FunctionCode) ?lower.Body {
        if (f.library) |l| return l.unit.bodies[f.body];
        const home = g.script(f.home) orelse return null;
        return home.unit.bodies[f.body];
    }

    /// A Function Value: `<function home:where {captures}>`, where `where`
    /// is a Library's name and `:` before its function's name or the
    /// Lambda's position.
    fn functionValue(g: *Group, run: *Run, library: ?*Library, body: u32, where: []const u8, captures: *Value) !*Value {
        const f = try g.functionCode(run.script.name, library, body);
        var shown: std.Io.Writer.Allocating = .init(g.scratch.allocator());
        try shown.writer.print("<function {s}:", .{run.script.name});
        if (library) |l| try shown.writer.print("{s}:", .{l.name});
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
        const n: usize = @intCast(ins.operands[0].int);
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
            var d = try g.newDelivery("", owned, id);
            d.waits = true;
            d.function = fv.retain();
            try g.post(home, d);
            try g.suspendRun(run, "call-value-wait", .{ .id = id, .run = run, .deadline = nanos(g.clock) + @as(i128, run.limits.max_wait_ms) * std.time.ns_per_ms, .order = 0, .after_ms = run.limits.max_wait_ms });
            return .suspended;
        }
        try g.callFunction(run, code.library, code.body, args);
        const callee = &run.frames.items[run.frames.items.len - 1];
        for (fv.data.function.captures.data.map, body.capture_slot..) |p, slot| {
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
            run.fuel += 4;
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
        errdefer {
            for (locals[0..made]) |v| v.release();
            g.gpa.free(locals);
        }
        for (locals, 0..) |*l, i| {
            l.* = if (i >= 1 and i <= args.len) args[i - 1].retain() else try nothing(g.gpa);
            made += 1;
        }
        try run.frames.append(g.gpa, .{ .library = library, .body = body, .pc = b.first, .locals = locals });
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
        /// The Group stopped while it ran, discarding it.
        stopped,
    };

    /// Runs until the bottom frame returns. `charged` is false for the
    /// initialiser, which costs nothing.
    fn execute(g: *Group, run: *Run, charged: bool) !Outcome {
        while (true) {
            _ = g.scratch.reset(.retain_capacity);
            const frame = &run.frames.items[run.frames.items.len - 1];
            const pc = frame.pc;
            if (run.select_at) |at| if (run.frames.items.len == 1 and pc == at) {
                run.select_at = null;
                return .selected;
            };
            // Preemption, only between instructions.
            if (run.base == 0) if (g.preemption(run)) |by| return .{ .preempted = by };
            const ins = unitOf(run, frame).code[pc];
            // The instruction may move the frames, so its unit's name is
            // taken first.
            const at_unit = unitName(run, frame);
            g.driving = .{ .unit = at_unit, .pc = pc, .ins = ins };
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
                error.GroupStop => {
                    // The call that stopped the Group keeps its charge.
                    if (charged) {
                        const spent = costs.charge(costKey(ins, &charge), &charge);
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
            // An instruction charged nothing still pays dispatch's `clause`
            // rate.
            if (charged and charge.uncharged) {
                run.fuel += run.clause_fuel;
                run.clause_fuel = 0;
            }
            if (charged and !charge.uncharged) {
                const key = costKey(ins, &charge);
                var cost = costs.charge(key, &charge);
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
                    if (limit == .alloc and charge.reached_host) {
                        var before = charge;
                        before.result = null;
                        run.fuel += costs.charge(key, &before).fuel + clause_fuel;
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
            g.restoreBase(run);
            run.cleanup_limited = true;
            return g.cleanupFailed(run);
        }
        if (g.trace) |w| {
            w.print("fault {s} limit={s} at={s}:{d} pos={d}:{d}", .{ run.id, @tagName(limit), unit, pc, ins.position.line, ins.position.column }) catch {};
            if (run.segment_base) |base| {
                var first = true;
                for (run.script.variables, base, run.script.unit.variables) |v, b, name| {
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
                if (run.base == 0 and run.clause_fuel + costs.charge("store-var", &none).fuel > fuelLeft(run)) return g.faultOn(.fuel);
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
                const dated = x.data == .instant or x.data == .civil_date or y.data == .instant or y.data == .civil_date;
                if (dated and (op == .add or op == .subtract)) {
                    const r = try g.dateArithmetic(op == .subtract, x, y);
                    m.result = r.retain();
                    try g.push(frame, r);
                    return .next;
                }
                const r = model.arithmetic(gpa, op, x, y) catch |e| return g.arithmeticError(e, x, y);
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
                        for (items, 1..) |item, i| if (try equalFolded(a, x, item, ops.len == 1)) {
                            m.scanned = i;
                            break :blk true;
                        };
                        m.scanned = items.len;
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
                    if (g.guardEntry(run, frame.pc - 1) == null) if (g.objectOf(base)) |o| return g.getProperty(run, frame, o, key, m);
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
                    const colon = std.mem.indexOfScalar(u8, ops[0].text, ':').?;
                    library = importOf(run, frame, ops[0].text[0..colon]) orelse return g.raise("not implemented", &.{});
                    name = ops[0].text[colon + 1 ..];
                    body = library.?.function(name) orelse return g.raise("not implemented", &.{});
                }
                const captures = try model.map(gpa, &.{});
                defer captures.release();
                const v = try g.functionValue(run, library, body, name, captures);
                m.result = v.retain();
                try g.push(frame, v);
            },
            .call_value, .call_value_wait => return g.callValue(run, frame, ins),
            .call_import => {
                // `<library>:<name>`: a function of a Library the unit
                // imports, run in the caller's Run.
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                const colon = std.mem.indexOfScalar(u8, ops[0].text, ':').?;
                const library = importOf(run, frame, ops[0].text[0..colon]) orelse return g.raise("not implemented", &.{});
                const body = library.function(ops[0].text[colon + 1 ..]) orelse return g.raise("not implemented", &.{});
                try g.callFunction(run, library, body, args);
            },
            .call_handler, .call_handler_wait => {
                const n: usize = @intCast(ops[1].int);
                const args = try a.alloc(*Value, n);
                for (0..n) |i| args[n - 1 - i] = pop(frame);
                defer for (args) |v| v.release();
                // The unit's own Handler, or else one it imports.
                const name = ops[0].text;
                var library: ?*Library = frame.library;
                const own = for (unit.bodies) |b| {
                    if (b.kind == .handler and std.mem.eql(u8, b.name, name)) break true;
                } else false;
                if (!own) library = for (importsOf(run, frame)) |l| {
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
                    const code = g.codeOf(args[0]) orelse return g.raise("function gone", &.{});
                    const body = g.functionBody(code) orelse return g.raise("function gone", &.{});
                    const r = if (std.mem.eql(u8, ops[0].text, "functionName"))
                        (if (body.kind == .lambda) try nothing(gpa) else try model.text(gpa, body.name))
                    else blk: {
                        var required: i64 = 0;
                        for (body.params) |p| {
                            if (std.mem.indexOf(u8, p, " = ") == null) required += 1;
                        }
                        const low = try chunks.numberValue(gpa, required);
                        defer low.release();
                        const high = try chunks.numberValue(gpa, @intCast(body.params.len));
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
                if (q.unit.compatible(month) and x.data == .civil_date) {
                    const months = q.unit.toBase(a, q.number) catch return error.OutOfMemory;
                    const n = months.integer(i64) catch return g.incompatible("month", q.unit);
                    return g.addMonths(x, if (subtract) -n else n);
                }
                if (!q.unit.compatible(second)) return g.incompatible(takes, q.unit);
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
                while (i < n) : (i += 1) unit = units.Unit.combine(unit, q.unit, false) catch return g.incompatible(q.unit.string(a, false) catch return error.OutOfMemory, units.Unit.parse("1") catch q.unit);
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
        if (decl.scope.name()) |scope_name| {
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
        if (decl.segment_bound) {
            m.uncharged = true;
            try g.participantConflict(run, granted, &where);
            m.uncharged = false;
            // A failed begin leaves the call's declared cost spent.
            m.declared = decl.cost.fuel;
            m.alloc_extra = decl.cost.alloc;
            try g.enroll(run, granted, &where);
        }

        // A Run that can't cover the declared cost faults before the Host
        // is called.
        // The call's charge before its result: its rate with the declared
        // cost, and dispatch's `clause` rate when it is the first
        // instruction.
        m.declared = decl.cost.fuel;
        m.alloc_extra = decl.cost.alloc;
        const before = costs.charge(costKey(ins, m), m);
        if (run.base == 0 and before.fuel + run.clause_fuel > fuelLeft(run)) return g.faultOn(.fuel);
        if (run.base == 0 and (run.alloc + before.alloc > run.limits.alloc_per_run)) return g.faultOn(.alloc);
        run.calls += 1;
        const id = try std.fmt.allocPrint(a, "{s}.c{d}", .{ run.id, run.calls });
        const left: ?u64 = fuelLeft(run) -| decl.cost.fuel;
        var local: capabilities.Call = .{ .id = id, .script = run.script.name, .grant = grant_name, .binding = granted.grant.binding, .now = g.clock, .left = left, .gpa = g.gpa, .run = run.id, .segment = g.segmentId(run), .scope = decl.scope.name() orelse "" };
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
            g.calls.append(gpa, c) catch |err| {
                gpa.free(c.id);
                gpa.destroy(c);
                return err;
            };
            if (decl.after != null) {
                c.args = try gpa.dupe(*Value, args);
                for (c.args) |v| _ = v.retain();
            }
            break :blk c;
        } else &local;
        const outcome = decl.host.call(decl.host.context, call, args);
        call.starting = false;
        m.reached_host = true;
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
                const after_ms = if (decl.max_pending_ms > 0) decl.max_pending_ms else run.limits.max_wait_ms;
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
                    try g.acknowledge(run, granted, decl.scope, id);
                    return g.hostError(id, grant_name, op_name, &where);
                }
                record(g, id, grant_name, op_name, args, "result", v, call.charged);
                try g.acknowledge(run, granted, decl.scope, id);
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
                // The call's own charge, with its declared cost, is spent;
                // the `Charge` past the limit faults it.
                record(g, id, grant_name, op_name, args, "", null, 0);
                const spent = costs.charge(costKey(ins, m), m);
                run.fuel += spent.fuel;
                run.alloc += spent.alloc;
                return g.faultOn(.fuel);
            },
        }
        return .next;
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
        const outcome = prop.get.call(prop.get.context, gpa, o);
        m.fuel_extra = prop.get_cost.fuel;
        m.alloc_extra = prop.get_cost.alloc;
        switch (outcome) {
            .value => |v| {
                const checked = try capabilities.checkValue(g.scratch.allocator(), gpa, prop.shape, v);
                defer checked.release();
                if (checked.mismatch != null) {
                    v.release();
                    g.propRecord(run, o, key, "get", "error", null);
                    return g.propError(o, key);
                }
                g.propRecord(run, o, key, "get", "value", v);
                // The value's conversion, as a Capability result's.
                const size = costs.size(v);
                m.fuel_extra += (size + 31) / 32;
                m.alloc_extra += size;
                try g.push(frame, v);
                return .next;
            },
            else => {
                g.releasePropResult(outcome);
                g.propRecord(run, o, key, "get", "error", null);
                return g.propError(o, key);
            },
        }
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
        const outcome = set.call(set.context, gpa, o, value);
        m.fuel_extra = prop.set_cost.fuel;
        m.alloc_extra = prop.set_cost.alloc;
        switch (outcome) {
            .done, .value => {
                g.releasePropResult(outcome);
                g.propRecord(run, o, key, "set", "value", value);
                return .next;
            },
            else => {
                g.releasePropResult(outcome);
                g.propRecord(run, o, key, "set", "error", null);
                return g.propError(o, key);
            },
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
    fn propRecord(g: *Group, run: *Run, o: *objects.Object, key: []const u8, op: []const u8, what: []const u8, v: ?*const Value) void {
        const out = g.trace orelse return;
        out.print("prop {s} object=", .{run.id}) catch {};
        display.writeTrace(out, o.value) catch {};
        out.print(" name={s} op={s} {s}=", .{ key, op, what }) catch {};
        if (v) |x| display.writeTrace(out, x) catch {} else out.writeAll("{}") catch {};
        out.writeAll("\n") catch {};
    }

    /// A property's failure raises as an Operation's does, with
    /// `capability` the Object Kind and `operation` the property.
    fn propError(g: *Group, o: *objects.Object, key: []const u8) error{ Raised, OutOfMemory } {
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

/// A Script's code identity (chapter 9).
pub fn codeIdentity(name: []const u8, source: []const u8, kind: enum { script, library }, imports: []const *const Library) [32]u8 {
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
/// Whether a Host may send a message by this name with `count` arguments:
/// one with a `:` must be a Selector of two or more parts, one argument per
/// part (chapter 9, Selectors).
pub fn hostMessageName(name: []const u8, count: usize) bool {
    if (std.mem.indexOfScalar(u8, name, ':') == null) return true;
    return count >= 2 and messageName(name, count);
}

fn messageName(name: []const u8, count: usize) bool {
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

/// The innermost Timeout Block's deadline on a frame's stack.
fn blockDeadline(frame: *const Frame) ?Deadline {
    var i = frame.stack.items.len;
    while (i > 0) {
        i -= 1;
        if (frame.stack.items[i] == .deadline) return frame.stack.items[i].deadline;
    }
    return null;
}

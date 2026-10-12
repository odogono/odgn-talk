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
const literal = @import("literal.zig");
const machine_table = @import("../generated/machine.zig").machine;
const version = @import("../generated/version.zig").version;
const cost_model = @import("../generated/costs.zig").costs;
const Opcode = @import("../generated/opcodes.zig").Opcode;
const Value = model.Value;

/// Something on a frame's operand stack: a Script value, or one of the
/// internal values only instructions see.
pub const Slot = union(enum) {
    value: *Value,
    iterator: *Iterator,
    reader: *binary.Reader,

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
        }
    }
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
    /// For an `error` message: the Run that errored.
    from: ?[]const u8 = null,
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
};

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
    mailbox: std.ArrayList(Delivery) = .empty,
    runs: u64 = 0,
};

/// What a Script is loaded with.
pub const LoadOptions = struct {
    context: check.Context = .{},
};

pub const LoadResult = union(enum) {
    loaded: *Script,
    /// The diagnostics, as `diag` records were written.
    refused: usize,
};

const Input = union(enum) {
    deliver: struct { script: []const u8, delivery: Delivery },
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

    pub fn init(gpa: Allocator, trace: ?*std.Io.Writer) Group {
        return .{ .gpa = gpa, .trace = trace, .scratch = .init(gpa) };
    }

    pub fn deinit(g: *Group) void {
        for (g.inputs.items) |input| switch (input) {
            .deliver => |d| releaseAll(d.delivery.args, g.gpa),
        };
        g.inputs.deinit(g.gpa);
        for (g.scripts.items) |s| {
            for (s.variables) |v| v.release();
            g.gpa.free(s.variables);
            for (s.definitions) |v| v.release();
            g.gpa.free(s.definitions);
            for (s.mailbox.items) |d| {
                releaseAll(d.args, g.gpa);
                g.gpa.free(d.message);
                if (d.during) |x| x.release();
                if (d.from) |x| g.gpa.free(x);
            }
            s.mailbox.deinit(g.gpa);
            for (s.unit.values) |v| if (v == .value) v.value.release();
            s.arena.deinit();
            g.gpa.destroy(s);
        }
        g.scripts.deinit(g.gpa);
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
        const checked = try check.check(a, t, options.context);
        if (checked.diagnostics.len > 0) {
            for (checked.diagnostics) |d| {
                const p = lines.position(d.offset);
                g.write("diag {s} code=\"{s}\" pos={d}:{d}\n", .{ name, d.code.spelling(), p.line, p.column });
            }
            s.arena.deinit();
            g.gpa.destroy(s);
            return .{ .refused = checked.diagnostics.len };
        }
        s.unit = try lower.lower(a, t, &checked, .{ .name = s.name, .context = options.context, .values = g.gpa });
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

    /// A Pump: the queued inputs are written and drained, then each Script
    /// runs its mailbox.
    pub fn pump(g: *Group, clock: model.dates.Instant) !void {
        for (g.inputs.items) |input| switch (input) {
            .deliver => |d| {
                const w = g.trace;
                if (w) |out| {
                    out.print("> {s} d{d} to={s} message={s}", .{ if (d.delivery.request) "request" else "deliver", d.delivery.id, d.script, d.delivery.message }) catch {};
                    if (d.delivery.args.len > 0) {
                        out.writeAll(" args=[") catch {};
                        for (d.delivery.args, 0..) |v, i| {
                            if (i > 0) out.writeAll(", ") catch {};
                            display.writeTrace(out, v) catch {};
                        }
                        out.writeAll("]") catch {};
                    }
                    out.writeAll("\n") catch {};
                }
            },
        };
        const shown = try model.dates.string(g.scratch.allocator(), model.dates.fields(clock), true);
        g.write("> pump clock={s}\n", .{shown});
        g.pump_fuel = 0;
        for (g.inputs.items) |input| switch (input) {
            .deliver => |d| {
                defer g.gpa.free(d.script);
                const s = g.script(d.script) orelse {
                    releaseAll(d.delivery.args, g.gpa);
                    g.gpa.free(d.delivery.message);
                    continue;
                };
                try s.mailbox.append(g.gpa, d.delivery);
            },
        };
        g.inputs.clearRetainingCapacity();
        // Turns: each Script with work, in load order, round and round.
        var busy = true;
        while (busy) {
            busy = false;
            for (g.scripts.items) |s| {
                if (s.mailbox.items.len == 0) continue;
                busy = true;
                const d = s.mailbox.orderedRemove(0);
                try g.dispatch(s, d);
            }
        }
        g.write("pumped state=idle fuel={d}\n", .{g.pump_fuel});
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

    fn dispatch(g: *Group, s: *Script, d: Delivery) !void {
        defer {
            releaseAll(d.args, g.gpa);
            g.gpa.free(d.message);
            if (d.during) |x| x.release();
            if (d.from) |x| g.gpa.free(x);
        }
        // An `error` message with no `on error` is dropped unseen.
        if (d.from != null) {
            const any = for (s.unit.bodies) |b| {
                if (b.kind == .handler and std.mem.eql(u8, b.name, "error")) break true;
            } else false;
            if (!any) return;
        }
        s.runs += 1;
        var id_buf: [64]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_buf, "{s}/r{d}", .{ s.name, s.runs });
        var run: Run = .{ .id = id, .script = s, .delivery = d, .handler = d.message };
        defer run.frames.deinit(g.gpa);
        // Each clause of the Handler, in order, whose parameter count fits.
        var clause: u32 = 0;
        var outcome: Outcome = .unhandled;
        for (s.unit.bodies, 0..) |b, i| {
            if (b.kind != .handler or !std.mem.eql(u8, b.name, d.message)) continue;
            clause += 1;
            if (b.params.len != d.args.len) continue;
            run.clause = clause;
            try g.pushFrame(&run, @intCast(i), d.args);
            if (b.during) |slot| if (d.during) |during| {
                const f = &run.frames.items[run.frames.items.len - 1];
                f.locals[slot].release();
                f.locals[slot] = during.retain();
            };
            // Dispatch charges the clause at the body's first instruction.
            run.fuel += 4;
            outcome = try g.execute(&run, true);
            if (outcome != .clause_failed) break;
            outcome = .unhandled;
        }
        g.pump_fuel += run.fuel;
        const state = g.persistentState(s);
        const w = g.trace;
        const end: []const u8 = switch (outcome) {
            .returned => "return",
            .errored => "error",
            .faulted => "fault",
            .unhandled, .clause_failed => "unhandled",
        };
        if (w) |out| {
            out.print("seg {s} start", .{id}) catch {};
            writeOrigin(out, d);
            out.print(" handler={s}", .{run.handler}) catch {};
            if (outcome != .unhandled and outcome != .clause_failed) out.print(" clause={d}", .{run.clause}) catch {};
            out.print(" fuel={d} alloc={d} state={d} end={s}\n", .{ run.fuel, run.alloc, state, end }) catch {};
            const word: []const u8 = switch (outcome) {
                .returned => "completed",
                .errored => "errored",
                .faulted => "limit-fault",
                .unhandled, .clause_failed => "unhandled",
            };
            out.print("run {s} outcome={s}", .{ id, word }) catch {};
            writeOrigin(out, d);
            out.print(" handler={s}", .{run.handler}) catch {};
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
        }
        switch (outcome) {
            .returned => |v| if (d.request) try g.results.put(g.gpa, d.id, v) else v.release(),
            .errored => |e| {
                // An uncaught error sends the Script its `error` message,
                // unless the Run was handling one.
                if (d.from == null) {
                    const during = try g.messageMap(d);
                    const args = try g.gpa.alloc(*Value, 1);
                    args[0] = e;
                    try s.mailbox.append(g.gpa, .{ .id = 0, .message = try g.gpa.dupe(u8, "error"), .args = args, .request = false, .during = during, .from = try g.gpa.dupe(u8, id) });
                } else e.release();
            },
            else => {},
        }
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
    /// Variables and its mailbox.
    fn persistentState(g: *Group, s: *Script) u64 {
        _ = g;
        var total: u64 = 0;
        for (s.variables) |v| total += costs.size(v);
        for (s.mailbox.items) |d| {
            var contents: u64 = 0;
            for (d.args) |v| contents += costs.size(v);
            total += 32 + contents;
        }
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
            if (charged) {
                const key = costKey(ins, &charge);
                const cost = costs.charge(key, &charge);
                run.fuel += cost.fuel;
                run.alloc += cost.alloc;
                // The default Fuel per Run. Limits and their rollback are
                // step 4's; this bound keeps every Run finite until then.
                if (run.fuel > fuel_per_run) {
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
                    if (run.frames.items.len == 0) return .{ .returned = v };
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
                .returned, .clause_failed, .end_cleanup => unreachable,
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
                const kind: literal.Kind = switch (ins.op) {
                    .contains => .search,
                    .begins_with => .prefix,
                    else => .suffix,
                };
                const r = if (x.data == .bytes and y.data == .bytes)
                    try literal.run(a, try literal.bytes(a, x.data.bytes), try literal.bytes(a, y.data.bytes), kind)
                else blk: {
                    if (x.data != .text) return g.wrongKind("text", x);
                    if (y.data != .text) return g.wrongKind("text", y);
                    break :blk try literal.run(a, try characters(a, x.data.text), try characters(a, y.data.text), kind);
                };
                m.steps = r.steps;
                try g.push(frame, try boolean(gpa, r.found));
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

/// Text split into its Characters.
fn characters(a: Allocator, text: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const end = unicode.grapheme.end(text, i);
        try out.append(a, text[i..end]);
        i = end;
    }
    return out.items;
}

const errors_table = @import("../generated/errors.zig");

fn errorEntry(code: []const u8) ?errors_table.ErrorsTableErrorEntry {
    for (errors_table.errors.@"error") |e| if (std.mem.eql(u8, e.code, code)) return e;
    return null;
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

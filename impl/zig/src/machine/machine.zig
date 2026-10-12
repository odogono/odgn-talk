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

    fn release(self: Slot, gpa: Allocator) void {
        switch (self) {
            .value => |v| v.release(),
            .iterator => |it| {
                if (it.subject) |s| s.release();
                gpa.destroy(it);
            },
        }
    }
};

/// A list or range snapshot and a position, or a count left.
pub const Iterator = struct {
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
            for (s.mailbox.items) |d| releaseAll(d.args, g.gpa);
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
                            display.write(out, v) catch {};
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
        for (g.scripts.items) |s| {
            while (s.mailbox.items.len > 0) {
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
                display.write(w, v) catch {};
            }
            w.writeAll("\n") catch {};
        }
    }

    // ------------------------------------------------------------ dispatch

    fn dispatch(g: *Group, s: *Script, d: Delivery) !void {
        s.runs += 1;
        var id_buf: [64]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_buf, "{s}/r{d}", .{ s.name, s.runs });
        var run: Run = .{ .id = id, .script = s, .delivery = d, .handler = d.message };
        defer run.frames.deinit(g.gpa);
        defer {
            releaseAll(d.args, g.gpa);
            g.gpa.free(d.message);
        }
        // Each clause of the Handler, in order, whose parameter count fits.
        var clause: u32 = 0;
        var outcome: Outcome = .unhandled;
        for (s.unit.bodies, 0..) |b, i| {
            if (b.kind != .handler or !std.mem.eql(u8, b.name, d.message)) continue;
            clause += 1;
            if (b.params.len != d.args.len) continue;
            run.clause = clause;
            try g.pushFrame(&run, @intCast(i), d.args);
            // Dispatch charges the clause at the body's first instruction.
            run.fuel += 4;
            outcome = try g.execute(&run, true);
            if (outcome != .clause_failed) break;
            outcome = .unhandled;
        }
        g.pump_fuel += run.fuel;
        const state = g.persistentState(s);
        switch (outcome) {
            .returned => |v| {
                g.write("seg {s} start delivery=d{d} handler={s} clause={d} fuel={d} alloc={d} state={d} end=return\n", .{ id, d.id, run.handler, run.clause, run.fuel, run.alloc, state });
                if (g.trace) |w| {
                    w.print("run {s} outcome=completed delivery=d{d} handler={s}", .{ id, d.id, run.handler }) catch {};
                    if (v.data != .nothing) {
                        w.writeAll(" value=") catch {};
                        display.write(w, v) catch {};
                    }
                    w.print(" fuel={d} alloc={d}\n", .{ run.fuel, run.alloc }) catch {};
                }
                if (d.request) try g.results.put(g.gpa, d.id, v) else v.release();
            },
            .errored => |e| {
                g.write("seg {s} start delivery=d{d} handler={s} clause={d} fuel={d} alloc={d} state={d} end=error\n", .{ id, d.id, run.handler, run.clause, run.fuel, run.alloc, state });
                if (g.trace) |w| {
                    w.print("run {s} outcome=errored delivery=d{d} handler={s} error=", .{ id, d.id, run.handler }) catch {};
                    display.write(w, e) catch {};
                    w.print(" fuel={d} alloc={d}\n", .{ run.fuel, run.alloc }) catch {};
                }
                e.release();
            },
            .faulted => {
                g.write("seg {s} start delivery=d{d} handler={s} clause={d} fuel={d} alloc={d} state={d} end=fault\n", .{ id, d.id, run.handler, run.clause, run.fuel, run.alloc, state });
                g.write("run {s} outcome=limit-fault delivery=d{d} handler={s} limit=fuel fuel={d} alloc={d}\n", .{ id, d.id, run.handler, run.fuel, run.alloc });
            },
            .unhandled, .clause_failed => {
                g.write("seg {s} start delivery=d{d} handler={s} fuel={d} alloc={d} state={d} end=unhandled\n", .{ id, d.id, run.handler, run.fuel, run.alloc, state });
                g.write("run {s} outcome=unhandled delivery=d{d} handler={s} fuel={d} alloc={d}\n", .{ id, d.id, run.handler, run.fuel, run.alloc });
            },
        }
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
            var done = g.instruction(run, frame, ins, &charge) catch |e| switch (e) {
                error.Raised => blk: {
                    const err = g.pending_error.?;
                    g.pending_error = null;
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
                    if (done == .returned) done.returned.release();
                    if (done == .raised) done.raised.release();
                    g.write("fault {s} limit=fuel at={s}:{d} pos={d}:{d}\n", .{ run.id, run.script.name, pc, ins.position.line, ins.position.column });
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
                    // Step 1 ends the Run; unwinding to a catch comes with
                    // the Unwind Table.
                    g.writeRaise(run, err, pc, ins);
                    while (run.frames.items.len > 0) g.popFrame(run);
                    return .{ .errored = err };
                },
            }
        }
    }

    fn writeRaise(g: *Group, run: *Run, err: *Value, pc: u32, ins: lower.Instruction) void {
        const w = g.trace orelse return;
        const code = err.get("code") orelse return;
        w.print("raise {s} code=", .{run.id}) catch {};
        display.write(w, code) catch {};
        w.print(" at={s}:{d} pos={d}:{d}\n", .{ run.script.name, pc, ins.position.line, ins.position.column }) catch {};
    }

    const Step = union(enum) {
        next,
        returned: *Value,
        clause_failed,
        raised: *Value,
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
                defer v.release();
                if (v.data != .bool) return g.wrongKind("boolean", v);
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
            .contains, .begins_with, .ends_with => {
                const y = pop(frame);
                defer y.release();
                const x = pop(frame);
                defer x.release();
                if (x.data != .text) return g.wrongKind("text", x);
                if (y.data != .text) return g.wrongKind("text", y);
                const r = textSearch(a, x.data.text, y.data.text, ins.op) catch return error.OutOfMemory;
                try g.push(frame, try boolean(gpa, r));
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
                if (ins.op == .property_delimited) {
                    d = pop(frame);
                    delimiter = try g.delimiterText(d.?);
                }
                const base = pop(frame);
                defer base.release();
                var effect: chunks.Effect = .{};
                const r = chunks.property(a, gpa, base, ops[0].text, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, base),
                    else => |other| return other,
                };
                m.input = base.retain();
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
                const r = chunks.set(a, gpa, whole, chunkKind(ops[0].text), index, part, delimiter, &effect) catch |e| switch (e) {
                    error.Raised => return g.raiseChunk(effect, whole),
                    else => |other| return other,
                };
                m.input = part.retain();
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
            .@"return" => return .{ .returned = pop(frame) },
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
    if (x.data == .list and y.data == .list) return @min(x.data.list.len, y.data.list.len);
    return 0;
}

fn textSearch(a: Allocator, text: []const u8, needle: []const u8, op: Opcode) !bool {
    // Whole Characters only: a match starts and ends at Character
    // boundaries of the text.
    const bounds = try boundaries(a, text);
    for (bounds) |start| {
        if (op == .begins_with and start != 0) break;
        if (!std.mem.startsWith(u8, text[start..], needle)) continue;
        const end = start + needle.len;
        const at_boundary = std.mem.indexOfScalar(usize, bounds, end) != null or end == text.len;
        if (!at_boundary) continue;
        if (op == .ends_with and end != text.len) continue;
        return true;
    }
    if (needle.len == 0) return true;
    return false;
}

fn boundaries(a: Allocator, text: []const u8) ![]usize {
    var out: std.ArrayList(usize) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        try out.append(a, i);
        i = unicode.grapheme.end(text, i);
    }
    try out.append(a, text.len);
    return out.items;
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

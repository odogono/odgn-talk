//! The operand stack a code unit's code expects at each instruction (chapter
//! 8; chapter 10, Restoring, control validation): how deep it is, and which
//! of its slots hold the internal values only instructions see. A restore
//! holds each saved frame's stack to it, so a save whose stacks don't fit
//! their code is refused, rather than run into an instruction that finds
//! the wrong thing on its stack.
const std = @import("std");
const Allocator = std.mem.Allocator;
const lower = @import("../lower/lower.zig");
const machine_table = @import("../generated/machine.zig").machine;
const Opcode = @import("../generated/opcodes.zig").Opcode;

/// What a slot holds: a Script value, or an internal value.
pub const Kind = enum(u8) { value, iterator, reader, replacement, deadline };

/// The shape of the stack at each instruction of a unit: null where no
/// path reaches, and `conflict` where two paths disagree.
pub const Shapes = struct {
    at: []?[]const Kind,
    conflicts: usize,
};

/// The stack's shape at each of a unit's instructions, from each body's
/// entry, each Unwind Table target and each offer action entry.
pub fn shapes(a: Allocator, unit: *const lower.Unit) Allocator.Error!Shapes {
    var out: Shapes = .{ .at = try a.alloc(?[]const Kind, unit.code.len), .conflicts = 0 };
    @memset(out.at, null);
    var work: std.ArrayList(u32) = .empty;
    defer work.deinit(a);
    for (unit.bodies) |b| if (b.first < unit.code.len) try reach(a, &out, &work, b.first, &.{});
    while (work.pop()) |pc| {
        const shape = out.at[pc].?;
        // Each Unwind entry over this instruction enters its target with
        // the stack cut to its depth.
        for (unit.unwind) |e| {
            if (pc < e.first or pc > e.last or shape.len < e.depth) continue;
            switch (e.kind) {
                .offer => if (e.target < unit.offers.len) {
                    const r = unit.offers[e.target];
                    for (r.offers) |o| if (o.entry < unit.code.len and shape.len >= r.depth) try reach(a, &out, &work, o.entry, shape[0..r.depth]);
                },
                // A catch's tests start with the error pushed.
                .@"catch" => if (e.target < unit.code.len) {
                    var entered: std.ArrayList(Kind) = .empty;
                    defer entered.deinit(a);
                    try entered.appendSlice(a, shape[0..e.depth]);
                    try entered.append(a, .value);
                    try reach(a, &out, &work, e.target, entered.items);
                },
                .finally, .guard => if (e.target < unit.code.len) try reach(a, &out, &work, e.target, shape[0..e.depth]),
            }
        }
        try step(a, unit, &out, &work, pc, shape);
    }
    return out;
}

fn reach(a: Allocator, out: *Shapes, work: *std.ArrayList(u32), pc: u32, shape: []const Kind) !void {
    if (out.at[pc]) |known| {
        if (!std.mem.eql(Kind, known, shape)) out.conflicts += 1;
        return;
    }
    out.at[pc] = try a.dupe(Kind, shape);
    try work.append(a, pc);
}

/// How many slots an instruction pops, from `machine.toml`.
pub fn popCount(unit: *const lower.Unit, ins: lower.Instruction) ?usize {
    const entry = machine_table.instruction[@backingInt(ins.op)];
    return count(unit, ins, entry.pops);
}

pub fn pushCount(unit: *const lower.Unit, ins: lower.Instruction) ?usize {
    const entry = machine_table.instruction[@backingInt(ins.op)];
    return count(unit, ins, entry.pushes);
}

fn count(unit: *const lower.Unit, ins: lower.Instruction, n: @FieldType(@TypeOf(machine_table.instruction[0]), "pops")) ?usize {
    return switch (n) {
        .int => |x| @intCast(x),
        .text => |t| blk: {
            if (std.mem.eql(u8, t, "event")) {
                const i: usize = @intCast(ins.operands[0].int);
                if (i >= unit.events.len) return null;
                const e = unit.events[i];
                var total: usize = @intFromBool(e.timeout);
                for (e.branches) |b| total += switch (b) {
                    .when => |w| @as(usize, @intFromBool(w.from)) + w.captures,
                    .after => 1,
                };
                break :blk total;
            }
            // `count`, `count + 1` or `count + 2`: the operand named count.
            const entry = machine_table.instruction[@backingInt(ins.op)];
            const at = for (entry.operands, 0..) |o, i| {
                if (std.mem.eql(u8, o, "count")) break i;
            } else return null;
            if (at >= ins.operands.len or ins.operands[at] != .int) return null;
            const base: usize = @intCast(ins.operands[at].int);
            break :blk base + if (std.mem.endsWith(u8, t, "+ 1")) @as(usize, 1) else if (std.mem.endsWith(u8, t, "+ 2")) @as(usize, 2) else 0;
        },
        .boolean => null,
    };
}

/// Whether an instruction never goes on to the next one.
fn ends(op: Opcode) bool {
    return switch (op) {
        .jump, .@"return", .throw, .clause_fail, .raise, .veto, .pass, .catch_accept, .catch_next, .end_cleanup, .choose_offer => true,
        else => false,
    };
}

fn step(a: Allocator, unit: *const lower.Unit, out: *Shapes, work: *std.ArrayList(u32), pc: u32, shape: []const Kind) !void {
    const ins = unit.code[pc];
    const entry = machine_table.instruction[@backingInt(ins.op)];
    const pops = popCount(unit, ins) orelse return;
    const pushes = pushCount(unit, ins) orelse return;
    if (pops > shape.len) {
        out.conflicts += 1;
        return;
    }
    var next: std.ArrayList(Kind) = .empty;
    defer next.deinit(a);
    const popped = shape[0 .. shape.len - pops];
    // The internal values: what each instruction keeps or makes.
    // A label is always an instruction's last operand.
    const labelled = entry.operands.len > 0 and std.mem.eql(u8, entry.operands[entry.operands.len - 1], "label");
    const label: ?u32 = if (labelled and ins.operands.len > 0 and ins.operands[ins.operands.len - 1] == .int) @intCast(ins.operands[ins.operands.len - 1].int) else null;
    switch (ins.op) {
        // These peek at their internal value, and jump with it left alone.
        .next, .replace_next => {
            if (label) |l| if (l < unit.code.len) try reach(a, out, work, l, shape);
            try next.appendSlice(a, shape);
            try next.append(a, .value);
        },
        .iterate, .iterate_times => {
            try next.appendSlice(a, popped);
            try next.append(a, .iterator);
        },
        .replace_start, .replace_put => {
            try next.appendSlice(a, popped);
            try next.append(a, .replacement);
        },
        .bin_start => {
            try next.appendSlice(a, popped);
            try next.append(a, .reader);
        },
        .timeout_start => {
            try next.appendSlice(a, popped);
            try next.append(a, .deadline);
        },
        else => {
            // A jump leaves `jumps` of the popped slots pushed, as they were.
            const kept = popped.len + @as(usize, @intCast(entry.jumps orelse 0));
            if (label) |l| if (l < unit.code.len and kept <= shape.len) try reach(a, out, work, l, shape[0..kept]);
            try next.appendSlice(a, popped);
            for (0..pushes) |_| try next.append(a, .value);
        },
    }
    // The readers' fields keep the reader below what they push.
    switch (ins.op) {
        .bin_literal, .bin_int, .bin_bits, .bin_bytes => next.items[popped.len] = .reader,
        else => {},
    }
    if (!ends(ins.op) and pc + 1 < unit.code.len) try reach(a, out, work, pc + 1, next.items);
}

const testing = std.testing;
const parser = @import("../syntax/parser.zig");
const check = @import("../check/check.zig");

test "every corpus unit's stack has one shape at each instruction" {
    const io = testing.io;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(testing.allocator);
    defer walker.deinit();
    var verified: usize = 0;
    var failed: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.endsWith(u8, entry.basename, ".talk")) {
        const source = try dir.readFileAlloc(io, entry.path, a, .unlimited);
        const parsed = try parser.parse(a, source);
        if (parsed != .tree) continue;
        for ([_]bool{ false, true }) |library| {
            const context: check.Context = .{ .library = library };
            const checked = try check.check(a, &parsed.tree, context);
            if (checked.diagnostics.len > 0) continue;
            const unit = try lower.lower(a, &parsed.tree, &checked, .{ .name = "u", .context = context });
            const s = try shapes(a, &unit);
            if (s.conflicts > 0) {
                std.debug.print("{s}: {d} conflicts\n", .{ entry.path, s.conflicts });
                failed += 1;
            }
            verified += 1;
            break;
        }
    };
    try testing.expect(verified > 300);
    try testing.expectEqual(@as(usize, 0), failed);
}

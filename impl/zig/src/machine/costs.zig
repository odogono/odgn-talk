//! Cost Model 0 (chapter 8): each instruction's Fuel and allocation from its
//! rate's formula, and the logical sizes the Allocation Budget and Persistent
//! State count.
const std = @import("std");
const model = @import("../value.zig");
const unicode = @import("../unicode/unicode.zig");
const rates = @import("../generated/rates.zig");
const Value = model.Value;

/// What one instruction's formulas measure. The values are owned references.
pub const Measures = struct {
    input: ?*Value = null,
    result: ?*Value = null,
    scanned: u64 = 0,
    count: u64 = 0,
    /// A Built-in's rate key, `builtin.<name>`, in place of `call-builtin`'s.
    builtin: []const u8 = "",
    args: []const *Value = &.{},

    pub fn release(self: *Measures) void {
        if (self.input) |v| v.release();
        if (self.result) |v| v.release();
        self.* = .{};
    }
};

pub const Charge = struct { fuel: u64, alloc: u64 };

fn find(key: []const u8) ?*const rates.CostRate {
    var lo: usize = 0;
    var hi: usize = rates.cost_rates.len;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        switch (std.mem.order(u8, rates.cost_rates[mid].key, key)) {
            .eq => return &rates.cost_rates[mid],
            .lt => lo = mid + 1,
            .gt => hi = mid,
        }
    }
    return null;
}

/// An instruction's charge by its rate key.
pub fn charge(key: []const u8, m: *const Measures) Charge {
    var buf: [64]u8 = undefined;
    const full = if (m.builtin.len > 0) std.fmt.bufPrint(&buf, "builtin.{s}", .{m.builtin}) catch key else key;
    const rate = find(full) orelse return .{ .fuel = 0, .alloc = 0 };
    return .{ .fuel = evaluate(rate.fuel, m), .alloc = evaluate(rate.alloc, m) };
}

fn evaluate(terms: []const rates.CostTerm, m: *const Measures) u64 {
    var total: u64 = 0;
    for (terms) |t| {
        const subject: ?*const Value = switch (t.subject) {
            rates.subject_input => m.input,
            rates.subject_result => m.result,
            rates.subject_none => null,
            else => blk: {
                const i: usize = @intCast(t.subject - rates.subject_x1);
                break :blk if (i < m.args.len) m.args[i] else null;
            },
        };
        const measured: u64 = switch (t.measure) {
            rates.measure_constant => 1,
            rates.measure_scanned => m.scanned,
            rates.measure_count => m.count,
            else => if (subject) |v| measure(t.measure, v) else 0,
        };
        const n = @as(u64, @intCast(t.factor)) * measured;
        const d: u64 = @intCast(t.divisor);
        total += (n + d - 1) / d;
    }
    return total;
}

fn measure(which: u8, v: *const Value) u64 {
    return switch (which) {
        rates.measure_size => size(v),
        rates.measure_contents => contents(v),
        rates.measure_characters => if (v.data == .text) unicode.grapheme.count(v.data.text) else 0,
        rates.measure_scalars => if (v.data == .text) scalars(v.data.text) else 0,
        rates.measure_utf8 => if (v.data == .text) v.data.text.len else 0,
        rates.measure_bytes => if (v.data == .bytes) v.data.bytes.len else 0,
        rates.measure_items => items(v),
        rates.measure_entries => if (v.data == .map) v.data.map.len else 0,
        rates.measure_digits => switch (v.data) {
            .number => |n| digits(n.coefficient),
            .quantity => |q| digits(q.number.coefficient),
            else => 0,
        },
        else => 0,
    };
}

fn scalars(text: []const u8) u64 {
    var n: u64 = 0;
    for (text) |b| {
        if (b & 0xc0 != 0x80) n += 1;
    }
    return n;
}

fn digits(c: u128) u64 {
    var n: u64 = 1;
    var x = c;
    while (x >= 10) : (x /= 10) n += 1;
    return n;
}

fn items(v: *const Value) u64 {
    return switch (v.data) {
        .list => |l| l.len,
        .range => |r| blk: {
            const from = if (r.from.data == .number) r.from.data.number.integer(i64) catch break :blk 0 else break :blk 0;
            const to = if (r.to.data == .number) r.to.data.number.integer(i64) catch break :blk 0 else break :blk 0;
            break :blk if (to >= from) @intCast(to - from + 1) else 0;
        },
        else => 0,
    };
}

fn contents(v: *const Value) u64 {
    var total: u64 = 0;
    switch (v.data) {
        .list => |l| for (l) |x| {
            total += size(x);
        },
        .map => |m| for (m) |p| {
            total += 16 + p.key.len + size(p.value);
        },
        .range => |r| total = size(r.from) + size(r.to),
        .function => |f| total = contents(f.captures),
        else => {},
    }
    return total;
}

/// A value's logical size (chapter 8, Logical sizes).
pub fn size(v: *const Value) u64 {
    return switch (v.data) {
        .nothing, .bool => 8,
        .number => 16,
        .quantity => 24,
        .text => |t| 16 + t.len,
        .bytes => |b| 16 + b.len,
        .list => |l| 16 + 8 * l.len + contents(v),
        .map => |m| 16 + 8 * m.len + contents(v),
        .range => 16 + contents(v),
        .instant, .civil_date, .object => 16,
        .pattern => 16,
        .function => |f| 32 + 8 * f.captures.data.list.len + contents(f.captures),
    };
}

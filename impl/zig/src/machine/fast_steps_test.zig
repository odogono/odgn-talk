//! The run loop's fast path for simple instructions (#1289) must leave
//! everything a Host sees as the general loop leaves it: each Script below
//! runs with `fast_steps` on and off, and the two Traces must match byte for
//! byte, across Fuel and allocation limits, Fuel Slices and call depths.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");

const testing = std.testing;

const clock: model.dates.Instant = .{ .seconds = 1790000000, .micros = 0 };

/// `core/loop`'s counting loop: compare, both branches, const, load, store,
/// add and jump, and the compare/branch and add/store pairs.
const loop =
    \\on run n
    \\  put 0 into total
    \\  put 0 into i
    \\  repeat while i < n
    \\    add 1 to i
    \\    add i to total
    \\  end repeat
    \\  return total
    \\end run
    \\
;

/// Shared locals, which an add/store pair must not write through; the other
/// comparisons and arithmetic; Numbers of different exponents; and operands
/// the fast path leaves to the general loop.
const mixed =
    \\on run n
    \\  put 0 into i
    \\  put 0.5 into total
    \\  put "" into log
    \\  repeat until i >= n
    \\    put i into j
    \\    add 1 to i
    \\    add j to total
    \\    put total * 2 into total
    \\    subtract j from total
    \\    put total - 1.25 into total
    \\    if i > 3 then put log & j into log
    \\    if "b" <= "a" then put 0 into total
    \\    if i <= 2 then put [i] into k
    \\  end repeat
    \\  return [total, i, j, k, log]
    \\end run
    \\
;

/// Unit conversion, cancellation and shared aliases, plus exact and rounded
/// division. Keep the original Values observable after each replacement.
const quantities =
    \\on run n
    \\  put 0 into total
    \\  put 0 m into distance
    \\  repeat for each i in 1..n
    \\    put distance into prior
    \\    put (i * 1000 mm) as m into distance
    \\    add distance / 1 m to total
    \\    put distance + 250 mm into distance
    \\    subtract 0.25 m from distance
    \\    put distance * 2 into distance
    \\    put distance / 2 into distance
    \\    put i div 2 into whole
    \\    put i mod 2 into remainder
    \\    put i / 3 into rounded
    \\  end repeat
    \\  return [total, distance, prior, whole, remainder, rounded]
    \\end run
    \\
;

/// Calls and returns: recursion, a call with no arguments (whose result
/// needs room on an empty stack), a parameter default and a Lambda, which the
/// general loop calls and the fast path may return from, and a call depth
/// that grows with `n`.
const calls =
    \\function fib n
    \\  if n < 2 then return n
    \\  return fib(n - 1) + fib(n - 2)
    \\end fib
    \\
    \\function seven
    \\  return 7
    \\end seven
    \\
    \\function scaled x, by = 3
    \\  return x * by
    \\end scaled
    \\
    \\function depth n
    \\  if n < 1 then return 0
    \\  return depth(n - 1) + 1
    \\end depth
    \\
    \\on run n
    \\  put given x: x + seven() into bump
    \\  put 0 into total
    \\  repeat for each i in 1..n
    \\    add fib(i) to total
    \\    add seven() to total
    \\    add scaled(i) to total
    \\    add scaled(i, 2) to total
    \\    put bump(total) into total
    \\  end repeat
    \\  return [total, depth(n)]
    \\end run
    \\
;

const Options = struct {
    fast: bool,
    limits: machine.Limits = .{},
    slice: u64 = 0,
    /// Refuse the Group's Value node allocations from this many after Load.
    refuse_after: ?usize = null,
};

/// Refuses Value node allocations once `left` more have succeeded: the
/// fast path's own allocations are its results' nodes.
const NodeRefusal = struct {
    parent: std.mem.Allocator,
    left: ?usize = null,

    fn allocator(self: *NodeRefusal) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret: usize) ?[*]u8 {
        const self: *NodeRefusal = @ptrCast(@alignCast(ctx));
        if (len == @sizeOf(model.Value)) if (self.left) |*n| {
            if (n.* == 0) return null;
            n.* -= 1;
        };
        return self.parent.rawAlloc(len, alignment, ret);
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) bool {
        const self: *NodeRefusal = @ptrCast(@alignCast(ctx));
        return self.parent.rawResize(memory, alignment, len, ret);
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, len: usize, ret: usize) ?[*]u8 {
        const self: *NodeRefusal = @ptrCast(@alignCast(ctx));
        return self.parent.rawRemap(memory, alignment, len, ret);
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret: usize) void {
        const self: *NodeRefusal = @ptrCast(@alignCast(ctx));
        self.parent.rawFree(memory, alignment, ret);
    }
};

fn trace(gpa: std.mem.Allocator, source: []const u8, n: i64, o: Options) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    var failing: NodeRefusal = .{ .parent = gpa };
    {
        var g: machine.Group = .init(failing.allocator(), &out.writer);
        defer g.deinit();
        g.fast_steps = o.fast;
        try testing.expect(try g.load("s", source, .{ .limits = o.limits }) == .loaded);
        // The Group takes the argument. A Request's Trace shows its value.
        var args = [_]*model.Value{try model.scalar(gpa, .{ .number = model.Decimal.fromInt(n) })};
        _ = try g.deliver("s", "run", &args, true);
        if (o.refuse_after) |k| failing.left = k;
        // A sliced Run takes a Pump per Slice.
        for (0..64) |_| g.pumpWith(clock, o.slice, 0) catch |e| {
            try out.writer.print("pump {t}\n", .{e});
            break;
        };
    }
    return out.toOwnedSlice();
}

fn expectSame(source: []const u8, n: i64, o: Options) !void {
    const gpa = testing.allocator;
    var slow = o;
    slow.fast = false;
    var fast = o;
    fast.fast = true;
    const want = try trace(gpa, source, n, slow);
    defer gpa.free(want);
    const got = try trace(gpa, source, n, fast);
    defer gpa.free(got);
    testing.expectEqualStrings(want, got) catch |e| {
        std.debug.print("options: {any}\n", .{o});
        return e;
    };
}

test "the fast path's Runs match the general loop's to completion" {
    try expectSame(loop, 40, .{ .fast = true });
    try expectSame(mixed, 8, .{ .fast = true });
    try expectSame(quantities, 4, .{ .fast = true });
    try expectSame(calls, 6, .{ .fast = true });
    // Shared locals keep their own values.
    const got = try trace(testing.allocator, mixed, 8, .{ .fast = true });
    defer testing.allocator.free(got);
    try testing.expect(std.mem.indexOf(u8, got, "value=[56.25, 8, 7, [2], \"34567\"]") != null);
    const called = try trace(testing.allocator, calls, 6, .{ .fast = true });
    defer testing.allocator.free(called);
    try testing.expect(std.mem.indexOf(u8, called, "value=[209, 6]") != null);
}

test "the fast path faults where the general loop does on every Fuel and allocation limit" {
    // Every instruction boundary of the first iterations, including those
    // inside a fused pair.
    for (1..260) |fuel| {
        try expectSame(quantities, 4, .{ .fast = true, .limits = .{ .fuel_per_run = fuel } });
        try expectSame(loop, 20, .{ .fast = true, .limits = .{ .fuel_per_run = fuel } });
        try expectSame(mixed, 4, .{ .fast = true, .limits = .{ .fuel_per_run = fuel } });
        try expectSame(calls, 3, .{ .fast = true, .limits = .{ .fuel_per_run = fuel } });
    }
    for (1..200) |alloc| {
        try expectSame(quantities, 4, .{ .fast = true, .limits = .{ .alloc_per_run = alloc } });
        try expectSame(loop, 20, .{ .fast = true, .limits = .{ .alloc_per_run = alloc } });
        try expectSame(mixed, 4, .{ .fast = true, .limits = .{ .alloc_per_run = alloc } });
        try expectSame(calls, 3, .{ .fast = true, .limits = .{ .alloc_per_run = alloc } });
    }
    // Quantity results occupy 24 logical bytes. Reach the later arithmetic
    // and its stores too, checking immediately below and at each 8-byte
    // accounting boundary without reloading for equivalent intermediate caps.
    var alloc: u64 = 200;
    while (alloc <= 1000) : (alloc += 8) {
        try expectSame(quantities, 4, .{ .fast = true, .limits = .{ .alloc_per_run = alloc - 1 } });
        try expectSame(quantities, 4, .{ .fast = true, .limits = .{ .alloc_per_run = alloc } });
    }
}

test "numeric fast steps leave arithmetic errors and finally cleanup to the general loop" {
    const a = testing.allocator;
    for ([_][]const u8{
        "n / 0",                                  "n div 0", "n mod 0",
        "(n * 1 m) + 1 s",                        "n + 1 m", "(n * 1 m) mod 1 m",
        "n * 9999999999999999999999999999999999",
    }) |expression| {
        for ([_]bool{ false, true }) |protected| {
            const source = try std.fmt.allocPrint(a, "on run n\n{s}  return {s}\n{s}end run\n", .{
                if (protected) "  try\n" else "",                                      expression,
                if (protected) "  finally\n    put n / 2 into n\n  end try\n" else "",
            });
            defer a.free(source);
            try expectSame(source, 2, .{ .fast = true });
        }
    }
}

test "the fast path is preempted where the general loop is at every Fuel Slice" {
    for (1..60) |slice| {
        try expectSame(quantities, 4, .{ .fast = true, .slice = slice });
        try expectSame(loop, 20, .{ .fast = true, .slice = slice });
        try expectSame(mixed, 4, .{ .fast = true, .slice = slice });
        try expectSame(calls, 4, .{ .fast = true, .slice = slice });
    }
}

test "fast calls fault on the call depth where the general loop does" {
    // `depth(8)` needs nine frames above `run`'s; each limit below that
    // faults at a different call.
    for (1..12) |limit| try expectSame(calls, 8, .{ .fast = true, .limits = .{ .call_depth = limit } });
}

test "the fast path recovers from a refused result node" {
    // The fast path allocates fewer nodes than the general loop, so the same
    // allocation index refuses different work; physical allocation is not
    // something a Host compares. A refused Run must leak nothing, and any
    // Run that completes must match the unrefused one.
    const gpa = testing.allocator;
    for ([_]struct { []const u8, i64 }{ .{ loop, 20 }, .{ mixed, 4 }, .{ quantities, 4 } }) |case| {
        const want = try trace(gpa, case[0], case[1], .{ .fast = true });
        defer gpa.free(want);
        for (0..80) |k| {
            const got = try trace(gpa, case[0], case[1], .{ .fast = true, .refuse_after = k });
            defer gpa.free(got);
            if (std.mem.indexOf(u8, got, "pump OutOfMemory") == null) try testing.expectEqualStrings(want, got);
        }
    }
}

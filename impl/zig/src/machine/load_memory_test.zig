//! A Load's memory relative to its source (#1403, #1411, #1447, #2206).
const std = @import("std");
const machine = @import("machine.zig");

/// Counts what the backing allocator hands out: live bytes and their peak.
/// It refuses every in-place resize and remap, so each growth is a fresh
/// allocation, a copy and a free on every platform. Whether the backing
/// allocator can grow in place depends on the page size, and the peak with it
/// (#2206).
const Peak = struct {
    child: std.mem.Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *Peak) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = std.mem.Allocator.noResize, .remap = std.mem.Allocator.noRemap, .free = free } };
    }
    fn note(self: *Peak, add: usize, sub: usize) void {
        self.live = self.live + add - sub;
        self.peak = @max(self.peak, self.live);
    }
    fn alloc(ctx: *anyopaque, n: usize, a: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *Peak = @ptrCast(@alignCast(ctx));
        const p = self.child.rawAlloc(n, a, ra) orelse return null;
        self.note(n, 0);
        return p;
    }
    fn free(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, ra: usize) void {
        const self: *Peak = @ptrCast(@alignCast(ctx));
        self.child.rawFree(m, a, ra);
        self.note(0, m.len);
    }
};

test "a Load of many empty Handlers peaks under 62 times its source (#1411, #1447, #1461, #2206)" {
    const gpa = std.testing.allocator;
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(gpa);
    for (0..20_000) |i| try source.print(gpa, "on h{d}\nend h{d}\n", .{ i, i });
    var counted: Peak = .{ .child = gpa };
    var g = machine.Group.init(counted.allocator(), null);
    defer g.deinit();
    _ = try g.load("hostile", source.items, .{});
    const peak = counted.peak / source.items.len;
    const kept = counted.live / source.items.len;
    // Before #1411 a Load peaked at about 181 times its source, and kept 33.
    // Before #1447 it peaked at 85, holding every body's working code until
    // the lowering laid them all out. Before #1461 it peaked at 76, holding
    // the checker's own tables through the lowering. Since #2206 the counter
    // refuses in-place growth, which measures 60.5 and 30.0 on macOS and Linux
    // alike; growing in place had given 60.0 on macOS and 60.6 on Linux.
    std.testing.expect(peak < 62 and kept < 31) catch |e| {
        std.debug.print("peak {d}x, kept {d}x\n", .{ peak, kept });
        return e;
    };
}

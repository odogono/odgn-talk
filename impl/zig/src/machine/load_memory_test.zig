//! A Load's memory relative to its source (#1403, #1411).
const std = @import("std");
const machine = @import("machine.zig");

/// Counts what the backing allocator hands out: live bytes and their peak.
const Peak = struct {
    child: std.mem.Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *Peak) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
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
    fn resize(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, n: usize, ra: usize) bool {
        const self: *Peak = @ptrCast(@alignCast(ctx));
        if (!self.child.rawResize(m, a, n, ra)) return false;
        self.note(n, m.len);
        return true;
    }
    fn remap(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, n: usize, ra: usize) ?[*]u8 {
        const self: *Peak = @ptrCast(@alignCast(ctx));
        const p = self.child.rawRemap(m, a, n, ra) orelse return null;
        self.note(n, m.len);
        return p;
    }
    fn free(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, ra: usize) void {
        const self: *Peak = @ptrCast(@alignCast(ctx));
        self.child.rawFree(m, a, ra);
        self.note(0, m.len);
    }
};

test "a Load of many empty Handlers peaks under 100 times its source (#1411)" {
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
    std.testing.expect(peak < 100 and kept < 31) catch |e| {
        std.debug.print("peak {d}x, kept {d}x\n", .{ peak, kept });
        return e;
    };
}

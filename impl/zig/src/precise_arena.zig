//! An arena whose large allocations are exact (#1411).
//!
//! `std.heap.ArenaAllocator` sizes each new buffer at 1.5 times everything it
//! already holds plus the request, so a few large tables leave as much unused
//! capacity again. In a WASM guest that capacity is linear memory, which never
//! shrinks. This arena gives each allocation of `threshold` bytes or more its
//! own block from the backing allocator, which it can grow, shrink and free.
//! Smaller allocations share an ordinary arena. Everything is released at
//! `deinit`, as with an arena.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

pub const PreciseArena = struct {
    arena: std.heap.ArenaAllocator,
    /// The large blocks, each from the backing allocator.
    big: std.ArrayList(Block) = .empty,

    pub const threshold = 16 * 1024;

    const Block = struct { memory: []u8, alignment: Alignment };

    pub fn init(child: Allocator) PreciseArena {
        return .{ .arena = .init(child) };
    }

    pub fn deinit(self: *PreciseArena) void {
        const child = self.arena.child_allocator;
        for (self.big.items) |b| child.rawFree(b.memory, b.alignment, @returnAddress());
        self.big.deinit(child);
        self.arena.deinit();
        self.* = .init(child);
    }

    pub fn allocator(self: *PreciseArena) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn find(self: *PreciseArena, memory: []u8) ?usize {
        var i = self.big.items.len;
        while (i > 0) {
            i -= 1;
            if (self.big.items[i].memory.ptr == memory.ptr) return i;
        }
        return null;
    }

    fn alloc(ctx: *anyopaque, n: usize, alignment: Alignment, ra: usize) ?[*]u8 {
        const self: *PreciseArena = @ptrCast(@alignCast(ctx));
        if (n < threshold) return self.arena.allocator().rawAlloc(n, alignment, ra);
        const child = self.arena.child_allocator;
        self.big.ensureUnusedCapacity(child, 1) catch return null;
        const p = child.rawAlloc(n, alignment, ra) orelse return null;
        self.big.appendAssumeCapacity(.{ .memory = p[0..n], .alignment = alignment });
        return p;
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: Alignment, n: usize, ra: usize) bool {
        const self: *PreciseArena = @ptrCast(@alignCast(ctx));
        const i = self.find(memory) orelse {
            // A small allocation stays in the arena; outgrowing it moves.
            if (n >= threshold) return false;
            return self.arena.allocator().rawResize(memory, alignment, n, ra);
        };
        if (!self.arena.child_allocator.rawResize(memory, alignment, n, ra)) return false;
        self.big.items[i].memory = memory.ptr[0..n];
        return true;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, n: usize, ra: usize) ?[*]u8 {
        const self: *PreciseArena = @ptrCast(@alignCast(ctx));
        const i = self.find(memory) orelse {
            if (n >= threshold) return null;
            return self.arena.allocator().rawRemap(memory, alignment, n, ra);
        };
        const p = self.arena.child_allocator.rawRemap(memory, alignment, n, ra) orelse return null;
        self.big.items[i].memory = p[0..n];
        return p;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: Alignment, ra: usize) void {
        const self: *PreciseArena = @ptrCast(@alignCast(ctx));
        const i = self.find(memory) orelse return self.arena.allocator().rawFree(memory, alignment, ra);
        self.arena.child_allocator.rawFree(memory, alignment, ra);
        _ = self.big.swapRemove(i);
    }
};

test "large allocations are exact, grow in place or move, and are freed" {
    const t = std.testing;
    var arena: PreciseArena = .init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const small = try a.alloc(u8, 64);
    @memset(small, 1);
    var list: std.ArrayList(u32) = .empty;
    for (0..100_000) |i| try list.append(a, @intCast(i));
    try t.expectEqual(@as(usize, 1), arena.big.items.len);
    try t.expectEqual(list.capacity * @sizeOf(u32), arena.big.items[0].memory.len);
    for (list.items, 0..) |v, i| try t.expectEqual(@as(u32, @intCast(i)), v);
    const block = try a.alloc(u8, PreciseArena.threshold);
    try t.expectEqual(@as(usize, 2), arena.big.items.len);
    a.free(block);
    try t.expectEqual(@as(usize, 1), arena.big.items.len);
    list.deinit(a);
    try t.expectEqual(@as(usize, 0), arena.big.items.len);
    try t.expectEqual(@as(u8, 1), small[63]);
}

test "deinit releases what is still held, and the arena is reusable" {
    const t = std.testing;
    var arena: PreciseArena = .init(t.allocator);
    _ = try arena.allocator().alloc(u8, 1 << 20);
    _ = try arena.allocator().alloc(u8, 10);
    arena.deinit();
    _ = try arena.allocator().alloc(u8, 1 << 20);
    arena.deinit();
}

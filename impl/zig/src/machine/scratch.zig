//! Instruction scratch reset, specialized for the pinned Zig 0.17 arena.
const std = @import("std");
const Arena = std.heap.ArenaAllocator;

/// An empty arena, or one already-empty buffer with no free list, is a
/// fixed point of retain_capacity. Avoid its capacity walks and stores.
/// Every other state takes the standard reset, including after failed growth
/// or consolidation. Like Arena.reset, this requires exclusive access.
pub inline fn reset(arena: *Arena) void {
    if (arena.state.free_list == null) {
        if (arena.state.used_list) |node| {
            if (node.end_index == 0 and node.next == null) return;
        } else return;
    }
    _ = arena.reset(.retain_capacity);
}

test "scratch reset preserves empty capacity and reuses a dirty buffer" {
    const t = std.testing;
    var parent: t.FailingAllocator = .init(t.allocator, .{});
    var arena: Arena = .init(parent.allocator());
    defer arena.deinit();
    reset(&arena);
    try t.expectEqual(@as(usize, 0), parent.allocations);
    const a = arena.allocator();
    const first = try a.alloc(u8, 64);
    @memset(first, 0xab);
    const capacity = arena.queryCapacity();
    reset(&arena);
    const node = arena.state.used_list.?;
    try t.expectEqual(@as(usize, 0), node.end_index);
    parent.fail_index = parent.alloc_index;
    for (0..10) |_| reset(&arena);
    try t.expectEqual(node, arena.state.used_list.?);
    try t.expectEqual(capacity, arena.queryCapacity());
    const second = try a.alloc(u8, 64);
    try t.expectEqual(first.ptr, second.ptr);
    // Freeing the last allocation may also leave an already-empty buffer.
    a.free(second);
    reset(&arena);
    try t.expectEqual(capacity, arena.queryCapacity());
    try t.expectEqual(first.ptr, (try a.alloc(u8, 64)).ptr);
    try t.expect(!parent.has_induced_failure);
}

test "scratch reset consolidates chains and recovers from allocation refusal" {
    const t = std.testing;
    for ([_]bool{ false, true }) |refuse| {
        var parent: t.FailingAllocator = .init(t.allocator, .{ .resize_fail_index = 0 });
        var arena: Arena = .init(parent.allocator());
        defer arena.deinit();
        const a = arena.allocator();
        _ = try a.alloc(u8, 64);
        _ = try a.alloc(u8, 4096);
        try t.expect(arena.state.used_list.?.next != null);
        if (refuse) parent.fail_index = parent.alloc_index;
        reset(&arena);
        try t.expectEqual(refuse, parent.has_induced_failure);
        try t.expect(arena.state.used_list.?.next == null);
        try t.expectEqual(@as(usize, 0), arena.state.used_list.?.end_index);
        // A failed preheat leaves a usable, empty last buffer. Repeated
        // boundaries must neither allocate nor retry the failed preheat.
        const requests = parent.allocations;
        reset(&arena);
        _ = try a.alloc(u8, 1);
        try t.expectEqual(requests, parent.allocations);
        if (refuse) {
            try t.expectError(error.OutOfMemory, a.alloc(u8, 16384));
            reset(&arena);
            _ = try a.alloc(u8, 1);
        }
    }
}

test "scratch reset also clears a free-list buffer" {
    const t = std.testing;
    var arena: Arena = .init(t.allocator);
    defer arena.deinit();
    var spare: Arena = .init(t.allocator);
    defer spare.deinit();
    _ = try arena.allocator().alloc(u8, 64);
    reset(&arena);
    _ = try spare.allocator().alloc(u8, 128);
    // The arena can retain unused candidate buffers on its free list.
    // Transfer ownership to exercise that path with a clean used buffer.
    arena.state.free_list = spare.state.used_list;
    spare.state = .init;
    const capacity = arena.queryCapacity();
    reset(&arena);
    try t.expectEqual(@as(usize, 0), arena.state.free_list.?.end_index);
    try t.expectEqual(capacity, arena.queryCapacity());
}

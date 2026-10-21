//! The process-wide allocator: `smp_allocator` natively, and on wasm a heap
//! for large blocks over `wasm_allocator` (#1447). `wasm_allocator` gives a
//! large block a power-of-two run of pages and reuses a freed run only for
//! the same power, so a buffer that grows leaves a freed run at every size
//! it passed through, and the guest's memory outgrows the native peak. Here
//! a large block takes exactly the pages it needs. A freed run merges with
//! free neighbours, any free run that fits is reused, and a block grows in
//! place into a free run after it or at the top of memory. Small blocks keep
//! `wasm_allocator`'s size classes.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

pub const allocator: Allocator = if (builtin.target.cpu.arch.isWasm())
    .{ .ptr = &guest, .vtable = &Heap(LinearMemory).vtable }
else
    std.heap.smp_allocator;

var guest: Heap(LinearMemory) = .{ .memory = .{}, .small = std.heap.wasm_allocator };

const page_size = 64 * 1024;

/// Memory 0, counted in pages, so a full 4 GiB memory's end still fits a
/// wasm32 `usize`.
const LinearMemory = struct {
    fn top(_: *LinearMemory) usize {
        return @wasmMemorySize(0);
    }
    fn grow(_: *LinearMemory, pages: usize) bool {
        return @wasmMemoryGrow(0, pages) >= 0;
    }
};

/// Whether `wasm_allocator` would give these bytes whole pages: its size
/// classes end at half a page, counting a free-list word.
fn isLarge(len: usize, alignment: Alignment) bool {
    return @max(len +| @sizeOf(usize), alignment.toByteUnits()) > page_size / 2;
}

fn pagesFor(len: usize) usize {
    return (len -| 1) / page_size + 1;
}

/// Large blocks in whole pages of `Memory`, which reports its `top` page and
/// can `grow` by pages there; small ones go to `small`. Single-threaded.
fn Heap(comptime Memory: type) type {
    return struct {
        const Self = @This();

        memory: Memory,
        small: Allocator,
        /// Free runs in address order, never adjacent, each holding its
        /// header in its first page.
        free_runs: ?*Run = null,

        const Run = struct { pages: usize, next: ?*Run };

        const vtable: Allocator.VTable = .{ .alloc = alloc, .resize = resize, .remap = remap, .free = free };

        fn start(run: *Run) usize {
            return @intFromPtr(run) / page_size;
        }

        fn runAt(page: usize) *Run {
            return @ptrFromInt(page * page_size);
        }

        fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, ret_addr: usize) ?[*]u8 {
            const self: *Self = @ptrCast(@alignCast(ctx));
            if (!isLarge(len, alignment)) return self.small.rawAlloc(len, alignment, ret_addr);
            if (alignment.toByteUnits() > page_size) return null;
            const page = self.take(pagesFor(len)) orelse return null;
            return @ptrFromInt(page * page_size);
        }

        fn resize(ctx: *anyopaque, buf: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) bool {
            const self: *Self = @ptrCast(@alignCast(ctx));
            const large = isLarge(buf.len, alignment);
            if (large != isLarge(new_len, alignment)) return false;
            if (!large) return self.small.rawResize(buf, alignment, new_len, ret_addr);
            const first = @intFromPtr(buf.ptr) / page_size;
            const old = pagesFor(buf.len);
            const new = pagesFor(new_len);
            if (new < old) self.release(first + new, old - new);
            return new <= old or self.extend(first + old, new - old);
        }

        fn remap(ctx: *anyopaque, buf: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
            if (!isLarge(buf.len, alignment)) {
                if (isLarge(new_len, alignment)) return null;
                const self: *Self = @ptrCast(@alignCast(ctx));
                return self.small.rawRemap(buf, alignment, new_len, ret_addr);
            }
            return if (resize(ctx, buf, alignment, new_len, ret_addr)) buf.ptr else null;
        }

        fn free(ctx: *anyopaque, buf: []u8, alignment: Alignment, ret_addr: usize) void {
            const self: *Self = @ptrCast(@alignCast(ctx));
            if (!isLarge(buf.len, alignment)) return self.small.rawFree(buf, alignment, ret_addr);
            self.release(@intFromPtr(buf.ptr) / page_size, pagesFor(buf.len));
        }

        /// The first page of `n` pages: the lowest free run that fits, else
        /// the last free run extended at the top, else new pages.
        fn take(self: *Self, n: usize) ?usize {
            var link = &self.free_runs;
            while (link.*) |run| : (link = &run.next) {
                const page = start(run);
                if (run.pages < n) {
                    if (run.next != null or page + run.pages != self.memory.top()) continue;
                    if (!self.memory.grow(n - run.pages)) return null;
                    link.* = null;
                    return page;
                }
                link.* = self.split(run, n);
                return page;
            }
            const page = self.memory.top();
            return if (self.memory.grow(n)) page else null;
        }

        /// Gives `extra` pages from `end` to the block ending there, from a
        /// free run starting there or by growing memory at the top.
        fn extend(self: *Self, end: usize, extra: usize) bool {
            var link = &self.free_runs;
            while (link.*) |run| : (link = &run.next) {
                const page = start(run);
                if (page < end) continue;
                if (page > end) break;
                if (run.pages >= extra) {
                    link.* = self.split(run, extra);
                    return true;
                }
                if (page + run.pages != self.memory.top() or !self.memory.grow(extra - run.pages)) return false;
                link.* = null;
                return true;
            }
            return end == self.memory.top() and self.memory.grow(extra);
        }

        /// What follows `run` once its first `n` pages are taken.
        fn split(_: *Self, run: *Run, n: usize) ?*Run {
            if (run.pages == n) return run.next;
            const rest = runAt(start(run) + n);
            rest.* = .{ .pages = run.pages - n, .next = run.next };
            return rest;
        }

        /// Frees `n` pages from `first`, merged with free neighbours.
        fn release(self: *Self, first: usize, n: usize) void {
            var before: ?*Run = null;
            var after = self.free_runs;
            while (after) |run| : (after = run.next) {
                if (start(run) > first) break;
                before = run;
            }
            const run = runAt(first);
            run.* = .{ .pages = n, .next = after };
            if (after) |next| if (first + n == start(next)) {
                run.pages += next.pages;
                run.next = next.next;
            };
            if (before) |previous| {
                if (start(previous) + previous.pages == first) {
                    previous.pages += run.pages;
                    previous.next = run.next;
                } else previous.next = run;
            } else self.free_runs = run;
        }
    };
}

/// Pages from a fixed buffer, standing in for linear memory.
const TestMemory = struct {
    buffer: []align(page_size) u8,
    used: usize = 0,

    fn top(self: *TestMemory) usize {
        return @intFromPtr(self.buffer.ptr) / page_size + self.used;
    }
    fn grow(self: *TestMemory, pages: usize) bool {
        if (self.used + pages > self.buffer.len / page_size) return false;
        self.used += pages;
        return true;
    }
};

const TestHeap = Heap(TestMemory);

fn testHeap(pages: usize) !TestHeap {
    const buffer = try std.testing.allocator.alignedAlloc(u8, .fromByteUnits(page_size), pages * page_size);
    return .{ .memory = .{ .buffer = buffer }, .small = std.testing.allocator };
}

fn freeRuns(heap: *TestHeap) usize {
    var n: usize = 0;
    var run = heap.free_runs;
    while (run) |r| : (run = r.next) n += 1;
    return n;
}

test "a block at the top grows in place" {
    var heap = try testHeap(16);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    const block = try gpa.alloc(u8, 3 * page_size);
    const grown = gpa.remap(block, 9 * page_size - 1) orelse return error.Moved;
    try std.testing.expectEqual(block.ptr, grown.ptr);
    try std.testing.expectEqual(9, heap.memory.used);
    gpa.free(grown);
}

test "freed neighbours merge and are reused" {
    var heap = try testHeap(16);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    const a = try gpa.alloc(u8, 2 * page_size);
    const b = try gpa.alloc(u8, 3 * page_size);
    const c = try gpa.alloc(u8, 4 * page_size);
    const d = try gpa.alloc(u8, page_size);
    gpa.free(a);
    gpa.free(c);
    try std.testing.expectEqual(2, freeRuns(&heap));
    gpa.free(b);
    try std.testing.expectEqual(1, freeRuns(&heap));
    const merged = try gpa.alloc(u8, 9 * page_size);
    try std.testing.expectEqual(a.ptr, merged.ptr);
    try std.testing.expectEqual(10, heap.memory.used);
    gpa.free(merged);
    gpa.free(d);
    try std.testing.expectEqual(1, freeRuns(&heap));
    try std.testing.expectEqual(10, heap.free_runs.?.pages);
}

test "a block grows into the free run after it and shrinks back" {
    var heap = try testHeap(16);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    const a = try gpa.alloc(u8, page_size);
    const b = try gpa.alloc(u8, 4 * page_size);
    const c = try gpa.alloc(u8, page_size);
    gpa.free(b);
    try std.testing.expect(gpa.resize(a, 3 * page_size));
    try std.testing.expect(!gpa.resize(a.ptr[0 .. 3 * page_size], 6 * page_size));
    try std.testing.expect(gpa.resize(a.ptr[0 .. 3 * page_size], 5 * page_size));
    try std.testing.expectEqual(null, heap.free_runs);
    try std.testing.expect(gpa.resize(a.ptr[0 .. 5 * page_size], 2 * page_size));
    try std.testing.expectEqual(3, heap.free_runs.?.pages);
    gpa.free(a.ptr[0 .. 2 * page_size]);
    gpa.free(c);
    try std.testing.expectEqual(6, heap.free_runs.?.pages);
    try std.testing.expectEqual(6, heap.memory.used);
}

test "the last free run extends at the top" {
    var heap = try testHeap(16);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    const a = try gpa.alloc(u8, page_size);
    const b = try gpa.alloc(u8, 2 * page_size);
    gpa.free(b);
    const c = try gpa.alloc(u8, 5 * page_size);
    try std.testing.expectEqual(b.ptr, c.ptr);
    try std.testing.expectEqual(6, heap.memory.used);
    try std.testing.expectError(error.OutOfMemory, gpa.alloc(u8, 11 * page_size));
    gpa.free(a);
    gpa.free(c);
}

test "a growing list needs no more pages than its capacity" {
    var heap = try testHeap(64);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(gpa);
    for (0..40 * page_size) |i| try list.append(gpa, @truncate(i));
    try std.testing.expectEqual(pagesFor(list.capacity), heap.memory.used);
}

test "standard allocator tests" {
    var heap = try testHeap(256);
    defer std.testing.allocator.free(heap.memory.buffer);
    const gpa: Allocator = .{ .ptr = &heap, .vtable = &TestHeap.vtable };
    try std.heap.testAllocator(gpa);
    try std.heap.testAllocatorAligned(gpa);
    try std.heap.testAllocatorAlignedShrink(gpa);
}

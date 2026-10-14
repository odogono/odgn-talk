//! A Group's allocator (#625's memory decision): every byte a Group holds
//! comes through it, from an allocator the Host supplies. Logical
//! allocation is charged by Cost Model 0 elsewhere; this counts physical
//! bytes and enforces a physical cap, so a Core defect that outgrows the
//! logical budgets becomes a refusal, never a crashed process.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;
const model = @import("../value.zig");

/// The default physical cap: far above what the logical budgets allow a
/// Group, so only a defect reaches it.
pub const default_cap: usize = 256 << 20;

/// The most freed Value nodes a Group keeps for reuse (#878). Temporary
/// scalars are nearly all of a Run's allocations and few are live at once,
/// so a small cache absorbs the churn. Retained nodes count in `used`, so
/// the cap still bounds everything a Group holds.
const max_cached_values: usize = 128;
const value_size = @sizeOf(model.Value);
const value_alignment: Alignment = .fromByteUnits(@alignOf(model.Value));

pub const GroupAllocator = struct {
    parent: Allocator,
    lock: @import("queue_lock.zig").Lock = .{},
    cap: usize,
    /// Bytes the Group holds now, and the most it has held. The Value
    /// cache below is held memory, so it is included.
    used: usize = 0,
    peak: usize = 0,
    /// Whether an allocation has been refused: past the cap, or by the
    /// parent. The Group's state may then be partial, so it takes no more
    /// work.
    refused: bool = false,
    /// Freed Value nodes available for reuse, linked through their first
    /// word, at most `max_cached_values` of them.
    cached_values: ?[*]u8 = null,
    cached_value_count: usize = 0,

    pub fn init(parent: Allocator, cap: usize) GroupAllocator {
        return .{ .parent = parent, .cap = if (cap == 0) default_cap else cap };
    }

    /// Returns every cached Value node to the parent. The owner calls this
    /// once the Group is gone; nothing may allocate through here after.
    pub fn deinit(self: *GroupAllocator) void {
        self.flushValues();
    }

    fn flushValues(self: *GroupAllocator) void {
        while (self.cached_values) |block| {
            self.cached_values = @as(*?[*]u8, @ptrCast(@alignCast(block))).*;
            self.parent.rawFree(block[0..value_size], value_alignment, @returnAddress());
            self.used -= value_size;
        }
        self.cached_value_count = 0;
    }

    fn isValueNode(len: usize, alignment: Alignment) bool {
        return len == value_size and alignment == value_alignment;
    }

    pub fn allocator(self: *GroupAllocator) Allocator {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: Allocator.VTable = .{ .alloc = alloc, .resize = resize, .remap = remap, .free = free };

    /// Whether `more` bytes fit under the cap, recording a refusal if not.
    fn admit(self: *GroupAllocator, more: usize) bool {
        if (more > self.cap - self.used) {
            self.refused = true;
            return false;
        }
        return true;
    }

    fn grew(self: *GroupAllocator, more: usize) void {
        self.used += more;
        self.peak = @max(self.peak, self.used);
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, ret_addr: usize) ?[*]u8 {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
        self.lock.lock();
        defer self.lock.unlock();
        // A cached node is already counted in `used`, so reusing one
        // neither grows the Group nor reaches the parent.
        if (isValueNode(len, alignment)) {
            if (self.cached_values) |block| {
                self.cached_values = @as(*?[*]u8, @ptrCast(@alignCast(block))).*;
                self.cached_value_count -= 1;
                return block;
            }
        }
        // Retained nodes must never cause a refusal other memory could
        // have avoided: give them back before deciding the cap is hit.
        if (len > self.cap - self.used and self.cached_value_count != 0) self.flushValues();
        if (!self.admit(len)) return null;
        const p = self.parent.rawAlloc(len, alignment, ret_addr) orelse {
            self.refused = true;
            return null;
        };
        self.grew(len);
        return p;
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) bool {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
        self.lock.lock();
        defer self.lock.unlock();
        if (new_len > memory.len and new_len - memory.len > self.cap - self.used and self.cached_value_count != 0) self.flushValues();
        if (new_len > memory.len and !self.admit(new_len - memory.len)) return false;
        if (!self.parent.rawResize(memory, alignment, new_len, ret_addr)) return false;
        self.settle(memory.len, new_len);
        return true;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
        self.lock.lock();
        defer self.lock.unlock();
        if (new_len > memory.len and new_len - memory.len > self.cap - self.used and self.cached_value_count != 0) self.flushValues();
        if (new_len > memory.len and !self.admit(new_len - memory.len)) return null;
        const p = self.parent.rawRemap(memory, alignment, new_len, ret_addr) orelse return null;
        self.settle(memory.len, new_len);
        return p;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: Alignment, ret_addr: usize) void {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
        self.lock.lock();
        defer self.lock.unlock();
        if (isValueNode(memory.len, alignment) and self.cached_value_count < max_cached_values) {
            @as(*?[*]u8, @ptrCast(@alignCast(memory.ptr))).* = self.cached_values;
            self.cached_values = memory.ptr;
            self.cached_value_count += 1;
            return;
        }
        self.parent.rawFree(memory, alignment, ret_addr);
        self.used -= memory.len;
    }

    fn settle(self: *GroupAllocator, old: usize, new: usize) void {
        if (new > old) self.grew(new - old) else self.used -= old - new;
    }
};

test "the cap refuses an allocation past it, and frees count back" {
    var g: GroupAllocator = .init(std.testing.allocator, 1024);
    const a = g.allocator();
    const first = try a.alloc(u8, 1000);
    try std.testing.expectEqual(@as(usize, 1000), g.used);
    try std.testing.expectError(error.OutOfMemory, a.alloc(u8, 100));
    try std.testing.expect(g.refused);
    a.free(first);
    try std.testing.expectEqual(@as(usize, 0), g.used);
    try std.testing.expectEqual(@as(usize, 1000), g.peak);
    // Growing in place is held to the cap too.
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(a);
    const small: [512]u8 = @splat(0);
    const large: [600]u8 = @splat(0);
    try list.appendSlice(a, &small);
    try std.testing.expectError(error.OutOfMemory, list.appendSlice(a, &large));
    try std.testing.expect(g.used <= 1024);
}

test "freed Value nodes are reused from a bounded cache counted in used" {
    var memory: GroupAllocator = .init(std.testing.allocator, 1 << 20);
    const a = memory.allocator();
    const first = try model.scalar(a, .nothing);
    const address = @intFromPtr(first);
    first.release();
    // The retained node still counts against the Group's physical memory.
    try std.testing.expectEqual(@sizeOf(model.Value), memory.used);
    const second = try model.scalar(a, .{ .bool = true });
    try std.testing.expectEqual(address, @intFromPtr(second));
    try std.testing.expect(second.data.bool);
    second.release();
    // Repeated churn retains no more than the cache bound.
    for (0..1000) |_| {
        const v = try model.scalar(a, .nothing);
        v.release();
    }
    try std.testing.expect(memory.used <= max_cached_values * @sizeOf(model.Value));
    // Other sizes are never cached.
    const scratch = try a.alloc(u8, 100);
    a.free(scratch);
    memory.deinit();
    try std.testing.expectEqual(@as(usize, 0), memory.used);
}

test "cap pressure flushes the Value cache instead of refusing" {
    var memory: GroupAllocator = .init(std.testing.allocator, @sizeOf(model.Value) + 512);
    defer memory.deinit();
    const a = memory.allocator();
    const v = try model.scalar(a, .nothing);
    v.release();
    try std.testing.expectEqual(@sizeOf(model.Value), memory.used);
    const big = try a.alloc(u8, 512);
    defer a.free(big);
    try std.testing.expect(!memory.refused);
}

test "Map updates obey the Group physical cap and leave the prior root intact on refusal" {
    var memory: GroupAllocator = .init(std.testing.allocator, 16 << 10);
    {
        const gpa = memory.allocator();
        const item = try model.scalar(gpa, .nothing);
        defer item.release();
        var root = try model.map(gpa, &.{});
        defer root.release();
        var refused = false;
        for (0..1000) |i| {
            var buffer: [20]u8 = undefined;
            const key = try std.fmt.bufPrint(&buffer, "{d}", .{i});
            const old = root;
            model.mapSet(&root, key, item) catch |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                try std.testing.expectEqual(old, root);
                try std.testing.expectEqual(i, root.data.map.len);
                try std.testing.expect(root.get(key) == null);
                refused = true;
                break;
            };
        }
        try std.testing.expect(refused and memory.refused);
        try std.testing.expect(memory.used <= memory.cap and memory.peak <= memory.cap);
    }
    memory.deinit(); // Only the bounded Value cache remains to give back.
    try std.testing.expectEqual(@as(usize, 0), memory.used);
}

test "a Group past its cap refuses mid-Pump and gives back every byte" {
    const machine = @import("machine.zig");
    var memory: GroupAllocator = .init(std.testing.allocator, 256 * 1024);
    defer memory.deinit();
    var group: machine.Group = .init(memory.allocator(), null);
    defer group.deinit();
    const source = "script variable s\non grow\n  put \"x\" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n";
    _ = try group.load("hog", source, .{});
    _ = try group.deliver("hog", "grow", &.{}, false);
    try std.testing.expectError(error.OutOfMemory, group.pump(.{ .seconds = 1790000000, .nanos = 0 }));
    try std.testing.expect(memory.refused);
}

test "large loads retain source and code, not compiler working storage" {
    const machine = @import("machine.zig");
    const gpa = std.testing.allocator;
    var memory: GroupAllocator = .init(gpa, 64 << 20);
    defer memory.deinit();
    var group: machine.Group = .init(memory.allocator(), null);
    defer group.deinit();
    const blank = try gpa.alloc(u8, 100_000);
    defer gpa.free(blank);
    @memset(blank, '\n');
    const before = memory.used;
    _ = try group.load("blank", blank, .{});
    try std.testing.expect(memory.used - before < blank.len * 2 + (64 << 10));

    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(gpa);
    const count = 1000;
    for (0..count) |i| {
        const handler = try std.fmt.allocPrint(gpa, "on h{d}\nend h{d}\n", .{ i, i });
        defer gpa.free(handler);
        try source.appendSlice(gpa, handler);
    }
    const loaded = memory.used;
    _ = try group.load("handlers", source.items, .{});
    try std.testing.expect(memory.used - loaded < source.items.len * 2 + count * 768);
    // Dispatch both ends of the body table after temporary storage is gone.
    _ = try group.deliver("handlers", "h0", &.{}, false);
    _ = try group.deliver("handlers", "h999", &.{}, false);
    try group.pump(.{ .seconds = 1790000000, .nanos = 0 });

    const script = group.script("handlers").?;
    const extending = memory.used;
    try std.testing.expectEqual(machine.Group.ExtendResult.extended, try group.extend(script, blank));
    try std.testing.expect(memory.used - extending < blank.len * 2 + (64 << 10));
    const reloading = memory.used;
    try std.testing.expectEqual(machine.Group.ReloadResult.reloaded, try group.reload(script, blank, false, false));
    try std.testing.expect(memory.used <= reloading);

    // Libraries use the same compiler storage policy, including a retained
    // source for replacement and save/restore.
    var libraries: GroupAllocator = .init(gpa, 64 << 20);
    defer libraries.deinit();
    const compiled = try machine.compileLibrary(libraries.allocator(), "lib", "1", blank, &.{}, null);
    const library = compiled.library;
    defer library.destroy();
    try std.testing.expect(libraries.used < blank.len * 2 + (64 << 10));
}

fn compileAllocations(a: Allocator) !void {
    const machine = @import("machine.zig");
    const compiled = try machine.compileLibrary(a, "lib", "1", "constant k = [1, 2]\nfunction twice x\n  return x * 2\nend twice\n", &.{}, null);
    defer compiled.library.destroy();
}

test "Library compilation frees code and Values on every allocation refusal" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, compileAllocations, .{});
}

test "a refusal at any allocation leaves nothing behind" {
    const machine = @import("machine.zig");
    const caller =
        \\script variable log = []
        \\on go n
        \\  try
        \\    put [n, {a: n & "x", b: [1, 2, 3]}] after log
        \\    repeat for each i in 1..12 collecting [i, ...[n]] into collected
        \\    end repeat
        \\    put collected into snapshot
        \\    put collected into item -1 of collected
        \\    put collected into item 1 of log
        \\    send note with n to callee and wait
        \\    put it after log
        \\    throw {code: "boom", n: n}
        \\  catch e
        \\    put e after log
        \\  finally
        \\    put "done" after log
        \\  end try
        \\end go
        \\on watch
        \\  wait for ping {n: n} or 5 s
        \\  put it after log
        \\end watch
        \\on fan
        \\  wait for all
        \\    send note with 1 to callee and wait
        \\    send note with 2 to callee and wait
        \\  end wait
        \\  put it after log
        \\end fan
        \\on ping m
        \\  put m after log
        \\end ping
        \\
    ;
    const callee =
        \\script variable seen = []
        \\on note n
        \\  wait 0 s
        \\  put n after seen
        \\  return n * 2
        \\end note
        \\
    ;
    // Every cap from too small to load to large enough to finish: the
    // refusal falls at a different allocation each time.
    var cap: usize = 1024;
    var finished = false;
    while (!finished) : (cap += 256) {
        var memory: GroupAllocator = .init(std.testing.allocator, cap);
        defer memory.deinit();
        var group: machine.Group = .init(memory.allocator(), null);
        defer group.deinit();
        finished = blk: {
            if ((group.load("caller", caller, .{}) catch break :blk false) != .loaded) return error.TestUnexpectedResult;
            if ((group.load("callee", callee, .{}) catch break :blk false) != .loaded) return error.TestUnexpectedResult;
            const n = model.scalar(memory.allocator(), .{ .number = model.Decimal.fromInt(7) }) catch break :blk false;
            var args = [_]*model.Value{n};
            _ = group.deliver("caller", "go", &args, false) catch {
                n.release();
                break :blk false;
            };
            _ = group.deliver("caller", "watch", &.{}, false) catch break :blk false;
            _ = group.deliver("caller", "fan", &.{}, false) catch break :blk false;
            const m = model.map(memory.allocator(), &.{.{ .key = "n", .value = n }}) catch break :blk false;
            var ping = [_]*model.Value{m};
            _ = group.deliver("caller", "ping", &ping, false) catch {
                m.release();
                break :blk false;
            };
            group.pump(.{ .seconds = 1790000000, .nanos = 0 }) catch break :blk false;
            group.pump(.{ .seconds = 1790000001, .nanos = 0 }) catch break :blk false;
            break :blk !memory.refused;
        };
    }
}

test "Extend, Reload and Library replacement refused at any allocation leave nothing behind" {
    const machine = @import("machine.zig");
    const gpa = std.testing.allocator;
    const first = (try machine.compileLibrary(gpa, "lib", "1", "constant k = 1\nfunction twice x\n  return x * 2\nend twice\n", &.{}, null)).library;
    defer first.destroy();
    const source =
        \\use k, twice from lib
        \\script variable n = k
        \\script variable f = nothing
        \\on go
        \\  put twice into f
        \\  put (given x: x + n) into f
        \\  wait 1 s
        \\  add 1 to n
        \\end go
        \\
    ;
    var cap: usize = 4096;
    var finished = false;
    while (!finished) : (cap += 512) {
        // Each attempt compiles its own replacement, which the Core would
        // own, and frees the ones the Group recompiled.
        const next = (try machine.compileLibrary(gpa, "lib", "2", "constant k = 2\nfunction twice x\n  return x * 3\nend twice\n", &.{}, null)).library;
        defer next.destroy();
        var memory: GroupAllocator = .init(gpa, cap);
        defer memory.deinit();
        var group: machine.Group = .init(memory.allocator(), null);
        defer group.deinit();
        finished = blk: {
            group.addLibrary(first) catch break :blk false;
            if ((group.load("s", source, .{}) catch break :blk false) != .loaded) return error.TestUnexpectedResult;
            const s = group.script("s") orelse break :blk false;
            _ = group.deliver("s", "go", &.{}, false) catch break :blk false;
            group.pump(.{ .seconds = 1790000000, .nanos = 0 }) catch break :blk false;
            const added = group.extend(s, "script variable m = 3\non more\n  return twice(m) + n\nend more\n") catch break :blk false;
            if (added != .extended) break :blk false;
            if ((group.extend(s, "on go\nend go\n") catch break :blk false) != .name_reused) break :blk false;
            if ((group.extend(s, "on") catch break :blk false) != .refused) break :blk false;
            _ = group.deliver("s", "more", &.{}, false) catch break :blk false;
            group.pump(.{ .seconds = 1790000000, .nanos = 0 }) catch break :blk false;
            _ = group.deliver("s", "go", &.{}, false) catch break :blk false;
            const reloaded = group.reload(s, source, true, true) catch break :blk false;
            if (reloaded != .reloaded) break :blk false;
            if ((group.reload(s, "on", false, false) catch break :blk false) != .refused) break :blk false;
            const replaced = group.replaceLibrary(next, true, gpa) catch break :blk false;
            if (replaced != .replaced) break :blk false;
            memory.allocator().free(replaced.replaced);
            group.pump(.{ .seconds = 1790000002, .nanos = 0 }) catch break :blk false;
            break :blk !memory.refused;
        };
    }
}

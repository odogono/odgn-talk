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

pub const GroupAllocator = struct {
    parent: Allocator,
    cap: usize,
    /// Bytes the Group holds now, and the most it has held.
    used: usize = 0,
    peak: usize = 0,
    /// Whether an allocation has been refused: past the cap, or by the
    /// parent. The Group's state may then be partial, so it takes no more
    /// work.
    refused: bool = false,

    pub fn init(parent: Allocator, cap: usize) GroupAllocator {
        return .{ .parent = parent, .cap = if (cap == 0) default_cap else cap };
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
        if (new_len > memory.len and !self.admit(new_len - memory.len)) return false;
        if (!self.parent.rawResize(memory, alignment, new_len, ret_addr)) return false;
        self.settle(memory.len, new_len);
        return true;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
        if (new_len > memory.len and !self.admit(new_len - memory.len)) return null;
        const p = self.parent.rawRemap(memory, alignment, new_len, ret_addr) orelse return null;
        self.settle(memory.len, new_len);
        return p;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: Alignment, ret_addr: usize) void {
        const self: *GroupAllocator = @ptrCast(@alignCast(ctx));
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

test "a Group past its cap refuses mid-Pump and gives back every byte" {
    const machine = @import("machine.zig");
    var memory: GroupAllocator = .init(std.testing.allocator, 256 * 1024);
    var group: machine.Group = .init(memory.allocator(), null);
    defer group.deinit();
    const source = "script variable s\non grow\n  put \"x\" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n";
    _ = try group.load("hog", source, .{});
    _ = try group.deliver("hog", "grow", &.{}, false);
    try std.testing.expectError(error.OutOfMemory, group.pump(.{ .seconds = 1790000000, .nanos = 0 }));
    try std.testing.expect(memory.refused);
}

test "a refusal at any allocation leaves nothing behind" {
    const machine = @import("machine.zig");
    const caller =
        \\script variable log = []
        \\on go n
        \\  try
        \\    put [n, {a: n & "x", b: [1, 2, 3]}] after log
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
        \\  wait for ping {n: n} where n > 1 or 5 s
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
        var group: machine.Group = .init(memory.allocator(), null);
        defer group.deinit();
        finished = blk: {
            _ = group.load("caller", caller, .{}) catch break :blk false;
            _ = group.load("callee", callee, .{}) catch break :blk false;
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

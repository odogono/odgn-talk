//! Issued Operation ids retain their metering eligibility for the Group's
//! lifetime. Consecutive calls with the same eligibility share a range, so
//! a polling Run does not retain one string and hash entry per iteration.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Range = struct {
    first: u64,
    last: u64,
    eligible: bool,
};

pub const IssuedCalls = struct {
    runs: std.StringHashMapUnmanaged(std.ArrayList(Range)) = .empty,

    pub fn deinit(self: *IssuedCalls, a: Allocator) void {
        var it = self.runs.iterator();
        while (it.next()) |entry| {
            a.free(entry.key_ptr.*);
            entry.value_ptr.deinit(a);
        }
        self.runs.deinit(a);
    }

    const Id = struct { run: []const u8, call: u64 };

    fn split(id: []const u8) ?Id {
        const at = std.mem.lastIndexOf(u8, id, ".c") orelse return null;
        const digits = id[at + 2 ..];
        if (at == 0 or digits.len == 0 or digits[0] == '0') return null;
        for (digits) |c| if (c < '0' or c > '9') return null;
        return .{ .run = id[0..at], .call = std.fmt.parseInt(u64, digits, 10) catch return null };
    }

    pub fn get(self: *const IssuedCalls, id: []const u8) ?bool {
        const parsed = split(id) orelse return null;
        const ranges = self.runs.get(parsed.run) orelse return null;
        // Binary search also keeps stale transport requests cheap after a
        // Run has alternated between metered and unmetered Operations.
        var low: usize = 0;
        var high = ranges.items.len;
        while (low < high) {
            const mid = low + (high - low) / 2;
            const r = ranges.items[mid];
            if (parsed.call < r.first) high = mid else if (parsed.call > r.last) low = mid + 1 else return r.eligible;
        }
        return null;
    }

    /// Calls are issued in increasing order within their Run. A deferred
    /// Host crossing can register the same id again without changing it.
    pub fn put(self: *IssuedCalls, a: Allocator, id: []const u8, eligible: bool) !void {
        if (self.get(id) != null) return;
        const parsed = split(id) orelse return error.InvalidCallId;
        if (self.runs.getPtr(parsed.run)) |ranges| {
            try append(ranges, a, .{ .first = parsed.call, .last = parsed.call, .eligible = eligible });
            return;
        }
        const run = try a.dupe(u8, parsed.run);
        errdefer a.free(run);
        var ranges: std.ArrayList(Range) = .empty;
        errdefer ranges.deinit(a);
        try append(&ranges, a, .{ .first = parsed.call, .last = parsed.call, .eligible = eligible });
        try self.runs.put(a, run, ranges);
    }

    pub fn append(ranges: *std.ArrayList(Range), a: Allocator, range: Range) !void {
        if (range.first == 0 or range.last < range.first) return error.InvalidCallId;
        if (ranges.items.len != 0) {
            const last = &ranges.items[ranges.items.len - 1];
            if (range.first <= last.last) return error.InvalidCallId;
            if (range.first - 1 == last.last and range.eligible == last.eligible) {
                last.last = range.last;
                return;
            }
        }
        try ranges.append(a, range);
    }

    /// Only the most recently issued call is withdrawn, when automatic
    /// abandonment pauses before reaching its Host callback.
    pub fn removeLast(self: *IssuedCalls, a: Allocator, id: []const u8) void {
        const parsed = split(id) orelse return;
        const ranges = self.runs.getPtr(parsed.run) orelse return;
        if (ranges.items.len == 0) return;
        const last = &ranges.items[ranges.items.len - 1];
        if (last.last != parsed.call) return;
        if (last.first < last.last) last.last -= 1 else _ = ranges.pop();
        if (ranges.items.len == 0) {
            const entry = self.runs.fetchRemove(parsed.run).?;
            a.free(entry.key);
            var empty = entry.value;
            empty.deinit(a);
        }
    }
};

test "issued ids compact consecutive calls and preserve eligibility and gaps" {
    const t = std.testing;
    var calls: IssuedCalls = .{};
    defer calls.deinit(t.allocator);
    try calls.put(t.allocator, "s.c/r1.c1", false);
    try calls.put(t.allocator, "s.c/r1.c2", false);
    try calls.put(t.allocator, "s.c/r1.c4", true);
    try calls.put(t.allocator, "s.c/r1.c5", true);
    try calls.put(t.allocator, "s.c/r1.c5", false);
    try calls.put(t.allocator, "s.c/r1.c6", false);
    try calls.put(t.allocator, "other/r1.c1", true);
    try t.expectEqual(@as(usize, 3), calls.runs.get("s.c/r1").?.items.len);
    try t.expectEqual(false, calls.get("s.c/r1.c2").?);
    try t.expectEqual(true, calls.get("s.c/r1.c5").?);
    try t.expectEqual(false, calls.get("s.c/r1.c6").?);
    for ([_][]const u8{ "s.c/r1.c3", "s.c/r1.c7", "s.c/r1.c0", "s.c/r1.c01", "s.c/r1.c+1", "s.c/r1.c18446744073709551616", "missing/r1.c1" }) |id| try t.expectEqual(@as(?bool, null), calls.get(id));
    calls.removeLast(t.allocator, "s.c/r1.c6");
    calls.removeLast(t.allocator, "s.c/r1.c5");
    try t.expectEqual(@as(?bool, null), calls.get("s.c/r1.c5"));
    try t.expectEqual(true, calls.get("s.c/r1.c4").?);
    calls.removeLast(t.allocator, "other/r1.c1");
    try t.expect(!calls.runs.contains("other/r1"));
}

fn allocationFailures(a: Allocator) !void {
    var calls: IssuedCalls = .{};
    defer calls.deinit(a);
    try calls.put(a, "s/r1.c1", false);
    try calls.put(a, "s/r1.c2", false);
    try calls.put(a, "s/r1.c4", true);
    try calls.put(a, "other/r1.c1", true);
}

test "issued range allocation refusal releases all owned memory" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}

test "issued ranges refuse zero, reversed and overlapping bounds" {
    var ranges: std.ArrayList(Range) = .empty;
    defer ranges.deinit(std.testing.allocator);
    try std.testing.expectError(error.InvalidCallId, IssuedCalls.append(&ranges, std.testing.allocator, .{ .first = 0, .last = 1, .eligible = false }));
    try std.testing.expectError(error.InvalidCallId, IssuedCalls.append(&ranges, std.testing.allocator, .{ .first = 2, .last = 1, .eligible = false }));
    try IssuedCalls.append(&ranges, std.testing.allocator, .{ .first = 1, .last = 4, .eligible = false });
    try std.testing.expectError(error.InvalidCallId, IssuedCalls.append(&ranges, std.testing.allocator, .{ .first = 4, .last = 5, .eligible = true }));
}

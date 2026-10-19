//! Issued Operation ids retain their metering eligibility for the Group's
//! lifetime. Consecutive calls with the same eligibility share a range, so
//! a polling Run does not retain one string and hash entry per iteration.
//! A finished Run folds into its Script's spans: consecutive Runs that
//! issued the same ranges share one, so a Group serving many Runs keeps
//! bounded memory for them (#1320).
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Range = struct {
    first: u64,
    last: u64,
    eligible: bool,
    /// Whether these were suspending calls, which a Host may still answer
    /// late once their Calls are released. Not saved.
    suspending: bool = false,
};

/// Runs `first` to `last` of one Script, each of which issued `ranges`.
pub const Span = struct {
    first: u64,
    last: u64,
    ranges: []Range,
};

pub const IssuedCalls = struct {
    /// Runs still open, by Run id.
    runs: std.StringHashMapUnmanaged(std.ArrayList(Range)) = .empty,
    /// Finished Runs, by Script, in Run number order.
    spans: std.StringHashMapUnmanaged(std.ArrayList(Span)) = .empty,

    pub fn deinit(self: *IssuedCalls, a: Allocator) void {
        var it = self.runs.iterator();
        while (it.next()) |entry| {
            a.free(entry.key_ptr.*);
            entry.value_ptr.deinit(a);
        }
        self.runs.deinit(a);
        var spans = self.spans.iterator();
        while (spans.next()) |entry| {
            a.free(entry.key_ptr.*);
            for (entry.value_ptr.items) |span| a.free(span.ranges);
            entry.value_ptr.deinit(a);
        }
        self.spans.deinit(a);
    }

    const RunId = struct { script: []const u8, n: u64 };

    /// `<script>/r<n>`, or null for a Run id of another form.
    fn splitRun(run: []const u8) ?RunId {
        const at = std.mem.lastIndexOf(u8, run, "/r") orelse return null;
        const digits = run[at + 2 ..];
        if (digits.len == 0 or digits[0] == '0') return null;
        for (digits) |c| if (c < '0' or c > '9') return null;
        return .{ .script = run[0..at], .n = std.fmt.parseInt(u64, digits, 10) catch return null };
    }

    fn sameRanges(x: []const Range, y: []const Range) bool {
        if (x.len != y.len) return false;
        for (x, y) |p, q| if (p.first != q.first or p.last != q.last or p.eligible != q.eligible or p.suspending != q.suspending) return false;
        return true;
    }

    fn search(ranges: []const Range, call: u64) ?Range {
        // Binary search also keeps stale transport requests cheap after a
        // Run has alternated between metered and unmetered Operations.
        var low: usize = 0;
        var high = ranges.len;
        while (low < high) {
            const mid = low + (high - low) / 2;
            const r = ranges[mid];
            if (call < r.first) high = mid else if (call > r.last) low = mid + 1 else return r;
        }
        return null;
    }

    /// The span holding Run `n`, or where one would go.
    fn spanAt(spans: []const Span, n: u64) struct { index: usize, found: bool } {
        var low: usize = 0;
        var high = spans.len;
        while (low < high) {
            const mid = low + (high - low) / 2;
            if (n < spans[mid].first) high = mid else if (n > spans[mid].last) low = mid + 1 else return .{ .index = mid, .found = true };
        }
        return .{ .index = low, .found = false };
    }

    /// Marks an issued call suspending, as a released Call's id must be for
    /// a late answer, including one a restore imported without the mark.
    pub fn markSuspending(self: *IssuedCalls, a: Allocator, id: []const u8) Allocator.Error!void {
        const parsed = split(id) orelse return;
        const list = self.runs.getPtr(parsed.run) orelse return;
        const i = for (list.items, 0..) |r, i| {
            if (parsed.call >= r.first and parsed.call <= r.last) break i;
        } else return;
        const r = list.items[i];
        if (r.suspending) return;
        // Split the range around the call: before, the call, after.
        var parts: [3]Range = undefined;
        var n: usize = 0;
        if (r.first < parsed.call) {
            parts[n] = .{ .first = r.first, .last = parsed.call - 1, .eligible = r.eligible, .suspending = false };
            n += 1;
        }
        parts[n] = .{ .first = parsed.call, .last = parsed.call, .eligible = r.eligible, .suspending = true };
        n += 1;
        if (parsed.call < r.last) {
            parts[n] = .{ .first = parsed.call + 1, .last = r.last, .eligible = r.eligible, .suspending = false };
            n += 1;
        }
        try list.replaceRange(a, i, 1, parts[0..n]);
    }

    /// Folds a finished Run into its Script's spans. Its calls stay issued.
    pub fn close(self: *IssuedCalls, a: Allocator, run: []const u8) Allocator.Error!void {
        const id = splitRun(run) orelse return;
        const open = self.runs.getEntry(run) orelse return;
        const ranges = open.value_ptr.items;
        const script = self.spans.getEntry(id.script);
        if (script) |entry| {
            const spans = entry.value_ptr.items;
            const at = spanAt(spans, id.n);
            if (at.found) return;
            if (at.index > 0) {
                const before = &spans[at.index - 1];
                if (before.last + 1 == id.n and sameRanges(before.ranges, ranges)) {
                    before.last = id.n;
                    // It may now meet the next span, too.
                    if (at.index < spans.len) {
                        const after = spans[at.index];
                        if (after.first == id.n + 1 and sameRanges(after.ranges, ranges)) {
                            before.last = after.last;
                            a.free(after.ranges);
                            _ = entry.value_ptr.orderedRemove(at.index);
                        }
                    }
                    self.forget(a, open);
                    return;
                }
            }
            if (at.index < spans.len) {
                const after = &spans[at.index];
                if (after.first == id.n + 1 and sameRanges(after.ranges, ranges)) {
                    after.first = id.n;
                    self.forget(a, open);
                    return;
                }
            }
        }
        const owned = try a.dupe(Range, ranges);
        errdefer a.free(owned);
        const span: Span = .{ .first = id.n, .last = id.n, .ranges = owned };
        if (script) |entry| {
            try entry.value_ptr.insert(a, spanAt(entry.value_ptr.items, id.n).index, span);
        } else {
            const key = try a.dupe(u8, id.script);
            errdefer a.free(key);
            var list: std.ArrayList(Span) = .empty;
            try list.append(a, span);
            errdefer list.deinit(a);
            try self.spans.put(a, key, list);
        }
        self.forget(a, open);
    }

    fn forget(self: *IssuedCalls, a: Allocator, open: std.StringHashMapUnmanaged(std.ArrayList(Range)).Entry) void {
        const key = open.key_ptr.*;
        open.value_ptr.deinit(a);
        self.runs.removeByPtr(open.key_ptr);
        a.free(key);
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
        return if (self.find(id)) |r| r.eligible else null;
    }

    /// Whether `id` was issued as a suspending call.
    pub fn suspending(self: *const IssuedCalls, id: []const u8) bool {
        return if (self.find(id)) |r| r.suspending else false;
    }

    fn find(self: *const IssuedCalls, id: []const u8) ?Range {
        const parsed = split(id) orelse return null;
        if (self.runs.get(parsed.run)) |ranges| if (search(ranges.items, parsed.call)) |r| return r;
        const run = splitRun(parsed.run) orelse return null;
        const spans = self.spans.get(run.script) orelse return null;
        const at = spanAt(spans.items, run.n);
        return if (at.found) search(spans.items[at.index].ranges, parsed.call) else null;
    }

    /// Calls are issued in increasing order within their Run. A deferred
    /// Host crossing can register the same id again without changing it.
    pub fn put(self: *IssuedCalls, a: Allocator, id: []const u8, eligible: bool) !void {
        return self.putCall(a, id, eligible, false);
    }

    pub fn putCall(self: *IssuedCalls, a: Allocator, id: []const u8, eligible: bool, is_suspending: bool) !void {
        if (self.get(id) != null) return;
        const parsed = split(id) orelse return error.InvalidCallId;
        if (self.runs.getPtr(parsed.run)) |ranges| {
            try append(ranges, a, .{ .first = parsed.call, .last = parsed.call, .eligible = eligible, .suspending = is_suspending });
            return;
        }
        const run = try a.dupe(u8, parsed.run);
        errdefer a.free(run);
        var ranges: std.ArrayList(Range) = .empty;
        errdefer ranges.deinit(a);
        try append(&ranges, a, .{ .first = parsed.call, .last = parsed.call, .eligible = eligible, .suspending = is_suspending });
        try self.runs.put(a, run, ranges);
    }

    pub fn append(ranges: *std.ArrayList(Range), a: Allocator, range: Range) !void {
        if (range.first == 0 or range.last < range.first) return error.InvalidCallId;
        if (ranges.items.len != 0) {
            const last = &ranges.items[ranges.items.len - 1];
            if (range.first <= last.last) return error.InvalidCallId;
            if (range.first - 1 == last.last and range.eligible == last.eligible and range.suspending == last.suspending) {
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

test "finished Runs fold into spans and stay issued" {
    const t = std.testing;
    var calls: IssuedCalls = .{};
    defer calls.deinit(t.allocator);
    for ([_][]const u8{ "s/r1.c1", "s/r2.c1", "s/r4.c1", "s/r3.c1" }) |id| try calls.putCall(t.allocator, id, true, true);
    try calls.putCall(t.allocator, "s/r5.c1", false, false);
    for ([_][]const u8{ "s/r1", "s/r2", "s/r4", "s/r3", "s/r5", "s/r9", "odd" }) |run| try calls.close(t.allocator, run);
    try t.expectEqual(@as(usize, 0), calls.runs.count());
    // r1–r4 issued the same call, in any order; r5 issued another kind.
    const spans = calls.spans.get("s").?.items;
    try t.expectEqual(@as(usize, 2), spans.len);
    try t.expectEqual(@as(u64, 1), spans[0].first);
    try t.expectEqual(@as(u64, 4), spans[0].last);
    for ([_][]const u8{ "s/r1.c1", "s/r3.c1", "s/r4.c1" }) |id| {
        try t.expectEqual(true, calls.get(id).?);
        try t.expect(calls.suspending(id));
    }
    try t.expectEqual(false, calls.get("s/r5.c1").?);
    try t.expect(!calls.suspending("s/r5.c1"));
    for ([_][]const u8{ "s/r1.c2", "s/r6.c1", "other/r1.c1" }) |id| try t.expectEqual(@as(?bool, null), calls.get(id));
    // A folded call registered again stays as it was.
    try calls.putCall(t.allocator, "s/r2.c1", false, false);
    try t.expectEqual(@as(usize, 0), calls.runs.count());
}

fn foldFailures(a: Allocator) !void {
    var calls: IssuedCalls = .{};
    defer calls.deinit(a);
    try calls.putCall(a, "s/r1.c1", true, true);
    try calls.putCall(a, "s/r3.c1", true, true);
    try calls.close(a, "s/r1");
    try calls.close(a, "s/r3");
}

test "fold allocation refusal releases all owned memory" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, foldFailures, .{});
}

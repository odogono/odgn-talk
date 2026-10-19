//! Issued Operation ids retain their metering eligibility for the Group's
//! lifetime. Consecutive calls with the same eligibility share a range, so
//! a polling Run does not retain one string and hash entry per iteration.
const std = @import("std");
const Allocator = std.mem.Allocator;
const sorting = @import("../sort.zig");

pub const Range = struct {
    first: u64,
    last: u64,
    eligible: bool,
};

/// Consecutive Runs, by Run number, whose calls are exactly 1..calls with
/// one eligibility.
pub const Span = struct {
    first: u64,
    last: u64,
    calls: u64,
    eligible: bool,
};

pub const IssuedCalls = struct {
    /// Runs whose ranges no Span can hold, by Run id.
    runs: std.StringHashMapUnmanaged(std.ArrayList(Range)) = .empty,
    /// Every other Run, by the Run id before its number (`s/r`), in Run
    /// order. A Group making the same calls in each Run keeps one Span, not
    /// an entry per Run (#1322).
    spans: std.StringHashMapUnmanaged(std.ArrayList(Span)) = .empty,

    pub fn deinit(self: *IssuedCalls, a: Allocator) void {
        inline for (.{ &self.runs, &self.spans }) |map| {
            var it = map.iterator();
            while (it.next()) |entry| {
                a.free(entry.key_ptr.*);
                entry.value_ptr.deinit(a);
            }
            map.deinit(a);
        }
    }

    const Id = struct { run: []const u8, call: u64 };

    fn split(id: []const u8) ?Id {
        const at = std.mem.lastIndexOf(u8, id, ".c") orelse return null;
        const n = number(id[at + 2 ..]) orelse return null;
        if (at == 0) return null;
        return .{ .run = id[0..at], .call = n };
    }

    fn number(digits: []const u8) ?u64 {
        if (digits.len == 0 or digits[0] == '0') return null;
        for (digits) |c| if (c < '0' or c > '9') return null;
        return std.fmt.parseInt(u64, digits, 10) catch null;
    }

    const RunNumber = struct { prefix: []const u8, n: u64 };

    /// A Run id's prefix and number: `s/r12` is `s/r` and 12.
    fn runNumber(run: []const u8) ?RunNumber {
        var at = run.len;
        while (at > 0 and run[at - 1] >= '0' and run[at - 1] <= '9') at -= 1;
        if (at == 0) return null;
        return .{ .prefix = run[0..at], .n = number(run[at..]) orelse return null };
    }

    /// The Span holding Run n, if any.
    fn spanAt(spans: []const Span, n: u64) ?usize {
        var low: usize = 0;
        var high = spans.len;
        while (low < high) {
            const mid = low + (high - low) / 2;
            if (n < spans[mid].first) high = mid else if (n > spans[mid].last) low = mid + 1 else return mid;
        }
        return null;
    }

    fn spanned(self: *const IssuedCalls, run: []const u8) ?Span {
        const r = runNumber(run) orelse return null;
        const spans = self.spans.get(r.prefix) orelse return null;
        const at = spanAt(spans.items, r.n) orelse return null;
        return spans.items[at];
    }

    pub fn get(self: *const IssuedCalls, id: []const u8) ?bool {
        const parsed = split(id) orelse return null;
        if (self.spanned(parsed.run)) |x| return if (parsed.call <= x.calls) x.eligible else null;
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

    /// Whether the table knows this Run, in either form.
    pub fn contains(self: *const IssuedCalls, run: []const u8) bool {
        return self.runs.contains(run) or self.spanned(run) != null;
    }

    /// How many Runs have issued calls.
    pub fn count(self: *const IssuedCalls) usize {
        var n: usize = self.runs.count();
        var it = self.spans.valueIterator();
        while (it.next()) |spans| for (spans.items) |x| {
            n += @intCast(x.last - x.first + 1);
        };
        return n;
    }

    /// Calls are issued in increasing order within their Run. A deferred
    /// Host crossing can register the same id again without changing it.
    pub fn put(self: *IssuedCalls, a: Allocator, id: []const u8, eligible: bool) !void {
        if (self.get(id) != null) return;
        const parsed = split(id) orelse return error.InvalidCallId;
        const range: Range = .{ .first = parsed.call, .last = parsed.call, .eligible = eligible };
        if (self.runs.getPtr(parsed.run)) |ranges| return append(ranges, a, range);
        if (self.spanned(parsed.run)) |x| {
            if (x.eligible == eligible and parsed.call == x.calls + 1) {
                return self.respan(a, parsed.run, .{ .first = 1, .last = parsed.call, .eligible = eligible });
            }
            if (parsed.call <= x.calls) return error.InvalidCallId;
            var ranges: std.ArrayList(Range) = .empty;
            errdefer ranges.deinit(a);
            try ranges.appendSlice(a, &.{ .{ .first = 1, .last = x.calls, .eligible = x.eligible }, range });
            const run = try a.dupe(u8, parsed.run);
            errdefer a.free(run);
            try self.runs.ensureUnusedCapacity(a, 1);
            try self.unspan(a, parsed.run, false);
            self.runs.putAssumeCapacity(run, ranges);
            return;
        }
        if (range.first == 1) if (runNumber(parsed.run)) |_| return self.span(a, parsed.run, range);
        try self.addRun(a, parsed.run, range);
    }

    fn addRun(self: *IssuedCalls, a: Allocator, run_id: []const u8, range: Range) !void {
        const run = try a.dupe(u8, run_id);
        errdefer a.free(run);
        var ranges: std.ArrayList(Range) = .empty;
        errdefer ranges.deinit(a);
        try append(&ranges, a, range);
        try self.runs.put(a, run, ranges);
    }

    /// Adds a Run no form holds, whose calls are 1..range.last, joining
    /// neighbouring Spans with the same calls.
    fn span(self: *IssuedCalls, a: Allocator, run: []const u8, range: Range) !void {
        const r = runNumber(run).?;
        const entry = try self.spans.getOrPut(a, r.prefix);
        if (!entry.found_existing) {
            entry.key_ptr.* = a.dupe(u8, r.prefix) catch |err| {
                self.spans.removeByPtr(entry.key_ptr);
                return err;
            };
            entry.value_ptr.* = .empty;
        }
        const spans = entry.value_ptr;
        var at: usize = 0;
        var high = spans.items.len;
        while (at < high) {
            const mid = at + (high - at) / 2;
            if (spans.items[mid].first < r.n) at = mid + 1 else high = mid;
        }
        const joins = struct {
            fn f(x: Span, calls: u64, eligible: bool) bool {
                return x.calls == calls and x.eligible == eligible;
            }
        }.f;
        const left = at > 0 and spans.items[at - 1].last + 1 == r.n and joins(spans.items[at - 1], range.last, range.eligible);
        const right = at < spans.items.len and spans.items[at].first == r.n + 1 and joins(spans.items[at], range.last, range.eligible);
        if (left and right) {
            spans.items[at - 1].last = spans.items[at].last;
            _ = spans.orderedRemove(at);
        } else if (left) {
            spans.items[at - 1].last = r.n;
        } else if (right) {
            spans.items[at].first = r.n;
        } else {
            try spans.insert(a, at, .{ .first = r.n, .last = r.n, .calls = range.last, .eligible = range.eligible });
        }
    }

    /// Takes a Run out of its Span, which may split in two.
    /// A Span list left empty is dropped unless `keep` says the Run is
    /// about to return.
    fn unspan(self: *IssuedCalls, a: Allocator, run: []const u8, keep: bool) !void {
        const r = runNumber(run).?;
        const spans = self.spans.getPtr(r.prefix).?;
        const at = spanAt(spans.items, r.n).?;
        const x = spans.items[at];
        if (x.first == x.last) {
            _ = spans.orderedRemove(at);
        } else if (r.n == x.first) {
            spans.items[at].first += 1;
        } else if (r.n == x.last) {
            spans.items[at].last -= 1;
        } else {
            try spans.insert(a, at + 1, .{ .first = r.n + 1, .last = x.last, .calls = x.calls, .eligible = x.eligible });
            spans.items[at].last = r.n - 1;
        }
        if (spans.items.len == 0 and !keep) {
            const entry = self.spans.fetchRemove(r.prefix).?;
            a.free(entry.key);
            var empty = entry.value;
            empty.deinit(a);
        }
    }

    /// Moves a spanned Run to the Span its new calls belong in. A split
    /// Span can need one more slot, reserved before the Run leaves.
    fn respan(self: *IssuedCalls, a: Allocator, run: []const u8, range: Range) !void {
        const spans = self.spans.getPtr(runNumber(run).?.prefix).?;
        try spans.ensureUnusedCapacity(a, 2);
        self.unspan(a, run, true) catch unreachable;
        self.span(a, run, range) catch unreachable;
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

    /// Adds a restored Run, taking ownership of `run` and `ranges`.
    pub fn importRun(self: *IssuedCalls, a: Allocator, run: []u8, ranges: std.ArrayList(Range)) !void {
        if (ranges.items.len == 1 and ranges.items[0].first == 1) if (runNumber(run)) |_| {
            try self.span(a, run, ranges.items[0]);
            a.free(run);
            var owned = ranges;
            owned.deinit(a);
            return;
        };
        try self.runs.put(a, run, ranges);
    }

    /// Each Run in Run-id order, independent of hashing and form, for a
    /// save. `f.run(id, ranges)` gets borrowed slices.
    pub fn each(self: *const IssuedCalls, a: Allocator, f: anytype) !void {
        const Entry = struct { id: []const u8, ranges: []const Range, one: [1]Range = undefined };
        var arena: std.heap.ArenaAllocator = .init(a);
        defer arena.deinit();
        const x = arena.allocator();
        var entries: std.ArrayList(Entry) = .empty;
        try entries.ensureTotalCapacity(x, self.count());
        var it = self.runs.iterator();
        while (it.next()) |e| entries.appendAssumeCapacity(.{ .id = e.key_ptr.*, .ranges = e.value_ptr.items });
        var spans = self.spans.iterator();
        while (spans.next()) |e| for (e.value_ptr.items) |sp| {
            var n = sp.first;
            while (true) : (n += 1) {
                entries.appendAssumeCapacity(.{ .id = try std.fmt.allocPrint(x, "{s}{d}", .{ e.key_ptr.*, n }), .ranges = &.{}, .one = .{.{ .first = 1, .last = sp.calls, .eligible = sp.eligible }} });
                if (n == sp.last) break;
            }
        };
        sorting.stable(Entry, entries.items, {}, struct {
            fn less(_: void, l: Entry, r: Entry) bool {
                return std.mem.lessThan(u8, l.id, r.id);
            }
        }.less);
        for (entries.items) |*e| try f.run(e.id, if (e.ranges.len == 0) &e.one else e.ranges);
    }

    /// Only the most recently issued call is withdrawn, when automatic
    /// abandonment pauses before reaching its Host callback.
    pub fn removeLast(self: *IssuedCalls, a: Allocator, id: []const u8) void {
        const parsed = split(id) orelse return;
        if (self.spanned(parsed.run)) |x| {
            if (x.calls != parsed.call) return;
            if (x.calls == 1) {
                // Leaving needs no slot: the Run is at a Span's end or alone,
                // or the split slot is reserved first.
                const spans = self.spans.getPtr(runNumber(parsed.run).?.prefix).?;
                spans.ensureUnusedCapacity(a, 1) catch return;
                self.unspan(a, parsed.run, false) catch unreachable;
            } else self.respan(a, parsed.run, .{ .first = 1, .last = x.calls - 1, .eligible = x.eligible }) catch return;
            return;
        }
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

test "Runs making the same calls share a Span, which splits and rejoins (#1322)" {
    const t = std.testing;
    var calls: IssuedCalls = .{};
    defer calls.deinit(t.allocator);
    for (1..6) |n| {
        var buf: [16]u8 = undefined;
        try calls.put(t.allocator, try std.fmt.bufPrint(&buf, "s/r{d}.c1", .{n}), false);
    }
    try t.expectEqual(@as(usize, 0), calls.runs.count());
    try t.expectEqualSlices(Span, &.{.{ .first = 1, .last = 5, .calls = 1, .eligible = false }}, calls.spans.get("s/r").?.items);
    try t.expectEqual(@as(usize, 5), calls.count());
    // A second call moves its Run to another Span; a later Run making the
    // same two calls joins it.
    try calls.put(t.allocator, "s/r3.c2", false);
    try t.expectEqualSlices(Span, &.{ .{ .first = 1, .last = 2, .calls = 1, .eligible = false }, .{ .first = 3, .last = 3, .calls = 2, .eligible = false }, .{ .first = 4, .last = 5, .calls = 1, .eligible = false } }, calls.spans.get("s/r").?.items);
    try t.expectEqual(false, calls.get("s/r3.c2").?);
    try t.expectEqual(@as(?bool, null), calls.get("s/r4.c2"));
    try t.expectEqual(@as(?bool, null), calls.get("s/r6.c1"));
    calls.removeLast(t.allocator, "s/r3.c2");
    try t.expectEqualSlices(Span, &.{.{ .first = 1, .last = 5, .calls = 1, .eligible = false }}, calls.spans.get("s/r").?.items);
    // A call with another eligibility needs ranges, so the Run leaves.
    try calls.put(t.allocator, "s/r2.c2", true);
    try t.expectEqual(true, calls.get("s/r2.c2").?);
    try t.expectEqual(false, calls.get("s/r2.c1").?);
    try t.expectEqual(@as(usize, 2), calls.runs.get("s/r2").?.items.len);
    try t.expect(calls.contains("s/r2") and calls.contains("s/r5") and !calls.contains("s/r6"));
    try t.expectEqual(@as(usize, 5), calls.count());
    // Run ids without a number never join a Span.
    try calls.put(t.allocator, "odd.c1", false);
    try t.expect(calls.runs.contains("odd"));
    calls.removeLast(t.allocator, "s/r1.c1");
    calls.removeLast(t.allocator, "s/r5.c1");
    calls.removeLast(t.allocator, "s/r4.c1");
    calls.removeLast(t.allocator, "s/r3.c1");
    try t.expect(!calls.spans.contains("s/r"));
}

test "saves list every Run in id order whatever its form" {
    const t = std.testing;
    var calls: IssuedCalls = .{};
    defer calls.deinit(t.allocator);
    for ([_][]const u8{ "s/r1.c1", "s/r2.c1", "s/r10.c1", "s/r2.c3", "a/r1.c1" }) |id| try calls.put(t.allocator, id, false);
    var listed: std.ArrayList(u8) = .empty;
    defer listed.deinit(t.allocator);
    try calls.each(t.allocator, struct {
        out: *std.ArrayList(u8),
        pub fn run(w: @This(), id: []const u8, ranges: []const Range) !void {
            try w.out.print(t.allocator, "{s}", .{id});
            for (ranges) |r| try w.out.print(t.allocator, " {d}-{d}", .{ r.first, r.last });
            try w.out.append(t.allocator, ';');
        }
    }{ .out = &listed });
    try t.expectEqualStrings("a/r1 1-1;s/r1 1-1;s/r10 1-1;s/r2 1-1 3-3;", listed.items);
}

fn spanFailures(a: Allocator) !void {
    var calls: IssuedCalls = .{};
    defer calls.deinit(a);
    try calls.put(a, "s/r1.c1", false);
    try calls.put(a, "s/r3.c1", false);
    try calls.put(a, "s/r2.c1", false);
    try calls.put(a, "s/r2.c2", true);
    try calls.put(a, "s/r1.c2", false);
    const run = try a.dupe(u8, "s/r4");
    var ranges: std.ArrayList(Range) = .empty;
    ranges.append(a, .{ .first = 1, .last = 1, .eligible = false }) catch |err| {
        a.free(run);
        return err;
    };
    calls.importRun(a, run, ranges) catch |err| {
        a.free(run);
        ranges.deinit(a);
        return err;
    };
}

test "Span allocation refusal releases all owned memory" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, spanFailures, .{});
}

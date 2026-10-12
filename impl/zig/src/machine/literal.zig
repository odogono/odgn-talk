//! A literal needle run as the matcher runs it (chapter 8, Running): the
//! program is a `char` per unit of the needle, then `match`, and `steps`
//! counts the threads in the list at each position. A unit is a Character
//! of text, or a byte of Bytes.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// The kind of run: where it seeds and where it accepts a match.
pub const Kind = enum { search, prefix, suffix };

pub const Result = struct { found: bool, steps: u64 };

/// Runs `needle` over `subject`, both split into units, stopping at the
/// first match.
pub fn run(a: Allocator, subject: []const []const u8, needle: []const []const u8, kind: Kind) !Result {
    const n = subject.len;
    const m = needle.len;
    // A literal program never splits, so each thread is the instruction it
    // is at, and the list holds each at most once.
    var list: std.ArrayList(usize) = .empty;
    var next: std.ArrayList(usize) = .empty;
    var steps: u64 = 0;
    var p: usize = 0;
    while (true) : (p += 1) {
        const seeds = kind != .prefix or p == 0;
        if (seeds and std.mem.indexOfScalar(usize, list.items, 0) == null) try list.append(a, 0);
        steps += list.items.len;
        next.clearRetainingCapacity();
        for (list.items) |i| {
            if (i == m) {
                if (kind != .suffix or p == n) return .{ .found = true, .steps = steps };
                continue;
            }
            if (p < n and std.mem.eql(u8, subject[p], needle[i]) and std.mem.indexOfScalar(usize, next.items, i + 1) == null) {
                try next.append(a, i + 1);
            }
        }
        if (p == n) break;
        std.mem.swap(std.ArrayList(usize), &list, &next);
        if (list.items.len == 0 and kind == .prefix) break;
    }
    return .{ .found = false, .steps = steps };
}

/// Bytes as units, one per byte.
pub fn bytes(a: Allocator, b: []const u8) ![]const []const u8 {
    const out = try a.alloc([]const u8, b.len);
    for (out, 0..) |*u, i| u.* = b[i .. i + 1];
    return out;
}

const testing = std.testing;

test "the steps of a literal search" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try run(a, try bytes(a, "abab"), try bytes(a, "ba"), .search);
    try testing.expect(r.found);
    // [0], [0], [1, 0], then [2, 0], whose first thread is the match.
    try testing.expectEqual(@as(u64, 6), r.steps);
}

//! Stable sorting without a per-call stack cache.
const std = @import("std");

/// Slices shorter than this use insertion sort.
const short = 32;

/// `std.mem.sort` declares a 512-element `undefined` cache, which safe
/// builds fill with 0xAA on every call, even for an empty slice. Pumps
/// sort a few rows each, so short slices take a stable insertion sort.
pub fn stable(
    comptime T: type,
    items: []T,
    context: anytype,
    comptime lessThan: fn (@TypeOf(context), lhs: T, rhs: T) bool,
) void {
    if (items.len < short) {
        std.sort.insertion(T, items, context, lessThan);
    } else {
        std.mem.sort(T, items, context, lessThan);
    }
}

test "stable keeps equal keys in input order on both paths" {
    const Pair = struct { key: u8, at: usize };
    const less = struct {
        fn less(_: void, x: Pair, y: Pair) bool {
            return x.key < y.key;
        }
    }.less;
    for ([_]usize{ 0, 1, 7, short - 1, short, 200 }) |n| {
        var items: [200]Pair = undefined;
        for (items[0..n], 0..) |*p, k| p.* = .{ .key = @intCast((k * 7) % 5), .at = k };
        stable(Pair, items[0..n], {}, less);
        for (items[0..n], 0..) |p, k| if (k > 0) {
            const q = items[k - 1];
            try std.testing.expect(q.key < p.key or (q.key == p.key and q.at < p.at));
        };
    }
}

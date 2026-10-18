//! The Core's ids, such as `d12`, `s/r3` and `s/r3.s2`: text, then a
//! number in decimal. Pumps make several, and `std.fmt.allocPrint` costs
//! several times the bytes on `wasm32`.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// `head`, `tail`, then `n`, in one allocation the caller owns.
pub fn alloc(a: Allocator, head: []const u8, tail: []const u8, n: u64) Allocator.Error![]u8 {
    var digits: [20]u8 = undefined;
    var at: usize = digits.len;
    var x = n;
    while (true) {
        at -= 1;
        digits[at] = '0' + @as(u8, @intCast(x % 10));
        x /= 10;
        if (x == 0) break;
    }
    const out = try a.alloc(u8, head.len + tail.len + digits.len - at);
    @memcpy(out[0..head.len], head);
    @memcpy(out[head.len..][0..tail.len], tail);
    @memcpy(out[head.len + tail.len ..], digits[at..]);
    return out;
}

test "alloc matches allocPrint" {
    const a = std.testing.allocator;
    for ([_]u64{ 0, 7, 10, 99, 100, 12345, std.math.maxInt(u64) }) |n| {
        const want = try std.fmt.allocPrint(a, "s/r{d}", .{n});
        defer a.free(want);
        const got = try alloc(a, "s", "/r", n);
        defer a.free(got);
        try std.testing.expectEqualStrings(want, got);
    }
    const empty = try alloc(a, "", "d", 4);
    defer a.free(empty);
    try std.testing.expectEqualStrings("d4", empty);
}

//! The Script Group's generator for `random(n)`: PCG32, XSH RR, with the
//! increment and seeding the Spec fixes (chapter 7, Random numbers;
//! ADR 0096).

const std = @import("std");

const multiplier: u64 = 6364136223846793005;
const increment: u64 = 1442695040888963407;

/// The largest `n` that `random` takes.
pub const limit: u64 = 1 << 32;

fn step(state: u64) u64 {
    return state *% multiplier +% increment;
}

fn output(state: u64) u32 {
    const xorshifted: u32 = @truncate(((state >> 18) ^ state) >> 27);
    const rot: u5 = @intCast(state >> 59);
    return std.math.rotr(u32, xorshifted, rot);
}

/// The generator state a seed gives.
pub fn seedState(seed: u64) u64 {
    return step(step(0) +% seed);
}

pub const Draw = struct { state: u64, value: u64 };

/// The next whole number 1..n, 1 <= n <= 2^32, and the state after it.
/// Draws below (2^32 - n) mod n are rejected, so every result is as likely.
pub fn next(state: u64, n: u64) Draw {
    std.debug.assert(n >= 1 and n <= limit);
    const threshold = (limit - n) % n;
    var s = state;
    while (true) {
        const r: u64 = output(s);
        s = step(s);
        if (r >= threshold) return .{ .state = s, .value = r % n + 1 };
    }
}

fn draws(seed: u64, ns: []const u64, out: []u64) void {
    var s = seedState(seed);
    for (ns, out) |n, *o| {
        const d = next(s, n);
        s = d.state;
        o.* = d.value;
    }
}

test "the generator gives the Spec's sequences" {
    var out: [10]u64 = undefined;
    const sixes = [_]u64{ 6, 6, 6, 6, 6, 6, 6, 6, 6, 6 };
    draws(0, &sixes, &out);
    try std.testing.expectEqualSlices(u64, &.{ 1, 6, 1, 3, 2, 6, 6, 6, 3, 5 }, &out);
    draws(42, &sixes, &out);
    try std.testing.expectEqualSlices(u64, &.{ 3, 6, 4, 4, 4, 5, 1, 6, 3, 4 }, &out);
    draws(0, &.{ 1, 2, 7, 100, limit }, out[0..5]);
    try std.testing.expectEqualSlices(u64, &.{ 1, 2, 4, 89, 3443325254 }, out[0..5]);
}

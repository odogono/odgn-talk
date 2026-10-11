//! UTF-8, written here so the Core's text handling depends on no `std`
//! Unicode function. Text the Core holds is always valid UTF-8, so only
//! `validate` checks its input.

const std = @import("std");

/// Whether `bytes` is well-formed UTF-8: shortest form, no surrogates, and
/// nothing above U+10FFFF (Unicode 3.9, D92).
pub fn validate(bytes: []const u8) bool {
    var i: usize = 0;
    while (i < bytes.len) {
        const lead = bytes[i];
        if (lead < 0x80) {
            i += 1;
            continue;
        }
        const len: usize, const low: u8, const high: u8 = switch (lead) {
            0xC2...0xDF => .{ 2, 0x80, 0xBF },
            0xE0 => .{ 3, 0xA0, 0xBF },
            0xE1...0xEC, 0xEE...0xEF => .{ 3, 0x80, 0xBF },
            0xED => .{ 3, 0x80, 0x9F },
            0xF0 => .{ 4, 0x90, 0xBF },
            0xF1...0xF3 => .{ 4, 0x80, 0xBF },
            0xF4 => .{ 4, 0x80, 0x8F },
            else => return false,
        };
        if (bytes.len - i < len) return false;
        if (bytes[i + 1] < low or bytes[i + 1] > high) return false;
        for (bytes[i + 2 .. i + len]) |byte| {
            if (byte & 0xC0 != 0x80) return false;
        }
        i += len;
    }
    return true;
}

/// The length of the sequence a valid lead byte starts.
pub fn sequenceLength(lead: u8) u3 {
    return if (lead < 0x80) 1 else if (lead < 0xE0) 2 else if (lead < 0xF0) 3 else 4;
}

/// Decodes the scalar starting at `bytes[i]` of valid UTF-8.
pub fn decode(bytes: []const u8, i: usize) u21 {
    const lead = bytes[i];
    return switch (sequenceLength(lead)) {
        1 => lead,
        // `&` and `|` share one precedence in Zig, so every term is parenthesised.
        2 => (@as(u21, lead & 0x1F) << 6) | (bytes[i + 1] & 0x3F),
        3 => (@as(u21, lead & 0x0F) << 12) | (@as(u21, bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F),
        else => (@as(u21, lead & 0x07) << 18) | (@as(u21, bytes[i + 1] & 0x3F) << 12) |
            (@as(u21, bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F),
    };
}

pub fn encodedLength(scalar: u21) u3 {
    return if (scalar < 0x80) 1 else if (scalar < 0x800) 2 else if (scalar < 0x10000) 3 else 4;
}

/// Writes a scalar's UTF-8 to `out` and returns its length.
pub fn encode(scalar: u21, out: []u8) u3 {
    const len = encodedLength(scalar);
    switch (len) {
        1 => out[0] = @intCast(scalar),
        2 => {
            out[0] = @intCast(0xC0 | (scalar >> 6));
            out[1] = @intCast(0x80 | (scalar & 0x3F));
        },
        3 => {
            out[0] = @intCast(0xE0 | (scalar >> 12));
            out[1] = @intCast(0x80 | ((scalar >> 6) & 0x3F));
            out[2] = @intCast(0x80 | (scalar & 0x3F));
        },
        else => {
            out[0] = @intCast(0xF0 | (scalar >> 18));
            out[1] = @intCast(0x80 | ((scalar >> 12) & 0x3F));
            out[2] = @intCast(0x80 | ((scalar >> 6) & 0x3F));
            out[3] = @intCast(0x80 | (scalar & 0x3F));
        },
    }
    return len;
}

/// Iterates over the scalars of valid UTF-8.
pub const Iterator = struct {
    bytes: []const u8,
    i: usize = 0,

    pub fn next(it: *Iterator) ?u21 {
        if (it.i >= it.bytes.len) return null;
        const scalar = decode(it.bytes, it.i);
        it.i += sequenceLength(it.bytes[it.i]);
        return scalar;
    }
};

test "validate refuses ill-formed sequences" {
    const valid = [_][]const u8{ "", "a", "\xC2\x80", "\xE0\xA0\x80", "\xED\x9F\xBF", "\xEE\x80\x80", "\xF0\x90\x80\x80", "\xF4\x8F\xBF\xBF" };
    for (valid) |bytes| try std.testing.expect(validate(bytes));
    const invalid = [_][]const u8{
        "\x80", // a lone continuation byte
        "\xC0\x80", "\xC1\xBF", "\xE0\x9F\xBF", "\xF0\x8F\xBF\xBF", // overlong
        "\xED\xA0\x80", "\xED\xBF\xBF", // surrogates
        "\xF4\x90\x80\x80", "\xF5\x80\x80\x80", "\xFF", // above U+10FFFF
        "\xC2", "\xE0\xA0", "\xF0\x90\x80", "a\xE2\x82", // truncated
        "\xE2\x28\xA1", "\xC2\xC0", // a bad continuation byte
    };
    for (invalid) |bytes| try std.testing.expect(!validate(bytes));
}

test "decode and encode round-trip every scalar" {
    var buffer: [4]u8 = undefined;
    var scalar: u21 = 0;
    while (scalar <= 0x10FFFF) : (scalar += 1) {
        if (scalar >= 0xD800 and scalar <= 0xDFFF) continue;
        const len = encode(scalar, &buffer);
        try std.testing.expect(validate(buffer[0..len]));
        try std.testing.expectEqual(len, sequenceLength(buffer[0]));
        try std.testing.expectEqual(scalar, decode(&buffer, 0));
    }
}

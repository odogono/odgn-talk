//! The C API that include/talk.h declares. Each export keeps talk.h's name and
//! order; tools/zig/api.ts holds talk.h to spec/embedding/talk.go.
//!
//! Values here are text only, enough for the Host's text constructor. The
//! Value model replaces this representation in #632.

const std = @import("std");
const builtin = @import("builtin");
const unicode = @import("unicode/unicode.zig");

/// Value constructors take no Core, as talk.go's don't, so values come from
/// one process-wide allocator.
const allocator = if (builtin.target.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.smp_allocator;

/// talk.h's `talk_host_error_code`, in the same order.
pub const HostErrorCode = enum(c_int) {
    ok = 0,
    clock_backwards,
    parent_cycle,
    duplicate_object_id,
    name_reused,
    reentrant_call,
    wrong_group,
    library_mismatch,
    reserved_name,
    not_adoptable,
    invalid_value,
    invalid_save,
    save_mismatch,
    unknown_call,
    state_too_large,
    effects_pending,
    effect_state_unknown,
    out_of_memory,
};

/// talk.h's `talk_kind`, in the same order.
pub const Kind = enum(c_int) {
    nothing,
    bool,
    number,
    quantity,
    text,
    bytes,
    list,
    map,
    range,
    instant,
    civil_date,
    pattern,
    function,
    object,
};

/// talk.h's opaque `talk_value`.
pub const Value = struct {
    references: usize,
    kind: Kind,
    text: []const u8,
};

/// Text from the Host: valid UTF-8, normalised to NFC, uncharged (ADR 0030).
pub fn text(bytes: []const u8) error{ InvalidValue, OutOfMemory }!*Value {
    if (!unicode.utf8.validate(bytes)) return error.InvalidValue;
    const normal = try unicode.nfc(allocator, bytes);
    errdefer allocator.free(normal);
    const value = try allocator.create(Value);
    value.* = .{ .references = 1, .kind = .text, .text = normal };
    return value;
}

pub fn release(value: *Value) void {
    value.references -= 1;
    if (value.references > 0) return;
    allocator.free(value.text);
    allocator.destroy(value);
}

export fn talk_text(s: ?[*]const u8, len: usize, out: *?*Value) HostErrorCode {
    out.* = null;
    const bytes: []const u8 = if (len == 0) "" else (s orelse return .invalid_value)[0..len];
    out.* = text(bytes) catch |err| return switch (err) {
        error.InvalidValue => .invalid_value,
        error.OutOfMemory => .out_of_memory,
    };
    return .ok;
}

export fn talk_value_kind(v: *const Value) Kind {
    return v.kind;
}

export fn talk_value_as_text(v: *const Value, s: *[*]const u8, len: *usize) bool {
    if (v.kind != .text) return false;
    s.* = v.text.ptr;
    len.* = v.text.len;
    return true;
}

export fn talk_value_release(v: ?*Value) void {
    if (v) |value| release(value);
}

test "the Host's text is refused unless UTF-8, and normalised" {
    try std.testing.expectError(error.InvalidValue, text("\xED\xA0\x80"));
    const value = try text("Cafe\u{0301}");
    defer release(value);
    try std.testing.expectEqualStrings("Caf\u{00E9}", value.text);
    var out: ?*Value = undefined;
    try std.testing.expectEqual(HostErrorCode.invalid_value, talk_text(null, 1, &out));
    try std.testing.expectEqual(@as(?*Value, null), out);
}

/// Whether `E`'s tags, spelled `prefix` ++ TAG, are the enumerators of
/// talk.h's `typedef enum name`, in order and with nothing else.
fn expectHeaderEnum(comptime E: type, comptime name: []const u8, comptime prefix: []const u8) !void {
    const header = @embedFile("talk.h");
    const start = std.mem.indexOf(u8, header, "typedef enum " ++ name ++ " {") orelse return error.TestUnexpectedResult;
    const end = std.mem.indexOfPos(u8, header, start, "} " ++ name ++ ";") orelse return error.TestUnexpectedResult;
    var enumerators = std.mem.tokenizeAny(u8, header[start..end], " \t\n,{}=0");
    inline for (comptime std.meta.fieldNames(E), 0..) |field, i| {
        // talk.h's enumerators take implicit, consecutive values from 0.
        try std.testing.expectEqual(i, @backingInt(@field(E, field)));
        var expected: [prefix.len + field.len]u8 = undefined;
        @memcpy(expected[0..prefix.len], prefix);
        for (field, expected[prefix.len..]) |c, *upper| upper.* = if (c >= 'a' and c <= 'z') c - 32 else c;
        while (enumerators.next()) |token| {
            if (std.mem.startsWith(u8, token, "TALK_")) {
                try std.testing.expectEqualStrings(&expected, token);
                break;
            }
        } else return error.TestUnexpectedResult;
    }
    while (enumerators.next()) |token| {
        if (std.mem.startsWith(u8, token, "TALK_")) return error.TestUnexpectedResult;
    }
}

test "the enums match talk.h's" {
    try expectHeaderEnum(HostErrorCode, "talk_host_error_code", "TALK_");
    try expectHeaderEnum(Kind, "talk_kind", "TALK_KIND_");
}

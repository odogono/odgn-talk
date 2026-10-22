//! The native Script Runner (chapter 12, The Script Runner; ADR 0126) and
//! its HTTP router (chapter 9, The HTTP router), over talk.h.
const std = @import("std");
pub const runner = @import("runner.zig");
pub const router = @import("router.zig");
pub const request = @import("request.zig");

pub const Options = runner.Options;
pub const run = runner.run;

/// Whether the first argument after the flags is a Script to run: it ends
/// in `.talk` or names an existing file, and isn't a flag (ADR 0126).
pub fn isScriptFile(io: std.Io, arg: []const u8) bool {
    if (arg.len == 0 or arg[0] == '-') return false;
    if (std.mem.endsWith(u8, arg, ".talk")) return true;
    const stat = std.Io.Dir.cwd().statFile(io, arg, .{}) catch return false;
    return stat.kind == .file;
}

/// A port from 0 to 65535, written in decimal digits only.
pub fn portOf(value: []const u8) ?u16 {
    if (value.len == 0) return null;
    for (value) |ch| if (!std.ascii.isDigit(ch)) return null;
    return std.fmt.parseInt(u16, value, 10) catch null;
}

test {
    _ = runner;
    _ = router;
    _ = request;
}

test "a port is digits from 0 to 65535" {
    try std.testing.expectEqual(@as(?u16, 0), portOf("0"));
    try std.testing.expectEqual(@as(?u16, 8080), portOf("8080"));
    try std.testing.expectEqual(@as(?u16, null), portOf("65536"));
    try std.testing.expectEqual(@as(?u16, null), portOf("-1"));
    try std.testing.expectEqual(@as(?u16, null), portOf("80x"));
    try std.testing.expectEqual(@as(?u16, null), portOf(""));
}

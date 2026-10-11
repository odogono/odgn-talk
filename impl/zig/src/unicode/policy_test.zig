//! The Core never takes observable Unicode or case behaviour from `std`
//! (#625): this directory's sources use neither of std's Unicode or ASCII
//! namespaces.

const std = @import("std");

test "src/unicode uses no std Unicode or case functions" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    // Spelled in pieces so this file doesn't trip its own check.
    const forbidden = [_][]const u8{ "std." ++ "unicode", "std." ++ "ascii", "@import(\"std\")." ++ "unicode" };
    var dir = try std.Io.Dir.cwd().openDir(io, "src/unicode", .{ .iterate = true });
    defer dir.close(io);
    var files: usize = 0;
    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".zig")) continue;
        const source = try dir.readFileAlloc(io, entry.name, gpa, .unlimited);
        defer gpa.free(source);
        for (forbidden) |name| {
            if (std.mem.indexOf(u8, source, name) != null) {
                std.debug.print("src/unicode/{s} uses {s}\n", .{ entry.name, name });
                return error.TestUnexpectedResult;
            }
        }
        files += 1;
    }
    try std.testing.expect(files > 5);
}

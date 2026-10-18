//! A one-line `wait for` with a Guard after any timeout (ADR 0109),
//! observed through the `watch` Run's record in the Trace.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");

const testing = std.testing;
const Allocator = std.mem.Allocator;

const start: i64 = 1790000000;

/// The Trace after `watch` waits with `wait`, a `key` message carrying each
/// of `keys` is dispatched in turn, and the Group is pumped at `until`
/// seconds past the start.
fn traceOf(gpa: Allocator, wait: []const u8, keys: []const []const u8, until: i64) ![]u8 {
    const source = try std.fmt.allocPrint(gpa, "on watch\n  {s}\n  return it\nend watch\non key k\nend key\n", .{wait});
    defer gpa.free(source);
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var g: machine.Group = .init(gpa, &out.writer);
    defer g.deinit();
    try testing.expect(try g.load("s", source, .{}) == .loaded);
    _ = try g.deliver("s", "watch", &.{}, false);
    try g.pump(.{ .seconds = start, .micros = 0 });
    for (keys) |k| {
        var args = [_]*model.Value{try model.text(gpa, k)};
        _ = try g.deliver("s", "key", &args, false);
        try g.pump(.{ .seconds = start, .micros = 0 });
    }
    try g.pump(.{ .seconds = start + until, .micros = 0 });
    return out.toOwnedSlice();
}

/// The `watch` Run's record, or null while it still waits.
fn watched(gpa: Allocator, wait: []const u8, keys: []const []const u8, until: i64) !?[]u8 {
    const trace = try traceOf(gpa, wait, keys, until);
    defer gpa.free(trace);
    var lines = std.mem.splitScalar(u8, trace, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "run ") and std.mem.indexOf(u8, line, "handler=watch") != null) return try gpa.dupe(u8, line);
    }
    return null;
}

fn expectWatched(wait: []const u8, keys: []const []const u8, until: i64, want: ?[]const u8) !void {
    const gpa = testing.allocator;
    const got = try watched(gpa, wait, keys, until);
    defer if (got) |g| gpa.free(g);
    if (want) |w| {
        const line = got orelse {
            std.debug.print("expected a watch record with {s}, but it still waits\n", .{w});
            return error.TestExpectedEqual;
        };
        if (std.mem.indexOf(u8, line, w) == null) {
            std.debug.print("expected {s} in\n  {s}\n", .{ w, line });
            return error.TestExpectedEqual;
        }
    } else if (got) |line| {
        std.debug.print("expected watch to still wait, got\n  {s}\n", .{line});
        return error.TestExpectedEqual;
    }
}

test "a one-line Guard matches only a message it holds for" {
    try expectWatched("wait for key k where k = \"Y\"", &.{"N"}, 0, null);
    try expectWatched("wait for key k where k = \"Y\"", &.{ "N", "Y" }, 0, "value=");
}

test "an `or` in a one-line Guard is boolean" {
    try expectWatched("wait for key k where k = \"Y\" or k = \"N\"", &.{ "A", "N" }, 0, "\"N\"");
}

test "a one-line Guard follows the timeout" {
    const wait = "wait for key k or 5 s where k = \"Y\"";
    try expectWatched(wait, &.{"N"}, 4, null);
    try expectWatched(wait, &.{"N"}, 5, "outcome=completed delivery=d1 handler=watch fuel=");
    try expectWatched(wait, &.{ "N", "Y" }, 5, "\"Y\"");
}

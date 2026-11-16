//! Holds the native Runner's Peer Exposures to the peer kit, corpus/peer-kit/,
//! as impl/go/peer/kit_test.go and impl/ts/tools/peer-kit.ts do. The
//! Runner serves one Group, so it skips the sequences with several. Each
//! sequence drives a fresh exposures.Exposures; a Remote Send reaches the
//! Script its Peer's exposure names if it still stands, which is all the
//! Runner's `local` asks of the table. `zig build test` runs it from
//! impl/zig.
const std = @import("std");
const kit_toml = @import("kit_toml.zig");
const exposures = @import("exposures.zig");

const Value = kit_toml.Value;
const Allocator = std.mem.Allocator;

/// What one step did, or should do, in a comparable form.
const Outcome = struct {
    deliveries: std.ArrayList([]const u8) = .empty,
    err: ?[]const u8 = null,
    peer: ?[]const u8 = null,

    fn show(o: Outcome, a: Allocator) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (o.deliveries.items) |d| try out.print(a, "delivery {s}; ", .{d});
        try out.print(a, "error {s}; peer {s}", .{ o.err orelse "none", o.peer orelse "none" });
        return out.items;
    }
};

fn expected(a: Allocator, step: Value) !Outcome {
    var o: Outcome = .{};
    if (step.get("deliveries")) |ds| for (ds.array) |d| {
        try o.deliveries.append(a, try std.fmt.allocPrint(a, "{s} {s} {s} {s} {s}", .{
            d.str("group") orelse "g", d.str("script") orelse "a", d.str("kind").?, d.str("message").?, d.str("args").?,
        }));
    };
    o.err = step.str("error");
    if (std.mem.eql(u8, step.str("do").?, "expose") and o.err == null)
        o.peer = if (step.str("same")) |same| try std.fmt.allocPrint(a, "same {s}", .{same}) else "new";
    return o;
}

/// Runs one sequence; a description of the first step that differs, if any.
fn runSequence(gpa: Allocator, a: Allocator, groups: Value, steps: []const Value) !?[]const u8 {
    const group = groups.table[0];
    var table = exposures.Exposures.init(gpa);
    defer table.deinit();
    // Each kept Peer, by name, as its exposure's secret.
    var peers: std.StringHashMapUnmanaged([]const u8) = .empty;
    var next: u8 = 0;
    for (steps, 1..) |step, n| {
        var got: Outcome = .{};
        const do = step.str("do").?;
        const script = step.str("script") orelse "a";
        const peer = if (step.str("peer")) |p| peers.get(p) else null;
        if (std.mem.eql(u8, do, "expose")) {
            next += 1;
            switch (try table.expose(script, step.str("name"), @splat(next))) {
                .name_in_use => got.err = "{code: \"name in use\"}",
                .secret => |secret| {
                    got.peer = "new";
                    var it = peers.iterator();
                    while (it.next()) |kept| if (std.mem.eql(u8, kept.value_ptr.*, secret)) {
                        got.peer = try std.fmt.allocPrint(a, "same {s}", .{kept.key_ptr.*});
                    };
                    if (step.str("as")) |as| try peers.put(a, as, try a.dupe(u8, secret));
                },
            }
        } else if (std.mem.eql(u8, do, "unexpose")) {
            const secret = if (step.str("peer") != null) peer else if (step.str("name")) |name| table.named(name) else null;
            if (secret) |s| table.unexpose(script, s);
        } else if (std.mem.eql(u8, do, "post") or std.mem.eql(u8, do, "call")) {
            const waits = std.mem.eql(u8, do, "call");
            const held = table.get(peer.?);
            const known = if (held) |h| for (group.value.array) |s| {
                if (std.mem.eql(u8, s.string, h.script)) break true;
            } else false else false;
            if (known) {
                try got.deliveries.append(a, try std.fmt.allocPrint(a, "{s} {s} {s} {s} {s}", .{
                    group.key, held.?.script, if (waits) "request" else "deliver", step.str("message").?, step.str("args") orelse "[]",
                }));
            } else if (waits) got.err = "{code: \"send failed\", reason: \"not exposed\"}";
        } else if (std.mem.eql(u8, do, "release")) {
            table.release(script, std.meta.stringToEnum(exposures.Reason, step.str("reason").?).?);
        } else return try std.fmt.allocPrint(a, "step {d}: the native Runner has no {s} step", .{ n, do });
        const want = try (try expected(a, step)).show(a);
        const have = try got.show(a);
        if (!std.mem.eql(u8, want, have)) return try std.fmt.allocPrint(a, "step {d}:\n want {s}\n  got {s}", .{ n, want, have });
    }
    return null;
}

test "the native Runner's exposures follow the peer kit" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus/peer-kit", .{ .iterate = true });
    defer dir.close(io);
    var ran: usize = 0;
    var failed: usize = 0;
    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".toml")) continue;
        const source = try dir.readFileAlloc(io, entry.name, a, .unlimited);
        var p: kit_toml.Parser = .{ .a = a, .s = source };
        const kit = try p.tables("[[sequence]]");
        for (kit.items) |sequence| {
            const groups = sequence.get("groups") orelse kit.top.get("groups").?;
            if (groups.table.len != 1) continue;
            ran += 1;
            if (try runSequence(gpa, a, groups, sequence.get("steps").?.array)) |why| {
                failed += 1;
                std.debug.print("FAIL {s}: {s}: {s}\n", .{ entry.name, sequence.str("name").?, why });
            }
        }
    }
    try std.testing.expect(ran >= 12);
    try std.testing.expectEqual(@as(usize, 0), failed);
}

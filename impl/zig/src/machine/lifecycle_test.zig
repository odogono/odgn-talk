//! Deferred code replacement follows §Lifecycle outside a Pump (#900).
const std = @import("std");
const machine = @import("machine.zig");
const caps = @import("capabilities.zig");
const model = @import("../value.zig");
const testing = std.testing;

const Host = struct {
    deferred: bool,
    pending: bool = false,
    rollbacks: usize = 0,
    fail_at: usize,
    status: caps.EffectStatus,

    fn hook(context: ?*anyopaque, phase: caps.Phase, segment: *const caps.SegmentContext) caps.EffectStatus {
        const h: *@This() = @ptrCast(@alignCast(context.?));
        if (phase != .rollback) return .ok;
        if (h.deferred and segment.deferrable and !h.pending) {
            h.pending = true;
            return .deferred;
        }
        h.pending = false;
        h.rollbacks += 1;
        return if (h.rollbacks == h.fail_at) h.status else .ok;
    }

    fn call(_: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
        return .{ .value = model.scalar(c.gpa, .nothing) catch return .broken };
    }
};

fn library(name: []const u8, source: []const u8, imports: []const *machine.Library) !*machine.Library {
    const compiled = try machine.compileLibrary(testing.allocator, name, "", source, imports, null);
    try testing.expect(compiled == .library);
    return compiled.library;
}

fn replacementTrace(deferred: bool, status: caps.EffectStatus, fail_at: usize, finish: bool) ![]u8 {
    const gpa = testing.allocator;
    const old = try library("user", "function one\nreturn 1\nend one\n", &.{});
    defer old.destroy();
    const fresh = try library("user", "function one\nreturn 2\nend one\n", &.{});
    defer fresh.destroy();
    const wrapper = try library("wrapper", "use one from user\nfunction two\nreturn one() + 1\nend two\n", &.{old});
    defer wrapper.destroy();
    const shape = try caps.Shape.kind(gpa, .nothing);
    defer shape.release();
    var operations = [_]caps.Operation{.{ .name = "write", .args = &.{}, .result = shape, .mode = .immediate, .segment_bound = true, .host = .{ .call = Host.call } }};
    var capability: caps.Capability = .{ .name = "resource", .operations = &operations };
    var allowed = [_]bool{true};
    // Failure on the second Script must prevent replacement of the first,
    // too. Every rollback is answered once, even across several pauses.
    var host: Host = .{ .deferred = deferred, .fail_at = fail_at, .status = status };
    var grant: caps.Grant = .{ .capability = &capability, .operations = &allowed, .coordinator = .{ .identity = 1, .hook = Host.hook, .context = &host } };
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var made: ?[]*machine.Library = null;
    defer if (made) |owned| {
        for (owned) |l| l.destroy();
        gpa.free(owned);
    };
    var g: machine.Group = .init(gpa, &out.writer);
    defer g.deinit();
    try g.addLibrary(old);
    try g.addLibrary(wrapper);
    const source = "use two from wrapper\non go\nask r to write\nrepeat forever\nend repeat\nend go\non value\nreturn two()\nend value\n";
    const a = (try g.load("a", source, .{ .grants = &.{.{ .name = "r", .grant = &grant }} })).loaded;
    const b = (try g.load("b", source, .{ .grants = &.{.{ .name = "r", .grant = &grant }} })).loaded;
    const a_identity = a.identity;
    const b_identity = b.identity;
    _ = try g.deliver("a", "go", &.{}, false);
    _ = try g.deliver("b", "go", &.{}, false);
    try g.pumpWith(.{ .seconds = 1790000000, .nanos = 0 }, 40, 0);
    var result = try g.replaceLibrary(fresh, true, gpa);
    if (!finish) {
        try testing.expect(result == .paused);
        return out.toOwnedSlice();
    }
    var pauses: usize = 0;
    while (result == .paused) {
        pauses += 1;
        try testing.expect(pauses <= 2);
        try testing.expectEqual(old, g.libraries.items[0]);
        try testing.expectEqual(wrapper, g.libraries.items[1]);
        try testing.expectEqual(a_identity, a.identity);
        try testing.expectEqual(b_identity, b.identity);
        result = (try g.resumeWork()).replace;
    }
    try testing.expectEqual(@as(usize, if (deferred) 2 else 0), pauses);
    try testing.expectEqual(@as(usize, 2), host.rollbacks);
    if (status == .ok) {
        try testing.expect(result == .replaced);
        made = result.replaced;
        try testing.expectEqual(@as(usize, 1), result.replaced.len);
        try testing.expectEqual(fresh, g.libraries.items[0]);
        try testing.expect(!std.mem.eql(u8, &a_identity, &a.identity));
        try testing.expect(!std.mem.eql(u8, &b_identity, &b.identity));
        try testing.expect(a.stopped == null and b.stopped == null);
        const requested = try g.deliver("a", "value", &.{}, true);
        try g.pump(.{ .seconds = 1790000000, .nanos = 0 });
        const three = try model.scalar(gpa, .{ .number = .fromInt(3) });
        defer three.release();
        try testing.expect(try three.equal(g.results.get(requested).?));
    } else {
        // The result must distinguish fatal termination from success.
        try testing.expect(result == .stopped);
        try testing.expectEqual(old, g.libraries.items[0]);
        try testing.expectEqual(wrapper, g.libraries.items[1]);
        try testing.expectEqual(a_identity, a.identity);
        try testing.expectEqual(b_identity, b.identity);
        try testing.expect(g.fatal);
        try testing.expect(a.stopped != null and b.stopped != null);
        try testing.expectError(error.EffectStateUnknown, g.load("c", "on go\nend go\n", .{}));
        try testing.expectError(error.EffectStateUnknown, g.reload(a, source, false, false));
        try testing.expectError(error.EffectStateUnknown, g.extend(a, "on extra\nend extra\n"));
        try testing.expectError(error.EffectStateUnknown, g.replaceLibrary(fresh, false, gpa));
    }
    return out.toOwnedSlice();
}

test "Library replacement publishes all code only after deferred cleanup succeeds" {
    const gpa = testing.allocator;
    for ([_]caps.EffectStatus{ .ok, .failed, .unknown }) |status| for ([_]usize{ 1, 2 }) |fail_at| {
        const sync = try replacementTrace(false, status, fail_at, true);
        defer gpa.free(sync);
        const deferred = try replacementTrace(true, status, fail_at, true);
        defer gpa.free(deferred);
        try testing.expectEqualStrings(sync, deferred);
    };
}

test "dropping a paused Library replacement releases its prospective code" {
    const trace = try replacementTrace(true, .ok, 2, false);
    defer testing.allocator.free(trace);
}

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
    try g.pumpWith(.{ .seconds = 1790000000, .micros = 0 }, 40, 0);
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
        try g.pump(.{ .seconds = 1790000000, .micros = 0 });
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

const ScopeHost = struct {
    result: enum { ok, malformed, declared, broken } = .ok,

    fn open(_: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
        return .{ .value = model.scalar(c.gpa, .nothing) catch return .broken };
    }

    fn close(context: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
        const h: *ScopeHost = @ptrCast(@alignCast(context.?));
        return switch (h.result) {
            .ok => .{ .value = model.scalar(c.gpa, .nothing) catch return .broken },
            .malformed => .{ .value = model.scalar(c.gpa, .{ .bool = true }) catch return .broken },
            .declared => .{ .failed = .{ .code = c.gpa.dupe(u8, "broken") catch return .broken, .message = null, .data = null } },
            .broken => .broken,
        };
    }

    fn hook(_: ?*anyopaque, _: caps.Phase, _: *const caps.SegmentContext) caps.EffectStatus {
        return .ok;
    }
};

test "automatic abandonment validates results and keeps revoked disabled Grants across Reload (#1056)" {
    const a = testing.allocator;
    const nothing = try caps.Shape.kind(a, .nothing);
    defer nothing.release();
    for ([_]ScopeHost{ .{ .result = .malformed }, .{ .result = .declared }, .{ .result = .broken } }) |given| {
        var host = given;
        var errors = [_]caps.ErrorDecl{.{ .code = "broken", .fields = &.{} }};
        var ops = [_]caps.Operation{
            .{ .name = "open", .args = &.{}, .result = nothing, .mode = .immediate, .scope = .{ .opens = .{ .name = "file", .abandon = "close" } }, .host = .{ .call = ScopeHost.open } },
            .{ .name = "close", .args = &.{}, .result = nothing, .mode = .immediate, .scope = .{ .closes = "file" }, .errors = &errors, .host = .{ .call = ScopeHost.close, .context = &host } },
        };
        var capability: caps.Capability = .{ .name = "resource", .operations = &ops };
        var allowed = [_]bool{ true, true };
        var grant: caps.Grant = .{ .capability = &capability, .operations = &allowed };
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var g: machine.Group = .init(a, &out.writer);
        defer g.deinit();
        const source = "on go\nask r to open\nend go\n";
        const s = (try g.load("s", source, .{ .grants = &.{.{ .name = "r", .grant = &grant }} })).loaded;
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(.{ .seconds = 0, .micros = 0 });
        try testing.expect(s.grants[0].disabled);
        const status = if (given.result == .declared) "status=failed" else "status=unknown";
        try testing.expect(std.mem.indexOf(u8, out.written(), status) != null);
        try testing.expect(std.mem.indexOf(u8, out.written(), "action=failed") != null);
        try g.revoke("s", "r");
        try g.pump(.{ .seconds = 0, .micros = 0 });
        try testing.expect((try g.reload(s, source, true, false)) == .reloaded);
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(.{ .seconds = 0, .micros = 0 });
        try testing.expect(std.mem.indexOf(u8, out.written(), "capability disabled") != null);
    }
}

test "cancellation abandons participating scopes before rollback and unrelated scopes after cleanup (#1057)" {
    const a = testing.allocator;
    const nothing = try caps.Shape.kind(a, .nothing);
    defer nothing.release();
    var host: ScopeHost = .{};
    var bound_ops = [_]caps.Operation{
        .{ .name = "open", .args = &.{}, .result = nothing, .mode = .immediate, .segment_bound = true, .scope = .{ .opens = .{ .name = "file", .abandon = "close" } }, .host = .{ .call = ScopeHost.open } },
        .{ .name = "close", .args = &.{}, .result = nothing, .mode = .immediate, .segment_bound = true, .scope = .{ .closes = "file" }, .host = .{ .call = ScopeHost.close, .context = &host } },
    };
    var plain_ops = bound_ops;
    for (&plain_ops) |*op| op.segment_bound = false;
    var bound: caps.Capability = .{ .name = "bound", .operations = &bound_ops };
    var plain: caps.Capability = .{ .name = "plain", .operations = &plain_ops };
    var allowed = [_]bool{ true, true };
    var grant: caps.Grant = .{ .capability = &bound, .operations = &allowed, .coordinator = .{ .identity = 1, .hook = ScopeHost.hook, .context = null } };
    var unrelated: caps.Grant = .{ .capability = &plain, .operations = &allowed };
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    const loaded = try g.load("s", "script variable n=0\non go\ntry\nask a to open\nask u to open\nask b to open\nrepeat forever\nend repeat\nfinally\nput 1 into n\nend try\nend go", .{ .grants = &.{ .{ .name = "a", .grant = &grant }, .{ .name = "u", .grant = &unrelated }, .{ .name = "b", .grant = &grant } } });
    try testing.expect(loaded == .loaded);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pumpWith(.{ .seconds = 0, .micros = 0 }, 100, 0);
    try g.cancelRunInput("s/r1");
    try g.pump(.{ .seconds = 0, .micros = 0 });
    const trace = out.written();
    const close_b = std.mem.indexOf(u8, trace, "op=b.close").?;
    const close_a = std.mem.indexOf(u8, trace, "op=a.close").?;
    const rollback = std.mem.indexOf(u8, trace, "phase=rollback").?;
    const close_u = std.mem.indexOf(u8, trace, "op=u.close").?;
    try testing.expect(close_b < close_a and close_a < rollback and rollback < close_u);
}

test "fatal rollback during Stop publishes Scripts in load order and traces refused Reload (#1074)" {
    const a = testing.allocator;
    const nothing = try caps.Shape.kind(a, .nothing);
    defer nothing.release();
    const Failed = struct {
        fn hook(_: ?*anyopaque, phase: caps.Phase, _: *const caps.SegmentContext) caps.EffectStatus {
            return if (phase == .rollback) .failed else .ok;
        }
    };
    var ops = [_]caps.Operation{.{ .name = "write", .args = &.{}, .result = nothing, .mode = .immediate, .segment_bound = true, .host = .{ .call = ScopeHost.open } }};
    var capability: caps.Capability = .{ .name = "resource", .operations = &ops };
    var allowed = [_]bool{true};
    var grant: caps.Grant = .{ .capability = &capability, .operations = &allowed, .coordinator = .{ .identity = 1, .hook = Failed.hook, .context = null } };
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    const waiting = "on go\nwait 1 s\nend go";
    try testing.expect((try g.load("before", waiting, .{})) == .loaded);
    const active = try g.load("s", "on go\nask r to write\nrepeat forever\nend repeat\nend go", .{ .grants = &.{.{ .name = "r", .grant = &grant }} });
    try testing.expect(active == .loaded);
    try testing.expect((try g.load("after", waiting, .{})) == .loaded);
    for ([_][]const u8{ "before", "s", "after" }) |name| _ = try g.deliver(name, "go", &.{}, true);
    try g.pumpWith(.{ .seconds = 0, .micros = 0 }, 100, 0);
    try g.stopInput("s", "requested");
    try g.pump(.{ .seconds = 0, .micros = 0 });
    const trace = out.written();
    const before = std.mem.indexOf(u8, trace, "stopped before").?;
    const middle = std.mem.indexOf(u8, trace, "stopped s").?;
    const after = std.mem.indexOf(u8, trace, "stopped after").?;
    try testing.expect(before < middle and middle < after);
    const start = trace.len;
    try testing.expectError(error.EffectStateUnknown, g.reload(active.loaded, waiting, true, false));
    const refusal = out.written()[start..];
    try testing.expect(std.mem.indexOf(u8, refusal, "> reload s carry=yes") != null);
    try testing.expect(std.mem.indexOf(u8, refusal, "refused code=\"effect state unknown\"") != null);
}

test "stopped Script Reload releases Grants once before publishing, synchronously or paused" {
    const ReleaseHost = struct {
        pause: bool,
        releases: usize = 0,

        fn release(context: ?*anyopaque, gc: *const caps.GrantContext) void {
            const h: *@This() = @ptrCast(@alignCast(context.?));
            h.releases += 1;
            const g: *machine.Group = @ptrCast(@alignCast(gc.group.?));
            if (h.pause and gc.reason == .reload) g.release_pause = true;
        }
    };
    const gpa = testing.allocator;
    for ([_]bool{ false, true }) |pause| {
        var host: ReleaseHost = .{ .pause = pause };
        var capability: caps.Capability = .{ .name = "resource", .operations = &.{}, .release = .{ .call = ReleaseHost.release, .context = &host } };
        var grant: caps.Grant = .{ .capability = &capability, .operations = &.{} };
        var g: machine.Group = .init(gpa, null);
        defer g.deinit();
        const old = "on value\nreturn 1\nend value\n";
        const fresh = "on value\nreturn 2\nend value\n";
        const s = (try g.load("s", old, .{ .grants = &.{.{ .name = "api", .grant = &grant }} })).loaded;
        try g.stopInput("s", "done");
        try g.pump(.{ .seconds = 1790000000, .micros = 0 });
        try testing.expect(s.stopped != null);
        try testing.expectEqual(@as(usize, 1), host.releases);
        g.release_pause = false;
        try testing.expectEqual(.refused, try g.reload(s, "on", false, false));
        try testing.expectEqual(@as(usize, 1), host.releases);
        const result = try g.reload(s, fresh, false, false);
        try testing.expectEqual(@as(usize, 2), host.releases);
        if (pause) {
            try testing.expectEqual(.paused, result);
            try testing.expectEqualStrings(old, s.source);
            try testing.expect(s.stopped != null);
            g.release_pause = false;
            try testing.expectEqual(.reloaded, (try g.resumeWork()).reload);
        } else {
            try testing.expectEqual(.reloaded, result);
        }
        try testing.expectEqual(@as(usize, 2), host.releases);
        try testing.expectEqualStrings(fresh, s.source);
        try testing.expect(s.stopped == null);
    }
}

// Parking retains the dispatch-local finally scope, but owns no clause slot.
test "cancelling a parked queued Run cleans up without releasing the active Run (#1063)" {
    const a = testing.allocator;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    const loaded = try g.load("s",
        \\script variable seen = []
        \\on work n, queued
        \\ try
        \\  put n after seen
        \\  wait 1 s
        \\ finally
        \\  put n * 10 after seen
        \\ end try
        \\end work
    , .{});
    try testing.expect(loaded == .loaded);
    for (1..4) |n| {
        const v = try model.scalar(a, .{ .number = .fromInt(@as(i64, @intCast(n))) });
        var args = [_]*model.Value{v};
        _ = try g.deliver("s", "work", &args, true);
    }
    try g.pump(.{ .seconds = 0, .micros = 0 });
    const script = loaded.loaded;
    try testing.expectEqual(@as(usize, 3), script.live.items.len);
    try g.cancelRunInput("s/r2");
    try g.pump(.{ .seconds = 0, .micros = 0 });
    try testing.expectEqual(@as(usize, 2), script.live.items.len);
    try testing.expectEqualStrings("s/r1", script.live.items[0].id);
    try testing.expect(script.live.items[1].parked);
    try testing.expectEqual(@as(usize, 2), script.variables[0].data.list.len);
    for ([_]i64{ 1, 20 }, script.variables[0].data.list) |want, got| {
        try testing.expectEqual(want, try got.data.number.integer(i64));
    }
    try g.pump(.{ .seconds = 1, .micros = 0 });
    try testing.expectEqual(@as(usize, 1), script.live.items.len);
    try testing.expectEqualStrings("s/r3", script.live.items[0].id);
    try testing.expect(!script.live.items[0].parked);
    try g.pump(.{ .seconds = 2, .micros = 0 });
    try testing.expectEqual(@as(usize, 0), script.live.items.len);
}

test "unknown rollback from another Script's Stop or cancel stops every Script with the controlling Run (#1401)" {
    const a = testing.allocator;
    const nothing = try caps.Shape.kind(a, .nothing);
    defer nothing.release();
    for ([_][]const u8{ "stop", "stop-two", "cancel" }) |control| {
        const Control = struct {
            var kind: []const u8 = "";
            var rollbacks: [3]usize = .{ 0, 0, 0 };
            fn hook(_: ?*anyopaque, phase: caps.Phase, segment: *const caps.SegmentContext) caps.EffectStatus {
                if (phase != .rollback) return .ok;
                for ([_][]const u8{ "earlier", "a", "b" }, 0..) |name, i| if (std.mem.eql(u8, segment.script, name)) {
                    rollbacks[i] += 1;
                };
                return if (std.mem.eql(u8, segment.script, "a")) .unknown else .ok;
            }
            fn stop(_: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
                const g: *machine.Group = @ptrCast(@alignCast(c.owner.?));
                if (std.mem.eql(u8, kind, "cancel")) {
                    g.cancelRunInput("a/r1") catch return .broken;
                } else {
                    g.stopInput("a", "requested") catch return .broken;
                    if (std.mem.eql(u8, kind, "stop-two")) g.stopInput("earlier", "second") catch return .broken;
                }
                return .{ .value = model.scalar(c.gpa, .nothing) catch return .broken };
            }
        };
        Control.kind = control;
        Control.rollbacks = .{ 0, 0, 0 };
        var write = [_]caps.Operation{.{ .name = "write", .args = &.{}, .result = nothing, .mode = .immediate, .segment_bound = true, .host = .{ .call = ScopeHost.open } }};
        var resource: caps.Capability = .{ .name = "resource", .operations = &write };
        var allowed = [_]bool{true};
        var r: caps.Grant = .{ .capability = &resource, .operations = &allowed, .coordinator = .{ .identity = 1, .hook = Control.hook, .context = null } };
        var ctrl_ops = [_]caps.Operation{
            .{ .name = "stop", .args = &.{}, .result = nothing, .mode = .immediate, .host = .{ .call = Control.stop } },
            .{ .name = "mark", .args = &.{}, .result = nothing, .mode = .immediate, .host = .{ .call = ScopeHost.open } },
        };
        var ctrl_cap: caps.Capability = .{ .name = "ctrl", .operations = &ctrl_ops };
        var ctrl_allowed = [_]bool{ true, true };
        var ctrl: caps.Grant = .{ .capability = &ctrl_cap, .operations = &ctrl_allowed };
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var g: machine.Group = .init(a, &out.writer);
        defer g.deinit();
        const busy = "on go\nask r to write\nrepeat forever\nend repeat\nend go";
        try testing.expect((try g.load("earlier", busy, .{ .grants = &.{.{ .name = "r", .grant = &r }} })) == .loaded);
        try testing.expect((try g.load("a", busy, .{ .grants = &.{.{ .name = "r", .grant = &r }} })) == .loaded);
        try testing.expect((try g.load("b", "on go\nask r to write\nask ctrl to stop\nask ctrl to mark\nend go", .{ .grants = &.{ .{ .name = "ctrl", .grant = &ctrl }, .{ .name = "r", .grant = &r } } })) == .loaded);
        for ([_][]const u8{ "earlier", "a", "b" }) |name| _ = try g.deliver(name, "go", &.{}, true);
        try g.pumpWith(.{ .seconds = 0, .micros = 0 }, 100, 0);
        const trace = out.written();
        var stopped: std.ArrayList(u8) = .empty;
        defer stopped.deinit(a);
        var lines = std.mem.splitScalar(u8, trace, '\n');
        while (lines.next()) |line| if (std.mem.startsWith(u8, line, "stopped ")) {
            try testing.expect(std.mem.indexOf(u8, line, "reason=\"effect state unknown\"") != null);
            var fields = std.mem.splitScalar(u8, line, ' ');
            _ = fields.next();
            try stopped.appendSlice(a, fields.next().?);
            try stopped.append(a, ',');
        };
        testing.expectEqualStrings("earlier,a,b,", stopped.items) catch |e| {
            std.debug.print("{s}: {s}\n", .{ control, trace });
            return e;
        };
        try testing.expectEqual([3]usize{ 1, 1, 1 }, Control.rollbacks);
        try testing.expect(std.mem.indexOf(u8, trace, "ctrl.mark") == null);
        try testing.expect(g.stoppedState());
    }
}

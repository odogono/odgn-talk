//! Callback-return ordering from chapter 9 and paused-crossing-inputs.md (#962).
const std = @import("std");
const machine = @import("machine.zig");
const caps = @import("capabilities.zig");
const objects = @import("objects.zig");
const model = @import("../value.zig");
const t = std.testing;
pub const clock: model.dates.Instant = .{ .seconds = 0, .micros = 0 };
pub const Crossing = enum { immediate, suspending, get, set };
pub const Control = enum { none, stop, cancel, rewind };
pub const Return = enum { value, wrong_shape, failure, invalid_failure, duplicate_failure, broken, started, refused };

pub fn source(crossing: Crossing) []const u8 {
    const prefix = "script variable n = 0\nscript variable cleaned = 0\non go o\ntry\nput 9 into n\n";
    const suffix = "put 8 into n\nfinally\nput 3 into cleaned\nend try\nreturn n\nend go\n";
    return switch (crossing) {
        .immediate => prefix ++ "ask api to read\n" ++ suffix,
        .suspending => prefix ++ "ask api to read and wait\n" ++ suffix,
        .get => prefix ++ "get the size of o\n" ++ suffix,
        .set => prefix ++ "set the size of o to 7\n" ++ suffix,
    };
}

pub fn cleanupSource(crossing: Crossing) []const u8 {
    return switch (crossing) {
        .immediate => "on go o\ntry\nwait 1 s\nfinally\nask api to read\nend try\nend go\n",
        .get => "on go o\ntry\nwait 1 s\nfinally\nget the size of o\nend try\nend go\n",
        .set => "on go o\ntry\nwait 1 s\nfinally\nset the size of o to 7\nend try\nend go\n",
        .suspending => unreachable,
    };
}

pub const Host = struct {
    g: *machine.Group,
    control: Control,
    result: Return,
    calls: usize = 0,
    target: ?[]const u8 = null,
    scope_abandoned: usize = 0,
    skip_first: bool = false,
    charged: u64 = 0,

    pub fn queue(h: *Host) !void {
        switch (h.control) {
            .none => {},
            .stop => try h.g.stopInput(h.target orelse "s", "crossing"),
            .cancel => try h.g.cancelRunInput(h.target orelse "s/r1"),
            .rewind => try h.g.rewindRunInput(h.target orelse "s/r1"),
        }
    }

    pub fn call(context: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
        const h: *Host = @ptrCast(@alignCast(context.?));
        if (c.automatic) {
            h.scope_abandoned += 1;
            return .{ .value = model.scalar(c.gpa, .nothing) catch return .broken };
        }
        h.calls += 1;
        if (h.skip_first and h.calls == 1) return .{ .value = model.scalar(c.gpa, .{ .number = .fromInt(7) }) catch return .broken };
        h.queue() catch return .broken;
        if (h.charged > 0) _ = c.charge(h.charged);
        if (h.result == .refused) {
            _ = c.charge(5);
            _ = c.charge(9_000_000_000);
        } else if (h.result == .started) return .started;
        return h.outcome(c.gpa) catch .broken;
    }

    pub fn outcome(h: *Host, gpa: std.mem.Allocator) !caps.Outcome {
        return switch (h.result) {
            .value => .{ .value = try model.scalar(gpa, .{ .number = .fromInt(7) }) },
            .wrong_shape, .refused => .{ .value = try model.scalar(gpa, .{ .bool = true }) },
            .broken, .started => .broken,
            .failure, .invalid_failure, .duplicate_failure => .{ .failed = .{
                .code = try gpa.dupe(u8, if (h.result == .invalid_failure) "timeout" else "oops"),
                .message = null,
                .data = if (h.result == .duplicate_failure) try failureData(gpa) else null,
            } },
        };
    }

    fn failureData(gpa: std.mem.Allocator) !*model.Value {
        const code = try model.text(gpa, "duplicate");
        defer code.release();
        return model.map(gpa, &.{.{ .key = "code", .value = code }});
    }

    fn prop(h: *Host, gpa: std.mem.Allocator) objects.Result {
        h.calls += 1;
        h.queue() catch return .broken;
        return switch (h.outcome(gpa) catch return .broken) {
            .value => |v| .{ .value = v },
            .failed => |f| .{ .failed = f },
            else => .broken,
        };
    }

    pub fn get(context: ?*anyopaque, gpa: std.mem.Allocator, _: *objects.Object) objects.Result {
        const h: *Host = @ptrCast(@alignCast(context.?));
        return h.prop(gpa);
    }
    pub fn set(context: ?*anyopaque, gpa: std.mem.Allocator, _: *objects.Object, _: *const model.Value) objects.Result {
        const h: *Host = @ptrCast(@alignCast(context.?));
        return h.prop(gpa);
    }
};

const Fixture = struct {
    shape: *caps.Shape,
    nothing_shape: *caps.Shape,
    operations: [2]caps.Operation = undefined,
    capability: caps.Capability = undefined,
    allowed: [2]bool = .{ true, true },
    grant: caps.Grant = undefined,
    props: [1]objects.Prop = undefined,
    kind: objects.Kind = undefined,
    object: *objects.Object = undefined,
    script: *machine.Script = undefined,

    fn init(f: *Fixture, h: *Host, crossing: Crossing, text: []const u8) !void {
        f.allowed = .{ true, true };
        f.shape = try caps.Shape.kind(t.allocator, .number);
        errdefer f.shape.release();
        f.nothing_shape = try caps.Shape.kind(t.allocator, .nothing);
        errdefer f.nothing_shape.release();
        f.operations = .{
            .{ .name = "abandon", .args = &.{}, .result = f.nothing_shape, .mode = .immediate, .host = .{ .call = Host.call, .context = h } },
            .{ .name = "read", .args = &.{}, .result = f.shape, .mode = if (crossing == .suspending) .suspending else .immediate, .cost = .{ .fuel = 7 }, .host = .{ .call = Host.call, .context = h } },
        };
        f.capability = .{ .name = "api", .operations = &f.operations };
        f.grant = .{ .capability = &f.capability, .operations = &f.allowed };
        f.props = .{.{ .name = "size", .shape = f.shape, .get = .{ .call = Host.get, .context = h }, .set = .{ .call = Host.set, .context = h }, .get_cost = .{ .fuel = 7 }, .set_cost = .{ .fuel = 7 } }};
        f.kind = .{ .name = "thing", .props = &f.props };
        f.object = try h.g.object(&f.kind, "o", null);
        const loaded = try h.g.load("s", text, .{ .grants = &.{.{ .name = "api", .grant = &f.grant }} });
        try t.expect(loaded == .loaded);
        f.script = loaded.loaded;
    }
    fn deliver(f: *Fixture, g: *machine.Group) !void {
        var args = [_]*model.Value{f.object.value.retain()};
        _ = try g.deliver("s", "go", &args, false);
    }
    fn deinit(f: *Fixture) void {
        f.shape.release();
        f.nothing_shape.release();
    }
};

fn contains(trace: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, trace, needle) == null) {
        std.debug.print("missing {s} in:\n{s}", .{ needle, trace });
        return error.TestExpectedEqual;
    }
}

fn noHostFailure(g: *machine.Group) !void {
    for (g.reports.list.items) |r| try t.expect(r != .call_failed);
}

test "callback controls precede rejecting Operation and property returns" {
    for (std.enums.values(Crossing)) |crossing| for ([_]Control{ .stop, .cancel, .rewind }) |control| for ([_]Return{ .value, .wrong_shape, .failure, .invalid_failure, .duplicate_failure, .broken, .started }) |result| {
        var trace: std.Io.Writer.Allocating = .init(t.allocator);
        defer trace.deinit();
        var g: machine.Group = .init(t.allocator, &trace.writer);

        var host: Host = .{ .g = &g, .control = control, .result = result };
        var fixture: Fixture = undefined;
        fixture.init(&host, crossing, source(crossing)) catch |e| {
            std.debug.print("{s}", .{trace.written()});
            g.deinit();
            return e;
        };
        defer fixture.deinit();
        defer g.deinit();
        try fixture.deliver(&g);
        try g.pump(clock);
        try t.expectEqual(@as(usize, 1), host.calls);
        try t.expectEqual(@as(i64, 0), try fixture.script.variables[0].data.number.integer(i64));
        try t.expectEqual(@as(i64, if (control == .cancel) 3 else 0), try fixture.script.variables[1].data.number.integer(i64));
        try noHostFailure(&g);
        if (control == .stop) try contains(trace.written(), "end=stop");
        if (control == .rewind) try t.expect(g.rewound);
        if (crossing == .suspending and (result == .started or result == .value or result == .wrong_shape)) {
            try t.expect(g.callById("s/r1.c1").?.abandoned.load(.acquire));
            try t.expectEqual(@as(usize, 0), g.pending.items.len);
            if (control == .stop) try contains(trace.written(), "abandoned=[s/r1.c1]");
            if (control == .cancel) try contains(trace.written(), "abandon s/r1.c1");
        }
        const crossing_at = std.mem.indexOf(u8, trace.written(), if (crossing == .get or crossing == .set) "prop " else "call ").?;
        const control_at = std.mem.indexOf(u8, trace.written(), switch (control) {
            .stop => "> stop ",
            .cancel => "> cancel-run ",
            .rewind => "> rewind-run ",
            .none => unreachable,
        }).?;
        try t.expect(crossing_at < control_at);
    };
}

test "cancellation cleanup still reports invalid results and Host failures" {
    for (std.enums.values(Crossing)) |crossing| for ([_]Return{ .failure, .wrong_shape, .invalid_failure, .duplicate_failure, .broken }) |result| {
        if (crossing == .suspending or (crossing == .set and result == .wrong_shape)) continue;
        var g: machine.Group = .init(t.allocator, null);

        var host: Host = .{ .g = &g, .control = .none, .result = result };
        var fixture: Fixture = undefined;
        const text = cleanupSource(crossing);
        fixture.init(&host, crossing, text) catch |e| {
            g.deinit();
            return e;
        };
        defer fixture.deinit();
        defer g.deinit();
        try fixture.deliver(&g);
        try g.pump(clock);
        try g.cancelRunInput("s/r1");
        try g.pump(clock);
        var found = false;
        for (g.reports.list.items) |r| if (r == .run_end) {
            found = true;
            try t.expectEqual(machine.report.Outcome.cancelled, r.run_end.outcome);
            try t.expectEqualStrings(if (result == .failure) "oops" else "host error", r.run_end.cleanup_failed.?.code);
        };
        try t.expect(found);
    };
}

test "callback Stop lands before a latched Charge refusal and retains accepted Fuel" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);

    var host: Host = .{ .g = &g, .control = .stop, .result = .refused };
    var fixture: Fixture = undefined;
    fixture.init(&host, .immediate, source(.immediate)) catch |e| {
        g.deinit();
        return e;
    };
    defer fixture.deinit();
    defer g.deinit();
    fixture.operations[1].metering = .read_only;
    try fixture.deliver(&g);
    try g.pump(clock);
    try contains(trace.written(), "charged=5 charge-refused=yes");
    try contains(trace.written(), "end=stop");
    try t.expect(std.mem.indexOf(u8, trace.written(), "fault ") == null);
    try t.expectEqualStrings("crossing", fixture.script.stopped.?);
    try t.expectEqual(@as(i64, 0), try fixture.script.variables[0].data.number.integer(i64));
    try noHostFailure(&g);
}

test "a refused Charge remains latched when crossing cancellation starts cleanup" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    var host: Host = .{ .g = &g, .control = .cancel, .result = .refused };
    var fixture: Fixture = undefined;
    try fixture.init(&host, .immediate, source(.immediate));
    defer fixture.deinit();
    defer g.deinit();
    try fixture.deliver(&g);
    try g.pump(clock);
    try contains(trace.written(), "charged=5");
    try contains(trace.written(), "cleanup-failed s/r1 limit=cleanup");
    try contains(trace.written(), "outcome=cancelled");
    try t.expectEqual(@as(i64, 0), try fixture.script.variables[1].data.number.integer(i64));
    try noHostFailure(&g);
}

const Coordinator = struct {
    rollbacks: usize = 0,
    fn hook(context: ?*anyopaque, phase: caps.Phase, _: *const caps.SegmentContext) caps.EffectStatus {
        const h: *Coordinator = @ptrCast(@alignCast(context.?));
        if (phase == .rollback) h.rollbacks += 1;
        return .ok;
    }
};

fn otherRunTrace(crossing: Crossing, result: Return, control: Control, deferred: bool, finish: bool) ![]u8 {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    errdefer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    var host: Host = .{ .g = &g, .control = .none, .result = .value };
    var fixture: Fixture = undefined;
    fixture.init(&host, crossing, source(crossing)) catch |e| {
        g.deinit();
        return e;
    };
    defer fixture.deinit();
    defer g.deinit();
    var coordinator: Coordinator = .{};
    fixture.operations[1].mode = .immediate;
    fixture.operations[1].segment_bound = true;
    fixture.grant.coordinator = .{ .identity = 1, .hook = Coordinator.hook, .context = &coordinator };
    const victim = try g.load("a", "script variable n = 0\non hold\nput 9 into n\nask api to read\nrepeat forever\nend repeat\nend hold\n", .{ .grants = &.{.{ .name = "api", .grant = &fixture.grant }} });
    try t.expect(victim == .loaded);
    _ = try g.deliver("a", "hold", &.{}, false);
    try g.pumpWith(clock, 45, 0);
    try t.expectEqual(@as(usize, 1), host.calls);
    host.control = control;
    host.target = if (control == .stop) "a" else "a/r1";
    host.result = result;
    host.charged = 5;
    g.defer_crossings = deferred;
    try fixture.deliver(&g);
    try g.pumpWith(clock, 100, 0);
    if (!finish) {
        // An immediate Operation may first pause at its own begin hook.
        // Drop the Group only once the completed callback return is retained.
        var advances: usize = 0;
        while (fixture.script.live.items.len == 0 or (fixture.script.live.items[0].returned_op == null and fixture.script.live.items[0].returned_prop == null)) {
            try t.expect(g.pumpPaused());
            advances += 1;
            try t.expect(advances < 3);
            try g.resumePump();
        }
        try t.expect(g.pumpPaused());
        try t.expectEqual(@as(usize, 2), host.calls);
        return trace.toOwnedSlice();
    }
    var pauses: usize = 0;
    while (g.pumpPaused()) {
        pauses += 1;
        try t.expect(pauses < 10);
        try g.resumePump();
    }
    try t.expectEqual(@as(usize, 2), host.calls);
    try t.expectEqual(@as(usize, if (crossing == .immediate and result == .refused) 2 else 1), coordinator.rollbacks);
    if (deferred) try t.expect(pauses > 0);
    return trace.toOwnedSlice();
}

test "callback returns survive another Run's deferred cleanup without repeated calls or charges" {
    for ([_]Crossing{ .immediate, .get, .set }) |crossing| for ([_]Return{ .value, .wrong_shape, .failure, .invalid_failure, .duplicate_failure, .broken, .refused }) |result| for ([_]Control{ .stop, .cancel, .rewind }) |control| {
        const sync = try otherRunTrace(crossing, result, control, false, true);
        defer t.allocator.free(sync);
        const paused = try otherRunTrace(crossing, result, control, true, true);
        defer t.allocator.free(paused);
        try t.expectEqualStrings(sync, paused);
    };
}

test "dropping a callback return paused for other Run cleanup releases its Values" {
    for ([_]Crossing{ .immediate, .get, .set }) |crossing| for ([_]Return{ .value, .failure }) |result| {
        const trace = try otherRunTrace(crossing, result, .stop, true, false);
        defer t.allocator.free(trace);
    };
}

test "a successful opener is acknowledged and abandoned even when its result has the wrong Shape" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    var host: Host = .{ .g = &g, .control = .stop, .result = .wrong_shape };
    var fixture: Fixture = undefined;
    fixture.init(&host, .immediate, source(.immediate)) catch |e| {
        g.deinit();
        return e;
    };
    defer fixture.deinit();
    defer g.deinit();
    fixture.operations[0].mode = .immediate;
    fixture.operations[0].result = fixture.nothing_shape;
    fixture.operations[0].scope = .{ .closes = "resource" };
    fixture.operations[1].scope = .{ .opens = .{ .name = "resource", .abandon = "abandon" } };
    try fixture.deliver(&g);
    try g.pump(clock);
    try contains(trace.written(), "action=opened\n> stop s");
    try contains(trace.written(), "action=abandoned");
    try t.expectEqual(@as(usize, 1), host.scope_abandoned);
    try noHostFailure(&g);
}

test "a non-rewindable callback still classifies its invalid return" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    var host: Host = .{ .g = &g, .control = .rewind, .result = .wrong_shape };
    var fixture: Fixture = undefined;
    fixture.init(&host, .immediate, "script variable n = 0\non go o\nwait 0 s\nput 9 into n\nask api to read\nend go\n") catch |e| {
        g.deinit();
        return e;
    };
    defer fixture.deinit();
    defer g.deinit();
    try fixture.deliver(&g);
    try g.pump(clock);
    try g.pump(clock);
    try contains(trace.written(), "kind=not-rewindable");
    try contains(trace.written(), "call-failed s/r1.c1");
    try t.expectEqual(@as(i64, 9), try fixture.script.variables[0].data.number.integer(i64));
    try t.expect(!g.rewound);
}

test "successful closure is acknowledged before Stop despite an invalid result" {
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    var host: Host = .{ .g = &g, .control = .stop, .result = .wrong_shape, .skip_first = true };
    var fixture: Fixture = undefined;
    fixture.init(&host, .immediate, "on go o\nask api to read\nask api to abandon\nend go\n") catch |e| {
        g.deinit();
        return e;
    };
    defer fixture.deinit();
    defer g.deinit();
    fixture.operations[0].mode = .immediate;
    fixture.operations[0].result = fixture.nothing_shape;
    fixture.operations[0].scope = .{ .closes = "resource" };
    fixture.operations[1].scope = .{ .opens = .{ .name = "resource", .abandon = "abandon" } };
    try t.expect(fixture.capability.validScopes());
    try fixture.deliver(&g);
    try g.pump(clock);
    try contains(trace.written(), "action=closed\n> stop s");
    try t.expectEqual(@as(usize, 2), host.calls);
    try t.expectEqual(@as(usize, 0), host.scope_abandoned);
    try noHostFailure(&g);
}

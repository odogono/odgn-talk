//! Zig-only acceptance while the shared metering catalogue is staged (#911).
const std = @import("std");
const machine = @import("machine.zig");
const caps = @import("capabilities.zig");
const model = @import("../value.zig");
const snapshot = @import("snapshot.zig");
const fingerprint = @import("fingerprint.zig");
const t = std.testing;
const clock: model.dates.Instant = .{ .seconds = 0, .micros = 0 };
const source = "script variable committed = 0\non go\n  put 1 into committed\n  ask api to fetch and wait\n  return it\nend go\n";

const Host = struct {
    shape: caps.Shape = .{ .allocator = t.allocator, .data = .{ .kind = .any } },
    ops: [1]caps.Operation = undefined,
    kept: [1]bool = .{true},
    capability: caps.Capability = undefined,
    grant: caps.Grant = undefined,
    named: [1]machine.NamedGrant = undefined,
    calls: std.ArrayList(*caps.Call) = .empty,
    chunks: []const u64 = &.{},
    suppress: bool = false,
    enqueue_start: bool = false,
    request: ?*caps.ChargeRequest = null,

    fn init(h: *Host, mode: caps.Mode) void {
        h.ops = .{.{ .name = "fetch", .args = &.{}, .result = &h.shape, .mode = mode, .metering = .read_only, .cost = .{ .fuel = 7 }, .host = .{ .call = callback, .context = h } }};
        h.capability = .{ .name = "metered", .operations = &h.ops };
        h.grant = .{ .capability = &h.capability, .operations = &h.kept };
        h.named = .{.{ .name = "api", .grant = &h.grant }};
    }
    fn deinit(h: *Host) void {
        h.calls.deinit(t.allocator);
    }
    fn callback(context: ?*anyopaque, call: *caps.Call, _: []const *model.Value) caps.Outcome {
        const h: *Host = @ptrCast(@alignCast(context.?));
        for (h.chunks) |amount| if (!call.charge(amount) and !h.suppress) return .limited;
        if (h.ops[0].mode == .suspending) {
            h.calls.append(t.allocator, call) catch return .broken;
            if (h.enqueue_start) {
                const g: *machine.Group = @ptrCast(@alignCast(call.owner.?));
                h.request = g.requestCharge(call.id, 11) catch return .broken;
            }
            return .started;
        }
        return .{ .value = model.scalar(call.gpa, .nothing) catch return .broken };
    }
    fn load(h: *Host, g: *machine.Group, text: []const u8) !*machine.Script {
        const result = try g.load("s", text, .{ .grants = &h.named, .limits = .{ .fuel_per_run = 1000 } });
        try t.expect(result == .loaded);
        return result.loaded;
    }
};

fn contains(trace: *std.Io.Writer.Allocating, text: []const u8) !void {
    if (std.mem.indexOf(u8, trace.written(), text) == null) {
        std.debug.print("missing {s} in:\n{s}", .{ text, trace.written() });
        return error.TestExpectedEqual;
    }
}
fn endReport(g: *machine.Group) !machine.report.RunEnd {
    for (g.reports.list.items) |r| if (r == .run_end) return r.run_end;
    return error.TestExpectedEqual;
}

test "long-lived polling Runs compact issued call history" {
    for ([_]caps.Mode{ .suspending, .immediate }) |mode| {
        var h: Host = .{};
        h.init(mode);
        h.ops[0].metering = null;
        defer h.deinit();
        var g: machine.Group = .init(t.allocator, null);
        defer g.deinit();
        const text = if (mode == .suspending)
            "on go\n  repeat forever\n    ask api to fetch and wait\n  end repeat\nend go\n"
        else
            "on go\n  repeat forever\n    ask api to fetch\n    wait 15 s\n  end repeat\nend go\n";
        const loaded = try g.load("s", text, .{ .grants = &h.named, .limits = .{ .fuel_per_run = 1000000 } });
        try t.expect(loaded == .loaded);
        _ = try g.deliver("s", "go", &.{}, false);
        try g.pump(clock);
        const answer = try model.scalar(t.allocator, .nothing);
        defer answer.release();
        var baseline: usize = 0;
        for (1..481) |tick| {
            if (mode == .suspending) {
                const call = h.calls.items[h.calls.items.len - 1];
                try g.settle(call.id, .{ .answer = .{ .value = answer.retain(), .fuel = 0 } });
            }
            try g.pump(.{ .seconds = @intCast(tick * 15), .micros = 0 });
            if (tick == 240 or tick == 480) {
                const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
                defer t.allocator.free(bytes);
                if (tick == 240) baseline = bytes.len else {
                    std.debug.print("polling {s}: save@240={d}, save@480={d}\n", .{ @tagName(mode), baseline, bytes.len });
                    try t.expect(bytes.len <= baseline + 32);
                }
                var copy: machine.Group = .init(t.allocator, null);
                defer copy.deinit();
                var result: snapshot.Result = .{};
                defer result.deinit(t.allocator);
                try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &h, .call = rebind } }, &result));
                const again = try snapshot.save(&copy, t.allocator, try copy.groupFingerprint());
                defer t.allocator.free(again);
                try t.expectEqualSlices(u8, bytes, again);
                try t.expectError(error.InvalidValue, copy.requestCharge("s/r1.c1", 0));
                try t.expectError(error.UnknownCall, copy.requestCharge("s/r1.c999999", 0));
            }
        }
    }
}

test "compacted metering eligibility survives polling and Restore" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    const loaded = try g.load("s", "on go\n  repeat forever\n    ask api to fetch and wait\n    wait 15 s\n  end repeat\nend go\n", .{ .grants = &h.named, .limits = .{ .fuel_per_run = 1000000 } });
    try t.expect(loaded == .loaded);
    _ = try g.deliver("s", "go", &.{}, false);
    const answer = try model.scalar(t.allocator, .nothing);
    defer answer.release();
    var baseline: usize = 0;
    for (0..480) |tick| {
        const now: model.dates.Instant = .{ .seconds = @intCast(tick * 15), .micros = 0 };
        try g.pump(now);
        const c = h.calls.items[h.calls.items.len - 1];
        try g.settle(c.id, .{ .answer = .{ .value = answer.retain(), .fuel = 0 } });
        try g.pump(now);
        if (tick == 239 or tick == 479) {
            const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
            defer t.allocator.free(bytes);
            if (tick == 239) baseline = bytes.len else try t.expect(bytes.len <= baseline + 32);
            var copy: machine.Group = .init(t.allocator, null);
            defer copy.deinit();
            var result: snapshot.Result = .{};
            defer result.deinit(t.allocator);
            try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &h, .call = rebind } }, &result));
            // Both ends of the range are issued, even though neither call
            // remains pending. They must still admit inactive requests.
            const first = try copy.requestCharge("s/r1.c1", 1);
            const last = try copy.requestCharge(c.id, 1);
            try copy.pump(now);
            try t.expectEqual(caps.ChargeStatus.inactive, first.status);
            try t.expectEqual(caps.ChargeStatus.inactive, last.status);
            try t.expectError(error.UnknownCall, copy.requestCharge("s/r1.c999999", 0));
        }
    }
}

test "mixed issued eligibility survives Restore without filling send id gaps" {
    var plain: Host = .{};
    plain.init(.immediate);
    plain.ops[0].metering = null;
    defer plain.deinit();
    var metered: Host = .{};
    metered.init(.suspending);
    defer metered.deinit();
    const named = [_]machine.NamedGrant{ .{ .name = "plain", .grant = &plain.grant }, .{ .name = "api", .grant = &metered.grant } };
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    const loaded = try g.load("s", "on go\n  ask plain to fetch\n  ask api to fetch and wait\n  send ping to me and wait\n  ask plain to fetch\n  wait 15 s\nend go\non ping\n  return nothing\nend ping\n", .{ .grants = &named });
    try t.expect(loaded == .loaded);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const answer = try model.scalar(t.allocator, .nothing);
    defer answer.release();
    try g.settle(metered.calls.items[0].id, .{ .answer = .{ .value = answer.retain(), .fuel = 0 } });
    try g.pump(clock);
    const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
    defer t.allocator.free(bytes);
    const Binding = struct {
        plain: *Host,
        metered: *Host,
        fn resolve(context: ?*anyopaque, _: []const u8, name: []const u8) ?*caps.Grant {
            const self: *@This() = @ptrCast(@alignCast(context.?));
            return if (std.mem.eql(u8, name, "plain")) &self.plain.grant else &self.metered.grant;
        }
    };
    var binding: Binding = .{ .plain = &plain, .metered = &metered };
    var copy: machine.Group = .init(t.allocator, null);
    defer copy.deinit();
    var result: snapshot.Result = .{};
    defer result.deinit(t.allocator);
    try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &binding, .call = Binding.resolve } }, &result));
    try t.expectError(error.InvalidValue, copy.requestCharge("s/r1.c1", 0));
    const eligible = try copy.requestCharge("s/r1.c2", 0);
    try t.expectError(error.UnknownCall, copy.requestCharge("s/r1.c3", 0));
    try t.expectError(error.InvalidValue, copy.requestCharge("s/r1.c4", 0));
    try t.expectError(error.UnknownCall, copy.requestCharge("s/r1.c5", 0));
    try copy.pump(clock);
    try t.expectEqual(caps.ChargeStatus.inactive, eligible.status);
}

test "metering validates modes/effects and participates in canonical declarations" {
    var h: Host = .{};
    h.init(.immediate);
    defer h.deinit();
    try t.expect(h.capability.validScopes());
    const plain = try fingerprint.grantJson(t.allocator, &h.capability, &h.kept);
    defer t.allocator.free(plain);
    try t.expect(std.mem.indexOf(u8, plain, "\"metering\":\"read-only\"") != null);
    h.ops[0].description = "documentation";
    const doc = try fingerprint.grantJson(t.allocator, &h.capability, &h.kept);
    defer t.allocator.free(doc);
    try t.expectEqualStrings(plain, doc);
    h.ops[0].metering = null;
    const unmarked = try fingerprint.grantJson(t.allocator, &h.capability, &h.kept);
    defer t.allocator.free(unmarked);
    try t.expect(!std.mem.eql(u8, plain, unmarked));
    h.ops[0].metering = .read_only;
    h.ops[0].mode = .fire_and_forget;
    try t.expect(!h.capability.validScopes());
    h.ops[0].mode = .suspending;
    try t.expect(h.capability.validScopes());
    h.ops[0].segment_bound = true;
    try t.expect(!h.capability.validScopes());
    h.ops[0].mode = .immediate;
    try t.expect(!h.capability.validScopes());
    h.ops[0].metering = .segment_bound;
    try t.expect(h.capability.validScopes());
    h.ops[0].segment_bound = false;
    try t.expect(!h.capability.validScopes());
    h.ops[0].metering = .read_only;
    h.ops[0].scope = .{ .closes = "scope" };
    try t.expect(!h.capability.validScopes());
}

test "repeated synchronous charges latch refusal and retain accepted prefix" {
    for ([_]bool{ false, true }) |suppress| {
        var h: Host = .{ .chunks = &.{ 0, 13, 17, 1000, 0, 1 }, .suppress = suppress };
        h.init(.immediate);
        defer h.deinit();
        var trace: std.Io.Writer.Allocating = .init(t.allocator);
        defer trace.deinit();
        var g: machine.Group = .init(t.allocator, &trace.writer);
        defer g.deinit();
        _ = try h.load(&g, "on go\n  ask api to fetch\n  return it\nend go\n");
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(clock);
        try contains(&trace, "charged=30 charge-refused=yes\n");
        try t.expectEqual(machine.report.Outcome.limit_fault, (try endReport(&g)).outcome);
        try t.expectEqual(g.pump_fuel, (try endReport(&g)).fuel);
    }
}

test "starting request waits for another Pump, charges waiting Run, and carries slice debt" {
    var h: Host = .{ .enqueue_start = true };
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    const s = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const q = h.request.?;
    try t.expectEqualStrings("q1", q.id);
    try t.expect(!q.done.load(.acquire));
    try t.expect(snapshot.effectsPending(&g));
    try t.expectError(error.InvalidValue, g.requestCharge(h.calls.items[0].id, 1));
    const before = g.counters(s).fuel_total;
    try g.pumpWith(clock, 3, 2);
    try t.expectEqual(caps.ChargeStatus.accepted, q.status);
    try t.expect(q.done.load(.acquire));
    try t.expectEqual(@as(u64, 11), g.pump_fuel);
    try t.expectEqual(before + 11, g.counters(s).fuel_total);
    try t.expectEqual(@as(u64, 8), s.debt);
    try t.expect(!g.sliced);
    const zero = try g.requestCharge(h.calls.items[0].id, 0);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, zero.status);
    try t.expectEqual(@as(u64, 0), g.pump_fuel);
}

test "charge versus Answer FIFO and late answer costs don't bill paid work twice" {
    for ([_]bool{ false, true }) |answer_first| {
        var h: Host = .{};
        h.init(.suspending);
        defer h.deinit();
        var g: machine.Group = .init(t.allocator, null);
        defer g.deinit();
        _ = try h.load(&g, source);
        _ = try g.deliver("s", "go", &.{}, true);
        try g.pump(clock);
        const c = h.calls.items[0];
        const v = try model.scalar(t.allocator, .nothing);
        defer v.release();
        if (answer_first) try g.settle(c.id, .{ .answer = .{ .value = v.retain(), .fuel = 5 } });
        const q = try g.requestCharge(c.id, 19);
        if (!answer_first) try g.settle(c.id, .{ .answer = .{ .value = v.retain(), .fuel = 5 } });
        const fuel_before = g.pump_fuel;
        try g.pump(clock);
        try t.expectEqual(if (answer_first) caps.ChargeStatus.inactive else .accepted, q.status);
        const end = try endReport(&g);
        try t.expectEqual(end.fuel, fuel_before + g.pump_fuel);
        const late = try g.requestCharge(c.id, 1000);
        try g.pump(clock);
        try t.expectEqual(caps.ChargeStatus.inactive, late.status);
        try t.expectEqual(@as(u64, 0), g.pump_fuel);
    }
}

test "limit faults at originating call, keeps committed variables, and emits no Segment" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    const s = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const paid = try g.requestCharge(h.calls.items[0].id, 37);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, paid.status);
    const offset = trace.written().len;
    const q = try g.requestCharge(h.calls.items[0].id, 1000);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.limit, q.status);
    try t.expect(h.calls.items[0].abandoned.load(.acquire));
    const end = try endReport(&g);
    try t.expectEqual(@as(u32, 4), end.at.line);
    try t.expectEqual(machine.report.Outcome.limit_fault, end.outcome);
    try t.expectEqual(@as(u64, 0), g.pump_fuel);
    try t.expect(std.mem.indexOf(u8, trace.written()[offset..], "\nseg ") == null);
    try t.expectEqual(@as(u64, 1), s.faults);
    try t.expectEqual(@as(i64, 1), try s.variables[0].data.number.integer(i64));
    const result_at = std.mem.indexOf(u8, trace.written()[offset..], "charge-result").?;
    const fault_at = std.mem.indexOf(u8, trace.written()[offset..], "fault ").?;
    try t.expect(result_at < fault_at);
    try t.expect(!snapshot.effectsPending(&g));
}

test "accepted charge then due timeout is paid and not refunded" {
    var h: Host = .{};
    h.init(.suspending);
    h.ops[0].max_pending_ms = 1;
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    _ = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const q = try g.requestCharge(h.calls.items[0].id, 31);
    try g.pump(.{ .seconds = 1, .micros = 0 });
    try t.expectEqual(caps.ChargeStatus.accepted, q.status);
    try t.expect(q.done.load(.acquire));
    try t.expect(h.calls.items[0].abandoned.load(.acquire));
    try t.expect(g.pump_fuel >= 31);
}

test "Reload preserves unresolved requests for inactive settlement and Save refuses without draining" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    const s = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const q = try g.requestCharge(h.calls.items[0].id, 31);
    _ = try g.reload(s, "on go\n  return 3\nend go\n", false, false);
    try t.expect(snapshot.effectsPending(&g));
    try t.expect(!q.done.load(.acquire));
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.inactive, q.status);
    try t.expect(!snapshot.effectsPending(&g));
}

fn rebind(context: ?*anyopaque, _: []const u8, _: []const u8) ?*caps.Grant {
    const h: *Host = @ptrCast(@alignCast(context.?));
    return &h.grant;
}

test "settled request counter and issued eligibility survive Save and Restore and metering mismatches" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    _ = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const c = h.calls.items[0];
    try t.expectError(error.EffectsPending, snapshot.save(&g, t.allocator, try g.groupFingerprint()));
    const first = try g.requestCharge(c.id, 19);
    try g.pump(clock);
    const v = try model.scalar(t.allocator, .nothing);
    defer v.release();
    try g.settle(c.id, .{ .answer = .{ .value = v.retain(), .fuel = 0 } });
    try g.pump(clock);
    try t.expect(first.done.load(.acquire));
    const bytes = try snapshot.save(&g, t.allocator, try g.groupFingerprint());
    defer t.allocator.free(bytes);
    var copy: machine.Group = .init(t.allocator, null);
    defer copy.deinit();
    var result: snapshot.Result = .{};
    defer result.deinit(t.allocator);
    try t.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &h, .call = rebind } }, &result));
    const stale = try copy.requestCharge(c.id, 29);
    try t.expectEqualStrings("q2", stale.id);
    try copy.pump(clock);
    try t.expectEqual(caps.ChargeStatus.inactive, stale.status);
    try t.expectError(error.UnknownCall, copy.requestCharge("never/r1.c1", 0));
    h.ops[0].metering = null;
    var mismatch: machine.Group = .init(t.allocator, null);
    defer mismatch.deinit();
    var refused: snapshot.Result = .{};
    defer refused.deinit(t.allocator);
    try t.expectEqual(snapshot.Outcome.mismatch, try snapshot.restore(&mismatch, bytes, .{ .grants = .{ .context = &h, .call = rebind } }, &refused));
}

test "Join Members share a FIFO budget and later sibling requests become inactive" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    _ = try h.load(&g, "on go\n  wait for all\n    ask api to fetch and wait\n    ask api to fetch and wait\n  end wait\nend go\n");
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    try t.expectEqual(@as(usize, 2), h.calls.items.len);
    const a = try g.requestCharge(h.calls.items[0].id, 900);
    const b = try g.requestCharge(h.calls.items[1].id, 900);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, a.status);
    try t.expectEqual(caps.ChargeStatus.limit, b.status);
    try t.expectEqual(@as(u64, 900), g.pump_fuel);
    try t.expect(h.calls.items[0].abandoned.load(.acquire));
    try t.expect(h.calls.items[1].abandoned.load(.acquire));
    try t.expectEqual(@as(u32, 4), (try endReport(&g)).at.line);
    const late = try g.requestCharge(h.calls.items[0].id, 1);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.inactive, late.status);
}

test "cancel order does not refund accepted charges and revocation leaves in-flight calls eligible" {
    for ([_]bool{ false, true }) |cancel_first| {
        var h: Host = .{};
        h.init(.suspending);
        defer h.deinit();
        var g: machine.Group = .init(t.allocator, null);
        defer g.deinit();
        _ = try h.load(&g, source);
        _ = try g.deliver("s", "go", &.{}, false);
        try g.pump(clock);
        const c = h.calls.items[0];
        if (cancel_first) try g.cancelRunInput("s/r1");
        const q = try g.requestCharge(c.id, 29);
        if (!cancel_first) try g.cancelRunInput("s/r1");
        try g.pump(clock);
        try t.expectEqual(if (cancel_first) caps.ChargeStatus.inactive else .accepted, q.status);
        try t.expect(c.abandoned.load(.acquire));
        try t.expect(g.pump_fuel >= if (cancel_first) @as(u64, 0) else 29);
    }
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    _ = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    try g.revoke("s", "api");
    const q = try g.requestCharge(h.calls.items[0].id, 17);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, q.status);
    try t.expect(!h.calls.items[0].abandoned.load(.acquire));
}

const ThreadRequest = struct {
    group: *machine.Group,
    call: []const u8,
    request: ?*caps.ChargeRequest = null,
    failed: bool = false,
    fn run(x: *ThreadRequest) void {
        x.request = x.group.requestCharge(x.call, 11) catch {
            x.failed = true;
            return;
        };
    }
};

test "concurrent native admission allocates distinct Group ids and enforces one slot per call" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    _ = try h.load(&g, "on go\n  wait for all\n    ask api to fetch and wait\n    ask api to fetch and wait\n  end wait\nend go\n");
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    var first: ThreadRequest = .{ .group = &g, .call = h.calls.items[0].id };
    var second: ThreadRequest = .{ .group = &g, .call = h.calls.items[1].id };
    const a = try std.Thread.spawn(.{}, ThreadRequest.run, .{&first});
    const b = try std.Thread.spawn(.{}, ThreadRequest.run, .{&second});
    a.join();
    b.join();
    try t.expect(!first.failed and !second.failed);
    try t.expect(!std.mem.eql(u8, first.request.?.id, second.request.?.id));
    try t.expectError(error.InvalidValue, g.requestCharge(first.call, 1));
    try g.pump(clock);
    try t.expectEqual(@as(u64, 22), g.pump_fuel);
    try t.expect(first.request.?.done.load(.acquire) and second.request.?.done.load(.acquire));
}

test "exact exhaustion is accepted even with no runnable continuation" {
    var h: Host = .{};
    h.init(.suspending);
    defer h.deinit();
    var g: machine.Group = .init(t.allocator, null);
    defer g.deinit();
    _ = try h.load(&g, source);
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    const left = 1000 - g.pending.items[0].run.fuel;
    const q = try g.requestCharge(h.calls.items[0].id, @intCast(left));
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, q.status);
    try t.expectEqual(left, g.pump_fuel);
    const zero = try g.requestCharge(h.calls.items[0].id, 0);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.accepted, zero.status);
    const refused = try g.requestCharge(h.calls.items[0].id, 1);
    try g.pump(clock);
    try t.expectEqual(caps.ChargeStatus.limit, refused.status);
    try t.expectEqual(@as(u64, 1000), (try endReport(&g)).fuel);
}

const Effects = struct {
    rolled_back: usize = 0,
    fn hook(context: ?*anyopaque, phase: caps.Phase, _: *const caps.SegmentContext) caps.EffectStatus {
        const effects: *Effects = @ptrCast(@alignCast(context.?));
        if (phase == .rollback) effects.rolled_back += 1;
        return .ok;
    }
    fn write(_: ?*anyopaque, c: *caps.Call, _: []const *model.Value) caps.Outcome {
        return .{ .value = model.scalar(c.gpa, .nothing) catch return .broken };
    }
};

test "a charge refusal in a preempted Join rolls back the open Segment even across deferred cleanup" {
    for ([_]bool{ false, true }) |deferred| {
        var h: Host = .{};
        h.init(.suspending);
        defer h.deinit();
        var effects: Effects = .{};
        var ops = [_]caps.Operation{
            h.ops[0],
            .{ .name = "write", .args = &.{}, .result = &h.shape, .mode = .immediate, .metering = .segment_bound, .segment_bound = true, .host = .{ .call = Effects.write } },
        };
        var kept = [_]bool{ true, true };
        h.capability.operations = &ops;
        h.grant.operations = &kept;
        h.grant.coordinator = .{ .identity = 1, .hook = Effects.hook, .context = &effects };
        var trace: std.Io.Writer.Allocating = .init(t.allocator);
        defer trace.deinit();
        var g: machine.Group = .init(t.allocator, &trace.writer);
        defer g.deinit();
        const s = try h.load(&g, "script variable committed = 0\non go\n  ask api to write\n  put 1 into committed\n  wait for all\n    ask api to fetch and wait\n    ask api to fetch and wait\n  end wait\nend go\n");
        _ = try g.deliver("s", "go", &.{}, false);
        for (0..100) |_| {
            try g.pumpWith(clock, 1, 0);
            if (h.calls.items.len > 0) break;
        }
        try t.expectEqual(@as(usize, 1), h.calls.items.len);
        try t.expect(g.pending.items[0].run.continuing);
        try t.expectEqual(@as(i64, 1), try s.variables[0].data.number.integer(i64));
        const at = trace.written().len;
        const q = try g.requestCharge(h.calls.items[0].id, 1000);
        g.defer_crossings = deferred;
        try g.pump(clock);
        while (g.pumpPaused()) {
            try t.expect(!q.done.load(.acquire));
            try g.resumePump();
        }
        try t.expectEqual(caps.ChargeStatus.limit, q.status);
        try t.expect(q.done.load(.acquire));
        try t.expectEqual(@as(usize, 1), effects.rolled_back);
        try t.expectEqual(@as(i64, 0), try s.variables[0].data.number.integer(i64));
        try t.expectEqual(@as(u32, 6), (try endReport(&g)).at.line);
        try t.expect(std.mem.indexOf(u8, trace.written()[at..], "\nseg ") == null);
        try contains(&trace, "rollback=[committed]");
    }
}

test "result shape failure keeps every paid increment" {
    var h: Host = .{ .chunks = &.{ 5, 7 } };
    h.init(.immediate);
    h.shape.data = .{ .kind = .number };
    defer h.deinit();
    var trace: std.Io.Writer.Allocating = .init(t.allocator);
    defer trace.deinit();
    var g: machine.Group = .init(t.allocator, &trace.writer);
    defer g.deinit();
    _ = try h.load(&g, "on go\n ask api to fetch\nend go\n");
    _ = try g.deliver("s", "go", &.{}, false);
    try g.pump(clock);
    try t.expectEqual(machine.report.Outcome.errored, (try endReport(&g)).outcome);
    try contains(&trace, "error={} charged=12");
    try t.expect((try endReport(&g)).fuel >= 12);
}

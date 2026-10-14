//! Private intrinsic conformance harness (#696); no Script-visible test API.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");
const lower = @import("../lower/lower.zig");
const snapshot = @import("snapshot.zig");
const objects = @import("objects.zig");
const caps = @import("capabilities.zig");
const testing = std.testing;
const Case = struct { name: []const u8, source: []const u8, result: []const u8, fuelLimit: ?u64 = null, allocLimit: ?u64 = null, depthLimit: ?u64 = null, object: bool = false, disposed: bool = false, foreign: bool = false, host: bool = false };
const clock: model.dates.Instant = .{ .seconds = 0, .nanos = 0 };

fn loadCases(a: std.mem.Allocator) !std.json.Parsed([]Case) {
    const raw = try std.Io.Dir.cwd().readFileAlloc(testing.io, "../../corpus/restricted-kit/cases.json", a, .unlimited);
    defer a.free(raw);
    return std.json.parseFromSlice([]Case, a, raw, .{ .allocate = .alloc_always });
}

const Host = struct {
    number: caps.Shape = .{ .references = 1000000, .allocator = testing.allocator, .data = .{ .kind = .number } },
    text: caps.Shape = .{ .references = 1000000, .allocator = testing.allocator, .data = .{ .kind = .text } },
    props: [1]objects.Prop = undefined,
    kind: objects.Kind = undefined,
    args: [1]*caps.Shape = undefined,
    ops: [2]caps.Operation = undefined,
    capability: caps.Capability = undefined,
    kept: [2]bool = .{ true, true },
    grant: caps.Grant = undefined,
    named: [1]machine.NamedGrant = undefined,
    fn init(h: *Host) void {
        h.props = .{.{ .name = "label", .shape = &h.text, .get = .{ .call = get }, .set = .{ .call = set } }};
        h.kind = .{ .name = "item", .props = &h.props };
        h.args = .{&h.number};
        h.ops = .{
            .{ .name = "read", .args = &h.args, .result = &h.number, .cost = .{ .fuel = 11 }, .mode = .immediate, .host = .{ .call = call } },
            .{ .name = "write", .args = &h.args, .result = null, .cost = .{ .fuel = 11 }, .mode = .fire_and_forget, .host = .{ .call = call } },
        };
        h.capability = .{ .name = "restrictedApi", .operations = &h.ops };
        h.grant = .{ .capability = &h.capability, .operations = &h.kept };
        h.named = .{.{ .name = "api", .grant = &h.grant }};
    }
    fn get(_: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object) objects.Result {
        @panic("restricted callback invoked Host getter");
    }
    fn set(_: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object, _: *const model.Value) objects.Result {
        @panic("restricted callback invoked Host setter");
    }
    fn call(_: ?*anyopaque, _: *caps.Call, _: []const *model.Value) caps.Outcome {
        @panic("restricted callback invoked Capability");
    }
    fn rebind(ctx: ?*anyopaque, _: []const u8, _: []const u8) ?*caps.Grant {
        const h: *Host = @ptrCast(@alignCast(ctx.?));
        return &h.grant;
    }
    fn kinds(ctx: ?*anyopaque, _: []const u8) ?*const objects.Kind {
        const h: *Host = @ptrCast(@alignCast(ctx.?));
        return &h.kind;
    }
    fn resolve(_: ?*anyopaque, _: []const u8, _: []const u8, native: *?*anyopaque) bool {
        native.* = null;
        return true;
    }
};

fn setup(g: *machine.Group, out: *std.Io.Writer.Allocating, c: Case, host: *Host) !void {
    var options: machine.LoadOptions = .{};
    if (c.fuelLimit) |n| options.limits.fuel_per_run = n;
    if (c.allocLimit) |n| options.limits.alloc_per_run = n;
    if (c.depthLimit) |n| options.limits.call_depth = n;
    if (c.host) options.grants = &host.named;
    const loaded = try g.load("s", c.source, options);
    if (loaded != .loaded) {
        std.debug.print("{s}: {s}\n", .{ c.name, out.written() });
        return error.TestUnexpectedResult;
    }
    const home = g.script("s").?;
    const lib = machine.stdlibLibrary("map").?;
    var body: u32 = 0;
    for (lib.unit.bodies, 0..) |b, i| if (std.mem.eql(u8, b.name, "restrictedCall")) {
        body = @intCast(i);
    };
    const code = try g.functionCode(home, lib, body);
    const captures = try model.map(g.gpa, &.{});
    defer captures.release();
    const fn_value = try model.function(g.gpa, "s", "<function s:map:restrictedCall>", @intFromPtr(code), captures);
    var args: [2]*model.Value = undefined;
    args[0] = fn_value;
    var n: usize = 1;
    if (c.object) {
        const o = try g.object(&host.kind, "o1", null);
        if (c.disposed) {
            try g.dispose(o);
            try g.pump(clock);
        }
        args[1] = o.value.retain();
        n = 2;
    }
    if (c.foreign) {
        try testing.expect(try g.load("other", "function callback n\n return n\nend callback\n", .{}) == .loaded);
        const other = try g.functionCode(g.script("other").?, null, 1);
        args[1] = try model.function(g.gpa, "other", "<function other:callback>", @intFromPtr(other), captures);
        n = 2;
    }
    out.writer.end = 0;
    _ = try g.deliver("s", "go", args[0..n], false);
}

test "restricted callback kit Trace agreement" {
    const a = testing.allocator;
    const cases = try loadCases(a);
    defer cases.deinit();
    for (cases.value) |c| {
        var host: Host = .{};
        host.init();
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var g: machine.Group = .init(a, &out.writer);
        defer g.deinit();
        try setup(&g, &out, c, &host);
        try g.pump(clock);
        g.vars();
        const path = try std.fmt.allocPrint(a, "../../corpus/restricted-kit/{s}.trace", .{c.name});
        defer a.free(path);
        const want = try std.Io.Dir.cwd().readFileAlloc(testing.io, path, a, .unlimited);
        defer a.free(want);
        const start = std.mem.indexOfScalar(u8, want, '\n').? + 1;
        if (!std.mem.eql(u8, want[start..], out.written())) std.debug.print("case {s}\n", .{c.name});
        try testing.expectEqualStrings(want[start..], out.written());
    }
}

test "restricted callback restores at each instruction" {
    const a = testing.allocator;
    const cases = try loadCases(a);
    defer cases.deinit();
    for (cases.value) |c| {
        var host: Host = .{};
        host.init();
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        var g: machine.Group = .init(a, &out.writer);
        defer g.deinit();
        try setup(&g, &out, c, &host);
        try g.pumpWith(clock, 1, 0);
        var finished = false;
        for (0..1000) |step| {
            const bytes = try snapshot.save(&g, a, try g.groupFingerprint());
            defer a.free(bytes);
            var copied: std.Io.Writer.Allocating = .init(a);
            defer copied.deinit();
            var copy: machine.Group = .init(a, &copied.writer);
            defer copy.deinit();
            var result: snapshot.Result = .{};
            defer result.deinit(a);
            const outcome = snapshot.restore(&copy, bytes, .{ .grants = .{ .context = &host, .call = Host.rebind }, .kinds = .{ .context = &host, .call = Host.kinds }, .resolve = .{ .call = Host.resolve } }, &result) catch |err| {
                std.debug.print("restore {s} step {d}: {s}\n", .{ c.name, step, @errorName(err) });
                return err;
            };
            try testing.expectEqual(snapshot.Outcome.full, outcome);
            out.writer.end = 0;
            copied.writer.end = 0;
            try g.pumpWith(clock, 1, 0);
            try copy.pumpWith(clock, 1, 0);
            g.vars();
            copy.vars();
            try testing.expectEqualStrings(out.written(), copied.written());
            if (std.mem.indexOf(u8, out.written(), "pumped state=idle") != null) {
                finished = true;
                break;
            }
        }
        try testing.expect(finished);
    }
}

test "restricted intrinsic has normative disassembly and no Host compilation privilege" {
    const a = testing.allocator;
    var g: machine.Group = .init(a, null);
    defer g.deinit();
    try testing.expect(try g.load("private", "use restrictedCall from map\n", .{}) != .loaded);
    const lib = machine.stdlibLibrary("map").?;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    try lower.disassemble(&lib.unit, &out.writer);
    const want = try std.Io.Dir.cwd().readFileAlloc(testing.io, "../../corpus/restricted-kit/map.dis", a, .unlimited);
    defer a.free(want);
    try testing.expectEqualStrings(want, out.written());
    const host = try machine.compileLibrary(a, "map", lib.version, lib.source, &.{}, null);
    try testing.expect(host == .library);
    defer host.library.destroy();
    for (host.library.unit.code) |i| try testing.expect(i.op != .call_restricted);
}

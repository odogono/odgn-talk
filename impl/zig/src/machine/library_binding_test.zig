//! Bound Library definitions belong to one Home and survive code lifecycle changes.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");
const snapshot = @import("snapshot.zig");
const testing = std.testing;

const helper_source =
    \\constant box = [{f: given x: x + 1}]
    \\function read
    \\  return box
    \\end read
    \\function choose callbacks = box
    \\  return callbacks
    \\end choose
    \\
;
const bridge_source =
    \\use read, choose from helper
    \\function through
    \\  return [read(), read(), choose(), choose()]
    \\end through
    \\
;
const caller_source =
    \\use through from bridge
    \\on go
    \\  return through()
    \\end go
    \\on apply callback
    \\  return callback(2)
    \\end apply
    \\
;

fn library(name: []const u8, source: []const u8, imports: []const *machine.Library) !*machine.Library {
    const compiled = try machine.compileLibrary(testing.allocator, name, "1", source, imports, null);
    try testing.expect(compiled == .library);
    return compiled.library;
}

fn read(g: *machine.Group, home: []const u8) !*model.Value {
    const id = try g.deliver(home, "go", &.{}, true);
    try g.pump(.{ .seconds = 0, .micros = 0 });
    const result = g.results.get(id) orelse return error.TestUnexpectedResult;
    const items = result.data.list;
    try testing.expectEqual(@as(usize, 4), items.len);
    // Constant reads and default reads each return their retained definition.
    try testing.expectEqual(items[0], items[1]);
    try testing.expectEqual(items[2], items[3]);
    for (items) |item| {
        const callback = item.data.list[0].data.map.at(0).value;
        try testing.expectEqualStrings(home, callback.data.function.home);
        var args = [_]*model.Value{callback.retain()};
        const called = try g.deliver(home, "apply", &args, true);
        try g.pump(.{ .seconds = 0, .micros = 0 });
        const three = g.results.get(called) orelse return error.TestUnexpectedResult;
        try testing.expectEqual(@as(i64, 3), try three.data.number.integer(i64));
    }
    return result;
}

test "Library Constant and default containers are reused per Home and renewed on code replacement" {
    const helper = try library("helper", helper_source, &.{});
    defer helper.destroy();
    const bridge = try library("bridge", bridge_source, &.{helper});
    defer bridge.destroy();
    const fresh = try library("helper", helper_source ++ "-- replacement\n", &.{});
    defer fresh.destroy();
    var rebuilt: ?[]*machine.Library = null;
    defer if (rebuilt) |libraries| {
        for (libraries) |l| l.destroy();
        testing.allocator.free(libraries);
    };
    var g: machine.Group = .init(testing.allocator, null);
    defer g.deinit();
    try g.addLibrary(helper);
    try g.addLibrary(bridge);
    for ([_][]const u8{ "a", "b" }) |home| try testing.expect(try g.load(home, caller_source, .{}) == .loaded);
    const first = try read(&g, "a");
    const again = try read(&g, "a");
    try testing.expectEqual(first.data.list[0], again.data.list[0]);
    try testing.expectEqual(first.data.list[2], again.data.list[2]);
    const other = try read(&g, "b");
    try testing.expect(first.data.list[0] != other.data.list[0]);
    const home = g.script("a").?;
    try testing.expectEqual(machine.Group.ReloadResult.reloaded, try g.reload(home, caller_source, false, false));
    try testing.expectEqual(@as(u32, 0), home.library_definitions.count());
    const reloaded = try read(&g, "a");
    try testing.expect(first.data.list[0] != reloaded.data.list[0]);
    const old_callback = first.data.list[0].data.list[0].data.map.at(0).value;
    try testing.expect(g.codeOfValue(old_callback).?.generation != home.generation);
    try testing.expectEqual(machine.Group.ExtendResult.extended, try g.extend(home, "on extra\n return through()\nend extra\n"));
    const extended = try read(&g, "a");
    try testing.expectEqual(reloaded.data.list[0], extended.data.list[0]);

    const replaced = try g.replaceLibrary(fresh, true, testing.allocator);
    try testing.expect(replaced == .replaced);
    rebuilt = replaced.replaced;
    try testing.expectEqual(@as(usize, 1), replaced.replaced.len);
    try testing.expectEqual(@as(u32, 0), home.library_definitions.count());
    const replacement = try read(&g, "a");
    try testing.expect(reloaded.data.list[0] != replacement.data.list[0]);
    try testing.expect(!home.library_definitions.contains(helper));
    const callback = replacement.data.list[0].data.list[0].data.map.at(0).value;
    try testing.expectEqual(fresh, g.codeOfValue(callback).?.library.?);
}

test "Library binding caches rebuild after cold and warm Save/Restore" {
    const helper = try library("helper", helper_source, &.{});
    defer helper.destroy();
    const bridge = try library("bridge", bridge_source, &.{helper});
    defer bridge.destroy();
    for ([_]bool{ false, true }) |warm| {
        var g: machine.Group = .init(testing.allocator, null);
        defer g.deinit();
        try g.addLibrary(helper);
        try g.addLibrary(bridge);
        try testing.expect(try g.load("a", caller_source, .{}) == .loaded);
        if (warm) _ = try read(&g, "a");
        const bytes = try snapshot.save(&g, testing.allocator, try g.groupFingerprint());
        defer testing.allocator.free(bytes);
        var copy: machine.Group = .init(testing.allocator, null);
        defer copy.deinit();
        var restored: snapshot.Result = .{};
        defer restored.deinit(testing.allocator);
        try testing.expectEqual(snapshot.Outcome.full, try snapshot.restore(&copy, bytes, .{ .libraries = &.{ helper, bridge } }, &restored));
        try testing.expectEqual(@as(u32, 0), copy.script("a").?.library_definitions.count());
        const first = try read(&copy, "a");
        const again = try read(&copy, "a");
        try testing.expectEqual(first.data.list[0], again.data.list[0]);
        try testing.expectEqual(first.data.list[2], again.data.list[2]);
    }
}

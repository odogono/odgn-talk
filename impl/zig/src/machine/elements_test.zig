//! Object Collection callbacks whose results are malformed (#1143): each is
//! `host error`, with the receiver's kind as `capability` and the callback
//! as `operation`, recorded as the `prop` crossing's `error={}`, and its
//! declared cost stays spent.
const std = @import("std");
const machine = @import("machine.zig");
const model = @import("../value.zig");
const objects = @import("objects.zig");
const caps = @import("capabilities.zig");
const chunks = @import("chunks.zig");
const testing = std.testing;
const clock: model.dates.Instant = .{ .seconds = 0, .micros = 0 };

const Answer = enum { fraction, negative, too_many, text, done, broken, number_member, wrong_kind_member, disposed_member, foreign_member, bad_failure_data, good };

const Host = struct {
    rect: caps.Shape = .{ .references = 1000000, .allocator = testing.allocator, .data = .{ .object = "rect" } },
    page: objects.Kind = undefined,
    rect_kind: objects.Kind = .{ .name = "rect", .props = &.{} },
    page_kind_other: objects.Kind = .{ .name = "page", .props = &.{} },
    answer: Answer = .good,
    member: ?*objects.Object = null,
    calls: usize = 0,

    fn init(h: *Host) void {
        h.page = .{ .name = "page", .props = &.{}, .elements = .{
            .shape = &h.rect,
            .count = count,
            .at = at,
            .find = find,
            .context = h,
            .count_cost = .{ .fuel = 5 },
            .at_cost = .{ .fuel = 5 },
            .find_cost = .{ .fuel = 5 },
        } };
    }

    fn number(text: []const u8) objects.Result {
        const d = model.Decimal.parse(text) catch unreachable;
        return .{ .value = model.scalar(testing.allocator, .{ .number = d }) catch unreachable };
    }

    fn answerOf(h: *Host) objects.Result {
        h.calls += 1;
        return switch (h.answer) {
            .fraction => number("1.5"),
            .negative => number("-1"),
            .too_many => number("9007199254740992"),
            .text => .{ .value = model.text(testing.allocator, "3") catch unreachable },
            .done => .done,
            .broken => .broken,
            .number_member => number("2"),
            .wrong_kind_member, .disposed_member, .foreign_member, .good => .{ .value = h.member.?.value.retain() },
            .bad_failure_data => .{ .failed = .{
                .code = testing.allocator.dupe(u8, "page locked") catch unreachable,
                .message = null,
                .data = model.text(testing.allocator, "not a map") catch unreachable,
            } },
        };
    }

    fn count(ctx: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object) objects.Result {
        const h: *Host = @ptrCast(@alignCast(ctx.?));
        return h.answerOf();
    }
    fn at(ctx: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object, index: i64) objects.Result {
        std.debug.assert(index != 0);
        const h: *Host = @ptrCast(@alignCast(ctx.?));
        return h.answerOf();
    }
    fn find(ctx: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object, _: []const u8) objects.Result {
        const h: *Host = @ptrCast(@alignCast(ctx.?));
        return h.answerOf();
    }
};

const source =
    \\script variable log = []
    \\on go p, how
    \\  try
    \\    if how is "count" then
    \\      put the number of elements of p after log
    \\    else if how is "at" then
    \\      put element -1 of p after log
    \\    else
    \\      put element "a" of p after log
    \\    end if
    \\  catch e
    \\    put e after log
    \\  end try
    \\end go
    \\
;

/// Runs one collection call against `answer` and gives the Trace.
fn run(a: std.mem.Allocator, answer: Answer, how: []const u8) ![]u8 {
    var host: Host = .{};
    host.init();
    host.answer = answer;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    var other: machine.Group = .init(a, null);
    defer other.deinit();
    try testing.expect(try g.load("s", source, .{}) == .loaded);
    const page = try g.object(&host.page, "main", null);
    host.member = switch (answer) {
        .wrong_kind_member => try g.object(&host.page_kind_other, "x", null),
        .foreign_member => try other.object(&host.rect_kind, "r1", null),
        else => try g.object(&host.rect_kind, "r1", null),
    };
    if (answer == .disposed_member) {
        try g.dispose(host.member.?);
        try g.pump(clock);
    }
    out.writer.end = 0;
    var args = [_]*model.Value{ page.value.retain(), try model.text(a, how) };
    _ = try g.deliver("s", "go", &args, false);
    try g.pump(clock);
    g.vars();
    try testing.expectEqual(@as(usize, 1), host.calls);
    return a.dupe(u8, out.written());
}

fn expectHostError(answer: Answer, how: []const u8, operation: []const u8) !void {
    const a = testing.allocator;
    const trace = try run(a, answer, how);
    defer a.free(trace);
    const record = try std.fmt.allocPrint(a, "name=elements op={s}", .{how});
    defer a.free(record);
    const line = std.mem.indexOf(u8, trace, record) orelse return error.TestUnexpectedResult;
    const end = std.mem.indexOfScalarPos(u8, trace, line, '\n').?;
    if (!std.mem.endsWith(u8, trace[line..end], " error={}")) {
        std.debug.print("{s}\n", .{trace});
        return error.TestUnexpectedResult;
    }
    const raised = try std.fmt.allocPrint(a, "code: \"host error\", capability: \"page\", operation: \"{s}\"", .{operation});
    defer a.free(raised);
    if (std.mem.indexOf(u8, trace, raised) == null) {
        std.debug.print("{s}\n", .{trace});
        return error.TestUnexpectedResult;
    }
}

test "a malformed count is a host error" {
    for ([_]Answer{ .fraction, .negative, .too_many, .text, .done, .broken, .bad_failure_data }) |answer| {
        try expectHostError(answer, "count", "elements.count");
    }
}

test "a member outside the Shape, disposed or of another Group is a host error" {
    for ([_]Answer{ .number_member, .wrong_kind_member, .disposed_member, .foreign_member, .done, .broken }) |answer| {
        try expectHostError(answer, "at", "elements.at");
        try expectHostError(answer, "find", "elements.find");
    }
}

test "a member and a count in range are answers" {
    const a = testing.allocator;
    const trace = try run(a, .good, "at");
    defer a.free(trace);
    try testing.expect(std.mem.indexOf(u8, trace, "op=at selector=-1 value=<object rect \"r1\">") != null);
    try testing.expect(std.mem.indexOf(u8, trace, "vars s log=[<object rect \"r1\">]") != null);
    _ = chunks;
}

/// A page of `n` rects, whose `At` gives Nothing at `hole` (#1627).
const Walk = struct {
    rect: caps.Shape = .{ .references = 1000000, .allocator = testing.allocator, .data = .{ .object = "rect" } },
    page: objects.Kind = undefined,
    rect_kind: objects.Kind = .{ .name = "rect", .props = &.{} },
    members: [3]*objects.Object = undefined,
    n: usize = 3,
    hole: i64 = 0,

    fn init(w: *Walk) void {
        w.page = .{ .name = "page", .props = &.{}, .elements = .{
            .shape = &w.rect,
            .count = count,
            .at = at,
            .find = find,
            .context = w,
            .count_cost = .{ .fuel = 5 },
            .at_cost = .{ .fuel = 7 },
            .find_cost = .{ .fuel = 5 },
        } };
    }
    fn count(ctx: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object) objects.Result {
        const w: *Walk = @ptrCast(@alignCast(ctx.?));
        return Host.number(switch (w.n) {
            0 => "0",
            else => "3",
        });
    }
    fn at(ctx: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object, index: i64) objects.Result {
        const w: *Walk = @ptrCast(@alignCast(ctx.?));
        if (index == w.hole) return .{ .value = model.scalar(testing.allocator, .nothing) catch unreachable };
        return .{ .value = w.members[@intCast(index - 1)].value.retain() };
    }
    fn find(_: ?*anyopaque, _: std.mem.Allocator, _: *objects.Object, _: []const u8) objects.Result {
        unreachable;
    }
};

const walk_source =
    \\script variable log = []
    \\on go p
    \\  try
    \\    repeat for each e in the elements of p
    \\      put the id of e after log
    \\    end repeat
    \\    put the length of (every element of p whose the id of it is not "r2") after log
    \\    put the id of (the first element of p whose the id of it is "r2") after log
    \\  catch e
    \\    put the code of e after log
    \\  end try
    \\end go
    \\
;

fn walk(a: std.mem.Allocator, n: usize, hole: i64) ![]u8 {
    var w: Walk = .{ .n = n, .hole = hole };
    w.init();
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var g: machine.Group = .init(a, &out.writer);
    defer g.deinit();
    try testing.expect(try g.load("s", walk_source, .{}) == .loaded);
    const page = try g.object(&w.page, "main", null);
    for (&w.members, [_][]const u8{ "r1", "r2", "r3" }) |*m, id| m.* = try g.object(&w.rect_kind, id, null);
    out.writer.end = 0;
    var args = [_]*model.Value{page.value.retain()};
    _ = try g.deliver("s", "go", &args, false);
    try g.pump(clock);
    g.vars();
    return a.dupe(u8, out.written());
}

test "the elements of a page are walked in order, read whole each time" {
    const a = testing.allocator;
    const trace = try walk(a, 3, 0);
    defer a.free(trace);
    if (std.mem.indexOf(u8, trace, "vars s log=[\"r1\", \"r2\", \"r3\", 2, \"r2\"]") == null) {
        std.debug.print("{s}\n", .{trace});
        return error.TestUnexpectedResult;
    }
    // Three reads, each a count then every position, even for `first`.
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, trace, "op=count"));
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, trace, "op=at selector=3 "));
}

test "an empty collection is only counted" {
    const a = testing.allocator;
    const trace = try walk(a, 0, 0);
    defer a.free(trace);
    try testing.expectEqual(@as(usize, 0), std.mem.count(u8, trace, "op=at"));
    try testing.expect(std.mem.indexOf(u8, trace, "vars s log=[0, \"wrong kind\"]") != null or std.mem.indexOf(u8, trace, "vars s log=[0") != null);
}

test "Nothing below the count is a host error" {
    const a = testing.allocator;
    const trace = try walk(a, 3, 2);
    defer a.free(trace);
    try testing.expect(std.mem.indexOf(u8, trace, "op=at selector=2 error={}") != null);
    try testing.expect(std.mem.indexOf(u8, trace, "vars s log=[\"host error\"]") != null);
    try testing.expectEqual(@as(usize, 0), std.mem.count(u8, trace, "op=at selector=3 "));
}

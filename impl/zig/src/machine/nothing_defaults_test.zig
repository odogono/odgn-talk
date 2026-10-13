//! `otherwise` and optional map-key reads at runtime (#721), observed
//! through the Trace: values, errors and their positions, Fuel, Guard
//! skips and Host crossings.
const std = @import("std");
const machine = @import("machine.zig");
const objects = @import("objects.zig");
const capabilities = @import("capabilities.zig");
const model = @import("../value.zig");

const testing = std.testing;
const Allocator = std.mem.Allocator;
const Value = model.Value;

const clock: model.dates.Instant = .{ .seconds = 1790000000, .nanos = 0 };

/// Loads `source` as Script `s`, requests `go` with `args`, pumps once and
/// returns the Trace.
fn traceOf(gpa: Allocator, source: []const u8, options: machine.LoadOptions, args: []*Value) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var g: machine.Group = .init(gpa, &out.writer);
    defer g.deinit();
    try testing.expect(try g.load("s", source, options) == .loaded);
    _ = try g.deliver("s", "go", args, true);
    try g.pump(clock);
    return out.toOwnedSlice();
}

/// The `run` record of `return <expression>` in a handler `go`.
fn runOf(gpa: Allocator, expression: []const u8) ![]u8 {
    const source = try std.fmt.allocPrint(gpa, "on go\n return {s}\nend go\n", .{expression});
    defer gpa.free(source);
    const trace = try traceOf(gpa, source, .{}, &.{});
    defer gpa.free(trace);
    const at = std.mem.indexOf(u8, trace, "\nrun ").? + 1;
    const end = std.mem.indexOfScalarPos(u8, trace, at, '\n').?;
    return gpa.dupe(u8, trace[at..end]);
}

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, haystack, needle) == null) {
        std.debug.print("expected to find\n  {s}\nin\n  {s}\n", .{ needle, haystack });
        return error.TestExpectedContains;
    }
}

fn expectResult(expression: []const u8, want: []const u8) !void {
    const gpa = testing.allocator;
    const run = try runOf(gpa, expression);
    defer gpa.free(run);
    // A run that returns Nothing records no value.
    const field = if (std.mem.eql(u8, want, "nothing"))
        try gpa.dupe(u8, "outcome=completed delivery=d1 handler=go fuel=")
    else
        try std.fmt.allocPrint(gpa, "outcome=completed delivery=d1 handler=go value={s} fuel=", .{want});
    defer gpa.free(field);
    try expectContains(run, field);
}

/// A run record's `fuel=`.
fn fuelOf(run: []const u8) !u64 {
    const at = std.mem.lastIndexOf(u8, run, " fuel=").? + 6;
    const end = std.mem.indexOfScalarPos(u8, run, at, ' ') orelse run.len;
    return std.fmt.parseInt(u64, run[at..end], 10);
}

test "otherwise defaults only Nothing, and optional reads give a map's value or Nothing" {
    const cases = [_][2][]const u8{
        .{ "nothing otherwise 2", "2" },
        .{ "false otherwise 2", "false" },
        .{ "0 otherwise 2", "0" },
        .{ "\"\" otherwise 2", "\"\"" },
        .{ "[] otherwise 2", "[]" },
        .{ "{} otherwise 2", "{}" },
        .{ "nothing otherwise nothing", "nothing" },
        .{ "nothing otherwise nothing otherwise 3", "3" },
        .{ "the missing of {a: 1} otherwise 9", "9" },
        .{ "the optional a of {a: 1}", "1" },
        .{ "the optional b of {a: 1}", "nothing" },
        .{ "the optional a of {a: nothing}", "nothing" },
        .{ "the optional a of nothing", "nothing" },
        .{ "the optional b of the optional a of {a: {b: 4}}", "4" },
        .{ "the optional b of the optional a of {}", "nothing" },
        .{ "the optional length of {length: 7}", "7" },
        .{ "the optional first of {first: 8}", "8" },
        .{ "the optional target of {target: 9}", "9" },
        .{ "the optional optional of {optional: 10}", "10" },
        .{ "the optional \"of\" of {\"of\": 11}", "11" },
        .{ "the optional of {optional: 12}", "12" },
        .{ "the optional (\"a\") of {a: 13}", "13" },
        .{ "the optional code points of {\"code points\": 14}", "14" },
        .{ "the length of [1, 2, 3]", "3" },
    };
    for (cases) |c| try expectResult(c[0], c[1]);
}

test "each side runs once, the fallback only when chosen, with the design's Fuel" {
    const gpa = testing.allocator;
    // The design's totals exclude the surrounding clause and return, which
    // `return 1` (one const) measures.
    const base = try runOf(gpa, "1");
    defer gpa.free(base);
    const surround = try fuelOf(base) - 1;
    const cases = [_]struct { []const u8, []const u8, u64 }{
        .{ "1 otherwise 2", "1", 2 },
        .{ "nothing otherwise 2", "2", 4 },
        .{ "1 otherwise 2 otherwise 3", "1", 3 },
        .{ "nothing otherwise nothing otherwise 3", "3", 7 },
        .{ "the optional a of nothing", "nothing", 4 },
        .{ "the optional (\"a\") of {}", "nothing", 1 + 1 + 1 + 3 },
    };
    for (cases) |c| {
        try expectResult(c[0], c[1]);
        const run = try runOf(gpa, c[0]);
        defer gpa.free(run);
        try testing.expectEqual(c[2], try fuelOf(run) - surround);
    }
    // A failing optional read charges what a failing ordinary read does.
    const optional = try runOf(gpa, "the optional a of 5");
    defer gpa.free(optional);
    const ordinary = try runOf(gpa, "the a of 5");
    defer gpa.free(ordinary);
    try expectContains(optional, "outcome=errored");
    try testing.expectEqual(try fuelOf(ordinary), try fuelOf(optional));

    const counting =
        \\script variable calls = 0
        \\on bump v
        \\ put calls + 1 into calls
        \\ return v
        \\end bump
        \\on go
        \\ put bump(nothing) otherwise bump(5) into x
        \\ put bump(7) otherwise bump(9) into y
        \\ return [x, y, calls, 1 otherwise 1 / 0]
        \\end go
        \\
    ;
    const trace = try traceOf(gpa, counting, .{}, &.{});
    defer gpa.free(trace);
    try expectContains(trace, "value=[5, 7, 3, 1]");

    const left = try runOf(gpa, "1 / 0 otherwise 2");
    defer gpa.free(left);
    try expectContains(left, "outcome=errored delivery=d1 handler=go error={code: \"division by zero\"");
}

test "an optional read's errors: key before receiver, at `the`, with no path" {
    const gpa = testing.allocator;
    // An invalid key with an erroring receiver reports the receiver's error.
    const boom = try traceOf(gpa,
        \\on boom
        \\ return 1 / 0
        \\end boom
        \\on go
        \\ return the optional (1) of boom()
        \\end go
        \\
    , .{}, &.{});
    defer gpa.free(boom);
    try expectContains(boom, "handler=go error={code: \"division by zero\"");

    const cases = [_][2][]const u8{
        .{ "the optional (1) of nothing", "expected: \"text\", got: \"number\", value: 1," },
        .{ "the optional (\"a\") of 5", "expected: \"map\", got: \"number\", value: 5," },
        .{ "the optional a of [1]", "expected: \"map\", got: \"list\", value: [1]," },
        .{ "the optional a of \"x\"", "expected: \"map\", got: \"text\", value: \"x\"," },
        .{ "the optional a of <<1>>", "expected: \"map\", got: \"bytes\", value: <<0x01>>," },
    };
    for (cases) |c| {
        const run = try runOf(gpa, c[0]);
        defer gpa.free(run);
        const want = try std.fmt.allocPrint(gpa, "error={{code: \"wrong kind\", {s} at: {{unit: \"s\", handler: \"go\", line: 2, column: 9}}}}", .{c[1]});
        defer gpa.free(want);
        try expectContains(run, want);
    }

    const counting = try traceOf(gpa,
        \\script variable calls = 0
        \\on bump v
        \\ put calls + 1 into calls
        \\ return v
        \\end bump
        \\on go
        \\ return [the optional (bump("a")) of bump({a: 3}), calls]
        \\end go
        \\
    , .{}, &.{});
    defer gpa.free(counting);
    try expectContains(counting, "value=[3, 2]");
}

/// A Kind whose every property Get is counted: a Host crossing.
const Counted = struct {
    gets: usize = 0,
    shape: capabilities.Shape = .{ .references = std.math.maxInt(usize) / 2, .allocator = testing.allocator, .data = .{ .kind = .text } },
    prop: [1]objects.Prop = undefined,
    kind: objects.Kind = undefined,

    fn get(context: ?*anyopaque, gpa: Allocator, _: *objects.Object) objects.Result {
        const c: *Counted = @ptrCast(@alignCast(context.?));
        c.gets += 1;
        return .{ .value = model.text(gpa, "host") catch return .broken };
    }

    fn init(c: *Counted) void {
        c.prop = .{.{ .name = "label", .shape = &c.shape, .get = .{ .call = get, .context = c } }};
        c.kind = .{ .name = "item", .props = &c.prop };
    }
};

test "optional reads reject Host Objects, live or disposed, with no Host crossing" {
    const gpa = testing.allocator;
    var counted: Counted = .{};
    counted.init();
    const sources = [_][]const u8{
        "on go o\n return the optional id of o\nend go\n",
        "on go o\n return the optional label of o\nend go\n",
        "on go o\n return the optional id of the optional held of {held: o}\nend go\n",
        "on go\n return the optional label of warehouse\nend go\n",
    };
    for ([_]bool{ false, true }) |disposed| for (sources) |source| {
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        var g: machine.Group = .init(gpa, &out.writer);
        defer g.deinit();
        const o = try g.object(&counted.kind, "o1", null);
        const named = [_]machine.NamedObject{.{ .name = "warehouse", .object = o }};
        try testing.expect(try g.load("s", source, .{ .objects = &named }) == .loaded);
        if (disposed) try g.dispose(o);
        var args = [_]*Value{o.value.retain()};
        _ = try g.deliver("s", "go", if (std.mem.startsWith(u8, source, "on go o")) &args else &.{}, true);
        if (!std.mem.startsWith(u8, source, "on go o")) args[0].release();
        try g.pump(clock);
        try expectContains(out.written(), "error={code: \"wrong kind\", expected: \"map\", got: \"object\"");
    };
    try testing.expectEqual(@as(usize, 0), counted.gets);

    // The ordinary `id` read, a held object returned whole, and
    // `otherwise` leaving an object unconverted.
    const fine = [_][2][]const u8{
        .{ "on go o\n return the id of o\nend go\n", "value=\"o1\"" },
        .{ "on go o\n return the optional held of {held: o} is o\nend go\n", "value=true" },
        .{ "on go o\n return (o otherwise nothing) is o\nend go\n", "value=true" },
    };
    for (fine) |c| {
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        var g: machine.Group = .init(gpa, &out.writer);
        defer g.deinit();
        const o = try g.object(&counted.kind, "o1", null);
        try testing.expect(try g.load("s", c[0], .{}) == .loaded);
        var args = [_]*Value{o.value.retain()};
        _ = try g.deliver("s", "go", &args, true);
        try g.pump(clock);
        try expectContains(out.written(), c[1]);
    }
    try testing.expectEqual(@as(usize, 0), counted.gets);
}

fn argument(gpa: Allocator, spelling: []const u8) !*Value {
    if (std.mem.eql(u8, spelling, "5")) return model.scalar(gpa, .{ .number = model.Decimal.fromInt(5) });
    if (std.mem.eql(u8, spelling, "{}")) return model.map(gpa, &.{});
    const yes = try model.scalar(gpa, .{ .bool = true });
    defer yes.release();
    return model.map(gpa, &.{.{ .key = "active", .value = yes }});
}

test "a Guard defaults an absent key, and skips on a wrong kind" {
    const gpa = testing.allocator;
    const source =
        \\on pick m where the optional active of m otherwise false
        \\ return 1
        \\end pick
        \\on pick m where the optional active of m
        \\ return 2
        \\end pick
        \\on pick m
        \\ return 3
        \\end pick
        \\
    ;
    const cases = [_]struct { []const u8, []const u8 }{
        .{ "{active: true}", "value=1" },
        .{ "{}", "value=3" },
        .{ "5", "value=3" },
    };
    for (cases) |c| {
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        var g: machine.Group = .init(gpa, &out.writer);
        defer g.deinit();
        try testing.expect(try g.load("s", source, .{}) == .loaded);
        const arg = try argument(gpa, c[0]);
        var args = [_]*Value{arg};
        _ = try g.deliver("s", "pick", &args, true);
        try g.pump(clock);
        try expectContains(out.written(), c[1]);
        // A wrong kind in a Guard is recorded where the clause is skipped.
        if (std.mem.eql(u8, c[0], "5")) try expectContains(out.written(), "code=\"wrong kind\"");
    }
}

test "Fuel run out just before branch-not-nothing faults there" {
    const gpa = testing.allocator;
    const base = try runOf(gpa, "nothing");
    defer gpa.free(base);
    // Enough for the clause and the first const, and no more.
    const before = try fuelOf(base) - 1;
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    var g: machine.Group = .init(gpa, &out.writer);
    defer g.deinit();
    try testing.expect(try g.load("s", "on go\n return nothing otherwise 2\nend go\n", .{ .limits = .{ .fuel_per_run = before } }) == .loaded);
    _ = try g.deliver("s", "go", &.{}, true);
    try g.pump(clock);
    const want = try std.fmt.allocPrint(gpa, "fuel={d}", .{before});
    defer gpa.free(want);
    try expectContains(out.written(), "outcome=limit-fault");
    try expectContains(out.written(), "pos=2:17");
    try expectContains(out.written(), want);
}

test "Constants default at load, and a chosen fallback's error unwinds" {
    const gpa = testing.allocator;
    const constant = try traceOf(gpa, "constant x = the optional a of {a: 4} otherwise 0\non go\n return x\nend go\n", .{}, &.{});
    defer gpa.free(constant);
    try expectContains(constant, "value=4");

    var g: machine.Group = .init(gpa, null);
    defer g.deinit();
    try testing.expect(try g.load("s", "constant x = the optional a of 5\non go\n return x\nend go\n", .{}) != .loaded);

    const unwind = try traceOf(gpa,
        \\on go
        \\ try
        \\  return nothing otherwise 1 / 0
        \\ catch "division by zero"
        \\  return [1, 2]
        \\ end try
        \\end go
        \\
    , .{}, &.{});
    defer gpa.free(unwind);
    try expectContains(unwind, "value=[1, 2]");
}

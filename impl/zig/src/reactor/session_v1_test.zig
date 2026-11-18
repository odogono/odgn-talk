//! `session-v1` through the Message Layer's frames: every `corpus/sessions`
//! case run live as an embedder would drive it, and the paths a replay never
//! takes.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const session = @import("session");
const session_v1 = @import("session_v1.zig");

const message = northtalk.message;
const transcript = session.transcript;
const replay = session.replay;
const Json = std.json.Value;

/// A guest with `session-v1` negotiated, sending frames through
/// `message.handle` as the reactor's exports do.
const Guest = struct {
    gpa: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    s: *message.Session,
    server: session_v1.Server,
    next: i64 = 1,
    /// Every reply's records, in order.
    lines: std.ArrayList([]const u8) = .empty,
    trace: std.ArrayList([]const u8) = .empty,
    output: std.ArrayList([]const u8) = .empty,

    fn init(g: *Guest, gpa: std.mem.Allocator) !void {
        g.* = .{ .gpa = gpa, .arena = .init(gpa), .s = message.Session.init(gpa) orelse return error.OutOfMemory, .server = .init(gpa) };
        g.s.extension = g.server.extension();
        const hello = try g.send("{\"m\":\"hello\",\"ref\":0,\"protocol\":1,\"features\":[\"session-v1\"]}");
        var offered = false;
        for (hello.object.get("ok").?.object.get("features").?.array.items) |f| offered = offered or std.mem.eql(u8, f.string, "session-v1");
        try std.testing.expect(offered);
    }

    fn deinit(g: *Guest) void {
        g.server.deinit();
        g.s.deinit();
        g.arena.deinit();
    }

    /// Sends a frame, keeping its reply's records.
    fn send(g: *Guest, frame: []const u8) !Json {
        const a = g.arena.allocator();
        const reply = message.handle(g.s, frame);
        defer message.freeReply(g.gpa, reply);
        const parsed = std.json.parseFromSliceLeaky(Json, a, reply, .{ .allocate = .alloc_always }) catch |e| {
            std.debug.print("unparsable reply to {s}: {s}\n", .{ frame, reply });
            return e;
        };
        inline for (.{ "transcript", "trace", "output" }, .{ &g.lines, &g.trace, &g.output }) |name, list| {
            if (parsed.object.get(name)) |xs| for (xs.array.items) |x| try list.append(a, x.string);
        }
        return parsed;
    }

    /// Sends a message built from `fields`, under the next ref, or under
    /// `ref` for a result.
    fn sendAs(g: *Guest, ref: ?i64, m: []const u8, fields: anytype) !Json {
        const a = g.arena.allocator();
        const r = ref orelse r: {
            g.next += 1;
            break :r g.next;
        };
        var out: std.Io.Writer.Allocating = .init(a);
        var jw: std.json.Stringify = .{ .writer = &out.writer };
        try jw.beginObject();
        try jw.objectField("m");
        try jw.write(m);
        try jw.objectField("ref");
        try jw.write(r);
        inline for (@typeInfo(@TypeOf(fields)).@"struct".field_names) |field_name| {
            const v = @field(fields, field_name);
            const present = switch (@typeInfo(@TypeOf(v))) {
                .optional => v != null,
                else => true,
            };
            if (present) {
                try jw.objectField(field_name);
                try jw.write(v);
            }
        }
        try jw.endObject();
        return g.send(out.written());
    }

    fn refOf(reply: Json) i64 {
        return reply.object.get("ref").?.integer;
    }
};

fn okOf(reply: Json) !Json {
    return reply.object.get("ok") orelse unexpected(reply);
}

fn needOf(reply: Json) !Json {
    return reply.object.get("need") orelse unexpected(reply);
}

fn errDetail(reply: Json) ![]const u8 {
    const e = reply.object.get("err") orelse return unexpected(reply);
    return e.object.get("detail").?.string;
}

fn unexpected(reply: Json) error{TestUnexpectedResult} {
    std.debug.print("unexpected reply: {f}\n", .{std.json.fmt(reply, .{})});
    return error.TestUnexpectedResult;
}

// ------------------------------------------------------------ the corpus

/// How many lines an item takes, counting an input's `|` lines.
fn lineCount(item: transcript.Item) usize {
    return switch (item) {
        .input => |i| 1 + i.more.len,
        else => 1,
    };
}

const Envelope = enum { declaration, action, made };

fn envelopeOf(a: std.mem.Allocator, text: []const u8) Envelope {
    const v = std.json.parseFromSliceLeaky(Json, a, text, .{ .parse_numbers = false }) catch return .made;
    const t = if (v.object.get("type")) |x| x.string else "";
    if (std.mem.eql(u8, t, "kind") or std.mem.eql(u8, t, "object") or std.mem.eql(u8, t, "setup")) return .declaration;
    if (std.mem.eql(u8, t, "input")) return .action;
    return .made;
}

/// Runs a case as an embedder drives `session-v1`: each input, line,
/// answer, deadline and declaration the Transcript holds is a frame, and
/// each need is answered from the Transcript, as `runLive` answers them.
fn runCase(gpa: std.mem.Allocator, text: []const u8, expected_trace: []const u8, name: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const items = try transcript.parse(a, text);

    var g: Guest = undefined;
    try g.init(gpa);
    defer g.deinit();
    // Live Host Objects when the embedder declares any.
    var declares = false;
    for (items) |item| declares = declares or (item == .crossing and envelopeOf(a, item.crossing) != .made);
    _ = try okOf(try g.sendAs(null, "session-open", .{ .objects = if (declares) @as(?[]const []const u8, &.{}) else null }));
    var clock_real = true;
    var last_reading: []const u8 = "1970-01-01T00:00:00Z";
    // Each item's first line, as `replay.expected` writes them.
    var starts: std.ArrayList(usize) = .empty;
    var at: usize = 0;
    for (items) |item| {
        try starts.append(a, at);
        at += lineCount(item);
    }
    var want: std.Io.Writer.Allocating = .init(a);
    try replay.expected(&want.writer, items);

    var i: usize = 0;
    while (true) {
        // Past what the session has written so far.
        const written = g.lines.items.len;
        while (i < items.len and starts.items[i] < written) i += 1;
        if (i < items.len and starts.items[i] != written) break;
        // Output is the session's to write.
        if (i >= items.len or items[i] == .output) break;
        const item = items[i];
        // The reading this frame carries: the `@` the session takes next.
        var j = i + 1;
        while (j < items.len and items[j] == .output) j += 1;
        const reading: ?[]const u8 = if (!clock_real) null else switch (item) {
            .clock => |x| x,
            else => if (j < items.len and items[j] == .clock) items[j].clock else last_reading,
        };
        if (reading) |r| last_reading = r;
        var reply = switch (item) {
            .input => |x| try g.sendAs(null, "session-input", .{ .input = x.first, .more = x.more, .reading = reading }),
            .clock => try g.sendAs(null, "session-pump", .{ .reading = reading }),
            .line => |x| try g.sendAs(null, "session-input", .{ .line = x, .reading = reading }),
            .answer => |x| try g.sendAs(null, "session-input", .{ .answer = .{ .shown = x.shown, .fail = x.fail }, .reading = reading }),
            .crossing => |x| switch (envelopeOf(a, x)) {
                .declaration => try g.sendAs(null, "session-input", .{ .envelope = x, .reading = reading }),
                .action => try g.sendAs(null, "session-input", .{ .envelope = try requestOnly(a, x), .reading = reading }),
                .made => break,
            },
            .output => unreachable,
        };
        // Each need, answered from the Transcript after what the session wrote.
        while (reply.object.get("need")) |need| {
            const r = Guest.refOf(reply);
            var k = i;
            while (k < items.len and starts.items[k] < g.lines.items.len) k += 1;
            const m = need.object.get("m").?.string;
            if (std.mem.eql(u8, m, "write")) {
                reply = try g.sendAs(r, "write-result", .{ .written = true });
            } else if (std.mem.eql(u8, m, "resolve")) {
                const recorded = try std.json.parseFromSliceLeaky(Json, a, items[k].crossing, .{});
                var outcomes: std.ArrayList(bool) = .empty;
                for (need.object.get("objects").?.array.items) |pair| {
                    const yes = for (recorded.object.get("objects").?.array.items) |o| {
                        const object = o.object.get("object").?;
                        if (std.mem.eql(u8, object.object.get("kind").?.string, pair.array.items[0].string) and std.mem.eql(u8, object.object.get("id").?.string, pair.array.items[1].string)) break o.object.get("resolved").?.bool;
                    } else false;
                    try outcomes.append(a, yes);
                }
                reply = try g.sendAs(r, "resolve-result", .{ .objects = outcomes.items });
            } else {
                // The identities the answer names and the Host's actions,
                // then the end's reply.
                var envelopes: std.ArrayList([]const u8) = .empty;
                const end = while (k < items.len) : (k += 1) {
                    if (items[k] != .crossing) return error.CaseFailed;
                    const v = try std.json.parseFromSliceLeaky(Json, a, items[k].crossing, .{ .parse_numbers = false });
                    if (std.mem.eql(u8, v.object.get("type").?.string, "property-end")) break v.object.get("reply").?;
                    try envelopes.append(a, if (envelopeOf(a, items[k].crossing) == .action) try requestOnly(a, items[k].crossing) else items[k].crossing);
                } else return error.CaseFailed;
                var frame: std.Io.Writer.Allocating = .init(a);
                try frame.writer.print("{{\"m\":\"prop-result\",\"ref\":{d},\"envelopes\":", .{r});
                try std.json.Stringify.value(envelopes.items, .{}, &frame.writer);
                var outcome = end.object.iterator();
                const e = outcome.next().?;
                try frame.writer.writeAll(",");
                try std.json.Stringify.value(e.key_ptr.*, .{}, &frame.writer);
                try frame.writer.writeAll(":");
                try std.json.Stringify.value(e.value_ptr.*, .{}, &frame.writer);
                try frame.writer.writeAll("}");
                reply = try g.send(frame.written());
            }
        }
        const ok = reply.object.get("ok") orelse {
            std.debug.print("{s}: ", .{name});
            return unexpected(reply);
        };
        clock_real = std.mem.eql(u8, ok.object.get("clock").?.string, "real");
    }

    // The end, as for a Trace Case: Inspect, unless the last input was it.
    if (g.server.host.?.group) |group| if (!lastInputIsVars(g.trace.items)) {
        _ = c.talk_inspect(group, null);
        try g.trace.appendSlice(g.arena.allocator(), g.server.trace.items);
    };

    var got: std.Io.Writer.Allocating = .init(a);
    for (g.lines.items) |l| try got.writer.print("{s}\n", .{l});
    if (replay.difference(want.written(), got.written()).first) |d| {
        std.debug.print("{s}: session.transcript line {d}\n  expected: {s}\n  actual:   {s}\n", .{ name, d.line, d.want orelse "<end>", d.got orelse "<end>" });
        return error.CaseFailed;
    }
    var want_trace = std.mem.splitScalar(u8, expected_trace, '\n');
    var n: usize = 0;
    var next: usize = 0;
    while (true) {
        const x = nextRecord(&want_trace);
        const y: ?[]const u8 = if (next < g.trace.items.len) g.trace.items[next] else null;
        next += 1;
        if (x == null and y == null) break;
        n += 1;
        if (x == null or y == null or !try northtalk.corpus_trace.matches(a, x.?, y.?)) {
            std.debug.print("{s}: case.trace line {d}\n  expected: {s}\n  actual:   {s}\n", .{ name, n, x orelse "<end>", y orelse "<end>" });
            return error.CaseFailed;
        }
    }
}

/// A recorded Host action as the embedder hands it: its request alone,
/// whose reply the session finds itself.
fn requestOnly(a: std.mem.Allocator, recorded: []const u8) ![]const u8 {
    const v = try std.json.parseFromSliceLeaky(Json, a, recorded, .{ .parse_numbers = false });
    const request = try std.json.Stringify.valueAlloc(a, v.object.get("request").?, .{});
    return std.fmt.allocPrint(a, "{{\"request\":{s},\"type\":\"input\"}}", .{request});
}

/// As `session_case.zig` decides it.
fn lastInputIsVars(lines: []const []const u8) bool {
    var last: []const u8 = "";
    for (lines) |l| if (std.mem.startsWith(u8, l, "> ")) {
        last = l;
    };
    return std.mem.eql(u8, last, "> vars");
}

fn nextRecord(lines: *std.mem.SplitIterator(u8, .scalar)) ?[]const u8 {
    while (lines.next()) |l| if (l.len > 0 and l[0] != '#') return l;
    return null;
}

fn caseNames(gpa: std.mem.Allocator, root: std.Io.Dir) !std.ArrayList([]const u8) {
    var names: std.ArrayList([]const u8) = .empty;
    var it = root.iterate();
    while (try it.next(std.testing.io)) |e| if (e.kind == .directory) try names.append(gpa, try gpa.dupe(u8, e.name));
    return names;
}

test "every corpus/sessions case runs live through session-v1's frames" {
    const io = std.testing.io;
    const gpa = std.testing.allocator;
    var root = try std.Io.Dir.cwd().openDir(io, "../../corpus/sessions", .{ .iterate = true });
    defer root.close(io);
    var names = try caseNames(gpa, root);
    defer {
        for (names.items) |n| gpa.free(n);
        names.deinit(gpa);
    }
    for (names.items) |name| {
        var dir = try root.openDir(io, name, .{});
        defer dir.close(io);
        const text = try dir.readFileAlloc(io, "session.transcript", gpa, .limited(16 * 1024 * 1024));
        defer gpa.free(text);
        const trace = try dir.readFileAlloc(io, "case.trace", gpa, .limited(64 * 1024 * 1024));
        defer gpa.free(trace);
        try runCase(gpa, text, trace, name);
    }
}

test "every corpus/sessions case replays through session-open" {
    const io = std.testing.io;
    const gpa = std.testing.allocator;
    var root = try std.Io.Dir.cwd().openDir(io, "../../corpus/sessions", .{ .iterate = true });
    defer root.close(io);
    var names = try caseNames(gpa, root);
    defer {
        for (names.items) |n| gpa.free(n);
        names.deinit(gpa);
    }
    for (names.items) |name| {
        var dir = try root.openDir(io, name, .{});
        defer dir.close(io);
        const text = try dir.readFileAlloc(io, "session.transcript", gpa, .limited(16 * 1024 * 1024));
        defer gpa.free(text);
        var g: Guest = undefined;
        try g.init(gpa);
        defer g.deinit();
        const reply = try g.sendAs(null, "session-open", .{ .transcript = text });
        const ok = reply.object.get("ok") orelse {
            std.debug.print("{s}: ", .{name});
            return unexpected(reply);
        };
        // Quietly: nothing the replay made comes back.
        try std.testing.expectEqual(@as(usize, 0), g.output.items.len + g.trace.items.len + g.lines.items.len);
        try std.testing.expectEqualStrings("prompt", ok.object.get("waiting").?.string);
    }
}

test "session-open refuses a Transcript that doesn't replay, naming its line" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    const refused = try errDetail(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .transcript = "> 1 + 1\n3\n" }));
    try std.testing.expectEqualStrings("the transcript doesn't replay at line 2: expected 3, got 2", refused);
    // It may be opened again.
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .transcript = "> 1 + 1\n2\n" }));
}

// ------------------------------------------------------------ live paths

const kind_envelope = "{\"name\":\"Lamp\",\"parentKinds\":[],\"props\":[{\"getCost\":{\"alloc\":0,\"fuel\":0},\"name\":\"level\",\"readOnly\":true,\"shape\":\"any\"}],\"type\":\"kind\"}";
const object_envelope = "{\"object\":{\"id\":\"desk\",\"kind\":\"Lamp\"},\"type\":\"object\"}";
const setup_envelope = "{\"objects\":{\"desk\":{\"id\":\"desk\",\"kind\":\"Lamp\"}},\"type\":\"setup\"}";

fn openLamp(g: *Guest) !void {
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .objects = &[_][]const u8{ kind_envelope, object_envelope, setup_envelope } }));
}

test "a live crossing stays open across frames until its prop-result" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    try openLamp(&g);
    // The declarations are recorded.
    try std.testing.expectEqual(@as(usize, 3), g.lines.items.len);
    const asked = try g.sendAs(null, "session-input", .{ .input = "the level of desk" });
    const need = try needOf(asked);
    try std.testing.expectEqualStrings("prop", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("level", need.object.get("prop").?.string);
    const r = Guest.refOf(asked);
    // Other frames meanwhile are refused, and the crossing stays open.
    try std.testing.expectEqualStrings("a session is waiting for its result", try errDetail(try g.sendAs(null, "session-pump", .{})));
    try std.testing.expectEqualStrings("a session is waiting for its result", try errDetail(try g.sendAs(null, "session-describe-prompt", .{})));
    try std.testing.expectEqualStrings("the result does not match the need", try errDetail(try g.sendAs(r, "write-result", .{ .written = true })));
    const answered = try g.send(try std.fmt.allocPrint(g.arena.allocator(), "{{\"m\":\"prop-result\",\"ref\":{d},\"value\":3}}", .{r}));
    try std.testing.expectEqual(r, Guest.refOf(answered));
    try std.testing.expectEqualStrings("prompt", (try okOf(answered)).object.get("waiting").?.string);
    try std.testing.expectEqualStrings("3", g.output.items[g.output.items.len - 1]);
    // `property-begin` came with the need, `property-end` with the answer.
    var begin = false;
    var end = false;
    for (g.lines.items) |l| {
        begin = begin or std.mem.indexOf(u8, l, "\"property-begin\"") != null;
        end = end or std.mem.indexOf(u8, l, "{\"crossing\":1,\"reply\":{\"value\":3},\"type\":\"property-end\"}") != null;
    }
    try std.testing.expect(begin and end);
}

test "a live Restore asks resolve once, and runs :restore again with the answer" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    try openLamp(&g);
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "put desk into lamp" }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = ":save" }));
    const asked = try g.sendAs(null, "session-input", .{ .input = ":restore" });
    const need = try needOf(asked);
    try std.testing.expectEqualStrings("resolve", need.object.get("m").?.string);
    const objects = need.object.get("objects").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), objects.len);
    try std.testing.expectEqualStrings("desk", objects[0].array.items[1].string);
    const before = g.output.items.len;
    _ = try okOf(try g.sendAs(Guest.refOf(asked), "resolve-result", .{ .objects = &[_]bool{true} }));
    // Said once, after the answer.
    try std.testing.expectEqual(before + 1, g.output.items.len);
    try std.testing.expectEqualStrings("restored default", g.output.items[before]);
    var resolve = false;
    for (g.lines.items) |l| resolve = resolve or std.mem.indexOf(u8, l, "\"type\":\"resolve\"") != null;
    try std.testing.expect(resolve);
}

test "a write is a need, and :export runs again with each answer" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z" }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "function twice x", .more = &[_][]const u8{ "  return x * 2", "end twice" } }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = ":library add tools", .more = &[_][]const u8{ "function half x", "  return x / 2", "end half" } }));
    try std.testing.expectEqual(@as(usize, 0), g.output.items.len);
    const first = try g.sendAs(null, "session-input", .{ .input = ":export out" });
    const r = Guest.refOf(first);
    const need = try needOf(first);
    try std.testing.expectEqualStrings("write", need.object.get("m").?.string);
    try std.testing.expectEqualStrings("out", need.object.get("directory").?.string);
    try std.testing.expectEqualStrings("session.talk", need.object.get("name").?.string);
    const second = try needOf(try g.sendAs(r, "write-result", .{ .written = true }));
    try std.testing.expectEqualStrings("tools.talk", second.object.get("name").?.string);
    const before = g.output.items.len;
    _ = try okOf(try g.sendAs(r, "write-result", .{ .written = true }));
    try std.testing.expectEqual(before + 2, g.output.items.len);
    try std.testing.expectEqualStrings("wrote session.talk", g.output.items[before]);
    try std.testing.expectEqualStrings("wrote tools.talk", g.output.items[before + 1]);
    // A refused write, said once.
    const again = try g.sendAs(null, "session-input", .{ .input = ":export out" });
    _ = try okOf(try g.sendAs(Guest.refOf(again), "write-result", .{ .written = false }));
    try std.testing.expectEqualStrings("! bad arguments", g.output.items[g.output.items.len - 1]);
    try std.testing.expectEqual(before + 3, g.output.items.len);
}

test "a real Clock's deadline waits for session-pump, with no sleep" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    _ = try okOf(try g.sendAs(null, "session-open", .{}));
    try std.testing.expectEqualStrings("a real Clock needs a reading", try errDetail(try g.sendAs(null, "session-input", .{ .input = "1 + 1" })));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "on nap", .more = &[_][]const u8{ "  wait 2 s", "  say \"rested\"", "end nap" }, .reading = "2026-09-30T10:00:00Z" }));
    const waiting = try okOf(try g.sendAs(null, "session-input", .{ .input = "nap and wait", .reading = "2026-09-30T10:00:00Z" }));
    try std.testing.expectEqualStrings("deadline", waiting.object.get("waiting").?.string);
    try std.testing.expectEqualStrings("2026-09-30T10:00:02Z", waiting.object.get("deadline").?.string);
    const woke = try okOf(try g.sendAs(null, "session-pump", .{ .reading = "2026-09-30T10:00:02Z" }));
    try std.testing.expectEqualStrings("prompt", woke.object.get("waiting").?.string);
    try std.testing.expectEqualStrings("rested", g.output.items[g.output.items.len - 1]);
    const want = [_][]const u8{ "> nap and wait", "@ 2026-09-30T10:00:00Z", "@ 2026-09-30T10:00:02Z", "rested" };
    for (want, g.lines.items[g.lines.items.len - want.len ..]) |x, y| try std.testing.expectEqualStrings(x, y);
}

test "a prompt is described, answered with a session-input, and abandoned by an input" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z" }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = ":grant user user" }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "on size", .more = &[_][]const u8{ "  ask user to choose [\"S\", \"M\"], {prompt: \"Size?\"} and wait", "  say \"got \" & it", "end size" } }));
    const asked = try okOf(try g.sendAs(null, "session-input", .{ .input = "size and wait" }));
    try std.testing.expectEqualStrings("user", asked.object.get("waiting").?.string);
    const prompt = try okOf(try g.sendAs(null, "session-describe-prompt", .{}));
    try std.testing.expectEqualStrings("choose", prompt.object.get("kind").?.string);
    try std.testing.expectEqualStrings("Size?", prompt.object.get("prompt").?.string);
    try std.testing.expectEqual(@as(usize, 2), prompt.object.get("items").?.array.items.len);
    try std.testing.expectEqualStrings("the session isn't waiting for a line", try errDetail(try g.sendAs(null, "session-input", .{ .line = "M" })));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .answer = .{ .shown = "\"M\"", .fail = false } }));
    try std.testing.expectEqualStrings("got M", g.output.items[g.output.items.len - 1]);
    // Typing an Entry instead ends the wait: the Run goes on in the background.
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "size and wait" }));
    const after = try okOf(try g.sendAs(null, "session-input", .{ .input = "1 + 1" }));
    try std.testing.expectEqualStrings("prompt", after.object.get("waiting").?.string);
    try std.testing.expectEqualStrings("2", g.output.items[g.output.items.len - 1]);
    _ = try okOf(try g.sendAs(null, "session-close", .{}));
    try std.testing.expectEqualStrings("the session is closed", try errDetail(try g.sendAs(null, "session-input", .{ .input = "1" })));
}

test "a session guest serves only its session" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    try std.testing.expectEqualStrings("no session is open", try errDetail(try g.sendAs(null, "session-pump", .{})));
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z" }));
    try std.testing.expectEqualStrings("this guest serves a session", try errDetail(try g.sendAs(null, "new-group", .{ .name = "g" })));
    try std.testing.expectEqualStrings("a session is open", try errDetail(try g.sendAs(null, "session-open", .{})));
    try std.testing.expectEqualStrings("a virtual Clock takes no reading", try errDetail(try g.sendAs(null, "session-pump", .{ .reading = "2026-11-18T09:00:00Z" })));
}

test "Host actions are performed live, recorded with their replies, and replay" {
    const gpa = std.testing.allocator;
    var g: Guest = undefined;
    try g.init(gpa);
    defer g.deinit();
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .objects = &[_][]const u8{} }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "on ping", .more = &[_][]const u8{ "  say \"pong\"", "end ping" } }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "function plus x", .more = &[_][]const u8{ "  return x + 1", "end plus" } }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = ":inspect plus" }));
    const actions = [_][]const u8{
        "{\"request\":{\"kind\":\"deliver\",\"message\":{\"name\":\"ping\"},\"to\":{\"script\":\"session\"}},\"type\":\"input\"}",
        "{\"request\":{\"kind\":\"request\",\"message\":{\"name\":\"ping\"},\"to\":{\"script\":\"session\"}},\"type\":\"input\"}",
        "{\"request\":{\"kind\":\"broadcast\",\"message\":{\"name\":\"ping\"}},\"type\":\"input\"}",
        "{\"request\":{\"kind\":\"decide\",\"message\":{\"name\":\"ping\"},\"to\":{\"script\":\"session\"}},\"type\":\"input\"}",
        "{\"request\":{\"broadcast\":true,\"kind\":\"decide\",\"message\":{\"name\":\"ping\"}},\"type\":\"input\"}",
        "{\"request\":{\"delivery\":\"d99\",\"kind\":\"cancel-delivery\"},\"type\":\"input\"}",
        "{\"request\":{\"args\":[1],\"fn\":{\"$sessionFunction\":\"f1\"},\"kind\":\"call\"},\"type\":\"input\"}",
        "{\"request\":{\"kind\":\"cancel-run\",\"run\":\"session/r99\",\"script\":\"session\"},\"type\":\"input\"}",
        "{\"request\":{\"call\":\"session/r99.c1\",\"kind\":\"answer\",\"value\":1},\"type\":\"input\"}",
        "{\"request\":{\"call\":\"session/r99.c1\",\"error\":{\"code\":\"x\",\"data\":null,\"message\":\"y\"},\"kind\":\"fail\"},\"type\":\"input\"}",
        "{\"request\":{\"call\":\"session/r99.c1\",\"kind\":\"settle\",\"settlement\":{\"adopt\":true}},\"type\":\"input\"}",
        "{\"request\":{\"grant\":\"console\",\"kind\":\"revoke\",\"script\":\"session\"},\"type\":\"input\"}",
    };
    for (actions) |x| _ = try okOf(try g.sendAs(null, "session-input", .{ .envelope = x }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .input = "1 + 1" }));
    _ = try okOf(try g.sendAs(null, "session-input", .{ .envelope = "{\"request\":{\"kind\":\"stop\",\"reason\":\"done\",\"script\":\"session\"},\"type\":\"input\"}" }));
    // Each recorded with its reply: ids for the actions that make them,
    // and a refusal for a call the session doesn't hold.
    var replies: std.ArrayList([]const u8) = .empty;
    for (g.lines.items) |l| if (std.mem.indexOf(u8, l, "\"type\":\"input\"") != null) {
        const v = try std.json.parseFromSliceLeaky(Json, g.arena.allocator(), l[2..], .{});
        try replies.append(g.arena.allocator(), try std.json.Stringify.valueAlloc(g.arena.allocator(), v.object.get("reply").?, .{}));
    };
    try std.testing.expectEqual(@as(usize, 13), replies.items.len);
    for (replies.items[0..2]) |r| try std.testing.expect(std.mem.startsWith(u8, r, "{\"ok\":{\"delivery\":\"d"));
    try std.testing.expect(std.mem.startsWith(u8, replies.items[2], "{\"ok\":{\"broadcast\":\"b"));
    try std.testing.expect(std.mem.startsWith(u8, replies.items[6], "{\"ok\":{\"delivery\":"));
    for (replies.items[8..11]) |r| try std.testing.expectEqualStrings("{\"error\":\"unknown call\"}", r);
    try std.testing.expectEqualStrings("{\"ok\":{}}", replies.items[12]);

    // The Transcript replays, each reply compared.
    var recorded: std.Io.Writer.Allocating = .init(gpa);
    defer recorded.deinit();
    for (g.lines.items) |l| try recorded.writer.print("{s}\n", .{l});
    var again: Guest = undefined;
    try again.init(gpa);
    defer again.deinit();
    _ = try okOf(try again.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .transcript = recorded.written() }));
    // One whose recorded reply differs doesn't.
    const tampered = try std.mem.replaceOwned(u8, gpa, recorded.written(), "{\"reply\":{\"error\":\"unknown call\"}", "{\"reply\":{\"ok\":{}}");
    defer gpa.free(tampered);
    var refused: Guest = undefined;
    try refused.init(gpa);
    defer refused.deinit();
    _ = try errDetail(try refused.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .transcript = tampered }));
}

test "a Host action refused for its fields is refused, and records nothing" {
    var g: Guest = undefined;
    try g.init(std.testing.allocator);
    defer g.deinit();
    _ = try okOf(try g.sendAs(null, "session-open", .{ .clock = "2026-11-18T09:00:00Z", .objects = &[_][]const u8{} }));
    const before = g.lines.items.len;
    _ = try errDetail(try g.sendAs(null, "session-input", .{ .envelope = "{\"request\":{\"kind\":\"pump\"},\"type\":\"input\"}" }));
    _ = try errDetail(try g.sendAs(null, "session-input", .{ .envelope = "{\"reply\":{\"ok\":{}},\"request\":{\"kind\":\"stop\",\"reason\":\"x\",\"script\":\"session\"},\"type\":\"input\"}" }));
    try std.testing.expectEqual(before, g.lines.items.len);
}

//! Session Transcript cases (chapter 11, Session Transcripts): the
//! Transcript replays through the Session Host, and both what it prints and
//! the Group's Trace must match the case.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const session = @import("session");
const trace = northtalk.corpus_trace;

const transcript = session.transcript;
const Session = session.Session;

/// A replay of a Transcript: the items the session reads in turn, and the
/// Transcript and Trace it writes as it goes.
const Replay = session.replay.Replay;
const instant = session.replay.instant;

/// Replays the Transcript in `dir`, and compares its lines and its Trace.
/// Returns the lines compared, or writes the first difference to `detail`
/// and fails with `error.CaseFailed`.
pub fn run(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, detail: *std.Io.Writer) !usize {
    return runIn(gpa, io, dir, name, detail, .replay);
}

/// Runs the Transcript in `dir` with live Host Objects (#2276) and compares
/// it as `run` does: the session declares nothing itself, answers each
/// crossing as an embedder would from the Transcript, and records every
/// envelope it makes. Host actions (`input` envelopes) aren't live yet
/// (#2284): they are applied as a replay applies them, and copied.
pub fn runLive(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, detail: *std.Io.Writer) !usize {
    return runIn(gpa, io, dir, name, detail, .live);
}

const Mode = enum { replay, live };

fn runIn(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, detail: *std.Io.Writer, mode: Mode) !usize {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const text = try dir.readFileAlloc(io, "session.transcript", a, .limited(16 * 1024 * 1024));
    const expected_trace = try dir.readFileAlloc(io, "case.trace", a, .limited(64 * 1024 * 1024));
    return runText(gpa, text, expected_trace, null, name, detail, mode);
}

/// Runs `text`, a Transcript, and compares what the session writes with it,
/// and its Trace with `expected_trace`, or else gives the Trace in `got`,
/// owned by `gpa`.
fn runText(gpa: std.mem.Allocator, text: []const u8, expected_trace: ?[]const u8, got: ?*[]u8, name: []const u8, detail: *std.Io.Writer, mode: Mode) !usize {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const items = try transcript.parse(a, text);
    var live: Live = .{ .replay = .{ .gpa = a, .items = items, .written = .init(a) } };
    const replay = &live.replay;
    var driver = replay.driver();
    if (mode == .live) {
        driver.crossing = Live.crossing;
        driver.prop = Live.prop;
        driver.resolve = Live.resolve;
        driver.record = Live.record;
    }
    const s = try Session.init(gpa, driver);
    defer s.deinit();
    live.session = s;
    while (replay.peek()) |item| {
        replay.next += 1;
        switch (item) {
            .input => |input| {
                try transcript.writeInput(&replay.written.writer, input);
                try s.submit(input);
            },
            // A Pump the session made at a deadline.
            .clock => |shown| {
                try replay.written.writer.print("@ {s}\n", .{shown});
                try s.deadline(instant(shown) orelse return error.MalformedTranscript);
            },
            .line, .answer => {
                try detail.print("{s}: a `<` or `~` line the session didn't read", .{name});
                return error.CaseFailed;
            },
            // An envelope between Host calls.
            .crossing => |x| if (mode == .replay) {
                try replay.written.writer.print("% {s}\n", .{x});
                try s.crossing(x);
            } else switch (Live.typeOf(a, x)) {
                .declaration => s.declare(x) catch |err| {
                    try detail.print("{s}: declaring {s}: {s}", .{ name, x, @errorName(err) });
                    return error.CaseFailed;
                },
                .action => {
                    try replay.written.writer.print("% {s}\n", .{x});
                    try s.crossing(x);
                },
                // One the session should have made by now.
                .made => {},
            },
            .output => unreachable,
        }
    }
    // The end, as for a Trace Case: Inspect, unless the last input was it.
    if (s.group) |g| if (!lastInputIsVars(replay.trace.items)) {
        _ = c.talk_inspect(g, null);
    };
    // The Transcript: its lines as the session wrote them.
    var want: std.Io.Writer.Allocating = .init(a);
    for (items) |item| switch (item) {
        .input => |input| try transcript.writeInput(&want.writer, input),
        .clock => |x| try want.writer.print("@ {s}\n", .{x}),
        .line => |x| if (x.len == 0) try want.writer.writeAll("<\n") else try want.writer.print("< {s}\n", .{x}),
        .answer => |x| try want.writer.print("~ {s} {s}{s}\n", .{ x.call, if (x.fail) "fail " else "", x.shown }),
        .crossing => |x| try want.writer.print("% {s}\n", .{x}),
        .output => |x| try transcript.writeOutput(&want.writer, x),
    };
    var count: usize = 0;
    var wl = std.mem.splitScalar(u8, want.written(), '\n');
    var gl = std.mem.splitScalar(u8, replay.written.written(), '\n');
    while (true) {
        const x = wl.next();
        const y = gl.next();
        if (x == null and y == null) break;
        count += 1;
        if (x == null or y == null or !std.mem.eql(u8, x.?, y.?)) {
            try detail.print("{s}: session.transcript line {d}\n  expected: {s}\n  actual:   {s}", .{ name, count, x orelse "<end>", y orelse "<end>" });
            return error.CaseFailed;
        }
    }
    if (got) |out| out.* = try gpa.dupe(u8, replay.trace.items);
    var want_trace = std.mem.splitScalar(u8, expected_trace orelse return count, '\n');
    var got_trace = std.mem.splitScalar(u8, replay.trace.items, '\n');
    var n: usize = 0;
    while (true) {
        const x = nextRecord(&want_trace);
        const y = nextRecord(&got_trace);
        if (x == null and y == null) break;
        n += 1;
        if (x == null or y == null or !try trace.matches(a, x.?, y.?)) {
            try detail.print("{s}: case.trace line {d}\n  expected: {s}\n  actual:   {s}", .{ name, n, x orelse "<end>", y orelse "<end>" });
            return error.CaseFailed;
        }
    }
    return count + n;
}

/// The embedder side of a live run: it declares the Transcript's Object
/// Kinds and identities, and answers each crossing and Restore from it.
const Live = struct {
    replay: Replay,
    session: *Session = undefined,

    const Type = enum { declaration, action, made };

    /// Who makes an envelope: the embedder declares, a Host acts, and the
    /// session makes the rest.
    fn typeOf(a: std.mem.Allocator, text: []const u8) Type {
        const v = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .parse_numbers = false }) catch return .made;
        const t = if (v.object.get("type")) |x| x.string else "";
        if (std.mem.eql(u8, t, "kind") or std.mem.eql(u8, t, "object") or std.mem.eql(u8, t, "setup")) return .declaration;
        if (std.mem.eql(u8, t, "input")) return .action;
        return .made;
    }

    fn of(context: *anyopaque) *Live {
        const r: *Replay = @ptrCast(@alignCast(context));
        return @fieldParentPtr("replay", r);
    }

    /// A live session reads no recorded crossings.
    fn crossing(context: *anyopaque) ?[]const u8 {
        _ = context;
        return null;
    }

    /// The session's envelope, written; the Transcript's line for one it
    /// makes is passed over.
    fn record(context: *anyopaque, envelope: []const u8) void {
        const l = of(context);
        const r = &l.replay;
        r.written.writer.print("% {s}\n", .{envelope}) catch {};
        if (typeOf(r.gpa, envelope) != .made) return;
        const item = r.peek() orelse return;
        if (item == .crossing and typeOf(r.gpa, item.crossing) == .made) r.next += 1;
    }

    /// The Transcript up to this crossing's end: identities its answer
    /// names, and Host actions; then the end's reply answers it.
    fn prop(context: *anyopaque, need: []const u8) ?[]const u8 {
        _ = need;
        const l = of(context);
        const r = &l.replay;
        const broken = "{\"hostError\":true}";
        while (r.peek()) |item| {
            if (item != .crossing) return broken;
            const v = std.json.parseFromSliceLeaky(std.json.Value, r.gpa, item.crossing, .{ .parse_numbers = false }) catch return broken;
            const t = v.object.get("type").?.string;
            if (std.mem.eql(u8, t, "property-end")) return std.json.Stringify.valueAlloc(r.gpa, v.object.get("reply").?, .{}) catch broken;
            r.next += 1;
            switch (typeOf(r.gpa, item.crossing)) {
                .declaration => l.session.declare(item.crossing) catch return broken,
                .action => {
                    r.written.writer.print("% {s}\n", .{item.crossing}) catch {};
                    l.session.crossing(item.crossing) catch {};
                    l.session.queued = true;
                },
                .made => return broken,
            }
        }
        return broken;
    }

    /// The recorded `resolve` envelope's outcome for each identity asked.
    fn resolve(context: *anyopaque, objects: []const u8) ?[]const u8 {
        const r = &of(context).replay;
        const item = r.peek() orelse return "[]";
        if (item != .crossing) return "[]";
        const recorded = std.json.parseFromSliceLeaky(std.json.Value, r.gpa, item.crossing, .{}) catch return "[]";
        const asked = std.json.parseFromSliceLeaky(std.json.Value, r.gpa, objects, .{}) catch return "[]";
        const outcomes = (recorded.object.get("objects") orelse return "[]").array.items;
        var out: std.Io.Writer.Allocating = .init(r.gpa);
        out.writer.writeAll("[") catch {};
        for (asked.array.items, 0..) |pair, i| {
            if (i > 0) out.writer.writeAll(",") catch {};
            const kind = pair.array.items[0].string;
            const id = pair.array.items[1].string;
            const yes = for (outcomes) |o| {
                const ref = o.object.get("object").?;
                if (std.mem.eql(u8, ref.object.get("kind").?.string, kind) and std.mem.eql(u8, ref.object.get("id").?.string, id)) break o.object.get("resolved").?.bool;
            } else false;
            out.writer.print("{}", .{yes}) catch {};
        }
        out.writer.writeAll("]") catch {};
        return out.written();
    }
};

test "object-inspection's objects run live as they replay (#2276)" {
    const io = std.testing.io;
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus/sessions/object-inspection", .{});
    defer dir.close(io);
    var detail: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer detail.deinit();
    _ = runLive(std.testing.allocator, io, dir, "sessions/object-inspection", &detail.writer) catch |err| {
        std.debug.print("{s}\n", .{detail.written()});
        return err;
    };
}

fn lastInputIsVars(text: []const u8) bool {
    var last: []const u8 = "";
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |l| if (std.mem.startsWith(u8, l, "> ")) {
        last = l;
    };
    return std.mem.eql(u8, last, "> vars");
}

fn nextRecord(lines: *std.mem.SplitIterator(u8, .scalar)) ?[]const u8 {
    while (lines.next()) |l| if (l.len > 0 and l[0] != '#') return l;
    return null;
}

// A live Object Collection (#2276): each of count, at and find pauses the
// Pump, is recorded and answered, and the recording replays with the same
// lines and Trace. `:inspect` and `:vars` cross only inside Pumps.
test "a live Object Collection records and replays (#2276)" {
    const gpa = std.testing.allocator;
    const text =
        \\% {"name":"Tile","parentKinds":[],"props":[],"type":"kind"}
        \\% {"elements":{"atCost":{"alloc":0,"fuel":1},"countCost":{"alloc":0,"fuel":1},"findCost":{"alloc":0,"fuel":1},"shape":{"object":"Tile"}},"name":"Board","parentKinds":["Tile"],"props":[{"getCost":{"alloc":0,"fuel":0},"name":"size","readOnly":true,"shape":{"oneOf":["number","nothing"]}}],"type":"kind"}
        \\% {"object":{"id":"b","kind":"Board"},"type":"object"}
        \\% {"objects":{"board":{"id":"b","kind":"Board"}},"type":"setup"}
        \\> the number of elements of board
        \\@ 1970-01-01T00:00:00Z
        \\% {"crossing":1,"object":{"id":"b","kind":"Board"},"operation":"count","property":"elements","type":"property-begin"}
        \\% {"crossing":1,"reply":{"value":2},"type":"property-end"}
        \\2
        \\> element -1 of board
        \\@ 1970-01-01T00:00:00Z
        \\% {"crossing":2,"object":{"id":"b","kind":"Board"},"operation":"at","property":"elements","selector":-1,"type":"property-begin"}
        \\% {"object":{"id":"t2","kind":"Tile"},"type":"object"}
        \\% {"crossing":2,"reply":{"value":{"$object":["Tile","t2"]}},"type":"property-end"}
        \\'<object Tile "t2">
        \\> element "x" of board
        \\@ 1970-01-01T00:00:00Z
        \\% {"crossing":3,"object":{"id":"b","kind":"Board"},"operation":"find","property":"elements","selector":"x","type":"property-begin"}
        \\% {"crossing":3,"reply":{"fail":{"code":"no tile","message":"none named x"}},"type":"property-end"}
        \\! error {code: "no tile", capability: "Board", operation: "elements.find"} at 1:1
        \\> the size of board
        \\@ 1970-01-01T00:00:00Z
        \\% {"crossing":4,"object":{"id":"b","kind":"Board"},"operation":"get","property":"size","type":"property-begin"}
        \\% {"crossing":4,"reply":{"hostError":true},"type":"property-end"}
        \\! error {code: "host error", capability: "Board", operation: "size"} at 1:1
        \\> :inspect board
        \\@ 1970-01-01T00:00:00Z
        \\@ 1970-01-01T00:00:00Z
        \\% {"crossing":5,"object":{"id":"b","kind":"Board"},"operation":"get","property":"size","type":"property-begin"}
        \\% {"crossing":5,"reply":{"value":2},"type":"property-end"}
        \\value {kind: "object", value: <object Board "b">}
        \\object {kind: "Board", id: "b", disposed: false}
        \\property {name: "size", shape: {oneOf: ["number", "nothing"]}, readOnly: true, getCost: {fuel: 0, alloc: 0}, setCost: nothing}
        \\read {name: "size", value: 2}
        \\> :vars
        \\
    ;
    var detail: std.Io.Writer.Allocating = .init(gpa);
    defer detail.deinit();
    var recorded: []u8 = &.{};
    defer gpa.free(recorded);
    _ = runText(gpa, text, null, &recorded, "live elements", &detail.writer, .live) catch |err| {
        std.debug.print("{s}\n", .{detail.written()});
        return err;
    };
    _ = runText(gpa, text, recorded, null, "replayed elements", &detail.writer, .replay) catch |err| {
        std.debug.print("{s}\n", .{detail.written()});
        return err;
    };
}

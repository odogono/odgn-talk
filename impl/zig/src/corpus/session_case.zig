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
const Replay = struct {
    gpa: std.mem.Allocator,
    items: []const transcript.Item,
    next: usize = 0,
    written: std.Io.Writer.Allocating,
    trace: std.ArrayList(u8) = .empty,
    failure: ?[]const u8 = null,

    fn peek(r: *Replay) ?transcript.Item {
        // Output lines are what the session prints, not what it reads.
        while (r.next < r.items.len and r.items[r.next] == .output) r.next += 1;
        return if (r.next < r.items.len) r.items[r.next] else null;
    }

    fn reading(context: *anyopaque) ?session.Instant {
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return null;
        if (item != .clock) return null;
        r.next += 1;
        r.written.writer.print("@ {s}\n", .{item.clock}) catch {};
        return instant(item.clock);
    }

    fn line(context: *anyopaque) ?[]const u8 {
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return null;
        if (item != .line) return null;
        r.next += 1;
        if (item.line.len == 0) r.written.writer.writeAll("<\n") catch {} else r.written.writer.print("< {s}\n", .{item.line}) catch {};
        return item.line;
    }

    fn answer(context: *anyopaque, call: []const u8, busy: bool) ?session.Answer {
        _ = busy;
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return null;
        if (item != .answer or !std.mem.eql(u8, item.answer.call, call)) return null;
        r.next += 1;
        r.written.writer.print("~ {s} {s}{s}\n", .{ call, if (item.answer.fail) "fail " else "", item.answer.shown }) catch {};
        return .{ .shown = item.answer.shown, .fail = item.answer.fail };
    }

    fn output(context: *anyopaque, text: []const u8) void {
        const r: *Replay = @ptrCast(@alignCast(context));
        transcript.writeOutput(&r.written.writer, text) catch {};
    }

    fn traceLine(context: *anyopaque, text: []const u8) void {
        const r: *Replay = @ptrCast(@alignCast(context));
        r.trace.appendSlice(r.gpa, text) catch {};
        r.trace.append(r.gpa, '\n') catch {};
    }

    fn crossing(context: *anyopaque) ?[]const u8 {
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return null;
        return if (item == .crossing) item.crossing else null;
    }

    fn take(context: *anyopaque) void {
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return;
        r.next += 1;
        r.written.writer.print("% {s}\n", .{item.crossing}) catch {};
    }

    fn sleep(context: *anyopaque, until: session.Instant) void {
        _ = context;
        _ = until;
    }

    /// `:export <directory>` writes to a scratch directory, which a replay
    /// never makes.
    fn write(context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) bool {
        _ = context;
        _ = directory;
        _ = name;
        _ = data;
        return true;
    }
};

fn instant(shown: []const u8) ?session.Instant {
    var v: ?*c.talk_value = null;
    if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return null;
    defer c.talk_value_release(v);
    var i: session.Instant = undefined;
    if (!c.talk_value_as_instant(v, &i.seconds, &i.micros)) return null;
    return i;
}

/// Replays the Transcript in `dir`, and compares its lines and its Trace.
/// Returns the lines compared, or writes the first difference to `detail`
/// and fails with `error.CaseFailed`.
pub fn run(gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, detail: *std.Io.Writer) !usize {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const text = try dir.readFileAlloc(io, "session.transcript", a, .limited(16 * 1024 * 1024));
    const expected_trace = try dir.readFileAlloc(io, "case.trace", a, .limited(64 * 1024 * 1024));
    const items = try transcript.parse(a, text);
    var replay: Replay = .{ .gpa = a, .items = items, .written = .init(a) };
    const driver: session.Driver = .{ .context = &replay, .reading = Replay.reading, .line = Replay.line, .answer = Replay.answer, .output = Replay.output, .trace = Replay.traceLine, .write = Replay.write, .crossing = Replay.crossing, .take = Replay.take, .sleep = Replay.sleep };
    const s = try Session.init(gpa, driver);
    defer s.deinit();
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
            .crossing => |x| {
                try replay.written.writer.print("% {s}\n", .{x});
                try s.crossing(x);
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
    var want_trace = std.mem.splitScalar(u8, expected_trace, '\n');
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

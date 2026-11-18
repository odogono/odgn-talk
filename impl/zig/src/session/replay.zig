//! A Transcript replayed through the Session Host (chapter 12, Session
//! Transcripts): a Driver that reads each item the session asks for in
//! turn, and writes the Transcript the session makes as it goes. The corpus
//! runner compares what it writes with the case; `session-open` replays a
//! recorded Transcript before a session goes on live (ADR 0180).
const std = @import("std");
const c = @import("talk-c");
const transcript = @import("transcript.zig");
const session = @import("session.zig");

pub const Replay = struct {
    gpa: std.mem.Allocator,
    items: []const transcript.Item,
    next: usize = 0,
    written: std.Io.Writer.Allocating,
    trace: std.ArrayList(u8) = .empty,

    pub fn driver(r: *Replay) session.Driver {
        return .{ .context = r, .reading = reading, .line = line, .answer = answer, .output = output, .trace = traceLine, .write = write, .crossing = crossing, .take = take, .sleep = sleep };
    }

    pub fn peek(r: *Replay) ?transcript.Item {
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

    pub fn crossing(context: *anyopaque) ?[]const u8 {
        const r: *Replay = @ptrCast(@alignCast(context));
        const item = r.peek() orelse return null;
        return if (item == .crossing) item.crossing else null;
    }

    pub fn take(context: *anyopaque) void {
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
    fn write(context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) ?bool {
        _ = context;
        _ = directory;
        _ = name;
        _ = data;
        return true;
    }

    /// Replays every item through `s`, which drives itself with this
    /// Replay: each input, each Pump at a deadline, and each envelope
    /// between Host calls. `error.Unread` when the session didn't read a
    /// `<` or `~` line.
    pub fn run(r: *Replay, s: *session.Session) !void {
        while (r.peek()) |item| {
            r.next += 1;
            switch (item) {
                .input => |input| {
                    try transcript.writeInput(&r.written.writer, input);
                    try s.submit(input);
                },
                // A Pump the session made at a deadline.
                .clock => |shown| {
                    try r.written.writer.print("@ {s}\n", .{shown});
                    try s.deadline(instant(shown) orelse return error.MalformedTranscript);
                },
                .line, .answer => return error.Unread,
                // An envelope between Host calls.
                .crossing => |x| {
                    try r.written.writer.print("% {s}\n", .{x});
                    try s.crossing(x);
                },
                .output => unreachable,
            }
        }
    }
};

/// A Clock reading in the display form.
pub fn instant(shown: []const u8) ?session.Instant {
    var v: ?*c.talk_value = null;
    if (c.talk_parse_display(shown.ptr, shown.len, &v) != c.TALK_OK) return null;
    defer c.talk_value_release(v);
    var i: session.Instant = undefined;
    if (!c.talk_value_as_instant(v, &i.seconds, &i.micros)) return null;
    return i;
}

/// The Transcript's lines, as a session that replays it writes them.
pub fn expected(w: *std.Io.Writer, items: []const transcript.Item) !void {
    for (items) |item| switch (item) {
        .input => |input| try transcript.writeInput(w, input),
        .clock => |x| try w.print("@ {s}\n", .{x}),
        .line => |x| if (x.len == 0) try w.writeAll("<\n") else try w.print("< {s}\n", .{x}),
        .answer => |x| try w.print("~ {s} {s}{s}\n", .{ x.call, if (x.fail) "fail " else "", x.shown }),
        .crossing => |x| try w.print("% {s}\n", .{x}),
        .output => |x| try transcript.writeOutput(w, x),
    };
}

/// The first line where `got` differs from `want`, counted from 1, with
/// both lines, or null when they are the same.
pub const Difference = struct { line: usize, want: ?[]const u8, got: ?[]const u8 };

pub fn difference(want: []const u8, got: []const u8) struct { lines: usize, first: ?Difference } {
    var count: usize = 0;
    var wl = std.mem.splitScalar(u8, want, '\n');
    var gl = std.mem.splitScalar(u8, got, '\n');
    while (true) {
        const x = wl.next();
        const y = gl.next();
        if (x == null and y == null) return .{ .lines = count, .first = null };
        count += 1;
        if (x == null or y == null or !std.mem.eql(u8, x.?, y.?)) return .{ .lines = count, .first = .{ .line = count, .want = x, .got = y } };
    }
}

/// A recorded Host action as a live embedder hands it: the `input`
/// envelope with its `request` alone, whose reply the session finds itself.
pub fn requestOnly(a: std.mem.Allocator, recorded: []const u8) ![]const u8 {
    const v = try std.json.parseFromSliceLeaky(std.json.Value, a, recorded, .{ .parse_numbers = false });
    const request = try std.json.Stringify.valueAlloc(a, v.object.get("request") orelse return error.MalformedTranscript, .{});
    return std.fmt.allocPrint(a, "{{\"request\":{s},\"type\":\"input\"}}", .{request});
}

//! `talk-repl`: the Zig Core's REPL, the Session Host (chapter 12) at a
//! terminal under a real Clock. Entries and Session Commands come from
//! standard input, an Entry over as many lines as it needs, and what the
//! session prints goes to standard output. It can write the session's
//! Transcript and the Group's Trace as it goes.
const std = @import("std");
const c = @import("talk-c");
const session = @import("session");

const transcript = session.transcript;
const Session = session.Session;

const usage =
    \\usage: talk-repl [--transcript <file>] [--trace <file>]
    \\
    \\Reads Entries and Session Commands (`:help` lists none; see chapter 12)
    \\from standard input. An Entry may span lines: the REPL waits for more
    \\while it is incomplete. End the session with end of input (Ctrl-D).
    \\
    \\  --transcript <file>  write the session's Transcript to <file>
    \\  --trace <file>       write the Group's Trace to <file>
    \\
;

const Repl = struct {
    io: std.Io,
    gpa: std.mem.Allocator,
    in: *std.Io.Reader,
    out: *std.Io.Writer,
    /// Whether a person is typing, who gets prompts.
    tty: bool,
    transcript: ?*std.Io.Writer,
    trace: ?*std.Io.Writer,
    /// The last line `read`, owned until the next.
    held: std.ArrayList(u8) = .empty,

    fn now(r: *Repl) session.Instant {
        const t = std.Io.Timestamp.now(r.io, .real);
        return .{ .seconds = @intCast(@divFloor(t.nanoseconds, std.time.ns_per_s)), .nanos = @intCast(@mod(t.nanoseconds, std.time.ns_per_s)) };
    }

    /// An `@` line: a reading's display form.
    fn writeReading(r: *Repl, at: session.Instant) void {
        const w = r.transcript orelse return;
        var v: ?*c.talk_value = null;
        if (c.talk_instant(at.seconds, at.nanos, &v) != c.TALK_OK) return;
        defer c.talk_value_release(v);
        var shown: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_value_string(v, &shown) != c.TALK_OK) return;
        defer c.talk_owned_bytes_release(&shown);
        w.print("@ {s}\n", .{shown.data[0..shown.len]}) catch {};
    }

    fn prompt(r: *Repl, text: []const u8) void {
        if (!r.tty) return;
        r.out.writeAll(text) catch {};
        r.out.flush() catch {};
    }

    /// One line of input without its line break, or null at the end.
    fn readLine(r: *Repl) ?[]const u8 {
        const l = (r.in.takeDelimiter('\n') catch return null) orelse return null;
        return std.mem.trimEnd(u8, l, "\r");
    }

    fn reading(context: *anyopaque) ?session.Instant {
        const r: *Repl = @ptrCast(@alignCast(context));
        const at = r.now();
        r.writeReading(at);
        return at;
    }

    fn line(context: *anyopaque) ?[]const u8 {
        const r: *Repl = @ptrCast(@alignCast(context));
        r.prompt("< ");
        const l = r.readLine() orelse return null;
        r.held.clearRetainingCapacity();
        r.held.appendSlice(r.gpa, l) catch return null;
        if (r.transcript) |w| (if (l.len == 0) w.writeAll("<\n") else w.print("< {s}\n", .{l})) catch {};
        return r.held.items;
    }

    /// A `user` prompt's answer: a value in the display form, or `fail`
    /// and an error map. Anything else is taken as text.
    fn answer(context: *anyopaque, call: []const u8, busy: bool) ?session.Answer {
        const r: *Repl = @ptrCast(@alignCast(context));
        var ans = session.user_busy;
        if (!busy) {
            r.prompt("~ ");
            r.prompt(call);
            r.prompt(" ");
            const l = r.readLine() orelse return null;
            ans = r.answerOf(l) orelse return null;
        }
        if (r.transcript) |w| w.print("~ {s} {s}{s}\n", .{ call, if (ans.fail) "fail " else "", ans.shown }) catch {};
        return ans;
    }

    fn answerOf(r: *Repl, l: []const u8) ?session.Answer {
        const fail = std.mem.startsWith(u8, l, "fail ");
        const text = if (fail) l[5..] else l;
        var v: ?*c.talk_value = null;
        if (c.talk_parse_display(text.ptr, text.len, &v) == c.TALK_OK) {
            c.talk_value_release(v);
            r.held.clearRetainingCapacity();
            r.held.appendSlice(r.gpa, text) catch return null;
            return .{ .shown = r.held.items, .fail = fail };
        }
        if (fail) return null;
        // Plain text, quoted as the display form quotes it.
        if (c.talk_text(text.ptr, text.len, &v) != c.TALK_OK) return null;
        defer c.talk_value_release(v);
        var shown: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_value_string(v, &shown) != c.TALK_OK) return null;
        defer c.talk_owned_bytes_release(&shown);
        r.held.clearRetainingCapacity();
        r.held.appendSlice(r.gpa, shown.data[0..shown.len]) catch return null;
        return .{ .shown = r.held.items, .fail = false };
    }

    fn output(context: *anyopaque, text: []const u8) void {
        const r: *Repl = @ptrCast(@alignCast(context));
        r.out.print("{s}\n", .{text}) catch {};
        r.out.flush() catch {};
        if (r.transcript) |w| transcript.writeOutput(w, text) catch {};
    }

    fn traceLine(context: *anyopaque, text: []const u8) void {
        const r: *Repl = @ptrCast(@alignCast(context));
        const w = r.trace orelse return;
        w.print("{s}\n", .{text}) catch {};
    }

    /// `:export <directory>`: one file in it.
    fn write(context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) bool {
        const r: *Repl = @ptrCast(@alignCast(context));
        var dir = std.Io.Dir.cwd().createDirPathOpen(r.io, directory, .{}) catch return false;
        defer dir.close(r.io);
        dir.writeFile(r.io, .{ .sub_path = name, .data = data }) catch return false;
        return true;
    }

    fn sleep(context: *anyopaque, at: session.Instant) void {
        const r: *Repl = @ptrCast(@alignCast(context));
        const ns = r.until(at);
        if (ns > 0) r.io.sleep(.fromNanoseconds(@intCast(ns)), .real) catch {};
    }

    /// Nanoseconds from now to `at`, negative once it has passed.
    fn until(r: *Repl, at: session.Instant) i128 {
        const t = r.now();
        return (@as(i128, at.seconds) - t.seconds) * std.time.ns_per_s + (@as(i128, at.nanos) - t.nanos);
    }

    /// A live session records no object crossings.
    fn crossing(context: *anyopaque) ?[]const u8 {
        _ = context;
        return null;
    }

    fn take(context: *anyopaque) void {
        _ = context;
    }

    /// Waits for input, pumping at each deadline the session reaches
    /// meanwhile. False at the end of input.
    fn await(r: *Repl, s: *Session) !void {
        while (r.in.bufferedLen() == 0) {
            const due = s.nextDeadline() orelse return;
            const wait_ns = r.until(due);
            if (wait_ns > 0) {
                var fds = [_]std.posix.pollfd{.{ .fd = std.posix.STDIN_FILENO, .events = std.posix.POLL.IN, .revents = 0 }};
                const ms: i32 = @intCast(@min(@divFloor(wait_ns + std.time.ns_per_ms - 1, std.time.ns_per_ms), std.math.maxInt(i32)));
                if (try std.posix.poll(&fds, ms) > 0) return;
            }
            const reading_at = r.now();
            r.writeReading(reading_at);
            try s.deadline(reading_at);
        }
    }
};

/// Reads a file's lines, each without its line break, for a command a
/// Transcript records with the file's lines in place of its path.
fn fileLines(io: std.Io, a: std.mem.Allocator, path: []const u8) ?[]const []const u8 {
    const text = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(64 * 1024 * 1024)) catch return null;
    var lines: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, text, '\n');
    while (it.next()) |l| {
        if (l.len == 0 and it.peek() == null) break;
        lines.append(a, std.mem.trimEnd(u8, l, "\r")) catch return null;
    }
    return lines.items;
}

/// A command that names a file, `:library add|replace <name> <path>`,
/// `:fix <run> <path>` or `:store load [<store>] <path>`, as the Session
/// Host takes it: without the path, and with the file's lines.
fn withFile(io: std.Io, a: std.mem.Allocator, input: transcript.Input) ?transcript.Input {
    var words: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeAny(u8, input.first, " \t");
    while (it.next()) |w| words.append(a, w) catch return null;
    const items = words.items;
    const names_file = (items.len == 4 and std.mem.eql(u8, items[0], ":library")) or
        (items.len == 3 and std.mem.eql(u8, items[0], ":fix")) or
        (items.len >= 3 and items.len <= 4 and std.mem.eql(u8, items[0], ":store") and std.mem.eql(u8, items[1], "load"));
    if (!names_file or input.more.len > 0) return input;
    const lines = fileLines(io, a, items[items.len - 1]) orelse return null;
    const first = std.mem.join(a, " ", items[0 .. items.len - 1]) catch return null;
    return .{ .first = first, .more = lines };
}

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const gpa = init.gpa;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    var transcript_path: ?[]const u8 = null;
    var trace_path: ?[]const u8 = null;
    var stderr_buffer: [1024]u8 = undefined;
    var stderr = std.Io.File.stderr().writerStreaming(io, &stderr_buffer);
    const e = &stderr.interface;
    defer e.flush() catch {};
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) {
            try e.writeAll(usage);
            return 0;
        }
        const target = if (std.mem.eql(u8, arg, "--transcript")) &transcript_path else if (std.mem.eql(u8, arg, "--trace")) &trace_path else {
            try e.print("unknown argument: {s}\n{s}", .{ arg, usage });
            return 2;
        };
        i += 1;
        if (i == args.len) {
            try e.print("{s} needs a file\n", .{arg});
            return 2;
        }
        target.* = args[i];
    }

    var in_buffer: [64 * 1024]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(io, &in_buffer);
    var out_buffer: [8192]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(io, &out_buffer);
    defer stdout.interface.flush() catch {};

    var transcript_file: ?std.Io.File = null;
    defer if (transcript_file) |f| f.close(io);
    var transcript_buffer: [8192]u8 = undefined;
    var transcript_writer: std.Io.File.Writer = undefined;
    if (transcript_path) |p| {
        transcript_file = try std.Io.Dir.cwd().createFile(io, p, .{});
        transcript_writer = transcript_file.?.writerStreaming(io, &transcript_buffer);
    }
    defer if (transcript_file != null) transcript_writer.interface.flush() catch {};
    var trace_file: ?std.Io.File = null;
    defer if (trace_file) |f| f.close(io);
    var trace_buffer: [8192]u8 = undefined;
    var trace_writer: std.Io.File.Writer = undefined;
    if (trace_path) |p| {
        trace_file = try std.Io.Dir.cwd().createFile(io, p, .{});
        trace_writer = trace_file.?.writerStreaming(io, &trace_buffer);
    }
    defer if (trace_file != null) trace_writer.interface.flush() catch {};

    var repl: Repl = .{
        .io = io,
        .gpa = gpa,
        .in = &stdin.interface,
        .out = &stdout.interface,
        .tty = std.Io.File.stdin().isTty(io) catch false,
        .transcript = if (transcript_file != null) &transcript_writer.interface else null,
        .trace = if (trace_file != null) &trace_writer.interface else null,
    };
    defer repl.held.deinit(gpa);
    const driver: session.Driver = .{ .context = &repl, .reading = Repl.reading, .line = Repl.line, .answer = Repl.answer, .output = Repl.output, .trace = Repl.traceLine, .write = Repl.write, .crossing = Repl.crossing, .take = Repl.take, .sleep = Repl.sleep };
    const s = try Session.init(gpa, driver);
    defer s.deinit();

    var entry: std.ArrayList([]const u8) = .empty;
    defer {
        for (entry.items) |l| gpa.free(l);
        entry.deinit(gpa);
    }
    while (true) {
        repl.prompt(if (entry.items.len == 0) "> " else "| ");
        try repl.await(s);
        const l = repl.readLine();
        if (l) |text| {
            if (entry.items.len == 0 and std.mem.trim(u8, text, " \t").len == 0) continue;
            try entry.append(gpa, try gpa.dupe(u8, text));
            const joined = try std.mem.join(gpa, "\n", entry.items);
            defer gpa.free(joined);
            if (!try s.complete(joined)) continue;
        } else if (entry.items.len == 0) break;
        // A whole Entry or Session Command, or what is left at the end of
        // input, which the Session Host reports.
        var scratch: std.heap.ArenaAllocator = .init(gpa);
        defer scratch.deinit();
        var input: transcript.Input = .{ .first = entry.items[0], .more = entry.items[1..] };
        if (withFile(io, scratch.allocator(), input)) |x| input = x else {
            try repl.out.writeAll("! bad arguments\n");
            try repl.out.flush();
            input = .{ .first = "", .more = &.{} };
        }
        if (input.first.len > 0) {
            if (repl.transcript) |w| try transcript.writeInput(w, input);
            try s.submit(input);
            if (repl.transcript) |w| try w.flush();
            if (repl.trace) |w| try w.flush();
        }
        for (entry.items) |x| gpa.free(x);
        entry.clearRetainingCapacity();
        if (l == null) break;
    }
    return 0;
}

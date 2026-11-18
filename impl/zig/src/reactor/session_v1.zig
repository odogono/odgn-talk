//! `session-v1` (ADR 0180; chapter 9, Sessions): the Zig Session Host
//! served through the reactor, so an embedder keeps only its Session
//! Driver, its I/O and its Host Objects.
//!
//! One guest serves one session, which owns its Group. Answers the session
//! would block for travel with the next message instead: each
//! `session-input` and `session-pump` carries the Clock reading under a
//! real Clock, a console line or a prompt's answer is a `session-input`,
//! and nothing sleeps: every reply says what the session waits for and its
//! next deadline. Only three answers are `need`s, each able to stay open
//! across frames: `prop` for a live crossing, `resolve` for a live Restore
//! and `write` for `:export` and `:store save`.
//!
//! Every reply carries the session's output lines, its Trace lines and its
//! Transcript Items, as the lines a `.transcript` file holds, in the order
//! the session made them.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const session = @import("session");

const message = northtalk.message;
const transcript = session.transcript;
const Allocator = std.mem.Allocator;
const Json = std.json.Value;

pub const feature = "session-v1";

/// The guest's session, and what the frame in progress carries.
pub const Server = struct {
    /// Lives as long as the session: its inputs and a replayed Transcript.
    life: std.heap.ArenaAllocator,
    /// Lives as long as a Host call: its need and the answers it has.
    call: std.heap.ArenaAllocator,
    /// Lives for one reply: its records.
    reply: std.heap.ArenaAllocator,
    host: ?*session.Session = null,
    closed: bool = false,
    /// What an open Host call waits for, under the ref whose frame stopped it.
    need: ?Need = null,
    /// An input typed while ending a foreground wait, which stopped at a
    /// need; it runs once the call ends.
    deferred: ?transcript.Input = null,
    /// The answers a `:export`, `:store save` or `:restore` got, which it
    /// reads again as it runs again from its start.
    writes: std.ArrayList(bool) = .empty,
    written: usize = 0,
    resolved: ?[]const u8 = null,
    /// A crossing's answer, taken once.
    answered: ?[]const u8 = null,
    /// The frame's line and prompt answer, and the reading of the frame
    /// that started the Host call, which its needs' results go on with.
    given_reading: ?session.Instant = null,
    given_line: ?[]const u8 = null,
    given_answer: ?session.Answer = null,
    said: std.ArrayList([]const u8) = .empty,
    trace: std.ArrayList([]const u8) = .empty,
    lines: std.ArrayList([]const u8) = .empty,

    const Need = struct { ref: i64, kind: Kind, text: []const u8 };
    const Kind = enum { prop, resolve, write };

    pub fn init(gpa: Allocator) Server {
        return .{ .life = .init(gpa), .call = .init(gpa), .reply = .init(gpa) };
    }

    pub fn deinit(srv: *Server) void {
        srv.end();
        srv.life.deinit();
        srv.call.deinit();
        srv.reply.deinit();
    }

    /// The extension the reactor's image declares.
    pub fn extension(srv: *Server) message.Extension {
        return .{ .feature = feature, .context = srv, .handle = handleFrame };
    }

    fn end(srv: *Server) void {
        if (srv.host) |h| h.deinit();
        srv.host = null;
    }

    /// The live driver; with live Host Objects, it answers crossings and
    /// Restores through needs, and records the session's envelopes.
    fn driver(srv: *Server, objects: bool) session.Driver {
        var d: session.Driver = .{ .context = srv, .reading = reading, .line = line, .answer = answer, .output = output, .trace = traceLine, .write = write, .crossing = noCrossing, .take = noTake, .sleep = noSleep, .suspends = true };
        if (objects) {
            d.prop = prop;
            d.resolve = resolve;
            d.record = record;
        }
        return d;
    }

    // -------------------------------------------------------- the Driver

    fn of(context: *anyopaque) *Server {
        return @ptrCast(@alignCast(context));
    }

    fn recordLine(srv: *Server, comptime fmt: []const u8, args: anytype) void {
        const a = srv.reply.allocator();
        srv.lines.append(a, std.fmt.allocPrint(a, fmt, args) catch return) catch {};
    }

    fn reading(context: *anyopaque) ?session.Instant {
        const srv = of(context);
        const at = srv.given_reading orelse return null;
        srv.recordLine("@ {s}", .{shownInstant(srv.reply.allocator(), at)});
        return at;
    }

    fn line(context: *anyopaque) ?[]const u8 {
        const srv = of(context);
        const l = srv.given_line orelse return null;
        srv.given_line = null;
        if (l.len == 0) srv.recordLine("<", .{}) else srv.recordLine("< {s}", .{l});
        return l;
    }

    /// The frame's answer, or `user busy` for a prompt while one waits.
    fn answer(context: *anyopaque, call: []const u8, busy: bool) ?session.Answer {
        const srv = of(context);
        const ans = if (busy) session.user_busy else srv.given_answer orelse return null;
        if (!busy) srv.given_answer = null;
        srv.recordLine("~ {s} {s}{s}", .{ call, if (ans.fail) "fail " else "", ans.shown });
        return ans;
    }

    fn output(context: *anyopaque, text: []const u8) void {
        const srv = of(context);
        const a = srv.reply.allocator();
        const kept = a.dupe(u8, text) catch return;
        srv.said.append(a, kept) catch {};
        srv.recordLine("{s}{s}", .{ if (transcript.escaped(text)) "'" else "", text });
    }

    fn traceLine(context: *anyopaque, text: []const u8) void {
        const srv = of(context);
        const a = srv.reply.allocator();
        srv.trace.append(a, a.dupe(u8, text) catch return) catch {};
    }

    fn record(context: *anyopaque, envelope: []const u8) void {
        of(context).recordLine("% {s}", .{envelope});
    }

    fn write(context: *anyopaque, directory: []const u8, name: []const u8, data: []const u8) ?bool {
        const srv = of(context);
        if (srv.written < srv.writes.items.len) {
            defer srv.written += 1;
            return srv.writes.items[srv.written];
        }
        var out: std.Io.Writer.Allocating = .init(srv.call.allocator());
        std.json.Stringify.value(.{ .m = "write", .directory = directory, .name = name, .data = data }, .{}, &out.writer) catch return false;
        srv.asked(.write, out.written());
        return null;
    }

    fn prop(context: *anyopaque, need: []const u8) ?[]const u8 {
        const srv = of(context);
        if (srv.answered) |a| {
            srv.answered = null;
            return a;
        }
        srv.asked(.prop, need);
        return null;
    }

    fn resolve(context: *anyopaque, objects: []const u8) ?[]const u8 {
        const srv = of(context);
        if (srv.resolved) |r| return r;
        const text = std.fmt.allocPrint(srv.call.allocator(), "{{\"m\":\"resolve\",\"objects\":{s}}}", .{objects}) catch return "[]";
        srv.asked(.resolve, text);
        return null;
    }

    /// The need the call stops for; its ref is set when the frame replies.
    fn asked(srv: *Server, kind: Kind, text: []const u8) void {
        srv.need = .{ .ref = 0, .kind = kind, .text = srv.call.allocator().dupe(u8, text) catch "" };
    }

    fn noCrossing(context: *anyopaque) ?[]const u8 {
        _ = context;
        return null;
    }

    fn noTake(context: *anyopaque) void {
        _ = context;
    }

    fn noSleep(context: *anyopaque, until: session.Instant) void {
        _ = context;
        _ = until;
    }

    // -------------------------------------------------------- frames

    pub fn handleFrame(context: *anyopaque, s: *message.Session, msg: Json, ref: i64, m: []const u8) ?[]u8 {
        const srv = of(context);
        defer {
            _ = srv.reply.reset(.retain_capacity);
            srv.said = .empty;
            srv.trace = .empty;
            srv.lines = .empty;
            srv.given_line = null;
            if (srv.need == null) srv.given_reading = null;
            srv.given_answer = null;
        }
        const gpa = s.gpa;
        const named = std.mem.startsWith(u8, m, "session-");
        if (srv.host == null and !srv.closed) {
            if (std.mem.eql(u8, m, "session-open")) return srv.open(gpa, msg, ref);
            return if (named) message.protocolError(gpa, ref, "no session is open") else null;
        }
        // The guest serves only its session, the Core's reading of source
        // and `hello`.
        if (isAnalysis(m) or std.mem.eql(u8, m, "hello")) return null;
        if (srv.closed) return message.protocolError(gpa, ref, "the session is closed");
        if (srv.need) |n| {
            if (std.mem.eql(u8, m, "session-close")) return srv.close(gpa, ref);
            const result = switch (n.kind) {
                .prop => "prop-result",
                .resolve => "resolve-result",
                .write => "write-result",
            };
            if (!std.mem.eql(u8, m, result) or ref != n.ref) return message.protocolError(gpa, ref, if (std.mem.endsWith(u8, m, "-result")) "the result does not match the need" else "a session is waiting for its result");
            return srv.answerNeed(gpa, msg, ref, n.kind);
        }
        if (std.mem.eql(u8, m, "session-input")) return srv.input(gpa, msg, ref);
        if (std.mem.eql(u8, m, "session-pump")) return srv.pump(gpa, msg, ref);
        if (std.mem.eql(u8, m, "session-describe-prompt")) return srv.describePrompt(gpa, ref);
        if (std.mem.eql(u8, m, "session-close")) return srv.close(gpa, ref);
        if (std.mem.eql(u8, m, "session-open")) return message.protocolError(gpa, ref, "a session is open");
        return message.protocolError(gpa, ref, "this guest serves a session");
    }

    fn isAnalysis(m: []const u8) bool {
        for ([_][]const u8{ "analyze-entry", "analyze-source", "analysis-catalogue", "message-name" }) |x| if (std.mem.eql(u8, m, x)) return true;
        return false;
    }

    /// `session-open`: the Clock mode, limits, and `objects`, present when
    /// the embedder serves live Host Objects, with the Object Kinds,
    /// identities and initial bindings it declares; or a recorded
    /// Transcript, which replays without a record and must replay exactly,
    /// and declares its own.
    fn open(srv: *Server, gpa: Allocator, msg: Json, ref: i64) []u8 {
        const la = srv.life.allocator();
        var clock: session.Clock = .real;
        if (msg.object.get("clock")) |x| {
            const shown = textOf(x) orelse return message.protocolError(gpa, ref, "clock is \"real\" or a virtual Instant");
            if (!std.mem.eql(u8, shown, "real")) clock = .{ .virtual = session.replay.instant(shown) orelse return message.protocolError(gpa, ref, "clock is \"real\" or a virtual Instant") };
        }
        var limits: session.Limits = .{};
        if (msg.object.get("limits")) |x| {
            if (x != .object) return message.protocolError(gpa, ref, "limits must be a map");
            var it = x.object.iterator();
            while (it.next()) |e| {
                const n = whole(e.value_ptr.*) orelse return message.protocolError(gpa, ref, "a limit is a whole number");
                const k = e.key_ptr.*;
                if (std.mem.eql(u8, k, "fuelPerRun")) limits.fuel_per_run = n else if (std.mem.eql(u8, k, "allocPerRun")) limits.alloc_per_run = n else if (std.mem.eql(u8, k, "maxWaitMs")) limits.max_wait_ms = n else if (std.mem.eql(u8, k, "maxJoin")) limits.max_join = n else return message.protocolError(gpa, ref, "unknown limit");
            }
        }
        const live = msg.object.get("objects") != null;
        const objects = texts(la, msg.object.get("objects")) orelse return message.protocolError(gpa, ref, "objects must be envelope texts");
        const recorded: ?[]const u8 = if (msg.object.get("transcript")) |x| la.dupe(u8, textOf(x) orelse return message.protocolError(gpa, ref, "transcript must be text")) catch return oom(gpa, ref) else null;
        if (recorded != null and objects.len > 0) return message.protocolError(gpa, ref, "a recorded Transcript declares its own objects");

        var replay: session.replay.Replay = undefined;
        const items: []const transcript.Item = if (recorded) |r| transcript.parse(la, r) catch return message.protocolError(gpa, ref, "the transcript is malformed") else &.{};
        replay = .{ .gpa = la, .items = items, .written = .init(la) };
        const h = session.Session.init(gpa, if (recorded != null) replay.driver() else srv.driver(live)) catch return oom(gpa, ref);
        h.clock = clock;
        h.limits = limits;
        srv.host = h;
        if (recorded != null) {
            replay.run(h) catch |err| {
                srv.end();
                return message.protocolError(gpa, ref, switch (err) {
                    error.Unread => "the transcript has a line the session didn't read",
                    error.MalformedTranscript => "the transcript is malformed",
                    else => "the transcript doesn't replay",
                });
            };
            var want: std.Io.Writer.Allocating = .init(la);
            session.replay.expected(&want.writer, items) catch return oom(gpa, ref);
            if (session.replay.difference(want.written(), replay.written.written()).first) |d| {
                srv.end();
                const detail = std.fmt.allocPrint(srv.reply.allocator(), "the transcript doesn't replay at line {d}: expected {s}, got {s}", .{ d.line, d.want orelse "<end>", d.got orelse "<end>" }) catch "the transcript doesn't replay";
                return message.protocolError(gpa, ref, detail);
            }
            h.driver = srv.driver(live);
        }
        for (objects) |o| h.declare(o) catch |err| {
            srv.end();
            return message.protocolError(gpa, ref, std.fmt.allocPrint(srv.reply.allocator(), "the object envelope is refused: {s}", .{@errorName(err)}) catch "the object envelope is refused");
        };
        // Its declarations are this reply's Transcript Items.
        return srv.ok(gpa, ref);
    }

    /// The reading the frame must carry under a real Clock, and mustn't
    /// under a virtual one.
    fn takeReading(srv: *Server, gpa: Allocator, msg: Json, ref: i64) ?[]u8 {
        const h = srv.host.?;
        const given = msg.object.get("reading");
        switch (h.clock) {
            .real => {
                const shown = textOf(given orelse return message.protocolError(gpa, ref, "a real Clock needs a reading")) orelse return message.protocolError(gpa, ref, "a reading is an Instant");
                srv.given_reading = session.replay.instant(shown) orelse return message.protocolError(gpa, ref, "a reading is an Instant");
            },
            .virtual => {
                if (given != null) return message.protocolError(gpa, ref, "a virtual Clock takes no reading");
                srv.given_reading = null;
            },
        }
        return null;
    }

    /// `session-input`: one Entry or Session Command (`input`, with any
    /// further lines in `more`), a console `line`, a prompt's `answer`, or
    /// an `envelope` between Host calls: an object declaration, or a Host
    /// action's `input` with its `request` alone.
    fn input(srv: *Server, gpa: Allocator, msg: Json, ref: i64) []u8 {
        const h = srv.host.?;
        const la = srv.life.allocator();
        var given: usize = 0;
        for ([_][]const u8{ "input", "line", "answer", "envelope" }) |k| {
            if (msg.object.get(k) != null) given += 1;
        }
        if (given != 1) return message.protocolError(gpa, ref, "session-input takes one of input, line, answer or envelope");
        if (srv.takeReading(gpa, msg, ref)) |refused| return refused;
        if (msg.object.get("envelope")) |x| {
            const e = textOf(x) orelse return message.protocolError(gpa, ref, "an envelope is text");
            if (h.waiting() != .prompt) return message.protocolError(gpa, ref, "a Host call is open");
            h.receive(e) catch |err| return message.protocolError(gpa, ref, std.fmt.allocPrint(srv.reply.allocator(), "the object envelope is refused: {s}", .{@errorName(err)}) catch "the object envelope is refused");
            return srv.ok(gpa, ref);
        }
        if (msg.object.get("line")) |x| {
            if (h.waiting() != .read) return message.protocolError(gpa, ref, "the session isn't waiting for a line");
            srv.given_line = la.dupe(u8, textOf(x) orelse return message.protocolError(gpa, ref, "a line is text")) catch return oom(gpa, ref);
            return srv.go(gpa, ref, h.resumeCall(.answered));
        }
        if (msg.object.get("answer")) |x| {
            if (h.waiting() != .user) return message.protocolError(gpa, ref, "the session isn't waiting for a prompt's answer");
            srv.given_answer = answerOf(la, x) orelse return message.protocolError(gpa, ref, "an answer is {shown, fail}");
            return srv.go(gpa, ref, h.resumeCall(.answered));
        }
        const first = textOf(msg.object.get("input").?) orelse return message.protocolError(gpa, ref, "input is text");
        const more = texts(la, msg.object.get("more")) orelse return message.protocolError(gpa, ref, "more must be text lines");
        if (std.mem.indexOfScalar(u8, first, '\n') != null) return message.protocolError(gpa, ref, "input is one line; further lines go in more");
        const typed: transcript.Input = .{ .first = la.dupe(u8, first) catch return oom(gpa, ref), .more = more };
        // A foreground wait ends first, as when the person types instead.
        switch (h.waiting()) {
            .read, .user, .deadline => h.resumeCall(.abandon) catch |err| {
                if (err == error.Suspended) srv.deferred = typed;
                return srv.go(gpa, ref, err);
            },
            else => {},
        }
        return srv.go(gpa, ref, srv.submit(typed));
    }

    fn submit(srv: *Server, typed: transcript.Input) !void {
        const name = typed.first[0 .. std.mem.indexOfAny(u8, typed.first, " \t") orelse typed.first.len];
        // `:help` and `:quit` are the Driver's, and aren't recorded.
        if (!std.mem.eql(u8, name, ":help") and !std.mem.eql(u8, name, ":quit")) {
            srv.recordLine("> {s}", .{typed.first});
            for (typed.more) |l| if (l.len == 0) srv.recordLine("|", .{}) else srv.recordLine("| {s}", .{l});
        }
        try srv.host.?.submit(typed);
    }

    /// `session-pump`: a deadline came. The foreground's wait Pumps, or
    /// else the session Pumps by itself.
    fn pump(srv: *Server, gpa: Allocator, msg: Json, ref: i64) []u8 {
        const h = srv.host.?;
        if (srv.takeReading(gpa, msg, ref)) |refused| return refused;
        switch (h.waiting()) {
            .read, .user, .deadline => return srv.go(gpa, ref, h.resumeCall(.wake)),
            else => {},
        }
        const at = switch (h.clock) {
            .real => at: {
                const r = srv.given_reading.?;
                srv.recordLine("@ {s}", .{shownInstant(srv.reply.allocator(), r)});
                break :at r;
            },
            .virtual => |v| v,
        };
        return srv.go(gpa, ref, h.deadline(at));
    }

    /// `session-describe-prompt`: the `user` prompt the foreground waits for.
    fn describePrompt(srv: *Server, gpa: Allocator, ref: i64) []u8 {
        const p = srv.host.?.prompt() orelse return message.protocolError(gpa, ref, "no prompt is waiting");
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        std.json.Stringify.value(.{ .ref = ref, .ok = .{ .call = p.call, .kind = p.kind, .message = p.message, .prompt = p.prompt, .default = p.fallback, .items = p.items, .multiple = p.multiple } }, .{}, &out.writer) catch return oom(gpa, ref);
        return out.toOwnedSlice() catch oom(gpa, ref);
    }

    /// `session-close`: the session and its Group go, with any need open.
    fn close(srv: *Server, gpa: Allocator, ref: i64) []u8 {
        srv.end();
        srv.closed = true;
        srv.need = null;
        srv.deferred = null;
        srv.callEnded();
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        out.writer.print("{{\"ref\":{d},\"ok\":{{}}}}", .{ref}) catch return oom(gpa, ref);
        return out.toOwnedSlice() catch oom(gpa, ref);
    }

    /// A need's result: the crossing's answer goes to the Pump waiting at
    /// its Crossing Pause; a `write` or `resolve` answer runs the command
    /// again from its start, with every answer it has had.
    fn answerNeed(srv: *Server, gpa: Allocator, msg: Json, ref: i64, kind: Kind) []u8 {
        const h = srv.host.?;
        const ca = srv.call.allocator();
        switch (kind) {
            .prop => {
                // What the Host did before answering: identities its answer
                // names, and Host actions, recorded before the crossing's end.
                if (msg.object.get("envelopes")) |d| {
                    const envelopes = texts(srv.life.allocator(), d) orelse return message.protocolError(gpa, ref, "envelopes must be envelope texts");
                    // A malformed one refuses them all before any applies,
                    // so the result can be sent again.
                    h.checkReceived(envelopes) catch |err| return message.protocolError(gpa, ref, std.fmt.allocPrint(srv.reply.allocator(), "the object envelope is refused: {s}", .{@errorName(err)}) catch "the object envelope is refused");
                    for (envelopes) |e| h.receive(e) catch |err| return message.protocolError(gpa, ref, std.fmt.allocPrint(srv.reply.allocator(), "the object envelope is refused: {s}", .{@errorName(err)}) catch "the object envelope is refused");
                }
                // The one outcome it gives; the session checks it.
                var outcome: std.Io.Writer.Allocating = .init(ca);
                var jw: std.json.Stringify = .{ .writer = &outcome.writer };
                jw.beginObject() catch return oom(gpa, ref);
                for ([_][]const u8{ "value", "ok", "fail", "hostError" }) |k| if (msg.object.get(k)) |v| {
                    jw.objectField(k) catch return oom(gpa, ref);
                    jw.write(v) catch return oom(gpa, ref);
                };
                jw.endObject() catch return oom(gpa, ref);
                srv.answered = outcome.written();
            },
            .resolve => {
                const objects = msg.object.get("objects") orelse return message.protocolError(gpa, ref, "resolve-result needs objects");
                srv.resolved = std.json.Stringify.valueAlloc(ca, objects, .{}) catch return oom(gpa, ref);
            },
            .write => {
                const written = msg.object.get("written") orelse return message.protocolError(gpa, ref, "write-result needs written");
                if (written != .bool) return message.protocolError(gpa, ref, "written is a boolean");
                srv.writes.append(ca, written.bool) catch return oom(gpa, ref);
            },
        }
        srv.need = null;
        srv.written = 0;
        return srv.go(gpa, ref, h.resumeCall(.answered));
    }

    // -------------------------------------------------------- replies

    /// The reply to a frame that ran the session: a need it stopped at, or
    /// what it waits for now. A deferred input runs once the call ends.
    fn go(srv: *Server, gpa: Allocator, ref: i64, ran: anyerror!void) []u8 {
        var outcome = ran;
        while (true) {
            outcome catch |err| {
                if (err != error.Suspended) {
                    srv.callEnded();
                    srv.deferred = null;
                    return message.protocolError(gpa, ref, std.fmt.allocPrint(srv.reply.allocator(), "the session failed: {s}", .{@errorName(err)}) catch "the session failed");
                }
                if (srv.need) |*n| {
                    n.ref = ref;
                    return srv.needReply(gpa, ref, n.text);
                }
                // A foreground wait: the call stays open.
                return srv.ok(gpa, ref);
            };
            srv.callEnded();
            const next = srv.deferred orelse return srv.ok(gpa, ref);
            srv.deferred = null;
            outcome = srv.submit(next);
        }
    }

    fn callEnded(srv: *Server) void {
        srv.writes = .empty;
        srv.written = 0;
        srv.resolved = null;
        srv.answered = null;
        _ = srv.call.reset(.retain_capacity);
    }

    fn ok(srv: *Server, gpa: Allocator, ref: i64) []u8 {
        const h = srv.host.?;
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        var jw: std.json.Stringify = .{ .writer = &out.writer };
        jw.beginObject() catch return oom(gpa, ref);
        jw.objectField("ref") catch return oom(gpa, ref);
        jw.write(ref) catch return oom(gpa, ref);
        jw.objectField("ok") catch return oom(gpa, ref);
        jw.beginObject() catch return oom(gpa, ref);
        jw.objectField("waiting") catch return oom(gpa, ref);
        jw.write(@tagName(h.waiting())) catch return oom(gpa, ref);
        // Whether the next frames carry readings.
        jw.objectField("clock") catch return oom(gpa, ref);
        jw.write(@as([]const u8, if (h.clock == .real) "real" else "virtual")) catch return oom(gpa, ref);
        jw.objectField("deadline") catch return oom(gpa, ref);
        if (h.nextDeadline()) |d| jw.write(shownInstant(srv.reply.allocator(), d)) catch return oom(gpa, ref) else jw.write(null) catch return oom(gpa, ref);
        jw.endObject() catch return oom(gpa, ref);
        srv.records(&jw) catch return oom(gpa, ref);
        jw.endObject() catch return oom(gpa, ref);
        return out.toOwnedSlice() catch oom(gpa, ref);
    }

    fn needReply(srv: *Server, gpa: Allocator, ref: i64, need: []const u8) []u8 {
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        var jw: std.json.Stringify = .{ .writer = &out.writer };
        jw.beginObject() catch return oom(gpa, ref);
        jw.objectField("ref") catch return oom(gpa, ref);
        jw.write(ref) catch return oom(gpa, ref);
        jw.objectField("need") catch return oom(gpa, ref);
        jw.print("{s}", .{need}) catch return oom(gpa, ref);
        srv.records(&jw) catch return oom(gpa, ref);
        jw.endObject() catch return oom(gpa, ref);
        return out.toOwnedSlice() catch oom(gpa, ref);
    }

    fn records(srv: *Server, jw: *std.json.Stringify) !void {
        try jw.objectField("output");
        try jw.write(srv.said.items);
        try jw.objectField("trace");
        try jw.write(srv.trace.items);
        try jw.objectField("transcript");
        try jw.write(srv.lines.items);
    }
};

/// The reactor image's one server, made with the Message Layer's
/// allocator on its first frame.
pub const Image = struct {
    server: ?Server = null,

    pub fn extension(img: *Image) message.Extension {
        return .{ .feature = feature, .context = img, .handle = handle };
    }

    fn handle(context: *anyopaque, s: *message.Session, msg: Json, ref: i64, m: []const u8) ?[]u8 {
        const img: *Image = @ptrCast(@alignCast(context));
        if (img.server == null) img.server = .init(s.gpa);
        return Server.handleFrame(&img.server.?, s, msg, ref, m);
    }
};

fn oom(gpa: Allocator, ref: i64) []u8 {
    return message.protocolError(gpa, ref, "out of memory");
}

fn textOf(v: Json) ?[]const u8 {
    return if (v == .string) v.string else null;
}

fn whole(v: Json) ?i64 {
    return switch (v) {
        .integer => |n| if (n >= 0) n else null,
        .number_string => |s| std.fmt.parseInt(i64, s, 10) catch null,
        else => null,
    };
}

/// Text lines, copied, or none when the field is absent.
fn texts(a: Allocator, v: ?Json) ?[]const []const u8 {
    const x = v orelse return &.{};
    if (x != .array) return null;
    const out = a.alloc([]const u8, x.array.items.len) catch return null;
    for (x.array.items, out) |item, *o| o.* = a.dupe(u8, textOf(item) orelse return null) catch return null;
    return out;
}

/// A prompt's answer: `{"shown": <display form>, "fail": <bool>}`.
fn answerOf(a: Allocator, v: Json) ?session.Answer {
    if (v != .object) return null;
    const shown = textOf(v.object.get("shown") orelse return null) orelse return null;
    const fail = if (v.object.get("fail")) |f| (if (f == .bool) f.bool else return null) else false;
    return .{ .shown = a.dupe(u8, shown) catch return null, .fail = fail };
}

/// An Instant in the display form, as a Transcript's `@` line holds it.
fn shownInstant(a: Allocator, at: session.Instant) []const u8 {
    var v: ?*c.talk_value = null;
    if (c.talk_instant(at.seconds, at.micros, &v) != c.TALK_OK) return "";
    defer c.talk_value_release(v);
    var shown: c.talk_owned_bytes = .{ .data = null, .len = 0 };
    if (c.talk_value_string(v, &shown) != c.TALK_OK) return "";
    defer c.talk_owned_bytes_release(&shown);
    return a.dupe(u8, shown.data[0..shown.len]) catch "";
}

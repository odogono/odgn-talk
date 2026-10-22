//! The native Script Runner: `northtalk app.talk [args…]` (chapter 12, The
//! Script Runner; ADR 0126). It loads the file as one Script in one Group,
//! Delivers `start` with the arguments after the file, and runs until
//! nothing can happen again, as the TS Runner (tooling/cli/src/run.ts) and
//! the Go one (impl/go/cmd/northtalk/run.go) do. One thread polls the HTTP
//! sockets, standard input and a signal pipe, and pumps at each Host Input,
//! timer and deadline. It grants `console`, `clock`, `timer`, an in-memory
//! `store` (the Session Store's), `http` and, at a terminal, `user`; it has
//! no time-zone or Locale data, so no `calendar` or `locale`.
const std = @import("std");
const c = @import("talk-c");
const session = @import("session");
const router_mod = @import("router.zig");

const sys = std.c;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const Router = router_mod.Router;
const Stores = session.store.Stores;

/// How long the first signal waits for open HTTP Exchanges.
const drain_ms: i64 = 5000;

pub const Options = struct {
    file: []const u8,
    /// The arguments after the file, given to `start`.
    args: []const []const u8,
    /// Overrides every `serve`'s port: `--port` or PORT.
    port: ?u16 = null,
};

const Instant = struct {
    seconds: i64,
    micros: i32,

    fn now() Instant {
        var ts: sys.timespec = undefined;
        _ = sys.clock_gettime(sys.CLOCK.REALTIME, &ts);
        return .{ .seconds = @intCast(ts.sec), .micros = @intCast(@divFloor(@as(i64, ts.nsec), 1000)) };
    }

    fn us(i: Instant) i128 {
        return @as(i128, i.seconds) * std.time.us_per_s + i.micros;
    }
};

const Timer = struct { name: []const u8, at: i128, message: []const u8, args: ?*c.talk_value };

const PromptKind = enum { confirm, choose, enter };
const Prompt = struct {
    kind: PromptKind,
    message: []const u8 = "",
    items: []const []const u8 = &.{},
    multiple: bool = false,
    fallback: []const u8 = "",
};

/// A call waiting for a line of standard input.
const Waiter = struct { call: ?*c.talk_call, run: []const u8, prompt: ?Prompt = null };

/// The signal the handler last saw goes through this pipe to the loop.
var signal_pipe: [2]posix.fd_t = .{ -1, -1 };

fn onSignal(sig: posix.SIG) callconv(.c) void {
    const byte: u8 = @intCast(@backingInt(sig));
    _ = sys.write(signal_pipe[1], @ptrCast(&byte), 1);
}

fn writeAll(fd: posix.fd_t, bytes: []const u8) void {
    var rest = bytes;
    while (rest.len > 0) {
        const n = sys.write(fd, rest.ptr, rest.len);
        if (n <= 0) {
            if (n < 0 and sys.errno(n) == .AGAIN) {
                var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.OUT, .revents = 0 }};
                _ = posix.poll(&fds, 100) catch return;
                continue;
            }
            return;
        }
        rest = rest[@intCast(n)..];
    }
}

/// A line to standard output or standard error.
fn line(fd: posix.fd_t, comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    w.print(fmt ++ "\n", args) catch {
        // Too long for the buffer: write it in pieces.
        var heap: std.Io.Writer.Allocating = .init(std.heap.page_allocator);
        defer heap.deinit();
        heap.writer.print(fmt ++ "\n", args) catch return;
        writeAll(fd, heap.written());
        return;
    };
    writeAll(fd, w.buffered());
}

const stdout = 1;
const stderr = 2;

pub const Runner = struct {
    gpa: Allocator,
    arena: std.heap.ArenaAllocator,
    options: Options,
    /// The Script's name: the file's basename without its extension.
    name: []const u8,
    tty: bool,
    core: *c.talk_core,
    group: ?*c.talk_group = null,
    script: ?*c.talk_script = null,
    http: *Router,
    notify: *c.talk_router,
    stores: Stores,
    /// Whether a Host Input waits for a Pump.
    dirty: bool = false,
    admitted: bool = false,
    failed: bool = false,
    next_deadline: ?Instant = null,
    timers: std.ArrayList(Timer) = .empty,
    waiting: std.ArrayList(Waiter) = .empty,
    buffered: std.ArrayList([]const u8) = .empty,
    partial: std.ArrayList(u8) = .empty,
    stdin_ended: bool = false,
    /// Runs to cancel once the Pump returns: a read after standard input
    /// ended.
    cancels: std.ArrayList([]const u8) = .empty,
    /// Answers for calls started in the Pump, given once it returns.
    later: std.ArrayList(struct { call: ?*c.talk_call, value: *c.talk_value }) = .empty,
    /// The first signal's exit code, and when draining ends.
    signalled: ?u8 = null,
    drain_until: i64 = 0,

    fn a(r: *Runner) Allocator {
        return r.arena.allocator();
    }

    // ------------------------------------------------------------ the store router's Host side

    fn admittedHook(context: ?*anyopaque, g: ?*c.talk_group) callconv(.c) void {
        _ = g;
        const r: *Runner = @ptrCast(@alignCast(context.?));
        r.admitted = true;
    }

    fn watchLimits(context: ?*anyopaque, name: [*c]const u8, len: usize) callconv(.c) c.talk_watch_limits {
        _ = context;
        _ = name;
        _ = len;
        return .{ .watches = 100, .watch_size = 65_536, .pending = 1_000, .pending_size = 1_048_576 };
    }

    fn revisionOf(context: ?*anyopaque, name: [*c]const u8, len: usize, out: [*c][*c]const u8, out_len: [*c]usize) callconv(.c) void {
        const r: *Runner = @ptrCast(@alignCast(context.?));
        const text = r.stores.named(name[0..len]).revision_text;
        out.* = text.ptr;
        out_len.* = text.len;
    }

    fn storeOf(context: ?*anyopaque, binding: ?*anyopaque, out: [*c][*c]const u8, out_len: [*c]usize) callconv(.c) bool {
        _ = context;
        const name: []const u8 = if (binding) |b| std.mem.span(@as([*:0]const u8, @ptrCast(b))) else "default";
        out.* = name.ptr;
        out_len.* = name.len;
        return true;
    }

    fn logHttp(context: *anyopaque, text: []const u8) void {
        _ = context;
        line(stderr, "{s}", .{text});
    }

    // ------------------------------------------------------------ console, timer and user

    fn callText(f: *const fn (?*const c.talk_call, [*c][*c]const u8, [*c]usize) callconv(.c) void, call: ?*c.talk_call) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        f(call, &p, &n);
        return if (n == 0) "" else p[0..n];
    }

    fn textOf(v: ?*const c.talk_value) ?[]const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(v, &p, &n)) return null;
        return if (n == 0) "" else p[0..n];
    }

    /// A value as `say` shows it: a text as itself, anything else in its
    /// display form.
    fn show(r: *Runner, v: ?*const c.talk_value) []const u8 {
        if (textOf(v)) |t| return t;
        var buf: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_value_string(v, &buf) != c.TALK_OK) return "";
        defer c.talk_owned_bytes_release(&buf);
        return r.a().dupe(u8, buf.data[0..buf.len]) catch "";
    }

    fn consoleWrite(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = context;
        _ = call;
        _ = err;
        if (len >= 1) {
            if (textOf(args[0])) |t| line(stdout, "{s}", .{t}) else {
                var buf: c.talk_owned_bytes = .{ .data = null, .len = 0 };
                if (c.talk_value_string(args[0], &buf) == c.TALK_OK) {
                    defer c.talk_owned_bytes_release(&buf);
                    line(stdout, "{s}", .{buf.data[0..buf.len]});
                }
            }
        }
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn consoleRead(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = args;
        _ = len;
        _ = err;
        const r: *Runner = @ptrCast(@alignCast(context.?));
        _ = result;
        if (r.buffered.items.len > 0) {
            const l = r.buffered.orderedRemove(0);
            var v: ?*c.talk_value = null;
            if (c.talk_text(l.ptr, l.len, &v) != c.TALK_OK) return c.TALK_CALL_BROKEN;
            return r.answerLater(call, v.?);
        }
        return r.wait(call, null);
    }

    /// A call that waits for a line; one after standard input ended has its
    /// Run cancelled once the Pump returns.
    fn wait(r: *Runner, call: ?*c.talk_call, prompt: ?Prompt) c.talk_call_end {
        const run_id = r.a().dupe(u8, callText(c.talk_call_run_id, call)) catch return c.TALK_CALL_BROKEN;
        if (r.stdin_ended) {
            r.cancels.append(r.a(), run_id) catch return c.TALK_CALL_BROKEN;
            return c.TALK_CALL_STARTED;
        }
        r.waiting.append(r.a(), .{ .call = call, .run = run_id, .prompt = prompt }) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_STARTED;
    }

    fn timerSchedule(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = call;
        _ = err;
        const r: *Runner = @ptrCast(@alignCast(context.?));
        if (len < 4) return c.TALK_CALL_BROKEN;
        const name = textOf(args[0]) orelse return c.TALK_CALL_BROKEN;
        var at: Instant = undefined;
        if (!c.talk_value_as_instant(args[1], &at.seconds, &at.micros)) return c.TALK_CALL_BROKEN;
        const message = textOf(args[2]) orelse return c.TALK_CALL_BROKEN;
        r.cancelTimer(name);
        c.talk_value_retain(args[3]);
        r.timers.append(r.gpa, .{ .name = r.gpa.dupe(u8, name) catch return c.TALK_CALL_BROKEN, .at = at.us(), .message = r.gpa.dupe(u8, message) catch return c.TALK_CALL_BROKEN, .args = args[3] }) catch return c.TALK_CALL_BROKEN;
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn timerCancel(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = call;
        _ = err;
        const r: *Runner = @ptrCast(@alignCast(context.?));
        if (len >= 1) if (textOf(args[0])) |name| r.cancelTimer(name);
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn freeTimer(r: *Runner, t: Timer) void {
        r.gpa.free(t.name);
        r.gpa.free(t.message);
        if (t.args) |x| c.talk_value_release(x);
    }

    fn cancelTimer(r: *Runner, name: []const u8) void {
        for (r.timers.items, 0..) |t, i| if (std.mem.eql(u8, t.name, name)) {
            r.freeTimer(r.timers.orderedRemove(i));
            return;
        };
    }

    /// Delivers each due timer's message, in deadline order.
    fn fireTimers(r: *Runner) void {
        const now = Instant.now().us();
        while (true) {
            var due: ?usize = null;
            for (r.timers.items, 0..) |t, i| if (t.at <= now and (due == null or t.at < r.timers.items[due.?].at)) {
                due = i;
            };
            const i = due orelse return;
            const t = r.timers.orderedRemove(i);
            defer r.freeTimer(t);
            var values: std.ArrayList(?*c.talk_value) = .empty;
            defer {
                for (values.items) |v| c.talk_value_release(v);
                values.deinit(r.gpa);
            }
            const n = c.talk_value_len(t.args);
            for (0..n) |k| {
                var v: ?*c.talk_value = null;
                if (c.talk_value_index(t.args, k + 1, &v) == c.TALK_OK) values.append(r.gpa, v) catch {};
            }
            const m: c.talk_message = .{ .name = t.message.ptr, .name_len = t.message.len, .args = values.items.ptr, .args_len = values.items.len, .limits = null };
            _ = c.talk_script_deliver(r.script, &m, null);
            r.dirty = true;
        }
    }

    fn userBusy(r: *const Runner) bool {
        for (r.waiting.items) |w| if (w.prompt != null) return true;
        return false;
    }

    /// A suspending call answered from what is already here: a Host
    /// function's own answer to one is not taken, so it waits until the
    /// Pump returns. Takes `v`.
    fn answerLater(r: *Runner, call: ?*c.talk_call, v: *c.talk_value) c.talk_call_end {
        r.later.append(r.a(), .{ .call = call, .value = v }) catch {
            c.talk_value_release(v);
            return c.TALK_CALL_BROKEN;
        };
        return c.TALK_CALL_STARTED;
    }

    fn answerStarted(r: *Runner) void {
        for (r.later.items) |x| {
            _ = c.talk_call_answer(x.call, x.value);
            c.talk_value_release(x.value);
            r.dirty = true;
        }
        r.later.clearRetainingCapacity();
        r.http.answerStarted();
    }

    fn userAsk(r: *Runner, call: ?*c.talk_call, p: Prompt, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        _ = result;
        if (r.userBusy()) {
            const code = "user busy";
            const message = "Another prompt is waiting for an answer";
            err.* = .{ .code = code, .code_len = code.len, .message = message, .message_len = message.len, .data = null };
            return c.TALK_CALL_FAILED;
        }
        r.showPrompt(p);
        while (r.buffered.items.len > 0) {
            const l = r.buffered.orderedRemove(0);
            if (r.promptAnswer(p, l)) |v| return r.answerLater(call, v);
            r.showPrompt(p);
        }
        return r.wait(call, p);
    }

    fn userConfirm(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const r: *Runner = @ptrCast(@alignCast(context.?));
        const message = if (len >= 1) r.a().dupe(u8, r.show(args[0])) catch "" else "";
        return r.userAsk(call, .{ .kind = .confirm, .message = message }, result, err);
    }

    fn userEnter(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const r: *Runner = @ptrCast(@alignCast(context.?));
        const message = if (len >= 1) r.a().dupe(u8, r.show(args[0])) catch "" else "";
        const fallback = if (len >= 2) r.a().dupe(u8, r.show(args[1])) catch "" else "";
        return r.userAsk(call, .{ .kind = .enter, .message = message, .fallback = fallback }, result, err);
    }

    fn userChoose(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const r: *Runner = @ptrCast(@alignCast(context.?));
        var items: std.ArrayList([]const u8) = .empty;
        if (len >= 1) for (0..c.talk_value_len(args[0])) |k| {
            var v: ?*c.talk_value = null;
            if (c.talk_value_index(args[0], k + 1, &v) != c.TALK_OK) continue;
            defer c.talk_value_release(v);
            items.append(r.a(), r.a().dupe(u8, r.show(v)) catch "") catch {};
        };
        const prompt = if (len >= 2) r.a().dupe(u8, r.show(args[1])) catch "" else "";
        var multiple = false;
        if (len >= 3) _ = c.talk_value_as_bool(args[2], &multiple);
        return r.userAsk(call, .{ .kind = .choose, .items = items.items, .message = prompt, .multiple = multiple }, result, err);
    }

    fn userNotify(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = call;
        _ = err;
        const r: *Runner = @ptrCast(@alignCast(context.?));
        const message = if (len >= 1) r.show(args[0]) else "";
        const title = if (len >= 2) r.show(args[1]) else "";
        if (title.len > 0) line(stdout, "* {s}: {s}", .{ title, message }) else line(stdout, "* {s}", .{message});
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    /// The lines that ask a prompt's question, as the Go and TS Runners show
    /// them (impl/go/driver/prompts.go).
    fn showPrompt(r: *Runner, p: Prompt) void {
        _ = r;
        switch (p.kind) {
            .confirm => line(stdout, "? {s} [y/N]", .{p.message}),
            .enter => if (p.fallback.len > 0)
                line(stdout, "? {s} [{s}]\n  an empty line gives the default", .{ p.message, p.fallback })
            else
                line(stdout, "? {s}\n  an empty line cancels", .{p.message}),
            .choose => {
                const title = if (p.message.len > 0) p.message else if (p.multiple) "Choose any" else "Choose one";
                line(stdout, "? {s}", .{title});
                for (p.items, 1..) |item, i| line(stdout, "  {d}. {s}", .{ i, item });
                if (p.multiple)
                    line(stdout, "  numbers separated by commas, \"none\" for none, or an empty line to cancel", .{})
                else
                    line(stdout, "  a number, or an empty line to cancel", .{});
            },
        }
    }

    /// The answer a typed line gives, an owned reference, or null when it
    /// answers nothing and the question is asked again.
    fn promptAnswer(r: *Runner, p: Prompt, typed_line: []const u8) ?*c.talk_value {
        const typed = std.mem.trim(u8, typed_line, " \t");
        var v: ?*c.talk_value = null;
        switch (p.kind) {
            .confirm => {
                const yes = std.ascii.eqlIgnoreCase(typed, "y") or std.ascii.eqlIgnoreCase(typed, "yes");
                _ = c.talk_bool(yes, &v);
                return v;
            },
            .enter => {
                if (typed_line.len > 0) {
                    _ = c.talk_text(typed_line.ptr, typed_line.len, &v);
                } else if (p.fallback.len > 0) {
                    _ = c.talk_text(p.fallback.ptr, p.fallback.len, &v);
                } else _ = c.talk_nothing(&v);
                return v;
            },
            .choose => {},
        }
        if (typed.len == 0) {
            _ = c.talk_nothing(&v);
            return v;
        }
        if (p.multiple and std.ascii.eqlIgnoreCase(typed, "none")) {
            _ = c.talk_list(null, 0, &v);
            return v;
        }
        var chosen: std.ArrayList(usize) = .empty;
        var words: usize = 0;
        var it = std.mem.tokenizeAny(u8, typed, " \t,");
        while (it.next()) |word| {
            words += 1;
            const n = std.fmt.parseInt(usize, word, 10) catch return null;
            if (n < 1 or n > p.items.len) return null;
            if (std.mem.indexOfScalar(usize, chosen.items, n) == null) chosen.append(r.a(), n) catch return null;
        }
        if (!p.multiple) {
            if (chosen.items.len != 1 or words != 1) return null;
            const item = p.items[chosen.items[0] - 1];
            _ = c.talk_text(item.ptr, item.len, &v);
            return v;
        }
        std.mem.sort(usize, chosen.items, {}, std.sort.asc(usize));
        var values: std.ArrayList(?*c.talk_value) = .empty;
        defer for (values.items) |x| c.talk_value_release(x);
        for (chosen.items) |n| {
            var t: ?*c.talk_value = null;
            _ = c.talk_text(p.items[n - 1].ptr, p.items[n - 1].len, &t);
            values.append(r.a(), t) catch return null;
        }
        _ = c.talk_list(values.items.ptr, values.items.len, &v);
        return v;
    }

    /// Gives a line of standard input to the first call still waiting.
    fn takeLine(r: *Runner, text: []const u8) void {
        while (r.waiting.items.len > 0) {
            const w = r.waiting.orderedRemove(0);
            if (c.talk_call_context(w.call)) continue; // abandoned
            if (w.prompt) |p| {
                const v = r.promptAnswer(p, text) orelse {
                    r.showPrompt(p);
                    r.waiting.insert(r.a(), 0, w) catch {};
                    return;
                };
                defer c.talk_value_release(v);
                _ = c.talk_call_answer(w.call, v);
            } else {
                var v: ?*c.talk_value = null;
                if (c.talk_text(text.ptr, text.len, &v) != c.TALK_OK) continue;
                defer c.talk_value_release(v);
                _ = c.talk_call_answer(w.call, v);
            }
            r.dirty = true;
            return;
        }
        r.buffered.append(r.a(), r.a().dupe(u8, text) catch return) catch {};
    }

    fn readStdin(r: *Runner) void {
        var buf: [4096]u8 = undefined;
        const n = sys.read(0, &buf, buf.len);
        if (n < 0) {
            if (sys.errno(n) == .AGAIN or sys.errno(n) == .INTR) return;
        }
        if (n <= 0) {
            if (r.partial.items.len > 0) {
                const rest = r.a().dupe(u8, r.partial.items) catch "";
                r.partial.clearRetainingCapacity();
                r.takeLine(std.mem.trimEnd(u8, rest, "\r"));
            }
            r.stdin_ended = true;
            // Each Run still waiting is cancelled.
            for (r.waiting.items) |w| {
                if (!c.talk_call_context(w.call)) r.cancels.append(r.a(), w.run) catch {};
            }
            r.waiting.clearRetainingCapacity();
            r.cancelWaiting();
            return;
        }
        r.partial.appendSlice(r.gpa, buf[0..@intCast(n)]) catch return;
        while (std.mem.indexOfScalar(u8, r.partial.items, '\n')) |eol| {
            const text = r.a().dupe(u8, std.mem.trimEnd(u8, r.partial.items[0..eol], "\r")) catch return;
            std.mem.copyForwards(u8, r.partial.items, r.partial.items[eol + 1 ..]);
            r.partial.shrinkRetainingCapacity(r.partial.items.len - eol - 1);
            r.takeLine(text);
        }
    }

    fn cancelWaiting(r: *Runner) void {
        for (r.cancels.items) |id| {
            _ = c.talk_script_cancel_run(r.script, id.ptr, id.len);
            r.dirty = true;
        }
        r.cancels.clearRetainingCapacity();
    }

    // ------------------------------------------------------------ loading

    fn grantOf(r: *Runner, def: ?*c.talk_capability_def) !*c.talk_grant {
        _ = r;
        var grant: ?*c.talk_grant = null;
        if (c.talk_capability_def_grant_all(def, null, &grant) != c.TALK_OK) return error.HostError;
        return grant.?;
    }

    fn free(comptime names: []const []const u8) [names.len]c.talk_named_cost {
        var out: [names.len]c.talk_named_cost = undefined;
        for (names, &out) |n, *o| o.* = .{ .name = n.ptr, .name_len = n.len, .cost = .{ .fuel = 0, .alloc = 0 } };
        return out;
    }

    /// The Grants, each Standard Capability the Runner offers under its own
    /// name.
    fn grants(r: *Runner) ![]const c.talk_load_grant {
        var out: std.ArrayList(c.talk_load_grant) = .empty;
        var def: ?*c.talk_capability_def = null;

        const console_costs = free(&.{ "write", "read" });
        const console: c.talk_console_impl = .{ .context = r, .write = consoleWrite, .read = consoleRead };
        if (c.talk_console_capability(r.core, &console, &.{ .entries = &console_costs, .len = console_costs.len }, &def) != c.TALK_OK) return error.HostError;
        try out.append(r.a(), .{ .name = "console", .name_len = 7, .grant = try r.grantOf(def) });

        const clock_costs = free(&.{"now"});
        if (c.talk_clock_capability(r.core, &.{ .entries = &clock_costs, .len = clock_costs.len }, &def) != c.TALK_OK) return error.HostError;
        try out.append(r.a(), .{ .name = "clock", .name_len = 5, .grant = try r.grantOf(def) });

        const timer_costs = free(&.{ "schedule", "cancel" });
        const timer: c.talk_timer_impl = .{ .context = r, .schedule = timerSchedule, .cancel = timerCancel };
        if (c.talk_timer_capability(r.core, &timer, &.{ .entries = &timer_costs, .len = timer_costs.len }, &def) != c.TALK_OK) return error.HostError;
        try out.append(r.a(), .{ .name = "timer", .name_len = 5, .grant = try r.grantOf(def) });

        try out.append(r.a(), .{ .name = "store", .name_len = 5, .grant = try r.grantOf(try r.stores.capability(r.core)) });
        try out.append(r.a(), .{ .name = "http", .name_len = 4, .grant = try r.grantOf(try r.http.capability(r.core)) });

        if (r.tty) {
            const user_costs = free(&.{ "confirm", "choose", "enter", "notify" });
            const user: c.talk_user_impl = .{ .context = r, .confirm = userConfirm, .choose = userChoose, .enter = userEnter, .notify = userNotify };
            if (c.talk_user_capability(r.core, &user, &.{ .entries = &user_costs, .len = user_costs.len }, &def) != c.TALK_OK) return error.HostError;
            try out.append(r.a(), .{ .name = "user", .name_len = 4, .grant = try r.grantOf(def) });
        }
        return out.items;
    }

    fn loadOptions(r: *Runner, source: []const u8, loaded: []const c.talk_load_grant) c.talk_load_options {
        return .{ .name = r.name.ptr, .name_len = r.name.len, .source = source.ptr, .source_len = source.len, .grants = loaded.ptr, .grants_len = loaded.len, .grants_as_used = true, .owner = null, .objects = null, .objects_len = 0, .limits = null };
    }

    const Diagnostics = struct { lines: std.ArrayList([]const u8) = .empty, a: Allocator };

    fn diagSink(context: ?*anyopaque, text: [*c]const u8, len: usize) callconv(.c) void {
        const d: *Diagnostics = @ptrCast(@alignCast(context.?));
        const record = text[0..len];
        if (!std.mem.startsWith(u8, record, "diag ")) return;
        d.lines.append(d.a, d.a.dupe(u8, record) catch return) catch {};
    }

    /// Prints a refused load's diagnostics, `file:line:col: code`, from the
    /// `diag` records of a second load into a Group that keeps its Trace:
    /// talk.h gives a Script's diagnostics only there.
    fn printDiagnostics(r: *Runner, source: []const u8, loaded: []const c.talk_load_grant) void {
        var d: Diagnostics = .{ .a = r.a() };
        const options: c.talk_group_options = .{ .name = "diagnostics", .name_len = 11, .trace = diagSink, .trace_context = &d, .allocator = null, .memory_cap = 0, .seed = 0 };
        var group: ?*c.talk_group = null;
        if (c.talk_new_group(r.core, &options, &group) == c.TALK_OK) {
            defer c.talk_group_release(group);
            const load = r.loadOptions(source, loaded);
            var script: ?*c.talk_script = null;
            _ = c.talk_load(group, &load, &script);
        }
        if (d.lines.items.len == 0) {
            line(stderr, "{s}: load refused", .{r.options.file});
            return;
        }
        for (d.lines.items) |record| {
            const code = std.mem.trim(u8, fieldOf(record, "code") orelse "", "\"");
            const pos = fieldOf(record, "pos") orelse "0:0";
            line(stderr, "{s}:{s}: {s}", .{ r.options.file, pos, code });
        }
    }

    fn fieldOf(record: []const u8, key: []const u8) ?[]const u8 {
        var it = std.mem.splitScalar(u8, record, ' ');
        var rest_start: usize = 0;
        while (it.next()) |part| : (rest_start += part.len + 1) {
            if (part.len > key.len and std.mem.startsWith(u8, part, key) and part[key.len] == '=') {
                const start = rest_start + key.len + 1;
                if (record[start] == '"') {
                    const end = std.mem.indexOfScalarPos(u8, record, start + 1, '"') orelse record.len - 1;
                    return record[start .. end + 1];
                }
                return part[key.len + 1 ..];
            }
        }
        return null;
    }

    // ------------------------------------------------------------ reports

    /// Writes a Run that ended with an uncaught error, or a Host mistake, to
    /// standard error. True when the exit code is to be 1.
    fn reportProblem(r: *Runner, report: *const c.talk_report) bool {
        const file = r.options.file;
        switch (report.kind) {
            c.TALK_REPORT_RUN_END => {
                const x = report.as.run_end;
                var where_buf: [512]u8 = undefined;
                const unit = x.at.unit[0..x.at.unit_len];
                const where = if (std.mem.eql(u8, unit, r.name) and x.at.line > 0)
                    std.fmt.bufPrint(&where_buf, "{s}:{d}:{d}: ", .{ file, x.at.line, x.at.col }) catch ""
                else
                    std.fmt.bufPrint(&where_buf, "{s}: ", .{file}) catch "";
                var handler_buf: [256]u8 = undefined;
                const handler = if (x.handler_len > 0) std.fmt.bufPrint(&handler_buf, " in {s}", .{x.handler[0..@min(x.handler_len, 200)]}) catch "" else "";
                if (x.outcome == c.TALK_ERRORED and x.@"error" != null) {
                    const e = x.@"error".*;
                    const message = if (e.message != null and e.message_len > 0) e.message[0..e.message_len] else "";
                    line(stderr, "{s}uncaught error{s}: {s}{s}{s}{s}", .{ where, handler, e.code[0..e.code_len], if (message.len > 0) ": " else "", message, r.errorFields(e.data) });
                    return true;
                }
                if (x.outcome == c.TALK_LIMIT_FAULT or x.outcome == c.TALK_EFFECT_FAILURE_OUTCOME) {
                    const outcome = if (x.outcome == c.TALK_LIMIT_FAULT) "limit fault" else "effect failed";
                    if (x.limit_len > 0)
                        line(stderr, "{s}{s}{s} ({s})", .{ where, outcome, handler, x.limit[0..x.limit_len] })
                    else
                        line(stderr, "{s}{s}{s}", .{ where, outcome, handler });
                    return true;
                }
            },
            c.TALK_REPORT_HOST_ERROR => {
                const x = report.as.host_error;
                line(stderr, "{s}: host error: {s}", .{ file, if (x.detail_len > 0) x.detail[0..x.detail_len] else "" });
                return true;
            },
            c.TALK_REPORT_CALL_FAILED => {
                const x = report.as.call_failed;
                line(stderr, "{s}: call failed: {s}", .{ file, if (x.detail_len > 0) x.detail[0..x.detail_len] else "" });
                return true;
            },
            else => {},
        }
        return false;
    }

    /// An error map's other fields, ` {…}`, without `at`, `code` and
    /// `message`, or "" when it has none.
    fn errorFields(r: *Runner, data: ?*c.talk_value) []const u8 {
        if (data == null or c.talk_value_kind(data) != c.TALK_KIND_MAP) return "";
        var kept: std.ArrayList(c.talk_pair) = .empty;
        defer for (kept.items) |p| c.talk_value_release(p.value);
        var i: usize = 0;
        var pair: c.talk_pair = undefined;
        while (c.talk_value_entries(data, i, &pair)) : (i += 1) {
            const key = pair.key[0..pair.key_len];
            if (std.mem.eql(u8, key, "at") or std.mem.eql(u8, key, "code") or std.mem.eql(u8, key, "message")) {
                c.talk_value_release(pair.value);
                continue;
            }
            kept.append(r.a(), pair) catch {
                c.talk_value_release(pair.value);
                return "";
            };
        }
        if (kept.items.len == 0) return "";
        var m: ?*c.talk_value = null;
        if (c.talk_map(kept.items.ptr, kept.items.len, &m) != c.TALK_OK) return "";
        defer c.talk_value_release(m);
        var buf: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_value_string(m, &buf) != c.TALK_OK) return "";
        defer c.talk_owned_bytes_release(&buf);
        return std.fmt.allocPrint(r.a(), " {s}", .{buf.data[0..buf.len]}) catch "";
    }

    // ------------------------------------------------------------ the loop

    /// Pumps while Host Inputs wait: a Delivery, an answer, a disposal or a
    /// Store Notification.
    fn pump(r: *Runner) void {
        while (true) {
            r.dirty = false;
            r.http.queued = false;
            r.admitted = false;
            const at = Instant.now();
            var result: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
            const code = c.talk_pump(r.group, at.seconds, at.micros, null, &result);
            defer c.talk_reports_release(result.reports);
            if (code != c.TALK_OK) {
                line(stderr, "{s}: host error: pump refused ({d})", .{ r.options.file, code });
                r.failed = true;
                r.next_deadline = null;
                return;
            }
            var items: [*c]const c.talk_report = null;
            const n = c.talk_reports_items(result.reports, &items);
            const reports = if (n == 0) &[_]c.talk_report{} else items[0..n];
            r.http.pumped(reports);
            _ = c.talk_router_pumped(r.notify, r.group);
            for (reports) |*report| if (r.reportProblem(report)) {
                r.failed = true;
            };
            r.next_deadline = if (result.has_next_deadline) .{ .seconds = result.next_deadline_seconds, .micros = result.next_deadline_micros } else null;
            r.cancelWaiting();
            r.answerStarted();
            if (!(r.dirty or r.http.queued or r.admitted or result.state == c.TALK_SLICED)) return;
        }
    }

    /// Nothing can happen again: no live Runs or queued messages, no timers,
    /// Serve Registrations or open HTTP Exchanges. A pending `console.read`
    /// or `user` prompt keeps its Run alive.
    fn done(r: *Runner) bool {
        if (r.signalled != null or r.dirty or r.http.queued or r.timers.items.len > 0 or r.http.registrationCount() > 0 or r.http.open > 0) return false;
        var inspection: ?*c.talk_inspection = null;
        if (c.talk_inspect(r.group, &inspection) != c.TALK_OK) return false;
        defer c.talk_inspection_release(inspection);
        const scripts = inspection.?.scripts[0..inspection.?.scripts_len];
        for (scripts) |s| if (s.runs_len > 0 or s.mailbox_len > 0) return false;
        return true;
    }

    fn signalCode(sig: u8) u8 {
        return switch (sig) {
            @backingInt(posix.SIG.INT) => 130,
            @backingInt(posix.SIG.TERM) => 143,
            else => 1,
        };
    }

    /// The first signal stops accepting, Delivers `stop` and starts the
    /// drain; a second exits at once.
    fn signal(r: *Runner, sig: u8) void {
        if (r.signalled) |code| {
            r.http.flush(100);
            std.process.exit(code);
        }
        r.signalled = signalCode(sig);
        r.http.stopAccepting();
        // A Script without a `stop` Handler ends that Run `unhandled`.
        const m: c.talk_message = .{ .name = "stop", .name_len = 4, .args = null, .args_len = 0, .limits = null };
        _ = c.talk_script_deliver(r.script, &m, null);
        r.dirty = true;
        r.drain_until = router_mod.milliTimestamp() + drain_ms;
    }

    /// Milliseconds until the loop next has something to do, or -1.
    fn timeout(r: *Runner) i32 {
        var until: ?i128 = null;
        if (r.next_deadline) |d| until = d.us();
        for (r.timers.items) |t| until = if (until) |u| @min(u, t.at) else t.at;
        var ms: ?i64 = null;
        if (until) |u| ms = @intCast(@max(0, @divFloor(u - Instant.now().us() + 999, 1000)));
        if (r.signalled != null) {
            const left = @max(0, r.drain_until - router_mod.milliTimestamp());
            ms = if (ms) |m| @min(m, left) else left;
        }
        const m = ms orelse return -1;
        return @intCast(@min(m, std.math.maxInt(i32)));
    }

    fn loop(r: *Runner) u8 {
        var fds: std.ArrayList(posix.pollfd) = .empty;
        defer fds.deinit(r.gpa);
        while (true) {
            if (r.dirty or r.http.queued) r.pump();
            if (r.signalled) |code| {
                if (!r.dirty and (r.http.open == 0 or router_mod.milliTimestamp() >= r.drain_until)) {
                    r.http.answerAll(503);
                    return code;
                }
            } else if (r.done()) return if (r.failed) 1 else 0;

            fds.clearRetainingCapacity();
            fds.append(r.gpa, .{ .fd = signal_pipe[0], .events = posix.POLL.IN, .revents = 0 }) catch return 1;
            const stdin_slot = fds.items.len;
            const reading = r.waiting.items.len > 0 and !r.stdin_ended;
            if (reading) fds.append(r.gpa, .{ .fd = 0, .events = posix.POLL.IN, .revents = 0 }) catch return 1;
            const http_slot = fds.items.len;
            r.http.collect(&fds) catch return 1;
            _ = posix.poll(fds.items, r.timeout()) catch return 1;

            if (fds.items[0].revents != 0) {
                var buf: [16]u8 = undefined;
                const n = sys.read(signal_pipe[0], &buf, buf.len);
                if (n > 0) for (buf[0..@intCast(n)]) |sig| r.signal(sig);
            }
            if (reading and fds.items[stdin_slot].revents != 0) r.readStdin();
            r.http.ready(fds.items[http_slot..]);
            if (r.http.queued) r.dirty = true;
            r.fireTimers();
            if (r.next_deadline) |d| if (d.us() <= Instant.now().us()) {
                r.dirty = true;
            };
        }
    }

    fn deinit(r: *Runner) void {
        r.http.flush(1000);
        for (r.timers.items) |t| r.freeTimer(t);
        r.timers.deinit(r.gpa);
        r.partial.deinit(r.gpa);
        if (r.group) |g| {
            c.talk_router_detach(r.notify, g);
            c.talk_group_release(g);
        }
        r.http.deinit();
        c.talk_router_free(r.notify);
        r.stores.deinit();
        c.talk_core_release(r.core);
        r.arena.deinit();
    }
};

/// The file's basename without its extension, or `main`.
pub fn scriptName(file: []const u8) []const u8 {
    const base = std.fs.path.basename(file);
    const name = base[0 .. std.mem.lastIndexOfScalar(u8, base, '.') orelse base.len];
    return if (name.len > 0) name else "main";
}

fn installSignals() !void {
    if (sys.pipe(&signal_pipe) != 0) return error.SystemResources;
    for (signal_pipe) |fd| {
        const flags = sys.fcntl(fd, sys.F.GETFL);
        _ = sys.fcntl(fd, sys.F.SETFL, flags | @as(c_int, 1 << @bitOffsetOf(sys.O, "NONBLOCK")));
    }
    const act: posix.Sigaction = .{ .handler = .{ .handler = onSignal }, .mask = posix.sigemptyset(), .flags = 0 };
    posix.sigaction(.INT, &act, null);
    posix.sigaction(.TERM, &act, null);
    // A client that goes away mid-answer is a failed write, not an exit.
    const ignore: posix.Sigaction = .{ .handler = .{ .handler = posix.SIG.IGN }, .mask = posix.sigemptyset(), .flags = 0 };
    posix.sigaction(.PIPE, &ignore, null);
}

/// Runs the file, and returns the exit code.
pub fn run(gpa: Allocator, io: std.Io, options: Options) u8 {
    const source = std.Io.Dir.cwd().readFileAlloc(io, options.file, gpa, .limited(64 * 1024 * 1024)) catch |e| {
        line(stderr, "{s}: {s}", .{ options.file, if (e == error.FileNotFound) "no such file" else @errorName(e) });
        return 2;
    };
    defer gpa.free(source);
    installSignals() catch {
        line(stderr, "{s}: can't install signal handlers", .{options.file});
        return 1;
    };

    var r: Runner = undefined;
    r = .{
        .gpa = gpa,
        .arena = .init(gpa),
        .options = options,
        .name = scriptName(options.file),
        .tty = sys.isatty(0) == 1,
        .core = c.talk_new() orelse return 1,
        .http = undefined,
        .notify = undefined,
        .stores = undefined,
    };
    const notify_options: c.talk_router_options = .{ .context = &r, .admitted = Runner.admittedHook, .limits = Runner.watchLimits, .revision = Runner.revisionOf, .store_of = Runner.storeOf };
    r.notify = c.talk_router_new(&notify_options) orelse return 1;
    r.stores = .init(gpa, r.notify);
    r.http = Router.init(gpa, r.core, .{ .port_override = options.port, .log = Runner.logHttp, .log_context = &r }) catch return 1;
    defer r.deinit();

    var seed: [8]u8 = undefined;
    io.random(&seed);
    const group_options: c.talk_group_options = .{ .name = "main", .name_len = 4, .trace = null, .trace_context = null, .allocator = null, .memory_cap = 0, .seed = std.mem.readInt(u64, &seed, .little) };
    var group: ?*c.talk_group = null;
    if (c.talk_new_group(r.core, &group_options, &group) != c.TALK_OK) return 1;
    r.group = group;
    r.http.group = group;

    const loaded = r.grants() catch {
        line(stderr, "{s}: can't grant the Standard Capabilities", .{options.file});
        return 1;
    };
    const load = r.loadOptions(source, loaded);
    var script: ?*c.talk_script = null;
    const code = c.talk_load(group, &load, &script);
    if (code == c.TALK_LOAD_REFUSED) {
        r.printDiagnostics(source, loaded);
        return 1;
    }
    if (code != c.TALK_OK) {
        line(stderr, "{s}: load refused ({d})", .{ options.file, code });
        return 1;
    }
    r.script = script;

    var values: std.ArrayList(?*c.talk_value) = .empty;
    defer {
        for (values.items) |v| c.talk_value_release(v);
        values.deinit(gpa);
    }
    for (options.args) |arg| {
        var v: ?*c.talk_value = null;
        if (c.talk_text(arg.ptr, arg.len, &v) != c.TALK_OK) {
            line(stderr, "{s}: an argument isn't UTF-8", .{options.file});
            return 2;
        }
        values.append(gpa, v) catch return 1;
    }
    var list: ?*c.talk_value = null;
    if (c.talk_list(values.items.ptr, values.items.len, &list) != c.TALK_OK) return 1;
    defer c.talk_value_release(list);
    const args = [_]?*c.talk_value{list};
    const start: c.talk_message = .{ .name = "start", .name_len = 5, .args = &args, .args_len = 1, .limits = null };
    if (c.talk_script_deliver(script, &start, null) != c.TALK_OK) {
        line(stderr, "{s}: start was refused", .{options.file});
        return 1;
    }
    r.dirty = true;
    return r.loop();
}

test "a Script's name is its file's basename without the extension" {
    try std.testing.expectEqualStrings("hello", scriptName("examples/http/hello.talk"));
    try std.testing.expectEqualStrings("app", scriptName("app"));
    try std.testing.expectEqualStrings("main", scriptName("dir/.talk"));
}

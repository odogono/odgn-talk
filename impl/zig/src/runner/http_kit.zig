//! Drives the native router through the http test kit, corpus/http-kit/: a
//! Script served through real sockets on 127.0.0.1, with the answers
//! chapter 7 and chapter 9's HTTP router require, as
//! impl/go/httphost/kit_test.go and impl/ts/tools/http-kit.ts do. The
//! router polls on this thread; each request is made from another.
//! `zig build http-kit` runs it; so does `zig build test`.
const std = @import("std");
const c = @import("talk-c");
const runner = @import("runner");
/// The Core, whose talk.h exports this links.
const northtalk = @import("northtalk");

comptime {
    _ = northtalk;
}

const sys = std.c;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const Router = runner.router.Router;

// ------------------------------------------------------------ the TOML the kit uses

/// A TOML value: the kit's files use strings, integers, arrays and inline
/// tables, with `'''` literals for scripts.
const Value = union(enum) {
    string: []const u8,
    int: i64,
    array: []const Value,
    table: []const Pair,

    fn get(v: Value, key: []const u8) ?Value {
        if (v != .table) return null;
        for (v.table) |p| if (std.mem.eql(u8, p.key, key)) return p.value;
        return null;
    }

    fn str(v: Value, key: []const u8) ?[]const u8 {
        const x = v.get(key) orelse return null;
        return if (x == .string) x.string else null;
    }
};
const Pair = struct { key: []const u8, value: Value };

const Parser = struct {
    a: Allocator,
    s: []const u8,
    i: usize = 0,

    fn skip(p: *Parser) void {
        while (p.i < p.s.len) {
            switch (p.s[p.i]) {
                ' ', '\t', '\r', '\n' => p.i += 1,
                '#' => while (p.i < p.s.len and p.s[p.i] != '\n') {
                    p.i += 1;
                },
                else => return,
            }
        }
    }

    fn peek(p: *Parser) u8 {
        p.skip();
        return if (p.i < p.s.len) p.s[p.i] else 0;
    }

    fn expect(p: *Parser, ch: u8) !void {
        if (p.peek() != ch) return error.BadToml;
        p.i += 1;
    }

    fn key(p: *Parser) ![]const u8 {
        p.skip();
        if (p.i < p.s.len and p.s[p.i] == '"') return (try p.value()).string;
        const start = p.i;
        while (p.i < p.s.len and (std.ascii.isAlphanumeric(p.s[p.i]) or p.s[p.i] == '-' or p.s[p.i] == '_')) p.i += 1;
        if (p.i == start) return error.BadToml;
        return p.s[start..p.i];
    }

    fn value(p: *Parser) anyerror!Value {
        const ch = p.peek();
        if (std.mem.startsWith(u8, p.s[p.i..], "'''")) {
            var start = p.i + 3;
            // A newline right after the opening delimiter is trimmed.
            if (start < p.s.len and p.s[start] == '\n') start += 1;
            const end = std.mem.indexOfPos(u8, p.s, start, "'''") orelse return error.BadToml;
            p.i = end + 3;
            return .{ .string = p.s[start..end] };
        }
        switch (ch) {
            '\'' => {
                const end = std.mem.indexOfScalarPos(u8, p.s, p.i + 1, '\'') orelse return error.BadToml;
                defer p.i = end + 1;
                return .{ .string = p.s[p.i + 1 .. end] };
            },
            '"' => {
                var out: std.ArrayList(u8) = .empty;
                p.i += 1;
                while (p.i < p.s.len and p.s[p.i] != '"') : (p.i += 1) {
                    if (p.s[p.i] != '\\') {
                        try out.append(p.a, p.s[p.i]);
                        continue;
                    }
                    p.i += 1;
                    switch (p.s[p.i]) {
                        'n' => try out.append(p.a, '\n'),
                        't' => try out.append(p.a, '\t'),
                        'r' => try out.append(p.a, '\r'),
                        'u' => {
                            const cp = try std.fmt.parseInt(u21, p.s[p.i + 1 .. p.i + 5], 16);
                            var buf: [4]u8 = undefined;
                            try out.appendSlice(p.a, buf[0..try std.unicode.utf8Encode(cp, &buf)]);
                            p.i += 4;
                        },
                        else => |x| try out.append(p.a, x),
                    }
                }
                p.i += 1;
                return .{ .string = out.items };
            },
            '[' => {
                p.i += 1;
                var items: std.ArrayList(Value) = .empty;
                while (p.peek() != ']') {
                    try items.append(p.a, try p.value());
                    if (p.peek() == ',') p.i += 1;
                }
                p.i += 1;
                return .{ .array = items.items };
            },
            '{' => {
                p.i += 1;
                var pairs: std.ArrayList(Pair) = .empty;
                while (p.peek() != '}') {
                    const k = try p.key();
                    try p.expect('=');
                    try pairs.append(p.a, .{ .key = k, .value = try p.value() });
                    if (p.peek() == ',') p.i += 1;
                }
                p.i += 1;
                return .{ .table = pairs.items };
            },
            else => {
                const start = p.i;
                while (p.i < p.s.len and (std.ascii.isDigit(p.s[p.i]) or p.s[p.i] == '-' or p.s[p.i] == '_')) p.i += 1;
                return .{ .int = try std.fmt.parseInt(i64, p.s[start..p.i], 10) };
            },
        }
    }

    /// The file's `[[case]]` tables.
    fn cases(p: *Parser) ![]const Value {
        var out: std.ArrayList(Value) = .empty;
        var current: ?std.ArrayList(Pair) = null;
        while (true) {
            p.skip();
            if (p.i >= p.s.len) break;
            if (std.mem.startsWith(u8, p.s[p.i..], "[[case]]")) {
                if (current) |cur| try out.append(p.a, .{ .table = cur.items });
                current = .empty;
                p.i += "[[case]]".len;
                continue;
            }
            const k = try p.key();
            try p.expect('=');
            const v = try p.value();
            if (current) |*cur| try cur.append(p.a, .{ .key = k, .value = v });
        }
        if (current) |cur| try out.append(p.a, .{ .table = cur.items });
        return out.items;
    }
};

// ------------------------------------------------------------ the client, on its own thread

const Answer = struct {
    status: u16 = 0,
    head: []const u8 = "",
    body: []const u8 = "",
    refused: bool = false,
    failed: ?anyerror = null,
};

const Client = struct {
    a: Allocator,
    port: u16,
    step: Value,
    line: []const u8,
    abort: bool,
    answer: Answer = .{},
    done: std.atomic.Value(bool) = .init(false),

    fn run(cl: *Client) void {
        cl.answer = cl.send() catch |e| .{ .failed = e };
        cl.done.store(true, .release);
    }

    fn send(cl: *Client) !Answer {
        const space = std.mem.indexOfScalar(u8, cl.line, ' ') orelse return error.BadStep;
        const method = cl.line[0..space];
        const target = cl.line[space + 1 ..];
        const fd = sys.socket(sys.AF.INET, sys.SOCK.STREAM, 0);
        if (fd < 0) return error.Socket;
        defer _ = sys.close(fd);
        const in: sys.sockaddr.in = .{ .port = std.mem.nativeToBig(u16, cl.port), .addr = @bitCast([4]u8{ 127, 0, 0, 1 }) };
        if (sys.connect(fd, @ptrCast(&in), @sizeOf(sys.sockaddr.in)) != 0) {
            if (sys.errno(@as(c_int, -1)) == .CONNREFUSED) return .{ .refused = true };
            return error.Connect;
        }
        var text: std.ArrayList(u8) = .empty;
        try text.print(cl.a, "{s} {s} HTTP/1.1\r\nHost: 127.0.0.1:{d}\r\nConnection: close\r\n", .{ method, target, cl.port });
        if (cl.step.get("headers")) |hs| for (hs.table) |h| switch (h.value) {
            .string => |s| try text.print(cl.a, "{s}: {s}\r\n", .{ h.key, s }),
            .array => |xs| for (xs) |x| try text.print(cl.a, "{s}: {s}\r\n", .{ h.key, x.string }),
            else => {},
        };
        const body = cl.step.str("body") orelse "";
        if (body.len > 0 or std.mem.eql(u8, method, "POST")) try text.print(cl.a, "Content-Length: {d}\r\n", .{body.len});
        try text.appendSlice(cl.a, "\r\n");
        try text.appendSlice(cl.a, body);
        _ = sys.write(fd, text.items.ptr, text.items.len);
        if (cl.abort) {
            sleepMs(100);
            return .{};
        }
        var got: std.ArrayList(u8) = .empty;
        var buf: [4096]u8 = undefined;
        while (true) {
            const n = sys.read(fd, &buf, buf.len);
            if (n <= 0) break;
            try got.appendSlice(cl.a, buf[0..@intCast(n)]);
        }
        const split = std.mem.indexOf(u8, got.items, "\r\n\r\n") orelse return error.NoAnswer;
        const head = got.items[0..split];
        if (head.len < 12) return error.NoAnswer;
        return .{ .status = try std.fmt.parseInt(u16, head[9..12], 10), .head = head, .body = got.items[split + 4 ..] };
    }
};

fn sleepMs(ms: i64) void {
    const ts: sys.timespec = .{ .sec = @intCast(@divFloor(ms, 1000)), .nsec = @intCast(@mod(ms, 1000) * 1_000_000) };
    _ = sys.nanosleep(&ts, null);
}

/// The values of a response header, any case, joined with `, `; null when
/// absent.
fn headerOf(a: Allocator, head: []const u8, name: []const u8) !?[]const u8 {
    var values: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.splitSequence(u8, head, "\r\n");
    _ = lines.next();
    while (lines.next()) |l| {
        const colon = std.mem.indexOfScalar(u8, l, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(l[0..colon], name)) try values.append(a, std.mem.trim(u8, l[colon + 1 ..], " \t"));
    }
    if (values.items.len == 0) return null;
    return try std.mem.join(a, ", ", values.items);
}

fn check(a: Allocator, step: Value, answer: Answer) !?[]const u8 {
    if (step.get("status")) |want| if (answer.status != want.int)
        return try std.fmt.allocPrint(a, "status {d}, wanted {d} (body {s})", .{ answer.status, want.int, answer.body });
    if (step.str("response")) |want| if (!std.mem.eql(u8, answer.body, want))
        return try std.fmt.allocPrint(a, "body {s}, wanted {s}", .{ answer.body, want });
    if (step.str("responseHex")) |want| {
        const got = try std.fmt.allocPrint(a, "{x}", .{answer.body});
        if (!std.mem.eql(u8, got, want)) return try std.fmt.allocPrint(a, "body {s}, wanted {s}", .{ got, want });
    }
    if (step.str("excludes")) |not| if (std.mem.indexOf(u8, answer.body, not) != null)
        return try std.fmt.allocPrint(a, "body {s} gives away {s}", .{ answer.body, not });
    if (step.str("type")) |want| {
        const got = (try headerOf(a, answer.head, "content-type")) orelse "";
        if (!std.mem.eql(u8, got, want)) return try std.fmt.allocPrint(a, "content-type {s}, wanted {s}", .{ got, want });
    }
    if (step.get("responseHeaders")) |hs| for (hs.table) |h| {
        const got = (try headerOf(a, answer.head, h.key)) orelse "";
        if (!std.mem.eql(u8, got, h.value.string)) return try std.fmt.allocPrint(a, "header {s} {s}, wanted {s}", .{ h.key, got, h.value.string });
    };
    return null;
}

// ------------------------------------------------------------ a case

fn nowMicros() i128 {
    var ts: sys.timespec = undefined;
    _ = sys.clock_gettime(sys.CLOCK.REALTIME, &ts);
    return @as(i128, ts.sec) * 1_000_000 + @divFloor(@as(i128, ts.nsec), 1000);
}

fn discard(context: *anyopaque, text: []const u8) void {
    _ = context;
    _ = text;
}

const Case = struct {
    gpa: Allocator,
    core: *c.talk_core,
    router: *Router,
    group: ?*c.talk_group = null,
    script: ?*c.talk_script = null,
    deadline: ?i128 = null,
    dirty: bool = false,

    fn pump(k: *Case) !void {
        while (true) {
            k.dirty = false;
            k.router.queued = false;
            const now = nowMicros();
            var result: c.talk_pump_result = std.mem.zeroes(c.talk_pump_result);
            if (c.talk_pump(k.group, @intCast(@divFloor(now, 1_000_000)), @intCast(@mod(now, 1_000_000)), null, &result) != c.TALK_OK) return error.PumpRefused;
            defer c.talk_reports_release(result.reports);
            var items: [*c]const c.talk_report = null;
            const n = c.talk_reports_items(result.reports, &items);
            k.router.pumped(if (n == 0) &.{} else items[0..n]);
            k.router.answerStarted();
            k.deadline = if (result.has_next_deadline) @as(i128, result.next_deadline_seconds) * 1_000_000 + result.next_deadline_micros else null;
            if (!k.router.queued and result.state != c.TALK_SLICED) return;
        }
    }

    /// Polls the router's sockets and pumps for up to `ms` milliseconds, or
    /// until `until` says stop.
    fn turn(k: *Case, ms: i64, until: ?*const std.atomic.Value(bool)) !void {
        const end = runner.router.milliTimestamp() + ms;
        var fds: std.ArrayList(posix.pollfd) = .empty;
        defer fds.deinit(k.gpa);
        while (true) {
            if (k.dirty or k.router.queued) try k.pump();
            if (k.deadline) |d| if (d <= nowMicros()) try k.pump();
            if (until) |u| if (u.load(.acquire)) return;
            const left = end - runner.router.milliTimestamp();
            if (left <= 0) return;
            fds.clearRetainingCapacity();
            try k.router.collect(&fds);
            _ = try posix.poll(fds.items, @intCast(@min(left, 10)));
            k.router.ready(fds.items);
        }
    }

    fn request(k: *Case, name: []const u8) !?*c.talk_value {
        const m: c.talk_message = .{ .name = name.ptr, .name_len = name.len, .args = null, .args_len = 0, .limits = null };
        var pending: ?*c.talk_pending = null;
        if (c.talk_script_request(k.script, &m, null, &pending) != c.TALK_OK) return error.RequestRefused;
        defer c.talk_pending_release(pending);
        k.dirty = true;
        const end = runner.router.milliTimestamp() + 10_000;
        while (!c.talk_pending_done(pending)) {
            if (runner.router.milliTimestamp() > end) return error.Timeout;
            try k.turn(10, null);
        }
        var v: ?*c.talk_value = null;
        if (c.talk_pending_result(pending, &v) != c.TALK_OK) return error.NoResult;
        return v;
    }
};

fn runCase(gpa: Allocator, a: Allocator, case: Value) !?[]const u8 {
    const core = c.talk_new() orelse return error.OutOfMemory;
    defer c.talk_core_release(core);
    var max_body: usize = runner.router.default_max_body;
    if (case.get("maxBodyBytes")) |m| max_body = @intCast(m.int);
    var context: u8 = 0;
    const router = try Router.init(gpa, core, .{ .max_body = max_body, .log = discard, .log_context = &context });
    defer router.deinit();
    var k: Case = .{ .gpa = gpa, .core = core, .router = router };
    const options: c.talk_group_options = .{ .name = "kit", .name_len = 3, .trace = null, .trace_context = null, .allocator = null, .memory_cap = 0, .seed = 0 };
    if (c.talk_new_group(core, &options, &k.group) != c.TALK_OK) return error.HostError;
    defer c.talk_group_release(k.group);
    router.group = k.group;
    const def = try router.capability(core);
    var grants: std.ArrayList(c.talk_load_grant) = .empty;
    const names: []const Value = if (case.get("grants")) |g| g.array else &.{.{ .string = "http" }};
    for (names) |n| {
        var grant: ?*c.talk_grant = null;
        if (c.talk_capability_def_grant_all(def, null, &grant) != c.TALK_OK) return error.HostError;
        try grants.append(a, .{ .name = n.string.ptr, .name_len = n.string.len, .grant = grant });
    }
    const source = case.str("script").?;
    const load: c.talk_load_options = .{ .name = "main", .name_len = 4, .source = source.ptr, .source_len = source.len, .grants = grants.items.ptr, .grants_len = grants.items.len, .grants_as_used = false, .owner = null, .objects = null, .objects_len = 0, .limits = null };
    if (c.talk_load(k.group, &load, &k.script) != c.TALK_OK) return "the script didn't load";

    const started = (try k.request("start")) orelse return "start gave nothing";
    defer c.talk_value_release(started);
    var d: ?*const c.talk_decimal = null;
    var port: i64 = 0;
    if (!c.talk_value_as_dec(started, @ptrCast(&d)) or c.talk_decimal_int64(d, &port) != c.TALK_OK) return "start gave no port";

    for (case.get("steps").?.array, 0..) |step, i| {
        const failure: ?[]const u8 = blk: {
            if (step.get("sleep")) |ms| {
                try k.turn(ms.int, null);
                break :blk null;
            }
            if (step.str("send")) |name| {
                if (try k.request(name)) |v| c.talk_value_release(v);
                try k.turn(20, null);
                break :blk null;
            }
            const line = step.str("request") orelse step.str("abort") orelse step.str("refused") orelse break :blk "an unknown step";
            var client: Client = .{ .a = a, .port = @intCast(port), .step = step, .line = line, .abort = step.get("abort") != null };
            const thread = try std.Thread.spawn(.{}, Client.run, .{&client});
            try k.turn(10_000, &client.done);
            thread.join();
            if (client.answer.failed) |e| break :blk try std.fmt.allocPrint(a, "the request failed: {s}", .{@errorName(e)});
            if (step.get("refused") != null) {
                break :blk if (client.answer.refused) null else try std.fmt.allocPrint(a, "answered {d}, wanted refused", .{client.answer.status});
            }
            if (client.answer.refused) break :blk "the connection was refused";
            if (step.get("abort") != null) break :blk null;
            break :blk try check(a, step, client.answer);
        };
        if (failure) |f| return try std.fmt.allocPrint(a, "step {d}: {s}", .{ i, f });
    }
    return null;
}

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const gpa = init.gpa;
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    const root = if (args.len > 1) args[1] else "../../corpus/http-kit";
    var dir = try std.Io.Dir.cwd().openDir(io, root, .{ .iterate = true });
    defer dir.close(io);
    var files: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (try it.next(io)) |entry| if (std.mem.endsWith(u8, entry.name, ".toml")) try files.append(a, try a.dupe(u8, entry.name));
    std.mem.sort([]const u8, files.items, {}, struct {
        fn lt(_: void, x: []const u8, y: []const u8) bool {
            return std.mem.order(u8, x, y) == .lt;
        }
    }.lt);
    var passed: usize = 0;
    var failed: usize = 0;
    for (files.items) |file| {
        const text = try dir.readFileAlloc(io, file, a, .limited(1 << 20));
        var p: Parser = .{ .a = a, .s = text };
        for (try p.cases()) |case| {
            const name = case.str("name") orelse "?";
            if (try runCase(gpa, a, case)) |why| {
                failed += 1;
                std.debug.print("FAIL {s}: {s}: {s}\n", .{ file, name, why });
            } else passed += 1;
        }
    }
    std.debug.print("http kit: {d} passed, {d} failed\n", .{ passed, failed });
    return if (failed == 0 and passed > 0) 0 else 1;
}

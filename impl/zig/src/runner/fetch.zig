//! `http.fetch` for the native Script Runner (chapter 7, Fetching; chapter
//! 12, The Script Runner; ADR 0151). It allows any origin. Each call runs
//! as a concurrent task on the Runner's `std.Io`, with `std.http.Client`:
//! HTTPS verifies the certificate and host name against the system's
//! authorities. The task makes one HTTP/1.1 request on its own connection,
//! follows no redirect, decompresses nothing and keeps no cookies, then
//! wakes the loop through a pipe; the loop answers the call. A call the Core
//! abandons cancels its task.
const std = @import("std");
const c = @import("talk-c");

const sys = std.c;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const http = std.http;

pub const max_body_bytes: usize = 8 * 1024 * 1024;
pub const max_header_bytes: usize = 64 * 1024;

const Header = struct { name: []u8, value: []u8 };

const Outcome = union(enum) {
    pending,
    answer: struct { status: u16, headers: []Header, body: []u8 },
    network_error: []const u8,
    too_large: []const u8,
};

const Job = struct {
    call: ?*c.talk_call,
    url: []u8,
    method: http.Method,
    headers: []http.Header,
    body: ?[]u8,
    accept_encoding: bool,
    user_agent: bool,
    future: std.Io.Future(void) = undefined,
    done: std.atomic.Value(bool) = .init(false),
    outcome: Outcome = .pending,
};

pub const Fetcher = struct {
    gpa: Allocator,
    io: std.Io,
    jobs: std.ArrayList(*Job) = .empty,
    wake: [2]posix.fd_t,

    pub fn init(gpa: Allocator, io: std.Io) !Fetcher {
        var fds: [2]posix.fd_t = undefined;
        if (sys.pipe(&fds) != 0) return error.Pipe;
        return .{ .gpa = gpa, .io = io, .wake = fds };
    }

    pub fn deinit(f: *Fetcher) void {
        for (f.jobs.items) |j| {
            j.future.cancel(f.io);
            f.free(j);
        }
        f.jobs.deinit(f.gpa);
        _ = sys.close(f.wake[0]);
        _ = sys.close(f.wake[1]);
    }

    pub fn inFlight(f: *const Fetcher) usize {
        return f.jobs.items.len;
    }

    /// The fd the loop polls while requests are in flight.
    pub fn pollFd(f: *const Fetcher) ?posix.pollfd {
        if (f.jobs.items.len == 0) return null;
        return .{ .fd = f.wake[0], .events = posix.POLL.IN, .revents = 0 };
    }

    pub fn drainWake(f: *Fetcher) void {
        var buf: [64]u8 = undefined;
        _ = sys.read(f.wake[0], &buf, buf.len);
    }

    /// Answers each finished request and cancels each abandoned one. True
    /// when it settled a call, which the next Pump drains.
    pub fn settle(f: *Fetcher) bool {
        var settled = false;
        var i: usize = 0;
        while (i < f.jobs.items.len) {
            const j = f.jobs.items[i];
            if (j.done.load(.acquire)) {
                j.future.await(f.io);
                f.answer(j);
                settled = true;
            } else if (c.talk_call_context(j.call)) {
                // Abandoned: stop the request; nobody waits for the answer.
                j.future.cancel(f.io);
            } else {
                i += 1;
                continue;
            }
            _ = f.jobs.swapRemove(i);
            f.free(j);
        }
        return settled;
    }

    fn free(f: *Fetcher, j: *Job) void {
        const gpa = f.gpa;
        gpa.free(j.url);
        for (j.headers) |h| {
            gpa.free(h.name);
            gpa.free(h.value);
        }
        gpa.free(j.headers);
        if (j.body) |b| gpa.free(b);
        switch (j.outcome) {
            .answer => |x| {
                for (x.headers) |h| {
                    gpa.free(h.name);
                    gpa.free(h.value);
                }
                gpa.free(x.headers);
                gpa.free(x.body);
            },
            else => {},
        }
        gpa.destroy(j);
    }

    fn fail(call: ?*c.talk_call, code: []const u8, message: []const u8, data: ?*c.talk_value) void {
        const e: c.talk_script_error = .{ .code = code.ptr, .code_len = code.len, .message = message.ptr, .message_len = message.len, .data = data };
        _ = c.talk_call_fail(call, &e);
    }

    fn answer(f: *Fetcher, j: *Job) void {
        switch (j.outcome) {
            .pending => fail(j.call, "network error", "the request didn't finish", null),
            .network_error => |why| {
                line("fetch {s}: {s}", .{ j.url, why });
                fail(j.call, "network error", why, null);
            },
            .too_large => |field| {
                const limit = if (std.mem.eql(u8, field, "body")) max_body_bytes else max_header_bytes;
                var name: ?*c.talk_value = null;
                var n: ?*c.talk_value = null;
                _ = c.talk_text(field.ptr, field.len, &name);
                _ = c.talk_uint(limit, &n);
                defer if (name) |v| c.talk_value_release(v);
                defer if (n) |v| c.talk_value_release(v);
                const pairs = [_]c.talk_pair{ c.talk_kv("field", 5, name), c.talk_kv("limit", 5, n) };
                var data: ?*c.talk_value = null;
                _ = c.talk_map(&pairs, pairs.len, &data);
                defer if (data) |v| c.talk_value_release(v);
                fail(j.call, "response too large", "the response is too large", data);
            },
            .answer => |x| {
                const v = response(f.gpa, x.status, x.headers, x.body) catch {
                    fail(j.call, "network error", "a header value isn't UTF-8", null);
                    return;
                };
                defer c.talk_value_release(v);
                _ = c.talk_call_answer(j.call, v);
            },
        }
    }

    /// `fetch`'s Host function: copies the request, then starts its task.
    pub fn start(f: *Fetcher, call: ?*c.talk_call, args: []const ?*c.talk_value) c.talk_call_end {
        if (args.len != 2) return c.TALK_CALL_BROKEN;
        const j = f.job(call, args[0].?, args[1].?) catch return c.TALK_CALL_BROKEN;
        f.jobs.append(f.gpa, j) catch {
            f.free(j);
            return c.TALK_CALL_BROKEN;
        };
        j.future = f.io.concurrent(work, .{ f, j }) catch {
            _ = f.jobs.pop();
            f.free(j);
            fail(call, "network error", "no thread for the request", null);
            return c.TALK_CALL_STARTED;
        };
        return c.TALK_CALL_STARTED;
    }

    fn text(v: ?*c.talk_value) ?[]const u8 {
        var s: [*c]const u8 = null;
        var len: usize = 0;
        if (!c.talk_value_as_text(v, &s, &len)) return null;
        return if (len == 0) "" else s[0..len];
    }

    fn job(f: *Fetcher, call: ?*c.talk_call, url: *c.talk_value, request: *c.talk_value) !*Job {
        const gpa = f.gpa;
        const j = try gpa.create(Job);
        j.* = .{ .call = call, .url = &.{}, .method = .GET, .headers = &.{}, .body = null, .accept_encoding = false, .user_agent = false };
        errdefer f.free(j);
        j.url = try gpa.dupe(u8, text(url) orelse return error.InvalidValue);
        var headers: std.ArrayList(http.Header) = .empty;
        defer {
            for (headers.items) |h| {
                gpa.free(h.name);
                gpa.free(h.value);
            }
            headers.deinit(gpa);
        }
        var i: usize = 0;
        var content_type = false;
        var pair: c.talk_pair = undefined;
        var json: ?[]const u8 = null;
        var text_body = false;
        while (c.talk_value_entries(request, i, &pair)) : (i += 1) {
            defer c.talk_value_release(pair.value);
            const key = pair.key[0..pair.key_len];
            if (std.mem.eql(u8, key, "method")) {
                j.method = std.meta.stringToEnum(http.Method, text(pair.value) orelse return error.InvalidValue) orelse return error.InvalidValue;
            } else if (std.mem.eql(u8, key, "headers")) {
                var k: usize = 0;
                var h: c.talk_pair = undefined;
                while (c.talk_value_entries(pair.value, k, &h)) : (k += 1) {
                    defer c.talk_value_release(h.value);
                    const name = h.key[0..h.key_len];
                    if (std.ascii.eqlIgnoreCase(name, "content-type")) content_type = true;
                    if (std.ascii.eqlIgnoreCase(name, "accept-encoding")) j.accept_encoding = true;
                    if (std.ascii.eqlIgnoreCase(name, "user-agent")) j.user_agent = true;
                    if (text(h.value)) |one| {
                        try headers.append(gpa, .{ .name = try gpa.dupe(u8, name), .value = try gpa.dupe(u8, one) });
                    } else {
                        var n: usize = 1;
                        while (n <= c.talk_value_len(h.value)) : (n += 1) {
                            var item: ?*c.talk_value = null;
                            if (c.talk_value_index(h.value, n, &item) != c.TALK_OK) return error.InvalidValue;
                            defer c.talk_value_release(item);
                            try headers.append(gpa, .{ .name = try gpa.dupe(u8, name), .value = try gpa.dupe(u8, text(item) orelse return error.InvalidValue) });
                        }
                    }
                }
            } else if (std.mem.eql(u8, key, "body")) {
                if (text(pair.value)) |t| {
                    j.body = try gpa.dupe(u8, t);
                    text_body = true;
                } else {
                    var owned: c.talk_owned_bytes = .{ .data = null, .len = 0 };
                    if (c.talk_value_as_bytes(pair.value, &owned) != c.TALK_OK) return error.InvalidValue;
                    defer c.talk_owned_bytes_release(&owned);
                    j.body = try gpa.dupe(u8, if (owned.len == 0) "" else owned.data[0..owned.len]);
                }
            } else if (std.mem.eql(u8, key, "json")) {
                json = text(pair.value);
                j.body = try gpa.dupe(u8, json orelse return error.InvalidValue);
            }
        }
        if (!content_type and (text_body or json != null)) {
            const value = if (json != null) "application/json" else "text/plain; charset=utf-8";
            try headers.append(gpa, .{ .name = try gpa.dupe(u8, "content-type"), .value = try gpa.dupe(u8, value) });
        }
        j.headers = try headers.toOwnedSlice(gpa);
        return j;
    }
};

fn line(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt ++ "\n", args) catch return;
    _ = sys.write(2, s.ptr, s.len);
}

/// Chapter 7's response: lowercase header names in code point order,
/// repeated values joined with ", ", and set-cookie a list.
fn response(gpa: Allocator, status: u16, headers: []Header, body: []u8) !*c.talk_value {
    std.mem.sort(Header, headers, {}, struct {
        fn less(_: void, x: Header, y: Header) bool {
            return std.mem.order(u8, x.name, y.name) == .lt;
        }
    }.less);
    var pairs: std.ArrayList(c.talk_pair) = .empty;
    defer pairs.deinit(gpa);
    var made: std.ArrayList(?*c.talk_value) = .empty;
    defer {
        for (made.items) |v| c.talk_value_release(v);
        made.deinit(gpa);
    }
    var i: usize = 0;
    while (i < headers.len) {
        var end = i + 1;
        while (end < headers.len and std.mem.eql(u8, headers[end].name, headers[i].name)) end += 1;
        var v: ?*c.talk_value = null;
        if (std.mem.eql(u8, headers[i].name, "set-cookie")) {
            var items: std.ArrayList(?*c.talk_value) = .empty;
            defer {
                for (items.items) |x| c.talk_value_release(x);
                items.deinit(gpa);
            }
            for (headers[i..end]) |h| {
                var t: ?*c.talk_value = null;
                if (c.talk_text(h.value.ptr, h.value.len, &t) != c.TALK_OK) return error.InvalidValue;
                try items.append(gpa, t);
            }
            if (c.talk_list(items.items.ptr, items.items.len, &v) != c.TALK_OK) return error.InvalidValue;
        } else {
            var joined: std.ArrayList(u8) = .empty;
            defer joined.deinit(gpa);
            for (headers[i..end], 0..) |h, n| {
                if (n > 0) try joined.appendSlice(gpa, ", ");
                try joined.appendSlice(gpa, h.value);
            }
            if (c.talk_text(joined.items.ptr, joined.items.len, &v) != c.TALK_OK) return error.InvalidValue;
        }
        try made.append(gpa, v);
        try pairs.append(gpa, c.talk_kv(headers[i].name.ptr, headers[i].name.len, v));
        i = end;
    }
    var hs: ?*c.talk_value = null;
    if (c.talk_map(pairs.items.ptr, pairs.items.len, &hs) != c.TALK_OK) return error.InvalidValue;
    try made.append(gpa, hs);
    var s: ?*c.talk_value = null;
    _ = c.talk_uint(status, &s);
    try made.append(gpa, s);
    var b: ?*c.talk_value = null;
    if (c.talk_bytes(body.ptr, body.len, &b) != c.TALK_OK) return error.InvalidValue;
    try made.append(gpa, b);
    const out = [_]c.talk_pair{ c.talk_kv("status", 6, s), c.talk_kv("headers", 7, hs), c.talk_kv("body", 4, b) };
    var v: ?*c.talk_value = null;
    if (c.talk_map(&out, out.len, &v) != c.TALK_OK) return error.InvalidValue;
    return v.?;
}

/// The bytes chapter 7 counts for a field line: name, value and 4.
fn fieldBytes(name: []const u8, value: []const u8) usize {
    return name.len + value.len + 4;
}

fn trailerBytes(raw: []const u8) usize {
    var n: usize = 0;
    var lines = std.mem.splitSequence(u8, raw, "\r\n");
    while (lines.next()) |l| {
        const colon = std.mem.indexOfScalar(u8, l, ':') orelse continue;
        n += fieldBytes(l[0..colon], std.mem.trim(u8, l[colon + 1 ..], " \t"));
    }
    return n;
}

fn work(f: *Fetcher, j: *Job) void {
    j.outcome = perform(f, j) catch |e| switch (e) {
        error.HttpHeadersOversize => .{ .too_large = "headers" },
        error.StreamTooLong => .{ .too_large = "body" },
        error.Canceled => .pending,
        else => .{ .network_error = @errorName(e) },
    };
    j.done.store(true, .release);
    _ = sys.write(f.wake[1], "x", 1);
}

fn perform(f: *Fetcher, j: *Job) !Outcome {
    const gpa = f.gpa;
    var client: http.Client = .{ .allocator = gpa, .io = f.io, .read_buffer_size = max_header_bytes + 16 * 1024 };
    defer client.deinit();
    const uri = try std.Uri.parse(j.url);
    var req = try client.request(j.method, uri, .{
        .keep_alive = false,
        .redirect_behavior = .unhandled,
        .headers = .{
            .user_agent = .omit,
            .accept_encoding = if (j.accept_encoding) .omit else .{ .override = "identity" },
            .content_type = .omit,
        },
        .extra_headers = j.headers,
    });
    defer req.deinit();
    if (j.body) |body| {
        req.transfer_encoding = .{ .content_length = body.len };
        var w = try req.sendBodyUnflushed(&.{});
        try w.writer.writeAll(body);
        try w.end();
        try req.connection.?.flush();
    } else try req.sendBodiless();
    var res = try req.receiveHead(&.{});
    // Skip informational responses; `fetch` can't switch protocols.
    while (res.head.status.class() == .informational) {
        if (res.head.status == .switching_protocols) return .{ .network_error = "the server switched protocols" };
        res = try req.receiveHead(&.{});
    }
    const status = @backingInt(res.head.status);
    if (status < 200 or status > 599) return .{ .network_error = "a status outside 200 to 599" };
    // Copy the head before the body reuses its buffer.
    var headers: std.ArrayList(Header) = .empty;
    errdefer {
        for (headers.items) |h| {
            gpa.free(h.name);
            gpa.free(h.value);
        }
        headers.deinit(gpa);
    }
    var seen: usize = 0;
    var it = res.head.iterateHeaders();
    while (it.next()) |h| {
        seen += fieldBytes(h.name, h.value);
        const name = try std.ascii.allocLowerString(gpa, h.name);
        errdefer gpa.free(name);
        try headers.append(gpa, .{ .name = name, .value = try gpa.dupe(u8, h.value) });
    }
    if (seen > max_header_bytes) return error.HttpHeadersOversize;
    var transfer: [64]u8 = undefined;
    const reader = res.reader(&transfer);
    const body = reader.allocRemaining(gpa, .limited(max_body_bytes)) catch |e| switch (e) {
        error.ReadFailed => return res.bodyErr() orelse error.ReadFailed,
        else => |x| return x,
    };
    errdefer gpa.free(body);
    if (seen + trailerBytes(req.reader.trailers) > max_header_bytes) return error.HttpHeadersOversize;
    return .{ .answer = .{ .status = status, .headers = try headers.toOwnedSlice(gpa), .body = body } };
}

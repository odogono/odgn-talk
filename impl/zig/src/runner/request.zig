//! An HTTP request as the router reads it off a socket, and the one argument
//! chapter 7 gives an HTTP Exchange's Delivery: method, path, segments,
//! query, headers and body, with query keys and header names in code-point
//! order, as the TS and Go routers give it (impl/ts/src/http/router.ts,
//! impl/go/httphost/host.go).
const std = @import("std");

const Allocator = std.mem.Allocator;

/// A header as it came, its name as written.
pub const Header = struct { name: []const u8, value: []const u8 };

/// A request head: the request line and the headers, borrowed from the
/// buffer it was parsed from.
pub const Head = struct {
    method: []const u8,
    target: []const u8,
    version: []const u8,
    headers: []const Header,
    /// The bytes the head took, its blank line included.
    len: usize,

    /// The value of the first header called `name`, any case.
    pub fn get(h: Head, name: []const u8) ?[]const u8 {
        for (h.headers) |x| if (std.ascii.eqlIgnoreCase(x.name, name)) return x.value;
        return null;
    }

    /// Whether the client keeps the connection open after this exchange.
    pub fn keepAlive(h: Head) bool {
        const connection = h.get("connection") orelse "";
        if (std.ascii.eqlIgnoreCase(h.version, "HTTP/1.0")) return containsToken(connection, "keep-alive");
        return !containsToken(connection, "close");
    }

    /// Whether the body is chunked.
    pub fn chunked(h: Head) bool {
        for (h.headers) |x| if (std.ascii.eqlIgnoreCase(x.name, "transfer-encoding") and containsToken(x.value, "chunked")) return true;
        return false;
    }
};

fn containsToken(list: []const u8, token: []const u8) bool {
    var it = std.mem.tokenizeAny(u8, list, ", \t");
    while (it.next()) |t| if (std.ascii.eqlIgnoreCase(t, token)) return true;
    return false;
}

pub const HeadError = error{ BadRequest, OutOfMemory };

/// The head at the start of `bytes`, or null while it is incomplete.
pub fn parseHead(a: Allocator, bytes: []const u8) HeadError!?Head {
    var parser: std.http.HeadParser = .{};
    const n = parser.feed(bytes);
    if (parser.state != .finished) return null;
    var lines = std.mem.splitScalar(u8, bytes[0..n], '\n');
    const first = std.mem.trimEnd(u8, lines.next() orelse return error.BadRequest, "\r");
    var parts = std.mem.splitScalar(u8, first, ' ');
    const method = parts.next() orelse return error.BadRequest;
    const target = parts.next() orelse return error.BadRequest;
    const version = parts.next() orelse return error.BadRequest;
    if (parts.next() != null or method.len == 0 or target.len == 0 or !std.mem.startsWith(u8, version, "HTTP/1.")) return error.BadRequest;
    var headers: std.ArrayList(Header) = .empty;
    while (lines.next()) |raw| {
        const line = std.mem.trimEnd(u8, raw, "\r");
        if (line.len == 0) continue;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.BadRequest;
        const name = line[0..colon];
        if (name.len == 0 or std.mem.indexOfAny(u8, name, " \t") != null) return error.BadRequest;
        try headers.append(a, .{ .name = name, .value = std.mem.trim(u8, line[colon + 1 ..], " \t") });
    }
    return .{ .method = method, .target = target, .version = version, .headers = headers.items, .len = n };
}

pub const BodyError = error{ BadRequest, TooLarge, OutOfMemory };

/// A chunked body's bytes, decoded, and how many bytes of `bytes` it took,
/// trailers included; null while it is incomplete. A body over `max` is
/// `TooLarge`.
pub fn dechunk(a: Allocator, bytes: []const u8, max: usize) BodyError!?struct { body: []u8, len: usize } {
    var out: std.ArrayList(u8) = .empty;
    // Freed unless it is returned.
    defer out.deinit(a);
    var i: usize = 0;
    while (true) {
        const eol = std.mem.indexOfScalarPos(u8, bytes, i, '\n') orelse return null;
        const line = std.mem.trimEnd(u8, bytes[i..eol], "\r");
        const size_text = std.mem.trim(u8, line[0 .. std.mem.indexOfScalar(u8, line, ';') orelse line.len], " \t");
        const size = std.fmt.parseInt(usize, size_text, 16) catch return error.BadRequest;
        i = eol + 1;
        if (size == 0) {
            // Trailers, up to a blank line.
            while (true) {
                const end = std.mem.indexOfScalarPos(u8, bytes, i, '\n') orelse return null;
                const trailer = std.mem.trimEnd(u8, bytes[i..end], "\r");
                i = end + 1;
                if (trailer.len == 0) return .{ .body = try out.toOwnedSlice(a), .len = i };
            }
        }
        if (size > max or out.items.len + size > max) return error.TooLarge;
        if (bytes.len < i + size) return null;
        try out.appendSlice(a, bytes[i .. i + size]);
        i += size;
        if (bytes.len < i + 1) return null;
        if (bytes[i] == '\r') {
            if (bytes.len < i + 2) return null;
            if (bytes[i + 1] != '\n') return error.BadRequest;
            i += 2;
        } else if (bytes[i] == '\n') {
            i += 1;
        } else return error.BadRequest;
    }
}

/// One query key or header name and its values, in the order they came.
pub const Entry = struct { key: []const u8, values: []const []const u8 };

/// The fields a Delivery's map holds, but `exchange`, before they become
/// Values: every text is valid UTF-8.
pub const Fields = struct {
    method: []const u8,
    path: []const u8,
    segments: []const []const u8,
    /// Sorted by key; one value is a text, more a list.
    query: []const Entry,
    /// Sorted by lower-case name; `set-cookie` is a list, any other name
    /// its values joined with `, `.
    headers: []const Entry,
};

/// `%XX` escapes decoded, and `+` as a space when `plus` is set. Null for
/// a malformed escape, or bytes that aren't UTF-8, as decodeURIComponent
/// refuses them.
fn percentDecode(a: Allocator, s: []const u8, plus: bool) Allocator.Error!?[]const u8 {
    if (std.mem.indexOfAny(u8, s, if (plus) "%+" else "%") == null) return if (std.unicode.utf8ValidateSlice(s)) s else null;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const ch = s[i];
        if (ch == '+' and plus) {
            try out.append(a, ' ');
        } else if (ch == '%') {
            if (i + 2 >= s.len) return null;
            const byte = std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch return null;
            try out.append(a, byte);
            i += 2;
        } else try out.append(a, ch);
    }
    if (!std.unicode.utf8ValidateSlice(out.items)) return null;
    return out.items;
}

fn lessThan(_: void, x: Entry, y: Entry) bool {
    return std.mem.order(u8, x.key, y.key) == .lt;
}

/// Groups pairs by key, in first-seen order, then sorts by key. UTF-8
/// byte order is code-point order.
fn grouped(a: Allocator, pairs: []const [2][]const u8) Allocator.Error![]const Entry {
    var keys: std.StringArrayHashMapUnmanaged(std.ArrayList([]const u8)) = .empty;
    for (pairs) |p| {
        const e = try keys.getOrPut(a, p[0]);
        if (!e.found_existing) e.value_ptr.* = .empty;
        try e.value_ptr.append(a, p[1]);
    }
    const out = try a.alloc(Entry, keys.count());
    for (keys.keys(), keys.values(), out) |k, *v, *o| o.* = .{ .key = k, .values = v.items };
    std.mem.sort(Entry, out, {}, lessThan);
    return out;
}

/// The request's fields. A path segment whose escapes don't decode stays
/// as written, as the TS router's decodeURIComponent fallback keeps it; so
/// does a query part, as URLSearchParams does. Null when a text the map
/// must hold isn't UTF-8.
pub fn fields(a: Allocator, method: []const u8, target: []const u8, headers: []const Header) Allocator.Error!?Fields {
    const q = std.mem.indexOfScalar(u8, target, '?');
    const path = target[0 .. q orelse target.len];
    const raw_query = if (q) |i| target[i + 1 ..] else "";
    if (!std.unicode.utf8ValidateSlice(path)) return null;

    var segments: std.ArrayList([]const u8) = .empty;
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |part| {
        if (part.len == 0) continue;
        try segments.append(a, (try percentDecode(a, part, false)) orelse part);
    }

    var query: std.ArrayList([2][]const u8) = .empty;
    var pairs = std.mem.splitScalar(u8, raw_query, '&');
    while (pairs.next()) |pair| {
        if (pair.len == 0) continue;
        const eq = std.mem.indexOfScalar(u8, pair, '=');
        const k = pair[0 .. eq orelse pair.len];
        const v = if (eq) |i| pair[i + 1 ..] else "";
        const key = (try percentDecode(a, k, true)) orelse (if (std.unicode.utf8ValidateSlice(k)) k else return null);
        const value = (try percentDecode(a, v, true)) orelse (if (std.unicode.utf8ValidateSlice(v)) v else return null);
        try query.append(a, .{ key, value });
    }

    var named: std.ArrayList([2][]const u8) = .empty;
    for (headers) |h| {
        if (!std.unicode.utf8ValidateSlice(h.value)) return null;
        try named.append(a, .{ try std.ascii.allocLowerString(a, h.name), h.value });
    }
    const by_name = try grouped(a, named.items);
    const joined = try a.alloc(Entry, by_name.len);
    for (by_name, joined) |e, *j| {
        j.* = if (std.mem.eql(u8, e.key, "set-cookie") or e.values.len == 1) e else blk: {
            const one = try a.alloc([]const u8, 1);
            one[0] = try std.mem.join(a, ", ", e.values);
            break :blk .{ .key = e.key, .values = one };
        };
    }
    return .{
        .method = try std.ascii.allocUpperString(a, method),
        .path = path,
        .segments = segments.items,
        .query = try grouped(a, query.items),
        .headers = joined,
    };
}

/// The reason phrase for a status line.
pub fn reason(status: u16) []const u8 {
    return switch (status) {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        else => "",
    };
}

const testing = std.testing;

test "a head parses, with its headers as written" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect(try parseHead(a, "GET / HTTP/1.1\r\nHost: x\r\n") == null);
    const h = (try parseHead(a, "GET /a?b=1 HTTP/1.1\r\nHost: x\r\nX-One:  1 \r\n\r\nbody")).?;
    try testing.expectEqualStrings("GET", h.method);
    try testing.expectEqualStrings("/a?b=1", h.target);
    try testing.expectEqual(@as(usize, 2), h.headers.len);
    try testing.expectEqualStrings("1", h.get("x-one").?);
    try testing.expect(h.keepAlive());
    try testing.expectEqualStrings("body", "GET /a?b=1 HTTP/1.1\r\nHost: x\r\nX-One:  1 \r\n\r\nbody"[h.len..]);
    try testing.expectError(error.BadRequest, parseHead(a, "GET\r\n\r\n"));
    const old = (try parseHead(a, "GET / HTTP/1.0\r\n\r\n")).?;
    try testing.expect(!old.keepAlive());
}

test "a chunked body decodes, and one over the limit is too large" {
    const a = testing.allocator;
    try testing.expect(try dechunk(a, "3\r\nabc\r\n", 10) == null);
    const done = (try dechunk(a, "3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\nnext", 10)).?;
    defer a.free(done.body);
    try testing.expectEqualStrings("abcde", done.body);
    try testing.expectEqualStrings("next", "3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\nnext"[done.len..]);
    try testing.expectError(error.TooLarge, dechunk(a, "b\r\n", 10));
}

test "the request map's fields are normalised as the TS and Go routers give them" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const headers = [_]Header{
        .{ .name = "X-B", .value = "2" },
        .{ .name = "Host", .value = "localhost" },
        .{ .name = "x-b", .value = "3" },
        .{ .name = "Set-Cookie", .value = "a=1" },
        .{ .name = "set-cookie", .value = "b=2" },
    };
    const f = (try fields(a, "post", "/users//caf%C3%A9/a%2Fb/%zz?z=1&a=x+y&a=%41&flag&&b=%E2%82%AC", &headers)).?;
    try testing.expectEqualStrings("POST", f.method);
    try testing.expectEqualStrings("/users//caf%C3%A9/a%2Fb/%zz", f.path);
    const segments = [_][]const u8{ "users", "café", "a/b", "%zz" };
    try testing.expectEqual(segments.len, f.segments.len);
    for (segments, f.segments) |x, y| try testing.expectEqualStrings(x, y);
    // Keys in code-point order; a repeated key's values in order.
    const keys = [_][]const u8{ "a", "b", "flag", "z" };
    for (keys, f.query) |k, e| try testing.expectEqualStrings(k, e.key);
    try testing.expectEqual(@as(usize, 2), f.query[0].values.len);
    try testing.expectEqualStrings("x y", f.query[0].values[0]);
    try testing.expectEqualStrings("A", f.query[0].values[1]);
    try testing.expectEqualStrings("€", f.query[1].values[0]);
    try testing.expectEqualStrings("", f.query[2].values[0]);
    // Lower-case names, sorted; repeats joined but set-cookie's.
    const names = [_][]const u8{ "host", "set-cookie", "x-b" };
    for (names, f.headers) |k, e| try testing.expectEqualStrings(k, e.key);
    try testing.expectEqual(@as(usize, 2), f.headers[1].values.len);
    try testing.expectEqualStrings("2, 3", f.headers[2].values[0]);
}

test "an empty path has no segments and the query no keys" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const f = (try fields(arena.allocator(), "GET", "/", &.{})).?;
    try testing.expectEqualStrings("/", f.path);
    try testing.expectEqual(@as(usize, 0), f.segments.len);
    try testing.expectEqual(@as(usize, 0), f.query.len);
    try testing.expectEqual(@as(usize, 0), f.headers.len);
}

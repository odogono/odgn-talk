//! `http.fetch`'s checks (chapter 7, Fetching; ADR 0151): the request the
//! Core accepts, the destination it gives the Host, and the answer it takes
//! back. The Host does the I/O.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const encoding = @import("../encoding.zig");
const caps = @import("capabilities.zig");
const Value = model.Value;

pub const methods = [_][]const u8{ "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS" };

/// Header names the Host controls, which a Script can't set.
pub const host_headers = [_][]const u8{ "host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade" };

/// A URL in chapter 7's strict profile, split and normalized. Its texts
/// borrow from the URL, except `host`, which `buf` holds lowercased.
pub const Url = struct {
    https: bool,
    host: []const u8,
    /// The effective port: the scheme's default when the URL omits it.
    port: u16,
    /// The path as written, empty for `/`.
    path: []const u8,
    /// The query after `?`, as written.
    query: ?[]const u8,
    buf: [256]u8 = undefined,

    pub fn defaultPort(u: *const Url) u16 {
        return if (u.https) 443 else 80;
    }

    /// The normalized URL, without the query: no default port, no
    /// fragment, `/` for an empty path.
    pub fn writeBase(u: *const Url, w: anytype) !void {
        try w.print("{s}://{s}", .{ if (u.https) "https" else "http", u.host });
        if (u.port != u.defaultPort()) try w.print(":{d}", .{u.port});
        try w.writeAll(if (u.path.len == 0) "/" else u.path);
    }
};

fn isDigits(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

fn ipv4(host: []const u8) bool {
    var parts = std.mem.splitScalar(u8, host, '.');
    var n: usize = 0;
    while (parts.next()) |p| : (n += 1) {
        if (n == 4 or !isDigits(p) or p.len > 3) return false;
        if (p.len > 1 and p[0] == '0') return false;
        if ((std.fmt.parseInt(u16, p, 10) catch return false) > 255) return false;
    }
    return n == 4;
}

fn hexGroup(g: []const u8) bool {
    if (g.len == 0 or g.len > 4) return false;
    for (g) |ch| if (!std.ascii.isHex(ch)) return false;
    return true;
}

/// The colon-separated groups of `part`, none for empty text, each a
/// hexadecimal group; null when one isn't.
fn groups(part: []const u8) ?usize {
    if (part.len == 0) return 0;
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, part, ':');
    while (it.next()) |g| : (n += 1) if (!hexGroup(g)) return null;
    return n;
}

fn ipv6(inner: []const u8) bool {
    var buf: [64]u8 = undefined;
    var s = inner;
    const colon = std.mem.lastIndexOfScalar(u8, s, ':');
    const tail = if (colon) |i| s[i + 1 ..] else s;
    if (std.mem.indexOfScalar(u8, tail, '.') != null) {
        // An embedded IPv4 address stands for the last two groups.
        if (!ipv4(tail)) return false;
        const head = s[0 .. s.len - tail.len];
        if (head.len + 3 > buf.len) return false;
        @memcpy(buf[0..head.len], head);
        @memcpy(buf[head.len..][0..3], "0:0");
        s = buf[0 .. head.len + 3];
    }
    const at = std.mem.indexOf(u8, s, "::") orelse {
        return (groups(s) orelse return false) == 8;
    };
    const rest = s[at + 2 ..];
    if (std.mem.indexOf(u8, rest, "::") != null) return false;
    const named = (groups(s[0..at]) orelse return false) + (groups(rest) orelse return false);
    return named <= 7;
}

/// RFC 3986 unreserved, sub-delims, `:`, `@` and `/`.
fn pchar(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or std.mem.indexOfScalar(u8, "_!$&'()*+,./:;=@~-", ch) != null;
}

fn partOk(s: []const u8, query: bool) bool {
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '%') {
            i += 2;
        } else if (!pchar(s[i]) and !(query and s[i] == '?')) return false;
    }
    return true;
}

fn nameOk(host: []const u8) bool {
    var labels = std.mem.splitScalar(u8, host, '.');
    while (labels.next()) |l| {
        if (l.len == 0) return false;
        for (l) |ch| if (!(std.ascii.isAlphanumeric(ch) or ch == '-')) return false;
    }
    return true;
}

/// Parses and normalizes a fetch URL, or null outside the profile.
pub fn parseUrl(url: []const u8) ?Url {
    for (url, 0..) |ch, i| {
        if (ch <= 0x20 or ch >= 0x7f or ch == '\\') return null;
        if (ch == '%' and (i + 2 >= url.len or !std.ascii.isHex(url[i + 1]) or !std.ascii.isHex(url[i + 2]))) return null;
    }
    var out: Url = .{ .https = false, .host = "", .port = 0, .path = "", .query = null };
    var rest: []const u8 = undefined;
    if (std.ascii.startsWithIgnoreCase(url, "https://")) {
        out.https = true;
        rest = url[8..];
    } else if (std.ascii.startsWithIgnoreCase(url, "http://")) {
        rest = url[7..];
    } else return null;
    if (std.mem.indexOfScalar(u8, rest, '#')) |hash| rest = rest[0..hash];
    const end = std.mem.indexOfAny(u8, rest, "/?") orelse rest.len;
    const authority = rest[0..end];
    rest = rest[end..];
    var host: []const u8 = undefined;
    var port_text: ?[]const u8 = null;
    if (authority.len > 0 and authority[0] == '[') {
        const close = std.mem.indexOfScalar(u8, authority, ']') orelse return null;
        if (!ipv6(authority[1..close])) return null;
        host = authority[0 .. close + 1];
        const after = authority[close + 1 ..];
        if (after.len > 0) {
            if (after[0] != ':') return null;
            port_text = after[1..];
        }
    } else {
        const colon = std.mem.indexOfScalar(u8, authority, ':');
        host = if (colon) |i| authority[0..i] else authority;
        if (colon) |i| port_text = authority[i + 1 ..];
        if (!nameOk(host)) return null;
        const last = host[if (std.mem.lastIndexOfScalar(u8, host, '.')) |i| i + 1 else 0..];
        if (isDigits(last) and !ipv4(host)) return null;
    }
    if (host.len > out.buf.len) return null;
    out.host = std.ascii.lowerString(out.buf[0..host.len], host);
    out.port = out.defaultPort();
    if (port_text) |p| {
        if (!isDigits(p)) return null;
        const trimmed = std.mem.trimStart(u8, p, "0");
        if (trimmed.len > 5) return null;
        const n = if (trimmed.len == 0) 0 else std.fmt.parseInt(u32, trimmed, 10) catch return null;
        if (n < 1 or n > 65535) return null;
        out.port = @intCast(n);
    }
    const q = std.mem.indexOfScalar(u8, rest, '?');
    out.path = if (q) |i| rest[0..i] else rest;
    out.query = if (q) |i| rest[i + 1 ..] else null;
    if (!partOk(out.path, false)) return null;
    if (out.query) |x| if (!partOk(x, true)) return null;
    return out;
}

/// A text, or a list of texts, as a slice of the values; null otherwise.
fn texts(v: *const Value, one: *[1]*Value) ?[]const *Value {
    switch (v.data) {
        .text => {
            one[0] = @constCast(v);
            return one;
        },
        .list => |xs| {
            for (xs) |x| if (x.data != .text) return null;
            return xs;
        },
        else => return null,
    }
}

/// RFC 9110 §5.6.2's tchar.
fn tokenOk(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| if (!(std.ascii.isAlphanumeric(ch) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", ch) != null)) return false;
    return true;
}

fn headerValueOk(s: []const u8) bool {
    for (s) |ch| if ((ch < 0x20 and ch != '\t') or ch == 0x7f) return false;
    if (s.len > 0 and (s[0] == ' ' or s[0] == '\t' or s[s.len - 1] == ' ' or s[s.len - 1] == '\t')) return false;
    return true;
}

/// Whether a headers map names one header twice in different cases. Shared
/// with `respond`.
pub fn duplicateHeaderNames(headers: *const Value) bool {
    const m = headers.data.map;
    for (0..m.len) |i| for (0..i) |j| {
        if (std.ascii.eqlIgnoreCase(m.at(i).key, m.at(j).key)) return true;
    };
    return false;
}

fn hostControlled(name: []const u8) bool {
    for (host_headers) |h| if (std.ascii.eqlIgnoreCase(h, name)) return true;
    return false;
}

fn request(args: []const *Value) ?*Value {
    return if (args.len > 1 and args[1].data == .map) args[1] else null;
}

fn invalid(field: []const u8) caps.Problem {
    return .{ .invalid_field = .{ .code = "invalid request", .field = field } };
}

/// Checks `fetch`'s arguments, after their Shapes, in chapter 7's order:
/// the method, the URL, `headers`, `query`, then `body` and `json`.
pub fn check(a: Allocator, args: []const *Value) Allocator.Error!?caps.Problem {
    const r = request(args);
    const method = if (r) |m| m.get("method") else null;
    if (method) |m| {
        for (methods) |x| {
            if (std.mem.eql(u8, x, m.data.text)) break;
        } else return .{ .out_of_domain = m };
    }
    const url = parseUrl(args[0].data.text) orelse return invalid("url");
    const req = r orelse return null;
    var one: [1]*Value = undefined;
    if (req.get("headers")) |headers| {
        if (duplicateHeaderNames(headers)) return invalid("headers");
        const m = headers.data.map;
        for (0..m.len) |i| {
            const p = m.at(i);
            if (!tokenOk(p.key) or hostControlled(p.key)) return invalid("headers");
            const values = texts(p.value, &one) orelse return invalid("headers");
            for (values) |v| if (!headerValueOk(v.data.text)) return invalid("headers");
        }
    }
    if (req.get("query")) |query| {
        const m = query.data.map;
        for (0..m.len) |i| _ = texts(m.at(i).value, &one) orelse return invalid("query");
        if (m.len > 0 and url.query != null) return invalid("query");
    }
    const body = req.get("body");
    if (req.get("json")) |json| {
        if (body != null) return invalid("json");
        const written = encoding.encodeJson(a, json) catch |e| return if (e == error.OutOfMemory) error.OutOfMemory else invalid("json");
        a.free(written);
    }
    const bodiless = if (method) |m| std.mem.eql(u8, m.data.text, "GET") or std.mem.eql(u8, m.data.text, "HEAD") else true;
    if (bodiless) {
        if (body != null) return invalid("body");
        if (req.get("json") != null) return invalid("json");
    }
    return null;
}

fn percentEncode(w: anytype, s: []const u8) !void {
    for (s) |byte| {
        if (std.ascii.isAlphanumeric(byte) or byte == '-' or byte == '.' or byte == '_' or byte == '~') {
            try w.writeByte(byte);
        } else try w.print("%{X:0>2}", .{byte});
    }
}

/// The normalized URL with `query` added, for arguments `check` accepted.
pub fn urlText(a: Allocator, args: []const *Value) ![]u8 {
    const url = parseUrl(args[0].data.text).?;
    var out: std.Io.Writer.Allocating = .init(a);
    errdefer out.deinit();
    const w = &out.writer;
    try url.writeBase(w);
    var first = true;
    if (url.query) |q| {
        try w.print("?{s}", .{q});
    } else if (request(args)) |r| if (r.get("query")) |query| {
        var one: [1]*Value = undefined;
        const m = query.data.map;
        for (0..m.len) |i| {
            const p = m.at(i);
            for (texts(p.value, &one).?) |v| {
                try w.writeByte(if (first) '?' else '&');
                first = false;
                try percentEncode(w, p.key);
                try w.writeByte('=');
                try percentEncode(w, v.data.text);
            }
        }
    };
    return out.toOwnedSlice();
}

/// The request the Host hears, without `query`: `method` always, `headers`
/// and `body` as given, and `json` as its compact JSON text.
pub fn requestValue(a: Allocator, args: []const *Value) !*Value {
    var pairs: [4]model.Pair = undefined;
    var n: usize = 0;
    var made: [2]?*Value = .{ null, null };
    defer for (made) |m| if (m) |v| v.release();
    const r = request(args);
    const method = if (r) |m| m.get("method") else null;
    if (method == null) made[0] = try model.text(a, "GET");
    pairs[n] = .{ .key = "method", .value = method orelse made[0].? };
    n += 1;
    if (r) |req| {
        if (req.get("headers")) |h| {
            pairs[n] = .{ .key = "headers", .value = h };
            n += 1;
        }
        if (req.get("body")) |b| {
            pairs[n] = .{ .key = "body", .value = b };
            n += 1;
        }
        if (req.get("json")) |j| {
            const written = encoding.encodeJson(a, j) catch |e| return if (e == error.OutOfMemory) error.OutOfMemory else error.InvalidValue;
            defer a.free(written);
            made[1] = try model.text(a, written);
            pairs[n] = .{ .key = "json", .value = made[1].? };
            n += 1;
        }
    }
    return model.map(a, pairs[0..n]);
}

fn whole(v: *const Value) ?i64 {
    if (v.data != .number) return null;
    return v.data.number.integer(i64) catch null;
}

/// Whether the Host's answer follows chapter 7's response rules: exactly
/// `status`, `headers` and `body`, in that order.
pub fn answerOk(result: *const Value) bool {
    if (result.data != .map) return false;
    const m = result.data.map;
    if (m.len != 3) return false;
    for ([_][]const u8{ "status", "headers", "body" }, 0..) |k, i| if (!std.mem.eql(u8, m.at(i).key, k)) return false;
    const status = whole(m.at(0).value) orelse return false;
    if (status < 200 or status > 599) return false;
    if (m.at(2).value.data != .bytes) return false;
    const headers = m.at(1).value;
    if (headers.data != .map) return false;
    const hs = headers.data.map;
    var previous: ?[]const u8 = null;
    for (0..hs.len) |i| {
        const p = hs.at(i);
        if (!tokenOk(p.key)) return false;
        for (p.key) |ch| if (std.ascii.isUpper(ch)) return false;
        if (previous) |prev| if (std.mem.order(u8, prev, p.key) != .lt) return false;
        previous = p.key;
        const ok = if (std.mem.eql(u8, p.key, "set-cookie"))
            p.value.data == .list and for (p.value.data.list) |x| {
                if (x.data != .text) break false;
            } else true
        else
            p.value.data == .text;
        if (!ok) return false;
    }
    return true;
}

test "fetch URLs: the strict profile and normalization" {
    const ok = [_]struct { []const u8, []const u8 }{
        .{ "HTTPS://API.Example.com:443/users#top", "https://api.example.com/users" },
        .{ "https://example.com", "https://example.com/" },
        .{ "http://10.0.0.1:8080/", "http://10.0.0.1:8080/" },
        .{ "https://[::FFFF:127.0.0.1]:8443", "https://[::ffff:127.0.0.1]:8443/" },
        .{ "http://example.com:0080/a/../b?x=%2F&y", "http://example.com/a/../b?x=%2F&y" },
        .{ "https://[::1]/", "https://[::1]/" },
    };
    for (ok) |x| {
        const u = parseUrl(x[0]) orelse return error.Refused;
        var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer out.deinit();
        try u.writeBase(&out.writer);
        if (u.query) |q| try out.writer.print("?{s}", .{q});
        try std.testing.expectEqualStrings(x[1], out.written());
    }
    for ([_][]const u8{ "ftp://example.com/", "https://user@example.com/", "https://example.com/a b", "https://exämple.com/", "https://127.1/", "https://0x7f.0.0.1/", "https://01.2.3.4/", "https://example.com:0/", "https://example.com:65536/", "https://example.com/%zz", "https://example.com/a\\b", "https://[::1/", "https://[1:2:3:4:5:6:7:8:9]/", "example.com/", "https://a..b/", "https://example.com./", "https:///", "https://[1:::2]/", "https://example.com/%a" }) |bad| {
        if (parseUrl(bad) != null) {
            std.debug.print("accepted {s}\n", .{bad});
            return error.Accepted;
        }
    }
}

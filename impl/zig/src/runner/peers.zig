//! The native Runner's `peer` transport (chapter 12, Runner peers; ADR
//! 0163): Remote Sends to other Runners as length-prefixed frames in the
//! Value Encoding, on the Runner's one poll loop, over mutual TLS with
//! pinned keys (ADR 0164) or plain TCP on loopback.
const std = @import("std");
const c = @import("talk-c");
pub const tls = @import("tls/root.zig");

const sys = std.c;
const posix = std.posix;
const Allocator = std.mem.Allocator;

/// The largest frame a Runner sends or reads.
const max_frame = 16 * 1024 * 1024;

pub const Address = struct {
    host: []const u8,
    port: u16,
    /// Plain TCP, on loopback only, rather than TLS.
    plain: bool = false,
    /// The key a dialled TLS listener must have.
    pin: ?tls.keys.Fingerprint = null,
};
pub const Remote = struct { name: []const u8, address: Address };

/// Plain TCP carries no key to check, so it stays on this machine.
fn loopback(host: []const u8) bool {
    return std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1") or std.mem.eql(u8, host, "localhost");
}

pub const ParseError = error{ Malformed, NotLoopback };

fn hostPort(given: []const u8, plain: bool) ParseError!Address {
    const colon = std.mem.lastIndexOfScalar(u8, given, ':') orelse return error.Malformed;
    var host = given[0..colon];
    if (host.len >= 2 and host[0] == '[' and host[host.len - 1] == ']') host = host[1 .. host.len - 1];
    if (host.len == 0) return error.Malformed;
    const port = std.fmt.parseInt(u16, given[colon + 1 ..], 10) catch return error.Malformed;
    if (plain and !loopback(host)) return error.NotLoopback;
    return .{ .host = host, .port = port, .plain = plain };
}

/// `--listen HOST:PORT` or `tls://HOST:PORT`, and `tcp://HOST:PORT` on loopback.
pub fn parseListen(given: []const u8) ParseError!Address {
    if (std.mem.startsWith(u8, given, "tcp://")) return hostPort(given["tcp://".len..], true);
    if (std.mem.startsWith(u8, given, "tls://")) return hostPort(given["tls://".len..], false);
    if (std.mem.indexOf(u8, given, "://") != null) return error.Malformed;
    return hostPort(given, false);
}

/// `--peer NAME=tls://HOST:PORT#FINGERPRINT`, or `NAME=tcp://HOST:PORT`.
pub fn parsePeer(given: []const u8) ParseError!Remote {
    const eq = std.mem.indexOfScalar(u8, given, '=') orelse return error.Malformed;
    if (eq == 0) return error.Malformed;
    const rest = given[eq + 1 ..];
    if (std.mem.startsWith(u8, rest, "tcp://")) return .{ .name = given[0..eq], .address = try hostPort(rest["tcp://".len..], true) };
    if (!std.mem.startsWith(u8, rest, "tls://")) return error.Malformed;
    const hash = std.mem.lastIndexOfScalar(u8, rest, '#') orelse return error.Malformed;
    const pin = rest[hash + 1 ..];
    if (pin.len != 64) return error.Malformed;
    for (pin) |ch| if (!std.ascii.isDigit(ch) and !(ch >= 'a' and ch <= 'f')) return error.Malformed;
    var address = try hostPort(rest["tls://".len..hash], false);
    address.pin = pin[0..64].*;
    return .{ .name = given[0..eq], .address = address };
}

const Asked = union(enum) { reach: ?*c.talk_call, call: ?*c.talk_call };

/// One connection to another Runner, either way round.
const Link = struct {
    fd: posix.fd_t,
    /// The TLS session, for a link that isn't plain TCP.
    tls: ?*tls.session.Session = null,
    /// The other end's key, as its `hello` claims; empty until it says.
    key: [64]u8 = undefined,
    known: bool = false,
    in: std.ArrayList(u8) = .empty,
    out: std.ArrayList(u8) = .empty,
    sent: usize = 0,
    gone: bool = false,
    next: u64 = 0,
    asked: std.AutoHashMapUnmanaged(u64, Asked) = .empty,
    /// The `--peer` that dialled it, if one did.
    remote: ?[]const u8 = null,
};

const Exposure = struct { name: ?[]const u8, script: []const u8 };

/// A `call` waiting for its Request's Run to end: one that arrived on a
/// link, or this Runner's own to its own exposure.
const Incoming = struct { link: ?*Link = null, n: u64 = 0, call: ?*c.talk_call = null };

pub const Peers = struct {
    gpa: Allocator,
    io: std.Io,
    core: *c.talk_core,
    group: ?*c.talk_group = null,
    log: *const fn ([]const u8) void,
    /// This Runner's key, when a `peer` flag was given; without one it
    /// claims a random fingerprint, which nobody can reach.
    identity: ?*const tls.keys.Identity,
    fingerprint: [64]u8,
    listener: ?posix.fd_t = null,
    listen_at: ?Address,
    remotes: []const Remote,
    links: std.ArrayList(*Link) = .empty,
    exposures: std.StringHashMapUnmanaged(Exposure) = .empty,
    names: std.StringHashMapUnmanaged([]const u8) = .empty,
    /// This Group's one Peer for each exposure id, an owned value.
    peers: std.StringHashMapUnmanaged(*c.talk_value) = .empty,
    /// Each Remote Send's Caller Identity, by delivery id: the sending
    /// key over TLS, and none over plain TCP, which authenticates nobody.
    remote_deliveries: std.StringHashMapUnmanaged(?[64]u8) = .empty,
    incoming: std.StringHashMapUnmanaged(Incoming) = .empty,
    /// Answers for calls started in the Pump, given once it returns.
    later: std.ArrayList(struct { call: ?*c.talk_call, value: ?*c.talk_value, fail: ?[]const u8 = null, send: bool = false }) = .empty,
    /// Whether something arrived that a Pump must take.
    dirty: bool = false,
    polled: std.ArrayList(?*Link) = .empty,

    pub fn init(gpa: Allocator, core: *c.talk_core, io: std.Io, identity: ?*const tls.keys.Identity, listen_at: ?Address, remotes: []const Remote, log: *const fn ([]const u8) void) Peers {
        var fingerprint: [64]u8 = undefined;
        if (identity) |id| fingerprint = id.fingerprint else {
            var raw: [32]u8 = undefined;
            io.random(&raw);
            fingerprint = std.fmt.bytesToHex(raw, .lower);
        }
        return .{ .gpa = gpa, .io = io, .core = core, .log = log, .identity = identity, .fingerprint = fingerprint, .listen_at = listen_at, .remotes = remotes };
    }

    pub fn deinit(p: *Peers) void {
        for (p.links.items) |l| p.freeLink(l);
        p.links.deinit(p.gpa);
        if (p.listener) |fd| _ = sys.close(fd);
        var it = p.peers.iterator();
        while (it.next()) |entry| {
            p.gpa.free(entry.key_ptr.*);
            c.talk_value_release(entry.value_ptr.*);
        }
        p.peers.deinit(p.gpa);
        var exposed = p.exposures.iterator();
        while (exposed.next()) |entry| {
            p.gpa.free(entry.key_ptr.*);
            if (entry.value_ptr.name) |n| p.gpa.free(n);
            p.gpa.free(entry.value_ptr.script);
        }
        p.exposures.deinit(p.gpa);
        // Its keys are the exposures' names, freed above.
        p.names.deinit(p.gpa);
        var delivered = p.remote_deliveries.keyIterator();
        while (delivered.next()) |k| p.gpa.free(k.*);
        p.remote_deliveries.deinit(p.gpa);
        p.incoming.deinit(p.gpa);
        p.later.deinit(p.gpa);
        p.polled.deinit(p.gpa);
    }

    fn freeLink(p: *Peers, l: *Link) void {
        _ = sys.close(l.fd);
        if (l.tls) |s| {
            s.deinit(p.gpa);
            p.gpa.destroy(s);
        }
        l.in.deinit(p.gpa);
        l.out.deinit(p.gpa);
        l.asked.deinit(p.gpa);
        p.gpa.destroy(l);
    }

    /// Whether the Runner listens, which keeps it running.
    pub fn listening(p: *const Peers) bool {
        return p.listener != null;
    }

    pub fn start(p: *Peers, group: ?*c.talk_group) !void {
        p.group = group;
        var shown: [256]u8 = undefined;
        if (p.identity != null) p.log(std.fmt.bufPrint(&shown, "peer: key {s}", .{&p.fingerprint}) catch unreachable);
        const at = p.listen_at orelse return;
        const port = try p.openListener(at);
        var buf: [128]u8 = undefined;
        const host = if (std.mem.indexOfScalar(u8, at.host, ':') != null)
            std.fmt.bufPrint(&buf, "[{s}]", .{at.host}) catch at.host
        else
            at.host;
        if (at.plain) {
            p.log(std.fmt.bufPrint(&shown, "peer: listening on tcp://{s}:{d}", .{ host, port }) catch return);
        } else {
            p.log(std.fmt.bufPrint(&shown, "peer: listening on tls://{s}:{d}#{s}", .{ host, port, &p.fingerprint }) catch return);
        }
    }

    pub fn stopListening(p: *Peers) void {
        if (p.listener) |fd| _ = sys.close(fd);
        p.listener = null;
    }

    // ------------------------------------------------------------ sockets

    fn sockaddrOf(at: Address, storage: *sys.sockaddr.storage, size: *sys.socklen_t) !c_uint {
        const literal = if (std.ascii.eqlIgnoreCase(at.host, "localhost")) "127.0.0.1" else at.host;
        const address = std.Io.net.IpAddress.parse(literal, at.port) catch return resolve(at, storage, size);
        switch (address) {
            .ip4 => |a| {
                const in: sys.sockaddr.in = .{ .port = std.mem.nativeToBig(u16, at.port), .addr = @bitCast(a.bytes) };
                @memcpy(std.mem.asBytes(storage)[0..@sizeOf(sys.sockaddr.in)], std.mem.asBytes(&in));
                size.* = @sizeOf(sys.sockaddr.in);
                return sys.AF.INET;
            },
            .ip6 => |a| {
                const in6: sys.sockaddr.in6 = .{ .port = std.mem.nativeToBig(u16, at.port), .flowinfo = 0, .addr = a.bytes, .scope_id = 0 };
                @memcpy(std.mem.asBytes(storage)[0..@sizeOf(sys.sockaddr.in6)], std.mem.asBytes(&in6));
                size.* = @sizeOf(sys.sockaddr.in6);
                return sys.AF.INET6;
            },
        }
    }

    /// A host name, looked up as the dial waits; a TLS address may name one.
    fn resolve(at: Address, storage: *sys.sockaddr.storage, size: *sys.socklen_t) !c_uint {
        if (at.plain or at.host.len >= 256) return error.BadAddress;
        var name: [256:0]u8 = undefined;
        @memcpy(name[0..at.host.len], at.host);
        name[at.host.len] = 0;
        var service_buf: [8:0]u8 = undefined;
        const digits = std.fmt.bufPrint(&service_buf, "{d}", .{at.port}) catch return error.BadAddress;
        service_buf[digits.len] = 0;
        const service: [*:0]const u8 = &service_buf;
        const hints: sys.addrinfo = .{ .flags = .{}, .family = sys.AF.UNSPEC, .socktype = sys.SOCK.STREAM, .protocol = 0, .addrlen = 0, .addr = null, .canonname = null, .next = null };
        var found: ?*sys.addrinfo = null;
        if (@backingInt(sys.getaddrinfo(&name, service, &hints, &found)) != 0) return error.BadAddress;
        defer sys.freeaddrinfo(found.?);
        const first = found orelse return error.BadAddress;
        const addr = first.addr orelse return error.BadAddress;
        @memcpy(std.mem.asBytes(storage)[0..first.addrlen], @as([*]const u8, @ptrCast(addr))[0..first.addrlen]);
        size.* = first.addrlen;
        return @intCast(first.family);
    }

    fn nonBlocking(fd: posix.fd_t) !void {
        const flags = sys.fcntl(fd, sys.F.GETFL);
        if (flags < 0) return error.SystemResources;
        if (sys.fcntl(fd, sys.F.SETFL, flags | @as(c_int, 1 << @bitOffsetOf(sys.O, "NONBLOCK"))) < 0) return error.SystemResources;
    }

    fn openListener(p: *Peers, at: Address) !u16 {
        var storage: sys.sockaddr.storage = undefined;
        var size: sys.socklen_t = 0;
        const family = try sockaddrOf(at, &storage, &size);
        const fd = sys.socket(family, sys.SOCK.STREAM, 0);
        if (fd < 0) return error.SystemResources;
        errdefer _ = sys.close(fd);
        const one: c_int = 1;
        _ = sys.setsockopt(fd, sys.SOL.SOCKET, sys.SO.REUSEADDR, &one, @sizeOf(c_int));
        if (sys.bind(fd, @ptrCast(&storage), size) != 0) return error.BadAddress;
        if (sys.listen(fd, 128) != 0) return error.BadAddress;
        var bound: sys.sockaddr.storage = undefined;
        var bound_size: sys.socklen_t = @sizeOf(sys.sockaddr.storage);
        if (sys.getsockname(fd, @ptrCast(&bound), &bound_size) != 0) return error.BadAddress;
        const port = if (family == sys.AF.INET)
            std.mem.bigToNative(u16, @as(*const sys.sockaddr.in, @ptrCast(&bound)).port)
        else
            std.mem.bigToNative(u16, @as(*const sys.sockaddr.in6, @ptrCast(&bound)).port);
        try nonBlocking(fd);
        p.listener = fd;
        return port;
    }

    /// A new link on a connected socket: a TLS one starts its handshake,
    /// with the key pinned when it dialled, and a plain one says hello.
    fn adopt(p: *Peers, fd: posix.fd_t, remote: ?[]const u8, plain: bool, pin: ?tls.keys.Fingerprint) !*Link {
        try nonBlocking(fd);
        const l = try p.gpa.create(Link);
        errdefer p.gpa.destroy(l);
        l.* = .{ .fd = fd, .remote = remote };
        if (!plain) {
            const id = p.identity orelse return error.NoKey;
            const s = try p.gpa.create(tls.session.Session);
            errdefer p.gpa.destroy(s);
            s.* = try tls.session.Session.init(p.gpa, p.io, if (pin != null) .client else .server, id, pin, &l.out);
            l.tls = s;
            // A dialled key is pinned: anything else fails the handshake.
            if (pin) |k| {
                l.key = k;
                l.known = true;
            }
        }
        try p.links.append(p.gpa, l);
        if (l.tls != null) {
            p.flush(l);
            return l;
        }
        var key: ?*c.talk_value = null;
        _ = c.talk_text(&p.fingerprint, p.fingerprint.len, &key);
        defer c.talk_value_release(key);
        p.sendPairs(l, &.{.{ .key = "hello", .key_len = 5, .value = key }});
        return l;
    }

    /// A link to the Runner a `--peer` names, dialled if none is open. The
    /// Runner waits for the connection, though not for a TLS handshake.
    fn dial(p: *Peers, name: []const u8) ?*Link {
        for (p.links.items) |l| if (!l.gone and l.remote != null and std.mem.eql(u8, l.remote.?, name)) return l;
        const remote = for (p.remotes) |r| {
            if (std.mem.eql(u8, r.name, name)) break r;
        } else return null;
        return p.dialRemote(remote);
    }

    fn dialRemote(p: *Peers, remote: Remote) ?*Link {
        const name = remote.name;
        var storage: sys.sockaddr.storage = undefined;
        var size: sys.socklen_t = 0;
        const family = sockaddrOf(remote.address, &storage, &size) catch return null;
        const fd = sys.socket(family, sys.SOCK.STREAM, 0);
        if (fd < 0) return null;
        if (sys.connect(fd, @ptrCast(&storage), size) != 0) {
            _ = sys.close(fd);
            var shown: [256]u8 = undefined;
            p.log(std.fmt.bufPrint(&shown, "peer: {s}: can't connect", .{name}) catch "peer: can't connect");
            return null;
        }
        return p.adopt(fd, name, remote.address.plain, remote.address.pin) catch {
            _ = sys.close(fd);
            return null;
        };
    }

    /// A link to the Runner with this key: one open to it, one a `--peer`
    /// dialled once it has said so, or a new one to the `--peer` that pins it.
    fn linkTo(p: *Peers, key: []const u8) ?*Link {
        for (p.links.items) |l| if (!l.gone and l.known and std.mem.eql(u8, &l.key, key)) return l;
        for (p.remotes) |r| if (r.address.pin) |pin| if (std.mem.eql(u8, &pin, key)) return p.dialRemote(r);
        return null;
    }

    /// The name a `--peer` gives a TLS key, if one pins it.
    fn nameOf(p: *const Peers, key: []const u8) ?[]const u8 {
        for (p.remotes) |r| if (r.address.pin) |pin| if (std.mem.eql(u8, &pin, key)) return r.name;
        return null;
    }

    pub fn collect(p: *Peers, fds: *std.ArrayList(posix.pollfd)) !void {
        p.polled.clearRetainingCapacity();
        if (p.listener) |fd| {
            try fds.append(p.gpa, .{ .fd = fd, .events = posix.POLL.IN, .revents = 0 });
            try p.polled.append(p.gpa, null);
        }
        for (p.links.items) |l| {
            if (l.gone) continue;
            var events: i16 = posix.POLL.IN;
            if (l.out.items.len > l.sent) events |= posix.POLL.OUT;
            try fds.append(p.gpa, .{ .fd = l.fd, .events = events, .revents = 0 });
            try p.polled.append(p.gpa, l);
        }
    }

    pub fn ready(p: *Peers, fds: []const posix.pollfd) void {
        for (fds, p.polled.items) |fd, what| {
            if (fd.revents == 0) continue;
            const l = what orelse {
                p.accept();
                continue;
            };
            if (l.gone) continue;
            if (fd.revents & posix.POLL.OUT != 0) p.flush(l);
            if (fd.revents & (posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR) != 0) p.read(l);
        }
        p.sweep();
    }

    fn accept(p: *Peers) void {
        const listener = p.listener orelse return;
        while (true) {
            const fd = sys.accept(listener, null, null);
            if (fd < 0) return;
            _ = p.adopt(fd, null, p.listen_at.?.plain, null) catch {
                _ = sys.close(fd);
            };
        }
    }

    fn flush(p: *Peers, l: *Link) void {
        _ = p;
        while (l.sent < l.out.items.len) {
            const rest = l.out.items[l.sent..];
            const n = sys.write(l.fd, rest.ptr, rest.len);
            if (n < 0) {
                if (sys.errno(n) != .AGAIN) l.gone = true;
                return;
            }
            l.sent += @intCast(n);
        }
        l.out.clearRetainingCapacity();
        l.sent = 0;
    }

    fn read(p: *Peers, l: *Link) void {
        var buf: [16 * 1024]u8 = undefined;
        while (true) {
            const n = sys.read(l.fd, &buf, buf.len);
            if (n == 0) {
                l.gone = true;
                break;
            }
            if (n < 0) {
                if (sys.errno(n) != .AGAIN) l.gone = true;
                break;
            }
            const got = buf[0..@intCast(n)];
            if (l.tls) |s| {
                // Handshake replies go out; the frames it carries come in.
                s.feed(p.gpa, got, &l.out, &l.in) catch {
                    l.gone = true;
                };
                if (s.connected() and !l.known) {
                    l.key = s.peer.?;
                    l.known = true;
                }
                p.flush(l);
                if (l.gone) return;
            } else l.in.appendSlice(p.gpa, got) catch {
                l.gone = true;
                return;
            };
        }
        if (l.in.items.len > 0 and !l.known) {
            // Only a plain link says hello, and frames over TLS wait for the handshake.
            if (l.tls != null) {
                l.gone = true;
                return;
            }
        }
        while (l.in.items.len >= 4) {
            const len = std.mem.readInt(u32, l.in.items[0..4], .big);
            if (len > max_frame) {
                l.gone = true;
                return;
            }
            if (l.in.items.len < 4 + len) break;
            var frame: ?*c.talk_value = null;
            const ok = c.talk_decode_value(l.in.items[4 .. 4 + len].ptr, len, resolvePeer, p, &frame) == c.TALK_OK;
            std.mem.copyForwards(u8, l.in.items, l.in.items[4 + len ..]);
            l.in.shrinkRetainingCapacity(l.in.items.len - 4 - len);
            if (!ok) {
                l.gone = true;
                return;
            }
            defer c.talk_value_release(frame);
            p.arrive(l, frame.?);
        }
    }

    /// Ends each closed link, failing what it still owed.
    fn sweep(p: *Peers) void {
        var i: usize = 0;
        while (i < p.links.items.len) {
            const l = p.links.items[i];
            if (!l.gone) {
                i += 1;
                continue;
            }
            var it = l.asked.valueIterator();
            while (it.next()) |asked| switch (asked.*) {
                .reach => |call| p.failCall(call, "bad address", null),
                .call => |call| p.failSend(call, "unreachable", null),
            };
            var waiting = p.incoming.iterator();
            while (waiting.next()) |entry| if (entry.value_ptr.link == l) {
                entry.value_ptr.n = std.math.maxInt(u64);
            };
            _ = p.links.swapRemove(i);
            p.freeLink(l);
        }
    }

    // ------------------------------------------------------------ frames

    fn sendPairs(p: *Peers, l: *Link, pairs: []const c.talk_pair) void {
        var frame: ?*c.talk_value = null;
        if (c.talk_map(pairs.ptr, pairs.len, &frame) != c.TALK_OK) return;
        defer c.talk_value_release(frame);
        var body: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_encode_value(frame, &body) != c.TALK_OK) return;
        defer c.talk_owned_bytes_release(&body);
        if (body.len > max_frame) return;
        var head: [4]u8 = undefined;
        std.mem.writeInt(u32, &head, @intCast(body.len), .big);
        if (l.tls) |s| {
            s.send(p.gpa, &head, &l.out) catch return;
            s.send(p.gpa, body.data[0..body.len], &l.out) catch return;
        } else {
            l.out.appendSlice(p.gpa, &head) catch return;
            l.out.appendSlice(p.gpa, body.data[0..body.len]) catch return;
        }
        p.flush(l);
    }

    fn resolvePeer(context: ?*anyopaque, kind: [*c]const u8, kind_len: usize, id: [*c]const u8, id_len: usize) callconv(.c) ?*c.talk_value {
        const p: *Peers = @ptrCast(@alignCast(context.?));
        if (!std.mem.eql(u8, kind[0..kind_len], "peer")) return null;
        return p.peerFor(id[0..id_len]);
    }

    /// This Group's one Peer for an exposure id, borrowed from the Runner.
    fn peerFor(p: *Peers, id: []const u8) ?*c.talk_value {
        if (p.peers.get(id)) |v| return v;
        var o: ?*c.talk_object = null;
        if (!c.talk_object_by_id(p.group, "peer", 4, id.ptr, id.len, &o)) {
            if (c.talk_group_object(p.group, c.talk_peer_kind(p.core), id.ptr, id.len, null, &o) != c.TALK_OK) return null;
        }
        var v: ?*c.talk_value = null;
        if (c.talk_object_value(o, &v) != c.TALK_OK) return null;
        const key = p.gpa.dupe(u8, id) catch return null;
        p.peers.put(p.gpa, key, v.?) catch return null;
        return v;
    }

    fn get(v: *c.talk_value, key: []const u8) ?*c.talk_value {
        var out: ?*c.talk_value = null;
        if (c.talk_value_get(v, key.ptr, key.len, &out) != c.TALK_OK) return null;
        if (c.talk_value_kind(out) == c.TALK_KIND_NOTHING) {
            c.talk_value_release(out);
            return null;
        }
        return out;
    }

    fn has(v: *c.talk_value, key: []const u8) bool {
        var i: usize = 0;
        var pair: c.talk_pair = undefined;
        while (c.talk_value_entries(v, i, &pair)) : (i += 1) {
            defer c.talk_value_release(pair.value);
            if (std.mem.eql(u8, pair.key[0..pair.key_len], key)) return true;
        }
        return false;
    }

    fn textOf(v: ?*const c.talk_value) ?[]const u8 {
        var s: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(v, &s, &n)) return null;
        return if (n == 0) "" else s[0..n];
    }

    fn wholeOf(v: ?*const c.talk_value) ?u64 {
        var d: ?*const c.talk_decimal = null;
        if (!c.talk_value_as_dec(v, &d)) return null;
        var n: u64 = 0;
        if (c.talk_decimal_uint64(d, &n) != c.TALK_OK) return null;
        return n;
    }

    fn splitId(id: []const u8) ?struct { key: []const u8, secret: []const u8 } {
        if (id.len != 64 + 1 + 32 or id[64] != '/') return null;
        for (id[0..64]) |ch| if (!std.ascii.isHex(ch) or std.ascii.isUpper(ch)) return null;
        for (id[65..]) |ch| if (!std.ascii.isHex(ch) or std.ascii.isUpper(ch)) return null;
        return .{ .key = id[0..64], .secret = id[65..] };
    }

    fn number(n: u64) ?*c.talk_value {
        var v: ?*c.talk_value = null;
        _ = c.talk_int(@intCast(n), &v);
        return v;
    }

    fn text(s: []const u8) ?*c.talk_value {
        var v: ?*c.talk_value = null;
        _ = c.talk_text(s.ptr, s.len, &v);
        return v;
    }

    fn arrive(p: *Peers, l: *Link, frame: *c.talk_value) void {
        if (!l.known) {
            // A plain link's first frame says which key the other end is.
            const hello = get(frame, "hello") orelse {
                l.gone = true;
                return;
            };
            defer c.talk_value_release(hello);
            const key = textOf(hello) orelse "";
            if (key.len != 64) {
                l.gone = true;
                return;
            }
            @memcpy(&l.key, key);
            l.known = true;
            return;
        }
        inline for (.{ "reached", "replied" }) |answer_key| {
            if (get(frame, answer_key)) |n_value| {
                defer c.talk_value_release(n_value);
                const n = wholeOf(n_value) orelse return;
                const asked = l.asked.fetchRemove(n) orelse return;
                p.answered(l, asked.value, frame);
                return;
            }
        }
        if (get(frame, "reach")) |n_value| {
            defer c.talk_value_release(n_value);
            const n = wholeOf(n_value) orelse return;
            const name_value = get(frame, "name");
            defer if (name_value) |v| c.talk_value_release(v);
            const name = if (name_value) |v| textOf(v) orelse "" else "";
            const nv = number(n);
            defer c.talk_value_release(nv);
            if (p.names.get(name)) |secret| {
                var buf: [97]u8 = undefined;
                const id = std.fmt.bufPrint(&buf, "{s}/{s}", .{ &p.fingerprint, secret }) catch return;
                const idv = text(id);
                defer c.talk_value_release(idv);
                p.sendPairs(l, &.{ .{ .key = "reached", .key_len = 7, .value = nv }, .{ .key = "peer", .key_len = 4, .value = idv } });
            } else {
                const err = text("not exposed");
                defer c.talk_value_release(err);
                p.sendPairs(l, &.{ .{ .key = "reached", .key_len = 7, .value = nv }, .{ .key = "error", .key_len = 5, .value = err } });
            }
            return;
        }
        const message_value = get(frame, "message");
        defer if (message_value) |v| c.talk_value_release(v);
        const message = if (message_value) |v| textOf(v) orelse "" else "";
        const args = get(frame, "args");
        defer if (args) |v| c.talk_value_release(v);
        if (get(frame, "post")) |to| {
            defer c.talk_value_release(to);
            const parts = splitId(textOf(to) orelse "") orelse return;
            if (std.mem.eql(u8, parts.key, &p.fingerprint)) _ = p.local(parts.secret, message, args, null, l);
            return;
        }
        const n_value = get(frame, "call") orelse return;
        defer c.talk_value_release(n_value);
        const n = wholeOf(n_value) orelse return;
        const to = get(frame, "to");
        defer if (to) |v| c.talk_value_release(v);
        const parts = splitId(if (to) |v| textOf(v) orelse "" else "") orelse return p.reply(l, n, "not exposed", null, null);
        if (!std.mem.eql(u8, parts.key, &p.fingerprint)) return p.reply(l, n, "not exposed", null, null);
        if (p.local(parts.secret, message, args, .{ .link = l, .n = n }, l)) |reason| p.reply(l, n, reason, null, null);
    }

    /// Answers a `call` that arrived: with its reply, or `failed`.
    fn reply(p: *Peers, l: *Link, n: u64, reason: ?[]const u8, err: ?*c.talk_value, value: ?*c.talk_value) void {
        const nv = number(n);
        defer c.talk_value_release(nv);
        if (reason) |why| {
            const rv = text(why);
            defer c.talk_value_release(rv);
            var pairs: [2]c.talk_pair = .{ .{ .key = "reason", .key_len = 6, .value = rv }, undefined };
            var count: usize = 1;
            if (err) |e| {
                pairs[1] = .{ .key = "error", .key_len = 5, .value = e };
                count = 2;
            }
            var failed: ?*c.talk_value = null;
            if (c.talk_map(&pairs, count, &failed) != c.TALK_OK) return;
            defer c.talk_value_release(failed);
            p.sendPairs(l, &.{ .{ .key = "replied", .key_len = 7, .value = nv }, .{ .key = "failed", .key_len = 6, .value = failed } });
            return;
        }
        p.sendPairs(l, &.{ .{ .key = "replied", .key_len = 7, .value = nv }, .{ .key = "value", .key_len = 5, .value = value } });
    }

    /// Gives a Remote Send to this Runner's exposure: a Delivery, or for a
    /// call that `waits` a Request answered when its Run ends. The reason
    /// when it can't go.
    fn local(p: *Peers, secret: []const u8, message: []const u8, args: ?*c.talk_value, waits: ?Incoming, from: ?*Link) ?[]const u8 {
        // Over TLS the sending key is known; over plain TCP, or from this
        // Runner itself, nobody is vouched for.
        const sender: ?[64]u8 = if (from) |l| if (l.tls != null) l.key else null else null;
        const held = p.exposures.get(secret) orelse return if (waits != null) "not exposed" else null;
        const script = c.talk_group_script(p.group, held.script.ptr, held.script.len) orelse return if (waits != null) "not exposed" else null;
        var values: std.ArrayList(?*c.talk_value) = .empty;
        defer {
            for (values.items) |v| c.talk_value_release(v);
            values.deinit(p.gpa);
        }
        if (args) |list| for (0..c.talk_value_len(list)) |k| {
            var v: ?*c.talk_value = null;
            if (c.talk_value_index(list, k + 1, &v) == c.TALK_OK) values.append(p.gpa, v) catch {};
        };
        const m: c.talk_message = .{ .name = message.ptr, .name_len = message.len, .args = values.items.ptr, .args_len = values.items.len, .limits = null };
        var id: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        defer if (id.data != null) c.talk_owned_bytes_release(&id);
        p.dirty = true;
        if (waits) |w| {
            var pending: ?*c.talk_pending = null;
            const code = c.talk_script_request(script, &m, &id, &pending);
            if (pending) |x| c.talk_pending_release(x);
            if (code == c.TALK_ERR_MAILBOX_FULL) return "mailbox full";
            if (code != c.TALK_OK) return "unreachable";
            const key = p.gpa.dupe(u8, id.data[0..id.len]) catch return "unreachable";
            p.incoming.put(p.gpa, key, w) catch return "unreachable";
            p.remote_deliveries.put(p.gpa, key, sender) catch {};
            return null;
        }
        if (c.talk_script_deliver(script, &m, &id) == c.TALK_OK and id.data != null) {
            const key = p.gpa.dupe(u8, id.data[0..id.len]) catch return null;
            p.remote_deliveries.put(p.gpa, key, sender) catch {};
        }
        return null;
    }

    /// After each Pump: answers the `call`s whose Runs ended.
    pub fn pumped(p: *Peers, reports: []const c.talk_report) void {
        for (reports) |*report| {
            if (report.kind != c.TALK_REPORT_RUN_END) continue;
            const x = report.as.run_end;
            if (x.delivery_len == 0) continue;
            const waiting = p.incoming.fetchRemove(x.delivery[0..x.delivery_len]) orelse continue;
            const w = waiting.value;
            if (w.call) |call| {
                p.settleOwn(call, x);
                continue;
            }
            if (w.n == std.math.maxInt(u64)) continue; // its link has gone
            const link = w.link.?;
            switch (x.outcome) {
                c.TALK_COMPLETED => p.reply(link, w.n, null, null, x.result),
                c.TALK_ERRORED => p.reply(link, w.n, "errored", if (x.@"error" != null) x.@"error".*.data else null, null),
                c.TALK_LIMIT_FAULT => p.reply(link, w.n, "limit fault", null, null),
                c.TALK_CANCELLED => p.reply(link, w.n, "cancelled", null, null),
                c.TALK_UNHANDLED_OUTCOME => p.reply(link, w.n, "unhandled", null, null),
                c.TALK_DROPPED => p.reply(link, w.n, "dropped", null, null),
                c.TALK_EFFECT_FAILURE_OUTCOME => p.reply(link, w.n, "effect failed", null, null),
                else => p.reply(link, w.n, "unreachable", null, null),
            }
        }
    }

    /// Settles this Runner's own `call` to its own exposure from the Run's end.
    fn settleOwn(p: *Peers, call: *c.talk_call, x: c.talk_run_end) void {
        const reason: []const u8 = switch (x.outcome) {
            c.TALK_COMPLETED => {
                _ = c.talk_call_answer(call, x.result);
                p.dirty = true;
                return;
            },
            c.TALK_ERRORED => "errored",
            c.TALK_LIMIT_FAULT => "limit fault",
            c.TALK_CANCELLED => "cancelled",
            c.TALK_UNHANDLED_OUTCOME => "unhandled",
            c.TALK_DROPPED => "dropped",
            c.TALK_EFFECT_FAILURE_OUTCOME => "effect failed",
            else => "unreachable",
        };
        p.failSend(call, reason, if (x.outcome == c.TALK_ERRORED) if (x.@"error" != null) x.@"error".*.data else null else null);
    }

    /// An answer that arrived for one of this Runner's questions.
    fn answered(p: *Peers, l: *Link, asked: Asked, frame: *c.talk_value) void {
        switch (asked) {
            .reach => |call| {
                const id_value = get(frame, "peer") orelse return p.failCall(call, "not exposed", null);
                defer c.talk_value_release(id_value);
                const id = textOf(id_value) orelse "";
                const parts = splitId(id) orelse return p.failCall(call, "not exposed", null);
                if (!std.mem.eql(u8, parts.key, &l.key)) return p.failCall(call, "not exposed", null);
                const peer = p.peerFor(id) orelse return p.failCall(call, "bad address", null);
                _ = c.talk_call_answer(call, peer);
                p.dirty = true;
            },
            .call => |call| {
                if (has(frame, "value")) {
                    var value: ?*c.talk_value = null;
                    _ = c.talk_value_get(frame, "value", 5, &value);
                    defer c.talk_value_release(value);
                    _ = c.talk_call_answer(call, value);
                    p.dirty = true;
                    return;
                }
                const failed = get(frame, "failed") orelse return p.failSend(call, "unreachable", null);
                defer c.talk_value_release(failed);
                const reason_value = get(failed, "reason");
                defer if (reason_value) |v| c.talk_value_release(v);
                const err = get(failed, "error");
                defer if (err) |v| c.talk_value_release(v);
                p.failSend(call, if (reason_value) |v| textOf(v) orelse "unreachable" else "unreachable", err);
            },
        }
    }

    fn failCall(p: *Peers, call: ?*c.talk_call, code: []const u8, data: ?*c.talk_value) void {
        const e: c.talk_script_error = .{ .code = code.ptr, .code_len = code.len, .message = null, .message_len = 0, .data = data };
        _ = c.talk_call_fail(call, &e);
        p.dirty = true;
    }

    fn failSend(p: *Peers, call: ?*c.talk_call, reason: []const u8, err: ?*c.talk_value) void {
        const rv = text(reason);
        defer c.talk_value_release(rv);
        var pairs: [2]c.talk_pair = .{ .{ .key = "reason", .key_len = 6, .value = rv }, undefined };
        var count: usize = 1;
        if (err) |e| {
            pairs[1] = .{ .key = "error", .key_len = 5, .value = e };
            count = 2;
        }
        var data: ?*c.talk_value = null;
        if (c.talk_map(&pairs, count, &data) != c.TALK_OK) return;
        defer c.talk_value_release(data);
        p.failCall(call, "send failed", data);
    }

    /// Answers and failures for calls started in the Pump, given once it
    /// returns: a Host function's own answer is not taken.
    pub fn answerStarted(p: *Peers) void {
        for (p.later.items) |x| {
            if (x.fail) |code| {
                // A send's reason fails it as `send failed`; a `reach` or
                // `expose` fails with the code itself.
                if (x.send) p.failSend(x.call, code, null) else p.failCall(x.call, code, null);
            } else {
                _ = c.talk_call_answer(x.call, x.value);
                p.dirty = true;
            }
        }
        p.later.clearRetainingCapacity();
    }

    // ------------------------------------------------------------ the Host functions

    fn self(context: ?*anyopaque) *Peers {
        return @ptrCast(@alignCast(context.?));
    }

    fn callText(f: *const fn (?*const c.talk_call, [*c][*c]const u8, [*c]usize) callconv(.c) void, call: ?*c.talk_call) []const u8 {
        var s: [*c]const u8 = null;
        var n: usize = 0;
        f(call, &s, &n);
        return if (n == 0) "" else s[0..n];
    }

    fn expose(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = result;
        _ = err;
        const p = self(context);
        const caller_script = callText(c.talk_call_script_name, call);
        const name: ?[]const u8 = if (len > 0) textOf(args[0]) else null;
        if (name) |n| if (p.names.get(n)) |secret| {
            if (!std.mem.eql(u8, p.exposures.get(secret).?.script, caller_script)) {
                p.later.append(p.gpa, .{ .call = call, .value = null, .fail = "name in use" }) catch return c.TALK_CALL_BROKEN;
                return c.TALK_CALL_STARTED;
            }
            return p.answerPeer(call, secret);
        };
        const script = p.gpa.dupe(u8, caller_script) catch return c.TALK_CALL_BROKEN;
        var raw: [16]u8 = undefined;
        p.io.random(&raw);
        const secret = p.gpa.dupe(u8, &std.fmt.bytesToHex(raw, .lower)) catch return c.TALK_CALL_BROKEN;
        const owned_name: ?[]const u8 = if (name) |n| p.gpa.dupe(u8, n) catch return c.TALK_CALL_BROKEN else null;
        p.exposures.put(p.gpa, secret, .{ .name = owned_name, .script = script }) catch return c.TALK_CALL_BROKEN;
        if (owned_name) |n| p.names.put(p.gpa, n, secret) catch return c.TALK_CALL_BROKEN;
        return p.answerPeer(call, secret);
    }

    fn answerPeer(p: *Peers, call: ?*c.talk_call, secret: []const u8) c.talk_call_end {
        var buf: [97]u8 = undefined;
        const id = std.fmt.bufPrint(&buf, "{s}/{s}", .{ &p.fingerprint, secret }) catch return c.TALK_CALL_BROKEN;
        const peer = p.peerFor(id) orelse return c.TALK_CALL_BROKEN;
        p.later.append(p.gpa, .{ .call = call, .value = peer }) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_STARTED;
    }

    fn unexpose(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        const p = self(context);
        _ = c.talk_nothing(result);
        if (len == 0) return c.TALK_CALL_ANSWERED;
        const script = callText(c.talk_call_script_name, call);
        var secret: ?[]const u8 = null;
        if (textOf(args[0])) |name| secret = p.names.get(name) else {
            var o: ?*c.talk_object = null;
            if (c.talk_value_as_object(p.group, args[0], &o)) {
                var s: [*c]const u8 = null;
                var n: usize = 0;
                c.talk_object_id(o, &s, &n);
                if (splitId(s[0..n])) |parts| secret = parts.secret;
            }
        }
        const key = secret orelse return c.TALK_CALL_ANSWERED;
        const held = p.exposures.get(key) orelse return c.TALK_CALL_ANSWERED;
        if (!std.mem.eql(u8, held.script, script)) return c.TALK_CALL_ANSWERED;
        if (held.name) |n| _ = p.names.remove(n);
        const removed = p.exposures.fetchRemove(key).?;
        p.gpa.free(removed.key);
        if (removed.value.name) |n| p.gpa.free(n);
        p.gpa.free(removed.value.script);
        return c.TALK_CALL_ANSWERED;
    }

    fn reach(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = result;
        _ = err;
        const p = self(context);
        const address = if (len > 0) textOf(args[0]) orelse "" else "";
        const l = p.dial(address) orelse {
            p.later.append(p.gpa, .{ .call = call, .value = null, .fail = "bad address" }) catch return c.TALK_CALL_BROKEN;
            return c.TALK_CALL_STARTED;
        };
        return p.ask(l, .{ .reach = call }, &.{.{ .key = "name", .key_len = 4, .value = args[0] }}, "reach");
    }

    fn ask(p: *Peers, l: *Link, asked: Asked, rest: []const c.talk_pair, kind: []const u8) c.talk_call_end {
        l.next += 1;
        l.asked.put(p.gpa, l.next, asked) catch return c.TALK_CALL_BROKEN;
        const nv = number(l.next);
        defer c.talk_value_release(nv);
        var pairs: std.ArrayList(c.talk_pair) = .empty;
        defer pairs.deinit(p.gpa);
        pairs.append(p.gpa, .{ .key = kind.ptr, .key_len = kind.len, .value = nv }) catch return c.TALK_CALL_BROKEN;
        pairs.appendSlice(p.gpa, rest) catch return c.TALK_CALL_BROKEN;
        p.sendPairs(l, pairs.items);
        return c.TALK_CALL_STARTED;
    }

    fn remoteSend(p: *Peers, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, waits: bool) c.talk_call_end {
        if (len < 3) return c.TALK_CALL_BROKEN;
        var o: ?*c.talk_object = null;
        if (!c.talk_value_as_object(p.group, args[0], &o)) return c.TALK_CALL_BROKEN;
        var s: [*c]const u8 = null;
        var n: usize = 0;
        c.talk_object_id(o, &s, &n);
        const id = s[0..n];
        const message = textOf(args[1]) orelse "";
        const parts = splitId(id) orelse return p.unreachable_(call, waits);
        if (std.mem.eql(u8, parts.key, &p.fingerprint)) {
            // A Peer of this Runner's own exposure: still a Remote Send,
            // answered once the Pump returns and the Run ends.
            if (!waits) {
                _ = p.local(parts.secret, message, args[2], null, null);
                return c.TALK_CALL_ANSWERED;
            }
            if (p.local(parts.secret, message, args[2], .{ .call = call }, null)) |why| {
                p.later.append(p.gpa, .{ .call = call, .value = null, .fail = why, .send = true }) catch return c.TALK_CALL_BROKEN;
            }
            return c.TALK_CALL_STARTED;
        }
        const l = p.linkTo(parts.key) orelse return p.unreachable_(call, waits);
        const idv = text(id);
        defer c.talk_value_release(idv);
        const rest = [_]c.talk_pair{ .{ .key = if (waits) "to" else "post", .key_len = if (waits) 2 else 4, .value = idv }, .{ .key = "message", .key_len = 7, .value = args[1] }, .{ .key = "args", .key_len = 4, .value = args[2] } };
        if (!waits) {
            p.sendPairs(l, &rest);
            return c.TALK_CALL_ANSWERED;
        }
        return p.ask(l, .{ .call = call }, &rest, "call");
    }

    fn unreachable_(p: *Peers, call: ?*c.talk_call, waits: bool) c.talk_call_end {
        if (!waits) return c.TALK_CALL_ANSWERED;
        p.later.append(p.gpa, .{ .call = call, .value = null, .fail = "unreachable", .send = true }) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_STARTED;
    }

    fn post(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        _ = c.talk_nothing(result);
        return self(context).remoteSend(call, args, len, false);
    }

    fn callOp(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = result;
        _ = err;
        return self(context).remoteSend(call, args, len, true);
    }

    /// The Caller Identity of a Remote Send that arrived over TLS:
    /// `{key}`, with `name` when a `--peer` pins that key. Plain TCP
    /// authenticates nobody, so `caller` gives Nothing for what came that way.
    fn caller(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = args;
        _ = len;
        _ = err;
        const p = self(context);
        const delivery = callText(c.talk_call_delivery, call);
        const sender = (p.remote_deliveries.get(delivery) orelse null) orelse {
            _ = c.talk_nothing(result);
            return c.TALK_CALL_ANSWERED;
        };
        const key = text(&sender);
        defer c.talk_value_release(key);
        const name = if (p.nameOf(&sender)) |n| text(n) else null;
        defer if (name) |v| c.talk_value_release(v);
        var pairs: [2]c.talk_pair = .{ .{ .key = "key", .key_len = 3, .value = key }, undefined };
        var count: usize = 1;
        if (name) |v| {
            pairs[1] = .{ .key = "name", .key_len = 4, .value = v };
            count = 2;
        }
        if (c.talk_map(&pairs, count, result) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }

    /// The `peer` Capability, with this Runner's Host functions.
    pub fn capability(p: *Peers) !?*c.talk_capability_def {
        const names = [_][]const u8{ "expose", "unexpose", "reach", "post", "call", "caller" };
        var costs: [names.len]c.talk_named_cost = undefined;
        for (names, &costs) |n, *x| x.* = .{ .name = n.ptr, .name_len = n.len, .cost = .{ .fuel = 0, .alloc = 0 } };
        const impl: c.talk_peer_impl = .{ .context = p, .expose = expose, .unexpose = unexpose, .reach = reach, .post = post, .call = callOp, .caller = caller };
        var def: ?*c.talk_capability_def = null;
        if (c.talk_peer_capability(p.core, &impl, &.{ .entries = &costs, .len = costs.len }, &def) != c.TALK_OK) return error.HostError;
        _ = c.talk_peer_kind(p.core);
        return def;
    }
};

test "the native Runner listens and dials over TLS anywhere, and over tcp:// on loopback only" {
    const listen = try parseListen("127.0.0.1:7400");
    try std.testing.expectEqual(@as(u16, 7400), listen.port);
    try std.testing.expect(!listen.plain);
    try std.testing.expect(!(try parseListen("tls://192.0.2.1:7400")).plain);
    try std.testing.expect((try parseListen("tcp://127.0.0.1:7400")).plain);
    try std.testing.expectError(error.NotLoopback, parseListen("tcp://192.0.2.1:7400"));
    try std.testing.expectError(error.Malformed, parseListen("udp://127.0.0.1:7400"));
    const r = try parsePeer("billing=tcp://[::1]:7400");
    try std.testing.expectEqualStrings("billing", r.name);
    try std.testing.expectEqualStrings("::1", r.address.host);
    const pin = "3f9c" ++ @as([60]u8, @splat('0'));
    const t = try parsePeer("billing=tls://192.0.2.1:7400#" ++ pin);
    try std.testing.expectEqualStrings(pin, &t.address.pin.?);
    try std.testing.expectEqualStrings("192.0.2.1", t.address.host);
    try std.testing.expectError(error.Malformed, parsePeer("billing=tls://127.0.0.1:7400"));
    try std.testing.expectError(error.Malformed, parsePeer("billing=tls://127.0.0.1:7400#3F9C" ++ @as([60]u8, @splat('0'))));
}

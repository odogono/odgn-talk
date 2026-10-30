//! The HTTP router (chapter 9, The HTTP router; ADR 0124) of the native
//! Script Runner: the Host side of the optional `http` Standard Capability
//! over talk.h. It holds Serve Registrations, listens on non-blocking
//! sockets the Runner's poll loop drives, turns each request into a
//! Delivery, and answers the HTTP Exchange from `respond` or, failing that,
//! from the Pump's reports. Its semantics are the TS and Go routers'
//! (impl/ts/src/http/router.ts, impl/go/internal/httphost/host.go): one listener per
//! address shared by its registrations, the longest prefix, a 1 MiB body
//! limit answered 413, and 404, 500 and 503 for what the Script didn't
//! answer.
const std = @import("std");
const c = @import("talk-c");
const request = @import("request.zig");

const sys = std.c;
const posix = std.posix;
const Allocator = std.mem.Allocator;

/// The largest request body read unless Options says otherwise: 1 MiB.
pub const default_max_body: usize = 1 << 20;
/// The largest request head.
const max_head: usize = 64 * 1024;

pub const Options = struct {
    /// The port every `serve` listens on, whatever it asked for.
    port_override: ?u16 = null,
    /// The host a `serve` without `host` listens on.
    default_host: []const u8 = "127.0.0.1",
    max_body: usize = default_max_body,
    /// Told each 500's cause and each refused Delivery, never the client.
    log: *const fn (context: *anyopaque, line: []const u8) void,
    log_context: *anyopaque,
};

const Listener = struct {
    fd: posix.fd_t,
    host: []const u8,
    port: u16,
    registrations: usize = 0,
    closed: bool = false,
};

const Registration = struct {
    script: []const u8,
    grant: []const u8,
    name: []const u8,
    prefix: []const u8,
    message: []const u8,
    asked_host: []const u8,
    asked_port: u16,
    listener: *Listener,

    fn ownedBy(r: *const Registration, script: []const u8, grant: []const u8) bool {
        return std.mem.eql(u8, r.script, script) and std.mem.eql(u8, r.grant, grant);
    }
};

const Connection = struct {
    fd: posix.fd_t,
    listener: *Listener,
    in: std.ArrayList(u8) = .empty,
    out: std.ArrayList(u8) = .empty,
    sent: usize = 0,
    /// The exchange its current request is, until it is answered.
    exchange: ?u64 = null,
    /// Whether the current request was HEAD, whose answer has no body.
    head_request: bool = false,
    keep_alive: bool = true,
    /// Whether `100 Continue` went out for the current request.
    continued: bool = false,
    /// Close once `out` is written.
    closing: bool = false,
    gone: bool = false,
};

const Exchange = struct {
    id: u64,
    object: ?*c.talk_object = null,
    delivery: []const u8 = "",
    run: ?[]const u8 = null,
    answered: bool = false,
    closed: bool = false,
    connection: ?*Connection,
};

/// What a poll slot the router added watches.
const Polled = union(enum) { listener: *Listener, connection: *Connection };

pub const Router = struct {
    gpa: Allocator,
    options: Options,
    kind: *c.talk_object_kind,
    group: ?*c.talk_group = null,
    registrations: std.ArrayList(*Registration) = .empty,
    listeners: std.ArrayList(*Listener) = .empty,
    connections: std.ArrayList(*Connection) = .empty,
    exchanges: std.AutoArrayHashMapUnmanaged(u64, *Exchange) = .empty,
    by_delivery: std.StringHashMapUnmanaged(u64) = .empty,
    by_run: std.StringHashMapUnmanaged(u64) = .empty,
    polled: std.ArrayList(Polled) = .empty,
    /// `serve` answers for once the Pump returns.
    later: std.ArrayList(struct { call: ?*c.talk_call, value: *c.talk_value }) = .empty,
    /// Exchanges delivered and not yet answered.
    open: usize = 0,
    stopping: bool = false,
    next_exchange: u64 = 0,
    /// Whether the router queued a Host Input since the Runner last pumped.
    queued: bool = false,

    /// Makes a router, defining the httpExchange Object Kind on `core`.
    pub fn init(gpa: Allocator, core: *c.talk_core, options: Options) !*Router {
        const r = try gpa.create(Router);
        errdefer gpa.destroy(r);
        const props = [_]c.talk_prop{.{ .name = "closed", .name_len = 6, .shape = c.talk_bool_shape(), .get = closedProp, .set = null, .context = r, .get_cost = .{ .fuel = 1, .alloc = 0 }, .set_cost = .{ .fuel = 0, .alloc = 0 } }};
        const def: c.talk_object_kind_def = .{ .name = "httpExchange", .name_len = 12, .props = &props, .props_len = props.len, .parent_kinds = null, .parent_kinds_lens = null, .parent_kinds_len = 0, .elements = null };
        var kind: ?*c.talk_object_kind = null;
        if (c.talk_define_object_kind(core, &def, &kind) != c.TALK_OK) return error.HostError;
        r.* = .{ .gpa = gpa, .options = options, .kind = kind.? };
        return r;
    }

    pub fn deinit(r: *Router) void {
        for (r.connections.items) |x| r.freeConnection(x);
        r.connections.deinit(r.gpa);
        for (r.listeners.items) |l| {
            if (!l.closed) _ = sys.close(l.fd);
            r.gpa.free(l.host);
            r.gpa.destroy(l);
        }
        r.listeners.deinit(r.gpa);
        for (r.registrations.items) |x| r.freeRegistration(x);
        r.registrations.deinit(r.gpa);
        for (r.exchanges.values()) |x| r.freeExchange(x);
        r.exchanges.deinit(r.gpa);
        r.by_delivery.deinit(r.gpa);
        r.by_run.deinit(r.gpa);
        r.polled.deinit(r.gpa);
        for (r.later.items) |x| c.talk_value_release(x.value);
        r.later.deinit(r.gpa);
        r.gpa.destroy(r);
    }

    /// The `http` Capability, with every Operation free.
    pub fn capability(r: *Router, core: *c.talk_core) !*c.talk_capability_def {
        const costs = [_]c.talk_named_cost{
            .{ .name = "serve", .name_len = 5, .cost = .{ .fuel = 0, .alloc = 0 } },
            .{ .name = "unserve", .name_len = 7, .cost = .{ .fuel = 0, .alloc = 0 } },
            .{ .name = "respond", .name_len = 7, .cost = .{ .fuel = 0, .alloc = 0 } },
        };
        const impl: c.talk_http_impl = .{ .context = r, .serve = serve, .unserve = unserve, .respond = respond };
        var def: ?*c.talk_capability_def = null;
        if (c.talk_http_capability(core, &impl, &.{ .entries = &costs, .len = costs.len }, &def) != c.TALK_OK) return error.HostError;
        return def.?;
    }

    pub fn registrationCount(r: *const Router) usize {
        return r.registrations.items.len;
    }

    fn log(r: *Router, comptime fmt: []const u8, args: anytype) void {
        var buf: [1024]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, fmt, args) catch buf[0..];
        r.options.log(r.options.log_context, line);
    }

    // ------------------------------------------------------------ the Operations

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

    /// A map's value at `key`, an owned reference, or null when absent or
    /// Nothing.
    fn field(v: ?*const c.talk_value, key: []const u8) ?*c.talk_value {
        var x: ?*c.talk_value = null;
        if (c.talk_value_get(v, key.ptr, key.len, &x) != c.TALK_OK or x == null) return null;
        if (c.talk_value_kind(x) == c.TALK_KIND_NOTHING) {
            c.talk_value_release(x);
            return null;
        }
        return x;
    }

    fn wholeOf(v: ?*const c.talk_value) ?i64 {
        var d: ?*const c.talk_decimal = null;
        if (!c.talk_value_as_dec(v, @ptrCast(&d))) return null;
        var n: i64 = 0;
        if (c.talk_decimal_int64(d, &n) != c.TALK_OK) return null;
        return n;
    }

    fn fail(err: [*c]c.talk_script_error, code: []const u8, message: []const u8) c.talk_call_end {
        err.* = .{ .code = code.ptr, .code_len = code.len, .message = message.ptr, .message_len = message.len, .data = null };
        return c.TALK_CALL_FAILED;
    }

    fn serve(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = result;
        const r: *Router = @ptrCast(@alignCast(context.?));
        if (len < 4) return c.TALK_CALL_BROKEN;
        r.group = c.talk_call_group(call);
        const name = textOf(args[0]) orelse return c.TALK_CALL_BROKEN;
        const prefix = textOf(args[1]) orelse return c.TALK_CALL_BROKEN;
        const message = textOf(args[2]) orelse return c.TALK_CALL_BROKEN;
        var host: []const u8 = r.options.default_host;
        const host_value = field(args[3], "host");
        defer if (host_value) |h| c.talk_value_release(h);
        if (host_value) |h| host = textOf(h) orelse host;
        var port: ?i64 = 0;
        if (field(args[3], "port")) |p| {
            defer c.talk_value_release(p);
            port = wholeOf(p);
        }
        if (r.options.port_override) |o| port = o;
        var shown: [300]u8 = undefined;
        if (port == null or port.? < 0 or port.? > 65535 or host.len == 0) {
            const text = std.fmt.bufPrint(&shown, "{s}:{?d}", .{ host[0..@min(host.len, 200)], port }) catch "bad address";
            return fail(err, "bad address", text);
        }
        const asked_port: u16 = @intCast(port.?);
        const script = callText(c.talk_call_script_name, call);
        const grant = callText(c.talk_call_grant_name, call);
        if (r.stopping) return fail(err, "bad address", "the Host is stopping");
        const existing = r.find(script, grant, name);
        if (existing) |e| if (std.mem.eql(u8, e.prefix, prefix) and std.mem.eql(u8, e.message, message) and std.mem.eql(u8, e.asked_host, host) and e.asked_port == asked_port) {
            return r.answerAddress(call, e.listener);
        };
        var listener: ?*Listener = null;
        if (asked_port != 0) for (r.listeners.items) |l| {
            if (!l.closed and l.port == asked_port and std.mem.eql(u8, l.host, host)) listener = l;
        };
        if (listener) |l| {
            for (r.registrations.items) |x| if (x.listener == l and std.mem.eql(u8, x.prefix, prefix) and !x.ownedBy(script, grant)) {
                const text = std.fmt.bufPrint(&shown, "{s}:{d}{s} is served by another owner", .{ host[0..@min(host.len, 100)], asked_port, prefix[0..@min(prefix.len, 100)] }) catch "served by another owner";
                return fail(err, "address in use", text);
            };
        } else {
            listener = r.listen(host, asked_port) catch |e| {
                const text = std.fmt.bufPrint(&shown, "listen tcp {s}:{d}: {s}", .{ host[0..@min(host.len, 200)], asked_port, @errorName(e) }) catch "listen";
                return fail(err, if (e == error.AddressInUse) "address in use" else "bad address", text);
            };
        }
        const l = listener.?;
        const reg = r.gpa.create(Registration) catch return c.TALK_CALL_BROKEN;
        reg.* = .{
            .script = r.gpa.dupe(u8, script) catch return c.TALK_CALL_BROKEN,
            .grant = r.gpa.dupe(u8, grant) catch return c.TALK_CALL_BROKEN,
            .name = r.gpa.dupe(u8, name) catch return c.TALK_CALL_BROKEN,
            .prefix = r.gpa.dupe(u8, prefix) catch return c.TALK_CALL_BROKEN,
            .message = r.gpa.dupe(u8, message) catch return c.TALK_CALL_BROKEN,
            .asked_host = r.gpa.dupe(u8, host) catch return c.TALK_CALL_BROKEN,
            .asked_port = asked_port,
            .listener = l,
        };
        r.registrations.append(r.gpa, reg) catch return c.TALK_CALL_BROKEN;
        l.registrations += 1;
        if (existing) |e| r.remove(e);
        return r.answerAddress(call, l);
    }

    /// Answers `serve` with where it listens. serve suspends, and a Host
    /// function's own answer to a suspending call is not taken, so the
    /// answer waits until the Pump returns.
    fn answerAddress(r: *Router, call: ?*c.talk_call, l: *Listener) c.talk_call_end {
        var host: ?*c.talk_value = null;
        if (c.talk_text(l.host.ptr, l.host.len, &host) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        defer c.talk_value_release(host);
        var port: ?*c.talk_value = null;
        if (c.talk_int(l.port, &port) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        defer c.talk_value_release(port);
        const pairs = [_]c.talk_pair{ .{ .key = "host", .key_len = 4, .value = host }, .{ .key = "port", .key_len = 4, .value = port } };
        var address: ?*c.talk_value = null;
        if (c.talk_map(&pairs, pairs.len, &address) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        r.later.append(r.gpa, .{ .call = call, .value = address.? }) catch {
            c.talk_value_release(address);
            return c.TALK_CALL_BROKEN;
        };
        return c.TALK_CALL_STARTED;
    }

    /// Answers the `serve` calls started in the last Pump.
    pub fn answerStarted(r: *Router) void {
        for (r.later.items) |x| {
            _ = c.talk_call_answer(x.call, x.value);
            c.talk_value_release(x.value);
            r.queued = true;
        }
        r.later.clearRetainingCapacity();
    }

    fn unserve(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        const r: *Router = @ptrCast(@alignCast(context.?));
        if (len < 1) return c.TALK_CALL_BROKEN;
        const name = textOf(args[0]) orelse return c.TALK_CALL_BROKEN;
        if (r.find(callText(c.talk_call_script_name, call), callText(c.talk_call_grant_name, call), name)) |reg| r.remove(reg);
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn respond(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        const r: *Router = @ptrCast(@alignCast(context.?));
        if (len < 2) return c.TALK_CALL_BROKEN;
        const group = c.talk_call_group(call);
        var o: ?*c.talk_object = null;
        if (!c.talk_value_as_object(group, args[0], &o)) return fail(err, "not owner", "not this Host's exchange");
        const id = @intFromPtr(c.talk_object_native(o));
        const x = r.exchanges.get(id) orelse return fail(err, "already responded", "the exchange is answered");
        const delivery = callText(c.talk_call_delivery, call);
        if (group != r.group or delivery.len == 0 or !std.mem.eql(u8, delivery, x.delivery)) return fail(err, "not owner", "this Run did not receive the exchange");
        if (x.answered) return fail(err, "already responded", "the exchange is answered");
        if (x.closed) return fail(err, "exchange closed", "the client has gone");
        const response = args[1];

        var status: u16 = 200;
        if (field(response, "status")) |s| {
            defer c.talk_value_release(s);
            if (wholeOf(s)) |n| status = std.math.cast(u16, n) orelse 500;
        }
        var arena: std.heap.ArenaAllocator = .init(r.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var headers: std.ArrayList(request.Header) = .empty;
        if (field(response, "headers")) |hs| {
            defer c.talk_value_release(hs);
            var i: usize = 0;
            var pair: c.talk_pair = undefined;
            while (c.talk_value_entries(hs, i, &pair)) : (i += 1) {
                defer c.talk_value_release(pair.value);
                const key = a.dupe(u8, pair.key[0..pair.key_len]) catch return c.TALK_CALL_BROKEN;
                if (textOf(pair.value)) |t| {
                    headers.append(a, .{ .name = key, .value = a.dupe(u8, t) catch return c.TALK_CALL_BROKEN }) catch return c.TALK_CALL_BROKEN;
                    continue;
                }
                for (0..c.talk_value_len(pair.value)) |j| {
                    var item: ?*c.talk_value = null;
                    if (c.talk_value_index(pair.value, j + 1, &item) != c.TALK_OK) continue;
                    defer c.talk_value_release(item);
                    const t = a.dupe(u8, textOf(item) orelse continue) catch return c.TALK_CALL_BROKEN;
                    headers.append(a, .{ .name = key, .value = t }) catch return c.TALK_CALL_BROKEN;
                }
            }
        }
        const has_type = for (headers.items) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "content-type")) break true;
        } else false;
        var body: []const u8 = "";
        var owned: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        defer c.talk_owned_bytes_release(&owned);
        const json = field(response, "json");
        defer if (json) |j| c.talk_value_release(j);
        const given = field(response, "body");
        defer if (given) |b| c.talk_value_release(b);
        if (json != null and textOf(json) != null) {
            body = textOf(json).?;
            if (!has_type) headers.append(a, .{ .name = "content-type", .value = "application/json" }) catch return c.TALK_CALL_BROKEN;
        } else if (given) |b| {
            if (textOf(b)) |t| {
                body = t;
                if (!has_type) headers.append(a, .{ .name = "content-type", .value = "text/plain; charset=utf-8" }) catch return c.TALK_CALL_BROKEN;
            } else if (c.talk_value_as_bytes(b, &owned) == c.TALK_OK) {
                body = if (owned.len == 0) "" else owned.data[0..owned.len];
            }
        }
        x.answered = true;
        r.open -= 1;
        if (x.connection) |conn| {
            conn.exchange = null;
            x.connection = null;
            r.reply(conn, status, headers.items, body);
        }
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn closedProp(context: ?*anyopaque, o: ?*c.talk_object, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        const r: *Router = @ptrCast(@alignCast(context.?));
        const x = r.exchanges.get(@intFromPtr(c.talk_object_native(o)));
        if (c.talk_bool(if (x) |e| e.closed else false, result) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }

    // ------------------------------------------------------------ registrations

    fn find(r: *Router, script: []const u8, grant: []const u8, name: []const u8) ?*Registration {
        for (r.registrations.items) |x| if (x.ownedBy(script, grant) and std.mem.eql(u8, x.name, name)) return x;
        return null;
    }

    /// Drops a registration, closing its listener if it was the last.
    fn remove(r: *Router, reg: *Registration) void {
        const i = std.mem.indexOfScalar(*Registration, r.registrations.items, reg) orelse return;
        _ = r.registrations.orderedRemove(i);
        reg.listener.registrations -= 1;
        if (reg.listener.registrations == 0) r.closeListener(reg.listener);
        r.freeRegistration(reg);
    }

    fn freeRegistration(r: *Router, reg: *Registration) void {
        for ([_][]const u8{ reg.script, reg.grant, reg.name, reg.prefix, reg.message, reg.asked_host }) |s| r.gpa.free(s);
        r.gpa.destroy(reg);
    }

    /// The registration whose prefix is the longest that begins `path`.
    fn match(r: *Router, l: *Listener, path: []const u8) ?*Registration {
        var best: ?*Registration = null;
        for (r.registrations.items) |x| {
            if (x.listener != l or !std.mem.startsWith(u8, path, x.prefix)) continue;
            if (best == null or x.prefix.len > best.?.prefix.len) best = x;
        }
        return best;
    }

    // ------------------------------------------------------------ sockets

    fn listen(r: *Router, host: []const u8, port: u16) !*Listener {
        const literal = if (std.ascii.eqlIgnoreCase(host, "localhost")) "127.0.0.1" else host;
        const address = std.Io.net.IpAddress.parse(literal, port) catch return error.BadAddress;
        var storage: sys.sockaddr.storage = undefined;
        var size: sys.socklen_t = 0;
        var family: c_uint = 0;
        switch (address) {
            .ip4 => |a| {
                const in: sys.sockaddr.in = .{ .port = std.mem.nativeToBig(u16, port), .addr = @bitCast(a.bytes) };
                @memcpy(std.mem.asBytes(&storage)[0..@sizeOf(sys.sockaddr.in)], std.mem.asBytes(&in));
                size = @sizeOf(sys.sockaddr.in);
                family = sys.AF.INET;
            },
            .ip6 => |a| {
                const in6: sys.sockaddr.in6 = .{ .port = std.mem.nativeToBig(u16, port), .flowinfo = 0, .addr = a.bytes, .scope_id = 0 };
                @memcpy(std.mem.asBytes(&storage)[0..@sizeOf(sys.sockaddr.in6)], std.mem.asBytes(&in6));
                size = @sizeOf(sys.sockaddr.in6);
                family = sys.AF.INET6;
            },
        }
        const fd = sys.socket(family, sys.SOCK.STREAM, 0);
        if (fd < 0) return error.SystemResources;
        errdefer _ = sys.close(fd);
        const one: c_int = 1;
        _ = sys.setsockopt(fd, sys.SOL.SOCKET, sys.SO.REUSEADDR, &one, @sizeOf(c_int));
        if (sys.bind(fd, @ptrCast(&storage), size) != 0) {
            return if (sys.errno(@as(c_int, -1)) == .ADDRINUSE) error.AddressInUse else error.BadAddress;
        }
        if (sys.listen(fd, 128) != 0) return error.BadAddress;
        var bound: sys.sockaddr.storage = undefined;
        var bound_size: sys.socklen_t = @sizeOf(sys.sockaddr.storage);
        if (sys.getsockname(fd, @ptrCast(&bound), &bound_size) != 0) return error.BadAddress;
        const bound_port = switch (address) {
            .ip4 => std.mem.bigToNative(u16, @as(*const sys.sockaddr.in, @ptrCast(&bound)).port),
            .ip6 => std.mem.bigToNative(u16, @as(*const sys.sockaddr.in6, @ptrCast(&bound)).port),
        };
        try nonBlocking(fd);
        const l = try r.gpa.create(Listener);
        errdefer r.gpa.destroy(l);
        l.* = .{ .fd = fd, .host = try r.gpa.dupe(u8, host), .port = bound_port };
        try r.listeners.append(r.gpa, l);
        return l;
    }

    /// Stops a listener accepting, and closes its idle connections; open
    /// exchanges finish.
    fn closeListener(r: *Router, l: *Listener) void {
        if (l.closed) return;
        l.closed = true;
        _ = sys.close(l.fd);
        for (r.connections.items) |conn| if (conn.listener == l and conn.exchange == null and conn.out.items.len == conn.sent) {
            conn.gone = true;
        };
    }

    fn nonBlocking(fd: posix.fd_t) !void {
        const flags = sys.fcntl(fd, sys.F.GETFL);
        if (flags < 0) return error.SystemResources;
        if (sys.fcntl(fd, sys.F.SETFL, flags | @as(c_int, 1 << @bitOffsetOf(sys.O, "NONBLOCK"))) < 0) return error.SystemResources;
    }

    /// Adds the router's sockets to a poll set; `ready` reads them back in
    /// the same order.
    pub fn collect(r: *Router, fds: *std.ArrayList(posix.pollfd)) !void {
        r.polled.clearRetainingCapacity();
        for (r.listeners.items) |l| if (!l.closed) {
            try fds.append(r.gpa, .{ .fd = l.fd, .events = posix.POLL.IN, .revents = 0 });
            try r.polled.append(r.gpa, .{ .listener = l });
        };
        for (r.connections.items) |conn| {
            if (conn.gone) continue;
            var events: i16 = posix.POLL.IN;
            if (conn.out.items.len > conn.sent) events |= posix.POLL.OUT;
            try fds.append(r.gpa, .{ .fd = conn.fd, .events = events, .revents = 0 });
            try r.polled.append(r.gpa, .{ .connection = conn });
        }
    }

    /// Handles what poll found on the slots `collect` added.
    pub fn ready(r: *Router, fds: []const posix.pollfd) void {
        for (fds, r.polled.items) |fd, what| {
            if (fd.revents == 0) continue;
            switch (what) {
                .listener => |l| if (!l.closed) r.accept(l),
                .connection => |conn| {
                    if (conn.gone) continue;
                    if (fd.revents & posix.POLL.OUT != 0) r.write(conn);
                    if (fd.revents & (posix.POLL.IN | posix.POLL.HUP | posix.POLL.ERR) != 0) r.read(conn);
                },
            }
        }
        r.sweep();
    }

    fn accept(r: *Router, l: *Listener) void {
        while (true) {
            const fd = sys.accept(l.fd, null, null);
            if (fd < 0) return;
            nonBlocking(fd) catch {
                _ = sys.close(fd);
                continue;
            };
            const conn = r.gpa.create(Connection) catch {
                _ = sys.close(fd);
                return;
            };
            conn.* = .{ .fd = fd, .listener = l };
            r.connections.append(r.gpa, conn) catch {
                _ = sys.close(fd);
                r.gpa.destroy(conn);
                return;
            };
        }
    }

    fn freeConnection(r: *Router, conn: *Connection) void {
        _ = sys.close(conn.fd);
        conn.in.deinit(r.gpa);
        conn.out.deinit(r.gpa);
        r.gpa.destroy(conn);
    }

    /// Closes the connections that are done, telling an unanswered exchange
    /// its client has gone.
    fn sweep(r: *Router) void {
        var i: usize = 0;
        while (i < r.connections.items.len) {
            const conn = r.connections.items[i];
            if (!conn.gone) {
                i += 1;
                continue;
            }
            if (conn.exchange) |id| if (r.exchanges.get(id)) |x| {
                if (!x.answered) x.closed = true;
                x.connection = null;
            };
            _ = r.connections.swapRemove(i);
            r.freeConnection(conn);
        }
    }

    fn read(r: *Router, conn: *Connection) void {
        var buf: [16 * 1024]u8 = undefined;
        while (true) {
            const n = sys.read(conn.fd, &buf, buf.len);
            if (n == 0) {
                conn.gone = true;
                return;
            }
            if (n < 0) {
                if (sys.errno(n) != .AGAIN) conn.gone = true;
                break;
            }
            conn.in.appendSlice(r.gpa, buf[0..@intCast(n)]) catch {
                conn.gone = true;
                return;
            };
            // A client that keeps sending while its exchange waits gets no
            // more buffer than one request may take.
            if (conn.in.items.len > r.options.max_body + max_head * 2) break;
        }
        r.next(conn);
    }

    fn write(r: *Router, conn: *Connection) void {
        while (conn.sent < conn.out.items.len) {
            const rest = conn.out.items[conn.sent..];
            const n = sys.write(conn.fd, rest.ptr, rest.len);
            if (n < 0) {
                if (sys.errno(n) != .AGAIN) conn.gone = true;
                return;
            }
            conn.sent += @intCast(n);
        }
        conn.out.clearRetainingCapacity();
        conn.sent = 0;
        if (conn.closing or (conn.listener.closed and conn.exchange == null)) {
            conn.gone = true;
            return;
        }
        r.next(conn);
    }

    /// Takes the next whole request off the connection, if it is free for one.
    fn next(r: *Router, conn: *Connection) void {
        if (conn.gone or conn.closing or conn.exchange != null or conn.out.items.len > conn.sent) return;
        var arena: std.heap.ArenaAllocator = .init(r.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = request.parseHead(a, conn.in.items) catch return r.refuse(conn, 400);
        const head = parsed orelse {
            if (conn.in.items.len > max_head) r.refuse(conn, 400);
            return;
        };
        if (head.len > max_head) return r.refuse(conn, 400);
        var body: []const u8 = "";
        var taken = head.len;
        const rest = conn.in.items[head.len..];
        if (head.chunked()) {
            const got = request.dechunk(a, rest, r.options.max_body) catch |e| return r.refuse(conn, if (e == error.TooLarge) 413 else 400);
            const decoded = got orelse return r.expectContinue(conn, head);
            body = decoded.body;
            taken += decoded.len;
        } else if (head.get("content-length")) |cl| {
            const n = std.fmt.parseInt(usize, cl, 10) catch return r.refuse(conn, 400);
            if (n > r.options.max_body) return r.refuse(conn, 413);
            if (rest.len < n) return r.expectContinue(conn, head);
            body = rest[0..n];
            taken += n;
        }
        conn.keep_alive = head.keepAlive();
        conn.head_request = std.ascii.eqlIgnoreCase(head.method, "HEAD");
        conn.continued = false;
        r.dispatch(conn, a, head, body);
        // The request's bytes, now that nothing borrows them.
        const left = conn.in.items.len - taken;
        std.mem.copyForwards(u8, conn.in.items[0..left], conn.in.items[taken..]);
        conn.in.shrinkRetainingCapacity(left);
    }

    fn expectContinue(r: *Router, conn: *Connection, head: request.Head) void {
        if (conn.continued) return;
        const expect = head.get("expect") orelse return;
        if (!std.ascii.eqlIgnoreCase(expect, "100-continue")) return;
        conn.continued = true;
        conn.out.appendSlice(r.gpa, "HTTP/1.1 100 Continue\r\n\r\n") catch {};
        r.write(conn);
    }

    /// Answers a request the router can't take, and closes the connection.
    fn refuse(r: *Router, conn: *Connection, status: u16) void {
        conn.keep_alive = false;
        conn.in.clearRetainingCapacity();
        r.plain(conn, status);
    }

    fn plain(r: *Router, conn: *Connection, status: u16) void {
        var line: [64]u8 = undefined;
        const body = std.fmt.bufPrint(&line, "{s}\n", .{request.reason(status)}) catch "\n";
        r.reply(conn, status, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
    }

    /// Writes an answer, closing after it when the client or the router
    /// won't go on.
    fn reply(r: *Router, conn: *Connection, status: u16, headers: []const request.Header, body: []const u8) void {
        if (conn.gone) return;
        if (r.stopping) conn.keep_alive = false;
        const w = &conn.out;
        const a = r.gpa;
        var line: [64]u8 = undefined;
        w.appendSlice(a, std.fmt.bufPrint(&line, "HTTP/1.1 {d} {s}\r\n", .{ status, request.reason(status) }) catch "") catch {};
        for (headers) |h| {
            w.appendSlice(a, h.name) catch {};
            w.appendSlice(a, ": ") catch {};
            w.appendSlice(a, h.value) catch {};
            w.appendSlice(a, "\r\n") catch {};
        }
        if (status != 204 and status != 304 and status >= 200) {
            w.appendSlice(a, std.fmt.bufPrint(&line, "content-length: {d}\r\n", .{body.len}) catch "") catch {};
        }
        if (!conn.keep_alive) w.appendSlice(a, "connection: close\r\n") catch {};
        w.appendSlice(a, "\r\n") catch {};
        if (!conn.head_request) w.appendSlice(a, body) catch {};
        if (!conn.keep_alive) conn.closing = true;
        r.write(conn);
    }

    // ------------------------------------------------------------ Deliveries

    fn dispatch(r: *Router, conn: *Connection, a: Allocator, head: request.Head, body: []const u8) void {
        if (r.stopping) {
            conn.keep_alive = false;
            return r.plain(conn, 503);
        }
        const f = (request.fields(a, head.method, head.target, head.headers) catch return r.plain(conn, 500)) orelse return r.refuse(conn, 400);
        const reg = r.match(conn.listener, f.path) orelse return r.plain(conn, 404);
        const group = r.group orelse return r.plain(conn, 500);
        const script = c.talk_group_script(group, reg.script.ptr, reg.script.len) orelse {
            r.log("http: delivery to {s} refused: no Script {s}", .{ reg.script, reg.script });
            r.remove(reg);
            return r.plain(conn, 500);
        };
        r.next_exchange += 1;
        const id = r.next_exchange;
        var label: [24]u8 = undefined;
        const object_id = std.fmt.bufPrint(&label, "x{d}", .{id}) catch unreachable;
        var object: ?*c.talk_object = null;
        if (c.talk_group_object(group, r.kind, object_id.ptr, object_id.len, @ptrFromInt(id), &object) != c.TALK_OK) return r.plain(conn, 500);
        var object_value: ?*c.talk_value = null;
        if (c.talk_object_value(object, &object_value) != c.TALK_OK) return r.plain(conn, 500);
        defer c.talk_value_release(object_value);
        const arg = deliveryArg(f, body, object_value.?) catch return r.plain(conn, 500);
        defer c.talk_value_release(arg);
        const args = [_]?*c.talk_value{arg};
        const message: c.talk_message = .{ .name = reg.message.ptr, .name_len = reg.message.len, .args = &args, .args_len = 1, .limits = null };
        var delivery: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        defer c.talk_owned_bytes_release(&delivery);
        const code = c.talk_script_deliver(script, &message, &delivery);
        r.queued = true;
        if (code != c.TALK_OK) {
            if (code != c.TALK_ERR_MAILBOX_FULL) {
                r.log("http: delivery to {s} refused: code {d}", .{ reg.script, code });
                r.remove(reg);
            }
            _ = c.talk_dispose(group, object);
            return r.plain(conn, if (code == c.TALK_ERR_MAILBOX_FULL) 503 else 500);
        }
        const x = r.gpa.create(Exchange) catch return r.plain(conn, 500);
        x.* = .{ .id = id, .object = object, .connection = conn };
        x.delivery = r.gpa.dupe(u8, delivery.data[0..delivery.len]) catch {
            r.gpa.destroy(x);
            return r.plain(conn, 500);
        };
        r.exchanges.put(r.gpa, id, x) catch return r.plain(conn, 500);
        r.by_delivery.put(r.gpa, x.delivery, id) catch {};
        r.open += 1;
        conn.exchange = id;
    }

    /// The Delivery's one argument: the request's fields, then `exchange`,
    /// an owned reference.
    fn deliveryArg(f: request.Fields, body: []const u8, exchange: *c.talk_value) !*c.talk_value {
        var held = Held{};
        defer held.release();
        const method = try held.text(f.method);
        const path = try held.text(f.path);
        const segments = try held.list(f.segments);
        const query = try held.entries(f.query, false);
        const headers = try held.entries(f.headers, true);
        var bytes: ?*c.talk_value = null;
        if (c.talk_bytes(body.ptr, body.len, &bytes) != c.TALK_OK) return error.HostError;
        try held.keep(bytes);
        const pairs = [_]c.talk_pair{
            .{ .key = "method", .key_len = 6, .value = method },
            .{ .key = "path", .key_len = 4, .value = path },
            .{ .key = "segments", .key_len = 8, .value = segments },
            .{ .key = "query", .key_len = 5, .value = query },
            .{ .key = "headers", .key_len = 7, .value = headers },
            .{ .key = "body", .key_len = 4, .value = bytes },
            .{ .key = "exchange", .key_len = 8, .value = exchange },
        };
        var out: ?*c.talk_value = null;
        if (c.talk_map(&pairs, pairs.len, &out) != c.TALK_OK) return error.HostError;
        return out.?;
    }

    /// Values made for a map, released once it holds them.
    const Held = struct {
        made: std.ArrayList(*c.talk_value) = .empty,

        fn keep(h: *Held, v: ?*c.talk_value) !void {
            const x = v orelse return error.HostError;
            h.made.append(std.heap.page_allocator, x) catch |e| {
                c.talk_value_release(x);
                return e;
            };
        }

        fn release(h: *Held) void {
            for (h.made.items) |v| c.talk_value_release(v);
            h.made.deinit(std.heap.page_allocator);
        }

        fn text(h: *Held, s: []const u8) !*c.talk_value {
            var v: ?*c.talk_value = null;
            if (c.talk_text(s.ptr, s.len, &v) != c.TALK_OK) return error.HostError;
            try h.keep(v);
            return v.?;
        }

        fn list(h: *Held, items: []const []const u8) !*c.talk_value {
            var values: std.ArrayList(?*c.talk_value) = .empty;
            defer values.deinit(std.heap.page_allocator);
            for (items) |s| try values.append(std.heap.page_allocator, try h.text(s));
            var v: ?*c.talk_value = null;
            if (c.talk_list(values.items.ptr, values.items.len, &v) != c.TALK_OK) return error.HostError;
            try h.keep(v);
            return v.?;
        }

        /// A map of entries: one value a text, more a list; `lists` keeps
        /// set-cookie a list whatever its length.
        fn entries(h: *Held, es: []const request.Entry, lists: bool) !*c.talk_value {
            var pairs: std.ArrayList(c.talk_pair) = .empty;
            defer pairs.deinit(std.heap.page_allocator);
            for (es) |e| {
                const as_list = e.values.len != 1 or (lists and std.mem.eql(u8, e.key, "set-cookie"));
                const v = if (as_list) try h.list(e.values) else try h.text(e.values[0]);
                try pairs.append(std.heap.page_allocator, .{ .key = e.key.ptr, .key_len = e.key.len, .value = v });
            }
            var v: ?*c.talk_value = null;
            if (c.talk_map(pairs.items.ptr, pairs.items.len, &v) != c.TALK_OK) return error.HostError;
            try h.keep(v);
            return v.?;
        }
    };

    // ------------------------------------------------------------ settlement

    fn exchangeOfRun(r: *Router, run: []const u8) ?*Exchange {
        const id = r.by_run.get(run) orelse return null;
        return r.exchanges.get(id);
    }

    fn exchangeOfDelivery(r: *Router, delivery: []const u8) ?*Exchange {
        if (delivery.len == 0) return null;
        const id = r.by_delivery.get(delivery) orelse return null;
        return r.exchanges.get(id);
    }

    /// Answers an exchange the Script didn't, once.
    fn answer(r: *Router, x: *Exchange, status: u16) void {
        if (x.answered) return;
        x.answered = true;
        r.open -= 1;
        if (x.connection) |conn| {
            conn.exchange = null;
            x.connection = null;
            r.plain(conn, status);
        }
    }

    /// Answers an exchange if it is still open, then forgets it.
    fn settle(r: *Router, x: *Exchange, status: u16, why: []const u8) void {
        if (!x.answered and status == 500 and why.len > 0) r.log("http: 500 for delivery {s}: {s}", .{ x.delivery, why });
        r.answer(x, status);
        _ = r.by_delivery.remove(x.delivery);
        if (x.run) |run| _ = r.by_run.remove(run);
        _ = r.exchanges.swapRemove(x.id);
        if (x.object) |o| if (r.group) |g| {
            _ = c.talk_dispose(g, o);
            r.queued = true;
        };
        r.freeExchange(x);
    }

    fn freeExchange(r: *Router, x: *Exchange) void {
        if (x.connection) |conn| conn.exchange = null;
        r.gpa.free(x.delivery);
        if (x.run) |run| r.gpa.free(run);
        r.gpa.destroy(x);
    }

    fn stoppingStatus(r: *const Router) u16 {
        return if (r.stopping) 503 else 500;
    }

    fn failedStatus(outcome: c.talk_outcome) u16 {
        return switch (outcome) {
            c.TALK_UNHANDLED_OUTCOME => 404,
            c.TALK_CANCELLED, c.TALK_DROPPED => 503,
            else => 500,
        };
    }

    fn outcomeName(outcome: c.talk_outcome) []const u8 {
        return switch (outcome) {
            c.TALK_COMPLETED => "completed",
            c.TALK_ERRORED => "errored",
            c.TALK_LIMIT_FAULT => "limit fault",
            c.TALK_CANCELLED => "cancelled",
            c.TALK_UNHANDLED_OUTCOME => "unhandled",
            c.TALK_DROPPED => "dropped",
            else => "effect failed",
        };
    }

    /// Settles exchanges from a Pump's reports, in order. Call it after each
    /// Pump of the Group returns.
    pub fn pumped(r: *Router, reports: []const c.talk_report) void {
        for (reports) |*report| switch (report.kind) {
            c.TALK_REPORT_STOP => {
                const x = report.as.stop;
                const script = x.script[0..x.script_len];
                var i: usize = r.registrations.items.len;
                while (i > 0) {
                    i -= 1;
                    if (i < r.registrations.items.len and std.mem.eql(u8, r.registrations.items[i].script, script)) r.remove(r.registrations.items[i]);
                }
            },
            c.TALK_REPORT_RUN_STARTED => {
                const x = report.as.run_started;
                const e = r.exchangeOfDelivery(x.delivery[0..x.delivery_len]) orelse continue;
                if (e.run != null) continue;
                const run = r.gpa.dupe(u8, x.run[0..x.run_len]) catch continue;
                e.run = run;
                r.by_run.put(r.gpa, run, e.id) catch {};
            },
            c.TALK_REPORT_RUN_END => {
                const x = report.as.run_end;
                const run = x.run[0..x.run_len];
                const e = r.exchangeOfDelivery(x.delivery[0..x.delivery_len]) orelse r.exchangeOfRun(run) orelse continue;
                if (e.run) |mine| if (!std.mem.eql(u8, mine, run)) continue;
                var buf: [512]u8 = undefined;
                const why: []const u8 = if (x.outcome == c.TALK_COMPLETED)
                    "the Run ended without responding"
                else if (x.outcome == c.TALK_ERRORED and x.@"error" != null)
                    std.fmt.bufPrint(&buf, "errored: {s}: {s}", .{ x.@"error".*.code[0..x.@"error".*.code_len], if (x.@"error".*.message) |m| m[0..@min(x.@"error".*.message_len, 400)] else "" }) catch "errored"
                else if (x.limit_len > 0)
                    std.fmt.bufPrint(&buf, "{s} ({s})", .{ outcomeName(x.outcome), x.limit[0..x.limit_len] }) catch "limit fault"
                else
                    outcomeName(x.outcome);
                r.settle(e, failedStatus(x.outcome), why);
            },
            c.TALK_REPORT_UNHANDLED => {
                const x = report.as.unhandled;
                const e = r.exchangeOfDelivery(x.delivery[0..x.delivery_len]) orelse continue;
                r.settle(e, 404, "");
            },
            c.TALK_REPORT_RUN_DISCARDED => {
                const x = report.as.run_discarded;
                const e = r.exchangeOfRun(x.run[0..x.run_len]) orelse continue;
                var buf: [128]u8 = undefined;
                r.settle(e, r.stoppingStatus(), std.fmt.bufPrint(&buf, "run discarded: {s}", .{x.reason[0..x.reason_len]}) catch "run discarded");
            },
            c.TALK_REPORT_CAUSAL_WORK => {
                const x = report.as.causal_work;
                const e = r.exchangeOfDelivery(x.root_delivery[0..x.root_delivery_len]) orelse continue;
                if (x.live_runs == 0 and x.queued_messages == 0) r.settle(e, r.stoppingStatus(), "its work ended without a Run");
            },
            else => {},
        };
        r.sweep();
    }

    /// Stops every listener accepting. A request on a connection already
    /// open is answered 503.
    pub fn stopAccepting(r: *Router) void {
        r.stopping = true;
        for (r.listeners.items) |l| r.closeListener(l);
        r.sweep();
    }

    /// Answers every open exchange with `status`.
    pub fn answerAll(r: *Router, status: u16) void {
        for (r.exchanges.values()) |x| r.answer(x, status);
        r.sweep();
    }

    /// Writes what is waiting to go out, for at most `ms` milliseconds.
    pub fn flush(r: *Router, ms: i64) void {
        var fds: std.ArrayList(posix.pollfd) = .empty;
        defer fds.deinit(r.gpa);
        const until = milliTimestamp() + ms;
        while (true) {
            fds.clearRetainingCapacity();
            var conns: std.ArrayList(*Connection) = .empty;
            defer conns.deinit(r.gpa);
            for (r.connections.items) |conn| if (!conn.gone and conn.out.items.len > conn.sent) {
                fds.append(r.gpa, .{ .fd = conn.fd, .events = posix.POLL.OUT, .revents = 0 }) catch return;
                conns.append(r.gpa, conn) catch return;
            };
            const left = until - milliTimestamp();
            if (fds.items.len == 0 or left <= 0) return;
            _ = posix.poll(fds.items, @intCast(left)) catch return;
            for (fds.items, conns.items) |fd, conn| if (fd.revents != 0) r.write(conn);
            r.sweep();
        }
    }
};

pub fn milliTimestamp() i64 {
    var ts: sys.timespec = undefined;
    _ = sys.clock_gettime(sys.CLOCK.MONOTONIC, &ts);
    return @as(i64, ts.sec) * 1000 + @divFloor(@as(i64, ts.nsec), 1_000_000);
}

test {
    _ = request;
}

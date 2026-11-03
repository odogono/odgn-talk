//! Runs `northtalk --port 0 examples/http/hello.talk` and checks its
//! answers over real sockets, then that SIGINT ends it with 130. Then runs
//! `fetch-smoke.talk`, which fetches from itself, and checks what it says.
//! Then runs two Runners with `peer` over loopback TCP (chapter 12, Runner
//! peers): one listening with `peer-billing.talk`, one dialling it with
//! `peer-shop.talk`.
//! `zig build runner-test` runs it; so does `zig build test`.
const std = @import("std");

const sys = std.c;
const posix = std.posix;

const Answer = struct { status: u16, head: []const u8, body: []const u8 };

fn connect(port: u16) !posix.fd_t {
    const fd = sys.socket(sys.AF.INET, sys.SOCK.STREAM, 0);
    if (fd < 0) return error.Socket;
    const in: sys.sockaddr.in = .{ .port = std.mem.nativeToBig(u16, port), .addr = @bitCast([4]u8{ 127, 0, 0, 1 }) };
    if (sys.connect(fd, @ptrCast(&in), @sizeOf(sys.sockaddr.in)) != 0) return error.Connect;
    return fd;
}

fn request(a: std.mem.Allocator, port: u16, method: []const u8, target: []const u8, body: []const u8) !Answer {
    const fd = try connect(port);
    defer _ = sys.close(fd);
    const text = try std.fmt.allocPrint(a, "{s} {s} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {d}\r\n\r\n{s}", .{ method, target, body.len, body });
    if (sys.write(fd, text.ptr, text.len) != text.len) return error.Write;
    var got: std.ArrayList(u8) = .empty;
    var buf: [4096]u8 = undefined;
    while (true) {
        const n = sys.read(fd, &buf, buf.len);
        if (n <= 0) break;
        try got.appendSlice(a, buf[0..@intCast(n)]);
    }
    const split = std.mem.indexOf(u8, got.items, "\r\n\r\n") orelse return error.NoHead;
    const head = got.items[0..split];
    const status = try std.fmt.parseInt(u16, head[9..12], 10);
    return .{ .status = status, .head = head, .body = got.items[split + 4 ..] };
}

fn expect(ok: bool, comptime what: []const u8, args: anytype) !void {
    if (ok) return;
    std.debug.print("runner-test: " ++ what ++ "\n", args);
    return error.TestFailed;
}

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len != 8) {
        std.debug.print("usage: runner-smoke <northtalk> <hello.talk> <fetch-smoke.talk> <peer-billing.talk> <peer-shop.talk> <shop.pem> <shop-fingerprint.txt>\n", .{});
        return 2;
    }
    var child = try std.process.spawn(io, .{ .argv = &.{ args[1], "--port", "0", args[2] }, .stdin = .ignore, .stdout = .pipe, .stderr = .inherit });
    errdefer child.kill(io);
    const out = child.stdout.?.handle;

    // The first line says where it listens.
    var first: std.ArrayList(u8) = .empty;
    while (std.mem.indexOfScalar(u8, first.items, '\n') == null) {
        var buf: [256]u8 = undefined;
        const n = sys.read(out, &buf, buf.len);
        if (n <= 0) return error.NoListeningLine;
        try first.appendSlice(a, buf[0..@intCast(n)]);
    }
    const said = std.mem.trimEnd(u8, first.items[0..std.mem.indexOfScalar(u8, first.items, '\n').?], "\r");
    try expect(std.mem.startsWith(u8, said, "listening on "), "first line {s}", .{said});
    const port = try std.fmt.parseInt(u16, said["listening on ".len..], 10);
    try expect(port != 0, "port 0", .{});

    const root = try request(a, port, "GET", "/", "");
    try expect(root.status == 200 and std.mem.eql(u8, root.body, "hello"), "GET / gave {d} {s}", .{ root.status, root.body });
    const user = try request(a, port, "GET", "/users/7", "");
    try expect(user.status == 200 and std.mem.eql(u8, user.body, "{\"id\":\"7\"}"), "GET /users/7 gave {d} {s}", .{ user.status, user.body });
    try expect(std.mem.indexOf(u8, user.head, "content-type: application/json") != null, "GET /users/7 head {s}", .{user.head});
    const echo = try request(a, port, "POST", "/echo", "hi there");
    try expect(echo.status == 201 and std.mem.eql(u8, echo.body, "hi there"), "POST /echo gave {d} {s}", .{ echo.status, echo.body });
    const missing = try request(a, port, "GET", "/missing", "");
    try expect(missing.status == 404, "GET /missing gave {d}", .{missing.status});
    const never = try request(a, port, "GET", "/never", "");
    try expect(never.status == 500, "GET /never gave {d}", .{never.status});

    try posix.kill(child.id.?, .INT);
    const term = try child.wait(io);
    try expect(term == .exited and term.exited == 130, "SIGINT ended it with {f}", .{term});
    std.debug.print("runner-test: 7 checks passed on port {d}\n", .{port});

    // http.fetch: the request, the response, an unfollowed redirect, a
    // refused connection and an abandoned call.
    const fetched = try std.process.run(a, io, .{ .argv = &.{ args[1], args[3] } });
    const want =
        \\201
        \\2
        \\["a=1", "b=2"]
        \\{"method":"POST","path":"/echo","query":"a b","xa":"1, 2","type":"application/json","encoding":"identity","body":"{\"n\":1}"}
        \\[302, "/elsewhere"]
        \\network error
        \\timeout
        \\
    ;
    try expect(fetched.term == .exited and fetched.term.exited == 0, "fetch-smoke ended {f}: {s}", .{ fetched.term, fetched.stderr });
    try expect(std.mem.eql(u8, fetched.stdout, want), "fetch-smoke said:\n{s}", .{fetched.stdout});
    std.debug.print("runner-test: fetch checks passed\n", .{});
    const shop_print = try std.Io.Dir.cwd().readFileAlloc(io, args[7], a, .limited(256));
    try peers(a, io, args[1], args[4], args[5], args[6], shop_print);
    return 0;
}

/// A Runner's standard error or output, read a line at a time.
const Lines = struct {
    fd: posix.fd_t,
    got: std.ArrayList(u8) = .empty,

    /// The next line that starts with `prefix`, skipping the others.
    fn with(l: *Lines, a: std.mem.Allocator, prefix: []const u8) ![]const u8 {
        while (true) {
            while (std.mem.indexOfScalar(u8, l.got.items, '\n')) |eol| {
                const text = try a.dupe(u8, l.got.items[0..eol]);
                std.mem.copyForwards(u8, l.got.items, l.got.items[eol + 1 ..]);
                l.got.shrinkRetainingCapacity(l.got.items.len - eol - 1);
                if (std.mem.startsWith(u8, text, prefix)) return text;
            }
            var buf: [512]u8 = undefined;
            const n = sys.read(l.fd, &buf, buf.len);
            if (n <= 0) return error.NoLine;
            try l.got.appendSlice(a, buf[0..@intCast(n)]);
        }
    }
};

/// Two native Runners carry Remote Sends (chapter 12, Runner peers): a
/// call and its reply, a Script error as `send failed`, and a post. Over
/// mutual TLS the listener's `--peer` names the caller and a wrong pinned
/// key is refused; over loopback TCP nobody is vouched for, and any other
/// host is refused.
fn peers(a: std.mem.Allocator, io: std.Io, northtalk: []const u8, billing: []const u8, shop: []const u8, shop_key: []const u8, shop_print: []const u8) !void {
    const print = std.mem.trim(u8, shop_print, " \n");
    const named = try std.fmt.allocPrint(a, "shop=tls://127.0.0.1:1#{s}", .{print});
    const tls_address = try exchange(a, io, northtalk, &.{ "--listen", "127.0.0.1:0", "--peer", named, billing }, &.{ "--peer-key", shop_key }, shop, "shop");
    try expect(std.mem.startsWith(u8, tls_address, "tls://127.0.0.1:"), "listening on {s}", .{tls_address});
    _ = try exchange(a, io, northtalk, &.{ "--listen", "tcp://127.0.0.1:0", billing }, &.{}, shop, "nobody");

    // A listener whose key isn't the pinned one is never reached.
    var listener = try std.process.spawn(io, .{ .argv = &.{ northtalk, "--listen", "127.0.0.1:0", billing }, .stdin = .ignore, .stdout = .pipe, .stderr = .pipe });
    errdefer listener.kill(io);
    var errs: Lines = .{ .fd = listener.stderr.?.handle };
    const listening = try errs.with(a, "peer: listening on ");
    const address = listening["peer: listening on ".len..];
    const hash = std.mem.lastIndexOfScalar(u8, address, '#').?;
    const wrong = try std.fmt.allocPrint(a, "billing={s}#{s}", .{ address[0..hash], &@as([64]u8, @splat('0')) });
    const refused = try std.process.run(a, io, .{ .argv = &.{ northtalk, "--peer", wrong, shop } });
    try expect(refused.term == .exited and refused.term.exited == 1 and std.mem.indexOf(u8, refused.stderr, "bad address") != null, "a wrongly pinned peer gave {f}: {s}", .{ refused.term, refused.stderr });
    try posix.kill(listener.id.?, .INT);
    _ = try listener.wait(io);

    const away = try std.process.run(a, io, .{ .argv = &.{ northtalk, "--listen", "tcp://192.0.2.1:7400", billing } });
    try expect(away.term == .exited and away.term.exited == 2 and std.mem.indexOf(u8, away.stderr, "only for loopback") != null, "a non-loopback listen gave {f}: {s}", .{ away.term, away.stderr });
    const bad_key = try std.process.run(a, io, .{ .argv = &.{ northtalk, "--peer-key", billing, shop } });
    try expect(bad_key.term == .exited and bad_key.term.exited == 2, "a --peer-key that isn't one gave {f}: {s}", .{ bad_key.term, bad_key.stderr });
    std.debug.print("runner-test: peer checks passed\n", .{});
}

/// A listener started with `listen`, a dialling Runner run with `dial`
/// and a `--peer` to it, and what each says; the listener's address.
fn exchange(a: std.mem.Allocator, io: std.Io, northtalk: []const u8, listen: []const []const u8, dial: []const []const u8, shop: []const u8, who: []const u8) ![]const u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(a, northtalk);
    try argv.appendSlice(a, listen);
    var listener = try std.process.spawn(io, .{ .argv = argv.items, .stdin = .ignore, .stdout = .pipe, .stderr = .pipe });
    errdefer listener.kill(io);
    var errs: Lines = .{ .fd = listener.stderr.?.handle };
    const listening = try errs.with(a, "peer: listening on ");
    const address = listening["peer: listening on ".len..];

    argv.clearRetainingCapacity();
    try argv.append(a, northtalk);
    try argv.appendSlice(a, dial);
    try argv.appendSlice(a, &.{ "--peer", try std.fmt.allocPrint(a, "billing={s}", .{address}), shop });
    const dialled = try std.process.run(a, io, .{ .argv = argv.items });
    try expect(dialled.term == .exited and dialled.term.exited == 0, "the dialling Runner ended {f}: {s}", .{ dialled.term, dialled.stderr });
    try expect(std.mem.eql(u8, dialled.stdout, "total 13\nsend failed errored\n"), "the dialling Runner said:\n{s}", .{dialled.stdout});
    try expect(std.mem.startsWith(u8, dialled.stderr, "peer: key "), "the dialling Runner wrote:\n{s}", .{dialled.stderr});
    var out: Lines = .{ .fd = listener.stdout.?.handle };
    const want = [_][]const u8{ "charge 12 from ", "charge 500 from ", "note hi from ", "charge 1 from " };
    for (want) |w| {
        const got = try out.with(a, "");
        const line = try std.fmt.allocPrint(a, "{s}{s}", .{ w, who });
        try expect(std.mem.eql(u8, got, line), "the listener said {s}, not {s}", .{ got, line });
    }
    try posix.kill(listener.id.?, .INT);
    const term = try listener.wait(io);
    try expect(term == .exited and term.exited == 130, "SIGINT ended the listener with {f}", .{term});
    return address;
}

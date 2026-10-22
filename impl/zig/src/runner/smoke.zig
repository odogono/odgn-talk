//! Runs `northtalk --port 0 examples/http/hello.talk` and checks its
//! answers over real sockets, then that SIGINT ends it with 130.
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
    if (args.len != 3) {
        std.debug.print("usage: runner-smoke <northtalk> <hello.talk>\n", .{});
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
    return 0;
}

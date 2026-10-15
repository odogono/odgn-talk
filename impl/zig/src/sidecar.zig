//! Native Message Layer: four-byte big-endian length, then JSON on stdio.
//! Stdout contains only protocol frames; transport failures go to stderr.
const std = @import("std");
const message = @import("northtalk").message;

pub fn main(init: std.process.Init) u8 {
    serve(init) catch |err| {
        var buffer: [256]u8 = undefined;
        var stderr = std.Io.File.stderr().writerStreaming(init.io, &buffer);
        stderr.interface.print("messagelayer: {s}\n", .{@errorName(err)}) catch {};
        stderr.interface.flush() catch {};
        return 1;
    };
    return 0;
}

fn serve(init: std.process.Init) !void {
    const gpa = init.gpa;
    const session = message.Session.init(gpa) orelse return error.OutOfMemory;
    defer session.deinit();
    var in_buffer: [64 * 1024]u8 = undefined;
    var out_buffer: [64 * 1024]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(init.io, &in_buffer);
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &out_buffer);
    const reader = &stdin.interface;
    const writer = &stdout.interface;

    while (true) {
        var header: [4]u8 = undefined;
        const read = try reader.readSliceShort(&header);
        if (read == 0) return; // Only EOF between frames is clean.
        if (read != header.len) return error.TruncatedFrameHeader;
        const size = std.mem.readInt(u32, &header, .big);
        if (size > message.max_frame) {
            // Use the reader's bounded buffer, never allocate the rejected body.
            reader.discardAll(size) catch |err| return switch (err) {
                error.EndOfStream => error.TruncatedOversizedFrame,
                else => err,
            };
            try writeFrame(writer, "{\"ref\":-1,\"err\":{\"kind\":\"protocol error\",\"detail\":\"frame exceeds 64 MiB\"}}");
            continue;
        }
        const frame = try gpa.alloc(u8, size);
        defer gpa.free(frame);
        reader.readSliceAll(frame) catch |err| return switch (err) {
            error.EndOfStream => error.TruncatedFrameBody,
            else => err,
        };
        const reply = message.handle(session, frame);
        defer message.freeReply(gpa, reply);
        try writeFrame(writer, reply);
    }
}

fn writeFrame(writer: *std.Io.Writer, frame: []const u8) !void {
    if (frame.len > std.math.maxInt(u32)) return error.ReplyTooLarge;
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(frame.len), .big);
    try writer.writeAll(&header);
    try writer.writeAll(frame);
    try writer.flush();
}

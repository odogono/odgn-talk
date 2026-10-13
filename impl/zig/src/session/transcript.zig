//! Session Transcripts (chapter 12, Session Transcripts): reading one into
//! the items a replay gives the Session Host, and writing the lines a
//! session prints.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Item = union(enum) {
    /// An Entry, or a Session Command when it starts with `:`. Its first
    /// line, and the `|` lines after it: an Entry's further lines, or the
    /// source `:library`, `:fix` and `:store load` record in place of a path.
    input: Input,
    /// `@`: a real Clock reading.
    clock: []const u8,
    /// `<`: a line the user typed for `console`'s `read`.
    line: []const u8,
    /// `~`: a built-in Capability's answer for a call: the call id, and the
    /// value, or `fail` and an error map.
    answer: Answer,
    /// `%`: an object crossing envelope.
    crossing: []const u8,
    /// An output line, without the `'` that escapes one.
    output: []const u8,
};

pub const Input = struct { first: []const u8, more: []const []const u8 };

pub const Answer = struct { call: []const u8, shown: []const u8, fail: bool };

pub const Error = error{MalformedTranscript} || Allocator.Error;

/// Reads a Transcript. Comments are left out.
pub fn parse(a: Allocator, text: []const u8) Error![]Item {
    var items: std.ArrayList(Item) = .empty;
    var lines = std.mem.splitScalar(u8, text, '\n');
    var pending: ?struct { first: []const u8, more: std.ArrayList([]const u8) } = null;
    while (lines.next()) |raw| {
        // A final line break leaves an empty last piece.
        if (raw.len == 0 and lines.peek() == null) break;
        const line = std.mem.trimEnd(u8, raw, "\r");
        if (line.len > 0 and line[0] == '|') {
            const p = &(pending orelse return error.MalformedTranscript);
            try p.more.append(a, if (line.len == 1) "" else if (line[1] == ' ') line[2..] else return error.MalformedTranscript);
            continue;
        }
        if (pending) |*p| {
            try items.append(a, .{ .input = .{ .first = p.first, .more = try p.more.toOwnedSlice(a) } });
            pending = null;
        }
        // A blank line is no Transcript line; an empty output line is `'`.
        if (line.len == 0) continue;
        switch (line[0]) {
            '#' => {},
            '>' => {
                if (line.len < 3 or line[1] != ' ') return error.MalformedTranscript;
                pending = .{ .first = line[2..], .more = .empty };
            },
            '@' => {
                if (line.len < 3 or line[1] != ' ') return error.MalformedTranscript;
                try items.append(a, .{ .clock = line[2..] });
            },
            '<' => try items.append(a, .{ .line = if (line.len == 1) "" else if (line[1] == ' ') line[2..] else return error.MalformedTranscript }),
            '~' => {
                if (line.len < 3 or line[1] != ' ') return error.MalformedTranscript;
                const rest = line[2..];
                const space = std.mem.indexOfScalar(u8, rest, ' ') orelse return error.MalformedTranscript;
                const shown = rest[space + 1 ..];
                const fail = std.mem.startsWith(u8, shown, "fail ");
                try items.append(a, .{ .answer = .{ .call = rest[0..space], .shown = if (fail) shown[5..] else shown, .fail = fail } });
            },
            '%' => {
                if (line.len < 3 or line[1] != ' ') return error.MalformedTranscript;
                try items.append(a, .{ .crossing = line[2..] });
            },
            '\'' => try items.append(a, .{ .output = line[1..] }),
            else => try items.append(a, .{ .output = line }),
        }
    }
    if (pending) |*p| try items.append(a, .{ .input = .{ .first = p.first, .more = try p.more.toOwnedSlice(a) } });
    return items.items;
}

/// Whether an output line must be written after a `'`: an empty one, or one
/// that starts with a Transcript mark.
pub fn escaped(line: []const u8) bool {
    if (line.len == 0) return true;
    return std.mem.indexOfScalar(u8, ">|<@~%#'", line[0]) != null;
}

/// Writes an output line as a Transcript holds it.
pub fn writeOutput(w: *std.Io.Writer, line: []const u8) std.Io.Writer.Error!void {
    if (escaped(line)) try w.writeByte('\'');
    try w.writeAll(line);
    try w.writeByte('\n');
}

/// Writes an Entry or Session Command: its first line after `> `, and each
/// further line after `| `, or `|` alone when it is empty.
pub fn writeInput(w: *std.Io.Writer, input: Input) std.Io.Writer.Error!void {
    try w.print("> {s}\n", .{input.first});
    for (input.more) |l| {
        if (l.len == 0) try w.writeAll("|\n") else try w.print("| {s}\n", .{l});
    }
}

test "a Transcript's items, and its output escaped" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const items = try parse(arena.allocator(), "# c\n> on f\n|   say 1\n|\n| end f\n@ 2026-09-30T10:00:00Z\n< hi\n~ s/r1.c1 fail {code: \"x\"}\n'> b\nplain\n");
    try std.testing.expectEqual(@as(usize, 6), items.len);
    try std.testing.expectEqualStrings("on f", items[0].input.first);
    try std.testing.expectEqual(@as(usize, 3), items[0].input.more.len);
    try std.testing.expectEqualStrings("", items[0].input.more[1]);
    try std.testing.expect(items[3].answer.fail);
    try std.testing.expectEqualStrings("> b", items[4].output);
    try std.testing.expect(escaped("> b") and escaped("") and !escaped("plain"));
}

//! The pinned UCD test data of chapter 1. Tests read the Unicode files
//! `bun run unicode:check` downloads and verifies, never another Core.

const std = @import("std");
const tables = @import("../generated/unicode.zig");
const case = @import("case.zig");
const grapheme = @import("grapheme.zig");
const normalize = @import("normalize.zig");
const utf8 = @import("utf8.zig");

const gpa = std.testing.allocator;

/// A pinned file's contents, checked against its SHA-256. Paths are relative
/// to impl/zig, where `zig build test` runs.
fn pinned(path: []const u8) ![]u8 {
    const full = try std.fmt.allocPrint(gpa, "../../.cache/unicode/{s}/{s}", .{ tables.unicode_version, path });
    defer gpa.free(full);
    const data = std.Io.Dir.cwd().readFileAlloc(std.testing.io, full, gpa, .unlimited) catch |err| {
        std.debug.print("{s}: {t}; run bun run unicode:check from the repository root\n", .{ full, err });
        return err;
    };
    errdefer gpa.free(data);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(data, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    for (tables.source_hashes) |source| {
        if (std.mem.eql(u8, source.path, path)) {
            try std.testing.expectEqualStrings(source.sha256, &hex);
            return data;
        }
    }
    return error.Unpinned;
}

/// A line's content before any comment, trimmed.
fn content(line: []const u8) []const u8 {
    const end = std.mem.indexOfScalar(u8, line, '#') orelse line.len;
    return std.mem.trim(u8, line[0..end], " \t\r");
}

/// Space-separated hex scalars as UTF-8.
fn text(out: *std.ArrayList(u8), field: []const u8) !void {
    out.clearRetainingCapacity();
    var it = std.mem.tokenizeScalar(u8, field, ' ');
    while (it.next()) |hex| {
        var buffer: [4]u8 = undefined;
        const len = utf8.encode(try std.fmt.parseInt(u21, hex, 16), &buffer);
        try out.appendSlice(gpa, buffer[0..len]);
    }
}

fn expectNfc(expected: []const u8, input: []const u8, line: []const u8) !void {
    const result = try normalize.nfc(gpa, input);
    defer gpa.free(result);
    if (!std.mem.eql(u8, expected, result)) {
        std.debug.print("NormalizationTest: {s}\n", .{line});
        return error.TestUnexpectedResult;
    }
}

test "NormalizationTest: every column, and every scalar outside part 1" {
    const data = try pinned("NormalizationTest.txt");
    defer gpa.free(data);
    var columns: [5]std.ArrayList(u8) = @splat(.empty);
    defer for (&columns) |*column| column.deinit(gpa);
    var in_part1 = false;
    var part1 = try std.DynamicBitSet.initEmpty(gpa, 0x110000);
    defer part1.deinit();
    var rows: usize = 0;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        const row = content(line);
        if (row.len == 0) continue;
        if (row[0] == '@') {
            in_part1 = std.mem.startsWith(u8, row, "@Part1");
            continue;
        }
        var fields = std.mem.splitScalar(u8, row, ';');
        for (&columns) |*column| try text(column, fields.next() orelse return error.BadRow);
        if (in_part1) part1.set(utf8.decode(columns[0].items, 0));
        const c1, const c2, const c3, const c4, const c5 = .{
            columns[0].items, columns[1].items, columns[2].items, columns[3].items, columns[4].items,
        };
        // c2 == NFC(c1) == NFC(c2) == NFC(c3), and c4 == NFC(c4) == NFC(c5).
        try expectNfc(c2, c1, line);
        try expectNfc(c2, c2, line);
        try expectNfc(c2, c3, line);
        try expectNfc(c4, c4, line);
        try expectNfc(c4, c5, line);
        rows += 1;
    }
    try std.testing.expect(rows > 10_000);
    var buffer: [4]u8 = undefined;
    var scalar: u21 = 0;
    while (scalar <= 0x10FFFF) : (scalar += 1) {
        if (part1.isSet(scalar) or (scalar >= 0xD800 and scalar <= 0xDFFF)) continue;
        const len = utf8.encode(scalar, &buffer);
        try expectNfc(buffer[0..len], buffer[0..len], "an unlisted scalar is unchanged");
    }
}

test "GraphemeBreakTest: every row" {
    const data = try pinned("auxiliary/GraphemeBreakTest.txt");
    defer gpa.free(data);
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(gpa);
    var expected: std.ArrayList(usize) = .empty;
    defer expected.deinit(gpa);
    var rows: usize = 0;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        const row = content(line);
        if (row.len == 0) continue;
        input.clearRetainingCapacity();
        expected.clearRetainingCapacity();
        // "÷ 0020 × 0308 ÷": a scalar between break marks; ÷ is a boundary.
        var tokens = std.mem.tokenizeScalar(u8, row, ' ');
        while (tokens.next()) |token| {
            if (std.mem.eql(u8, token, "÷")) {
                if (input.items.len > 0) try expected.append(gpa, input.items.len);
            } else if (!std.mem.eql(u8, token, "×")) {
                var buffer: [4]u8 = undefined;
                const len = utf8.encode(try std.fmt.parseInt(u21, token, 16), &buffer);
                try input.appendSlice(gpa, buffer[0..len]);
            }
        }
        var at: usize = 0;
        var index: usize = 0;
        while (at < input.items.len) : (index += 1) {
            at = grapheme.end(input.items, at);
            if (index >= expected.items.len or expected.items[index] != at) {
                std.debug.print("GraphemeBreakTest: {s}\n", .{line});
                return error.TestUnexpectedResult;
            }
        }
        try std.testing.expectEqual(expected.items.len, index);
        rows += 1;
    }
    try std.testing.expect(rows > 500);
}

test "CaseFolding: statuses C and S, and nothing else folds" {
    const data = try pinned("CaseFolding.txt");
    defer gpa.free(data);
    var folded = try std.DynamicBitSet.initEmpty(gpa, 0x110000);
    defer folded.deinit();
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        const row = content(line);
        if (row.len == 0) continue;
        var fields = std.mem.splitScalar(u8, row, ';');
        const from = try std.fmt.parseInt(u21, std.mem.trim(u8, fields.next().?, " "), 16);
        const status = std.mem.trim(u8, fields.next().?, " ");
        const to = std.mem.trim(u8, fields.next().?, " ");
        if (!std.mem.eql(u8, status, "C") and !std.mem.eql(u8, status, "S")) continue;
        try std.testing.expectEqual(try std.fmt.parseInt(u21, to, 16), case.fold(from));
        folded.set(from);
    }
    var scalar: u21 = 0;
    while (scalar <= 0x10FFFF) : (scalar += 1) {
        if (!folded.isSet(scalar)) try std.testing.expectEqual(scalar, case.fold(scalar));
    }
}

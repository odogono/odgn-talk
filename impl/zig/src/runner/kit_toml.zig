//! The TOML the language-neutral kits use (corpus/http-kit/,
//! corpus/peer-kit/): strings, integers, arrays and inline tables, with
//! `'''` literals for scripts, and arrays of tables such as `[[case]]`.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// A TOML value: the kit's files use strings, integers, arrays and inline
/// tables, with `'''` literals for scripts.
pub const Value = union(enum) {
    string: []const u8,
    int: i64,
    array: []const Value,
    table: []const Pair,

    pub fn get(v: Value, key: []const u8) ?Value {
        if (v != .table) return null;
        for (v.table) |p| if (std.mem.eql(u8, p.key, key)) return p.value;
        return null;
    }

    pub fn str(v: Value, key: []const u8) ?[]const u8 {
        const x = v.get(key) orelse return null;
        return if (x == .string) x.string else null;
    }
};
pub const Pair = struct { key: []const u8, value: Value };

pub const Parser = struct {
    a: Allocator,
    s: []const u8,
    i: usize = 0,

    fn skip(p: *Parser) void {
        while (p.i < p.s.len) {
            switch (p.s[p.i]) {
                ' ', '\t', '\r', '\n' => p.i += 1,
                '#' => while (p.i < p.s.len and p.s[p.i] != '\n') {
                    p.i += 1;
                },
                else => return,
            }
        }
    }

    fn peek(p: *Parser) u8 {
        p.skip();
        return if (p.i < p.s.len) p.s[p.i] else 0;
    }

    fn expect(p: *Parser, ch: u8) !void {
        if (p.peek() != ch) return error.BadToml;
        p.i += 1;
    }

    fn key(p: *Parser) ![]const u8 {
        p.skip();
        if (p.i < p.s.len and p.s[p.i] == '"') return (try p.value()).string;
        const start = p.i;
        while (p.i < p.s.len and (std.ascii.isAlphanumeric(p.s[p.i]) or p.s[p.i] == '-' or p.s[p.i] == '_')) p.i += 1;
        if (p.i == start) return error.BadToml;
        return p.s[start..p.i];
    }

    fn value(p: *Parser) anyerror!Value {
        const ch = p.peek();
        if (std.mem.startsWith(u8, p.s[p.i..], "'''")) {
            var start = p.i + 3;
            // A newline right after the opening delimiter is trimmed.
            if (start < p.s.len and p.s[start] == '\n') start += 1;
            const end = std.mem.indexOfPos(u8, p.s, start, "'''") orelse return error.BadToml;
            p.i = end + 3;
            return .{ .string = p.s[start..end] };
        }
        switch (ch) {
            '\'' => {
                const end = std.mem.indexOfScalarPos(u8, p.s, p.i + 1, '\'') orelse return error.BadToml;
                defer p.i = end + 1;
                return .{ .string = p.s[p.i + 1 .. end] };
            },
            '"' => {
                var out: std.ArrayList(u8) = .empty;
                p.i += 1;
                while (p.i < p.s.len and p.s[p.i] != '"') : (p.i += 1) {
                    if (p.s[p.i] != '\\') {
                        try out.append(p.a, p.s[p.i]);
                        continue;
                    }
                    p.i += 1;
                    switch (p.s[p.i]) {
                        'n' => try out.append(p.a, '\n'),
                        't' => try out.append(p.a, '\t'),
                        'r' => try out.append(p.a, '\r'),
                        'u' => {
                            const cp = try std.fmt.parseInt(u21, p.s[p.i + 1 .. p.i + 5], 16);
                            var buf: [4]u8 = undefined;
                            try out.appendSlice(p.a, buf[0..try std.unicode.utf8Encode(cp, &buf)]);
                            p.i += 4;
                        },
                        else => |x| try out.append(p.a, x),
                    }
                }
                p.i += 1;
                return .{ .string = out.items };
            },
            '[' => {
                p.i += 1;
                var items: std.ArrayList(Value) = .empty;
                while (p.peek() != ']') {
                    try items.append(p.a, try p.value());
                    if (p.peek() == ',') p.i += 1;
                }
                p.i += 1;
                return .{ .array = items.items };
            },
            '{' => {
                p.i += 1;
                var pairs: std.ArrayList(Pair) = .empty;
                while (p.peek() != '}') {
                    const k = try p.key();
                    try p.expect('=');
                    try pairs.append(p.a, .{ .key = k, .value = try p.value() });
                    if (p.peek() == ',') p.i += 1;
                }
                p.i += 1;
                return .{ .table = pairs.items };
            },
            else => {
                const start = p.i;
                while (p.i < p.s.len and (std.ascii.isDigit(p.s[p.i]) or p.s[p.i] == '-' or p.s[p.i] == '_')) p.i += 1;
                return .{ .int = try std.fmt.parseInt(i64, p.s[start..p.i], 10) };
            },
        }
    }

    /// The file's `[[case]]` tables.
    pub fn cases(p: *Parser) ![]const Value {
        return (try p.tables("[[case]]")).items;
    }

    /// The file's top-level pairs, before its first `header`, and the tables
    /// each `header` begins, such as `[[sequence]]`.
    pub fn tables(p: *Parser, header: []const u8) !struct { top: Value, items: []const Value } {
        var top: std.ArrayList(Pair) = .empty;
        var out: std.ArrayList(Value) = .empty;
        var current: ?std.ArrayList(Pair) = null;
        while (true) {
            p.skip();
            if (p.i >= p.s.len) break;
            if (std.mem.startsWith(u8, p.s[p.i..], header)) {
                if (current) |cur| try out.append(p.a, .{ .table = cur.items });
                current = .empty;
                p.i += header.len;
                continue;
            }
            const k = try p.key();
            try p.expect('=');
            const v = try p.value();
            if (current) |*cur| try cur.append(p.a, .{ .key = k, .value = v }) else try top.append(p.a, .{ .key = k, .value = v });
        }
        if (current) |cur| try out.append(p.a, .{ .table = cur.items });
        return .{ .top = .{ .table = top.items }, .items = out.items };
    }
};

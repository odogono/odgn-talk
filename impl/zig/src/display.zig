//! Chapter 11's one-line display form. The reader returns the consumed length
//! as well as a value, so Trace keys can follow a filled value on the same line.
const std = @import("std");
const model = @import("value.zig");
const utf8 = @import("unicode/utf8.zig");
const Value = model.Value;
/// Every refusal the writer can report, including the writer's own failure.
pub const Error = model.Error || error{WriteFailed};
fn hidden(cp: u21) bool {
    return cp < 32 or (cp >= 127 and cp <= 159) or cp == 0x61c or cp == 0x200e or cp == 0x200f or (cp >= 0x2028 and cp <= 0x202e) or (cp >= 0x2066 and cp <= 0x2069) or cp == 0xfeff;
}
fn word(s: []const u8) bool {
    if (s.len == 0 or !(std.ascii.isAlphabetic(s[0]) or s[0] == '_')) return false;
    for (s) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_')) return false;
    return !std.mem.eql(u8, s, "offer");
}
fn text(w: *std.Io.Writer, s: []const u8) !void {
    var pos: usize = 0;
    var first = true;
    while (pos < s.len) {
        if (!first) try w.writeAll(" & ");
        first = false;
        const cp = utf8.decode(s, pos);
        if (cp == '"' or hidden(cp)) {
            switch (cp) {
                '"' => try w.writeAll("quote"),
                '\n' => try w.writeAll("newline"),
                '\t' => try w.writeAll("tab"),
                else => try w.print("fromCodePoint({d})", .{cp}),
            }
            pos += utf8.sequenceLength(s[pos]);
        } else {
            const start = pos;
            while (pos < s.len) {
                const c = utf8.decode(s, pos);
                if (c == '"' or hidden(c)) break;
                pos += utf8.sequenceLength(s[pos]);
            }
            try w.writeByte('"');
            try w.writeAll(s[start..pos]);
            try w.writeByte('"');
        }
    }
    if (first) try w.writeAll("\"\"");
}
fn key(w: *std.Io.Writer, s: []const u8) !void {
    if (word(s)) return w.writeAll(s);
    if (s.len > 0 and (s[0] == '"' or hidden(utf8.decode(s, 0)))) try w.writeAll("\"\" & ");
    try text(w, s);
}
/// Writes source text as display-form text, its scalars exactly as given,
/// as a Trace's `source` field does.
pub fn writeSource(w: *std.Io.Writer, s: []const u8) Error!void {
    return text(w, s);
}

/// Reads a Trace's `source` field: display-form text whose scalars are kept
/// exactly as written, without NFC.
pub fn readSource(a: std.mem.Allocator, input: []const u8) model.Error![]u8 {
    if (!utf8.validate(input)) return error.InvalidValue;
    var r: Reader = .{ .allocator = a, .input = input };
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    try r.textPiece(&out);
    while (r.take(" & ")) try r.textPiece(&out);
    if (r.pos != input.len) return error.InvalidValue;
    return out.toOwnedSlice(a);
}

/// Writes `v`'s one-line display form. A Function writes its stored source.
pub fn write(w: *std.Io.Writer, v: *const Value) Error!void {
    return writeWith(w, v, false);
}

/// Writes `v` as a Trace writes it: a Core-raised error map without its
/// `message`, wherever the map appears.
pub fn writeTrace(w: *std.Io.Writer, v: *const Value) Error!void {
    return writeWith(w, v, true);
}

fn writeWith(w: *std.Io.Writer, v: *const Value, trace: bool) Error!void {
    const a = v.allocator;
    switch (v.data) {
        .nothing => try w.writeAll("nothing"),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .number => |n| {
            const s = try n.string(a);
            defer a.free(s);
            try w.writeAll(s);
        },
        .quantity => |q| {
            const s = try q.number.string(a);
            defer a.free(s);
            try w.writeAll(s);
            try w.writeByte(' ');
            const u = try q.unit.string(a, model.Decimal.order(q.number, model.Decimal.fromInt(@as(i32, 1))) != .eq and model.Decimal.order(q.number, model.Decimal.fromInt(@as(i32, -1))) != .eq);
            defer a.free(u);
            try w.writeAll(u);
        },
        .text => |s| try text(w, s),
        .bytes => |s| {
            try w.writeAll("<<");
            for (s, 0..) |b, i| {
                if (i > 0) try w.writeAll(", ");
                try w.print("0x{X:0>2}", .{b});
            }
            try w.writeAll(">>");
        },
        .list => |xs| {
            try w.writeByte('[');
            for (xs, 0..) |x, i| {
                if (i > 0) try w.writeAll(", ");
                try writeWith(w, x, trace);
            }
            try w.writeByte(']');
        },
        .map => |xs| {
            try w.writeByte('{');
            var first = true;
            for (xs) |x| {
                if (trace and v.core_message and std.mem.eql(u8, x.key, "message")) continue;
                if (!first) try w.writeAll(", ");
                first = false;
                try key(w, x.key);
                try w.writeAll(": ");
                try writeWith(w, x.value, trace);
            }
            try w.writeByte('}');
        },
        .range => |r| {
            try writeWith(w, r.from, trace);
            try w.writeAll("..");
            try writeWith(w, r.to, trace);
        },
        .civil_date => |f| {
            const s = try model.dates.string(a, f, false);
            defer a.free(s);
            try w.writeAll(s);
        },
        .instant => |t| {
            const s = try model.dates.string(a, model.dates.fields(t), true);
            defer a.free(s);
            try w.writeAll(s);
        },
        .pattern => |s| try w.writeAll(s),
        .function => |f| try w.writeAll(f.display),
        .object => |o| {
            try w.writeAll("<object ");
            try w.writeAll(o.kind);
            try w.writeByte(' ');
            try text(w, o.id);
            try w.writeByte('>');
        },
    }
}
/// `v`'s display form, owned by the caller.
pub fn string(a: std.mem.Allocator, v: *const Value) Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    write(&out.writer, v) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else err;
    return out.toOwnedSlice();
}
/// A Group's lookups for the values a reader cannot build alone. `object`
/// finds an existing Host Object by kind and id; `function` finds a Function
/// Value by its display source. Each returns an owned reference; without
/// one, that kind is refused.
pub const Resolver = struct {
    context: ?*anyopaque = null,
    object: ?*const fn (?*anyopaque, []const u8, []const u8) model.Error!*Value = null,
    function: ?*const fn (?*anyopaque, []const u8) model.Error!*Value = null,
};
/// Reads one display-form value from `input` at `pos`, leaving `pos` after it.
pub const Reader = struct {
    allocator: std.mem.Allocator,
    input: []const u8,
    pos: usize = 0,
    resolver: Resolver = .{},
    /// Consumes `s` if the input continues with it.
    pub fn take(self: *Reader, s: []const u8) bool {
        if (std.mem.startsWith(u8, self.input[self.pos..], s)) {
            self.pos += s.len;
            return true;
        }
        return false;
    }
    fn expect(self: *Reader, s: []const u8) model.Error!void {
        if (!self.take(s)) return error.InvalidValue;
    }
    fn textPiece(self: *Reader, out: *std.ArrayList(u8)) model.Error!void {
        const a = self.allocator;
        if (self.take("\"")) {
            const start = self.pos;
            while (self.pos < self.input.len and self.input[self.pos] != '"') : (self.pos += 1) {
                if (self.input[self.pos] < 32) return error.InvalidValue;
            }
            const s = self.input[start..self.pos];
            if (!utf8.validate(s)) return error.InvalidValue;
            var it = utf8.Iterator{ .bytes = s };
            while (it.next()) |cp| if (hidden(cp)) return error.InvalidValue;
            try out.appendSlice(a, s);
            try self.expect("\"");
        } else if (self.take("quote")) try out.append(a, '"') else if (self.take("newline")) try out.append(a, '\n') else if (self.take("tab")) try out.append(a, '\t') else if (self.take("fromCodePoint(")) {
            const start = self.pos;
            while (self.pos < self.input.len and std.ascii.isDigit(self.input[self.pos])) : (self.pos += 1) {}
            const cp = std.fmt.parseInt(u21, self.input[start..self.pos], 10) catch return error.InvalidValue;
            if (cp > 0x10ffff or (cp >= 0xd800 and cp <= 0xdfff)) return error.InvalidValue;
            try self.expect(")");
            var buf: [4]u8 = undefined;
            const len = utf8.encode(cp, &buf);
            try out.appendSlice(a, buf[0..len]);
        } else return error.InvalidValue;
    }
    fn readText(self: *Reader) model.Error!*Value {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(self.allocator);
        try self.textPiece(&out);
        while (self.take(" & ")) try self.textPiece(&out);
        return model.text(self.allocator, out.items);
    }
    /// Reads the value at `pos`; `depth` is the nesting already entered.
    pub fn read(self: *Reader, depth: usize) model.Error!*Value {
        if (depth >= model.max_depth) return error.TooDeep;
        const a = self.allocator;
        const start = self.pos;
        if (self.pos >= self.input.len) return error.InvalidValue;
        if (self.input[self.pos] == '"' or std.mem.startsWith(u8, self.input[self.pos..], "quote") or std.mem.startsWith(u8, self.input[self.pos..], "newline") or std.mem.startsWith(u8, self.input[self.pos..], "tab") or std.mem.startsWith(u8, self.input[self.pos..], "fromCodePoint(")) return self.readText();
        if (self.take("nothing")) return model.scalar(a, .nothing);
        if (self.take("true")) return model.scalar(a, .{ .bool = true });
        if (self.take("false")) return model.scalar(a, .{ .bool = false });
        if (self.take("<<")) {
            var out: std.ArrayList(u8) = .empty;
            defer out.deinit(a);
            if (!self.take(">>")) while (true) {
                try self.expect("0x");
                if (self.input.len - self.pos < 2) return error.InvalidValue;
                const b = std.fmt.parseInt(u8, self.input[self.pos .. self.pos + 2], 16) catch return error.InvalidValue;
                self.pos += 2;
                try out.append(a, b);
                if (self.take(">>")) break;
                try self.expect(", ");
            };
            return model.bytes(a, out.items);
        }
        if (self.take("[")) {
            var items: std.ArrayList(*Value) = .empty;
            defer {
                for (items.items) |v| v.release();
                items.deinit(a);
            }
            if (!self.take("]")) while (true) {
                const v = try self.read(depth + 1);
                items.append(a, v) catch {
                    v.release();
                    return error.OutOfMemory;
                };
                if (self.take("]")) break;
                try self.expect(", ");
            };
            return model.list(a, items.items);
        }
        if (self.take("{")) {
            var pairs: std.ArrayList(model.Pair) = .empty;
            defer {
                for (pairs.items) |p| {
                    a.free(p.key);
                    p.value.release();
                }
                pairs.deinit(a);
            }
            if (!self.take("}")) while (true) {
                {
                    var k: []const u8 = undefined;
                    if (self.pos < self.input.len and self.input[self.pos] == '"') {
                        const v = try self.readText();
                        defer v.release();
                        k = try a.dupe(u8, v.data.text);
                    } else {
                        const begin = self.pos;
                        while (self.pos < self.input.len and (std.ascii.isAlphanumeric(self.input[self.pos]) or self.input[self.pos] == '_')) : (self.pos += 1) {}
                        if (!word(self.input[begin..self.pos])) return error.InvalidValue;
                        k = try a.dupe(u8, self.input[begin..self.pos]);
                    }
                    errdefer a.free(k);
                    try self.expect(": ");
                    const v = try self.read(depth + 1);
                    errdefer v.release();
                    try pairs.append(a, .{ .key = k, .value = v });
                }
                if (self.take("}")) break;
                try self.expect(", ");
            };
            return model.map(a, pairs.items);
        }
        if (self.take("<object ")) {
            const begin = self.pos;
            while (self.pos < self.input.len and self.input[self.pos] != ' ') : (self.pos += 1) {}
            const kind = self.input[begin..self.pos];
            try self.expect(" ");
            const id = try self.readText();
            defer id.release();
            try self.expect(">");
            const resolve = self.resolver.object orelse return error.InvalidValue;
            return resolve(self.resolver.context, kind, id.data.text);
        }
        if (self.take("<")) {
            var nesting: usize = 1;
            var quoted = false;
            while (self.pos < self.input.len and nesting > 0) : (self.pos += 1) {
                const c = self.input[self.pos];
                if (c == '"') quoted = !quoted;
                if (!quoted) {
                    if (c == '<') {
                        nesting += 1;
                        if (nesting >= model.max_depth) return error.TooDeep;
                    }
                    if (c == '>') nesting -= 1;
                }
            }
            if (nesting != 0) return error.InvalidValue;
            const source = self.input[start..self.pos];
            if (!std.mem.startsWith(u8, source, "<function ")) return @import("pattern.zig").parse(a, source);
            const resolve = self.resolver.function orelse return error.InvalidValue;
            return resolve(self.resolver.context, source);
        }
        // ISO dates are distinguishable from a number by the first hyphen.
        if (self.input.len - self.pos >= 10 and self.input[self.pos + 4] == '-' and self.input[self.pos + 7] == '-') {
            while (self.pos < self.input.len and std.mem.indexOfScalar(u8, "0123456789-T:.Z", self.input[self.pos]) != null) : (self.pos += 1) {}
            const s = self.input[start..self.pos];
            if (s[s.len - 1] == 'Z') return model.scalar(a, .{ .instant = try model.dates.parseInstant(s) });
            return model.scalar(a, .{ .civil_date = try model.dates.parseCivil(s) });
        }
        if (self.input[self.pos] == '-') self.pos += 1;
        while (self.pos < self.input.len and std.ascii.isDigit(self.input[self.pos])) : (self.pos += 1) {}
        if (self.pos < self.input.len and self.input[self.pos] == '.' and !std.mem.startsWith(u8, self.input[self.pos..], "..")) {
            self.pos += 1;
            while (self.pos < self.input.len and std.ascii.isDigit(self.input[self.pos])) : (self.pos += 1) {}
        }
        const n = try model.Decimal.parse(self.input[start..self.pos]);
        var v: *Value = undefined;
        // Never consume the next Trace key as a Unit (chapter 11).
        if (self.pos < self.input.len and self.input[self.pos] == ' ') {
            const unit_start = self.pos + 1;
            var end = unit_start;
            while (end < self.input.len and (std.ascii.isAlphanumeric(self.input[end]) or std.mem.indexOfScalar(u8, "*/^", self.input[end]) != null)) : (end += 1) {}
            if (end > unit_start and !(end < self.input.len and self.input[end] == '=')) {
                v = try model.quantity(a, n, self.input[unit_start..end]);
                self.pos = end;
            } else v = try model.scalar(a, .{ .number = n });
        } else v = try model.scalar(a, .{ .number = n });
        errdefer v.release();
        if (self.take("..")) {
            const to = try self.read(depth + 1);
            defer to.release();
            const r = try model.range(a, v, to);
            v.release();
            return r;
        }
        return v;
    }
};
/// Reads `input` as exactly one display-form value.
pub fn parse(a: std.mem.Allocator, input: []const u8, resolver: Resolver) model.Error!*Value {
    if (!utf8.validate(input)) return error.InvalidValue;
    var r: Reader = .{ .allocator = a, .input = input, .resolver = resolver };
    const v = try r.read(0);
    errdefer v.release();
    if (r.pos != input.len) return error.InvalidValue;
    return v;
}
test "every data kind display round trips, hidden scalars and quoted keys" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "nothing", "true", "false", "7.50", "2.50 GBP", "3 days", "<<0x0D, 0x0A>>", "[nothing, {a: 1, \"offer\": 2}]", "3 m..7 cm", "2026-09-27T14:30:00.5", "1969-12-31T23:59:59.999999999Z", "\"say \" & quote & \"hi\" & quote", "{\"\" & quote: newline & tab & fromCodePoint(13)}" }) |s| {
        const v = try parse(a, s, .{});
        defer v.release();
        const rendered = try string(a, v);
        defer a.free(rendered);
        try std.testing.expectEqualStrings(s, rendered);
        const copy = try parse(a, rendered, .{});
        defer copy.release();
        try std.testing.expect(try v.equal(copy));
    }
}

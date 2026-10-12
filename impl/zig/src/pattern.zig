//! Reparse canonical Text Pattern sources for the Value Encoding, with a
//! nesting guard for untrusted input. The machine compiles and matches them
//! (machine/matcher.zig). Resolved splices can contain only nested patterns
//! or parenthesized display text.
const std = @import("std");
const model = @import("value.zig");
const display = @import("display.zig");
const keywords = [_][]const u8{ "character", "characters", "digit", "digits", "letter", "letters", "punctuation", "space", "spaces", "text", "whitespace", "word", "words" };
const Parser = struct {
    reader: display.Reader,
    fn name(self: *Parser) []const u8 {
        const r = &self.reader;
        const start = r.pos;
        if (start == r.input.len or !(std.ascii.isAlphabetic(r.input[start]) or r.input[start] == '_')) return "";
        r.pos += 1;
        while (r.pos < r.input.len and (std.ascii.isAlphanumeric(r.input[r.pos]) or r.input[r.pos] == '_')) : (r.pos += 1) {}
        return r.input[start..r.pos];
    }
    fn expect(self: *Parser, s: []const u8) model.Error!void {
        if (!self.reader.take(s)) return error.InvalidValue;
    }
    fn pattern(self: *Parser, depth: usize) model.Error!void {
        if (depth >= model.max_depth) return error.TooDeep;
        try self.expect("<");
        if (self.reader.take(">")) return;
        if (self.reader.pos < self.reader.input.len and self.reader.input[self.reader.pos] == ' ') {
            self.reader.pos += 1;
            if (self.reader.pos == self.reader.input.len or self.reader.input[self.reader.pos] != '<') return error.InvalidValue;
        }
        try self.alternation(depth + 1);
        while (self.reader.take(", ")) try self.alternation(depth + 1);
        try self.expect(">");
    }
    fn alternation(self: *Parser, depth: usize) model.Error!void {
        try self.element(depth);
        while (self.reader.take(" or ")) try self.element(depth);
    }
    fn element(self: *Parser, depth: usize) model.Error!void {
        try self.atom(depth);
        _ = self.reader.take(" as number");
        _ = self.reader.take(" ignoring case");
        _ = self.reader.take(" lazily");
    }
    fn atom(self: *Parser, depth: usize) model.Error!void {
        if (depth >= model.max_depth) return error.TooDeep;
        const r = &self.reader;
        if (r.pos == r.input.len) return error.InvalidValue;
        if (r.input[r.pos] == '<') return self.pattern(depth);
        if (r.input[r.pos] == '"' or r.input[r.pos] == '(') {
            const parens = r.take("(");
            const text = try r.read(depth);
            defer text.release();
            if (text.data != .text) return error.InvalidValue;
            if (parens) try self.expect(")");
            return;
        }
        if (std.ascii.isDigit(r.input[r.pos])) {
            const start = r.pos;
            while (r.pos < r.input.len and (std.ascii.isDigit(r.input[r.pos]) or r.input[r.pos] == '.')) : (r.pos += 1) {}
            const n = try model.Decimal.parse(r.input[start..r.pos]);
            _ = try n.integer(u128);
            try self.expect(" ");
            return self.atom(depth + 1);
        }
        const word = self.name();
        if (word.len == 0) return error.InvalidValue;
        if (r.take(": ")) return self.alternation(depth + 1);
        if (std.mem.eql(u8, word, "optional")) {
            try self.expect(" ");
            return self.atom(depth + 1);
        }
        if (std.mem.eql(u8, word, "one") or std.mem.eql(u8, word, "zero")) {
            try self.expect(" or more of ");
            return self.atom(depth + 1);
        }
        if (std.mem.eql(u8, word, "a") or std.mem.eql(u8, word, "an")) return self.expect(" number");
        if (std.mem.eql(u8, word, "uppercase") or std.mem.eql(u8, word, "lowercase")) {
            try self.expect(" ");
            const cls = self.name();
            if (!std.mem.eql(u8, cls, "letter") and !std.mem.eql(u8, cls, "letters")) return error.InvalidValue;
            return;
        }
        if (std.mem.eql(u8, word, "line") or std.mem.eql(u8, word, "text")) {
            if (r.take(" start") or r.take(" end")) return;
            if (std.mem.eql(u8, word, "line")) return error.InvalidValue;
        }
        if (std.mem.eql(u8, word, "word") and r.take(" break")) return;
        for (keywords) |known| if (std.mem.eql(u8, word, known)) return;
        return error.InvalidValue;
    }
};
pub fn parse(a: std.mem.Allocator, source: []const u8) model.Error!*model.Value {
    const unicode = @import("unicode/unicode.zig");
    if (!unicode.utf8.validate(source)) return error.InvalidValue;
    const normal = try unicode.nfc(a, source);
    errdefer a.free(normal);
    var parser: Parser = .{ .reader = .{ .allocator = a, .input = normal } };
    try parser.pattern(0);
    if (parser.reader.pos != normal.len) return error.InvalidValue;
    return model.scalar(a, .{ .pattern = normal });
}
test "canonical sources are reparsed, resolved text splices and nesting guarded" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "<>", "<\"ID-\", 4 digits>", "< <4 digits>, \"x\">", "<last: word, \", \", first: word>", "<(quote & \"x\"), optional digit>", "<one or more of uppercase letters lazily>" }) |s| {
        const v = try parse(a, s);
        defer v.release();
        try std.testing.expectEqualStrings(s, v.data.pattern);
    }
    for ([_][]const u8{ "<nonsense>", "<1.5 digits>", "<optional>", "<line>", "<a map>", "<\"x\",>", "<digit> trailing" }) |s| try std.testing.expectError(error.InvalidValue, parse(a, s));
}

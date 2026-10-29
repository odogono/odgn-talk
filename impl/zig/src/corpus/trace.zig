//! Trace records are read from the generated corpus.toml catalogue. Filled
//! keys may be absent on authored inputs; outputs must carry them. Values
//! use the display reader, which stops before a following key=value.
const std = @import("std");
const schema = @import("../generated/corpus.zig");
const display = @import("../display.zig");
const model = @import("../value.zig");
pub const Field = struct { key: []const u8, value: []const u8 };
pub const Record = struct {
    input: bool,
    name: []const u8,
    ids: []const []const u8,
    fields: []Field,
    pub fn deinit(self: Record, a: std.mem.Allocator) void {
        a.free(self.ids);
        a.free(self.fields);
    }
};
fn id(s: []const u8) bool {
    if (s.len == 0 or !(std.ascii.isAlphanumeric(s[0]) or s[0] == '_')) return false;
    for (s) |c| if (!(std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_./:+-", c) != null)) return false;
    return true;
}
fn count(s: []const u8, positive: bool) bool {
    if (s.len == 0 or (s.len > 1 and s[0] == '0') or (positive and s[0] == '0')) return false;
    for (s) |c| if (!std.ascii.isDigit(c)) return false;
    return true;
}
fn keyName(s: []const u8) bool {
    if (s.len == 0 or !(std.ascii.isAlphabetic(s[0]) or s[0] == '_')) return false;
    for (s) |c| if (!std.ascii.isAlphanumeric(c) and c != '_' and c != '-') return false;
    return true;
}
fn token(r: *display.Reader) []const u8 {
    const start = r.pos;
    while (r.pos < r.input.len and r.input[r.pos] != ' ') : (r.pos += 1) {}
    return r.input[start..r.pos];
}
fn typed(r: *display.Reader, k: schema.CorpusTableRecordEntryKeyEntry) !void {
    const start = r.pos;
    if (std.mem.eql(u8, k.type, "value") or std.mem.eql(u8, k.type, "instant") or (std.mem.eql(u8, k.type, "target") and r.input[r.pos] == '<')) {
        const v = try r.read();
        defer v.release();
        if (std.mem.eql(u8, k.type, "instant") and v.data != .instant) return error.InvalidValue;
        return;
    }
    if (std.mem.eql(u8, k.type, "ids")) {
        if (!r.take("[")) return error.InvalidValue;
        if (!r.take("]")) while (true) {
            const begin = r.pos;
            while (r.pos < r.input.len and r.input[r.pos] != ',' and r.input[r.pos] != ']') : (r.pos += 1) {}
            if (!id(r.input[begin..r.pos])) return error.InvalidValue;
            if (r.take("]")) break;
            if (!r.take(", ")) return error.InvalidValue;
        };
        return;
    }
    const s = token(r);
    if (s.len == 0) return error.InvalidValue;
    if (std.mem.eql(u8, k.type, "count")) {
        if (!count(s, false)) return error.InvalidValue;
    } else if (std.mem.eql(u8, k.type, "word")) {
        if (k.words) |words| {
            for (words) |w| if (std.mem.eql(u8, w, s)) return;
            return error.InvalidValue;
        }
        if (!id(s)) return error.InvalidValue;
    } else if (std.mem.eql(u8, k.type, "hex")) {
        for (s) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return error.InvalidValue;
    } else if (std.mem.eql(u8, k.type, "at") or std.mem.eql(u8, k.type, "pos")) {
        const colon = std.mem.lastIndexOfScalar(u8, s, ':') orelse return error.InvalidValue;
        if (!count(s[colon + 1 ..], std.mem.eql(u8, k.type, "pos"))) return error.InvalidValue;
        if (std.mem.eql(u8, k.type, "pos")) {
            if (!count(s[0..colon], true)) return error.InvalidValue;
        } else if (!id(s[0..colon])) return error.InvalidValue;
    } else if (!id(s)) return error.InvalidValue;
    if (r.pos == start) return error.InvalidValue;
}
/// The catalogue's description of the Host Input or output record `name`.
fn descriptor(input: bool, name: []const u8) ?schema.CorpusTableRecordEntry {
    for (schema.corpus.record) |record| if (record.input == input and std.mem.eql(u8, record.name, name)) return record;
    return null;
}
/// The number of `ids` a record must write: a trailing `?` marks one that may
/// be absent.
fn requiredIds(ids: []const []const u8) usize {
    var required: usize = 0;
    for (ids) |name| {
        if (!std.mem.endsWith(u8, name, "?")) required += 1;
    }
    return required;
}
/// Whether a line may leave a key out: an optional one, a list of ids,
/// which is written only when it isn't empty, or a filled input key in an
/// authored line.
fn omittable(k: schema.CorpusTableRecordEntryKeyEntry, input: bool, authored: bool) bool {
    if (k.optional orelse false) return true;
    if (std.mem.eql(u8, k.type, "ids")) return true;
    return input and authored and (k.filled orelse false);
}

/// Reads an authored Trace line, which may leave filled input keys out.
/// Comments and blank lines give null.
pub fn parse(a: std.mem.Allocator, line: []const u8, resolver: display.Resolver) !?Record {
    return parseMode(a, line, resolver, true);
}
fn parseMode(a: std.mem.Allocator, line: []const u8, resolver: display.Resolver, authored: bool) !?Record {
    if (line.len == 0 or line[0] == '#') return null;
    if (line[line.len - 1] == ' ' or std.mem.indexOfAny(u8, line, "\r\n\t") != null) return error.InvalidValue;
    var r: display.Reader = .{ .allocator = a, .input = line, .resolver = resolver };
    const input = r.take("> ");
    const name = token(&r);
    const spec = descriptor(input, name) orelse return error.InvalidValue;
    var ids: std.ArrayList([]const u8) = .empty;
    errdefer ids.deinit(a);
    var fields: std.ArrayList(Field) = .empty;
    errdefer fields.deinit(a);
    while (r.pos < line.len) {
        if (!r.take(" ")) return error.InvalidValue;
        const start = r.pos;
        const part = token(&r);
        if (std.mem.indexOfScalar(u8, part, '=') != null) {
            r.pos = start - 1;
            break;
        }
        if (!id(part) or ids.items.len >= spec.ids.len) return error.InvalidValue;
        try ids.append(a, part);
    }
    // Refused inputs legitimately omit ids; an output omits only optional ones.
    if (!input and ids.items.len < requiredIds(spec.ids)) return error.InvalidValue;
    const keys = spec.key orelse &.{};
    var next: usize = 0;
    while (r.pos < line.len) {
        if (!r.take(" ")) return error.InvalidValue;
        const begin = r.pos;
        while (r.pos < line.len and line[r.pos] != '=' and line[r.pos] != ' ') : (r.pos += 1) {}
        const key = line[begin..r.pos];
        if (!keyName(key) or !r.take("=")) return error.InvalidValue;
        for (fields.items) |field| if (std.mem.eql(u8, field.key, key)) return error.InvalidValue;
        var chosen: ?schema.CorpusTableRecordEntryKeyEntry = null;
        if (std.mem.eql(u8, name, "vars")) chosen = .{ .key = key, .type = "value", .is = "Script Variable" } else {
            while (next < keys.len) : (next += 1) {
                const k = keys[next];
                if (std.mem.eql(u8, k.key, key)) {
                    chosen = k;
                    next += 1;
                    break;
                }
                if (!omittable(k, input, authored)) return error.InvalidValue;
            }
        }
        const k = chosen orelse return error.InvalidValue;
        const value_start = r.pos;
        if (r.pos == line.len) return error.InvalidValue;
        try typed(&r, k);
        try fields.append(a, .{ .key = key, .value = line[value_start..r.pos] });
    }
    for (keys[next..]) |k| if (!omittable(k, input, authored)) return error.InvalidValue;
    if (std.mem.eql(u8, name, "charge-request")) {
        const amount = try display.parse(a, fields.items[0].value, resolver);
        defer amount.release();
        switch (amount.data) {
            .text => |v| if (!std.mem.eql(u8, v, "invalid")) return error.InvalidValue,
            .number => |n| if ((n.integer(u64) catch return error.InvalidValue) > 9_007_199_254_740_991) return error.InvalidValue,
            else => return error.InvalidValue,
        }
    }
    var refusal = false;
    var returned = false;
    var automatic = false;
    for (fields.items) |f| {
        refusal = refusal or std.mem.eql(u8, f.key, "charge-refused");
        returned = returned or std.mem.eql(u8, f.key, "result") or std.mem.eql(u8, f.key, "value") or std.mem.eql(u8, f.key, "error");
        automatic = automatic or std.mem.eql(u8, f.key, "automatic");
    }
    if (refusal and (returned or automatic)) return error.InvalidValue;
    const owned_ids = try ids.toOwnedSlice(a);
    errdefer a.free(owned_ids);
    return .{ .input = input, .name = name, .ids = owned_ids, .fields = try fields.toOwnedSlice(a) };
}
/// A replay backend. The runner owns comparison; the backend owns Group
/// construction, Host Inputs and Trace generation, and says which cases it
/// can replay.
pub const Replay = struct {
    /// Why the backend can't replay a case, or null when it can.
    supports: *const fn (a: std.mem.Allocator, setup: []const u8, trace: []const u8) ?[]const u8,
    /// Replays a case from its directory, returning the Trace written; with
    /// `round_trip`, saving and restoring between each pair of Pumps
    /// (chapter 11, Save and restore replays).
    run: *const fn (gpa: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, setup: []const u8, trace: []const u8, round_trip: bool) anyerror![]u8,
};

test "filled input keys and values followed by Trace keys" {
    const a = std.testing.allocator;
    const load = (try parse(a, "> load orders", .{})).?;
    defer load.deinit(a);
    const pump = (try parse(a, "> pump clock=2026-09-27T00:00:00Z", .{})).?;
    defer pump.deinit(a);
    const answer = (try parse(a, "> answer orders/r1.c1 value=2.50 GBP fuel=9", .{})).?;
    defer answer.deinit(a);
    try std.testing.expectEqualStrings("2.50 GBP", answer.fields[0].value);
    const vars = (try parse(a, "vars orders n=3 text=\"x\" & newline", .{})).?;
    defer vars.deinit(a);
    try std.testing.expectError(error.InvalidValue, parse(a, "pumped state=idle", .{}));
}

test "ids marked optional in the catalogue may be absent, others may not" {
    const a = std.testing.allocator;
    const sent = (try parse(a, "unhandled message=frob args=[1]", .{})).?;
    defer sent.deinit(a);
    try std.testing.expectEqual(@as(usize, 0), sent.ids.len);
    const delivered = (try parse(a, "unhandled d1 message=frob args=[1]", .{})).?;
    defer delivered.deinit(a);
    try std.testing.expectEqualStrings("d1", delivered.ids[0]);
    const cancelled = (try parse(a, "run outcome=cancelled delivery=d2 fuel=0 alloc=0", .{})).?;
    defer cancelled.deinit(a);
    try std.testing.expectError(error.InvalidValue, parse(a, "unhandled d1 d2 message=frob args=[1]", .{}));
    try std.testing.expectEqual(@as(usize, 1), requiredIds(&.{ "script", "run?" }));
}

/// Compare authored input to a fully written record, permitting only the
/// catalogue's filled fields to appear in actual but not expected. The
/// display reader's resolver is immaterial to equality of canonical bytes;
/// callers with object/function crossings can provide it when validating.
fn anyObject(context: ?*anyopaque, kind: []const u8, object_id: []const u8) model.Error!*model.Value {
    const a: *const std.mem.Allocator = @ptrCast(@alignCast(context.?));
    return model.object(a.*, kind, object_id, 0);
}

/// A Function Value, as a Trace shows it: compared by its display form.
fn anyFunction(context: ?*anyopaque, shown: []const u8) model.Error!*model.Value {
    const a: *const std.mem.Allocator = @ptrCast(@alignCast(context.?));
    const captures = try model.map(a.*, &.{});
    defer captures.release();
    return model.function(a.*, "", shown, 0, captures);
}

/// A line a Core wrote, with any Host Object or Function Value it shows.
pub fn parseWritten(a: std.mem.Allocator, line: []const u8) !?Record {
    var gpa = a;
    const objects: display.Resolver = .{ .context = @ptrCast(&gpa), .object = anyObject, .function = anyFunction };
    return parseMode(a, line, objects, false);
}

pub fn matches(a: std.mem.Allocator, expected: []const u8, actual: []const u8) !bool {
    if (std.mem.eql(u8, expected, actual) and !std.mem.startsWith(u8, actual, "> ")) return true;
    // Host Objects are compared by their display form, kind and id, and
    // Function Values by their display form.
    var gpa = a;
    const objects: display.Resolver = .{ .context = @ptrCast(&gpa), .object = anyObject, .function = anyFunction };
    const x = (try parse(a, expected, objects)) orelse return false;
    defer x.deinit(a);
    const y = (try parseMode(a, actual, objects, false)) orelse return false;
    defer y.deinit(a);
    if (x.input != y.input or !std.mem.eql(u8, x.name, y.name) or x.ids.len != y.ids.len) return false;
    for (x.ids, y.ids) |left, right| if (!std.mem.eql(u8, left, right)) return false;
    const fields = (descriptor(x.input, x.name) orelse return false).key orelse &.{};
    var next: usize = 0;
    for (y.fields) |field| {
        if (next < x.fields.len and std.mem.eql(u8, x.fields[next].key, field.key)) {
            if (!std.mem.eql(u8, x.fields[next].value, field.value)) return false;
            next += 1;
        } else {
            var filled = false;
            if (x.input) for (fields) |k| if (std.mem.eql(u8, k.key, field.key) and (k.filled orelse false)) {
                filled = true;
                break;
            };
            if (!filled) return false;
        }
    }
    return next == x.fields.len;
}
test "filled keys compare against actual output but never hide divergences" {
    const a = std.testing.allocator;
    try std.testing.expect(try matches(a, "> load orders", "> load orders identity=abc012"));
    try std.testing.expect(!try matches(a, "> load orders identity=abc012", "> load orders identity=abc013"));
    try std.testing.expect(!try matches(a, "> pump clock=2026-09-27T00:00:00Z", "> pump clock=2026-09-28T00:00:00Z"));
}

test "metering records validate ordered fields, normalized invalid amounts and latched refusal" {
    const a = std.testing.allocator;
    for ([_][]const u8{
        "> charge-request s/r1.c1 q1 fuel=0",
        "> charge-request s/r1.c1 fuel=\"invalid\"",
        "charge-result s/r1.c1 q1 fuel=19 status=accepted",
        "call s/r1.c1 op=api.fetch args=[] charged=19 charge-refused=yes",
        "call s/r1.c1 op=api.fetch args=[] charge-refused=yes",
        "> stub api.fetch charge=19 charge-refused=yes",
        "> stub api.fetch charge-refused=yes",
    }) |line| {
        const r = (try parse(a, line, .{})).?;
        r.deinit(a);
    }
    for ([_][]const u8{
        "> charge-request s/r1.c1 q1 fuel=1.5",
        "> charge-request s/r1.c1 fuel=\"bad\"",
        "> charge-request s/r1.c1 q1 fuel=9007199254740992",
        "charge-result s/r1.c1 fuel=19 status=accepted",
        "charge-result s/r1.c1 q1 fuel=19 status=unknown",
        "call s/r1.c1 op=api.fetch args=[] result=nothing charge-refused=yes",
        "> stub api.fetch value=nothing charge-refused=yes",
        "> stub api.fetch charge-refused=no",
    }) |line| try std.testing.expectError(error.InvalidValue, parse(a, line, .{}));
}

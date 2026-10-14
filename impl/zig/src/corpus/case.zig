//! A case's setup, as the front end needs it: its Scripts and Libraries,
//! each Script's well-known objects and Grants, and its Disassembly Cases'
//! units. It reads only the case.toml shapes the Corpus uses: top-level and
//! `[[table]]` keys, each on one line, with strings, arrays and inline tables
//! as values.
const std = @import("std");
const Allocator = std.mem.Allocator;
const check = @import("../check/check.zig");
const stdlib = @import("../generated/stdlib.zig").stdlib;

pub const Value = union(enum) {
    string: []const u8,
    array: []const Value,
    table: []const Entry,
    /// A number, boolean or anything else, as written.
    raw: []const u8,

    pub const Entry = struct { key: []const u8, value: Value };

    pub fn get(self: Value, key: []const u8) ?Value {
        if (self != .table) return null;
        for (self.table) |e| if (std.mem.eql(u8, e.key, key)) return e.value;
        return null;
    }
};

pub const Error = error{MalformedCase} || Allocator.Error;

const Reader = struct {
    s: []const u8,
    i: usize = 0,

    fn space(r: *Reader) void {
        while (r.i < r.s.len and (r.s[r.i] == ' ' or r.s[r.i] == '\t')) r.i += 1;
    }

    fn value(r: *Reader, a: Allocator) Error!Value {
        r.space();
        if (r.i >= r.s.len) return error.MalformedCase;
        switch (r.s[r.i]) {
            '"', '\'' => {
                const q = r.s[r.i];
                const start = r.i + 1;
                const end = std.mem.indexOfScalarPos(u8, r.s, start, q) orelse return error.MalformedCase;
                r.i = end + 1;
                return .{ .string = r.s[start..end] };
            },
            '[' => {
                r.i += 1;
                var items: std.ArrayList(Value) = .empty;
                while (true) {
                    r.space();
                    if (r.i < r.s.len and r.s[r.i] == ']') break;
                    try items.append(a, try r.value(a));
                    r.space();
                    if (r.i < r.s.len and r.s[r.i] == ',') r.i += 1;
                }
                r.i += 1;
                return .{ .array = items.items };
            },
            '{' => {
                r.i += 1;
                var entries: std.ArrayList(Value.Entry) = .empty;
                while (true) {
                    r.space();
                    if (r.i < r.s.len and r.s[r.i] == '}') break;
                    const start = r.i;
                    while (r.i < r.s.len and r.s[r.i] != '=' and r.s[r.i] != ' ') r.i += 1;
                    const key = std.mem.trim(u8, r.s[start..r.i], "\"");
                    r.space();
                    if (r.i >= r.s.len or r.s[r.i] != '=') return error.MalformedCase;
                    r.i += 1;
                    try entries.append(a, .{ .key = key, .value = try r.value(a) });
                    r.space();
                    if (r.i < r.s.len and r.s[r.i] == ',') r.i += 1;
                }
                r.i += 1;
                return .{ .table = entries.items };
            },
            else => {
                const start = r.i;
                while (r.i < r.s.len and r.s[r.i] != ',' and r.s[r.i] != '}' and r.s[r.i] != ']') r.i += 1;
                return .{ .raw = std.mem.trim(u8, r.s[start..r.i], " ") };
            },
        }
    }
};

/// One table of case.toml: its header and its keys.
pub const Table = struct { header: []const u8, entries: []const Value.Entry };

/// Reads case.toml into its tables, the root's first, with no header.
pub fn tables(a: Allocator, toml: []const u8) Error![]const Table {
    var out: std.ArrayList(Table) = .empty;
    var header: []const u8 = "";
    var entries: std.ArrayList(Value.Entry) = .empty;
    var lines = std.mem.splitScalar(u8, toml, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        if (line[0] == '[') {
            try out.append(a, .{ .header = header, .entries = entries.items });
            header = line;
            entries = .empty;
            continue;
        }
        const eq = std.mem.indexOf(u8, line, " = ") orelse return error.MalformedCase;
        var r: Reader = .{ .s = line[eq + 3 ..] };
        try entries.append(a, .{ .key = line[0..eq], .value = try r.value(a) });
    }
    try out.append(a, .{ .header = header, .entries = entries.items });
    return out.items;
}

pub fn field(t: Table, key: []const u8) ?Value {
    for (t.entries) |e| if (std.mem.eql(u8, e.key, key)) return e.value;
    return null;
}

fn string(t: Table, key: []const u8) []const u8 {
    const v = field(t, key) orelse return "";
    return if (v == .string) v.string else "";
}

pub const Unit = struct {
    name: []const u8,
    source: []const u8,
    library: bool,
    objects: []const check.Object,
    grants: []const check.Grant,
};

pub const Disassembly = struct { unit: []const u8, expected: []const u8 };

pub const Setup = struct {
    units: []const Unit,
    disassembly: []const Disassembly,
};

const Declared = struct { capability: []const u8, operation: check.Operation };

fn parseMode(s: []const u8) check.Mode {
    if (std.mem.eql(u8, s, "suspending")) return .suspending;
    if (std.mem.eql(u8, s, "fire-and-forget")) return .fire_and_forget;
    return .immediate;
}

/// An Operation's arity from its declared arguments: a trailing run of
/// Optional Shapes may be left off.
fn arity(args: []const Value) struct { required: usize, total: usize } {
    var required = args.len;
    while (required > 0 and args[required - 1].get("optional") != null) required -= 1;
    return .{ .required = required, .total = args.len };
}

/// A Standard Capability's arity from stdlib.toml's `call`, where `[ … ]`
/// marks an optional argument.
fn standardArity(call: []const u8) struct { required: usize, total: usize } {
    const space = std.mem.indexOfScalar(u8, call, ' ') orelse return .{ .required = 0, .total = 0 };
    var required: usize = 0;
    var total: usize = 0;
    var optional = false;
    var word = false;
    for (call[space + 1 ..]) |ch| switch (ch) {
        '[' => optional = true,
        ']' => optional = false,
        ',', ' ' => word = false,
        else => if (!word) {
            word = true;
            total += 1;
            if (!optional) required += 1;
        },
    };
    return .{ .required = required, .total = total };
}

/// Reads a case's setup.
pub fn read(a: Allocator, toml: []const u8) Error!Setup {
    return fromTables(a, try tables(a, toml));
}

/// A case's setup, from its tables.
pub fn fromTables(a: Allocator, all: []const Table) Error!Setup {
    var declared: std.ArrayList(Declared) = .empty;
    for (all) |t| {
        if (std.mem.eql(u8, t.header, "[[operations]]")) {
            const args = if (field(t, "args")) |v| (if (v == .array) v.array else &.{}) else &.{};
            const n = arity(args);
            try declared.append(a, .{ .capability = string(t, "capability"), .operation = .{ .name = string(t, "name"), .mode = parseMode(string(t, "mode")), .required = n.required, .total = n.total } });
        } else if (std.mem.eql(u8, t.header, "[[standard]]")) {
            const capability = string(t, "capability");
            for (stdlib.operation) |o| if (std.mem.eql(u8, o.capability, capability)) {
                const n = standardArity(o.call);
                try declared.append(a, .{ .capability = capability, .operation = .{ .name = o.name, .mode = parseMode(o.mode), .required = n.required, .total = n.total } });
            };
        }
    }
    var units: std.ArrayList(Unit) = .empty;
    var disassembly: std.ArrayList(Disassembly) = .empty;
    for (all) |t| {
        const library = std.mem.eql(u8, t.header, "[[libraries]]");
        if (library or std.mem.eql(u8, t.header, "[[scripts]]")) {
            var objects: std.ArrayList(check.Object) = .empty;
            if (field(t, "objects")) |v| if (v == .table) for (v.table) |o| {
                const kind = o.value.get("kind") orelse continue;
                if (kind == .string) try objects.append(a, .{ .name = o.key, .kind = kind.string });
            };
            var grants: std.ArrayList(check.Grant) = .empty;
            if (field(t, "grants")) |v| if (v == .table) for (v.table) |g| {
                const capability = if (g.value.get("capability")) |c| (if (c == .string) c.string else g.key) else g.key;
                const ops = g.value.get("ops");
                var operations: std.ArrayList(check.Operation) = .empty;
                for (declared.items) |d| {
                    if (!std.mem.eql(u8, d.capability, capability)) continue;
                    const granted = if (ops) |o| switch (o) {
                        .string => |s| std.mem.eql(u8, s, "all"),
                        .array => |names| for (names) |n| {
                            if (n == .string and std.mem.eql(u8, n.string, d.operation.name)) break true;
                        } else false,
                        else => false,
                    } else false;
                    if (granted) try operations.append(a, d.operation);
                }
                try grants.append(a, .{ .name = g.key, .operations = operations.items });
            };
            try units.append(a, .{ .name = string(t, "name"), .source = string(t, "source"), .library = library, .objects = objects.items, .grants = grants.items });
        } else if (std.mem.eql(u8, t.header, "[[disassembly]]")) {
            try disassembly.append(a, .{ .unit = string(t, "unit"), .expected = string(t, "expected") });
        }
    }
    return .{ .units = units.items, .disassembly = disassembly.items };
}

test "inline tables, arrays and Grants" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const setup = try read(arena.allocator(),
        \\kind = "trace"
        \\[[operations]]
        \\capability = "log"
        \\name = "write"
        \\mode = "fire-and-forget"
        \\args = ["text", { optional = "text" }]
        \\[[standard]]
        \\capability = "clock"
        \\[[scripts]]
        \\name = "s"
        \\source = "s.talk"
        \\grants = { out = { capability = "log", ops = "all", binding = { a = "b", n = 1 } }, clock = { ops = ["now"] } }
        \\objects = { bulb = { kind = "light", id = "b-1" } }
        \\[[disassembly]]
        \\unit = "s"
        \\expected = "s.dis"
    );
    const u = setup.units[0];
    try std.testing.expectEqualStrings("s.talk", u.source);
    try std.testing.expectEqualStrings("light", u.objects[0].kind);
    try std.testing.expectEqualStrings("out", u.grants[0].name);
    try std.testing.expectEqual(check.Mode.fire_and_forget, u.grants[0].operations[0].mode);
    try std.testing.expectEqual(@as(usize, 1), u.grants[0].operations[0].required);
    try std.testing.expectEqual(@as(usize, 2), u.grants[0].operations[0].total);
    try std.testing.expectEqualStrings("now", u.grants[1].operations[0].name);
    try std.testing.expectEqualStrings("s.dis", setup.disassembly[0].expected);
}

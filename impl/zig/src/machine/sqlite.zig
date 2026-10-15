//! `sqlite`'s values at the boundary (chapter 7, `sqlite`; chapter 9, The
//! `sqlite` factory): the Core checks `max` and `params`, converts `params`
//! into SQL values, and converts the rows the Host gives back, raising `sql`
//! for a column named twice and `unrepresentable` for a value it can't hold.
//! The structs are laid out as talk.h's.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const caps = @import("capabilities.zig");
const Value = model.Value;
const Decimal = model.Decimal;

/// A SQL value's storage class. Non-exhaustive: a Host's malformed kind is
/// `host error`.
pub const Kind = enum(c_int) { null, integer, real, text, blob, _ };

/// `NULL`, an `INTEGER`, a `REAL`, or `TEXT` or a `BLOB` in `bytes`.
pub const SqlValue = extern struct {
    kind: Kind,
    integer: i64 = 0,
    real: f64 = 0,
    bytes: ?[*]const u8 = null,
    len: usize = 0,
};

/// A list bound to `?` and `?NNN`, or with `named` a name map bound to
/// `:name`, keyed without the colon.
pub const Params = extern struct {
    named: bool,
    values: ?[*]const SqlValue,
    names: ?[*]const [*]const u8,
    name_lens: ?[*]const usize,
    len: usize,
};

/// A result: its column names, and `rows_len` rows of `columns_len` values,
/// row by row; `change` also gives `changes`.
pub const Rows = extern struct {
    columns: ?[*]const ?[*]const u8 = null,
    column_lens: ?[*]const usize = null,
    columns_len: usize = 0,
    values: ?[*]const SqlValue = null,
    rows_len: usize = 0,
    changes: i64 = 0,
};

/// A Grant's binding: the Host's database, the tables it may use, and its
/// row cap.
pub const Binding = extern struct {
    database: ?[*]const u8,
    database_len: usize,
    tables: ?[*]const ?[*]const u8 = null,
    table_lens: ?[*]const usize = null,
    tables_len: usize = 0,
    has_tables: bool = false,
    max_rows: i64,
};

/// The largest row cap and per-row cost.
pub const max_whole: i64 = 9_007_199_254_740_991;

pub fn bindingOf(binding: ?*anyopaque) ?*const Binding {
    return @ptrCast(@alignCast(binding orelse return null));
}

/// Whether a binding is well formed: a database, and a row cap from 0 to
/// `max_whole`.
pub fn validBinding(b: *const Binding) bool {
    if (b.max_rows < 0 or b.max_rows > max_whole) return false;
    if (b.database_len > 0 and b.database == null) return false;
    if (b.has_tables and b.tables_len > 0 and (b.tables == null or b.table_lens == null)) return false;
    return true;
}

/// The rows a call may give: its `max`, or the binding's cap when omitted
/// or Nothing.
pub fn effectiveMax(args: []const *Value, b: *const Binding) u64 {
    if (args.len > 2) if (args[2].data == .number) return args[2].data.number.integer(u64) catch 0;
    return @intCast(b.max_rows);
}

/// The kinds a parameter may be, as `wrong kind` names them.
const parameter_kinds = "nothing or number or text or bytes or boolean";

/// The Core's checks before a `query` or `change` is charged: `max`, then
/// that `params` is a list or a map, then each value in it, in order.
pub fn check(a: Allocator, args: []const *Value, binding: ?*anyopaque) Allocator.Error!?caps.Problem {
    const b = bindingOf(binding) orelse return null;
    if (args.len > 2 and args[2].data == .number) {
        const whole = args[2].data.number.integer(i64) catch null;
        if (whole == null or whole.? < 0 or whole.? > b.max_rows) return .{ .out_of_range = .{ .field = "max", .value = args[2] } };
    }
    const given = args[1];
    switch (given.data) {
        .list => |items| for (items, 1..) |v, i| if (!bindable(v)) {
            // The path outlives the call, so it is the Group's.
            const index = model.scalar(given.allocator, .{ .number = Decimal.fromInt(@as(i64, @intCast(i))) }) catch return error.OutOfMemory;
            return try wrong(a, parameter_kinds, v, index);
        },
        .map => |pairs| for (0..pairs.len) |map_index| {
            const p = pairs.at(map_index);
            if (!bindable(p.value)) {
                const key = model.text(given.allocator, p.key) catch return error.OutOfMemory;
                return try wrong(a, parameter_kinds, p.value, key);
            }
        },
        else => return try wrong(a, "list or map", given, null),
    }
    return null;
}

fn bindable(v: *const Value) bool {
    return switch (v.data) {
        .nothing, .number, .text, .bytes, .bool => true,
        else => false,
    };
}

/// `wrong kind` at `params`, argument 2, with the parameter's position or
/// key as its path. The path value lives in `a`'s values.
fn wrong(a: Allocator, expected: []const u8, v: *Value, at: ?*Value) Allocator.Error!caps.Problem {
    const path: []const *Value = if (at) |x| try a.dupe(*Value, &.{x}) else &.{};
    return .{ .mismatch = .{ .bad = .{ .wrong_kind = .{ .expected = expected, .got = kindName(v), .value = v, .path = path } }, .position = 2, .keep = at } };
}

fn kindName(v: *const Value) []const u8 {
    return switch (v.data) {
        .bool => "boolean",
        .civil_date => "civil date",
        else => @tagName(v.data),
    };
}

/// A value bound as a SQL value: a number with no fraction digits that
/// fits 64 bits as `INTEGER`, any other as `REAL` by the nearest double.
fn sqlValue(a: Allocator, v: *const Value) !SqlValue {
    return switch (v.data) {
        .nothing => .{ .kind = .null },
        .bool => |x| .{ .kind = .integer, .integer = @intFromBool(x) },
        .text => |t| .{ .kind = .text, .bytes = t.ptr, .len = t.len },
        .bytes => |t| .{ .kind = .blob, .bytes = t.ptr, .len = t.len },
        .number => |n| blk: {
            const shown = try n.string(a);
            if (std.mem.indexOfScalar(u8, shown, '.') == null) {
                if (std.fmt.parseInt(i64, shown, 10)) |i| break :blk .{ .kind = .integer, .integer = i } else |_| {}
            }
            break :blk .{ .kind = .real, .real = std.fmt.parseFloat(f64, shown) catch unreachable };
        },
        else => unreachable,
    };
}

/// `params` as SQL values, a list or a name map; `check` has passed.
pub fn params(a: Allocator, v: *const Value) !Params {
    switch (v.data) {
        .list => |items| {
            const values = try a.alloc(SqlValue, items.len);
            for (items, values) |x, *y| y.* = try sqlValue(a, x);
            return .{ .named = false, .values = values.ptr, .names = null, .name_lens = null, .len = items.len };
        },
        .map => |pairs| {
            const values = try a.alloc(SqlValue, pairs.len);
            const names = try a.alloc([*]const u8, pairs.len);
            const lens = try a.alloc(usize, pairs.len);
            for (0..pairs.len, values, names, lens) |i, *y, *n, *l| {
                const p = pairs.at(i);
                y.* = try sqlValue(a, p.value);
                n.* = p.key.ptr;
                l.* = p.key.len;
            }
            return .{ .named = true, .values = values.ptr, .names = names.ptr, .name_lens = lens.ptr, .len = pairs.len };
        },
        else => unreachable,
    }
}

/// What converting a result gives: the value, a Script error the Core
/// raises (`sql` or `unrepresentable`, with its one field), or `host error`
/// for a malformed result.
pub const Converted = union(enum) {
    value: *Value,
    failed: struct { code: []const u8, key: []const u8, text: []const u8 },
    broken,
};

/// Converts a result: its form, then its column names, then each value,
/// row by row in column order. `change` gives `{changes, rows}`.
pub fn convert(gpa: Allocator, a: Allocator, r: Rows, max: u64, change: bool) !Converted {
    if (r.rows_len > max or (change and r.changes < 0)) return .broken;
    if (r.columns_len > 0 and (r.columns == null or r.column_lens == null)) return .broken;
    if (r.rows_len > 0 and r.columns_len > 0 and r.values == null) return .broken;
    const names = try a.alloc([]const u8, r.columns_len);
    for (names, 0..) |*n, i| {
        const p = r.columns.?[i] orelse return .broken;
        n.* = p[0..r.column_lens.?[i]];
        if (!std.unicode.utf8ValidateSlice(n.*)) return .broken;
    }
    for (names, 0..) |n, i| for (names[0..i]) |m| if (std.mem.eql(u8, m, n)) {
        return .{ .failed = .{ .code = "sql", .key = "reason", .text = try std.fmt.allocPrint(a, "duplicate column {s}", .{n}) } };
    };
    var made: std.ArrayList(*Value) = .empty;
    defer {
        for (made.items) |v| v.release();
        made.deinit(a);
    }
    const values: []const SqlValue = if (r.values) |v| v[0 .. r.rows_len * r.columns_len] else &.{};
    var rows: std.ArrayList(*Value) = .empty;
    defer rows.deinit(a);
    for (0..r.rows_len) |row| {
        const pairs = try a.alloc(model.Pair, names.len);
        var built: usize = 0;
        defer for (pairs[0..built]) |p| p.value.release();
        for (names, 0..) |n, col| {
            const out = switch (try valueOf(gpa, values[row * names.len + col])) {
                .value => |v| v,
                .unrepresentable => return .{ .failed = .{ .code = "unrepresentable", .key = "column", .text = n } },
                .broken => return .broken,
            };
            pairs[col] = .{ .key = n, .value = out };
            built += 1;
        }
        const map = model.map(gpa, pairs) catch return .broken;
        try made.append(a, map);
        try rows.append(a, map);
    }
    const list = try model.list(gpa, rows.items);
    if (!change) return .{ .value = list };
    defer list.release();
    const changes = try model.scalar(gpa, .{ .number = Decimal.fromInt(r.changes) });
    defer changes.release();
    return .{ .value = try model.map(gpa, &.{ .{ .key = "changes", .value = changes }, .{ .key = "rows", .value = list } }) };
}

const Out = union(enum) { value: *Value, unrepresentable, broken };

/// A SQL value as a Script value: `REAL` as the shortest decimal that
/// reads back as the same double, `TEXT` as NFC text.
fn valueOf(gpa: Allocator, v: SqlValue) !Out {
    return switch (v.kind) {
        .null => .{ .value = try model.scalar(gpa, .nothing) },
        .integer => .{ .value = try model.scalar(gpa, .{ .number = Decimal.fromInt(v.integer) }) },
        .real => .{ .value = try model.scalar(gpa, .{ .number = Decimal.fromFloat(v.real) catch return .unrepresentable }) },
        .text => blk: {
            const t: []const u8 = if (v.len == 0) "" else (v.bytes orelse return .broken)[0..v.len];
            if (!std.unicode.utf8ValidateSlice(t)) break :blk .unrepresentable;
            break :blk .{ .value = model.text(gpa, t) catch return .unrepresentable };
        },
        .blob => .{ .value = try model.bytes(gpa, if (v.len == 0) "" else (v.bytes orelse return .broken)[0..v.len]) },
        _ => .broken,
    };
}

const testing = std.testing;

test "params bind integers, reals, text, bytes and booleans" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const list = try @import("../display.zig").parse(testing.allocator, "[3, 3.0, 9223372036854775808, true, \"t\", nothing]", .{});
    defer list.release();
    const p = try params(a, list);
    try testing.expectEqual(Kind.integer, p.values.?[0].kind);
    try testing.expectEqual(Kind.real, p.values.?[1].kind);
    try testing.expectEqual(Kind.real, p.values.?[2].kind);
    try testing.expectEqual(@as(i64, 1), p.values.?[3].integer);
    try testing.expectEqual(Kind.text, p.values.?[4].kind);
    try testing.expectEqual(Kind.null, p.values.?[5].kind);
}

test "results raise sql for a column named twice before unrepresentable values" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const columns = [_]?[*]const u8{ "a", "a" };
    const lens = [_]usize{ 1, 1 };
    const values = [_]SqlValue{ .{ .kind = .real, .real = std.math.nan(f64) }, .{ .kind = .integer, .integer = 1 } };
    const got = try convert(testing.allocator, a, .{ .columns = &columns, .column_lens = &lens, .columns_len = 2, .values = &values, .rows_len = 1 }, 1, false);
    try testing.expectEqualStrings("sql", got.failed.code);
    try testing.expectEqualStrings("duplicate column a", got.failed.text);
}

//! Disassembly Cases (chapter 11): each unit a case pins is compiled with its
//! Libraries' exports and its Script's Grants and objects, and its canonical
//! disassembly is compared byte for byte with the expected text.
const std = @import("std");
const Allocator = std.mem.Allocator;
const case_setup = @import("case.zig");
const parser = @import("../syntax/parser.zig");
const lexer = @import("../syntax/lexer.zig");
const ast = @import("../syntax/ast.zig");
const check = @import("../check/check.zig");
const lower = @import("../lower/lower.zig");

pub const Outcome = union(enum) {
    /// The units compared, and their lines.
    pass: usize,
    /// The first divergence, or why the case couldn't compile.
    fail: []const u8,
};

const Compiled = struct { tree: *ast.Tree, checked: check.Result, context: check.Context };

/// Runs the Disassembly Case in `dir`, whose case.toml is `toml`.
pub fn run(a: Allocator, io: std.Io, dir: std.Io.Dir, toml: []const u8) !Outcome {
    const setup = case_setup.read(a, toml) catch |e| switch (e) {
        error.MalformedCase => return .{ .fail = "invalid case.toml" },
        else => |other| return other,
    };
    // Libraries first, each seeing the exports of those before it, until
    // every import resolves.
    var libraries: std.ArrayList(check.Library) = .empty;
    for (setup.units) |u| if (u.library) try libraries.append(a, .{ .name = u.name, .exports = &.{} });
    var compiled: std.StringHashMapUnmanaged(Compiled) = .empty;
    for (0..libraries.items.len + 1) |_| {
        var i: usize = 0;
        for (setup.units) |u| if (u.library) {
            const c = try compile(a, io, dir, u, libraries.items) orelse return .{ .fail = try std.fmt.allocPrint(a, "{s}: syntax error", .{u.source}) };
            libraries.items[i].exports = try check.exports(a, c.tree, &c.checked);
            try compiled.put(a, u.name, c);
            i += 1;
        };
    }
    for (setup.units) |u| if (!u.library) {
        const c = try compile(a, io, dir, u, libraries.items) orelse return .{ .fail = try std.fmt.allocPrint(a, "{s}: syntax error", .{u.source}) };
        try compiled.put(a, u.name, c);
    };
    var lines: usize = 0;
    for (setup.disassembly) |d| {
        const c = compiled.get(d.unit) orelse return .{ .fail = try std.fmt.allocPrint(a, "no unit {s}", .{d.unit}) };
        if (c.checked.diagnostics.len > 0) {
            return .{ .fail = try std.fmt.allocPrint(a, "{s}: load diagnostic {s}", .{ d.unit, c.checked.diagnostics[0].code.spelling() }) };
        }
        const unit = try lower.lower(a, c.tree, &c.checked, .{ .name = d.unit, .context = c.context });
        var out: std.Io.Writer.Allocating = .init(a);
        try lower.disassemble(&unit, &out.writer);
        const want = try dir.readFileAlloc(io, d.expected, a, .unlimited);
        var got_lines = std.mem.splitScalar(u8, out.written(), '\n');
        var want_lines = std.mem.splitScalar(u8, want, '\n');
        var n: usize = 1;
        while (true) : (n += 1) {
            const g = got_lines.next();
            const w = want_lines.next();
            if (g == null and w == null) break;
            if (g == null or w == null or !std.mem.eql(u8, g.?, w.?)) {
                return .{ .fail = try std.fmt.allocPrint(a, "{s}: line {d}\n  expected: {s}\n  actual:   {s}", .{ d.expected, n, w orelse "<end>", g orelse "<end>" }) };
            }
        }
        lines += n - 2;
    }
    return .{ .pass = lines };
}

fn compile(a: Allocator, io: std.Io, dir: std.Io.Dir, u: case_setup.Unit, libraries: []const check.Library) !?Compiled {
    const source = try dir.readFileAlloc(io, u.source, a, .unlimited);
    const parsed = try parser.parse(a, source);
    if (parsed != .tree) return null;
    const tree = try a.create(ast.Tree);
    tree.* = parsed.tree;
    const context: check.Context = .{ .library = u.library, .objects = u.objects, .grants = if (u.library) null else u.grants, .libraries = libraries };
    return .{ .tree = tree, .checked = try check.check(a, tree, context), .context = context };
}

test "every Disassembly Case's expected disassembly" {
    const io = std.testing.io;
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root = try std.Io.Dir.cwd().openDir(io, "../../corpus/disassembly", .{ .iterate = true });
    defer root.close(io);
    var it = root.iterate();
    var cases: usize = 0;
    var failures: usize = 0;
    while (try it.next(io)) |entry| if (entry.kind == .directory) {
        var dir = try root.openDir(io, entry.name, .{});
        defer dir.close(io);
        const toml = try dir.readFileAlloc(io, "case.toml", a, .unlimited);
        cases += 1;
        switch (try run(a, io, dir, toml)) {
            .pass => {},
            .fail => |why| {
                failures += 1;
                std.debug.print("{s}: {s}\n", .{ entry.name, why });
            },
        }
    };
    try std.testing.expectEqual(@as(usize, 15), cases);
    try std.testing.expectEqual(@as(usize, 0), failures);
}

test "every case.toml in the Corpus reads" {
    const io = std.testing.io;
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(std.testing.allocator);
    defer walker.deinit();
    var failures: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.eql(u8, entry.basename, "case.toml")) {
        const toml = try dir.readFileAlloc(io, entry.path, arena.allocator(), .unlimited);
        _ = case_setup.read(arena.allocator(), toml) catch {
            failures += 1;
            std.debug.print("{s}: doesn't read\n", .{entry.path});
        };
    };
    try std.testing.expectEqual(@as(usize, 0), failures);
}

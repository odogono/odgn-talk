//! The corpus is read from disk and exercised through talk.h. Unsupported
//! kinds are named and skipped; a passing-list entry must actually pass.
//! Messages match the Go runner's (impl/go/internal/corpus/runner.go).
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const language_version = northtalk.generated.version.version.language;
const cost_model_version = northtalk.generated.costs.costs.version;
const schema = northtalk.generated.corpus.corpus;
const trace = northtalk.corpus_trace;
const model = northtalk.value;
const talk_replay = @import("talk_replay.zig");
const session_case = @import("session_case.zig");
const Kind = enum { trace, disassembly, transcript, encoding };
const Metadata = struct { kind: Kind, objects: bool };
/// What a malformed case.toml names, for its message.
const Problem = struct { kind: Kind = .trace, table: []const u8 = "", key: []const u8 = "" };
const MetadataError = error{ MalformedCase, InvalidCaseKind, UnsupportedVersions, UnexpectedTable, UnexpectedKey };

/// Whether corpus.toml's setup catalogue allows `table` (and `key`, unless
/// null) in a case of `kind`.
fn allowed(table: []const u8, key: ?[]const u8, kind: Kind) bool {
    for (schema.setup) |entry| {
        if (!std.mem.eql(u8, entry.table, table)) continue;
        if (key) |k| if (!std.mem.eql(u8, entry.key, k)) continue;
        for (entry.kinds) |name| if (std.mem.eql(u8, name, @tagName(kind))) return true;
    }
    return false;
}
fn quotedValue(value: []const u8) MetadataError![]const u8 {
    if (value.len < 2 or value[0] != '"') return error.MalformedCase;
    const end = std.mem.indexOfScalarPos(u8, value, 1, '"') orelse return error.MalformedCase;
    return value[1..end];
}
/// Reads case.toml as the Go runner's ReadSetup does: the kind, the language
/// and Cost Model versions, and every table and key held to corpus.toml's
/// setup catalogue for that kind. Keys nested below a table's own keys are
/// left to the backend that consumes them.
fn metadata(s: []const u8, problem: *Problem) MetadataError!Metadata {
    var kind: ?Kind = null;
    var language: ?[]const u8 = null;
    var cost: ?[]const u8 = null;
    var objects = false;
    var table: []const u8 = "";
    var nested = false;
    var lines = std.mem.splitScalar(u8, s, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        if (line[0] == '[') {
            // The kind is a root key, so it precedes every table.
            const k = kind orelse return error.InvalidCaseKind;
            const header = std.mem.trim(u8, line, "[] ");
            const dot = std.mem.indexOfScalar(u8, header, '.');
            table = header[0 .. dot orelse header.len];
            nested = dot != null;
            problem.* = .{ .kind = k, .table = table };
            if (!allowed(table, null, k)) return error.UnexpectedTable;
            if (dot) |d| {
                // [x.y] and [[x.y]] write key y of table x.
                const key = header[d + 1 ..];
                problem.key = key[0 .. std.mem.indexOfScalar(u8, key, '.') orelse key.len];
                if (!allowed(table, problem.key, k)) return error.UnexpectedKey;
            }
            objects = objects or std.mem.eql(u8, table, "objects");
            continue;
        }
        if (nested) continue;
        const equal = std.mem.indexOfScalar(u8, line, '=') orelse continue;
        const key = std.mem.trim(u8, line[0..equal], " \t");
        const value = std.mem.trim(u8, line[equal + 1 ..], " \t");
        if (table.len == 0 and std.mem.eql(u8, key, "kind")) {
            if (kind != null) return error.MalformedCase;
            kind = std.meta.stringToEnum(Kind, quotedValue(value) catch return error.InvalidCaseKind) orelse return error.InvalidCaseKind;
            continue;
        }
        const k = kind orelse return error.InvalidCaseKind;
        if (table.len == 0) {
            // Any other root key is a table written inline.
            problem.* = .{ .kind = k, .table = key };
            if (value.len == 0 or (value[0] != '{' and value[0] != '[') or !allowed(key, null, k)) return error.UnexpectedTable;
            objects = objects or std.mem.eql(u8, key, "objects");
            continue;
        }
        problem.* = .{ .kind = k, .table = table, .key = key };
        if (!allowed(table, key, k)) return error.UnexpectedKey;
        if (!std.mem.eql(u8, table, "versions")) continue;
        const text = quotedValue(value) catch return error.UnsupportedVersions;
        const slot = if (std.mem.eql(u8, key, "language")) &language else &cost;
        if (slot.* != null) return error.MalformedCase;
        slot.* = text;
    }
    const k = kind orelse return error.InvalidCaseKind;
    var cost_buffer: [24]u8 = undefined;
    const expected_cost = std.fmt.bufPrint(&cost_buffer, "{d}", .{cost_model_version}) catch unreachable;
    if (!std.mem.eql(u8, language orelse "", language_version) or !std.mem.eql(u8, cost orelse "", expected_cost)) return error.UnsupportedVersions;
    return .{ .kind = k, .objects = objects };
}
/// Writes the Go runner's message for a metadata error.
fn describe(w: *std.Io.Writer, err: MetadataError, problem: Problem) !void {
    switch (err) {
        error.MalformedCase => try w.writeAll("invalid case.toml"),
        error.InvalidCaseKind => try w.writeAll("invalid case kind"),
        error.UnsupportedVersions => try w.writeAll("unsupported or missing corpus versions"),
        error.UnexpectedTable => try w.print("unexpected case.toml table {s}", .{problem.table}),
        error.UnexpectedKey => try w.print("unexpected {s}.{s} in {t} case", .{ problem.table, problem.key, problem.kind }),
    }
}
/// Null when the runner can execute a case, or why it can't, in the Go
/// runner's words.
fn unsupported(case: Case, replay: ?trace.Replay) ?[]const u8 {
    const meta = case.meta;
    return switch (meta.kind) {
        .encoding => if (meta.objects) "Host Object registration is not implemented" else null,
        .trace => blk: {
            const r = replay orelse break :blk "trace execution is not implemented";
            var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
            defer arena.deinit();
            break :blk r.supports(arena.allocator(), case.setup, case.trace);
        },
        .disassembly, .transcript => null,
    };
}
fn read(init: std.process.Init, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(init.io, path, init.gpa, .limited(64 * 1024 * 1024));
}
fn less(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}
/// Whether `selector` names the case `name`, or a category containing it,
/// with or without a `corpus/` prefix.
fn selects(selector: []const u8, name: []const u8) bool {
    var path = std.mem.trimEnd(u8, selector, "/");
    if (std.mem.startsWith(u8, path, "../../corpus/")) path = path[13..] else if (std.mem.startsWith(u8, path, "corpus/")) path = path[7..];
    return std.mem.eql(u8, path, name) or (std.mem.startsWith(u8, name, path) and name.len > path.len and name[path.len] == '/');
}
fn selected(paths: []const []const u8, name: []const u8) bool {
    if (paths.len == 0) return true;
    for (paths) |path| if (selects(path, name)) return true;
    return false;
}
/// Replays an encoding case through talk.h. A divergence or malformed line
/// is described in `detail` and reported as error.CaseFailed.
fn encodingCase(init: std.process.Init, detail: *std.Io.Writer, name: []const u8, path: []const u8) !usize {
    const data = try read(init, path);
    defer init.gpa.free(data);
    if (data.len > 0 and data[data.len - 1] != '\n') {
        try detail.writeAll("encoding file must end with LF");
        return error.CaseFailed;
    }
    var lines = std.mem.splitScalar(u8, data[0..data.len -| 1], '\n');
    var count: usize = 0;
    var line_number: usize = 0;
    while (lines.next()) |line| {
        line_number += 1;
        if (line.len == 0 or line[0] == '#') continue;
        // Delimiter occurs outside text, brackets and patterns. A quoted
        // " => " is part of a value, never the encoding separator.
        var quoted = false;
        var separator: ?usize = null;
        for (line, 0..) |ch, i| {
            if (ch == '"') quoted = !quoted;
            if (!quoted and std.mem.startsWith(u8, line[i..], " => ")) {
                separator = i;
                break;
            }
        }
        const split = separator orelse {
            try detail.print("{s}: line {d}: missing encoding separator", .{ name, line_number });
            return error.CaseFailed;
        };
        var value: ?*c.talk_value = null;
        if (c.talk_parse_display(line.ptr, split, &value) != c.TALK_OK) {
            try detail.print("{s}: line {d}: invalid display value", .{ name, line_number });
            return error.CaseFailed;
        }
        defer c.talk_value_release(value);
        var actual: c.talk_owned_bytes = std.mem.zeroes(c.talk_owned_bytes);
        if (c.talk_encode_value(value, &actual) != c.TALK_OK) {
            try detail.print("{s}: line {d}: the value has no encoding", .{ name, line_number });
            return error.CaseFailed;
        }
        defer c.talk_owned_bytes_release(&actual);
        const got = actual.data[0..actual.len];
        const want = line[split + 4 ..];
        if (!std.mem.eql(u8, want, got)) {
            try detail.print("{s}: line {d} ({s})\n  expected: {s}\n  actual:   {s}", .{ name, line_number, line[0..split], want, got });
            return error.CaseFailed;
        }
        count += 1;
    }
    return count;
}
/// Replays a Trace case through `replay` and compares record by record.
/// Every Trace Case also replays with a save and restore between each pair
/// of Pumps, which must give the same Trace.
fn traceCase(init: std.process.Init, detail: *std.Io.Writer, name: []const u8, path: []const u8, setup: []const u8, replay: trace.Replay) !usize {
    const n = try traceCaseOnce(init, detail, name, path, setup, replay, false);
    _ = traceCaseOnce(init, detail, name, path, setup, replay, true) catch |err| {
        if (err == error.CaseFailed) try detail.writeAll("\n  (in the save and restore replay)");
        return err;
    };
    return n;
}

fn traceCaseOnce(init: std.process.Init, detail: *std.Io.Writer, name: []const u8, path: []const u8, setup: []const u8, replay: trace.Replay, round_trip: bool) !usize {
    const expected = try read(init, path);
    defer init.gpa.free(expected);
    const case_dir = try std.fmt.allocPrint(init.gpa, "../../corpus/{s}", .{name});
    defer init.gpa.free(case_dir);
    var dir = try std.Io.Dir.cwd().openDir(init.io, case_dir, .{});
    defer dir.close(init.io);
    const actual = try replay.run(init.gpa, init.io, dir, setup, expected, round_trip);
    defer init.gpa.free(actual);
    var want = std.mem.splitScalar(u8, expected, '\n');
    var got = std.mem.splitScalar(u8, actual, '\n');
    var count: usize = 0;
    while (true) {
        const x = nextRecord(&want);
        const y = nextRecord(&got);
        if (x == null and y == null) return count;
        count += 1;
        if (x == null or y == null or !try trace.matches(init.gpa, x.?, y.?)) {
            try detail.print("{s}: line {d}\n  expected: {s}\n  actual:   {s}", .{ name, count, x orelse "<end>", y orelse "<end>" });
            return error.CaseFailed;
        }
    }
}
fn nextRecord(lines: *std.mem.SplitIterator(u8, .scalar)) ?[]const u8 {
    while (lines.next()) |line| if (line.len > 0 and line[0] != '#') return line;
    return null;
}
/// One discovered case: its name under corpus/, its case.toml and metadata.
const Case = struct { name: []const u8, setup: []u8, meta: Metadata, trace: []u8 = &.{} };
const Runner = struct {
    init: std.process.Init,
    out: *std.Io.Writer,
    replay: ?trace.Replay,

    /// Runs one supported case and returns its line count, or prints the Go
    /// runner's FAIL report and returns null.
    fn execute(self: Runner, case: Case) !?usize {
        const gpa = self.init.gpa;
        if (case.meta.kind == .disassembly) return disassemblyCase(self, case);
        if (case.meta.kind == .transcript) return transcriptCase(self, case);
        var detail: std.Io.Writer.Allocating = .init(gpa);
        defer detail.deinit();
        const file = try std.fmt.allocPrint(gpa, "../../corpus/{s}/case.{s}", .{ case.name, if (case.meta.kind == .trace) "trace" else "encoding" });
        defer gpa.free(file);
        const result = if (case.meta.kind == .trace)
            traceCase(self.init, &detail.writer, case.name, file, case.setup, self.replay.?)
        else
            encodingCase(self.init, &detail.writer, case.name, file);
        if (result) |n| return n else |err| {
            if (err != error.CaseFailed) try detail.writer.print("{s}: {t}", .{ case.name, err });
            try self.out.print("FAIL {s}\n  reproduce: cd impl/zig && zig build corpus -- {s}\n", .{ detail.written(), case.name });
            return null;
        }
    }
};
/// A Session Transcript replays through the Session Host.
fn transcriptCase(self: Runner, case: Case) !?usize {
    const gpa = self.init.gpa;
    var detail: std.Io.Writer.Allocating = .init(gpa);
    defer detail.deinit();
    const case_dir = try std.fmt.allocPrint(gpa, "../../corpus/{s}", .{case.name});
    defer gpa.free(case_dir);
    var dir = try std.Io.Dir.cwd().openDir(self.init.io, case_dir, .{});
    defer dir.close(self.init.io);
    if (session_case.run(gpa, self.init.io, dir, case.name, &detail.writer)) |n| return n else |err| {
        if (err != error.CaseFailed) try detail.writer.print("{s}: {t}", .{ case.name, err });
        try self.out.print("FAIL {s}\n  reproduce: cd impl/zig && zig build corpus -- {s}\n", .{ detail.written(), case.name });
        return null;
    }
}
/// A Disassembly Case runs through the front end directly: the canonical
/// disassembly is a compiled unit's, which talk.h doesn't expose.
fn disassemblyCase(self: Runner, case: Case) !?usize {
    var arena: std.heap.ArenaAllocator = .init(self.init.gpa);
    defer arena.deinit();
    const path = try std.fmt.allocPrint(arena.allocator(), "../../corpus/{s}", .{case.name});
    var dir = try std.Io.Dir.cwd().openDir(self.init.io, path, .{});
    defer dir.close(self.init.io);
    switch (try northtalk.corpus_disassembly.run(arena.allocator(), self.init.io, dir, case.setup)) {
        .pass => |n| return n,
        .fail => |why| {
            try self.out.print("FAIL {s}: {s}\n  reproduce: cd impl/zig && zig build corpus -- {s}\n", .{ case.name, why, case.name });
            return null;
        },
    }
}
/// A machine backend plugs into this function; flags, discovery, passing
/// enforcement and first-divergence reporting stay in this runner.
pub fn run(init: std.process.Init, replay: ?trace.Replay) !u8 {
    const gpa = init.gpa;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    var list_only = false;
    var check = false;
    var paths: std.ArrayList([]const u8) = .empty;
    defer paths.deinit(gpa);
    var stdout_buffer: [8192]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &stdout_buffer);
    const w = &stdout.interface;
    defer w.flush() catch {};
    var stderr_buffer: [1024]u8 = undefined;
    var stderr = std.Io.File.stderr().writerStreaming(init.io, &stderr_buffer);
    const e = &stderr.interface;
    defer e.flush() catch {};
    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "--list")) list_only = true else if (std.mem.eql(u8, arg, "--check-passing")) check = true else if (std.mem.startsWith(u8, arg, "--")) {
            try e.print("unknown flag: {s}\n", .{arg});
            return 2;
        } else try paths.append(gpa, arg);
    }
    if (check and (list_only or paths.items.len != 0)) {
        try e.writeAll("--check-passing cannot be combined with other selections\n");
        return 1;
    }
    var dir = try std.Io.Dir.cwd().openDir(init.io, "../../corpus", .{ .iterate = true });
    defer dir.close(init.io);
    var walker = try dir.walk(gpa);
    defer walker.deinit();
    var names: std.ArrayList([]const u8) = .empty;
    defer {
        for (names.items) |name| gpa.free(name);
        names.deinit(gpa);
    }
    while (try walker.next(init.io)) |entry| if (entry.kind == .file and std.mem.eql(u8, entry.basename, "case.toml")) {
        const name = std.fs.path.dirname(entry.path).?;
        if (selected(paths.items, name)) try names.append(gpa, try gpa.dupe(u8, name));
    };
    std.mem.sort([]const u8, names.items, {}, less);
    for (paths.items) |selector| {
        for (names.items) |name| {
            if (selects(selector, name)) break;
        } else {
            try e.print("unknown case {s}\n", .{selector});
            return 1;
        }
    }
    var cases: std.ArrayList(Case) = .empty;
    defer {
        for (cases.items) |case| {
            gpa.free(case.setup);
            gpa.free(case.trace);
        }
        cases.deinit(gpa);
    }
    for (names.items) |name| {
        const path = try std.fmt.allocPrint(gpa, "../../corpus/{s}/case.toml", .{name});
        defer gpa.free(path);
        const setup = try read(init, path);
        var problem: Problem = .{};
        const meta = metadata(setup, &problem) catch |err| {
            gpa.free(setup);
            try e.print("corpus/{s}: ", .{name});
            try describe(e, err, problem);
            try e.writeByte('\n');
            return 1;
        };
        const trace_text: []u8 = if (meta.kind == .trace) blk: {
            const trace_path = try std.fmt.allocPrint(gpa, "../../corpus/{s}/case.trace", .{name});
            defer gpa.free(trace_path);
            break :blk read(init, trace_path) catch try gpa.alloc(u8, 0);
        } else try gpa.alloc(u8, 0);
        cases.append(gpa, .{ .name = name, .setup = setup, .meta = meta, .trace = trace_text }) catch |err| {
            gpa.free(setup);
            return err;
        };
    }
    if (list_only) {
        for (cases.items) |case| {
            if (unsupported(case, replay)) |reason| {
                try w.print("{s} ({t}; deferred: {s})\n", .{ case.name, case.meta.kind, reason });
            } else try w.print("{s} ({t}; supported)\n", .{ case.name, case.meta.kind });
        }
        return 0;
    }
    const runner: Runner = .{ .init = init, .out = w, .replay = replay };
    if (check) return checkPassing(runner, cases.items, e);
    var failures: usize = 0;
    for (cases.items) |case| {
        if (unsupported(case, replay)) |reason| {
            try w.print("SKIP {s} ({s})\n", .{ case.name, reason });
            if (paths.items.len > 0) failures += 1;
            continue;
        }
        if (try runner.execute(case)) |n| {
            try w.print("PASS {s} ({d} lines)\n", .{ case.name, n });
        } else failures += 1;
    }
    if (failures > 0) {
        try w.flush();
        try e.print("{d} corpus case(s) failed\n", .{failures});
        return 1;
    }
    return 0;
}
/// The CI gate, over the whole corpus. Every listed case must pass, and a
/// listed case that no longer exists fails. Unlike the Go gate, a case the
/// Zig Core can't run yet, or doesn't pass yet, is reported and skipped
/// unless it is listed.
fn checkPassing(runner: Runner, cases: []const Case, e: *std.Io.Writer) !u8 {
    const gpa = runner.init.gpa;
    const w = runner.out;
    const passing = try read(runner.init, "corpus-passing.txt");
    defer gpa.free(passing);
    var required: std.StringArrayHashMapUnmanaged(void) = .empty;
    defer required.deinit(gpa);
    var lines = std.mem.splitScalar(u8, passing, '\n');
    while (lines.next()) |line| {
        if (line.len == 0 or line[0] == '#') continue;
        if (!std.mem.eql(u8, std.mem.trim(u8, line, " \t\r"), line) or required.contains(line)) {
            try e.print("invalid or duplicate passing-list entry \"{s}\"\n", .{line});
            return 1;
        }
        try required.put(gpa, line, {});
    }
    var failed = false;
    for (cases) |case| {
        const must = required.swapRemove(case.name);
        if (unsupported(case, runner.replay)) |reason| {
            if (must) {
                try w.print("FAIL {s} ({s})\n", .{ case.name, reason });
                failed = true;
            } else try w.print("SKIP {s} ({s})\n", .{ case.name, reason });
            continue;
        }
        if (must) {
            if (try runner.execute(case)) |n| {
                try w.print("PASS {s} ({d} lines)\n", .{ case.name, n });
            } else failed = true;
            continue;
        }
        // An unlisted case is reported, never failed: the Zig Core's
        // machine grows case by case.
        var quiet: std.Io.Writer.Allocating = .init(runner.init.gpa);
        defer quiet.deinit();
        var unlisted = runner;
        unlisted.out = &quiet.writer;
        if (try unlisted.execute(case)) |n| {
            try w.print("NEW PASS {s} ({d} lines; add to corpus-passing.txt)\n", .{ case.name, n });
        } else try w.print("SKIP {s} (not passing yet)\n", .{case.name});
    }
    for (required.keys()) |name| {
        try w.print("FAIL {s} (listed case does not exist)\n", .{name});
        failed = true;
    }
    if (failed) {
        try w.flush();
        try e.writeAll("Zig corpus gate failed\n");
        return 1;
    }
    return 0;
}
pub fn main(init: std.process.Init) !u8 {
    return run(init, .{ .supports = talk_replay.supports, .run = talk_replay.replay });
}

test "metadata for every case kind and selectors" {
    var problem: Problem = .{};
    for ([_]Kind{ .trace, .disassembly, .transcript, .encoding }) |k| {
        const s = try std.fmt.allocPrint(std.testing.allocator, "kind = \"{t}\"\n[versions]\nlanguage = \"{s}\"\ncostModel = \"0\"\n", .{ k, language_version });
        defer std.testing.allocator.free(s);
        try std.testing.expectEqual(k, (try metadata(s, &problem)).kind);
    }
    try std.testing.expect(selected(&.{"corpus/bytes"}, "bytes/value-encoding"));
    try std.testing.expect(!selected(&.{"byte"}, "bytes/value-encoding"));
}
test "case.toml tables and keys are held to the setup catalogue for their kind" {
    const versions = "[versions]\nlanguage = \"" ++ language_version ++ "\"\ncostModel = \"0\"\n";
    var problem: Problem = .{};
    const objects = try metadata("kind = \"encoding\"\n" ++ versions ++ "[[objects]]\nkind = \"item\"\nid = \"a\"\n", &problem);
    try std.testing.expect(objects.objects);
    try std.testing.expectEqualStrings("Host Object registration is not implemented", unsupported(.{ .name = "x", .setup = @constCast(""), .meta = objects }, null).?);
    try std.testing.expectError(error.UnexpectedKey, metadata("kind = \"encoding\"\n" ++ versions ++ "[[objects]]\nprops = {}\n", &problem));
    try std.testing.expectEqualStrings("props", problem.key);
    try std.testing.expectEqual(Kind.encoding, problem.kind);
    try std.testing.expectError(error.UnexpectedTable, metadata("kind = \"encoding\"\n" ++ versions ++ "[[scripts]]\nname = \"s\"\n", &problem));
    try std.testing.expectError(error.UnexpectedKey, metadata("kind = \"trace\"\n" ++ versions ++ "extra = 1\n", &problem));
    try std.testing.expectError(error.UnsupportedVersions, metadata("kind = \"trace\"\n[versions]\nlanguage = \"0.1\"\ncostModel = \"0\"\n", &problem));
    try std.testing.expectError(error.InvalidCaseKind, metadata("kind = \"film\"\n" ++ versions, &problem));
    _ = try metadata("kind = \"trace\"\n" ++ versions ++ "[[scripts]]\nname = \"s\"\n[scripts.limits]\nmaxDepth = 3\n", &problem);
}
fn testObject(_: ?*anyopaque, kind: []const u8, id: []const u8) model.Error!*model.Value {
    return model.object(std.testing.allocator, kind, id, 0);
}
fn testFunction(_: ?*anyopaque, source: []const u8) model.Error!*model.Value {
    const captures = try model.map(std.testing.allocator, &.{});
    defer captures.release();
    return model.function(std.testing.allocator, "corpus", source, 0, captures);
}
test "every corpus Trace line reads against the record catalogue" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    var dir = try std.Io.Dir.cwd().openDir(io, "../../corpus", .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(gpa);
    defer walker.deinit();
    var failures: usize = 0;
    var files: usize = 0;
    while (try walker.next(io)) |entry| if (entry.kind == .file and std.mem.eql(u8, entry.basename, "case.trace")) {
        files += 1;
        const data = try dir.readFileAlloc(io, entry.path, gpa, .unlimited);
        defer gpa.free(data);
        var lines = std.mem.splitScalar(u8, std.mem.trimEnd(u8, data, "\n"), '\n');
        var line_number: usize = 0;
        while (lines.next()) |line| {
            line_number += 1;
            const record = trace.parse(gpa, line, .{ .object = testObject, .function = testFunction }) catch |err| {
                std.debug.print("{s}:{d}: {t}: {s}\n", .{ entry.path, line_number, err, line });
                failures += 1;
                continue;
            };
            if (record) |r| r.deinit(gpa);
        }
    };
    try std.testing.expect(files > 0);
    try std.testing.expectEqual(@as(usize, 0), failures);
}

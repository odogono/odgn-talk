//! The Zig Core's differential fuzz worker (tooling/fuzz/README.md, Dual-Core
//! mode): one JSON request and response per line on stdin and stdout, and no
//! filesystem or network I/O. A `run` replays a Fuzz Case's Host Inputs
//! through the Corpus replay Host, resolving each symbolic reference against
//! this Core's own Trace as tooling/fuzz/src/runner.ts does.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");
const case_setup = northtalk.corpus_case;
const trace = northtalk.corpus_trace;
const talk_replay = @import("talk_replay.zig");

/// The features the TS worker lists, in its order.
const features = [_][]const u8{ "compute", "dispatch", "suspend", "join", "decision", "error", "scope", "effect", "loop", "send", "timer" };

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const in_buffer = try gpa.alloc(u8, 8 * 1024 * 1024 + 1);
    defer gpa.free(in_buffer);
    var stdin = std.Io.File.stdin().readerStreaming(init.io, in_buffer);
    var out_buffer: [64 * 1024]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &out_buffer);
    const w = &stdout.interface;
    while (try stdin.interface.takeDelimiter('\n')) |line| {
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        respond(arena.allocator(), gpa, line, w) catch |err| {
            try w.writeAll("{\"error\":");
            try std.json.Stringify.encodeJsonString(@errorName(err), .{}, w);
            try w.writeAll("}");
        };
        try w.writeByte('\n');
        try w.flush();
    }
    return 0;
}

fn respond(a: std.mem.Allocator, gpa: std.mem.Allocator, line: []const u8, w: *std.Io.Writer) !void {
    const request = try std.json.parseFromSliceLeaky(std.json.Value, a, line, .{});
    const kind = text(request, "type") orelse return error.UnknownRequest;
    if (std.mem.eql(u8, kind, "capabilities")) {
        var v: c.talk_versions = undefined;
        c.talk_core_versions(&v);
        try w.writeAll("{\"version\":1,\"features\":[");
        for (features, 0..) |f, i| {
            if (i > 0) try w.writeByte(',');
            try std.json.Stringify.encodeJsonString(f, .{}, w);
        }
        try w.writeAll("],\"languageVersion\":");
        try std.json.Stringify.encodeJsonString(v.language[0..v.language_len], .{}, w);
        try w.writeAll(",\"costModel\":");
        try std.json.Stringify.encodeJsonString(v.cost_model[0..v.cost_model_len], .{}, w);
        try w.writeByte('}');
    } else if (std.mem.eql(u8, kind, "run")) {
        const case = if (request == .object) request.object.get("case") orelse return error.MalformedCase else return error.MalformedCase;
        run(a, gpa, case, w) catch |err| {
            // A case the harness can't run is the generator's; anything else
            // is the worker's.
            const malformed = switch (err) {
                error.MalformedCase, error.MissingSource, error.UnknownScript, error.UnknownOperation, error.UnknownCall => true,
                else => false,
            };
            try w.writeAll("{\"findings\":[{\"classification\":");
            try std.json.Stringify.encodeJsonString(if (malformed) "generator" else "execution", .{}, w);
            try w.writeAll(",\"signature\":{\"oracle\":");
            try std.json.Stringify.encodeJsonString(if (malformed) "harness-validity" else "worker-exception", .{}, w);
            try w.writeAll(",\"record\":\"exception\",\"field\":");
            try std.json.Stringify.encodeJsonString(@errorName(err), .{}, w);
            try w.writeAll(",\"owner\":\"group\"},\"message\":");
            try std.json.Stringify.encodeJsonString(@errorName(err), .{}, w);
            try w.writeAll("}]}");
        };
    } else return error.UnknownRequest;
}

fn text(v: std.json.Value, key: []const u8) ?[]const u8 {
    if (v != .object) return null;
    const x = v.object.get(key) orelse return null;
    return if (x == .string) x.string else null;
}

fn number(v: std.json.Value, key: []const u8) i64 {
    if (v != .object) return 0;
    const x = v.object.get(key) orelse return 0;
    return switch (x) {
        .integer => |n| n,
        .float => |f| @intFromFloat(f),
        else => 0,
    };
}

const SetupError = error{ MalformedCase, OutOfMemory };

/// A JSON value as case.toml would hold it.
fn tomlValue(a: std.mem.Allocator, v: std.json.Value) SetupError!case_setup.Value {
    return switch (v) {
        .string => |s| .{ .string = s },
        .integer => |n| .{ .raw = try std.fmt.allocPrint(a, "{d}", .{n}) },
        .float => |f| .{ .raw = try std.fmt.allocPrint(a, "{d}", .{f}) },
        .number_string => |s| .{ .raw = s },
        .bool => |b| .{ .raw = if (b) "true" else "false" },
        .null => error.MalformedCase,
        .array => |xs| blk: {
            const out = try a.alloc(case_setup.Value, xs.items.len);
            for (xs.items, out) |x, *o| o.* = try tomlValue(a, x);
            break :blk .{ .array = out };
        },
        .object => |o| .{ .table = try entries(a, o) },
    };
}

fn entries(a: std.mem.Allocator, o: std.json.ObjectMap) SetupError![]case_setup.Value.Entry {
    var out: std.ArrayList(case_setup.Value.Entry) = .empty;
    var it = o.iterator();
    while (it.next()) |e| {
        if (e.value_ptr.* == .null) continue;
        try out.append(a, .{ .key = e.key_ptr.*, .value = try tomlValue(a, e.value_ptr.*) });
    }
    return out.items;
}

/// The Fuzz Case's setup as case.toml's tables, each inline `text` held
/// under a source name of its own.
fn tablesOf(a: std.mem.Allocator, setup: std.json.Value, texts: *std.StringHashMapUnmanaged([]const u8)) ![]const case_setup.Table {
    if (setup != .object) return error.MalformedCase;
    var out: std.ArrayList(case_setup.Table) = .empty;
    try out.append(a, .{ .header = "", .entries = &.{} });
    var it = setup.object.iterator();
    while (it.next()) |e| switch (e.value_ptr.*) {
        .array => |items| for (items.items) |item| {
            if (item != .object) return error.MalformedCase;
            var table: std.ArrayList(case_setup.Value.Entry) = .empty;
            for (try entries(a, item.object)) |x| if (!std.mem.eql(u8, x.key, "text") and !std.mem.eql(u8, x.key, "source")) try table.append(a, x);
            // Its inline text, under its `source` name, or one of its own.
            if (text(item, "text")) |inline_text| {
                const source = text(item, "source") orelse try std.fmt.allocPrint(a, "{s}/{s}", .{ e.key_ptr.*, text(item, "name") orelse return error.MalformedCase });
                try texts.put(a, source, inline_text);
                try table.append(a, .{ .key = "source", .value = .{ .string = source } });
            } else if (text(item, "source")) |source| try table.append(a, .{ .key = "source", .value = .{ .string = source } });
            try out.append(a, .{ .header = try std.fmt.allocPrint(a, "[[{s}]]", .{e.key_ptr.*}), .entries = table.items });
        },
        .object => |o| try out.append(a, .{ .header = try std.fmt.allocPrint(a, "[{s}]", .{e.key_ptr.*}), .entries = try entries(a, o) }),
        else => return error.MalformedCase,
    };
    return out.items;
}

/// The ids, runs and deliveries a case's actions refer to, read from the
/// Trace as runner.ts reads it.
const Refs = struct {
    a: std.mem.Allocator,
    setup: std.json.Value,
    pending: Set = .{},
    settlements: Set = .{},
    scheduled: Set = .{},
    runs: Set = .{},
    deliveries: Set = .{},
    saved: std.StringHashMapUnmanaged(struct { runs: []const []const u8, deliveries: []const []const u8 }) = .empty,
    records: std.StringArrayHashMapUnmanaged(u64) = .empty,

    /// An insertion-ordered set, as a JS Set iterates.
    const Set = struct {
        items: std.ArrayList([]const u8) = .empty,
        fn has(s: *const Set, x: []const u8) bool {
            for (s.items.items) |y| if (std.mem.eql(u8, x, y)) return true;
            return false;
        }
        fn add(s: *Set, a: std.mem.Allocator, x: []const u8) !void {
            if (!s.has(x)) try s.items.append(a, try a.dupe(u8, x));
        }
        fn delete(s: *Set, x: []const u8) void {
            for (s.items.items, 0..) |y, i| if (std.mem.eql(u8, x, y)) {
                _ = s.items.orderedRemove(i);
                return;
            };
        }
        fn clear(s: *Set) void {
            s.items.clearRetainingCapacity();
        }
    };

    fn field(r: trace.Record, key: []const u8) ?[]const u8 {
        for (r.fields) |f| if (std.mem.eql(u8, f.key, key)) return f.value;
        return null;
    }

    /// The ids of a shown `[a, b]` list.
    fn ids(a: std.mem.Allocator, shown: ?[]const u8) ![]const []const u8 {
        const s = shown orelse return &.{};
        if (s.len < 2) return &.{};
        var out: std.ArrayList([]const u8) = .empty;
        var it = std.mem.tokenizeSequence(u8, s[1 .. s.len - 1], ", ");
        while (it.next()) |x| try out.append(a, x);
        return out.items;
    }

    fn mode(refs: *const Refs, script: []const u8, grant: []const u8, operation: []const u8) ?[]const u8 {
        var capability = grant;
        if (refs.setup.object.get("scripts")) |scripts| if (scripts == .array) for (scripts.array.items) |s| {
            if (!std.mem.eql(u8, text(s, "name") orelse continue, script)) continue;
            const grants = s.object.get("grants") orelse break;
            const g = if (grants == .object) grants.object.get(grant) orelse break else break;
            capability = text(g, "capability") orelse grant;
            break;
        };
        const ops = refs.setup.object.get("operations") orelse return null;
        if (ops != .array) return null;
        for (ops.array.items) |o| {
            if (std.mem.eql(u8, text(o, "capability") orelse "", capability) and std.mem.eql(u8, text(o, "name") orelse "", operation)) return text(o, "mode");
        }
        return null;
    }

    fn update(refs: *Refs, lines: []const u8) !void {
        const a = refs.a;
        var it = std.mem.splitScalar(u8, lines, '\n');
        while (it.next()) |line| {
            if (line.len == 0) continue;
            const r = (trace.parseWritten(a, line) catch return error.MalformedTrace) orelse continue;
            const name = try std.fmt.allocPrint(a, "{s}{s}", .{ if (r.input) ">" else "", r.name });
            const counted = try refs.records.getOrPut(a, name);
            if (!counted.found_existing) counted.value_ptr.* = 0;
            counted.value_ptr.* += 1;
            const is = struct {
                fn one(n: []const u8, names: []const []const u8) bool {
                    for (names) |x| if (std.mem.eql(u8, n, x)) return true;
                    return false;
                }
            }.one;
            const first = if (r.ids.len > 0) r.ids[0] else "";
            if (!r.input and is(r.name, &.{ "seg", "preempt" }) and r.ids.len > 1 and std.mem.eql(u8, r.ids[1], "start")) try refs.runs.add(a, first);
            if (!r.input and std.mem.eql(u8, r.name, "call")) {
                const op = field(r, "op") orelse "";
                const dot = std.mem.indexOfScalar(u8, op, '.') orelse op.len;
                const script = first[0 .. std.mem.indexOf(u8, first, "/r") orelse first.len];
                const m = refs.mode(script, op[0..dot], if (dot < op.len) op[dot + 1 ..] else "");
                if (m != null and std.mem.eql(u8, m.?, "suspending") and field(r, "result") == null and field(r, "error") == null and !refs.scheduled.has(first)) try refs.pending.add(a, first);
            }
            if (r.input and is(r.name, &.{ "answer", "fail", "settle" })) {
                refs.pending.delete(first);
                refs.settlements.delete(first);
                if (std.mem.eql(u8, r.name, "settle") and is(field(r, "how") orelse "", &.{ "adopt", "reissue" })) try refs.pending.add(a, first);
            }
            if (!r.input and is(r.name, &.{ "abandon", "timeout" })) refs.pending.delete(first);
            if (!r.input and std.mem.eql(u8, r.name, "run")) {
                refs.runs.delete(first);
                const prefix = try std.fmt.allocPrint(a, "{s}.c", .{first});
                var i: usize = 0;
                while (i < refs.pending.items.items.len) {
                    if (std.mem.startsWith(u8, refs.pending.items.items[i], prefix)) {
                        _ = refs.pending.items.orderedRemove(i);
                    } else i += 1;
                }
            }
            if (r.input and is(r.name, &.{ "deliver", "request", "decide", "broadcast", "decide-broadcast" }) and r.ids.len > 0) try refs.deliveries.add(a, first);
            if (!r.input and is(r.name, &.{ "seg", "preempt", "run" })) if (field(r, "delivery")) |d| refs.deliveries.delete(d);
            if (r.input and std.mem.eql(u8, r.name, "restore")) {
                refs.runs.clear();
                refs.pending.clear();
                refs.settlements.clear();
                refs.deliveries.clear();
                refs.scheduled.clear();
                if (!std.mem.eql(u8, field(r, "mode") orelse "", "variables-only")) if (refs.saved.get(field(r, "from") orelse "")) |saved| {
                    for (saved.runs) |x| try refs.runs.add(a, x);
                    for (saved.deliveries) |x| try refs.deliveries.add(a, x);
                };
                for (try ids(a, field(r, "pending"))) |x| try refs.settlements.add(a, x);
            }
            if (!r.input and std.mem.eql(u8, r.name, "stopped")) {
                for (try ids(a, field(r, "discarded"))) |x| refs.runs.delete(x);
                for (try ids(a, field(r, "abandoned"))) |x| refs.pending.delete(x);
                for (try ids(a, field(r, "dropped"))) |x| refs.deliveries.delete(x);
            }
        }
    }
};

fn choose(items: []const []const u8, nth: i64) ?[]const u8 {
    if (items.len == 0) return null;
    const n: i64 = @intCast(items.len);
    return items[@intCast(@mod(nth, n))];
}

/// The input line an action stands for here, or null for a no-op.
fn resolve(a: std.mem.Allocator, refs: *Refs, saves: []const []const u8, action: std.json.Value) !?[]const u8 {
    const kind = text(action, "kind") orelse return error.MalformedCase;
    const nth = number(action, "nth");
    if (std.mem.eql(u8, kind, "input")) return text(action, "line") orelse error.MalformedCase;
    if (std.mem.eql(u8, kind, "answer") or std.mem.eql(u8, kind, "fail")) {
        const id = try a.dupe(u8, choose(refs.pending.items.items, nth) orelse return null);
        refs.pending.delete(id);
        try refs.scheduled.add(a, id);
        const value = text(action, "value") orelse return error.MalformedCase;
        return if (std.mem.eql(u8, kind, "answer")) try std.fmt.allocPrint(a, "> answer {s} value={s}", .{ id, value }) else try std.fmt.allocPrint(a, "> fail {s} error={s}", .{ id, value });
    }
    if (std.mem.eql(u8, kind, "cancel-run")) {
        const prefix = try std.fmt.allocPrint(a, "{s}/r", .{text(action, "script") orelse return error.MalformedCase});
        var mine: std.ArrayList([]const u8) = .empty;
        for (refs.runs.items.items) |x| if (std.mem.startsWith(u8, x, prefix)) try mine.append(a, x);
        return try std.fmt.allocPrint(a, "> cancel-run {s}", .{choose(mine.items, nth) orelse return null});
    }
    if (std.mem.eql(u8, kind, "cancel-delivery")) return try std.fmt.allocPrint(a, "> cancel-delivery {s}", .{choose(refs.deliveries.items.items, nth) orelse return null});
    if (std.mem.eql(u8, kind, "restore")) {
        // The latest save first.
        const reversed = try a.alloc([]const u8, saves.len);
        for (saves, 0..) |x, i| reversed[saves.len - 1 - i] = x;
        const id = choose(reversed, nth) orelse return null;
        const variables_only = if (action.object.get("variablesOnly")) |x| x == .bool and x.bool else false;
        return try std.fmt.allocPrint(a, "> restore from={s}{s}", .{ id, if (variables_only) " mismatch=variables-only" else "" });
    }
    if (std.mem.eql(u8, kind, "settle")) {
        const id = try a.dupe(u8, choose(refs.settlements.items.items, nth) orelse return null);
        refs.settlements.delete(id);
        const how = text(action, "how") orelse return error.MalformedCase;
        if (std.mem.eql(u8, how, "adopt") or std.mem.eql(u8, how, "reissue")) try refs.pending.add(a, id);
        const value = text(action, "value");
        const rest = if (std.mem.eql(u8, how, "answer"))
            try std.fmt.allocPrint(a, " value={s}", .{value orelse "0"})
        else if (std.mem.eql(u8, how, "fail"))
            try std.fmt.allocPrint(a, " error={s}", .{value orelse "{code: \"fuzz failure\"}"})
        else
            "";
        return try std.fmt.allocPrint(a, "> settle {s} how={s}{s}", .{ id, how, rest });
    }
    return error.MalformedCase;
}

fn hex(out: *[64]u8, bytes: [32]u8) []const u8 {
    const digits = "0123456789abcdef";
    for (bytes, 0..) |b, i| {
        out[2 * i] = digits[b >> 4];
        out[2 * i + 1] = digits[b & 15];
    }
    return out;
}

fn fingerprint(h: *talk_replay.Host, out: *[64]u8) ![]const u8 {
    var bytes: [32]u8 = undefined;
    if (c.talk_fingerprint(h.group, &bytes) != c.TALK_OK) return error.HostError;
    return hex(out, bytes);
}

fn run(a: std.mem.Allocator, gpa: std.mem.Allocator, case: std.json.Value, w: *std.Io.Writer) !void {
    const setup = if (case == .object) case.object.get("setup") orelse return error.MalformedCase else return error.MalformedCase;
    const inputs = if (case.object.get("inputs")) |x| (if (x == .array) x.array.items else return error.MalformedCase) else return error.MalformedCase;
    var texts: std.StringHashMapUnmanaged([]const u8) = .empty;
    const tables = try tablesOf(a, setup, &texts);
    const h = try talk_replay.Host.create(gpa, .{ .texts = &texts }, tables);
    defer h.destroy();
    var refs: Refs = .{ .a = a, .setup = setup };
    var actions: std.StringArrayHashMapUnmanaged(u64) = .empty;
    var fingerprints: std.Io.Writer.Allocating = .init(a);
    var applied: u64 = 0;
    var noops: u64 = 0;
    var offset: usize = 0;
    for (inputs) |action| {
        const line = try resolve(a, &refs, h.save_ids.items, action) orelse {
            noops += 1;
            continue;
        };
        var before_hex: [64]u8 = undefined;
        var after_hex: [64]u8 = undefined;
        const before = try fingerprint(h, &before_hex);
        try h.apply(line, &.{}, null);
        applied += 1;
        const rest = line[2..];
        const name = rest[0 .. std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len];
        const counted = try actions.getOrPut(a, name);
        if (!counted.found_existing) counted.value_ptr.* = 0;
        counted.value_ptr.* += 1;
        const after = try fingerprint(h, &after_hex);
        const fw = &fingerprints.writer;
        if (applied > 1) try fw.writeByte(',');
        try fw.writeAll("{\"action\":");
        try std.json.Stringify.encodeJsonString(name, .{}, fw);
        try fw.print(",\"before\":\"{s}\",\"after\":\"{s}\"}}", .{ before, after });
        const written = try h.trace();
        try refs.update(written[offset..]);
        offset = written.len;
        // As runner.ts does, every save action records the refs under the
        // latest save held, even when this one was refused.
        if (std.mem.eql(u8, name, "save") and h.save_ids.items.len > 0) {
            const ids = h.save_ids.items;
            try refs.saved.put(a, ids[ids.len - 1], .{ .runs = try a.dupe([]const u8, refs.runs.items.items), .deliveries = try a.dupe([]const u8, refs.deliveries.items.items) });
        }
    }
    try w.writeAll("{\"findings\":[],\"execution\":{\"trace\":[");
    var lines = std.mem.splitScalar(u8, try h.trace(), '\n');
    var first = true;
    while (lines.next()) |l| {
        if (l.len == 0 and lines.peek() == null) break;
        if (!first) try w.writeByte(',');
        first = false;
        try std.json.Stringify.encodeJsonString(l, .{}, w);
    }
    try w.print("],\"counts\":{{\"applied\":{d},\"noops\":{d},\"actions\":{{", .{ applied, noops });
    for (actions.keys(), actions.values(), 0..) |k, v, i| {
        if (i > 0) try w.writeByte(',');
        try std.json.Stringify.encodeJsonString(k, .{}, w);
        try w.print(":{d}", .{v});
    }
    try w.writeAll("},\"records\":{");
    for (refs.records.keys(), refs.records.values(), 0..) |k, v, i| {
        if (i > 0) try w.writeByte(',');
        try std.json.Stringify.encodeJsonString(k, .{}, w);
        try w.print(":{d}", .{v});
    }
    try w.writeAll("}},\"fingerprints\":[");
    try w.writeAll(fingerprints.written());
    try w.writeAll("]}}");
}

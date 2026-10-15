//! Script Shape checks (chapter 7): Shapes as data, decoded and checked
//! iteratively so depth is bounded by the budgets, not the call stack. The
//! scanned count is what the Built-in rates measure, failed work included.
//! Acceptance and diagnostics follow chapter 7 as the TS and Go Cores read
//! it: a Function Value is `not encodable` only where a data scan (`any`,
//! or an open map's extra field) meets it, and `wrong kind` elsewhere.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model = @import("../value.zig");
const units = @import("../units.zig");
const capabilities = @import("capabilities.zig");
const Shape = capabilities.Shape;
const Value = model.Value;

pub const DefinitionError = struct {
    reason: []const u8,
    path: []*Value,
    value: *Value,
};

pub const Diagnostic = struct {
    expected: []const u8,
    got: []const u8,
    value: *Value,
    path: []*Value,
    unencodable: bool = false,
    alternatives: ?[][]Diagnostic = null,
};

pub const Outcome = struct {
    scanned: u64 = 0,
    definition_error: ?DefinitionError = null,
    diagnostics: []Diagnostic = &.{},
    /// Values created for paths and missing fields; release after use.
    kept: []*Value = &.{},
    /// The decoded Shape; release after use.
    shape: ?*Shape = null,

    pub fn release(o: Outcome) void {
        for (o.kept) |v| v.release();
        if (o.shape) |s| s.release();
    }
};

const wrapper_keys = [_][]const u8{ "quantity", "unitKind", "object", "list", "oneOf", "optional", "map" };

fn scalars(s: []const u8) u64 {
    const view = std.unicode.Utf8View.init(s) catch return s.len;
    var it = view.iterator();
    var n: u64 = 0;
    while (it.nextCodepoint() != null) n += 1;
    return n;
}

fn kindName(v: *const Value) []const u8 {
    return switch (v.data) {
        .bool => "boolean",
        .civil_date => "civil date",
        inline else => |_, k| @tagName(k),
    };
}

const Ctx = struct {
    a: Allocator,
    gpa: Allocator,
    scanned: u64 = 0,
    kept: std.ArrayList(*Value) = .empty,
    definition_error: ?DefinitionError = null,

    fn invalid(c: *Ctx, reason: []const u8, path: []*Value, value: *Value) error{InvalidShape} {
        c.definition_error = .{ .reason = reason, .path = path, .value = value };
        return error.InvalidShape;
    }

    fn keep(c: *Ctx, v: *Value) !*Value {
        try c.kept.append(c.a, v);
        return v;
    }

    fn keyValue(c: *Ctx, key: []const u8) !*Value {
        return c.keep(try model.text(c.gpa, key));
    }

    fn indexValue(c: *Ctx, i: usize) !*Value {
        return c.keep(try model.scalar(c.gpa, .{ .number = model.Decimal.fromInt(@as(i64, @intCast(i))) }));
    }

    fn child(c: *Ctx, path: []*Value, step: *Value) ![]*Value {
        const out = try c.a.alloc(*Value, path.len + 1);
        @memcpy(out[0..path.len], path);
        out[path.len] = step;
        return out;
    }

    fn childKey(c: *Ctx, path: []*Value, key: []const u8) ![]*Value {
        return c.child(path, try c.keyValue(key));
    }

    fn childIndex(c: *Ctx, path: []*Value, i: usize) ![]*Value {
        return c.child(path, try c.indexValue(i));
    }
};

// --------------------------------------------------------------- decoding

const FieldAcc = std.ArrayList(capabilities.Field);

const DecodeFrame = union(enum) {
    enter: struct { data: *Value, path: []*Value },
    wrap: enum { list, optional },
    one_of: usize,
    map_done: struct { acc: *FieldAcc, open: bool },
    field: struct { data: *Value, path: []*Value, acc: *FieldAcc, seen: *std.StringHashMapUnmanaged(void) },
    field_done: struct { acc: *FieldAcc, key: []const u8, optional: bool },
};

fn lookup(entries: model.Map, key: []const u8) ?*Value {
    for (0..entries.len) |i| {
        const p = entries.at(i);
        if (std.mem.eql(u8, p.key, key)) return p.value;
    }
    return null;
}

fn scalarKind(name: []const u8) ?capabilities.Kind {
    const names = .{
        .{ "any", capabilities.Kind.any },
        .{ "value", capabilities.Kind.value },
        .{ "nothing", capabilities.Kind.nothing },
        .{ "boolean", capabilities.Kind.boolean },
        .{ "number", capabilities.Kind.number },
        .{ "quantity", capabilities.Kind.quantity },
        .{ "text", capabilities.Kind.text },
        .{ "bytes", capabilities.Kind.bytes },
        .{ "list", capabilities.Kind.list },
        .{ "map", capabilities.Kind.map },
        .{ "range", capabilities.Kind.range },
        .{ "instant", capabilities.Kind.instant },
        .{ "civil date", capabilities.Kind.civil_date },
        .{ "pattern", capabilities.Kind.pattern },
        .{ "function", capabilities.Kind.function },
        .{ "object", capabilities.Kind.object },
    };
    inline for (names) |pair| if (std.mem.eql(u8, name, pair[0])) return pair[1];
    return null;
}

fn decode(c: *Ctx, data: *Value) !*Shape {
    var results: std.ArrayList(*Shape) = .empty;
    var stack: std.ArrayList(DecodeFrame) = .empty;
    var accs: std.ArrayList(*FieldAcc) = .empty;
    try stack.append(c.a, .{ .enter = .{ .data = data, .path = &.{} } });
    errdefer {
        for (results.items) |s| s.release();
        for (accs.items) |acc| for (acc.items) |f| {
            c.gpa.free(f.key);
            f.shape.release();
        };
        for (stack.items) |frame| if (frame == .field_done) c.gpa.free(frame.field_done.key);
    }
    while (stack.items.len > 0) {
        const frame = stack.orderedRemove(stack.items.len - 1);
        switch (frame) {
            .wrap => |k| {
                const inner = results.orderedRemove(results.items.len - 1);
                errdefer inner.release();
                try results.append(c.a, switch (k) {
                    .list => try Shape.listOf(c.gpa, inner),
                    .optional => try Shape.optional(c.gpa, inner),
                });
            },
            .one_of => |n| {
                const shapes = try c.gpa.dupe(*Shape, results.items[results.items.len - n ..]);
                errdefer c.gpa.free(shapes);
                results.shrinkRetainingCapacity(results.items.len - n);
                try results.append(c.a, try Shape.oneOf(c.gpa, shapes));
            },
            .map_done => |m| {
                try results.append(c.a, try Shape.map(c.gpa, try c.gpa.dupe(capabilities.Field, m.acc.items), m.open));
                // The Shape took the fields; the accumulator must not free them.
                for (accs.items, 0..) |acc, i| if (acc == m.acc) {
                    _ = accs.orderedRemove(i);
                    break;
                };
                m.acc.clearRetainingCapacity();
            },
            .field_done => |f| {
                const inner = results.orderedRemove(results.items.len - 1);
                errdefer inner.release();
                try f.acc.append(c.a, .{ .key = f.key, .shape = inner, .optional = f.optional });
            },
            .field => |f| {
                const decl = f.data;
                if (decl.data != .map) return c.invalid("invalid field", f.path, decl);
                const entries = decl.data.map;
                c.scanned += entries.len;
                const key = lookup(entries, "key") orelse return c.invalid("invalid field key", f.path, decl);
                if (key.data != .text) return c.invalid("invalid field key", try c.childKey(f.path, "key"), key);
                const inner = lookup(entries, "shape") orelse return c.invalid("missing field shape", f.path, decl);
                var optional = false;
                if (lookup(entries, "optional")) |flag| {
                    if (flag.data != .bool) return c.invalid("invalid flag", try c.childKey(f.path, "optional"), flag);
                    optional = flag.data.bool;
                }
                if (f.seen.contains(key.data.text)) return c.invalid("duplicate field", try c.childKey(f.path, "key"), key);
                try f.seen.put(c.a, key.data.text, {});
                try stack.append(c.a, .{ .field_done = .{ .acc = f.acc, .key = try c.gpa.dupe(u8, key.data.text), .optional = optional } });
                try stack.append(c.a, .{ .enter = .{ .data = inner, .path = try c.childKey(f.path, "shape") } });
            },
            .enter => |e| {
                const node = e.data;
                c.scanned += 1;
                if (node.data == .text) {
                    const name = node.data.text;
                    c.scanned += scalars(name);
                    const kind = scalarKind(name) orelse return c.invalid("unknown kind", e.path, node);
                    try results.append(c.a, try Shape.kind(c.gpa, kind));
                    continue;
                }
                if (node.data != .map) return c.invalid("not a shape", e.path, node);
                const entries = node.data.map;
                c.scanned += entries.len;
                var present: ?[]const u8 = null;
                for (wrapper_keys) |k| {
                    if (lookup(entries, k) == null) continue;
                    if (present != null) return c.invalid("ambiguous shape", e.path, node);
                    present = k;
                }
                const key = present orelse return c.invalid("not a shape", e.path, node);
                const payload = lookup(entries, key).?;
                if (std.mem.eql(u8, key, "quantity")) {
                    if (payload.data != .text) return c.invalid("invalid unit", try c.childKey(e.path, key), payload);
                    c.scanned += scalars(payload.data.text);
                    const unit = units.Unit.parse(payload.data.text) catch return c.invalid("invalid unit", try c.childKey(e.path, key), payload);
                    const canonical = try unit.string(c.a, false);
                    try results.append(c.a, Shape.quantityOf(c.gpa, canonical) catch return c.invalid("invalid unit", try c.childKey(e.path, key), payload));
                } else if (std.mem.eql(u8, key, "unitKind")) {
                    if (payload.data == .text) c.scanned += scalars(payload.data.text);
                    if (payload.data != .text) return c.invalid("unknown unit kind", try c.childKey(e.path, key), payload);
                    try results.append(c.a, Shape.quantityKind(c.gpa, payload.data.text) catch return c.invalid("unknown unit kind", try c.childKey(e.path, key), payload));
                } else if (std.mem.eql(u8, key, "object")) {
                    if (payload.data != .text) return c.invalid("invalid object kind", try c.childKey(e.path, key), payload);
                    try results.append(c.a, try Shape.objectOf(c.gpa, payload.data.text));
                } else if (std.mem.eql(u8, key, "list") or std.mem.eql(u8, key, "optional")) {
                    try stack.append(c.a, .{ .wrap = if (key[0] == 'l') .list else .optional });
                    try stack.append(c.a, .{ .enter = .{ .data = payload, .path = try c.childKey(e.path, key) } });
                } else if (std.mem.eql(u8, key, "oneOf")) {
                    if (payload.data != .list) return c.invalid("invalid alternatives", try c.childKey(e.path, key), payload);
                    const items = payload.data.list;
                    if (items.len == 0) return c.invalid("empty union", try c.childKey(e.path, key), payload);
                    try stack.append(c.a, .{ .one_of = items.len });
                    var i = items.len;
                    while (i >= 1) : (i -= 1) {
                        try stack.append(c.a, .{ .enter = .{ .data = items[i - 1], .path = try c.childIndex(try c.childKey(e.path, key), i) } });
                    }
                } else { // map
                    var open = false;
                    if (lookup(entries, "open")) |flag| {
                        if (flag.data != .bool) return c.invalid("invalid flag", try c.childKey(e.path, "open"), flag);
                        open = flag.data.bool;
                    }
                    if (payload.data != .list) return c.invalid("invalid fields", try c.childKey(e.path, key), payload);
                    const acc = try c.a.create(FieldAcc);
                    acc.* = .empty;
                    try accs.append(c.a, acc);
                    const seen = try c.a.create(std.StringHashMapUnmanaged(void));
                    seen.* = .empty;
                    try stack.append(c.a, .{ .map_done = .{ .acc = acc, .open = open } });
                    const items = payload.data.list;
                    var i = items.len;
                    while (i >= 1) : (i -= 1) {
                        try stack.append(c.a, .{ .field = .{ .data = items[i - 1], .path = try c.childIndex(try c.childKey(e.path, key), i), .acc = acc, .seen = seen } });
                    }
                }
            },
        }
    }
    return results.items[0];
}

// --------------------------------------------------------------- matching

const Sink = std.ArrayList(Diagnostic);

const CheckFrame = union(enum) {
    node: struct { v: *Value, s: *const Shape, path: []*Value, out: *Sink, trial: usize },
    deep: struct { v: *Value, path: []*Value, out: *Sink, trial: usize },
    extras: struct { v: *Value, s: *const Shape, path: []*Value, out: *Sink, trial: usize },
    missing: struct { expected: []const u8, path: []*Value, out: *Sink, trial: usize },
    adjust: struct { mark: usize, path: []*Value, out: *Sink, trial: usize },
    union_frame: struct {
        v: *Value,
        s: *const Shape,
        alts: []*Shape,
        index: usize = 0,
        current: ?*Sink = null,
        collected: std.ArrayList([]Diagnostic) = .empty,
        path: []*Value,
        out: *Sink,
        trial: usize,
    },

    fn trialOf(f: CheckFrame) usize {
        return switch (f) {
            inline else => |x| x.trial,
        };
    }
};

const Matcher = struct {
    c: *Ctx,
    first: bool,
    stack: std.ArrayList(CheckFrame) = .empty,
    discarded: std.AutoHashMapUnmanaged(usize, void) = .empty,
    // A deep scan charges a shared part's logical nodes without
    // re-walking it once it is known to hold no Function Value (#890).
    deep_scans: std.AutoHashMapUnmanaged(usize, model.DeepScan) = .empty,
    trials: usize = 0,
    halted: bool = false,

    fn emit(m: *Matcher, out: *Sink, trial: usize, d: Diagnostic) !void {
        try out.append(m.c.a, d);
        if (!m.first) return;
        if (trial == 0) {
            // Only enclosing Optional adjustments may still run.
            m.halted = true;
            var kept: std.ArrayList(CheckFrame) = .empty;
            for (m.stack.items) |f| if (f == .adjust) try kept.append(m.c.a, f);
            m.stack = kept;
            return;
        }
        try m.discarded.put(m.c.a, trial, {});
        var kept: std.ArrayList(CheckFrame) = .empty;
        for (m.stack.items) |f| if (f.trialOf() != trial) try kept.append(m.c.a, f);
        m.stack = kept;
    }

    fn got(m: *Matcher, s: *const Shape, v: *Value) ![]const u8 {
        if ((s.data == .quantity_of or s.data == .quantity_kind) and v.data == .quantity) {
            return try v.data.quantity.unit.string(m.c.a, false);
        }
        return kindName(v);
    }

    fn wrong(m: *Matcher, out: *Sink, trial: usize, s: *const Shape, v: *Value, path: []*Value) !void {
        try m.emit(out, trial, .{
            .expected = try s.expected(m.c.a),
            .got = try m.got(s, v),
            .value = v,
            .path = path,
        });
    }

    fn push(m: *Matcher, frame: CheckFrame) !void {
        try m.stack.append(m.c.a, frame);
    }
};

fn samePath(a: []*Value, b: []*Value) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        const eq = x.equal(y) catch return false;
        if (!eq) return false;
    }
    return true;
}

fn diagnostics(c: *Ctx, v: *Value, s: *const Shape, first: bool) ![]Diagnostic {
    const root = try c.a.create(Sink);
    root.* = .empty;
    var m: Matcher = .{ .c = c, .first = first };
    try m.push(.{ .node = .{ .v = v, .s = s, .path = &.{}, .out = root, .trial = 0 } });
    while (m.stack.items.len > 0) {
        const frame = m.stack.orderedRemove(m.stack.items.len - 1);
        if (m.discarded.contains(frame.trialOf())) continue;
        switch (frame) {
            .adjust => |f| {
                for (f.out.items[f.mark..]) |*d| {
                    if (!d.unencodable and samePath(d.path, f.path)) {
                        d.expected = try std.fmt.allocPrint(c.a, "{s} or nothing", .{d.expected});
                        break;
                    }
                }
            },
            .missing => |f| {
                c.scanned += 1;
                try m.emit(f.out, f.trial, .{
                    .expected = f.expected,
                    .got = "nothing",
                    .value = try c.keep(try model.scalar(c.gpa, .nothing)),
                    .path = f.path,
                });
            },
            .deep => |f| {
                const scan = try model.deepScanOf(c.a, f.v, &m.deep_scans);
                if (scan.clean) {
                    c.scanned +|= scan.nodes;
                    continue;
                }
                c.scanned += 1;
                switch (f.v.data) {
                    .function => try m.emit(f.out, f.trial, .{
                        .expected = "any",
                        .got = "function",
                        .value = f.v,
                        .path = f.path,
                        .unencodable = true,
                    }),
                    .list => |items| {
                        var i = items.len;
                        while (i >= 1) : (i -= 1) {
                            try m.push(.{ .deep = .{ .v = items[i - 1], .path = try c.childIndex(f.path, i), .out = f.out, .trial = f.trial } });
                        }
                    },
                    .map => |pairs| {
                        var i = pairs.len;
                        while (i >= 1) : (i -= 1) {
                            try m.push(.{ .deep = .{ .v = pairs.at(i - 1).value, .path = try c.childKey(f.path, pairs.at(i - 1).key), .out = f.out, .trial = f.trial } });
                        }
                    },
                    else => {},
                }
            },
            .extras => |f| {
                const fields = f.s.data.map.fields;
                var deeps: std.ArrayList(CheckFrame) = .empty;
                for (0..f.v.data.map.len) |map_index| {
                    const p = f.v.data.map.at(map_index);
                    var declared = false;
                    for (fields) |field| if (std.mem.eql(u8, field.key, p.key)) {
                        declared = true;
                    };
                    if (declared) continue;
                    if (!f.s.data.map.open) {
                        c.scanned += 1;
                        try m.emit(f.out, f.trial, .{
                            .expected = "nothing",
                            .got = kindName(p.value),
                            .value = p.value,
                            .path = try c.childKey(f.path, p.key),
                        });
                        if (m.halted or m.discarded.contains(f.trial)) break;
                    } else {
                        try deeps.append(c.a, .{ .deep = .{ .v = p.value, .path = try c.childKey(f.path, p.key), .out = f.out, .trial = f.trial } });
                    }
                }
                var i = deeps.items.len;
                while (i >= 1) : (i -= 1) {
                    try m.push(deeps.items[i - 1]);
                }
            },
            .union_frame => |f| {
                var u = f;
                if (u.current) |current| {
                    if (current.items.len == 0) continue;
                    try u.collected.append(c.a, current.items);
                    u.current = null;
                    u.index += 1;
                }
                if (u.index >= u.alts.len) {
                    try m.emit(u.out, u.trial, .{
                        .expected = try u.s.expected(c.a),
                        .got = try m.got(u.s, u.v),
                        .value = u.v,
                        .path = u.path,
                        .alternatives = u.collected.items,
                    });
                    continue;
                }
                const sink = try c.a.create(Sink);
                sink.* = .empty;
                u.current = sink;
                m.trials += 1;
                try m.push(.{ .union_frame = u });
                try m.push(.{ .node = .{ .v = u.v, .s = u.alts[u.index], .path = u.path, .out = sink, .trial = m.trials } });
            },
            .node => |f| {
                c.scanned += 1;
                switch (f.s.data) {
                    .kind => |k| switch (k) {
                        .value => {},
                        .any => try m.push(.{ .deep = .{ .v = f.v, .path = f.path, .out = f.out, .trial = f.trial } }),
                        else => {
                            const ok = switch (k) {
                                .nothing => f.v.data == .nothing,
                                .boolean => f.v.data == .bool,
                                .number => f.v.data == .number,
                                .text => f.v.data == .text,
                                .bytes => f.v.data == .bytes,
                                .instant => f.v.data == .instant,
                                .range => f.v.data == .range,
                                .civil_date => f.v.data == .civil_date,
                                .pattern => f.v.data == .pattern,
                                .function => f.v.data == .function,
                                .quantity => f.v.data == .quantity,
                                .list => f.v.data == .list,
                                .map => f.v.data == .map,
                                .object => f.v.data == .object,
                                .any, .value => unreachable,
                            };
                            if (!ok) try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                        },
                    },
                    .quantity_of => |q| {
                        if (f.v.data != .quantity or !std.meta.eql(f.v.data.quantity.unit, q.unit)) try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                    },
                    .quantity_kind => |name| {
                        if (f.v.data != .quantity or !capabilities.ofKind(f.v.data.quantity.unit, name)) try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                    },
                    .object => |name| {
                        if (f.v.data != .object or !std.mem.eql(u8, f.v.data.object.kind, name)) try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                    },
                    .list => |inner| {
                        if (f.v.data != .list) {
                            try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                        } else {
                            const items = f.v.data.list;
                            var i = items.len;
                            while (i >= 1) : (i -= 1) {
                                try m.push(.{ .node = .{ .v = items[i - 1], .s = inner, .path = try c.childIndex(f.path, i), .out = f.out, .trial = f.trial } });
                            }
                        }
                    },
                    .map => |shape_map| {
                        if (f.v.data != .map) {
                            try m.wrong(f.out, f.trial, f.s, f.v, f.path);
                        } else {
                            try m.push(.{ .extras = .{ .v = f.v, .s = f.s, .path = f.path, .out = f.out, .trial = f.trial } });
                            var i = shape_map.fields.len;
                            while (i >= 1) : (i -= 1) {
                                const field = shape_map.fields[i - 1];
                                if (f.v.get(field.key)) |item| {
                                    try m.push(.{ .node = .{ .v = item, .s = field.shape, .path = try c.childKey(f.path, field.key), .out = f.out, .trial = f.trial } });
                                } else if (!field.optional) {
                                    try m.push(.{ .missing = .{ .expected = try field.shape.expected(c.a), .path = try c.childKey(f.path, field.key), .out = f.out, .trial = f.trial } });
                                }
                            }
                        }
                    },
                    .one_of => |alts| {
                        try m.push(.{ .union_frame = .{ .v = f.v, .s = f.s, .alts = alts, .path = f.path, .out = f.out, .trial = f.trial } });
                    },
                    .optional => |inner| {
                        if (f.v.data != .nothing) {
                            try m.push(.{ .adjust = .{ .mark = f.out.items.len, .path = f.path, .out = f.out, .trial = f.trial } });
                            try m.push(.{ .node = .{ .v = f.v, .s = inner, .path = f.path, .out = f.out, .trial = f.trial } });
                        }
                    },
                }
            },
        }
    }
    return root.items;
}

/// Decodes `data` as a Shape and checks `v` against it, first mismatch
/// only when `first`. The caller releases the outcome after use.
pub fn run(a: Allocator, gpa: Allocator, v: *Value, data: *Value, first: bool) !Outcome {
    var c: Ctx = .{ .a = a, .gpa = gpa };
    const shape = decode(&c, data) catch |e| switch (e) {
        error.InvalidShape => return .{
            .scanned = c.scanned,
            .definition_error = c.definition_error.?,
            .kept = c.kept.items,
        },
        else => return e,
    };
    errdefer shape.release();
    const diags = try diagnostics(&c, v, shape, first);
    return .{
        .scanned = c.scanned,
        .diagnostics = diags,
        .kept = c.kept.items,
        .shape = shape,
    };
}

/// A Value Path as a Script list value.
pub fn pathList(gpa: Allocator, path: []*Value) !*Value {
    return try model.list(gpa, path);
}

/// One `explain` record: the error's fields as a plain map, without
/// `message` or `at`.
pub fn record(gpa: Allocator, d: Diagnostic) !*Value {
    var fields: std.ArrayList(model.Pair) = .empty;
    defer fields.deinit(gpa);
    // Created values: the map retains them, so each creation ref is ours
    // to release once the map is built.
    var owned: std.ArrayList(*Value) = .empty;
    defer {
        for (owned.items) |v| v.release();
        owned.deinit(gpa);
    }
    const textPair = struct {
        fn add(gpa_: Allocator, fields_: *std.ArrayList(model.Pair), owned_: *std.ArrayList(*Value), key: []const u8, s: []const u8) !void {
            const v = try model.text(gpa_, s);
            try owned_.append(gpa_, v);
            try fields_.append(gpa_, .{ .key = key, .value = v });
        }
    }.add;
    const valuePair = struct {
        fn add(gpa_: Allocator, fields_: *std.ArrayList(model.Pair), owned_: *std.ArrayList(*Value), key: []const u8, v: *Value, owned_value: bool) !void {
            if (owned_value) try owned_.append(gpa_, v);
            try fields_.append(gpa_, .{ .key = key, .value = v });
        }
    }.add;
    if (d.unencodable) {
        try textPair(gpa, &fields, &owned, "code", "not encodable");
        try textPair(gpa, &fields, &owned, "kind", d.got);
        try valuePair(gpa, &fields, &owned, "path", try pathList(gpa, d.path), true);
        return try model.map(gpa, fields.items);
    }
    try textPair(gpa, &fields, &owned, "code", "wrong kind");
    try textPair(gpa, &fields, &owned, "expected", d.expected);
    try textPair(gpa, &fields, &owned, "got", d.got);
    try valuePair(gpa, &fields, &owned, "value", d.value, false);
    if (d.path.len > 0) try valuePair(gpa, &fields, &owned, "path", try pathList(gpa, d.path), true);
    if (d.alternatives) |alts| {
        var lists: std.ArrayList(*Value) = .empty;
        defer lists.deinit(gpa);
        for (alts) |alt| {
            var records: std.ArrayList(*Value) = .empty;
            defer records.deinit(gpa);
            for (alt) |sub| try records.append(gpa, try record(gpa, sub));
            const list_value = try model.list(gpa, records.items);
            for (records.items) |r| r.release();
            try lists.append(gpa, list_value);
        }
        try valuePair(gpa, &fields, &owned, "alternatives", try model.list(gpa, lists.items), true);
        for (lists.items) |l| l.release();
    }
    return try model.map(gpa, fields.items);
}

const testing = std.testing;
const display = @import("../display.zig");

fn runCase(a: Allocator, gpa: Allocator, value_text: []const u8, shape_text: []const u8, first: bool) !Outcome {
    // Parsed with the arena: diagnostics borrow the checked value, as a
    // Built-in's arguments are alive for the call.
    const v = try display.parse(a, value_text, .{});
    const data = try display.parse(a, shape_text, .{});
    return run(a, gpa, v, data, first);
}

test "Script Shape checks decode, match and group union alternatives" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const gpa = testing.allocator;

    const ok = try runCase(a, gpa, "[1, 2]", "{list: \"number\"}", true);
    defer ok.release();
    try testing.expect(ok.definition_error == null);
    try testing.expectEqual(@as(usize, 0), ok.diagnostics.len);

    const all = try runCase(a, gpa, "[1, \"x\", true]", "{list: \"number\"}", false);
    defer all.release();
    try testing.expectEqual(@as(usize, 2), all.diagnostics.len);
    try testing.expectEqualStrings("number", all.diagnostics[0].expected);
    try testing.expectEqual(@as(usize, 1), all.diagnostics[0].path.len);

    const first = try runCase(a, gpa, "[1, \"x\", true]", "{list: \"number\"}", true);
    defer first.release();
    try testing.expectEqual(@as(usize, 1), first.diagnostics.len);

    const grouped = try runCase(a, gpa, "true", "{oneOf: [\"text\", {list: \"number\"}]}", false);
    defer grouped.release();
    try testing.expectEqual(@as(usize, 1), grouped.diagnostics.len);
    try testing.expectEqualStrings("text or list", grouped.diagnostics[0].expected);
    try testing.expectEqual(@as(usize, 2), grouped.diagnostics[0].alternatives.?.len);
    const rec = try record(gpa, grouped.diagnostics[0]);
    defer rec.release();
    try testing.expect(rec.get("alternatives") != null);
    try testing.expect(rec.get("message") == null);
    try testing.expectEqualStrings("{code: \"wrong kind\", expected: \"text or list\", got: \"boolean\", value: true, alternatives: [[{code: \"wrong kind\", expected: \"text\", got: \"boolean\", value: true}], [{code: \"wrong kind\", expected: \"list\", got: \"boolean\", value: true}]]}", try display.string(a, rec));

    const optional = try runCase(a, gpa, "3", "{optional: \"text\"}", true);
    defer optional.release();
    try testing.expectEqualStrings("text or nothing", optional.diagnostics[0].expected);
}

test "Script Shape definitions fail before matching, with reasons and paths" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const gpa = testing.allocator;
    const cases = .{
        .{ "42", "not a shape" },
        .{ "\"bogus\"", "unknown kind" },
        .{ "{list: \"number\", optional: \"text\"}", "ambiguous shape" },
        .{ "{oneOf: []}", "empty union" },
        .{ "{quantity: \"furlongs\"}", "invalid unit" },
        .{ "{unitKind: \"weightiness\"}", "unknown unit kind" },
        .{ "{oneOf: [\"number\", \"bogus\"]}", "unknown kind" },
        .{ "{map: [{key: \"a\", shape: \"number\"}, {key: \"a\", shape: \"text\"}]}", "duplicate field" },
    };
    inline for (cases) |case| {
        const outcome = try runCase(a, gpa, "3", case[0], true);
        defer outcome.release();
        try testing.expect(outcome.definition_error != null);
        try testing.expectEqualStrings(case[1], outcome.definition_error.?.reason);
        try testing.expect(outcome.scanned > 0);
    }
    const nested = try runCase(a, gpa, "3", "{oneOf: [\"number\", \"bogus\"]}", true);
    defer nested.release();
    try testing.expectEqual(@as(usize, 2), nested.definition_error.?.path.len);
}

//! The Group Fingerprint (chapter 9, The Pump and the Group Fingerprint):
//! the SHA-256 of a canonical JSON description of a Group's Libraries,
//! Scripts, Grants and limits. A Grant's Operation Declarations are written
//! in the Host Manifest's data model, and a save keeps that text, so a Grant
//! a restore couldn't re-bind still counts with its saved declarations.
const std = @import("std");
const Allocator = std.mem.Allocator;
const capabilities = @import("capabilities.zig");
const version = @import("../generated/version.zig").version;
const cost_model = @import("../generated/costs.zig").costs;
const limits_table = @import("../generated/limits.zig").limits;

/// A JSON string, escaping only `"`, `\` and U+0000 to U+001F.
pub fn writeString(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| switch (c) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        0...0x1f => try w.print("\\u{x:0>4}", .{c}),
        else => try w.writeByte(c),
    };
    try w.writeByte('"');
}

pub fn writeShape(w: *std.Io.Writer, s: *const capabilities.Shape) std.Io.Writer.Error!void {
    switch (s.data) {
        .kind => |k| try writeString(w, k.name()),
        .quantity_of => |q| {
            try w.writeAll("{\"quantity\":");
            try writeString(w, q.text);
            try w.writeByte('}');
        },
        .quantity_kind => |k| {
            try w.writeAll("{\"unitKind\":");
            try writeString(w, k);
            try w.writeByte('}');
        },
        .object => |k| {
            try w.writeAll("{\"object\":");
            try writeString(w, k);
            try w.writeByte('}');
        },
        .list => |x| {
            try w.writeAll("{\"list\":");
            try writeShape(w, x);
            try w.writeByte('}');
        },
        .optional => |x| {
            try w.writeAll("{\"optional\":");
            try writeShape(w, x);
            try w.writeByte('}');
        },
        .one_of => |xs| {
            try w.writeAll("{\"oneOf\":[");
            for (xs, 0..) |x, i| {
                if (i > 0) try w.writeByte(',');
                try writeShape(w, x);
            }
            try w.writeAll("]}");
        },
        .map => |m| {
            try w.writeAll("{\"map\":");
            try writeFields(w, m.fields);
            if (m.open) try w.writeAll(",\"open\":true");
            try w.writeByte('}');
        },
    }
}

fn writeFields(w: *std.Io.Writer, fields: []const capabilities.Field) std.Io.Writer.Error!void {
    try w.writeByte('[');
    for (fields, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"key\":");
        try writeString(w, f.key);
        try w.writeAll(",\"shape\":");
        try writeShape(w, f.shape);
        if (f.optional) try w.writeAll(",\"optional\":true");
        try w.writeByte('}');
    }
    try w.writeByte(']');
}

/// One Operation Declaration, as the Fingerprint writes it, or with its
/// `description` and then its `examples` after its other keys, each only
/// when present, as the Host Manifest does.
pub fn writeOperation(w: *std.Io.Writer, op: *const capabilities.Operation, documented: bool) !void {
    try w.writeAll("{\"name\":");
    try writeString(w, op.name);
    try w.writeAll(",\"mode\":");
    try writeString(w, switch (op.mode) {
        .immediate => "immediate",
        .suspending => "suspending",
        .fire_and_forget => "fire-and-forget",
    });
    try w.writeAll(",\"args\":[");
    for (op.args, 0..) |a, i| {
        if (i > 0) try w.writeByte(',');
        try writeShape(w, a);
    }
    try w.writeByte(']');
    if (op.result) |r| {
        try w.writeAll(",\"result\":");
        try writeShape(w, r);
    }
    try w.print(",\"cost\":{{\"fuel\":{d},\"alloc\":{d}}}", .{ op.cost.fuel, op.cost.alloc });
    if (op.mode == .suspending and op.max_pending_ms > 0) try w.print(",\"maxPending\":{d}", .{op.max_pending_ms});
    if (op.errors.len > 0 or op.closed_errors) {
        // Ordered by code. The codes the Core raises itself, such as
        // `invalid key`, aren't the Host's to declare.
        var order: [64]usize = undefined;
        var n: usize = 0;
        for (op.errors, 0..) |e, i| if (!e.core and n < order.len) {
            order[n] = i;
            n += 1;
        };
        std.mem.sort(usize, order[0..n], op.errors, struct {
            fn less(errs: []const capabilities.ErrorDecl, x: usize, y: usize) bool {
                return std.mem.order(u8, errs[x].code, errs[y].code) == .lt;
            }
        }.less);
        try w.writeAll(",\"errors\":[");
        for (order[0..n], 0..) |e, i| {
            if (i > 0) try w.writeByte(',');
            try w.writeAll("{\"code\":");
            try writeString(w, op.errors[e].code);
            try w.writeAll(",\"fields\":");
            try writeFields(w, op.errors[e].fields);
            try w.writeByte('}');
        }
        try w.writeByte(']');
    }
    switch (op.scope) {
        .none => {},
        .opens => |o| {
            try w.writeAll(",\"scope\":{\"opens\":");
            try writeString(w, o.name);
            try w.writeAll(",\"abandon\":");
            try writeString(w, o.abandon);
            try w.writeByte('}');
        },
        .closes => |n| {
            try w.writeAll(",\"scope\":{\"closes\":");
            try writeString(w, n);
            try w.writeByte('}');
        },
    }
    if (op.segment_bound) try w.writeAll(",\"segmentBound\":true");
    if (documented and op.description.len > 0) {
        try w.writeAll(",\"description\":");
        try writeString(w, op.description);
    }
    if (documented and op.examples.len > 0) {
        try w.writeAll(",\"examples\":[");
        for (op.examples, 0..) |e, i| {
            if (i > 0) try w.writeByte(',');
            try writeString(w, e);
        }
        try w.writeByte(']');
    }
    try w.writeByte('}');
}

/// A Grant's `{"capability", "operations"}`: its Capability's name and the
/// Operations it keeps, ordered by name. `a` owns the text.
pub fn grantJson(a: Allocator, capability: *const capabilities.Capability, kept: []const bool) Allocator.Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    errdefer out.deinit();
    const w = &out.writer;
    w.writeByte('{') catch return error.OutOfMemory;
    writeGrant(a, w, capability, kept, false) catch return error.OutOfMemory;
    w.writeByte('}') catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// A Grant's `"capability"` and `"operations"` keys, the Host Manifest's
/// with each Operation's documentation.
pub fn writeGrant(a: Allocator, w: *std.Io.Writer, capability: *const capabilities.Capability, kept: []const bool, documented: bool) !void {
    var order: std.ArrayList(usize) = .empty;
    defer order.deinit(a);
    for (kept, 0..) |k, i| if (k) try order.append(a, i);
    std.mem.sort(usize, order.items, capability.operations, struct {
        fn less(ops: []const capabilities.Operation, x: usize, y: usize) bool {
            return std.mem.order(u8, ops[x].name, ops[y].name) == .lt;
        }
    }.less);
    try w.writeAll("\"capability\":");
    try writeString(w, capability.name);
    try w.writeAll(",\"operations\":[");
    for (order.items, 0..) |op, i| {
        if (i > 0) try w.writeByte(',');
        try writeOperation(w, &capability.operations[op], documented);
    }
    try w.writeByte(']');
}

pub const Library = struct { name: []const u8, identity: [32]u8 };
pub const Grant = struct { name: []const u8, json: []const u8 };
pub const Script = struct {
    name: []const u8,
    identity: [32]u8,
    grants: []const Grant,
    /// Each limit in `limits.toml`'s order.
    limits: [limits_table.limit.len]u64,
};

/// The Group Fingerprint of these Libraries and Scripts, which it sorts.
pub fn compute(libraries: []Library, scripts: []Script) [32]u8 {
    std.mem.sort(Library, libraries, {}, struct {
        fn less(_: void, x: Library, y: Library) bool {
            return std.mem.order(u8, x.name, y.name) == .lt;
        }
    }.less);
    std.mem.sort(Script, scripts, {}, struct {
        fn less(_: void, x: Script, y: Script) bool {
            return std.mem.order(u8, x.name, y.name) == .lt;
        }
    }.less);
    var h: Hashing = .{};
    var buffer: [256]u8 = undefined;
    var hw = h.writer(&buffer);
    const w = &hw.interface;
    write(w, libraries, scripts) catch unreachable;
    w.flush() catch unreachable;
    var out: [32]u8 = undefined;
    h.sha.final(&out);
    return out;
}

fn write(w: *std.Io.Writer, libraries: []const Library, scripts: []const Script) !void {
    try w.writeAll("{\"language\":");
    try writeString(w, version.language);
    try w.print(",\"costModel\":{d},\"libraries\":[", .{cost_model.version});
    for (libraries, 0..) |l, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeByte('[');
        try writeString(w, l.name);
        try w.print(",\"{x}\"]", .{l.identity});
    }
    try w.writeAll("],\"scripts\":[");
    for (scripts, 0..) |s, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, s.name);
        try w.print(",\"identity\":\"{x}\",\"grants\":{{", .{s.identity});
        // Granted names in order.
        var order: [256]usize = undefined;
        const n = @min(s.grants.len, order.len);
        for (order[0..n], 0..) |*o, j| o.* = j;
        std.mem.sort(usize, order[0..n], s.grants, struct {
            fn less(gs: []const Grant, x: usize, y: usize) bool {
                return std.mem.order(u8, gs[x].name, gs[y].name) == .lt;
            }
        }.less);
        for (order[0..n], 0..) |g, j| {
            if (j > 0) try w.writeByte(',');
            try writeString(w, s.grants[g].name);
            try w.writeByte(':');
            try w.writeAll(s.grants[g].json);
        }
        try w.writeAll("},\"limits\":{");
        for (limits_table.limit, s.limits, 0..) |l, v, j| {
            if (j > 0) try w.writeByte(',');
            try writeString(w, l.ts);
            try w.print(":{d}", .{v});
        }
        try w.writeAll("}}");
    }
    try w.writeAll("]}");
}

/// A writer sink that hashes what it's given.
const Hashing = struct {
    sha: std.crypto.hash.sha2.Sha256 = .init(.{}),

    const Writer = struct {
        interface: std.Io.Writer,
        hashing: *Hashing,
    };

    fn writer(h: *Hashing, buffer: []u8) Writer {
        return .{ .hashing = h, .interface = .{ .buffer = buffer, .vtable = &.{ .drain = drain } } };
    }

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const self: *Writer = @alignCast(@fieldParentPtr("interface", w));
        self.hashing.sha.update(w.buffered());
        w.end = 0;
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |d| {
            self.hashing.sha.update(d);
            n += d.len;
        }
        const last = data[data.len - 1];
        for (0..splat) |_| self.hashing.sha.update(last);
        return n + last.len * splat;
    }
};

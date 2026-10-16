//! The Host Manifest (chapter 9, The Host Manifest format): what a kind of
//! Script may use, as deterministic JSON for tooling. Operation Declarations
//! and Shapes are the Group Fingerprint's data model, with each Operation's
//! documentation. It is a pure function of the definitions, never of a live
//! Group, and the Core never reads it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const capabilities = @import("capabilities.zig");
const objects = @import("objects.zig");
const machine = @import("machine.zig");
const fingerprint = @import("fingerprint.zig");
const version = @import("../generated/version.zig").version;

const writeString = fingerprint.writeString;

pub const Grant = struct { name: []const u8, grant: *const capabilities.Grant };
/// A message tooling may expect. `receivers` is empty for a message
/// addressed to a Script.
/// `description` and `examples` are documentation, written only when present.
pub const Message = struct { name: []const u8, args: []const *capabilities.Shape, receivers: []const *const objects.Kind, description: []const u8 = "", examples: []const []const u8 = &.{} };
/// A well-known name bound at load, and its object's kind.
pub const Object = struct { name: []const u8, kind: *const objects.Kind };
pub const Spec = struct {
    kind: []const u8,
    version: []const u8,
    grants: []const Grant,
    libraries: []const *const machine.Library,
    messages: []const Message,
    object_kinds: []const *const objects.Kind,
    objects: []const Object,
};

pub const Error = Allocator.Error || error{InvalidValue};

fn nameOf(x: anytype) []const u8 {
    return switch (@TypeOf(x)) {
        *const machine.Library, *const objects.Kind => x.name,
        []const u8 => x,
        else => x.name,
    };
}

/// `items` ordered by name, which must each be distinct.
fn sorted(a: Allocator, comptime T: type, items: []const T) Error![]T {
    const out = try a.dupe(T, items);
    errdefer a.free(out);
    std.mem.sort(T, out, {}, struct {
        fn less(_: void, x: T, y: T) bool {
            return std.mem.order(u8, nameOf(x), nameOf(y)) == .lt;
        }
    }.less);
    if (out.len > 1) for (out[1..], 0..) |x, i| if (std.mem.eql(u8, nameOf(x), nameOf(out[i]))) return error.InvalidValue;
    return out;
}

fn writeCost(w: *std.Io.Writer, c: capabilities.Cost) !void {
    try w.print("{{\"fuel\":{d},\"alloc\":{d}}}", .{ c.fuel, c.alloc });
}

/// The manifest's bytes, owned by the caller. Each list is ordered by name,
/// and a name given twice in one list, or a message name that isn't a Name
/// or a Selector for its arguments, is InvalidValue.
pub fn write(a: Allocator, spec: Spec) Error![]u8 {
    for (spec.messages) |m| if (!machine.messageName(m.name, m.args.len)) return error.InvalidValue;
    const grants = try sorted(a, Grant, spec.grants);
    defer a.free(grants);
    const libraries = try sorted(a, *const machine.Library, spec.libraries);
    defer a.free(libraries);
    const messages = try sorted(a, Message, spec.messages);
    defer a.free(messages);
    const kinds = try sorted(a, *const objects.Kind, spec.object_kinds);
    defer a.free(kinds);
    const named = try sorted(a, Object, spec.objects);
    defer a.free(named);
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    writeAll(a, &out.writer, spec, grants, libraries, messages, kinds, named) catch |err| return if (err == error.WriteFailed) error.OutOfMemory else @errorCast(err);
    return out.toOwnedSlice();
}

fn writeAll(a: Allocator, w: *std.Io.Writer, spec: Spec, grants: []const Grant, libraries: []const *const machine.Library, messages: []const Message, kinds: []const *const objects.Kind, named: []const Object) !void {
    try w.writeAll("{\"kind\":");
    try writeString(w, spec.kind);
    try w.writeAll(",\"version\":");
    try writeString(w, spec.version);
    try w.writeAll(",\"language\":");
    try writeString(w, version.language);
    try w.writeAll(",\"grants\":[");
    for (grants, 0..) |g, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, g.name);
        try w.writeByte(',');
        try fingerprint.writeGrant(a, w, g.grant.capability, g.grant.operations, true);
        try w.writeByte('}');
    }
    try w.writeAll("],\"libraries\":[");
    for (libraries, 0..) |l, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, l.name);
        try w.writeAll(",\"version\":");
        try writeString(w, l.version);
        try w.writeAll(",\"source\":");
        try writeString(w, l.source);
        try w.writeAll(",\"needs\":[");
        for (l.operations, 0..) |r, j| {
            if (j > 0) try w.writeByte(',');
            try w.writeAll("{\"capability\":");
            try writeString(w, r.capability[0..r.capability_len]);
            try w.writeAll(",\"operation\":");
            try writeString(w, r.operation[0..r.operation_len]);
            try w.writeByte('}');
        }
        try w.writeAll("]}");
    }
    try w.writeAll("],\"messages\":[");
    for (messages, 0..) |m, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, m.name);
        try w.writeAll(",\"args\":[");
        for (m.args, 0..) |s, j| {
            if (j > 0) try w.writeByte(',');
            try fingerprint.writeShape(w, s);
        }
        try w.writeAll("],\"receivers\":[");
        const receivers = try sorted(a, *const objects.Kind, m.receivers);
        defer a.free(receivers);
        for (receivers, 0..) |k, j| {
            if (j > 0) try w.writeByte(',');
            try writeString(w, k.name);
        }
        try w.writeByte(']');
        if (m.description.len > 0) {
            try w.writeAll(",\"description\":");
            try writeString(w, m.description);
        }
        if (m.examples.len > 0) {
            try w.writeAll(",\"examples\":[");
            for (m.examples, 0..) |e, j| {
                if (j > 0) try w.writeByte(',');
                try writeString(w, e);
            }
            try w.writeByte(']');
        }
        try w.writeByte('}');
    }
    try w.writeAll("],\"objectKinds\":[");
    for (kinds, 0..) |k, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, k.name);
        try w.writeAll(",\"props\":[");
        const props = try sorted(a, objects.Prop, k.props);
        defer a.free(props);
        for (props, 0..) |p, j| {
            if (j > 0) try w.writeByte(',');
            try w.writeAll("{\"name\":");
            try writeString(w, p.name);
            try w.writeAll(",\"shape\":");
            try fingerprint.writeShape(w, p.shape);
            try w.print(",\"readOnly\":{},\"getCost\":", .{p.set == null});
            try writeCost(w, p.get_cost);
            try w.writeAll(",\"setCost\":");
            try writeCost(w, p.set_cost);
            try w.writeByte('}');
        }
        try w.writeAll("],\"parentKinds\":[");
        const parents = try sorted(a, []const u8, k.parent_kinds);
        defer a.free(parents);
        for (parents, 0..) |p, j| {
            if (j > 0) try w.writeByte(',');
            try writeString(w, p);
        }
        try w.writeAll("]}");
    }
    try w.writeAll("],\"objects\":[");
    for (named, 0..) |o, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"name\":");
        try writeString(w, o.name);
        try w.writeAll(",\"kind\":");
        try writeString(w, o.kind.name);
        try w.writeByte('}');
    }
    try w.writeAll("]}");
}

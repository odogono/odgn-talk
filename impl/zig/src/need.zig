//! A paused exchange's Needs, written once for both Message Layer layouts.
//!
//! An Exchange pauses for a Need the Host must answer: an op, prop or
//! effect callback, or a Grant release. Each Need's fields are listed here
//! once, in order; the JSON and fields layouts only encode them, as
//! `reportFields` does for Reports (#1568).
//!
//! `e` is an encoder with `key`, `text`, `int`, `boolean`, `texts`,
//! `instant`, `value` (a Value Encoding field), `list`/`item`/`endList`,
//! `object` (a Host Object reference) and `setter` (what marks a prop set,
//! if the layout needs a mark).

const std = @import("std");
const Allocator = std.mem.Allocator;

/// The kind's fields of `n`, a paused exchange's op, prop or effect Need.
pub fn fields(e: anytype, n: anytype) Allocator.Error!void {
    switch (n.kind) {
        .op => {
            try e.key("call");
            try e.text(n.call);
            try e.key("script");
            try e.text(n.script);
            try e.key("run");
            try e.text(n.run);
            try e.key("segment");
            try e.text(n.segment);
            try e.key("grant");
            try e.text(n.grant);
            try e.key("capability");
            try e.text(n.capability);
            try e.key("operation");
            try e.text(n.operation);
            try e.key("mode");
            try e.text(modeName(n.mode));
            try e.key("now");
            try e.instant(n.now);
            try e.key("args");
            try e.list(n.args.len);
            for (n.args) |v| {
                try e.item();
                try e.value(v);
            }
            try e.endList();
            if (n.scope.len > 0) {
                try e.key("scope");
                try e.text(n.scope);
            }
            try e.key("automatic");
            try e.boolean(n.automatic);
            if (n.fuel_left) |left| {
                try e.key("fuelLeft");
                try e.int(left);
            }
            if (n.delivery.len > 0) {
                try e.key("delivery");
                try e.text(n.delivery);
            }
        },
        .effect => {
            try e.key("script");
            try e.text(n.script);
            try e.key("run");
            try e.text(n.run);
            try e.key("segment");
            try e.text(n.segment);
            try e.key("grant");
            try e.text(n.grant);
            try e.key("grants");
            try e.texts(n.grants);
            if (n.coordinator) |c| {
                try e.key("coordinator");
                try e.text(c);
            }
            try e.key("phase");
            try e.text(@tagName(n.phase));
            try e.key("now");
            try e.instant(n.now);
        },
        .prop => {
            try e.key("object");
            try e.object(n.object_kind, n.object_id);
            try e.key("prop");
            try e.text(n.prop);
            if (n.value) |v| {
                try e.setter();
                try e.key("value");
                try e.value(v);
            }
            if (n.op) |op| {
                try e.key("op");
                try e.text(op);
            }
            if (n.selector) |v| {
                try e.key("selector");
                try e.value(v);
            }
        },
    }
}

/// The fields of `r`, a Grant release the exchange pauses for.
pub fn releaseFields(e: anytype, r: anytype) Allocator.Error!void {
    try e.key("script");
    try e.text(r.script);
    try e.key("grant");
    try e.text(r.grant);
    try e.key("reason");
    try e.text(@tagName(r.reason));
    try e.key("now");
    try e.instant(r.now);
}

pub fn modeName(m: anytype) []const u8 {
    return switch (m) {
        .immediate => "immediate",
        .suspending => "suspending",
        .fire_and_forget => "fire-and-forget",
    };
}

/// Records each call as one line, so a test sees the field order every
/// layout writes.
const Recorder = struct {
    out: std.ArrayList(u8) = .empty,
    gpa: Allocator,

    fn line(r: *Recorder, comptime fmt: []const u8, args: anytype) Allocator.Error!void {
        try r.out.print(r.gpa, fmt ++ "\n", args);
    }
    fn key(r: *Recorder, comptime name: []const u8) Allocator.Error!void {
        try r.line("key {s}", .{name});
    }
    fn text(r: *Recorder, s: []const u8) Allocator.Error!void {
        try r.line("text {s}", .{s});
    }
    fn int(r: *Recorder, n: i128) Allocator.Error!void {
        try r.line("int {d}", .{n});
    }
    fn boolean(r: *Recorder, b: bool) Allocator.Error!void {
        try r.line("bool {}", .{b});
    }
    fn texts(r: *Recorder, xs: []const []const u8) Allocator.Error!void {
        try r.line("texts {d}", .{xs.len});
    }
    fn instant(r: *Recorder, t: anytype) Allocator.Error!void {
        try r.line("instant {d}", .{t});
    }
    fn value(r: *Recorder, v: anytype) Allocator.Error!void {
        try r.line("value {d}", .{v});
    }
    fn list(r: *Recorder, n: usize) Allocator.Error!void {
        try r.line("list {d}", .{n});
    }
    fn item(_: *Recorder) Allocator.Error!void {}
    fn endList(r: *Recorder) Allocator.Error!void {
        try r.line("end", .{});
    }
    fn object(r: *Recorder, kind: []const u8, id: []const u8) Allocator.Error!void {
        try r.line("object {s} {s}", .{ kind, id });
    }
    fn setter(r: *Recorder) Allocator.Error!void {
        try r.line("set", .{});
    }
};

test "a prop set marks itself before its value, and a get writes neither" {
    const Prop = struct {
        kind: enum { op, effect, prop } = .prop,
        object_kind: []const u8 = "room",
        object_id: []const u8 = "hall",
        prop: []const u8 = "name",
        value: ?u8 = null,
        op: ?[]const u8 = null,
        selector: ?u8 = null,
        // Unused by a prop, but `fields` names them.
        call: []const u8 = "",
        script: []const u8 = "",
        run: []const u8 = "",
        segment: []const u8 = "",
        grant: []const u8 = "",
        capability: []const u8 = "",
        operation: []const u8 = "",
        mode: enum { immediate, suspending, fire_and_forget } = .immediate,
        now: u8 = 0,
        args: []const u8 = &.{},
        scope: []const u8 = "",
        automatic: bool = false,
        fuel_left: ?u8 = null,
        delivery: []const u8 = "",
        grants: []const []const u8 = &.{},
        coordinator: ?[]const u8 = null,
        phase: enum { begin } = .begin,
    };
    const gpa = std.testing.allocator;
    var set: Recorder = .{ .gpa = gpa };
    defer set.out.deinit(gpa);
    try fields(&set, Prop{ .value = 7 });
    try std.testing.expectEqualStrings(
        \\key object
        \\object room hall
        \\key prop
        \\text name
        \\set
        \\key value
        \\value 7
        \\
    , set.out.items);
    var get: Recorder = .{ .gpa = gpa };
    defer get.out.deinit(gpa);
    try fields(&get, Prop{});
    try std.testing.expectEqualStrings("key object\nobject room hall\nkey prop\ntext name\n", get.out.items);
}

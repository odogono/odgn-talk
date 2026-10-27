//! A paused exchange's Needs and results, described once for both layouts.
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

/// The fields of `need`, in order: a Grant release, or a paused exchange's
/// op, prop or effect Need. Both layouts write every Need through here.
pub fn needFields(e: anytype, need: anytype) Allocator.Error!void {
    const T = switch (@typeInfo(@TypeOf(need))) {
        .pointer => |p| p.child,
        else => @TypeOf(need),
    };
    return if (@hasField(T, "reason")) releaseFields(e, need) else fields(e, need);
}

fn fields(e: anytype, n: anytype) Allocator.Error!void {
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
fn releaseFields(e: anytype, r: anytype) Allocator.Error!void {
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

// Results borrow their protocol texts from the parsed frame, and own their
// Values. Neither the neutral result nor its mapping to Answer knows a layout.
const model = @import("value.zig");
const Value = model.Value;
const Json = std.json.Value;
const encoding = @import("encoding.zig");
const binary = @import("binary_value.zig");
const rp = @import("request_pump.zig");
const exchange = @import("exchange.zig");
const caps = @import("machine/capabilities.zig");

/// What the re-made crossing consumes. All texts and Values are owned.
pub const Answer = struct {
    kind: enum { result, started, done, fail, limit, host_error },
    value: ?*Value = null,
    code: []const u8 = "",
    message: ?[]const u8 = null,
    data: ?*Value = null,
    charged: u64 = 0,

    pub fn release(a: *Answer, gpa: Allocator) void {
        if (a.value) |v| v.release();
        if (a.data) |v| v.release();
        if (a.code.len > 0) gpa.free(a.code);
        if (a.message) |m| gpa.free(m);
        a.* = undefined;
    }
};

pub const Outcome = @FieldType(Answer, "kind");

pub const CallbackResult = struct {
    kind: Outcome,
    value: ?*Value = null,
    code: ?[]const u8 = null,
    message: ?[]const u8 = null,
    data: ?*Value = null,
    charged: u64 = 0,
};

pub const Result = union(enum) {
    callback: CallbackResult,
    effect: caps.EffectStatus,
    release,
};

/// Consumes the callback's Values, including on failure. This is the one
/// mapping from a layout-neutral callback result to the worker's Answer.
pub fn answer(gpa: Allocator, result: CallbackResult) Allocator.Error!Answer {
    var out: Answer = .{ .kind = result.kind, .charged = result.charged, .value = result.value, .data = result.data };
    errdefer out.release(gpa);
    if (result.kind == .fail) {
        out.code = try gpa.dupe(u8, result.code.?);
        if (result.message) |m| out.message = try gpa.dupe(u8, m);
    }
    return out;
}

/// Layout parsers own syntax, including JSON's `limit: true`, optional
/// fields and outcome precedence. The shared reader owns decoded results.
pub fn readJson(gpa: Allocator, kind: exchange.Result, msg: Json, options: binary.DecodeOptions) !Result {
    return read(JsonResult{ .gpa = gpa, .kind = kind, .msg = msg, .options = options });
}

/// `spans` is a validated callback record from `rp.Reader.record`; dispatch,
/// ref/Group validation and the exchange gate stay with the Message Layer.
pub fn readFields(gpa: Allocator, kind: exchange.Result, spans: []const ?[]const u8, options: binary.DecodeOptions) !Result {
    return read(FieldsResult{ .gpa = gpa, .kind = kind, .spans = spans, .options = options });
}

fn read(p: anytype) !Result {
    switch (p.kind) {
        .release => return .release,
        .effect => {
            const status = p.status();
            return .{ .effect = if (std.mem.eql(u8, status, "ok")) .ok else if (std.mem.eql(u8, status, "failed")) .failed else .unknown };
        },
        .op, .prop => {},
        .trace => unreachable,
    }
    const charged = try p.charged();
    if (charged > 9_007_199_254_740_991) return error.InvalidValue;
    var result: CallbackResult = .{ .kind = try p.outcome(), .charged = charged };
    switch (result.kind) {
        .result => result.value = try p.value(),
        .fail => {
            // A malformed failure is a broken Host callback, while an
            // invalid successful Value refuses the frame. Both layouts
            // keep this distinction, including a wrong-Group Function.
            failure(p, &result) catch |err| {
                if (err == error.OutOfMemory) return error.OutOfMemory;
                result.kind = .host_error;
                result.code = null;
                result.message = null;
            };
        },
        .started, .done, .limit, .host_error => {},
    }
    return .{ .callback = result };
}

fn failure(p: anytype, result: *CallbackResult) !void {
    result.code = try p.code() orelse return error.InvalidValue;
    result.message = try p.message();
    result.data = try p.data();
}

/// The field naming a successful Value: `value` for props, `result` otherwise.
fn successKey(kind: exchange.Result) []const u8 {
    return if (kind == .prop) "value" else "result";
}

fn field(j: Json, key: []const u8) ?Json {
    return if (j == .object) j.object.get(key) else null;
}
fn text(j: ?Json) ?[]const u8 {
    const v = j orelse return null;
    return if (v == .string) v.string else null;
}

const JsonResult = struct {
    gpa: Allocator,
    kind: exchange.Result,
    msg: Json,
    options: binary.DecodeOptions,

    fn charged(p: JsonResult) !u64 {
        const v = field(p.msg, "charged") orelse return 0;
        const s = switch (v) {
            .integer => |n| return std.math.cast(u64, n) orelse error.InvalidValue,
            .string, .number_string => |s| s,
            else => return error.InvalidValue,
        };
        // JSON integers are signed 64-bit, even when spelled as text.
        const n = std.fmt.parseInt(i64, s, 10) catch return error.InvalidValue;
        return std.math.cast(u64, n) orelse error.InvalidValue;
    }
    fn outcome(p: JsonResult) !Outcome {
        if (p.kind == .op) {
            // A latched refusal wins over any successful outcome.
            if (field(p.msg, "limit")) |v| {
                if (v != .bool or !v.bool) return error.InvalidValue;
                return .limit;
            }
        }
        if (field(p.msg, successKey(p.kind)) != null) return .result;
        if (p.kind == .prop) {
            if (field(p.msg, "ok") != null) return .done;
        } else {
            if (field(p.msg, "started") != null) return .started;
            if (field(p.msg, "done") != null) return .done;
        }
        if (field(p.msg, "fail") != null) return .fail;
        if (field(p.msg, "hostError") != null) return .host_error;
        return error.NoOutcome;
    }
    fn value(p: JsonResult) !*Value {
        return encoding.decodeParsed(p.gpa, field(p.msg, successKey(p.kind)).?, p.options.resolver);
    }
    fn code(p: JsonResult) !?[]const u8 {
        return text(field(p.fail(), "code"));
    }
    fn message(p: JsonResult) !?[]const u8 {
        return text(field(p.fail(), "message"));
    }
    fn data(p: JsonResult) !?*Value {
        const v = field(p.fail(), "data") orelse return null;
        return if (v == .null) null else try encoding.decodeParsed(p.gpa, v, p.options.resolver);
    }
    /// Only reached once `outcome` has found the `fail` field.
    fn fail(p: JsonResult) Json {
        return field(p.msg, "fail").?;
    }
    fn status(p: JsonResult) []const u8 {
        return text(field(p.msg, "status")) orelse "unknown";
    }
};

const FieldsResult = struct {
    gpa: Allocator,
    kind: exchange.Result,
    spans: []const ?[]const u8,
    options: binary.DecodeOptions,

    fn charged(p: FieldsResult) !u64 {
        return if (p.spans[6]) |v| rp.uintOf(v) catch error.InvalidValue else 0;
    }
    fn outcome(p: FieldsResult) !Outcome {
        const given = try rp.ptextOf(p.spans[2] orelse return error.NoOutcome);
        const prop = p.kind == .prop;
        if (std.mem.eql(u8, given, successKey(p.kind))) return .result;
        if (std.mem.eql(u8, given, "fail")) return .fail;
        if (std.mem.eql(u8, given, "hostError")) return .host_error;
        if (prop) {
            if (std.mem.eql(u8, given, "ok")) return .done;
        } else {
            if (std.mem.eql(u8, given, "started")) return .started;
            if (std.mem.eql(u8, given, "done")) return .done;
            if (std.mem.eql(u8, given, "limit")) return .limit;
        }
        return error.UnknownOutcome;
    }
    fn value(p: FieldsResult) !*Value {
        const v = p.spans[3] orelse return model.scalar(p.gpa, .nothing);
        return binary.decode(p.gpa, v, p.options);
    }
    fn code(p: FieldsResult) !?[]const u8 {
        return if (p.spans[4]) |v| try rp.ptextOf(v) else null;
    }
    fn message(p: FieldsResult) !?[]const u8 {
        return if (p.spans[5]) |v| try rp.ptextOf(v) else null;
    }
    fn data(p: FieldsResult) !?*Value {
        return if (p.spans[3]) |v| try binary.decode(p.gpa, v, p.options) else null;
    }
    fn status(p: FieldsResult) []const u8 {
        return if (p.spans[2]) |v| rp.ptextOf(v) catch "unknown" else "unknown";
    }
};

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

fn expectValuesEqual(a: ?*Value, b: ?*Value) !void {
    try std.testing.expectEqual(a != null, b != null);
    if (a) |v| try std.testing.expect(try v.equal(b.?));
}

/// Consumes both results, checking the complete worker-facing Answer too.
fn expectResultsEqual(gpa: Allocator, a: Result, b: Result) !void {
    try std.testing.expectEqual(std.meta.activeTag(a), std.meta.activeTag(b));
    switch (a) {
        .callback => |c| {
            var left = try answer(gpa, c);
            defer left.release(gpa);
            var right = try answer(gpa, b.callback);
            defer right.release(gpa);
            try std.testing.expectEqual(left.kind, right.kind);
            try std.testing.expectEqual(left.charged, right.charged);
            try std.testing.expectEqualStrings(left.code, right.code);
            try std.testing.expectEqual(left.message != null, right.message != null);
            if (left.message) |m| try std.testing.expectEqualStrings(m, right.message.?);
            try expectValuesEqual(left.value, right.value);
            try expectValuesEqual(left.data, right.data);
        },
        .effect => |status| try std.testing.expectEqual(status, b.effect),
        .release => {},
    }
}

fn callbackKind(c: rp.Callback) exchange.Result {
    return switch (c) {
        .op_result => .op,
        .prop_result => .prop,
        .effect_result => .effect,
        .release_result => .release,
        else => unreachable,
    };
}

fn fieldsResult(gpa: Allocator, c: rp.Callback, wire: []const u8, options: binary.DecodeOptions) !Result {
    var spans: [7]?[]const u8 = undefined;
    const names = rp.fields(c);
    var r: rp.Reader = .{ .data = wire };
    try r.record(names, true, spans[0..names.len]);
    try std.testing.expect(r.done());
    return readFields(gpa, callbackKind(c), spans[0..names.len], options);
}

test "shared callback vectors have the same result and Answer in both layouts (#1568)" {
    const gpa = std.testing.allocator;
    const Vector = struct { name: []const u8, tag: u8, hex: []const u8, tree: []const u8 };
    const vectors = try std.json.parseFromSlice([]Vector, gpa, @embedFile("envelope-frames"), .{ .ignore_unknown_fields = true });
    defer vectors.deinit();
    var checked: usize = 0;
    for (vectors.value) |v| {
        const c = rp.Callback.result(v.tag) orelse continue;
        errdefer std.debug.print("callback vector: {s}\n", .{v.name});
        const wire = try gpa.alloc(u8, v.hex.len / 2);
        defer gpa.free(wire);
        _ = try std.fmt.hexToBytes(wire, v.hex);
        const parsed = try std.json.parseFromSlice(Json, gpa, v.tree, .{ .parse_numbers = false });
        defer parsed.deinit();
        const left = try readJson(gpa, callbackKind(c), parsed.value, .{});
        const right = try fieldsResult(gpa, c, wire[rp.prefix.len + 2 ..], .{});
        try expectResultsEqual(gpa, left, right);
        checked += 1;
    }
    // Every op/prop outcome, Nothing, effect and release.
    try std.testing.expectEqual(14, checked);
}

const TestFields = struct {
    outcome: ?[]const u8 = null,
    value: ?[]const u8 = null,
    code: ?[]const u8 = null,
    message: ?[]const u8 = null,
    charged: ?[]const u8 = null,
};

fn testFields(gpa: Allocator, c: rp.Callback, f: TestFields) ![]u8 {
    var w = rp.Writer.init(gpa);
    defer w.deinit();
    try w.begin(rp.fields(c), true);
    try w.key("ref");
    try w.int(1);
    try w.key("group");
    try w.ptext("g");
    if (f.outcome) |o| {
        try w.key(if (c == .effect_result) "status" else "outcome");
        try w.ptext(o);
    }
    if (f.value) |v| {
        try w.key("value");
        try w.raw(v);
    }
    if (f.code) |code| {
        try w.key("code");
        try w.ptext(code);
    }
    if (f.message) |m| {
        try w.key("message");
        try w.ptext(m);
    }
    if (f.charged) |charged| {
        try w.key("charged");
        try w.raw(charged);
    }
    try w.end();
    return w.finish();
}

const TestResolver = struct {
    fn function(_: ?*anyopaque, _: []const u8, _: []const u8, _: []const u8) encoding.DecodeError!*Value {
        return error.WrongGroup;
    }
    fn object(_: ?*anyopaque, _: []const u8, _: []const u8) model.Error!*Value {
        return error.InvalidValue;
    }
};

test "callback refusals and broken failures agree across layouts (#1568)" {
    const gpa = std.testing.allocator;
    const Case = struct {
        json: []const u8,
        fields: TestFields,
        err: ?anyerror = null,
        kind: Outcome = .host_error,
    };
    const cases = [_]Case{
        .{ .json = "{}", .fields = .{}, .err = error.NoOutcome },
        .{ .json = "{\"charged\":-1}", .fields = .{ .charged = &.{ rp.tag.negative, 1 } }, .err = error.InvalidValue },
        .{ .json = "{\"charged\":9007199254740992}", .fields = .{ .charged = &.{ rp.tag.integer, 128, 128, 128, 128, 128, 128, 128, 16 } }, .err = error.InvalidValue },
        .{ .json = "{\"result\":{\"$object\":[\"x\",\"missing\"]},\"value\":{\"$object\":[\"x\",\"missing\"]}}", .fields = .{ .value = "\x0e\x05\x01x\x05\x07missing" }, .err = error.InvalidValue },
        .{ .json = "{\"result\":[1,{\"$function\":[\"s\",\"f\",\"token\"]}],\"value\":[1,{\"$function\":[\"s\",\"f\",\"token\"]}]}", .fields = .{ .value = "\x06\x02\x03\x01\x0f\x05\x01s\x05\x01f\x05\x05token" }, .err = error.WrongGroup },
        .{ .json = "{\"fail\":{}}", .fields = .{ .outcome = "fail" } },
        .{ .json = "{\"fail\":{\"code\":\"E\",\"message\":\"broken\",\"data\":{\"$object\":[\"x\",\"missing\"]}}}", .fields = .{ .outcome = "fail", .code = "E", .message = "broken", .value = "\x0e\x05\x01x\x05\x07missing" } },
        .{ .json = "{\"fail\":{\"code\":\"E\",\"data\":{\"$function\":[\"s\",\"f\",\"token\"]}}}", .fields = .{ .outcome = "fail", .code = "E", .value = "\x0f\x05\x01s\x05\x01f\x05\x05token" } },
        .{ .json = "{\"fail\":{\"code\":\"\",\"data\":null}}", .fields = .{ .outcome = "fail", .code = "" }, .kind = .fail },
    };
    const options: binary.DecodeOptions = .{ .resolver = .{ .object = TestResolver.object, .function_token = TestResolver.function } };
    for ([_]rp.Callback{ .op_result, .prop_result }) |c| for (cases) |tc| {
        errdefer std.debug.print("callback {s}: {s}\n", .{ @tagName(c), tc.json });
        const parsed = try std.json.parseFromSlice(Json, gpa, tc.json, .{ .parse_numbers = false });
        defer parsed.deinit();
        var f = tc.fields;
        if (f.value != null and f.outcome == null) f.outcome = if (c == .prop_result) "value" else "result";
        const wire = try testFields(gpa, c, f);
        defer gpa.free(wire);
        if (tc.err) |err| {
            try std.testing.expectError(err, readJson(gpa, callbackKind(c), parsed.value, options));
            try std.testing.expectError(err, fieldsResult(gpa, c, wire, options));
        } else {
            const left = try readJson(gpa, callbackKind(c), parsed.value, options);
            const right = try fieldsResult(gpa, c, wire, options);
            try std.testing.expectEqual(tc.kind, left.callback.kind);
            try expectResultsEqual(gpa, left, right);
        }
    };
}

test "effect status and release results are layout neutral (#1568)" {
    const gpa = std.testing.allocator;
    const cases = [_]struct { json: []const u8, status: ?[]const u8, want: caps.EffectStatus }{
        .{ .json = "{\"status\":\"ok\"}", .status = "ok", .want = .ok },
        .{ .json = "{\"status\":\"failed\"}", .status = "failed", .want = .failed },
        .{ .json = "{\"status\":\"other\"}", .status = "other", .want = .unknown },
        .{ .json = "{\"status\":false}", .status = null, .want = .unknown },
        .{ .json = "{}", .status = null, .want = .unknown },
    };
    for (cases) |tc| {
        const parsed = try std.json.parseFromSlice(Json, gpa, tc.json, .{});
        defer parsed.deinit();
        const wire = try testFields(gpa, .effect_result, .{ .outcome = tc.status });
        defer gpa.free(wire);
        const left = try readJson(gpa, .effect, parsed.value, .{});
        try std.testing.expectEqual(tc.want, left.effect);
        try expectResultsEqual(gpa, left, try fieldsResult(gpa, .effect_result, wire, .{}));
    }
    // Release acknowledgements have no outcome, even if JSON gives one.
    const release = try std.json.parseFromSlice(Json, gpa, "{\"result\":false}", .{});
    defer release.deinit();
    const wire = try testFields(gpa, .release_result, .{});
    defer gpa.free(wire);
    try expectResultsEqual(gpa, try readJson(gpa, .release, release.value, .{}), try fieldsResult(gpa, .release_result, wire, .{}));
}

test "JSON owns limit syntax and outcome precedence (#1568)" {
    const gpa = std.testing.allocator;
    const cases = [_]struct { json: []const u8, want: ?Outcome }{
        .{ .json = "{\"limit\":true,\"result\":{\"$invalid\":0}}", .want = .limit },
        .{ .json = "{\"limit\":false,\"result\":1}", .want = null },
        .{ .json = "{\"limit\":1}", .want = null },
        .{ .json = "{\"result\":null,\"fail\":{}}", .want = .result },
    };
    for (cases) |tc| {
        const parsed = try std.json.parseFromSlice(Json, gpa, tc.json, .{});
        defer parsed.deinit();
        if (tc.want) |want| {
            var got = try answer(gpa, (try readJson(gpa, .op, parsed.value, .{})).callback);
            defer got.release(gpa);
            try std.testing.expectEqual(want, got.kind);
        } else try std.testing.expectError(error.InvalidValue, readJson(gpa, .op, parsed.value, .{}));
    }
}

test "an Answer frees its code and Values when copying its message fails (#1569)" {
    const gpa = std.testing.allocator;
    const data = try model.text(gpa, "owned data");
    // The code's copy succeeds and the message's fails. The mapping consumes
    // the decoded Data even when it cannot finish building the Answer.
    var failing: std.testing.FailingAllocator = .init(gpa, .{ .fail_index = 1 });
    try std.testing.expectError(error.OutOfMemory, answer(failing.allocator(), .{ .kind = .fail, .code = "E", .message = "a message", .data = data }));
}

test "a binary fail frees its code when its message cannot be copied (#1569)" {
    const gpa = std.testing.allocator;
    const wire = try testFields(gpa, .op_result, .{ .outcome = "fail", .code = "E", .message = "a message" });
    defer gpa.free(wire);
    const result = try fieldsResult(gpa, .op_result, wire, .{});
    // The code's copy succeeds and the message's fails.
    var failing: std.testing.FailingAllocator = .init(gpa, .{ .fail_index = 1 });
    try std.testing.expectError(error.OutOfMemory, answer(failing.allocator(), result.callback));
}

fn allocatedAnswer(gpa: Allocator, parsed: Json, wire: ?[]const u8) !void {
    const result = if (wire) |w| try fieldsResult(gpa, .op_result, w, .{}) else try readJson(gpa, .op, parsed, .{});
    var got = try answer(gpa, result.callback);
    defer got.release(gpa);
    try std.testing.expectEqual(.fail, got.kind);
}

test "both result readers and the Answer mapping release partial allocation failures (#1568)" {
    const gpa = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(Json, gpa, "{\"fail\":{\"code\":\"E\",\"message\":\"failure\",\"data\":[\"data\"]}}", .{});
    defer parsed.deinit();
    const wire = try testFields(gpa, .op_result, .{ .outcome = "fail", .code = "E", .message = "failure", .value = "\x06\x01\x05\x04data" });
    defer gpa.free(wire);
    try std.testing.checkAllAllocationFailures(gpa, allocatedAnswer, .{ parsed.value, @as(?[]const u8, null) });
    try std.testing.checkAllAllocationFailures(gpa, allocatedAnswer, .{ parsed.value, @as(?[]const u8, wire) });
}

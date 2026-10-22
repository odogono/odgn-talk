//! A Message Layer exchange's lifecycle (#1481): one Host-started Pump,
//! Reload or library replacement, from its first frame to its final reply,
//! with the needs and Grant releases answered inside it. The module keeps
//! the exchange's state between frames and the worker it runs, gates every
//! frame while the exchange is open, and decides what follows a pause, a
//! result or a release's acknowledgement. `message.zig` decodes and encodes
//! frames in each layout and runs the worker from what the module returns.
//!
//! The module never sees the Session. `Parts` names the payloads it holds
//! and the machine's crossing-pause calls it makes, so its tests run on
//! stand-ins.
const std = @import("std");
const Allocator = std.mem.Allocator;

/// The worker an exchange runs.
pub const Worker = enum {
    pump,
    /// A Reload or library replacement ending the old code's Runs.
    work,
};

/// A crossing that waits for the Host's result.
pub const Crossing = enum { op, prop, effect };

/// How a frame crossed: the JSON layout, or the binary fields layout,
/// whose results have no `trace-result` (ADR 0110).
pub const Layout = enum { json, binary };

/// A frame as the gate sees it: a result of some kind, or any other input.
pub const Frame = union(enum) {
    result: Result,
    input,
};

pub const Result = enum { op, prop, effect, trace, release };

/// Why a frame is refused, with the exchange left as it was. Each layout
/// words these as it did before the module (#1496 would make them agree).
pub const Refusal = enum {
    /// A result of another kind than the open need's.
    kind_mismatch,
    /// Another frame under the paused worker's ref.
    result_pending,
    /// Anything but `trace-result` under the worker's ref at a Trace pause.
    trace_pending,
    /// Binary: any result but the release's acknowledgement.
    release_pending,
    /// Binary: a result under another ref.
    wrong_ref,
    /// A result with no exchange open.
    not_open,
    /// Admission: a new input under the paused worker's ref.
    reserved_ref,
    /// Admission: no Group's worker has run.
    no_worker,
    /// Admission: an input for another Group, or for none.
    other_group,
    /// Admission: a message paused admission doesn't take.
    not_admitted,
};

/// What a frame does while an exchange may be open.
pub const Gate = union(enum) {
    /// No exchange waits for it: handled as ever.
    dispatch,
    /// Considered for paused admission beside the worker under this ref.
    admit: i64,
    refuse: Refusal,
    /// The open need's result, of this kind.
    result: Crossing,
    trace_result,
    release_result,
};

/// What a paused input is to admission.
pub const Input = enum {
    /// A worker message: refused with `reentrant call`, as natively.
    worker,
    /// A message paused admission takes.
    admitted,
    other,
};

/// The worker a paused input would join.
pub fn Paused(comptime Entry: type) type {
    return struct {
        const P = @This();
        /// The ref the worker's result is reserved for.
        ref: i64,
        entry: ?Entry,
        worker: Worker,

        pub const Admission = union(enum) {
            refuse: Refusal,
            /// A worker message for the paused Group.
            refuse_worker: Entry,
            admit: Entry,
        };

        /// Whether an input under `ref` for Group `group` joins the paused
        /// worker, as `spec/embedding/paused-crossing-inputs.md` decides.
        pub fn admission(p: P, ref: i64, group: ?Entry, input: Input) Admission {
            if (ref == p.ref) return .{ .refuse = .reserved_ref };
            const entry = p.entry orelse return .{ .refuse = .no_worker };
            if (group != entry) return .{ .refuse = .other_group };
            return switch (input) {
                .other => .{ .refuse = .not_admitted },
                .worker => .{ .refuse_worker = entry },
                .admitted => .{ .admit = entry },
            };
        }
    };
}

/// An exchange holding `Parts`' payloads, all owned by the exchange:
///
/// - `Entry`, a Group's handle, and `Need`, `Answer`, `Held` (a reply with
///   its `entry`), `Release` and `Bin`, each freed with a `gpa`;
/// - the crossing-pause calls on a Group: `releasePaused`, `pauseForRelease`,
///   `clearReleasePause`, `tracePaused`, `clearTracePause`, `beginAnswer`
///   and `answerTaken`;
/// - `EffectStatus`, an effect's result.
pub fn Exchange(comptime Parts: type) type {
    return struct {
        const X = @This();
        pub const Entry = Parts.Entry;
        pub const Need = Parts.Need;
        pub const Answer = Parts.Answer;
        pub const Held = Parts.Held;
        pub const Release = Parts.Release;
        pub const Bin = Parts.Bin;
        pub const EffectStatus = Parts.EffectStatus;

        /// Where the exchange is between frames.
        pub const State = union(enum) {
            /// Nothing waits for the Host.
            idle,
            /// Paused at a crossing whose need was sent.
            awaiting_result: struct { ref: i64, need: Need },
            /// Paused for the crossing's Trace (`crossing-trace-v1`).
            awaiting_trace: struct { ref: i64 },
            /// Each queued release is sent as a need and acknowledged in
            /// turn under `ref`, before `then`.
            awaiting_release: struct { ref: i64, then: AfterReleases },
        };

        pub const AfterReleases = union(enum) {
            /// The worker's final reply.
            reply: Held,
            /// A need reply; the exchange then waits for its result.
            need: struct { need: Need, reply: Held },
            /// The worker paused only for the releases, and goes on.
            resume_worker,
        };

        /// A worker on the stack: what its callbacks may defer to.
        pub const Running = struct {
            entry: Entry,
            worker: Worker,
            /// The need a callback made, which the worker pauses at.
            need: ?Need = null,
        };

        /// The worker to go on with, and where.
        pub const Resume = struct { entry: Entry, worker: Worker };

        /// Why a worker paused.
        pub const Pause = enum {
            /// At a crossing: its need goes out, behind any releases.
            need,
            /// For the crossing's Trace.
            trace,
            /// Only for releases: the first one's need goes out.
            release,
        };

        /// What follows a release's acknowledgement.
        pub const Acknowledged = union(enum) {
            /// The next queued release's need.
            next_release,
            /// The held reply, final or a need's, sent now.
            reply: Held,
            /// The worker, which paused only for the releases. Unlike after a
            /// result, its crossing is not answered.
            resume_worker: Resume,
        };

        /// Where a Grant release goes as the Core makes it.
        pub const Route = union(enum) {
            /// Straight to the Host on the inline transport, as an event of
            /// this Group's exchange.
            inline_to: Entry,
            /// Inline, with no Group's worker run yet: nowhere.
            drop,
            queue,
        };

        state: State = .idle,
        /// The Group whose worker last started, and which worker. It stays
        /// while the exchange is open, and also after a worker fails without
        /// a reply that could be held (#1493).
        entry: ?Entry = null,
        worker: Worker = .pump,
        running: ?Running = null,
        /// A result the re-made callback takes as the worker goes on.
        answer: ?Answer = null,
        effect_answer: ?EffectStatus = null,
        /// Grant releases waiting to be sent as needs, before the reply
        /// that follows them.
        releases: std.ArrayList(Release) = .empty,
        /// A binary exchange (#1245), kept across JSON needs so its final
        /// reply is binary.
        bin: ?Bin = null,

        /// Whether the exchange waits for the Host.
        pub fn open(x: *const X) bool {
            return x.state != .idle;
        }

        pub fn deinit(x: *X, gpa: Allocator) void {
            switch (x.state) {
                .idle, .awaiting_trace => {},
                .awaiting_result => |*w| w.need.release(gpa),
                .awaiting_release => |*w| switch (w.then) {
                    .reply => |*h| h.deinit(gpa),
                    .need => |*n| {
                        n.need.release(gpa);
                        n.reply.deinit(gpa);
                    },
                    .resume_worker => {},
                },
            }
            if (x.running) |*r| if (r.need) |*n| n.release(gpa);
            if (x.answer) |*a| a.release(gpa);
            for (x.releases.items) |*r| r.deinit(gpa);
            x.releases.deinit(gpa);
            if (x.bin) |*b| b.deinit(gpa);
            x.* = .{};
        }

        // ------------------------------------------------ the running worker

        /// A worker starts or goes on for `entry`'s Group.
        pub fn start(x: *X, entry: Entry, worker: Worker) void {
            x.entry = entry;
            x.worker = worker;
            x.running = .{ .entry = entry, .worker = worker };
        }

        /// The worker has returned, paused or not.
        pub fn stop(x: *X, gpa: Allocator) void {
            if (x.running) |*r| if (r.need) |*n| n.release(gpa);
            x.running = null;
        }

        pub fn runningEntry(x: *const X) ?Entry {
            return if (x.running) |r| r.entry else null;
        }

        /// Whether a crossing of `kind` can pause the running worker. A
        /// property crossing pauses only a Pump.
        pub fn canDefer(x: *const X, kind: Crossing) bool {
            const r = x.running orelse return false;
            return kind != .prop or r.worker == .pump;
        }

        /// Whether the running worker paused for a release, so a crossing
        /// waits rather than ask.
        pub fn releasePaused(x: *const X) bool {
            const r = x.running orelse return false;
            return Parts.releasePaused(r.entry);
        }

        /// A callback's need; the worker pauses at it.
        pub fn cross(x: *X, need: Need) void {
            x.running.?.need = need;
        }

        /// The need a callback just made.
        pub fn crossing(x: *X) *Need {
            return &x.running.?.need.?;
        }

        /// The result a re-made callback takes.
        pub fn takeAnswer(x: *X) ?Answer {
            const a = x.answer orelse return null;
            Parts.answerTaken(x.running.?.entry);
            x.answer = null;
            return a;
        }

        pub fn takeEffectAnswer(x: *X) ?EffectStatus {
            const status = x.effect_answer orelse return null;
            Parts.answerTaken(x.running.?.entry);
            x.effect_answer = null;
            return status;
        }

        /// The running worker paused under `ref`. Its need, if a callback
        /// made one, is sent next.
        pub fn pause(x: *X, ref: i64) Pause {
            std.debug.assert(x.state == .idle);
            const r = &x.running.?;
            if (r.need) |need| {
                r.need = null;
                x.state = .{ .awaiting_result = .{ .ref = ref, .need = need } };
                return .need;
            }
            if (Parts.tracePaused(r.entry)) {
                x.state = .{ .awaiting_trace = .{ .ref = ref } };
                return .trace;
            }
            std.debug.assert(x.releases.items.len > 0);
            x.state = .{ .awaiting_release = .{ .ref = ref, .then = .resume_worker } };
            return .release;
        }

        /// The open need.
        pub fn openNeed(x: *X) *Need {
            return &x.state.awaiting_result.need;
        }

        // -------------------------------------------------------- gating

        /// What a frame under `ref` does to the exchange. JSON and binary
        /// differ where they did before the module (#1496).
        pub fn gate(x: *const X, ref: i64, frame: Frame, layout: Layout) Gate {
            const binary_result = layout == .binary and frame == .result;
            switch (x.state) {
                .idle => return if (binary_result) .{ .refuse = .not_open } else .dispatch,
                .awaiting_release => |w| {
                    if (isResult(frame, .release) and ref == w.ref) return .release_result;
                    return if (binary_result) .{ .refuse = .release_pending } else .{ .admit = w.ref };
                },
                .awaiting_trace => |w| {
                    if (layout == .binary) {
                        if (frame == .input) return .{ .admit = w.ref };
                        return .{ .refuse = if (ref != w.ref) .wrong_ref else .trace_pending };
                    }
                    if (ref != w.ref) return .{ .admit = w.ref };
                    return if (isResult(frame, .trace)) .trace_result else .{ .refuse = .trace_pending };
                },
                .awaiting_result => |w| {
                    if (layout == .binary and frame == .input) return .{ .admit = w.ref };
                    if (ref != w.ref) return if (layout == .binary) .{ .refuse = .wrong_ref } else .{ .admit = w.ref };
                    const got = switch (frame) {
                        .input => return .{ .refuse = .result_pending },
                        .result => |kind| kind,
                    };
                    if (got == resultOf(w.need.kind)) return .{ .result = w.need.kind };
                    return .{ .refuse = switch (got) {
                        .op, .prop, .effect => .kind_mismatch,
                        .trace, .release => .result_pending,
                    } };
                },
            }
        }

        /// The worker an input under `ref` would join while the exchange
        /// is open.
        pub fn paused(x: *const X, ref: i64) Paused(Entry) {
            return .{ .ref = ref, .entry = x.entry, .worker = x.worker };
        }

        // ------------------------------------------------------- results

        /// The open need's result, for the re-made callback to take as the
        /// worker goes on.
        pub fn answered(x: *X, gpa: Allocator, answer: Answer) Resume {
            x.endNeed(gpa);
            x.answer = answer;
            return x.goOn();
        }

        pub fn effectAnswered(x: *X, gpa: Allocator, status: EffectStatus) Resume {
            x.endNeed(gpa);
            x.effect_answer = status;
            return x.goOn();
        }

        /// The crossing's Trace was taken.
        pub fn traceTaken(x: *X) Resume {
            std.debug.assert(x.state == .awaiting_trace);
            Parts.clearTracePause(x.entry.?);
            x.state = .idle;
            return x.goOn();
        }

        fn endNeed(x: *X, gpa: Allocator) void {
            x.state.awaiting_result.need.release(gpa);
            x.state = .idle;
        }

        fn goOn(x: *X) Resume {
            const entry = x.entry.?;
            Parts.beginAnswer(entry);
            return .{ .entry = entry, .worker = x.worker };
        }

        // ------------------------------------------------------ releases

        /// Where a Grant release the Core just made goes. `inline_open`: the
        /// inline transport is negotiated and no inline round is running.
        pub fn route(x: *const X, inline_open: bool) Route {
            if (!inline_open) return .queue;
            return if (x.entry) |e| .{ .inline_to = e } else .drop;
        }

        /// Queues a release; a running worker pauses for it.
        pub fn queue(x: *X, gpa: Allocator, release: Release) Allocator.Error!void {
            try x.releases.append(gpa, release);
            if (x.running) |r| Parts.pauseForRelease(r.entry);
        }

        /// The release whose need goes out next.
        pub fn nextRelease(x: *const X) *const Release {
            return &x.releases.items[0];
        }

        /// The Group the releases' needs report for.
        pub fn releasing(x: *const X) Entry {
            return switch (x.state.awaiting_release.then) {
                .reply => |h| h.entry,
                .need => |n| n.reply.entry,
                .resume_worker => x.entry.?,
            };
        }

        /// Holds `reply`, a final or need reply under `ref`, behind any
        /// queued releases; false sends it now. A final reply sent now ends
        /// the exchange.
        pub fn hold(x: *X, ref: i64, reply: Held) bool {
            if (x.releases.items.len == 0) {
                if (x.state == .idle) x.entry = null;
                return false;
            }
            x.state = switch (x.state) {
                .idle => .{ .awaiting_release = .{ .ref = ref, .then = .{ .reply = reply } } },
                .awaiting_result => |w| .{ .awaiting_release = .{ .ref = ref, .then = .{ .need = .{ .need = w.need, .reply = reply } } } },
                .awaiting_trace, .awaiting_release => unreachable,
            };
            return true;
        }

        /// The Host acknowledged the first queued release.
        pub fn releaseAcknowledged(x: *X, gpa: Allocator) Acknowledged {
            var done = x.releases.orderedRemove(0);
            done.deinit(gpa);
            if (x.releases.items.len > 0) return .next_release;
            const w = x.state.awaiting_release;
            switch (w.then) {
                .resume_worker => {
                    x.state = .idle;
                    const entry = x.entry.?;
                    Parts.clearReleasePause(entry);
                    return .{ .resume_worker = .{ .entry = entry, .worker = x.worker } };
                },
                .reply => |h| {
                    if (x.entry) |e| Parts.clearReleasePause(e);
                    x.state = .idle;
                    x.entry = null;
                    return .{ .reply = h };
                },
                .need => |n| {
                    if (x.entry) |e| Parts.clearReleasePause(e);
                    x.state = .{ .awaiting_result = .{ .ref = w.ref, .need = n.need } };
                    return .{ .reply = n.reply };
                },
            }
        }
    };
}

fn isResult(frame: Frame, kind: Result) bool {
    return switch (frame) {
        .result => |r| r == kind,
        .input => false,
    };
}

fn resultOf(kind: Crossing) Result {
    return switch (kind) {
        .op => .op,
        .prop => .prop,
        .effect => .effect,
    };
}

// ------------------------------------------------------------------ tests

const testing = std.testing;

/// A Group with the machine's crossing-pause flags, and the calls made.
const TestGroup = struct {
    release_pause: bool = false,
    trace_pause: bool = false,
    calls: std.ArrayList([]const u8) = .empty,

    fn note(g: *TestGroup, call: []const u8) void {
        g.calls.append(testing.allocator, call) catch @panic("OOM");
    }
};

/// Stand-ins that own one allocation each, so a leak or a double free
/// fails; `tag` makes each its own type.
fn Owned(comptime tag: []const u8) type {
    _ = tag;
    return struct {
        const O = @This();
        bytes: []u8,
        entry: *TestGroup = undefined,
        kind: Crossing = .op,

        fn make(text: []const u8) O {
            return .{ .bytes = testing.allocator.dupe(u8, text) catch @panic("OOM") };
        }
        pub fn release(o: *O, gpa: Allocator) void {
            gpa.free(o.bytes);
        }
        pub fn deinit(o: *O, gpa: Allocator) void {
            gpa.free(o.bytes);
        }
    };
}

const TestX = Exchange(struct {
    pub const Entry = *TestGroup;
    pub const Need = Owned("need");
    pub const Answer = Owned("answer");
    pub const Held = Owned("held");
    pub const Release = Owned("release");
    pub const Bin = Owned("bin");
    pub const EffectStatus = enum { ok, failed, unknown };

    pub fn releasePaused(g: *TestGroup) bool {
        return g.release_pause;
    }
    pub fn pauseForRelease(g: *TestGroup) void {
        g.note("pauseForRelease");
        g.release_pause = true;
    }
    pub fn clearReleasePause(g: *TestGroup) void {
        g.note("clearReleasePause");
        g.release_pause = false;
    }
    pub fn tracePaused(g: *TestGroup) bool {
        return g.trace_pause;
    }
    pub fn clearTracePause(g: *TestGroup) void {
        g.note("clearTracePause");
        g.trace_pause = false;
    }
    pub fn beginAnswer(g: *TestGroup) void {
        g.note("beginAnswer");
    }
    pub fn answerTaken(g: *TestGroup) void {
        g.note("answerTaken");
    }
});

fn expectCalls(g: *TestGroup, want: []const []const u8) !void {
    defer g.calls.clearRetainingCapacity();
    try testing.expectEqual(want.len, g.calls.items.len);
    for (want, g.calls.items) |w, got| try testing.expectEqualStrings(w, got);
}

fn opNeed(g: *TestGroup, kind: Crossing) TestX.Need {
    var n = TestX.Need.make("need");
    n.entry = g;
    n.kind = kind;
    return n;
}

fn heldReply(g: *TestGroup, text: []const u8) TestX.Held {
    var h = TestX.Held.make(text);
    h.entry = g;
    return h;
}

test "a need's result resumes the worker that paused, and only that result is taken" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    try testing.expectEqual(Gate.dispatch, x.gate(7, .{ .result = .op }, .json));
    try testing.expectEqual(Gate{ .refuse = .not_open }, x.gate(7, .{ .result = .op }, .binary));

    x.start(&g, .work);
    try testing.expect(x.canDefer(.op) and x.canDefer(.effect) and !x.canDefer(.prop));
    x.cross(opNeed(&g, .op));
    try testing.expectEqual(TestX.Pause.need, x.pause(7));
    x.stop(gpa);
    try testing.expect(x.open() and !x.canDefer(.op));

    // JSON: a result under another ref is an input; the kind is checked last.
    try testing.expectEqual(Gate{ .admit = 7 }, x.gate(8, .{ .result = .op }, .json));
    try testing.expectEqual(Gate{ .refuse = .kind_mismatch }, x.gate(7, .{ .result = .prop }, .json));
    try testing.expectEqual(Gate{ .refuse = .result_pending }, x.gate(7, .{ .result = .release }, .json));
    try testing.expectEqual(Gate{ .refuse = .result_pending }, x.gate(7, .input, .json));
    // Binary: the ref is checked first, and an input is always considered.
    try testing.expectEqual(Gate{ .refuse = .wrong_ref }, x.gate(8, .{ .result = .op }, .binary));
    try testing.expectEqual(Gate{ .admit = 7 }, x.gate(7, .input, .binary));
    try testing.expectEqual(Gate{ .result = .op }, x.gate(7, .{ .result = .op }, .binary));

    const r = x.answered(gpa, TestX.Answer.make("41"));
    try testing.expectEqual(TestX.Resume{ .entry = &g, .worker = .work }, r);
    try expectCalls(&g, &.{"beginAnswer"});
    try testing.expect(!x.open());
    x.start(r.entry, r.worker);
    var answer = x.takeAnswer().?;
    answer.release(gpa);
    try testing.expectEqual(@as(?TestX.Answer, null), x.takeAnswer());
    try expectCalls(&g, &.{"answerTaken"});
    x.stop(gpa);
}

test "a Trace pause takes only trace-result, which no binary result is" {
    const gpa = testing.allocator;
    var g: TestGroup = .{ .trace_pause = true };
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    x.start(&g, .pump);
    try testing.expectEqual(TestX.Pause.trace, x.pause(3));
    x.stop(gpa);
    try testing.expectEqual(Gate{ .admit = 3 }, x.gate(4, .{ .result = .op }, .json));
    try testing.expectEqual(Gate{ .refuse = .trace_pending }, x.gate(3, .{ .result = .op }, .json));
    try testing.expectEqual(Gate.trace_result, x.gate(3, .{ .result = .trace }, .json));
    try testing.expectEqual(Gate{ .refuse = .wrong_ref }, x.gate(4, .{ .result = .op }, .binary));
    try testing.expectEqual(Gate{ .refuse = .trace_pending }, x.gate(3, .{ .result = .op }, .binary));
    try testing.expectEqual(Gate{ .admit = 3 }, x.gate(3, .input, .binary));
    try testing.expectEqual(TestX.Resume{ .entry = &g, .worker = .pump }, x.traceTaken());
    try expectCalls(&g, &.{ "clearTracePause", "beginAnswer" });
    try testing.expect(!x.open() and !g.trace_pause);
}

test "a final reply waits for each release, then ends the exchange" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    // Nothing queued: the reply goes now, and the exchange ends.
    x.start(&g, .pump);
    x.stop(gpa);
    var now = heldReply(&g, "now");
    try testing.expect(!x.hold(5, now));
    now.deinit(gpa);
    try testing.expectEqual(@as(?*TestGroup, null), x.entry);

    // Queued between workers, a release pauses no worker.
    try x.queue(gpa, TestX.Release.make("a"));
    try x.queue(gpa, TestX.Release.make("b"));
    try expectCalls(&g, &.{});
    x.start(&g, .pump);
    x.stop(gpa);
    try testing.expect(x.hold(5, heldReply(&g, "final")));
    try testing.expectEqual(&g, x.releasing());
    try testing.expectEqualStrings("a", x.nextRelease().bytes);
    try testing.expectEqual(Gate{ .admit = 5 }, x.gate(5, .{ .result = .op }, .json));
    try testing.expectEqual(Gate{ .admit = 5 }, x.gate(6, .{ .result = .release }, .json));
    try testing.expectEqual(Gate{ .refuse = .release_pending }, x.gate(5, .{ .result = .op }, .binary));
    try testing.expectEqual(Gate{ .admit = 5 }, x.gate(6, .input, .binary));
    try testing.expectEqual(Gate.release_result, x.gate(5, .{ .result = .release }, .binary));
    try testing.expectEqual(TestX.Acknowledged.next_release, x.releaseAcknowledged(gpa));
    try testing.expectEqualStrings("b", x.nextRelease().bytes);
    var sent = x.releaseAcknowledged(gpa).reply;
    defer sent.deinit(gpa);
    try testing.expectEqualStrings("final", sent.bytes);
    try expectCalls(&g, &.{"clearReleasePause"});
    try testing.expect(!x.open() and x.entry == null);
}

test "a need reply held behind a release leaves its need open" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    try x.queue(gpa, TestX.Release.make("a"));
    x.start(&g, .pump);
    x.cross(opNeed(&g, .effect));
    try testing.expectEqual(TestX.Pause.need, x.pause(9));
    x.stop(gpa);
    try testing.expectEqual(Crossing.effect, x.openNeed().kind);
    try testing.expect(x.hold(9, heldReply(&g, "need")));
    var sent = x.releaseAcknowledged(gpa).reply;
    sent.deinit(gpa);
    try expectCalls(&g, &.{"clearReleasePause"});
    try testing.expectEqual(Gate{ .result = .effect }, x.gate(9, .{ .result = .effect }, .json));
    try testing.expectEqual(&g, x.entry.?);
    try testing.expectEqual(TestX.Resume{ .entry = &g, .worker = .pump }, x.effectAnswered(gpa, .ok));
    x.start(&g, .pump);
    try testing.expectEqual(@as(?TestX.EffectStatus, .ok), x.takeEffectAnswer());
    x.stop(gpa);
}

test "a worker paused only for a release goes on without an answer" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    x.start(&g, .work);
    try testing.expect(!x.releasePaused());
    try x.queue(gpa, TestX.Release.make("a"));
    try expectCalls(&g, &.{"pauseForRelease"});
    try testing.expect(x.releasePaused());
    try testing.expectEqual(TestX.Pause.release, x.pause(2));
    x.stop(gpa);
    try testing.expectEqual(&g, x.releasing());
    const r = x.releaseAcknowledged(gpa).resume_worker;
    try testing.expectEqual(TestX.Resume{ .entry = &g, .worker = .work }, r);
    // No `beginAnswer`: the crossing it paused at was never asked.
    try expectCalls(&g, &.{"clearReleasePause"});
    try testing.expect(!x.open() and x.entry == &g);
}

test "a release goes inline only to a Group whose worker has run" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    defer x.deinit(gpa);
    try testing.expectEqual(TestX.Route.queue, x.route(false));
    try testing.expectEqual(TestX.Route.drop, x.route(true));
    x.start(&g, .pump);
    try testing.expectEqual(TestX.Route{ .inline_to = &g }, x.route(true));
    x.stop(gpa);
}

test "paused admission checks the ref, then the Group, then the message" {
    var g: TestGroup = .{};
    var h: TestGroup = .{};
    const P = Paused(*TestGroup);
    const none: P = .{ .ref = 4, .entry = null, .worker = .pump };
    try testing.expectEqual(P.Admission{ .refuse = .reserved_ref }, none.admission(4, &g, .admitted));
    try testing.expectEqual(P.Admission{ .refuse = .no_worker }, none.admission(5, &g, .admitted));
    const p: P = .{ .ref = 4, .entry = &g, .worker = .pump };
    try testing.expectEqual(P.Admission{ .refuse = .other_group }, p.admission(5, &h, .admitted));
    try testing.expectEqual(P.Admission{ .refuse = .other_group }, p.admission(5, null, .worker));
    try testing.expectEqual(P.Admission{ .refuse = .not_admitted }, p.admission(5, &g, .other));
    try testing.expectEqual(P.Admission{ .refuse_worker = &g }, p.admission(5, &g, .worker));
    try testing.expectEqual(P.Admission{ .admit = &g }, p.admission(5, &g, .admitted));
}

test "an open exchange frees what it holds" {
    const gpa = testing.allocator;
    var g: TestGroup = .{};
    defer g.calls.deinit(gpa);
    var x: TestX = .{};
    try x.queue(gpa, TestX.Release.make("a"));
    x.start(&g, .pump);
    x.cross(opNeed(&g, .op));
    _ = x.pause(1);
    x.stop(gpa);
    try testing.expect(x.hold(1, heldReply(&g, "need")));
    x.answer = TestX.Answer.make("stale");
    x.bin = TestX.Bin.make("delivery");
    x.deinit(gpa);
    try testing.expect(!x.open());
}

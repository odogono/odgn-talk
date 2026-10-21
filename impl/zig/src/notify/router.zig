//! The Notification router (chapter 7, Store Notification routing; chapter
//! 10, Store Notification checkpoints): the Host component that holds
//! `store` watches, routes each commit's changed keys to them as
//! Notifications, retries what a full mailbox refused after each Pump, and
//! saves and restores its routing beside a Group's save. It is Host code
//! over talk.h, as talk.go's `notify` package is over talk.go, and the Core
//! takes no part in it.
const std = @import("std");
const sorting = @import("../sort.zig");
const builtin = @import("builtin");
const talk = @import("../talk.zig");
const model = @import("../value.zig");
const encoding = @import("../encoding.zig");
const costs = @import("../machine/costs.zig");
const machine = @import("../machine/machine.zig");

const Value = model.Value;
const Group = talk.Group;
const Allocator = std.mem.Allocator;
const allocator = @import("../process_allocator.zig").allocator;

pub const WatchLimits = extern struct { watches: i64, watch_size: i64, pending: i64, pending_size: i64 };

pub const Options = extern struct {
    context: ?*anyopaque = null,
    /// Told after each admitted Notification; must not call the router.
    admitted: ?*const fn (context: ?*anyopaque, g: *Group) callconv(.c) void = null,
    limits: *const fn (context: ?*anyopaque, store: [*]const u8, len: usize) callconv(.c) WatchLimits,
    /// The Store's revision, read under its synchronization, borrowed until
    /// the next call.
    revision: *const fn (context: ?*anyopaque, store: [*]const u8, len: usize, out: *[*]const u8, out_len: *usize) callconv(.c) void,
    /// The Store a `store` Grant's binding names.
    store_of: *const fn (context: ?*anyopaque, binding: ?*anyopaque, out: *[*]const u8, out_len: *usize) callconv(.c) bool,
};

/// A pending ordinary Notification: its changed keys under the prefix.
const Keys = [][]u8;

const Watch = struct {
    group: *Group,
    script: []u8,
    grant: []u8,
    name: []u8,
    store: []u8,
    prefix: []u8,
    message: []u8,
    /// Pending ordinary Notifications, oldest first.
    pending: std.ArrayList(Keys) = .empty,
    /// Whether its one pending work is a Reconciliation Marker.
    resync: bool = false,

    fn hasWork(w: *const Watch) bool {
        return w.resync or w.pending.items.len > 0;
    }
};

/// A Group's place among the router's Groups, and the watch its last
/// retry round started at.
const Place = struct { group: *Group, retry: ?[3][]u8 = null };

pub const Router = struct {
    gpa: Allocator,
    options: Options,
    watches: std.ArrayList(*Watch) = .empty,
    groups: std.ArrayList(Place) = .empty,

    pub fn init(gpa: Allocator, options: Options) Router {
        return .{ .gpa = gpa, .options = options };
    }

    pub fn deinit(r: *Router) void {
        for (r.watches.items) |w| r.destroyWatch(w);
        r.watches.deinit(r.gpa);
        for (r.groups.items) |*p| r.dropRetry(p);
        r.groups.deinit(r.gpa);
    }

    fn destroyWatch(r: *Router, w: *Watch) void {
        r.clearPending(w);
        w.pending.deinit(r.gpa);
        inline for (.{ "script", "grant", "name", "store", "prefix", "message" }) |f| r.gpa.free(@field(w, f));
        r.gpa.destroy(w);
    }

    fn clearPending(r: *Router, w: *Watch) void {
        for (w.pending.items) |keys| freeKeys(r.gpa, keys);
        w.pending.clearRetainingCapacity();
    }

    fn dropRetry(r: *Router, p: *Place) void {
        if (p.retry) |k| for (k) |x| r.gpa.free(x);
        p.retry = null;
    }

    fn placeOf(r: *Router, g: *Group) ?usize {
        for (r.groups.items, 0..) |p, i| if (p.group == g) return i;
        return null;
    }

    /// A Group that holds no watches loses its place.
    fn prune(r: *Router) void {
        var i: usize = 0;
        while (i < r.groups.items.len) {
            const g = r.groups.items[i].group;
            const holds = for (r.watches.items) |w| {
                if (w.group == g) break true;
            } else false;
            if (holds) {
                i += 1;
                continue;
            }
            r.dropRetry(&r.groups.items[i]);
            _ = r.groups.orderedRemove(i);
        }
    }

    // ------------------------------------------------------------ order

    /// The order of watches: by Group, in the order the router first
    /// registered a watch from it; by Script, in its Group's load order;
    /// then by named Grant and watch name, in code-point order.
    fn sort(r: *Router) void {
        sorting.stable(*Watch, r.watches.items, r, struct {
            fn less(router: *Router, x: *Watch, y: *Watch) bool {
                const gx = router.placeOf(x.group) orelse 0;
                const gy = router.placeOf(y.group) orelse 0;
                if (gx != gy) return gx < gy;
                const sx = loadIndex(x.group, x.script);
                const sy = loadIndex(y.group, y.script);
                if (sx != sy) return sx < sy;
                switch (std.mem.order(u8, x.grant, y.grant)) {
                    .lt => return true,
                    .gt => return false,
                    .eq => return std.mem.order(u8, x.name, y.name) == .lt,
                }
            }
        }.less);
    }

    fn loadIndex(g: *Group, script: []const u8) usize {
        var names: [*]const talk.Id = undefined;
        const n = talk.talk_script_names(g, &names);
        for (names[0..n], 0..) |id, i| if (std.mem.eql(u8, id.data[0..id.len], script)) return i;
        return n;
    }

    fn find(r: *Router, g: *Group, script: []const u8, grant: []const u8, name: []const u8) ?usize {
        for (r.watches.items, 0..) |w, i| if (w.group == g and std.mem.eql(u8, w.script, script) and std.mem.eql(u8, w.grant, grant) and std.mem.eql(u8, w.name, name)) return i;
        return null;
    }

    // ------------------------------------------------------------ sizes

    fn textSize(s: []const u8) u64 {
        const v = model.text(allocator, s) catch return s.len;
        defer v.release();
        return costs.size(v);
    }

    fn watchSize(w: *const Watch) u64 {
        return textSize(w.name) + textSize(w.prefix) + textSize(w.message);
    }

    /// A payload map: `{grant, watch, prefix, keys, resync}`.
    fn payload(w: *const Watch, keys: []const []const u8, resync: bool) !*Value {
        const items = try allocator.alloc(*Value, keys.len);
        var made: usize = 0;
        defer {
            for (items[0..made]) |v| v.release();
            allocator.free(items);
        }
        for (keys) |k| {
            items[made] = try model.text(allocator, k);
            made += 1;
        }
        const parts = [_]*Value{
            try model.text(allocator, w.grant),
            try model.text(allocator, w.name),
            try model.text(allocator, w.prefix),
            try model.list(allocator, items),
            try model.scalar(allocator, .{ .bool = resync }),
        };
        defer for (parts) |v| v.release();
        return model.map(allocator, &.{ .{ .key = "grant", .value = parts[0] }, .{ .key = "watch", .value = parts[1] }, .{ .key = "prefix", .value = parts[2] }, .{ .key = "keys", .value = parts[3] }, .{ .key = "resync", .value = parts[4] } });
    }

    fn payloadSize(w: *const Watch, keys: []const []const u8, resync: bool) u64 {
        const v = payload(w, keys, resync) catch return 0;
        defer v.release();
        return costs.size(v);
    }

    /// A Store's watch and pending totals, each watch reserving its marker;
    /// `skip` leaves out one watch, and `extra` adds one.
    const Totals = struct { watches: u64 = 0, watch_size: u64 = 0, pending: u64 = 0, pending_size: u64 = 0 };

    fn totals(r: *Router, store: []const u8, skip: ?*const Watch, extra: ?*const Watch) Totals {
        var t: Totals = .{};
        for (r.watches.items) |w| if (w != skip and std.mem.eql(u8, w.store, store)) add(&t, w);
        if (extra) |w| add(&t, w);
        return t;
    }

    fn add(t: *Totals, w: *const Watch) void {
        t.watches += 1;
        t.watch_size += watchSize(w);
        t.pending += 1;
        t.pending_size += payloadSize(w, &.{}, true);
        for (w.pending.items) |keys| {
            t.pending += 1;
            t.pending_size += payloadSize(w, keys, false);
        }
    }

    fn limitsOf(r: *Router, store: []const u8) WatchLimits {
        return r.options.limits(r.options.context, store.ptr, store.len);
    }

    fn storeOf(r: *Router, binding: ?*anyopaque) ?[]const u8 {
        var p: [*]const u8 = undefined;
        var n: usize = 0;
        if (!r.options.store_of(r.options.context, binding, &p, &n)) return null;
        return p[0..n];
    }

    // ------------------------------------------------------------ watching

    pub const Refusal = enum { watches, size, pending };

    /// Registers a watch, or replaces one with other parameters. Null when
    /// it took effect; otherwise the first limit it would pass.
    pub fn watch(r: *Router, call: *const talk.Call, name: []const u8, prefix: []const u8, message: []const u8) !?Refusal {
        const g = talk.talk_call_group(call) orelse return null;
        const store = r.storeOf(call.binding) orelse return null;
        if (r.find(g, call.script, call.grant, name)) |i| {
            const old = r.watches.items[i];
            // The same parameters change nothing, and keep its pending work.
            if (std.mem.eql(u8, old.prefix, prefix) and std.mem.eql(u8, old.message, message) and std.mem.eql(u8, old.store, store)) return null;
        }
        const w = try r.gpa.create(Watch);
        w.* = .{ .group = g, .script = try r.gpa.dupe(u8, call.script), .grant = try r.gpa.dupe(u8, call.grant), .name = try r.gpa.dupe(u8, name), .store = try r.gpa.dupe(u8, store), .prefix = try r.gpa.dupe(u8, prefix), .message = try r.gpa.dupe(u8, message) };
        errdefer r.destroyWatch(w);
        const replaced: ?usize = r.find(g, call.script, call.grant, name);
        const t = r.totals(store, if (replaced) |i| r.watches.items[i] else null, w);
        const l = r.limitsOf(store);
        if (t.watches > clamp(l.watches)) {
            r.destroyWatch(w);
            return .watches;
        }
        if (t.watch_size > clamp(l.watch_size)) {
            r.destroyWatch(w);
            return .size;
        }
        if (t.pending > clamp(l.pending) or t.pending_size > clamp(l.pending_size)) {
            r.destroyWatch(w);
            return .pending;
        }
        if (replaced) |i| {
            // A replaced watch keeps its place, and loses its pending work.
            r.destroyWatch(r.watches.items[i]);
            r.watches.items[i] = w;
        } else {
            if (r.placeOf(g) == null) try r.groups.append(r.gpa, .{ .group = g });
            try r.watches.append(r.gpa, w);
        }
        r.sort();
        return null;
    }

    fn clamp(x: i64) u64 {
        return if (x < 0) 0 else @intCast(x);
    }

    pub fn unwatch(r: *Router, call: *const talk.Call, name: []const u8) void {
        const g = talk.talk_call_group(call) orelse return;
        const i = r.find(g, call.script, call.grant, name) orelse return;
        r.destroyWatch(r.watches.orderedRemove(i));
        r.prune();
    }

    /// A Grant's release: every watch its owner holds goes.
    pub fn release(r: *Router, g: ?*Group, script: []const u8, grant: []const u8) void {
        var i: usize = 0;
        while (i < r.watches.items.len) {
            const w = r.watches.items[i];
            if (w.group == g and std.mem.eql(u8, w.script, script) and std.mem.eql(u8, w.grant, grant)) {
                r.destroyWatch(r.watches.orderedRemove(i));
            } else i += 1;
        }
        r.prune();
    }

    pub fn detach(r: *Router, g: *Group) void {
        var i: usize = 0;
        while (i < r.watches.items.len) {
            if (r.watches.items[i].group == g) {
                r.destroyWatch(r.watches.orderedRemove(i));
            } else i += 1;
        }
        r.prune();
    }

    // ------------------------------------------------------------ routing

    const Admission = enum { admitted, full, refused };

    fn deliver(r: *Router, w: *Watch, keys: []const []const u8, resync: bool) !Admission {
        const script = talk.talk_group_script(w.group, w.script.ptr, w.script.len) orelse return .refused;
        const arg = try payload(w, keys, resync);
        defer arg.release();
        const args = [_]*Value{arg};
        const m: talk.Message = .{ .name = w.message.ptr, .name_len = w.message.len, .args = &args, .args_len = 1 };
        return switch (talk.talk_script_deliver(script, &m, null)) {
            .ok => {
                if (r.options.admitted) |f| f(r.options.context, w.group);
                return .admitted;
            },
            .err_mailbox_full => .full,
            else => .refused,
        };
    }

    /// Routes a commit's changed keys to the Store's watches, in the order
    /// of watches. The Host calls it under the Store's synchronization,
    /// once the commit is applied.
    pub fn commit(r: *Router, store: []const u8, keys_changed: []const []const u8) !void {
        if (keys_changed.len == 0) return;
        const sorted = try r.gpa.dupe([]const u8, keys_changed);
        defer r.gpa.free(sorted);
        sorting.stable([]const u8, sorted, {}, lessText);
        var i: usize = 0;
        while (i < r.watches.items.len) {
            const w = r.watches.items[i];
            i += 1;
            if (!std.mem.eql(u8, w.store, store)) continue;
            var keys: std.ArrayList([]u8) = .empty;
            errdefer freeKeys(r.gpa, keys.items);
            for (sorted, 0..) |k, n| {
                if (!std.mem.startsWith(u8, k, w.prefix)) continue;
                if (n > 0 and std.mem.eql(u8, k, sorted[n - 1])) continue;
                try keys.append(r.gpa, try r.gpa.dupe(u8, k));
            }
            if (keys.items.len == 0) {
                keys.deinit(r.gpa);
                continue;
            }
            const owned = try keys.toOwnedSlice(r.gpa);
            // A resyncing watch's marker already covers the commit.
            if (w.resync) {
                freeKeys(r.gpa, owned);
                continue;
            }
            if (w.pending.items.len == 0) switch (try r.deliver(w, @ptrCast(owned), false)) {
                .admitted => {
                    freeKeys(r.gpa, owned);
                    continue;
                },
                .full => {},
                .refused => {
                    freeKeys(r.gpa, owned);
                    i -= 1;
                    r.destroyWatch(r.watches.orderedRemove(i));
                    continue;
                },
            };
            try r.hold(w, owned);
        }
        r.prune();
    }

    /// Holds a Notification as pending work, or under overload makes the
    /// watch resyncing in place of its pending Notifications.
    fn hold(r: *Router, w: *Watch, keys: Keys) !void {
        try w.pending.append(r.gpa, keys);
        const t = r.totals(w.store, null, null);
        const l = r.limitsOf(w.store);
        if (t.pending > clamp(l.pending) or t.pending_size > clamp(l.pending_size)) {
            r.clearPending(w);
            w.resync = true;
        }
    }

    /// After a Pump of `g` returns: a retry round over its watches with
    /// pending work, starting after the one that started its last round.
    /// True while it still has pending work.
    pub fn pumped(r: *Router, g: *Group) !bool {
        const place = r.placeOf(g) orelse return false;
        var mine: std.ArrayList(*Watch) = .empty;
        defer mine.deinit(r.gpa);
        for (r.watches.items) |w| if (w.group == g) try mine.append(r.gpa, w);
        if (mine.items.len == 0) return false;
        var start: usize = 0;
        if (r.groups.items[place].retry) |k| {
            for (mine.items, 0..) |w, i| if (std.mem.eql(u8, w.script, k[0]) and std.mem.eql(u8, w.grant, k[1]) and std.mem.eql(u8, w.name, k[2])) {
                start = i + 1;
                break;
            };
        }
        var first = true;
        var removed: std.ArrayList(*Watch) = .empty;
        defer removed.deinit(r.gpa);
        for (0..mine.items.len) |n| {
            const w = mine.items[(start + n) % mine.items.len];
            if (!w.hasWork()) continue;
            if (first) {
                first = false;
                r.dropRetry(&r.groups.items[place]);
                r.groups.items[place].retry = .{ try r.gpa.dupe(u8, w.script), try r.gpa.dupe(u8, w.grant), try r.gpa.dupe(u8, w.name) };
            }
            if (w.resync) {
                switch (try r.deliver(w, &.{}, true)) {
                    .admitted => w.resync = false,
                    .full => {},
                    .refused => try removed.append(r.gpa, w),
                }
                continue;
            }
            while (w.pending.items.len > 0) {
                switch (try r.deliver(w, @ptrCast(w.pending.items[0]), false)) {
                    .admitted => freeKeys(r.gpa, w.pending.orderedRemove(0)),
                    .full => break,
                    .refused => {
                        try removed.append(r.gpa, w);
                        break;
                    },
                }
            }
        }
        for (removed.items) |w| if (std.mem.indexOfScalar(*Watch, r.watches.items, w)) |i| r.destroyWatch(r.watches.orderedRemove(i));
        r.prune();
        for (r.watches.items) |w| if (w.group == g and w.hasWork()) return true;
        return false;
    }

    // ------------------------------------------------------------ checkpoints

    const magic = "NTZR";
    const version: u32 = 1;

    /// A checkpoint: the Group's save and the routing state that goes with
    /// it, tied by the save's digest.
    pub fn save(r: *Router, g: *Group) (Allocator.Error || error{EffectsPending})![]u8 {
        var saved: talk.Buffer = .{};
        switch (talk.talk_save(g, &saved)) {
            .ok => {},
            .effects_pending => return error.EffectsPending,
            else => return error.OutOfMemory,
        }
        defer talk.talk_owned_bytes_release(&saved);
        const bytes = saved.data.?[0..saved.len];
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(r.gpa);
        try out.appendSlice(r.gpa, magic);
        try putInt(r.gpa, &out, version);
        try putStr(r.gpa, &out, bytes);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
        try out.appendSlice(r.gpa, &digest);
        // The Group's retry position.
        const place = r.placeOf(g);
        const retry = if (place) |p| r.groups.items[p].retry else null;
        try out.append(r.gpa, @intFromBool(retry != null));
        if (retry) |k| for (k) |x| try putStr(r.gpa, &out, x);
        var stores: std.ArrayList([]const u8) = .empty;
        defer stores.deinit(r.gpa);
        var count: u32 = 0;
        for (r.watches.items) |w| if (w.group == g) {
            count += 1;
            for (stores.items) |s| {
                if (std.mem.eql(u8, s, w.store)) break;
            } else try stores.append(r.gpa, w.store);
        };
        try putInt(r.gpa, &out, count);
        for (r.watches.items) |w| if (w.group == g) {
            inline for (.{ "script", "grant", "name", "store", "prefix", "message" }) |f| try putStr(r.gpa, &out, @field(w, f));
            try out.append(r.gpa, @intFromBool(w.resync));
            try putInt(r.gpa, &out, @intCast(w.pending.items.len));
            for (w.pending.items) |keys| {
                try putInt(r.gpa, &out, @intCast(keys.len));
                for (keys) |k| try putStr(r.gpa, &out, k);
            }
        };
        try putInt(r.gpa, &out, @intCast(stores.items.len));
        for (stores.items) |s| {
            try putStr(r.gpa, &out, s);
            try putStr(r.gpa, &out, r.revisionOf(s));
        }
        return out.toOwnedSlice(r.gpa);
    }

    fn revisionOf(r: *Router, store: []const u8) []const u8 {
        var p: [*]const u8 = undefined;
        var n: usize = 0;
        r.options.revision(r.options.context, store.ptr, store.len, &p, &n);
        return p[0..n];
    }

    /// Which watches a restore registered again, dropped and resynced, each
    /// `<script>.<grant>.<watch>`, in the order of watches.
    pub const Routing = struct {
        restored: std.ArrayList([]u8) = .empty,
        dropped: std.ArrayList([]u8) = .empty,
        resynced: std.ArrayList([]u8) = .empty,

        pub fn deinit(x: *Routing, gpa: Allocator) void {
            inline for (.{ &x.restored, &x.dropped, &x.resynced }) |l| {
                for (l.items) |s| gpa.free(s);
                l.deinit(gpa);
            }
        }
    };

    pub const Restored = struct { group: *Group, result: *talk.RestoreResult, routing: Routing };

    const Recorded = struct { script: []const u8, grant: []const u8, name: []const u8, store: []const u8, prefix: []const u8, message: []const u8, resync: bool, pending: []const []const []const u8 };

    /// Restores a checkpoint: the Group through `Core.Restore`, then, for a
    /// full restore, each recorded watch whose Grant is still bound to its
    /// Store, with its pending work; a Store whose revision moved resyncs
    /// its watches, whose markers are admitted at once.
    pub fn restore(r: *Router, core: *talk.Core, checkpoint: []const u8, options: *const talk.RestoreOptions, code: *talk.HostErrorCode) !?Restored {
        var arena: std.heap.ArenaAllocator = .init(r.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var in: Reader = .{ .bytes = checkpoint };
        const parsed = in.checkpoint(a) catch {
            code.* = .invalid_checkpoint;
            return null;
        };
        var group: ?*Group = null;
        var result: ?*talk.RestoreResult = null;
        code.* = talk.talk_restore(core, parsed.save.ptr, parsed.save.len, options, &group, &result);
        if (code.* != .ok) return null;
        var routing: Routing = .{};
        errdefer routing.deinit(r.gpa);
        const g = group.?;
        if (talk.talk_restore_result_variables_only(result.?)) return .{ .group = g, .result = result.?, .routing = routing };
        var made: std.ArrayList(*Watch) = .empty;
        defer made.deinit(r.gpa);
        for (parsed.watches) |x| {
            const label = try std.fmt.allocPrint(r.gpa, "{s}.{s}.{s}", .{ x.script, x.grant, x.name });
            if (!r.boundTo(g, x.script, x.grant, x.store)) {
                try routing.dropped.append(r.gpa, label);
                continue;
            }
            try routing.restored.append(r.gpa, label);
            const w = try r.gpa.create(Watch);
            w.* = .{ .group = g, .script = try r.gpa.dupe(u8, x.script), .grant = try r.gpa.dupe(u8, x.grant), .name = try r.gpa.dupe(u8, x.name), .store = try r.gpa.dupe(u8, x.store), .prefix = try r.gpa.dupe(u8, x.prefix), .message = try r.gpa.dupe(u8, x.message), .resync = x.resync };
            for (x.pending) |keys| {
                const owned = try r.gpa.alloc([]u8, keys.len);
                for (keys, owned) |k, *o| o.* = try r.gpa.dupe(u8, k);
                try w.pending.append(r.gpa, owned);
            }
            if (r.placeOf(g) == null) try r.groups.append(r.gpa, .{ .group = g });
            try r.watches.append(r.gpa, w);
            try made.append(r.gpa, w);
        }
        r.sort();
        if (parsed.retry) |k| if (r.placeOf(g)) |p| {
            r.groups.items[p].retry = .{ try r.gpa.dupe(u8, k[0]), try r.gpa.dupe(u8, k[1]), try r.gpa.dupe(u8, k[2]) };
        };
        // Stores that changed since the checkpoint resync their watches.
        for (r.watches.items) |w| {
            if (std.mem.indexOfScalar(*Watch, made.items, w) == null) continue;
            const recorded = for (parsed.revisions) |rev| {
                if (std.mem.eql(u8, rev[0], w.store)) break rev[1];
            } else "";
            if (std.mem.eql(u8, recorded, r.revisionOf(w.store))) continue;
            r.clearPending(w);
            w.resync = true;
            try routing.resynced.append(r.gpa, try std.fmt.allocPrint(r.gpa, "{s}.{s}.{s}", .{ w.script, w.grant, w.name }));
            switch (try r.deliver(w, &.{}, true)) {
                .admitted => w.resync = false,
                .full, .refused => {},
            }
        }
        return .{ .group = g, .result = result.?, .routing = routing };
    }

    /// Whether the restored Script's named Grant is a `store` Grant, kept,
    /// and bound to the Store.
    fn boundTo(r: *Router, g: *Group, script_name: []const u8, grant: []const u8, store: []const u8) bool {
        const s = g.group.script(script_name) orelse return false;
        const sg = s.grant(grant) orelse return false;
        if (sg.revoked or sg.disabled) return false;
        const watches = for (sg.grant.capability.operations) |op| {
            if (std.mem.eql(u8, op.name, "watch")) break true;
        } else false;
        if (!watches) return false;
        const bound = r.storeOf(sg.grant.binding) orelse return false;
        return std.mem.eql(u8, bound, store);
    }
};

fn lessText(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

fn freeKeys(gpa: Allocator, keys: []const []u8) void {
    for (keys) |k| gpa.free(k);
    gpa.free(keys);
}

fn putInt(gpa: Allocator, out: *std.ArrayList(u8), n: u32) !void {
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, n, .little);
    try out.appendSlice(gpa, &b);
}

fn putStr(gpa: Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    try putInt(gpa, out, @intCast(s.len));
    try out.appendSlice(gpa, s);
}

/// A checkpoint being read; anything short or impossible is an error.
const Reader = struct {
    bytes: []const u8,
    pos: usize = 0,

    const Parsed = struct { save: []const u8, retry: ?[3][]const u8, watches: []Router.Recorded, revisions: [][2][]const u8 };

    fn take(x: *Reader, n: usize) ![]const u8 {
        if (x.bytes.len - x.pos < n) return error.Invalid;
        x.pos += n;
        return x.bytes[x.pos - n .. x.pos];
    }

    fn int(x: *Reader) !u32 {
        return std.mem.readInt(u32, (try x.take(4))[0..4], .little);
    }

    fn str(x: *Reader) ![]const u8 {
        return x.take(try x.int());
    }

    fn flag(x: *Reader) !bool {
        const b = (try x.take(1))[0];
        if (b > 1) return error.Invalid;
        return b == 1;
    }

    fn checkpoint(x: *Reader, a: Allocator) !Parsed {
        if (!std.mem.eql(u8, try x.take(4), Router.magic)) return error.Invalid;
        if (try x.int() != Router.version) return error.Invalid;
        const saved = try x.str();
        const digest = try x.take(32);
        var check: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(saved, &check, .{});
        if (!std.mem.eql(u8, digest, &check)) return error.Invalid;
        const retry: ?[3][]const u8 = if (try x.flag()) .{ try x.str(), try x.str(), try x.str() } else null;
        const n = try x.int();
        if (n > x.bytes.len) return error.Invalid;
        const watches = try a.alloc(Router.Recorded, n);
        for (watches) |*w| {
            w.* = .{ .script = try x.str(), .grant = try x.str(), .name = try x.str(), .store = try x.str(), .prefix = try x.str(), .message = try x.str(), .resync = try x.flag(), .pending = &.{} };
            const p = try x.int();
            if (p > x.bytes.len) return error.Invalid;
            const pending = try a.alloc([]const []const u8, p);
            for (pending) |*keys| {
                const k = try x.int();
                if (k > x.bytes.len) return error.Invalid;
                const list = try a.alloc([]const u8, k);
                for (list) |*s| s.* = try x.str();
                keys.* = list;
            }
            w.pending = pending;
        }
        const s = try x.int();
        if (s > x.bytes.len) return error.Invalid;
        const revisions = try a.alloc([2][]const u8, s);
        for (revisions) |*rev| rev.* = .{ try x.str(), try x.str() };
        if (x.pos != x.bytes.len) return error.Invalid;
        return .{ .save = saved, .retry = retry, .watches = watches, .revisions = revisions };
    }
};

/// Whether a key's committed value changed, by the bytes of the Value
/// Encoding; Nothing, or null, also stands for a missing key.
pub fn changed(before: ?*const Value, after: ?*const Value) bool {
    const x = absent(before);
    const y = absent(after);
    if (x and y) return false;
    if (x != y) return true;
    const ex = encoding.encode(allocator, before.?) catch return true;
    defer allocator.free(ex);
    const ey = encoding.encode(allocator, after.?) catch return true;
    defer allocator.free(ey);
    return !std.mem.eql(u8, ex, ey);
}

fn absent(v: ?*const Value) bool {
    const x = v orelse return true;
    return x.data == .nothing;
}

// ---------------------------------------------------------------- talk.h

pub const RoutingResult = extern struct {
    restored: [*]const talk.Id,
    restored_len: usize,
    dropped: [*]const talk.Id,
    dropped_len: usize,
    resynced: [*]const talk.Id,
    resynced_len: usize,
};

const RoutingHeld = struct { view: RoutingResult, routing: Router.Routing, ids: []talk.Id };

export fn talk_router_new(o: *const Options) ?*Router {
    const r = allocator.create(Router) catch return null;
    r.* = .init(allocator, o.*);
    return r;
}

export fn talk_router_free(r: ?*Router) void {
    const x = r orelse return;
    x.deinit();
    allocator.destroy(x);
}

export fn talk_router_watch(r: *Router, c: *const talk.Call, name: ?[*]const u8, name_len: usize, prefix: ?[*]const u8, prefix_len: usize, message: ?[*]const u8, message_len: usize, refused: *talk.ScriptError) bool {
    refused.* = .{ .code = null, .code_len = 0, .message = null, .message_len = 0, .data = null };
    const refusal = r.watch(c, text(name, name_len), text(prefix, prefix_len), text(message, message_len)) catch return false;
    const limit = refusal orelse return true;
    const word = @tagName(limit);
    const v = model.text(allocator, word) catch return false;
    defer v.release();
    const data = model.map(allocator, &.{.{ .key = "limit", .value = v }}) catch return false;
    refused.* = .{ .code = "watch limit", .code_len = 11, .message = null, .message_len = 0, .data = data };
    return false;
}

fn text(p: ?[*]const u8, n: usize) []const u8 {
    return if (n == 0) "" else p.?[0..n];
}

export fn talk_router_unwatch(r: *Router, c: *const talk.Call, name: ?[*]const u8, name_len: usize) void {
    r.unwatch(c, text(name, name_len));
}

export fn talk_router_release(r: *Router, g: *const talk.GrantContext) void {
    r.release(g.group, g.script_name[0..g.script_name_len], g.grant_name[0..g.grant_name_len]);
}

export fn talk_router_commit(r: *Router, store: ?[*]const u8, store_len: usize, changed_keys: ?[*]const talk.Id, changed_len: usize) talk.HostErrorCode {
    const keys = allocator.alloc([]const u8, changed_len) catch return .out_of_memory;
    defer allocator.free(keys);
    for (keys, 0..) |*k, i| k.* = changed_keys.?[i].data[0..changed_keys.?[i].len];
    r.commit(text(store, store_len), keys) catch return .out_of_memory;
    return .ok;
}

export fn talk_router_pumped(r: *Router, g: *Group) bool {
    return r.pumped(g) catch true;
}

export fn talk_router_detach(r: *Router, g: *Group) void {
    r.detach(g);
}

export fn talk_router_save(r: *Router, g: *Group, out: *talk.Buffer) talk.HostErrorCode {
    out.* = .{};
    const bytes = r.save(g) catch |e| return switch (e) {
        error.EffectsPending => .effects_pending,
        error.OutOfMemory => .out_of_memory,
    };
    out.* = .{ .data = bytes.ptr, .len = bytes.len };
    return .ok;
}

export fn talk_router_restore(r: *Router, core: *talk.Core, checkpoint: ?[*]const u8, len: usize, o: *const talk.RestoreOptions, out: *?*Group, result: *?*talk.RestoreResult, routing: *?*RoutingResult) talk.HostErrorCode {
    out.* = null;
    result.* = null;
    routing.* = null;
    var code: talk.HostErrorCode = .ok;
    const restored = (r.restore(core, text(checkpoint, len), o, &code) catch return .out_of_memory) orelse return code;
    const held = allocator.create(RoutingHeld) catch return .out_of_memory;
    const total = restored.routing.restored.items.len + restored.routing.dropped.items.len + restored.routing.resynced.items.len;
    held.* = .{ .view = undefined, .routing = restored.routing, .ids = allocator.alloc(talk.Id, total) catch return .out_of_memory };
    var at: usize = 0;
    var views: [3][]talk.Id = undefined;
    for ([_]*std.ArrayList([]u8){ &held.routing.restored, &held.routing.dropped, &held.routing.resynced }, &views) |l, *v| {
        v.* = held.ids[at .. at + l.items.len];
        for (l.items, v.*) |s, *id| id.* = .{ .data = s.ptr, .len = s.len };
        at += l.items.len;
    }
    held.view = .{ .restored = views[0].ptr, .restored_len = views[0].len, .dropped = views[1].ptr, .dropped_len = views[1].len, .resynced = views[2].ptr, .resynced_len = views[2].len };
    out.* = restored.group;
    result.* = restored.result;
    routing.* = &held.view;
    return .ok;
}

export fn talk_routing_result_release(x: ?*RoutingResult) void {
    const view = x orelse return;
    const held: *RoutingHeld = @fieldParentPtr("view", view);
    held.routing.deinit(allocator);
    allocator.free(held.ids);
    allocator.destroy(held);
}

export fn talk_changed(before: ?*const Value, after: ?*const Value) bool {
    return changed(before, after);
}

test "changed compares by the Value Encoding, and Nothing is a missing key" {
    const gpa = std.testing.allocator;
    const one = try model.text(gpa, "1");
    defer one.release();
    const other = try model.text(gpa, "1");
    defer other.release();
    const none = try model.scalar(gpa, .nothing);
    defer none.release();
    try std.testing.expect(!changed(one, other));
    try std.testing.expect(!changed(null, none));
    try std.testing.expect(changed(none, one));
}

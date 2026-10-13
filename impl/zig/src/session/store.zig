//! The Session Store (chapter 12, The Session Store): the in-memory Stores a
//! session's `store` Grants reach, one per name, and the `store` Standard
//! Capability's implementation over them (chapter 7, `store`). Each value is
//! held by its Value Encoding, so it outlives any Group a restore replaces.
//! Writes are Segment-bound: they wait in their Segment until it commits,
//! and a commit with changed keys counts a revision and goes to the router.
const std = @import("std");
const c = @import("talk-c");
const northtalk = @import("northtalk");

const Allocator = std.mem.Allocator;
const Value = northtalk.value.Value;

/// The Session Store's quotas, each counted by logical size.
pub const quota = struct {
    pub const size: u64 = 1_048_576;
    pub const keys: u64 = 1_000;
    pub const value: u64 = 65_536;
};

pub const Store = struct {
    /// Each key's value, by its Value Encoding, and its logical size.
    entries: std.StringArrayHashMapUnmanaged(Entry) = .empty,
    /// Commits with changed keys, from 0.
    revision: u64 = 0,
    revision_text: []const u8 = "0",

    pub const Entry = struct { encoded: []const u8, size: u64 };
};

const Write = struct {
    store: []const u8,
    key: []const u8,
    what: union(enum) { set: Store.Entry, delete, increment: []const u8 },
};

pub const Stores = struct {
    gpa: Allocator,
    arena: std.heap.ArenaAllocator,
    stores: std.StringArrayHashMapUnmanaged(*Store) = .empty,
    /// Each live Segment's writes, in call order.
    pending: std.StringArrayHashMapUnmanaged(std.ArrayList(Write)) = .empty,
    router: *c.talk_router,

    pub fn init(gpa: Allocator, router: *c.talk_router) Stores {
        return .{ .gpa = gpa, .arena = .init(gpa), .router = router };
    }

    pub fn deinit(s: *Stores) void {
        s.arena.deinit();
    }

    fn a(s: *Stores) Allocator {
        return s.arena.allocator();
    }

    pub fn named(s: *Stores, name: []const u8) *Store {
        if (s.stores.get(name)) |x| return x;
        const x = s.a().create(Store) catch @panic("out of memory");
        x.* = .{};
        s.stores.put(s.a(), s.a().dupe(u8, name) catch @panic("out of memory"), x) catch @panic("out of memory");
        return x;
    }

    // ------------------------------------------------------------ values

    /// A value's Value Encoding, or null for one that holds a Host Object.
    fn encode(s: *Stores, v: ?*const c.talk_value) ?Store.Entry {
        var buf: c.talk_owned_bytes = .{ .data = null, .len = 0 };
        if (c.talk_encode_value(v, &buf) != c.TALK_OK) return null;
        defer c.talk_owned_bytes_release(&buf);
        const value: *const Value = @ptrCast(@alignCast(v.?));
        if (holdsObject(value)) return null;
        return .{ .encoded = s.a().dupe(u8, buf.data[0..buf.len]) catch @panic("out of memory"), .size = northtalk.machine.costs.size(value) };
    }

    fn holdsObject(v: *const Value) bool {
        return switch (v.data) {
            .object => true,
            .list => |items| for (items) |x| {
                if (holdsObject(x)) break true;
            } else false,
            .map => |pairs| for (pairs) |p| {
                if (holdsObject(p.value)) break true;
            } else false,
            else => false,
        };
    }

    /// A held value, as a new reference the caller owns.
    fn decode(encoded: []const u8) ?*c.talk_value {
        var v: ?*c.talk_value = null;
        if (c.talk_decode_value(encoded.ptr, encoded.len, null, null, &v) != c.TALK_OK) return null;
        return v;
    }

    fn textSize(t: []const u8) u64 {
        const v = northtalk.value.text(std.heap.page_allocator, t) catch return t.len;
        defer v.release();
        return northtalk.machine.costs.size(v);
    }

    // ------------------------------------------------------------ what a Segment sees

    /// The Store as a Segment sees it: committed, with its own writes
    /// applied in call order.
    fn view(s: *Stores, segment: []const u8, name: []const u8) !std.StringArrayHashMapUnmanaged(Store.Entry) {
        const store = s.named(name);
        var out = try store.entries.clone(s.gpa);
        errdefer out.deinit(s.gpa);
        if (s.pending.get(segment)) |writes| for (writes.items) |w| {
            if (!std.mem.eql(u8, w.store, name)) continue;
            switch (w.what) {
                .set => |e| try out.put(s.gpa, w.key, e),
                .delete => _ = out.orderedRemove(w.key),
                .increment => |by| {
                    const before = if (out.get(w.key)) |e| e.encoded else null;
                    const after = try add(s.a(), before, by) orelse continue;
                    try out.put(s.gpa, w.key, after);
                },
            }
        };
        return out;
    }

    /// `by` added to a held value, a missing key giving `by` itself.
    fn add(arena: Allocator, before: ?[]const u8, by: []const u8) !?Store.Entry {
        const y = decode(by) orelse return null;
        defer c.talk_value_release(y);
        const yv: *Value = @ptrCast(@alignCast(y));
        const x = if (before) |b| decode(b) else null;
        defer if (x) |v| c.talk_value_release(v);
        const sum: *Value = if (x) |v| northtalk.value.arithmetic(std.heap.page_allocator, .add, @ptrCast(@alignCast(v)), yv) catch return null else yv.retain();
        defer sum.release();
        const encoded = northtalk.encoding.encode(arena, sum) catch return null;
        return .{ .encoded = encoded, .size = northtalk.machine.costs.size(sum) };
    }

    fn sumError(before: ?[]const u8, by: []const u8) ?[]const u8 {
        const y = decode(by) orelse return "wrong kind";
        defer c.talk_value_release(y);
        const x = (if (before) |b| decode(b) else return null) orelse return null;
        defer c.talk_value_release(x);
        const sum = northtalk.value.arithmetic(std.heap.page_allocator, .add, @ptrCast(@alignCast(x)), @ptrCast(@alignCast(y))) catch |e| return switch (e) {
            error.IncompatibleUnits => "incompatible units",
            error.Overflow => "overflow",
            else => "wrong kind",
        };
        sum.release();
        return null;
    }

    /// Whether the Store, with a Segment's writes and `extra` applied, keeps
    /// to its quotas; the limit it would pass, if any.
    fn overQuota(s: *Stores, segment: []const u8, name: []const u8, key: []const u8, entry: ?Store.Entry) !?[]const u8 {
        var v = try s.view(segment, name);
        defer v.deinit(s.gpa);
        if (entry) |e| {
            if (e.size > quota.value) return "value";
            try v.put(s.gpa, key, e);
        } else _ = v.orderedRemove(key);
        if (v.count() > quota.keys) return "keys";
        var total: u64 = 0;
        for (v.keys(), v.values()) |k, e| total += textSize(k) + e.size;
        if (total > quota.size) return "size";
        return null;
    }

    fn record(s: *Stores, segment: []const u8, w: Write) !void {
        const e = try s.pending.getOrPut(s.a(), try s.a().dupe(u8, segment));
        if (!e.found_existing) e.value_ptr.* = .empty;
        try e.value_ptr.append(s.a(), w);
    }

    // ------------------------------------------------------------ commits

    /// Applies a commit to the Stores it writes, all at once: each Store
    /// whose keys changed counts a revision, and the router routes them.
    pub fn commit(s: *Stores, segment: []const u8) !void {
        const kv = s.pending.fetchOrderedRemove(segment) orelse return;
        var touched: std.ArrayList([]const u8) = .empty;
        defer touched.deinit(s.gpa);
        for (kv.value.items) |w| {
            for (touched.items) |t| {
                if (std.mem.eql(u8, t, w.store)) break;
            } else try touched.append(s.gpa, w.store);
        }
        for (touched.items) |name| {
            const store = s.named(name);
            var before = try store.entries.clone(s.gpa);
            defer before.deinit(s.gpa);
            for (kv.value.items) |w| {
                if (!std.mem.eql(u8, w.store, name)) continue;
                switch (w.what) {
                    .set => |e| try store.entries.put(s.a(), w.key, e),
                    .delete => _ = store.entries.orderedRemove(w.key),
                    .increment => |by| {
                        const old = if (store.entries.get(w.key)) |e| e.encoded else null;
                        if (try add(s.a(), old, by)) |e| try store.entries.put(s.a(), w.key, e);
                    },
                }
            }
            try s.routeChanges(name, &before);
        }
    }

    /// Routes a Store's net changes since `before`, counting a revision when
    /// there are any.
    pub fn routeChanges(s: *Stores, name: []const u8, before: *const std.StringArrayHashMapUnmanaged(Store.Entry)) !void {
        const store = s.named(name);
        var changed: std.ArrayList(c.talk_id) = .empty;
        defer changed.deinit(s.gpa);
        for (store.entries.keys(), store.entries.values()) |k, e| {
            const old = before.get(k);
            if (old == null or !std.mem.eql(u8, old.?.encoded, e.encoded)) try changed.append(s.gpa, .{ .data = k.ptr, .len = k.len });
        }
        for (before.keys()) |k| if (!store.entries.contains(k)) try changed.append(s.gpa, .{ .data = k.ptr, .len = k.len });
        // A key holding Nothing and a missing key are one state.
        var kept: usize = 0;
        for (changed.items) |id| {
            const key = id.data[0..id.len];
            const x = if (before.get(key)) |e| e.encoded else "null";
            const y = if (store.entries.get(key)) |e| e.encoded else "null";
            if (std.mem.eql(u8, x, y)) continue;
            changed.items[kept] = id;
            kept += 1;
        }
        if (kept == 0) return;
        store.revision += 1;
        store.revision_text = try std.fmt.allocPrint(s.a(), "{d}", .{store.revision});
        _ = c.talk_router_commit(s.router, name.ptr, name.len, changed.items.ptr, kept);
    }

    pub fn rollback(s: *Stores, segment: []const u8) void {
        _ = s.pending.fetchOrderedRemove(segment);
    }

    // ------------------------------------------------------------ the Operations

    fn storeName(call: ?*c.talk_call) []const u8 {
        const binding = c.talk_call_binding(call) orelse return "default";
        return std.mem.span(@as([*:0]const u8, @ptrCast(binding)));
    }

    fn segmentOf(call: ?*c.talk_call) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        c.talk_call_segment_id(call, &p, &n);
        return p[0..n];
    }

    fn text(v: ?*const c.talk_value) []const u8 {
        var p: [*c]const u8 = null;
        var n: usize = 0;
        if (!c.talk_value_as_text(v, &p, &n)) return "";
        return p[0..n];
    }

    fn fail(err: [*c]c.talk_script_error, code: []const u8, key: []const u8, word: []const u8) c.talk_call_end {
        var field: ?*c.talk_value = null;
        _ = c.talk_text(word.ptr, word.len, &field);
        defer c.talk_value_release(field);
        const pair = [_]c.talk_pair{.{ .key = key.ptr, .key_len = key.len, .value = field }};
        var data: ?*c.talk_value = null;
        _ = c.talk_map(&pair, 1, &data);
        err.* = .{ .code = code.ptr, .code_len = code.len, .message = null, .message_len = 0, .data = data };
        return c.TALK_CALL_FAILED;
    }

    fn get(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        var v = s.view(segmentOf(call), storeName(call)) catch return c.TALK_CALL_BROKEN;
        defer v.deinit(s.gpa);
        if (v.get(text(args[0]))) |e| {
            result.* = decode(e.encoded) orelse return c.TALK_CALL_BROKEN;
        } else {
            c.talk_value_retain(args[1]);
            result.* = args[1];
        }
        return c.TALK_CALL_ANSWERED;
    }

    fn keys(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = err;
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        var v = s.view(segmentOf(call), storeName(call)) catch return c.TALK_CALL_BROKEN;
        defer v.deinit(s.gpa);
        const prefix = text(args[0]);
        var names: std.ArrayList([]const u8) = .empty;
        defer names.deinit(s.gpa);
        for (v.keys()) |k| if (std.mem.startsWith(u8, k, prefix)) names.append(s.gpa, k) catch return c.TALK_CALL_BROKEN;
        std.mem.sort([]const u8, names.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.order(u8, x, y) == .lt;
            }
        }.less);
        var items: std.ArrayList(?*c.talk_value) = .empty;
        defer {
            for (items.items) |x| c.talk_value_release(x);
            items.deinit(s.gpa);
        }
        for (names.items) |k| {
            var t: ?*c.talk_value = null;
            if (c.talk_text(k.ptr, k.len, &t) != c.TALK_OK) return c.TALK_CALL_BROKEN;
            items.append(s.gpa, t) catch return c.TALK_CALL_BROKEN;
        }
        if (c.talk_list(@ptrCast(items.items.ptr), items.items.len, result) != c.TALK_OK) return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }

    fn write(s: *Stores, call: ?*c.talk_call, key: []const u8, value: ?*const c.talk_value, err: [*c]c.talk_script_error) c.talk_call_end {
        const name = storeName(call);
        const segment = segmentOf(call);
        const nothing = blk: {
            const v: *const Value = @ptrCast(@alignCast(value.?));
            break :blk v.data == .nothing;
        };
        const entry: ?Store.Entry = if (nothing) null else s.encode(value) orelse {
            const v: *const Value = @ptrCast(@alignCast(value.?));
            _ = v;
            return fail(err, "can't store", "kind", "object");
        };
        if (s.overQuota(segment, name, key, entry) catch return c.TALK_CALL_BROKEN) |limit| return fail(err, "store full", "limit", limit);
        const owned = s.a().dupe(u8, key) catch return c.TALK_CALL_BROKEN;
        s.record(segment, .{ .store = s.a().dupe(u8, name) catch return c.TALK_CALL_BROKEN, .key = owned, .what = if (entry) |e| .{ .set = e } else .delete }) catch return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }

    fn set(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        const end = s.write(call, text(args[0]), args[1], err);
        if (end == c.TALK_CALL_ANSWERED) _ = c.talk_nothing(result);
        return end;
    }

    fn delete(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        _ = err;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        const key = s.a().dupe(u8, text(args[0])) catch return c.TALK_CALL_BROKEN;
        s.record(segmentOf(call), .{ .store = s.a().dupe(u8, storeName(call)) catch return c.TALK_CALL_BROKEN, .key = key, .what = .delete }) catch return c.TALK_CALL_BROKEN;
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn increment(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        const name = storeName(call);
        const segment = segmentOf(call);
        const key = text(args[0]);
        // `by` is 1 when omitted or Nothing.
        var one: ?*c.talk_value = null;
        defer c.talk_value_release(one);
        const by_value = blk: {
            const v: *const Value = @ptrCast(@alignCast(args[1].?));
            if (v.data != .nothing) break :blk args[1];
            _ = c.talk_int(1, &one);
            break :blk one;
        };
        const by = s.encode(by_value) orelse return c.TALK_CALL_BROKEN;
        var v = s.view(segment, name) catch return c.TALK_CALL_BROKEN;
        defer v.deinit(s.gpa);
        const before = if (v.get(key)) |e| e.encoded else null;
        if (sumError(before, by.encoded)) |code| {
            const msg = code;
            err.* = .{ .code = msg.ptr, .code_len = msg.len, .message = null, .message_len = 0, .data = null };
            return c.TALK_CALL_FAILED;
        }
        const after = (add(s.a(), before, by.encoded) catch return c.TALK_CALL_BROKEN) orelse return c.TALK_CALL_BROKEN;
        if (s.overQuota(segment, name, key, after) catch return c.TALK_CALL_BROKEN) |limit| return fail(err, "store full", "limit", limit);
        s.record(segment, .{ .store = s.a().dupe(u8, name) catch return c.TALK_CALL_BROKEN, .key = s.a().dupe(u8, key) catch return c.TALK_CALL_BROKEN, .what = .{ .increment = by.encoded } }) catch return c.TALK_CALL_BROKEN;
        result.* = decode(after.encoded) orelse return c.TALK_CALL_BROKEN;
        return c.TALK_CALL_ANSWERED;
    }

    fn swap(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        var v = s.view(segmentOf(call), storeName(call)) catch return c.TALK_CALL_BROKEN;
        defer v.deinit(s.gpa);
        const key = text(args[0]);
        const seen = if (v.get(key)) |e| decode(e.encoded) else null;
        defer if (seen) |x| c.talk_value_release(x);
        var equal = false;
        if (seen) |x| {
            _ = c.talk_value_equal(x, args[1], &equal);
        } else {
            const expected: *const Value = @ptrCast(@alignCast(args[1].?));
            equal = expected.data == .nothing;
        }
        if (!equal) {
            _ = c.talk_bool(false, result);
            return c.TALK_CALL_ANSWERED;
        }
        const end = s.write(call, key, args[2], err);
        if (end == c.TALK_CALL_ANSWERED) _ = c.talk_bool(true, result);
        return end;
    }

    fn watch(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        const name = text(args[0]);
        const prefix = text(args[1]);
        const message = text(args[2]);
        if (!c.talk_router_watch(s.router, call, name.ptr, name.len, prefix.ptr, prefix.len, message.ptr, message.len, err)) {
            return if (err.*.code != null) c.TALK_CALL_FAILED else c.TALK_CALL_BROKEN;
        }
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn unwatch(context: ?*anyopaque, call: ?*c.talk_call, args: [*c]const ?*c.talk_value, len: usize, result: [*c]?*c.talk_value, err: [*c]c.talk_script_error) callconv(.c) c.talk_call_end {
        _ = len;
        _ = err;
        const s: *Stores = @ptrCast(@alignCast(context.?));
        const name = text(args[0]);
        c.talk_router_unwatch(s.router, call, name.ptr, name.len);
        _ = c.talk_nothing(result);
        return c.TALK_CALL_ANSWERED;
    }

    fn release(context: ?*anyopaque, g: [*c]const c.talk_grant_context) callconv(.c) void {
        const s: *Stores = @ptrCast(@alignCast(context.?));
        c.talk_router_release(s.router, g);
    }

    fn segmentId(ctx: [*c]const c.talk_segment_context) []const u8 {
        return ctx.*.segment_id[0..ctx.*.segment_id_len];
    }

    fn begin(context: ?*anyopaque, ctx: [*c]const c.talk_segment_context) callconv(.c) c.talk_effect_result {
        _ = context;
        _ = ctx;
        return .{ .status = c.TALK_EFFECT_OK, .detail = null, .detail_len = 0 };
    }

    fn commitHook(context: ?*anyopaque, ctx: [*c]const c.talk_segment_context) callconv(.c) c.talk_effect_result {
        const s: *Stores = @ptrCast(@alignCast(context.?));
        s.commit(segmentId(ctx)) catch return .{ .status = c.TALK_EFFECT_FAILED, .detail = null, .detail_len = 0 };
        return .{ .status = c.TALK_EFFECT_OK, .detail = null, .detail_len = 0 };
    }

    fn rollbackHook(context: ?*anyopaque, ctx: [*c]const c.talk_segment_context) callconv(.c) c.talk_effect_result {
        const s: *Stores = @ptrCast(@alignCast(context.?));
        s.rollback(segmentId(ctx));
        return .{ .status = c.TALK_EFFECT_OK, .detail = null, .detail_len = 0 };
    }

    /// The `store` Capability over these Stores: `get`, `keys` and
    /// `unwatch` cost 2 Fuel, the rest 4, with no declared allocation.
    pub fn capability(s: *Stores, core: *c.talk_core) !*c.talk_capability_def {
        const costs = [_]c.talk_named_cost{
            .{ .name = "get", .name_len = 3, .cost = .{ .fuel = 2, .alloc = 0 } },
            .{ .name = "keys", .name_len = 4, .cost = .{ .fuel = 2, .alloc = 0 } },
            .{ .name = "unwatch", .name_len = 7, .cost = .{ .fuel = 2, .alloc = 0 } },
            .{ .name = "set", .name_len = 3, .cost = .{ .fuel = 4, .alloc = 0 } },
            .{ .name = "delete", .name_len = 6, .cost = .{ .fuel = 4, .alloc = 0 } },
            .{ .name = "increment", .name_len = 9, .cost = .{ .fuel = 4, .alloc = 0 } },
            .{ .name = "swap", .name_len = 4, .cost = .{ .fuel = 4, .alloc = 0 } },
            .{ .name = "watch", .name_len = 5, .cost = .{ .fuel = 4, .alloc = 0 } },
        };
        const impl: c.talk_store_impl = .{
            .context = s,
            .get = get,
            .set = set,
            .del = delete,
            .keys = keys,
            .increment = increment,
            .swap = swap,
            .watch = watch,
            .unwatch = unwatch,
            .coordinator = .{ .begin = begin, .commit = commitHook, .rollback = rollbackHook, .context = s },
            .release = release,
        };
        var def: ?*c.talk_capability_def = null;
        if (c.talk_store_capability(core, &impl, &.{ .entries = &costs, .len = costs.len }, &def) != c.TALK_OK) return error.HostError;
        return def.?;
    }

    // ------------------------------------------------------------ the Host's own changes

    /// `:store load`: a JSON object of keys and their values by the Value
    /// Encoding replaces the Store's contents, as one commit. Null when it
    /// is refused.
    pub fn load(s: *Stores, name: []const u8, json: []const u8) !?usize {
        var v: ?*c.talk_value = null;
        if (c.talk_decode_value(json.ptr, json.len, null, null, &v) != c.TALK_OK) return null;
        defer c.talk_value_release(v);
        const value: *const Value = @ptrCast(@alignCast(v.?));
        if (value.data != .map) return null;
        var next: std.StringArrayHashMapUnmanaged(Store.Entry) = .empty;
        var total: u64 = 0;
        for (value.data.map) |p| {
            if (p.key.len == 0) return null;
            const e = s.encode(@ptrCast(p.value)) orelse return null;
            if (e.size > quota.value) return null;
            total += textSize(p.key) + e.size;
            try next.put(s.a(), try s.a().dupe(u8, p.key), e);
        }
        if (next.count() > quota.keys or total > quota.size) return null;
        const store = s.named(name);
        const before = store.entries;
        store.entries = next;
        try s.routeChanges(name, &before);
        return next.count();
    }

    /// `:store clear`, as one commit.
    pub fn clear(s: *Stores, name: []const u8) !void {
        const store = s.named(name);
        const before = store.entries;
        store.entries = .empty;
        try s.routeChanges(name, &before);
    }

    /// The Store's contents in key order, as `:store` prints them and
    /// `:store save` writes them.
    pub fn sorted(s: *Stores, name: []const u8) ![]const []const u8 {
        const store = s.named(name);
        const out = try s.a().dupe([]const u8, store.entries.keys());
        std.mem.sort([]const u8, out, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.order(u8, x, y) == .lt;
            }
        }.less);
        return out;
    }

    pub fn valueOf(s: *Stores, name: []const u8, key: []const u8) ?*c.talk_value {
        const e = s.named(name).entries.get(key) orelse return null;
        return decode(e.encoded);
    }
};

//! Reference-counted, acyclic values with copy-on-write containers. Every
//! node remembers its allocator; constructors retain children and copy bytes.
const std = @import("std");
const unicode = @import("unicode/unicode.zig");
pub const decimal = @import("decimal/decimal.zig");
pub const Decimal = decimal.Decimal;
pub const units = @import("units.zig");
pub const dates = @import("dates.zig");
/// Every refusal a value operation can report.
pub const Error = units.Error || error{ CantCompare, NotEncodable };
/// talk.h's `talk_kind`, in the same order.
pub const Kind = enum(c_int) { nothing, bool, number, quantity, text, bytes, list, map, range, instant, civil_date, pattern, function, object };
/// One map entry. A key is NFC text, unique within its map.
pub const Pair = struct { key: []const u8, value: *Value };
/// A number with a non-empty Unit.
pub const Quantity = struct { number: Decimal, unit: units.Unit };
/// A range between two numbers, or two Quantities of compatible Units.
pub const Range = struct { from: *Value, to: *Value };
/// A Host Object, compared by `identity`, which its Group assigns.
pub const Object = struct { kind: []const u8, id: []const u8, identity: usize };
/// A Function Value: its display source, home Script and captured values.
pub const Function = struct { display: []const u8, home: []const u8, identity: usize, captures: *Value };
/// List versions share an initialized span of a buffer. Extending that span
/// leaves each older version's slice unchanged; an interior write must copy.
const ListStorage = struct {
    references: usize = 1,
    buffer: []*Value,
    start: usize,
    end: usize,
};
/// A value's payload, one variant per Kind. Slices and children are owned.
pub const Data = union(Kind) {
    nothing: void,
    bool: bool,
    number: Decimal,
    quantity: Quantity,
    text: []const u8,
    bytes: []const u8,
    list: []*Value,
    map: []Pair,
    range: Range,
    instant: dates.Instant,
    civil_date: dates.Fields,
    pattern: []const u8,
    function: Function,
    object: Object,
};
/// One reference-counted, immutable node. Release each owned reference once.
pub const Value = struct {
    references: usize = 1,
    allocator: std.mem.Allocator,
    /// The logical size of a container's or Function's contents (chapter 8,
    /// Logical sizes), kept as it is built so that measuring never walks a
    /// deep value; for a Text Pattern, its program size once measured, or 0;
    /// for ASCII Text, its exact Character count (CRLF counts once).
    /// Logical size sums saturate: no budget reaches 2^64.
    measure: u64 = 0,
    /// A Core-raised error map, whose `message` the Trace leaves out
    /// (chapter 11): its wording is outside parity.
    core_message: bool = false,
    /// A Script's name as `load-object` pushes it: a Script is not a
    /// value, so retained state doesn't count it (chapter 8).
    script_name: bool = false,
    /// Immutable Text metadata. Only ASCII Character counts are additive,
    /// with a correction for CRLF across the join. Other Texts keep the
    /// full Unicode measurement path. This flag fits in header padding.
    text_ascii: bool = false,
    list_storage: ?*ListStorage = null,
    /// Greater than every physical child's rank. Shared List growth keeps
    /// it fixed; higher-ranked insertions copy to preserve acyclic ownership.
    ownership_rank: u64 = 0,
    /// Intrusive work list used only after the last reference is released.
    release_next: ?*Value = null,
    data: Data,
    /// The kind of the value's payload.
    pub fn kind(self: *const Value) Kind {
        return std.meta.activeTag(self.data);
    }
    /// Acquires another reference and returns the same value.
    pub fn retain(self: *Value) *Value {
        self.references += 1;
        return self;
    }
    /// Ends one reference, freeing the node and its children with the last.
    pub fn release(self: *Value) void {
        // Hidden List tails can make physical ownership deeper than a
        // Script's logical nesting. Teardown is iterative and allocates
        // nothing, including when the Group allocator has refused memory.
        var pending: ?*Value = null;
        queueRelease(self, &pending);
        while (pending) |node| {
            pending = node.release_next;
            const gpa = node.allocator;
            switch (node.data) {
                .text, .bytes, .pattern => |s| gpa.free(s),
                .list => |items| {
                    if (node.list_storage) |storage| {
                        storage.references -= 1;
                        if (storage.references == 0) {
                            for (storage.buffer[storage.start..storage.end]) |v| queueRelease(v, &pending);
                            gpa.free(storage.buffer);
                            gpa.destroy(storage);
                        }
                    } else {
                        for (items) |v| queueRelease(v, &pending);
                        gpa.free(items);
                    }
                },
                .map => |pairs| {
                    for (pairs) |p| {
                        gpa.free(p.key);
                        queueRelease(p.value, &pending);
                    }
                    gpa.free(pairs);
                },
                .range => |r| {
                    queueRelease(r.from, &pending);
                    queueRelease(r.to, &pending);
                },
                .object => |o| {
                    gpa.free(o.kind);
                    gpa.free(o.id);
                },
                .function => |f| {
                    gpa.free(f.display);
                    gpa.free(f.home);
                    queueRelease(f.captures, &pending);
                },
                else => {},
            }
            gpa.destroy(node);
        }
    }
    /// The value a map holds under the NFC `key`, borrowed, or null.
    pub fn get(self: *const Value, key: []const u8) ?*Value {
        if (self.data != .map) return null;
        for (self.data.map) |p| if (std.mem.eql(u8, p.key, key)) return p.value;
        return null;
    }
    /// Script equality: numbers by value, Quantities in Base Units, maps
    /// regardless of order, Objects and Functions by identity. Containers
    /// are compared from a heap work list, never by native recursion.
    pub fn equal(self: *const Value, other: *const Value) Error!bool {
        var comparer = Comparer.init(self.allocator);
        defer comparer.deinit();
        return comparer.equal(self, other);
    }
    /// Equality decided at this node, or null when a container's children
    /// decide it: lists and maps of equal length, ranges, and Functions of
    /// the same identity.
    fn shallowEqual(x: *const Value, y: *const Value) Error!?bool {
        if (x.kind() != y.kind()) return false;
        return switch (x.data) {
            .nothing => true,
            .bool => |b| b == y.data.bool,
            .number => |n| Decimal.order(n, y.data.number) == .eq,
            .quantity => |q| blk: {
                const r = y.data.quantity;
                if (!q.unit.compatible(&r.unit)) break :blk false;
                break :blk Decimal.order(try q.unit.comparisonBase(x.allocator, q.number), try r.unit.comparisonBase(x.allocator, r.number)) == .eq;
            },
            .text, .bytes, .pattern => |t| std.mem.eql(u8, t, switch (y.data) {
                .text, .bytes, .pattern => |v| v,
                else => unreachable,
            }),
            .list => |xs| if (xs.len != y.data.list.len) false else if (xs.len == 0) true else null,
            .map => |xs| if (xs.len != y.data.map.len) false else if (xs.len == 0) true else null,
            .range => null,
            .instant => |t| t.seconds == y.data.instant.seconds and t.nanos == y.data.instant.nanos,
            .civil_date => |f| std.meta.eql(f, y.data.civil_date),
            .object => |o| o.identity == y.data.object.identity,
            .function => |f| if (f.identity != y.data.function.identity or !std.mem.eql(u8, f.home, y.data.function.home)) false else null,
        };
    }
    /// Script ordering, refused with CantCompare for unordered kinds or
    /// incompatible Units. A list orders by its first unequal item, so the
    /// descent is a loop.
    pub fn order(self: *const Value, other: *const Value) Error!std.math.Order {
        var comparer = Comparer.init(self.allocator);
        defer comparer.deinit();
        return comparer.order(self, other);
    }
};
/// One comparison's shared work (#890): equality walks each distinct
/// pair of nodes once, however many paths reach it, while `scanned`
/// still counts every logical pair examined, shared parts at each
/// occurrence. The Fuel charge is logical; the native work is not.
/// Values are acyclic, so a pair is proven when its children finish,
/// and no pair is its own descendant.
pub const Comparer = struct {
    gpa: std.mem.Allocator,
    fold: bool,
    folded_texts: std.AutoHashMap(usize, []u8),
    proven: std.AutoHashMap(u128, void),
    self_scans: std.AutoHashMap(usize, u64),

    pub fn init(gpa: std.mem.Allocator) Comparer {
        return initFolded(gpa, false);
    }
    /// Fold text at every depth, including captures; map keys and Pattern
    /// sources remain exact. Caches belong to this one comparison mode.
    pub fn initFolded(gpa: std.mem.Allocator, fold: bool) Comparer {
        return .{ .gpa = gpa, .fold = fold, .folded_texts = .init(gpa), .proven = .init(gpa), .self_scans = .init(gpa) };
    }
    pub fn deinit(self: *Comparer) void {
        var texts = self.folded_texts.valueIterator();
        while (texts.next()) |t| self.gpa.free(t.*);
        self.folded_texts.deinit();
        self.proven.deinit();
        self.self_scans.deinit();
    }
    /// Simple foldings are compared as they are, without a second NFC pass.
    /// A shared text node is folded once, even when many paths reach it.
    fn text(self: *Comparer, v: *const Value) Error![]const u8 {
        if (!self.fold) return v.data.text;
        const id = @intFromPtr(v);
        if (self.folded_texts.get(id)) |t| return t;
        const t = try unicode.foldText(self.gpa, v.data.text);
        errdefer self.gpa.free(t);
        try self.folded_texts.put(id, t);
        return t;
    }
    fn pairKey(x: *const Value, y: *const Value) u128 {
        return (@as(u128, @intFromPtr(x)) << 64) | @as(u128, @intFromPtr(y));
    }
    /// Script equality over a heap work list, skipping pairs already
    /// proven equal within this comparison.
    pub fn equal(self: *Comparer, a: *const Value, b: *const Value) Error!bool {
        const Entry = struct { x: *const Value, y: *const Value, finish: bool = false };
        const gpa = self.gpa;
        var stack: std.ArrayList(Entry) = .empty;
        defer stack.deinit(gpa);
        try stack.append(gpa, .{ .x = a, .y = b });
        while (stack.pop()) |entry| {
            const x = entry.x;
            const y = entry.y;
            if (entry.finish) {
                try self.proven.put(pairKey(x, y), {});
                continue;
            }
            if (x == y or self.proven.contains(pairKey(x, y))) continue;
            if (self.fold and x.data == .text and y.data == .text) {
                if (!std.mem.eql(u8, try self.text(x), try self.text(y))) return false;
                continue;
            }
            if (try x.shallowEqual(y)) |same| {
                if (!same) return false;
                continue;
            }
            try stack.append(gpa, .{ .x = x, .y = y, .finish = true });
            // Children are pushed last first, so they compare in order.
            switch (x.data) {
                .list => |xs| {
                    try stack.ensureUnusedCapacity(gpa, xs.len);
                    var i = xs.len;
                    while (i > 0) {
                        i -= 1;
                        stack.appendAssumeCapacity(.{ .x = xs[i], .y = y.data.list[i] });
                    }
                },
                .map => |xs| {
                    try stack.ensureUnusedCapacity(gpa, xs.len);
                    var i = xs.len;
                    while (i > 0) {
                        i -= 1;
                        stack.appendAssumeCapacity(.{ .x = xs[i].value, .y = y.get(xs[i].key) orelse return false });
                    }
                },
                .range => |r| {
                    try stack.ensureUnusedCapacity(gpa, 2);
                    stack.appendAssumeCapacity(.{ .x = r.to, .y = y.data.range.to });
                    stack.appendAssumeCapacity(.{ .x = r.from, .y = y.data.range.from });
                },
                .function => |f| try stack.append(gpa, .{ .x = f.captures, .y = y.data.function.captures }),
                else => unreachable,
            }
        }
        return true;
    }
    /// Script ordering. A list orders by its first unequal item, so the
    /// descent is a loop over this Comparer's equality.
    pub fn order(self: *Comparer, a: *const Value, b: *const Value) Error!std.math.Order {
        var x = a;
        var y = b;
        while (true) {
            if (x.kind() != y.kind()) return error.CantCompare;
            return switch (x.data) {
                .number => |n| Decimal.order(n, y.data.number),
                .quantity => |q| blk: {
                    const r = y.data.quantity;
                    if (!q.unit.compatible(&r.unit)) return error.CantCompare;
                    break :blk Decimal.order(try q.unit.comparisonBase(a.allocator, q.number), try r.unit.comparisonBase(a.allocator, r.number));
                },
                .text => std.mem.order(u8, try self.text(x), try self.text(y)), // UTF-8 preserves scalar order.
                .bytes => |s| std.mem.order(u8, s, y.data.bytes),
                .list => |xs| {
                    const ys = y.data.list;
                    const n = @min(xs.len, ys.len);
                    for (xs[0..n], ys[0..n]) |p, q| {
                        if (try self.equal(p, q)) continue;
                        x = p;
                        y = q;
                        break;
                    } else return std.math.order(xs.len, ys.len);
                    continue;
                },
                .instant => |t| blk: {
                    const r = y.data.instant;
                    const o = std.math.order(t.seconds, r.seconds);
                    break :blk if (o == .eq) std.math.order(t.nanos, r.nanos) else o;
                },
                .civil_date => |f| blk: {
                    const r = y.data.civil_date;
                    if (f.has_time != r.has_time) return error.CantCompare;
                    const o = std.math.order(dates.seconds(f), dates.seconds(r));
                    break :blk if (o == .eq) std.math.order(f.nanosecond, r.nanosecond) else o;
                },
                else => error.CantCompare,
            };
        }
    }
    /// What comparing a value with itself scans: every logical pair in
    /// it. An equal pair scans this much, from either side. Shared
    /// parts are measured once and counted at each occurrence.
    pub fn selfScan(self: *Comparer, v: *const Value) Error!u64 {
        if (self.self_scans.get(@intFromPtr(v))) |n| return n;
        const gpa = self.gpa;
        var pending: std.ArrayList(*const Value) = .empty;
        defer pending.deinit(gpa);
        var order_list: std.ArrayList(*const Value) = .empty;
        defer order_list.deinit(gpa);
        var seen: std.AutoHashMap(usize, void) = .init(gpa);
        defer seen.deinit();
        try pending.append(gpa, v);
        while (pending.pop()) |next| {
            const id = @intFromPtr(next);
            if (self.self_scans.contains(id) or seen.contains(id)) continue;
            try seen.put(id, {});
            try order_list.append(gpa, next);
            try appendScanChildren(gpa, next, &pending);
        }
        var i = order_list.items.len;
        while (i > 0) {
            i -= 1;
            const value = order_list.items[i];
            var total: u64 = 0;
            switch (value.data) {
                .text => {
                    const t = try self.text(value);
                    var at: usize = 0;
                    while (at < t.len) {
                        total += 1;
                        at = unicode.grapheme.end(t, at);
                    }
                },
                .bytes => |b| total = b.len,
                .list => |items| for (items) |child| {
                    total +|= 1 +| self.self_scans.get(@intFromPtr(child)).?;
                },
                .map => |pairs| for (pairs) |p| {
                    total +|= 1 +| self.self_scans.get(@intFromPtr(p.value)).?;
                },
                .range => |r| {
                    total = self.self_scans.get(@intFromPtr(r.from)).? +| self.self_scans.get(@intFromPtr(r.to)).?;
                },
                .function => |f| total = self.self_scans.get(@intFromPtr(f.captures)).?,
                else => {},
            }
            try self.self_scans.put(@intFromPtr(value), total);
        }
        return self.self_scans.get(@intFromPtr(v)).?;
    }
    /// The logical pairs a comparison of `a` with `b` examines, through
    /// the first that differs, at every depth (chapter 8, the `compare`
    /// rate). Only the first differing path is descended; equal parts
    /// contribute their self-scan.
    pub fn scanned(self: *Comparer, a: *const Value, b: *const Value) Error!u64 {
        var total: u64 = 0;
        var x = a;
        var y = b;
        while (true) {
            if (x.kind() != y.kind()) return total;
            switch (x.data) {
                .text => {
                    const s = try self.text(x);
                    const t = try self.text(y);
                    var i: usize = 0;
                    var j: usize = 0;
                    var n: u64 = 0;
                    while (i < s.len and j < t.len) {
                        const ei = unicode.grapheme.end(s, i);
                        const ej = unicode.grapheme.end(t, j);
                        n += 1;
                        if (!std.mem.eql(u8, s[i..ei], t[j..ej])) break;
                        i = ei;
                        j = ej;
                    }
                    return total +| n;
                },
                .bytes => |s| {
                    const t = y.data.bytes;
                    for (0..@min(s.len, t.len)) |k| if (s[k] != t[k]) return total +| (k + 1);
                    return total +| @min(s.len, t.len);
                },
                .list => |xs| {
                    const ys = y.data.list;
                    const n = @min(xs.len, ys.len);
                    var descended = false;
                    for (xs[0..n], ys[0..n]) |p, q| {
                        total +|= 1;
                        if (try self.equal(p, q)) {
                            total +|= try self.selfScan(p);
                        } else {
                            x = p;
                            y = q;
                            descended = true;
                            break;
                        }
                    }
                    if (!descended) return total;
                },
                .map => |xs| {
                    const count = @min(xs.len, y.data.map.len);
                    var descended = false;
                    for (xs[0..count]) |entry| {
                        total +|= 1;
                        const other = y.get(entry.key) orelse return total;
                        if (try self.equal(entry.value, other)) {
                            total +|= try self.selfScan(entry.value);
                        } else {
                            x = entry.value;
                            y = other;
                            descended = true;
                            break;
                        }
                    }
                    if (!descended) return total;
                },
                .range => |r| {
                    if (try self.equal(r.from, y.data.range.from)) {
                        total +|= try self.selfScan(r.from);
                        x = r.to;
                        y = y.data.range.to;
                    } else {
                        x = r.from;
                        y = y.data.range.from;
                    }
                },
                .function => |f| {
                    const g = y.data.function;
                    if (f.identity != g.identity or !std.mem.eql(u8, f.home, g.home)) return total;
                    x = f.captures;
                    y = g.captures;
                },
                else => return total,
            }
        }
    }
};
fn appendScanChildren(gpa: std.mem.Allocator, v: *const Value, out: *std.ArrayList(*const Value)) Error!void {
    switch (v.data) {
        .list => |items| try out.appendSlice(gpa, items),
        .map => |pairs| for (pairs) |p| try out.append(gpa, p.value),
        .range => |r| {
            try out.append(gpa, r.from);
            try out.append(gpa, r.to);
        },
        .function => |f| try out.append(gpa, f.captures),
        else => {},
    }
}
/// A deep scan's summary (chapter 7's `any` scan): whether a value
/// holds no Function Value, and how many logical nodes the scan
/// examines, shared parts at each occurrence.
pub const DeepScan = struct { clean: bool, nodes: u64 };
/// Measures `v` for a deep scan, walking each distinct node once
/// however often it is shared (#890). The caller keeps the cache
/// across the scans of one check.
pub fn deepScanOf(gpa: std.mem.Allocator, v: *const Value, cache: *std.AutoHashMapUnmanaged(usize, DeepScan)) Error!DeepScan {
    if (cache.get(@intFromPtr(v))) |scan| return scan;
    var pending: std.ArrayList(*const Value) = .empty;
    defer pending.deinit(gpa);
    var order_list: std.ArrayList(*const Value) = .empty;
    defer order_list.deinit(gpa);
    var seen: std.AutoHashMapUnmanaged(usize, void) = .empty;
    defer seen.deinit(gpa);
    try pending.append(gpa, v);
    while (pending.pop()) |next| {
        const id = @intFromPtr(next);
        if (cache.contains(id) or seen.contains(id)) continue;
        try seen.put(gpa, id, {});
        try order_list.append(gpa, next);
        switch (next.data) {
            .list => |items| try pending.appendSlice(gpa, items),
            .map => |pairs| for (pairs) |p| try pending.append(gpa, p.value),
            else => {},
        }
    }
    var i = order_list.items.len;
    while (i > 0) {
        i -= 1;
        const value = order_list.items[i];
        var scan: DeepScan = .{ .clean = value.data != .function, .nodes = 1 };
        switch (value.data) {
            .list => |items| for (items) |child| {
                const info = cache.get(@intFromPtr(child)).?;
                scan.clean = scan.clean and info.clean;
                scan.nodes +|= info.nodes;
            },
            .map => |pairs| for (pairs) |p| {
                const info = cache.get(@intFromPtr(p.value)).?;
                scan.clean = scan.clean and info.clean;
                scan.nodes +|= info.nodes;
            },
            else => {},
        }
        try cache.put(gpa, @intFromPtr(value), scan);
    }
    return cache.get(@intFromPtr(v)).?;
}
/// The logical size of `v` (chapter 8, Logical sizes). Containers and
/// Functions carry their contents' size, so this never walks children.
pub fn logicalSize(v: *const Value) u64 {
    return switch (v.data) {
        .nothing, .bool => 8,
        .number => 16,
        .quantity => 24,
        .text => |t| 16 +| t.len,
        .bytes => |b| 16 +| b.len,
        .list => |l| 16 +| (8 *| l.len) +| v.measure,
        .map => |m| 16 +| (8 *| m.len) +| v.measure,
        .range => 16 +| v.measure,
        .instant, .civil_date, .object => 16,
        .pattern => 16 +| (8 *| programSize(v)),
        .function => 32 +| v.measure,
    };
}
/// The logical size of a container's or Function's contents: its items',
/// a map's entries with their keys, a range's ends or a Function's
/// captured values, without their names.
pub fn contentsSize(v: *const Value) u64 {
    return switch (v.data) {
        .list, .map, .range, .function => v.measure,
        else => 0,
    };
}
fn programSize(v: *const Value) u64 {
    if (v.measure != 0) return v.measure;
    const n = @import("machine/matcher.zig").programSize(v);
    // A failed measure is 0 and is not kept, so it is tried again.
    @constCast(v).measure = n;
    return n;
}
fn itemsSize(items: []const *Value) u64 {
    var total: u64 = 0;
    for (items) |x| total +|= logicalSize(x);
    return total;
}
fn pairsSize(pairs: []const Pair) u64 {
    var total: u64 = 0;
    for (pairs) |p| total +|= 16 +| p.key.len +| logicalSize(p.value);
    return total;
}
fn capturedSize(captures: *const Value) u64 {
    return switch (captures.data) {
        .map => |m| blk: {
            var total: u64 = 0;
            for (m) |p| total +|= logicalSize(p.value);
            break :blk total;
        },
        .list => |l| itemsSize(l),
        else => 0,
    };
}
fn queueRelease(node: *Value, pending: *?*Value) void {
    node.references -= 1;
    if (node.references != 0) return;
    node.release_next = pending.*;
    pending.* = node;
}

fn ownershipRank(data: Data) error{OutOfMemory}!u64 {
    var child_rank: u64 = 0;
    switch (data) {
        .list => |items| for (items) |item| {
            child_rank = @max(child_rank, item.ownership_rank);
        },
        .map => |pairs| for (pairs) |pair| {
            child_rank = @max(child_rank, pair.value.ownership_rank);
        },
        .range => |r| child_rank = @max(r.from.ownership_rank, r.to.ownership_rank),
        .function => |f| child_rank = f.captures.ownership_rank,
        else => return 0,
    }
    return std.math.add(u64, child_rank, 1) catch error.OutOfMemory;
}
/// Takes ownership of `data`'s slices and any already-retained children.
/// Keep the small tags visible to callers so they need not build a full Data.
pub inline fn scalar(gpa: std.mem.Allocator, data: Data) !*Value {
    return switch (data) {
        .nothing => narrowScalar(gpa, .nothing, {}),
        .bool => |b| narrowScalar(gpa, .bool, b),
        .number => |n| narrowScalar(gpa, .number, n),
        else => scalarOwned(gpa, data),
    };
}

fn narrowScalar(gpa: std.mem.Allocator, comptime tag: Kind, payload: @FieldType(Data, @tagName(tag))) !*Value {
    // create(Value) poisons the whole node in safe builds. This allocation
    // has exactly the same size, alignment and owner, but initializes every
    // defined field below without requiring inactive union storage to be
    // poisoned. Zig still zero-fills that storage for the void Nothing tag.
    // No inactive payload may be read, including on cached nodes.
    const storage = gpa.rawAlloc(@sizeOf(Value), .of(Value), @returnAddress()) orelse return error.OutOfMemory;
    const v: *Value = @ptrCast(@alignCast(storage));
    v.* = .{ .allocator = gpa, .data = @unionInit(Data, @tagName(tag), payload) };
    return v;
}

fn scalarOwned(gpa: std.mem.Allocator, data: Data) !*Value {
    const rank = try ownershipRank(data);
    const v = try gpa.create(Value);
    v.* = .{ .allocator = gpa, .data = data, .ownership_rank = rank };
    if (data == .text) {
        if (asciiCharacters(data.text)) |n| {
            v.text_ascii = true;
            v.measure = n;
        }
    }
    return v;
}

test "small scalars initialize every header and payload and refuse before publishing" {
    const examples = [_]Data{
        .nothing,
        .{ .bool = false },
        .{ .bool = true },
        .{ .number = try Decimal.parse("-12345678901234567890123456789012.00") },
        .{ .number = try Decimal.parse("0.000") },
    };
    for (examples) |data| {
        var counting = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const gpa = counting.allocator();
        const v = try scalar(gpa, data);
        try std.testing.expectEqual(@as(usize, 1), counting.allocations);
        try std.testing.expectEqual(@sizeOf(Value), counting.allocated_bytes);
        try std.testing.expectEqual(std.meta.activeTag(data), v.kind());
        try std.testing.expectEqual(@as(usize, 1), v.references);
        try std.testing.expectEqual(gpa.ptr, v.allocator.ptr);
        try std.testing.expectEqual(gpa.vtable, v.allocator.vtable);
        try std.testing.expectEqual(@as(u64, 0), v.measure);
        try std.testing.expect(!v.core_message and !v.script_name and !v.text_ascii);
        try std.testing.expectEqual(@as(?*ListStorage, null), v.list_storage);
        try std.testing.expectEqual(@as(u64, 0), v.ownership_rank);
        try std.testing.expectEqual(@as(?*Value, null), v.release_next);
        switch (data) {
            .nothing => try std.testing.expectEqual(@as(u64, 8), logicalSize(v)),
            .bool => |b| {
                try std.testing.expectEqual(b, v.data.bool);
                try std.testing.expectEqual(@as(u64, 8), logicalSize(v));
            },
            .number => |n| {
                try std.testing.expectEqual(n, v.data.number);
                try std.testing.expectEqual(@as(u64, 16), logicalSize(v));
            },
            else => unreachable,
        }
        try std.testing.expectEqual(v, v.retain());
        v.release();
        try std.testing.expectEqual(@as(usize, 1), v.references);
        try std.testing.expectEqual(@as(usize, 0), counting.deallocations);
        v.release();
        try std.testing.expectEqual(counting.allocated_bytes, counting.freed_bytes);
        var refusing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
        try std.testing.expectError(error.OutOfMemory, scalar(refusing.allocator(), data));
        try std.testing.expectEqual(@as(usize, 0), refusing.allocations);
    }
}
/// Text from UTF-8, normalised to NFC. Invalid UTF-8 is refused.
pub fn text(gpa: std.mem.Allocator, s: []const u8) Error!*Value {
    if (!unicode.utf8.validate(s)) return error.InvalidValue;
    return normalizedText(gpa, s);
}

/// Normalises valid UTF-8; callers validate external bytes before reaching here.
fn normalizedText(gpa: std.mem.Allocator, s: []const u8) Error!*Value {
    const normal = try unicode.nfc(gpa, s);
    errdefer gpa.free(normal);
    return scalar(gpa, .{ .text = normal });
}
/// Concatenates UTF-8 text and normalises across the join. ASCII is already
/// NFC, so its joined buffer becomes the Value's storage without a copy.
pub fn concatText(gpa: std.mem.Allocator, left: []const u8, right: []const u8) Error!*Value {
    if (!unicode.utf8.validate(left) or !unicode.utf8.validate(right)) return error.InvalidValue;
    const joined = try std.mem.concat(gpa, u8, &.{ left, right });
    if (asciiCharacters(joined)) |n| return asciiTextOwned(gpa, joined, n);
    defer gpa.free(joined);
    return normalizedText(gpa, joined);
}

/// Concatenates two immutable Text Values, whose bytes are already valid
/// UTF-8/NFC. Unicode still needs normalization across the join; only ASCII
/// can reuse both measurements without scanning the growing prefix.
pub fn concatTextValues(gpa: std.mem.Allocator, left: *const Value, right: *const Value) Error!*Value {
    if (left.data != .text or right.data != .text) return error.InvalidValue;
    const l = left.data.text;
    const r = right.data.text;
    const joined = try std.mem.concat(gpa, u8, &.{ l, r });
    if (left.text_ascii and right.text_ascii) {
        const crlf: u64 = @intFromBool(l.len > 0 and r.len > 0 and l[l.len - 1] == '\r' and r[0] == '\n');
        return asciiTextOwned(gpa, joined, left.measure + right.measure - crlf);
    }
    defer gpa.free(joined);
    return normalizedText(gpa, joined);
}

/// Consumes an owned ASCII buffer, including on allocation refusal.
fn asciiTextOwned(gpa: std.mem.Allocator, joined: []u8, characters: u64) Error!*Value {
    errdefer gpa.free(joined);
    const v = try gpa.create(Value);
    v.* = .{ .allocator = gpa, .data = .{ .text = joined }, .text_ascii = true, .measure = characters };
    return v;
}

fn asciiCharacters(s: []const u8) ?u64 {
    var n: u64 = 0;
    var previous: u8 = 0;
    for (s) |b| {
        if (b >= 0x80) return null;
        n += @intFromBool(b != '\n' or previous != '\r');
        previous = b;
    }
    return n;
}

/// Exact Characters of a Text, reusing immutable ASCII metadata when known.
pub fn textCharacters(v: *const Value) u64 {
    std.debug.assert(v.data == .text);
    return if (v.text_ascii) v.measure else unicode.grapheme.count(v.data.text);
}

fn concatTextAllocations(gpa: std.mem.Allocator) !void {
    const cases = [_][3][]const u8{
        .{ "ab", "cd", "abcd" },
        .{ "", "", "" },
        .{ "e", "\u{0301}", "\u{00e9}" },
        .{ "\u{1100}", "\u{1161}", "\u{ac00}" },
        .{ "a\u{0302}", "\u{0323}", "\u{1ead}" },
    };
    for (cases) |case| {
        const joined = try concatText(gpa, case[0], case[1]);
        defer joined.release();
        try std.testing.expectEqualStrings(case[2], joined.data.text);
    }
}

test "Text concatenation normalises across joins and frees every failed allocation" {
    try concatTextAllocations(std.testing.allocator);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, concatTextAllocations, .{});
    try std.testing.expectError(error.InvalidValue, concatText(std.testing.allocator, "\xff", "x"));
    try std.testing.expectError(error.InvalidValue, concatText(std.testing.allocator, "x", "\xff"));
}

fn concatTextValuesAllocations(gpa: std.mem.Allocator) !void {
    const cases = [_][3][]const u8{
        .{ "ab", "cd", "abcd" },
        .{ "", "", "" },
        .{ "", "\r\n", "\r\n" },
        .{ "\r\n", "", "\r\n" },
        .{ "a\r", "\nb\r\n", "a\r\nb\r\n" },
        .{ "e", "\u{0301}", "é" },
        .{ "\u{1100}", "\u{1161}", "가" },
        .{ "가", "\u{11a8}", "각" },
        .{ "a\u{0302}", "\u{0323}", "ậ" },
        .{ "é", "a", "éa" },
        .{ "a", "é", "aé" },
        .{ "👨\u{200d}", "👩\u{200d}👧", "👨\u{200d}👩\u{200d}👧" },
        .{ "🇬", "🇧🇫", "🇬🇧🇫" },
        .{ "क्", "ष", "क्ष" },
        .{ "\u{0600}", "a", "\u{0600}a" },
    };
    for (cases) |case| {
        const left = try text(gpa, case[0]);
        defer left.release();
        const right = try text(gpa, case[1]);
        defer right.release();
        // Retained old Values, including their counts, must survive the join.
        const old_left = try gpa.dupe(u8, left.data.text);
        defer gpa.free(old_left);
        const old_right = try gpa.dupe(u8, right.data.text);
        defer gpa.free(old_right);
        const joined = try concatTextValues(gpa, left, right);
        defer joined.release();
        try std.testing.expectEqualStrings(case[2], joined.data.text);
        try std.testing.expectEqualStrings(old_left, left.data.text);
        try std.testing.expectEqualStrings(old_right, right.data.text);
        for ([_]*Value{ left, right, joined }) |v| {
            try std.testing.expectEqual(unicode.normalize.isAscii(v.data.text), v.text_ascii);
            try std.testing.expectEqual(@as(u64, unicode.grapheme.count(v.data.text)), textCharacters(v));
            try std.testing.expectEqual(@as(u64, 16 + v.data.text.len), logicalSize(v));
        }
    }
}

test "trusted Text joins preserve NFC, Characters, retained operands and allocation refusal" {
    try concatTextValuesAllocations(std.testing.allocator);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, concatTextValuesAllocations, .{});
}

test "ASCII metadata counts every control pair and survives either join association" {
    const gpa = std.testing.allocator;
    // Includes every ASCII byte, NUL and the CR/LF pair split at each point.
    var bytes_: [130]u8 = undefined;
    for (bytes_[0..128], 0..) |*b, i| b.* = @intCast(i);
    bytes_[128..].* = .{ '\r', '\n' };
    for (0..bytes_.len + 1) |i| {
        const left = try text(gpa, bytes_[0..i]);
        defer left.release();
        const right = try text(gpa, bytes_[i..]);
        defer right.release();
        const joined = try concatTextValues(gpa, left, right);
        defer joined.release();
        try std.testing.expectEqualStrings(&bytes_, joined.data.text);
        try std.testing.expectEqual(@as(u64, unicode.grapheme.count(&bytes_)), textCharacters(joined));
    }
    for ([_][]const u8{ "", "\r", "\n", "\r\n", "\n\r", "x" }) |s| {
        for ([_][]const u8{ "", "\r", "\n", "\r\n", "\n\r", "x" }) |t| {
            const a = try text(gpa, s);
            defer a.release();
            const b = try text(gpa, t);
            defer b.release();
            const ab = try concatTextValues(gpa, a, b);
            defer ab.release();
            const abb = try concatTextValues(gpa, ab, b);
            defer abb.release();
            const bb = try concatTextValues(gpa, b, b);
            defer bb.release();
            const a_bb = try concatTextValues(gpa, a, bb);
            defer a_bb.release();
            try std.testing.expectEqualStrings(abb.data.text, a_bb.data.text);
            try std.testing.expectEqual(textCharacters(abb), textCharacters(a_bb));
            try std.testing.expectEqual(@as(u64, unicode.grapheme.count(abb.data.text)), textCharacters(abb));
        }
    }
}

test "untrusted Text input still refuses strict UTF-8 errors" {
    for ([_][]const u8{ "\xff", "\xc0\x80", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xe2\x82" }) |s| {
        try std.testing.expectError(error.InvalidValue, text(std.testing.allocator, s));
        try std.testing.expectError(error.InvalidValue, concatText(std.testing.allocator, s, ""));
        try std.testing.expectError(error.InvalidValue, concatText(std.testing.allocator, "", s));
    }
}

/// Bytes, copied from `s`.
pub fn bytes(gpa: std.mem.Allocator, s: []const u8) Error!*Value {
    const copy = try gpa.dupe(u8, s);
    errdefer gpa.free(copy);
    return scalar(gpa, .{ .bytes = copy });
}
/// A list that retains each item.
pub fn list(gpa: std.mem.Allocator, items: []const *Value) Error!*Value {
    const copy = try gpa.dupe(*Value, items);
    errdefer gpa.free(copy);
    const v = try scalar(gpa, .{ .list = copy });
    v.measure = itemsSize(items);
    for (items) |item| _ = item.retain();
    return v;
}
/// Adds borrowed items to either end, returning a new immutable List version.
/// Only unused capacity is written when the newest span can be extended.
/// Otherwise a geometrically larger buffer copies and retains the spine.
/// New storage belongs to `gpa`; a different allocator's spine is copied.
pub fn listGrow(gpa: std.mem.Allocator, old: *Value, items: []const *Value, after: bool) Error!*Value {
    if (old.data != .list) return error.InvalidValue;
    var child_rank: u64 = 0;
    for (items) |item| child_rank = @max(child_rank, item.ownership_rank);
    const measure = old.measure +| itemsSize(items);
    if (items.len == 0) return old.retain();
    const same_allocator = gpa.ptr == old.allocator.ptr and gpa.vtable == old.allocator.vtable;
    const length = std.math.add(usize, old.data.list.len, items.len) catch return error.OutOfMemory;
    if (old.list_storage) |storage| {
        const newest = same_allocator and old.data.list.ptr == storage.buffer[storage.start..].ptr and old.data.list.len == storage.end - storage.start;
        const spare = if (after) storage.buffer.len - storage.end else storage.start;
        // Ranks decrease along every physical ownership edge. Extending
        // the buffer with lower-ranked children cannot introduce a cycle,
        // including one through another version's hidden items.
        const safe = newest and items.len <= spare and child_rank < old.ownership_rank;
        if (safe) {
            const start = if (after) storage.start else storage.start - items.len;
            const end = if (after) storage.end + items.len else storage.end;
            const next = try gpa.create(Value);
            next.* = .{ .allocator = gpa, .data = .{ .list = storage.buffer[start..end] }, .ownership_rank = old.ownership_rank };
            const added = if (after) storage.buffer[storage.end..end] else storage.buffer[start..storage.start];
            for (added, items) |*slot, item| slot.* = item.retain();
            storage.start = start;
            storage.end = end;
            storage.references += 1;
            next.list_storage = storage;
            next.measure = measure;
            return next;
        }
    }
    // Base capacity on this version's length, not a larger buffer kept by
    // an old snapshot: repeatedly branching must not double unused memory.
    const capacity = @max(@as(usize, 8), std.math.mul(usize, length, 2) catch return error.OutOfMemory);
    const rank = std.math.add(u64, @max(old.ownership_rank, child_rank), 1) catch return error.OutOfMemory;
    const storage = try gpa.create(ListStorage);
    errdefer gpa.destroy(storage);
    const buffer = try gpa.alloc(*Value, capacity);
    errdefer gpa.free(buffer);
    const start = (capacity - length) / 2;
    const end = start + length;
    const next = try gpa.create(Value);
    next.* = .{ .allocator = gpa, .data = .{ .list = buffer[start..end] }, .ownership_rank = rank };
    storage.* = .{ .buffer = buffer, .start = start, .end = end };
    next.list_storage = storage;
    next.measure = measure;
    const first = if (after) old.data.list else items;
    const second = if (after) items else old.data.list;
    for (buffer[start..][0..first.len], first) |*slot, item| slot.* = item.retain();
    for (buffer[start + first.len .. end], second) |*slot, item| slot.* = item.retain();
    return next;
}

test "List growth preserves snapshots, branches, interior writes and self-insertion" {
    const gpa = std.testing.allocator;
    const one = try scalar(gpa, .{ .number = try Decimal.parse("1") });
    defer one.release();
    const two = try scalar(gpa, .{ .number = try Decimal.parse("2") });
    defer two.release();
    const empty = try list(gpa, &.{});
    defer empty.release();
    const first = try listGrow(gpa, empty, &.{one}, true);
    defer first.release();
    var latest = try listGrow(gpa, first, &.{two}, true);
    defer latest.release();
    try std.testing.expectEqual(@as(usize, 1), first.data.list.len);
    try std.testing.expectEqual(@as(usize, 2), latest.data.list.len);
    const branch = try listGrow(gpa, first, &.{one}, true);
    defer branch.release();
    try std.testing.expectEqual(two, latest.data.list[1]);
    try std.testing.expectEqual(one, branch.data.list[1]);
    const prepended = try listGrow(gpa, latest, &.{ two, one }, false);
    defer prepended.release();
    try std.testing.expectEqualSlices(*Value, &.{ two, one, one, two }, prepended.data.list);
    try listSet(gpa, &latest, 0, two);
    try std.testing.expectEqual(one, first.data.list[0]);
    try std.testing.expectEqual(one, prepended.data.list[2]);
    const older_self = try listGrow(gpa, prepended, &.{first}, true);
    defer older_self.release();
    try std.testing.expectEqual(first, older_self.data.list[4]);
    const self = try listGrow(gpa, first, &.{first}, true);
    defer self.release();
    try std.testing.expectEqual(first, self.data.list[1]);
    // A different version and a nested child may also hold the same storage.
    const nested = try map(gpa, &.{.{ .key = "snapshot", .value = prepended }});
    defer nested.release();
    const nested_self = try listGrow(gpa, prepended, &.{nested}, true);
    defer nested_self.release();
    try std.testing.expectEqual(nested, nested_self.data.list[4]);
    const unchanged = try listGrow(gpa, prepended, &.{}, true);
    defer unchanged.release();
    try std.testing.expect(try prepended.equal(unchanged));
}

test "List growth preserves snapshots when ownership ranks require a copy" {
    const gpa = std.testing.allocator;
    const item = try scalar(gpa, .nothing);
    defer item.release();
    const empty = try list(gpa, &.{});
    defer empty.release();
    const target = try listGrow(gpa, empty, &.{item}, true);
    defer target.release();
    const prefix = try listGrow(gpa, empty, &.{item}, true);
    defer prefix.release();
    const tail = try listGrow(gpa, prefix, &.{target}, true);
    defer tail.release();
    const result = try listGrow(gpa, target, &.{prefix}, true);
    defer result.release();
    try std.testing.expectEqual(prefix, result.data.list[1]);
    try std.testing.expectEqual(target, tail.data.list[1]);
}

test "constant-size snapshot growth preserves shallow visible values" {
    const gpa = std.testing.allocator;
    const item = try scalar(gpa, .nothing);
    defer item.release();
    const empty = try list(gpa, &.{});
    defer empty.release();
    var root = try listGrow(gpa, empty, &.{item}, true);
    defer root.release();
    for (0..1000) |_| {
        const prefix = try listGrow(gpa, empty, &.{item}, true);
        errdefer prefix.release();
        const tail = try listGrow(gpa, prefix, &.{root}, true);
        tail.release();
        root.release();
        root = prefix;
    }
    try std.testing.expectEqual(@as(u64, 8), root.measure);
    const grown = try listGrow(gpa, root, &.{item}, true);
    defer grown.release();
}

test "List growth and shared writes free everything after any allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, listGrowthAllocations, .{});
}

fn listGrowthAllocations(gpa: std.mem.Allocator) !void {
    const item = try scalar(gpa, .nothing);
    defer item.release();
    var root = try list(gpa, &.{});
    defer root.release();
    for (0..40) |i| {
        const next = try listGrow(gpa, root, &.{item}, i % 2 == 0);
        root.release();
        root = next;
    }
    const snapshot = root.retain();
    defer snapshot.release();
    try listSet(gpa, &root, 0, item);
    const self = try listGrow(gpa, root, &.{root}, true);
    defer self.release();
    const wrapped = try map(gpa, &.{.{ .key = "snapshot", .value = root }});
    defer wrapped.release();
    const nested = try listGrow(gpa, self, &.{wrapped}, true);
    defer nested.release();
}
/// A map in insertion order that retains each value and copies each key as
/// NFC. A key duplicated after normalisation is refused.
pub fn map(gpa: std.mem.Allocator, pairs: []const Pair) Error!*Value {
    const out = try gpa.alloc(Pair, pairs.len);
    var initialized: usize = 0;
    errdefer freePairs(gpa, out[0..initialized], out);
    for (pairs) |p| {
        if (!unicode.utf8.validate(p.key)) return error.InvalidValue;
        const key = try unicode.nfc(gpa, p.key);
        errdefer gpa.free(key);
        for (out[0..initialized]) |old| if (std.mem.eql(u8, old.key, key)) return error.InvalidValue;
        out[initialized] = .{ .key = key, .value = p.value.retain() };
        initialized += 1;
    }
    return mapOwned(gpa, out);
}
/// Releases the first `initialized` pairs of `storage`, then `storage`.
fn freePairs(gpa: std.mem.Allocator, initialized: []const Pair, storage: []Pair) void {
    for (initialized) |p| {
        gpa.free(p.key);
        p.value.release();
    }
    gpa.free(storage);
}
/// A map over valid, NFC and unique owned keys with retained values. Takes
/// ownership of `pairs` only on success.
fn mapOwned(gpa: std.mem.Allocator, pairs: []Pair) Error!*Value {
    const rank = try ownershipRank(.{ .map = pairs });
    const v = try gpa.create(Value);
    v.* = .{ .allocator = gpa, .data = .{ .map = pairs }, .measure = pairsSize(pairs), .ownership_rank = rank };
    return v;
}
/// A range that retains both ends, which must be numbers or compatible
/// Quantities.
pub fn range(gpa: std.mem.Allocator, from: *Value, to: *Value) Error!*Value {
    if (from.kind() != to.kind() or (from.data != .number and from.data != .quantity)) return error.InvalidValue;
    if (from.data == .quantity and !from.data.quantity.unit.compatible(&to.data.quantity.unit)) return error.IncompatibleUnits;
    const v = try scalar(gpa, .{ .range = .{ .from = from, .to = to } });
    v.measure = logicalSize(from) +| logicalSize(to);
    _ = from.retain();
    _ = to.retain();
    return v;
}
/// A Quantity from a number and Unit source; an empty Unit gives a number.
pub fn quantity(gpa: std.mem.Allocator, n: Decimal, unit: []const u8) Error!*Value {
    const normalized = try units.Unit.parseQuantity(gpa, n, unit);
    return scalar(gpa, if (normalized.unit.empty()) .{ .number = normalized.number } else .{ .quantity = .{ .number = normalized.number, .unit = normalized.unit } });
}
/// Consumes one reference to the old root only on success. A changed root
/// cannot form a cycle, even when a caller inserts the old root into itself.
/// New storage belongs to `gpa`; foreign or shared spines are copied once.
pub fn listSet(gpa: std.mem.Allocator, root: **Value, index: usize, item: *Value) Error!void {
    const old = root.*;
    if (old.data != .list or index >= old.data.list.len) return error.InvalidValue;
    // Only lower-ranked children may enter existing storage: a higher rank
    // can reach it through another version's hidden tail, even when a walk
    // of that version's visible children would find no cycle. This copies
    // more than a reachability walk would, but only the first write that
    // raises the rank pays it. Machine chunk writes retain their root and
    // always copy, so only direct callers of this branch see the difference.
    const same_allocator = gpa.ptr == old.allocator.ptr and gpa.vtable == old.allocator.vtable;
    const unique_storage = if (old.list_storage) |storage| storage.references == 1 else true;
    const rank = std.math.add(u64, item.ownership_rank, 1) catch return error.OutOfMemory;
    // Subtraction is exact unless the old sum saturated; in that case the
    // changed contents must be measured again after replacing the item.
    const measure: ?u64 = if (old.measure == std.math.maxInt(u64)) null else old.measure - logicalSize(old.data.list[index]) +| logicalSize(item);
    if (same_allocator and old.references == 1 and unique_storage and item.ownership_rank < old.ownership_rank) {
        _ = item.retain();
        old.data.list[index].release();
        old.data.list[index] = item;
        old.measure = measure orelse itemsSize(old.data.list);
    } else {
        const copy = try gpa.dupe(*Value, old.data.list);
        errdefer gpa.free(copy);
        const v = try gpa.create(Value);
        copy[index] = item;
        // The prior rank already exceeds every retained child's rank.
        // A replacement can only raise it. No child scan is needed.
        v.* = .{
            .allocator = gpa,
            .data = .{ .list = copy },
            .ownership_rank = @max(old.ownership_rank, rank),
            .measure = measure orelse itemsSize(copy),
        };
        for (copy) |child| _ = child.retain();
        root.* = v;
        old.release();
    }
}

test "copy-on-write never changes an alias and every reference is freed" {
    const gpa = std.testing.allocator;
    const one = try scalar(gpa, .{ .number = try Decimal.parse("1") });
    defer one.release();
    const two = try scalar(gpa, .{ .number = try Decimal.parse("2") });
    defer two.release();
    const original = try list(gpa, &.{one});
    defer original.release();
    var copy = original.retain();
    defer copy.release();
    try listSet(gpa, &copy, 0, two);
    try std.testing.expect(try original.data.list[0].equal(one));
    try std.testing.expect(try copy.data.list[0].equal(two));
    try listSet(gpa, &copy, 0, copy); // An immutable previous version, never a cycle.
    try std.testing.expect(copy.data.list[0] != copy);
}
test "NFC duplicate keys and map equality independent of order" {
    const gpa = std.testing.allocator;
    const n = try scalar(gpa, .nothing);
    defer n.release();
    try std.testing.expectError(error.InvalidValue, map(gpa, &.{ .{ .key = "é", .value = n }, .{ .key = "e\u{0301}", .value = n } }));
    const x = try map(gpa, &.{ .{ .key = "a", .value = n }, .{ .key = "b", .value = n } });
    defer x.release();
    const y = try map(gpa, &.{ .{ .key = "b", .value = n }, .{ .key = "a", .value = n } });
    defer y.release();
    try std.testing.expect(try x.equal(y));
}

/// A map write keeps an existing key's position and appends a new key last.
/// The prior root stays immutable, including self-insertion.
pub fn mapSet(root: **Value, key: []const u8, item: *Value) Error!void {
    const old = root.*;
    if (old.data != .map) return error.InvalidValue;
    const gpa = old.allocator;
    if (!unicode.utf8.validate(key)) return error.InvalidValue;
    const normalized = try unicode.nfc(gpa, key);
    defer gpa.free(normalized);
    var index: usize = old.data.map.len;
    for (old.data.map, 0..) |p, i| if (std.mem.eql(u8, p.key, normalized)) {
        index = i;
        break;
    };

    // Existing keys are already valid, NFC and unique, so copy their owned
    // bytes without the external constructor's scans. Build privately so
    // refusal cannot change the old root or children.
    const pairs = try gpa.alloc(Pair, old.data.map.len + @intFromBool(index == old.data.map.len));
    var initialized: usize = 0;
    errdefer freePairs(gpa, pairs[0..initialized], pairs);
    for (pairs, 0..) |*p, i| {
        const source_key = if (i < old.data.map.len) old.data.map[i].key else normalized;
        const child = if (i == index) item else old.data.map[i].value;
        p.* = .{ .key = try gpa.dupe(u8, source_key), .value = child.retain() };
        initialized += 1;
    }
    const next = try mapOwned(gpa, pairs);
    next.core_message = old.core_message and !std.mem.eql(u8, normalized, "message");
    root.* = next;
    old.release();
}
/// Applies `op` to numbers or Quantities, converting through Base Units.
pub fn arithmetic(gpa: std.mem.Allocator, op: decimal.Operator, x: *Value, y: *Value) Error!*Value {
    if (x.data == .number and y.data == .number) return scalar(gpa, .{ .number = try decimal.calculate(gpa, op, x.data.number, y.data.number) });
    if (op == .div or op == .mod) return error.InvalidValue;
    if (op == .add or op == .subtract) {
        if (x.data != .quantity or y.data != .quantity) return error.InvalidValue;
        const l = x.data.quantity;
        const r = y.data.quantity;
        if (!l.unit.compatible(&r.unit)) return error.IncompatibleUnits;
        const rhs = try l.unit.fromBase(gpa, try r.unit.toBase(gpa, r.number));
        return scalar(gpa, .{ .quantity = .{ .number = try decimal.calculate(gpa, op, l.number, rhs), .unit = l.unit } });
    }
    const l: Quantity = switch (x.data) {
        .quantity => |q| q,
        .number => |n| .{ .number = n, .unit = .{} },
        else => return error.InvalidValue,
    };
    const r: Quantity = switch (y.data) {
        .quantity => |q| q,
        .number => |n| .{ .number = n, .unit = .{} },
        else => return error.InvalidValue,
    };
    const u = try units.Unit.combine(&l.unit, &r.unit, op == .divide);
    const base = try decimal.calculate(gpa, op, try l.unit.toBase(gpa, l.number), try r.unit.toBase(gpa, r.number));
    const n = try u.fromBase(gpa, base);
    return scalar(gpa, if (u.empty()) .{ .number = n } else .{ .quantity = .{ .number = n, .unit = u } });
}

test "exact number arithmetic still allocates an immutable result and refuses atomically" {
    const gpa = std.testing.allocator;
    const x = try scalar(gpa, .{ .number = try Decimal.parse("2.50") });
    defer x.release();
    const y = try scalar(gpa, .{ .number = try Decimal.parse("2") });
    defer y.release();
    for ([_]decimal.Operator{ .add, .subtract, .multiply, .divide, .div, .mod }) |op| {
        var counting = std.testing.FailingAllocator.init(gpa, .{});
        const result = try arithmetic(counting.allocator(), op, x, y);
        try std.testing.expectEqual(@as(usize, 1), counting.allocations);
        try std.testing.expectEqual(@as(usize, @sizeOf(Value)), counting.allocated_bytes);
        result.release();
        try std.testing.expectEqual(counting.allocated_bytes, counting.freed_bytes);
        var refusing = std.testing.FailingAllocator.init(gpa, .{ .fail_index = 0 });
        try std.testing.expectError(error.OutOfMemory, arithmetic(refusing.allocator(), op, x, y));
        try std.testing.expectEqual(try Decimal.parse("2.50"), x.data.number);
        try std.testing.expectEqual(try Decimal.parse("2"), y.data.number);
    }
}

test "quantity arithmetic follows kind-order Base Unit factors" {
    const gpa = std.testing.allocator;
    const examples = .{
        .{ decimal.Operator.add, "5 kg", "250 g", "5.250 kg" },
        .{ decimal.Operator.divide, "4 yd", "2 ft", "6" },
        .{ decimal.Operator.multiply, "2 m", "3 ft", "1.8288 m^2" },
        .{ decimal.Operator.multiply, "100 EUR", "1.1 USD/EUR", "110.0 USD" },
        .{ decimal.Operator.multiply, "60 mi/hr", "2 hr", "120.0 mi" },
    };
    inline for (examples) |example| {
        const display = @import("display.zig");
        const x = try display.parse(gpa, example[1], .{});
        defer x.release();
        const y = try display.parse(gpa, example[2], .{});
        defer y.release();
        const result = try arithmetic(gpa, example[0], x, y);
        defer result.release();
        const s = try display.string(gpa, result);
        defer gpa.free(s);
        try std.testing.expectEqualStrings(example[3], s);
    }
    const x = try quantity(gpa, try Decimal.parse("1000000000000000000000000000000000"), "km");
    defer x.release();
    const y = try quantity(gpa, try Decimal.parse("1000000000000000000000000000000000"), "m");
    defer y.release();
    try std.testing.expectEqual(std.math.Order.gt, try x.order(y));
    try std.testing.expect(!try x.equal(y));
}
test "equality never errors and ordering follows Value Semantics" {
    const gpa = std.testing.allocator;
    const display = @import("display.zig");
    const equal = .{
        .{ "1.0", "1", true },
        .{ "1", "\"1\"", false },
        .{ "5", "5 kg", false },
        .{ "nothing", "\"\"", false },
        .{ "5 kg", "5000 g", true },
        .{ "1 L", "1000 mL", true },
        .{ "5 kg", "5 m", false },
        .{ "1 month", "30 days", false },
        .{ "2026-09-27", "2026-09-27T00:00:00", false },
        .{ "[1, 2]", "[1.00, 2]", true },
        .{ "1..2", "1.0..2", true },
    };
    inline for (equal) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectEqual(example[2], try x.equal(y));
    }
    const less = .{
        .{ "1", "2" },
        .{ "999 g", "1 kg" },
        .{ "\"Zebra\"", "\"apple\"" },
        .{ "\"ab\"", "\"abc\"" },
        .{ "<<0x01, 0xFF>>", "<<0x02>>" },
        .{ "<<0x01>>", "<<0x01, 0x00>>" },
        .{ "1969-12-31T23:59:59.999999999Z", "1970-01-01T00:00:00Z" },
        .{ "2026-09-26", "2026-09-27" },
        .{ "2026-09-27T14:30:00", "2026-09-27T14:30:00.5" },
        .{ "[1, \"b\"]", "[2, \"a\"]" },
        .{ "[1, 2]", "[1, 2, 0]" },
    };
    inline for (less) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectEqual(std.math.Order.lt, try x.order(y));
        try std.testing.expectEqual(std.math.Order.gt, try y.order(x));
    }
    const unordered = .{
        .{ "1", "\"1\"" },
        .{ "5 kg", "5 m" },
        .{ "2026-09-27", "2026-09-27T00:00:00" },
        .{ "true", "false" },
        .{ "nothing", "nothing" },
        .{ "{a: 1}", "{a: 2}" },
        .{ "1..2", "1..3" },
        .{ "[1, \"a\"]", "[1, 2]" },
    };
    inline for (unordered) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        try std.testing.expectError(error.CantCompare, x.order(y));
    }
}
test "shared values compare in distinct pairs and scan in logical pairs" {
    const gpa = std.testing.allocator;
    // [v, v] shared 30 deep: 2^30 logical paths, 31 distinct nodes (#890).
    const build = struct {
        fn shared(alloc: std.mem.Allocator, leaf: []const u8) !*Value {
            var v = try scalar(alloc, .{ .number = try Decimal.parse(leaf) });
            for (0..30) |_| {
                const next = try list(alloc, &.{ v, v });
                v.release();
                v = next;
            }
            return v;
        }
    }.shared;
    const a = try build(gpa, "1");
    defer a.release();
    const b = try build(gpa, "1");
    defer b.release();
    const c = try build(gpa, "2");
    defer c.release();
    try std.testing.expect(try a.equal(b));
    try std.testing.expect(!(try a.equal(c)));
    try std.testing.expectEqual(std.math.Order.lt, try a.order(c));
    var comparer = Comparer.init(gpa);
    defer comparer.deinit();
    // Each list pair counts 1 plus its items' counts: 2^31 - 2 in all.
    try std.testing.expectEqual(@as(u64, (1 << 31) - 2), try comparer.scanned(a, b));
    try std.testing.expectEqual(@as(u64, (1 << 31) - 2), try comparer.selfScan(a));
    // A differing leaf is found down the first path: 30 item pairs.
    try std.testing.expectEqual(@as(u64, 30), try comparer.scanned(a, c));
}
test "folded comparisons scan folded Characters and keep keys and Patterns exact" {
    const gpa = std.testing.allocator;
    const display = @import("display.zig");
    const examples = .{
        .{ "\"A\"", "\"a\"", true, 1 },
        .{ "\"AB\"", "\"ac\"", false, 2 },
        .{ "\"a\u{0345}\"", "\"aι\"", true, 2 },
        .{ "\"ẞ\"", "\"ß\"", true, 1 },
        .{ "\"ß\"", "\"ss\"", false, 1 },
        .{ "\"İ\"", "\"i\"", false, 1 },
        .{ "[\"A\", [\"Σ\"]]", "[\"a\", [\"ς\"]]", true, 5 },
        .{ "{key: [\"A\"]}", "{key: [\"a\"]}", true, 3 },
        .{ "{A: \"X\"}", "{a: \"x\"}", false, 1 },
        .{ "<\"A\">", "<\"a\">", false, 0 },
    };
    inline for (examples) |example| {
        const x = try display.parse(gpa, example[0], .{});
        defer x.release();
        const y = try display.parse(gpa, example[1], .{});
        defer y.release();
        var comparer = Comparer.initFolded(gpa, true);
        defer comparer.deinit();
        try std.testing.expectEqual(example[2], try comparer.equal(x, y));
        try std.testing.expectEqual(@as(u64, example[3]), try comparer.scanned(x, y));
    }
    const x = try display.parse(gpa, "[{key: \"A\"}, \"B\"]", .{});
    defer x.release();
    const y = try display.parse(gpa, "[{key: \"a\"}, \"c\"]", .{});
    defer y.release();
    var comparer = Comparer.initFolded(gpa, true);
    defer comparer.deinit();
    try std.testing.expectEqual(std.math.Order.lt, try comparer.order(x, y));
    try std.testing.expectEqual(std.math.Order.gt, try comparer.order(y, x));
    try std.testing.expectEqual(@as(u64, 5), try comparer.scanned(x, y));
    try std.testing.expectError(error.CantCompare, x.order(y));
}
test "folded shared comparisons charge every occurrence without expanding sharing" {
    const gpa = std.testing.allocator;
    const build = struct {
        fn shared(alloc: std.mem.Allocator, leaf: []const u8) !*Value {
            var v = try text(alloc, leaf);
            for (0..30) |_| {
                const next = try list(alloc, &.{ v, v });
                v.release();
                v = next;
            }
            return v;
        }
    }.shared;
    const x = try build(gpa, "A\u{0345}");
    defer x.release();
    const y = try build(gpa, "aι");
    defer y.release();
    const z = try build(gpa, "bι");
    defer z.release();
    var comparer = Comparer.initFolded(gpa, true);
    defer comparer.deinit();
    try std.testing.expect(try comparer.equal(x, y));
    try std.testing.expectEqual(std.math.Order.eq, try comparer.order(x, y));
    // 2^31 - 2 list pairs plus two folded Characters at each of 2^30 leaves.
    try std.testing.expectEqual(@as(u64, (1 << 32) - 2), try comparer.scanned(x, y));
    try std.testing.expectEqual(@as(u64, (1 << 32) - 2), try comparer.selfScan(x));
    try std.testing.expectEqual(@as(u64, 31), try comparer.scanned(x, z));
    try std.testing.expectEqual(std.math.Order.lt, try comparer.order(x, z));
}
test "map copy-on-write and preserved insertion order" {
    const gpa = std.testing.allocator;
    const n = try scalar(gpa, .nothing);
    defer n.release();
    const original = try map(gpa, &.{.{ .key = "a", .value = n }});
    defer original.release();
    var copy = original.retain();
    defer copy.release();
    try mapSet(&copy, "b", n);
    try mapSet(&copy, "a", copy);
    try std.testing.expect(original.get("b") == null);
    try std.testing.expectEqualStrings("a", copy.data.map[0].key);
    try std.testing.expectEqualStrings("b", copy.data.map[1].key);
    try std.testing.expect(copy.get("a").? != copy);
}

fn mapUpdateAllocations(gpa: std.mem.Allocator) !void {
    const one = try scalar(gpa, .nothing);
    defer one.release();
    var root = try map(gpa, &.{ .{ .key = "é", .value = one }, .{ .key = "tail", .value = one } });
    defer root.release();
    const snapshot = root.retain();
    defer snapshot.release();
    root.core_message = true;
    try checkedMapSet(&root, "e\u{0301}", snapshot);
    try std.testing.expectEqual(@as(usize, 2), root.data.map.len);
    try std.testing.expectEqualStrings("é", root.data.map[0].key);
    try std.testing.expectEqualStrings("tail", root.data.map[1].key);
    try std.testing.expectEqual(snapshot, root.get("é").?);
    try std.testing.expectEqual(one, snapshot.get("é").?);
    try std.testing.expect(root.ownership_rank > snapshot.ownership_rank);
    try std.testing.expect(root.core_message);
    const nested = try list(gpa, &.{root});
    defer nested.release();
    try checkedMapSet(&root, "nested", nested);
    try std.testing.expectEqualStrings("nested", root.data.map[2].key);
    try std.testing.expect(root.ownership_rank > nested.ownership_rank);
    try checkedMapSet(&root, "message", one);
    try std.testing.expect(!root.core_message);
    const before = root;
    try std.testing.expectError(error.InvalidValue, mapSet(&root, "\xff", one));
    try std.testing.expectEqual(before, root);
}

fn checkedMapSet(root: **Value, key: []const u8, item: *Value) !void {
    const old = root.*;
    const old_references = old.references;
    const item_references = item.references;
    mapSet(root, key, item) catch |err| {
        try std.testing.expectEqual(old, root.*);
        try std.testing.expectEqual(old_references, old.references);
        try std.testing.expectEqual(item_references, item.references);
        return err;
    };
}

test "Map writes normalize only incoming keys and preserve nested snapshots on refusal" {
    try mapUpdateAllocations(std.testing.allocator);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, mapUpdateAllocations, .{});
}

/// Objects are made by a Group, not a Host value constructor. These identity
/// fields are the seam for step 1.4's handles and the encoding resolver.
pub fn object(gpa: std.mem.Allocator, kind: []const u8, id: []const u8, identity: usize) Error!*Value {
    if (!unicode.utf8.validate(kind) or !unicode.utf8.validate(id)) return error.InvalidValue;
    const k = try gpa.dupe(u8, kind);
    errdefer gpa.free(k);
    const s = try unicode.nfc(gpa, id);
    errdefer gpa.free(s);
    return scalar(gpa, .{ .object = .{ .kind = k, .id = s, .identity = identity } });
}
/// A Function Value that retains its captures.
pub fn function(gpa: std.mem.Allocator, home: []const u8, source: []const u8, identity: usize, captures: *Value) Error!*Value {
    const h = try gpa.dupe(u8, home);
    errdefer gpa.free(h);
    const s = try gpa.dupe(u8, source);
    errdefer gpa.free(s);
    const v = try scalar(gpa, .{ .function = .{ .home = h, .display = s, .identity = identity, .captures = captures } });
    _ = captures.retain();
    v.measure = capturedSize(captures);
    return v;
}

test "List point writes reuse unique storage and copy for ranks, aliases and foreign allocators" {
    const gpa = std.testing.allocator;
    const one = try scalar(gpa, .{ .number = Decimal.fromInt(1) });
    defer one.release();
    const two = try scalar(gpa, .{ .number = Decimal.fromInt(2) });
    defer two.release();
    var root = try list(gpa, &.{one});
    defer root.release();
    const address = root;
    try listSet(gpa, &root, 0, two);
    try std.testing.expectEqual(address, root);
    try std.testing.expectEqual(@as(u64, 16), root.measure);
    // An equal-ranked child forces a new ownership rank, even if acyclic.
    const child = try list(gpa, &.{one});
    defer child.release();
    try listSet(gpa, &root, 0, child);
    try std.testing.expect(root != address);
    try std.testing.expect(root.ownership_rank > child.ownership_rank);
    // Only the first rank-raising write copies: later equal-shaped children
    // now rank below the root and reuse its storage.
    const raised = root;
    const sibling = try list(gpa, &.{two});
    defer sibling.release();
    try listSet(gpa, &root, 0, sibling);
    try std.testing.expectEqual(raised, root);
    const snapshot = root.retain();
    defer snapshot.release();
    try listSet(gpa, &root, 0, root);
    try std.testing.expectEqual(snapshot, root.data.list[0]);
    try std.testing.expectEqual(sibling, snapshot.data.list[0]);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var foreign = try list(arena.allocator(), &.{one});
    defer foreign.release();
    const host = foreign.retain();
    defer host.release();
    try listSet(gpa, &foreign, 0, two);
    try std.testing.expectEqual(gpa.ptr, foreign.allocator.ptr);
    try std.testing.expectEqual(one, host.data.list[0]);
    try std.testing.expectEqual(two, foreign.data.list[0]);
}

test "List point writes recover exact measures after a saturated sum" {
    const gpa = std.testing.allocator;
    const item = try scalar(gpa, .nothing);
    defer item.release();
    var large = item.retain();
    defer large.release();
    for (0..64) |_| {
        const next = try list(gpa, &.{ large, large });
        large.release();
        large = next;
    }
    var root = try list(gpa, &.{ large, large });
    defer root.release();
    const snapshot = root.retain();
    defer snapshot.release();
    try listSet(gpa, &root, 0, item);
    try std.testing.expectEqual(std.math.maxInt(u64), root.measure);
    try listSet(gpa, &root, 1, item);
    try std.testing.expectEqual(@as(u64, 16), root.measure);
    try std.testing.expectEqual(std.math.maxInt(u64), snapshot.measure);
    try std.testing.expectEqualSlices(*Value, &.{ large, large }, snapshot.data.list);
}

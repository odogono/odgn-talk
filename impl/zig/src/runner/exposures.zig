//! The native Runner's Peer Exposures and their Lifetime (chapter 9, The
//! peer router: Lifetime; ADR 0181): each Script's named and unnamed
//! exposures, by secret, withdrawn by `unexpose` or when the Script's
//! `peer` Grant is released by a stop, a revocation or a disabling, and
//! kept across a Reload. The Runner serves one Group, and a Script holds at
//! most one `peer` Grant, so an exposure's owner is its Script.
//! peer_kit.zig holds it to corpus/peer-kit/.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Exposure = struct { name: ?[]const u8, script: []const u8 };

/// Why a Grant is released, as talk.h's talk_release_reason has it.
pub const Reason = enum { stop, reload, revoke, disable };

pub const Exposed = union(enum) {
    /// The exposure's secret, owned by the table.
    secret: []const u8,
    /// Another Script holds the name.
    name_in_use,
};

pub const Exposures = struct {
    gpa: Allocator,
    by_secret: std.StringHashMapUnmanaged(Exposure) = .empty,
    /// Its keys are the exposures' own names.
    names: std.StringHashMapUnmanaged([]const u8) = .empty,

    pub fn init(gpa: Allocator) Exposures {
        return .{ .gpa = gpa };
    }

    pub fn deinit(e: *Exposures) void {
        var it = e.by_secret.iterator();
        while (it.next()) |entry| free(e.gpa, entry.key_ptr.*, entry.value_ptr.*);
        e.by_secret.deinit(e.gpa);
        e.names.deinit(e.gpa);
    }

    fn free(gpa: Allocator, secret: []const u8, x: Exposure) void {
        gpa.free(secret);
        if (x.name) |n| gpa.free(n);
        gpa.free(x.script);
    }

    pub fn get(e: *const Exposures, secret: []const u8) ?Exposure {
        return e.by_secret.get(secret);
    }

    /// The secret of the exposure a name names.
    pub fn named(e: *const Exposures, name: []const u8) ?[]const u8 {
        return e.names.get(name);
    }

    /// Exposes script under name, or unnamed for null, with raw as a new
    /// exposure's 128 random bits. Exposing a name the Script holds again
    /// gives the same secret.
    pub fn expose(e: *Exposures, script: []const u8, name: ?[]const u8, raw: [16]u8) Allocator.Error!Exposed {
        if (name) |n| if (e.names.get(n)) |secret| {
            if (!std.mem.eql(u8, e.by_secret.get(secret).?.script, script)) return .name_in_use;
            return .{ .secret = secret };
        };
        const secret = try e.gpa.dupe(u8, &std.fmt.bytesToHex(raw, .lower));
        errdefer e.gpa.free(secret);
        const owned_script = try e.gpa.dupe(u8, script);
        errdefer e.gpa.free(owned_script);
        const owned_name: ?[]const u8 = if (name) |n| try e.gpa.dupe(u8, n) else null;
        errdefer if (owned_name) |n| e.gpa.free(n);
        try e.by_secret.put(e.gpa, secret, .{ .name = owned_name, .script = owned_script });
        if (owned_name) |n| e.names.put(e.gpa, n, secret) catch |err| {
            _ = e.by_secret.remove(secret);
            return err;
        };
        return .{ .secret = secret };
    }

    /// Withdraws the exposure, if script owns it.
    pub fn unexpose(e: *Exposures, script: []const u8, secret: []const u8) void {
        const held = e.by_secret.get(secret) orelse return;
        if (std.mem.eql(u8, held.script, script)) e.withdraw(secret);
    }

    /// The release hook's work: a stop, a revocation or a disabling
    /// withdraws every exposure the Script made; a Reload keeps them, since
    /// the Script goes on.
    pub fn release(e: *Exposures, script: []const u8, reason: Reason) void {
        if (reason == .reload) return;
        while (true) {
            var it = e.by_secret.iterator();
            const found = while (it.next()) |entry| {
                if (std.mem.eql(u8, entry.value_ptr.script, script)) break entry.key_ptr.*;
            } else return;
            e.withdraw(found);
        }
    }

    fn withdraw(e: *Exposures, secret: []const u8) void {
        const removed = e.by_secret.fetchRemove(secret) orelse return;
        if (removed.value.name) |n| {
            if (e.names.get(n)) |held| if (held.ptr == removed.key.ptr) {
                _ = e.names.remove(n);
            };
        }
        free(e.gpa, removed.key, removed.value);
    }
};

test "a stop, a revocation or a disabling withdraws a Script's exposures, and a Reload keeps them" {
    var e = Exposures.init(std.testing.allocator);
    defer e.deinit();
    const a = (try e.expose("a", "inbox", @splat(1))).secret;
    _ = try e.expose("a", null, @splat(2));
    _ = try e.expose("b", "other", @splat(3));
    try std.testing.expect(try e.expose("b", "inbox", @splat(4)) == .name_in_use);
    try std.testing.expectEqualStrings(a, (try e.expose("a", "inbox", @splat(5))).secret);
    e.release("a", .reload);
    try std.testing.expectEqual(@as(u32, 3), e.by_secret.count());
    e.release("a", .revoke);
    try std.testing.expectEqual(@as(u32, 1), e.by_secret.count());
    try std.testing.expect(e.named("inbox") == null);
    try std.testing.expect(e.named("other") != null);
}

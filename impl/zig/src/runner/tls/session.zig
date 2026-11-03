//! One end of a mutual TLS 1.3 connection between Runners (ADR 0164): a
//! single profile, `TLS_AES_128_GCM_SHA256` with X25519 and
//! `ecdsa_secp256r1_sha256`, both ends showing a certificate, and the key
//! pinned rather than trusted through any authority.
//!
//! It does no I/O. The caller feeds it the bytes that arrive and sends the
//! bytes it gives back, so it fits a nonblocking poll loop.
const std = @import("std");
const keys = @import("keys.zig");

const tls = std.crypto.tls;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Hmac = std.crypto.auth.hmac.sha2.HmacSha256;
const Hkdf = std.crypto.kdf.hkdf.Hkdf(Hmac);
const Aead = std.crypto.aead.aes_gcm.Aes128Gcm;
const X25519 = std.crypto.dh.X25519;
const Ecdsa = keys.Ecdsa;
const Allocator = std.mem.Allocator;
const List = std.ArrayList(u8);

pub const Error = error{
    /// The other end broke the protocol, or offered nothing this profile takes.
    Handshake,
    /// A record failed to decrypt, or was too long.
    BadRecord,
    /// The other end's key isn't the one pinned, or its signature is wrong.
    BadPeer,
    /// The other end sent an alert or closed the connection.
    Closed,
    OutOfMemory,
};

const suite: u16 = 0x1301; // TLS_AES_128_GCM_SHA256
const group_x25519: u16 = 0x001d;
const scheme: u16 = 0x0403; // ecdsa_secp256r1_sha256
const max_plain = 1 << 14;
const max_cipher = max_plain + 256;

const msg_client_hello = 1;
const msg_server_hello = 2;
const msg_new_session_ticket = 4;
const msg_encrypted_extensions = 8;
const msg_certificate = 11;
const msg_certificate_request = 13;
const msg_certificate_verify = 15;
const msg_finished = 20;
const msg_key_update = 24;

const rec_ccs = 20;
const rec_alert = 21;
const rec_handshake = 22;
const rec_data = 23;

// ---------------------------------------------------------------- key schedule

/// HKDF-Expand-Label (RFC 8446 §7.1) with SHA-256.
pub fn expandLabel(secret: [32]u8, label: []const u8, context: []const u8, comptime len: usize) [len]u8 {
    return tls.hkdfExpandLabel(Hkdf, secret, label, context, len);
}

/// SHA-256 of nothing.
pub const empty_hash = hexConst("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

fn hexConst(comptime s: []const u8) [s.len / 2]u8 {
    @setEvalBranchQuota(100_000);
    var out: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch unreachable;
    return out;
}

/// The handshake and master secrets, from the X25519 shared secret.
pub const Schedule = struct {
    handshake: [32]u8,
    master: [32]u8,

    pub fn init(shared: [32]u8) Schedule {
        const zero: [32]u8 = @splat(0);
        const early = Hkdf.extract(&zero, &zero);
        const handshake = Hkdf.extract(&expandLabel(early, "derived", &empty_hash, 32), &shared);
        const master = Hkdf.extract(&expandLabel(handshake, "derived", &empty_hash, 32), &zero);
        return .{ .handshake = handshake, .master = master };
    }
};

/// One direction's traffic: its secret, key, IV and record count.
pub const Traffic = struct {
    secret: [32]u8,
    key: [Aead.key_length]u8,
    iv: [Aead.nonce_length]u8,
    seq: u64 = 0,

    pub fn init(secret: [32]u8) Traffic {
        return .{ .secret = secret, .key = expandLabel(secret, "key", "", Aead.key_length), .iv = expandLabel(secret, "iv", "", Aead.nonce_length) };
    }

    /// The next generation, after a KeyUpdate (RFC 8446 §7.2).
    fn updated(t: Traffic) Traffic {
        return init(expandLabel(t.secret, "traffic upd", "", 32));
    }

    fn nonce(t: *const Traffic) [Aead.nonce_length]u8 {
        var n = t.iv;
        var seq: [8]u8 = undefined;
        std.mem.writeInt(u64, &seq, t.seq, .big);
        for (n[4..], seq) |*a, b| a.* ^= b;
        return n;
    }

    /// Appends one protected record holding `plain` of content `kind`.
    pub fn seal(t: *Traffic, gpa: Allocator, out: *List, kind: u8, plain: []const u8) Allocator.Error!void {
        std.debug.assert(plain.len <= max_plain);
        const inner_len = plain.len + 1;
        const len = inner_len + Aead.tag_length;
        const header = [5]u8{ rec_data, 3, 3, @intCast(len >> 8), @intCast(len & 0xff) };
        try out.ensureUnusedCapacity(gpa, 5 + len);
        out.appendSliceAssumeCapacity(&header);
        const start = out.items.len;
        out.items.len += len;
        const body = out.items[start..][0..inner_len];
        @memcpy(body[0..plain.len], plain);
        body[plain.len] = kind;
        var tag: [Aead.tag_length]u8 = undefined;
        Aead.encrypt(body, &tag, body, &header, t.nonce(), t.key);
        @memcpy(out.items[start + inner_len ..][0..Aead.tag_length], &tag);
        t.seq += 1;
    }

    /// Opens one protected record in place: its content type and plaintext.
    pub fn open(t: *Traffic, header: [5]u8, body: []u8) Error!struct { kind: u8, plain: []u8 } {
        if (body.len < Aead.tag_length + 1) return error.BadRecord;
        const sealed = body[0 .. body.len - Aead.tag_length];
        const tag = body[sealed.len..][0..Aead.tag_length].*;
        Aead.decrypt(sealed, sealed, tag, &header, t.nonce(), t.key) catch return error.BadRecord;
        t.seq += 1;
        // The content type is the last nonzero byte; zeros after it pad.
        var end = sealed.len;
        while (end > 0 and sealed[end - 1] == 0) end -= 1;
        if (end == 0) return error.BadRecord;
        if (end - 1 > max_plain) return error.BadRecord;
        return .{ .kind = sealed[end - 1], .plain = sealed[0 .. end - 1] };
    }
};

fn finishedOf(secret: [32]u8, transcript: [32]u8) [32]u8 {
    return tls.hmac(Hmac, &transcript, expandLabel(secret, "finished", "", 32));
}

/// The content a CertificateVerify signs (RFC 8446 §4.4.3).
fn verifyContent(server: bool, transcript: [32]u8) [64 + 34 + 32]u8 {
    var out: [64 + 34 + 32]u8 = undefined;
    @memset(out[0..64], 0x20);
    const context = if (server) "TLS 1.3, server CertificateVerify\x00" else "TLS 1.3, client CertificateVerify\x00";
    @memcpy(out[64..][0..34], context);
    @memcpy(out[98..], &transcript);
    return out;
}

// ---------------------------------------------------------------- reading

const Reader = struct {
    rest: []const u8,

    fn bytes(r: *Reader, n: usize) Error![]const u8 {
        if (r.rest.len < n) return error.Handshake;
        const out = r.rest[0..n];
        r.rest = r.rest[n..];
        return out;
    }

    fn int(r: *Reader, comptime T: type) Error!T {
        const n = @divExact(@bitSizeOf(T), 8);
        return std.mem.readInt(T, (try r.bytes(n))[0..n], .big);
    }

    /// A vector with a length prefix of type `T`.
    fn vec(r: *Reader, comptime T: type) Error!Reader {
        return .{ .rest = try r.bytes(try r.int(T)) };
    }

    fn done(r: *const Reader) Error!void {
        if (r.rest.len != 0) return error.Handshake;
    }
};

const Extension = struct { kind: u16, body: Reader };

fn nextExtension(r: *Reader) Error!?Extension {
    if (r.rest.len == 0) return null;
    const kind = try r.int(u16);
    return .{ .kind = kind, .body = try r.vec(u16) };
}

// ---------------------------------------------------------------- writing

fn put16(gpa: Allocator, out: *List, n: usize) Allocator.Error!void {
    try out.appendSlice(gpa, &.{ @intCast(n >> 8 & 0xff), @intCast(n & 0xff) });
}

fn put24(gpa: Allocator, out: *List, n: usize) Allocator.Error!void {
    try out.appendSlice(gpa, &.{ @intCast(n >> 16 & 0xff), @intCast(n >> 8 & 0xff), @intCast(n & 0xff) });
}

/// Starts a length-prefixed part, to close with `endLen`.
fn beginLen(gpa: Allocator, out: *List, comptime width: usize) Allocator.Error!usize {
    try out.appendNTimes(gpa, 0, width);
    return out.items.len;
}

fn endLen(out: *List, start: usize, comptime width: usize) void {
    const n = out.items.len - start;
    var i: usize = 0;
    while (i < width) : (i += 1) out.items[start - width + i] = @intCast(n >> @intCast(8 * (width - 1 - i)) & 0xff);
}

// ---------------------------------------------------------------- the session

pub const Role = enum { client, server };

const State = enum {
    /// Client: waiting for ServerHello. Server: waiting for ClientHello.
    hello,
    encrypted_extensions,
    certificate_request_or_certificate,
    certificate,
    certificate_verify,
    finished,
    connected,
};

pub const Session = struct {
    role: Role,
    id: *const keys.Identity,
    /// The fingerprint the dialled key must have; the listener has none.
    pin: ?keys.Fingerprint,
    state: State = .hello,
    /// Once connected, the other end's key fingerprint.
    peer: ?keys.Fingerprint = null,
    transcript: Sha256 = .init(.{}),
    exchange: X25519.KeyPair,
    random: [32]u8,
    session_id: [32]u8,
    schedule: Schedule = undefined,
    read: ?Traffic = null,
    write: ?Traffic = null,
    /// Traffic secrets the handshake has derived but not yet switched to.
    next_read: Traffic = undefined,
    next_write: Traffic = undefined,
    /// Whether the server asked this client for its certificate.
    asked_for_certificate: bool = false,
    peer_key: ?Ecdsa.PublicKey = null,
    /// Bytes not yet a whole record, and handshake bytes not yet a whole message.
    records: List = .empty,
    messages: List = .empty,
    /// Plaintext written before the handshake ended.
    pending: List = .empty,
    closed: bool = false,
    /// The transcript through the hellos, which the handshake secrets take.
    hs_transcript: [32]u8 = undefined,

    /// A new session. A client sends its ClientHello into `out` at once.
    pub fn init(gpa: Allocator, io: std.Io, role: Role, id: *const keys.Identity, pin: ?keys.Fingerprint, out: *List) Error!Session {
        var s: Session = .{ .role = role, .id = id, .pin = pin, .exchange = X25519.KeyPair.generate(io), .random = undefined, .session_id = undefined };
        io.random(&s.random);
        io.random(&s.session_id);
        if (role == .client) try s.sendClientHello(gpa, out);
        return s;
    }

    pub fn deinit(s: *Session, gpa: Allocator) void {
        s.records.deinit(gpa);
        s.messages.deinit(gpa);
        s.pending.deinit(gpa);
        std.crypto.secureZero(u8, std.mem.asBytes(&s.exchange.secret_key));
    }

    pub fn connected(s: *const Session) bool {
        return s.state == .connected;
    }

    /// Writes application data: at once when connected, and otherwise
    /// once the handshake ends.
    pub fn send(s: *Session, gpa: Allocator, plain: []const u8, out: *List) Error!void {
        if (s.state != .connected) return s.pending.appendSlice(gpa, plain);
        var rest = plain;
        while (rest.len > 0) {
            const n = @min(rest.len, max_plain);
            try s.write.?.seal(gpa, out, rec_data, rest[0..n]);
            rest = rest[n..];
        }
    }

    /// Takes bytes that arrived: handshake replies go to `out`, and the
    /// application data they carry to `plain`.
    pub fn feed(s: *Session, gpa: Allocator, bytes: []const u8, out: *List, plain: *List) Error!void {
        if (s.closed) return error.Closed;
        try s.records.appendSlice(gpa, bytes);
        var used: usize = 0;
        defer {
            std.mem.copyForwards(u8, s.records.items, s.records.items[used..]);
            s.records.shrinkRetainingCapacity(s.records.items.len - used);
        }
        while (s.records.items.len - used >= 5) {
            const at = s.records.items[used..];
            const header = at[0..5].*;
            const len = std.mem.readInt(u16, header[3..5], .big);
            if (len > max_cipher) return error.BadRecord;
            if (at.len < 5 + len) break;
            const body = at[5 .. 5 + len];
            used += 5 + len;
            try s.record(gpa, header, body, out, plain);
        }
    }

    fn record(s: *Session, gpa: Allocator, header: [5]u8, body: []u8, out: *List, plain: *List) Error!void {
        const kind = header[0];
        if (kind == rec_ccs) {
            // Middlebox compatibility (RFC 8446 §D.4): ignored until connected.
            if (s.state == .connected or s.state == .hello or body.len != 1 or body[0] != 1) return error.Handshake;
            return;
        }
        if (s.read == null) {
            // Only the hellos travel in the clear.
            if (kind == rec_alert) return s.closing();
            if (kind != rec_handshake) return error.Handshake;
            return s.handshakeBytes(gpa, body, out);
        }
        if (kind != rec_data) return error.BadRecord;
        const opened = try s.read.?.open(header, body);
        switch (opened.kind) {
            rec_handshake => try s.handshakeBytes(gpa, opened.plain, out),
            rec_data => {
                if (s.state != .connected) return error.Handshake;
                try plain.appendSlice(gpa, opened.plain);
            },
            rec_alert => return s.closing(),
            else => return error.Handshake,
        }
    }

    fn closing(s: *Session) Error!void {
        s.closed = true;
        return error.Closed;
    }

    fn handshakeBytes(s: *Session, gpa: Allocator, bytes: []const u8, out: *List) Error!void {
        if (bytes.len == 0) return error.Handshake;
        try s.messages.appendSlice(gpa, bytes);
        var used: usize = 0;
        defer {
            std.mem.copyForwards(u8, s.messages.items, s.messages.items[used..]);
            s.messages.shrinkRetainingCapacity(s.messages.items.len - used);
        }
        while (s.messages.items.len - used >= 4) {
            const at = s.messages.items[used..];
            const len = std.mem.readInt(u24, at[1..4], .big);
            if (len > 64 * 1024) return error.Handshake;
            if (at.len < 4 + len) break;
            const message = at[0 .. 4 + len];
            used += 4 + len;
            const read_before = s.read;
            try s.handshake(gpa, message, out);
            // Keys change only at a record's end (RFC 8446 §5.1).
            if (!std.meta.eql(read_before, s.read) and s.messages.items.len > used) return error.Handshake;
        }
    }

    fn handshake(s: *Session, gpa: Allocator, message: []const u8, out: *List) Error!void {
        const kind = message[0];
        var body = Reader{ .rest = message[4..] };
        if (s.state == .connected) return s.afterHandshake(gpa, kind, &body, out);
        switch (s.role) {
            .server => switch (s.state) {
                .hello => {
                    if (kind != msg_client_hello) return error.Handshake;
                    try s.clientHello(gpa, message, &body, out);
                },
                .certificate => {
                    if (kind != msg_certificate) return error.Handshake;
                    try s.certificate(message, &body);
                },
                .certificate_verify => {
                    if (kind != msg_certificate_verify) return error.Handshake;
                    try s.certificateVerify(message, &body);
                },
                .finished => {
                    if (kind != msg_finished) return error.Handshake;
                    try s.finished(&body);
                    s.read = s.next_read;
                    s.write = s.next_write;
                    try s.connect(gpa, out);
                },
                else => return error.Handshake,
            },
            .client => switch (s.state) {
                .hello => {
                    if (kind != msg_server_hello) return error.Handshake;
                    try s.serverHello(message, &body);
                },
                .encrypted_extensions => {
                    if (kind != msg_encrypted_extensions) return error.Handshake;
                    var extensions = try body.vec(u16);
                    while (try nextExtension(&extensions)) |_| {}
                    try body.done();
                    s.transcript.update(message);
                    s.state = .certificate_request_or_certificate;
                },
                .certificate_request_or_certificate => {
                    if (kind == msg_certificate_request) {
                        const context = try body.vec(u8);
                        if (context.rest.len != 0) return error.Handshake;
                        _ = try body.vec(u16);
                        try body.done();
                        s.transcript.update(message);
                        s.asked_for_certificate = true;
                        s.state = .certificate;
                        return;
                    }
                    if (kind != msg_certificate) return error.Handshake;
                    try s.certificate(message, &body);
                },
                .certificate => {
                    if (kind != msg_certificate) return error.Handshake;
                    try s.certificate(message, &body);
                },
                .certificate_verify => {
                    if (kind != msg_certificate_verify) return error.Handshake;
                    try s.certificateVerify(message, &body);
                },
                .finished => {
                    if (kind != msg_finished) return error.Handshake;
                    try s.finished(&body);
                    s.transcript.update(message);
                    try s.clientFinish(gpa, out);
                },
                else => return error.Handshake,
            },
        }
    }

    /// After the handshake: tickets are ignored, and key updates followed.
    fn afterHandshake(s: *Session, gpa: Allocator, kind: u8, body: *Reader, out: *List) Error!void {
        switch (kind) {
            msg_new_session_ticket => {},
            msg_key_update => {
                const request = try body.int(u8);
                try body.done();
                if (request > 1) return error.Handshake;
                s.read = s.read.?.updated();
                if (request == 1) {
                    try s.write.?.seal(gpa, out, rec_handshake, &.{ msg_key_update, 0, 0, 1, 0 });
                    s.write = s.write.?.updated();
                }
            },
            else => return error.Handshake,
        }
    }

    fn connect(s: *Session, gpa: Allocator, out: *List) Error!void {
        s.state = .connected;
        const waiting = try s.pending.toOwnedSlice(gpa);
        defer gpa.free(waiting);
        try s.send(gpa, waiting, out);
    }

    // ------------------------------------------------------------ hellos

    fn sendClientHello(s: *Session, gpa: Allocator, out: *List) Error!void {
        var m: List = .empty;
        defer m.deinit(gpa);
        try m.append(gpa, msg_client_hello);
        const body = try beginLen(gpa, &m, 3);
        try m.appendSlice(gpa, &.{ 3, 3 });
        try m.appendSlice(gpa, &s.random);
        try m.append(gpa, 32);
        try m.appendSlice(gpa, &s.session_id);
        try m.appendSlice(gpa, &.{ 0, 2, suite >> 8, suite & 0xff, 1, 0 });
        const extensions = try beginLen(gpa, &m, 2);
        try m.appendSlice(gpa, &.{ 0, 43, 0, 3, 2, 3, 4 }); // supported_versions: TLS 1.3
        try m.appendSlice(gpa, &.{ 0, 10, 0, 4, 0, 2, 0, 0x1d }); // supported_groups: x25519
        try m.appendSlice(gpa, &.{ 0, 13, 0, 4, 0, 2, 4, 3 }); // signature_algorithms
        try m.appendSlice(gpa, &.{ 0, 51, 0, 38, 0, 36, 0, 0x1d, 0, 32 }); // key_share
        try m.appendSlice(gpa, &s.exchange.public_key);
        endLen(&m, extensions, 2);
        endLen(&m, body, 3);
        s.transcript.update(m.items);
        try plainRecord(gpa, out, rec_handshake, m.items);
    }

    fn clientHello(s: *Session, gpa: Allocator, message: []const u8, body: *Reader, out: *List) Error!void {
        _ = try body.bytes(2 + 32);
        const session_id = try body.vec(u8);
        if (session_id.rest.len > 32) return error.Handshake;
        var suites = try body.vec(u16);
        var offered_suite = false;
        while (suites.rest.len >= 2) if (try suites.int(u16) == suite) {
            offered_suite = true;
        };
        _ = try body.vec(u8);
        var extensions = try body.vec(u16);
        try body.done();
        var tls13 = false;
        var ecdsa = false;
        var share: ?[32]u8 = null;
        while (try nextExtension(&extensions)) |e| {
            var x = e.body;
            switch (e.kind) {
                43 => {
                    var versions = try x.vec(u8);
                    while (versions.rest.len >= 2) if (try versions.int(u16) == 0x0304) {
                        tls13 = true;
                    };
                },
                13 => {
                    var schemes = try x.vec(u16);
                    while (schemes.rest.len >= 2) if (try schemes.int(u16) == scheme) {
                        ecdsa = true;
                    };
                },
                51 => {
                    var shares = try x.vec(u16);
                    while (shares.rest.len > 0) {
                        const group = try shares.int(u16);
                        const key = try shares.vec(u16);
                        if (group == group_x25519 and key.rest.len == 32) share = key.rest[0..32].*;
                    }
                },
                else => {},
            }
        }
        // No HelloRetryRequest: a client that won't match this profile fails.
        if (!offered_suite or !tls13 or !ecdsa) return error.Handshake;
        const theirs = share orelse return error.Handshake;
        s.transcript.update(message);

        var m: List = .empty;
        defer m.deinit(gpa);
        try m.append(gpa, msg_server_hello);
        const hello = try beginLen(gpa, &m, 3);
        try m.appendSlice(gpa, &.{ 3, 3 });
        try m.appendSlice(gpa, &s.random);
        try m.append(gpa, @intCast(session_id.rest.len));
        try m.appendSlice(gpa, session_id.rest);
        try m.appendSlice(gpa, &.{ suite >> 8, suite & 0xff, 0 });
        const extensions_at = try beginLen(gpa, &m, 2);
        try m.appendSlice(gpa, &.{ 0, 43, 0, 2, 3, 4 });
        try m.appendSlice(gpa, &.{ 0, 51, 0, 36, 0, 0x1d, 0, 32 });
        try m.appendSlice(gpa, &s.exchange.public_key);
        endLen(&m, extensions_at, 2);
        endLen(&m, hello, 3);
        s.transcript.update(m.items);
        try plainRecord(gpa, out, rec_handshake, m.items);
        if (session_id.rest.len > 0) try out.appendSlice(gpa, &.{ rec_ccs, 3, 3, 0, 1, 1 });

        try s.handshakeKeys(theirs);
        var hs_write = Traffic.init(s.handshakeSecret(.server));
        s.read = Traffic.init(s.handshakeSecret(.client));

        // EncryptedExtensions, CertificateRequest, Certificate,
        // CertificateVerify and Finished, in one flight.
        m.clearRetainingCapacity();
        try s.addMessage(gpa, &m, &.{ msg_encrypted_extensions, 0, 0, 2, 0, 0 });
        try s.addMessage(gpa, &m, &.{ msg_certificate_request, 0, 0, 11, 0, 0, 8, 0, 13, 0, 4, 0, 2, 4, 3 });
        try s.addCertificate(gpa, &m);
        try s.addCertificateVerify(gpa, &m);
        const server_finished = finishedOf(hs_write.secret, s.transcript.peek());
        try s.addMessage(gpa, &m, &([_]u8{ msg_finished, 0, 0, 32 } ++ server_finished));
        try sealAll(gpa, &hs_write, out, m.items);
        const after_server_finished = s.transcript.peek();
        s.next_write = Traffic.init(expandLabel(s.schedule.master, "s ap traffic", &after_server_finished, 32));
        s.next_read = Traffic.init(expandLabel(s.schedule.master, "c ap traffic", &after_server_finished, 32));
        s.state = .certificate;
    }

    fn serverHello(s: *Session, message: []const u8, body: *Reader) Error!void {
        _ = try body.bytes(2);
        const random = try body.bytes(32);
        if (std.mem.eql(u8, random, &tls.hello_retry_request_sequence)) return error.Handshake;
        const echoed = try body.vec(u8);
        if (!std.mem.eql(u8, echoed.rest, &s.session_id)) return error.Handshake;
        if (try body.int(u16) != suite) return error.Handshake;
        if (try body.int(u8) != 0) return error.Handshake;
        var extensions = try body.vec(u16);
        try body.done();
        var tls13 = false;
        var share: ?[32]u8 = null;
        while (try nextExtension(&extensions)) |e| {
            var x = e.body;
            switch (e.kind) {
                43 => tls13 = try x.int(u16) == 0x0304,
                51 => {
                    if (try x.int(u16) != group_x25519) return error.Handshake;
                    const key = try x.vec(u16);
                    if (key.rest.len != 32) return error.Handshake;
                    share = key.rest[0..32].*;
                },
                else => return error.Handshake,
            }
        }
        if (!tls13) return error.Handshake;
        s.transcript.update(message);
        try s.handshakeKeys(share orelse return error.Handshake);
        s.read = Traffic.init(s.handshakeSecret(.server));
        s.next_write = Traffic.init(s.handshakeSecret(.client));
        s.state = .encrypted_extensions;
    }

    fn handshakeKeys(s: *Session, theirs: [32]u8) Error!void {
        const shared = X25519.scalarmult(s.exchange.secret_key, theirs) catch return error.Handshake;
        s.schedule = Schedule.init(shared);
        s.hs_transcript = s.transcript.peek();
    }

    fn handshakeSecret(s: *const Session, side: Role) [32]u8 {
        return expandLabel(s.schedule.handshake, if (side == .client) "c hs traffic" else "s hs traffic", &s.hs_transcript, 32);
    }

    // ------------------------------------------------------------ certificates

    fn certificate(s: *Session, message: []const u8, body: *Reader) Error!void {
        const context = try body.vec(u8);
        if (context.rest.len != 0) return error.Handshake;
        var list = try body.vec(u24);
        try body.done();
        // The first certificate carries the key; any after it mean nothing.
        const first = try list.vec(u24);
        _ = try list.vec(u16);
        const carried = keys.certKey(first.rest) catch return error.BadPeer;
        const fingerprint = keys.fingerprintOf(carried.spki);
        if (s.pin) |pin| if (!std.crypto.timing_safe.eql([64]u8, pin, fingerprint)) return error.BadPeer;
        s.peer = fingerprint;
        s.peer_key = carried.key;
        s.transcript.update(message);
        s.state = .certificate_verify;
    }

    fn certificateVerify(s: *Session, message: []const u8, body: *Reader) Error!void {
        if (try body.int(u16) != scheme) return error.BadPeer;
        const der = try body.vec(u16);
        try body.done();
        const sig = Ecdsa.Signature.fromDer(der.rest) catch return error.BadPeer;
        const content = verifyContent(s.role == .client, s.transcript.peek());
        sig.verify(&content, s.peer_key.?) catch return error.BadPeer;
        s.transcript.update(message);
        s.state = .finished;
    }

    fn finished(s: *Session, body: *Reader) Error!void {
        const theirs = try body.bytes(32);
        try body.done();
        // Each side's Finished uses its own handshake secret.
        const secret = s.handshakeSecret(if (s.role == .client) .server else .client);
        const expected = finishedOf(secret, s.transcript.peek());
        if (!std.crypto.timing_safe.eql([32]u8, expected, theirs[0..32].*)) return error.BadPeer;
    }

    /// The client's last flight: its certificate, if asked, and Finished.
    fn clientFinish(s: *Session, gpa: Allocator, out: *List) Error!void {
        const after_server_finished = s.transcript.peek();
        var m: List = .empty;
        defer m.deinit(gpa);
        if (s.asked_for_certificate) {
            try s.addCertificate(gpa, &m);
            try s.addCertificateVerify(gpa, &m);
        }
        const client_finished = finishedOf(s.next_write.secret, s.transcript.peek());
        try s.addMessage(gpa, &m, &([_]u8{ msg_finished, 0, 0, 32 } ++ client_finished));
        try sealAll(gpa, &s.next_write, out, m.items);
        s.read = Traffic.init(expandLabel(s.schedule.master, "s ap traffic", &after_server_finished, 32));
        s.write = Traffic.init(expandLabel(s.schedule.master, "c ap traffic", &after_server_finished, 32));
        try s.connect(gpa, out);
    }

    fn addMessage(s: *Session, gpa: Allocator, m: *List, message: []const u8) Error!void {
        s.transcript.update(message);
        try m.appendSlice(gpa, message);
    }

    fn addCertificate(s: *Session, gpa: Allocator, m: *List) Error!void {
        const start = m.items.len;
        try m.append(gpa, msg_certificate);
        const body = try beginLen(gpa, m, 3);
        try m.append(gpa, 0);
        try put24(gpa, m, s.id.cert.len + 5);
        try put24(gpa, m, s.id.cert.len);
        try m.appendSlice(gpa, s.id.cert);
        try put16(gpa, m, 0);
        endLen(m, body, 3);
        s.transcript.update(m.items[start..]);
    }

    fn addCertificateVerify(s: *Session, gpa: Allocator, m: *List) Error!void {
        const content = verifyContent(s.role == .server, s.transcript.peek());
        const sig = s.id.pair.sign(&content, null) catch return error.Handshake;
        var buf: [Ecdsa.Signature.der_encoded_length_max]u8 = undefined;
        const der = sig.toDer(&buf);
        const start = m.items.len;
        try m.append(gpa, msg_certificate_verify);
        try put24(gpa, m, 4 + der.len);
        try m.appendSlice(gpa, &.{ scheme >> 8, scheme & 0xff });
        try put16(gpa, m, der.len);
        try m.appendSlice(gpa, der);
        s.transcript.update(m.items[start..]);
    }
};

fn plainRecord(gpa: Allocator, out: *List, kind: u8, body: []const u8) Allocator.Error!void {
    var rest = body;
    while (rest.len > 0) {
        const n = @min(rest.len, max_plain);
        try out.appendSlice(gpa, &.{ kind, 3, 3, @intCast(n >> 8), @intCast(n & 0xff) });
        try out.appendSlice(gpa, rest[0..n]);
        rest = rest[n..];
    }
}

fn sealAll(gpa: Allocator, t: *Traffic, out: *List, body: []const u8) Allocator.Error!void {
    var rest = body;
    while (rest.len > 0) {
        const n = @min(rest.len, max_plain);
        try t.seal(gpa, out, rec_handshake, rest[0..n]);
        rest = rest[n..];
    }
}

// ---------------------------------------------------------------- tests

const testing = std.testing;

const hex = hexConst;

// RFC 8448 §3, Simple 1-RTT Handshake.
const rfc_shared = hex("8bd4054fb55b9d63fdfbacf9f04b9f0d35e6d63f537563efd46272900f89492d");
const rfc_hello_hash = hex("860c06edc07858ee8e78f0e7428c58edd6b43f2ca3e6e95f02ed063cf0e1cad8");
const rfc_finished_hash = hex("9608102a0f1ccc6db6250b7b7e417b1a000eaada3daae4777a7686c9ff83df13");

test "the key schedule matches RFC 8448's simple 1-RTT handshake" {
    const k = Schedule.init(rfc_shared);
    try testing.expectEqualSlices(u8, &hex("1dc826e93606aa6fdc0aadc12f741b01046aa6b99f691ed221a9f0ca043fbeac"), &k.handshake);
    try testing.expectEqualSlices(u8, &hex("18df06843d13a08bf2a449844c5f8a478001bc4d4c627984d5a41da8d0402919"), &k.master);
    const c_hs = expandLabel(k.handshake, "c hs traffic", &rfc_hello_hash, 32);
    const s_hs = expandLabel(k.handshake, "s hs traffic", &rfc_hello_hash, 32);
    try testing.expectEqualSlices(u8, &hex("b3eddb126e067f35a780b3abf45e2d8f3b1a950738f52e9600746a0e27a55a21"), &c_hs);
    try testing.expectEqualSlices(u8, &hex("b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38"), &s_hs);
    const server_hs = Traffic.init(s_hs);
    try testing.expectEqualSlices(u8, &hex("3fce516009c21727d0f2e4e86ee403bc"), &server_hs.key);
    try testing.expectEqualSlices(u8, &hex("5d313eb2671276ee13000b30"), &server_hs.iv);
    try testing.expectEqualSlices(u8, &hex("9e40646ce79a7f9dc05af8889bce6552875afa0b06df0087f792ebb7c17504a5"), &expandLabel(k.master, "c ap traffic", &rfc_finished_hash, 32));
    try testing.expectEqualSlices(u8, &hex("a11af9f05531f856ad47116b45a950328204b4f44bfb6b3a4b4f1f3fcb631643"), &expandLabel(k.master, "s ap traffic", &rfc_finished_hash, 32));
    try testing.expectEqualSlices(u8, &hex("008d3b66f816ea559f96b537e885c31fc068bf492c652f01f288a1d8cdc19fc8"), &expandLabel(s_hs, "finished", "", 32));
}

test "a record is sealed and opened as RFC 8448's client application data" {
    var t = Traffic.init(hex("9e40646ce79a7f9dc05af8889bce6552875afa0b06df0087f792ebb7c17504a5"));
    try testing.expectEqualSlices(u8, &hex("17422dda596ed5d9acd890e3c63f5051"), &t.key);
    var payload: [50]u8 = undefined;
    for (&payload, 0..) |*b, i| b.* = @intCast(i);
    var out: List = .empty;
    defer out.deinit(testing.allocator);
    try t.seal(testing.allocator, &out, rec_data, &payload);
    const expected = hex("1703030043a23f7054b62c94d0affafe8228ba55cbefacea42f914aa66bcab3f2b9819a8a5b46b395bd54a9a20441e2b62974e1f5a6292a2977014bd1e3deae63aeebb21694915e4");
    try testing.expectEqualSlices(u8, &expected, out.items);
    var back = Traffic.init(t.secret);
    var body = expected[5..].*;
    const opened = try back.open(expected[0..5].*, &body);
    try testing.expectEqual(@as(u8, rec_data), opened.kind);
    try testing.expectEqualSlices(u8, &payload, opened.plain);
    // A changed byte fails it.
    var bent = expected[5..].*;
    bent[3] ^= 1;
    var again = Traffic.init(t.secret);
    try testing.expectError(error.BadRecord, again.open(expected[0..5].*, &bent));
}

const Pair = struct {
    client: Session,
    server: Session,
    to_server: List = .empty,
    to_client: List = .empty,
    at_server: List = .empty,
    at_client: List = .empty,

    fn deinit(p: *Pair) void {
        p.client.deinit(testing.allocator);
        p.server.deinit(testing.allocator);
        p.to_server.deinit(testing.allocator);
        p.to_client.deinit(testing.allocator);
        p.at_server.deinit(testing.allocator);
        p.at_client.deinit(testing.allocator);
    }

    /// Passes bytes each way until neither side has more to say.
    fn run(p: *Pair) Error!void {
        const gpa = testing.allocator;
        while (p.to_server.items.len > 0 or p.to_client.items.len > 0) {
            const a = try p.to_server.toOwnedSlice(gpa);
            defer gpa.free(a);
            try p.server.feed(gpa, a, &p.to_client, &p.at_server);
            const b = try p.to_client.toOwnedSlice(gpa);
            defer gpa.free(b);
            try p.client.feed(gpa, b, &p.to_server, &p.at_client);
        }
    }
};

fn pair(client_id: *const keys.Identity, server_id: *const keys.Identity, pin: keys.Fingerprint) !Pair {
    var p: Pair = .{ .client = undefined, .server = undefined };
    p.client = try Session.init(testing.allocator, testing.io, .client, client_id, pin, &p.to_server);
    p.server = try Session.init(testing.allocator, testing.io, .server, server_id, null, &p.to_client);
    return p;
}

test "two ends shake hands, pin the server, learn the client, and carry data both ways" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    var p = try pair(&a, &b, b.fingerprint);
    defer p.deinit();
    // Written before the handshake ends, sent once it does.
    try p.client.send(testing.allocator, "early words", &p.to_server);
    try p.run();
    try testing.expect(p.client.connected() and p.server.connected());
    try testing.expectEqualStrings(&b.fingerprint, &p.client.peer.?);
    try testing.expectEqualStrings(&a.fingerprint, &p.server.peer.?);
    try testing.expectEqualStrings("early words", p.at_server.items);
    const big = try testing.allocator.alloc(u8, 40_000);
    defer testing.allocator.free(big);
    for (big, 0..) |*x, i| x.* = @truncate(i);
    try p.server.send(testing.allocator, big, &p.to_client);
    try p.run();
    try testing.expectEqualSlices(u8, big, p.at_client.items);
}

test "bytes that arrive one at a time still make a handshake" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    var p = try pair(&a, &b, b.fingerprint);
    defer p.deinit();
    const gpa = testing.allocator;
    while (p.to_server.items.len > 0 or p.to_client.items.len > 0) {
        const x = try p.to_server.toOwnedSlice(gpa);
        defer gpa.free(x);
        for (0..x.len) |i| try p.server.feed(gpa, x[i .. i + 1], &p.to_client, &p.at_server);
        const y = try p.to_client.toOwnedSlice(gpa);
        defer gpa.free(y);
        for (0..y.len) |i| try p.client.feed(gpa, y[i .. i + 1], &p.to_server, &p.at_client);
    }
    try testing.expect(p.client.connected() and p.server.connected());
}

test "a dialler refuses a listener whose key isn't the pinned one" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    var p = try pair(&a, &b, a.fingerprint);
    defer p.deinit();
    try testing.expectError(error.BadPeer, p.run());
    try testing.expect(!p.client.connected());
}

test "a CertificateVerify that doesn't verify is refused" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    // The server shows b's certificate but signs with a's key.
    var liar = b;
    liar.pair = a.pair;
    var p = try pair(&a, &liar, b.fingerprint);
    defer p.deinit();
    try testing.expectError(error.BadPeer, p.run());
}

test "a changed record or a cut-short message fails" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    {
        var p = try pair(&a, &b, b.fingerprint);
        defer p.deinit();
        try p.run();
        try p.client.send(testing.allocator, "hello", &p.to_server);
        p.to_server.items[p.to_server.items.len - 1] ^= 0x80;
        try testing.expectError(error.BadRecord, p.run());
    }
    {
        // A ClientHello whose length runs past its end.
        var s = try Session.init(testing.allocator, testing.io, .server, &b, null, undefined);
        defer s.deinit(testing.allocator);
        var out: List = .empty;
        defer out.deinit(testing.allocator);
        var plain: List = .empty;
        defer plain.deinit(testing.allocator);
        try testing.expectError(error.Handshake, s.feed(testing.allocator, &.{ 22, 3, 3, 0, 6, 1, 0, 0, 2, 3, 3 }, &out, &plain));
    }
}

test "a key update from the other end is followed" {
    var a = try keys.generate(testing.allocator, testing.io);
    defer a.deinit(testing.allocator);
    var b = try keys.generate(testing.allocator, testing.io);
    defer b.deinit(testing.allocator);
    var p = try pair(&a, &b, b.fingerprint);
    defer p.deinit();
    try p.run();
    // The server updates its keys and asks the client to do the same.
    try p.server.write.?.seal(testing.allocator, &p.to_client, rec_handshake, &.{ msg_key_update, 0, 0, 1, 1 });
    p.server.write = p.server.write.?.updated();
    try p.run();
    try p.server.send(testing.allocator, "after", &p.to_client);
    try p.client.send(testing.allocator, "both", &p.to_server);
    try p.run();
    try testing.expectEqualStrings("after", p.at_client.items);
    try testing.expectEqualStrings("both", p.at_server.items);
}

/// Feeds arbitrary bytes to each end before and after its hello: whatever
/// arrives, a session fails with an error rather than crashing.
fn fuzzOne(id: *const keys.Identity, smith: *testing.Smith) anyerror!void {
    const gpa = testing.allocator;
    var bytes: [4096]u8 = undefined;
    const n = smith.slice(&bytes);
    inline for (.{ Role.server, Role.client }) |role| {
        var out: List = .empty;
        defer out.deinit(gpa);
        var plain: List = .empty;
        defer plain.deinit(gpa);
        var s = try Session.init(gpa, testing.io, role, id, if (role == .client) id.fingerprint else null, &out);
        defer s.deinit(gpa);
        s.feed(gpa, bytes[0..n], &out, &plain) catch {};
    }
}

test "fuzz: a session survives any bytes that arrive" {
    var id = try keys.generate(testing.allocator, testing.io);
    defer id.deinit(testing.allocator);
    try testing.fuzz(@as(*const keys.Identity, &id), fuzzOne, .{ .corpus = &.{
        &.{ 22, 3, 3, 0, 4, 1, 0, 0, 0 },
        &.{ 22, 3, 3, 0, 4, 2, 0, 0, 0 },
        &([_]u8{ 23, 3, 3, 0, 17 } ++ @as([17]u8, @splat(0))),
        &.{ 20, 3, 3, 0, 1, 1 },
    } });
}

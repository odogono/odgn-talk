//! A Runner's peer key (chapter 12, Runner peers; ADRs 0163 and 0164): an
//! ECDSA P-256 key and a self-signed certificate that only carries it. It
//! reads the PEM file `--peer-key` names, as the TS and Go Runners do, or
//! makes a new key, and gives the key fingerprint: the lowercase hex
//! SHA-256 of the key's DER SubjectPublicKeyInfo.
const std = @import("std");

pub const Ecdsa = std.crypto.sign.ecdsa.EcdsaP256Sha256;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Allocator = std.mem.Allocator;

/// The DER SubjectPublicKeyInfo of a P-256 key, before its 65-byte point:
/// id-ecPublicKey with prime256v1, and a BIT STRING with no unused bits.
const spki_prefix = [_]u8{ 0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00 };
const oid_ec_public_key = [_]u8{ 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01 };
const oid_prime256v1 = [_]u8{ 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07 };
pub const spki_len = spki_prefix.len + 65;

pub const Error = error{ BadKeyFile, NoCertificate, NotP256, KeyMismatch, OutOfMemory };

pub const Fingerprint = [64]u8;

/// This Runner's key: its pair, its certificate's DER, and its fingerprint.
pub const Identity = struct {
    pair: Ecdsa.KeyPair,
    cert: []u8,
    fingerprint: Fingerprint,

    pub fn deinit(id: *Identity, gpa: Allocator) void {
        gpa.free(id.cert);
    }
};

/// The key fingerprint of a DER SubjectPublicKeyInfo.
pub fn fingerprintOf(spki: []const u8) Fingerprint {
    var digest: [32]u8 = undefined;
    Sha256.hash(spki, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

pub fn spkiOf(key: Ecdsa.PublicKey) [spki_len]u8 {
    var out: [spki_len]u8 = undefined;
    @memcpy(out[0..spki_prefix.len], &spki_prefix);
    @memcpy(out[spki_prefix.len..], &key.toUncompressedSec1());
    return out;
}

// ---------------------------------------------------------------- DER

pub const Der = struct {
    tag: u8,
    body: []const u8,
    /// The whole element, tag and length included.
    whole: []const u8,
};

/// Reads one DER element from the front of `bytes`.
pub fn readDer(bytes: []const u8) error{BadDer}!Der {
    if (bytes.len < 2) return error.BadDer;
    var len: usize = bytes[1];
    var at: usize = 2;
    if (len & 0x80 != 0) {
        const n = len & 0x7f;
        if (n == 0 or n > 3 or bytes.len < 2 + n) return error.BadDer;
        len = 0;
        for (bytes[2 .. 2 + n]) |b| len = len << 8 | b;
        at += n;
    }
    if (bytes.len - at < len) return error.BadDer;
    return .{ .tag = bytes[0], .body = bytes[at .. at + len], .whole = bytes[0 .. at + len] };
}

/// The elements inside a constructed element, one at a time.
pub const DerIter = struct {
    rest: []const u8,

    pub fn next(it: *DerIter) error{BadDer}!?Der {
        if (it.rest.len == 0) return null;
        const d = try readDer(it.rest);
        it.rest = it.rest[d.whole.len..];
        return d;
    }

    pub fn expect(it: *DerIter, tag: u8) error{BadDer}!Der {
        const d = (try it.next()) orelse return error.BadDer;
        if (d.tag != tag) return error.BadDer;
        return d;
    }
};

/// The SubjectPublicKeyInfo of a DER certificate, which is all it carries
/// that matters here: its fingerprint and the P-256 point it holds.
pub const CertKey = struct { spki: []const u8, key: Ecdsa.PublicKey };

pub fn certKey(cert: []const u8) error{ BadDer, NotP256 }!CertKey {
    const outer = try readDer(cert);
    if (outer.tag != 0x30) return error.BadDer;
    var top = DerIter{ .rest = outer.body };
    const tbs = try top.expect(0x30);
    var fields = DerIter{ .rest = tbs.body };
    var first = (try fields.next()) orelse return error.BadDer;
    // An explicit [0] version comes before the serial.
    if (first.tag == 0xa0) first = (try fields.next()) orelse return error.BadDer;
    _ = try fields.expect(0x30); // signature algorithm
    _ = try fields.expect(0x30); // issuer
    _ = try fields.expect(0x30); // validity
    _ = try fields.expect(0x30); // subject
    const spki = try fields.expect(0x30);
    if (spki.whole.len != spki_len or !std.mem.eql(u8, spki.whole[0..spki_prefix.len], &spki_prefix)) return error.NotP256;
    const key = Ecdsa.PublicKey.fromSec1(spki.whole[spki_prefix.len..]) catch return error.NotP256;
    return .{ .spki = spki.whole, .key = key };
}

// ---------------------------------------------------------------- PEM

const Block = struct { label: []const u8, body: []const u8 };

/// The PEM blocks in a file, base64 still encoded.
const PemIter = struct {
    rest: []const u8,

    fn next(it: *PemIter) ?Block {
        const begin = "-----BEGIN ";
        const start = std.mem.indexOf(u8, it.rest, begin) orelse return null;
        const after = it.rest[start + begin.len ..];
        const label_end = std.mem.indexOf(u8, after, "-----") orelse return null;
        const label = after[0..label_end];
        const body_start = after[label_end + 5 ..];
        var end_marker_buf: [80]u8 = undefined;
        const end_marker = std.fmt.bufPrint(&end_marker_buf, "-----END {s}-----", .{label}) catch return null;
        const body_end = std.mem.indexOf(u8, body_start, end_marker) orelse return null;
        it.rest = body_start[body_end + end_marker.len ..];
        return .{ .label = label, .body = body_start[0..body_end] };
    }
};

fn decodeBase64(gpa: Allocator, text: []const u8) Error![]u8 {
    var clean: std.ArrayList(u8) = .empty;
    defer clean.deinit(gpa);
    for (text) |ch| if (!std.ascii.isWhitespace(ch)) try clean.append(gpa, ch);
    const decoder = std.base64.standard.Decoder;
    const n = decoder.calcSizeForSlice(clean.items) catch return error.BadKeyFile;
    const out = try gpa.alloc(u8, n);
    errdefer gpa.free(out);
    decoder.decode(out, clean.items) catch return error.BadKeyFile;
    return out;
}

/// The 32-byte secret of a SEC1 ECPrivateKey, checking any curve it names.
fn sec1Secret(der: []const u8) Error![32]u8 {
    const outer = readDer(der) catch return error.BadKeyFile;
    if (outer.tag != 0x30) return error.BadKeyFile;
    var it = DerIter{ .rest = outer.body };
    const version = it.expect(0x02) catch return error.BadKeyFile;
    if (!std.mem.eql(u8, version.body, &.{1})) return error.BadKeyFile;
    const secret = it.expect(0x04) catch return error.BadKeyFile;
    while (it.next() catch return error.BadKeyFile) |field| if (field.tag == 0xa0) {
        const oid = readDer(field.body) catch return error.BadKeyFile;
        if (!std.mem.eql(u8, oid.body, &oid_prime256v1)) return error.NotP256;
    };
    if (secret.body.len != 32) return error.NotP256;
    return secret.body[0..32].*;
}

/// The secret of a PKCS #8 PrivateKeyInfo holding a P-256 key.
fn pkcs8Secret(der: []const u8) Error![32]u8 {
    const outer = readDer(der) catch return error.BadKeyFile;
    if (outer.tag != 0x30) return error.BadKeyFile;
    var it = DerIter{ .rest = outer.body };
    _ = it.expect(0x02) catch return error.BadKeyFile;
    const algorithm = it.expect(0x30) catch return error.BadKeyFile;
    var alg = DerIter{ .rest = algorithm.body };
    const kind = alg.expect(0x06) catch return error.BadKeyFile;
    if (!std.mem.eql(u8, kind.body, &oid_ec_public_key)) return error.NotP256;
    const curve = alg.expect(0x06) catch return error.NotP256;
    if (!std.mem.eql(u8, curve.body, &oid_prime256v1)) return error.NotP256;
    const inner = it.expect(0x04) catch return error.BadKeyFile;
    return sec1Secret(inner.body);
}

/// Reads a `--peer-key` file: a P-256 key, PKCS #8 or SEC1, and the
/// certificate that carries it, in either order.
pub fn parse(gpa: Allocator, pem: []const u8) Error!Identity {
    var secret: ?[32]u8 = null;
    var cert: ?[]u8 = null;
    errdefer if (cert) |x| gpa.free(x);
    var it = PemIter{ .rest = pem };
    while (it.next()) |block| {
        if (std.mem.eql(u8, block.label, "CERTIFICATE")) {
            if (cert != null) continue;
            cert = try decodeBase64(gpa, block.body);
        } else if (std.mem.eql(u8, block.label, "PRIVATE KEY") or std.mem.eql(u8, block.label, "EC PRIVATE KEY")) {
            const der = try decodeBase64(gpa, block.body);
            defer {
                std.crypto.secureZero(u8, der);
                gpa.free(der);
            }
            secret = if (block.label.len == "PRIVATE KEY".len) try pkcs8Secret(der) else try sec1Secret(der);
        } else if (std.mem.eql(u8, block.label, "EC PARAMETERS")) {
            continue;
        } else return error.NotP256;
    }
    const s = secret orelse return error.BadKeyFile;
    const c = cert orelse return error.NoCertificate;
    const sk = Ecdsa.SecretKey.fromBytes(s) catch return error.BadKeyFile;
    const pair = Ecdsa.KeyPair.fromSecretKey(sk) catch return error.BadKeyFile;
    const carried = certKey(c) catch |e| return if (e == error.NotP256) error.NotP256 else error.BadKeyFile;
    if (!std.mem.eql(u8, &spkiOf(pair.public_key), carried.spki)) return error.KeyMismatch;
    return .{ .pair = pair, .cert = c, .fingerprint = fingerprintOf(carried.spki) };
}

// ---------------------------------------------------------------- a new key

fn derHead(out: *std.ArrayList(u8), gpa: Allocator, tag: u8, len: usize) Allocator.Error!void {
    try out.append(gpa, tag);
    if (len < 0x80) {
        try out.append(gpa, @intCast(len));
    } else if (len < 0x100) {
        try out.appendSlice(gpa, &.{ 0x81, @intCast(len) });
    } else {
        try out.appendSlice(gpa, &.{ 0x82, @intCast(len >> 8), @intCast(len & 0xff) });
    }
}

fn derOf(gpa: Allocator, tag: u8, parts: []const []const u8) Allocator.Error![]u8 {
    var len: usize = 0;
    for (parts) |part| len += part.len;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try derHead(&out, gpa, tag, len);
    for (parts) |part| try out.appendSlice(gpa, part);
    return out.toOwnedSlice(gpa);
}

// ecdsa-with-SHA256, 1.2.840.10045.4.3.2.
const ecdsa_sha256 = [_]u8{ 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02 };
// CN=northtalk: the certificate only carries the key.
const name_der = [_]u8{ 0x30, 0x14, 0x31, 0x12, 0x30, 0x10, 0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, 0x09 } ++ "northtalk".*;
const validity_der = [_]u8{ 0x30, 0x20, 0x17, 0x0d } ++ "250101000000Z".* ++ [_]u8{ 0x18, 0x0f } ++ "99991231235959Z".*;

/// A self-signed certificate for a key, as the TS Runner makes one.
pub fn certificate(gpa: Allocator, io: std.Io, pair: Ecdsa.KeyPair) (Allocator.Error || error{SignFailed})![]u8 {
    var serial: [16]u8 = undefined;
    io.random(&serial);
    // Positive, with a nonzero first byte, so the INTEGER is minimal.
    serial[0] = (serial[0] & 0x7f) | 0x40;
    const serial_der = [_]u8{ 0x02, 16 } ++ serial;
    const spki = spkiOf(pair.public_key);
    const tbs = try derOf(gpa, 0x30, &.{ &.{ 0xa0, 0x03, 0x02, 0x01, 0x02 }, &serial_der, &ecdsa_sha256, &name_der, &validity_der, &name_der, &spki });
    defer gpa.free(tbs);
    const sig = pair.sign(tbs, null) catch return error.SignFailed;
    var sig_buf: [Ecdsa.Signature.der_encoded_length_max]u8 = undefined;
    const sig_der = sig.toDer(&sig_buf);
    const bits = try derOf(gpa, 0x03, &.{ &.{0}, sig_der });
    defer gpa.free(bits);
    return derOf(gpa, 0x30, &.{ tbs, &ecdsa_sha256, bits });
}

/// A new key and its certificate, for a Runner without `--peer-key`.
pub fn generate(gpa: Allocator, io: std.Io) (Allocator.Error || error{SignFailed})!Identity {
    const pair = Ecdsa.KeyPair.generate(io);
    const cert = try certificate(gpa, io, pair);
    return .{ .pair = pair, .cert = cert, .fingerprint = fingerprintOf(&spkiOf(pair.public_key)) };
}

// ---------------------------------------------------------------- tests

const testing = std.testing;

// Made by `openssl ecparam -name prime256v1 -genkey` and a self-signed
// certificate; its fingerprint is `openssl x509 -pubkey | openssl pkey
// -pubin -outform der | sha256sum`.
const sec1_pem = @embedFile("testdata/sec1.pem");
const pkcs8_pem = @embedFile("testdata/pkcs8.pem");
const p384_pem = @embedFile("testdata/p384.pem");
const fingerprint_txt = @embedFile("testdata/fingerprint.txt");

test "a --peer-key file reads with its key in PKCS #8 or SEC1, before or after the certificate" {
    inline for (.{ sec1_pem, pkcs8_pem }) |pem| {
        var id = try parse(testing.allocator, pem);
        defer id.deinit(testing.allocator);
        try testing.expectEqualStrings(fingerprint_txt[0..64], &id.fingerprint);
    }
}

test "a --peer-key file without a certificate, or with another curve, is refused" {
    const key_only = sec1_pem[0..std.mem.indexOf(u8, sec1_pem, "-----BEGIN CERTIFICATE").?];
    try testing.expectError(error.NoCertificate, parse(testing.allocator, key_only));
    try testing.expectError(error.NotP256, parse(testing.allocator, p384_pem));
    try testing.expectError(error.BadKeyFile, parse(testing.allocator, "nothing here"));
}

test "a new key's certificate carries it, and its fingerprint is the key's" {
    var id = try generate(testing.allocator, testing.io);
    defer id.deinit(testing.allocator);
    const carried = try certKey(id.cert);
    try testing.expectEqualSlices(u8, &spkiOf(id.pair.public_key), carried.spki);
    try testing.expectEqualStrings(&fingerprintOf(carried.spki), &id.fingerprint);
    // Its self-signature verifies, so stacks that check it still take it.
    const outer = try readDer(id.cert);
    var top = DerIter{ .rest = outer.body };
    const tbs = try top.expect(0x30);
    _ = try top.expect(0x30);
    const bits = try top.expect(0x03);
    const sig = try Ecdsa.Signature.fromDer(bits.body[1..]);
    try sig.verify(tbs.whole, id.pair.public_key);
}

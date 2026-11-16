package main

// The Script Runner's `peer` transport (chapter 12, Runner peers; ADR 0163),
// as tooling/cli/src/peers.ts has it: Remote Sends between Runners over
// mutual TLS, each end pinned by its key's fingerprint, or over plain TCP on
// loopback, as length-prefixed frames in the Value Encoding.

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	talk "northtalk.org/go"
	"northtalk.org/go/peer"
)

// maxFrame is the largest frame a Runner sends or reads.
const maxFrame = 16 << 20

// peerAddress is where a Runner listens or dials; plain is TCP without TLS.
type peerAddress struct {
	host  string
	port  int
	plain bool
}

// peerRemote is a `--peer`: plain ones pin no key.
type peerRemote struct {
	peerAddress
	fingerprint string
}

type peerOptions struct {
	keyFile string
	listen  *peerAddress
	remotes map[string]peerRemote
	log     func(string)
}

// Plain TCP carries no key to check, so it stays on this machine.
var loopback = map[string]bool{"127.0.0.1": true, "::1": true, "localhost": true}

func addressOf(scheme, host, port string) (peerAddress, error) {
	bare := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 {
		return peerAddress{}, fmt.Errorf("not a port: %s", port)
	}
	plain := scheme == "tcp"
	if plain && !loopback[bare] {
		return peerAddress{}, fmt.Errorf("tcp:// is only for loopback, not %s", host)
	}
	return peerAddress{host: bare, port: n, plain: plain}, nil
}

var (
	tlsPeer  = regexp.MustCompile(`^([^=]+)=tls://(.+):(\d+)#([0-9a-f]{64})$`)
	tcpPeer  = regexp.MustCompile(`^([^=]+)=tcp://(.+):(\d+)$`)
	listenAt = regexp.MustCompile(`^(?:(tls|tcp)://)?(.+):(\d+)$`)
)

// parsePeerFlag reads `NAME=tls://HOST:PORT#FINGERPRINT` or `NAME=tcp://HOST:PORT`.
func parsePeerFlag(given string) (string, peerRemote, error) {
	if m := tlsPeer.FindStringSubmatch(given); m != nil {
		a, err := addressOf("tls", m[2], m[3])
		return m[1], peerRemote{a, m[4]}, err
	}
	if m := tcpPeer.FindStringSubmatch(given); m != nil {
		a, err := addressOf("tcp", m[2], m[3])
		return m[1], peerRemote{peerAddress: a}, err
	}
	return "", peerRemote{}, fmt.Errorf("--peer wants NAME=tls://HOST:PORT#FINGERPRINT or NAME=tcp://HOST:PORT: %s", given)
}

// parseListen reads `HOST:PORT` or `tls://HOST:PORT` for TLS, `tcp://HOST:PORT` for plain.
func parseListen(given string) (peerAddress, error) {
	m := listenAt.FindStringSubmatch(given)
	if m == nil {
		return peerAddress{}, fmt.Errorf("--listen wants [tls://|tcp://]HOST:PORT: %s", given)
	}
	return addressOf(m[1], m[2], m[3])
}

// ---------------------------------------------------------------- keys

// fingerprintOf is the key fingerprint: lowercase hex SHA-256 of the DER
// SubjectPublicKeyInfo.
func fingerprintOf(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(sum[:])
}

// newPeerKey makes an ECDSA P-256 key and a self-signed certificate that
// only carries it, as the PEM `--peer-key` reads.
func newPeerKey() ([]byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := cryptorand.Int(cryptorand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "northtalk"},
		NotBefore:    time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC),
	}
	der, err := x509.CreateCertificate(cryptorand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})
	return append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...), nil
}

func loadPeerKey(file string) (tls.Certificate, string, error) {
	var pemBytes []byte
	var err error
	if file == "" {
		pemBytes, err = newPeerKey()
	} else {
		pemBytes, err = os.ReadFile(file)
	}
	if err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.X509KeyPair(pemBytes, pemBytes)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, "", err
	}
	return cert, fingerprintOf(leaf), nil
}

// ---------------------------------------------------------------- links

// link is one connection to another Runner, either way round: a peer.Link
// that moves length-prefixed frames.
type link struct {
	r     *runnerPeers
	conn  net.Conn
	in    *bufio.Reader
	plain bool
	// fingerprint is the other end's key: checked over TLS, as it claims
	// over plain TCP.
	fingerprint string
	mu          sync.Mutex
	closed      bool
}

func newLink(r *runnerPeers, conn net.Conn, key string, plain bool) *link {
	return &link{r: r, conn: conn, in: bufio.NewReader(conn), plain: plain, fingerprint: key}
}

func (l *link) Key() string { return l.fingerprint }

// Identity is the Caller Identity of what arrives on l: none over plain TCP,
// which authenticates nobody, and otherwise the key, with the `--peer` name
// pinned to it.
func (l *link) Identity() talk.Value {
	if l.plain {
		return talk.Nothing
	}
	pairs := []talk.Pair{{Key: "key", Val: mustText(l.fingerprint)}}
	if name, named := l.r.nameOf(l.fingerprint); named {
		pairs = append(pairs, talk.Pair{Key: "name", Val: mustText(name)})
	}
	v, _ := talk.Map(pairs...)
	return v
}

func (l *link) Send(body []byte) bool {
	if len(body) > maxFrame {
		return false
	}
	head := make([]byte, 4)
	binary.BigEndian.PutUint32(head, uint32(len(body)))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	_, err := l.conn.Write(append(head, body...))
	return err == nil
}

// read is the next whole frame; false once the link fails or closes.
func (l *link) read() ([]byte, bool) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(l.in, head); err != nil {
		return nil, false
	}
	n := binary.BigEndian.Uint32(head)
	if n > maxFrame {
		return nil, false
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(l.in, body); err != nil {
		return nil, false
	}
	return body, true
}

func (l *link) Run(arrive func([]byte)) {
	defer l.Close()
	for {
		body, ok := l.read()
		if !ok {
			return
		}
		arrive(body)
	}
}

func (l *link) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		_ = l.conn.Close()
	}
}

// greet opens a plain connection: each end first says which key it is, with
// nothing to check it by. nil when the other end doesn't say in time.
func (r *runnerPeers) greet(conn net.Conn) *link {
	l := newLink(r, conn, "", true)
	hello, _ := talk.Map(talk.Pair{Key: "hello", Val: mustText(r.fingerprint)})
	body, _ := talk.EncodeValue(hello)
	if !l.Send(body) {
		l.Close()
		return nil
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	frame, ok := l.read()
	_ = conn.SetReadDeadline(time.Time{})
	if !ok {
		l.Close()
		return nil
	}
	said, err := talk.DecodeValue(frame, nil)
	key, _ := said.Get("hello").AsText()
	if err != nil || len(key) != 64 || strings.Trim(key, "0123456789abcdef") != "" {
		l.Close()
		return nil
	}
	l.fingerprint = key
	return l
}

// ---------------------------------------------------------------- the Host

// runnerPeers is the Runner's side of `peer`: its key, its listener and its
// links, around the Peer Router that holds its exposures.
type runnerPeers struct {
	o           peerOptions
	cert        tls.Certificate
	fingerprint string
	router      *peer.Router

	mu       sync.Mutex
	listener net.Listener
	// byKey is the `--peer` name for each key: pinned ones, and what a plain
	// one claimed when dialled.
	byKey map[string]string
}

func newRunnerPeers(core *talk.Core, o peerOptions) (*runnerPeers, error) {
	cert, fingerprint, err := loadPeerKey(o.keyFile)
	if err != nil {
		return nil, err
	}
	r := &runnerPeers{o: o, cert: cert, fingerprint: fingerprint, byKey: map[string]string{}}
	for name, remote := range o.remotes {
		if remote.fingerprint != "" {
			r.byKey[remote.fingerprint] = name
		}
	}
	r.router = peer.New(core, peer.Options{
		Key: fingerprint,
		Dial: func(address string) peer.Link {
			if l := r.dial(address); l != nil {
				return l
			}
			return nil
		},
		AddressOf: r.nameOf,
	})
	return r, nil
}

func (r *runnerPeers) nameOf(key string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name, named := r.byKey[key]
	return name, named
}

// binding is the `peer` Grant's binding: a Script reaches only the Runners
// a `--peer` names, and exposes any name.
func (r *runnerPeers) binding() peer.Binding {
	reach := []string{}
	for name := range r.o.remotes {
		reach = append(reach, name)
	}
	return peer.Binding{Reach: reach}
}

// listening is whether the Runner listens, which keeps it running.
func (r *runnerPeers) listening() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listener != nil
}

func (r *runnerPeers) start(group *talk.Group) error {
	// A Peer of the Runner's own exposure is vouched for as its own key.
	self, _ := talk.Map(talk.Pair{Key: "key", Val: mustText(r.fingerprint)})
	r.router.Attach(group, self)
	if r.o.listen != nil || len(r.o.remotes) > 0 || r.o.keyFile != "" {
		r.o.log("peer: key " + r.fingerprint)
	}
	at := r.o.listen
	if at == nil {
		return nil
	}
	address := net.JoinHostPort(at.host, strconv.Itoa(at.port))
	var ln net.Listener
	var err error
	if at.plain {
		ln, err = net.Listen("tcp", address)
	} else {
		ln, err = tls.Listen("tcp", address, &tls.Config{
			Certificates: []tls.Certificate{r.cert},
			ClientAuth:   tls.RequireAnyClientCert,
			MinVersion:   tls.VersionTLS13,
		})
	}
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.listener = ln
	r.mu.Unlock()
	port := ln.Addr().(*net.TCPAddr).Port
	host := at.host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if at.plain {
		r.o.log(fmt.Sprintf("peer: listening on tcp://%s:%d", host, port))
	} else {
		r.o.log(fmt.Sprintf("peer: listening on tls://%s:%d#%s", host, port, r.fingerprint))
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go r.accept(conn, at.plain)
		}
	}()
	return nil
}

func (r *runnerPeers) accept(conn net.Conn, plain bool) {
	if plain {
		if l := r.greet(conn); l != nil {
			r.router.Connect(l)
		}
		return
	}
	t := conn.(*tls.Conn)
	if err := t.Handshake(); err != nil {
		_ = conn.Close()
		return
	}
	certs := t.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		_ = conn.Close()
		return
	}
	r.router.Connect(newLink(r, conn, fingerprintOf(certs[0]), false))
}

func (r *runnerPeers) stopListening() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listener != nil {
		_ = r.listener.Close()
		r.listener = nil
	}
}

func (r *runnerPeers) close() {
	r.stopListening()
	r.router.Close()
}

// dial is a new link to the Runner a `--peer` names; nil when it can't be
// reached or doesn't have the pinned key.
func (r *runnerPeers) dial(name string) *link {
	remote, named := r.o.remotes[name]
	if !named {
		return nil
	}
	address := net.JoinHostPort(remote.host, strconv.Itoa(remote.port))
	if remote.plain {
		conn, err := net.DialTimeout("tcp", address, 10*time.Second)
		if err != nil {
			r.o.log(fmt.Sprintf("peer: %s: %v", name, err))
			return nil
		}
		l := r.greet(conn)
		if l != nil {
			// What it claimed is all a plain link has to go on.
			r.mu.Lock()
			r.byKey[l.fingerprint] = name
			r.mu.Unlock()
		}
		return l
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", address, &tls.Config{
		Certificates:       []tls.Certificate{r.cert},
		InsecureSkipVerify: true, // the key is pinned below instead
		MinVersion:         tls.VersionTLS13,
	})
	if err != nil {
		r.o.log(fmt.Sprintf("peer: %s: %v", name, err))
		return nil
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 || fingerprintOf(certs[0]) != remote.fingerprint {
		r.o.log(fmt.Sprintf("peer: %s has the wrong key", name))
		_ = conn.Close()
		return nil
	}
	return newLink(r, conn, remote.fingerprint, false)
}

package main

// The Script Runner's `peer` transport (chapter 12, Runner peers; ADR 0163),
// as tooling/cli/src/peers.ts has it: Remote Sends between Runners over
// mutual TLS, each end pinned by its key's fingerprint, or over plain TCP on
// loopback, as length-prefixed frames in the Value Encoding.

import (
	"bufio"
	"context"
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
	"errors"
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

// ---------------------------------------------------------------- frames

// link is one connection to another Runner, either way round.
type link struct {
	conn  net.Conn
	plain bool
	mu    sync.Mutex
	// fingerprint is the other end's key: checked over TLS, as it claims
	// over plain TCP.
	fingerprint string
	next        int
	asked       map[int]chan talk.Value
	closed      bool
	hello       chan struct{}
}

func (l *link) send(frame talk.Value) bool {
	body, err := talk.EncodeValue(frame)
	if err != nil || len(body) > maxFrame {
		return false
	}
	head := make([]byte, 4)
	binary.BigEndian.PutUint32(head, uint32(len(body)))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	_, err = l.conn.Write(append(head, body...))
	return err == nil
}

// begin sends a question; its answer comes on the channel, which closes
// unanswered when the link does. Questions go out in the order begun.
func (l *link) begin(kind string, rest ...talk.Pair) (<-chan talk.Value, bool) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, false
	}
	l.next++
	n := l.next
	answer := make(chan talk.Value, 1)
	l.asked[n] = answer
	l.mu.Unlock()
	frame, _ := talk.Map(append([]talk.Pair{{Key: kind, Val: talk.Int(int64(n))}}, rest...)...)
	if !l.send(frame) {
		return nil, false
	}
	return answer, true
}

// ask sends a question and waits for its answer; false when the link
// closes first.
func (l *link) ask(kind string, rest ...talk.Pair) (talk.Value, bool) {
	answer, ok := l.begin(kind, rest...)
	if !ok {
		return talk.Nothing, false
	}
	v, ok := <-answer
	return v, ok
}

func (l *link) answered(n int, frame talk.Value) {
	l.mu.Lock()
	answer := l.asked[n]
	delete(l.asked, n)
	l.mu.Unlock()
	if answer != nil {
		answer <- frame
	}
}

func (l *link) isClosed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

func (l *link) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	_ = l.conn.Close()
	for n, answer := range l.asked {
		close(answer)
		delete(l.asked, n)
	}
}

func has(frame talk.Value, key string) bool {
	for _, p := range frame.Entries() {
		if p.Key == key {
			return true
		}
	}
	return false
}

func textField(frame talk.Value, key string) string {
	s, _ := frame.Get(key).AsText()
	return s
}

func wholeField(frame talk.Value, key string) (int, bool) {
	if !has(frame, key) || frame.Get(key).Kind() != talk.KindNumber {
		return 0, false
	}
	n, err := strconv.Atoi(frame.Get(key).String())
	return n, err == nil
}

func failure(code string, pairs ...talk.Pair) *talk.ScriptError {
	data, _ := talk.Map(pairs...)
	return &talk.ScriptError{Code: code, Message: code, Data: data}
}

func sendFailed(reason string, err talk.Value) *talk.ScriptError {
	pairs := []talk.Pair{{Key: "reason", Val: mustText(reason)}}
	if err.Kind() != talk.KindNothing {
		pairs = append(pairs, talk.Pair{Key: "error", Val: err})
	}
	return failure("send failed", pairs...)
}

// ---------------------------------------------------------------- the Host

type exposure struct{ name, script string }

// runnerPeers is the Runner's side of `peer`: its exposures, its links and
// its key.
type runnerPeers struct {
	o           peerOptions
	cert        tls.Certificate
	fingerprint string
	group       *talk.Group
	kind        *talk.ObjectKind
	listener    net.Listener

	mu        sync.Mutex
	exposures map[string]exposure
	names     map[string]string
	peers     map[string]*talk.Object
	links     map[string]*link
	callers   map[string]talk.Value
	byKey     map[string]string
	// outboxes hold each destination's Remote Sends, in the order the
	// Script made them, for one goroutine to dial and send.
	outboxes map[string]chan func(*link)
}

func newRunnerPeers(core *talk.Core, o peerOptions) (*runnerPeers, error) {
	cert, fingerprint, err := loadPeerKey(o.keyFile)
	if err != nil {
		return nil, err
	}
	r := &runnerPeers{o: o, cert: cert, fingerprint: fingerprint, kind: core.PeerKind(),
		exposures: map[string]exposure{}, names: map[string]string{}, peers: map[string]*talk.Object{},
		links: map[string]*link{}, callers: map[string]talk.Value{}, byKey: map[string]string{},
		outboxes: map[string]chan func(*link){}}
	for name, remote := range o.remotes {
		if remote.fingerprint != "" {
			r.byKey[remote.fingerprint] = name
		}
	}
	return r, nil
}

// listening is whether the Runner listens, which keeps it running.
func (r *runnerPeers) listening() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listener != nil
}

func (r *runnerPeers) start(group *talk.Group) error {
	r.group = group
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
		r.greet(conn)
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
	r.adopt(conn, fingerprintOf(certs[0]), false)
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
	r.mu.Lock()
	links := make([]*link, 0, len(r.links))
	for _, l := range r.links {
		links = append(links, l)
	}
	r.mu.Unlock()
	for _, l := range links {
		l.close()
	}
}

// adopt starts reading a connection whose other end is known, or, for a
// plain one, will say who it is.
func (r *runnerPeers) adopt(conn net.Conn, key string, plain bool) *link {
	l := &link{conn: conn, plain: plain, fingerprint: key, asked: map[int]chan talk.Value{}, hello: make(chan struct{})}
	if key != "" {
		r.mu.Lock()
		// The newest link to a key carries what this Runner sends there.
		r.links[key] = l
		r.mu.Unlock()
	}
	go r.read(l)
	return l
}

// greet opens a plain connection: each end first says which key it is,
// with nothing to check it by.
func (r *runnerPeers) greet(conn net.Conn) *link {
	l := r.adopt(conn, "", true)
	hello, _ := talk.Map(talk.Pair{Key: "hello", Val: mustText(r.fingerprint)})
	l.send(hello)
	select {
	case <-l.hello:
		return l
	case <-time.After(10 * time.Second):
		l.close()
		return nil
	}
}

func (r *runnerPeers) read(l *link) {
	defer func() {
		l.close()
		r.mu.Lock()
		if r.links[l.fingerprint] == l {
			delete(r.links, l.fingerprint)
		}
		r.mu.Unlock()
	}()
	in := bufio.NewReader(l.conn)
	head := make([]byte, 4)
	for {
		if _, err := io.ReadFull(in, head); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(head)
		if n > maxFrame {
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(in, body); err != nil {
			return
		}
		frame, err := talk.DecodeValue(body, func(kind, id string) (*talk.Object, bool) {
			if kind != peerKindName {
				return nil, false
			}
			p, err := r.peerFor(id)
			return p, err == nil
		})
		if err != nil || frame.Kind() != talk.KindMap {
			return
		}
		r.arrive(l, frame)
	}
}

const peerKindName = "peer"

var peerID = regexp.MustCompile(`^([0-9a-f]{64})/([0-9a-f]{32})$`)

func splitID(id string) (string, string, bool) {
	m := peerID.FindStringSubmatch(id)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// peerFor is this Group's one Peer for an exposure id.
func (r *runnerPeers) peerFor(id string) (*talk.Object, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p := r.peers[id]; p != nil {
		return p, nil
	}
	if p, found := r.group.ObjectByID(peerKindName, id); found && p != nil {
		r.peers[id] = p
		return p, nil
	}
	p, err := r.group.Object(r.kind, id, nil)
	if err != nil {
		return nil, err
	}
	r.peers[id] = p
	return p, nil
}

// identityOf is the Caller Identity of what arrives on l: none over plain
// TCP, which authenticates nobody.
func (r *runnerPeers) identityOf(l *link, key string) talk.Value {
	if l != nil && l.plain {
		return talk.Nothing
	}
	pairs := []talk.Pair{{Key: "key", Val: mustText(key)}}
	r.mu.Lock()
	name, named := r.byKey[key]
	r.mu.Unlock()
	if named {
		pairs = append(pairs, talk.Pair{Key: "name", Val: mustText(name)})
	}
	v, _ := talk.Map(pairs...)
	return v
}

// local gives a Remote Send to this Runner's exposure: a Delivery, or for a
// call a Request whose Pending is returned. reason is set when it can't go.
func (r *runnerPeers) local(l *link, key, secret, message string, args []talk.Value, waits bool) (*talk.Pending, string) {
	r.mu.Lock()
	e, held := r.exposures[secret]
	r.mu.Unlock()
	var s *talk.Script
	if held {
		s = r.group.Script(e.script)
	}
	if s == nil {
		return nil, "not exposed"
	}
	m := talk.Message{Name: message, Args: args}
	identity := r.identityOf(l, key)
	if !waits {
		if id, err := s.Deliver(m); err == nil {
			r.vouch(id, identity)
		}
		return nil, ""
	}
	id, pending, err := s.Request(context.Background(), m)
	if errors.Is(err, talk.ErrMailboxFull) {
		return nil, "mailbox full"
	}
	if err != nil {
		return nil, "unreachable"
	}
	r.vouch(id, identity)
	return pending, ""
}

func (r *runnerPeers) vouch(id talk.DeliveryID, identity talk.Value) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.callers[string(id)] = identity
}

func (r *runnerPeers) arrive(l *link, frame talk.Value) {
	if l.plain && l.fingerprint == "" {
		// A plain link's first frame says which key the other end is.
		hello := textField(frame, "hello")
		if len(hello) != 64 || strings.Trim(hello, "0123456789abcdef") != "" {
			l.close()
			return
		}
		l.fingerprint = hello
		r.mu.Lock()
		r.links[hello] = l
		r.mu.Unlock()
		close(l.hello)
		return
	}
	if n, ok := wholeField(frame, "reached"); ok {
		l.answered(n, frame)
		return
	}
	if n, ok := wholeField(frame, "replied"); ok {
		l.answered(n, frame)
		return
	}
	if n, ok := wholeField(frame, "reach"); ok {
		r.mu.Lock()
		key, named := r.names[textField(frame, "name")]
		r.mu.Unlock()
		answer := talk.Pair{Key: "error", Val: mustText("not exposed")}
		if named {
			answer = talk.Pair{Key: "peer", Val: mustText(r.fingerprint + "/" + key)}
		}
		reply, _ := talk.Map(talk.Pair{Key: "reached", Val: talk.Int(int64(n))}, answer)
		l.send(reply)
		return
	}
	message := textField(frame, "message")
	var args []talk.Value
	for i := 1; i <= frame.Get("args").Len(); i++ {
		args = append(args, frame.Get("args").Index(i))
	}
	if has(frame, "post") {
		if key, secret, ok := splitID(textField(frame, "post")); ok && key == r.fingerprint {
			r.local(l, l.fingerprint, secret, message, args, false)
		}
		return
	}
	n, ok := wholeField(frame, "call")
	if !ok {
		return
	}
	reply := func(p talk.Pair) {
		v, _ := talk.Map(talk.Pair{Key: "replied", Val: talk.Int(int64(n))}, p)
		l.send(v)
	}
	failed := func(reason string, err talk.Value) {
		pairs := []talk.Pair{{Key: "reason", Val: mustText(reason)}}
		if err.Kind() != talk.KindNothing {
			pairs = append(pairs, talk.Pair{Key: "error", Val: err})
		}
		f, _ := talk.Map(pairs...)
		reply(talk.Pair{Key: "failed", Val: f})
	}
	key, secret, ok := splitID(textField(frame, "to"))
	if !ok || key != r.fingerprint {
		failed("not exposed", talk.Nothing)
		return
	}
	pending, reason := r.local(l, l.fingerprint, secret, message, args, true)
	if pending == nil {
		failed(reason, talk.Nothing)
		return
	}
	go func() {
		<-pending.Done()
		value, err := pending.Result()
		if err != nil {
			reason := "unreachable"
			errValue := talk.Nothing
			if err.Code == "send failed" {
				if s, ok := err.Data.Get("reason").AsText(); ok {
					reason = s
				}
				errValue = err.Data.Get("error")
			}
			failed(reason, errValue)
			return
		}
		reply(talk.Pair{Key: "value", Val: value})
	}()
}

// linkTo is a link to the Host with this key, dialled if a `--peer` gives it.
func (r *runnerPeers) linkTo(key string) *link {
	r.mu.Lock()
	open := r.links[key]
	name, named := r.byKey[key]
	r.mu.Unlock()
	if open != nil {
		return open
	}
	if !named {
		return nil
	}
	return r.dial(name)
}

// dial is a link to the Runner a `--peer` names, dialled if none is open.
func (r *runnerPeers) dial(name string) *link {
	remote := r.o.remotes[name]
	if remote.fingerprint != "" {
		r.mu.Lock()
		open := r.links[remote.fingerprint]
		r.mu.Unlock()
		if open != nil {
			return open
		}
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
	return r.adopt(conn, remote.fingerprint, false)
}

// The talk.PeerImpl the Runner grants.

func (r *runnerPeers) Expose(c *talk.Call, name string) error {
	r.mu.Lock()
	if key, named := r.names[name]; name != "" && named {
		e := r.exposures[key]
		r.mu.Unlock()
		if e.script != c.ScriptName() {
			c.Fail(failure("name in use"))
			return nil
		}
		return r.answerPeer(c, r.fingerprint+"/"+key)
	}
	secret := make([]byte, 16)
	_, _ = cryptorand.Read(secret)
	key := hex.EncodeToString(secret)
	r.exposures[key] = exposure{name: name, script: c.ScriptName()}
	if name != "" {
		r.names[name] = key
	}
	r.mu.Unlock()
	return r.answerPeer(c, r.fingerprint+"/"+key)
}

func (r *runnerPeers) answerPeer(c *talk.Call, id string) error {
	p, err := r.peerFor(id)
	if err != nil {
		return err
	}
	c.Answer(p.Value())
	return nil
}

func (r *runnerPeers) Unexpose(c *talk.Call, name string, peer *talk.Object) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := r.names[name]
	if peer != nil {
		_, key, _ = splitID(peer.ID())
	}
	e, held := r.exposures[key]
	if !held || e.script != c.ScriptName() {
		return nil
	}
	delete(r.exposures, key)
	if e.name != "" {
		delete(r.names, e.name)
	}
	return nil
}

func (r *runnerPeers) Reach(c *talk.Call, address string) error {
	if _, named := r.o.remotes[address]; !named {
		c.Fail(failure("bad address"))
		return nil
	}
	go func() {
		l := r.dial(address)
		if l == nil {
			c.Fail(failure("bad address"))
			return
		}
		frame, ok := l.ask("reach", talk.Pair{Key: "name", Val: mustText(address)})
		if !ok {
			c.Fail(failure("bad address"))
			return
		}
		id := textField(frame, "peer")
		if key, _, valid := splitID(id); !valid || key != l.fingerprint {
			c.Fail(failure("not exposed"))
			return
		}
		if err := r.answerPeer(c, id); err != nil {
			c.Fail(failure("bad address"))
		}
	}()
	return nil
}

func (r *runnerPeers) Post(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	return r.remoteSend(c, peer, message, args, false)
}

func (r *runnerPeers) Call(c *talk.Call, peer *talk.Object, message string, args []talk.Value) error {
	return r.remoteSend(c, peer, message, args, true)
}

func (r *runnerPeers) remoteSend(c *talk.Call, peer *talk.Object, message string, args []talk.Value, waits bool) error {
	key, secret, ok := splitID(peer.ID())
	if !ok {
		if waits {
			c.Fail(sendFailed("unreachable", talk.Nothing))
		}
		return nil
	}
	if key == r.fingerprint {
		// A Peer of this Runner's own exposure: still a Remote Send.
		pending, reason := r.local(nil, key, secret, message, args, waits)
		if !waits {
			return nil
		}
		if pending == nil {
			c.Fail(sendFailed(reason, talk.Nothing))
			return nil
		}
		go func() {
			<-pending.Done()
			value, err := pending.Result()
			if err != nil {
				c.Fail(failure(err.Code, err.Data.Entries()...))
				return
			}
			c.Answer(value)
		}()
		return nil
	}
	rest := []talk.Pair{{Key: "message", Val: mustText(message)}, {Key: "args", Val: talk.List(args...)}}
	r.enqueue(key, func(l *link) {
		if !waits {
			if l != nil {
				frame, _ := talk.Map(append([]talk.Pair{{Key: "post", Val: mustText(peer.ID())}}, rest...)...)
				l.send(frame)
			}
			return
		}
		var answer <-chan talk.Value
		ok := l != nil
		if ok {
			answer, ok = l.begin("call", append([]talk.Pair{{Key: "to", Val: mustText(peer.ID())}}, rest...)...)
		}
		if !ok {
			c.Fail(sendFailed("unreachable", talk.Nothing))
			return
		}
		go func() {
			frame, ok := <-answer
			switch {
			case ok && has(frame, "value"):
				c.Answer(frame.Get("value"))
			case ok && has(frame, "failed"):
				failed := frame.Get("failed")
				reason, _ := failed.Get("reason").AsText()
				c.Fail(sendFailed(reason, failed.Get("error")))
			default:
				c.Fail(sendFailed("unreachable", talk.Nothing))
			}
		}()
	})
	return nil
}

// enqueue queues a Remote Send to the Host with this key, after every one
// the Script made before it, as the TS Runner keeps them.
func (r *runnerPeers) enqueue(key string, job func(*link)) {
	r.mu.Lock()
	box := r.outboxes[key]
	if box == nil {
		box = make(chan func(*link), 1024)
		r.outboxes[key] = box
		go func() {
			var l *link
			for job := range box {
				if l == nil || l.isClosed() {
					l = r.linkTo(key)
				}
				job(l)
			}
		}()
	}
	r.mu.Unlock()
	box <- job
}

func (r *runnerPeers) Caller(c *talk.Call) (talk.Value, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.callers[c.Delivery()]; ok && c.Delivery() != "" {
		return v, nil
	}
	return talk.Nothing, nil
}

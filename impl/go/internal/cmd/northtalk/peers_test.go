package main

// Two Runners carry Remote Sends (chapter 12, Runner peers), as
// tooling/cli/tests/run-integration.ts's verifyRunnerPeers checks for TS.

import (
	"bufio"
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const billingPeer = `on start args
  ask peer to expose "billing" and wait
  say "ready"
end start
on charge amount
  say "charge " & amount & " from " & sender()
  if amount > 100 then
    throw {code: "too much"}
  end if
  return amount + 1
end charge
on note line
  say "note " & line & " from " & sender()
end note
function sender
  ask peer to caller
  if it = nothing then
    return "nobody"
  end if
  return the name of it
end sender
`

const shopPeer = `on start args
  ask peer to reach "billing" into billing and wait
  send charge with 12 to billing into total and wait
  say "total " & total
  try
    send charge with 500 to billing and wait
  catch e
    say the code of e & " " & the reason of e
  end try
  send note with "hi" to billing
  send charge with 1 to billing and wait
end start
`

// syncBuffer is a Runner's standard output, read while it runs.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type listening struct {
	address string
	stdout  *syncBuffer
	signals chan os.Signal
	code    chan int
}

// listen runs a listening Runner until stop, and gives its address.
func listen(t *testing.T, o runOptions) *listening {
	t.Helper()
	read, write := io.Pipe()
	l := &listening{stdout: &syncBuffer{}, signals: make(chan os.Signal, 1), code: make(chan int, 1)}
	go func() {
		l.code <- runScript(o, runIO{stdin: strings.NewReader(""), stdout: l.stdout, stderr: write, signals: l.signals, exit: func(int) {}})
		_ = write.Close()
	}()
	found := make(chan string, 1)
	go func() {
		lines := bufio.NewScanner(read)
		for lines.Scan() {
			if m := regexp.MustCompile(`listening on (\S+)`).FindStringSubmatch(lines.Text()); m != nil {
				found <- m[1]
			}
		}
	}()
	select {
	case l.address = <-found:
	case <-time.After(20 * time.Second):
		t.Fatal("the Runner never listened")
	}
	return l
}

func (l *listening) said(want string) string {
	for i := 0; i < 100 && len(l.stdout.String()) < len(want); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	return l.stdout.String()
}

func (l *listening) stop(t *testing.T) {
	t.Helper()
	l.signals <- syscall.SIGINT
	if code := <-l.code; code != 130 {
		t.Errorf("the listener exited %d", code)
	}
}

func said(who string) string {
	return "ready\ncharge 12 from " + who + "\ncharge 500 from " + who + "\nnote hi from " + who + "\ncharge 1 from " + who + "\n"
}

func TestRunnerPeers(t *testing.T) {
	dir := t.TempDir()
	at := func(name string) string { return filepath.Join(dir, name) }
	for name, source := range map[string]string{"billing.talk": billingPeer, "shop.talk": shopPeer} {
		if err := os.WriteFile(at(name), []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	key, err := newPeerKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(at("shop.pem"), key, 0o600); err != nil {
		t.Fatal(err)
	}
	var shopPrint string
	for rest := key; ; {
		var block *pem.Block
		if block, rest = pem.Decode(rest); block == nil {
			break
		} else if block.Type == "CERTIFICATE" {
			cert, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				t.Fatal(err)
			}
			shopPrint = fingerprintOf(cert)
		}
	}
	peer := func(given string) map[string]peerRemote {
		name, remote, err := parsePeerFlag(given)
		if err != nil {
			t.Fatal(err)
		}
		return map[string]peerRemote{name: remote}
	}
	address := func(given string) *peerAddress {
		a, err := parseListen(given)
		if err != nil {
			t.Fatal(err)
		}
		return &a
	}
	shop := func(o runOptions) ran {
		var stdout, stderr bytes.Buffer
		signals := make(chan os.Signal)
		defer close(signals)
		o.file = at("shop.talk")
		code := runScript(o, runIO{stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr, signals: signals, exit: func(int) {}})
		return ran{code, stdout.String(), stderr.String()}
	}

	tls := listen(t, runOptions{file: at("billing.talk"), listen: address("127.0.0.1:0"), remotes: peer("shop=tls://127.0.0.1:1#" + shopPrint)})
	got := shop(runOptions{peerKey: at("shop.pem"), remotes: peer("billing=" + tls.address)})
	if want := (ran{0, "total 13\nsend failed errored\n", "peer: key " + shopPrint + "\n"}); got != want {
		t.Errorf("over TLS: got %+v, wanted %+v", got, want)
	}
	if out := tls.said(said("shop")); out != said("shop") {
		t.Errorf("the TLS listener said %q", out)
	}
	// A listener whose key isn't the pinned one is never reached.
	wrong := regexp.MustCompile(`#.*`).ReplaceAllString(tls.address, "#"+strings.Repeat("0", 64))
	if got := shop(runOptions{remotes: peer("billing=" + wrong)}); got.code != 1 || !strings.Contains(got.stderr, "uncaught error in start: bad address") {
		t.Errorf("with the wrong key: %+v", got)
	}
	tls.stop(t)

	tcp := listen(t, runOptions{file: at("billing.talk"), listen: address("tcp://127.0.0.1:0")})
	if got := shop(runOptions{remotes: peer("billing=" + tcp.address)}); got.code != 0 || got.stdout != "total 13\nsend failed errored\n" {
		t.Errorf("over TCP: %+v", got)
	}
	if out := tcp.said(said("nobody")); out != said("nobody") {
		t.Errorf("the TCP listener said %q", out)
	}
	tcp.stop(t)

	// Plain TCP carries no key, so it stays on loopback.
	if _, _, err := parsePeerFlag("billing=tcp://192.0.2.1:7400"); err == nil || !strings.Contains(err.Error(), "only for loopback") {
		t.Errorf("a non-loopback tcp:// address: %v", err)
	}
}

package bench

import (
	"fmt"
	"os"
	"path/filepath"

	lua "github.com/yuin/gopher-lua"
	"go.starlark.net/starlark"
	"go.starlark.net/syntax"

	native "github.com/odogono/odgn-talk/bench/peers/go"
)

// PeersDir holds each Peer Language's ports, as `<language>/<name>.<ext>`.
var PeersDir = filepath.Join("..", "peers")

// Port is a Benchmark's port loaded into its Peer Language, ready to Run. Its
// Run calls the port's `run`, returning the value whose display form is the
// Script's expected output.
type Port func(n int64) (any, error)

// Peer is a Peer Language runner on the Go Host.
type Peer struct {
	Name string
	// Load starts the interpreter and compiles the Benchmark's port, so that
	// neither is part of a Run.
	Load func(b Benchmark) (Port, error)
}

// Peers are the Peer Language runners on the Go Host.
var Peers = []Peer{
	{"go-native", loadNative},
	{"gopher-lua", loadLua},
	{"starlark-go", loadStarlark},
}

func readPort(language string, b Benchmark, ext string) (string, string, error) {
	path := filepath.Join(PeersDir, language, b.Name+ext)
	data, e := os.ReadFile(path)
	return path, string(data), e
}

func loadNative(b Benchmark) (Port, error) {
	port, ok := native.Ports[b.Name]
	if !ok {
		return nil, fmt.Errorf("%s: no native Go port", b.Name)
	}
	return func(n int64) (any, error) { return port(n), nil }, nil
}

func loadLua(b Benchmark) (Port, error) {
	_, source, e := readPort("lua", b, ".lua")
	if e != nil {
		return nil, e
	}
	l := lua.NewState()
	if e = l.DoString(source); e != nil {
		return nil, e
	}
	run := l.GetGlobal("run")
	return func(n int64) (any, error) {
		if e := l.CallByParam(lua.P{Fn: run, NRet: 1, Protect: true}, lua.LNumber(n)); e != nil {
			return nil, e
		}
		result := l.Get(-1)
		l.Pop(1)
		return result, nil
	}, nil
}

func loadStarlark(b Benchmark) (Port, error) {
	path, source, e := readPort("starlark", b, ".star")
	if e != nil {
		return nil, e
	}
	thread := &starlark.Thread{Name: "bench"}
	// Starlark forbids recursion unless it is enabled.
	options := &syntax.FileOptions{Recursion: true}
	globals, e := starlark.ExecFileOptions(options, thread, path, source, nil)
	if e != nil {
		return nil, e
	}
	run := globals["run"]
	return func(n int64) (any, error) {
		return starlark.Call(thread, run, starlark.Tuple{starlark.MakeInt64(n)}, nil)
	}, nil
}

// LoadPeer loads the Benchmark's port into the peer and confirms one Run at
// the chosen size produces the Script's expected output.
func LoadPeer(p Peer, b Benchmark, smoke bool) (Port, error) {
	port, e := p.Load(b)
	if e != nil {
		return nil, fmt.Errorf("%s on %s: %w", b.Name, p.Name, e)
	}
	size := b.At(smoke)
	result, e := port(size.N)
	if e != nil {
		return nil, fmt.Errorf("%s on %s: %w", b.Name, p.Name, e)
	}
	if got := fmt.Sprint(result); got != size.Expect {
		return nil, fmt.Errorf("%s on %s: output %s, expected %s", b.Name, p.Name, got, size.Expect)
	}
	return port, nil
}

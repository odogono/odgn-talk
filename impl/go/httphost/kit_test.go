package httphost

// Drives the router through the http test kit, corpus/http-kit/: a Script
// served through real sockets on 127.0.0.1, with the answers chapter 7 and
// chapter 9's HTTP router require, as impl/ts/tools/http-kit.ts does.

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/internal/toml"
)

const kitRoot = "../../../corpus/http-kit"

type kitCase struct {
	file, name, script string
	grants             []string
	maxBody            int64
	steps              []toml.Table
}

func kitCases(t *testing.T) []kitCase {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(kitRoot, "*.toml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no http kit files in %s: %v", kitRoot, err)
	}
	var out []kitCase
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		kit, err := toml.ReadTOML(string(b))
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, raw := range kit["case"].([]any) {
			c := raw.(toml.Table)
			k := kitCase{file: filepath.Base(file), name: c["name"].(string), script: c["script"].(string), grants: []string{"http"}}
			if gs, ok := c["grants"].([]any); ok {
				k.grants = nil
				for _, g := range gs {
					k.grants = append(k.grants, g.(string))
				}
			}
			if n, ok := c["maxBodyBytes"].(int64); ok {
				k.maxBody = n
			}
			for _, s := range c["steps"].([]any) {
				k.steps = append(k.steps, s.(toml.Table))
			}
			out = append(out, k)
		}
	}
	return out
}

var costs = talk.Costs{"serve": {Fuel: 10}, "unserve": {Fuel: 5}, "respond": {Fuel: 10}}

func TestHTTPKit(t *testing.T) {
	cases := kitCases(t)
	core := talk.New()
	for _, c := range cases {
		t.Run(c.file+": "+c.name, func(t *testing.T) {
			if err := runCase(core, c); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Logf("%d http kit cases", len(cases))
}

func await(ctx context.Context, p *talk.Pending) (talk.Value, error) {
	select {
	case <-p.Done():
	case <-ctx.Done():
		return talk.Nothing, ctx.Err()
	}
	v, failure := p.Result()
	if failure != nil {
		return talk.Nothing, failure
	}
	return v, nil
}

type answer struct {
	status int
	header http.Header
	body   []byte
}

func send(port int, line string, step toml.Table, abortAfter time.Duration) (answer, error) {
	method, target, _ := strings.Cut(line, " ")
	var body io.Reader = http.NoBody
	if b, ok := step["body"].(string); ok {
		body = strings.NewReader(b)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+strconv.Itoa(port)+target, body)
	if err != nil {
		return answer{}, err
	}
	req.Close = true
	if hs, ok := step["headers"].(toml.Table); ok {
		for k, v := range hs {
			switch v := v.(type) {
			case string:
				req.Header.Add(k, v)
			case []any:
				for _, item := range v {
					req.Header.Add(k, item.(string))
				}
			}
		}
	}
	if abortAfter > 0 {
		time.AfterFunc(abortAfter, cancel)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	res, err := client.Do(req)
	if err != nil {
		if abortAfter > 0 {
			return answer{}, nil
		}
		return answer{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return answer{res.StatusCode, res.Header, b}, err
}

func check(step toml.Table, a answer) error {
	text := string(a.body)
	if want, ok := step["status"].(int64); ok && int64(a.status) != want {
		return fmt.Errorf("status %d, wanted %d (body %q)", a.status, want, text)
	}
	if want, ok := step["response"].(string); ok && text != want {
		return fmt.Errorf("body %q, wanted %q", text, want)
	}
	if want, ok := step["responseHex"].(string); ok && hex.EncodeToString(a.body) != want {
		return fmt.Errorf("body %x, wanted %s", a.body, want)
	}
	if not, ok := step["excludes"].(string); ok && strings.Contains(text, not) {
		return fmt.Errorf("body %q gives away %s", text, not)
	}
	if want, ok := step["type"].(string); ok && a.header.Get("Content-Type") != want {
		return fmt.Errorf("content-type %q, wanted %q", a.header.Get("Content-Type"), want)
	}
	if hs, ok := step["responseHeaders"].(toml.Table); ok {
		for k, v := range hs {
			if got := strings.Join(a.header.Values(k), ", "); got != v.(string) {
				return fmt.Errorf("header %s %q, wanted %q", k, got, v)
			}
		}
	}
	return nil
}

func runCase(core *talk.Core, c kitCase) (failure error) {
	h, err := New(core, Options{MaxBodyBytes: c.maxBody})
	if err != nil {
		return err
	}
	capability, err := core.HTTPCapability(h, costs)
	if err != nil {
		return err
	}
	pool := driver.NewPool(driver.PoolOptions{Workers: 2, OnPump: h.OnPump})
	defer pool.Close()
	defer func() {
		if err := h.Close(); err != nil && failure == nil {
			failure = err
		}
	}()
	member := pool.NewGroup(core, talk.GroupOptions{Name: "kit"})
	grants := map[string]*talk.Grant{}
	for _, g := range c.grants {
		grants[g] = capability.GrantAll(nil)
	}
	var script *talk.Script
	if err := member.Do(func(g *talk.Group) error {
		script, err = g.Load(talk.LoadOptions{Name: "main", Source: c.script, Grants: grants})
		return err
	}); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request := func(name string) (talk.Value, error) {
		_, p, err := script.Request(ctx, talk.Message{Name: name})
		if err != nil {
			return talk.Nothing, err
		}
		return await(ctx, p)
	}
	v, err := request("start")
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}
	port, ok := wholeOf(v)
	if !ok {
		return fmt.Errorf("start gave %s, not a port", v)
	}
	for i, step := range c.steps {
		fail := func(err error) error { return fmt.Errorf("step %d: %w", i, err) }
		switch {
		case step["sleep"] != nil:
			time.Sleep(time.Duration(step["sleep"].(int64)) * time.Millisecond)
		case step["send"] != nil:
			if _, err := request(step["send"].(string)); err != nil {
				return fail(err)
			}
			pool.Wait()
		case step["abort"] != nil:
			if _, err := send(port, step["abort"].(string), step, 100*time.Millisecond); err != nil {
				return fail(err)
			}
		case step["refused"] != nil:
			a, err := send(port, step["refused"].(string), step, 0)
			if err == nil {
				return fail(fmt.Errorf("answered %d, wanted refused", a.status))
			}
			if !errors.Is(err, syscall.ECONNREFUSED) {
				return fail(fmt.Errorf("failed with %v, wanted refused", err))
			}
		case step["request"] != nil:
			a, err := send(port, step["request"].(string), step, 0)
			if err != nil {
				return fail(err)
			}
			if err := check(step, a); err != nil {
				return fail(err)
			}
		}
	}
	return nil
}

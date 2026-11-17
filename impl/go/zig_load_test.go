package northtalk

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"northtalk.org/go/internal/generated"
)

func TestZigBackendLoadStartsGroupInBinaryFrame(t *testing.T) {
	// Warm the Core's guest before observing the per-Group exports.
	core := New()
	for range runtime.GOMAXPROCS(0) {
		warm := core.NewGroup(GroupOptions{})
		if _, err := warm.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
			t.Fatal(err)
		}
	}
	var frames [][]byte
	zigFrameSeen = func(data []byte) { frames = append(frames, bytes.Clone(data)) }
	defer func() { zigFrameSeen = nil }()
	group := core.NewGroup(GroupOptions{Name: "tenant", Seed: 1<<63 + 7})
	if len(frames) != 0 {
		t.Fatalf("untouched Group exported %d frames", len(frames))
	}
	if _, err := group.Load(LoadOptions{Name: "s", Source: "on ping\n return \"a\\b\" & newline & quote\nend ping\n"}); err != nil {
		t.Fatal(err)
	}
	if len(frames) > 2 {
		t.Fatalf("new Group Load exported %d frames, want at most 2", len(frames))
	}
	last := frames[len(frames)-1]
	if !bytes.HasPrefix(last, []byte("NTB\x01")) || last[5] != 0x0b {
		t.Fatalf("Load frame is not binary: %q", last)
	}
}

// BenchmarkZigBackendLoadLiveGroups pins the live population so GC pacing
// cannot hide an O(Groups) lookup. Compare the steady counts after warm-up.
func BenchmarkZigBackendLoadLiveGroups(b *testing.B) {
	for _, live := range []int{0, 20000} {
		b.Run(fmt.Sprintf("live=%d", live), func(b *testing.B) {
			old := runtime.GOMAXPROCS(1)
			defer runtime.GOMAXPROCS(old)
			core := New()
			kept := make([]*Group, 0, live)
			for range live {
				g := core.NewGroup(GroupOptions{})
				if _, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
					b.Fatal(err)
				}
				kept = append(kept, g)
			}
			warm := core.NewGroup(GroupOptions{})
			if _, err := warm.Load(LoadOptions{Name: "warm", Source: "on ping\n return 1\nend ping\n"}); err != nil {
				b.Fatal(err)
			}
			var loading time.Duration
			b.ResetTimer()
			for b.Loop() {
				started := time.Now()
				g := core.NewGroup(GroupOptions{})
				if _, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
					b.Fatal(err)
				}
				loading += time.Since(started)
				// Keep the live population fixed instead of waiting for GC.
				backend := g.backend.(*zigGroup)
				backend.dropping.Stop()
				dropZigGroup(zigDrop{backend.shared, backend.handle})
			}
			b.ReportMetric(float64(loading.Nanoseconds())/float64(b.N), "load-ns/op")
			runtime.KeepAlive(kept)
		})
	}
}

func TestZigBackendLoadFailureLeavesGroupUsable(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Name: "retry", Trace: &trace})
	if _, err := g.Load(LoadOptions{Name: "s", Source: "on broken\n return (\nend broken\n"}); err == nil {
		t.Fatal("invalid source loaded")
	}
	if len(trace) == 0 {
		t.Fatal("refused Load lost its diagnostics")
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return \"a\\b\" & newline & quote\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, pending, err := s.Request(context.Background(), Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(sharedNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	want, _ := Text("a\\b\n\"")
	if v, failure := pending.Result(); failure != nil || !v.Equal(want) {
		t.Fatal(v, failure)
	}
}

// Each Load vector's tree decodes into the generated record, which writes
// the vector's fields frame and, in the JSON layout, the tree itself.
func TestZigBackendLoadFrameVectors(t *testing.T) {
	data, err := os.ReadFile("../testdata/envelope-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Name, Hex, Tree string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, vector := range vectors {
		if !strings.HasPrefix(vector.Name, "load-") {
			continue
		}
		checked++
		t.Run(vector.Name, func(t *testing.T) {
			tree := zigTestTree(t, vector.Tree)
			delete(tree, "m")
			plain, _ := json.Marshal(tree)
			strict := json.NewDecoder(bytes.NewReader(plain))
			strict.DisallowUnknownFields()
			strict.UseNumber()
			var load generated.EnvelopeLoad
			if err := strict.Decode(&load); err != nil {
				t.Fatal(err)
			}
			// These metadata vectors contain only small exact integers.
			for _, field := range []*any{&load.Grants, &load.Owner, &load.Objects, &load.Limits, &load.NewGroup} {
				*field = zigTestInts(t, *field)
			}
			data, err := zbLoad(&load)
			if err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(data); got != vector.Hex {
				t.Fatalf("Load frame %s, want %s", got, vector.Hex)
			}
			text, err := zigLoadJSON(&load)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := zigTestTree(t, string(text)), zigTestTree(t, vector.Tree); !reflect.DeepEqual(got, want) {
				t.Fatalf("Load JSON %s, want %s", text, vector.Tree)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no Load vectors")
	}
}

func zigTestTree(t *testing.T, text string) map[string]any {
	t.Helper()
	d := json.NewDecoder(strings.NewReader(text))
	d.UseNumber()
	var tree map[string]any
	if err := d.Decode(&tree); err != nil {
		t.Fatal(err)
	}
	return tree
}

// zigTestInts turns a decoded tree's numbers into the int64 a Host writes.
func zigTestInts(t *testing.T, v any) any {
	t.Helper()
	switch v := v.(type) {
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			t.Fatal(err)
		}
		return n
	case map[string]any:
		for k, item := range v {
			v[k] = zigTestInts(t, item)
		}
	case []any:
		for i, item := range v {
			v[i] = zigTestInts(t, item)
		}
	}
	return v
}

func TestZigBackendLoadWithoutBinaryFeature(t *testing.T) {
	core := New()
	// The guest understands Load fields, but this Host keeps JSON on this
	// Session. A first nonbinary worker still creates the Group before use.
	g := core.NewGroup(GroupOptions{Name: "json"})
	g.backend.(*zigGroup).reg.load = false
	if _, err := g.Load(LoadOptions{Name: "s", Source: "on ping\n return 1\nend ping\n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "t", Source: "on ping\n return 2\nend ping\n"}); err != nil {
		t.Fatal(err)
	}
}

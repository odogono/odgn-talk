package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeRun(t *testing.T, dir string, native, zig []float64) {
	t.Helper()
	for _, file := range []string{"base", "native", "zig-json", "zig-map", "zig-fields"} {
		values := zig
		if file == "base" || file == "native" {
			values = native
		}
		var text strings.Builder
		for _, ns := range values {
			fmt.Fprintln(&text, "goos: darwin\ngoarch: arm64\npkg: example\ncpu: Example")
			names := benchmarks
			if file == "base" || file == "zig-json" {
				names = benchmarks[:1]
			}
			for _, name := range names {
				fmt.Fprintf(&text, "%s-3\t20000\t%g ns/op\t42 p50-ns\t90 B/op\t1 allocs/op\n", name, ns)
			}
			fmt.Fprintln(&text, "PASS")
		}
		if err := os.WriteFile(filepath.Join(dir, file+".txt"), []byte(text.String()), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPairedRatiosCancelDrift(t *testing.T) {
	dir := t.TempDir()
	// The ratio of medians is 100/10 = 10, but the paired median is 2.
	writeRun(t, dir, []float64{1, 100, 10}, []float64{2, 200, 100})
	var output bytes.Buffer
	if err := report(&output, dir, 3); err != nil {
		t.Fatal(err)
	}
	rows := 0
	for _, line := range strings.Split(output.String(), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 8 && fields[0] == "zig-fields" && fields[2] == "native" {
			rows++
			if got := strings.Join(fields[4:], " "); got != "3 2.000x 2.000x 10.000x" {
				t.Fatalf("paired summary: %s", line)
			}
		}
	}
	if rows != 3 {
		t.Fatal(output.String())
	}
}

func TestMedianEvenAndOdd(t *testing.T) {
	for _, tc := range []struct {
		values []float64
		want   float64
	}{
		{[]float64{8, 2, 6, 4}, 5},
		{[]float64{8, 2, 4}, 4},
		{[]float64{2}, 2},
	} {
		if got := median(tc.values); got != tc.want {
			t.Fatalf("median(%v) = %g, want %g", tc.values, got, tc.want)
		}
	}
}

func TestRejectInvalidSamples(t *testing.T) {
	for _, line := range []string{
		"BenchmarkBackendRequest-3 2000 NaN ns/op",
		"BenchmarkBackendRequest-3 2000 +Inf ns/op",
		"BenchmarkBackendRequest-3 2000 0 ns/op",
		"BenchmarkBackendRequest-3 0 100 ns/op",
		"BenchmarkBackendRequest-3 2000 100 us/op",
		"BenchmarkBackendRequest-3 2000",
	} {
		t.Run(line, func(t *testing.T) {
			if _, err := readSamples(strings.NewReader(line)); err == nil {
				t.Fatal("accepted invalid sample")
			}
		})
	}
}

func TestSingleCPUAndDecimalTimings(t *testing.T) {
	// Go omits the CPU suffix at GOMAXPROCS=1. Additional metrics must not
	// replace ns/op, and calibration-sized iteration counts are not timings.
	data, err := readSamples(strings.NewReader("BenchmarkBackendRequest 20000 12.5 ns/op 8 p50-ns 90 B/op\n"))
	if err != nil {
		t.Fatal(err)
	}
	got := data["BenchmarkBackendRequest"]
	if len(got) != 1 || got[0].iterations != 20000 || got[0].ns != 12.5 {
		t.Fatalf("parsed %v", data)
	}
}

func TestRejectIncompleteOrMismatchedRounds(t *testing.T) {
	for _, tc := range []struct {
		name, before, after, want string
	}{
		{"missing sample", "BenchmarkBackendRequest-3\t20000\t2 ns/op\t42 p50-ns\t90 B/op\t1 allocs/op\n", "", "got 1 samples, want 2"},
		{"different work", "20000", "2000", "got 2000 iterations, want 20000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeRun(t, dir, []float64{1, 1}, []float64{2, 2})
			path := filepath.Join(dir, "zig-fields.txt")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(strings.Replace(string(data), tc.before, tc.after, 1)), 0600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			if err := report(&output, dir, 2); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %s", err, tc.want)
			}
			if output.Len() != 0 {
				t.Fatal("wrote a partial report")
			}
		})
	}
}

func TestArchivedMacOSRounds(t *testing.T) {
	for _, tc := range []struct{ run, want string }{
		{"1267-final-a", "2.684x"},
		{"1267-final-b", "2.707x"},
	} {
		t.Run(tc.run, func(t *testing.T) {
			dir := filepath.Join("../../../../bench/results/go-zig-adapter", tc.run, "macos-15")
			var output bytes.Buffer
			if err := report(&output, dir, 10); err != nil {
				t.Fatal(err)
			}
			for _, line := range strings.Split(output.String(), "\n") {
				fields := strings.Fields(line)
				if len(fields) == 8 && strings.Join(fields[:4], " ") == "zig-fields Request native Request" {
					if fields[5] != tc.want {
						t.Fatalf("%s: %s", tc.run, line)
					}
					return
				}
			}
			t.Fatal("missing fields/native Request ratio")
		})
	}
}

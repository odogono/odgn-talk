// request-pump-report pairs the chronological rounds written by
// zig-request-pump-bench.sh. It also accepts archived runs of that script.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
)

var benchmarkName = regexp.MustCompile(`^(BenchmarkBackend(Request|RequestPump|CallPump))(-\d+)?$`)

var benchmarks = []string{"BenchmarkBackendRequest", "BenchmarkBackendRequestPump", "BenchmarkBackendCallPump"}

type sample struct {
	iterations int
	ns         float64
}

func readSamples(r io.Reader) (map[string][]sample, error) {
	result := make(map[string][]sample)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "Benchmark") {
			continue
		}
		name := benchmarkName.FindStringSubmatch(fields[0])
		if name == nil || len(fields) < 4 || fields[3] != "ns/op" {
			return nil, fmt.Errorf("invalid benchmark sample: %s", scanner.Text())
		}
		iterations, err := strconv.Atoi(fields[1])
		if err != nil || iterations <= 0 {
			return nil, fmt.Errorf("invalid iteration count: %s", scanner.Text())
		}
		ns, err := strconv.ParseFloat(fields[2], 64)
		if err != nil || ns <= 0 || math.IsNaN(ns) || math.IsInf(ns, 0) {
			return nil, fmt.Errorf("invalid timing: %s", scanner.Text())
		}
		result[name[1]] = append(result[name[1]], sample{iterations: iterations, ns: ns})
	}
	return result, scanner.Err()
}

func median(values []float64) float64 {
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[mid-1] + sorted[mid]) / 2
	}
	return sorted[mid]
}

func report(w io.Writer, dir string, rounds int) error {
	files := []string{"base", "native", "zig-json", "zig-map", "zig-fields"}
	samples := make(map[string]map[string][]sample)
	for _, file := range files {
		f, err := os.Open(filepath.Join(dir, file+".txt"))
		if err != nil {
			return err
		}
		data, err := readSamples(f)
		f.Close()
		if err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		samples[file] = data
	}
	if rounds == 0 {
		rounds = len(samples["native"][benchmarks[0]])
	}
	if rounds < 1 {
		return fmt.Errorf("need at least one complete round")
	}
	// All files must contain every round; never zip or truncate unequal lists.
	// Fixed iteration counts preserve the same amount of work across backends.
	iterations := -1
	for _, file := range files {
		names := benchmarks
		if file == "base" || file == "zig-json" {
			names = benchmarks[:1]
		}
		for _, name := range names {
			values := samples[file][name]
			if len(values) != rounds {
				return fmt.Errorf("%s %s: got %d samples, want %d", file, name, len(values), rounds)
			}
			if iterations < 0 {
				iterations = values[0].iterations
			}
			for _, value := range values {
				if value.iterations != iterations {
					return fmt.Errorf("%s %s: got %d iterations, want %d", file, name, value.iterations, iterations)
				}
			}
		}
	}

	fmt.Fprintln(w, "Paired ns/op ratios (numerator / denominator, chronological round in each file).")
	fmt.Fprintln(w, "Median of round ratios; min/max show spread, not a confidence interval.")
	table := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "Numerator\tBenchmark\tDenominator\tBenchmark\tRounds\tMedian\tMin\tMax")
	row := func(numerator, name, denominator, reference string) {
		ratios := make([]float64, rounds)
		for i := range ratios {
			ratios[i] = samples[numerator][name][i].ns / samples[denominator][reference][i].ns
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%d\t%.3fx\t%.3fx\t%.3fx\n",
			numerator, strings.TrimPrefix(name, "BenchmarkBackend"), denominator, strings.TrimPrefix(reference, "BenchmarkBackend"),
			rounds, median(ratios), slices.Min(ratios), slices.Max(ratios))
	}
	row("native", benchmarks[0], "base", benchmarks[0])
	row("zig-json", benchmarks[0], "native", benchmarks[0])
	for _, file := range []string{"zig-map", "zig-fields"} {
		for _, name := range benchmarks {
			row(file, name, "native", name)
		}
		// The combined Request performs the same work as JSON's separate calls.
		for _, name := range benchmarks[:2] {
			row(file, name, "zig-json", benchmarks[0])
		}
	}
	return table.Flush()
}

func main() {
	rounds := flag.Int("rounds", 0, "expected rounds (default: infer from native Request)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: request-pump-report [-rounds N] RESULTS_DIRECTORY")
		os.Exit(2)
	}
	if err := report(os.Stdout, flag.Arg(0), *rounds); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

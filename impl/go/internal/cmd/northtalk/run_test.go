package main

// The Script Runner, `northtalk app.talk` (ADR 0126), checked as
// tooling/cli/tests/run-integration.ts checks the TS one.

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

var scripts = map[string]string{
	"hello.talk": "on start args\n  say \"hello \" & args\nend start\n",
	"boom.talk":  "on start args\n  say \"before\"\n  throw {code: \"boom\", n: 1}\nend start\n",
	"later.talk": strings.Join([]string{
		"on start args",
		"  ask clock to now",
		"  tell timer to schedule \"t\", it + 200 ms, \"tick\", [5]",
		"  say \"set\"",
		"end start",
		"on tick n",
		"  say \"tick \" & n",
		"end tick",
		"",
	}, "\n"),
	"broken.talk": "on start args\n  say 1 +\nend start\n",
	"echo.talk":   "on start args\n  ask console to read and wait\n  say \"got \" & it\nend start\n",
}

type ran struct {
	code           int
	stdout, stderr string
}

func runIn(t *testing.T, input string, file string, args ...string) ran {
	t.Helper()
	var stdout, stderr bytes.Buffer
	signals := make(chan os.Signal)
	defer close(signals)
	code := runScript(runOptions{file: file, args: args}, runIO{
		stdin: strings.NewReader(input), stdout: &stdout, stderr: &stderr,
		signals: signals, exit: func(int) { t.Error("exited on a signal") },
	})
	return ran{code, stdout.String(), stderr.String()}
}

func TestScriptRunner(t *testing.T) {
	dir := t.TempDir()
	for name, source := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	at := func(name string) string { return filepath.Join(dir, name) }
	check := func(got, want ran) {
		t.Helper()
		if got != want {
			t.Errorf("got %+v, wanted %+v", got, want)
		}
	}
	check(runIn(t, "", at("hello.talk"), "a", "--b"), ran{0, "hello [\"a\", \"--b\"]\n", ""})
	check(runIn(t, "", at("boom.talk")), ran{1, "before\n", at("boom.talk") + ":3:3: uncaught error in start: boom {n: 1}\n"})
	started := time.Now()
	check(runIn(t, "", at("later.talk")), ran{0, "set\ntick 5\n", ""})
	if time.Since(started) < 200*time.Millisecond {
		t.Error("exited before the timer fired")
	}
	broken := runIn(t, "", at("broken.talk"))
	if broken.code != 1 || !strings.Contains(broken.stderr, "broken.talk:3:1: unexpected token") {
		t.Errorf("broken: %+v", broken)
	}
	check(runIn(t, "line one\n", at("echo.talk")), ran{0, "got line one\n", ""})
	// At the end of input, the Run waiting to read is cancelled.
	check(runIn(t, "", at("echo.talk")), ran{0, "", ""})
}

// calendar, locale and sqlite give what the TS Runner gives for the same
// Script.
func TestRunnerStandardCapabilities(t *testing.T) {
	cases := []struct {
		name  string
		lines []string // each followed by `say it`, unless it says something itself
		want  string
	}{
		{"calendar", []string{
			`ask calendar to zone`,
			`ask calendar to toCivil "2021-03-28T01:30:00Z" as instant, "Europe/London"`,
			// In the spring gap, `compatible` moves forward past it.
			`ask calendar to toInstant "2021-03-28T01:30:00" as civil date, "Europe/London"`,
			// In the autumn overlap, `later` takes the second reading.
			`ask calendar to toInstant "2021-10-31T01:30:00" as civil date, "later", "Europe/London"`,
			`ask calendar to offset "2021-07-01T00:00:00Z" as instant, "America/New_York"`,
			"try\n    ask calendar to zone \"Nowhere/Else\"\n  catch e\n    say the code of e\n  end try",
		}, "UTC\n2021-03-28T02:30:00\n2021-03-28T01:30:00Z\n2021-10-31T01:30:00Z\n-14400 s\nunknown zone\n"},
		{"locale", []string{
			`ask locale to tag`,
			`ask locale to tag "de-CH"`,
			`ask locale to rank ["b", "a", "B", "ä"], {sensitivity: "base"}, "de"`,
			`ask locale to compare "file 10", "file 9", {numeric: true}`,
			`ask locale to upper "istanbul", "tr"`,
			`ask locale to monthNames {width: "short"}, "fr"`,
			`ask locale to dayNames`,
			`ask locale to numberSymbols "de"`,
		}, strings.Join([]string{
			"und",
			"de",
			`{a: 1, "ä": 1, b: 2, B: 2}`,
			"1",
			"İSTANBUL",
			`["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]`,
			`["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]`,
			`{decimal: ",", group: ".", minus: "-", digits: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], primaryGroup: 3, secondaryGroup: 3, minGrouping: 1}`,
			"",
		}, "\n")},
		{"sqlite", []string{
			`ask sqlite to change "create table t (n integer)", []`,
			`ask sqlite to change "insert into t values (?), (?)", [7, 8]`,
			`ask sqlite to query "select n from t order by n", []`,
		}, "{changes: 0, rows: []}\n{changes: 2, rows: []}\n[{n: 7}, {n: 8}]\n"},
	}
	dir := t.TempDir()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var source strings.Builder
			source.WriteString("on start args\n")
			for _, line := range c.lines {
				source.WriteString("  " + line + "\n")
				if !strings.Contains(line, "say ") {
					source.WriteString("  say it\n")
				}
			}
			source.WriteString("end start\n")
			file := filepath.Join(dir, c.name+".talk")
			if err := os.WriteFile(file, []byte(source.String()), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := runIn(t, "", file); got != (ran{0, c.want, ""}) {
				t.Errorf("got %+v, wanted stdout %q", got, c.want)
			}
		})
	}
}

func TestIsScriptFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "app")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for arg, want := range map[string]bool{"x.talk": true, file: true, "-x.talk": false, "missing": false, t.TempDir(): false} {
		if isScriptFile(arg) != want {
			t.Errorf("isScriptFile(%q) != %v", arg, want)
		}
	}
}

// The HTTP example serves until SIGINT, then exits 130.
func TestHTTPExample(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no SIGINT to send")
	}
	binary := filepath.Join(t.TempDir(), "northtalk")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	cmd := exec.Command(binary, "-port", "0", "../../../../../examples/http/hello.talk")
	cmd.Env = append(os.Environ(), "PORT=3000")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	lines := bufio.NewReader(stdout)
	first, err := lines.ReadString('\n')
	if err != nil {
		t.Fatalf("before listening: %v: %s", err, stderr.String())
	}
	found := regexp.MustCompile(`^listening on (\d+)\n$`).FindStringSubmatch(first)
	if found == nil || found[1] == "3000" {
		t.Fatalf("first line %q", first)
	}
	port, _ := strconv.Atoi(found[1])
	get := func(method, path, body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(port)+path, strings.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	for _, c := range []struct {
		method, path, body string
		status             int
		want               string
	}{
		{"GET", "/", "", 200, "hello"},
		{"GET", "/users/7", "", 200, `{"id":"7"}`},
		{"POST", "/echo", "hi there", 201, "hi there"},
		{"GET", "/missing", "", 404, ""},
		{"GET", "/never", "", 500, ""},
	} {
		status, body := get(c.method, c.path, c.body)
		if status != c.status || (c.want != "" && body != c.want) {
			t.Errorf("%s %s: %d %q, wanted %d %q", c.method, c.path, status, body, c.status, c.want)
		}
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	rest, _ := io.ReadAll(lines)
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 130 {
			t.Errorf("exited with %v, wanted 130; stderr %s", err, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still running after SIGINT")
	}
	if len(rest) > 0 {
		t.Errorf("more output: %q", rest)
	}
}

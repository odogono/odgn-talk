package fuzz

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"

	talk "github.com/odogono/odgn-talk/impl/go"
)

const maxLine = 8 * 1024 * 1024

var malformedCase = regexp.MustCompile(`No lifecycle Stub|Missing inline source|case.toml has no|Expected a concrete`)

// Serve answers worker.ts's protocol: one JSON request and one JSON response
// per line. It performs no filesystem or network I/O of its own.
func Serve(in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), maxLine+1)
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	for scanner.Scan() {
		if err := encoder.Encode(respond(scanner.Bytes())); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func respond(line []byte) any {
	var request struct {
		Type string          `json:"type"`
		Case json.RawMessage `json:"case"`
	}
	if err := json.Unmarshal(line, &request); err != nil {
		return map[string]string{"error": err.Error()}
	}
	switch request.Type {
	case "capabilities":
		versions := talk.CoreVersions()
		return map[string]any{"version": 1, "features": Features, "languageVersion": versions.Language, "costModel": versions.CostModel}
	case "run":
		c, err := ReadCase(request.Case)
		if err != nil {
			return map[string]string{"error": err.Error()}
		}
		return Run(c)
	}
	return map[string]string{"error": "Unknown worker request"}
}

// Run executes a case. The TS runner checks the oracles; this result carries
// the complete Trace that evaluate compares, or the failure that stopped it.
func Run(c Case) (result Result) {
	defer func() {
		if p := recover(); p != nil {
			result = Result{Findings: []Finding{failure(fmt.Errorf("panic: %v", p), "panic")}}
		}
	}()
	execution, err := Execute(c)
	if err != nil {
		return Result{Findings: []Finding{failure(err, "Error")}}
	}
	return Result{Execution: execution, Findings: []Finding{}}
}

func failure(err error, kind string) Finding {
	if malformedCase.MatchString(err.Error()) {
		return Finding{Classification: "generator", Message: err.Error(), Signature: Signature{Oracle: "harness-validity", Record: "exception", Field: kind, Owner: "group"}}
	}
	return Finding{Classification: "execution", Message: err.Error(), Signature: Signature{Oracle: "worker-exception", Record: "exception", Field: kind, Owner: "group"}}
}

package corpus

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestExecutionBackends(t *testing.T) {
	cases, e := Discover("../../../../corpus", nil)
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	r := Runner{Root: "../../../../corpus", Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		if c.Kind == "trace" && (len(c.Name) >= 11 && c.Name[:11] == "text-model/" || len(c.Name) >= 17 && c.Name[:17] == "load-diagnostics/") {
			count++
			t.Run(c.Name, func(t *testing.T) {
				if _, e := r.execute(c); e != nil {
					t.Fatal(e)
				}
			})
		}
	}
	if count != 49 {
		t.Fatalf("expected 49 Trace cases, got %d", count)
	}
}

// The step-1 set is an acceptance gate independent of opportunistic side cases.
// Removing an implemented backend or a required passing-list entry must fail.
func TestPassingListContainsFullStepOneSet(t *testing.T) {
	cases, e := Discover("../../../../corpus", nil)
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile("../../corpus-passing.txt")
	if e != nil {
		t.Fatal(e)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	count := 0
	for _, c := range cases {
		required := strings.HasPrefix(c.Name, "text-model/") || strings.HasPrefix(c.Name, "load-diagnostics/") || strings.HasPrefix(c.Name, "disassembly/") || c.Name == "bytes/value-encoding" || c.Name == "dates/value-encoding" || c.Name == "quantities/value-encoding"
		if !required {
			continue
		}
		count++
		if !listed[c.Name] {
			t.Errorf("required step-1 case not listed: %s", c.Name)
		}
	}
	if count != 60 {
		t.Fatalf("required set: %d cases, want 60", count)
	}
}

// Step 2 completes against reviewed TS-produced cases, with execution through
// the public Group API and comparison of every Trace record. The limits cases
// are tracked by #135; pattern-size-literal-limit also requires #136 Reload.
func TestTextPatternStepTwoAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{
		"text-patterns/canonical-source-leading-group",
		"text-patterns/empty-match-skipped-after-match",
		"text-patterns/empty-matches-step-one-character",
		"text-patterns/greedy-by-default",
		"text-patterns/lazily-prefers-fewer",
		"text-patterns/lazily-stays-on-its-element",
		"text-patterns/or-is-leftmost-first",
		"text-patterns/replace-all-empty-matches",
	}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !listed[c.Name] {
				t.Errorf("required step-2 case not listed: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Error delivery replays through the public Group API. Reviewed Core-error
// cases pin retained maps; new regressions pin dispatch and error backstops.
func TestErrorDeliveryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)

	names := []string{
		"bytes/build-errors", "dates/instants-and-offsets",
		"errors/handler-backstop", "errors/handler-delivery",
		"math/domain-errors", "math/fractional-power-errors", "quantities/incompatible-units",
	}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("error-delivery case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDurationWaitAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"limits/wait-zero-next-pump", "limits/wait-deadline", "limits/rollback-after-suspension", "suspension/nested-waits", "suspension/wait-work-order", "suspension/wait-precision"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("wait case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestQueueingPolicyAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"cancellation/queueing-policies", "cancellation/policy-clause-selection", "cancellation/policy-dispatch-limits"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("policy case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDecisionAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"decisions/fault-before-seal", "decisions/undecided-on-an-error", "decisions/verdict-behind-a-fuel-slice", "decisions/script-verdict-boundaries"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("Decision case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestEventObservationAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"decisions/dispatch-and-waits", "limits/event-tests-fault-on-resume", "suspension/event-test-group-cap", "suspension/event-test-slice-debt", "suspension/wait-observation"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("observation case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestScriptSendAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"suspension/wait-for", "suspension/script-sends", "suspension/send-preemption", "limits/self-send-persistent"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	passing, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains("\n"+string(passing), "\n"+c.Name+"\n") {
				t.Fatal("missing send acceptance case from passing gate")
			}
		})
	}
}

func TestScriptReplyAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"suspension/send-and-wait", "suspension/send-reply-preemption", "limits/send-wait-retention", "suspension/send-wait-replacement"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	passing, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains("\n"+string(passing), "\n"+c.Name+"\n") {
				t.Fatal("missing reply acceptance case from passing gate")
			}
		})
	}
}

// Script-only Joins retain their own acceptance alongside mixed Joins.
func TestScriptJoinAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"suspension/script-joins", "suspension/join-closing-position", "suspension/join-preemption", "limits/join-retention", "limits/script-join-width"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Errorf("required Script Join case not listed: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Ordinary Operations execute through the public embedding API. These
// existing reviewed cases and new paired regressions protect this slice.
func TestOrdinaryOperationAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/calls", "capabilities/charge-faults", "capabilities/load-checks", "capabilities/argument-shapes", "capabilities/host-failures", "capabilities/optional-args-fuel", "capabilities/declared-allocation", "capabilities/ordinary-grants", "limits/mailbox-depth"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(b), "\n"+c.Name+"\n") {
				t.Errorf("required ordinary Operation case not listed: %s", c.Name)
			}
			if reason := r.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSuspendingOperationAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"suspension/answers", "suspension/joins", "suspension/capability-resumption", "capabilities/optional-args-join", "capabilities/revoke-in-flight", "limits/max-wait-minimum", "limits/max-join-minimum", "reload/reload-carry-and-discard"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if reason := runner.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Errorf("required suspending Operation case missing from gate: %s", c.Name)
			}
		})
	}
}

// Library and normative Standard Library calls protect the shared code context.
func TestLibraryExecutionAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"builtins/function-values", "libraries/calls", "libraries/errors", "libraries/registration", "stdlib/calls", "stdlib/errors-name-the-call", "stdlib/template-migration"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Fatal("missing Library acceptance case from gate")
			}
			if reason := runner.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Capability calls through Libraries use the same caller budgets and Grants.
func TestLibraryCapabilityAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"libraries/needs-transitive", "libraries/needs-suspending", "capabilities/optional-args", "libraries/caller-capabilities"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Fatal("missing Library Capability acceptance case from gate")
			}
			if reason := runner.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClockTimerFactoryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/standard-clock", "capabilities/standard-clock-fuel", "capabilities/standard-timer"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Error("Clock/Timer acceptance case missing from gate")
			}
			if reason := runner.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConsoleFactoryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/standard-console", "capabilities/standard-console-timeout", "capabilities/standard-console-cancel", "reload/function-staleness"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Error("Console acceptance case missing from gate")
			}
			if reason := runner.support(c); reason != "" {
				t.Fatal(reason)
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

package corpus

import (
	"io"
	"os"
	"path/filepath"
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
	if count != 52 {
		t.Fatalf("expected 52 Trace cases, got %d", count)
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
	if count != 66 {
		t.Fatalf("required set: %d cases, want 66", count)
	}
}

// Step 2 completes against reviewed TS-produced cases, with execution through
// the public Group API and comparison of every Trace record. The limits cases
// are covered separately by the step-4 acceptance gate below.
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

// Step 4 pins the exhaustion instruction, resource charges and rollback state
// through public embedding execution. Segment-bound effects have their own gate.
func TestLimitsStepFourAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	count := 0
	for _, c := range cases {
		required := strings.HasPrefix(c.Name, "limits/") || strings.HasPrefix(c.Name, "cancellation/") || c.Name == "text-patterns/matching-fuel-exhaustion" || c.Name == "text-patterns/pattern-size-literal-limit" || c.Name == "text-patterns/pattern-size-made-at-run-time"
		if !required {
			continue
		}
		count++
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("required step-4 case missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
	if count != 40 {
		t.Fatalf("required step-4 limits set: %d cases, want 40", count)
	}
}

func TestSegmentEffectStepFourAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	count := 0
	for _, c := range cases {
		if !strings.HasPrefix(c.Name, "capabilities/effect-") {
			continue
		}

		count++
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("required step-4 effect missing from passing gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
	if count != 30 {
		t.Fatalf("required effect set: %d cases, want 30", count)
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
	cases, err := Discover(root, []string{"decisions/fault-before-seal", "decisions/undecided-on-an-error", "decisions/verdict-behind-a-fuel-slice", "decisions/script-verdict-boundaries", "decisions/undecided-on-cancel-delivery"})
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

// Counters must agree across full ordinary and save/restore Traces, including
// queued Request cancellation, which starts no Run and spends no Fuel.
func TestCountersAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"counters/faults-and-cleanup", "counters/lifetime", "counters/variables-only"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 3 {
		t.Fatalf("expected 3 Counters cases, got %d", len(cases))
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
				t.Errorf("Counters case missing from passing gate: %s", c.Name)
			}
			if reason := (executionBackend{}).Support(c); reason != "" {
				t.Fatalf("Counters case deferred: %s", reason)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// An abort after sealing is a Host action, but it queues no Trace input.
// Inject it separately because a canonical case.trace cannot retain that action.
func TestDecisionReplayIgnoresCancellationAfterSeal(t *testing.T) {
	cases, err := Discover("../../../../corpus", []string{"decisions/undecided-on-cancel-delivery"})
	if err != nil {
		t.Fatal(err)
	}
	c := cases[0]
	b, err := os.ReadFile(filepath.Join(c.Dir, "case.trace"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(b)
	records, err := ParseTrace(source)
	if err != nil {
		t.Fatal(err)
	}
	var expected []string
	for _, r := range records {
		expected = append(expected, r.Raw)
	}
	inputs, err := ParseTrace(strings.Replace(source, "> answer board/r2.c1", "> cancel-delivery d3\n> answer board/r2.c1", 1))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := (executionBackend{}).Run(c, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if err := Compare(c.Name, expected, actual); err != nil {
		t.Fatal(err)
	}
}

// #277 requires all corrected event-test Traces and the observation regression.
// ExecutionBackends compares ordinary and save/restore replay before the Runner
// compares every record with the authoritative Trace.
func TestEventObservationAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{
		"decisions/dispatch-and-waits",
		"decisions/broadcast-outcomes",
		"limits/event-tests-fault-on-resume",
		"objects/wait-target",
		"reload/extend-units",
		"suspension/event-test-group-cap",
		"suspension/event-test-slice-debt",
		"suspension/wait-for",
		"suspension/wait-observation",
	}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 9 {
		t.Fatalf("event-test acceptance: %d cases, want 9", len(cases))
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

func TestSuspensionRetentionAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{
		"limits/ask-wait-retention", "limits/foreign-call-retention",
		"limits/event-capture-wait-retention", "limits/event-capture-block-retention",
		"limits/event-object-wait-retention", "limits/event-object-block-retention",
		"limits/join-pending-retention", "limits/join-early-answer-retention",
	}
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
				t.Errorf("required suspension retention case missing from gate: %s", c.Name)
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

func TestCalendarFactoryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/standard-calendar", "capabilities/standard-calendar-errors", "capabilities/standard-calendar-validation"}
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
				t.Error("Calendar acceptance case missing from gate")
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

func TestLocaleFactoryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/standard-locale", "capabilities/standard-locale-ranks", "capabilities/standard-locale-validation"}
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
				t.Error("Locale acceptance case missing from gate")
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

func TestObjectIdentityAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"builtins/object-kind", "builtins/kind-of"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if !strings.Contains("\n"+string(listed), "\n"+name+"\n") {
			t.Error("Object identity acceptance case missing from gate:", name)
		}
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		if reason := runner.support(c); reason != "" {
			t.Fatal(reason)
		}
		if _, err := runner.execute(c); err != nil {
			t.Fatal(err)
		}
	}
}

func TestObjectPropertyAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"objects/properties", "objects/guard-keys", "load-diagnostics/object-properties"}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(listed), "\n"+c.Name+"\n") {
				t.Fatal("Object property acceptance case missing from gate")
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

func TestMessagePathAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"objects/message-path", "objects/moving-mailbox", "objects/moving-climb", "objects/sends", "objects/wait-target", "decisions/pass-up-the-message-path", "cancellation/owner-disposal-and-stop", "decisions/veto-ends-the-decision"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != len(names) {
		t.Fatal(len(cases))
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		listed[line] = true
	}
	for _, name := range names {
		if !listed[name] {
			t.Error("Message Path case missing from passing gate:", name)
		}
	}

	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStopAcceptance(t *testing.T) {
	cases, err := Discover("../../../../corpus", []string{"functions/host-calls", "cancellation/broadcast-recipients", "cancellation/host-crossings", "cancellation/owner-disposal-and-stop"})
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: "../../../../corpus", Output: io.Discard, Backends: ExecutionBackends()}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(b), "\n"+c.Name+"\n") {
				t.Fatal("Stop acceptance missing from gate")
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestScopeAcceptance(t *testing.T) {
	cases, err := Discover("../../../../corpus", []string{"capabilities/scope-cancel-run", "capabilities/scope-close-conversion", "capabilities/scope-conversion-fault", "capabilities/scope-dispose", "capabilities/scope-failed-close", "capabilities/scope-limit-fault", "capabilities/scope-malformed-acquisition", "capabilities/scope-ordinary-error", "capabilities/scope-reverse-abandonment", "capabilities/scope-revoked-cleanup", "capabilities/scope-slots", "capabilities/scope-stop", "capabilities/scope-suspension-boundaries"})
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: "../../../../corpus", Output: io.Discard, Backends: ExecutionBackends()}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(b), "\n"+c.Name+"\n") {
				t.Fatal("Scope acceptance missing from gate")
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBroadcastDecisionAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"decisions/broadcast-outcomes", "decisions/broadcast-decision-reports-every-veto"})
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(b), "\n"+c.Name+"\n") {
				t.Fatal("Broadcast acceptance missing from gate")
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestForeignFunctionAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"functions/foreign-calls", "functions/host-cancellation"}
	cases, err := Discover(root, names)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	if len(cases) != len(names) {
		t.Fatal(len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains("\n"+string(b), "\n"+c.Name+"\n") {
				t.Fatal("Function acceptance missing from gate")
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCapabilityCallbackAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"functions/capability-callbacks"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 1 {
		t.Fatal("missing callback case")
	}
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	n, err := r.execute(cases[0])
	if err != nil {
		t.Fatal(err)
	}
	if n != 25 {
		t.Fatalf("got %d records, want 25", n)
	}
	listed, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains("\n"+string(listed), "\nfunctions/capability-callbacks\n") {
		t.Fatal("Capability callback case missing from passing gate")
	}
}

// Step 5 replays each supported Trace both ordinarily and across quiescent
// snapshots. Keep the complete save/restore family and replacement boundaries
// in the acceptance gate independently of newly discovered passing cases.
func TestSaveRestoreStepFiveAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"reload/extend-units", "reload/extension-state-cap", "reload/replacement-transitive", "capabilities/effect-close-preemption-fault", "capabilities/effect-reload-fatal", "capabilities/effect-replace-fatal", "capabilities/effect-replace-library"}
	cases, err := Discover(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	listed := "\n" + string(b)
	r := Runner{Root: root, Output: io.Discard, Backends: ExecutionBackends()}
	count := 0
	for _, c := range cases {
		required := strings.HasPrefix(c.Name, "save-restore/")
		for _, name := range names {
			required = required || c.Name == name
		}
		if !required {
			continue
		}
		count++
		t.Run(c.Name, func(t *testing.T) {
			if !strings.Contains(listed, "\n"+c.Name+"\n") {
				t.Errorf("required step-5 case missing from gate: %s", c.Name)
			}
			if _, err := r.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
	if count != 19 {
		t.Fatalf("required step-5 set: %d cases, want 19", count)
	}
}

func TestArgumentLabelsAcceptance(t *testing.T) {
	names := []string{"suspension/argument-labels", "objects/argument-labels", "load-diagnostics/argument-labels"}
	cases, err := Discover("../../../../corpus", names)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../corpus-passing.txt")
	if err != nil {
		t.Fatal(err)
	}
	passing := map[string]bool{}
	for _, name := range strings.Split(string(data), "\n") {
		passing[name] = true
	}
	runner := Runner{Root: "../../../../corpus", Backends: ExecutionBackends()}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if !passing[c.Name] {
				t.Errorf("selector case missing from gate: %s", c.Name)
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

func TestRecoveryOffersAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	cases, err := Discover(root, []string{"recovery-offers/basic", "recovery-offers/boundaries", "recovery-offers/costs", "recovery-offers/cleanup-restore", "recovery-offers/nested", "recovery-offers/cancellation", "recovery-offers/action-suspend", "disassembly/recovery-offers"})
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
				t.Error("Recovery Offers acceptance case missing from gate")
			}
			if _, err := runner.execute(c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStoreFactoryAcceptance(t *testing.T) {
	const root = "../../../../corpus"
	names := []string{"capabilities/standard-store", "capabilities/standard-store-errors", "capabilities/standard-store-segments", "capabilities/standard-store-validation"}
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
				t.Error("Store acceptance case missing from gate")
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

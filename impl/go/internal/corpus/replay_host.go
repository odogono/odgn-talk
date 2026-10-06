package corpus

import (
	"fmt"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// ReplayHost applies concrete Host Inputs to one Group, one at a time, for a
// driver that chooses each input from the Trace so far. Sources come only from
// each setup row's inline text, so it performs no filesystem I/O.
type ReplayHost struct{ x *executionReplay }

func NewReplayHost(setup Setup) (*ReplayHost, error) {
	if _, ok := setup["scripts"].([]any); !ok {
		return nil, fmt.Errorf("setup has no scripts")
	}
	x, err := newExecutionReplay(setup, nil, false, func(row Setup) (string, error) {
		if text, ok := row["text"].(string); ok {
			return text, nil
		}
		return "", fmt.Errorf("Missing inline source %v", row["source"])
	})
	if err != nil {
		return nil, err
	}
	x.operations.strict = true
	return &ReplayHost{x}, nil
}

// Apply replays one Host Input line, as a Trace writes it.
func (h *ReplayHost) Apply(line string) error {
	r, err := parseRecord(line)
	if err != nil {
		return err
	}
	if !r.Input {
		return fmt.Errorf("Expected a concrete Host Input")
	}
	h.x.records = append(h.x.records, r)
	if err := h.x.apply(len(h.x.records) - 1); err != nil {
		return err
	}
	return h.x.operations.malformed
}

// Trace is every line written so far, including the runner's Stub lines.
func (h *ReplayHost) Trace() []string { return h.x.lines }

// SaveIDs lists successful Saves in the order their ids were first written.
func (h *ReplayHost) SaveIDs() []string { return h.x.saveIDs }

func (h *ReplayHost) Group() *talk.Group { return h.x.g }

func (h *ReplayHost) Close() { h.x.close() }

// ParseRecord reads one Trace line by the corpus record schema.
func ParseRecord(line string) (Record, error) { return parseRecord(line) }

//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"fmt"
	"reflect"
	"time"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// zigValueResolver supplies the identities that belong to the Host, rather
// than the envelope. Codec tests can supply these without instantiating a guest.
type zigValueResolver interface {
	resolve(kind, id string) (*Object, bool)
	zigFunction(parts []corevalue.Value) (corevalue.Value, error)
}

type zigReplyClock struct {
	raw string
	now time.Time
}

type zigReplyReader struct {
	resolver zigValueResolver
	clock    *zigReplyClock
}

// zigResponse is independent of the reply's envelope. body retains only the
// JSON success bodies outside the Request/Pump family, for their callers.
// A failure may accompany an assigned admission when only its Pump failed.
type zigResponse struct {
	body                      zigReply
	failure                   error
	need                      *zigNeed
	admission                 zigAdmitted
	completion                zigCompletion
	abandoned, settled, trace []string
	pause                     zigPause
}

type zigAdmitted struct {
	delivery DeliveryID
	token    uint64
	assigned bool
}

type zigCompletion struct {
	result  PumpResult
	climbed []Report
	gone    []string
	// A decoding failure is applied by the receipt, after admission bookkeeping.
	err error
}

type zigPause uint8

const (
	zigPauseUnchanged zigPause = iota
	zigPauseSet
	zigPauseClear
)

func (r zigResponse) updatePause(paused *bool) {
	switch r.pause {
	case zigPauseSet:
		*paused = true
	case zigPauseClear:
		*paused = false
	}
}

// read validates every envelope's ref and normalizes its outcome, notices and
// pause transition. No borrowed packet or envelope spans escape the reader.
func (r zigReplyReader) read(data []byte, ref int64, sent string) (zigResponse, error) {
	if bytes.HasPrefix(data, zbPrefix[:3]) {
		var p zbPacket
		err := zbParse(data, &p)
		if err != nil {
			return zigResponse{}, err
		}
		if p.ref != ref {
			return zigResponse{}, fmt.Errorf("Zig reply ref mismatch")
		}
		reply := zigResponse{admission: zigAdmitted{DeliveryID(p.delivery), p.token, p.hasDelivery}}
		reply.abandoned, _ = zbTexts(p.abandoned)
		reply.settled, _ = zbTexts(p.settled)
		reply.trace, _ = zbTexts(p.trace)
		if p.need.tag != 0 {
			need := r.zbReadNeed(&p.need)
			reply.need = &need
		} else if !p.ok {
			reply.failure = p.failure()
		} else if p.completion {
			reply.completion = r.decodeCompletion(nil, &p)
		}
		reply.pause = zigReplyPause(sent, reply.need != nil, reply.failure == nil, true, p.completion)
		return reply, nil
	}
	root, err := zigParseReply(data)
	if err != nil {
		return zigResponse{}, err
	}
	return r.readJSON(root, ref, sent)
}

func (r zigReplyReader) readJSON(root zigReply, ref int64, sent string) (zigResponse, error) {
	p := zigReadPacket(root)
	if ref != 0 {
		if !p.ref.present() {
			return zigResponse{}, fmt.Errorf("Zig reply omitted ref")
		}
		if got, ok := p.ref.int64(); !ok || got != ref {
			return zigResponse{}, fmt.Errorf("Zig reply ref mismatch")
		}
	}
	reply := zigResponse{body: p.ok}
	var notices [3]zigReply
	p.ok.lookup(zigObservedKeys, notices[:])
	reply.abandoned = append(zigReplyTexts(p.abandoned), zigReplyTexts(notices[0])...)
	reply.settled = append(zigReplyTexts(p.settled), zigReplyTexts(notices[1])...)
	reply.trace = zigReplyTexts(p.trace)
	// Grants is a name-to-Operations map: "trace" is a legal Grant name.
	if sent != "grants" {
		reply.trace = append(reply.trace, zigReplyTexts(notices[2])...)
	}

	switch sent {
	case "request", "call", "request-pump", "call-pump", "deliver", "broadcast", "decide":
		// A JSON Broadcast's, or Broadcast Decision's, id is its broadcast.
		id := p.ok.get("delivery")
		if !id.present() {
			id = p.ok.get("broadcast")
		}
		if !id.present() {
			id = root.get("delivery")
		}
		reply.admission.delivery = DeliveryID(zigText(id))
		reply.admission.assigned = id.present()
		if n, ok := root.get("token").int64(); ok && n > 0 {
			reply.admission.token = uint64(n)
		}
		reply.body = nil
	}

	if p.need.present() {
		need := r.zigReadNeed(zigText(p.need.get("m")), p.need)
		reply.need = &need
	} else if p.err.present() {
		reply.failure = zigFailure(p.err)
	} else {
		// Callback result names identify continuations, not the initial Pump.
		if sent == "pump" || sent != "grants" && p.ok.get("reports") != nil {
			reply.completion = r.decodeCompletion(p.ok, nil)
			if sent == "pump" || p.ok.get("state").present() {
				reply.body = nil
			}
		}
	}
	reply.pause = zigReplyPause(sent, reply.need != nil, reply.failure == nil, false, false)
	return reply, nil
}

// readInline unwraps an admission acknowledgement or reads an event with no
// ref. Its caller owns the admission queue and checks that an ack was expected.
func (r zigReplyReader) readInline(data []byte, ref int64, sent string) (zigResponse, bool, error) {
	root, err := zigParseReply(data)
	if err != nil {
		return zigResponse{}, false, err
	}
	if reply := root.get("reply"); reply.present() {
		response, err := r.readJSON(reply, ref, sent)
		return response, true, err
	}
	response, err := r.readJSON(root, 0, "")
	return response, false, err
}

// zigReplyPause is the one pause rule. JSON continuations lack a completion
// tag, so their sent message names carry that information instead.
func zigReplyPause(sent string, need, ok, binary, completion bool) zigPause {
	if need {
		return zigPauseSet
	}
	if ok {
		if binary {
			if completion {
				return zigPauseClear
			}
		} else {
			switch sent {
			case "pump", "op-result", "trace-result", "release-result", "resolve-result":
				return zigPauseClear
			}
		}
	}
	return zigPauseUnchanged
}

var zigObservedKeys = []string{"abandoned", "settled", "trace"}

func zigReplyTexts(raw zigReply) []string {
	var texts []string
	for _, item := range raw.items() {
		texts = append(texts, zigText(item))
	}
	return texts
}

func (r zigReplyReader) resolveObject(kind, id string) (corevalue.Value, error) {
	if r.resolver != nil {
		if o, ok := r.resolver.resolve(kind, id); ok {
			return o.Value().inner, nil
		}
	}
	return corevalue.Value{}, fmt.Errorf("object not resolved")
}

func (r zigReplyReader) resolveFunction(parts []corevalue.Value) (corevalue.Value, error) {
	if r.resolver == nil {
		return corevalue.Value{}, fmt.Errorf("function not resolved")
	}
	return r.resolver.zigFunction(parts)
}

func zigDecodeValue(raw []byte, resolver zigValueResolver) (Value, error) {
	r := zigReplyReader{resolver: resolver}
	v, err := corevalue.DecodeWire(raw, r.resolveObject, func(payload corevalue.Value) (corevalue.Value, error) { return r.resolveFunction(payload.Items()) })
	if err != nil {
		return Nothing, &HostError{InvalidValue, err.Error()}
	}
	return Value{v}, nil
}

// decodeCompletion reads Pump-shaped results, including lifecycle Reports.
// Group settlement remains with the receipt, after admission is registered.
func (b zigReplyReader) decodeCompletion(body zigReply, p *zbPacket) (completion zigCompletion) {
	result := &completion.result
	if p == nil {
		var err error
		*result, err = b.decodePumpHeader(body)
		if err != nil {
			completion.err = err
			return
		}

		for _, row := range body.get("reports").items() {
			report, err := zigReportOf(zigText(row.get("kind")))
			if err != nil {
				completion.err = err
				return
			}
			if err := zigDecodeResolving(row, reflect.ValueOf(report).Elem(), b.resolver); err != nil {
				completion.err = err
				return
			}
			if c, _ := row.get("climbed").boolean(); c {
				completion.climbed = append(completion.climbed, report)
			}
			result.Reports = append(result.Reports, report)
		}
		completion.gone = zigReplyTexts(body.get("gone"))
		return
	}
	state, _ := zbText(p.state)
	stateValue, valid := zigGroupStates[state]
	if !valid {
		completion.err = fmt.Errorf("unknown Zig %s %q", reflect.TypeFor[GroupState](), state)
		return
	}
	result.State = GroupState(stateValue)
	if p.deadline != nil {
		t, ok := zbInstant(p.deadline)
		if !ok {
			completion.err = errZigBinary
			return
		}
		result.NextDeadline = t
	}
	fuel, ok := zbInt(p.fuel)
	if !ok {
		completion.err = errZigBinary
		return
	}
	result.FuelUsed = fuel

	add := func(kind string, row zbView) error {
		report, err := zigReportOf(kind)
		if err != nil {
			return err
		}
		if err := b.zbDecodeReport(row, report); err != nil {
			return err
		}
		if c := row.get("climbed"); len(c) == 1 && c[0] == 0x02 {
			completion.climbed = append(completion.climbed, report)
		}
		result.Reports = append(result.Reports, report)
		return nil
	}
	// zbParse read the positional Reports as it found the list's end.
	if len(p.rows) > 0 {
		result.Reports = make([]Report, 0, len(p.rows))
	}
	for _, row := range p.rows {
		if err := add(zbReportSchemas[byte(row.kind)].name, row.view); err != nil {
			completion.err = err
			return
		}
	}
	var err error
	completion.gone, err = zbTexts(p.gone)
	if len(completion.gone) == 0 {
		completion.gone = nil
	}
	if err != nil {
		completion.err = err
		return
	}
	return
}

// zigReportOf is an empty Report of a guest Report kind.
func zigReportOf(kind string) (Report, error) {
	switch kind {
	case "run end":
		return &RunEnd{}, nil
	case "run started":
		return &RunStarted{}, nil
	case "run discarded":
		return &RunDiscarded{}, nil
	case "run accounting":
		return &RunAccounting{}, nil
	case "causal work":
		return &CausalWork{}, nil
	case "stop":
		return &Stop{}, nil
	case "unhandled":
		return &Unhandled{}, nil
	case "host error":
		return &HostError{}, nil
	case "effect failure":
		return &EffectFailure{}, nil
	case "call failed":
		return &CallFailed{}, nil
	case "decided":
		return &Decided{}, nil
	}
	return nil, backendUnsupported("Report " + kind)
}

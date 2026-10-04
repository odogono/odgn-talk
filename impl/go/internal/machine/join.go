package machine

import "github.com/odogono/odgn-talk/impl/go/internal/value"

// Join retains calls in start order, including replies received while its body
// was preempted. Waiting starts only at the closing instruction.
type Join struct {
	Frame, Start   int
	Members        []JoinMember
	Waiting, Ready bool
	Failure        *SendResume
	Index          int
	early          []joinReply
}
type JoinMember struct {
	ID    string
	Reply *SendResume
}
type joinReply struct {
	id    string
	reply SendResume
}

func (r *Run) AddJoinMember(id string) { r.Join.Members = append(r.Join.Members, JoinMember{ID: id}) }

// SettleJoin records a reply without executing the sender. Its result says
// whether a suspended sender just became ready for a new turn.
func (r *Run) SettleJoin(id string, p SendResume) bool {
	j := r.Join
	if j == nil || j.Ready {
		return false
	}
	for n := range j.Members {
		m := &j.Members[n]
		if m.ID != id || m.Reply != nil {
			continue
		}
		m.Reply = &p
		if !j.Waiting {
			j.early = append(j.early, joinReply{id, p})
			return false
		}
		if p.Reason != "" || p.Timeout {
			j.Failure, j.Index, j.Ready = &p, n+1, true
			if p.Timeout {
				r.Abandons = append(r.Abandons, id)
			}
			for _, pending := range j.Members {
				if pending.Reply == nil {
					r.Abandons = append(r.Abandons, pending.ID)
				}
			}
			return true
		}
		for _, pending := range j.Members {
			if pending.Reply == nil {
				return false
			}
		}
		j.Ready = true
		return true
	}
	return false
}

// BeginJoinWait applies early replies in arrival order, just as replies to an
// already suspended Join are applied. Pending timers are installed by Group.
func (r *Run) BeginJoinWait() bool {
	j := r.Join
	early := j.early
	j.early = nil
	for n := range j.Members {
		j.Members[n].Reply = nil
	}
	j.Waiting = true
	for _, reply := range early {
		r.SettleJoin(reply.id, reply.reply)
	}
	return j.Ready
}

func (r *Run) ResumeJoin() {
	j := r.Join
	if j == nil || !j.Ready {
		return
	}
	r.Join = nil
	f := &r.Frames[len(r.Frames)-1]
	if j.Failure != nil {
		f.PC--
		err := r.positionedError(sendResumeError(*j.Failure))
		if !hasKey(err, "index") {
			err.Entries = append(err.Entries, value.Pair{Key: "index", Val: integer(int64(j.Index))})
		}
		r.raise(err)
		return
	}
	answers := make([]value.Value, len(j.Members))
	for n, m := range j.Members {
		answers[n] = m.Reply.Answer
	}
	result := value.NewList(answers)
	// The Join's base rate was paid at its closing end. Script replies have
	// no conversion charge; only the assembled list's allocation remains.
	if r.pay(0, Size(result)) {
		f.Stack = append(f.Stack, result)
	}
}

func (r *Run) AbandonJoin() {
	j := r.Join
	if j == nil {
		return
	}
	if !j.Ready {
		for _, m := range j.Members {
			if m.Reply == nil {
				r.Abandons = append(r.Abandons, m.ID)
			}
		}
	}
	r.Join = nil
}

// A local catch inside the body keeps its Join; leaving the body abandons it.
func (r *Run) leaveJoin(frame, target int) {
	j := r.Join
	if j == nil || frame > j.Frame {
		return
	}
	if frame == j.Frame && target > j.Start {
		code := r.State.Unit.Bodies[r.Frames[frame].Body].Code
		end := j.Start
		for end < len(code) && code[end].Name != "join-end" {
			end++
		}
		if target <= end {
			return
		}
	}
	r.AbandonJoin()
}

func sendResumeSize(p SendResume) int64 {
	if p.Reason == "" && !p.Timeout {
		return Size(p.Answer)
	}
	if p.Error.Kind != value.Nothing {
		return Size(p.Error)
	}
	return 0
}

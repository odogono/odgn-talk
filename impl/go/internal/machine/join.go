package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Join retains calls in start order, including replies received while its body
// was preempted. Waiting starts only at the closing instruction.
type Join struct {
	Frame, Start   int
	Members        []JoinMember
	Waiting, Ready bool
	Failure        *SendResume
	Index          int
	Early          []JoinReply
}
type JoinMember struct {
	WaitMS int64
	ID     string
	Reply  *SendResume
}
type JoinReply struct {
	ID    string
	Reply SendResume
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
			j.Early = append(j.Early, JoinReply{id, p})
			return false
		}
		if p.Reason != "" || p.Timeout || p.Failed {
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

// BeginJoinWait applies Early replies in arrival order, just as replies to an
// already suspended Join are applied. Pending timers are installed by Group.
func (r *Run) BeginJoinWait() bool {
	j := r.Join
	Early := j.Early
	j.Early = nil
	for n := range j.Members {
		j.Members[n].Reply = nil
	}
	j.Waiting = true
	for _, reply := range Early {
		r.SettleJoin(reply.ID, reply.Reply)
	}
	return j.Ready
}

func (r *Run) ResumeJoinOperation(resume ResumeOperationFunc) {
	j := r.Join
	if j == nil || !j.Ready {
		return
	}
	r.Join = nil
	f := &r.Frames[len(r.Frames)-1]
	if j.Failure != nil && j.Failure.Deadline != nil {
		// No member failed: the Join as a whole ran out of time.
		f.PC--
		r.raise(r.positionedError(DeadlineTimeout(*j.Failure.Deadline)))
		return
	}
	if j.Failure != nil {
		f.PC--
		err := sendResumeError(*j.Failure)
		if j.Failure.Capability {
			_, failure := resume(*j.Failure)
			if r.Status != Running {
				return
			}
			err = *failure
		}
		err = r.positionedError(err)
		if !hasKey(err, "index") {
			err = err.WithEntries(append(err.Entries(), value.Pair{Key: "index", Val: integer(int64(j.Index))}))
		}
		r.raise(err)
		return
	}
	answers := make([]value.Value, len(j.Members))
	for n, m := range j.Members {
		if m.Reply.Capability {
			f.PC--
			answer, err := resume(*m.Reply)
			if r.Status != Running {
				return
			}
			if err != nil {
				e := r.positionedError(*err)
				e = e.WithEntries(append(e.Entries(), value.Pair{Key: "index", Val: integer(int64(n + 1))}))
				r.raise(e)
				return
			}
			f.PC++
			answers[n] = answer
		} else {
			answers[n] = m.Reply.Answer
		}
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
		code := r.Frames[frame].Code.Unit.Bodies[r.Frames[frame].Body].Code
		end := j.Start
		for end < len(code) && code[end].Op != generated.OpJoinEnd {
			end++
		}
		if target <= end {
			return
		}
	}
	r.AbandonJoin()
}

func sendResumeSize(p SendResume) int64 {
	if p.Capability && p.Failed {
		if p.FailureData.Kind == value.Nothing {
			return 0
		}
		return Size(p.FailureData)
	}
	if p.Reason == "" && !p.Timeout {
		return Size(p.Answer)
	}
	if p.Error.Kind != value.Nothing {
		return Size(p.Error)
	}
	return 0
}

func (r *Run) ResumeJoin() { r.ResumeJoinOperation(nil) }

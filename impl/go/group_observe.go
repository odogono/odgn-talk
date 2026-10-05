package northtalk

import (
	"slices"
	"strings"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func (g *Group) observe(s *Script, d delivery, allow func()) (fuel, alloc int64) {
	var waits []*execution
	for _, x := range s.runs {
		if x.run.EventWait != nil {
			waits = append(waits, x)
		}
	}
	slices.SortFunc(waits, func(a, b *execution) int {
		if a.timerOrder < b.timerOrder {
			return -1
		}
		if a.timerOrder > b.timerOrder {
			return 1
		}
		return 0
	})
	args := make([]corevalue.Value, len(d.message.Args))
	for j, v := range d.message.Args {
		args[j] = v.inner
	}
	sender, _, _ := strings.Cut(string(d.from), "/")
	for _, x := range waits {
		raised := len(x.run.Raises)
		f, a, matched := x.run.Observe(d.message.Name, args, d.targetValue(), sender)
		fuel += f
		alloc += a
		g.writeRaises(x, raised)
		if matched {
			x.deadline = nil
			x.how = "resume"
			s.queue = append(s.queue, workItem{run: x})
			allow()
		}
	}
	return
}

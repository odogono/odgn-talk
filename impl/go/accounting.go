package northtalk

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
)

type RunAncestry struct {
	RootDelivery DeliveryID
	ParentRun    RunID
	ParentCall   CallID
}
type RunStarted struct {
	RunAncestry
	Script   string
	Run      RunID
	Delivery DeliveryID
	Selector string
	Function *Value
	Args     []Value
}
type RunDiscarded struct {
	RunAncestry
	Script string
	Run    RunID
	Reason string
}
type RunAccounting struct {
	RunAncestry
	Script string
	Run    RunID
	Fuel   int64
	State  string
}
type CausalWork struct {
	RootDelivery      DeliveryID
	LiveRuns          int64
	QueuedMessages    int64
	DiscardedMessages int64
}

func (*RunStarted) isReport()    {}
func (*RunDiscarded) isReport()  {}
func (*RunAccounting) isReport() {}
func (*CausalWork) isReport()    {}

type accountingRun struct {
	Report       RunAccounting
	Order        int64
	ReportedFuel int64
	Reported     bool
}
type accountingRoot struct {
	Discarded int64
	Reported  string
}
type accountingState struct {
	Next  int64
	Runs  map[RunID]*accountingRun
	Roots map[DeliveryID]*accountingRoot
}

func (g *Group) accountRoot(root DeliveryID) {
	if g.accounting.Roots == nil {
		g.accounting.Roots = map[DeliveryID]*accountingRoot{}
	}
	if g.accounting.Runs == nil {
		g.accounting.Runs = map[RunID]*accountingRun{}
	}
	if g.accounting.Roots[root] == nil {
		g.accounting.Roots[root] = &accountingRoot{}
	}
}
func (g *Group) ancestry(d delivery) RunAncestry {
	a := d.ancestry
	if a.RootDelivery == "" {
		if d.id != "" {
			a.RootDelivery = d.id
		} else {
			parent := d.from
			if d.reply != "" {
				parent = RunID(string(d.from)[:strings.LastIndex(string(d.from), ".c")])
			}
			row := g.accounting.Runs[parent]
			if row == nil {
				panic(fmt.Sprintf("missing accounting parent %s", parent))
			}
			a = RunAncestry{RootDelivery: row.Report.RootDelivery, ParentRun: parent, ParentCall: d.reply}
		}
	}
	g.accountRoot(a.RootDelivery)
	return a
}
func (g *Group) accountStart(s *Script, x *execution, reports *[]Report) {
	x.delivery.ancestry = g.ancestry(x.delivery)
	g.accounting.Next++
	a := x.delivery.ancestry
	g.accounting.Runs[x.id] = &accountingRun{Report: RunAccounting{RunAncestry: a, Script: s.name, Run: x.id, Fuel: x.run.Fuel, State: "live"}, Order: g.accounting.Next}
	r := &RunStarted{RunAncestry: a, Script: s.name, Run: x.id, Delivery: x.delivery.id, Selector: x.delivery.message.Name, Args: slices.Clone(x.delivery.message.Args)}
	if x.delivery.function != nil {
		v := Value{*x.delivery.function}
		r.Function = &v
		r.Selector = ""
	}
	*reports = append(*reports, r)
}
func (g *Group) accountEnd(x *execution, state, reason string, reports *[]Report) {
	row := g.accounting.Runs[x.id]
	if row.Report.State != "live" {
		return
	}
	row.Report.Fuel = x.run.Fuel
	row.Report.State = state
	if state == "discarded" {
		*reports = append(*reports, &RunDiscarded{RunAncestry: row.Report.RunAncestry, Script: row.Report.Script, Run: x.id, Reason: reason})
	}
}
func (g *Group) accountDrop(d delivery) {
	for _, child := range d.children {
		g.accountDrop(child)
	}
	if d.id == "" && d.from == "" {
		return
	}
	a := g.ancestry(d)
	g.accounting.Roots[a.RootDelivery].Discarded++
}

// Called only by the worker. Queue admission alone is concurrent, so take mu
// while collecting input messages; ancestry itself is worker-owned state.
func (g *Group) flushAccounting(reports *[]Report) {
	queued := map[DeliveryID]int64{}
	var count func(delivery)
	count = func(d delivery) {
		for _, child := range d.children {
			count(child)
		}
		if d.id == "" && d.from == "" {
			return
		}
		a := g.ancestry(d)
		queued[a.RootDelivery]++
	}
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if row := g.accounting.Runs[x.id]; row != nil && row.Report.State == "live" {
				row.Report.Fuel = x.run.Fuel
			}
		}
		for _, item := range s.queue {
			if item.run == nil {
				count(item.delivery)
			}
		}
	}
	g.mu.Lock()
	for _, d := range g.inputs {
		count(d)
	}
	g.mu.Unlock()
	for _, d := range g.unrouted {
		count(d)
	}
	// Orphan replies represent already rejected messages, not queued work.
	var rows []*accountingRun
	for _, row := range g.accounting.Runs {
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Order < rows[j].Order })
	changed := map[DeliveryID]bool{}
	live := map[DeliveryID]int64{}
	for _, row := range rows {
		r := row.Report
		if r.State == "live" {
			live[r.RootDelivery]++
		}
		if !row.Reported || row.ReportedFuel != r.Fuel || r.State != "live" {
			copy := r
			*reports = append(*reports, &copy)
			changed[r.RootDelivery] = true
		}
		row.Reported = true
		row.ReportedFuel = r.Fuel
		if r.State != "live" {
			delete(g.accounting.Runs, r.Run)
		}
	}
	var roots []DeliveryID
	for root := range g.accounting.Roots {
		roots = append(roots, root)
	}
	number := func(id DeliveryID) int64 {
		n, _ := strconv.ParseInt(strings.TrimPrefix(string(id), "d"), 10, 64)
		return n
	}
	sort.Slice(roots, func(i, j int) bool { return number(roots[i]) < number(roots[j]) })
	for _, root := range roots {
		row := g.accounting.Roots[root]
		r := &CausalWork{RootDelivery: root, LiveRuns: live[root], QueuedMessages: queued[root], DiscardedMessages: row.Discarded}
		key := fmt.Sprintf("%d/%d/%d", r.LiveRuns, r.QueuedMessages, r.DiscardedMessages)
		if row.Reported != key || changed[root] {
			*reports = append(*reports, r)
		}
		row.Reported = key
		if r.LiveRuns == 0 && r.QueuedMessages == 0 {
			delete(g.accounting.Roots, root)
		}
	}
}

// Saved accounting must describe exactly the retained Runs. Reject malformed
// metadata before a restore can publish a baseline or discard saved work.
func validateSavedAccounting(data savedGroup) error {
	a := data.Accounting
	if a.Next < 0 {
		return fmt.Errorf("negative accounting order")
	}
	orders := map[int64]bool{}
	count := 0
	for _, s := range data.Scripts {
		for _, x := range s.Runs {
			count++
			row := a.Runs[x.ID]
			if row == nil || x.Run == nil || row.Report.Run != x.ID || row.Report.Script != s.Name || row.Report.State != "live" || row.Report.Fuel != x.Run.Fuel || row.Report.RootDelivery == "" || a.Roots[row.Report.RootDelivery] == nil || row.Order <= 0 || row.Order > a.Next || orders[row.Order] {
				return fmt.Errorf("invalid accounting for Run %s", x.ID)
			}
			orders[row.Order] = true
		}
	}
	if count != len(a.Runs) {
		return fmt.Errorf("accounting references a missing Run")
	}
	for id, row := range a.Roots {
		n, err := strconv.ParseInt(strings.TrimPrefix(string(id), "d"), 10, 64)
		if err != nil || id != DeliveryID(fmt.Sprintf("d%d", n)) || n <= 0 || n > data.Delivery || row == nil || row.Discarded < 0 {
			return fmt.Errorf("invalid accounting root %s", id)
		}
	}
	return nil
}

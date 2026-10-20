package northtalk

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

package northtalk

// ChargeRequestID is a Group-wide charge request id: q1, q2, … in enqueue order.
type ChargeRequestID string

// ChargeRequest is a queued charge request (Metered Operations). Its Result
// is ready once Done closes, at the end of the Pump that processes it.
type ChargeRequest struct {
	id     ChargeRequestID
	done   chan struct{}
	result *ChargeResult
}

func (r *ChargeRequest) ID() ChargeRequestID   { return r.id }
func (r *ChargeRequest) Done() <-chan struct{} { return r.done }
func (r *ChargeRequest) Result() *ChargeResult { return r.result }

// ChargeResult is a charge request's outcome, also reported by its Pump.
type ChargeResult struct {
	Request ChargeRequestID
	Call    CallID
	Fuel    int64  // the requested amount; only "accepted" spends it
	Status  string // "accepted", "limit" or "inactive"
}

func (*ChargeResult) isReport() {}

// RequestCharge queues a charge request into the Group that made the Call,
// from any goroutine. Only a suspending Operation declared Metering
// "read-only" may ask, one unresolved request at a time; an invalid amount,
// an ineligible call or an overlap is HostError invalid value, with no id.
func (c *Call) RequestCharge(fuel int64) (*ChargeRequest, error) {
	return c.group.backend.requestCharge(c, fuel)
}

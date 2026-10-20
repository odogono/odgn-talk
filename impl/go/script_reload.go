package northtalk

type CarryOver int

const (
	ResetVariables CarryOver = iota
	CarryVariables
)

// ReloadOptions: KeepMailbox keeps the mailbox, a rewound message included
// (ADR 0068).
type ReloadOptions struct {
	KeepMailbox bool
}

type Stop struct {
	Script          string
	Reason          string
	DiscardedRuns   []RunID
	DroppedMessages []DeliveryID
	PendingCalls    []CallID
}

func (*Stop) isReport() {}

// Reload validates and checks carried state before terminating old Runs and
// rolling back their participants.
func (s *Script) Reload(source string, carry CarryOver, o ...ReloadOptions) ([]Report, error) {
	return s.group.backend.reload(s, source, carry, len(o) > 0 && o[0].KeepMailbox)
}

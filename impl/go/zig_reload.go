//go:build !talk_native_go

package northtalk

// Reload and Extend are worker calls the guest checks and records. A Reload
// may pause for Grant release hooks and lifecycle crossings like a Library
// replacement; its reply carries the Reports of the Runs it discarded.
func (b *zigGroup) reload(s *Script, source string, carry CarryOver, keepMailbox bool) ([]Report, error) {
	how := map[CarryOver]string{ResetVariables: "reset variables", CarryVariables: "carry variables"}[carry]
	fields := map[string]any{"script": s.name, "source": source, "carry": how, "keepMailbox": keepMailbox}
	if err := b.beginWorker("reload", fields); err != nil {
		return nil, err
	}
	defer b.group.endWorker()
	if err := b.syncKinds(); err != nil {
		return nil, err
	}
	var reports []Report
	_, err := b.exchangeDecoded("reload", map[string]any{"script": s.name, "source": source, "carry": how, "keepMailbox": keepMailbox}, func(reply zigResponse) error {
		if reply.failure != nil {
			return nil
		}
		result, err := b.completePump(reply.completion)
		reports = result.Reports
		return err
	})
	if err != nil {
		return nil, err
	}
	s.source = source
	if reports == nil {
		reports = []Report{}
	}
	return reports, nil
}

func (b *zigGroup) extend(s *Script, source string) error {
	fields := map[string]any{"script": s.name, "source": source}
	if err := b.beginWorker("extend", fields); err != nil {
		return err
	}
	defer b.group.endWorker()
	if err := b.syncKinds(); err != nil {
		return err
	}
	_, err := b.send("extend", map[string]any{"script": s.name, "source": source})
	return err
}

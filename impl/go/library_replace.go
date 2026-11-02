package northtalk

// ReplaceLibrary validates every transitive dependent before stopping any Run.
// KeepMailbox keeps every reloaded Script's mailbox, as Reload's does.
func (g *Group) ReplaceLibrary(l *Library, carry CarryOver, o ...ReloadOptions) ([]Report, error) {
	if l == nil {
		return nil, &HostError{InvalidValue, "nil Library"}
	}
	return g.backend.replaceLibrary(l, carry, len(o) > 0 && o[0].KeepMailbox)
}

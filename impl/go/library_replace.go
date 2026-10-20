package northtalk

// ReplaceLibrary validates every transitive dependent before stopping any Run.
func (g *Group) ReplaceLibrary(l *Library, carry CarryOver) ([]Report, error) {
	if l == nil {
		return nil, &HostError{InvalidValue, "nil Library"}
	}
	return g.backend.replaceLibrary(l, carry)
}

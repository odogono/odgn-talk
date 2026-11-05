package northtalk

// Restore checks declarations before rehydrating frames. Host bindings and
// futures are rebuilt separately from the saved plain machine data.
func (c *Core) Restore(save []byte, o RestoreOptions, options ...GroupOption) (_ *Group, result RestoreResult, err error) {
	return zigRestore(c, save, o, options)
}

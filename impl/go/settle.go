package northtalk

// Settle reserves a pending id immediately, and queues its settlement for the
// first Pump. The adopted Call answers into the restored Group.
func (g *Group) Settle(id CallID, s Settlement) (*Call, error) {
	return g.backend.settle(id, s)
}

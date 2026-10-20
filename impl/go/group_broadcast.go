package northtalk

import (
	"context"
)

// Broadcast queues a message for the Scripts that want it at the next drain.
func (g *Group) Broadcast(m Message) (BroadcastID, error) {
	id, _, err := g.admit(nil, m, nil, false, nil, delivery{kind: "broadcast"})
	return BroadcastID(id), err
}

func (g *Group) DecideBroadcast(ctx context.Context, m Message) (BroadcastID, *Deciding, error) {
	d := &Deciding{done: make(chan struct{})}
	id, _, err := g.admit(nil, m, ctx, false, d, delivery{kind: "broadcast"})
	if err != nil {
		return "", nil, err
	}
	return BroadcastID(id), d, nil
}

type broadcastDecision struct {
	future *Deciding
}

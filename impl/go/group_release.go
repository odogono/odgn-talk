package northtalk

import "slices"

// Every caller owns the worker guard. Host input methods remain queueable.
func (g *Group) releaseGrant(s *Script, name string, reason ReleaseReason) {
	grant := s.grants[name]
	if grant == nil || grant.definition.release == nil {
		return
	}
	invokeReleaseHook(grant.definition.release, GrantContext{Group: g, ScriptName: s.name, GrantName: name, Binding: grant.binding, Now: g.clock, Reason: reason})
}

func (g *Group) releaseGrants(s *Script, reason ReleaseReason) {
	names := make([]string, 0, len(s.grants))
	for name := range s.grants {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		g.releaseGrant(s, name, reason)
	}
}

// Cleanup cannot refuse its lifecycle boundary, including through a transport.
func invokeReleaseHook(hook ReleaseHook, ctx GrantContext) {
	defer func() { _ = recover() }()
	hook(ctx)
}

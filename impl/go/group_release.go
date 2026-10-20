package northtalk

// Cleanup cannot refuse its lifecycle boundary, including through a transport.
func invokeReleaseHook(hook ReleaseHook, ctx GrantContext) {
	defer func() { _ = recover() }()
	hook(ctx)
}

module github.com/odogono/odgn-talk/bench/go

go 1.27

require (
	github.com/odogono/odgn-talk/bench/peers/go v0.0.0
	github.com/odogono/odgn-talk/impl/go v0.0.0
	github.com/yuin/gopher-lua v1.1.2
	go.starlark.net v0.0.0-20261005163335-bcb1a1a55bf9
)

require golang.org/x/sys v0.42.0 // indirect

replace (
	github.com/odogono/odgn-talk/bench/peers/go => ../peers/go
	github.com/odogono/odgn-talk/impl/go => ../../impl/go
)

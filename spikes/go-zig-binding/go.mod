module github.com/odogono/odgn-talk/spikes/go-zig-binding

go 1.27

require (
	github.com/odogono/odgn-talk/impl/go v0.0.0-00010101000000-000000000000
	github.com/tetratelabs/wazero v1.12.0
)

require golang.org/x/sys v0.44.0 // indirect

replace github.com/odogono/odgn-talk/impl/go => ../../impl/go

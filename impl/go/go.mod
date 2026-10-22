module github.com/odogono/odgn-talk/impl/go

go 1.27

require (
	github.com/odogono/odgn-talk/impl/go/sqlite v0.0.0
	github.com/tetratelabs/wazero v1.12.0
	golang.org/x/text v0.43.0
)

require (
	github.com/ncruces/go-sqlite3 v0.35.6 // indirect
	github.com/ncruces/go-sqlite3-wasm/v6 v6.3.35304 // indirect
	github.com/ncruces/julianday v1.0.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
)

replace github.com/odogono/odgn-talk/impl/go/sqlite => ./sqlite

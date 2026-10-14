---
type: feat
breaking: true
---
Implement Metered Operations in the Zig Core, including Pump-authorized charge
requests, latched refusals, Run accounting, saves and Message Layer transport.
The Zig SQLite factory now supplies step authorization instead of reserving
`max × perRow`. Native Operation/SQLite callback layouts change, and saves use
`zig/7`. Shared metering catalogues and Go/TS implementation remain staged.

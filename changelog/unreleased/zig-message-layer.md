---
type: feat
---
Speak the Message Layer on `wasm32-wasi` in the Zig Core: its reactor now exports `talk_buffer`/`talk_send` beside `talk.h`, answering `hello`, Capability definition and Grants, `new-group`, `load`, `deliver`, `pump` with interim `op` and `prop` needs, `save` and `fingerprint`, so the C and Elixir bench Hosts run it beside the Go reactor (#635).

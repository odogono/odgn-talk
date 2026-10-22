# A Host function's Call names the Delivery that started its Run

A Host function already learns which Run, Script, named Grant and Segment made each call. It doesn't learn which Host Delivery started that Run. The Pump reports do link Runs to Deliveries (`run started`), but only when the Pump returns, which is too late for a call made inside the same Pump. `http`'s `respond` (ADR 0124) must refuse every Run but the one its HTTP Exchange started. So a call now carries an optional `delivery`: the delivery id of the Host Delivery that started the calling Run. Runs started by a Script's `send`, a Function Value call or a Join have none.

## Considered Options

- **The Host maps Runs to Deliveries from the reports:** this needs no Core change, but the mapping arrives after the call it is needed for.
- **Ownership by Script instead:** this is weaker than the rule ADR 0124 settled.
- **Tracing `delivery` too:** the Trace already records `run started` with the Delivery, so a Trace reader can recover it. Recording it on every call line would change every Trace for no new information.

## Consequences

- `Call.delivery` (Go `Call.Delivery`, C `talk_call_delivery`, the Message Layer's optional `delivery` on an `op` need) is the delivery id, or absent.
- Both Cores already keep it on the Run, and Snapshots already save it.
- It isn't traced and isn't part of the Group Fingerprint.
- Any Capability may use it, not only `http`.

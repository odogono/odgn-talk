# Capabilities are called through `tell` and `ask`, never through Host-defined syntax

A Script calls a Capability in one uniform form: `ask <capability> to <operation> <arguments>` for a call whose result the Script needs (`it` holds the result), and `tell <capability> to <operation> <arguments>` for fire-and-forget. For example, `ask http to get url, {headers: auth}` or `tell log to write "done"`. A Capability offers a set of named Operations, which the Host declares. The Operation is the unit of the grant, of the declared per-call cost and of the suspending flag, so a Host can grant `http` with only `get` and `head`. Operation names are literal words, so the loader checks every call against the grant. A call to an Operation that wasn't granted is a load-time error, and a load-time check is also how the Suspension Points are known (ADR 0004). The word after `to` is always an Operation name, even if it's also a keyword (`put`, `delete`). Arguments are ordinary values, positional, and usually a single map. Hosts cannot add commands, predicates or other syntax. We chose this because the grammar must be the same on every Host for the Conformance Corpus and for bit-for-bit parity (ADR 0009). Host-defined commands like `save value as key in storage` would make each Host a different language, and the parser would depend on the grant list. The uniform form also shows a reader where effects happen, and `ask` marks where a Run can suspend.

## Considered Options

- **Host-defined commands and predicates** (`save … in storage`, `if the player carries torch`). This is the most English-like option, and HyperTalk's XCMDs set a precedent. But every Host would extend the grammar, tooling would need each Host's grammar, and Scripts wouldn't port between Hosts.
- **Method calls** (`storage.save(key, value)`). Familiar to programmers, and trivial to parse, but it looks out of place in a beginner surface and doesn't show which calls suspend.
- **One generic Operation with the action as data** (`ask http to request {method: "DELETE", …}`). Flexible, but the loader can't check the action against the grant. A Host may still offer one next to specific Operations, and it is checked when the call is made.

## Consequences

- Whether a call suspends is declared per Operation, not per Capability. A "Suspending Capability" is shorthand for a Capability with at least one suspending Operation.
- `tell` is allowed only on Operations the Host declares as fire-and-forget, because otherwise the result and any failure would go nowhere.
- The Host embedding API registers Operations with their names, argument shapes, costs and flags. Host Objects keep properties, which Scripts write with `set` (`set the state of door to "open"`) so that a Host effect doesn't look like `put … into` on a Script value.
- Operation names become part of a Host's documented surface, and the LSP can complete them from the grant list.
- Narrowed by ADR 0019: a call to a suspending Operation is written `ask … and wait`, and the loader checks the form against the Operation Declaration both ways, so every Suspension Point is visible in the source.

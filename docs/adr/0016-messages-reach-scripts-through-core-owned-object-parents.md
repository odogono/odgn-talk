# Messages reach Scripts through Core-owned object parents

A Host Object has at most one Owning Script (set when that Script is loaded), and the Core, not the Host, holds each object's parent. The Host changes parents with `setParent`. Parent changes are recorded in the Trace and saved with the Group. A Delivery addressed to an object goes to its Owning Script, or else to the nearest ancestor that has one. If no ancestor has one, the object's kind decides what the end of the chain means. The path is walked at dispatch, from the parents the Core holds at that moment. When no clause matches, or a Handler uses `pass`, the message keeps climbing from the owner's object. The language gets `the target`, the object a message was delivered to, which stays the same all the way up the path. We chose this because the Damocles slice's path follows Object Residence, which native game code changes mid-tick. A Host function called inside dispatch would put Host code where parity can't see it, and lockstep Hosts could walk different paths. Core-owned parents make the walk deterministic and put every change in the Trace. One owner per object is the HyperTalk model, and it keeps one Run per message. Fan-out is what Broadcast is for.

## Considered Options

- **A Host `Parent` function called at dispatch:** it keeps parents in Host state, which is simpler, but the walk then depends on when the Host function runs and what it reads.
- **A path fixed at delivery**, with the Host passing the chain: every Delivery gets heavier, and the path is stale by the time a queued message is dispatched.
- **Several Owning Scripts per object, fanned out:** one message would start several Runs, which muddies replies, outcomes and delivery ids.
- **Hosts pass the target object as an argument by convention:** Handlers higher up the path then depend on every Host remembering to.
- **Broadcast into every mailbox:** every Script pays dispatch Fuel for messages it doesn't want, which is too costly at 10k Scripts.
- **Registering interest through a Capability:** it duplicates state the Core already has (Handlers and pending `wait for`s).
- **One queueing policy per message** (ADR 0004 as written): the webhook and pickup Scripts wanted different policies on clauses of one message, and splitting message names pushes routing back into the Host.
- **A queued message waiting at the head of the mailbox:** one busy clause would stall the whole Script.
- **A Script-level `exclusive` mode for Damocles's one-script-at-a-time rule:** it revives ADR 0004's rejected strict serial Script. The Host already knows when a Run ends.

## Consequences

- **Parents:**
  - `setParent` rejects a cycle as a Host error, and it can be called from any thread.
  - A disposed object drops out of the chain, so the walk skips to its parent.
  - A message waiting in the mailbox follows the object if it moves.
- **Routing:** `group.deliver` routes by object. `Script.deliver` stays for messages addressed to a Script rather than to an object.
- **Addressing Scripts and objects by name:**
  - Scripts in one Group are addressable by name. Across Groups the Host routes.
  - Well-known Host Objects are bound to names at load (`objects: { session: … }`), checked like Grants, and saved by stable id. A name that clashes with a Script Variable or Handler is a load error.
- **`the target`:** `me` stays the object the Script owns. For a message sent without an object, `the target` is the receiving Script's owner, or Nothing if it has none.
- **Broadcast:**
  - `group.broadcast` delivers only to Scripts that currently want the message, meaning they have a Handler for it or a `wait for` pending on it.
  - Scripts that don't want it pay nothing.
  - A Broadcast is never reported as unhandled and never climbs a path.
  - Each recipient gets its own Delivery id under one broadcast id, and the Trace records the recipients.
- **Queueing:** narrows ADR 0004. A queueing policy belongs to a Handler Clause, not to the whole message. Dispatch picks the clause first, then applies that clause's policy against in-flight Runs of the same clause.
  - **`, queued`:** the Run parks right after dispatch, in a queue for its clause. The mailbox keeps flowing, dispatch Fuel is charged once, and the parked Run counts toward Persistent State.
  - **`, dropping`:** the new Run ends right after dispatch with outcome `dropped`.
- **Guards:** a Host Object's id is Core-held, so it is the only Host Object property a Guard may read (`where the id of item is "object-slot-183"`).
- **Damocles:**
  - The original's single script VM (busy, with one waiting trigger that a later one replaces) is Host policy.
  - The Host owns trigger arming and the waiting slot, and it delivers the next trigger when the previous Run's report arrives.
- **Still untested:** decision-mode dispatch. No Example Host needed a veto, because Damocles's refusals are native and silent.
- **Source:** the [Example Hosts sketch](https://github.com/odogono/odgn-talk/tree/prototype/example-hosts/prototypes/example-hosts) is the primary source.

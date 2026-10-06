# A restored Group's Host Objects are found by kind and id

A Group looks up a Host Object's handle by its Object Kind name and id: `group.ObjectByID(kind, id)` in Go and `group.objectById(kind, id)` in TS. `Restore` makes new handles, and the Host's `Resolve` returns only the native object (ADR 0008, #72), so neither Core's specified interface let a Host get a restored handle back to `Deliver` to, `SetParent`, `Dispose` or pass as a value. TS had the lookup as an unspecified helper, and Go's corpus runner and fuzz worker reached the Group's objects through an internal hook. We chose a lookup because the id is already the Host's own identity for the object (ADR 0008), and kind and id are what a save, `Resolve`, `DecodeValue`'s resolver and the restore result's `Disposed` all use, so `DecodeValue(b, g.ObjectByID)` works as it stands. Settled in #377.

- **Any Group, any time.** The lookup isn't tied to Restore. It also reaches an object a Capability made during a Run that the Host didn't keep.
- **Disposed objects are found.** A disposed object is still an ordinary value with its id and equality (ADR 0044), so the lookup returns it. "Absent" means the Group never made an object with that kind and id.
- **Callable from anywhere.** It doesn't queue and reads no Run state, so like `Object` it is safe from any goroutine and inside a Pump, such as from a property `Get`.

## Considered Options

- **The restored handles in the restore result:** only available at Restore, and it would repeat `Disposed` for the objects that didn't resolve.
- **`Resolve` receives the new handle:** the Host would record each handle as it is made, but every Host's `Resolve` would change, and so would the message layer's interim `resolve`.
- **No API:** a Go Host couldn't reach a restored object it didn't hold through a Script's value, and `DecodeValue` would have no resolver to use after a Restore.

## Consequences

- Go's `internal/replay` hook for listing a Group's objects is removed: the corpus runner looks up the ids it set up.
- The message layer is unchanged, since its handles are already `[kind, id]`.

# The test runner gives each Script under test a mock owner

When the Host Manifest names an Owner Kind, `northtalk test` gives every Script under test its own fresh Host Object of that kind as `me`, made anew for each test ([#1645](https://github.com/odogono/odgn-talk/issues/1645)). The Test Script's own `me` stays Nothing, and without an Owner Kind nothing changes. An owner's properties start unset, as a well-known object's do (ADR 0056), so reading one before the test sets it raises `unset property`. The Harness gains one Operation, `owner`: `ask harness to owner "door"` returns the Script `door`'s owner, and any other name fails with `no such script`. With it the Test Script reads the owner's properties and sends it messages, which reach the Script by its Message Path as a Host's would. The Harness's `set` key `<name>.<property>` may now name a Script under test as well as a well-known object, and the runner refuses a Script that shares a well-known object's name. An owner has no parent, so the Message Path ends at it. Folio's Harness is unchanged, since Folio Scripts already have real owners (ADR 0133).

We chose this because it extends ADR 0056's existing design for Host Objects instead of adding a second one. A test still reaches the Script under test only by message or through the object a Host would hand it. The values come from the test, never from a Shape, and the Harness gains one read verb, as Folio's did with `property:of:`.

## Considered Options

- **Defaults from manifest Shapes:** a Shape gives no default worth trusting, which is why ADR 0056 leaves well-known objects unset.
- **A Harness verb per property operation (`get`, `setOwner`):** returning the object lets the Test Script use ordinary property reads and sends, so `owner` is the only new verb.

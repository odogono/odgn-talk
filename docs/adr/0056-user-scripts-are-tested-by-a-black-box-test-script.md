# User Scripts are tested by a black-box Test Script

An author tests their own Scripts with `northtalk test`, which is Tooling (ADR 0028), so nothing it produces is normative. A **Test Script** is an ordinary Script in a `*.test.talk` file. Each of its parameterless Handlers named `test` and then a capital, such as `on testIncrements`, is a **Test Handler**: one test, the way SUnit treats a `test` method. Every test gets a fresh Script Group holding the Test Script and every other Script in its directory, named by file stem. The Test Script reaches them only by message, as any other Script would. The Group runs under a virtual Clock from a fixed instant, and an optional `on setup` runs first. The Grants come from the Host Manifest the author names, each as a mock. The Test Script alone is also granted the **Harness**, a Capability that queues answers for those mocks (`stub`, `stubFail`), reads the calls they received (`calls`) and moves the Clock on (`advance`). A call with no answer queued fails with `unstubbed call`. The runner also supplies the **Test Library**, whose `assert` and `assertEqual` throw an `assertion failed` Error. The pass rule is strict. A test passes only if its Run completes, no Run in the Group errors and no message goes unhandled. After the test Run ends, the runner keeps pumping, without moving the Clock, until the Group is idle. Every `*.transcript` under the same paths is replayed as `northtalk replay` replays it, and counts as one test. We chose this because it adds nothing to the language. A test is a Script, a Delivery and a Run outcome, so it uses only the public embedding API, and the Go REPL (#137) could run the same tests without a spec change. Testing by message respects the actor model (ADR 0004). A Script under test carries no test code, and a test sees exactly what another Script would. Getting Grants from the Host Manifest means a test can't drift from what the Host offers. Giving the stubs and the Clock to a Capability keeps the rule that Scripts have no ambient I/O (ADR 0012).

## Considered Options

- **Test Handlers inline in the Scripts under test,** ignored by real Hosts: the simplest option, but test code would ship with every Script.
- **Test Handlers added into the Script under test,** as a session extends its Script (ADR 0014): they could read Script Variables, but they would blur the boundary a Script is meant to keep.
- **Recorded Transcripts as the only kind of test:** golden files are easy to record, but brittle and hard to read as specifications. They stay as the second kind of test.
- **A sidecar data file of stubs per test:** declarative, but it can't vary answers partway through a test or move the Clock between sends.
- **A suspending call that waits until the test answers it:** it could test in-flight state, but the language would need call ids, and a forgotten answer would hang until MaxWait.
- **`assert` in the stdlib, or plain `throw` only:** the stdlib is a small reserved set (ADR 0021), and tooling must not grow it. Plain `throw` gives poor failure messages.
- **Passing a test on its own Run alone:** an error in a background Run of another Script would go unseen.
- **A normative test format, with Corpus cases:** both Cores would have to implement it before either needed it.

## Consequences

- **Portable, not normative:** `tooling/cli/README.md` states the convention. A Go runner may follow it, but no Core must.
- **Names:**
  - `test` is the Test Library's name, which a Host Manifest's Libraries may not reuse.
  - `harness` is the Harness's name, which a Host Manifest's Grants may not reuse.
  - Test Handler names follow camelCase, since `on test increments` would be the message `test` with a parameter.
- **Locations:** an assertion raised inside the Test Library is reported at its Test Handler, since a Library's raise doesn't point back at its caller. A raise in a Script under test is reported where it happened.
- **Time:**
  - The Clock only moves when the test is waiting with nothing else to run, or when it calls `advance`.
  - A test waiting on a deadline jumps straight to it.
  - A test waiting on nothing that can happen fails rather than hangs.
- **Out of scope for now:** the Playground, machine-readable output, Host Objects from the manifest, and the `timer` Capability.

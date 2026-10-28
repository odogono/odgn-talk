# Save-state determinism and state comparison in other systems

Research for [#1693](https://github.com/odogono/odgn-talk/issues/1693), checked 2026-10-28 against repository revision `538ba8c8`. It follows the State Fingerprint in [ADR 0142](../adr/0142-saved-state-is-compared-by-state-fingerprint.md), which [#1703](https://github.com/odogono/odgn-talk/pull/1703) (Zig) and [#1704](https://github.com/odogono/odgn-talk/pull/1704) (TS) implement. These are recommendations, not decisions.

## The question

How do interactive-fiction VMs, narrative engines, persistent scripting runtimes, deterministic games and emulators make save states reproducible, and how do they tell whether two states are equal? What should change in NorthTalk's `Group.save()` snapshot and State Fingerprint as a result?

## Summary

- **None of the systems compares saves byte for byte as its equality test.** They split each save into a state body and an envelope, and compare a hash of the body:
  - Factorio, GGPO and RetroArch netplay hash the state only.
  - mGBA, Ren'Py and SugarCube keep the timestamp, title and screenshot outside the state.
  - Quetzal leaves out timestamps and counters entirely.
  - ADR 0142 takes the same approach: it keeps the save id counter in the save and hashes everything else.
- **The common failure is iteration order, not timestamps.** Unordered containers broke byte stability in every system that didn't sort them: Lua tables in Eris, .NET `Dictionary` in ink, Python `set` in Ren'Py's pickle, and the Glulx `MAll` block list. **The Zig Core has the same problem.** Its save writes two `std.AutoHashMapUnmanaged` maps in their iteration order, and that order can differ after a restore (see [the Zig hash maps](#the-zig-saves-hash-maps)).
- **The deterministic games test save stability directly.** Factorio checks it with save, load, save and compare, and GGPO with a sync test that rolls back, replays and compares checksums. NorthTalk's corpus already replays a save and restore between Pumps, but doesn't compare fingerprints there.
- **When states differ, a single hash only shows that they differ.** Factorio diffs two readable saves taken on the same tick. GGPO logs both save states, and Eris can record the path to a failing value. NorthTalk has no tool that says what differs, and Mercenary's workaround blanks the whole Group.
- **Canonical encodings are a contract, not something you get for free.** CBOR and JSON define canonical forms (RFC 8949 §4.2, RFC 8785). Protobuf says its own serialisation "is not (and cannot be) canonical" and advises writing your own fingerprint function. ADR 0142 already avoids a cross-Core fingerprint for this reason.

## Interactive-fiction VMs: Quetzal and Glulx

**Quetzal** ([spec 1.4](https://inform-fiction.org/zmachine/standards/quetzal/index.html)) is an IFF `FORM` of type `IFZS` with these chunks:

- **`IFhd` identifies the story file.** It holds the release number, serial number, checksum and PC (§5.4). An interpreter refuses a save whose identity doesn't match its story file (§5.3).
- **`CMem` stores dynamic memory as a diff.** Memory is XORed with the original story file's dynamic memory, so unchanged bytes become zero. The result is run-length encoded: a zero byte is followed by a count, and the pair stands for count + 1 zeros. Trailing zeros may be omitted (§3.2–3.4). `UMem` is the uncompressed alternative (§3.6).
- **`Stks` holds the stacks.** It contains only the used frames, oldest first. Each frame has its return PC, flags, result variable, arguments-supplied byte, eval-stack count, locals and eval stack (§4.3).
- **Metadata chunks are optional and ignored.** `ANNO`, `AUTH` and `(c)` are free-form (§7.3–7.7). Unknown chunks are skipped (§8.9), and optional chunks need not survive a re-save (§7.17).
- **No time or counter.** The spec defines no timestamp, creation date or save counter. So a save is a function of story identity, memory, stack and PC.

**Glulx** ([spec §1.8](https://www.eblong.com/zarf/glulx/Glulx-Spec.html#saveformat)) uses "a variant of Quetzal":

- **`IFhd` is the first 128 bytes of memory**, which are in ROM. They include the story file's length and checksum (§1.8.4).
- **`CMem`/`UMem` start with a 4-byte memory size**, and the diff starts at `RAMSTART` (§1.8.1).
- **The heap chunk isn't canonical.** In the `MAll` chunk, "The blocks need not be listed in any particular order" (§1.8.3). So two saves of the same heap can differ in bytes.
- **Some state is deliberately not saved:** Glk I/O objects, the protected-memory range and **the RNG's internal state** (§1.8.5).

## ink

The save is `StoryState.ToJson()`, and `LoadJson` restores it ([`StoryState.cs`](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/StoryState.cs)).

- **What `WriteJson` writes** (L654–700):
  - `flows`: each flow's `callstack`, `outputStream`, `currentChoices` and optional `choiceThreads` ([`Flow.cs` L31–](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/Flow.cs#L31))
  - `currentFlowName`, `variablesState`, `evalStack` and `currentDivertTarget`
  - `visitCounts`, `turnIndices` and `turnIdx`
  - `storySeed` and `previousRandom`
  - `inkSaveVersion` and `inkFormatVersion`
  It writes no timestamp and no save counter.
- **Randomness is part of the state.** `RANDOM` seeds a fresh `Random` from `storySeed + previousRandom`, then stores the draw back as `previousRandom` ([`Story.cs` ~L1505](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/Story.cs#L1505)). The initial seed comes from the wall clock: `DateTime.UtcNow.Millisecond` (StoryState L482–483). After that, the RNG state is two saved integers.
- **Versioning:** `kInkSaveStateVersion = 10` and `kMinCompatibleLoadVersion = 8` (L25–26). `LoadJsonObj` refuses saves older than the minimum (L704–711). This allows a range of readable versions, where NorthTalk reads exactly one.
- **Byte stability:** visit counts, turn indices, flows and globals are written in .NET `Dictionary` enumeration order (L476–477, L659–688; [`JsonSerialisation.cs` L53–59](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/JsonSerialisation.cs#L53)). .NET documents that order as undefined: ["The order in which the items are returned is undefined."](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.dictionary-2?view=net-8.0) So two runs that reach the same state are not guaranteed to give the same JSON.
- **Unchanged globals are left out.** By default, `dontSaveDefaultValues` skips globals still equal to their declared value ([`VariablesState.cs` L160–190](https://github.com/inkle/ink/blob/35c63e52f1d36060930dc7ed3cfba38ea224b528/ink-engine-runtime/VariablesState.cs#L160)). This is the same idea as Quetzal's diff against the original.
- **Copy-on-write background save:** `CopyStateForBackgroundThreadSave()` freezes the current state for a background thread. The live story keeps running on a copy that records changes in a `StatePatch`, and `BackgroundSaveComplete()` applies it (Story L828–868; StoryState L543–575, L623–640).

## SugarCube (Twine)

- **Save object** ([`save.js` L912–946](https://github.com/tmedwards/sugarcube-2/blob/ba17b12343728d191b5cc6a82e4dc5713379863d/src/save.js#L912)): `marshal` adds `date: Date.now()`, `id: Config.saves.id` (the story's id, which a load must match, L962) and `state`. An optional `version`, plus the caller's `desc`, `type` and `metadata`, sit beside them. `splitSave` stores `{state}` as data and the rest as `info`, separately (L943–946). So the timestamp is never inside `state`.
- **History of moments** ([`state.js` L106–130](https://github.com/tmedwards/sugarcube-2/blob/ba17b12343728d191b5cc6a82e4dc5713379863d/src/state.js#L106)):
  - Each moment is a `{title, variables}` pair.
  - The marshalled state holds `index`, the history (delta-encoded by default) and the names of `expired` moments.
  - It holds the PRNG `seed` when the PRNG is enabled.
- **Deltas:** `historyDeltaEncode` stores the first moment whole and each later moment as a `Diff.diff` from the one before (L515–553).
- **The PRNG is restored by replay.** Each moment records the PRNG's `pull` count. A restore recreates the generator from the seed and pulls that many times (L566–626). The saved RNG state is just the seed and a count.
- **Compression:** saves are LZ-String-compressed: `compressToUTF16` in Web Storage ([`webstorage.js` L177](https://github.com/tmedwards/sugarcube-2/blob/ba17b12343728d191b5cc6a82e4dc5713379863d/src/storage/adapters/webstorage.js#L177)) and `compressToBase64` for disk saves (`save.js` L772).

## Yarn Spinner

- **Visit counts live with the variables.** The runtime stores them as ordinary variables named `$Yarn.Internal.Visiting.<node>` ([`Library.cs` L207–210](https://github.com/YarnSpinnerTool/YarnSpinner/blob/c5215f86dd5a6761aecbdc9f60f6a6108f91f919/YarnSpinner/Library.cs#L207); [`Dialogue.cs` L1144–1152](https://github.com/YarnSpinnerTool/YarnSpinner/blob/c5215f86dd5a6761aecbdc9f60f6a6108f91f919/YarnSpinner/Dialogue.cs#L1144)).
- **The built-in save is variables only.** `SaveStateToPersistentStorage` serialises `GetAllVariables()` (floats, strings and bools) to JSON ([`DialogueRunner.Utility.cs` L84–160](https://github.com/YarnSpinnerTool/YarnSpinner-Unity/blob/90fb4c462355514bb4a8fdc0085a327f71f1b561/Runtime/DialogueRunner/DialogueRunner.Utility.cs#L84); [`VariableStorageBehaviour.cs` L89–95](https://github.com/YarnSpinnerTool/YarnSpinner-Unity/blob/90fb4c462355514bb4a8fdc0085a327f71f1b561/Runtime/Storage/VariableStorageBehaviour.cs#L89)).
- **No mid-node resume.** The [FAQ](https://docs.yarnspinner.dev/3.1/faq) says to save `DialogueRunner.CurrentNode` and restart with `StartDialogue(node)`, and that "Jumping to a specific line in a node is currently not supported." The VM's program counter and stack aren't saved. Equal state therefore means equal variables, and a save is a flat map.

## Ren'Py

- **The archive** ([`loadsave.py` L106–124](https://github.com/renpy/renpy/blob/b0f6b16c852b12d829e01b1b4190c299fe488119/renpy/loadsave.py#L106)) is a deflated zip holding `screenshot.png`, `extra_info`, `json`, `renpy_version`, `log` and `signatures`. The state is `log`, a pickle of `(roots, renpy.game.log)` (L172–181).
- **Metadata is kept apart from state.** The `json` member holds `_save_name`, `_renpy_version`, `_version`, `_game_runtime` and `_ctime: time.time()` (L208–222).
- **Saves fall on statement boundaries.** The [docs](https://www.renpy.org/doc/html/save_load_rollback.html) say: "Saves occur at the start of a Ren'Py statement in the outermost interaction context", and "Ren'Py only saves the current statement, and the statement it needs to return to." Only store variables that changed since the game began are saved. Rollback is described as "saving the game at the start of each statement that interacts with the user".
- **Not byte-stable:**
  - `_ctime` is in every save.
  - `ZipFile.writestr` with a name stamps the entry with "the current date and time" ([zipfile docs](https://docs.python.org/3/library/zipfile.html#zipfile.ZipFile.writestr)).
  - Pickled sets iterate in hash order. str/bytes hashes are "salted with an unpredictable random value… not predictable between repeated invocations of Python" ([`PYTHONHASHSEED`](https://docs.python.org/3/using/cmdline.html#cmdoption-R)).

  I didn't find a Ren'Py document that claims or denies byte stability. The points above are inferences from the code and the Python docs.

## Lua persistence: Pluto and Eris

Source: the [Eris README](https://github.com/fnuecke/eris/blob/1566f6cfa027694941fb34229048e9b576aaa8e5/README.md).

- **What it saves:** Eris, Pluto's successor, persists tables, closures and yielded coroutines (L8, L89).
- **The permanents table** stands in for objects the host owns:
  - Any non-basic value found as a key in the table is written as its "permanent key" instead. A load maps it back through an inverse table (L95–100).
  - C functions are persisted only through this table (L91, L159).
  - Userdata needs a `__persist` metafield (L116–142).
  This is NorthTalk's Host Object rule under another name: save the `(kind, id)`, and let the Host resolve it.
- **Byte stability:** `p_table` writes pairs in `lua_next` order ([`eris.c` L909–910](https://github.com/fnuecke/eris/blob/1566f6cfa027694941fb34229048e9b576aaa8e5/src/eris.c#L909)). For that order, the Lua manual says "The order in which the indices are enumerated is not specified, even for numeric indices" ([§6.1 `next`](https://www.lua.org/manual/5.4/manual.html#pdf-next)).
- **Portability:** Eris records `int` and `size_t` sizes in its header and checks them for truncation on read (L148–149). Literal userdata isn't portable across platforms.

## Deterministic games: Factorio and GGPO

**Factorio** runs "deterministic lockstep", and a desync is any disagreement between peers ([wiki](https://wiki.factorio.com/Desynchronization)). It checks for desyncs at three levels:

- **A heuristic CRC every tick:** "an incomplete but very fast check taken every tick" over a few values, such as player states, active entity counts and production statistics ([FFF #55](https://factorio.com/blog/post/fff-55)).
- **A full CRC as a debug mode:** a "full game state CRC check every tick", which is slow and depends on map size (FFF #55).
- **Diffing saves:** in a debug mode the game CRCs the whole map every tick and replays alongside. When the CRCs diverge, the two readable-tagged saves from that tick are diffed, and the difference is "typically just a value of one variable" ([FFF #47](https://www.factorio.com/blog/post/fff-47)).

Desync reports were hard to read, because differences spread before the report was taken. So the server was made to "check the save-load stability locally": save, load, save again and compare. This was aimed at cases where save-load itself changes internal state ([FFF #158](https://www.factorio.com/blog/post/fff-158)). For mods, `on_load` must not change state, or it "will lead to desyncs, breaking both multiplayer and replays" ([data lifecycle](https://lua-api.factorio.com/latest/auxiliary/data-lifecycle.html)).

**GGPO:**

- **The game hashes its own state.** The game's `save_game_state` callback copies the whole state and "Optionally… compute[s] a checksum" ([`ggponet.h` L204–210](https://github.com/pond3r/ggpo/blob/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a/src/include/ggponet.h#L204)).
- **The sync test checks that replay is deterministic.** In `ggpo_start_synctest`, "every frame of execution is run twice… If the checksums of your save states do not match, the test is aborted" (L346–352). [`synctest.cpp` L114–150](https://github.com/pond3r/ggpo/blob/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a/src/lib/ggpo/backends/synctest.cpp#L114) loads the last verified frame, replays, and compares each frame's checksum, logging both states on a mismatch.
- **Peers don't exchange checksums.** The peer-to-peer backend sends none: `p2p.cpp` contains no checksum. The VectorWar sample only shows a Fletcher-32 checksum on screen ([`vectorwar.cpp` L19–25, L140–148](https://github.com/pond3r/ggpo/blob/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a/src/apps/vectorwar/vectorwar.cpp#L140)).

## Emulator savestates: bsnes, libretro and RetroArch netplay, mGBA

**bsnes** ([`serialization.cpp` L1–48](https://github.com/bsnes-emu/bsnes/blob/78474e5d39f58872dc21aca18cf9eb583b147fe7/bsnes/sfc/system/serialization.cpp#L1)):

- **A fixed header comes first:** a signature, the size, a 16-byte serializer version, a 512-byte `description` and a `synchronize` flag. Then comes `serializeAll`, starting with the RNG.
- **Version and size are checked exactly.** A load fails unless they match.
- **Determinism is a flag in the save.** "deterministic serialization (synchronize=false) is only possible with select libco methods"; otherwise the emulator first runs to a safe point (`runToSave`).

**libretro** ([`libretro.h`](https://github.com/libretro/RetroArch/blob/ffbe75195b749022fd16256a49c1e9d2f131e442/libretro-common/include/libretro.h)):

- **The API is an opaque blob:** `retro_serialize_size`, `retro_serialize` and `retro_unserialize` (L9437–9465). The size may not grow during a session.
- **Cores declare their limits as quirks** (L4788–4828):
  - `INCOMPLETE`: the state "should not be relied upon for… netplay or rerecording"
  - `SINGLE_SESSION`
  - `ENDIAN_DEPENDENT` and `PLATFORM_DEPENDENT`
- **Savestate contexts** (L7285–7332) separate a disk save from same-instance runahead (where pointers are allowed) and from rollback netplay. For netplay, the state "should omit any data that would unnecessarily increase bandwidth usage".

**RetroArch netplay** ([`netplay_frontend.c`](https://github.com/libretro/RetroArch/blob/ffbe75195b749022fd16256a49c1e9d2f131e442/network/netplay/netplay_frontend.c)):

- **The host sends a CRC32 every `check_frames` frames.** It hashes only the core memory region of its savestate container, not the container's header (L2678–2694).
- **Lockstep mode prefers system RAM.** It hashes system RAM when the core exposes it, because that "leaves out bookkeeping that may differ between peers" (L2785–2830).
- **It detects cores whose serialisation isn't deterministic.** If CRCs differ right after the client loaded the host's state, desync checks are switched off for that core. A later mismatch requests the host's state (L3900–3935).

**mGBA:**

- **The state struct starts with an identity:** a version magic, the BIOS checksum, the ROM CRC32 and the game title and code ([`gba/serialize.h` L23–28](https://github.com/mgba-emu/mgba/blob/65db8569b50d02412274ddd1f1520dbe8f3edff5/include/mgba/internal/gba/serialize.h#L23)).
- **Metadata goes in separate "extdata" items** ([`core/serialize.h`](https://github.com/mgba-emu/mgba/blob/65db8569b50d02412274ddd1f1520dbe8f3edff5/include/mgba/core/serialize.h)): screenshot, save data, cheats, RTC, `META_TIME` and `META_CREATOR`. Each is opt-in by flag.
- **In the PNG form, state and extdata are separate chunks.** The state is a zlib-compressed `gbAs` chunk, and each extdata item is its own `gbAx` chunk ([`serialize.c` L156–202](https://github.com/mgba-emu/mgba/blob/65db8569b50d02412274ddd1f1520dbe8f3edff5/src/core/serialize.c#L156)). The creation time, from `gettimeofday`, is only ever in extdata (L388–428).

## Other techniques

- **Canonical CBOR** ([RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1)):
  - Shortest ("preferred") encodings.
  - No indefinite lengths.
  - Map keys sorted "in the bytewise lexicographic order of their deterministic encodings".
  - §4.2.2 leaves some choices to the application: integer versus float, negative zero, NaN, and so on.
- **JCS** ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)): object properties "MUST be sorted recursively", array order is kept, and numbers use ECMAScript formatting.
- **Protobuf:** "Protobuf serialization is not (and cannot be) canonical", hashes of serialised messages "are fragile and not stable across time or space", and "when you need to fingerprint a message, we recommend writing out the fingerprinting function yourself" ([protobuf.dev](https://protobuf.dev/programming-guides/serialization-not-canonical/)).
- **Content addressing:** Git hashes `type size\0content`. A tree entry is the hash of a blob or subtree, so an unchanged subtree keeps its hash and is shared, not copied ([Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)). A State Fingerprint built as a hash of per-part hashes would show *which* part differs.
- **Incremental hashing:** Bellare and Micciancio give collision-free hashes that update "in time proportional to the size of the change" ([ePrint 1997/001](https://eprint.iacr.org/1997/001)). This is relevant only if a fingerprint is ever needed every frame.

## How NorthTalk compares

| | NorthTalk today | Nearest precedent |
|---|---|---|
| Identity in the save | magic `NTZS`, format version, language version, Cost Model version, Group Fingerprint ([`snapshot.zig` L982–987](../../impl/zig/src/machine/snapshot.zig)); `family`, `format`, `language`, `costModel` and `fingerprint` in TS ([`group-snapshot.ts`](../../impl/ts/src/group-snapshot.ts)) | Quetzal `IFhd`, mGBA ROM CRC, bsnes version string |
| Version policy | reads exactly one format (Zig 17, TS 11) ([chapter 10](../../spec/10-save-and-restore.md#restoring)) | bsnes (exact); ink accepts a range (8–10) |
| Wall-clock time in the save | none; `lastClock` is the Host-supplied Clock | Quetzal and ink (none); Ren'Py, SugarCube and mGBA keep it as metadata |
| RNG | `random_state` saved ([chapter 10](../../spec/10-save-and-restore.md#what-a-save-holds)) | ink seed and previous draw; SugarCube seed and pull count; Glulx doesn't save it |
| Counter that varies between saves | Trace save id, written after the Group Fingerprint ([`snapshot.zig` L988](../../impl/zig/src/machine/snapshot.zig)), and `id: "sN"` in TS ([`group.ts` ~L990](../../impl/ts/src/group.ts)) | none in the others; it is NorthTalk-specific |
| Equality test | State Fingerprint: SHA-256 over the save with the counter and integrity digest spliced out (Zig, [`snapshot.zig` L938–969](../../impl/zig/src/machine/snapshot.zig)); SHA-256 of the JSON payload without `id`, `sourceMode` and `sources` (TS, [`group-snapshot.ts` L65–93](../../impl/ts/src/group-snapshot.ts)) | RetroArch hashes only core memory; GGPO and Factorio hash the state |
| Live fingerprint cost | builds a whole save in memory, then hashes it ([`snapshot.zig` L963–969](../../impl/zig/src/machine/snapshot.zig); [`group.ts` L1012–1018](../../impl/ts/src/group.ts)) | Factorio's heuristic CRC is cheap, and its full CRC is debug-only |
| Save-load stability check | corpus replays a save and restore between Pumps and compares execution output ([chapter 10](../../spec/10-save-and-restore.md#the-rule)); fingerprints are checked only in unit tests ([`snapshot.zig` L3382–3418](../../impl/zig/src/machine/snapshot.zig), [`state-fingerprint.test.ts`](../../impl/ts/tests/state-fingerprint.test.ts)) | Factorio save, load, save and compare; GGPO sync test |
| Explaining a difference | none | Factorio save diff; GGPO `LogSaveStates`; Eris `path` |
| Host-owned objects | `(kind, id, parent, disposed)`, resolved on restore | Eris and Pluto permanents table |

### The Zig save's hash maps

The Zig save writes `open_broadcasts` and `root_discards` by iterating `std.AutoHashMapUnmanaged` ([`snapshot.zig` L1125–1163](../../impl/zig/src/machine/snapshot.zig); declared in [`machine.zig` L1563, L1688](../../impl/zig/src/machine/machine.zig)). A restore rebuilds them with `put` in the saved order (`snapshot.zig` L2522, L2548). Zig's hash map iterates in slot order, and slot order depends on the map's capacity and its history of inserts and removals. `open_broadcasts` loses entries through `fetchRemove` ([`machine.zig` L5471](../../impl/zig/src/machine/machine.zig)).

**What I checked:** a standalone Zig 0.17.0 program put keys 0–39 in such a map, removed 0–36, and copied the result into a fresh map. The original iterated `39 38 37`; the copy iterated `39 37 38`.

So whenever two or more Broadcast Decisions are open, or two or more roots have discarded messages, a restored Group can save different bytes from the original. Its State Fingerprint can differ too. That would break chapter 10's guarantee that "a save, its restore and a save of that restore" give the same fingerprint, and ADR 0008's "same complete Group state … gives the same bytes".

I showed the mechanism but didn't reproduce it end to end through a NorthTalk Group. The existing fingerprint test uses `busyGroup` and doesn't cover these maps. The TS Core uses JS `Map`s and objects, which keep insertion order, and a restore re-inserts in saved order. So TS doesn't have this problem.

## Recommendations, ranked

1. **Fix the Zig save's map ordering.**
   - **Change:** write `open_broadcasts` and `root_discards` sorted by key (`sorting.stable` is already imported), or store them as `std.AutoArrayHashMapUnmanaged`, as `changed_roots` already is. Then check the rest of `save` for any other hash-map iteration.
   - **Why:** it is a real hole in ADR 0142's guarantee and in chapter 10's byte-determinism rule, and it is the failure every other system ran into.
   - **Trade-off:** sorting a few small maps on each save costs very little. If the save layout stays the same, no format version bump is needed: sorted output is still valid input. A failing test written first would make the fix safe.

2. **Check fingerprint stability in the corpus save and restore replay.**
   - **Change:** at each Pump boundary where the replay already saves and restores, also assert these are all equal:
     - `liveStateFingerprint(original)`
     - `stateFingerprint(save)`
     - `liveStateFingerprint(restored)`
     - the fingerprint of a second save of the restored Group

     Do this in both Cores' corpus runners ([`impl/zig/src/corpus/main.zig` L197](../../impl/zig/src/corpus/main.zig)).
   - **Why:** this is Factorio's save-load stability check and GGPO's sync test, run over every case, and it would have caught recommendation 1.
   - **Trade-off:** each replay boundary costs one or two more saves, so the corpus runs slower. It checks only one Core family at a time, which is all ADR 0142 promises.

3. **Add a tool that says why two saves differ.**
   - **Change:** a tooling-only `save diff`, or a debug decoder in each Core, that decodes two saves of one Core family and reports the first differing part. It would give a path, such as `script "a" / variable 2` or `run r3 / frame 1 / operand 0`, or `counter deliveries`.
   - **Why:** a hash only shows that two saves differ. Mercenary's `comparable()` blanks the whole Group because it has no way to see what differs. Factorio fixes desyncs by diffing readable saves, GGPO logs both states, and Eris records value paths.
   - **Trade-off:** the Zig format is binary, so this needs a decoder that dumps it. Keep it outside parity and out of the Embedding API, as the save bytes already are.

4. **Build the fingerprint from per-part hashes.**
   - **Change:** compute the fingerprint as SHA-256 over a fixed list of sub-digests: Group counters, the input queue, each Script's variables, each Script's Runs, Host Objects, and so on. Optionally expose the sub-digests through tooling.
   - **Why:** a differing sub-digest shows where two states diverge without decoding either save, as Git does with tree hashes. It also makes a later cheap or incremental fingerprint possible.
   - **Trade-off:** the fingerprint's bytes change, which is allowed: they are outside parity, but changing them breaks any fingerprints a Host has stored. In Zig, which hashes the save bytes directly, this means a second walk over the state or section markers in the format. Do recommendation 3 first. This one matters only if the diff tool proves too slow or too coarse.

5. **Store the fingerprint in the save header.**
   - **Change:** in the next format bump, move the save id counter into the header (next to magic and version) and write the State Fingerprint there. The body digest is then the fingerprint, and the integrity digest covers the header and body.
   - **Why:** `core.stateFingerprint(save)` would verify a digest and read 32 bytes, rather than splicing (Zig) or fully decoding (TS calls `decodeGroup`, [`group-snapshot.ts` L72–83](../../impl/ts/src/group-snapshot.ts)). It also matches the precedents: a fixed identity header before the body (Quetzal `IFhd`, bsnes), and metadata kept out of the hashed body (mGBA `gbAs`/`gbAx`, RetroArch hashing core memory only).
   - **Trade-off:** it needs a format bump in Zig (17 → 18) and TS (11 → 12), refreshing the Go adapter's embedded reactor, and re-pinning the Elixir reactor. It is worth doing only alongside another format change.

6. **Document what "same state" means.**
   - **Change:** state in chapter 10 that the fingerprint covers all counters (delivery, run, call and Broadcast ids, `run_order`, `charge_counter`), the last Clock reading, and the order of lists such as Host Objects.
   - **Why:**
     - Two sessions with equal variables but a different history (one extra no-op Delivery, or Host Objects created in a different order) get different fingerprints. Mercenary's cases (a restore, a replay, two restores of one Save) share history, so they're fine. A Host that compares two independently played sessions would be surprised.
     - ink, Yarn and SugarCube compare variables, visit counts and seeds only. Factorio's heuristic CRC deliberately checks a cheap subset.
   - **Trade-off:** documentation only. A coarser "observable state" fingerprint (variables and Runs, without counters) would be a separate, opt-in API. Don't add one until a Host asks for it.

7. **Keep the current shape on three points.**
   - **No timestamps.** Keep wall-clock time and Host metadata out of the save, as Quetzal and ink do. If Hosts want titles, screenshots or dates, document that these go beside the save, as Ren'Py's `json` member, SugarCube's `info` and mGBA's extdata do. They must not go inside the save.
   - **The Trace save id stays.** ADR 0142's reason to keep it still holds. In the other systems, "consecutive saves differ" comes only from metadata, never from state. NorthTalk's counter is real state (Trace ids), as a frame counter is in an emulator, so excluding it from the fingerprint rather than from the save is right.
   - **No cross-Core fingerprint.** Protobuf's warning and RFC 8949 §4.2.2's list of choices left to the application show how much a normative canonical encoding would cost. ADR 0142 already turned this down.

8. **Save size (low priority).**
   - **Change:** if save size ever matters, encode Script Variables as a diff against their initial values, which code identity already pins down.
   - **Why:** this follows Quetzal's XOR against the story file, ink's `dontSaveDefaultValues` and SugarCube's moment deltas.
   - **Trade-off:** it adds work to restore and a format bump, and it doesn't help determinism. Do nothing until a Host reports large saves.

## Not verified

- The Zig hash-map hazard is shown through std behaviour, not with a NorthTalk Group that saves different bytes after a restore. Recommendation 1 should start with that failing test.
- No primary source for Pluto itself: its permanents table is described through Eris's README ("Like Pluto…").
- Factorio's checks are documented only in Friday Facts posts from 2014 to 2016. Current builds may differ.
- I found no Ren'Py document on byte stability; the conclusion is inferred from the code and the Python docs.
- Yarn's "no mid-node resume" is from the 3.1 FAQ, which says jumping to a line "is currently not supported". Later releases weren't checked.
- I didn't look at higan, BizHawk or TASVideos movie formats. TAS sync is covered here only through RetroArch's netplay CRCs and GGPO's sync test.

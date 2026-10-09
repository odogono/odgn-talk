# Fix and Continue is a Session Command

A session does Fix and Continue with the Session Command `:fix <run>`, followed by the declarations that change, which a Transcript records as `|` lines, as it records `:library`'s source. It is one `RewindRun` of the Run, then one Reload of the session source with those declarations in place, carrying Script Variables and keeping the mailbox, then a Pump. The Playground's Apply becomes Fix and Continue while the debugger is paused in a Run that can be rewound, and enters `:fix`. We chose a command over a Fix and Continue made only by tooling because the REPL and the Playground share it through the Session Host, and the Transcript records what was done. It takes its declarations with it because a redefinition entered after a Rewind would Reload without the mailbox, and drop the message the Rewind put back. Settled in #444.

- **Between Pumps** it rewinds a Run that is parked, and both REPLs replay it. A REPL pumps after every Entry, so a parked Run is the one Run there still in its first Segment.
- **At a debugger pause** the Rewind lands at the paused instruction, through the TS Core's tooling hooks ([ADR 0068](0068-a-run-in-its-first-segment-can-be-rewound-to-its-delivery.md)). A Transcript's replay can't land an input there, so the Session Transcript stops before the Host call whose Pump was paused, and nothing after it is Transcript. The Trace records the `rewind-run` with its `pc`, so replay debugging still shows it. A paused Run is often an Entry's, whose implicit Handler isn't in the session source, so the Reload loads it after the session source.
- **Refusals before the Rewind:** a syntax error, anything but declarations, or a Run the session doesn't have. A Rewind that lands on a Run past a Suspension Point does nothing, and `:fix` prints `! not rewindable` and reloads nothing.
- **A Reload that fails** after the Rewind prints its diagnostics and leaves the session source as it was, so the message runs again on the unchanged code. Neither Core can check a Reload's source without making it, and adding that check to both was more than a REPL needed.

## Considered Options

- **A tooling-only Session Host method:** pausing is TS tooling, but between Pumps a Rewind is ordinary, and a command records it, so a Transcript still replays.
- **`:rewind <run>`, then redefinitions that keep the mailbox while a rewound message waits:** a redefinition's meaning would depend on state the user can't see.
- **A Transcript form that lands the Rewind at a recorded Fuel count:** both REPLs would need to land an input mid-Pump, which ADR 0068 rejected for the Core.
- **Checking the source before the Rewind,** with a new call in both Cores, or by loading it into a scratch Group: the call adds embedding surface, and a scratch Group could accept what Reload refuses.

## Consequences

- **Output:** `:fix` prints `! rewound <run>` when the Rewind lands, then each Run the Reload discarded, then what the Pump prints.
- **The Playground** checks the Script tab's declarations parse before it offers Fix and Continue, lists the effects that will happen again, and asks for confirmation. A Shared Link or download after a Fix at a pause carries the Transcript up to that point.
- **`script variable x = e`** in `:fix` changes the initialiser in the session source, and the value carries, with no `put`.

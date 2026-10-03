# The Playground's Script tab is the session source

A Playground session still takes only Entries and Session Commands, like a REPL's ([ADR 0014](0014-a-session-is-an-ordinary-host.md)), but its user edits a whole Script in a tab. The Script tab is kept in sync with the session source both ways. A declaration entered at the prompt appears in the tab, and **Apply** compares the tab's top-level declarations with the session source's and enters each new or changed one as an Entry. So a redefinition causes the Spec's Reload, with its Script Variables carried over, and the Session Transcript stays a plain list of Entries that the Go REPL can replay. An Entry can't remove a declaration, so when the tab drops one, Apply offers a **Restart**. A Restart makes a fresh session: it replays the session's `:grant` and `:mock` commands, its virtual Clock and its tightened limits, adds each Library tab with `:library add`, and applies the Script tab. We chose this over a new Session Command because the Transcript is normative and a Corpus case kind: a command that replaced the whole source would be a language change both Cores must match, only to serve one Host's editor. Settled in #140.

## Considered Options

- **A Restart on every run:** simple, but every edit would lose the session's Runs and Script Variables, which a REPL keeps.
- **A read-only tab, as an `:export` view:** the session would be built only at the prompt, and the Playground couldn't edit a Script as a file.
- **A `:source` Session Command replacing the whole session source:** it changes the normative Transcript format, and needs a Corpus case and the Go REPL to match.

## Consequences

- **Order:** Apply enters declarations in the tab's order, retrying one that doesn't load while others still do, so a declaration may use one later in the tab. Moving a declaration within the tab changes nothing in the session.
- **Unapplied edits:** a declaration entered at the prompt replaces a clean tab's text. A tab with unapplied edits keeps them, and the next Apply compares against the session as it then is.
- **Library tabs:** the first save is `:library add` and later ones `:library replace`, each with the Library's source inline. Renaming or closing a Library tab needs a Restart to take it out of the session.
- **A Restart is not recorded:** it starts a new Session Transcript, and a Shared Link carries only the current session's.
- **Debugging:** breakpoints in the Script tab map through each declaration to the code unit it was loaded in, and a pause holds the Session Host mid-Pump, through the TS Core's tooling hook. The pause isn't a Host Input, so the Transcript and the Trace are as they would be without it.

## Fresh execution alongside live Apply

The workbench also offers **Run fresh** with a visible launch Entry. It prepares and validates the current tabs in a new session before replacing the old one, then enters the launch Entry. A failed load leaves the old session available; a fault in the launch Entry belongs to the successfully loaded new session. **Evaluate** enters that same Entry against the live session without applying edits. This revisits the rejected restart-on-every-run interface by offering fresh execution explicitly alongside Apply, rather than removing state-preserving experimentation. Neither action adds a Session Command or changes the Transcript format.

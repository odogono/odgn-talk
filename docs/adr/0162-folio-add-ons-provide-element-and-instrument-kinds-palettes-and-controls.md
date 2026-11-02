---
status: accepted
---

# Folio Add-ons provide Element and Instrument kinds, shown in Palettes and driven by controls

Folio's Element kinds and Instrument kinds are built into its main bundle, so every kind costs every visitor, and the music work in [#1887](https://github.com/odogono/odgn-talk/issues/1887) needs kinds, such as knobs, sliders and pads, that most Projects never use and that need not be part of Folio at all. We decided that an **Add-on** provides Element kinds or Instrument kinds, that a Project's `.folio` file may carry the Add-ons it uses, and that the built-in kinds are described the same way.

## Add-ons

Add-ons are written in TS and Preact, and come in two forms:

- A **built-in Add-on** is built in this repo as a separate chunk, fetched the first time a Project or author needs it, and cached at runtime by the service worker so that it works offline afterwards, the same way ADR 0161 caches Music. The `.folio` file records it with its version.
- A **Project Add-on** is carried in the `.folio` file itself, as code and a content hash, and is loaded when the Project opens. Folio's core code holds no definition for its kinds.

Behaviour in a Project still comes from NorthTalk Scripts that handle the messages a kind sends. An Add-on defines what a kind is, how it draws and what it sends.

One Element kind definition serves built-in kinds and both forms of Add-on. It declares:

- the kind's properties, with their shapes and defaults;
- how the kind draws;
- its Info controls;
- the messages it sends;
- its Manifest documentation;
- file validation and migrations for its data;
- the parameters its properties can bind to;
- the Play State it carries between the worker and the page.

Instrument kinds use the same mechanism. An Instrument kind's code may come from an Add-on, but the sounds it plays are the Project's own (ADR 0161). A new Project copies its Base Project's Project Add-ons and Palettes along with its sounds, so it never depends on the Base Project.

## Naming

An Add-on is named by a URL, such as `https://northtalk.org/add-ons/music-controls`, whose page describes the Add-on, its versions and its kinds. An Element kind from it is that URL, `#` and the kind's name, such as `…/music-controls#knob`, so each Element names its Add-on, a placeholder can link to the page, and two Add-ons' kinds can't clash. The version is kept once, in the `.folio` file's Add-on list, not in the URL. Folio ships one version of each built-in Add-on and loads it for any Project that lists the same or an older version, whose Elements its kinds' checks migrate; the Project is then saved at the loaded version. A Project that needs a newer version keeps placeholders.

Scripts see each loaded kind as an Object Kind named by the kind's name, such as `knob`, so an Add-on can't load a kind whose name a built-in kind or another loaded Add-on already has.

The URL is an identity, never a download location: Folio never fetches code from it, and it grants no trust. An unsigned Project Add-on that claims a `northtalk.org` URL still gets the trust prompt.

## Trust

A Project Add-on runs in the page with Folio's privileges, so Folio asks before running one. When a Project with Project Add-ons opens, Folio names them and asks the reader to trust them. Folio remembers the answer by content hash, so a changed Add-on asks again.

A Project Add-on may carry a signature over its content hash. Folio ships one NorthTalk public key, an Ed25519 key that it checks with WebCrypto, and runs an Add-on whose signature verifies against that key without asking, wherever the file came from. Our release tooling signs the Project Add-ons in the Base Projects and Example Projects we publish. Built-in Add-ons are part of Folio and are always trusted. If the NorthTalk key leaks, a new Folio release ships a new key, and the old signatures stop verifying.

When an Add-on is not trusted or can't load, the Project still opens: its Elements show as placeholders whose box, name and Owning Script can still be edited, the rest of their data is saved back unchanged, and the Errors window names the missing Add-on during Play, where a Script that uses one fails. Trusting it later loads it without reopening the Project.

## Palettes

A **Palette** is authored like a Page and shown in its own floating window during Browse and Present. Its Scripts run until Stop, across Page changes. A Palette opens from the Window menu, by its "open when Play starts" setting, or when a Script sends it `show`.

## Controls

A control is an Element kind with a `value` property that sends `change value` when the reader changes it. In Info, a control can bind its value straight to an Instrument parameter or to the tempo. The binding is applied on the audio side, so it needs no Script and does not wait on the worker.

## Considered Options

- **First-party Add-ons only.** Rejected because every new kind would have to ship with Folio, and an author could not share a Project that brings its own kinds.
- **Kinds defined in NorthTalk and drawn through the canvas Grant.** Rejected because drawing and pointer handling through the worker are too limited and too slow for controls, though it needs no new trust.
- **Trust `.folio` files served from northtalk.org.** Rejected because the trust is lost once the file is saved and reopened from disk, and anything served from that origin, by mistake or by an attacker, would run without asking. A signature travels with the file.
- **Let any author sign Add-ons.** Deferred, because it needs key registration, a way to show who signed, and revocation. Until then, an Add-on signed by anyone else gets the trust prompt.
- **Run Project Add-ons in a sandboxed cross-origin iframe.** Deferred, because it needs a message protocol, sizing, focus and theming across the boundary, and an audio-side binding API. It can later replace the trust prompt for untrusted origins.
- **Keep every kind in the main bundle.** Rejected because the bundle and precache would grow with every music kind, which ADR 0161 avoided for sounds.
- **Separate definitions for built-in and Add-on kinds.** Rejected because two definitions would drift, and moving a kind into or out of an Add-on would change its behaviour.
- **Bind controls only through Scripts.** Rejected because a knob turned during Play would wait on the worker before the sound changed.

## Consequences

A trusted Project Add-on can do anything Folio can, including reading other Projects in browser storage, so the prompt must say so plainly, and we sign only Add-ons we have reviewed. The NorthTalk private key lives in the release secrets, and the release tooling gains a signing step. Built-in kinds move onto the shared Element kind definition. The `.folio` format gains an Add-on list holding references and embedded code with optional signatures, and placeholders must round-trip unknown Element data byte for byte. Shared Links stay asset-free, so a Project with Project Add-ons is shared as a `.folio` file. A Project opened offline that uses a built-in Add-on never fetched online shows that Add-on's Elements as placeholders until Folio is online again.

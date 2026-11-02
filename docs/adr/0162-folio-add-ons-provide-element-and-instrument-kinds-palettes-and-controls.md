---
status: accepted
---

# Folio Add-ons provide Element and Instrument kinds, shown in Palettes and driven by controls

Folio's Element kinds and Instrument kinds are built into its main bundle, so every kind costs every visitor, and the music work in [#1887](https://github.com/odogono/odgn-talk/issues/1887) needs kinds, such as knobs, sliders and pads, that most Projects never use. We decided that an **Add-on**, a separately loaded part of Folio, provides Element kinds or Instrument kinds, and that the built-in kinds are described the same way.

## Add-ons

Add-ons are first-party only. They are built in this repo as separate chunks, fetched the first time a Project or author needs them, and cached at runtime by the service worker so that they work offline afterwards, the same way ADR 0161 caches Music. Add-ons are written in TS and Preact. Behaviour in a Project still comes from NorthTalk Scripts that handle the messages a kind sends, never from Add-on code the author writes.

One Element kind definition serves Add-on kinds and built-in kinds alike. It declares:

- the kind's properties, with their shapes and defaults;
- how the kind draws;
- its Info controls;
- the messages it sends;
- its Manifest documentation;
- file validation and migrations for its data;
- the parameters its properties can bind to;
- the Play State it carries between the worker and the page.

Instrument kinds use the same mechanism. An Instrument kind's code may come from an Add-on, but the sounds it plays are the Project's own (ADR 0161). Base Projects bring Add-on references and Palettes along with their sounds.

The `.folio` file records each Add-on it uses, with its version. When an Add-on can't load, the Project still opens: its Elements show as placeholders that cannot be edited, their data is saved back unchanged, and a Script that uses one gets a clear error during Play.

## Palettes

A **Palette** is authored like a Page and shown in its own floating window during Browse and Present. Its Scripts run until Stop, across Page changes. A Palette opens from the Window menu, by its "open when Play starts" setting, or when a Script sends it `show`.

## Controls

A control is an Element kind with a `value` property that sends `change value` when the reader changes it. In Info, a control can bind its value straight to an Instrument parameter or to the tempo. The binding is applied on the audio side, so it needs no Script and does not wait on the worker.

## Considered Options

- **Third-party Add-ons.** Deferred, because Add-on code runs with the page's privileges and would need a sandbox and a trust model first.
- **Keep every kind in the main bundle.** Rejected because the bundle and precache would grow with every music kind, which ADR 0161 avoided for sounds.
- **Separate definitions for built-in and Add-on kinds.** Rejected because two definitions would drift, and moving a kind into or out of an Add-on would change its behaviour.
- **Bind controls only through Scripts.** Rejected because a knob turned during Play would wait on the worker before the sound changed.

## Consequences

Built-in kinds move onto the shared Element kind definition. The `.folio` format gains an Add-on list, and placeholders must round-trip unknown Element data byte for byte. A Project opened offline that uses an Add-on never fetched online shows that Add-on's Elements as placeholders until Folio is online again.

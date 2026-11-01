---
status: accepted
---

# Folio plays Instruments on one Transport

Folio's `sound` Grant plays a named sound through one `<audio>` element per voice ([ADR 0084](0084-creative-tool-scripts-reach-elements-through-load-time-names-properties-and-three-grants.md)). It has no pitch, gain, synthesis or musical time. To live-code music ([#1887](https://github.com/odogono/odgn-talk/issues/1887)), a Project gains Instruments and a Play Session gains a Transport.

```talk
set the cutoff of bass to 800
tell transport to set tempo to 96
ask transport to beats 2              -- an exact duration for two beats
wait it
```

**Instruments**

- An Instrument is authored in the Project and edited in Info. Scripts reach it by name, as they reach Elements: a misspelt name is a load error.
- Scripts change an Instrument's parameters but never create or delete one.
- Each Instrument kind declares its own Operations and parameters, which the Host Manifest lists so the editor completes and checks them.
- The first kinds are a sampler, a YM2149 sound chip and a basic synth. Notes are MIDI numbers or note names such as `c3` and `f#4`.
- Instruments are saved in the `.folio` file. Each one has caps on its voices, and so does the Play Session.

**The Transport**

- One Transport per Play Session holds the tempo, time signature, bar and beat. It defaults to 120 bpm in 4/4.
- A `transport` Grant, which every Script receives, sets the tempo and time signature and starts and stops the Transport.
- `wait` needs an exact duration, so a Transport Operation converts beats into one. A `beat` Unit in the language comes later.
- The Transport runs on the Play clock, which follows the audio clock ([ADR 0156](0156-folios-play-clock-follows-the-audio-clock.md)). `beat` reaches the Scripts that handle it one lead ahead of its time.

**Built-in kits**

- Folio ships sample kits with CC0 or similarly clear licences. A Sound Pattern played without `on` plays the default kit.
- Engines copied from other projects ship without those projects' sound assets.

This amends ADR 0084. Scripts get Instrument names and the `transport` Grant beside `pages`, `elements` and `sound`, and `sound` plays through the Instruments.

## Considered Options

- **Instruments created by Scripts:** a Project's sound would only exist while its code runs. Info couldn't show or edit it, and the editor couldn't check names.
- **One Operation set for every Instrument kind:** a chip's registers and a synth's filter have little in common, so a shared set would either be tiny or full of Operations most kinds ignore.
- **A Transport per Script:** Scripts would drift apart, and a Sound Pattern's bar would mean different things to different Scripts.
- **Beats as `wait` arguments:** `wait` takes an exact duration, and a duration in beats changes meaning when the tempo changes.

## Consequences

- Instrument kinds are built through one registry entry each, so they can later become Add-ons.
- Renaming an Instrument breaks the Scripts that use it, as renaming an Element does.
- The tempo can change mid-bar. Durations already converted keep their length.

---
status: accepted
---

# Folio Projects carry their own sounds and start from a Base Project

ADR 0158 gave Folio built-in kits that every Project could play by name. The service worker precached them for every visitor, so opening a Project without Instruments still downloaded every kit ([#1933](https://github.com/odogono/odgn-talk/issues/1933)), and a Project's sound depended on whichever kits the running Folio shipped. We decided that a Project's `.folio` file holds every sound it plays, and that Folio has no global kits.

A new Project starts as a copy of a Base Project that ships with Folio: **Blank**, with no sounds, or **Music**, which brings the default sounds, the Instrument Add-on references and the music Palettes. The copy records which Base Project and version it came from. That record supports offers to update and attribution only, and Folio never loads anything from it. Example Projects are complete, checked-in `.folio` files that carry their own sounds. Shared Links stay asset-free, so a Project with sounds is shared as a `.folio` file.

A Script that plays a sound name the Project lacks gets an error during Play. In Edit, Browse and Punch In, a quick fix copies that sound from Music into the Project. When a Project saved before this decision opens, a migration adds the kit sounds its patterns name and records Music as its base. A Project whose patterns name no kit sounds records Blank.

Folio precaches only itself and Blank. Music and the Example Projects are fetched the first time they are opened, then cached at runtime, the same way [#1901](https://github.com/odogono/odgn-talk/issues/1901) caches Add-ons. Starting a Music Project offline therefore needs Music to have been opened online once, and Folio says so and offers Blank. A `.folio` file always opens offline.

Add-ons ([#1899](https://github.com/odogono/odgn-talk/issues/1899)) remain code that a Project references by version. An Instrument kind's code may come from an Add-on, but the sounds it plays come from the Project.

## Considered Options

- **Download each kit the first time a Project needs it.** Rejected because sound names built at run time are not known at load, and a Project opened offline could be missing its sounds.
- **Have a Project reference a kit by version.** Rejected because it makes a file depend on Folio, which is what Add-ons do for code and what we avoid for content.
- **Generate kit sounds in the browser from `synth.ts`.** Rejected as the source of truth, because the output would change whenever the synth code changed. `synth.ts` stays as the tool that regenerates Music's sounds, and a test checks the checked-in sounds against it.

## Consequences

The build no longer writes `kits/`, and `kitPrecacheFiles` and `KIT_BUDGET_BYTES` are removed. Each Base Project and Example Project has its own size budget. Music and First Sounds both hold copies of the same sound bytes.

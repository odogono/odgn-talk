# Folio's Play browses in place, and Present is a Project action

Folio's Play button always Browses: the Play Session runs in place, on the Page being edited, with the authoring windows and Palettes left where they are. Present, which shows the Project full-window as a reader would see it, is chosen explicitly from the Project menu (⌘⇧↩) and is never what Play does. Perform, the separate live-coding layout with a code pane and docked Palettes (#1905), is removed. Its Hush, Revert and tempo/bar clock join Browse's play controls. Its code tabs and zoom are dropped, because the Code Browser already does that job. The Project's `play` setting and a Palette's `floatInPerform` setting are no longer used. Files that carry them still load, and the values are ignored, so the file format does not change. The Music base Project stops setting `play`.

We chose this because pressing Play to hear music should not rearrange the workspace. Live-coding is Browse with the windows the author already arranged, and a separate Perform layout duplicated the Code Browser and Palettes for little gain. Making Present explicit also removes the per-Project choice of what Play means, so Play behaves the same in every Project.

This supersedes the Perform parts of ADR 0167: the Instruments window stays open as an ordinary window during Browse rather than docking in Perform.

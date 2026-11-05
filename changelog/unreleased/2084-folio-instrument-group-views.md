---
type: feat
scope: tools
---

Draw the synth's envelope and filter in Folio's Instruments window. The Envelope group shows its ADSR shape, whose corners drag attack, decay with sustain, and release; the Filter group shows the low-pass response, whose handle drags cutoff and resonance. An Instrument kind declares these pictures with an optional `views`, naming which parameter plays each part; kinds without it are unchanged (#2084).

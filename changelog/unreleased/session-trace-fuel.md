---
type: feat
---
Both Session Hosts add `:trace` and `:untrace`, which print `trace start` and `trace end` rows for dispatched Runs whose Selector is traced, and `:fuel`, which measures the exact Fuel of an Entry and everything it spawns. A measurement stays pending while any of that work is live or queued. Saves keep filters and measurements, and `:restore` reports pending measurements it abandons. The REPLs and the Playground accept a multiline `:fuel` Entry. Part of #370.

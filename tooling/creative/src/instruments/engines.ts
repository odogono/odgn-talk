// Folio's own Instrument engine, without Operations or the Core, for the
// audio thread (#1894); Add-ons add theirs (#1901).
import type { InstrumentEngine } from './kind';
import { samplerEngine } from './sampler';

export const INSTRUMENT_ENGINES: ReadonlyMap<string, InstrumentEngine> =
  new Map([samplerEngine].map(engine => [engine.name, engine]));

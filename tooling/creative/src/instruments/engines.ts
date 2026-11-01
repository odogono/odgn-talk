// Every Instrument engine, without Operations or the Core, for the audio
// thread (#1894).
import type { InstrumentEngine } from './kind';
import { samplerEngine } from './sampler';
import { synthEngine } from './synth';
import { ym2149Engine } from './ym2149';

export const INSTRUMENT_ENGINES: ReadonlyMap<string, InstrumentEngine> =
  new Map(
    [samplerEngine, ym2149Engine, synthEngine].map(engine => [
      engine.name,
      engine,
    ]),
  );

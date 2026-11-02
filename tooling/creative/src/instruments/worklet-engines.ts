// Engines Add-ons add to the audio worklet (#1901). Each Add-on's worklet
// module is added separately but shares the worklet's global scope, so
// they meet in one table there.
import type { InstrumentEngine } from './kind';

const KEY = '__folioInstrumentEngines';

const table = (): Map<string, InstrumentEngine> => {
  const scope = globalThis as unknown as Record<
    string,
    Map<string, InstrumentEngine> | undefined
  >;
  return (scope[KEY] ??= new Map());
};

export const registerWorkletEngine = (
  kind: string,
  engine: InstrumentEngine,
): void => {
  table().set(kind, engine);
};

export const workletEngine = (kind: string): InstrumentEngine | undefined =>
  table().get(kind);

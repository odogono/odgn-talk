// Format 9 to 10 (#1901): the synth and YM2149 Instrument kinds moved from
// Folio into the built-in Instruments Add-on, so a Project names them by
// the Add-on's URL and lists the Add-on.
import {
  INSTRUMENTS_ADD_ON,
  INSTRUMENTS_VERSION,
  SYNTH_KIND,
  YM2149_KIND,
} from './ids';

type Obj = Record<string, unknown>;

const MOVED: Readonly<Record<string, string>> = {
  synth: SYNTH_KIND,
  ym2149: YM2149_KIND,
};

export const migrateInstrumentKinds = (data: Obj): Obj => {
  if (!Array.isArray(data.instruments)) {
    return { ...data };
  }
  let moved = false;
  const instruments = (data.instruments as unknown[]).map(raw => {
    const instrument = raw as Obj | null;
    const kind =
      typeof instrument?.kind === 'string' ? MOVED[instrument.kind] : undefined;
    if (!kind) {
      return raw;
    }
    moved = true;
    return { ...instrument, kind };
  });
  if (!moved) {
    return { ...data };
  }
  const addOns = Array.isArray(data.addOns) ? (data.addOns as Obj[]) : [];
  return {
    ...data,
    instruments,
    addOns: addOns.some(a => a?.id === INSTRUMENTS_ADD_ON)
      ? addOns
      : [...addOns, { id: INSTRUMENTS_ADD_ON, version: INSTRUMENTS_VERSION }],
  };
};

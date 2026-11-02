// The built-in Instruments Add-on's names (ADR 0162, #1901), without its
// engines, so Projects and migrations can name its kinds without loading it.

export const INSTRUMENTS_ADD_ON = 'https://northtalk.org/add-ons/instruments';
export const INSTRUMENTS_VERSION = '1.0.0';
export const SYNTH_KIND = `${INSTRUMENTS_ADD_ON}#synth`;
export const YM2149_KIND = `${INSTRUMENTS_ADD_ON}#ym2149`;

/**
 * A synth Instrument as a Base or Example Project writes it, without loading
 * the Add-on: its parameters take their defaults once it loads.
 */
export const synthInstrument = (name: string) => ({
  name,
  kind: SYNTH_KIND,
  voices: 8,
  parameters: {},
});

/** The Add-on's entry in a Project that uses it. */
export const INSTRUMENTS_REF = {
  id: INSTRUMENTS_ADD_ON,
  version: INSTRUMENTS_VERSION,
};

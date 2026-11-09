// The built-in Piano Roll Add-on's names (ADR 0175, #2181), so Base Projects
// can list it without loading it.

export const PIANO_ROLL_ADD_ON = 'https://northtalk.org/add-ons/piano-roll';
export const PIANO_ROLL_VERSION = '1.3.0';

/** The Add-on's entry in a Project that uses it. */
export const PIANO_ROLL_REF = {
  id: PIANO_ROLL_ADD_ON,
  version: PIANO_ROLL_VERSION,
};

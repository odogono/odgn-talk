// The built-in controls Add-on's names (ADR 0162, #1902), so Base Projects
// and migrations can list it without loading its kinds.

export const CONTROLS_ADD_ON = 'https://northtalk.org/add-ons/controls';
export const CONTROLS_VERSION = '1.0.0';

/** The Add-on's entry in a Project that uses it. */
export const CONTROLS_REF = { id: CONTROLS_ADD_ON, version: CONTROLS_VERSION };

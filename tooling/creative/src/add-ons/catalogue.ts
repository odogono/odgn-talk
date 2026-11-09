// The Add-ons built with Folio (ADR 0162, #1901). Each is a separate chunk at
// `add-ons/<slug>-<version>.js`, fetched the first time a Project or author
// needs it and kept by the service worker.
import { CONTROLS_ADD_ON } from './controls/ids';
import { INSTRUMENTS_ADD_ON, INSTRUMENTS_VERSION } from './instruments/ids';
import { PIANO_ROLL_ADD_ON, PIANO_ROLL_VERSION } from './piano-roll/ids';

export type CatalogueEntry = {
  /** The Add-on's URL. */
  id: string;
  /** Its Instrument kinds as Info lists them before it loads. */
  instruments?: readonly { label: string; name: string }[];
  /** Its kinds as the Tools window lists them before it loads. */
  kinds: readonly { icon: string; label: string; name: string }[];
  /** Its name in Project ▸ Add-ons…. */
  label: string;
  /** Its source under `src/add-ons/`, and its chunk's name. */
  slug: string;
  version: string;
  /** It has engines for the audio worklet, at `add-ons/<slug>-<version>.worklet.js`. */
  worklet?: true;
};

export const BUILT_IN_ADD_ONS: readonly CatalogueEntry[] = [
  {
    id: CONTROLS_ADD_ON,
    kinds: [
      { name: 'slider', label: 'Slider', icon: '▭' },
      { name: 'knob', label: 'Knob', icon: '◔' },
      { name: 'toggle', label: 'Toggle', icon: '◐' },
      { name: 'xy', label: 'XY pad', icon: '⌖' },
      { name: 'meter', label: 'Level meter', icon: '▮' },
    ],
    label: 'Controls',
    slug: 'controls',
    version: '1.0.0',
  },
  {
    id: INSTRUMENTS_ADD_ON,
    kinds: [],
    instruments: [
      { name: 'synth', label: 'Synth' },
      { name: 'ym2149', label: 'YM2149 sound chip' },
    ],
    label: 'Instruments',
    slug: 'instruments',
    version: INSTRUMENTS_VERSION,
    worklet: true,
  },
  {
    id: PIANO_ROLL_ADD_ON,
    kinds: [],
    label: 'Piano Roll',
    slug: 'piano-roll',
    version: PIANO_ROLL_VERSION,
  },
];

/** The chunk a built-in Add-on is served as, relative to Folio. */
export const addOnChunk = (entry: CatalogueEntry): string =>
  `add-ons/${entry.slug}-${entry.version}.js`;

/** A built-in Add-on's audio worklet module, relative to Folio. */
export const addOnWorklet = (entry: CatalogueEntry): string =>
  `add-ons/${entry.slug}-${entry.version}.worklet.js`;

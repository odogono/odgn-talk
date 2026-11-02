// The built-in Instruments Add-on (ADR 0162, #1901): the synth and YM2149
// Instrument kinds, loaded only by Projects that use them. The sampler stays
// in Folio, since Sound Patterns without `on` play on one.
import { defineAddOn } from '../api';
import { synthEngine } from '../../instruments/synth';
import { ym2149Engine } from '../../instruments/ym2149';
import { INSTRUMENTS_ADD_ON, INSTRUMENTS_VERSION } from './ids';

export default defineAddOn({
  id: INSTRUMENTS_ADD_ON,
  version: INSTRUMENTS_VERSION,
  kinds: {},
  instruments: {
    synth: {
      label: 'Synth',
      instanceName: 'synth',
      kind: ({ operations }) => ({
        ...synthEngine,
        operations: operations.note,
      }),
    },
    ym2149: {
      label: 'YM2149 sound chip',
      instanceName: 'chip',
      kind: ({ operations }) => ({
        ...ym2149Engine,
        operations: operations.note,
      }),
    },
  },
});

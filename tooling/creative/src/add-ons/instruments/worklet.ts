// The Instruments Add-on's engines for the audio worklet (#1901). The
// worklet can't import, so this module is added to it and registers each
// engine by kind.
import { registerWorkletEngine } from '../../instruments/worklet-engines';
import { synthEngine } from '../../instruments/synth';
import { ym2149Engine } from '../../instruments/ym2149';
import { SYNTH_KIND, YM2149_KIND } from './ids';

registerWorkletEngine(SYNTH_KIND, synthEngine);
registerWorkletEngine(YM2149_KIND, ym2149Engine);

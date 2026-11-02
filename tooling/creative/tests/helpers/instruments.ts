// Registers the built-in Instruments Add-on, as opening a Project that uses
// it does, so tests can use the synth and YM2149 kinds (#1901).
import instruments from '../../src/add-ons/instruments';
import { AddOnLoader } from '../../src/add-ons/loader';
// The audio worklet's half registers the engines the rack plays.
import '../../src/add-ons/instruments/worklet';

export {
  INSTRUMENTS_REF,
  SYNTH_KIND,
  YM2149_KIND,
} from '../../src/add-ons/instruments/ids';

const problem = new AddOnLoader().register(instruments);
if (problem) {
  throw new Error(problem);
}

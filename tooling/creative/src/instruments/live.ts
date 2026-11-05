// The Instruments window during Play (ADR 0167, #2081). A change made in the
// window is an authored edit, kept with the Project, that the running
// Instrument also hears straight away; a Script's `set` changes only the
// playing value, which the window shows beside the saved one.
import type { Instrument, InstrumentParameterValue } from '../model';
import type { DeepReadonly } from '../readonly';

/** Every Instrument's parameters as they play, by Instrument name. */
export type PlayingParameters = Readonly<
  Record<string, Readonly<Record<string, InstrumentParameterValue>>>
>;

/** One parameter for the running Instrument named `instrument`. */
export type LiveParameter = {
  instrument: string;
  parameter: string;
  value: InstrumentParameterValue;
};

/**
 * The parameters an authored change moved, such as a committed drag, an
 * undo or a redo, for the running Instruments to hear. Instruments are
 * matched by id and reached by name; one added, removed or renamed is
 * skipped, since Scripts reach Instruments by name at load.
 */
export const changedParameters = (
  before: readonly DeepReadonly<Instrument>[],
  after: readonly DeepReadonly<Instrument>[],
): LiveParameter[] => {
  if (before === after) {
    return [];
  }
  const was = new Map(before.map(each => [each.id, each]));
  return after.flatMap(now => {
    const old = was.get(now.id);
    if (!old || old === now || old.name !== now.name) {
      return [];
    }
    return Object.entries(now.parameters)
      .filter(([parameter, value]) => old.parameters[parameter] !== value)
      .map(([parameter, value]) => ({
        instrument: now.name,
        parameter,
        value,
      }));
  });
};

/** `playing` with one parameter set, as the page hears it before the worker. */
export const withPlaying = (
  playing: PlayingParameters,
  { instrument, parameter, value }: LiveParameter,
): PlayingParameters =>
  instrument in playing
    ? {
        ...playing,
        [instrument]: { ...playing[instrument], [parameter]: value },
      }
    : playing;

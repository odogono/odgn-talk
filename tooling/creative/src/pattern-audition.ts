// Auditioning one step of a pattern (#2190): what `play "<name>" on <on>`
// would send, worked out in a Play Session of its own that runs nothing
// else, for the page to preview through its own audio. A Literal Editor
// plays the note a press puts in, or the row it names, this way.
import type { InstrumentMessage } from './instruments/session';
import { settle } from './message';
import type { Project } from './model';
import { PlaySession } from './play';
import type { DeepReadonly } from './readonly';

/** Steps a name may be: a note, a sound, or a sound with its index. */
const STEP = /^[A-Za-z0-9#_.]+(?::\d+)?$/u;

/**
 * The messages `name` plays on the Instrument named `on`, or on the
 * Project's default sampler without one; why not, when it can't.
 */
export const auditionStep = async (
  project: DeepReadonly<Project>,
  name: string,
  on?: string,
): Promise<InstrumentMessage[] | { problem: string }> => {
  if (!STEP.test(name) || (on !== undefined && !/^\w+$/u.test(on))) {
    return { problem: `${name} is not a step` };
  }
  const sent: InstrumentMessage[] = [];
  const play = new PlaySession(project as Project, 0, {
    events: false,
    instrumentBackend: message => sent.push(message),
  });
  const started = play.runMessage(
    `play "${name}"${on === undefined ? '' : ` on ${on}`}`,
  );
  if (!started.ok) {
    play.stop(0n);
    return { problem: started.error };
  }
  const reply = await settle(play, started.result, () => play.pump(0n));
  play.patterns.flush();
  // Stopping the session stops its Instruments too, which would silence
  // the note as it starts: only what the step played is kept.
  const played = sent.slice();
  play.stop(0n);
  return reply.error ? { problem: reply.error } : played;
};

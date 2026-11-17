// Edit-time preview (#2269): Edit runs no Play Session, so what a command or
// a pattern step plays is worked out in a scratch session of its own, kept
// before that session stops, and sounded through the Instruments' preview
// audio (ADR 0159, ADR 0175). The Message Box, a Literal Editor's audition
// and the Instruments window's ▶ all preview through here.
import type { ImageAssets } from './images';
import { previewInstruments, type SoundBytes } from './instruments/preview';
import type { InstrumentMessage } from './instruments/session';
import { settle } from './message';
import type { Project } from './model';
import { PlaySession } from './play';
import type { DeepReadonly } from './readonly';

export type EditPreview = {
  /**
   * Flushes its patterns, then stops it, returning what it played. Stopping
   * stops its Instruments too, which would silence each note as it starts,
   * so those stops are not kept.
   */
  finish(): InstrumentMessage[];
  /** The scratch session: it sends no events and sounds nothing itself. */
  readonly play: PlaySession;
};

/** A scratch session over `project` that records what its Instruments get. */
export const editPreview = (
  project: DeepReadonly<Project>,
  pageIndex = 0,
): EditPreview => {
  const sent: InstrumentMessage[] = [];
  const play = new PlaySession(project, pageIndex, {
    events: false,
    instrumentBackend: message => sent.push(message),
  });
  return {
    play,
    finish() {
      play.patterns.flush();
      const played = sent.slice();
      play.stop(0n);
      return played;
    },
  };
};

/** Steps a name may be: a note, a sound, or a sound with its index. */
const STEP = /^[A-Za-z0-9#_.]+(?::\d+)?$/u;

/**
 * The messages `play "<name>" on <on>` plays (#2190), or on the Project's
 * default sampler without `on`; why not, when it can't.
 */
export const auditionStep = async (
  project: DeepReadonly<Project>,
  name: string,
  on?: string,
): Promise<InstrumentMessage[] | { problem: string }> => {
  if (!STEP.test(name) || (on !== undefined && !/^\w+$/u.test(on))) {
    return { problem: `${name} is not a step` };
  }
  const preview = editPreview(project);
  const started = preview.play.runMessage(
    `play "${name}"${on === undefined ? '' : ` on ${on}`}`,
  );
  if (!started.ok) {
    preview.finish();
    return { problem: started.error };
  }
  const reply = await settle(preview.play, started.result, () =>
    preview.play.pump(0n),
  );
  const played = preview.finish();
  return reply.error ? { problem: reply.error } : played;
};

/** A Project's sound bytes, from the assets the page holds. */
export const assetSoundBytes =
  (images: ImageAssets): SoundBytes =>
  async asset => {
    const bytes = images.bytes.get(asset.hash);
    if (bytes === undefined) {
      throw new Error('its bytes are missing');
    }
    return bytes.slice().buffer;
  };

/**
 * Sounds `messages` through the preview audio, ending any earlier preview.
 * A preview with no Script to report against ignores errors by default.
 */
export const playPreview = (
  project: DeepReadonly<Project>,
  soundBytes: SoundBytes,
  messages: readonly InstrumentMessage[],
  onError: (message: string) => void = () => {},
  sounds: readonly string[] = [],
): void => {
  if (messages.length) {
    previewInstruments(project, soundBytes, messages, onError, sounds);
  }
};

// The Edit-time preview of Instruments: Edit runs no Play Session, so
// sounds are heard through an AudioContext of their own. The Message Box
// previews the steps a `play` command played (ADR 0159, #1896), which
// closes when they have sounded; the Instruments window auditions the
// selected Instrument (#2080), and holds its audio open while the computer
// keyboard plays it. A new preview of either kind ends the last one.
import type { Asset, Project } from '../model';
import type { DeepReadonly } from '../readonly';
import { startInstrumentAudio } from './audio';
import type { InstrumentMessage } from './session';

// Time for the first step after the audio starts, and for the last to ring.
const START_S = 0.05;
const TAIL_S = 2;

export type SoundBytes = (asset: DeepReadonly<Asset>) => Promise<ArrayBuffer>;

let current: { close(): void } | undefined;

/**
 * Plays `messages`, timed in seconds from 0, from when the audio starts.
 * `sounds` decode before it starts.
 */
export const previewInstruments = (
  project: DeepReadonly<Project>,
  soundBytes: SoundBytes,
  messages: readonly InstrumentMessage[],
  onError: (message: string) => void,
  sounds: readonly string[] = [],
): void => {
  current?.close();
  const channel = new MessageChannel();
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const audio = startInstrumentAudio(project, soundBytes, {
    onError,
    onReading: reading => {
      if (started || !reading.running) {
        return;
      }
      started = true;
      const base = reading.audio + START_S;
      let last = 0;
      for (const message of messages) {
        last = Math.max(last, message.at ?? 0);
        channel.port1.postMessage({ ...message, at: base + (message.at ?? 0) });
      }
      timer = setTimeout(
        () => preview.close(),
        (START_S + last + TAIL_S) * 1000,
      );
    },
    sounds,
  });
  const preview = {
    close() {
      clearTimeout(timer);
      channel.port1.close();
      audio.close();
      if (current === preview) {
        current = undefined;
      }
    },
  };
  current = preview;
  audio.listen(channel.port2);
};

export type HeldPreview = {
  /** Ends the audio; later sends are ignored. */
  close(): void;
  /** False once closed, by `close` or by another preview. */
  open(): boolean;
  /** Plays `message` as soon as the audio can; its `at` is ignored. */
  send(message: InstrumentMessage): void;
};

/**
 * Opens audio for `project` that stays open until closed or until another
 * preview starts, for notes played live.
 */
export const holdInstruments = (
  project: DeepReadonly<Project>,
  soundBytes: SoundBytes,
  onError: (message: string) => void,
  sounds: readonly string[] = [],
): HeldPreview => {
  current?.close();
  const channel = new MessageChannel();
  const audio = startInstrumentAudio(project, soundBytes, {
    onError,
    onReading: () => {},
    sounds,
  });
  let closed = false;
  const held: HeldPreview = {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      channel.port1.close();
      audio.close();
      if (current === held) {
        current = undefined;
      }
    },
    open: () => !closed,
    send({ commands, instrument }) {
      // Without `at`, the worklet plays it at its next sample.
      if (!closed) {
        channel.port1.postMessage({ commands, instrument });
      }
    },
  };
  current = held;
  audio.listen(channel.port2);
  return held;
};

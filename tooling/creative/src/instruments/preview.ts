// The Message Box's Edit-time preview of `play` (ADR 0159, #1896): Edit runs
// no Play Session, so the steps a command played are heard once through an
// AudioContext of their own, which closes when they have sounded.
import type { Asset, Project } from '../model';
import type { DeepReadonly } from '../readonly';
import { startInstrumentAudio } from './audio';
import type { InstrumentMessage } from './session';

// Time for the first step after the audio starts, and for the last to ring.
const START_S = 0.05;
const TAIL_S = 2;

let current: { close(): void } | undefined;

/**
 * Plays `messages`, timed in seconds from 0, from when the audio starts. A
 * new preview ends the last one.
 */
export const previewInstruments = (
  project: DeepReadonly<Project>,
  soundBytes: (asset: DeepReadonly<Asset>) => Promise<ArrayBuffer>,
  messages: readonly InstrumentMessage[],
  onError: (message: string) => void,
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

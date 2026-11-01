// Run on the dedicated test page described in README.md. Proves that beats
// sound in time (#1892): the real Play worker drives the real Instrument
// worklet on a real AudioContext, sending its commands over a MessageChannel
// (#1927), with the Play clock following the audio clock, and the worklet
// reports the sample each note starts on.
import type { Envelope } from '@northtalk/tooling/worker-supervisor';
import { startInstrumentAudio } from '../src/instruments/audio';
import type { NoteOnset } from '../src/instruments/rack';
import { createInstrument } from '../src/instruments/registry';
import { createProject } from '../src/model';
import type { PlayRequest } from '../src/play-protocol';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Holds this thread, as layout or a long Edit task would. */
const block = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Busy.
  }
};

/**
 * Plays a beat Script for `ms` and returns its onsets. `during` runs on this
 * thread while it plays.
 */
const playBeats = async (
  script: string,
  ms: number,
  projectScript = '',
  during?: () => Promise<void>,
) => {
  const project = createProject('Beats');
  project.instruments.push(createInstrument('synth', 'lead'));
  project.script = projectScript;
  project.pages[0]!.script = script;
  const onsets: NoteOnset[] = [];
  const worker = new Worker('./play.worker.js', { type: 'module' });
  let id = 1;
  const request = (body: PlayRequest, transfer: Transferable[] = []) =>
    worker.postMessage(
      { id: id++, request: body } satisfies Envelope<PlayRequest>,
      transfer,
    );
  const audio = startInstrumentAudio(
    project,
    () => Promise.reject(new Error('no sounds')),
    {
      onError: message => {
        throw new Error(message);
      },
      onNote: onset => onsets.push(onset),
      onReading: reading =>
        request({ kind: 'audioClock', session: 1, reading }),
    },
  );
  const { port1, port2 } = new MessageChannel();
  audio.listen(port1);
  request(
    {
      kind: 'open',
      session: 1,
      project,
      pageIndex: 0,
      seed: 0n,
      audioClock: audio.reading(),
      instrumentPort: port2,
    },
    [port2],
  );
  await Promise.all([sleep(ms), during?.()]);
  request({ kind: 'stop', session: 1 });
  await sleep(50);
  worker.terminate();
  audio.close();
  return onsets;
};

/** Asserts the onsets fall every `gap` seconds, each on its sample. */
const onGrid = (onsets: readonly NoteOnset[], gap: number) => {
  const sample = 1 / 44_100;
  for (let i = 2; i < onsets.length; i++) {
    const between = onsets[i]!.time - onsets[i - 1]!.time;
    // A late command would play at once, off the grid.
    assert(
      Math.abs(between - gap) < 2 * sample,
      `Beats ${i - 1} and ${i} are ${between} s apart, not ${gap} s`,
    );
  }
};

const BEAT_SCRIPT = `on beat bar, beat, count
  tell lead to play 60 + beat
end beat
`;
const FAST = 'on startPlay\n  tell transport to setTempo 240\nend startPlay\n';

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  await test('every beat sounds on its sample, a beat apart', async () => {
    const onsets = await playBeats(BEAT_SCRIPT, 2600, FAST);
    assert(onsets.length >= 6, `Enough beats sounded: ${onsets.length}`);
    onGrid(onsets, 0.25);
    assert(
      onsets
        .slice(0, 4)
        .map(o => o.note)
        .join() === '61,62,63,64',
      `The bar's beats played in order: ${onsets.map(o => o.note).join()}`,
    );
  });

  await test('a blocked page delays no beat', async () => {
    // The page holds its thread for longer than the 100 ms lead, twice.
    const onsets = await playBeats(BEAT_SCRIPT, 2600, FAST, async () => {
      await sleep(800);
      block(400);
      await sleep(500);
      block(400);
    });
    assert(onsets.length >= 8, `Enough beats sounded: ${onsets.length}`);
    onGrid(onsets, 0.25);
  });

  await test('a sound at an offset lands that far after its beat', async () => {
    const onsets = await playBeats(
      `on beat bar, beat, count
  tell lead to play 60
  tell lead to play 72, 1, 125 ms
end beat
`,
      1400,
    );
    const pairs = onsets.filter(o => o.note === 60).length;
    assert(pairs >= 2, `Beats sounded: ${pairs}`);
    for (let i = 0; i + 1 < onsets.length; i += 2) {
      const gap = onsets[i + 1]!.time - onsets[i]!.time;
      assert(
        Math.abs(gap - 0.125) < 2 / 44_100,
        `The offset note came ${gap} s after its beat`,
      );
    }
  });

  return results;
};

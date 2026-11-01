// Run on the dedicated test page described in README.md. Proves that beats
// sound in time (#1892): a Play host drives the real Instrument worklet on a
// real AudioContext, with the Play clock following its audio clock, and the
// worklet reports the sample each note starts on.
import type { Envelope, Reply } from '@northtalk/tooling/worker-supervisor';
import { startInstrumentAudio } from '../src/instruments/audio';
import type { NoteOnset } from '../src/instruments/rack';
import { createInstrument } from '../src/instruments/registry';
import { createProject } from '../src/model';
import { PlayHost } from '../src/play-host';
import type { PlayRequest, PlayResponse } from '../src/play-protocol';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Plays a beat Script for `ms` and returns its onsets and sound times. */
const playBeats = async (script: string, ms: number, projectScript = '') => {
  const project = createProject('Beats');
  project.instruments.push(createInstrument('synth', 'lead'));
  project.script = projectScript;
  project.pages[0]!.script = script;
  const onsets: NoteOnset[] = [];
  const times: number[] = [];
  let id = 1;
  // The audio and the host each need the other; the host comes second.
  const wired: { host?: PlayHost } = {};
  const request = (body: PlayRequest) =>
    wired.host?.receive({
      id: id++,
      request: body,
    } satisfies Envelope<PlayRequest>);
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
  wired.host = new PlayHost((reply: Reply<PlayResponse>) => {
    const { response } = reply;
    if (response.kind === 'instrument') {
      if (response.at !== undefined) {
        times.push(response.at);
      }
      audio.send(response);
    }
  });
  request({
    kind: 'open',
    session: 1,
    project,
    pageIndex: 0,
    seed: 0n,
    audioClock: audio.reading(),
  });
  await sleep(ms);
  request({ kind: 'stop', session: 1 });
  audio.close();
  return { onsets, times, audio };
};

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
    const { onsets, times } = await playBeats(
      `on beat bar, beat, count
  tell lead to play 60 + beat
end beat
`,
      2600,
      'on startPlay\n  tell transport to setTempo 240\nend startPlay\n',
    );
    assert(onsets.length >= 6, `Enough beats sounded: ${onsets.length}`);
    const sample = 1 / 44_100;
    for (const [i, onset] of onsets.entries()) {
      const due = times[i]!;
      // A late command would play at once, after its time.
      assert(
        onset.time >= due - sample && onset.time - due < 2 * sample,
        `Beat ${i} sounded at ${onset.time}, due at ${due}`,
      );
    }
    for (let i = 2; i < onsets.length; i++) {
      const gap = onsets[i]!.time - onsets[i - 1]!.time;
      assert(
        Math.abs(gap - 0.25) < 2 * sample,
        `Beats ${i - 1} and ${i} are ${gap} s apart, not 0.25 s`,
      );
    }
    assert(
      onsets
        .slice(0, 4)
        .map(o => o.note)
        .join() === '61,62,63,64',
      `The bar's beats played in order: ${onsets.map(o => o.note).join()}`,
    );
  });

  await test('a sound at an offset lands that far after its beat', async () => {
    const { onsets } = await playBeats(
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

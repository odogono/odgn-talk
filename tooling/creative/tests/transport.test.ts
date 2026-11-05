import { expect, test } from 'bun:test';
import type { Envelope } from '@northtalk/tooling/worker-supervisor';
import { settle } from '../src/message';
import { createElement, createProject, type Project } from '../src/model';
import { PlaySession } from '../src/play';
import { PlayHost } from '../src/play-host';
import type { PlayRequest } from '../src/play-protocol';
import { createInstrument } from '../src/instruments/registry';
import type { InstrumentMessage } from '../src/instruments/session';
import { scriptManifest } from '../src/script-manifest';
import { LEAD_US, Transport } from '../src/transport';
import { SYNTH_KIND } from './helpers/instruments';

const ms = (n: number) => BigInt(n) * 1000n;

test('beats fall on the tempo grid, delivered one lead early', () => {
  const transport = new Transport();
  transport.start(0n);
  expect(transport.nextDelivery()).toBe(0n);
  expect(transport.due(0n)).toEqual([
    { position: { bar: 1, beat: 1, count: 0 }, time: LEAD_US },
  ]);
  expect(transport.nextDelivery()).toBe(ms(500));
  expect(transport.due(ms(499))).toEqual([]);
  expect(transport.due(ms(500))).toEqual([
    { position: { bar: 1, beat: 2, count: 1 }, time: ms(600) },
  ]);
  // A Pump up to a lead late still gets the beat.
  expect(transport.due(ms(1150)).map(b => b.position.count)).toEqual([2]);
  expect(transport.duration(2)).toBe(ms(1000));
});

test('a tempo change keeps the beat due in place and spaces later ones', () => {
  const transport = new Transport();
  transport.start(0n);
  transport.due(0n);
  transport.setTempo(60, ms(300));
  // Beat 1 was due at 600 ms; from there each beat is a second.
  expect(transport.timeOf(1)).toBe(ms(600));
  expect(transport.timeOf(2)).toBe(ms(1600));
  expect(transport.duration(1)).toBe(ms(1000));
});

test('bars follow the time signature; stop and start begin again', () => {
  const transport = new Transport();
  transport.setTimeSignature(3, 4);
  transport.start(0n);
  const bars = [0, 500, 1000, 1500].flatMap(at =>
    transport.due(ms(at)).map(b => [b.position.bar, b.position.beat]),
  );
  expect(bars).toEqual([
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 1],
  ]);
  transport.stop(ms(1500));
  expect(transport.nextDelivery()).toBeUndefined();
  expect(transport.due(ms(5000))).toEqual([]);
  transport.start(ms(5000));
  expect(transport.due(ms(5000))[0]!.position.count).toBe(0);
});

test('a time signature takes effect at the next bar line, and bars number on', () => {
  const transport = new Transport();
  transport.start(0n);
  // During bar 1's second beat: 3/4 starts with bar 2.
  transport.due(ms(500));
  transport.setTimeSignature(3, 4);
  expect(transport.beatsPerBar).toBe(4);
  const bars = [1000, 1500, 2000, 2500, 3000, 3500].flatMap(at =>
    transport.due(ms(at)).map(b => `${b.position.bar}.${b.position.beat}`),
  );
  expect(bars).toEqual(['1.3', '1.4', '2.1', '2.2', '2.3', '3.1']);
  expect(transport.beatsPerBar).toBe(3);
  expect(transport.countOfBar(2)).toBe(7);
  expect(transport.barAt(5.5)).toBe(1.5);
  // A change once bar 3 has begun comes in with bar 4, at count 10, and a
  // second one before then replaces it.
  transport.setTimeSignature(2, 4);
  transport.setTimeSignature(5, 8);
  expect(transport.position(9)).toEqual({ bar: 3, beat: 3, count: 9 });
  expect(transport.position(14)).toEqual({ bar: 4, beat: 5, count: 14 });
  expect(transport.position(15)).toEqual({ bar: 5, beat: 1, count: 15 });
});

test('a bar Wait ends on the Nth bar line after now, not counting the one it starts on', () => {
  const transport = new Transport();
  transport.start(0n);
  // Bar 1's line is count 0, at 100 ms; each bar is 2 s.
  const onLine = transport.wait('bar', 2, 0);
  const midBar = transport.wait('bar', 1, 1.5);
  const beats = transport.wait('beat', 3, 1.5);
  expect(transport.lineTime(onLine)).toBe(ms(4100));
  expect(transport.lineTime(midBar)).toBe(ms(2100));
  expect(transport.lineTime(beats)).toBe(ms(2100));
  expect(transport.nextWaitEnd()).toBe(ms(2000));
  expect(transport.endedWaits(ms(1999))).toEqual([]);
  // A late Pump still ends them with their line's time.
  expect(transport.endedWaits(ms(2300))).toEqual([
    { time: ms(2100), wait: midBar },
    { time: ms(2100), wait: beats },
  ]);
  expect(transport.waits.size).toBe(1);
});

test('a tempo or time-signature change mid-Wait still ends it on a bar line', () => {
  const transport = new Transport();
  transport.start(0n);
  const wait = transport.wait('bar', 3, 0);
  transport.due(ms(1000));
  // From bar 1's last beat (1.6 s), a beat is a second, so bar 4's line
  // comes at 10.6 s.
  transport.setTempo(60, ms(1000));
  expect(transport.lineTime(wait)).toBe(ms(10_600));
  transport.due(ms(3000));
  // Bar 3 is in 3/4, from 6.6 s, so bar 4 begins at 9.6 s.
  transport.setTimeSignature(3, 4);
  expect(transport.lineTime(wait)).toBe(ms(9600));
});

test('a stopped Transport holds Waits, which count on from bar 1 once it starts', () => {
  const transport = new Transport();
  const before = transport.wait('bar', 2, undefined);
  transport.start(0n);
  expect(transport.lineTime(before)).toBe(ms(4100));
  // Stopped during bar 2: one bar line, bar 3's, is still to come.
  transport.stop(ms(3000));
  expect(transport.nextWaitEnd()).toBeUndefined();
  expect(transport.endedWaits(ms(10_000))).toEqual([]);
  transport.start(ms(10_000));
  expect(transport.lineTime(before)).toBe(ms(12_100));
});

test('a session far behind skips to the latest beat', () => {
  const transport = new Transport();
  transport.start(0n);
  transport.due(0n);
  expect(transport.due(ms(10_000)).map(b => b.position.count)).toEqual([20]);
});

const band = (script: string) => {
  const project = createProject('Band');
  project.instruments.push(createInstrument(SYNTH_KIND, 'bass'));
  project.pages[0]!.script = script;
  project.pages[0]!.elements.push(createElement('button', 'go'));
  return project;
};

const session = (project: Project) => {
  const sent: InstrumentMessage[] = [];
  const play = new PlaySession(project, 0, {
    instrumentBackend: message => sent.push(message),
  });
  const pumpAt = (us: bigint) => {
    let result = play.pump(us);
    while (result.state === 'sliced') {
      result = play.pump(us);
    }
    return result;
  };
  return { play, pumpAt, sent };
};

test('a beat Handler gets bar, beat and count, and its sounds land on the beat', () => {
  const { play, pumpAt, sent } = session(
    band(`on beat bar, beat, count
  tell bass to play 40 + count
  if beat = 2 then
    tell bass to play "c4", 1, 250 ms
  end if
end beat
`),
  );
  const first = pumpAt(0n);
  expect(first.nextDeadline).toBe(ms(500));
  // A late Pump still times the sound from the beat, not from now.
  pumpAt(ms(530));
  expect(play.problems).toEqual([]);
  expect(sent).toEqual([
    {
      instrument: 'bass',
      at: 0.1,
      commands: [{ kind: 'note', note: 40, velocity: 1 }],
    },
    {
      instrument: 'bass',
      at: 0.6,
      commands: [{ kind: 'note', note: 41, velocity: 1 }],
    },
    {
      instrument: 'bass',
      at: 0.85,
      commands: [{ kind: 'note', note: 60, velocity: 1 }],
    },
  ]);
});

test('without a beat Handler no beats are delivered or scheduled', () => {
  const { pumpAt } = session(band(''));
  expect(pumpAt(0n).nextDeadline).toBeUndefined();
});

test('the transport Grant sets the tempo', async () => {
  const { play, pumpAt, sent } = session(
    band(`on beat bar, beat, count
  tell bass to play 60
end beat
`),
  );
  const run = async (command: string) => {
    const started = play.runMessage(command);
    return started.ok
      ? settle(play, started.result, () => play.pump(0n))
      : { error: started.error };
  };
  pumpAt(0n);
  expect(await run('ask transport to tempo')).toEqual({ text: undefined });
  await run('tell transport to setTempo 60');
  expect(await run('tell transport to setTempo 1000')).toMatchObject({
    error: expect.any(String),
  });
  // The beat already due keeps its time; the next comes a second later.
  pumpAt(ms(500));
  pumpAt(ms(1500));
  expect(sent.map(m => m.at)).toEqual([0.1, 0.6, 1.6]);
});

test('wait in beats ends on a beat line, and a sound after it plays there', () => {
  const project = band('');
  project.pages[0]!.elements[0]!.script =
    'on click\n  wait 2 beats\n  tell bass to play 60\nend click\n';
  const { play, pumpAt, sent } = session(project);
  pumpAt(0n);
  // At 200 ms, a lead later is in beat 1, so beat 3's line is the second.
  play.send(play.page.elements[0]!, 'click');
  pumpAt(ms(200));
  expect(pumpAt(ms(200)).nextDeadline).toBe(ms(1000));
  pumpAt(ms(999));
  expect(sent).toEqual([]);
  // A late Pump plays it on the line all the same.
  pumpAt(ms(1050));
  expect(play.problems).toEqual([]);
  expect(sent.map(m => m.at)).toEqual([1.1]);
});

test('a sound outside a beat Run plays now, or after an at from now', async () => {
  const project = band('');
  project.pages[0]!.elements[0]!.script =
    'on click\n  tell bass to play 60\n  tell bass to play 62, 1, 1000 ms\nend click\n';
  const { play, pumpAt, sent } = session(project);
  pumpAt(0n);
  play.send(play.page.elements[0]!, 'click');
  pumpAt(ms(2000));
  expect(sent.map(m => m.at)).toEqual([undefined, 3]);
});

test('every Manifest declares beat, the transport Grant and musical time', () => {
  const project = band('');
  const manifest = scriptManifest(project, project.pages[0]!);
  expect(manifest.musicalTime).toBe(true);
  expect(manifest.messages).toContainEqual({
    name: 'beat',
    args: ['value', 'value', 'value'],
  });
  expect(
    manifest.grants
      .find(g => g.name === 'transport')!
      .operations.map(o => o.name),
  ).toEqual(['setTempo', 'setTimeSignature', 'start', 'stop', 'tempo']);
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const hostWithAudio = (project: Project, audio: boolean) => {
  const clock = { wall: 0 };
  const messages: InstrumentMessage[] = [];
  // Commands arrive over the session's channel, as the worklet hears them.
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = ({ data }: MessageEvent<InstrumentMessage>) =>
    messages.push(data);
  const host = new PlayHost(
    () => {},
    () => BigInt(Math.round(clock.wall * 1000)),
    () => clock.wall,
    undefined,
    () => clock.wall,
  );
  let id = 1;
  const request = (body: PlayRequest) =>
    host.receive({ id: id++, request: body } satisfies Envelope<PlayRequest>);
  request({
    kind: 'open',
    session: 1,
    project,
    pageIndex: 0,
    seed: 0n,
    instrumentPort: port2,
    ...(audio ? { audioClock: { audio: 0, epoch: 0 } } : {}),
  });
  return { clock, messages, request };
};

const beating = () =>
  band('on beat bar, beat, count\n  tell bass to play 60\nend beat\n');

test('sounds are timed on the audio clock, a margin and a lead ahead', async () => {
  const { messages, request } = hostWithAudio(beating(), true);
  await until(() => messages.length === 1);
  // The Play clock starts 15 ms ahead of the audio; the beat is a lead later.
  expect(messages[0]!.at).toBeCloseTo(0.115, 6);
  request({ kind: 'stop', session: 1 });
});

test('without the audio clock a sound plays on arrival', async () => {
  const { messages, request } = hostWithAudio(beating(), false);
  await until(() => messages.length === 1);
  expect(messages[0]!.at).toBeUndefined();
  request({ kind: 'stop', session: 1 });
});

test('an ended session sends nothing more on its port', async () => {
  const { clock, messages, request } = hostWithAudio(beating(), true);
  await until(() => messages.length === 1);
  request({ kind: 'stop', session: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  const sent = messages.length;
  clock.wall = 5000;
  request({ kind: 'frame', session: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(messages.length).toBe(sent);
});

test('Pause freezes the Transport: beats resume on the same grid', async () => {
  const { clock, messages, request } = hostWithAudio(beating(), true);
  await until(() => messages.length === 1);
  request({ kind: 'pause', session: 1 });
  clock.wall = 5000;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(messages.length).toBe(1);
  request({ kind: 'resume', session: 1 });
  // The audio was suspended too: it resumes where it stopped.
  request({
    kind: 'audioClock',
    session: 1,
    reading: { audio: 0, epoch: 5000 },
  });
  clock.wall = 5520;
  await until(() => messages.length === 2);
  expect(messages.map(m => m.at)).toEqual([0.115, 0.615]);
  request({ kind: 'stop', session: 1 });
});

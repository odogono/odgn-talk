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
  transport.stop();
  expect(transport.nextDelivery()).toBeUndefined();
  expect(transport.due(ms(5000))).toEqual([]);
  transport.start(ms(5000));
  expect(transport.due(ms(5000))[0]!.position.count).toBe(0);
});

test('a session far behind skips to the latest beat', () => {
  const transport = new Transport();
  transport.start(0n);
  transport.due(0n);
  expect(transport.due(ms(10_000)).map(b => b.position.count)).toEqual([20]);
});

const band = (script: string) => {
  const project = createProject('Band');
  project.instruments.push(createInstrument('synth', 'bass'));
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

test('the transport Grant sets the tempo and converts beats for wait', async () => {
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

test('beats convert to an exact duration that wait keeps', () => {
  const project = band('');
  project.pages[0]!.elements[0]!.script =
    'on click\n  ask transport to beats 2\n  wait it\n  tell bass to play 60\nend click\n';
  const { play, pumpAt, sent } = session(project);
  pumpAt(0n);
  play.send(play.page.elements[0]!, 'click');
  pumpAt(0n);
  pumpAt(ms(999));
  expect(sent).toEqual([]);
  pumpAt(ms(1000));
  expect(sent.length).toBe(1);
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

test('every Manifest declares beat and the transport Grant', () => {
  const project = band('');
  const manifest = scriptManifest(project, project.pages[0]!);
  expect(manifest.messages).toContainEqual({
    name: 'beat',
    args: ['value', 'value', 'value'],
  });
  expect(
    manifest.grants
      .find(g => g.name === 'transport')!
      .operations.map(o => o.name),
  ).toEqual([
    'setTempo',
    'setTimeSignature',
    'start',
    'stop',
    'beats',
    'tempo',
  ]);
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

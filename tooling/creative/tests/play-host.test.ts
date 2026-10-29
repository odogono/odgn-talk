import { expect, test } from 'bun:test';
import {
  WorkerSupervisor,
  type Envelope,
  type Reply,
  type SupervisedWorker,
} from '@northtalk/tooling/worker-supervisor';
import {
  createElement,
  createPage,
  createProject,
  richTextFromPlainText,
  textOf,
  type Project,
} from '../src/model';
import { firstView, PlayHost } from '../src/play-host';
import { PlayMirror } from '../src/play-mirror';
import {
  type PlayRequest,
  type PlayResponse,
  type PlayView,
} from '../src/play-protocol';
import { ReaderTextHistory } from '../src/play-text';
import {
  ITEM_LIMIT,
  rowKey,
  summary,
  variableRows,
  type VariableScript,
} from '../src/variables';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

const fixture = () => {
  const project = createProject('Host');
  const button = createElement('button', 'go');
  button.script = 'on click\n set the label of me to "Clicked"\nend click';
  const note = createElement('text', 'note');
  if (note.kind !== 'text') {
    throw new Error('Expected text');
  }
  note.editable = true;
  note.script =
    'on textChanged\n set the label of go to the text of me\nend textChanged';
  project.pages[0]!.elements.push(button, note);
  project.pages[0]!.script = 'on keyDown k\nend keyDown';
  project.assets.push({
    name: 'beep',
    fileName: 'beep.wav',
    hash: '0',
    size: 1,
    mediaType: 'audio/wav',
  });
  return project;
};

// A host wired straight to a mirror, as the page and worker would be.
// `clock` is milliseconds, read as both the wall and the performance clock.
const hosted = (project: Project, clock?: () => number) => {
  const replies: Reply<PlayResponse>[] = [];
  const views: PlayView[] = [];
  let id = 1;
  const mirror = new PlayMirror((element, richText, pageIndex, edit) =>
    request({
      kind: 'text',
      session: 1,
      pageIndex,
      name: element.name,
      richText,
      edit,
    }),
  );
  // Copied as `postMessage` would, so the mirror never shares the session's objects.
  const host = new PlayHost(
    sent => {
      const reply = structuredClone(sent);
      replies.push(reply);
      if (reply.response.kind === 'view') {
        views.push(reply.response);
        mirror.apply(reply.response);
      }
    },
    clock && (() => BigInt(Math.round(clock() * 1000))),
    clock,
  );
  const request = (request: PlayRequest) =>
    host.receive({ id: id++, request } satisfies Envelope<PlayRequest>);
  request({
    kind: 'open',
    session: 1,
    project: structuredClone(project),
    pageIndex: 0,
    seed: 0n,
  });
  const element = (name: string) =>
    mirror.elementsOf().find(e => e.name === name)!;
  return { host, mirror, replies, request, views, element };
};

test('the page gets a full view, then only the Elements that changed', async () => {
  const { mirror, request, views, element } = hosted(fixture());
  expect(views[0]!.full).toBe(true);
  expect(views[0]!.order).toEqual(['go', 'note']);
  expect(mirror.pageHandles).toEqual({ keyDown: true, keyUp: false });
  const go = element('go');
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await until(() => go.kind === 'button' && go.label === 'Clicked');
  const update = views.at(-1)!;
  expect(update.full).toBe(false);
  expect(update.elements.map(e => e.element.name)).toEqual(['go']);
  // The mirror keeps one object per Element across updates.
  expect(element('go')).toBe(go);
  expect(mirror.isVisible(go)).toBe(true);
});

test('a reader edit keeps its history when the worker echoes it', async () => {
  const { mirror, element } = hosted(fixture());
  const note = element('note');
  if (note.kind !== 'text') {
    throw new Error('Expected text');
  }
  const history = new ReaderTextHistory(mirror, note);
  history.set(richTextFromPlainText('Hello'));
  expect(textOf(note)).toBe('Hello');
  const go = element('go');
  await until(() => go.kind === 'button' && go.label === 'Hello');
  expect(history.canUndo).toBe(true);
  history.undo();
  expect(textOf(note)).toBe('Text');
  await until(() => go.kind === 'button' && go.label === 'Text');
});

test('sounds play through the page and stop with the session', async () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n tell sound to loop "beep"\nend click';
  const { replies, request } = hosted(project);
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await until(() => replies.some(r => r.response.kind === 'play'));
  const play = replies.find(r => r.response.kind === 'play')!.response;
  expect(play).toMatchObject({
    kind: 'play',
    loop: true,
    asset: { name: 'beep' },
  });
  request({ kind: 'stop', session: 1 });
  expect(replies.at(-1)).toEqual({ id: 3, response: { kind: 'done' } });
  expect(replies.some(r => r.response.kind === 'stopSound')).toBe(true);
});

test('Stop is acknowledged once the session has stopped, and ends it', () => {
  const { request, replies, views } = hosted(fixture());
  request({ kind: 'stop', session: 1 });
  expect(views.at(-1)!.stopped).toBe(true);
  expect(replies.at(-1)).toEqual({ id: 2, response: { kind: 'done' } });
  // The ended session's input is answered and dropped.
  const count = views.length;
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  expect(replies.at(-1)!.response).toEqual({ kind: 'done' });
  expect(views.length).toBe(count);
});

test('Message Box commands answer once their Run ends', async () => {
  const { replies, request } = hosted(fixture());
  request({ kind: 'message', session: 1, text: '1 + 2' });
  await until(() => replies.some(r => r.id === 2));
  expect(replies.find(r => r.id === 2)!.response).toEqual({
    kind: 'message',
    text: '3',
  });
  request({ kind: 'message', session: 1, text: ':inspect [1 + 2]' });
  await until(() => replies.some(r => r.id === 3));
  expect(replies.find(r => r.id === 3)!.response).toEqual({
    kind: 'message',
    value: { kind: 'list', length: 1, items: [{ kind: 'plain', text: '3' }] },
  });
});

test('a paused session drops frames and reader input, and a Step delivers one frame', async () => {
  const project = fixture();
  project.pages[0]!.script =
    'script variable total = 0\non frame elapsed\n add elapsed to total\n set the label of go to "" & total\nend frame';
  let ms = 1000;
  const { mirror, request, element } = hosted(project, () => ms);
  const label = () => {
    const go = element('go');
    return go.kind === 'button' ? go.label : undefined;
  };
  await until(() => mirror.wantsFrames);
  request({ kind: 'frame', session: 1 });
  await until(() => label() === '0');
  ms = 1016;
  request({ kind: 'frame', session: 1 });
  await until(() => label() === '16');
  request({ kind: 'pause', session: 1 });
  await until(() => mirror.paused);
  ms = 5000;
  request({ kind: 'frame', session: 1 });
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(label()).toBe('16');
  // One Step is one 60 Hz frame of Play time, however long the pause.
  request({ kind: 'step', session: 1 });
  await until(() => label() === '33');
  expect(mirror.paused).toBe(true);
  ms = 6000;
  request({ kind: 'resume', session: 1 });
  await until(() => !mirror.paused);
  ms = 6016;
  request({ kind: 'frame', session: 1 });
  await until(() => label() === '49');
});

test('a wait keeps its remaining time across a pause', async () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n wait 100 ms\n set the label of me to "done"\nend click';
  let ms = 0;
  const { request, element } = hosted(project, () => ms);
  const label = () => {
    const go = element('go');
    return go.kind === 'button' ? go.label : undefined;
  };
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  ms = 50;
  request({ kind: 'pause', session: 1 });
  ms = 1000;
  request({ kind: 'resume', session: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  // Play time is 50 ms in, so the wait has 50 ms left.
  expect(label()).not.toBe('done');
  ms = 1100;
  await until(() => label() === 'done');
});

// A worker whose host runs in-process, except that it can be made to hang.
class HostWorker implements SupervisedWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  hung = false;
  terminated = false;
  readonly #host: PlayHost;
  constructor() {
    this.#host = new PlayHost(reply => this.#reply(reply));
  }
  // Replies arrive in a later task, as across a real worker boundary.
  #reply(reply: Reply<PlayResponse>): void {
    setTimeout(() =>
      this.onmessage?.(new MessageEvent('message', { data: reply })),
    );
  }
  postMessage(message: unknown): void {
    if (!this.hung) {
      this.#host.receive(message as Envelope<PlayRequest>);
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

test('a worker that does not answer Stop in time is ended', async () => {
  const workers: HostWorker[] = [];
  let terminations = 0;
  const supervisor = new WorkerSupervisor<PlayRequest, PlayResponse>({
    ended: { kind: 'ended' },
    spawn: () => {
      workers.push(new HostWorker());
      return workers.at(-1)!;
    },
    onMessage: () => {},
    onTerminated: () => terminations++,
  });
  const open = (session: number) =>
    supervisor.call({
      kind: 'open',
      session,
      project: fixture(),
      pageIndex: 0,
      seed: 0n,
    });
  await open(1);
  expect(
    await supervisor.supervise(
      { kind: 'stop', session: 1 },
      { deadlineMs: 50 },
    ),
  ).toEqual({ kind: 'done' });
  expect(terminations).toBe(0);
  await open(2);
  workers[0]!.hung = true;
  expect(
    await supervisor.supervise(
      { kind: 'stop', session: 2 },
      { deadlineMs: 50 },
    ),
  ).toEqual({ kind: 'ended' });
  expect(workers[0]!.terminated).toBe(true);
  expect(terminations).toBe(1);
  // The replacement is ready for the next session.
  expect(await open(3)).toEqual({ kind: 'done' });
});

test('the mirror keeps a reader edit the worker has not applied yet', () => {
  const sent: number[] = [];
  const mirror = new PlayMirror((_element, _text, _page, edit) =>
    sent.push(edit),
  );
  const view = firstView(fixture(), 0, 1);
  mirror.apply(view);
  const note = mirror.elementsOf().find(e => e.name === 'note')!;
  if (note.kind !== 'text') {
    throw new Error('Expected text');
  }
  mirror.editText(note, richTextFromPlainText('Typed'));
  // A view from before the edit arrives with other text.
  const stale = structuredClone(view);
  stale.full = false;
  for (const entry of stale.elements) {
    if (entry.element.kind === 'text') {
      entry.element.richText = richTextFromPlainText('Old');
    }
  }
  mirror.apply(stale);
  expect(textOf(note)).toBe('Typed');
  // Once the worker has applied it, its text is authoritative again.
  for (const entry of stale.elements) {
    entry.edit = sent[0]!;
    if (entry.element.kind === 'text') {
      entry.element.richText = richTextFromPlainText('Script');
    }
  }
  mirror.apply(stale);
  expect(textOf(note)).toBe('Script');
});

test('a refused reader edit is replaced by the worker’s text', async () => {
  const project = fixture();
  const note = project.pages[0]!.elements[1]!;
  note.visible = false;
  const { mirror, element } = hosted(project);
  const mirrored = element('note');
  if (mirrored.kind !== 'text') {
    throw new Error('Expected text');
  }
  mirror.editText(mirrored, richTextFromPlainText('Sneaky'));
  await until(() => textOf(mirrored) === 'Text');
});

test('Elements a Script deletes leave the mirror', async () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n tell elements to delete note\nend click';
  const { request, mirror } = hosted(project);
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await until(() => mirror.elementsOf().length === 1);
  expect(mirror.elementsOf().map(e => e.name)).toEqual(['go']);
});

test('a key held across navigation is released to the Project', async () => {
  const project = fixture();
  const first = project.pages[0]!;
  project.pages.push(createPage('two'));
  // The release leads back, so the test can see it arrive.
  project.script = `on keyUp k\n tell pages to show ${first.name}\nend keyUp`;
  // A stopped Page Script ends the path, so this Page has none.
  delete first.script;
  first.elements[0]!.script = 'on click\n tell pages to show two\nend click';
  const { request, mirror } = hosted(project);
  const send = (message: 'keyDown' | 'keyUp' | 'click', pageIndex: number) =>
    request({
      kind: 'send',
      session: 1,
      pageIndex,
      message,
      ...(message === 'click' ? { target: 'go' } : { args: ['a'] }),
    });
  send('keyDown', 0);
  send('click', 0);
  await until(() => mirror.page.index === 1);
  // The page releases the key to the Page it was pressed on.
  send('keyUp', 0);
  await until(() => mirror.page.index === 0);
});

test('worker targets carry loaded scope, reject stale instances and session ids', async () => {
  const project = fixture();
  project.script = 'script variable score = 3';
  project.pages.push(createPage('page2'));
  const { mirror, request, replies } = hosted(project);
  const target = mirror.messageTargets.find(t => t.label === 'project')!;
  expect(target.source).toBe(project.script!);
  expect(target.manifest.objects.map(o => o.name)).toEqual(['page1', 'page2']);
  const count = () => replies.filter(r => r.response.kind === 'message').length;
  request({ kind: 'message', session: 1, target: target.id, text: 'score' });
  await until(() => count() === 1);
  expect(replies.find(r => r.response.kind === 'message')?.response).toEqual({
    kind: 'message',
    text: '3',
  });
  request({
    kind: 'message',
    session: 1,
    target: 9999,
    text: 'put 8 into score',
  });
  expect(replies.at(-1)?.response).toMatchObject({
    kind: 'message',
    error: expect.stringContaining('unavailable'),
  });
  request({
    kind: 'message',
    session: 2,
    target: target.id,
    text: 'put 8 into score',
  });
  expect(replies.at(-1)?.response).toEqual({
    kind: 'message',
    error: 'Play has stopped.',
  });
  request({ kind: 'stop', session: 1 });
  expect(mirror.messageTargets).toEqual([]);
});

test('performance telemetry is opt-in, updates quiet views at 4 Hz and ends with a final snapshot', async () => {
  const replies: Reply<PlayResponse>[] = [];
  let clock = 0;
  const host = new PlayHost(
    reply => replies.push(structuredClone(reply)),
    () => 0n,
    () => clock,
  );
  const send = (request: PlayRequest) => host.receive({ id: 1, request });
  const snapshots = () =>
    replies.flatMap(reply =>
      reply.response.kind === 'performance' ? [reply.response] : [],
    );
  send({
    kind: 'open',
    session: 1,
    project: createProject('Quiet'),
    pageIndex: 0,
    seed: 0n,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(snapshots()).toHaveLength(0);
  send({ kind: 'performance', session: 1, epoch: 1 });
  expect(snapshots()).toHaveLength(1);
  clock = 250;
  await until(() => snapshots().length === 2);
  expect(snapshots()[1]!.snapshot.elapsed).toBe(0.25);
  send({ kind: 'performance', session: 1, epoch: 2 });
  expect(snapshots().at(-1)?.snapshot.epoch).toBe(2);
  clock = 500;
  send({ kind: 'stop', session: 1 });
  expect(snapshots().at(-1)?.snapshot).toMatchObject({
    status: 'stopped',
    epoch: 2,
    elapsed: 0.25,
  });
  const count = snapshots().length;
  await new Promise(resolve => setTimeout(resolve, 280));
  expect(snapshots()).toHaveLength(count);
});

test('capture requested at open includes startup Runs and source owners', async () => {
  const replies: Reply<PlayResponse>[] = [];
  const project = createProject('Startup');
  project.script = 'on startPlay\n return 1 + 2\nend startPlay';
  const host = new PlayHost(reply => replies.push(structuredClone(reply)));
  host.receive({
    id: 1,
    request: {
      kind: 'open',
      session: 1,
      project,
      pageIndex: 0,
      seed: 0n,
      performanceEpoch: 7,
    },
  });
  await until(() =>
    replies.some(
      reply =>
        reply.response.kind === 'performance' &&
        reply.response.snapshot.fuel > 0,
    ),
  );
  host.receive({ id: 2, request: { kind: 'stop', session: 1 } });
  const last = replies
    .flatMap(reply =>
      reply.response.kind === 'performance' ? [reply.response.snapshot] : [],
    )
    .at(-1)!;
  expect(last.epoch).toBe(7);
  expect(last.scripts.find(row => row.script === 'project')).toMatchObject({
    owner: 0,
    active: 0,
  });
});

test('clone telemetry keeps instance identity and links to the authored source', async () => {
  const project = createProject('Clones');
  const button = createElement('button', 'original');
  button.script = 'on click\n return 1 + 2\nend click';
  project.pages[0]!.elements.push(button);
  project.pages[0]!.script =
    'on openPage\n ask elements to clone original\n send click to it\nend openPage';
  const snapshots: Extract<PlayResponse, { kind: 'performance' }>[] = [];
  const host = new PlayHost(({ response }) => {
    if (response.kind === 'performance') {
      snapshots.push(structuredClone(response));
    }
  });
  host.receive({
    id: 1,
    request: {
      kind: 'open',
      session: 1,
      project,
      pageIndex: 0,
      seed: 0n,
      performanceEpoch: 1,
    },
  });
  try {
    await until(() =>
      snapshots.some(s =>
        s.snapshot.scripts.some(row => row.script.includes('dynamic:')),
      ),
    );
    const clone = snapshots
      .at(-1)!
      .snapshot.scripts.find(row => row.script.includes('dynamic:'))!;
    expect(clone.owner).toBe(2);
    expect(clone.origins.map(row => row.origin)).toEqual(['click']);
  } finally {
    host.receive({ id: 2, request: { kind: 'stop', session: 1 } });
  }
});

test('Library diagnostics retain source targets through the worker protocol', async () => {
  const project = createProject('Library problems');
  project.libraries = [
    { name: 'broken', source: 'function' },
    {
      name: 'helpers',
      source: 'function failNow\n return 1 div 0\nend failNow',
    },
  ];
  project.script =
    'use failNow from helpers\non startPlay\n put failNow() into result\nend startPlay';
  const { views, request } = hosted(project);
  await until(() =>
    views
      .flatMap(view => view.problems)
      .some(
        problem =>
          problem.target?.kind === 'library' && problem.target.index === 1,
      ),
  );
  expect(views.flatMap(view => view.problems)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: { kind: 'library', index: 0 } }),
      expect.objectContaining({
        line: 2,
        target: { kind: 'library', index: 1 },
      }),
    ]),
  );
  request({ kind: 'stop', session: 1 });
});

test('the Variables window reads the showing Page’s Scripts once per Pump', async () => {
  const project = fixture();
  project.script = 'script variable level = 1';
  project.pages[0]!.script = [
    'script variable score = 0',
    'script variable board = [[1, 2], [3]]',
    'script variable target = nothing',
    'script variable step = nothing',
    'on openPage',
    ' put 5 into score',
    ' put go into target',
    ' put given x: x into step',
    'end openPage',
  ].join('\n');
  project.pages[0]!.elements[0]!.script =
    'script variable presses = 0\non click\n put presses + 1 into presses\nend click';
  const other = createPage('Other');
  other.script = 'script variable hidden = 1';
  project.pages.push(other);
  const { replies, request } = hosted(project);
  const ask = () => {
    request({ kind: 'variables', session: 1 });
    return replies.at(-1)!.response as Extract<
      PlayResponse,
      { kind: 'variables' }
    >;
  };
  // `until` checks once more after it passes, so keep the last values.
  let scripts: VariableScript[] = [];
  const shows = (variable: string, text: string) => () => {
    scripts = ask().scripts ?? scripts;
    return scripts.some(script =>
      script.vars.some(
        ([name, value]) =>
          name === variable && value.kind === 'plain' && value.text === text,
      ),
    );
  };
  await until(shows('score', '5'));
  request({
    kind: 'send',
    session: 1,
    pageIndex: 0,
    target: 'go',
    message: 'click',
  });
  await until(shows('presses', '1'));
  expect(scripts.map(script => script.label)).toEqual([
    'Project',
    'page1',
    'page1 › go',
  ]);
  const page = new Map(scripts[1]!.vars);
  expect(page.get('board')).toEqual({
    kind: 'list',
    length: 2,
    items: [
      {
        kind: 'list',
        length: 2,
        items: [
          { kind: 'plain', text: '1' },
          { kind: 'plain', text: '2' },
        ],
      },
      { kind: 'list', length: 1, items: [{ kind: 'plain', text: '3' }] },
    ],
  });
  expect(page.get('target')).toMatchObject({
    kind: 'object',
    name: 'go',
    live: true,
    owner: 2,
  });
  expect(page.get('step')).toEqual({ kind: 'function' });
  // Nothing has pumped since, so the window keeps what it has.
  expect(ask().scripts).toBeUndefined();
});

test('Variables rows open lists by key and cap them with a more row', () => {
  const script: VariableScript = {
    label: 'Page 1',
    script: 'page',
    vars: [
      [
        'board',
        {
          kind: 'list',
          length: ITEM_LIMIT + 5,
          items: Array.from({ length: ITEM_LIMIT }, (_, i) => ({
            kind: 'plain' as const,
            text: String(i),
          })),
        },
      ],
      ['score', { kind: 'plain', text: '5' }],
    ],
  };
  expect(variableRows(script, new Set()).map(row => row.label)).toEqual([
    'board',
    'score',
  ]);
  const open = variableRows(script, new Set([rowKey('page', ['board'])]));
  expect(open).toHaveLength(ITEM_LIMIT + 3);
  expect(open[0]!.expanded).toBe(true);
  expect(open[ITEM_LIMIT + 1]!.more).toBe(5);
  expect(summary(script.vars[0]![1])).toBe(`list of ${ITEM_LIMIT + 5}`);
  expect(
    summary({
      kind: 'object',
      host: 'element',
      id: '7',
      name: 'gone',
      live: false,
    }),
  ).toBe('(deleted)');
});

test('the Performance window leaves out paused time', () => {
  const replies: Reply<PlayResponse>[] = [];
  let ms = 0;
  const host = new PlayHost(
    reply => replies.push(structuredClone(reply)),
    () => BigInt(ms * 1000),
    () => ms,
  );
  const send = (request: PlayRequest) => host.receive({ id: 1, request });
  send({
    kind: 'open',
    session: 1,
    project: createProject('Paused'),
    pageIndex: 0,
    seed: 0n,
  });
  send({ kind: 'performance', session: 1, epoch: 1 });
  ms = 250;
  send({ kind: 'pause', session: 1 });
  ms = 10_250;
  send({ kind: 'resume', session: 1 });
  ms = 10_500;
  send({ kind: 'stop', session: 1 });
  const last = replies.filter(r => r.response.kind === 'performance').at(-1);
  expect(last?.response).toMatchObject({ snapshot: { elapsed: 0.5 } });
});

const watchResults = (replies: Reply<PlayResponse>[]) =>
  new Map(
    replies.flatMap(reply =>
      reply.response.kind === 'watches'
        ? reply.response.results.map(result => [result.id, result] as const)
        : [],
    ),
  );

test('Watches run only while paused, and again after a Message Box line', async () => {
  const project = fixture();
  project.script =
    'script variable score = 3\nfunction poke\n send ping to page1\n return 1\nend poke';
  project.pages[0]!.script += '\non ping\nend ping';
  const { mirror, request, replies } = hosted(project);
  const target = mirror.messageTargets.find(t => t.label === 'project')!.id;
  const watches = [
    { id: 1, text: '1 + 2' },
    { id: 2, text: 'score', target },
    { id: 3, text: 'put 1 into x' },
    { id: 4, text: 'poke()', target },
    { id: 5, text: 'score', target: 9999 },
  ];
  request({ kind: 'watches', session: 1, watches });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(watchResults(replies).size).toBe(0);
  request({ kind: 'pause', session: 1 });
  await until(() => watchResults(replies).size === 5);
  const results = watchResults(replies);
  expect(results.get(1)).toMatchObject({
    state: 'value',
    value: { kind: 'plain', text: '3' },
    effects: false,
  });
  expect(results.get(2)).toMatchObject({ state: 'value', effects: false });
  expect(results.get(3)?.state).toBe('error');
  expect(results.get(4)).toMatchObject({ state: 'value', effects: true });
  expect(results.get(5)?.state).toBe('unavailable');
  request({
    kind: 'message',
    session: 1,
    target,
    text: 'put 7 into score',
  });
  await until(
    () =>
      JSON.stringify(watchResults(replies).get(2)) ===
      JSON.stringify({
        id: 2,
        state: 'value',
        value: { kind: 'plain', text: '7' },
        effects: false,
      }),
  );
  const count = replies.length;
  request({ kind: 'resume', session: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(
    replies.slice(count).some(reply => reply.response.kind === 'watches'),
  ).toBe(false);
});

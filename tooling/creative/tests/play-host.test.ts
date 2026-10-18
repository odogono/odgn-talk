import { expect, test } from 'bun:test';
import {
  WorkerSupervisor,
  type Envelope,
  type Reply,
  type SupervisedWorker,
} from '@northtalk/tooling/worker-supervisor';
import {
  createElement,
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
const hosted = (project: Project) => {
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
  const host = new PlayHost(reply => {
    replies.push(reply);
    if (reply.response.kind === 'view') {
      views.push(reply.response);
      mirror.apply(reply.response);
    }
  });
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

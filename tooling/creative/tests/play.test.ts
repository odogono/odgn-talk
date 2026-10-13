import { expect, test } from 'bun:test';
import { createElement, createPage, createProject, textOf } from '../src/model';
import { PlaySession } from '../src/play';

const fixture = () => {
  const project = createProject('Story');
  project.pages[0]!.elements.push(
    createElement('button', 'button1'),
    createElement('text', 'text1'),
  );
  return project;
};
const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
  throw new Error('Did not become idle');
};

for (const level of ['element', 'page', 'project']) {
  test(`click reaches the ${level} Handler through Core parents`, () => {
    const project = fixture();
    const page = project.pages[0]!;
    const button = page.elements[0]!;
    const owner =
      level === 'element' ? button : level === 'page' ? page : project;
    owner.script = `on click\n set the ${level === 'project' ? 'background of page1' : 'label of button1'} to "changed"\nend click`;
    const play = new PlaySession(project);
    play.send(play.page.elements[0]!, 'click');
    drain(play);
    expect(play.problems).toEqual([]);
    expect(
      level === 'project'
        ? play.page.background
        : (play.page.elements[0] as { label: string }).label,
    ).toBe('changed');
  });
}

test('me properties and plain text writes change only Play State; each session starts fresh', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n set the label of me to "Clicked"\n set the text of text1 to "Plain"\nend click';
  const before = structuredClone(project);
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.page.elements[0]).toHaveProperty('label', 'Clicked');
  const text = play.page.elements[1]!;
  expect(text.kind === 'text' && textOf(text)).toBe('Plain');
  play.stop(0n);
  expect(project).toEqual(before);
  expect(new PlaySession(project).page.elements[0]).toHaveProperty(
    'label',
    'Button',
  );
});

test('startPlay and openPage are delivered; a bad Script does not block other Scripts', () => {
  const project = fixture();
  project.script =
    'on startPlay\n set the background of page1 to "red"\nend startPlay';
  project.pages[0]!.script =
    'on openPage\n set the label of button1 to "Open"\nend openPage';
  project.pages[0]!.elements[0]!.script =
    'on click\n put typo into x\nend click';
  const play = new PlaySession(project);
  drain(play);
  expect(play.page.background).toBe('red');
  expect(play.page.elements[0]).toHaveProperty('label', 'Open');
  expect(play.problems[0]).toMatchObject({
    owner: project.pages[0]!.elements[0],
    line: 2,
    message: 'unknown name',
  });
});

test('runtime errors identify the authored Script and line and later handlers still run', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n put 1 / 0 into x\nend click\non pointerEnter\n set the label of me to "Alive"\nend pointerEnter';
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.problems[0]).toMatchObject({
    owner: project.pages[0]!.elements[0],
    line: 2,
  });
  play.send(play.page.elements[0]!, 'pointerEnter');
  drain(play);
  expect(play.page.elements[0]).toHaveProperty('label', 'Alive');
});

test('runaway execution yields to Stop and cannot restart from reader input', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n repeat forever\n end repeat\nend click';
  const before = structuredClone(project);
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  expect(play.pump(0n).state).toBe('sliced');
  play.stop(0n);
  play.send(play.page.elements[0]!, 'click');
  expect(
    play.group
      .inspect()
      .scripts.every(s => s.runs.length === 0 && s.mailbox.length === 0),
  ).toBe(true);
  expect(project).toEqual(before);
});

test('Host messages ending unhandled are ignored; Script messages warn with their sender', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'on click\n send missing to me\nend click';
  const play = new PlaySession(project);
  drain(play);
  expect(play.problems).toEqual([]);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.problems).toMatchObject([
    {
      owner: project.pages[0]!.elements[0],
      message: 'Unhandled message: missing',
    },
  ]);
});

// Navigation yields to the request's settlement between browser Pump turns.
const advance = async (play: PlaySession, now = 0n) => {
  for (let i = 0; i < 100; i++) {
    const result = play.pump(now);
    await Promise.resolve();
    if (result.state !== 'sliced') {
      return result;
    }
  }
  throw new Error('Did not become idle');
};

test('navigation keeps visuals, resets local variables and preserves Project variables', async () => {
  const project = fixture();
  const first = project.pages[0]!;
  const second = createPage('page2');
  second.elements.push(createElement('button', 'button1'));
  project.pages.push(second);
  project.script =
    'script variable visits = 0\non visited\n add 1 to visits\n set the height of page1 to visits + 500\nend visited';
  first.script =
    'script variable opens = 0\non openPage\n add 1 to opens\n set the text of text1 to "" & opens\n send visited to project\nend openPage\non closePage\n set the background of me to "closed"\nend closePage';
  first.elements[0]!.script =
    'on click\n set the label of me to "Kept"\n tell pages to show page2\n wait 10 s\n set the label of me to "Leaked"\nend click';
  second.elements[0]!.script = 'on click\n tell pages to show page1\nend click';
  const play = new PlaySession(project);
  await advance(play);
  expect(play.page.height).toBe(501);
  play.send(play.page.elements[0]!, 'click');
  await advance(play);
  expect(play.page.name).toBe('page2');
  expect(play.project.pages[0]!.background).toBe('closed');
  expect(play.project.pages[0]!.elements[0]).toHaveProperty('label', 'Kept');
  play.send(play.page.elements[0]!, 'click');
  await advance(play, 20_000_000_000n);
  expect(play.page.name).toBe('page1');
  expect(play.page.height).toBe(502);
  const localCount = play.page.elements[1]!;
  expect(localCount.kind === 'text' && textOf(localCount)).toBe('1');
  expect(play.page.elements[0]).toHaveProperty('label', 'Kept');
  expect(play.problems).toEqual([]);
});

test('closePage gets one second, then navigation cancels its waiting Run', async () => {
  const project = fixture();
  project.pages.push(createPage('page2'));
  project.pages[0]!.script =
    'on closePage\n wait 2 s\n set the background of me to "Too late"\nend closePage';
  project.pages[0]!.elements[0]!.script =
    'on click\n tell pages to show page2\nend click';
  const play = new PlaySession(project);
  await advance(play);
  play.send(play.page.elements[0]!, 'click');
  const pending = await advance(play);
  expect(play.pageIndex).toBe(0);
  expect(pending.nextDeadline).toBe(1_000_000_000n);
  await advance(play, 999_000_000n);
  expect(play.pageIndex).toBe(0);
  await advance(play, 1_000_000_000n);
  expect(play.pageIndex).toBe(1);
  await advance(play, 3_000_000_000n);
  expect(play.project.pages[0]!.background).not.toBe('Too late');
  expect(play.problems).toEqual([]);
});

test('passed closePage waits for its Project handler and Stop cancels navigation', async () => {
  const project = fixture();
  project.pages.push(createPage('page2'));
  project.pages[0]!.script = 'on closePage\n pass closePage\nend closePage';
  project.script =
    'on closePage\n wait 500 ms\n set the background of page1 to "Closed by project"\nend closePage';
  project.pages[0]!.elements[0]!.script =
    'on click\n tell pages to show page2\nend click';
  const play = new PlaySession(project);
  await advance(play);
  play.send(play.page.elements[0]!, 'click');
  await advance(play);
  expect(play.pageIndex).toBe(0);
  await advance(play, 500_000_000n);
  expect(play.pageIndex).toBe(1);
  expect(play.project.pages[0]!.background).toBe('Closed by project');
  expect(play.problems).toEqual([]);

  const stopped = new PlaySession(project);
  await advance(stopped);
  stopped.send(stopped.page.elements[0]!, 'click');
  await advance(stopped);
  stopped.stop(0n);
  await advance(stopped, 2_000_000_000n);
  expect(stopped.pageIndex).toBe(0);
});

test('a CPU-bound closePage cannot exceed the navigation deadline', async () => {
  const project = fixture();
  project.pages.push(createPage('page2'));
  project.pages[0]!.script =
    'on closePage\n repeat forever\n end repeat\nend closePage';
  project.pages[0]!.elements[0]!.script =
    'on click\n tell pages to show page2\nend click';
  const play = new PlaySession(project);
  await advance(play);
  play.send(play.page.elements[0]!, 'click');
  play.pump(0n);
  expect(play.pump(0n).state).toBe('sliced');
  expect(play.pageIndex).toBe(0);
  await advance(play, 1_000_000_000n);
  expect(play.pageIndex).toBe(1);
  expect(play.problems).toEqual([]);
});

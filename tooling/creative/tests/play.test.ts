import { expect, test } from 'bun:test';
import { createElement, createProject, textOf } from '../src/model';
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

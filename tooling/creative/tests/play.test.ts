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

test('wait suspends only its Run, resumes at its deadline and changes only Play State', async () => {
  const project = fixture();
  const [button, other] = project.pages[0]!.elements;
  button!.script =
    'on click\n set the label of me to "Waiting"\n wait 1 s\n set the label of me to "Finished"\nend click\non pointerEnter\n set the background of thisPage to "Responsive"\nend pointerEnter';
  other!.script =
    'on click\n wait 250 ms\n set the text of me to "Other finished"\nend click';
  const original = structuredClone(project);
  const play = new PlaySession(project);
  await advance(play);
  play.send(play.page.elements[0]!, 'click');
  expect((await advance(play)).nextDeadline).toBe(1_000_000n);
  expect(play.page.elements[0]).toHaveProperty('label', 'Waiting');

  // Both another Handler in the same Script and another Script can run.
  play.send(play.page.elements[0]!, 'pointerEnter');
  play.send(play.page.elements[1]!, 'click');
  expect((await advance(play)).nextDeadline).toBe(250_000n);
  expect(play.page.background).toBe('Responsive');
  const text = play.page.elements[1]!;
  const beforeText = text.kind === 'text' && textOf(text);
  await advance(play, 249_000n);
  expect(text.kind === 'text' && textOf(text)).toBe(beforeText);
  expect((await advance(play, 250_000n)).nextDeadline).toBe(1_000_000n);
  expect(text.kind === 'text' && textOf(text)).toBe('Other finished');
  await advance(play, 999_000n);
  expect(play.page.elements[0]).toHaveProperty('label', 'Waiting');
  expect((await advance(play, 1_000_000n)).nextDeadline).toBeUndefined();
  expect(play.page.elements[0]).toHaveProperty('label', 'Finished');
  expect(project).toEqual(original);
  expect(play.problems).toEqual([]);
});

test('leaving a Page cancels both Page and Element waits without late effects', async () => {
  const project = fixture();
  project.pages.push(createPage('page2'));
  project.script =
    'on leaked\n set the background of page2 to "Leaked"\nend leaked';
  const first = project.pages[0]!;
  first.script =
    'on openPage\n wait 2 s\n set the background of me to "Late Page"\n send leaked to project\nend openPage';
  first.elements[0]!.script =
    'on click\n wait 2 s\n set the label of me to "Late Element"\n send leaked to project\nend click';
  first.elements[1]!.script = 'on click\n tell pages to show page2\nend click';
  const play = new PlaySession(project);
  await advance(play);
  play.send(play.page.elements[0]!, 'click');
  expect((await advance(play)).nextDeadline).toBe(2_000_000n);
  play.send(play.page.elements[1]!, 'click');
  expect((await advance(play)).nextDeadline).toBeUndefined();
  expect(play.page.name).toBe('page2');
  await advance(play, 3_000_000n);
  expect(play.project.pages[0]!.background).toBe(first.background);
  expect(play.project.pages[0]!.elements[0]).toHaveProperty('label', 'Button');
  expect(play.page.background).not.toBe('Leaked');
  expect(play.problems).toEqual([]);
});

test('a Project wait keeps its deadline across Page navigation', async () => {
  const project = fixture();
  project.pages.push(createPage('page2'));
  project.script =
    'on startPlay\n wait 2 s\n set the background of page2 to "Project finished"\nend startPlay';
  project.pages[0]!.elements[0]!.script =
    'on click\n tell pages to show page2\nend click';
  const play = new PlaySession(project);
  expect((await advance(play)).nextDeadline).toBe(2_000_000n);
  play.send(play.page.elements[0]!, 'click');
  expect((await advance(play, 500_000n)).nextDeadline).toBe(2_000_000n);
  expect(play.page.name).toBe('page2');
  await advance(play, 1_999_000n);
  expect(play.page.background).not.toBe('Project finished');
  expect((await advance(play, 2_000_000n)).nextDeadline).toBeUndefined();
  expect(play.page.background).toBe('Project finished');
  expect(play.problems).toEqual([]);
});

test('Stop cancels Project, Page and Element waits even when their deadline is due', async () => {
  const project = fixture();
  project.script =
    'on startPlay\n wait 1 s\n set the height of page1 to 999\nend startPlay';
  project.pages[0]!.script =
    'on openPage\n wait 1 s\n set the background of me to "Late Page"\nend openPage';
  project.pages[0]!.elements[0]!.script =
    'on click\n wait 1 s\n set the label of me to "Late Element"\nend click';
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  expect((await advance(play)).nextDeadline).toBe(1_000_000n);
  expect(play.group.inspect().scripts.flatMap(s => s.runs)).toHaveLength(3);
  const frozen = structuredClone(play.project);
  play.stop(1_000_000n);
  play.send(play.page.elements[0]!, 'click');
  expect((await advance(play, 2_000_000n)).nextDeadline).toBeUndefined();
  expect(play.project).toEqual(frozen);
  expect(play.group.inspect().scripts.every(s => s.runs.length === 0)).toBe(
    true,
  );
  expect(play.problems).toEqual([]);
});

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
  await advance(play, 20_000_000n);
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
  expect(pending.nextDeadline).toBe(1_000_000n);
  await advance(play, 999_000n);
  expect(play.pageIndex).toBe(0);
  await advance(play, 1_000_000n);
  expect(play.pageIndex).toBe(1);
  await advance(play, 3_000_000n);
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
  await advance(play, 500_000n);
  expect(play.pageIndex).toBe(1);
  expect(play.project.pages[0]!.background).toBe('Closed by project');
  expect(play.problems).toEqual([]);

  const stopped = new PlaySession(project);
  await advance(stopped);
  stopped.send(stopped.page.elements[0]!, 'click');
  await advance(stopped);
  stopped.stop(0n);
  await advance(stopped, 2_000_000n);
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
  await advance(play, 1_000_000n);
  expect(play.pageIndex).toBe(1);
  expect(play.problems).toEqual([]);
});

for (const kind of [
  'text',
  'image',
  'button',
  'rectangle',
  'ellipse',
  'line',
]) {
  test(`elements creates ${kind} with defaults and routes clicks to its Page`, () => {
    const project = fixture();
    project.pages[0]!.script = `on openPage
 ask elements to create "${kind}", thisPage
 set the left of it to 99
end openPage
on click
 set the background of me to "Clicked"
end click`;
    const play = new PlaySession(project);
    drain(play);
    const created = play.page.elements.at(-1)!;
    expect(created).toMatchObject({ kind, left: 99 });
    expect(created.script).toBeUndefined();
    play.send(created, 'click');
    drain(play);
    expect(play.page.background).toBe('Clicked');
    expect(play.problems).toEqual([]);
  });
}

test('clone copies properties and Script, attaches after the creating Pump, and reports against its source', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script = `on click
 set the label of me to "Clone clicked"
end click
on pointerEnter
 put 1 / 0 into x
end pointerEnter`;
  project.pages[0]!.script = `on openPage
 ask elements to clone button1
 send click to it
end openPage
on click
 set the background of me to "Before attachment"
end click`;
  const play = new PlaySession(project);
  drain(play);
  const clone = play.page.elements.at(-1)!;
  expect(clone).toMatchObject({
    name: 'button2',
    left: 60,
    top: 60,
    label: 'Clone clicked',
    script: project.pages[0]!.elements[0]!.script,
  });
  expect(play.page.background).toBe(project.pages[0]!.background);
  play.send(clone, 'click');
  drain(play);
  expect(clone).toHaveProperty('label', 'Clone clicked');
  expect(play.page.elements[0]).toHaveProperty('label', 'Button');
  play.send(clone, 'pointerEnter');
  drain(play);
  expect(play.problems[0]?.owner).toBe(project.pages[0]!.elements[0]);
});

test('find reaches another Page; creation, cloning and deletion never alter authored content', () => {
  const project = fixture();
  const second = createPage('page2');
  second.elements.push(createElement('button', 'remote'));
  project.pages.push(second);
  project.pages[0]!.script = `on openPage
 ask elements to find "remote", page2
 set the label of it to "Found"
 ask elements to clone it
 tell elements to delete button1
 ask elements to create "text", thisPage, "journal"
end openPage`;
  const before = structuredClone(project);
  const play = new PlaySession(project);
  drain(play);
  expect(play.project.pages[1]!.elements[0]).toHaveProperty('label', 'Found');
  expect(play.project.pages[1]!.elements[1]).toHaveProperty('name', 'remote2');
  expect(play.page.elements.map(e => e.name)).toEqual(['text1', 'journal']);
  expect(play.problems).toEqual([]);
  play.stop(0n);
  expect(project).toEqual(before);
  expect(new PlaySession(project).project).toEqual(before);
});

test('deleting the running Element stops immediately and stale handles cannot change it', () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script = `on click
 tell elements to delete me
 set the background of thisPage to "Leaked"
end click`;
  project.pages[0]!.script = `on pointerEnter
 set the label of button1 to "Gone"
end pointerEnter`;
  const play = new PlaySession(project);
  drain(play);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.page.elements.map(e => e.name)).toEqual(['text1']);
  expect(play.page.background).toBe(project.pages[0]!.background);
  play.send(play.page, 'pointerEnter');
  drain(play);
  expect(play.problems).toHaveLength(1);
});

for (const operation of [
  'create "unknown", thisPage',
  'create "button", thisPage, "button1"',
  'create "button", thisPage, "page1"',
  'create "button", thisPage, "elements"',
  'create "button", thisPage, "bad name"',
  'find "missing", thisPage',
  'clone thisPage',
]) {
  test(`invalid elements operation reports a Script error: ${operation}`, () => {
    const project = fixture();
    project.pages[0]!.script = `on openPage\n ask elements to ${operation}\nend openPage`;
    const play = new PlaySession(project);
    drain(play);
    expect(play.problems).toHaveLength(1);
    expect(play.page.elements).toHaveLength(2);
  });
}

test('created messages route immediately after create, through Page to Project', () => {
  const project = fixture();
  project.script =
    'on click\n set the background of page1 to "Project handled"\nend click';
  project.pages[0]!.script = `on openPage
 ask elements to create "button", thisPage
 send click to it
end openPage
on click
 pass click
end click`;
  const play = new PlaySession(project);
  drain(play);
  expect(play.page.background).toBe('Project handled');
  expect(play.problems).toEqual([]);
});

test('off-Page clones load on entry, restart on revisit and retain visual state', async () => {
  const project = fixture();
  const second = createPage('page2');
  const remote = createElement('button', 'remote');
  remote.script = `script variable clicks = 0
on click
 add 1 to clicks
 set the label of me to "" & clicks
end click`;
  second.elements.push(remote);
  project.pages.push(second);
  project.script = `on startPlay
 ask elements to find "remote", page2
 ask elements to clone it
 tell pages to show page2
end startPlay`;
  project.pages[0]!.elements[0]!.script =
    'on click\n tell pages to show page2\nend click';
  second.script =
    'on pointerEnter\n tell pages to show page1\nend pointerEnter';
  const play = new PlaySession(project);
  await advance(play);
  const clone = play.page.elements[1]!;
  play.send(clone, 'click');
  await advance(play);
  expect(clone).toHaveProperty('label', '1');
  play.send(play.page, 'pointerEnter');
  await advance(play);
  expect(play.page.name).toBe('page1');
  play.send(play.page.elements[0]!, 'click');
  await advance(play);
  expect(play.page.name).toBe('page2');
  expect(clone).toHaveProperty('label', '1');
  play.send(clone, 'click');
  await advance(play);
  expect(clone).toHaveProperty('label', '1');
  expect(play.problems).toEqual([]);
});

const soundAsset = (name: string, mediaType = 'audio/mpeg') => ({
  name,
  fileName: `${name}.mp3`,
  hash: (name === 'waves' ? 'a' : 'b').repeat(64),
  mediaType,
  size: 3,
});

test('the sound Grant plays and loops for the owning Script; stop is owner-scoped', () => {
  const project = fixture();
  project.assets.push(soundAsset('waves'), soundAsset('rain'));
  project.pages[0]!.elements[0]!.script = `on click
 tell sound to play "waves"
 tell sound to loop "rain"
end click
on pointerLeave
 tell sound to stop "waves"
end pointerLeave`;
  project.pages[0]!.elements[1]!.script = `on click
 tell sound to stop "rain"
end click`;
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.sounds.playing()).toEqual([
    { owner: 'element:page1/button1', name: 'waves', loop: false },
    { owner: 'element:page1/button1', name: 'rain', loop: true },
  ]);
  // Another Element's Script cannot stop the button's rain.
  play.send(play.page.elements[1]!, 'click');
  drain(play);
  expect(play.sounds.playing().map(s => s.name)).toEqual(['waves', 'rain']);
  play.send(play.page.elements[0]!, 'pointerLeave');
  drain(play);
  expect(play.sounds.playing().map(s => s.name)).toEqual(['rain']);
  play.stop(0n);
  expect(play.sounds.playing()).toEqual([]);
});

for (const bad of ['missing', 'picture']) {
  test(`playing ${bad === 'missing' ? 'a missing sound' : 'an image as a sound'} reports against the Script`, () => {
    const project = fixture();
    project.assets.push(soundAsset('picture', 'image/png'));
    project.pages[0]!.elements[0]!.script = `on click\n tell sound to play "${bad}"\nend click`;
    const play = new PlaySession(project);
    play.send(play.page.elements[0]!, 'click');
    drain(play);
    expect(play.sounds.playing()).toEqual([]);
    expect(play.problems).toHaveLength(1);
    expect(play.problems[0]?.owner).toBe(project.pages[0]!.elements[0]);
  });
}

test('leaving a Page stops its Scripts’ sounds while a Project sound continues', async () => {
  const project = fixture();
  project.assets.push(soundAsset('waves'), soundAsset('rain'));
  project.pages.push(createPage('page2'));
  project.script = `on startPlay
 tell sound to loop "rain"
end startPlay`;
  project.pages[0]!.script = `on openPage
 tell sound to loop "waves"
end openPage`;
  project.pages[0]!.elements[0]!.script = `on click
 tell pages to show page2
end click`;
  const play = new PlaySession(project);
  await advance(play);
  expect(
    play.sounds
      .playing()
      .map(s => s.name)
      .sort(),
  ).toEqual(['rain', 'waves']);
  play.send(play.page.elements[0]!, 'click');
  await advance(play);
  expect(play.page.name).toBe('page2');
  expect(play.sounds.playing()).toEqual([
    { owner: 'project', name: 'rain', loop: true },
  ]);
  expect(play.problems).toEqual([]);
  // Stop silences the rest.
  play.stop(0n);
  expect(play.sounds.playing()).toEqual([]);
});

test('deleting an Element stops its sounds; its Script cannot restart them', () => {
  const project = fixture();
  project.assets.push(soundAsset('waves'));
  project.pages[0]!.elements[0]!.script = `on click
 tell sound to loop "waves"
end click`;
  project.pages[0]!.script = `on pointerEnter
 tell elements to delete button1
end pointerEnter`;
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.sounds.playing()).toHaveLength(1);
  play.send(play.page, 'pointerEnter');
  drain(play);
  expect(play.sounds.playing()).toEqual([]);
  expect(play.page.elements.map(e => e.name)).toEqual(['text1']);
});

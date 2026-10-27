import { expect, test } from 'bun:test';
import { createElement, createPage, createProject } from '../src/model';
import { StackEditor } from '../src/editing';
import { PlaySession } from '../src/play';
import { runProjectTests } from '../src/test-runner';

// A Page whose button flips a label and whose `frame` counts time, and a
// second Page to go to.
const project = (tests: string) => {
  const result = createProject('Tested');
  const page = result.pages[0]!;
  const label = createElement('text', 'label');
  const flip = createElement('button', 'flip');
  page.elements.push(label, flip);
  page.script = `script variable elapsedMs = 0
script variable lastKey = ""
on click
  set the text of label to "flipped"
end click
on keyDown key
  put key into lastKey
end keyDown
on frame ms
  put elapsedMs + ms into elapsedMs
end frame
on explode
  throw {code: "boom"}
end explode
on report
  return {elapsed: elapsedMs, key: lastKey}
end report
`;
  const other = createPage('other');
  other.elements.push(createElement('text', 'welcome'));
  other.script = `on openPage
  set the text of welcome to "arrived"
end openPage
`;
  result.pages.push(other);
  result.testScripts.push({ name: 'page.test', source: tests });
  return result;
};

const run = async (tests: string) =>
  (await runProjectTests(project(tests))).map(r => ({
    test: r.test,
    ok: r.ok,
    line: r.at.line,
    problems: r.problems,
  }));

test('reader input reaches the Page and the Test Script reads it back', async () => {
  expect(
    await run(`use assertEqual from test
on testClick
  ask harness to property "text", "label"
  assertEqual(it, "Text")
  ask harness to click "flip" and wait
  ask harness to property "text", "label"
  assertEqual(it, "flipped")
end testClick
on testKeysAndFrames
  ask harness to key "a" and wait
  ask harness to frame 40 ms and wait
  send report to page1 and wait
  assertEqual(it, {elapsed: 40, key: "a"})
end testKeysAndFrames
on testGoTo
  ask harness to goTo "other" and wait
  ask harness to property "text", "welcome"
  assertEqual(it, "arrived")
end testGoTo
`),
  ).toEqual([
    { test: 'testClick', ok: true, line: 2, problems: [] },
    { test: 'testKeysAndFrames', ok: true, line: 9, problems: [] },
    { test: 'testGoTo', ok: true, line: 15, problems: [] },
  ]);
});

test('a failure names its line, and an error in a Script under test fails too', async () => {
  const results = await run(`use assert from test
on testAssert
  ask harness to click "flip" and wait
  assert(false, "flipped is not enough")
end testAssert
on testPageError
  send explode to page1
end testPageError
on testNoElement
  ask harness to click "nowhere" and wait
end testNoElement
`);
  expect(results.map(r => [r.test, r.ok, r.line])).toEqual([
    ['testAssert', false, 4],
    ['testPageError', false, 6],
    ['testNoElement', false, 10],
  ]);
  expect(results[0]!.problems).toEqual([
    'page.test testAssert errored: {code: "assertion failed"}\n  flipped is not enough',
  ]);
  expect(results[1]!.problems).toEqual([
    'page:page1 explode line 13 errored: {code: "boom"}',
  ]);
  expect(results[2]!.problems[0]).toContain('no such element');
});

test('a Test Script that does not load reports where', async () => {
  expect(await run('on testBroken\n  put into\nend testBroken\n')).toEqual([
    { test: '', ok: false, line: 2, problems: [expect.any(String)] },
  ]);
});

test('every test starts from a fresh Play Session with the seed fixed', async () => {
  const tests = `use assertEqual from test
on testFirst
  ask harness to click "flip" and wait
end testFirst
on testFresh
  ask harness to property "text", "label"
  assertEqual(it, "Text")
end testFresh
`;
  expect((await run(tests)).every(r => r.ok)).toBe(true);
});

test('Play never loads a Test Script', async () => {
  const tested = project(
    'on startPlay\n  throw {code: "loaded"}\nend startPlay\n',
  );
  const play = new PlaySession(tested);
  for (let i = 0; i < 10 && play.pump(0n).state === 'sliced'; i++) {
    await Promise.resolve();
  }
  expect(play.problems).toEqual([]);
  expect([...play.owners.keys()].some(name => name.includes('test'))).toBe(
    false,
  );
});

test('Test Scripts are edited like Libraries, with history', () => {
  const editor = new StackEditor(createProject('Tested'));
  let id = 0;
  editor.edit(({ tree }) => {
    id = tree.addTestScript('rules.test', 'on testA\nend testA\n').id!;
  });
  expect(() =>
    editor.edit(({ tree }) => tree.renameTestScript(id, 'rules')),
  ).toThrow('Use a NorthTalk identifier and then .test');
  editor.edit(({ tree }) => tree.addTestScript('other.test'));
  expect(() =>
    editor.edit(({ tree }) => tree.renameTestScript(id, 'other.test')),
  ).toThrow('Another Test Script already has that name.');
  editor.edit(({ tree }) => tree.setTestScriptSource(id, ''));
  editor.edit(({ tree }) => tree.removeTestScript(id));
  expect(editor.project.testScripts.map(t => t.name)).toEqual(['other.test']);
  editor.undo();
  editor.undo();
  expect(editor.project.testScripts[0]).toMatchObject({
    id,
    name: 'rules.test',
    source: 'on testA\nend testA\n',
  });
});

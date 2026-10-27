import { expect, test } from 'bun:test';
import { createTetrisProject } from '../src/examples/tetris';
import { createElement, createProject } from '../src/model';
import {
  addRecordedTest,
  inputLines,
  Recorder,
  replayRecording,
} from '../src/recorder';
import type { ReaderView } from '../src/test-runner';
import type { Project } from '../src/model';

// A recording replayed and added to `recorded.test`, as Record Test does.
const recordTest = async (
  project: Project,
  recorder: Recorder,
  seen: ReaderView,
  frames: boolean,
) => {
  const recording = await replayRecording(project, recorder, seen, frames);
  const existing = project.testScripts.find(s => s.name === 'recorded.test');
  const added = addRecordedTest(existing?.source, recording.body);
  return {
    ...recording,
    test: { name: added.name, line: added.line },
    script: { name: 'recorded.test', source: added.source },
  };
};
import { runProjectTests } from '../src/test-runner';

// A Recorder on a clock the test moves.
const recording = () => {
  let now = 1000;
  const recorder = new Recorder(() => now);
  return { recorder, wait: (ms: number) => (now += ms) };
};

test('time becomes 16 ms frames, a run of them a repeat, before each input', () => {
  const { recorder, wait } = recording();
  wait(40);
  recorder.key('ArrowLeft');
  wait(10);
  recorder.click('restartButton');
  recorder.unrecorded('typing');
  recorder.unrecorded('typing');
  recorder.pause();
  wait(5000);
  recorder.resume();
  wait(20);
  expect(inputLines(recorder.events, recorder.elapsed, true)).toEqual([
    'repeat 2 times',
    '  ask harness to frame 16 ms and wait',
    'end repeat',
    'ask harness to key "ArrowLeft" and wait',
    'ask harness to frame 16 ms and wait',
    'ask harness to click "restartButton" and wait',
    '-- not recorded: typing',
    'ask harness to frame 16 ms and wait',
  ]);
  // Without a `frame` Handler, time passes with `advance`.
  expect(inputLines(recorder.events, recorder.elapsed, false)[0]).toBe(
    'ask harness to advance 32 ms and wait',
  );
});

test('a Recorded Test of Tetris replays and passes under Run Tests', async () => {
  const { project } = await createTetrisProject();
  const { recorder, wait } = recording();
  for (const key of ['ArrowLeft', 'ArrowLeft', ' ', 'ArrowDown']) {
    wait(250);
    recorder.key(key);
  }
  wait(1500);
  const seen: ReaderView = { page: 'nothing', texts: [], visibility: [] };
  const recorded = await recordTest(project, recorder, seen, true);
  expect(recorded.problems).toEqual([]);
  expect(recorded.drifted).toBe(true);
  expect(recorded.test.name).toBe('testRecording1');
  const source = recorded.script.source;
  expect(source.split('\n')[recorded.test.line - 1]).toBe('on testRecording1');
  expect(source).toContain('ask harness to key " " and wait');
  expect(source).toContain('assertEqual(it, "Score: ');
  const tested = { ...project, testScripts: [recorded.script] };
  const results = await runProjectTests(tested);
  expect(results.map(r => [r.test, r.problems])).toEqual([
    ['testRecording1', []],
  ]);
  // A second recording is added beside the first.
  const again = await recordTest(tested, recorder, seen, true);
  expect(again.test.name).toBe('testRecording2');
  expect(
    (await runProjectTests({ ...project, testScripts: [again.script] })).every(
      r => r.ok,
    ),
  ).toBe(true);
});

test('the assertions cover the Page, texts and changed visibility', async () => {
  const project = createProject('Seen');
  const page = project.pages[0]!;
  const note = createElement('text', 'note');
  const button = createElement('button', 'reveal');
  const secret = createElement('text', 'secret');
  secret.visible = false;
  page.elements.push(note, button, secret);
  page.script = 'on click\n  show secret\nend click\n';
  const { recorder, wait } = recording();
  wait(5);
  recorder.click('reveal');
  const recorded = await recordTest(
    project,
    recorder,
    {
      page: 'page1',
      texts: [
        ['note', 'Text'],
        ['secret', 'Text'],
      ],
      visibility: [['secret', true]],
    },
    false,
  );
  expect(recorded.drifted).toBe(false);
  expect(recorded.script.source).toBe(`use assertEqual from test

on testRecording1
  ask harness to click "reveal" and wait
  ask harness to page
  assertEqual(it, "page1")
  ask harness to property "text", "note"
  assertEqual(it, "Text")
  ask harness to property "text", "secret"
  assertEqual(it, "Text")
  ask harness to property "visible", "secret"
  assertEqual(it, true)
end testRecording1
`);
});

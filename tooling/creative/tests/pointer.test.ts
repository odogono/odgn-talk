import { expect, test } from 'bun:test';
import { clickAdvice } from '../src/click-advice';
import { migrateClickSource, migrateClicks } from '../src/click-migration';
import { createElement, createProject } from '../src/model';
import { migrateProjectJson } from '../src/project-file';
import { runProjectTests } from '../src/test-runner';

test('the migration keeps old click Handlers and sends to the primary button', () => {
  expect(
    migrateClickSource(`on click
  send click to b
  send to b: click
  click
  pass click
end click
`),
  ).toBe(`on click {button: 0}
  send click with {button: 0} to b
  send to b: click {button: 0}
  click {button: 0}
  pass click
end click
`);
});

test('the migration leaves clauses with parameters, other names, computed sends and broken Scripts', () => {
  for (const source of [
    'on click e\nend click\non clicked\nend clicked\n-- on click\n',
    'on t\n  send ("click") to b\n  send click with 1 to b\nend t\n',
    'on click\n  broken (\nend click',
  ]) {
    expect(migrateClickSource(source)).toBe(source);
  }
});

test('format 4 Projects reach format 5 with every Script migrated', () => {
  const migrated = migrateProjectJson({
    format: 4,
    script: 'on click\nend click\n',
    pages: [
      {
        script: 'on click\nend click\n',
        elements: [{ script: 'on click\nend click\n' }],
      },
    ],
    libraries: [{ name: 'l', source: 'function f()\nend f\n' }],
    testScripts: [],
  });
  expect(migrated.format).toBe(5);
  expect(
    JSON.stringify(migrated).match(/on click \{button: 0\}/gu),
  ).toHaveLength(3);
  // The step doesn't change its input.
  const input = { script: 'on click\nend click\n' };
  migrateClicks(input);
  expect(input.script).toBe('on click\nend click\n');
});

const codes = (source: string) => clickAdvice(source).map(d => d.code);

test('advice names click Handlers that every button or no click reaches', () => {
  expect(codes('on click {}\nend click')).toEqual(['click any button']);
  expect(codes('on click\nend click')).toEqual(['click without its map']);
  expect(codes('on click {button: 0}\nend click')).toEqual([]);
  expect(codes('on click e where true\nend click')).toEqual([]);
  expect(
    codes('on click e\nend click\non click {button: 2}\nend click'),
  ).toEqual([]);
});

const sonarLike = (tests: string) => {
  const project = createProject('Pointer');
  const page = project.pages[0]!;
  const cell = createElement('rectangle', 'cell');
  cell.width = 40;
  cell.height = 20;
  const label = createElement('text', 'label');
  page.elements.push(cell, label);
  cell.script = `script variable planted = false
on click {button: 2}
  set the text of label to "flag"
end click
on click {button: 0, x, y}
  if planted then
    put false into planted
  else
    set the text of label to "ping " & x & "," & y
  end if
end click
on pointerHeld {held} where held >= 100 and not planted
  put true into planted
  set the text of label to "held " & held
end pointerHeld
on pointerHeld _
end pointerHeld
`;
  project.testScripts.push({ name: 'pointer.test', source: tests });
  return project;
};

test('the Harness clicks with a button and position, and holds a press', async () => {
  const results = await runProjectTests(
    sonarLike(`use assertEqual from test
on testClicks
  ask harness to click "cell" and wait
  ask harness to property "text", "label"
  assertEqual(it, "ping 20,10")
  ask harness to click "cell", {x: 3, y: 4} and wait
  ask harness to property "text", "label"
  assertEqual(it, "ping 3,4")
  ask harness to click "cell", {button: 2} and wait
  ask harness to property "text", "label"
  assertEqual(it, "flag")
end testClicks
on testHold
  ask harness to hold "cell", 160 ms and wait
  ask harness to property "text", "label"
  assertEqual(it, "held 112")
end testHold
`),
  );
  expect(results.map(r => [r.test, r.ok, r.problems])).toEqual([
    ['testClicks', true, []],
    ['testHold', true, []],
  ]);
});

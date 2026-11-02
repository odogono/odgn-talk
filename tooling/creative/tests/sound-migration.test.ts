// Format 7's rewrite of `tell sound to loop` (ADR 0159, #1896).
import { expect, test } from 'bun:test';
import { createProject } from '../src/model';
import {
  CURRENT_FORMAT,
  migrateProjectJson,
  serializeProject,
  validateProjectJson,
} from '../src/project-file';
import { migrateSoundSource, migrateSounds } from '../src/sound-migration';

test('`tell sound to loop` becomes `play … with {repeat: true}`', () => {
  expect(
    migrateSoundSource('on click\n  tell sound to loop "rain"\nend click'),
  ).toBe(
    'on click\n  tell sound to play "rain" with {repeat: true}\nend click',
  );
  expect(
    migrateSoundSource('on click\n  tell sound to loop name & "x"\nend click'),
  ).toBe(
    'on click\n  tell sound to play name & "x" with {repeat: true}\nend click',
  );
});

test('a `tell sound` block’s `loop` line is rewritten too', () => {
  expect(
    migrateSoundSource(
      'on click\n  tell sound\n    play "bell"\n    loop "waves"\n  end tell\nend click',
    ),
  ).toBe(
    'on click\n  tell sound\n    play "bell"\n    play "waves" with {repeat: true}\n  end tell\nend click',
  );
});

test('other Grants, other Operations and broken Scripts are left alone', () => {
  for (const source of [
    'on click\n  tell bass to loop "c3"\nend click',
    'on click\n  tell sound to play "rain"\nend click',
    'on click\n  tell sound to stop "rain"\nend click',
    'on click\n  loop "bd hh"\nend click',
    'on click\n  tell sound to loop "rain"\n',
  ]) {
    expect(migrateSoundSource(source)).toBe(source);
  }
});

test('a format 6 Project migrates every Script, Group members included', () => {
  const loop = 'on click\n  tell sound to loop "rain"\nend click';
  const repeat =
    'on click\n  tell sound to play "rain" with {repeat: true}\nend click';
  const data = {
    script: loop,
    pages: [
      {
        script: loop,
        elements: [{ script: loop, members: [{ script: loop, members: [] }] }],
      },
    ],
    libraries: [{ source: loop }],
    testScripts: [{ source: loop }],
  };
  expect(migrateSounds(data)).toEqual({
    script: repeat,
    pages: [
      {
        script: repeat,
        elements: [
          { script: repeat, members: [{ script: repeat, members: [] }] },
        ],
      },
    ],
    libraries: [{ source: repeat }],
    testScripts: [{ source: repeat }],
  });
});

test('reading a format 6 file rewrites its loops and saves the current format', () => {
  const project = createProject('Rain');
  project.pages[0]!.script =
    'on openPage\n  tell sound to loop "rain"\nend openPage';
  const json = { ...serializeProject(project), format: 6 };
  const result = validateProjectJson(migrateProjectJson(json));
  if (!('project' in result)) {
    throw new Error(JSON.stringify(result.issues));
  }
  expect(result.project.pages[0]!.script).toBe(
    'on openPage\n  tell sound to play "rain" with {repeat: true}\nend openPage',
  );
  expect(serializeProject(result.project).format).toBe(CURRENT_FORMAT);
});

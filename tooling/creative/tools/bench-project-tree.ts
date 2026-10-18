// Run from the repository root: bun tooling/creative/tools/bench-project-tree.ts
// --check also enforces the Edit hot-path serialization budget.
import { strict as assert } from 'node:assert';
import { StackEditor } from '../src/editing';
import { createElement, createProject, type TextElement } from '../src/model';
import { groupElement } from '../src/tree/rules';

const fixture = () => {
  const project = createProject('Write benchmark');
  const text = createElement('text', 'entry') as TextElement;
  text.richText = Array.from({ length: 100 }, () => ({
    runs: Array.from({ length: 5 }, () => ({ text: 'text '.repeat(20) })),
  }));
  project.pages[0]!.elements = [
    groupElement('panel', [
      text,
      ...Array.from({ length: 998 }, (_, i) =>
        createElement('button', `button${i}`),
      ),
    ]),
  ];
  return project;
};

const steps = 120;
for (const workload of ['drag', 'typing'] as const) {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const editor = new StackEditor(fixture());
    editor.click('panel');
    const entry = editor.element('entry') as TextElement;
    const original = editor.snapshot();
    let clones = 0;
    let serializations = 0;
    const clone = globalThis.structuredClone;
    const stringify = JSON.stringify;
    globalThis.structuredClone = ((...args: Parameters<typeof clone>) => {
      clones++;
      return clone(...args);
    }) as typeof clone;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => {
      serializations++;
      return stringify(...args);
    }) as typeof stringify;
    const start = performance.now();
    try {
      if (workload === 'drag') {
        const gesture = editor.startMove();
        for (let i = 1; i <= steps; i++) {
          gesture.to(i, i);
        }
        gesture.finish();
      } else {
        const edit = editor.startEdit();
        for (let i = 1; i <= steps; i++) {
          const next = entry.richText.map((paragraph, p) =>
            p === 0
              ? { ...paragraph, runs: [{ text: 'typed '.repeat(i) }] }
              : paragraph,
          );
          edit.change(({ tree }) => tree.replaceRichText(entry, next));
        }
        edit.finish();
      }
    } finally {
      globalThis.structuredClone = clone;
      JSON.stringify = stringify;
    }
    const ms = performance.now() - start;
    const result = editor.snapshot();
    editor.undo();
    assert.deepEqual(editor.project, original);
    editor.redo();
    assert.deepEqual(editor.project, result);
    samples.push({ ms, clones, serializations });
  }
  samples.sort((a, b) => a.ms - b.ms);
  const median = samples[2]!;
  console.log(JSON.stringify({ workload, nodes: 1000, steps, ...median }));
  if (process.argv.includes('--check')) {
    assert.equal(median.serializations, 0, 'Edit must not serialize Fuel work');
    assert.equal(
      median.clones,
      workload === 'typing' ? steps + 2 : 0,
      'Clone only typing intake and the two durable history endpoints',
    );
  }
}

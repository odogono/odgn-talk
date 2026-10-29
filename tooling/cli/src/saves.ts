// `northtalk diff-save` and `dump-save` (#1713): where two saves differ, and
// one save as a tree. They read a save from any Core and are outside parity.
import { readFileSync } from 'node:fs';
import {
  decodeSave,
  diffSaves,
  dumpSave as dumpTree,
  type SaveDifference,
} from '@northtalk/tooling/save-diff';

const line = ({ path, a, b }: SaveDifference) => `${path}: ${a} → ${b}`;

/** Prints where two saves differ; exits 1 when their states do. */
export const diffSave = (
  a: string,
  b: string,
  { first, json }: { first: boolean; json: boolean },
): number => {
  const diff = diffSaves(readFileSync(a), readFileSync(b));
  if (first) {
    diff.differences = diff.differences.slice(0, 1);
  }
  if (json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    if (diff.sameState) {
      console.log('same state');
    }
    for (const difference of diff.differences) {
      console.log(line(difference));
    }
    for (const note of diff.notes) {
      console.log(`note: ${line(note)}`);
    }
  }
  return diff.sameState ? 0 : 1;
};

/** Prints a save as an indented tree. */
export const dumpSave = (file: string, json: boolean): number => {
  const save = decodeSave(readFileSync(file));
  console.log(json ? JSON.stringify(save, null, 2) : dumpTree(save));
  return 0;
};

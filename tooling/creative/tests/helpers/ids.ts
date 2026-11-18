// Gives a Project built in a test the session ids the editor's ProjectTree
// would: one counter across Pages, Elements, Libraries, Instruments and Test
// Scripts. Play places Scripts and Libraries by these ids (#2270).
import type { Project } from '../../src/model';
import { allElements } from '../../src/tree/rules';

/** Gives every Page, Element and source without an id one, in place. */
export const giveIds = <P extends Project>(project: P): P => {
  const sources = [
    ...project.instruments,
    ...project.libraries,
    ...project.testScripts,
  ];
  const owners = project.pages.flatMap(page => [
    page,
    ...allElements(page.elements),
  ]);
  let next = Math.max(0, ...[...sources, ...owners].map(o => o.id ?? 0));
  for (const owner of [...sources, ...owners]) {
    owner.id ??= ++next;
  }
  return project;
};

// Compiled with Folio's typecheck; deliberately never invoked at runtime.
import type { StackEditor } from '../src/editing';
import type { PlaySession } from '../src/play';
import type { ProjectTree } from '../src/tree/project-tree';

export const readonlyContract = (
  editor: StackEditor,
  play: PlaySession,
  tree: ProjectTree,
): void => {
  // @ts-expect-error Live views are deeply readonly.
  editor.project.name = 'bypass';
  // @ts-expect-error Structural writes require tree operations.
  editor.page.elements.push(play.elementsOf()[0]!);
  const field = play.elementsOf().find(element => element.kind === 'text');
  if (field) {
    // @ts-expect-error Nested rich text cannot bypass copy-work accounting.
    field.richText[0]!.runs[0]!.text = 'bypass';
  }
  // @ts-expect-error Runtime maps cannot be mutated by consumers.
  play.objects.clear();
  const object = play.objects.get(play.page)!;
  // @ts-expect-error Core native values expose the same readonly contract.
  object.native.name = 'bypass';
  // @ts-expect-error Owner map values are readonly too.
  play.owners.values().next().value!.name = 'bypass';
  // @ts-expect-error Authored owner views are readonly too.
  play.authored.values().next().value!.name = 'bypass';
  // @ts-expect-error Signal state exposes deeply readonly Project data.
  editor.state.value.project.pages[0]!.elements[0]!.name = 'bypass';
  // @ts-expect-error Selected Elements are readonly views.
  editor.selected[0]!.name = 'bypass';
  // @ts-expect-error Snapshot arrays are readonly.
  editor.snapshot().pages.splice(0, 1);
  // @ts-expect-error Captured assets are deeply readonly.
  editor.capture().project.assets[0]!.hash = 'bypass';
  const page = tree.project.pages[0]!;
  // @ts-expect-error Tree Project views are deeply readonly.
  tree.project.pages[0]!.background = 'bypass';
  // @ts-expect-error Indexed collections are readonly arrays.
  tree.elementsOf(page).pop();
  // @ts-expect-error Member views cannot bypass structural operations.
  tree.membersOf(page)[0]!.name = 'bypass';
  // @ts-expect-error Owner lookup returns readonly views.
  tree.owner(0)!.script = 'bypass';
  const element = tree.find(page, 'element')!;
  // @ts-expect-error Parent lookup returns readonly views.
  tree.parentOf(element)!.name = 'bypass';
  // @ts-expect-error Page lookup returns readonly views.
  tree.pageOf(element)!.elements.length = 0;
  // @ts-expect-error Outer lookup returns readonly views.
  tree.outerOf(element)!.name = 'bypass';
  if (element.kind === 'group') {
    // @ts-expect-error Recursive union members remain deeply readonly.
    element.members[0]!.left = 0;
    // @ts-expect-error Group membership is readonly too.
    element.members.push(element);
  }
  // @ts-expect-error Clone pairs expose readonly source and destination nodes.
  tree.clone(element).pairs[0]![1].name = 'bypass';
  tree.subscribe(change => {
    // @ts-expect-error Change notifications expose readonly owner views.
    change.owners[0]!.name = 'bypass';
    // @ts-expect-error Journal arrays are readonly.
    change.changes.pop();
    const entry = change.changes[0]!;
    if (entry.kind === 'children') {
      // @ts-expect-error Nested journal payloads are readonly too.
      entry.nodes[0]!.children!.push(entry.nodes[0]!);
    }
  });
  editor.edit(edit => {
    // @ts-expect-error Authoring callbacks expose views, not mutable Projects.
    edit.project.designWidth = 1;
  });
};

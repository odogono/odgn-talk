// Compiled with Folio's typecheck; deliberately never invoked at runtime.
import type { StackEditor } from '../src/editing';
import type { PlaySession } from '../src/play';

export const readonlyContract = (
  editor: StackEditor,
  play: PlaySession,
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
  editor.edit(edit => {
    // @ts-expect-error Authoring callbacks expose views, not mutable Projects.
    edit.project.designWidth = 1;
  });
};

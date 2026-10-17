import { type Immutable } from 'immer';
import { scriptNameProblems } from './script-names';
import type { EditorView } from '@codemirror/view';
import { h } from './dom';
import type { Project } from './model';
import {
  recipeEdit,
  recipePlacement,
  recipeSource,
  recipeTargets,
  SOUND_RECIPE_KINDS,
  type RecipeKind,
} from './recipes';
import type { ScriptOwner } from './script-manifest';

/** A disposable picker: no Recipe metadata is saved in the Project. */
export const openRecipePicker = (
  parent: HTMLElement,
  view: EditorView,
  project: Immutable<Project>,
  owner: ScriptOwner,
  readOnly: () => boolean,
): void => {
  parent.replaceChildren();
  const problems = scriptNameProblems(project);
  if (problems.length) {
    parent.append(
      h('p', { role: 'status' }, problems.map(p => p.message).join(' ')),
    );
    return;
  }
  const kind = h(
    'select',
    { 'aria-label': 'Action' },
    ...(
      [
        'navigate',
        'show',
        'hide',
        'text',
        'playSound',
        'loopSound',
        'stopSound',
      ] as const
    )
      .filter(
        value =>
          owner !== project ||
          value === 'navigate' ||
          SOUND_RECIPE_KINDS.includes(value),
      )
      .map(value =>
        h(
          'option',
          { value },
          {
            navigate: 'Go to a Page',
            show: 'Show an Element',
            hide: 'Hide an Element',
            text: 'Change text',
            playSound: 'Play a sound',
            loopSound: 'Loop a sound',
            stopSound: 'Stop a sound',
          }[value],
        ),
      ),
  );
  const target = h('select', { 'aria-label': 'Target' });
  const value = h('textarea', { 'aria-label': 'New text', rows: 2 });
  const textLabel = h('label', {}, 'New text', value);
  const position = h('select', { 'aria-label': 'Insertion position' });
  const positionLabel = h('label', {}, 'Insert at', position);
  const guidance = h('p', { class: 'muted' });
  const preview = h('pre', {
    class: 'recipe-preview',
    'aria-label': 'Source preview',
  });
  const previewButton = h('button', { type: 'button' }, 'Preview insertion');
  const apply = h(
    'button',
    { type: 'button', disabled: true },
    'Insert action',
  );
  const cancel = h('button', { type: 'button' }, 'Cancel');
  const status = h('p', { role: 'status' });
  let prepared:
    | { from: number; insert: string; signature: string; source: string }
    | undefined;
  const signature = () =>
    JSON.stringify(recipeTargets(project, owner, kind.value as RecipeKind));
  const clear = () => {
    prepared = undefined;
    apply.disabled = true;
    preview.replaceChildren();
  };
  const configure = () => {
    clear();
    const action = kind.value as RecipeKind;
    const targets = recipeTargets(project, owner, action);
    target.replaceChildren(
      ...targets.map((item, index) =>
        h(
          'option',
          { value: index, selected: item.reference === 'me' },
          item.name,
        ),
      ),
    );
    textLabel.hidden = action !== 'text';
    const placement = recipePlacement(view.state.doc.toString());
    position.replaceChildren(
      ...(placement.kind === 'simple'
        ? [
            h(
              'option',
              { value: 'start', selected: action !== 'navigate' },
              'Start of handler',
            ),
            h(
              'option',
              { value: 'end', selected: action === 'navigate' },
              'End of handler',
            ),
          ]
        : [
            h(
              'option',
              { value: placement.kind },
              placement.kind === 'new' ? 'New click handler' : 'Current cursor',
            ),
          ]),
    );
    positionLabel.hidden = placement.kind === 'new';
    guidance.textContent = [
      !('kind' in owner)
        ? 'This handler receives clicks passed up the Element → Page → Project Message Path.'
        : '',
      action === 'text'
        ? 'Replacing a text Element’s contents clears mixed formatting.'
        : '',
      SOUND_RECIPE_KINDS.includes(action)
        ? 'Sounds a Page or Element Script starts stop when the reader leaves that Page; sounds the Project Script starts keep playing.'
        : '',
      'Navigation stops the outgoing Page’s Scripts, so action order matters.',
      placement.kind === 'simple'
        ? 'Choose a position, then preview the insertion.'
        : placement.kind === 'cursor'
          ? 'This Script needs explicit placement. Put the cursor where the action belongs in a click handler, then choose Use current cursor and preview. No handler will be added.'
          : 'A new click handler will be created.',
    ]
      .filter(Boolean)
      .join(' ');
    previewButton.textContent =
      placement.kind === 'cursor'
        ? 'Use current cursor and preview'
        : 'Preview insertion';
    previewButton.disabled = !targets.length || readOnly();
    status.textContent = targets.length
      ? ''
      : SOUND_RECIPE_KINDS.includes(action)
        ? 'No sounds in this Project yet. Add one with Add sound… in Info when no Element is selected.'
        : 'There are no matching Elements on this Page.';
  };
  kind.addEventListener('change', configure);
  for (const input of [target, value, position]) {
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }
  previewButton.addEventListener('click', () => {
    clear();
    if (readOnly()) {
      return;
    }
    const chosen = recipeTargets(project, owner, kind.value as RecipeKind)[
      Number(target.value)
    ];
    if (!chosen) {
      configure();
      return;
    }
    try {
      const source = view.state.doc.toString();
      const edit = recipeEdit(
        source,
        recipeSource(kind.value as RecipeKind, chosen, value.value),
        position.value as 'new' | 'start' | 'end' | 'cursor',
        view.state.selection.main.head,
      );
      prepared = { source, ...edit, signature: signature() };
      preview.replaceChildren(
        source.slice(0, edit.from),
        h('mark', {}, edit.insert),
        source.slice(edit.from),
      );
      apply.disabled = false;
      status.textContent =
        'Highlighted source will be inserted as one undoable edit.';
    } catch (error) {
      status.textContent = String(error);
    }
  });
  apply.addEventListener('click', () => {
    if (readOnly()) {
      return;
    }
    if (
      !prepared ||
      prepared.source !== view.state.doc.toString() ||
      prepared.signature !== signature()
    ) {
      configure();
      status.textContent =
        'The Script or targets changed. Choose a position and preview again.';
      return;
    }
    const { from, insert } = prepared;
    parent.replaceChildren();
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from, head: from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
  });
  cancel.addEventListener('click', () => parent.replaceChildren());
  parent.append(
    h(
      'div',
      { class: 'recipe-picker' },
      h('strong', {}, 'When clicked…'),
      h('label', {}, 'Action', kind),
      h('label', {}, 'Target', target),
      textLabel,
      guidance,
      positionLabel,
      h('div', { class: 'row' }, previewButton, apply, cancel),
      status,
      preview,
    ),
  );
  configure();
  kind.focus();
};

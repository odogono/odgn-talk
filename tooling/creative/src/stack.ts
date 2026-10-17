// The Stack editor shell (#749), in the layout the UI prototype chose for
// #154: the Page on a desk, floating Tools and Info windows, and a strip of
// Pages. The edits themselves live in `editing.ts`; this file draws them and
// turns pointer and form events into them.
import { effect, signal, untracked } from '@preact/signals-core';
import { type Immutable } from 'immer';
import {
  HANDLES,
  PAGE_HANDLES,
  MIN_PAGE_WIDTH,
  MIN_PAGE_HEIGHT,
  labelSuggestion,
  pageOf,
  selectedOf,
  StackEditor,
  type Edit,
  type Gesture,
  type Handle,
  type PageHandle,
  type NameCheck,
} from './editing';
import {
  ELEMENT_KINDS,
  hasBorder,
  isTextAlign,
  plainTextOf,
  replacePlainText,
  setTextAlign,
  TEXT_ALIGNS,
  textAlignOf,
  type Element,
  type ElementKind,
  type Page,
  type Project,
  type TextAlign,
  type TextElement,
  textOf,
} from './model';
import { ImageAssets, IMAGE_ACCEPT, importImage } from './images';
import { importSound, isSoundAsset, SOUND_ACCEPT } from './sounds';
import { ScriptWindows } from './scripts';
import { bringWindowForward, mountWindows } from './windows';
import type { ScriptOwner } from './script-manifest';
import { commandForKey, type EditingCommand } from './shortcuts';

import { type Attributes, byId, h } from './dom';
import { renderRichText } from './rich-text-dom';
import { ElementTextControls, InPlaceTextEditor } from './text-editor';

const KIND_NAMES: Record<ElementKind, string> = {
  text: 'Text',
  image: 'Image',
  button: 'Button',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
};
const ALIGN_LABELS: Record<TextAlign, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  justify: 'Justified',
};

const KIND_ICONS: Record<ElementKind, string> = {
  text: 'T',
  image: '▨',
  button: '▭',
  rectangle: '■',
  ellipse: '●',
  line: '╱',
};

const FONTS = ['sans-serif', 'serif', 'monospace', 'cursive'];

const SVG = 'http://www.w3.org/2000/svg';

/** An Element as the reader would see it, positioned in design pixels. */
export const renderElement = (
  element: Immutable<Element>,
  imageUrl?: string,
): HTMLElement => {
  const node = h('div', {
    class: `el ${element.kind}${element.visible ? '' : ' hidden'}`,
    'data-element': element.name,
  });
  Object.assign(node.style, {
    left: `${element.left}px`,
    top: `${element.top}px`,
    width: `${element.width}px`,
    height: `${element.height}px`,
  });
  switch (element.kind) {
    case 'text':
      Object.assign(node.style, {
        color: element.textColor,
        fontFamily: element.font,
        fontSize: `${element.textSize}px`,
      });
      renderRichText(node, element.richText);
      break;
    case 'image':
      if (imageUrl) {
        node.append(
          h('img', { src: imageUrl, alt: element.image, draggable: 'false' }),
        );
        node.addEventListener('contextmenu', event => event.preventDefault());
      } else {
        node.append(
          h(
            'span',
            {},
            element.image ? `Missing image: ${element.image}` : 'Image',
          ),
          h(
            'button',
            { type: 'button', 'data-replace-image': element.name },
            'Replace…',
          ),
        );
      }
      break;
    case 'button':
      Object.assign(node.style, {
        background: element.fill,
        color: element.textColor,
      });
      node.append(element.label);
      break;
    case 'rectangle':
    case 'ellipse':
      Object.assign(node.style, {
        background: element.fill,
        borderColor: element.stroke,
        borderWidth: `${element.thickness}px`,
      });
      break;
    case 'line': {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
      for (const width of [
        Math.max(12, element.thickness),
        element.thickness,
      ]) {
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '0');
        line.setAttribute('x2', String(element.width));
        line.setAttribute('y2', String(element.height));
        line.setAttribute('stroke', element.stroke);
        line.setAttribute('stroke-width', String(width));
        svg.append(line);
      }
      // The first, wider line is transparent: it makes a thin line easy to grab.
      svg.firstElementChild!.setAttribute('class', 'hit');
      node.append(svg);
      break;
    }
  }
  return node;
};

/** A Page at design size, unscaled. */
const renderPage = (
  page: Immutable<Page>,
  designWidth: number,
  into: HTMLElement,
  project: Immutable<Project>,
  images: ImageAssets,
) => {
  into.replaceChildren(
    ...page.elements.map(element =>
      renderElement(
        element,
        element.kind === 'image'
          ? images.url(project.assets.find(a => a.name === element.image))
          : undefined,
      ),
    ),
  );
  Object.assign(into.style, {
    width: `${designWidth}px`,
    height: `${page.height}px`,
    background: page.background,
  });
};

const THUMBNAIL_WIDTH = 96;

type WindowPositions = Record<string, { left: number; top: number }>;
const WINDOWS_KEY = 'northtalk-creative-windows';

/**
 * Makes each `.window` draggable by its title bar, and keeps where it was
 * put across reloads.
 */
const floatWindows = () => {
  let positions: WindowPositions = {};
  try {
    positions = JSON.parse(
      localStorage.getItem(WINDOWS_KEY) ?? '{}',
    ) as WindowPositions;
  } catch {
    /* Positions are optional. */
  }
  const place = (win: HTMLElement, left: number, top: number) => {
    const header = byId('menu').offsetHeight;
    // Keep the whole window on screen where it fits.
    const clampedLeft = Math.max(
      0,
      Math.min(left, window.innerWidth - win.offsetWidth),
    );
    const clampedTop = Math.min(Math.max(header, top), window.innerHeight - 24);
    win.style.left = `${clampedLeft}px`;
    win.style.top = `${clampedTop}px`;
    win.style.setProperty('--window-left', `${clampedLeft}px`);
    win.style.setProperty('--window-top', `${clampedTop}px`);
  };
  const register = (win: HTMLElement) => {
    const saved = positions[win.id];
    if (saved) {
      place(win, saved.left, saved.top);
    } else {
      place(
        win,
        win.dataset.right === undefined
          ? Number(win.dataset.left ?? 16)
          : window.innerWidth - win.offsetWidth - Number(win.dataset.right),
        Number(win.dataset.top ?? 48),
      );
    }
    const bar = win.querySelector<HTMLElement>('.bar')!;
    bar.addEventListener('pointerdown', down => {
      if ((down.target as HTMLElement).closest('button')) {
        return;
      }
      down.preventDefault();
      bar.setPointerCapture(down.pointerId);
      const start = { left: win.offsetLeft, top: win.offsetTop };
      const move = (event: PointerEvent) =>
        place(
          win,
          start.left + event.clientX - down.clientX,
          start.top + event.clientY - down.clientY,
        );
      const up = () => {
        bar.removeEventListener('pointermove', move);
        positions[win.id] = { left: win.offsetLeft, top: win.offsetTop };
        try {
          localStorage.setItem(WINDOWS_KEY, JSON.stringify(positions));
        } catch {
          /* Optional. */
        }
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up, { once: true });
      bar.addEventListener('pointercancel', up, { once: true });
    });
    win.addEventListener('pointerdown', () => {
      bringWindowForward(win);
    });
  };
  document.querySelectorAll<HTMLElement>('.window').forEach(register);
  document.addEventListener('script-window-opened', event => {
    const win = event.target as HTMLElement;
    register(win);
    bringWindowForward(win);
  });
  window.addEventListener('resize', () => {
    for (const win of document.querySelectorAll<HTMLElement>('.window')) {
      place(win, win.offsetLeft, win.offsetTop);
    }
  });
};

// Info window fields; each input carries the property it edits.
const field = (
  label: string,
  input: HTMLElement,
  className = 'field',
): HTMLElement => h('label', { class: className }, h('span', {}, label), input);

const input = (
  name: string,
  value: string | number,
  type = 'text',
  extra: Attributes = {},
) => h('input', { type, 'data-field': name, value, ...extra });

const color = (name: string, value: string) =>
  input(name, /^#[0-9a-f]{6}$/iu.test(value) ? value : '#000000', 'color');

const checkbox = (name: string, label: string, checked: boolean) =>
  h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', 'data-field': name, checked }),
    label,
  );

/** The Page index of a strip thumbnail an event happened on. */
const pageIndexOf = (event: Event) => {
  const index = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-page]',
  )?.dataset.page;
  return index === undefined ? undefined : Number(index);
};
/** A refused name: what the author typed, and why it was refused. */
type Refusal = { attempted: string; check: NameCheck & { ok: false } };

export type PlayMode = 'browse' | 'present';

/** The mounted shell: the editor, a redraw, and read-only switching. */
export type StackShell = {
  editor: StackEditor;
  images: ImageAssets;
  onRedraw(listener: () => void): void;
  openScript(owner: ScriptOwner, line?: number): void;
  readOnly: boolean;
  redraw(): void;
  /**
   * Starts or ends a Play Session. Browsing keeps the Tools and Script
   * windows, and Scripts stay editable for the next session; presenting
   * hides the editor and makes it read-only.
   */
  setPlaying(mode: PlayMode | undefined): void;
  setReadOnly(readOnly: boolean): void;
};

/**
 * Mounts the editor shell on the page's desk, strip and windows. A
 * read-only shell still selects and navigates, but every way of changing
 * the Project is closed off: another tab holds its edit lock (#752), or an
 * earlier version is being previewed.
 */
export const mountStack = (
  initialProject: Immutable<Project>,
  options: { readOnly?: boolean } = {},
): StackShell => {
  const editor = new StackEditor(initialProject);
  const redrawVersion = signal(0);
  const redrawListeners = new Set<() => void>();
  const images = new ImageAssets();
  const scripts = new ScriptWindows(editor, () => draw());
  window.addEventListener('pagehide', event => {
    stopPreview();
    if (!event.persisted) {
      images.dispose();
    }
  });
  let readOnly = options.readOnly ?? false;
  let playing: PlayMode | undefined;
  editor.readOnly = readOnly;
  const desk = byId('desk');
  const stage = byId('stage');
  const pageNode = byId('page');
  const info = byId('info') as HTMLFormElement;
  const thumbnails = byId('thumbnails');
  let pointerElement: string | undefined;
  // The Edit-time sound preview: one voice, never a Script (those run in Play).
  let preview: { audio: HTMLAudioElement; name: string } | undefined;
  const stopPreview = () => {
    preview?.audio.pause();
    preview = undefined;
  };
  let activeText: InPlaceTextEditor | undefined;
  let textControls: ElementTextControls | undefined;
  const historyOf = (element: Immutable<TextElement>) =>
    editor.textHistory(element);
  const closeText = () => {
    activeText?.destroy();
    activeText = undefined;
  };
  const openScript = (owner: ScriptOwner) => {
    closeText();
    scripts.open(owner);
  };
  let scale = 1;
  let refusal: Refusal | undefined;
  let fieldEdit: Edit | undefined;
  const finishFieldEdit = () => {
    fieldEdit?.finish();
    fieldEdit = undefined;
  };

  const fit = () => {
    const style = getComputedStyle(desk);
    const room =
      desk.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    scale = Math.min(1, Math.max(0.1, room / editor.project.designWidth));
    pageNode.style.transform = `scale(${scale})`;
    stage.style.width = `${editor.project.designWidth * scale}px`;
    byId('caption').style.width = stage.style.width;
    stage.style.height = `${editor.page.height * scale}px`;
    desk.style.setProperty('--scale', String(scale));
  };

  const drawPage = () => {
    renderPage(
      editor.page,
      editor.project.designWidth,
      pageNode,
      editor.project,
      images,
    );
    const selected = editor.selected;
    stage.querySelector('.page-handles')?.remove();
    if (!selected.length && !editor.readOnly) {
      stage.append(
        h(
          'div',
          { class: 'page-handles' },
          ...PAGE_HANDLES.map(handle => {
            const dimension =
              handle === 's'
                ? 'height'
                : handle.length === 1
                  ? 'width (all Pages)'
                  : 'width (all Pages) and height';
            return h('button', {
              type: 'button',
              class: `handle ${handle}`,
              'data-page-handle': handle,
              'aria-label': `Resize Page ${dimension}`,
              title: `Resize Page ${dimension}. Arrow keys resize; Shift for 10 pixels.`,
            });
          }),
        ),
      );
    }
    for (const element of selected) {
      pageNode
        .querySelector(`[data-element="${CSS.escape(element.name)}"]`)
        ?.classList.add('selected');
    }
    const [single] = selected;
    if (single && selected.length === 1 && !editor.readOnly) {
      // Handles sit over the Element rather than in it, which may clip them.
      const box = h(
        'div',
        { class: 'handles' },
        ...HANDLES.map(handle =>
          h('span', { class: `handle ${handle}`, 'data-handle': handle }),
        ),
      );
      Object.assign(box.style, {
        left: `${single.left}px`,
        top: `${single.top}px`,
        width: `${single.width}px`,
        height: `${single.height}px`,
      });
      pageNode.append(box);
    }
    byId('page-name').textContent = editor.page.name;
    byId('page-number').textContent =
      `${editor.pageIndex + 1} / ${editor.project.pages.length}`;
    fit();
  };

  const drawStrip = () => {
    const scaleDown = THUMBNAIL_WIDTH / editor.project.designWidth;
    thumbnails.replaceChildren(
      ...editor.project.pages.map((page, index) => {
        const miniature = h('div', { class: 'page' });
        renderPage(
          page,
          editor.project.designWidth,
          miniature,
          editor.project,
          images,
        );
        miniature.style.transform = `scale(${scaleDown})`;
        const frame = h('div', { class: 'thumbnail' }, miniature);
        frame.style.height = `${Math.min(72, page.height * scaleDown)}px`;
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              draggable: 'true',
              'data-page': index,
              'aria-current': index === editor.pageIndex ? 'page' : undefined,
              title: `Show ${page.name}; drag to reorder`,
            },
            frame,
            h('span', {}, `${index + 1}. ${page.name}`),
          ),
        );
      }),
    );
    (byId('previous-page') as HTMLButtonElement).disabled =
      editor.pageIndex === 0;
    (byId('next-page') as HTMLButtonElement).disabled =
      editor.pageIndex === editor.project.pages.length - 1;
  };

  /** The name field, with the refusal message and its suggestion if any. */
  const nameField = (current: string, offer?: string) => {
    const shown = refusal?.attempted ?? current;
    const parts = [
      field(
        'Name',
        input('name', shown, 'text', {
          spellcheck: 'false',
          autocomplete: 'off',
          'aria-invalid': refusal ? 'true' : undefined,
          'aria-describedby': refusal ? 'name-problem' : undefined,
        }),
      ),
    ];
    const suggestion = refusal?.check.suggestion ?? offer;
    if (refusal) {
      parts.push(
        h(
          'p',
          { class: 'problem', id: 'name-problem', role: 'alert' },
          refusal.check.message,
        ),
      );
    }
    if (suggestion) {
      parts.push(
        h(
          'p',
          { class: 'suggestion' },
          refusal ? 'Try ' : 'Suggested from the label: ',
          h(
            'button',
            { type: 'button', 'data-rename': suggestion },
            suggestion,
          ),
        ),
      );
    }
    return parts;
  };

  const elementInfo = (element: Immutable<Element>): HTMLElement[] => {
    const kind: HTMLElement[] = [];
    switch (element.kind) {
      case 'text':
        kind.push(
          h(
            'button',
            { type: 'button', 'data-edit-text': element.name },
            'Edit formatted text',
          ),
          field(
            'Plain text (replaces formatting)',
            h(
              'textarea',
              { 'data-field': 'text', rows: 4 },
              plainTextOf(element.richText),
            ),
          ),
          field(
            'Font',
            h(
              'select',
              { 'data-field': 'font' },
              ...[...new Set([element.font, ...FONTS])].map(font =>
                h(
                  'option',
                  { value: font, selected: font === element.font },
                  font,
                ),
              ),
            ),
          ),
          field(
            'Alignment (all paragraphs)',
            h(
              'select',
              { 'data-field': 'textAlign' },
              ...TEXT_ALIGNS.map(align =>
                h(
                  'option',
                  {
                    value: align,
                    selected: align === textAlignOf(element),
                  },
                  ALIGN_LABELS[align],
                ),
              ),
            ),
          ),
          h(
            'div',
            { class: 'row' },
            field(
              'Size',
              input('textSize', element.textSize, 'number', { min: 1 }),
            ),
            field('Colour', color('textColor', element.textColor)),
          ),
          checkbox('editable', 'Reader can edit', element.editable),
        );
        break;
      case 'image':
        kind.push(
          h(
            'button',
            { type: 'button', 'data-replace-image': element.name },
            'Replace image…',
          ),
        );
        break;
      case 'button':
        kind.push(
          field('Label', input('label', element.label)),
          h(
            'div',
            { class: 'row' },
            field('Fill', color('fill', element.fill)),
            field('Text', color('textColor', element.textColor)),
          ),
        );
        break;
      case 'rectangle':
      case 'ellipse':
        kind.push(
          h(
            'div',
            { class: 'row' },
            field('Fill', color('fill', element.fill)),
            field('Stroke', color('stroke', element.stroke)),
          ),
          field(
            'Thickness',
            input('thickness', element.thickness, 'number', { min: 0 }),
          ),
        );
        break;
      case 'line':
        kind.push(
          h(
            'div',
            { class: 'row' },
            field('Stroke', color('stroke', element.stroke)),
            field(
              'Thickness',
              input('thickness', element.thickness, 'number', { min: 1 }),
            ),
          ),
        );
        break;
    }
    return [
      h('h2', {}, `${KIND_NAMES[element.kind]} “${element.name}”`),
      h(
        'button',
        { type: 'button', 'data-script': 'element', 'data-view-only': '' },
        'Edit Script',
      ),
      h(
        'button',
        { type: 'button', 'data-script': 'element', 'data-recipe': '' },
        'Add action…',
      ),
      ...nameField(
        element.name,
        element.kind === 'button'
          ? labelSuggestion(editor.page, element, editor.project)
          : undefined,
      ),
      h(
        'div',
        { class: 'grid' },
        ...(['left', 'top', 'width', 'height'] as const).map(key =>
          field(
            key[0]!.toUpperCase() + key.slice(1),
            input(key, element[key], 'number'),
          ),
        ),
      ),
      ...kind,
      checkbox('visible', 'Visible', element.visible),
    ];
  };

  const pageInfo = (page: Immutable<Page>): HTMLElement[] => [
    h(
      'h2',
      {},
      `Page ${editor.pageIndex + 1} of ${editor.project.pages.length}`,
    ),
    ...nameField(page.name),
    h(
      'button',
      { type: 'button', 'data-script': 'page', 'data-view-only': '' },
      'Edit Page Script',
    ),
    h(
      'button',
      { type: 'button', 'data-script': 'page', 'data-recipe': '' },
      'Add action…',
    ),
    h(
      'div',
      { class: 'row' },
      field(
        'Height',
        input('pageHeight', page.height, 'number', { min: MIN_PAGE_HEIGHT }),
      ),
      field('Background', color('background', page.background)),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          'data-move-page': -1,
          disabled: editor.pageIndex === 0,
        },
        '← Earlier',
      ),
      h(
        'button',
        {
          type: 'button',
          'data-move-page': 1,
          disabled: editor.pageIndex === editor.project.pages.length - 1,
        },
        'Later →',
      ),
    ),
    h('h2', {}, 'Project'),
    h(
      'button',
      { type: 'button', 'data-script': 'project', 'data-view-only': '' },
      'Edit Project Script',
    ),
    h(
      'button',
      { type: 'button', 'data-script': 'project', 'data-recipe': '' },
      'Add action…',
    ),
    field('Title', input('projectName', editor.project.name)),
    field(
      'Design width',
      input('designWidth', editor.project.designWidth, 'number', {
        min: MIN_PAGE_WIDTH,
      }),
    ),
    h('h2', {}, 'Sounds'),
    ...(editor.project.assets.filter(isSoundAsset).length
      ? editor.project.assets.filter(isSoundAsset).map(asset =>
          h(
            'div',
            { class: 'row' },
            h('span', {}, `${asset.name} (${asset.fileName})`),
            h(
              'button',
              {
                type: 'button',
                'data-preview-sound': asset.name,
                'data-view-only': '',
              },
              preview?.name === asset.name ? 'Stop' : 'Preview',
            ),
          ),
        )
      : [h('p', { class: 'muted' }, 'No sounds yet.')]),
    h('button', { type: 'button', 'data-add-sound': '' }, 'Add sound…'),
    h(
      'p',
      { class: 'muted' },
      'Scripts play a sound by its name, like tell sound to play "waves". Add action… can write that for you.',
    ),
    h(
      'p',
      { class: 'muted' },
      'Click an Element to select it; Shift-click selects several.',
    ),
  ];

  const drawInfo = () => {
    const focused = (document.activeElement as HTMLElement | null)?.dataset
      .field;
    const selected = editor.selected;
    info.replaceChildren(
      ...(selected.length === 1
        ? elementInfo(selected[0]!)
        : selected.length > 1
          ? [
              h('h2', {}, `${selected.length} Elements`),
              h('p', {}, selected.map(e => e.name).join(', ')),
              h('p', { class: 'muted' }, 'Drag any of them to move them all.'),
            ]
          : pageInfo(editor.page)),
    );
    if (editor.readOnly) {
      for (const control of info.querySelectorAll<
        | HTMLButtonElement
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >('button, input, select, textarea')) {
        control.disabled = !control.hasAttribute('data-view-only');
      }
    } else if (focused) {
      info.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
    }
  };

  // Formatting controls for one selected text Element; while it is edited in
  // place, the InPlaceTextEditor drives them instead.
  const drawTextControls = () => {
    const [element, ...others] = editor.selected;
    const target =
      !editor.readOnly &&
      !activeText &&
      !others.length &&
      element?.kind === 'text'
        ? element
        : undefined;
    if (textControls?.history.element !== target) {
      textControls?.destroy();
      textControls =
        target &&
        new ElementTextControls(byId('text-toolbar'), historyOf(target), () =>
          draw(),
        );
    }
    textControls?.update();
  };

  const draw = () => {
    redrawVersion.value++;
  };
  const drawNow = () => {
    if (
      activeText &&
      !editor.selected.some(e => e.id === activeText!.history.element.id)
    ) {
      closeText();
    }
    byId('project-title').textContent = editor.project.name;
    pageNode.classList.toggle('edit', !editor.readOnly);
    (byId('add-page') as HTMLButtonElement).disabled = editor.readOnly;
    for (const button of byId('tools').querySelectorAll('button')) {
      button.disabled = editor.readOnly;
    }
    if (!activeText) {
      drawPage();
    }
    drawStrip();
    if (!fieldEdit) {
      drawInfo();
    }
    drawCommands();
    drawTextControls();
    scripts.sync();
    for (const listener of redrawListeners) {
      listener();
    }
  };

  /** Applies an edit, forgetting any refused name, then redraws. */
  const edit = (change: () => void) => {
    closeText();
    refusal = undefined;
    change();
    draw();
  };

  const rename = (name: string) => {
    closeText();
    const [element] = editor.selected;
    const check =
      editor.selection.length === 1
        ? editor.renameElement(element!.name, name)
        : editor.renamePage(name);
    refusal = check.ok ? undefined : { attempted: name, check };
    draw();
  };

  // A form field changed: write it to the selected Element, or to the Page.
  const write = (target: HTMLInputElement, live: boolean) => {
    const key = target.dataset.field;
    if (!key || key === 'name') {
      return;
    }
    closeText();
    const number = Number(target.value);
    const isNumber = target.type === 'number';
    if (isNumber && (target.value === '' || !Number.isFinite(number))) {
      return;
    }
    const value =
      target.type === 'checkbox'
        ? target.checked
        : isNumber
          ? Math.round(number)
          : target.value;
    fieldEdit ??= editor.startEdit();
    fieldEdit.change(draft => {
      const { project } = draft;
      const page = pageOf(draft);
      const [element] = selectedOf(draft);
      if (element && editor.selection.length === 1) {
        if (key === 'text' && element.kind === 'text') {
          if (textOf(element) !== value) {
            replacePlainText(element, String(value));
          }
        } else if (key === 'textAlign' && element.kind === 'text') {
          if (isTextAlign(value)) {
            setTextAlign(element, value);
          }
        } else {
          let minimum: number | undefined;
          if (key === 'width' || key === 'height') {
            minimum = element.kind === 'line' ? 0 : 1;
          } else if (key === 'thickness' && hasBorder(element)) {
            minimum = 0;
          }
          (element as Record<string, unknown>)[key] =
            minimum === undefined ? value : Math.max(minimum, value as number);
        }
      } else if (key === 'pageHeight') {
        page.height = Math.max(MIN_PAGE_HEIGHT, value as number);
      } else if (key === 'background') {
        page.background = String(value);
      } else if (key === 'projectName') {
        project.name = String(value);
      } else if (key === 'designWidth') {
        project.designWidth = Math.max(MIN_PAGE_WIDTH, value as number);
      }
    });
    if (!live) {
      finishFieldEdit();
    }
    drawCommands();
    if (live) {
      byId('project-title').textContent = editor.project.name;
      drawPage();
      drawStrip();
    } else {
      draw();
    }
  };

  info.addEventListener('focusout', () => {
    finishFieldEdit();
    drawCommands();
  });
  info.addEventListener('submit', event => event.preventDefault());
  info.addEventListener('input', event => {
    const target = event.target as HTMLInputElement;
    if (target.type !== 'number' && target.dataset.field !== 'name') {
      write(target, true);
    }
  });
  info.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.field === 'name') {
      rename(target.value.trim());
    } else {
      write(target, false);
    }
  });
  info.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (button?.dataset.script) {
      const owners = {
        project: () => editor.project,
        page: () => editor.page,
        element: () => editor.selected[0]!,
      };
      const owner = owners[button.dataset.script as keyof typeof owners]();
      openScript(owner);
      if (button.hasAttribute('data-recipe')) {
        scripts.addAction(owner);
      }
    } else if (button?.dataset.replaceImage) {
      chooseImage(button.dataset.replaceImage);
    } else if (button?.hasAttribute('data-add-sound')) {
      chooseSound();
    } else if (button?.dataset.previewSound) {
      togglePreview(button.dataset.previewSound);
    } else if (button?.dataset.editText) {
      openText(button.dataset.editText);
    } else if (button?.dataset.rename) {
      rename(button.dataset.rename);
    } else if (button?.dataset.movePage) {
      const from = editor.pageIndex;
      edit(() => editor.movePage(from, from + Number(button.dataset.movePage)));
    }
  });

  // Page handles live outside the clipped Page, at screen size. Capture on
  // the stable stage because drawing replaces the handles on every move.
  stage.addEventListener('pointerdown', down => {
    const handle = (down.target as HTMLElement).closest<HTMLElement>(
      '[data-page-handle]',
    )?.dataset.pageHandle as PageHandle | undefined;
    if (!handle || down.button !== 0 || editor.readOnly) {
      return;
    }
    down.preventDefault();
    down.stopPropagation();
    closeText();
    finishFieldEdit();
    editor.selectPage();
    const gesture = editor.startPageResize(handle)!;
    const startScale = scale;
    stage.setPointerCapture(down.pointerId);
    const move = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId || editor.readOnly) {
        return;
      }
      gesture.to(
        (event.clientX - down.clientX) / startScale,
        (event.clientY - down.clientY) / startScale,
      );
      drawPage();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId) {
        return;
      }
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      stage.removeEventListener('lostpointercapture', up);
      gesture.finish();
      if (stage.hasPointerCapture(down.pointerId)) {
        stage.releasePointerCapture(down.pointerId);
      }
      draw();
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('lostpointercapture', up);
  });
  stage.addEventListener('keydown', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-page-handle]',
    );
    const handle = target?.dataset.pageHandle as PageHandle | undefined;
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!handle || !delta || editor.readOnly) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const gesture = editor.startPageResize(handle)!;
    gesture.to(delta[0]! / 2, delta[1]!);
    gesture.finish();
    draw();
    stage.querySelector<HTMLElement>(`[data-page-handle="${handle}"]`)?.focus();
  });

  // Selection, moving and resizing on the Page.
  pageNode.addEventListener('pointerdown', down => {
    if (down.button !== 0) {
      return;
    }
    // The page listener runs first, and redraws; the desk's must not then
    // take the detached target for empty space.
    down.stopPropagation();
    const target = down.target as HTMLElement;
    const scriptElement =
      target.closest<HTMLElement>('[data-element]')?.dataset.element;
    if (down.metaKey && down.altKey && scriptElement) {
      down.preventDefault();
      openScript(editor.element(scriptElement)!);
      return;
    }
    if (target.closest('[data-replace-image], [contenteditable="true"]')) {
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset
      .handle as Handle | undefined;
    const name = target.closest<HTMLElement>('[data-element]')?.dataset.element;
    pointerElement = name;
    let gesture: Gesture | undefined;
    if (editor.readOnly) {
      edit(() => editor.click(name, { shift: down.shiftKey }));
      return;
    }
    if (handle) {
      gesture = editor.startResize(handle);
    } else {
      if (
        down.shiftKey ||
        editor.selection.length !== 1 ||
        editor.selection[0] !== name ||
        activeText
      ) {
        edit(() => editor.click(name, { shift: down.shiftKey }));
      }
      if (name && !down.shiftKey) {
        gesture = editor.startMove();
      }
    }
    if (!gesture) {
      return;
    }
    down.preventDefault();
    let moved = false;
    const move = (event: PointerEvent) => {
      const dx = (event.clientX - down.clientX) / scale;
      const dy = (event.clientY - down.clientY) / scale;
      // A small wobble during a click isn't a drag.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / scale) {
        return;
      }
      if (!moved) {
        pageNode.setPointerCapture(down.pointerId);
      }
      moved = true;
      gesture.to(dx, dy);
      drawPage();
    };
    const up = () => {
      pageNode.removeEventListener('pointermove', move);
      pageNode.removeEventListener('pointerup', up);
      pageNode.removeEventListener('pointercancel', up);
      gesture.finish();
      if (moved) {
        draw();
      }
    };
    pageNode.addEventListener('pointermove', move);
    pageNode.addEventListener('pointerup', up, { once: true });
    pageNode.addEventListener('pointercancel', up, { once: true });
  });
  const openText = (name: string) => {
    if (editor.readOnly) {
      return;
    }
    const element = editor.element(name);
    if (element?.kind !== 'text') {
      return;
    }
    edit(() => {
      editor.selectPage();
      editor.click(element.name);
    });
    pageNode.querySelector('.handles')?.remove();
    textControls?.destroy();
    textControls = undefined;
    const node = pageNode.querySelector<HTMLElement>(
      `[data-element="${CSS.escape(element.name)}"]`,
    )!;
    activeText = new InPlaceTextEditor(
      node,
      byId('text-toolbar'),
      historyOf(element),
      () => {
        drawStrip();
        if (!fieldEdit) {
          drawInfo();
        }
        drawCommands();
      },
      () => {
        closeText();
        draw();
      },
    );
  };
  pageNode.addEventListener('dblclick', event => {
    const name =
      (event.target as HTMLElement).closest<HTMLElement>('[data-element]')
        ?.dataset.element ?? pointerElement;
    const element = name ? editor.element(name) : undefined;
    if (!element) {
      return;
    }
    if (
      element.kind !== 'text' ||
      event.shiftKey ||
      (event.metaKey && event.altKey)
    ) {
      event.preventDefault();
      openScript(element);
    } else if (!activeText) {
      openText(element.name);
    }
  });
  // A click on the desk around the Page selects the Page.
  desk.addEventListener('pointerdown', event => {
    if (!event.shiftKey) {
      edit(() => editor.selectPage());
    }
  });

  const imageNotice = (message: string) => {
    byId('notice-text').textContent = message;
    byId('notice-banner').hidden = false;
  };
  const addImages = async (
    files: File[],
    replacement?: string,
    position?: { left: number; top: number },
  ) => {
    if (editor.readOnly) {
      return;
    }
    const page = editor.page;
    const target = replacement ? editor.element(replacement) : undefined;
    const messages: string[] = [];
    for (const file of files) {
      try {
        const imported = await importImage(file);
        // The picker/decoder may outlive a Page switch or edit-lock loss.
        if (
          editor.readOnly ||
          editor.page !== page ||
          (target && !page.elements.includes(target))
        ) {
          return;
        }
        images.add(imported);
        edit(() => editor.setImage(imported.asset, replacement, position));
        messages.push(...imported.warnings);
      } catch (error) {
        messages.push(String(error));
      }
    }
    if (messages.length) {
      imageNotice(messages.join(' '));
    }
  };
  const chooseImage = (replacement?: string) => {
    if (editor.readOnly) {
      return;
    }
    const picker = h('input', {
      type: 'file',
      accept: IMAGE_ACCEPT,
      multiple: !replacement,
    }) as HTMLInputElement;
    picker.addEventListener(
      'change',
      () => void addImages([...(picker.files ?? [])], replacement),
    );
    picker.click();
  };
  const addSounds = async (files: File[]) => {
    if (editor.readOnly) {
      return;
    }
    const generation = editor.generation;
    const messages: string[] = [];
    for (const file of files) {
      try {
        const imported = await importSound(file);
        if (editor.readOnly || editor.generation !== generation) {
          return;
        }
        images.add(imported);
        edit(() => editor.addSound(imported.asset));
        messages.push(...imported.warnings);
      } catch (error) {
        messages.push(String(error));
      }
    }
    if (messages.length) {
      imageNotice(messages.join(' '));
    }
  };
  const chooseSound = () => {
    if (editor.readOnly) {
      return;
    }
    const picker = h('input', {
      type: 'file',
      accept: SOUND_ACCEPT,
      multiple: true,
    }) as HTMLInputElement;
    picker.addEventListener(
      'change',
      () => void addSounds([...(picker.files ?? [])]),
    );
    picker.click();
  };
  const togglePreview = (name: string) => {
    if (preview?.name === name) {
      stopPreview();
      draw();
      return;
    }
    stopPreview();
    const asset = editor.project.assets.find(a => a.name === name);
    const url = images.url(asset);
    if (!url) {
      imageNotice(`The sound “${name}” is missing from this Project.`);
      return;
    }
    const audio = new Audio(url);
    preview = { audio, name };
    audio.addEventListener('ended', () => {
      if (preview?.audio === audio) {
        preview = undefined;
        draw();
      }
    });
    void audio.play().catch((error: unknown) => {
      stopPreview();
      imageNotice(
        `The sound “${name}” could not play: ${error instanceof Error ? error.message : String(error)}`,
      );
      draw();
    });
    draw();
  };
  pageNode.addEventListener('click', event => {
    const name = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-replace-image]',
    )?.dataset.replaceImage;
    if (name) {
      chooseImage(name);
    }
  });
  pageNode.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
    }
  });
  pageNode.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) {
      return;
    }
    event.preventDefault();
    const rect = pageNode.getBoundingClientRect();
    void addImages([...event.dataTransfer.files], undefined, {
      left: (event.clientX - rect.left) / scale,
      top: (event.clientY - rect.top) / scale,
    });
  });

  // The Tools window adds Elements.
  byId('tools').replaceChildren(
    ...ELEMENT_KINDS.map(kind =>
      h(
        'button',
        {
          type: 'button',
          'data-kind': kind,
          title: `Add ${KIND_NAMES[kind].toLowerCase()}`,
        },
        h('span', { 'aria-hidden': 'true' }, KIND_ICONS[kind]),
        KIND_NAMES[kind],
      ),
    ),
  );
  byId('tools').addEventListener('click', event => {
    const kind = (event.target as HTMLElement).closest('button')?.dataset
      .kind as ElementKind | undefined;
    if (kind === 'image') {
      chooseImage();
    } else if (kind) {
      edit(() => editor.addElement(kind));
    }
  });

  // The Pages strip.
  byId('previous-page').addEventListener('click', () =>
    edit(() => editor.previousPage()),
  );
  byId('next-page').addEventListener('click', () =>
    edit(() => editor.nextPage()),
  );
  byId('add-page').addEventListener('click', () =>
    edit(() => editor.addPage()),
  );
  thumbnails.addEventListener('click', event => {
    const index = pageIndexOf(event);
    if (index !== undefined) {
      edit(() => editor.goToPage(index));
    }
  });
  thumbnails.addEventListener('dragstart', event => {
    if (editor.readOnly) {
      event.preventDefault();
      return;
    }
    const index = pageIndexOf(event);
    if (index !== undefined) {
      event.dataTransfer?.setData('application/x-page', String(index));
    }
  });
  thumbnails.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('application/x-page')) {
      event.preventDefault();
    }
  });
  thumbnails.addEventListener('drop', event => {
    const from = event.dataTransfer?.getData('application/x-page');
    const to = pageIndexOf(event);
    if (from && to !== undefined) {
      event.preventDefault();
      edit(() => editor.movePage(Number(from), to));
    }
  });

  const commands: Record<EditingCommand, () => void> = {
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    duplicate: () => editor.duplicate(),
    delete: () => editor.delete(),
    forward: () => editor.orderLayers('forward'),
    backward: () => editor.orderLayers('backward'),
    front: () => editor.orderLayers('front'),
    back: () => editor.orderLayers('back'),
  };
  const commandButtons = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-command]'),
  ];
  const drawCommands = () => {
    for (const button of commandButtons) {
      const command = button.dataset.command as EditingCommand;
      const enabled: Partial<Record<EditingCommand, boolean>> = {
        undo: editor.canUndo,
        redo: editor.canRedo,
        delete: editor.canDelete,
        duplicate: true,
      };
      // Browsing hides the Page, so only Script edits can be undone.
      button.disabled =
        editor.readOnly ||
        (playing === 'browse' && command !== 'undo' && command !== 'redo') ||
        !(enabled[command] ?? editor.selection.length > 0);
    }
  };
  const runCommand = (command: EditingCommand) => {
    finishFieldEdit();
    edit(commands[command]);
    byId('edit-menu').removeAttribute('open');
  };
  byId('edit-menu').addEventListener('click', event => {
    const command = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-command]',
    )?.dataset.command as EditingCommand | undefined;
    if (command) {
      runCommand(command);
    }
  });

  // Ignore all editor shortcuts while typing, including the Script editor.
  document.addEventListener('keydown', event => {
    if (playing) {
      return;
    }
    const target = event.target as HTMLElement;
    const typing = !!target.closest(
      'input, textarea, select, [contenteditable], [role="textbox"]',
    );
    const command = commandForKey(event, typing);
    if (command) {
      event.preventDefault();
      runCommand(command);
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === 'Escape') {
      byId('edit-menu').removeAttribute('open');
      edit(() => editor.selectPage());
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const nudge = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (nudge && editor.selection.length && !editor.readOnly) {
      event.preventDefault();
      edit(() => {
        const gesture = editor.startMove();
        gesture.to(nudge[0]!, nudge[1]!);
        gesture.finish();
      });
    }
  });

  new ResizeObserver(fit).observe(desk);
  mountWindows();
  floatWindows();
  // The one redraw effect: every state, history, read-only or forced change.
  effect(() => {
    void editor.state.value;
    void editor.canUndo;
    void editor.canRedo;
    void editor.readOnly;
    void redrawVersion.value;
    untracked(drawNow);
  });
  return {
    editor,
    images,
    get readOnly() {
      return editor.readOnly;
    },
    redraw: draw,
    onRedraw: listener => {
      redrawListeners.add(listener);
    },
    openScript: (owner, line) => scripts.open(owner, line),
    setPlaying(mode) {
      finishFieldEdit();
      stopPreview();
      closeText();
      byId('edit-menu').removeAttribute('open');
      playing = mode;
      editor.readOnly = readOnly || playing === 'present';
      draw();
    },
    setReadOnly(value: boolean) {
      readOnly = value;
      if ((value || playing === 'present') === editor.readOnly) {
        return;
      }
      finishFieldEdit();
      closeText();
      editor.readOnly = value || playing === 'present';
      draw();
    },
  };
};

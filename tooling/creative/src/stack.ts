// The Stack editor shell (#749), in the layout the UI prototype chose for
// #154: the Page on a desk, floating Tools and Info windows, and a strip of
// Pages. The edits themselves live in `editing.ts`; this file draws them and
// turns pointer and form events into them.
import {
  HANDLES,
  labelSuggestion,
  StackEditor,
  type Edit,
  type Gesture,
  type Handle,
  type NameCheck,
} from './editing';
import {
  ELEMENT_KINDS,
  plainTextOf,
  replacePlainText,
  type Element,
  type ElementKind,
  type Page,
  type Project,
  type TextElement,
  textOf,
} from './model';
import { commandForKey, type EditingCommand } from './shortcuts';

import { renderRichText } from './rich-text-dom';
import { ElementTextControls, InPlaceTextEditor } from './text-editor';

type Attributes = Record<string, string | number | boolean | undefined>;

/** A DOM element with attributes and children; `false` attributes are left out. */
const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  node.append(...children.filter(c => c !== undefined));
  return node;
};

const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no #${id}`);
  }
  return found;
};

const KIND_NAMES: Record<ElementKind, string> = {
  text: 'Text',
  image: 'Image',
  button: 'Button',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
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
const renderElement = (element: Element): HTMLElement => {
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
      // A placeholder until image assets arrive (#753).
      node.append(h('span', {}, element.image || 'Image'));
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
const renderPage = (page: Page, designWidth: number, into: HTMLElement) => {
  into.replaceChildren(...page.elements.map(renderElement));
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
  const windows = [...document.querySelectorAll<HTMLElement>('.window')];
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
  };
  for (const win of windows) {
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
      for (const other of windows) {
        other.classList.toggle('front', other === win);
      }
    });
  }
  window.addEventListener('resize', () => {
    for (const win of windows) {
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

/** Mounts the editor shell on the page's desk, strip and windows. */
export const mountStack = (project: Project): StackEditor => {
  const editor = new StackEditor(project);
  const desk = byId('desk');
  const stage = byId('stage');
  const pageNode = byId('page');
  const info = byId('info') as HTMLFormElement;
  const thumbnails = byId('thumbnails');
  let pointerElement: string | undefined;
  let activeText: InPlaceTextEditor | undefined;
  let textControls: ElementTextControls | undefined;
  const historyOf = (element: TextElement) => editor.textHistory(element);
  const closeText = () => {
    activeText?.destroy();
    activeText = undefined;
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
    scale = Math.min(1, Math.max(0.1, room / project.designWidth));
    pageNode.style.transform = `scale(${scale})`;
    stage.style.width = `${project.designWidth * scale}px`;
    byId('caption').style.width = stage.style.width;
    stage.style.height = `${editor.page.height * scale}px`;
    desk.style.setProperty('--scale', String(scale));
  };

  const drawPage = () => {
    renderPage(editor.page, project.designWidth, pageNode);
    const selected = editor.selected;
    for (const element of selected) {
      pageNode
        .querySelector(`[data-element="${CSS.escape(element.name)}"]`)
        ?.classList.add('selected');
    }
    const [single] = selected;
    if (single && selected.length === 1) {
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
      `${editor.pageIndex + 1} / ${project.pages.length}`;
    fit();
  };

  const drawStrip = () => {
    const scaleDown = THUMBNAIL_WIDTH / project.designWidth;
    thumbnails.replaceChildren(
      ...project.pages.map((page, index) => {
        const miniature = h('div', { class: 'page' });
        renderPage(page, project.designWidth, miniature);
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
      editor.pageIndex === project.pages.length - 1;
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

  const elementInfo = (element: Element): HTMLElement[] => {
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
            'p',
            { class: 'muted' },
            'Choosing a picture comes with image assets.',
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
      ...nameField(
        element.name,
        element.kind === 'button'
          ? labelSuggestion(editor.page, element)
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

  const pageInfo = (page: Page): HTMLElement[] => [
    h('h2', {}, `Page ${editor.pageIndex + 1} of ${project.pages.length}`),
    ...nameField(page.name),
    h(
      'div',
      { class: 'row' },
      field('Height', input('pageHeight', page.height, 'number', { min: 1 })),
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
          disabled: editor.pageIndex === project.pages.length - 1,
        },
        'Later →',
      ),
    ),
    h('h2', {}, 'Project'),
    field('Title', input('projectName', project.name)),
    field(
      'Design width',
      input('designWidth', project.designWidth, 'number', { min: 1 }),
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
    if (focused) {
      info.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
    }
  };

  // Formatting controls for one selected text Element; while it is edited in
  // place, the InPlaceTextEditor drives them instead.
  const drawTextControls = () => {
    const [element, ...others] = editor.selected;
    const target =
      !activeText && !others.length && element?.kind === 'text'
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
    byId('project-title').textContent = project.name;
    drawPage();
    drawStrip();
    drawInfo();
    drawCommands();
    drawTextControls();
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
    fieldEdit.change(() => {
      const [element] = editor.selected;
      if (element && editor.selection.length === 1) {
        if (key === 'text' && element.kind === 'text') {
          if (textOf(element) !== value) {
            replacePlainText(element, String(value));
          }
        } else {
          const sizes = key === 'width' || key === 'height';
          const minimum = sizes ? (element.kind === 'line' ? 0 : 1) : undefined;
          (element as Record<string, unknown>)[key] =
            minimum === undefined ? value : Math.max(minimum, value as number);
        }
      } else if (key === 'pageHeight') {
        editor.page.height = Math.max(1, value as number);
      } else if (key === 'background') {
        editor.page.background = String(value);
      } else if (key === 'projectName') {
        project.name = String(value);
      } else if (key === 'designWidth') {
        project.designWidth = Math.max(1, value as number);
      }
    });
    if (!live) {
      finishFieldEdit();
    }
    drawCommands();
    if (live) {
      byId('project-title').textContent = project.name;
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
    if (button?.dataset.editText) {
      openText(button.dataset.editText);
    } else if (button?.dataset.rename) {
      rename(button.dataset.rename);
    } else if (button?.dataset.movePage) {
      const from = editor.pageIndex;
      edit(() => editor.movePage(from, from + Number(button.dataset.movePage)));
    }
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
    if (target.closest('[contenteditable="true"]')) {
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset
      .handle as Handle | undefined;
    const name = target.closest<HTMLElement>('[data-element]')?.dataset.element;
    pointerElement = name;
    let gesture: Gesture | undefined;
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
        drawInfo();
        drawCommands();
      },
      () => {
        closeText();
        draw();
      },
    );
  };
  pageNode.addEventListener('dblclick', event => {
    if (event.shiftKey || event.metaKey || event.altKey || activeText) {
      return;
    }
    const name = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-element]',
    )?.dataset.element;
    // The first click can redraw the selection; dblclick then targets the Page.
    openText(name ?? pointerElement ?? '');
  });
  // A click on the desk around the Page selects the Page.
  desk.addEventListener('pointerdown', event => {
    if (!event.shiftKey) {
      edit(() => editor.selectPage());
    }
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
    if (kind) {
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
      button.disabled = !(enabled[command] ?? editor.selection.length > 0);
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
    if (nudge && editor.selection.length) {
      event.preventDefault();
      edit(() => {
        const gesture = editor.startMove();
        gesture.to(nudge[0]!, nudge[1]!);
        gesture.finish();
      });
    }
  });

  new ResizeObserver(fit).observe(desk);
  floatWindows();
  draw();
  return editor;
};

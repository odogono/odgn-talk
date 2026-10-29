import type { DeepReadonly } from './readonly';
import { allElements, elementVisibility } from './tree/rules';
// The Stack editor shell (#749), in the layout the UI prototype chose for
// #154: the Page on a desk, floating Tools and Info windows, and a strip of
// Pages. The edits themselves live in `editing.ts`; this file draws them and
// turns pointer and form events into them.
import { effect, signal, untracked } from '@preact/signals-core';
import {
  HANDLES,
  PAGE_HANDLES,
  MIN_PAGE_WIDTH,
  MIN_PAGE_HEIGHT,
  pageOf,
  selectedOf,
  StackEditor,
  type Edit,
  type Gesture,
  type Handle,
  type PageHandle,
} from './editing';
import {
  type Asset,
  ELEMENT_KINDS,
  hasBorder,
  isTextAlign,
  type ElementKind,
  type Page,
  type Project,
  type TextElement,
  textOf,
} from './model';
import { ImageAssets, IMAGE_ACCEPT, importImage } from './images';
import { importSound, SOUND_ACCEPT } from './sounds';
import { type CodeSelection } from './code-browser-panel';
import {
  CodeBrowser,
  type SourceBreakpoints,
  type LoadedSource,
} from './scripts';
import { bringWindowForward, mountWindows } from './windows';
import type { ScriptOwner } from './script-manifest';
import { commandForKey, type EditingCommand } from './shortcuts';

import { createElement } from 'preact';
import { byId, h, isTyping } from './dom';
import { ElementView, renderElements } from './element-view';
import { ElementTextControls, InPlaceTextEditor } from './text-editor';
import { mountProjectTitle } from './project-title';
import { mountPageStrip } from './page-strip';
import { mountEditMenu } from './edit-menu';
import { KIND_NAMES, mountInfoPanel, type NameRefusal } from './info-panel';

const KIND_ICONS: Record<ElementKind, string> = {
  text: 'T',
  image: '▨',
  button: '▭',
  rectangle: '■',
  ellipse: '●',
  line: '╱',
  canvas: '▦',
  group: '▱',
};

/** A Page at design size, unscaled. */
const renderPage = (
  page: DeepReadonly<Page>,
  designWidth: number,
  into: HTMLElement,
  assets: DeepReadonly<Asset[]>,
  images: ImageAssets,
  selected: ReadonlySet<string> = new Set(),
) => {
  const visibility = elementVisibility(page.elements);
  renderElements(
    into,
    allElements(page.elements).map(element =>
      createElement(ElementView, {
        key: element.id,
        element,
        className: selected.has(element.name) ? 'selected' : '',
        hidden: !visibility.get(element.name),
        imageUrl:
          element.kind === 'image'
            ? images.url(assets.find(a => a.name === element.image))
            : undefined,
      }),
    ),
  );
  Object.assign(into.style, {
    width: `${designWidth}px`,
    height: `${page.height}px`,
    background: page.background,
  });
};

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

/** The Page index of a strip thumbnail an event happened on. */
const pageIndexOf = (event: Event) => {
  const index = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-page]',
  )?.dataset.page;
  return index === undefined ? undefined : Number(index);
};

export type PlayMode = 'browse' | 'present';

/** The mounted shell: the editor, a redraw, and read-only switching. */
export type StackShell = {
  /** The Code Browser's Breakpoints and paused line (ADR 0147). */
  breakpoints: {
    all(): SourceBreakpoints[];
    onChange(listener: () => void): void;
    setLoaded(loaded: LoadedSource | undefined): void;
    showStopped(at: { line: number; source: CodeSelection } | undefined): void;
  };
  editor: StackEditor;
  images: ImageAssets;
  onRedraw(listener: () => void): void;
  openLibrary(id: number, line?: number): void;
  openScript(owner: ScriptOwner, line?: number): void;
  openTestScript(id: number, line?: number): void;
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
  initialProject: DeepReadonly<Project>,
  options: { readOnly?: boolean } = {},
): StackShell => {
  const editor = new StackEditor(initialProject);
  const unmountTitle = mountProjectTitle(byId('project-title'), editor);
  const redrawVersion = signal(0);
  const redrawListeners = new Set<() => void>();
  const images = new ImageAssets();
  const scripts = new CodeBrowser(editor, () => draw());
  window.addEventListener('pagehide', event => {
    stopPreview();
    if (!event.persisted) {
      unmountTitle();
      unmountInfo();
      unmountStrip();
      unmountEditMenu();
      images.dispose();
    }
  });
  let readOnly = options.readOnly ?? false;
  const playing = signal<PlayMode | undefined>(undefined);
  editor.readOnly = readOnly;
  const unmountEditMenu = mountEditMenu(
    byId('edit-menu').querySelector<HTMLElement>('.menu-commands')!,
    { editor, playing },
  );
  const desk = byId('desk');
  const stage = byId('stage');
  const pageNode = byId('page');
  const info = byId('info') as HTMLFormElement;
  const thumbnails = byId('thumbnails');
  const unmountStrip = mountPageStrip(
    thumbnails,
    editor,
    (page, designWidth, assets, into) =>
      renderPage(page, designWidth, into, assets, images),
  );
  let pointerElement: string | undefined;
  // The Edit-time sound preview: one voice, never a Script (those run in Play).
  let preview: { audio: HTMLAudioElement; name: string } | undefined;
  const previewName = signal<string | undefined>(undefined);
  const stopPreview = () => {
    preview?.audio.pause();
    preview = undefined;
    previewName.value = undefined;
  };
  let activeText: InPlaceTextEditor | undefined;
  let textControls: ElementTextControls | undefined;
  const historyOf = (element: DeepReadonly<TextElement>) =>
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
  const refusal = signal<NameRefusal | undefined>(undefined);
  const unmountInfo = mountInfoPanel(info, { editor, refusal, previewName });
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
    const selected = editor.selected;
    renderPage(
      editor.page,
      editor.project.designWidth,
      pageNode,
      editor.project.assets,
      images,
      new Set(selected.map(element => element.name)),
    );
    pageNode.querySelector(':scope > .handles')?.remove();
    stage.querySelector('.page-handles')?.remove();
    if (!selected.length && !editor.scope.length && !editor.readOnly) {
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
    const [single] = selected;
    if (
      single &&
      single.kind !== 'group' &&
      selected.length === 1 &&
      !editor.readOnly
    ) {
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
    byId('page-name').textContent = [
      editor.page.name,
      ...editor.scope.map(
        id => allElements(editor.page.elements).find(e => e.id === id)?.name,
      ),
    ].join(' › ');
    byId('page-number').textContent =
      `${editor.pageIndex + 1} / ${editor.project.pages.length}`;
    fit();
  };

  const drawNavigation = () => {
    (byId('previous-page') as HTMLButtonElement).disabled =
      editor.pageIndex === 0;
    (byId('next-page') as HTMLButtonElement).disabled =
      editor.pageIndex === editor.project.pages.length - 1;
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
    pageNode.classList.toggle('edit', !editor.readOnly);
    (byId('add-page') as HTMLButtonElement).disabled = editor.readOnly;
    for (const button of byId('tools').querySelectorAll('button')) {
      button.disabled = editor.readOnly;
    }
    if (!activeText) {
      drawPage();
    }
    drawNavigation();
    drawTextControls();
    scripts.sync();
    for (const listener of redrawListeners) {
      listener();
    }
  };

  /** Applies an edit, forgetting any refused name, then redraws. */
  const edit = (change: () => void) => {
    closeText();
    refusal.value = undefined;
    try {
      change();
    } catch (error) {
      byId('notice-text').textContent =
        error instanceof Error ? error.message : String(error);
      byId('notice-banner').hidden = false;
    }
    draw();
  };

  const rename = (name: string) => {
    closeText();
    const [element] = editor.selected;
    const check =
      editor.selection.length === 1
        ? editor.renameElement(element!.name, name)
        : editor.renamePage(name);
    refusal.value = check.ok ? undefined : { attempted: name, check };
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
    try {
      fieldEdit.change(draft => {
        const { project } = draft;
        const page = pageOf(draft);
        const [element] = selectedOf(draft);
        if (element && editor.selection.length === 1) {
          if (['left', 'top', 'width', 'height'].includes(key)) {
            const next =
              key === 'width' || key === 'height'
                ? Math.max(element.kind === 'line' ? 0 : 1, Number(value))
                : Number(value);
            draft.tree.setGeometry(element, { [key]: next });
          } else if (key === 'text' && element.kind === 'text') {
            if (textOf(element) !== value) {
              draft.tree.setProperty(element, 'text', String(value));
            }
          } else if (key === 'textAlign' && element.kind === 'text') {
            if (isTextAlign(value)) {
              draft.tree.setProperty(element, 'textAlign', value);
            }
          } else {
            let minimum: number | undefined;
            if (key === 'thickness' && hasBorder(element)) {
              minimum = 0;
            } else if (key === 'textSize' && element.kind === 'button') {
              minimum = 1;
            }
            draft.tree.setProperty(
              element,
              key,
              minimum === undefined
                ? value
                : Math.max(minimum, value as number),
            );
          }
        } else if (key === 'pageHeight') {
          draft.tree.setProperty(
            page,
            'height',
            Math.max(MIN_PAGE_HEIGHT, value as number),
          );
        } else if (key === 'background') {
          draft.tree.setProperty(page, 'background', String(value));
        } else if (key === 'projectName') {
          draft.tree.setProjectName(String(value));
        } else if (key === 'designWidth') {
          draft.tree.setProperty(
            project,
            'designWidth',
            Math.max(MIN_PAGE_WIDTH, value as number),
          );
        }
      });
    } catch (error) {
      finishFieldEdit();
      byId('notice-text').textContent =
        error instanceof Error ? error.message : String(error);
      byId('notice-banner').hidden = false;
    }
    if (!live) {
      finishFieldEdit();
    }
    draw();
  };

  info.addEventListener('focusout', finishFieldEdit);
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
    } else if (button?.dataset.clearDrawing) {
      const [canvas] = editor.selected;
      if (canvas?.kind === 'canvas') {
        edit(() => editor.clearDrawing(canvas));
      }
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
      openScript(
        editor.selectable(scriptElement) ?? editor.element(scriptElement)!,
      );
      return;
    }
    if (target.closest('[data-replace-image], [contenteditable="true"]')) {
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset
      .handle as Handle | undefined;
    const name = target.closest<HTMLElement>('[data-element]')?.dataset.element;
    pointerElement = name ? (editor.selectable(name)?.name ?? name) : undefined;
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
      // The Edit menu follows the editor's history signals itself.
      () => {},
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
    const element = name
      ? (editor.selectable(name) ?? editor.element(name))
      : undefined;
    if (!element) {
      return;
    }
    if (
      element.kind === 'group' &&
      !event.shiftKey &&
      !(event.metaKey && event.altKey)
    ) {
      event.preventDefault();
      edit(() => editor.enterGroup(element.name));
    } else if (
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
    let expected = editor.stamp();
    const target = replacement ? editor.element(replacement) : undefined;
    const messages: string[] = [];
    for (const file of files) {
      try {
        const imported = await importImage(file);
        // The picker/decoder may outlive a Page switch or edit-lock loss.
        if (
          editor.readOnly ||
          !editor.isCurrent(expected) ||
          editor.page.id !== page.id ||
          (target &&
            !allElements(editor.page.elements).some(
              element => element.id === target.id,
            ))
        ) {
          return;
        }
        images.add(imported);
        edit(() => editor.setImage(imported.asset, replacement, position));
        expected = editor.stamp();
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
    previewName.value = name;
    audio.addEventListener('ended', () => {
      if (preview?.audio === audio) {
        preview = undefined;
        previewName.value = undefined;
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
    ...ELEMENT_KINDS.filter(kind => kind !== 'group').map(kind =>
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
    group: () => editor.groupSelection(),
    ungroup: () => editor.ungroupSelection(),
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    duplicate: () => editor.duplicate(),
    delete: () => editor.delete(),
    forward: () => editor.orderLayers('forward'),
    backward: () => editor.orderLayers('backward'),
    front: () => editor.orderLayers('front'),
    back: () => editor.orderLayers('back'),
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
    if (playing.peek()) {
      return;
    }
    const typing = isTyping(event.target);
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
      edit(() => editor.leaveGroup());
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
    breakpoints: {
      all: () => scripts.breakpoints(),
      onChange: listener => scripts.onBreakpointsChanged(listener),
      setLoaded: loaded => scripts.setLoaded(loaded),
      showStopped: at => scripts.showStopped(at),
    },
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
    openLibrary: (id, line) => scripts.openLibrary(id, line),
    openTestScript: (id, line) => scripts.openTestScript(id, line),
    setPlaying(mode) {
      finishFieldEdit();
      stopPreview();
      closeText();
      byId('edit-menu').removeAttribute('open');
      playing.value = mode;
      editor.readOnly = readOnly || mode === 'present';
      draw();
    },
    setReadOnly(value: boolean) {
      readOnly = value;
      const presenting = playing.peek() === 'present';
      if ((value || presenting) === editor.readOnly) {
        return;
      }
      finishFieldEdit();
      closeText();
      editor.readOnly = value || presenting;
      draw();
    },
  };
};

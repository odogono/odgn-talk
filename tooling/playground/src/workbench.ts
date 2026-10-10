import type { EditorView } from '@codemirror/view';
import { enclosingNode, type SyntaxView } from './syntax';
import type { SyntaxRequest, SyntaxResponse } from './protocol';

const element = (id: string) => document.getElementById(id)!;
type Preferences = {
  collapsed: boolean;
  height: number;
  inspector: string;
  theme: string;
  width: number;
};
const defaults: Preferences = {
  theme: 'system',
  inspector: 'syntax',
  width: 60,
  height: 24,
  collapsed: false,
};

/** Owns layout and syntax navigation; execution remains in the session worker. */
export const createWorkbench = (view: EditorView) => {
  let preferences = { ...defaults };
  try {
    const data = JSON.parse(
      localStorage.getItem('northtalk-workbench') ?? '{}',
    ) as Partial<Preferences>;
    preferences = { ...defaults, ...data };
  } catch {
    /* Preferences are optional. */
  }
  const persist = () => {
    try {
      localStorage.setItem('northtalk-workbench', JSON.stringify(preferences));
    } catch {
      /* Optional. */
    }
  };
  const root = document.documentElement;
  const theme = element('theme') as HTMLSelectElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    root.dataset.theme =
      preferences.theme === 'system'
        ? media.matches
          ? 'dark'
          : 'light'
        : preferences.theme;
  };
  theme.value = preferences.theme;
  theme.onchange = () => {
    preferences.theme = theme.value;
    applyTheme();
    persist();
  };
  media.addEventListener('change', applyTheme);
  applyTheme();

  const selectInspector = (name: string) => {
    if (
      ![
        'syntax',
        'inspect',
        'canvas',
        'debugger',
        'replay',
        'grants',
        'dictionary',
      ].includes(name)
    ) {
      name = 'syntax';
    }
    preferences.inspector = name;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-inspector]',
    )) {
      const selected = button.dataset.inspector === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      element(button.dataset.inspector!).hidden = !selected;
    }
    persist();
  };
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-inspector]'),
  ];
  buttons.forEach((button, index) => {
    button.onclick = () => selectInspector(button.dataset.inspector!);
    button.onkeydown = event => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % buttons.length
          : event.key === 'ArrowLeft'
            ? (index + buttons.length - 1) % buttons.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : -1;
      if (next < 0) {
        return;
      }
      event.preventDefault();
      buttons[next]!.click();
      buttons[next]!.focus();
    };
  });
  selectInspector(preferences.inspector);
  const layout = () => {
    preferences.width = Math.max(
      25,
      Math.min(75, Number(preferences.width) || 60),
    );
    preferences.height = Math.max(
      12,
      Math.min(55, Number(preferences.height) || 24),
    );
    root.style.setProperty('--editor-width', `${preferences.width}%`);
    root.style.setProperty('--console-height', `${preferences.height}vh`);
    document.body.classList.toggle('console-collapsed', preferences.collapsed);
    element('console-toggle').setAttribute(
      'aria-expanded',
      String(!preferences.collapsed),
    );
    for (const [id, value] of [
      ['column-resize', preferences.width],
      ['console-resize', preferences.height],
    ] as const) {
      element(id).setAttribute('aria-valuenow', String(value));
    }
  };
  element('console-toggle').onclick = () => {
    preferences.collapsed = !preferences.collapsed;
    layout();
    persist();
  };
  const resize = (id: string, key: 'width' | 'height') => {
    const handle = element(id);
    handle.onpointerdown = event => {
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = e => {
        if (!handle.hasPointerCapture(e.pointerId)) {
          return;
        }
        const bounds = element('workspace').getBoundingClientRect();
        preferences[key] =
          key === 'width'
            ? (100 * (e.clientX - bounds.left)) / bounds.width
            : (100 * (innerHeight - e.clientY)) / innerHeight;
        layout();
      };
      handle.onpointerup = e => {
        handle.releasePointerCapture(e.pointerId);
        persist();
      };
    };
    handle.onkeydown = event => {
      const delta = ['ArrowRight', 'ArrowUp'].includes(event.key)
        ? 2
        : ['ArrowLeft', 'ArrowDown'].includes(event.key)
          ? -2
          : 0;
      if (!delta) {
        return;
      }
      event.preventDefault();
      preferences[key] += delta;
      layout();
      persist();
    };
  };
  resize('column-resize', 'width');
  resize('console-resize', 'height');
  layout();

  const worker = new Worker('./syntax.worker.js', { type: 'module' });
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tree: SyntaxView | null = null;
  const nodes = new Map<SyntaxView, HTMLElement>();
  const selected = () => {
    const selection = view.state.selection.main;
    const node = tree && enclosingNode(tree, selection.from, selection.to);
    for (const [n, el] of nodes) {
      el.classList.toggle('selected', n === node);
    }
    const el = node && nodes.get(node);
    if (el) {
      for (
        let parent = el.parentElement;
        parent && parent !== element('syntax');
        parent = parent.parentElement
      ) {
        if (parent.tagName === 'DETAILS') {
          (parent as HTMLDetailsElement).open = true;
        }
      }
      if (!element('syntax').hidden) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  };
  const renderNode = (node: SyntaxView, depth = 0): HTMLElement => {
    const button = document.createElement('button');
    button.textContent = node.label;
    button.title = `Source offsets ${node.from}–${node.to}`;
    button.className =
      node.label === 'Error' ? 'syntax-node error' : 'syntax-node';
    button.onclick = () => {
      view.dispatch({
        selection: { anchor: node.from, head: node.to },
        scrollIntoView: true,
      });
      view.focus();
      selected();
    };
    nodes.set(node, button);
    if (!node.children.length) {
      return button;
    }
    const details = document.createElement('details');
    details.open = depth < 2;
    const summary = document.createElement('summary');
    summary.append(button);
    details.append(summary);
    const children = document.createElement('div');
    children.className = 'syntax-children';
    children.append(...node.children.map(n => renderNode(n, depth + 1)));
    details.append(children);
    return details;
  };
  worker.onmessage = ({ data }: MessageEvent<SyntaxResponse>) => {
    if (data.revision !== revision) {
      return;
    }
    const target = element('syntax-tree');
    nodes.clear();
    if ('error' in data) {
      tree = null;
      target.textContent = data.error;
      return;
    }
    tree = data.tree;
    target.replaceChildren(renderNode(tree));
    selected();
  };
  const changed = () => {
    revision++;
    element('syntax-tree').replaceChildren();
    tree = null;
    nodes.clear();
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        worker.postMessage({
          revision,
          source: view.state.doc.toString(),
        } satisfies SyntaxRequest),
      120,
    );
  };
  return { changed, selected, selectInspector };
};

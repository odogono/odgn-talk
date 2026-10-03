// The NorthTalk Playground page: tabs and an editor over the LSP worker, and
// a console, Grants, and debuggers over the session worker. Its layout and
// controls are tooling freedom (chapter 12); everything a session prints and
// records comes from the Session Host in the session worker.
import { writeTranscript } from '@odgn/northtalk/session';
import { libraryUri, type Position } from '@odgn/northtalk-tooling/lsp';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { planApply, splitDeclarations } from './declarations';
import {
  breakpointLines,
  createEditorState,
  diagnosticsSpec,
  markVerified,
  offsetOf,
  onEdits,
  pausedAt,
  refreshHints,
} from './editor';
import { decodeLink, encodeLink, type Shared } from './link';
import { LspClient } from './lsp-client';
import type {
  ConsoleLine,
  FromSession,
  ReplayView,
  SessionRequest,
  SessionResponse,
  SessionState,
  ToSession,
} from './protocol';
import { SESSION_TAB, type Library, type PauseView } from './session';
import { loadSaved, save, type Saved } from './storage';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const WELCOME = `-- Welcome to the NorthTalk Playground. This tab is the session's source:
-- Apply (Ctrl/Cmd-S) enters it into the session, then try
-- greet "Ann" at the prompt.
on greet name
  say "hello " & name
end greet
`;
const NAME_TEXT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const SCRIPT_URI = 'playground:///session.talk';

// ------------------------------------------------------------- workers

const sessionWorker = new Worker('./session.worker.js', { type: 'module' });
const lsp = new LspClient(new Worker('./lsp.worker.js', { type: 'module' }));

let nextId = 1;
const waiting = new Map<number, (response: SessionResponse) => void>();
sessionWorker.onmessage = ({
  data: { id, response },
}: MessageEvent<FromSession>) => {
  receive(response);
  if (id !== undefined) {
    waiting.get(id)?.(response);
    waiting.delete(id);
  }
};
const call = (request: SessionRequest): Promise<SessionResponse> => {
  const id = nextId++;
  sessionWorker.postMessage({ id, request } satisfies ToSession);
  return new Promise(resolve => waiting.set(id, resolve));
};

// ------------------------------------------------------------- tabs

type Tab = {
  kind: 'script' | 'library';
  name: string;
  state: EditorState;
  uri: string;
};
const tabs: Tab[] = [];
let active = 0;
let sessionSource = '';
let savedLibraries: Library[] = [];
let profile: Saved['profile'] = 'beginner';

const view = new EditorView({ parent: $('editor') });
const tabText = (tab: Tab) =>
  (tab === tabs[active] ? view.state : tab.state).doc.toString();
const scriptTab = () => tabs[0]!;
const libraryTabs = () => tabs.filter(t => t.kind === 'library');
const currentTabs = () => ({
  script: tabText(scriptTab()),
  libraries: libraryTabs().map(t => ({ name: t.name, source: tabText(t) })),
});

const hooksFor = (uri: () => string) => ({
  changed: (text: string) => {
    lsp.change(uri(), text);
    if (tabs.find(t => t.uri === uri())?.kind === 'library') {
      configureSources();
    }
    scheduleAutosave();
    scheduleHints();
    renderTabs();
    scheduleBreakpoints();
  },
  breakpointsChanged: () => sendBreakpoints(),
  goTo,
  references: (lines: string[]) =>
    showLines(
      lines.length
        ? ['References:', ...lines.map(l => `  ${l}`)]
        : ['No references'],
    ),
  save: () => void saveActive(),
});

const addTab = (kind: Tab['kind'], name: string, text: string): Tab => {
  const uri = kind === 'script' ? SCRIPT_URI : libraryUri(name);
  const tab: Tab = { kind, name, uri, state: null as unknown as EditorState };
  tab.state = createEditorState(
    text,
    uri,
    lsp,
    hooksFor(() => tab.uri),
  );
  tabs.push(tab);
  lsp.open(uri, text);
  return tab;
};

const switchTo = (index: number) => {
  if (index !== active) {
    tabs[active]!.state = view.state;
    active = index;
    view.setState(tabs[index]!.state);
  }
  renderTabs();
  scheduleHints();
};

const isClean = (script: string, source: string) => {
  const tab = splitDeclarations(script);
  const session = splitDeclarations(source);
  if (tab.error || session.error) {
    return false;
  }
  const plan = planApply(tab.declarations, session.declarations);
  return !plan.enter.length && !plan.removed.length;
};

const renderTabs = () => {
  const nav = $('tabs');
  nav.replaceChildren();
  tabs.forEach((tab, i) => {
    const button = document.createElement('button');
    const text = tabText(tab);
    const dirty =
      tab.kind === 'script'
        ? !isClean(text, sessionSource)
        : savedLibraries.find(l => l.name === tab.name)?.source !==
          `${text.replace(/\n+$/u, '')}\n`;
    button.textContent = `${tab.name}.talk${dirty ? ' •' : ''}`;
    button.title =
      tab.kind === 'script'
        ? 'The Session Script. Apply enters it into the session.'
        : 'A user Library. Saving (Ctrl/Cmd-S) adds or replaces it. Double-click to rename.';
    button.className = i === active ? 'active' : '';
    button.onclick = () => switchTo(i);
    if (tab.kind === 'library') {
      button.ondblclick = () => renameLibrary(tab);
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Close this Library tab';
      close.onclick = event => {
        event.stopPropagation();
        closeLibrary(tab);
      };
      button.append(close);
    }
    nav.append(button);
  });
  const add = document.createElement('button');
  add.textContent = '+ Library';
  add.onclick = newLibrary;
  nav.append(add);
};

const askLibraryName = (initial = ''): string | null => {
  const name = prompt('Library name', initial)?.trim();
  if (!name) {
    return null;
  }
  if (
    !NAME_TEXT.test(name) ||
    name === SESSION_TAB ||
    tabs.some(t => t.name === name)
  ) {
    alert(`${name} is not a free Library name`);
    return null;
  }
  return name;
};

const newLibrary = () => {
  const name = askLibraryName();
  if (name) {
    addTab(
      'library',
      name,
      `-- The ${name} Library. Save it to add it to the session.\n`,
    );
    configureSources();
    switchTo(tabs.length - 1);
    scheduleAutosave();
  }
};

const needsRestart = (what: string) =>
  savedLibraries.some(l => l.name === what) &&
  note(
    `The session still has the Library ${what}; Restart to drop it.`,
    'warning',
  );

const renameLibrary = (tab: Tab) => {
  const name = askLibraryName(tab.name);
  if (!name) {
    return;
  }
  const text = tabText(tab);
  lsp.close(tab.uri);
  needsRestart(tab.name);
  tab.name = name;
  tab.uri = libraryUri(name);
  lsp.open(tab.uri, text);
  configureSources();
  renderTabs();
  scheduleAutosave();
};

const closeLibrary = (tab: Tab) => {
  if (!confirm(`Close the Library tab ${tab.name}? Its text is lost.`)) {
    return;
  }
  const index = tabs.indexOf(tab);
  if (index === active) {
    switchTo(0);
  } else if (index < active) {
    active--;
  }
  tabs.splice(index, 1);
  lsp.close(tab.uri);
  needsRestart(tab.name);
  configureSources();
  renderTabs();
  scheduleAutosave();
  sendBreakpoints();
};

const goTo = (uri: string, line: number, character: number) => {
  const index = tabs.findIndex(t => t.uri === uri);
  if (index < 0) {
    note(
      `Defined in the standard Library ${decodeURIComponent(uri.replace(/^.*\//u, '').replace(/\.talk$/u, ''))}`,
    );
    return;
  }
  switchTo(index);
  const offset = offsetOf(view.state.doc, { line, character });
  view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  view.focus();
};

onEdits((uri, edits) => {
  const tab = tabs.find(t => t.uri === uri);
  if (!tab) {
    return;
  }
  const state = tab === tabs[active] ? view.state : tab.state;
  const changes = edits.map(e => ({
    from: offsetOf(state.doc, e.range.start),
    to: offsetOf(state.doc, e.range.end),
    insert: e.newText,
  }));
  if (tab === tabs[active]) {
    view.dispatch({ changes });
  } else {
    tab.state = tab.state.update({ changes }).state;
    lsp.change(tab.uri, tab.state.doc.toString());
  }
});

lsp.onDiagnostics = (uri, diagnostics) => {
  const tab = tabs.find(t => t.uri === uri);
  if (tab === tabs[active]) {
    view.dispatch(diagnosticsSpec(view.state, diagnostics));
  } else if (tab) {
    tab.state = tab.state.update(diagnosticsSpec(tab.state, diagnostics)).state;
  }
};

const configureSources = () =>
  lsp.configure({
    sources: libraryTabs().map(t => ({
      uri: t.uri,
      text: tabText(t),
      library: t.name,
    })),
  });

// ------------------------------------------------------------- timers

const debounce = (ms: number, f: () => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      f();
    }, ms);
  };
};
const scheduleAutosave = debounce(400, () => {
  const { script, libraries } = currentTabs();
  save({
    script,
    libraries,
    profile,
    showReadings: document.body.classList.contains('readings'),
  });
});
const scheduleHints = debounce(
  300,
  () => void refreshHints(view, tabs[active]!.uri, lsp),
);
const scheduleBreakpoints = debounce(500, () => sendBreakpoints());

// ------------------------------------------------------------- console

const consoleEl = $('console');
const appendLine = (text: string, className: string) => {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  consoleEl.append(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
};
const showLines = (
  lines: string[],
  level: 'info' | 'warning' | 'error' = 'info',
) => {
  for (const text of lines) {
    appendLine(text, `note ${level}`);
  }
};
const note = (text: string, level: 'info' | 'warning' | 'error' = 'info') =>
  showLines([text], level);

const renderLine = (line: ConsoleLine) => {
  if (line.k === 'note') {
    note(line.text, line.level);
    return;
  }
  const { item } = line;
  const className =
    item.k === 'input'
      ? 'in'
      : item.k === 'read'
        ? 'read'
        : item.k === 'clock' || item.k === 'answer'
          ? 'reading'
          : item.k === 'comment'
            ? 'note'
            : item.text.startsWith('! ') || /^\[[^\]]+\] ! /u.test(item.text)
              ? 'out bang'
              : 'out';
  for (const text of writeTranscript([item]).replace(/\n$/u, '').split('\n')) {
    appendLine(text, className);
  }
};

// ------------------------------------------------------------- session state

let manifest = '';
let lastPause: PauseView | null = null;

const receive = (response: SessionResponse) => {
  switch (response.t) {
    case 'state':
    case 'applied':
    case 'mismatch':
      render(response.state);
      break;
    case 'error':
      note(response.message, 'error');
      break;
    default:
      break;
  }
};

const render = (state: SessionState) => {
  for (const line of state.lines) {
    renderLine(line);
  }
  if (state.prompt !== 'continue') {
    $('pending').textContent = '';
  }
  $('prompt-label').textContent = {
    entry: '>',
    continue: '|',
    read: '<',
    sleeping: '(waiting)',
    paused: '(paused)',
  }[state.prompt];
  ($('prompt') as HTMLInputElement).disabled =
    state.prompt === 'paused' || state.prompt === 'sleeping';
  savedLibraries = state.savedLibraries;
  syncScript(state.source);
  renderSetup(state);
  const text = JSON.stringify(state.manifest);
  if (text !== manifest) {
    manifest = text;
    lsp.configure({ manifest: state.manifest });
  }
  renderPause(state.pause);
  for (const tab of tabs) {
    const lines = state.breakpoints
      .filter(
        b =>
          b.tab === (tab.kind === 'script' ? SESSION_TAB : tab.name) &&
          b.verified,
      )
      .map(b => b.line);
    if (tab === tabs[active]) {
      view.dispatch({ effects: markVerified(lines) });
    } else {
      tab.state = tab.state.update({ effects: markVerified(lines) }).state;
    }
  }
  renderTabs();
};

// The Script tab is the session source (ADR 0051): a clean tab follows the
// session; a tab with unapplied edits keeps them.
const syncScript = (source: string) => {
  if (source === sessionSource) {
    return;
  }
  const script = scriptTab();
  const text = tabText(script);
  const wasClean = isClean(text, sessionSource);
  sessionSource = source;
  const banner = $('banner');
  if (isClean(text, source)) {
    banner.hidden = true;
  } else if (wasClean) {
    const state = script === tabs[active] ? view.state : script.state;
    const update = state.update({
      changes: { from: 0, to: state.doc.length, insert: source },
    });
    if (script === tabs[active]) {
      view.dispatch(update);
    } else {
      script.state = update.state;
      lsp.change(script.uri, source);
    }
    banner.hidden = true;
  } else {
    banner.textContent =
      'The session changed at the prompt while the Script tab has unapplied edits. Your edits are kept; Apply compares against the session as it is now.';
    banner.hidden = false;
  }
};

const renderSetup = (state: SessionState) => {
  const list = $('setup');
  list.replaceChildren(
    ...state.setup.map(command => {
      const li = document.createElement('li');
      li.textContent = command;
      return li;
    }),
  );
  for (const form of ['grant-form', 'mock-form']) {
    for (const el of $(form).querySelectorAll('input, select, button')) {
      (el as HTMLInputElement).disabled = state.started;
    }
  }
  $('grants').querySelector('.hint')!.textContent = state.started
    ? 'The session has started, so its Grants are fixed. Restart to change them.'
    : 'Before the session starts. console is always granted.';
};

const pauseText = (
  pause: Omit<PauseView, 'tab'> & { tab?: PauseView['tab'] },
) =>
  [
    `paused: ${pause.reason} in ${pause.run} at ${pause.tab ? `${pause.tab.name}.talk:${pause.tab.line}` : `${pause.unit}:${pause.line}`}`,
    ...(pause.error ? [`error ${pause.error}`] : []),
    ...(pause.limit ? [`limit ${pause.limit}`] : []),
    '',
    'frames:',
    ...pause.frames.flatMap(f => [
      `  ${f.handler ?? '?'} at ${f.unit}:${f.line}`,
      ...f.locals.map(l => `    ${l}`),
    ]),
    '',
    'runs:',
    ...pause.views.runs.map(l => `  ${l}`),
    'mailbox:',
    ...pause.views.mailbox.map(l => `  ${l}`),
    'vars:',
    ...pause.views.vars.map(l => `  ${l}`),
  ].join('\n');

const renderPause = (pause: PauseView | null) => {
  for (const id of ['debug-resume', 'debug-step', 'debug-over', 'debug-out']) {
    ($(id) as HTMLButtonElement).disabled = !pause;
  }
  for (const id of ['apply', 'restart']) {
    ($(id) as HTMLButtonElement).disabled = Boolean(pause);
  }
  $('pause-view').textContent = pause ? pauseText(pause) : '';
  if (lastPause?.tab) {
    const tab = tabs.find(
      t =>
        (t.kind === 'script' ? SESSION_TAB : t.name) === lastPause!.tab!.name,
    );
    if (tab === tabs[active]) {
      view.dispatch({ effects: pausedAt(null) });
    } else if (tab) {
      tab.state = tab.state.update({ effects: pausedAt(null) }).state;
    }
  }
  lastPause = pause;
  if (pause?.tab) {
    const index = tabs.findIndex(
      t => (t.kind === 'script' ? SESSION_TAB : t.name) === pause.tab!.name,
    );
    if (index >= 0) {
      switchTo(index);
      view.dispatch({
        effects: pausedAt(pause.tab.line),
        selection: {
          anchor: view.state.doc.line(
            Math.min(pause.tab.line, view.state.doc.lines),
          ).from,
        },
        scrollIntoView: true,
      });
    }
  }
  if (pause) {
    ($('debugger') as HTMLDetailsElement).open = true;
  }
};

const sendBreakpoints = () => {
  const breakpoints = tabs.flatMap(tab =>
    breakpointLines(tab === tabs[active] ? view.state : tab.state).map(
      line => ({
        tab: tab.kind === 'script' ? SESSION_TAB : tab.name,
        line,
      }),
    ),
  );
  void call({
    t: 'breakpoints',
    breakpoints,
    faults: {
      error: ($('break-error') as HTMLInputElement).checked,
      limitFault: ($('break-limit') as HTMLInputElement).checked,
    },
    tabs: currentTabs(),
  });
};

// ------------------------------------------------------------- actions

const applied = (response: SessionResponse) => {
  if (response.t !== 'applied') {
    return;
  }
  const result = response.result;
  if (result.kind === 'syntax') {
    note(`The Script tab has a syntax error: ${result.error}`, 'error');
  } else if (result.kind === 'restart') {
    if (
      confirm(
        `The Script tab no longer has ${result.removed.join(', ')}, which only a Restart removes. Restart now?`,
      )
    ) {
      void restart();
    }
  } else {
    for (const failed of result.failed) {
      note(`${failed.key} did not load: ${failed.lines.join('; ')}`, 'error');
    }
    if (result.pending) {
      note(
        `Paused with ${result.pending} declarations left; Apply again after continuing.`,
        'warning',
      );
    }
  }
  sendBreakpoints();
};

const apply = async () =>
  applied(await call({ t: 'apply', script: tabText(scriptTab()) }));
const restart = async () => {
  applied(await call({ t: 'restart', tabs: currentTabs() }));
};
const saveActive = async () => {
  const tab = tabs[active]!;
  if (tab.kind === 'script') {
    await apply();
  } else {
    await call({
      t: 'saveLibrary',
      library: { name: tab.name, source: tabText(tab) },
    });
    sendBreakpoints();
  }
};

$('apply').onclick = () => void apply();
$('restart').onclick = () => {
  if (
    confirm(
      'Restart: a fresh session from the Grants and the tabs. Its Runs and Script Variables are lost. Go on?',
    )
  ) {
    void restart();
  }
};
$('format').onclick = async () => {
  const tab = tabs[active]!;
  const edits = await lsp.request<
    { newText: string; range: { end: Position; start: Position } }[]
  >('textDocument/formatting', {
    textDocument: { uri: tab.uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  if (!edits.length) {
    note('Nothing to format, or the tab has a syntax error.');
    return;
  }
  view.dispatch({
    changes: edits.map(e => ({
      from: offsetOf(view.state.doc, e.range.start),
      to: offsetOf(view.state.doc, e.range.end),
      insert: e.newText,
    })),
  });
};
$('download').onclick = async () => {
  const response = await call({ t: 'transcript' });
  if (response.t !== 'transcript') {
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(
    new Blob([response.text], { type: 'text/plain' }),
  );
  link.download = 'session.transcript';
  link.click();
  URL.revokeObjectURL(link.href);
};

// Share
const shareUrl = async () => {
  const shared: Shared = currentTabs();
  if (($('share-transcript') as HTMLInputElement).checked) {
    const response = await call({ t: 'transcript' });
    if (response.t === 'transcript' && response.text) {
      shared.transcript = response.text;
    }
  }
  const url = `${location.origin}${location.pathname}#${await encodeLink(shared)}`;
  ($('share-url') as HTMLInputElement).value = url;
  $('share-size').textContent =
    url.length > 8000
      ? `${url.length} characters: some sites truncate links this long.`
      : `${url.length} characters`;
};
$('share').onclick = async () => {
  await shareUrl();
  ($('share-dialog') as HTMLDialogElement).showModal();
};
$('share-transcript').onchange = () => void shareUrl();
$('share-copy').onclick = () =>
  void navigator.clipboard.writeText(
    ($('share-url') as HTMLInputElement).value,
  );

// Lints and readings
const profileSelect = $('profile') as HTMLSelectElement;
profileSelect.onchange = () => {
  profile = profileSelect.value === 'standard' ? 'standard' : 'beginner';
  lsp.notify('workspace/didChangeConfiguration', {
    settings: { northtalk: { profile } },
  });
  scheduleAutosave();
};
const readings = $('readings') as HTMLInputElement;
readings.onchange = () => {
  document.body.classList.toggle('readings', readings.checked);
  scheduleAutosave();
};

// The prompt
const promptInput = $('prompt') as HTMLInputElement;
const history: string[] = [];
let historyAt = 0;
$('prompt-form').onsubmit = async event => {
  event.preventDefault();
  const text = promptInput.value;
  promptInput.value = '';
  if (text.trim()) {
    history.push(text);
  }
  historyAt = history.length;
  const response = await call({ t: 'line', text });
  if (response.t === 'state' && response.state.prompt === 'continue') {
    $('pending').textContent +=
      `${$('pending').textContent ? '\n' : '> '}${$('pending').textContent ? '| ' : ''}${text}`;
  }
};
promptInput.onkeydown = event => {
  if (event.key === 'Escape') {
    void call({ t: 'cancel' });
  } else if (event.key === 'ArrowUp' && historyAt > 0) {
    promptInput.value = history[--historyAt]!;
    event.preventDefault();
  } else if (event.key === 'ArrowDown' && historyAt < history.length) {
    promptInput.value = history[++historyAt] ?? '';
    event.preventDefault();
  }
};
$('cancel').onclick = () => void call({ t: 'cancel' });

// Grants
$('grant-form').onsubmit = event => {
  event.preventDefault();
  const name = ($('grant-name') as HTMLInputElement).value.trim();
  const capability = ($('grant-capability') as HTMLSelectElement).value;
  const binding = ($('grant-binding') as HTMLInputElement).value.trim();
  void call({
    t: 'line',
    text: `:grant ${name} ${capability}${binding ? ` ${binding}` : ''}`,
  });
};
$('mock-form').onsubmit = event => {
  event.preventDefault();
  const target = ($('mock-target') as HTMLInputElement).value.trim();
  const mode = ($('mock-mode') as HTMLSelectElement).value;
  void call({ t: 'line', text: `:mock ${target} ${mode}` });
};

// Live debugger
for (const [id, action] of [
  ['debug-resume', 'resume'],
  ['debug-step', 'step'],
  ['debug-over', 'stepOver'],
  ['debug-out', 'stepOut'],
] as const) {
  $(id).onclick = () => void call({ t: 'debug', action });
}
$('break-error').onchange = sendBreakpoints;
$('break-limit').onchange = sendBreakpoints;

// Replay debugger
const replaySources: Record<string, string> = {};
let needed: string | null = null;
const showReplay = (response: SessionResponse) => {
  if (response.t === 'needSource') {
    needed = response.file;
    $('replay-need').hidden = false;
    $('replay-need-label').textContent =
      `No tab is named after ${response.file}: paste its source, then Load again.`;
    return;
  }
  if (response.t !== 'replay') {
    return;
  }
  $('replay-need').hidden = true;
  const r: ReplayView = response.replay;
  $('replay-view').textContent = [
    `Host Input ${r.hostInputIndex} of ${r.hostInputCount} (${r.state})`,
    ...(r.pause ? ['', pauseText(r.pause)] : []),
  ].join('\n');
};
$('replay-load').onclick = async () => {
  if (needed) {
    replaySources[needed] = ($('replay-source') as HTMLTextAreaElement).value;
    needed = null;
  }
  const trace = ($('replay-trace') as HTMLTextAreaElement).value;
  const setup = ($('replay-setup') as HTMLTextAreaElement).value;
  const loaded = await call({
    t: 'replayLoad',
    tabs: currentTabs(),
    sources: replaySources,
    ...(trace.trim() ? { trace } : {}),
    ...(setup.trim() ? { setup } : {}),
  });
  showReplay(loaded);
  if (loaded.t !== 'replay') {
    return;
  }
  await replayBreakpoints();
};
const replayBreakpoints = async () => {
  const breakpoints = ($('replay-breaks') as HTMLInputElement).value
    .split(',')
    .map(s => /^\s*(.+):(\d+)\s*$/u.exec(s))
    .flatMap(m => (m ? [{ unit: m[1]!, line: Number(m[2]) }] : []));
  showReplay(
    await call({
      t: 'replay',
      op: {
        breakpoints,
        faults: {
          error: ($('replay-error') as HTMLInputElement).checked,
          limitFault: ($('replay-limit') as HTMLInputElement).checked,
        },
      },
    }),
  );
};
for (const id of ['replay-breaks', 'replay-error', 'replay-limit']) {
  $(id).onchange = () => void replayBreakpoints();
}
for (const [id, op] of [
  ['replay-resume', 'resume'],
  ['replay-step', 'step'],
  ['replay-over', 'stepOver'],
  ['replay-out', 'stepOut'],
  ['replay-back', 'back'],
] as const) {
  $(id).onclick = async () => showReplay(await call({ t: 'replay', op }));
}
$('replay-go').onclick = async () =>
  showReplay(
    await call({
      t: 'replay',
      op: { input: Number(($('replay-input') as HTMLInputElement).value) },
    }),
  );

// ------------------------------------------------------------- start

const start = async () => {
  let shared: Shared | null = null;
  if (location.hash.length > 1) {
    try {
      shared = await decodeLink(location.hash);
    } catch (error) {
      note(
        `The link could not be read: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }
  const saved = loadSaved();
  profile = saved?.profile ?? 'beginner';
  profileSelect.value = profile;
  readings.checked = saved?.showReadings ?? false;
  document.body.classList.toggle('readings', readings.checked);
  lsp.notify('workspace/didChangeConfiguration', {
    settings: { northtalk: { profile } },
  });
  const source = shared ?? saved ?? { script: WELCOME, libraries: [] };
  addTab('script', SESSION_TAB, source.script);
  for (const library of source.libraries) {
    addTab('library', library.name, library.source);
  }
  configureSources();
  view.setState(tabs[0]!.state);
  renderTabs();
  const response = await call({ t: 'open', ...(shared ? { shared } : {}) });
  if (response.t === 'mismatch') {
    const d = response.difference;
    note(
      `The shared Transcript replays differently at line ${d.line}: expected ${d.expected}, got ${d.actual}. The session did not go live; the Replay debugger can step through what did replay.`,
      'error',
    );
    ($('replay') as HTMLDetailsElement).open = true;
  } else if (shared) {
    note(
      shared.transcript
        ? 'Opened a Shared Link.'
        : 'Opened a Shared Link: Apply to run its Script tab.',
    );
  } else {
    note('NorthTalk Playground. :help lists the Session Commands.');
  }
  scheduleHints();
};
// Opening another Shared Link in this page starts over from it.
window.addEventListener('hashchange', () => location.reload());
void start();

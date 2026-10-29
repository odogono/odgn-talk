// Browser driving and reader input stay outside the testable Play Session.
// Browsing plays the Project in place on the desk, beside the Tools and
// Code Browser; presenting plays it full-window with the editor hidden.
// The session runs in the Play worker (#1225); the page draws from its
// mirror of Play State and posts reader input to the worker.
import type { DeepReadonly } from './readonly';
import { WorkerSupervisor } from '@northtalk/tooling/worker-supervisor';
import { scriptNameProblems } from './script-names';
import { byId, h, isTyping } from './dom';
import { ErrorsWindow } from './errors';
import { PerformanceWindow } from './performance-window';
import { mountMessageWindow } from './message-window';
import { type Element, type Project, type TextElement } from './model';
import { firstView } from './play-host';
import { commitDrawings, PlayMirror, type MirrorPage } from './play-mirror';
import { mountPlayPrompts } from './play-prompts';
import {
  type PlayRequest,
  type PlayResponse,
  type ReaderMessage,
} from './play-protocol';
import { ReaderTextHistory } from './play-text';
import {
  ownerById,
  ownerId,
  scriptOwners,
  type ScriptOwner,
  scriptPage,
} from './script-manifest';
import { browserSoundBackend } from './sounds';
import { createElement, type HTMLAttributes } from 'preact';
import { ElementView, renderElements } from './element-view';
import { type PlayMode, type StackShell } from './stack';
import { clickEvent, type ClickEvent, type ReaderArg } from './pointer';
import { isPlayKey } from './shortcuts';
import { InPlaceTextEditor } from './text-editor';
import { VariablesWindow } from './variables-window';
import {
  addRecordedTest,
  RECORDED_SCRIPT,
  Recorder,
  replayRecording,
} from './recorder';
import { readerView, type ReaderView } from './test-runner';

/** How often the Variables window reads a browsing session, in ms. */
const VARIABLES_REFRESH = 100;

/** Shown when the worker was ended because Stop got no answer in time. */
export const UNRESPONSIVE = 'Play was stopped: a Script did not respond';

export const mountPlay = (shell: StackShell): void => {
  // Play presents the Project; Pause and Step act on any Play Session.
  const toggle = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Play: present the Project (⌘↩)',
    },
    'Play',
  );
  const pauseButton = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      disabled: true,
      title: 'Pause (⌘.)',
    },
    'Pause',
  );
  const stepButton = h(
    'button',
    { type: 'button', disabled: true, title: "Step one frame (⌘')" },
    'Step',
  );
  byId('menu').append(
    h(
      'div',
      { id: 'play-controls', role: 'group', 'aria-label': 'Play' },
      toggle,
      pauseButton,
      stepButton,
    ),
  );
  // Browse and Edit head the Tools window, as HyperCard's browse tool did.
  const browseTool = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Browse: try the Project here',
    },
    h('span', { 'aria-hidden': 'true' }, '☞'),
    'Browse',
  );
  // Record Test (ADR 0134) Browses from a test's start and writes what
  // the reader does as a Recorded Test.
  const recordTool = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Record Test: Browse from the first Page and write a test',
    },
    h('span', { 'aria-hidden': 'true' }, '●'),
    'Record Test',
  );
  const editTool = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'true',
      title: 'Edit: select and change',
    },
    h('span', { 'aria-hidden': 'true' }, '↖'),
    'Edit',
  );
  byId('tools').before(
    h(
      'div',
      { id: 'tool-modes', role: 'group', 'aria-label': 'Mode' },
      browseTool,
      recordTool,
      editTool,
    ),
  );
  const errors = new ErrorsWindow(shell);
  let captureEpoch: number | undefined;
  const profiler = new PerformanceWindow(
    epoch => {
      if (session && !session.stopped && captureEpoch !== epoch) {
        captureEpoch = epoch;
        post({ kind: 'performance', session: sessionId, epoch });
      }
    },
    index => {
      const owner = owners[index];
      if (owner && generation === shell.editor.generation) {
        const current = ownerById(shell.editor.project, ownerId(owner));
        if (current) {
          shell.openScript(current);
        }
      }
    },
  );
  // Clicking an authored Element in the Variables window selects it;
  // `index` places it in `list`, which is `owners` but for Edit's `:inspect`.
  const selectOwner = (
    list: readonly ScriptOwner[],
    of: number,
    index: number,
  ): void => {
    const owner = list[index];
    if (!owner || of !== shell.editor.generation) {
      return;
    }
    const project = shell.editor.project;
    const current = ownerById(project, ownerId(owner));
    const page = current && scriptPage(project, current);
    if (!current || !page || 'elements' in current) {
      return;
    }
    const pageIndex = project.pages.indexOf(page);
    if (pageIndex !== shell.editor.pageIndex) {
      shell.editor.goToPage(pageIndex);
    }
    shell.editor.click(current.name);
  };
  const variables = new VariablesWindow(
    index => selectOwner(owners, generation, index),
    () => sendWatches(),
  );
  // Watches go to a browsing session; the worker runs them while paused.
  const sendWatches = () => {
    if (mode === 'browse' && session && !session.stopped) {
      post({
        kind: 'watches',
        session: sessionId,
        watches: variables.watchesFor(sessionId),
      });
    }
  };
  let variablesTimer: ReturnType<typeof setInterval> | undefined;
  let variablesAsked = false;
  // Only while the window is open and Play is browsing; the worker answers
  // without values when no Pump has run since it was last asked.
  const refreshVariables = () => {
    if (
      variablesAsked ||
      !variables.visible ||
      mode !== 'browse' ||
      !session ||
      session.stopped
    ) {
      return;
    }
    const asked = sessionId;
    variablesAsked = true;
    void supervisor.call({ kind: 'variables', session: asked }).then(reply => {
      variablesAsked = false;
      if (reply.kind === 'variables' && reply.scripts && asked === sessionId) {
        variables.update(reply.scripts);
      }
    });
  };
  const reader = h('div', {
    id: 'reader',
    role: 'region',
    hidden: true,
    tabindex: '-1',
    'aria-label': 'Play Session',
  });
  const pageNode = h('div', { class: 'page' });
  // The Page is laid out at design size and scaled with a transform,
  // which does not shrink its layout box. The scaler carries the scaled
  // size, so at narrow widths the reader scrolls only vertically and
  // the scaled Page fits its width (as the editor's stage does).
  const scaler = h('div', { class: 'play-scale' }, pageNode);
  reader.append(scaler);
  // A playing Page is the reader's app: secondary clicks go to its Scripts.
  pageNode.addEventListener('contextmenu', event => {
    if (session && !session.stopped) {
      event.preventDefault();
    }
  });
  // `user` prompts cover the Page, unscaled, and answering resumes Play.
  const prompts = mountPlayPrompts(scaler, (prompt, value) => {
    recorder?.unrecorded('a prompt answer');
    post({ kind: 'answer', session: sessionId, prompt: prompt.id, value });
  });
  const toolbar = byId('text-toolbar').cloneNode(true) as HTMLElement;
  toolbar.id = 'play-text-toolbar';
  toolbar.hidden = true;
  delete toolbar.dataset.scope;
  toolbar.setAttribute('aria-label', 'Reader text formatting');
  document.body.append(toolbar, reader);
  let session: PlayMirror | undefined;
  // Each session's id; the worker's word about an earlier one is dropped.
  let sessionId = 0;
  // The Project as it was when Play started, for assets and problem owners.
  let playing: Project | undefined;
  // Problem owners by the place the worker names, in the authored Project.
  let owners: ReturnType<typeof scriptOwners<DeepReadonly<Project>>> = [];
  let libraries: DeepReadonly<Project['libraries']> = [];
  let mode: PlayMode | undefined;
  let recorder: Recorder | undefined;
  // requestAnimationFrame pauses with a hidden tab, so frames do too.
  let frameRequest: number | undefined;
  let generation = 0;
  let drawnPage: MirrorPage | undefined;
  let activeText: InPlaceTextEditor | undefined;
  // Physical key codes keep releases paired if modifiers change event.key.
  const heldKeys = new Map<
    string,
    { key: string; pageIndex: number; target: MirrorPage | TextElement }
  >();
  // The press `pointerHeld` reports each frame until release or leave.
  let press:
    | {
        element: Element;
        node: HTMLElement;
        start: number;
        x: number;
        y: number;
      }
    | undefined;
  let pressRequest: number | undefined;
  // Sounds play here for the worker, each voice under the worker's number.
  const voices = new Map<number, { stop(): void }>();
  const silence = () => {
    for (const voice of voices.values()) {
      voice.stop();
    }
    voices.clear();
  };
  const supervisor = new WorkerSupervisor<PlayRequest, PlayResponse>({
    ended: { kind: 'ended' },
    spawn: () => new Worker('./play.worker.js', { type: 'module' }),
    onMessage: response => receive(response),
    // Only Stop is supervised. The ended worker's session is gone with it,
    // so a session started since then ends too; the replacement waits idle.
    onTerminated: () => {
      profiler.interrupted();
      silence();
      leave();
      errors.add([{ owner: shell.editor.project, message: UNRESPONSIVE }]);
    },
  });
  const post = (request: PlayRequest) => void supervisor.call(request);
  /** `pageIndex` names the Page `target` is on, if it isn't the showing one. */
  const sendTo = (
    target: MirrorPage | Element,
    message: ReaderMessage,
    args?: ReaderArg[],
    pageIndex = session?.page.index,
  ) => {
    if (!session || session.stopped || session.navigating || session.paused) {
      return;
    }
    if (recorder && message === 'click' && !('index' in target)) {
      recorder.click(target.name, args![0] as ClickEvent);
    } else if (recorder && message === 'pointerHeld') {
      recorder.unrecorded('a held press');
    } else if (recorder && message === 'keyDown' && args) {
      if ('index' in target) {
        recorder.key(args[0] as string);
      } else {
        recorder.unrecorded('typing');
      }
    }
    post({
      kind: 'send',
      session: sessionId,
      pageIndex: pageIndex!,
      message,
      ...('index' in target ? {} : { target: target.name }),
      ...(args ? { args } : {}),
    });
  };
  const receive = (response: PlayResponse) => {
    if (response.kind === 'watches') {
      if (response.session === sessionId) {
        variables.watchResults(response.results, response.pageChanged);
      }
      return;
    }
    if (response.kind === 'performance') {
      profiler.receive(response.session, response.snapshot);
      return;
    }
    if (response.kind === 'play') {
      const done = (error?: string) => {
        if (voices.delete(response.voice)) {
          post({
            kind: 'soundEnded',
            voice: response.voice,
            ...(error === undefined ? {} : { error }),
          });
        }
      };
      try {
        voices.set(
          response.voice,
          browserSoundBackend(asset => shell.images.url(asset))(
            response.asset,
            response.loop,
            () => done(),
            done,
          ),
        );
      } catch (error) {
        voices.set(response.voice, { stop() {} });
        done(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (response.kind === 'stopSound') {
      voices.get(response.voice)?.stop();
      voices.delete(response.voice);
      return;
    }
    if (
      response.kind !== 'view' ||
      !session ||
      response.session !== sessionId
    ) {
      return;
    }
    const wasPaused = session.paused;
    session.apply(response);
    if (mode === 'browse') {
      variables.context(sessionId, session.messageTargets, session.paused);
    }
    if (session.paused !== wasPaused) {
      drawModes();
    }
    if (response.messageTargets) {
      syncMessage();
    }
    draw();
    prompts.draw(session.prompt, response.notices);
    errors.add(
      response.problems.map(problem => ({
        line: problem.line,
        message: problem.message,
        owner: owners[problem.owner] ?? shell.editor.project,
        ...(problem.target?.kind === 'library' &&
        libraries[problem.target.index]
          ? {
              target: {
                kind: 'library' as const,
                library: libraries[problem.target.index]!,
              },
            }
          : {}),
      })),
    );
    requestFrame();
  };
  const releaseKeys = () => {
    // send ignores input during closePage; keep releases until navigation
    // finishes so the surviving Project Handler still receives them.
    if (session?.navigating) {
      return;
    }
    // A Page left since the press still gets its release, as the old
    // Page's Message Path leads on to any surviving Project Handler.
    for (const { key, pageIndex, target } of heldKeys.values()) {
      sendTo(target, 'keyUp', [key], pageIndex);
    }
    heldKeys.clear();
  };
  const histories = new Map<TextElement, ReaderTextHistory>();
  const closeText = () => {
    const editor = activeText;
    activeText = undefined;
    editor?.destroy();
    if (editor) {
      editor.node.contentEditable =
        session &&
        !session.stopped &&
        !session.navigating &&
        editor.history.element.editable &&
        session.isVisible(editor.history.element)
          ? 'true'
          : 'false';
    }
    toolbar.hidden = true;
  };
  const openText = (node: HTMLElement, element: TextElement) => {
    if (
      !session ||
      session.stopped ||
      session.navigating ||
      session.paused ||
      !element.editable
    ) {
      return;
    }
    if (activeText?.node === node) {
      return;
    }
    closeText();
    let history = histories.get(element);
    if (!history) {
      history = new ReaderTextHistory(session, element);
      histories.set(element, history);
    }
    activeText = new InPlaceTextEditor(
      node,
      toolbar,
      history,
      () => {
        node.dataset.renderedRichText = JSON.stringify(element.richText);
      },
      () => {
        closeText();
        node.blur();
      },
      { escape: () => leave(), selectAll: false },
    );
  };

  const draw = () => {
    if (!session) {
      return;
    }
    const play = session;
    if (drawnPage !== play.page) {
      // Old Page Scripts have stopped; release to any surviving Project
      // Handler and require a fresh press on the new Page.
      releaseKeys();
      endPress();
      closeText();
      pageNode.replaceChildren();
      drawnPage = play.page;
      reader.scrollTop = 0;
    }
    const scale = Math.min(
      1,
      Math.max(
        0.1,
        (reader.clientWidth - (mode === 'present' ? 32 : 0)) / play.designWidth,
      ),
    );
    // Present places the Page by its alignment. Auto margins in the flex
    // reader centre it without clipping a Page larger than the window.
    const presenting = mode === 'present';
    const before = (align: string | undefined, start: string) =>
      presenting && align !== start ? 'auto' : '';
    const after = (align: string | undefined, end: string) =>
      presenting && align !== end ? 'auto' : '';
    const { alignX, alignY } = play.page;
    Object.assign(scaler.style, {
      width: `${play.designWidth * scale}px`,
      height: `${play.page.height * scale}px`,
      marginLeft: before(alignX, 'left'),
      marginRight: after(alignX, 'right'),
      marginTop: before(alignY, 'top'),
      marginBottom: after(alignY, 'bottom'),
    });
    Object.assign(pageNode.style, {
      width: `${play.designWidth}px`,
      height: `${play.page.height}px`,
      background: play.page.background,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
    });
    if (
      activeText &&
      !play
        .elementsOf()
        .some(element => element === activeText!.history.element)
    ) {
      closeText();
    }
    renderElements(
      pageNode,
      play
        .elementsOf()
        .filter(element => element.kind !== 'group')
        .map(element => {
          if (
            activeText?.history.element === element &&
            (play.stopped ||
              play.navigating ||
              !play.isVisible(element) ||
              !element.editable)
          ) {
            closeText();
          }
          return createElement(ElementView, {
            key: element.id,
            element,
            reader: true,
            editing: activeText?.history.element === element,
            className:
              activeText?.history.element === element ? 'text-editing' : '',
            imageUrl:
              element.kind === 'image'
                ? shell.images.url(
                    playing!.assets.find(a => a.name === element.image),
                  )
                : undefined,
            attributes: readerAttributes(play, element),
          });
        }),
    );
    // A Script may rewrite the text the reader is editing.
    if (activeText) {
      const { node } = activeText;
      const json = JSON.stringify(activeText.history.element.richText);
      if (node.dataset.renderedRichText !== json) {
        activeText.refresh();
        node.dataset.renderedRichText = json;
      }
    }
  };
  /** What a playing Element adds: reader input, focus and editability. */
  const readerAttributes = (
    play: PlayMirror,
    element: Element,
  ): HTMLAttributes<HTMLDivElement> => {
    const send = (name: 'pointerEnter' | 'pointerLeave') =>
      sendTo(element, name);
    const click = (event: MouseEvent) => {
      const touch = 'pointerType' in event && event.pointerType === 'touch';
      if (touch) {
        send('pointerEnter');
      }
      sendTo(element, 'click', [
        clickAt(event.currentTarget as HTMLElement, event),
      ]);
      if (touch) {
        send('pointerLeave');
      }
    };
    const visible = play.isVisible(element);
    return {
      hidden: !visible,
      ...(element.kind === 'text' && {
        contentEditable:
          element.editable && visible && !play.stopped && !play.navigating
            ? 'true'
            : 'false',
      }),
      ...(element.kind === 'button' && {
        tabIndex: visible ? 0 : -1,
        role: 'button',
        'aria-label': element.label || element.name,
      }),
      onPointerEnter: event => {
        if (event.pointerType !== 'touch') {
          send('pointerEnter');
        }
      },
      onPointerLeave: event => {
        if (press?.node === event.currentTarget) {
          endPress();
        }
        if (event.pointerType !== 'touch') {
          send('pointerLeave');
        }
      },
      onPointerDown: event => {
        if (
          event.button === 0 &&
          event.isPrimary &&
          session?.heldElements.has(element.name)
        ) {
          startPress(element, event.currentTarget, event);
        }
      },
      onPointerUp: endPress,
      onPointerCancel: endPress,
      // Middle and secondary buttons arrive as `auxclick`, not `click`.
      onAuxClick: event => {
        if (event.button === 1 || event.button === 2) {
          click(event);
        }
      },
      onClick: event => {
        click(event);
        // A pointer click leaves the keys with the Page, as games expect.
        if (event.detail > 0 && element.kind === 'button') {
          reader.focus();
        }
      },
      onFocus: event => {
        if (element.kind === 'text') {
          openText(event.currentTarget, element);
        }
      },
      onBlur: event => {
        if (!toolbar.contains(event.relatedTarget as Node | null)) {
          closeText();
        }
      },
    };
  };
  /** Where `event` fell on `node`, in Page units from its top-left corner. */
  const pageOffset = (node: HTMLElement, event: MouseEvent) => {
    const box = node.getBoundingClientRect();
    const scale = box.width / (node.offsetWidth || 1) || 1;
    return {
      x: (event.clientX - box.left) / scale,
      y: (event.clientY - box.top) / scale,
    };
  };
  /** A keyboard activation has no position, so it clicks the centre. */
  const clickAt = (node: HTMLElement, event: MouseEvent): ClickEvent => {
    if (event.detail === 0) {
      return clickEvent(0, node.offsetWidth / 2, node.offsetHeight / 2);
    }
    const { x, y } = pageOffset(node, event);
    return clickEvent(event.button, x, y);
  };
  const startPress = (
    element: Element,
    node: HTMLElement,
    event: PointerEvent,
  ) => {
    endPress();
    press = {
      element,
      node,
      start: performance.now(),
      ...pageOffset(node, event),
    };
    const tick = () => {
      if (!press || !session || session.stopped || session.paused) {
        pressRequest = undefined;
        return;
      }
      const { x, y } = clickEvent(0, press.x, press.y);
      sendTo(press.element, 'pointerHeld', [
        { held: Math.round(performance.now() - press.start), x, y },
      ]);
      pressRequest = requestAnimationFrame(tick);
    };
    pressRequest = requestAnimationFrame(tick);
  };
  const endPress = () => {
    press = undefined;
    if (pressRequest !== undefined) {
      cancelAnimationFrame(pressRequest);
      pressRequest = undefined;
    }
  };
  const requestFrame = () => {
    if (frameRequest !== undefined || !session?.wantsFrames) {
      return;
    }
    frameRequest = requestAnimationFrame(() => {
      frameRequest = undefined;
      // A paused session asks again when its Resume's view arrives.
      if (!session || session.stopped || session.paused) {
        return;
      }
      post({ kind: 'frame', session: sessionId });
      requestFrame();
    });
  };
  /**
   * Silences Play at once, then asks the worker to stop its session. A
   * worker that doesn't answer in time is ended (ADR 0107).
   */
  const stopPlay = () => {
    heldKeys.clear();
    endPress();
    if (!session) {
      return;
    }
    closeText();
    if (frameRequest !== undefined) {
      cancelAnimationFrame(frameRequest);
      frameRequest = undefined;
    }
    silence();
    session.stopped = true;
    clearInterval(variablesTimer);
    variablesTimer = undefined;
    variables.end();
    void supervisor.supervise({ kind: 'stop', session: sessionId });
  };
  const drawModes = () => {
    const live = Boolean(session && !session.stopped);
    const paused = live && session!.paused;
    toggle.textContent = mode === 'present' ? 'Stop' : 'Play';
    toggle.setAttribute('aria-pressed', String(mode === 'present'));
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.disabled = !live;
    stepButton.disabled = !paused;
    reader.classList.toggle('paused', paused);
    browseTool.setAttribute(
      'aria-pressed',
      String(mode === 'browse' && !recorder),
    );
    recordTool.setAttribute('aria-pressed', String(Boolean(recorder)));
    editTool.setAttribute('aria-pressed', String(mode === undefined));
    document.body.classList.toggle('playing', mode === 'present');
    document.body.classList.toggle('browsing', mode === 'browse');
  };
  /**
   * Ends Play, discarding Play State but committing each Canvas's Drawing as
   * shown (ADR 0116), unless another Project has replaced this one. Browsing
   * leaves Edit on its Page.
   */
  const leave = (commit = true) => {
    if (!session) {
      return;
    }
    if (recorder && playing) {
      void finishRecording(
        playing,
        recorder,
        readerView(playing, session),
        session.wantsFrames,
      );
    }
    recorder = undefined;
    const ended = session;
    const pageName = session.page.name;
    const browsed = mode === 'browse';
    stopPlay();
    session = undefined;
    playing = undefined;
    mode = undefined;
    histories.clear();
    prompts.clear();
    reader.hidden = true;
    pageNode.replaceChildren();
    drawModes();
    const index = shell.editor.project.pages.findIndex(
      p => p.name === pageName,
    );
    if (browsed && index >= 0 && index !== shell.editor.pageIndex) {
      shell.editor.goToPage(index);
    }
    shell.setPlaying(undefined);
    if (commit && generation === shell.editor.generation) {
      commitDrawings(shell.editor, owners, ended);
    }
  };
  let errorsGeneration = shell.editor.generation;
  const start = (next: PlayMode, record = false) => {
    leave();
    errors.clear();
    errorsGeneration = shell.editor.generation;
    const names = scriptNameProblems(shell.editor.project);
    if (names.length) {
      errors.add(names);
      return;
    }
    mode = next;
    // A Recorded Test starts where every test does: the first Page, seed 0.
    const pageIndex = record ? 0 : shell.editor.pageIndex;
    recorder = record ? new Recorder(() => performance.now()) : undefined;
    shell.setPlaying(mode);
    generation = shell.editor.generation;
    playing = shell.editor.project as Project;
    owners = scriptOwners(shell.editor.project);
    libraries = [...shell.editor.project.libraries];
    sessionId++;
    profiler.reset(sessionId);
    captureEpoch = profiler.visible ? profiler.results.epoch : undefined;
    session = new PlayMirror((element, richText, pageIndex, edit) => {
      recorder?.unrecorded('typing');
      post({
        kind: 'text',
        session: sessionId,
        pageIndex,
        name: element.name,
        richText,
        edit,
      });
    });
    post({
      kind: 'open',
      ...(captureEpoch === undefined ? {} : { performanceEpoch: captureEpoch }),
      session: sessionId,
      project: playing,
      pageIndex,
      // A different game each time (ADR 0096), unless recording a test.
      seed: record ? 0n : BigInt(Date.now()),
    });
    // Draw the authored Page at once, as the worker starts its session.
    session.apply(firstView(playing, pageIndex, sessionId));
    syncMessage();
    histories.clear();
    variables.start();
    if (mode === 'browse') {
      variablesTimer = setInterval(refreshVariables, VARIABLES_REFRESH);
      sendWatches();
      byId('desk').append(toolbar, reader);
    } else {
      document.body.append(toolbar, reader);
    }
    reader.hidden = false;
    drawModes();
    draw();
    reader.focus();
  };
  toggle.addEventListener('click', () => {
    if (mode === 'present') {
      leave();
    } else {
      start('present');
    }
  });
  recordTool.addEventListener('click', () => {
    if (recorder) {
      leave();
    } else if (!shell.readOnly) {
      start('browse', true);
    }
  });
  // Writes the Recorded Test into the Project and opens it.
  const finishRecording = async (
    project: Project,
    recorded: Recorder,
    seen: ReaderView,
    frames: boolean,
  ) => {
    const recording = await replayRecording(project, recorded, seen, frames);
    if (shell.readOnly) {
      return;
    }
    let id = 0;
    let added = { line: 1, name: '', source: '' };
    shell.editor.edit(({ project: current, tree }) => {
      const existing = current.testScripts.find(
        s => s.name === RECORDED_SCRIPT,
      );
      added = addRecordedTest(existing?.source, recording.body);
      if (existing) {
        tree.setTestScriptSource(existing.id!, added.source);
        id = existing.id!;
      } else {
        id = tree.addTestScript(RECORDED_SCRIPT, added.source).id!;
      }
    });
    shell.redraw();
    shell.openTestScript(id, added.line);
    const notes = [
      ...recording.unrecorded.map(
        what =>
          `${added.name} doesn't replay ${what}; a comment marks where it was.`,
      ),
      ...(recording.drifted
        ? [
            `${added.name}'s replay ended differently from what you saw, so its assertions follow the replay.`,
          ]
        : []),
      ...recording.problems.map(
        problem => `${added.name} didn't replay cleanly: ${problem}`,
      ),
    ];
    errors.add(
      notes.map(message => ({ owner: shell.editor.project, message })),
    );
  };
  browseTool.addEventListener('click', () => {
    if (mode !== 'browse') {
      start('browse');
    }
  });
  editTool.addEventListener('click', () => leave());
  /** Pausing releases held keys first, as input while paused is dropped. */
  const togglePause = () => {
    if (!session || session.stopped) {
      return;
    }
    if (!session.paused) {
      releaseKeys();
      closeText();
    }
    if (session.paused) {
      recorder?.resume();
    } else {
      recorder?.pause();
    }
    post({ kind: session.paused ? 'resume' : 'pause', session: sessionId });
  };
  const step = () => {
    if (session && !session.stopped && session.paused) {
      post({ kind: 'step', session: sessionId });
    }
  };
  pauseButton.addEventListener('click', togglePause);
  stepButton.addEventListener('click', step);
  // Choosing an Element tool while browsing returns to Edit to add it.
  byId('tools').addEventListener(
    'click',
    event => {
      if (
        mode === 'browse' &&
        (event.target as HTMLElement).closest('button')
      ) {
        leave();
      }
    },
    { capture: true },
  );
  toolbar.addEventListener('focusout', event => {
    if (
      !toolbar.contains(event.relatedTarget as Node | null) &&
      event.relatedTarget !== activeText?.node
    ) {
      closeText();
    }
  });
  document.addEventListener('keydown', event => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      event.code === 'KeyP' &&
      !isTyping(event.target) &&
      !session?.prompt
    ) {
      event.preventDefault();
      if (!event.repeat) {
        profiler.toggle();
      }
      return;
    }
    // ⌘↩ starts and stops Present, from Edit, Browse or Present.
    if (
      isPlayKey(event) &&
      !isTyping(event.target) &&
      !prompts.contains(event.target as Node)
    ) {
      event.preventDefault();
      if (!event.repeat) {
        toggle.click();
      }
      return;
    }
    // A prompt's keys, Escape included, answer the prompt.
    if (!session || prompts.contains(event.target as Node)) {
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      (event.key === '.' || event.key === "'") &&
      !isTyping(event.target)
    ) {
      event.preventDefault();
      if (!event.repeat || event.key === "'") {
        (event.key === '.' ? togglePause : step)();
      }
      return;
    }
    // While browsing, Esc in the Code Browser or a menu stays with it.
    if (
      event.key === 'Escape' &&
      (mode === 'present' ||
        !(event.target as HTMLElement).closest('.window, #menu'))
    ) {
      event.preventDefault();
      leave();
      return;
    }
    if (
      session.stopped ||
      session.navigating ||
      session.paused ||
      !reader.contains(event.target as Node)
    ) {
      return;
    }
    const node = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-element]',
    );
    const element = session
      .elementsOf()
      .find(e => e.name === node?.dataset.element);
    if (element && !session.isVisible(element)) {
      event.preventDefault();
      return;
    }
    // Enter or Space activates a focused button, as in a browser, and is
    // not also a key for the Page.
    if (
      element?.kind === 'button' &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      sendTo(element, 'click', [
        clickEvent(0, element.width / 2, element.height / 2),
      ]);
      return;
    }
    const target =
      element?.kind === 'text' && element.editable ? element : session.page;
    const code = event.code || event.key;
    // A repeat after focus returns cannot start a new held key: its eventual
    // release may still belong to the window or Session that lost focus.
    if (!heldKeys.has(code)) {
      if (event.repeat) {
        return;
      }
      heldKeys.set(code, {
        key: event.key,
        pageIndex: session.page.index,
        target,
      });
    }
    // A handled key belongs to the Project: arrows and space don't scroll.
    // Editable text keeps typing, so only the Page's keys are claimed.
    if (target === session.page && session.pageHandles.keyDown) {
      event.preventDefault();
    }
    sendTo(target, 'keyDown', [event.key]);
  });
  document.addEventListener('keyup', event => {
    const code = event.code || event.key;
    const held = heldKeys.get(code);
    if (!session || !held || session.navigating) {
      return;
    }
    heldKeys.delete(code);
    if (held.target === session.page && session.pageHandles.keyUp) {
      event.preventDefault();
    }
    sendTo(held.target, 'keyUp', [held.key], held.pageIndex);
  });
  // Release to the original recipient before focus moves to another field,
  // the Code Browser or a prompt. The later physical keyup is ignored.
  reader.addEventListener('focusout', releaseKeys);
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseKeys();
    }
  });
  shell.onRedraw(() => {
    // Another Project's errors no longer point at anything here.
    if (errorsGeneration !== shell.editor.generation) {
      errorsGeneration = shell.editor.generation;
      errors.clear();
      profiler.reset(sessionId);
      captureEpoch = undefined;
      variables.clearWatches();
    }
    if (!session) {
      return;
    }
    if (generation !== shell.editor.generation) {
      leave(false);
    } else {
      draw();
    }
  });
  const syncMessage = mountMessageWindow(shell, {
    inspected: (text, value, context, inspectedIn) => {
      const [list, of] =
        inspectedIn === undefined
          ? [scriptOwners(shell.editor.project), shell.editor.generation]
          : [owners, generation];
      const select = (index: number) => selectOwner(list, of, index);
      variables.inspect(text, value, context, select);
      return select;
    },
    pageName: () => session?.page.name,
    session: () => (session && !session.stopped ? sessionId : undefined),
    scripts: () => (session && !session.stopped ? session.messageTargets : []),
    run: async (text, expectedSession, target) => {
      if (!session || session.stopped || sessionId !== expectedSession) {
        return { error: 'Play has stopped.' };
      }
      const reply = await supervisor.call({
        kind: 'message',
        session: expectedSession,
        text,
        ...(target === undefined ? {} : { target }),
      });
      return reply.kind === 'message'
        ? {
            ...(reply.error === undefined ? {} : { error: reply.error }),
            ...(reply.text === undefined ? {} : { text: reply.text }),
            ...(reply.value === undefined ? {} : { value: reply.value }),
            ...(reply.source === undefined ? {} : { source: reply.source }),
          }
        : { error: 'Play has stopped.' };
    },
  });
  window.addEventListener('resize', draw);
  window.addEventListener('pagehide', stopPlay);
};

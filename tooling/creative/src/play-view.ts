// Browser driving and reader input stay outside the testable Play Session.
// Browsing plays the Project in place on the desk, beside the Tools and
// Script windows; presenting plays it full-window with the editor hidden.
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
import { PlayMirror, type MirrorPage } from './play-mirror';
import { mountPlayPrompts } from './play-prompts';
import {
  type PlayRequest,
  type PlayResponse,
  type ReaderMessage,
} from './play-protocol';
import { ReaderTextHistory } from './play-text';
import { ownerById, ownerId, scriptOwners } from './script-manifest';
import { browserSoundBackend } from './sounds';
import { renderElement, type PlayMode, type StackShell } from './stack';
import { InPlaceTextEditor } from './text-editor';

/** Shown when the worker was ended because Stop got no answer in time. */
export const UNRESPONSIVE = 'Play was stopped: a Script did not respond';

export const mountPlay = (shell: StackShell): void => {
  const toggle = h(
    'button',
    { type: 'button', 'aria-pressed': 'false' },
    'Present',
  );
  byId('menu').append(toggle);
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
  // `user` prompts cover the Page, unscaled, and answering resumes Play.
  const prompts = mountPlayPrompts(scaler, (prompt, value) =>
    post({ kind: 'answer', session: sessionId, prompt: prompt.id, value }),
  );
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
  let mode: PlayMode | undefined;
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
    args?: string[],
    pageIndex = session?.page.index,
  ) => {
    if (!session || session.stopped || session.navigating) {
      return;
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
    session.apply(response);
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
  const renderedElements = new WeakMap<HTMLElement, Element>();
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
    Object.assign(scaler.style, {
      width: `${play.designWidth * scale}px`,
      height: `${play.page.height * scale}px`,
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
    for (const node of pageNode.querySelectorAll<HTMLElement>(
      '[data-element]',
    )) {
      if (!play.elementsOf().includes(renderedElements.get(node)!)) {
        node.remove();
      }
    }
    let renderIndex = 0;
    for (const element of play.elementsOf()) {
      if (element.kind === 'group') {
        continue;
      }
      if (
        activeText?.history.element === element &&
        (play.stopped ||
          play.navigating ||
          !play.isVisible(element) ||
          !element.editable)
      ) {
        closeText();
      }
      const send = (name: 'click' | 'pointerEnter' | 'pointerLeave') =>
        sendTo(element, name);
      const fresh = renderElement(
        element,
        element.kind === 'image'
          ? shell.images.url(
              playing!.assets.find(a => a.name === element.image),
            )
          : undefined,
      );
      fresh.hidden = !play.isVisible(element);
      fresh.querySelector('[data-replace-image]')?.remove();
      const existing = pageNode.querySelector<HTMLElement>(
        `[data-element="${CSS.escape(element.name)}"]`,
      );
      // Keep the reader's focus, selection and IME intact across other writes.
      if (existing) {
        existing.className = fresh.className;
        if (activeText?.node === existing) {
          existing.classList.add('text-editing');
        }
        existing.style.cssText = fresh.style.cssText;
        existing.hidden = fresh.hidden;
        if (
          element.kind !== 'text' ||
          existing.dataset.renderedRichText !== JSON.stringify(element.richText)
        ) {
          if (activeText?.node === existing) {
            activeText.refresh();
          } else {
            existing.replaceChildren(...fresh.childNodes);
          }
        }
      } else {
        renderedElements.set(fresh, element);
        pageNode.append(fresh);
        fresh.addEventListener('pointerenter', event => {
          if (event.pointerType !== 'touch') {
            send('pointerEnter');
          }
        });
        fresh.addEventListener('pointerleave', event => {
          if (event.pointerType !== 'touch') {
            send('pointerLeave');
          }
        });
        fresh.addEventListener('click', event => {
          const touch = 'pointerType' in event && event.pointerType === 'touch';
          if (touch) {
            send('pointerEnter');
          }
          send('click');
          if (touch) {
            send('pointerLeave');
          }
          // A pointer click leaves the keys with the Page, as games expect.
          if (event.detail > 0 && element.kind === 'button') {
            reader.focus();
          }
        });
        fresh.addEventListener('focus', () => {
          if (element.kind === 'text') {
            openText(fresh, element);
          }
        });
        fresh.addEventListener('blur', event => {
          if (!toolbar.contains(event.relatedTarget as Node | null)) {
            closeText();
          }
        });
      }
      const node = existing ?? fresh;
      // Append existing nodes too: structural changes must update DOM layer order.
      if (pageNode.children[renderIndex] !== node) {
        pageNode.insertBefore(node, pageNode.children[renderIndex] ?? null);
      }
      renderIndex++;
      if (element.kind === 'text') {
        node.contentEditable =
          element.editable &&
          play.isVisible(element) &&
          !play.stopped &&
          !play.navigating
            ? 'true'
            : 'false';
        if (activeText?.node !== node) {
          node.dataset.renderedRichText = JSON.stringify(element.richText);
        }
      }
      if (element.kind === 'button') {
        node.tabIndex = play.isVisible(element) ? 0 : -1;
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', element.label || element.name);
      }
    }
  };
  const requestFrame = () => {
    if (frameRequest !== undefined || !session?.wantsFrames) {
      return;
    }
    frameRequest = requestAnimationFrame(() => {
      frameRequest = undefined;
      if (!session || session.stopped) {
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
    void supervisor.supervise({ kind: 'stop', session: sessionId });
  };
  const drawModes = () => {
    toggle.textContent = mode === 'present' ? 'Stop' : 'Present';
    toggle.setAttribute('aria-pressed', String(mode === 'present'));
    browseTool.setAttribute('aria-pressed', String(mode === 'browse'));
    editTool.setAttribute('aria-pressed', String(mode === undefined));
    document.body.classList.toggle('playing', mode === 'present');
    document.body.classList.toggle('browsing', mode === 'browse');
  };
  /** Ends Play, discarding Play State; browsing leaves Edit on its Page. */
  const leave = () => {
    if (!session) {
      return;
    }
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
  };
  let errorsGeneration = shell.editor.generation;
  const start = (next: PlayMode) => {
    leave();
    errors.clear();
    errorsGeneration = shell.editor.generation;
    const names = scriptNameProblems(shell.editor.project);
    if (names.length) {
      errors.add(names);
      return;
    }
    mode = next;
    shell.setPlaying(mode);
    generation = shell.editor.generation;
    playing = shell.editor.project as Project;
    owners = scriptOwners(shell.editor.project);
    sessionId++;
    profiler.reset(sessionId);
    captureEpoch = profiler.visible ? profiler.results.epoch : undefined;
    session = new PlayMirror((element, richText, pageIndex, edit) =>
      post({
        kind: 'text',
        session: sessionId,
        pageIndex,
        name: element.name,
        richText,
        edit,
      }),
    );
    post({
      kind: 'open',
      ...(captureEpoch === undefined ? {} : { performanceEpoch: captureEpoch }),
      session: sessionId,
      project: playing,
      pageIndex: shell.editor.pageIndex,
      // A different game each time (ADR 0096).
      seed: BigInt(Date.now()),
    });
    // Draw the authored Page at once, as the worker starts its session.
    session.apply(firstView(playing, shell.editor.pageIndex, sessionId));
    histories.clear();
    if (mode === 'browse') {
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
  browseTool.addEventListener('click', () => {
    if (mode !== 'browse') {
      start('browse');
    }
  });
  editTool.addEventListener('click', leave);
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
    // A prompt's keys, Escape included, answer the prompt.
    if (!session || prompts.contains(event.target as Node)) {
      return;
    }
    // While browsing, Esc in a Script window or menu stays with it.
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
      sendTo(element, 'click');
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
  // a Script window or a prompt. The later physical keyup is ignored.
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
    }
    if (!session) {
      return;
    }
    if (generation !== shell.editor.generation) {
      leave();
    } else {
      draw();
    }
  });
  const syncMessage = mountMessageWindow(shell, {
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
          }
        : { error: 'Play has stopped.' };
    },
  });
  window.addEventListener('resize', draw);
  window.addEventListener('pagehide', stopPlay);
};

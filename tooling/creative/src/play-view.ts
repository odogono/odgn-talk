// Browser driving and reader input stay outside the testable Play Session.
import { scriptNameProblems } from './script-names';
import { text } from '@odgn/northtalk';
import { byId, h } from './dom';
import { type Element, type TextElement } from './model';
import { PlaySession } from './play';
import { ReaderTextHistory } from './play-text';
import { browserSoundBackend } from './sounds';
import { renderElement, type StackShell } from './stack';
import { InPlaceTextEditor } from './text-editor';

const now = () =>
  BigInt(Math.floor(performance.timeOrigin + performance.now())) * 1_000_000n;

export const mountPlay = (shell: StackShell): void => {
  const toggle = h(
    'button',
    { type: 'button', 'aria-pressed': 'false' },
    'Play',
  );
  const stop = h('button', { type: 'button', hidden: true }, 'Stop');
  byId('menu').append(toggle, stop);
  const reader = h('main', {
    id: 'reader',
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
  const toolbar = byId('text-toolbar').cloneNode(true) as HTMLElement;
  toolbar.id = 'play-text-toolbar';
  toolbar.hidden = true;
  delete toolbar.dataset.scope;
  toolbar.setAttribute('aria-label', 'Reader text formatting');
  document.body.append(toolbar, reader);
  const problems = h('div', { class: 'banner', hidden: true, role: 'status' });
  byId('banners').append(problems);
  let session: PlaySession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let problemCount = 0;
  let drawnPage: PlaySession['page'] | undefined;
  let activeText: InPlaceTextEditor | undefined;
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
        editor.history.element.visible
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
        schedule();
      },
      () => {
        closeText();
        node.blur();
        schedule();
      },
      { escape: () => stopPlay(), selectAll: false },
    );
  };

  const draw = () => {
    if (!session) {
      return;
    }
    const play = session;
    if (drawnPage !== play.page) {
      closeText();
      pageNode.replaceChildren();
      drawnPage = play.page;
      reader.scrollTop = 0;
    }
    const scale = Math.min(
      1,
      Math.max(0.1, (reader.clientWidth - 32) / play.project.designWidth),
    );
    Object.assign(scaler.style, {
      width: `${play.project.designWidth * scale}px`,
      height: `${play.page.height * scale}px`,
    });
    Object.assign(pageNode.style, {
      width: `${play.project.designWidth}px`,
      height: `${play.page.height}px`,
      background: play.page.background,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
    });
    if (
      activeText &&
      !play.page.elements.includes(activeText.history.element)
    ) {
      closeText();
    }
    for (const node of pageNode.querySelectorAll<HTMLElement>(
      '[data-element]',
    )) {
      if (!play.page.elements.includes(renderedElements.get(node)!)) {
        node.remove();
      }
    }
    for (const element of play.page.elements) {
      if (
        activeText?.history.element === element &&
        (play.stopped ||
          play.navigating ||
          !element.visible ||
          !element.editable)
      ) {
        closeText();
      }
      const send = (name: 'click' | 'pointerEnter' | 'pointerLeave') => {
        play.send(element, name);
        schedule();
      };
      const fresh = renderElement(
        element,
        element.kind === 'image'
          ? shell.images.url(
              play.project.assets.find(a => a.name === element.image),
            )
          : undefined,
      );
      fresh.hidden = !element.visible;
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
        });
        fresh.addEventListener('focus', () => {
          if (element.kind === 'text') {
            openText(fresh, element);
          }
        });
        fresh.addEventListener('blur', event => {
          if (!toolbar.contains(event.relatedTarget as Node | null)) {
            closeText();
            schedule();
          }
        });
      }
      const node = existing ?? fresh;
      if (element.kind === 'text') {
        node.contentEditable =
          element.editable && !play.stopped && !play.navigating
            ? 'true'
            : 'false';
        if (activeText?.node !== node) {
          node.dataset.renderedRichText = JSON.stringify(element.richText);
        }
      }
      if (element.kind === 'button') {
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
      }
    }
    play.changed = false;
  };
  const showProblems = () => {
    if (!session || problemCount === session.problems.length) {
      return;
    }
    problemCount = session.problems.length;
    problems.hidden = false;
    problems.replaceChildren(
      ...session.problems.slice(-10).map(problem => {
        const button = h(
          'button',
          { type: 'button' },
          `${problem.owner.name}, line ${problem.line}: ${problem.message}`,
        );
        button.addEventListener('click', () =>
          shell.openScript(problem.owner, problem.line),
        );
        return button;
      }),
    );
  };
  const schedule = (delay = 0) => {
    if (!session || session.stopped) {
      return;
    }
    if (timer !== undefined) {
      if (delay !== 0) {
        return;
      }
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!session) {
        return;
      }
      if (generation !== shell.editor.generation) {
        leave();
        return;
      }
      const clock = now();
      const result = session.pump(clock);
      if (session.changed || session.navigating) {
        draw();
      }
      showProblems();
      if (result.state === 'sliced') {
        schedule();
      } else if (result.nextDeadline !== undefined) {
        schedule(
          Math.min(
            2_147_483_647,
            Math.max(0, Number((result.nextDeadline - clock) / 1_000_000n)),
          ),
        );
      }
    }, delay);
  };
  const stopPlay = () => {
    if (!session) {
      return;
    }
    closeText();
    clearTimeout(timer);
    timer = undefined;
    session.stop(now());
    stop.disabled = true;
    stop.textContent = 'Stopped';
    draw();
    showProblems();
  };
  const leave = () => {
    stopPlay();
    session = undefined;
    histories.clear();
    reader.hidden = true;
    pageNode.replaceChildren();
    problems.hidden = true;
    stop.hidden = true;
    toggle.textContent = 'Play';
    toggle.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('playing');
    shell.setPlaying(false);
  };
  toggle.addEventListener('click', () => {
    if (session) {
      leave();
      return;
    }
    const names = scriptNameProblems(shell.editor.project);
    if (names.length) {
      problems.hidden = false;
      problems.replaceChildren(...names.map(p => h('p', {}, p.message)));
      return;
    }
    shell.setPlaying(true);
    generation = shell.editor.generation;
    session = new PlaySession(shell.editor.project, shell.editor.pageIndex, {
      soundBackend: browserSoundBackend(asset => shell.images.url(asset)),
    });
    histories.clear();
    problemCount = 0;
    document.body.classList.add('playing');
    reader.hidden = false;
    stop.hidden = false;
    stop.disabled = false;
    stop.textContent = 'Stop';
    toggle.textContent = 'Back to Edit';
    toggle.setAttribute('aria-pressed', 'true');
    draw();
    showProblems();
    schedule();
    reader.focus();
  });
  stop.addEventListener('click', stopPlay);
  toolbar.addEventListener('focusout', event => {
    if (
      !toolbar.contains(event.relatedTarget as Node | null) &&
      event.relatedTarget !== activeText?.node
    ) {
      closeText();
      schedule();
    }
  });
  document.addEventListener('keydown', event => {
    if (!session) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      stopPlay();
      return;
    }
    if (!reader.contains(event.target as Node)) {
      return;
    }
    const node = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-element]',
    );
    const element = session.page.elements.find(
      e => e.name === node?.dataset.element,
    );
    session.send(
      element?.kind === 'text' && element.editable ? element : session.page,
      'keyDown',
      [text(event.key)],
    );
    if (
      element?.kind === 'button' &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      session.send(element, 'click');
    }
    schedule();
  });
  shell.onRedraw(() => {
    if (!session) {
      return;
    }
    if (generation !== shell.editor.generation) {
      leave();
    } else {
      draw();
    }
  });
  window.addEventListener('resize', draw);
  window.addEventListener('pagehide', stopPlay);
};

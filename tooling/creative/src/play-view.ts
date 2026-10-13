// Browser driving and reader input stay outside the testable Play Session.
import { scriptNameProblems } from './script-names';
import { text } from '@odgn/northtalk';
import { byId, h } from './dom';
import { replacePlainText, textOf } from './model';
import { PlaySession } from './play';
import { renderElement, type StackShell } from './stack';

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
  reader.append(pageNode);
  document.body.append(reader);
  const problems = h('div', { class: 'banner', hidden: true, role: 'status' });
  byId('banners').append(problems);
  let session: PlaySession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let problemCount = 0;
  let drawnPage: PlaySession['page'] | undefined;

  const draw = () => {
    if (!session) {
      return;
    }
    const play = session;
    if (drawnPage !== play.page) {
      pageNode.replaceChildren();
      drawnPage = play.page;
      reader.scrollTop = 0;
    }
    const scale = Math.min(
      1,
      (reader.clientWidth - 32) / play.project.designWidth,
    );
    Object.assign(pageNode.style, {
      width: `${play.project.designWidth}px`,
      height: `${play.page.height}px`,
      background: play.page.background,
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
    });
    for (const element of play.page.elements) {
      const send = (
        name: 'click' | 'pointerEnter' | 'pointerLeave' | 'textChanged',
      ) => {
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
        existing.style.cssText = fresh.style.cssText;
        existing.hidden = fresh.hidden;
        if (
          element.kind !== 'text' ||
          existing !== document.activeElement ||
          existing.dataset.renderedText !== textOf(element)
        ) {
          existing.replaceChildren(...fresh.childNodes);
        }
      } else {
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
        fresh.addEventListener('blur', () => {
          if (
            element.kind === 'text' &&
            element.editable &&
            !play.stopped &&
            fresh.innerText !== textOf(element)
          ) {
            replacePlainText(element, fresh.innerText);
            send('textChanged');
          }
        });
      }
      const node = existing ?? fresh;
      if (element.kind === 'text') {
        node.contentEditable =
          element.editable && !play.stopped ? 'plaintext-only' : 'false';
        node.dataset.renderedText = textOf(element);
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
      if (session.changed) {
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
    session = new PlaySession(shell.editor.project, shell.editor.pageIndex);
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

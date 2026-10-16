// The Message Box: one line of NorthTalk, run at once (HyperCard's
// Message Box). While browsing it talks to the running Play Session;
// in Edit it changes the authored Project as one undoable edit.
import { byId, h } from './dom';
import { runInEdit, type MessageReply } from './message';
import { type PlaySession } from './play';
import { bringWindowForward } from './scripts';
import { type StackShell } from './stack';

export type MessageTarget = {
  /** Lets the session run the command it was just given. */
  ran(): void;
  /** The browsing session, if any; commands run there when it is. */
  session(): PlaySession | undefined;
};

const HISTORY = 50;

export const mountMessageWindow = (
  shell: StackShell,
  target: MessageTarget,
): void => {
  const win = byId('message-window');
  const log = byId('message-log');
  const input = byId('message-input') as HTMLInputElement;
  const history: string[] = [];
  let recalled = 0;
  const print = (className: string, text: string) => {
    log.append(h('li', { class: className }, text));
    while (log.children.length > HISTORY * 2) {
      log.firstElementChild!.remove();
    }
    log.scrollTop = log.scrollHeight;
  };

  const run = async (command: string): Promise<MessageReply> => {
    const play = target.session();
    if (!play) {
      const reply = await runInEdit(shell.editor, command);
      shell.redraw();
      return reply;
    }
    const started = play.runMessage(command);
    if (!started.ok) {
      return { error: started.error };
    }
    target.ran();
    return started.result.then(
      value => ({
        text:
          value.kind === 'nothing'
            ? undefined
            : (value.asText() ?? String(value)),
      }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      recalled = Math.max(
        0,
        Math.min(history.length, recalled + (event.key === 'ArrowUp' ? -1 : 1)),
      );
      input.value = history[recalled] ?? '';
      return;
    }
    if (event.key !== 'Enter' || !input.value.trim()) {
      return;
    }
    event.preventDefault();
    const command = input.value.trim();
    input.value = '';
    if (history.at(-1) !== command) {
      history.push(command);
      history.splice(0, history.length - HISTORY);
    }
    recalled = history.length;
    print('command', command);
    void run(command).then(reply => {
      if (reply.error) {
        print('error', reply.error);
      } else if (reply.text !== undefined) {
        print('result', reply.text);
      }
    });
  });

  byId('show-message').addEventListener('click', () => {
    win.hidden = false;
    bringWindowForward(win);
    input.focus();
  });
  byId('close-message').addEventListener('click', () => {
    win.hidden = true;
  });
};

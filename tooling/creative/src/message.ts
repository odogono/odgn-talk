// Message Box commands (#154's Message Box): run against the Play Session
// while browsing, or in Edit against the authored Project as one undoable
// edit, through a session that sends no events.
import { type Value } from '@odgn/northtalk';
import { type StackEditor } from './editing';
import { type Element, type Project } from './model';
import { PlaySession } from './play';

/** What a command printed: its value, nothing, or an error. */
export type MessageReply = { error?: string; text?: string };

const show = (value: Value): string | undefined =>
  value.kind === 'nothing' ? undefined : (value.asText() ?? String(value));

// Waits never finish in Edit, so a command gets this many Pumps.
const EDIT_PUMPS = 200;

/** Settles a command started in `play`, pumping until its Run ends. */
export const settle = async (
  play: PlaySession,
  result: Promise<Value>,
  pump: () => void,
): Promise<MessageReply> => {
  let done = false;
  const reply = result.then(
    value => ({ text: show(value) }),
    (error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  void reply.then(() => {
    done = true;
  });
  for (let i = 0; i < EDIT_PUMPS && !done && !play.stopped; i++) {
    pump();
    await Promise.resolve();
  }
  return done
    ? reply
    : { error: "It didn't finish; waits only run while browsing." };
};

/** Copies `from` onto `to`, keeping `to`'s identity and unchanged values. */
const assignChanged = (to: object, from: object, skip: string[] = []) => {
  const target = to as Record<string, unknown>;
  const source = from as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!(key in source) && !skip.includes(key)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      !skip.includes(key) &&
      JSON.stringify(target[key]) !== JSON.stringify(value)
    ) {
      target[key] = structuredClone(value);
    }
  }
};

/**
 * Writes a session's Project back over the authored one it copied. Authored
 * Pages and Elements keep their identity, so open Script windows stay
 * attached; Elements the command created are added and deleted ones removed.
 */
export const applySession = (authored: Project, play: PlaySession): void => {
  assignChanged(authored, play.project, ['pages', 'assets']);
  play.project.pages.forEach((copy, index) => {
    const page = authored.pages[index]!;
    assignChanged(page, copy, ['elements']);
    page.elements = copy.elements.map(element => {
      const original = play.authored.get(element) as Element | undefined;
      if (!original || !page.elements.includes(original)) {
        return structuredClone(element);
      }
      assignChanged(original, element);
      return original;
    });
  });
};

/** Runs a command in Edit, recording its changes as one undoable edit. */
export const runInEdit = async (
  editor: StackEditor,
  command: string,
): Promise<MessageReply> => {
  if (editor.readOnly) {
    return { error: 'This Project is read-only here.' };
  }
  const play = new PlaySession(editor.project, editor.pageIndex, {
    events: false,
  });
  const started = play.runMessage(command);
  if (!started.ok) {
    play.stop(0n);
    return { error: started.error };
  }
  const generation = editor.generation;
  const reply = await settle(play, started.result, () => play.pump(0n));
  play.stop(0n);
  if (reply.error || editor.generation !== generation || editor.readOnly) {
    return reply;
  }
  editor.edit(() => applySession(editor.project, play));
  if (play.pageIndex !== editor.pageIndex) {
    editor.goToPage(play.pageIndex);
  }
  return reply;
};

// Message Box commands (#154's Message Box): run against the Play Session
// while browsing, or in Edit against the authored Project as one undoable
// edit, through a session that sends no events.
import { type Value } from '@northtalk/ts';
import { type StackEditor } from './editing';
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

/** Runs a command in Edit, recording its changes as one undoable edit. */
export const runInEdit = async (
  editor: StackEditor,
  command: string,
): Promise<MessageReply> => {
  if (editor.readOnly) {
    return { error: 'This Project is read-only here.' };
  }
  editor.finishPendingEdit();
  const expected = editor.stamp();
  const play = new PlaySession(editor.project, editor.pageIndex, {
    events: false,
  });
  const started = play.runMessage(command);
  if (!started.ok) {
    play.stop(0n);
    return { error: started.error };
  }
  const reply = await settle(play, started.result, () => play.pump(0n));
  play.stop(0n);
  if (reply.error) {
    return reply;
  }
  if (!editor.isCurrent(expected)) {
    return {
      error: 'The Project changed while the command ran. Run it again.',
    };
  }
  if (editor.readOnly) {
    return { error: 'This Project is read-only here.' };
  }
  editor.edit(({ tree }) => tree.adopt(play.project));
  if (play.pageIndex !== editor.pageIndex) {
    editor.goToPage(play.pageIndex);
  }
  return reply;
};

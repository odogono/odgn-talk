// Message Box commands (#154's Message Box): run against the Play Session
// while browsing, or in Edit against the authored Project as one undoable
// edit, through a session that sends no events.
import { type Value } from '@northtalk/ts';
import { isReadable, sourceForm } from '@northtalk/ts/debug';
import { apropos, describe, scriptNames } from '@northtalk/ts/session';
import { type StackEditor } from './editing';
import { fuelCommand, inspectCommand } from './message-script';
import { PlaySession } from './play';
import { scriptOwners } from './script-manifest';
import { valueEncoder, type VariableValue } from './variables';

/**
 * What a command printed: its value, nothing, or an error. `:inspect` gives
 * `value`, encoded as the Variables window shows it. A value's `source` is its
 * source form, absent when it holds a Function Value or Host Object.
 */
export type MessageReply = {
  error?: string;
  source?: string;
  text?: string;
  value?: VariableValue;
};

/** A command's value as its reply prints it. */
export const valueReply = (value: Value): MessageReply =>
  value.kind === 'nothing'
    ? {}
    : {
        text: value.asText() ?? String(value),
        ...(isReadable(value) ? { source: sourceForm(value) } : {}),
      };

/**
 * `:describe` and `:apropos`, read from the context Script's source and the
 * Project's Libraries without running anything, so they answer alike in
 * Edit and while browsing. Undefined when `command` is neither.
 */
export const sessionCommand = (
  command: string,
  source: string,
  libraries: readonly { name: string; source: string }[],
): MessageReply | undefined => {
  const match = /^:(describe|apropos)(?:\s+([^]*))?$/u.exec(command.trim());
  if (!match) {
    return undefined;
  }
  // A refusal prints as the Session Host prints it.
  let refused: string | undefined;
  const names = scriptNames(
    source,
    new Map(libraries.map(l => [l.name, l.source])),
    reason => {
      refused = `! ${reason}`;
      throw new Error(refused);
    },
  );
  try {
    const rows = (match[1] === 'describe' ? describe : apropos)(
      names,
      (match[2] ?? '').trim(),
    );
    return { text: rows.join('\n') || undefined };
  } catch (error) {
    if (refused !== undefined) {
      return { error: refused };
    }
    throw error;
  }
};

// Waits never finish in Edit, so a command gets this many Pumps.
const EDIT_PUMPS = 200;

/** Settles a command started in `play`, pumping until its Run ends. */
export const settle = async (
  play: PlaySession,
  result: Promise<Value>,
  pump: () => void,
  encode?: (value: Value) => VariableValue,
): Promise<MessageReply> => {
  let done = false;
  const reply = result.then(
    (value): MessageReply =>
      encode ? { value: encode(value) } : valueReply(value),
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
  target?: number,
): Promise<MessageReply> => {
  const inspect = inspectCommand(command);
  if (inspect && 'error' in inspect) {
    return inspect;
  }
  // Edit runs a command in a session that sends no events, so Fuel there
  // would not be what the line costs in Play.
  if (fuelCommand(command)) {
    return { error: ':fuel works only while browsing.' };
  }
  if (editor.readOnly) {
    return { error: 'This Project is read-only here.' };
  }
  editor.finishPendingEdit();
  const expected = editor.stamp();
  const play = new PlaySession(editor.project, editor.pageIndex, {
    events: false,
  });
  const loadedTarget =
    target === undefined ? undefined : play.messageTargetForOwner(target);
  if (target !== undefined && loadedTarget === undefined) {
    play.stop(0n);
    return {
      error:
        'That Script could not load; fix its problems before running a command.',
    };
  }
  const started = inspect
    ? play.runWatch(inspect.expression, loadedTarget)
    : play.runMessage(command, loadedTarget);
  if (!started.ok) {
    play.stop(0n);
    return { error: started.error };
  }
  // Elements are placed in the authored Project, which `authored` maps to.
  const encode = inspect
    ? valueEncoder(
        play,
        new Map(scriptOwners(editor.project).map((owner, i) => [owner, i])),
      )
    : undefined;
  const reply = await settle(play, started.result, () => play.pump(0n), encode);
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
  // A line that draws appends to the Canvas's Drawing in the same edit.
  play.commitDrawings();
  editor.edit(({ tree }) => tree.adopt(play.project));
  if (play.pageIndex !== editor.pageIndex) {
    editor.goToPage(play.pageIndex);
  }
  return reply;
};

// Chapter 7's `user` Standard Capability, as the Play Session offers it. The
// Core declares its Operations; Folio supplies the prompts and the costs.
import {
  userCapability,
  type Call,
  type CapabilityDef,
  type UserImpl,
} from '@northtalk/ts';
import { grantAll, type GrantDefinition } from './grant';

export type UserPrompt =
  | { kind: 'confirm'; message: string }
  | {
      items: readonly string[];
      kind: 'choose';
      multiple: boolean;
      prompt: string;
    }
  | { fallback: string; kind: 'enter'; message: string };

export type UserState = {
  /** Shows a prompt; the Call is answered or abandoned later. */
  ask(call: Call<unknown>, prompt: UserPrompt): void;
  notify(message: string, title: string): void;
};

const costs = Object.fromEntries(
  ['confirm', 'choose', 'enter', 'notify'].map(name => [name, { fuel: 1 }]),
);
const capability = (state: UserState): CapabilityDef<unknown> =>
  userCapability(
    {
      confirm: (call, message) => state.ask(call, { kind: 'confirm', message }),
      choose: (call, items, prompt, multiple) =>
        state.ask(call, { kind: 'choose', items, prompt, multiple }),
      enter: (call, message, fallback) =>
        state.ask(call, { kind: 'enter', message, fallback }),
      notify: (_call, message, title) => state.notify(message, title),
    } satisfies UserImpl,
    costs,
  );
const unreachable = () => {
  throw new Error('The user Grant declarations never run');
};

export const userGrant: GrantDefinition<UserState> = {
  name: 'user',
  // In the Core's order, which the Manifest keeps.
  operations: Object.fromEntries(
    ['confirm', 'choose', 'enter', 'notify'].map(name => [
      name,
      capability({ ask: unreachable, notify: unreachable }).operations.get(
        name,
      )!,
    ]),
  ),
  grant: state => grantAll(capability(state), undefined),
};

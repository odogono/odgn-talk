// Folio's Host Commands (ADR 0094): `hide x` is an Operation call in the
// caller's Run, so a bad argument fails at the calling line.
import { defineCapability, type Value } from '@northtalk/ts';
import { elementShape, grantAll, type GrantDefinition } from './grant';

export type FolioState = {
  setVisible(element: Value, visible: boolean): void;
};

const command = (verb: 'Hides' | 'Shows', visible: boolean, name: string) =>
  ({
    mode: 'fire-and-forget',
    command: true,
    args: [elementShape],
    cost: { fuel: 1 },
    description: `${verb} an Element: sets its visible to ${visible}. A Host Command, so any Script can call it by name; a Script's own \`on ${name}\` takes its calls instead.`,
    examples: [`${name} welcomeText`],
  }) as const;

/** Operations of the `folio` Grant that any Script calls by name alone. */
const FOLIO_COMMANDS = {
  hide: command('Hides', false, 'hide'),
  show: command('Shows', true, 'show'),
};

export const folioGrant: GrantDefinition<FolioState> = {
  name: 'folio',
  operations: FOLIO_COMMANDS,
  grant: state =>
    grantAll(
      defineCapability('folio', {
        hide: {
          ...FOLIO_COMMANDS.hide,
          examples: [...FOLIO_COMMANDS.hide.examples],
          fire: (_call, element) => state.setVisible(element, false),
        },
        show: {
          ...FOLIO_COMMANDS.show,
          examples: [...FOLIO_COMMANDS.show.examples],
          fire: (_call, element) => state.setVisible(element, true),
        },
      }),
      undefined,
    ),
};

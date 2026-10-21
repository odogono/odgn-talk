import { defineCapability, ScriptError, type HostObject } from '@northtalk/ts';
import { grantAll, pageShape, type GrantDefinition } from './grant';

export type PagesState = {
  /** The Page's index in the Project, or -1 when it is not one of its Pages. */
  pageIndex(page: HostObject): number;
  /** Asks to open a Page once the current Run ends. */
  requestPage(index: number): void;
};

const operations = {
  show: {
    mode: 'fire-and-forget',
    args: [pageShape],
    cost: { fuel: 1 },
  },
} as const;

export const pagesGrant: GrantDefinition<PagesState> = {
  name: 'pages',
  operations,
  grant: state =>
    grantAll(
      defineCapability('pages', {
        show: {
          ...operations.show,
          fire: (_call, page) => {
            const index = state.pageIndex(page as HostObject);
            if (index < 0) {
              throw new ScriptError('out of domain', 'Unknown Page');
            }
            state.requestPage(index);
          },
        },
      }),
      undefined,
    ),
};

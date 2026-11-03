// A small Add-on for tests (#1901): one `counter` kind with a `count`.
import { defineAddOn } from '../../src/add-ons/api';
import type { CatalogueEntry } from '../../src/add-ons/catalogue';
import type { AddOnElement } from '../../src/model';

type Counter = AddOnElement & { count: number };

export const COUNTER_ADD_ON = 'https://northtalk.org/add-ons/test-counter';
export const COUNTER_KIND = `${COUNTER_ADD_ON}#counter` as const;

/** Its catalogue entry, as a built-in Add-on's would be. */
export const COUNTER_ENTRY: CatalogueEntry = {
  id: COUNTER_ADD_ON,
  kinds: [{ name: 'counter', label: 'Counter', icon: '#' }],
  label: 'Test counter',
  slug: 'test-counter',
  version: '1.1.0',
};

export default defineAddOn({
  id: COUNTER_ADD_ON,
  version: '1.1.0',
  kinds: {
    counter: {
      data: ({ commonProperties, property }) => ({
        label: 'Counter',
        icon: '#',
        creatable: true,
        properties: { ...commonProperties, count: property('count', 'number') },
        create: base => ({ ...base, kind: COUNTER_KIND, count: 0 }) as Counter,
        check: (c, e, path, { base }) =>
          ({
            ...base(),
            kind: COUNTER_KIND,
            count: c.num(e.count, `${path}.count`, 'finite') ?? 0,
          }) as Counter,
      }),
      view: ({ h, controls }) => ({
        Contents: ({ element }) =>
          h(
            'span',
            { className: 'counter' },
            String((element as Counter).count),
          ),
        info: (element, { disabled }) =>
          controls.field(
            'Count',
            controls.input(
              'count',
              (element as Counter).count,
              disabled,
              'number',
            ),
          ),
      }),
    },
  },
});

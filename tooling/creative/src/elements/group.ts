// The group Element: member Elements moved, shown and scripted together.
// Its box is derived from its members; an empty one keeps a saved position.
import type { Element, GroupElement } from '../model';
import { checkHierarchy, MAX_GROUP_DEPTH, refreshBounds } from '../tree/rules';
import { setDefined } from './checker';
import { commonProperties, defineElementKind, readOnly } from './definition';

export const groupKind = defineElementKind({
  kind: 'group',
  label: 'Group',
  icon: '▱',
  creatable: false,
  container: true,
  properties: {
    ...commonProperties,
    width: readOnly(commonProperties.width),
    height: readOnly(commonProperties.height),
  },
  create: base => ({
    ...base,
    kind: 'group',
    members: [],
    width: 0,
    height: 0,
  }),
  check: (c, e, path, { depth, member, name }) => {
    if (depth >= MAX_GROUP_DEPTH) {
      c.fail(path, `groups may nest at most ${MAX_GROUP_DEPTH} levels`);
      return undefined;
    }
    const members = (c.arr(e.members, `${path}.members`) ?? []).flatMap(
      (raw, i) => {
        const checked = member(raw, `${path}.members[${i}]`);
        return checked ? [checked] : [];
      },
    );
    const anchor = members.length
      ? undefined
      : c.obj(
          e.emptyPosition ??
            (typeof e.left === 'number'
              ? { left: e.left, top: e.top }
              : undefined),
          `${path}.emptyPosition`,
        );
    if (members.length && e.emptyPosition !== undefined) {
      c.fail(
        `${path}.emptyPosition`,
        'only empty groups have a saved position',
      );
    }
    const group: GroupElement = {
      kind: 'group',
      name,
      members,
      visible: c.bool(e.visible, `${path}.visible`) ?? true,
      left: anchor
        ? (c.num(anchor.left, `${path}.emptyPosition.left`, 'finite') ?? 0)
        : 0,
      top: anchor
        ? (c.num(anchor.top, `${path}.emptyPosition.top`, 'finite') ?? 0)
        : 0,
      width: 0,
      height: 0,
    };
    setDefined(group, 'script', c.optStr(e.script, `${path}.script`));
    try {
      checkHierarchy([group as Element]);
      refreshBounds([group as Element]);
    } catch (error) {
      c.fail(path, error instanceof Error ? error.message : String(error));
    }
    return group;
  },
  save: (element, saveMember) => ({
    kind: 'group',
    name: element.name,
    visible: element.visible,
    ...(element.script === undefined ? {} : { script: element.script }),
    members: element.members.map(saveMember),
    ...(element.members.length
      ? {}
      : { emptyPosition: { left: element.left, top: element.top } }),
  }),
  // Members travel as Elements of their own.
  forPage: element => ({ ...element, members: [] }) as GroupElement,
  className: element => (element.members.length ? '' : ' empty-group'),
});

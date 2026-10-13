export type Attributes = Record<string, string | number | boolean | undefined>;

/** A DOM element with attributes and children; `false` attributes are left out. */
export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  node.append(...children.filter(c => c !== undefined));
  return node;
};

export const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no #${id}`);
  }
  return found;
};

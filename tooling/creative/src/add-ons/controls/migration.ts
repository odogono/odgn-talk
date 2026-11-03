// Format 11 to 12 (#2028): Play performs a Project copied from Music, and a
// Project whose Elements are controls lists the controls Add-on, since
// Tools offers only the kinds of the Add-ons a Project lists (#2025). The
// base is read once here, never afterwards (ADR 0161).
import { CONTROLS_ADD_ON, CONTROLS_VERSION } from './ids';

type Obj = Record<string, unknown>;

const usesControls = (data: Obj): boolean =>
  [data.pages, data.palettes].some(
    pages =>
      Array.isArray(pages) &&
      (pages as (Obj | null)[]).some(
        page =>
          Array.isArray(page?.elements) &&
          (page.elements as (Obj | null)[]).some(
            element =>
              typeof element?.kind === 'string' &&
              element.kind.startsWith(`${CONTROLS_ADD_ON}#`),
          ),
      ),
  );

export const migratePlayAndControls = (data: Obj): Obj => {
  const out = { ...data };
  if ((data.base as Obj | undefined)?.name === 'music') {
    out.play = 'perform';
  }
  const addOns = Array.isArray(data.addOns) ? (data.addOns as Obj[]) : [];
  if (usesControls(data) && !addOns.some(a => a?.id === CONTROLS_ADD_ON)) {
    out.addOns = [
      ...addOns,
      { id: CONTROLS_ADD_ON, version: CONTROLS_VERSION },
    ];
  }
  return out;
};

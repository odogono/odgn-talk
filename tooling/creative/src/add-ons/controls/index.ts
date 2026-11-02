// The built-in controls Add-on (ADR 0162, #1902): slider, knob, toggle, XY
// pad and level meter. Each has a `value` (the XY pad an `x` and a `y`)
// and, when the reader moves it during Play, sends `change` with its new
// value up the Message Path. A meter only shows its value. Dragging draws
// at once and reports through `change`, which Folio merges, so a drag never
// runs a Script per frame.
import type { AddOnDataApi, AddOnKindData, AddOnViewApi } from '../api';
import { defineAddOn } from '../api';
import type { PropertyDescriptor } from '../../elements/definition';
import type { AddOnElement } from '../../model';

export const CONTROLS_ADD_ON = 'https://northtalk.org/add-ons/controls';
export const CONTROLS_VERSION = '1.0.0';

type Fields = Record<string, number | boolean>;
type Ranged = AddOnElement & {
  max: number;
  min: number;
  step: number;
  value: number;
};
type Toggle = AddOnElement & { value: boolean };
type XY = AddOnElement & { x: number; y: number };
type Change = ((fields: Fields) => void) | undefined;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** `v` within the control's range, on its step when it has one. */
const fit = ({ min, max, step }: Ranged, v: number): number => {
  const inRange = clamp(v, Math.min(min, max), Math.max(min, max));
  return step > 0
    ? clamp(
        min + Math.round((inRange - min) / step) * step,
        Math.min(min, max),
        Math.max(min, max),
      )
    : inRange;
};

// --- Data -------------------------------------------------------------------

const rangedData =
  (label: string, icon: string, size: { height: number; width: number }) =>
  ({ commonProperties, property }: AddOnDataApi): AddOnKindData => {
    const value: PropertyDescriptor = {
      ...property('value', 'number'),
      validate: (owner, v) => {
        const { min, max } = owner as unknown as Ranged;
        return Number(v) < Math.min(min, max) || Number(v) > Math.max(min, max)
          ? `value must be from ${min} to ${max}`
          : undefined;
      },
    };
    return {
      label,
      icon,
      creatable: true,
      properties: {
        ...commonProperties,
        value,
        min: property('min', 'number'),
        max: property('max', 'number'),
        step: property('step', 'number'),
      },
      create: base =>
        ({ ...base, ...size, value: 0, min: 0, max: 1, step: 0 }) as Ranged,
      check: (c, e, path, { base }) => {
        const min = c.num(e.min ?? 0, `${path}.min`, 'finite') ?? 0;
        const max = c.num(e.max ?? 1, `${path}.max`, 'finite') ?? 1;
        const step = c.num(e.step ?? 0, `${path}.step`, 'nonNegative') ?? 0;
        const value = c.num(e.value ?? min, `${path}.value`, 'finite') ?? min;
        return {
          ...base(),
          min,
          max,
          step,
          value: fit({ min, max, step } as Ranged, value),
        } as Ranged;
      },
    };
  };

const toggleData = ({
  commonProperties,
  property,
}: AddOnDataApi): AddOnKindData => ({
  label: 'Toggle',
  icon: '◐',
  creatable: true,
  properties: { ...commonProperties, value: property('value', 'boolean') },
  create: base => ({ ...base, width: 56, height: 32, value: false }) as Toggle,
  check: (c, e, path, { base }) =>
    ({
      ...base(),
      value: c.bool(e.value ?? false, `${path}.value`) ?? false,
    }) as Toggle,
});

const xyData = ({
  commonProperties,
  property,
}: AddOnDataApi): AddOnKindData => {
  const unit = (field: 'x' | 'y'): PropertyDescriptor => ({
    ...property(field, 'number'),
    validate: (_owner, v) =>
      Number(v) < 0 || Number(v) > 1
        ? `${field} must be from 0 to 1`
        : undefined,
  });
  return {
    label: 'XY pad',
    icon: '⌖',
    creatable: true,
    properties: { ...commonProperties, x: unit('x'), y: unit('y') },
    create: base =>
      ({ ...base, width: 160, height: 160, x: 0.5, y: 0.5 }) as XY,
    check: (c, e, path, { base }) =>
      ({
        ...base(),
        x: clamp(c.num(e.x ?? 0.5, `${path}.x`, 'finite') ?? 0.5, 0, 1),
        y: clamp(c.num(e.y ?? 0.5, `${path}.y`, 'finite') ?? 0.5, 0, 1),
      }) as XY,
  };
};

// --- Views ------------------------------------------------------------------

const FILL = { position: 'absolute', inset: '0' } as const;

/**
 * The value a drag or key shows before Play State catches up, and a way to
 * set it that also reports it.
 */
const useLive = <T>(
  { hooks }: AddOnViewApi,
  saved: T,
  change: Change,
  toFields: (v: T) => Fields,
) => {
  const [live, setLive] = hooks.useState<T | undefined>(undefined);
  const dragging = hooks.useRef(false);
  // Once Play State moves, it is the truth again, unless still dragging.
  hooks.useEffect(() => {
    if (!dragging.current) {
      setLive(undefined);
    }
  }, [JSON.stringify(saved)]);
  const set = (v: T) => {
    setLive(v);
    change?.(toFields(v));
  };
  return { value: live ?? saved, set, dragging };
};

/** Pointer capture and moves, reporting the box-relative position. */
const dragHandlers = (
  dragging: { current: boolean },
  change: Change,
  onMove: (event: PointerEvent, box: DOMRect, start: boolean) => void,
) =>
  change
    ? {
        onPointerDown: (event: PointerEvent) => {
          const node = event.currentTarget as HTMLElement;
          try {
            node.setPointerCapture(event.pointerId);
          } catch {
            // A synthetic pointer can't be captured; moves still arrive.
          }
          node.focus();
          dragging.current = true;
          onMove(event, node.getBoundingClientRect(), true);
        },
        onPointerMove: (event: PointerEvent) => {
          if (dragging.current) {
            onMove(
              event,
              (event.currentTarget as HTMLElement).getBoundingClientRect(),
              false,
            );
          }
        },
        onPointerUp: () => {
          dragging.current = false;
        },
        onPointerCancel: () => {
          dragging.current = false;
        },
      }
    : {};

/** Arrow keys, Page Up/Down, Home and End over a range. */
const rangeKey = (
  event: KeyboardEvent,
  element: Ranged,
  value: number,
): number | undefined => {
  const span = element.max - element.min;
  const small = element.step > 0 ? element.step : span / 100;
  const big = Math.max(small, span / 10);
  const next = {
    ArrowRight: value + small,
    ArrowUp: value + small,
    ArrowLeft: value - small,
    ArrowDown: value - small,
    PageUp: value + big,
    PageDown: value - big,
    Home: element.min,
    End: element.max,
  }[event.key];
  return next === undefined ? undefined : fit(element, next);
};

const keyHandler =
  (change: Change, handle: (event: KeyboardEvent) => boolean) =>
  (event: KeyboardEvent) => {
    if (change && handle(event)) {
      // Handled here, so Play's own keys don't see it.
      event.preventDefault();
      event.stopPropagation();
    }
  };

const rangeAria = (element: Ranged, value: number, change: Change) => ({
  role: 'slider',
  tabIndex: change ? 0 : -1,
  'aria-label': element.name,
  'aria-valuemin': Math.min(element.min, element.max),
  'aria-valuemax': Math.max(element.min, element.max),
  'aria-valuenow': value,
  'aria-disabled': change ? undefined : 'true',
});

const sliderView = (api: AddOnViewApi) => ({
  Contents: ({
    element,
    change,
  }: {
    change?: Change;
    element: AddOnElement;
  }) => {
    const slider = element as Ranged;
    const { value, set, dragging } = useLive(api, slider.value, change, v => ({
      value: v,
    }));
    const span = slider.max - slider.min || 1;
    const fraction = clamp((value - slider.min) / span, 0, 1);
    return api.h(
      'div',
      {
        ...rangeAria(slider, value, change),
        className: 'control-slider',
        style: {
          ...FILL,
          touchAction: 'none',
          cursor: change ? 'pointer' : '',
        },
        ...dragHandlers(dragging, change, (event, box) =>
          set(
            fit(
              slider,
              slider.min + ((event.clientX - box.left) / box.width) * span,
            ),
          ),
        ),
        onKeyDown: keyHandler(change, event => {
          const next = rangeKey(event, slider, value);
          if (next !== undefined) {
            set(next);
          }
          return next !== undefined;
        }),
      },
      api.h('div', {
        style: {
          position: 'absolute',
          left: '0',
          right: '0',
          top: '50%',
          height: '4px',
          marginTop: '-2px',
          borderRadius: '2px',
          background: 'var(--muted, #888)',
        },
      }),
      api.h('div', {
        className: 'control-fill',
        style: {
          position: 'absolute',
          left: '0',
          width: `${fraction * 100}%`,
          top: '50%',
          height: '4px',
          marginTop: '-2px',
          borderRadius: '2px',
          background: 'var(--accent, #2f6fed)',
        },
      }),
      api.h('div', {
        style: {
          position: 'absolute',
          left: `calc(${fraction * 100}% - 8px)`,
          top: 'calc(50% - 8px)',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: 'var(--accent, #2f6fed)',
        },
      }),
    );
  },
  info: rangeInfo(api),
});

/** Info's min, max and step, shared by the ranged kinds. */
const rangeInfo =
  (api: AddOnViewApi) =>
  (element: AddOnElement, { disabled }: { disabled: boolean }) => {
    const { field, input } = api.controls;
    const ranged = element as Ranged;
    return api.h(
      api.Fragment,
      {},
      field('Value', input('value', ranged.value, disabled, 'number')),
      api.h(
        'div',
        { className: 'row' },
        field('Min', input('min', ranged.min, disabled, 'number')),
        field('Max', input('max', ranged.max, disabled, 'number')),
        field(
          'Step',
          input('step', ranged.step, disabled, 'number', { min: 0 }),
        ),
      ),
    );
  };

const knobView = (api: AddOnViewApi) => ({
  Contents: ({
    element,
    change,
  }: {
    change?: Change;
    element: AddOnElement;
  }) => {
    const knob = element as Ranged;
    const { value, set, dragging } = useLive(api, knob.value, change, v => ({
      value: v,
    }));
    const start = api.hooks.useRef({ y: 0, value: 0 });
    const span = knob.max - knob.min || 1;
    const fraction = clamp((value - knob.min) / span, 0, 1);
    // From 7 o'clock round to 5 o'clock.
    const angle = -135 + fraction * 270;
    return api.h(
      'div',
      {
        ...rangeAria(knob, value, change),
        className: 'control-knob',
        style: {
          ...FILL,
          touchAction: 'none',
          cursor: change ? 'ns-resize' : '',
        },
        ...dragHandlers(dragging, change, (event, _box, first) => {
          if (first) {
            start.current = { y: event.clientY, value };
            return;
          }
          // A drag up turns it up; 150 pixels cover the whole range.
          set(
            fit(
              knob,
              start.current.value +
                ((start.current.y - event.clientY) / 150) * span,
            ),
          );
        }),
        onKeyDown: keyHandler(change, event => {
          const next = rangeKey(event, knob, value);
          if (next !== undefined) {
            set(next);
          }
          return next !== undefined;
        }),
      },
      api.h(
        'div',
        {
          style: {
            position: 'absolute',
            inset: '4px',
            borderRadius: '50%',
            border: '3px solid var(--muted, #888)',
            transform: `rotate(${angle}deg)`,
          },
        },
        api.h('div', {
          className: 'control-pointer',
          style: {
            position: 'absolute',
            left: 'calc(50% - 2px)',
            top: '2px',
            width: '4px',
            height: '35%',
            borderRadius: '2px',
            background: 'var(--accent, #2f6fed)',
          },
        }),
      ),
    );
  },
  info: rangeInfo(api),
});

const toggleView = (api: AddOnViewApi) => ({
  Contents: ({
    element,
    change,
  }: {
    change?: Change;
    element: AddOnElement;
  }) => {
    const toggle = element as Toggle;
    const { value, set } = useLive(api, toggle.value, change, v => ({
      value: v,
    }));
    return api.h(
      'div',
      {
        role: 'switch',
        className: 'control-toggle',
        tabIndex: change ? 0 : -1,
        'aria-label': toggle.name,
        'aria-checked': value ? 'true' : 'false',
        style: {
          ...FILL,
          borderRadius: '999px',
          background: value ? 'var(--accent, #2f6fed)' : 'var(--muted, #888)',
          cursor: change ? 'pointer' : '',
        },
        ...(change ? { onClick: () => set(!value) } : {}),
        onKeyDown: keyHandler(change, event => {
          if (event.key === ' ' || event.key === 'Enter') {
            set(!value);
            return true;
          }
          return false;
        }),
      },
      api.h('div', {
        style: {
          position: 'absolute',
          top: '3px',
          bottom: '3px',
          aspectRatio: '1',
          left: value ? '' : '3px',
          right: value ? '3px' : '',
          borderRadius: '50%',
          background: '#fff',
        },
      }),
    );
  },
  info: (element: AddOnElement, { disabled }: { disabled: boolean }) =>
    api.controls.checkbox('value', 'On', (element as Toggle).value, disabled),
});

const xyView = (api: AddOnViewApi) => ({
  Contents: ({
    element,
    change,
  }: {
    change?: Change;
    element: AddOnElement;
  }) => {
    const pad = element as XY;
    const saved = api.hooks.useRef({ x: pad.x, y: pad.y });
    saved.current = { x: pad.x, y: pad.y };
    const { value, set, dragging } = useLive(
      api,
      { x: pad.x, y: pad.y },
      change,
      v => ({ x: v.x, y: v.y }),
    );
    return api.h(
      'div',
      {
        role: 'slider',
        className: 'control-xy',
        tabIndex: change ? 0 : -1,
        'aria-label': pad.name,
        'aria-valuetext': `x ${value.x.toFixed(2)}, y ${value.y.toFixed(2)}`,
        'aria-valuenow': value.x,
        'aria-valuemin': 0,
        'aria-valuemax': 1,
        style: {
          ...FILL,
          touchAction: 'none',
          border: '2px solid var(--muted, #888)',
          borderRadius: '6px',
          cursor: change ? 'crosshair' : '',
        },
        ...dragHandlers(dragging, change, (event, box) =>
          set({
            x: clamp((event.clientX - box.left) / box.width, 0, 1),
            // Up is more, as on a graph.
            y: clamp(1 - (event.clientY - box.top) / box.height, 0, 1),
          }),
        ),
        onKeyDown: keyHandler(change, event => {
          const d = event.shiftKey ? 0.1 : 0.01;
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [-d, 0],
            ArrowRight: [d, 0],
            ArrowUp: [0, d],
            ArrowDown: [0, -d],
          };
          const move = moves[event.key];
          if (move) {
            set({
              x: clamp(value.x + move[0], 0, 1),
              y: clamp(value.y + move[1], 0, 1),
            });
          }
          return move !== undefined;
        }),
      },
      api.h('div', {
        className: 'control-dot',
        style: {
          position: 'absolute',
          left: `calc(${value.x * 100}% - 7px)`,
          top: `calc(${(1 - value.y) * 100}% - 7px)`,
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: 'var(--accent, #2f6fed)',
        },
      }),
    );
  },
  info: (element: AddOnElement, { disabled }: { disabled: boolean }) => {
    const { field, input } = api.controls;
    const pad = element as XY;
    return api.h(
      'div',
      { className: 'row' },
      field('X', input('x', pad.x, disabled, 'number', { min: 0 })),
      field('Y', input('y', pad.y, disabled, 'number', { min: 0 })),
    );
  },
});

const meterView = (api: AddOnViewApi) => ({
  Contents: ({ element }: { element: AddOnElement }) => {
    const meter = element as Ranged;
    const span = meter.max - meter.min || 1;
    const fraction = clamp((meter.value - meter.min) / span, 0, 1);
    return api.h(
      'div',
      {
        role: 'meter',
        className: 'control-meter',
        'aria-label': meter.name,
        'aria-valuemin': Math.min(meter.min, meter.max),
        'aria-valuemax': Math.max(meter.min, meter.max),
        'aria-valuenow': meter.value,
        style: {
          ...FILL,
          borderRadius: '3px',
          background: 'var(--muted, #888)',
          overflow: 'hidden',
        },
      },
      api.h('div', {
        className: 'control-fill',
        style: {
          position: 'absolute',
          left: '0',
          right: '0',
          bottom: '0',
          height: `${fraction * 100}%`,
          background: 'var(--accent, #2f6fed)',
        },
      }),
    );
  },
  info: rangeInfo(api),
});

export default defineAddOn({
  id: CONTROLS_ADD_ON,
  version: CONTROLS_VERSION,
  kinds: {
    slider: {
      data: rangedData('Slider', '▭', { width: 160, height: 32 }),
      view: sliderView,
    },
    knob: {
      data: rangedData('Knob', '◔', { width: 64, height: 64 }),
      view: knobView,
    },
    toggle: { data: toggleData, view: toggleView },
    xy: { data: xyData, view: xyView },
    meter: {
      data: rangedData('Level meter', '▮', { width: 24, height: 120 }),
      view: meterView,
    },
  },
});

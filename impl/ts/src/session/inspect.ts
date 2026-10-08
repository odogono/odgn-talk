// Passive inspection renders held Values; only the ordinary reader Run calls getters.
import { integerValue } from '../operations';
import { functionHead } from '../code-unit';
import { functionDoc } from '../documentation';
import { shapeData } from '../manifest';
import { stateOf } from '../objects';
import { compareText } from '../text';
import { characterBoundaries } from '../unicode';
import {
  bool,
  listValues,
  map,
  nothing,
  range,
  text,
  type Value,
} from '../values';

export const declarationValue = (data: unknown): Value => {
  if (data === null || data === undefined) {
    return nothing;
  }
  if (typeof data === 'string') {
    return text(data);
  }
  if (typeof data === 'boolean') {
    return bool(data);
  }
  if (typeof data === 'number') {
    return integerValue(BigInt(data));
  }
  if (Array.isArray(data)) {
    return listValues(data.map(declarationValue));
  }
  return map(
    Object.entries(data as object).map(([k, v]) => [k, declarationValue(v)]),
  );
};
export const propertyNames = (value: Value): string[] =>
  [...(stateOf(value)?.handle.kind.props.keys() ?? [])].sort(compareText);

const cost = (c?: { alloc?: number; fuel: number }) =>
  declarationValue({ fuel: c?.fuel ?? 0, alloc: c?.alloc ?? 0 });

export const valueRows = (value: Value): string[] => {
  const out = [
    `value ${map([
      ['kind', text(value.kind)],
      ['value', value],
    ])}`,
  ];
  const size =
    value.kind === 'text'
      ? characterBoundaries(value.asText()!).length - 1
      : value.kind === 'bytes'
        ? value.asBytes()!.length
        : value.kind === 'list'
          ? value.length
          : value.kind === 'map'
            ? value.entries().length
            : null;
  if (size !== null) {
    out.push(`size ${size}`);
  }
  if (value.kind === 'map') {
    for (const [key, field] of value
      .entries()
      .sort(([a], [b]) => compareText(a, b))) {
      out.push(`field ${text(key)} = ${field}`);
    }
  }
  if (value.kind === 'function') {
    const fn = value.asFunction()!;
    const head = functionHead(fn.code);
    out.push(
      `function ${map([
        ['name', head?.name == null ? nothing : text(head.name)],
        [
          'arity',
          head
            ? range(
                integerValue(BigInt(head.min)),
                integerValue(BigInt(head.max)),
              )
            : nothing,
        ],
        ['home', text(fn.home)],
      ])}`,
      `doc ${text(functionDoc(value) ?? '')}`,
    );
  }
  if (value.kind === 'object') {
    const state = stateOf(value)!;
    const object = state.handle;
    out.push(
      `object ${map([
        ['kind', text(object.kind.name)],
        ['id', text(object.id)],
        ['disposed', bool(state.disposed)],
      ])}`,
    );
    for (const name of propertyNames(value)) {
      const p = object.kind.props.get(name)!;
      out.push(
        `property ${map([
          ['name', text(name)],
          ['shape', declarationValue(p.shape ? shapeData(p.shape) : 'any')],
          ['readOnly', bool(!p.set)],
          ['getCost', cost(p.getCost)],
          ['setCost', p.set ? cost(p.setCost) : nothing],
        ])}`,
      );
    }
  }
  return out;
};

// The JSON layout of the Message Layer, walked from the generated catalogue
// (ADR 0183). One encoder writes a message's fields and one decoder reads a
// reply view, so no message maps its fields by hand.
import {
  envelopeJsonMessages,
  envelopeMessages,
  envelopeViews,
  type EnvelopeField,
  type EnvelopeInspect,
  type EnvelopeInspectedMessage,
  type EnvelopeInspectedRun,
  type EnvelopeInspectedScript,
  type EnvelopeInspection,
  type EnvelopeLoad,
} from '../generated/envelope';
import { isJsonNumber, type Json } from '../readers';
import { InstanceLostError } from './reactor';
import {
  boolOf,
  entriesOf,
  intOf,
  listOf,
  textOf,
  textsOf,
  type Frame,
} from './wire';

/** The messages TS sends in the JSON layout through this encoder. */
type JsonMessages = { inspect: EnvelopeInspect; load: EnvelopeLoad };
/** The reply views TS reads through this decoder. */
type JsonViews = {
  'inspected-message': EnvelopeInspectedMessage;
  'inspected-run': EnvelopeInspectedRun;
  'inspected-script': EnvelopeInspectedScript;
  inspection: EnvelopeInspection;
};

/** An opaque field goes out as a frame; text, numbers and booleans stay. */
type Outgoing<V> = V extends Json
  ? V extends string | boolean
    ? V
    : Frame
  : V;
/** A message's fields as the Host gives them; the exchange adds `ref` and `group`. */
export type JsonMessage<M extends keyof JsonMessages> = Omit<
  { readonly [K in keyof JsonMessages[M]]: Outgoing<JsonMessages[M][K]> },
  'ref' | 'group'
>;

const fieldsOf = new Map<string, readonly EnvelopeField[]>([
  ...envelopeMessages
    .filter(m => m.layouts?.includes('json'))
    .map(m => [m.name, m.fields] as const),
  ...envelopeJsonMessages.map(m => [m.name, m.fields] as const),
]);
/** Each view's fields by name, and its required ones. */
const views = new Map(
  envelopeViews.map(v => [
    v.name,
    {
      byName: new Map(v.fields.map(f => [f.name, f])),
      required: v.fields.filter(f => f.required).map(f => f.name),
    },
  ]),
);

/** A message's JSON fields, in catalogue order; absent fields are left out. */
export const encodeJsonMessage = <M extends keyof JsonMessages>(
  m: M,
  record: JsonMessage<M>,
): Record<string, Frame | undefined> => {
  const given = record as Readonly<Record<string, Frame | undefined>>;
  const out: Record<string, Frame | undefined> = {};
  for (const f of fieldsOf.get(m)!) {
    if (f.name !== 'ref' && f.name !== 'group' && given[f.name] !== undefined) {
      out[f.name] = given[f.name];
    }
  }
  return out;
};

const uintOf = (j: Json | undefined): bigint | undefined =>
  isJsonNumber(j)
    ? BigInt(j.source)
    : typeof j === 'string' && /^\d+$/.test(j)
      ? BigInt(j)
      : undefined;

const decodeField = (f: EnvelopeField, j: Json): unknown => {
  switch (f.kind) {
    case 'text':
    case 'instant':
      return textOf(j);
    case 'texts':
      return textsOf(j);
    case 'bool':
      return boolOf(j);
    case 'int':
      return intOf(j);
    case 'uint':
      return uintOf(j);
    case 'pairs':
      return listOf(j).map(p => {
        const [k, v] = listOf(p);
        return [textOf(k) ?? '', v ?? null] as const;
      });
    case 'views':
      return listOf(j).map(x => decodeView(f.view!, x));
    default:
      // Records, Values and messages stay as read; their reader decodes them.
      return j;
  }
};

const decodeView = (name: string, j: Json): Record<string, unknown> => {
  const { byName, required } = views.get(name)!;
  const out: Record<string, unknown> = {};
  // One pass over the reply; a field the catalogue lacks is left out.
  for (const [k, v] of entriesOf(j)) {
    const f = byName.get(k);
    if (f) {
      const decoded = decodeField(f, v);
      if (decoded !== undefined) {
        out[k] = decoded;
      }
    }
  }
  for (const k of required) {
    if (!(k in out)) {
      throw new InstanceLostError(`The ${name} reply lacks ${k}`);
    }
  }
  return out;
};

/** A reply view read from its JSON, typed by the catalogue. */
export const decodeJsonView = <V extends keyof JsonViews>(
  view: V,
  j: Json,
): JsonViews[V] => decodeView(view, j) as JsonViews[V];

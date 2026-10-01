import { toBase64 } from './base64';
import { invalidValue } from './errors';
import { Value, requireValue } from './values';

/** The spec's JSON string form: every U+0000..U+001F uses lowercase \u00xx. */
const quote = (s: string): string =>
  '"' +
  s.replaceAll(/[\u0000-\u001f"\\]/g, ch =>
    ch === '"'
      ? String.raw`\"`
      : ch === '\\'
        ? '\\\\'
        : String.raw`\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  ) +
  '"';

export const encodeValue = (value: Value): string => {
  requireValue(value);
  const pending: (Value | string)[] = [value];
  const output: string[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === 'string') {
      output.push(next);
      continue;
    }
    switch (next.kind) {
      case 'nothing':
        output.push('null');
        break;
      case 'boolean':
        output.push(next.asBool() ? 'true' : 'false');
        break;
      case 'text':
        output.push(quote(next.asText()!));
        break;
      case 'number': {
        const canonical = next.asDecimal()!.toString();
        output.push(
          !canonical.includes('.') &&
            BigInt(canonical) > -(2n ** 53n) &&
            BigInt(canonical) < 2n ** 53n
            ? canonical
            : `{"$dec":${quote(canonical)}}`,
        );
        break;
      }
      case 'bytes':
        output.push(`{"$bytes":${quote(toBase64(next.bytesView()!))}}`);
        break;
      case 'quantity': {
        const q = next.asQuantity()!;
        output.push(
          `{"$quantity":[${quote(q.number.toString())},${quote(q.unit)}]}`,
        );
        break;
      }
      case 'range': {
        const { from, to } = next.asRange()!;
        output.push('{"$range":[');
        pending.push(']}', to, ',', from);
        break;
      }
      case 'list': {
        output.push('[');
        pending.push(']');
        for (let i = next.length; i >= 1; i--) {
          if (i < next.length) {
            pending.push(',');
          }
          pending.push(next.index(i));
        }
        break;
      }
      case 'map': {
        const entries = next.entries();
        const tagged = entries.some(([k]) => k.startsWith('$'));
        output.push(tagged ? '{"$map":[' : '{');
        pending.push(tagged ? ']}' : '}');
        for (let i = entries.length - 1; i >= 0; i--) {
          const [k, v] = entries[i]!;
          if (i < entries.length - 1) {
            pending.push(',');
          }
          if (tagged) {
            pending.push(']', v, `[${quote(k)},`);
          } else {
            pending.push(v, `${quote(k)}:`);
          }
        }
        break;
      }
      default:
        invalidValue(
          `The Value Encoding of a ${next.kind} isn't implemented yet`,
        );
    }
  }
  return output.join('');
};

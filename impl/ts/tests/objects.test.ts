import { describe, expect, test } from 'bun:test';
import {
  decodeValue,
  defineObjectKind,
  encodeValue,
  HostError,
  newGroup,
  parseInstant,
  readDisplay,
  ScriptError,
  text,
} from '../src/index';

const room = defineObjectKind<null>({ name: 'room', props: {} });
const now = parseInstant('2026-09-30T09:00:00Z');

describe('Host Objects', () => {
  test('a handle is made once per kind and id, and is equal only to itself', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    expect(() => group.object(room, 'a', null)).toThrow(HostError);
    expect(a.value.equals(a.value)).toBe(true);
    expect(a.value.equals(b.value)).toBe(false);
    expect(a.value.toString()).toBe('<object room "a">');
    expect(a.value.asObject()).toBe(a);
  });

  test('another Group’s handle is refused', () => {
    const a = newGroup({ name: 'g' }).object(room, 'a', null);
    expect(() => newGroup({ name: 'h' }).setParent(a, undefined)).toThrow(
      HostError,
    );
  });

  test('a parent cycle is refused at the call', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const a = group.object(room, 'a', null);
    const b = group.object(room, 'b', null);
    group.setParent(a, b);
    group.pump(now);
    expect(() => group.setParent(b, a)).toThrow(HostError);
    expect(lines.at(-1)).toBe('refused code="parent cycle"');
  });

  test('an object has at most one Owning Script', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    group.load({ name: 's', source: 'on go\nend go', owner: a });
    expect(() =>
      group.load({ name: 't', source: 'on go\nend go', owner: a }),
    ).toThrow(HostError);
  });

  test('the Value Encoding and display form name an object by kind and id', () => {
    const group = newGroup({ name: 'g' });
    const a = group.object(room, 'a', null);
    const resolve = (kind: string, id: string) =>
      kind === 'room' && id === 'a' ? a : undefined;
    expect(encodeValue(a.value)).toBe('{"$object":["room","a"]}');
    expect(decodeValue('{"$object":["room","a"]}', resolve).asObject()).toBe(a);
    expect(readDisplay('<object room "a">', resolve).asObject()).toBe(a);
    expect(() => readDisplay('<object room "z">', resolve)).toThrow(HostError);
  });

  test('a Request to an object settles with the Run that handles it, or fails unhandled', async () => {
    const group = newGroup({ name: 'g' });
    const top = group.object(room, 'top', null);
    const leaf = group.object(room, 'leaf', null);
    const lone = group.object(room, 'lone', null);
    group.load({
      name: 's',
      source: 'on query x\n  return x & "!"\nend query',
      owner: top,
    });
    group.setParent(leaf, top);
    const ok = group.request(leaf, { name: 'query', args: [text('hi')] });
    const lost = group.request(lone, { name: 'query', args: [text('no')] });
    group.pump(now);
    expect((await ok.result).toString()).toBe('"hi!"');
    const error = await lost.result.catch((error_: unknown) => error_);
    expect((error as ScriptError).code).toBe('send failed');
  });
});

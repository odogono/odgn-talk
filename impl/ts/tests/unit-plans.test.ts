import { expect, test } from 'bun:test';
import { divide, multiply, parseDec } from '../src/decimal';
import {
  combine,
  fromBase,
  ownUnit,
  parseUnit,
  powerOf,
  sameDimension,
  toBase,
  unitText,
} from '../src/units';
import { quantityOf } from '../src/values';
import {
  dec,
  encodeValue,
  newGroup,
  quantity,
  restore,
  text,
} from '../src/index';
import { canConvert, convert, prepareConversion } from '../src/operations';

// Explicit chapter 3 factor sequences, including identity factors. These
// exercise per-step rounding, rather than comparing pre-multiplied ratios.
test.each([
  ['m', ['1'], []],
  ['degF', ['5'], ['9']],
  ['1/degF', ['9'], ['5']],
  ['mL^2/degF', ['0.001', '0.001', '0.001', '0.001', '9'], ['5']],
  ['kg*inch*L/s^2', ['1', '0.0254', '1', '0.001'], ['1', '1']],
  [
    'lb*inch^3*L/degF',
    ['0.45359237', '0.0254', '0.0254', '0.0254', '1', '0.001', '9'],
    ['5'],
  ],
  ['USD/EUR', ['1'], ['1']],
  ['m/m', [], []],
  ['year', ['12'], []],
  ['m^129', Array.from({ length: 129 }, () => '1'), []],
] as const)(
  '%s retains every ordered factor operation',
  (written, top, bottom) => {
    const unit = parseUnit(written);
    for (const input of [
      parseDec('1.000000000000000000000000000000001'),
      parseDec('0.0000000000000000000000000000000001'),
      parseDec('0.00'),
      { coefficient: 0n, exponent: -2, negative: true },
      { coefficient: 1n, exponent: -6176, negative: false },
      { coefficient: 1n, exponent: 1, negative: false },
      // A noncanonical cohort that multiplication by one must round.
      { coefficient: 10n ** 34n, exponent: -34, negative: false },
    ]) {
      let into = input;
      let out = input;
      for (const f of top) {
        into = multiply(into, parseDec(f));
      }
      for (const f of bottom) {
        into = divide(into, parseDec(f));
        out = multiply(out, parseDec(f));
      }
      for (const f of top) {
        out = divide(out, parseDec(f));
      }
      // Repeat to cover reuse of an already prepared plan.
      for (let i = 0; i < 2; i++) {
        expect(toBase(input, unit)).toEqual(into);
        expect(fromBase(input, unit)).toEqual(out);
      }
    }
  },
);

test('identity conversions round an unchecked exponent below the value limit', () => {
  const value = { coefficient: 5n, exponent: -6177, negative: false };
  const unit = parseUnit('m');
  const one = parseDec('1');
  expect(toBase(value, unit)).toEqual(multiply(value, one));
  expect(fromBase(value, unit)).toEqual(divide(value, one));
  expect(toBase(value, unit)).toEqual({
    coefficient: 0n,
    exponent: -6176,
    negative: false,
  });
});

test('a Quantity owns frozen slots without freezing caller-owned data', () => {
  const slots = [{ unit: 'cm', exponent: 1 }];
  const q = quantityOf(dec('2.50').asDecimal()!, Object.freeze(slots));
  expect(q.toString()).toBe('2.50 cm');
  expect(sameDimension(q.asQuantityRef()!.unit, parseUnit('m'))).toBe(true);
  slots[0]!.unit = 's';
  slots[0]!.exponent = 2;
  expect(q.toString()).toBe('2.50 cm');
  expect(encodeValue(q)).toBe('{"$quantity":["2.50","cm"]}');
  expect(q.equals(quantity(dec('0.0250'), 'm'))).toBe(true);
  for (const unit of [q.asQuantityRef()!.unit, parseUnit('m/s')]) {
    expect(Object.isFrozen(unit)).toBe(true);
    expect(unit.every(Object.isFrozen)).toBe(true);
  }
});

test('mutable Unit inputs use current slots, even with a frozen outer array', () => {
  const slot = { unit: 'cm', exponent: 1 };
  const unit = Object.freeze([slot]);
  const m = parseUnit('m');
  expect(sameDimension(unit, m)).toBe(true);
  expect(toBase(parseDec('1'), unit)).toEqual(parseDec('0.01'));
  expect(unitText(combine(unit, m, 'multiply'))).toBe('cm^2');
  slot.unit = 's';
  expect(sameDimension(unit, m)).toBe(false);
  expect(toBase(parseDec('1'), unit)).toEqual(parseDec('1'));
  expect(unitText(combine(unit, m, 'multiply'))).toBe('m*s');
});

test('combination eviction keeps left-hand slots, empty Units and calendar errors', () => {
  const cm = parseUnit('cm');
  const m = parseUnit('m');
  for (let round = 0; round < 2; round++) {
    expect(unitText(combine(cm, m, 'multiply'))).toBe('cm^2');
    expect(combine(cm, m, 'divide')).toEqual([]);
    expect(unitText(combine(ownUnit([]), cm, 'divide'))).toBe('1/cm');
    expect(() => combine(parseUnit('month'), m, 'multiply')).toThrow(
      'a Calendar Unit stands alone',
    );
    expect(() => powerOf(parseUnit('month'), 2)).toThrow(
      'a Calendar Unit stands alone',
    );
    for (let n = 1; n <= 300; n++) {
      expect(unitText(combine(powerOf(cm, n), m, 'multiply'))).toBe(
        `cm^${n + 1}`,
      );
    }
  }
});

test('prepared targets preserve conversion display, errors and dynamic text input', () => {
  for (const target of ['m', 'months', 'mL/degF', 'm/m', 'number']) {
    const plan = prepareConversion(target);
    for (const v of [
      dec('2.50'),
      quantity(dec('1.0'), 'cm'),
      text(' 5 inches '),
      text('no Unit'),
    ]) {
      expect(canConvert(v, target, plan).asBool()).toBe(
        canConvert(v, target).asBool(),
      );
      if (canConvert(v, target).asBool()) {
        expect(encodeValue(convert(v, target, plan))).toBe(
          encodeValue(convert(v, target)),
        );
      }
    }
  }
});

test('Unit plans survive preemption, canonical save/restore and Reload', () => {
  const source = `script variable distance = 1500 mm
on go
  repeat 8 times
    put distance as m into distance
    put distance as mm into distance
  end repeat
  return [distance, 9 degF as degC, distance can be s]
end go`;
  const group = newGroup({ name: 'units' });
  const script = group.load({ name: 's', source });
  script.deliver({ name: 'go' });
  group.pump(0n, { fuelSlice: 20 });
  const saved = group.save();
  const { group: copy } = restore(saved, {
    name: 'units',
    libraries: [],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(copy.fingerprint()).toEqual(group.fingerprint());
  expect(copy.pump(0n)).toEqual(group.pump(0n));
  expect(
    copy.inspect().scripts[0]!.vars.map(([name, v]) => [name, encodeValue(v)]),
  ).toEqual(
    group.inspect().scripts[0]!.vars.map(([name, v]) => [name, encodeValue(v)]),
  );
  for (const g of [group, copy]) {
    g.script('s')!.reload(
      source.replace('as m into', 'as cm into'),
      'carry variables',
    );
    g.script('s')!.deliver({ name: 'go' });
  }
  expect(copy.pump(0n)).toEqual(group.pump(0n));
  expect(copy.fingerprint()).toEqual(group.fingerprint());
  expect(
    copy.inspect().scripts[0]!.vars.map(([name, v]) => [name, encodeValue(v)]),
  ).toEqual(
    group.inspect().scripts[0]!.vars.map(([name, v]) => [name, encodeValue(v)]),
  );
});

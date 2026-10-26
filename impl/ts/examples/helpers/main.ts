import {
  createGroup,
  dec,
  inlineGrants,
  talk,
  type Decimal,
  type Value,
} from '@northtalk/ts';

// The Handlers' JS types, which the Host states and nothing checks.
type Calculator = {
  greet(name: string): Promise<string>;
  total(a: number | Value, b: number | Value): Promise<Decimal>;
};

await using group = createGroup({ name: 'calculator' });

const script = group.load<Calculator>({
  name: 'main',
  source: talk`
    on total a, b
      return a + b
    end total

    on greet name
      shout "Hello, " & name & "!"
      return it
    end greet
  `,
  grants: inlineGrants({
    app: { shout: (line: string) => line.toUpperCase() },
  }),
});

console.log(String(await script.handlers.total(2, 3))); // 5
console.log(String(await script.handlers.total(dec('0.1'), dec('0.2')))); // 0.3
console.log(await script.handlers.greet('Ada')); // HELLO, ADA!

import { defineCapability, ScriptError, shape, text } from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';

type CustomerDirectory = {
  lookup(id: string, signal: AbortSignal): Promise<string | undefined>;
};

// Define the API once. Each Grant supplies its own application binding.
const customers = defineCapability<CustomerDirectory>('customers', {
  lookup: {
    mode: 'suspending',
    args: [shape.text],
    result: shape.text,
    errors: [{ code: 'customer missing' }],
    cost: { fuel: 10 },
    maxPendingMs: 2000,
    run: async (call, id) => {
      const name = await call.binding.lookup(id.asText()!, call.signal);
      if (name === undefined) {
        throw new ScriptError('customer missing', 'No matching customer');
      }
      return text(name);
    },
  },
});

// Stand-in for the application's database or service client.
const names = new Map([['c-1', 'Ada']]);
const directory: CustomerDirectory = {
  lookup: (id, signal) => {
    signal.throwIfAborted();
    return Promise.resolve(names.get(id));
  },
};

const { group, drive } = newDrivenGroup({
  name: 'greetings',
  pump: { fuelSlice: 1000, fuelCap: 5000 },
  onError: error => console.error('Pump failed:', error),
});

try {
  const script = group.load({
    name: 'welcome',
    source: `on greet customerId
  ask customers to lookup customerId and wait
  return "Hello, " & it & "!"
end greet`,
    grants: { customers: customers.grant(['lookup'], directory) },
    limits: { fuelPerRun: 10_000, mailboxDepth: 32, maxWaitMs: 3000 },
  });

  const answer = await script.request({
    name: 'greet',
    args: [text('c-1')],
  }).result;
  console.log(answer.asText()); // Hello, Ada!
} finally {
  // Stop is queued: let the driver apply it before stopping the driver.
  group.script('welcome')?.stop('Application shutdown');
  await drive.idle();
  drive.stop();
}

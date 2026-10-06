import { expect, test } from 'bun:test';
import { measure } from '../src/measurement';

test('sampling leaves a reusable budget unchanged', async () => {
  const options = {
    heap: () => 0,
    max_samples: 1,
    min_cpu_time: 1,
    min_samples: 1,
    warmup_samples: 0,
  };
  const original = { ...options };
  await measure(() => 42, options);
  await measure(() => 42, options);
  expect(options).toEqual(original);
});

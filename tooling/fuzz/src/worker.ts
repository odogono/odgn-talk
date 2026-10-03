import { createInterface } from 'node:readline';
import { coreVersions } from '@odgn/northtalk';
import { features, readCase, type Finding } from './model';
import { checkCase } from './oracles';

// One JSON request/response per line. This entrypoint performs no filesystem or network I/O.
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line);
    if (request.type === 'capabilities') {
      console.log(
        JSON.stringify({
          version: 1,
          features,
          languageVersion: coreVersions.language,
          costModel: coreVersions.costModel,
        }),
      );
    } else if (request.type === 'run') {
      const c = readCase(request.case);
      try {
        console.log(JSON.stringify(checkCase(c)));
      } catch (error) {
        const e = error as Error;
        const malformed =
          /No lifecycle Stub|Missing inline source|case.toml has no|Expected a concrete/.test(
            e.message,
          );
        const finding: Finding = {
          classification: malformed ? 'generator' : 'execution',
          signature: {
            oracle: malformed ? 'harness-validity' : 'worker-exception',
            record: 'exception',
            field: e.name,
            owner: 'group',
          },
          message: e.message,
        };
        console.log(JSON.stringify({ findings: [finding] }));
      }
    } else {
      throw new Error('Unknown worker request');
    }
  } catch (error) {
    console.log(JSON.stringify({ error: (error as Error).message }));
  }
}

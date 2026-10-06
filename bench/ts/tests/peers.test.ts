import { describe, expect, test } from 'bun:test';
import { loadPeer, peers } from '../src/peers';
import { manifest } from '../src/suite';

for (const peer of peers) {
  describe(peer.name, () => {
    for (const b of manifest().filter(b => !b.skip?.peers)) {
      test(`${b.name} produces the Script's expected output`, async () => {
        await loadPeer(peer, b, true);
      });
    }

    test('a wrong expected output fails the check', async () => {
      const b = manifest()[0]!;
      const wrong = {
        ...b,
        smoke: { ...b.smoke, expect: `${b.smoke.expect}0` },
      };
      await expect(loadPeer(peer, wrong, true)).rejects.toThrow(
        `expected ${wrong.smoke.expect}`,
      );
    });

    test('a missing port fails the check', async () => {
      const b = { ...manifest()[0]!, name: 'core/absent' };
      await expect(loadPeer(peer, b, true)).rejects.toThrow();
    });
  });
}

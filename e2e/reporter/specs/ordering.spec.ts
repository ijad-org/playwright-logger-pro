import { test, expect } from '../../lib';

// Six tests that overlap with four workers and end in a different order than they start. Every URL
// carries its test's tag (?t=tagN), so a request line can be matched to its test.
const durations = [900, 150, 500, 60, 300, 700];
durations.forEach((ms, i) => {
  const tag = `tag${i + 1}`;
  test(`${tag} makes requests`, async ({ request }) => {
    await request.get(`/delay/${ms}?t=${tag}`);
    const res = await request.get(`/status/${i === 2 ? 404 : i === 4 ? 500 : 200}?t=${tag}&token=${['SECRET', '123'].join('-')}`);
    if (i === 4) expect(res.status()).toBe(200); // tag5 fails: its 500 gets a block
  });
});

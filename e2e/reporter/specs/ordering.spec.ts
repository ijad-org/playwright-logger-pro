import { test, expect } from '../../lib';

// Six tests that overlap with four workers and end in a different order than they start. Every URL
// carries its test's tag (?t=tagN), so a request line can be matched to its test.
const durations = [900, 150, 500, 60, 300, 700];

// The first wave of tests starts together: none gets going before every worker has one running.
// Worker processes start at their own pace (slow on a busy CI machine), so without the gate the
// fastest test could end before the others had begun, and the overlap these checks are about
// would not exist. The gate is not a logged request (a plain fetch), so it stays out of the output.
const wave = Math.min(Number(process.env.PLP_WORKERS || 1), durations.length);
const port = Number(process.env.PLP_E2E_PORT || 4180);

durations.forEach((ms, i) => {
  const tag = `tag${i + 1}`;
  test(`${tag} makes requests`, async ({ request }) => {
    await (await fetch(`http://127.0.0.1:${port}/gate/${wave}`)).text();
    await request.get(`/delay/${ms}?t=${tag}`);
    const res = await request.get(`/status/${i === 2 ? 404 : i === 4 ? 500 : 200}?t=${tag}&token=${['SECRET', '123'].join('-')}`);
    if (i === 4) expect(res.status()).toBe(200); // tag5 fails: its 500 gets a block
  });
});

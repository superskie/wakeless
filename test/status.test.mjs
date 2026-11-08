// Status polling: failed polls are asked again until the deadline, polls keep
// a gap between them, and a timeout names the last failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForStatus } from '../src/agent/status.mjs';

/** A clock that only moves when the poller sleeps or a poll takes time. */
function fakeTime() {
  let t = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    pass: (ms) => {
      t += ms;
    },
  };
}

const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

test('a failed poll is asked again with backoff instead of ending the wait', async () => {
  const time = fakeTime();
  const answers = [
    failure(null, 'the Agent API is not reachable: fetch failed'),
    failure(502, 'the Agent API did not answer', { code: 'upstream_unreachable' }),
    failure(429, 'too many requests', { retryAfterSeconds: 7 }),
    { status: 'PROCESSING' },
    { correlation_id: 'op-1', status: 'SUCCESS' },
  ];
  const api = { getStatus: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
  const final = await waitForStatus(api, 'op-1', 180_000, { sleep: time.sleep, now: time.now });

  assert.equal(final.status, 'SUCCESS');
  assert.equal(answers.length, 0);
  // Backoffs of 1 s and 2 s, both held to the 2 s minimum gap, then the server's Retry-After of 7 s,
  // then the 2 s gap after a PROCESSING that came back at once.
  assert.deepEqual(time.sleeps, [2_000, 2_000, 7_000, 2_000]);
});

test('a long-poll that answers at once still leaves a gap between polls', async () => {
  const time = fakeTime();
  let polls = 0;
  const api = { getStatus: async () => (++polls < 4 ? { status: 'QUEUED' } : { status: 'SUCCESS' }) };
  await waitForStatus(api, 'op-1', 180_000, { sleep: time.sleep, now: time.now, minGapMs: 2_000 });
  assert.deepEqual(time.sleeps, [2_000, 2_000, 2_000]);

  // A poll that held the line for 30 s needs no extra wait.
  const slow = fakeTime();
  polls = 0;
  const longPoll = { getStatus: async () => { slow.pass(30_000); return ++polls < 3 ? { status: 'PROCESSING' } : { status: 'SUCCESS' }; } };
  await waitForStatus(longPoll, 'op-1', 180_000, { sleep: slow.sleep, now: slow.now });
  assert.deepEqual(slow.sleeps, []);
});

test('the deadline ends the wait with the real error, and a refusal ends it at once', async () => {
  const time = fakeTime();
  const down = { getStatus: async () => { throw failure(503, 'service unavailable', { code: 'provider_unavailable' }); } };
  await assert.rejects(waitForStatus(down, 'op-1', 60_000, { sleep: time.sleep, now: time.now }), (err) => {
    assert.equal(err.name, 'TimeoutError');
    assert.match(err.message, /no settled status after 60s \(the last poll failed: HTTP 503 provider_unavailable: service unavailable\)/);
    return true;
  });
  assert.ok(time.now() <= 60_000, 'it never sleeps past the deadline');

  let polls = 0;
  const missing = { getStatus: async () => { polls += 1; throw failure(404, 'no such operation', { code: 'not_found' }); } };
  await assert.rejects(waitForStatus(missing, 'op-x', 60_000, { sleep: fakeTime().sleep, now: fakeTime().now }), /no such operation/);
  assert.equal(polls, 1);
});

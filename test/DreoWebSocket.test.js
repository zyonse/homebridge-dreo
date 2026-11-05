// Regression tests for the Dreo websocket client, driven against a simulated Dreo cloud.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const DreoWebSocket = require('../dist/DreoWebSocket').default;
const { MockDreoServer, BlackholeServer } = require('./helpers/mock-dreo-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Fast timings so the suite runs in seconds rather than minutes
const fast = {
  keepaliveInterval: 100,
  pongTimeout: 150,
  connectTimeout: 200,
  minReconnectDelay: 50,
  maxReconnectDelay: 200,
};

// Waits for a condition instead of sleeping a fixed time, so tests aren't flaky under load
async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

test('connects and delivers messages to registered listeners', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  const messages = [];
  client.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));
  client.start();

  assert.ok(await waitFor(() => server.connections === 1), 'client should connect');
  server.broadcast({ devicesn: 'SN1', method: 'report', state: { poweron: true } });

  assert.ok(await waitFor(() => messages.length === 1), 'listener should receive the report');
  assert.strictEqual(messages[0].method, 'report');
});

test('control commands round-trip and the reply reaches the listener', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  const replies = [];
  client.addEventListener('message', (e) => replies.push(JSON.parse(e.data)));
  client.start();
  await waitFor(() => server.connections === 1);

  client.send(JSON.stringify({ deviceSn: 'SN1', method: 'control', params: { poweron: true } }));

  assert.ok(await waitFor(() => replies.length === 1), 'should receive control-reply');
  assert.strictEqual(replies[0].method, 'control-reply');
  assert.deepStrictEqual(replies[0].reported, { poweron: true });
  assert.deepStrictEqual(server.controls[0].params, { poweron: true });
});

// accessories register once at startup and must keep receiving updates forever after.
test('a listener registered once survives a server-side drop and reconnect', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  const messages = [];
  client.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));
  client.start();
  await waitFor(() => server.connections === 1);

  server.dropAll();
  assert.ok(await waitFor(() => server.connections === 2), 'client should reconnect after a drop');

  server.broadcast({ devicesn: 'SN1', method: 'report', state: { poweron: false } });
  assert.ok(await waitFor(() => messages.length === 1), 'listener must still fire after reconnect');
});

// aborting a handshake makes ws emit 'error' on process.nextTick. With no listener attached
// that is an unhandled 'error' event, which takes down the whole Homebridge process.
test('an aborted handshake is reported, not fatal', async (t) => {
  const blackhole = await new BlackholeServer().start();
  const client = new DreoWebSocket(async () => blackhole.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await blackhole.stop();
  });

  const errors = [];
  client.addEventListener('error', (e) => errors.push(e.message));
  client.start();

  // If the deferred emit were unhandled, the test process would die here instead of asserting
  assert.ok(
    await waitFor(() => errors.some((m) => /closed before the connection was established/.test(m))),
    'the abort should surface as a handled error event',
  );
  assert.ok(await waitFor(() => errors.length >= 2), 'client should keep retrying after an abort');
});

test('the URL is rebuilt for every connection attempt', async (t) => {
  const blackhole = await new BlackholeServer().start();
  const attempts = [];
  const client = new DreoWebSocket(async (attempt) => {
    attempts.push(attempt);
    return `${blackhole.url}/?token=t${attempt}&timestamp=${Date.now()}`;
  }, silentLog, fast);
  t.after(async () => {
    client.stop();
    await blackhole.stop();
  });

  client.start();
  assert.ok(await waitFor(() => attempts.length >= 3), 'should keep re-deriving the URL');
  assert.deepStrictEqual(attempts.slice(0, 3), [0, 1, 2], 'attempt counter should advance');
});

test('sends the keepalive while connected', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  client.start();
  assert.ok(await waitFor(() => server.keepalives >= 2), 'keepalives should be sent on an interval');
});

// A half-open connection accepts writes forever. Without a pong check the plugin looks
// connected while silently receiving nothing.
test('recovers from a half-open connection that stops answering pings', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  client.start();
  // Let at least one ping/pong through first, so the client learns the server answers pings
  await waitFor(() => server.keepalives >= 1);
  server.freeze();

  assert.ok(await waitFor(() => server.connections >= 2, 6000), 'should terminate and reconnect');
});

test('send() while disconnected is dropped, not thrown', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => {
    client.stop();
    await server.stop();
  });

  // Never started, so there is no socket at all
  assert.doesNotThrow(() => client.send('{"method":"control"}'));
});

test('stop() ends reconnection', async (t) => {
  const server = await new MockDreoServer().start();
  const client = new DreoWebSocket(async () => server.url, silentLog, fast);
  t.after(async () => await server.stop());

  client.start();
  await waitFor(() => server.connections === 1);

  client.stop();
  server.dropAll();
  await sleep(500);

  assert.strictEqual(server.connections, 1, 'no reconnect should happen after stop()');
});

// --- Outage reporting ('lost' and the 'open' reconnect flags) ---

const GRACE = 600;

// Builds a client whose URL follows `ctx.server`, so a test can replace the server mid-run
function trackOutages(t, ctx) {
  const client = new DreoWebSocket(async () => ctx.server.url, silentLog, { ...fast, lostGracePeriod: GRACE });
  const events = { lost: 0, opens: [] };
  client.addEventListener('lost', () => events.lost++);
  client.addEventListener('open', (e) => events.opens.push(e));
  t.after(async () => {
    client.stop();
    await ctx.server.stop();
  });
  return { client, events };
}

test('the first connection is not flagged as a reconnect', async (t) => {
  const ctx = { server: await new MockDreoServer().start() };
  const { client, events } = trackOutages(t, ctx);
  client.start();

  assert.ok(await waitFor(() => events.opens.length === 1));
  assert.deepStrictEqual(events.opens[0], { reconnect: false, afterLost: false });
});

test('a brief drop is flagged as a reconnect but never reported as lost', async (t) => {
  const ctx = { server: await new MockDreoServer().start() };
  const { client, events } = trackOutages(t, ctx);
  client.start();
  await waitFor(() => events.opens.length === 1);

  ctx.server.dropAll();

  assert.ok(await waitFor(() => events.opens.length === 2), 'should reconnect');
  assert.deepStrictEqual(events.opens[1], { reconnect: true, afterLost: false });
  await sleep(GRACE + 100);
  assert.strictEqual(events.lost, 0, 'a reconnect inside the grace period must not report the connection lost');
});

test('an outage longer than the grace period is reported lost once, and flagged on reconnect', async (t) => {
  const ctx = { server: await new MockDreoServer().start() };
  const { client, events } = trackOutages(t, ctx);
  client.start();
  await waitFor(() => events.opens.length === 1);

  // Take the cloud away entirely; reconnect attempts keep failing
  await ctx.server.stop();
  assert.ok(await waitFor(() => events.lost === 1), 'should report the outage after the grace period');
  await sleep(GRACE + 200);
  assert.strictEqual(events.lost, 1, 'repeated failed reconnects must not report the outage again');

  ctx.server = await new MockDreoServer().start();
  assert.ok(await waitFor(() => events.opens.length === 2), 'should reconnect once the cloud is back');
  assert.deepStrictEqual(events.opens[1], { reconnect: true, afterLost: true });
});

test('an outage before the first connection is flagged once connected', async (t) => {
  // Start with nothing listening, so the very first connection attempts fail
  const ctx = { server: await new MockDreoServer().start() };
  await ctx.server.stop();
  const { client, events } = trackOutages(t, ctx);
  client.start();

  assert.ok(await waitFor(() => events.lost === 1));
  ctx.server = await new MockDreoServer().start();
  assert.ok(await waitFor(() => events.opens.length === 1), 'should connect once the cloud is up');
  assert.deepStrictEqual(events.opens[0], { reconnect: true, afterLost: true });
});

test('stop() during an outage does not report it lost', async (t) => {
  const ctx = { server: await new MockDreoServer().start() };
  const { client, events } = trackOutages(t, ctx);
  client.start();
  await waitFor(() => events.opens.length === 1);

  ctx.server.dropAll();
  client.stop();
  await sleep(GRACE + 100);
  assert.strictEqual(events.lost, 0);
});

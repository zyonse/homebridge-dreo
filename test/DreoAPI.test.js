// Tests for outgoing command pacing in DreoAPI, driven against a simulated Dreo cloud.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const DreoAPI = require('../dist/DreoAPI').default;
const DreoWebSocket = require('../dist/DreoWebSocket').default;
const { MockDreoServer } = require('./helpers/mock-dreo-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Must match MIN_COMMAND_GAP_MS in src/DreoAPI.ts, less a little timer slack
const MIN_GAP = 740;

async function waitFor(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

// DreoAPI opens its socket against the real Dreo hostname, so swap in one pointed at the
// mock server. reconcileDevice records the follow-up state pulls DreoAPI schedules.
async function setup(t, wsOptions = { minReconnectDelay: 50, maxReconnectDelay: 200 }) {
  const server = await new MockDreoServer().start();
  const reconciled = [];
  const platform = {
    log: silentLog,
    config: { options: {} },
    reconcileDevice: (sn) => reconciled.push(sn),
  };
  const api = new DreoAPI(platform);
  api.ws = new DreoWebSocket(async () => server.url, silentLog, wsOptions);
  api.ws.start();
  t.after(async () => {
    api.ws.stop();
    api.reconcileTimers?.forEach((timer) => clearTimeout(timer));
    await server.stop();
  });
  assert.ok(await waitFor(() => server.connections === 1), 'client should connect');
  return { server, api, reconciled };
}

test('a scene burst is merged per subsystem and paced', async (t) => {
  const { server, api } = await setup(t);

  // What HomeKit sends when a scene turns a fan and its light on together
  api.control('SN1', { fanon: true });
  api.control('SN1', { lighton: true });
  api.control('SN1', { fanon: true, windlevel: 5 });
  api.control('SN1', { brightness: 80 });

  assert.ok(await waitFor(() => server.controls.length === 2), 'should send two messages');
  await sleep(300);
  assert.strictEqual(server.controls.length, 2, 'nothing else should follow');
  assert.deepStrictEqual(server.controls[0].params, { fanon: true, windlevel: 5 });
  assert.deepStrictEqual(server.controls[1].params, { lighton: true, brightness: 80 });
  assert.ok(server.controls[1].receivedAt - server.controls[0].receivedAt >= MIN_GAP, 'messages should be spaced out');
});

test('a command queued just after a batch drains still waits the full gap', async (t) => {
  const { server, api } = await setup(t);

  api.control('SN1', { fanon: true });
  assert.ok(await waitFor(() => server.controls.length === 1));
  await sleep(150);
  api.control('SN1', { windlevel: 3 });

  assert.ok(await waitFor(() => server.controls.length === 2));
  assert.ok(server.controls[1].receivedAt - server.controls[0].receivedAt >= MIN_GAP, 'second command should be paced');
});

test('devices are paced independently', async (t) => {
  const { server, api } = await setup(t);

  api.control('SN1', { fanon: true });
  api.control('SN2', { fanon: true });

  assert.ok(await waitFor(() => server.controls.length === 2));
  assert.ok(Math.abs(server.controls[1].receivedAt - server.controls[0].receivedAt) < 300, 'other devices should not wait');
});

test('commands sent while disconnected are delivered after reconnect', async (t) => {
  // Reconnect slower than the queue's coalescing window, so the command is ready to go
  // while the socket is still down
  const { server, api } = await setup(t, { minReconnectDelay: 600, maxReconnectDelay: 600 });

  server.dropAll();
  assert.ok(await waitFor(() => !api.ws.isOpen), 'client should notice the drop');
  api.control('SN1', { fanon: false });

  assert.ok(await waitFor(() => server.connections === 2), 'client should reconnect');
  assert.ok(await waitFor(() => server.controls.length === 1), 'command should not be dropped');
  assert.deepStrictEqual(server.controls[0].params, { fanon: false });
});

test('device state is reconciled once after commands settle', async (t) => {
  const { server, api, reconciled } = await setup(t);

  api.control('SN1', { fanon: true });
  api.control('SN1', { lighton: true });
  assert.ok(await waitFor(() => server.controls.length === 2));
  assert.deepStrictEqual(reconciled, [], 'should wait for things to settle');

  assert.ok(await waitFor(() => reconciled.length > 0, 7000), 'should reconcile');
  await sleep(200);
  assert.deepStrictEqual(reconciled, ['SN1']);
});

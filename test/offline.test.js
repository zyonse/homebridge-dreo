// Tests that accessories show "No Response" in HomeKit while their device is offline.
// Message shapes match what the Dreo cloud actually sends.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const hap = require('hap-nodejs');
const { FanAccessory } = require('../dist/accessories/FanAccessory');

const NO_RESPONSE = hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
const SN = 'SN1';
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeFan({ connected } = {}) {
  const listeners = [];
  const controls = [];
  const platform = {
    log: silentLog,
    config: {},
    api: { hap },
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    webHelper: {
      addEventListener: (event, listener) => event === 'message' && listeners.push(listener),
      control: (sn, command) => controls.push(command),
    },
  };
  const accessory = new hap.Accessory('Tower Fan', hap.uuid.generate(SN));
  accessory.context = { device: { sn: SN, brand: 'Dreo', model: 'DR-HTF001S', deviceName: 'Tower Fan' } };
  const state = { windlevel: { state: 1 }, poweron: { state: false }, shakehorizon: { state: false } };
  if (connected !== undefined) {
    state.connected = { state: connected };
  }
  new FanAccessory(platform, accessory, state);

  const service = accessory.getService(hap.Service.Fanv2);
  return {
    controls,
    active: service.getCharacteristic(hap.Characteristic.Active),
    speed: service.getCharacteristic(hap.Characteristic.RotationSpeed),
    receive: (message) => listeners.forEach((l) => l({ data: JSON.stringify({ devicesn: SN, ...message }) })),
  };
}

test('a device that is online at startup responds normally', async () => {
  const fan = makeFan({ connected: true });
  assert.strictEqual(await fan.active.handleGetRequest(), 0);
});

test('a device with no connection status at startup is assumed online', async () => {
  const fan = makeFan();
  assert.strictEqual(await fan.active.handleGetRequest(), 0);
});

test('a device that is offline at startup shows No Response', async () => {
  const fan = makeFan({ connected: false });
  await assert.rejects(fan.active.handleGetRequest(), (status) => status === NO_RESPONSE);
});

test('device-offline marks the device No Response immediately', async () => {
  const fan = makeFan({ connected: true });
  fan.receive({ method: 'device-offline', reported: {} });

  // Pushed straight away, not just on the next read
  assert.strictEqual(fan.active.statusCode, NO_RESPONSE);
  await assert.rejects(fan.active.handleGetRequest(), (status) => status === NO_RESPONSE);
});

test('device-online restores the device and applies its current state', async () => {
  const fan = makeFan({ connected: false });
  fan.receive({
    method: 'device-online',
    reported: { windlevel: 4, poweron: true, shakehorizon: false, connected: true, temperature: 73, wifi_rssi: -39 },
  });

  assert.strictEqual(fan.active.statusCode, 0);
  assert.strictEqual(await fan.active.handleGetRequest(), 1);
  assert.strictEqual(await fan.speed.handleGetRequest(), 100);
});

test('a report carrying connected: false marks the device offline', async () => {
  const fan = makeFan({ connected: true });
  fan.receive({ method: 'report', reported: { connected: false } });
  await assert.rejects(fan.active.handleGetRequest(), (status) => status === NO_RESPONSE);
});

test('writes to an offline device fail and send nothing', async () => {
  const fan = makeFan({ connected: false });
  await assert.rejects(fan.active.handleSetRequest(1), (status) => status === NO_RESPONSE);
  assert.deepStrictEqual(fan.controls, []);
});

test('messages for other devices are ignored', async () => {
  const fan = makeFan({ connected: true });
  fan.receive({ devicesn: 'OTHER', method: 'device-offline', reported: {} });
  assert.strictEqual(await fan.active.handleGetRequest(), 0);
});

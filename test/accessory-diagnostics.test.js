/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('node:util');
const hap = require('hap-nodejs');
const { HeaterAccessory } = require('../dist/accessories/HeaterAccessory');
const { FanAccessory } = require('../dist/accessories/FanAccessory');
const { HumidifierAccessory } = require('../dist/accessories/HumidifierAccessory');

const fixtures = [
  {
    Accessory: HeaterAccessory, service: hap.Service.HeaterCooler, name: 'Heater', model: 'DR-HSH004S',
    values: { temperature: 68, ecolevel: 70, poweron: false, mode: 'eco', htalevel: 1, childlockon: false, ptcon: false },
  },
  {
    Accessory: FanAccessory, service: hap.Service.Fanv2, name: 'Fan', model: 'DR-HTF001S',
    values: { poweron: false, windlevel: 1, shakehorizon: false },
  },
  {
    Accessory: HumidifierAccessory, service: hap.Service.HumidifierDehumidifier, name: 'Humidifier', model: 'DR-HHM713S',
    values: { poweron: false, mode: 0, rh: 45, foglevel: 2, rhautolevel: 50, rhsleeplevel: 50 },
  },
];

function makeAccessory({ Accessory, service, name, model, values }, config = {}) {
  const sn = 'private-device-serial';
  const logs = [];
  const controls = [];
  const listeners = [];
  const noop = () => undefined;
  const platform = {
    config,
    api: { hap },
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    log: { debug: noop, info: (...args) => logs.push(format(...args)), warn: noop, error: noop },
    webHelper: {
      addEventListener: (event, listener) => listeners.push(listener),
      control: (serial, params) => controls.push(params),
    },
  };
  const accessory = new hap.Accessory(name, hap.uuid.generate(sn));
  accessory.context = { device: { sn, brand: 'Dreo', model, deviceName: name, controlsConf: {} } };
  if (service === hap.Service.HeaterCooler) {
    accessory.addService(service)
      .updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, 20)
      .updateCharacteristic(hap.Characteristic.CoolingThresholdTemperature, 13);
  }
  new Accessory(platform, accessory, Object.fromEntries(Object.entries(values).map(([key, state]) => [key, { state }])));
  return {
    controls,
    logs,
    set: (characteristic, value) => accessory.getService(service).getCharacteristic(characteristic).handleSetRequest(value),
    report: (method, reported) => listeners.forEach(listener => listener({
      data: JSON.stringify({ devicesn: sn, method, reported }),
    })),
  };
}

test('accessory diagnostic logging is off by default', async () => {
  for (const fixture of fixtures) {
    const device = makeAccessory(fixture);
    await device.set(hap.Characteristic.Active, 1);
    device.report('control-report', { poweron: true });
    assert.deepEqual(device.logs, []);
    assert.deepEqual(device.controls, [{ poweron: true }]);
  }
});

test('diagnostics distinguish HomeKit writes, Dreo commands, replies, and device reports across accessory types', async () => {
  for (const fixture of fixtures) {
    const device = makeAccessory(fixture, { accessoryDiagnosticLogging: true });
    const prefix = 'Accessory diagnostics [' + fixture.name + '] ';
    await device.set(hap.Characteristic.Active, 1);
    device.report('control-reply', { poweron: true });
    device.report('control-report', { poweron: true, unknown: 'private-payload-value' });
    assert.deepEqual(device.logs, [
      prefix + 'HomeKit setActive: 1',
      prefix + 'Dreo command: {"poweron":true}',
      prefix + 'Dreo control-reply: {"poweron":true}',
      prefix + 'Dreo control-report: {"poweron":true}',
    ]);
    assert.deepEqual(device.controls, [{ poweron: true }]);
  }
});

test('diagnostics log a HomeKit setpoint even when the accessory sends no command', async () => {
  const device = makeAccessory(fixtures[0], { accessoryDiagnosticLogging: true });
  await device.set(hap.Characteristic.CoolingThresholdTemperature, 13);
  assert.deepEqual(device.logs, ['Accessory diagnostics [Heater] HomeKit setCoolingThresholdTemperature: 13']);
  assert.deepEqual(device.controls, []);
});

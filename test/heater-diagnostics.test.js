/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('node:util');
const hap = require('hap-nodejs');
const { HeaterAccessory } = require('../dist/accessories/HeaterAccessory');

function makeHeater(config) {
  const sn = 'private-device-serial';
  const logs = [];
  const controls = [];
  const listeners = [];
  const platform = {
    config,
    api: { hap },
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    log: { debug: () => undefined, info: (...args) => logs.push(format(...args)) },
    webHelper: {
      addEventListener: (event, listener) => listeners.push(listener),
      control: (serial, params) => controls.push({ serial, params }),
    },
  };
  const accessory = new hap.Accessory('Office Heater', hap.uuid.generate(sn));
  accessory.context = {
    device: { sn, brand: 'Dreo', model: 'DR-HSH004S', deviceName: 'Office Heater', controlsConf: {} },
  };
  const service = accessory.addService(hap.Service.HeaterCooler);
  service.updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, 20);
  service.updateCharacteristic(hap.Characteristic.CoolingThresholdTemperature, 13);
  new HeaterAccessory(platform, accessory, {
    temperature: { state: 68 },
    ecolevel: { state: 70 },
    poweron: { state: false },
    mode: { state: 'eco' },
    htalevel: { state: 1 },
    childlockon: { state: false },
    ptcon: { state: false },
  });
  return {
    controls,
    logs,
    set: (characteristic, value) => service.getCharacteristic(characteristic).handleSetRequest(value),
    report: (method, reported) => listeners.forEach(listener => listener({
      data: JSON.stringify({ devicesn: sn, method, reported }),
    })),
  };
}

test('heater diagnostic logging is off by default', async () => {
  const heater = makeHeater({});
  await heater.set(hap.Characteristic.Active, 1);
  heater.report('control-report', { poweron: true });
  assert.deepEqual(heater.logs, []);
  assert.deepEqual(heater.controls.map(({ params }) => params), [{ poweron: true }]);
});

test('heater diagnostics distinguish HomeKit writes, Dreo replies, and device reports', async () => {
  const heater = makeHeater({ heaterDiagnosticLogging: true });
  await heater.set(hap.Characteristic.Active, 1);
  await heater.set(hap.Characteristic.HeatingThresholdTemperature, 20);
  await heater.set(hap.Characteristic.CoolingThresholdTemperature, 13);
  heater.report('control-reply', { poweron: true });
  heater.report('control-report', { ecolevel: 68, otherField: 'private-payload-value' });
  assert.deepEqual(heater.logs, [
    'Heater diagnostics [Office Heater] HomeKit request power = true',
    'Heater diagnostics [Office Heater] HomeKit request heating target (°C) = 20',
    'Heater diagnostics [Office Heater] HomeKit request cooling target (°C) = 13',
    'Heater diagnostics [Office Heater] Dreo control-reply power = true',
    'Heater diagnostics [Office Heater] Dreo control-report Eco target (°F) = 68',
  ]);
  assert.deepEqual(heater.controls.map(({ params }) => params), [{ poweron: true }, { ecolevel: 68 }]);
});

/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const hap = require('hap-nodejs');
const { HeaterAccessory } = require('../dist/accessories/HeaterAccessory');

function setup(ignoreHeaterPowerOnWithTemperature = true, hideHeaterAutoMode = false) {
  const controls = [];
  const listeners = [];
  const noop = () => undefined;
  const platform = {
    config: { ignoreHeaterPowerOnWithTemperature, hideHeaterAutoMode },
    api: { hap, updatePlatformAccessories: noop },
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    log: { debug: noop, info: noop, warn: noop },
    webHelper: {
      addEventListener: (event, listener) => listeners.push(listener),
      control: (sn, command) => controls.push([sn, command]),
    },
  };
  return {
    controls,
    heater(sn, power = false, mode = 'eco') {
      const accessory = new hap.Accessory(sn, hap.uuid.generate(sn));
      accessory.context = { device: { sn, brand: 'Dreo', model: 'DR-HSH004S', deviceName: sn, controlsConf: {} } };
      accessory.addService(hap.Service.HeaterCooler)
        .updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, 20)
        .updateCharacteristic(hap.Characteristic.CoolingThresholdTemperature, 13)
        .getCharacteristic(hap.Characteristic.CoolingThresholdTemperature)
        .setProps({ minValue: 13, maxValue: 13, validValues: [13] });
      new HeaterAccessory(platform, accessory, {
        temperature: { state: 68 },
        ecolevel: { state: 70 },
        poweron: { state: power },
        mode: { state: mode },
        htalevel: { state: 1 },
        childlockon: { state: false },
        ptcon: { state: false },
      });
      const climate = accessory.getService(hap.Service.HeaterCooler);
      return {
        active: climate.getCharacteristic(hap.Characteristic.Active),
        climate,
        setpoint: climate.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature),
        report: (reported, method = 'report') => listeners.forEach(listener => listener({
          data: JSON.stringify({ devicesn: sn, method, reported }),
        })),
      };
    },
  };
}

test('the default still sends power and temperature immediately', async () => {
  const { heater, controls } = setup(false);
  const { active, setpoint } = heater('Office');
  await active.handleSetRequest(1);
  await setpoint.handleSetRequest(20);
  assert.deepEqual(controls, [['Office', { poweron: true }], ['Office', { ecolevel: 68 }]]);
});

test('a setpoint after grouped power requests suppresses power to both heaters', async () => {
  const { heater, controls } = setup();
  const office = heater('Office');
  const garage = heater('Garage');
  await office.active.handleSetRequest(1);
  await garage.active.handleSetRequest(1);
  assert.equal(office.active.value, 1);
  assert.equal(garage.active.value, 1);
  await garage.setpoint.handleSetRequest(20);
  await nextTurn();
  assert.equal(Number(office.active.value), 0);
  assert.equal(Number(garage.active.value), 0);
  await delay(1600);
  assert.deepEqual(controls, []);
  assert.equal(await office.active.handleGetRequest(), 0);
  assert.equal(await garage.active.handleGetRequest(), 0);
});

test('an off-state setpoint suppresses subsequent power and waits for a confirmed Eco start', async () => {
  const { heater, controls } = setup();
  const office = heater('Office');
  await office.setpoint.handleSetRequest(20);
  await office.active.handleSetRequest(1);
  await nextTurn();
  assert.equal(Number(office.active.value), 0);
  await delay(1600);
  assert.deepEqual(controls, []);
  assert.equal(await office.setpoint.handleGetRequest(), 20);
  await office.active.handleSetRequest(1);
  assert.deepEqual(controls, []);
  await delay(1600);
  assert.deepEqual(controls, [['Office', { poweron: true }]]);
  office.report({ poweron: true });
  assert.deepEqual(controls, [['Office', { poweron: true }], ['Office', { ecolevel: 68 }]]);
  await office.setpoint.handleSetRequest(25);
  office.report({ ecolevel: 68 });
  assert.deepEqual(controls, [['Office', { poweron: true }], ['Office', { ecolevel: 68 }], ['Office', { ecolevel: 77 }]]);
  office.report({ ecolevel: 77 });
  office.report({ poweron: false });
  office.report({ poweron: true });
  assert.equal(controls.length, 3);
});

test('an off write cancels delayed power-on and blocks setpoint writes pending confirmation', async () => {
  const { heater, controls } = setup();
  const office = heater('Office');
  const garage = heater('Garage', true);
  await office.active.handleSetRequest(1);
  await office.active.handleSetRequest(0);
  await garage.active.handleSetRequest(0);
  await garage.setpoint.handleSetRequest(20);
  assert.deepEqual(controls, [['Office', { poweron: false }], ['Garage', { poweron: false }]]);
  await delay(1600);
  assert.equal(controls.length, 2);
});

test('a cloud acknowledgement alone does not enable setpoint writes', async () => {
  const { heater, controls } = setup();
  const garage = heater('Garage');
  garage.report({ poweron: true }, 'control-reply');
  await garage.setpoint.handleSetRequest(20);
  assert.deepEqual(controls, []);
  garage.report({ poweron: true }, 'control-report');
  await garage.setpoint.handleSetRequest(20);
  assert.deepEqual(controls, [['Garage', { ecolevel: 68 }]]);
});

test('Cool selects fan only and accepts a writable target without sending power or mode commands', async () => {
  const { heater, controls } = setup();
  const { climate, report } = heater('Office', true);
  const { CoolingThresholdTemperature, TargetHeaterCoolerState, CurrentHeaterCoolerState } = hap.Characteristic;
  const cooling = climate.getCharacteristic(CoolingThresholdTemperature);
  assert.equal(cooling.props.validValues, undefined);
  assert.deepEqual(climate.getCharacteristic(TargetHeaterCoolerState).props.validValues, [0, 1, 2]);
  await climate.getCharacteristic(TargetHeaterCoolerState).handleSetRequest(2);
  await cooling.handleSetRequest(12, {});
  assert.deepEqual(controls, [['Office', { mode: 'coolair' }]]);
  report({ mode: 'coolair', ptcon: true });
  assert.equal(await climate.getCharacteristic(TargetHeaterCoolerState).handleGetRequest(), 2);
  assert.equal(await climate.getCharacteristic(CurrentHeaterCoolerState).handleGetRequest(), 3);
  assert.equal(await cooling.handleGetRequest(), 12);
  await cooling.handleSetRequest(19, {});
  assert.equal(await cooling.handleGetRequest(), 19);
  await climate.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).handleSetRequest(25, {});
  assert.equal(await cooling.handleGetRequest(), 25);
  assert.deepEqual(controls, [['Office', { mode: 'coolair' }]]);
});

test('an off-state cooling target does not select fan-only mode or let an accompanying power-on through', async () => {
  const { heater, controls } = setup();
  const { climate, active } = heater('Office');
  const { CoolingThresholdTemperature, TargetHeaterCoolerState } = hap.Characteristic;
  await active.handleSetRequest(1);
  await climate.getCharacteristic(CoolingThresholdTemperature).handleSetRequest(12, {});
  await delay(1600);
  assert.deepEqual(controls, []);
  assert.equal(await climate.getCharacteristic(TargetHeaterCoolerState).handleGetRequest(), 1);
  assert.equal(await active.handleGetRequest(), 0);
});

test('a cooling-target write in Heat sets the Eco temperature without changing mode', async () => {
  const { heater, controls } = setup(true, true);
  const { climate, report } = heater('Office', true);
  const cooling = climate.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature);
  await cooling.handleSetRequest(5, {});
  assert.deepEqual(controls, [['Office', { ecolevel: 41 }]]);
  report({ ecolevel: 41 });
  assert.equal(await cooling.handleGetRequest(), 5);
});

test('Hide Heater Auto Mode removes Auto and blocks fixed heat-level writes', async () => {
  const { heater, controls } = setup(false, true);
  const { climate, setpoint } = heater('Office', true, 'hotair');
  const target = climate.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState);
  assert.deepEqual(target.props.validValues, [1, 2]);
  assert.equal(await target.handleGetRequest(), 1);
  await assert.rejects(target.handleSetRequest(0, {}));
  await setpoint.handleSetRequest(25);
  assert.deepEqual(controls, []);
  await target.handleSetRequest(1);
  assert.deepEqual(controls, [['Office', { mode: 'eco' }]]);
});

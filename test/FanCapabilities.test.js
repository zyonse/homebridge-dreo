const test = require('node:test');
const assert = require('node:assert');
const {
  FAN_MODE_SWITCHES,
  getModeCommand,
  getOscillationCommand,
  getStateValue,
} = require('../dist/accessories/FanCapabilities');

test('uses oscillation capability metadata when available', () => {
  const device = {
    controlsConf: {
      control: [{ type: 'Oscillation', cmd: 'hoscon' }],
    },
  };

  assert.strictEqual(getOscillationCommand(device, {}), 'hoscon');
});

test('detects known oscillation commands from live state', () => {
  const device = { controlsConf: {} };

  assert.strictEqual(
    getOscillationCommand(device, { shakehorizon: { state: false } }),
    'shakehorizon',
  );
  assert.strictEqual(
    getOscillationCommand(device, { hoscon: { state: false } }),
    'hoscon',
  );
  assert.strictEqual(
    getOscillationCommand(device, { oscmode: { state: 0 } }),
    'oscmode',
  );
});

test('falls back to shakehorizon for DR-HTF017S', () => {
  assert.strictEqual(
    getOscillationCommand({ model: 'DR-HTF017S', controlsConf: {} }, {}),
    'shakehorizon',
  );
});

test('does not invent an oscillation command for unknown devices', () => {
  assert.strictEqual(getOscillationCommand({}, {}), undefined);
});

test('supports both fan mode command variants', () => {
  assert.strictEqual(getModeCommand({ windtype: { state: 2 } }), 'windtype');
  assert.strictEqual(getModeCommand({ mode: { state: 4 } }), 'mode');
  assert.strictEqual(getModeCommand({}), undefined);
  assert.strictEqual(getStateValue({ windtype: { state: 3 } }, 'windtype'), 3);
});

test('only exposes non-native fan modes as optional switches', () => {
  assert.deepStrictEqual(
    FAN_MODE_SWITCHES.map(({ value, name }) => ({ value, name })),
    [
      { value: 2, name: 'Natural Breeze' },
      { value: 3, name: 'Sleep Mode' },
    ],
  );
});

test('additional fan controls are disabled by default', () => {
  const schema = require('../config.schema.json');

  assert.strictEqual(schema.schema.properties.exposeFanModeSwitches.default, false);
  assert.strictEqual(schema.schema.properties.exposeFanPreferences.default, false);
});

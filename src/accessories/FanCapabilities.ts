interface FanControl {
  type?: string;
  cmd?: string;
}

interface FanDevice {
  model?: string;
  controlsConf?: {
    control?: unknown;
  };
}

interface FanStateValue {
  state?: unknown;
}

export type FanState = Record<string, FanStateValue | undefined>;

export const FAN_MODE_SWITCHES = [
  { value: 2, name: 'Natural Breeze', subtype: 'dreo-mode-natural' },
  { value: 3, name: 'Sleep Mode', subtype: 'dreo-mode-sleep' },
] as const;

const OSCILLATION_KEYS = ['shakehorizon', 'hoscon', 'oscmode'] as const;

// Some devices omit both controlsConf and the oscillation field from their
// initial state. Keep confirmed model-specific fallbacks narrowly scoped.
const OSCILLATION_FALLBACKS: Record<string, string> = {
  'DR-HTF017S': 'shakehorizon',
};

function getControls(device: FanDevice): FanControl[] {
  const controls = device.controlsConf?.control;
  return Array.isArray(controls) ? controls : [];
}

export function getOscillationCommand(
  device: FanDevice,
  state: FanState,
): string | undefined {
  const configuredCommand = getControls(device).find(
    (control) => control.type === 'Oscillation',
  )?.cmd;

  return configuredCommand ||
    OSCILLATION_KEYS.find((command) => state[command] !== undefined) ||
    OSCILLATION_FALLBACKS[device.model || ''];
}

export function getModeCommand(state: FanState): string | undefined {
  return ['windtype', 'mode'].find((command) => state[command] !== undefined);
}

export function getStateValue(state: FanState, command: string): unknown {
  return state[command]?.state;
}

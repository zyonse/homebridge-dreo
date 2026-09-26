export interface DeviceCapabilities {
  maxSpeed: number;
  presetModes?: { name: string; value: number }[];
  horizontalRange?: [number, number];
  verticalRange?: [number, number];
}

export const DREO_DEVICE_CAPABILITIES: Record<string, DeviceCapabilities> = {
  // Tower Fans
  'DR-HTF018S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'natural', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'auto', value: 4 }
    ]
  },
  'DR-HTF017S': {
    maxSpeed: 4,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'natural', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'auto', value: 4 }
    ]
  },
  'DR-HTF024S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'natural', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'auto', value: 4 }
    ]
  },
  // Air Circulators
  'DR-HAF008S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'natural', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'auto', value: 4 }
    ]
  },
  'DR-HPF008S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'auto', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'natural', value: 4 },
      { name: 'turbo', value: 5 }
    ],
    verticalRange: [-30, 90]
  },
  'DR-HPF015S': {
    maxSpeed: 12
  },
  'DR-HPF007S': {
    maxSpeed: 10,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'auto', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'natural', value: 4 },
      { name: 'turbo', value: 5 },
      { name: 'custom', value: 6 }
    ],
    horizontalRange: [-75, 75],
    verticalRange: [-30, 90]
  },
  'DR-HPF005S': {
    maxSpeed: 10,
    horizontalRange: [-60, 60]
  },
  'DR-HPF020S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'auto', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'natural', value: 4 },
      { name: 'turbo', value: 5 },
      { name: 'custom', value: 6 }
    ],
    horizontalRange: [-60, 60],
    verticalRange: [-30, 90]
  },
  'DR-HPF022S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'natural', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'auto', value: 4 },
      { name: 'turbo', value: 5 }
    ],
    horizontalRange: [-60, 60],
    verticalRange: [-30, 90]
  },
  'DR-HPF025S': {
    maxSpeed: 9,
    presetModes: [
      { name: 'normal', value: 1 },
      { name: 'auto', value: 2 },
      { name: 'sleep', value: 3 },
      { name: 'natural', value: 4 },
      { name: 'turbo', value: 5 }
    ],
    horizontalRange: [-60, 60],
    verticalRange: [0, 90]
  },
  // Ceiling Fans
  'DR-HCF002S': {
    maxSpeed: 12
  }
};

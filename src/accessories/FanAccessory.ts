import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

// Known oscillation state keys, in priority order. Add new keys here if Dreo
// introduces additional oscillation commands on future devices.
const OSCILLATION_KEYS = ['shakehorizon', 'hoscon', 'oscmode'] as const;
const RGB_MAX = 255;
const DEFAULT_PERCENT_MAX = 100;

// Fallback maxSpeed for devices whose Dreo API returns an incomplete controlsConf
// (e.g. { template: 'DR-HPF002S' } with no control array). swingCmd is not needed
// here — it is auto-detected from whichever oscillation key is present in device state.
//
// Future enhancement: resolve the template model name returned in controlsConf against
// the Dreo API to fetch the real maxSpeed, eliminating the need for this map entirely.
// Until then, add an entry here for any device that crashes with "No controlsConf" and
// has a non-standard speed count. Devices with full controlsConf from the API are
// unaffected and do not need an entry.
const DEVICE_FALLBACK_CONFIGS: Record<string, { maxSpeed: number }> = {
  'DR-HPF004S': { maxSpeed: 9 },
  'DR-HPF007S': { maxSpeed: 9 },
  'DR-HPF008S': { maxSpeed: 9 },
  'DR-HTF024S': { maxSpeed: 9 },
};

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory extends BaseAccessory {
  private service: Service;
  private temperatureService?: Service;
  private lightService?: Service;
  private rgbLightService?: Service;
  private readonly ambientBrightnessMax: number;

  // Cached copy of latest fan states
  private currState = {
    on: false,
    powerCMD: 'none', // Command used to control power (poweron, fanon)
    speed: 1,
    swing: false,
    swingCMD: 'none', // Command used to control oscillation (shakehorizon, hoscon, oscmode)
    autoMode: false,
    lockPhysicalControls: false,
    maxSpeed: 1,
    temperature: 0,
    lightOn: false,
    brightness: 100,
    rgbLightOn: false,
    rgbBrightness: 100,
    hue: 0,
    saturation: 0,
  };

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    // Call base class constructor
    super(platform, accessory);

    // Initialize fan values
    // Get max fan speed from Dreo API, falling back to device config map for newer models
    // that return empty controlsConf from the API
    const model = accessory.context.device.model;
    this.currState.maxSpeed = Number(
      accessory.context.device?.controlsConf?.control?.find(
        (params) => params.type === 'Speed',
      )?.items?.[1]?.text ??
      DEVICE_FALLBACK_CONFIGS[model]?.maxSpeed ??
      4,
    );
    if (!accessory.context.device?.controlsConf?.control) {
      this.platform.log.warn('No controlsConf from API for %s, using fallback config (maxSpeed: %s)', model, this.currState.maxSpeed);
    }
    this.ambientBrightnessMax = this.resolveAmbientBrightnessMax();
    // Load current state from Dreo API
    this.currState.speed =
      (state.windlevel.state * 100) / this.currState.maxSpeed;
    // Some fans use different commands to toggle power, determine which one should be used
    if (state.fanon !== undefined) {
      this.currState.powerCMD = 'fanon';
      this.currState.on = state.fanon.state;
    } else {
      this.currState.powerCMD = 'poweron';
      this.currState.on = state.poweron.state;
    }

    // Get the Fanv2 service if it exists, otherwise create a new Fanv2 service
    // You can create multiple services for each accessory
    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // Set the service name, this is what is displayed as the default name on the Home app
    // In this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.deviceName,
    );

    // Each service must implement at-minimum the "required characteristics" for the given service type
    // See https://developers.homebridge.io/#/service/Fanv2
    // Register handlers for the Active Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Register handlers for the RotationSpeed Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        // Setting minStep defines fan speed steps in HomeKit
        minStep: 100 / this.currState.maxSpeed,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Check whether fan supports oscillation. First try the API controlsConf, then
    // auto-detect from whichever oscillation key is present in the device state.
    this.currState.swingCMD =
      accessory.context.device?.controlsConf?.control?.find(
        (params) => params.type === 'Oscillation',
      )?.cmd ??
      OSCILLATION_KEYS.find((key) => key in state) ??
      'none';

    if (this.currState.swingCMD !== 'none') {
      // Register handlers for Swing Mode (oscillation)
      this.service
        .getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.setSwingMode.bind(this))
        .onGet(this.getSwingMode.bind(this));
      this.currState.swing = Boolean(state[this.currState.swingCMD]?.state ?? false);
    }

    // Check if mode control is supported
    if (state.mode !== undefined) {
      // Register handlers for Target Fan State
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onSet(this.setMode.bind(this))
        .onGet(this.getMode.bind(this));
      this.currState.autoMode = this.convertModeToBoolean(state.mode.state);
    }

    // Check if child lock is supported
    if (state.childlockon !== undefined) {
      // Register handlers for Lock Physical Controls
      this.service
        .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .onSet(this.setLockPhysicalControls.bind(this))
        .onGet(this.getLockPhysicalControls.bind(this));
      this.currState.lockPhysicalControls = Boolean(state.childlockon.state);
    }

    const shouldHideTemperatureSensor =
      this.platform.config.hideTemperatureSensor || false; // default to false if not defined

    // If temperature is defined and we are not hiding the sensor
    if (state.temperature !== undefined && !shouldHideTemperatureSensor) {
      this.currState.temperature = this.correctedTemperature(
        state.temperature.state,
      );

      // Check if the Temperature Sensor service already exists, if not create a new one
      this.temperatureService = this.accessory.getService(
        this.platform.Service.TemperatureSensor,
      );

      if (!this.temperatureService) {
        this.temperatureService = this.accessory.addService(
          this.platform.Service.TemperatureSensor,
          'Temperature Sensor',
        );
      }

      // Bind the get handler for temperature to this service
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getTemperature.bind(this));
    } else {
      const existingTemperatureService = this.accessory.getService(
        this.platform.Service.TemperatureSensor,
      );
      if (existingTemperatureService) {
        platform.log.debug('Hiding Temperature Sensor');
        this.accessory.removeService(existingTemperatureService);
      }
    }

    if (state.lighton !== undefined && state.brightness !== undefined) {
      this.currState.lightOn = state.lighton.state;
      this.currState.brightness = state.brightness.state;

      // Initialize Lightbulb service
      this.lightService =
        this.accessory.getServiceById(this.platform.Service.Lightbulb, 'main-light') ||
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(
          this.platform.Service.Lightbulb,
          accessory.context.device.deviceName + ' Light',
          'main-light',
        );

      this.lightService.setCharacteristic(
        this.platform.Characteristic.Name,
        accessory.context.device.deviceName + ' Light',
      );

      this.lightService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this))
        .onGet(this.getLightOn.bind(this));

      this.lightService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setBrightness.bind(this))
        .onGet(this.getBrightness.bind(this));
    }

    if (this.hasRgbLightSupport(state)) {
      this.currState.rgbLightOn = Boolean(state.ambient_switch?.state ?? false);
      this.currState.rgbBrightness = this.toHomeKitBrightness(
        Number(state.atmbri?.state ?? this.ambientBrightnessMax),
      );

      if (state.atmcolor?.state !== undefined) {
        const hsv = this.rgbToHsv(this.intToRgb(Number(state.atmcolor.state)));
        this.currState.hue = hsv.hue;
        this.currState.saturation = hsv.saturation;
      }

      this.rgbLightService =
        this.accessory.getServiceById(this.platform.Service.Lightbulb, 'rgb-light') ||
        this.accessory.addService(
          this.platform.Service.Lightbulb,
          accessory.context.device.deviceName + ' RGB Light',
          'rgb-light',
        );

      this.rgbLightService.setCharacteristic(
        this.platform.Characteristic.Name,
        accessory.context.device.deviceName + ' RGB Light',
      );

      this.rgbLightService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setRgbLightOn.bind(this))
        .onGet(this.getRgbLightOn.bind(this));

      this.rgbLightService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setRgbBrightness.bind(this))
        .onGet(this.getRgbBrightness.bind(this));

      this.rgbLightService
        .getCharacteristic(this.platform.Characteristic.Hue)
        .onSet(this.setHue.bind(this))
        .onGet(this.getHue.bind(this));

      this.rgbLightService
        .getCharacteristic(this.platform.Characteristic.Saturation)
        .onSet(this.setSaturation.bind(this))
        .onGet(this.getSaturation.bind(this));
    }

    // Update values from Dreo app
    platform.webHelper.addEventListener('message', (message) => {
      const data = JSON.parse(message.data);

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.warn('Incoming %s', message.data);

        // Check if we need to update fan state in homekit
        if (
          data.method === 'control-report' ||
          data.method === 'control-reply' ||
          data.method === 'report'
        ) {
          Object.keys(data.reported).forEach((key) => {
            switch (key) {
              case 'poweron':
                this.currState.on = data.reported.poweron;
                this.service
                  .getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.currState.on);
                this.platform.log.debug('Fan power:', data.reported.poweron);
                break;
              case 'fanon':
                this.currState.on = data.reported.fanon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.currState.on);
                this.platform.log.debug('Fan power:', data.reported.fanon);
                break;
              case 'windlevel':
                this.currState.speed =
                  (data.reported.windlevel * 100) / this.currState.maxSpeed;
                this.service
                  .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                  .updateValue(this.currState.speed);
                this.platform.log.debug('Fan speed:', data.reported.windlevel);
                break;
              case 'shakehorizon':
                this.currState.swing = data.reported.shakehorizon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.shakehorizon,
                );
                break;
              case 'hoscon':
                this.currState.swing = data.reported.hoscon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.hoscon,
                );
                break;
              case 'oscmode':
                this.currState.swing = Boolean(data.reported.oscmode);
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.oscmode,
                );
                break;
              case 'mode':
                this.currState.autoMode = this.convertModeToBoolean(
                  data.reported.mode,
                );
                this.service
                  .getCharacteristic(
                    this.platform.Characteristic.TargetFanState,
                  )
                  .updateValue(this.currState.autoMode);
                this.platform.log.debug('Fan mode:', data.reported.mode);
                break;
              case 'childlockon':
                this.currState.lockPhysicalControls = Boolean(
                  data.reported.childlockon,
                );
                this.service
                  .getCharacteristic(
                    this.platform.Characteristic.LockPhysicalControls,
                  )
                  .updateValue(this.currState.lockPhysicalControls);
                this.platform.log.debug(
                  'Child lock:',
                  data.reported.childlockon,
                );
                break;
              case 'temperature':
                if (
                  this.temperatureService !== undefined &&
                  !shouldHideTemperatureSensor
                ) {
                  this.currState.temperature = this.correctedTemperature(
                    data.reported.temperature,
                  );
                  this.temperatureService
                    .getCharacteristic(
                      this.platform.Characteristic.CurrentTemperature,
                    )
                    .updateValue(this.currState.temperature);
                }
                this.platform.log.debug(
                  'Temperature:',
                  data.reported.temperature,
                );
                break;
              case 'lighton':
                this.currState.lightOn = data.reported.lighton;
                this.lightService
                  ?.getCharacteristic(this.platform.Characteristic.On)
                  .updateValue(this.currState.lightOn);
                this.platform.log.debug('Light on:', data.reported.lighton);
                break;
              case 'brightness':
                this.currState.brightness = data.reported.brightness;
                this.lightService
                  ?.getCharacteristic(this.platform.Characteristic.Brightness)
                  .updateValue(this.currState.brightness);
                this.platform.log.debug(
                  'Brightness:',
                  data.reported.brightness,
                );
                break;
      case 'atmon':
              case 'ambient_switch':
                this.currState.rgbLightOn = Boolean(data.reported.atmon ?? data.reported.ambient_switch);
                this.rgbLightService
                  ?.getCharacteristic(this.platform.Characteristic.On)
                  .updateValue(this.currState.rgbLightOn);
                this.platform.log.debug(
                  'RGB light on:',
                  data.reported.ambient_switch,
                );
                break;
              case 'atmcolor': {
                const hsv = this.rgbToHsv(this.intToRgb(Number(data.reported.atmcolor)));
                this.currState.hue = hsv.hue;
                this.currState.saturation = hsv.saturation;
                this.rgbLightService
                  ?.getCharacteristic(this.platform.Characteristic.Hue)
                  .updateValue(this.currState.hue);
                this.rgbLightService
                  ?.getCharacteristic(this.platform.Characteristic.Saturation)
                  .updateValue(this.currState.saturation);
                this.platform.log.debug('RGB color:', data.reported.atmcolor);
                break;
              }
              case 'atmbri':
                this.currState.rgbBrightness = this.toHomeKitBrightness(
                  Number(data.reported.atmbri),
                );
                this.rgbLightService
                  ?.getCharacteristic(this.platform.Characteristic.Brightness)
                  .updateValue(this.currState.rgbBrightness);
                this.platform.log.debug('RGB brightness:', data.reported.atmbri);
                break;
              default:
                platform.log.debug(
                  'Unknown command received:',
                  Object.keys(data.reported)[0],
                );
            }
          });
        }
      }
    });
  }

  // Handle requests to set the "Active" characteristic
  setActive(value) {
    this.platform.log.debug('Triggered SET Active:', value);
    // Check state to prevent duplicate requests
    if (this.currState.on !== Boolean(value)) {
      this.currState.on = Boolean(value);
      this.service
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
      // Send to Dreo server via websocket
      this.platform.webHelper.control(this.sn, {
        [this.currState.powerCMD]: this.currState.on,
      });
    }
  }

  // Handle requests to get the current value of the "Active" characteristic
  getActive() {
    return this.currState.on;
  }

  // Handle requests to set the fan speed
  async setRotationSpeed(value) {
    // Rotation speed needs to be scaled from HomeKit's percentage value (Dreo app uses whole numbers, ex. 1-6)
    const converted = Math.round((value * this.currState.maxSpeed) / 100);
    // Avoid setting speed to 0 (illegal value)
    if (converted !== 0) {
      this.platform.log.debug('Setting fan speed:', converted);
      this.currState.speed = Number(value);
      this.currState.on = true;
      this.service
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.currState.speed);
      this.service
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
      // Setting power state to true ensures the fan is actually on
      this.platform.webHelper.control(this.sn, {
        [this.currState.powerCMD]: true,
        windlevel: converted,
      });
    }
  }

  async getRotationSpeed() {
    return this.currState.speed;
  }

  // Turn oscillation on/off
  async setSwingMode(value) {
    this.currState.swing = Boolean(value);
    this.service
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .updateValue(this.currState.swing);
    this.platform.webHelper.control(this.sn, {
      [this.currState.swingCMD]:
        this.currState.swingCMD === 'oscmode' ? Number(value) : this.currState.swing,
    });
  }

  async getSwingMode() {
    return this.currState.swing;
  }

  // Set fan mode
  async setMode(value) {
    this.currState.autoMode =
      value === this.platform.Characteristic.TargetFanState.AUTO;
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetFanState)
      .updateValue(this.currState.autoMode);
    this.platform.webHelper.control(this.sn, {
      mode: value === this.platform.Characteristic.TargetFanState.AUTO ? 4 : 1,
    });
  }

  async getMode() {
    return this.currState.autoMode;
  }

  // Turn child lock on/off
  async setLockPhysicalControls(value) {
    this.currState.lockPhysicalControls = Boolean(value);
    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .updateValue(this.currState.lockPhysicalControls);
    this.platform.webHelper.control(this.sn, {
      childlockon: Number(this.currState.lockPhysicalControls),
    });
  }

  getLockPhysicalControls() {
    return this.currState.lockPhysicalControls;
  }

  async getTemperature() {
    return this.currState.temperature;
  }

  correctedTemperature(temperatureFromDreo) {
    const offset = this.platform.config.temperatureOffset || 0; // default to 0 if not defined
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return ((temperatureFromDreo + offset - 32) * 5) / 9;
  }

  convertModeToBoolean(value: number) {
    // Show all non-automatic modes as "Manual"
    return value === 4;
  }

  setLightOn(value: any) {
    this.platform.log.debug('Triggered SET Light On:', value);
    this.currState.lightOn = Boolean(value);
    this.lightService
      ?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.currState.lightOn);
    this.platform.webHelper.control(this.sn, { lighton: this.currState.lightOn });
  }

  getLightOn() {
    return this.currState.lightOn;
  }

  setBrightness(value) {
    this.platform.log.debug('Triggered SET Brightness:', value);
    this.currState.brightness = Number(value);
    this.lightService
      ?.getCharacteristic(this.platform.Characteristic.Brightness)
      .updateValue(this.currState.brightness);
    this.platform.webHelper.control(this.sn, { brightness: this.currState.brightness });
  }

  getBrightness() {
    return this.currState.brightness;
  }

  private hasRgbLightSupport(state): boolean {
    return state.ambient_switch !== undefined ||
      state.atmcolor !== undefined ||
      state.atmbri !== undefined;
  }

  private resolveAmbientBrightnessMax(): number {
    const control = this.accessory.context.device?.controlsConf?.control?.find(
      (params) => params.cmd === 'atmbri',
    );
    const candidates = [
      control?.items?.[1]?.value,
      control?.items?.[1]?.text,
      control?.max,
      control?.range?.[1],
    ];

    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
      }
    }

    return 5;
  }

  private toHomeKitBrightness(value: number): number {
    const normalized = (value / this.ambientBrightnessMax) * DEFAULT_PERCENT_MAX;
    return Math.max(0, Math.min(DEFAULT_PERCENT_MAX, Math.round(normalized)));
  }

  private toAmbientBrightness(value: number): number {
    return Math.max(1, Math.min(5, Math.round((value / 100) * 5)));
  }

  private intToRgb(value: number) {
    return {
      red: (value >> 16) & RGB_MAX,
      green: (value >> 8) & RGB_MAX,
      blue: value & RGB_MAX,
    };
  }

  private rgbToInt(red: number, green: number, blue: number): number {
    return (red << 16) | (green << 8) | blue;
  }

  private rgbToHsv(rgb: { red: number; green: number; blue: number }) {
    const red = rgb.red / RGB_MAX;
    const green = rgb.green / RGB_MAX;
    const blue = rgb.blue / RGB_MAX;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
      switch (max) {
        case red:
          hue = 60 * (((green - blue) / delta) % 6);
          break;
        case green:
          hue = 60 * (((blue - red) / delta) + 2);
          break;
        default:
          hue = 60 * (((red - green) / delta) + 4);
          break;
      }
    }

    if (hue < 0) {
      hue += 360;
    }

    const saturation = max === 0 ? 0 : (delta / max) * DEFAULT_PERCENT_MAX;

    return {
      hue: Math.round(hue),
      saturation: Math.round(saturation),
    };
  }

  private hsvToRgb(hue: number, saturation: number, brightness: number) {
    const normalizedSaturation = saturation / DEFAULT_PERCENT_MAX;
    const normalizedBrightness = brightness / DEFAULT_PERCENT_MAX;
    const chroma = normalizedBrightness * normalizedSaturation;
    const huePrime = hue / 60;
    const intermediate = chroma * (1 - Math.abs((huePrime % 2) - 1));
    const match = normalizedBrightness - chroma;
    let red = 0;
    let green = 0;
    let blue = 0;

    if (huePrime >= 0 && huePrime < 1) {
      red = chroma;
      green = intermediate;
    } else if (huePrime < 2) {
      red = intermediate;
      green = chroma;
    } else if (huePrime < 3) {
      green = chroma;
      blue = intermediate;
    } else if (huePrime < 4) {
      green = intermediate;
      blue = chroma;
    } else if (huePrime < 5) {
      red = intermediate;
      blue = chroma;
    } else {
      red = chroma;
      blue = intermediate;
    }

    return {
      red: Math.round((red + match) * RGB_MAX),
      green: Math.round((green + match) * RGB_MAX),
      blue: Math.round((blue + match) * RGB_MAX),
    };
  }

  private rgbUpdateTimer?: NodeJS.Timeout;

  private scheduleRgbUpdate() {
    if (this.rgbUpdateTimer) clearTimeout(this.rgbUpdateTimer);
    this.rgbUpdateTimer = setTimeout(() => this.updateRgbColor(), 500);
  }

  private updateRgbColor() {
    const rgb = this.hsvToRgb(
      this.currState.hue,
      this.currState.saturation,
      100,
    );

    this.platform.webHelper.control(this.sn, {
      atmcolor: this.rgbToInt(rgb.red, rgb.green, rgb.blue),
    });
  }

  private setRgbLightOn(value) {
    this.platform.log.debug('Triggered SET RGB Light On:', value);
    this.currState.rgbLightOn = Boolean(value);
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.currState.rgbLightOn);
    this.platform.webHelper.control(this.sn, { atmon: this.currState.rgbLightOn });
  }

  private getRgbLightOn() {
    return this.currState.rgbLightOn;
  }

  private setRgbBrightness(value) {
    this.platform.log.debug('Triggered SET RGB Brightness:', value);
    this.currState.rgbBrightness = Number(value);
    this.currState.rgbLightOn = true;
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.Brightness)
      .updateValue(this.currState.rgbBrightness);
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.currState.rgbLightOn);
    this.platform.webHelper.control(this.sn, {
      atmbri: this.toAmbientBrightness(Number(value)),
    });
  }

  private getRgbBrightness() {
    return this.currState.rgbBrightness;
  }

  private setHue(value) {
    this.platform.log.debug('Triggered SET Hue:', value);
    this.currState.hue = Number(value);
    this.currState.rgbLightOn = true;
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.Hue)
      .updateValue(this.currState.hue);
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.currState.rgbLightOn);
    this.scheduleRgbUpdate();
  }

  private getHue() {
    return this.currState.hue;
  }

  private setSaturation(value) {
    this.platform.log.debug('Triggered SET Saturation:', value);
    this.currState.saturation = Number(value);
    this.currState.rgbLightOn = true;
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.Saturation)
      .updateValue(this.currState.saturation);
    this.rgbLightService
      ?.getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.currState.rgbLightOn);
    this.scheduleRgbUpdate();
  }

  private getSaturation() {
    return this.currState.saturation;
  }
}

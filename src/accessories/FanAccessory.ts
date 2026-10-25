import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

// Known oscillation state keys, in priority order. Add new keys here if Dreo
// introduces additional oscillation commands on future devices.
const OSCILLATION_KEYS = ['shakehorizon', 'hoscon', 'oscmode'] as const;

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

// How long after a speed request reports of any other speed are kept out of HomeKit.
// Commands are paced, so while the slider is dragged the device reports each speed it
// passes through, arriving after HomeKit has already moved on to a newer one.
const SPEED_REPORT_HOLD_MS = 4000;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory extends BaseAccessory {
  private service: Service;
  private temperatureService?: Service;
  private lightService?: Service;

  // Latest speed HomeKit asked for, see SPEED_REPORT_HOLD_MS
  private requestedWindlevel?: number;
  private requestedWindlevelAt = 0;

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
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

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

    // Update values from Dreo app
    platform.webHelper.addEventListener('message', (message) => {
      const data = JSON.parse(message.data);

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // Check if we need to update fan state in homekit
        if (
          data.method === 'control-report' ||
          data.method === 'control-reply' ||
          data.method === 'report' ||
          // Sent with a full state snapshot when the device rejoins the cloud
          data.method === 'device-online'
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
                this.platform.log.debug('Fan speed:', data.reported.windlevel);
                // A control-reply echoes our own command, which HomeKit already shows, and
                // a report of an older speed would drag the slider back through it
                if (data.method === 'control-reply' || this.isStaleSpeedReport(data.reported.windlevel)) {
                  break;
                }
                this.currState.speed =
                  (data.reported.windlevel * 100) / this.currState.maxSpeed;
                this.service
                  .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                  .updateValue(this.currState.speed);
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
    const isActive = Boolean(value);
    this.currState.on = isActive;
    // When HomeKit turns the fan on at a speed (scenes, slider from off) it writes
    // Active and RotationSpeed together; the command queue merges the two into a
    // single power-on + windlevel message
    this.platform.webHelper.control(this.sn, {
      [this.currState.powerCMD]: isActive,
    });
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
      this.requestedWindlevel = converted;
      this.requestedWindlevelAt = Date.now();
      this.currState.on = true;
      this.currState.speed = value;
      // Setting power state to true ensures the fan is actually on
      this.platform.webHelper.control(this.sn, {
        [this.currState.powerCMD]: true,
        windlevel: converted,
      });
    }
  }

  private isStaleSpeedReport(windlevel: number) {
    return this.requestedWindlevel !== undefined &&
      windlevel !== this.requestedWindlevel &&
      Date.now() - this.requestedWindlevelAt < SPEED_REPORT_HOLD_MS;
  }

  async getRotationSpeed() {
    return this.currState.speed;
  }

  // Turn oscillation on/off
  async setSwingMode(value) {
    this.currState.swing = Boolean(value);
    this.platform.webHelper.control(this.sn, {
      [this.currState.swingCMD]:
        this.currState.swingCMD === 'oscmode' ? Number(value) : Boolean(value),
    });
  }

  async getSwingMode() {
    return this.currState.swing;
  }

  // Set fan mode
  async setMode(value) {
    this.currState.autoMode = value === this.platform.Characteristic.TargetFanState.AUTO;
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
    this.platform.webHelper.control(this.sn, { childlockon: Number(value) });
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
    this.platform.webHelper.control(this.sn, { lighton: Boolean(value) });
  }

  getLightOn() {
    return this.currState.lightOn;
  }

  setBrightness(value) {
    this.platform.log.debug('Triggered SET Brightness:', value);
    this.currState.brightness = value;
    this.platform.webHelper.control(this.sn, { brightness: value });
  }

  getBrightness() {
    return this.currState.brightness;
  }

  updateState(state) {
    this.platform.log.debug('Updating state from API for %s', this.accessory.displayName);
    if (!state) {
      return;
    }

    if (state.windlevel !== undefined) {
      this.currState.speed =
        (state.windlevel.state * 100) / this.currState.maxSpeed;
      this.service
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.currState.speed);
    }
    if (state.fanon !== undefined) {
      this.currState.on = state.fanon.state;
      this.service
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
    } else if (state.poweron !== undefined) {
      this.currState.on = state.poweron.state;
      this.service
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
    }
    if (this.currState.swingCMD !== 'none' && state[this.currState.swingCMD] !== undefined) {
      this.currState.swing = Boolean(state[this.currState.swingCMD]?.state ?? false);
      this.service
        .getCharacteristic(this.platform.Characteristic.SwingMode)
        .updateValue(this.currState.swing);
    }
    if (state.mode !== undefined) {
      this.currState.autoMode = this.convertModeToBoolean(state.mode.state);
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetFanState)
        .updateValue(this.currState.autoMode);
    }
    if (state.childlockon !== undefined) {
      this.currState.lockPhysicalControls = Boolean(state.childlockon.state);
      this.service
        .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .updateValue(this.currState.lockPhysicalControls);
    }
    const shouldHideTemperatureSensor =
      this.platform.config.hideTemperatureSensor || false;
    if (state.temperature !== undefined && !shouldHideTemperatureSensor) {
      this.currState.temperature = this.correctedTemperature(
        state.temperature.state,
      );
      if (this.temperatureService) {
        this.temperatureService
          .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .updateValue(this.currState.temperature);
      }
    }
    if (state.lighton !== undefined && state.brightness !== undefined) {
      this.currState.lightOn = state.lighton.state;
      this.currState.brightness = state.brightness.state;
      if (this.lightService) {
        this.lightService
          .getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.currState.lightOn);
        this.lightService
          .getCharacteristic(this.platform.Characteristic.Brightness)
          .updateValue(this.currState.brightness);
      }
    }
  }
}

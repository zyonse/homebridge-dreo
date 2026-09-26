import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';
import { DREO_DEVICE_CAPABILITIES, DeviceCapabilities } from './devices';

// Known oscillation state keys, in priority order. Add new keys here if Dreo
// introduces additional oscillation commands on future devices.
const OSCILLATION_KEYS = ['shakehorizon', 'hoscon', 'oscmode'] as const;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory extends BaseAccessory {
  private service: Service;
  private temperatureService?: Service;
  private lightService?: Service;

  // Advanced capability services
  private horizontalSwingService?: Service;
  private verticalSwingService?: Service;
  private horizontalAngleService?: Service;
  private verticalAngleService?: Service;
  private modeSwitches: Record<string, Service> = {};

  private capabilities?: DeviceCapabilities;

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
    verticalSwing: false,
    horizontalAngle: 0,
    verticalAngle: 0,
    modes: {} as Record<string, boolean>,
  };

  private hasBrightness = false;

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    // Call base class constructor
    super(platform, accessory);

    // Get device capabilities
    const model = accessory.context.device.model;
    this.capabilities = DREO_DEVICE_CAPABILITIES[model];
    this.platform.log.debug('Loaded capabilities for %s:', model, JSON.stringify(this.capabilities));

    // Initialize fan values
    // Get max fan speed from Dreo API, falling back to device config map for newer models
    // that return empty controlsConf from the API
    this.currState.maxSpeed = Number(
      accessory.context.device?.controlsConf?.control?.find(
        (params) => params.type === 'Speed',
      )?.items?.[1]?.text ??
      this.capabilities?.maxSpeed ??
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
    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.deviceName,
    );

    // Each service must implement at-minimum the "required characteristics" for the given service type
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
      if (this.currState.swingCMD === 'oscmode') {
        const oscVal = state.oscmode?.state ?? 0;
        this.currState.swing = (oscVal === 1 || oscVal === 3);
        this.currState.verticalSwing = (oscVal === 2 || oscVal === 3);

        // Remove native SwingMode if it exists (to avoid confusion with two separate switches)
        const swingModeChar = this.service.getCharacteristic(this.platform.Characteristic.SwingMode);
        if (swingModeChar) {
          this.platform.log.debug('Removing native SwingMode characteristic for oscmode device');
          this.service.removeCharacteristic(swingModeChar);
        }

        // Register Horizontal Swing Switch
        this.horizontalSwingService =
          this.accessory.getService('horizontalSwing') ||
          this.accessory.addService(this.platform.Service.Switch, 'Horizontal Swing', 'horizontalSwing');

        this.horizontalSwingService.setCharacteristic(
          this.platform.Characteristic.Name,
          'Horizontal Swing',
        );

        this.horizontalSwingService.getCharacteristic(this.platform.Characteristic.On)
          .onSet(this.setHorizontalSwing.bind(this))
          .onGet(this.getHorizontalSwing.bind(this));

        // Register Vertical Swing Switch if capabilities.verticalRange is present
        if (this.capabilities?.verticalRange) {
          this.verticalSwingService =
            this.accessory.getService('verticalSwing') ||
            this.accessory.addService(this.platform.Service.Switch, 'Vertical Swing', 'verticalSwing');

          this.verticalSwingService.setCharacteristic(
            this.platform.Characteristic.Name,
            'Vertical Swing',
          );

          this.verticalSwingService.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setVerticalSwing.bind(this))
            .onGet(this.getVerticalSwing.bind(this));
        }
      } else {
        // Register handlers for Swing Mode (oscillation) for single-direction fans
        this.service
          .getCharacteristic(this.platform.Characteristic.SwingMode)
          .onSet(this.setSwingMode.bind(this))
          .onGet(this.getSwingMode.bind(this));

        this.currState.swing = Boolean(state[this.currState.swingCMD]?.state ?? false);

        // Clean up custom horizontal/vertical swing switch services if they were cached
        const cachedHorizSwing = this.accessory.getService('horizontalSwing');
        if (cachedHorizSwing) {
          this.accessory.removeService(cachedHorizSwing);
        }
        const cachedVertSwing = this.accessory.getService('verticalSwing');
        if (cachedVertSwing) {
          this.accessory.removeService(cachedVertSwing);
        }
      }
    } else {
      // Clean up custom swing services if the device does not support swing at all
      const cachedHorizSwing = this.accessory.getService('horizontalSwing');
      if (cachedHorizSwing) {
        this.accessory.removeService(cachedHorizSwing);
      }
      const cachedVertSwing = this.accessory.getService('verticalSwing');
      if (cachedVertSwing) {
        this.accessory.removeService(cachedVertSwing);
      }
    }

    // Clean up tilt angle services if they are cached but no longer used
    const cachedHorizontal = this.accessory.getService('horizontalAngle');
    if (cachedHorizontal) {
      this.platform.log.debug('Removing cached Horizontal Angle service');
      this.accessory.removeService(cachedHorizontal);
    }
    const cachedVertical = this.accessory.getService('verticalAngle');
    if (cachedVertical) {
      this.platform.log.debug('Removing cached Vertical Angle service');
      this.accessory.removeService(cachedVertical);
    }

    // Check if mode control is supported
    if (state.mode !== undefined) {
      // Register handlers for Target Fan State
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onSet(this.setMode.bind(this))
        .onGet(this.getMode.bind(this));
      this.currState.autoMode = this.convertModeToBoolean(state.mode.state);

      // Set up individual switches for preset modes
      if (this.capabilities?.presetModes) {
        for (const preset of this.capabilities.presetModes) {
          // Skip 'normal' since it is the default when others are off
          if (preset.name === 'normal') {
            continue;
          }
          const serviceName = `${preset.name.charAt(0).toUpperCase() + preset.name.slice(1)} Mode`;
          const serviceSubtype = `mode_${preset.name}`;

          const modeSwitch =
            this.accessory.getService(serviceSubtype) ||
            this.accessory.addService(this.platform.Service.Switch, serviceName, serviceSubtype);

          modeSwitch.setCharacteristic(
            this.platform.Characteristic.Name,
            serviceName,
          );

          modeSwitch.getCharacteristic(this.platform.Characteristic.On)
            .onSet((value) => this.setPresetMode(preset.name, preset.value, value))
            .onGet(() => this.getPresetMode(preset.name));

          this.modeSwitches[preset.name] = modeSwitch;
          this.currState.modes[preset.name] = (state.mode?.state === preset.value);
        }
      }
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

    if (state.lighton !== undefined) {
      this.currState.lightOn = state.lighton.state;

      // Initialize Lightbulb service
      this.lightService =
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      this.lightService.setCharacteristic(
        this.platform.Characteristic.Name,
        'Light',
      );

      this.lightService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this))
        .onGet(this.getLightOn.bind(this));

      if (state.brightness !== undefined) {
        this.currState.brightness = state.brightness.state;
        this.hasBrightness = true;

        this.lightService
          .getCharacteristic(this.platform.Characteristic.Brightness)
          .onSet(this.setBrightness.bind(this))
          .onGet(this.getBrightness.bind(this));
      }
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
              case 'oscmode': {
                const oscVal = data.reported.oscmode;
                this.currState.swing = (oscVal === 1 || oscVal === 3);
                this.currState.verticalSwing = (oscVal === 2 || oscVal === 3);
                if (this.horizontalSwingService) {
                  this.horizontalSwingService
                    .getCharacteristic(this.platform.Characteristic.On)
                    .updateValue(this.currState.swing);
                }
                if (this.verticalSwingService) {
                  this.verticalSwingService
                    .getCharacteristic(this.platform.Characteristic.On)
                    .updateValue(this.currState.verticalSwing);
                }
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.oscmode,
                );
                break;
              }
              case 'fixedconf': {
                if (data.reported.fixedconf) {
                  const [hAngle, vAngle] = data.reported.fixedconf.split(',').map(Number);
                  this.currState.horizontalAngle = hAngle;
                  this.currState.verticalAngle = vAngle;
                }
                this.platform.log.debug(
                  'Fixed direction configuration:',
                  data.reported.fixedconf,
                );
                break;
              }
              case 'mode': {
                const currentModeValue = data.reported.mode;
                this.currState.autoMode = (currentModeValue === 4);
                this.service
                  .getCharacteristic(this.platform.Characteristic.TargetFanState)
                  .updateValue(this.currState.autoMode);

                if (this.capabilities?.presetModes) {
                  this.capabilities.presetModes.forEach((preset) => {
                    if (preset.name === 'normal') {
                      return;
                    }
                    const isCurrent = (currentModeValue === preset.value);
                    this.currState.modes[preset.name] = isCurrent;
                    if (this.modeSwitches[preset.name]) {
                      this.modeSwitches[preset.name]
                        .getCharacteristic(this.platform.Characteristic.On)
                        .updateValue(isCurrent);
                    }
                  });
                }
                this.platform.log.debug('Fan mode:', data.reported.mode);
                break;
              }
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
                if (this.hasBrightness) {
                  this.currState.brightness = data.reported.brightness;
                  this.lightService
                    ?.getCharacteristic(this.platform.Characteristic.Brightness)
                    .updateValue(this.currState.brightness);
                }
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
    // Check state to prevent duplicate requests
    if (this.currState.on !== Boolean(value)) {
      // Send to Dreo server via websocket
      this.platform.webHelper.control(this.sn, {
        [this.currState.powerCMD]: Boolean(value),
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

  // Turn oscillation on/off (for single-direction oscillation)
  async setSwingMode(value) {
    this.currState.swing = Boolean(value);
    this.platform.webHelper.control(this.sn, {
      [this.currState.swingCMD]: Boolean(value),
    });
  }

  async getSwingMode() {
    return this.currState.swing;
  }

  // Turn horizontal oscillation on/off (for oscmode devices)
  setHorizontalSwing(value) {
    this.platform.log.debug('Setting Horizontal Swing:', value);
    this.currState.swing = Boolean(value);
    this.updateOscmode();
  }

  getHorizontalSwing() {
    return this.currState.swing;
  }

  // Turn vertical oscillation on/off (for oscmode devices)
  setVerticalSwing(value) {
    this.platform.log.debug('Setting Vertical Swing:', value);
    this.currState.verticalSwing = Boolean(value);
    this.updateOscmode();
  }

  getVerticalSwing() {
    return this.currState.verticalSwing;
  }

  private updateOscmode() {
    let oscmodeValue = 0;
    if (this.currState.swing && this.currState.verticalSwing) {
      oscmodeValue = 3;
    } else if (this.currState.swing) {
      oscmodeValue = 1;
    } else if (this.currState.verticalSwing) {
      oscmodeValue = 2;
    }
    this.platform.webHelper.control(this.sn, { oscmode: oscmodeValue });
  }



  // Preset Modes
  setPresetMode(modeName: string, modeValue: number, value: any) {
    this.platform.log.debug(`Setting Preset Mode ${modeName} to ${value}`);
    if (value) {
      this.platform.webHelper.control(this.sn, { mode: modeValue });
      this.currState.modes[modeName] = true;
      Object.keys(this.modeSwitches).forEach((otherName) => {
        if (otherName !== modeName) {
          this.currState.modes[otherName] = false;
          this.modeSwitches[otherName].getCharacteristic(this.platform.Characteristic.On)
            .updateValue(false);
        }
      });
      this.currState.autoMode = (modeName === 'auto');
      this.service.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .updateValue(this.currState.autoMode);
    } else {
      // Revert to Normal mode (value 1)
      this.platform.webHelper.control(this.sn, { mode: 1 });
      this.currState.modes[modeName] = false;
      this.currState.autoMode = false;
      this.service.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .updateValue(false);
    }
  }

  getPresetMode(modeName: string) {
    return !!this.currState.modes[modeName];
  }

  // Set fan mode
  async setMode(value) {
    this.platform.webHelper.control(this.sn, {
      mode: value === this.platform.Characteristic.TargetFanState.AUTO ? 4 : 1,
    });
  }

  async getMode() {
    return this.currState.autoMode;
  }

  // Turn child lock on/off
  async setLockPhysicalControls(value) {
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
    return ((temperatureFromDreo + offset - 32) * 5) / 9;
  }

  convertModeToBoolean(value: number) {
    return value === 4;
  }

  setLightOn(value: any) {
    this.platform.log.debug('Triggered SET Light On:', value);
    this.platform.webHelper.control(this.sn, { lighton: Boolean(value) });
  }

  getLightOn() {
    return this.currState.lightOn;
  }

  setBrightness(value) {
    this.platform.log.debug('Triggered SET Brightness:', value);
    this.platform.webHelper.control(this.sn, { brightness: value });
  }

  getBrightness() {
    return this.currState.brightness;
  }
}

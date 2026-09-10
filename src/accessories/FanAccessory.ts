import { CharacteristicValue, Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';
import {
  FAN_MODE_SWITCHES,
  getModeCommand,
  getOscillationCommand,
  getStateValue,
} from './FanCapabilities';

// Fallback maxSpeed for devices whose Dreo API returns an incomplete controlsConf
// (e.g. { template: 'DR-HPF002S' } with no control array).
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
  private displayAutoOffService?: Service;
  private panelSoundService?: Service;
  private readonly modeServices = new Map<number, Service>();

  // Cached copy of latest fan states
  private currState = {
    on: false,
    powerCMD: 'none', // Command used to control power (poweron, fanon)
    speed: 1,
    swing: false,
    swingCMD: 'none', // Command used to control oscillation (shakehorizon, hoscon, oscmode)
    mode: 1,
    modeCMD: 'none', // Command used to control mode (windtype, mode)
    autoMode: false,
    lockPhysicalControls: false,
    maxSpeed: 1,
    temperature: 0,
    lightOn: false,
    brightness: 100,
    ledAlwaysOn: false,
    panelSound: false,
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
    this.currState.swingCMD = getOscillationCommand(
      accessory.context.device,
      state,
    ) || 'none';

    if (this.currState.swingCMD !== 'none') {
      // Register handlers for Swing Mode (oscillation)
      this.service
        .getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.setSwingMode.bind(this))
        .onGet(this.getSwingMode.bind(this));
      this.currState.swing = Boolean(state[this.currState.swingCMD]?.state ?? false);
    }

    // Check if mode control is supported. Newer fans report "windtype"
    // instead of "mode".
    const modeCommand = getModeCommand(state);
    this.currState.modeCMD = modeCommand || 'none';
    if (modeCommand) {
      // Register handlers for Target Fan State
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onSet(this.setMode.bind(this))
        .onGet(this.getMode.bind(this));
      this.currState.mode = Number(getStateValue(state, modeCommand));
      this.currState.autoMode = this.convertModeToBoolean(this.currState.mode);
      this.configureModeSwitches();
    } else {
      this.removeModeSwitches();
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

    this.configurePreferenceSwitches(state);

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
              case 'windtype':
                this.updateMode(Number(data.reported[key]));
                this.platform.log.debug('Fan mode:', data.reported[key]);
                break;
              case 'ledalwayson':
                this.currState.ledAlwaysOn = Boolean(data.reported.ledalwayson);
                this.displayAutoOffService
                  ?.getCharacteristic(this.platform.Characteristic.On)
                  .updateValue(!this.currState.ledAlwaysOn);
                this.platform.log.debug('Display always on:', data.reported.ledalwayson);
                break;
              case 'voiceon':
                this.currState.panelSound = Boolean(data.reported.voiceon);
                this.panelSoundService
                  ?.getCharacteristic(this.platform.Characteristic.On)
                  .updateValue(this.currState.panelSound);
                this.platform.log.debug('Panel sound:', data.reported.voiceon);
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

  private configureModeSwitches() {
    if (!this.platform.config.exposeFanModeSwitches) {
      this.removeModeSwitches();
      return;
    }

    for (const mode of FAN_MODE_SWITCHES) {
      const displayName = `${this.accessory.context.device.deviceName} ${mode.name}`;
      const service = this.accessory.getServiceById(
        this.platform.Service.Switch,
        mode.subtype,
      ) || this.accessory.addService(
          this.platform.Service.Switch,
          displayName,
          mode.subtype,
        );

      service.displayName = displayName;
      service
        .setCharacteristic(this.platform.Characteristic.Name, displayName)
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet((value) => this.setDetailedMode(mode.value, value))
        .onGet(() => this.currState.mode === mode.value)
        .updateValue(this.currState.mode === mode.value);

      this.modeServices.set(mode.value, service);
    }
  }

  private removeModeSwitches() {
    for (const mode of FAN_MODE_SWITCHES) {
      const service = this.accessory.getServiceById(
        this.platform.Service.Switch,
        mode.subtype,
      );
      if (service) {
        this.accessory.removeService(service);
      }
    }
    this.modeServices.clear();
  }

  private configurePreferenceSwitches(state) {
    if (!this.platform.config.exposeFanPreferences) {
      this.removeSwitch('dreo-display-auto-off');
      this.removeSwitch('dreo-panel-sound');
      this.displayAutoOffService = undefined;
      this.panelSoundService = undefined;
      return;
    }

    const deviceName = this.accessory.context.device.deviceName;
    if (state.ledalwayson !== undefined) {
      this.currState.ledAlwaysOn = Boolean(state.ledalwayson.state);
      const displayName = `${deviceName} Display Auto Off`;
      this.displayAutoOffService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        'dreo-display-auto-off',
      ) || this.accessory.addService(
          this.platform.Service.Switch,
          displayName,
          'dreo-display-auto-off',
        );
      this.displayAutoOffService.displayName = displayName;
      this.displayAutoOffService
        .setCharacteristic(this.platform.Characteristic.Name, displayName)
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setDisplayAutoOff.bind(this))
        .onGet(this.getDisplayAutoOff.bind(this))
        .updateValue(!this.currState.ledAlwaysOn);
    } else {
      this.removeSwitch('dreo-display-auto-off');
      this.displayAutoOffService = undefined;
    }

    if (state.voiceon !== undefined) {
      this.currState.panelSound = Boolean(state.voiceon.state);
      const displayName = `${deviceName} Panel Sound`;
      this.panelSoundService = this.accessory.getServiceById(
        this.platform.Service.Switch,
        'dreo-panel-sound',
      ) || this.accessory.addService(
          this.platform.Service.Switch,
          displayName,
          'dreo-panel-sound',
        );
      this.panelSoundService.displayName = displayName;
      this.panelSoundService
        .setCharacteristic(this.platform.Characteristic.Name, displayName)
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setPanelSound.bind(this))
        .onGet(this.getPanelSound.bind(this))
        .updateValue(this.currState.panelSound);
    } else {
      this.removeSwitch('dreo-panel-sound');
      this.panelSoundService = undefined;
    }
  }

  private removeSwitch(subtype: string) {
    const service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      subtype,
    );
    if (service) {
      this.accessory.removeService(service);
    }
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

  // Turn oscillation on/off
  async setSwingMode(value) {
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
    this.platform.webHelper.control(this.sn, {
      [this.currState.modeCMD]:
        value === this.platform.Characteristic.TargetFanState.AUTO ? 4 : 1,
    });
  }

  async getMode() {
    return this.currState.autoMode;
  }

  private setDetailedMode(mode: number, value: CharacteristicValue) {
    if (Boolean(value)) {
      this.platform.webHelper.control(this.sn, {
        [this.currState.modeCMD]: mode,
      });
      return;
    }

    if (this.currState.mode === mode) {
      this.platform.webHelper.control(this.sn, {
        [this.currState.modeCMD]: 1,
      });
    }
  }

  private updateMode(mode: number) {
    this.currState.mode = mode;
    this.currState.autoMode = this.convertModeToBoolean(mode);
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetFanState)
      .updateValue(this.currState.autoMode);

    for (const [modeValue, service] of this.modeServices) {
      service
        .getCharacteristic(this.platform.Characteristic.On)
        .updateValue(modeValue === mode);
    }
  }

  private setDisplayAutoOff(value: CharacteristicValue) {
    this.platform.webHelper.control(this.sn, {
      ledalwayson: !Boolean(value),
    });
  }

  private getDisplayAutoOff() {
    return !this.currState.ledAlwaysOn;
  }

  private setPanelSound(value: CharacteristicValue) {
    this.platform.webHelper.control(this.sn, {
      voiceon: Boolean(value),
    });
  }

  private getPanelSound() {
    return this.currState.panelSound;
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
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return ((temperatureFromDreo + offset - 32) * 5) / 9;
  }

  convertModeToBoolean(value: number) {
    // Show all non-automatic modes as "Manual"
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

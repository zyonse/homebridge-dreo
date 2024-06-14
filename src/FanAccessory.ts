import { Service, PlatformAccessory} from 'homebridge';
import { DreoPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory {
  private service: Service;
  private temperatureService?: Service;

  // Cached copy of latest fan states
  private fanState = {
    On: false,
    PowerMethod: 'none',  // Variable used to control power (poweron, fanon)
    Speed: 1,
    Swing: false,
    SwingMethod: 'none',  // Variable used to control oscillation (shakehorizon, hoscon, oscmode)
    AutoMode: false,
    LockPhysicalControls: false,
    MaxSpeed: 1,
    Temperature: 0,
  };

  constructor(
    private readonly platform: DreoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly state,
    private readonly ws,
  ) {

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);

    // Initialize fan values
    // Get max fan speed from Dreo report
    this.fanState.MaxSpeed = accessory.context.device.controlsConf.control[1].items[1].text;
    // Load current state from Dreo report
    this.fanState.Speed = state.windlevel.state * 100 / this.fanState.MaxSpeed;
    // Some fans use different commands to toggle power, determine which one should be used
    if (state.fanon !== undefined) {
      this.fanState.PowerMethod = 'fanon';
      this.fanState.On = state.fanon.state;
    } else {
      this.fanState.PowerMethod = 'poweron';
      this.fanState.On = state.poweron.state;
    }

    // Get the Fanv2 service if it exists, otherwise create a new Fanv2 service
    // You can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);

    // Set the service name, this is what is displayed as the default name on the Home app
    // In this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.deviceName);

    // Each service must implement at-minimum the "required characteristics" for the given service type
    // See https://developers.homebridge.io/#/service/Fanv2
    // Register handlers for the Active Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleActiveSet.bind(this))
      .onGet(this.handleActiveGet.bind(this));

    // Register handlers for the RotationSpeed Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        // Setting minStep defines fan speed steps in HomeKit
        minStep: 100 / this.fanState.MaxSpeed,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Check whether fan supports oscillation
    // Some fans use different commands to toggle oscillation, determine which one should be used
    if (state.shakehorizon !== undefined) {
      this.fanState.SwingMethod = 'shakehorizon';
    } else if (state.hoscon !== undefined) {
      this.fanState.SwingMethod = 'hoscon';
    } else if (state.oscmode !== undefined) {
      this.fanState.SwingMethod = 'oscmode';
    }

    if (this.fanState.SwingMethod !== 'none') {
      // Register handlers for Swing Mode (oscillation)
      this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.setSwingMode.bind(this))
        .onGet(this.getSwingMode.bind(this));
      this.fanState.Swing = state[this.fanState.SwingMethod].state;
    }

    // Check if mode control is supported
    if (state.mode !== undefined) {
      // Register handlers for Target Fan State
      this.service.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onSet(this.setMode.bind(this))
        .onGet(this.getMode.bind(this));
      this.fanState.AutoMode = this.convertModeToBoolean(state.mode.state);
    }

    // Check if child lock is supported
    if (state.childlockon !== undefined) {
      // Register handlers for Lock Physical Controls
      this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .onSet(this.setLockPhysicalControls.bind(this))
        .onGet(this.getLockPhysicalControls.bind(this));
      this.fanState.LockPhysicalControls = Boolean(state.childlockon.state);
    }

    const shouldHideTemperatureSensor = this.platform.config.hideTemperatureSensor || false; // default to false if not defined

    // If temperature is defined and we are not hiding the sensor
    if (state.temperature !== undefined && !shouldHideTemperatureSensor) {
      this.fanState.Temperature = this.correctedTemperature(state.temperature.state);

      // Check if the Temperature Sensor service already exists, if not create a new one
      this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);

      if (!this.temperatureService) {
        this.temperatureService = this.accessory.addService(this.platform.Service.TemperatureSensor, 'Temperature Sensor');
      }

      // Bind the get handler for temperature to this service
      this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getTemperature.bind(this));
    } else {
      const existingTemperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor);
      if (existingTemperatureService) {
        platform.log.debug('Hiding Temperature Sensor');
        this.accessory.removeService(existingTemperatureService);
      }
    }

    // Update values from Dreo app
    ws.addEventListener('message', message => {
      const data = JSON.parse(message.data);

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // Check if we need to update fan state in homekit
        if (data.method === 'control-report' || data.method === 'control-reply' || data.method === 'report') {
          switch(Object.keys(data.reported)[0]) {
            case 'poweron':
              this.fanState.On = data.reported.poweron;
              this.service.getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.fanState.On);
              this.platform.log.debug('Fan power:', data.reported.poweron);
              break;
            case 'fanon':
              this.fanState.On = data.reported.fanon;
              this.service.getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.fanState.On);
              this.platform.log.debug('Fan power:', data.reported.fanon);
              break;
            case 'windlevel':
              this.fanState.Speed = data.reported.windlevel * 100 / this.fanState.MaxSpeed;
              this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .updateValue(this.fanState.Speed);
              this.platform.log.debug('Fan speed:', data.reported.windlevel);
              break;
            case 'shakehorizon':
              this.fanState.Swing = data.reported.shakehorizon;
              this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                .updateValue(this.fanState.Swing);
              this.platform.log.debug('Oscillation mode:', data.reported.shakehorizon);
              break;
            case 'hoscon':
              this.fanState.Swing = data.reported.hoscon;
              this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                .updateValue(this.fanState.Swing);
              this.platform.log.debug('Oscillation mode:', data.reported.hoscon);
              break;
            case 'oscmode':
              this.fanState.Swing = Boolean(data.reported.oscmode);
              this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                .updateValue(this.fanState.Swing);
              this.platform.log.debug('Oscillation mode:', data.reported.oscmode);
              break;
            case 'mode':
              this.fanState.AutoMode = this.convertModeToBoolean(data.reported.mode);
              this.service.getCharacteristic(this.platform.Characteristic.TargetFanState)
                .updateValue(this.fanState.AutoMode);
              this.platform.log.debug('Fan mode:', data.reported.mode);
              break;
            case 'childlockon':
              this.fanState.LockPhysicalControls = Boolean(data.reported.childlockon);
              this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
                .updateValue(this.fanState.LockPhysicalControls);
              this.platform.log.debug('Child lock:', data.reported.childlockon);
              break;
            case 'temperature':
              if (this.temperatureService !== undefined && !shouldHideTemperatureSensor) {
                this.fanState.Temperature = this.correctedTemperature(data.reported.temperature);
                this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                  .updateValue(this.fanState.Temperature);
              }
              this.platform.log.debug('Temperature:', data.reported.temperature);
              break;
            default:
              platform.log.debug('Unknown command received:', Object.keys(data.reported)[0]);
          }
        }
      }
    });
  }

  // Handle requests to set the "Active" characteristic
  handleActiveSet(value) {
    this.platform.log.debug('Triggered SET Active:', value);
    // Check state to prevent duplicate requests
    if (this.fanState.On !== Boolean(value)) {
      // Send to Dreo server via websocket
      this.ws.send(JSON.stringify({
        'devicesn': this.accessory.context.device.sn,
        'method': 'control',
        'params': {PowerMethod: Boolean(value)},
        'timestamp': Date.now(),
      }));
    }
  }

  // Handle requests to get the current value of the "Active" characteristic
  handleActiveGet() {
    return this.fanState.On;
  }

  // Handle requests to set the fan speed
  async setRotationSpeed(value) {
    // Rotation speed needs to be scaled from HomeKit's percentage value (Dreo app uses whole numbers, ex. 1-6)
    const converted = Math.round(value * this.fanState.MaxSpeed / 100);
    // Avoid setting speed to 0 (illegal value)
    if (converted !== 0) {
      this.platform.log.debug('Setting fan speed:', converted);
      this.ws.send(JSON.stringify({
        'devicesn': this.accessory.context.device.sn,
        'method': 'control',
        'params': {
          PowerMethod: true,  // Setting power state to true ensures the fan is actually on
          'windlevel': converted,
        },
        'timestamp': Date.now(),
      }));
    }
  }

  async getRotationSpeed() {
    return this.fanState.Speed;
  }

  // Turn oscillation on/off
  async setSwingMode(value) {
    this.ws.send(JSON.stringify({
      'devicesn': this.accessory.context.device.sn,
      'method': 'control',
      'params': {[this.fanState.SwingMethod]: this.fanState.SwingMethod === 'oscmode' ? Number(value) : Boolean(value)},
      'timestamp': Date.now(),
    }));
  }

  async getSwingMode() {
    return this.fanState.Swing;
  }

  // Set fan mode
  async setMode(value) {
    this.ws.send(JSON.stringify({
      'devicesn': this.accessory.context.device.sn,
      'method': 'control',
      'params': {'mode': value === this.platform.Characteristic.TargetFanState.AUTO ? 4 : 1},
      'timestamp': Date.now(),
    }));
  }

  async getMode() {
    return this.fanState.AutoMode;
  }

  // Turn child lock on/off
  async setLockPhysicalControls(value) {
    this.ws.send(JSON.stringify({
      'devicesn': this.accessory.context.device.sn,
      'method': 'control',
      'params': {'childlockon': Number(value)},
      'timestamp': Date.now(),
    }));
  }

  getLockPhysicalControls() {
    return this.fanState.LockPhysicalControls;
  }

  async getTemperature() {
    return this.fanState.Temperature;
  }

  correctedTemperature(temperatureFromDreo) {
    const offset = this.platform.config.temperatureOffset || 0; // default to 0 if not defined
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return ((temperatureFromDreo + offset) - 32) * 5 / 9;
  }

  convertModeToBoolean(value: number) {
    // Show all non-automatic modes as "Manual"
    return (value === 4);
  }
}

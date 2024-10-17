import { Service, PlatformAccessory} from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

/**
 * Heater Accessory
 */
export class HeaterAccessory extends BaseAccessory {
  private service: Service;

  // Cached copy of latest device states
  private on: boolean;
  private mode: string;  // [hotair, eco, coolair]
  private heatLevel: number;  // 1 - 3
  private oscAngle: number;  // Oscillation angle: 0 = rotating, 60, 90, 120
  private temperature: number;
  private targetTemperature: number;
  private tempUnit: number;  // Unit shown on physical disply: 1 = F, 2 = C
  private childLockOn: boolean;

  private modeMap = {
    hotair: 0,
    eco: 1,
    coolair: 2,
  };

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    // Call base class constructor
    super(platform, accessory);

    // Update current state in homebridge from Dreo API
    this.temperature = this.convertToCelsius(state.temperature.state);
    this.targetTemperature = this.convertToCelsius(state.ecolevel.state);
    this.on = state.poweron.state;
    this.mode = this.modeMap[state.mode.state];
    this.heatLevel = state.htalevel.state;
    this.oscAngle = state.oscangle.state;
    this.tempUnit = state.tempunit.state;
    this.childLockOn = state.childlockon.state;

    // Get the HeaterCooler service if it exists, otherwise create a new HeaterCooler service
    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) ||
                   this.accessory.addService(this.platform.Service.HeaterCooler);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.deviceName);

    // Register handlers for the Active characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Register handlers for the Current Temperature characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Register handlers for Heating Threshold Temperature
    const ecoRange = accessory.context.device.controlsConf.schedule.modes.find(params => params.value === 'eco').controls[0];
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onSet(this.setHeatingThresholdTemperature.bind(this))
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .setProps({
        minValue: this.convertToCelsius(ecoRange.startValue),
        maxValue: this.convertToCelsius(ecoRange.endValue),
      });

    // Check if child lock is supported
    if (state.childlockon !== undefined) {
      // Register handlers for Lock Physical Controls
      this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .onSet(this.setLockPhysicalControls.bind(this))
        .onGet(this.getLockPhysicalControls.bind(this));
    }

    // Update values from Dreo app
    platform.webHelper.addEventListener('message', message => {
      const data = JSON.parse(message.data);

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // Check if we need to update fan state in homekit
        if (data.method === 'control-report' || data.method === 'control-reply' || data.method === 'report') {
          switch(Object.keys(data.reported)[0]) {
            case 'poweron':
              this.on = data.reported.poweron;
              this.service.getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.on);
              this.platform.log.debug('Heater power:', data.reported.poweron);
              break;
            case 'mode':
              this.mode = this.modeMap[data.reported.mode];
              this.service.getCharacteristic(this.platform.Characteristic.TargetFanState)
                .updateValue(this.mode);
              this.platform.log.debug('Fan mode:', data.reported.mode);
              break;
            case 'childlockon':
              this.childLockOn = Boolean(data.reported.childlockon);
              this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
                .updateValue(this.childLockOn);
              this.platform.log.debug('Child lock:', data.reported.childlockon);
              break;
            case 'temperature':
              this.temperature = this.convertToCelsius(data.reported.temperature);
              this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                .updateValue(this.temperature);
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
  setActive(value) {
    this.platform.log.debug('Triggered SET Active:', value);
    // Check state to prevent duplicate requests
    if (this.on !== Boolean(value)) {
      // Send to Dreo server via websocket
      this.platform.webHelper.control(this.sn, {'poweron': Boolean(value)});
    }
  }

  // Handle requests to get the current value of the "Active" characteristic
  getActive() {
    return this.on;
  }

  // Handle requests for Current Temperature
  getCurrentTemperature() {
    return this.temperature;
  }

  // Handle requests for Heating Threshold Temperature
  setHeatingThresholdTemperature(value) {
    this.platform.webHelper.control(this.sn, {'ecolevel': this.convertToFahrenheit(value)});
  }

  getHeatingThresholdTemperature() {
    return this.targetTemperature;
  }

  // Turn child lock on/off
  setLockPhysicalControls(value) {
    this.platform.webHelper.control(this.sn, {'childlockon': Boolean(value)});
  }

  getLockPhysicalControls() {
    return this.childLockOn;
  }

  convertToCelsius(temperatureFromDreo) {
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return (temperatureFromDreo - 32) * 5 / 9;
  }

  convertToFahrenheit(temperatureFromHomeKit) {
    // Dreo expects temperature in Fahrenheit for some reason
    return (temperatureFromHomeKit * 9 / 5) + 32;
  }
}

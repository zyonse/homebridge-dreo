import { Service, PlatformAccessory} from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

const HEATER_COMMAND_WINDOW_MS = 1500;

/**
 * Heater Accessory
 */
export class HeaterAccessory extends BaseAccessory {
  private static readonly lastTemperatureWrite = new WeakMap<DreoPlatform, number>();
  private static readonly pendingStarts = new WeakMap<DreoPlatform, Set<HeaterAccessory>>();
  private service: Service;
  private readonly guardHeaterPower: boolean;
  private readonly hideHeaterAutoMode: boolean;
  private pendingPowerOn?: ReturnType<typeof setTimeout>;
  private shuttingOff = false;
  private sentEcoSetpoint?: number;
  private fanOnlyRequested = false;

  // Cached copy of latest device states
  private on: boolean;
  private mode: string;  // [hotair, eco, coolair]
  private heatLevel: number;  // [1, 2, 3]
  private oscAngle: number;  // Oscillation angle: 0 = rotating, 60, 90, 120
  private swing: boolean;  // Oscillation on/off
  private temperature: number;
  private targetTemperature: number;
  private currState: number;  // Heater state in HomeKit {0: inactive, 1: idle, 2: heating, 3: cooling}
  private tempUnit: boolean;  // Unit shown on physical disply: {0: C, 1: F}
  private childLockOn: boolean;
  private ptcon: boolean;  // Heating active

  /**
  * Map of Oscillation commands to HomeKit percentage values
  * Dreo uses 0, 60, 90, 120 for oscillation angle where 0 is rotating
  * If we get an oscillation angle of 0 from Dreo, we'll set oscOn to true
  */
  private readonly oscMap = {
    // Dreo -> HomeKit
    60: 100,
    90: 50,
    120: 0,
    // HomeKit -> Dreo
    100: 60,
    50: 90,
    0: 120,
  };

  minTemp: number;
  canSwing: boolean;
  canSetAngle: boolean;
  canSetTempUnit: boolean;

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    // Call base class constructor
    super(platform, accessory, state);
    this.guardHeaterPower = platform.config.ignoreHeaterPowerOnWithTemperature === true;
    this.hideHeaterAutoMode = platform.config.hideHeaterAutoMode === true;

    // Update current state in homebridge from Dreo API
    this.temperature = this.convertToCelsius(state.temperature.state);
    this.targetTemperature = this.convertToCelsius(state.ecolevel.state);
    this.on = state.poweron.state;
    this.mode = state.mode.state;
    this.heatLevel = state.htalevel.state;
    this.childLockOn = state.childlockon.state;
    this.ptcon = state.ptcon.state;

    // Determine if fan supports "oscangle" command
    if (state.oscangle) {
      // Fan supports setting specific oscillation angles
      this.canSetAngle = true;
      this.canSwing = true;
      if (state.oscangle.state === 0) {
        this.swing = true;
        this.oscAngle = 0;
      } else {
        this.swing = false;
        this.oscAngle = this.oscMap[state.oscangle.state];
      }
    } else if (state.oscon) {
      // Fan only supports on/off oscillation toggle
      this.canSetAngle = false;
      this.canSwing = true;
      this.swing = state.oscon.state;
      this.oscAngle = 0;
    } else {
      // Fan does not support oscillation
      this.canSwing = false;
      this.canSetAngle = false;
      this.swing = false;
      this.oscAngle = 0;
    }
    // Determine if fan supports setting temperature unit
    if (state.tempunit) {
      this.canSetTempUnit = true;
      // Dreo uses 1 for Fahrenheit and 2 for Celsius, convert to boolean for HomeKit
      this.tempUnit = state.tempunit.state === 1;
    } else {
      this.canSetTempUnit = false;
      this.tempUnit = false;
    }

    this.currState = this.getReportedHeaterState();

    // Get the HeaterCooler service if it exists, otherwise create a new HeaterCooler service
    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) ||
                   this.accessory.addService(this.platform.Service.HeaterCooler);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.deviceName);

    // Register handlers for the Active characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.whenOnline(this.setActive))
      .onGet(this.whenOnline(this.getActive));

    // Register handlers for Current Heater-Cooler State
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.whenOnline(this.getCurrentHeaterCoolerState));

    // Register handlers for Target Heater-Cooler State
    /**
    * 0: Auto (Dreo static heat)
    * 1: Heat (Dreo eco mode)
    * 2: Cool (Dreo fan only mode)
    */
    const targetMode = this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState);
    if (this.hideHeaterAutoMode) {
      targetMode.updateValue(this.getTargetHeaterCoolerState());
    }
    targetMode
      .onSet(this.whenOnline(this.setTargetHeaterCoolerState))
      .onGet(this.whenOnline(this.getTargetHeaterCoolerState))
      .setProps({  // We can disable modes by limiting these values
        minValue: this.hideHeaterAutoMode ? 1 : 0,
        maxValue: 2,
        validValues: this.hideHeaterAutoMode ? [1, 2] : [0, 1, 2],
      });

    // Register handlers for Current Temperature characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.whenOnline(this.getCurrentTemperature));

    // Register handlers for Heating Threshold Temperature
    let ecoRange = {startValue: 41, endValue: 95};  // Default temperature range
    // Get temperature range from Dreo control config if available (not sure why this doesn't exist for some devices)
    if (accessory.context.device.controlsConf.schedule) {
      ecoRange = accessory.context.device.controlsConf.schedule.modes.find(params => params.value === 'eco').controls[0];
    }
    this.minTemp = this.convertToCelsius(ecoRange.startValue);
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onSet(this.whenOnline(this.setHeatingThresholdTemperature))
      .onGet(this.whenOnline(this.getHeatingThresholdTemperature))
      .setProps({
        minValue: this.minTemp,
        maxValue: this.convertToCelsius(ecoRange.endValue),
        minStep: 0.5,  // We need this increment amount to create 3 speed steps for auto mode
      });

    // Register handlers for Cooling Threshold Temperature
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onSet(this.whenOnline(this.setCoolingThresholdTemperature))
      .onGet(this.whenOnline(this.getCoolingThresholdTemperature))
      .setProps({
        minValue: this.minTemp,
        maxValue: this.convertToCelsius(ecoRange.endValue),
        minStep: 0.5,
        validValues: null,
      });

    // Register handlers for Lock Physical Controls
    this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .onSet(this.whenOnline(this.setLockPhysicalControls))
      .onGet(this.whenOnline(this.getLockPhysicalControls));

    // Rotation speed (used to set oscillation angle)
    // Only show this if the fan supports setting specific oscillation angles
    if (this.canSetAngle) {
      this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .onSet(this.whenOnline(this.setRotationSpeed))
        .onGet(this.whenOnline(this.getRotationSpeed))
        .setProps({
          minStep: 50,
        });
    }

    // Temperature display units
    if (this.canSetTempUnit) {
      this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
        .onSet(this.whenOnline(this.setTemperatureDisplayUnits))
        .onGet(this.whenOnline(this.getTemperatureDisplayUnits));
    }

    // Swing mode
    if (this.canSwing) {
      this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.whenOnline(this.setSwingMode))
        .onGet(this.whenOnline(this.getSwingMode));
    }


    // Update values from Dreo app
    platform.webHelper.addEventListener('message', message => {
      const data = JSON.parse(message.data);

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        if (!this.online) {
          this.cancelPendingPowerOn();
        }
        if (!this.online || data.method === 'device-online') {
          this.sentEcoSetpoint = undefined;
        }

        // Check if we need to update fan state in homekit
        if (data.method === 'control-report' || data.method === 'control-reply' || data.method === 'report' ||
          data.method === 'device-online') {
          Object.keys(data.reported).forEach(key => {
            switch(key) {
              case 'poweron':
                if (this.guardHeaterPower && data.method === 'control-reply') {
                  break;
                }
                this.on = data.reported.poweron;
                if (!this.on) {
                  this.shuttingOff = false;
                }
                this.service.getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.on);
                this.platform.log.debug('Heater power:', data.reported.poweron);
                // Update Heater-Cooler State
                this.updateHeaterState();
                break;
              case 'mode':
                this.mode = data.reported.mode;
                if (this.mode === 'coolair' && data.method !== 'control-reply') {
                  this.fanOnlyRequested = false;
                }
                if (this.hideHeaterAutoMode) {
                  targetMode.updateValue(this.getTargetHeaterCoolerState());
                }
                this.platform.log.debug('Heater mode:', data.reported.mode);
                // Swap to custom thermostat mode if in 'hotair' mode
                this.updateThermostatTemp();
                // Update Heater-Cooler State
                this.updateHeaterState();
                break;
              case 'childlockon':
                this.childLockOn = data.reported.childlockon;
                this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
                  .updateValue(this.childLockOn);
                this.platform.log.debug('Child lock:', data.reported.childlockon);
                break;
              case 'temperature':
                this.temperature = this.convertToCelsius(data.reported.temperature);
                this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
                  .updateValue(this.temperature);
                this.platform.log.debug('Heater temperature:', data.reported.temperature);
                break;
              case 'ecolevel':
                if (this.guardHeaterPower && data.method === 'control-reply') {
                  break;
                }
                this.targetTemperature = this.convertToCelsius(data.reported.ecolevel);
                if (data.reported.ecolevel === this.sentEcoSetpoint) {
                  this.sentEcoSetpoint = undefined;
                }
                this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
                  .updateValue(this.guardHeaterPower ? this.getHeatingThresholdTemperature() : this.targetTemperature);
                if (this.mode === 'eco') {
                  this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
                    .updateValue(this.getCoolingThresholdTemperature());
                }
                this.platform.log.debug('Heater target temperature:', data.reported.ecolevel);
                break;
              case 'ptcon':
                this.ptcon = data.reported.ptcon;
                this.updateHeaterState();
                this.platform.log.debug('Heating active:', this.currState);
                break;
              case 'htalevel':
                this.heatLevel = data.reported.htalevel;
                this.updateThermostatTemp();
                this.platform.log.debug('Heater fixed level:', data.reported.htalevel);
                break;
              case 'oscangle':
                if (data.reported.oscangle === 0) {
                  this.swing = true;
                } else {
                  this.oscAngle = this.oscMap[data.reported.oscangle];  // Convert to percentage
                  this.swing = false;
                  this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
                    .updateValue(this.oscAngle);
                }
                this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.swing);
                this.platform.log.debug('Heater oscillation angle:', data.reported.oscangle);
                break;
              case 'oscon':
                this.swing = data.reported.oscon;
                this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.swing);
                this.platform.log.debug('Heater oscillation:', data.reported.oscon);
                break;
              case 'tempunit':
                this.tempUnit = data.reported.tempunit === 1;
                this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
                  .updateValue(this.tempUnit);
                this.platform.log.debug('Temperature unit:', data.reported.tempunit);
                break;
              default:
                this.platform.log.debug('Unknown command received:', key);
            }
          });
          this.applySavedEcoSetpoint();
        }
      }
    });
    this.applySavedEcoSetpoint();
  }

  // Handle requests to set the "Active" characteristic
  setActive(value) {
    this.platform.log.debug('Triggered SET Active:', value);
    if (this.guardHeaterPower) {
      if (!value) {
        this.cancelPendingPowerOn();
        this.shuttingOff = true;
        this.platform.webHelper.control(this.sn, {'poweron': false});
      } else if ((!this.on || this.shuttingOff) && !this.pendingPowerOn) {
        if (this.hasRecentTemperatureWrite()) {
          this.publishConfirmedOff();
        } else {
          this.holdPowerOn();
        }
      }
      return;
    }
    // Check state to prevent duplicate requests
    if (this.on !== Boolean(value)) {
      // Send to Dreo server via websocket
      this.platform.webHelper.control(this.sn, {'poweron': Boolean(value)});
    }
  }

  private holdPowerOn() {
    let pending = HeaterAccessory.pendingStarts.get(this.platform);
    if (!pending) {
      pending = new Set();
      HeaterAccessory.pendingStarts.set(this.platform, pending);
    }
    pending.add(this);
    this.pendingPowerOn = setTimeout(() => {
      this.cancelPendingPowerOn();
      if (this.online && (!this.on || this.shuttingOff)) {
        this.platform.webHelper.control(this.sn, {'poweron': true});
      }
    }, HEATER_COMMAND_WINDOW_MS);
  }

  private cancelPendingPowerOn() {
    if (this.pendingPowerOn !== undefined) {
      clearTimeout(this.pendingPowerOn);
      this.pendingPowerOn = undefined;
      HeaterAccessory.pendingStarts.get(this.platform)?.delete(this);
    }
  }

  private publishConfirmedOff() {
    // HomeKit caches the requested value after the write handler finishes.
    setImmediate(() => {
      if (this.online && !this.on && !this.pendingPowerOn) {
        this.service.getCharacteristic(this.platform.Characteristic.Active).updateValue(false);
      }
    });
  }

  private hasRecentTemperatureWrite() {
    const last = HeaterAccessory.lastTemperatureWrite.get(this.platform);
    return last !== undefined && performance.now() - last <= HEATER_COMMAND_WINDOW_MS;
  }

  // Handle requests to get the current value of the "Active" characteristic
  getActive() {
    return this.on;
  }

  // Handle requests for Current Heater-Cooler State
  getCurrentHeaterCoolerState() {
    return this.currState;
  }

  // Handle requests for Target Heater-Cooler State
  // More details: https://developers.homebridge.io/#/characteristic/TargetHeaterCoolerState
  setTargetHeaterCoolerState(value) {
    this.platform.log.debug('Triggered SET TargetHeaterCoolerState:', value);
    if (value === 1) {
      this.fanOnlyRequested = false;
      this.platform.webHelper.control(this.sn, {'mode': 'eco'});
    } else if (value === 2) {
      this.fanOnlyRequested = true;
      this.platform.webHelper.control(this.sn, {'mode': 'coolair'});
    } else if (value === 0 && !this.hideHeaterAutoMode) {
      this.fanOnlyRequested = false;
      this.platform.webHelper.control(this.sn, {'mode': 'hotair'});
    }
  }

  getTargetHeaterCoolerState() {
    if (this.mode === 'coolair') {
      return 2;
    }
    return this.mode === 'eco' || this.hideHeaterAutoMode ? 1 : 0;
  }

  // Handle requests for Current Temperature
  getCurrentTemperature() {
    return this.temperature;
  }

  // Handle requests for Heating Threshold Temperature
  setHeatingThresholdTemperature(value) {
    if (this.isFanOnlyTarget()) {
      this.setCoolingThresholdTemperature(value);
      return;
    }
    if (this.guardHeaterPower) {
      this.recordTemperatureWrite();
      if (!this.on || this.shuttingOff ||
        (this.mode === 'eco' && this.accessory.context.savedHeaterEcoSetpoint !== undefined)) {
        this.accessory.context.savedHeaterEcoSetpoint = this.convertToFahrenheit(value);
        this.platform.api.updatePlatformAccessories([this.accessory]);
        this.applySavedEcoSetpoint();
        return;
      }
    }
    if (this.mode === 'eco') {
      this.platform.webHelper.control(this.sn, {'ecolevel': this.convertToFahrenheit(value)});
    } else if (!this.hideHeaterAutoMode) {
      /**
       * Dreo uses a fixed range of 1-3 for heat level
       * We'll map the bottom 3 degree increments of the fan to these levels
       * So if the minTemp is 5C, {5: 1, 5.5: 2, 6: 3}
       */
      value = ((value - this.minTemp) * 2) + 1;
      value = Math.min(value, 3);  // Ensure speed is within range
      this.platform.webHelper.control(this.sn, {'htalevel': value});
    }
  }

  getHeatingThresholdTemperature() {
    if (this.isFanOnlyTarget()) {
      return this.getCoolingThresholdTemperature();
    }
    const saved = this.accessory.context.savedHeaterEcoSetpoint;
    if (this.guardHeaterPower && Number.isFinite(saved) && (!this.on || this.shuttingOff || this.mode === 'eco')) {
      return this.convertToCelsius(saved);
    }
    if (this.mode === 'eco' || this.hideHeaterAutoMode) {
      return this.targetTemperature;
    } else {
      return ((this.heatLevel - 1) / 2) + this.minTemp;
    }
  }

  private applySavedEcoSetpoint() {
    if (!this.guardHeaterPower) {
      return;
    }
    if (!this.online || !this.on || this.shuttingOff || this.mode !== 'eco' || this.fanOnlyRequested) {
      this.sentEcoSetpoint = undefined;
      return;
    }
    const saved = this.accessory.context.savedHeaterEcoSetpoint;
    if (!Number.isFinite(saved) || this.sentEcoSetpoint !== undefined) {
      return;
    }
    if (saved === this.convertToFahrenheit(this.targetTemperature)) {
      delete this.accessory.context.savedHeaterEcoSetpoint;
      this.platform.api.updatePlatformAccessories([this.accessory]);
      return;
    }
    this.sentEcoSetpoint = saved;
    this.platform.webHelper.control(this.sn, {'ecolevel': saved});
  }

  private recordTemperatureWrite() {
    HeaterAccessory.lastTemperatureWrite.set(this.platform, performance.now());
    HeaterAccessory.pendingStarts.get(this.platform)?.forEach(heater => {
      heater.cancelPendingPowerOn();
      heater.publishConfirmedOff();
    });
  }

  // Dreo fan-only mode has no hardware setpoint. Keep the HomeKit target locally.
  setCoolingThresholdTemperature(value) {
    if (this.mode === 'eco' && !this.fanOnlyRequested) {
      this.setHeatingThresholdTemperature(value);
      return;
    }
    if (this.guardHeaterPower) {
      this.recordTemperatureWrite();
    }
    if (value !== this.accessory.context.fanOnlyTargetTemperature) {
      this.accessory.context.fanOnlyTargetTemperature = value;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }

  getCoolingThresholdTemperature() {
    if (this.mode === 'eco' && !this.fanOnlyRequested) {
      return this.getHeatingThresholdTemperature();
    }
    const target = this.accessory.context.fanOnlyTargetTemperature;
    return Number.isFinite(target) ? target : this.minTemp + 8;
  }

  private isFanOnlyTarget() {
    return this.mode === 'coolair' || this.fanOnlyRequested;
  }

  // Turn child lock on/off
  setLockPhysicalControls(value) {
    this.platform.webHelper.control(this.sn, {'childlockon': Boolean(value)});
  }

  getLockPhysicalControls() {
    return this.childLockOn;
  }

  // Handle requests for Rotation Speed
  setRotationSpeed(value) {
    this.platform.webHelper.control(this.sn, {'oscangle': this.oscMap[value]});
  }

  getRotationSpeed() {
    return this.oscAngle;
  }

  // Handle requests for Temperature Display Units
  setTemperatureDisplayUnits(value) {
    this.platform.webHelper.control(this.sn, {'tempunit': value === 1 ? 1 : 2});
  }

  getTemperatureDisplayUnits() {
    return this.tempUnit;
  }

  // Handle requests for Swing Mode
  setSwingMode(value) {
    if (this.canSetAngle) {
      // If fan supports setting specific angles, we need to set angle to 0 for oscillation mode
      if (value === 1) {
        this.platform.webHelper.control(this.sn, {'oscangle': 0});
      } else {
        this.platform.webHelper.control(this.sn, {'oscangle': this.oscMap[this.oscAngle]});
      }
    } else {
      // Fan only supports on/off oscillation toggle
      this.platform.webHelper.control(this.sn, {'oscon': value});
    }
  }

  getSwingMode() {
    return this.swing;
  }

  // Helper function that determines heater state for HomeKit based on Dreo values
  updateHeaterState() {
    this.currState = this.getReportedHeaterState();
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .updateValue(this.currState);
  }

  private getReportedHeaterState() {
    if (this.mode === 'coolair') {
      return 3;
    }
    return Number(this.ptcon) + Number(this.on);
  }

  updateThermostatTemp() {
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .updateValue(this.getCoolingThresholdTemperature());
    if (this.hideHeaterAutoMode || this.mode === 'coolair') {
      this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .updateValue(this.getHeatingThresholdTemperature());
    } else if (this.mode === 'eco') {
      this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .updateValue(this.targetTemperature);
    } else if (this.mode === 'hotair') {
      const dispValue = ((this.heatLevel - 1) / 2) + this.minTemp;
      this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .updateValue(dispValue);
    }
  }

  convertToCelsius(temperatureFromDreo) {
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return (temperatureFromDreo - 32) * 5 / 9;
  }

  convertToFahrenheit(temperatureFromHomeKit) {
    // Dreo expects temperature in Fahrenheit for some reason
    return Math.round((temperatureFromHomeKit * 9 / 5) + 32);
  }
}

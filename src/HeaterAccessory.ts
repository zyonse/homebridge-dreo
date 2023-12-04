import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class HeaterAccessory {
  private service: Service;

  // Cached copy of latest fan states
  private heaterState = {
    On: false,
    Temperature: 0,
    TargetTemperature: 0,
    TempUnit: 1, // 1 = Fahrenheit, 0 = Celsius
    Mode: 'eco',
  };

  constructor(
    private readonly platform: DreoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly state,
    private readonly ws,
  ) {
    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        accessory.context.device.brand,
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        accessory.context.device.model,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        accessory.context.device.sn,
      );

    // initialize fan values
    // get max fan speed from config
    platform.log.debug('State:', state);
    // load current state from Dreo servers
    this.heaterState.On = state.poweron.state;
    this.heaterState.Mode = state.mode.state;
    this.heaterState.Temperature = state.temperature.state;
    this.heaterState.TargetTemperature = state.ecolevel.state;
    this.heaterState.TempUnit = state.tempunit.state;

    // get the Thermostat service if it exists, otherwise create a new Thermostat service
    // you can create multiple services for each accessory
    this.service =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.deviceName,
    );

    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
      )
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minStep: 1,
      })
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    // update values from Dreo app
    ws.addEventListener('message', (message) => {
      const data = JSON.parse(message.data);

      // check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // check if we need to update fan state in homekit
        if (
          data.method === 'control-report' ||
          data.method === 'control-reply' ||
          data.method === 'report'
        ) {
          switch (Object.keys(data.reported)[0]) {
            case 'temperature':
              this.heaterState.Temperature = data.reported.temperature;
              this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
                .updateValue(this.heaterState.TargetTemperature);
              this.platform.log.debug('Heater temp:', data.reported.temperate);
              break;
            case 'ecolevel':
              this.heaterState.TargetTemperature = data.reported.ecolevel;
              this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
                .updateValue(this.heaterState.TargetTemperature);
              this.platform.log.debug(
                'Heater target temp:',
                data.reported.ecolevel,
              );
              break;
            case 'poweron':
              this.heaterState.On = data.reported.poweron;
              this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
                .updateValue(this.heaterState.On);
              this.platform.log.debug('Heater on:', data.reported.poweron);
              break;
            default:
              platform.log.debug(
                'Unknown command received:',
                Object.keys(data.reported)[0],
              );
          }
        }
      }
    });
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet() {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    // set this to a valid value for CurrentHeatingCoolingState
    switch (this.heaterState.On) {
      case false:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
      case true:
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        break;
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
    }
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    // set this to a valid value for CurrentHeatingCoolingState
    switch (this.heaterState.On) {
      case false:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
      case true:
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        break;
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
    }
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value) {
    let state;
    switch (value) {
      case this.platform.Characteristic.CurrentHeatingCoolingState.OFF:
        state = false;
        break;
      case this.platform.Characteristic.CurrentHeatingCoolingState.HEAT:
        state = true;
        break;
      default:
        state = false;
        break;
    }
    this.ws.send(
      JSON.stringify({
        devicesn: this.accessory.context.device.sn,
        method: 'control',
        params: { poweron: state },
        timestamp: Date.now(),
      }),
    );
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.platform.log.debug('Triggered GET CurrentTemperature');
    switch (this.heaterState.TempUnit) {
      case 1:
        return this.fahrenheitToCelsius(this.heaterState.Temperature);
      case 0:
        return this.heaterState.Temperature;
      default:
        return this.fahrenheitToCelsius(this.heaterState.Temperature);
    }
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    this.platform.log.debug('Triggered GET TargetTemperature');

    switch (this.heaterState.TempUnit) {
      case 1:
        return this.fahrenheitToCelsius(this.heaterState.TargetTemperature);
      case 0:
        return this.heaterState.Temperature;
      default:
        return this.fahrenheitToCelsius(this.heaterState.TargetTemperature);
    }
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value) {
    switch (this.heaterState.TempUnit) {
      case 1:
        value = this.celsiusToFahrenheit(value);
        break;
      case 0:
        break;
    }

    this.ws.send(
      JSON.stringify({
        devicesn: this.accessory.context.device.sn,
        method: 'control',
        params: { ecolevel: value },
        timestamp: Date.now(),
      }),
    );
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');

    switch (this.heaterState.TempUnit) {
      case 1:
        return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
      case 0:
        return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
      default:
        return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value) {
    this.ws.send(
      JSON.stringify({
        devicesn: this.accessory.context.device.sn,
        method: 'control',
        params: { tempunit: value },
        timestamp: Date.now(),
      }),
    );
  }

  fahrenheitToCelsius(value) {
    return (value - 32) / 1.8;
  }

  celsiusToFahrenheit(value) {
    return (value * 1.8) + 32;
  }
}

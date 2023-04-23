import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { DreoPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private exampleStates = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: DreoPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.deviceName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Fanv2
    // register handlers for the Active Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleActiveSet.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.handleActiveGet.bind(this));               // GET - bind to the `getOn` method below

    // register handlers for the RotationSpeed Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this));       // SET - bind to the 'setBrightness` method below
  }

  // Handle requests to set the "Active" characteristic
  handleActiveSet(value) {
    this.platform.log.debug('Triggered SET Active:', value);
  }

  // Handle requests to get the current value of the "Active" characteristic
  handleActiveGet() {
    this.platform.log.debug('Triggered GET Active');

    // set this to a valid value for Active
    const currentValue = 1;

    return currentValue;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setRotationSpeed(value: CharacteristicValue) {
    // implement code to set the speed
    this.exampleStates.Brightness = value as number;

    this.platform.log.debug('Set Rotation Speed -> ', value);
  }

}

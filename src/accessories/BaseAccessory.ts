import { PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';

export abstract class BaseAccessory {
  protected readonly sn = this.accessory.context.sn;

  constructor(
    protected readonly platform: DreoPlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    // Set accessory information
    accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);
  }

  // Abstract methods that derived classes must implement
  abstract setActive(value: boolean): void;
  abstract getActive(): boolean;
}
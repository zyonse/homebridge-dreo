import type { PlatformAccessory } from 'homebridge' with { 'resolution-mode': 'import' };
import { DreoPlatform } from '../platform';

interface DreoDevice {
  brand: string;
  model: string;
  seriesName?: string;
  sn: string;
}

export abstract class BaseAccessory {
  protected readonly sn: string;

  constructor(
    protected readonly platform: DreoPlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    this.sn = this.accessory.context.device.sn;

    // Set accessory information
    accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, this.getDisplayModel(accessory.context.device))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);
  }

  /**
   * Generate user-friendly model name based on series information
   * For example: DR-HHM001S with seriesName "HM311S/411S" becomes "DR-HM311S"
   */
  private getDisplayModel(device: DreoDevice): string {
    const originalModel = device.model;
    const seriesName = device.seriesName;

    // If no series name available, use original model
    if (!seriesName) {
      return originalModel;
    }

    // Extract the main series model from seriesName (e.g., "HM311S" from "HM311S/411S")
    const seriesMatch = seriesName.match(/^([^/]+)/);
    if (!seriesMatch) {
      return originalModel;
    }

    const mainSeriesModel = seriesMatch[1]; // e.g., "HM311S"

    // For humidifiers, construct DR-HM + series number
    if (originalModel.startsWith('DR-HHM')) {
      return `DR-${mainSeriesModel}`; // e.g., "DR-HM311S"
    }

    // For other device types, you could add similar logic
    // For now, return original model for non-humidifier devices
    return originalModel;
  }

  // Abstract methods that derived classes must implement
  abstract setActive(value: boolean): void;
  abstract getActive(): boolean;
}

import { PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';

interface DreoDevice {
  brand: string;
  model: string;
  seriesName?: string;
  sn: string;
}

export abstract class BaseAccessory {
  protected readonly sn = this.accessory.context.device.sn;

  // Whether the Dreo cloud reports the device as connected. While offline, every HomeKit read/write
  // fails with SERVICE_COMMUNICATION_FAILURE so the Home app shows the accessory as "No Response".
  protected online = true;

  constructor(
    protected readonly platform: DreoPlatform,
    protected readonly accessory: PlatformAccessory,
    state?: { connected?: { state?: boolean } },
  ) {
    // Initial connection status from the device state API (assume online if the field is missing)
    this.online = state?.connected?.state ?? true;
    if (!this.online) {
      this.platform.log.warn('%s is offline', accessory.displayName);
    }

    // Track connection changes pushed over the WebSocket
    platform.webHelper.addEventListener('message', (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data?.devicesn !== this.sn) {
        return;
      }
      // Dreo sends 'device-offline' with an empty payload, and 'device-online' with a full state
      // snapshot (including connected: true). Other reports may also carry the connected flag.
      if (data.method === 'device-offline') {
        this.setOnline(false);
      } else if (data.method === 'device-online') {
        this.setOnline(true);
      } else if (typeof data.reported?.connected === 'boolean') {
        this.setOnline(data.reported.connected);
      }
    });

    // Set accessory information
    accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, this.getDisplayModel(accessory.context.device))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);
  }

  // Wrap an onGet/onSet handler so it fails with "No Response" while the device is offline
  protected whenOnline<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      if (!this.online) {
        throw this.communicationFailure();
      }
      return handler.apply(this, args);
    };
  }

  private communicationFailure() {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private setOnline(online: boolean) {
    if (online === this.online) {
      return;
    }
    this.online = online;
    if (online) {
      this.platform.log.info('%s is back online', this.accessory.displayName);
    } else {
      this.platform.log.warn('%s is offline', this.accessory.displayName);
    }

    // Push the new status to HomeKit right away rather than waiting for the next read
    for (const service of this.accessory.services) {
      if (service.UUID === this.platform.Service.AccessoryInformation.UUID) {
        continue;
      }
      for (const characteristic of service.characteristics) {
        // updateValue(error) marks the characteristic as failed; updating with the cached value clears it
        characteristic.updateValue(online ? characteristic.value : this.communicationFailure());
      }
    }
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

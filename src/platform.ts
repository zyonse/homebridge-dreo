import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { FanAccessory } from './FanAccessory';
import DreoAPI from './DreoAPI';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class DreoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly webHelper = new DreoAPI(this);

  // This is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');
      // Run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // Add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Log into Dreo services, retrieve the user's devices, and register them as accessories
   * Also remove accessories that are no longer present on the user's account
   */
  async discoverDevices() {
    // Validate config values
    if (this.config.options.email === undefined || this.config.options.password === undefined) {
      this.log.error('error: Invalid email and/or password');
      return;
    }

    // Request access token from Dreo server
    let auth = await this.webHelper.authenticate();
    // Check if access_token is valid
    if (auth === undefined) {
      this.log.error('Authentication error: Failed to obtain access_token');
      return;
    }
    this.log.info('Country:', auth.countryCode);
    this.log.info('Region:', auth.region);

    // Re-authenticate with EU server if european account is detected
    if (auth.region === 'EU') {
      this.webHelper.server = 'eu';
      auth = await this.webHelper.authenticate();
    } else if (auth.region !== 'NA') {
      this.log.error('error, unknown region');
      this.log.error('Please open a github issue and provide your Country and Region (shown above)');
      return;
    }

    // Use access token to retrieve user's devices
    const dreoDevices = await this.webHelper.getDevices();

    // Mask sensitive information and print the device list
    const maskedDevices = dreoDevices.map(device => ({
      ...device,
      sn: '********',
      deviceId: '********',
    }));
    this.log.debug('\n\nDevices:\n', maskedDevices);

    // Check for device list
    if (dreoDevices === undefined) {
      this.log.error('error: Failed to retrieve device list');
      return;
    }

    // Create a set of UUIDs for the currently discovered devices
    const discoveredDeviceUUIDs = new Set(dreoDevices.map(device => this.api.hap.uuid.generate(device.sn)));

    // Unregister accessories that are no longer present
    const accessoriesToRemove = this.accessories.filter(accessory => !discoveredDeviceUUIDs.has(accessory.UUID));
    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
      this.log.info('Removing accessories:', accessoriesToRemove.map(accessory => accessory.displayName).join(', '));
    }

    // Open WebSocket (used to control devices later)
    await this.webHelper.startWebSocket();

    // Loop over the discovered devices and register each one if it has not already been registered
    for (const device of dreoDevices) {
      // Print device info:
      this.log.debug('Control parameters: ', JSON.stringify(device.controlsConf.control, null, 2));

      // Generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.sn);

      // See if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      // Get initial device state
      const state = await this.webHelper.getState(device.sn);
      if (state === undefined) {
        this.log.error('error: Failed to retrieve device state');
        return;
      }
      this.log.debug('Accessory state:', state);

      if (existingAccessory) {
        // The accessory already exists
        this.log.info('Restoring existing accessory from cache:', device.deviceName);

        // If you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // Create the accessory handler for the restored accessory
        // This is imported from `platformAccessory.ts`

        // If windlevel exists, infer that the device is a fan
        if (state.windlevel !== undefined) {
          new FanAccessory(this, existingAccessory, state);
        } else {
          this.log.error('error: Unsupported device type ', device.productName);
        }

        // It is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // The accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.deviceName);

        // Create a new accessory
        const accessory = new this.api.platformAccessory(device.deviceName, uuid);

        // Store a copy of the device object in the `accessory.context`
        // The `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // Create the accessory handler for the newly create accessory
        // This is imported from `platformAccessory.ts`

        if (state.windlevel !== undefined) {
          new FanAccessory(this, accessory, state);
        } else {
          this.log.error('error, unknown device type:', device.productName);
        }

        // Link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}

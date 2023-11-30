import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { FanAccessory } from './FanAccessory';
import { HeaterAccessory } from './HeaterAccessory';
import DreoAPI from './DreoAPI';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class DreoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
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
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const email = this.config.options.email;
    const password = this.config.options.password;

    // check for config values
    if (email === undefined || password === undefined) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        this.accessories,
      );
      this.log.error('error: Invalid email and/or password');
      return;
    }

    // request access token from Dreo server
    let auth = await new DreoAPI().authenticate(this, email, password, 'us');
    this.log.debug('\n\nREMOTE:\n', auth);
    // check if access_token is valid
    if (auth === undefined) {
      this.log.error('Authentication error: Server returned invalid access_token');
      this.log.error('Make sure your email/password are correct');
      return;
    }
    this.log.info('Country:', auth.countryCode);
    this.log.info('Region:', auth.region);

    if (auth.region === 'NA') {
      auth.server = 'us';
    } else if (auth.region === 'EU') {
      auth = await new DreoAPI().authenticate(this, email, password, 'eu');
      auth.server = 'eu';
    } else {
      this.log.error('error, unknown region');
      this.log.error('Please open a github issue and provide your Country and Region (shown above)');
      return;
    }

    // use access token to retrieve user's devices
    const dreoDevices = await new DreoAPI().getDevices(this, auth);
    this.log.debug('\n\nDEVICES:\n', dreoDevices);
    // check for device list
    if (dreoDevices === undefined) {
      return;
    }

    // open WebSocket (used to control devices later)
    const ws = await new DreoAPI().startWebSocket(this, auth);

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of dreoDevices) {

      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.sn);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      // get initial device state
      const state = await new DreoAPI().getState(this, device.sn, auth);
      if (state === undefined) {
        this.log.error('error, could not retrieve device state');
        return;
      }

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', device.deviceName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        switch (device.productName) {
          case 'Tower Fan':
          case 'Air Circulator':
            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new FanAccessory(this, existingAccessory, state, ws);
            break;
          case 'Heater':
            new HeaterAccessory(this, existingAccessory, state, ws);
            break;
          default:
            this.log.error('error, unknown device type');
        }

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.deviceName);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.deviceName, uuid);

        this.log.info('Added new accessory:', device.deviceName);
        this.log.info('With UUID:', uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        switch (device.productName) {
          case 'Tower Fan':
          case 'Air Circulator':
            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new FanAccessory(this, accessory, state, ws);
            break;
          case 'Heater':
            new HeaterAccessory(this, accessory, state, ws);
            break;
          default:
            this.log.error('error, unknown device type');
        }

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}

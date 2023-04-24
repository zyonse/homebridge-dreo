import { Service, PlatformAccessory} from 'homebridge';

import { DreoPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory {
  private service: Service;

  // Cached copy of latest fan states
  private fanState = {
    On: false,  //TODO initialize properly
    Speed: 1,
    Swing: 0,
  };

  constructor(
    private readonly platform: DreoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ws,
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
      .onSet(this.handleActiveSet.bind(this))
      .onGet(this.handleActiveGet.bind(this));

    // register handlers for the RotationSpeed Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))       // SET - bind to the 'setBrightness` method below
      .onGet(this.getRotationSpeed.bind(this));

    // update values from Dreo app
    ws.addEventListener('message', message => {
      const data = JSON.parse(message.data);

      // check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // check if we need to update fan state in homekit
        if (data.method === 'control-report' || data.method === 'control-reply' || data.method === 'report') {
          switch(Object.keys(data.reported)[0]) {
            case 'poweron':
              this.fanState.On = data.reported.poweron;
              break;
            case 'windlevel':
              if (data.method === 'report') {
                this.fanState.Speed = data.reported.windlevel / 6 * 100;
              }
              break;
            case 'shakehorizon':
              this.fanState.Swing = data.reported.shakehorizon;
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
    this.ws.send(JSON.stringify({
      'devicesn': this.accessory.context.device.sn,
      'method': 'control',
      'params': {'poweron': Boolean(value)},
      'timestamp': Date.now(),
    }));
  }

  // Handle requests to get the current value of the "Active" characteristic
  handleActiveGet() {
    return this.fanState.On;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setRotationSpeed(value) {
    // implement code to set the speed
    const curr = Math.ceil(this.fanState.Speed / 100 * 6);
    const converted = Math.ceil(value / 100 * 6);
    if (curr !== converted) {
      this.platform.log.debug('Setting fan speed:', converted);
      this.ws.send(JSON.stringify({
        'devicesn': this.accessory.context.device.sn,
        'method': 'control',
        'params': {'windlevel': converted},
        'timestamp': Date.now(),
      }));
    }
    this.fanState.Speed = value;
  }

  async getRotationSpeed() {
    return this.fanState.Speed;
  }

}

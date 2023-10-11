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
    On: false,
    Speed: 1,
    Swing: false,
    SwingMethod: 'shakehorizon',  // some fans use hoscon instead of shakehorizon to control swing mode
    MaxSpeed: 1,
  };

  constructor(
    private readonly platform: DreoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly state,
    private readonly ws,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.brand)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.sn);

    // initialize fan values
    // get max fan speed from config
    this.fanState.MaxSpeed = accessory.context.device.controlsConf.control[1].items[1].text;
    platform.log.debug('State:', state);
    // load current state from Dreo servers
    this.fanState.On = state.poweron.state;
    this.fanState.Speed = state.windlevel.state * 100 / this.fanState.MaxSpeed;

    // get the Fanv2 service if it exists, otherwise create a new Fanv2 service
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
      .setProps({
        // setting minStep defines fan speed steps in HomeKit
        minStep: 100 / this.fanState.MaxSpeed,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // check whether fan supports oscillation
    if (state.shakehorizon !== undefined || state.hoscon !== undefined) {
      // some fans use different commands to toggle oscillation, determine which one should be used
      if (state.hoscon !== undefined) {
        this.fanState.SwingMethod = 'hoscon';
      }
      // register handlers for Swing Mode (oscillation)
      this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.setSwingMode.bind(this))
        .onGet(this.getSwingMode.bind(this));
      this.fanState.Swing = state.shakehorizon.state;
    }

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
              this.service.getCharacteristic(this.platform.Characteristic.Active).updateValue(this.fanState.On);
              this.platform.log.debug('Fan power:', data.reported.poweron);
              break;
            case 'windlevel':
              this.fanState.Speed = data.reported.windlevel * 100 / this.fanState.MaxSpeed;
              this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(this.fanState.Speed);
              this.platform.log.debug('Fan speed:', data.reported.windlevel);
              break;
            case 'shakehorizon':
              this.fanState.Swing = data.reported.shakehorizon;
              this.service.getCharacteristic(this.platform.Characteristic.SwingMode).updateValue(this.fanState.Swing);
              this.platform.log.debug('Oscillation mode:', data.reported.shakehorizon);
              break;
            case 'hoscon':
              this.fanState.Swing = data.reported.hoscon;
              this.service.getCharacteristic(this.platform.Characteristic.SwingMode).updateValue(this.fanState.Swing);
              this.platform.log.debug('Oscillation mode:', data.reported.hoscon);
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
    // check state to prevent duplicate requests
    if (this.fanState.On !== Boolean(value)) {
      // send to Dreo server via websocket
      this.ws.send(JSON.stringify({
        'devicesn': this.accessory.context.device.sn,
        'method': 'control',
        'params': {'poweron': Boolean(value)},
        'timestamp': Date.now(),
      }));
    }
  }

  // Handle requests to get the current value of the "Active" characteristic
  handleActiveGet() {
    return this.fanState.On;
  }

  // Handle requests to set the fan speed
  async setRotationSpeed(value) {
    // rotation speed needs to be scaled from HomeKit's percentage value (Dreo app uses whole numbers, ex. 1-6)
    const converted = Math.round(value * this.fanState.MaxSpeed / 100);
    // avoid setting speed to 0 (illegal value)
    if (converted !== 0) {
      this.platform.log.debug('Setting fan speed:', converted);
      this.ws.send(JSON.stringify({
        'devicesn': this.accessory.context.device.sn,
        'method': 'control',
        'params': {
          // setting poweron to true prevents fan speed from being overriden
          'poweron': true,
          'windlevel': converted,
        },
        'timestamp': Date.now(),
      }));
    }
  }

  async getRotationSpeed() {
    return this.fanState.Speed;
  }

  // turn oscillation on/off
  async setSwingMode(value) {
    this.ws.send(JSON.stringify({
      'devicesn': this.accessory.context.device.sn,
      'method': 'control',
      'params': {[this.fanState.SwingMethod]: Boolean(value)},
      'timestamp': Date.now(),
    }));
  }

  async getSwingMode() {
    return this.fanState.Swing;
  }
}

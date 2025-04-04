/* eslint-disable */
import { PlatformAccessory, Service } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

interface DreoStateReport {
  poweron?: boolean;      // Active
  mode?: number;          // Mode 0-2 [manual, auto, sleep]
  suspend?: boolean;      // Suspended
  rh?: number;            // Current humidity
  hotfogon?: boolean;     // Hot fog on
  foglevel?: number;      // Fog level 0-6 [0: off, 1-6: levels]
  rhautolevel?: number;   // Target humidity level in auto mode
  rhsleeplevel?: number;  // Target humidity level in sleep mode
  ledlevel?: number;      // LED indicator level 0-2 [off, low, high]
  rgblevel?: string;      // RGB display level 0-2 [off, low, high]
  muteon?: boolean;       // Beep on/off
  wrong?: number;         // Error code 0-1 [0: no error, 1: no water]
  worktime?: number;      // Work time in minutes after last cleaning
}

interface DreoMessage {
  devicesn?: string;      // Device serial number
  method?: string;        // API method (e.g., control-report, control-reply, report)
  reported?: DreoStateReport; // Reported state of the device
}

interface DreoState {
  poweron: {state: boolean};
  mode: {state: number};
  suspend: {state: boolean};
  rh: {state: number};
  hotfogon: {state: boolean};
  ledlevel: {state: number};
  rgblevel: {state: string};
  foglevel: {state: number};
  rhautolevel: {state: number};
  rhsleeplevel: {state: number};
  wrong: {state: number};
}

const MAX_HUMIDITY = 90.0; // Maximum humidity level for HomeKit.
const MIN_HUMIDITY = 30.0; // Minimum humidity level for HomeKit.
const DEFAULT_HUMIDITY = 45.0; // Default humidity level for HomeKit if not specified.

export class HumidifierAccessory extends BaseAccessory {
  private readonly humidifierService: Service;
  private readonly humidityService: Service;
  private readonly sleepSwitchService: Service;
  private readonly hotFogSwitchService: Service;

  // Cached copy of latest device states
  private on: boolean;        // poweron
  private deroMode: number;   // mode 0-2       [manual, auto, sleep]
  private suspended: boolean; // suspend
  private currentHum: number; // rh
  private fogHot: boolean;    // hotfogon
  private ledLevel: number;   // ledlevel 0-2   [off, low, high]
  private rgbLevel: string;   // rgblevel 0-2   [off, low, high]
  private wrong: number;      // wrong 0-1      [0: no error, 1: no water]

  private manualFogLevel: number;         // foglevel 0-6   [1-, 1, 2-, 2, 3-, 3]
  private targetHumAutoLevel: number;     // rhautolevel
  private targetHumSleepLevel: number;    // rhsleeplevel

  // HomeKit
  private currState: number;  // State in HomeKit {0: inactive, 1: idle, 2: humidifying, 3: dehumidifying}

  constructor(
    readonly platform: DreoPlatform,
    readonly accessory: PlatformAccessory,
    private readonly state: DreoState,
  ) {
    // Call base class constructor
    super(platform, accessory);

    // Update current state in homebridge from Dreo API
    this.on = state.poweron.state;
    this.deroMode = state.mode.state;
    this.suspended = state.suspend.state;
    this.currentHum = state.rh.state;
    this.fogHot = state.hotfogon.state || false;
    this.ledLevel = state.ledlevel.state;
    this.rgbLevel = state.rgblevel.state;
    this.wrong = state.wrong.state || 0;
    this.manualFogLevel = state.foglevel.state || 0;
    this.targetHumAutoLevel = state.rhautolevel.state || DEFAULT_HUMIDITY;
    this.targetHumSleepLevel = state.rhsleeplevel.state || DEFAULT_HUMIDITY;

    this.currState = this.on ? (this.suspended ? 1 : 2) : 0;

    const deviceName = accessory.context.device.deviceName || 'Humidifier';
    // Get the HumidifierDehumidifier service if it exists, otherwise create a new HumidifierDehumidifier service
    this.humidifierService = this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier, deviceName);
    // Get the HumiditySensor service if it exists, otherwise create a new HumiditySensor service
    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor) ||
      this.accessory.addService(this.platform.Service.HumiditySensor, 'Humidity Sensor');
    // Get the Switch service if it exists, otherwise create a new Switch service
    this.sleepSwitchService = this.accessory.getServiceById(this.platform.Service.Switch, 'SleepMode') ||
      this.accessory.addService(this.platform.Service.Switch, 'Sleep Mode', 'SleepMode');
    this.hotFogSwitchService = this.accessory.getServiceById(this.platform.Service.Switch, 'HotFog') ||
      this.accessory.addService(this.platform.Service.Switch, 'Warm Mist', 'HotFog');

    // ON / OFF
    // Register handlers for the Humidifier Active characteristic
    this.humidifierService.getCharacteristic(this.platform.Characteristic.Active)
    .onGet(this.getActive.bind(this))
    .onSet(this.setActive.bind(this));
    this.sleepSwitchService.getCharacteristic(this.platform.Characteristic.On)
    .onGet(this.getSleepMode.bind(this))
    .onSet(this.setSleepMode.bind(this));
    this.hotFogSwitchService.getCharacteristic(this.platform.Characteristic.On)
    .onGet(this.getHotFog.bind(this))
    .onSet(this.setHotFog.bind(this));

    // Register handlers for Current Humidifier State characteristic
    // Disabling dehumidifying as it is not supported
    /**
     * 0: Inactive      (Dero Off)
     * 1: Idle          (Dero On & Dero Suspended)
     * 2: Humidifying   (Dero On & Dero Not Suspended)
     * 3: Dehumidifying (Not supported - DISABLE IT)
     */
    this.humidifierService.getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
    .setProps({
      minValue: 0,
      maxValue: 2,
      validValues: [0, 1, 2],
    })
    .onGet(this.getCurrentHumidifierState.bind(this));

    // Register handlers for Current Humidifier Water Level characteristic
    this.humidifierService.getCharacteristic(this.platform.Characteristic.WaterLevel)
    .onGet(this.getCurrentHumidifierWaterLevel.bind(this));

    // Register handlers for Target Humidifier Mode characteristic
    /**
     * 0: Auto (Dero Manual)
     * 1: Humidifier (Dero Auto)
     * 2: Dehumidifier (Dero Sleep)
     */
    this.humidifierService.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
    .setProps({
      minValue: 0,
      maxValue: 1,
      validValues: [0, 1],
    })
    .onGet(this.getTargetHumidifierMode.bind(this))
    .onSet(this.setTargetHumidifierMode.bind(this));

    // Set RelativeHumidityHumidifierThreshold
    this.humidifierService.getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
    .setProps({
      minValue: MIN_HUMIDITY,
      maxValue: MAX_HUMIDITY,
      minStep: 1,
    })
    .onGet(this.getTargetHumidity.bind(this))
    .onSet(this.setTargetHumidity.bind(this));

    // Register handlers for Current Humidity characteristic
    this.humidifierService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
    .onGet(this.getCurrentHumidity.bind(this));
    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
    .onGet(this.getCurrentHumidity.bind(this));

    // Register handlers for manual fog level characteristic
    this.humidifierService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
    .setProps({
      minValue: 0,
      maxValue: 6,
      validValues: [0, 1, 2, 3, 4, 5, 6], // [0: off, 1-6: fog levels]
    })
    .onGet(this.getTargetFogLevel.bind(this))
    .onSet(this.setTargetFogLevel.bind(this));

    // Update values from Dreo App
    platform.webHelper.addEventListener('message', (message: MessageEvent) => {
      let data: DreoMessage;
      try {
        data = JSON.parse(message.data);
        if (data.devicesn === accessory.context.device.sn) {
          if (data.method && ['control-report', 'control-reply', 'report'].includes(data.method) && data.reported) {
            Object.keys(data.reported).forEach(key => this.processReportedKey(key, data.reported!));
          }
        }
      } catch (error) {
        this.platform.log.error('Failed to parse incoming message: %s', error);
      }
    });
  }

  getActive(): boolean {
    return this.on;
  }

  setActive(value: unknown): void {
    this.platform.log.debug('Triggered SET Active: %s', value);
    const isActive = Boolean(value);
    // Check state to prevent duplicate requests
    if (this.on !== isActive) {
      // Send to Dreo server via websocket
      this.platform.webHelper.control(this.sn, {'poweron': isActive});
    }
    // Update HomeKit state
    this.on = isActive;
    this.updateCurrentHumidifierState();
  }

  getSleepMode(): boolean {
    return this.on && this.deroMode === 2;
  }

  setSleepMode(value: unknown): void {
    this.platform.log.debug('Triggered SET SleepMode: %s', value);
    const isSleepMode = Boolean(value);
    let command: {};
    if (isSleepMode) {
      this.deroMode = 2;
      if (this.on) {
        command = {'mode': this.deroMode};
      } else {
        this.on = true;
        command = {'poweron': true, 'mode': this.deroMode}; // Power on the humidifier
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, true);
      }
      setTimeout(() => {
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, 1);
      }, 750);
    } else { // Run this only if the humidifier is on
      this.deroMode = 0;
      command = {'mode': this.deroMode};
      if (this.on) {
        setTimeout(() => {
          this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, 0);
        }, 750);
      }
    }
    this.platform.webHelper.control(this.sn, command);
  }

  getHotFog(): boolean {
    return this.on && this.fogHot;
  }

  setHotFog(value: unknown): void {
    this.platform.log.debug('Triggered SET HotFog: %s', value);
    this.fogHot = Boolean(value);
    let command: {};
    if (this.on) {
      command = {'hotfogon': this.fogHot};
    } else {
      command = {'poweron': true, 'hotfogon': this.fogHot};
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, true);
    }
    this.platform.webHelper.control(this.sn, command);
  }

  getCurrentHumidifierState() {
    return this.currState;
  }

  // Note: Dreo API does not provide a direct water level, using current humidity as a placeholder
  // This could be replaced with actual logic if Dreo provides a water level state
  getCurrentHumidifierWaterLevel() {
    return this.wrong === 1 ? 0 : 100;
  }

  setTargetHumidifierMode(value: unknown): void {
    this.platform.log.debug('Triggered SET TargetHumidifierState: %s', value);
    this.deroMode = Number(value);
    this.platform.webHelper.control(this.sn, {'mode': this.deroMode});
  }

  getTargetHumidifierMode(): number {
    return this.deroMode === 2 ? 1 : this.deroMode;
  }

  getCurrentHumidity(): number {
    return this.currentHum;
  }

  // Target humidity can be set in auto and sleep modes
  setTargetHumidity(value: unknown): void {
    const targetValue = Math.min(MAX_HUMIDITY, Math.max(MIN_HUMIDITY, Number(value)));
    if (this.deroMode === 0) { // manual
      this.platform.log.warn('ERROR: Triggered SET TargetHumidity (Manual): %s', Number(value));
    } else if (this.deroMode === 1) { // auto
      this.targetHumAutoLevel = targetValue;
      this.platform.log.debug('Triggered SET TargetHumidity (Auto): %s', value);
      this.platform.webHelper.control(this.sn, {'rhautolevel': this.targetHumAutoLevel});
    } else if (this.deroMode === 2) { // sleep
      this.targetHumSleepLevel = targetValue;
      this.platform.log.debug('Triggered SET TargetHumidity (Sleep): %s', value);
      this.platform.webHelper.control(this.sn, {'rhsleeplevel': this.targetHumSleepLevel});
    }
  }

  getTargetHumidity(): number {
    let threshold: number;
    switch (this.deroMode) {
      case 1: // auto
        threshold = this.targetHumAutoLevel;
        this.platform.log.debug('Triggered GET TargetHumidity (Auto): %s', threshold);
        break;
      case 2: // sleep
        threshold = this.targetHumSleepLevel;
        this.platform.log.debug('Triggered GET TargetHumidity (Sleep): %s', threshold);
        break;
      default: // manual do not have a target humidity, it has fog level
        // return the threshold for Auto mode as a sensible default when manual is active
        threshold = this.targetHumAutoLevel || DEFAULT_HUMIDITY;
        this.platform.log.debug('Triggered GET TargetHumidity (Manual - Returning Auto Level): %s', threshold);
        break;
    }
    return Math.max(MIN_HUMIDITY, threshold || DEFAULT_HUMIDITY);
  }

  // Can only be set in manual mode
  setTargetFogLevel(value: unknown): void {
    this.platform.log.debug('Triggered SET TargetFogLevel: %s', value);
    this.manualFogLevel = Number(value);
    if (this.manualFogLevel === 0) { // If manual fog level is 0, turn off the humidifier
      this.on = false; // Turn off humidifier
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, false);
      this.platform.webHelper.control(this.sn, {'poweron': this.on});
      return;
    }
    if (this.deroMode === 0) { // manual
      this.platform.webHelper.control(this.sn, {'foglevel': this.manualFogLevel});
    } else {
      this.platform.log.warn('WARN: Switching to manual mode to set fog level. Current mode: %s', this.deroMode);
      this.deroMode = 0; // Set mode to manual
      this.platform.webHelper.control(this.sn, {'mode': this.deroMode, 'foglevel': this.manualFogLevel});
    }
  }

  getTargetFogLevel(): number {
    return this.on ? this.manualFogLevel : 0;
  }

  private updateCurrentHumidifierState() {
    // Update HomeKit current humidifier state based on power and suspend states
    this.currState = this.on ? this.suspended ? 1 : 2 : 0;
    this.platform.log.debug('Current Humidifier State: %s', this.currState);
    this.humidifierService.updateCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState, this.currState);
    this.sleepSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.getSleepMode());
    this.hotFogSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.getHotFog());
  }

  /**
   * 0 HomeKit: Auto - Dero: Manual (0)
   * 1 HomeKit: Humidifying - Dero: Auto (1) & Sleep (2)
   **/
  private updateTargetHumidifierState(deroMode: number) {
    this.deroMode = deroMode;
    if (this.deroMode === 2) {
      if (!this.on) {
        this.on = true;
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, this.on);
      }
      this.sleepSwitchService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, 1);
    } else {
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, this.deroMode);
    }
  }

  private processReportedKey(key: string, reported: DreoStateReport): void {
    switch (key) {
      case 'poweron':
        if (this.on !== reported.poweron) {
          this.on = reported.poweron ?? this.on;
          this.platform.log.debug('Humidifier power: %s', this.on);
          this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, this.on);
          this.updateCurrentHumidifierState();
        }
        break;
      case 'mode':
        this.deroMode = reported.mode ?? this.deroMode;
        this.platform.log.debug('Humidifier mode reported: %s', this.deroMode);
        this.updateTargetHumidifierState(this.deroMode);
        break;
      case 'suspend':
        this.suspended = reported.suspend ?? this.suspended;
        this.platform.log.debug('Humidifier suspended: %s', this.suspended);
        this.updateCurrentHumidifierState();
        break;
      case 'rh':
        this.currentHum = reported.rh ?? this.currentHum;
        this.platform.log.debug('Humidifier humidity: %s', this.currentHum);
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.currentHum);
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.currentHum);
        break;
      case 'hotfogon':
        this.fogHot = reported.hotfogon ?? this.fogHot;
        this.platform.log.debug('Humidifier hotfogon: %s', this.fogHot);
        this.hotFogSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.fogHot);
        break;
      case 'foglevel':
        this.manualFogLevel = reported.foglevel ?? this.manualFogLevel;
        this.platform.log.debug('Humidifier manualFogLevel: %s', this.manualFogLevel);
        // Fog level can change even when not in manual mode. So no need to change mode to manual.
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.manualFogLevel);
        break;
      case 'rhautolevel':
        this.targetHumAutoLevel = reported.rhautolevel ?? this.targetHumAutoLevel;
        this.platform.log.debug('Humidifier targetHumAutoLevel: %s', this.targetHumAutoLevel);
        if (this.deroMode === 1) {
          const valueToUpdate = Math.max(MIN_HUMIDITY, this.targetHumAutoLevel || DEFAULT_HUMIDITY);
          this.humidifierService
          .updateCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold, valueToUpdate);
        }
        break;
      case 'rhsleeplevel':
        this.targetHumSleepLevel = reported.rhsleeplevel ?? this.targetHumSleepLevel;
        this.platform.log.debug('Humidifier targetHumSleepLevel: %s %s', this.targetHumSleepLevel, typeof parseFloat(String(this.targetHumSleepLevel)));
        if (this.deroMode === 2) {
          const valueToUpdate = Math.max(MIN_HUMIDITY, this.targetHumSleepLevel || DEFAULT_HUMIDITY);
          this.humidifierService
          .updateCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold, valueToUpdate);
        }
        break;
      case 'wrong':
        this.wrong = reported.wrong ?? this.wrong;
        if (this.wrong === 1) {
          this.platform.log.error('Humidifier error: No water detected');
          this.humidifierService.updateCharacteristic(this.platform.Characteristic.WaterLevel, 0);
        } else {
          this.humidifierService.updateCharacteristic(this.platform.Characteristic.WaterLevel, 100);
        }
        break;
      default:
        this.platform.log.debug('Incoming [%s]: %s', key, reported);
        break;
    }
  }
}

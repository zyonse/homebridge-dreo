/* eslint-disable */
import type { PlatformAccessory, Service } from 'homebridge' with { 'resolution-mode': 'import' };
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

interface DreoStateReport {
  poweron?: boolean;      // Active
  mode?: number;          // Mode 0-2 [manual, auto, sleep]
  suspend?: boolean;      // Suspended
  rh?: number;            // Current humidity
  hotfogon?: boolean;     // Hot fog on (not available on all models)
  foglevel?: number;      // Fog level 0-6 [0: off, 1-6: levels]
  rhautolevel?: number;   // Target humidity level in auto mode
  rhsleeplevel?: number;  // Target humidity level in sleep mode
  ledlevel?: number;      // LED indicator level 0-2 [off, low, high]
  rgblevel?: string | number;  // RGB display level 0-2 [off, low, high]
  muteon?: boolean;       // Beep on/off
  wrong?: number;         // Error code 0-1 [0: no error, 1: no water]
  worktime?: number;      // Work time in minutes after last cleaning
  filtertime?: number;    // Filter life percentage remaining
  mcuon?: boolean;        // MCU status
  connected?: boolean;    // Connection status
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
  hotfogon?: {state: boolean};  // Optional - not available on all models
  ledlevel: {state: number};
  rgblevel: {state: string | number};  // Can be string or number depending on model
  foglevel: {state: number};
  rhautolevel: {state: number};
  rhsleeplevel: {state: number};
  wrong: {state: number};
}

// Use integer values for HomeKit humidity thresholds
const MAX_HUMIDITY = 90; // Maximum humidity level for HomeKit.
const MIN_HUMIDITY = 30; // Minimum humidity level for HomeKit.
const DEFAULT_HUMIDITY = 45; // Default humidity level for HomeKit if not specified.

export class HumidifierAccessory extends BaseAccessory {
  private readonly humidifierService: Service;
  private readonly humidityService: Service;
  private readonly sleepSwitchService: Service;
  private readonly hotFogSwitchService?: Service;  // Optional - not all models support hot fog

  // Cached copy of latest device states
  private on: boolean;        // poweron
  private dreoMode: number;   // mode 0-2       [manual, auto, sleep]
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
    this.on = state.poweron?.state ?? false;
    this.dreoMode = state.mode?.state ?? 0;
    this.suspended = state.suspend?.state ?? false;
    this.currentHum = state.rh?.state ?? 0;
    this.fogHot = state.hotfogon?.state ?? false;
    this.ledLevel = state.ledlevel?.state ?? 0;
    this.rgbLevel = String(state.rgblevel?.state ?? '0');  // Convert to string for consistency
    this.wrong = state.wrong?.state ?? 0;
    this.manualFogLevel = state.foglevel?.state ?? 0;
    // Ensure humidity levels are within HomeKit valid range
    this.targetHumAutoLevel = this.clampHumidityForDevice(state.rhautolevel?.state);
    this.targetHumSleepLevel = this.clampHumidityForDevice(state.rhsleeplevel?.state);

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

    // Only create Hot Fog switch if the device supports it (some models like HM311S don't have this feature)
    if (state.hotfogon !== undefined) {
      this.hotFogSwitchService = this.accessory.getServiceById(this.platform.Service.Switch, 'HotFog') ||
        this.accessory.addService(this.platform.Service.Switch, 'Warm Mist', 'HotFog');
    }

    // ON / OFF
    // Register handlers for the Humidifier Active characteristic
    this.humidifierService.getCharacteristic(this.platform.Characteristic.Active)
    .onGet(this.getActive.bind(this))
    .onSet(this.setActive.bind(this));
    this.sleepSwitchService.getCharacteristic(this.platform.Characteristic.On)
    .onGet(this.getSleepMode.bind(this))
    .onSet(this.setSleepMode.bind(this));

    // Only register Hot Fog handlers if the service exists (device supports it)
    if (this.hotFogSwitchService) {
      this.hotFogSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getHotFog.bind(this))
      .onSet(this.setHotFog.bind(this));
    }

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
    // HM311S is humidifier-only, so only expose humidifier mode (1) to avoid "Humidifier-Dehumidifier" display
    this.humidifierService.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
    .setProps({
      minValue: 1,
      maxValue: 1,
      validValues: [1], // Only humidifier mode - this makes HomeKit show just "Humidifier"
    })
    .onGet(this.getTargetHumidifierMode.bind(this))
    .onSet(this.setTargetHumidifierMode.bind(this));

    // Set RelativeHumidityHumidifierThreshold
    // HomeKit range matches device capabilities (30-90%) for clearer user interface
    const humidityCharacteristic = this.humidifierService.getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold);
    humidityCharacteristic
    .setProps({
      minValue: 30,
      maxValue: 90,
      minStep: 1,
    })
    .onGet(this.getTargetHumidity.bind(this))
    .onSet(this.setTargetHumidity.bind(this));

    // Force an immediate update to ensure HomeKit uses the new properties for both characteristics
    setTimeout(() => {
      const currentTargetHumidity = this.getTargetHumidity();
      const currentHumidity = this.getCurrentHumidity();
      this.platform.log.debug('Forcing humidity characteristic updates - target: %s, current: %s', currentTargetHumidity, currentHumidity);

      // Update both target (slider) and current (tile subtext) humidity characteristics
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold, currentTargetHumidity);
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, currentHumidity);
      this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, currentHumidity);
    }, 1000);

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

  // Helper function to clamp humidity values to device capabilities when setting values
  private clampHumidityForDevice(value: any): number {
    const MIN_HUMIDITY = 30;
    const MAX_HUMIDITY = 90;
    const DEFAULT_HUMIDITY = 45;

    // Handle null and undefined explicitly
    if (value === null || value === undefined) {
      return DEFAULT_HUMIDITY;
    }

    const numValue = Number(value);
    if (isNaN(numValue)) {
      return DEFAULT_HUMIDITY;
    }

    // Ensure integer value within device's valid range (30-90%)
    const intValue = Math.round(numValue);
    return Math.max(MIN_HUMIDITY, Math.min(MAX_HUMIDITY, intValue));
  }

  // Helper function to validate humidity values for HomeKit display (allows actual device values)
  private validateHumidityForHomeKit(value: any): number {
    const DEFAULT_HUMIDITY = 45;

    // Handle null and undefined explicitly
    if (value === null || value === undefined) {
      return DEFAULT_HUMIDITY;
    }

    const numValue = Number(value);
    if (isNaN(numValue)) {
      return DEFAULT_HUMIDITY;
    }

    // Just ensure it's an integer - let HomeKit display the actual device value
    return Math.round(numValue);
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
    return this.on && this.dreoMode === 2;
  }

  setSleepMode(value: unknown): void {
    this.platform.log.debug('Triggered SET SleepMode: %s', value);
    const isSleepMode = Boolean(value);
    let command: {};
    if (isSleepMode) {
      this.dreoMode = 2;
      if (this.on) {
        command = {'mode': this.dreoMode};
      } else {
        this.on = true;
        command = {'poweron': true, 'mode': this.dreoMode}; // Power on the humidifier
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, true);
      }
      setTimeout(() => {
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, 1);
      }, 750);
    } else { // Run this only if the humidifier is on
      this.dreoMode = 0;
      command = {'mode': this.dreoMode};
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
    // Only proceed if this device supports hot fog
    if (!this.hotFogSwitchService) {
      this.platform.log.warn('Hot fog feature not supported on this model');
      return;
    }

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
    // Since we only expose humidifier mode (1), this should always be 1
    // But we still respect the user's device mode for internal operations
    if (Number(value) === 1) {
      // User is setting humidifier mode - we'll keep current dreoMode
      // This allows the device's internal modes (manual/auto/sleep) to work
      // while presenting a simple "humidifier" interface to HomeKit
      this.platform.log.debug('Humidifier mode confirmed (internal dreoMode: %s)', this.dreoMode);
    }
  }

  getTargetHumidifierMode(): number {
    // Always return 1 (humidifier) since HM311S is humidifier-only
    // This ensures HomeKit displays "Humidifier" instead of "Humidifier-Dehumidifier"
    return 1;
  }

  getCurrentHumidity(): number {
    // Ensure current humidity is a proper integer for HomeKit display
    const validated = this.validateHumidityForHomeKit(this.currentHum);
    this.platform.log.debug('getCurrentHumidity() - raw: %s, validated: %s', this.currentHum, validated);
    return validated;
  }

  setTargetHumidity(value: unknown): void {
    // Clamp value to device capabilities (30-90%) when setting
    const targetValue = this.clampHumidityForDevice(Number(value));
    if (this.dreoMode === 0) { // manual
      this.platform.log.warn('ERROR: Triggered SET TargetHumidity (Manual): %s', targetValue);
    } else if (this.dreoMode === 1) { // auto
      this.targetHumAutoLevel = targetValue;
      this.platform.log.debug('Triggered SET TargetHumidity (Auto): %s', targetValue);
      this.platform.webHelper.control(this.sn, {'rhautolevel': this.targetHumAutoLevel});
    } else if (this.dreoMode === 2) { // sleep
      this.targetHumSleepLevel = targetValue;
      this.platform.log.debug('Triggered SET TargetHumidity (Sleep): %s', targetValue);
      this.platform.webHelper.control(this.sn, {'rhsleeplevel': this.targetHumSleepLevel});
    }
  }

  getTargetHumidity(): number {
    let threshold: number;
    switch (this.dreoMode) {
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
        threshold = this.targetHumAutoLevel;
        this.platform.log.debug('Triggered GET TargetHumidity (Manual - Returning Auto Level): %s', threshold);
        break;
    }
    // Return the actual device value for HomeKit to display correctly
    const validatedValue = this.validateHumidityForHomeKit(threshold);
    this.platform.log.debug('GET TargetHumidity returning: %s (from device value: %s)', validatedValue, threshold);
    return validatedValue;
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
    if (this.dreoMode === 0) { // manual
      this.platform.webHelper.control(this.sn, {'foglevel': this.manualFogLevel});
    } else {
      this.platform.log.warn('WARN: Switching to manual mode to set fog level. Current mode: %s', this.dreoMode);
      this.dreoMode = 0; // Set mode to manual
      this.platform.webHelper.control(this.sn, {'mode': this.dreoMode, 'foglevel': this.manualFogLevel});
    }
  }

  getTargetFogLevel(): number {
    return this.on ? this.manualFogLevel : 0;
  }

  private updateCurrentHumidifierState() {
    // Update HomeKit current humidifier state based on power and suspend states
    this.currState = this.on ? (this.suspended ? 1 : 2) : 0;
    this.platform.log.debug('Current Humidifier State: %s', this.currState);
    this.humidifierService.updateCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState, this.currState);
    this.sleepSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.getSleepMode());

    // Only update Hot Fog if the service exists (device supports it)
    if (this.hotFogSwitchService) {
      this.hotFogSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.getHotFog());
    }
  }

  /**
   * 0 HomeKit: Auto - Dero: Manual (0)
   * 1 HomeKit: Humidifying - Dero: Auto (1) & Sleep (2)
   **/
  private updateTargetHumidifierState(dreoMode: number) {
    this.dreoMode = dreoMode;
    if (this.dreoMode === 2) {
      if (!this.on) {
        this.on = true;
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, this.on);
      }
      this.sleepSwitchService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, 1);
    } else {
      this.humidifierService.updateCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState, this.dreoMode);
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
        this.dreoMode = reported.mode ?? this.dreoMode;
        this.platform.log.debug('Humidifier mode reported: %s', this.dreoMode);
        this.updateTargetHumidifierState(this.dreoMode);
        break;
      case 'suspend':
        this.suspended = reported.suspend ?? this.suspended;
        this.platform.log.debug('Humidifier suspended: %s', this.suspended);
        this.updateCurrentHumidifierState();
        break;
      case 'rh':
        this.currentHum = reported.rh ?? this.currentHum;
        this.platform.log.debug('Humidifier humidity: %s', this.currentHum);
        // Validate current humidity for HomeKit display consistency
        const validatedCurrentHum = this.validateHumidityForHomeKit(this.currentHum);
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, validatedCurrentHum);
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, validatedCurrentHum);
        break;
      case 'hotfogon':
        this.fogHot = reported.hotfogon ?? this.fogHot;
        this.platform.log.debug('Humidifier hotfogon: %s', this.fogHot);
        // Only update if the service exists (device supports hot fog)
        if (this.hotFogSwitchService) {
          this.hotFogSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.fogHot);
        }
        break;
      case 'foglevel':
        this.manualFogLevel = reported.foglevel ?? this.manualFogLevel;
        this.platform.log.debug('Humidifier manualFogLevel: %s', this.manualFogLevel);
        this.humidifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.manualFogLevel);
        if (this.manualFogLevel === 0) {
          this.on = false;
          this.humidifierService.updateCharacteristic(this.platform.Characteristic.Active, false);
        }
        break;
      case 'rhautolevel':
        this.targetHumAutoLevel = reported.rhautolevel ?? this.targetHumAutoLevel;
        this.platform.log.debug('Humidifier targetHumAutoLevel: %s', this.targetHumAutoLevel);
        if (this.dreoMode === 1) {
          const valueToUpdate = this.validateHumidityForHomeKit(this.targetHumAutoLevel);
          this.humidifierService
          .updateCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold, valueToUpdate);
        }
        break;
      case 'rhsleeplevel':
        this.targetHumSleepLevel = reported.rhsleeplevel ?? this.targetHumSleepLevel;
        this.platform.log.debug('Humidifier targetHumSleepLevel: %s', this.targetHumSleepLevel);
        if (this.dreoMode === 2) {
          const valueToUpdate = this.validateHumidityForHomeKit(this.targetHumSleepLevel);
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
      case 'filtertime':
        const filterLife = reported.filtertime ?? 100;
        this.platform.log.debug('Humidifier filter life: %s%', filterLife);
        // Could add a FilterLifeLevel characteristic if desired for HomeKit
        break;
      case 'worktime':
        const workTime = reported.worktime ?? 0;
        this.platform.log.debug('Humidifier work time since cleaning: %s minutes', workTime);
        break;
      case 'connected':
        const connected = reported.connected ?? true;
        this.platform.log.debug('Humidifier connection status: %s', connected ? 'Connected' : 'Disconnected');
        break;
      default:
        this.platform.log.debug('Incoming [%s]: %s', key, reported);
        break;
    }
  }
}

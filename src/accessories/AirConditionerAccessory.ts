import type { PlatformAccessory, Service } from 'homebridge' with { 'resolution-mode': 'import' };
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

type HvacMode = 'cool' | 'dry' | 'fan_only';
type TemperatureUnit = 'celsius' | 'fahrenheit';

const HVAC_MODE = {
  COOL: 'cool' as HvacMode,
  DRY: 'dry' as HvacMode,
  FAN_ONLY: 'fan_only' as HvacMode,
};

const DREO_MODE = {
  NORMAL: 'normal',
  SLEEP: 'sleep',
  ECO: 'eco',
};

const HK = {
  ACTIVE: 1,
  INACTIVE: 0,
  CURRENT_HC_INACTIVE: 0,
  CURRENT_HC_COOLING: 3,
  TARGET_HC_COOL: 2,
  CURRENT_HD_INACTIVE: 0,
  CURRENT_HD_DEHUMIDIFYING: 3,
  TARGET_HD_DEHUMIDIFIER: 2,
  CURRENT_FAN_INACTIVE: 0,
  CURRENT_FAN_BLOWING_AIR: 2,
  TARGET_FAN_MANUAL: 0,
  TARGET_FAN_AUTO: 1,
  SWING_DISABLED: 0,
  SWING_ENABLED: 1,
};

const SPEED_AUTO = 4;
const DEFAULT_TARGET_TEMPERATURE_F = 72;
const DEFAULT_TARGET_HUMIDITY = 50;
const DEFAULT_CURRENT_HUMIDITY = 50;

/**
 * Dreo HAC / portable air conditioner support.
 *
 * HomeKit has no single native service with Cool, Dry and Fan Only modes, so
 * the AC is exposed as one accessory with three mode-specific services.
 */
export class AirConditionerAccessory extends BaseAccessory {
  private readonly coolService: Service;
  private readonly dryService: Service;
  private readonly fanService: Service;
  private readonly displaySwitchService: Service;
  private readonly sleepSwitchService: Service;
  private readonly ecoSwitchService: Service;
  private readonly fanSpeed1SwitchService: Service;
  private readonly fanSpeed2SwitchService: Service;
  private readonly fanSpeed3SwitchService: Service;
  private readonly autoFanSwitchService: Service;
  private readonly pollTimer: NodeJS.Timeout;

  private state = {
    on: false,
    hvacMode: HVAC_MODE.COOL,
    mode: DREO_MODE.NORMAL,
    speed: 1,
    swing: false,
    targetTemperature: this.toCelsius(DEFAULT_TARGET_TEMPERATURE_F),
    currentTemperature: this.toCelsius(DEFAULT_TARGET_TEMPERATURE_F),
    targetHumidity: DEFAULT_TARGET_HUMIDITY,
    currentHumidity: DEFAULT_CURRENT_HUMIDITY,
    displayOn: true,
    displayKey: 'led_switch',
    temperatureUnit: 'fahrenheit' as TemperatureUnit,
  };

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly initialState,
  ) {
    super(platform, accessory);

    const configuredTemperatureUnit = this.getFanEntityConfig().temperature_unit;
    if (configuredTemperatureUnit === 'celsius' || configuredTemperatureUnit === 'fahrenheit') {
      this.state.temperatureUnit = configuredTemperatureUnit;
    }
    this.loadState(initialState);

    this.coolService =
      this.accessory.getServiceById(this.platform.Service.HeaterCooler, 'Cool') ||
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler, 'Kühlen', 'Cool');
    this.setServiceName(this.coolService, 'Kühlen');

    this.dryService =
      this.accessory.getServiceById(this.platform.Service.HumidifierDehumidifier, 'Dry') ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier, 'Trocknen', 'Dry');
    this.setServiceName(this.dryService, 'Trocknen');

    this.fanService =
      this.accessory.getServiceById(this.platform.Service.Fanv2, 'FanOnly') ||
      this.accessory.addService(this.platform.Service.Fanv2, 'Ventilator', 'FanOnly');
    this.setServiceName(this.fanService, 'Ventilator');

    this.displaySwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'Display') ||
      this.accessory.addService(this.platform.Service.Switch, 'Anzeige', 'Display');
    this.setServiceName(this.displaySwitchService, 'Anzeige');

    this.sleepSwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'SleepMode') ||
      this.accessory.addService(this.platform.Service.Switch, 'Schlafmodus', 'SleepMode');
    this.setServiceName(this.sleepSwitchService, 'Schlafmodus');

    this.ecoSwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'EcoMode') ||
      this.accessory.addService(this.platform.Service.Switch, 'Ökomodus', 'EcoMode');
    this.setServiceName(this.ecoSwitchService, 'Ökomodus');

    this.fanSpeed1SwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'FanSpeed1') ||
      this.accessory.addService(this.platform.Service.Switch, 'Lüfter 1', 'FanSpeed1');
    this.setServiceName(this.fanSpeed1SwitchService, 'Lüfter 1');

    this.fanSpeed2SwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'FanSpeed2') ||
      this.accessory.addService(this.platform.Service.Switch, 'Lüfter 2', 'FanSpeed2');
    this.setServiceName(this.fanSpeed2SwitchService, 'Lüfter 2');

    this.fanSpeed3SwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'FanSpeed3') ||
      this.accessory.addService(this.platform.Service.Switch, 'Lüfter 3', 'FanSpeed3');
    this.setServiceName(this.fanSpeed3SwitchService, 'Lüfter 3');

    this.autoFanSwitchService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'AutoFan') ||
      this.accessory.addService(this.platform.Service.Switch, 'Lüfter Auto', 'AutoFan');
    this.setServiceName(this.autoFanSwitchService, 'Lüfter Auto');

    this.configureCoolService();
    this.configureDryService();
    this.configureFanService();
    this.configureSwitches();

    platform.webHelper.addEventListener('message', message => {
      try {
        const data = JSON.parse(message.data);
        if (
          data.devicesn === accessory.context.device.sn &&
          data.reported &&
          ['control-report', 'control-reply', 'report'].includes(data.method)
        ) {
          this.loadState(data.reported);
          this.updateHomeKit();
        }
      } catch (error) {
        this.platform.log.debug('Failed to parse AC websocket update:', error);
      }
    });

    this.pollTimer = setInterval(() => {
      void this.refreshFromCloud();
    }, 15000);

    this.updateHomeKit();
  }

  setActive(value): void {
    void this.setCoolActive(value);
  }

  getActive(): boolean {
    return this.isModeActive(HVAC_MODE.COOL);
  }

  private setServiceName(service: Service, name: string): void {
    service.displayName = name;
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
  }

  private configureCoolService(): void {
    const temperatureRange = this.getTemperatureRange();

    this.coolService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setCoolActive.bind(this))
      .onGet(() => this.isModeActive(HVAC_MODE.COOL));

    this.coolService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentCoolerState.bind(this));

    this.coolService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        minValue: HK.TARGET_HC_COOL,
        maxValue: HK.TARGET_HC_COOL,
        validValues: [HK.TARGET_HC_COOL],
      })
      .onSet(this.setTargetHeaterCoolerState.bind(this))
      .onGet(() => HK.TARGET_HC_COOL);

    this.coolService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTemperature);

    this.coolService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: temperatureRange.min,
        maxValue: temperatureRange.max,
        minStep: 1,
      })
      .onSet(this.setCoolingThresholdTemperature.bind(this))
      .onGet(() => this.state.targetTemperature);

    this.coolService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 25,
        maxValue: 100,
        minStep: 25,
      })
      .onSet(value => this.setRotationSpeed(value, HVAC_MODE.COOL))
      .onGet(() => this.speedToPercentage(this.state.speed));

    this.coolService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(value => this.setSwingMode(value, HVAC_MODE.COOL))
      .onGet(() => this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);
  }

  private configureDryService(): void {
    const humidityRange = this.getHumidityRange();

    this.dryService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setDryActive.bind(this))
      .onGet(() => this.isModeActive(HVAC_MODE.DRY));

    this.dryService.getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .setProps({
        minValue: HK.CURRENT_HD_INACTIVE,
        maxValue: HK.CURRENT_HD_DEHUMIDIFYING,
        validValues: [HK.CURRENT_HD_INACTIVE, HK.CURRENT_HD_DEHUMIDIFYING],
      })
      .onGet(this.getCurrentDryState.bind(this));

    this.dryService.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        minValue: HK.TARGET_HD_DEHUMIDIFIER,
        maxValue: HK.TARGET_HD_DEHUMIDIFIER,
        validValues: [HK.TARGET_HD_DEHUMIDIFIER],
      })
      .onSet(this.setTargetDryState.bind(this))
      .onGet(() => HK.TARGET_HD_DEHUMIDIFIER);

    this.dryService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.state.currentHumidity);

    this.dryService.getCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .setProps({
        minValue: humidityRange.min,
        maxValue: humidityRange.max,
        minStep: 5,
      })
      .onSet(this.setTargetHumidity.bind(this))
      .onGet(() => this.state.targetHumidity);

    this.dryService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 25,
        maxValue: 100,
        minStep: 25,
      })
      .onSet(value => this.setRotationSpeed(value, HVAC_MODE.DRY))
      .onGet(() => this.speedToPercentage(this.state.speed));

    this.dryService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(value => this.setSwingMode(value, HVAC_MODE.DRY))
      .onGet(() => this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);
  }

  private configureFanService(): void {
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this))
      .onGet(() => this.isModeActive(HVAC_MODE.FAN_ONLY));

    this.fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.getCurrentFanState.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 25,
        maxValue: 100,
        minStep: 25,
      })
      .onSet(value => this.setRotationSpeed(value, HVAC_MODE.FAN_ONLY))
      .onGet(() => this.speedToPercentage(this.state.speed));

    this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onSet(this.setTargetFanState.bind(this))
      .onGet(() => this.state.speed === SPEED_AUTO ? HK.TARGET_FAN_AUTO : HK.TARGET_FAN_MANUAL);

    this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onSet(value => this.setSwingMode(value, HVAC_MODE.FAN_ONLY))
      .onGet(() => this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);
  }

  private configureSwitches(): void {
    this.displaySwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setDisplayOn.bind(this))
      .onGet(() => this.state.displayOn);

    this.sleepSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setSleepMode.bind(this))
      .onGet(() => this.isPresetActive(DREO_MODE.SLEEP));

    this.ecoSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setEcoMode.bind(this))
      .onGet(() => this.isPresetActive(DREO_MODE.ECO));

    this.fanSpeed1SwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(value => this.setFanSpeedSwitch(value, 1))
      .onGet(() => this.state.speed === 1);

    this.fanSpeed2SwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(value => this.setFanSpeedSwitch(value, 2))
      .onGet(() => this.state.speed === 2);

    this.fanSpeed3SwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(value => this.setFanSpeedSwitch(value, 3))
      .onGet(() => this.state.speed === 3);

    this.autoFanSwitchService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(value => this.setFanSpeedSwitch(value, SPEED_AUTO))
      .onGet(() => this.state.speed === SPEED_AUTO);
  }

  private async setCoolActive(value): Promise<void> {
    if (Boolean(value)) {
      await this.sendCommand({
        power_switch: true,
        hvacmode: HVAC_MODE.COOL,
      });
    } else if (this.isModeActive(HVAC_MODE.COOL)) {
      await this.sendCommand({power_switch: false});
    }
  }

  private async setDryActive(value): Promise<void> {
    if (Boolean(value)) {
      await this.sendCommand({
        power_switch: true,
        hvacmode: HVAC_MODE.DRY,
      });
    } else if (this.isModeActive(HVAC_MODE.DRY)) {
      await this.sendCommand({power_switch: false});
    }
  }

  private async setFanActive(value): Promise<void> {
    if (Boolean(value)) {
      await this.sendCommand({
        power_switch: true,
        hvacmode: HVAC_MODE.FAN_ONLY,
      });
    } else if (this.isModeActive(HVAC_MODE.FAN_ONLY)) {
      await this.sendCommand({power_switch: false});
    }
  }

  private setTargetHeaterCoolerState(value): void {
    if (Number(value) !== HK.TARGET_HC_COOL) {
      throw new Error('Only cooling is supported by this service');
    }
  }

  private setTargetDryState(value): void {
    if (Number(value) !== HK.TARGET_HD_DEHUMIDIFIER) {
      throw new Error('Only dehumidifying is supported by this service');
    }
  }

  private async setCoolingThresholdTemperature(value): Promise<void> {
    const temperature = Number(value);
    await this.sendCommand({
      power_switch: true,
      hvacmode: HVAC_MODE.COOL,
      temperature: this.fromHomeKitTemperature(temperature),
    });
  }

  private async setTargetHumidity(value): Promise<void> {
    const humidityRange = this.getHumidityRange();
    await this.sendCommand({
      power_switch: true,
      hvacmode: HVAC_MODE.DRY,
      humidity: this.clamp(Number(value), humidityRange.min, humidityRange.max),
    });
  }

  private async setRotationSpeed(value, mode: HvacMode): Promise<void> {
    const speed = this.percentageToSpeed(Number(value));
    await this.sendCommand({
      power_switch: true,
      hvacmode: mode,
      speed,
    });
  }

  private async setSwingMode(value, mode: HvacMode): Promise<void> {
    await this.sendCommand({
      power_switch: true,
      hvacmode: mode,
      swing_switch: Number(value) === HK.SWING_ENABLED || value === true,
    });
  }

  private async setTargetFanState(value): Promise<void> {
    if (Number(value) === HK.TARGET_FAN_AUTO) {
      await this.setFanSpeedSwitch(true, SPEED_AUTO);
    } else if (this.state.speed === SPEED_AUTO) {
      await this.setFanSpeedSwitch(true, 1);
    }
  }

  private async setDisplayOn(value): Promise<void> {
    await this.sendCommand({[this.state.displayKey]: Boolean(value)});
  }

  private async setSleepMode(value): Promise<void> {
    const enabled = Boolean(value);
    if (!enabled && !this.isPresetActive(DREO_MODE.SLEEP)) {
      return;
    }
    await this.sendCommand(enabled
      ? {
        power_switch: true,
        hvacmode: HVAC_MODE.COOL,
        mode: DREO_MODE.SLEEP,
      }
      : {hvacmode: HVAC_MODE.COOL});
  }

  private async setEcoMode(value): Promise<void> {
    const enabled = Boolean(value);
    if (!enabled && !this.isPresetActive(DREO_MODE.ECO)) {
      return;
    }
    await this.sendCommand(enabled
      ? {
        power_switch: true,
        hvacmode: HVAC_MODE.COOL,
        mode: DREO_MODE.ECO,
      }
      : {hvacmode: HVAC_MODE.COOL});
  }

  private async setFanSpeedSwitch(value, speed: number): Promise<void> {
    const enabled = Boolean(value);
    if (!enabled) {
      this.updateHomeKit();
      return;
    }

    const command = {
      power_switch: true,
      speed,
    } as Record<string, unknown>;

    if (!this.state.on) {
      command.hvacmode = this.state.hvacMode;
    }

    await this.sendCommand(command);
  }

  private getCurrentCoolerState(): number {
    return this.isModeActive(HVAC_MODE.COOL) ? HK.CURRENT_HC_COOLING : HK.CURRENT_HC_INACTIVE;
  }

  private getCurrentDryState(): number {
    return this.isModeActive(HVAC_MODE.DRY) ? HK.CURRENT_HD_DEHUMIDIFYING : HK.CURRENT_HD_INACTIVE;
  }

  private getCurrentFanState(): number {
    return this.isModeActive(HVAC_MODE.FAN_ONLY) ? HK.CURRENT_FAN_BLOWING_AIR : HK.CURRENT_FAN_INACTIVE;
  }

  private async sendCommand(command): Promise<void> {
    this.platform.log.debug('AC command:', command);
    const commandAccepted = await this.platform.webHelper.controlOpen(this.sn, command);
    if (!commandAccepted) {
      throw new Error('Dreo rejected the air conditioner command');
    }
    this.applyCommand(command);
    this.updateHomeKit();
    setTimeout(() => {
      void this.refreshFromCloud();
    }, 1500);
  }

  private async refreshFromCloud(): Promise<void> {
    const state = await this.platform.webHelper.getOpenState(this.sn);
    if (state !== undefined) {
      this.loadState(state);
      this.updateHomeKit();
    }
  }

  private loadState(state): void {
    if (!state) {
      return;
    }

    const targetTemp = this.readNumber(state, ['temperature', 'target_temperature', 'targetTemperature']);
    if (targetTemp !== undefined) {
      this.state.temperatureUnit = this.detectTemperatureUnit(targetTemp);
      this.state.targetTemperature = this.toHomeKitTemperature(targetTemp);
      this.state.currentTemperature = this.state.targetTemperature;
    }

    const currentTemp = this.readNumber(state, ['current_temperature', 'currentTemperature', 'room_temperature', 'roomtemp', 'envtemp']);
    if (currentTemp !== undefined) {
      this.state.currentTemperature = this.toHomeKitTemperature(currentTemp);
    }

    const on = this.readBoolean(state, ['power_switch', 'poweron', 'fanon']);
    if (on !== undefined) {
      this.state.on = on;
    }

    const hvacMode = this.readString(state, ['hvacmode', 'hvac_mode']);
    if (hvacMode !== undefined) {
      this.state.hvacMode = this.normalizeHvacMode(hvacMode);
      if (this.readString(state, ['mode']) === undefined) {
        this.state.mode = DREO_MODE.NORMAL;
      }
    }

    const mode = this.readString(state, ['mode']);
    if (mode !== undefined) {
      this.state.mode = mode;
      if (mode === DREO_MODE.SLEEP || mode === DREO_MODE.ECO) {
        this.state.hvacMode = HVAC_MODE.COOL;
      }
    }

    const speed = this.readNumber(state, ['speed', 'windlevel']);
    if (speed !== undefined) {
      this.state.speed = this.clamp(Math.round(speed), 1, SPEED_AUTO);
    }

    const swing = this.readBoolean(state, ['swing_switch', 'oscillate', 'oscon', 'shakehorizon', 'hoscon', 'oscmode']);
    if (swing !== undefined) {
      this.state.swing = swing;
    }

    const humidity = this.readNumber(state, ['humidity', 'target_humidity', 'targetHumidity']);
    if (humidity !== undefined) {
      const humidityRange = this.getHumidityRange();
      this.state.targetHumidity = this.clamp(Math.round(humidity), humidityRange.min, humidityRange.max);
    }

    const currentHumidity = this.readNumber(state, ['humidity_sensor', 'current_humidity', 'currentHumidity', 'rh']);
    if (currentHumidity !== undefined) {
      this.state.currentHumidity = this.clamp(Math.round(currentHumidity), 0, 100);
    } else {
      this.state.currentHumidity = this.state.targetHumidity;
    }

    const displayKey = this.detectDisplayKey(state);
    if (displayKey) {
      this.state.displayKey = displayKey;
      const display = this.readBoolean(state, [displayKey]);
      if (display !== undefined) {
        this.state.displayOn = display;
      }
    }
  }

  private applyCommand(command): void {
    this.loadState(command);
  }

  private updateHomeKit(): void {
    this.coolService.updateCharacteristic(this.platform.Characteristic.Active, this.isModeActive(HVAC_MODE.COOL));
    this.coolService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentCoolerState());
    this.coolService.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.state.targetTemperature);
    this.coolService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
    this.coolService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.speedToPercentage(this.state.speed));
    this.coolService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);

    this.dryService.updateCharacteristic(this.platform.Characteristic.Active, this.isModeActive(HVAC_MODE.DRY));
    this.dryService.updateCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState, this.getCurrentDryState());
    this.dryService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.state.currentHumidity);
    this.dryService.updateCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold, this.state.targetHumidity);
    this.dryService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.speedToPercentage(this.state.speed));
    this.dryService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);

    this.fanService.updateCharacteristic(this.platform.Characteristic.Active, this.isModeActive(HVAC_MODE.FAN_ONLY));
    this.fanService.updateCharacteristic(this.platform.Characteristic.CurrentFanState, this.getCurrentFanState());
    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.speedToPercentage(this.state.speed));
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.TargetFanState,
      this.state.speed === SPEED_AUTO ? HK.TARGET_FAN_AUTO : HK.TARGET_FAN_MANUAL,
    );
    this.fanService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.state.swing ? HK.SWING_ENABLED : HK.SWING_DISABLED);

    this.displaySwitchService.updateCharacteristic(this.platform.Characteristic.On, this.state.displayOn);
    this.sleepSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.isPresetActive(DREO_MODE.SLEEP));
    this.ecoSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.isPresetActive(DREO_MODE.ECO));
    this.fanSpeed1SwitchService.updateCharacteristic(this.platform.Characteristic.On, this.state.speed === 1);
    this.fanSpeed2SwitchService.updateCharacteristic(this.platform.Characteristic.On, this.state.speed === 2);
    this.fanSpeed3SwitchService.updateCharacteristic(this.platform.Characteristic.On, this.state.speed === 3);
    this.autoFanSwitchService.updateCharacteristic(this.platform.Characteristic.On, this.state.speed === SPEED_AUTO);
  }

  private isModeActive(mode: HvacMode): boolean {
    return this.state.on && this.state.hvacMode === mode;
  }

  private isPresetActive(mode: string): boolean {
    return this.isModeActive(HVAC_MODE.COOL) && this.state.mode === mode;
  }

  private normalizeHvacMode(value: string): HvacMode {
    const mode = String(value).toLowerCase();
    if (mode === HVAC_MODE.DRY || mode.includes('dry')) {
      return HVAC_MODE.DRY;
    }
    if (mode === HVAC_MODE.FAN_ONLY || mode.includes('fan')) {
      return HVAC_MODE.FAN_ONLY;
    }
    return HVAC_MODE.COOL;
  }

  private percentageToSpeed(value: number): number {
    if (value >= 88) {
      return SPEED_AUTO;
    }
    if (value >= 63) {
      return 3;
    }
    if (value >= 38) {
      return 2;
    }
    return 1;
  }

  private speedToPercentage(value: number): number {
    if (value >= SPEED_AUTO) {
      return 100;
    }
    return this.clamp(value, 1, 3) * 25;
  }

  private detectTemperatureUnit(value: number): TemperatureUnit {
    return value > 45 ? 'fahrenheit' : 'celsius';
  }

  private getFanEntityConfig(): Record<string, any> {
    return this.accessory.context.device?.config?.fan_entity_config ||
      this.accessory.context.device?.config?.fanEntityConfig ||
      {};
  }

  private getTemperatureRange(): {min: number; max: number} {
    const configuredRange = this.getFanEntityConfig().temperature_range;
    if (!Array.isArray(configuredRange) || configuredRange.length < 2) {
      return {min: 18, max: 30};
    }

    const min = this.state.temperatureUnit === 'fahrenheit'
      ? this.toCelsius(Number(configuredRange[0]))
      : Number(configuredRange[0]);
    const max = this.state.temperatureUnit === 'fahrenheit'
      ? this.toCelsius(Number(configuredRange[1]))
      : Number(configuredRange[1]);
    return {
      min: Math.ceil(min),
      max: Math.floor(max),
    };
  }

  private getHumidityRange(): {min: number; max: number} {
    const configuredRange = this.getFanEntityConfig().humidity_range;
    if (!Array.isArray(configuredRange) || configuredRange.length < 2) {
      return {min: 40, max: 70};
    }
    return {
      min: Number(configuredRange[0]),
      max: Number(configuredRange[1]),
    };
  }

  private toHomeKitTemperature(value: number): number {
    return this.state.temperatureUnit === 'fahrenheit' ? this.toCelsius(value) : value;
  }

  private fromHomeKitTemperature(value: number): number {
    return this.state.temperatureUnit === 'fahrenheit' ? Math.round((value * 9 / 5) + 32) : Math.round(value);
  }

  private toCelsius(value: number): number {
    return Math.round(((value - 32) * 5 / 9) * 10) / 10;
  }

  private detectDisplayKey(state): string | undefined {
    const configuredField = this.getConfiguredDisplayField();
    if (configuredField) {
      return configuredField;
    }

    return ['led_switch', 'light_switch', 'dispmode', 'display_mode', 'displayon', 'lighton']
      .find(key => this.readRawValue(state, key) !== undefined);
  }

  private getConfiguredDisplayField(): string | undefined {
    const toggleConfig = this.accessory.context.device?.config?.toggle_entity_config ||
      this.accessory.context.device?.config?.toggleEntityConfig ||
      this.accessory.context.device?.toggle_entity_config;

    if (!toggleConfig || typeof toggleConfig !== 'object') {
      return undefined;
    }

    const toggles = Object.values(toggleConfig);
    const displayToggle = toggles.find((toggle: any) => {
      const field = String(toggle?.field || '').toLowerCase();
      const label = String(toggle?.labelName || toggle?.name || '').toLowerCase();
      return ['led_switch', 'light_switch', 'dispmode', 'display_mode'].includes(field) ||
        label.includes('display') ||
        label.includes('screen') ||
        label.includes('led');
    }) as any;

    return displayToggle?.field;
  }

  private readString(state, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.readRawValue(state, key);
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }
    return undefined;
  }

  private readNumber(state, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = this.readRawValue(state, key);
      if (value !== undefined && value !== null && value !== '') {
        const numberValue = Number(value);
        if (!isNaN(numberValue)) {
          return numberValue;
        }
      }
    }
    return undefined;
  }

  private readBoolean(state, keys: string[]): boolean | undefined {
    for (const key of keys) {
      const value = this.readRawValue(state, key);
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value === 'number') {
        return value !== 0;
      }

      const normalized = String(value).toLowerCase();
      if (['true', '1', 'on', 'enabled', 'open'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'off', 'disabled', 'close', 'closed'].includes(normalized)) {
        return false;
      }
    }
    return undefined;
  }

  private readRawValue(state, key: string) {
    const value = state?.[key];
    if (value && typeof value === 'object' && 'state' in value) {
      return value.state;
    }
    return value;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

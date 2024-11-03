<p align="center">
  <img src="https://play-lh.googleusercontent.com/8qg4gA2ZhxBNPPSlp3zT4Z54Meh-emx-JXs8M0H78_4ExRA1qE0aNpO00bI_2lbWo5g=w480-h960-rw" width=150>
</p>

# Homebridge Dreo Plugin

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM Version](https://img.shields.io/npm/v/homebridge-dreo.svg)](https://www.npmjs.com/package/homebridge-dreo)
[![npm](https://img.shields.io/npm/dt/homebridge-dreo)](https://www.npmjs.com/package/homebridge-dreo)

Homebridge plugin for Dreo brand smart devices. [Dreo Fans on Amazon](https://www.amazon.com/s?k=Dreo+Smart+Fan&linkCode=ll2&tag=zyonse-20&linkId=45e21dea18d40bc4d1d9244334dae1fe&language=en_US&ref_=as_li_ss_tl) (Affiliate link)
<p align="center">
  <img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/7cd2578d-48a3-47bd-a5ed-dca129a02f91" width=200>
  <img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/1f1d85e6-5bbf-46b5-be7f-6edf95727327" width=200>
  <img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/d5095dd8-3dbe-4f31-9309-1b37c6f62eeb" width=200>
</p>
<p align="center">
  <img src="https://github.com/user-attachments/assets/81bd06d3-5a40-4516-9cf0-bacbd704e689" width=200>
  <img src="https://github.com/user-attachments/assets/25488e2a-3ac7-4370-9912-072dae31d7d5" width=200>
  <img src="https://github.com/user-attachments/assets/17e6350d-ec68-48e8-88da-3bd553dffbf2" width=200>
</p>

## Compatability

### Confirmed Working

#### Fans

* DR-HAF001S
* DR-HAF003S
* DR-HAF004S
* DR-HCF003S
* DR-HPF001S
* DR-HPF002S
* DR-HTF001S
* DR-HTF002S
* DR-HTF004S
* DR-HTF005S
* DR-HTF007S

#### Heaters

* DR-HSH004S
* DR-HSH009S
* ‎DR-HSH017S

Please open an issue if you have another model that works or doesn't work. If you have another device type and can help me test some code out I would definitely be open to adding support.

## Supported Features

### Fans

* **Fan Speed:** Fan speed is displayed as a percentage value with steps that are equivalent to those of the Dreo app. (for example, a fan with speeds 1-6 will have steps at 17%, 33%, 50% etc)

* **Oscillate:** Toggles fan oscillation
* **Temperature Sensor:** Displays current temperature sensor reading. (for supported devices, check your devices capabilities) Because the Dreo fan temperature sensors are not entirely accurate, you can also set a specific temperature offset for your devices.
* **Child Lock:** Lock physical fan controls

### Heaters

#### Heaters are displayed as a thermostat accessory with the following control mappings

* **Heat Mode:** Controls Dreo 'Eco' mode
* **Cool Mode:** Controls Dreo 'Fan Only' mode
* **Auto Mode:** Controls Dreo 'Heat' speeds, represented as an offset from the minimum temperature (for example, a heater with speeds 1-3 and a minimum temp of 41F can be controlled by setting temperature to 41, 42, 43)
* **Current Temperature:** Displays current temperature sensor reading
* **Fan Speed:** Controls heater vent angle
* **Oscillate:** Toggles heater vent oscillation
* **Child Lock:** Lock physical heater controls
* **Hardware Display:** Changes temperature unit on physical hardware display

## Installation

```bash
npm install -g homebridge-dreo
```

(Or install through the Homebridge UI)

## Configuration

Provide your Dreo app login credentials

```json
"platforms": [
  {
    "options": {
      "email": "email@example.com",
      "password": "00000000"
    },
    "hideTemperatureSensor": false,
    "temperatureOffset": 0,
    "name": "Dreo Platform",
    "platform": "DreoPlatform"
  }
]
```

## Contributing

If you'd like to add support for a new device type, you might find this writeup from [@JeffSteinbok](https://github.com/JeffSteinbok) (HomeAssistant plugin maintainer) useful for tracing the Dreo App:

https://github.com/JeffSteinbok/hass-dreo/blob/main/contributing.md

## Special thanks

[homebridge-tp-link-tapo](https://github.com/RaresAil/homebridge-tp-link-tapo): Similar repo that helped me figure out some of the http request functions necessary for this project.

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

## Compatability
### Confirmed Working
#### Tower Fans
* DR-HTF001S
* DR-HTF002S
* DR-HTF004S
* DR-HTF005S
* DR-HTF007S
#### Pedestal Fans
* DR-HPF001S
* DR-HAF003S
#### Other Fans
* DR-HAF004S (Table Fan)

Please open an issue if you have another model that works or doesn't work. The plugin *should* also be compatible with multiple devices on the same account but I haven't tested this. Non-fan smart devices are not supported at this time, but if you have another device and can help me test some code out I would definitely be open to adding support.

## Features
- **Temperature Sensor Display:** Display the temperature sensor detected within your devices (for supported devices, check your devices capabilities). Because the Dreo devices temperature sensors are not entirely accurate, you can also set a specific temperature offset for your devices.

## Installation
```
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

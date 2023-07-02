
<p align="center">

<img src="https://play-lh.googleusercontent.com/8qg4gA2ZhxBNPPSlp3zT4Z54Meh-emx-JXs8M0H78_4ExRA1qE0aNpO00bI_2lbWo5g=w480-h960-rw" width=150>

</p>


# Homebridge Dreo Plugin
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://img.shields.io/npm/dt/homebridge-dreo)](https://www.npmjs.com/package/homebridge-dreo)

Homebridge plugin for Dreo brand smart devices.
<p align="center">
<img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/557325f4-8872-40a7-b4a8-7a4ce5f55430" width=200>
</p>

## Compatability
### Confirmed Working
#### Tower Fans
* DR-HTF001S
* DR-HTF002S
* DR-HTF005S
* DR-HTF007S
#### Table Fans
* DR-HAF004S

Please let me know if you have another model that works or doesn't work. The plugin *should* also be compatible with multiple devices on the same account but I haven't tested this. Non-fan smart devices are not supported at this time, but if you have another device and can help me test some code out I would definitely be open to adding support.
## Installation
```
npm i homebridge-dreo
```
(Or install through the Homebridge UI)

## Configuration
Provide your Dreo app login credentials
```json
{
  "platforms": [
    {
      "options": {
         "email": "email@example.com",
         "password": "00000000"
      },
      "name": "Dreo Platform",
      "platform": "DreoPlatform",
    }
  ]
}
```

## Special thanks
[homebridge-tp-link-tapo](https://github.com/RaresAil/homebridge-tp-link-tapo): Similar repo that helped me figure out some of the http request functions necessary for this project.

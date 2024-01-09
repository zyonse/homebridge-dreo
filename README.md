
<p align="center">

<img src="https://play-lh.googleusercontent.com/8qg4gA2ZhxBNPPSlp3zT4Z54Meh-emx-JXs8M0H78_4ExRA1qE0aNpO00bI_2lbWo5g=w480-h960-rw" width=150>

</p>


# Homebridge Dreo Plugin
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM Version](https://img.shields.io/npm/v/homebridge-dreo.svg)](https://www.npmjs.com/package/homebridge-dreo)

Homebridge plugin for Dreo brand smart devices. [Dreo Fans on Amazon](https://www.amazon.com/s?k=Dreo+Smart+Fan&linkCode=ll2&tag=yozak-20&linkId=37ac94920f6842a3563ba383ded90e00&language=en_US&ref_=as_li_ss_tl) (Affiliate link)
<p align="center">
<img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/dd396181-cd27-423c-be2c-fc5892bd3e32" width=200>
<img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/c7e9d5ac-7c20-4e19-939c-c4193effd46a" width=200>
<img src="https://github.com/zyonse/homebridge-dreo/assets/28782587/bfe7311d-3e3d-444f-95a5-c8e1a1ebd8b9" width=200>
</p>

## Compatability
### Confirmed Working
#### Tower Fans
* DR-HTF001S
* DR-HTF002S
* DR-HTF004S
* DR-HTF005S
* DR-HTF007S
#### Other Fans
* DR-HAF003S (Pedestal Fan)
* DR-HAF004S (Table Fan)

Please open an issue if you have another model that works or doesn't work. The plugin *should* also be compatible with multiple devices on the same account but I haven't tested this. Non-fan smart devices are not supported at this time, but if you have another device and can help me test some code out I would definitely be open to adding support.
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

## Contributing
If you'd like to add support for a new device type, you might find this writeup from [@JeffSteinbok](https://github.com/JeffSteinbok) (HomeAssistant plugin maintainer) useful for tracing the Dreo App:

https://github.com/JeffSteinbok/hass-dreo/blob/main/contributing.md

## Special thanks
[homebridge-tp-link-tapo](https://github.com/RaresAil/homebridge-tp-link-tapo): Similar repo that helped me figure out some of the http request functions necessary for this project.

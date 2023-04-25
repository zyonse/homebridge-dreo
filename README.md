
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>


# Homebridge Dreo Plugin

This is a Homebridge plugin that allows you to control Dreo smart devices.

## Compatability
I've tested this plugin with my DR-HTF001S Tower Fan. It should work with other smart fans but I don't have any more to test. Please let me know if you have another model that works or doesn't work. The plugin *should* also be compatible with multiple devices on the same account but I haven't tested this. Non-fan smart devices are not supported at this time, but if you have another device and can help me test some code out I would definitely be open to adding support.

## Installation
npm i homebridge-dreo
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

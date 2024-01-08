import axios from 'axios';
import MD5 from 'crypto-js/md5';
import ReconnectingWebSocket from 'reconnecting-websocket';
import WebSocket from 'ws';

// Follows same request structure as the mobile app
export default class DreoAPI {
  // Get authentication token
  public async authenticate(platform, email, password, server) {
    let token;
    await axios.post('https://app-api-'+server+'.dreo-cloud.com/api/oauth/login', {
      'client_id': '7de37c362ee54dcf9c4561812309347a',
      'client_secret': '32dfa0764f25451d99f94e1693498791',
      'email': email,
      'encrypt': 'ciphertext',
      'grant_type': 'email-password',
      'himei': 'faede31549d649f58864093158787ec9',
      'password': MD5(password).toString(),  // MD5 hash is sent instead of actual password
      'scope': 'all',
    }, {
      params: {
        'timestamp': Date.now(),
      },
      headers: {
        'ua': 'dreo/2.5.12 (sdk_gphone64_arm64;android 13;Scale/2.625)',
        'lang': 'en',
        'content-type': 'application/json; charset=UTF-8',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    })
      .then((response) => {
        token = response.data.data;
      })
      .catch((error) => {
        platform.log.error('error retrieving token:', error);
        token = undefined;
      });
    return token;
  }

  // Return device list
  public async getDevices(platform, auth) {
    let devices;
    await axios.get('https://app-api-'+auth.server+'.dreo-cloud.com/api/v2/user-device/device/list', {
      params: {
        'pageSize': 1000,
        'currentPage': 1,
        'timestamp': Date.now(),
      },
      headers: {
        'authorization': 'Bearer ' + auth.access_token,
        'ua': 'dreo/2.5.12 (sdk_gphone64_arm64;android 13;Scale/2.625)',
        'lang': 'en',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    })
      // Catch and log errors
      .then((response) => {
        devices = response.data.data.list;
      })
      .catch((error) => {
        platform.log.error('error retrieving device list:', error);
        devices = undefined;
      });
    return devices;
  }

  // used to initialize power state, speed values on boot
  public async getState(platform, sn, auth) {
    let state;
    await axios.get('https://app-api-'+auth.server+'.dreo-cloud.com/api/user-device/device/state', {
      params: {
        'deviceSn': sn,
        'timestamp': Date.now(),
      },
      headers: {
        'authorization': 'Bearer ' + auth.access_token,
        'ua': 'dreo/2.5.12 (sdk_gphone64_arm64;android 13;Scale/2.625)',
        'lang': 'en',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    })
      .then((response) => {
        state = response.data.data.mixed;
      })
      .catch((error) => {
        platform.log.error('error retrieving device state:', error);
        state = undefined;
      });
    return state;
  }

  // open websocket for outgoing fan commands, websocket will auto-reconnect if a connection error occurs
  // websocket is also used to monitor incoming state changes from hardware controls
  public async startWebSocket(platform, auth) {
    // open websocket
    const url = 'wss://wsb-'+auth.server+'.dreo-cloud.com/websocket?accessToken='+auth.access_token+'&timestamp='+Date.now();
    platform.log.debug(url);
    const ws = new ReconnectingWebSocket(
      url,
      [],
      {WebSocket: WebSocket});

    ws.addEventListener('error', error => {
      platform.log.debug('WebSocket', error);
    });

    ws.addEventListener('open', () => {
      platform.log.debug('WebSocket Opened');
    });

    ws.addEventListener('close', () => {
      platform.log.debug('WebSocket Closed');
    });

    // keep connection open by sending empty packet every 15 seconds
    setInterval(() => ws.send('2'), 15000);

    return ws;
  }
}
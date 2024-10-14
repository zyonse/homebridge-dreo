import axios from 'axios';
import MD5 from 'crypto-js/md5';
import ReconnectingWebSocket from 'reconnecting-websocket';
import WebSocket from 'ws';
import type { DreoPlatform } from './platform';
import type { Logger } from 'homebridge';

// User agent string for API requests
const ua = 'dreo/2.8.1 (iPhone; iOS 18.0.0; Scale/3.00)';

// Follows same request structure as the mobile app
export default class DreoAPI {
  private readonly email: string;
  private readonly password: string;
  private readonly log: Logger;
  private access_token: string;
  private ws: WebSocket;
  public server: string;

  constructor(platform: DreoPlatform) {
    this.log = platform.log;
    this.email = platform.config.options.email;
    this.password = platform.config.options.password;
    this.server = 'us';
    this.access_token = '';
  }

  // Get authentication token
  public async authenticate() {
    let auth;
    await axios.post('https://app-api-'+this.server+'.dreo-cloud.com/api/oauth/login', {
      'client_id': '7de37c362ee54dcf9c4561812309347a',
      'client_secret': '32dfa0764f25451d99f94e1693498791',
      'email': this.email,
      'encrypt': 'ciphertext',
      'grant_type': 'email-password',
      'himei': 'faede31549d649f58864093158787ec9',
      'password': MD5(this.password).toString(),  // MD5 hash is sent instead of actual password
      'scope': 'all',
    }, {
      params: {
        'timestamp': Date.now(),
      },
      headers: {
        'ua': ua,
        'lang': 'en',
        'content-type': 'application/json; charset=UTF-8',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    })
      .then((response) => {
        const payload = response.data;
        if (payload.data && payload.data.access_token) {
          // Auth success
          auth = payload.data;
          this.access_token = auth.access_token;
        } else {
          this.log.error('error retrieving token:', payload.msg);
          auth = undefined;
        }
      })
      .catch((error) => {
        this.log.error('error retrieving token:', error);
        auth = undefined;
      });
    return auth;
  }

  // Return device list
  public async getDevices() {
    let devices;
    await axios.get('https://app-api-'+this.server+'.dreo-cloud.com/api/v2/user-device/device/list', {
      params: {
        'pageSize': 1000,
        'currentPage': 1,
        'timestamp': Date.now(),
      },
      headers: {
        'authorization': 'Bearer ' + this.access_token,
        'ua': ua,
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
        this.log.error('error retrieving device list:', error);
        devices = undefined;
      });
    return devices;
  }

  // Used to initialize power state, speed values on boot
  public async getState(sn) {
    let state;
    await axios.get('https://app-api-'+this.server+'.dreo-cloud.com/api/user-device/device/state', {
      params: {
        'deviceSn': sn,
        'timestamp': Date.now(),
      },
      headers: {
        'authorization': 'Bearer ' + this.access_token,
        'ua': ua,
        'lang': 'en',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    })
      .then((response) => {
        state = response.data.data.mixed;
      })
      .catch((error) => {
        this.log.error('error retrieving device state:', error);
        state = undefined;
      });
    return state;
  }

  // Open websocket for outgoing fan commands, websocket will auto-reconnect if a connection error occurs
  // Websocket is also used to monitor incoming state changes from hardware controls
  public async startWebSocket() {
    // open websocket
    const url = 'wss://wsb-'+this.server+'.dreo-cloud.com/websocket?accessToken='+this.access_token+'&timestamp='+Date.now();
    this.ws = new ReconnectingWebSocket(
      url,
      [],
      {WebSocket: WebSocket});

    this.ws.addEventListener('error', error => {
      this.log.debug('WebSocket', error);
    });

    this.ws.addEventListener('open', () => {
      this.log.debug('WebSocket Opened');
    });

    this.ws.addEventListener('close', () => {
      this.log.debug('WebSocket Closed');
    });

    // Keep connection open by sending empty packet every 15 seconds
    setInterval(() => this.ws.send('2'), 15000);
  }

  // Allow devices to add event listeners to the WebSocket
  public addEventListener(event, listener) {
    this.ws.addEventListener(event, listener);
  }

  // Send control commands to device (fan speed, power, etc)
  public control(sn, command) {
    this.ws.send(JSON.stringify({
      'deviceSn': sn,
      'method': 'control',
      'params': command,
      'timestamp': Date.now(),
    }));
  }
}
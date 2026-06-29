import axios from 'axios';
import MD5 from 'crypto-js/md5';
import ReconnectingWebSocket from 'reconnecting-websocket';
import WebSocket from 'ws';
import type { DreoPlatform } from './platform';
import type { Logger } from 'homebridge' with { 'resolution-mode': 'import' };

// User agent string for API requests
const ua = 'dreo/2.8.1 (iPhone; iOS 18.0.0; Scale/3.00)';
const openApiUa = 'openapi/1.0.0';
const openApiVersion = '1.0.0';
const openApiClientId = '89ef537b2202481aaaf9077068bcb0c9';
const openApiClientSecret = '41b20a1f60e9499e89c8646c31f93ea1';

// Follows same request structure as the mobile app
export default class DreoAPI {
  private readonly email: string;
  private readonly password: string;
  private readonly log: Logger;
  private access_token: string;
  private open_access_token: string;
  private open_endpoint: string;
  private ws: WebSocket;
  public server: string;

  constructor(platform: DreoPlatform) {
    this.log = platform.log;
    this.email = platform.config.options?.email;
    this.password = platform.config.options?.password;
    this.server = 'us';
    this.access_token = '';
    this.open_access_token = '';
    this.open_endpoint = 'https://open-api-us.dreo-tech.com';
  }

  // Get authentication token
  public async authenticate() {
    let auth;
    await axios.post('https://app-api-'+this.server+'.dreo-tech.com/api/oauth/login', {
      'client_id': 'd8a56a73d93b427cad801116dc4d3188',
      'client_secret': '2ac9b179f7e84be58bb901d6ed8bf374',
      'email': this.email,
      'encrypt': 'ciphertext',
      'grant_type': 'email-password',
      'himei': '463299817f794e52a228868167df3f34',
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
        this.logRequestError('error retrieving token', error);
        auth = undefined;
      });
    return auth;
  }

  // Authenticate against Dreo's Open API. Newer devices such as HAC air
  // conditioners expose their canonical control directives here.
  public async authenticateOpenAPI() {
    let auth;
    await axios.post('https://open-api-us.dreo-tech.com/api/oauth/login', {
      'client_id': openApiClientId,
      'client_secret': openApiClientSecret,
      'email': this.email,
      'grant_type': 'openapi',
      'password': MD5(this.password).toString(),
      'scope': 'all',
    }, {
      params: {
        'timestamp': Date.now(),
        'pydreover': openApiVersion,
      },
      headers: {
        'UA': openApiUa,
        'content-type': 'application/json',
      },
    })
      .then((response) => {
        const payload = response.data;
        if (payload.code === 0 && payload.data && payload.data.access_token) {
          auth = payload.data;
          this.open_access_token = auth.access_token;
          this.open_endpoint = this.getOpenAPIEndpoint(auth.access_token);
        } else {
          this.log.error('error retrieving Open API token:', payload.msg);
          auth = undefined;
        }
      })
      .catch((error) => {
        this.logRequestError('error retrieving Open API token', error);
        auth = undefined;
      });
    return auth;
  }

  // Return device list
  public async getDevices() {
    let devices;
    await axios.get('https://app-api-'+this.server+'.dreo-tech.com/api/app/index/family/room/devices', {
      params: {
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
        this.logRequestError('error retrieving device list', error);
        devices = undefined;
      });
    return devices;
  }

  // Return devices and model capabilities from the Dreo Open API.
  public async getOpenDevices() {
    let devices;
    await axios.get(this.open_endpoint + '/api/device/list', {
      params: {
        'timestamp': Date.now(),
        'pydreover': openApiVersion,
      },
      headers: {
        'authorization': 'Bearer ' + this.getCleanOpenAPIToken(),
        'UA': openApiUa,
        'content-type': 'application/json',
      },
    })
      .then((response) => {
        const payload = response.data;
        if (payload.code === 0) {
          devices = payload.data;
        } else {
          this.log.error('error retrieving Open API device list:', payload.msg);
          devices = undefined;
        }
      })
      .catch((error) => {
        this.logRequestError('error retrieving Open API device list', error);
        devices = undefined;
      });
    return devices;
  }

  // Used to initialize power state, speed values on boot
  public async getState(sn) {
    let state;
    await axios.get('https://app-api-'+this.server+'.dreo-tech.com/api/user-device/device/state', {
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
        this.logRequestError('error retrieving device state', error);
        state = undefined;
      });
    return state;
  }

  // Return device state from the Dreo Open API.
  public async getOpenState(sn) {
    let state;
    await axios.get(this.open_endpoint + '/api/device/state', {
      params: {
        'deviceSn': sn,
        'timestamp': Date.now(),
        'pydreover': openApiVersion,
      },
      headers: {
        'authorization': 'Bearer ' + this.getCleanOpenAPIToken(),
        'UA': openApiUa,
        'content-type': 'application/json',
      },
    })
      .then((response) => {
        const payload = response.data;
        if (payload.code === 0) {
          state = payload.data;
        } else {
          this.log.error('error retrieving Open API device state:', payload.msg);
          state = undefined;
        }
      })
      .catch((error) => {
        this.logRequestError('error retrieving Open API device state', error);
        state = undefined;
      });
    return state;
  }

  // Open websocket for outgoing fan commands, websocket will auto-reconnect if a connection error occurs
  // Websocket is also used to monitor incoming state changes from hardware controls
  public async startWebSocket() {
    // open websocket
    const url = 'wss://wsb-'+this.server+'.dreo-tech.com/websocket?accessToken='+this.access_token+'&timestamp='+Date.now();
    this.ws = new ReconnectingWebSocket(
      url,
      [],
      {WebSocket: WebSocket});

    this.ws.addEventListener('error', () => {
      this.log.debug('WebSocket error');
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

  // Send control commands through the Dreo Open API.
  public async controlOpen(sn, command) {
    let result;
    await axios.post(this.open_endpoint + '/api/device/control', {
      'devicesn': sn,
      'desired': command,
    }, {
      params: {
        'timestamp': Date.now(),
        'pydreover': openApiVersion,
      },
      headers: {
        'authorization': 'Bearer ' + this.getCleanOpenAPIToken(),
        'UA': openApiUa,
        'content-type': 'application/json',
      },
    })
      .then((response) => {
        const payload = response.data;
        if (payload.code === 0) {
          result = true;
        } else {
          this.log.error('error sending Open API command:', payload.msg);
          result = undefined;
        }
      })
      .catch((error) => {
        this.logRequestError('error sending Open API command', error);
        result = undefined;
      });
    return result;
  }

  private logRequestError(context: string, error: unknown): void {
    if (axios.isAxiosError(error)) {
      const details = [
        error.response?.status ? `HTTP ${error.response.status}` : undefined,
        error.code,
        error.message,
      ].filter(Boolean).join(', ');
      this.log.error(`${context}: ${details || 'request failed'}`);
      return;
    }

    const message = error instanceof Error ? error.message : 'request failed';
    this.log.error(`${context}: ${message}`);
  }

  private getOpenAPIEndpoint(accessToken: string): string {
    const region = accessToken.includes(':') ? accessToken.split(':')[1].toUpperCase() : 'NA';
    return region === 'EU'
      ? 'https://open-api-eu.dreo-tech.com'
      : 'https://open-api-us.dreo-tech.com';
  }

  private getCleanOpenAPIToken(): string {
    return this.open_access_token.includes(':')
      ? this.open_access_token.split(':')[0]
      : this.open_access_token;
  }
}

import axios from 'axios';
import MD5 from 'crypto-js/md5';
import DreoWebSocket from './DreoWebSocket';
import type { DreoPlatform } from './platform';
import type { Logger } from 'homebridge';

// User agent string for API requests
const ua = 'dreo/2.8.1 (iPhone; iOS 18.0.0; Scale/3.00)';

// The device applies one control message at a time. When HomeKit writes several
// characteristics at once (a scene, or turning a fan and its light on together) the
// messages reach the device back-to-back and it silently drops all but one. The Dreo
// server acks each of them with control-reply regardless, so the drop is invisible
// unless you watch for the control-report the device sends when it really applies a
// change. Outgoing commands are therefore queued per device: writes to the same
// subsystem are merged into one message, and messages are spaced far enough apart for
// the device to keep up (observed: ~0.5s is enough, same-tick bursts always fail).
const COMMAND_GROUPS: Record<string, string> = {
  lighton: 'light',
  brightness: 'light',
  colortemp: 'light',
};
const DEFAULT_COMMAND_GROUP = 'device';
// Window for merging characteristics HomeKit writes together into a single message
const COMMAND_COALESCE_MS = 100;
const MIN_COMMAND_GAP_MS = 750;
// Delay after the last command before pulling authoritative state over HTTP, so
// HomeKit gets corrected when the device ignored what we sent
const RECONCILE_DELAY_MS = 5000;

interface QueuedCommand {
  group: string;
  params: Record<string, unknown>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Follows same request structure as the mobile app
export default class DreoAPI {
  private readonly email: string;
  private readonly password: string;
  private readonly log: Logger;
  private readonly platform: DreoPlatform;
  private access_token: string;
  private ws!: DreoWebSocket;
  public server: string;

  // Pending outgoing commands per device serial, plus the drain/reconcile bookkeeping
  private readonly commandQueues = new Map<string, QueuedCommand[]>();
  private readonly draining = new Set<string>();
  private readonly lastCommandSent = new Map<string, number>();
  private readonly reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(platform: DreoPlatform) {
    this.log = platform.log;
    this.platform = platform;
    this.email = platform.config.options?.email;
    this.password = platform.config.options?.password;
    this.server = 'us';
    this.access_token = '';
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
        this.log.error('error retrieving token:', error);
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
        this.log.error('error retrieving device list:', error);
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
        this.log.error('error retrieving device state:', error);
        state = undefined;
      });
    return state;
  }

  // Open websocket for outgoing fan commands, websocket will auto-reconnect if a connection error occurs
  // Websocket is also used to monitor incoming state changes from hardware controls
  public async startWebSocket() {
    this.ws = new DreoWebSocket(async (attempt) => {
      // The URL is rebuilt for every attempt: the timestamp must be current, and the access token
      // may have expired while we were disconnected. Re-authenticate once retries start failing.
      if (attempt >= 2) {
        this.log.debug('Refreshing access token before WebSocket reconnect');
        await this.authenticate();
      }
      return 'wss://wsb-'+this.server+'.dreo-tech.com/websocket?accessToken='+this.access_token+'&timestamp='+Date.now();
    }, this.log);

    this.ws.start();
  }

  // Close the websocket and stop reconnecting (called on Homebridge shutdown)
  public stopWebSocket() {
    this.ws?.stop();
  }

  // Allow devices to add event listeners to the WebSocket
  public addEventListener(event, listener) {
    this.ws.addEventListener(event, listener);
  }

  // Send control commands to device (fan speed, power, etc). Commands are queued and
  // paced rather than written straight to the socket - see COMMAND_GROUPS above.
  public control(sn: string, command: Record<string, unknown>) {
    const group = DreoAPI.commandGroup(command);
    let queue = this.commandQueues.get(sn);
    if (queue === undefined) {
      queue = [];
      this.commandQueues.set(sn, queue);
    }

    // Merge into a message that has not been sent yet so a burst of HomeKit writes to
    // the same subsystem leaves as one command
    const pending = queue.find((entry) => entry.group === group);
    if (pending !== undefined) {
      Object.assign(pending.params, command);
    } else {
      queue.push({ group, params: { ...command } });
    }

    if (!this.draining.has(sn)) {
      this.drainCommands(sn);
    }
  }

  private static commandGroup(command: Record<string, unknown>): string {
    for (const key of Object.keys(command)) {
      if (COMMAND_GROUPS[key] !== undefined) {
        return COMMAND_GROUPS[key];
      }
    }
    return DEFAULT_COMMAND_GROUP;
  }

  private async drainCommands(sn: string) {
    this.draining.add(sn);
    try {
      // Let the rest of this HomeKit write burst arrive before sending anything
      await delay(COMMAND_COALESCE_MS);
      const queue = this.commandQueues.get(sn) ?? [];
      while (queue.length > 0) {
        // The gap is measured against the device rather than this drain pass, so a
        // command queued just after a previous batch finished still gets spaced out
        const sinceLastSend = Date.now() - (this.lastCommandSent.get(sn) ?? 0);
        if (sinceLastSend < MIN_COMMAND_GAP_MS) {
          await delay(MIN_COMMAND_GAP_MS - sinceLastSend);
        }
        await this.waitForOpenSocket();
        const next = queue.shift();
        if (next === undefined) {
          break;
        }
        this.lastCommandSent.set(sn, Date.now());
        this.ws.send(JSON.stringify({
          'deviceSn': sn,
          'method': 'control',
          'params': next.params,
          'timestamp': Date.now(),
        }));
      }
    } catch (error) {
      this.log.error('error sending command:', error);
    } finally {
      this.commandQueues.delete(sn);
      this.draining.delete(sn);
      this.scheduleReconcile(sn);
    }
  }

  // DreoWebSocket drops sends made while disconnected, so hold queued commands until
  // the socket reconnects rather than losing them
  private async waitForOpenSocket(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.ws.isOpen && Date.now() < deadline) {
      await delay(200);
    }
  }

  // control-reply only means the server received the command, so pull real state from
  // the HTTP API once things settle and let the device correct HomeKit
  private scheduleReconcile(sn: string) {
    const existing = this.reconcileTimers.get(sn);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.reconcileTimers.set(sn, setTimeout(() => {
      this.reconcileTimers.delete(sn);
      this.platform.reconcileDevice(sn);
    }, RECONCILE_DELAY_MS));
  }
}

import WebSocket from 'ws';
import type { Logger } from 'homebridge';

// Reconnect backoff bounds
const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;
// Dreo's servers drop idle connections, so send an app-level keepalive on this interval
const KEEPALIVE_INTERVAL = 15000;
// How long to wait for a pong before assuming the connection is half-open
const PONG_TIMEOUT = 10000;
// How long to wait for the handshake to complete before giving up and retrying
const CONNECT_TIMEOUT = 10000;

type Listener = (event) => void;

// Timings are overridable so tests can exercise reconnect/keepalive behaviour quickly
export interface DreoWebSocketOptions {
  keepaliveInterval?: number;
  pongTimeout?: number;
  connectTimeout?: number;
  minReconnectDelay?: number;
  maxReconnectDelay?: number;
}

/**
 * Auto-reconnecting WebSocket client for the Dreo cloud.
 *
 * Listeners are held here rather than on the underlying socket, so registrations made once at
 * startup survive every reconnect. The socket itself is disposable; this wrapper is not.
 */
export default class DreoWebSocket {
  private ws?: WebSocket;
  private readonly listeners = new Map<string, Set<Listener>>();
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private attempt = 0;
  private stopped = false;
  // Only enforce the pong timeout if the server has actually answered a ping at least once
  private pongSupported = false;
  private readonly keepaliveInterval: number;
  private readonly pongTimeout: number;
  private readonly connectTimeout: number;
  private readonly minReconnectDelay: number;
  private readonly maxReconnectDelay: number;

  // getUrl is called before every connection attempt so the token and timestamp are always current
  constructor(
    private readonly getUrl: (attempt: number) => Promise<string>,
    private readonly log: Logger,
    options: DreoWebSocketOptions = {},
  ) {
    this.keepaliveInterval = options.keepaliveInterval ?? KEEPALIVE_INTERVAL;
    this.pongTimeout = options.pongTimeout ?? PONG_TIMEOUT;
    this.connectTimeout = options.connectTimeout ?? CONNECT_TIMEOUT;
    this.minReconnectDelay = options.minReconnectDelay ?? MIN_RECONNECT_DELAY;
    this.maxReconnectDelay = options.maxReconnectDelay ?? MAX_RECONNECT_DELAY;
  }

  public start() {
    this.stopped = false;
    this.connect();
  }

  // Stop reconnecting and tear down the current connection (called on Homebridge shutdown)
  public stop() {
    this.stopped = true;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearTimer(this.connectTimer);
    this.connectTimer = undefined;
    this.stopKeepalive();
    this.ws?.close();
    this.ws = undefined;
  }

  // Register a listener that persists across reconnects
  public addEventListener(event: string, listener: Listener) {
    const existing = this.listeners.get(event);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(event, new Set([listener]));
    }
  }

  public get isOpen(): boolean {
    return this.openSocket() !== undefined;
  }

  public send(data: string) {
    const ws = this.openSocket();
    if (!ws) {
      // Matches the old behaviour of dropping sends while disconnected, but says so out loud
      this.log.debug('WebSocket not open, dropping message');
      return;
    }
    ws.send(data);
  }

  // The current socket if it is open, so callers get a defined socket to use
  private openSocket(): WebSocket | undefined {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws : undefined;
  }

  private async connect() {
    if (this.stopped) {
      return;
    }

    let url: string;
    try {
      url = await this.getUrl(this.attempt);
    } catch (error) {
      this.log.debug('Could not build WebSocket URL:', error);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    // A hung TCP handshake would otherwise sit in CONNECTING until the OS gives up (~75s).
    // terminate() aborts it; the 'error' handler below catches the resulting async emit.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      this.log.debug('WebSocket connection timed out');
      ws.terminate();
    }, this.connectTimeout);

    // Attached for the socket's entire lifetime. `ws` emits 'error' asynchronously (process.nextTick)
    // when a handshake is aborted; an unhandled 'error' event would take down the Homebridge process.
    ws.on('error', (error) => {
      this.log.debug('WebSocket error:', error.message);
      this.emit('error', error);
    });

    ws.on('open', () => {
      this.attempt = 0;
      this.clearTimer(this.connectTimer);
      this.connectTimer = undefined;
      this.log.debug('WebSocket Opened');
      this.startKeepalive();
      this.emit('open', {});
    });

    ws.on('message', (raw) => {
      // Accessories expect a MessageEvent-like object with a string `data` field
      const data = Array.isArray(raw) ? Buffer.concat(raw).toString() : raw.toString();
      this.emit('message', {data: data});
    });

    ws.on('pong', () => {
      this.pongSupported = true;
      this.clearTimer(this.pongTimer);
      this.pongTimer = undefined;
    });

    ws.on('close', (code, reason) => {
      this.clearTimer(this.connectTimer);
      this.connectTimer = undefined;
      this.stopKeepalive();
      this.log.debug('WebSocket Closed');
      this.emit('close', {code: code, reason: reason.toString()});
      // Only the active socket may trigger a reconnect; a stale one closing must not
      if (this.ws === ws) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    // Exponential backoff, half-jittered so every plugin instance doesn't retry in lockstep
    const backoff = Math.min(this.maxReconnectDelay, this.minReconnectDelay * Math.pow(2, this.attempt));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.attempt++;

    this.log.debug('Reconnecting to WebSocket in %dms', Math.round(delay));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ws = this.openSocket();
      if (!ws) {
        return;
      }
      ws.send('2');
      ws.ping();

      // A half-open TCP connection accepts writes forever, so wait for a pong to prove it is alive.
      // Skipped until we know the server answers pings at all, otherwise we would kill a healthy socket.
      if (this.pongSupported && !this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.pongTimer = undefined;
          this.log.debug('WebSocket keepalive timed out, terminating');
          this.ws?.terminate();
        }, this.pongTimeout);
      }
    }, this.keepaliveInterval);
  }

  private stopKeepalive() {
    this.clearTimer(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    this.clearTimer(this.pongTimer);
    this.pongTimer = undefined;
  }

  private clearTimer(timer?: NodeJS.Timeout) {
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  }

  private emit(event: string, payload) {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    listeners.forEach((listener) => {
      // One misbehaving accessory must not stop the others from receiving updates
      try {
        listener(payload);
      } catch (error) {
        this.log.error('Error in WebSocket %s listener:', event, error);
      }
    });
  }
}

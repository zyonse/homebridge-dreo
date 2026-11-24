// Software-in-the-loop stand-in for the Dreo cloud.
//
// Speaks enough of the real protocol for the websocket client to be exercised without
// credentials or hardware: it accepts the token query string, answers pings, records the
// '2' keepalive, and replies to control commands the way the real server does:
//
//   -> {"deviceSn":"...","method":"control","params":{"poweron":true}}
//   <- {"devicesn":"...","method":"control-reply","reported":{"poweron":true}}
//
// It can also misbehave on demand: drop connections server-side, or freeze a socket to
// simulate a half-open TCP connection that accepts writes but never answers.
const http = require('http');
const { WebSocketServer } = require('ws');

class MockDreoServer {
  constructor() {
    this.connections = 0;
    this.keepalives = 0;
    this.controls = [];
    this.tokens = [];
  }

  async start() {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => this.wss.once('listening', resolve));
    this.port = this.wss.address().port;

    this.wss.on('connection', (socket, req) => {
      this.connections++;
      this.tokens.push(new URL(req.url, 'http://x').searchParams.get('accessToken'));

      socket.on('message', (raw) => {
        const text = raw.toString();
        if (text === '2') {
          this.keepalives++;
          return;
        }
        const msg = JSON.parse(text);
        if (msg.method === 'control') {
          this.controls.push({ ...msg, receivedAt: Date.now() });
          socket.send(JSON.stringify({
            devicesn: msg.deviceSn,
            method: 'control-reply',
            reported: msg.params,
          }));
        }
      });
    });
    return this;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  // Push an unsolicited state report, as the real server does on a hardware control
  broadcast(payload) {
    this.wss.clients.forEach((c) => c.send(JSON.stringify(payload)));
  }

  // Hard server-side disconnect
  dropAll() {
    this.wss.clients.forEach((c) => c.terminate());
  }

  // Stop reading from the sockets: writes still "succeed", but nothing ever comes back
  // and pings go unanswered. This is what a half-open connection looks like.
  freeze() {
    this.wss.clients.forEach((c) => c._socket.pause());
  }

  async stop() {
    this.wss.clients.forEach((c) => c.terminate());
    await new Promise((resolve) => this.wss.close(resolve));
  }
}

/**
 * Accepts the TCP connection and the HTTP upgrade request, then never replies.
 * The client is left in CONNECTING until it gives up — the exact state in which
 * calling close()/terminate() triggers ws's abortHandshake() and its deferred
 * 'error' emit.
 */
class BlackholeServer {
  async start() {
    this.sockets = [];
    this.server = http.createServer();
    this.server.on('upgrade', (req, socket) => this.sockets.push(socket)); // deliberately no response
    this.server.listen(0);
    await new Promise((resolve) => this.server.once('listening', resolve));
    this.port = this.server.address().port;
    return this;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  async stop() {
    this.sockets.forEach((s) => s.destroy());
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { MockDreoServer, BlackholeServer };

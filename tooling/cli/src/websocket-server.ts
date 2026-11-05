// The server side of a WebSocket (RFC 6455) over `node:http`'s upgrade, as
// much as a peer link needs: text messages, fragmented or not, pings and
// closes. Each socket is adapted to the WHATWG surface `acceptWebSocket`
// takes. TLS is a proxy's job (ADR 0165).
// Runtime-neutral: node:* APIs only, under Bun and Node.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketEndpoint } from '@northtalk/ts/peer';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/** One upgraded connection, seen as a WHATWG `WebSocket`. */
class ServerSocket extends EventTarget implements WebSocketEndpoint {
  readyState = 1;
  private buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partBytes = 0;

  constructor(
    private readonly socket: Duplex,
    private readonly maxMessage: number,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('close', () => this.ended());
    socket.on('error', () => this.ended());
  }

  read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.readyState === 1) {
      const b = this.buffer;
      if (b.length < 2) {
        return;
      }
      const fin = (b[0]! & 0x80) !== 0;
      const op = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let length = b[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        if (b.length < 4) {
          return;
        }
        length = b.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (b.length < 10) {
          return;
        }
        const big = b.readBigUInt64BE(2);
        length = big > BigInt(this.maxMessage) ? Infinity : Number(big);
        at = 10;
      }
      // A client masks every frame (RFC 6455 §5.1).
      if (!masked) {
        return this.close(1002);
      }
      if (this.partBytes + length > this.maxMessage) {
        return this.close(1009);
      }
      if (b.length < at + 4 + length) {
        return;
      }
      const mask = b.subarray(at, at + 4);
      const body = Buffer.from(b.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < body.length; i++) {
        body[i]! ^= mask[i & 3]!;
      }
      this.buffer = b.subarray(at + 4 + length);
      this.frame(fin, op, body);
    }
  }

  private frame(fin: boolean, op: number, body: Buffer) {
    if (op === PING) {
      return this.write(PONG, body);
    }
    if (op === PONG) {
      return;
    }
    if (op === CLOSE) {
      return this.close(body.length >= 2 ? body.readUInt16BE(0) : 1000);
    }
    if (op === BINARY) {
      return this.close(1003);
    }
    // A text message starts afresh; a continuation (0) needs one started.
    const continuing = this.parts.length > 0;
    if (op === TEXT ? continuing : op !== 0 || !continuing) {
      return this.close(1002);
    }
    this.parts.push(body);
    this.partBytes += body.length;
    if (!fin) {
      return;
    }
    const data = Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.partBytes = 0;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  private write(op: number, body: Buffer) {
    const head =
      body.length < 126
        ? Buffer.from([0x80 | op, body.length])
        : body.length < 0x1_00_00
          ? Buffer.from([0x80 | op, 126, body.length >> 8, body.length & 0xff])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | op;
              h[1] = 127;
              h.writeBigUInt64BE(BigInt(body.length), 2);
              return h;
            })();
    this.socket.write(Buffer.concat([head, body]));
  }

  send(data: string) {
    if (this.readyState === 1) {
      this.write(TEXT, Buffer.from(data, 'utf8'));
    }
  }

  close(code = 1000) {
    if (this.readyState !== 1) {
      return;
    }
    this.readyState = 2;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.write(CLOSE, body);
    this.socket.end();
    this.ended();
  }

  private ended() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.socket.destroy();
    this.dispatchEvent(new Event('close'));
  }
}

/**
 * An HTTP server that upgrades every WebSocket request, whatever its path,
 * and answers anything else 426.
 */
export const webSocketServer = (
  accepted: (socket: WebSocketEndpoint, request: IncomingMessage) => void,
  maxMessage: number,
): Server => {
  const server = createServer((_, response) => {
    response.writeHead(426, { upgrade: 'websocket' }).end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head) => {
    const key = request.headers['sec-websocket-key'];
    if (
      typeof key !== 'string' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      request.headers['sec-websocket-version'] !== '13'
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new ServerSocket(socket, maxMessage);
    accepted(ws, request);
    if (head && head.length > 0) {
      ws.read(head);
    }
  });
  return server;
};

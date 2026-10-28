import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import cookieParser from 'cookie-parser';
import { one } from './db.js';
import { cache } from './redis.js';
import { logger } from './logger.js';
import { resolveUser } from './auth/session.js';
import { canEditBranch, getSpaceRole, atLeast, enforceOrgPolicies } from './permissions.js';
import { type PMNode, YJS_FIELD, jsonToYFragment, yFragmentToJson } from './content/prosemirror.js';
import { savePageContent, setLiveContentHandler } from './content/pages.js';
import { uuid } from './util.js';
import type { Request } from 'express';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const NODE_ID = uuid();
const PERSIST_DEBOUNCE_MS = 1500;

interface Conn {
  ws: WebSocket;
  readOnly: boolean;
  userId: string;
  clientIds: Set<number>;
}

class Room {
  doc = new Y.Doc({ gc: true });
  awareness = new awarenessProtocol.Awareness(this.doc);
  conns = new Map<WebSocket, Conn>();
  persistTimer: NodeJS.Timeout | null = null;
  lastEditor: string | null = null;
  ready: Promise<void>;

  constructor(public pageId: string) {
    this.awareness.setLocalState(null);
    this.ready = this.load();
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns.values()) send(c.ws, msg);
      if (origin !== 'remote-node' && origin !== 'load') {
        void cache.publish(`collab:${this.pageId}`, JSON.stringify({ node: NODE_ID, t: 'u', d: Buffer.from(update).toString('base64') }));
      }
      if (origin !== 'load' && origin !== 'remote-node') this.schedulePersist();
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed);
      const conn = origin ? this.conns.get(origin as WebSocket) : undefined;
      if (conn) {
        added.forEach((id) => conn.clientIds.add(id));
        removed.forEach((id) => conn.clientIds.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns.values()) send(c.ws, msg);
    });
  }

  private async load() {
    const page = await one('SELECT ydoc, content FROM pages WHERE id=?', [this.pageId]);
    if (!page) return;
    if (page.ydoc && page.ydoc.length) {
      Y.applyUpdate(this.doc, new Uint8Array(page.ydoc), 'load');
    } else {
      const content = parseContent(page.content);
      this.doc.transact(() => jsonToYFragment(this.doc.getXmlFragment(YJS_FIELD), content), 'load');
    }
    await cache.subscribe(`collab:${this.pageId}`, (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.node === NODE_ID) return;
        if (msg.t === 'u') Y.applyUpdate(this.doc, Buffer.from(msg.d, 'base64'), 'remote-node');
      } catch {
        /* ignore */
      }
    });
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), PERSIST_DEBOUNCE_MS);
  }

  async persist() {
    this.persistTimer = null;
    try {
      const doc = yFragmentToJson(this.doc.getXmlFragment(YJS_FIELD));
      await savePageContent(this.pageId, doc, this.lastEditor, { fromCollab: true, ydoc: Y.encodeStateAsUpdate(this.doc) });
    } catch (err) {
      logger.error('collab persist failed', { pageId: this.pageId, error: (err as Error).message });
    }
  }

  /** Replace the document content from an API-side change (restore, merge, AI insert...). */
  replaceContent(doc: PMNode) {
    this.doc.transact(() => jsonToYFragment(this.doc.getXmlFragment(YJS_FIELD), doc), 'api');
  }
}

function parseContent(raw: unknown): PMNode {
  if (!raw) return { type: 'doc', content: [{ type: 'paragraph' }] };
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PMNode);
  } catch {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState === ws.OPEN) ws.send(msg, (err) => err && ws.close());
}

setLiveContentHandler((pageId, doc) => {
  const room = rooms.get(pageId);
  if (!room) return false;
  room.replaceContent(doc);
  return true;
});

export function collabStats() {
  let connections = 0;
  for (const r of rooms.values()) connections += r.conns.size;
  return { rooms: rooms.size, connections };
}

async function authorize(req: IncomingMessage, pageId: string): Promise<{ userId: string; readOnly: boolean } | null> {
  const fakeReq = req as unknown as Request;
  await new Promise<void>((resolve) => cookieParser()(fakeReq, {} as any, () => resolve()));
  await resolveUser(fakeReq);
  if (!fakeReq.user || fakeReq.mfaPending) return null;
  const page = await one('SELECT p.space_id, p.branch_id FROM pages p WHERE p.id=?', [pageId]);
  if (!page) return null;
  const space = await one('SELECT * FROM spaces WHERE id=?', [page.space_id]);
  const branch = await one('SELECT * FROM branches WHERE id=?', [page.branch_id]);
  if (!space || !branch) return null;
  const role = await getSpaceRole(fakeReq.user.id, fakeReq.user.is_admin, space);
  if (!atLeast(role, 'reader')) return null;
  if (!fakeReq.user.is_admin) {
    const org = await one('SELECT settings FROM organizations WHERE id=?', [space.org_id]);
    try {
      enforceOrgPolicies(fakeReq, org!);
    } catch {
      return null;
    }
  }
  return { userId: fakeReq.user.id, readOnly: !canEditBranch(space, branch, role) };
}

export function createCollabServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const m = /^\/collab\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    const pageId = m[1];
    authorize(req, pageId)
      .then((auth) => {
        if (!auth) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, pageId, auth));
      })
      .catch((err) => {
        logger.error('collab auth failed', { error: (err as Error).message });
        socket.destroy();
      });
  };

  return { handleUpgrade };
}

async function onConnection(ws: WebSocket, pageId: string, auth: { userId: string; readOnly: boolean }) {
  ws.binaryType = 'arraybuffer';
  let room = rooms.get(pageId);
  if (!room) {
    room = new Room(pageId);
    rooms.set(pageId, room);
  }
  const conn: Conn = { ws, readOnly: auth.readOnly, userId: auth.userId, clientIds: new Set() };
  room.conns.set(ws, conn);
  const r = room;

  // Buffer messages until the document has loaded.
  const queue: Uint8Array[] = [];
  let loaded = false;
  ws.on('message', (data: ArrayBuffer | Buffer) => {
    const msg = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!loaded) queue.push(msg);
    else handleMessage(r, conn, msg);
  });

  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on('close', () => {
    clearInterval(ping);
    room!.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(r.awareness, Array.from(conn.clientIds), null);
    if (r.conns.size === 0) {
      setTimeout(async () => {
        if (r.conns.size > 0) return;
        if (r.persistTimer) {
          clearTimeout(r.persistTimer);
          await r.persist();
        }
        if (r.conns.size === 0 && rooms.get(pageId) === r) {
          rooms.delete(pageId);
          r.doc.destroy();
        }
      }, 5000);
    }
  });

  await room.ready;
  loaded = true;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  send(ws, encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size) {
    const aenc = encoding.createEncoder();
    encoding.writeVarUint(aenc, MSG_AWARENESS);
    encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())));
    send(ws, encoding.toUint8Array(aenc));
  }
  for (const m of queue) handleMessage(room, conn, m);
}

function handleMessage(room: Room, conn: Conn, msg: Uint8Array) {
  try {
    const decoder = decoding.createDecoder(msg);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      // Peek the sync sub-type: read-only clients may request state (step 1) but never write.
      const subType = decoding.peekVarUint(decoder);
      if (conn.readOnly && subType !== syncProtocol.messageYjsSyncStep1) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (subType !== syncProtocol.messageYjsSyncStep1) room.lastEditor = conn.userId;
      syncProtocol.readSyncMessage(decoder, enc, room.doc, conn.ws);
      if (encoding.length(enc) > 1) send(conn.ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn.ws);
    }
  } catch (err) {
    logger.warn('collab message error', { error: (err as Error).message });
  }
}

/** Flush all rooms to the database (graceful shutdown). */
export async function flushCollab() {
  await Promise.all([...rooms.values()].map((r) => (r.persistTimer ? r.persist() : Promise.resolve())));
}

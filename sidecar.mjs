// do-app sync sidecar.
// Holds the canonical state JSON on disk, serves it to the local browser,
// and pushes/pulls against a peer sidecar over the Tailscale network.
//
// State file: ~/.do-app/state.json
// Config:     ~/.do-app/config.json   ({ "peerUrl": "http://laptop.tailnet.ts.net:5174" })
//
// Endpoints:
//   GET  /health            { ok, peerUrl, hasState, lastModified }
//   GET  /state             returns { lastModified, version, data } or 404
//   PUT  /state             body is the Zustand persist blob; wraps + writes atomically
//   POST /sync              newer-wins between local and peer; returns { direction }

import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const DATA_DIR = join(HOME, '.do-app');
const STATE_PATH = join(DATA_DIR, 'state.json');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const PORT = Number(process.env.DO_APP_PORT ?? 5174);
const HOST = process.env.DO_APP_HOST ?? '0.0.0.0';
const PEER_TIMEOUT_MS = 5000;

await mkdir(DATA_DIR, { recursive: true });

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readConfig() {
  return (await readJson(CONFIG_PATH)) ?? { peerUrl: null };
}

async function readState() {
  return await readJson(STATE_PATH);
}

async function writeState(wrapper) {
  const tmp = STATE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(wrapper));
  await rename(tmp, STATE_PATH);
}

async function backupState(reason) {
  try {
    const buf = await readFile(STATE_PATH, 'utf8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(DATA_DIR, `state.bak.${ts}.${reason}.json`), buf);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function fetchPeerState(peerUrl) {
  const r = await withTimeout(fetch(new URL('/state', peerUrl)), PEER_TIMEOUT_MS, 'peer GET');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`peer /state ${r.status}`);
  return await r.json();
}

async function pushToPeer(peerUrl, wrapper) {
  const r = await withTimeout(
    fetch(new URL('/state', peerUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wrapper),
    }),
    PEER_TIMEOUT_MS,
    'peer PUT',
  );
  if (!r.ok) throw new Error(`peer PUT /state ${r.status}`);
}

function wrap(rawBlob) {
  // The browser sends the raw Zustand persist blob. We wrap it with a server-stamped mtime
  // so the sync comparison is independent of any client clock.
  return { lastModified: Date.now(), version: 1, data: rawBlob };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method;

    if (path === '/health' && method === 'GET') {
      const config = await readConfig();
      const state = await readState();
      return send(res, 200, {
        ok: true,
        peerUrl: config.peerUrl ?? null,
        hasState: state != null,
        lastModified: state?.lastModified ?? null,
      });
    }

    if (path === '/state' && method === 'GET') {
      const state = await readState();
      if (!state) return send(res, 404, { error: 'no state yet' });
      return send(res, 200, state);
    }

    if (path === '/state' && method === 'PUT') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      // Accept either a pre-wrapped payload (from a peer's /sync push) or a raw blob (from the browser).
      const isWrapped =
        parsed && typeof parsed === 'object' && 'data' in parsed && 'lastModified' in parsed;
      const wrapper = isWrapped ? parsed : wrap(parsed);
      await writeState(wrapper);
      return send(res, 200, { lastModified: wrapper.lastModified });
    }

    if (path === '/sync' && method === 'POST') {
      const config = await readConfig();
      if (!config.peerUrl) {
        return send(res, 400, { error: 'no peerUrl configured in ~/.do-app/config.json' });
      }
      const local = await readState();
      let peer;
      try {
        peer = await fetchPeerState(config.peerUrl);
      } catch (e) {
        return send(res, 502, { error: `peer unreachable: ${e.message}` });
      }

      const localMs = local?.lastModified ?? 0;
      const peerMs = peer?.lastModified ?? 0;

      if (!local && !peer) {
        return send(res, 200, { direction: 'noop', reason: 'neither side has state' });
      }
      if (localMs === peerMs) {
        return send(res, 200, { direction: 'in-sync', localMs, peerMs });
      }
      if (localMs > peerMs) {
        try {
          await pushToPeer(config.peerUrl, local);
        } catch (e) {
          return send(res, 502, { error: `push failed: ${e.message}` });
        }
        return send(res, 200, { direction: 'push', localMs, peerMs });
      }
      // peer is newer — back up local then overwrite
      await backupState('pre-pull');
      await writeState(peer);
      return send(res, 200, { direction: 'pull', localMs, peerMs });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[sidecar]', e);
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[do-app sidecar] http://${HOST}:${PORT}`);
  console.log(`[do-app sidecar] state  ${STATE_PATH}`);
  console.log(`[do-app sidecar] config ${CONFIG_PATH}`);
});

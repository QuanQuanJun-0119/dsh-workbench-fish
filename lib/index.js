// dsh-workbench-fish —— 宿主侧
//
// 职责：任务存储 + 消耗归集 + REST 接口。界面在 client 侧。
// 路由挂在 ctx.webServer（prefix /workbench-fish）；认证复用 dsh 的 connection.requestRejection，
// 另放一个本机探针（x-wf-probe 头）方便脚本自测。

import { promises as fs } from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'workbench-fish';
export const inject = ['webServer', 'connection'];

const ROUTE = '/workbench-fish';
const ROUTE_AUTH = '/workbench-fish/authurl';
const ROUTE_DAILY = '/workbench-fish/daily';
const BODY_MAX = 1024 * 1024;
const PROBE_KEY = randomUUID();
const STATUS = ['running', 'waiting', 'stuck', 'done', 'paused'];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function storeDir() {
  return join(dshHome(), 'workbench-fish');
}
function storePath() {
  return join(storeDir(), 'tasks.json');
}
function ledgerPath() {
  return join(dshHome(), 'storages', 'cost-meter', 'ledger.json');
}

function trace(msg) {
  try {
    mkdirSync(storeDir(), { recursive: true });
    appendFileSync(join(storeDir(), 'apply.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 忽略 */ }
}

/* ---------------- 存储 ---------------- */

async function readStore() {
  try {
    const j = JSON.parse(await fs.readFile(storePath(), 'utf8'));
    return { version: 1, tasks: Array.isArray(j.tasks) ? j.tasks : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

async function writeStore(store) {
  await fs.mkdir(storeDir(), { recursive: true });
  const tmp = storePath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, storePath());
}

/* ---------------- 消耗归集 ---------------- */

async function readLedger() {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(), 'utf8'));
  } catch {
    return { days: {} };
  }
}

/** 账本 → { sessionId: {cost, tokens} } */
function sessionCosts(ledger) {
  const out = new Map();
  for (const day of Object.values(ledger.days || {})) {
    const raw = day && day.sessions;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    for (const s of list) {
      if (!s || !s.id) continue;
      const cur = out.get(s.id) || { cost: 0, tokens: 0 };
      cur.cost += Number(s.costCny != null ? s.costCny : (s.cost || 0));   // 账本里 cost 是美元，用 costCny
      cur.tokens += Number(s.input || 0) + Number(s.output || 0) + Number(s.cacheRead || 0) + Number(s.cacheWrite || 0);
      out.set(s.id, cur);
    }
  }
  return out;
}

function attachCost(tasks, costs) {
  return tasks.map((t) => {
    let cost = 0;
    let tokens = 0;
    for (const sid of t.sessions || []) {
      const c = costs.get(sid);
      if (c) { cost += c.cost; tokens += c.tokens; }
    }
    return { ...t, cost: Number(cost.toFixed(4)), tokens };
  });
}

function summarize(tasks) {
  const byStatus = {};
  for (const s of STATUS) byStatus[s] = { count: 0, cost: 0, tokens: 0 };
  let cost = 0;
  let tokens = 0;
  for (const t of tasks) {
    const b = byStatus[t.status] || (byStatus[t.status] = { count: 0, cost: 0, tokens: 0 });
    b.count += 1;
    b.cost += t.cost || 0;
    b.tokens += t.tokens || 0;
    cost += t.cost || 0;
    tokens += t.tokens || 0;
  }
  for (const b of Object.values(byStatus)) b.cost = Number(b.cost.toFixed(4));
  return { byStatus, total: { count: tasks.length, cost: Number(cost.toFixed(4)), tokens } };
}

async function readBalance() {
  try {
    const yaml = await fs.readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    const m = yaml.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (!m) return null;
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return null;
    const j = await r.json();
    const info = (j.balance_infos || [])[0] || {};
    return { currency: info.currency || 'CNY', total: Number(info.total_balance || 0) };
  } catch {
    return null;
  }
}

async function readEvolution() {
  const out = { persona: null, memoryBytes: 0, skills: [] };
  try {
    const memDir = join(dshHome(), 'soul-md', 'memory');
    const names = await fs.readdir(memDir);
    const cards = [];
    for (const n of names) {
      if (!n.endsWith('.md') || n === 'global.md') continue;
      const st = await fs.stat(join(memDir, n));
      cards.push({ name: n.replace(/\.md$/, ''), bytes: st.size });
    }
    out.persona = cards[0] || null;
    out.cards = cards;
  } catch { /* 没有就算了 */ }
  try {
    out.memoryBytes = (await fs.stat(join(dshHome(), 'soul-md', 'memory', 'global.md'))).size;
  } catch { /* 忽略 */ }
  try {
    const dirs = await fs.readdir(join(dshHome(), 'skills'), { withFileTypes: true });
    out.skills = dirs.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* 忽略 */ }
  return out;
}
async function readDaily(daysBack = 120) {
  const ledger = await readLedger();
  const out = [];
  const today = new Date();
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const day = (ledger.days || {})[key];
    const cost = day ? Number(day.costCny != null ? day.costCny : day.cost || 0) : 0;
    const tokens = day ? Number(day.input || 0) + Number(day.output || 0) + Number(day.cacheRead || 0) + Number(day.cacheWrite || 0) : 0;
    out.push({ date: key, cost: Number(Number(cost).toFixed(4)), tokens });
  }
  return out;
}

/* ---------------- HTTP 工具 ---------------- */

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_MAX) throw new Error('body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/* ---------------- 插件入口 ---------------- */

export function apply(ctx) {
  trace('apply 开始');
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(join(storeDir(), 'probe.key'), PROBE_KEY + '\n');
  } catch { /* 忽略 */ }

  const connection = ctx.connection;

  const route = {
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const probe = req.headers['x-wf-probe'];
      const byProbe = probe === PROBE_KEY;

      if (!byProbe) {
        if (typeof connection?.requestRejection === 'function') {
          let rej;
          try { rej = connection.requestRejection(req); } catch { rej = 403; }
          if (rej !== undefined) {
            res.writeHead(rej, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(rej === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
        }
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      try {
        if (method === 'GET' && path === ROUTE_DAILY) {
          return json(res, 200, { ok: true, days: await readDaily(Number(url.searchParams.get('days') || 120)) });
        }

        if (method === 'GET' && path === ROUTE_AUTH) {
          if (!byProbe) return json(res, 403, { ok: false, error: 'probe only' });
          let u = null;
          try {
            u = typeof connection?.authenticatedUrl === 'function' ? connection.authenticatedUrl('http://127.0.0.1:3080/') : null;
          } catch { u = null; }
          return json(res, 200, { ok: true, url: u });
        }

        if (method === 'GET' && path === `${ROUTE}/state`) {
          const store = await readStore();
          const costs = sessionCosts(await readLedger());
          const tasks = attachCost(store.tasks, costs);
          return json(res, 200, {
            ok: true,
            tasks,
            summary: summarize(tasks),
            balance: await readBalance(),
            evolution: await readEvolution(),
            currentSession: process.env.DSH_SESSION_ID || null,
            updatedAt: new Date().toISOString(),
          });
        }

        if (method === 'POST' && path === `${ROUTE}/tasks`) {
          const body = await readBody(req);
          const store = await readStore();
          const now = new Date().toISOString();
          if (body.id) {
            const i = store.tasks.findIndex((t) => t.id === body.id);
            if (i < 0) return json(res, 404, { ok: false, error: 'task not found' });
            store.tasks[i] = { ...store.tasks[i], ...body, updatedAt: now };
          } else {
            store.tasks.push({
              id: randomUUID(),
              title: String(body.title || '未命名任务'),
              summary: String(body.summary || ''),
              judgment: String(body.judgment || ''),
              status: STATUS.includes(body.status) ? body.status : 'running',
              progress: Number(body.progress || 0),
              sessions: Array.isArray(body.sessions) ? body.sessions : [],
              tags: Array.isArray(body.tags) ? body.tags : [],
              createdAt: now,
              updatedAt: now,
            });
          }
          await writeStore(store);
          return json(res, 200, { ok: true });
        }

        const m = path.match(new RegExp(`^${ROUTE}/tasks/([^/]+)/status$`));
        if (method === 'POST' && m) {
          const id = decodeURIComponent(m[1]);
          const body = await readBody(req);
          if (!STATUS.includes(body.status)) return json(res, 400, { ok: false, error: 'bad status' });
          const store = await readStore();
          const t = store.tasks.find((x) => x.id === id);
          if (!t) return json(res, 404, { ok: false, error: 'task not found' });
          t.status = body.status;
          t.updatedAt = new Date().toISOString();
          await writeStore(store);
          return json(res, 200, { ok: true });
        }

        const d = path.match(new RegExp(`^${ROUTE}/tasks/([^/]+)$`));
        if (method === 'DELETE' && d) {
          const id = decodeURIComponent(d[1]);
          const store = await readStore();
          const before = store.tasks.length;
          store.tasks = store.tasks.filter((x) => x.id !== id);
          if (store.tasks.length === before) return json(res, 404, { ok: false, error: 'task not found' });
          await writeStore(store);
          return json(res, 200, { ok: true });
        }

        return json(res, 404, { ok: false, error: 'no such endpoint' });
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  };

  try {
    const registered = ctx.webServer.register(route);
    trace('路由已注册');
    if (typeof registered === 'function') ctx.on?.('dispose', () => { try { registered(); } catch {} });
    else if (registered && typeof registered.then === 'function') {
      ctx.on?.('dispose', async () => { try { const fn = await registered; if (typeof fn === 'function') fn(); } catch {} });
    }
  } catch (e) {
    trace('注册失败: ' + String((e && e.stack) || e));
    throw e;
  }
}

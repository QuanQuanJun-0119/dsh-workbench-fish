// dsh-workbench-fish —— 宿主侧
//
// 职责：任务存储 + 消耗归集 + REST 接口。界面在 client 侧。
// 路由挂在 ctx.webServer（prefix /workbench-fish）；认证复用 dsh 的 connection.requestRejection，
// 另放一个本机探针（x-wf-probe 头）方便脚本自测。

import { promises as fs } from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'workbench-fish';
export const inject = ['webServer', 'connection'];

const ROUTE = '/workbench-fish';
const ROUTE_AUTH = '/workbench-fish/authurl';
const ROUTE_DAILY = '/workbench-fish/daily';
const ROUTE_SESSION = '/workbench-fish/session';
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

/* ---------------- 进化：不只是现状，还要看"变了多少" ---------------- */

const EVO_KEEP_VERSIONS = 8;

function evoHistoryPath() {
  return join(storeDir(), 'evo-history.json');
}

async function readEvoHistory() {
  try {
    const j = JSON.parse(await fs.readFile(evoHistoryPath(), 'utf8'));
    return { version: 1, personaVersions: Array.isArray(j.personaVersions) ? j.personaVersions : [] };
  } catch {
    return { version: 1, personaVersions: [] };
  }
}

async function writeEvoHistory(hist) {
  try {
    await fs.mkdir(storeDir(), { recursive: true });
    const tmp = evoHistoryPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(hist, null, 2), 'utf8');
    await fs.rename(tmp, evoHistoryPath());
  } catch { /* 记不住就算了，不能影响读数据 */ }
}

function shortHash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

/** 本地日期键（不能用 toISOString，会按 UTC 差 8 小时） */
function dayKey(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function kb(n) {
  const v = Number(n || 0);
  return v >= 1024 ? (v / 1024).toFixed(1) + ' KB' : v + ' B';
}

/** 从 cordis.patch.yml 里抠出 soul-md 的 cards —— 不引 yaml 依赖，只认块标量 */
function parseSoulBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { cards: {}, active: null, at: null };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*soul-md\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return out;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    const am = /^\s+active:\s*(\S+)\s*$/.exec(lines[i]);
    if (am && !out.active) out.active = am[1].replace(/^["']|["']$/g, '');
    const m0 = /^(\s*)cards:\s*$/.exec(lines[i]);
    if (!m0) continue;
    const base = m0[1].length;
    for (let j = i + 1; j < end; j++) {
      const ln = lines[j];
      if (!ln.trim()) continue;
      const ind = ln.length - ln.trimStart().length;
      if (ind <= base) break;
      const m = /^(\s+)(.+?):\s*\|-?\s*$/.exec(ln);
      if (!m) continue;
      const keyIndent = m[1].length;
      const name = m[2].trim().replace(/^["']|["']$/g, '');
      const body = [];
      let k = j + 1;
      let ci = null;
      for (; k < end; k++) {
        const bl = lines[k];
        if (!bl.trim()) { body.push(''); continue; }
        const bi = bl.length - bl.trimStart().length;
        if (bi <= keyIndent) break;
        if (ci === null) ci = bi;
        body.push(bl.slice(Math.min(ci, bi)));
      }
      let txt = body.join('\n').replace(/\s+$/, '');
      if (txt) txt += '\n';
      out.cards[name] = txt;
      j = k - 1;
    }
  }
  return out;
}

function lineDiff(prev, next) {
  const norm = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const a = norm(prev);
  const b = norm(next);
  const setA = new Set(a);
  const setB = new Set(b);
  const added = b.filter((x) => !setA.has(x));
  const removed = a.filter((x) => !setB.has(x));
  return {
    added: added.length,
    removed: removed.length,
    addedLines: added.slice(0, 3),
    removedLines: removed.slice(0, 2),
  };
}

async function readPersona() {
  const dir = join(dshHome(), 'profiles', 'web');
  let text = '';
  let mtime = null;
  try {
    text = await fs.readFile(join(dir, 'cordis.patch.yml'), 'utf8');
    mtime = (await fs.stat(join(dir, 'cordis.patch.yml'))).mtime.toISOString();
  } catch {
    return null;
  }
  const blk = parseSoulBlock(text);
  const names = Object.keys(blk.cards);
  if (!names.length) return null;
  const pick = (blk.active && blk.cards[blk.active] !== undefined) ? blk.active : names[0];
  const card = blk.cards[pick] || '';
  const sections = [];
  let cur = null;
  for (const ln of card.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(ln);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1], bytes: 0 };
    } else if (cur) cur.bytes += Buffer.byteLength(ln + '\n', 'utf8');
  }
  if (cur) sections.push(cur);
  return {
    name: pick,
    text: card,
    bytes: Buffer.byteLength(card, 'utf8'),
    lines: card.split(/\r?\n/).filter((x) => x.trim()).length,
    cards: names,
    sections,
    fileAt: mtime,
  };
}

async function readMemoryEntries() {
  const out = { files: [], entries: [], totalBytes: 0 };
  const dir = join(dshHome(), 'soul-md', 'memory');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    let text = '';
    try { text = await fs.readFile(join(dir, n), 'utf8'); } catch { continue; }
    const file = { name: n.replace(/\.md$/, ''), bytes: Buffer.byteLength(text, 'utf8'), entries: 0 };
    let cur = null;
    const push = () => { if (cur) out.entries.push(cur); };
    for (const ln of text.split(/\r?\n/)) {
      const m = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*[—–-]*\s*(.*)$/.exec(ln);
      if (m) {
        push();
        cur = { date: m[1], time: m[2] ? m[2].padStart(5, '0') : '00:00', label: (m[3] || '').trim(), bytes: 0, file: file.name };
      } else if (cur) {
        cur.bytes += Buffer.byteLength(ln + '\n', 'utf8');
      }
    }
    push();
    file.entries = out.entries.filter((e) => e.file === file.name).length;
    out.files.push(file);
    out.totalBytes += file.bytes;
  }
  return out;
}

async function scanSkills() {
  const out = [];
  const seen = new Set();
  const add = async (name, file, source) => {
    if (!name || seen.has(name)) return;
    try {
      const st = await fs.stat(file);
      seen.add(name);
      out.push({ name, at: st.mtime.toISOString(), source });
    } catch { /* 没有 SKILL.md 就当不是 skill */ }
  };
  const userDir = join(dshHome(), 'skills');
  try {
    for (const d of await fs.readdir(userDir, { withFileTypes: true })) {
      if (d.isDirectory()) await add(d.name, join(userDir, d.name, 'SKILL.md'), '自建');
    }
  } catch { /* 忽略 */ }
  try {
    const nm = join(dshHome(), 'profiles', 'web', 'node_modules');
    const pkgs = [];
    for (const t of await fs.readdir(nm, { withFileTypes: true })) {
      if (!t.isDirectory() || t.name.startsWith('.')) continue;
      if (t.name.startsWith('@')) {
        try {
          for (const s of await fs.readdir(join(nm, t.name), { withFileTypes: true })) {
            if (s.isDirectory()) pkgs.push([`${t.name}/${s.name}`, join(nm, t.name, s.name)]);
          }
        } catch { /* 忽略 */ }
      } else {
        pkgs.push([t.name, join(nm, t.name)]);
      }
    }
    for (const [label, base] of pkgs) {
      for (const sub of ['skills', 'skill']) {
        let kids = [];
        try { kids = await fs.readdir(join(base, sub), { withFileTypes: true }); } catch { continue; }
        for (const k of kids) {
          if (!k.isDirectory()) continue;
          await add(k.name, join(base, sub, k.name, 'SKILL.md'), label);
        }
      }
    }
  } catch { /* 忽略 */ }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function scanPlugins() {
  const out = [];
  const nm = join(dshHome(), 'profiles', 'web', 'node_modules');
  let names = [];
  try { names = await fs.readdir(nm); } catch { return out; }
  for (const n of names) {
    if (!/^dsh[-.]/.test(n)) continue;
    try {
      const pkgPath = join(nm, n, 'package.json');
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      const st = await fs.stat(pkgPath);
      out.push({ name: pkg.name || n, version: pkg.version || '', at: st.mtime.toISOString() });
    } catch { /* 忽略 */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

let evoCache = { at: 0, value: null };

async function readEvolution() {
  if (evoCache.value && Date.now() - evoCache.at < 60000) return evoCache.value;
  let value = null;
  try {
    value = await buildEvolution();
  } catch (e) {
    value = { error: String((e && e.message) || e), curve: [], changes: [], skills: [], plugins: [] };
  }
  evoCache = { at: Date.now(), value };
  return value;
}

async function buildEvolution() {
  const [personaRaw, mem, skills, plugins, store] = await Promise.all([
    readPersona(), readMemoryEntries(), scanSkills(), scanPlugins(), readStore(),
  ]);

  /* ---- 人格卡：留版本，才能算 diff ---- */
  const hist = await readEvoHistory();
  let persona = null;
  if (personaRaw) {
    persona = { ...personaRaw };
    delete persona.text;
    const hash = shortHash(personaRaw.text);
    const versions = hist.personaVersions;
    const foundIdx = versions.findIndex((v) => v.hash === hash);
    if (foundIdx >= 0) {
      // 已经记过：把 at 校正成真实改动时间（老版本保留原 at）
      persona.changedAt = versions[foundIdx].at;
    } else {
      const at = personaRaw.fileAt || new Date().toISOString();
      versions.push({ hash, at, bytes: persona.bytes, text: personaRaw.text });
      if (versions.length > EVO_KEEP_VERSIONS) versions.splice(0, versions.length - EVO_KEEP_VERSIONS);
      await writeEvoHistory(hist);
      persona.changedAt = at;
    }
    const idx = versions.findIndex((v) => v.hash === hash);
    const prev = idx > 0 ? versions[idx - 1] : null;
    persona.versionCount = versions.length;
    persona.diff = prev ? lineDiff(prev.text, personaRaw.text) : null;
    persona.deltaBytes = prev ? persona.bytes - prev.bytes : null;
    persona.prevAt = prev ? prev.at : null;
  }

  /* ---- 记忆：按日期累计 ---- */
  const byDate = new Map();
  for (const e of mem.entries) {
    const cur = byDate.get(e.date) || { date: e.date, bytes: 0, count: 0, items: [] };
    cur.bytes += e.bytes;
    cur.count += 1;
    cur.items.push({ label: e.label, time: e.time, file: e.file });
    byDate.set(e.date, cur);
  }
  const dated = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const todayKey = dayKey(new Date());
  const firstKey = dated.length ? dated[0].date : todayKey;
  const spanDays = Math.round((new Date(todayKey + 'T00:00:00').getTime() - new Date(firstKey + 'T00:00:00').getTime()) / 86400000);
  const windowDays = Math.min(90, Math.max(14, spanDays + 2));
  const curve = [];
  let cumBytes = 0;
  let cumCount = 0;
  const base = new Date(todayKey + 'T00:00:00');
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = dayKey(new Date(base.getTime() - i * 86400000));
    const rec = byDate.get(key);
    if (rec) { cumBytes += rec.bytes; cumCount += rec.count; }
    curve.push({
      date: key,
      bytes: cumBytes,
      count: cumCount,
      newBytes: rec ? rec.bytes : 0,
      newCount: rec ? rec.count : 0,
    });
  }

  /* ---- 变化流水 ---- */
  const changes = [];
  for (const e of mem.entries) {
    changes.push({
      at: `${e.date}T${e.time || '00:00'}:00`,
      date: e.date,
      kind: 'memory',
      title: e.label || '记了一笔',
      detail: `${e.file} · ${kb(e.bytes)}`,
    });
  }
  for (const s of skills) {
    changes.push({ at: s.at, date: dayKey(s.at), kind: 'skill', title: s.name, detail: `skill · ${s.source}` });
  }
  for (const p of plugins) {
    changes.push({ at: p.at, date: dayKey(p.at), kind: 'plugin', title: p.name, detail: `插件 v${p.version}` });
  }
  for (const t of store.tasks) {
    if (!t.createdAt) continue;
    changes.push({ at: t.createdAt, date: dayKey(t.createdAt), kind: 'task', title: t.title, detail: '新建任务' });
  }
  if (persona && persona.changedAt && persona.diff) {
    changes.push({
      at: persona.changedAt,
      date: dayKey(persona.changedAt),
      kind: 'persona',
      title: '人格卡改了',
      detail: `+${persona.diff.added} / −${persona.diff.removed} 行`,
    });
  }
  changes.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  /* ---- 本周 ---- */
  const wkKey = dayKey(new Date(base.getTime() - 6 * 86400000));
  const week = {
    memoryCount: mem.entries.filter((e) => e.date >= wkKey).length,
    memoryBytes: mem.entries.filter((e) => e.date >= wkKey).reduce((a, e) => a + e.bytes, 0),
    skillsTouched: skills.filter((s) => dayKey(s.at) >= wkKey).length,
    pluginsTouched: plugins.filter((p) => dayKey(p.at) >= wkKey).length,
    tasksCreated: store.tasks.filter((t) => t.createdAt && dayKey(t.createdAt) >= wkKey).length,
    personaDelta: persona && persona.deltaBytes != null ? persona.deltaBytes : null,
    since: wkKey,
  };

  return {
    persona,
    memory: {
      totalBytes: mem.totalBytes,
      entries: mem.entries.length,
      files: mem.files,
      todayCount: (byDate.get(todayKey) || {}).count || 0,
      todayBytes: (byDate.get(todayKey) || {}).bytes || 0,
    },
    curve,
    changes: changes.slice(0, 60),
    week,
    skills: skills.map((s) => ({ name: s.name, at: s.at, date: dayKey(s.at), source: s.source })),
    plugins,
    totals: {
      skills: skills.length,
      userSkills: skills.filter((s) => s.source === '自建').length,
      plugins: plugins.length,
    },
    generatedAt: new Date().toISOString(),
  };
}
async function findSessionFile(sessionId) {
  const stack = [join(dshHome(), 'sessions')];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name === sessionId) {
        const f = join(full, 'session.v4.jsonl.zstd');
        try { await fs.access(f); return f; } catch { return null; }
      }
      stack.push(full);
    }
  }
  return null;
}

/** 读一个会话的对话内容（只取 user / assistant 的文字） */
async function readSessionMessages(sessionId, limit = 60) {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  const buf = await fs.readFile(file);
  // session logs are multi-frame zstd; walk every frame
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { idx.push(i); i += 4; }
  let text = '';
  for (let k = 0; k < idx.length; k++) {
    const end2 = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try { text += zstdDecompressSync(buf.subarray(idx[k], end2)).toString('utf8'); } catch { /* skip bad frame */ }
  }
  const out = [];
  let dbgMatched = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'user/message') {
      const blocks = (rec.data && rec.data.content) || [];
      const s = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (s) out.push({ role: 'user', at: rec.time || 0, text: s });
    } else if (rec.type === 'assistant/message') {
      const blocks = (rec.data && rec.data.message && rec.data.message.content) || [];
      const s = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (s) out.push({ role: 'assistant', at: rec.time || 0, text: s });
    }
  }
  return out.slice(-limit);
}
/** 只读会话日志最后几帧，取出最近活动时间和最后一轮的结束原因 */
async function sessionTail(sessionId) {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  const buf = await fs.readFile(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { idx.push(i); i += 4; }
  if (!idx.length) return null;
  const from = Math.max(0, idx.length - 3);          // 只解最后 3 帧，够快
  let text = '';
  for (let k = from; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try { text += zstdDecompressSync(buf.subarray(idx[k], end)).toString('utf8'); } catch { /* 坏帧跳过 */ }
  }
  let lastAt = 0;
  let lastAssistantAt = 0;
  let lastTurnEnd = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const at = Number(rec.time || 0);
    if (at > lastAt) lastAt = at;
    if (rec.type === 'assistant/message' && at > lastAssistantAt) lastAssistantAt = at;
    if (rec.type === 'turn/end') lastTurnEnd = rec.data || {};
  }
  return { lastAt, lastAssistantAt, lastTurnEnd };
}

/** 从会话状态推任务状态。done 不自动改，手动改过的(auto=false)也不改 */
function autoStatusOf(tail, now = Date.now()) {
  if (!tail || !tail.lastAt) return null;
  const idle = now - tail.lastAt;
  const MIN = 60000;
  const kind = tail.lastTurnEnd && tail.lastTurnEnd.reason && tail.lastTurnEnd.reason.kind;
  const failed = kind && ['error', 'aborted', 'interrupted'].includes(kind);
  if (failed && idle < 120 * MIN) return 'stuck';
  if (idle < 10 * MIN) return 'running';
  if (idle < 120 * MIN) return 'waiting';
  return 'paused';
}

/** 当前会话 id：先看环境变量，没有再取最新的会话目录 */
async function currentSessionId() {
  const id = process.env.DSH_SESSION_ID;
  if (typeof id === 'string' && id.startsWith('session-')) return id;
  // 兜底：最近写过的那個会话就是正在用的
  let best = null;
  const stack = [join(dshHome(), 'sessions')];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name.startsWith('session-')) {
        const f = join(full, 'session.v4.jsonl.zstd');
        try {
          const st = await fs.stat(f);
          if (!best || st.mtimeMs > best.mtimeMs) best = { id: e.name, mtimeMs: st.mtimeMs };
        } catch { /* 没有文件就算了 */ }
        continue;
      }
      stack.push(full);
    }
  }
  return best ? best.id : null;
}

/* ---------------- 按时间段拆账 ---------------- */

const msgCache = new Map();   // sessionId -> { mtimeMs, list }

async function readPricing() {
  const ledger = await readLedger();
  const cfg = (ledger && ledger.config) || {};
  const pr = cfg.prices || {};
  return {
    models: pr.models || {},
    def: pr.default || null,
    fx: Number(cfg.exchangeRate || 7),
    peakEnabled: cfg.peakEnabled !== false,
    peakWindows: Array.isArray(cfg.peakWindows) ? cfg.peakWindows : [],
    peakHolidays: Array.isArray(cfg.peakHolidays) ? cfg.peakHolidays : [],
  };
}

/** 按消息时间判断是不是高峰（北京时间），是就用 peak 档 */
function isPeak(atMs, pricing) {
  if (!pricing.peakEnabled) return false;
  const bj = new Date(atMs + 8 * 3600 * 1000);
  const day = bj.toISOString().slice(0, 10);
  if (pricing.peakHolidays.includes(day)) return false;
  const hour = new Date(atMs).getUTCHours();
  return pricing.peakWindows.some((w) => hour >= Number(w.start) && hour < Number(w.end));
}

function costOfMessage(usage, model, pricing, atMs) {
  const base = pricing.models[model] || pricing.def;
  if (!base || !usage) return 0;
  const peak = isPeak(Number(atMs || Date.now()), pricing) && base.peak ? base.peak : null;
  const p = peak || base;
  const usd = (Number(usage.cacheReadTokens || 0) / 1e6) * Number(p.cacheHit || 0)
    + (Number(usage.inputTokens || 0) / 1e6) * Number(p.cacheMiss || 0)
    + (Number(usage.outputTokens || 0) / 1e6) * Number(p.output || 0)
    + (Number(usage.cacheWriteTokens || 0) / 1e6) * Number(p.cacheWrite || 0);
  return usd * pricing.fx;
}

/** 会话里每条回复的时间和人民币成本（按 mtime 缓存） */
async function sessionMessageCosts(sessionId, pricing) {
  const file = await findSessionFile(sessionId);
  if (!file) return [];
  let st;
  try { st = await fs.stat(file); } catch { return []; }
  const hit = msgCache.get(sessionId);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.list;
  const buf = await fs.readFile(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { idx.push(i); i += 4; }
  let text = '';
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try { text += zstdDecompressSync(buf.subarray(idx[k], end)).toString('utf8'); } catch { /* 坏帧 */ }
  }
  const list = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant/message') continue;
    const d = rec.data || {};
    const usage = d.usage;
    if (!usage) continue;
    const model = (d.message && d.message.source && d.message.source.model) || '';
    list.push({ at: Number(rec.time || 0), cost: costOfMessage(usage, model, pricing, Number(rec.time || Date.now())) });
  }
  msgCache.set(sessionId, { mtimeMs: st.mtimeMs, list });
  return list;
}

/** 把每条消息的钱按任务的时间窗分配；窗口重叠时按同时活跃的任务数均分 */
async function attachWindowCost(tasks) {
  const pricing = await readPricing();
  const windows = [];   // { taskIdx, start, end }
  tasks.forEach((task, idx) => {
    for (const w of (task.windows || [])) {
      const start = Number(w.start || 0);
      const end = Number(w.end || Date.now());
      if (start) windows.push({ taskIdx: idx, start, end });
    }
  });
  if (!windows.length) return tasks;

  // 每个任务自己的会话（没挂就从窗口算，不读会话）
  const perTaskCost = tasks.map(() => 0);
  const perTaskTokens = tasks.map(() => 0);
  const seen = new Set();
  for (let ti = 0; ti < tasks.length; ti++) {
    for (const sid of (tasks[ti].sessions || [])) {
      if (seen.has(ti + '|' + sid)) continue;
      seen.add(ti + '|' + sid);
      const msgs = await sessionMessageCosts(sid, pricing);
      for (const m of msgs) {
        // 这条消息落在哪些任务的窗口里
        const active = windows.filter((w) => m.at >= w.start && m.at <= w.end);
        if (!active.length) continue;
        const share = m.cost / active.length;
        for (const w of active) {
          if (w.taskIdx === ti) perTaskCost[ti] += share;
        }
      }
    }
  }
  return tasks.map((task, idx) => ({
    ...task,
    costWindow: Number(perTaskCost[idx].toFixed(4)),
  }));
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

/** 给本机自测脚本用（不影响宿主） */
export const __internals = { buildEvolution, readEvolution, parseSoulBlock, lineDiff, dayKey, readSessionMessages, findSessionFile };

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
        if (method === 'GET' && path === ROUTE_SESSION) {
          const sid = url.searchParams.get('id') || '';
          if (!sid) return json(res, 400, { ok: false, error: 'need id' });
          const msgs = await readSessionMessages(sid, Number(url.searchParams.get('limit') || 60));
          if (!msgs) return json(res, 404, { ok: false, error: 'session not found' });
          return json(res, 200, { ok: true, messages: msgs });
        }

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
          const tasks = await attachWindowCost(attachCost(store.tasks, costs));
          return json(res, 200, {
            ok: true,
            tasks,
            summary: summarize(tasks),
            balance: await readBalance(),
            evolution: await readEvolution(),
            currentSession: await currentSessionId(),
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
              sessions: Array.isArray(body.sessions) && body.sessions.length
                ? body.sessions
                : (await currentSessionId() ? [await currentSessionId()] : []),
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
          t.windows = Array.isArray(t.windows) ? t.windows : [];
          if (body.status === 'running') {
            if (!t.windows.some((w) => w && w.start && !w.end)) t.windows.push({ start: Date.now() });
          } else {
            const ow = t.windows.find((w) => w && w.start && !w.end);
            if (ow) ow.end = Date.now();
          }
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

  // ---- 只维护时间窗：状态由人和我说了算，这里不猜 ----
  const syncWindows = async () => {
    try {
      const store = await readStore();
      let dirty = false;
      for (const task of store.tasks) {
        task.windows = Array.isArray(task.windows) ? task.windows : [];
        const open = task.windows.find((w) => w && w.start && !w.end);
        if (task.status === 'running') {
          if (!open) { task.windows.push({ start: Date.now() }); dirty = true; }
        } else if (open) {
          open.end = Date.now();
          dirty = true;
        }
      }
      if (dirty) await writeStore(store);
    } catch (e) {
      trace('syncWindows fail: ' + String((e && e.message) || e));
    }
  };
  syncWindows();
  const sweepTimer = setInterval(syncWindows, 60000);
  ctx.on?.('dispose', () => clearInterval(sweepTimer));
}
// hmr-test 09:09:25
// hmr-test2 09:14:07
// hmr-test3 09:14:50
// 热重载验证 09:31:10

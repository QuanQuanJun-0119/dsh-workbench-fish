/**
 * dsh-workbench-fish —— 浏览器侧
 *
 * 手写 ModuleLoader bundle（无构建步骤）。挂两个槽：
 *   sidebar.footer.action —— 侧栏底部「工作台」入口
 *   shell.overlay          —— 全屏面板（点入口打开）
 * 两个槽通过模块级事件总线联动。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbench-fish',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useCallback, useRef } = react;
    let createPortal = null;
    try {
      const rd = require('react-dom');
      createPortal = (rd && rd.createPortal) || (rd && rd.default && rd.default.createPortal) || null;
    } catch { createPortal = null; }

    const NS = 'workbench-fish';
    const API = '/workbench-fish/state';

    /* ---------------- 共享状态（跨槽） ---------------- */
    const bus = {
      open: false,
      listeners: new Set(),
      emit() { for (const fn of this.listeners) fn(this.open); },
      set(v) { this.open = v; this.emit(); },
      toggle() { this.set(!this.open); },
    };


    /* ---------------- 样式 ---------------- */
    const CSS = `
    .wf-fab{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #e3e8f0;
      border-radius:12px;background:#fff;color:#1f2937;font:inherit;cursor:pointer;text-align:left;transition:border-color .15s}
    .wf-fab:hover{border-color:#12a594;background:#fff}
    .wf-fab i{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#12a594;box-shadow:0 0 10px #12a594}
    .wf-fab .wf-fabcol{display:flex;flex-direction:column;gap:2px;min-width:0}
    .wf-fab .wf-fabt{font-size:15px;font-weight:700;line-height:1.2}
    .wf-fab .wf-fabs{font-size:11px;color:#9aa3b2;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .wf-root{position:fixed;inset:0;z-index:2147483000;background:#f5f7fa;display:flex;flex-direction:column;
      font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
    .wf-head{height:56px;flex:0 0 56px;background:#fff;border-bottom:1px solid #e3e8f0;display:flex;
      align-items:center;justify-content:space-between;padding:0 20px;gap:16px;position:relative}
    .wf-hl{display:flex;align-items:center;gap:14px;min-width:0}
    .wf-hc{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px}
    .wf-hr{display:flex;align-items:center}
    @media (max-width:680px){
      .wf-hc{position:static;transform:none;flex:1;justify-content:center}
      .wf-head{gap:8px;padding:0 12px}
      .wf-evo{padding:6px 12px;letter-spacing:.06em}
    }
.wf-brand{display:flex;align-items:center;gap:9px}
    .wf-branddot{width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#12a594,#38bdf8);box-shadow:0 0 10px rgba(56,189,248,.5)}
    .wf-brandname{font-size:16px;font-weight:800;letter-spacing:.06em;background:linear-gradient(100deg,#0f766e 0%,#0ea5a0 45%,#38bdf8 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
    .wf-tab{border:0;background:transparent;font:inherit;font-size:13px;color:#9aa3b2;padding:6px 14px;border-radius:14px;cursor:pointer}
    .wf-tab.on{background:#12a594;color:#fff;font-weight:600}
    .wf-evo{display:inline-flex;align-items:center;gap:7px;border:0;border-radius:999px;padding:7px 16px;
      background:linear-gradient(135deg,#0ea5a0,#38bdf8);color:#fff;font:inherit;font-size:12px;font-weight:700;
      letter-spacing:.12em;cursor:pointer;box-shadow:0 2px 10px rgba(56,189,248,.35);
      transition:box-shadow .18s,transform .18s,filter .18s}
    .wf-evo:hover{box-shadow:0 4px 16px rgba(56,189,248,.5);transform:translateY(-1px);filter:saturate(1.1)}
    .wf-evo.on{box-shadow:0 0 0 2px rgba(18,165,148,.28),0 4px 16px rgba(56,189,248,.45)}
    .wf-evo i{width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 8px #fff;flex:0 0 auto}
    .wf-spacer{flex:1}
    .wf-close{border:1px solid #e3e8f0;background:#fff;border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
    .wf-body{flex:1;display:flex;min-height:0}
    .wf-left{width:58%;overflow:auto;padding:14px 16px}
    .wf-split{width:10px;cursor:col-resize;background:#fff;border-left:1px solid #e3e8f0;border-right:1px solid #e3e8f0;flex:0 0 10px}
    .wf-right{flex:1;overflow:auto;background:#fff;padding:16px 18px;min-width:260px}
    .wf-bubbles{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:12px}
    .wf-b{background:#fff;border:1px solid #e3e8f0;border-radius:12px;padding:10px 12px}
    .wf-bclick{cursor:pointer;transition:border-color .15s,box-shadow .15s}
    .wf-bclick:hover{border-color:#b9c4d4}
    .wf-bclick.on{border-color:#12a594;box-shadow:0 0 0 2px rgba(18,165,148,.18)}
    .wf-bn{font-size:22px;font-weight:700;line-height:1.2}
    .wf-bl{font-size:12px;color:#5b6473}
    .wf-bc{font-size:10px;color:#9aa3b2;margin-top:4px}
    .wf-bar{height:4px;border-radius:2px;margin-top:8px}
    .wf-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .wf-bubbles4{grid-template-columns:repeat(4,1fr)}
    .wf-evo-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
    .wf-evo-card{padding:14px 16px}
    .wf-card{background:#fff;border:1px solid #e3e8f0;border-radius:12px;padding:10px 12px;cursor:pointer;position:relative;overflow:hidden}
    .wf-card.sel{border-color:#12a594;box-shadow:0 0 0 1px #12a594 inset}
    .wf-card .strip{position:absolute;left:0;top:0;bottom:0;width:4px}
    .wf-ct{font-size:13px;font-weight:600;padding-left:8px;display:flex;justify-content:space-between;gap:8px}
    .wf-cs{font-size:11px;color:#5b6473;padding-left:8px;margin-top:4px;line-height:1.45;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .wf-cm{font-size:10px;color:#9aa3b2;padding-left:8px;margin-top:6px;display:flex;justify-content:space-between}
    .wf-cost{color:#e5a53c;font-variant-numeric:tabular-nums}
    .wf-foot{flex:0 0 46px;height:46px;background:#fff;border-top:1px solid #e3e8f0;display:flex;align-items:center;gap:14px;padding:0 20px;font-size:11px;color:#9aa3b2}
    .wf-kv{display:flex;align-items:baseline;gap:6px}
    .wf-kv b{font-size:15px;color:#1f2937;font-variant-numeric:tabular-nums}
    .wf-div{width:1px;height:20px;background:#e3e8f0}
    .wf-h{font-size:15px;font-weight:700;margin:0 0 6px}
    .wf-pill{display:inline-block;font-size:10px;padding:2px 8px;border-radius:10px;margin-right:6px}
    .wf-sec{font-size:11px;font-weight:700;color:#1f2937;margin:16px 0 6px}
    .wf-txt{font-size:12px;color:#5b6473;line-height:1.6;white-space:pre-wrap}
    .wf-conv{background:#f7f9fc;border:1px dashed #e3e8f0;border-radius:10px;padding:10px;font-size:11px;color:#5b6473;line-height:1.7;max-height:180px;overflow:auto}
    .wf-btn{border:0;border-radius:9px;padding:8px 14px;font:inherit;font-size:12px;cursor:pointer;margin:6px 8px 0 0}
    .wf-btn.p{background:#12a594;color:#fff}
    .wf-btn.s{background:#eef1f6;color:#1f2937}
    .wf-empty{color:#9aa3b2;font-size:12px;padding:24px 0;text-align:center}
    .wf-crow{display:flex;align-items:center;gap:10px;font-size:12px;padding:6px 0;color:#5b6473}
    .wf-cbarwrap{flex:1;height:8px;border-radius:4px;background:#eef1f6;overflow:hidden}
    .wf-cbar{display:block;height:8px;border-radius:4px;background:#12a594}
    .wf-barwrap{height:6px;border-radius:3px;background:#eef1f6;overflow:hidden;margin:8px 0 0 8px}
    .wf-barfill{height:6px;border-radius:3px;transition:width .25s}
        .wf-heat{display:flex;gap:3px;flex-wrap:nowrap;overflow:hidden;margin-bottom:4px}
    .wf-heatcol{display:flex;flex-direction:column;gap:3px}
    .wf-heatcell{width:14px;height:14px;border-radius:3px}
    .wf-heatlegend{display:flex;align-items:center;gap:4px;font-size:10px;color:#9aa3b2;margin-top:6px}
    .wf-heatlegend i{display:inline-block;width:10px;height:10px;border-radius:2px}
    .wf-in{width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border:1px solid #dfe5ee;border-radius:8px;font:inherit;font-size:12px;outline:none}
    .wf-in:focus{border-color:#12a594}
    `;

    const COLOR = { running: '#2f6fed', waiting: '#e5a53c', stuck: '#e05252', done: '#2f9e6e', paused: '#9aa3b2' };
    const LABEL = { running: '进行中', waiting: '等你确认', stuck: '卡住了', done: '已完成', paused: '你暂停了' };
    const ORDER = ['running', 'waiting', 'stuck', 'done', 'paused'];

    function useCss() {
      useEffect(() => {
        if (document.getElementById('wf-style')) return;
        const el = document.createElement('style');
        el.id = 'wf-style';
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    /* ---------------- 侧栏入口 ---------------- */
    function Launcher() {
      return h('button', { className: 'wf-fab', onClick: () => bus.toggle() },
        h('i'),
        h('span', { className: 'wf-fabcol' },
          h('span', { className: 'wf-fabt' }, '工作台'),
          h('span', { className: 'wf-fabs' }, '任务 · 消耗 · 进化')));
    }

    /* ---------------- 全屏面板 ---------------- */
    function Panel() {
      useCss();
      const [open, setOpen] = useState(bus.open);
      const [tab, setTab] = useState(() => { const h = String(location.hash || ''); return h === '#cost' ? 'cost' : (h === '#evo' || h === '#evolve') ? 'evolve' : 'overview'; });
      const [state, setState] = useState({ tasks: [], summary: null, balance: null });
      const [sel, setSel] = useState(null);
      const [adding, setAdding] = useState(false);
      const [draft, setDraft] = useState({ title: '', summary: '' });
      const [sessInput, setSessInput] = useState('');
      const [filter, setFilter] = useState(null);
      const [sideW, setSideW] = useState(0);
      const [err, setErr] = useState('');
      const [loading, setLoading] = useState(true);
      const [daily, setDaily] = useState([]);
      const [costDays, setCostDays] = useState(91);
      const [leftW, setLeftW] = useState(58);
      const dragRef = useRef(false);
      const [host] = useState(() => document.createElement('div'));
      useEffect(() => {
        if (!open) return;
        document.body.appendChild(host);
        return () => { try { host.remove(); } catch {} };
      }, [open, host]);

      useEffect(() => {
        const fn = (v) => setOpen(v);
        bus.listeners.add(fn);
        return () => bus.listeners.delete(fn);
      }, []);

      const load = useCallback(async () => {
        try {
          // 刚用 ?token= 打开页面时，登录 cookie 可能还没落到第一个请求上，重试几次
          let r = null;
          for (let i = 0; i < 5; i++) {
            r = await fetch(API, { credentials: 'include' });
            if (r.ok) break;
            await new Promise((z) => setTimeout(z, 600 + i * 400));
          }
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'bad response');
          setState({ tasks: j.tasks || [], summary: j.summary, balance: j.balance, evolution: j.evolution || null, currentSession: j.currentSession || null });
          setErr('');
          setLoading(false);
        } catch (e) {
          setErr(String((e && e.message) || e));
          setLoading(false);
        }
      }, []);

      const loadDaily = useCallback(async (days) => {
        try {
          const dr = await fetch(`/workbench-fish/daily?days=${days}`, { credentials: 'include' });
          if (dr.ok) { const dj = await dr.json(); if (dj.days) setDaily(dj.days); }
        } catch { /* 忽略 */ }
      }, []);

      useEffect(() => {
        if (!open) return;
        const measure = () => {
          let right = 264;
          try {
            const cands = Array.from(document.querySelectorAll('[class*="sidebar"], [class*="Sidebar"]'));
            for (const el of cands) {
              const r = el.getBoundingClientRect();
              if (r.height > 300 && r.width > 120 && r.left <= 2) { right = Math.round(r.right); break; }
            }
          } catch { /* 忽略 */ }
          setSideW(right);
        };
        measure();
        window.addEventListener('resize', measure);
        load();
        const id = setInterval(load, 30000);
        return () => { clearInterval(id); window.removeEventListener('resize', measure); };
      }, [open, load]);

      useEffect(() => {
        if (!open) return;
        loadDaily(costDays);
      }, [open, costDays, loadDaily]);

      // 分隔条拖动
      useEffect(() => {
        const move = (e) => {
          if (!dragRef.current) return;
          const pct = Math.min(75, Math.max(30, (e.clientX / window.innerWidth) * 100));
          setLeftW(pct);
        };
        const up = () => { dragRef.current = false; document.body.style.cursor = ''; };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      }, []);

      if (!open) return null;

      const s = state.summary;
      const by = (s && s.byStatus) || {};
      const selected = state.tasks.find((t) => t.id === sel) || null;

      const bubbles = ORDER.map((k) => {
        const b = by[k] || { count: 0, cost: 0, tokens: 0 };
        return h('div', {
          key: k,
          className: 'wf-b wf-bclick' + (filter === k ? ' on' : ''),
          onClick: () => setFilter(filter === k ? null : k),
          title: filter === k ? '再点一下取消筛选' : '只看这个状态',
        },
          h('div', { className: 'wf-bn', style: { color: COLOR[k] } }, String(b.count)),
          h('div', { className: 'wf-bl' }, LABEL[k]),
          h('div', { className: 'wf-bc' }, `¥${(b.cost || 0).toFixed(2)} · ${fmtTok(b.tokens)}`),
          h('div', { className: 'wf-bar', style: { background: COLOR[k], opacity: 0.5, width: `${Math.min(100, 20 + b.count * 12)}%` } }));
      });

      const shown = filter ? state.tasks.filter((x) => x.status === filter) : state.tasks;
      const cards = shown.map((t) => h('div', {
        key: t.id,
        className: 'wf-card' + (t.id === sel ? ' sel' : ''),
        onClick: () => setSel(t.id),
      },
        h('div', { className: 'strip', style: { background: COLOR[t.status] || '#9aa3b2' } }),
        h('div', { className: 'wf-ct' }, h('span', null, t.title), h('span', { className: 'wf-cost' }, `¥${(t.cost || 0).toFixed(2)}`)),
        h('div', { className: 'wf-cs' }, t.summary || '（还没写摘要）'),
        h('div', { className: 'wf-barwrap' }, h('div', { className: 'wf-barfill', style: { width: `${Math.max(0, Math.min(100, Number(t.progress) || 0))}%`, background: COLOR[t.status] || '#9aa3b2' } })),
        h('div', { className: 'wf-cm' },
          h('span', { className: 'wf-pill', style: { background: (COLOR[t.status] || '#9aa3b2') + '22', color: COLOR[t.status] } }, LABEL[t.status] || t.status),
          h('span', null, `${fmtTok(t.tokens)} · ${LABEL[t.status] || ''}`))));

      const saveNew = async () => {
        if (!draft.title.trim()) { setErr('任务名不能空着'); return; }
        try {
          let r = await fetch('/workbench-fish/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ title: draft.title.trim(), summary: draft.summary.trim(), status: 'running' }),
          });
          if (r.status === 401) {
            await new Promise((z) => setTimeout(z, 800));
            r = await fetch('/workbench-fish/tasks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ title: draft.title.trim(), summary: draft.summary.trim(), status: 'running' }),
            });
          }
          if (!r.ok) { setErr(`新建失败（${r.status}），没存进去`); return; }
        } catch (e) {
          setErr('新建失败：' + String((e && e.message) || e));
          return;
        }
        setErr('');
        setAdding(false);
        setDraft({ title: '', summary: '' });
        load();
      };
      const addTile = adding
        ? h('div', { className: 'wf-card', style: { borderColor: '#12a594', cursor: 'default' } },
            h('input', { className: 'wf-in', placeholder: '任务名（必填）', value: draft.title, onChange: (e) => setDraft({ title: e.target.value, summary: draft.summary }) }),
            h('input', { className: 'wf-in', placeholder: '一句话摘要', value: draft.summary, onChange: (e) => setDraft({ title: draft.title, summary: e.target.value }) }),
            h('div', null,
              h('button', { className: 'wf-btn p', onClick: saveNew }, '保存'),
              h('button', { className: 'wf-btn s', onClick: () => { setAdding(false); setDraft({ title: '', summary: '' }); } }, '取消')))
        : h('div', { className: 'wf-card', style: { borderStyle: 'dashed', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa3b2', minHeight: 76 }, onClick: () => setAdding(true) }, '＋ 新建任务');

      const detail = selected
        ? h('div', null,
            h('div', { className: 'wf-h' }, selected.title),
            h('div', { style: { marginBottom: 4 } },
              h('span', { className: 'wf-pill', style: { background: (COLOR[selected.status] || '#9aa3b2') + '22', color: COLOR[selected.status] } }, LABEL[selected.status] || selected.status),
              h('span', { className: 'wf-txt' }, `¥${(selected.cost || 0).toFixed(2)} · ${fmtTok(selected.tokens)} tokens`)),
            h('div', { className: 'wf-barwrap', style: { marginTop: 8 } }, h('div', { className: 'wf-barfill', style: { width: `${Math.max(0, Math.min(100, Number(selected.progress) || 0))}%`, background: COLOR[selected.status] || '#9aa3b2' } })),
            h('div', { className: 'wf-txt', style: { marginTop: 4, color: '#9aa3b2' } }, `进度 ${Number(selected.progress) || 0}%`),
            h('div', { style: { marginTop: 10, marginBottom: 4 } },
              h('button', { className: 'wf-btn p', onClick: () => setStatus(selected, 'running', load) }, '继续'),
              h('button', { className: 'wf-btn s', onClick: () => setStatus(selected, 'paused', load) }, '暂停'),
              h('button', { className: 'wf-btn s', onClick: () => setStatus(selected, 'done', load) }, '标记完成')),
            h('div', { className: 'wf-sec' }, '判断（鱼鱼写的）'),
            h('div', { className: 'wf-txt' }, selected.judgment || '（没写）'),
            h('div', { className: 'wf-sec' }, '摘要'),
            h('div', { className: 'wf-txt' }, selected.summary || '（没写）'),
            h('div', { className: 'wf-sec' }, '关联会话'),
            h('div', { className: 'wf-conv' }, (selected.sessions && selected.sessions.length)
              ? selected.sessions.join('\n')
              : '还没挂会话（挂上才会算花费）'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('input', {
                className: 'wf-in',
                style: { marginTop: 0, flex: 1 },
                placeholder: '黏一个会话 id（session-…）',
                value: sessInput,
                onChange: (e) => setSessInput(e.target.value),
              }),
              h('button', { className: 'wf-btn p', style: { marginTop: 0 }, onClick: () => attachSession(selected, sessInput, load, setSessInput) }, '挂上')),
            state.currentSession
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
                  h('span', { className: 'wf-txt', style: { color: '#9aa3b2' } }, '当前会话'),
                  h('span', { className: 'wf-txt', style: { color: '#1f2937' } }, state.currentSession),
                  h('button', {
                    className: 'wf-btn s',
                    style: { margin: 0, padding: '5px 12px' },
                    onClick: () => attachSession(selected, state.currentSession, load, () => {}),
                  }, '挂上这个'))
              : null,
            )
        : h('div', { className: 'wf-empty' }, '点左边任意一张卡，这里出详情');

      const bal = state.balance;

      const evo = state.evolution || {};
      const costView = h('div', null,
        h('div', { className: 'wf-h' }, '消耗'),
        h('div', { className: 'wf-txt' }, `总消耗 ¥${s ? s.total.cost.toFixed(2) : '0.00'} · 余额 ${bal ? '¥' + bal.total.toFixed(2) : '—'}`),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { className: 'wf-sec', style: { margin: 0 } }, costDays >= 365 ? '最近 1 年' : `最近 ${costDays} 天`),
          h('div', { style: { display: 'flex', gap: 4 } },
            [[30, '月'], [91, '季'], [365, '年']].map(([d, l]) =>
              h('button', {
                key: d,
                className: 'wf-tab' + (costDays === d ? ' on' : ''),
                style: { padding: '3px 10px', fontSize: 11 },
                onClick: () => setCostDays(d),
              }, l)))),
        heatmap(daily),
        h('div', { className: 'wf-sec' }, '按类型'),
        h('div', { className: 'wf-bubbles wf-bubbles4' }, [
          { n: '任务', v: s ? s.total.cost : 0, c: '#2f6fed' },
          { n: '闲聊', v: 0, c: '#7c5cff' },
          { n: '头脑风暴', v: 0, c: '#e5a53c' },
          { n: '自我进化', v: 0, c: '#2f9e6e' },
        ].map((cat) => h('div', { key: cat.n, className: 'wf-b' },
          h('div', { className: 'wf-bn', style: { color: cat.c, fontSize: 18 } }, `¥${cat.v.toFixed(2)}`),
          h('div', { className: 'wf-bl' }, cat.n),
          h('div', { className: 'wf-bar', style: { background: cat.c, opacity: .5, width: `${s && s.total.cost ? Math.max(8, cat.v / s.total.cost * 100) : 8}%` } })))),
        h('div', { className: 'wf-txt', style: { color: '#9aa3b2', marginTop: 4 } }, '闲聊/头脑风暴/自我进化 要先给会话打标签才分得出来，v1 先只算任务'),
        h('div', { className: 'wf-sec' }, '按任务排（贵的在上）'),
        state.tasks.length
          ? h('div', null, state.tasks.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((x) => h('div', { key: x.id, className: 'wf-crow' },
              h('span', { style: { width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.title),
              h('span', { className: 'wf-cbarwrap' },
                h('span', { className: 'wf-cbar', style: { width: `${s && s.total.cost ? Math.max(2, (x.cost || 0) / s.total.cost * 100) : 0}%` } })),
              h('span', { className: 'wf-cost', style: { width: 58, textAlign: 'right' } }, `¥${(x.cost || 0).toFixed(2)}`),
              h('span', { style: { width: 64, textAlign: 'right', color: '#9aa3b2' } }, fmtTok(x.tokens)))))
          : h('div', { className: 'wf-empty' }, '还没有花钱的记录'));
      const evoCards = [
        {
          title: '鲸鱼的进化',
          color: '#2f6fed',
          lines: [
            `人格卡：${evo.persona ? evo.persona.bytes + ' 字节' : '没找到'}`,
            `常驻记忆：${evo.memoryBytes || 0} 字节`,
          ],
        },
        {
          title: '已加载的 skill',
          color: '#7c5cff',
          lines: (evo.skills && evo.skills.length) ? evo.skills.map((n) => '· ' + n) : ['没读到'],
        },
        {
          title: '当前人格卡',
          color: '#12a594',
          lines: (evo.cards && evo.cards.length)
            ? evo.cards.map((c) => `· ${c.name}　${c.bytes} 字节`)
            : ['（没读到卡文件）'],
        },
        {
          title: '主人进化',
          color: '#e5a53c',
          lines: ['这块 v1 先留位置', '以后记你学会的新规矩'],
        },
      ];
      const evolveView = h('div', null,
        h('div', { className: 'wf-h' }, '进化'),
        h('div', { className: 'wf-txt', style: { marginBottom: 4 } }, '鲸鱼长了什么、你长了什么'),
        h('div', { className: 'wf-evo-grid' }, evoCards.map((c) => h('div', { key: c.title, className: 'wf-b wf-evo-card' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h('i', { style: { width: 8, height: 8, borderRadius: '50%', background: c.color, display: 'inline-block' } }),
            h('span', { style: { fontSize: 14, fontWeight: 700 } }, c.title)),
          c.lines.map((ln, k) => h('div', { key: k, style: { fontSize: 12, color: '#5b6473', lineHeight: 1.7 } }, ln))))));


      const tree = h('div', { className: 'wf-root', style: { left: sideW ? sideW : 0 } },
        h('div', { className: 'wf-head' },
          h('div', { className: 'wf-hl' },
            h('span', { className: 'wf-brand' }, h('span', { className: 'wf-branddot' }), h('span', { className: 'wf-brandname' }, '鱼鱼的工作台')),
            h('button', { className: 'wf-evo' + (tab === 'evolve' ? ' on' : ''), onClick: () => setTab('evolve') },
              h('i'), h('span', null, '进化'))),
          h('div', { className: 'wf-hc' },
            h('button', { className: 'wf-tab' + (tab === 'overview' ? ' on' : ''), onClick: () => setTab('overview') }, '总览'),
            h('button', { className: 'wf-tab' + (tab === 'cost' ? ' on' : ''), onClick: () => setTab('cost') }, '消耗')),
          h('div', { className: 'wf-hr' },
            h('button', { className: 'wf-close', onClick: () => bus.set(false) }, '关闭'))),
        h('div', { className: 'wf-body' },
          tab !== 'overview' ? null :
          h('div', { className: 'wf-left', style: { width: `${leftW}%` } },
            err ? h('div', { className: 'wf-empty', style: { color: '#e05252' } }, '读取失败：' + err) : null,
            loading && !state.tasks.length ? h('div', { className: 'wf-empty' }, '读取中…') : null,
            h('div', { className: 'wf-bubbles' }, bubbles),
            h('div', { className: 'wf-cards' }, cards.concat([addTile]))),
          tab !== 'overview' ? null :
          h('div', { className: 'wf-split', onMouseDown: () => { dragRef.current = true; document.body.style.cursor = 'col-resize'; } }),
          h('div', { className: 'wf-right', style: tab === 'overview' ? null : { flex: '1 1 100%', padding: '20px 32px' } }, h('div', { style: tab === 'overview' ? null : { maxWidth: 820, margin: '0 auto' } }, tab === 'cost' ? costView : tab === 'evolve' ? evolveView : detail))),
        h('div', { className: 'wf-foot' },
          h('span', { className: 'wf-kv' }, '余额', h('b', null, bal ? `¥ ${bal.total.toFixed(2)}` : '—')),
          h('span', { className: 'wf-div' }),
          h('span', { className: 'wf-kv' }, '任务合计', h('b', null, s ? `¥ ${s.total.cost.toFixed(2)}` : '—')),
          h('span', { className: 'wf-div' }),
          h('span', { className: 'wf-kv' }, 'tokens', h('b', null, s ? fmtTok(s.total.tokens) : '—')),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'wf-close', onClick: load }, '刷新')));
      return createPortal ? createPortal(tree, host) : tree;
    }

    async function attachSession(task, sid, reload, clear) {
      const id = String(sid || '').trim();
      if (!id) return;
      const next = Array.from(new Set([...(task.sessions || []), id]));
      try {
        await fetch('/workbench-fish/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: task.id, sessions: next }),
        });
      } catch { /* 忽略 */ }
      clear('');
      reload();
    }

    async function setStatus(task, status, reload) {
      try {
        await fetch(`/workbench-fish/tasks/${encodeURIComponent(task.id)}/status`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ status }),
        });
      } catch { /* 忽略 */ }
      reload();
    }


    function heatmap(days) {
      if (!days || !days.length) return h('div', { className: 'wf-txt' }, '还没有数据');
      const max = Math.max(0.01, ...days.map((d) => d.cost));
      const shade = (v) => {
        if (!v) return '#ebedf0';
        const r = v / max;
        if (r < 0.25) return '#d3e0fb';
        if (r < 0.5) return '#a8c3f7';
        if (r < 0.75) return '#6f9bef';
        return '#2f6fed';
      };
      // 13 列 x 7 行
      const cols = [];
      for (let i = 0; i < days.length; i += 7) cols.push(days.slice(i, i + 7));
      return h('div', { className: 'wf-heat' },
        cols.map((col, ci) => h('div', { key: ci, className: 'wf-heatcol' },
          col.map((d) => h('div', {
            key: d.date,
            className: 'wf-heatcell',
            title: `${d.date} ¥${d.cost.toFixed(2)}`,
            style: { background: shade(d.cost) },
          })))),
        h('div', { className: 'wf-heatlegend' },
          h('span', null, '少'),
          ['#ebedf0', '#d3e0fb', '#a8c3f7', '#6f9bef', '#2f6fed'].map((s, i) => h('i', { key: i, style: { background: s } })),
          h('span', null, '多'),
          h('span', { style: { marginLeft: 10, color: '#9aa3b2' } }, `最贵一天 ¥${max.toFixed(2)}`)));
    }

    function fmtTok(n) {
      const v = Number(n || 0);
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
      return String(v);
    }

    /* ---------------- 注册 ---------------- */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'workbench-fish', order: 30 },
        () => h(Launcher)));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'workbench-fish', order: 30 },
        () => h(Panel)));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});

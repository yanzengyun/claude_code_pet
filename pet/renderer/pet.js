'use strict';
/* pet.js — 渲染 Claude 小人、驱动状态、订阅 agent 的 SSE。 */

// ---------- 1. 生成 Anthropic 星芒 spark ----------
function buildSpark() {
  const N = 11;                 // 叶片数
  const cx = 28, cy = 28;
  const rIn = 4.5, rOut = 26;   // 内/外半径
  const halfW = 3.6;            // 叶片根部半宽
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 56 56');
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const px = -dy, py = dx;    // 垂直方向
    const tipX = cx + dx * rOut, tipY = cy + dy * rOut;
    const baseX = cx + dx * rIn, baseY = cy + dy * rIn;
    const blade = document.createElementNS(ns, 'path');
    blade.setAttribute('class', 'blade');
    blade.setAttribute('d',
      `M ${tipX.toFixed(2)} ${tipY.toFixed(2)} ` +
      `L ${(baseX + px * halfW).toFixed(2)} ${(baseY + py * halfW).toFixed(2)} ` +
      `L ${(baseX - px * halfW).toFixed(2)} ${(baseY - py * halfW).toFixed(2)} Z`);
    svg.appendChild(blade);
  }
  const core = document.createElementNS(ns, 'circle');
  core.setAttribute('class', 'core');
  core.setAttribute('cx', cx); core.setAttribute('cy', cy); core.setAttribute('r', '5.5');
  svg.appendChild(core);
  document.getElementById('spark').appendChild(svg);
}

// ---------- 2. 状态文案 ----------
const STATE_LABEL = { working: '思考中', waiting: '需要你', idle: '待命', done: '完成', offline: '离线' };
function bubbleFor(snap) {
  const top = snap.sessions && snap.sessions[0];
  const proj = top && top.project ? top.project : '';
  switch (snap.pet) {
    case 'waiting': return proj ? `需要你！${proj}` : '需要你！';
    case 'done':    return '完成 ✓';
    case 'offline': return '离线';
    default:        return '';
  }
}

// ---------- 3. 应用快照 ----------
const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubbleText');
const panel = document.getElementById('panel');
const sessionsEl = document.getElementById('sessions');
const panelDot = document.getElementById('panelDot');
const panelStatus = document.getElementById('panelStatus');

let lastPet = null;
function applySnapshot(snap) {
  if (!snap || !snap.pet) return;
  pet.setAttribute('data-state', snap.pet);
  const text = bubbleFor(snap);
  bubbleText.textContent = text;

  // 通知 Electron 主进程（用于系统通知/提示音/托盘）
  if (window.petBridge && snap.pet !== lastPet) {
    window.petBridge.onState({ pet: snap.pet, reason: snap.reason, sessions: snap.sessions || [] });
  }
  lastPet = snap.pet;

  // 面板
  panelDot.setAttribute('data-s', snap.pet);
  panelStatus.textContent = STATE_LABEL[snap.pet] || snap.pet;
  renderSessions(snap.sessions || []);
}

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'empty'; li.textContent = '当前没有活跃会话';
    sessionsEl.appendChild(li);
    return;
  }
  for (const s of sessions.slice(0, 12)) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 's-dot ' + s.state;
    const proj = document.createElement('span');
    proj.className = 's-proj'; proj.textContent = s.project || s.sessionId.slice(0, 8);
    const meta = document.createElement('span');
    meta.className = 's-meta'; meta.textContent = STATE_LABEL[s.state] || s.state;
    li.append(dot, proj, meta);
    sessionsEl.appendChild(li);
  }
}

// ---------- 4. 拖拽 + 面板开合 ----------
// CSS 的 -webkit-app-region: drag 会吞掉 click，这里手动实现：
// 按住移动 = 拖窗口；按下抬起几乎没动 = 点击开合面板
let panelOpen = false;
const DRAG_THRESHOLD = 4; // px，超过视为拖拽
pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  let lastX = e.screenX, lastY = e.screenY, moved = 0;
  const onMove = (ev) => {
    const dx = ev.screenX - lastX, dy = ev.screenY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > DRAG_THRESHOLD && window.petBridge) window.petBridge.moveWindowBy(dx, dy);
    lastX = ev.screenX; lastY = ev.screenY;
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (moved <= DRAG_THRESHOLD) {
      panelOpen = !panelOpen;
      panel.hidden = !panelOpen;
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});
panel.addEventListener('mousedown', (e) => { e.stopPropagation(); });

// ---------- 5. 连接层（SSE） ----------
const connEl = document.getElementById('connState');
const connText = document.getElementById('connText');
function setConn(up, label) {
  connEl.className = 'conn ' + (up ? 'up' : 'down');
  connText.textContent = label;
}

let es = null, downTimer = null;
function connect(base, token) {
  const url = base.replace(/\/+$/, '') + '/events' + (token ? `?token=${encodeURIComponent(token)}` : '');
  try { es = new EventSource(url); } catch (e) { setConn(false, 'bad url'); return; }
  es.onopen = () => { setConn(true, base); clearTimeout(downTimer); };
  es.onmessage = (ev) => {
    if (!ev.data || ev.data[0] !== '{') return;
    try { applySnapshot(JSON.parse(ev.data)); } catch {}
  };
  es.onerror = () => {
    setConn(false, '重连中…');
    clearTimeout(downTimer);
    // 连续掉线一段时间 → 进入 offline 形态
    downTimer = setTimeout(() => applySnapshot({ pet: 'offline', reason: 'agent unreachable', sessions: [] }), 5000);
  };
}

// ---------- 6. 启动：真实 / mock / demo ----------
function start() {
  buildSpark();
  const q = new URLSearchParams(location.search);

  // 测试可视化：仅在 mock/demo 下给个桌面感背景（真实运行保持透明）
  if (q.get('mock') || q.get('demo')) {
    document.body.style.background =
      'linear-gradient(150deg,#cfd9e0 0%,#aeb9c2 55%,#9aa6b0 100%)';
  }

  if (q.get('mock')) {                       // 测试：仅渲染，不连
    setConn(false, 'mock');
    if (q.get('state')) applySnapshot({ pet: q.get('state'), reason: 'mock',
      sessions: [{ sessionId: 'demo1234', project: 'xiaoxia_train', state: q.get('state') }] });
    window.__setSnap = applySnapshot;        // 供 headless 测试驱动
    return;
  }
  if (q.get('demo')) {                        // 自动轮播展示
    setConn(true, 'demo');
    const seq = ['idle', 'working', 'waiting', 'done', 'idle', 'offline'];
    let i = 0;
    const proj = 'xiaoxia_train';
    setInterval(() => {
      const st = seq[i++ % seq.length];
      applySnapshot({ pet: st, reason: 'demo',
        sessions: st === 'offline' ? [] : [{ sessionId: 'demo1234', project: proj, state: st }] });
    }, 2200);
    return;
  }

  // 真实：从 Electron 注入的配置取 base/token；浏览器直跑则默认 localhost
  const cfg = (window.PET_CONFIG && window.PET_CONFIG.primary) || { url: 'http://127.0.0.1:47600', token: '' };
  setConn(false, 'connecting…');
  connect(cfg.url, cfg.token);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

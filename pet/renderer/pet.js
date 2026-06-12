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
// 工具名 → 人话（需 hooks 以 WITH_TOOLS=1 安装才有 PreToolUse 事件）
const TOOL_LABEL = {
  Bash: '执行命令', Edit: '修改代码', Write: '写文件', NotebookEdit: '改 Notebook',
  Read: '读代码', Grep: '搜索代码', Glob: '找文件',
  WebFetch: '查网页', WebSearch: '搜网页',
  Task: '派子任务', Agent: '派子任务', TodoWrite: '整理待办', Skill: '调用技能',
};
// 自动连接器阶段（offline 时气泡显示卡在哪一步）
let connStatus = null;
const CONN_LABEL = {
  probing: '探测连接…', tunneling: '隧道连接中…',
  deploying: '部署 agent…', starting: '启动 agent…', failed: '连接失败',
};
function bubbleFor(snap) {
  const top = snap.sessions && snap.sessions[0];
  const proj = top && top.project ? top.project : '';
  switch (snap.pet) {
    case 'waiting': return proj ? `需要你！${proj}` : '需要你！';
    case 'done':    return '完成 ✓';
    case 'offline': return (connStatus && CONN_LABEL[connStatus.phase]) || '离线';
    case 'working': {
      const t = top && top.toolName;
      return t ? `正在${TOOL_LABEL[t] || '用 ' + t}…` : '';
    }
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
  // idle 且无正经文案时，别打断正在显示的闲聊气泡（心跳推送会频繁触发本函数）
  if (!(snap.pet === 'idle' && !text && Date.now() < chatUntil)) {
    bubbleText.textContent = text;
    bubble.classList.toggle('show', !!text); // working 等仅在有文案时显示气泡
  }

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
    const projName = s.project || s.sessionId.slice(0, 8);
    const label = s.title || projName;   // 优先会话标题，悬停看项目名
    proj.className = 's-proj';
    proj.textContent = (multiSource && s.sourceName) ? `${s.sourceName}·${label}` : label;
    proj.title = projName;
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

/** 开/关面板：main 把窗口向旁边扩/缩，面板显示在小人侧边（默认右，贴边换左） */
async function setPanel(open) {
  panelOpen = open;
  if (!open) panel.hidden = true; // 先藏再缩窗，避免闪烁
  try {
    const r = window.petBridge && window.petBridge.panelToggle
      ? await window.petBridge.panelToggle(open) : null;
    if (r && r.side) document.body.setAttribute('data-panel-side', r.side);
  } catch {}
  if (open) panel.hidden = false;
}

// 互动反应：只加/移除 CSS 类做动画，不发任何事件、不改 data-state
let reactTimer = null;
function react(cls, ms) {
  clearTimeout(reactTimer);
  pet.classList.remove('react-land', 'react-click');
  pet.classList.add(cls);
  if (ms) reactTimer = setTimeout(() => pet.classList.remove(cls), ms);
}

pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  let lastX = e.screenX, lastY = e.screenY, moved = 0, dragging = false;
  const onMove = (ev) => {
    const dx = ev.screenX - lastX, dy = ev.screenY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > DRAG_THRESHOLD) {
      if (!dragging) { dragging = true; react('react-drag'); } // 被拎起来
      if (window.petBridge) window.petBridge.moveWindowBy(dx, dy);
    }
    lastX = ev.screenX; lastY = ev.screenY;
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (dragging) {
      pet.classList.remove('react-drag');
      react('react-land', 500);                                // 落地回弹
    } else if (moved <= DRAG_THRESHOLD) {
      react('react-click', 550);                               // 开心晃一晃
      setPanel(!panelOpen);
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});
panel.addEventListener('mousedown', (e) => { e.stopPropagation(); });
document.getElementById('panelClose').addEventListener('click', () => setPanel(false));

// 眼珠跟随鼠标（悬停在窗口内时）
const pupils = document.querySelectorAll('.pupil');
window.addEventListener('mousemove', (e) => {
  const r = pet.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.45;
  const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 90));
  const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 90));
  pupils.forEach((p) => { p.style.transform = `translate(${(dx * 2.5).toFixed(1)}px, ${(dy * 2.5).toFixed(1)}px)`; });
});
document.addEventListener('mouseleave', () => {
  pupils.forEach((p) => { p.style.transform = ''; });
});

// ---------- 闲聊气泡（仅 idle 时随机冒一句，纯视觉，不碰状态机） ----------
let chatUntil = 0;
const CHAT_LINES = {
  any: [
    '我在呢 ✦', '喝口水吧 💧', '站起来伸个懒腰？', '摸摸我试试 👀',
    '有任务随时叫我～', '发呆中…', '陪你上班的第 N 天', '拖我玩儿啊',
    '点我看会话列表', '休息一下眼睛吧', '保持水分，保持优雅', '嗯哼～',
  ],
  morning: ['早上好 ☀️', '今天也要加油呀', '先来杯咖啡？'],
  noon: ['午饭吃了吗？', '小憩一会儿也不错'],
  night: ['晚上好 🌙', '别忘了下班呀', '今天辛苦啦'],
  late: ['夜深了，早点休息 😴', '熬夜伤身，我先眯一会儿', '凌晨写码，注意身体'],
};
function pickChat() {
  const h = new Date().getHours();
  const pool = [...CHAT_LINES.any];
  if (h >= 6 && h < 11) pool.push(...CHAT_LINES.morning);
  else if (h >= 11 && h < 14) pool.push(...CHAT_LINES.noon);
  else if (h >= 18 && h < 23) pool.push(...CHAT_LINES.night);
  else if (h >= 23 || h < 6) pool.push(...CHAT_LINES.late);
  return pool[Math.floor(Math.random() * pool.length)];
}
function scheduleChat() {
  setTimeout(() => {
    if (pet.getAttribute('data-state') === 'idle' && !panelOpen) {
      bubbleText.textContent = pickChat();
      bubble.classList.add('show');
      chatUntil = Date.now() + 6000;
      setTimeout(() => {
        // 6 秒后若没被正经状态接管，收起
        if (Date.now() >= chatUntil && pet.getAttribute('data-state') === 'idle') {
          bubble.classList.remove('show');
          bubbleText.textContent = '';
        }
      }, 6200);
    }
    scheduleChat();
  }, 45000 + Math.random() * 90000); // 45s ~ 2min15s 随机
}
scheduleChat();

// 连接器阶段推送：offline 时实时刷新气泡文案
if (window.petBridge && window.petBridge.onConnectorStatus) {
  window.petBridge.onConnectorStatus((s) => {
    connStatus = s;
    if (pet.getAttribute('data-state') === 'offline') {
      const text = bubbleFor({ pet: 'offline', sessions: [] });
      bubbleText.textContent = text;
      bubble.classList.toggle('show', !!text);
    }
  });
}

// ---------- 5. 连接层（多源 SSE + 聚合） ----------
const connEl = document.getElementById('connState');
const connText = document.getElementById('connText');
function setConn(up, label) {
  connEl.className = 'conn ' + (up ? 'up' : 'down');
  connText.textContent = label;
}

const PRIO = { waiting: 0, working: 1, done: 2, idle: 3, error: 3, offline: 4 };
const sourceStates = new Map(); // name → { up, snap, downTimer }
let multiSource = false;        // >1 源时会话条目带来源前缀

function mergeAndApply() {
  const all = [...sourceStates.entries()];
  const ups = all.filter(([, st]) => st.up);
  if (!ups.length) {
    setConn(false, '重连中…');
    applySnapshot({ pet: 'offline', reason: 'all sources unreachable', sessions: [] });
    return;
  }
  const sessions = [];
  for (const [name, st] of ups) {
    if (!st.snap) continue;
    for (const s of (st.snap.sessions || [])) sessions.push({ ...s, sourceName: name });
  }
  sessions.sort((a, b) =>
    ((PRIO[a.state] ?? 3) - (PRIO[b.state] ?? 3)) || ((b.lastTs || 0) - (a.lastTs || 0)));
  const top = sessions[0];
  const pet = top ? (top.state === 'error' ? 'idle' : top.state) : 'idle';
  const reason = top ? `${top.state} @ ${top.project || ''}` : 'no active sessions';
  setConn(true, ups.map(([n]) => n).join(' + ') + (ups.length < all.length ? `（${all.length - ups.length} 源掉线）` : ''));
  applySnapshot({ pet, reason, sessions });
}

function connectSource(src) {
  const st = { up: false, snap: null, downTimer: null, es: null };
  sourceStates.set(src.name, st);
  const url = src.url.replace(/\/+$/, '') + '/events' +
    (src.token ? `?token=${encodeURIComponent(src.token)}` : '');
  let es;
  try { es = new EventSource(url); } catch { mergeAndApply(); return; }
  st.es = es;
  const markUp = () => { clearTimeout(st.downTimer); st.downTimer = null; if (!st.up) { st.up = true; mergeAndApply(); } };
  es.onopen = markUp;
  es.onmessage = (ev) => {
    if (!ev.data || ev.data[0] !== '{') return;
    try { st.snap = JSON.parse(ev.data); } catch { return; }
    markUp(); mergeAndApply();
  };
  es.onerror = () => {
    // EventSource 自动重连；连续 5s 连不上才把该源记为掉线
    if (st.downTimer || !st.up) return;
    st.downTimer = setTimeout(() => { st.up = false; st.downTimer = null; mergeAndApply(); }, 5000);
  };
}

function connectAll(sources) {
  multiSource = sources.length > 1;
  for (const src of sources) connectSource(src);
  if (!sources.length) {
    setConn(false, '未配置任何源');
    applySnapshot({ pet: 'offline', reason: 'no sources configured', sessions: [] });
  }
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

  // 皮肤：URL 参数优先（mock/demo 测试用），其次注入配置
  document.body.setAttribute('data-skin',
    q.get('skin') || (window.PET_CONFIG && window.PET_CONFIG.skin) || 'claude');

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

  // 真实：优先经 IPC 实时取配置（重新加载后能拿到最新值），兜底用注入配置/默认
  setConn(false, 'connecting…');
  Promise.resolve(window.petBridge && window.petBridge.getConfig ? window.petBridge.getConfig() : null)
    .catch(() => null)
    .then((live) => {
      const cfg = live || window.PET_CONFIG || {};
      document.body.setAttribute('data-skin', q.get('skin') || cfg.skin || 'claude');
      let sources = Array.isArray(cfg.sources) ? cfg.sources : null;
      if (!sources || !sources.length) {
        const p = cfg.primary || { name: 'local', url: 'http://127.0.0.1:47600', token: '' };
        sources = [{ name: p.name || 'local', url: p.url, token: p.token || '' }];
      }
      connectAll(sources.filter((s) => s.url));
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

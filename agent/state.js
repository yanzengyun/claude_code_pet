'use strict';
/*
 * state.js — 把 collector 的基线 session 状态 + hook 精确事件 + 上一拍状态
 * 聚合成「桌宠总状态」。纯函数、无副作用、可单测。
 */

// hook 事件名 → session 状态
// 注意：SubagentStop 不映射 working —— 后台子任务可能在主轮 Stop 之后才结束，
// 若映射 working 会把已完成的会话重新钉成"思考中"（实测踩过）。
const HOOK_STATE = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'idle',
  SessionStart: 'idle',
  SessionEnd: 'offline',
};

// working 类事件真干活时会连续刷新（每次工具调用都有），权威期短才安全；
// Stop/Notification 是终态/等待语义，才配长权威期
const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

function hookEventToState(event) {
  return HOOK_STATE[event] || null;
}

// 桌宠总状态优先级（数字小=优先）
const PET_PRIORITY = { waiting: 0, working: 1, done: 2, idle: 3, offline: 4 };

/**
 * @param {Object} p
 *  - sessions: collector 输出的 Session[]
 *  - hookState: { [sid]: { state, event, ts, cwd, project, toolName } } 权威 hook 态
 *  - prev: { sessionStates:{sid:state}, doneUntil:{sid:ts}, pet } 上一拍
 *  - now: ms
 *  - opts: { hookTtlMs, doneWindowMs }
 * @returns { pet, reason, sessions, changedAt, prev }
 */
function aggregate(p = {}) {
  const now = p.now || Date.now();
  const opts = p.opts || {};
  const hookTtlMs = opts.hookTtlMs ?? 15 * 60 * 1000; // hook 态最长有效期（防卡死）
  const workingHookTtlMs = opts.workingHookTtlMs ?? 2 * 60 * 1000; // working 类事件的短权威期
  const doneWindowMs = opts.doneWindowMs ?? 4000;
  const hookState = p.hookState || {};
  const prev = p.prev || { sessionStates: {}, doneUntil: {}, pet: 'idle' };
  const prevStates = prev.sessionStates || {};
  const prevDone = prev.doneUntil || {};

  // 合并：collector sessions ∪ 仅在 hookState 里出现的 session
  const bySid = new Map();
  for (const s of (p.sessions || [])) bySid.set(s.sessionId, { ...s });
  for (const sid of Object.keys(hookState)) {
    if (!bySid.has(sid)) {
      const h = hookState[sid];
      bySid.set(sid, {
        sessionId: sid, pid: null, alive: false,
        cwd: h.cwd || null, project: h.project || null, gitBranch: null,
        lastRole: null, lastTs: h.ts || null, jsonlMtime: null,
        cpuActive: false, state: 'idle', source: 'hook',
      });
    }
  }

  const sessions = [];
  const newStates = {};
  const newDone = {};

  for (const s of bySid.values()) {
    const sid = s.sessionId;
    let state = s.state;
    let source = 'heuristic';

    // 1) hook 权威覆盖（在 TTL 内；working 类事件用短 TTL，超时回落启发式）
    const h = hookState[sid];
    const ttl = h && WORKING_EVENTS.has(h.event) ? Math.min(hookTtlMs, workingHookTtlMs) : hookTtlMs;
    if (h && hookEventToState(h.event) && (now - h.ts) < ttl) {
      const hs = hookEventToState(h.event);
      if (hs === 'offline') {
        continue; // SessionEnd：从展示里移除
      }
      state = hs;
      source = 'hook';
      s.hookEvent = h.event; // 可观测性：当前权威态来自哪个 hook 事件
      if (h.toolName) s.toolName = h.toolName;
      if (!s.cwd && h.cwd) s.cwd = h.cwd;
      if (!s.project && h.project) s.project = h.project;
    }

    // 2) done 跃迁：上一拍是 working、这拍变 idle → 展示 done 一小段
    const prevState = prevStates[sid];
    if (state === 'idle') {
      const wasWorking = prevState === 'working';
      const stillInDone = prevDone[sid] && now < prevDone[sid];
      if (wasWorking) {
        newDone[sid] = now + doneWindowMs;
        state = 'done';
      } else if (stillInDone) {
        newDone[sid] = prevDone[sid];
        state = 'done';
      }
    }

    newStates[sid] = (state === 'done') ? 'idle' : state; // done 记账为 idle，避免反复触发
    s.state = state;
    s.source = source;
    sessions.push(s);
  }

  // 3) 排序 + 总状态
  sessions.sort((a, b) =>
    (PET_PRIORITY[a.state] - PET_PRIORITY[b.state]) || ((b.lastTs || 0) - (a.lastTs || 0)));

  let pet = 'idle';
  let reason = 'no active sessions';
  if (sessions.length) {
    const top = sessions.reduce((best, s) =>
      (PET_PRIORITY[s.state] < PET_PRIORITY[best.state] ? s : best), sessions[0]);
    pet = top.state === 'error' ? 'idle' : top.state;
    reason = `${top.state} @ ${top.project || top.sessionId.slice(0, 8)}`;
  }

  const changedAt = (pet !== prev.pet) ? now : (prev.changedAt || now);

  return {
    pet,
    reason,
    sessions,
    changedAt,
    ts: now,
    prev: { sessionStates: newStates, doneUntil: newDone, pet, changedAt },
  };
}

/**
 * 按订阅方的 slug 白名单过滤快照（共享 agent 多人订阅用）。
 * @param snap 全量快照  @param includes slug 子串数组  @param slugOf cwd→slug 函数
 */
function filterSnapshot(snap, includes, slugOf) {
  if (!includes || !includes.length) return snap;
  const sessions = (snap.sessions || []).filter((s) => {
    const slug = slugOf(s.cwd || '');
    return includes.some((inc) => slug.includes(inc));
  });
  let pet = 'idle';
  let reason = 'no active sessions';
  if (sessions.length) {
    const top = sessions.reduce((best, s) =>
      ((PET_PRIORITY[s.state] ?? 3) < (PET_PRIORITY[best.state] ?? 3) ? s : best), sessions[0]);
    pet = top.state === 'error' ? 'idle' : top.state;
    reason = `${top.state} @ ${top.project || String(top.sessionId || '').slice(0, 8)}`;
  }
  return { ...snap, pet, reason, sessions };
}

module.exports = { aggregate, hookEventToState, HOOK_STATE, PET_PRIORITY, filterSnapshot };

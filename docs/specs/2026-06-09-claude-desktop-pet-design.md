# Claude 桌宠（Claude Desktop Pet）设计文档

- 日期：2026-06-09
- 作者：Claude（受 zengyuny 委托设计并构建）
- 状态：已批准方向，进入实现

## 1. 目标

在 macOS 上做一个 **Claude 官方风格的桌宠**：桌面上一个悬浮的 Claude 小人，
**随被监控的 Claude Code 客户端运行状态实时变换动作/表情**，并在「Claude 卡住等你点权限」
或「任务完成」时主动**系统通知 + 可选提示音**叫你回来。

可监控两类目标（同一套桌宠，配置切换/叠加）：
1. **远程**：跑在 vibe 服务器上的 Claude Code（首发，可在 vibe 端到端验证）。
2. **本地**：跑在你 MacBook 上的 Claude Code（第二步，桌宠直接读本机 `~/.claude`）。

核心价值（用户确认）：**既陪伴也提醒**——平时是个好看的小人陪着，关键时刻把你叫回来。

## 2. 非目标（YAGNI）

- 不做账号体系/云端、不做多用户、不做 Windows/Linux 桌宠（仅 macOS）。
- 不替代 Claude Code 本身的任何功能，不读/不改对话内容（只看状态信号）。
- v1 不做换肤商店、不做复杂养成系统。

## 3. 架构总览

```
┌────────────── vibe 服务器 ──────────────┐
│  Claude Code 多个 session                │
│   ├─ ~/.claude/projects/<slug>/*.jsonl   │  ← 事件流（含 timestamp/cwd/sessionId）
│   └─ 进程 claude --resume <id> ...        │  ← 活进程 + /proc CPU 增量
│            │                              │
│            ▼                              │
│  cc-pet-agent (Node)                      │
│   • collector：读 jsonl尾 + 扫进程 → 每   │
│     session 状态                          │
│   • (可选) POST /hook 接收精确事件         │
│   • GET /status (JSON) + GET /events (SSE)│
│     经 https://vibe.../proxy/<PORT>/ 暴露  │
└───────────────┬──────────────────────────┘
   SSE 实时推送   │
                 ▼
┌────────────── 你的 MacBook ──────────────┐
│  cc-pet (Electron)                        │
│   • 透明/置顶/无边框窗口 → Claude 小人      │
│   • 订阅一个或多个 agent 的 SSE            │
│   • waiting/done → mac 系统通知 + 可选音    │
│   • 点击 → 小面板列出活跃 session + 状态    │
│   • (第二步) 内置本地 collector 读本机      │
└───────────────────────────────────────────┘
```

## 4. 状态模型

### 4.1 单 session 状态
`working`（正在干活）/ `waiting`（卡住等你：权限或输入）/ `idle`（空闲待命）/
`done`（刚完成，瞬时）/ `error`（异常，可选）。

### 4.2 桌宠总状态（多 session 聚合，优先级从高到低）
1. 任一 `waiting` → 桌宠 **waiting**：招手 + 冒「!」+ 系统通知 + 可选提示音。
2. 任一 `working` → 桌宠 **working**：思考/打字动画。
3. 刚有 `working→idle` 跃迁 → 桌宠 **done**：庆祝约 3s 再转 idle。
4. 都空 → **idle**：打盹/呼吸。
5. 连不上任何 agent → **offline**：灰、半透明。

### 4.3 状态来源（两层）
- **基线（零配置，立即可用）**：
  - 进程扫描：`ps` 找 `claude ... --resume <id>`；`/proc/<pid>/stat` 采样 utime+stime
    两次（间隔约 700ms）得 CPU 增量 → 判「此刻是否在算」。
  - jsonl 尾：读对应 `<sessionId>.jsonl` 最后一条 `user`/`assistant` 内容事件，取
    `timestamp`/role/`cwd`/`gitBranch`，结合文件 mtime。
  - 判定规则（每 session）：
    - CPU 增量高 或 jsonl 刚写(<4s) → `working`
    - 否则 last role=assistant → `idle`（轮次结束，等你）
    - 否则 last role=user 且未超宽限(30s) → `working`（刚提交）；超宽限且低 CPU → `idle`
    - 无进程且 jsonl 陈旧(>5min) → 不展示（视为已关闭）
  - 局限：基线无法区分「空闲等输入」与「暂停等权限」，两者都显示 idle。
- **可选 hook 增强（用户已同意，只影响 junjiet 自己）**：
  - 装 `~/.claude/hooks/cc-pet-notify.sh`，注册到事件：
    `UserPromptSubmit`→working，`PreToolUse`→working，`Notification`→**waiting**，
    `Stop`→done/idle，`SessionStart`→online，`SessionEnd`→offline。
  - hook 把 `{event, sessionId, cwd, ...}` 用 `curl --max-time 1` 后台 POST 给 agent。
  - 安装脚本**先备份 settings.json、只增不改、JSON 解析后合并、原子写回、校验**；
    agent 不在/超时也**绝不阻塞** Claude Code（后台 + 超时 + 失败静默）。
  - hook 事件在 agent 内为**权威状态**，带 TTL，覆盖启发式；TTL 内无新事件则回落启发式。

## 5. 组件与接口（单一职责、可独立测）

### agent/collector.js
- `scanSessions(opts) -> Session[]`
- `Session = { sessionId, cwd, project, state, role, lastTs, pid, cpuActive, source }`
- 依赖：文件系统（`~/.claude/projects`）、`ps`、`/proc`。纯数据输出，便于断言。

### agent/state.js
- `aggregate(sessions, hookEvents, prevState) -> { pet, sessions, changedAt }`
- 处理 hook TTL 覆盖、done 跃迁检测、总状态优先级。无副作用、可单测。

### agent/server.js
- `GET /status` → `{ pet, sessions, ts }`
- `GET /events` → SSE，状态变化即推（也定时心跳）
- `POST /hook` → 收 hook 事件写入内存（带时间戳）
- `GET /health` → ok
- 可选 `?token=` 简单校验（经 vibe proxy 暴露时启用）。

### hooks/
- `cc-pet-notify.sh`：读 stdin 的 hook JSON，POST 给 agent。
- `install-hooks.sh` / `uninstall-hooks.sh`：备份 + 合并/移除 settings.json 中的 hook 注册。

### pet/（Electron，跑在 Mac）
- `main.js`：透明无边框置顶窗、托盘菜单、系统通知/提示音、SSE 客户端、读 config。
- `preload.js`：安全暴露 IPC。
- `renderer/`：Claude 小人 + 各状态动画（纯网页，可单独无头截图验证）。
- `config.example.json`：要连的 agent 列表（远程 proxy URL / 本地）。

## 6. Claude 官方视觉风格
- 主色：Claude 珊瑚/赤陶 `#CC785C`（标志性 terracotta），辅暖米白 `#F0EEE6`。
- 小人：圆润 sparkle/星芒造型 + 简单眼睛，透明背景。
- 每状态不同动画：idle 呼吸打盹、working 星芒旋转/打字点、waiting 弹跳招手+「!」、
  done 一圈高光脉冲、offline 灰掉半透明。

## 7. 验证策略（goal-driven）
1. collector 对真实 jsonl + 合成 fixture 单测，断言状态判定。【vibe 可验】
2. 起 agent，curl `/status`、连 `/events` SSE、模拟 `/hook` POST 看翻转。【vibe 可验】
3. 经 vibe proxy URL 从「外部」curl 一遍（模拟 Mac 客户端）。【vibe 可验】
4. 无头浏览器开 renderer，喂 mock 状态，逐状态截图确认小人样式。【vibe 可验】
5. 透明窗+托盘+系统通知：给 Mac 上精确运行步骤 + 自检清单。【仅用户可验】

## 8. 风险 / 注意
- **Mac 原生外壳无法在 vibe 验证**：选 Electron，用户 `npm install && npm start` 即可跑，
  无需 Xcode；renderer 在本地浏览器可完整预览。
- **基线状态精度有限**：靠 hook 增强补「等权限」精确态。
- **改 settings.json 有风险**：备份 + 只增不改 + 原子写 + 校验；hook 失败不阻塞 Claude。
- **proxy 暴露安全**：SSE 端点加可选 token；不外泄对话内容，只传状态摘要。
- **跨用户凭据红线**：只读 junjiet 自己路径，不碰其他用户 `.claude`。

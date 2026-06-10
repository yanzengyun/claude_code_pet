# Claude 桌宠 · claude-desktop-pet

桌面上一只 **Claude 官方风格的小人**，随你监控的 Claude Code 运行状态变表情/动作：
思考时星芒转圈、卡住等你点权限时弹跳招手 + 系统通知叫你回来、任务完成时庆祝、空闲时打盹。
支持监控 **远程 vibe 上的 Claude Code** 和 **你本地 Mac 上的 Claude Code**。

```
  idle 打盹      working 思考      waiting 需要你!      done 完成      offline 离线
   (｡-‿-)         ✦ 转转转          ❗弹跳+通知         ✓ 撒花         (灰) zzz
```

## 它由两部分组成

| 部分 | 跑在哪 | 作用 | 状态 |
|---|---|---|---|
| **agent**（Node，零依赖） | 被监控的机器上（vibe / 你的 Mac） | 读 Claude Code 的会话文件+进程，算出状态，用 HTTP/SSE 推出来 | ✅ 已在 vibe 验证 |
| **pet**（Electron） | 你的 Mac | 透明置顶的小人，订阅 agent 的状态，变动作 + 系统通知 | 需你在 Mac 上 `npm start` |

---

## 一、在 vibe 上启动 agent（监控远程 Claude Code）

```bash
cd /home/q/vibe/projects/zengyuny/claude-desktop-pet/agent
bash start.sh           # 后台启动，默认端口 47600，只看 zengyuny 自己的会话
curl http://127.0.0.1:47600/status   # 自测：应返回 {"pet":..., "sessions":[...]}
bash stop.sh            # 需要时停止
```

- 配置在 `agent/config.json`：
  - `slugIncludes`: `["-home-q-vibe-projects-zengyuny"]` —— 只监控你自己的项目（vibe 是共享机，别人的会话不会进来）。
  - `port` / `token`：默认 47600、无 token。要经公网代理暴露时建议设 `token`（pet 端配置里同步填上）。
- 机器重启后 nohup 会丢，要长期跑可挂 cron：`*/5 * * * * .../agent/start.sh`（幂等）。

---

## 二、在 Mac 上启动桌宠 pet

需要 Mac 装了 **Node ≥ 18**（`node -v` 看一下；没有就先 `brew install node`）。

```bash
# 把整个 claude-desktop-pet/ 目录拷到你 Mac（scp 或 git），然后：
cd claude-desktop-pet/pet
npm install            # 装 Electron（首次约几十 MB）
npm start              # 启动桌宠
```

启动后右下角出现 Claude 小人，菜单栏有一个 spark 托盘图标（显示/隐藏、登录、退出）。

### 打包成 .dmg（双击安装版）

`.dmg` **只能在 macOS 上构建**（依赖 mac 专有的 `hdiutil`/`iconutil`），所以这步在你的 Mac 上做：

```bash
cd claude-desktop-pet/pet
bash build-dmg.sh          # 同时出 arm64 + x64；或 build-dmg.sh arm / intel 只出一个
# 产物在 pet/dist/Claude Pet-0.1.0-*.dmg
```
- 脚本自动 `npm install` + `electron-builder --mac dmg`，应用图标已内置（`assets/icon.png`，cream 圆角瓷砖 + Claude 小人）。
- 安装：双击 dmg → 把「Claude Pet」拖进 Applications。
- 这是**未签名**应用，首次打开被 Gatekeeper 拦时二选一：
  右键 App →「打开」→ 再点「打开」；或终端 `xattr -cr "/Applications/Claude Pet.app"`。
- 装好后 App 自带托盘常驻，不再依赖 `npm start`；连接配置读 `~/.cc-pet/config.json`（没有则用 App 内置默认）。

---

## 三、让 Mac 的桌宠连上 vibe 的 agent（二选一）

vibe 的 agent 监听在服务器的 `127.0.0.1:47600`，Mac 要连过去，两种方式：

### 方式 A · SSH 隧道（推荐，最稳，无需登录）
在 Mac 上开一个隧道，把 vibe 的 47600 映射到本地 47600：
```bash
ssh -N -L 47600:127.0.0.1:47600 <你的用户名>@vibe.corp.tujia.com
```
保持这个终端开着。`pet/config.json` 用默认的 `"url": "http://127.0.0.1:47600"` 即可。

### 方式 B · 走 vibe 代理 + 登录（没有 SSH 时用）
vibe 用 `https://vibe.corp.tujia.com/zengyuny/proxy/47600/` 暴露端口，但前面有公司 SSO 登录。
改 `pet/config.json`（或 `~/.cc-pet/config.json`）：
```json
{
  "primary": { "name": "vibe", "url": "https://vibe.corp.tujia.com/zengyuny/proxy/47600", "token": "" },
  "ssoOrigin": "https://vibe.corp.tujia.com"
}
```
启动桌宠后，点托盘菜单 **「登录 vibe（代理连接用）」**，在弹出的窗口里登录一次；
登录后的 cookie 桌宠会复用，自动连上（关掉登录窗即可）。

> 配置改完重启 `npm start`，或点托盘「重新加载」。

---

## 四、（可选）装精确状态钩子 —— 准确识别「Claude 在等你点权限」

不装也能用（靠读会话文件+进程判断 working/idle/done）；装了能精确捕捉
`Notification`(等权限/等输入) / `Stop`(完成) / `UserPromptSubmit`(开工) 等时刻。

在 **agent 所在的机器**（vibe）上：
```bash
cd claude-desktop-pet/hooks
./install-hooks.sh                 # 先预览：只打印会加什么 + 生成 *.cc-pet-preview，不动你的 settings.json
./install-hooks.sh --apply         # 确认后真正写入（自动备份 settings.json.bak-<时间戳>，只增不改）
./uninstall-hooks.sh --apply       # 想撤销时
```
- 只追加，不动你已有的任何 hook；写前备份、写后校验 JSON。
- 钩子转发用 `curl --max-time 1` 后台执行，agent 挂了也**绝不阻塞 Claude Code**。
- agent 端口/带 token 不同：在 shell 里 `export CC_PET_URL=... CC_PET_TOKEN=...`。

---

## 五、监控本地 Mac 的 Claude Code（图形化，一键开启）

点托盘菜单 **「设置…」** → 勾选 **「自动监控本机 ~/.claude」** → 保存。
桌宠会自动拉起一个内置本地 agent（默认端口 47601，无需手动 `node server.js`），
**vibe 远程 + 本机双源同时监控**，小人显示两边里最需要你的状态；
面板里的会话条目带 `来源·项目` 前缀区分。

设置窗口同时可配：远程源地址/token、SSO 站点、通知与提示音开关——保存即生效，
落盘在 `~/.cc-pet/config.json`（也可手改）。本地 agent 想加过滤可建 `~/.cc-pet/local-agent.json`
（格式同 `agent/config.json`，默认监控本机全部项目）。

---

## 状态判定逻辑（简述）

- **基线**：扫 `claude` 进程（`--resume <id>` 关联会话）+ `/proc` CPU 增量判「此刻在算」+ 读会话
  `*.jsonl` 末条事件与 mtime → `working / idle`；`working→idle` 跃迁 → `done`。
- **钩子（可选）**：`Notification→waiting`、`Stop→done/idle`、`UserPromptSubmit→working` 等，
  作为权威态覆盖基线，带 TTL 防卡死。
- **多会话聚合**优先级：`waiting > working > done > idle`；连不上 agent → `offline`。

## 自测 / 排错

```bash
# agent 是否健康
curl http://127.0.0.1:47600/health           # {"ok":true,...}
curl http://127.0.0.1:47600/status           # 看 pet 和 sessions
# 看实时推送
curl -N http://127.0.0.1:47600/events         # 持续打印 data: {...}
# 跑单测
node test/state.test.js                        # 状态聚合逻辑
```
- 桌宠一直 `offline`：agent 没起 / 隧道没开 / 代理没登录 / url 端口不对。
- vibe 上 `status` 里混进别人的会话：检查 `slugIncludes` 是不是你自己的项目前缀。
- 没有系统通知：macOS「系统设置 → 通知」允许「Claude Pet / Electron」。

## 设计文档
`docs/specs/2026-06-09-claude-desktop-pet-design.md`

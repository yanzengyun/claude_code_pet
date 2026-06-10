# Claude 桌宠 · claude-desktop-pet

桌面上一只 **Claude 官方风格的小人**，随你监控的 Claude Code 运行状态变表情/动作：
思考时星芒转圈、卡住等你点权限时弹跳招手 + 系统通知叫你回来、任务完成时庆祝、空闲时打盹。
支持监控 **远程 vibe 上的 Claude Code** 和 **你本地 Mac 上的 Claude Code**（托盘一键切换）。

```
  idle 打盹      working 思考      waiting 需要你!      done 完成      offline 离线
   (｡-‿-)         ✦ 转转转          ❗弹跳+通知         ✓ 撒花         (灰) zzz
```

**亮点功能**

- 🫧 **工具气泡**：working 时头顶冒「正在执行命令…/修改代码…/搜索代码…」，瞟一眼就知道进展（需装 `--with-tools` 钩子）。
- 🏷️ **会话标题**：点开面板显示每个会话的标题（Claude 自动生成的 `ai-title`，无则用最后一条用户消息），多会话不再分不清。
- 🎭 **互动反应**：拖着走会吊摆瞪眼、松手落地回弹、点击开心晃动、眼珠跟随鼠标——纯视觉，不影响状态判定。
- ⚙️ **图形化设置**：托盘「设置…」配连接 / 通知 / 音效 / 监控目标，保存即生效。
- 🐢 **换肤**：托盘或设置里一键切「Claude 小人 / 像素小蓝龟」，全状态动画两套皮肤通用（像素画为自绘，box-shadow 网格渲染）。

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
在 Mac 上开一个隧道，把 vibe 的 47600 映射到本地 47600。**用你平时 ssh 登 vibe 的真实地址**
（例如 `zengyuny@l-picservice4.tj.cn5`，不是网页域名 `vibe.corp.tujia.com`——后者只走网页 SSO，密码登不上）：
```bash
ssh -N -L 47600:127.0.0.1:47600 zengyuny@l-picservice4.tj.cn5
```
- 窗口会"卡住"不动 = 正常，保持开着别关。
- `pet/config.json` 用默认的 `"url": "http://127.0.0.1:47600"` 即可。
- Mac 睡眠/换网后隧道会断，桌宠转灰，重跑这条即可。嫌烦可用 `autossh` 自动重连。

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
./install-hooks.sh                       # 先预览：只打印会加什么 + 生成 *.cc-pet-preview，不动你的 settings.json
./install-hooks.sh --apply               # 确认后真正写入（自动备份 settings.json.bak-<时间戳>，只增不改）
./install-hooks.sh --apply --with-tools  # 额外注册 PreToolUse/PostToolUse → 启用「工具气泡」（更实时）
./uninstall-hooks.sh --apply             # 想撤销时
```
- 只追加，不动你已有的任何 hook；写前备份、写后校验 JSON。
- 钩子转发用 `curl --max-time 1` 后台执行，agent 挂了也**绝不阻塞 Claude Code**。
- agent 端口/带 token 不同：在 shell 里 `export CC_PET_URL=... CC_PET_TOKEN=...`。
- **钩子是会话启动时加载的**：装/改钩子后，只对**新开的** Claude Code 会话生效，已开的要重启。
- `--with-tools` 必须用命令行参数（环境变量 `WITH_TOOLS=1` 不生效）。

---

## 五、切换监控目标：vibe 远程 / 本机（图形化）

**托盘菜单直接切**：「监控 vibe（远程）」/「监控本机（~/.claude）」两个单选项，点了立即生效。
切到本机时桌宠自动拉起内置 agent（默认端口 47601，无需手动 `node server.js`），切回远程自动停掉。

更多配置点托盘 **「设置…」**：远程源地址/token、SSO 站点、本地端口、通知与提示音开关——
保存即生效，落盘在 `~/.cc-pet/config.json`（也可手改）。本地 agent 想加过滤可建
`~/.cc-pet/local-agent.json`（格式同 `agent/config.json`，默认监控本机全部项目）。

**会话面板**：点小人在旁边展开（默认右侧，贴屏幕边自动换左侧），点 ✕ 或再点小人关闭。

---

## 六、多人共用与二次开发（同机其他同学看这里）

vibe 是共享机，**hooks 是机器级共享设施**——已经装好、对所有人的会话都在发事件，
你**不需要重装 hooks，也不要动 settings.json**。你要做的只是：跑一个自己的 agent + 注册进广播列表。

```bash
# 1. clone 一份（或 fork）
git clone https://github.com/yanzengyun/claude_code_pet.git
cd claude_code_pet

# 2. 改 agent/config.json 两个字段：
#    "port": 477XX                                ← 挑个没人用的端口（47600 已被占用）
#    "slugIncludes": ["-home-q-vibe-projects-<你的目录名>"]   ← 只收自己项目的会话
vim agent/config.json

# 3. 启动自己的 agent（pid/日志按端口隔离，不会和别人打架）
bash agent/start.sh
curl http://127.0.0.1:477XX/status

# 4. 注册进 hook 广播列表（一行搞定，立即生效，所有 hook 事件会同时发给你）
echo "http://127.0.0.1:477XX" >> ~/.cc-pet/agents.list
```

然后 Mac 侧照第二、三节做，把端口换成你自己的（隧道：`ssh -N -L 477XX:127.0.0.1:477XX 你@主机`）。

原理与边界：

- hook 脚本（`hooks/cc-pet-notify.sh`）把每个事件**广播**给 `~/.cc-pet/agents.list` 里的所有 agent
  （后台 + 1 秒超时，谁挂了都不影响别人、更不阻塞 Claude Code）。
- 每个 agent 用自己的 `slugIncludes` 过滤，**只收自己项目的事件**，互相看不到对方会话。
- 想换形象：参考 `pet/renderer/skins.js`（字符画→像素，画左半边自动镜像）+ `skin-squirtle.css`
  （状态→帧的映射），加一套新皮肤大约就是一张字符画 + 一个 CSS 文件的事。

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
- 桌宠突然 `offline`：先在 vibe 上 `curl http://127.0.0.1:47600/health`——
  - 不通 → agent 挂了，`cd agent && bash start.sh` 重启（想一劳永逸挂 cron，见第一节）。
  - 通了但桌宠还灰 → Mac 这头 SSH 隧道断了，重跑方式 A 那条 ssh 命令。
- vibe 上 `status` 里混进别人的会话：检查 `slugIncludes` 是不是你自己的项目前缀
  （共享机上所有人的钩子都会发事件来，agent 已按 `slugIncludes` 过滤，只收你自己项目的）。
- 工具气泡不出现：① 钩子要带 `--with-tools` 装；② 当前会话需是装钩子之后**新开**的；③ Mac 端要 `git pull` 到最新。
- 没有系统通知/提示音：macOS「系统设置 → 通知」允许「Claude Pet / Electron」；完成提示音默认关，在「设置…」里开。

## 设计文档
`docs/specs/2026-06-09-claude-desktop-pet-design.md`

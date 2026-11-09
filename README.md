<div align="center">

# Physics Clawd Pet

Clawd 是只可以拎起来扔的桌宠。轻一点，或许还能站稳。也有可能脸先着地。<br>
Clawd is a desktop pet you can pick up and throw. A gentle toss and it lands on its feet. A hard one and it lands on its face.

[![Release](https://img.shields.io/github/v/release/Ramirez0291/physics-clawd-pet?include_prereleases&label=release)](https://github.com/Ramirez0291/physics-clawd-pet/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%7C%20macOS-0078D6)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文](#中文) · [English](#english)

| | | | |
| :---: | :---: | :---: | :---: |
| <img src="skins/clawd/gif/clawd-jump.gif" alt="Clawd jumps" height="150"> | <img src="skins/clawd-dsh/gif/clawd-dsh-think.gif" alt="Clawd? thinking" height="150"> | <img src="skins/deepseek/gif/deepseek-laptop.gif" alt="DeepSeek-chan typing" height="150"> | <img src="skins/miss-claude/gif/miss-claude-pet.gif" alt="miss.claude being petted" height="150"> |
| [Clawd](skins/clawd/README.md) | [Clawd?](skins/clawd-dsh/README.md) | [DeepSeek 娘 / DeepSeek-chan](skins/deepseek/README.md) | [miss.claude](skins/miss-claude/README.md) |

</div>

## 中文

### 下载

安装包在 [Releases](https://github.com/Ramirez0291/physics-clawd-pet/releases)。

- **Windows 10 / 11** · 运行文件名以 `-setup.exe` 结尾的安装包。桌宠需要 WebView2，Windows 11 自带。
- **macOS** · 打开 `.dmg`，把 Clawd Pet 拖进「应用程序」。应用还没有经过 Apple 公证。如果首次打开时被拦住，去「系统设置 → 隐私与安全性」点「仍要打开」。 [Apple 的操作说明](https://support.apple.com/zh-cn/102445)

Windows 右下角没看见图标，先点时钟旁边的 **^** 看看。还找不到就**右键点桌宠**打开调教面板，里面可以换形象、调大小，也能进小助手。要反馈托盘问题，可以发弹窗截图，或者从资源管理器打开 `%TEMP%\clawd-pet-startup.log`，把相关那几行发过来。

### 怎么玩

平时 Clawd 沿着任务栏走，到了 Mac 上就沿着程序坞那一边走。光标从它面前经过，眼睛也跟着转。在它头上来回晃两下就是摸头。抓住一条腿，它会倒过来晃。松手时鼠标带点速度，就能把它甩出去。撞上墙或天花板，它有时会贴住，再蹬一脚翻下来。

它也会把窗口的标题栏当落脚点。等它站上去，慢慢拖动窗口，它就跟着走。拖快了突然停手，窗口刹住了，它还在飞。miss.claude 和蓝色大肥鱼会坐在标题栏上晃腿，也会探头看看下面，再屈膝跳到旁边的窗口。 [蓝色大肥鱼](skins/blue-whale/README.md)

几块屏幕它都能逛，哪块在全屏打游戏或放视频，它就绕开哪块。点到桌宠外面，点击照样交给原来的窗口。它也能避开你正在打字的输入框。Mac 上要先从菜单栏打开「避开正在输入的文本框…」，再授予辅助功能权限。

右键托盘或菜单栏里的图标，可以**换形象、调大小、把桌宠叫回来**。图里的四位之外，还有戴贝雷帽的蓝色毛球、绿青蛙、黄饭团和粉兔子这四款 [Dots](skins/dots/README.md)。左键打开**调教面板**。

**小助手**也在右键菜单里。待办可以设截止时间，日历可以填 iCal 订阅链接或导入 `.ics`。默认按键鼠活动算，连续用电脑 45 分钟会提醒休息，也可以开整点报时。提醒会从桌宠头顶冒出来，等你点一下。

菜单和小助手跟随系统语言，有中、日、英三种。切到日文，Clawd 会讲诡异的关西腔？调教面板目前是中文。

### AI 联动

去 **小助手 → Agent** 选你用的工具，点「开启联动」。AI 思考时，桌宠头顶冒泡泡。开始干活，它就把电脑掏出来。压缩上下文时它扫地，出错了它会被电击。派出子代理时召唤小伙伴，一轮做完就撒彩纸。各个动作可以单独关掉。

想在桌宠头顶点**允许**或**拒绝**，就勾选气泡审批。它会尽量跑到发出请求的窗口旁边。

| 工具 | 开启时会改哪里 | 有什么要留意 |
| --- | --- | --- |
| **Claude Code** | 在 `~/.claude/settings.json` 里加 hooks | 先在终端答了，气泡就会收起来。 |
| **Codex** | 在 `$CODEX_HOME/hooks.json` 里加 hooks，默认是 `~/.codex/hooks.json` | 回 Codex 输入 `/hooks`，信任桌宠的 hooks。 |
| **DeepSeek Harness** | 默认把插件放进 `~/.dsh/clawd-pet/`，并在 `~/.dsh/cordis.patch.yml` 里加一段配置 | 配置会自动加载。桌宠气泡和 DSH 面板，哪边先答就按哪边。 |
| **Antigravity**（App、IDE、`agy`） | 在 `~/.gemini/config/hooks.json` 里加一组 hooks，旁边会多一个启动脚本 | 开启后新建对话。勾选气泡审批后，每条 shell 命令都会等气泡。 |

联动默认关闭。第一次改已有配置时，桌宠会留一份 `*.clawd-backup`。关闭联动或在 Windows 卸载时，只清理桌宠加进去的条目。四种联动可以同时开，AI 工具得在桌宠所在的系统里运行，能连上本机的回环地址。云端会话、远程主机和 WSL 默认连不上。

### 调教面板

左键点图标，重力、弹性和走路速度都能边调边看。想反复看同一次落地，就点「重放上次投掷」，再用慢动作或单步看它是哪一帧碰到地的。「动作菜单」里也可以直接叫它做动作。其余参数按**物理 / 行为 / 外观**分组，搜索框会一起查。

点**保存**会写入 `tuning.json`。Windows 的目录是 `%APPDATA%\com.physicsclawdpet.desktop\`，macOS 的目录是 `~/Library/Application Support/com.physicsclawdpet.desktop/`。

### 从源码构建

用 Node.js 24 和 Rust，跟 CI 一样。Windows 还要装 Visual Studio C++ 生成工具和 WebView2，macOS 需要 Xcode 命令行工具。

```bash
npm ci
npm run tauri dev
npm run tauri build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

安装包在 `src-tauri/target/release/bundle/`。只想在浏览器里试物理，运行 `npm run dev` 后打开 `http://localhost:1420`，按 **D** 打开调教面板。`/preview.html` 可以并排看几款 Dots 的放大图和桌面大小。

### 自制皮肤

在源码的 `skins/` 下建一个目录，放进 `skin.json`。下次运行开发版或重新打包，形象菜单里就会出现它。最简单的做法是照着 Clawd 画几个色块，标好身体、眼睛和四肢，走路和翻滚交给引擎。想画细一点，可以像 DeepSeek 娘那样用分层像素图，也可以像 miss.claude 那样用透明 PNG 裁片和动作图集。 [Clawd 配置](skins/clawd/skin.json) · [DeepSeek 像素图脚本](scripts/skins/deepseek.mjs) · [miss.claude 的做法](skins/miss-claude/README.md) · [皮肤字段](src/skin/types.ts)

### 许可

引擎代码采用 MIT 许可。内置形象是同人作品，形象权利归各自的权利人。 [MIT 许可](LICENSE)

---

## English

### Download

Installers are on [Releases](https://github.com/Ramirez0291/physics-clawd-pet/releases).

- **Windows 10 / 11** · Run the installer whose filename ends in `-setup.exe`. Clawd needs WebView2, which comes with Windows 11.
- **macOS** · Open the `.dmg` and drag Clawd Pet into Applications. The app is distributed without Apple notarization. If macOS blocks the first launch, go to System Settings → Privacy & Security and choose **Open Anyway**. [Apple’s instructions](https://support.apple.com/en-us/102445)

On Windows, check the **^** beside the clock if you can’t find the tray icon. If it’s missing there too, **right-click the pet** to open the tuning panel. You can switch characters, change size and open Assistant from there. To report a tray problem, share a screenshot of the error dialog or open `%TEMP%\clawd-pet-startup.log` in File Explorer and share the matching lines.

### Playing with Clawd

Clawd walks along the taskbar or the edge of the Dock on a Mac. Its eyes follow your cursor. Wiggle the cursor over its head to pet it, or pick it up by a leg and let it dangle. Keep the mouse moving as you let go to throw it. A hard hit against the wall or ceiling can leave it clinging there until it kicks off again.

Window title bars double as ledges. Wait until Clawd lands on one and move the window gently. It comes along for the ride. Stop too suddenly and the window stops before Clawd does. Switch to miss.claude to see her sit on the title bar, peek over the edge or crouch before jumping to the next window.

The pet crosses between monitors and stays off any screen running a full-screen app. Clicks outside the pet go through to the window underneath. It can also move away from the text box you’re typing in. On Mac, enable that from the menu bar and grant Accessibility permission.

Right-click the tray or menu bar icon to **switch characters, change size or bring the pet back**. There are four furry [Dots](skins/dots/README.md) alongside the characters pictured above. Left-click the icon for the **Tuning panel**.

Open **Assistant** from the same menu for to-dos with due dates, iCal subscriptions or local `.ics` files, hourly chimes and break reminders. By default, the break timer counts 45 minutes of keyboard and mouse use. Reminders wait in a bubble above the pet until you respond.

Menus and Assistant follow your system language in Chinese, Japanese or English. Clawd speaks Kansai dialect in Japanese. The tuning panel is currently in Chinese.

### AI integration

In **Assistant → Agent**, choose your AI tool and click **Turn on**. An ellipsis appears while the agent thinks. The pet pulls out a laptop when the agent works, sweeps when it compacts context and gets zapped on errors. A mini pet drops in for each subagent, and there’s confetti when the turn ends. You can switch off individual reactions.

Enable bubble approval to **allow** or **deny** requests from the pet. It will try to get near the window that asked.

| Tool | What the link installs | What to do next |
| --- | --- | --- |
| **Claude Code** | Hooks in `~/.claude/settings.json` | Answering in the terminal dismisses the pet’s bubble. |
| **Codex** | Hooks in `$CODEX_HOME/hooks.json`, defaulting to `~/.codex/hooks.json` | Run `/hooks` in Codex and trust the pet’s hooks. |
| **DeepSeek Harness** | A plugin in `~/.dsh/clawd-pet/` and a block in `~/.dsh/cordis.patch.yml` by default | DSH loads the changes live. The first answer from the pet or DSH wins. |
| **Antigravity** (app, IDE, `agy`) | Hooks in `~/.gemini/config/hooks.json` and a launcher beside it | Start a new conversation. With bubble approval enabled, every shell command waits for the bubble. |

All four links start off and can run together. The first edit to an existing settings file leaves a `*.clawd-backup`. Turning a link off or uninstalling on Windows removes the pet’s entries. The bridge listens on localhost, so the tools need to run in the same system as the pet. Cloud sessions, remote hosts and WSL cannot reach it by default.

### Tuning panel

Left-click the icon to change gravity, bounce and walking speed while the pet is moving. Replay the last throw, then slow it down or step through it to see where the pet hit the floor. Other settings live under **Physics / Behavior / Appearance**, and search looks through all three. Use **Action menu** to try specific moves.

**Save** writes `tuning.json` under `%APPDATA%\com.physicsclawdpet.desktop\` on Windows or `~/Library/Application Support/com.physicsclawdpet.desktop/` on macOS.

### Build from source

Use Node.js 24 and Rust, as in CI. Windows also needs Visual Studio C++ Build Tools and WebView2. On macOS, install the Xcode Command Line Tools.

```bash
npm ci
npm run tauri dev
npm run tauri build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Installers go to `src-tauri/target/release/bundle/`. To try the physics in a browser, run `npm run dev`, open `http://localhost:1420` and press **D** for the tuning panel. `/preview.html` shows the Dots at large and desktop sizes.

<details>
<summary>Project layout</summary>

```text
src/engine/    Physics, state machine, animation and expressions
src/render/    Pixel, sprite and fur renderers
src/overlay/   Input, AI reactions and bubbles
src/assistant/ To-dos, calendar, scheduler and Assistant window
src/debug/     Tuning panel
src/platform/  Tauri and browser implementations
src/skin/      Skin format and loader
skins/         Built-in characters and artwork
scripts/       Skin generators
src-tauri/     Native windows, tray, desktop tracking and AI bridge
tests/         Frontend tests
```

</details>

### Make a skin

Add a `skin.json` in a new directory under `skins/` in the source tree. It shows up in the Character menu the next time you run the development build or rebuild the app. Clawd is a good starting point. The engine can animate a character made of a few colored rectangles once it knows which parts are the body, eyes, arms and legs. For more detail, use layered pixel art like DeepSeek-chan or PNG parts and motion atlases like miss.claude. [Clawd’s skin](skins/clawd/skin.json) · [DeepSeek-chan’s generator](scripts/skins/deepseek.mjs) · [miss.claude’s notes](skins/miss-claude/README.md) · [Skin fields](src/skin/types.ts)

### License

The engine code uses the MIT License. The included characters are fan art, and the rights to those characters belong to their respective owners. [MIT License](LICENSE)

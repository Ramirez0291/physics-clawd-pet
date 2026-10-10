<div align="center">

# Physics Clawd Pet

**A desktop pet with exaggerated cartoon physics.**<br>
**一只物理效果夸张到离谱的桌宠。**

Grab it, fling it across your screen, and watch it tumble, superhero-land, or stick to the wall like Spider-Man.<br>
把它拎起来甩出去：翻滚落地、超级英雄式砸地，或者像蜘蛛侠一样贴在屏幕边上。

[![Release](https://img.shields.io/github/v/release/Ramirez0291/physics-clawd-pet?include_prereleases&label=release)](https://github.com/Ramirez0291/physics-clawd-pet/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](#english) · [中文](#中文)

<!-- TODO:  [demo](docs/demo.gif) -->

</div>

---

## English

### Features

**Throw it around**

- **Pick it up and fling it.** It swings like a pendulum while you hold it. Grab it by a leg and it hangs upside down. Shake it too hard and it gets dizzy.
- **Landings depend on how hard it hits:** a soft landing, a bounce, a roll, a superhero landing, or a faceplant.
- **Sticks to walls and the ceiling** when it hits them fast enough, then crawls along the edge or backflips off.
- **Satisfying impacts:** hit-stop, squash and stretch, motion trails, dust clouds and impact lines.
- **Crisp pixel art at any angle.** It is rotated on a low-res grid and scaled up with nearest-neighbor, so the pixels stay sharp mid-spin.

**It lives on your desktop**

- **Stands on your windows.** It lands on window title bars, hops onto nearby windows, and jumps off the edge.
- **Rides along when you move a window.** Drag the window gently and it rides along. Stop suddenly and inertia flings it off. Yank the window away and it falls.
- **Falls when its window closes,** gets minimized, or is covered by another window.
- **Has a life of its own.** It walks along the taskbar, climbs walls, hangs from the ceiling, and follows your cursor with its eyes. Sometimes it plays on a laptop, trades stocks or eats coins.
- **Pet it** by moving your cursor back and forth over its head.
- **Stays out of your way.** It walks away from the text box you're typing in, and hides while a full-screen app (game, video, slides) is running.
- **Never steals focus or clicks.** Only the pet itself is clickable. Everything else clicks straight through to the windows below.

### Download

Grab the installer from [**Releases**](https://github.com/Ramirez0291/physics-clawd-pet/releases).


Requires Windows 10 or 11 with WebView2 (already included in Windows 11).

### How to use

| Action | How |
| --- | --- |
| Throw | Drag Clawd and let go while moving the mouse |
| Pet | Wiggle the cursor back and forth over its head |
| Change size | Tray icon → right-click → **Size** |
| Lost it? | Tray icon → right-click → **Bring Clawd back** |
| Hide / show | Tray icon → right-click → **Hide Clawd** |
| Tuning panel | Left-click the tray icon |

The tray menu follows your Windows display language: Chinese on a Chinese system, English everywhere else. The tuning panel itself is in Chinese for now.

### Tuning panel

Everything about how Clawd feels is adjustable live: gravity, bounciness, landing thresholds, walking speed, size and 60+ other parameters. The panel also has slow motion, pause and single-step, repeatable test throws, and a "replay last throw" button.

Click **Save** to keep your settings. They're stored in `%APPDATA%\com.physicsclawdpet.desktop\tuning.json` and loaded on every launch.

### Build from source

Requirements: Node.js 20+, Rust (MSVC toolchain), Visual Studio C++ Build Tools and WebView2.

```bash
npm install
npm run tauri dev     # run with the tuning panel open
npm run tauri build   # build the installer → src-tauri/target/release/bundle/nsis/
```

Just want to play with the physics? You can skip Rust and preview it in the browser:

```bash
npm run dev           # then open http://localhost:1420 and press D for the tuning panel
npm test              # engine unit tests
```

<details>
<summary>Project layout</summary>

```
src/
  engine/     Physics, state machine and procedural animation. Pure logic, unit-tested.
  render/     Pixel-art rasterizer and effects
  overlay/    Main loop, mouse input, link to the tuning panel
  debug/      Tuning panel
  platform/   Tauri and browser implementations
  skin/       Skin format and loader
skins/clawd/  The Clawd skin
src-tauri/    Rust: transparent overlay window, tray, desktop window tracking (Win32)
tests/        Engine tests
```

</details>

### Custom skins

A skin is a single JSON file: a grid size, a color palette and a list of rectangles. Each rectangle gets one of four roles: `body`, `eye`, `arm` or `leg`. All movement is generated from these roles, so **a new character needs no animation frames at all.** See [`skins/clawd/skin.json`](skins/clawd/skin.json) for an example.

### License

The engine code is released under the [MIT License](LICENSE).

Clawd is the mascot of Anthropic's Claude Code. This skin is **fan art**, not affiliated with or endorsed by Anthropic. The character is **not** covered by the MIT license. See [`skins/clawd/README.md`](skins/clawd/README.md).

---

## 中文

### 能做什么

**甩着玩**

- **拎起来甩出去：** 拎着的时候会像钟摆一样晃，抓腿会倒挂，甩太猛会晕。
- **落地看冲击力：** 普通落地、弹跳、翻滚、超级英雄落地，或者脸着地。
- **贴墙：** 高速撞到屏幕边或天花板会贴住，然后沿着边爬，或者蹬墙后空翻跳下来。
- **打击感拉满：** 顿帧、果冻形变、速度拉伸、残影、烟尘和冲击线。
- **怎么转都是整齐的像素：** 先在低分辨率网格里旋转，再最近邻放大，翻滚时像素块也不会糊。

**住在你的桌面上**

- **站在窗口上：** 会落在窗口顶上，自己跳上附近的窗口，走到边缘再跳下去。
- **跟着窗口走：** 平稳拖动它脚下的窗口会带着它走，急停会把它甩飞，猛地一拽会把窗口从它脚下"抽走"。
- **窗口没了会掉下去：** 脚下的窗口被关掉、最小化或者被挡住时，它会掉下去。
- **自己会玩：** 在任务栏上走来走去、爬墙、倒挂天花板，眼睛跟着鼠标转；有时还会玩电脑、炒股、吃TOKEN。
- **可以摸摸它：** 在它头上来回晃鼠标。
- **不碍事：** 你在哪个输入框打字，它就从那里让开；全屏玩游戏、看视频、放幻灯片时自动隐藏。
- **不抢焦点、不挡点击：** 只有宠物本身能点到，其他地方的点击都会穿透到下面的窗口。

### 下载

到 [**Releases**](https://github.com/Ramirez0291/physics-clawd-pet/releases) 下载安装包。


系统要求：Windows 10 / 11，需要 WebView2（Windows 11 自带）。

### 怎么玩

| 操作 | 方法 |
| --- | --- |
| 甩 | 按住 Clawd 拖动，边移动鼠标边松手 |
| 摸摸 | 在它头上来回晃鼠标 |
| 调大小 | 托盘图标右键 → **大小** |
| 找不到它了 | 托盘图标右键 → **把 Clawd 叫回来** |
| 隐藏 / 显示 | 托盘图标右键 → **隐藏 Clawd** |
| 调教面板 | 左键点托盘图标 |

托盘菜单跟随 Windows 显示语言：中文系统显示中文，其他语言显示英文。

### 调教面板

Clawd 的手感全都可以实时调：重力、弹性、落地分级的阈值、走路速度、大小等 60 多个参数。面板里还有慢动作、暂停和单步、可重复的测试投掷，以及"重放上次投掷"。

点 **保存** 就会记住你的设置。设置存在 `%APPDATA%\com.physicsclawdpet.desktop\tuning.json`，每次启动自动加载。

### 从源码构建

需要：Node.js 20+、Rust（MSVC 工具链）、Visual Studio C++ 生成工具、WebView2。

```bash
npm install
npm run tauri dev     # 开发模式，会同时打开调教面板
npm run tauri build   # 打包安装程序 → src-tauri/target/release/bundle/nsis/
```

只想玩物理、不想装 Rust 的话，可以直接在浏览器里预览：

```bash
npm run dev           # 打开 http://localhost:1420，按 D 打开调教面板
npm test              # 引擎单元测试
```

目录结构见上面英文部分的 *Project layout*。

### 自制皮肤

皮肤就是一个 JSON 文件：网格大小、调色板，加上一组矩形部件。每个部件标一个角色：`body`（身体）、`eye`（眼睛）、`arm`（手臂）或 `leg`（腿）。所有动作都按角色程序化生成，所以**做一个新角色不用画任何动画帧**。可以参考 [`skins/clawd/skin.json`](skins/clawd/skin.json)。

### 许可

引擎代码以 [MIT 许可](LICENSE) 开源。

Clawd 是 Anthropic 旗下 Claude Code 的吉祥物。这个皮肤是**同人作品**，与 Anthropic 无关，也不代表官方。Clawd 形象**不在** MIT 许可范围内，详见 [`skins/clawd/README.md`](skins/clawd/README.md)。

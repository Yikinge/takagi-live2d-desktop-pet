# 高木同学 Live2D 桌宠

一个使用 Tauri 2、Vue 3、PixiJS 与 Live2D Cubism 制作的非官方同人桌宠，
支持 macOS 与 Windows。角色会眨眼、看向指针，并根据全局键盘和鼠标操作驱动
两只手与桌面设备。

![待机预览](docs/screenshots/idle.png)

## 实际效果

下面的图片均来自当前 macOS 成品实际运行画面；窗口背景本身透明。

| Q 键 | W 键 | T 键 |
| --- | --- | --- |
| ![Q 键交互](docs/screenshots/key-q.png) | ![W 键交互](docs/screenshots/key-w.png) | ![T 键交互](docs/screenshots/key-t.png) |

设置窗口：

![设置窗口](docs/screenshots/settings.png)

Windows 与 macOS 共用同一套 Vue、Live2D 模型、叠加图和动画逻辑，因此桌宠
外观与键位动作一致；Windows 安装包仍需要在真实 Windows 环境中完成最终运行
验收，不能只凭 macOS 交叉编译结果判断。

## 功能

- 透明、置顶、默认鼠标穿透的桌宠窗口，不会挡住桌面点击。
- 设置只从 macOS 菜单栏或 Windows 系统托盘图标打开。
- 眼珠跟随屏幕内指针；指针离开屏幕后保留最后视线位置。
- 键盘手待机时只显示小手套，按键时切换为肩膀到手套的完整手臂。
- 键盘手肩膀固定，整条手臂围绕真实肩点轻微旋转、伸缩到对应实体键位。
- 鼠标侧袖子、手臂、手套与实体鼠标作为同一个整体移动。
- 左上角气泡短暂显示物理按键标签，不显示“按下”、输入内容或按键历史。
- 自动眨眼、Live2D 表情、动作和头发物理效果。
- 可调角色缩放、互动灵敏度、始终置顶、气泡、开机启动和全局互动开关。

## 下载

正式发布后请在仓库的 **Releases** 页面选择对应系统：

- macOS Apple Silicon：`高木同学桌宠_0.1.0_macos-arm64.zip`
- Windows 10/11 x64：名称以 `_x64-setup.exe` 结尾的 NSIS 安装程序

当前 macOS ZIP 的 SHA-256：

```text
e4e7bc0ba2082689f19b59f27a0df55cf1fa2ef47013d328adeec456f168e60f
```

当前 Windows 安装程序 `高木同学桌宠_0.1.0_x64-setup.exe` 的 SHA-256：

```text
3d8ae601535f728297786e2a9c32086ac0bf89dcf65560e4e1509aa953c29068
```

Windows 安装包同时附带 UTF-8 编码的 `SHA256SUMS-windows.txt`。

## macOS 安装与使用

1. 解压 ZIP，将 `高木同学桌宠.app` 移到“应用程序”。
2. 首次启动时右键应用并选择“打开”。当前包使用 ad-hoc 签名，未经过
   Apple Developer ID 公证，因此 macOS 可能显示安全提示。
3. 在“系统设置 → 隐私与安全性”中允许应用使用“辅助功能”和“输入监控”。
4. 完全退出应用并重新启动。桌宠启动后默认鼠标穿透。
5. 从菜单栏的桌宠图标打开设置、暂停互动、切换鼠标穿透、显示/隐藏或退出。
6. 如果暂时找不到桌宠，按 `Command + Shift + T` 可恢复显示或切换鼠标穿透。

## Windows 安装与使用

1. 下载并运行名称以 `_x64-setup.exe` 结尾的安装程序。
2. 当前安装程序尚未购买 Windows 代码签名证书；SmartScreen 如显示提醒，请先
   核对来源与 `SHA256SUMS-windows.txt`，确认后再选择继续运行。
3. 桌宠启动后默认鼠标穿透，从 Windows 系统托盘的桌宠图标打开设置或退出。
4. 按 `Ctrl + Shift + T` 可恢复显示或切换鼠标穿透。
5. Windows 不需要 macOS 的“辅助功能/输入监控”授权；若安全软件阻止全局输入
   监听，请只对白名单中的本项目正式安装包放行。

## 设置说明

- **捉弄气泡**：控制连续输入时是否出现原创台词。
- **桌宠鼠标穿透**：允许鼠标直接点击桌宠后面的窗口与桌面。
- **始终置顶**：让桌宠保持在其他普通窗口上方。
- **暂停全局互动**：停止转发键盘和鼠标动作，并清空瞬时按键状态。
- **随系统启动**：登录系统后自动启动，默认关闭。
- **角色缩放**：调整角色与桌面的整体显示大小。
- **互动灵敏度**：调整动作对键盘、鼠标输入的响应幅度。
- **测试 W 按键提示**：不读取真实按键，仅预览左上角按键气泡。

应用会记住桌宠位置。因为主窗口默认穿透，常规设置入口只放在菜单栏或系统托盘，
不会在桌宠画面上放置容易误触的设置按钮。

## 本地开发与验证

共同要求：

- Node.js 20+
- Rust stable
- 对应平台的 Tauri 2 构建环境

安装依赖并验证 Vue 构建与 Rust 测试：

```bash
npm ci
npm run verify
```

仅运行浏览器预览：

```bash
npm run dev
```

macOS 构建：

```bash
npm run desktop:build
```

Windows x64 NSIS 构建（请在 Windows 环境运行）：

```powershell
npm run desktop:build:windows
```

仓库内的 `.github/workflows/build-windows.yml` 可在 GitHub Actions 中手动触发。
它只上传私有工作流附件，不会自动发布 Release，也不会自动公开仓库。

## t004 美术资源

当前版本只保留最终 t004 状态源文件：

- `art/source/takagi-idle-state-seethrough-t004.psd`
- `art/source/takagi-keyboard-active-state-seethrough-t004.psd`
- `art/source/takagi-front-hair-source-t004.png`

重新生成 t004 运行时叠加图：

```bash
python3 -m venv .venv-art
.venv-art/bin/pip install -r art/tools/requirements.txt
.venv-art/bin/python art/tools/build_t004_from_state_psds.py
```

运行时叠加图位于 `public/models/takagi/overlays/`；脚本会把审计中间结果写入
已忽略的 `art/processed/`。

## 项目文件架构

```text
Takagi/
├── .github/workflows/       Windows x64 的私有手动构建流程
├── src/                     Vue 界面与运行时动画
│   ├── App.vue              透明桌宠主窗口与图层组合
│   ├── SettingsWindow.vue   独立设置窗口
│   ├── components/          设置面板与预览组件
│   └── composables/         Live2D、键鼠映射、状态与 Tauri 桥接
├── src-tauri/               Tauri 2 桌面外壳
│   ├── src/input.rs         真实键位坐标、输入事件与测试
│   ├── src/lib.rs           托盘、窗口、全局监听与快捷键
│   ├── src/permissions.rs   macOS 权限与其他平台兼容分支
│   ├── vendor/rdev/         锁定的全局输入监听依赖
│   ├── icons/               macOS/Windows 应用图标
│   └── tauri.conf.json      窗口、透明度与打包配置
├── public/
│   ├── live2d/              Cubism Core 与许可说明
│   ├── models/takagi/       Live2D 模型、动作、表情和 t004 叠加图
│   └── assets/              桌面基础合成图
├── art/
│   ├── source/              最终 PSD 与前发源图
│   ├── specs/               参数映射及 schema
│   └── tools/               确定性 PSD 导出脚本
├── docs/screenshots/        README 使用的实际运行截图
├── scripts/                 macOS 稳定性监测脚本
├── package.json             前端、验证与打包命令
├── package-lock.json        锁定 Node.js 依赖版本
└── README.md                使用、构建、结构与许可说明
```

### 哪些文件可以删除

| 路径 | 是否影响程序 | 建议 |
| --- | --- | --- |
| `node_modules/` | 删除后不能立刻构建 | 可删；运行 `npm ci` 可重建 |
| `dist/` | 不影响源码 | 可删；运行 `npm run build` 可重建 |
| `src-tauri/target/` | 会删除本地 `.app` 和编译缓存 | 上传安装包后可删；重新构建耗时较长 |
| `.venv-art/` | 只影响 PSD 导出脚本 | 可删；按美术资源章节重建 |
| `art/processed/` | 只含审计与中间输出 | 可删；运行美术脚本可重建 |
| `release/` | 会删除本地安装包副本 | Release 上传并核验后可删 |
| `legacy-local/` | 不影响最终项目或构建 | 约 1 GB，确认不再回滚后可永久删除 |
| `art/source/`、`art/tools/` | 不影响现有运行图和应用构建 | 不再修改美术时可移出公开仓库，建议私下备份 |
| `docs/screenshots/` | 不影响应用 | 删除后 README 没有效果图，不建议公开仓库删除 |
| `src-tauri/icons/android/`、`ios/` | 不影响 macOS/Windows 桌面构建 | 确定不做移动端时可删 |
| `.git/` | 会失去版本历史与 GitHub 同步能力 | 不要删除 |

`src/`、`src-tauri/src/`、`src-tauri/vendor/rdev/`、`public/`、桌面图标、
`Cargo.toml`、`Cargo.lock`、`tauri.conf.json`、`package.json` 和
`package-lock.json` 是 macOS/Windows 正常构建所需文件，不应删除。

## 隐私

全局输入监听仅在本机 Tauri 进程中运行，不联网传输输入。后端只向界面发送：

- 短暂的物理按键标签、匿名键位坐标、按压状态与输入节奏；
- 鼠标按钮、滚轮方向和用于动画的量化指针方向。

应用不保存输入文本、按键历史、密码、剪贴板、前台应用、窗口标题或鼠标绝对
坐标。`localStorage` 只保存桌宠缩放、灵敏度和功能开关。

## 版权与第三方许可

这是非官方同人项目，与《擅长捉弄的高木同学》的原作者、出版社、动画制作方及
Live2D Inc. 均无隶属或背书关系。角色形象及相关权利归各自权利人所有，请仅在
法律和权利人允许的范围内进行个人、非商业使用。

Live2D Cubism Core、模型格式及相关组件受 Live2D 官方许可条款约束，详情见
`public/live2d/README.md`。仓库中的角色美术、PSD、模型与 Live2D 组件不因源码
公开而自动获得可再授权、售卖或商业分发许可。

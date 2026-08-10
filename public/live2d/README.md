# Live2D Cubism Core

`easy-live2d` 不包含 Live2D Cubism Core。本项目在用户接受两份 Live2D 官方
协议，并于 2026-08-01 再次明确授权后，从 Live2D 官方 Web Core `06` 固定
地址取得：

```text
https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js
```

安装位置：

```text
public/live2d/live2dcubismcore.js
```

文件保持官方原样，SHA-256：

```text
8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47
```

该文件运行时报告的 Core 版本为 `6.0.1`。模型本身由 Cubism Editor 5.3.03
导出为 MOC3 格式版本 6；这两个版本号含义不同。

Core 不在 Live2D 的公开 GitHub 仓库中；使用和分发时必须遵守官方许可：

https://docs.live2d.com/cubism-sdk-manual/cubism-sdk-for-web/

应用只在本地模型契约检查通过后加载它；没有 Core 或模型时显示 t002 定稿图预览。

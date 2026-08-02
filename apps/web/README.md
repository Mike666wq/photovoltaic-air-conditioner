# M1 原理图页面 — React + Vite 工程

## 启动方式

```bash
cd apps/web
pnpm install
pnpm dev
# 浏览器访问 http://localhost:5173
```

## 工程结构

```
apps/web/
├── package.json              # 依赖 + 脚本
├── vite.config.ts            # Vite 配置（publicDir 指向 base-elements/）
├── tsconfig.json             # TypeScript 配置
├── index.html                # HTML 入口
└── src/
    ├── main.tsx              # React 入口
    ├── App.tsx               # 根组件（整体布局）
    ├── styles.css            # 全局样式
    ├── components/
    │   ├── TopBar.tsx        # 顶部状态栏
    │   ├── CircuitCanvas.tsx # 主画布（1400×900 SVG）
    │   ├── ControlPanel.tsx  # 右侧控制面板
    │   ├── LogPanel.tsx      # 底部日志
    │   └── Tooltip.tsx       # 部件 Tooltip
    ├── data/
    │   ├── components.ts     # 14 部件坐标 + 元数据
    │   ├── cables.ts         # 7 条线缆路径
    │   └── presets.ts        # 9 个预设场景
    ├── store/
    │   └── simulation.ts     # Zustand 状态管理
    ├── injector/
    │   └── injector.ts       # SVG 注入器（fetch + DOMParser）
    └── hooks/
        └── useParticleAnimation.ts  # Canvas 粒子 RAF 循环
```

## 实现的功能

| 功能 | 状态 |
|------|------|
| 14 部件按坐标定位 | ✅ |
| 7 条线缆骨架路径 | ✅ |
| Canvas 粒子动画（10 粒子/线） | ✅ |
| 12 个手动控制滑块 | ✅ |
| 9 个预设场景 | ✅ |
| 随机扰动 / 重置 | ✅ |
| Tooltip 200ms 显示 | ✅ |
| 实时时钟 | ✅ |

## SVG 资源引用

Vite 配置 `publicDir: '../../base-elements'` 让 `/base-elements/pv-array.svg` 可直接通过 fetch 访问。

**重要**：`base-elements/demo.html` 和所有 SVG 保持原样，本工程**不修改**这些文件。

## 下一步可优化

- [ ] Canvas 粒子分三类（电力/制冷剂/水）独立绘制
- [ ] 部件点击交互（attachClick）
- [ ] 太阳自主移动（JS RAF 替代 CSS keyframe）
- [ ] 模式切换 cool/heat/off 响应
- [ ] 历史曲线（ECharts，M3 阶段）
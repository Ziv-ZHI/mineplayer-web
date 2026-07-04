# 知非的音乐厅

3D 沉浸式网页音乐播放器，灵感来源于 [MinePlayer](https://github.com/QingJ01/MinePlayer)。

## 功能

- 本地音频文件播放（支持拖拽 / 选择）
- **情绪色彩系统** — 实时分析音乐频谱质心，粒子颜色跟随音乐风格动态变换：
  - 低频厚重（电子/摇滚）→ 暖色（红橙）
  - 中频柔和（人声/民谣）→ 自然色（青绿）
  - 高频明亮（古典/轻音乐）→ 冷色（蓝紫）
  - 节拍跳动 → 饱和度闪烁脉冲
- 3D 场景（Three.js）：拖拽旋转、滚轮缩放、触摸支持
- 每首歌 = 3D 空间中的独立粒子球，点击切歌
- 当前播放球体居中脉动，64 段频谱环围绕
- 800 个背景粒子云，颜色随情绪整体流转
- 播放控制：上一首 / 下一首 / 播放模式（循环 / 随机 / 单曲）
- 深色 / 浅色主题切换

## 技术栈

- Three.js（WebGL 3D 渲染 + 自定义着色器）
- Web Audio API（FFT 频谱分析 + 情绪检测）
- HSV 色彩空间实时转换（GLSL 着色器内）
- 纯原生 JS，无框架依赖

## 本地运行

```bash
# 任意静态服务器即可
npx serve .
# 或
python -m http.server 3000
```

## 在线访问

https://ziv-zhi.github.io/mineplayer-web/

## 致谢

- 原项目：[QingJ01/MinePlayer](https://github.com/QingJ01/MinePlayer)

## License

GPL-3.0

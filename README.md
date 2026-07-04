# MinePlayer Web

网页版音乐播放器，还原 [MinePlayer](https://github.com/QingJ01/MinePlayer) 的核心体验。

## 功能

- 本地音频文件播放（支持拖拽 / 选择）
- FFT 频谱分析 + 实时粒子可视化
- 播放控制：上一首 / 下一首 / 播放模式（循环 / 随机 / 单曲）
- 进度条、音量调节
- 深色 / 浅色主题切换
- 播放列表管理

## 技术栈

- HTML5 Audio API
- Web Audio API（FFT 频谱分析）
- Canvas 2D（粒子渲染）
- 纯原生 JS，无依赖

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
- 粒子视觉风格参考：[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)

## License

GPL-3.0

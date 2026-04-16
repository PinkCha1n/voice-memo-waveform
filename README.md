# 录音播放波形组件

这是一个可在手机浏览器直接运行的录音波形组件。它接收本地录音文件，解析真实音频音量数据，并在播放时让波形从右向左运动；暂停后会停在当前帧。

## 特性

- 支持本地录音文件添加
- 播放时根据真实音量数据驱动波形运动
- 暂停时波形冻结在当前时间点
- 条高限制在 12px 到 58px
- 条间距固定 6px
- 支持多次添加文件，后续录音会顺序追加
- 纯原生 Web Component，无需 React、Flutter、React Native 或 Vue

## 文件

- [src/voice-memo-waveform.js](src/voice-memo-waveform.js)
- [index.html](index.html)
- [docs/prompt-log.md](docs/prompt-log.md)

## 运行方式

直接打开 [index.html](index.html) 即可预览。如果浏览器对 `file://` 打开本地文件有限制，也可以放到任意静态服务器中访问。

## 组件用法

```html
<voice-memo-waveform
  min-height="12"
  max-height="58"
  gap="6"
  bar-width="4"
  sample-interval="72"
  history-ms="5600"
  color="#ff6a5f"
></voice-memo-waveform>
```

```js
const wave = document.querySelector('voice-memo-waveform');
await wave.loadAudioFile(file);
await wave.appendAudioFile(nextFile);
await wave.play();
wave.pause();
wave.clear();
```

## 工作方式

1. 选择录音文件。
2. 组件用 Web Audio API 解码音频。
3. 按固定时间窗计算 RMS 和峰值，生成波形数据。
4. 点击播放后，波形按时间从右向左滚动。
5. 点击暂停后，波形停止在当前帧。

## 提交材料建议

如果你要录开卷考过程视频，建议按这个顺序展示：

1. 打开 [docs/prompt-log.md](docs/prompt-log.md) 展示提示词记录。
2. 打开 [index.html](index.html) 演示添加录音文件。
3. 点击播放和暂停，展示波形运动与冻结。
4. 打开 [src/voice-memo-waveform.js](src/voice-memo-waveform.js) 说明实现思路。

## 说明

这个版本不绑定某一个移动端框架，而是以原生 Web Component 形式实现，所以只要手机浏览器能打开静态页面，就能运行。

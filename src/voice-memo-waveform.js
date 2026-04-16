(() => {
  const DEFAULTS = {
    color: '#ff6a5f',
    minHeight: 12,
    maxHeight: 58,
    gap: 6,
    barWidth: 4,
    sampleInterval: 72,
    historyMs: 5600,
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function drawRoundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, width, height, safeRadius);
      return;
    }
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + safeRadius, safeRadius);
    ctx.lineTo(x + width, y + height - safeRadius);
    ctx.arcTo(x + width, y + height, x + width - safeRadius, y + height, safeRadius);
    ctx.lineTo(x + safeRadius, y + height);
    ctx.arcTo(x, y + height, x, y + height - safeRadius, safeRadius);
    ctx.lineTo(x, y + safeRadius);
    ctx.arcTo(x, y, x + safeRadius, y, safeRadius);
    ctx.closePath();
  }

  function getAudioContextConstructor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function decodeAudioDataAsync(audioContext, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const copy = arrayBuffer.slice(0);
      const maybePromise = audioContext.decodeAudioData(copy, resolve, reject);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve).catch(reject);
      }
    });
  }

  class VoiceMemoWaveform extends HTMLElement {
    static get observedAttributes() {
      return ['color', 'min-height', 'max-height', 'gap', 'bar-width', 'sample-interval', 'history-ms'];
    }

    constructor() {
      super();
      this._options = { ...DEFAULTS };
      this._tracks = [];
      this._samples = [];
      this._timelineDurationMs = 0;
      this._playbackMs = 0;
      this._playing = false;
      this._mode = 'preview';
      this._loadingToken = 0;
      this._rafId = 0;
      this._resizeObserver = null;
      this._audioContext = null;
      this._playSessionId = 0;
      this._playbackStartContextTime = 0;
      this._audioSources = [];
      this._playbackGain = null;
      this._playbackStopTimer = 0;
      this._boundResize = () => this._measure();
      this._boundVisibility = () => {
        if (!document.hidden) {
          this._render(performance.now());
        }
      };

      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host {
            display: block;
            width: 100%;
            height: 58px;
            overflow: hidden;
            contain: content;
            user-select: none;
            -webkit-user-select: none;
            touch-action: manipulation;
          }
          canvas {
            display: block;
            width: 100%;
            height: 100%;
            pointer-events: none;
          }
        </style>
        <canvas part="canvas" aria-hidden="true"></canvas>
      `;
      this._canvas = shadow.querySelector('canvas');
      this._context = this._canvas.getContext('2d', { alpha: true });
    }

    connectedCallback() {
      if (!this.hasAttribute('role')) {
        this.setAttribute('role', 'img');
      }
      if (!this.hasAttribute('aria-label')) {
        this.setAttribute('aria-label', 'Recorded audio waveform');
      }

      this._readOptions();
      this._measure();

      if ('ResizeObserver' in window) {
        if (this._resizeObserver) {
          this._resizeObserver.disconnect();
        }
        this._resizeObserver = new ResizeObserver(() => this._measure());
        this._resizeObserver.observe(this);
      }

      window.addEventListener('resize', this._boundResize);
      document.addEventListener('visibilitychange', this._boundVisibility);
    }

    disconnectedCallback() {
      window.removeEventListener('resize', this._boundResize);
      document.removeEventListener('visibilitychange', this._boundVisibility);

      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }

      this._stopAnimation();
      this._stopPlaybackSilently();
      this._revokeTracks();
    }

    attributeChangedCallback() {
      if (!this.isConnected) return;
      this._readOptions();
      this._measure();
    }

    get state() {
      return {
        playing: this._playing,
        mode: this._mode,
        canPlay: this._tracks.length > 0,
        trackCount: this._tracks.length,
        durationMs: this._timelineDurationMs,
        currentTimeMs: this._getPlaybackMs(),
        activeTrackIndex: this._findTrackIndex(this._getPlaybackMs()),
        currentTrackName: this._currentTrackName(),
      };
    }

    async loadAudioFile(fileOrFiles) {
      return this._loadAudioFiles(fileOrFiles, false);
    }

    async appendAudioFile(fileOrFiles) {
      return this._loadAudioFiles(fileOrFiles, true);
    }

    async play() {
      if (!this._tracks.length) {
        return false;
      }

      if (this._playing) {
        return true;
      }

      if (this._playbackMs >= this._timelineDurationMs) {
        this._playbackMs = 0;
      }

      this._mode = 'playback';
      const playbackMs = clamp(this._playbackMs, 0, this._timelineDurationMs);
      await this._startPlaybackSession(playbackMs);
      this._playing = true;

      this._startAnimation();
      this._emitState();
      return true;
    }

    pause() {
      if (!this._playing) {
        return false;
      }

      this._playbackMs = this._getPlaybackMs();
      this._playing = false;
      this._stopPlaybackSources();
      this._stopAnimation();
      this._emitState();
      return true;
    }

    async togglePlayback() {
      return this._playing ? this.pause() : this.play();
    }

    clear() {
      this._loadingToken += 1;
      this._stopPlaybackSilently();
      this._revokeTracks();
      this._tracks = [];
      this._samples = [];
      this._timelineDurationMs = 0;
      this._playbackMs = 0;
      this._mode = 'preview';
      this._render(performance.now());
      this._emitState();
    }

    _animate = () => {
      if (!this.isConnected) {
        this._rafId = 0;
        return;
      }

      this._render(performance.now());

      if (this._playing) {
        this._rafId = requestAnimationFrame(this._animate);
      } else {
        this._rafId = 0;
      }
    };

    _startAnimation() {
      if (!this._rafId) {
        this._rafId = requestAnimationFrame(this._animate);
      }
    }

    _stopAnimation() {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      }
    }

    _emitState() {
      this.dispatchEvent(new CustomEvent('statechange', {
        detail: this.state,
        bubbles: true,
        composed: true,
      }));
    }

    _readOptions() {
      const styles = getComputedStyle(this);
      const cssColor = styles.getPropertyValue('--voice-waveform-color').trim();

      this._options.color = this.getAttribute('color') || cssColor || DEFAULTS.color;
      this._options.minHeight = clamp(this._readNumber('min-height', DEFAULTS.minHeight), 12, 58);
      this._options.maxHeight = clamp(this._readNumber('max-height', DEFAULTS.maxHeight), this._options.minHeight, 58);
      this._options.gap = Math.max(0, this._readNumber('gap', DEFAULTS.gap));
      this._options.barWidth = Math.max(2, this._readNumber('bar-width', DEFAULTS.barWidth));
      this._options.sampleInterval = Math.max(16, this._readNumber('sample-interval', DEFAULTS.sampleInterval));
      this._options.historyMs = Math.max(
        this._options.sampleInterval * 4,
        this._readNumber('history-ms', DEFAULTS.historyMs)
      );
    }

    _readNumber(attributeName, fallback) {
      const raw = this.getAttribute(attributeName);
      if (raw == null || raw === '') return fallback;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    _measure() {
      const rect = this.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const sizeChanged = width !== this._canvas.width || height !== this._canvas.height;

      if (sizeChanged) {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        this._canvas.width = Math.max(1, Math.round(width * ratio));
        this._canvas.height = Math.max(1, Math.round(height * ratio));
        this._canvas.style.width = `${width}px`;
        this._canvas.style.height = `${height}px`;
        this._context.setTransform(ratio, 0, 0, ratio, 0, 0);
      }

      this._render(performance.now());
    }

    _normalizeLevel(level) {
      const numeric = Number(level);
      if (!Number.isFinite(numeric)) return 0;
      if (numeric < 0) {
        return clamp(1 + numeric / 60, 0, 1);
      }
      if (numeric <= 1) {
        return clamp(numeric, 0, 1);
      }
      if (numeric <= 100) {
        return clamp(numeric / 100, 0, 1);
      }
      if (numeric <= 255) {
        return clamp(numeric / 255, 0, 1);
      }
      return clamp(numeric / 100, 0, 1);
    }

    _extractLevels(audioBuffer, intervalMs) {
      const frameCount = Math.max(1, Math.ceil((audioBuffer.duration * 1000) / intervalMs));
      const samplesPerFrame = Math.max(1, Math.round((audioBuffer.sampleRate * intervalMs) / 1000));
      const channels = [];

      for (let index = 0; index < audioBuffer.numberOfChannels; index += 1) {
        channels.push(audioBuffer.getChannelData(index));
      }

      const levels = new Array(frameCount);
      let frameStart = 0;
      let previous = 0;

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const frameEnd = Math.min(audioBuffer.length, frameStart + samplesPerFrame);
        let sumSquares = 0;
        let peak = 0;
        let count = 0;

        for (let sampleIndex = frameStart; sampleIndex < frameEnd; sampleIndex += 1) {
          let mixed = 0;
          for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
            mixed += channels[channelIndex][sampleIndex];
          }
          mixed /= channels.length || 1;

          const absValue = Math.abs(mixed);
          if (absValue > peak) {
            peak = absValue;
          }

          sumSquares += mixed * mixed;
          count += 1;
        }

        const rms = count ? Math.sqrt(sumSquares / count) : 0;
        const boosted = clamp(Math.max(rms * 4.2, peak * 1.35), 0, 1);
        const shaped = Math.pow(boosted, 0.82);
        const smoothing = shaped > previous ? 0.7 : 0.34;
        const value = clamp(previous + (shaped - previous) * smoothing, 0, 1);

        levels[frameIndex] = value;
        previous = value;
        frameStart += samplesPerFrame;
      }

      return levels;
    }

    async _loadAudioFiles(fileOrFiles, append) {
      const files = Array.isArray(fileOrFiles) ? fileOrFiles.filter(Boolean) : [fileOrFiles].filter(Boolean);
      if (!files.length) {
        return null;
      }

      const loadToken = ++this._loadingToken;
      if (!append) {
        this._stopPlaybackSilently();
        this._revokeTracks();
        this._tracks = [];
        this._samples = [];
        this._timelineDurationMs = 0;
        this._playbackMs = 0;
        this._mode = 'preview';
      }

      const results = [];
      for (const file of files) {
        if (loadToken !== this._loadingToken) {
          return null;
        }

        const track = await this._createTrack(file);
        if (loadToken !== this._loadingToken) {
          return null;
        }

        this._appendTrack(track);
        results.push({
          file: track.file,
          durationMs: track.durationMs,
          trackCount: this._tracks.length,
          sampleInterval: this._options.sampleInterval,
        });
      }

      this._mode = this._playing ? 'playback' : 'preview';
      this._render(performance.now());
      this._emitState();
      return results.length === 1 ? results[0] : results;
    }

    async _createTrack(file) {
      const audioBuffer = await this._decodeAudioFile(file);
      const durationMs = Math.max(1, Math.round(audioBuffer.duration * 1000));
      const levels = this._extractLevels(audioBuffer, this._options.sampleInterval);
      return {
        file,
        durationMs,
        levels,
        audioBuffer,
        startMs: 0,
        endMs: durationMs,
        url: URL.createObjectURL(file),
      };
    }

    async _decodeAudioFile(file) {
      const audioContext = await this._getAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      return decodeAudioDataAsync(audioContext, arrayBuffer);
    }

    async _getAudioContext() {
      if (this._audioContext) {
        return this._audioContext;
      }

      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        throw new Error('当前浏览器不支持 Web Audio API');
      }

      this._audioContext = new AudioContextConstructor();
      if (this._audioContext.state === 'suspended') {
        try {
          await this._audioContext.resume();
        } catch (error) {
          // Some browsers require a direct user gesture before resume succeeds.
        }
      }

      return this._audioContext;
    }

    _appendTrack(track) {
      track.startMs = this._timelineDurationMs;
      track.endMs = track.startMs + track.durationMs;
      this._tracks.push(track);

      let sampleTime = track.startMs;
      for (const level of track.levels) {
        this._samples.push({ value: level, time: sampleTime });
        sampleTime += this._options.sampleInterval;
      }

      this._timelineDurationMs = track.endMs;
    }

    _revokeTracks() {
      for (const track of this._tracks) {
        URL.revokeObjectURL(track.url);
      }
    }

    _stopPlaybackSilently() {
      this._playing = false;
      this._stopPlaybackSources();
      this._stopAnimation();
    }

    _stopPlaybackSources() {
      if (this._playbackStopTimer) {
        clearTimeout(this._playbackStopTimer);
        this._playbackStopTimer = 0;
      }

      this._playSessionId += 1;
      for (const source of this._audioSources) {
        try {
          source.onended = null;
          source.stop();
        } catch (error) {
          // Ignore already stopped nodes.
        }
      }
      this._audioSources = [];

      if (this._playbackGain) {
        try {
          this._playbackGain.disconnect();
        } catch (error) {
          // Ignore disconnect failures on torn-down contexts.
        }
        this._playbackGain = null;
      }
    }

    _currentTrackName() {
      const playbackMs = this._getPlaybackMs();
      const trackIndex = this._findTrackIndex(playbackMs);
      return this._tracks[trackIndex]?.file?.name || '';
    }

    _getPlaybackMs() {
      if (this._playing && this._audioContext) {
        const elapsedMs = (this._audioContext.currentTime - this._playbackStartContextTime) * 1000;
        return clamp(elapsedMs, 0, this._timelineDurationMs);
      }
      return clamp(this._playbackMs, 0, this._timelineDurationMs);
    }

    _findTrackIndex(timeMs) {
      if (!this._tracks.length) {
        return -1;
      }

      let low = 0;
      let high = this._tracks.length - 1;
      let result = 0;

      while (low <= high) {
        const mid = (low + high) >> 1;
        const track = this._tracks[mid];
        if (track.startMs <= timeMs) {
          result = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      return result;
    }

    _findSampleIndex(timeMs) {
      let low = 0;
      let high = this._samples.length - 1;
      let result = this._samples.length;

      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this._samples[mid].time >= timeMs) {
          result = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }

      return result;
    }

    async _startPlaybackSession(playbackMs) {
      const audioContext = await this._getAudioContext();
      this._stopPlaybackSources();

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const sessionId = ++this._playSessionId;
      const gain = audioContext.createGain();
      gain.gain.value = 1;
      gain.connect(audioContext.destination);
      this._playbackGain = gain;
      this._audioSources = [];
      this._playbackStartContextTime = audioContext.currentTime - playbackMs / 1000;

      let startIndex = this._findTrackIndex(playbackMs);
      const boundaryTrack = this._tracks[startIndex];
      if (
        boundaryTrack &&
        startIndex < this._tracks.length - 1 &&
        playbackMs >= boundaryTrack.endMs - 1
      ) {
        startIndex += 1;
      }

      let lastEndedMs = playbackMs;

      for (let index = startIndex; index < this._tracks.length; index += 1) {
        const track = this._tracks[index];
        const trackOffsetMs = Math.max(0, playbackMs - track.startMs);
        const whenMs = Math.max(0, track.startMs - playbackMs);
        const source = audioContext.createBufferSource();
        source.buffer = track.audioBuffer;
        source.connect(gain);
        source.onended = () => {
          if (this._playSessionId !== sessionId) {
            return;
          }

          if (index === this._tracks.length - 1) {
            this._playing = false;
            this._playbackMs = this._timelineDurationMs;
            this._stopPlaybackSources();
            this._stopAnimation();
            this._emitState();
          }
        };
        source.start(audioContext.currentTime + whenMs / 1000, trackOffsetMs / 1000);
        this._audioSources.push(source);
        lastEndedMs = track.endMs;
      }

      this._schedulePlaybackStop(lastEndedMs, sessionId);
    }

    _schedulePlaybackStop(lastEndedMs, sessionId) {
      if (this._playbackStopTimer) {
        clearTimeout(this._playbackStopTimer);
      }

      const remainingMs = Math.max(0, lastEndedMs - this._playbackMs);
      this._playbackStopTimer = window.setTimeout(() => {
        if (this._playSessionId !== sessionId) {
          return;
        }
        if (this._playing) {
          this._playing = false;
          this._playbackMs = this._timelineDurationMs;
          this._stopPlaybackSources();
          this._stopAnimation();
          this._emitState();
        }
      }, remainingMs + 40);
    }

    _render(now) {
      if (!this._context) return;

      const width = this._canvas.width / Math.max(window.devicePixelRatio || 1, 1);
      const height = this._canvas.height / Math.max(window.devicePixelRatio || 1, 1);
      if (!width || !height) return;

      const ctx = this._context;
      const step = this._options.barWidth + this._options.gap;
      const minHeight = clamp(this._options.minHeight, 12, 58);
      const maxHeight = clamp(this._options.maxHeight, minHeight, 58);
      const centerY = height / 2;
      const rightPadding = this._options.gap;

      ctx.clearRect(0, 0, width, height);

      if (!this._samples.length) {
        return;
      }

      ctx.fillStyle = this._options.color;

      if (this._playing || this._mode === 'playback') {
        const playbackMs = clamp(this._getPlaybackMs(), 0, this._timelineDurationMs);
        this._playbackMs = playbackMs;

        const visibleWindowMs = Math.max(
          this._options.historyMs,
          Math.max(this._options.sampleInterval * 12, Math.round((width / Math.max(step, 1)) * this._options.sampleInterval))
        );
        const windowStartMs = Math.max(0, playbackMs - visibleWindowMs);
        const startIndex = this._findSampleIndex(windowStartMs);

        for (let index = startIndex; index < this._samples.length; index += 1) {
          const sample = this._samples[index];
          if (sample.time > playbackMs) {
            break;
          }

          const ageMs = playbackMs - sample.time;
          const x = width - rightPadding - step - (ageMs / this._options.sampleInterval) * step;
          if (x < -step || x > width + step) {
            continue;
          }

          const eased = Math.pow(sample.value, 0.86);
          const barHeight = minHeight + (maxHeight - minHeight) * eased;
          const y = centerY - barHeight / 2;
          drawRoundedRect(ctx, x, y, this._options.barWidth, barHeight, this._options.barWidth / 2);
          ctx.fill();
        }
        return;
      }

      const bucketCount = Math.max(1, Math.floor((width - rightPadding * 2) / step));
      const bucketValues = new Array(bucketCount).fill(0);
      const timelineDuration = Math.max(this._timelineDurationMs, this._options.sampleInterval);

      for (const sample of this._samples) {
        const bucketIndex = clamp(Math.floor((sample.time / timelineDuration) * bucketCount), 0, bucketCount - 1);
        if (sample.value > bucketValues[bucketIndex]) {
          bucketValues[bucketIndex] = sample.value;
        }
      }

      for (let index = 0; index < bucketCount; index += 1) {
        const value = bucketValues[index];
        const eased = Math.pow(value, 0.86);
        const barHeight = minHeight + (maxHeight - minHeight) * eased;
        const y = centerY - barHeight / 2;
        const x = rightPadding + index * step;
        drawRoundedRect(ctx, x, y, this._options.barWidth, barHeight, this._options.barWidth / 2);
        ctx.fill();
      }
    }
  }

  if (!customElements.get('voice-memo-waveform')) {
    customElements.define('voice-memo-waveform', VoiceMemoWaveform);
  }

  window.VoiceMemoWaveform = VoiceMemoWaveform;
})();

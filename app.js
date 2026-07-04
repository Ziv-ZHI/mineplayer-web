// ============ 状态 ============
const state = {
  audioCtx: null,
  analyser: null,
  source: null,
  audio: new Audio(),
  playlist: [],       // 每首歌 { name, url, hue, x, y, vx, vy, radius, pulsePhase }
  currentIndex: -1,
  isPlaying: false,
  mode: 'loop',
  volume: 0.8,
  dataArray: null,
  bgParticles: [],    // 背景装饰粒子
  time: 0,
};

// ============ DOM ============
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const audio = state.audio;

// ============ 工具 ============
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ============ 初始化 ============
function init() {
  resize();
  window.addEventListener('resize', resize);
  audio.volume = state.volume;

  initBgParticles();
  bindEvents();
  loop();
}

function initBgParticles() {
  state.bgParticles = [];
  for (let i = 0; i < 120; i++) {
    state.bgParticles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.3,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      alpha: Math.random() * 0.3 + 0.1,
    });
  }
}

// ============ 事件 ============
function bindEvents() {
  // 画布点击 — 检测是否点中某个粒子球
  canvas.addEventListener('click', onCanvasClick);

  // 控制按钮
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-prev').addEventListener('click', playPrev);
  $('btn-next').addEventListener('click', playNext);
  $('btn-mode').addEventListener('click', toggleMode);

  // 进度条
  $('progress-track').addEventListener('click', e => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  // 音量
  $('volume-bar').addEventListener('input', () => {
    state.volume = $('volume-bar').value / 100;
    audio.volume = state.volume;
  });

  // 主题
  $('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('light');
    $('btn-theme').textContent = document.body.classList.contains('light') ? '\u{1F319}' : '\u2600';
  });

  // 文件选择
  $('file-input').addEventListener('change', e => addFiles([...e.target.files]));

  // 全局拖拽
  window.addEventListener('dragover', e => {
    e.preventDefault();
    document.body.classList.add('drag-active');
  });
  window.addEventListener('dragleave', e => {
    if (e.clientX === 0 && e.clientY === 0) document.body.classList.remove('drag-active');
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('drag-active');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio/'));
    if (files.length) addFiles(files);
  });

  // 音频事件
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('ended', onEnded);
}

function onCanvasClick(e) {
  const mx = e.clientX, my = e.clientY;
  // 从后往前检测（上层优先）
  for (let i = state.playlist.length - 1; i >= 0; i--) {
    const t = state.playlist[i];
    const dx = mx - t.x, dy = my - t.y;
    const hitR = t.radius + 8;
    if (dx * dx + dy * dy < hitR * hitR) {
      playTrack(i);
      return;
    }
  }
}

// ============ 文件 ============
function addFiles(files) {
  files.forEach(f => {
    const name = f.name.replace(/\.[^.]+$/, '');
    const url = URL.createObjectURL(f);
    const h = hashStr(name);
    state.playlist.push({
      name,
      url,
      hue: h % 360,
      x: Math.random() * (canvas.width - 200) + 100,
      y: Math.random() * (canvas.height - 200) + 100,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      radius: 18,
      pulsePhase: Math.random() * Math.PI * 2,
    });
  });
  $('drop-zone').classList.add('hidden');
  if (state.currentIndex === -1) playTrack(0);
}

// ============ 播放 ============
function playTrack(i) {
  if (i < 0 || i >= state.playlist.length) return;
  state.currentIndex = i;
  const t = state.playlist[i];
  audio.src = t.url;
  audio.load();
  audio.play();
  state.isPlaying = true;
  $('btn-play').textContent = '\u23F8';
  $('mini-controls').classList.remove('hidden');
  $('now-playing').classList.remove('hidden');
  $('np-title').textContent = t.name;
  initAudioAnalyser();
}

function togglePlay() {
  if (state.currentIndex === -1 && state.playlist.length > 0) {
    playTrack(0);
    return;
  }
  if (state.isPlaying) {
    audio.pause();
    $('btn-play').textContent = '\u25B6';
  } else {
    audio.play();
    $('btn-play').textContent = '\u23F8';
  }
  state.isPlaying = !state.isPlaying;
}

function playPrev() {
  if (!state.playlist.length) return;
  let i = state.currentIndex - 1;
  if (i < 0) i = state.playlist.length - 1;
  playTrack(i);
}

function playNext() {
  if (!state.playlist.length) return;
  let i = state.mode === 'random'
    ? Math.floor(Math.random() * state.playlist.length)
    : (state.currentIndex + 1) % state.playlist.length;
  playTrack(i);
}

function toggleMode() {
  const modes = ['loop', 'random', 'single'];
  const icons = { loop: '\u{1F501}', random: '\u{1F500}', single: '\u{1F502}' };
  state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length];
  $('btn-mode').textContent = icons[state.mode];
}

function onEnded() {
  if (state.mode === 'single') {
    audio.currentTime = 0;
    audio.play();
  } else {
    playNext();
  }
}

function updateProgress() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('progress-fill').style.width = pct + '%';
  $('np-time').textContent = fmtTime(audio.currentTime) + ' / ' + fmtTime(audio.duration);
}

// ============ 音频分析 ============
function initAudioAnalyser() {
  if (state.audioCtx) state.audioCtx.close();
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.source = state.audioCtx.createMediaElementSource(audio);
  state.source.connect(state.analyser);
  state.analyser.connect(state.audioCtx.destination);
  state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);
}

function getAudioData() {
  if (!state.analyser || !state.isPlaying) return { bass: 0, mid: 0, treble: 0, freq: [] };
  state.analyser.getByteFrequencyData(state.dataArray);
  const len = state.dataArray.length;
  let bass = 0, mid = 0, treble = 0;
  const bassEnd = Math.floor(len * 0.1);
  const midEnd = Math.floor(len * 0.4);
  for (let i = 0; i < bassEnd; i++) bass += state.dataArray[i];
  for (let i = bassEnd; i < midEnd; i++) mid += state.dataArray[i];
  for (let i = midEnd; i < len; i++) treble += state.dataArray[i];
  bass = bass / bassEnd / 255;
  mid = mid / (midEnd - bassEnd) / 255;
  treble = treble / (len - midEnd) / 255;
  return { bass, mid, treble, freq: state.dataArray };
}

// ============ 主渲染循环 ============
function loop() {
  state.time += 0.016;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 渐变背景
  drawBgGradient();

  const audio = getAudioData();

  // 背景粒子
  drawBgParticles(audio);

  // 歌曲粒子球
  drawSongOrbs(audio);

  requestAnimationFrame(loop);
}

function drawBgGradient() {
  const hueBase = state.currentIndex >= 0 ? state.playlist[state.currentIndex].hue : 210;
  const grad = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, 0,
    canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) / 1.5
  );
  const isLight = document.body.classList.contains('light');
  grad.addColorStop(0, `hsla(${hueBase}, 60%, ${isLight ? 90 : 8}%, 1)`);
  grad.addColorStop(1, `hsla(${hueBase + 40}, 40%, ${isLight ? 80 : 4}%, 1)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawBgParticles(audio) {
  const isLight = document.body.classList.contains('light');
  state.bgParticles.forEach(p => {
    p.x += p.vx + Math.sin(state.time + p.r) * 0.1;
    p.y += p.vy;
    if (p.x < 0) p.x = canvas.width;
    if (p.x > canvas.width) p.x = 0;
    if (p.y < 0) p.y = canvas.height;
    if (p.y > canvas.height) p.y = 0;

    const r = p.r * (1 + audio.bass * 1.5);
    const a = p.alpha * (1 + audio.mid * 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isLight
      ? `rgba(100, 120, 140, ${a})`
      : `rgba(180, 200, 255, ${a})`;
    ctx.fill();
  });
}

function drawSongOrbs(audio) {
  state.playlist.forEach((t, i) => {
    const isCurrent = i === state.currentIndex;
    const isPlaying = isCurrent && state.isPlaying;

    // 粒子运动
    t.pulsePhase += 0.03;

    if (isCurrent) {
      // 当前歌曲：被吸引到中心区域，半径随音频脉动
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      t.vx += (cx - t.x) * 0.008;
      t.vy += (cy - t.y) * 0.008;
      t.vx *= 0.92;
      t.vy *= 0.92;
      t.radius = 50 + audio.bass * 80 + Math.sin(t.pulsePhase) * 8;
    } else {
      // 其他歌曲：自由漂浮
      t.radius = 18 + Math.sin(t.pulsePhase) * 3;
      // 轻微排斥（避免重叠）
      for (let j = 0; j < state.playlist.length; j++) {
        if (j === i) continue;
        const o = state.playlist[j];
        const dx = t.x - o.x, dy = t.y - o.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = 80;
        if (d < minD && d > 0) {
          t.vx += (dx / d) * 0.05;
          t.vy += (dy / d) * 0.05;
        }
      }
      t.vx *= 0.98;
      t.vy *= 0.98;
    }

    t.x += t.vx;
    t.y += t.vy;

    // 边界软约束
    const margin = t.radius + 20;
    if (t.x < margin) t.vx += 0.3;
    if (t.x > canvas.width - margin) t.vx -= 0.3;
    if (t.y < margin) t.vy += 0.3;
    if (t.y > canvas.height - margin) t.vy -= 0.3;

    // === 绘制粒子球 ===
    const hue = t.hue;
    const r = t.radius;

    // 外层辉光
    if (isCurrent) {
      const glowR = r * 2.5 + audio.bass * 100;
      const glow = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, glowR);
      glow.addColorStop(0, `hsla(${hue}, 80%, 65%, ${0.4 + audio.bass * 0.3})`);
      glow.addColorStop(0.5, `hsla(${hue}, 70%, 50%, 0.1)`);
      glow.addColorStop(1, `hsla(${hue}, 60%, 40%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(t.x, t.y, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 频谱环（仅当前播放）
    if (isPlaying && audio.freq.length > 0) {
      const bands = 64;
      const ringR = r + 12;
      for (let b = 0; b < bands; b++) {
        const fi = Math.floor((b / bands) * (audio.freq.length * 0.7));
        const v = audio.freq[fi] / 255;
        const barH = v * 40 + 2;
        const angle = (b / bands) * Math.PI * 2 - Math.PI / 2;
        const x1 = t.x + Math.cos(angle) * ringR;
        const y1 = t.y + Math.sin(angle) * ringR;
        const x2 = t.x + Math.cos(angle) * (ringR + barH);
        const y2 = t.y + Math.sin(angle) * (ringR + barH);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `hsla(${hue + b * 2}, 80%, ${60 + v * 30}%, ${0.6 + v * 0.4})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 主体球
    const ballGrad = ctx.createRadialGradient(
      t.x - r * 0.3, t.y - r * 0.3, 0,
      t.x, t.y, r
    );
    const lightness = isCurrent ? 60 : 45;
    ballGrad.addColorStop(0, `hsla(${hue}, 80%, ${lightness + 20}%, 0.95)`);
    ballGrad.addColorStop(0.6, `hsla(${hue}, 70%, ${lightness}%, 0.8)`);
    ballGrad.addColorStop(1, `hsla(${hue}, 60%, ${lightness - 15}%, 0.3)`);
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 高光
    ctx.beginPath();
    ctx.arc(t.x - r * 0.35, t.y - r * 0.35, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${isCurrent ? 0.3 : 0.15})`;
    ctx.fill();

    // 歌曲名
    ctx.fillStyle = `rgba(255,255,255,${isCurrent ? 0.95 : 0.5})`;
    ctx.font = `${isCurrent ? '600 13px' : '400 11px'} -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 截断长名
    let name = t.name;
    const maxW = isCurrent ? 200 : 120;
    if (ctx.measureText(name).width > maxW) {
      while (ctx.measureText(name + '...').width > maxW && name.length > 3) name = name.slice(0, -1);
      name += '...';
    }
    ctx.fillText(name, t.x, t.y + r + (isCurrent ? 24 : 16));

    // 播放指示
    if (isCurrent && state.isPlaying) {
      const dotY = t.y - r - 18;
      const pulse = Math.sin(state.time * 4) * 2;
      ctx.beginPath();
      ctx.arc(t.x, dotY, 3 + pulse, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 80%, 70%, 0.9)`;
      ctx.fill();
    }
  });
}

// ============ 启动 ============
init();

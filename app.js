// ============ 状态 ============
const state = {
  audioCtx: null,
  analyser: null,
  source: null,
  audio: null,
  playlist: [],
  currentIndex: -1,
  isPlaying: false,
  mode: 'loop',       // loop / random / single
  volume: 0.8,
  particles: [],
  animFrame: null,
  dataArray: null,
};

// ============ DOM ============
const $ = id => document.getElementById(id);
const canvas   = $('particle-canvas');
const ctx      = canvas.getContext('2d');
const audio    = new Audio();
const btnPlay  = $('btn-play');
const btnPrev  = $('btn-prev');
const btnNext  = $('btn-next');
const btnMode  = $('btn-mode');
const btnVol   = $('btn-vol');
const btnTheme = $('btn-theme');
const progBar  = $('progress-bar');
const volBar   = $('volume-bar');
const fileInput = $('file-input');
const fileArea  = $('file-area');
const trackTitle = $('track-title');
const trackArtist= $('track-artist');
const timeCurr  = $('time-current');
const timeDur   = $('time-duration');
const playlistEl= $('playlist');

// ============ 初始化 ============
function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  audio.volume = state.volume;
  volBar.value = state.volume * 100;

  bindEvents();
  initParticles();
  drawParticles(); // 空闲动画
}

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ============ 事件绑定 ============
function bindEvents() {
  // 播放/暂停
  btnPlay.addEventListener('click', togglePlay);

  // 上一首/下一首
  btnPrev.addEventListener('click', playPrev);
  btnNext.addEventListener('click', playNext);

  // 播放模式
  btnMode.addEventListener('click', toggleMode);

  // 音量
  btnVol.addEventListener('click', toggleMute);
  volBar.addEventListener('input', () => {
    state.volume = volBar.value / 100;
    audio.volume = state.volume;
    updateVolIcon();
  });

  // 进度条
  progBar.addEventListener('input', () => {
    if (audio.duration) {
      audio.currentTime = (progBar.value / 100) * audio.duration;
    }
  });

  // 音频时间更新
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', onMetaLoaded);
  audio.addEventListener('ended', onTrackEnded);

  // 文件选择
  fileInput.addEventListener('change', onFilesSelected);

  // 拖拽
  fileArea.addEventListener('dragover', e => {
    e.preventDefault();
    fileArea.classList.add('drag-over');
  });
  fileArea.addEventListener('dragleave', () => fileArea.classList.remove('drag-over'));
  fileArea.addEventListener('drop', e => {
    e.preventDefault();
    fileArea.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio/'));
    if (files.length) addFiles(files);
  });

  // 主题
  btnTheme.addEventListener('click', () => {
    document.body.classList.toggle('light');
    btnTheme.textContent = document.body.classList.contains('light') ? '🌙' : '☀';
  });
}

// ============ 文件处理 ============
function onFilesSelected(e) {
  addFiles([...e.target.files]);
}

function addFiles(files) {
  files.forEach(f => {
    const url = URL.createObjectURL(f);
    state.playlist.push({ name: f.name.replace(/\.[^.]+$/, ''), file: f, url });
  });
  renderPlaylist();
  if (state.currentIndex === -1) playTrack(0);
}

function renderPlaylist() {
  playlistEl.innerHTML = '';
  state.playlist.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = i === state.currentIndex ? 'active' : '';
    li.innerHTML = `<span>${t.name}</span><span class="duration" id="dur-${i}">--:--</span>`;
    li.addEventListener('click', () => playTrack(i));
    playlistEl.appendChild(li);
  });
}

// ============ 播放控制 ============
function playTrack(index) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentIndex = index;
  const track = state.playlist[index];

  audio.src = track.url;
  audio.load();

  trackTitle.textContent = track.name;
  trackArtist.textContent = '本地文件';

  renderPlaylist();
  if (state.isPlaying) audio.play();
  initAudioAnalyser();
}

function togglePlay() {
  if (state.currentIndex === -1 && state.playlist.length > 0) {
    playTrack(0);
  }
  if (state.isPlaying) {
    audio.pause();
  } else {
    audio.play();
  }
  state.isPlaying = !state.isPlaying;
  btnPlay.textContent = state.isPlaying ? '⏸' : '▶';
}

function playPrev() {
  if (state.playlist.length === 0) return;
  let idx = state.currentIndex - 1;
  if (idx < 0) idx = state.playlist.length - 1;
  playTrack(idx);
  if (state.isPlaying) audio.play();
}

function playNext() {
  if (state.playlist.length === 0) return;
  let idx;
  if (state.mode === 'random') {
    idx = Math.floor(Math.random() * state.playlist.length);
  } else {
    idx = (state.currentIndex + 1) % state.playlist.length;
  }
  playTrack(idx);
  if (state.isPlaying) audio.play();
}

function toggleMode() {
  const modes = ['loop', 'random', 'single'];
  const labels = { loop: '🔁', random: '🔀', single: '🔂' };
  const curr = modes.indexOf(state.mode);
  state.mode = modes[(curr + 1) % modes.length];
  btnMode.textContent = labels[state.mode];
}

function toggleMute() {
  audio.muted = !audio.muted;
  updateVolIcon();
}

function updateVolIcon() {
  btnVol.textContent = audio.muted ? '🔇' : (state.volume === 0 ? '🔇' : (state.volume < 0.5 ? '🔉' : '🔊'));
}

function onMetaLoaded() {
  timeDur.textContent = fmtTime(audio.duration);
  // 更新播放列表中的时长
  const durEl = document.getElementById(`dur-${state.currentIndex}`);
  if (durEl) durEl.textContent = fmtTime(audio.duration);
}

function onTrackEnded() {
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
  progBar.value = pct;
  timeCurr.textContent = fmtTime(audio.currentTime);
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ============ Web Audio + 分析 ============
function initAudioAnalyser() {
  if (state.audioCtx) {
    state.audioCtx.close();
  }
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 256;
  state.source = state.audioCtx.createMediaElementSource(audio);
  state.source.connect(state.analyser);
  state.analyser.connect(state.audioCtx.destination);
  state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);
}

// ============ 粒子系统 ============
function initParticles() {
  const count = 200;
  state.particles = [];
  for (let i = 0; i < count; i++) {
    state.particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.random() * 2.5 + 0.5,
      speedX: (Math.random() - 0.5) * 0.5,
      speedY: (Math.random() - 0.5) * 0.5,
      hue: Math.random() * 60 + 180, // 蓝绿色系
    });
  }
}

function drawParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let bass = 0;
  if (state.analyser && state.isPlaying) {
    state.analyser.getByteFrequencyData(state.dataArray);
    // 计算低音能量
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += state.dataArray[i];
    bass = sum / 10 / 255;
  }

  state.particles.forEach(p => {
    // 音频驱动：低音越强，粒子越大/越亮
    const boost = 1 + bass * 3;
    const alpha = 0.3 + bass * 0.7;

    p.x += p.speedX + (Math.random() - 0.5) * bass * 2;
    p.y += p.speedY + (Math.random() - 0.5) * bass * 2;

    // 边界回绕
    if (p.x < 0) p.x = canvas.width;
    if (p.x > canvas.width) p.x = 0;
    if (p.y < 0) p.y = canvas.height;
    if (p.y > canvas.height) p.y = 0;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * boost, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${alpha})`;
    ctx.fill();
  });

  // 连线（距离近的粒子之间）
  drawLines(bass);

  state.animFrame = requestAnimationFrame(drawParticles);
}

function drawLines(bass) {
  const maxDist = 100 + bass * 80;
  const pts = state.particles;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        const alpha = (1 - dist / maxDist) * (0.3 + bass * 0.5);
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.strokeStyle = `hsla(200, 80%, 70%, ${alpha})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }
}

// ============ 启动 ============
init();

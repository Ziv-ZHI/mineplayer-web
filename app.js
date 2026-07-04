// ============ 状态 ============
const state = {
  playlist: [],
  currentIndex: -1,
  isPlaying: false,
  mode: 'loop',
  volume: 0.8,
  audioCtx: null,
  analyser: null,
  source: null,
  dataArray: null,
  audio: new Audio(),
  time: 0,
};

// ============ 情绪检测系统 ============
// 通过分析音频频谱特征，实时计算音乐"情绪色"
// 频谱质心 → 色相（低频暖、中频自然、高频冷）
// 整体能量 → 饱和度 + 亮度
// 节拍突变 → 闪烁脉冲
const mood = {
  bassAvg: 0, midAvg: 0, trebleAvg: 0,
  energy: 0,
  targetHue: 220, currentHue: 220,
  targetSat: 0.7, currentSat: 0.7,
  targetLight: 0.6, currentLight: 0.6,
  beatPulse: 0,
  lastBass: 0,
};

function lerpHue(a, b, t) {
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return (a + d * t + 360) % 360;
}

function updateMood(audio) {
  // 滚动平均（慢速，约3秒窗口，决定整体氛围）
  mood.bassAvg = mood.bassAvg * 0.97 + audio.bass * 0.03;
  mood.midAvg = mood.midAvg * 0.97 + audio.mid * 0.03;
  mood.trebleAvg = mood.trebleAvg * 0.97 + audio.treble * 0.03;
  mood.energy = mood.energy * 0.97 + ((audio.bass + audio.mid + audio.treble) / 3) * 0.03;

  // 节拍检测（快速跳动）
  const bassDelta = audio.bass - mood.lastBass;
  if (bassDelta > 0.12) mood.beatPulse = Math.min(1, mood.beatPulse + bassDelta * 2.5);
  mood.beatPulse *= 0.90;
  mood.lastBass = audio.bass;

  // 频谱质心 → 色相（有音频时才更新，静默时保持上一次的色相）
  const total = mood.bassAvg + mood.midAvg + mood.trebleAvg;
  if (total > 0.01) {
    const bw = mood.bassAvg / total;
    const mw = mood.midAvg / total;
    const tw = mood.trebleAvg / total;
    // 低频 → 暖色(红橙 25), 中频 → 自然(青绿 155), 高频 → 冷色(蓝紫 255)
    mood.targetHue = bw * 25 + mw * 155 + tw * 255;
  }

  // 能量 → 饱和度/亮度
  mood.targetSat = 0.55 + mood.energy * 0.45;
  mood.targetLight = 0.5 + mood.energy * 0.25;

  // 平滑过渡（约2秒完成色相转换）
  mood.currentHue = lerpHue(mood.currentHue, mood.targetHue, 0.012);
  mood.currentSat += (mood.targetSat - mood.currentSat) * 0.015;
  mood.currentLight += (mood.targetLight - mood.currentLight) * 0.015;
}

// ============ 工具 ============
const $ = id => document.getElementById(id);
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

// ============ NCM 格式解码 ============
// 网易云 .ncm 加密格式：AES-128-ECB + RC4 流加密
// 使用浏览器原生 Web Crypto API，无需外部依赖
function hexToU8(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
// AES-128-ECB 解密 + PKCS7 去填充（使用原生 Web Crypto API）
async function aesECBDecrypt(keyHex, encBytes) {
  const keyBytes = hexToU8(keyHex);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-ECB' }, false, ['decrypt']);
  const decBuf = await crypto.subtle.decrypt({ name: 'AES-ECB' }, key, encBytes);
  const result = new Uint8Array(decBuf);
  const padLen = result[result.length - 1];
  if (padLen > 0 && padLen <= 16) return result.slice(0, result.length - padLen);
  return result;
}

async function decodeNCM(file) {
  if (!crypto.subtle) throw new Error('浏览器不支持 Web Crypto API，请使用 HTTPS 访问');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  // 1. Magic "CTENFDAM"
  if (view.getUint32(0, true) !== 0x4E455443 || view.getUint32(4, true) !== 0x4D414446) {
    throw new Error('非 NCM 格式（文件头不匹配）');
  }
  offset = 8;

  // 2. 解密 RC4 密钥
  const keyLen = view.getUint32(offset, true);
  offset += 4;
  const encKey = bytes.slice(offset, offset + keyLen);
  offset += keyLen;
  for (let i = 0; i < encKey.length; i++) encKey[i] ^= 0x64;

  const keyDecrypted = await aesECBDecrypt('687A52416D736F356B496E6261785700', encKey);
  // 去掉 "neteasecloudmusic" 前缀（17 字节），剩余部分 XOR 0x63 得到 RC4 密钥
  const rc4Key = keyDecrypted.slice(17);
  for (let i = 0; i < rc4Key.length; i++) rc4Key[i] ^= 0x63;
  if (rc4Key.length === 0) throw new Error('RC4 密钥解密失败');

  // 3. 元数据（可选，含歌曲名和格式信息）
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  let songName = file.name.replace(/\.ncm$/i, '');
  let format = 'mp3';
  if (metaLen > 0) {
    const metaEnc = bytes.slice(offset, offset + metaLen);
    offset += metaLen;
    for (let i = 0; i < metaEnc.length; i++) metaEnc[i] ^= 0x63;
    try {
      const metaDecrypted = await aesECBDecrypt('2331346C6A6B5F215C5D2630553C2728', metaEnc);
      let metaStr = new TextDecoder().decode(metaDecrypted);
      if (metaStr.startsWith('music:')) metaStr = metaStr.slice(6);
      const meta = JSON.parse(metaStr);
      if (meta.musicName) songName = meta.musicName;
      if (meta.format) format = meta.format;
    } catch (e) { /* 元数据解析失败就用文件名 */ }
  } else {
    offset += metaLen;
  }

  // 4. 跳过 CRC32
  offset += 4;

  // 5. 跳过专辑封面图
  const imgSize = view.getUint32(offset, true);
  offset += 4;
  offset += imgSize;

  // 6. RC4 解密音频数据
  const audioData = bytes.slice(offset);
  // 构建 RC4 密钥盒（KSA）
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + rc4Key[i % rc4Key.length]) & 0xff;
    const tmp = box[i]; box[i] = box[j]; box[j] = tmp;
  }
  // 生成 256 字节密钥流（NCM 特有的修改版 PRGA）
  const stream = new Uint8Array(256);
  let j2 = 0;
  for (let i = 0; i < 256; i++) {
    j2 = (box[i] + j2) & 0xff;
    const tmp = box[i]; box[i] = box[j2]; box[j2] = tmp;
    stream[i] = box[(box[i] + box[j2]) & 0xff];
  }
  // 逐字节异或解密
  for (let i = 0; i < audioData.length; i++) {
    audioData[i] ^= stream[(i + 1) & 0xff];
  }

  // 验证解密结果
  const isMp3 = (audioData[0] === 0xFF && (audioData[1] === 0xFB || audioData[1] === 0xF3 || audioData[1] === 0xF2));
  const isFlac = (audioData[0] === 0x66 && audioData[1] === 0x4C && audioData[2] === 0x61 && audioData[3] === 0x43);
  if (!isMp3 && !isFlac) {
    // 尝试通过文件头自动检测格式
    if (isFlac) format = 'flac';
    else if (!isMp3) console.warn('NCM 解密后音频头异常，可能解码不完整');
  }

  const mime = format === 'flac' ? 'audio/flac' : 'audio/mpeg';
  const blob = new Blob([audioData], { type: mime });
  console.log('NCM 解码成功:', songName, '格式:', format, '大小:', blob.size);
  return { name: songName, blob, format };
}

// ============ Toast（歌曲名短暂浮现） ============
let toastTimer = null;
function showToast(text, duration = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ============ Three.js 场景 ============
let scene, camera, renderer, raycaster, mouse;
let songOrbs = [];
let bgParticles;
let bgParticleData;
let freqBars;

const camCtrl = {
  azimuth: 0,
  polar: Math.PI / 2.2,
  distance: 350,
  targetAzimuth: 0,
  targetPolar: Math.PI / 2.2,
  targetDist: 350,
  isDragging: false,
  lastX: 0,
  lastY: 0,
  downX: 0,
  downY: 0,
  autoRotate: 0.0012,
  pinchDist: 0,
};

// ============ 初始化 ============
function initThree() {
  const canvas = $('canvas');
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06080c, 0.00025);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 20000);
  updateCamera();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  scene.add(new THREE.AmbientLight(0x404060, 0.4));
  const pl = new THREE.PointLight(0x6080ff, 1.5, 5000);
  pl.position.set(0, 0, 0);
  scene.add(pl);

  createBgParticles();
  createFreqBars();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============ 背景粒子云（银河星空 + 情绪着色器） ============
function createBgParticles() {
  const count = 6000;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const hues = new Float32Array(count);    // 每个粒子的色相偏移
  const sizes = new Float32Array(count);
  const brights = new Float32Array(count);  // 个体亮度因子

  bgParticleData = [];

  for (let i = 0; i < count; i++) {
    // 银河盘状分布：大部分粒子在扁平盘面上，少量在球冠
    let x, y, z, r;
    const discRoll = Math.random();

    if (discRoll < 0.82) {
      // 盘面粒子（银河臂）— 拉大半径形成宽阔环带
      r = 200 + Math.random() * 2300;
      const theta = Math.random() * Math.PI * 2;
      // 螺旋臂偏移
      const armOffset = Math.sin(theta * 2 + r * 0.002) * 60;
      const thickness = (Math.random() - 0.5) * 120 * Math.exp(-r / 1200);
      x = r * Math.cos(theta) + armOffset * Math.cos(theta + 0.5);
      z = r * Math.sin(theta) + armOffset * Math.sin(theta + 0.5);
      y = thickness;
    } else if (discRoll < 0.94) {
      // 球状晕（少量散布在球面）
      r = 400 + Math.random() * 1600;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      x = r * Math.sin(phi) * Math.cos(theta);
      y = r * Math.sin(phi) * Math.sin(theta);
      z = r * Math.cos(phi);
    } else {
      // 近景尘埃（靠近相机的微小粒子）
      r = 50 + Math.random() * 200;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      x = r * Math.sin(phi) * Math.cos(theta);
      y = r * Math.sin(phi) * Math.sin(theta);
      z = r * Math.cos(phi);
    }

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // 色相偏移：盘面粒子偏移大（有星云感），球晕粒子偏移小
    hues[i] = (Math.random() - 0.5) * 0.3;

    // 多元大小：70% 微尘, 20% 星星, 8% 亮星, 2% 巨星
    const sizeRoll = Math.random();
    if (sizeRoll < 0.70) {
      sizes[i] = 1 + Math.random() * 2;      // 微尘 1-3
      brights[i] = 0.3 + Math.random() * 0.3;
    } else if (sizeRoll < 0.90) {
      sizes[i] = 3 + Math.random() * 4;      // 星星 3-7
      brights[i] = 0.5 + Math.random() * 0.3;
    } else if (sizeRoll < 0.98) {
      sizes[i] = 7 + Math.random() * 6;      // 亮星 7-13
      brights[i] = 0.7 + Math.random() * 0.3;
    } else {
      sizes[i] = 13 + Math.random() * 10;    // 巨星 13-23
      brights[i] = 0.9 + Math.random() * 0.1;
    }

    bgParticleData.push({
      x, y, z,
      baseR: Math.sqrt(x*x + y*y + z*z),
      vx: (Math.random() - 0.5) * 0.02,
      vy: (Math.random() - 0.5) * 0.02,
      vz: (Math.random() - 0.5) * 0.02,
      phase: Math.random() * Math.PI * 2,
      size: sizes[i],
    });
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aHue', new THREE.BufferAttribute(hues, 1));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(brights, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uMoodHue: { value: 220 / 360 },
      uMoodSat: { value: 0.7 },
      uMoodLight: { value: 0.5 },
      uBeatPulse: { value: 0 },
    },
    vertexShader: `
      attribute float size;
      attribute float aHue;
      attribute float aBright;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uTime;
      uniform float uBass;
      uniform float uMid;
      uniform float uPixelRatio;
      uniform float uMoodHue;
      uniform float uMoodSat;
      uniform float uMoodLight;
      uniform float uBeatPulse;

      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }

      void main() {
        // 情绪色相 + 粒子偏移
        float hue = mod(uMoodHue + aHue, 1.0);
        // 节拍跳动时饱和度增强
        float sat = uMoodSat * (0.6 + uBeatPulse * 0.5);
        // 低频驱动亮度，个体亮度因子让粒子层次分明
        float light = (uMoodLight * 0.6 + aBright * 0.5) + uBass * 0.15 * aBright + uBeatPulse * 0.1;
        vColor = hsv2rgb(vec3(hue, sat, clamp(light, 0.0, 1.0)));
        // 透明度也跟个体亮度关联
        vAlpha = aBright * (0.6 + uBeatPulse * 0.3);

        vec3 pos = position;
        float wave = sin(uTime * 0.5 + position.x * 0.01) * (3.0 + uMid * 20.0);
        pos += normalize(position + vec3(0.001)) * wave * 0.08;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = max(2.0, size * uPixelRatio * (1.0 + uBass * 2.5 + uBeatPulse * 1.2) * (700.0 / -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        // 中心亮、边缘暗，模拟星光
        float alpha = smoothstep(0.5, 0.0, d);
        alpha = pow(alpha, 1.5);
        gl_FragColor = vec4(vColor, alpha * vAlpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  bgParticles = new THREE.Points(geo, mat);
  scene.add(bgParticles);
}

// ============ 频谱环 ============
function createFreqBars() {
  freqBars = new THREE.Group();
  const bands = 64;
  for (let i = 0; i < bands; i++) {
    const angle = (i / bands) * Math.PI * 2;
    const geo = new THREE.BoxGeometry(1.5, 1, 1.5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x58a6ff,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
    });
    const bar = new THREE.Mesh(geo, mat);
    bar.userData = { angle, index: i, baseH: 1 };
    freqBars.add(bar);
  }
  freqBars.visible = false;
  scene.add(freqBars);
}

// ============ 歌曲球体 ============
function createSongOrb(track, index) {
  const hue = track.hue;
  const color = new THREE.Color().setHSL(hue / 360, 0.75, 0.55);

  const geo = new THREE.IcosahedronGeometry(18, 2);
  const mat = new THREE.MeshPhongMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.4,
    shininess: 80,
    transparent: true,
    opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);

  const r = 120 + Math.random() * 200;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  mesh.position.set(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi)
  );

  const wireGeo = new THREE.IcosahedronGeometry(22, 1);
  const wireMat = new THREE.MeshBasicMaterial({
    color: color,
    wireframe: true,
    transparent: true,
    opacity: 0.2,
  });
  const wire = new THREE.Mesh(wireGeo, wireMat);
  mesh.add(wire);

  const haloTex = createHaloTexture(color);
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(70, 70, 1);
  mesh.add(halo);

  // 隐形 hitbox — 比球体大很多，方便点击
  const hitGeo = new THREE.SphereGeometry(40, 8, 8);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitGeo, hitMat);
  mesh.add(hitbox);

  mesh.userData = {
    track,
    index,
    hue,
    basePos: mesh.position.clone(),
    floatPhase: Math.random() * Math.PI * 2,
    rotSpeed: { x: (Math.random() - 0.5) * 0.01, y: (Math.random() - 0.5) * 0.01 },
    vel: new THREE.Vector3(
      (Math.random() - 0.5) * 0.15,
      (Math.random() - 0.5) * 0.15,
      (Math.random() - 0.5) * 0.15
    ),
    wire,
    halo,
    baseEmissive: 0.4,
    haloTex,
  };

  scene.add(mesh);
  songOrbs.push(mesh);
  return mesh;
}

function createHaloTexture(color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const cx = c.getContext('2d');
  const grad = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const hsl = color.getHSL({});
  const hslStr = `hsla(${Math.round(hsl.h * 360)}, 70%, 60%, `;
  grad.addColorStop(0, hslStr + '0.6)');
  grad.addColorStop(0.4, hslStr + '0.2)');
  grad.addColorStop(1, hslStr + '0)');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ============ 相机控制 ============
function updateCamera() {
  const x = camCtrl.distance * Math.sin(camCtrl.polar) * Math.cos(camCtrl.azimuth);
  const y = camCtrl.distance * Math.cos(camCtrl.polar);
  const z = camCtrl.distance * Math.sin(camCtrl.polar) * Math.sin(camCtrl.azimuth);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
}

function onMouseDown(e) {
  camCtrl.isDragging = true;
  camCtrl.lastX = e.clientX;
  camCtrl.lastY = e.clientY;
  camCtrl.downX = e.clientX;
  camCtrl.downY = e.clientY;
}
function onMouseMove(e) {
  if (!camCtrl.isDragging) return;
  const dx = e.clientX - camCtrl.lastX;
  const dy = e.clientY - camCtrl.lastY;
  camCtrl.targetAzimuth -= dx * 0.005;
  camCtrl.targetPolar -= dy * 0.005;
  camCtrl.targetPolar = Math.max(0.05, Math.min(Math.PI - 0.05, camCtrl.targetPolar));
  camCtrl.lastX = e.clientX;
  camCtrl.lastY = e.clientY;
}
function onMouseUp(e) {
  if (camCtrl.isDragging) {
    // 判断是否为点击（mousedown 到 mouseup 位移很小）
    const dx = Math.abs(e.clientX - camCtrl.downX);
    const dy = Math.abs(e.clientY - camCtrl.downY);
    if (dx < 8 && dy < 8) {
      handleOrbClick(e.clientX, e.clientY);
    }
  }
  camCtrl.isDragging = false;
}

function onTouchStart(e) {
  if (e.touches.length === 1) {
    e.preventDefault();
    camCtrl.isDragging = true;
    camCtrl.lastX = e.touches[0].clientX;
    camCtrl.lastY = e.touches[0].clientY;
    camCtrl.downX = e.touches[0].clientX;
    camCtrl.downY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    e.preventDefault();
    camCtrl.isDragging = false;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    camCtrl.pinchDist = Math.sqrt(dx * dx + dy * dy);
  }
}
function onTouchMove(e) {
  if (e.touches.length === 2) {
    // 双指缩放
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (camCtrl.pinchDist > 0) {
      const delta = camCtrl.pinchDist - dist;
      camCtrl.targetDist += delta * 1.5;
      camCtrl.targetDist = Math.max(30, Math.min(8000, camCtrl.targetDist));
    }
    camCtrl.pinchDist = dist;
  } else if (e.touches.length === 1 && camCtrl.isDragging) {
    e.preventDefault();
    const dx = e.touches[0].clientX - camCtrl.lastX;
    const dy = e.touches[0].clientY - camCtrl.lastY;
    camCtrl.targetAzimuth -= dx * 0.005;
    camCtrl.targetPolar -= dy * 0.005;
    camCtrl.targetPolar = Math.max(0.05, Math.min(Math.PI - 0.05, camCtrl.targetPolar));
    camCtrl.lastX = e.touches[0].clientX;
    camCtrl.lastY = e.touches[0].clientY;
  }
}
function onTouchEnd(e) {
  if (e.touches.length === 0) {
    // 单指点击检测
    if (camCtrl.isDragging) {
      const dx = Math.abs(camCtrl.lastX - camCtrl.downX);
      const dy = Math.abs(camCtrl.lastY - camCtrl.downY);
      if (dx < 10 && dy < 10) {
        handleOrbClick(camCtrl.lastX, camCtrl.lastY);
      }
    }
    camCtrl.isDragging = false;
    camCtrl.pinchDist = 0;
  } else if (e.touches.length === 1) {
    camCtrl.pinchDist = 0;
    camCtrl.isDragging = true;
    camCtrl.lastX = e.touches[0].clientX;
    camCtrl.lastY = e.touches[0].clientY;
    camCtrl.downX = e.touches[0].clientX;
    camCtrl.downY = e.touches[0].clientY;
  }
}

function onWheel(e) {
  e.preventDefault();
  camCtrl.targetDist += e.deltaY * 0.8;
  camCtrl.targetDist = Math.max(30, Math.min(8000, camCtrl.targetDist));
}

function handleOrbClick(clientX, clientY) {
  mouse.x = (clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  // 检测歌曲球体（包括子物体的隐形 hitbox）
  const hits = raycaster.intersectObjects(songOrbs, true);
  if (hits.length > 0) {
    // 找到被点击的根 songOrb
    let target = hits[0].object;
    while (target.parent && !target.userData.track) {
      target = target.parent;
    }
    if (target.userData.track) {
      const idx = target.userData.index;
      if (idx === state.currentIndex) {
        togglePlay();
      } else {
        playTrack(idx);
      }
    }
  }
}

// ============ 音频 ============
function initAudioAnalyser() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.source = state.audioCtx.createMediaElementSource(state.audio);
    state.source.connect(state.analyser);
    state.analyser.connect(state.audioCtx.destination);
    state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
}

function getAudioData() {
  if (!state.analyser || !state.isPlaying) return { bass: 0, mid: 0, treble: 0, freq: new Uint8Array(0) };
  state.analyser.getByteFrequencyData(state.dataArray);
  const len = state.dataArray.length;
  let bass = 0, mid = 0, treble = 0;
  const bEnd = Math.floor(len * 0.1);
  const mEnd = Math.floor(len * 0.4);
  for (let i = 0; i < bEnd; i++) bass += state.dataArray[i];
  for (let i = bEnd; i < mEnd; i++) mid += state.dataArray[i];
  for (let i = mEnd; i < len; i++) treble += state.dataArray[i];
  bass = bass / bEnd / 255;
  mid = mid / (mEnd - bEnd) / 255;
  treble = treble / (len - mEnd) / 255;
  return { bass, mid, treble, freq: state.dataArray };
}

// ============ 文件 ============
async function addFiles(files) {
  const hadSongs = state.playlist.length > 0;
  const ncmFiles = files.filter(f => f.name.toLowerCase().endsWith('.ncm'));
  const normalFiles = files.filter(f => !f.name.toLowerCase().endsWith('.ncm'));

  // 解码 NCM 文件
  let ncmSuccess = 0, ncmFail = 0;
  for (const f of ncmFiles) {
    const baseName = f.name.replace(/\.ncm$/i, '');
    showToast('正在解码 ' + baseName + ' ...', 60000);
    try {
      const decoded = await decodeNCM(f);
      const h = hashStr(decoded.name);
      state.playlist.push({ name: decoded.name, url: URL.createObjectURL(decoded.blob), hue: h % 360 });
      ncmSuccess++;
    } catch (e) {
      ncmFail++;
      console.error('NCM decode error for', f.name, ':', e);
      showToast('解码失败: ' + baseName + '\n' + e.message, 5000);
      await new Promise(r => setTimeout(r, 5200)); // 等用户看到错误
    }
  }
  if (ncmSuccess > 0 && ncmFail === 0) {
    showToast(ncmSuccess > 1 ? `已解码 ${ncmSuccess} 首 NCM` : '解码完成', 1500);
  } else if (ncmSuccess > 0 && ncmFail > 0) {
    showToast(`成功 ${ncmSuccess} 首，失败 ${ncmFail} 首`, 3000);
  }

  // 普通音频文件直接导入
  for (const f of normalFiles) {
    const name = f.name.replace(/\.[^.]+$/, '');
    const url = URL.createObjectURL(f);
    const h = hashStr(name);
    state.playlist.push({ name, url, hue: h % 360 });
  }

  $('drop-zone').classList.add('hidden');

  // 为新加入的歌曲创建粒子球
  state.playlist.forEach((t, i) => {
    if (!songOrbs[i]) createSongOrb(t, i);
  });

  // 显示操作提示
  if (!hadSongs) {
    $('hint').classList.remove('hidden');
    setTimeout(() => $('hint').classList.add('hidden'), 5000);
    playTrack(0);
  } else {
    const added = ncmSuccess + normalFiles.length;
    if (added > 1) showToast(`已添加 ${added} 首音乐`);
  }
}

// ============ 播放控制 ============
function playTrack(i) {
  if (i < 0 || i >= state.playlist.length) return;
  state.currentIndex = i;
  const t = state.playlist[i];
  state.audio.src = t.url;
  state.audio.load();
  state.audio.play();
  state.isPlaying = true;
  $('btn-play').textContent = '\u23F8';
  $('mini-controls').classList.remove('hidden');
  showToast('\u266B  ' + t.name);
  initAudioAnalyser();
}

function togglePlay() {
  if (state.currentIndex === -1 && state.playlist.length > 0) { playTrack(0); return; }
  if (state.isPlaying) {
    state.audio.pause();
    $('btn-play').textContent = '\u25B6';
    showToast('已暂停');
  } else {
    state.audio.play();
    $('btn-play').textContent = '\u23F8';
    showToast('\u266B  ' + state.playlist[state.currentIndex].name);
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
  if (state.mode === 'single') { state.audio.currentTime = 0; state.audio.play(); }
  else playNext();
}

function updateProgress() {
  if (!state.audio.duration) return;
  const pct = (state.audio.currentTime / state.audio.duration) * 100;
  $('progress-fill').style.width = pct + '%';
}

// ============ 主循环 ============
function animate() {
  requestAnimationFrame(animate);
  state.time += 0.016;

  // 相机缓动
  if (!camCtrl.isDragging) {
    camCtrl.targetAzimuth += camCtrl.autoRotate;
  }
  camCtrl.azimuth += (camCtrl.targetAzimuth - camCtrl.azimuth) * 0.08;
  camCtrl.polar += (camCtrl.targetPolar - camCtrl.polar) * 0.08;
  camCtrl.distance += (camCtrl.targetDist - camCtrl.distance) * 0.08;
  updateCamera();

  const audio = getAudioData();

  // 情绪更新
  updateMood(audio);

  // 背景粒子 — 传入情绪 uniforms
  if (bgParticles) {
    const u = bgParticles.material.uniforms;
    u.uTime.value = state.time;
    u.uBass.value = audio.bass;
    u.uMid.value = audio.mid;
    u.uMoodHue.value = mood.currentHue / 360;
    u.uMoodSat.value = mood.currentSat;
    u.uMoodLight.value = mood.currentLight;
    u.uBeatPulse.value = mood.beatPulse;
    bgParticles.rotation.y = state.time * 0.02;
  }

  // 雾色跟随情绪
  const fogColor = new THREE.Color().setHSL(
    mood.currentHue / 360,
    Math.min(0.5, mood.currentSat * 0.6),
    document.body.classList.contains('light') ? 0.75 : 0.04 + mood.currentLight * 0.04
  );
  scene.fog.color.copy(fogColor);

  // 进度条彩色渐变（跟随情绪色相）
  const progFill = $('progress-fill');
  if (progFill) {
    const h = Math.round(mood.currentHue);
    progFill.style.background = `linear-gradient(90deg, hsl(${(h - 40 + 360) % 360}, 75%, 55%), hsl(${h}, 80%, 62%), hsl(${(h + 40) % 360}, 75%, 55%))`;
    progFill.style.boxShadow = `0 0 12px hsla(${h}, 80%, 60%, 0.6)`;
  }

  // 歌曲球体 — 颜色随情绪混合
  songOrbs.forEach((orb, i) => {
    const ud = orb.userData;
    const isCurrent = i === state.currentIndex;
    const isPlaying = isCurrent && state.isPlaying;

    ud.floatPhase += 0.015;

    // 情绪色与歌曲本色混合：当前播放受情绪影响更大
    const moodInfluence = isCurrent ? 0.55 : 0.25;
    const blendedHue = lerpHue(ud.hue, mood.currentHue, moodInfluence);
    const dynSat = mood.currentSat * 0.85 + (isCurrent ? audio.mid * 0.25 : 0);
    const dynLight = mood.currentLight * 0.85 + (isCurrent ? audio.bass * 0.2 : 0) + mood.beatPulse * 0.1;

    orb.material.color.setHSL(blendedHue / 360, Math.min(1, dynSat), Math.min(0.8, dynLight));
    orb.material.emissive.setHSL(blendedHue / 360, Math.min(1, dynSat), Math.min(0.8, dynLight));
    ud.wire.material.color.setHSL(blendedHue / 360, Math.min(1, dynSat), Math.min(0.8, dynLight));

    if (isCurrent) {
      // 当前歌曲：吸引到中心
      ud.vel.x += (0 - orb.position.x) * 0.003;
      ud.vel.y += (0 - orb.position.y) * 0.003;
      ud.vel.z += (0 - orb.position.z) * 0.003;
      ud.vel.multiplyScalar(0.94);

      const scale = 1.5 + audio.bass * 2.0 + mood.beatPulse * 0.5 + Math.sin(ud.floatPhase) * 0.1;
      orb.scale.setScalar(scale);

      orb.material.emissiveIntensity = ud.baseEmissive + audio.mid * 1.5 + mood.beatPulse * 0.8;
      ud.wire.material.opacity = 0.3 + audio.treble * 0.5;
      ud.halo.material.opacity = 0.4 + audio.bass * 0.5;
      ud.halo.scale.setScalar(70 + audio.bass * 100);

      // 频谱环
      freqBars.visible = true;
      const ringR = 32 * scale;
      freqBars.children.forEach((bar, bi) => {
        const fi = Math.floor((bi / freqBars.children.length) * (audio.freq.length * 0.7));
        const v = audio.freq.length > 0 ? audio.freq[fi] / 255 : 0;
        const h = 2 + v * 30;
        bar.scale.y = h;
        const angle = bar.userData.angle + state.time * 0.3;
        bar.position.set(
          orb.position.x + Math.cos(angle) * ringR,
          orb.position.y + Math.sin(angle) * ringR,
          orb.position.z
        );
        bar.lookAt(camera.position);
        // 频谱条颜色也跟随情绪
        const barHue = lerpHue(mood.currentHue, (mood.currentHue + bi * 5) % 360, 0.3);
        bar.material.color.setHSL(barHue / 360, 0.8, 0.5 + v * 0.3);
        bar.material.opacity = 0.4 + v * 0.5;
      });
    } else {
      // 非当前歌曲：自由漂浮 + 互斥
      for (let j = 0; j < songOrbs.length; j++) {
        if (j === i) continue;
        const other = songOrbs[j];
        const dx = orb.position.x - other.position.x;
        const dy = orb.position.y - other.position.y;
        const dz = orb.position.z - other.position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 6400 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = (80 - d) * 0.0006;
          ud.vel.x += (dx / d) * f;
          ud.vel.y += (dy / d) * f;
          ud.vel.z += (dz / d) * f;
        }
      }

      ud.vel.x += (ud.basePos.x - orb.position.x) * 0.0005;
      ud.vel.y += (ud.basePos.y - orb.position.y) * 0.0005;
      ud.vel.z += (ud.basePos.z - orb.position.z) * 0.0005;
      ud.vel.multiplyScalar(0.98);

      const scale = 1 + audio.bass * 0.3 + mood.beatPulse * 0.15;
      orb.scale.setScalar(scale);
      orb.material.emissiveIntensity = ud.baseEmissive + audio.bass * 0.2;
      ud.halo.material.opacity = 0.3 + audio.bass * 0.15;
    }

    orb.position.add(ud.vel);
    orb.rotation.x += ud.rotSpeed.x;
    orb.rotation.y += ud.rotSpeed.y;
    ud.wire.rotation.x -= ud.rotSpeed.x * 0.5;
    ud.wire.rotation.y -= ud.rotSpeed.y * 0.5;
  });

  renderer.render(scene, camera);
}

// ============ 事件绑定 ============
function bindEvents() {
  // 开场页进入
  $('welcome-enter').addEventListener('click', () => {
    $('welcome').classList.add('fade-out');
    setTimeout(() => $('drop-zone').classList.remove('hidden'), 800);
  });

  $('btn-play').addEventListener('click', togglePlay);
  $('btn-prev').addEventListener('click', playPrev);
  $('btn-next').addEventListener('click', playNext);
  $('btn-mode').addEventListener('click', toggleMode);

  // 添加音乐按钮 — 随时导入更多
  $('btn-add').addEventListener('click', () => $('file-input').click());

  $('progress-track').addEventListener('click', e => {
    if (!state.audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    state.audio.currentTime = pct * state.audio.duration;
  });

  $('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('light');
    $('btn-theme').textContent = document.body.classList.contains('light') ? '\u{1F319}' : '\u2603';
  });

  $('file-input').addEventListener('change', e => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });

  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag-active'); });
  window.addEventListener('dragleave', e => {
    if (e.clientX === 0 && e.clientY === 0) document.body.classList.remove('drag-active');
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('drag-active');
    const files = [...e.dataTransfer.files].filter(f =>
      f.type.startsWith('audio/') || f.name.toLowerCase().endsWith('.ncm')
    );
    if (files.length) addFiles(files);
  });

  state.audio.addEventListener('timeupdate', updateProgress);
  state.audio.addEventListener('ended', onEnded);
  state.audio.volume = state.volume;
}

// ============ 开场页星空生成 ============
function generateStarfield() {
  const el = $('starfield');
  if (!el) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const shadows = [];
  for (let i = 0; i < 120; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    const opacity = (0.3 + Math.random() * 0.7).toFixed(2);
    shadows.push(`${x}px ${y}px 0 0 rgba(255,255,255,${opacity})`);
  }
  el.style.boxShadow = shadows.join(', ');
}

// ============ 启动 ============
initThree();
bindEvents();
generateStarfield();
animate();

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const W = 800;
const H = 600;
const DPR = window.devicePixelRatio || 1;
canvas.width = W * DPR;
canvas.height = H * DPR;
canvas.style.width = W + "px";
canvas.style.height = H + "px";
ctx.scale(DPR, DPR);

function showError(msg: string) {
  ctx.fillStyle = "#0a0a1a";
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = "#ff3333";
  ctx.font = "16px monospace";
  ctx.textAlign = "left";
  const lines = msg.split("\n").slice(0, 20);
  lines.forEach((l, i) => ctx.fillText(l, 20, 40 + i * 22));
}
window.addEventListener("error", e => {
  showError("ERROR: " + (e.message || e.error) + "\n" + (e.error && e.error.stack ? e.error.stack : ""));
});

ctx.fillStyle = "#0a0a1a";
ctx.fillRect(0, 0, 800, 600);
ctx.fillStyle = "#fff";
ctx.font = "20px sans-serif";
ctx.textAlign = "center";
ctx.fillText("初期化中... (Initializing)", 400, 300);

const CX = W / 2;
const CY = H / 2;

let gameMode: "menu" | "tracewave" = "menu";
let bpm = 120;
let beatMs = 60000 / bpm;
let gameOver = false;
let score = 0;
let songTime = 0;
let muted = false;

const keys: Record<string, boolean> = {};
let keysJust: Record<string, boolean> = {};

// ── Audio (lookahead scheduler, audio-clock driven) ──

let audioCtx: AudioContext | null = null;
let audioStartTime = 0;
let audioStarted = false;
let nextBeatTime = 0;
let schedulerBeat = 0;
let perfStart = performance.now();

function ensureAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      audioStartTime = audioCtx.currentTime;
      alignScheduler();
      audioStarted = true;
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { audioCtx = null; }
}

function alignScheduler() {
  if (!audioCtx) return;
  const beatSec = beatMs / 1000;
  const elapsedBeats = (audioCtx.currentTime - audioStartTime) / beatSec;
  schedulerBeat = Math.max(0, Math.ceil(elapsedBeats));
  nextBeatTime = audioStartTime + schedulerBeat * beatSec;
}

function resetAudioClock() {
  if (audioCtx && audioStarted) {
    audioStartTime = audioCtx.currentTime;
    alignScheduler();
  }
  perfStart = performance.now();
}

function songNow(): number {
  if (audioCtx && audioStarted) return (audioCtx.currentTime - audioStartTime) * 1000;
  return performance.now() - perfStart;
}

function playClickAt(time: number, beat: number) {
  if (!audioCtx || muted) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g).connect(audioCtx.destination);
  if (beat % 4 === 0) {
    o.type = "sine";
    o.frequency.setValueAtTime(170, time);
    o.frequency.exponentialRampToValueAtTime(55, time + 0.12);
    g.gain.setValueAtTime(0.55, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    o.start(time);
    o.stop(time + 0.22);
  } else {
    o.type = "square";
    o.frequency.value = 900;
    g.gain.setValueAtTime(0.22, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    o.start(time);
    o.stop(time + 0.06);
  }
}

function scheduleMetronome() {
  if (!audioCtx || !audioStarted || muted) return;
  const ahead = 0.15;
  while (nextBeatTime < audioCtx.currentTime + ahead) {
    playClickAt(nextBeatTime, schedulerBeat);
    nextBeatTime += beatMs / 1000;
    schedulerBeat++;
  }
}

function hitSound(quality: "perfect" | "good" | "miss") {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.connect(g).connect(audioCtx.destination);
  if (quality === "perfect") { o.type = "sine"; o.frequency.value = 1320; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.start(t); o.stop(t + 0.11); }
  else if (quality === "good") { o.type = "sine"; o.frequency.value = 880; g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.start(t); o.stop(t + 0.11); }
  else { o.type = "sawtooth"; o.frequency.value = 110; g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); o.start(t); o.stop(t + 0.19); }
}

window.addEventListener("keydown", e => {
  if (!keys[e.key]) keysJust[e.key] = true;
  keys[e.key] = true;
  if (e.key === " ") e.preventDefault();
  if (e.key === "m" || e.key === "M") { muted = !muted; keysJust["m"] = false; keysJust["M"] = false; }
  ensureAudio();
});
window.addEventListener("keyup", e => { keys[e.key] = false; });
canvas.addEventListener("click", () => ensureAudio());

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v: number, mn: number, mx: number) { return Math.max(mn, Math.min(mx, v)); }

function drawText(text: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = "center") {
  ctx.fillStyle = color;
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

// ─── Menu ───

function drawMenu() {
  ctx.fillStyle = "#0a0a1a";
  ctx.fillRect(0, 0, W, H);

  const phase = (songTime % beatMs) / beatMs;
  const pulse = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;

  drawText("リズムゲーム プロトタイプ", CX, 80, "#e94560", 40);
  drawText(`BPM: ${bpm}  (↑↓で変更)`, CX, 120, "#888", 16);
  drawText(muted ? "🔇 ミュート中 (Mで解除)" : (audioStarted ? "🔊 ビート再生中 (Mでミュート)" : "🔈 キー/クリックでビート開始"), CX, 150, muted ? "#666" : (audioStarted ? "#00ff88" : "#ffaa00"), 13);

  const s = 0.97 + Math.sin(songTime * 0.008) * 0.03;
  const bg = `rgba(15, 52, 96, ${0.7 + pulse * 0.3})`;

  ctx.save();
  ctx.translate(CX, 260);
  ctx.scale(s, s);
  ctx.fillStyle = bg;
  ctx.fillRect(-120, -50, 240, 100);
  ctx.strokeStyle = "#e94560";
  ctx.lineWidth = 3;
  ctx.strokeRect(-120, -50, 240, 100);
  drawText("トレース・ウェーブ", 0, 8, "#fff", 22);
  drawText("Space / → キー", 0, 32, "#aaa", 14);
  ctx.restore();

  drawText("ESC=メニュー  R=リスタート  Space=決定/アクション  M=ミュート", CX, 430, "#555", 13);
}

function startTraceWave() {
  gameMode = "tracewave";
  gameOver = false;
  score = 0;
  songTime = 0;
  resetAudioClock();
  initTraceWave();
}

function updateMenu() {
  if (keysJust["ArrowRight"] || keysJust[" "]) { startTraceWave(); keysJust["ArrowRight"] = false; keysJust[" "] = false; }
  if (keysJust["ArrowUp"]) { bpm = Math.min(200, bpm + 5); beatMs = 60000 / bpm; keysJust["ArrowUp"] = false; }
  if (keysJust["ArrowDown"]) { bpm = Math.max(60, bpm - 5); beatMs = 60000 / bpm; keysJust["ArrowDown"] = false; }
}


// ─── Trace Wave (beat-synced scoring) ───

interface Ring { spawnTime: number; hitTime: number; targetY: number; resolved: boolean; hit: boolean; }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; }

const TW_JUDGE_X = Math.round(W * 0.26);
const TW_CENTER_Y = H / 2;
const TW_AMP = 120;
const TW_SCROLL = 150;
const TW_LEAD_BEATS = 2;
const TW_TOLERANCE = 26;
const TW_SNAP = 0.14;
const tierColorsTW = ["#00d2ff", "#00ff88", "#ffaa00", "#ff3333"];

let twState: {
  update: (dt: number) => void;
  render: () => void;
} | null = null;

function initTraceWave() {
  let offset = 0;
  let cursorY = TW_CENTER_Y;
  let combo = 0;
  let inSync = 0;
  let outSync = 0;
  let beatPulse = 0;
  let lastBeatY = TW_CENTER_Y;
  let lastCornerIdx = 0;
  let flash = 0;
  let judgeFlash = 0;
  let judgeText = "";
  let judgeColor = "#fff";
  let lastSpawnBeat = -1;
  let rings: Ring[] = [];
  let particles: Particle[] = [];

  const worldPerBeat = TW_SCROLL * (beatMs / 1000);
  const period = worldPerBeat * 2;

  function triWave(x: number) {
    let t = ((x / period) % 1 + 1) % 1;
    return t < 0.5 ? (4 * t - 1) : (3 - 4 * t);
  }
  function waveY(worldX: number) { return TW_CENTER_Y + TW_AMP * triWave(worldX); }
  function tierFor(c: number) { return c >= 50 ? 3 : c >= 25 ? 2 : c >= 10 ? 1 : 0; }

  function spawnParticle(x: number, y: number, color: string, speed: number) {
    particles.push({ x, y, vx: (Math.random() - 0.5) * speed, vy: (Math.random() - 0.5) * speed, life: 0.5, max: 0.5, color, size: 2 + Math.random() * 2 });
  }

  function onBeat(idx: number) {
    const cornerVal = (idx % 2 === 0) ? -1 : 1;
    const targetY = TW_CENTER_Y + TW_AMP * cornerVal;
    cursorY += (targetY - cursorY) * TW_SNAP;
    beatPulse = 1;
    lastBeatY = targetY;
  }

  function spawnRing(beat: number) {
    const hitTime = (beat + TW_LEAD_BEATS) * beatMs;
    const futureOffset = (hitTime / 1000) * TW_SCROLL;
    const targetY = waveY(futureOffset + TW_JUDGE_X);
    rings.push({ spawnTime: songTime, hitTime, targetY, resolved: false, hit: false });
  }

  function attemptHit() {
    let best: Ring | null = null;
    let bestErr = Infinity;
    for (const r of rings) {
      if (r.resolved) continue;
      const err = Math.abs(songTime - r.hitTime);
      if (err < beatMs * 0.4 && err < bestErr) { best = r; bestErr = err; }
    }
    if (best) {
      best.resolved = true;
      best.hit = true;
      const result: "perfect" | "good" = bestErr < 55 ? "perfect" : "good";
      const tier = tierFor(combo);
      combo += 5;
      score += 200 + combo * 4;
      flash = 0.15;
      for (let k = 0; k < 18; k++) spawnParticle(TW_JUDGE_X, best.targetY, tierColorsTW[tier], 160);
      judgeText = result === "perfect" ? "PERFECT!" : "GOOD";
      judgeColor = result === "perfect" ? "#00ff88" : "#ffaa00";
      judgeFlash = 1;
      hitSound(result);
    }
  }

  function update(dt: number) {
    if (gameOver) return;
    offset = (songTime / 1000) * TW_SCROLL;

    const ms = 340;
    if (keys["ArrowUp"]) cursorY -= ms * dt;
    if (keys["ArrowDown"]) cursorY += ms * dt;
    cursorY = clamp(cursorY, 12, H - 12);

    const idx = Math.floor((offset + TW_JUDGE_X) / worldPerBeat);
    if (idx !== lastCornerIdx) { lastCornerIdx = idx; onBeat(idx); }

    const beatIndex = Math.floor(songTime / beatMs);
    if (beatIndex !== lastSpawnBeat && beatIndex > 0) {
      lastSpawnBeat = beatIndex;
      if (beatIndex % 2 === 0) spawnRing(beatIndex);
    }

    beatPulse = Math.max(0, beatPulse - dt / 0.2);
    flash = Math.max(0, flash - dt);
    judgeFlash = Math.max(0, judgeFlash - dt * 2.5);

    if (keysJust[" "]) { keysJust[" "] = false; attemptHit(); }

    for (const r of rings) {
      if (r.resolved) continue;
      if (songTime > r.hitTime + beatMs * 0.4) {
        r.resolved = true;
        r.hit = false;
        combo = 0;
        judgeText = "MISS";
        judgeColor = "#ff3333";
        judgeFlash = 0.6;
        hitSound("miss");
      }
    }
    rings = rings.filter(r => songTime - r.hitTime < 1200);

    const nowWaveY = waveY(offset + TW_JUDGE_X);
    const diff = Math.abs(cursorY - nowWaveY);
    const tier = tierFor(combo);
    if (diff < TW_TOLERANCE) {
      outSync = 0;
      inSync += dt;
      if (inSync >= 0.15) {
        inSync = 0;
        combo++;
        score += 8 + combo;
        for (let p = 0; p < 2 + tier; p++) spawnParticle(TW_JUDGE_X, cursorY, tierColorsTW[tier], 60);
      }
    } else {
      inSync = 0;
      outSync += dt;
      if (outSync >= 0.5) { outSync = 0; combo = Math.max(0, combo - 4); }
    }

    particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
    particles = particles.filter(p => p.life > 0);
  }

  function render() {
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    const tier = tierFor(combo);

    if (flash > 0) {
      ctx.globalAlpha = flash * 0.5;
      ctx.fillStyle = tierColorsTW[tier];
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(TW_JUDGE_X, 0);
    ctx.lineTo(TW_JUDGE_X, H);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "#8ba3c7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 2) {
      const y = waveY(offset + x);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (beatPulse > 0) {
      ctx.globalAlpha = beatPulse * 0.55;
      ctx.fillStyle = "#ffaa00";
      ctx.beginPath();
      ctx.arc(TW_JUDGE_X, lastBeatY, 16 + (1 - beatPulse) * 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const r of rings) {
      if (r.resolved && !(songTime - r.hitTime < 0.25)) continue;
      const denom = Math.max(1, r.hitTime - r.spawnTime);
      const progress = clamp((songTime - r.spawnTime) / denom, 0, 1);
      const radius = 68 + (14 - 68) * progress;
      ctx.strokeStyle = r.resolved ? (r.hit ? "#00ff88" : "#666") : "#ffaa00";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(TW_JUDGE_X, r.targetY, Math.max(radius, 4), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#666";
      ctx.beginPath();
      ctx.arc(TW_JUDGE_X, r.targetY, 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    particles.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    ctx.fillStyle = tierColorsTW[tier];
    ctx.beginPath();
    ctx.arc(TW_JUDGE_X, cursorY, 9 + tier, 0, Math.PI * 2);
    ctx.fill();

    drawText(`Score: ${Math.floor(score)}`, 20, 30, "#fff", 18, "left");
    drawText(`Combo: ${combo}`, 20, 55, "#fff", 18, "left");
    if (judgeFlash > 0) drawText(judgeText, TW_JUDGE_X, 90, judgeColor, 26 + judgeFlash * 8);

    drawText("↑ ↓ で波形をなぞる  リングが最小になった瞬間に SPACE = HIT!", CX, H - 20, "#888", 13);
  }

  twState = { update, render };
}

// ─── Main Loop ───

let lastLoopTime = 0;

function gameLoop(time: number) {
  try {
    const dt = lastLoopTime === 0 ? 0 : Math.min(1 / 20, (time - lastLoopTime) / 1000);
    lastLoopTime = time;

    songTime = songNow();
    scheduleMetronome();

    if (gameMode === "menu") {
      updateMenu();
      drawMenu();
    } else if (gameMode === "tracewave") {
      if (twState) {
        twState.update(dt);
        twState.render();
      }
      if (keysJust["r"] || keysJust["R"]) { keysJust["r"] = false; keysJust["R"] = false; startTraceWave(); }
      if (keysJust["Escape"]) { keysJust["Escape"] = false; gameMode = "menu"; }
    }

    keysJust = {};
  } catch (err) {
    showError("gameLoop error:\n" + (err && (err as Error).stack ? (err as Error).stack : String(err)));
    return;
  }
  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

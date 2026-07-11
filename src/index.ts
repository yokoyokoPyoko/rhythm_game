const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

canvas.width = 800;
canvas.height = 600;

const W = canvas.width;
const H = canvas.height;
const CX = W / 2;
const CY = H / 2;

let gameMode: "menu" | "soundwave" | "tracewave" = "menu";
let bpm = 120;
let beatMs = 60000 / bpm;
let beatTimer = 0;
let beatCount = 0;
let gameOver = false;
let score = 0;

const keys: Record<string, boolean> = {};
let keysJust: Record<string, boolean> = {};

window.addEventListener("keydown", e => {
  if (!keys[e.key]) keysJust[e.key] = true;
  keys[e.key] = true;
  if (e.key === " ") e.preventDefault();
});
window.addEventListener("keyup", e => { keys[e.key] = false; });

let frameCount = 0;

function fillCircle(x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeCircle(x: number, y: number, r: number, color: string, w = 2) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function clamp(v: number, mn: number, mx: number) { return Math.max(mn, Math.min(mx, v)); }

function wrapAngle(a: number) {
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a;
}

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

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

  const pulse = Math.sin(beatTimer / beatMs * Math.PI * 2) * 0.5 + 0.5;

  drawText("リズムゲーム プロトタイプ", CX, 80, "#e94560", 40);
  drawText(`BPM: ${bpm}  (↑↓で変更)`, CX, 120, "#888", 16);

  const s = 0.97 + Math.sin(frameCount * 0.08) * 0.03;
  const bg = `rgba(15, 52, 96, ${0.7 + pulse * 0.3})`;

  ctx.save();
  ctx.translate(CX - 170, 260);
  ctx.scale(s, s);
  ctx.fillStyle = bg;
  ctx.fillRect(-120, -50, 240, 100);
  ctx.strokeStyle = "#e94560";
  ctx.lineWidth = 3;
  ctx.strokeRect(-120, -50, 240, 100);
  drawText("音波サバイバル", 0, 8, "#fff", 22);
  drawText("← キー", 0, 32, "#aaa", 14);
  ctx.restore();

  ctx.save();
  ctx.translate(CX + 170, 260);
  ctx.scale(s, s);
  ctx.fillStyle = bg;
  ctx.fillRect(-120, -50, 240, 100);
  ctx.strokeStyle = "#e94560";
  ctx.lineWidth = 3;
  ctx.strokeRect(-120, -50, 240, 100);
  drawText("トレース・ウェーブ", 0, 8, "#fff", 22);
  drawText("→ キー", 0, 32, "#aaa", 14);
  ctx.restore();

  drawText("ESC=メニュー  R=リスタート  Space=決定/アクション", CX, 430, "#555", 13);
}

function startSoundWave() {
  gameMode = "soundwave";
  gameOver = false;
  score = 0;
  beatTimer = 0;
  beatCount = 0;
  initSoundWave();
}

function startTraceWave() {
  gameMode = "tracewave";
  gameOver = false;
  score = 0;
  beatTimer = 0;
  beatCount = 0;
  initTraceWave();
}

function updateMenu() {
  if (keysJust["ArrowLeft"]) { startSoundWave(); keysJust["ArrowLeft"] = false; }
  if (keysJust["ArrowRight"]) { startTraceWave(); keysJust["ArrowRight"] = false; }
  if (keysJust["ArrowUp"]) { bpm = Math.min(200, bpm + 5); beatMs = 60000 / bpm; keysJust["ArrowUp"] = false; }
  if (keysJust["ArrowDown"]) { bpm = Math.max(60, bpm - 5); beatMs = 60000 / bpm; keysJust["ArrowDown"] = false; }
}

// ─── Sound Wave Survival ───

interface RingNote {
  angle: number;
  progress: number;
  speed: number;
  alive: boolean;
  hit: boolean;
}

let swState: {
  playerAngle: number;
  health: number;
  notes: RingNote[];
  combo: number;
  maxCombo: number;
  beatPulse: number;
  hitEffect: number;
  missEffect: number;
  update: (dt: number, onBeat: boolean) => void;
  render: () => void;
} | null = null;

function initSoundWave() {
  const JUDGE_R = 140;
  const ARENA_R = 220;
  let playerAngle = 0;
  let health = 100;
  let notes: RingNote[] = [];
  let combo = 0;
  let maxCombo = 0;
  let beatPulse = 0;
  let hitEffect = 0;
  let missEffect = 0;
  let noteTimer = 0;
  let noteInterval = 2;
  let lastOnBeat = false;

  const state = {
    playerAngle: 0, health: 100, notes, combo: 0, maxCombo: 0,
    beatPulse: 0, hitEffect: 0, missEffect: 0, update, render
  };

  function spawnNote() {
    const angle = Math.random() * Math.PI * 2;
    const beatsToArrive = 2 + Math.random();
    notes.push({
      angle,
      progress: 0,
      speed: 1 / beatsToArrive,
      alive: true,
      hit: false
    });
  }

  function update(dt: number, onBeat: boolean) {
    if (gameOver) return;
    if (health <= 0) { gameOver = true; return; }

    if (keys["ArrowLeft"]) playerAngle -= 3 * dt;
    if (keys["ArrowRight"]) playerAngle += 3 * dt;
    playerAngle = wrapAngle(playerAngle);

    if (onBeat) {
      beatPulse = 1;
      noteTimer++;
      if (noteTimer >= noteInterval) {
        noteTimer = 0;
        spawnNote();
      }
    }
    beatPulse = Math.max(0, beatPulse - dt * 4);

    if (keysJust[" "]) {
      keysJust[" "] = false;
      let anyHit = false;
      for (const n of notes) {
        if (!n.alive || n.hit) continue;
        const distToJudge = Math.abs(n.progress - 1);
        if (distToJudge < 0.15 && angleDiff(n.angle, playerAngle) < 0.4) {
          n.hit = true;
          n.alive = false;
          anyHit = true;
          const perf = distToJudge < 0.05;
          score += perf ? 50 : 25;
          combo++;
          if (combo > maxCombo) maxCombo = combo;
          hitEffect = 0.4;
        }
      }
      if (!anyHit) {
        combo = 0;
        missEffect = 0.3;
      }
    }

    for (const n of notes) {
      if (!n.alive) continue;
      n.progress += n.speed * dt;
      if (n.progress >= 1.3) {
        n.alive = false;
        if (!n.hit) {
          health -= 12;
          combo = 0;
          missEffect = 0.4;
        }
      }
    }

    notes = notes.filter(n => n.alive || n.hit);
    hitEffect = Math.max(0, hitEffect - dt * 3);
    missEffect = Math.max(0, missEffect - dt * 3);
    health = clamp(health + dt * 2, 0, 100);
    score += dt;
  }

  function render() {
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    if (missEffect > 0) {
      ctx.fillStyle = `rgba(255, 0, 0, ${missEffect * 0.15})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (beatPulse > 0) {
      const r = beatPulse * 40;
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, r);
      g.addColorStop(0, `rgba(233, 69, 96, ${beatPulse * 0.25})`);
      g.addColorStop(1, "rgba(233, 69, 96, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(CX, CY, r, 0, Math.PI * 2);
      ctx.fill();
    }

    strokeCircle(CX, CY, JUDGE_R, "rgba(0, 210, 255, 0.2)", 2);
    strokeCircle(CX, CY, ARENA_R, "rgba(255,255,255,0.06)", 1);

    const px = CX + Math.cos(playerAngle) * JUDGE_R;
    const py = CY + Math.sin(playerAngle) * JUDGE_R;
    fillCircle(px, py, 8, "#00d2ff");
    strokeCircle(px, py, 14, "#00d2ff", 2);

    const pi = playerAngle;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(px, py);
    ctx.strokeStyle = "rgba(0, 210, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();

    for (const n of notes) {
      if (!n.alive) continue;
      const r = n.progress * JUDGE_R;
      const x = CX + Math.cos(n.angle) * r;
      const y = CY + Math.sin(n.angle) * r;
      const nearingJudge = Math.abs(n.progress - 1) < 0.2;
      const inLane = angleDiff(n.angle, playerAngle) < 0.4;
      if (nearingJudge && inLane) {
        strokeCircle(CX, CY, r, "#ffaa00", 3);
        fillCircle(x, y, 8, "#ffaa00");
      } else {
        strokeCircle(CX, CY, r, `rgba(233, 69, 96, ${0.6 - n.progress * 0.3})`, 2);
        fillCircle(x, y, 6, "#e94560");
      }
    }

    if (hitEffect > 0) {
      const gr = hitEffect * 60;
      const g = ctx.createRadialGradient(px, py, 0, px, py, gr);
      g.addColorStop(0, `rgba(0, 255, 136, ${hitEffect * 0.6})`);
      g.addColorStop(1, "rgba(0, 255, 136, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, gr, 0, Math.PI * 2);
      ctx.fill();
      strokeCircle(px, py, gr, "rgba(0, 255, 136, 0.3)", 2);
    }

    const hp = health / 100;
    ctx.fillStyle = "#222";
    ctx.fillRect(W - 200, 20, 180, 14);
    ctx.fillStyle = hp > 0.5 ? "#00ff88" : hp > 0.25 ? "#ffaa00" : "#ff3333";
    ctx.fillRect(W - 200, 20, 180 * hp, 14);
    drawText(`HP ${Math.floor(health)}`, W - 210, 32, "#fff", 12, "right");

    drawText(`Score: ${Math.floor(score)}`, 20, 30, "#fff", 18, "left");
    drawText(`Combo: ${combo}`, 20, 55, "#fff", 18, "left");
    drawText("← → 回転  SPACEで迎撃 (リングが青い円に重なる時に)", CX, H - 20, "#888", 13);

    if (gameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, W, H);
      drawText("GAME OVER", CX, CY - 20, "#e94560", 48);
      drawText(`Score: ${Math.floor(score)}  Max Combo: ${maxCombo}`, CX, CY + 40, "#fff", 28);
      drawText("R: リスタート  ESC: メニュー", CX, CY + 80, "#fff", 18);
    }
  }

  swState = state;
}

// ─── Trace Wave ───

let twState: {
  playerY: number;
  hitCount: number;
  missCount: number;
  missStreak: number;
  accuracy: number;
  beatFlash: number;
  update: (dt: number, onBeat: boolean) => void;
  render: () => void;
} | null = null;

function initTraceWave() {
  const waveAmp = 140;
  const waveOrigin = H / 2;
  let playerY = waveOrigin;
  let targetY = waveOrigin;
  let scroll = 0;
  let accuracy = 0;
  let hitCount = 0;
  let missCount = 0;
  let missStreak = 0;
  let trail: { x: number; y: number }[] = [];
  let waveFreq = 2.5;
  let speed = 90;
  let beatFlash = 0;

  const state = {
    playerY: waveOrigin, hitCount: 0, missCount: 0,
    missStreak: 0, accuracy: 0, beatFlash: 0, update, render
  };

  function getWave(x: number) {
    const a = Math.sin(x * 0.012 * waveFreq) * waveAmp * 0.6;
    const b = Math.sin(x * 0.025 * waveFreq * 1.4 + 1.2) * waveAmp * 0.3;
    const c = Math.sin(x * 0.006 * waveFreq * 0.6 + 2.7) * waveAmp * 0.2;
    return waveOrigin + a + b + c;
  }

  function update(dt: number, onBeat: boolean) {
    if (gameOver) return;

    waveFreq = 2.5 + beatCount * 0.012;
    speed = 90 + beatCount * 0.6;
    scroll += speed * dt;

    const ms = 350;
    if (keys["ArrowUp"]) targetY -= ms * dt;
    if (keys["ArrowDown"]) targetY += ms * dt;
    targetY = clamp(targetY, 30, H - 30);
    playerY = lerp(playerY, targetY, 14 * dt);

    const jx = W * 0.18;
    const waveY = getWave(jx + scroll);
    const diff = Math.abs(playerY - waveY);

    accuracy = Math.max(0, 1 - diff / waveAmp);

    if (onBeat) beatFlash = 1;
    beatFlash = Math.max(0, beatFlash - dt * 3);

    if (diff < 12) {
      hitCount++;
      missStreak = 0;
      const bonus = onBeat ? 2 : 1;
      score += 10 * bonus;
      trail.push({ x: jx, y: playerY });
      if (trail.length > 80) trail.shift();
    } else {
      missCount++;
      missStreak++;
    }

    if (missStreak > 120) {
      gameOver = true;
    }
  }

  function render() {
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    if (beatFlash > 0) {
      ctx.fillStyle = `rgba(233, 69, 96, ${beatFlash * 0.05})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(0, waveOrigin);
    ctx.lineTo(W, waveOrigin);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    const steps = 300;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * W;
      const y = getWave(x + scroll);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#e94560";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#e94560";
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const jx = W * 0.18;
    const waveY = getWave(jx + scroll);

    ctx.strokeStyle = "rgba(0, 210, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(jx, 0);
    ctx.lineTo(jx, H);
    ctx.stroke();
    ctx.setLineDash([]);

    const diff = Math.abs(playerY - waveY);
    fillCircle(jx, waveY, 7, "rgba(233, 69, 96, 0.4)");
    fillCircle(jx, playerY, 9, "#00d2ff");
    strokeCircle(jx, playerY, 16, diff < 12 ? "#00ff88" : "#00d2ff", 2);

    for (const t of trail) {
      fillCircle(t.x, t.y, 3, "rgba(0, 210, 255, 0.2)");
    }

    drawText(`Score: ${Math.floor(score)}`, 20, 30, "#fff", 18, "left");
    drawText(`Accuracy: ${(accuracy * 100).toFixed(0)}%`, 20, 55, "#fff", 18, "left");
    drawText(`Hits: ${hitCount}  Miss: ${missCount}`, 20, 80, "#fff", 18, "left");

    const bx = 20, by = 105, bw = 160, bh = 10;
    ctx.fillStyle = "#222";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = diff < 12 ? "#00ff88" : diff < 30 ? "#ffaa00" : "#ff3333";
    ctx.fillRect(bx, by, bw * accuracy, bh);

    drawText("↑ ↓ で波形をトレース  青いラインの位置で判定", CX, H - 20, "#888", 13);

    if (gameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, W, H);
      drawText("GAME OVER", CX, CY - 20, "#e94560", 48);
      drawText(`Score: ${Math.floor(score)}`, CX, CY + 40, "#fff", 28);
      drawText("R: リスタート  ESC: メニュー", CX, CY + 80, "#fff", 18);
    }
  }

  twState = state;
}

// ─── Main Loop ───

function gameLoop(time: number) {
  const dt = Math.min(1 / 30, 1 / 60);
  frameCount++;

  beatTimer += dt * 1000;
  let onBeat = false;
  while (beatTimer >= beatMs) {
    beatTimer -= beatMs;
    beatCount++;
    onBeat = true;
  }
  const beatPhase = beatTimer / beatMs;

  if (gameMode === "menu") {
    updateMenu();
    drawMenu();
  } else if (gameMode === "soundwave") {
    if (swState) {
      swState.update(dt, onBeat);
      swState.render();
    }
    if (keysJust["r"] || keysJust["R"]) { keysJust["r"] = false; keysJust["R"] = false; startSoundWave(); }
    if (keysJust["Escape"]) { keysJust["Escape"] = false; gameMode = "menu"; }
  } else if (gameMode === "tracewave") {
    if (twState) {
      twState.update(dt, onBeat);
      twState.render();
    }
    if (keysJust["r"] || keysJust["R"]) { keysJust["r"] = false; keysJust["R"] = false; startTraceWave(); }
    if (keysJust["Escape"]) { keysJust["Escape"] = false; gameMode = "menu"; }
  }

  keysJust = {};
  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

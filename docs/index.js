"use strict";
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
canvas.width = 800;
canvas.height = 600;
function showError(msg) {
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
const W = canvas.width;
const H = canvas.height;
const CX = W / 2;
const CY = H / 2;
let gameMode = "menu";
let bpm = 120;
let beatMs = 60000 / bpm;
let gameOver = false;
let score = 0;
let songTime = 0;
let muted = false;
const keys = {};
let keysJust = {};
// ── Audio (lookahead scheduler, audio-clock driven) ──
let audioCtx = null;
let audioStartTime = 0;
let audioStarted = false;
let nextBeatTime = 0;
let schedulerBeat = 0;
let perfStart = performance.now();
function ensureAudio() {
    try {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC)
                return;
            audioCtx = new AC();
            audioStartTime = audioCtx.currentTime;
            alignScheduler();
            audioStarted = true;
        }
        if (audioCtx.state === "suspended")
            audioCtx.resume();
    }
    catch (_a) {
        audioCtx = null;
    }
}
function alignScheduler() {
    if (!audioCtx)
        return;
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
function songNow() {
    if (audioCtx && audioStarted)
        return (audioCtx.currentTime - audioStartTime) * 1000;
    return performance.now() - perfStart;
}
function playClickAt(time, beat) {
    if (!audioCtx || muted)
        return;
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
    }
    else {
        o.type = "square";
        o.frequency.value = 900;
        g.gain.setValueAtTime(0.22, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        o.start(time);
        o.stop(time + 0.06);
    }
}
function scheduleMetronome() {
    if (!audioCtx || !audioStarted || muted)
        return;
    const ahead = 0.15;
    while (nextBeatTime < audioCtx.currentTime + ahead) {
        playClickAt(nextBeatTime, schedulerBeat);
        nextBeatTime += beatMs / 1000;
        schedulerBeat++;
    }
}
function hitSound(quality) {
    if (!audioCtx || muted)
        return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g).connect(audioCtx.destination);
    if (quality === "perfect") {
        o.type = "sine";
        o.frequency.value = 1320;
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.start(t);
        o.stop(t + 0.11);
    }
    else if (quality === "good") {
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.start(t);
        o.stop(t + 0.11);
    }
    else {
        o.type = "sawtooth";
        o.frequency.value = 110;
        g.gain.setValueAtTime(0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t);
        o.stop(t + 0.19);
    }
}
window.addEventListener("keydown", e => {
    if (!keys[e.key])
        keysJust[e.key] = true;
    keys[e.key] = true;
    if (e.key === " ")
        e.preventDefault();
    if (e.key === "m" || e.key === "M") {
        muted = !muted;
        keysJust["m"] = false;
        keysJust["M"] = false;
    }
    ensureAudio();
});
window.addEventListener("keyup", e => { keys[e.key] = false; });
canvas.addEventListener("click", () => ensureAudio());
function fillCircle(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}
function strokeCircle(x, y, r, color, w = 2) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function wrapAngle(a) {
    while (a < 0)
        a += Math.PI * 2;
    while (a >= Math.PI * 2)
        a -= Math.PI * 2;
    return a;
}
function drawText(text, x, y, color, size, align = "center") {
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
    drawText("ESC=メニュー  R=リスタート  Space=決定/アクション  M=ミュート", CX, 430, "#555", 13);
}
function startSoundWave() {
    gameMode = "soundwave";
    gameOver = false;
    score = 0;
    songTime = 0;
    resetAudioClock();
    initSoundWave();
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
    if (keysJust["ArrowLeft"]) {
        startSoundWave();
        keysJust["ArrowLeft"] = false;
    }
    if (keysJust["ArrowRight"]) {
        startTraceWave();
        keysJust["ArrowRight"] = false;
    }
    if (keysJust["ArrowUp"]) {
        bpm = Math.min(200, bpm + 5);
        beatMs = 60000 / bpm;
        keysJust["ArrowUp"] = false;
    }
    if (keysJust["ArrowDown"]) {
        bpm = Math.max(60, bpm - 5);
        beatMs = 60000 / bpm;
        keysJust["ArrowDown"] = false;
    }
}
let swState = null;
const JUDGE_R = 150;
const APPROACH_BEATS = 2;
const HIT_WINDOW = 0.4;
function initSoundWave() {
    let notes = [];
    let health = 100;
    let combo = 0;
    let maxCombo = 0;
    let judgeFlash = 0;
    let judgeText = "";
    let judgeColor = "#fff";
    let beatPulse = 0;
    let shockAnim = 0;
    let lastSpawnBeat = -1;
    const state = {
        notes, health, combo, maxCombo,
        judgeFlash: 0, judgeText: "", judgeColor: "#fff",
        beatPulse: 0, shockAnim: 0, lastSpawnBeat: -1, update, render
    };
    function spawnNote(targetBeat) {
        const angle = Math.random() * Math.PI * 2;
        notes.push({ angle, targetBeat, judged: false, hitAnim: 0, inWindow: false });
    }
    function judgePress() {
        let hitAny = false;
        let bestErr = Infinity;
        let bestResult = "good";
        for (const n of notes) {
            if (n.judged)
                continue;
            const targetTime = n.targetBeat * beatMs;
            const err = Math.abs(songTime - targetTime);
            if (err < beatMs * HIT_WINDOW) {
                hitAny = true;
                if (err < bestErr) {
                    bestErr = err;
                    bestResult = err < 55 ? "perfect" : err < 120 ? "good" : "good";
                }
                n.judged = true;
                n.result = err < 55 ? "perfect" : "good";
                n.hitAnim = 1;
            }
        }
        if (hitAny) {
            const mult = bestResult === "perfect" ? 1 : 0.5;
            score += Math.round(100 * mult);
            combo++;
            if (combo > maxCombo)
                maxCombo = combo;
            judgeText = bestResult === "perfect" ? "PERFECT!" : "GOOD";
            judgeColor = bestResult === "perfect" ? "#00ff88" : "#ffaa00";
            judgeFlash = 1;
            shockAnim = 1;
            hitSound(bestResult);
        }
        else {
            combo = 0;
            judgeText = "MISS";
            judgeColor = "#ff3333";
            judgeFlash = 0.6;
            hitSound("miss");
        }
    }
    function update(dt) {
        if (gameOver)
            return;
        if (health <= 0) {
            gameOver = true;
            return;
        }
        const beatIndex = Math.floor(songTime / beatMs);
        if (beatIndex !== lastSpawnBeat && beatIndex > 0) {
            lastSpawnBeat = beatIndex;
            if (Math.random() < 0.85) {
                spawnNote(beatIndex + APPROACH_BEATS);
                if (Math.random() < 0.3)
                    spawnNote(beatIndex + APPROACH_BEATS);
            }
        }
        beatPulse = 1 - (songTime % beatMs) / beatMs;
        judgeFlash = Math.max(0, judgeFlash - dt * 2.5);
        shockAnim = Math.max(0, shockAnim - dt * 3);
        if (keysJust[" "]) {
            keysJust[" "] = false;
            judgePress();
        }
        for (const n of notes) {
            if (n.hitAnim > 0)
                n.hitAnim = Math.max(0, n.hitAnim - dt * 3);
            const targetTime = n.targetBeat * beatMs;
            n.inWindow = !n.judged && Math.abs(songTime - targetTime) < beatMs * HIT_WINDOW;
            if (!n.judged && songTime > targetTime + beatMs * HIT_WINDOW) {
                n.judged = true;
                n.result = "miss";
                health -= 15;
                combo = 0;
                judgeText = "MISS";
                judgeColor = "#ff3333";
                judgeFlash = 0.6;
                hitSound("miss");
            }
        }
        notes = notes.filter(n => !n.judged || n.hitAnim > 0);
        health = clamp(health + dt * 1.5, 0, 100);
        if (combo > 0)
            score += dt * 3;
    }
    function render() {
        ctx.fillStyle = "#0a0a1a";
        ctx.fillRect(0, 0, W, H);
        if (shockAnim > 0) {
            const r = JUDGE_R + (1 - shockAnim) * 80;
            strokeCircle(CX, CY, r, `rgba(0, 255, 136, ${shockAnim * 0.5})`, 4);
        }
        if (beatPulse > 0) {
            const r = JUDGE_R * (1 + (1 - beatPulse) * 0.12);
            strokeCircle(CX, CY, r, `rgba(233, 69, 96, ${beatPulse * 0.25})`, 2);
        }
        strokeCircle(CX, CY, JUDGE_R, "rgba(0, 210, 255, 0.5)", 3);
        strokeCircle(CX, CY, JUDGE_R, "rgba(255,255,255,0.12)", 1);
        strokeCircle(CX, CY, 200, "rgba(255,255,255,0.05)", 1);
        fillCircle(CX, CY, 6, "#e94560");
        for (const n of notes) {
            if (n.hitAnim > 0) {
                const gr = (1 - n.hitAnim) * 50 + 10;
                const nx = CX + Math.cos(n.angle) * JUDGE_R;
                const ny = CY + Math.sin(n.angle) * JUDGE_R;
                const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, gr);
                g.addColorStop(0, `rgba(0,255,136,${n.hitAnim * 0.6})`);
                g.addColorStop(1, "rgba(0,255,136,0)");
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(nx, ny, gr, 0, Math.PI * 2);
                ctx.fill();
                continue;
            }
            if (n.judged)
                continue;
            const targetTime = n.targetBeat * beatMs;
            const progress = clamp((songTime - (targetTime - APPROACH_BEATS * beatMs)) / (APPROACH_BEATS * beatMs), 0, 1.1);
            const r = progress * JUDGE_R;
            const x = CX + Math.cos(n.angle) * r;
            const y = CY + Math.sin(n.angle) * r;
            if (n.inWindow) {
                strokeCircle(CX, CY, r, "#ffaa00", 4);
                fillCircle(x, y, 10, "#ffaa00");
            }
            else {
                strokeCircle(CX, CY, r, `rgba(233,69,96,${0.7 - progress * 0.3})`, 3);
                fillCircle(x, y, 7, "#e94560");
            }
        }
        if (judgeFlash > 0) {
            drawText(judgeText, CX, CY - 180, judgeColor, 28 + judgeFlash * 10);
        }
        if (combo > 1) {
            drawText(`${combo} COMBO`, CX, CY - 210, "#fff", 18);
        }
        const hp = health / 100;
        ctx.fillStyle = "#222";
        ctx.fillRect(W - 200, 20, 180, 14);
        ctx.fillStyle = hp > 0.5 ? "#00ff88" : hp > 0.25 ? "#ffaa00" : "#ff3333";
        ctx.fillRect(W - 200, 20, 180 * hp, 14);
        drawText(`HP ${Math.floor(health)}`, W - 210, 32, "#fff", 12, "right");
        drawText(`Score: ${Math.floor(score)}`, 20, 30, "#fff", 18, "left");
        drawText(`Combo: ${combo}`, 20, 55, "#fff", 18, "left");
        drawText("音符が青い輪に重なったら SPACE!  (ビートに合わせて)", CX, H - 20, "#888", 13);
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
const TW_JUDGE_X = Math.round(W * 0.26);
const TW_CENTER_Y = H / 2;
const TW_AMP = 120;
const TW_SCROLL = 150;
const TW_LEAD_BEATS = 2;
const TW_TOLERANCE = 26;
const TW_SNAP = 0.14;
const tierColorsTW = ["#00d2ff", "#00ff88", "#ffaa00", "#ff3333"];
let twState = null;
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
    let rings = [];
    let particles = [];
    const worldPerBeat = TW_SCROLL * (beatMs / 1000);
    const period = worldPerBeat * 2;
    function triWave(x) {
        let t = ((x / period) % 1 + 1) % 1;
        return t < 0.5 ? (4 * t - 1) : (3 - 4 * t);
    }
    function waveY(worldX) { return TW_CENTER_Y + TW_AMP * triWave(worldX); }
    function tierFor(c) { return c >= 50 ? 3 : c >= 25 ? 2 : c >= 10 ? 1 : 0; }
    function spawnParticle(x, y, color, speed) {
        particles.push({ x, y, vx: (Math.random() - 0.5) * speed, vy: (Math.random() - 0.5) * speed, life: 0.5, max: 0.5, color, size: 2 + Math.random() * 2 });
    }
    function onBeat(idx) {
        const cornerVal = (idx % 2 === 0) ? -1 : 1;
        const targetY = TW_CENTER_Y + TW_AMP * cornerVal;
        cursorY += (targetY - cursorY) * TW_SNAP;
        beatPulse = 1;
        lastBeatY = targetY;
    }
    function spawnRing(beat) {
        const hitTime = (beat + TW_LEAD_BEATS) * beatMs;
        const futureOffset = (hitTime / 1000) * TW_SCROLL;
        const targetY = waveY(futureOffset + TW_JUDGE_X);
        rings.push({ spawnTime: songTime, hitTime, targetY, resolved: false, hit: false });
    }
    function attemptHit() {
        let best = null;
        let bestErr = Infinity;
        for (const r of rings) {
            if (r.resolved)
                continue;
            const err = Math.abs(songTime - r.hitTime);
            if (err < beatMs * 0.4 && err < bestErr) {
                best = r;
                bestErr = err;
            }
        }
        if (best) {
            best.resolved = true;
            best.hit = true;
            const result = bestErr < 55 ? "perfect" : "good";
            const tier = tierFor(combo);
            combo += 5;
            score += 200 + combo * 4;
            flash = 0.15;
            for (let k = 0; k < 18; k++)
                spawnParticle(TW_JUDGE_X, best.targetY, tierColorsTW[tier], 160);
            judgeText = result === "perfect" ? "PERFECT!" : "GOOD";
            judgeColor = result === "perfect" ? "#00ff88" : "#ffaa00";
            judgeFlash = 1;
            hitSound(result);
        }
    }
    function update(dt) {
        if (gameOver)
            return;
        offset = (songTime / 1000) * TW_SCROLL;
        const ms = 340;
        if (keys["ArrowUp"])
            cursorY -= ms * dt;
        if (keys["ArrowDown"])
            cursorY += ms * dt;
        cursorY = clamp(cursorY, 12, H - 12);
        const idx = Math.floor((offset + TW_JUDGE_X) / worldPerBeat);
        if (idx !== lastCornerIdx) {
            lastCornerIdx = idx;
            onBeat(idx);
        }
        const beatIndex = Math.floor(songTime / beatMs);
        if (beatIndex !== lastSpawnBeat && beatIndex > 0) {
            lastSpawnBeat = beatIndex;
            if (beatIndex % 2 === 0)
                spawnRing(beatIndex);
        }
        beatPulse = Math.max(0, beatPulse - dt / 0.2);
        flash = Math.max(0, flash - dt);
        judgeFlash = Math.max(0, judgeFlash - dt * 2.5);
        if (keysJust[" "]) {
            keysJust[" "] = false;
            attemptHit();
        }
        for (const r of rings) {
            if (r.resolved)
                continue;
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
                for (let p = 0; p < 2 + tier; p++)
                    spawnParticle(TW_JUDGE_X, cursorY, tierColorsTW[tier], 60);
            }
        }
        else {
            inSync = 0;
            outSync += dt;
            if (outSync >= 0.5) {
                outSync = 0;
                combo = Math.max(0, combo - 4);
            }
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
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(TW_JUDGE_X, 0);
        ctx.lineTo(TW_JUDGE_X, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "#e94560";
        ctx.lineWidth = 3;
        ctx.shadowColor = "#e94560";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 4) {
            const y = waveY(offset + x);
            if (x === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (beatPulse > 0) {
            ctx.globalAlpha = beatPulse * 0.55;
            ctx.fillStyle = "#ffaa00";
            ctx.beginPath();
            ctx.arc(TW_JUDGE_X, lastBeatY, 16 + (1 - beatPulse) * 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        for (const r of rings) {
            if (r.resolved && !(songTime - r.hitTime < 0.25))
                continue;
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
        if (judgeFlash > 0)
            drawText(judgeText, TW_JUDGE_X, 90, judgeColor, 26 + judgeFlash * 8);
        drawText("↑ ↓ で波形をなぞる  リングが最小になった瞬間に SPACE = HIT!", CX, H - 20, "#888", 13);
    }
    twState = { update, render };
}
// ─── Main Loop ───
let lastLoopTime = 0;
function gameLoop(time) {
    try {
        const dt = lastLoopTime === 0 ? 0 : Math.min(1 / 20, (time - lastLoopTime) / 1000);
        lastLoopTime = time;
        songTime = songNow();
        scheduleMetronome();
        if (gameMode === "menu") {
            updateMenu();
            drawMenu();
        }
        else if (gameMode === "soundwave") {
            if (swState) {
                swState.update(dt);
                swState.render();
            }
            if (keysJust["r"] || keysJust["R"]) {
                keysJust["r"] = false;
                keysJust["R"] = false;
                startSoundWave();
            }
            if (keysJust["Escape"]) {
                keysJust["Escape"] = false;
                gameMode = "menu";
            }
        }
        else if (gameMode === "tracewave") {
            if (twState) {
                twState.update(dt);
                twState.render();
            }
            if (keysJust["r"] || keysJust["R"]) {
                keysJust["r"] = false;
                keysJust["R"] = false;
                startTraceWave();
            }
            if (keysJust["Escape"]) {
                keysJust["Escape"] = false;
                gameMode = "menu";
            }
        }
        keysJust = {};
    }
    catch (err) {
        showError("gameLoop error:\n" + (err && err.stack ? err.stack : String(err)));
        return;
    }
    requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

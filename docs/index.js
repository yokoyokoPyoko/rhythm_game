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
            nextBeatTime = audioCtx.currentTime + 0.12;
            schedulerBeat = 0;
            audioStarted = true;
        }
        if (audioCtx.state === "suspended")
            audioCtx.resume();
    }
    catch (_a) {
        audioCtx = null;
    }
}
function resetAudioClock() {
    if (audioCtx && audioStarted) {
        audioStartTime = audioCtx.currentTime;
        nextBeatTime = audioCtx.currentTime + 0.12;
        schedulerBeat = 0;
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
function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI)
        d -= Math.PI * 2;
    while (d < -Math.PI)
        d += Math.PI * 2;
    return Math.abs(d);
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
function initSoundWave() {
    let playerAngle = 0;
    let notes = [];
    let health = 100;
    let combo = 0;
    let maxCombo = 0;
    let judgeFlash = 0;
    let judgeText = "";
    let judgeColor = "#fff";
    let beatPulse = 0;
    let lastSpawnBeat = -1;
    const state = {
        playerAngle: 0, notes, health, combo, maxCombo,
        judgeFlash: 0, judgeText: "", judgeColor: "#fff",
        beatPulse: 0, lastSpawnBeat: -1, update, render
    };
    function spawnNote(targetBeat) {
        const angle = Math.random() * Math.PI * 2;
        notes.push({ angle, targetBeat, judged: false, hitAnim: 0 });
    }
    function judgePress() {
        const currentBeatTime = songTime;
        let best = null;
        let bestErr = Infinity;
        for (const n of notes) {
            if (n.judged)
                continue;
            const targetTime = n.targetBeat * beatMs;
            const err = Math.abs(currentBeatTime - targetTime);
            const angleOk = angleDiff(n.angle, playerAngle) < 0.45;
            if (angleOk && err < bestErr) {
                bestErr = err;
                best = n;
            }
        }
        if (best && bestErr < beatMs * 0.45) {
            best.judged = true;
            let result;
            if (bestErr < 55) {
                result = "perfect";
                score += 100;
            }
            else if (bestErr < 120) {
                result = "good";
                score += 50;
            }
            else {
                result = "good";
                score += 25;
            }
            best.result = result;
            best.hitAnim = 1;
            combo++;
            if (combo > maxCombo)
                maxCombo = combo;
            judgeText = result === "perfect" ? "PERFECT!" : "GOOD";
            judgeColor = result === "perfect" ? "#00ff88" : "#ffaa00";
            judgeFlash = 1;
            hitSound(result);
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
        let dx = 0, dy = 0;
        if (keys["ArrowLeft"])
            dx -= 1;
        if (keys["ArrowRight"])
            dx += 1;
        if (keys["ArrowUp"])
            dy -= 1;
        if (keys["ArrowDown"])
            dy += 1;
        if (dx !== 0 || dy !== 0) {
            const tx = -Math.sin(playerAngle), ty = Math.cos(playerAngle);
            const dot = tx * dx + ty * dy;
            playerAngle += Math.sign(dot) * 3.5 * dt;
            playerAngle = wrapAngle(playerAngle);
        }
        const beat = songTime / beatMs;
        const beatIndex = Math.floor(beat);
        if (beatIndex !== lastSpawnBeat && beatIndex > 0) {
            lastSpawnBeat = beatIndex;
            if (Math.random() < 0.8) {
                spawnNote(beatIndex + APPROACH_BEATS);
            }
        }
        beatPulse = 1 - (songTime % beatMs) / beatMs;
        judgeFlash = Math.max(0, judgeFlash - dt * 2.5);
        if (keysJust[" "]) {
            keysJust[" "] = false;
            judgePress();
        }
        for (const n of notes) {
            if (n.hitAnim > 0)
                n.hitAnim = Math.max(0, n.hitAnim - dt * 3);
            const targetTime = n.targetBeat * beatMs;
            if (!n.judged && songTime > targetTime + 140) {
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
        if (beatPulse > 0) {
            const r = JUDGE_R * (1 + (1 - beatPulse) * 0.15);
            strokeCircle(CX, CY, r, `rgba(233, 69, 96, ${beatPulse * 0.3})`, 2);
        }
        strokeCircle(CX, CY, JUDGE_R, "rgba(0, 210, 255, 0.4)", 3);
        strokeCircle(CX, CY, JUDGE_R, "rgba(255,255,255,0.1)", 1);
        strokeCircle(CX, CY, 200, "rgba(255,255,255,0.06)", 1);
        const px = CX + Math.cos(playerAngle) * JUDGE_R;
        const py = CY + Math.sin(playerAngle) * JUDGE_R;
        fillCircle(px, py, 8, "#00d2ff");
        strokeCircle(px, py, 14, "#00d2ff", 2);
        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.lineTo(px, py);
        ctx.strokeStyle = "rgba(0, 210, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();
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
            const near = Math.abs(r - JUDGE_R) < 15;
            const inLane = angleDiff(n.angle, playerAngle) < 0.45;
            if (near && inLane) {
                strokeCircle(CX, CY, r, "#ffaa00", 4);
                fillCircle(x, y, 9, "#ffaa00");
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
        drawText("← → ↑ ↓ で移動(画面方向)  SPACEでビートに合わせて迎撃", CX, H - 20, "#888", 13);
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
// ─── Trace Wave (beat-synced scoring) ───
let twState = null;
function initTraceWave() {
    const waveAmp = 120;
    const waveOrigin = H / 2;
    let playerY = waveOrigin;
    let targetY = waveOrigin;
    let scroll = 0;
    let accuracy = 0;
    let hitCount = 0;
    let missCount = 0;
    let missStreak = 0;
    let trail = [];
    let waveFreq = 2.5;
    let speed = 90;
    let beatFlash = 0;
    let judgeText = "";
    let judgeColor = "#fff";
    let judgeFlash = 0;
    let lastBeat = -1;
    const state = {
        playerY: waveOrigin, hitCount: 0, missCount: 0,
        missStreak: 0, accuracy: 0, beatFlash: 0,
        judgeText: "", judgeColor: "#fff", judgeFlash: 0,
        lastBeat: -1, update, render
    };
    function getWave(x) {
        const beatPhase = (songTime % beatMs) / beatMs;
        const env = 1 + 0.35 * Math.sin(beatPhase * Math.PI * 2);
        const a = Math.sin(x * 0.012 * waveFreq) * waveAmp * 0.6 * env;
        const b = Math.sin(x * 0.025 * waveFreq * 1.4 + 1.2) * waveAmp * 0.3;
        const c = Math.sin(x * 0.006 * waveFreq * 0.6 + 2.7) * waveAmp * 0.2;
        return waveOrigin + a + b + c;
    }
    function update(dt) {
        if (gameOver)
            return;
        waveFreq = 2.5 + (songTime / beatMs) * 0.01;
        speed = 90 + (songTime / beatMs) * 0.5;
        scroll += speed * dt;
        const ms = 360;
        if (keys["ArrowUp"])
            targetY -= ms * dt;
        if (keys["ArrowDown"])
            targetY += ms * dt;
        targetY = clamp(targetY, 30, H - 30);
        playerY = lerp(playerY, targetY, 15 * dt);
        const jx = W * 0.18;
        const waveY = getWave(jx + scroll);
        const diff = Math.abs(playerY - waveY);
        accuracy = Math.max(0, 1 - diff / waveAmp);
        const beatIndex = Math.floor(songTime / beatMs);
        if (beatIndex !== lastBeat && beatIndex > 0) {
            lastBeat = beatIndex;
            beatFlash = 1;
            if (diff < 10) {
                hitCount++;
                missStreak = 0;
                score += 100;
                judgeText = "PERFECT!";
                judgeColor = "#00ff88";
                judgeFlash = 1;
                hitSound("perfect");
            }
            else if (diff < 25) {
                hitCount++;
                missStreak = 0;
                score += 50;
                judgeText = "GOOD";
                judgeColor = "#ffaa00";
                judgeFlash = 1;
                hitSound("good");
            }
            else {
                missCount++;
                missStreak++;
                judgeText = "MISS";
                judgeColor = "#ff3333";
                judgeFlash = 0.8;
                hitSound("miss");
            }
            trail.push({ x: jx, y: playerY });
            if (trail.length > 80)
                trail.shift();
        }
        beatFlash = Math.max(0, beatFlash - dt * 3);
        if (keysJust[" "]) {
            keysJust[" "] = false;
            const tapDiff = Math.abs(playerY - getWave(jx + scroll));
            const beatPhase = (songTime % beatMs) / beatMs;
            const onBeat = beatPhase < 0.14 || beatPhase > 0.86;
            if (tapDiff < 10) {
                hitCount++;
                missStreak = 0;
                score += onBeat ? 200 : 100;
                judgeText = onBeat ? "PERFECT! ★" : "PERFECT!";
                judgeColor = "#00ff88";
                judgeFlash = 1;
                hitSound("perfect");
            }
            else if (tapDiff < 25) {
                hitCount++;
                missStreak = 0;
                score += onBeat ? 100 : 50;
                judgeText = "GOOD";
                judgeColor = "#ffaa00";
                judgeFlash = 1;
                hitSound("good");
            }
            else {
                missCount++;
                missStreak++;
                judgeText = "MISS";
                judgeColor = "#ff3333";
                judgeFlash = 0.8;
                hitSound("miss");
            }
            trail.push({ x: jx, y: playerY });
            if (trail.length > 80)
                trail.shift();
        }
        judgeFlash = Math.max(0, judgeFlash - dt * 2.5);
        if (missStreak > 30) {
            gameOver = true;
        }
    }
    function render() {
        ctx.fillStyle = "#0a0a1a";
        ctx.fillRect(0, 0, W, H);
        if (beatFlash > 0) {
            ctx.fillStyle = `rgba(233, 69, 96, ${beatFlash * 0.06})`;
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
            if (i === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#e94560";
        ctx.lineWidth = 3;
        ctx.shadowColor = "#e94560";
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
        const jx = W * 0.18;
        const waveY = getWave(jx + scroll);
        ctx.strokeStyle = "rgba(0, 210, 255, 0.2)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(jx, 0);
        ctx.lineTo(jx, H);
        ctx.stroke();
        ctx.setLineDash([]);
        const beatPhase = (songTime % beatMs) / beatMs;
        const ringR = 10 + Math.sin(beatPhase * Math.PI * 2) * 4;
        strokeCircle(jx, waveY, ringR, "#e94560", 2);
        const diff = Math.abs(playerY - waveY);
        fillCircle(jx, waveY, 7, "rgba(233, 69, 96, 0.4)");
        fillCircle(jx, playerY, 9, "#00d2ff");
        strokeCircle(jx, playerY, 16, diff < 10 ? "#00ff88" : diff < 25 ? "#ffaa00" : "#00d2ff", 2);
        for (const t of trail) {
            fillCircle(t.x, t.y, 3, "rgba(0, 210, 255, 0.25)");
        }
        if (judgeFlash > 0) {
            drawText(judgeText, jx, 80, judgeColor, 24 + judgeFlash * 8);
        }
        drawText(`Score: ${Math.floor(score)}`, 20, 30, "#fff", 18, "left");
        drawText(`Accuracy: ${(accuracy * 100).toFixed(0)}%`, 20, 55, "#fff", 18, "left");
        drawText(`Hits: ${hitCount}  Miss: ${missCount}`, 20, 80, "#fff", 18, "left");
        const bx = 20, by = 105, bw = 160, bh = 10;
        ctx.fillStyle = "#222";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = diff < 10 ? "#00ff88" : diff < 25 ? "#ffaa00" : "#ff3333";
        ctx.fillRect(bx, by, bw * accuracy, bh);
        drawText("↑ ↓ で波形をトレース  Space=波に重ねた瞬間に判定!  (ビートで叩くと高得点)", CX, H - 20, "#888", 13);
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

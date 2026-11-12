/*
 * CyberCall — оверлей входящего звонка в киберпанк-стиле.
 * Этот файл собирает HTML страницы, которую показывает окно оверлея.
 * Никаких импортов: его можно открыть и в обычном браузере для предпросмотра.
 */

export interface OverlayData {
    name: string;
    sub: string;
    avatar: string;
    /** in — звонят мне, out — звоню я, talk — идёт разговор */
    mode: "in" | "out" | "talk";
    /** когда начался разговор (мс), для таймера */
    startedAt?: number;
    acceptKey: string;
    declineKey: string;
    /** compact — горизонтальная панель, big — карточка с большой аватаркой */
    layout: "compact" | "big";
    /** масштаб, 1 = 100% */
    scale: number;
    /** показывать строку субтитров и подключить распознавание речи (только для разговора) */
    subs?: boolean;
    /** call — панель звонка/собеседника, me — отдельное окно с моей панелью */
    view?: "call" | "me";
    /** в окне звонка: распознавать и мою речь с микрофона (текст уходит в моё окно) */
    own?: boolean;
    /** данные моей панели для view = "me" */
    me?: { name: string; sub: string; avatar: string; } | null;
    /** название готовой палитры или "custom" */
    theme?: string;
    /** свой акцентный цвет (#rrggbb) для палитры "custom" */
    accent?: string;
}

export interface Theme { label: string; accent: string; second: string; danger: string; }

export const THEMES: Record<string, Theme> = {
    neon: { label: "Неон (жёлтый и циан)", accent: "#fcee0a", second: "#00f0ff", danger: "#ff2a4f" },
    blue: { label: "Синий час", accent: "#4fc3ff", second: "#8f9bff", danger: "#ff4f7b" },
    acid: { label: "Кислота (зелёный)", accent: "#b6ff3c", second: "#3cffc0", danger: "#ff4d4d" },
    sunset: { label: "Закат (розовый и фиолетовый)", accent: "#ff5fd2", second: "#a98bff", danger: "#ff5a3c" },
    blood: { label: "Янтарь и красный", accent: "#ffb02e", second: "#ff5a4f", danger: "#e0122f" },
    mono: { label: "Монохром", accent: "#f2f5f8", second: "#9aa7b4", danger: "#ff4f5e" }
};

const HEX = /^#[0-9a-f]{6}$/i;

function toRgb(hex: string) {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

function rgbTriplet(hex: string) {
    return toRgb(hex).join(" ");
}

/** Цвет текста, который читается поверх заливки. */
function onColor(hex: string) {
    const [r, g, b] = toRgb(hex).map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? "#0a0a0a" : "#ffffff";
}

/** Поворачивает оттенок, сохраняя яркость: так из одного акцента получается парный цвет. */
function rotateHue(hex: string, degrees: number) {
    const [r, g, b] = toRgb(hex).map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    h = ((h * 60 + degrees) % 360 + 360) % 360;
    // парный цвет делаем не темнее 55 %, иначе подписи на тёмной панели не читаются
    const l2 = Math.max(l, 0.55), c = (1 - Math.abs(2 * l2 - 1)) * sat, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l2 - c / 2;
    const [r2, g2, b2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return "#" + [r2, g2, b2].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

export function resolveTheme(theme?: string, accent?: string): Theme {
    if (theme === "custom" && accent && HEX.test(accent))
        return { label: "", accent: accent.toLowerCase(), second: rotateHue(accent, 126), danger: THEMES.neon.danger };
    return THEMES[theme ?? ""] ?? THEMES.neon;
}

/** размер одной панели и поля вокруг содержимого окна */
const PANEL = { compact: { width: 520, height: 176 }, big: { width: 320, height: 470 } };
const PAD = 14, GAP = 8;
/** высота строки субтитров под панелью */
const SUBS_HEIGHT = { compact: 66, big: 104 };

export function clampScale(scale: number) {
    return Math.min(2, Math.max(0.5, Number(scale) || 1));
}

/** Размер одного окна оверлея: панель и, если включены субтитры, строка под ней. */
export function overlaySize(layout: "compact" | "big", scale: number, subs = false) {
    const key = layout === "big" ? "big" : "compact", p = PANEL[key], s = clampScale(scale);
    const height = p.height + (subs ? GAP + SUBS_HEIGHT[key] : 0);
    return { width: Math.ceil((p.width + PAD * 2) * s), height: Math.ceil((height + PAD * 2) * s) };
}

/** Длительность анимации закрытия, мс */
export const CLOSE_MS = 420;

function esc(s: string) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]!));
}

/*
 * Субтитры. Распознаём речь из общего звука компьютера, но только пока Discord сообщает,
 * что собеседник говорит (плюс короткий хвост): так звуки игры почти не попадают в текст,
 * а процессор в паузах не занят.
 */
const SUBS_SCRIPT = String.raw`
const subsEl = document.getElementById("subs"), whoEl = subsEl.querySelector(".who"), txtEl = subsEl.querySelector(".txt");
let subsTimer = 0;
const subsHideIn = ms => { clearTimeout(subsTimer); subsTimer = setTimeout(() => subsEl.classList.remove("on"), ms); };
const sendLog = text => { document.title = "cybercall:log:" + encodeURIComponent(text) + ":" + Date.now(); };
const nice = text => { text = String(text || "").trim(); return text ? text[0].toUpperCase() + text.slice(1) : ""; };

window.cyberSubsStatus = (text, hold) => {
  whoEl.textContent = ""; txtEl.textContent = text;
  subsEl.className = "subs on status";
  clearTimeout(subsTimer);
  if (hold) subsHideIn(hold);
};
const caption = (text, final) => {
  text = nice(text);
  if (!text) return;
  whoEl.textContent = document.getElementById("name").textContent;
  txtEl.textContent = text;
  subsEl.className = "subs on";
  subsHideIn(final ? 6000 : 10000);
};
// мои слова уходят в моё окно (его показывает главный процесс)
const mineShow = (who, text, status, hold) => {
  document.title = "cybercall:mine:" + encodeURIComponent(JSON.stringify([who, text, !!status, hold || 0])) + ":" + Date.now();
};
const mineCaption = (text, final) => {
  text = nice(text);
  if (text) mineShow("@", text, false, final ? 6000 : 10000);
};
const mineStatus = (text, hold) => mineShow("", text, true, hold);
onSelfMuted = muted => { if (muted) mineStatus("Микрофон выключен — твоя речь не распознаётся", 4000); };

let sttModel = null;
window.cyberSubsInit = async cfg => {
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = cfg.engineUrl; s.onload = ok; s.onerror = () => fail(new Error("движок не загрузился"));
    document.head.appendChild(s);
  });
  // если модель не поднялась, движок может молчать вечно — поэтому ждём не дольше двух минут
  sttModel = await Promise.race([
    Vosk.createModel(cfg.modelUrl, -1),
    new Promise((_, fail) => setTimeout(() => fail(new Error("модель не загрузилась")), 120000))
  ]);
};

/*
 * Один слушатель = один поток звука со своим распознавателем.
 * signal() возвращает { on, ever, blocked }: говорит ли человек по данным Discord, приходил ли
 * этот сигнал хоть раз, и запрещено ли слушать (микрофон выключен). Если Discord сигнал ни разу
 * не прислал, ориентируемся на громкость.
 */
function makeListener(signal, show, stats) {
  let rec = null, recRate = 0, wasOpen = false, lastFlag = 0, lastSound = 0;
  return (samples, rate) => {
    if (!sttModel) return;
    const now = Date.now(), sig = signal();
    if (sig.on) lastFlag = now;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
    const level = Math.sqrt(sum / (samples.length / 4));
    stats.blocks++;
    if (level > stats.peak) stats.peak = level;
    if (level > 0.008) lastSound = now;
    const open = !sig.blocked && (now - lastFlag <= 800 || (!sig.ever && now - lastSound <= 800));
    if (!open) {
      // человек замолчал: дописываем тишину, чтобы распознаватель закончил фразу
      if (wasOpen && rec) rec.acceptWaveformFloat(new Float32Array(Math.round(rate)), rate);
      wasOpen = false;
      return;
    }
    if (!rec || recRate !== rate) {
      if (rec) rec.remove();
      rec = new sttModel.KaldiRecognizer(rate); recRate = rate;
      rec.on("partialresult", m => { if (m.result.partial) { stats.partials++; stats.loudSinceText = 0; } show(m.result.partial, false); });
      rec.on("result", m => { if (m.result.text) { stats.finals++; stats.loudSinceText = 0; } show(m.result.text, true); });
    }
    wasOpen = true;
    stats.fed++;
    stats.lvlSum += level; stats.lvlN++;
    // сторож: речь слышна давно, а распознаватель молчит — пересоздаём его
    if (level > 0.02) stats.loudSinceText++;
    if (stats.loudSinceText > 240) {
      stats.loudSinceText = 0; stats.restarts++;
      rec.remove(); rec = null; wasOpen = false;
      return;
    }
    rec.acceptWaveformFloat(samples, rate);
  };
}

// счётчики для журнала: по ним видно, где обрывается цепочка «звук → распознавание → текст»
const newStats = () => ({ blocks: 0, fed: 0, peak: 0, partials: 0, finals: 0, lvlSum: 0, lvlN: 0, loudSinceText: 0, restarts: 0 });
const sttStats = newStats(), mineStats = newStats();
window.cyberSubsFeed = makeListener(() => ({ on: speaking, ever: spokeEver, blocked: false }), caption, sttStats);
window.cyberMineFeed = makeListener(() => ({ on: selfSpeaking, ever: selfSpokeEver, blocked: selfMuted }), mineCaption, mineStats);

let sttLogged = "", sttLogs = 0;
// «громкость речи» — средний уровень звука в те моменты, когда он шёл в распознавание, за последние 10 секунд
const statLine = (title, st, ever) => {
  const lvl = st.lvlN ? (st.lvlSum / st.lvlN).toFixed(3) : "—";
  st.lvlSum = 0; st.lvlN = 0;
  return title + ": распознавалось=" + st.fed + "/" + st.blocks + " громкость речи=" + lvl + " сигнал Discord=" + ever
    + " текст=" + st.partials + "/" + st.finals + (st.restarts ? " перезапусков=" + st.restarts : "");
};
setInterval(() => {
  const line = statLine("звук", sttStats, spokeEver) + (mineStats.blocks ? " | " + statLine("микрофон", mineStats, selfSpokeEver) : "");
  if (!sttStats.blocks || line === sttLogged || sttLogs >= 18) return;
  sttLogged = line; sttLogs++;
  sendLog(line);
}, 10000);

async function captureSystemAudio() {
  let stream, firstError;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { firstError = e; }
  if (!stream || !stream.getAudioTracks().length) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop" } },
        video: { mandatory: { chromeMediaSource: "desktop" } }
      });
    } catch (e) { throw firstError || e; }
  }
  stream.getVideoTracks().forEach(t => t.stop());
  if (!stream.getAudioTracks().length) throw new Error("система не отдала звук");
  return stream;
}

// Микрофон: берём тот же, что выбран в Discord (ищем по названию), иначе системный по умолчанию
async function captureMic(micLabel) {
  const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: opts });
  const current = stream.getAudioTracks()[0].label;
  if (micLabel && !current.includes(micLabel)) {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.label.includes(micLabel));
    const wanted = devices.find(d => d.deviceId !== "default" && d.deviceId !== "communications") || devices[0];
    if (wanted) {
      stream.getTracks().forEach(t => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...opts, deviceId: { exact: wanted.deviceId } } });
    }
  }
  return stream;
}

function pipe(ctx, stream, feed) {
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 2, 1), mute = ctx.createGain();
  mute.gain.value = 0; // слушаем, но обратно в колонки ничего не отдаём
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  proc.onaudioprocess = e => {
    const b = e.inputBuffer, l = b.getChannelData(0), mono = new Float32Array(l.length);
    if (b.numberOfChannels > 1) { const r = b.getChannelData(1); for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2; }
    else mono.set(l);
    feed(mono, ctx.sampleRate);
  };
  return [src, proc, mute];
}

const withTimeout = (promise, ms, text) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(text)), ms))]);
const cleanLabel = label => String(label || "").replace(/^(Default|Communications|По умолчанию|Связь)\s*-\s*/i, "");

/*
 * Откуда брать голос собеседника. Обычно это «звук компьютера» — то, что играет устройство
 * вывода по умолчанию. Но с виртуальным микшером (Voicemeeter и подобные) Discord может
 * выводить звук в другое устройство, и тогда там тишина. Поэтому в начале звонка слушаем сразу
 * несколько источников и оставляем тот, где громко именно тогда, когда Discord показывает,
 * что собеседник говорит.
 */
const SRC_KEY = "cybercall-source";
let remoteSources = [], activeSource = null, sourceDecided = false;

function addSource(ctx, label, stream) {
  const src = { label, stream, on: 0, onN: 0, off: 0, offN: 0, nodes: null };
  src.nodes = pipe(ctx, stream, (mono, rate) => {
    if (!sourceDecided) {
      let sum = 0;
      for (let i = 0; i < mono.length; i += 4) sum += mono[i] * mono[i];
      const level = Math.sqrt(sum / (mono.length / 4));
      if (speaking && !selfSpeaking) { src.on += level; src.onN++; }
      else if (!speaking) { src.off += level; src.offN++; }
    }
    if (src === activeSource) cyberSubsFeed(mono, rate);
  });
  remoteSources.push(src);
  return src;
}

function dropSource(src) {
  src.stream.getTracks().forEach(t => t.stop());
  src.nodes.forEach(n => { try { n.disconnect(); } catch {} });
  src.nodes[1].onaudioprocess = null;
}

function decideSource() {
  if (sourceDecided || !activeSource) return;
  // ждём несколько секунд речи собеседника и несколько секунд пауз: источник, где одинаково
  // громко и в речи, и в паузах (музыка, игра), — не голос
  const onN = Math.max(...remoteSources.map(s => s.onN)), offN = Math.max(...remoteSources.map(s => s.offN));
  if (onN < 45) return;
  const longWait = onN >= 400; // собеседник говорит без пауз — решаем по тому, что есть
  if (offN < 20 && !longWait) return;
  const mean = (sum, n) => n ? sum / n : 0;
  const scored = remoteSources.map(s => ({ s, on: mean(s.on, s.onN), off: mean(s.off, s.offN) }));
  const cur = scored.find(x => x.s === activeSource);
  const candidates = offN >= 20
    ? scored.filter(x => x.on > 0.008 && x.on > x.off * 1.5)
    : (cur.on < 0.004 ? scored.filter(x => x.on > 0.008) : []);
  const best = candidates.sort((a, b) => (b.on - b.off) - (a.on - a.off))[0];
  if (best && best.s !== activeSource && best.on - best.off > (cur.on - cur.off) * 2.5) activeSource = best.s;
  sourceDecided = true;
  try { localStorage.setItem(SRC_KEY, activeSource.label); } catch {}
  sendLog("источник голоса собеседника: " + activeSource.label + " | "
    + scored.map(x => x.s.label + " речь=" + x.on.toFixed(3) + " пауза=" + x.off.toFixed(3)).join("; "));
  remoteSources.filter(s => s !== activeSource).forEach(dropSource);
  remoteSources = [activeSource];
}

window.cyberSubsStart = async cfg => {
  let ctx = null, micLabel = "";
  try {
    cyberSubsStatus("Запуск распознавания речи…");
    await cyberSubsInit(cfg);
    ctx = new AudioContext();
  } catch (e) {
    const text = "Субтитры не запустились: " + (e && e.message || e);
    cyberSubsStatus(text, 20000);
    sendLog(text + (e && e.name ? " [" + e.name + "]" : ""));
    return;
  }

  // 1. Мой микрофон (заодно после этого система отдаёт названия устройств)
  if (cfg.own) {
    try {
      const mic = await withTimeout(captureMic(cfg.micLabel), 15000, "микрофон не ответил");
      micLabel = cleanLabel(mic.getAudioTracks()[0].label);
      pipe(ctx, mic, cyberMineFeed);
      mineStatus("Твои субтитры включены", 2500);
      sendLog("мои субтитры включены, микрофон: " + micLabel);
    } catch (e) {
      mineStatus("Микрофон недоступен: " + (e && e.message || e), 20000);
      sendLog("мои субтитры не запустились: " + (e && e.message || e) + (e && e.name ? " [" + e.name + "]" : ""));
    }
  }

  // 2. Голос собеседника: звук компьютера и остальные устройства записи
  let firstError = null;
  try {
    addSource(ctx, "звук компьютера", await withTimeout(captureSystemAudio(), 15000, "система не ответила на запрос звука"));
  } catch (e) { firstError = e; sendLog("звук компьютера недоступен: " + (e && e.message || e) + (e && e.name ? " [" + e.name + "]" : "")); }
  try {
    const seen = new Set([micLabel]);
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
    for (const d of inputs) {
      const label = cleanLabel(d.label);
      if (!label || seen.has(label) || remoteSources.length >= 10) continue;
      seen.add(label);
      try {
        addSource(ctx, label, await withTimeout(navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        }), 5000, "нет ответа"));
      } catch {}
    }
  } catch {}

  if (!remoteSources.length) {
    const text = "Субтитры собеседника не запустились: " + (firstError && firstError.message || "нет источников звука");
    cyberSubsStatus(text, 20000);
    sendLog(text);
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem(SRC_KEY); } catch {}
  activeSource = remoteSources.find(s => s.label === saved) || remoteSources[0];
  if (ctx.state === "suspended") await ctx.resume();
  cyberSubsStatus("Субтитры включены", 2500);
  sendLog("субтитры включены, частота " + ctx.sampleRate + ", слушаю: " + activeSource.label + ", всего источников: " + remoteSources.length);
  const decider = setInterval(() => { decideSource(); if (sourceDecided) clearInterval(decider); }, 2000);
};
`;

export function buildOverlayHtml(d: OverlayData) {
    const out = d.mode === "out";
    const talk = d.mode === "talk";
    const big = d.layout === "big";
    const t = resolveTheme(d.theme, d.accent);
    const me = d.view === "me" && d.me ? d.me : null;
    const avatarHtml = (url: string) => `<div class="ava">
        <img class="base" src="${esc(url)}" alt="">
        <img class="gr" src="${esc(url)}" alt="">
        <img class="gc" src="${esc(url)}" alt="">
        <img class="slice" src="${esc(url)}" alt="">
        <div class="tint"></div><div class="lines"></div><div class="boot"></div>
      </div>`;
    const name = esc(d.name);
    const bars = Array.from({ length: out ? 16 : 22 }, (_, i) =>
        `<i style="animation-delay:${out ? i * 90 - 1500 : -((i * 137) % 900)}ms"></i>`).join("");

    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src blob: data:; style-src 'unsafe-inline'; ${d.subs
            ? "script-src 'unsafe-inline' 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:"
            : "script-src 'unsafe-inline'"}">
<title>cybercall</title>
<style>
:root{
  --y:${t.accent}; --c:${t.second}; --r:${t.danger}; --bg:rgba(8,10,14,.93);
  --y-rgb:${rgbTriplet(t.accent)}; --c-rgb:${rgbTriplet(t.second)}; --on-y:${onColor(t.accent)}; --on-r:${onColor(t.danger)};
  --font:"Bahnschrift","Segoe UI Semibold","Segoe UI","DejaVu Sans",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;font-family:var(--font)}
body{display:flex;flex-direction:column;align-items:flex-start;gap:${GAP}px;padding:${PAD}px;zoom:${clampScale(d.scale)}}
.col{flex:none;display:flex;flex-direction:column;gap:${GAP}px}
.panel{cursor:grab}
body.dragging .panel,body.dragging button{cursor:grabbing}

/* ---------- каркас ---------- */
.wrap{position:relative;width:520px;height:176px;filter:drop-shadow(0 0 10px rgb(var(--c-rgb) / .22))}
.panel{
  position:absolute;inset:0;background:var(--bg);
  clip-path:polygon(0 0,calc(100% - 26px) 0,100% 26px,100% 100%,22px 100%,0 calc(100% - 22px));
  animation:open .55s cubic-bezier(.2,.9,.2,1) both, flick .5s steps(1) both;
}
.panel::before{ /* рамка */
  content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,var(--y),var(--c));
  clip-path:polygon(0 0,calc(100% - 26px) 0,100% 26px,100% 100%,22px 100%,0 calc(100% - 22px),
    0 0,2px 2px,2px calc(100% - 23px),23px calc(100% - 2px),calc(100% - 2px) calc(100% - 2px),
    calc(100% - 2px) 27px,calc(100% - 27px) 2px,2px 2px);
  opacity:.9;
}
.panel::after{ /* сканлайны */
  content:"";position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 3px);
}
.sweep{position:absolute;left:0;right:0;height:38px;top:-40px;pointer-events:none;
  background:linear-gradient(180deg,transparent,rgb(var(--c-rgb) / .13),transparent);
  animation:sweep 2.6s linear infinite .6s}
.tag{position:absolute;right:34px;top:7px;font-size:9px;letter-spacing:.22em;color:rgb(var(--c-rgb) / .55)}
.corner{position:absolute;left:0;top:0;width:64px;height:5px;background:var(--y)}

.content{position:absolute;inset:0;display:flex;gap:18px;padding:20px 22px 18px 22px;
  animation:content .5s ease-out .28s both}

/* ---------- аватар ---------- */
.ava{position:relative;flex:none;width:112px;height:136px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%);
  background:#05070a;outline:1px solid var(--c)}
.ava::after{content:"";position:absolute;inset:0;border:1px solid var(--c);pointer-events:none;transition:border-color .15s}
.ava img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ava .base{filter:saturate(.75) contrast(1.15) brightness(.95)}
.ava .tint{position:absolute;inset:0;background:linear-gradient(180deg,rgb(var(--c-rgb) / .28),rgb(var(--c-rgb) / .08));mix-blend-mode:screen}
.ava .gr{mix-blend-mode:screen;opacity:0;filter:saturate(3) hue-rotate(-35deg);animation:splitR 3.1s steps(1) infinite}
.ava .gc{mix-blend-mode:screen;opacity:0;filter:saturate(3) hue-rotate(150deg);animation:splitC 3.1s steps(1) infinite}
.ava .slice{animation:slice 3.1s steps(1) infinite;opacity:0}
.ava .lines{position:absolute;inset:0;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.42) 0 1px,transparent 1px 3px);animation:roll 1s linear infinite}
.ava .boot{position:absolute;inset:0;background:var(--c);animation:boot .6s steps(6) .25s both}

/* ---------- текст ---------- */
.info{flex:1;min-width:0;display:flex;flex-direction:column}
.label{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.26em;color:var(--y)}
.label b{width:8px;height:8px;background:var(--r);box-shadow:0 0 8px var(--r);animation:blink 1s steps(2) infinite}
.name{position:relative;margin-top:6px;font-size:30px;line-height:36px;font-weight:700;letter-spacing:.03em;
  color:#f4f7fa;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 0 12px rgb(var(--c-rgb) / .45)}
.name::before,.name::after{content:attr(data-t);position:absolute;left:0;top:0;width:100%;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis;opacity:0}
.name::before{color:var(--r);animation:txtR 2.7s steps(1) infinite}
.name::after{color:var(--c);animation:txtC 2.7s steps(1) infinite}
.sub{font-size:12px;letter-spacing:.12em;color:rgb(var(--c-rgb) / .8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.wave{display:flex;align-items:center;gap:3px;height:20px;margin-top:8px}
.wave i{width:3px;height:100%;background:var(--c);transform-origin:center;animation:wave .9s ease-in-out infinite;opacity:.85}

/* ---------- кнопки ---------- */
.btns{display:flex;gap:10px;margin-top:auto}
button{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;height:30px;padding:0 14px 0 6px;
  font:700 12px var(--font);letter-spacing:.14em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%);
  transition:filter .12s, transform .12s}
button kbd{font:700 11px var(--font);min-width:24px;height:20px;padding:0 5px;display:grid;place-items:center;
  background:rgba(0,0,0,.82)}
button:hover{filter:brightness(1.25)}
button:active{transform:translateY(1px)}
.acc{background:var(--y);color:var(--on-y)}
.acc kbd{background:var(--on-y)}
.acc kbd{color:var(--y)}
.dec{background:var(--r);color:var(--on-r)}
.dec kbd{color:#ff8298}
.acc{animation:pulse 1.4s ease-in-out infinite}

/* ---------- крупный вид: карточка с большой аватаркой ---------- */
.big .wrap{width:320px;height:470px}
.big .content{flex-direction:column;gap:14px;padding:22px 22px 20px 22px}
.big .ava{width:100%;height:252px;clip-path:polygon(0 0,100% 0,100% calc(100% - 24px),calc(100% - 24px) 100%,0 100%)}
.big .info{flex:1;width:100%}
.big .name{font-size:26px;line-height:32px;margin-top:4px}
.big .wave{margin-top:10px;justify-content:space-between}
.big .btns{gap:8px}
.big .btns button{flex:1;justify-content:center;padding:0 8px 0 6px;font-size:11px;letter-spacing:.08em;height:32px}
.big .tag{top:8px}

/* ---------- исходящий вызов ---------- */
.mode-out .label{color:var(--c)}
.mode-out .label b{background:var(--y);box-shadow:0 0 8px var(--y)}
.mode-out .corner{background:var(--c)}
.mode-out .panel::before{background:linear-gradient(90deg,var(--c),var(--y))}
.mode-out .wave{gap:4px}
.mode-out .wave i{width:9px;height:4px;opacity:.18;animation:dial 1.5s linear infinite}
.dots{margin-left:-8px}
.dots i{font-style:normal;animation:dots 1.2s steps(1) infinite}
.dots i:nth-child(2){animation-delay:.3s}
.dots i:nth-child(3){animation-delay:.6s}
@keyframes dial{0%{opacity:1;background:var(--y)}18%{opacity:.9;background:var(--c)}45%,100%{opacity:.18;background:var(--c)}}
@keyframes dots{0%{opacity:0}35%,100%{opacity:1}}

/* ---------- разговор ----------
   Панель висит весь звонок, поэтому в покое ничего не анимируется и не грузит видеокарту.
   Движение включается только пока собеседник говорит. */
.mode-talk .sweep{display:none}
.mode-talk .label{color:var(--c)}
.mode-talk .label b{background:#39ff88;box-shadow:0 0 8px #39ff88;animation:none}
.mode-talk .timer{margin-left:auto;color:#f4f7fa;letter-spacing:.12em}
.mode-talk .ava .lines,.mode-talk .ava .gr,.mode-talk .ava .gc,.mode-talk .ava .slice,
.mode-talk .name::before,.mode-talk .name::after{animation:none}
.mode-talk .wave i{animation:none;transform:scaleY(.14);opacity:.4}
.mode-talk .ava{transition:outline-color .15s, box-shadow .15s}
.mode-talk .wrap.speaking .ava::after{border:3px solid var(--y)}
.mode-talk .wrap.speaking .ava{animation:talk .62s ease-in-out infinite}
.mode-talk .wrap.speaking .ava .base{animation:talkImg .62s ease-in-out infinite}
.mode-talk .wrap.speaking .ava .gr{animation:splitR 1.4s steps(1) infinite}
.mode-talk .wrap.speaking .ava .gc{animation:splitC 1.4s steps(1) infinite}
.mode-talk .wrap.speaking .ava .lines{animation:roll 1s linear infinite}
.mode-talk .wrap.speaking .wave i{animation:wave .9s ease-in-out infinite;opacity:.9;background:var(--y)}
.mode-talk .wrap.speaking .name{text-shadow:0 0 14px rgb(var(--y-rgb) / .5)}
.ghost{background:transparent;color:rgb(var(--c-rgb) / .85);outline:1px solid rgb(var(--c-rgb) / .5);outline-offset:-1px;padding:0 12px}
@keyframes talk{0%,100%{transform:translateY(0) scale(1)}30%{transform:translateY(-3px) scale(1.035)}65%{transform:translateY(1px) scale(.99)}}
@keyframes talkImg{0%,100%{transform:scale(1.02)}50%{transform:scale(1.09)}}

/* ---------- субтитры ---------- */
.subs{flex:none;width:520px;height:${SUBS_HEIGHT.compact}px;padding:6px 12px 7px;overflow:hidden;
  display:flex;flex-direction:column;justify-content:flex-end;
  background:rgba(8,10,14,.84);border-left:3px solid var(--y);
  font-size:15px;line-height:18px;font-weight:600;color:#f4f7fa;text-shadow:0 1px 2px #000;
  opacity:0;transition:opacity .35s}
.big .subs{width:320px;height:${SUBS_HEIGHT.big}px}
.subs.on{opacity:1}
.subs .who{color:var(--y);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-right:7px}
.subs.status{font-size:12px;letter-spacing:.08em;font-weight:400;color:rgb(var(--c-rgb) / .9);border-left-color:var(--c)}
body.out .subs{opacity:0;transition:opacity .12s}

/* ---------- моё окно: та же панель, но про меня ---------- */
.wrap.me .label b{background:#39ff88;box-shadow:0 0 8px #39ff88}
.wrap.me.muted .label{color:var(--r)}
.wrap.me.muted .label b{background:var(--r);box-shadow:0 0 8px var(--r)}
.wrap.me.muted .ava .base{filter:grayscale(1) brightness(.55)}
.wrap.me .on-muted,.wrap.me.muted .on-live{display:none}
.wrap.me.muted .on-muted{display:inline}

/* ---------- закрытие ---------- */
body.out .panel{animation:close ${CLOSE_MS}ms cubic-bezier(.7,0,.8,.2) both}
body.out .content{animation:contentOut .16s steps(3) both}
body.ok .panel::before{background:var(--y)}
body.no .panel::before{background:var(--r)}

@keyframes open{0%{transform:scaleY(.012) scaleX(0)}45%{transform:scaleY(.012) scaleX(1)}100%{transform:none}}
@keyframes close{0%{transform:none}55%{transform:scaleY(.012) scaleX(1)}100%{transform:scaleY(.012) scaleX(0)}}
@keyframes flick{0%{opacity:0}8%{opacity:1}16%{opacity:.25}24%{opacity:1}52%{opacity:.55}60%,100%{opacity:1}}
@keyframes content{0%{opacity:0;transform:translateX(-14px);filter:blur(3px)}60%{opacity:1}100%{opacity:1;transform:none;filter:none}}
@keyframes contentOut{to{opacity:0;transform:translateX(10px)}}
@keyframes sweep{to{top:110%}}
@keyframes blink{50%{opacity:.15}}
@keyframes roll{to{background-position:0 3px}}
@keyframes boot{0%{opacity:1}40%{opacity:.75}60%{opacity:.2}80%{opacity:.5}100%{opacity:0}}
@keyframes wave{0%,100%{transform:scaleY(.18)}50%{transform:scaleY(1)}}
@keyframes pulse{50%{box-shadow:0 0 0 0 transparent;filter:brightness(1.22)}}
@keyframes splitR{0%,100%{opacity:0;transform:none}
  62%{opacity:.75;transform:translate(5px,0)}64%{opacity:.75;transform:translate(-4px,1px)}66%{opacity:0}
  88%{opacity:.7;transform:translate(3px,-1px)}90%{opacity:0}}
@keyframes splitC{0%,100%{opacity:0;transform:none}
  62%{opacity:.75;transform:translate(-5px,0)}64%{opacity:.75;transform:translate(4px,-1px)}66%{opacity:0}
  88%{opacity:.7;transform:translate(-3px,1px)}90%{opacity:0}}
@keyframes slice{0%,100%{opacity:0}
  30%{opacity:1;clip-path:inset(22% 0 62% 0);transform:translateX(9px)}
  32%{opacity:1;clip-path:inset(58% 0 24% 0);transform:translateX(-11px)}
  34%{opacity:0}
  63%{opacity:1;clip-path:inset(40% 0 44% 0);transform:translateX(13px)}
  65%{opacity:1;clip-path:inset(8% 0 80% 0);transform:translateX(-7px)}
  67%{opacity:0}}
@keyframes txtR{0%,100%{opacity:0}
  41%{opacity:.9;transform:translate(3px,0);clip-path:inset(0 0 55% 0)}
  43%{opacity:.9;transform:translate(-3px,0);clip-path:inset(50% 0 0 0)}45%{opacity:0}
  79%{opacity:.9;transform:translate(2px,0);clip-path:inset(30% 0 30% 0)}81%{opacity:0}}
@keyframes txtC{0%,100%{opacity:0}
  41%{opacity:.9;transform:translate(-3px,0);clip-path:inset(45% 0 0 0)}
  43%{opacity:.9;transform:translate(3px,0);clip-path:inset(0 0 50% 0)}45%{opacity:0}
  79%{opacity:.9;transform:translate(-2px,0);clip-path:inset(0 0 65% 0)}81%{opacity:0}}
</style></head>
<body class="mode-${esc(d.mode)}${big ? " big" : ""}">
${me ? `<div class="col">
<div class="wrap me" id="wMe">
  <div class="panel">
    <div class="corner"></div>
    <div class="tag">HOLO // SELF</div>
    <div class="content">
      ${avatarHtml(me.avatar)}
      <div class="info">
        <div class="label"><b></b><span class="on-live">ЭТО ТЫ</span><span class="on-muted">МИКРОФОН ВЫКЛЮЧЕН</span></div>
        <div class="name" id="myName" data-t="${esc(me.name)}">${esc(me.name)}</div>
        <div class="sub">${esc(me.sub)}</div>
        <div class="wave">${bars}</div>
        <div class="btns">
          <button class="ghost" data-a="mic"><span class="on-live">ВЫКЛЮЧИТЬ МИКРОФОН</span><span class="on-muted">ВКЛЮЧИТЬ МИКРОФОН</span></button>
        </div>
      </div>
    </div>
  </div>
</div>
${d.subs ? '<div class="subs" id="mine"><div><span class="who"></span><span class="txt"></span></div></div>' : ""}
</div>` : `<div class="col">
<div class="wrap" id="wOther">
  <div class="panel">
    <div class="corner"></div>
    <div class="tag">${out ? "HOLO // DIAL" : talk ? "HOLO // LIVE" : "HOLO // LINK"}</div>
    <div class="sweep"></div>
    <div class="content">
      ${avatarHtml(d.avatar)}
      <div class="info">
        <div class="label"><b></b>${out ? 'ИСХОДЯЩИЙ ВЫЗОВ<span class="dots"><i>.</i><i>.</i><i>.</i></span>' : talk ? 'НА СВЯЗИ<span class="timer" id="timer">00:00</span>' : "ВХОДЯЩИЙ ВЫЗОВ"}</div>
        <div class="name" id="name" data-t="${name}">${name}</div>
        <div class="sub" id="sub">${esc(d.sub)}</div>
        <div class="wave">${bars}</div>
        <div class="btns">
          ${talk ? `<button class="dec" data-a="decline" style="padding-left:14px">ЗАВЕРШИТЬ</button>
          <button class="ghost" data-a="dismiss">СКРЫТЬ</button>` : `
          ${out ? "" : `<button class="acc" data-a="accept"><kbd>${esc(d.acceptKey)}</kbd>ПРИНЯТЬ</button>`}
          <button class="dec" data-a="decline"><kbd>${esc(d.declineKey)}</kbd>${out ? "СБРОСИТЬ" : "ОТКЛОНИТЬ"}</button>`}
        </div>
      </div>
    </div>
  </div>
</div>
${d.subs ? '<div class="subs" id="subs"><div><span class="who"></span><span class="txt"></span></div></div>' : ""}
</div>`}
<script>
// Клик по кнопке передаётся в главный процесс через заголовок окна.
document.querySelectorAll("button").forEach(b =>
  b.addEventListener("click", () => { document.title = "cybercall:" + b.dataset.a + ":" + Date.now(); }));

// Разговор: собеседник говорит / сменился говорящий (в групповом звонке)
let speaking = false, lastVoice = 0, spokeEver = false;
window.cyberSpeak = on => {
  speaking = !!on;
  if (speaking) { lastVoice = Date.now(); spokeEver = true; }
  const w = document.getElementById("wOther");
  if (w) w.classList.toggle("speaking", speaking);
};
// Ctrl + колесо мыши над окном меняет его размер (считает и запоминает главный процесс)
let wheelAt = 0;
window.addEventListener("wheel", e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const now = Date.now();
  if (now - wheelAt < 40) return;
  wheelAt = now;
  document.title = "cybercall:zoom:" + (e.deltaY < 0 ? "in" : "out") + ":" + now;
}, { passive: false });
window.cyberZoom = scale => { document.body.style.zoom = scale; };
// Моё окно: текст моей речи приходит из окна звонка, где работает распознавание
let myCapTimer = 0;
window.cyberMineShow = (who, text, status, hold) => {
  const el = document.getElementById("mine");
  if (!el) return;
  el.querySelector(".who").textContent = who === "@" ? document.getElementById("myName").textContent : who;
  el.querySelector(".txt").textContent = text;
  el.className = "subs" + (text ? " on" : "") + (status ? " status" : "");
  clearTimeout(myCapTimer);
  if (hold) myCapTimer = setTimeout(() => el.classList.remove("on"), hold);
};
// Моё окно: сигналы «я говорю» и «я выключил микрофон» от Discord
const wMe = document.getElementById("wMe");
let selfSpeaking = false, selfSpokeEver = false, selfMuted = false, onSelfMuted = null;
window.cyberSelfSpeak = on => {
  selfSpeaking = !!on;
  if (selfSpeaking) selfSpokeEver = true;
  if (wMe) wMe.classList.toggle("speaking", selfSpeaking && !selfMuted);
};
window.cyberSelfMuted = on => {
  selfMuted = !!on;
  if (wMe) { wMe.classList.toggle("muted", selfMuted); if (selfMuted) wMe.classList.remove("speaking"); }
  if (onSelfMuted) onSelfMuted(selfMuted);
};
window.cyberUser = (name, sub, avatar) => {
  const n = document.getElementById("name");
  n.textContent = name; n.dataset.t = name;
  document.getElementById("sub").textContent = sub;
  document.querySelectorAll("#wOther .ava img").forEach(i => { if (i.src !== avatar) i.src = avatar; });
};
const timer = document.getElementById("timer");
if (timer) {
  const t0 = ${Number(d.startedAt) || 0} || Date.now();
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - t0) / 1000)), p = v => String(v).padStart(2, "0");
    timer.textContent = (s >= 3600 ? p(Math.floor(s / 3600)) + ":" : "") + p(Math.floor(s / 60) % 60) + ":" + p(s % 60);
  };
  tick(); setInterval(tick, 1000);
}

// Перетаскивание: страница только сообщает о начале и конце, окно двигает главный процесс.
let dragging = false;
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove("dragging");
  document.title = "cybercall:dragend:" + Date.now();
};
document.querySelectorAll(".panel").forEach(panel => {
  panel.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("button")) return;
    dragging = true;
    document.body.classList.add("dragging");
    try { panel.setPointerCapture(e.pointerId); } catch {}
    document.title = "cybercall:dragstart:" + Date.now();
  });
  panel.addEventListener("pointerup", endDrag);
  panel.addEventListener("pointercancel", endDrag);
  panel.addEventListener("lostpointercapture", endDrag);
});

${d.subs && !me ? SUBS_SCRIPT : ""}
let audio = null;
window.cyberClose = kind => {
  document.body.classList.add("out", kind === "accept" ? "ok" : kind === "decline" ? "no" : "x");
  if (audio) { audio.pause(); audio = null; }
};
window.cyberRing = (b64, mime, volume) => {
  const bin = atob(b64), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  audio = new Audio(URL.createObjectURL(new Blob([buf], { type: mime })));
  audio.loop = true; audio.volume = volume; audio.play().catch(() => {});
};
</script>
</body></html>`;
}

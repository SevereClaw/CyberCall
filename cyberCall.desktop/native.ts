/*
 * CyberCall — часть, работающая в главном процессе Discord.
 * Открывает маленькое прозрачное окно поверх всех окон и ловит горячие клавиши.
 * Окно существует только пока идёт звонок, в остальное время плагин ничего не держит в памяти.
 */

import { BrowserWindow, globalShortcut, IpcMainInvokeEvent, net, screen, WebContents } from "electron";
import { randomBytes } from "crypto";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";

import defaultRingtone from "file://ringtone.mp3?base64";

import { buildOverlayHtml, clampScale, CLOSE_MS, overlaySize } from "./overlay";
import { prepareStt, startSttServer, STT_PARTITION, sttLang, SttServer, sttSession } from "./stt";
import { RELEASE_URL, runUpdate } from "./updater";

export interface ShowOptions {
    name: string;
    sub: string;
    avatar: string;
    mode: "in" | "out" | "talk";
    startedAt?: number;
    acceptKey: string;
    declineKey: string;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "custom";
    /** сохранённое место панели, если её перетаскивали */
    posX?: number;
    posY?: number;
    layout: "compact" | "big";
    /** масштаб в процентах */
    scale: number;
    theme: string;
    accent: string;
    /** субтитры речи собеседника в панели разговора */
    subtitles: boolean;
    subtitleLang: string;
    /** моё окно: вторая панель с моим ником и аватаркой */
    ownCaptions: boolean;
    selfName: string;
    selfSub: string;
    selfAvatar: string;
    selfMuted: boolean;
    /** название микрофона, выбранного в Discord */
    micLabel: string;
    /** моё окно: свой размер (в процентах) и своё место, если его перетаскивали */
    meScale: number;
    meCustom: boolean;
    mePosX?: number;
    mePosY?: number;
    /** на каком мониторе показывать, если панель стоит в углу */
    monitor: string;
    ringtonePath: string;
    ringtoneVolume: number;
    /** играть рингтон и на исходящем вызове */
    ringtoneOutgoing: boolean;
}

type Action = "accept" | "decline" | "dismiss" | "mic";

const MAX_RINGTONE_BYTES = 15 * 1024 * 1024;
const MIME: Record<string, string> = {
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".opus": "audio/ogg", ".webm": "audio/webm"
};

type Which = "call" | "me";

/** окно звонка (панель собеседника) и отдельное окно с моей панелью */
let win: BrowserWindow | null = null;
let meWin: BrowserWindow | null = null;
/** что нужно знать об окне, чтобы менять его размер колесом мыши */
const info = new WeakMap<BrowserWindow, { which: Which; layout: "compact" | "big"; subs: boolean; scale: number; }>();
let owner: WebContents | null = null;
let keys: string[] = [];

/** Пишет строку в журнал плагина (его можно скопировать из настроек). */
function log(text: string) {
    if (!owner || owner.isDestroyed()) return;
    owner.executeJavaScript(`Vencord.Plugins.plugins.CyberCall.onNativeLog(${JSON.stringify(String(text).slice(0, 600))})`).catch(() => { });
}

function notify(action: Action) {
    if (!owner || owner.isDestroyed()) return;
    owner.executeJavaScript(`Vencord.Plugins.plugins.CyberCall.onOverlayAction(${JSON.stringify(action)})`).catch(() => { });
}

function releaseKeys() {
    for (const k of keys) {
        try { globalShortcut.unregister(k); } catch { }
    }
    keys = [];
}

function grabKey(key: string, action: Action) {
    key = key?.trim();
    if (!key) return;
    try {
        if (globalShortcut.register(key, () => notify(action))) keys.push(key);
    } catch {
        // неверное название клавиши — просто работаем без неё
    }
}

/** Монитор для панели в углу: основной, тот, где курсор, или по номеру слева направо. */
function pickDisplay(monitor: string) {
    if (monitor === "cursor") return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const index = Number(monitor);
    if (Number.isInteger(index) && index >= 1) {
        const all = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
        if (all[index - 1]) return all[index - 1];
    }
    return screen.getPrimaryDisplay();
}

/** Не даёт панели уехать за пределы экрана (например, если отключили монитор). */
function fitToScreen(x: number, y: number, width: number, height: number) {
    const b = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) }).bounds;
    return {
        x: Math.round(Math.min(Math.max(x, b.x), b.x + Math.max(0, b.width - width))),
        y: Math.round(Math.min(Math.max(y, b.y), b.y + Math.max(0, b.height - height)))
    };
}

let drag: { timer: ReturnType<typeof setInterval>; w: BrowserWindow; started: number; } | null = null;

function stopDrag(save: boolean) {
    const d = drag;
    if (!d) return;
    drag = null;
    clearInterval(d.timer);
    if (!save || d.w.isDestroyed()) return;

    const { width, height } = d.w.getBounds();
    const [wx, wy] = d.w.getPosition();
    const { x, y } = fitToScreen(wx, wy, width, height);
    d.w.setBounds({ x, y, width, height });
    const which = info.get(d.w)?.which ?? "call";
    if (owner && !owner.isDestroyed())
        owner.executeJavaScript(`Vencord.Plugins.plugins.CyberCall.onOverlayMoved(${JSON.stringify(which)},${x},${y})`).catch(() => { });
}

/** Ctrl + колесо: меняем размер окна, левый верхний угол остаётся на месте. */
function zoom(w: BrowserWindow, direction: "in" | "out") {
    const i = info.get(w);
    if (!i || w.isDestroyed()) return;
    const scale = clampScale(Math.round((i.scale + (direction === "in" ? 0.05 : -0.05)) * 100) / 100);
    if (scale === i.scale) return;
    i.scale = scale;

    const { x, y } = w.getBounds();
    const { width, height } = overlaySize(i.layout, scale, i.subs);
    const pos = fitToScreen(x, y, width, height);
    w.setBounds({ ...pos, width, height });
    w.webContents.executeJavaScript(`cyberZoom(${scale})`).catch(() => { });
    if (owner && !owner.isDestroyed())
        owner.executeJavaScript(`Vencord.Plugins.plugins.CyberCall.onOverlayScaled(${JSON.stringify(i.which)},${Math.round(scale * 100)})`).catch(() => { });
}

function createWindow(bounds: { x: number; y: number; width: number; height: number; }, partition?: string) {
    const w = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: false, // не отбирает фокус у игры
        alwaysOnTop: true,
        show: false,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            autoplayPolicy: "no-user-gesture-required",
            ...(partition ? { partition } : {})
        }
    });
    w.setAlwaysOnTop(true, "screen-saver");
    w.setMenu(null);

    // Оверлей никуда не переходит и не открывает окна
    w.webContents.on("will-navigate", ev => ev.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // Страница общается с главным процессом через заголовок окна
    w.webContents.on("page-title-updated", (ev, title) => {
        ev.preventDefault();
        if (title.startsWith("cybercall:log:")) {
            try { log("панель: " + decodeURIComponent(title.slice(14).replace(/:\d+$/, ""))); } catch { }
            return;
        }
        if (title.startsWith("cybercall:mine:")) {
            // текст моей речи из окна звонка — в моё окно
            try {
                const [who, text, status, hold] = JSON.parse(decodeURIComponent(title.slice(15).replace(/:\d+$/, "")));
                if (meWin && !meWin.isDestroyed())
                    meWin.webContents.executeJavaScript(`cyberMineShow(${JSON.stringify(String(who))},${JSON.stringify(String(text))},${status ? "true" : "false"},${Number(hold) || 0})`).catch(() => { });
            } catch { }
            return;
        }
        const m = /^cybercall:(accept|decline|dismiss|mic|dragstart|dragend|zoom):(in|out)?/.exec(title);
        if (!m) return;
        if (m[1] === "dragstart") startDrag(w);
        else if (m[1] === "dragend") stopDrag(true);
        else if (m[1] === "zoom") zoom(w, m[2] === "in" ? "in" : "out");
        else notify(m[1] as Action);
    });
    return w;
}

function startDrag(w: BrowserWindow) {
    stopDrag(false);
    const from = screen.getCursorScreenPoint();
    const { x, y, width, height } = w.getBounds();
    const timer = setInterval(() => {
        // страховка: если отпускание мыши потерялось, не таскаем окно вечно
        if (w.isDestroyed() || !drag || Date.now() - drag.started > 60_000) return stopDrag(!w.isDestroyed());
        const p = screen.getCursorScreenPoint();
        // размер задаём каждый раз заново: на экранах с масштабом окно иначе «ползёт»
        w.setBounds({ x: x + p.x - from.x, y: y + p.y - from.y, width, height });
    }, 16);
    drag = { timer, w, started: Date.now() };
}

function destroy(w: BrowserWindow | null) {
    if (drag?.w === w) stopDrag(false);
    if (w && !w.isDestroyed()) w.destroy();
}

export async function showCall(e: IpcMainInvokeEvent, o: ShowOptions) {
    owner = e.sender;
    try {
        await openCall(o);
    } catch (err) {
        log("окно не открылось: " + String((err as Error)?.message ?? err));
        throw err;
    }
}

async function openCall(o: ShowOptions) {
    destroy(win);
    destroy(meWin);
    meWin = null;
    releaseKeys();

    const subs = o.mode === "talk" && !!o.subtitles;
    if (subs) sttSession();
    const mine = o.mode === "talk" && !!o.ownCaptions;
    const layout = o.layout === "big" ? "big" : "compact";
    const scale = clampScale(o.scale / 100);
    const { width, height } = overlaySize(layout, scale, subs);
    const area = pickDisplay(o.monitor).workArea;
    let pos = {
        x: o.position.endsWith("right") ? area.x + area.width - width : area.x,
        y: o.position.startsWith("bottom") ? area.y + area.height - height : area.y
    };
    if (o.position === "custom" && Number.isFinite(o.posX) && Number.isFinite(o.posY))
        pos = fitToScreen(o.posX!, o.posY!, width, height);

    const w = win = createWindow({ ...pos, width, height }, subs ? STT_PARTITION : undefined);
    info.set(w, { which: "call", layout, subs, scale });
    w.on("closed", () => {
        if (win === w) {
            win = null;
            releaseKeys();
        }
    });

    const html = buildOverlayHtml({
        name: o.name, sub: o.sub, avatar: o.avatar, mode: o.mode, startedAt: o.startedAt,
        acceptKey: o.acceptKey, declineKey: o.declineKey,
        layout, scale, theme: o.theme, accent: o.accent, subs, own: mine
    });

    // Для субтитров странице нужен «настоящий» адрес: с data:-страницы нельзя слушать звук и грузить модель
    let server: SttServer | null = null;
    if (subs) {
        try {
            server = await startSttServer(o.subtitleLang, randomBytes(16).toString("hex"), () => html);
            const s = server;
            if (w.isDestroyed()) return s.close();
            w.on("closed", () => s.close());
            // на случайном порту кэш модели не переиспользуется — чистим, чтобы он не копился
            if (!s.stablePort) await sttSession().clearStorageData({ storages: ["indexdb"] }).catch(() => { });
        } catch (err) {
            log("субтитры: локальный сервер не запустился: " + String((err as Error)?.message ?? err));
            server = null;
        }
    }

    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    if (server) {
        try {
            await w.loadURL(server.pageUrl);
        } catch (err) {
            // панель важнее субтитров: если страница с локального адреса не открылась, показываем обычную
            log("субтитры: страница не открылась: " + String((err as Error)?.message ?? err));
            server.close();
            server = null;
            if (w.isDestroyed()) return;
            await w.loadURL(dataUrl);
        }
    } else {
        await w.loadURL(dataUrl);
    }
    if (w.isDestroyed()) return;

    w.showInactive();
    if (o.mode === "in") grabKey(o.acceptKey, "accept");
    // В разговоре клавиши не перехватываем: панель висит весь звонок, а клавиша нужна игре
    if (o.mode !== "talk") grabKey(o.declineKey, "decline");

    if (mine) {
        if (o.selfMuted) w.webContents.executeJavaScript("cyberSelfMuted(true)").catch(() => { });
        await openMe(o, w, layout, subs).catch(err => log("моё окно не открылось: " + String((err as Error)?.message ?? err)));
        if (w.isDestroyed()) return;
    }
    if (subs) startSubtitles(w, server, o.subtitleLang, mine, o.micLabel);

    // В разговоре рингтон не нужен; для исходящего — только если включено в настройках
    if (o.mode === "talk" || (o.mode === "out" && !o.ringtoneOutgoing)) return;

    // Свой файл из настроек, иначе встроенный рингтон
    let b64 = defaultRingtone, mime = "audio/mpeg";
    const path = o.ringtonePath?.trim().replace(/^"|"$/g, "");
    if (path) {
        try {
            const m = MIME[extname(path).toLowerCase()];
            if (m && (await stat(path)).size <= MAX_RINGTONE_BYTES) {
                b64 = (await readFile(path)).toString("base64");
                mime = m;
            }
        } catch {
            // файл не найден или не читается — играет встроенный рингтон
        }
    }

    const vol = Math.min(1, Math.max(0, o.ringtoneVolume / 100));
    if (vol > 0 && !w.isDestroyed())
        w.webContents.executeJavaScript(`cyberRing(${JSON.stringify(b64)},${JSON.stringify(mime)},${vol})`).catch(() => { });
}

/** Моё окно: отдельная панель с моим ником и аватаркой, её можно двигать и масштабировать независимо. */
async function openMe(o: ShowOptions, call: BrowserWindow, layout: "compact" | "big", subs: boolean) {
    const scale = clampScale((o.meScale || o.scale) / 100);
    const { width, height } = overlaySize(layout, scale, subs);

    // По умолчанию — вплотную к окну собеседника: в обычном виде снизу, в крупном справа.
    // Если там нет места на экране — с другой стороны.
    const c = call.getBounds();
    const screenArea = screen.getDisplayMatching(c).bounds;
    let pos = layout === "big"
        ? { x: c.x + c.width + width <= screenArea.x + screenArea.width ? c.x + c.width - 20 : c.x - width + 20, y: c.y }
        : { x: c.x, y: c.y + c.height + height <= screenArea.y + screenArea.height ? c.y + c.height - 20 : c.y - height + 20 };
    if (o.meCustom && Number.isFinite(o.mePosX) && Number.isFinite(o.mePosY)) pos = { x: o.mePosX!, y: o.mePosY! };
    pos = fitToScreen(pos.x, pos.y, width, height);

    const w = meWin = createWindow({ ...pos, width, height });
    info.set(w, { which: "me", layout, subs, scale });
    w.on("closed", () => {
        if (meWin === w) meWin = null;
    });

    const html = buildOverlayHtml({
        view: "me", name: "", sub: "", avatar: "", mode: "talk",
        acceptKey: "", declineKey: "", layout, scale, theme: o.theme, accent: o.accent, subs,
        me: { name: o.selfName, sub: o.selfSub, avatar: o.selfAvatar }
    });
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    if (w.isDestroyed()) return;
    if (o.selfMuted) w.webContents.executeJavaScript("cyberSelfMuted(true)").catch(() => { });
    w.showInactive();
}

export function hideCall(_: IpcMainInvokeEvent, kind: Action | "missed" = "missed") {
    releaseKeys();
    const windows = [win, meWin];
    win = null;
    meWin = null;
    for (const w of windows) {
        if (!w || w.isDestroyed()) continue;
        w.webContents.executeJavaScript(`cyberClose(${JSON.stringify(kind)})`).catch(() => { });
        setTimeout(() => destroy(w), CLOSE_MS + 60);
    }
}

/** Докачивает распознавание при первом запуске и включает субтитры в окне. */
function startSubtitles(w: BrowserWindow, server: SttServer | null, lang: string, own: boolean, micLabel: string) {
    const exec = (js: string, gesture = false) => {
        if (!w.isDestroyed()) w.webContents.executeJavaScript(js, gesture).catch(() => { });
    };
    const status = (text: string, hold = 0) => exec(`cyberSubsStatus(${JSON.stringify(text)},${hold})`);

    if (!server) return status("Субтитры не запустились: не удалось открыть локальную страницу", 20000);

    status("Подготовка распознавания речи…");
    prepareStt(sttLang(lang), text => status(text))
        .then(files => {
            log("субтитры: файлы готовы, запускаю распознавание (" + sttLang(lang) + ")");
            server.setFiles(files);
            // userGesture = true: захват звука разрешён только «по действию пользователя»
            exec(`cyberSubsStart(${JSON.stringify({ engineUrl: server.engineUrl, modelUrl: server.modelUrl, own, micLabel })})`, true);
        })
        .catch(e => {
            const text = "Не удалось скачать распознавание речи: " + String(e?.message ?? e);
            log("субтитры: " + text);
            status(text, 20000);
        });
}

function run(js: string) {
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(js).catch(() => { });
}

/** Собеседник начал или перестал говорить. */
export function setSpeaking(_: IpcMainInvokeEvent, speaking: boolean) {
    run(`cyberSpeak(${speaking ? "true" : "false"})`);
}

function runBoth(js: string) {
    for (const w of [win, meWin])
        if (w && !w.isDestroyed()) w.webContents.executeJavaScript(js).catch(() => { });
}

/** Я начал или перестал говорить: моей панели — для анимации, окну звонка — для распознавания моей речи. */
export function setSelfSpeaking(_: IpcMainInvokeEvent, speaking: boolean) {
    runBoth(`window.cyberSelfSpeak&&cyberSelfSpeak(${speaking ? "true" : "false"})`);
}

/** Я выключил или включил микрофон. */
export function setSelfMuted(_: IpcMainInvokeEvent, muted: boolean) {
    runBoth(`window.cyberSelfMuted&&cyberSelfMuted(${muted ? "true" : "false"})`);
}

/** Собеседник вышел из звонка (панель становится серой) или вернулся. */
export function setRemoteGone(_: IpcMainInvokeEvent, gone: boolean) {
    run(`window.cyberGone&&cyberGone(${gone ? "true" : "false"})`);
}

/** В групповом звонке сменился говорящий. */
export function setSpeaker(_: IpcMainInvokeEvent, info: { name: string; sub: string; avatar: string; }) {
    run(`cyberUser(${JSON.stringify(String(info.name))},${JSON.stringify(String(info.sub))},${JSON.stringify(String(info.avatar))})`);
}

/** Какая сборка сейчас установлена. */
export async function getVersion(_: IpcMainInvokeEvent) {
    try {
        return String(JSON.parse(await readFile(join(__dirname, "version.json"), "utf-8")).tag);
    } catch {
        return "ручная сборка";
    }
}

/** Проверяет релизы на GitHub и, если вышла новая сборка, скачивает её. */
export function checkUpdate(_: IpcMainInvokeEvent) {
    // net.fetch ходит через сетевой стек Chromium, то есть учитывает системный прокси
    return runUpdate(__dirname, RELEASE_URL, (url, init) => net.fetch(url, init));
}

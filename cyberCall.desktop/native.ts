/*
 * CyberCall — часть, работающая в главном процессе Discord.
 * Открывает маленькое прозрачное окно поверх всех окон и ловит горячие клавиши.
 * Окно существует только пока идёт звонок, в остальное время плагин ничего не держит в памяти.
 */

import { BrowserWindow, globalShortcut, IpcMainInvokeEvent, net, screen, WebContents } from "electron";
import { readFile, stat } from "fs/promises";
import { extname } from "path";

import defaultRingtone from "file://ringtone.mp3?base64";

import { buildOverlayHtml, clampScale, CLOSE_MS, overlaySize } from "./overlay";
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
    /** на каком мониторе показывать, если панель стоит в углу */
    monitor: string;
    ringtonePath: string;
    ringtoneVolume: number;
}

type Action = "accept" | "decline" | "dismiss";

const MAX_RINGTONE_BYTES = 15 * 1024 * 1024;
const MIME: Record<string, string> = {
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".opus": "audio/ogg", ".webm": "audio/webm"
};

let win: BrowserWindow | null = null;
let owner: WebContents | null = null;
let keys: string[] = [];

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
    if (owner && !owner.isDestroyed())
        owner.executeJavaScript(`Vencord.Plugins.plugins.CyberCall.onOverlayMoved(${x},${y})`).catch(() => { });
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
    destroy(win);
    releaseKeys();
    owner = e.sender;

    const { width, height } = overlaySize(o.layout, o.scale / 100);
    const area = pickDisplay(o.monitor).workArea;
    let pos = {
        x: o.position.endsWith("right") ? area.x + area.width - width : area.x,
        y: o.position.startsWith("bottom") ? area.y + area.height - height : area.y
    };
    if (o.position === "custom" && Number.isFinite(o.posX) && Number.isFinite(o.posY))
        pos = fitToScreen(o.posX!, o.posY!, width, height);

    const w = win = new BrowserWindow({
        width,
        height,
        x: pos.x,
        y: pos.y,
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
            autoplayPolicy: "no-user-gesture-required"
        }
    });

    w.setAlwaysOnTop(true, "screen-saver");
    w.setMenu(null);
    w.on("closed", () => {
        if (win === w) {
            win = null;
            releaseKeys();
        }
    });

    // Оверлей никуда не переходит и не открывает окна
    w.webContents.on("will-navigate", ev => ev.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    w.webContents.on("page-title-updated", (ev, title) => {
        ev.preventDefault();
        const m = /^cybercall:(accept|decline|dismiss|dragstart|dragend):/.exec(title);
        if (!m) return;
        if (m[1] === "dragstart") startDrag(w);
        else if (m[1] === "dragend") stopDrag(true);
        else notify(m[1] as Action);
    });

    const html = buildOverlayHtml({
        name: o.name, sub: o.sub, avatar: o.avatar, mode: o.mode, startedAt: o.startedAt,
        acceptKey: o.acceptKey, declineKey: o.declineKey,
        layout: o.layout === "big" ? "big" : "compact", scale: clampScale(o.scale / 100),
        theme: o.theme, accent: o.accent
    });
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    if (w.isDestroyed()) return;

    w.showInactive();
    if (o.mode === "in") grabKey(o.acceptKey, "accept");
    // В разговоре клавиши не перехватываем: панель висит весь звонок, а клавиша нужна игре
    if (o.mode !== "talk") grabKey(o.declineKey, "decline");

    // У исходящего свои гудки Discord, рингтон только для входящего
    if (o.mode !== "in") return;

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

export function hideCall(_: IpcMainInvokeEvent, kind: Action | "missed" = "missed") {
    releaseKeys();
    const w = win;
    win = null;
    if (!w || w.isDestroyed()) return;

    w.webContents.executeJavaScript(`cyberClose(${JSON.stringify(kind)})`).catch(() => { });
    setTimeout(() => destroy(w), CLOSE_MS + 60);
}

function run(js: string) {
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(js).catch(() => { });
}

/** Собеседник начал или перестал говорить. */
export function setSpeaking(_: IpcMainInvokeEvent, speaking: boolean) {
    run(`cyberSpeak(${speaking ? "true" : "false"})`);
}

/** В групповом звонке сменился говорящий. */
export function setSpeaker(_: IpcMainInvokeEvent, info: { name: string; sub: string; avatar: string; }) {
    run(`cyberUser(${JSON.stringify(String(info.name))},${JSON.stringify(String(info.sub))},${JSON.stringify(String(info.avatar))})`);
}

/** Проверяет релизы на GitHub и, если вышла новая сборка, скачивает её. */
export function checkUpdate(_: IpcMainInvokeEvent) {
    // net.fetch ходит через сетевой стек Chromium, то есть учитывает системный прокси
    return runUpdate(__dirname, RELEASE_URL, (url, init) => net.fetch(url, init));
}

/*
 * CyberCall — часть, работающая в главном процессе Discord.
 * Открывает маленькое прозрачное окно поверх всех окон и ловит горячие клавиши.
 * Окно существует только пока идёт звонок, в остальное время плагин ничего не держит в памяти.
 */

import { BrowserWindow, globalShortcut, IpcMainInvokeEvent, net, screen, WebContents } from "electron";
import { readFile, stat } from "fs/promises";
import { extname } from "path";

import defaultRingtone from "file://ringtone.mp3?base64";

import { buildOverlayHtml, CLOSE_MS, OVERLAY_HEIGHT, OVERLAY_WIDTH } from "./overlay";
import { RELEASE_URL, runUpdate } from "./updater";

export interface ShowOptions {
    name: string;
    sub: string;
    avatar: string;
    acceptKey: string;
    declineKey: string;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    ringtonePath: string;
    ringtoneVolume: number;
}

type Action = "accept" | "decline";

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

function destroy(w: BrowserWindow | null) {
    if (w && !w.isDestroyed()) w.destroy();
}

export async function showCall(e: IpcMainInvokeEvent, o: ShowOptions) {
    destroy(win);
    releaseKeys();
    owner = e.sender;

    const area = screen.getPrimaryDisplay().workArea;
    const right = o.position.endsWith("right");
    const bottom = o.position.startsWith("bottom");

    const w = win = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        x: right ? area.x + area.width - OVERLAY_WIDTH : area.x,
        y: bottom ? area.y + area.height - OVERLAY_HEIGHT : area.y,
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
        const m = /^cybercall:(accept|decline):/.exec(title);
        if (m) notify(m[1] as Action);
    });

    const html = buildOverlayHtml({
        name: o.name, sub: o.sub, avatar: o.avatar,
        acceptKey: o.acceptKey, declineKey: o.declineKey, right
    });
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    if (w.isDestroyed()) return;

    w.showInactive();
    grabKey(o.acceptKey, "accept");
    grabKey(o.declineKey, "decline");

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

/** Проверяет релизы на GitHub и, если вышла новая сборка, скачивает её. */
export function checkUpdate(_: IpcMainInvokeEvent) {
    // net.fetch ходит через сетевой стек Chromium, то есть учитывает системный прокси
    return runUpdate(__dirname, RELEASE_URL, (url, init) => net.fetch(url, init));
}

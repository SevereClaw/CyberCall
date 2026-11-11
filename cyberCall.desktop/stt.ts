/*
 * CyberCall — субтитры: подготовка распознавания речи в главном процессе.
 *
 * Распознавание работает полностью на компьютере (движок Vosk, собранный в WebAssembly).
 * Здесь: загрузка движка и языковой модели при первом включении, маленький локальный сервер,
 * с которого их берёт окно оверлея, и разрешение этому окну слушать звук компьютера.
 * Звук никуда не отправляется.
 */

import { createHash } from "crypto";
import { app, desktopCapturer, net, session } from "electron";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, rename, stat, unlink } from "fs/promises";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { join } from "path";

const ASSET_URL = "https://github.com/SevereClaw/CyberCall/releases/download/stt-1/";
/** Постоянный порт нужен, чтобы распакованная модель кэшировалась между звонками. */
const PREFERRED_PORT = 47613;
export const STT_PARTITION = "persist:cybercall-stt";

interface Asset { file: string; size: number; sha256: string; type: string; }

const ENGINE: Asset = {
    file: "vosk.js", size: 5804767, type: "text/javascript",
    sha256: "29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c"
};
const MODELS: Record<string, Asset> = {
    ru: {
        file: "model-ru.tar.gz", size: 40810065, type: "application/gzip",
        sha256: "b855cf79a513023af4090739caa407203754d7db98ccb3b8d4162f5d7f6a3f8e"
    },
    en: {
        file: "model-en.tar.gz", size: 41184862, type: "application/gzip",
        sha256: "f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8"
    }
};

export const sttLang = (lang: string) => (lang === "en" ? "en" : "ru");
const dir = () => join(app.getPath("userData"), "CyberCall", "stt");

const downloads = new Map<string, Promise<string>>();

async function download(asset: Asset, onProgress: (percent: number) => void) {
    const path = join(dir(), asset.file);
    try {
        if ((await stat(path)).size === asset.size) return path;
    } catch { }

    await mkdir(dir(), { recursive: true });
    const tmp = path + ".part";
    try {
        // сторож: если сервер молчит полминуты (нет ответа или загрузка встала), обрываем с понятной ошибкой
        const abort = new AbortController();
        let watchdog: ReturnType<typeof setTimeout>;
        const alive = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => abort.abort(), 30_000);
        };
        alive();
        onProgress(0);
        const res = await net.fetch(ASSET_URL + asset.file, { signal: abort.signal }).catch(e => {
            throw new Error(abort.signal.aborted ? "GitHub не отвечает (проверь интернет или VPN)" : String(e?.message ?? e));
        });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

        const hash = createHash("sha256");
        const out = createWriteStream(tmp);
        const reader = res.body.getReader();
        let done = 0, shown = -1;
        for (; ;) {
            const chunk = await reader.read().catch(e => {
                throw new Error(abort.signal.aborted ? "загрузка остановилась (проверь интернет или VPN)" : String(e?.message ?? e));
            });
            alive();
            if (chunk.done) break;
            hash.update(chunk.value);
            if (!out.write(chunk.value)) await new Promise(r => out.once("drain", r));
            done += chunk.value.length;
            const percent = Math.min(99, Math.floor(done / asset.size * 100));
            if (percent !== shown) onProgress(shown = percent);
        }
        clearTimeout(watchdog!);
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => e ? reject(e) : resolve()));

        if (hash.digest("hex") !== asset.sha256) throw new Error("файл повреждён при загрузке");
        await rename(tmp, path);
        return path;
    } catch (e) {
        await unlink(tmp).catch(() => { });
        throw e;
    }
}

function ensure(asset: Asset, onProgress: (percent: number) => void) {
    let p = downloads.get(asset.file);
    if (!p) {
        p = download(asset, onProgress).finally(() => downloads.delete(asset.file));
        downloads.set(asset.file, p);
    }
    return p;
}

/** Скачивает движок и модель языка, если их ещё нет. Возвращает пути к файлам. */
export async function prepareStt(lang: string, onStatus: (text: string) => void) {
    const model = MODELS[sttLang(lang)];
    onStatus("Подготовка распознавания речи…");
    const engine = await ensure(ENGINE, p => onStatus(`Загрузка распознавания речи… ${Math.round(p / 8)}%`));
    const modelPath = await ensure(model, p => onStatus(`Загрузка распознавания речи… ${12 + Math.round(p * 0.88)}%`));
    return { engine, model: modelPath };
}

let sessionReady = false;

/** Отдельная сессия для окна с субтитрами: только ей разрешено слушать звук компьютера. */
export function sttSession() {
    const ses = session.fromPartition(STT_PARTITION);
    if (sessionReady) return ses;
    sessionReady = true;

    const allowed = (permission: string) => permission === "media" || permission === "display-capture";
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    // «Захват экрана» нужен только ради звука: видео страница сразу выключает
    ses.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .then(sources => callback({ video: sources[0], audio: "loopback" }))
            .catch(() => callback({} as any));
    });
    return ses;
}

export interface SttServer {
    /** адрес страницы оверлея */
    pageUrl: string;
    engineUrl: string;
    modelUrl: string;
    /** false — порт занят, работаем на случайном и кэш модели между звонками не сохранится */
    stablePort: boolean;
    setFiles(files: { engine: string; model: string; }): void;
    close(): void;
}

function listen(server: Server, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

/** Локальный сервер только для своего окна: страница оверлея, движок и модель. */
export async function startSttServer(lang: string, token: string, getHtml: () => string): Promise<SttServer> {
    let files: { engine: string; model: string; } | null = null;
    const modelName = "/" + MODELS[sttLang(lang)].file;

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const host = req.headers.host ?? "";
        const site = req.headers["sec-fetch-site"];
        // отвечаем только своей странице: никаких запросов с чужих сайтов и по чужому имени хоста
        if (req.method !== "GET" || !/^127\.0\.0\.1:\d+$/.test(host) || (site && site !== "same-origin" && site !== "none")) {
            res.writeHead(403).end();
            return;
        }

        if (url.pathname === "/overlay" && url.searchParams.get("t") === token) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(getHtml());
            return;
        }

        const file = url.pathname === "/vosk.js" ? files?.engine : url.pathname === modelName ? files?.model : null;
        if (!file) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            "Content-Type": url.pathname === "/vosk.js" ? ENGINE.type : "application/gzip",
            "Cache-Control": "no-store"
        });
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });

    let stablePort = true;
    try {
        await listen(server, PREFERRED_PORT);
    } catch {
        stablePort = false;
        await listen(server, 0);
    }

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        pageUrl: `${origin}/overlay?t=${token}`,
        engineUrl: `${origin}/vosk.js`,
        modelUrl: origin + modelName,
        stablePort,
        setFiles: f => { files = f; },
        close: () => {
            server.close();
            server.closeAllConnections?.();
        }
    };
}

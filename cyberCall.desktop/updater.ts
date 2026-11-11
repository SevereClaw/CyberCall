/*
 * CyberCall — автообновление готовой сборки.
 * Работает только если плагин установлен через install.bat (в папке dist лежит version.json).
 * Файлы берутся из последнего релиза на GitHub, сверяются по SHA-256 и подменяются целиком,
 * новая версия начинает работать после перезапуска Discord.
 */

import { createHash } from "crypto";
import { readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";

export const RELEASE_URL = "https://github.com/SevereClaw/CyberCall/releases/latest/download/";
const FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"] as const;
const MANIFEST = "version.json";

interface Manifest {
    tag: string;
    files: Record<string, string>;
}

export interface UpdateResult {
    status: "updated" | "current" | "unsupported" | "error";
    /** установленная версия (после обновления — новая) */
    tag?: string;
    error?: string;
}

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; }>;

const buildNumber = (tag: unknown) => Number(/^build-(\d+)$/.exec(String(tag))?.[1] ?? NaN);

function parseManifest(text: string): Manifest {
    const m = JSON.parse(text);
    if (!Number.isFinite(buildNumber(m?.tag))) throw new Error("bad manifest tag");
    for (const f of FILES)
        if (!/^[0-9a-f]{64}$/.test(m?.files?.[f] ?? "")) throw new Error("bad manifest hash for " + f);
    return m;
}

async function download(fetchImpl: Fetch, url: string) {
    const res = await fetchImpl(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

let busy = false;

export async function runUpdate(distDir: string, baseUrl: string, fetchImpl: Fetch): Promise<UpdateResult> {
    let local: Manifest;
    try {
        local = parseManifest(await readFile(join(distDir, MANIFEST), "utf-8"));
    } catch {
        return { status: "unsupported" };
    }

    if (busy) return { status: "current", tag: local.tag };
    busy = true;

    const staged: string[] = [];
    try {
        const remoteText = (await download(fetchImpl, baseUrl + MANIFEST)).toString("utf-8");
        const remote = parseManifest(remoteText);
        if (buildNumber(remote.tag) <= buildNumber(local.tag))
            return { status: "current", tag: local.tag };

        // Сначала качаем и проверяем всё, и только потом трогаем рабочие файлы
        for (const f of FILES) {
            const data = await download(fetchImpl, baseUrl + f);
            const hash = createHash("sha256").update(data).digest("hex");
            if (hash !== remote.files[f]) throw new Error("checksum mismatch for " + f);
            const tmp = join(distDir, f + ".new");
            await writeFile(tmp, data);
            staged.push(tmp);
        }

        for (const f of FILES) await rename(join(distDir, f + ".new"), join(distDir, f));
        staged.length = 0;
        await writeFile(join(distDir, MANIFEST), remoteText);

        return { status: "updated", tag: remote.tag };
    } catch (e) {
        return { status: "error", tag: local.tag, error: String((e as Error)?.message ?? e) };
    } finally {
        for (const tmp of staged) await unlink(tmp).catch(() => { });
        busy = false;
    }
}

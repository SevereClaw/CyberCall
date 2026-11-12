// Сравнение распознавателей на реальной речи (FLEURS): Vosk small (как сейчас в плагине) и Whisper base/small.
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";

const dir = process.argv[2];
const clips = JSON.parse(fs.readFileSync(path.join(dir, "clips.json"), "utf8"));
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };
const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/page.html";
    const file = path.join(dir, p);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin"
    });
    fs.createReadStream(file).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise(r => server.once("listening", r));

const norm = s => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
    const r = norm(ref), h = norm(hyp);
    const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
    for (let j = 1; j <= h.length; j++) d[0][j] = j;
    for (let i = 1; i <= r.length; i++)
        for (let j = 1; j <= h.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    return { errors: d[r.length][h.length], words: r.length };
}

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage();
page.on("pageerror", e => console.log("pageerror", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction("window.ready === true", null, { timeout: 60000 });
console.log("isolated:", await page.evaluate("crossOriginIsolated"), "threads:", await page.evaluate("navigator.hardwareConcurrency"));

const engines = [
    { name: "vosk-small", run: c => page.evaluate(([f, l]) => vosk(f, l), [c.file, c.lang]) },
    { name: "whisper-base", load: () => page.evaluate(() => loadWhisper("whisper-base", "wasm")), run: c => page.evaluate(([f, l]) => whisper(f, l), [c.file, c.lang]) },
    { name: "whisper-small", load: () => page.evaluate(() => loadWhisper("whisper-small", "wasm")), run: c => page.evaluate(([f, l]) => whisper(f, l), [c.file, c.lang]) }
];

const only = process.env.ENGINES ? process.env.ENGINES.split(",") : null;
const maxWer = Number(process.env.MAX_WER || 0);
let failed = false;
const summary = [];
for (const e of engines.filter(x => !only || only.includes(x.name))) {
    const loadMs = e.load ? await e.load() : 0;
    const acc = { ru: { errors: 0, words: 0, ms: 0, sec: 0 }, en: { errors: 0, words: 0, ms: 0, sec: 0 } };
    for (const c of clips) {
        const r = await e.run(c);
        const w = wer(c.ref, r.text);
        const a = acc[c.lang];
        a.errors += w.errors; a.words += w.words; a.ms += r.ms; a.sec += r.sec;
        console.log(`${e.name} ${c.lang} ${r.ms}ms/${r.sec.toFixed(1)}s WER ${(w.errors / w.words * 100).toFixed(0)}% | ${r.text.trim().slice(0, 110)}`);
        console.log(`   ref: ${c.ref.slice(0, 110)}`);
    }
    for (const lang of ["ru", "en"]) {
        const a = acc[lang];
        if (maxWer && a.words && a.errors / a.words * 100 > maxWer) failed = true;
        summary.push(`${e.name.padEnd(14)} ${lang}: WER ${(a.errors / a.words * 100).toFixed(1)}%  скорость ${(a.ms / 1000 / a.sec).toFixed(2)}x от длины речи  загрузка ${loadMs} ms`);
    }
}
console.log("\n===== ИТОГ =====\n" + summary.join("\n"));
await browser.close();
server.close();
if (failed) { console.log("WER выше допустимого " + maxWer + "%"); process.exit(1); }

// Проверка языковых моделей в настоящем браузере: тот же движок, что в плагине.
// Запуск: node ci/stt-test.mjs <папка с vosk.js, моделями и wav> <wav> <модель.tar.gz>...
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";

const [dir, wav, ...models] = process.argv.slice(2);
const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(req.url.split("?")[0]));
    if (req.url === "/") return res.end("<!doctype html><script src='/vosk.js'></script>");
    fs.existsSync(file) ? fs.createReadStream(file).pipe(res) : res.writeHead(404).end();
}).listen(0, "127.0.0.1");
await new Promise(r => server.once("listening", r));
const origin = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch();
let ok = true;
for (const model of models) {
    const page = await browser.newPage();
    await page.goto(origin + "/");
    const result = await page.evaluate(async ({ model, wav }) => {
        const t0 = performance.now();
        const m = await Vosk.createModel("/" + model, -1);
        const loadMs = Math.round(performance.now() - t0);
        const rec = new m.KaldiRecognizer(16000);
        const finals = [];
        rec.on("result", e => { if (e.result.text) finals.push(e.result.text); });
        const ctx = new AudioContext({ sampleRate: 16000 });
        const data = (await ctx.decodeAudioData(await (await fetch("/" + wav)).arrayBuffer())).getChannelData(0);
        for (let i = 0; i < data.length; i += 4096) rec.acceptWaveformFloat(data.slice(i, i + 4096), 16000);
        rec.acceptWaveformFloat(new Float32Array(32000), 16000);
        rec.retrieveFinalResult();
        await new Promise(r => setTimeout(r, 8000));
        return { loadMs, text: finals.join(" | ") };
    }, { model, wav });
    console.log(`MODEL ${model}: load ${result.loadMs} ms -> "${result.text}"`);
    if (!result.text) ok = false;
    await page.close();
}
await browser.close();
server.close();
process.exit(ok ? 0 : 1);

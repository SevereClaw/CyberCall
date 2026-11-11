/*
 * CyberCall — оверлей входящего звонка в киберпанк-стиле.
 * Этот файл собирает HTML страницы, которую показывает окно оверлея.
 * Никаких импортов: его можно открыть и в обычном браузере для предпросмотра.
 */

export interface OverlayData {
    name: string;
    sub: string;
    avatar: string;
    acceptKey: string;
    declineKey: string;
    /** true — панель прижата к правому краю экрана */
    right: boolean;
}

export const OVERLAY_WIDTH = 560;
export const OVERLAY_HEIGHT = 210;
/** Длительность анимации закрытия, мс */
export const CLOSE_MS = 420;

function esc(s: string) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]!));
}

export function buildOverlayHtml(d: OverlayData) {
    const name = esc(d.name);
    const bars = Array.from({ length: 22 }, (_, i) => `<i style="animation-delay:-${(i * 137) % 900}ms"></i>`).join("");

    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>cybercall</title>
<style>
:root{
  --y:#fcee0a; --c:#00f0ff; --r:#ff2a4f; --bg:rgba(8,10,14,.93);
  --font:"Bahnschrift","Segoe UI Semibold","Segoe UI","DejaVu Sans",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;font-family:var(--font)}
body{display:flex;align-items:flex-start;padding:14px;${d.right ? "justify-content:flex-end;" : ""}}

/* ---------- каркас ---------- */
.wrap{position:relative;width:520px;height:176px;filter:drop-shadow(0 0 10px rgba(0,240,255,.22))}
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
  background:linear-gradient(180deg,transparent,rgba(0,240,255,.13),transparent);
  animation:sweep 2.6s linear infinite .6s}
.tag{position:absolute;right:34px;top:7px;font-size:9px;letter-spacing:.22em;color:rgba(0,240,255,.55)}
.corner{position:absolute;left:0;top:0;width:64px;height:5px;background:var(--y)}

.content{position:absolute;inset:0;display:flex;gap:18px;padding:20px 22px 18px 22px;
  animation:content .5s ease-out .28s both}

/* ---------- аватар ---------- */
.ava{position:relative;flex:none;width:112px;height:136px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%);
  background:#05070a;outline:1px solid var(--c)}
.ava img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ava .base{filter:saturate(.75) contrast(1.15) brightness(.95)}
.ava .tint{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,240,255,.28),rgba(0,240,255,.08));mix-blend-mode:screen}
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
  text-shadow:0 0 12px rgba(0,240,255,.45)}
.name::before,.name::after{content:attr(data-t);position:absolute;left:0;top:0;width:100%;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis;opacity:0}
.name::before{color:var(--r);animation:txtR 2.7s steps(1) infinite}
.name::after{color:var(--c);animation:txtC 2.7s steps(1) infinite}
.sub{font-size:12px;letter-spacing:.12em;color:rgba(0,240,255,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

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
.acc{background:var(--y);color:#0a0a0a}
.acc kbd{color:var(--y)}
.dec{background:var(--r);color:#fff}
.dec kbd{color:#ff8298}
.acc{animation:pulse 1.4s ease-in-out infinite}

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
<body>
<div class="wrap">
  <div class="panel">
    <div class="corner"></div>
    <div class="tag">HOLO // LINK</div>
    <div class="sweep"></div>
    <div class="content">
      <div class="ava">
        <img class="base" src="${esc(d.avatar)}" alt="">
        <img class="gr" src="${esc(d.avatar)}" alt="">
        <img class="gc" src="${esc(d.avatar)}" alt="">
        <img class="slice" src="${esc(d.avatar)}" alt="">
        <div class="tint"></div><div class="lines"></div><div class="boot"></div>
      </div>
      <div class="info">
        <div class="label"><b></b>ВХОДЯЩИЙ ВЫЗОВ</div>
        <div class="name" data-t="${name}">${name}</div>
        <div class="sub">${esc(d.sub)}</div>
        <div class="wave">${bars}</div>
        <div class="btns">
          <button class="acc" data-a="accept"><kbd>${esc(d.acceptKey)}</kbd>ПРИНЯТЬ</button>
          <button class="dec" data-a="decline"><kbd>${esc(d.declineKey)}</kbd>ОТКЛОНИТЬ</button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
// Клик по кнопке передаётся в главный процесс через заголовок окна.
document.querySelectorAll("button").forEach(b =>
  b.addEventListener("click", () => { document.title = "cybercall:" + b.dataset.a + ":" + Date.now(); }));

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

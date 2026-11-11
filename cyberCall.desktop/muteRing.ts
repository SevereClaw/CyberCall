/*
 * CyberCall — глушит стандартный звонок Discord, пока играет свой рингтон.
 *
 * Discord проигрывает звуки через обычные Audio-элементы, а мелодия вызова — единственный
 * зацикленный звук. Поэтому следим за запущенными звуками и на время входящего звонка
 * выключаем те, что играют по кругу. Остальные звуки (сообщения, вход в канал) не трогаем.
 */

let originalPlay: typeof HTMLMediaElement.prototype.play | null = null;
let muting = false;
/** звуки, которые Discord недавно запускал */
let recent: WeakRef<HTMLAudioElement>[] = [];
/** звуки, которые заглушили мы — чтобы вернуть только их */
let mutedByUs: WeakRef<HTMLAudioElement>[] = [];
let timers: ReturnType<typeof setTimeout>[] = [];

function silence(el: HTMLAudioElement) {
    if (!el.loop || el.muted) return;
    el.muted = true;
    mutedByUs.push(new WeakRef(el));
}

function sweep() {
    recent = recent.filter(r => r.deref());
    if (!muting) return;
    for (const r of recent) {
        const el = r.deref();
        if (el && !el.paused) silence(el);
    }
}

export function installRingMuter() {
    if (originalPlay) return;
    const original = originalPlay = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        try {
            // только «висящие в воздухе» звуки интерфейса, а не видео и не плееры на странице
            if (this instanceof HTMLAudioElement && !this.isConnected) {
                if (!recent.some(r => r.deref() === this)) {
                    recent.push(new WeakRef(this));
                    if (recent.length > 40) recent = recent.filter(r => r.deref()).slice(-40);
                }
                if (muting) silence(this);
            }
        } catch { }
        return original.apply(this, arguments as any);
    };
}

export function uninstallRingMuter() {
    setRingMuted(false);
    if (originalPlay) HTMLMediaElement.prototype.play = originalPlay;
    originalPlay = null;
    recent = [];
}

export function setRingMuted(on: boolean) {
    timers.forEach(clearTimeout);
    timers = [];
    muting = on;

    if (on) {
        // звонок мог начать играть чуть раньше или чуть позже, чем появилась панель
        sweep();
        timers = [80, 250, 600, 1500].map(ms => setTimeout(sweep, ms));
    } else {
        for (const r of mutedByUs) {
            const el = r.deref();
            if (el) el.muted = false;
        }
        mutedByUs = [];
    }
}

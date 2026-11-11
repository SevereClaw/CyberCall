/*
 * CyberCall — входящий звонок Discord в киберпанк-стиле поверх игр и рабочего стола.
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { CallStore, ChannelStore, IconUtils, RestAPI, SelectedChannelStore, UserStore, useEffect, useState } from "@webpack/common";

import { THEMES } from "./overlay";
import { installRingMuter, ringMuterReport, setRingMuted, uninstallRingMuter } from "./muteRing";

const Native = VencordNative.pluginHelpers.CyberCall as PluginNative<typeof import("./native")>;
const VoiceActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

const TEST_ID = "cybercall-test";
const FALLBACK_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

type Mode = "in" | "out" | "talk";

/** id канала, звонок из которого сейчас показан в оверлее */
let shownChannelId: string | null = null;
/** какой это звонок: входящий или исходящий */
let shownMode: Mode = "in";
/** каналы, где звонили мне: после ответа там не показываем панель исходящего */
const wasIncoming = new Set<string>();
/** разговоры, у которых панель скрыли кнопкой «Скрыть» */
const dismissedTalk = new Set<string>();
/** когда начался разговор в канале — для таймера */
const talkStart = new Map<string, number>();
/** кто сейчас говорит (кроме меня) */
const speakers = new Set<string>();
let shownSpeaker: string | null = null;
let lastHideAt = 0;
/** в каком голосовом канале я был при прошлой сверке и когда в него вошёл */
let lastVoiceId: string | null = null;
let voiceJoinedAt = 0;
/** сколько ждать после входа в свой звонок: гудки собеседнику начинаются не сразу */
const OUTGOING_GRACE = 1500;
let speakTestTimer: ReturnType<typeof setInterval> | undefined;
/** звонки, на которые уже ответили — чтобы оверлей не всплыл повторно, пока Discord обновляет состояние */
const handled = new Set<string>();
let testTimer: ReturnType<typeof setTimeout> | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
/** новая сборка уже скачана и ждёт перезапуска */
let updateReady = false;

const UPDATE_INTERVAL = 30 * 60 * 1000;

/** Журнал последних событий: по нему видно, что плагин увидел и что решил показать. */
const journal: string[] = [];
let lastSyncState = "";
function log(text: string) {
    journal.push(new Date().toLocaleTimeString("ru-RU") + " " + text);
    if (journal.length > 120) journal.shift();
}

async function copyJournal() {
    const s = settings.store;
    const head = [
        "CyberCall " + await Native.getVersion().catch(() => "?"),
        `настройки: субтитры=${s.captions}/${s.subtitleLang} исходящий=${s.showOutgoing} разговор=${s.showInCall} рингтонИсх=${s.ringtoneOutgoing} глушить=${s.muteDiscordRing} громкость=${s.ringtoneVolume}`,
        ringMuterReport()
    ];
    await copyToClipboard([...head, ...journal].join("\n"));
    showNotification({ title: "CyberCall", body: "Журнал скопирован. Вставь его в чат.", noPersist: true });
}

function VersionLine() {
    const [version, setVersion] = useState("…");
    useEffect(() => { Native.getVersion().then(setVersion, () => setVersion("?")); }, []);
    return <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>Установлена сборка: {version}</div>;
}

function AccentPicker() {
    const { accent, theme } = settings.use(["accent", "theme"]);
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-default, var(--header-primary))" }}>
            <input
                type="color"
                value={accent || "#fcee0a"}
                onChange={e => {
                    settings.store.accent = e.currentTarget.value;
                    settings.store.theme = "custom";
                }}
                style={{ width: 44, height: 28, padding: 0, border: "none", background: "none", cursor: "pointer" }}
            />
            Свой акцентный цвет{theme === "custom" ? "" : " (выбор цвета включит его)"} — второй цвет подберётся сам
        </label>
    );
}

const settings = definePluginSettings({
    acceptKey: {
        type: OptionType.STRING,
        description: "Клавиша «Принять» (работает только пока идёт звонок). Примеры: F7, Alt+A, Ctrl+Shift+Y",
        default: "F7"
    },
    declineKey: {
        type: OptionType.STRING,
        description: "Клавиша «Отклонить» (работает только пока идёт звонок)",
        default: "F8"
    },
    position: {
        type: OptionType.SELECT,
        description: "Место на экране. Панель можно просто перетащить мышкой — место запомнится",
        options: [
            { label: "Своё место (куда перетащил)", value: "custom" },
            { label: "Слева сверху", value: "top-left", default: true },
            { label: "Справа сверху", value: "top-right" },
            { label: "Слева снизу", value: "bottom-left" },
            { label: "Справа снизу", value: "bottom-right" }
        ]
    },
    monitor: {
        type: OptionType.SELECT,
        description: "Монитор (для панели в углу; перетащенная панель остаётся там, куда её поставили)",
        options: [
            { label: "Там, где сейчас курсор мыши", value: "cursor", default: true },
            { label: "Основной", value: "primary" },
            { label: "Монитор 1 (счёт слева направо)", value: "1" },
            { label: "Монитор 2", value: "2" },
            { label: "Монитор 3", value: "3" },
            { label: "Монитор 4", value: "4" }
        ]
    },
    theme: {
        type: OptionType.SELECT,
        description: "Цвета",
        options: [
            ...Object.entries(THEMES).map(([value, t], i) => ({ label: t.label, value, default: i === 0 })),
            { label: "Свой акцентный цвет", value: "custom" }
        ]
    },
    accent: {
        type: OptionType.COMPONENT,
        description: "Свой акцентный цвет",
        default: "#fcee0a",
        component: AccentPicker
    },
    posX: { type: OptionType.NUMBER, description: "X панели", default: 0, hidden: true },
    posY: { type: OptionType.NUMBER, description: "Y панели", default: 0, hidden: true },
    layout: {
        type: OptionType.SELECT,
        description: "Вид панели",
        options: [
            { label: "Обычная", value: "compact", default: true },
            { label: "Крупная, с большой аватаркой", value: "big" }
        ]
    },
    scale: {
        type: OptionType.SLIDER,
        description: "Размер панели, %",
        markers: [50, 75, 100, 125, 150, 200],
        default: 100,
        stickToMarkers: false
    },
    ringtonePath: {
        type: OptionType.STRING,
        description: "Полный путь к другому рингтону (mp3, ogg, wav, m4a, flac). Пусто — встроенный рингтон",
        default: ""
    },
    ringtoneVolume: {
        type: OptionType.SLIDER,
        description: "Громкость рингтона, % (0 — без звука)",
        markers: [0, 25, 50, 75, 100],
        default: 70,
        stickToMarkers: false
    },
    ringtoneOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Играть свой рингтон и когда звонишь ты (вместо гудков Discord)",
        default: true
    },
    muteDiscordRing: {
        type: OptionType.BOOLEAN,
        description: "Глушить стандартную мелодию звонка и гудки Discord, пока играет свой рингтон",
        default: true
    },
    showOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Показывать панель исходящего вызова, когда звонишь ты (сброс — клавишей «Отклонить»)",
        default: true
    },
    showInCall: {
        type: OptionType.BOOLEAN,
        description: "Показывать панель разговора после ответа: аватарка оживает, когда собеседник говорит",
        default: true
    },
    captions: {
        type: OptionType.BOOLEAN,
        description: "Субтитры: текст речи собеседника под панелью разговора. Распознаётся на компьютере, звук никуда не отправляется. При первом звонке скачает около 45 МБ, во время звонка занимает около 400 МБ памяти",
        default: true
    },
    subtitleLang: {
        type: OptionType.SELECT,
        description: "Язык субтитров (распознаётся один язык за раз)",
        options: [
            { label: "Русский", value: "ru", default: true },
            { label: "English", value: "en" }
        ]
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        description: "Автообновление: при запуске Discord и каждые 3 часа проверять новые сборки и ставить их самому",
        default: true
    },
    test: {
        type: OptionType.COMPONENT,
        description: "Проверка",
        component: () => (
            <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button onClick={() => showTest("in")}>Тест входящего</Button>
                    <Button onClick={() => showTest("out")}>Тест исходящего</Button>
                    <Button onClick={() => showTest("talk")}>Тест разговора</Button>
                    <Button variant="secondary" onClick={() => checkUpdate(true)}>Проверить обновления</Button>
                    <Button variant="secondary" onClick={() => copyJournal()}>Скопировать журнал</Button>
                </div>
                <VersionLine />
            </div>
        )
    }
});

function absolute(url: string | undefined | null) {
    if (!url) return FALLBACK_AVATAR;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return location.origin + url;
    return url;
}

function describe(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    const recipients: string[] = (channel as any)?.recipients ?? [];
    const users = recipients.map(id => UserStore.getUser(id)).filter(Boolean);

    // Личный звонок
    if (users.length === 1 && !channel?.name) {
        const u = users[0];
        return {
            name: (u as any).globalName || u.username,
            sub: "@" + u.username,
            avatar: absolute(IconUtils.getUserAvatarURL(u, true, 256))
        };
    }

    // Групповой звонок
    const names = users.map(u => (u as any).globalName || u.username).join(", ");
    return {
        name: channel?.name || names || "Неизвестный абонент",
        sub: users.length ? `Группа · ${users.length + 1} участников` : "Discord",
        avatar: absolute(
            (channel && IconUtils.getChannelIconURL({ id: channel.id, icon: (channel as any).icon, size: 256 }))
            || (users[0] && IconUtils.getUserAvatarURL(users[0], true, 256))
        )
    };
}

function show(channelId: string, mode: Mode, info: { name: string; sub: string; avatar: string; }) {
    shownChannelId = channelId;
    shownMode = mode;
    shownSpeaker = null;
    const s = settings.store;
    const ownRingtone = s.ringtoneVolume > 0 && (mode === "in" || (mode === "out" && s.ringtoneOutgoing));
    setRingMuted(ownRingtone && channelId !== TEST_ID && s.muteDiscordRing);
    log(`показываю панель: ${mode}${channelId === TEST_ID ? " (тест)" : ""}, свой рингтон=${ownRingtone}, субтитры=${mode === "talk" && s.captions}`);
    Native.showCall({
        ...info,
        mode,
        startedAt: talkStart.get(channelId),
        acceptKey: s.acceptKey,
        declineKey: s.declineKey,
        position: s.position as any,
        posX: s.posX,
        posY: s.posY,
        layout: s.layout as any,
        scale: s.scale,
        theme: s.theme as string,
        accent: s.accent as string,
        monitor: s.monitor as string,
        subtitles: s.captions,
        subtitleLang: s.subtitleLang as string,
        ringtonePath: s.ringtonePath,
        ringtoneVolume: s.ringtoneVolume,
        ringtoneOutgoing: s.ringtoneOutgoing
    }).catch(e => log("ошибка показа панели: " + String(e?.message ?? e)));
}

function hide(kind: "accept" | "decline" | "missed") {
    log(`скрываю панель: ${shownMode} (${kind})`);
    shownChannelId = null;
    shownSpeaker = null;
    lastHideAt = Date.now();
    setRingMuted(false);
    clearTimeout(testTimer);
    clearInterval(speakTestTimer);
    Native.hideCall(kind);
}

function showTest(mode: Mode) {
    const me = UserStore.getCurrentUser();
    show(TEST_ID, mode, {
        name: (me as any)?.globalName || me?.username || "Тестовый абонент",
        sub: "Тестовый вызов",
        avatar: me ? absolute(IconUtils.getUserAvatarURL(me, true, 256)) : FALLBACK_AVATAR
    });
    clearTimeout(testTimer);
    clearInterval(speakTestTimer);
    testTimer = setTimeout(() => shownChannelId === TEST_ID && hide("missed"), 15_000);
    if (mode === "talk") {
        // имитируем речь, чтобы было видно, как оживает аватарка
        let on = false;
        speakTestTimer = setInterval(() => Native.setSpeaking(on = !on), 1800);
    }
}

function notifyRestart(tag?: string) {
    showNotification({
        title: "CyberCall обновлён",
        body: `Скачана новая сборка${tag ? " " + tag : ""}. Нажми сюда, чтобы перезапустить Discord, или она включится при следующем запуске.`,
        permanent: true,
        noPersist: true,
        onClick: relaunch
    });
}

async function checkUpdate(manual = false) {
    if (!manual && !settings.store.autoUpdate) return;
    if (updateReady) {
        if (manual) notifyRestart();
        return;
    }

    let result: Awaited<ReturnType<typeof Native.checkUpdate>>;
    try {
        result = await Native.checkUpdate();
    } catch (e) {
        result = { status: "error", error: String(e) };
    }

    if (result.status === "updated") {
        updateReady = true;
        notifyRestart(result.tag);
    } else if (manual) {
        const body = {
            current: `Установлена последняя сборка${result.tag ? " (" + result.tag + ")" : ""}.`,
            unsupported: "Эта копия собрана вручную, автообновление работает только после установки через install.bat.",
            error: "Не получилось проверить обновления: " + (result.error ?? "неизвестная ошибка")
        }[result.status];
        showNotification({ title: "CyberCall", body, noPersist: true });
    }
}

/** Сверяет оверлей с тем, что сейчас реально звонит в Discord. */
function sync() {
    const meId = UserStore.getCurrentUser()?.id;
    if (!meId) return;

    const calls = CallStore.getCalls() ?? [];
    const live = new Set<string>(calls.map(c => c.channelId));
    const ringing = new Set<string>(calls.filter(c => c?.ringing?.includes(meId)).map(c => c.channelId));

    const voiceId = SelectedChannelStore.getVoiceChannelId() ?? null;
    if (voiceId !== lastVoiceId) {
        lastVoiceId = voiceId;
        voiceJoinedAt = Date.now();
    }

    // «Мне звонили» помним, только пока звонят или пока я в этом звонке:
    // если я вышел и набрал сам — это уже мой исходящий
    for (const id of ringing) wasIncoming.add(id);
    for (const id of wasIncoming) if (!live.has(id) || (id !== voiceId && !ringing.has(id))) wasIncoming.delete(id);
    for (const id of handled) if (!ringing.has(id)) handled.delete(id);

    // Исходящий: я сижу в звонке, который начал сам, и кому-то ещё идут гудки
    const outgoing = settings.store.showOutgoing && voiceId && !wasIncoming.has(voiceId)
        && calls.some(c => c.channelId === voiceId && c.ringing?.some(id => id !== meId))
        ? voiceId
        : null;

    // Разговор: я в звонке, гудки уже никому не идут
    for (const id of dismissedTalk) if (id !== voiceId) dismissedTalk.delete(id);
    for (const id of talkStart.keys()) if (id !== voiceId) talkStart.delete(id);
    const talking = voiceId && live.has(voiceId) && !ringing.has(voiceId) && outgoing !== voiceId ? voiceId : null;
    // пока идут гудки, разговор ещё не начался — таймер пойдёт с момента ответа
    if (outgoing) talkStart.delete(outgoing);
    if (talking && !talkStart.has(talking)) talkStart.set(talking, Date.now());
    if (!talking) speakers.clear();
    let talk = talking && settings.store.showInCall && !dismissedTalk.has(talking) ? talking : null;

    // Я только что сам вошёл в звонок: гудки собеседнику Discord начинает на секунду позже.
    // Ждём, чтобы вместо панели исходящего не мелькнула панель разговора.
    const sinceJoin = Date.now() - voiceJoinedAt;
    if (talk && talk !== shownChannelId && !wasIncoming.has(talk) && sinceJoin < OUTGOING_GRACE) {
        talk = null;
        setTimeout(sync, OUTGOING_GRACE - sinceJoin + 50);
    }

    const state = `звонков=${calls.length} [${calls.map(c => `гудки:${c.ringing?.length ?? 0}${c.ringing?.includes(meId) ? "(мне)" : ""}`).join(" ")}] я в голосе=${Boolean(voiceId)} в звонке=${Boolean(voiceId && live.has(voiceId))} → входящий=${ringing.size} исходящий=${Boolean(outgoing)} разговор=${Boolean(talk)}`;
    if (state !== lastSyncState) log(lastSyncState = state);

    if (shownChannelId && shownChannelId !== TEST_ID) {
        if (shownMode === "talk" && talk !== shownChannelId) {
            hide("decline");
        } else if (shownMode === "in" && !ringing.has(shownChannelId)) {
            hide("missed");
        } else if (shownMode === "out" && outgoing !== shownChannelId) {
            // гудки кончились, а я всё ещё в звонке — значит, ответили
            hide(voiceId === shownChannelId && live.has(shownChannelId) ? "accept" : "missed");
        }
    }

    const next = [...ringing].find(id => !handled.has(id));
    if (next) {
        // входящий важнее: перекрывает тест и панель исходящего
        if (shownChannelId !== next) show(next, "in", describe(next));
    } else if (!shownChannelId && (outgoing || talk)) {
        // даём старой панели доиграть анимацию закрытия
        if (Date.now() - lastHideAt < 520) return void setTimeout(sync, 540);
        if (outgoing) show(outgoing, "out", describe(outgoing));
        else if (talk) {
            show(talk, "talk", describe(talk));
            pushSpeaking();
        }
    }
}

/** Передаёт в панель разговора, говорит ли сейчас собеседник и кто именно. */
function pushSpeaking() {
    if (shownMode !== "talk" || !shownChannelId || shownChannelId === TEST_ID) return;

    const channel = ChannelStore.getChannel(shownChannelId);
    const group = ((channel as any)?.recipients?.length ?? 0) > 1;
    // в групповом звонке показываем того, кто говорит
    const current = [...speakers].pop();
    if (group && current && current !== shownSpeaker) {
        const u = UserStore.getUser(current);
        if (u) {
            shownSpeaker = current;
            Native.setSpeaker({
                name: (u as any).globalName || u.username,
                sub: "@" + u.username,
                avatar: absolute(IconUtils.getUserAvatarURL(u, true, 256))
            });
        }
    }
    Native.setSpeaking(speakers.size > 0);
}

function onSpeaking(e: any) {
    const id = e?.userId;
    if (!id || id === UserStore.getCurrentUser()?.id) return;

    const on = Boolean(e.speakingFlags ?? e.speaking);
    if (on === speakers.has(id)) return;
    if (on) speakers.add(id); else speakers.delete(id);
    pushSpeaking();
}

const scheduleSync = () => { setTimeout(sync, 60); };

export default definePlugin({
    name: "CyberCall",
    description: "Звонки в киберпанк-стиле поверх игр и рабочего стола: входящий, исходящий и панель разговора с живой аватаркой.",
    authors: [{ name: "SevereClaw", id: 0n }],
    settings,

    flux: {
        CALL_CREATE: scheduleSync,
        CALL_UPDATE: scheduleSync,
        CALL_DELETE: scheduleSync,
        VOICE_CHANNEL_SELECT: scheduleSync,
        SPEAKING: onSpeaking,
        CONNECTION_OPEN: scheduleSync
    },

    start() {
        installRingMuter();
        scheduleSync();
        setTimeout(() => checkUpdate(), 15_000);
        updateTimer = setInterval(() => checkUpdate(), UPDATE_INTERVAL);
    },

    stop() {
        uninstallRingMuter();
        clearInterval(updateTimer);
        handled.clear();
        wasIncoming.clear();
        lastVoiceId = null;
        dismissedTalk.clear();
        talkStart.clear();
        speakers.clear();
        if (shownChannelId) hide("missed");
    },

    /** Вызывается из главного процесса: строка для журнала. */
    onNativeLog(text: string) {
        log(String(text));
    },

    /** Вызывается из главного процесса: панель перетащили на новое место. */
    onOverlayMoved(x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        settings.store.posX = Math.round(x);
        settings.store.posY = Math.round(y);
        settings.store.position = "custom";
    },

    /** Вызывается из главного процесса: нажата кнопка или горячая клавиша. */
    onOverlayAction(action: "accept" | "decline" | "dismiss") {
        const id = shownChannelId;
        const mode = shownMode;
        if (!id) return;
        hide(action === "dismiss" ? "missed" : action);
        if (id === TEST_ID) return;

        if (mode === "talk") {
            if (action === "dismiss") dismissedTalk.add(id);
            else if (SelectedChannelStore.getVoiceChannelId() === id) VoiceActions.selectVoiceChannel(null);
            return;
        }
        if (action === "dismiss") return;

        if (mode === "out") {
            // сброс исходящего — выходим из звонка
            if (SelectedChannelStore.getVoiceChannelId() === id) VoiceActions.selectVoiceChannel(null);
            return;
        }

        handled.add(id);
        if (action === "accept") {
            VoiceActions.selectVoiceChannel(id);
        } else {
            RestAPI.post({ url: `/channels/${id}/call/stop-ringing`, body: {} }).catch(() => { });
        }
    }
});

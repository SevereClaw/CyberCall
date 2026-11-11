/*
 * CyberCall — входящий звонок Discord в киберпанк-стиле поверх игр и рабочего стола.
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { CallStore, ChannelStore, IconUtils, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.CyberCall as PluginNative<typeof import("./native")>;
const VoiceActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

const TEST_ID = "cybercall-test";
const FALLBACK_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

type Mode = "in" | "out";

/** id канала, звонок из которого сейчас показан в оверлее */
let shownChannelId: string | null = null;
/** какой это звонок: входящий или исходящий */
let shownMode: Mode = "in";
/** каналы, где звонили мне: после ответа там не показываем панель исходящего */
const wasIncoming = new Set<string>();
/** звонки, на которые уже ответили — чтобы оверлей не всплыл повторно, пока Discord обновляет состояние */
const handled = new Set<string>();
let testTimer: ReturnType<typeof setTimeout> | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
/** новая сборка уже скачана и ждёт перезапуска */
let updateReady = false;

const UPDATE_INTERVAL = 3 * 60 * 60 * 1000;

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
        description: "Угол экрана",
        options: [
            { label: "Слева сверху", value: "top-left", default: true },
            { label: "Справа сверху", value: "top-right" },
            { label: "Слева снизу", value: "bottom-left" },
            { label: "Справа снизу", value: "bottom-right" }
        ]
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
    showOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Показывать панель исходящего вызова, когда звонишь ты (сброс — клавишей «Отклонить»)",
        default: true
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
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={() => showTest("in")}>Тест входящего</Button>
                <Button onClick={() => showTest("out")}>Тест исходящего</Button>
                <Button variant="secondary" onClick={() => checkUpdate(true)}>Проверить обновления</Button>
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
            avatar: absolute(IconUtils.getUserAvatarURL(u, false, 256))
        };
    }

    // Групповой звонок
    const names = users.map(u => (u as any).globalName || u.username).join(", ");
    return {
        name: channel?.name || names || "Неизвестный абонент",
        sub: users.length ? `Группа · ${users.length + 1} участников` : "Discord",
        avatar: absolute(
            (channel && IconUtils.getChannelIconURL({ id: channel.id, icon: (channel as any).icon, size: 256 }))
            || (users[0] && IconUtils.getUserAvatarURL(users[0], false, 256))
        )
    };
}

function show(channelId: string, mode: Mode, info: { name: string; sub: string; avatar: string; }) {
    shownChannelId = channelId;
    shownMode = mode;
    const s = settings.store;
    Native.showCall({
        ...info,
        mode,
        acceptKey: s.acceptKey,
        declineKey: s.declineKey,
        position: s.position as any,
        ringtonePath: s.ringtonePath,
        ringtoneVolume: s.ringtoneVolume
    });
}

function hide(kind: "accept" | "decline" | "missed") {
    shownChannelId = null;
    clearTimeout(testTimer);
    Native.hideCall(kind);
}

function showTest(mode: Mode) {
    const me = UserStore.getCurrentUser();
    show(TEST_ID, mode, {
        name: (me as any)?.globalName || me?.username || "Тестовый абонент",
        sub: "Тестовый вызов",
        avatar: me ? absolute(IconUtils.getUserAvatarURL(me, false, 256)) : FALLBACK_AVATAR
    });
    clearTimeout(testTimer);
    testTimer = setTimeout(() => shownChannelId === TEST_ID && hide("missed"), 15_000);
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

    for (const id of ringing) wasIncoming.add(id);
    for (const id of wasIncoming) if (!live.has(id)) wasIncoming.delete(id);
    for (const id of handled) if (!ringing.has(id)) handled.delete(id);

    // Исходящий: я сижу в звонке, который начал сам, и кому-то ещё идут гудки
    const voiceId = SelectedChannelStore.getVoiceChannelId();
    const outgoing = settings.store.showOutgoing && voiceId && !wasIncoming.has(voiceId)
        && calls.some(c => c.channelId === voiceId && c.ringing?.some(id => id !== meId))
        ? voiceId
        : null;

    if (shownChannelId && shownChannelId !== TEST_ID) {
        if (shownMode === "in" && !ringing.has(shownChannelId)) {
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
    } else if (outgoing && !shownChannelId) {
        show(outgoing, "out", describe(outgoing));
    }
}

const scheduleSync = () => { setTimeout(sync, 60); };

export default definePlugin({
    name: "CyberCall",
    description: "Входящие и исходящие звонки в киберпанк-стиле поверх игр и рабочего стола: глитч-анимация, кнопки и горячие клавиши.",
    authors: [{ name: "SevereClaw", id: 0n }],
    settings,

    flux: {
        CALL_CREATE: scheduleSync,
        CALL_UPDATE: scheduleSync,
        CALL_DELETE: scheduleSync,
        VOICE_CHANNEL_SELECT: scheduleSync,
        CONNECTION_OPEN: scheduleSync
    },

    start() {
        scheduleSync();
        setTimeout(() => checkUpdate(), 15_000);
        updateTimer = setInterval(() => checkUpdate(), UPDATE_INTERVAL);
    },

    stop() {
        clearInterval(updateTimer);
        handled.clear();
        wasIncoming.clear();
        if (shownChannelId) hide("missed");
    },

    /** Вызывается из главного процесса: нажата кнопка или горячая клавиша. */
    onOverlayAction(action: "accept" | "decline") {
        const id = shownChannelId;
        const mode = shownMode;
        if (!id) return;
        hide(action);
        if (id === TEST_ID) return;

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

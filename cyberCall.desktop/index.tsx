/*
 * CyberCall — входящий звонок Discord в киберпанк-стиле поверх игр и рабочего стола.
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { CallStore, ChannelStore, IconUtils, RestAPI, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.CyberCall as PluginNative<typeof import("./native")>;
const VoiceActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

const TEST_ID = "cybercall-test";
const FALLBACK_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

/** id канала, звонок из которого сейчас показан в оверлее */
let shownChannelId: string | null = null;
/** звонки, на которые уже ответили — чтобы оверлей не всплыл повторно, пока Discord обновляет состояние */
const handled = new Set<string>();
let testTimer: ReturnType<typeof setTimeout> | undefined;

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
    test: {
        type: OptionType.COMPONENT,
        description: "Проверка",
        component: () => (
            <Button onClick={() => showTest()}>Показать тестовый звонок</Button>
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

function show(channelId: string, info: { name: string; sub: string; avatar: string; }) {
    shownChannelId = channelId;
    const s = settings.store;
    Native.showCall({
        ...info,
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

function showTest() {
    const me = UserStore.getCurrentUser();
    show(TEST_ID, {
        name: (me as any)?.globalName || me?.username || "Тестовый абонент",
        sub: "Тестовый вызов",
        avatar: me ? absolute(IconUtils.getUserAvatarURL(me, false, 256)) : FALLBACK_AVATAR
    });
    clearTimeout(testTimer);
    testTimer = setTimeout(() => shownChannelId === TEST_ID && hide("missed"), 15_000);
}

/** Сверяет оверлей с тем, что сейчас реально звонит в Discord. */
function sync() {
    const meId = UserStore.getCurrentUser()?.id;
    if (!meId) return;

    const calls = CallStore.getCalls() ?? [];
    const ringing = new Set<string>(calls.filter(c => c?.ringing?.includes(meId)).map(c => c.channelId));

    for (const id of handled) if (!ringing.has(id)) handled.delete(id);

    if (shownChannelId && shownChannelId !== TEST_ID && !ringing.has(shownChannelId)) hide("missed");

    if (!shownChannelId || shownChannelId === TEST_ID) {
        const next = [...ringing].find(id => !handled.has(id));
        if (next) show(next, describe(next));
    }
}

const scheduleSync = () => { setTimeout(sync, 60); };

export default definePlugin({
    name: "CyberCall",
    description: "Входящий звонок в киберпанк-стиле поверх игр и рабочего стола: глитч-анимация, кнопки и горячие клавиши.",
    authors: [{ name: "SevereClaw", id: 0n }],
    settings,

    flux: {
        CALL_CREATE: scheduleSync,
        CALL_UPDATE: scheduleSync,
        CALL_DELETE: scheduleSync,
        CONNECTION_OPEN: scheduleSync
    },

    start() {
        scheduleSync();
    },

    stop() {
        handled.clear();
        if (shownChannelId) hide("missed");
    },

    /** Вызывается из главного процесса: нажата кнопка или горячая клавиша. */
    onOverlayAction(action: "accept" | "decline") {
        const id = shownChannelId;
        if (!id) return;
        hide(action);
        if (id === TEST_ID) return;

        handled.add(id);
        if (action === "accept") {
            VoiceActions.selectVoiceChannel(id);
        } else {
            RestAPI.post({ url: `/channels/${id}/call/stop-ringing`, body: {} }).catch(() => { });
        }
    }
});

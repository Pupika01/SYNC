const $ = (id) => document.getElementById(id);
const { parseVideoSource } = window.SYNC_VIDEO_UTILS || {};
const { safeStorageGet, safeStorageSet, safeStorageRemove, isRoomCode, createPerKeyRateLimiter, createRollingRateLimiter } = window.SYNC_UTILS || {};
const roomDialog = $("roomDialog");
const joinDialog = $("joinDialog");
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let roomCode = "";
let channel = null;
let roomRole = "guest";
let toastTimer;
let supabaseClient = null;
let syncAuthUI = null;
let lastGoogleUser = null;
let vkVideoPlayer = null;
let vkPlayerApiReady = false;
let currentVideoEmbed = "";
let pendingRemoteControl = null;
let suppressControlBroadcastUntil = 0;
let lastObservedPlayerTime = null;
let lastPlayerState = "";
let syncHeartbeatTimer = null;
let heldByBuffer = false, localBuffering = false, bufTimer = null, hlsInstance = null, ytApiPromise = null, altCleanup = null;
let hostOnlyFlag = false, lastHostOnly = false, reconnectTimer = null, reconnectAttempt = 0;
const bufferingPeers = new Map();
const clientId = makeId();
const sessionJoinedAt = new Date().toISOString();

function makeId() {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}
function makeCode() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes); // alphabet has 32 symbols, so `& 31` is unbiased
  return Array.from(bytes, (b) => codeAlphabet[b & 31]).join("");
}
function getDisplayName() {
  return String(safeStorageGet("localStorage", "syncName", "Гость") || "Гость").trim().slice(0, 20) || "Гость";
}
function configReady() {
  const cfg = window.SYNC_CONFIG || {};
  return Boolean(
    window.supabase?.createClient &&
    typeof cfg.url === "string" && cfg.url.startsWith("https://") &&
    typeof cfg.publishableKey === "string" && cfg.publishableKey.length > 20 &&
    !cfg.url.includes("PASTE_") && !cfg.publishableKey.includes("PASTE_")
  );
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}
function setConnectionStatus(text, state = "neutral") {
  const status = $("connectionStatus");
  if (!status) return;
  status.lastChild.textContent = ` ${text}`;
  status.dataset.state = state;
  status.title = text;
}

function updateGoogleAuthUI(user) {
  if (!syncAuthUI) return;
  const signedIn = Boolean(user);
  const label = user?.email || user?.user_metadata?.full_name || user?.user_metadata?.name || "Аккаунт Google";
  syncAuthUI.signInButton.hidden = signedIn;
  syncAuthUI.account.hidden = !signedIn;
  syncAuthUI.signOutButton.hidden = !signedIn;
  syncAuthUI.account.textContent = label;
  syncAuthUI.account.title = label;
  syncAuthUI.account.setAttribute("aria-label", `Вы вошли как ${label}`);
  lastGoogleUser = user;
  refreshSelfAvatar();
  refreshWelcomeAuth();
  refreshProfileGoogle();
  syncAuthUI.signInButton.disabled = false;
  syncAuthUI.signOutButton.disabled = false;
}

function setupGoogleAuthUI() {
  const topActions = document.querySelector(".top-actions");
  const avatar = $("avatar");
  if (!topActions || !avatar || $("syncAuthControls")) return;


  const controls = document.createElement("div");
  controls.id = "syncAuthControls";
  controls.className = "sync-auth-controls";

  const signInButton = document.createElement("button");
  signInButton.type = "button";
  signInButton.className = "sync-auth-button";
  signInButton.title = "Продолжить с Google";
  signInButton.setAttribute("aria-label", "Продолжить с Google");
  const googleMark = document.createElement("span");
  googleMark.className = "sync-auth-google-mark";
  googleMark.setAttribute("aria-hidden", "true");
  googleMark.textContent = "G";
  const longLabel = document.createElement("span");
  longLabel.className = "sync-auth-long-label";
  longLabel.textContent = "Продолжить с Google";
  const shortLabel = document.createElement("span");
  shortLabel.className = "sync-auth-short-label";
  shortLabel.textContent = "Google";
  signInButton.append(googleMark, longLabel, shortLabel);
  signInButton.addEventListener("click", signInWithGoogle);

  const account = document.createElement("span");
  account.className = "sync-auth-account";
  account.hidden = true;

  const signOutButton = document.createElement("button");
  signOutButton.type = "button";
  signOutButton.className = "sync-auth-button";
  signOutButton.textContent = "Выйти";
  signOutButton.title = "Выйти из аккаунта Google";
  signOutButton.hidden = true;
  signOutButton.addEventListener("click", signOutGoogle);

  controls.append(signInButton, account, signOutButton);
  topActions.insertBefore(controls, avatar);
  syncAuthUI = { controls, signInButton, account, signOutButton };
}

async function signInWithGoogle() {
  if (!supabaseClient) {
    showToast("Supabase пока не подключён. Проверь config.js.");
    return;
  }
  const button = syncAuthUI?.signInButton;
  if (button) button.disabled = true;
  try {
    const params = new URLSearchParams(location.search);
    const pendingRoom = params.get("room") || roomCode;
    if (pendingRoom) safeStorageSet("sessionStorage", "syncPendingAuthRoom", pendingRoom);
    else safeStorageRemove("sessionStorage", "syncPendingAuthRoom");

    // Return to the project's base URL, which should be in Supabase's Redirect URLs allowlist.
    const redirectTo = new URL("./", location.href).toString();
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" }
      }
    });
    if (error) throw error;
  } catch (error) {
    console.error("SYNC Google sign-in error", error);
    safeStorageRemove("sessionStorage", "syncPendingAuthRoom");
    showToast("Не удалось начать вход. Проверь настройки Google в Supabase.");
    if (button) button.disabled = false;
  }
}

async function signOutGoogle() {
  if (!supabaseClient) return;
  const button = syncAuthUI?.signOutButton;
  if (button) button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  } catch (error) {
    console.error("SYNC Google sign-out error", error);
    showToast("Не удалось выйти из аккаунта. Попробуй ещё раз.");
    if (button) button.disabled = false;
  }
}
function currentInviteUrl() {
  const url = new URL(location.href);
  if (roomCode) url.searchParams.set("room", roomCode);
  return url.toString();
}
function refreshRoomUI() {
  $("roomCode").textContent = roomCode || "——————————";
  updatePresenceUI();
  $("leaveRoom").hidden = !roomCode;
  $("lobby").hidden = Boolean(roomCode);
  $("stage").hidden = !roomCode;
  $("copyInvite").textContent = navigator.share ? "↗ Поделиться" : "↗ Пригласить";
  syncRoomSettings();
}
function openInviteDialog(title = "Твоя комната готова") {
  $("dialogTitle").textContent = title;
  $("dialogText").textContent = "Отправь другу ссылку-приглашение. Когда он откроет её, вы появитесь в одной комнате и сможете писать друг другу в реальном времени.";
  $("inviteUrl").textContent = currentInviteUrl();
  roomDialog.showModal();
}
const MAX_CHAT_ENTRIES = 250;
const CHAT_RATE_WINDOW_MS = 10_000;
const CHAT_RATE_LIMIT = 8;
const incomingChatLimiter = createPerKeyRateLimiter(100);
const outgoingChatLimiter = createRollingRateLimiter(CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS);
function trimChatHistory() {
  const root = $("messages");
  while (root.children.length > MAX_CHAT_ENTRIES) root.firstElementChild?.remove();
}
function allowChatActivity(client, incoming = false) {
  if (!incoming) return outgoingChatLimiter();
  if (typeof client !== "string" || !client || client.length > 120) return false;
  return incomingChatLimiter(client, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS);
}
function addSystemMessage(_text) {
  // Keep the chat focused on participant messages; room/video status is handled by the UI and toasts.
}
function addChatMessage(message, isOwn = false) {
  if (!message || typeof message.text !== "string" || !message.text.trim()) return;
  const cleanText = message.text.trim().slice(0, 300);
  const item = document.createElement("div");
  item.className = `chat-message${isOwn ? " is-own" : ""}`;
  const who = isOwn ? { name: getDisplayName(), avatar: myAvatar() } : (presencePeople().find((p) => p.clientId === message.clientId) || { name: message.name });
  const pic = document.createElement("span");
  pic.className = "chat-pic";
  pic.setAttribute("aria-hidden", "true");
  paintAvatar(pic, who.name, who.avatar);
  const body = document.createElement("span");
  body.className = "chat-body";
  const author = document.createElement("b");
  author.className = "chat-author";
  author.textContent = isOwn ? "Ты" : String(message.name || who.name || "Гость").slice(0, 20);
  const text = document.createElement("span");
  text.className = "chat-text";
  text.textContent = cleanText;
  body.append(author, text);
  item.append(pic, body);
  if (!isOwn && document.hidden) { unread++; document.title = `(${unread}) ${baseTitle}`; }
  $("messages").appendChild(item);
  trimChatHistory();
  $("messages").scrollTop = $("messages").scrollHeight;
}
function updatePresenceUI() {
  const root = $("members");
  if (!root) return;
  root.replaceChildren();
  let people = [];
  if (channel) {
    try {
      people = Object.values(channel.presenceState()).flat().filter((p) => p && p.clientId);
    } catch { /* channel is reconnecting */ }
  }
  const distinct = new Map();
  for (const person of people) distinct.set(person.clientId, person);
  people = [...distinct.values()];
  $("memberCount").textContent = String(people.length);
  if (!people.length) {
    const empty = document.createElement("div");
    empty.className = "panel-note empty-members";
    empty.textContent = "Открой комнату по приглашению, чтобы увидеть участников.";
    root.appendChild(empty);
    return;
  }
  for (const person of people) {
    const self = person.clientId === clientId;
    const row = document.createElement("div");
    row.className = "member";
    const avatar = document.createElement("span");
    avatar.className = `person-avatar${self ? " self" : ""}`;
    paintAvatar(avatar, person.name, person.avatar);
    const details = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = self ? `${person.name || getDisplayName()} (ты)` : String(person.name || "Гость").slice(0, 20);
    const role = document.createElement("small");
    role.textContent = person.role === "host" ? "Организатор" : "Участник";
    details.append(name, role);
    row.append(avatar, details);
    if (!self && /^[A-Z0-9]{10}$/.test(person.friendCode || "")) {
      const known = findFriend(person.friendCode);
      const add = document.createElement("button");
      add.type = "button"; add.className = "mini-btn";
      add.textContent = known ? (known.status === "friend" ? "друг ✓" : "ждёт ответа") : "＋ В друзья";
      add.disabled = Boolean(known);
      add.addEventListener("click", () => addFriendByCode(person.friendCode, person.name, person.avatar));
      row.appendChild(add);
    }
    if (self) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "ВЫ";
      row.appendChild(tag);
    }
    root.appendChild(row);
  }
}
function startHeartbeat(chan) {
  if (syncHeartbeatTimer) clearInterval(syncHeartbeatTimer);
  syncHeartbeatTimer = setInterval(() => {
    if (!channel || channel !== chan || !currentVideoEmbed || heldByBuffer) return;
    const state = readVkPlayerState();
    if (!state || !["playing", "paused"].includes(state.state)) return;
    chan.send({ type: "broadcast", event: "video-state", payload: {
      clientId, url: currentVideoEmbed, state: state.state, time: state.time, rate: currentRate, sentAt: Date.now()
    }}).catch((error) => console.warn("SYNC heartbeat failed", error));
  }, 4500);
}
// If nobody in the room is the organizer any more, the earliest participant takes over.
function electHostIfNeeded() {
  if (!channel || roomRole === "host") return;
  const byId = new Map();
  for (const p of Object.values(channel.presenceState()).flat()) if (p && p.clientId) byId.set(p.clientId, p);
  const people = [...byId.values()];
  if (!people.length || people.some((p) => p.role === "host")) return;
  people.sort((x, y) => String(x.joinedAt).localeCompare(String(y.joinedAt)) || String(x.clientId).localeCompare(String(y.clientId)));
  if (people[0].clientId !== clientId) return;
  roomRole = "host";
  try { sessionStorage.setItem(`syncHost-${roomCode}`, "1"); } catch { /* ignore */ }
  channel.track(selfPresence()).catch(() => {});
  startHeartbeat(channel);
  addSystemMessage("Организатор вышел — теперь организатор ты.");
}
async function leaveCurrentRoom() {
  const previous = channel;
  channel = null;
  if (syncHeartbeatTimer) { clearInterval(syncHeartbeatTimer); syncHeartbeatTimer = null; }
  if (previous && supabaseClient) {
    try { await supabaseClient.removeChannel(previous); } catch { /* ignore disconnect cleanup */ }
  }
  updatePresenceUI();
}
function channelMessageData(event) {
  return event && event.payload && typeof event.payload === "object" ? event.payload : event;
}
const inboundRoomEventLimiter = createPerKeyRateLimiter(250);
function allowRoomEvent(senderClientId, eventName, limit, windowMs = 5000) {
  if (typeof senderClientId !== "string" || !senderClientId || senderClientId.length > 120) return false;
  return inboundRoomEventLimiter(`${senderClientId}:${eventName}`, limit, windowMs);
}
async function connectToRoom(code, role = "guest", quiet = false) {
  code = String(code || "").toUpperCase();
  if (!isRoomCode(code)) {
    if (!quiet) showToast("Код комнаты должен содержать 10 букв или цифр.");
    return false;
  }
  if (!supabaseClient) {
    showToast("Сначала подключи Supabase в файле config.js");
    setConnectionStatus("нужна настройка", "error");
    return false;
  }
  if (!quiet) {
    clearTimeout(reconnectTimer); reconnectTimer = null; reconnectAttempt = 0;
  }
  await leaveCurrentRoom();
  if (!quiet) {
    if (roomCode) { teardownPlayer(); resetPlayerView(); }
    roomCode = "";
    roomRole = "guest";
    hostOnlyFlag = false;
    lastHostOnly = false;
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete("room");
    history.replaceState({}, "", cleanUrl);
    refreshRoomUI();
  }
  const newChannel = supabaseClient.channel(`sync-room-${code.toLowerCase()}`, {
    config: {
      private: false,
      broadcast: { self: false, ack: true },
      presence: { key: clientId }
    }
  });
  newChannel
    .on("broadcast", { event: "chat" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || typeof data.clientId !== "string" ||
          typeof data.text !== "string" || !data.text.trim() || data.text.length > 1000) return;
      if (!allowChatActivity(data.clientId, true)) return;
      addChatMessage({ clientId: data.clientId, name: String(data.name || "Гость").slice(0, 20), text: data.text.slice(0, 300) }, false);
    })
    .on("broadcast", { event: "video" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video", 3, 10_000)) return;
      if (data.to && data.to !== clientId) return;
      if (hostOnlyMode() && !isHostClient(data.clientId)) return;
      if (typeof data.url === "string" && data.url.length <= 2048 && data.url !== currentVideoEmbed) setVideo(data.url, false, true);
    })
    .on("broadcast", { event: "video-control" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video-control", 20, 5000)) return;
      if (data.to && data.to !== clientId) return;
      if (hostOnlyMode() && !isHostClient(data.clientId)) return;
      applyRemoteVideoControl(data);
    })
    .on("broadcast", { event: "video-state" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video-state", 5, 10_000) || !data.url || data.url !== currentVideoEmbed) return;
      applyRemoteVideoState(data);
    })
    .on("broadcast", { event: "video-state-request" }, async (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video-state-request", 5, 10_000) || !currentVideoEmbed || !channel) return;
      try {
        await channel.send({ type: "broadcast", event: "video", payload: { url: currentVideoEmbed, clientId, to: data.clientId } });
        const state = readVkPlayerState();
        if (state && ["playing", "paused"].includes(state.state)) {
          await channel.send({
            type: "broadcast",
            event: "video-control",
            payload: { clientId, to: data.clientId, rate: currentRate, action: state.state === "playing" ? "play" : "pause", time: state.time, sentAt: Date.now() }
          });
        }
      } catch (error) {
        console.warn("SYNC video state response failed", error);
      }
    })
    .on("broadcast", { event: "video-rate" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video-rate", 10, 5000)) return;
      if (hostOnlyMode() && !isHostClient(data.clientId)) return;
      applyRate(Number(data.rate));
    })
    .on("broadcast", { event: "video-buffer" }, (event) => {
      const data = channelMessageData(event);
      if (!data || data.clientId === clientId || !allowRoomEvent(data.clientId, "video-buffer", 6, 10_000)) return;
      if (data.buffering === true) {
        if (bufferingPeers.size < 32 || bufferingPeers.has(data.clientId)) bufferingPeers.set(data.clientId, Date.now());
      } else if (data.buffering === false) bufferingPeers.delete(data.clientId);
      updateBufferHold();
    })
    .on("presence", { event: "sync" }, () => { syncRoomSettings(); updatePresenceUI(); electHostIfNeeded(); pruneBuffering(); })
    .on("presence", { event: "join" }, ({ newPresences }) => {
      for (const p of newPresences || []) {
        if (p.clientId !== clientId) addSystemMessage(`${String(p.name || "Друг").slice(0, 20)} подключился к комнате.`);
      }
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      for (const p of leftPresences || []) {
        if (p.clientId !== clientId) addSystemMessage(`${String(p.name || "Участник").slice(0, 20)} вышел из комнаты.`);
      }
    });

  setConnectionStatus("подключаемся…", "pending");
  return new Promise((resolve) => {
    let finished = false;
    let wasSubscribed = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      resolve(ok);
    };
    const timeoutId = setTimeout(() => {
      if (channel === newChannel) channel = null;
      supabaseClient.removeChannel(newChannel).catch(() => {});
      if (!quiet) { roomCode = ""; roomRole = "guest"; refreshRoomUI(); }
      setConnectionStatus("нет связи", "error");
      if (!quiet) showToast("Не удалось подключиться. Проверь URL и ключ Supabase.");
      finish(false);
    }, 12000);

    channel = newChannel;
    newChannel.subscribe(async (status) => {
      // A late SUBSCRIBED event can arrive after the timeout already discarded this channel.
      if (finished && channel !== newChannel) { supabaseClient.removeChannel(newChannel).catch(() => {}); return; }
      if (status === "SUBSCRIBED") {
        roomCode = code;
        wasSubscribed = true;
        roomRole = role;
        if (role === "host") { try { sessionStorage.setItem(`syncHost-${code}`, "1"); } catch { /* ignore */ } }
        try {
          const trackResult = await newChannel.track(selfPresence());
          if (trackResult?.error) throw trackResult.error;
          if (channel !== newChannel) { supabaseClient.removeChannel(newChannel).catch(() => {}); finish(false); return; }
          history.replaceState({}, "", currentInviteUrl());
          refreshRoomUI();
          setConnectionStatus("в сети", "online");
          // Host periodically publishes the authoritative playback position so small drift can be corrected.
          if (roomRole === "host") startHeartbeat(newChannel);
          // Ask existing participants for the currently loaded video and playback position.
          newChannel.send({ type: "broadcast", event: "video-state-request", payload: { clientId } }).catch(() => {});
          finish(true);
        } catch (error) {
          console.error("SYNC presence error", error);
          if (channel === newChannel) channel = null;
          supabaseClient.removeChannel(newChannel).catch(() => {});
          if (!quiet) { roomCode = ""; roomRole = "guest"; refreshRoomUI(); }
          setConnectionStatus("ошибка подключения", "error");
          if (!quiet) showToast("Не удалось подтвердить подключение к комнате. Попробуй ещё раз.");
          finish(false);
        }
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        if (finished && channel !== newChannel) return; // stale callback from a channel we already dropped
        if (wasSubscribed && channel === newChannel) { // connection lost mid-session: rejoin with the same identity
          channel = null;
          supabaseClient.removeChannel(newChannel).catch(() => {});
          scheduleReconnect();
          return;
        }
        if (channel === newChannel) channel = null;
        if (!quiet) { roomCode = ""; roomRole = "guest"; refreshRoomUI(); }
        setConnectionStatus("нет связи", "error");
        if (!quiet) showToast("Supabase не подключился. Проверь настройки проекта.");
        finish(false);
      }
    });
  });
}
async function createRoom() {
  if (!supabaseClient) {
    showToast("Сначала настрой Supabase: заполни URL и Publishable key в config.js");
    return;
  }
  const code = makeCode();
  if (roomCode) { teardownPlayer(); resetPlayerView(); }
  const connected = await connectToRoom(code, "host");
  if (!connected) return;
  $("messages").replaceChildren();
  addSystemMessage(`Комната ${code} создана. Отправь другу ссылку-приглашение.`);
  openInviteDialog();
}
$("createRoom").addEventListener("click", createRoom);
$("joinRoom").addEventListener("click", () => joinDialog.showModal());
$("doneDialog").addEventListener("click", () => roomDialog.close());
$("copyInvite").addEventListener("click", async () => {
  if (!roomCode || !channel) { showToast("Сначала подключись к комнате"); return; }
  await shareInvite();
});
$("copyUrl").addEventListener("click", async () => {
  if (roomCode) await copyText(currentInviteUrl());
});
$("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("joinCodeInput").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 10) {
    showToast("Код комнаты состоит из 10 символов — проверь приглашение");
    return;
  }
  const button = event.submitter;
  if (button) { button.disabled = true; button.textContent = "Подключаемся…"; }
  if (roomCode && roomCode !== code) { teardownPlayer(); resetPlayerView(); }
  const connected = await connectToRoom(code, "guest");
  if (button) { button.disabled = false; button.textContent = "Подключиться"; }
  if (!connected) return;
  joinDialog.close();
  $("messages").replaceChildren();
  addSystemMessage(`Ты подключился к комнате ${roomCode}. Сообщения видны участникам в реальном времени.`);
});
async function copyText(text, msg = "Ссылка скопирована") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showToast(msg);
  }
}
$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim().slice(0, 300);
  if (!text) return;
  if (!channel) { showToast("Сначала создай комнату или войди по приглашению"); return; }
  if (!allowChatActivity(clientId, false)) { showToast("Небольшая пауза — отправляй сообщения чуть медленнее."); return; }
  input.value = "";
  const payload = { clientId, name: getDisplayName(), text, sentAt: Date.now() };
  try {
    const result = await channel.send({ type: "broadcast", event: "chat", payload });
    if (result?.status && result.status !== "ok") throw new Error(result.status);
    addChatMessage(payload, true);
  } catch (error) {
    console.error("SYNC chat send error", error);
    input.value = text;
    showToast("Сообщение не отправлено. Проверь соединение.");
  }
});

function readVkPlayerState() {
  if (!vkVideoPlayer) return null;
  try {
    let state = vkVideoPlayer.getState?.();
    let time = vkVideoPlayer.getCurrentTime?.();
    if (state && typeof state === "object") {
      time = Number.isFinite(Number(state.time)) ? Number(state.time) : time;
      state = state.state;
    }
    if (typeof state !== "string") state = lastPlayerState || "unknown";
    if (!Number.isFinite(Number(time))) time = lastObservedPlayerTime ?? 0;
    return { state, time: Math.max(0, Number(time) || 0) };
  } catch {
    return null;
  }
}
function sendVideoControl(action, time) {
  if (!channel || Date.now() < suppressControlBroadcastUntil || controlsLocked()) return;
  const numericTime = Number(time);
  const payload = {
    clientId,
    action,
    time: Number.isFinite(numericTime) ? Math.max(0, numericTime) : undefined,
    sentAt: Date.now()
  };
  channel.send({ type: "broadcast", event: "video-control", payload }).catch((error) => {
    console.warn("SYNC video control send failed", error);
  });
}
function applyRemoteVideoControl(data) {
  if (!data || typeof data.clientId !== "string" || data.clientId.length > 120 || !["play", "pause", "seek"].includes(data.action)) return;
  const sentAt = Number(data.sentAt);
  if (Number.isFinite(sentAt) && (Date.now() - sentAt > 15_000 || sentAt - Date.now() > 15_000)) return;
  if (!vkVideoPlayer || !vkPlayerApiReady) {
    // The iframe/API may still be initializing after a video-state response.
    pendingRemoteControl = data;
    return;
  }
  suppressControlBroadcastUntil = Date.now() + 2200;
  if (Number.isFinite(Number(data.rate))) applyRate(Number(data.rate));
  const time = Number(data.time);
  const safeTime = Number.isFinite(time) ? Math.max(0, ui.duration ? Math.min(time, ui.duration) : time) : null;
  try {
    if (safeTime !== null && (data.action === "seek" || Math.abs((lastObservedPlayerTime ?? 0) - safeTime) > 2.5)) {
      vkVideoPlayer.seek(safeTime);
      lastObservedPlayerTime = safeTime;
    }
    if (data.action === "play") {
      vkVideoPlayer.play();
      lastPlayerState = "playing";
    } else if (data.action === "pause") {
      vkVideoPlayer.pause();
      lastPlayerState = "paused";
    }
  } catch (error) {
    console.warn("SYNC could not control VK player", error);
    showToast("VK не разрешил удалённо управлять плеером. Попробуй нажать воспроизведение вручную.");
  }
}
function applyRemoteVideoState(data) {
  if (!data || typeof data.clientId !== "string" || data.clientId.length > 120 || heldByBuffer) return;
  const sentAt = Number(data.sentAt);
  if (Number.isFinite(sentAt) && Date.now() - sentAt > 12_000) return;
  if (Number.isFinite(Number(data?.rate)) && Number(data.rate) !== currentRate) applyRate(Number(data.rate));
  if (!data || !["playing", "paused"].includes(data.state)) return;
  if (!vkVideoPlayer || !vkPlayerApiReady) {
    pendingRemoteControl = { clientId: data.clientId, action: data.state === "playing" ? "play" : "pause", time: data.time, sentAt: data.sentAt };
    return;
  }
  const target = Number(data.time);
  const current = readVkPlayerState();
  if (!Number.isFinite(target) || !current) return;
  // Ignore stale heartbeats and tolerate a little network/buffering drift.
  const drift = target - current.time;
  suppressControlBroadcastUntil = Date.now() + 1900;
  try {
    if (Math.abs(drift) > 1.8) {
      vkVideoPlayer.seek(Math.max(0, target + (data.state === "playing" ? Math.max(0, Math.min(1.2, (Date.now() - Number(data.sentAt || Date.now())) / 1000)) : 0)));
      lastObservedPlayerTime = target;
    }
    if (data.state === "playing" && current.state !== "playing") vkVideoPlayer.play();
    if (data.state === "paused" && current.state !== "paused") vkVideoPlayer.pause();
    lastPlayerState = data.state;
  } catch (error) {
    console.warn("SYNC heartbeat correction failed", error);
  }
}

function attachVkPlayerApi() {
  const iframe = $("vkPlayer");
  if (!iframe.src || iframe.hidden) return;
  if (!window.VK || typeof window.VK.VideoPlayer !== "function") {
    $("playerStatus").textContent = "VK · API НЕДОСТУПНО";
    showToast("VK-плеер не предоставил API управления. Видео может играть, но синхронизация недоступна.");
    return;
  }
  try {
    if (vkVideoPlayer && typeof vkVideoPlayer.destroy === "function") vkVideoPlayer.destroy();
    vkPlayerApiReady = false;
    vkVideoPlayer = window.VK.VideoPlayer(iframe);
    lastObservedPlayerTime = null;
    lastPlayerState = "";

    const onPlaying = handlePlaying, onPaused = handlePaused, onTimeUpdate = handleTimeUpdate;

    vkVideoPlayer.on("started", onPlaying);
    vkVideoPlayer.on("resumed", onPlaying);
    vkVideoPlayer.on("paused", onPaused);
    vkVideoPlayer.on("timeupdate", onTimeUpdate);
    vkVideoPlayer.on("inited", () => {
      vkPlayerApiReady = true;
      $("playerStatus").textContent = "VK · СИНХРОНИЗАЦИЯ ГОТОВА";
      activateControls("vk");
      const pending = pendingRemoteControl;
      pendingRemoteControl = null;
      if (pending) applyRemoteVideoControl(pending);
    });
    $("playerStatus").textContent = "VK · API ПОДКЛЮЧЁН";
    // In case the API's `inited` event fired during iframe creation, drain a queued command too.
    setTimeout(() => {
      if (pendingRemoteControl && vkVideoPlayer && vkPlayerApiReady) {
        const pending = pendingRemoteControl;
        pendingRemoteControl = null;
        applyRemoteVideoControl(pending);
      }
    }, 900);
  } catch (error) {
    vkVideoPlayer = null;
    vkPlayerApiReady = false;
    $("playerStatus").textContent = "VK · БЕЗ СИНХРОНИЗАЦИИ";
    console.warn("SYNC VK player API init failed", error);
    showToast("Видео запущено, но API синхронизации VK недоступно для этой ссылки.");
  }
}
$("vkPlayer").addEventListener("load", () => {
  // The iframe is cross-origin; use VK's official player API rather than reading its page.
  setTimeout(attachVkPlayerApi, 150);
});
function setVideo(raw, broadcast = false, fromRemote = false) {
  const src = parseVideoSource(raw);
  if (!src) {
    if (!fromRemote) showToast("Не удалось распознать ссылку. Подойдут VK Видео, YouTube и прямые HTTPS-ссылки на mp4/webm/m3u8.");
    return false;
  }
  if (broadcast && controlsLocked()) { showToast("Сейчас видео выбирает организатор"); return false; }
  teardownPlayer();
  currentVideoEmbed = src.key;
  $("emptyPlayer").hidden = true;
  if (src.kind === "vk") {
    const frame = $("vkPlayer");
    frame.hidden = false;
    frame.src = src.key;
    $("playerStatus").textContent = "VK VIDEO · SYNC";
  } else if (src.kind === "yt") startYouTube(src.id);
  else startHtmlVideo(src.key);
  $("videoUrl").value = raw;
  if (fromRemote) addSystemMessage("Друг добавил видео в плеер.");
  else addSystemMessage("Видео загружено. Воспроизведение синхронизируется для участников комнаты, если источник это позволяет.");
  if (broadcast && channel) {
    channel.send({ type: "broadcast", event: "video", payload: { url: src.key, clientId } })
      .then((result) => { if (result?.status && result.status !== "ok") showToast("Видео открыто только у тебя"); })
      .catch(() => showToast("Видео открыто только у тебя"));
  }
  return true;
}
$("loadVideo").addEventListener("click", () => {
  const raw = $("videoUrl").value.trim();
  if (!raw) { showToast("Вставь ссылку на видео"); return; }
  if (setVideo(raw, true, false)) showToast("Отправили видео участникам комнаты");
});

// ---------- profile: nickname + photo (independent of the Google account) ----------
const store = {
  get(key, fallback = "") { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};
let unread = 0;
const baseTitle = document.title;
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unread = 0; document.title = baseTitle; } });
const AVATAR_HEAD = /^data:image\/(?:jpeg|png|webp);base64,/;
const safeAvatar = (v) => (typeof v === "string" && v.length > 60 && v.length < 70000 && AVATAR_HEAD.test(v) && !/[^A-Za-z0-9+/=]/.test(v.slice(v.indexOf(",") + 1)) ? v : "");
let memAvatar = ""; // keeps the photo for this session even if localStorage refuses to save it
const myAvatar = () => safeAvatar(store.get("syncAvatar")) || memAvatar;
function saveAvatar(dataUrl) {
  memAvatar = dataUrl || "";
  if (!dataUrl) { store.remove("syncAvatar"); return; }
  if (!store.set("syncAvatar", dataUrl)) showToast("Браузер не дал сохранить фото: оно будет видно до перезагрузки страницы.");
}
function paintAvatar(el, name, avatar) {
  if (safeAvatar(avatar)) {
    el.style.backgroundImage = `url("${avatar}")`;
    el.classList.add("has-pic", "avatar-has-image");
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.classList.remove("has-pic", "avatar-has-image");
    el.textContent = String(name || "Г").trim().slice(0, 1).toUpperCase();
  }
}
function refreshSelfAvatar() {
  const el = $("avatar");
  if (!el) return;
  paintAvatar(el, getDisplayName(), myAvatar());
  el.title = "Профиль: ник и фото. Нажми, чтобы изменить";
  el.setAttribute("aria-label", el.title);
}
function loadImage(src, cors = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}
function imageToAvatar(img) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("Пустое изображение");
  const size = 128, c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1a1928";
  ctx.fillRect(0, 0, size, size);
  const s = Math.min(w, h);
  ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  for (const q of [0.85, 0.7, 0.5]) { const out = c.toDataURL("image/jpeg", q); if (out.length < 40000) return out; }
  return c.toDataURL("image/jpeg", 0.35);
}
async function fileToAvatar(file) {
  if (!file) throw new Error("Файл не выбран");
  if (file.size > 25 * 1024 * 1024) throw new Error("Файл больше 25 МБ");
  try { return imageToAvatar(await createImageBitmap(file, { imageOrientation: "from-image" })); }
  catch (first) {
    if (first?.message === "Пустое изображение") throw first;
    const url = URL.createObjectURL(file);
    try { return imageToAvatar(await loadImage(url)); }
    catch { throw new Error("Не удалось открыть фото. Попробуй JPG или PNG (HEIC лучше сохранить как JPEG)."); }
    finally { URL.revokeObjectURL(url); }
  }
}
const googlePhotoUrl = () => {
  const m = lastGoogleUser?.user_metadata || {};
  const u = m.avatar_url || m.picture || "";
  return /^https:\/\//i.test(u) ? u : "";
};
let profileDialog = null, draftAvatar = "";
function buildProfileDialog() {
  const d = document.createElement("dialog");
  d.id = "profileDialog"; d.className = "modal";
  d.innerHTML = `<form method="dialog" class="modal-close"><button aria-label="Закрыть">×</button></form>
    <h2>Твой профиль</h2><p>Ник и фото видят друзья и участники комнат. Они не зависят от аккаунта Google.</p>
    <div class="profile-row"><div id="profilePreview" class="person-avatar big"></div><div class="profile-actions">
      <button type="button" class="btn btn-ghost compact" id="profilePick">Выбрать фото</button>
      <button type="button" class="btn btn-ghost compact" id="profileGoogle" hidden>Фото из Google</button>
      <button type="button" class="btn btn-ghost compact" id="profileClear">Убрать фото</button></div></div>
    <input type="file" id="profileFile" accept="image/*" hidden>
    <form id="profileForm"><input id="profileNick" class="modal-input" maxlength="20" placeholder="Твой ник" autocomplete="nickname" required><button class="btn btn-primary full" type="submit">Сохранить</button></form>
    <div class="profile-google"><span id="profileGoogleState"></span><button type="button" class="btn btn-ghost compact" id="profileGoogleBtn"></button></div>
    <p class="hint">Фото обрезается до квадрата 128×128 и хранится на этом устройстве.</p>`;
  document.body.appendChild(d);
  const q = (id) => d.querySelector(id);
  const repaint = () => paintAvatar(q("#profilePreview"), q("#profileNick").value || "Гость", draftAvatar);
  q("#profileNick").addEventListener("input", repaint);
  q("#profilePick").addEventListener("click", () => q("#profileFile").click());
  q("#profileFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { draftAvatar = await fileToAvatar(file); repaint(); } catch (err) { showToast(err.message); }
  });
  q("#profileGoogle").addEventListener("click", async () => {
    try { draftAvatar = imageToAvatar(await loadImage(googlePhotoUrl(), true)); repaint(); }
    catch { showToast("Google не отдал фото. Выбери файл из галереи."); }
  });
  q("#profileGoogleBtn").addEventListener("click", () => { if (lastGoogleUser) signOutGoogle(); else signInWithGoogle(); });
  q("#profileClear").addEventListener("click", () => { draftAvatar = ""; repaint(); });
  q("#profileForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const nick = q("#profileNick").value.trim().slice(0, 20);
    if (!nick) { showToast("Ник не должен быть пустым"); return; }
    store.set("syncName", nick);
    saveAvatar(draftAvatar);
    d.close();
    onProfileChanged();
    showToast(`Профиль сохранён: ${nick}`);
  });
  profileDialog = d;
}
function refreshProfileGoogle() {
  if (!profileDialog) return;
  const signed = Boolean(lastGoogleUser);
  profileDialog.querySelector("#profileGoogleState").textContent = signed ? `Google: ${lastGoogleUser.email || "подключён"}` : "Google не подключён (нужен для поиска видео)";
  profileDialog.querySelector("#profileGoogleBtn").textContent = signed ? "Выйти" : "Войти через Google";
}
function openProfile() {
  if (!profileDialog) buildProfileDialog();
  const nick = store.get("syncName");
  profileDialog.querySelector("#profileNick").value = nick;
  draftAvatar = myAvatar();
  paintAvatar(profileDialog.querySelector("#profilePreview"), nick || "Гость", draftAvatar);
  profileDialog.querySelector("#profileGoogle").hidden = !googlePhotoUrl();
  refreshProfileGoogle();
  profileDialog.showModal();
  profileDialog.querySelector("#profileNick").select();
}
function onProfileChanged() {
  refreshSelfAvatar();
  if (channel) channel.track(selfPresence()).catch(() => {});
  myPersonalChannel?.track(personalPresence()).catch(() => {});
  updatePresenceUI();
}

// ---------- confirm prompts (friend requests, invites) ----------
const promptQueue = [];
let promptBusy = false, promptDialog = null;
function askConfirm(opts) { promptQueue.push(opts); nextPrompt(); }
function nextPrompt() {
  if (promptBusy || !promptQueue.length) return;
  if (!promptDialog) {
    promptDialog = document.createElement("dialog");
    promptDialog.className = "modal";
    promptDialog.innerHTML = `<div class="profile-row"><div class="person-avatar big" id="promptAvatar"></div><div><h2 id="promptTitle"></h2><p id="promptText"></p></div></div>
      <div class="prompt-actions"><button type="button" class="btn btn-ghost compact" id="promptNo"></button><button type="button" class="btn btn-primary compact" id="promptYes"></button></div>`;
    document.body.appendChild(promptDialog);
    promptDialog.querySelector("#promptNo").addEventListener("click", () => promptDialog.close("no"));
    promptDialog.querySelector("#promptYes").addEventListener("click", () => promptDialog.close("ok"));
    promptDialog.addEventListener("close", () => {
      const done = promptBusy && promptDialog.currentOpts;
      promptBusy = false;
      if (done && promptDialog.returnValue === "ok") { try { done.onOk(); } catch (e) { console.warn(e); } }
      promptDialog.currentOpts = null;
      nextPrompt();
    });
  }
  const o = promptQueue.shift();
  promptBusy = true;
  promptDialog.currentOpts = o;
  promptDialog.returnValue = "no";
  promptDialog.querySelector("#promptTitle").textContent = o.title;
  promptDialog.querySelector("#promptText").textContent = o.text;
  promptDialog.querySelector("#promptYes").textContent = o.ok;
  promptDialog.querySelector("#promptNo").textContent = o.cancel || "Позже";
  paintAvatar(promptDialog.querySelector("#promptAvatar"), o.name, o.avatar);
  promptDialog.showModal();
}

// ---------- friends (serverless: personal Realtime channels, list kept on this device) ----------
let _friendCode = "";
function myFriendCode() {
  if (_friendCode) return _friendCode;
  let c = store.get("syncFriendCode");
  if (!/^[A-Z0-9]{10}$/.test(c)) { c = makeCode(); store.set("syncFriendCode", c); }
  return (_friendCode = c);
}
function loadFriends() {
  try {
    const list = JSON.parse(store.get("syncFriends", "[]"));
    return Array.isArray(list) ? list.filter((f) => f && /^[A-Z0-9]{10}$/.test(f.code)).slice(0, 30).map((f) => ({
      code: f.code, name: String(f.name || "Друг").slice(0, 20), avatar: safeAvatar(f.avatar),
      status: f.status === "pending" ? "pending" : "friend", addedAt: Number(f.addedAt) || Date.now()
    })) : [];
  } catch { return []; }
}
let friends = loadFriends();
const watchers = new Map(); // friend code -> { chan, ready, online, requested }
let myPersonalChannel = null, lastInvite = { room: "", at: 0 };
const findFriend = (code) => friends.find((f) => f.code === code);
const isOnline = (code) => Boolean(watchers.get(code)?.online);
const personalPresence = () => ({ code: myFriendCode(), name: getDisplayName(), avatar: myAvatar() });
function saveFriends() {
  store.set("syncFriends", JSON.stringify(friends));
  renderFriends();
  updatePresenceUI();
}
function friendLink() {
  const u = new URL("./", location.href);
  u.searchParams.set("friend", myFriendCode());
  return u.toString();
}
function watchFriend(code) {
  if (!supabaseClient) return null;
  if (watchers.has(code)) return watchers.get(code);
  const w = { online: false, requested: false };
  const ch = supabaseClient.channel(`sync-user-${code.toLowerCase()}`, { config: { broadcast: { self: false } } });
  w.chan = ch;
  w.ready = new Promise((resolve) => {
    ch.on("presence", { event: "sync" }, () => onFriendPresence(code))
      .subscribe((s) => { if (s === "SUBSCRIBED") resolve(true); else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(s)) resolve(false); });
  });
  watchers.set(code, w);
  return w;
}
async function sendTo(code, event, payload) {
  const w = watchFriend(code);
  if (!w || !(await w.ready)) return false;
  try {
    const r = await w.chan.send({ type: "broadcast", event, payload });
    return !(r === "error" || r === "timed out" || (r?.status && r.status !== "ok"));
  } catch { return false; }
}
function sendFriendRequest(code) {
  const w = watchers.get(code);
  if (!w || w.requested) return;
  w.requested = true;
  sendTo(code, "friend-request", personalPresence());
}
function onFriendPresence(code) {
  const w = watchers.get(code), f = findFriend(code);
  if (!w || !f) return;
  const list = Object.values(w.chan.presenceState()).flat();
  const was = w.online;
  w.online = list.length > 0;
  const info = list[0];
  if (info) {
    if (typeof info.name === "string" && info.name.trim()) f.name = info.name.slice(0, 20);
    f.avatar = safeAvatar(info.avatar);
  }
  if (w.online && !was && f.status === "pending") sendFriendRequest(code);
  if (!w.online) w.requested = false;
  store.set("syncFriends", JSON.stringify(friends));
  renderFriends();
}
function addFriendByCode(raw, name = "", avatar = "") {
  const code = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 10) { showToast("Код друга состоит из 10 символов"); return false; }
  if (code === myFriendCode()) { showToast("Это твой собственный код"); return false; }
  const known = findFriend(code);
  if (known) { showToast(known.status === "friend" ? "Он уже у тебя в друзьях" : "Запрос уже отправлен"); return false; }
  if (friends.length >= 30) { showToast("В списке может быть не больше 30 друзей"); return false; }
  if (!supabaseClient) { showToast("Сначала подключи Supabase в config.js"); return false; }
  friends.push({ code, name: name ? String(name).slice(0, 20) : `Друг ${code.slice(0, 4)}`, avatar: safeAvatar(avatar), status: "pending", addedAt: Date.now() });
  saveFriends();
  const w = watchFriend(code);
  w.ready.then(() => { if (findFriend(code)?.status === "pending" && w.online) sendFriendRequest(code); });
  showToast("Запрос отправлен. Друг увидит его, когда зайдёт в SYNC");
  return true;
}
function removeFriend(code) {
  friends = friends.filter((f) => f.code !== code);
  const w = watchers.get(code);
  if (w) { supabaseClient?.removeChannel(w.chan).catch(() => {}); watchers.delete(code); }
  saveFriends();
}
function onFriendRequest(d) {
  if (!d || !/^[A-Z0-9]{10}$/.test(d.code || "") || d.code === myFriendCode()) return;
  const name = String(d.name || "Гость").slice(0, 20), avatar = safeAvatar(d.avatar);
  const accept = () => sendTo(d.code, "friend-accept", personalPresence());
  const known = findFriend(d.code);
  if (known) {
    const wasPending = known.status === "pending";
    known.name = name; known.avatar = avatar; known.status = "friend";
    saveFriends(); accept();
    if (wasPending) showToast(`${name} теперь в друзьях`);
    return;
  }
  if (friends.length >= 30) return;
  askConfirm({ title: "Запрос в друзья", text: `${name} хочет добавить тебя в друзья.`, ok: "Принять", cancel: "Отклонить", name, avatar,
    onOk: () => { friends.push({ code: d.code, name, avatar, status: "friend", addedAt: Date.now() }); saveFriends(); watchFriend(d.code); accept(); showToast(`${name} теперь в друзьях`); } });
}
function onFriendAccept(d) {
  const f = d && findFriend(d.code);
  if (!f || f.status !== "pending") return;
  f.status = "friend";
  if (typeof d.name === "string" && d.name.trim()) f.name = d.name.slice(0, 20);
  f.avatar = safeAvatar(d.avatar);
  saveFriends();
  showToast(`${f.name} теперь в друзьях`);
}
function onInvite(d) {
  const f = d && findFriend(d.code);
  const room = String(d?.room || "").toUpperCase();
  if (!f || f.status !== "friend" || !/^[A-Z0-9]{10}$/.test(room) || room === roomCode) return;
  if (lastInvite.room === room && Date.now() - lastInvite.at < 20000) return;
  lastInvite = { room, at: Date.now() };
  askConfirm({ title: `${f.name} зовёт смотреть вместе`, text: roomCode ? "Ты выйдешь из текущей комнаты." : "Войти в комнату друга?", ok: "Войти", cancel: "Позже", name: f.name, avatar: f.avatar,
    onOk: async () => {
      teardownPlayer(); resetPlayerView();
      if (await connectToRoom(room, "guest")) { $("messages").replaceChildren(); addSystemMessage(`Ты в комнате ${room} (приглашение от ${f.name}).`); }
    } });
}
function inviteFriend(code) {
  if (!channel || !roomCode) { showToast("Сначала создай комнату или войди в неё"); return; }
  sendTo(code, "invite", { code: myFriendCode(), name: getDisplayName(), room: roomCode }).then((ok) => showToast(ok ? "Приглашение отправлено" : "Не удалось отправить приглашение"));
}
function startFriends() {
  if (!supabaseClient || myPersonalChannel) return;
  const ch = supabaseClient.channel(`sync-user-${myFriendCode().toLowerCase()}`, { config: { broadcast: { self: false }, presence: { key: clientId } } });
  ch.on("broadcast", { event: "friend-request" }, (e) => onFriendRequest(channelMessageData(e)))
    .on("broadcast", { event: "friend-accept" }, (e) => onFriendAccept(channelMessageData(e)))
    .on("broadcast", { event: "invite" }, (e) => onInvite(channelMessageData(e)))
    .subscribe((s) => { if (s === "SUBSCRIBED") ch.track(personalPresence()).catch(() => {}); });
  myPersonalChannel = ch;
  friends.forEach((f) => watchFriend(f.code));
  const params = new URLSearchParams(location.search);
  const link = params.get("friend");
  if (link) {
    params.delete("friend");
    const u = new URL(location.href); u.search = params.toString();
    history.replaceState({}, "", u);
    setTimeout(() => addFriendByCode(link), 800);
  }
}
let friendsDialog = null;
function setupFriendsUI() {
  const top = document.querySelector(".top-actions");
  if (!top || $("friendsBtn")) return;
  const b = document.createElement("button");
  b.id = "friendsBtn"; b.type = "button"; b.className = "btn btn-ghost compact"; b.textContent = "Друзья";
  b.addEventListener("click", openFriends);
  top.insertBefore(b, $("syncAuthControls") || $("avatar"));
}
function openFriends() {
  if (!friendsDialog) {
    const d = document.createElement("dialog");
    d.id = "friendsDialog"; d.className = "modal";
    d.innerHTML = `<form method="dialog" class="modal-close"><button aria-label="Закрыть">×</button></form>
      <h2>Друзья</h2><p>Отправь другу свой код или ссылку, чтобы он мог тебя добавить.</p>
      <div class="friend-code-row"><strong id="myFriendCodeText"></strong><button type="button" class="btn btn-ghost compact" id="copyFriendCode">Копировать</button><button type="button" class="btn btn-ghost compact" id="shareFriendCode">Поделиться</button></div>
      <form id="addFriendForm" class="friend-add"><input id="addFriendInput" class="modal-input" maxlength="14" placeholder="Код друга" autocomplete="off" required><button class="btn btn-primary compact" type="submit">Добавить</button></form>
      <div id="friendsList" class="friends-list"></div>
      <p class="hint">Друг получит запрос, когда зайдёт в SYNC. Позвать в комнату можно, когда вы оба в списках друг у друга и друг в сети. Список хранится на этом устройстве.</p>`;
    document.body.appendChild(d);
    d.querySelector("#copyFriendCode").addEventListener("click", () => copyText(myFriendCode(), "Код скопирован"));
    d.querySelector("#shareFriendCode").addEventListener("click", async () => {
      if (navigator.share) {
        try { await navigator.share({ title: "SYNC — смотрим вместе", text: `Добавляй меня в друзья в SYNC. Мой код: ${myFriendCode()}`, url: friendLink() }); return; }
        catch (err) { if (err?.name === "AbortError") return; }
      }
      copyText(friendLink());
    });
    d.querySelector("#addFriendForm").addEventListener("submit", (e) => {
      e.preventDefault();
      if (addFriendByCode(d.querySelector("#addFriendInput").value)) d.querySelector("#addFriendInput").value = "";
    });
    friendsDialog = d;
  }
  friendsDialog.querySelector("#myFriendCodeText").textContent = myFriendCode();
  renderFriends();
  friendsDialog.showModal();
}
function renderFriends() {
  const online = friends.filter((f) => f.status === "friend" && isOnline(f.code)).length;
  const btn = $("friendsBtn");
  if (btn) btn.textContent = online ? `Друзья · ${online}` : "Друзья";
  const root = $("friendsList");
  if (!root) return;
  root.replaceChildren();
  if (!friends.length) {
    const empty = document.createElement("div");
    empty.className = "panel-note";
    empty.textContent = "Пока никого. Введи код друга или отправь ему свой.";
    root.appendChild(empty);
    return;
  }
  const rows = [...friends].sort((x, y) => Number(isOnline(y.code)) - Number(isOnline(x.code)) || x.name.localeCompare(y.name));
  for (const f of rows) {
    const row = document.createElement("div");
    row.className = "member friend-row";
    const av = document.createElement("span");
    av.className = "person-avatar";
    paintAvatar(av, f.name, f.avatar);
    const info = document.createElement("span");
    info.className = "grow";
    const nm = document.createElement("b");
    nm.textContent = f.name;
    const st = document.createElement("small");
    if (f.status === "pending") st.textContent = "ждёт ответа";
    else if (isOnline(f.code)) { st.textContent = "● в сети"; st.className = "on"; }
    else st.textContent = "не в сети";
    info.append(nm, st);
    row.append(av, info);
    if (f.status === "friend" && isOnline(f.code) && channel && roomCode) {
      const inv = document.createElement("button");
      inv.type = "button"; inv.className = "mini-btn"; inv.textContent = "Позвать";
      inv.addEventListener("click", () => inviteFriend(f.code));
      row.appendChild(inv);
    }
    const del = document.createElement("button");
    del.type = "button"; del.className = "mini-btn danger"; del.textContent = "✕"; del.title = "Удалить из друзей";
    del.addEventListener("click", () => removeFriend(f.code));
    row.appendChild(del);
    root.appendChild(row);
  }
}

// ---------- side panel tabs ----------
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    for (const id of ["tabChat", "tabPeople"]) $(id).hidden = id !== tab.dataset.tab;
  });
}

// ---------- welcome screen: slogan, nickname, Google sign-in ----------
let welcomeResolve = () => {};
const welcomeDone = new Promise((resolve) => { welcomeResolve = resolve; });
let welcomeClosed = false, welcomeAvatar = "";
function repaintWelcomePhoto() {
  const el = $("welcomePhoto");
  if (welcomeAvatar) paintAvatar(el, "", welcomeAvatar);
  else { el.style.backgroundImage = ""; el.classList.remove("has-pic", "avatar-has-image"); el.textContent = "+"; }
}
function refreshWelcomeAuth() {
  const signed = Boolean(lastGoogleUser);
  $("welcomeGoogle").hidden = signed;
  $("welcomeOr").hidden = signed;
  $("welcomeHint").textContent = signed
    ? `Google подключён (${lastGoogleUser.email || "аккаунт"}). Осталось выбрать ник.`
    : "Вход через Google нужен для поиска видео. Ник и фото ты задаёшь сам, они не зависят от аккаунта Google.";
}
function closeWelcome() {
  if (welcomeClosed) return;
  welcomeClosed = true;
  $("welcome").hidden = true;
  document.body.style.overflow = "";
  welcomeResolve();
}
function saveWelcomeProfile() {
  const nick = $("welcomeNick").value.trim().slice(0, 20);
  if (!nick) return false;
  store.set("syncName", nick);
  if (welcomeAvatar) saveAvatar(welcomeAvatar);
  onProfileChanged();
  return true;
}
function showWelcome() {
  const w = $("welcome");
  const hasNick = Boolean(store.get("syncName"));
  const params = new URLSearchParams(location.search);
  if (hasNick) {
    let seen = false;
    seen = safeStorageGet("sessionStorage", "syncSplash", "") === "1";
    safeStorageSet("sessionStorage", "syncSplash", "1");
    if (seen) { closeWelcome(); return; }
    w.classList.add("splash");
    $("welcomeSub").textContent = `С возвращением, ${getDisplayName()}!`;
    const timer = setTimeout(closeWelcome, 3500);
    w.addEventListener("click", () => { clearTimeout(timer); closeWelcome(); });
  } else if (store.get("syncSkipped")) { closeWelcome(); return; }
  else if (params.get("room") || params.get("friend")) {
    $("welcomeSub").textContent = "Тебя позвали в SYNC. Осталось выбрать ник.";
  }
  refreshWelcomeAuth();
  w.hidden = false;
  document.body.style.overflow = "hidden";
  if (!hasNick) setTimeout(() => $("welcomeNick").focus(), 300);
}
$("welcomePhoto").addEventListener("click", () => $("welcomeFile").click());
$("welcomeFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try { welcomeAvatar = await fileToAvatar(file); repaintWelcomePhoto(); } catch (err) { showToast(err.message); }
});
$("welcomeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!saveWelcomeProfile()) { showToast("Придумай ник"); return; }
  showToast(`Добро пожаловать, ${getDisplayName()}!`);
  closeWelcome();
});
$("welcomeGoogle").addEventListener("click", () => { saveWelcomeProfile(); signInWithGoogle(); });
$("welcomeSkip").addEventListener("click", () => { store.set("syncSkipped", "1"); closeWelcome(); });

// ---------- SYNC player controls: our own interface over VK / YouTube / <video> ----------
const ui = { kind: "", duration: 0, dragging: false, muted: false, tick: null, idleTimer: null, seekPending: null, durationCheckedAt: 0, previousVolume: 1 };
let currentRate = 1;
const wrapEl = () => document.querySelector(".player-wrap");
const setFill = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
const rateFn = (p) => p && (p.setRate || p.setPlaybackRate || p.setSpeed);
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
function applyRate(r) {
  if (!(r >= 0.25 && r <= 2)) return;
  currentRate = r;
  const label = `${Number.isInteger(r) ? r : String(r)}×`;
  const button = $("ctlSpeed");
  button.textContent = label;
  button.setAttribute("aria-label", `Скорость воспроизведения, ${label}`);
  document.querySelectorAll(".speed-option[data-rate]").forEach((option) => {
    const active = Math.abs(Number(option.dataset.rate) - r) < 0.001;
    option.classList.toggle("active", active);
    option.setAttribute("aria-checked", String(active));
  });
  try { rateFn(vkVideoPlayer)?.call(vkVideoPlayer, r); } catch { /* player does not support speed */ }
}
function playerIsPlaying() {
  const st = readVkPlayerState();
  if (!st) return false;
  return st.state === "playing" || (!["paused", "ended"].includes(st.state) && lastPlayerState === "playing");
}
function guardLocked() {
  if (controlsLocked()) { showToast("Сейчас видео управляет организатор"); return true; }
  return false;
}
function togglePlay() {
  if (!vkVideoPlayer || !vkPlayerApiReady || guardLocked()) return;
  heldByBuffer = false;
  const t = readVkPlayerState()?.time;
  try {
    if (playerIsPlaying()) { vkVideoPlayer.pause(); lastPlayerState = "paused"; sendVideoControl("pause", t); }
    else { vkVideoPlayer.play(); lastPlayerState = "playing"; sendVideoControl("play", t); }
  } catch { showToast("Плеер не отвечает"); }
  uiTick();
}
function setSeekPreview(time) {
  if (!Number.isFinite(Number(time))) return;
  const target = Math.max(0, ui.duration ? Math.min(Number(time), ui.duration) : Number(time));
  const seek = $("ctlSeek");
  seek.value = ui.duration ? String(Math.min(1000, (target / ui.duration) * 1000)) : "0";
  $("ctlTime").textContent = fmtTime(target);
  setFill(seek);
}
function seekTo(t) {
  if (!vkVideoPlayer || !vkPlayerApiReady || guardLocked()) return;
  t = Number(t);
  if (!Number.isFinite(t)) return;
  t = Math.max(0, ui.duration ? Math.min(t, ui.duration) : t);
  ui.seekPending = { time: t, startedAt: Date.now() };
  setSeekPreview(t); // Update immediately; the player API may report the old time briefly.
  try { vkVideoPlayer.seek(t); lastObservedPlayerTime = t; } catch { ui.seekPending = null; return; }
  sendVideoControl("seek", t);
  uiTick();
}
function uiTick() {
  if (!vkVideoPlayer || !vkPlayerApiReady) return;
  const st = readVkPlayerState();
  if (!st) return;
  const player = vkVideoPlayer;
  // VK may return duration asynchronously; avoid starting a new promise every 250 ms.
  if (Date.now() - ui.durationCheckedAt > 1200) {
    ui.durationCheckedAt = Date.now();
    try {
      const d = player.getDuration?.();
      if (d && typeof d.then === "function") {
        d.then((v) => {
          if (player === vkVideoPlayer && Number.isFinite(Number(v)) && Number(v) > 0) ui.duration = Number(v);
        }).catch(() => {});
      } else if (Number.isFinite(Number(d)) && Number(d) > 0) ui.duration = Number(d);
      const state = player.getState?.();
      if (state && typeof state === "object" && Number.isFinite(Number(state.duration)) && Number(state.duration) > 0) ui.duration = Number(state.duration);
    } catch { /* ignore duration API quirks */ }
  }
  $("ctlPlay").textContent = playerIsPlaying() ? "❚❚" : "▶";
  const seek = $("ctlSeek");
  seek.disabled = !ui.duration;
  if (ui.seekPending && !ui.dragging) {
    const elapsed = Date.now() - ui.seekPending.startedAt;
    if (Math.abs(st.time - ui.seekPending.time) <= 1.25 || elapsed > 2400) ui.seekPending = null;
  }
  if (ui.dragging) {
    const preview = ui.duration ? (Number(seek.value) / 1000) * ui.duration : 0;
    $("ctlTime").textContent = fmtTime(preview);
    setFill(seek);
  } else if (ui.seekPending) {
    setSeekPreview(ui.seekPending.time);
  } else {
    $("ctlTime").textContent = fmtTime(st.time);
    seek.value = ui.duration ? String(Math.min(1000, (st.time / ui.duration) * 1000)) : "0";
    setFill(seek);
  }
  $("ctlDur").textContent = ui.duration ? fmtTime(ui.duration) : "--:--";
}
function poke() {
  const w = wrapEl();
  w.classList.remove("idle");
  clearTimeout(ui.idleTimer);
  ui.idleTimer = setTimeout(() => { if (ui.kind && playerIsPlaying() && !ui.dragging) w.classList.add("idle"); }, 3000);
}
function reflectMuteState(muted) {
  ui.muted = Boolean(muted);
  const button = $("ctlMute");
  button.classList.toggle("is-muted", ui.muted);
  button.setAttribute("aria-label", ui.muted ? "Включить звук" : "Выключить звук");
  button.setAttribute("aria-pressed", String(ui.muted));
  button.title = ui.muted ? "Включить звук" : "Выключить звук";
}
function activateControls(kind) {
  if (!kind) return;
  ui.kind = kind;
  const w = wrapEl(), p = vkVideoPlayer;
  w.classList.add("custom");
  w.classList.toggle("vk-custom", kind === "vk");
  $("controls").hidden = false; $("playerShield").hidden = false;
  $("speedMenu").hidden = !(kind === "yt" || kind === "html" || rateFn(p));
  $("ctlMute").hidden = !(p && p.mute && p.unmute);
  let initiallyMuted = false;
  try { initiallyMuted = Boolean(p?.isMuted?.()); } catch { /* source may not expose mute state */ }
  ui.previousVolume = Math.max(0.05, Number($("ctlVol").value || 100) / 100);
  reflectMuteState(initiallyMuted);
  $("ctlVol").hidden = !(kind === "yt" || kind === "html");
  $("ctlFull").hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const q = $("ctlQuality");
  q.replaceChildren();
  let opts = [];
  if (kind === "vk") opts = [["", "Авто"], ["0", "240p"], ["1", "360p"], ["2", "480p"], ["3", "720p"], ["4", "1080p"]];
  else if (kind === "html" && hlsInstance?.levels?.length) opts = [["-1", "Авто"], ...hlsInstance.levels.map((l, i) => [String(i), l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}k`])];
  for (const [v, l] of opts) { const o = document.createElement("option"); o.value = v; o.textContent = l; q.appendChild(o); }
  q.hidden = opts.length === 0;
  if (kind === "vk") { try { q.value = new URL($("vkPlayer").src).searchParams.get("hd") ?? ""; } catch { /* ignore */ } }
  applyRate(currentRate);
  clearInterval(ui.tick);
  ui.tick = setInterval(uiTick, 250);
  uiTick(); poke();
}
function deactivateControls() {
  clearInterval(ui.tick);
  ui.tick = null; ui.kind = ""; ui.duration = 0; ui.muted = false; ui.dragging = false; ui.seekPending = null; ui.durationCheckedAt = 0; ui.previousVolume = 1;
  setSpeedMenuOpen(false);
  wrapEl()?.classList.remove("custom", "vk-custom", "native", "idle", "waiting");
  $("controls").hidden = true; $("playerShield").hidden = true;
}
function reloadVkQuality(value) {
  const frame = $("vkPlayer");
  let u;
  try { u = new URL(frame.src); } catch { return; }
  if (value === "") u.searchParams.delete("hd"); else u.searchParams.set("hd", value);
  const st = readVkPlayerState();
  const wasPlaying = playerIsPlaying();
  vkPlayerApiReady = false;
  pendingRemoteControl = { clientId: "local", action: wasPlaying ? "play" : "pause", time: st?.time || 0, sentAt: Date.now(), rate: currentRate };
  showToast("Меняю качество…");
  frame.src = u.toString();
}
$("ctlPlay").addEventListener("click", () => { togglePlay(); poke(); });
$("playerShield").addEventListener("click", () => { if (wrapEl().classList.contains("idle")) { poke(); return; } togglePlay(); poke(); });
const seekControl = $("ctlSeek");
seekControl.addEventListener("pointerdown", () => { ui.dragging = true; ui.seekPending = null; poke(); });
seekControl.addEventListener("input", () => {
  ui.dragging = true;
  const target = ui.duration ? (Number(seekControl.value) / 1000) * ui.duration : 0;
  $("ctlTime").textContent = fmtTime(target);
  setFill(seekControl);
});
seekControl.addEventListener("change", () => {
  const target = ui.duration ? (Number(seekControl.value) / 1000) * ui.duration : null;
  ui.dragging = false;
  if (target !== null) seekTo(target);
  else uiTick();
  poke();
});
seekControl.addEventListener("pointercancel", () => { ui.dragging = false; ui.seekPending = null; uiTick(); });
$("ctlMute").addEventListener("click", () => {
  const p = vkVideoPlayer;
  if (!p) return;
  const nextMuted = !ui.muted;
  try {
    if (nextMuted) {
      const sliderVolume = Number($("ctlVol").value);
      if (sliderVolume > 0) ui.previousVolume = sliderVolume / 100;
      p.mute();
      reflectMuteState(true);
    } else {
      p.unmute();
      if (typeof p.setVolume === "function" && Number($("ctlVol").value) === 0) {
        const restored = Math.round(Math.max(0.05, ui.previousVolume) * 100);
        $("ctlVol").value = String(restored);
        p.setVolume(restored / 100);
        setFill($("ctlVol"));
      }
      reflectMuteState(false);
    }
  } catch { showToast("Не удалось изменить звук у этого источника."); }
});
$("ctlVol").addEventListener("input", (e) => {
  const p = vkVideoPlayer, v = Number(e.target.value) / 100;
  setFill(e.target);
  if (!p) return;
  try {
    p.setVolume?.(v);
    if (v > 0) {
      ui.previousVolume = v;
      if (ui.muted) { p.unmute?.(); reflectMuteState(false); }
    } else reflectMuteState(true);
  } catch { /* ignore */ }
});
function setSpeedMenuOpen(open) {
  const menu = $("speedOptions"), button = $("ctlSpeed"), root = $("speedMenu");
  if (!menu || !button || !root) return;
  menu.hidden = !open;
  root.classList.toggle("open", Boolean(open));
  button.setAttribute("aria-expanded", String(Boolean(open)));
}
$("ctlSpeed").addEventListener("click", (event) => {
  event.stopPropagation();
  setSpeedMenuOpen($("speedOptions").hidden);
  poke();
});
$("speedOptions").addEventListener("click", (event) => {
  const option = event.target.closest(".speed-option[data-rate]");
  if (!option) return;
  if (guardLocked()) { setSpeedMenuOpen(false); return; }
  const r = Number(option.dataset.rate);
  applyRate(r);
  channel?.send({ type: "broadcast", event: "video-rate", payload: { clientId, rate: r } }).catch(() => {});
  setSpeedMenuOpen(false);
  poke();
});
document.addEventListener("click", (event) => {
  if (!( $("speedMenu")?.contains(event.target) )) setSpeedMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSpeedMenuOpen(false);
});
$("ctlQuality").addEventListener("change", (e) => {
  if (ui.kind === "html" && hlsInstance) hlsInstance.currentLevel = Number(e.target.value);
  else if (ui.kind === "vk") reloadVkQuality(e.target.value);
});
function updateFullscreenButton() {
  const button = $("ctlFull");
  if (!button) return;
  const isFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const label = isFullscreen ? "Выйти из полноэкранного режима" : "На весь экран";
  button.classList.toggle("is-fullscreen", isFullscreen);
  button.setAttribute("aria-label", label);
  button.title = label;
}
for (const eventName of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(eventName, updateFullscreenButton);
$("ctlFull").addEventListener("click", async () => {
  const w = wrapEl();
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
    } else {
      const request = w.requestFullscreen || w.webkitRequestFullscreen;
      if (request) await request.call(w);
    }
  } catch { showToast("Не удалось изменить режим экрана."); }
  updateFullscreenButton();
  poke();
});
for (const ev of ["pointermove", "pointerdown"]) wrapEl().addEventListener(ev, () => { if (ui.kind) poke(); });
document.addEventListener("keydown", (e) => {
  if (!ui.kind || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement?.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); poke(); }
  else if (e.code === "ArrowRight") { seekTo((readVkPlayerState()?.time || 0) + 5); poke(); }
  else if (e.code === "ArrowLeft") { seekTo((readVkPlayerState()?.time || 0) - 5); poke(); }
});

// ---------- shared player events (VK / YouTube / <video>) ----------
function handlePlaying(state) {
  const time = Number(state?.time);
  if (Number.isFinite(time)) lastObservedPlayerTime = time;
  lastPlayerState = "playing";
  sendVideoControl("play", Number.isFinite(time) ? time : readVkPlayerState()?.time);
}
function handlePaused(state) {
  if (Date.now() >= suppressControlBroadcastUntil) heldByBuffer = false; // the user took over
  const time = Number(state?.time);
  if (Number.isFinite(time)) lastObservedPlayerTime = time;
  lastPlayerState = "paused";
  sendVideoControl("pause", Number.isFinite(time) ? time : readVkPlayerState()?.time);
}
function handleTimeUpdate(state) {
  if (Number.isFinite(Number(state?.duration)) && Number(state.duration) > 0) ui.duration = Number(state.duration);
  const time = Number(state?.time);
  if (!Number.isFinite(time)) return;
  if (!ui.seekPending && lastObservedPlayerTime !== null && Date.now() >= suppressControlBroadcastUntil && Math.abs(time - lastObservedPlayerTime) > 3.5) sendVideoControl("seek", time);
  lastObservedPlayerTime = time;
}
function markPlayerReady(label, kind) {
  vkPlayerApiReady = true;
  $("playerStatus").textContent = `${label} · СИНХРОНИЗАЦИЯ ГОТОВА`;
  activateControls(kind);
  const pending = pendingRemoteControl;
  pendingRemoteControl = null;
  if (pending) applyRemoteVideoControl(pending);
}

// ---------- video sources ----------
const HLS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement("script");
  s.src = src; s.onload = resolve; s.onerror = reject;
  document.head.appendChild(s);
});
function teardownPlayer() {
  try { vkVideoPlayer?.destroy?.(); } catch { /* ignore */ }
  try { altCleanup?.(); } catch { /* ignore */ }
  deactivateControls();
  altCleanup = null; vkVideoPlayer = null; vkPlayerApiReady = false; pendingRemoteControl = null;
  lastObservedPlayerTime = null; lastPlayerState = ""; heldByBuffer = false;
  clearTimeout(bufTimer); bufTimer = null; localBuffering = false; bufferingPeers.clear();
  const frame = $("vkPlayer"); frame.hidden = true; frame.removeAttribute("src");
  const alt = $("altPlayer"); alt.hidden = true; alt.replaceChildren();
  const v = $("htmlPlayer");
  for (const k of ["onplay", "onpause", "ontimeupdate", "onwaiting", "onplaying", "oncanplay", "onloadedmetadata", "onerror"]) v[k] = null;
  v.hidden = true; try { v.pause(); } catch { /* ignore */ } v.removeAttribute("src"); v.load();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
}
function resetPlayerView() {
  currentVideoEmbed = "";
  $("emptyPlayer").hidden = false;
  $("playerStatus").textContent = "ОЖИДАНИЕ ВИДЕО";
  $("videoUrl").value = "";
}
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { ytApiPromise = null; reject(new Error("youtube")); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}
async function startYouTube(id) {
  const key = `https://www.youtube.com/watch?v=${id}`;
  const box = $("altPlayer");
  box.hidden = false;
  $("playerStatus").textContent = "YOUTUBE · ЗАГРУЗКА";
  try { await loadYouTubeApi(); }
  catch { $("playerStatus").textContent = "YOUTUBE · НЕДОСТУПЕН"; showToast("Не удалось загрузить YouTube. Проверь блокировщик рекламы."); return; }
  if (currentVideoEmbed !== key) return;
  const mount = document.createElement("div");
  box.replaceChildren(mount);
  let timer = null, yt = null;
  const vars = { playsinline: 1, rel: 0, controls: 0, disablekb: 1, modestbranding: 1, iv_load_policy: 3, fs: 0 };
  if (location.protocol.startsWith("http")) vars.origin = location.origin;
  yt = new window.YT.Player(mount, {
    videoId: id, playerVars: vars,
    events: {
      onReady: () => {
        if (currentVideoEmbed !== key) return;
        vkVideoPlayer = {
          play: () => yt.playVideo(), pause: () => yt.pauseVideo(), seek: (t) => yt.seekTo(t, true),
          getCurrentTime: () => yt.getCurrentTime(),
          getDuration: () => yt.getDuration(), setRate: (r) => yt.setPlaybackRate(r),
          setVolume: (v) => yt.setVolume(Math.round(v * 100)), mute: () => yt.mute(), unmute: () => yt.unMute(), isMuted: () => yt.isMuted(),
          getState: () => ({ state: yt.getPlayerState() === 1 ? "playing" : "paused", time: yt.getCurrentTime() }),
          destroy: () => {}
        };
        timer = setInterval(() => handleTimeUpdate({ time: yt.getCurrentTime() }), 500); // YouTube has no timeupdate event
        markPlayerReady("YOUTUBE", "yt");
      },
      onStateChange: (e) => {
        if (!vkVideoPlayer) return;
        const time = yt.getCurrentTime();
        if (e.data === 1) { setLocalBuffering(false); handlePlaying({ time }); }
        else if (e.data === 2) { setLocalBuffering(false); handlePaused({ time }); }
        else if (e.data === 3) setLocalBuffering(true);
      },
      onError: () => showToast("YouTube не даёт встроить это видео.")
    }
  });
  altCleanup = () => { clearInterval(timer); try { yt.destroy(); } catch { /* ignore */ } };
}
async function startHtmlVideo(url) {
  const v = $("htmlPlayer");
  v.hidden = false;
  v.controls = false;
  $("playerStatus").textContent = "ВИДЕО · ЗАГРУЗКА";
  const adapter = {
    play: () => { v.play()?.catch(() => showToast("Браузер не дал запустить видео сам — нажми ▶.")); },
    pause: () => v.pause(), seek: (t) => { v.currentTime = t; }, getCurrentTime: () => v.currentTime,
    getDuration: () => v.duration, setRate: (r) => { v.playbackRate = r; }, setVolume: (x) => { v.volume = x; },
    mute: () => { v.muted = true; }, unmute: () => { v.muted = false; }, isMuted: () => v.muted,
    getState: () => ({ state: v.paused ? "paused" : "playing", time: v.currentTime }), destroy: () => {}
  };
  v.onloadedmetadata = () => { if (currentVideoEmbed !== url) return; vkVideoPlayer = adapter; markPlayerReady("ВИДЕО", "html"); };
  v.onplay = () => handlePlaying({ time: v.currentTime });
  v.onpause = () => { if (!v.ended) handlePaused({ time: v.currentTime }); };
  v.ontimeupdate = () => handleTimeUpdate({ time: v.currentTime });
  v.onwaiting = () => setLocalBuffering(true);
  v.onplaying = v.oncanplay = () => setLocalBuffering(false);
  v.onerror = () => { $("playerStatus").textContent = "ВИДЕО · ОШИБКА"; showToast("Не удалось загрузить видео. Проверь ссылку, формат и CORS."); };
  if (/\.m3u8$/i.test(new URL(url).pathname) && !v.canPlayType("application/vnd.apple.mpegurl")) {
    try { await loadScript(HLS_URL); } catch { showToast("Не удалось загрузить HLS-плеер."); return; }
    if (currentVideoEmbed !== url) return;
    if (!window.Hls?.isSupported()) { showToast("Этот браузер не умеет играть HLS (m3u8)."); return; }
    hlsInstance = new window.Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(v);
  } else v.src = url;
}

// ---------- buffering: everyone waits for the slowest participant ----------
function sendBuffer(flag) {
  channel?.send({ type: "broadcast", event: "video-buffer", payload: { clientId, buffering: flag, sentAt: Date.now() } }).catch(() => {});
}
function setLocalBuffering(flag) {
  if (flag) {
    if (localBuffering || bufTimer) return;
    bufTimer = setTimeout(() => { bufTimer = null; localBuffering = true; sendBuffer(true); }, 700); // ignore micro-stalls
  } else {
    clearTimeout(bufTimer); bufTimer = null;
    if (localBuffering) { localBuffering = false; sendBuffer(false); }
  }
}
function updateBufferHold() {
  const now = Date.now();
  for (const [id, t] of bufferingPeers) if (now - t > 15000) bufferingPeers.delete(id);
  if (!vkVideoPlayer || !vkPlayerApiReady) return;
  const waiting = bufferingPeers.size > 0;
  if (waiting && !heldByBuffer && readVkPlayerState()?.state === "playing") {
    heldByBuffer = true;
    suppressControlBroadcastUntil = now + 2200;
    try { vkVideoPlayer.pause(); } catch { /* ignore */ }
    $("playerStatus").textContent = "ЖДЁМ, ПОКА ДРУГ ЗАГРУЗИТ ВИДЕО…";
    wrapEl()?.classList.add("waiting");
  } else if (!waiting && heldByBuffer) {
    heldByBuffer = false;
    suppressControlBroadcastUntil = now + 2200;
    try { vkVideoPlayer.play(); } catch { /* ignore */ }
    $("playerStatus").textContent = "СИНХРОНИЗАЦИЯ ГОТОВА";
    wrapEl()?.classList.remove("waiting");
  }
}
function pruneBuffering() {
  if (!channel) return;
  const ids = new Set(presencePeople().map((p) => p.clientId));
  for (const id of bufferingPeers.keys()) if (!ids.has(id)) bufferingPeers.delete(id);
  updateBufferHold();
}
setInterval(() => { if (localBuffering) sendBuffer(true); updateBufferHold(); }, 3000);

// ---------- host-only control mode ----------
function selfPresence(name = getDisplayName()) {
  return { clientId, name, role: roomRole, joinedAt: sessionJoinedAt, hostOnly: roomRole === "host" ? hostOnlyFlag : undefined, avatar: myAvatar(), friendCode: myFriendCode() };
}
function presencePeople() {
  if (!channel) return [];
  try { return Object.values(channel.presenceState()).flat().filter((p) => p && p.clientId); } catch { return []; }
}
const hostEntry = () => presencePeople().find((p) => p.role === "host");
const hostOnlyMode = () => Boolean(hostEntry()?.hostOnly);
const isHostClient = (id) => hostEntry()?.clientId === id;
const controlsLocked = () => hostOnlyMode() && roomRole !== "host";
function syncRoomSettings() {
  const wrap = $("hostOnlyWrap"), box = $("hostOnlyToggle");
  if (!wrap) return;
  wrap.hidden = !channel;
  const entry = channel ? hostEntry() : null;
  const now = Boolean(entry?.hostOnly);
  if (entry && roomRole !== "host") hostOnlyFlag = now; // remembered, so a new organizer inherits the mode
  box.checked = roomRole === "host" ? hostOnlyFlag : now;
  box.disabled = roomRole !== "host";
  if (now !== lastHostOnly) {
    lastHostOnly = now;
    if (roomRole !== "host" && channel) addSystemMessage(now ? "Организатор включил режим: видео управляет только он." : "Организатор разрешил управлять видео всем.");
  }
}
$("hostOnlyToggle").addEventListener("change", (event) => {
  if (roomRole !== "host" || !channel) { event.target.checked = hostOnlyMode(); return; }
  hostOnlyFlag = event.target.checked;
  channel.track(selfPresence()).catch(() => {});
  addSystemMessage(hostOnlyFlag ? "Теперь видео управляет только организатор." : "Теперь видео могут управлять все.");
});

// ---------- share / leave / reconnect ----------
async function shareInvite() {
  const url = currentInviteUrl();
  if (navigator.share) {
    try { await navigator.share({ title: "SYNC — смотрим вместе", text: "Заходи в мою комнату в SYNC", url }); return; }
    catch (error) { if (error?.name === "AbortError") return; }
  }
  await copyText(url);
}
async function leaveRoom() {
  if (!roomCode) return;
  const code = roomCode;
  clearTimeout(reconnectTimer); reconnectTimer = null; reconnectAttempt = 0;
  roomCode = ""; roomRole = "guest"; hostOnlyFlag = false; lastHostOnly = false;
  await leaveCurrentRoom();
  teardownPlayer();
  resetPlayerView();
  safeStorageRemove("sessionStorage", `syncHost-${code}`);
  safeStorageRemove("sessionStorage", "syncPendingAuthRoom");
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState({}, "", url);
  $("messages").replaceChildren();
  addSystemMessage("Ты вышел из комнаты. Создай новую или открой приглашение.");
  setConnectionStatus("готов к подключению", "online");
  refreshRoomUI();
}
$("leaveRoom").addEventListener("click", leaveRoom);
function scheduleReconnect() {
  if (reconnectTimer || !roomCode) return;
  setConnectionStatus("переподключаемся…", "pending");
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
  reconnectAttempt++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (channel || !roomCode) return;
    if (navigator.onLine === false) { scheduleReconnect(); return; }
    const ok = await connectToRoom(roomCode, roomRole, true);
    if (ok) { reconnectAttempt = 0; addSystemMessage("Связь восстановлена."); }
    else if (roomCode) scheduleReconnect();
  }, delay);
}
function nudgeReconnect() {
  if (!roomCode || channel) return;
  clearTimeout(reconnectTimer); reconnectTimer = null; reconnectAttempt = 0;
  scheduleReconnect();
}
window.addEventListener("online", nudgeReconnect);
document.addEventListener("visibilitychange", () => { if (!document.hidden) nudgeReconnect(); });

function setupVideoSearch() {
  if ($("syncVideoSearchDialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "syncVideoSearchDialog";
  dialog.className = "modal sync-search-dialog";
  dialog.innerHTML = `
    <div class="search-head"><div><h2>Поиск видео</h2><p>Найди видео VK и загрузи его в общую комнату.</p></div><button class="search-close" type="button" aria-label="Закрыть поиск">×</button></div>
    <form class="sync-search-form" id="syncVideoSearchForm"><input id="syncVideoSearchQuery" type="search" maxlength="120" placeholder="Название фильма, аниме, видео…" autocomplete="off" required><button class="btn btn-primary compact" type="submit">Найти</button></form>
    <div class="sync-search-results" id="syncVideoSearchResults"><div class="sync-search-state">Введи запрос, чтобы найти видео.</div></div>
    <p class="hint">Показываются результаты, доступные API VK. Часть видео может быть закрыта или запрещена для встраивания.</p>`;
  document.body.appendChild(dialog);
  dialog.querySelector(".search-close").addEventListener("click", () => dialog.close());
  $("openVideoSearch").addEventListener("click", () => {
    if (!channel) { showToast("Сначала создай комнату или войди в комнату друга"); return; }
    dialog.showModal();
    $("syncVideoSearchQuery").focus();
  });
  $("syncVideoSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("syncVideoSearchQuery").value.trim();
    if (query.length < 2) { showToast("Введи хотя бы 2 символа"); return; }
    const submit = event.submitter;
    if (submit) { submit.disabled = true; submit.textContent = "Ищем…"; }
    const resultsRoot = $("syncVideoSearchResults");
    resultsRoot.replaceChildren();
    const state = document.createElement("div");
    state.className = "sync-search-state";
    state.textContent = "Ищем видео в VK…";
    resultsRoot.appendChild(state);
    try {
      if (!supabaseClient) throw new Error("Supabase не настроен");
      const { data: authData, error: authError } = await supabaseClient.auth.getSession();
      if (authError) throw authError;
      if (!authData?.session) throw new Error("Сначала войди через Google: нажми на аватар → «Войти через Google».");
      const { data, error } = await supabaseClient.functions.invoke("vk-video-search", { body: { query, count: 20 } });
      if (error) throw error;
      const items = Array.isArray(data?.items) ? data.items : [];
      resultsRoot.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("div"); empty.className = "sync-search-state";
        empty.textContent = data?.message || "Ничего не найдено. Попробуй другой запрос.";
        resultsRoot.appendChild(empty); return;
      }
      for (const item of items) {
        const owner = Number(item.owner_id);
        const videoId = Number(item.id);
        if (!Number.isFinite(owner) || !Number.isFinite(videoId)) continue;
        const videoUrl = `https://vk.com/video${owner}_${videoId}${item.access_key ? `?access_key=${encodeURIComponent(item.access_key)}` : ""}`;
        const card = document.createElement("button"); card.type = "button"; card.className = "sync-search-result";
        const thumb = document.createElement("img"); thumb.className = "sync-search-thumb"; thumb.alt = ""; thumb.loading = "lazy";
        thumb.src = item.thumbnail || ""; thumb.onerror = () => { thumb.removeAttribute("src"); thumb.style.visibility = "hidden"; };
        const copy = document.createElement("span"); copy.className = "sync-search-copy";
        const title = document.createElement("span"); title.className = "sync-search-title"; title.textContent = item.title || "Видео без названия";
        const meta = document.createElement("span"); meta.className = "sync-search-meta";
        const duration = Number(item.duration);
        const durationText = Number.isFinite(duration) && duration > 0 ? ` · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}` : "";
        meta.textContent = `${item.owner_name || "VK Видео"}${durationText}`;
        copy.append(title, meta); card.append(thumb, copy);
        card.addEventListener("click", () => {
          if (setVideo(videoUrl, true, false)) { dialog.close(); showToast("Видео отправлено участникам комнаты"); }
        });
        resultsRoot.appendChild(card);
      }
      if (!resultsRoot.children.length) { const empty = document.createElement("div"); empty.className = "sync-search-state"; empty.textContent = "VK вернул результаты в неподдерживаемом формате."; resultsRoot.appendChild(empty); }
    } catch (error) {
      console.error("SYNC VK search error", error);
      resultsRoot.replaceChildren();
      const err = document.createElement("div"); err.className = "sync-search-state";
      err.textContent = error instanceof Error && error.message.includes("Сначала войди")
        ? error.message
        : "Поиск пока не настроен или VK API вернул ошибку. Проверь Edge Function vk-video-search и секрет VK_ACCESS_TOKEN в Supabase.";
      resultsRoot.appendChild(err);
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = "Найти"; }
    }
  });
}
setupVideoSearch();

$("avatar").addEventListener("click", openProfile);

async function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const incoming = params.get("room") || safeStorageGet("sessionStorage", "syncPendingAuthRoom", "");
  if (!incoming) return;
  safeStorageRemove("sessionStorage", "syncPendingAuthRoom");
  const code = incoming.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (code.length !== 10) return;
  $("messages").replaceChildren();
  addSystemMessage("Подключаемся к комнате по приглашению…");
  const savedHost = safeStorageGet("sessionStorage", `syncHost-${code}`, "") === "1";
  const connected = await connectToRoom(code, savedHost ? "host" : "guest");
  if (connected) addSystemMessage(`Ты в комнате ${code}. Можно писать сообщения и добавлять видео.`);
}

function initialiseSupabase() {
  if (!configReady()) {
    setConnectionStatus("настрой Supabase", "error");
    addSystemMessage("Чтобы комнаты и чат работали между устройствами, заполни URL и Publishable key в config.js, затем загрузи обновлённые файлы на сайт.");
    return;
  }
  try {
    const cfg = window.SYNC_CONFIG;
    supabaseClient = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      realtime: { params: { eventsPerSecond: 8 } }
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
      updateGoogleAuthUI(session?.user || null);
      if (event === "SIGNED_IN") showToast("Вход через Google выполнен");
      if (event === "SIGNED_OUT") showToast("Ты вышел из аккаунта");
    });
    supabaseClient.auth.getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        updateGoogleAuthUI(data?.session?.user || null);
      })
      .catch((error) => console.warn("SYNC could not load auth session", error));
    setConnectionStatus("готов к подключению", "online");
    addSystemMessage("SYNC готов. Создай комнату или открой приглашение от друга.");
  } catch (error) {
    console.error("SYNC Supabase init error", error);
    setConnectionStatus("ошибка настройки", "error");
    addSystemMessage("Не удалось запустить Supabase. Проверь URL и Publishable key в config.js.");
  }
}

$("messages").replaceChildren();
refreshSelfAvatar();
setConnectionStatus("загрузка…", "pending");
setupGoogleAuthUI();
initialiseSupabase();
setupFriendsUI();
refreshRoomUI();
showWelcome();
welcomeDone.then(() => { startFriends(); initFromUrl(); });
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

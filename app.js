(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const config = window.SYNC_CONFIG || {};
  const providers = {
    youtube: { name: 'YouTube' },
    vk: { name: 'VK Видео' }
  };
  // Домен VK Видео: меняется в одном месте, если VK переедет на другой.
  const VK_HOST = 'https://vk.ru';
  const VK_VIDEO_ID = /^(-?\d{1,12})_(\d{1,12})(?:_([A-Fa-f0-9]{8,40}))?$/;

  let supabase = null;
  let authUser = null;
  let profile = null;
  let authMode = 'signin';
  let currentRoom = null;
  let inviteToken = null;
  let roomReady = false;
  let roomChannel = null;
  let onlineChannel = null;
  let friends = [];
  let incomingRequests = [];
  let onlineIds = new Set();
  let currentVideo = null;
  let youtubePlayer = null;
  let youtubeApiPromise = null;
  let vkApiPromise = null;
  let vkFrame = null;
  let vkPlayer = null;
  let vkReady = false;
  let vkPlaying = false;
  let vkMuted = false;
  let vkAdPlaying = false;
  let pendingRemotePlayback = null;
  let suppressPlaybackBroadcastUntil = 0;
  let roomOwnerId = null;
  let syncTimer = null;
  let playerUiTimer = null;
  let vkDuration = 0;
  let lastVkPosition = 0;
  let lastVkSyncAt = 0;
  let playbackStarted = false;
  let autoplayTimer = null;
  let toastTimer = null;
  let bootstrapping = false;
  let creatingRoom = false;
  let activeSearchRequest = 0;
  let friendSearchRequest = 0;
  let playerGeneration = 0;
  let playerSeekPreview = null;
  let installPrompt = null;
  let googleSignInMarkup = '';
  let modalReturnFocus = null;
  let voiceEnabled = false;
  let voiceMuted = false;
  let localAudioStream = null;
  const voicePeers = new Map();
  const pendingVoiceCandidates = new Map();
  const presenceSessionId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('#installApp')?.classList.remove('hidden');
  });

  const initials = (name) => (String(name || '?').trim().replace(/^@/, '').slice(0, 1) || '?').toLocaleUpperCase('ru-RU');
  function setAvatar(node, url, name) {
    if (!node) return;
    node.replaceChildren();
    if (url && /^https:\/\//i.test(String(url))) {
      const image = document.createElement('img');
      image.className = 'avatar-image'; image.alt = ''; image.loading = 'eager'; image.decoding = 'async'; image.fetchPriority = 'high'; image.src = normalizeGoogleAvatar(url);
      image.onerror = () => { image.remove(); node.textContent = initials(name); };
      node.append(image);
    } else node.textContent = initials(name);
  }
  const showToast = (message) => {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  };
  const setAuthStatus = (message, isError = false) => {
    const node = $('#authStatus');
    node.textContent = message || '';
    node.style.color = isError ? '#ff9a9f' : '#f0c58d';
  };
  const displayName = () => profile?.display_name || authUser?.email?.split('@')[0] || 'Гость';
  function normalizeGoogleAvatar(url) {
    if (!url) return '';
    return String(url).replace(/=s\d+(-c)?(?=($|\?))/, '=s512-c').replace(/([?&]sz=)\d+/g, (_match, prefix) => `${prefix}512`);
  }

  function showAuthGate() {
    $('#authGate').classList.remove('hidden');
    $('#appContent')?.classList.add('auth-locked');
  }
  function hideAuthGate() {
    $('#authGate').classList.add('hidden');
    $('#appContent')?.classList.remove('auth-locked');
  }

  function initializeAuthUI() {
    googleSignInMarkup = $('#googleSignIn')?.innerHTML || '';
    const supabaseKey = config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
    const configured = Boolean(config.SUPABASE_URL && supabaseKey && window.supabase?.createClient);
    if (!configured) {
      $('#setupNotice').classList.remove('hidden');
      $('#authPanel').classList.add('hidden');
      showAuthGate();
      return false;
    }
    supabase = window.supabase.createClient(config.SUPABASE_URL, supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    $('#setupNotice').classList.add('hidden');
    $('#authPanel').classList.remove('hidden');
    setAuthMode('signin');
    showAuthGate();
    return true;
  }

  function setAuthMode(mode) {
    authMode = mode === 'signup' ? 'signup' : 'signin';
    const signup = authMode === 'signup';
    $('#signupFields').classList.toggle('hidden', !signup);
    $('#authTitle').textContent = signup ? 'Создать аккаунт' : 'С возвращением';
    $('#authSubtitle').textContent = signup ? 'Твой аккаунт, друзья и комнаты — в одном месте.' : 'Войди, чтобы смотреть вместе с друзьями.';
    $('#authSubmit').textContent = signup ? 'Зарегистрироваться' : 'Войти';
    $('#authSwitchText').textContent = signup ? 'Уже есть аккаунт?' : 'Впервые в SYNC?';
    $('#authSwitch').textContent = signup ? 'Войти' : 'Создать аккаунт';
    $('#authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('#authDisplayName').required = signup;
    setAuthStatus('');
  }

  function authErrorText(error) {
    const text = String(error?.message || error || '');
    if (/invalid login credentials/i.test(text)) return 'Неверная почта или пароль.';
    if (/email not confirmed/i.test(text)) return 'Почта ещё не подтверждена. Открой письмо от Supabase и перейди по ссылке (проверь «Спам»).';
    if (/already registered|already been registered/i.test(text)) return 'Этот адрес уже зарегистрирован. Попробуй войти.';
    if (/rate limit|too many/i.test(text)) return 'Слишком много попыток. Подожди пару минут и попробуй снова.';
    if (/password should be|weak password/i.test(text)) return 'Пароль слишком простой. Используй не меньше 8 символов.';
    if (/invalid path specified/i.test(text)) return 'Неверный адрес Supabase в config.js: уберите «/rest/v1/» в конце.';
    if (/failed to fetch|networkerror|load failed/i.test(text)) return 'Нет связи с сервером. Проверь интернет и адрес Supabase в config.js.';
    return text || 'Не удалось войти. Попробуй ещё раз.';
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    const button = $('#googleSignIn');
    button.disabled = true;
    button.textContent = 'Переходим к Google…';
    try {
      const redirectTo = `${location.origin}${location.pathname}`;
      try { if (location.search) sessionStorage.setItem('syncPendingInvite', location.search); } catch {}
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, queryParams: { prompt: 'select_account' } }
      });
      if (error) throw error;
    } catch (error) {
      setAuthStatus(`Не удалось начать вход через Google: ${error.message}`, true);
      button.disabled = false;
      button.innerHTML = googleSignInMarkup || 'Продолжить с Google';
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    const email = $('#authEmail').value.trim().toLowerCase();
    const password = $('#authPassword').value;
    if (!email || password.length < 8) return setAuthStatus('Проверь почту и пароль (минимум 8 символов).', true);
    $('#authSubmit').disabled = true;
    $('#authSubmit').textContent = 'Подключаем…';
    setAuthStatus('');
    try {
      if (authMode === 'signup') {
        const name = $('#authDisplayName').value.trim();
        if (name.length < 2) throw new Error('Напиши, как к тебе обращаться (минимум 2 символа).');
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name } }
        });
        if (error) throw error;
        if (!data.session) {
          setAuthStatus('Аккаунт создан. Подтверди почту по письму от Supabase, затем войди.');
          setAuthMode('signin');
          $('#authEmail').value = email;
        } else {
          await bootstrapUser(data.user);
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await bootstrapUser(data.user);
      }
    } catch (error) {
      setAuthStatus(authErrorText(error), true);
    } finally {
      $('#authSubmit').disabled = false;
      $('#authSubmit').textContent = authMode === 'signup' ? 'Зарегистрироваться' : 'Войти';
    }
  }

  async function bootstrapUser(user) {
    if (!user || bootstrapping) return;
    bootstrapping = true;
    authUser = user;
    try {
      const { data, error } = await supabase.from('sync_profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', user.id)
        .single();
      if (error) throw new Error(`Не удалось загрузить профиль. Выполни supabase-migration-05.sql в Supabase → SQL Editor. (${error.message})`);
      profile = data;
      updateProfileUI();
      hideAuthGate();
      await Promise.all([loadFriends(), loadIncomingRequests()]);
      await connectOnlinePresence();
      await joinOrCreateRoom();
    } catch (error) {
      showAuthGate();
      setAuthStatus(error.message || 'Ошибка загрузки профиля.', true);
    } finally {
      bootstrapping = false;
    }
  }

  function updateProfileUI() {
    setAvatar($('#profileButton'), profile?.avatar_url, displayName());
    $('#profileDisplayName').value = profile?.display_name || '';
    $('#profileEmail').textContent = authUser?.email || '';
    $('#avatarPreview').src = profile?.avatar_url ? normalizeGoogleAvatar(profile.avatar_url) : 'icon.svg';
  }

  function presencePayload() {
    return {
      user_id: authUser.id,
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url || null,
      session_id: presenceSessionId,
      voice_enabled: voiceEnabled
    };
  }
  async function trackSelf() {
    try {
      if (roomChannel) await roomChannel.track(presencePayload());
      if (onlineChannel) await onlineChannel.track(presencePayload());
    } catch (error) { console.warn('SYNC presence update failed', error); }
  }

  async function prepareAvatar(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { bitmap = await createImageBitmap(file); }
    const side = Math.min(bitmap.width, bitmap.height); // the largest centered square, scaled down as a whole
    const sx = Math.round((bitmap.width - side) / 2);
    const sy = Math.round((bitmap.height - side) / 2);
    const size = Math.min(768, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.fillStyle = '#12242a'; context.fillRect(0, 0, size, size);
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    bitmap.close?.();
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92)); // Safari has no WebP encoder
    if (!blob) throw new Error('Не удалось обработать изображение');
    return blob;
  }

  async function removeOldAvatars(keepPath) {
    try {
      const { data } = await supabase.storage.from('sync-avatars').list(authUser.id, { limit: 100 });
      const stale = (data || []).map((item) => `${authUser.id}/${item.name}`).filter((path) => path !== keepPath);
      if (stale.length) await supabase.storage.from('sync-avatars').remove(stale);
    } catch (error) { console.warn('SYNC old avatars were not removed', error); }
  }

  async function uploadAvatar(file) {
    if (!file || !supabase || !authUser) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return showToast('Выбери JPG, PNG или WebP');
    if (file.size > 10 * 1024 * 1024) return showToast('Фото должно быть меньше 10 МБ');
    const localUrl = URL.createObjectURL(file);
    $('#avatarPreview').src = localUrl;
    try {
      showToast('Загружаем фото…');
      const processed = await prepareAvatar(file);
      const path = `${authUser.id}/${Date.now()}.${processed.type === 'image/webp' ? 'webp' : 'jpg'}`;
      const { error: uploadError } = await supabase.storage.from('sync-avatars').upload(path, processed, { contentType: processed.type, cacheControl: '31536000' });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from('sync-avatars').getPublicUrl(path);
      const { data: updated, error } = await supabase.from('sync_profiles').update({ avatar_url: data?.publicUrl }).eq('id', authUser.id).select('id,username,display_name,avatar_url').single();
      if (error) throw error;
      profile = updated; updateProfileUI();
      await trackSelf(); renderMembers();
      showToast('Фото профиля обновлено');
      removeOldAvatars(path);
    } catch (error) {
      updateProfileUI();
      showToast(`Не удалось обновить фото: ${error.message}`);
    } finally { URL.revokeObjectURL(localUrl); }
  }

  async function signOut() {
    if (!supabase) return;
    if (roomChannel) await supabase.removeChannel(roomChannel);
    if (onlineChannel) await supabase.removeChannel(onlineChannel);
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    roomChannel = null;
    onlineChannel = null;
    authUser = null;
    profile = null;
    friends = [];
    incomingRequests = [];
    resetRoomState();
    $('#friendsList').replaceChildren();
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus('Ты вышел из аккаунта.');
  }

  function resetRoomState() {
    stopVoiceLocally();
    playerGeneration += 1;
    currentRoom = null; inviteToken = null; roomReady = false; roomOwnerId = null; currentVideo = null; pendingRemotePlayback = null;
    clearTimeout(autoplayTimer);
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    resetVkPlayer();
    $('#embedWrap').replaceChildren(); $('#embedWrap').classList.add('hidden');
    $('#stagePlaceholder').classList.remove('hidden'); $('#playerGesture').classList.add('hidden'); $('#playerError').classList.add('hidden');
    $('#videoTitle').textContent = 'Пока ничего'; $('#videoSource').textContent = ''; $('#videoCover').textContent = 'S';
    $('#playerControls').classList.add('hidden'); if (playerUiTimer) clearInterval(playerUiTimer); playerUiTimer = null;
    $('#chatMessages').replaceChildren();
    const welcome = document.createElement('div'); welcome.className = 'chat-welcome'; welcome.textContent = 'Напиши что-нибудь, чтобы начать общение.'; $('#chatMessages').append(welcome);
    const url = new URL(location.href); url.searchParams.delete('room'); url.searchParams.delete('invite'); history.replaceState({}, '', url);
    $('#roomHint').textContent = 'создай комнату и выбери, что смотреть';
    updateRoomActions();
  }

  async function saveProfile(event) {
    event.preventDefault();
    const name = $('#profileDisplayName').value.trim();
    if (name.length < 2 || name.length > 24) return showToast('Имя должно содержать от 2 до 24 символов');
    const { data, error } = await supabase.from('sync_profiles')
      .update({ display_name: name })
      .eq('id', authUser.id)
      .select('id,username,display_name,avatar_url')
      .single();
    if (error) return showToast(error.message);
    profile = data;
    updateProfileUI();
    closeModal('profileModal');
    if (roomChannel) await roomChannel.track(presencePayload());
    if (onlineChannel) await onlineChannel.track(presencePayload());
    renderMembers();
    showToast('Имя обновлено');
  }

  function setRoomUrl(roomId, token) {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    url.searchParams.set('invite', token);
    history.replaceState({}, '', url);
  }

  function updateRoomActions() {
    const ready = Boolean(currentRoom && inviteToken && roomReady);
    ['#inviteTop', '#shareRoom', '#shareRoomSmall', '#invitePeople'].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = !ready;
    });
    const chatInput = $('#chatInput');
    const chatSend = $('#chatForm button[type="submit"]');
    if (chatInput) {
      chatInput.disabled = !ready;
      chatInput.placeholder = ready ? 'Написать сообщение…' : 'Подключаем чат…';
    }
    if (chatSend) chatSend.disabled = !ready;
  }

  async function tryJoinRoom(roomId, token) {
    const { error } = await supabase.rpc('join_sync_room', { p_room_id: roomId, p_invite_token: token });
    if (error) return false;
    currentRoom = roomId; inviteToken = token;
    setRoomUrl(roomId, token);
    updateRoomActions();
    $('#roomHint').textContent = 'пригласи друзей по ссылке и выбери видео';
    $('#syncLabel').textContent = 'Вы в комнате';
    await connectRoom();
    return true;
  }

  async function joinOrCreateRoom() {
    let params = new URLSearchParams(location.search);
    if (!params.get('room') || !params.get('invite')) {
      try {
        const saved = sessionStorage.getItem('syncPendingInvite');
        if (saved) { params = new URLSearchParams(saved); sessionStorage.removeItem('syncPendingInvite'); }
      } catch {}
    }
    const requestedRoom = params.get('room');
    const requestedToken = params.get('invite');
    if (requestedRoom && requestedToken) {
      if (await tryJoinRoom(requestedRoom, requestedToken)) { showToast('Ты присоединился к просмотру'); return; }
      showToast('Ссылка недействительна или комната закрыта.');
    }
    // Reuse the latest room of this user instead of creating a new one on every visit.
    const { data: own } = await supabase.from('sync_rooms').select('id,invite_token').eq('owner_id', authUser.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (own?.id && own?.invite_token && await tryJoinRoom(own.id, own.invite_token)) return;
    await createRoom(false);
  }

  function clearActiveVideo() {
    playerGeneration += 1;
    currentVideo = null; pendingRemotePlayback = null; playbackStarted = false;
    clearTimeout(autoplayTimer);
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    resetVkPlayer();
    if (playerUiTimer) clearInterval(playerUiTimer); playerUiTimer = null;
    $('#embedWrap').replaceChildren(); $('#embedWrap').classList.add('hidden');
    $('#stagePlaceholder').classList.remove('hidden'); $('#playerControls').classList.add('hidden');
    $('#playerGesture').classList.add('hidden'); $('#playerError').classList.add('hidden');
    $('#videoTitle').textContent = 'Пока ничего'; $('#videoSource').textContent = ''; $('#videoCover').textContent = 'S';
    $('#searchResults').replaceChildren();
  }

  async function createRoom(showMessage = true) {
    if (!supabase || creatingRoom) return;
    creatingRoom = true;
    const button = $('#newRoom');
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Создаём…';
    try {
      const { data, error } = await supabase.rpc('create_sync_room');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.room_id || !row?.invite_token) throw new Error('Supabase не вернул ссылку комнаты');
      clearActiveVideo();
      currentRoom = row.room_id;
      inviteToken = row.invite_token;
      setRoomUrl(currentRoom, inviteToken);
      updateRoomActions();
      $('#roomHint').textContent = 'пригласи друзей по ссылке и выбери видео';
      $('#syncLabel').textContent = 'Новая комната';
      await connectRoom();
      if (showMessage) showToast('Новая комната создана');
    } catch (error) {
      showToast(`Не удалось создать комнату: ${error?.message || 'ошибка соединения'}`);
    } finally {
      creatingRoom = false;
      button.disabled = false;
      button.textContent = previousLabel;
      updateRoomActions();
    }
  }

  function roomUrl() {
    const url = new URL(location.href);
    if (currentRoom && inviteToken) {
      url.searchParams.set('room', currentRoom);
      url.searchParams.set('invite', inviteToken);
    }
    return url.toString();
  }

  async function connectRoom() {
    if (!currentRoom) return;
    roomReady = false;
    updateRoomActions();
    if (roomChannel) {
      if (voiceEnabled) {
        for (const sessionId of [...voicePeers.keys()]) await sendVoiceSignal(sessionId, { type: 'leave' });
        stopVoiceLocally();
      }
      await supabase.removeChannel(roomChannel);
    }
    roomChannel = supabase.channel(`sync-room:${currentRoom}`, {
      config: { private: true, presence: { key: `${authUser.id}:${presenceSessionId}` }, broadcast: { self: false } }
    });
    roomChannel
      .on('presence', { event: 'sync' }, () => { renderMembers(); syncVoicePeers(); })
      .on('presence', { event: 'join' }, () => { renderMembers(); syncVoicePeers(); })
      .on('presence', { event: 'leave' }, () => { renderMembers(); cleanupStaleVoicePeers(); syncVoicePeers(); })
      .on('broadcast', { event: 'voice-signal' }, ({ payload }) => handleVoiceSignal(payload))
      .on('broadcast', { event: 'request-current-video' }, async ({ payload }) => {
        if (!currentVideo || payload?.user_id === authUser.id) return;
        const live = { user_id: authUser.id, provider: currentVideo.provider, videoId: currentVideo.videoId, title: currentVideo.title, channelTitle: currentVideo.channelTitle, state: 'playing', time: getCurrentPlayerTime() };
        await roomChannel.send({ type: 'broadcast', event: 'video', payload: live });
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        if (payload?.user_id !== authUser.id) addChatMessage(payload?.name || 'Друг', payload?.message || '', false, payload?.avatar_url || '', payload?.created_at || Date.now());
      })
      .on('broadcast', { event: 'video' }, async ({ payload }) => {
        if (payload?.user_id !== authUser.id && payload?.videoId && ['youtube', 'vk'].includes(payload.provider)) {
          suppressPlaybackBroadcastUntil = Date.now() + 5000;
          await playSelectedVideo(payload.provider, payload.videoId, payload.title || 'Видео', payload.channelTitle || providers[payload.provider].name, false, { state: 'playing', time: payload.time || 0 });
          showToast('Друг выбрал видео — запускаем вместе');
        }
      })
      .on('broadcast', { event: 'playback' }, ({ payload }) => {
        if (payload?.user_id !== authUser.id && payload?.provider && payload?.videoId === currentVideo?.videoId) {
          suppressPlaybackBroadcastUntil = Date.now() + 1800;
          applyPlaybackState(payload);
        }
      });
    const { data: roomInfo } = await supabase.from('sync_rooms').select('owner_id').eq('id', currentRoom).maybeSingle();
    roomOwnerId = roomInfo?.owner_id || null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(broadcastRoomHeartbeat, 7000);
    const subscribedChannel = roomChannel;
    subscribedChannel.subscribe(async (status) => {
      if (subscribedChannel !== roomChannel) return;
      if (status === 'SUBSCRIBED') {
        roomReady = true;
        updateRoomActions();
        await subscribedChannel.track(presencePayload());
        renderMembers();
        $('#syncLabel').textContent = 'Комната синхронизирована';
        syncVoicePeers();
        // Ask active participants for the live selection. Old saved test videos are never auto-restored.
        await subscribedChannel.send({ type: 'broadcast', event: 'request-current-video', payload: { user_id: authUser.id } });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        roomReady = false;
        updateRoomActions();
        $('#syncLabel').textContent = 'Нет соединения';
      }
    });
  }

  function presenceUserIds() {
    return [...new Set(Object.values(roomChannel?.presenceState?.() || {}).flat().map((person) => person?.user_id).filter(Boolean))];
  }
  function isSyncLeader() {
    if (!authUser) return false;
    const ids = presenceUserIds();
    if (roomOwnerId && ids.includes(roomOwnerId)) return roomOwnerId === authUser.id;
    return [...new Set([...ids, authUser.id])].sort()[0] === authUser.id;
  }

  function renderMembers() {
    const list = $('#peopleList');
    if (!list) return;
    list.replaceChildren();
    const state = roomChannel?.presenceState?.() || {};
    const participants = Object.values(state).flat().filter((person) => person?.user_id);
    if (!participants.some((person) => person.user_id === authUser?.id) && authUser) {
      participants.unshift({ user_id: authUser.id, display_name: displayName() });
    }
    const unique = [...new Map(participants.map((person) => [person.user_id, person])).values()];
    unique.forEach((person) => {
      const mine = person.user_id === authUser?.id;
      const row = document.createElement('div'); row.className = 'person-row';
      const avatar = document.createElement('div'); avatar.className = `person-avatar${mine ? ' self-avatar' : ''}`; setAvatar(avatar, person.avatar_url, person.display_name);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = mine ? 'Вы' : (person.display_name || person.username || 'Участник');
      const role = document.createElement('span'); role.textContent = mine ? 'Вы здесь' : 'Смотрит вместе с вами';
      const dot = document.createElement('span'); dot.className = 'person-presence';
      info.append(name, role); row.append(avatar, info, dot); list.append(row);
    });
    const count = unique.length;
    $('#peopleCount').textContent = `${count} ${count === 1 ? 'участник' : count < 5 ? 'участника' : 'участников'}`;
  }

  async function connectOnlinePresence() {
    if (onlineChannel) await supabase.removeChannel(onlineChannel);
    onlineChannel = supabase.channel('sync-online-presence', {
      config: { private: true, presence: { key: `${authUser.id}:${presenceSessionId}` } }
    });
    onlineChannel.on('presence', { event: 'sync' }, () => {
      const state = onlineChannel.presenceState();
      onlineIds = new Set(Object.values(state).flat().map((item) => item?.user_id).filter(Boolean));
      renderFriends();
    });
    onlineChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await onlineChannel.track(presencePayload());
        const state = onlineChannel.presenceState();
        onlineIds = new Set(Object.values(state).flat().map((item) => item?.user_id).filter(Boolean));
        renderFriends();
      }
    });
  }

  async function loadFriends() {
    const { data, error } = await supabase.from('sync_friend_requests')
      .select('id,from_user,to_user,from_profile:sync_profiles!sync_friend_requests_from_user_fkey(id,username,display_name,avatar_url),to_profile:sync_profiles!sync_friend_requests_to_user_fkey(id,username,display_name,avatar_url)')
      .eq('status', 'accepted')
      .or(`from_user.eq.${authUser.id},to_user.eq.${authUser.id}`);
    if (error) { showToast(`Не загрузились друзья: ${error.message}`); return; }
    friends = (data || []).map((row) => ({
      requestId: row.id,
      id: row.from_user === authUser.id ? row.to_user : row.from_user,
      ...(row.from_user === authUser.id ? row.to_profile : row.from_profile)
    }));
    renderFriends();
  }

  async function loadIncomingRequests() {
    const { data, error } = await supabase.from('sync_friend_requests')
      .select('id,from_user,from_profile:sync_profiles!sync_friend_requests_from_user_fkey(id,username,display_name,avatar_url)')
      .eq('to_user', authUser.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) { showToast(`Не загрузились заявки: ${error.message}`); return; }
    incomingRequests = data || [];
    renderIncomingRequests();
  }

  function renderFriends() {
    const list = $('#friendsList');
    list.replaceChildren();
    if (!friends.length) {
      const empty = document.createElement('div'); empty.className = 'empty-friends';
      const icon = document.createElement('span'); icon.className = 'empty-friends-icon'; icon.textContent = '✳';
      const label = document.createElement('span'); label.textContent = 'Найди друзей по имени';
      empty.append(icon, label); list.append(empty); return;
    }
    friends.forEach((friend) => {
      const row = document.createElement('div'); row.className = 'friend-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, friend.avatar_url, friend.display_name || friend.username);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = friend.display_name || friend.username;
      const dot = document.createElement('span'); dot.className = `friend-online${onlineIds.has(friend.id) ? ' online' : ''}`; dot.title = onlineIds.has(friend.id) ? 'В сети' : 'Не в сети';
      const actions = document.createElement('div'); actions.className = 'friend-actions';
      const invite = document.createElement('button'); invite.className = 'friend-action'; invite.textContent = '↗'; invite.title = 'Пригласить в комнату'; invite.setAttribute('aria-label', `Пригласить ${friend.display_name || friend.username}`);
      invite.addEventListener('click', () => inviteFriend(friend.display_name || friend.username));
      const remove = document.createElement('button'); remove.className = 'friend-action'; remove.textContent = '×'; remove.title = 'Удалить из друзей'; remove.setAttribute('aria-label', `Удалить ${friend.username}`);
      remove.addEventListener('click', () => removeFriend(friend.requestId));
      info.append(name); actions.append(invite, remove); row.append(avatar, info, dot, actions); list.append(row);
    });
  }

  function inviteFriend(name) { return shareRoom(name); }

  async function removeFriend(requestId) {
    const { error } = await supabase.from('sync_friend_requests').delete().eq('id', requestId);
    if (error) return showToast(error.message);
    await loadFriends(); showToast('Друг удалён');
  }

  async function searchUsers(event) {
    event.preventDefault();
    const requestId = ++friendSearchRequest;
    const query = $('#friendName').value.trim().replace(/[,%_]/g, ' ').replace(/\s+/g, ' ');
    const box = $('#friendSearchResults'); box.replaceChildren();
    if (query.length < 2) {
      box.textContent = 'Введи хотя бы 2 символа имени.';
      box.className = 'modal-list modal-empty'; return;
    }
    box.className = 'modal-list';
    const loading = document.createElement('div'); loading.className = 'modal-empty'; loading.textContent = 'Ищем людей…'; box.append(loading);
    const { data, error } = await supabase.from('sync_profiles')
      .select('id,username,display_name,avatar_url')
      .ilike('display_name', `%${query}%`)
      .neq('id', authUser.id)
      .limit(12);
    if (requestId !== friendSearchRequest || !box.isConnected) return;
    box.replaceChildren();
    if (error) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = `Не удалось найти людей: ${error.message}`; box.append(msg); return; }
    if (!data?.length) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = 'Пока никого не нашли. Попробуй другое написание.'; box.append(msg); return; }
    data.forEach((person) => {
      const existing = friends.some((friend) => friend.id === person.id);
      const item = document.createElement('div'); item.className = 'modal-user-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, person.avatar_url, person.display_name);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = person.display_name || 'Пользователь';
      const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'button';
      button.textContent = existing ? 'Уже в друзьях' : 'Добавить'; button.disabled = existing;
      button.addEventListener('click', () => sendFriendRequestById(person.id, button));
      info.append(name); item.append(avatar, info, button); box.append(item);
    });
  }

  async function sendFriendRequestById(userId, button) {
    button.disabled = true; button.textContent = 'Отправляем…';
    const { data, error } = await supabase.rpc('send_friend_request_by_id', { p_target_id: userId });
    if (error) { button.disabled = false; button.textContent = 'Добавить'; showToast(error.message); return; }
    const status = typeof data === 'string' ? data : data?.status;
    if (status === 'accepted') { await loadFriends(); showToast('Теперь вы друзья'); }
    else if (status === 'already_friends') showToast('Вы уже друзья');
    else if (status === 'pending') showToast('Заявка уже отправлена');
    else showToast('Заявка отправлена');
    button.textContent = status === 'already_friends' ? 'Уже в друзьях' : 'Заявка отправлена';
  }

  function renderIncomingRequests() {
    const box = $('#incomingRequests'); box.replaceChildren();
    if (!incomingRequests.length) { const empty = document.createElement('div'); empty.className = 'modal-empty'; empty.textContent = 'Нет новых заявок'; box.append(empty); return; }
    incomingRequests.forEach((request) => {
      const user = request.from_profile || {};
      const item = document.createElement('div'); item.className = 'modal-user-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, user.avatar_url, user.display_name || user.username);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = user.display_name || 'Пользователь';
      const accept = document.createElement('button'); accept.className = 'button button-primary'; accept.type = 'button'; accept.textContent = 'Принять';
      accept.addEventListener('click', () => respondRequest(request.id, true));
      const decline = document.createElement('button'); decline.className = 'friend-action'; decline.type = 'button'; decline.textContent = '×'; decline.title = 'Отклонить';
      decline.addEventListener('click', () => respondRequest(request.id, false));
      info.append(name); item.append(avatar, info, accept, decline); box.append(item);
    });
  }

  async function respondRequest(requestId, accept) {
    const query = supabase.from('sync_friend_requests');
    const result = accept
      ? await query.update({ status: 'accepted' }).eq('id', requestId).eq('to_user', authUser.id)
      : await query.delete().eq('id', requestId).eq('to_user', authUser.id);
    if (result.error) return showToast(result.error.message);
    await Promise.all([loadIncomingRequests(), loadFriends()]);
    showToast(accept ? 'Заявка принята' : 'Заявка отклонена');
  }

  // Voice chat uses WebRTC media streams; Supabase Realtime is only the signaling channel.
  function getRoomPresence() {
    const state = roomChannel?.presenceState?.() || {};
    return Object.values(state).flat().filter((person) => person?.session_id && person.user_id);
  }

  function updateVoiceUI(statusText) {
    const toggle = $('#voiceToggle');
    const leave = $('#voiceLeave');
    if (!toggle) return;
    toggle.classList.toggle('is-active', voiceEnabled && !voiceMuted);
    toggle.classList.toggle('is-muted', voiceEnabled && voiceMuted);
    toggle.title = !voiceEnabled ? 'Подключить голосовой чат' : voiceMuted ? 'Включить микрофон' : 'Выключить микрофон';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(voiceEnabled && !voiceMuted));
    leave?.classList.toggle('hidden', !voiceEnabled);
    const status = $('#voiceStatus');
    if (status) {
      status.textContent = statusText || (voiceEnabled ? `На связи · ${voicePeers.size + 1}` : 'Голос выключен');
      status.classList.toggle('is-active', voiceEnabled);
    }
  }

  function closeVoicePeer(sessionId) {
    const peer = voicePeers.get(sessionId);
    if (peer) {
      try { peer.connection.ontrack = null; peer.connection.onicecandidate = null; peer.connection.close(); } catch {}
      peer.audio?.remove();
      voicePeers.delete(sessionId);
    }
    pendingVoiceCandidates.delete(sessionId);
    if (voiceEnabled) updateVoiceUI();
  }

  function stopVoiceLocally() {
    voiceEnabled = false;
    voiceMuted = false;
    for (const sessionId of [...voicePeers.keys()]) closeVoicePeer(sessionId);
    if (localAudioStream) localAudioStream.getTracks().forEach((track) => track.stop());
    localAudioStream = null;
    $('#voiceAudioDock')?.replaceChildren();
    updateVoiceUI();
  }

  async function sendVoiceSignal(targetSessionId, signal) {
    if (!roomChannel || !authUser) return;
    await roomChannel.send({
      type: 'broadcast',
      event: 'voice-signal',
      payload: {
        from_user_id: authUser.id,
        from_session_id: presenceSessionId,
        target_session_id: targetSessionId,
        signal
      }
    });
  }

  function makeVoicePeer(person) {
    if (voicePeers.has(person.session_id) || !localAudioStream) return voicePeers.get(person.session_id)?.connection;
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    localAudioStream.getTracks().forEach((track) => connection.addTrack(track, localAudioStream));
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.sessionId = person.session_id;
    audio.setAttribute('aria-label', `Голос ${person.display_name || 'участника'}`);
    $('#voiceAudioDock').append(audio);
    voicePeers.set(person.session_id, { connection, audio, name: person.display_name || 'Участник' });
    connection.ontrack = (event) => {
      audio.srcObject = event.streams?.[0] || new MediaStream([event.track]);
      audio.play?.().catch(() => showToast('Нажми на экран, чтобы разрешить звук собеседника'));
    };
    connection.onicecandidate = (event) => {
      if (event.candidate) sendVoiceSignal(person.session_id, { type: 'candidate', candidate: event.candidate.toJSON?.() || event.candidate });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') closeVoicePeer(person.session_id);
      else updateVoiceUI(connection.connectionState === 'connected' ? `На связи: ${voicePeers.size} · микрофон включён` : 'Подключаем голос участников…');
    };
    return connection;
  }

  async function syncVoicePeers() {
    if (!voiceEnabled || !localAudioStream || !roomChannel) return;
    const people = getRoomPresence().filter((person) => person.voice_enabled && person.session_id !== presenceSessionId);
    for (const person of people) {
      // Only one side creates the offer for a given pair, preventing offer collisions.
      if (presenceSessionId.localeCompare(person.session_id) > 0 || voicePeers.has(person.session_id)) continue;
      try {
        const connection = makeVoicePeer(person);
        if (!connection) continue;
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await sendVoiceSignal(person.session_id, { type: 'description', description: connection.localDescription.toJSON() });
      } catch (error) {
        console.warn('SYNC voice offer failed:', error);
        showToast('Не удалось подключить голосового участника');
      }
    }
    updateVoiceUI();
  }

  function cleanupStaleVoicePeers() {
    const activeSessions = new Set(getRoomPresence().map((person) => person.session_id));
    for (const sessionId of [...voicePeers.keys()]) if (!activeSessions.has(sessionId)) closeVoicePeer(sessionId);
  }

  async function handleVoiceSignal(payload) {
    if (!payload || payload.target_session_id !== presenceSessionId || payload.from_session_id === presenceSessionId) return;
    const sender = getRoomPresence().find((person) => person.session_id === payload.from_session_id);
    if (!sender) return;
    const signal = payload.signal || {};
    if (signal.type === 'leave') return closeVoicePeer(payload.from_session_id);
    if (!voiceEnabled || !localAudioStream) return;
    try {
      let peer = voicePeers.get(payload.from_session_id);
      if (signal.type === 'description' && signal.description?.type === 'offer') {
        const connection = makeVoicePeer(sender);
        await connection.setRemoteDescription(new RTCSessionDescription(signal.description));
        const queued = pendingVoiceCandidates.get(payload.from_session_id) || [];
        for (const candidate of queued) await connection.addIceCandidate(new RTCIceCandidate(candidate));
        pendingVoiceCandidates.delete(payload.from_session_id);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        await sendVoiceSignal(payload.from_session_id, { type: 'description', description: connection.localDescription.toJSON() });
        return;
      }
      if (signal.type === 'description' && signal.description?.type === 'answer') {
        if (!peer) return;
        await peer.connection.setRemoteDescription(new RTCSessionDescription(signal.description));
        const queued = pendingVoiceCandidates.get(payload.from_session_id) || [];
        for (const candidate of queued) await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
        pendingVoiceCandidates.delete(payload.from_session_id);
        return;
      }
      if (signal.type === 'candidate' && signal.candidate) {
        if (peer?.connection.remoteDescription) await peer.connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        else {
          const pending = pendingVoiceCandidates.get(payload.from_session_id) || [];
          pending.push(signal.candidate);
          pendingVoiceCandidates.set(payload.from_session_id, pending);
        }
      }
    } catch (error) {
      console.warn('SYNC voice signaling failed:', error);
      showToast('Голос не подключился. Попробуй переподключиться.');
    }
  }

  async function toggleVoice() {
    if (voiceEnabled) {
      const peers = [...voicePeers.keys()];
      for (const sessionId of peers) await sendVoiceSignal(sessionId, { type: 'leave' });
      stopVoiceLocally();
      if (roomChannel) await roomChannel.track(presencePayload());
      return;
    }
    if (!currentRoom || !roomChannel) return showToast('Сначала дождись подключения к комнате');
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return showToast('Этот браузер не поддерживает голосовой чат');
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      voiceEnabled = true;
      voiceMuted = false;
      await roomChannel.track(presencePayload());
      updateVoiceUI('Микрофон включён · ищем участников…');
      await syncVoicePeers();
      showToast('Голосовой чат включён');
    } catch (error) {
      stopVoiceLocally();
      const message = error?.name === 'NotAllowedError' ? 'Разреши доступ к микрофону в браузере' : error?.name === 'NotFoundError' ? 'Не найден микрофон' : 'Не удалось включить микрофон';
      showToast(message);
    }
  }

  function toggleVoiceMute() {
    if (!voiceEnabled || !localAudioStream) return;
    voiceMuted = !voiceMuted;
    localAudioStream.getAudioTracks().forEach((track) => { track.enabled = !voiceMuted; });
    updateVoiceUI(voiceMuted ? 'Микрофон выключен для остальных' : `Микрофон включён · участников: ${voicePeers.size + 1}`);
  }

  function addChatMessage(name, message, mine = false, avatarUrl = '', createdAt = Date.now()) {
    if (!message) return;
    const welcome = $('#chatMessages .chat-welcome'); if (welcome) welcome.remove();
    const wrap = document.createElement('div'); wrap.className = `chat-message${mine ? ' mine' : ''}`;
    const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, avatarUrl, name);
    const body = document.createElement('div'); body.className = 'message-body';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const strong = document.createElement('strong'); strong.textContent = mine ? 'Ты' : (name || 'Друг');
    const time = document.createElement('time'); time.textContent = new Date(createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message;
    meta.append(strong, time); body.append(meta, text); wrap.append(avatar, body); $('#chatMessages').append(wrap);
    const box = $('#chatMessages');
    while (box.children.length > 200) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
    return wrap;
  }

  async function sendChatMessage(message) {
    if (!roomChannel || !authUser) {
      showToast('Нет соединения с комнатой. Сообщение не отправлено.');
      return false;
    }
    const createdAt = Date.now();
    const node = addChatMessage(displayName(), message, true, profile?.avatar_url, createdAt);
    try {
      const status = await roomChannel.send({
        type: 'broadcast',
        event: 'chat',
        payload: { user_id: authUser.id, name: displayName(), avatar_url: profile?.avatar_url || null, message, created_at: createdAt }
      });
      if (status && status !== 'ok') throw new Error(status);
      return true;
    } catch (error) {
      node?.remove();
      if (!$('#chatMessages').children.length) {
        const welcome = document.createElement('div');
        welcome.className = 'chat-welcome';
        welcome.textContent = 'Сообщение не отправлено. Проверь подключение и попробуй ещё раз.';
        $('#chatMessages').append(welcome);
      }
      showToast('Сообщение не отправлено. Проверь соединение.');
      console.warn('SYNC chat send failed:', error);
      return false;
    }
  }

  async function searchVideos(query) {
    const cleaned = String(query || '').trim();
    if (!cleaned) { showToast('Напиши название фильма или вставь ссылку VK Видео'); $('#providerSearchInput').focus(); return; }
    if (!currentRoom || !roomChannel) { $('#providerMessage').textContent = 'Комната ещё подключается. Подожди пару секунд и повтори поиск.'; return; }
    const pastedLink = parseVkLink(cleaned);
    if (pastedLink) {
      closeModal('videoSearchModal');
      playSelectedVideo('vk', pastedLink, 'Видео из VK Видео', 'VK Видео', true)
        .catch((error) => { console.error('SYNC open VK link failed:', error); showToast('Не удалось открыть эту ссылку VK Видео.'); });
      return;
    }
    const requestId = ++activeSearchRequest;
    const submit = $('#providerSearchButton');
    submit.disabled = true; submit.textContent = 'Ищем…';
    renderSearchNotice(`Ищем «${cleaned}»…`);
    $('#providerMessage').textContent = 'Подбираем доступные видео по твоему запросу.';
    try {
      const { data, error } = await supabase.functions.invoke('sync-search', { body: { provider: 'vk', query: cleaned } });
      if (error) {
        let serverMessage = '';
        try { const body = await error.context?.clone?.().json?.(); serverMessage = body?.error || body?.message || ''; } catch {}
        throw new Error(serverMessage || error.message || 'Функция поиска не отвечает');
      }
      if (requestId !== activeSearchRequest) return;
      if (data?.error) throw new Error(data.error);
      const results = Array.isArray(data?.results) ? data.results : [];
      renderVideoCards(results);
      $('#providerMessage').textContent = results.length
        ? `Нашли ${results.length} ${results.length === 1 ? 'вариант' : results.length < 5 ? 'варианта' : 'вариантов'}. Выбери видео — оно откроется у всех участников комнаты.`
        : 'По этому запросу пока нет результатов. Попробуй короче или используй другое написание.';
      if (data?.warnings?.length) {
        const warning = document.createElement('div'); warning.className = 'search-warning';
        warning.textContent = `Поиск временно ограничен: ${data.warnings.join('; ')}`;
        $('#searchResults').prepend(warning);
      }
    } catch (error) {
      if (requestId !== activeSearchRequest) return;
      const text = String(error?.message || error);
      if (/404|not found|function not found|non-2xx|functionsfetcherror|failed to send a request/i.test(text)) {
        renderSearchNotice('Нужно обновить функцию sync-search в Supabase из папки supabase/functions/sync-search.');
      } else renderSearchNotice(`Не получилось выполнить поиск: ${text}`);
    } finally {
      if (requestId === activeSearchRequest) {
        submit.disabled = false;
        submit.textContent = 'Найти';
      }
    }
  }

  function renderVideoCards(items) {
    const box = $('#searchResults'); box.replaceChildren();
    if (!items.length) return renderSearchNotice('По этому запросу ничего не найдено. Попробуй другое название или сократи запрос.');
    items.forEach((item) => {
      const kind = 'vk';
      const card = document.createElement('article'); card.className = 'result-card';
      const thumb = document.createElement('img'); thumb.className = 'result-thumb'; thumb.loading = 'lazy'; thumb.alt = ''; thumb.decoding = 'async';
      if (item.thumbnail) thumb.src = item.thumbnail;
      thumb.onerror = () => { thumb.classList.add('thumb-unavailable'); thumb.removeAttribute('src'); };
      const copy = document.createElement('div'); copy.className = 'result-copy';
      const name = document.createElement('strong'); name.className = 'result-title'; name.textContent = item.title || 'Видео';
      const author = document.createElement('span'); author.className = 'result-author'; author.textContent = item.author || 'Автор видео';
      const play = document.createElement('button'); play.className = 'result-play'; play.type = 'button'; play.textContent = 'Выбрать видео';
      play.setAttribute('aria-label', `Выбрать видео: ${item.title || 'Видео'}`);
      play.addEventListener('click', () => {
        play.disabled = true; play.textContent = 'Открываем…';
        closeModal('videoSearchModal');
        playSelectedVideo(kind, item.id, item.title || 'Видео', item.author || 'Автор видео', true)
          .catch((error) => { console.error('SYNC select video failed:', error); showToast('Не удалось открыть это видео. Выбери другое.'); })
          .finally(() => { play.disabled = false; play.textContent = 'Выбрать видео'; });
      });
      copy.append(name, author, play); card.append(thumb, copy); box.append(card);
    });
  }

  function renderSearchNotice(message) {
    const box = $('#searchResults'); box.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'search-empty'; empty.textContent = message; box.append(empty);
  }

  function markPlaybackStarted() {
    playbackStarted = true;
    clearTimeout(autoplayTimer);
    $('#playerGesture').classList.add('hidden');
  }
  function armAutoplayWatchdog() {
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => { if (!playbackStarted && currentVideo) $('#playerGesture').classList.remove('hidden'); }, 3500);
  }

  function loadYoutubeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve, reject) => {
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try { prior?.(); } catch {} resolve(); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
      script.onerror = () => {
        youtubeApiPromise = null;
        reject(new Error('Не удалось загрузить YouTube Player API'));
      };
      document.head.append(script);
    });
    return youtubeApiPromise;
  }

  async function playSelectedVideo(kind, videoId, title, channelTitle, broadcast = true, initial = {}) {
    if (kind === 'youtube') return playYoutube(videoId, title, channelTitle, broadcast, initial);
    if (kind === 'vk') return playVk(videoId, title, channelTitle, broadcast, initial);
  }

  async function announceVideo(kind, videoId, title, channelTitle) {
    if (!roomChannel || !authUser) return;
    const current = { provider: kind, videoId, title, channelTitle, state: 'playing', time: 0 };
    await roomChannel.send({ type: 'broadcast', event: 'video', payload: { user_id: authUser.id, ...current } });
    // Only active participants share the current video; old selections are not restored on a later visit.
  }

  async function playYoutube(videoId, title, channelTitle, broadcast = true, initial = {}) {
    if (!/^[\w-]{6,}$/.test(videoId || '')) return showToast('Не удалось открыть это видео');
    clearTimeout(autoplayTimer);
    pendingRemotePlayback = null;
    const generation = ++playerGeneration;
    playerSeekPreview = null;
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    resetVkPlayer();
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden'); $('#playerGesture').classList.add('hidden'); $('#playerControls').classList.remove('hidden'); startPlayerUiTimer();
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    const target = document.createElement('div'); target.id = 'ytPlayer'; wrap.append(target);
    currentVideo = { provider: 'youtube', videoId, title, channelTitle };
    playbackStarted = false;
    $('#videoTitle').textContent = title; $('#videoSource').textContent = channelTitle || ''; $('#videoCover').textContent = '▶'; $('#syncLabel').textContent = 'Подключаем YouTube…';
    if (broadcast) await announceVideo('youtube', videoId, title, channelTitle);
    try {
      await loadYoutubeApi();
      if (generation !== playerGeneration || currentVideo?.provider !== 'youtube' || currentVideo?.videoId !== videoId) return;
      youtubePlayer = new window.YT.Player('ytPlayer', {
        host: 'https://www.youtube-nocookie.com',
        videoId,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, controls: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: (event) => {
            if (generation !== playerGeneration) { try { event.target.destroy(); } catch {} return; }
            if (Number(initial.time) > 0) event.target.seekTo(Number(initial.time), true);
            if (initial.state !== 'paused') { event.target.playVideo(); armAutoplayWatchdog(); }
            $('#syncLabel').textContent = 'YouTube подключён';
          },
          onStateChange: (event) => {
            if (generation !== playerGeneration) return;
            if (event.data === window.YT.PlayerState.PLAYING) markPlaybackStarted();
            updatePlayerControls();
            if (Date.now() < suppressPlaybackBroadcastUntil) return;
            const state = event.data;
            const mapped = state === window.YT.PlayerState.PLAYING ? 'playing' : state === window.YT.PlayerState.PAUSED ? 'paused' : state === window.YT.PlayerState.ENDED ? 'ended' : null;
            if (mapped) broadcastPlayback('youtube', mapped, event.target.getCurrentTime?.() || 0);
          },
          onAutoplayBlocked: () => { if (generation === playerGeneration) $('#playerGesture').classList.remove('hidden'); },
          onError: (event) => { if (generation !== playerGeneration) return; $('#syncLabel').textContent = 'Видео недоступно'; showToast(`YouTube: ошибка плеера ${event.data}`); }
        }
      });
    } catch (error) {
      if (generation !== playerGeneration) return;
      $('#playerError').textContent = error.message;
      $('#playerError').classList.remove('hidden');
    }
    if (generation === playerGeneration) $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetVkPlayer() {
    if (vkPlayer) { try { vkPlayer.destroy(); } catch {} vkPlayer = null; }
    if (vkFrame) { vkFrame.remove(); vkFrame = null; }
    vkReady = false; vkPlaying = false; vkMuted = false; vkAdPlaying = false; vkDuration = 0;
    lastVkPosition = 0; lastVkSyncAt = 0;
  }

  // ID видео VK внутри SYNC: «владелец_видео» или «владелец_видео_hash» (hash нужен для видео по ссылке).
  function parseVkVideoId(value) {
    const match = VK_VIDEO_ID.exec(String(value || ''));
    return match ? { oid: match[1], id: match[2], hash: match[3] || '' } : null;
  }

  // Принимает ссылки вида vk.com/video-1_2, vkvideo.ru/video-1_2 и код вставки video_ext.php?oid=…&id=….
  function parseVkLink(text) {
    const raw = String(text || '').trim();
    if (!raw || /\s/.test(raw)) return null;
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)(vk\.com|vk\.ru|vkvideo\.ru)$/i.test(url.hostname)) return null;
    let oid = url.searchParams.get('oid');
    let id = url.searchParams.get('id');
    if (!oid || !id) {
      const found = /video(-?\d+)_(\d+)/i.exec(url.pathname + url.search);
      if (!found) return null;
      [, oid, id] = found;
    }
    const hash = url.searchParams.get('hash') || '';
    const videoId = `${oid}_${id}${/^[a-f0-9]{8,40}$/i.test(hash) ? `_${hash}` : ''}`;
    return parseVkVideoId(videoId) ? videoId : null;
  }

  function buildVkEmbedUrl(parsed) {
    const params = new URLSearchParams({ oid: parsed.oid, id: parsed.id, autoplay: '1', js_api: '1' });
    if (parsed.hash) params.set('hash', parsed.hash);
    return `${VK_HOST}/video_ext.php?${params}`;
  }

  function loadVkApi() {
    if (window.VK?.VideoPlayer) return Promise.resolve();
    if (vkApiPromise) return vkApiPromise;
    vkApiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${VK_HOST}/js/api/videoplayer.js`; script.async = true;
      script.onload = () => {
        if (window.VK?.VideoPlayer) { resolve(); return; }
        vkApiPromise = null; script.remove();
        reject(new Error('API плеера VK Видео не запустился'));
      };
      script.onerror = () => {
        vkApiPromise = null; script.remove();
        reject(new Error('Не удалось загрузить API плеера VK Видео'));
      };
      document.head.append(script);
    });
    return vkApiPromise;
  }

  async function playVk(videoId, title, channelTitle, broadcast = true, initial = {}) {
    const parsed = parseVkVideoId(videoId);
    if (!parsed) return showToast('Не удалось распознать видео VK Видео');
    clearTimeout(autoplayTimer);
    const generation = ++playerGeneration;
    playerSeekPreview = null;
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    resetVkPlayer();
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden'); $('#playerGesture').classList.add('hidden'); $('#playerControls').classList.remove('hidden'); startPlayerUiTimer();
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    currentVideo = { provider: 'vk', videoId, title, channelTitle };
    playbackStarted = false;
    $('#videoTitle').textContent = title; $('#videoSource').textContent = channelTitle || ''; $('#videoCover').textContent = '▶'; $('#syncLabel').textContent = 'Подключаем VK Видео…';
    pendingRemotePlayback = initial;
    if (broadcast) await announceVideo('vk', videoId, title, channelTitle);
    try {
      await loadVkApi();
      if (generation !== playerGeneration || currentVideo?.provider !== 'vk' || currentVideo?.videoId !== videoId) return;
      // Сначала создаём iframe, и сразу же подключаем API: событие inited не должно пройти мимо.
      const frame = document.createElement('iframe');
      frame.id = 'vkPlayer'; frame.title = title;
      frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.src = buildVkEmbedUrl(parsed);
      wrap.replaceChildren(frame); vkFrame = frame;
      vkPlayer = window.VK.VideoPlayer(frame);
      bindVkPlayer(vkPlayer, generation);
      setTimeout(() => {
        if (generation === playerGeneration && !vkReady) $('#syncLabel').textContent = 'VK Видео отвечает долго. Если видео не запускается, отключи блокировщики для этого сайта';
      }, 10000);
    } catch (error) {
      if (generation !== playerGeneration) return;
      $('#playerError').textContent = error?.message || 'Не удалось открыть VK Видео';
      $('#playerError').classList.remove('hidden');
    }
    if (generation === playerGeneration) $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function vkCommand(action, ...args) {
    if (!vkPlayer || !vkReady) return;
    try { vkPlayer[action](...args); } catch (error) { console.warn('SYNC VK command failed:', action, error); }
  }

  function bindVkPlayer(player, generation) {
    const on = (event, handler) => player.on(event, (state) => {
      if (generation !== playerGeneration || vkPlayer !== player) return;
      handler(state && typeof state === 'object' ? state : {});
    });
    const readState = (state) => {
      const duration = Number(state.duration);
      if (Number.isFinite(duration) && duration > 0) vkDuration = duration;
      if (state.muted !== undefined) vkMuted = state.muted === true || state.muted === 'true';
      const time = Number(state.time);
      return Number.isFinite(time) ? time : null;
    };
    const canBroadcast = () => !vkAdPlaying && Date.now() >= suppressPlaybackBroadcastUntil;

    on('inited', (state) => {
      vkReady = true; readState(state);
      $('#syncLabel').textContent = 'VK Видео подключено';
      const pending = pendingRemotePlayback; pendingRemotePlayback = null;
      if (pending) applyPlaybackState({ ...pending, provider: 'vk', videoId: currentVideo?.videoId });
      if (pending?.state !== 'paused') armAutoplayWatchdog();
      updatePlayerControls();
    });
    const onPlay = (state) => {
      const time = readState(state); if (time !== null) lastVkPosition = time;
      vkPlaying = true; markPlaybackStarted(); updatePlayerControls();
      if (canBroadcast()) broadcastPlayback('vk', 'playing', lastVkPosition);
    };
    on('started', onPlay);
    on('resumed', onPlay);
    on('paused', (state) => {
      const time = readState(state); if (time !== null) lastVkPosition = time;
      vkPlaying = false; updatePlayerControls();
      if (canBroadcast()) broadcastPlayback('vk', 'paused', lastVkPosition);
    });
    on('ended', (state) => {
      const time = readState(state); if (time !== null) lastVkPosition = time;
      vkPlaying = false; updatePlayerControls();
      if (canBroadcast()) broadcastPlayback('vk', 'ended', lastVkPosition);
    });
    on('timeupdate', (state) => {
      const next = readState(state); if (next === null) return;
      const previous = lastVkPosition; lastVkPosition = next;
      if (vkAdPlaying) return;
      if (previous > 0 && Math.abs(next - previous) > 3 && Date.now() > suppressPlaybackBroadcastUntil) broadcastPlayback('vk', 'seek', next);
      if (vkPlaying && Date.now() - lastVkSyncAt > 5000 && isSyncLeader()) { lastVkSyncAt = Date.now(); broadcastPlayback('vk', 'sync', lastVkPosition); }
    });
    on('volumechange', (state) => { readState(state); updatePlayerControls(); });
    on('adStarted', () => { vkAdPlaying = true; });
    on('adCompleted', () => { vkAdPlaying = false; });
    on('error', () => {
      $('#syncLabel').textContent = 'Видео недоступно';
      showToast('VK Видео: не удалось воспроизвести это видео');
    });
  }

  function formatPlayerTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(value / 60); const secs = value % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function getCurrentPlayerTime() {
    if (currentVideo?.provider === 'youtube') return Number(youtubePlayer?.getCurrentTime?.()) || 0;
    if (currentVideo?.provider === 'vk') return Number(lastVkPosition) || 0;
    return 0;
  }

  function startPlayerUiTimer() {
    if (playerUiTimer) clearInterval(playerUiTimer);
    playerUiTimer = setInterval(updatePlayerControls, 500);
    updatePlayerControls();
  }

  function updatePlayerControls() {
    const bar = $('#playerControls');
    if (!bar || !currentVideo) { bar?.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    let current = getCurrentPlayerTime(); let duration = vkDuration; let playing = false; let muted = false;
    if (currentVideo.provider === 'youtube' && youtubePlayer?.getDuration) {
      duration = Number(youtubePlayer.getDuration()) || 0;
      const state = youtubePlayer.getPlayerState?.();
      playing = state === window.YT?.PlayerState?.PLAYING;
      muted = Boolean(youtubePlayer.isMuted?.());
    }
    if (currentVideo.provider === 'vk') { playing = vkPlaying; muted = vkMuted; }
    const seek = $('#playerSeek');
    const hasPreview = playerSeekPreview !== null && Number.isFinite(playerSeekPreview);
    const progress = hasPreview ? playerSeekPreview : (duration ? Math.min(1, current / duration) : 0);
    seek.disabled = !duration;
    if (!hasPreview && !seek.matches(':active')) seek.value = duration ? String(Math.round(progress * 1000)) : '0';
    seek.style.setProperty('--seek-progress', `${progress * 100}%`);
    const displayTime = hasPreview && duration ? duration * playerSeekPreview : current;
    $('#playerCurrentTime').textContent = formatPlayerTime(displayTime);
    $('#playerDurationTime').textContent = duration ? formatPlayerTime(duration) : '—:—';
    const playButton = $('#playerPlayPause');
    playButton.classList.toggle('is-playing', playing);
    playButton.setAttribute('aria-label', playing ? 'Пауза' : 'Продолжить');
    playButton.title = playing ? 'Пауза' : 'Продолжить';
    const muteButton = $('#playerMute');
    muteButton.classList.toggle('is-muted', muted);
    muteButton.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
    muteButton.title = muted ? 'Включить звук' : 'Выключить звук';
  }

  function togglePlayerPlayback() {
    if (!currentVideo) return;
    if (currentVideo.provider === 'youtube' && youtubePlayer) {
      const playing = youtubePlayer.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
      if (playing) youtubePlayer.pauseVideo(); else youtubePlayer.playVideo();
    } else if (currentVideo.provider === 'vk' && vkReady) {
      vkCommand(vkPlaying ? 'pause' : 'play');
    }
  }

  function seekPlayer(value) {
    const position = Math.max(0, Number(value) || 0) / 1000;
    if (currentVideo?.provider === 'youtube' && youtubePlayer) {
      const duration = Number(youtubePlayer.getDuration?.()) || 0;
      if (duration) { const time = duration * position; youtubePlayer.seekTo(time, true); broadcastPlayback('youtube', 'seek', time); }
    } else if (currentVideo?.provider === 'vk' && vkReady && vkDuration) {
      const time = vkDuration * position; lastVkPosition = time; vkCommand('seek', time); broadcastPlayback('vk', 'seek', time);
    }
  }

  function togglePlayerMute() {
    if (currentVideo?.provider === 'youtube' && youtubePlayer) {
      if (youtubePlayer.isMuted?.()) youtubePlayer.unMute(); else youtubePlayer.mute();
    } else if (currentVideo?.provider === 'vk' && vkReady) {
      vkMuted = !vkMuted; vkCommand(vkMuted ? 'mute' : 'unmute');
    }
    updatePlayerControls();
  }

  async function broadcastPlayback(kind, state, time) {
    if (!roomChannel || !authUser || Date.now() < suppressPlaybackBroadcastUntil) return;
    const payload = { provider: kind, videoId: currentVideo?.videoId, title: currentVideo?.title, channelTitle: currentVideo?.channelTitle, state, time: Number(time) || 0, sentAt: Date.now() };
    try {
      await roomChannel.send({ type: 'broadcast', event: 'playback', payload: { user_id: authUser.id, ...payload } });
      // Do not persist playback to the database: returning later should start with an empty room.
    } catch (error) { console.warn('SYNC playback broadcast failed', error); }
  }

  function applyPlaybackState(payload) {
    if (!currentVideo || payload.videoId !== currentVideo.videoId || payload.provider !== currentVideo.provider) return;
    const time = Math.max(0, Number(payload.time) || 0);
    if (payload.provider === 'youtube' && youtubePlayer) {
      const local = youtubePlayer.getCurrentTime?.() || 0;
      if (Number.isFinite(time) && Math.abs(local - time) > 2.5) youtubePlayer.seekTo(time, true);
      if (payload.state === 'playing' || payload.state === 'sync' || payload.state === 'seek') youtubePlayer.playVideo();
      else if (payload.state === 'paused' || payload.state === 'ended') youtubePlayer.pauseVideo();
    } else if (payload.provider === 'vk' && vkReady) {
      const drift = Math.abs((Number(lastVkPosition) || 0) - time);
      if (payload.state === 'seek' || drift > 2.5) vkCommand('seek', time);
      if (payload.state === 'playing' || payload.state === 'sync') vkCommand('play');
      else if (payload.state === 'paused' || payload.state === 'ended') vkCommand('pause');
    }
  }

  async function broadcastRoomHeartbeat() {
    if (!roomChannel || !currentVideo || !isSyncLeader()) return;
    if (currentVideo.provider === 'youtube' && youtubePlayer?.getPlayerState) {
      const state = youtubePlayer.getPlayerState();
      if (state === window.YT?.PlayerState?.PLAYING) broadcastPlayback('youtube', 'sync', youtubePlayer.getCurrentTime?.() || 0);
    } else if (currentVideo.provider === 'vk' && vkReady && vkPlaying && !vkAdPlaying) {
      broadcastPlayback('vk', 'sync', lastVkPosition);
    }
  }

  function enablePlaybackFromGesture() {
    markPlaybackStarted();
    suppressPlaybackBroadcastUntil = Date.now() + 1000;
    if (currentVideo?.provider === 'youtube') youtubePlayer?.playVideo?.();
    else if (currentVideo?.provider === 'vk') { vkCommand('unmute'); vkCommand('play'); }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    field.style.pointerEvents = 'none';
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); }
    finally { field.remove(); }
    if (!copied) throw new Error('Браузер не разрешил копирование');
    return true;
  }

  async function shareRoom(friendName = '') {
    if (!currentRoom || !inviteToken) return showToast('Комната ещё создаётся');
    const url = roomUrl();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Моя комната SYNC', text: friendName ? `Присоединяйся к просмотру, ${friendName}!` : 'Заходи смотреть вместе!', url });
      } else {
        await copyText(url);
        showToast(friendName ? `Ссылка для ${friendName} скопирована` : 'Ссылка на комнату скопирована');
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      try {
        await copyText(url);
        showToast('Ссылка на комнату скопирована');
      } catch {
        showToast(`Скопируй ссылку: ${url}`);
      }
    }
  }

  function openModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    const firstField = modal.querySelector('input:not([type="file"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
      || modal.querySelector('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
    (firstField || modal.querySelector('.modal-card'))?.focus({ preventScroll: true });
    if (id === 'friendModal') loadIncomingRequests();
  }

  function closeModal(id) {
    const modal = $(`#${id}`);
    if (!modal) return;
    modal.classList.add('hidden');
    if (id === 'friendModal') $$('.nav-link').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === '#watch'));
    if (!$('.modal-backdrop:not(.hidden)')) document.body.classList.remove('modal-open');
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus({ preventScroll: true });
    modalReturnFocus = null;
  }

  function bindEvents() {
    $('#authForm').addEventListener('submit', submitAuth);
    $('#googleSignIn').addEventListener('click', signInWithGoogle);
    $('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#avatarInput').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) uploadAvatar(file);
      event.target.value = '';
    });
    $('#logoutButton').addEventListener('click', signOut);
    $('#profileButton').addEventListener('click', () => { updateProfileUI(); openModal('profileModal'); });
    $('#providerSearchForm').addEventListener('submit', (event) => { event.preventDefault(); searchVideos($('#providerSearchInput').value); });
    $('#addVideoButton').addEventListener('click', () => {
      $('#providerSearchInput').value = '';
      $('#searchResults').replaceChildren();
      $('#providerMessage').textContent = currentRoom ? 'Введи название фильма, сериала или видео — или вставь ссылку на видео VK.' : 'Сначала подключись к комнате, чтобы выбрать видео для общего просмотра.';
      $('#providerSearchButton').disabled = false;
      openModal('videoSearchModal');
    });
    $('#playerPlayPause').addEventListener('click', togglePlayerPlayback);
    $('#playerSeek').addEventListener('input', (event) => {
      playerSeekPreview = Math.max(0, Math.min(1000, Number(event.target.value) || 0)) / 1000;
      updatePlayerControls();
    });
    $('#playerSeek').addEventListener('change', (event) => {
      seekPlayer(event.target.value);
      playerSeekPreview = null;
      updatePlayerControls();
    });
    $('#playerSeek').addEventListener('blur', () => {
      playerSeekPreview = null;
      updatePlayerControls();
    });
    $('#playerSeek').addEventListener('pointercancel', () => {
      playerSeekPreview = null;
      updatePlayerControls();
    });
    $('#playerMute').addEventListener('click', togglePlayerMute);
    $('#voiceToggle').addEventListener('click', () => voiceEnabled ? toggleVoiceMute() : toggleVoice());
    $('#voiceLeave').addEventListener('click', toggleVoice);
    $('#startPlayback').addEventListener('click', enablePlaybackFromGesture);
    window.addEventListener('pagehide', stopVoiceLocally);
    $('#inviteTop').addEventListener('click', () => shareRoom());
    $('#invitePeople').addEventListener('click', () => shareRoom());
    $('#shareRoom').addEventListener('click', () => shareRoom());
    $('#shareRoomSmall').addEventListener('click', () => shareRoom());
    $('#newRoom').addEventListener('click', () => createRoom(true));
    $('#addFriend').addEventListener('click', () => openModal('friendModal'));
    $('#friendsNav').addEventListener('click', () => { $$('.nav-link').forEach((item) => item.classList.toggle('active', item.id === 'friendsNav')); openModal('friendModal'); });
    document.querySelector('.nav-link[href="#watch"]')?.addEventListener('click', () => $$('.nav-link').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === '#watch')));
    $('#friendSearchForm').addEventListener('submit', searchUsers);
    document.addEventListener('keydown', (event) => {
      const activeModal = $('.modal-backdrop:not(.hidden)');
      if (!activeModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(activeModal.id);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...activeModal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0 && !element.classList.contains('visually-hidden'));
      if (!focusable.length) {
        event.preventDefault();
        activeModal.querySelector('.modal-card')?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
    $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
    $('#chatForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = $('#chatInput');
      const message = input.value.trim();
      if (!message) return;
      const sent = await sendChatMessage(message);
      if (sent) input.value = '';
    });
    $('#fullscreenButton').addEventListener('click', () => {
      const target = $('#playerStage');
      if (document.fullscreenElement) document.exitFullscreen?.();
      else if (target.requestFullscreen) target.requestFullscreen().catch(() => showToast('Полный экран недоступен'));
      else showToast('Полный экран недоступен в этом браузере');
    });
    $('#installApp')?.addEventListener('click', installApplication);
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      $('#installApp')?.classList.add('hidden');
      showToast('SYNC установлен на устройство');
    });
  }

  async function installApplication() {
    if (!installPrompt) return;
    const promptEvent = installPrompt;
    installPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') showToast('Установка SYNC началась');
    } catch (error) {
      console.warn('SYNC install prompt failed:', error);
      showToast('Не удалось открыть установку приложения');
    } finally {
      $('#installApp')?.classList.add('hidden');
    }
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !['https:', 'http:'].includes(location.protocol)) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('SYNC обновлён. Перезагрузи страницу, чтобы применить изменения.');
          }
        });
      });
    } catch (error) {
      console.warn('SYNC service worker registration failed:', error);
    }
  }

  async function start() {
    bindEvents();
    void registerServiceWorker();
    if (!initializeAuthUI()) return;
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) setAuthStatus(error.message, true);
    if (session?.user) await bootstrapUser(session.user);
    supabase.auth.onAuthStateChange((event, sessionNow) => {
      if (sessionNow?.user && !authUser && !bootstrapping) queueMicrotask(() => bootstrapUser(sessionNow.user));
      else if (!sessionNow?.user && event === 'SIGNED_OUT') {
        authUser = null; profile = null; resetRoomState(); showAuthGate();
      }
    });
  }

  start().catch((error) => {
    console.error(error);
    showAuthGate();
    setAuthStatus(error.message || 'Не удалось запустить SYNC.', true);
  });
})();

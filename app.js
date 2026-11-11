(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const config = window.SYNC_CONFIG || {};
  const providers = {
    youtube: { name: 'YouTube', description: 'Ищи видео прямо здесь. Выбранный ролик откроется в общей комнате.' },
    rutube: { name: 'RUTUBE', description: 'Ищи публичные видео и запускай встроенный плеер для всех участников.' },
    vk: { name: 'VK Видео', description: 'Подключение встроенного каталога VK Видео пока готовится.' },
    netflix: { name: 'Netflix', description: 'Netflix использует защищённый плеер, который нельзя встроить в сторонний сайт.' },
    kinopoisk: { name: 'Кинопоиск', description: 'Кинопоиск использует защищённый плеер, который нельзя встроить в сторонний сайт.' }
  };

  let supabase = null;
  let authUser = null;
  let profile = null;
  let authMode = 'signin';
  let provider = 'youtube';
  let currentRoom = null;
  let inviteToken = null;
  let roomChannel = null;
  let onlineChannel = null;
  let friends = [];
  let incomingRequests = [];
  let onlineIds = new Set();
  let currentVideo = null;
  let youtubePlayer = null;
  let youtubeApiPromise = null;
  let rutubeFrame = null;
  let rutubeReady = false;
  let pendingRemotePlayback = null;
  let suppressPlaybackBroadcastUntil = 0;
  let roomOwnerId = null;
  let syncTimer = null;
  let lastRutubePosition = 0;
  let lastRutubeSyncAt = 0;
  let playbackStarted = false;
  let autoplayTimer = null;
  let lastPersistAt = 0;
  let toastTimer = null;
  let bootstrapping = false;
  const presenceSessionId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

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
      button.innerHTML = '<span class="google-g">G</span> Продолжить с Google';
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
    return { user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url || null };
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
    currentRoom = null; inviteToken = null; roomOwnerId = null; currentVideo = null; pendingRemotePlayback = null;
    clearTimeout(autoplayTimer);
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    if (rutubeFrame) { rutubeFrame.remove(); rutubeFrame = null; }
    rutubeReady = false;
    $('#embedWrap').replaceChildren(); $('#embedWrap').classList.add('hidden');
    $('#stagePlaceholder').classList.remove('hidden'); $('#playerGesture').classList.add('hidden'); $('#playerError').classList.add('hidden');
    $('#videoTitle').textContent = 'Пока ничего'; $('#videoSource').textContent = 'Выберите площадку ниже'; $('#videoCover').textContent = 'S';
    $('#chatMessages').replaceChildren();
    const welcome = document.createElement('div'); welcome.className = 'chat-welcome'; welcome.textContent = 'Общайтесь, пока идёт фильм.'; $('#chatMessages').append(welcome);
    const url = new URL(location.href); url.searchParams.delete('room'); url.searchParams.delete('invite'); history.replaceState({}, '', url);
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
    $('#profileModal').classList.add('hidden');
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

  async function tryJoinRoom(roomId, token) {
    const { error } = await supabase.rpc('join_sync_room', { p_room_id: roomId, p_invite_token: token });
    if (error) return false;
    currentRoom = roomId; inviteToken = token;
    setRoomUrl(roomId, token);
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

  async function createRoom(showMessage = true) {
    const { data, error } = await supabase.rpc('create_sync_room');
    if (error) {
      showToast(`Не удалось создать комнату: ${error.message}`);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.room_id || !row?.invite_token) {
      showToast('Supabase не вернул ссылку комнаты');
      return;
    }
    currentRoom = row.room_id;
    inviteToken = row.invite_token;
    setRoomUrl(currentRoom, inviteToken);
    $('#syncLabel').textContent = 'Новая комната';
    await connectRoom();
    if (showMessage) showToast('Новая комната создана');
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
    if (roomChannel) await supabase.removeChannel(roomChannel);
    roomChannel = supabase.channel(`sync-room:${currentRoom}`, {
      config: { private: true, presence: { key: `${authUser.id}:${presenceSessionId}` }, broadcast: { self: false } }
    });
    roomChannel
      .on('presence', { event: 'sync' }, renderMembers)
      .on('presence', { event: 'join' }, renderMembers)
      .on('presence', { event: 'leave' }, renderMembers)
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        if (payload?.user_id !== authUser.id) addChatMessage(payload?.name || 'Друг', payload?.message || '', false, payload?.avatar_url || '', payload?.created_at || Date.now());
      })
      .on('broadcast', { event: 'video' }, async ({ payload }) => {
        if (payload?.user_id !== authUser.id && payload?.videoId && ['youtube', 'rutube'].includes(payload.provider)) {
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
    roomChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await roomChannel.track(presencePayload());
        renderMembers();
        $('#syncLabel').textContent = 'Комната синхронизирована';
        loadPersistedRoomState();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
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
  }

  async function sendChatMessage(message) {
    const createdAt = Date.now();
    addChatMessage(displayName(), message, true, profile?.avatar_url, createdAt);
    if (roomChannel) await roomChannel.send({ type: 'broadcast', event: 'chat', payload: { user_id: authUser.id, name: displayName(), avatar_url: profile?.avatar_url || null, message, created_at: createdAt } });
  }

  function selectProvider(name) {
    provider = providers[name] ? name : 'youtube';
    $$('.provider-card').forEach((card) => card.classList.toggle('selected', card.dataset.provider === provider));
    $('#providerWorkspace').classList.remove('hidden');
    $('#providerTitle').textContent = providers[provider].name;
    $('#providerDescription').textContent = providers[provider].description;
    $('#providerSearchForm').classList.toggle('hidden', !['youtube', 'rutube'].includes(provider));
    $('#searchResults').replaceChildren();
    const message = $('#providerMessage');
    message.classList.remove('hidden');
    if (provider === 'youtube') {
      message.textContent = 'Ищи видео здесь. Нажми «Смотреть вместе», и ролик появится у всех в комнате.';
      $('#providerSearchInput').placeholder = 'Что найти на YouTube?';
    } else if (provider === 'rutube') {
      message.textContent = 'Ищи публичные видео RUTUBE. Поиск использует открытый endpoint площадки и может временно ограничиваться самим RUTUBE.';
      $('#providerSearchInput').placeholder = 'Что найти на RUTUBE?';
    } else {
      const messages = {
        vk: 'Встроенный поиск VK Видео пока не подключён. Внешнюю страницу не открываем: добавим официальный API/виджет, когда будет доступ к интеграции.',
        netflix: 'Netflix не разрешает сторонним сайтам встраивать защищённый видеоплеер. Поэтому нельзя запустить один и тот же фильм внутри SYNC на двух устройствах через обычный iframe.',
        kinopoisk: 'Кинопоиск использует защищённое воспроизведение и не предоставляет SYNC открытый плеер для встраивания. Внешнюю вкладку без твоего согласия не открываем.'
      };
      message.textContent = messages[provider];
    }
    $('#providerWorkspace').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderSearchNotice(message) {
    const box = $('#searchResults'); box.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'search-empty'; empty.textContent = message; box.append(empty);
  }

  async function searchVideos(query) {
    const cleaned = String(query || '').trim();
    if (!cleaned) { showToast('Напиши, что ищем'); $('#providerSearchInput').focus(); return; }
    if (!['youtube', 'rutube'].includes(provider)) return renderSearchNotice('Поиск этой площадки пока не подключён.');
    const submit = $('#providerSearchForm button[type="submit"]');
    submit.disabled = true; submit.textContent = 'Ищем…';
    renderSearchNotice(`Ищем «${cleaned}» на ${providers[provider].name}…`);
    try {
      const { data, error } = await supabase.functions.invoke('sync-search', { body: { provider, query: cleaned } });
      if (error) {
        let serverMessage = '';
        try {
          const body = await error.context?.clone?.().json?.();
          serverMessage = body?.error || body?.message || '';
        } catch {}
        throw new Error(serverMessage || error.message || 'Функция поиска не отвечает');
      }
      if (data?.error) throw new Error(data.error);
      renderVideoCards(Array.isArray(data?.results) ? data.results : [], provider);
    } catch (error) {
      const text = String(error?.message || error);
      if (/404|not found|function not found|non-2xx|functionsfetcherror|failed to send a request/i.test(text)) {
        renderSearchNotice('Поиск ещё не подключён к серверу. В архиве есть функция sync-search — её нужно один раз опубликовать в Supabase.');
      } else if (/YOUTUBE_API_KEY/i.test(text)) {
        renderSearchNotice('Для поиска YouTube добавь ключ YouTube Data API v3 в Secrets функции sync-search в Supabase.');
      } else {
        renderSearchNotice(`Не получилось выполнить поиск: ${text}`);
      }
    } finally {
      submit.disabled = false; submit.textContent = 'Найти';
    }
  }

  function renderVideoCards(items, kind) {
    const box = $('#searchResults'); box.replaceChildren();
    if (!items.length) return renderSearchNotice('Ничего не найдено. Попробуй другой запрос.');
    items.forEach((item) => {
      const card = document.createElement('article'); card.className = 'result-card';
      const thumb = document.createElement('img'); thumb.className = 'result-thumb'; thumb.loading = 'lazy'; thumb.alt = ''; thumb.src = item.thumbnail || '';
      const copy = document.createElement('div'); copy.className = 'result-copy';
      const name = document.createElement('strong'); name.textContent = item.title || 'Видео';
      const author = document.createElement('span'); author.textContent = item.author || (kind === 'youtube' ? 'YouTube' : 'RUTUBE');
      const play = document.createElement('button'); play.className = 'result-play'; play.type = 'button'; play.textContent = 'Смотреть вместе';
      play.addEventListener('click', () => playSelectedVideo(kind, item.id, item.title || 'Видео', item.author || providers[kind].name, true));
      copy.append(name, author, play); card.append(thumb, copy); box.append(card);
    });
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
      script.onerror = () => reject(new Error('Не удалось загрузить YouTube Player API'));
      document.head.append(script);
    });
    return youtubeApiPromise;
  }

  async function playSelectedVideo(kind, videoId, title, channelTitle, broadcast = true, initial = {}) {
    if (kind === 'youtube') return playYoutube(videoId, title, channelTitle, broadcast, initial);
    if (kind === 'rutube') return playRutube(videoId, title, channelTitle, broadcast, initial);
  }

  async function announceVideo(kind, videoId, title, channelTitle) {
    if (!roomChannel || !authUser) return;
    const current = { provider: kind, videoId, title, channelTitle, state: 'playing', time: 0 };
    await roomChannel.send({ type: 'broadcast', event: 'video', payload: { user_id: authUser.id, ...current } });
    await savePersistedRoomState(current);
  }

  async function savePersistedRoomState(state) {
    if (!supabase || !currentRoom || !authUser) return;
    const { error } = await supabase.from('sync_room_state').upsert({
      room_id: currentRoom,
      current_video: state,
      updated_by: authUser.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'room_id' });
    if (error) console.warn('SYNC room state was not saved:', error.message);
  }

  async function loadPersistedRoomState() {
    if (!supabase || !currentRoom) return;
    const { data, error } = await supabase.from('sync_room_state').select('current_video').eq('room_id', currentRoom).maybeSingle();
    if (error) { console.warn('SYNC room state could not be loaded:', error.message); return; }
    const state = data?.current_video;
    if (!state?.provider || !state?.videoId || !['youtube', 'rutube'].includes(state.provider)) return;
    if (currentVideo?.videoId === state.videoId && currentVideo?.provider === state.provider) return;
    suppressPlaybackBroadcastUntil = Date.now() + 5000;
    await playSelectedVideo(state.provider, state.videoId, state.title || 'Видео', state.channelTitle || providers[state.provider].name, false, { state: state.state || 'playing', time: Number(state.time) || 0 });
  }

  async function playYoutube(videoId, title, channelTitle, broadcast = true, initial = {}) {
    if (!/^[\w-]{6,}$/.test(videoId || '')) return showToast('Не удалось открыть это видео');
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    if (rutubeFrame) { rutubeFrame.remove(); rutubeFrame = null; }
    rutubeReady = false;
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden'); $('#playerGesture').classList.add('hidden');
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    const target = document.createElement('div'); target.id = 'ytPlayer'; wrap.append(target);
    currentVideo = { provider: 'youtube', videoId, title, channelTitle };
    playbackStarted = false;
    $('#videoTitle').textContent = title; $('#videoSource').textContent = `${channelTitle} · YouTube`; $('#videoCover').textContent = '▶'; $('#syncLabel').textContent = 'Подключаем YouTube…';
    if (broadcast) await announceVideo('youtube', videoId, title, channelTitle);
    try {
      await loadYoutubeApi();
      youtubePlayer = new window.YT.Player('ytPlayer', {
        host: 'https://www.youtube-nocookie.com',
        videoId,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: (event) => {
            if (Number(initial.time) > 0) event.target.seekTo(Number(initial.time), true);
            if (initial.state !== 'paused') { event.target.playVideo(); armAutoplayWatchdog(); }
            $('#syncLabel').textContent = 'YouTube подключён';
          },
          onStateChange: (event) => {
            if (event.data === window.YT.PlayerState.PLAYING) markPlaybackStarted();
            if (Date.now() < suppressPlaybackBroadcastUntil) return;
            const state = event.data;
            const mapped = state === window.YT.PlayerState.PLAYING ? 'playing' : state === window.YT.PlayerState.PAUSED ? 'paused' : state === window.YT.PlayerState.ENDED ? 'ended' : null;
            if (mapped) broadcastPlayback('youtube', mapped, event.target.getCurrentTime?.() || 0);
          },
          onAutoplayBlocked: () => $('#playerGesture').classList.remove('hidden'),
          onError: (event) => { $('#syncLabel').textContent = 'Видео недоступно'; showToast(`YouTube: ошибка плеера ${event.data}`); }
        }
      });
    } catch (error) { $('#playerError').textContent = error.message; $('#playerError').classList.remove('hidden'); }
    $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function playRutube(videoId, title, channelTitle, broadcast = true, initial = {}) {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(videoId || '')) return showToast('Не удалось распознать видео RUTUBE');
    if (youtubePlayer?.destroy) { try { youtubePlayer.destroy(); } catch {} youtubePlayer = null; }
    if (rutubeFrame) rutubeFrame.remove();
    rutubeReady = false;
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden'); $('#playerGesture').classList.add('hidden');
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    const frame = document.createElement('iframe'); frame.id = 'rutubePlayer'; frame.title = title; frame.allow = 'autoplay; clipboard-write; fullscreen; picture-in-picture'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = `https://rutube.ru/play/embed/${encodeURIComponent(videoId)}?skinColor=8b48ff&getPlayOptions=title,thumbnail_url&autostartmute=true`;
    wrap.append(frame); rutubeFrame = frame;
    currentVideo = { provider: 'rutube', videoId, title, channelTitle };
    playbackStarted = false;
    $('#videoTitle').textContent = title; $('#videoSource').textContent = `${channelTitle} · RUTUBE`; $('#videoCover').textContent = 'R'; $('#syncLabel').textContent = 'Подключаем RUTUBE…';
    pendingRemotePlayback = initial;
    if (broadcast) await announceVideo('rutube', videoId, title, channelTitle);
    $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function sendRutubeCommand(type, data = {}) {
    if (!rutubeFrame?.contentWindow || !rutubeReady) return;
    rutubeFrame.contentWindow.postMessage(JSON.stringify({ type, data }), 'https://rutube.ru');
  }

  function handleRutubeMessage(event) {
    if (event.origin !== 'https://rutube.ru' || !rutubeFrame || event.source !== rutubeFrame.contentWindow) return;
    let message = event.data;
    if (typeof message === 'string') { try { message = JSON.parse(message); } catch { return; } }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'player:ready') {
      rutubeReady = true; $('#syncLabel').textContent = 'RUTUBE подключён';
      if (pendingRemotePlayback) applyPlaybackState({ ...pendingRemotePlayback, provider: 'rutube', videoId: currentVideo?.videoId });
      if (pendingRemotePlayback?.state !== 'paused') armAutoplayWatchdog();
      pendingRemotePlayback = null;
      return;
    }
    if (message.type === 'player:changeState') {
      if (message.data?.state === 'playing') markPlaybackStarted();
      if (Date.now() < suppressPlaybackBroadcastUntil) return;
      const state = message.data?.state;
      if (state === 'playing' || state === 'paused' || state === 'stopped') broadcastPlayback('rutube', state, lastRutubePosition);
    }
    if (message.type === 'player:currentTime') {
      const nextPosition = Number(message.data?.time) || 0;
      const previousPosition = lastRutubePosition;
      lastRutubePosition = nextPosition;
      if (previousPosition > 0 && Math.abs(nextPosition - previousPosition) > 3 && Date.now() > suppressPlaybackBroadcastUntil) {
        broadcastPlayback('rutube', 'seek', nextPosition);
      }
      if (Date.now() - lastRutubeSyncAt > 5000 && isSyncLeader()) {
        lastRutubeSyncAt = Date.now(); broadcastPlayback('rutube', 'sync', lastRutubePosition);
      }
    }
    if (message.type === 'player:error') showToast(`RUTUBE: ${message.data?.text || message.data?.code || 'ошибка плеера'}`);
  }

  async function broadcastPlayback(kind, state, time) {
    if (!roomChannel || !authUser || Date.now() < suppressPlaybackBroadcastUntil) return;
    const payload = { provider: kind, videoId: currentVideo?.videoId, title: currentVideo?.title, channelTitle: currentVideo?.channelTitle, state, time: Number(time) || 0, sentAt: Date.now() };
    try {
      await roomChannel.send({ type: 'broadcast', event: 'playback', payload: { user_id: authUser.id, ...payload } });
      if (state !== 'sync' || Date.now() - lastPersistAt > 30000) { lastPersistAt = Date.now(); await savePersistedRoomState(payload); }
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
    } else if (payload.provider === 'rutube') {
      if (payload.state === 'playing') sendRutubeCommand('player:play');
      else if (payload.state === 'paused' || payload.state === 'ended') sendRutubeCommand('player:pause');
      if (['sync', 'seek'].includes(payload.state)) sendRutubeCommand('player:setCurrentTime', { time });
    }
  }

  async function broadcastRoomHeartbeat() {
    if (!roomChannel || !currentVideo || !isSyncLeader()) return;
    if (currentVideo.provider === 'youtube' && youtubePlayer?.getPlayerState) {
      const state = youtubePlayer.getPlayerState();
      if (state === window.YT?.PlayerState?.PLAYING) broadcastPlayback('youtube', 'sync', youtubePlayer.getCurrentTime?.() || 0);
    } else if (currentVideo.provider === 'rutube' && rutubeReady) {
      broadcastPlayback('rutube', 'sync', lastRutubePosition);
    }
  }

  function enablePlaybackFromGesture() {
    markPlaybackStarted();
    suppressPlaybackBroadcastUntil = Date.now() + 1000;
    if (currentVideo?.provider === 'youtube') youtubePlayer?.playVideo?.();
    else if (currentVideo?.provider === 'rutube') { sendRutubeCommand('player:unMute'); sendRutubeCommand('player:play'); }
  }

  async function shareRoom(friendName = '') {
    if (!currentRoom || !inviteToken) return showToast('Комната ещё создаётся');
    const url = roomUrl();
    try {
      if (navigator.share) await navigator.share({ title: 'Моя комната SYNC', text: friendName ? `Присоединяйся к просмотру, ${friendName}!` : 'Заходи смотреть вместе!', url });
      else { await navigator.clipboard.writeText(url); showToast(friendName ? `Ссылка для ${friendName} скопирована` : 'Ссылка на комнату скопирована'); }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        try { await navigator.clipboard.writeText(url); showToast('Ссылка на комнату скопирована'); }
        catch { showToast(url); }
      }
    }
  }

  function openModal(id) {
    $(`#${id}`).classList.remove('hidden');
    if (id === 'friendModal') { $('#friendName').focus(); loadIncomingRequests(); }
  }
  function closeModal(id) {
    $(`#${id}`).classList.add('hidden');
    if (id === 'friendModal') $$('.nav-link').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === '#watch'));
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
    $$('.provider-card').forEach((card) => card.addEventListener('click', () => selectProvider(card.dataset.provider)));
    $('#providerSearchForm').addEventListener('submit', (event) => { event.preventDefault(); searchVideos($('#providerSearchInput').value); });
    $('#closeProvider').addEventListener('click', () => $('#providerWorkspace').classList.add('hidden'));
    $('#findFromPlayer').addEventListener('click', () => $('#providers').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    $('#startPlayback').addEventListener('click', enablePlaybackFromGesture);
    window.addEventListener('message', handleRutubeMessage);
    $('#inviteTop').addEventListener('click', () => shareRoom());
    $('#invitePeople').addEventListener('click', () => shareRoom());
    $('#shareRoom').addEventListener('click', () => shareRoom());
    $('#shareRoomSmall').addEventListener('click', () => shareRoom());
    $('#newRoom').addEventListener('click', () => createRoom(true));
    $('#addFriend').addEventListener('click', () => openModal('friendModal'));
    $('#friendsNav').addEventListener('click', () => { $$('.nav-link').forEach((item) => item.classList.toggle('active', item.id === 'friendsNav')); openModal('friendModal'); });
    document.querySelector('.nav-link[href="#watch"]')?.addEventListener('click', () => $$('.nav-link').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === '#watch')));
    $('#friendSearchForm').addEventListener('submit', searchUsers);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach((modal) => closeModal(modal.id)); });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
    $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
    $('#chatForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const message = $('#chatInput').value.trim(); if (!message) return;
      $('#chatInput').value = ''; await sendChatMessage(message);
    });
    $('#fullscreenButton').addEventListener('click', () => {
      const target = $('#playerStage');
      if (document.fullscreenElement) document.exitFullscreen?.();
      else target.requestFullscreen?.().catch(() => showToast('Полный экран недоступен'));
    });
  }

  async function start() {
    bindEvents();
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

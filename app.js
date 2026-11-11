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
  let toastTimer = null;
  let bootstrapping = false;
  const presenceSessionId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

  const initials = (name) => (String(name || '?').trim().replace(/^@/, '').slice(0, 1) || '?').toLocaleUpperCase('ru-RU');
  function setAvatar(node, url, name) {
    if (!node) return;
    node.replaceChildren();
    if (url) {
      const image = document.createElement('img');
      image.className = 'avatar-image'; image.alt = ''; image.loading = 'lazy'; image.src = url;
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
  const cleanUsername = (value) => String(value || '').trim().replace(/^@/, '').toLowerCase();

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
    $('#authUsername').required = signup;
    $('#authDisplayName').required = signup;
    setAuthStatus('');
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    const button = $('#googleSignIn');
    button.disabled = true;
    button.textContent = 'Переходим к Google…';
    try {
      const redirectTo = location.href;
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
        const username = cleanUsername($('#authUsername').value);
        const name = $('#authDisplayName').value.trim();
        if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Ник: 3–20 символов, только латинские буквы, цифры и _.');
        if (name.length < 2) throw new Error('Имя должно быть не короче двух символов.');
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username, display_name: name } }
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
      const detail = error.message || 'Не удалось войти. Попробуй ещё раз.';
      setAuthStatus(detail.includes('sync_profiles_username_key') || detail.includes('duplicate key') ? 'Этот ник уже занят. Придумай другой.' : detail, true);
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
      if (error) throw new Error(`Профиль не найден. Выполни SQL из supabase.sql. (${error.message})`);
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
    $('#profileUsername').value = profile?.username || '';
    $('#profileEmail').textContent = authUser?.email || '';
    $('#avatarPreview').src = profile?.avatar_url || 'icon.svg';
  }

  async function uploadAvatar(file) {
    if (!file || !supabase || !authUser) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return showToast('Выбери JPG, PNG или WebP');
    if (file.size > 5 * 1024 * 1024) return showToast('Фото должно быть меньше 5 МБ');
    const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
    const path = `${authUser.id}/${Date.now()}.${extension}`;
    showToast('Загружаем фото…');
    const { error: uploadError } = await supabase.storage.from('sync-avatars').upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
    if (uploadError) return showToast(`Не удалось загрузить фото: ${uploadError.message}`);
    const { data } = supabase.storage.from('sync-avatars').getPublicUrl(path);
    const avatarUrl = data?.publicUrl;
    const { data: updated, error } = await supabase.from('sync_profiles').update({ avatar_url: avatarUrl }).eq('id', authUser.id).select('id,username,display_name,avatar_url').single();
    if (error) return showToast(`Фото загружено, но профиль не обновился: ${error.message}`);
    profile = updated; updateProfileUI();
    if (roomChannel) await roomChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url });
    if (onlineChannel) await onlineChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url });
    renderMembers(); showToast('Фото профиля обновлено');
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
    $('#friendsList').replaceChildren();
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus('Ты вышел из аккаунта.');
  }

  async function saveProfile(event) {
    event.preventDefault();
    const name = $('#profileDisplayName').value.trim();
    const username = cleanUsername($('#profileUsername').value);
    if (name.length < 2) return showToast('Имя должно быть не короче двух символов');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return showToast('Проверь формат ника');
    const { data, error } = await supabase.from('sync_profiles')
      .update({ display_name: name, username })
      .eq('id', authUser.id)
      .select('id,username,display_name,avatar_url')
      .single();
    if (error) return showToast(error.code === '23505' ? 'Этот ник уже занят' : error.message);
    profile = data;
    updateProfileUI();
    $('#profileModal').classList.add('hidden');
    if (roomChannel) await roomChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url || null });
    if (onlineChannel) await onlineChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url || null });
    renderMembers();
    showToast('Профиль сохранён');
  }

  function setRoomUrl(roomId, token) {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    url.searchParams.set('invite', token);
    history.replaceState({}, '', url);
  }

  async function joinOrCreateRoom() {
    const params = new URLSearchParams(location.search);
    const requestedRoom = params.get('room');
    const requestedToken = params.get('invite');
    if (requestedRoom && requestedToken) {
      const { error } = await supabase.rpc('join_sync_room', {
        p_room_id: requestedRoom,
        p_invite_token: requestedToken
      });
      if (!error) {
        currentRoom = requestedRoom;
        inviteToken = requestedToken;
        $('#syncLabel').textContent = 'Вы в комнате';
        await connectRoom();
        showToast('Ты присоединился к просмотру');
        return;
      }
      showToast('Ссылка недействительна или комната закрыта. Создали новую.');
    }
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
        if (payload?.user_id !== authUser.id) addChatMessage(payload?.name || 'Друг', payload?.message || '');
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
        await roomChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url || null });
        renderMembers();
        $('#syncLabel').textContent = 'Комната синхронизирована';
        loadPersistedRoomState();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        $('#syncLabel').textContent = 'Нет соединения';
      }
    });
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
        await onlineChannel.track({ user_id: authUser.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url || null });
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
      const label = document.createElement('span'); label.textContent = 'Найди друзей по нику';
      empty.append(icon, label); list.append(empty); return;
    }
    friends.forEach((friend) => {
      const row = document.createElement('div'); row.className = 'friend-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, friend.avatar_url, friend.display_name || friend.username);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = friend.display_name || friend.username;
      const handle = document.createElement('span'); handle.className = 'friend-state'; handle.textContent = `@${friend.username}`;
      const dot = document.createElement('span'); dot.className = `friend-online${onlineIds.has(friend.id) ? ' online' : ''}`; dot.title = onlineIds.has(friend.id) ? 'В сети' : 'Не в сети';
      const actions = document.createElement('div'); actions.className = 'friend-actions';
      const invite = document.createElement('button'); invite.className = 'friend-action'; invite.textContent = '↗'; invite.title = 'Пригласить в комнату'; invite.setAttribute('aria-label', `Пригласить ${friend.display_name || friend.username}`);
      invite.addEventListener('click', () => inviteFriend(friend.display_name || friend.username));
      const remove = document.createElement('button'); remove.className = 'friend-action'; remove.textContent = '×'; remove.title = 'Удалить из друзей'; remove.setAttribute('aria-label', `Удалить ${friend.username}`);
      remove.addEventListener('click', () => removeFriend(friend.requestId));
      info.append(name, handle); actions.append(invite, remove); row.append(avatar, info, dot, actions); list.append(row);
    });
  }

  async function removeFriend(requestId) {
    const { error } = await supabase.from('sync_friend_requests').delete().eq('id', requestId);
    if (error) return showToast(error.message);
    await loadFriends(); showToast('Друг удалён');
  }

  async function searchUsers(event) {
    event.preventDefault();
    const query = cleanUsername($('#friendName').value);
    const box = $('#friendSearchResults'); box.replaceChildren();
    if (!/^[a-z0-9_]{3,20}$/.test(query)) {
      box.textContent = 'Ник должен содержать 3–20 латинских букв, цифр или _.';
      box.className = 'modal-list modal-empty'; return;
    }
    box.className = 'modal-list';
    const loading = document.createElement('div'); loading.className = 'modal-empty'; loading.textContent = 'Ищем…'; box.append(loading);
    const { data, error } = await supabase.from('sync_profiles')
      .select('id,username,display_name,avatar_url')
      .ilike('username', `${query}%`)
      .neq('id', authUser.id)
      .limit(8);
    box.replaceChildren();
    if (error) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = error.message; box.append(msg); return; }
    if (!data?.length) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = 'Никого не нашли. Проверь написание.'; box.append(msg); return; }
    data.forEach((person) => {
      const existing = friends.some((friend) => friend.id === person.id);
      const item = document.createElement('div'); item.className = 'modal-user-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; setAvatar(avatar, person.avatar_url, person.display_name);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = person.display_name;
      const username = document.createElement('span'); username.textContent = `@${person.username}`;
      const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'button';
      button.textContent = existing ? 'Уже в друзьях' : 'Добавить'; button.disabled = existing;
      button.addEventListener('click', () => sendFriendRequest(person.username, button));
      info.append(name, username); item.append(avatar, info, button); box.append(item);
    });
  }

  async function sendFriendRequest(username, button) {
    button.disabled = true; button.textContent = 'Отправляем…';
    const { data, error } = await supabase.rpc('send_friend_request', { p_username: username });
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
      const username = document.createElement('span'); username.textContent = `@${user.username || ''}`;
      const accept = document.createElement('button'); accept.className = 'button button-primary'; accept.type = 'button'; accept.textContent = 'Принять';
      accept.addEventListener('click', () => respondRequest(request.id, true));
      const decline = document.createElement('button'); decline.className = 'friend-action'; decline.type = 'button'; decline.textContent = '×'; decline.title = 'Отклонить';
      decline.addEventListener('click', () => respondRequest(request.id, false));
      info.append(name, username); item.append(avatar, info, accept, decline); box.append(item);
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

  function addChatMessage(name, message, mine = false) {
    if (!message) return;
    const welcome = $('#chatMessages .chat-welcome'); if (welcome) welcome.remove();
    const wrap = document.createElement('div'); wrap.className = 'chat-message';
    const avatar = document.createElement('div'); avatar.className = 'person-avatar'; avatar.textContent = initials(name);
    const body = document.createElement('div'); body.className = 'message-body';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const strong = document.createElement('strong'); strong.textContent = mine ? 'Вы' : name;
    const time = document.createElement('span'); time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message;
    meta.append(strong, time); body.append(meta, text); wrap.append(avatar, body); $('#chatMessages').append(wrap);
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  }

  async function sendChatMessage(message) {
    addChatMessage(displayName(), message, true);
    if (roomChannel) await roomChannel.send({ type: 'broadcast', event: 'chat', payload: { user_id: authUser.id, name: displayName(), message } });
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
      message.textContent = config.YOUTUBE_API_KEY
        ? 'Ищи видео здесь. Нажми «Смотреть вместе» — ролик появится у всех в комнате.'
        : 'Для поиска YouTube внутри SYNC нужен API key YouTube Data API. Плеер и синхронизация уже готовы; добавь ключ в config.js.';
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
    const cleaned = query.trim();
    if (!cleaned) { showToast('Напиши название видео'); $('#providerSearchInput').focus(); return; }
    if (provider === 'youtube') {
      if (!config.YOUTUBE_API_KEY) {
        renderSearchNotice('Поиск YouTube пока не включён: добавь YOUTUBE_API_KEY в config.js из Google Cloud Console → YouTube Data API v3.');
        return;
      }
      renderSearchNotice('Ищем видео на YouTube…');
      try {
        const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
        endpoint.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '10', q: cleaned, key: config.YOUTUBE_API_KEY }).toString();
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || 'YouTube API вернул ошибку');
        renderYoutubeResults(data.items || []);
      } catch (error) { renderSearchNotice(`Поиск YouTube не сработал: ${error.message}`); }
      return;
    }
    if (provider === 'rutube') {
      renderSearchNotice('Ищем видео на RUTUBE…');
      try {
        const endpoint = new URL('https://rutube.ru/api/search/video/');
        endpoint.search = new URLSearchParams({ query: cleaned, page: '1', limit: '12' }).toString();
        const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`RUTUBE ответил ${response.status}`);
        const data = await response.json();
        const items = Array.isArray(data) ? data : (data.results || data.data || data.items || []);
        renderRutubeResults(items);
      } catch (error) {
        renderSearchNotice(`RUTUBE не отдал результаты прямо в SYNC (${error.message}). Поиск этой площадки может ограничивать запросы с других сайтов. Встроенный плеер RUTUBE при этом поддерживается.`);
      }
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

  function renderYoutubeResults(items) {
    const clean = (items || []).map((item) => ({
      id: item?.id?.videoId,
      title: item?.snippet?.title,
      author: item?.snippet?.channelTitle,
      thumbnail: item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || ''
    })).filter((item) => item.id);
    renderVideoCards(clean, 'youtube');
  }

  function renderRutubeResults(items) {
    const clean = (items || []).map((item) => ({
      id: String(item?.id || item?.video_id || item?.videoId || ''),
      title: item?.title || item?.name,
      author: item?.author?.name || item?.author || item?.channel?.name || 'RUTUBE',
      thumbnail: item?.thumbnail_url || item?.thumbnail || item?.picture || ''
    })).filter((item) => /^[A-Za-z0-9_-]{8,}$/.test(item.id));
    renderVideoCards(clean, 'rutube');
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
            if (initial.state !== 'paused') event.target.playVideo();
            $('#syncLabel').textContent = 'YouTube подключён';
          },
          onStateChange: (event) => {
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
      if (pendingRemotePlayback) applyPlaybackState({ ...pendingRemotePlayback, provider: 'rutube' });
      pendingRemotePlayback = null;
      return;
    }
    if (message.type === 'player:changeState') {
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
      if (Date.now() - lastRutubeSyncAt > 5000 && roomOwnerId === authUser?.id) {
        lastRutubeSyncAt = Date.now(); broadcastPlayback('rutube', 'sync', lastRutubePosition);
      }
    }
    if (message.type === 'player:error') showToast(`RUTUBE: ${message.data?.text || message.data?.code || 'ошибка плеера'}`);
  }

  async function broadcastPlayback(kind, state, time) {
    if (!roomChannel || !authUser || Date.now() < suppressPlaybackBroadcastUntil) return;
    const payload = { provider: kind, videoId: currentVideo?.videoId, title: currentVideo?.title, channelTitle: currentVideo?.channelTitle, state, time: Number(time) || 0, sentAt: Date.now() };
    await roomChannel.send({ type: 'broadcast', event: 'playback', payload: { user_id: authUser.id, ...payload } });
    await savePersistedRoomState(payload);
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
    if (!roomChannel || !currentVideo || roomOwnerId !== authUser?.id) return;
    if (currentVideo.provider === 'youtube' && youtubePlayer?.getPlayerState) {
      const state = youtubePlayer.getPlayerState();
      if (state === window.YT?.PlayerState?.PLAYING) broadcastPlayback('youtube', 'sync', youtubePlayer.getCurrentTime?.() || 0);
    } else if (currentVideo.provider === 'rutube' && rutubeReady) {
      broadcastPlayback('rutube', 'sync', lastRutubePosition);
    }
  }

  function enablePlaybackFromGesture() {
    $('#playerGesture').classList.add('hidden');
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
  function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

  function bindEvents() {
    $('#authForm').addEventListener('submit', submitAuth);
    $('#googleSignIn').addEventListener('click', signInWithGoogle);
    $('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#avatarInput').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) { $('#avatarPreview').src = URL.createObjectURL(file); uploadAvatar(file); }
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
    $('#heroInvite').addEventListener('click', () => shareRoom());
    $('#invitePeople').addEventListener('click', () => shareRoom());
    $('#shareRoom').addEventListener('click', () => shareRoom());
    $('#shareRoomSmall').addEventListener('click', () => shareRoom());
    $('#newRoom').addEventListener('click', () => createRoom(true));
    $('#addFriend').addEventListener('click', () => openModal('friendModal'));
    $('#friendSearchForm').addEventListener('submit', searchUsers);
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
        authUser = null; profile = null; showAuthGate();
      }
    });
  }

  start().catch((error) => {
    console.error(error);
    showAuthGate();
    setAuthStatus(error.message || 'Не удалось запустить SYNC.', true);
  });
})();

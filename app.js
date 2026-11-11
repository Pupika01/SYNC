(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const config = window.SYNC_CONFIG || {};
  const serviceGroups = [
    {
      title: 'Видеоплатформы',
      services: [
        { id: 'youtube', name: 'YouTube', mark: '▶', brand: 'youtube', note: 'Видео, каналы и шоу', domain: 'youtube.com', home: 'https://www.youtube.com/', search: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
        { id: 'rutube', name: 'RUTUBE', mark: 'R', brand: 'rutube', note: 'Видео и телешоу', domain: 'rutube.ru', home: 'https://rutube.ru/', search: q => `https://rutube.ru/search/?query=${encodeURIComponent(q)}` },
        { id: 'vkvideo', name: 'VK Видео', mark: 'VK', brand: 'vkvideo', note: 'Видео, клипы и трансляции', domain: 'vkvideo.ru', home: 'https://vkvideo.ru/', search: q => `https://vkvideo.ru/?q=${encodeURIComponent(q)}` },
        { id: 'dzen', name: 'Дзен Видео', mark: 'Д', brand: 'dzen', note: 'Видео и авторские каналы', domain: 'dzen.ru', home: 'https://dzen.ru/video', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:dzen.ru/video ${q}`)}` }
      ]
    },
    {
      title: 'Онлайн-кинотеатры',
      services: [
        { id: 'kinopoisk', name: 'Кинопоиск', mark: 'К', brand: 'kinopoisk', note: 'Фильмы, сериалы и подборки', domain: 'kinopoisk.ru', home: 'https://hd.kinopoisk.ru/', search: q => `https://hd.kinopoisk.ru/search?text=${encodeURIComponent(q)}` },
        { id: 'ivi', name: 'Иви', mark: 'ivi', brand: 'ivi', note: 'Фильмы и сериалы', domain: 'ivi.ru', home: 'https://www.ivi.ru/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:ivi.ru ${q}`)}` },
        { id: 'okko', name: 'Okko', mark: 'okko', brand: 'okko', note: 'Кино, сериалы и спорт', domain: 'okko.tv', home: 'https://okko.tv/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:okko.tv ${q}`)}` },
        { id: 'wink', name: 'Wink', mark: 'W', brand: 'wink', note: 'Фильмы, сериалы и ТВ', domain: 'wink.ru', home: 'https://wink.ru/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:wink.ru ${q}`)}` },
        { id: 'start', name: 'START', mark: 'S', brand: 'start', note: 'Сериалы и оригинальные проекты', domain: 'start.ru', home: 'https://start.ru/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:start.ru ${q}`)}` },
        { id: 'premier', name: 'PREMIER', mark: 'P', brand: 'premier', note: 'Шоу, фильмы и сериалы', domain: 'premier.one', home: 'https://premier.one/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:premier.one ${q}`)}` },
        { id: 'kion', name: 'KION', mark: 'K', brand: 'kion', note: 'Кино, сериалы и ТВ', domain: 'kion.ru', home: 'https://kion.ru/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:kion.ru ${q}`)}` },
        { id: 'netflix', name: 'Netflix', mark: 'N', brand: 'netflix', note: 'Фильмы и сериалы', domain: 'netflix.com', home: 'https://www.netflix.com/', search: q => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
        { id: 'appletv', name: 'Apple TV+', mark: 'tv+', brand: 'appletv', note: 'Оригинальные фильмы и сериалы', domain: 'tv.apple.com', home: 'https://tv.apple.com/', search: q => `https://tv.apple.com/search?term=${encodeURIComponent(q)}` },
        { id: 'primevideo', name: 'Prime Video', mark: 'prime', brand: 'primevideo', note: 'Фильмы и сериалы Amazon', domain: 'primevideo.com', home: 'https://www.primevideo.com/', search: q => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(q)}` },
        { id: 'disney', name: 'Disney+', mark: 'D+', brand: 'disney', note: 'Фильмы и сериалы Disney', domain: 'disneyplus.com', home: 'https://www.disneyplus.com/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:disneyplus.com ${q}`)}` },
        { id: 'amediateka', name: 'Амедиатека', mark: 'A', brand: 'amediateka', note: 'Сериалы и кино', domain: 'amediateka.ru', home: 'https://amediateka.ru/', search: q => `https://www.google.com/search?q=${encodeURIComponent(`site:amediateka.ru ${q}`)}` }
      ]
    }
  ];
  let supabase = null;
  let authUser = null;
  let profile = null;
  let authMode = 'signin';
  let lastSearchQuery = '';
  let currentRoom = null;
  let inviteToken = null;
  let roomChannel = null;
  let onlineChannel = null;
  let friends = [];
  let incomingRequests = [];
  let onlineIds = new Set();
  let onlineProfiles = new Map();
  let currentVideo = null;
  let toastTimer = null;
  let bootstrapping = false;
  let profileHasAvatarColumn = true;
  const presenceSessionId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

  const initials = (name) => (String(name || '?').trim().replace(/^@/, '').slice(0, 1) || '?').toLocaleUpperCase('ru-RU');
  const avatarUrl = (person = profile) => person?.avatar_url || person?.avatar || person?.user_metadata?.avatar_url || person?.user_metadata?.picture || (person === profile ? authUser?.user_metadata?.avatar_url || authUser?.user_metadata?.picture : '') || '';

  function paintAvatar(node, name, url = '') {
    if (!node) return;
    node.replaceChildren();
    if (url) {
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { image.remove(); node.textContent = initials(name); }, { once: true });
      node.append(image);
    } else {
      node.textContent = initials(name);
    }
  }

  function presenceProfile() {
    return {
      user_id: authUser.id,
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: avatarUrl()
    };
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
    node.style.color = isError ? '#c24f5d' : '#9c7b47';
  };
  const displayName = () => profile?.display_name || authUser?.email?.split('@')[0] || 'Гость';
  const cleanUsername = (value) => String(value || '').trim().replace(/^@/, '').toLowerCase();

  function isMissingAvatarColumn(error) {
    const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
    return /avatar_url/i.test(message) && /(does not exist|schema cache|could not find|unknown column)/i.test(message);
  }

  // Старые версии базы SYNC могут ещё не содержать avatar_url. Это не должно
  // блокировать вход: повторяем запрос только с базовыми полями профиля.
  async function getProfileById(userId) {
    let result = await supabase.from('sync_profiles')
      .select('id,username,display_name,avatar_url')
      .eq('id', userId)
      .maybeSingle();
    profileHasAvatarColumn = true;
    if (isMissingAvatarColumn(result.error)) {
      profileHasAvatarColumn = false;
      result = await supabase.from('sync_profiles')
        .select('id,username,display_name')
        .eq('id', userId)
        .maybeSingle();
      if (result.data) result.data.avatar_url = null;
    }
    return result;
  }

  async function queryWithOptionalAvatar(queryFactory) {
    let result = await queryFactory(true);
    if (isMissingAvatarColumn(result.error)) result = await queryFactory(false);
    return result;
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
    $('#authSubtitle').textContent = signup ? 'Создай пространство для своих людей и любимых видео.' : 'Твои люди. Ваше кино. Одно общее пространство.';
    $('#authSubmit').textContent = signup ? 'Зарегистрироваться' : 'Войти';
    $('#authSwitchText').textContent = signup ? 'Уже есть аккаунт?' : 'Впервые в SYNC?';
    $('#authSwitch').textContent = signup ? 'Войти' : 'Создать аккаунт';
    $('#authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('#authUsername').required = signup;
    $('#authDisplayName').required = signup;
    setAuthStatus('');
    $('#googleAuth').classList.remove('hidden');
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    const button = $('#googleAuth');
    button.disabled = true;
    button.textContent = 'Переходим к Google…';
    setAuthStatus('');
    try {
      const redirectUrl = new URL(location.href);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUrl.toString(), queryParams: { prompt: 'select_account' } }
      });
      if (error) throw error;
    } catch (error) {
      setAuthStatus(error.message || 'Не удалось открыть вход через Google.', true);
      button.disabled = false;
      button.innerHTML = '<span class="google-mark" aria-hidden="true">G</span> Продолжить с Google';
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
      const { data, error } = await getProfileById(user.id);
      if (error) throw new Error(`Не удалось загрузить профиль SYNC. Проверь, что SQL проекта выполнен. (${error.message})`);
      if (!data) throw new Error('Для этого аккаунта ещё не создан профиль SYNC. Выполни supabase.sql в Supabase → SQL Editor, затем обнови страницу.');
      profile = data;
      const providerAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || '';
      if (profileHasAvatarColumn && !profile.avatar_url && providerAvatar) {
        const avatarUpdate = await supabase.from('sync_profiles')
          .update({ avatar_url: providerAvatar })
          .eq('id', user.id)
          .select('id,username,display_name,avatar_url')
          .maybeSingle();
        if (!avatarUpdate.error && avatarUpdate.data) profile = avatarUpdate.data;
        else if (isMissingAvatarColumn(avatarUpdate.error)) profileHasAvatarColumn = false;
      }
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
    paintAvatar($('#profileButton'), displayName(), avatarUrl());
    paintAvatar($('#profileAvatarPreview'), displayName(), avatarUrl());
    $('#profileDisplayName').value = profile?.display_name || '';
    $('#profileUsername').value = profile?.username || '';
    $('#profileEmail').textContent = authUser?.email || '';
  }

  async function signOut() {
    if (!supabase) return;
    if (roomChannel) await supabase.removeChannel(roomChannel);
    if (onlineChannel) await supabase.removeChannel(onlineChannel);
    roomChannel = null;
    onlineChannel = null;
    onlineIds = new Set();
    onlineProfiles = new Map();
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
      .select('id,username,display_name')
      .single();
    if (error) return showToast(error.code === '23505' ? 'Этот ник уже занят' : error.message);
    profile = { ...data, avatar_url: profile?.avatar_url || null };
    updateProfileUI();
    $('#profileModal').classList.add('hidden');
    if (roomChannel) await roomChannel.track(presenceProfile());
    if (onlineChannel) await onlineChannel.track(presenceProfile());
    renderMembers();
    showToast('Профиль сохранён');
  }

  async function uploadAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      showToast('Подойдёт JPG, PNG или WebP');
      event.target.value = '';
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      showToast('Фото должно весить не больше 3 МБ');
      event.target.value = '';
      return;
    }
    if (!profileHasAvatarColumn) {
      showToast('Чтобы включить фото профиля, один раз выполни supabase.sql в Supabase → SQL Editor.');
      event.target.value = '';
      return;
    }

    const uploadButton = $('#chooseAvatar');
    uploadButton.disabled = true;
    uploadButton.textContent = 'Загружаем…';
    try {
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
      const objectPath = `${authUser.id}/${globalThis.crypto?.randomUUID?.() || Date.now()}.${extension}`;
      const storage = supabase.storage.from('sync-avatars');
      const { error: uploadError } = await storage.upload(objectPath, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false
      });
      if (uploadError) throw uploadError;
      const { data: publicData } = storage.getPublicUrl(objectPath);
      const { data, error } = await supabase.from('sync_profiles')
        .update({ avatar_url: publicData.publicUrl })
        .eq('id', authUser.id)
        .select('id,username,display_name,avatar_url')
        .single();
      if (error) throw error;
      const previousUrl = profile?.avatar_url || '';
      profile = data;
      updateProfileUI();
      if (roomChannel) await roomChannel.track(presenceProfile());
      if (onlineChannel) await onlineChannel.track(presenceProfile());
      renderMembers();
      renderFriends();
      const storagePrefix = '/storage/v1/object/public/sync-avatars/';
      const oldPathStart = previousUrl.indexOf(storagePrefix);
      if (oldPathStart >= 0) {
        const oldPath = decodeURIComponent(previousUrl.slice(oldPathStart + storagePrefix.length).split('?')[0]);
        if (oldPath && oldPath !== objectPath) await storage.remove([oldPath]);
      }
      showToast('Фото профиля обновлено');
    } catch (error) {
      const message = error.message || 'Не удалось загрузить фото';
      showToast(message.includes('Bucket not found') || message.includes('sync-avatars')
        ? 'Выполни обновлённый supabase.sql — он создаст хранилище фото.'
        : message);
    } finally {
      uploadButton.disabled = false;
      uploadButton.textContent = 'Загрузить фото';
      event.target.value = '';
    }
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
        if (payload?.user_id !== authUser.id) addChatMessage(payload?.name || 'Друг', payload?.message || '', false, payload?.avatar_url || '');
      })
      .on('broadcast', { event: 'video' }, ({ payload }) => {
        if (payload?.user_id !== authUser.id && payload?.videoId) {
          playYoutube(payload.videoId, payload.title || 'Видео YouTube', payload.channelTitle || 'YouTube', false);
          showToast('Друг выбрал видео');
        }
      });
    roomChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await roomChannel.track(presenceProfile());
        renderMembers();
        $('#syncLabel').textContent = 'Комната синхронизирована';
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
      participants.unshift({ user_id: authUser.id, display_name: displayName(), avatar_url: avatarUrl() });
    }
    const unique = [...new Map(participants.map((person) => [person.user_id, person])).values()];
    unique.forEach((person) => {
      const mine = person.user_id === authUser?.id;
      const row = document.createElement('div'); row.className = 'person-row';
      const avatar = document.createElement('div'); avatar.className = `person-avatar${mine ? ' self-avatar' : ''}`; paintAvatar(avatar, person.display_name, person.avatar_url || (mine ? avatarUrl() : ''));
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
      const peers = Object.values(state).flat().filter((item) => item?.user_id);
      onlineIds = new Set(peers.map((item) => item.user_id));
      onlineProfiles = new Map(peers.map((item) => [item.user_id, item]));
      renderFriends();
    });
    onlineChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await onlineChannel.track(presenceProfile());
        const state = onlineChannel.presenceState();
        const peers = Object.values(state).flat().filter((item) => item?.user_id);
        onlineIds = new Set(peers.map((item) => item.user_id));
        onlineProfiles = new Map(peers.map((item) => [item.user_id, item]));
        renderFriends();
      }
    });
  }

  async function loadFriends() {
    const { data, error } = await queryWithOptionalAvatar((withAvatar) => supabase.from('sync_friend_requests')
      .select(`id,from_user,to_user,from_profile:sync_profiles!sync_friend_requests_from_user_fkey(id,username,display_name${withAvatar ? ',avatar_url' : ''}),to_profile:sync_profiles!sync_friend_requests_to_user_fkey(id,username,display_name${withAvatar ? ',avatar_url' : ''})`)
      .eq('status', 'accepted')
      .or(`from_user.eq.${authUser.id},to_user.eq.${authUser.id}`));
    if (error) { showToast(`Не загрузились друзья: ${error.message}`); return; }
    friends = (data || []).map((row) => ({
      requestId: row.id,
      id: row.from_user === authUser.id ? row.to_user : row.from_user,
      ...(row.from_user === authUser.id ? row.to_profile : row.from_profile)
    }));
    renderFriends();
  }

  async function loadIncomingRequests() {
    const { data, error } = await queryWithOptionalAvatar((withAvatar) => supabase.from('sync_friend_requests')
      .select(`id,from_user,from_profile:sync_profiles!sync_friend_requests_from_user_fkey(id,username,display_name${withAvatar ? ',avatar_url' : ''})`)
      .eq('to_user', authUser.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }));
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
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; paintAvatar(avatar, friend.display_name || friend.username, onlineProfiles.get(friend.id)?.avatar_url || friend.avatar_url);
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
    const { data, error } = await queryWithOptionalAvatar((withAvatar) => supabase.from('sync_profiles')
      .select(`id,username,display_name${withAvatar ? ',avatar_url' : ''}`)
      .ilike('username', `${query}%`)
      .neq('id', authUser.id)
      .limit(8));
    box.replaceChildren();
    if (error) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = error.message; box.append(msg); return; }
    if (!data?.length) { const msg = document.createElement('div'); msg.className = 'modal-empty'; msg.textContent = 'Никого не нашли. Проверь написание.'; box.append(msg); return; }
    data.forEach((person) => {
      const existing = friends.some((friend) => friend.id === person.id);
      const item = document.createElement('div'); item.className = 'modal-user-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; paintAvatar(avatar, person.display_name, person.avatar_url);
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
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; paintAvatar(avatar, user.display_name || user.username, user.avatar_url);
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

  function addChatMessage(name, message, mine = false, imageUrl = '') {
    if (!message) return;
    const welcome = $('#chatMessages .chat-welcome'); if (welcome) welcome.remove();
    const wrap = document.createElement('div'); wrap.className = 'chat-message';
    const avatar = document.createElement('div'); avatar.className = 'person-avatar'; paintAvatar(avatar, name, imageUrl || (mine ? avatarUrl() : ''));
    const body = document.createElement('div'); body.className = 'message-body';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const strong = document.createElement('strong'); strong.textContent = mine ? 'Вы' : name;
    const time = document.createElement('span'); time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message;
    meta.append(strong, time); body.append(meta, text); wrap.append(avatar, body); $('#chatMessages').append(wrap);
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  }

  async function sendChatMessage(message) {
    addChatMessage(displayName(), message, true, avatarUrl());
    if (roomChannel) await roomChannel.send({ type: 'broadcast', event: 'chat', payload: { user_id: authUser.id, name: displayName(), message, avatar_url: avatarUrl() } });
  }

  function makeServiceCard(service, query, order = 0) {
    const card = document.createElement('a');
    card.className = `service-card service-${service.brand}`;
    card.href = query ? service.search(query) : service.home;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', `Искать «${query}» на ${service.name}`);
    card.style.setProperty('--fly-delay', `${Math.min(order, 30) * 55}ms`);

    const mark = document.createElement('span');
    mark.className = `service-mark mark-${service.brand}`;
    mark.setAttribute('aria-hidden', 'true');

    // Настоящий favicon сервиса, а не текстовая буква-заглушка.
    const logo = document.createElement('img');
    logo.className = 'service-logo';
    logo.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(service.domain)}&sz=128`;
    logo.alt = '';
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.referrerPolicy = 'no-referrer';
    logo.addEventListener('error', () => {
      logo.remove();
      mark.textContent = service.mark;
      mark.classList.add('service-mark-fallback');
    }, { once: true });
    mark.append(logo);

    const copy = document.createElement('span');
    copy.className = 'service-copy';
    const title = document.createElement('strong');
    title.textContent = service.name;
    const note = document.createElement('span');
    note.textContent = service.note;
    copy.append(title, note);

    const action = document.createElement('span');
    action.className = 'service-action';
    action.textContent = 'Открыть ↗';
    card.append(mark, copy, action);
    return card;
  }

  function renderServiceDirectory(query = '') {
    const directory = $('#providerDirectory');
    if (!directory) return;
    directory.replaceChildren();
    const normalizedQuery = String(query || '').trim();
    const head = $('#directoryHead');
    const footnote = $('#directoryFootnote');
    $('#directoryTitle').textContent = 'Выбери, где смотреть';
    $('#directoryNote').textContent = normalizedQuery;

    let order = 0;
    serviceGroups.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'service-group';
      const heading = document.createElement('h4');
      heading.textContent = group.title;
      const grid = document.createElement('div');
      grid.className = 'service-grid';
      group.services.forEach((service) => grid.append(makeServiceCard(service, normalizedQuery, order++)));
      section.append(heading, grid);
      directory.append(section);
    });

    head.hidden = false;
    footnote.hidden = false;
    directory.hidden = false;
    directory.classList.remove('is-visible');
    // Перезапускаем анимацию появления иконок при каждом новом поиске.
    requestAnimationFrame(() => requestAnimationFrame(() => directory.classList.add('is-visible')));
  }

  function extractYoutubeVideoId(value) {
    const raw = String(value || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
    try {
      const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(normalized);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
      if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
        const fromQuery = url.searchParams.get('v');
        if (fromQuery) return fromQuery;
        return url.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/)?.[1] || '';
      }
    } catch (_) {}
    return '';
  }

  async function searchVideos(query) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) { $('#searchInput').focus(); return; }
    const pastedVideoId = extractYoutubeVideoId(rawQuery);
    if (pastedVideoId) {
      await playYoutube(pastedVideoId, 'Видео YouTube', 'YouTube', true);
      return;
    }
    lastSearchQuery = rawQuery;
    renderServiceDirectory(lastSearchQuery);
    $('#discover').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Keep the existing embedded YouTube results when the owner has configured an API key.
    if (config.YOUTUBE_API_KEY) {
      $('#searchResults').classList.remove('hidden');
      $('#searchResults').replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'search-empty';
      loading.textContent = 'Ищем видео на YouTube…';
      $('#searchResults').append(loading);
      try {
        const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
        endpoint.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', q: lastSearchQuery, key: config.YOUTUBE_API_KEY }).toString();
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || 'Не удалось выполнить поиск');
        renderYoutubeResults(data.items || []);
      } catch (error) {
        $('#searchResults').classList.add('hidden');
        console.warn('SYNC YouTube search unavailable:', error);
      }
    } else {
      $('#searchResults').classList.add('hidden');
    }
  }

  function renderYoutubeResults(items) {
    const box = $('#searchResults'); box.replaceChildren(); box.classList.remove('hidden');
    const head = document.createElement('div'); head.className = 'results-head'; const title = document.createElement('strong'); title.textContent = `Результаты · ${items.length}`; head.append(title); box.append(head);
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'search-empty'; empty.textContent = 'Ничего не найдено. Попробуй другое название.'; box.append(empty); return; }
    const grid = document.createElement('div'); grid.className = 'results-grid';
    items.forEach((item) => {
      const videoId = item?.id?.videoId; const snippet = item?.snippet || {}; if (!videoId) return;
      const card = document.createElement('article'); card.className = 'result-card';
      const thumb = document.createElement('img'); thumb.className = 'result-thumb'; thumb.loading = 'lazy'; thumb.alt = ''; thumb.src = snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '';
      const copy = document.createElement('div'); copy.className = 'result-copy';
      const name = document.createElement('strong'); name.textContent = snippet.title || 'Видео YouTube';
      const channelName = document.createElement('span'); channelName.textContent = snippet.channelTitle || 'YouTube';
      const play = document.createElement('button'); play.className = 'result-play'; play.type = 'button'; play.textContent = 'Смотреть вместе';
      play.addEventListener('click', () => playYoutube(videoId, snippet.title || 'YouTube-видео', snippet.channelTitle || 'YouTube', true));
      copy.append(name, channelName, play); card.append(thumb, copy); grid.append(card);
    });
    box.append(grid);
  }

  async function playYoutube(videoId, title, channelTitle, broadcast = true) {
    if (!/^[\w-]{6,}$/.test(videoId)) { showToast('Не удалось открыть это видео'); return; }
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden');
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=0&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    frame.title = title; frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    wrap.append(frame); currentVideo = { videoId, title, channelTitle };
    $('#videoTitle').textContent = title; $('#videoSource').textContent = `${channelTitle} · YouTube`; $('#videoCover').textContent = '▶'; $('#syncLabel').textContent = 'Видео выбрано';
    if (broadcast && roomChannel) await roomChannel.send({ type: 'broadcast', event: 'video', payload: { user_id: authUser.id, videoId, title, channelTitle } });
    $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  function applyTheme(theme, persist = true) {
    const isDark = theme === 'dark';
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    const toggle = $('#themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(isDark));
      toggle.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
      toggle.title = isDark ? 'Светлая тема' : 'Тёмная тема';
    }
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = isDark ? '#151619' : '#ffffff';
    if (persist) {
      try { localStorage.setItem('sync-theme', isDark ? 'dark' : 'light'); } catch (_) {}
    }
  }

  function bindEvents() {
    const savedTheme = (() => { try { return localStorage.getItem('sync-theme'); } catch (_) { return null; } })();
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light', false);
    $('#themeToggle').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    $('#authForm').addEventListener('submit', submitAuth);
    $('#googleAuth').addEventListener('click', signInWithGoogle);
    $('#chooseAvatar').addEventListener('click', () => $('#avatarFileInput').click());
    $('#avatarUploadButton').addEventListener('click', () => $('#avatarFileInput').click());
    $('#avatarFileInput').addEventListener('change', uploadAvatar);
    $('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#logoutButton').addEventListener('click', signOut);
    $('#profileButton').addEventListener('click', () => { updateProfileUI(); openModal('profileModal'); });
    $('#searchForm').addEventListener('submit', (event) => { event.preventDefault(); searchVideos($('#searchInput').value); });
    $('#findFromPlayer').addEventListener('click', () => { $('#discover').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#searchInput').focus({ preventScroll: true }); });
    $('#inviteTop').addEventListener('click', () => shareRoom());
    $('#invitePeople').addEventListener('click', () => shareRoom());
    $('#shareRoom').addEventListener('click', () => shareRoom());
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
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('SYNC offline cache unavailable:', error));
    }
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

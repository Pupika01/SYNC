(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const providers = {
    youtube: { name: 'YouTube', title: 'Подключить YouTube', description: 'Вставьте ссылку на ролик или трансляцию', placeholder: 'https://www.youtube.com/watch?v=...', hint: 'YouTube открывается во встроенном официальном плеере.' },
    rutube: { name: 'Rutube', title: 'Подключить Rutube', description: 'Вставьте ссылку на видео Rutube', placeholder: 'https://rutube.ru/video/...', hint: 'Для публичных видео Rutube попробуем открыть официальный встроенный плеер.' },
    vk: { name: 'VK Видео', title: 'Подключить VK Видео', description: 'Вставьте ссылку на видео VK', placeholder: 'https://vkvideo.ru/video...', hint: 'Пока откроем VK Видео отдельно: доступность встраивания зависит от настроек ролика.' },
    netflix: { name: 'Netflix', title: 'Открыть Netflix', description: 'Вставьте ссылку на фильм или сериал', placeholder: 'https://www.netflix.com/watch/...', hint: 'Netflix использует защищённый плеер. Видео откроется на официальном сайте, не внутри SYNC.' },
    kinopoisk: { name: 'Кинопоиск', title: 'Открыть Кинопоиск', description: 'Вставьте ссылку на фильм или сериал', placeholder: 'https://www.kinopoisk.ru/film/...', hint: 'Кинопоиск использует защищённый плеер. Видео откроется на официальном сайте, не внутри SYNC.' },
    other: { name: 'видео', title: 'Подключить видео', description: 'Вставьте прямую ссылку на страницу видео', placeholder: 'https://...', hint: 'Сторонние сервисы могут запрещать встраивание. Если плеер недоступен, откроем сайт отдельно.' }
  };

  let provider = 'youtube';
  let room = new URLSearchParams(location.search).get('room') || randomRoom();
  let toastTimer;
  let channel;
  let userName = 'Вы';
  const members = new Map([['self', { name: userName, avatar: 'Г', role: 'Организатор' }]]);

  function randomRoom() { return `SYNC-${Math.floor(1000 + Math.random() * 9000)}`; }
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
  function setRoom(nextRoom) {
    room = nextRoom.toUpperCase().replace(/\s/g, '');
    $('#roomCode').textContent = room;
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState({}, '', url);
    connectLocalRoom();
    $('#roomStatus').textContent = 'Вы — участник комнаты';
    showToast(`Комната ${room} готова`);
  }
  function connectLocalRoom() {
    if (channel) channel.close();
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(`sync-${room}`);
      channel.onmessage = (event) => handleRoomEvent(event.data, false);
    }
  }
  function sendRoomEvent(data) {
    if (channel) channel.postMessage(data);
  }
  function addChatMessage(name, message, mine = false) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-message';
    const avatar = document.createElement('div');
    avatar.className = 'person-avatar';
    avatar.textContent = (name || '?').slice(0, 1).toUpperCase();
    const body = document.createElement('div'); body.className = 'message-body';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const strong = document.createElement('strong'); strong.textContent = name;
    const time = document.createElement('span'); time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message;
    meta.append(strong, time); body.append(meta, text); wrap.append(avatar, body);
    $('#chatMessages').append(wrap);
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  }
  function handleRoomEvent(data, announce = true) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'chat' && typeof data.message === 'string') addChatMessage(data.name || 'Участник', data.message);
    if (data.type === 'video' && typeof data.title === 'string') {
      $('#videoTitle').textContent = data.title;
      $('#videoSource').textContent = `${data.provider || 'Видео'} · подключено участником`;
      $('#syncLabel').textContent = 'Ссылка получена';
      if (announce) showToast('Участник выбрал видео');
    }
    if (data.type === 'hello' && data.name) {
      members.set(data.id || data.name, { name: data.name, avatar: data.name.slice(0, 1).toUpperCase(), role: 'Участник' });
      renderMembers();
    }
  }
  function renderMembers() {
    $('#peopleCount').textContent = `${members.size} / 8`;
    const list = $('#peopleList'); list.replaceChildren();
    members.forEach((member, id) => {
      const row = document.createElement('div'); row.className = 'person';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; avatar.textContent = member.avatar;
      const name = document.createElement('div'); name.className = 'person-name';
      const strong = document.createElement('strong'); strong.textContent = member.name;
      const small = document.createElement('span'); small.textContent = member.role;
      name.append(strong, small); row.append(avatar, name);
      const state = document.createElement('span'); state.className = 'mic-status'; state.textContent = id === 'self' ? '♬' : '•'; row.append(state); list.append(row);
    });
  }
  function selectProvider(name) {
    provider = providers[name] ? name : 'other';
    $$('.platform-tile').forEach((tile) => tile.classList.toggle('selected', tile.dataset.provider === provider));
    const config = providers[provider];
    $('#linkTitle').textContent = config.title;
    $('#linkDescription').textContent = config.description;
    $('#videoUrl').placeholder = config.placeholder;
    $('#formHint').textContent = config.hint;
  }
  function getEmbed(url, selected) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (selected === 'youtube' || host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
        let id = parsed.searchParams.get('v');
        if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0];
        const match = parsed.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/);
        if (!id && match) id = match[1];
        if (id && /^[\w-]{6,}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&rel=0`, title: 'YouTube-видео', provider: 'YouTube' };
      }
      if (selected === 'rutube' || host === 'rutube.ru' || host.endsWith('.rutube.ru')) {
        const match = parsed.pathname.match(/\/(?:video|shorts)\/([a-f0-9]{20,})/i);
        if (match) return { src: `https://rutube.ru/play/embed/${match[1]}`, title: 'Rutube-видео', provider: 'Rutube' };
      }
      return null;
    } catch { return null; }
  }
  function connectVideo(url) {
    const trimmed = url.trim();
    if (!trimmed) { showToast('Сначала вставьте ссылку'); return; }
    let parsed;
    try { parsed = new URL(trimmed); } catch { showToast('Проверьте ссылку'); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { showToast('Поддерживаются только http и https ссылки'); return; }
    const embed = getEmbed(trimmed, provider);
    if (embed) {
      $('#stagePlaceholder').classList.add('hidden');
      $('#embedWrap').classList.remove('hidden');
      $('#embedWrap').replaceChildren();
      const frame = document.createElement('iframe');
      frame.src = embed.src;
      frame.title = embed.title;
      frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      $('#embedWrap').append(frame);
      $('#stageNotice').textContent = 'Официальный встроенный плеер · управление воспроизведением пока не синхронизируется';
      $('#videoTitle').textContent = embed.title;
      $('#videoSource').textContent = `${embed.provider} · встроенный плеер`;
      $('#syncLabel').textContent = 'Видео подключено';
      $('#playerHeading').textContent = `${embed.provider.toUpperCase()} PLAYER`;
      sendRoomEvent({ type: 'video', title: embed.title, provider: embed.provider });
    } else {
      $('#stagePlaceholder').classList.remove('hidden');
      $('#embedWrap').classList.add('hidden');
      $('#stageNotice').textContent = 'Этот сервис открывается отдельно; не закрывайте вкладку комнаты';
      $('#videoTitle').textContent = providers[provider].name === 'видео' ? 'Внешнее видео' : providers[provider].name;
      $('#videoSource').textContent = 'Открывается на официальном сайте';
      $('#syncLabel').textContent = 'Внешний просмотр';
      $('#playerHeading').textContent = 'EXTERNAL PLAYER';
      sendRoomEvent({ type: 'video', title: $('#videoTitle').textContent, provider: providers[provider].name });
      window.open(trimmed, '_blank', 'noopener,noreferrer');
      showToast('Открыли официальный сайт в новой вкладке');
    }
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); showToast('Скопировано!'); }
    catch { showToast(`Код комнаты: ${text}`); }
  }
  function openJoinModal() { $('#roomModal').classList.remove('hidden'); $('#joinCode').focus(); }
  function closeJoinModal() { $('#roomModal').classList.add('hidden'); }

  $$('.platform-tile').forEach(tile => tile.addEventListener('click', () => selectProvider(tile.dataset.provider)));
  $('#videoForm').addEventListener('submit', (event) => { event.preventDefault(); connectVideo($('#videoUrl').value); });
  $('#chooseVideo').addEventListener('click', () => { $('#linkPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#videoUrl').focus(); });
  $('#copyRoom').addEventListener('click', () => copyText(room));
  $('#shareButton').addEventListener('click', () => copyText(`${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`));
  $('#inviteWide').addEventListener('click', () => copyText(`${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`));
  $('#changeRoom').addEventListener('click', openJoinModal);
  $('#closeModal').addEventListener('click', closeJoinModal);
  $('#roomModal').addEventListener('click', (event) => { if (event.target === $('#roomModal')) closeJoinModal(); });
  $('#joinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('#joinCode').value.trim();
    if (!/^SYNC-[A-Z0-9]{3,8}$/i.test(code)) { showToast('Код должен выглядеть как SYNC-4821'); return; }
    setRoom(code); closeJoinModal();
  });
  $('#createNewRoom').addEventListener('click', () => { setRoom(randomRoom()); closeJoinModal(); $('#roomStatus').textContent = 'Вы — организатор'; });
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = $('#chatInput').value.trim();
    if (!message) return;
    addChatMessage(userName, message, true);
    sendRoomEvent({ type: 'chat', name: userName, message });
    $('#chatInput').value = '';
  });
  $('#fullscreenButton').addEventListener('click', () => {
    const target = $('#playerStage');
    if (document.fullscreenElement) document.exitFullscreen?.();
    else target.requestFullscreen?.().catch(() => showToast('Полноэкранный режим недоступен'));
  });
  $('#profileButton').addEventListener('click', () => {
    const next = prompt('Как тебя называть в комнате?', userName);
    if (next && next.trim()) { userName = next.trim().slice(0, 24); $('#profileButton').textContent = userName.slice(0, 1).toUpperCase(); members.set('self', { name: userName, avatar: userName.slice(0, 1).toUpperCase(), role: 'Организатор' }); renderMembers(); sendRoomEvent({ type: 'hello', id: 'guest-' + userName, name: userName }); }
  });
  $('#roomMenu').addEventListener('click', () => showToast('Настройки комнаты появятся в следующей версии'));

  $('#roomCode').textContent = room;
  if (new URLSearchParams(location.search).get('room')) $('#roomStatus').textContent = 'Вы вошли по приглашению';
  connectLocalRoom();
  sendRoomEvent({ type: 'hello', id: 'guest-local-' + Math.random().toString(36).slice(2), name: userName });
  selectProvider('youtube');
})();

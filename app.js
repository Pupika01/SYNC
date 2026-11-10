(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const config = window.SYNC_CONFIG || {};

  const providers = {
    youtube: { name: 'YouTube', url: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
    rutube: { name: 'Rutube', url: (q) => `https://rutube.ru/search/?query=${encodeURIComponent(q)}` },
    vk: { name: 'VK Видео', url: (q) => `https://vkvideo.ru/?q=${encodeURIComponent(q)}` },
    netflix: { name: 'Netflix', url: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
    kinopoisk: { name: 'Кинопоиск', url: (q) => `https://hd.kinopoisk.ru/search?text=${encodeURIComponent(q)}` }
  };

  let provider = 'youtube';
  let room = new URLSearchParams(location.search).get('room') || randomRoom();
  let toastTimer = null;
  let channel = null;
  let userName = localStorage.getItem('sync-user-name') || 'Гость';
  let currentVideo = null;
  const sessionId = getSessionId();
  const members = new Map([[sessionId, { name: userName, role: 'Организатор' }]]);
  let friends = loadFriends();

  function randomRoom() {
    const token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    return `watch-${token.replace(/-/g, '').slice(0, 10)}`;
  }
  function getSessionId() {
    let id = sessionStorage.getItem('sync-session-id');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      sessionStorage.setItem('sync-session-id', id);
    }
    return id;
  }
  function loadFriends() {
    try {
      const value = JSON.parse(localStorage.getItem('sync-friends') || '[]');
      return Array.isArray(value) ? value.filter((item) => typeof item?.name === 'string').slice(0, 40) : [];
    } catch { return []; }
  }
  function saveFriends() { localStorage.setItem('sync-friends', JSON.stringify(friends)); }
  function initials(name) { return (name.trim().replace(/^@/, '').slice(0, 1) || '?').toLocaleUpperCase('ru-RU'); }
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }
  function roomUrl() {
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    return url.toString();
  }
  function setRoom(nextRoom, joined = false) {
    room = nextRoom;
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState({}, '', url);
    connectRoom();
    members.clear();
    members.set(sessionId, { name: userName, role: joined ? 'Участник' : 'Организатор' });
    renderMembers();
    $('#syncLabel').textContent = joined ? 'Вы в комнате' : 'Новая комната';
    sendRoomEvent({ type: 'hello', id: sessionId, name: userName });
    showToast(joined ? 'Вы вошли в комнату' : 'Новая комната создана');
  }
  function connectRoom() {
    if (channel) channel.close();
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(`sync-${room}`);
      channel.onmessage = (event) => handleRoomEvent(event.data);
    }
  }
  function sendRoomEvent(data) {
    if (channel) channel.postMessage(data);
  }
  function handleRoomEvent(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'chat' && typeof data.message === 'string') addChatMessage(data.name || 'Друг', data.message);
    if (data.type === 'hello' && data.id && data.id !== sessionId && typeof data.name === 'string') {
      members.set(data.id, { name: data.name, role: 'Участник' });
      renderMembers();
    }
    if (data.type === 'bye' && data.id && data.id !== sessionId) {
      members.delete(data.id);
      renderMembers();
    }
    if (data.type === 'video' && data.videoId && typeof data.title === 'string') {
      playYoutube(data.videoId, data.title, data.channelTitle || 'YouTube', false);
      showToast('Друг выбрал видео');
    }
  }
  function renderMembers() {
    const list = $('#peopleList');
    list.replaceChildren();
    members.forEach((member, id) => {
      const row = document.createElement('div'); row.className = 'person-row';
      const avatar = document.createElement('div'); avatar.className = `person-avatar${id === sessionId ? ' self-avatar' : ''}`; avatar.textContent = initials(member.name);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = id === sessionId ? 'Вы' : member.name;
      const role = document.createElement('span'); role.textContent = member.role;
      const presence = document.createElement('span'); presence.className = 'person-presence';
      info.append(name, role); row.append(avatar, info, presence); list.append(row);
    });
    const count = members.size;
    $('#peopleCount').textContent = `${count} ${count === 1 ? 'участник' : count < 5 ? 'участника' : 'участников'}`;
  }
  function renderFriends() {
    const list = $('#friendsList'); list.replaceChildren();
    if (!friends.length) {
      const empty = document.createElement('div'); empty.className = 'empty-friends';
      const icon = document.createElement('span'); icon.className = 'empty-friends-icon'; icon.textContent = '✳';
      const text = document.createElement('span'); text.textContent = 'Пока здесь тихо';
      empty.append(icon, text); list.append(empty); return;
    }
    friends.forEach((friend, index) => {
      const row = document.createElement('div'); row.className = 'friend-row';
      const avatar = document.createElement('div'); avatar.className = 'person-avatar'; avatar.textContent = initials(friend.name);
      const info = document.createElement('div'); info.className = 'person-info';
      const name = document.createElement('strong'); name.textContent = friend.name;
      const state = document.createElement('span'); state.textContent = 'В вашем круге';
      const actions = document.createElement('div'); actions.className = 'friend-actions';
      const invite = document.createElement('button'); invite.className = 'friend-action'; invite.textContent = '↗'; invite.title = 'Пригласить в комнату'; invite.setAttribute('aria-label', `Пригласить ${friend.name}`);
      invite.addEventListener('click', () => inviteFriend(friend.name));
      const remove = document.createElement('button'); remove.className = 'friend-action'; remove.textContent = '×'; remove.title = 'Удалить друга'; remove.setAttribute('aria-label', `Удалить ${friend.name}`);
      remove.addEventListener('click', () => { friends.splice(index, 1); saveFriends(); renderFriends(); showToast('Друг удалён'); });
      info.append(name, state); actions.append(invite, remove); row.append(avatar, info, actions); list.append(row);
    });
  }
  function addChatMessage(name, message, mine = false) {
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
  function selectProvider(name) {
    provider = providers[name] ? name : 'youtube';
    $$('.provider-chip').forEach((chip) => chip.classList.toggle('selected', chip.dataset.provider === provider));
    $('#searchHint').textContent = provider === 'youtube' && config.YOUTUBE_API_KEY ? 'Поиск внутри SYNC' : `Поиск на ${providers[provider].name}`;
  }
  function showSearchMessage(html, count = '') {
    const box = $('#searchResults'); box.classList.remove('hidden'); box.replaceChildren();
    const head = document.createElement('div'); head.className = 'results-head';
    const title = document.createElement('strong'); title.textContent = count || `Поиск · ${providers[provider].name}`;
    head.append(title); box.append(head);
    const content = document.createElement('div'); content.className = 'search-empty'; content.innerHTML = html; box.append(content);
  }
  function openSearchResultPage(query) {
    const providerInfo = providers[provider];
    const url = providerInfo.url(query);
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `Открыть результаты на ${providerInfo.name} ↗`;
    const wrapper = document.createElement('span');
    wrapper.append(document.createTextNode(`В каталоге ${providerInfo.name} выбери фильм или видео. `), link);
    showSearchMessage('');
    const content = $('#searchResults .search-empty'); content.replaceChildren(wrapper);
    $('#searchHint').textContent = provider === 'youtube' && !config.YOUTUBE_API_KEY ? 'Для поиска внутри SYNC нужен API-ключ' : 'Официальный каталог';
  }
  async function searchVideos(query) {
    if (!query.trim()) { showToast('Напиши название'); $('#searchInput').focus(); return; }
    if (provider !== 'youtube' || !config.YOUTUBE_API_KEY) {
      openSearchResultPage(query.trim());
      return;
    }
    $('#searchResults').classList.remove('hidden');
    $('#searchResults').replaceChildren();
    const loading = document.createElement('div'); loading.className = 'search-empty'; loading.textContent = 'Ищем видео…'; $('#searchResults').append(loading);
    try {
      const endpoint = new URL('https://www.googleapis.com/youtube/v3/search');
      endpoint.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', q: query.trim(), key: config.YOUTUBE_API_KEY }).toString();
      const response = await fetch(endpoint);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || 'Не удалось выполнить поиск');
      renderYoutubeResults(data.items || []);
    } catch (error) {
      showSearchMessage(`Поиск не сработал. Проверь API-ключ YouTube в config.js. <a href="${providers.youtube.url(query.trim())}" target="_blank" rel="noopener noreferrer">Открыть поиск на YouTube ↗</a>`);
    }
  }
  function renderYoutubeResults(items) {
    const box = $('#searchResults'); box.replaceChildren(); box.classList.remove('hidden');
    const head = document.createElement('div'); head.className = 'results-head';
    const title = document.createElement('strong'); title.textContent = `Результаты · ${items.length}`; head.append(title); box.append(head);
    if (!items.length) {
      const empty = document.createElement('div'); empty.className = 'search-empty'; empty.textContent = 'Ничего не найдено. Попробуй другое название.'; box.append(empty); return;
    }
    const grid = document.createElement('div'); grid.className = 'results-grid';
    items.forEach((item) => {
      const videoId = item?.id?.videoId;
      const snippet = item?.snippet || {};
      if (!videoId) return;
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
  function playYoutube(videoId, title, channelTitle, broadcast = true) {
    if (!/^[\w-]{6,}$/.test(videoId)) { showToast('Не удалось открыть это видео'); return; }
    $('#stagePlaceholder').classList.add('hidden'); $('#playerError').classList.add('hidden');
    const wrap = $('#embedWrap'); wrap.classList.remove('hidden'); wrap.replaceChildren();
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=0&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    frame.title = title; frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    wrap.append(frame);
    currentVideo = { videoId, title, channelTitle };
    $('#videoTitle').textContent = title;
    $('#videoSource').textContent = `${channelTitle} · YouTube`;
    $('#videoCover').textContent = '▶';
    $('#syncLabel').textContent = 'Видео выбрано';
    if (broadcast) sendRoomEvent({ type: 'video', videoId, title, channelTitle });
    $('#playerStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function copyInvite() {
    const url = roomUrl();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Моя комната SYNC', text: 'Заходи смотреть вместе!', url });
      } else {
        await navigator.clipboard.writeText(url);
        showToast('Ссылка на комнату скопирована');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        try { await navigator.clipboard.writeText(url); showToast('Ссылка на комнату скопирована'); }
        catch { showToast(url); }
      }
    }
  }
  async function inviteFriend(name) {
    const url = roomUrl();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'SYNC', text: `Присоединяйся к просмотру, ${name}!`, url });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        showToast(`Ссылка для ${name} скопирована`);
      } else {
        showToast(url);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('Не удалось поделиться ссылкой');
    }
  }
  function openModal(id) { $(`#${id}`).classList.remove('hidden'); if (id === 'friendModal') $('#friendName').focus(); }
  function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

  $$('.provider-chip').forEach((chip) => chip.addEventListener('click', () => selectProvider(chip.dataset.provider)));
  $('#searchForm').addEventListener('submit', (event) => { event.preventDefault(); searchVideos($('#searchInput').value); });
  $('#findFromPlayer').addEventListener('click', () => { $('#discover').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#searchInput').focus({ preventScroll: true }); });
  $('#inviteTop').addEventListener('click', copyInvite);
  $('#invitePeople').addEventListener('click', copyInvite);
  $('#shareRoom').addEventListener('click', copyInvite);
  $('#newRoom').addEventListener('click', () => setRoom(randomRoom(), false));
  $('#addFriend').addEventListener('click', () => openModal('friendModal'));
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
  $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
  $('#friendForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#friendName').value.trim().replace(/^@/, '');
    if (!name) return;
    if (friends.some((friend) => friend.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { showToast('Этот друг уже добавлен'); return; }
    friends.push({ name }); saveFriends(); renderFriends(); $('#friendName').value = ''; closeModal('friendModal'); showToast('Друг добавлен');
  });
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = $('#chatInput').value.trim();
    if (!message) return;
    addChatMessage(userName, message, true); sendRoomEvent({ type: 'chat', name: userName, message }); $('#chatInput').value = '';
  });
  $('#fullscreenButton').addEventListener('click', () => {
    const target = $('#playerStage');
    if (document.fullscreenElement) document.exitFullscreen?.();
    else target.requestFullscreen?.().catch(() => showToast('Полный экран недоступен'));
  });
  $('#profileButton').textContent = initials(userName);
  $('#profileButton').addEventListener('click', () => {
    const next = prompt('Как тебя называть?', userName);
    if (next && next.trim()) {
      userName = next.trim().slice(0, 24); localStorage.setItem('sync-user-name', userName);
      $('#profileButton').textContent = initials(userName);
      members.set(sessionId, { name: userName, role: 'Организатор' }); renderMembers();
      sendRoomEvent({ type: 'hello', id: sessionId, name: userName });
    }
  });

  connectRoom();
  renderMembers();
  renderFriends();
  sendRoomEvent({ type: 'hello', id: sessionId, name: userName });
  window.addEventListener('beforeunload', () => sendRoomEvent({ type: 'bye', id: sessionId }));
  selectProvider('youtube');
  if (new URLSearchParams(location.search).has('room')) $('#syncLabel').textContent = 'Вы вошли по приглашению';
})();

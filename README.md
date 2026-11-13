# SYNC — смотреть вместе

Сайт для совместного просмотра: личные комнаты по ссылке, друзья, текстовый и голосовой чат, вход через Google или почту, фото профиля, каталог приложений и встроенные плееры YouTube и RUTUBE с синхронизацией паузы и перемотки.

## Что в архиве

| Файл | Зачем |
|---|---|
| `index.html`, `styles.css`, `app.js`, `config.js` | сам сайт |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `manifest.webmanifest`, `sw.js` | иконки и установка как приложение |
| `supabase.sql` | база данных (запускается один раз, если проект новый) |
| `supabase-migration-05.sql` | обновление базы: аватары, состояние комнаты, друзья по ID |
| `supabase/functions/sync-search/index.ts` | исходник серверного поиска YouTube и RUTUBE |

## 1. Подключение Supabase (`config.js`)

1. Supabase → Project Settings → API.
2. В `SUPABASE_URL` вставь Project URL **без пути**: `https://xxxx.supabase.co` (не `.../rest/v1/`).
3. В `SUPABASE_PUBLISHABLE_KEY` вставь publishable (или anon) ключ. `service_role` и `secret` ключи сюда нельзя.

## 2. База данных

- Проект новый: SQL Editor → выполни `supabase.sql`, затем `supabase-migration-05.sql`.
- Проект уже работает по версии 0.3: выполни только `supabase-migration-05.sql` (повторный запуск безопасен).

## 3. Вход через Google

1. Google Cloud Console → создай OAuth Client ID типа Web application.
2. В Authorized redirect URIs добавь `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → Sign In / Providers → Google: включи и вставь Client ID и Client Secret.
4. Supabase → Authentication → URL Configuration: Site URL = адрес сайта на GitHub Pages; в Redirect URLs добавь тот же адрес.

## 4. Поиск видео (Edge Function)

В архив добавлен полный исходник функции `supabase/functions/sync-search/index.ts` — отдельный файл из интернета искать не нужно.

1. Supabase → Edge Functions → Deploy a new function → имя `sync-search`.
2. Вставь содержимое `supabase/functions/sync-search/index.ts` и разверни функцию. **Verify JWT оставь включённым**: поиск должен быть доступен только вошедшим пользователям.
3. Supabase → Edge Functions → Secrets: добавь `YOUTUBE_API_KEY` (ключ YouTube Data API v3 из Google Cloud Console). Без него поиск RUTUBE всё ещё будет работать, а YouTube будет показан как недоступный источник.

Поиск RUTUBE использует публичный endpoint сайта без ключа. Это не гарантированный публичный контракт: RUTUBE может изменить endpoint, формат ответа или ограничить запросы. Платные ролики отбрасываются; SYNC не обходит DRM и ограничения встраивания.


## 5. Публикация на GitHub Pages

Загрузи **файлы** из этой папки в корень репозитория (не папку целиком): `index.html` должен лежать в корне. Папка `supabase/` и SQL-файлы сайту не нужны, их можно не публиковать: Edge Function разворачивается отдельно в Supabase. После публикации открой адрес сайта и обнови страницу; при обновлении установленной PWA следуй подсказке SYNC о перезагрузке.

## Что умеет

- Вход через Google и по почте; имя и фото профиля (JPG, PNG, WebP, обрезка до квадрата).
- Комната по ссылке-приглашению; открытая комната запоминается и не плодится при каждом заходе.
- Друзья: поиск по имени, заявки, статус «в сети», приглашение ссылкой.
- Тёплая тёмная палитра, адаптивная навигация на телефонах и мобильный чат сразу под видеоплеером.
- Установка как PWA на поддерживаемых браузерах, Service Worker с сетевым обновлением и офлайн-кешем оболочки.
- Доступные модальные окна с управлением клавиатурой, фокусом и прокруткой.
- YouTube и RUTUBE внутри комнаты: выбранное видео, пауза, перемотка и позиция синхронизируются; если браузер блокирует автозапуск, появляется кнопка «Начать общий просмотр».
- VK Видео, Netflix, Кинопоиск и SoundCloud открываются в собственной веб-версии в новой вкладке: их сайты могут запрещать встраивание или защищать воспроизведение. SYNC не обходит DRM и ограничения платформ.
- Голосовой чат использует WebRTC для аудио и Supabase Realtime для сигналинга. Нужен HTTPS и разрешение на микрофон. В базовой конфигурации используется STUN; для стабильной работы через сети с жёстким NAT/фаерволом потребуется настроить TURN-сервер.

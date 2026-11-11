# SYNC — смотреть вместе

Сайт для совместного просмотра: личные комнаты по ссылке, друзья, чат, вход через Google или почту, фото профиля, встроенные плееры YouTube и RUTUBE с синхронизацией паузы и перемотки.

## Что в архиве

| Файл | Зачем |
|---|---|
| `index.html`, `styles.css`, `app.js`, `config.js` | сам сайт |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `manifest.webmanifest`, `sw.js` | иконки и установка как приложение |
| `supabase.sql` | база данных (запускается один раз, если проект новый) |
| `supabase-migration-05.sql` | обновление базы: аватары, состояние комнаты, друзья по ID |
| `supabase/functions/sync-search/index.ts` | серверный поиск YouTube и RUTUBE |

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

1. Supabase → Edge Functions → Deploy a new function → имя `sync-search` → вставь код из `supabase/functions/sync-search/index.ts`. Verify JWT оставь включённым.
2. Supabase → Edge Functions → Secrets: добавь `YOUTUBE_API_KEY` (ключ YouTube Data API v3 из Google Cloud Console). Для RUTUBE ключ не нужен.

Поиск RUTUBE использует публичный endpoint самого сайта: это не гарантированный контракт, он может измениться или ограничить запросы.

## 5. Публикация на GitHub Pages

Загрузи **файлы** из этой папки в корень репозитория (не папку целиком): `index.html` должен лежать в корне. Папка `supabase/` и SQL-файлы сайту не нужны, их можно не публиковать. После Commit обнови страницу дважды.

## Что умеет

- Вход через Google и по почте; имя и фото профиля (JPG, PNG, WebP, обрезка до квадрата).
- Комната по ссылке-приглашению; открытая комната запоминается и не плодится при каждом заходе.
- Друзья: поиск по имени, заявки, статус «в сети», приглашение ссылкой.
- YouTube и RUTUBE внутри комнаты: выбранное видео, пауза, перемотка и позиция синхронизируются; если браузер блокирует автозапуск, появляется кнопка «Начать общий просмотр».
- VK Видео, Netflix и Кинопоиск: показаны как недоступные для встраивания; SYNC не обходит DRM и правила платформ.

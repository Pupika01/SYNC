/*
  Публичные настройки SYNC.
  Сюда можно вставлять только Project URL и anon/publishable key из Supabase.
  Project URL должен быть БЕЗ пути: https://xxxx.supabase.co (без /rest/v1/).
  НИКОГДА не вставляй сюда service_role или secret key.
  Ключ YouTube API хранится не здесь, а в Secrets Edge Function sync-search.
*/
window.SYNC_CONFIG = {
  SUPABASE_URL: "https://mrifwkffxfdltidhbscv.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_BQu5ffNOWrzbDF7g6WZlrA_c8zzx656",
  SUPABASE_ANON_KEY: "" // запасной вариант для старых проектов Supabase
};

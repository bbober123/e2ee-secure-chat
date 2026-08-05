import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// Włącz Realtime dla tabeli messages (sprawdź czy serwer też ma włączone)
export async function ensureRealtime() {
  const channel = supabase.channel('db-messages');
  channel.subscribe((status) => {
    console.log('Realtime status:', status);
  });
  return channel;
}

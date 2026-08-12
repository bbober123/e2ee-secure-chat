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

// Walidacja przy starcie - ostrzeż jeśli dane Supabase nie zostały uzupełnione
if (CONFIG.SUPABASE_URL.includes('TWOJ-PROJEKT') || CONFIG.SUPABASE_ANON_KEY.includes('TWOJ-ANON-KEY')) {
    console.error(
        'BŁĄD KONFIGURACJI: Uzupełnij VITE_SUPABASE_URL i VITE_SUPABASE_ANON_KEY w pliku .env ' +
        '(patrz .env.example). Logowanie i rejestracja nie będą działać bez poprawnych danych Supabase.'
    );
}

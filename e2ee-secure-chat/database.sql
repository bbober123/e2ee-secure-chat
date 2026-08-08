-- =====================================================================
-- SecureChat E2EE — schemat bazy danych (Supabase / Postgres)
--
-- Ten plik jest IDEMPOTENTNY: można go uruchomić wielokrotnie, na pustej
-- bazie i na już istniejącej (z danymi), bez błędów typu
-- "relation already exists" / "policy already exists" / "already member
-- of publication". Nie usuwa (DROP) żadnych tabel ani danych — jedynie
-- tworzy brakujące obiekty i (bezpiecznie) nadpisuje definicje polityk.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- 1. Tabela Użytkowników
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    id UUID REFERENCES auth.users(id) PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    avatar_url TEXT,
    public_key_real TEXT NOT NULL,
    public_key_fake TEXT NOT NULL,
    salt_real TEXT NOT NULL,
    salt_fake TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Na wypadek starszej wersji schematu bez tej kolumny
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read all users" ON public.users;
CREATE POLICY "Users can read all users" ON public.users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own record" ON public.users;
CREATE POLICY "Users can insert their own record" ON public.users
    FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update their own record" ON public.users;
CREATE POLICY "Users can update their own record" ON public.users
    FOR UPDATE USING (auth.uid() = id);

-- ---------------------------------------------------------------------
-- 2. Tabela Urządzeń (Client-side Vaults)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL,
    encrypted_private_key_real TEXT NOT NULL,
    encrypted_private_key_fake TEXT NOT NULL,
    label TEXT,
    last_ip TEXT,
    last_user_agent TEXT,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, device_fingerprint)
);

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own devices" ON public.devices;
CREATE POLICY "Users can read their own devices" ON public.devices
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own devices" ON public.devices;
CREATE POLICY "Users can insert their own devices" ON public.devices
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own devices" ON public.devices;
CREATE POLICY "Users can update their own devices" ON public.devices
    FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 2b. Tabela Historii Logowań (IP, urządzenie, czas - dla każdego konta)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_history (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.login_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own login history" ON public.login_history;
CREATE POLICY "Users can read their own login history" ON public.login_history
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own login history" ON public.login_history;
CREATE POLICY "Users can insert their own login history" ON public.login_history
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON public.login_history(user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 3. Tabela Kontaktów
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contacts (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    contact_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    real_nickname TEXT,
    fake_nickname TEXT,
    real_avatar_url TEXT,
    fake_avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(owner_id, contact_user_id)
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own contacts" ON public.contacts;
CREATE POLICY "Users can manage their own contacts" ON public.contacts
    FOR ALL USING (auth.uid() = owner_id);

-- ---------------------------------------------------------------------
-- 4. Tabela Konwersacji
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    created_by UUID REFERENCES public.users(id),
    participant_ids UUID[] NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see conversations they are part of" ON public.conversations;
CREATE POLICY "Users can see conversations they are part of" ON public.conversations
    FOR SELECT USING (auth.uid() = ANY(participant_ids));

DROP POLICY IF EXISTS "Users can insert conversations" ON public.conversations;
CREATE POLICY "Users can insert conversations" ON public.conversations
    FOR INSERT WITH CHECK (auth.uid() = ANY(participant_ids));

DROP POLICY IF EXISTS "Users can update conversations they are part of" ON public.conversations;
CREATE POLICY "Users can update conversations they are part of" ON public.conversations
    FOR UPDATE USING (auth.uid() = ANY(participant_ids));

-- ---------------------------------------------------------------------
-- 5. Tabela Wiadomości
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES public.users(id),
    encrypted_payload TEXT NOT NULL,
    nonce TEXT NOT NULL,
    encrypted_content_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    status TEXT DEFAULT 'sent',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read messages in their conversations" ON public.messages;
CREATE POLICY "Users can read messages in their conversations" ON public.messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = messages.conversation_id
            AND auth.uid() = ANY(c.participant_ids)
        )
    );

DROP POLICY IF EXISTS "Users can insert messages to their conversations" ON public.messages;
CREATE POLICY "Users can insert messages to their conversations" ON public.messages
    FOR INSERT WITH CHECK (
        auth.uid() = sender_id AND
        EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = conversation_id
            AND auth.uid() = ANY(c.participant_ids)
        )
    );

DROP POLICY IF EXISTS "Users can update message status in their conversations" ON public.messages;
CREATE POLICY "Users can update message status in their conversations" ON public.messages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = messages.conversation_id
            AND auth.uid() = ANY(c.participant_ids)
        )
    );

-- ---------------------------------------------------------------------
-- Indeksy dla wydajności
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON public.messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_participant_ids ON public.conversations USING GIN (participant_ids);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_id ON public.contacts(owner_id);

-- ---------------------------------------------------------------------
-- Publikacja dla Realtime (Supabase)
-- Dodaje tabele do publikacji tylko jeśli jeszcze w niej nie są —
-- bezpieczne do wielokrotnego uruchomienia.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
END $$;

-- Wymagane, żeby zmiana awatara (users.avatar_url) była widoczna na żywo
-- u innych użytkowników bez odświeżania strony
-- (patrz ChatApp.subscribeToProfileUpdates w src/js/chat.js).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
    END IF;
END $$;

-- Bezpieczne przy wielokrotnym uruchomieniu (ustawienie tej samej wartości nie jest błędem)
ALTER TABLE public.users REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------
-- 6. Storage: bucket na awatary użytkowników
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Awatary są publicznie widoczne (potrzebne do wyświetlania ich rozmówcom)
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
CREATE POLICY "Avatar images are publicly accessible" ON storage.objects
    FOR SELECT USING (bucket_id = 'avatars');

-- Użytkownik może wgrywać/nadpisywać/usuwać TYLKO plik we własnym folderze: avatars/<user_id>/...
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
    );

DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can update their own avatar" ON storage.objects
    FOR UPDATE USING (
        bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
    );

DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
CREATE POLICY "Users can delete their own avatar" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
    );

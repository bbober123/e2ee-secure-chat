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

-- Tożsamość X3DH/Double Ratchet (ECDH P-256 do X3DH + ECDSA P-256 do podpisywania SPK,
-- razem jako JSON: {"dh": JWK, "sign": JWK}) — osobna dla trybu real i fake, tak jak
-- public_key_real/public_key_fake powyżej. public_key_real/fake (RSA-4096) zostają
-- nietknięte — nadal ich używa wymiana kluczy połączeń głosowych/wideo (src/js/calls.js),
-- co jest poza zakresem tej migracji.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS identity_bundle_real TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS identity_bundle_fake TEXT;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read all users" ON public.users;
CREATE POLICY "Users can read all users" ON public.users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own record" ON public.users;
CREATE POLICY "Users can insert their own record" ON public.users
    FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update their own record" ON public.users;
CREATE POLICY "Users can update their own record" ON public.users
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ---------------------------------------------------------------------
-- 2. Tabela Urządzeń (Client-side Vaults)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL,
    encrypted_private_key_real TEXT NOT NULL,
    encrypted_private_key_fake TEXT NOT NULL,
    -- Cały prywatny materiał X3DH/Double Ratchet (Identity DH priv, Identity Signing priv,
    -- aktualny Signed Prekey priv, zapas One-Time Prekeys priv) jako jeden zaszyfrowany JSON
    -- blob (AES-GCM, kluczem PBKDF2(hasło) — ten sam wzorzec co encrypted_private_key_*).
    -- Publiczne odpowiedniki (do pobrania przez innych) są w users.identity_bundle_*,
    -- public.signed_prekeys i public.one_time_prekeys.
    encrypted_prekey_vault_real TEXT,
    encrypted_prekey_vault_fake TEXT,
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
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

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
-- 4a. Prośby o znajomość (friend requests) — zastępują dawne bezpośrednie
-- dodawanie kontaktu: wysłanie prośby NIE tworzy jeszcze wpisu w `contacts`,
-- dopiero jej zaakceptowanie (przez odbiorcę, przez RPC accept_friend_request)
-- tworzy wzajemne wpisy w `contacts` dla obu stron + konwersację 1:1.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friend_requests (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    from_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    to_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    real_nickname TEXT,   -- nick, jaki NADAWCA chce nadać kontaktowi u SIEBIE po akceptacji (real)
    fake_nickname TEXT,   -- j.w., tryb fake
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(from_user_id, to_user_id),
    CHECK (from_user_id != to_user_id)
);

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see requests involving them" ON public.friend_requests;
CREATE POLICY "Users can see requests involving them" ON public.friend_requests
    FOR SELECT USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

DROP POLICY IF EXISTS "Users can send friend requests" ON public.friend_requests;
CREATE POLICY "Users can send friend requests" ON public.friend_requests
    FOR INSERT WITH CHECK (auth.uid() = from_user_id);

-- DELETE służy zarówno do cofnięcia własnej wysłanej prośby, jak i odrzucenia
-- otrzymanej (obie strony mogą po prostu usunąć wiersz - akceptacja natomiast
-- idzie WYŁĄCZNIE przez poniższą funkcję, bo musi dotknąć cudzych wierszy `contacts`).
DROP POLICY IF EXISTS "Users can delete requests involving them" ON public.friend_requests;
CREATE POLICY "Users can delete requests involving them" ON public.friend_requests
    FOR DELETE USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

CREATE OR REPLACE FUNCTION public.accept_friend_request(request_id UUID)
RETURNS VOID AS $$
DECLARE
    v_req RECORD;
BEGIN
    SELECT * INTO v_req FROM public.friend_requests WHERE id = request_id AND to_user_id = auth.uid();
    IF v_req.id IS NULL THEN
        RAISE EXCEPTION 'Prośba nie istnieje lub nie masz do niej dostępu.';
    END IF;

    INSERT INTO public.contacts (owner_id, contact_user_id, real_nickname, fake_nickname)
        VALUES (v_req.from_user_id, v_req.to_user_id, v_req.real_nickname, v_req.fake_nickname)
        ON CONFLICT (owner_id, contact_user_id) DO NOTHING;
    INSERT INTO public.contacts (owner_id, contact_user_id)
        VALUES (v_req.to_user_id, v_req.from_user_id)
        ON CONFLICT (owner_id, contact_user_id) DO NOTHING;

    IF NOT EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.type = 'direct'
          AND c.participant_ids @> ARRAY[v_req.from_user_id, v_req.to_user_id]
          AND array_length(c.participant_ids, 1) = 2
    ) THEN
        INSERT INTO public.conversations (participant_ids, created_by, type)
        VALUES (ARRAY[v_req.from_user_id, v_req.to_user_id], v_req.to_user_id, 'direct');
    END IF;

    DELETE FROM public.friend_requests WHERE id = request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.accept_friend_request(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 4b. Grupy — tworzenie, dołączanie przez (nazwa twórcy + kod), członkostwo.
-- ---------------------------------------------------------------------
-- Pomocnicza funkcja SECURITY DEFINER do sprawdzania członkostwa w grupie.
-- KONIECZNA (nie tylko dla wygody): polityka SELECT na `group_members` musi
-- sprawdzić "czy jestem członkiem TEJ grupy", ale zwykłe
-- `EXISTS (SELECT ... FROM group_members ...)` WEWNĄTRZ polityki NA
-- group_members odpytywałoby samo siebie -> Postgres zgłasza
-- "infinite recursion detected in policy for relation group_members".
-- Funkcja SECURITY DEFINER wykonuje zapytanie z uprawnieniami właściciela
-- (pomijając RLS), więc nie wywołuje ponownie polityki, którą sama pomaga
-- ewaluować - rekurencja znika.
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE group_id = p_group_id AND user_id = p_user_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION public.is_group_member(UUID, UUID) TO authenticated;

CREATE TABLE IF NOT EXISTS public.groups (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    creator_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    join_code TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(creator_id, join_code)
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

-- Świadomie WĄSKA polityka: `groups` NIE jest przeszukiwalne wprost przez klienta
-- (nikt niebędący członkiem nie zobaczy nazwy/istnienia grupy) - dołączanie po
-- (nazwa twórcy + kod) idzie WYŁĄCZNIE przez join_group_by_code() poniżej (SECURITY
-- DEFINER), które samo weryfikuje kod i nie ujawnia niczego przy błędnym kodzie.
DROP POLICY IF EXISTS "Members can read their groups" ON public.groups;
CREATE POLICY "Members can read their groups" ON public.groups
    FOR SELECT USING (public.is_group_member(groups.id, auth.uid()));

DROP POLICY IF EXISTS "Users can create groups" ON public.groups;
CREATE POLICY "Users can create groups" ON public.groups
    FOR INSERT WITH CHECK (auth.uid() = creator_id);

CREATE TABLE IF NOT EXISTS public.group_members (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(group_id, user_id)
);

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can see fellow members" ON public.group_members;
CREATE POLICY "Members can see fellow members" ON public.group_members
    FOR SELECT USING (public.is_group_member(group_members.group_id, auth.uid()));

-- Twórca dodaje SIEBIE bezpośrednio przy tworzeniu grupy; dołączenie kogokolwiek
-- INNEGO idzie wyłącznie przez join_group_by_code() (SECURITY DEFINER) poniżej,
-- bo w chwili dołączania osoba jeszcze NIE jest członkiem i zwykła RLS by to zablokowała.
DROP POLICY IF EXISTS "Users can add themselves as a member" ON public.group_members;
CREATE POLICY "Users can add themselves as a member" ON public.group_members
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Rozszerzenie `conversations` o typ grupowy - jedna konwersacja (i jedna lista
-- messages.conversation_id) na grupę, tak samo jak dla rozmów 1:1.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group'));
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_group_id_key;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_group_id_key UNIQUE (group_id);

CREATE OR REPLACE FUNCTION public.join_group_by_code(creator_username TEXT, code TEXT)
RETURNS TABLE(group_id UUID, group_name TEXT, conversation_id UUID, existing_member_ids UUID[]) AS $$
DECLARE
    v_creator_id UUID;
    v_group RECORD;
    v_conv_id UUID;
    v_members UUID[];
BEGIN
    SELECT id INTO v_creator_id FROM public.users WHERE username = creator_username;
    IF v_creator_id IS NULL THEN
        RAISE EXCEPTION 'Nie znaleziono użytkownika o takiej nazwie.';
    END IF;

    SELECT * INTO v_group FROM public.groups g WHERE g.creator_id = v_creator_id AND g.join_code = upper(code);
    IF v_group.id IS NULL THEN
        RAISE EXCEPTION 'Nieprawidłowy kod dołączenia.';
    END IF;

    SELECT c.id INTO v_conv_id FROM public.conversations c WHERE c.group_id = v_group.id;
    IF v_conv_id IS NULL THEN
        RAISE EXCEPTION 'Konwersacja tej grupy nie istnieje.';
    END IF;

    SELECT array_agg(gm.user_id) INTO v_members FROM public.group_members gm WHERE gm.group_id = v_group.id;

    IF auth.uid() = ANY(v_members) THEN
        RAISE EXCEPTION 'Jesteś już członkiem tej grupy.';
    END IF;

    INSERT INTO public.group_members (group_id, user_id) VALUES (v_group.id, auth.uid());
    UPDATE public.conversations SET participant_ids = array_append(participant_ids, auth.uid()), updated_at = now() WHERE id = v_conv_id;

    group_id := v_group.id;
    group_name := v_group.name;
    conversation_id := v_conv_id;
    existing_member_ids := v_members;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 4c. Dystrybucja kluczy grupowych (Sender Keys) — jednorazowe, "zapieczętowane"
-- pakiety X3DH wysyłane PAIRWISE do każdego członka (patrz src/js/sealed.js,
-- src/js/groupkeys.js). Serwer widzi tylko nieprzezroczysty ciphertext + KTO->KOMU,
-- nigdy sam klucz łańcucha nadawczego.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_key_messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
    from_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    to_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    payload TEXT NOT NULL, -- JSON: {ik, ek, spkId, opkId, ciphertext, nonce} - patrz sealed.js
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.group_key_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Recipients can read their key distributions" ON public.group_key_messages;
CREATE POLICY "Recipients can read their key distributions" ON public.group_key_messages
    FOR SELECT USING (auth.uid() = to_user_id);

DROP POLICY IF EXISTS "Senders can create key distributions" ON public.group_key_messages;
CREATE POLICY "Senders can create key distributions" ON public.group_key_messages
    FOR INSERT WITH CHECK (auth.uid() = from_user_id);

-- Odbiorca kasuje wiersz zaraz po skonsumowaniu (jednorazowe użycie - patrz consumePendingKeyDistributions).
DROP POLICY IF EXISTS "Recipients can delete after consuming" ON public.group_key_messages;
CREATE POLICY "Recipients can delete after consuming" ON public.group_key_messages
    FOR DELETE USING (auth.uid() = to_user_id);

-- ---------------------------------------------------------------------
-- 4d. Stan Sender Keys per grupa (zaszyfrowany hasłem) - własny łańcuch +
-- ostatnio znane łańcuchy pozostałych członków, żeby przetrwać F5 tak samo
-- jak ratchet_states dla rozmów 1:1.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_sender_states (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    encrypted_state TEXT NOT NULL,
    nonce TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, group_id, mode)
);

ALTER TABLE public.group_sender_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage only their own group sender state" ON public.group_sender_states;
CREATE POLICY "Users manage only their own group sender state" ON public.group_sender_states
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON public.group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON public.group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_key_messages_recipient ON public.group_key_messages(to_user_id, mode);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON public.friend_requests(to_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON public.friend_requests(from_user_id);

-- ---------------------------------------------------------------------
-- 5. Tabela Wiadomości
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES public.users(id),
    ciphertext TEXT NOT NULL,        -- AES-256-GCM ciphertext (base64), kluczem wyprowadzonym z chain ratchetu
    nonce TEXT NOT NULL,             -- 12 bajtów nonce (base64)
    header TEXT NOT NULL,            -- JSON: {dh: JWK, pn: int, n: int, x3dh?: {ik, ek, spkId, opkId}} — TYLKO liczniki + klucze publiczne, zero treści
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    status TEXT DEFAULT 'sent',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ---------------------------------------------------------------------
-- MIGRACJA Z RSA-4096+AES-GCM NA X3DH+DOUBLE RATCHET (breaking change)
-- ---------------------------------------------------------------------
-- Stare wiadomości (kolumny encrypted_payload/encrypted_content_key, szyfrowane
-- kluczem sesyjnym owiniętym RSA) są KRYPTOGRAFICZNIE NIEKOMPATYBILNE z nowym
-- protokołem — nie da się ich odszyfrować nowym kodem klienta, bo nie ma dla
-- nich stanu ratchetu ani nagłówka. Ten blok migruje istniejące instalacje:
-- przenosi starą treść 1:1 do nowych kolumn nazwą (nie da się jej odszyfrować,
-- ale UI pokaże normalny błąd deszyfrowania zamiast psuć się na braku kolumny),
-- a `header` wypełnia pustym obiektem JSON jako placeholder.
-- Jeśli wolisz po prostu wyczyścić historię przy wdrożeniu tej zmiany, zastąp
-- poniższy blok pojedynczym: TRUNCATE TABLE public.messages;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'encrypted_payload') THEN
        ALTER TABLE public.messages RENAME COLUMN encrypted_payload TO ciphertext;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'header') THEN
        ALTER TABLE public.messages ADD COLUMN header TEXT;
        UPDATE public.messages SET header = '{}' WHERE header IS NULL;
        ALTER TABLE public.messages ALTER COLUMN header SET NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'encrypted_content_key') THEN
        ALTER TABLE public.messages DROP COLUMN encrypted_content_key;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5b. Media (zdjęcia / filmy / wiadomości głosowe)
-- ---------------------------------------------------------------------
-- Pliki są szyfrowane W CAŁOŚCI po stronie klienta (AES-256-GCM, ten sam
-- świeży klucz sesyjny co reszta wiadomości - patrz src/js/media.js) i
-- wgrywane jako nieprzezroczysty ciphertext do prywatnego bucketu 'media'.
-- Kolumny poniżej trzymają WYŁĄCZNIE to, co niezbędne do pobrania i
-- odszyfrowania pliku - same są (poza media_path/media_size) tak samo
-- "ślepe" dla serwera jak ciphertext dla wiadomości tekstowych.
-- `ciphertext`/`nonce`/`header` dla wiadomości typu != 'text' przechowują
-- zaszyfrowane METADANE pliku (oryginalna nazwa, MIME, czas trwania nagrania)
-- - nie samą treść pliku.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'text'
    CHECK (type IN ('text', 'image', 'video', 'voice'));
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_path TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_size INTEGER;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_nonce TEXT;

-- Spójność: wiadomości tekstowe nie mają pliku, medialne mają ścieżkę+nonce pliku.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_media_consistency;
ALTER TABLE public.messages ADD CONSTRAINT messages_media_consistency CHECK (
    (type = 'text' AND media_path IS NULL AND media_nonce IS NULL)
    OR (type != 'text' AND media_path IS NOT NULL AND media_nonce IS NOT NULL)
);

-- Rozszerzenie triggera niezmienności treści (patrz sekcja poniżej) obejmuje
-- też nowe kolumny media_* i type - trigger jest zdefiniowany raz, niżej,
-- już z pełną listą kolumn.

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

-- UWAGA BEZPIECZEŃSTWA (naprawione): poprzednia wersja tej polityki (USING bez WITH CHECK
-- i bez ograniczenia kolumn) pozwalała KAŻDEMU uczestnikowi konwersacji nadpisać DOWOLNĄ
-- kolumnę wiadomości - w tym ciphertext, nonce, header czy sender_id,
-- nie tylko pole 'status' (do którego UPDATE faktycznie służy - oznaczanie jako przeczytane).
-- To pozwalało na sabotaż/DoS treści (nadpisanie szyfrogramu) przez drugą stronę rozmowy.
-- Rozwiązanie: RLS pozwala UPDATE dowolnej kolumny (Postgres RLS nie ma natywnej granulacji
-- per-kolumna), ale poniższy trigger wymusza, że jedyną zmienną kolumną jest 'status'.
DROP POLICY IF EXISTS "Users can update message status in their conversations" ON public.messages;
CREATE POLICY "Users can update message status in their conversations" ON public.messages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = messages.conversation_id
            AND auth.uid() = ANY(c.participant_ids)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = messages.conversation_id
            AND auth.uid() = ANY(c.participant_ids)
        )
    );

-- Trigger wymuszający niezmienność treści wiadomości: UPDATE może zmienić WYŁĄCZNIE
-- kolumnę 'status' (używane do oznaczania "przeczytane"). Każda próba zmiany
-- szyfrogramu, noncu, kluczy sesyjnych, nadawcy, konwersacji czy trybu jest odrzucana.
CREATE OR REPLACE FUNCTION public.prevent_message_content_tampering()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
       OR NEW.nonce IS DISTINCT FROM OLD.nonce
       OR NEW.header IS DISTINCT FROM OLD.header
       OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.timestamp IS DISTINCT FROM OLD.timestamp
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.media_path IS DISTINCT FROM OLD.media_path
       OR NEW.media_size IS DISTINCT FROM OLD.media_size
       OR NEW.media_nonce IS DISTINCT FROM OLD.media_nonce THEN
        RAISE EXCEPTION 'Modyfikacja treści wiadomości jest niedozwolona - można zmienić tylko status.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_message_content_tampering ON public.messages;
CREATE TRIGGER trg_prevent_message_content_tampering
    BEFORE UPDATE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.prevent_message_content_tampering();

-- Rate limiting po stronie serwera (obrona w głębi - limit klienta w chat.js można ominąć
-- wywołując Supabase API bezpośrednio). Maksymalnie 30 wiadomości / 60 sekund / nadawca,
-- lekko luźniejszy niż limit klienta (15/60s), żeby nie kolidować z normalnym użyciem.
CREATE OR REPLACE FUNCTION public.enforce_message_rate_limit()
RETURNS TRIGGER AS $$
DECLARE
    recent_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO recent_count
    FROM public.messages
    WHERE sender_id = NEW.sender_id
      AND timestamp > (now() - interval '60 seconds');

    IF recent_count >= 30 THEN
        RAISE EXCEPTION 'Przekroczono limit wysyłania wiadomości. Spróbuj ponownie za chwilę.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_message_rate_limit ON public.messages;
CREATE TRIGGER trg_enforce_message_rate_limit
    BEFORE INSERT ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.enforce_message_rate_limit();

-- ---------------------------------------------------------------------
-- 5c. X3DH — Signed Prekey (średnioterminowy, rotowany co 7 dni)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.signed_prekeys (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    prekey_id INT NOT NULL,
    public_key TEXT NOT NULL,        -- JWK ECDH P-256
    signature TEXT NOT NULL,         -- ECDSA P-256, podpis nad kanoniczną reprezentacją public_key kluczem podpisującym tożsamości
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, mode, prekey_id)
);

ALTER TABLE public.signed_prekeys ENABLE ROW LEVEL SECURITY;

-- Publiczne (jak public_key_real/fake w users) - każdy zalogowany musi móc pobrać
-- SPK dowolnego kontaktu, żeby zainicjować X3DH.
DROP POLICY IF EXISTS "Anyone can read signed prekeys" ON public.signed_prekeys;
CREATE POLICY "Anyone can read signed prekeys" ON public.signed_prekeys
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users manage their own signed prekeys" ON public.signed_prekeys;
CREATE POLICY "Users manage their own signed prekeys" ON public.signed_prekeys
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 5d. X3DH — One-Time Prekeys (zużywane jednorazowo)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.one_time_prekeys (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    prekey_id INT NOT NULL,
    public_key TEXT NOT NULL,        -- JWK ECDH P-256
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, mode, prekey_id)
);

ALTER TABLE public.one_time_prekeys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read unused one-time prekeys" ON public.one_time_prekeys;
CREATE POLICY "Anyone can read unused one-time prekeys" ON public.one_time_prekeys
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users manage their own one-time prekeys" ON public.one_time_prekeys;
CREATE POLICY "Users manage their own one-time prekeys" ON public.one_time_prekeys
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Ważne: NIE dodajemy szerokiej polityki "UPDATE dla wszystkich" na used=true (byłaby podatna
-- na race condition - dwóch inicjatorów mogłoby jednocześnie "zaklaimować" ten sam OPK zanim
-- transakcja UPDATE się zakończy). Zamiast tego konsumpcja OPK idzie WYŁĄCZNIE przez poniższą
-- funkcję SECURITY DEFINER, która robi atomowy SELECT ... FOR UPDATE SKIP LOCKED + UPDATE
-- w jednej transakcji, więc dwóch jednoczesnych wywołujących zawsze dostanie RÓŻNE klucze.
CREATE OR REPLACE FUNCTION public.claim_one_time_prekey(target_user_id UUID, target_mode TEXT)
RETURNS TABLE(prekey_id INT, public_key TEXT) AS $$
DECLARE
    claimed RECORD;
BEGIN
    SELECT o.id, o.prekey_id, o.public_key INTO claimed
    FROM public.one_time_prekeys o
    WHERE o.user_id = target_user_id AND o.mode = target_mode AND o.used = FALSE
    ORDER BY o.prekey_id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF claimed.id IS NULL THEN
        RETURN; -- brak OPK w zapasie — X3DH przejdzie na wariant bez OPK (3 DH zamiast 4)
    END IF;

    UPDATE public.one_time_prekeys SET used = TRUE WHERE id = claimed.id;

    prekey_id := claimed.prekey_id;
    public_key := claimed.public_key;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Każdy zalogowany użytkownik może wywołać funkcję (samo czytanie/oznaczanie zużycia jest
-- bezpieczne dzięki SECURITY DEFINER + logice powyżej; funkcja nigdy nie zwraca ani nie
-- modyfikuje niczego poza jednym wierszem OPK).
GRANT EXECUTE ON FUNCTION public.claim_one_time_prekey(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 5e. Stan Double Ratchet per-konwersacja/per-urządzenie (zaszyfrowany hasłem)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ratchet_states (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'fake')),
    encrypted_state TEXT NOT NULL,   -- AES-256-GCM zaszyfrowany JSON stanu (RK/CK/liczniki/klucze ratchetu)
    nonce TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, conversation_id, device_fingerprint, mode)
);

ALTER TABLE public.ratchet_states ENABLE ROW LEVEL SECURITY;

-- Stan ratchetu to sekret (choć zaszyfrowany) - w przeciwieństwie do kluczy publicznych
-- powyżej, WYŁĄCZNIE właściciel może go czytać/zapisywać.
DROP POLICY IF EXISTS "Users manage only their own ratchet state" ON public.ratchet_states;
CREATE POLICY "Users manage only their own ratchet state" ON public.ratchet_states
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_signed_prekeys_user_mode ON public.signed_prekeys(user_id, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user_mode_unused ON public.one_time_prekeys(user_id, mode) WHERE used = FALSE;
CREATE INDEX IF NOT EXISTS idx_ratchet_states_lookup ON public.ratchet_states(user_id, conversation_id, device_fingerprint, mode);

-- ---------------------------------------------------------------------
-- 9. Kazyno — wirtualne żetony i stoły wieloosobowe (granie ze znajomymi)
-- ---------------------------------------------------------------------
-- WAŻNE: to są WYŁĄCZNIE wirtualne żetony do zabawy (bez wartości pieniężnej,
-- bez możliwości wypłaty) - konto startuje z 1000, plus możliwy bonus dobowy.
CREATE TABLE IF NOT EXISTS public.casino_balances (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    chips BIGINT NOT NULL DEFAULT 1000 CHECK (chips >= 0),
    last_daily_bonus_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.casino_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage only their own casino balance" ON public.casino_balances;
CREATE POLICY "Users manage only their own casino balance" ON public.casino_balances
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Atomowa zmiana salda (stawki/wygrane/bonus dobowy) - RPC zamiast
-- odczyt-potem-zapis z klienta, żeby dwie jednoczesne karty/zakładki
-- (albo dwa szybkie kliknięcia) nie mogły ze sobą "wyścigowo" nadpisać salda
-- i np. wydać więcej żetonów niż faktycznie było na koncie.
CREATE OR REPLACE FUNCTION public.casino_adjust_chips(delta BIGINT, claim_bonus BOOLEAN DEFAULT FALSE)
RETURNS BIGINT AS $$
DECLARE
    new_balance BIGINT;
BEGIN
    INSERT INTO public.casino_balances (user_id, chips) VALUES (auth.uid(), 1000)
        ON CONFLICT (user_id) DO NOTHING;

    IF claim_bonus THEN
        UPDATE public.casino_balances
        SET chips = chips + delta, last_daily_bonus_at = now(), updated_at = now()
        WHERE user_id = auth.uid()
          AND (last_daily_bonus_at IS NULL OR last_daily_bonus_at < now() - INTERVAL '20 hours')
        RETURNING chips INTO new_balance;

        IF new_balance IS NULL THEN
            RAISE EXCEPTION 'daily bonus not yet available';
        END IF;
        RETURN new_balance;
    END IF;

    UPDATE public.casino_balances
    SET chips = chips + delta, updated_at = now()
    WHERE user_id = auth.uid() AND chips + delta >= 0
    RETURNING chips INTO new_balance;

    IF new_balance IS NULL THEN
        RAISE EXCEPTION 'insufficient chips';
    END IF;
    RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.casino_adjust_chips(BIGINT, BOOLEAN) TO authenticated;

-- Stoły wieloosobowe (na razie: blackjack ze znajomym). Stan gry (talia, ręce,
-- tura) leży w jednej współdzielonej kolumnie JSONB - patrz uwaga o zaufaniu
-- klienta w src/js/casino/blackjack.js (świadomy kompromis dla gry-zabawy
-- między znajomymi, bez osobnego serwera gry).
CREATE TABLE IF NOT EXISTS public.casino_tables (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    game TEXT NOT NULL CHECK (game IN ('blackjack')),
    creator_id UUID REFERENCES public.users(id),
    participant_ids UUID[] NOT NULL,
    state JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.casino_tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants can read their casino table" ON public.casino_tables;
CREATE POLICY "Participants can read their casino table" ON public.casino_tables
    FOR SELECT USING (auth.uid() = ANY(participant_ids));

DROP POLICY IF EXISTS "Creator can create a casino table" ON public.casino_tables;
CREATE POLICY "Creator can create a casino table" ON public.casino_tables
    FOR INSERT WITH CHECK (auth.uid() = creator_id AND auth.uid() = ANY(participant_ids));

DROP POLICY IF EXISTS "Participants can update their casino table" ON public.casino_tables;
CREATE POLICY "Participants can update their casino table" ON public.casino_tables
    FOR UPDATE USING (auth.uid() = ANY(participant_ids));

CREATE INDEX IF NOT EXISTS idx_casino_tables_participants ON public.casino_tables USING GIN (participant_ids);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'casino_tables'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.casino_tables;
    END IF;
END $$;

-- Zaproszenie do gry to zwykła wiadomość czatu (typ 'game_invite') - podróżuje
-- przez ten sam Double Ratchet / Sender Keys co reszta wiadomości, więc
-- treść zaproszenia (który stół, jaka gra) jest tak samo E2EE jak zwykły tekst.
DO $$
BEGIN
    ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_type_check;
    ALTER TABLE public.messages ADD CONSTRAINT messages_type_check
        CHECK (type IN ('text', 'image', 'video', 'voice', 'game_invite'));
END $$;
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

-- Prośby o znajomość, dołączenia do grup i dystrybucja kluczy grupowych muszą
-- działać na żywo (bez odświeżania), żeby np. istniejący członek grupy mógł
-- natychmiast wypchnąć swój Sender Key nowemu dołączającemu (patrz
-- ChatApp.subscribeToGroupJoins / subscribeToKeyDistributions w chat.js).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'friend_requests'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_requests;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_members'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.group_members;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_key_messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.group_key_messages;
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

-- ---------------------------------------------------------------------
-- 7. Storage: bucket na zaszyfrowane pliki (zdjęcia / filmy / głosówki)
-- ---------------------------------------------------------------------
-- W PRZECIWIEŃSTWIE do 'avatars' ten bucket jest PRYWATNY: pliki są już
-- szyfrowane end-to-end po stronie klienta, więc nawet publiczny odczyt nie
-- ujawniłby treści, ALE pozostawiłby serwerowi/każdemu z linkiem metadane
-- (kto z kim, kiedy, jak duży plik). Dostęp ograniczamy więc do uczestników
-- danej konwersacji, tak samo jak do samych wierszy `messages`.
-- Ścieżka pliku MUSI mieć format: <conversation_id>/<message_id>-<losowa_nazwa>
-- (wymuszane w src/js/media.js), żeby poniższe polityki mogły sprawdzić
-- uprawnienia na podstawie pierwszego segmentu ścieżki.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('media', 'media', false, 104857600) -- 100 MB - dopasuj do potrzeb/planu Supabase
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Participants can read conversation media" ON storage.objects;
CREATE POLICY "Participants can read conversation media" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'media' AND EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id::text = (storage.foldername(name))[1]
              AND auth.uid() = ANY(c.participant_ids)
        )
    );

DROP POLICY IF EXISTS "Participants can upload conversation media" ON storage.objects;
CREATE POLICY "Participants can upload conversation media" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'media' AND EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id::text = (storage.foldername(name))[1]
              AND auth.uid() = ANY(c.participant_ids)
        )
    );

-- Pliki medialne są niezmienne po wysłaniu (spójnie z triggerem na `messages`
-- powyżej) - brak polityk UPDATE/DELETE oznacza, że nikt (poza service_role
-- używanym przez administratora z panelu Supabase) nie może ich nadpisać ani
-- usunąć przez zwykłe zapytania klienta.

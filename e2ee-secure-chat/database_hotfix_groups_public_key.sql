-- KROK 1: Zobacz, jakie kolumny NAPRAWDĘ ma Twoja tabela `groups` w Supabase.
-- Uruchom TO NAJPIERW i wklej mi wynik, jeśli chcesz, żebym to zweryfikował
-- przed usunięciem czegokolwiek.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'groups'
ORDER BY ordinal_position;

-- KROK 2: Skoro `group_public_key` nie jest używane NIGDZIE w kodzie aplikacji
-- (ani w database.sql, ani w src/js/*.js) - to najpewniej pozostałość po
-- wcześniejszej, innej wersji tabeli `groups`. Najprostsza i najbezpieczniejsza
-- naprawa: usuń tę kolumnę całkowicie (tabela `groups` w tym projekcie ma być
-- tylko: id, name, creator_id, join_code, created_at).
ALTER TABLE public.groups DROP COLUMN IF EXISTS group_public_key;

-- Jeśli z jakiegoś powodu wolisz NIE usuwać kolumny (np. bo trzymasz w niej coś
-- celowo), alternatywa to tylko zdjęcie wymogu NOT NULL - ale wtedy kolumna
-- zostanie zawsze pusta dla grup tworzonych przez tę aplikację, bo nic jej nie
-- wypełnia:
-- ALTER TABLE public.groups ALTER COLUMN group_public_key DROP NOT NULL;

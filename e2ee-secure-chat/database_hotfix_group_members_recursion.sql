-- HOTFIX: "infinite recursion detected in policy for relation group_members"
--
-- Przyczyna: polityka SELECT na group_members odpytywała SAMĄ SIEBIE
-- (EXISTS (SELECT ... FROM group_members ...) wewnątrz polityki NA group_members).
-- Każda kontrola widoczności wiersza uruchamiała tę samą politykę od nowa -> rekurencja.
--
-- Rozwiązanie: standardowy wzorzec Postgres/Supabase - wynieść sprawdzenie
-- członkostwa do funkcji SECURITY DEFINER. Taka funkcja wykonuje swoje
-- zapytanie z uprawnieniami właściciela (pomijając RLS), więc nie wywołuje
-- ponownie polityki, którą sama pomaga ewaluować - rekurencja znika.

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.group_members
        WHERE group_id = p_group_id AND user_id = p_user_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION public.is_group_member(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS "Members can see fellow members" ON public.group_members;
CREATE POLICY "Members can see fellow members" ON public.group_members
    FOR SELECT USING (public.is_group_member(group_members.group_id, auth.uid()));

-- Polityka na `groups` nie odpytywała samej siebie (patrzy na group_members,
-- nie na groups), więc technicznie nie miała problemu z rekurencją - ale
-- warto ją też przepisać na tę samą funkcję: krócej i szybciej (jeden plan
-- zapytania zamiast osobnego EXISTS w każdej polityce).
DROP POLICY IF EXISTS "Members can read their groups" ON public.groups;
CREATE POLICY "Members can read their groups" ON public.groups
    FOR SELECT USING (public.is_group_member(groups.id, auth.uid()));

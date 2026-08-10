import { supabase } from './supabase.js';
import { AppState } from './state.js';
import { keyManager } from './auth.js';
import { GroupCrypto, saveGroupState, distributeOwnKeyTo } from './groupkeys.js';

export const groupCrypto = new GroupCrypto();

// Alfabet bez znaków łatwych do pomylenia (0/O, 1/I/L) - kod dołączenia jest
// przepisywany ręcznie przez drugą osobę, więc czytelność ma znaczenie.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomJoinCode(length = 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Tworzy grupę: wiersz `groups`, konwersację typu 'group', członkostwo twórcy, i własny Sender Key. */
export async function createGroup(name) {
    const userId = AppState.getUser().id;
    const mode = AppState.getMode();

    let group = null, lastErr = null;
    for (let attempt = 0; attempt < 5 && !group; attempt++) {
        const { data, error } = await supabase.from('groups')
            .insert({ name: name.trim(), creator_id: userId, join_code: randomJoinCode() })
            .select().single();
        if (!error) { group = data; break; }
        lastErr = error;
        if (error.code !== '23505') break; // błąd inny niż kolizja unikalności kodu - nie ma sensu ponawiać
    }
    if (!group) throw lastErr || new Error('Nie udało się utworzyć grupy.');

    const { data: conv, error: convErr } = await supabase.from('conversations').insert({
        participant_ids: [userId], created_by: userId, type: 'group', group_id: group.id
    }).select().single();
    if (convErr) throw convErr;

    const { error: memberErr } = await supabase.from('group_members').insert({ group_id: group.id, user_id: userId });
    if (memberErr) throw memberErr;

    await groupCrypto.initOwnChain(group.id);
    await saveGroupState(userId, group.id, mode, groupCrypto, keyManager.passwordKey);

    return { group, conversationId: conv.id };
}

/**
 * Dołącza do grupy po nazwie użytkownika twórcy + kodzie. Po dołączeniu:
 * generuje własny Sender Key i rozsyła go pairwise wszystkim OBECNYM
 * członkom (żeby mogli czytać moje nowe wiadomości). Klucze OBECNYCH
 * członków (żebym ja mógł czytać ICH nowe wiadomości) przyjdą do mnie
 * asynchronicznie — patrz ChatApp.subscribeToGroupJoins w chat.js, które
 * każe KAŻDEMU obecnemu członkowi wypchnąć mi swój klucz, gdy zobaczy moje
 * dołączenie na żywo (Realtime na group_members).
 */
export async function joinGroupByCode(creatorUsername, code) {
    const userId = AppState.getUser().id;
    const mode = AppState.getMode();

    const { data, error } = await supabase.rpc('join_group_by_code', {
        creator_username: creatorUsername.trim(),
        code: code.trim().toUpperCase()
    });
    if (error) throw new Error(error.message || 'Nie udało się dołączyć do grupy.');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Nie udało się dołączyć do grupy — sprawdź nazwę użytkownika i kod.');

    await groupCrypto.initOwnChain(row.group_id);
    await saveGroupState(userId, row.group_id, mode, groupCrypto, keyManager.passwordKey);

    const existingMembers = (row.existing_member_ids || []).filter(id => id !== userId);
    for (const memberId of existingMembers) {
        try {
            await distributeOwnKeyTo(row.group_id, mode, userId, memberId, groupCrypto, keyManager.identityVault);
        } catch (e) {
            console.warn('Nie udało się rozesłać własnego klucza grupowego do członka', memberId, e);
        }
    }

    return { groupId: row.group_id, groupName: row.group_name, conversationId: row.conversation_id };
}

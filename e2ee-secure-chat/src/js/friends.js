import { supabase } from './supabase.js';
import { AppState } from './state.js';

/** Wysyła prośbę o znajomość. Nicki są zapamiętane i zaaplikowane WYŁĄCZNIE u nadawcy po akceptacji. */
export async function sendFriendRequest(username, realNickname, fakeNickname) {
    const { data: targetUser, error: findErr } = await supabase.from('users').select('id, username').eq('username', username.trim()).maybeSingle();
    if (findErr) throw findErr;
    if (!targetUser) throw new Error('Nie znaleziono użytkownika o takiej nazwie.');
    if (targetUser.id === AppState.getUser().id) throw new Error('Nie możesz wysłać prośby do samego siebie.');

    const { error } = await supabase.from('friend_requests').insert({
        from_user_id: AppState.getUser().id,
        to_user_id: targetUser.id,
        real_nickname: realNickname?.trim() || null,
        fake_nickname: fakeNickname?.trim() || null
    });
    if (error) {
        if (error.code === '23505') throw new Error('Prośba do tej osoby została już wysłana.');
        throw error;
    }
}

export async function listIncomingFriendRequests() {
    const { data, error } = await supabase.from('friend_requests')
        .select('*, from_user:from_user_id(username, avatar_url)')
        .eq('to_user_id', AppState.getUser().id)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function listOutgoingFriendRequests() {
    const { data, error } = await supabase.from('friend_requests')
        .select('*, to_user:to_user_id(username, avatar_url)')
        .eq('from_user_id', AppState.getUser().id)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function acceptFriendRequest(requestId) {
    const { error } = await supabase.rpc('accept_friend_request', { request_id: requestId });
    if (error) throw new Error(error.message || 'Nie udało się zaakceptować prośby.');
}

/** Działa zarówno na odrzucenie otrzymanej prośby, jak i cofnięcie własnej wysłanej — obie strony mogą usunąć wiersz. */
export async function declineOrCancelFriendRequest(requestId) {
    const { error } = await supabase.from('friend_requests').delete().eq('id', requestId);
    if (error) throw error;
}

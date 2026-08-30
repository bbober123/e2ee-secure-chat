/**
 * chat/group-friend-actions.js — akcje wywoływane z UI: tworzenie/dołączanie do
 * grup oraz wysyłanie/akceptowanie/odrzucanie próśb o znajomość.
 */
import { UI } from '../ui.js';
import { createGroup, joinGroupByCode } from '../groups.js';
import { sendFriendRequest, listIncomingFriendRequests, listOutgoingFriendRequests, acceptFriendRequest, declineOrCancelFriendRequest } from '../friends.js';

export const GroupFriendActionsMixin = {
    // -----------------------------------------------------------------
    // Akcje wywoływane z UI: grupy i prośby o znajomość
    // -----------------------------------------------------------------

    async createGroupAction(name) {
        if (!name || !name.trim()) return;
        try {
            const { group } = await createGroup(name);
            UI.showToast(`Grupa "${group.name}" utworzona! Kod dołączenia: ${group.join_code}`, 'success');
            UI.closeAllMenusAndModals();
            await this.loadConversations();
        } catch (e) {
            console.error(e);
            UI.showToast(e.message || 'Nie udało się utworzyć grupy.', 'error');
        }
    },

    async joinGroupAction(creatorUsername, code) {
        if (!creatorUsername || !code) return;
        try {
            const { groupName } = await joinGroupByCode(creatorUsername, code);
            UI.showToast(`Dołączono do grupy "${groupName}"!`, 'success');
            UI.closeAllMenusAndModals();
            await this.loadConversations();
        } catch (e) {
            console.error(e);
            UI.showToast(e.message || 'Nie udało się dołączyć do grupy.', 'error');
        }
    },

    async sendFriendRequestAction(username, realNick, fakeNick) {
        if (!username) return;
        try {
            await sendFriendRequest(username, realNick, fakeNick);
            UI.showToast('Prośba o znajomość wysłana!', 'success');
            UI.closeAllMenusAndModals();
        } catch (e) {
            UI.showToast(e.message || 'Nie udało się wysłać prośby.', 'error');
        }
    },

    async openFriendRequestsModal() {
        try {
            const [incoming, outgoing] = await Promise.all([listIncomingFriendRequests(), listOutgoingFriendRequests()]);
            UI.renderFriendRequests(incoming, outgoing);
            UI.showModal('friend-requests-modal');
        } catch (e) {
            UI.showToast('Nie udało się wczytać próśb o znajomość.', 'error');
        }
    },

    async acceptFriendRequestAction(requestId) {
        try {
            await acceptFriendRequest(requestId);
            UI.showToast('Znajomość zaakceptowana!', 'success');
            await this.loadContacts();
            await this.loadConversations();
            await this.refreshFriendRequestsBadge();
            await this.openFriendRequestsModal();
        } catch (e) {
            UI.showToast(e.message || 'Nie udało się zaakceptować prośby.', 'error');
        }
    },

    async declineFriendRequestAction(requestId) {
        try {
            await declineOrCancelFriendRequest(requestId);
            await this.refreshFriendRequestsBadge();
            await this.openFriendRequestsModal();
        } catch (e) {
            UI.showToast('Nie udało się usunąć prośby.', 'error');
        }
    },
};

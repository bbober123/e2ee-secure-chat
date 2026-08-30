/**
 * ui/skeletons.js — placeholdery ładowania (shimmer) dla listy rozmów i wiadomości,
 * pokazywane od razu, zanim dane dotrą z serwera.
 */
export const SkeletonsUI = {
    renderConversationsSkeleton(count = 5) {
        const list = document.getElementById('conversations-list');
        let html = '';
        for (let i = 0; i < count; i++) {
            html += `
                <div class="skel-conv">
                    <div class="skeleton skel-avatar"></div>
                    <div class="skel-lines">
                        <div class="skeleton skel-line w60"></div>
                        <div class="skeleton skel-line w40"></div>
                    </div>
                </div>`;
        }
        list.innerHTML = html;
    },

    renderMessagesSkeleton(count = 6) {
        const container = document.getElementById('messages-container');
        let html = '';
        for (let i = 0; i < count; i++) {
            const w = ['85%', '55%', '70%', '40%', '60%', '90%'][i % 6];
            html += `
                <div class="skel-msg">
                    <div class="skeleton skel-avatar"></div>
                    <div class="skel-lines">
                        <div class="skeleton skel-line" style="width:30%"></div>
                        <div class="skeleton skel-line" style="width:${w}"></div>
                    </div>
                </div>`;
        }
        container.innerHTML = html;
    },
};

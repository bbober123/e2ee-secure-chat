/**
 * ui/typing.js — wskaźnik "X pisze..." w nagłówku czatu i na liście rozmów.
 */
export const TypingUI = {
    showTypingIndicator(name) {
        const typingEl = document.getElementById('chat-typing-status');
        const e2eeEl = document.getElementById('chat-e2ee-status');
        if (!typingEl) return;
        document.getElementById('chat-typing-name').textContent = `${name} pisze...`;
        typingEl.classList.add('visible');
        e2eeEl.classList.add('hidden-by-typing');
    },

    hideTypingIndicator() {
        const typingEl = document.getElementById('chat-typing-status');
        const e2eeEl = document.getElementById('chat-e2ee-status');
        if (!typingEl) return;
        typingEl.classList.remove('visible');
        e2eeEl.classList.remove('hidden-by-typing');
    },

    /** Odznacza w liście rozmów, że kontakt aktualnie pisze (zielony tekst zamiast ostatniej wiadomości). */
    setConversationTyping(convId, isTyping) {
        const item = document.querySelector(`.conv-item[data-conv-id="${convId}"] .conv-msg`);
        if (!item) return;
        if (isTyping) {
            item.dataset.originalText = item.dataset.originalText ?? item.textContent;
            item.textContent = 'pisze...';
            item.classList.add('is-typing');
        } else {
            item.classList.remove('is-typing');
            if (item.dataset.originalText !== undefined) item.textContent = item.dataset.originalText;
        }
    },
};

/**
 * casino/bet-input.js — mały, współdzielony helper renderujący pole
 * "własna kwota" obok gotowych żetonów. Używany w ruletce, blackjacku
 * (solo) i automatach, żeby zachowanie było identyczne wszędzie.
 *
 * Użycie:
 *   1. W render(): renderBetInput(currentValue, isCustom, disabled)
 *      wstawia HTML pola.
 *   2. Po wstrzyknięciu HTML do DOM: wireBetInput(container, (amount) => {...})
 *      podpina Enter/klik "Ustaw" i woła callback z wpisaną kwotą.
 */

export function renderBetInput(currentValue, isCustom, disabled) {
    return `
        <span class="roulette-custom-chip ${isCustom ? 'chip-selected' : ''}">
            <input type="number" class="bet-custom-input" min="1" step="1" placeholder="własna"
                   value="${isCustom && currentValue ? currentValue : ''}" ${disabled ? 'disabled' : ''}>
            <button class="btn-cancel bet-custom-apply" ${disabled ? 'disabled' : ''}>Ustaw</button>
        </span>`;
}

export function wireBetInput(container, onApply) {
    const apply = () => {
        const input = container.querySelector('.bet-custom-input');
        const val = Math.floor(Number(input?.value));
        if (!val || val < 1) return;
        onApply(val);
    };
    container.querySelector('.bet-custom-apply')?.addEventListener('click', apply);
    container.querySelector('.bet-custom-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });
}

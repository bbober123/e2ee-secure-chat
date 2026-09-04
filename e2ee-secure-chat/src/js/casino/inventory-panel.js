/**
 * casino/inventory-panel.js — widok "Ekwipunek": lista przedmiotów
 * zachowanych ze skrzynek (max. 30), z przyciskami Sprzedaj i Pochwal się.
 */
import { Inventory, MAX_INVENTORY } from './inventory.js';
import { Wallet } from './wallet.js';
import { WEAPON_ICON, rarityById } from './weapon-icons.js';
export class InventoryPanel {
    constructor(container) {
        this.el = container;
        this.loading = true;
    }

    stop() {}

    async start() {
        this.loading = true;
        this.render();
        await Inventory.load();
        this.loading = false;
        this.render();
    }

    async sell(itemId) {
        const btn = this.el.querySelector(`[data-sell="${itemId}"]`);
        if (btn) btn.disabled = true;
        const newBalance = await Inventory.sell(itemId);
        if (newBalance === null) {
            const { UI } = await import('../ui.js');
            UI.showToast('Nie udało się sprzedać przedmiotu.', 'error');
            if (btn) btn.disabled = false;
            return;
        }
        Wallet.balance = newBalance;
        this.render();
    }

    async share(item) {
        const { Casino } = await import('../casino.js');
        await Casino.shareItemToChat(item);
    }

    render() {
        const items = Inventory.items;
        this.el.innerHTML = `
            <div class="inventory-panel">
                <div class="inventory-header">
                    <span>Ekwipunek: <strong>${items.length} / ${MAX_INVENTORY}</strong></span>
                </div>
                ${this.loading ? '<div class="inventory-empty">Wczytywanie…</div>' : ''}
                ${!this.loading && items.length === 0 ? `
                    <div class="inventory-empty">
                        Pusto. Otwórz kilka 📦 Skrzynek i wybierz "Zachowaj" zamiast sprzedawać od razu,
                        żeby przedmioty trafiły tutaj.
                    </div>` : ''}
                ${!this.loading && items.length > 0 ? `
                    <div class="inventory-grid">
                        ${items.map(item => this._itemHtml(item)).join('')}
                    </div>` : ''}
            </div>`;

        this.el.querySelectorAll('[data-sell]').forEach(btn => {
            btn.addEventListener('click', () => this.sell(btn.dataset.sell));
        });
        this.el.querySelectorAll('[data-share]').forEach(btn => {
            const item = items.find(i => i.id === btn.dataset.share);
            btn.addEventListener('click', () => this.share(item));
        });
    }

    _itemHtml(item) {
        const rarity = rarityById(item.rarity_id);
        const icon = item.icon_snapshot || WEAPON_ICON[item.weapon_key] || '🔫';
        return `
            <div class="inventory-item" style="border-color:${rarity.color}">
                <div class="inventory-item-icon" style="color:${rarity.color}">${icon}</div>
                <div class="inventory-item-name" style="color:${rarity.color}">${item.item_name}</div>
                <div class="inventory-item-meta">${rarity.label} · ${item.case_title || ''}</div>
                <div class="inventory-item-value">${item.value} 🪙</div>
                <div class="inventory-item-actions">
                    <button class="btn-cancel inventory-share-btn" data-share="${item.id}">📣 Pochwal się</button>
                    <button class="btn-cancel inventory-sell-btn" data-sell="${item.id}">Sprzedaj</button>
                </div>
            </div>`;
    }
}

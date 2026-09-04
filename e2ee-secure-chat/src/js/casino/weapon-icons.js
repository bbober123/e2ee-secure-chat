/**
 * casino/weapon-icons.js — ikony broni (darmowe, licencja CC BY 3.0,
 * https://game-icons.net - NIE są to obrazy/skiny z CS:GO) i definicje
 * rzadkości, współdzielone między otwieraniem skrzynek a ekwipunkiem.
 * Wymóg licencji ikon: wzmianka o autorach - patrz
 * src/assets/weapon-icons/ATTRIBUTION.txt.
 */
import iconAk47 from '../../assets/weapon-icons/ak47.svg?raw';
import iconM4 from '../../assets/weapon-icons/m4.svg?raw';
import iconAwp from '../../assets/weapon-icons/awp.svg?raw';
import iconDeagle from '../../assets/weapon-icons/deagle.svg?raw';
import iconUsp from '../../assets/weapon-icons/usp.svg?raw';
import iconKarambit from '../../assets/weapon-icons/karambit.svg?raw';
import iconGlock from '../../assets/weapon-icons/glock.svg?raw';
import iconP90 from '../../assets/weapon-icons/p90.svg?raw';
import iconMp7 from '../../assets/weapon-icons/mp7.svg?raw';
import iconFiveseven from '../../assets/weapon-icons/fiveseven.svg?raw';
import iconButterfly from '../../assets/weapon-icons/butterfly-knife.svg?raw';
import iconGloves from '../../assets/weapon-icons/gloves.svg?raw';
import iconMac10 from '../../assets/weapon-icons/mac10.svg?raw';
import iconSawedoff from '../../assets/weapon-icons/sawedoff.svg?raw';
import iconNegev from '../../assets/weapon-icons/negev.svg?raw';
import iconP250 from '../../assets/weapon-icons/p250.svg?raw';
import iconBayonet from '../../assets/weapon-icons/bayonet.svg?raw';
import iconGutknife from '../../assets/weapon-icons/gutknife.svg?raw';
import iconStiletto from '../../assets/weapon-icons/stiletto.svg?raw';
import iconUrsus from '../../assets/weapon-icons/ursus.svg?raw';
import iconBoxingglove from '../../assets/weapon-icons/boxingglove.svg?raw';

export const WEAPON_ICON = {
    'AK-47': iconAk47, 'M4A4': iconM4, 'AWP': iconAwp, 'Desert Eagle': iconDeagle,
    'USP': iconUsp, 'Karambit': iconKarambit, 'Glock-18': iconGlock, 'P90': iconP90,
    'M4A1-S': iconM4, 'MP7': iconMp7, 'Five-SeveN': iconFiveseven, 'Butterfly': iconButterfly,
    'MAC-10': iconMac10, 'Sawed-Off': iconSawedoff, 'Negev': iconNegev, 'P250': iconP250,
    'Bayonet': iconBayonet, 'Gut Knife': iconGutknife, 'Stiletto': iconStiletto,
    'Ursus': iconUrsus, 'Rękawice Bojowe': iconBoxingglove, 'Rękawice': iconGloves
};

// Wagi = dokładnie te same procenty, jakie Valve oficjalnie ujawniło dla
// szans na rzadkość w skrzynkach CS:GO/CS2 (Mil-Spec 79.92% / Restricted
// 15.98% / Classified 3.2% / Covert 0.64% / Rzadkie-Złote 0.26%) — suma
// = 100, więc `weight` można czytać wprost jako procent. To publiczna,
// jawna informacja liczbowa, nie grafika ani cudzy kod, więc mogę jej
// użyć - ale same przedmioty/nazwy są własne.
export const RARITIES = [
    { id: 'mil-spec', label: 'Mil-Spec', color: '#4b69ff', weight: 79.92 },
    { id: 'restricted', label: 'Restricted', color: '#8847ff', weight: 15.98 },
    { id: 'classified', label: 'Classified', color: '#d32ce6', weight: 3.2 },
    { id: 'covert', label: 'Covert', color: '#eb4b4b', weight: 0.64 },
    { id: 'rare-gold', label: 'Rzadkie Złoto', color: '#ffd700', weight: 0.26 }
];

export function rarityById(id) {
    return RARITIES.find(r => r.id === id) || RARITIES[0];
}

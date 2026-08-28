const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const apiSource = read('api/game-deals.js')
    .replace("import { guard } from './_guard.js';", 'const guard = () => false;')
    .replace('export default async function handler', 'async function handler')
    + '\nthis.__deals = { extractSteamPromoText, buildSteamDeal, mergeDeals };';
const apiContext = vm.createContext({ console, URLSearchParams, encodeURIComponent });
vm.runInContext(apiSource, apiContext, { filename: 'api/game-deals.js' });

const dealTools = apiContext.__deals;
const humankind = dealTools.buildSteamDeal('1124300', {
    1124300: {
        success: true,
        data: {
            name: 'HUMANKIND™',
            is_free: false,
            price_overview: { currency: 'EUR', initial: 4999, final: 499, discount_percent: 90 }
        }
    }
}, "L'offre prend fin le 8 septembre");
assert.strictEqual(humankind.deal.shop, 'Steam');
assert.strictEqual(humankind.deal.price, 4.99);
assert.strictEqual(humankind.deal.regular, 49.99);
assert.strictEqual(humankind.deal.cut, 90);
assert.strictEqual(humankind.deal.promoEnds, "L'offre prend fin le 8 septembre");

assert.strictEqual(dealTools.extractSteamPromoText(
    '<p class="game_purchase_discount_countdown">OFFRE DU JOUR ! L\'offre prend fin le 8 septembre</p>'
), "OFFRE DU JOUR ! L'offre prend fin le 8 septembre");

const manyItadDeals = Array.from({ length: 9 }, (_value, index) => ({
    shop: index === 0 ? 'Steam' : `Boutique ${index}`,
    price: index + 1,
    regular: index + 2
}));
const merged = dealTools.mergeDeals(manyItadDeals, humankind, 8);
assert.strictEqual(merged.length, 8);
assert.strictEqual(merged.filter(deal => deal.shop === 'Steam').length, 1, 'Steam must be deduplicated');
assert(merged.some(deal => deal === humankind.deal), 'The direct Steam offer must survive the top-offer limit');

const coreSource = read('core.js') + '\nthis.__dealPromotionLabel = dealPromotionLabel;';
const coreContext = vm.createContext({ console, URL, Date, Math, Promise, Set, Map });
vm.runInContext(coreSource, coreContext, { filename: 'core.js' });
assert.strictEqual(coreContext.__dealPromotionLabel(humankind.deal), "L'offre prend fin le 8 septembre");
assert(/^Promo jusqu’au /.test(coreContext.__dealPromotionLabel({ expiry: '2026-09-08T17:00:00Z' })));

const desktop = read('newScript.js');
const mobile = read('mobile.js');
const desktopHtml = read('desktop.html');
const mobileHtml = read('m.html');
assert(/waiting-install__compare/.test(desktop) && /openGameDetails\(game\.name\)/.test(desktop),
    'The closed-vote desktop checklist must expose the comparator');
assert(/À INSTALLER OU ACHETER/.test(desktopHtml));
assert(/votesAreClosed[\s\S]{0,650}Comparer les prix/.test(mobile),
    'The closed-vote mobile home must lead players to the comparator');
assert(/function gameDeals/.test(mobile) && /m-deals__expiry/.test(mobile),
    'Mobile game sheets must render multi-store offers and promotion deadlines');
assert(/GAME_PRICE_CLIENT_TTL/.test(desktop) && /GAME_PRICE_CLIENT_TTL/.test(mobile),
    'Long-lived tabs must eventually refresh Steam prices and promotions');
assert(/expiry: deal\.expiry \|\| null/.test(read('api/game-deals.js')),
    'ITAD promotion expiry must not be dropped');
assert(/20260828-tcg-vote-rarities/.test(desktopHtml)
    && /20260828-tcg-vote-rarities/.test(mobileHtml), 'Comparator assets need the current cache tag');

console.log('Price comparator checks passed (Steam, ITAD expiry, desktop and mobile).');

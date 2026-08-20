/* ==========================================================================
   LES SONS DE L'OUVERTURE
   Partagé par les deux interfaces, comme core.js — mais pour une autre raison.
   core.js est partagé parce qu'un score doit se calculer pareil partout ; ceci
   l'est parce qu'il n'y a aucune raison qu'un booster sonne différemment sur
   PC et sur téléphone, et qu'un synthétiseur dupliqué en deux exemplaires
   dériverait à la première retouche.

   Tout est SYNTHÉTISÉ : pas un seul fichier audio. Trois raisons — rien à
   héberger, rien à charger avant de jouer le son, et aucun domaine à ajouter à
   la CSP. Un « ding » de rareté, c'est trois oscillateurs et une enveloppe.

   Le vocabulaire est celui de Balatro : des sons courts, secs, très lisibles,
   qui montent en intensité avec ce qui arrive. Une commune fait « tic », une
   Signature fait une cascade — et on doit pouvoir les distinguer les yeux
   fermés.
   ========================================================================== */

const Sfx = (function () {
    const STORE_KEY = 'lan-demain:sfx';
    let ctx = null;
    let master = null;
    let muted = false;

    try {
        muted = localStorage.getItem(STORE_KEY) === 'off';
    } catch (_e) {
        // Navigation privée stricte : on garde le son, ce n'est pas critique.
    }

    /* Le contexte audio ne peut naître que d'un geste de l'utilisateur : les
       navigateurs refusent de jouer quoi que ce soit avant. On le crée donc au
       premier clic, et on le réveille à chaque fois — iOS le suspend dès que
       l'onglet passe en arrière-plan. */
    function wake() {
        if (muted) return null;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        if (!ctx) {
            ctx = new Ctor();
            master = ctx.createGain();
            master.gain.value = 0.32;
            master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function isEnabled() { return !muted; }

    function toggle() {
        muted = !muted;
        try { localStorage.setItem(STORE_KEY, muted ? 'off' : 'on'); } catch (_e) { /* tant pis */ }
        if (!muted) wake();
        return !muted;
    }

    /* Un grain de bruit blanc, la matière première de tout ce qui « frotte » :
       la déchirure, le souffle, le claquement d'une carte. */
    function noise(seconds) {
        const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }

    /* Une note. `glide` la fait monter ou descendre pendant sa durée, ce qui
       suffit à transformer un bip en « zioup ». */
    function tone(options) {
        const o = options || {};
        const at = ctx.currentTime + (o.at || 0);
        const dur = o.dur || 0.12;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = o.type || 'triangle';
        osc.frequency.setValueAtTime(o.freq, at);
        if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, at + dur);

        // Enveloppe exponentielle : une attaque franche et une queue qui meurt.
        // Jamais zéro, exponentialRamp l'interdit.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(o.gain || 0.2, at + (o.attack || 0.008));
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

        osc.connect(gain).connect(master);
        osc.start(at);
        osc.stop(at + dur + 0.03);
    }

    /* Un souffle : du bruit passé dans un filtre dont la fréquence bouge.
       Monte pour une déchirure, descend pour un rangement. */
    function whoosh(options) {
        const o = options || {};
        const at = ctx.currentTime + (o.at || 0);
        const dur = o.dur || 0.3;

        const source = ctx.createBufferSource();
        source.buffer = noise(dur);

        const filter = ctx.createBiquadFilter();
        filter.type = o.type || 'bandpass';
        filter.Q.value = o.q || 1.2;
        filter.frequency.setValueAtTime(o.from || 400, at);
        filter.frequency.exponentialRampToValueAtTime(o.to || 3000, at + dur);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(o.gain || 0.18, at + Math.min(0.05, dur * 0.25));
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

        source.connect(filter).connect(gain).connect(master);
        source.start(at);
        source.stop(at + dur + 0.03);
    }

    /* Des étincelles : quelques bips très courts et très aigus, semés au
       hasard. C'est ce qui fait « précieux » plutôt que « fort ». */
    function sparkle(count, spread, gain) {
        for (let i = 0; i < count; i++) {
            tone({
                freq: 1400 + Math.random() * 2600,
                type: 'sine',
                at: Math.random() * spread,
                dur: 0.07,
                gain: gain || 0.06
            });
        }
    }

    /* Gamme pentatonique : n'importe quelle suite de ces notes sonne juste, ce
       qui évite d'avoir à accorder chaque rareté à la main. */
    const SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5];

    /* Ce que chaque rareté joue. Le nombre de notes, la brillance et le poids
       montent ensemble : on doit reconnaître une Signature sans regarder. */
    const STINGS = {
        common: { notes: 1, gain: 0.13, sparkle: 0, boom: false },
        uncommon: { notes: 2, gain: 0.15, sparkle: 0, boom: false },
        rare: { notes: 3, gain: 0.17, sparkle: 4, boom: false },
        epic: { notes: 4, gain: 0.2, sparkle: 8, boom: true },
        showcase: { notes: 5, gain: 0.22, sparkle: 12, boom: true },
        signature: { notes: 6, gain: 0.24, sparkle: 18, boom: true }
    };

    return {
        wake,
        isEnabled,
        toggle,

        /* Le doigt entaille l'emballage. Appelé par crans pendant le
           glissement : chaque cran est un petit craquement, et l'ensemble fait
           le bruit d'une fermeture qu'on ouvre. */
        cut(progress) {
            if (!wake()) return;
            whoosh({
                dur: 0.06,
                from: 900 + progress * 2200,
                to: 1600 + progress * 3400,
                q: 3.5,
                gain: 0.09 + progress * 0.06
            });
        },

        /* L'emballage cède : un claquement sec, un souffle qui monte, et une
           basse qui donne le poids du paquet qui s'ouvre. */
        packOpen() {
            if (!wake()) return;
            whoosh({ dur: 0.42, from: 320, to: 5200, q: 0.9, gain: 0.26 });
            tone({ freq: 90, glide: 42, type: 'sine', dur: 0.5, gain: 0.3 });
            tone({ freq: 660, glide: 1320, type: 'triangle', at: 0.05, dur: 0.25, gain: 0.12 });
            sparkle(10, 0.35, 0.05);
        },

        /* La carte se retourne : un tic de carton, rien de plus. Il sonne
           quatorze fois par booster, il a intérêt à être discret. */
        flip() {
            if (!wake()) return;
            whoosh({ dur: 0.055, from: 2600, to: 900, q: 2.2, gain: 0.13, type: 'bandpass' });
        },

        /* La carte est retournée : le son qui dit ce qu'on vient de sortir. */
        reveal(rarity) {
            if (!wake()) return;
            const sting = STINGS[rarity] || STINGS.common;

            for (let i = 0; i < sting.notes; i++) {
                tone({
                    freq: SCALE[i],
                    type: i === sting.notes - 1 ? 'triangle' : 'sine',
                    at: i * 0.055,
                    dur: i === sting.notes - 1 ? 0.42 : 0.13,
                    gain: sting.gain
                });
            }

            // Les raretés du haut posent une basse sous la cascade : c'est elle
            // qu'on sent dans la poitrine, pas les aigus.
            if (sting.boom) {
                tone({ freq: 130, glide: 65, type: 'sine', dur: 0.6, gain: 0.26 });
            }
            if (sting.sparkle) {
                sparkle(sting.sparkle, 0.45, 0.055);
            }
        },

        /* On range le paquet : les cartes filent et retombent en pile. */
        gather() {
            if (!wake()) return;
            whoosh({ dur: 0.34, from: 3200, to: 420, q: 1, gain: 0.2 });
            tone({ freq: 160, glide: 80, type: 'sine', at: 0.24, dur: 0.24, gain: 0.22 });
        }
    };
})();

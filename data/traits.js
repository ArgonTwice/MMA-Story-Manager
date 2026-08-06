/**
 * data/traits.js
 * ---------------------------------------------------------------------------
 * UI-only presentation metadata for Fighter personality traits: which of
 * web/style.css's badge colors each trait renders with on the Fighter
 * Profile view, plus a short one-line French blurb for a subtitle/tooltip.
 * Keyed by the SAME keys as BALANCE.PERSONALITY.TRAITS — data/balance.js
 * remains the single source of truth for what a trait actually DOES to
 * gameplay (fatigueMultiplier, salaryDemandMultiplier, moraleVolatility,
 * progressionMultiplier, activityWeights). This file only decides how a
 * trait LOOKS; it is never read by any engine.
 * ---------------------------------------------------------------------------
 */

export const TRAIT_DISPLAY = Object.freeze({
  Professionnel: { color: 'blue', description: "Se prepare serieusement, fatigue moins vite." },
  Fetard: { color: 'orange', description: 'Aime la fete — moral volatile, fatigue plus vite.' },
  Impulsif: { color: 'red', description: 'Agit sur un coup de tete — moral tres volatile.' },
  Provocateur: { color: 'red', description: 'Aime chauffer ses adversaires — moral volatile.' },
  Discipline: { color: 'blue', description: "Rigoureux a l'entrainement — progresse plus vite." },
  Loyal: { color: 'green', description: 'Fidele a son gym — exigences salariales reduites.' },
  Arrogant: { color: 'orange', description: 'Sur de lui — exigences salariales elevees.' },
  Humble: { color: 'green', description: 'Reste modeste — facile a negocier.' },
  Genereux: { color: 'green', description: "Peu interesse par l'argent." },
  Intense: { color: 'red', description: "S'entraine a fond — fatigue vite, progresse vite." },
  Calme: { color: 'blue', description: 'Flegmatique — moral tres stable.' },
  Ambitieux: { color: 'gold', description: 'Vise toujours plus haut — exigeant mais motive.' },
});

/**
 * @param {string} traitKey - One of Object.keys(BALANCE.PERSONALITY.TRAITS).
 * @returns {{ color: string, description: string }} Falls back to a neutral
 *   blue badge with no description for any trait this file hasn't been
 *   updated to cover yet (e.g. a future trait added only to balance.js).
 */
export function getTraitDisplay(traitKey) {
  return TRAIT_DISPLAY[traitKey] ?? { color: 'blue', description: '' };
}

export default TRAIT_DISPLAY;

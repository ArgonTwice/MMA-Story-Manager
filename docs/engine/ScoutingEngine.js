/**
 * engine/ScoutingEngine.js
 * ---------------------------------------------------------------------------
 * Turns an opponent's REAL (but never player-visible) skills/style/
 * personality/career into a handful of qualitative "Rapport de Scouting"
 * lines — the pre-fight uncertainty layer: the player sees "Fort en
 * Grappling" or "Agressif des le R1", never the opponent's exact skill
 * numbers, Readiness, or Overall rating (see ui/FightNightView.js's fight
 * card, which now calls this instead of exposing Coin B's raw stats, and
 * web/app.js's fight-setup screen, which no longer lets the player see —
 * or set — the opponent's gameplan).
 *
 * Pure and read-only: reads a Fighter instance, returns plain strings.
 * Never mutates, never rolls dice — the SAME opponent always produces the
 * SAME report, because scouting a real fighter's tape doesn't get luckier
 * on a second viewing. The "incertitude" in "sous incertitude" comes from
 * what's withheld (no numbers, no gameplan), not from randomized accuracy.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

const SKILL_LABELS = Object.freeze({
  boxe: 'Boxe',
  jambes: 'Jeu de jambes',
  sol: 'Grappling',
  soumission: 'Soumissions',
  cardio: 'Cardio',
  intelligence: 'Lecture du combat',
});

/** High/low observation text per skill — the low-intelligence line doubles as "weak head defense," the closest honest proxy this codebase has for that concept (no fighter carries a literal defense stat). */
const SKILL_OBSERVATIONS = Object.freeze({
  boxe: { high: 'Frappes de poing puissantes', low: 'Frappes de poing peu precises' },
  jambes: { high: 'Low-kicks dangereux', low: 'Jeu de jambes limite' },
  sol: { high: 'Excellent lutteur, cherche le sol dans les moments difficiles', low: 'Vulnerable une fois amene au sol' },
  soumission: { high: 'Danger permanent des qu\'un combat passe au sol', low: 'Peu de menace en soumission' },
  cardio: { high: 'Gros moteur, tient la distance sur la duree', low: 'Cardio fragile, s\'essouffle en fin de combat' },
  intelligence: { high: 'Tres bonne lecture du combat, difficile a piegeur', low: 'Defense de tete parfois relachee' },
});

const DISTANCE_LABELS = Object.freeze({ STRIKING: 'la frappe debout', CLINCH: 'le clinch', GROUND: 'le sol' });

const TRAIT_SCOUTING_LINES = Object.freeze({
  Agressif: 'Agressif des le debut du combat, impose le rythme immediatement',
  Calme: 'Reste mesure, ne se precipite jamais',
  Provocateur: 'Cherche a destabiliser mentalement son adversaire',
  Discipline: 'Execution methodique, rarement pris de vitesse',
  Intense: 'Rythme tres eleve du premier au dernier round',
  Paresseux: 'Depart parfois lent, monte en puissance progressivement',
  Frimeur: 'Prend des risques pour le spectacle',
  Introverti: 'Combattant discret, laisse peu paraitre ses intentions',
  Loyal: 'Se bat avec la niaque pour son gym',
  Toxique: 'Instable, peut se desengager mentalement en cas de coup dur',
});

const ARCHETYPE_SCOUTING_LINES = Object.freeze({
  Predateur: 'Predateur : sent la faiblesse et enchaine des qu\'un adversaire vacille',
  Guerrier: 'Guerrier : ne recule devant rien, encaisse pour avancer',
  Showman: 'Showman : joue pour le public, parfois au detriment de la prudence',
  Veteran: 'Veteran : gere son combat avec l\'experience du nombre',
  Phenomene: 'Phenomene : talent brut au-dessus de la moyenne',
  Genie: 'Genie tactique : adapte son plan de jeu en temps reel',
});

/** @param {number} value @param {number} threshold */
function isNotably(value, threshold, aboveOrBelow) {
  return aboveOrBelow === 'above' ? value >= threshold : value <= threshold;
}

/**
 * Builds a short, qualitative scouting report for one fighter — meant to
 * describe an OPPONENT the player hasn't trained personally, never the
 * player's own roster fighter (who they already know in full detail).
 *
 * @param {Object} fighter - A Fighter instance.
 * @returns {string[]} 3-5 short French observations, most notable first.
 */
export function generateScoutingReport(fighter) {
  const lines = [];
  const skills = fighter.attributes.skills;
  const cfg = BALANCE.PROGRESSION;
  const highThreshold = cfg.SKILL_MAX * 0.7;
  const lowThreshold = cfg.SKILL_MAX * 0.35;

  const skillEntries = Object.entries(skills);
  const strongest = skillEntries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  const weakest = skillEntries.reduce((worst, entry) => (entry[1] < worst[1] ? entry : worst));

  if (isNotably(strongest[1], highThreshold, 'above')) {
    lines.push(`Fort en ${SKILL_LABELS[strongest[0]]} — ${SKILL_OBSERVATIONS[strongest[0]].high}`);
  }
  if (weakest[0] !== strongest[0] && isNotably(weakest[1], lowThreshold, 'below')) {
    lines.push(`Faible en ${SKILL_LABELS[weakest[0]]} — ${SKILL_OBSERVATIONS[weakest[0]].low}`);
  }

  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[fighter.identity.style];
  if (styleBonus?.distance) {
    lines.push(`Excelle dans ${DISTANCE_LABELS[styleBonus.distance]} (style ${fighter.identity.style})`);
  }

  const { archetype, traits } = fighter.psychology.personality;
  if (ARCHETYPE_SCOUTING_LINES[archetype]) lines.push(ARCHETYPE_SCOUTING_LINES[archetype]);
  for (const trait of traits) {
    if (TRAIT_SCOUTING_LINES[trait]) lines.push(TRAIT_SCOUTING_LINES[trait]);
  }

  if (fighter.career.finishes >= 3 && fighter.career.wins > 0 && fighter.career.finishes / fighter.career.wins >= 0.6) {
    lines.push('Finisseur : cherche activement le KO/la soumission plutot que d\'aller aux points');
  } else if (fighter.career.decisionWins >= 3 && fighter.career.wins > 0 && fighter.career.decisionWins / fighter.career.wins >= 0.6) {
    lines.push('Combattant patient : gagne surtout aux points, joue la carte de la duree');
  }

  if (lines.length === 0) {
    lines.push('Profil equilibre, aucune tendance nette ne ressort de l\'analyse video.');
  }

  return lines.slice(0, 5);
}

export default { generateScoutingReport };

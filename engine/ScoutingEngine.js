/**
 * engine/ScoutingEngine.js
 * ---------------------------------------------------------------------------
 * Two related but distinct halves, both about withholding certainty:
 *
 *   1. Opponent scouting (generateScoutingReport): turns a FIGHT OPPONENT's
 *      real skills/style/personality/career into a handful of qualitative
 *      "Rapport de Scouting" lines — "Fort en Grappling", never the exact
 *      skill numbers, Readiness, or Overall rating (see
 *      ui/FightNightView.js's fight card, and web/app.js's fight-setup
 *      screen, which no longer lets the player see — or set — the
 *      opponent's gameplan).
 *
 *   2. Prospect Fog of War (estimateFighterSkills/getRevealedTraits): a
 *      RECRUITMENT-MARKET PROSPECT's exact stats/hidden traits are
 *      estimated rather than shown outright, resolving toward the truth
 *      the longer they've trained at the gym (Fighter#weeksAtGym) and the
 *      better the Head Coach scouting them (engine/StaffEngine.js#getScoutingCompetence).
 *
 * Both halves are pure and read-only: reads a Fighter instance, returns
 * plain data, never mutates, never rolls dice — the SAME fighter always
 * produces the SAME report/estimate for the SAME inputs, because scouting
 * a real fighter's tape doesn't get luckier on a second viewing. The
 * "incertitude"/"Fog of War" comes from what's withheld or estimated, not
 * from randomized accuracy.
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

// ---- Fog of War: prospect stat estimation (BALANCE.SCOUTING_FOG) --------------
// Distinct from generateScoutingReport above (qualitative FIGHT-OPPONENT
// notes): this half of the module estimates a PROSPECT's exact numeric
// skills before/while they're still being scouted at the gym — the
// "StatEstimee = StatReelle +/- (100 - CompetenceCoach) * 0.3" formula,
// resolving toward the truth over weeks spent training (Fighter#weeksAtGym).

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Deterministic pseudo-random offset in [-1, 1) from a seed string — no Math.random, same "the same fighter always scouts the same way" contract as generateScoutingReport (see this file's own header). */
function stableSignedNoise(seedString) {
  let hash = 0;
  for (let i = 0; i < seedString.length; i += 1) hash = (hash * 31 + seedString.charCodeAt(i)) >>> 0;
  return (hash % 2000) / 1000 - 1;
}

/**
 * @param {number} weeksAtGym
 * @returns {number} 0 (just signed, nothing revealed yet) to 1 (fully revealed) — BALANCE.SCOUTING_FOG.WEEKLY_ERROR_REDUCTION_FRACTION per week.
 */
export function getRevealProgress(weeksAtGym) {
  return clamp01(weeksAtGym * BALANCE.SCOUTING_FOG.WEEKLY_ERROR_REDUCTION_FRACTION);
}

/**
 * Estimates a prospect's skills under Fog of War: StatEstimee = StatReelle
 * +/- (100 - CompetenceCoach) * ERROR_PER_MISSING_COMPETENCE_POINT, with
 * that error window shrinking toward 0 as weeksAtGym grows (per
 * WEEKLY_ERROR_REDUCTION_FRACTION) — a sharp-eyed Head Coach (high
 * CompetenceCoach) starts closer to the truth than a gym with nobody
 * hired (BALANCE.SCOUTING_FOG.NO_COACH_COMPETENCE), and either way the
 * estimate converges to the real numbers well within a season.
 *
 * @param {Object} fighter - A Fighter instance.
 * @param {Object} [options]
 * @param {number} [options.headCoachSkill] - See engine/StaffEngine.js#getScoutingCompetence. Defaults to NO_COACH_COMPETENCE.
 * @param {number} [options.weeksAtGym] - Fighter#weeksAtGym. Defaults to 0 (a candidate not yet signed).
 * @returns {{ estimated: Object, errorWindow: number, fullyRevealed: boolean }}
 */
export function estimateFighterSkills(fighter, { headCoachSkill = BALANCE.SCOUTING_FOG.NO_COACH_COMPETENCE, weeksAtGym = 0 } = {}) {
  const cfg = BALANCE.SCOUTING_FOG;
  const baseError = (100 - headCoachSkill) * cfg.ERROR_PER_MISSING_COMPETENCE_POINT;
  const remainingFraction = 1 - getRevealProgress(weeksAtGym);
  const errorWindow = baseError * remainingFraction;

  const estimated = {};
  for (const [key, real] of Object.entries(fighter.attributes.skills)) {
    const noise = stableSignedNoise(`${fighter.identity.id}-${key}`) * errorWindow;
    estimated[key] = Math.round(clamp(real + noise, 0, 100));
  }

  return { estimated, errorWindow, fullyRevealed: errorWindow < 1 };
}

/**
 * Personality traits reveal one at a time as scouting progress advances —
 * the "traits caches... se revelent progressivement" fog-of-war layer,
 * expressed over this codebase's REAL personality trait system (see
 * data/traits.js) rather than inventing new hidden-perk mechanics.
 * Archetype is always visible (a fighter's general vibe reads immediately;
 * only the finer-grained traits are genuinely hidden at first).
 *
 * @param {Object} fighter - A Fighter instance.
 * @param {number} weeksAtGym
 * @returns {string[]} The subset of fighter.psychology.personality.traits revealed so far.
 */
export function getRevealedTraits(fighter, weeksAtGym) {
  const traits = fighter.psychology.personality.traits;
  const revealedCount = Math.floor(getRevealProgress(weeksAtGym) * traits.length);
  return traits.slice(0, revealedCount);
}

/**
 * Increments every roster fighter's Fighter#weeksAtGym by 1 — call once
 * per week (see web/app.js's weekly resolution, alongside
 * engine/StaffEngine.js#applyWeeklyStaffEffects).
 * @param {Object} playerState
 */
export function advanceWeeksAtGym(playerState) {
  for (const fighter of playerState.roster) fighter.weeksAtGym += 1;
}

export default { generateScoutingReport, getRevealProgress, estimateFighterSkills, getRevealedTraits, advanceWeeksAtGym };

/**
 * engine/Matchmaking.js
 * ---------------------------------------------------------------------------
 * A single, tiny structural rule: an official/competitive bout (a sanctioned
 * league fight, a title fight — anything CombatEngine#setupMatch is asked to
 * run OUTSIDE the Underground Circuit's own rules) can never pit two of the
 * PLAYER's own roster fighters against each other. Two gym-mates only ever
 * meet in Sparring, a weekly training activity (see
 * data/balance.js's ACTIVITY_LABELS.SPARRING / ui/WeeklyFlowController.js) —
 * never as opponents in the Combat tab. A real opponent always comes from a
 * rival gym's roster (worldState.rivalGyms[*].roster) or, for the
 * Underground Circuit, that same rival-gym pool (see
 * web/app.js#_renderUndergroundSetupModal, which already only ever offers
 * rival-gym opponents and therefore already satisfies this rule structurally).
 *
 * This exists as its own tiny guard — rather than only an implicit UI
 * limitation — so "no intra-gym official fight" is enforced even if a
 * future caller (a headless sim, a new UI flow) forgets to filter its own
 * opponent picker.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {Object} fighterA - A Fighter instance.
 * @param {Object} fighterB - A Fighter instance.
 * @param {Object} playerState - A PlayerState instance (reads .roster only).
 * @throws {Error} If both fighters belong to the player's own roster.
 */
export function assertNoIntraGymMatch(fighterA, fighterB, playerState) {
  const aIsPlayerFighter = playerState.roster.some((f) => f.identity.id === fighterA.identity.id);
  const bIsPlayerFighter = playerState.roster.some((f) => f.identity.id === fighterB.identity.id);

  if (aIsPlayerFighter && bIsPlayerFighter) {
    throw new Error(
      'Matchmaking: un combat officiel ne peut pas opposer deux combattants du meme gym. ' +
        'Deux membres du roster ne se rencontrent qu\'en Sparring (Planning) — un adversaire de competition vient toujours d\'un gym rival.'
    );
  }
}

/**
 * V3.5: real MMA promotions run strictly separate men's/women's divisions —
 * a competitive bout matches identity.gender by default. web/app.js's
 * opponent pickers use this same predicate to grey out cross-gender
 * opponents, and only bypass it when the player has explicitly checked a
 * "Mode Mixte" toggle (allowMixedGender: true).
 *
 * @param {Object} fighterA - A Fighter instance.
 * @param {Object} fighterB - A Fighter instance.
 * @param {Object} [options]
 * @param {boolean} [options.allowMixedGender=false]
 * @returns {boolean}
 */
export function isGenderMatch(fighterA, fighterB, { allowMixedGender = false } = {}) {
  if (allowMixedGender) return true;
  return fighterA.identity.gender === fighterB.identity.gender;
}

/**
 * @param {Object} fighterA - A Fighter instance.
 * @param {Object} fighterB - A Fighter instance.
 * @param {Object} [options]
 * @param {boolean} [options.allowMixedGender=false]
 * @throws {Error} If the genders don't match and Mode Mixte isn't explicitly allowed.
 */
export function assertGenderMatch(fighterA, fighterB, { allowMixedGender = false } = {}) {
  if (isGenderMatch(fighterA, fighterB, { allowMixedGender })) return;
  throw new Error(
    'Matchmaking: un combat officiel oppose strictement des combattants du meme genre ' +
      '(Hommes contre Hommes, Femmes contre Femmes), sauf en Mode Mixte explicitement active.'
  );
}

export default { assertNoIntraGymMatch, isGenderMatch, assertGenderMatch };

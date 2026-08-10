/**
 * data/names.js
 * ---------------------------------------------------------------------------
 * Shared real-name pool for any fighter the PLAYER personally recruits —
 * the initial roster draft and the permanent recruitment market (see
 * engine/DraftEngine.js). Every rival-gym-facing generator (AcademyEngine,
 * TransferMarket, ProspectGenerator) already keeps its own small local
 * FIRST_NAMES/LAST_NAMES pool by this codebase's established convention;
 * this file exists because the player's OWN starting roster used to get no
 * name pool at all — web/app.js#bootstrapRoster stamped
 * identity.name = `${style} Prospect` ("Boxe Prospect", "Kickboxing
 * Prospect"...) directly, with nothing narrative behind it.
 * ---------------------------------------------------------------------------
 */

/** V3.5: split by gender (see BALANCE.PHYSICAL.GENDERS/engine/FighterGenerator.js#generateGenderedIdentity) — was one unisex, ungendered pool. */
export const MALE_FIRST_NAMES = Object.freeze([
  'Thomas', 'Julien', 'Marco', 'Karim', 'Hugo', 'Anthony', 'Damien', 'Mathis',
  'Jonas', 'Samuel', 'Gabriel', 'Victor', 'Yannick', 'Lucas', 'Simon', 'Fabio',
]);

export const FEMALE_FIRST_NAMES = Object.freeze([
  'Elena', 'Chloe', 'Manon', 'Alicia', 'Sarah', 'Jade', 'Laura', 'Naomi',
]);

export const LAST_NAMES = Object.freeze([
  'Silva', 'Mercier', 'Bernard', 'Faure', 'Lemoine', 'Girard', 'Fontaine', 'Renard',
  'Barbosa', 'Almeida', 'Cardoso', 'Vasquez', 'Herrera', 'Novikov', 'Sokolov', 'Bauer',
  'Keller', 'Hoffmann', 'Andrade', 'Ferraz', 'Correia', 'Duval', 'Marchand', 'Leroy',
]);

export default { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES };

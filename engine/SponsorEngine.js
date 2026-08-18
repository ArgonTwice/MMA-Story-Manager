/**
 * engine/SponsorEngine.js
 * ---------------------------------------------------------------------------
 * V4.2 "Sponsoring Dynamique": individual, per-fighter sponsor CONTRACTS —
 * distinct from engine/InboxEngine.js's own pre-existing one-time gym-wide
 * SPONSOR_OFFER generator (evaluateSponsorOffers, left completely untouched)
 * and from BALANCE.NARRATIVE_EVENTS/BALANCE.DRAMA's own SPONSOR_OFFER flows
 * (engine/EventEngine.js/engine/DramaEngine.js, also untouched) — this file
 * is a separate, additive channel, same "never read the other's independent
 * concept" convention this codebase already applies to its several
 * orgId-scoped systems (see e.g. data/balance.js's GALA_CIRCUIT header).
 *
 * Triggered when a fighter's OWN Hype (models/Fighter.js#attributes.hype)
 * crosses one of BALANCE.FIGHTER_HYPE.SPONSOR_THRESHOLDS upward — a brand
 * (Volt Athletics/Monster Energy/FightWear) sends an unsolicited offer
 * (signing bonus + purse per fight + a fixed number of fights) into the
 * Messagerie (engine/InboxEngine.js#createMessage, category SPONSOR_OFFER),
 * the same "the sponsor reaches out first" pattern V4.0's league contract
 * offers already established (see engine/LeagueEngine.js
 * #evaluateLeagueOffers). Each threshold notifies AT MOST ONCE per
 * fighter's whole career (models/Fighter.js#markSponsorThresholdNotified) —
 * accepting or declining both consume it, so re-crossing the same tier
 * later never re-offers it. At most BALANCE.FIGHTER_HYPE
 * .MAX_ACTIVE_SPONSOR_OFFERS pending sponsor offers are ever active for one
 * fighter at a time ("evite le spam"), gating new OFFERS only — a fighter
 * may hold as many already-SIGNED sponsorships as they've accepted.
 *
 * Sponsor offers share Fighter#contracts.pendingOffers with league offers
 * (see engine/LeagueEngine.js) — SPONSOR_OFFER_ID_PREFIX keeps the two
 * namespaces (org ids vs sponsor offer ids) from ever colliding.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { createMessage } from './InboxEngine.js';

/** Prefix for every sponsor offer's Fighter#contracts.pendingOffers key — see this file's header. */
export const SPONSOR_OFFER_ID_PREFIX = 'SPONSOR_';

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** @returns {string} The Fighter#contracts.pendingOffers key for this Hype threshold's sponsor offer. */
function sponsorOfferId(threshold) {
  return `${SPONSOR_OFFER_ID_PREFIX}${threshold}`;
}

/** A sponsor contract's terms scale with the Hype threshold crossed — a Hype-80 offer pays far more than a Hype-30 one. `sponsorName` travels inside `terms` itself (not a separate field) so it survives the round-trip through Fighter#contracts.pendingOffers, which only ever stores {orgId, offeredOnDay, terms}. */
function buildSponsorTerms(threshold, sponsorName) {
  const cfg = BALANCE.FIGHTER_HYPE.SPONSOR_CONTRACT;
  return {
    sponsorName,
    fightsRequired: cfg.FIGHTS_REQUIRED,
    signingBonus: Math.round(threshold * cfg.SIGNING_BONUS_PER_HYPE_POINT),
    pursePerFight: Math.round(threshold * cfg.PURSE_PER_FIGHT_PER_HYPE_POINT),
  };
}

/**
 * Checks every BALANCE.FIGHTER_HYPE.SPONSOR_THRESHOLDS this fighter has now
 * cleared and never been notified for, and sends at most as many new
 * offers as still fit under MAX_ACTIVE_SPONSOR_OFFERS. Idempotent per
 * threshold (see models/Fighter.js#markSponsorThresholdNotified) — safe to
 * call after every resolved fight.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} fighter
 * @param {() => number} [rng]
 * @returns {Object[]} Every newly-created inbox message this call.
 */
export function evaluateSponsorshipOffers(playerState, worldState, fighter, rng = Math.random) {
  const cfg = BALANCE.FIGHTER_HYPE;
  const created = [];
  let activeOfferCount = fighter.getPendingOffers().filter((offer) => offer.orgId.startsWith(SPONSOR_OFFER_ID_PREFIX)).length;

  for (const threshold of cfg.SPONSOR_THRESHOLDS) {
    if (activeOfferCount >= cfg.MAX_ACTIVE_SPONSOR_OFFERS) break;
    if (fighter.attributes.hype < threshold) continue;
    if (fighter.hasBeenNotifiedForSponsorThreshold(threshold)) continue;

    const sponsorName = pick(rng, cfg.SPONSOR_BRANDS);
    const terms = buildSponsorTerms(threshold, sponsorName);
    const offerId = sponsorOfferId(threshold);

    fighter.receiveLeagueOffer(offerId, terms, worldState.currentDay);
    fighter.markSponsorThresholdNotified(threshold);

    const message = createMessage(playerState, worldState, {
      sender: sponsorName,
      category: 'SPONSOR_OFFER',
      title: `Offre de sponsoring de ${sponsorName}`,
      body: `${sponsorName} propose a ${fighter.identity.name} un contrat de sponsoring : ${terms.fightsRequired} combats, ${terms.pursePerFight.toLocaleString('fr-FR')}$/combat, prime de signature ${terms.signingBonus.toLocaleString('fr-FR')}$.`,
      actions: [
        { id: 'ACCEPT', label: 'Signer le sponsor' },
        { id: 'DECLINE', label: 'Refuser' },
      ],
      context: { fighterId: fighter.identity.id, offerId },
    });

    created.push(message);
    activeOfferCount += 1;
  }

  return created;
}

/**
 * Accepts a pending sponsor offer (see evaluateSponsorshipOffers) — pays
 * the signing bonus immediately and signs the fighter to that sponsor's
 * per-fight purse bonus for `terms.fightsRequired` fights (models/
 * Fighter.js#signSponsorship/consumeSponsorshipFights, the latter called
 * once per resolved fight from web/app.js#_finishCombatPlayback).
 *
 * @param {Object} playerState
 * @param {string} fighterId
 * @param {string} offerId
 * @returns {{ success: boolean, reason?: string, sponsorName?: string, terms?: Object }}
 */
export function acceptSponsorshipOffer(playerState, fighterId, offerId) {
  const fighter = playerState.getFighter(fighterId);
  if (!fighter) return { success: false, reason: 'FIGHTER_NOT_FOUND' };

  const offer = fighter.getPendingOffer(offerId);
  if (!offer) return { success: false, reason: 'NO_PENDING_OFFER' };

  fighter.signSponsorship(offer.terms.sponsorName, offer.terms.fightsRequired, offer.terms.pursePerFight);
  playerState.changeMoney(offer.terms.signingBonus, 'SPONSOR_SIGNING_BONUS');
  fighter.clearPendingOffer(offerId);

  return { success: true, sponsorName: offer.terms.sponsorName, terms: offer.terms };
}

/**
 * Declines a pending sponsor offer (see evaluateSponsorshipOffers) — the
 * threshold that produced it stays permanently notified either way, so
 * declining never causes it to be re-offered later.
 *
 * @param {Object} playerState
 * @param {string} fighterId
 * @param {string} offerId
 * @returns {{ success: boolean, reason?: string }}
 */
export function declineSponsorshipOffer(playerState, fighterId, offerId) {
  const fighter = playerState.getFighter(fighterId);
  if (!fighter) return { success: false, reason: 'FIGHTER_NOT_FOUND' };

  const removed = fighter.clearPendingOffer(offerId);
  return removed ? { success: true } : { success: false, reason: 'NO_PENDING_OFFER' };
}

export default { SPONSOR_OFFER_ID_PREFIX, evaluateSponsorshipOffers, acceptSponsorshipOffer, declineSponsorshipOffer };

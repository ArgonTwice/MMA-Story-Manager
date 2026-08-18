/**
 * engine/SponsorEngine.test.js
 * Run with: node --test engine/SponsorEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { getMessages } from './InboxEngine.js';
import { evaluateSponsorshipOffers, acceptSponsorshipOffer, declineSponsorshipOffer } from './SponsorEngine.js';

function makeFighter(hype = 0) {
  const fighter = new Fighter({ identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' } });
  fighter.adjustHype(hype);
  return fighter;
}

test('evaluateSponsorshipOffers sends nothing below every threshold', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(0);
  playerState.addFighter(fighter);

  assert.deepEqual(evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0), []);
  assert.equal(getMessages(playerState).length, 0);
});

test('evaluateSponsorshipOffers sends an offer once Hype clears the first threshold, with terms scaled off that threshold', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(35); // clears the 30 threshold, not 60/80.
  playerState.addFighter(fighter);
  const cfg = BALANCE.FIGHTER_HYPE.SPONSOR_CONTRACT;

  const created = evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].category, 'SPONSOR_OFFER');
  assert.equal(created[0].context.fighterId, 'f1');
  assert.equal(created[0].context.offerId, 'SPONSOR_30');

  const pending = fighter.getPendingOffer('SPONSOR_30');
  assert.ok(pending);
  assert.equal(pending.terms.fightsRequired, cfg.FIGHTS_REQUIRED);
  assert.equal(pending.terms.signingBonus, 30 * cfg.SIGNING_BONUS_PER_HYPE_POINT);
  assert.equal(pending.terms.pursePerFight, 30 * cfg.PURSE_PER_FIGHT_PER_HYPE_POINT);
  assert.ok(BALANCE.FIGHTER_HYPE.SPONSOR_BRANDS.includes(pending.terms.sponsorName));
});

test('evaluateSponsorshipOffers never duplicates an already-notified threshold on a later call', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(35); // clears only the 30 threshold — no cap interference.
  playerState.addFighter(fighter);

  const first = evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  assert.equal(first.length, 1);
  assert.equal(first[0].context.offerId, 'SPONSOR_30');

  const secondCall = evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  assert.deepEqual(secondCall, [], 'the 30 threshold is already notified — no re-offer');
});

test('evaluateSponsorshipOffers caps active offers at MAX_ACTIVE_SPONSOR_OFFERS', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(85);
  playerState.addFighter(fighter);

  const created = evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  assert.equal(created.length, BALANCE.FIGHTER_HYPE.MAX_ACTIVE_SPONSOR_OFFERS, 'only 2 of the 3 cleared thresholds fire before the cap stops it');

  // The un-notified threshold must remain available once a slot frees up (its offer resolved).
  acceptSponsorshipOffer(playerState, 'f1', created[0].context.offerId);
  const thirdBatch = evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  assert.equal(thirdBatch.length, 1);
});

test('acceptSponsorshipOffer pays the signing bonus, signs the sponsorship, and clears the pending offer; fails cleanly otherwise', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(35);
  playerState.addFighter(fighter);

  assert.equal(acceptSponsorshipOffer(playerState, 'missing', 'SPONSOR_30').reason, 'FIGHTER_NOT_FOUND');
  assert.equal(acceptSponsorshipOffer(playerState, 'f1', 'SPONSOR_30').reason, 'NO_PENDING_OFFER');

  evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  const moneyBefore = playerState.money;
  const result = acceptSponsorshipOffer(playerState, 'f1', 'SPONSOR_30');

  assert.equal(result.success, true);
  const cfg = BALANCE.FIGHTER_HYPE.SPONSOR_CONTRACT;
  assert.equal(playerState.money, moneyBefore + 30 * cfg.SIGNING_BONUS_PER_HYPE_POINT);
  assert.equal(fighter.hasPendingOffer('SPONSOR_30'), false);
  assert.equal(fighter.contracts.sponsorships.length, 1);
  assert.equal(fighter.contracts.sponsorships[0].sponsorName, result.sponsorName);
  assert.equal(fighter.contracts.sponsorships[0].fightsRemaining, cfg.FIGHTS_REQUIRED);
});

test('declineSponsorshipOffer clears the pending offer without paying anything, and fails cleanly when none exists', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeFighter(35);
  playerState.addFighter(fighter);

  assert.equal(declineSponsorshipOffer(playerState, 'f1', 'SPONSOR_30').reason, 'NO_PENDING_OFFER');

  evaluateSponsorshipOffers(playerState, worldState, fighter, () => 0);
  const moneyBefore = playerState.money;
  const result = declineSponsorshipOffer(playerState, 'f1', 'SPONSOR_30');

  assert.equal(result.success, true);
  assert.equal(playerState.money, moneyBefore);
  assert.equal(fighter.contracts.sponsorships.length, 0);
  assert.equal(fighter.hasBeenNotifiedForSponsorThreshold(30), true, 'declining still permanently consumes the threshold');
});

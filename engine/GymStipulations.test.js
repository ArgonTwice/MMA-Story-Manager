/**
 * engine/GymStipulations.test.js
 * Run with: node --test engine/GymStipulations.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { resolveGymStipulation, processActiveDeals, GYM_STIPULATIONS } from './GymStipulations.js';

function makeFighter(name, overrides = {}) {
  return new Fighter({
    identity: { name, age: 27, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    psychology: overrides.psychology,
  });
}

test('resolveGymStipulation rejects an unknown stipulation key', () => {
  assert.throws(() => resolveGymStipulation('NOT_A_REAL_STIPULATION', { playerWon: true, playerState: new PlayerState() }), TypeError);
});

test('GYM_TAKEOVER win: awards the highest-purchaseCost equipment item not already owned, free', () => {
  const player = new PlayerState({ money: 100 });
  const outcome = resolveGymStipulation(GYM_STIPULATIONS.GYM_TAKEOVER, { playerWon: true, playerState: player });

  const priciest = Object.entries(BALANCE.EQUIPMENT.DEFINITIONS).reduce((best, cand) =>
    cand[1].purchaseCost > best[1].purchaseCost ? cand : best
  )[0];

  assert.equal(outcome.type, 'EQUIPMENT_GAINED');
  assert.equal(outcome.equipmentId, priciest);
  assert.equal(player.equipment.length, 1);
  assert.equal(player.equipment[0].id, priciest);
  assert.equal(player.money, 100, 'the takeover reward must be free — no cost deducted');
});

test('GYM_TAKEOVER win: reports NOTHING_TO_GAIN once every equipment item is already owned, without erroring', () => {
  const player = new PlayerState();
  for (const id of Object.keys(BALANCE.EQUIPMENT.DEFINITIONS)) player.addEquipmentItem({ id });

  const outcome = resolveGymStipulation(GYM_STIPULATIONS.GYM_TAKEOVER, { playerWon: true, playerState: player });
  assert.equal(outcome.type, 'NOTHING_TO_GAIN');
  assert.equal(player.equipment.length, Object.keys(BALANCE.EQUIPMENT.DEFINITIONS).length);
});

test('GYM_TAKEOVER loss: seizes exactly one facility level for free, and reports NOTHING_TO_LOSE at equipLevel 0', () => {
  const player = new PlayerState({ equipLevel: 3, money: 500 });
  const outcome = resolveGymStipulation(GYM_STIPULATIONS.GYM_TAKEOVER, { playerWon: false, playerState: player });

  assert.equal(outcome.type, 'FACILITY_LEVEL_SEIZED');
  assert.equal(player.equipLevel, 2);
  assert.equal(player.money, 500, 'a seizure must never cost money');

  const brokePlayer = new PlayerState({ equipLevel: 0 });
  const brokeOutcome = resolveGymStipulation(GYM_STIPULATIONS.GYM_TAKEOVER, { playerWon: false, playerState: brokePlayer });
  assert.equal(brokeOutcome.type, 'NOTHING_TO_LOSE');
});

test('COACHS_HONOUR win: boosts Reputation and every roster fighter\'s Loyalty by the BALANCE-defined flat amounts', () => {
  const player = new PlayerState({ reputation: 30 });
  const f1 = makeFighter('F1');
  const f2 = makeFighter('F2');
  f1.psychology.loyalty = 50;
  f2.psychology.loyalty = 60;
  player.addFighter(f1);
  player.addFighter(f2);

  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.COACHS_HONOUR;
  const outcome = resolveGymStipulation(GYM_STIPULATIONS.COACHS_HONOUR, { playerWon: true, playerState: player });

  assert.equal(outcome.type, 'HONOUR_UPHELD');
  assert.equal(player.reputation, 30 + cfg.REPUTATION_WIN_BONUS);
  assert.equal(f1.psychology.loyalty, 50 + cfg.LOYALTY_WIN_BONUS);
  assert.equal(f2.psychology.loyalty, 60 + cfg.LOYALTY_WIN_BONUS);
});

test('COACHS_HONOUR loss: crashes every roster fighter\'s Loyalty by LOYALTY_LOSS_FRACTION of their OWN current value (proportional, not a flat -20)', () => {
  const player = new PlayerState();
  const highLoyalty = makeFighter('High');
  const lowLoyalty = makeFighter('Low');
  highLoyalty.psychology.loyalty = 80;
  lowLoyalty.psychology.loyalty = 10;
  player.addFighter(highLoyalty);
  player.addFighter(lowLoyalty);

  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.COACHS_HONOUR;
  const outcome = resolveGymStipulation(GYM_STIPULATIONS.COACHS_HONOUR, { playerWon: false, playerState: player });

  assert.equal(outcome.type, 'HONOUR_LOST');
  assert.ok(Math.abs(highLoyalty.psychology.loyalty - 80 * (1 - cfg.LOYALTY_LOSS_FRACTION)) < 1e-9);
  assert.ok(Math.abs(lowLoyalty.psychology.loyalty - 10 * (1 - cfg.LOYALTY_LOSS_FRACTION)) < 1e-9);
  assert.ok(
    80 * cfg.LOYALTY_LOSS_FRACTION > 10 * cfg.LOYALTY_LOSS_FRACTION,
    'sanity: the higher-loyalty fighter must lose more absolute points than the lower-loyalty one — proportional, not flat'
  );
});

test('PINK_SLIP requires playerFighter/opponentFighter/opponentGymId/worldState and rejects a call missing them', () => {
  assert.throws(
    () => resolveGymStipulation(GYM_STIPULATIONS.PINK_SLIP, { playerWon: true, playerState: new PlayerState() }),
    TypeError
  );
});

test('PINK_SLIP win: the opponent\'s fighter is removed from the rival gym roster and added to the player\'s own roster for free', () => {
  const player = new PlayerState();
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });

  const opponentFighter = makeFighter('Rival Prospect');
  world.updateRivalGym(gym.id, { roster: [opponentFighter.toJSON(), makeFighter('Other').toJSON()] });

  const playerFighter = makeFighter('Player Fighter');
  player.addFighter(playerFighter);

  const outcome = resolveGymStipulation(GYM_STIPULATIONS.PINK_SLIP, {
    playerWon: true,
    playerFighter,
    opponentFighter,
    opponentGymId: gym.id,
    playerState: player,
    worldState: world,
  });

  assert.equal(outcome.type, 'FIGHTER_ACQUIRED');
  assert.ok(player.roster.some((f) => f.identity.id === opponentFighter.identity.id));
  assert.equal(opponentFighter.identity.origin, 'PINK_SLIP');

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.ok(!updatedGym.roster.some((entry) => entry.identity.id === opponentFighter.identity.id), 'the rival gym must no longer list the ceded fighter');
  assert.equal(updatedGym.roster.length, 1, 'only the OTHER rival fighter should remain');
});

test('PINK_SLIP loss: the player\'s own fighter is removed from playerState.roster and added to the rival gym\'s roster for free', () => {
  const player = new PlayerState();
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });

  const playerFighter = makeFighter('Player Fighter');
  player.addFighter(playerFighter);
  player.addFighter(makeFighter('Stays On Roster'));
  const opponentFighter = makeFighter('Rival Prospect');

  const outcome = resolveGymStipulation(GYM_STIPULATIONS.PINK_SLIP, {
    playerWon: false,
    playerFighter,
    opponentFighter,
    opponentGymId: gym.id,
    playerState: player,
    worldState: world,
  });

  assert.equal(outcome.type, 'FIGHTER_LOST');
  assert.ok(!player.roster.some((f) => f.identity.id === playerFighter.identity.id));
  assert.equal(player.roster.length, 1);
  assert.equal(playerFighter.identity.origin, 'PINK_SLIP');
  assert.equal(playerFighter.contracts.currentContract, null);

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.ok(updatedGym.roster.some((entry) => entry.identity.id === playerFighter.identity.id));
});

test('SPONSORSHIP_RAID win: captures a timed deal matching BALANCE.UNDERGROUND.GYM_STIPULATIONS.SPONSORSHIP_RAID exactly', () => {
  const player = new PlayerState();
  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.SPONSORSHIP_RAID;

  const outcome = resolveGymStipulation(GYM_STIPULATIONS.SPONSORSHIP_RAID, { playerWon: true, playerState: player });

  assert.equal(outcome.type, 'SPONSOR_CAPTURED');
  assert.equal(player.activeDeals.length, 1);
  assert.equal(player.activeDeals[0].type, 'SPONSORSHIP_RAID');
  assert.equal(player.activeDeals[0].weeklyAmount, cfg.WEEKLY_AMOUNT);
  assert.equal(player.activeDeals[0].weeksRemaining, cfg.WEEKS);
});

test('SPONSORSHIP_RAID loss: no deal is captured, no error', () => {
  const player = new PlayerState();
  const outcome = resolveGymStipulation(GYM_STIPULATIONS.SPONSORSHIP_RAID, { playerWon: false, playerState: player });

  assert.equal(outcome.type, 'RAID_FAILED');
  assert.equal(player.activeDeals.length, 0);
});

test('processActiveDeals pays out weeklyAmount, counts down weeksRemaining, and removes the deal exactly when it expires', () => {
  const player = new PlayerState({ money: 0 });
  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.SPONSORSHIP_RAID;
  player.addActiveDeal({ type: 'SPONSORSHIP_RAID', weeklyAmount: cfg.WEEKLY_AMOUNT, weeksRemaining: 2 });

  const week1 = processActiveDeals(player);
  assert.equal(player.money, cfg.WEEKLY_AMOUNT);
  assert.equal(player.activeDeals.length, 1);
  assert.equal(player.activeDeals[0].weeksRemaining, 1);
  assert.equal(week1[0].expired, false);

  const week2 = processActiveDeals(player);
  assert.equal(player.money, cfg.WEEKLY_AMOUNT * 2);
  assert.equal(player.activeDeals.length, 0, 'the deal must be removed the week its countdown reaches 0');
  assert.equal(week2[0].expired, true);
});

test('processActiveDeals is a true no-op (no error, empty result) when there are no active deals', () => {
  const player = new PlayerState();
  const results = processActiveDeals(player);
  assert.deepEqual(results, []);
});

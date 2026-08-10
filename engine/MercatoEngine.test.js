/**
 * engine/MercatoEngine.test.js
 * Run with: node --test engine/MercatoEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { WorldState } from '../state/WorldState.js';
import { PlayerState } from '../state/PlayerState.js';
import {
  getScoutableGyms,
  sendScout,
  computeBuyoutFee,
  buyoutRivalFighter,
  rollWeeklyPoaching,
} from './MercatoEngine.js';

function seededRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ---- getScoutableGyms -------------------------------------------------------

test('getScoutableGyms only returns gyms at/below SCOUT.SMALL_CLUB_REPUTATION_MAX', () => {
  const cfg = BALANCE.MERCATO.SCOUT;
  const gyms = [
    { id: 'a', reputation: cfg.SMALL_CLUB_REPUTATION_MAX },
    { id: 'b', reputation: cfg.SMALL_CLUB_REPUTATION_MAX + 1 },
    { id: 'c', reputation: 0 },
  ];
  const scoutable = getScoutableGyms(gyms);
  assert.deepEqual(scoutable.map((g) => g.id).sort(), ['a', 'c']);
});

test('getScoutableGyms handles an empty/missing rival gym list', () => {
  assert.deepEqual(getScoutableGyms([]), []);
  assert.deepEqual(getScoutableGyms(undefined), []);
});

// ---- sendScout ---------------------------------------------------------------

test('sendScout generates between ROOKIE_COUNT_MIN and ROOKIE_COUNT_MAX real Fighter instances, never touching Player/WorldState', () => {
  const cfg = BALANCE.MERCATO.SCOUT;
  const rookies = sendScout({ rng: seededRng(42) });

  assert.ok(rookies.length >= cfg.ROOKIE_COUNT_MIN && rookies.length <= cfg.ROOKIE_COUNT_MAX);
  for (const rookie of rookies) {
    assert.ok(rookie instanceof Fighter);
    assert.equal(rookie.identity.origin, 'MERCATO_SCOUT');
    assert.ok(rookie.identity.age >= cfg.ROOKIE_MIN_AGE && rookie.identity.age <= cfg.ROOKIE_MAX_AGE);
    assert.ok(['M', 'F'].includes(rookie.identity.gender));
  }
});

// ---- computeBuyoutFee ---------------------------------------------------------

test('computeBuyoutFee scales with rating and multiplies steeply for a title holder', () => {
  const weakFighter = new Fighter({ identity: { name: 'Weak', age: 25 }, attributes: { skills: { boxe: 10, jambes: 10, sol: 10, soumission: 10, cardio: 10, intelligence: 10 } } });
  const strongFighter = new Fighter({ identity: { name: 'Strong', age: 27 }, attributes: { skills: { boxe: 80, jambes: 80, sol: 80, soumission: 80, cardio: 80, intelligence: 80 } } });

  const weakFee = computeBuyoutFee(weakFighter);
  const strongFee = computeBuyoutFee(strongFighter);
  assert.ok(strongFee > weakFee, 'a higher-rated fighter must cost more to buy out');

  strongFighter.career.titles.push('WFC Lightweight');
  const championFee = computeBuyoutFee(strongFighter);
  assert.ok(championFee > strongFee * 2.9, 'a title holder must cost roughly TITLE_HOLDER_EXTRA_MULTIPLIER times more');
});

// ---- buyoutRivalFighter -------------------------------------------------------

function makeRivalFighter(id, gymId, world) {
  const fighter = new Fighter({
    identity: { id, name: `Rival ${id}`, age: 26 },
    contracts: { currentContract: { leagueId: 'IRON_CAGE', gymId, signedYear: world.year, expiresYear: world.year + 3 } },
  });
  return fighter;
}

test('buyoutRivalFighter fails cleanly when the gym or fighter does not exist', () => {
  const world = new WorldState();
  const player = new PlayerState({ money: 999999 });

  assert.equal(buyoutRivalFighter(player, world, 'missing-gym', 'missing-fighter').success, false);

  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  assert.equal(buyoutRivalFighter(player, world, gym.id, 'missing-fighter').success, false);
});

test('buyoutRivalFighter fails when the player cannot afford the fee, and does not mutate state', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  const fighter = makeRivalFighter('f1', gym.id, world);
  world.updateRivalGym(gym.id, { roster: [fighter.toJSON()] });

  const player = new PlayerState({ money: 0 });
  const result = buyoutRivalFighter(player, world, gym.id, 'f1');

  assert.equal(result.success, false);
  assert.equal(result.reason, 'INSUFFICIENT_FUNDS');
  assert.equal(player.roster.length, 0);
  assert.equal(world.rivalGyms.find((g) => g.id === gym.id).roster.length, 1);
});

test('buyoutRivalFighter fails when the player roster is already full', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  const fighter = makeRivalFighter('f1', gym.id, world);
  world.updateRivalGym(gym.id, { roster: [fighter.toJSON()] });

  const player = new PlayerState({ money: 999999 });
  const capacity = player.getRosterCapacity();
  for (let i = 0; i < capacity; i += 1) {
    player.addFighter(new Fighter({ identity: { name: `Filler ${i}`, age: 25 } }));
  }

  const result = buyoutRivalFighter(player, world, gym.id, 'f1');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ROSTER_FULL');
});

test('a successful buyout deducts the fee, moves the fighter from the rival roster to the player roster, resets contract/loyalty', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  const fighter = makeRivalFighter('f1', gym.id, world);
  world.updateRivalGym(gym.id, { roster: [fighter.toJSON()] });

  const player = new PlayerState({ money: 999999 });
  const startingMoney = player.money;

  const result = buyoutRivalFighter(player, world, gym.id, 'f1');

  assert.equal(result.success, true);
  assert.ok(result.fee > 0);
  assert.equal(player.money, startingMoney - result.fee);
  assert.equal(player.roster.length, 1);
  assert.equal(player.roster[0].identity.id, 'f1');
  assert.equal(player.roster[0].contracts.currentContract, null);
  assert.equal(player.roster[0].psychology.loyalty, BALANCE.PSYCHOLOGY.STARTING_VALUES.loyalty);
  assert.equal(world.rivalGyms.find((g) => g.id === gym.id).roster.length, 0);
});

// ---- rollWeeklyPoaching --------------------------------------------------------

test('rollWeeklyPoaching never poaches a fighter at/above the loyalty threshold', () => {
  const world = new WorldState();
  world.addRivalGym({ name: 'Rival Gym', reputation: 30 });
  const player = new PlayerState({ money: 1000 });
  const loyalFighter = new Fighter({ identity: { name: 'Loyal', age: 25 }, psychology: { loyalty: BALANCE.MERCATO.POACHING.LOYALTY_THRESHOLD } });
  player.addFighter(loyalFighter);

  const poached = rollWeeklyPoaching(player, world, () => 0); // would always "hit" if eligible
  assert.deepEqual(poached, []);
  assert.equal(player.roster.length, 1);
});

test('rollWeeklyPoaching never poaches anyone when there are no rival gyms to receive them', () => {
  const world = new WorldState();
  const player = new PlayerState({ money: 1000 });
  const disloyalFighter = new Fighter({ identity: { name: 'Disloyal', age: 25 }, psychology: { loyalty: 0 } });
  player.addFighter(disloyalFighter);

  const poached = rollWeeklyPoaching(player, world, () => 0);
  assert.deepEqual(poached, []);
  assert.equal(player.roster.length, 1);
});

test('a low-loyalty fighter is poached onto a rival roster when the roll hits, and removed from the player roster', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rival Gym', reputation: 30 });
  const player = new PlayerState({ money: 1000 });
  const disloyalFighter = new Fighter({ identity: { id: 'target', name: 'Disloyal', age: 25 }, psychology: { loyalty: 0 } });
  player.addFighter(disloyalFighter);

  const poached = rollWeeklyPoaching(player, world, () => 0); // always beats any positive chance

  assert.equal(poached.length, 1);
  assert.equal(poached[0].fighterId, 'target');
  assert.equal(poached[0].gymId, gym.id);
  assert.equal(player.roster.length, 0);

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, 1);
  assert.equal(updatedGym.roster[0].identity.id, 'target');
});

test('a low-loyalty fighter is safe when the roll misses', () => {
  const world = new WorldState();
  world.addRivalGym({ name: 'Rival Gym', reputation: 30 });
  const player = new PlayerState({ money: 1000 });
  const disloyalFighter = new Fighter({ identity: { name: 'Disloyal', age: 25 }, psychology: { loyalty: 0 } });
  player.addFighter(disloyalFighter);

  const poached = rollWeeklyPoaching(player, world, () => 0.999); // always beats no positive chance
  assert.deepEqual(poached, []);
  assert.equal(player.roster.length, 1);
});

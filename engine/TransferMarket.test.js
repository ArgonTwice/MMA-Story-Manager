/**
 * engine/TransferMarket.test.js
 * Run with: node --test engine/TransferMarket.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { WorldState, WORLD_EVENTS } from '../state/WorldState.js';
import EventBus from '../core/EventBus.js';
import { resolveLeagueForReputation } from '../data/leagues.js';
import { processTransferMarket } from './TransferMarket.js';

function seededRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test('a gym with no rival gyms produces an empty report and touches nothing', () => {
  const world = new WorldState();
  const report = processTransferMarket(world, { rng: seededRng(1) });
  assert.deepEqual(report, { signings: [], extensions: [], releases: [] });
});

test('an empty-roster gym under ROSTER_TARGET_SIZE recruits when the roll favors it, with a contract under the league its Reputation qualifies for', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rising Gym', reputation: 30 }); // qualifies for RISING_WARRIORS

  const report = processTransferMarket(world, { rng: () => 0 }); // always "succeeds" any < chance roll

  assert.equal(report.signings.length, 1);
  assert.equal(report.signings[0].type, 'RIVAL_SIGNING');
  assert.equal(report.signings[0].gymId, gym.id);

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, 1);
  assert.equal(updatedGym.roster[0] instanceof Fighter, false, 'roster must be stored as plain JSON, never live Fighter instances');

  const recruit = Fighter.fromJSON(updatedGym.roster[0]);
  assert.equal(recruit.identity.origin, 'TRANSFER_MARKET');
  assert.ok(recruit.contracts.currentContract);
  assert.equal(recruit.contracts.currentContract.gymId, gym.id);
  assert.equal(recruit.contracts.currentContract.leagueId, resolveLeagueForReputation(30).id);
  assert.equal(recruit.contracts.currentContract.expiresYear, world.year + BALANCE.TRANSFER_MARKET.NEW_CONTRACT_YEARS);
});

test('a gym already at ROSTER_TARGET_SIZE never recruits, even when every roll favors it', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Full Gym', reputation: 50 });

  const fullRoster = Array.from({ length: BALANCE.TRANSFER_MARKET.ROSTER_TARGET_SIZE }, (_, i) =>
    new Fighter({
      identity: { name: `Roster Fighter ${i}`, age: 25 },
      contracts: { currentContract: { leagueId: 'IRON_CAGE', gymId: gym.id, signedYear: world.year, expiresYear: world.year + 5 } },
    }).toJSON()
  );
  world.updateRivalGym(gym.id, { roster: fullRoster });

  const report = processTransferMarket(world, { rng: () => 0 });

  assert.equal(report.signings.length, 0);
  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, BALANCE.TRANSFER_MARKET.ROSTER_TARGET_SIZE);
});

test('an expiring contract survives (extended) when the release roll fails, and a fresh contract is written', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Loyal Gym', reputation: 40 });

  const youngStrong = new Fighter({
    identity: { name: 'Young Strong', age: 24 },
    attributes: { skills: { boxe: 80, jambes: 80, sol: 80, soumission: 80, cardio: 80, intelligence: 80 } },
    contracts: { currentContract: { leagueId: 'RISING_WARRIORS', gymId: gym.id, signedYear: world.year - 2, expiresYear: world.year } },
  });
  world.updateRivalGym(gym.id, { roster: [youngStrong.toJSON()] });

  // rng() = 0.99 fails BOTH the release roll (chance <= 0.2 for a young/strong fighter) and the recruit-chance roll.
  const report = processTransferMarket(world, { rng: () => 0.99 });

  assert.equal(report.releases.length, 0);
  assert.equal(report.extensions.length, 1);
  assert.equal(report.extensions[0].type, 'RIVAL_EXTENSION');

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, 1);
  const kept = Fighter.fromJSON(updatedGym.roster[0]);
  assert.equal(kept.contracts.currentContract.expiresYear, world.year + BALANCE.TRANSFER_MARKET.EXTEND_CONTRACT_YEARS);
});

test('an old, low-rated expiring fighter is released when the roll favors it, and the vacated slot can trigger a fresh recruit', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Rebuilding Gym', reputation: 20 });

  const oldWeak = new Fighter({
    identity: { name: 'Old Weak', age: BALANCE.AGE.DECLINE_START_AGE + 5 },
    attributes: { skills: { boxe: 10, jambes: 10, sol: 10, soumission: 10, cardio: 10, intelligence: 10 } },
    contracts: { currentContract: { leagueId: 'UNDERGROUND_CIRCUIT', gymId: gym.id, signedYear: world.year - 2, expiresYear: world.year } },
  });
  world.updateRivalGym(gym.id, { roster: [oldWeak.toJSON()] });

  // rng() = 0 guarantees the release roll fires (chance > 0) and the subsequent recruit-chance roll also fires.
  const report = processTransferMarket(world, { rng: () => 0 });

  assert.equal(report.releases.length, 1);
  assert.equal(report.releases[0].fighterName, 'Old Weak');
  assert.equal(report.signings.length, 1, 'the vacated roster slot (now under target size) should trigger a fresh recruit');

  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, 1);
  assert.notEqual(Fighter.fromJSON(updatedGym.roster[0]).identity.name, 'Old Weak');
});

test('a contract not yet expired is neither released nor extended (no event published) — the fighter simply stays', () => {
  const world = new WorldState();
  const gym = world.addRivalGym({ name: 'Stable Gym', reputation: 40 });

  const midContract = new Fighter({
    identity: { name: 'Mid Contract', age: 26 },
    contracts: { currentContract: { leagueId: 'RISING_WARRIORS', gymId: gym.id, signedYear: world.year, expiresYear: world.year + 3 } },
  });
  world.updateRivalGym(gym.id, { roster: [midContract.toJSON()] });

  const report = processTransferMarket(world, { rng: () => 0.99 });

  assert.equal(report.releases.length, 0);
  assert.equal(report.extensions.length, 0);
  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, 1);
  assert.equal(Fighter.fromJSON(updatedGym.roster[0]).contracts.currentContract.expiresYear, world.year + 3, 'expiresYear should be untouched');
});

test('every signing/extension/release publishes a WORLD_EVENTS.GLOBAL_EVENT_ADDED event', () => {
  const world = new WorldState();
  world.addRivalGym({ name: 'Eventful Gym', reputation: 50 });

  const events = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.GLOBAL_EVENT_ADDED, (payload) => events.push(payload.event));
  processTransferMarket(world, { rng: () => 0 });
  unsub();

  assert.ok(events.length > 0);
  assert.ok(events.every((e) => ['RIVAL_SIGNING', 'RIVAL_EXTENSION', 'RIVAL_RELEASE'].includes(e.type)));
});

test('processTransferMarket is deterministic given a fixed rng seed', () => {
  function runOnce() {
    const world = new WorldState();
    world.addRivalGym({ name: 'Gym A', reputation: 30 });
    world.addRivalGym({ name: 'Gym B', reputation: 70 });
    const report = processTransferMarket(world, { rng: seededRng(99) });
    return { report, rosterSizes: world.rivalGyms.map((g) => g.roster?.length ?? 0) };
  }

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a.rosterSizes, b.rosterSizes);
  assert.equal(a.report.signings.length, b.report.signings.length);
});

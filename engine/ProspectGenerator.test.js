/**
 * engine/ProspectGenerator.test.js
 * Run with: node --test engine/ProspectGenerator.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { WorldState, WORLD_EVENTS } from '../state/WorldState.js';
import EventBus from '../core/EventBus.js';
import { resolveLeagueForReputation } from '../data/leagues.js';
import { isProspectWaveDue, generateProspectWave } from './ProspectGenerator.js';

function seededRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function worldAtYear(year) {
  const world = new WorldState();
  // WorldState has no direct year setter (year is derived from currentDay) —
  // advance by whole years using its own calendar constants, same approach
  // engine/ProgressionEngine.js itself uses.
  const daysPerYear = BALANCE.CALENDAR.DAYS_PER_WEEK * BALANCE.CALENDAR.WEEKS_PER_SEASON * BALANCE.CALENDAR.SEASONS_PER_YEAR;
  if (year > 1) world.advanceDay(daysPerYear * (year - 1));
  return world;
}

test('isProspectWaveDue is false off the WAVE_INTERVAL_YEARS boundary, true exactly on it, and false again once recorded for that year', () => {
  const interval = BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS;
  const offBoundary = worldAtYear(interval - 1);
  assert.equal(isProspectWaveDue(offBoundary), false);

  const onBoundary = worldAtYear(interval);
  assert.equal(onBoundary.year, interval);
  assert.equal(isProspectWaveDue(onBoundary), true);

  onBoundary.recordProspectWave(interval);
  assert.equal(isProspectWaveDue(onBoundary), false);
});

test('generateProspectWave with no rival gyms still generates prospects and records the wave, but places nobody', () => {
  const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
  const result = generateProspectWave(world, { rng: seededRng(1) });

  assert.ok(result.prospects.length >= BALANCE.PROSPECT_GENERATOR.WAVE_SIZE_MIN);
  assert.ok(result.prospects.length <= BALANCE.PROSPECT_GENERATOR.WAVE_SIZE_MAX);
  assert.ok(Object.keys(BALANCE.PROSPECT_GENERATOR.THEMES).includes(result.theme));
  assert.deepEqual(result.assignments, []);
  assert.equal(world.lastProspectWaveYear, world.year);
});

test('generateProspectWave distributes prospects round-robin across rival gyms, each stamped with the wave\'s theme/year provenance and a contract under the signing gym\'s league', () => {
  const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
  const gymA = world.addRivalGym({ name: 'Gym A', reputation: 10 });
  const gymB = world.addRivalGym({ name: 'Gym B', reputation: 90 });

  const result = generateProspectWave(world, { rng: seededRng(7) });

  assert.equal(result.assignments.length, result.prospects.length, 'both gyms have ample room, so every prospect should be placed');
  const gymIdsUsed = new Set(result.assignments.map((a) => a.gymId));
  assert.ok(gymIdsUsed.has(gymA.id) || gymIdsUsed.has(gymB.id));

  for (const gym of world.rivalGyms) {
    for (const entry of gym.roster ?? []) {
      const fighter = Fighter.fromJSON(entry);
      assert.match(fighter.identity.origin, new RegExp(`^PROSPECT_WAVE:${result.theme}:${world.year}$`));
      assert.ok(fighter.contracts.currentContract);
      assert.equal(fighter.contracts.currentContract.gymId, gym.id);
      assert.equal(fighter.contracts.currentContract.leagueId, resolveLeagueForReputation(gym.reputation).id);
    }
  }
});

test('a theme\'s own skills get THEME_SKILL_BONUS on top of the baseline mean — a Lutteurs-themed prospect reads stronger in sol/soumission than a same-seed Strikers-themed one would', () => {
  const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
  // Force theme selection to the first Object.keys(THEMES) entry deterministically via rng()=0 on the first call.
  const themeKeys = Object.keys(BALANCE.PROSPECT_GENERATOR.THEMES);
  const forcedThemeKey = themeKeys[0];
  const theme = BALANCE.PROSPECT_GENERATOR.THEMES[forcedThemeKey];

  const queue = [0, 0]; // theme pick (index 0), wave size roll (-> WAVE_SIZE_MIN)
  const rng = () => (queue.length > 0 ? queue.shift() : 0.5);
  const result = generateProspectWave(world, { rng });

  assert.equal(result.theme, forcedThemeKey);
  const prospect = result.prospects[0];
  for (const skillKey of theme.skills) {
    assert.ok(
      prospect.attributes.skills[skillKey] > BALANCE.PROSPECT_GENERATOR.SKILL_MEAN_BASE,
      `expected theme skill "${skillKey}" to read above the baseline mean thanks to THEME_SKILL_BONUS`
    );
  }
});

test('a gym already at 2x ROSTER_TARGET_SIZE never receives a new prospect from the wave', () => {
  const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
  const gym = world.addRivalGym({ name: 'Overflowing Gym', reputation: 50 });
  const maxSize = BALANCE.TRANSFER_MARKET.ROSTER_TARGET_SIZE * 2;
  const fullRoster = Array.from({ length: maxSize }, (_, i) => new Fighter({ identity: { name: `Existing ${i}` } }).toJSON());
  world.updateRivalGym(gym.id, { roster: fullRoster });

  const result = generateProspectWave(world, { rng: seededRng(3) });

  assert.deepEqual(result.assignments, [], 'the only gym is already full, so nothing should be placed');
  const updatedGym = world.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.roster.length, maxSize);
});

test('generateProspectWave publishes exactly one PROSPECT_WAVE global event', () => {
  const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
  world.addRivalGym({ name: 'Gym', reputation: 40 });

  const events = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.GLOBAL_EVENT_ADDED, (payload) => events.push(payload.event));
  const result = generateProspectWave(world, { rng: seededRng(5) });
  unsub();

  const waveEvents = events.filter((e) => e.type === 'PROSPECT_WAVE');
  assert.equal(waveEvents.length, 1);
  assert.equal(waveEvents[0].theme, result.theme);
  assert.equal(waveEvents[0].waveSize, result.prospects.length);
  assert.equal(waveEvents[0].placedCount, result.assignments.length);
});

test('generateProspectWave is deterministic given a fixed rng seed', () => {
  function runOnce() {
    const world = worldAtYear(BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS);
    world.addRivalGym({ name: 'Gym', reputation: 45 });
    const result = generateProspectWave(world, { rng: seededRng(2024) });
    return { theme: result.theme, names: result.prospects.map((p) => p.identity.name) };
  }

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b);
});

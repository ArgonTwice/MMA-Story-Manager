/**
 * engine/ProgressionEngine.test.js
 * Run with: node --test engine/ProgressionEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { GameState } from '../state/GameState.js';
import { createSeededRng } from './CombatEngine.js';
import { advanceWeek, PROGRESSION_EVENTS } from './ProgressionEngine.js';
import { LEGACY_ENGINE_OUTCOMES } from './LegacyEngine.js';

const WEEKS_PER_YEAR = BALANCE.CALENDAR.WEEKS_PER_SEASON * BALANCE.CALENDAR.SEASONS_PER_YEAR;

test('advanceWeek moves the calendar forward 7 days and publishes a full weekly summary', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Progression Gym' });
  const dayBefore = gameState.worldState.currentDay;

  const events = [];
  const unsub = EventBus.subscribe(PROGRESSION_EVENTS.WEEK_ADVANCED, (payload) => events.push(payload));

  const summary = advanceWeek(gameState, { rng: createSeededRng(1) });
  unsub();

  assert.equal(gameState.worldState.currentDay, dayBefore + BALANCE.CALENDAR.DAYS_PER_WEEK);
  assert.equal(summary.day, gameState.worldState.currentDay);
  assert.ok('trainingReport' in summary);
  assert.ok('economyReport' in summary);
  assert.ok('birthdays' in summary);
  assert.ok('rivalGymReport' in summary);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], summary);
});

test('crossing a season boundary publishes world:season_ended in addition to world:week_advanced', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Season Gym' });

  const daysPerSeason = BALANCE.CALENDAR.DAYS_PER_WEEK * BALANCE.CALENDAR.WEEKS_PER_SEASON;
  const weeksToSeasonEdge = Math.floor(daysPerSeason / BALANCE.CALENDAR.DAYS_PER_WEEK) - 1;

  // Walk right up to the last week still inside the starting season.
  for (let i = 0; i < weeksToSeasonEdge; i += 1) {
    advanceWeek(gameState, { rng: createSeededRng(i + 1) });
  }
  const seasonBeforeFinalStep = gameState.worldState.season;

  const seasonEndedEvents = [];
  const unsub = EventBus.subscribe(PROGRESSION_EVENTS.SEASON_ENDED, (payload) => seasonEndedEvents.push(payload));
  advanceWeek(gameState, { rng: createSeededRng(999) });
  unsub();

  assert.notEqual(gameState.worldState.season, seasonBeforeFinalStep);
  assert.equal(seasonEndedEvents.length, 1);
  assert.equal(seasonEndedEvents[0].endedSeason, seasonBeforeFinalStep);
  assert.equal(seasonEndedEvents[0].newSeason, gameState.worldState.season);
});

test('Phase V2.7: the autonomous transfer market only runs on a season boundary, and its report is null every other week', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Transfer Gym' });
  gameState.worldState.addRivalGym({ name: 'Rival Gym', reputation: 40 });

  const daysPerSeason = BALANCE.CALENDAR.DAYS_PER_WEEK * BALANCE.CALENDAR.WEEKS_PER_SEASON;
  const weeksToSeasonEdge = Math.floor(daysPerSeason / BALANCE.CALENDAR.DAYS_PER_WEEK) - 1;

  let midSeasonSummary = null;
  for (let i = 0; i < weeksToSeasonEdge; i += 1) {
    midSeasonSummary = advanceWeek(gameState, { rng: createSeededRng(i + 1) });
  }
  assert.equal(midSeasonSummary.transferMarketReport, null, 'mid-season weeks should never run the transfer market');

  const boundarySummary = advanceWeek(gameState, { rng: () => 0 }); // rng=0 forces a recruit on the still-empty rival roster
  assert.notEqual(boundarySummary.transferMarketReport, null);
  assert.ok(Array.isArray(boundarySummary.transferMarketReport.signings));
});

test('Phase V2.7: a prospect wave fires exactly once across a full WAVE_INTERVAL_YEARS span, on the correct year boundary', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Prospect Gym' });
  gameState.worldState.addRivalGym({ name: 'Rival Gym', reputation: 40 });

  const interval = BALANCE.PROSPECT_GENERATOR.WAVE_INTERVAL_YEARS;
  const waveWeeks = [];
  for (let week = 1; week <= WEEKS_PER_YEAR * interval; week += 1) {
    const summary = advanceWeek(gameState, { rng: createSeededRng(week) });
    if (summary.prospectWaveReport) waveWeeks.push({ week, year: summary.year });
  }

  assert.equal(waveWeeks.length, 1, 'exactly one wave should fire across the whole interval');
  assert.equal(waveWeeks[0].year, interval);
  assert.equal(gameState.worldState.lastProspectWaveYear, interval);
});

test('a full 52-week year ages every fighter by exactly one year, on a single distinct week', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Birthday Gym' });
  const fighter = new Fighter({ identity: { name: 'Birthday Fighter', age: 30 } });
  gameState.playerState.addFighter(fighter);

  let totalBirthdayHits = 0;
  for (let week = 0; week < WEEKS_PER_YEAR; week += 1) {
    const summary = advanceWeek(gameState, { rng: createSeededRng(week + 1) });
    totalBirthdayHits += summary.birthdays.filter((b) => b.fighterId === fighter.identity.id).length;
  }

  assert.equal(fighter.identity.age, 31);
  assert.equal(totalBirthdayHits, 1, 'a fighter should have exactly one birthday per 52-week year');
});

test('Phase 4.3: a fighter aging into forced retirement is fully resolved (Legacy Engine reconversion, then removed from the roster), not just left on it', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Retirement Gym' });
  const fighter = new Fighter({
    identity: { name: 'Elder Fighter', age: BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE - 1 },
    career: { wins: 10, losses: 5, draws: 0 },
  });
  gameState.playerState.addFighter(fighter);

  let summary;
  for (let week = 0; week < WEEKS_PER_YEAR; week += 1) {
    summary = advanceWeek(gameState, { rng: createSeededRng(week + 1) });
    if (summary.retirements.length > 0) break;
  }

  assert.equal(summary.retirements.length, 1);
  const retirement = summary.retirements[0];
  assert.equal(retirement.fighterId, fighter.identity.id);
  assert.equal(retirement.age, BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE);
  assert.ok(Object.values(LEGACY_ENGINE_OUTCOMES).includes(retirement.reconversion.outcome));
  assert.equal(gameState.playerState.getFighter(fighter.identity.id), undefined, 'the retired fighter must actually leave the roster');
});

test('rival gyms drift weekly and can headlessly fight each other, recorded as a world global event', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Rival Watcher Gym' });
  gameState.worldState.addRivalGym({ id: 'gymA', name: 'Gym A', reputation: 60 });
  gameState.worldState.addRivalGym({ id: 'gymB', name: 'Gym B', reputation: 40 });

  const alwaysZero = () => 0; // guarantees the weekly fight-chance roll passes
  const summary = advanceWeek(gameState, { rng: alwaysZero });

  assert.equal(summary.rivalGymReport.length, 1);
  assert.equal(summary.rivalGymReport[0].type, 'RIVAL_FIGHT_RESULT');
  assert.ok(['gymA', 'gymB'].includes(summary.rivalGymReport[0].winnerGymId));

  const [gymA, gymB] = gameState.worldState.rivalGyms;
  assert.notEqual(gymA.reputation, 60, 'the winning/losing gym reputations should have moved from their starting values');
  assert.notEqual(gymB.reputation, 40);

  const loggedInGlobalEvents = gameState.worldState.globalEvents.some((e) => e.type === 'RIVAL_FIGHT_RESULT');
  assert.ok(loggedInGlobalEvents, 'the fight result should also be recorded in WorldState.globalEvents');
});

test('advanceWeek drives real training and economy side effects through the underlying engines', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Integration Gym' });
  const fighter = new Fighter({
    identity: { name: 'Integration Fighter' },
    attributes: { skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 } },
  });
  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  gameState.playerState.addFighter(fighter);

  const moneyBefore = gameState.playerState.money;
  const boxeBefore = fighter.attributes.skills.boxe;

  const summary = advanceWeek(gameState, { rng: createSeededRng(5) });

  assert.ok(fighter.attributes.skills.boxe > boxeBefore, 'training report should have actually trained the fighter');
  assert.equal(summary.trainingReport.trained[0].fighterId, fighter.identity.id);
  assert.notEqual(gameState.playerState.money, moneyBefore, "economy report should have actually changed the player's money");
  assert.equal(summary.economyReport.balanceAfter, gameState.playerState.money);
});

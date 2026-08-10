/**
 * engine/SocialFeedEngine.test.js
 * Run with: node --test engine/SocialFeedEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import {
  computeWeeklySubscriberGrowth,
  computeWeeklyMerchandisingIncome,
  applyFilmingMoralePenalty,
  processWeeklyCommunityManagement,
} from './SocialFeedEngine.js';

function makeFighter(traits = []) {
  return new Fighter({
    identity: { name: 'Social Fighter', age: 25, style: 'Freestyle', weightClass: 'Lightweight' },
    psychology: { personality: { archetype: 'Cameleon', traits } },
  });
}

test('a fresh gym starts with 0 subscribers and filming disabled', () => {
  const playerState = new PlayerState({ money: 25000 });
  assert.equal(playerState.subscribers, BALANCE.COMMUNITY_MANAGER.STARTING_SUBSCRIBERS);
  assert.equal(playerState.filmingEnabled, false);
});

test('computeWeeklySubscriberGrowth scales with Hype, and is multiplied while filming is enabled', () => {
  const cfg = BALANCE.COMMUNITY_MANAGER;
  const playerState = new PlayerState({ money: 25000, hype: 20 });

  const baseline = computeWeeklySubscriberGrowth(playerState);
  assert.ok(Math.abs(baseline - (cfg.BASE_WEEKLY_GROWTH + 20 * cfg.GROWTH_PER_HYPE_POINT)) < 1e-9);

  playerState.setFilmingEnabled(true);
  const filming = computeWeeklySubscriberGrowth(playerState);
  assert.ok(Math.abs(filming - baseline * cfg.FILMING_GROWTH_MULTIPLIER) < 1e-9);
  assert.ok(filming > baseline);
});

test('computeWeeklyMerchandisingIncome scales linearly with current subscribers, and is 0 at 0 subscribers', () => {
  const cfg = BALANCE.COMMUNITY_MANAGER;
  const playerState = new PlayerState({ money: 25000 });
  assert.equal(computeWeeklyMerchandisingIncome(playerState), 0);

  playerState.subscribers = 5000;
  assert.ok(Math.abs(computeWeeklyMerchandisingIncome(playerState) - (5 * cfg.INCOME_PER_1000_SUBSCRIBERS_WEEKLY)) < 1e-9);
});

test('applyFilmingMoralePenalty docks Introverti fighters only, and only while filming is enabled', () => {
  const cfg = BALANCE.COMMUNITY_MANAGER;
  const playerState = new PlayerState({ money: 25000 });
  const introvert = makeFighter(['Introverti']);
  const extrovert = makeFighter(['Meneur']);
  playerState.addFighter(introvert);
  playerState.addFighter(extrovert);

  assert.deepEqual(applyFilmingMoralePenalty(playerState), [], 'filming is off by default — no effect');

  playerState.setFilmingEnabled(true);
  const moraleBefore = introvert.attributes.moral;
  const affected = applyFilmingMoralePenalty(playerState);

  assert.deepEqual(affected, [introvert.identity.id]);
  assert.equal(introvert.attributes.moral, moraleBefore + cfg.FILMING_INTROVERT_MORALE_PENALTY);
});

test('processWeeklyCommunityManagement grants merchandising income, grows subscribers, and applies the introvert penalty in one call', () => {
  const playerState = new PlayerState({ money: 25000, hype: 10 });
  playerState.subscribers = 2000;
  playerState.setFilmingEnabled(true);
  const introvert = makeFighter(['Introverti']);
  playerState.addFighter(introvert);

  const moneyBefore = playerState.money;
  const moraleBefore = introvert.attributes.moral;

  const report = processWeeklyCommunityManagement(playerState);

  assert.ok(report.merchandisingIncome > 0);
  assert.equal(playerState.money, moneyBefore + report.merchandisingIncome);
  assert.ok(report.subscriberGrowth > 0);
  assert.equal(playerState.subscribers, report.subscribersAfter);
  assert.ok(playerState.subscribers > 2000);
  assert.deepEqual(report.introvertFightersDocked, [introvert.identity.id]);
  assert.ok(introvert.attributes.moral < moraleBefore);
});

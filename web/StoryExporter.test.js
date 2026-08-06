/**
 * web/StoryExporter.test.js
 * Run with: node --test web/StoryExporter.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { buildStoryCard, toShareText } from './StoryExporter.js';

function makeFighter({ name = 'Test Fighter', wins = 0, losses = 0, draws = 0 } = {}) {
  const fighter = new Fighter({ identity: { name, age: 25, style: 'Boxe', weightClass: 'Poids Welter' } });
  fighter.career.wins = wins;
  fighter.career.losses = losses;
  fighter.career.draws = draws;
  return fighter;
}

test('buildStoryCard: Bilan Global sums the current roster and every Hall of Fame entry, and reports the honest lower-bound note', () => {
  const player = new PlayerState({ gymName: 'Iron Gym', country: 'France' });
  player.addFighter(makeFighter({ wins: 5, losses: 2, draws: 1 }));
  player.addFighter(makeFighter({ wins: 3, losses: 0, draws: 0 }));

  const world = new WorldState();
  world.addHallOfFameEntry({ fighterId: 'legend1', name: 'Old Legend', record: '20-4-2', style: 'Lutte' });

  const card = buildStoryCard({ playerState: player, worldState: world });

  assert.deepEqual(card.record, { wins: 5 + 3 + 20, losses: 2 + 0 + 4, draws: 1 + 0 + 2 });
  assert.equal(card.recordString, '28-6-3');
  assert.equal(card.gymName, 'Iron Gym');
  assert.equal(card.country, 'France');
  assert.ok(card.note.length > 0);
});

test('buildStoryCard: legendCount is the Hall of Fame size, and null/absent fields degrade honestly instead of being fabricated', () => {
  const player = new PlayerState({ gymName: 'Empty Gym' });
  const world = new WorldState();

  const card = buildStoryCard({ playerState: player, worldState: world });

  assert.equal(card.legendCount, 0);
  assert.equal(card.bestRivalry, null);
  assert.equal(card.biggestUpset, null);
  assert.equal(card.recordString, '0-0-0');

  world.addHallOfFameEntry({ fighterId: 'l1', name: 'Legend One', record: '10-1-0' });
  world.addHallOfFameEntry({ fighterId: 'l2', name: 'Legend Two', record: '8-3-1' });
  const cardWithLegends = buildStoryCard({ playerState: player, worldState: world });
  assert.equal(cardWithLegends.legendCount, 2);
});

test('buildStoryCard: bestRivalry finds the single highest-tension pair across the whole relationship graph, resolving live roster names', () => {
  const player = new PlayerState({ gymName: 'Rivals Gym' });
  const fighterA = makeFighter({ name: 'Alpha' });
  const fighterB = makeFighter({ name: 'Beta' });
  player.addFighter(fighterA);
  player.addFighter(fighterB);

  const world = new WorldState();
  world.upsertRelationship(fighterA.identity.id, fighterB.identity.id, { tension: 40 });
  world.upsertRelationship('unknownId1', 'unknownId2', { tension: 80 });

  const card = buildStoryCard({ playerState: player, worldState: world });

  assert.ok(card.bestRivalry, 'the higher-tension pair should have been picked, even with unresolvable names');
  assert.equal(card.bestRivalry.tension, 80);
  // Neither unknownId resolves to a live roster fighter, so the raw id is the honest fallback (same as engine/HistoryEngine.js#findBiggestRival).
  assert.equal(card.bestRivalry.fighterAId, 'unknownId1');
  assert.equal(card.bestRivalry.fighterAName, 'unknownId1');
});

test('buildStoryCard: a zero-tension-only relationship graph reports no rivalry rather than a meaningless 0-tension "best" pair', () => {
  const player = new PlayerState({ gymName: 'Quiet Gym' });
  const world = new WorldState();
  world.upsertRelationship('f1', 'f2', {}); // starts at BALANCE.RELATIONSHIP.STARTING_TENSION, no delta applied

  const card = buildStoryCard({ playerState: player, worldState: world });
  if (card.bestRivalry) {
    assert.ok(card.bestRivalry.tension > 0);
  }
});

test('buildStoryCard: biggestUpset surfaces the persistent WorldState record when set', () => {
  const player = new PlayerState({ gymName: 'Underdog Gym' });
  const world = new WorldState();
  world.trySetRecord('biggestUpset', 35, { detail: 'Beta bat Alpha malgre un ecart de 35 points de niveau.' });

  const card = buildStoryCard({ playerState: player, worldState: world });
  assert.deepEqual(card.biggestUpset, { detail: 'Beta bat Alpha malgre un ecart de 35 points de niveau.', gap: 35 });
});

test('toShareText renders every populated field and omits sections that are honestly null', () => {
  const player = new PlayerState({ gymName: 'Text Gym', country: 'Belgique' });
  const world = new WorldState();
  const card = buildStoryCard({ playerState: player, worldState: world });

  const text = toShareText(card);
  assert.ok(text.includes('Text Gym'));
  assert.ok(text.includes('Belgique'));
  assert.ok(text.includes('Bilan Global : 0-0-0'));
  assert.ok(!text.includes('Meilleure Rivalite'), 'no rivalry section when bestRivalry is null');
  assert.ok(!text.includes('Plus Grand Upset'), 'no upset section when biggestUpset is null');

  world.upsertRelationship('f1', 'f2', { tension: 25 });
  world.trySetRecord('biggestUpset', 12, { detail: 'X bat Y malgre un ecart de 12 points de niveau.' });
  const fullCard = buildStoryCard({ playerState: player, worldState: world });
  const fullText = toShareText(fullCard);
  assert.ok(fullText.includes('Meilleure Rivalite'));
  assert.ok(fullText.includes('Plus Grand Upset'));
});

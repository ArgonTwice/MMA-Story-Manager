/**
 * ui/FightNightView.test.js
 * Run with: node --test ui/FightNightView.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { CombatEngine, createSeededRng } from '../engine/CombatEngine.js';
import { FightNightView } from './FightNightView.js';

function makeFighter(name, val, overrides = {}) {
  return new Fighter({
    identity: { name, age: 28, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: {
      skills: { boxe: val, jambes: val, sol: val, soumission: val, cardio: val, intelligence: val },
      ...overrides.attributes,
    },
  });
}

function makeEngineWithPlayerState() {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighterA = makeFighter('Alpha', 50);
  const fighterB = makeFighter('Beta', 50);
  playerState.addFighter(fighterA);
  playerState.addFighter(fighterB);
  const combatEngine = new CombatEngine({ playerState, worldState, rng: createSeededRng(1) });
  return { combatEngine, playerState, worldState, fighterA, fighterB };
}

test('presentMatchup returns a fight card with both fighters\' Readiness/nickname/record/style', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  fighterA.recordFightResult({ outcome: 'win', byFinish: false });
  const view = new FightNightView({ combatEngine });

  const card = view.presentMatchup(fighterA, fighterB, 'WFC', false);

  assert.equal(card.fighterA.name, 'Alpha');
  assert.equal(card.fighterA.record, '1-0-0');
  assert.equal(card.fighterB.name, 'Beta');
  assert.equal(card.isTitle, false);
  assert.ok(typeof card.fighterA.readiness === 'number');
  assert.equal(card.fighterA.nickname, null);
});

test('setGameplans defaults each corner to its own style\'s primary distance/target when not explicitly provided', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  fighterA.identity.style = 'Lutte'; // GROUND-affinity style
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);

  view.setGameplans();

  const snapshot = combatEngine.getSnapshot();
  assert.equal(snapshot.gameplans.A.distance, 'GROUND');
  assert.equal(snapshot.gameplans.B.distance, 'STRIKING');
});

test('setGameplans respects an explicitly provided gameplan for either corner', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);

  view.setGameplans({ A: { target: 'LEGS', distance: 'CLINCH', tempo: 'AGGRESSIVE' } });

  const snapshot = combatEngine.getSnapshot();
  assert.deepEqual(snapshot.gameplans.A, { target: 'LEGS', distance: 'CLINCH', tempo: 'AGGRESSIVE' });
});

test('advanceOneRound steps exactly one round per call, then reports finished: true with a result banner on the last call', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);
  view.setGameplans();

  let step;
  let rounds = 0;
  const seenRoundNumbers = [];
  do {
    step = view.advanceOneRound();
    if (!step.finished) {
      rounds += 1;
      seenRoundNumbers.push(step.round.round);
      assert.equal(step.resultBanner, null);
    }
  } while (!step.finished && rounds < 20);

  assert.ok(step.finished, 'the fight must eventually finish');
  assert.ok(step.resultBanner, 'a finished step must carry a result banner');
  assert.ok(step.resultBanner.headline.length > 0);
  assert.deepEqual(seenRoundNumbers, [...seenRoundNumbers].sort((a, b) => a - b), 'rounds should be reported in increasing order');
  assert.equal(view.getRoundLogs().length, rounds);
});

test('simulateToCompletion runs the whole fight in one call and still populates getRoundLogs()', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);
  view.setGameplans();

  const banner = view.simulateToCompletion();

  assert.ok(banner);
  assert.ok(view.getRoundLogs().length > 0);
  assert.equal(view.toResultText(), banner.headline);
});

test('a finished fight\'s result banner names the actual winning Fighter and carries purses/readiness', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', false);
  view.setGameplans();
  const banner = view.simulateToCompletion();

  if (banner.winner) {
    const winnerFighter = banner.winner === 'A' ? fighterA : fighterB;
    assert.equal(banner.winnerName, winnerFighter.identity.name);
  } else {
    assert.equal(banner.winnerName, null);
  }
  assert.ok(banner.purses.A);
  assert.ok(typeof banner.readiness.A === 'number');
});

test('toCardText/toRoundsText render non-empty, readable plain text', () => {
  const { combatEngine, fighterA, fighterB } = makeEngineWithPlayerState();
  const view = new FightNightView({ combatEngine });
  view.presentMatchup(fighterA, fighterB, 'WFC', true);
  view.setGameplans();

  const cardText = view.toCardText();
  assert.ok(cardText.includes('Alpha'));
  assert.ok(cardText.includes('Beta'));
  assert.ok(cardText.includes('COMBAT DE TITRE'));

  view.simulateToCompletion();
  const roundsText = view.toRoundsText();
  assert.ok(roundsText.includes('Round 1'));
});

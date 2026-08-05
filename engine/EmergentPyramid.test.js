/**
 * engine/EmergentPyramid.test.js
 * Run with: node --test engine/EmergentPyramid.test.js
 *
 * Integration coverage for the whole Phase 2 pyramid working together
 * through real EventBus traffic and real CombatEngine simulations (no
 * shortcuts): PersonalityEngine (L1), RelationshipEngine (L1), StoryEngine
 * (L2 detector), NarrativeEngine (L2 storyteller) and WorldMemory (L2
 * memory) are all attached at once, exactly as engine/App.js would wire
 * them, and none of them import each other — only core/EventBus.js,
 * data/balance.js and State/Models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { CombatEngine, createSeededRng } from './CombatEngine.js';
import { PersonalityEngine } from './PersonalityEngine.js';
import { RelationshipEngine } from './RelationshipEngine.js';
import { StoryEngine, STORY_ENGINE_EVENTS, OPPORTUNITY_TYPES } from './StoryEngine.js';
import { NarrativeEngine, NARRATIVE_ENGINE_EVENTS } from './NarrativeEngine.js';
import { WorldMemory } from './WorldMemory.js';

function makeFighter(name, value, overrides = {}) {
  return new Fighter({
    identity: { name, age: 27, weightClass: 'Lightweight', ...overrides.identity },
    attributes: {
      skills: { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value },
    },
    psychology: overrides.psychology,
  });
}

test('a proud fighter losing repeatedly to the same rival builds tension/relation until StoryEngine detects it, NarrativeEngine tells it, and RelationshipEngine feeds the beat back into the graph', () => {
  const player = new PlayerState({ gymName: 'Emergent Gym', hype: 20 });
  const world = new WorldState();

  const proud = makeFighter('Le Fier', 45, { psychology: { ego: 85 } });
  const nemesis = makeFighter('Nemesis', 70);
  player.addFighter(proud);
  player.addFighter(nemesis);

  const personalityEngine = new PersonalityEngine().attach(player);
  const relationshipEngine = new RelationshipEngine().attach(world);
  const storyEngine = new StoryEngine().attach(player, world);
  // Low, constant rng: for every FORM_WEIGHTS_BY_OPPORTUNITY row used below,
  // this deterministically selects the first-listed form (DECLARATION for
  // both CONFLICT_POTENTIAL and RIVALRY_IGNITED).
  const narrativeEngine = new NarrativeEngine({ rng: () => 0.01 }).attach(player, world);
  const worldMemory = new WorldMemory().attach(world);

  const opportunities = [];
  const narrativeBeats = [];
  const unsubStory = EventBus.subscribe(STORY_ENGINE_EVENTS.OPPORTUNITY_DETECTED, (o) => opportunities.push(o));
  const unsubNarrative = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => narrativeBeats.push(b));

  // Fight the same pair 4 times; nemesis (much higher skill + aggressive
  // gameplan vs proud's conservative one) wins every time by decision,
  // driving tension (+12/fight) and relation (-8/fight) past the
  // RIVALRY_IGNITED (relation <= -30) and CONFLICT_POTENTIAL (tension >= 40,
  // loser ego >= 65) thresholds on the 4th meeting.
  let lastResult = null;
  for (let i = 0; i < 4; i += 1) {
    const combat = new CombatEngine({ rng: createSeededRng(i + 1) });
    combat.setupMatch(proud, nemesis, 'WFC', false);
    combat.setGameplan('A', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
    combat.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
    lastResult = combat.simulateFullMatch();
    assert.equal(lastResult.winner, 'B', `expected nemesis to win fight #${i + 1} for this scenario to be meaningful`);
  }

  unsubStory();
  unsubNarrative();
  personalityEngine.detach();
  relationshipEngine.detach();
  storyEngine.detach();
  narrativeEngine.detach();
  worldMemory.detach();

  // --- Level 1: RelationshipEngine mechanically tracked 4 fights' worth of gauges ---
  const cfg = BALANCE.RELATIONSHIP.COMBAT_EFFECTS;
  const relationship = world.getRelationship(proud.identity.id, nemesis.identity.id);
  assert.ok(relationship, 'a relationship record should exist after repeated combat');
  assert.ok(
    relationship.gauges.tension >= BALANCE.STORY.CONFLICT_POTENTIAL.MIN_TENSION,
    'tension should have crossed the conflict threshold'
  );
  assert.ok(
    relationship.gauges.relation <= BALANCE.STORY.RIVALRY_IGNITED.MAX_RELATION,
    'relation should have crossed the rivalry threshold'
  );

  // --- Level 2 detector: StoryEngine raised both opportunities ---
  const conflictOpportunity = opportunities.find((o) => o.type === OPPORTUNITY_TYPES.CONFLICT_POTENTIAL);
  const rivalryOpportunity = opportunities.find((o) => o.type === OPPORTUNITY_TYPES.RIVALRY_IGNITED);
  assert.ok(conflictOpportunity, 'StoryEngine should have detected a CONFLICT_POTENTIAL');
  assert.deepEqual(conflictOpportunity.entities, [proud.identity.id, nemesis.identity.id]);
  assert.ok(rivalryOpportunity, 'StoryEngine should have detected a RIVALRY_IGNITED');

  // --- Level 2 storyteller: NarrativeEngine turned at least one opportunity into a beat ---
  assert.ok(narrativeBeats.length >= 1, 'NarrativeEngine should have published at least one beat');
  const provocationBeat = narrativeBeats.find((b) => b.tone === 'PROVOCATION');
  assert.ok(provocationBeat, 'at least one beat should be tagged as a provocation (DECLARATION on an adversarial opportunity)');
  assert.ok(player.socialFeed.some((post) => post.text === provocationBeat.headline));

  // --- Feedback loop: RelationshipEngine reacted to the provocation, pushing the graph further ---
  const relationshipAfterNarrative = world.getRelationship(proud.identity.id, nemesis.identity.id);
  const provocationHistory = relationshipAfterNarrative.history.filter((h) => h.type === 'PROVOCATION');
  assert.ok(provocationHistory.length >= 1, 'the provocation should be recorded in the relationship history');
  assert.ok(
    relationshipAfterNarrative.gauges.tension > relationship.gauges.tension - 1e-9,
    'tension should not have decreased after the provocation feedback'
  );

  // --- Level 1: PersonalityEngine silently nudged morale on every fight (non-neutral default archetype is fine either way) ---
  assert.notEqual(proud.attributes.moral, BALANCE.MORALE.STARTING_VALUE, "the fighter's morale should have moved from its starting value across 4 losses");

  // --- Level 2 memory: WorldMemory recorded the biggest of the 4 fights by combined purse ---
  const biggestFight = world.getRecord('biggestFight');
  assert.ok(biggestFight.value > 0);
  assert.ok(biggestFight.detail.includes('Le Fier') || biggestFight.detail.includes('Nemesis'));
});

test('no engine in the pyramid imports another engine module — only core/EventBus.js, data/balance.js and Models', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const engineFiles = [
    'PersonalityEngine.js',
    'RelationshipEngine.js',
    'StoryEngine.js',
    'NarrativeEngine.js',
    'WorldMemory.js',
  ];

  for (const file of engineFiles) {
    const filePath = path.join(import.meta.dirname, file);
    const source = await fs.readFile(filePath, 'utf8');
    const importLines = source.match(/^import .* from '.*';$/gm) ?? [];
    for (const line of importLines) {
      assert.ok(
        /from '\.\.\/core\/EventBus\.js'|from '\.\.\/data\/balance\.js'/.test(line),
        `${file} has a disallowed cross-module import: "${line}"`
      );
    }
  }
});

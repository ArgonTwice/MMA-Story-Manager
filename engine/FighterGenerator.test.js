/**
 * engine/FighterGenerator.test.js
 * Run with: node --test engine/FighterGenerator.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generatePersonality, generateFighterIdentity, generateGenderedIdentity, generatePhysicalProfile, computeAcademyOverallBase } from './FighterGenerator.js';

test('generatePersonality always returns a valid archetype and MIN_TRAITS..MAX_TRAITS unique, valid traits', () => {
  const archetypeKeys = new Set(Object.keys(BALANCE.PERSONALITY.ARCHETYPES));
  const traitKeys = new Set(Object.keys(BALANCE.PERSONALITY.TRAITS));
  const cfg = BALANCE.PERSONALITY.GENERATION;

  for (let i = 0; i < 200; i += 1) {
    const personality = generatePersonality();
    assert.ok(archetypeKeys.has(personality.archetype), `"${personality.archetype}" should be a valid archetype`);
    assert.ok(personality.traits.length >= cfg.MIN_TRAITS && personality.traits.length <= cfg.MAX_TRAITS);
    assert.equal(new Set(personality.traits).size, personality.traits.length, 'traits should never repeat');
    for (const trait of personality.traits) {
      assert.ok(traitKeys.has(trait), `"${trait}" should be a valid trait`);
    }
  }
});

test('generatePersonality is deterministic given a fixed rng, and produces a Fighter-ready shape', () => {
  const queue = [0, 0, 0, 0]; // archetype pick, trait-count pick, then one pick per trait (MIN_TRAITS=2)
  const rng = () => queue.shift() ?? 0.9;

  const personality = generatePersonality(rng);
  const archetypeKeys = Object.keys(BALANCE.PERSONALITY.ARCHETYPES);
  const traitKeys = Object.keys(BALANCE.PERSONALITY.TRAITS);

  assert.equal(personality.archetype, archetypeKeys[0]);
  assert.deepEqual(personality.traits, [traitKeys[0], traitKeys[1]]);

  // Must be directly usable as Fighter construction input, with no further massaging.
  const fighter = new Fighter({ identity: { name: 'Generated' }, psychology: { personality } });
  assert.equal(fighter.psychology.personality.archetype, personality.archetype);
  assert.deepEqual(fighter.psychology.personality.traits, personality.traits);
});

test('different rng streams produce varied personalities (not every generated fighter collapses to the same default)', () => {
  const seen = new Set();
  for (let seed = 0; seed < 20; seed += 1) {
    let state = seed + 1;
    const rng = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const personality = generatePersonality(rng);
    seen.add(`${personality.archetype}:${personality.traits.join(',')}`);
  }
  assert.ok(seen.size > 1, 'generated personalities should vary across different rng streams');
});

// ---- V3.5: gendered identity + physical profile ------------------------------

function seededRng(seed) {
  let state = seed + 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test('generateFighterIdentity always returns a valid BALANCE.PHYSICAL.GENDERS value alongside the name', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const identity = generateFighterIdentity(seededRng(seed));
    assert.ok(BALANCE.PHYSICAL.GENDERS.includes(identity.gender), `"${identity.gender}" should be a valid gender`);
    assert.ok(identity.name.includes(' '), 'expected a "Prenom Nom" shaped name');
  }
});

test('generateGenderedIdentity picks a first name from the matching gendered pool for whichever gender it rolls', () => {
  const male = ['Marc'];
  const female = ['Julie'];
  const last = ['Dupont'];

  let sawMale = false;
  let sawFemale = false;
  for (let seed = 0; seed < 50 && !(sawMale && sawFemale); seed += 1) {
    const identity = generateGenderedIdentity(seededRng(seed), male, female, last);
    if (identity.gender === 'M') {
      assert.equal(identity.name, 'Marc Dupont');
      sawMale = true;
    } else {
      assert.equal(identity.name, 'Julie Dupont');
      sawFemale = true;
    }
  }
  assert.ok(sawMale && sawFemale, 'expected both genders to be rolled across 50 seeds');
});

test('generatePhysicalProfile respects an explicitly-passed gender rather than rolling its own', () => {
  for (let seed = 0; seed < 20; seed += 1) {
    assert.equal(generatePhysicalProfile(seededRng(seed), 'M').gender, 'M');
    assert.equal(generatePhysicalProfile(seededRng(seed), 'F').gender, 'F');
  }
});

test('generatePhysicalProfile picks a weight class from the correct gendered catalog, and a weightKg at/under that class\'s cap', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    for (const gender of ['M', 'F']) {
      const profile = generatePhysicalProfile(seededRng(seed), gender);
      const validIds = BALANCE.PHYSICAL.WEIGHT_CLASSES[gender].map((wc) => wc.id);
      assert.ok(validIds.includes(profile.weightClassId), `"${profile.weightClassId}" should belong to ${gender}'s catalog`);

      const weightClass = BALANCE.PHYSICAL.WEIGHT_CLASSES[gender].find((wc) => wc.id === profile.weightClassId);
      assert.ok(profile.weightKg <= weightClass.maxKg, 'weigh-in should never exceed the division cap');
      assert.ok(profile.weightKg > weightClass.maxKg - BALANCE.PHYSICAL.WEIGHT_UNDER_CAP_KG * 2, 'weigh-in should be realistically close to the cap');
    }
  }
});

test('generatePhysicalProfile\'s heightCm stays within the gender\'s configured range', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    for (const gender of ['M', 'F']) {
      const profile = generatePhysicalProfile(seededRng(seed), gender);
      const range = BALANCE.PHYSICAL.HEIGHT_CM[gender];
      assert.ok(profile.heightCm >= range.MIN && profile.heightCm <= range.MAX, `${profile.heightCm}cm should be within [${range.MIN}, ${range.MAX}] for ${gender}`);
    }
  }
});

test('a Fighter built from generatePhysicalProfile\'s output round-trips its identity fields cleanly', () => {
  const identity = generateFighterIdentity(seededRng(1));
  const physical = generatePhysicalProfile(seededRng(1), identity.gender);
  const fighter = new Fighter({
    identity: {
      name: identity.name,
      gender: physical.gender,
      heightCm: physical.heightCm,
      weightKg: physical.weightKg,
      weightClass: physical.weightClassLabel,
    },
  });

  assert.equal(fighter.identity.gender, physical.gender);
  assert.equal(fighter.identity.heightCm, physical.heightCm);
  assert.equal(fighter.identity.weightKg, physical.weightKg);
  assert.equal(fighter.identity.weightClass, physical.weightClassLabel);
});

// ---- V3.8: computeAcademyOverallBase -------------------------------------------

test('computeAcademyOverallBase lands at exactly 25 for a fresh gym (0 Reputation, equipLevel 0) — a genuinely raw starting prospect', () => {
  assert.equal(computeAcademyOverallBase(0, 0), 25);
});

test('computeAcademyOverallBase follows OverallBase = min(100, 25 + Reputation*0.3 + EquipmentScore*0.2)', () => {
  const maxEquipLevel = BALANCE.GYM.TIERS.length - 1;
  const equipmentScore = (2 / maxEquipLevel) * 100;
  const expected = 25 + 50 * 0.3 + equipmentScore * 0.2;
  assert.equal(computeAcademyOverallBase(50, 2), expected);
});

test('computeAcademyOverallBase increases with Reputation and with equipLevel, and never exceeds 100', () => {
  const base = computeAcademyOverallBase(0, 0);
  const higherReputation = computeAcademyOverallBase(50, 0);
  const higherEquip = computeAcademyOverallBase(0, BALANCE.GYM.TIERS.length - 1);
  const maxed = computeAcademyOverallBase(100, BALANCE.GYM.TIERS.length - 1);

  assert.ok(higherReputation > base);
  assert.ok(higherEquip > base);
  assert.ok(maxed <= 100);
});

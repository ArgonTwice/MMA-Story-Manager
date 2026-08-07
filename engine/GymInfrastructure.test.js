/**
 * engine/GymInfrastructure.test.js
 * Run with: node --test engine/GymInfrastructure.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import {
  getNextTierUpgradeCost,
  getNextTier,
  getQualityScaledMultiplier,
  getClinchOutputMultiplier,
  getStaminaMaxBonusPercent,
  getFatigueAccumulationMultiplier,
  getEquipmentHealthIndicator,
  degradeEquipmentWeekly,
  getRepairCost,
  repairEquipment,
  getLowQualityInjuryRiskMultiplier,
  hasLowQualityEquipment,
} from './GymInfrastructure.js';

test('a fresh gym has no equipment/upgrade cost effects — every multiplier is exactly neutral', () => {
  const playerState = new PlayerState({ money: 25000 });
  assert.equal(getClinchOutputMultiplier(playerState), 1);
  assert.equal(getStaminaMaxBonusPercent(playerState), 0);
  assert.equal(getFatigueAccumulationMultiplier(playerState), 1);
  assert.equal(getLowQualityInjuryRiskMultiplier(playerState), 1);
  assert.equal(hasLowQualityEquipment(playerState), false);
});

test('getNextTierUpgradeCost grows with GROWTH per level and is null at MAX_LEVEL', () => {
  const cfg = BALANCE.ECONOMY.FACILITY_UPGRADE;
  const playerState = new PlayerState({ money: 999999 });

  const cost0 = getNextTierUpgradeCost(playerState);
  assert.equal(cost0, Math.round(cfg.BASE_COST));

  playerState.equipLevel = cfg.MAX_LEVEL;
  assert.equal(getNextTierUpgradeCost(playerState), null);
});

test('getNextTier returns the following BALANCE.GYM.TIERS entry, and null at the top tier', () => {
  const playerState = new PlayerState({ money: 25000 });
  assert.equal(getNextTier(playerState).id, BALANCE.GYM.TIERS[1].id);

  playerState.equipLevel = BALANCE.GYM.TIERS.length - 1;
  assert.equal(getNextTier(playerState), null);
});

test('getQualityScaledMultiplier reproduces the raw multiplier at quality 1 and is fully neutral at quality 0', () => {
  assert.equal(getQualityScaledMultiplier(1.2, 1), 1.2);
  assert.equal(getQualityScaledMultiplier(1.2, 0), 1);
  assert.ok(getQualityScaledMultiplier(1.2, 0.5) > 1 && getQualityScaledMultiplier(1.2, 0.5) < 1.2);
});

test('getClinchOutputMultiplier scales COMPETITION_CAGE\'s bonus by the item\'s current quality', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'COMPETITION_CAGE' });
  assert.equal(getClinchOutputMultiplier(playerState), BALANCE.EQUIPMENT.DEFINITIONS.COMPETITION_CAGE.clinchOutputMultiplier);

  playerState.equipment[0].quality = 0;
  assert.equal(getClinchOutputMultiplier(playerState), 1);
});

test('getStaminaMaxBonusPercent reflects CARDIO_ZONE, scaled by quality, and 0 without it', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'CARDIO_ZONE' });
  assert.equal(getStaminaMaxBonusPercent(playerState), BALANCE.EQUIPMENT.DEFINITIONS.CARDIO_ZONE.staminaMaxBonusPercent);

  playerState.equipment[0].quality = 0;
  assert.equal(getStaminaMaxBonusPercent(playerState), 0);
});

test('getFatigueAccumulationMultiplier reflects CRYOTHERAPY_CHAMBER\'s reduction, scaled by quality', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'CRYOTHERAPY_CHAMBER' });
  assert.equal(
    getFatigueAccumulationMultiplier(playerState),
    BALANCE.EQUIPMENT.DEFINITIONS.CRYOTHERAPY_CHAMBER.fatigueAccumulationMultiplier
  );

  playerState.equipment[0].quality = 0;
  assert.equal(getFatigueAccumulationMultiplier(playerState), 1);
});

test('getEquipmentHealthIndicator returns the correct traffic-light emoji at each quality band', () => {
  assert.equal(getEquipmentHealthIndicator(1), '\u{1F7E2}');
  assert.equal(getEquipmentHealthIndicator(0.7), '\u{1F7E2}');
  assert.equal(getEquipmentHealthIndicator(0.5), '\u{1F7E1}');
  assert.equal(getEquipmentHealthIndicator(BALANCE.EQUIPMENT.LOW_QUALITY_THRESHOLD), '\u{1F7E1}');
  assert.equal(getEquipmentHealthIndicator(0.1), '\u{1F534}');
});

test('degradeEquipmentWeekly lowers every owned item\'s quality by DEGRADATION_PER_WEEK, floored at 0', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'HEAVY_BAGS' });

  degradeEquipmentWeekly(playerState);
  assert.ok(Math.abs(playerState.equipment[0].quality - (1 - BALANCE.EQUIPMENT.DEGRADATION_PER_WEEK)) < 1e-9);

  for (let i = 0; i < 50; i += 1) degradeEquipmentWeekly(playerState);
  assert.equal(playerState.equipment[0].quality, 0);
});

test('getRepairCost is purchaseCost * REPAIR_COST_FRACTION_OF_PURCHASE, and 0 for an unknown id', () => {
  const cfg = BALANCE.EQUIPMENT;
  assert.equal(getRepairCost('HEAVY_BAGS'), Math.round(cfg.DEFINITIONS.HEAVY_BAGS.purchaseCost * cfg.REPAIR_COST_FRACTION_OF_PURCHASE));
  assert.equal(getRepairCost('NOT_A_REAL_ITEM'), 0);
});

test('repairEquipment restores quality to 1 and deducts the repair cost, but fails without enough funds or an unowned item', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'HEAVY_BAGS' });
  playerState.equipment[0].quality = 0.2;

  const cost = getRepairCost('HEAVY_BAGS');
  const moneyBefore = playerState.money;
  assert.equal(repairEquipment(playerState, 'HEAVY_BAGS'), true);
  assert.equal(playerState.equipment[0].quality, 1);
  assert.equal(playerState.money, moneyBefore - cost);

  assert.equal(repairEquipment(playerState, 'NOT_OWNED'), false);

  playerState.equipment[0].quality = 0.2;
  playerState.money = 0;
  assert.equal(repairEquipment(playerState, 'HEAVY_BAGS'), false);
});

test('getLowQualityInjuryRiskMultiplier is neutral above LOW_QUALITY_THRESHOLD and compounds for each item below it', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'HEAVY_BAGS' });
  playerState.addEquipmentItem({ id: 'WEIGHT_ROOM' });

  assert.equal(getLowQualityInjuryRiskMultiplier(playerState), 1);

  playerState.equipment[0].quality = 0.1;
  assert.equal(getLowQualityInjuryRiskMultiplier(playerState), BALANCE.EQUIPMENT.LOW_QUALITY_INJURY_RISK_MULTIPLIER);

  playerState.equipment[1].quality = 0.1;
  assert.ok(
    Math.abs(
      getLowQualityInjuryRiskMultiplier(playerState) - BALANCE.EQUIPMENT.LOW_QUALITY_INJURY_RISK_MULTIPLIER ** 2
    ) < 1e-9
  );
});

test('hasLowQualityEquipment flips true once any owned item drops below LOW_QUALITY_THRESHOLD', () => {
  const playerState = new PlayerState({ money: 25000 });
  playerState.addEquipmentItem({ id: 'HEAVY_BAGS' });
  assert.equal(hasLowQualityEquipment(playerState), false);

  playerState.equipment[0].quality = BALANCE.EQUIPMENT.LOW_QUALITY_THRESHOLD - 0.01;
  assert.equal(hasLowQualityEquipment(playerState), true);
});

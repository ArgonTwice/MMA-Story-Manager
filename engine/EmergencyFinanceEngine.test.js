/**
 * engine/EmergencyFinanceEngine.test.js
 * Run with: node --test engine/EmergencyFinanceEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import { isTreasuryCrisis, takePredatoryLoan, getFireSalePrice, fireSaleEquipment } from './EmergencyFinanceEngine.js';

test('isTreasuryCrisis flips true once money drops below TREASURY_CRISIS_THRESHOLD', () => {
  const cfg = BALANCE.EMERGENCY_FINANCE;
  const healthy = new PlayerState({ money: cfg.TREASURY_CRISIS_THRESHOLD + 1 });
  const crisis = new PlayerState({ money: cfg.TREASURY_CRISIS_THRESHOLD - 1 });
  assert.equal(isTreasuryCrisis(healthy), false);
  assert.equal(isTreasuryCrisis(crisis), true);
});

test('takePredatoryLoan grants PRINCIPAL immediately and schedules a repayment deal totalling TOTAL_REPAYMENT', () => {
  const cfg = BALANCE.EMERGENCY_FINANCE.PREDATORY_LOAN;
  const playerState = new PlayerState({ money: 500 });

  const moneyBefore = playerState.money;
  const deal = takePredatoryLoan(playerState);

  assert.equal(playerState.money, moneyBefore + cfg.PRINCIPAL);
  assert.equal(deal.weeksRemaining, cfg.WEEKS_TO_REPAY);
  assert.ok(deal.weeklyAmount < 0, 'repayment installments should deduct money each week');

  const totalRepaid = -deal.weeklyAmount * cfg.WEEKS_TO_REPAY;
  assert.ok(Math.abs(totalRepaid - cfg.TOTAL_REPAYMENT) <= cfg.WEEKS_TO_REPAY, 'rounded weekly installments should sum close to TOTAL_REPAYMENT');
  assert.ok(cfg.TOTAL_REPAYMENT > cfg.PRINCIPAL, 'the loan should be a real loss over time (usurious)');
});

test('getFireSalePrice is purchaseCost * SALE_FRACTION_OF_PURCHASE, and 0 for an unknown id', () => {
  const cfg = BALANCE.EMERGENCY_FINANCE.EQUIPMENT_FIRE_SALE;
  const def = BALANCE.EQUIPMENT.DEFINITIONS.HEAVY_BAGS;
  assert.equal(getFireSalePrice('HEAVY_BAGS'), Math.round(def.purchaseCost * cfg.SALE_FRACTION_OF_PURCHASE));
  assert.equal(getFireSalePrice('NOT_A_REAL_ITEM'), 0);
});

test('fireSaleEquipment removes the item and credits the fire-sale price, and fails for an unowned item', () => {
  const playerState = new PlayerState({ money: 100 });
  playerState.addEquipmentItem({ id: 'HEAVY_BAGS' });

  const price = getFireSalePrice('HEAVY_BAGS');
  const moneyBefore = playerState.money;
  assert.equal(fireSaleEquipment(playerState, 'HEAVY_BAGS'), true);
  assert.equal(playerState.equipment.length, 0);
  assert.equal(playerState.money, moneyBefore + price);

  assert.equal(fireSaleEquipment(playerState, 'HEAVY_BAGS'), false);
});

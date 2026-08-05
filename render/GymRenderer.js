/**
 * render/GymRenderer.js
 * ---------------------------------------------------------------------------
 * The gym's own facilities: current level, an equipment catalog (what's
 * owned vs what's purchasable, from BALANCE.EQUIPMENT.DEFINITIONS), and a
 * panel of rival gyms. Reacts to facility/equipment changes and to
 * WorldState's rival-gym events independently.
 * ---------------------------------------------------------------------------
 */

import { BaseRenderer } from './BaseRenderer.js';
import BALANCE from '../data/balance.js';
import { PLAYER_EVENTS } from '../state/PlayerState.js';
import { WORLD_EVENTS } from '../state/WorldState.js';

export class GymRenderer extends BaseRenderer {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} options.worldState - A WorldState instance.
   * @param {Object} [options.mount]
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.playerState = options.playerState;
    this.worldState = options.worldState;
    this.viewModel = { equipLevel: 0, roster: {}, owned: [], catalog: [], upgrade: {}, rivalGyms: [] };
  }

  /** @returns {GymRenderer} this, for chaining. */
  attach() {
    this._subscribe(PLAYER_EVENTS.GYM_FACILITY_UPGRADED, () => this._renderFacility());
    this._subscribe(PLAYER_EVENTS.GYM_EQUIPMENT_ADDED, () => this._renderFacility());

    this._subscribe(WORLD_EVENTS.RIVAL_GYM_ADDED, () => this._renderRivalGyms());
    this._subscribe(WORLD_EVENTS.RIVAL_GYM_UPDATED, () => this._renderRivalGyms());
    this._subscribe(WORLD_EVENTS.RIVAL_GYM_REMOVED, () => this._renderRivalGyms());

    this.render();
    return this;
  }

  /** Recomputes the full view model from current state. */
  render() {
    this.viewModel = { ...this._buildFacility(), rivalGyms: this._buildRivalGyms() };
    return this._flush();
  }

  /**
   * Buys one piece of equipment (one-time purchaseCost, deducted immediately).
   * @param {string} equipmentId - A key of BALANCE.EQUIPMENT.DEFINITIONS.
   * @returns {boolean} True if the purchase succeeded.
   */
  buyEquipment(equipmentId) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
    if (!def) {
      throw new TypeError(`GymRenderer.buyEquipment: unknown equipment "${equipmentId}".`);
    }
    if (this.playerState.money < def.purchaseCost) {
      return false;
    }
    this.playerState.changeMoney(-def.purchaseCost, `EQUIPMENT_PURCHASE:${equipmentId}`);
    this.playerState.addEquipmentItem({ id: equipmentId });
    return true;
  }

  /**
   * Upgrades the gym facility by one level, at the cost computed from
   * BALANCE.ECONOMY.FACILITY_UPGRADE (cost = BASE * GROWTH ^ currentLevel).
   * @returns {boolean} True if the upgrade succeeded.
   */
  upgradeFacility() {
    const { BASE_COST, GROWTH } = BALANCE.ECONOMY.FACILITY_UPGRADE;
    const cost = Math.round(BASE_COST * GROWTH ** this.playerState.equipLevel);
    return this.playerState.upgradeFacility(cost);
  }

  // ---- internals ------------------------------------------------------------

  _renderFacility() {
    this.viewModel = { ...this.viewModel, ...this._buildFacility() };
    this._flush();
  }

  _renderRivalGyms() {
    this.viewModel = { ...this.viewModel, rivalGyms: this._buildRivalGyms() };
    this._flush();
  }

  _buildFacility() {
    const ownedIds = new Set(this.playerState.equipment.map((item) => item.id));
    const owned = this.playerState.equipment
      .map((item) => ({ id: item.id, ...BALANCE.EQUIPMENT.DEFINITIONS[item.id] }))
      .filter((item) => item.label);

    const catalog = Object.entries(BALANCE.EQUIPMENT.DEFINITIONS)
      .filter(([id]) => !ownedIds.has(id))
      .map(([id, def]) => ({ id, ...def, affordable: this.playerState.money >= def.purchaseCost }));

    const { BASE_COST, GROWTH, MAX_LEVEL } = BALANCE.ECONOMY.FACILITY_UPGRADE;
    const atMax = this.playerState.equipLevel >= MAX_LEVEL;
    const nextLevelCost = atMax ? null : Math.round(BASE_COST * GROWTH ** this.playerState.equipLevel);

    return {
      equipLevel: this.playerState.equipLevel,
      roster: { size: this.playerState.roster.length, capacity: this.playerState.getRosterCapacity() },
      owned,
      catalog,
      upgrade: { atMax, nextLevelCost, maxLevel: MAX_LEVEL },
    };
  }

  _buildRivalGyms() {
    return this.worldState.rivalGyms.map((gym) => ({
      id: gym.id,
      name: gym.name ?? gym.id,
      reputation: gym.reputation ?? BALANCE.GYM.STARTING_REPUTATION,
      activity: gym.activity ?? BALANCE.WORLD.RIVAL_GYM_ACTIVITY.STARTING_VALUE,
    }));
  }

  toHTML() {
    const v = this.viewModel;
    const ownedHTML = v.owned
      .map((item) => `<li class="equipment-item owned" data-id="${item.id}">${item.label}</li>`)
      .join('');
    const catalogHTML = v.catalog
      .map(
        (item) =>
          `<li class="equipment-item${item.affordable ? ' affordable' : ' not-affordable'}" data-id="${item.id}">` +
          `<span class="equipment-label">${item.label}</span>` +
          `<span class="equipment-cost">${item.purchaseCost}$</span>` +
          `<button class="btn btn-outline btn-buy" data-action="buy-equipment" data-id="${item.id}" ${item.affordable ? '' : 'disabled'}>Acheter</button>` +
          `</li>`
      )
      .join('');
    const upgradeHTML = v.upgrade.atMax
      ? `<p class="upgrade-max">Niveau maximum atteint.</p>`
      : `<button class="btn btn-gold" data-action="upgrade-facility">Ameliorer (${v.upgrade.nextLevelCost}$)</button>`;
    const rivalsHTML = v.rivalGyms
      .map(
        (gym) =>
          `<li class="rival-gym-item" data-id="${gym.id}">` +
          `<span class="rival-name">${gym.name}</span>` +
          `<span class="rival-reputation">Reputation ${Math.round(gym.reputation)}</span>` +
          `<span class="rival-activity">Activite ${Math.round(gym.activity)}</span>` +
          `</li>`
      )
      .join('');
    return (
      `<section class="gym">` +
      `<header class="gym-header">Niveau ${v.equipLevel} <span class="gym-sub">${v.roster.size}/${v.roster.capacity} places</span></header>` +
      upgradeHTML +
      `<h3 class="section-title">Equipement possede</h3>` +
      `<ul class="equipment-owned">${ownedHTML}</ul>` +
      `<h3 class="section-title">Catalogue</h3>` +
      `<ul class="equipment-catalog">${catalogHTML}</ul>` +
      `<h3 class="section-title">Gyms rivaux</h3>` +
      `<ul class="rival-gym-list">${rivalsHTML}</ul>` +
      `</section>`
    );
  }
}

export default GymRenderer;

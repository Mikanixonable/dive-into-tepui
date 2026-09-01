// 軌道上の弾薬/RCS燃料補給ピックアップの投入・回収・デスポーンを担う。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { randSym } from '../../../math/random';
import { add, len, lenSq, randVec, rotateAxis, sub, v3 } from '../../../math/vec3';
import * as C from '../../const';
import { AmmoPickup, AMMO_PICKUP_RADIUS } from '../../dynamic/dynamic-entity/ammo-pickup';
import { RcsFuelPickup, RCS_FUEL_PICKUP_RADIUS, RCS_FUEL_PICKUP_AMOUNT } from '../../dynamic/dynamic-entity/rcs-fuel-pickup';
import { kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { Hud } from '../../hud/hud';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import { UiSfx } from '../../../audio/sfx/ui-sfx';
import { Player } from '../../player/player';
import type { DynamicSystem } from '../../dynamic/dynamic-system';
import type { SimSpeedManager } from '../../dynamic/sim-speed-manager';
import type { LogisticsSaveData } from '../../save/save-data';

const AMMO_PICKUP_MAGS = 6; // 補給 1 個の取り込みで増えるマガジン数
const LOGISTICS_LOW_MAGS = 7; // 残りマガジンがこれ未満になると付近の軌道に補給を投入
const LOGISTICS_LOW_FUEL_RATIO = 0.3; // この割合未満になると燃料補給を投入
const MAX_ACTIVE_RCS_FUEL_PICKUPS = 3; // 同時に存在する燃料補給の最大数
const LOGISTICS_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
const LOGISTICS_MIN_DIST = 312.5; // 補給投入位置(自機軌道上の位相シフト距離)下限 [m]
const LOGISTICS_MAX_DIST = 625; // 同上限 [m]
const LOGISTICS_DESPAWN_DIST = 50000; // これ以上自機から離れた補給マガジンをデスポーンさせる距離 [m]

export class Logistics {
  private resupplyCheckAt: number;

  // 補給の自動投入を行うかどうか。既に軌道上にある補給の回収・デスポーンには影響しない。
  resupplyEnabled: boolean;
  // RCS燃料の自動投入を行うかどうか。弾薬のトグルとは独立している。
  rcsFuelResupplyEnabled: boolean;

  // saved があればその状態(次回投入判定時刻・自動投入の有効/無効)から始める。
  constructor(
    private readonly _hud: Hud,
    private readonly _worldSfx: WorldSfx,
    private readonly _uiSfx: UiSfx,
    private readonly _scene: THREE.Scene,
    private readonly entities: DynamicSystem,
    saved?: LogisticsSaveData,
  ) {
    this.resupplyCheckAt = saved?.resupplyCheckAt ?? 0;
    this.resupplyEnabled = saved?.resupplyEnabled ?? true;
    this.rcsFuelResupplyEnabled = saved?.rcsFuelResupplyEnabled ?? true;
  }

  // 自機の軌道上、minDist〜maxDist 先の位相に補給を1個投入する。
  spawnForPlayer(
    player: Player,
    minDist = LOGISTICS_MIN_DIST,
    maxDist = LOGISTICS_MAX_DIST,
  ): void {
    // 自機の軌道面内で minDist〜maxDist 先に相当する角度だけ位相をずらす
    const r = player.state.r;
    const v = player.state.v;
    const hHat = orbitAxes(player.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    // ずらした位置・速度と、ランダムな姿勢で補給エンティティを作る
    const ammoPickup = new AmmoPickup(
      {
        state: kinematicState<'eci'>(
          player.state.t,
          rotateAxis(r, hHat, ang),
          add(rotateAxis(v, hHat, ang), randVec(1.5)),
        ),
        att: {
          q: randomQuat(),
          w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
          inertia: v3(1, 1.4, 1.2),
        },
      },
      this._scene,
    );
    // 投入して演出とヒントを出す
    this.entities.addAmmoPickup(ammoPickup);
    this._uiSfx.warp();
    this._hud.hint('付近の軌道に補給が投入された — ▣ 弾薬マーカーへ接近して回収', 5000);
  }

  // 自機の軌道上、minDist〜maxDist 先の位相に RCS 燃料補給を1個投入する。
  spawnRcsFuelForPlayer(
    player: Player,
    minDist = LOGISTICS_MIN_DIST,
    maxDist = LOGISTICS_MAX_DIST,
  ): void {
    const r = player.state.r;
    const v = player.state.v;
    const hHat = orbitAxes(player.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    const fuelPickup = new RcsFuelPickup(
      {
        state: kinematicState<'eci'>(
          player.state.t,
          rotateAxis(r, hHat, ang),
          add(rotateAxis(v, hHat, ang), randVec(1.5)),
        ),
        att: {
          q: randomQuat(),
          w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
          inertia: v3(1, 1.4, 1.2),
        },
      },
      this._scene,
    );
    this.entities.addRcsFuelPickup(fuelPickup);
    this._uiSfx.warp();
    this._hud.hint('付近の軌道に RCS 燃料補給が投入された — ◈ 燃料マーカーへ接近して回収', 5000);
  }

  // 近傍の補給を回収し、遠方のものをデスポーンし、残弾が少なければ定期的に新規投入する。
  // 回収とデスポーンは投入の可否によらず常に走る(既に軌道上にある補給の始末は別の話)。
  updateLogistics(
    simTime: number, player: Player, simSpeed: SimSpeedManager, respawnOnDespawn = false,
  ): void {
    this.absorbNearbyAmmoPickups(player);
    this.absorbNearbyRcsFuelPickups(player);
    const canResupplyAmmo = this.resupplyEnabled && simSpeed.canResupplyAmmo;
    const canResupplyFuel = this.rcsFuelResupplyEnabled && simSpeed.canResupplyAmmo;
    this.despawnFarAmmoPickups(player, respawnOnDespawn && canResupplyAmmo);
    this.despawnFarRcsFuelPickups(player, respawnOnDespawn && canResupplyFuel);

    // 投入できない間は次回判定時刻を進めない — 再開した直後の1フレームで判定させ、
    // 停止していた長さぶんの空白を再開後に持ち越さないため。
    if (!canResupplyAmmo && !canResupplyFuel) return;
    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + LOGISTICS_CHECK_INTERVAL;
    if (canResupplyAmmo && player.magsLeft < LOGISTICS_LOW_MAGS && this.liveAmmoPickupCount() < C.MAX_ACTIVE_AMMO_PICKUPS) {
      this.spawnForPlayer(player);
    }
    if (canResupplyFuel && this.shouldResupplyFuel(player) && this.liveRcsFuelPickupCount() < MAX_ACTIVE_RCS_FUEL_PICKUPS) {
      this.spawnRcsFuelForPlayer(player);
    }
  }

  serialize(): LogisticsSaveData {
    return {
      resupplyCheckAt: this.resupplyCheckAt,
      resupplyEnabled: this.resupplyEnabled,
      rcsFuelResupplyEnabled: this.rcsFuelResupplyEnabled,
    };
  }

  // 生存中の補給の数を返す。
  private liveAmmoPickupCount(): number {
    let count = 0;
    for (const ammoPickup of this.entities.ammoPickups) if (ammoPickup.alive) count++;
    return count;
  }

  // 生存中の RCS 燃料補給の数を返す。
  private liveRcsFuelPickupCount(): number {
    let count = 0;
    for (const pickup of this.entities.rcsFuelPickups) if (pickup.alive) count++;
    return count;
  }

  private shouldResupplyFuel(player: Player): boolean {
    return player.totalMaxFuel > 0
      && player.totalFuel < player.totalMaxFuel * LOGISTICS_LOW_FUEL_RATIO;
  }

  // 回収半径内の生存中補給を吸収し、ベルトへ弾を追加する。
  private absorbNearbyAmmoPickups(player: Player): void {
    for (const ammoPickup of this.entities.ammoPickups) {
      if (!ammoPickup.alive) continue;
      if (
        lenSq(sub(ammoPickup.state.r, player.state.r))
        >= AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS
      ) continue;
      ammoPickup.alive = false;
      player.onPickup(AMMO_PICKUP_MAGS);
      this._worldSfx.pickup();
      this._hud.hint(`補給取り込み — ベルト +${AMMO_PICKUP_MAGS} 連`, 3000);
    }
  }

  // 回収半径内の生存中 RCS 燃料補給を吸収し、タンクへ燃料を追加する。
  private absorbNearbyRcsFuelPickups(player: Player): void {
    for (const pickup of this.entities.rcsFuelPickups) {
      if (!pickup.alive) continue;
      if (
        lenSq(sub(pickup.state.r, player.state.r))
        >= RCS_FUEL_PICKUP_RADIUS * RCS_FUEL_PICKUP_RADIUS
      ) continue;
      pickup.alive = false;
      const added = player.refuelFuel(RCS_FUEL_PICKUP_AMOUNT);
      this._worldSfx.pickup();
      this._hud.hint(`補給取り込み — RCS燃料 +${Math.round(added)} kg`, 3000);
    }
  }

  // デスポーン距離を超えた生存中補給を消し、respawnOnDespawn が真なら同数を再投入する。
  private despawnFarAmmoPickups(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    // デスポーン距離を超えた分を消し、再投入すべき数を数える
    for (const ammoPickup of this.entities.ammoPickups) {
      if (!ammoPickup.alive) continue;
      if (len(sub(ammoPickup.state.r, player.state.r)) <= LOGISTICS_DESPAWN_DIST) continue;
      ammoPickup.alive = false;
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    // 消えた分だけ新たに投入する
    let count = this.liveAmmoPickupCount();
    for (let i = 0; i < respawn && count < C.MAX_ACTIVE_AMMO_PICKUPS; i++) {
      this.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
      count++;
    }
  }

  // デスポーン距離を超えた燃料補給を消し、respawnOnDespawn が真なら同数を再投入する。
  private despawnFarRcsFuelPickups(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    for (const pickup of this.entities.rcsFuelPickups) {
      if (!pickup.alive) continue;
      if (len(sub(pickup.state.r, player.state.r)) <= LOGISTICS_DESPAWN_DIST) continue;
      pickup.alive = false;
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    let count = this.liveRcsFuelPickupCount();
    for (let i = 0; i < respawn && count < MAX_ACTIVE_RCS_FUEL_PICKUPS; i++) {
      this.spawnRcsFuelForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
      count++;
    }
  }
}

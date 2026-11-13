// 軌道上の弾薬/RCS燃料補給ピックアップの投入・回収・デスポーンを担う。
import { randomQuat } from '../../../math/quat';
import { randSym } from '../../../math/random';
import { add, addScaled, len, lenSq, randVec, rotateAxis, sub, v3 } from '../../../math/vec3';
import {
  AmmoPickup, AMMO_PICKUP_MAGS, AMMO_PICKUP_RADIUS, isAmmoPickup,
  isRcsFuelPickup, RcsFuelPickup, RCS_FUEL_PICKUP_RADIUS, RCS_FUEL_PICKUP_AMOUNT,
} from '../../dynamic/dynamic-entity/pickup';
import { kinematicState, orbitAxes, type KinematicState } from '../../../physics/kinematic-state';
import type * as THREE from 'three/webgpu';
import type { Attitude } from '../../../physics/attitude';
import type { ModularShip } from '../../ship/modular-ship';
import type { EntityRoster } from '../../dynamic/entity-roster';
import type { EntityRegistry } from '../../dynamic/entity-registry';
import type { SimSpeedManager } from '../../dynamic/sim-speed-manager';
import type { FormationRole } from '../../dynamic/dynamic-entity/entity-kind';

export interface SerializedLogistics {
  readonly resupplyCheckAt: number;
  readonly resupplyEnabled: boolean;
  readonly rcsFuelResupplyEnabled: boolean;
}

export const MAX_ACTIVE_AMMO_PICKUPS = 3; // 同時に存在する補給の最大数
export const LOGISTICS_SCRIPTED_MIN_DIST = 12.5; // 台本投入の配置距離(自機軌道上の位相シフト距離)下限 [m]
export const LOGISTICS_SCRIPTED_MAX_DIST = 50; // 同上限 [m]

const LOGISTICS_LOW_MAGS = 7; // 残りマガジンがこれ未満になると付近の軌道に補給を投入
const LOGISTICS_LOW_FUEL_RATIO = 0.3; // この割合未満になると燃料補給を投入
const MAX_ACTIVE_RCS_FUEL_PICKUPS = 3; // 同時に存在する燃料補給の最大数
const LOGISTICS_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
const LOGISTICS_AUTO_MIN_DIST = 312.5; // 自動投入の配置距離(自機軌道上の位相シフト距離)下限 [m]
const LOGISTICS_AUTO_MAX_DIST = 625; // 同上限 [m]
const LOGISTICS_DESPAWN_DIST = 50000; // これ以上自機から離れた補給をデスポーンさせる距離 [m]
// 撃破ドロップの速度へ残す、自機から見た敵機の相対速度の割合。近くで落とした補給ほど自機の近くを漂う。
const DROP_RELATIVE_VELOCITY_KEEP = 0.15;

// 補給物に与えるランダムな姿勢。どの投入経路でも同じ振る舞いで組む。
function randomPickupAttitude(): Attitude {
  return {
    q: randomQuat(),
    w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
    inertia: v3(1, 1.4, 1.2),
  };
}

// 撃破ドロップのマガジン数の内訳(SPEC GAME.md 8)。盾役は補給の既定と同じ数、攻撃担当とエネルギー供給役は
// それより少なく、陣形に属さない敵はさらに少ない。
const DROP_MAGS_ATTACKER = 4;
const DROP_MAGS_OTHER = 2;

// 落とした敵の陣形での役割から、撃破ドロップのマガジン数を決める。
export function dropMagsOf(formationRole: FormationRole | null): number {
  if (formationRole === 'shield') return AMMO_PICKUP_MAGS;
  if (formationRole === 'attacker' || formationRole === 'energy') return DROP_MAGS_ATTACKER;
  return DROP_MAGS_OTHER;
}

export class Logistics {
  // 弾薬補給を自動投入するかどうか。回収・デスポーンはこの値によらず走る。
  private _resupplyEnabled: boolean;
  // RCS燃料を自動投入するかどうか。弾薬設定とは独立している。
  private _rcsFuelResupplyEnabled: boolean;

  // 次回投入判定時刻 resupplyCheckAt [sim s] と自動投入の有効/無効から始める。省いた値は新しいランの
  // 初期値(すぐ判定する・どちらも有効)。automaticResupply はステージの規則で、偽なら自動投入は
  // 渡した有効/無効によらず無効で始まる。
  public constructor(
    private readonly _scene: THREE.Scene,
    private readonly dynamicSystem: EntityRegistry & EntityRoster,
    automaticResupply: boolean,
    private resupplyCheckAt = 0,
    resupplyEnabled = true,
    rcsFuelResupplyEnabled = true,
  ) {
    this._resupplyEnabled = automaticResupply && resupplyEnabled;
    this._rcsFuelResupplyEnabled = automaticResupply && rcsFuelResupplyEnabled;
  }

  // 直列化した状態から復元する。automaticResupply はステージの規則。
  public static deserialize(
    serialized: SerializedLogistics,
    scene: THREE.Scene,
    dynamicSystem: EntityRegistry & EntityRoster,
    automaticResupply: boolean,
  ): Logistics {
    const { resupplyCheckAt, resupplyEnabled, rcsFuelResupplyEnabled } = serialized;
    // null も欠けと同じく新しいランの初期値から始める(既定引数は undefined でしか働かない)。
    return new Logistics(
      scene, dynamicSystem, automaticResupply,
      resupplyCheckAt ?? undefined, resupplyEnabled ?? undefined, rcsFuelResupplyEnabled ?? undefined,
    );
  }

  public get resupplyEnabled(): boolean { return this._resupplyEnabled; }
  public get rcsFuelResupplyEnabled(): boolean { return this._rcsFuelResupplyEnabled; }

  // 弾薬補給の自動投入の可否を切り替える。
  public setResupplyEnabled(on: boolean): void {
    this._resupplyEnabled = on;
  }

  // RCS燃料の自動投入の可否を切り替える。
  public setFuelResupplyEnabled(on: boolean): void {
    this._rcsFuelResupplyEnabled = on;
  }

  // 自機の軌道上、minDist〜maxDist 先の位相に補給を1個投入する。
  public spawnForPlayer(
    player: ModularShip,
    minDist = LOGISTICS_AUTO_MIN_DIST,
    maxDist = LOGISTICS_AUTO_MAX_DIST,
  ): void {
    // 自機の軌道面内で minDist〜maxDist 先に相当する角度だけ位相をずらす
    const r = player.motion.state.r;
    const v = player.motion.state.v;
    const hHat = orbitAxes(player.motion.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    // ずらした位置・速度と、ランダムな姿勢で補給エンティティを作る
    const ammoPickup = AmmoPickup.create(
      {
        state: kinematicState<'eci'>(
          player.motion.state.t,
          rotateAxis(r, hHat, ang),
          add(rotateAxis(v, hHat, ang), randVec(1.5)),
        ),
        att: randomPickupAttitude(),
      },
      this._scene,
      this.dynamicSystem.idAllocators,
    );
    // エンティティ一覧へ追加し、投入を記録する
    this.dynamicSystem.add(ammoPickup);
    this.dynamicSystem.events.record({ kind: 'ammoResupplyDeployed' });
  }

  // 自機の軌道上、minDist〜maxDist 先の位相に RCS 燃料補給を1個投入する。
  public spawnRcsFuelForPlayer(
    player: ModularShip,
    minDist = LOGISTICS_AUTO_MIN_DIST,
    maxDist = LOGISTICS_AUTO_MAX_DIST,
  ): void {
    // 自機の軌道面内で minDist〜maxDist 先に相当する角度だけ位相をずらす
    const r = player.motion.state.r;
    const v = player.motion.state.v;
    const hHat = orbitAxes(player.motion.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    // ずらした位置・速度と、ランダムな姿勢で燃料補給エンティティを作る
    const fuelPickup = RcsFuelPickup.create(
      {
        state: kinematicState<'eci'>(
          player.motion.state.t,
          rotateAxis(r, hHat, ang),
          add(rotateAxis(v, hHat, ang), randVec(1.5)),
        ),
        att: randomPickupAttitude(),
      },
      this._scene,
      this.dynamicSystem.idAllocators,
    );
    // エンティティ一覧へ追加し、投入を記録する
    this.dynamicSystem.add(fuelPickup);
    this.dynamicSystem.events.record({ kind: 'rcsFuelResupplyDeployed' });
  }

  // state の位置へ弾薬補給を1個放出する。補給の速度は、自機(playerState、居なければ null)の速度へ
  // 「自機から見た敵機の相対速度」の DROP_RELATIVE_VELOCITY_KEEP 倍を足し、小さな乱れを加えたもの。
  // 自機が居ないときは state の速度を引き継ぐ。補給は mags のマガジン数を持ち、以後は通常の補給と同じ
  // 回収・遠方デスポーンの規則に従う。
  public dropAt(state: KinematicState, playerState: KinematicState | null, mags: number): void {
    const baseV = playerState === null
      ? state.v
      : addScaled(playerState.v, sub(state.v, playerState.v), DROP_RELATIVE_VELOCITY_KEEP);
    const ammoPickup = AmmoPickup.create(
      {
        state: kinematicState<'eci'>(state.t, state.r, add(baseV, randVec(1.5))),
        att: randomPickupAttitude(),
      },
      this._scene,
      this.dynamicSystem.idAllocators,
      mags,
    );
    this.dynamicSystem.add(ammoPickup);
  }

  // 近傍の補給を回収し、遠方のものをデスポーンし、残弾・残燃料が少なければ定期的に新規投入する。
  // 回収とデスポーンは投入の可否によらず常に走る。respawnOnDespawn なら、投入できる間は
  // デスポーンした数だけ再投入する。
  public updateLogistics(
    simTime: number, player: ModularShip, simSpeed: SimSpeedManager, respawnOnDespawn = false,
  ): void {
    this.absorbNearbyAmmoPickups(player);
    this.absorbNearbyRcsFuelPickups(player);
    const canResupplyAmmo = this._resupplyEnabled && simSpeed.canResupplyAmmo;
    const canResupplyFuel = this._rcsFuelResupplyEnabled && simSpeed.canResupplyAmmo;
    this.despawnFarAmmoPickups(player, respawnOnDespawn && canResupplyAmmo);
    this.despawnFarRcsFuelPickups(player, respawnOnDespawn && canResupplyFuel);

    // 投入できない間は次回判定時刻を進めず、再開した直後のフレームで判定させる。
    if (!canResupplyAmmo && !canResupplyFuel) return;
    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + LOGISTICS_CHECK_INTERVAL;
    if (canResupplyAmmo && player.magsLeft < LOGISTICS_LOW_MAGS && this.liveAmmoPickupCount() < MAX_ACTIVE_AMMO_PICKUPS) {
      this.spawnForPlayer(player);
    }
    if (canResupplyFuel && this.shouldResupplyFuel(player) && this.liveRcsFuelPickupCount() < MAX_ACTIVE_RCS_FUEL_PICKUPS) {
      this.spawnRcsFuelForPlayer(player);
    }
  }

  // 次回投入判定時刻と、自動投入の有効/無効を直列化した形へ畳む。
  public serialize(): SerializedLogistics {
    return {
      resupplyCheckAt: this.resupplyCheckAt,
      resupplyEnabled: this._resupplyEnabled,
      rcsFuelResupplyEnabled: this._rcsFuelResupplyEnabled,
    };
  }

  // 生存中の弾薬補給の数を返す。
  private liveAmmoPickupCount(): number {
    let count = 0;
    for (const ammoPickup of this.dynamicSystem.all().filter(isAmmoPickup)) {
      if (ammoPickup.motion.alive) count++;
    }
    return count;
  }

  // 生存中の RCS 燃料補給の数を返す。
  private liveRcsFuelPickupCount(): number {
    let count = 0;
    for (const pickup of this.dynamicSystem.all().filter(isRcsFuelPickup)) {
      if (pickup.motion.alive) count++;
    }
    return count;
  }

  // 自機が燃料タンクを持ち、残量が LOGISTICS_LOW_FUEL_RATIO 未満か。
  private shouldResupplyFuel(player: ModularShip): boolean {
    return player.totalMaxRcsFuel > 0
      && player.totalRcsFuel < player.totalMaxRcsFuel * LOGISTICS_LOW_FUEL_RATIO;
  }

  // 回収半径内の生存中補給を吸収し、ベルトへ弾を追加する。
  private absorbNearbyAmmoPickups(player: ModularShip): void {
    for (const ammoPickup of this.dynamicSystem.all().filter(isAmmoPickup)) {
      if (!ammoPickup.motion.alive) continue;
      if (
        lenSq(sub(ammoPickup.motion.state.r, player.motion.state.r))
        >= AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS
      ) continue;
      // 取り込んで消し、取り込んだことを記録する
      ammoPickup.motion.kill();
      player.onPickup(ammoPickup.mags);
      this.dynamicSystem.events.record({ kind: 'ammoPickedUp', mags: ammoPickup.mags });
    }
  }

  // 回収半径内の生存中 RCS 燃料補給を吸収し、タンクへ燃料を追加する。
  private absorbNearbyRcsFuelPickups(player: ModularShip): void {
    for (const pickup of this.dynamicSystem.all().filter(isRcsFuelPickup)) {
      if (!pickup.motion.alive) continue;
      if (
        lenSq(sub(pickup.motion.state.r, player.motion.state.r))
        >= RCS_FUEL_PICKUP_RADIUS * RCS_FUEL_PICKUP_RADIUS
      ) continue;
      // 取り込んで消し、取り込んだことを記録する
      pickup.motion.kill();
      const added = Math.min(
        RCS_FUEL_PICKUP_AMOUNT, Math.max(0, player.totalMaxRcsFuel - player.totalRcsFuel),
      );
      player.refuelRcsFuel(RCS_FUEL_PICKUP_AMOUNT);
      this.dynamicSystem.events.record({ kind: 'rcsFuelPickedUp', fuel: added });
    }
  }

  // デスポーン距離を超えた生存中補給を消し、respawnOnDespawn が真なら同時数の上限まで同数を再投入する。
  private despawnFarAmmoPickups(player: ModularShip, respawnOnDespawn: boolean): void {
    let respawn = 0;
    // デスポーン距離を超えた分を消し、再投入すべき数を数える
    for (const ammoPickup of this.dynamicSystem.all().filter(isAmmoPickup)) {
      if (!ammoPickup.motion.alive) continue;
      if (len(sub(
        ammoPickup.motion.state.r, player.motion.state.r,
      )) <= LOGISTICS_DESPAWN_DIST) continue;
      ammoPickup.motion.kill();
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    // 消えた分だけ新たに投入する
    let count = this.liveAmmoPickupCount();
    for (let i = 0; i < respawn && count < MAX_ACTIVE_AMMO_PICKUPS; i++) {
      this.spawnForPlayer(player);
      count++;
    }
  }

  // デスポーン距離を超えた燃料補給を消し、respawnOnDespawn が真なら同時数の上限まで同数を再投入する。
  private despawnFarRcsFuelPickups(player: ModularShip, respawnOnDespawn: boolean): void {
    let respawn = 0;
    // デスポーン距離を超えた分を消し、再投入すべき数を数える
    for (const pickup of this.dynamicSystem.all().filter(isRcsFuelPickup)) {
      if (!pickup.motion.alive) continue;
      if (len(sub(
        pickup.motion.state.r, player.motion.state.r,
      )) <= LOGISTICS_DESPAWN_DIST) continue;
      pickup.motion.kill();
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    // 消えた分だけ新たに投入する
    let count = this.liveRcsFuelPickupCount();
    for (let i = 0; i < respawn && count < MAX_ACTIVE_RCS_FUEL_PICKUPS; i++) {
      this.spawnRcsFuelForPlayer(player);
      count++;
    }
  }
}

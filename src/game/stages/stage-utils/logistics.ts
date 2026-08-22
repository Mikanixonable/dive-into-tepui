// 軌道上の弾薬補給ピックアップの投入・回収・デスポーンを担う。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { randSym } from '../../../physics/random';
import { add, len, lenSq, randVec, rotateAxis, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { AmmoPickup } from '../../game-entity/ammo-pickup';
import { kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { Hud } from '../../hud/hud';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import { UiSfx } from '../../../audio/sfx/ui-sfx';
import { Player } from '../../player/player';
import type { EntityManager } from '../../simulation/entity-manager';
import type { SimSpeedManager } from '../../sim-speed-manager';
import type { LogisticsSaveData } from '../../save-data';

export class Logistics {
  private resupplyCheckAt: number;

  // 補給の自動投入を行うかどうか。既に軌道上にある補給の回収・デスポーンには影響しない。
  resupplyEnabled: boolean;

  // saved があればその状態(次回投入判定時刻・自動投入の有効/無効)から始める。
  constructor(
    private readonly _hud: Hud,
    private readonly _worldSfx: WorldSfx,
    private readonly _uiSfx: UiSfx,
    private readonly _scene: THREE.Scene,
    private readonly entities: EntityManager,
    saved?: LogisticsSaveData,
  ) {
    this.resupplyCheckAt = saved?.resupplyCheckAt ?? 0;
    this.resupplyEnabled = saved?.resupplyEnabled ?? true;
  }

  // 自機の軌道上、minDist〜maxDist 先の位相に補給を1個投入する。
  spawnForPlayer(
    player: Player,
    minDist = C.LOGISTICS_MIN_DIST,
    maxDist = C.LOGISTICS_MAX_DIST,
  ): void {
    // 自機の軌道面内で minDist〜maxDist 先に相当する角度だけ位相をずらす
    const r = player.state.r;
    const v = player.state.v;
    const hHat = orbitAxes(player.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    // ずらした位置・速度と、ランダムな姿勢で補給エンティティを作る
    const ammoPickup = new AmmoPickup(
      {
        state: kinematicState(
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

  // 近傍の補給を回収し、遠方のものをデスポーンし、残弾が少なければ定期的に新規投入する。
  // 回収とデスポーンは投入の可否によらず常に走る(既に軌道上にある補給の始末は別の話)。
  updateLogistics(
    simTime: number, player: Player, simSpeed: SimSpeedManager, respawnOnDespawn = false,
  ): void {
    this.absorbNearbyAmmoPickups(player);
    const canResupply = this.resupplyEnabled && simSpeed.canResupplyAmmo;
    this.despawnFarAmmoPickups(player, respawnOnDespawn && canResupply);

    // 投入できない間は次回判定時刻を進めない — 再開した直後の1フレームで判定させ、
    // 停止していた長さぶんの空白を再開後に持ち越さないため。
    if (!canResupply) return;
    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.LOGISTICS_CHECK_INTERVAL;
    if (player.magsLeft < C.LOGISTICS_LOW_MAGS && this.liveAmmoPickupCount() < C.MAX_ACTIVE_AMMO_PICKUPS) {
      this.spawnForPlayer(player);
    }
  }

  serialize(): LogisticsSaveData {
    return { resupplyCheckAt: this.resupplyCheckAt, resupplyEnabled: this.resupplyEnabled };
  }

  // 生存中の補給の数を返す。
  private liveAmmoPickupCount(): number {
    let count = 0;
    for (const ammoPickup of this.entities.ammoPickups) if (ammoPickup.alive) count++;
    return count;
  }

  // 回収半径内の生存中補給を吸収し、ベルトへ弾を追加する。
  private absorbNearbyAmmoPickups(player: Player): void {
    for (const ammoPickup of this.entities.ammoPickups) {
      if (!ammoPickup.alive) continue;
      if (
        lenSq(sub(ammoPickup.state.r, player.state.r))
        >= C.AMMO_PICKUP_RADIUS * C.AMMO_PICKUP_RADIUS
      ) continue;
      ammoPickup.alive = false;
      player.onPickup(C.AMMO_PICKUP_MAGS);
      this._worldSfx.pickup();
      this._hud.hint(`補給取り込み — ベルト +${C.AMMO_PICKUP_MAGS} 連`, 3000);
    }
  }

  // デスポーン距離を超えた生存中補給を消し、respawnOnDespawn が真なら同数を再投入する。
  private despawnFarAmmoPickups(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    // デスポーン距離を超えた分を消し、再投入すべき数を数える
    for (const ammoPickup of this.entities.ammoPickups) {
      if (!ammoPickup.alive) continue;
      if (len(sub(ammoPickup.state.r, player.state.r)) <= C.LOGISTICS_DESPAWN_DIST) continue;
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
}

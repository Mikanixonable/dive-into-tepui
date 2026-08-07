// 補給(ammo)の投入・取り込み・デスポーンと、▣ AMMO マーカーの表示。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { add, len, lenSq, randSym, randVec, rotateAxis, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { Ammo } from '../../game-entity/ammo';
import { orbitState, orbitalAxes } from '../../../physics/orbital';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import { Player } from '../../player/player';
import { ProjectFn } from '../../camera/camera-system';
import { MarkerManager } from '../../marker/marker-manager';
import { fmtMarkerDist } from '../../hud/utils';
import type { EntityManager } from '../../simulation/entity-manager';

export class Logistics {
  private resupplyCheckAt = 0;
  private lastMarkerCount = 0;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly _scene: THREE.Scene,
    private readonly entities: EntityManager,
    private readonly markerManager: MarkerManager,
  ) {}

  // 自機の軌道上、minDist〜maxDist 先の位相に補給を1個投入する。
  spawnForPlayer(
    player: Player,
    minDist = C.LOGISTICS_MIN_DIST,
    maxDist = C.LOGISTICS_MAX_DIST,
  ): void {
    // 自機の軌道面内で minDist〜maxDist 先に相当する角度だけ位相をずらす
    const r = player.state.r;
    const v = player.state.v;
    const hHat = orbitalAxes(player.state).nrm;
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    // ずらした位置・速度と、ランダムな姿勢で補給エンティティを作る
    const ammo = new Ammo(
      orbitState(
        player.state.t,
        rotateAxis(r, hHat, ang),
        add(rotateAxis(v, hHat, ang), randVec(1.5)),
      ),
      {
        q: randomQuat(),
        w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
        inertia: v3(1, 1.4, 1.2),
      },
      this._scene,
    );
    // 投入して演出とヒントを出す
    this.entities.addAmmo(ammo);
    this._sfx.warp();
    this._hud.hint('付近の軌道に補給が投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  // 近傍の補給を回収し、遠方のものをデスポーンし、残弾が少なければ定期的に新規投入する。
  updateLogistics(simTime: number, player: Player, respawnOnDespawn = false): void {
    if (player.alive) this.absorbNearbyAmmo(player);
    this.despawnFarAmmo(player, respawnOnDespawn);

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.LOGISTICS_CHECK_INTERVAL;
    if (player.magsLeft < C.LOGISTICS_LOW_MAGS && this.liveAmmoCount() < C.MAX_AMMO) {
      this.spawnForPlayer(player);
    }
  }

  // 生存中の補給の数を返す。
  private liveAmmoCount(): number {
    let count = 0;
    for (const ammo of this.entities.ammos) if (ammo.alive) count++;
    return count;
  }

  // 生存中の補給へ ▣ マーカー(画面外なら△の方位矢印)を同期する。
  syncMarkers(player: Player, project: ProjectFn, displayTime: number, overviewMode: boolean, showMapAmmo: boolean): void {
    // 表示時刻における生存中ピックアップの位置一覧
    const shown = this.entities.ammos.flatMap((ammo) => {
      const pos = ammo.alive ? ammo.displayState(displayTime)?.r : undefined;
      return pos ? [pos] : [];
    });
    for (const [i, pos] of shown.entries()) {
      const key = `mg${i}`;
      const bearing = `${key}-bearing`;
      const label = `AMMO ${fmtMarkerDist(len(sub(pos, player.state.r)))}`;
      const p = project(pos);
      if (overviewMode && !showMapAmmo) {
        this.markerManager.hide(key);
        this.markerManager.hide(bearing);
      } else {
        this.markerManager.set(key, 'mk-ammo', '▣', p.x, p.y, p.front, label);
        if (overviewMode) {
          this.markerManager.hide(bearing);
        } else {
          this.markerManager.setBearing(bearing, 'mk-ammo', '△', p, label, 0.9);
        }
      }
    }
    // 前フレームより件数が減った分のマーカーを隠す
    for (let i = shown.length; i < this.lastMarkerCount; i++) {
      const key = `mg${i}`;
      this.markerManager.hide(key);
      this.markerManager.hide(`${key}-bearing`);
    }
    this.lastMarkerCount = shown.length;
  }

  // 回収半径内の生存中補給を吸収し、ベルトへ弾を追加する。
  private absorbNearbyAmmo(player: Player): void {
    for (const ammo of this.entities.ammos) {
      if (!ammo.alive) continue;
      if (lenSq(sub(ammo.state.r, player.state.r)) >= C.AMMO_PICKUP_RADIUS * C.AMMO_PICKUP_RADIUS) continue;
      ammo.alive = false;
      player.onPickup(C.AMMO_PICKUP_MAGS);
      this._sfx.pickup();
      this._hud.hint(`補給取り込み — ベルト +${C.AMMO_PICKUP_MAGS} 連`, 3000);
    }
  }

  // デスポーン距離を超えた生存中補給を消し、respawnOnDespawn が真なら同数を再投入する。
  private despawnFarAmmo(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    // デスポーン距離を超えた分を消し、再投入すべき数を数える
    for (const ammo of this.entities.ammos) {
      if (!ammo.alive) continue;
      if (len(sub(ammo.state.r, player.state.r)) <= C.LOGISTICS_DESPAWN_DIST) continue;
      ammo.alive = false;
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    // 消えた分だけ新たに投入する
    let count = this.liveAmmoCount();
    for (let i = 0; i < respawn && count < C.MAX_AMMO; i++) {
      this.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
      count++;
    }
  }
}

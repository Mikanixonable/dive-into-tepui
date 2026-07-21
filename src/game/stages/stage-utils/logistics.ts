// 補給(ammo)の兵站ロジック(能動的な判断のみ): 投入の判断・生成、自機の接近による
// 取り込み、遠距離デスポーンの判断。配列の所有と軌道積分・姿勢・実削除は Simulator 側
// (ammos は Simulator 所有の配列への読み取り参照で、追加は addAmmo 経由、
// 破壊は alive = false を立てるだけで simulator.cleanup が回収する)。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { add, cross, len, lenSq, norm, randSym, randVec, rotateAxis, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { Ammo } from '../../orbit-entity/entities';
import { Hud } from '../../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import { Player } from '../../player/player';

export class Logistics {
  private resupplyCheckAt = 0;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly _scene: THREE.Scene,
    private readonly ammos: readonly Ammo[],
    private readonly addAmmo: (ammo: Ammo) => void,
  ) {}

  spawnForPlayer(
    player: Player,
    minDist = C.LOGISTICS_MIN_DIST,
    maxDist = C.LOGISTICS_MAX_DIST,
  ): void {
    const r = player.state.r;
    const v = player.state.v;
    const hHat = norm(cross(r, v));
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    const ammo = new Ammo(
      {
        r: rotateAxis(r, hHat, ang),
        v: add(rotateAxis(v, hHat, ang), randVec(1.5)),
      },
      {
        q: randomQuat(),
        w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
        inertia: v3(1, 1.4, 1.2),
      },
      this._scene,
    );
    this.addAmmo(ammo);
    this._sfx.warp();
    this._hud.hint('付近の軌道に補給が投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  // respawnOnDespawn: 遠方デスポーンした補給を同数投入し直すか。呼び出し元(各 Stage の
  // update、stages/wave-manager.ts 経由)がこの真偽値を直接渡す。
  updateLogistics(simTime: number, player: Player, respawnOnDespawn = false): void {
    if (player.alive) this.absorbNearbyAmmo(player);
    this.despawnFarAmmo(player, respawnOnDespawn);

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.LOGISTICS_CHECK_INTERVAL;
    if (player.magsLeft < C.LOGISTICS_LOW_MAGS && this.ammos.length < C.MAX_AMMO) {
      this.spawnForPlayer(player);
    }
  }

  private absorbNearbyAmmo(player: Player): void {
    for (const ammo of this.ammos) {
      if (!ammo.alive) continue;
      if (lenSq(sub(ammo.state.r, player.state.r)) >= C.AMMO_PICKUP_RADIUS * C.AMMO_PICKUP_RADIUS) continue;
      ammo.alive = false;
      player.onPickup(C.AMMO_PICKUP_MAGS);
      this._sfx.pickup();
      this._hud.hint(`補給取り込み — ベルト +${C.AMMO_PICKUP_MAGS} 連`, 3000);
    }
  }

  // 自機から離れすぎた補給はデスポーンし、respawnOnDespawn なら同数を投入し直す
  // (ループ中に respawn 分を割り込ませない — ループ終了後にまとめて処理する)。
  private despawnFarAmmo(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    for (const ammo of this.ammos) {
      if (!ammo.alive) continue;
      if (len(sub(ammo.state.r, player.state.r)) <= C.LOGISTICS_DESPAWN_DIST) continue;
      ammo.alive = false;
      if (respawnOnDespawn) respawn++;
    }
    for (let i = 0; i < respawn; i++) {
      this.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    }
  }
}

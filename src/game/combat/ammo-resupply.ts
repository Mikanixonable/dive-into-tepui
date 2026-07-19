// 補給マガジンの兵站ロジック(能動的な判断のみ): 投入の判断・生成、自機の接近による
// 取り込み、遠距離デスポーンの判断。配列の所有と軌道積分・姿勢・実削除は Simulator 側
// (pickups は Simulator 所有の配列への読み取り参照で、追加は addPickup 経由、
// 破壊は alive = false を立てるだけで simulator.cleanup が回収する)。
import { randomQuat } from '../../physics/attitude';
import { add, cross, len, lenSq, norm, randSym, randVec, rotateAxis, sub, v3 } from '../../physics/vec3';
import { buildMagPickup } from '../../render/ships';
import * as C from '../const';
import { MagPickup } from '../entities';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Player } from '../player/player';

export class AmmoResupplySystem {
  private resupplyCheckAt = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly pickups: readonly MagPickup[],
    private readonly addPickup: (mp: MagPickup) => void,
  ) {}

  spawnForPlayer(
    player: Player,
    minDist = C.AMMO_RESUPPLY_MIN_DIST,
    maxDist = C.AMMO_RESUPPLY_MAX_DIST,
  ): void {
    const r = player.state.r;
    const v = player.state.v;
    const hHat = norm(cross(r, v));
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    const mp = new MagPickup(
      {
        r: rotateAxis(r, hHat, ang),
        v: add(rotateAxis(v, hHat, ang), randVec(1.5)),
      },
      buildMagPickup(),
      {
        q: randomQuat(),
        w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
        inertia: v3(1, 1.4, 1.2),
      },
    );
    this.addPickup(mp);
    this.sfx.warp();
    this.hud.hint('付近の軌道に補給マガジンが投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  updateLogistics(simTime: number, stage: number, player: Player): void {
    if (player.alive) this.absorbNearbyPickups(player);
    this.despawnFarPickups(stage, player);

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.RESUPPLY_CHECK_INTERVAL;
    if (player.magsLeft < C.AMMO_LOW_MAGS && this.pickups.length < C.MAX_MAG_PICKUPS) {
      this.spawnForPlayer(player);
    }
  }

  private absorbNearbyPickups(player: Player): void {
    for (const mp of this.pickups) {
      if (!mp.alive) continue;
      if (lenSq(sub(mp.state.r, player.state.r)) >= C.MAG_PICKUP_RADIUS * C.MAG_PICKUP_RADIUS) continue;
      mp.alive = false;
      player.onPickup(C.MAG_PICKUP_MAGS);
      this.sfx.pickup();
      this.hud.hint(`補給マガジン取り込み — ベルト +${C.MAG_PICKUP_MAGS} 連`, 3000);
    }
  }

  // 自機から離れすぎた補給はデスポーンし、ステージ00では同数を投入し直す
  private despawnFarPickups(stage: number, player: Player): void {
    let respawn = 0;
    for (const mp of this.pickups) {
      if (!mp.alive) continue;
      if (len(sub(mp.state.r, player.state.r)) <= C.AMMO_DESPAWN_DIST) continue;
      mp.alive = false;
      if (stage === -1) respawn++;
    }
    for (let i = 0; i < respawn; i++) {
      this.spawnForPlayer(player, C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
    }
  }
}

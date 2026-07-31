// 補給(ammo)の兵站: 投入の判断・生成、自機の接近による取り込み、遠距離デスポーンの
// 判断と、回収先を示す ▣ AMMO マーカーの表示。配列の所有と軌道積分・姿勢・実削除は
// Simulator 側(ammos は Simulator 所有の配列への読み取り参照で、追加は addAmmo 経由、
// 破壊は alive = false を立てるだけで simulator.cleanup が回収する)。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { add, cross, len, lenSq, norm, randSym, randVec, rotateAxis, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { Ammo } from '../../orbit-entity/entities';
import { orbitState } from '../../../physics/orbital';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import { Player } from '../../player/player';
import { ProjectFn } from '../../camera/camera-system';
import { MarkerManager } from '../../marker/marker-manager';
import { fmtMarkerDist } from '../../hud/utils';

export class Logistics {
  private resupplyCheckAt = 0;
  // 前フレームに syncMarkers が出したマーカー数。生存数が減ったとき、余った
  // 添字のキーを隠すために覚えておく(キーの種類は同時存在数の最大値で頭打ちになる)。
  private lastMarkerCount = 0;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly _scene: THREE.Scene,
    private readonly ammos: readonly Ammo[],
    private readonly addAmmo: (ammo: Ammo) => void,
    private readonly markerManager: MarkerManager,
  ) {}

  // 上限判定はここでは行わない。MAX_AMMO は「定期投入が維持しようとする数」であって
  // ハード上限ではなく、Stage0 の初期配置は STAGE0_LOGISTICS_INITIAL_AMMO(> MAX_AMMO)
  // 個をこの関数で意図的に並べるため、ここで弾くと初期配置数が狂う。上限は呼び出し側
  // (updateLogistics/despawnFarAmmo)が liveAmmoCount() を見て判断する。
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
    this.addAmmo(ammo);
    this._sfx.warp();
    this._hud.hint('付近の軌道に補給が投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  // respawnOnDespawn: 遠方デスポーンした補給を同数投入し直すか。呼び出し元(各 Stage の
  // update)がこの真偽値を直接渡す。
  updateLogistics(simTime: number, player: Player, respawnOnDespawn = false): void {
    if (player.alive) this.absorbNearbyAmmo(player);
    this.despawnFarAmmo(player, respawnOnDespawn);

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.LOGISTICS_CHECK_INTERVAL;
    if (player.magsLeft < C.LOGISTICS_LOW_MAGS && this.liveAmmoCount() < C.MAX_AMMO) {
      this.spawnForPlayer(player);
    }
  }

  // ammos は Simulator が cleanup/prune で後から詰めて消すため、alive=false のまま
  // 配列に残る個体が混ざる。上限判定は必ずこれ経由で行い、ammos.length を直接見ない。
  private liveAmmoCount(): number {
    let count = 0;
    for (const ammo of this.ammos) if (ammo.alive) count++;
    return count;
  }

  // ▣ AMMO マーカー: 回収へ向かうべき補給の位置と距離を示す。生存している補給だけを
  // 詰めた配列に番号を振ってキーにする(alive=false のまま残る個体を挟んでも欠番に
  // ならない)。前フレームより生存数が減った回だけ、余った添字のキーを隠す
  // (lastMarkerCount で前回数を覚えておく — キーの種類は同時存在数の最大値で頭打ち)。
  // 画面外にあるあいだは実位置を指せないので、代わりに画面端へ方位マーカー △ を出す
  // (敵の ▲ と同じ機構・同じ位置付けで、塗りを抜いた記号で区別する)。補給は取りに行く
  // 対象なので、方位マーカー側にも距離ラベルを載せる。
  syncMarkers(player: Player, project: ProjectFn): void {
    const live = this.ammos.filter((ammo) => ammo.alive);
    for (const [i, ammo] of live.entries()) {
      const key = `mg${i}`;
      const bearing = `${key}-bearing`;
      const label = `AMMO ${fmtMarkerDist(len(sub(ammo.state.r, player.state.r)))}`;
      const p = project(ammo.state.r);
      this.markerManager.set(key, 'mk-ammo', '▣', p.x, p.y, p.front, label);
      this.markerManager.setBearing(bearing, 'mk-ammo', '△', p, label, 0.9);
    }
    for (let i = live.length; i < this.lastMarkerCount; i++) {
      const key = `mg${i}`;
      this.markerManager.hide(key);
      this.markerManager.hide(`${key}-bearing`);
    }
    this.lastMarkerCount = live.length;
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
  // 直前のループで alive = false にした個体がまだ ammos に残っているため、投入し直す
  // ループは liveAmmoCount() を都度更新しながら MAX_AMMO で打ち切る(ammos.length は
  // 死んだ個体を含むので使えない)。
  private despawnFarAmmo(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    for (const ammo of this.ammos) {
      if (!ammo.alive) continue;
      if (len(sub(ammo.state.r, player.state.r)) <= C.LOGISTICS_DESPAWN_DIST) continue;
      ammo.alive = false;
      if (respawnOnDespawn) respawn++;
    }
    if (!respawnOnDespawn) return;
    let count = this.liveAmmoCount();
    for (let i = 0; i < respawn && count < C.MAX_AMMO; i++) {
      this.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
      count++;
    }
  }
}

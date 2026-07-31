// 補給(ammo)の投入・取り込み・デスポーンと、▣ AMMO マーカーの表示。
import * as THREE from 'three/webgpu';
import { randomQuat } from '../../../physics/attitude';
import { add, cross, len, lenSq, norm, randSym, randVec, rotateAxis, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { Ammo } from '../../game-entity/ammo';
import { orbitState } from '../../../physics/orbital';
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
    this.entities.addAmmo(ammo);
    this._sfx.warp();
    this._hud.hint('付近の軌道に補給が投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  updateLogistics(simTime: number, player: Player, respawnOnDespawn = false): void {
    if (player.alive) this.absorbNearbyAmmo(player);
    this.despawnFarAmmo(player, respawnOnDespawn);

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.LOGISTICS_CHECK_INTERVAL;
    if (player.magsLeft < C.LOGISTICS_LOW_MAGS && this.liveAmmoCount() < C.MAX_AMMO) {
      this.spawnForPlayer(player);
    }
  }

  private liveAmmoCount(): number {
    let count = 0;
    for (const ammo of this.entities.ammos) if (ammo.alive) count++;
    return count;
  }

  syncMarkers(player: Player, project: ProjectFn, displayTime: number): void {
    const shown = this.entities.ammos.flatMap((ammo) => {
      const pos = ammo.alive ? ammo.displayState(displayTime)?.r : undefined;
      return pos ? [pos] : [];
    });
    for (const [i, pos] of shown.entries()) {
      const key = `mg${i}`;
      const bearing = `${key}-bearing`;
      const label = `AMMO ${fmtMarkerDist(len(sub(pos, player.state.r)))}`;
      const p = project(pos);
      this.markerManager.set(key, 'mk-ammo', '▣', p.x, p.y, p.front, label);
      this.markerManager.setBearing(bearing, 'mk-ammo', '△', p, label, 0.9);
    }
    for (let i = shown.length; i < this.lastMarkerCount; i++) {
      const key = `mg${i}`;
      this.markerManager.hide(key);
      this.markerManager.hide(`${key}-bearing`);
    }
    this.lastMarkerCount = shown.length;
  }

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

  private despawnFarAmmo(player: Player, respawnOnDespawn: boolean): void {
    let respawn = 0;
    for (const ammo of this.entities.ammos) {
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

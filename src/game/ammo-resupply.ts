import * as THREE from 'three/webgpu';
import { randomQuat, stepAttitude } from '../physics/attitude';
import { stepOrbitRK4 } from '../physics/orbital';
import { Vec3, add, cross, len, lenSq, norm, randSym, randVec, rotateAxis, sub, v3 } from '../physics/vec3';
import { buildMagPickup } from '../render/ships';
import * as C from './const';
import { MagPickup } from './entities';
import { Hud } from '../hud/hud';
import { Sfx } from './audio';
import { Player } from './player';

export class AmmoResupplySystem {
  private readonly pickups: MagPickup[] = [];
  private resupplyCheckAt = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {}

  get list(): MagPickup[] {
    return this.pickups;
  }

  spawnForPlayer(
    player: Player,
    minDist = C.AMMO_RESUPPLY_MIN_DIST,
    maxDist = C.AMMO_RESUPPLY_MAX_DIST,
  ): void {
    const r = player.state.r;
    const v = player.state.v;
    const hHat = norm(cross(r, v));
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    const mp: MagPickup = {
      state: {
        r: rotateAxis(r, hHat, ang),
        v: add(rotateAxis(v, hHat, ang), randVec(1.5)),
      },
      att: {
        q: randomQuat(),
        w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
        inertia: v3(1, 1.4, 1.2),
      },
      obj: buildMagPickup(),
      alive: true,
    };
    this.pickups.push(mp);
    this.scene.add(mp.obj);
    this.sfx.warp();
    this.hud.hint('付近の軌道に補給マガジンが投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  updateLogistics(simTime: number, player: Player): void {
    if (player.alive) {
      for (const mp of this.pickups) {
        if (!mp.alive) continue;
        if (lenSq(sub(mp.state.r, player.state.r)) >= C.MAG_PICKUP_RADIUS * C.MAG_PICKUP_RADIUS) continue;
        mp.alive = false;
        this.scene.remove(mp.obj);
        player.onPickup(C.MAG_PICKUP_MAGS);
        this.sfx.pickup();
        this.hud.hint(`補給マガジン取り込み — ベルト +${C.MAG_PICKUP_MAGS} 連`, 3000);
      }
      this.compact();
    }

    if (simTime < this.resupplyCheckAt) return;
    this.resupplyCheckAt = simTime + C.RESUPPLY_CHECK_INTERVAL;
    if (player.magsLeft < C.AMMO_LOW_MAGS && this.pickups.length < C.MAX_MAG_PICKUPS) {
      this.spawnForPlayer(player);
    }
  }

  stepOrbits(sub: number, envSmall: (r: Vec3, v: Vec3, out?: Vec3) => Vec3): void {
    for (const mp of this.pickups) if (mp.alive) stepOrbitRK4(mp.state, sub, envSmall);
  }

  stepAttitudes(attDt: number): void {
    for (const mp of this.pickups) if (mp.alive) stepAttitude(mp.att, v3(), attDt);
  }

  cleanup(stage: number, player: Player, altitudeOf: (r: Vec3) => number): void {
    let respawn = 0;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const mp = this.pickups[i]!;
      const dist = len(sub(mp.state.r, player.state.r));
      const tooFar = dist > C.AMMO_DESPAWN_DIST;
      const expired = !mp.alive || altitudeOf(mp.state.r) < C.DEBRIS_REENTRY_ALT || tooFar;
      if (!expired) continue;
      this.scene.remove(mp.obj);
      this.pickups.splice(i, 1);
      if (stage === -1 && tooFar) respawn++;
    }
    for (let i = 0; i < respawn; i++) {
      this.spawnForPlayer(player, C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
    }
  }

  private compact(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      if (!this.pickups[i]!.alive) this.pickups.splice(i, 1);
    }
  }
}

// 訓練クラスタ(stage0)の敵集団の配置・分散を計算し、直接 Enemy を生成する。
// (Simulator への登録は呼び出し側の Stage0 が Stage.addEnemy 経由で行う)。
import * as THREE from 'three/webgpu';
import { OrbitState, orbitState } from '../../../physics/orbital';
import { add, cross, len, norm, randSym, scale } from '../../../physics/vec3';
import * as C from '../../const';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../orbit-entity/enemy';
import { generateDriftingEnemy } from './enemy-generator';

// 色分けされた5グループ(各10機)を base 周囲5km以内に配置して直接生成する(訓練クラスタ)。
export function generateCluster(base: OrbitState, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy[] {
  const vHat = norm(base.v);
  const rHat = norm(base.r);
  const hHat = norm(cross(base.r, base.v));
  const groupCount = C.STAGE0_GROUP_ACCENTS.length;
  const safeRange = C.STAGE0_MAX_RANGE * C.STAGE0_SAFE_RANGE_FACTOR; // マージンを残して確実に5km以内に収める
  const enemies: Enemy[] = [];

  for (let gi = 0; gi < groupCount; gi++) {
    const theta = (gi / groupCount) * Math.PI * 2;
    const centerDist = safeRange * (C.STAGE0_GROUP_CENTER_DIST_MIN + Math.random() * C.STAGE0_GROUP_CENTER_DIST_RANGE);
    const cAlong = Math.cos(theta) * centerDist;
    const cNormal = Math.sin(theta) * centerDist;
    const cRadial = randSym(safeRange * C.STAGE0_GROUP_RADIAL_FACTOR);

    for (let i = 0; i < C.STAGE0_PER_GROUP; i++) {
      const jAlong = cAlong + randSym(C.STAGE0_JITTER_ALONG);
      const jNormal = cNormal + randSym(C.STAGE0_JITTER_NORMAL);
      const jRadial = cRadial + randSym(C.STAGE0_JITTER_RADIAL);
      let off = add(scale(vHat, jAlong), scale(hHat, jNormal));
      off = add(off, scale(rHat, jRadial));
      const offLen = len(off);
      if (offLen > safeRange) off = scale(off, safeRange / offLen);

      const state: OrbitState = orbitState(base.t, add(base.r, off), base.v);
      const accent = C.STAGE0_GROUP_ACCENTS[gi]!;
      enemies.push(generateDriftingEnemy(`${C.STAGE0_GROUP_LABELS[gi]}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene));
    }
  }
  return enemies;
}

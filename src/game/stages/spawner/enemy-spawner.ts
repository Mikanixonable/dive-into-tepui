// 訓練クラスタ(stage0)の敵集団の配置・分散を計算し、直接 Enemy を生成する。
// (EntityManager への登録は呼び出し側の Stage0 が Stage.addEnemy 経由で行う)。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { randSym } from '../../../physics/random';
import { add, len, norm, scale } from '../../../physics/vec3';
import * as C from '../../const';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../game-entity/enemy';
import { generateDriftingEnemy } from './enemy-generator';

// 色分けされたグループ(既定 5 グループ×各10機)を base 周囲5km以内に配置して直接生成する(訓練クラスタ)。
// groupCount/perGroup でグループ数・1グループあたりの機数を変更できる。
export function generateCluster(
  base: KinematicState,
  hud: Hud,
  sfx: Sfx,
  fx: EffectsSystem,
  scene: THREE.Scene,
  groupCount: number = C.COLOR_STAGE0_GROUP_ACCENTS.length,
  perGroup: number = C.STAGE0_PER_GROUP,
): Enemy[] {
  const { pro, nrm } = orbitAxes(base);
  const rHat = norm(base.r);
  const safeRange = C.STAGE0_MAX_RANGE * C.STAGE0_SAFE_RANGE_FACTOR; // マージンを残して確実に5km以内に収める
  const enemies: Enemy[] = [];

  // グループごとの中心位置を、進行方向-法線平面の円周上に配置する。
  for (let gi = 0; gi < groupCount; gi++) {
    const theta = (gi / groupCount) * Math.PI * 2;
    const centerDist = safeRange * (C.STAGE0_GROUP_CENTER_DIST_MIN + Math.random() * C.STAGE0_GROUP_CENTER_DIST_RANGE);
    const cAlong = Math.cos(theta) * centerDist;
    const cNormal = Math.sin(theta) * centerDist;
    const cRadial = randSym(safeRange * C.STAGE0_GROUP_RADIAL_FACTOR);

    // グループ中心へ個体ごとのジッターを加え、safeRange を超えたらクランプする。
    // groupCount が色・ラベルの定義数を超えても引けるよう、配列長で剰余を取る。
    const accent = C.COLOR_STAGE0_GROUP_ACCENTS[gi % C.COLOR_STAGE0_GROUP_ACCENTS.length]!;
    const label = C.STAGE0_GROUP_LABELS[gi % C.STAGE0_GROUP_LABELS.length]!;
    for (let i = 0; i < perGroup; i++) {
      const jAlong = cAlong + randSym(C.STAGE0_JITTER_ALONG);
      const jNormal = cNormal + randSym(C.STAGE0_JITTER_NORMAL);
      const jRadial = cRadial + randSym(C.STAGE0_JITTER_RADIAL);
      let off = add(scale(pro, jAlong), scale(nrm, jNormal));
      off = add(off, scale(rHat, jRadial));
      const offLen = len(off);
      if (offLen > safeRange) off = scale(off, safeRange / offLen);

      const state: KinematicState = kinematicState(base.t, add(base.r, off), base.v);
      enemies.push(generateDriftingEnemy(`${label}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene));
    }
  }
  return enemies;
}

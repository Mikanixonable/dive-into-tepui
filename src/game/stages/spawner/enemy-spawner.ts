// 訓練クラスタ(stage0)の敵集団の配置・分散を計算し、直接 Enemy を生成する。
// (DynamicSystem への登録は呼び出し側の Stage0 が Stage.addEnemy 経由で行う)。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { randSym } from '../../../math/random';
import { add, len, norm, scale } from '../../../math/vec3';
import * as C from '../../const';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../dynamic/dynamic-entity/enemy';
import { generateDriftingEnemy } from './enemy-generator';
import { COLOR_ENEMY_ORBIT_LINE } from '../../lines/entity-line-manager';

const STAGE0_GROUP_LABELS = ['RED', 'BLUE', 'GREEN', 'AMBER', 'VIOLET'];

// 5グループの配置: 各グループ中心を安全半径(STAGE0_MAX_RANGE * SAFE_RANGE_FACTOR)
// の CENTER_DIST_MIN〜+RANGE の位置に置き、各機はそこから ALONG/NORMAL/RADIAL
// 方向にランダムに散らす
const STAGE0_SAFE_RANGE_FACTOR = 0.94; // マージンを残して確実に配置半径内に収める
const STAGE0_GROUP_CENTER_DIST_MIN = 0.52; // 安全半径に対する比率
const STAGE0_GROUP_CENTER_DIST_RANGE = 0.14;
const STAGE0_GROUP_RADIAL_FACTOR = 0.1; // 動径方向のグループ中心ばらつき(安全半径比)
const STAGE0_JITTER_ALONG = 500; // 各機の進行方向ばらつき [m]
const STAGE0_JITTER_NORMAL = 500; // 各機の軌道面法線方向ばらつき [m]
const STAGE0_JITTER_RADIAL = 350; // 各機の動径方向ばらつき [m]

// 色分けされたグループ(既定 5 グループ×各10機)を base 周囲5km以内に配置して直接生成する(訓練クラスタ)。
// groupCount/perGroup でグループ数・1グループあたりの機数を変更できる。
export function generateCluster(
  base: KinematicState,
  worldSfx: WorldSfx,
  fx: EffectsSystem,
  scene: THREE.Scene,
  groupCount: number = C.COLOR_STAGE0_GROUP_ACCENTS.length,
  perGroup: number = C.STAGE0_PER_GROUP,
): readonly Enemy[] {
  const { pro, nrm } = orbitAxes(base);
  const rHat = norm(base.r);
  const safeRange = C.STAGE0_MAX_RANGE * STAGE0_SAFE_RANGE_FACTOR; // マージンを残して確実に5km以内に収める
  const enemies: Enemy[] = [];

  // グループごとの中心位置を、進行方向-法線平面の円周上に配置する。
  for (let gi = 0; gi < groupCount; gi++) {
    const theta = (gi / groupCount) * Math.PI * 2;
    const centerDist = safeRange * (STAGE0_GROUP_CENTER_DIST_MIN + Math.random() * STAGE0_GROUP_CENTER_DIST_RANGE);
    const cAlong = Math.cos(theta) * centerDist;
    const cNormal = Math.sin(theta) * centerDist;
    const cRadial = randSym(safeRange * STAGE0_GROUP_RADIAL_FACTOR);

    // グループ中心へ個体ごとのジッターを加え、safeRange を超えたらクランプする。
    // groupCount が色・ラベルの定義数を超えても引けるよう、配列長で剰余を取る。
    const accent = C.COLOR_STAGE0_GROUP_ACCENTS[gi % C.COLOR_STAGE0_GROUP_ACCENTS.length]!;
    const label = STAGE0_GROUP_LABELS[gi % STAGE0_GROUP_LABELS.length]!;
    for (let i = 0; i < perGroup; i++) {
      const jAlong = cAlong + randSym(STAGE0_JITTER_ALONG);
      const jNormal = cNormal + randSym(STAGE0_JITTER_NORMAL);
      const jRadial = cRadial + randSym(STAGE0_JITTER_RADIAL);
      let off = add(scale(pro, jAlong), scale(nrm, jNormal));
      off = add(off, scale(rHat, jRadial));
      const offLen = len(off);
      if (offLen > safeRange) off = scale(off, safeRange / offLen);

      const state: KinematicState = kinematicState<'eci'>(base.t, add(base.r, off), base.v);
      enemies.push(generateDriftingEnemy(`${label}-${i + 1}`, state, accent, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene));
    }
  }
  return enemies;
}

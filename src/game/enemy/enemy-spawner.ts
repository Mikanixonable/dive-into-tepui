// 敵集団の配置・分散を計算し、直接 Enemy を生成する。StageCtx は受け取らない
// (ゲームの現在状態への登録 = ctx.addEnemy は呼び出し側の stage-data.ts が行う)。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { Vec3, add, clone, cross, len, norm, randPerp, randSym, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Enemy } from './enemy';
import { generateApproachingEnemy, generateDriftingEnemy } from './enemy-generator';

// 色分けされた5グループ(各10機)を base 周囲5km以内に配置して直接生成する(訓練クラスタ)。
export function generateCluster(base: OrbitState, scene: THREE.Scene): Enemy[] {
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

      const state: OrbitState = { r: add(base.r, off), v: clone(base.v) };
      const accent = C.STAGE0_GROUP_ACCENTS[gi]!;
      enemies.push(generateDriftingEnemy(`${C.STAGE0_GROUP_LABELS[gi]}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, scene));
    }
  }
  return enemies;
}

// ウェーブ出現位置: 自機の後方/前方/上方/側方いずれか(第1波は必ず後方)
function pickWaveCenter(player: OrbitState, wave: number): Vec3 {
  const types = ['behind', 'front', 'above', 'side'];
  const type = wave === 1 ? 'behind' : types[Math.floor(Math.random() * types.length)];

  const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);
  const r0 = player.r;
  const hHat = norm(cross(r0, player.v));
  const rHat = norm(r0);
  const vHat = cross(hHat, rHat);

  const dr = (Math.random() - 0.5) * C.STAGE00_PLACEMENT_JITTER;
  if (type === 'behind') return add(r0, add(scale(vHat, -dist), scale(rHat, dr)));
  if (type === 'front') return add(r0, add(scale(vHat, dist), scale(rHat, dr)));
  if (type === 'above') return add(r0, add(scale(rHat, dist), scale(vHat, dr)));
  const sideSign = Math.random() < 0.5 ? 1 : -1; // side
  return add(r0, add(scale(hHat, dist * sideSign), scale(rHat, dr)));
}

// フライバイ初速: 1000m ~ 2000m の範囲ですれ違うようにターゲット位置をずらし、
// 敵の初速度 = 自機の速度 + 接近速度 + わずかな横ブレ とする
function makeFlybyVelocity(player: OrbitState, centerR: Vec3, wave: number): { approachDir: Vec3; centerV: Vec3 } {
  const missDist = C.STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * C.STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  const flybySpeed = C.STAGE00_FLYBY_SPEED + (wave - 1) * C.STAGE00_FLYBY_SPEED_RAMP; // ウェーブが進むと少し速くなる
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * C.STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
}

// 基調色: アースカラー7割 / 寒色系2割 / アクセントカラー1割
function pickWaveBaseHex(): number {
  const randCol = Math.random();
  if (randCol < 0.7) {
    const earthColors = [0xc2b280, 0x808080, 0xb2beb5, 0x8b4513, 0xc3b091, 0x556b2f, 0x8f9779, 0x5f9ea0];
    return earthColors[Math.floor(Math.random() * earthColors.length)]!;
  }
  if (randCol < 0.9) {
    const coolColors = [0x722f37, 0x8a2be2, 0x0000ff, 0x00ffff, 0x40e0d0, 0x008000, 0x9acd32];
    return coolColors[Math.floor(Math.random() * coolColors.length)]!;
  }
  const accentColors = [0xffa500, 0xffc0cb, 0xff0000, 0xffffff];
  return accentColors[Math.floor(Math.random() * accentColors.length)]!;
}

// 個体を2~4のサブグループに分け、色相・彩度・明度をわずかにずらす
function makeSubGroupHexes(baseHex: number): number[] {
  const baseColor = new THREE.Color(baseHex);
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);

  const subGroupCount = 2 + Math.floor(Math.random() * 3);
  const subGroups: number[] = [];
  for (let i = 0; i < subGroupCount; i++) {
    const hOffset = (Math.random() - 0.5) * 0.12;
    const sOffset = (Math.random() - 0.5) * 0.35;
    const lOffset = (Math.random() - 0.5) * 0.25;
    const subColor = new THREE.Color().setHSL(
      (hsl.h + hOffset + 1) % 1,
      Math.max(0, Math.min(1, hsl.s + sOffset)),
      Math.max(0.1, Math.min(0.9, hsl.l + lOffset))
    );
    subGroups.push(subColor.getHex());
  }
  return subGroups;
}

// 隊列内の各機の配置位置(高度を少し下げるオフセット込み)
function waveShipPosition(pattern: 'linear' | 'random', i: number, shipCount: number, centerR: Vec3, approachDir: Vec3): Vec3 {
  let pos: Vec3;
  if (pattern === 'linear') {
    // 隊列は接近方向に対して後方へ直列に並べる。直線状のものも少しランダムに配置
    const offset = (i - (shipCount - 1) / 2) * C.STAGE00_FORMATION_SPACING;
    const jitter = scale(randPerp(approachDir), (Math.random() - 0.5) * 200);
    pos = add(centerR, add(scale(approachDir, -offset), jitter));
  } else {
    // ランダムな球状の配置
    const randDir = norm(v3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5));
    const randDist = Math.random() * C.STAGE00_FORMATION_SPACING * (shipCount / 2);
    pos = add(centerR, scale(randDir, randDist));
  }

  // 高度を少し下げる (200m~1km)
  const altDrop = C.STAGE00_ALT_OFFSET_MIN + Math.random() * (C.STAGE00_ALT_OFFSET_MAX - C.STAGE00_ALT_OFFSET_MIN);
  return add(pos, scale(norm(pos), altDrop));
}

// サバイバル波状攻撃1波分を直接生成する(登録は呼び出し側)。
export function generateWave(player: OrbitState, waveNumber: number, scene: THREE.Scene, forcedPattern?: 'linear' | 'random'): Enemy[] {
  const shipCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE);
  const centerR = pickWaveCenter(player, waveNumber);
  const { approachDir, centerV } = makeFlybyVelocity(player, centerR, waveNumber);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir);
    const state: OrbitState = { r: position, v: clone(centerV) };
    enemies.push(generateApproachingEnemy(`W${waveNumber}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, typeIndex, waveNumber, scene));
  }
  return enemies;
}

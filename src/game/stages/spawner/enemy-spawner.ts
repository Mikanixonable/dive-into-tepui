// 敵集団の配置・分散を計算し、直接 Enemy を生成する。
// (Simulator への登録は呼び出し側の各 Stage(stages/)が Stage.addEnemy 経由で行う)。
import * as THREE from 'three/webgpu';
import { OrbitState, orbitState } from '../../../physics/orbital';
import { Vec3, add, cross, len, norm, randPerp, randSym, scale, sub, v3 } from '../../../physics/vec3';
import * as C from '../../const';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../orbit-entity/enemy';
import { generateApproachingEnemy, generateDriftingEnemy } from './enemy-generator';

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

// ウェーブ出現位置: 自機と同じ高度の水平方向(全方位)にランダムな距離で配置
function pickWaveCenter(player: OrbitState, wave: number): Vec3 {
  const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);
  
  // 第1波は必ず後方(速度ベクトルと逆向き)に出現させる。それ以降はランダムな水平方向。
  let dir: Vec3;
  if (wave === 1) {
    dir = norm(scale(player.v, -1));
  } else {
    dir = randPerp(player.r);
  }
  
  return add(player.r, scale(dir, dist));
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

// 隊列内の各機の配置位置(高度を少し下げるオフセット込み・大気圏突入防止のクランプあり)
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
  const droppedPos = add(pos, scale(norm(pos), altDrop));

  // 安全装置: どんなに低くても高度90km未満(大気圏+10km)には出現させない
  const safeAlt = C.REENTRY_ALT + 10e3;
  const currentAlt = len(droppedPos) - C.R_EARTH;
  if (currentAlt < safeAlt) {
    return scale(norm(droppedPos), C.R_EARTH + safeAlt);
  }
  return droppedPos;
}

// サバイバル波状攻撃1波分を直接生成する(登録は呼び出し側)。
export function generateWave(player: OrbitState, waveNumber: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene, forcedPattern?: 'linear' | 'random'): Enemy[] {
  const calculatedCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE);
  const shipCount = Math.min(calculatedCount, C.STAGE00_WAVE_MAX_SHIPS);
  const centerR = pickWaveCenter(player, waveNumber);
  const { approachDir, centerV } = makeFlybyVelocity(player, centerR, waveNumber);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir);
    const state: OrbitState = orbitState(player.t, position, centerV);
    enemies.push(generateApproachingEnemy(`W${waveNumber}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, accent, typeIndex, waveNumber, hud, sfx, fx, scene));
  }
  return enemies;
}

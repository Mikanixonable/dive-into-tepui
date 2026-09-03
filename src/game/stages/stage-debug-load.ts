// デバッグ用ステージ: 破片を多数配置し、積分するエンティティ数の高負荷を常時再現する。
// タイトルの通常ボタン列には出ない。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import type { Player } from '../player/player';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { randomQuat } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { mulberry32 } from '../../math/random';
import { add, v3, Vec3 } from '../../math/vec3';
import type { StageSaveData } from '../save/save-data';
import {
  DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN,
} from '../../render/vfx-style';
import { MAG_ROUNDS } from '../player/player-fire';

// 破片は衛星の破壊直後の雲を想定し、自機の周囲に留める。
const DEBRIS_COUNT = 500;
const DEBRIS_MAX_DIST = 250000; // [m]
const PLACEMENT_MIN_DIST = 5000; // 自機からの配置距離下限 [m]
const RNG_SEED = 20260810;

export class StageDebugLoad extends Stage {
  static readonly id = 'debug-load' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'DEBUG(高負荷)';
  static readonly selectSub = '【デバッグ】破片を多数配置し積分を高負荷にする・撃破しても終了しない';
  static readonly hiddenFromSelect = true;
  static readonly selectKeys = ['KeyL'];

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  briefingHtml(): string {
    return `<b>高負荷デバッグステージ</b><br>破片 ${DEBRIS_COUNT} 個を配置`;
  }

  // 自機を置き、破片を自機の周囲へ散らす。
  protected init(entities: DynamicSystem): void {
    const player = this.addPlayer({ ammo: { mags: 20, rounds: MAG_ROUNDS } });
    const rand = mulberry32(RNG_SEED);
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const offset = randomOffset(rand, DEBRIS_MAX_DIST);
      const state = kinematicState<'eci'>(player.state.t, add(player.state.r, offset), player.state.v);
      const size = DESTROY_FRAG_SIZE_MIN + rand() * (DESTROY_FRAG_SIZE_MAX - DESTROY_FRAG_SIZE_MIN);
      const att = { q: randomQuat(rand), w: v3(0, 0, 0), inertia: v3(1, 1, 1) };
      entities.add(new DebrisPiece(state, { kind: 'fragment', accent: 0x888888, size }, att, this._worldSfx, this._fx, undefined, this._scene));
    }
  }

  update(_dt: number, player: Player | null, _entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;
    this.logistics.updateLogistics(simTime, player, simSpeed);
  }

  // 検証を継続できるよう、勝敗を発生させない(UnlockManager のクリア数にも入らない)。
  checkWin(): boolean {
    return false;
  }
}

// 自機からの距離が [DEBUG_LOAD_PLACEMENT_MIN_DIST, maxDist] に収まるランダムな相対位置を、
// その球殻内で密度が一様になるように返す。
function randomOffset(rand: () => number, maxDist: number): Vec3 {
  const min3 = PLACEMENT_MIN_DIST ** 3;
  const dist = Math.cbrt(min3 + rand() * (maxDist ** 3 - min3));
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  return v3(dist * Math.sin(phi) * Math.cos(theta), dist * Math.sin(phi) * Math.sin(theta), dist * Math.cos(phi));
}

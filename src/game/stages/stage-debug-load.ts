// デバッグ用ステージ: 重力を及ぼす小惑星と受ける破片の双方を多数配置し、万有引力計算の
// 高負荷を常時再現する。タイトルの通常ボタン列には出ない。
import { Stage, type StageDeps } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import * as C from '../const';
import { Asteroid } from '../game-entity/asteroid';
import { DebrisPiece } from '../game-entity/debris-piece';
import { randomQuat } from '../../physics/attitude';
import { kinematicState } from '../../physics/kinematic-state';
import { mulberry32 } from '../../physics/random';
import { add, v3, Vec3 } from '../../physics/vec3';
import type { StageSaveData } from '../save-data';

export class StageDebugLoad extends Stage {
  static readonly id = 'debug-load' as const;
  static readonly selectLabel = 'DEBUG(高負荷)';
  static readonly selectSub = '【デバッグ】小惑星・破片を多数配置し万有引力計算を高負荷にする・撃破しても終了しない';
  static readonly hiddenFromSelect = true;
  static readonly selectKeys = ['KeyL'];

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  briefingHtml(): string {
    return `<b>高負荷デバッグステージ</b><br>小惑星 ${C.DEBUG_LOAD_ASTEROID_COUNT} 体・破片 ${C.DEBUG_LOAD_DEBRIS_COUNT} 個を配置`;
  }

  // 自機を置き、引力を及ぼす小惑星(重力源)と、受けるだけの破片の双方を自機周囲へ散らす。
  protected init(entities: EntityManager): number {
    const player = this.addPlayer({ ammo: { mags: 20, rounds: C.MAG_ROUNDS } });
    const rand = mulberry32(C.DEBUG_LOAD_RNG_SEED);
    for (let i = 0; i < C.DEBUG_LOAD_ASTEROID_COUNT; i++) {
      const offset = randomOffset(rand, C.DEBUG_LOAD_ASTEROID_MAX_DIST);
      const state = kinematicState(player.state.t, add(player.state.r, offset), player.state.v);
      entities.addAsteroid(new Asteroid(state, C.DEBUG_LOAD_ASTEROID_MASS, C.DEBUG_LOAD_ASTEROID_RADIUS, this._scene, { q: randomQuat(rand), w: v3(0, 0, 0), inertia: v3(1, 1, 1) }));
    }
    for (let i = 0; i < C.DEBUG_LOAD_DEBRIS_COUNT; i++) {
      const offset = randomOffset(rand, C.DEBUG_LOAD_DEBRIS_MAX_DIST);
      const state = kinematicState(player.state.t, add(player.state.r, offset), player.state.v);
      const size = C.DESTROY_FRAG_SIZE_MIN + rand() * (C.DESTROY_FRAG_SIZE_MAX - C.DESTROY_FRAG_SIZE_MIN);
      const att = { q: randomQuat(rand), w: v3(0, 0, 0), inertia: v3(1, 1, 1) };
      entities.addDebris(new DebrisPiece(state, { kind: 'fragment', accent: 0x888888, size }, att, this._sfx, this._fx, undefined, this._scene));
    }
    return 0;
  }

  update(_dt: number, player: Player | null, _entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying || !player) return;
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
  const min3 = C.DEBUG_LOAD_PLACEMENT_MIN_DIST ** 3;
  const dist = Math.cbrt(min3 + rand() * (maxDist ** 3 - min3));
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  return v3(dist * Math.sin(phi) * Math.cos(theta), dist * Math.sin(phi) * Math.sin(theta), dist * Math.cos(phi));
}

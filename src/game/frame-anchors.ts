// physics/frame.ts の FrameAnchorSource 実装。天体レジストリに無い参照フレームの基準・回転対象
// (生存中の重力天体・機体・役割トークン @activeShip/@navTarget)を、Game 側が持つ状態から解決する。
// Ephemeris は Game/EntityManager/NavTarget を知らないため、この解決だけが frame.ts と
// ephemeris.ts の外に置かれる。
//
// 実体は Game が1つ持ち(src/game/game.ts)、毎フレーム update() の先頭付近で最新の
// celestialBodies を差し込む。呼び出し側で celestialBodies を個別に持ち回っていた箇所は
// この bodies を参照する側へ寄せ、同じ配列の二重管理を避ける。
import { CelestialBody, CelestialBodyId, orbitingAttractorOf } from '../physics/celestial-body';
import { FrameAnchorId, FrameAnchorSource, FrameRole, frameRoleOf } from '../physics/frame';
import { KinematicState } from '../physics/kinematic-state';

// 解決に要る問い合わせだけをまとめた受け口。EntityManager・NavTarget・GameEntity の型そのものを
// 受けると、参照フレームの解決がそれらの都合に引きずられ、DOM を持つモジュールまで巻き込む。
// 実装は Game が組んで渡す。
export interface AnchorTargets {
  // 生存中のエンティティ id → 現在の状態。見つからなければ null。
  entityState(id: string): KinematicState | null;
  // 操作対象の船の現在の状態。乗り換え中などで定まらなければ null。
  activeShipState(): KinematicState | null;
  // 航法ターゲットの時刻 t における状態。設定されていない・消滅していれば null。
  navTargetState(bodies: readonly CelestialBody[], t: number): KinematicState | null;
}

// 役割トークンが1フレームだけ解決できなくなっても直前の状態を保つための保持枠。missFrame は
// 連続ミスを数えた最後のフレーム番号 — stateOf は1フレームに何度も呼ばれる(カメラ・軌道
// フレーム・attractorOf 経由)ので、呼び出し回数で数えると1フレームのうちに猶予を使い切る。
type RoleHold = { state: KinematicState | null; misses: number; missFrame: number };

export class FrameAnchors implements FrameAnchorSource {
  bodies: readonly CelestialBody[] = [];

  private readonly roleHolds = new Map<FrameRole, RoleHold>();
  // update() ごとに進む通し番号。役割トークンの猶予とキャッシュの有効範囲をフレームで区切る。
  private frameIndex = 0;
  private attractorCacheKey: string | null = null;
  private attractorCacheValue: CelestialBodyId | null = null;

  constructor(private readonly targets: AnchorTargets) {}

  // このフレームの celestialBodies を差し込む。Game.update()/sync() の先頭で、対応する
  // 表示時刻の celestialBodiesAt(t) を渡して呼ぶ。
  update(bodies: readonly CelestialBody[]): void {
    this.bodies = bodies;
    this.frameIndex++;
  }

  // 役割トークンは resolveRoleState → heldRoleState で解決し、機体 id は生存中のエンティティから、
  // それ以外は bodies(このフレームの celestialBodies)から引く。
  stateOf(id: FrameAnchorId, t: number): KinematicState | null {
    const role = frameRoleOf(id);
    if (role !== null) return this.heldRoleState(role, this.resolveRoleState(role, t));
    return this.targets.entityState(id) ?? this.bodies.find((b) => b.id === id)?.state ?? null;
  }

  // 直近1回ぶんだけ憶えるキャッシュ。同一フレーム内でカメラ用・軌道フレーム用が同じ id を
  // 重ねて問うことが多く、strongestAttractor は天体数に線形に効くため。
  attractorOf(id: FrameAnchorId, t: number): CelestialBodyId | null {
    // bodies はフレームごとに差し替わるので、キャッシュもフレームで区切る。
    const key = `${this.frameIndex}|${id}|${t}`;
    if (this.attractorCacheKey === key) return this.attractorCacheValue;
    const result = this.computeAttractorOf(id, t);
    this.attractorCacheKey = key;
    this.attractorCacheValue = result;
    return result;
  }

  private computeAttractorOf(id: FrameAnchorId, t: number): CelestialBodyId | null {
    const state = this.stateOf(id, t);
    return state !== null ? orbitingAttractorOf(state, this.bodies)?.id ?? null : null;
  }

  private resolveRoleState(role: FrameRole, t: number): KinematicState | null {
    if (role === 'activeShip') return this.targets.activeShipState();
    return this.targets.navTargetState(this.bodies, t);
  }

  // resolved が null の間は連続ミス数を数え、1回目は直前の状態を返す。2フレーム連続で
  // 解決できなかったときだけ null を返す(MAP.md の被選択物と同じ猶予)。
  private heldRoleState(role: FrameRole, resolved: KinematicState | null): KinematicState | null {
    let hold = this.roleHolds.get(role);
    if (!hold) { hold = { state: null, misses: 0, missFrame: -1 }; this.roleHolds.set(role, hold); }
    if (resolved !== null) {
      hold.state = resolved;
      hold.misses = 0;
      return resolved;
    }
    // 同じフレーム内で何度問われても、連続ミスは1回だけ数える。
    if (hold.missFrame !== this.frameIndex) {
      hold.missFrame = this.frameIndex;
      hold.misses++;
    }
    if (hold.misses <= 1) return hold.state;
    hold.state = null;
    return null;
  }
}

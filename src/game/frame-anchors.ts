// 天体レジストリに載らない参照フレームの基準・回転対象 — 生存中の重力天体・機体・役割トークン
// (@activeShip / @navTarget)— を ECI 状態と主天体へ解決する FrameAnchorSource。
// 役割トークンは毎フレームその時点の対象へ解決されるので、操作対象の乗り換えやターゲットの
// 付け替えをまたいでも同じ基準を指し続ける(DEVELOP/SPEC/CELESTIAL.md 8節)。
import { CelestialBody, orbitingAttractorOf } from '../physics/celestial-body';
import { FrameAnchorSource, FrameRole, frameRoleOf } from '../physics/frame';
import { KinematicState } from '../physics/kinematic-state';

// 解決に要る問い合わせをまとめた受け口。ゲーム側の型ではなく状態だけを受け取ることで、
// 参照フレームの解決がエンティティ管理や航法ターゲットの都合から独立する。
export interface AnchorTargets {
  // 生存中のエンティティ id の時刻 t における状態。見つからなければ null。
  entityState(id: string, t: number): KinematicState | null;
  // 操作対象の船の時刻 t における状態。乗り換え中などで定まらなければ null。
  activeShipState(t: number): KinematicState | null;
  // 航法ターゲットの時刻 t における状態。設定されていない・消滅していれば null。
  navTargetState(bodies: readonly CelestialBody[], t: number): KinematicState | null;
}

// 役割トークンが一時的に解決できないあいだ直前の状態を保つ枠。misses は連続ミスの数、
// missFrame はそれを最後に数えたフレーム — 猶予を呼び出し回数で数えると、同じフレームで
// 重ねて問われただけで使い切ってしまう。
type RoleHold = { state: KinematicState | null; misses: number; missFrame: number };

export class FrameAnchors implements FrameAnchorSource {
  bodies: readonly CelestialBody[] = [];

  private readonly roleHolds = new Map<FrameRole, RoleHold>();
  // update() ごとに進む通し番号。役割トークンの猶予とキャッシュの有効範囲をフレームで区切る。
  private frameIndex = 0;
  private attractorCacheKey: string | null = null;
  private attractorCacheValue: string | null = null;

  constructor(private readonly targets: AnchorTargets) {}

  // このフレームの celestialBodies を差し込む。毎フレーム、以降の解決で使う表示時刻の
  // celestialBodies を渡して1度呼ぶ。
  update(bodies: readonly CelestialBody[]): void {
    this.bodies = bodies;
    this.frameIndex++;
  }

  // 基準 id の ECI 状態。役割トークン・機体・重力天体のいずれとしても解決できなければ null。
  stateOf(id: string, t: number): KinematicState | null {
    const role = frameRoleOf(id);
    if (role !== null) return this.heldRoleState(role, this.resolveRoleState(role, t));
    return this.targets.entityState(id, t) ?? this.bodies.find((b) => b.id === id)?.state ?? null;
  }

  // 基準 id が公転している主天体。離心率1未満の周回軌道にないなら null。
  // 直近1件だけ憶える — 同じ id が同一フレーム内で重ねて問われ、探索は天体数に線形に効く。
  attractorOf(id: string, t: number): string | null {
    // bodies はフレームごとに差し替わるので、キャッシュもフレームで区切る。
    const key = `${this.frameIndex}|${id}|${t}`;
    if (this.attractorCacheKey === key) return this.attractorCacheValue;
    const result = this.computeAttractorOf(id, t);
    this.attractorCacheKey = key;
    this.attractorCacheValue = result;
    return result;
  }

  // attractorOf のキャッシュを介さない本体。
  private computeAttractorOf(id: string, t: number): string | null {
    const state = this.stateOf(id, t);
    return state !== null ? orbitingAttractorOf(state, this.bodies)?.id ?? null : null;
  }

  // 役割そのものの解決。猶予は掛かっていない生の結果を返す。
  private resolveRoleState(role: FrameRole, t: number): KinematicState | null {
    if (role === 'activeShip') return this.targets.activeShipState(t);
    return this.targets.navTargetState(this.bodies, t);
  }

  // 解決結果に猶予を掛ける。2フレーム連続で解決できなかったときに初めて null を返す
  // (DEVELOP/SPEC/MAP.md の被選択物と同じ猶予)。
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

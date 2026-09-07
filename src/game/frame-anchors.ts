// 天体レジストリに載らない参照フレームの基準・回転対象 — 生存中の重力天体・機体・役割トークン
// (@activeShip / @navTarget)— を ECI 状態と主天体へ解決する FrameAnchorSource。
// 役割トークンは毎フレームその時点の対象へ解決されるので、操作対象の乗り換えやターゲットの
// 付け替えをまたいでも同じ基準を指し続ける(DEVELOP/SPEC/CELESTIAL.md 8節)。
import { orbitingAttractorOf } from '../physics/attractor';
import { CelestialMotion } from '../physics/celestial-motion';
import { FrameAnchorSource, FrameRole, frameRoleOf } from '../physics/frame';
import { KinematicState } from '../physics/kinematic-state';
import type { CelestialSystem } from './celestial/celestial-system';

// 解決に要る問い合わせをまとめた受け口。いずれも ECI 状態を答える。
interface AnchorTargets {
  // 生存中のエンティティ id の時刻 t における状態。見つからなければ null。
  entityState(id: string, t: number): KinematicState | null;
  // 操作対象の船の時刻 t における状態。乗り換え中などで定まらなければ null。
  activeShipState(t: number): KinematicState | null;
  // 航法ターゲットの時刻 t における状態。設定されていない・消滅していれば null。
  navTargetState(bodies: readonly CelestialMotion[], t: number): KinematicState | null;
}

// 役割トークンが一時的に解決できないあいだ直前の状態を保つ枠。連続ミスはフレームで数える —
// 呼び出し回数で数えると、同じフレームに重ねて問われただけで猶予を使い切る。
type RoleHold = { state: KinematicState | null; misses: number; missFrame: number };

export class FrameAnchors implements FrameAnchorSource {
  // bodies の位置を厳密に引く時刻 [s]。
  bodiesPivot = 0;

  private readonly roleHolds = new Map<FrameRole, RoleHold>();
  // フレームごとに進む通し番号。役割トークンの猶予とキャッシュの有効範囲をフレームで区切る。
  private frameIndex = 0;
  private attractorCacheKey: string | null = null;
  private attractorCacheValue: string | null = null;

  constructor(
    private readonly celestialSystem: CelestialSystem,
    private readonly targets: AnchorTargets,
  ) {}

  get bodies(): readonly CelestialMotion[] { return this.celestialSystem.celestialMotions; }

  // このフレームが天体の位置を厳密に引く表示時刻を差し込む。フレームの先頭で1度だけ呼ぶ —
  // 役割トークンの猶予とキャッシュの区切りがこの呼び出し回数で決まる。
  update(bodiesPivot: number): void {
    this.bodiesPivot = bodiesPivot;
    this.frameIndex++;
  }

  // 基準 id の ECI 状態。役割トークン・機体・重力天体のいずれとしても解決できなければ null。
  stateOf(id: string, t: number): KinematicState | null {
    const role = frameRoleOf(id);
    if (role !== null) return this.heldRoleState(role, this.resolveRoleState(role, t));
    return this.targets.entityState(id, t)
      ?? this.celestialSystem.find(id)?.motion.stateAt(this.bodiesPivot) ?? null;
  }

  // 基準 id が公転している主天体。離心率1未満の周回軌道にないなら null。
  // 直近1件だけ憶える — 同じ id が同一フレーム内で重ねて問われ、探索は天体数に線形に効く。
  attractorOf(id: string, t: number): string | null {
    // 天体を引く時刻はフレームごとに動くので、キャッシュもフレームで区切る。
    const key = `${this.frameIndex}|${id}|${t}`;
    if (this.attractorCacheKey === key) return this.attractorCacheValue;
    const result = this.computeAttractorOf(id, t);
    this.attractorCacheKey = key;
    this.attractorCacheValue = result;
    return result;
  }

  // 主天体を実際に探索する。
  private computeAttractorOf(id: string, t: number): string | null {
    const state = this.stateOf(id, t);
    return state !== null
      ? orbitingAttractorOf(state, this.bodies, this.bodiesPivot)?.id ?? null : null;
  }

  // 役割トークンをその時点の対象へ解決した、猶予を掛ける前の結果。
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

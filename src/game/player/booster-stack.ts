// 分離式ブースターの物理・状態モデル。船体側から最後尾へ並ぶ段の並びと、その採番・燃焼・
// 分離の数値を持つ。燃焼は、刻みの途中で燃料が尽きても実際に燃焼していた時間の割合で推力を返す。
import { addScaled, type Vec3 } from '../../math/vec3';
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';

const idAllocator = new EntityIdAllocator('booster-');

// ブースターの ID を払い出す。restoredId を渡すとそれを採番済みにしてそのまま返す。
// 接続中の段と分離後エンティティは同じ ID を引き継ぐ。
export function nextBoosterId(restoredId?: string): string {
  return idAllocator.next(restoredId);
}

/** 燃料を含む、スタック内の一段の可変状態。質量の単位は kg、推力は N。 */
export interface BoosterStage {
  readonly id: string;
  readonly dryMass: number;
  fuel: number;
  readonly maxFuel: number;
  readonly thrust: number;
  readonly fuelRate: number;
  ignited: boolean;
}

/** セーブデータに使うスタック全体の plain data。 */
export interface BoosterStackData {
  readonly stages: BoosterStage[];
}

/** 1 回の step で最後尾段が発生した燃焼結果。 */
interface BoosterStepResult {
  /** この dt 全体で平均した推力 [N]。フレーム途中で燃料が切れれば小さくなる。 */
  readonly averageThrust: number;
  /** dt のうち燃焼していた割合 (0..1)。 */
  readonly burnRatio: number;
  /** この step で消費した燃料 [kg]。 */
  readonly fuelConsumed: number;
}

// 燃焼区間で質量が線形に減るときの平均加速度。平均推力を最終質量だけで割ると、
// 大きな刻みほどΔvを過大評価するため、始終質量の対数平均を使う。推力・質量が正でなければ 0。
export function boosterAverageAcceleration(
  result: BoosterStepResult,
  massBefore: number,
  massAfter: number,
): number {
  if (result.averageThrust <= 0 || massBefore <= 0 || massAfter <= 0) return 0;
  if (!Number.isFinite(massBefore) || !Number.isFinite(massAfter)) return 0;
  const ratio = massBefore / massAfter;
  if (Math.abs(ratio - 1) < 1e-12) return result.averageThrust / massAfter;
  const logarithmicMeanMass = (massBefore - massAfter) / Math.log(ratio);
  return logarithmicMeanMass > 0 ? result.averageThrust / logarithmicMeanMass : 0;
}

export interface BoosterSeparationVelocities {
  readonly player: Vec3;
  readonly booster: Vec3;
}

// 機首方向 forward に対しブースターが船尾へ relativeSpeed で離れるよう、
// 両者へ運動量を保存する速度差を配る。baseVelocity は分離直前の共通速度。
export function boosterSeparationVelocities(
  baseVelocity: Vec3,
  forward: Vec3,
  playerMass: number,
  boosterMass: number,
  relativeSpeed: number,
): BoosterSeparationVelocities {
  const totalMass = playerMass + boosterMass;
  if (totalMass <= 0 || relativeSpeed <= 0) {
    return { player: { ...baseVelocity }, booster: { ...baseVelocity } };
  }

  // 相対速度を質量の逆比で両者へ配る
  const playerDelta = relativeSpeed * boosterMass / totalMass;
  const boosterDelta = -relativeSpeed * playerMass / totalMass;
  return {
    player: addScaled(baseVelocity, forward, playerDelta),
    booster: addScaled(baseVelocity, forward, boosterDelta),
  };
}

const NO_BURN: BoosterStepResult = Object.freeze({
  averageThrust: 0,
  burnRatio: 0,
  fuelConsumed: 0,
});

// value が有限の非負数でなければ、name を添えて RangeError を投げる。
function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

// 段データを検証して複製する。不正な値には TypeError / RangeError を投げる。
function cloneStage(data: BoosterStage): BoosterStage {
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new TypeError('booster stage id must be a non-empty string');
  }
  finiteNonNegative(data.dryMass, 'booster stage dryMass');
  finiteNonNegative(data.fuel, 'booster stage fuel');
  finiteNonNegative(data.maxFuel, 'booster stage maxFuel');
  finiteNonNegative(data.thrust, 'booster stage thrust');
  finiteNonNegative(data.fuelRate, 'booster stage fuelRate');
  if (data.fuel > data.maxFuel) {
    throw new RangeError('booster stage fuel cannot exceed maxFuel');
  }
  if (typeof data.ignited !== 'boolean') {
    throw new TypeError('booster stage ignited must be a boolean');
  }

  return {
    id: data.id,
    dryMass: data.dryMass,
    fuel: data.fuel,
    maxFuel: data.maxFuel,
    thrust: data.thrust,
    fuelRate: data.fuelRate,
    // 燃料ゼロの段は消火状態で読み込む。
    ignited: data.fuel > 0 && data.ignited,
  };
}

/**
 * 分離式ブースターの段スタック。配列は船体側 -> 最後尾の順で、attach/detach/燃焼は
 * 末尾の段に対して行う。attach と import は入力を複製して持つ。
 */
export class BoosterStack {
  private readonly _stages: BoosterStage[];

  // stages を検証・複製して始める。
  public constructor(stages: readonly BoosterStage[] = []) {
    this._stages = stages.map(cloneStage);
  }

  /** 船体側から最後尾順に並べた段の複製。 */
  public get stages(): readonly BoosterStage[] {
    return this._stages.map((stage) => ({ ...stage }));
  }

  /** 船体側から最後尾順の段の識別子。 */
  public get stageIds(): readonly string[] {
    return this._stages.map((stage) => stage.id);
  }

  /** 全段の乾燥質量と残燃料を足した、船体に加わる質量 [kg]。 */
  public get totalMass(): number {
    return this._stages.reduce((sum, stage) => sum + stage.dryMass + stage.fuel, 0);
  }

  /** 段を最後尾へ追加する。入力段はコピーされる。 */
  public attach(stage: BoosterStage): void {
    this._stages.push(cloneStage(stage));
  }

  /**
   * 最後尾段の点火状態を反転する。段が無い、または燃料が無い場合は点火せず false を返す。
   * 消火は燃料の有無によらず可能で、戻り値は操作後の点火状態。
   */
  public toggleIgnition(): boolean {
    const stage = this._stages[this._stages.length - 1];
    if (!stage) return false;
    if (stage.ignited) {
      stage.ignited = false;
      return false;
    }
    if (stage.fuel <= 0) return false;
    stage.ignited = true;
    return true;
  }

  /**
   * dt 秒ぶん、最後尾段を燃焼させる。fuelRate=0 の段は燃料を減らさずに燃え続ける。
   * dt 内で燃料が尽きたときは、burnRatio と averageThrust が燃焼していた時間の割合で縮み、
   * 段は消火される。
   */
  public step(dt: number): BoosterStepResult {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('booster step dt must be finite and non-negative');
    if (dt === 0) return NO_BURN;

    const stage = this._stages[this._stages.length - 1];
    if (!stage || !stage.ignited || stage.fuel <= 0) {
      if (stage && stage.fuel <= 0) stage.ignited = false;
      return NO_BURN;
    }

    // rate=0 なら燃焼時間は dt 全体。有限 rate なら燃料が尽きるまでの時間を求める。
    const burnTime = stage.fuelRate > 0
      ? Math.min(dt, stage.fuel / stage.fuelRate)
      : dt;
    const consumed = stage.fuelRate > 0 ? Math.min(stage.fuel, stage.fuelRate * burnTime) : 0;
    stage.fuel -= consumed;
    // 丸め誤差で微小な負値を残さず、燃料切れを点火状態へ即時反映する。
    if (stage.fuel <= Number.EPSILON * Math.max(1, stage.maxFuel)) {
      stage.fuel = 0;
      stage.ignited = false;
    }

    const burnRatio = burnTime / dt;
    return {
      averageThrust: stage.thrust * burnRatio,
      burnRatio,
      fuelConsumed: consumed,
    };
  }

  /** 最後尾段を状態ごと取り外して返す。空なら null。 */
  public detachOutermost(): BoosterStage | null {
    return this._stages.pop() ?? null;
  }

  /** セーブ用 plain data(内部状態の複製)。 */
  public exportData(): BoosterStackData {
    return { stages: this._stages.map((stage) => ({ ...stage })) };
  }

  /** セーブ用 plain data から新しいスタックを復元する。 */
  public static importData(data: BoosterStackData): BoosterStack {
    if (!data || !Array.isArray(data.stages)) throw new TypeError('booster stack data must contain a stages array');
    return new BoosterStack(data.stages);
  }
}

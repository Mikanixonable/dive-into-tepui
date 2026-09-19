// 分離式ブースターの物理・状態モデル。船体側から最後尾へ並ぶ段の並びと、その燃焼・分離の
// 数値を持つ。燃焼は、刻みの途中で燃料が尽きても実際に燃焼していた時間の割合で推力を返す。
import { addScaled, type Vec3 } from '../../math/vec3';

/** 燃料を含む、スタック内の一段の状態。質量の単位は kg、推力は N。 */
export interface BoosterStage {
  readonly id: string;
  readonly dryMass: number;
  readonly fuel: number;
  readonly maxFuel: number;
  readonly thrust: number;
  readonly fuelRate: number;
  readonly ignited: boolean;
}

// スタックが燃焼と点火で書き換える、段の内部状態。
interface StageState extends BoosterStage {
  fuel: number;
  ignited: boolean;
}

export interface SerializedBoosterStack {
  readonly stages: BoosterStage[];
}

/** 最後尾段を dt 秒のあいだ燃やしたときの燃焼結果。 */
interface BoosterBurn {
  /** この dt 全体で平均した推力 [N]。フレーム途中で燃料が切れれば小さくなる。 */
  readonly averageThrust: number;
  /** dt のうち燃焼していた割合 (0..1)。 */
  readonly burnRatio: number;
  /** この dt で消費する燃料 [kg]。 */
  readonly fuelConsumed: number;
}

// 燃焼区間で質量が線形に減るときの平均加速度。平均推力を最終質量だけで割ると、
// 大きな刻みほどΔvを過大評価するため、始終質量の対数平均を使う。推力・質量が正でなければ 0。
export function boosterAverageAcceleration(
  result: BoosterBurn,
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

const NO_BURN: BoosterBurn = Object.freeze({
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
function cloneStage(stage: BoosterStage): StageState {
  if (typeof stage.id !== 'string' || stage.id.length === 0) {
    throw new TypeError('booster stage id must be a non-empty string');
  }
  finiteNonNegative(stage.dryMass, 'booster stage dryMass');
  finiteNonNegative(stage.fuel, 'booster stage fuel');
  finiteNonNegative(stage.maxFuel, 'booster stage maxFuel');
  finiteNonNegative(stage.thrust, 'booster stage thrust');
  finiteNonNegative(stage.fuelRate, 'booster stage fuelRate');
  if (stage.fuel > stage.maxFuel) {
    throw new RangeError('booster stage fuel cannot exceed maxFuel');
  }
  if (typeof stage.ignited !== 'boolean') {
    throw new TypeError('booster stage ignited must be a boolean');
  }

  return {
    id: stage.id,
    dryMass: stage.dryMass,
    fuel: stage.fuel,
    maxFuel: stage.maxFuel,
    thrust: stage.thrust,
    fuelRate: stage.fuelRate,
    // 燃料ゼロの段は消火状態で読み込む。
    ignited: stage.fuel > 0 && stage.ignited,
  };
}

/**
 * 分離式ブースターの段スタック。配列は船体側 -> 最後尾の順で、attach/detach/燃焼は
 * 末尾の段に対して行う。構築と attach は入力を複製して持つ。
 */
export class BoosterStack {
  private readonly _stages: StageState[];

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

  /** 最後尾段が点火しているか。段が無ければ false。 */
  public get ignited(): boolean {
    return this._stages[this._stages.length - 1]?.ignited ?? false;
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
   * 最後尾段の点火状態を反転する。段が無い、または燃料が無い段は点火しない。消火は燃料の有無に
   * よらず可能。
   */
  public toggleIgnition(): void {
    const stage = this._stages[this._stages.length - 1];
    if (!stage) return;
    stage.ignited = !stage.ignited && stage.fuel > 0;
  }

  /**
   * 最後尾段を dt 秒のあいだ燃やしたときの燃焼結果。fuelRate=0 の段は燃料を減らさずに燃え続ける。
   * dt 内で燃料が尽きるときは、burnRatio と averageThrust が燃焼していた時間の割合で縮む。
   */
  public burnOver(dt: number): BoosterBurn {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('booster burn dt must be finite and non-negative');
    const stage = this._stages[this._stages.length - 1];
    if (dt === 0 || !stage || !stage.ignited || stage.fuel <= 0) return NO_BURN;

    // rate=0 なら燃焼時間は dt 全体。有限 rate なら燃料が尽きるまでの時間を求める。
    const burnTime = stage.fuelRate > 0
      ? Math.min(dt, stage.fuel / stage.fuelRate)
      : dt;
    const burnRatio = burnTime / dt;
    return {
      averageThrust: stage.thrust * burnRatio,
      burnRatio,
      fuelConsumed: stage.fuelRate > 0 ? Math.min(stage.fuel, stage.fuelRate * burnTime) : 0,
    };
  }

  /** 最後尾段を dt 秒のあいだ燃やす(燃焼結果は burnOver)。燃料が尽きた段は消火される。 */
  public burn(dt: number): void {
    const stage = this._stages[this._stages.length - 1];
    if (!stage) return;
    stage.fuel -= this.burnOver(dt).fuelConsumed;
    // 丸め誤差で微小な負値を残さず、燃料切れを点火状態へ即時反映する。
    if (stage.fuel <= Number.EPSILON * Math.max(1, stage.maxFuel)) {
      stage.fuel = 0;
      stage.ignited = false;
    }
  }

  /** 最後尾段を取り外す。空なら何もしない。 */
  public detachOutermost(): void {
    this._stages.pop();
  }

  /** 直列化した形(内部状態の複製)。 */
  public serialize(): SerializedBoosterStack {
    return { stages: this._stages.map((stage) => ({ ...stage })) };
  }

  /** 直列化した段の並びから復元する。不正な記録には TypeError / RangeError を投げる。 */
  public static deserialize(serialized: SerializedBoosterStack): BoosterStack {
    if (!serialized || !Array.isArray(serialized.stages)) {
      throw new TypeError('booster stack data must contain a stages array');
    }
    return new BoosterStack(serialized.stages);
  }
}

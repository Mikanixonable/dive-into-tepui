// 分離式ブースターの物理・状態モデル。
//
// この層は Three.js や Player を知らず、船体側から最後尾へ並ぶ段の配列だけを持つ。
// 推力と燃料の更新をここへ閉じ込めることで、描画フレームの刻みが燃料切れをまたいでも
// 実際に燃焼していた時間だけを上位の運動方程式へ渡せる。
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';

const idAllocator = new EntityIdAllocator('booster-');

// 接続中の段と分離後エンティティで同じ ID を引き継ぐ。
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

/** セーブデータに使う JSON 化可能な一段の形。 */
export type BoosterStageData = BoosterStage;

/** セーブデータに使うスタック全体の plain data。 */
export interface BoosterStackData {
  stages: BoosterStageData[];
}

/** 1 回の step で最後尾段が発生した燃焼結果。 */
export interface BoosterStepResult {
  /** この dt 全体で平均した推力 [N]。フレーム途中で燃料が切れれば小さくなる。 */
  readonly thrust: number;
  /** thrust と同じ値を意味が明確な名前でも返す。 */
  readonly averageThrust: number;
  /** dt のうち燃焼していた割合 (0..1)。 */
  readonly burnRatio: number;
  /** この step で消費した燃料 [kg]。 */
  readonly fuelConsumed: number;
  /** この step で点火していたか。燃料切れ直後も、発生推力の有無を追跡しやすい。 */
  readonly burning: boolean;
}

// 燃焼区間で質量が線形に減るときの平均加速度。平均推力を最終質量だけで割ると、
// 大きな刻みほどΔvを過大評価するため、始終質量の対数平均を使う。
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

const NO_BURN: BoosterStepResult = Object.freeze({
  thrust: 0,
  averageThrust: 0,
  burnRatio: 0,
  fuelConsumed: 0,
  burning: false,
});

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function cloneStage(data: BoosterStageData): BoosterStage {
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
    // 燃料ゼロの保存データを読み込んでも「空の段が点火中」にはしない。
    ignited: data.fuel > 0 && data.ignited,
  };
}

function noBurn(): BoosterStepResult {
  return NO_BURN;
}

/**
 * 分離式ブースターの段スタック。
 *
 * 配列の順序は常に船体側 -> 最後尾であり、attach/detach/燃焼の対象は末尾だけに限定
 * される。attach と import は入力をコピーするため、呼び出し側のオブジェクトを後から
 * 書き換えてもスタックの不変条件を壊さない。
 */
export class BoosterStack {
  private readonly _stages: BoosterStage[];

  constructor(stages: readonly BoosterStageData[] = []) {
    this._stages = stages.map(cloneStage);
  }

  /** 船体側から最後尾順の段を読む。外部からの変更でスタックの不変条件を壊せない。 */
  get stages(): readonly BoosterStage[] {
    return this._stages.map((stage) => ({ ...stage }));
  }

  /** 全段の乾燥質量と残燃料を足した、船体に加わる質量 [kg]。 */
  get totalMass(): number {
    return this._stages.reduce((sum, stage) => sum + stage.dryMass + stage.fuel, 0);
  }

  /** 段を最後尾へ追加する。入力段はコピーされる。 */
  attach(stage: BoosterStageData): void {
    this._stages.push(cloneStage(stage));
  }

  /**
   * 最後尾段の点火状態を反転する。段が無い、または燃料が無い場合は点火せず false を返す。
   * 消火は燃料の有無によらず可能で、戻り値は操作後の点火状態。
   */
  toggleIgnition(): boolean {
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
   * dt 秒ぶん、最後尾段だけを燃焼させる。
   *
   * fuelRate=0 は「燃料を消費しない試験用/無限燃焼段」として扱い、有限燃料を持つ段の
   * 通常設定では fuelRate>0 を使う。dt 内で燃料が尽きたときは burnRatio と averageThrust
   * が燃焼時間の割合を返すので、呼び出し側はフレーム全体へ一定推力を誤って適用しない。
   */
  step(dt: number): BoosterStepResult {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('booster step dt must be finite and non-negative');
    if (dt === 0) return noBurn();

    const stage = this._stages[this._stages.length - 1];
    if (!stage || !stage.ignited || stage.fuel <= 0) {
      if (stage && stage.fuel <= 0) stage.ignited = false;
      return noBurn();
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
    const averageThrust = stage.thrust * burnRatio;
    return {
      thrust: averageThrust,
      averageThrust,
      burnRatio,
      fuelConsumed: consumed,
      burning: burnTime > 0,
    };
  }

  /** 最後尾段を状態ごと取り外して返す。空なら null。 */
  detachOutermost(): BoosterStage | null {
    return this._stages.pop() ?? null;
  }

  /** セーブ用 plain data。返却値を編集してもスタックへ影響しない。 */
  exportData(): BoosterStackData {
    return { stages: this._stages.map((stage) => ({ ...stage })) };
  }

  /** セーブ用 plain data から新しいスタックを復元する。 */
  static importData(data: BoosterStackData): BoosterStack {
    if (!data || !Array.isArray(data.stages)) throw new TypeError('booster stack data must contain a stages array');
    return new BoosterStack(data.stages);
  }
}

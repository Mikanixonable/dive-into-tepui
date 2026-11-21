// 気圧へ書き込む低気圧の谷の配置を、吸収込みで時刻の閉じた関数として答える。中緯度の低気圧は
// low-tracks、熱帯低気圧は tropical-tracks が一生を組み、ここはそれらの生の配置を集めて
// 近づきすぎた中心どうしの吸収をかける。吸収の効きは全ての低気圧の生の配置を ±窓 で標本化
// した上で決まるので、全渦・全刻みの生の配置を先に表へ起こして分け合う — 1 渦ずつ引くと
// 同じ生の配置を相手ごと・刻みごとに組み直すことになる。
import { LOW_COUNT, rawLowPlacementAt } from './low-tracks';
import { TROPICAL_COUNT, rawTropicalPlacementAt } from './tropical-tracks';
import {
  ABSORB_WINDOW_STEP, ABSORB_WINDOW_STEPS, absorbedVortexAt,
} from './vortex-absorption';
import type { RawVortex } from './vortex-absorption';
import type { PressurePlacement } from './tracks';

// 低気圧の渦の総数。0..LOW_COUNT − 1 が中緯度の低気圧、LOW_COUNT.. が熱帯低気圧。
const VORTEX_COUNT = LOW_COUNT + TROPICAL_COUNT;

// 渦 vortex(0..VORTEX_COUNT − 1)の、時刻 seconds [s] における生の配置。
function rawVortexAt(
  vortex: number, seconds: number, surfaceRadius: number, rotationPeriod: number,
): RawVortex | null {
  return vortex < LOW_COUNT
    ? rawLowPlacementAt(vortex, seconds, surfaceRadius, rotationPeriod)
    : rawTropicalPlacementAt(vortex - LOW_COUNT, seconds, rotationPeriod);
}

// 中緯度の低気圧 index(0..LOW_COUNT − 1)の、時刻 seconds [s] における配置。吸収の効きは
// 熱帯の渦を含む全ての低気圧の生の配置から決まる。surfaceRadius [m] は天体の半径、
// rotationPeriod [s] はその自転周期。生まれる前と消えたあとは null。
export function lowPlacementAt(
  index: number, seconds: number, surfaceRadius: number, rotationPeriod: number,
): PressurePlacement | null {
  return absorbedVortexAt(
    index, VORTEX_COUNT, surfaceRadius,
    (j, k) => rawVortexAt(
      j, seconds + k * ABSORB_WINDOW_STEP, surfaceRadius, rotationPeriod),
  );
}

// 熱帯低気圧 index(0..TROPICAL_COUNT − 1)の、時刻 seconds [s] における配置。吸収の効きは
// 中緯度を含む全ての低気圧の生の配置から決まる。その世代に発生しない、生まれる前、
// 消えたあとは null。
export function tropicalPlacementAt(
  index: number, seconds: number, surfaceRadius: number, rotationPeriod: number,
): PressurePlacement | null {
  return absorbedVortexAt(
    LOW_COUNT + index, VORTEX_COUNT, surfaceRadius,
    (j, k) => rawVortexAt(
      j, seconds + k * ABSORB_WINDOW_STEP, surfaceRadius, rotationPeriod),
  );
}

// 全ての低気圧の、時刻 seconds [s] における配置。戻り値の lows/tropicals の index 番目は
// それぞれ lowPlacementAt・tropicalPlacementAt と同じ。
export function cyclonePlacementsAt(
  seconds: number, surfaceRadius: number, rotationPeriod: number,
): { readonly tropicals: readonly (PressurePlacement | null)[];
    readonly lows: readonly (PressurePlacement | null)[] } {
  // 生の配置の表 [渦][窓の標本]。標本は時刻から −窓 側が先頭。
  const raw = Array.from({ length: VORTEX_COUNT }, (_, j) =>
    Array.from({ length: 2 * ABSORB_WINDOW_STEPS + 1 }, (_, k) =>
      rawVortexAt(
        j, seconds + (k - ABSORB_WINDOW_STEPS) * ABSORB_WINDOW_STEP,
        surfaceRadius, rotationPeriod)));
  const absorbed = Array.from({ length: VORTEX_COUNT }, (_, vortex) =>
    absorbedVortexAt(vortex, VORTEX_COUNT, surfaceRadius, (j, k) => raw[j]![k + ABSORB_WINDOW_STEPS]!));
  return {
    tropicals: absorbed.slice(LOW_COUNT),
    lows: absorbed.slice(0, LOW_COUNT),
  };
}

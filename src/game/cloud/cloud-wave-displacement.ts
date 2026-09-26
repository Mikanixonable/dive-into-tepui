// 環境の重力波 driver が立つ場で、堆積済みの層別質量場へ波の鉛直変位を適用する。
// 湿潤層が波の節・腹で持ち上がり・沈み込む形を、セルごとの層間再配分で表す — 各層の
// 質量が占める高度区間を位相変位 η だけずらし、ずらした区間と各層の重なりで質量を同じ
// 層格子へ畳み直す。質量は増やさず消さず、格子端を超える変位分は端の層へ畳む
// (保存はこの関数内で残差点検する)。
// 波の位相は φ(x,t) = k_e·east + k_n·north − ω·t。水平波数ベクトルと角振動数は、環境の
// gravityWaveDriver が線形 Boussinesq 分散関係から導いた位相速度から復元する — 物質輸送
// の風とは独立に、雲の流れと波の伝播が一致しないことを分離して保つ(波状雲の本質)。
// 近似:
// - 変位の鉛直構造(層内での位相・振幅の変化)は解かず、源の変位振幅を全層へ同位相で
//   当てる。層の厚みは鉛直波長より小さいという扱い。
// - 凝結・蒸発そのものは解かない。凝結可否は driver の cloudCondensationPossible が
//   場全体を on/off するゲートとして使い、閉じる場では変位を適用しない。
// - 場の環境は呼び手が一点で評価したものを使う(空間変化は位相へ含めない)。

import type { CloudEnvironmentProfile } from './cloud-environment';
import type { CloudFootprintGrid } from './cloud-footprint-overlap';
import type { CloudMassDeposition, CloudMassPhase } from './cloud-mass-deposition';

// 場へ適用する平面波の最小パラメータ。環境 driver から一度だけ導く。
export interface CloudGravityWaveField {
  readonly eastWavenumberPerM: number;
  readonly northWavenumberPerM: number;
  readonly angularFrequencyRadPerS: number;
  readonly displacementAmplitudeM: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

// 波が雲を作れる環境では波場を返し、それ以外(波源なし・不安定・未飽和)では null を返す。
// 水平波数ベクトルは位相速度ベクトル c = ω·k̂/k_h から k = ω·c/c_h² で復元するので、
// 波源入力を持ち出さず driver の成分だけで位相場を張れる。
export function cloudGravityWaveFieldFromEnvironment(
  environment: CloudEnvironmentProfile,
): CloudGravityWaveField | null {
  const driver = environment.gravityWaveDriver;
  if (!driver.active || !driver.cloudCondensationPossible) return null;
  const angularFrequencyRadPerS = driver.intrinsicAngularFrequencyRadPerS;
  const horizontalPhaseSpeedMps = driver.horizontalPhaseSpeedMps;
  if (angularFrequencyRadPerS <= 0 || horizontalPhaseSpeedMps <= 0) {
    throw new RangeError('an active gravity-wave driver must carry a positive frequency and phase speed');
  }
  const phaseSpeedSquared = horizontalPhaseSpeedMps * horizontalPhaseSpeedMps;
  return Object.freeze({
    eastWavenumberPerM: angularFrequencyRadPerS
      * driver.eastwardPhaseSpeedMps / phaseSpeedSquared,
    northWavenumberPerM: angularFrequencyRadPerS
      * driver.northwardPhaseSpeedMps / phaseSpeedSquared,
    angularFrequencyRadPerS,
    displacementAmplitudeM: driver.verticalDisplacementM,
  });
}

// 上向き正の波変位 [m]。φ = k_e·east + k_n·north − ω·t の調和成分。
export function gravityWaveDisplacementM(
  wave: CloudGravityWaveField,
  eastM: number,
  northM: number,
  timeSeconds: number,
): number {
  return wave.displacementAmplitudeM * Math.sin(
    wave.eastWavenumberPerM * eastM + wave.northWavenumberPerM * northM
      - wave.angularFrequencyRadPerS * timeSeconds,
  );
}

function validateWave(wave: CloudGravityWaveField): void {
  requireFinite(wave.eastWavenumberPerM, 'wave.eastWavenumberPerM');
  requireFinite(wave.northWavenumberPerM, 'wave.northWavenumberPerM');
  if (wave.eastWavenumberPerM === 0 && wave.northWavenumberPerM === 0) {
    throw new RangeError('wave wavenumbers must not both be zero');
  }
  requireNonNegative(wave.angularFrequencyRadPerS, 'wave.angularFrequencyRadPerS');
  requireNonNegative(wave.displacementAmplitudeM, 'wave.displacementAmplitudeM');
}

// 1 列ぶんの層別質量 [kg/m²] を、全区間を η だけずらしたあとの層別質量へ畳み直す。
// 各区間の密度は層内一様とし、ずらした区間と各層の重なり長さの比で分配する。格子端を
// はみ出る分は端の層へ畳むので、各層への分配比の合計は常に 1 になる。
function shiftColumnMassKgM2(
  massesKgM2ByLayer: readonly number[],
  layerEdgesM: readonly number[],
  etaM: number,
): number[] {
  const layerCount = massesKgM2ByLayer.length;
  const shifted = new Array<number>(layerCount).fill(0);
  const topEdgeM = layerEdgesM[layerCount]!;
  const bottomEdgeM = layerEdgesM[0]!;
  for (let source = 0; source < layerCount; source += 1) {
    const lowerEdgeM = layerEdgesM[source]!;
    const depthM = layerEdgesM[source + 1]! - lowerEdgeM;
    if (depthM <= 0) throw new RangeError('layer edges must be strictly increasing');
    const massKgM2 = massesKgM2ByLayer[source]!;
    if (massKgM2 === 0) continue;
    const lowM = lowerEdgeM + etaM;
    const highM = lowM + depthM;
    // 下端より下・上端より上へはみ出る分は、表現できない外側へ置かず端の層へ畳む。
    const belowM = Math.max(0, Math.min(highM, bottomEdgeM) - lowM);
    const aboveM = Math.max(0, highM - Math.max(lowM, topEdgeM));
    shifted[0]! += massKgM2 * belowM / depthM;
    shifted[layerCount - 1]! += massKgM2 * aboveM / depthM;
    for (let layer = 0; layer < layerCount; layer += 1) {
      const overlapM = Math.max(0,
        Math.min(highM, layerEdgesM[layer + 1]!) - Math.max(lowM, layerEdgesM[layer]!));
      if (overlapM > 0) shifted[layer]! += massKgM2 * overlapM / depthM;
    }
  }
  return shifted;
}

function columnMassTotalKg(deposition: CloudMassDeposition, phase: CloudMassPhase): number {
  const perLayer = deposition.columnsByLayer.map(
    (layer) => phase === 'liquid' ? layer.liquidKgM2ByCell : layer.iceKgM2ByCell);
  let total = 0;
  let correction = 0;
  for (const columns of perLayer) {
    for (const massKgM2 of columns) {
      const adjusted = massKgM2 - correction;
      const next = total + adjusted;
      correction = (next - total) - adjusted;
      total = next;
    }
  }
  return total + deposition.unassignedMassKgByPhase[phase];
}

// 格子の全セルへ位相変位を当て、層別質量を再配分した新しい堆積を返す。格子は
// cellIndex = row·width + column の row-major、セルの位相はその中心の東・北座標で評る。
// 変位の伝播は波場の位相速度だけで決まり、堆積の輸送に使った物質風へは一切触れない。
export function displaceCloudMassByWave(
  deposition: CloudMassDeposition,
  wave: CloudGravityWaveField,
  grid: CloudFootprintGrid,
  timeSeconds: number,
): CloudMassDeposition {
  validateWave(wave);
  requireFinite(timeSeconds, 'timeSeconds');
  requireFinite(grid.originEastM, 'grid.originEastM');
  requireFinite(grid.originNorthM, 'grid.originNorthM');
  if (grid.cellWidthM <= 0 || grid.cellHeightM <= 0
    || !Number.isSafeInteger(grid.width) || grid.width <= 0
    || !Number.isSafeInteger(grid.height) || grid.height <= 0) {
    throw new RangeError('grid dimensions and cell sizes must be positive');
  }
  const cellCount = grid.width * grid.height;
  const layerEdgesM = deposition.columnsByLayer.map((layer) => layer.lowerAltitudeM);
  layerEdgesM.push(deposition.columnsByLayer.at(-1)?.upperAltitudeM ?? Number.NaN);
  if (!layerEdgesM.every(Number.isFinite)) {
    throw new RangeError('deposition layers must carry finite edges');
  }
  for (const layer of deposition.columnsByLayer) {
    if (layer.liquidKgM2ByCell.length !== cellCount || layer.iceKgM2ByCell.length !== cellCount) {
      throw new RangeError('deposition cell counts must match the footprint grid');
    }
  }

  const liquidSourceByLayer = deposition.columnsByLayer.map((layer) => layer.liquidKgM2ByCell);
  const iceSourceByLayer = deposition.columnsByLayer.map((layer) => layer.iceKgM2ByCell);
  const liquidByLayer = deposition.columnsByLayer.map(() => new Array<number>(cellCount).fill(0));
  const iceByLayer = deposition.columnsByLayer.map(() => new Array<number>(cellCount).fill(0));
  const liquidScratch = new Array<number>(deposition.columnsByLayer.length).fill(0);
  const iceScratch = new Array<number>(deposition.columnsByLayer.length).fill(0);
  const layerCount = deposition.columnsByLayer.length;
  for (let row = 0; row < grid.height; row += 1) {
    const northM = grid.originNorthM + (row + 0.5) * grid.cellHeightM;
    for (let column = 0; column < grid.width; column += 1) {
      const cellIndex = row * grid.width + column;
      const eastM = grid.originEastM + (column + 0.5) * grid.cellWidthM;
      const etaM = gravityWaveDisplacementM(wave, eastM, northM, timeSeconds);
      for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
        liquidScratch[layerIndex] = liquidSourceByLayer[layerIndex]![cellIndex]!;
        iceScratch[layerIndex] = iceSourceByLayer[layerIndex]![cellIndex]!;
      }
      const liquidShifted = etaM === 0
        ? liquidScratch : shiftColumnMassKgM2(liquidScratch, layerEdgesM, etaM);
      const iceShifted = etaM === 0
        ? iceScratch : shiftColumnMassKgM2(iceScratch, layerEdgesM, etaM);
      for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
        liquidByLayer[layerIndex]![cellIndex] = liquidShifted[layerIndex]!;
        iceByLayer[layerIndex]![cellIndex] = iceShifted[layerIndex]!;
      }
    }
  }
  const displaced: CloudMassDeposition = {
    columnsByLayer: deposition.columnsByLayer.map((layer, index) => ({
      lowerAltitudeM: layer.lowerAltitudeM,
      upperAltitudeM: layer.upperAltitudeM,
      liquidKgM2ByCell: liquidByLayer[index]!,
      iceKgM2ByCell: iceByLayer[index]!,
    })),
    unassignedMassKgByPhase: { ...deposition.unassignedMassKgByPhase },
  };
  // 畳み直しは質量を生やしたり消したりしないので、残差が出たら実装の誤りとして落とす。
  for (const phase of ['liquid', 'ice'] as const) {
    const beforeKg = columnMassTotalKg(deposition, phase);
    const afterKg = columnMassTotalKg(displaced, phase);
    const toleranceKg = Math.max(Number.MIN_VALUE, Math.abs(beforeKg) * 1e-10);
    if (!Number.isFinite(afterKg) || Math.abs(afterKg - beforeKg) > toleranceKg) {
      throw new RangeError(`${phase} mass is not conserved by gravity-wave displacement`);
    }
  }
  return displaced;
}

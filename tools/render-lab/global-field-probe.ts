// 全球質量場の中身を CPU で直に読む診査口。製品が供給へ渡すのと同じ環境・種・格子で
// 供給ジョブ(製品と同じ worker 帯分割、組めない環境では同期供給)を完走させ、
// 凝結済みテクセル(製品がテクスチャへ載せる値そのもの)の被覆率分布を返す。
// 描画経路を通らないので、「場が疎か、描画が拾えていないか」を切り分ける。
import climateTextureUrl from '../../src/assets/earth-climate.png';
import { v3 } from '../../src/math/vec3';
import { AnnualClimateMap } from '../../src/render/cloud/climate-map';
import { AtmosphericWindField } from '../../src/render/cloud/atmospheric-wind';
import { condenseGlobalMassField } from '../../src/render/cloud/cloud-global-condensation';
import { ConvectiveCloudGlobalFieldSupply } from '../../src/game/cloud/cloud-global-field-supply';
import type { CloudGlobalFieldSupplyResult } from '../../src/game/cloud/cloud-global-field-supply';
import {
  ConvectiveCloudGlobalFieldWorkerSupply,
} from '../../src/game/cloud/cloud-global-field-worker-client';
import { makeWindAt } from '../../src/game/cloud/cloud-local-field-supply';
import { earthGlobalEnvironmentAt } from '../../src/game/cloud/earth-global-environment';
import { R_EARTH, R_EARTH_EQ, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';

// earth-system.ts の私有定数(EARTH_CLOUD_GLOBAL_SEED・equirect 格子の寸法・
// イベントセル間隔)と揃える — 私有なので値をここへ写す。ずれるとこの診査は製品の場とは
// 別の場を読む。
const GLOBAL_SEED = 137;
const GRID_WIDTH = 512;
const GRID_HEIGHT = 256;
const EVENT_CELL_SPACING_M = 100e3;

export interface GlobalCloudFieldProbe {
  readonly displayTimeSeconds: number;
  readonly width: number;
  readonly height: number;
  // 供給ジョブの開始から結果が揃うまでの壁時計 [ms]。worker 帯分割ではメインスレッドの
  // CPU 時間ではなく応答待ちの時間になる。
  readonly supplyWallMs: number;
  readonly eventCount: number;
  readonly truncatedEventCount: number;
  readonly omittedMassUpperBoundKgM2: number;
  readonly eventMassKgByPhase: { readonly liquid: number; readonly ice: number };
  readonly unassignedMassKgByPhase: { readonly liquid: number; readonly ice: number };
  readonly meanCoverage: number;
  readonly maxCoverage: number;
  readonly meanTranslucent: number;
  // 被覆率が各閾値を超えるセルの割合。
  readonly fractionCoveragePositive: number;
  readonly fractionCoverageGt005: number;
  readonly fractionCoverageGt02: number;
  readonly fractionCoverageGt05: number;
  // 被覆率の最大セルの中心の緯度・経度 [deg]。
  readonly maxCoverageLatitudeDeg: number;
  readonly maxCoverageLongitudeDeg: number;
  // 行ごと(行 0 が北極側、64 行)の平均被覆率・平均薄い雲 τ。緯度帯の構造を読む。
  readonly coverageByRow: readonly number[];
  readonly translucentByRow: readonly number[];
}

// 表示時刻 displayTimeSeconds [s] の全球雲場を製品と同じ供給で導き、凝結後の統計を返す。
export async function probeGlobalCloudField(displayTimeSeconds: number): Promise<GlobalCloudFieldProbe> {
  // 気候は描画経路の DeferredTexture 経由ではなく直接読む — publishOne を呼ぶ描画
  // ループがここには無いので、遅延読み込みの器はいつまで経っても CPU から読めない。
  const climate = await AnnualClimateMap.load(climateTextureUrl);
  try {
    // 環境の CPU 読み出しは気候画像が届くまで null を返す — 届くまで待ってから導く。
    for (let i = 0; i < 200 && climate.valuesAtCpu(v3(0, 0, 1)) === null; i++) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    }
    // 製品と同じ組立て — 内側の同期供給を帯分割して worker プールへ振る供給でジョブを
    // 出す。応答は非同期に届くので、done が立つまで step を回しつつ待つ。
    const supply = new ConvectiveCloudGlobalFieldWorkerSupply(
      new ConvectiveCloudGlobalFieldSupply(
        (direction, timeSeconds) => earthGlobalEnvironmentAt(
          direction, climate, timeSeconds, R_EARTH, SIDEREAL_DAY),
        GLOBAL_SEED, R_EARTH_EQ, GRID_WIDTH, GRID_HEIGHT,
        makeWindAt(new AtmosphericWindField()), EVENT_CELL_SPACING_M),
      climate, R_EARTH, SIDEREAL_DAY);
    const job = supply.startJob(displayTimeSeconds);
    const startedAt = performance.now();
    while (!job.step(Number.POSITIVE_INFINITY).done) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    }
    const supplyWallMs = performance.now() - startedAt;
    // GlobalMassFieldJob の面は場だけを返すが、ここが組んだ供給は対流イベントの診断値を
    // 添えた結果を返す — 組立て側で分かっている形へ絞る。
    const result = job.result as CloudGlobalFieldSupplyResult | null;
    if (result === null) throw new Error('global field derive returned null');
    const { width, height } = result.field;
    const cellCount = width * height;
    const texels = condenseGlobalMassField(result.field);

    let coverageSum = 0;
    let coverageMax = 0;
    let maxCell = 0;
    let translucentSum = 0;
    let positive = 0;
    let gt005 = 0;
    let gt02 = 0;
    let gt05 = 0;
    const coverageByRow = new Array<number>(height).fill(0);
    const translucentByRow = new Array<number>(height).fill(0);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const index = (row * width + col) * 4;
        const coverage = texels[index]!;
        const translucent = texels[index + 2]!;
        coverageByRow[row]! += coverage;
        translucentByRow[row]! += translucent;
        coverageSum += coverage;
        translucentSum += translucent;
        if (coverage > coverageMax) {
          coverageMax = coverage;
          maxCell = row * width + col;
        }
        if (coverage > 0) positive++;
        if (coverage > 0.05) gt005++;
        if (coverage > 0.2) gt02++;
        if (coverage > 0.5) gt05++;
      }
    }
    const maxRow = Math.floor(maxCell / width);
    const maxCol = maxCell % width;
    return {
      displayTimeSeconds,
      width,
      height,
      supplyWallMs,
      eventCount: result.eventCount,
      truncatedEventCount: result.truncatedEventCount,
      omittedMassUpperBoundKgM2: result.omittedMassUpperBoundKgM2,
      eventMassKgByPhase: result.eventMassKgByPhase,
      unassignedMassKgByPhase: result.unassignedMassKgByPhase,
      meanCoverage: coverageSum / cellCount,
      maxCoverage: coverageMax,
      meanTranslucent: translucentSum / cellCount,
      fractionCoveragePositive: positive / cellCount,
      fractionCoverageGt005: gt005 / cellCount,
      fractionCoverageGt02: gt02 / cellCount,
      fractionCoverageGt05: gt05 / cellCount,
      // 行 0 が北極側・列 0 が経度 −180°(equirect の取り決め)。
      maxCoverageLatitudeDeg: 90 - ((maxRow + 0.5) * 180) / height,
      maxCoverageLongitudeDeg: -180 + ((maxCol + 0.5) * 360) / width,
      coverageByRow: coverageByRow.map((v) => v / width),
      translucentByRow: translucentByRow.map((v) => v / width),
    };
  } finally {
    climate.dispose();
  }
}

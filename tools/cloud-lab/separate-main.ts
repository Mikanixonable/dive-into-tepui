// 実写の分離環境の画面。パラメータのスライダーを配線し、パスを流し直しながら分離の各段を
// 目視で調整する。撮影(tools/cloud-lab-separate.mjs)の入口も window へ出す。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
// 実写の雲(ゲーム本体が地表へ貼っているもの)。この画面の分離の入力そのもの。
import cloudsPhotoUrl from '../../src/assets/8k_clouds.jpg';
import { buildButtonRow, buildSlider } from '../lab-controls';
import {
  SEPARATION_PARAMS, SEPARATION_VIEWS, SeparationPipeline,
  type SeparationParamId, type SeparationView,
} from './separation-pipeline';

// スライダーを置く行。特徴づけ → veil → 雲頂の順で、パスの流れと同じ並び。
const PARAM_ROWS: Record<SeparationParamId, string> = {
  fineScaleKm: 'feature',
  tensorWindowKm: 'feature',
  isotropyThreshold: 'feature',
  minBias: 'veil',
  stepKm: 'veil',
  denMin: 'veil',
  ceiling: 'veil',
  boundKm: 'veil',
  boundSoftness: 'veil',
  topBase: 'top',
  topSmoothKm: 'top',
  topGain: 'top',
  topRelief: 'top',
};

// 分離の質の指標。veil と thick の相関が低いほど「積雲側に巻雲らしい情報が残っていない」。
// 帯の相関は 150〜600 km(veil の特徴的な帯)へバンドパスしてから取る。天気そのものの相関が
// あるので 0 が正解ではない — 調整の相対比較にだけ使う。
type SeparationMetrics = {
  readonly veilMean: number;
  readonly thickMean: number;
  readonly corrAll: number;
  readonly corrBand: number;
};

declare global {
  interface Window {
    // 撮影の駆動(tools/cloud-lab-separate.mjs)が CDP から読む入口。
    cloudSeparate?: {
      views: readonly SeparationView[];
      show: (view: SeparationView) => void;
      setParam: (id: SeparationParamId, value: number) => void;
      capture: (view: SeparationView) => Promise<string>;
      metrics: () => Promise<SeparationMetrics>;
    };
  }
}

// 縮んだ写し(512×256)専用の素朴な箱ぼかし。端は伸ばす。
function blurSmall(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const clampX = (x: number) => Math.min(width - 1, Math.max(0, x));
  const clampY = (y: number) => Math.min(height - 1, Math.max(0, y));
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += src[y * width + clampX(x + d)]!;
      tmp[y * width + x] = sum / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += tmp[clampY(y + d) * width + x]!;
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

function pearson(a: Float32Array, b: Float32Array): number {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= a.length;
  meanB /= b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return covariance / Math.sqrt(varianceA * varianceB + 1e-12);
}

// 実写を読み、レンダラとパイプラインを起こし、操作部品を配線する。
async function init(): Promise<void> {
  const photo = await new THREE.TextureLoader().loadAsync(cloudsPhotoUrl);
  photo.wrapS = THREE.RepeatWrapping;
  photo.wrapT = THREE.ClampToEdgeWrapping;
  photo.flipY = false;
  photo.generateMipmaps = false;
  photo.minFilter = THREE.LinearFilter;
  photo.magFilter = THREE.LinearFilter;
  photo.colorSpace = THREE.NoColorSpace;
  const { width, height } = photo.image as { width: number; height: number };

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  await renderer.init();

  const pipeline = new SeparationPipeline(renderer, photo, width, height);
  let view: SeparationView = 'veil';
  const params = Object.fromEntries(
    Object.entries(SEPARATION_PARAMS).map(([id, spec]) => [id, spec.initial]),
  ) as Record<SeparationParamId, number>;

  const markView = buildButtonRow<SeparationView>('views', SEPARATION_VIEWS, (next) => {
    view = next;
    markView(view);
    pipeline.show(view);
  });

  // 分離の質の指標を測って表示する。読み出しが非同期なので、走っている間の要求は 1 つに畳む。
  const metricsOut = document.createElement('span');
  const measure = async (): Promise<SeparationMetrics> => {
    const c = await pipeline.readComponents();
    const bandOf = (data: Float32Array) => {
      const fine = blurSmall(data, c.width, c.height, 1);
      const coarse = blurSmall(data, c.width, c.height, 4);
      return Float32Array.from(fine, (v, i) => v - coarse[i]!);
    };
    let veilMean = 0;
    let thickMean = 0;
    for (let i = 0; i < c.veil.length; i++) {
      veilMean += c.veil[i]!;
      thickMean += c.thick[i]!;
    }
    return {
      veilMean: veilMean / c.veil.length,
      thickMean: thickMean / c.thick.length,
      corrAll: pearson(c.veil, c.thick),
      corrBand: pearson(bandOf(c.veil), bandOf(c.thick)),
    };
  };
  let measuring = false;
  let measureAgain = false;
  const refreshMetrics = (): void => {
    if (measuring) {
      measureAgain = true;
      return;
    }
    measuring = true;
    void measure().then((m) => {
      metricsOut.textContent = `相関 全体 ${m.corrAll.toFixed(3)} / 150-600km ${m.corrBand.toFixed(3)}`
        + ` | 平均 veil ${m.veilMean.toFixed(3)} / thick ${m.thickMean.toFixed(3)}`;
      measuring = false;
      if (measureAgain) {
        measureAgain = false;
        refreshMetrics();
      }
    });
  };

  // まとめて置き直す入口。スライダー・JSON 欄・uniform を揃えてから 1 回だけ流し直す。
  const setSliders = new Map<SeparationParamId, (value: number) => void>();
  const paramsBox = document.createElement('textarea');
  const applyParams = (next: Partial<Record<SeparationParamId, number>>): void => {
    for (const [id, value] of Object.entries(next) as [SeparationParamId, number][]) {
      if (!(id in SEPARATION_PARAMS) || typeof value !== 'number' || !Number.isFinite(value)) continue;
      params[id] = value;
      pipeline.setParam(id, value);
      setSliders.get(id)!(value);
    }
    paramsBox.value = JSON.stringify(params);
    pipeline.run();
    pipeline.show(view);
    refreshMetrics();
  };

  for (const [id, spec] of Object.entries(SEPARATION_PARAMS) as [SeparationParamId, typeof SEPARATION_PARAMS[SeparationParamId]][]) {
    setSliders.set(id, buildSlider(PARAM_ROWS[id], spec.label, spec.min, spec.max, spec.step,
      () => String(params[id]), (value) => applyParams({ [id]: value })));
  }

  // 調整の共有用: いまの全パラメータの JSON。編集して「適用」で戻せる。
  const paramsRow = document.getElementById('params')!;
  paramsRow.appendChild(paramsBox);
  const copyButton = document.createElement('button');
  copyButton.textContent = 'コピー';
  copyButton.addEventListener('click', () => { void navigator.clipboard.writeText(paramsBox.value); });
  const applyButton = document.createElement('button');
  applyButton.textContent = '適用';
  applyButton.addEventListener('click', () => {
    try {
      applyParams(JSON.parse(paramsBox.value) as Partial<Record<SeparationParamId, number>>);
    } catch (e) {
      document.getElementById('error')!.textContent = `パラメータの JSON が読めない: ${String(e)}`;
    }
  });
  paramsRow.append(copyButton, applyButton, metricsOut);

  markView(view);
  applyParams(params);

  window.cloudSeparate = {
    views: SEPARATION_VIEWS.map(([id]) => id),
    show: (next) => { view = next; markView(view); pipeline.show(view); },
    setParam: (id, value) => applyParams({ [id]: value }),
    capture: (target) => pipeline.capture(target),
    metrics: () => measure(),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});

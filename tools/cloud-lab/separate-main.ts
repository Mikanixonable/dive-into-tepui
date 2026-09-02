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

declare global {
  interface Window {
    // 撮影の駆動(tools/cloud-lab-separate.mjs)が CDP から読む入口。
    cloudSeparate?: {
      views: readonly SeparationView[];
      show: (view: SeparationView) => void;
      setParam: (id: SeparationParamId, value: number) => void;
      capture: (view: SeparationView) => Promise<string>;
    };
  }
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
  paramsRow.append(copyButton, applyButton);

  markView(view);
  applyParams(params);

  window.cloudSeparate = {
    views: SEPARATION_VIEWS.map(([id]) => id),
    show: (next) => { view = next; markView(view); pipeline.show(view); },
    setParam: (id, value) => applyParams({ [id]: value }),
    capture: (target) => pipeline.capture(target),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});

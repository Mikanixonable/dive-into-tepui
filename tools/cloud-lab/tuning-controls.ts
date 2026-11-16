// モデルの調整値(CLOUD_TUNING の uniform)をいじる操作群。生成(index)と描画の写し(detail)で
// 同じ束を使う — スライダー・全値の JSON 欄・ボタン列を組み、変更を少し待ってから onChanged へ
// 流す。変更はそのまま実行中のゲーム(npm run dev)の上書きファイルへも流れる。
import { CLOUD_TUNING, CLOUD_TUNING_DEFAULTS, type CloudTuningId } from '../../src/render/earth-weather/cloud/cloud-tuning';
import { GENERATION_PARAMS } from './generation-params';
import { buildParamPanel } from './param-panel';

export interface TuningControls {
  // 渡した値を適用する。immediate が真のときは debounce せず即座に onChanged を呼ぶ —
  // 撮影口から「適用した時点で焼き直し済み」を約束するために使う。
  applyParams(next: Partial<Record<CloudTuningId, number>>, immediate?: boolean): void;
}

// panelEl にスライダーの束、jsonEl に JSON 欄とボタン列を組む。値が変わるたび(最後の変更から
// 少し待って1回)に onChanged を呼ぶ — 焼き直しは雲場 1 面ぶんの費用が掛かるので、ドラッグ中は
// 走らせない(uniform 自体は即時に書き変わり、描画は焼き直しを待たずに乗る)。
// errorEl はボタンの失敗と JSON の読み違いを出す先。
export function buildTuningControls(
  panelEl: HTMLElement, jsonEl: HTMLElement, errorEl: HTMLElement,
  onChanged: () => void,
): TuningControls {
  const setSliders = new Map<CloudTuningId, (value: number) => void>();
  const paramsBox = document.createElement('textarea');
  let bakeTimer: number | null = null;
  let overridesSyncTimer: number | null = null;

  const applyParams = (next: Partial<Record<CloudTuningId, number>>, immediate = false): void => {
    for (const [id, value] of Object.entries(next) as [CloudTuningId, number][]) {
      if (!(id in CLOUD_TUNING_DEFAULTS) || typeof value !== 'number' || !Number.isFinite(value)) continue;
      CLOUD_TUNING[id].value = value;
      setSliders.get(id)!(value);
    }
    paramsBox.value = JSON.stringify(Object.fromEntries(
      Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])));
    if (bakeTimer !== null) window.clearTimeout(bakeTimer);
    if (immediate) onChanged();
    else bakeTimer = window.setTimeout(onChanged, 250);
    scheduleOverridesSync();
  };

  for (const [id, setSlider] of buildParamPanel(
    panelEl, GENERATION_PARAMS, CLOUD_TUNING_DEFAULTS,
    (id) => String(CLOUD_TUNING[id].value), (id, value) => applyParams({ [id]: value }))) {
    setSliders.set(id, setSlider);
  }

  // 調整の共有用: いまの全パラメータの JSON。編集して「適用」で戻せる。「リセット」は既定値へ。
  jsonEl.appendChild(paramsBox);
  const copyButton = document.createElement('button');
  copyButton.textContent = 'コピー';
  copyButton.addEventListener('click', () => { void navigator.clipboard.writeText(paramsBox.value); });
  const applyButton = document.createElement('button');
  applyButton.textContent = '適用';
  applyButton.addEventListener('click', () => {
    try {
      applyParams(JSON.parse(paramsBox.value) as Partial<Record<CloudTuningId, number>>);
    } catch (e) {
      errorEl.textContent = `パラメータの JSON が読めない: ${String(e)}`;
    }
  });
  const resetButton = document.createElement('button');
  resetButton.textContent = 'リセット';
  resetButton.addEventListener('click', () => applyParams({ ...CLOUD_TUNING_DEFAULTS }));
  // いまの値のうち既定値と違う項目を、開発サーバの窓口(tools/cloud-lab-apply-tuning.cjs)へ送る。
  // 'overrides' は git 管理外の上書きファイルへ書き、実行中のゲーム(npm run dev)がそのまま
  // 拾って反映する。「既定値へ確定」は cloud-tuning.ts の既定値を書き換える。
  const reflectResult = document.createElement('span');
  const changedIds = (): CloudTuningId[] => (Object.keys(CLOUD_TUNING_DEFAULTS) as CloudTuningId[])
    .filter((id) => CLOUD_TUNING[id].value !== CLOUD_TUNING_DEFAULTS[id]);
  const sendToServer = async (
    target: 'defaults' | 'overrides', ids: readonly CloudTuningId[],
  ): Promise<void> => {
    const response = await fetch('/__cloud-lab/apply-tuning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, values: Object.fromEntries(ids.map((id) => [id, CLOUD_TUNING[id].value])) }),
    });
    if (response.status === 404) throw new Error('開発サーバ(npm run cloud-lab)でだけ使える');
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
  };
  const addServerButton = (label: string, title: string, run: () => Promise<string | null>): HTMLButtonElement => {
    const button = document.createElement('button');
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => {
      errorEl.textContent = '';
      run().then((message) => {
        if (message !== null) reflectResult.textContent = message;
      }).catch((e: unknown) => {
        errorEl.textContent = `${label}に失敗: ${String(e)}`;
      });
    });
    return button;
  };
  // スライダー・JSON 欄の変更は、そのままゲームの上書きファイルへ流す — いじった値が
  // そのまま実行中のゲーム(npm run dev)で見える。書き込みは少し待って最後の1回に畳む。
  function scheduleOverridesSync(): void {
    if (overridesSyncTimer !== null) window.clearTimeout(overridesSyncTimer);
    overridesSyncTimer = window.setTimeout(() => {
      overridesSyncTimer = null;
      sendToServer('overrides', changedIds()).then(() => {
        reflectResult.textContent = 'ゲームへ反映した';
      }).catch((e: unknown) => {
        reflectResult.textContent = `ゲームへの反映に失敗: ${String(e)}`;
      });
    }, 300);
  }
  const commitDefaults = addServerButton(
    '既定値へ確定', '既定値と違う項目を cloud-tuning.ts の既定値へ書き込む。git に差分が出る(開発サーバのみ)',
    async () => {
      const ids = changedIds();
      if (ids.length === 0) return '既定値と違う項目はない';
      const list = ids.map((id) => `${id}: ${CLOUD_TUNING_DEFAULTS[id]} → ${CLOUD_TUNING[id].value}`).join('\n');
      if (!window.confirm(`cloud-tuning.ts の既定値へ書き込む(${ids.length} 項目)\n\n${list}`)) return null;
      await sendToServer('defaults', ids);
      return `${ids.length} 項目を既定値へ書き込んだ`;
    });
  jsonEl.append(copyButton, applyButton, resetButton, commitDefaults, reflectResult);

  return { applyParams };
}

// いまの全調整値を id → 数値 の表で返す。焼き直しの版を上げる applyCloudTuningOverrides へ
// 渡すための、現在値の丸ごとの写し。
export function currentTuningValues(): Record<string, number> {
  return Object.fromEntries(Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value]));
}

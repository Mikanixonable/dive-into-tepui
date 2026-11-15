// 雲の細部の描画側モード(detail.html)。render-lab と同じ描画経路(LabView)で、場面・段・
// 時刻・種類を選んだ撮影を撮り、同じ場所・同じ段の実写参照(ビルドの配信の中の
// detail/reference/ — cloud-lab:detail-reference が取り込むもの)と左右に並べて見る。
// window.cloudLabDetail が計測道具(tools/cloud-lab-detail-*.mjs)の駆動口で、
// render-lab の window.renderLab にあった雲の細部の撮影 API はここへ移した。
import {
  CLOUD_DETAIL_SHOT_INFOS, CLOUD_DETAIL_STABILITY_SHOT_INFOS,
  type CloudDetailRandomPoint, type CloudDetailShotInfo,
} from '../render-lab/cloud-detail-cases';
import { LabView } from '../render-lab/lab';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import {
  withGraphicsOption, type ChoiceValue, type GraphicsOptionKey,
} from '../../src/render/graphics-settings';
import { buildButtonRow } from '../lab-controls';

// 撮影名 <場面>-<時刻 h>h-<km/px>km-<種類> から、場面・時刻・段・種類の選択肢を組む。
const SHOT_NAME = /^(.+)-(\d+)h-([0-9.]+)km-([a-z]+)$/;

interface ShotChoice {
  readonly scene: string;
  readonly hours: number;
  readonly tierKmPerPx: number;
  readonly kind: string;
}

function choiceOf(info: CloudDetailShotInfo): ShotChoice | null {
  const match = SHOT_NAME.exec(info.name);
  if (match === null) return null;
  return {
    scene: match[1]!,
    hours: Number(match[2]),
    tierKmPerPx: Number(match[3]),
    kind: match[4]!,
  };
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  both: '両方',
  cirrus: '巻雲だけ',
  cumulus: '積雲だけ',
};

declare global {
  interface Window {
    // 計測道具(tools/cloud-lab-detail-*.mjs)が CDP から駆動する入口。
    cloudLabDetail?: {
      cloudDetailShots: () => readonly CloudDetailShotInfo[];
      // 視点の安定性の撮影の組(基準・横ずらし・高度違い・時間後)。
      cloudDetailStabilityShots: () => readonly CloudDetailShotInfo[];
      shootCloudDetail: (name: string) => Promise<string>;
      // ランダム抽出の実写の教師と同じ点で撮る雲。name は PNG の名前。
      shootCloudDetailRandom: (
        name: string, point: CloudDetailRandomPoint,
      ) => Promise<{ png: string; centerKmPerPx: number; altitudeM: number }>;
      capture: () => Promise<string>;
      setDisplayTime: (displayTime: number) => void;
      setGraphicsOption: (key: GraphicsOptionKey, value: boolean | ChoiceValue) => void;
    };
  }
}

// 器を起こし、選択肢の操作行を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  const settings = new UserSettings(new MemorySettingStorage());
  const view = await LabView.create(
    document.getElementById('view') as HTMLCanvasElement, settings.graphics, { captureOnly: true });

  // 選択肢は撮影の一覧(CLOUD_DETAIL_SHOT_INFOS)から引く — 定義側とずれないように、
  // 写した名前の表を独自に持たない。
  const infos = CLOUD_DETAIL_SHOT_INFOS;
  const byName = new Map(infos.map((info) => [info.name, info]));
  const scenes: string[] = [];
  const hours = new Set<number>();
  const tiers = new Set<number>();
  const kinds = new Set<string>();
  for (const info of infos) {
    const choice = choiceOf(info);
    if (choice === null) continue;
    if (!scenes.includes(choice.scene)) scenes.push(choice.scene);
    hours.add(choice.hours);
    tiers.add(choice.tierKmPerPx);
    kinds.add(choice.kind);
  }

  const generated = document.getElementById('generated') as HTMLImageElement;
  const generatedCap = document.getElementById('generated-cap')!;
  const referenceBox = document.getElementById('reference-box')!;
  const status = document.getElementById('status')!;

  const selection = {
    scene: scenes[0]!,
    hours: [...hours][0]!,
    tierKmPerPx: [...tiers][0]!,
    kind: [...kinds][0]!,
  };

  // 実写の参照の置き場。dev server / 静的配信はビルドの出力(.cloud-lab/)が根なので、
  // cloud-lab:detail-reference の出力へそのまま届く。
  const referenceUrl = (info: CloudDetailShotInfo): string =>
    `detail/reference/${info.scene}-${info.tierKmPerPx}.png`;

  // 選択が続けて変わったとき、遅い撮影が新しい選択を上書きしないよう逐次番号で捨てる。
  let requestSeq = 0;
  const showSelection = async (): Promise<void> => {
    const name = `${selection.scene}-${selection.hours}h-${selection.tierKmPerPx}km-${selection.kind}`;
    const seq = ++requestSeq;
    status.textContent = `撮影中 ${name}`;
    let png: string;
    try {
      png = await view.shootCloudDetail(name);
    } catch (e) {
      if (seq === requestSeq) document.getElementById('error')!.textContent = String(e);
      return;
    }
    if (seq !== requestSeq) return;
    const info = byName.get(name);
    generated.src = png;
    generatedCap.textContent = `生成 — ${name}`;
    if (info !== undefined) {
      referenceBox.innerHTML = '';
      const img = document.createElement('img');
      img.id = 'reference';
      img.src = referenceUrl(info);
      img.onerror = () => {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '実写の参照が無い(npm run cloud-lab:detail-reference で取り込む)';
        referenceBox.replaceChildren(empty);
      };
      referenceBox.appendChild(img);
      document.getElementById('reference-cap')!.textContent = `実写 — ${info.scene} ${info.tierKmPerPx} km/px`;
      status.textContent = `${name} — 中心 ${info.centerKmPerPx.toFixed(3)} km/px・高度 ${Math.round(info.altitudeM / 1000)} km`;
    }
  };

  const markScene = buildButtonRow('scenes',
    scenes.map((id) => [id, id] as const), (id) => { selection.scene = id; void showSelection(); });
  const markTime = buildButtonRow('times',
    [...hours].sort((a, b) => a - b).map((h) => [String(h), `${h}h`] as const),
    (h) => { selection.hours = Number(h); void showSelection(); });
  const markTier = buildButtonRow('tiers',
    [...tiers].sort((a, b) => a - b).map((t) => [String(t), `${t} km/px`] as const),
    (t) => { selection.tierKmPerPx = Number(t); void showSelection(); });
  const markKind = buildButtonRow('kinds',
    [...kinds].map((k) => [k, KIND_LABELS[k] ?? k] as const),
    (k) => { selection.kind = k; void showSelection(); });

  markScene(selection.scene);
  markTime(String(selection.hours));
  markTier(String(selection.tierKmPerPx));
  markKind(selection.kind);
  void showSelection();

  window.cloudLabDetail = {
    cloudDetailShots: () => CLOUD_DETAIL_SHOT_INFOS,
    cloudDetailStabilityShots: () => CLOUD_DETAIL_STABILITY_SHOT_INFOS,
    shootCloudDetail: (name) => view.shootCloudDetail(name),
    shootCloudDetailRandom: (name, point) => view.shootCloudDetailRandom(name, point),
    capture: () => view.capture(),
    setDisplayTime: (displayTime) => view.setDisplayTime(displayTime),
    setGraphicsOption: (key, value) => {
      settings.graphics.set(withGraphicsOption(settings.graphics.current, key, value));
    },
  };
}

// 失敗は画面へ出す — 絵が出ないまま無言で残ると、器の不備を描画の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});

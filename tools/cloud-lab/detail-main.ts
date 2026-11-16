// 雲の細部の描画側モード(detail.html)。render-lab と同じ描画経路(LabView)で動く2つのサブタブ:
// 「写し」は cap で指定した領域の真上から、パラメーターをいじった積雲と巻雲をゲームと同じ
// 絵で眺める。「比較」は場面・段・時刻・種類を選んだ撮影を、同じ場所・同じ段の実写参照
// (ビルドの配信の中の detail/reference/ — cloud-lab:detail-reference が取り込むもの)と
// 左右に並べて見る。パラメーターの束は生成側モードと同じ tuning-controls で、いじった値は
// 上書き経路から実行中のゲームへも届く。
// window.cloudLabDetail が計測道具(tools/cloud-lab-detail-*.mjs)の駆動口で、
// render-lab の window.renderLab にあった雲の細部の撮影 API はここへ移した。
import {
  CLOUD_DETAIL_SHOT_INFOS, CLOUD_DETAIL_STABILITY_SHOT_INFOS, capAltitudeFor,
  type CloudDetailRandomPoint, type CloudDetailShotInfo,
} from '../render-lab/cloud-detail-cases';
import { LabView } from '../render-lab/lab';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import {
  withGraphicsOption, type ChoiceValue, type GraphicsOptionKey,
} from '../../src/render/graphics-settings';
import { applyCloudTuningOverrides } from '../../src/render/earth-weather/cloud/cloud-tuning';
import { CLOUD_FIELD_SOURCE_KIND } from '../../src/render/earth-weather/cloud/cloud-presentation';
import { buildButtonRow, buildCheckbox } from '../lab-controls';
import { buildFramingRow } from './framing-controls';
import { buildTimeControls } from './time-controls';
import type { Framing } from './synoptic-map';
import { buildTuningControls, currentTuningValues } from './tuning-controls';
import { latestReportText } from './latest-report';

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
};

type Pane = 'shot' | 'compare';
const PANE_LABELS: Readonly<Record<Pane, string>> = { shot: '写し', compare: '比較' };

// 写しの初期の cap。貿易風の積雲が並ぶ北大西洋の沖を、雲の並びが見渡せる広さで。
const INITIAL_FRAMING: Framing = { latitude: 15, longitude: -42, radius: 20 };

declare global {
  interface Window {
    // 計測道具(tools/cloud-lab-detail-*.mjs)が CDP から駆動する入口。
    cloudLabDetail?: {
      // 計測道具が内部状態を読むための口(一時)。
      labView: LabView;
      cloudDetailShots: () => readonly CloudDetailShotInfo[];
      // 視点の安定性の撮影の組(基準・横ずらし・高度違い・時間後)。
      cloudDetailStabilityShots: () => readonly CloudDetailShotInfo[];
      shootCloudDetail: (name: string) => Promise<string>;
      // ランダム抽出の実写の教師と同じ点で撮る雲。name は PNG の名前。
      shootCloudDetailRandom: (
        name: string, point: CloudDetailRandomPoint,
      ) => Promise<{ png: string; centerKmPerPx: number; altitudeM: number }>;
      capture: () => Promise<string>;
      // 計測道具が構図と描画設定を自由に重ねて撮るための口(一時)。
      applyShot: (name: string, graphics?: Record<string, unknown>) => void;
      setDisplayTime: (displayTime: number) => void;
      setGraphicsOption: (key: GraphicsOptionKey, value: boolean | ChoiceValue) => void;
    };
  }
}

// 器を起こし、サブタブと操作行を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  const settings = new UserSettings(new MemorySettingStorage());
  // 写しはキャンバスへ出すのが仕事なので提示を切らない(captureOnly は撮影専用)。
  // 比較側の撮影は capture() が自前で captureTarget へ描き直すので、この1つの器で両方を賄う。
  const view = await LabView.create(
    document.getElementById('view') as HTMLCanvasElement, settings.graphics);
  const status = document.getElementById('status')!;
  const errorEl = document.getElementById('error')!;

  // ---- 写し ----
  // cap の中心・半径と表示時刻と種類を持ち、写しが見えているときだけ LabView をその1フレームへ
  // 描き直す(比較を開いているあいだ写しへは描かない — 隠れキャンバスへの描画は無駄な費用)。
  let currentPane: Pane = 'shot';
  let shotHours = 0;
  let shotFraming: Framing = INITIAL_FRAMING;
  const shotKinds = { cumulus: true, cirrus: true };

  const repaintShot = (): void => {
    if (currentPane === 'shot') view.setDisplayTime(shotHours * 3600);
  };

  // cap を動かす。mergeViewAngles は描き直さないので、続けて表示時刻つきの描き直しを呼ぶ —
  // setViewAngles は時刻 0 の1フレームを描き、そのぶん雲場を 0 へ焼き直してしまう。
  const applyFraming = (framing: Framing): void => {
    shotFraming = framing;
    view.mergeViewAngles({
      earthLatitudeDeg: framing.latitude,
      earthLongitudeDeg: framing.longitude,
      earthAltitudeLog: Math.log10(capAltitudeFor(framing.latitude, framing.radius)),
    });
    status.textContent =
      `cap ${framing.latitude.toFixed(0)}°, ${framing.longitude.toFixed(0)}° ・r${framing.radius.toFixed(0)}°` +
      ` — 高度 ${Math.round(capAltitudeFor(framing.latitude, framing.radius) / 1000)} km`;
    repaintShot();
  };
  const framingRow = buildFramingRow('cap', 'capTitle', applyFraming);

  buildTimeControls('time', 0, (hours) => {
    shotHours = hours;
    repaintShot();
  });

  const setOption = (key: GraphicsOptionKey, value: boolean | ChoiceValue): void => {
    settings.graphics.set(withGraphicsOption(settings.graphics.current, key, value));
  };
  // 写しが効く設定: 生成の雲場を出し、種類のトグルを映す。設定の書き込みは1回に畳む —
  // 書き込みごとにパイプラインの組み直し(1フレーム描き直し)が走る。
  const applyShotGraphics = (): void => {
    let next = settings.graphics.current;
    next = withGraphicsOption(next, 'clouds', true);
    next = withGraphicsOption(next, 'cloudFieldSource', CLOUD_FIELD_SOURCE_KIND.generated);
    next = withGraphicsOption(next, 'cumulus', shotKinds.cumulus);
    next = withGraphicsOption(next, 'cirrus', shotKinds.cirrus);
    settings.graphics.set(next);
  };
  buildCheckbox('kind', '積雲', shotKinds.cumulus, (on) => {
    shotKinds.cumulus = on;
    setOption('cumulus', on);
    repaintShot();
  });
  buildCheckbox('kind', '巻雲', shotKinds.cirrus, (on) => {
    shotKinds.cirrus = on;
    setOption('cirrus', on);
    repaintShot();
  });

  // パラメーターの束。変更は版を上げてから表示時刻で描き直す — 版を上げないと雲場が
  // 「同じ時刻・同じ版の焼き」を使い回して、いじった値が絵に載らない。
  buildTuningControls(
    document.getElementById('p-panel')!, document.getElementById('p-json')!, errorEl,
    () => {
      applyCloudTuningOverrides(currentTuningValues());
      repaintShot();
    });
  applyCloudTuningOverrides(currentTuningValues());

  // ---- サブタブ ----
  const paneEls: Record<Pane, HTMLElement> = {
    shot: document.getElementById('pane-shot')!,
    compare: document.getElementById('pane-compare')!,
  };
  const tabButtons = new Map<Pane, HTMLButtonElement>();
  const selectPane = (pane: Pane): void => {
    currentPane = pane;
    for (const [id, el] of Object.entries(paneEls) as [Pane, HTMLElement][]) el.hidden = id !== pane;
    for (const [id, button] of tabButtons) button.classList.toggle('active', id === pane);
    if (pane === 'shot') {
      // 生成の雲場と種類のトグルを効かせてから、専用ケース(真下見下ろしの地球)を組んで cap へ合わせる。
      applyShotGraphics();
      view.showCloudDetail();
      applyFraming(shotFraming);
    } else if (generated.src === '') {
      // 初めて比較を開いたときは、選ばれている組の撮影をそのまま撮る。
      void showSelection();
    }
  };
  const subtabs = document.getElementById('subtabs')!;
  for (const [pane, label] of Object.entries(PANE_LABELS) as [Pane, string][]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => selectPane(pane));
    subtabs.appendChild(button);
    tabButtons.set(pane, button);
  }

  // ---- 比較 ----
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
      if (seq === requestSeq) errorEl.textContent = String(e);
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
    scenes.map((id) => [id, id] as const), (id) => { selection.scene = id; markScene(id); void showSelection(); });
  const markTime = buildButtonRow('times',
    [...hours].sort((a, b) => a - b).map((h) => [String(h), `${h}h`] as const),
    (h) => { selection.hours = Number(h); markTime(h); void showSelection(); });
  const markTier = buildButtonRow('tiers',
    [...tiers].sort((a, b) => a - b).map((t) => [String(t), `${t} km/px`] as const),
    (t) => { selection.tierKmPerPx = Number(t); markTier(t); void showSelection(); });
  const markKind = buildButtonRow('kinds',
    [...kinds].map((k) => [k, KIND_LABELS[k] ?? k] as const),
    (k) => { selection.kind = k; markKind(k); void showSelection(); });

  // 最後に回した細部の比較の評価値。生成側と同じく「最後に測った値」の表示で、
  // 未実行ならその旨だけ出す。
  void latestReportText('detail/compare/latest.json').then((text) => {
    document.getElementById('score')!.textContent =
      text ?? '評価 — (cloud-lab:detail-compare 未実行)';
  });

  markScene(selection.scene);
  markTime(String(selection.hours));
  markTier(String(selection.tierKmPerPx));
  markKind(selection.kind);

  // 既定は写し。比較の最初の撮影は、比較を開いたときに選びなおせば撮れる。
  framingRow.show(shotFraming, 'cap', true);
  selectPane('shot');

  window.cloudLabDetail = {
    // 計測道具が内部状態(雲のフラグ・uniform)を読むための口(一時)。
    labView: view,
    cloudDetailShots: () => CLOUD_DETAIL_SHOT_INFOS,
    cloudDetailStabilityShots: () => CLOUD_DETAIL_STABILITY_SHOT_INFOS,
    shootCloudDetail: (name) => view.shootCloudDetail(name),
    shootCloudDetailRandom: (name, point) => view.shootCloudDetailRandom(name, point),
    capture: () => view.capture(),
    applyShot: (name: string, graphics?: Parameters<typeof view.applyShot>[1]) =>
      view.applyShot(name, graphics),
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

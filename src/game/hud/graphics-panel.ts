// 設定メニューの「描画」面。品質プリセットと、いま実際に絵から要素を消せる項目だけを並べる。
import {
  GraphicsSettings, LOD_BIAS, RESOLUTION_SCALES,
  type GraphicsToggleKey, type LodBias, type QualityPreset, type ResolutionScale,
} from '../../render/graphics-settings';
import { DEBUG_TARGETS, type DebugTargetHost, type DebugTargetId } from '../../render/pipeline/debug-target';
import { SegmentedControl, ToggleSwitch } from './widgets';

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

const RESOLUTION_ITEMS: readonly (readonly [ResolutionScale, string])[] =
  RESOLUTION_SCALES.map((s) => [s, `${Math.round(s * 100)}%`] as const);

const LOD_ITEMS: readonly (readonly [LodBias, string])[] = [
  [LOD_BIAS.low, '低'], [LOD_BIAS.normal, '標準'], [LOD_BIAS.high, '高'],
];

export class GraphicsPanel {
  readonly element: HTMLElement;

  private readonly preset: SegmentedControl<QualityPreset>;
  private readonly resolution: SegmentedControl<ResolutionScale>;
  private readonly lod: SegmentedControl<LodBias>;
  private readonly toggles: readonly (readonly [ToggleSwitch, GraphicsToggleKey])[];
  private readonly debugTarget: SegmentedControl<DebugTargetId>;

  // プリセット・解像度・詳細度・各トグル・デバッグ表示選択を縦に並べる。どの操作も graphics/host
  // へ書いてから sync() で全コントロールの点灯を引き直すので、点灯の正本は常にそちら側にある。
  constructor(private readonly graphics: GraphicsSettings, private readonly host: DebugTargetHost) {
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    this.preset = new SegmentedControl('品質プリセット', PRESET_ITEMS, (p) => {
      this.graphics.applyPreset(p);
      this.sync();
    });
    this.element.appendChild(this.preset.element);

    this.resolution = new SegmentedControl('解像度', RESOLUTION_ITEMS, (scale) => {
      this.graphics.update({ resolutionScale: scale });
      this.sync();
    });
    this.element.appendChild(this.resolution.element);

    this.lod = new SegmentedControl('描画詳細度', LOD_ITEMS, (bias) => {
      this.graphics.update({ lodBias: bias });
      this.sync();
    });
    this.element.appendChild(this.lod.element);

    this.toggles = [
      [this.addToggle('小天体の点群', 'pointField'), 'pointField'],
      [this.addToggle('惑星の環', 'rings'), 'rings'],
      [this.addToggle('オーロラ', 'aurora'), 'aurora'],
      [this.addToggle('大気', 'atmosphere'), 'atmosphere'],
      [this.addToggle('アンチエイリアス(次回起動から)', 'antialias'), 'antialias'],
    ];

    this.debugTarget = new SegmentedControl('デバッグ表示', DEBUG_TARGETS, (id) => {
      this.host.debugTarget = id;
      this.sync();
    });
    this.element.appendChild(this.debugTarget.element);

    this.sync();
  }

  // 真偽項目1つぶんのスイッチを組んで並べる。返り値は sync() が点灯を合わせるために持つ。
  private addToggle(label: string, key: GraphicsToggleKey): ToggleSwitch {
    const toggle = new ToggleSwitch(label, (on) => {
      this.graphics.update({ [key]: on });
      this.sync();
    });
    this.element.appendChild(toggle.element);
    return toggle;
  }

  // 各コントロールの点灯を現在の設定値へ合わせる。プリセットはどれとも一致しなければ全消灯。
  private sync(): void {
    const data = this.graphics.current;
    this.preset.setSelected(this.graphics.matchingPreset());
    this.resolution.setSelected(data.resolutionScale);
    this.lod.setSelected(data.lodBias);
    for (const [toggle, key] of this.toggles) toggle.setOn(data[key]);
    this.debugTarget.setSelected(this.host.debugTarget);
  }
}

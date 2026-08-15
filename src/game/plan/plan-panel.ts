// 軌道計画パネル(#hud-plan)の DOM: ノード一覧・噴射後軌道要素・Δv 手動入力欄(数値入力+
// 長押しボタン)を組み立て、値を書き込む。何を書き込むかの計算(状態から表示値を導く・
// 入力値をノードへ反映する)は PlanEditor が持ち、このクラスは表示専用。
import { OrbitalElements, apsisAltitudes } from '../../physics/elements';
import { Vec3 } from '../../physics/vec3';
import { AXIS_NORMAL, AXIS_PROGRADE, AXIS_RADIAL } from '../theme';
import { HoldButton, ValueInput } from '../hud/widgets';
import { fmtDist, fmtTime } from '../hud/utils';
import { hudRail } from '../hud/hud-root';
import { KEY_MAPPING as K } from '../input/key-mapping';

export interface DvButtons {
  readonly pro: HoldButton;
  readonly ret: HoldButton;
  readonly nrm: HoldButton;
  readonly anm: HoldButton;
  readonly out: HoldButton;
  readonly in: HoldButton;
}

export interface PlanPanelNodeRow {
  readonly tRel: number;
  readonly dvMag: number;
  readonly selected: boolean;
}

// prograde/retrograde/normal/antinormal/radial out/in の長押しボタン6個を組み立てる。
function buildDvButtons(): { row: HTMLElement; buttons: DvButtons } {
  const row = document.createElement('div');
  row.className = 'w-group';
  const mk = (dir: string, key: string): HoldButton => new HoldButton(`${dir} [${key}]`);
  const buttons: DvButtons = {
    pro: mk('PRO', K.dvPrograde.label),
    ret: mk('RET', K.dvRetrograde.label),
    nrm: mk('NRM', K.dvNormal.label),
    anm: mk('ANM', K.dvAntinormal.label),
    out: mk('OUT', K.dvRadialOut.label),
    in: mk('IN', K.dvRadialIn.label),
  };
  for (const b of Object.values(buttons)) row.appendChild(b.element);
  return { row, buttons };
}

// 手動入力欄1行分(ラベル + 数値入力)を組み立てて row へ足す。
function buildNumericInput(row: HTMLElement, label: string, color: string, onCommit: () => void): ValueInput {
  const line = document.createElement('div');
  line.className = 'row';
  line.style.width = '100%';
  line.style.gap = '4px';
  line.style.alignItems = 'center';
  const k = document.createElement('span');
  k.className = 'k';
  k.style.width = '28px';
  k.style.color = color;
  k.style.fontWeight = 'bold';
  k.textContent = label;
  line.appendChild(k);
  const input = new ValueInput({ type: 'number', step: 0.1 }, onCommit);
  input.element.style.flex = '1';
  input.element.style.width = '0';
  line.appendChild(input.element);
  row.appendChild(line);
  return input;
}

// 計画パネルの定型 HTML。近地点が大気圏内(<120km)なら警告を添える。
function planPanelHtml(
  nodes: readonly PlanPanelNodeRow[],
  selEl: OrbitalElements | null,
  warnAtmosphere: boolean,
): string {
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let s = '';
  // ノード一覧
  if (nodes.length > 0) {
    s += nodes
      .map((n, i) => {
        const sign = n.tRel >= 0 ? 'T-' : 'T+';
        return `<div class="row"><span class="k">${n.selected ? '▸ ' : ''}◈ NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}</span><span class="v">${n.dvMag.toFixed(1)} m/s</span></div>`;
      })
      .join('');
  }
  // 噴射後の軌道要素、近地点が大気圏内なら警告
  if (selEl) {
    const apsis = apsisAltitudes(selEl);
    s +=
      '<div style="margin-top:4px;color:var(--text);font-size:11px;letter-spacing:1px">噴射後の軌道</div>' +
      row('遠地点 AP', fmtDist(apsis.ap)) +
      row('近地点 PE', fmtDist(apsis.pe)) +
      row('傾斜角 INC', isFinite(selEl.incDeg) ? `${selEl.incDeg.toFixed(2)}°` : '---') +
      row('周期 PRD', fmtTime(selEl.period));
    if (warnAtmosphere && isFinite(apsis.pe) && apsis.pe < 120e3) {
      s += '<div style="color:var(--accent);margin-top:2px">⚠ 近地点が大気圏内</div>';
    }
  }
  // 操作キーのヒント
  const dvKeys =
    `${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label}`;
  s += `<div style="margin-top:6px;color:var(--text-dim);font-size:11px">[クリック] ノード配置/選択 [ノードをドラッグ] 時刻移動とマニューバ維持 [手動設定のΔT] 軌道上の位置を数値指定 [矢印ハンドル/${dvKeys}/パネルのボタン] 長押しでΔv調整、ハンドルは大きくドラッグし続けると加速 <br>[右クリック] メニュー(自動ワープ/削除) [${K.deleteNode.label}] 選択ノード削除 [${K.fineAttitudeToggle.label}] 微調整 [${K.toggleMapMode.label}] 確定して戻る(時間は進み続ける)</div>`;
  return s;
}

export class PlanPanel {
  readonly dvButtons: DvButtons;
  onDvInputChange: ((pro: number, nrm: number, rad: number) => void) | null = null;
  onPositionInputChange: ((secondsFromNow: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly editForm: HTMLElement;
  private readonly proInput: ValueInput;
  private readonly nrmInput: ValueInput;
  private readonly radInput: ValueInput;
  private readonly positionInput: ValueInput;

  // パネルの DOM を組み立て、右レールへ追加する。
  constructor(panelRoot: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-plan';
    this.panel.className = 'panel hidden';
    this.panel.innerHTML = `
      <h3>軌道計画 [${K.toggleMapMode.label}]</h3>
      <div data-id="planbody"></div>
      <div data-id="planedit" class="hidden" style="margin-top:8px; padding-top:8px; border-top:1px solid var(--fill-2)">
        <div style="font-size:10px; color:var(--text-dim); margin-bottom:4px;">ノード位置（現在時刻からの ΔT [s]）</div>
      </div>
    `;
    this.body = this.panel.querySelector<HTMLElement>('[data-id="planbody"]')!;
    this.editForm = this.panel.querySelector<HTMLElement>('[data-id="planedit"]')!;

    const positionRow = document.createElement('div');
    positionRow.className = 'w-group';
    this.positionInput = buildNumericInput(positionRow, 'ΔT', 'var(--text)', () => {
      this.onPositionInputChange?.(Number(this.positionInput.element.value));
    });
    this.positionInput.element.step = '0.1';
    this.editForm.appendChild(positionRow);

    const dvTitle = document.createElement('div');
    dvTitle.style.fontSize = '10px';
    dvTitle.style.color = 'var(--text-dim)';
    dvTitle.style.margin = '6px 0 4px';
    dvTitle.textContent = 'マニューバ Δv (m/s)';
    this.editForm.appendChild(dvTitle);

    const onInputChange = () => {
      this.onDvInputChange?.(
        parseFloat(this.proInput.element.value) || 0,
        parseFloat(this.nrmInput.element.value) || 0,
        parseFloat(this.radInput.element.value) || 0,
      );
    };
    const dvRow = document.createElement('div');
    dvRow.className = 'w-group';
    this.proInput = buildNumericInput(dvRow, 'PRO', AXIS_PROGRADE, onInputChange);
    this.nrmInput = buildNumericInput(dvRow, 'NRM', AXIS_NORMAL, onInputChange);
    this.radInput = buildNumericInput(dvRow, 'RAD', AXIS_RADIAL, onInputChange);
    this.editForm.appendChild(dvRow);

    const { buttons } = buildDvButtons();
    this.dvButtons = buttons;

    hudRail(panelRoot, 'right').appendChild(this.panel);
  }

  // ノード一覧・噴射後軌道要素・Δv 手動入力欄を現在値へ合わせる。選択中ノードが無ければ
  // パネル全体を隠す。
  sync(
    nodes: readonly PlanPanelNodeRow[], selEl: OrbitalElements | null, localDv: Vec3 | null,
    nodeSecondsFromNow: number | null, warnAtmosphere: boolean, hasSelection: boolean,
  ): void {
    const html = planPanelHtml(nodes, selEl, warnAtmosphere);
    this.panel.classList.toggle('hidden', !hasSelection);
    if (this.body.innerHTML !== html) this.body.innerHTML = html;

    if (hasSelection && localDv) {
      this.editForm.classList.remove('hidden');
      // 入力フォームにフォーカスがない時だけ値を同期(ドラッグ操作での変動を反映)
      if (nodeSecondsFromNow !== null && document.activeElement !== this.positionInput.element) {
        this.positionInput.setValue(nodeSecondsFromNow.toFixed(1));
      }
      if (document.activeElement !== this.proInput.element) this.proInput.setValue(localDv.x.toFixed(1));
      if (document.activeElement !== this.nrmInput.element) this.nrmInput.setValue(localDv.y.toFixed(1));
      if (document.activeElement !== this.radInput.element) this.radInput.setValue(localDv.z.toFixed(1));
    } else {
      this.editForm.classList.add('hidden');
    }
  }

  hide(): void {
    this.panel.classList.add('hidden');
  }

  // パネルの DOM を取り除く。
  dispose(): void {
    this.panel.remove();
  }
}

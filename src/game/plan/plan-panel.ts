// 軌道計画パネル(#hud-plan)の DOM: ノード一覧・噴射後軌道要素・Δv 手動入力欄(数値入力+
// 長押しボタン)を組み立て、渡された表示値を書き込む。
import { OrbitalElements, apsisAltitudes } from '../../physics/elements';
import { getApsisLabelSpec } from '../hud/orbit/orbit-labels';
import { Vec3 } from '../../math/vec3';
import { AXIS_NORMAL, AXIS_PROGRADE, AXIS_RADIAL, FONT_XXS, SPACE_1, SPACE_2, SPACE_3, SPACE_4 } from '../../theme';
import { HoldButton, ValueInput } from '../../hud/widgets';
import { fmtDist, fmtTime } from '../../hud/utils';
import { hudRail } from '../hud/hud-root';
import { KEY_MAPPING as K } from '../../input/key-mapping';

interface DvButtons {
  readonly pro: HoldButton;
  readonly ret: HoldButton;
  readonly nrm: HoldButton;
  readonly anm: HoldButton;
  readonly out: HoldButton;
  readonly in: HoldButton;
}

interface PlanPanelNodeRow {
  readonly tRel: number; // 現在時刻からノード時刻までの秒数 [s]
  readonly dvMag: number; // ノードの Δv の大きさ [m/s]
}

// prograde/retrograde/normal/antinormal/radial out/in の長押しボタン6個を組み立てる。
function buildDvButtons(): { row: HTMLElement; buttons: DvButtons } {
  const row = document.createElement('div');
  row.className = 'w-group';
  // ラベルは「方向 [キー]」
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
  line.style.gap = SPACE_2;
  line.style.alignItems = 'center';
  // 色付きの短いラベル
  const k = document.createElement('span');
  k.className = 'k';
  k.style.width = '28px';
  k.style.color = color;
  k.style.fontWeight = 'bold';
  k.textContent = label;
  line.appendChild(k);
  // 残り幅いっぱいの数値入力
  const input = new ValueInput({ type: 'number', step: 0.1 }, onCommit);
  input.element.style.flex = '1';
  input.element.style.width = '0';
  line.appendChild(input.element);
  row.appendChild(line);
  return input;
}

// 計画パネルの定型 HTML。噴射後の軌道の近点が大気圏内なら警告を添える。
function planPanelHtml(
  nodes: readonly PlanPanelNodeRow[],
  selectedIdx: number | null,
  selEl: OrbitalElements | null,
  peInAtmosphere: boolean,
): string {
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  // ノード一覧は索引として並べ、選択中ノードの主状態は固定DOM側で先に示す。
  let s = '<div class="editorial-divider">PLAN NODES</div>';
  s += nodes
    .map((n, i) => {
      const sign = n.tRel >= 0 ? 'T-' : 'T+';
      const mark = i === selectedIdx ? '▸ ' : '';
      return row(`${mark}◈ NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}`, `${n.dvMag.toFixed(1)} m/s`);
    })
    .join('');
  // 噴射後の軌道要素、近点が大気圏内なら警告
  if (selEl) {
    const apsis = apsisAltitudes(selEl);
    const apSpec = getApsisLabelSpec('ap', selEl.center.id);
    const peSpec = getApsisLabelSpec('pe', selEl.center.id);
    s +=
      `<div class="plan-post-orbit"><div class="editorial-divider">ORBIT AFTER BURN</div>` +
      row(`${apSpec.nameJa} ${apSpec.short}`, fmtDist(apsis.ap)) +
      row(`${peSpec.nameJa} ${peSpec.short}`, fmtDist(apsis.pe)) +
      row('傾斜角 INC', isFinite(selEl.incDeg) ? `${selEl.incDeg.toFixed(2)}°` : '---') +
      row('周期 PRD', fmtTime(selEl.period)) + '</div>';
    if (peInAtmosphere) {
      s += `<div style="color:var(--color-warning);margin-top:${SPACE_1}">⚠ ${peSpec.nameJa}が大気圏内</div>`;
    }
  }
  // 詳細な操作説明は Help に集約し、常設パネルでは次の行動だけを示す。
  s += `<div class="plan-help">[${K.help.label}] 操作一覧 · [右クリック] ノードメニュー · [${K.toggleMapMode.label}] 戻る</div>`;
  return s;
}

export class PlanPanel {
  public readonly dvButtons: DvButtons;
  public onDvInputChange: ((pro: number, nrm: number, rad: number) => void) | null = null;
  public onPositionInputChange: ((secondsFromNow: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly editForm: HTMLElement;
  private readonly state: HTMLElement;
  private readonly stateLabel: HTMLElement;
  private readonly stateDv: HTMLElement;
  private readonly stateTime: HTMLElement;
  private readonly statePro: HTMLElement;
  private readonly stateNrm: HTMLElement;
  private readonly stateRad: HTMLElement;
  private readonly proInput: ValueInput;
  private readonly nrmInput: ValueInput;
  private readonly radInput: ValueInput;
  private readonly positionInput: ValueInput;

  // パネルの DOM を組み立て、右レールへ追加する。
  public constructor(panelRoot: HTMLElement) {
    // 見出し・本文・編集フォームの器
    this.panel = document.createElement('div');
    this.panel.id = 'hud-plan';
    this.panel.className = 'panel hidden editorial-control-sheet';
    this.panel.innerHTML = `
      <div class="plan-panel-head">
        <span class="ui-section-code" aria-hidden="true">PLN</span>
        <h3 class="editorial-panel-title">MANEUVER PLAN</h3>
        <span class="ui-data-context">[${K.toggleMapMode.label}]</span>
      </div>
      <section class="editorial-state plan-state hidden" data-id="planstate">
        <div class="plan-node-hero">
          <span class="ui-data-label" data-id="plan-state-label">MANEUVER</span>
          <strong data-id="plan-state-dv">—</strong>
          <span class="ui-annotation" data-id="plan-state-time">—</span>
        </div>
        <div class="editorial-state-grid">
          <div class="editorial-state-cell"><span class="ui-data-label">PRO</span><span data-id="plan-state-pro">—</span></div>
          <div class="editorial-state-cell"><span class="ui-data-label">NRM</span><span data-id="plan-state-nrm">—</span></div>
          <div class="editorial-state-cell"><span class="ui-data-label">RAD</span><span data-id="plan-state-rad">—</span></div>
        </div>
      </section>
      <div data-id="planbody"></div>
      <div data-id="planedit" class="hidden" style="margin-top:${SPACE_4}; padding-top:${SPACE_4}; border-top:1px solid var(--fill-2)">
        <div style="font-size:${FONT_XXS}; color:var(--text-dim); margin-bottom:${SPACE_2};">ノード位置（現在時刻からの ΔT [s]）</div>
      </div>
    `;
    this.body = this.panel.querySelector<HTMLElement>('[data-id="planbody"]')!;
    this.editForm = this.panel.querySelector<HTMLElement>('[data-id="planedit"]')!;
    this.state = this.panel.querySelector<HTMLElement>('[data-id="planstate"]')!;
    this.stateLabel = this.panel.querySelector<HTMLElement>('[data-id="plan-state-label"]')!;
    this.stateDv = this.panel.querySelector<HTMLElement>('[data-id="plan-state-dv"]')!;
    this.stateTime = this.panel.querySelector<HTMLElement>('[data-id="plan-state-time"]')!;
    this.statePro = this.panel.querySelector<HTMLElement>('[data-id="plan-state-pro"]')!;
    this.stateNrm = this.panel.querySelector<HTMLElement>('[data-id="plan-state-nrm"]')!;
    this.stateRad = this.panel.querySelector<HTMLElement>('[data-id="plan-state-rad"]')!;

    // ノード位置(ΔT)の入力行
    const positionRow = document.createElement('div');
    positionRow.className = 'w-group';
    this.positionInput = buildNumericInput(positionRow, 'ΔT', 'var(--text)', () => {
      this.onPositionInputChange?.(Number(this.positionInput.element.value));
    });
    this.editForm.appendChild(positionRow);

    // Δv の PRO/NRM/RAD 入力行
    const dvTitle = document.createElement('div');
    dvTitle.style.fontSize = FONT_XXS;
    dvTitle.style.color = 'var(--text-dim)';
    dvTitle.style.margin = `${SPACE_3} 0 ${SPACE_2}`;
    dvTitle.textContent = 'マニューバ Δv (m/s)';
    this.editForm.appendChild(dvTitle);

    // 3成分をまとめて通知する(空欄は 0)
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

    // 長押しボタン
    const { buttons } = buildDvButtons();
    this.dvButtons = buttons;

    hudRail(panelRoot, 'right').appendChild(this.panel);
  }

  // ノード一覧・噴射後軌道要素・Δv 手動入力欄を現在値へ合わせる。nodes は計画のノード全件を
  // 計画の順で渡し、selectedIdx はその中の選択中ノードの index。選択が無ければパネル全体を隠し、
  // 選択中ノードの Δv 成分 localDv が求まっていなければ手動入力欄だけを隠す。
  public sync(
    nodes: readonly PlanPanelNodeRow[], selectedIdx: number | null, selEl: OrbitalElements | null,
    localDv: Vec3 | null, peInAtmosphere: boolean,
  ): void {
    const html = planPanelHtml(nodes, selectedIdx, selEl, peInAtmosphere);
    this.panel.classList.toggle('hidden', selectedIdx === null);
    if (this.body.innerHTML !== html) this.body.innerHTML = html;

    const selected = selectedIdx === null ? null : nodes[selectedIdx] ?? null;
    this.state.classList.toggle('hidden', selected === null);
    if (selected !== null) {
      this.stateLabel.textContent = `MANEUVER / ${String((selectedIdx ?? 0) + 1).padStart(2, '0')}`;
      this.stateDv.textContent = `${selected.dvMag.toFixed(1)} m/s`;
      this.stateTime.textContent = `${selected.tRel >= 0 ? 'T-' : 'T+'}${fmtTime(Math.abs(selected.tRel))}`;
      this.statePro.textContent = localDv === null ? '—' : `${localDv.x.toFixed(1)} m/s`;
      this.stateNrm.textContent = localDv === null ? '—' : `${localDv.y.toFixed(1)} m/s`;
      this.stateRad.textContent = localDv === null ? '—' : `${localDv.z.toFixed(1)} m/s`;
    }
    this.editForm.classList.toggle('hidden', selected === null || localDv === null);
    if (selected === null || localDv === null) return;
    // 入力欄にフォーカスがない時だけ値を書き込む(ドラッグ操作での変動を反映する)
    if (document.activeElement !== this.positionInput.element) this.positionInput.setValue(selected.tRel.toFixed(1));
    if (document.activeElement !== this.proInput.element) this.proInput.setValue(localDv.x.toFixed(1));
    if (document.activeElement !== this.nrmInput.element) this.nrmInput.setValue(localDv.y.toFixed(1));
    if (document.activeElement !== this.radInput.element) this.radInput.setValue(localDv.z.toFixed(1));
  }

  // パネル全体を隠す。
  public hide(): void {
    this.panel.classList.add('hidden');
  }

  // パネルの DOM を取り除く。
  public dispose(): void {
    this.panel.remove();
  }
}

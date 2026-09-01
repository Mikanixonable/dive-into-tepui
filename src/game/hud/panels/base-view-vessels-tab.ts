import type { Base, DockedVesselEntry } from '../../dynamic/dynamic-entity/base';
import { Button } from '../widgets';
import type { BasePanel } from './base-view';
import { buildSectionHeader, costLabel, NEW_VESSEL_COST, styleDockBtn } from './base-view-shared';
import { BASE_MAX_VESSELS } from '../../dynamic/dynamic-entity/base';

// 基地パネルの「格納艦艇」タブ: 発進する艦の選択と、既定構成での新造を担う。
export class VesselsTabController {
  public constructor(private readonly panel: BasePanel) {}

  // 格納艦艇の一覧と、新造行を組み立てる。
  public build(base: Base): HTMLElement {
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    const ships = base.baseState.dockedVessels;
    frag.appendChild(buildSectionHeader(
      '格納艦艇',
      '発進する艦を選択するか、整備画面で搭載部品を確認します。',
      `${ships.length} / ${BASE_MAX_VESSELS} 隻`,
    ));
    // 格納艦が居なければ案内文を、居れば一覧を出す。
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦艇はありません。ランデブー後に収容するか、新造してください。';
      frag.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'dock-ship-list';
      list.setAttribute('role', 'list');
      for (const [i, s] of ships.entries()) list.appendChild(this.buildVesselRow(base, s, i));
      frag.appendChild(list);
    }
    // 末尾に新造行を添える。
    frag.appendChild(this.buildNewVesselHeader(base));
    return frag;
  }

  // 格納艦1隻分の行を作る。選択状態の表示、発進、部品タブへの遷移を提供する。
  private buildVesselRow(base: Base, s: DockedVesselEntry, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-ship-row';
    row.setAttribute('role', 'listitem');
    const selected = this.panel.vessel?.id === s.id;
    row.classList.toggle('is-selected', selected);
    const hpRatio = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    row.classList.toggle('is-critical', hpRatio <= 0.3);

    // 行全体を選択ボタンにし、艦名・HPを表示する。
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'dock-ship-select';
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `${s.name || `艦 ${i + 1}`}を選択`);
    select.addEventListener('click', () => {
      this.panel.vessel = s.player;
      this.panel.refresh();
    });

    const info = document.createElement('div');
    info.className = 'dock-ship-info';
    const name = document.createElement('span');
    name.className = 'dock-ship-name';
    name.textContent = `${s.name || `艦 #${i + 1}`} [ドック ${s.slotIndex + 1}]`;
    const hp = document.createElement('span');
    hp.className = 'dock-ship-hp';
    hp.textContent = `HP ${Math.round(s.hp ?? 0).toLocaleString()} / ${Math.round(s.maxHp ?? 0).toLocaleString()}`;
    info.append(name, hp);
    select.appendChild(info);
    row.appendChild(select);

    // 発進と、部品タブでの確認に分岐する操作列。
    const actions = document.createElement('div');
    actions.className = 'dock-ship-actions';
    const launchBtn = new Button('発進', () => this.handleLaunch(base, i));
    styleDockBtn(launchBtn.element, 'primary');
    const inspectBtn = new Button('部品を見る', () => this.handleInspect(base, i));
    styleDockBtn(inspectBtn.element, 'quiet');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // 新造(既定パーツ一式の艦を1隻、格納艦へ加える)行。
  private buildNewVesselHeader(base: Base): HTMLElement {
    // ドックの空き・資金から新造の可否を決める。
    const isFull = base.baseState.dockedVessels.length >= BASE_MAX_VESSELS;
    const canAfford = !isFull && (this.panel.freeProcurement || base.baseState.money >= NEW_VESSEL_COST);
    // 状況に応じた案内文。
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.textContent = isFull
      ? `基地のドックが満杯です (最大 ${BASE_MAX_VESSELS} 隻)`
      : '既定構成の艦艇を新造して格納庫へ追加します。';
    row.appendChild(label);
    // 新造ボタン。
    const btn = new Button(
      isFull ? 'ドック満杯' : `新造 · ${costLabel(this.panel.freeProcurement, NEW_VESSEL_COST)}`,
      () => this.handleBuildVessel(base),
    );
    styleDockBtn(btn.element, 'primary');
    btn.setEnabled(canAfford);
    row.appendChild(btn.element);
    return row;
  }

  // 選択中の艦の発進を要求する。発進した艦を選択中だったら選択を解除する。
  private handleLaunch(base: Base, idx: number): void {
    const shipData = base.baseState.dockedVessels[idx];
    if (!shipData) return;
    const ship = shipData.player;
    this.panel.onLaunchVessel?.(ship, base);
    if (this.panel.vessel === ship) this.panel.vessel = null;
    this.panel.refresh();
  }

  // 新造費用を支払い、艦そのものの生成を BasePanel の外へ要求する。資金不足なら何もしない。
  private handleBuildVessel(base: Base): void {
    if (!this.panel.freeProcurement && base.baseState.money < NEW_VESSEL_COST) return;
    if (!this.panel.freeProcurement) base.baseState.money -= NEW_VESSEL_COST;
    this.panel.onBuildVessel?.(base);
    this.panel.refresh();
  }

  // 指定した艦を選択し、部品タブへ切り替える。
  private handleInspect(base: Base, idx: number): void {
    const shipData = base.baseState.dockedVessels[idx];
    if (!shipData) return;
    this.panel.vessel = shipData.player;
    this.panel.switchToPartsTab();
  }
}

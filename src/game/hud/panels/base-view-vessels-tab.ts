import type { Base, DockedVesselEntry } from '../../game-entity/base';
import * as C from '../../const';
import { Button } from '../widgets';
import type { BaseViewContext } from './base-view-context';
import { buildSectionHeader, NEW_VESSEL_COST } from './base-view-shared';

// ドックビューの「格納艦艇」タブ: 発進する艦の選択と、既定構成での新造を担う。
export class VesselsTabController {
  public constructor(private readonly ctx: BaseViewContext) {}

  public build(): HTMLElement {
    const base = this.ctx.base();
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    const ships = base.baseState.dockedVessels;
    frag.appendChild(buildSectionHeader(
      '格納艦艇',
      '発進する艦を選択するか、整備画面で搭載部品を確認します。',
      `${ships.length} / ${C.BASE_MAX_VESSELS} 隻`,
    ));
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦艇はありません。ランデブー後に収容するか、新造してください。';
      frag.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'dock-ship-list';
      list.setAttribute('role', 'list');
      ships.forEach((s, i) => list.appendChild(this.buildVesselRow(s, i)));
      frag.appendChild(list);
    }
    frag.appendChild(this.buildNewVesselHeader(base));
    return frag;
  }

  private buildVesselRow(s: DockedVesselEntry, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-ship-row';
    row.setAttribute('role', 'listitem');
    const selected = this.ctx.vessel()?.id === s.id;
    row.classList.toggle('is-selected', selected);
    const hpRatio = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    row.classList.toggle('is-critical', hpRatio <= 0.3);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'dock-ship-select';
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `${s.name || `艦 ${i + 1}`}を選択`);
    select.addEventListener('click', () => {
      this.ctx.selectVessel(s.player);
      this.ctx.refresh();
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

    const actions = document.createElement('div');
    actions.className = 'dock-ship-actions';
    const launchBtn = new Button('発進', () => this.handleLaunch(i));
    launchBtn.element.classList.add('dock-btn', 'dock-btn-primary');
    const inspectBtn = new Button('部品を見る', () => this.handleInspect(i));
    inspectBtn.element.classList.add('dock-btn', 'dock-btn-quiet');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // 新造(既定パーツ一式の艦を1隻、格納艦へ加える)行。
  private buildNewVesselHeader(base: Base): HTMLElement {
    const isFull = base.baseState.dockedVessels.length >= C.BASE_MAX_VESSELS;
    const canAfford = !isFull && (this.ctx.freeProcurement() || base.baseState.money >= NEW_VESSEL_COST);
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.textContent = isFull
      ? `基地のドックが満杯です (最大 ${C.BASE_MAX_VESSELS} 隻)`
      : '既定構成の艦艇を新造して格納庫へ追加します。';
    row.appendChild(label);
    const btn = new Button(
      isFull
        ? 'ドック満杯'
        : `新造 · ${this.ctx.freeProcurement() ? 'コストなし' : `${NEW_VESSEL_COST.toLocaleString()} Cr`}`,
      () => this.handleBuildVessel(),
    );
    btn.element.classList.add('dock-btn', 'dock-btn-primary');
    btn.setEnabled(canAfford);
    row.appendChild(btn.element);
    return row;
  }

  private handleLaunch(idx: number): void {
    const base = this.ctx.base();
    const shipData = base.baseState.dockedVessels[idx];
    if (!shipData) return;
    const ship = shipData.player;
    this.ctx.notifyLaunch(ship, base);
    if (this.ctx.vessel() === ship) this.ctx.selectVessel(null);
    this.ctx.refresh();
  }

  // 新造費用を払い、実際の艦の生成(Docking 側)を要求する。
  private handleBuildVessel(): void {
    const base = this.ctx.base();
    if (!this.ctx.freeProcurement() && base.baseState.money < NEW_VESSEL_COST) return;
    if (!this.ctx.freeProcurement()) base.baseState.money -= NEW_VESSEL_COST;
    this.ctx.notifyBuildVessel(base);
    this.ctx.refresh();
  }

  private handleInspect(idx: number): void {
    const shipData = this.ctx.base().baseState.dockedVessels[idx];
    if (!shipData) return;
    this.ctx.selectVessel(shipData.player);
    this.ctx.switchToPartsTab();
  }
}

import { createPart } from '../../game-entity/parts';
import type { AnyPart } from '../../game-entity/parts';
import { Button } from '../widgets';
import type { BaseViewContext } from './base-view-context';
import {
  buildSectionHeader, formatCatalogProperty, PART_TYPE_LABELS, SHOP_CATALOG,
} from './base-view-shared';

// ドックビューの「ショップ」タブ: 部品を購入し、この基地の倉庫へ搬入する。
export class ShopTabController {
  public constructor(private readonly ctx: BaseViewContext) {}

  public build(): HTMLElement {
    const base = this.ctx.base();
    const money = base.baseState.money;

    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(buildSectionHeader(
      'ショップ',
      '購入した部品はこの基地の倉庫へ直接搬入されます。',
      `${SHOP_CATALOG.length} 品目`,
    ));

    const list = document.createElement('div');
    list.className = 'dock-shop-list';
    list.setAttribute('role', 'list');
    SHOP_CATALOG.forEach((entry, i) => {
      const canBuy = this.ctx.freeProcurement() || money >= entry.price;
      const props = Object.entries(entry.props).map(([name, value]) => formatCatalogProperty(name, value)).join(' · ');

      const item = document.createElement('article');
      item.className = 'dock-shop-item';
      item.setAttribute('role', 'listitem');
      const info = document.createElement('div');
      info.className = 'dock-shop-info';
      const name = document.createElement('span');
      name.className = 'dock-shop-name';
      name.textContent = entry.name;
      const type = document.createElement('span');
      type.className = 'dock-shop-type';
      type.textContent = PART_TYPE_LABELS[entry.type];
      const propsEl = document.createElement('span');
      propsEl.className = 'dock-shop-props';
      propsEl.textContent = props || '標準規格';
      const stats = document.createElement('span');
      stats.className = 'dock-shop-stats';
      stats.textContent = `重量 ${entry.weight.toLocaleString()} kg · 耐久 ${entry.maxHp.toLocaleString()}`;
      info.append(name, type, propsEl, stats);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'dock-shop-actions';
      const price = document.createElement('span');
      price.className = 'dock-shop-price';
      price.textContent = this.ctx.freeProcurement() ? 'コストなし' : `${entry.price.toLocaleString()} Cr`;
      actions.appendChild(price);
      const buyBtn = new Button('購入して倉庫へ', () => this.handleBuy(i));
      buyBtn.element.classList.add('dock-btn', 'dock-btn-primary');
      buyBtn.setEnabled(canBuy);
      actions.appendChild(buyBtn.element);
      item.appendChild(actions);
      list.appendChild(item);
    });
    frag.appendChild(list);
    return frag;
  }

  private handleBuy(catalogIdx: number): void {
    const base = this.ctx.base();
    const entry = SHOP_CATALOG[catalogIdx];
    if (!entry) return;
    if (!this.ctx.freeProcurement() && base.baseState.money < entry.price) return;

    const part = createPart(entry.type, {
      name: entry.name,
      weight: entry.weight,
      maxHp: entry.maxHp,
      hp: entry.maxHp,
      ...entry.props,
    } as Partial<AnyPart>);

    if (!this.ctx.freeProcurement()) base.baseState.money -= entry.price;
    base.baseState.inventory.push(part);
    this.ctx.refresh();
  }
}

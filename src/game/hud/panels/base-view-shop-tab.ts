import type { Base } from '../../game-entity/base';
import { createPart } from '../../game-entity/parts';
import type { AnyPart } from '../../game-entity/parts';
import { Button } from '../widgets';
import type { BasePanel } from './base-view';
import {
  buildSectionHeader, costLabel, formatCatalogProperty, PART_TYPE_LABELS, SHOP_CATALOG, styleDockBtn,
} from './base-view-shared';

// 基地パネルの「ショップ」タブ: 部品を購入し、この基地の倉庫へ搬入する。
export class ShopTabController {
  public constructor(private readonly panel: BasePanel) {}

  // ショップの商品一覧を組み立てる。商品ごとに情報欄・価格・購入ボタンを持つカードを作る。
  public build(base: Base): HTMLElement {
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
    for (const [i, entry] of SHOP_CATALOG.entries()) {
      const canBuy = this.panel.freeProcurement || money >= entry.price;
      const props = Object.entries(entry.props).map(([name, value]) => formatCatalogProperty(name, value)).join(' · ');

      // 商品名・種別・プロパティ・重量/耐久からなる情報欄。
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

      // 価格表示と購入ボタン。資金不足なら無効化する。
      const actions = document.createElement('div');
      actions.className = 'dock-shop-actions';
      const price = document.createElement('span');
      price.className = 'dock-shop-price';
      price.textContent = costLabel(this.panel.freeProcurement, entry.price);
      actions.appendChild(price);
      const buyBtn = new Button('購入して倉庫へ', () => this.handleBuy(base, i));
      styleDockBtn(buyBtn.element, 'primary');
      buyBtn.setEnabled(canBuy);
      actions.appendChild(buyBtn.element);
      item.appendChild(actions);
      list.appendChild(item);
    }
    frag.appendChild(list);
    return frag;
  }

  // 指定した商品を購入し、生成した部品を倉庫へ加える。資金不足なら何もしない。
  private handleBuy(base: Base, catalogIdx: number): void {
    // カタログの商品を特定し、資金を確認する。
    const entry = SHOP_CATALOG[catalogIdx];
    if (!entry) return;
    if (!this.panel.freeProcurement && base.baseState.money < entry.price) return;

    // カタログのスペックそのままの新品部品を生成する。
    const part = createPart(entry.type, {
      name: entry.name,
      weight: entry.weight,
      maxHp: entry.maxHp,
      hp: entry.maxHp,
      ...entry.props,
    } as Partial<AnyPart>);

    // 代金を払い、倉庫へ搬入する。
    if (!this.panel.freeProcurement) base.baseState.money -= entry.price;
    base.baseState.inventory.push(part);
    this.panel.refresh();
  }
}

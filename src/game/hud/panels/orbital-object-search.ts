// 図で見つけにくい軌道物体を、名前で探して操作する検索面。
import { Button } from '../../../hud/widgets';
import { expandHitTarget, stopDragPropagation } from '../../../hud/widgets/widget-base';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { OrbitingObject } from '../../dynamic/dynamic-entity/orbiting-object';

const MAX_RESULTS = 60; // 一度に並べる一致行の上限

// 対象の操作の受け口。押す・右クリック・キーの割り当ては図の記号と共通。
export interface OrbitalObjectActions {
  // el を押す・右クリック・F/T で id の対象を操作できるようにする。
  bind(el: HTMLElement, id: string): void;
  // id の対象へフォーカスを移す。
  pick(id: string): void;
}

export class OrbitalObjectSearch {
  public readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly empty: HTMLElement;
  private query = '';
  // 直近に組んだ一致行の鍵(検索語と一致 id の列)。変わったときだけ行を組み直す。
  private builtKey = '';

  // actions は行の操作の受け口、onClose は検索欄から図へ戻るときに呼ぶ。
  public constructor(private readonly actions: OrbitalObjectActions, onClose: () => void) {
    this.element = document.createElement('div');
    this.element.className = 'oo-search hidden';
    const bar = document.createElement('div');
    bar.className = 'oo-search-bar';
    // 入力のたびに検索結果を更新するため、確定通知型の数値入力を使わない。
    this.input = document.createElement('input');
    this.input.type = 'search';
    this.input.className = 'w-input';
    this.input.placeholder = '名前・状態で検索';
    this.input.setAttribute('aria-label', '軌道物体を検索');
    stopDragPropagation(this.input);
    expandHitTarget(this.input);
    this.input.addEventListener('keydown', (e) => {
      // 打鍵が機体操作のキー割り当てへ流れないよう止める。
      e.stopPropagation();
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.input.value = '';
      this.query = '';
    });
    this.input.addEventListener('input', () => { this.query = this.input.value.trim().toLocaleLowerCase(); });
    const close = new Button('図へ戻る', onClose, undefined, 'dense');
    bar.append(this.input, close.element);
    this.results = document.createElement('div');
    this.results.className = 'oo-search-results';
    this.empty = document.createElement('div');
    this.empty.className = 'oo-empty hidden';
    this.empty.textContent = '該当する物体がありません';
    this.element.append(bar, this.results, this.empty);
  }

  // 検索面を出し、検索欄へ打鍵を受ける。
  public open(): void {
    this.element.classList.remove('hidden');
    this.input.focus();
  }

  // 検索面を隠し、検索語を消す。
  public close(): void {
    this.element.classList.add('hidden');
    this.input.value = '';
    this.query = '';
  }

  public get isOpen(): boolean { return !this.element.classList.contains('hidden'); }

  // 一致行を今フレームの候補で組み直す。一致の顔ぶれが変わらなければ DOM に触れない。
  public sync(
    items: readonly ListedObject[], viewer: OrbitingObject | null, bodies: CelestialBodies, displayTime: number,
  ): void {
    const matched = items.filter((item) => item.listSection !== null && (this.query === ''
      || item.name.toLocaleLowerCase().includes(this.query)
      || item.listSearchText(bodies, viewer, displayTime).toLocaleLowerCase().includes(this.query)))
      .slice(0, MAX_RESULTS);
    const key = `${this.query}\n${matched.map((item) => item.id).join('\n')}`;
    this.empty.classList.toggle('hidden', matched.length > 0);
    if (key === this.builtKey) return;
    this.builtKey = key;
    this.results.replaceChildren(...matched.map((item) => this.buildRow(item, viewer, bodies, displayTime)));
  }

  // 一致行1つ。押すとフォーカスを移して図へ戻る。
  private buildRow(
    item: ListedObject, viewer: OrbitingObject | null, bodies: CelestialBodies, displayTime: number,
  ): HTMLElement {
    const row = new Button(item.name, () => this.actions.pick(item.id), glyphMarkup(item), 'dense');
    row.element.classList.add('oo-search-row');
    const detail = document.createElement('small');
    detail.className = 'oo-search-detail';
    detail.textContent = item.listDetail(bodies, viewer, displayTime);
    row.element.appendChild(detail);
    this.actions.bind(row.element, item.id);
    return row.element;
  }
}

// 記号を、ボタンの記号欄へ差し込めるマークアップにする。SVG を持つ対象はそれを優先する。
export function glyphMarkup(item: ListedObject): string {
  if (item.glyphSvg !== null) return item.glyphSvg;
  return item.glyph.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

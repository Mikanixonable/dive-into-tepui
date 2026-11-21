// 表示パネル(マップモード左レール)の対象タブ。マップに出す対象クラスごとに1つのチップを置き、
// 名前の部分でラベル、右端の軌道の図で軌道線を独立に切り替える。天体群と機体・設備群を
// 見出しで区切り、チップは内容の幅で折り返す。押したまま同じ種類の押し所をなぞると、通った
// チップの状態が最初に押したものと揃う。
import { Button } from '../../../hud/widgets';
import { ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../../marker/marker-identity';
import type { MapDisplayToggles } from '../../map/display-toggles';

// 対象クラス1つぶんのチップ。orbitKey が null のクラス(ラグランジュ点)は軌道線を持たず、
// 名前の部分だけを持つ。glyph はマップ上の記号と同じ字形。
interface TargetClassChip {
  readonly label: string;
  readonly glyph: string;
  readonly nameKey: keyof MapDisplayToggles;
  readonly orbitKey: keyof MapDisplayToggles | null;
}

const BODY_CLASS_CHIPS: readonly TargetClassChip[] = [
  { label: '惑星', glyph: ENTITY_GLYPH.body, nameKey: 'planetName', orbitKey: 'planetOrbit' },
  { label: '衛星', glyph: ENTITY_GLYPH.satellite, nameKey: 'satelliteName', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', glyph: ENTITY_GLYPH.body, nameKey: 'dwarfName', orbitKey: 'dwarfOrbit' },
  { label: '小天体', glyph: ENTITY_GLYPH.body, nameKey: 'smallBodyName', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', glyph: ENTITY_GLYPH.lagrange, nameKey: 'lagrangeName', orbitKey: null },
];

const ENTITY_CHIPS: readonly TargetClassChip[] = [
  { label: '自艦', glyph: ENTITY_GLYPH.ship, nameKey: 'playerName', orbitKey: 'playerOrbit' },
  { label: '敵', glyph: ENTITY_GLYPH.enemyShip, nameKey: 'enemyName', orbitKey: 'enemyOrbit' },
  { label: '弾薬', glyph: ENTITY_GLYPH.ammo, nameKey: 'ammoName', orbitKey: 'ammoOrbit' },
  { label: 'RCS燃料', glyph: ENTITY_GLYPH.fuel, nameKey: 'fuelName', orbitKey: 'fuelOrbit' },
  { label: '基地', glyph: ENTITY_GLYPH.base, nameKey: 'baseName', orbitKey: 'baseOrbit' },
  { label: '軌道標識', glyph: ORBIT_POINT_GLYPH.orbitSlot, nameKey: 'orbitSlotName', orbitKey: 'orbitSlotOrbit' },
];

// 軌道線の押し所に描く、楕円と軌道上の点の図。Button のアイコン枠へ入れる固定マークアップ。
const ORBIT_ICON = '<svg viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="9" cy="6" rx="7.4" ry="4"/><circle cx="16.4" cy="6" r="1.9" fill="currentColor" stroke="none"/></svg>';

// 押し所1つ。kind が同じ押し所どうしでだけ、なぞって状態を揃える。
interface ChipPart {
  readonly kind: 'name' | 'orbit';
  readonly key: keyof MapDisplayToggles;
  readonly button: Button;
}

// 押したまま押し所をなぞっている間の状態。value は揃える先の状態、moved は起点の外へ
// なぞり出たか(起点の click を、なぞりの終わりとして読み捨てるため)。
interface Stroke {
  readonly origin: ChipPart;
  readonly value: boolean;
  moved: boolean;
}

// 群の見出し(天体/機体と設備)。
function appendSectionDivider(parent: HTMLElement, title: string): void {
  const divider = document.createElement('div');
  divider.className = 'view-options-section-divider editorial-divider';
  divider.textContent = title;
  parent.appendChild(divider);
}

export class TargetTab {
  // ラベルか軌道線のトグルが切り替わるたびに、そのキーと新しい状態で呼ばれる。
  public onToggle: ((key: keyof MapDisplayToggles, on: boolean) => void) | null = null;

  private readonly parts: ChipPart[] = [];
  // 各トグルの現在値の鏡映し。押したときの次の状態と、なぞりで揃える要否を決めるのに使う。
  private readonly state = new Map<keyof MapDisplayToggles, boolean>();
  private stroke: Stroke | null = null;
  // なぞりを終えた直後に起点へ届く click を1回だけ読み捨てる。
  private swallowClick: ChipPart | null = null;

  // parent(対象タブの本体)の末尾へタブの内容を組み込む。
  public constructor(parent: HTMLElement) {
    const groups: readonly { readonly title: string; readonly chips: readonly TargetClassChip[] }[] = [
      { title: '天体', chips: BODY_CLASS_CHIPS },
      { title: '機体と設備', chips: ENTITY_CHIPS },
    ];
    // 群ごとに見出しを置き、その下へチップを折り返して並べる。
    for (const group of groups) {
      appendSectionDivider(parent, group.title);
      const groupEl = document.createElement('div');
      groupEl.className = 'target-chip-group';
      groupEl.setAttribute('role', 'group');
      groupEl.setAttribute('aria-label', group.title);
      for (const chip of group.chips) groupEl.appendChild(this.buildChip(chip));
      parent.appendChild(groupEl);
    }
  }

  // ラベル・軌道線の表示状態を現在値へ合わせる。
  public sync(toggles: MapDisplayToggles): void {
    for (const part of this.parts) {
      const on = toggles[part.key];
      this.state.set(part.key, on);
      part.button.setOn(on);
    }
  }

  // チップ1つ(名前の押し所と、軌道線を持つクラスなら軌道の押し所)を組む。
  private buildChip(chip: TargetClassChip): HTMLElement {
    const el = document.createElement('span');
    el.className = 'target-chip';
    // 名前の押し所。字形はマップ上の記号と同じものを添える。
    const name = new Button(chip.label, () => this.press(namePart), chip.glyph);
    name.element.classList.add('target-chip-name');
    name.element.setAttribute('aria-label', `${chip.label}のラベル`);
    const namePart: ChipPart = { kind: 'name', key: chip.nameKey, button: name };
    this.addPart(namePart);
    el.appendChild(name.element);
    // 軌道線を持つクラスだけ、右端に軌道の押し所を足す。
    if (chip.orbitKey !== null) {
      const orbit = new Button('', () => this.press(orbitPart), ORBIT_ICON);
      orbit.element.classList.add('target-chip-orbit');
      orbit.element.setAttribute('aria-label', `${chip.label}の軌道線`);
      orbit.element.title = `${chip.label}の軌道線`;
      const orbitPart: ChipPart = { kind: 'orbit', key: chip.orbitKey, button: orbit };
      this.addPart(orbitPart);
      el.appendChild(orbit.element);
    }
    return el;
  }

  // 押し所を登録し、なぞりの起点・通過・終点を受ける。押下の確定は Button の click が持つ。
  private addPart(part: ChipPart): void {
    this.parts.push(part);
    const el = part.button.element;
    el.dataset['toggleKey'] = part.key;
    el.addEventListener('pointerdown', (e) => {
      // 指でもなぞれるよう捕捉し、なぞった先は座標から引く。
      el.setPointerCapture(e.pointerId);
      this.swallowClick = null;
      this.stroke = { origin: part, value: !this.isOn(part.key), moved: false };
    });
    el.addEventListener('pointermove', (e) => this.extendStroke(e.clientX, e.clientY));
    el.addEventListener('pointerup', () => {
      if (this.stroke?.moved) this.swallowClick = this.stroke.origin;
      this.stroke = null;
    });
    el.addEventListener('pointercancel', () => { this.stroke = null; });
  }

  // なぞりの途中で指の下にある同じ種類の押し所を、起点と同じ状態へ揃える。起点の外へ初めて
  // 出たときに起点自身も揃える(押しただけのときは click が切り替える)。
  private extendStroke(x: number, y: number): void {
    const stroke = this.stroke;
    if (stroke === null) return;
    // 捕捉中は自分にしかイベントが来ないので、指の下の押し所は座標から引く。
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-toggle-key]');
    const part = this.parts.find((p) => p.button.element === hit);
    if (part === undefined || part === stroke.origin || part.kind !== stroke.origin.kind) return;
    if (!stroke.moved) {
      stroke.moved = true;
      this.set(stroke.origin.key, stroke.value);
    }
    this.set(part.key, stroke.value);
  }

  // 押し所が押された(クリックかキーボード)。なぞりの終わりに届いた click は読み捨てる。
  private press(part: ChipPart): void {
    if (this.swallowClick === part) {
      this.swallowClick = null;
      return;
    }
    this.set(part.key, !this.isOn(part.key));
  }

  // トグル key を on にし、変わったときだけ通知する。
  private set(key: keyof MapDisplayToggles, on: boolean): void {
    if (this.isOn(key) === on) return;
    this.state.set(key, on);
    this.parts.find((p) => p.key === key)?.button.setOn(on);
    this.onToggle?.(key, on);
  }

  // トグル key のいまの状態。
  private isOn(key: keyof MapDisplayToggles): boolean {
    return this.state.get(key) ?? false;
  }
}

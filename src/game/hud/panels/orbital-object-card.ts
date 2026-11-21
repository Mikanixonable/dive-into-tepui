// 軌道物体パネルの札。フォーカス対象の名前・系の経路・状態と、その対象にできる操作を出し、
// 束を開いている間はその中身を並べて選ばせる(SPEC/MAP.md「軌道物体パネル」)。
import { Button } from '../../../hud/widgets';
import { buildSpan } from '../../../hud/widgets/widget-base';
import { injectOnce } from '../../../hud/inject-style';
import { isApproachingEnemy } from './orbital-object-chart';
import { glyphMarkup, type OrbitalObjectActions } from './orbital-object-search';
import type { ChartRole } from './orbital-object-chart';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { OrbitingObject } from '../../dynamic/dynamic-entity/orbiting-object';

const STYLE = `
/* 札: フォーカス対象と、それにできる操作。束を開いている間は中身の一覧になる。 */
#hud-orbital-objects .oo-card {
  display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4);
  border-radius: var(--radius-control); background: var(--glass-inset);
}
#hud-orbital-objects .oo-card-meta { display: flex; gap: var(--space-3); min-width: 0; }
#hud-orbital-objects .oo-card-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--role-label); font-size: var(--font-xxs); }
#hud-orbital-objects .oo-card-tag { margin-left: auto; font-size: var(--font-xxs); white-space: nowrap; }
#hud-orbital-objects .oo-card-tag.is-own { color: var(--role-own); }
#hud-orbital-objects .oo-card-tag.is-tgt { color: var(--role-target); }
#hud-orbital-objects .oo-card-tag.is-near { color: var(--role-caution); }
#hud-orbital-objects .oo-card-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--role-data); font-size: var(--font-l); font-weight: 600;
}
#hud-orbital-objects .oo-card-name.is-own { color: var(--role-own); }
#hud-orbital-objects .oo-card-name.is-tgt { color: var(--role-target); }
#hud-orbital-objects .oo-card-detail {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted); font-size: var(--font-xxs); font-variant-numeric: tabular-nums;
}
#hud-orbital-objects .oo-card-actions, #hud-orbital-objects .oo-bundle { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-orbital-objects .oo-card .hidden { display: none !important; }
`;

// 意味の色分けを当てるクラス。データは色を持たない(UI-DESIGN.md「HUD の色は意味で引く」)。
const ROLE_CLASS: Record<ChartRole, string | null> = {
  own: 'is-own', target: 'is-tgt', caution: 'is-near', data: null,
};

// el に role の意味の色分けのクラスを当て、他の意味のクラスを外す。
export function applyRoleClass(el: HTMLElement, role: ChartRole): void {
  for (const cls of ['is-own', 'is-tgt', 'is-near']) el.classList.toggle(cls, cls === ROLE_CLASS[role]);
}

// 毎フレームの再代入はレイアウトの再計算を招くので、変わったときだけ書く。
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

// 札の操作の受け口。
export interface CardHandlers {
  target(id: string): void;
  control(id: string): void;
  detail(id: string, clientX: number, clientY: number): void;
  closeBundle(): void;
}

// 軌道図の下の札。フォーカス対象の名前・経路・状態と、その対象にできる操作を出す。束を開いている
// 間は、その中身を並べて選ばせる。
export class OrbitalObjectCard {
  public readonly element: HTMLElement;
  private readonly path: HTMLElement;
  private readonly tag: HTMLElement;
  private readonly name: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly actionsRow: HTMLElement;
  private readonly targetButton: Button;
  private readonly controlButton: Button;
  private readonly bundle: HTMLElement;
  private focusId: string | null = null;
  private bundleKey = '';

  // actions は束の中身を押したときの受け口、handlers は札の操作ボタンの受け口。
  public constructor(private readonly actions: OrbitalObjectActions, private readonly handlers: CardHandlers) {
    injectOnce('orbital-object-card', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'oo-card';
    this.element.setAttribute('aria-live', 'polite');
    const meta = document.createElement('div');
    meta.className = 'oo-card-meta';
    this.path = buildSpan('oo-card-path', '');
    this.tag = buildSpan('oo-card-tag', '');
    meta.append(buildSpan('ui-data-context', 'FOCUS'), this.path, this.tag);
    this.name = buildSpan('oo-card-name', '');
    this.detail = buildSpan('oo-card-detail', '');
    // 操作は押した時点のフォーカス対象へ向ける。「操作する」は操作対象でない自艦にだけ出す。
    this.actionsRow = document.createElement('div');
    this.actionsRow.className = 'oo-card-actions';
    this.targetButton = new Button('ターゲット', () => this.withFocus((id) => this.handlers.target(id)),
      undefined, 'dense', 'T');
    this.controlButton = new Button('操作する', () => this.withFocus((id) => this.handlers.control(id)),
      undefined, 'dense');
    const detailButton = new Button('詳細', () => this.withFocus((id) => {
      const rect = detailButton.element.getBoundingClientRect();
      this.handlers.detail(id, rect.left, rect.bottom);
    }), undefined, 'dense');
    this.actionsRow.append(this.targetButton.element, this.controlButton.element, detailButton.element);
    this.bundle = document.createElement('div');
    this.bundle.className = 'oo-bundle hidden';
    this.element.append(meta, this.name, this.detail, this.actionsRow, this.bundle);
  }

  // focus はフォーカス対象、system は軌道図に出している系の中心、bundle は中身を開いている束。
  // どれも無ければ null。
  public sync(
    focus: ListedObject | null, system: ListedObject | null, bundle: readonly ListedObject[] | null,
    targetId: string | null, viewer: OrbitingObject | null, bodies: CelestialBodies, displayTime: number,
  ): void {
    // 束を開いている間は、フォーカス対象の読み値と操作を隠して中身の一覧だけを出す。
    this.focusId = focus?.id ?? null;
    const showBundle = bundle !== null;
    this.bundle.classList.toggle('hidden', !showBundle);
    this.actionsRow.classList.toggle('hidden', showBundle || focus === null);
    this.detail.classList.toggle('hidden', showBundle);
    if (bundle !== null) {
      setText(this.path, '');
      setText(this.tag, '');
      setText(this.name, `×${bundle.length}`);
      this.syncBundle(bundle);
      return;
    }
    const own = focus !== null && viewer !== null && focus.id === viewer.id;
    const target = focus !== null && focus.id === targetId;
    const near = focus !== null && isApproachingEnemy(focus, viewer, displayTime);
    const role: ChartRole = target ? 'target' : own ? 'own' : near ? 'caution' : 'data';
    setText(this.path, system === null ? '' : pathOf(system.id, bodies));
    setText(this.tag, target ? 'ターゲット' : own ? '操作中' : near ? '△ 接近' : '');
    setText(this.name, focus === null ? 'なし' : `${focus.glyph} ${focus.name}`);
    setText(this.detail, focus === null ? '' : focus.listDetail(bodies, viewer, displayTime));
    for (const el of [this.tag, this.name]) applyRoleClass(el, role);
    this.targetButton.setOn(target);
    this.controlButton.element.classList.toggle('hidden', focus === null || own || focus.listSection !== 'player');
  }

  // 束の中身を、押せば選べるボタンとして並べる。顔ぶれが変わったときだけ組み直す。
  private syncBundle(bundle: readonly ListedObject[]): void {
    const key = bundle.map((item) => item.id).join('\n');
    if (key === this.bundleKey) return;
    this.bundleKey = key;
    const back = new Button('閉じる', () => this.handlers.closeBundle(), undefined, 'dense');
    this.bundle.replaceChildren(...bundle.map((item) => {
      const button = new Button(item.name, () => this.actions.pick(item.id), glyphMarkup(item), 'dense');
      this.actions.bind(button.element, item.id);
      return button.element;
    }), back.element);
  }

  // フォーカス対象があるときだけ run を呼ぶ。
  private withFocus(run: (id: string) => void): void {
    if (this.focusId !== null) run(this.focusId);
  }
}

// 系の中心 id から主星までの経路(主星 › 惑星 › …)。
function pathOf(id: string, bodies: CelestialBodies): string {
  return [...bodies.chainFrom(id)].reverse().map((body) => bodies.nameOf(body)).join(' › ');
}

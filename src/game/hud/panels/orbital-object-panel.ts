// 路線図・軌道図・フォーカス対象の札をまとめたマップ用パネル。
import { hudRail } from '../hud-dom';
import { Button, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, type CollapseToggleLabels } from '../../../hud-kit/widgets';
import { injectOnce } from '../../../hud-kit/inject-style';
import { createKeyCap } from '../../../hud-kit/key-cap';
import { buildOrbitalObjectChart, CHART_KINDS, isApproachingEnemy } from './orbital-object-chart';
import { glyphMarkup, OrbitalObjectSearch, type OrbitalObjectActions } from './orbital-object-search';
import { applyRoleClass, OrbitalObjectCard, setText } from './orbital-object-card';
import { buildSpan } from '../../../hud-kit/widgets/widget-base';
import { ORBITAL_OBJECT_PANEL_STYLE } from '../style/orbital-object-panel-style';
import type { PanelCollapse } from '../panel-chrome';
import type { ChartKind, ChartMark, ChartStation } from './orbital-object-chart';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { OrbitingObject } from '../../dynamic/entity/orbiting-object';

const COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '軌道物体パネルを畳む',
  collapsedTitle: '軌道物体パネルを開く',
};

const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round"><circle cx="7" cy="7" r="4.8"></circle><path d="M10.6 10.6 14 14"></path></svg>';


// 軌道図の記号1つぶんの DOM。代表の id ごとに使い回す。
interface MarkView {
  readonly button: Button;
  readonly label: HTMLElement;
  members: readonly ListedObject[];
}

// 路線図の駅1つぶんの DOM。
interface StationView {
  readonly button: Button;
  readonly badge: HTMLElement;
  readonly name: HTMLElement;
}

export class OrbitalObjectPanel {
  // id の対象へマップ視点のフォーカスを移す。
  public onFocus: ((id: string) => void) | null = null;
  // id の自艦へフォーカスを移し、操作対象にする。
  public onControl: ((id: string) => void) | null = null;
  // id の対象をターゲットに設定/解除する。
  public onNavTarget: ((id: string) => void) | null = null;
  // id の対象のプロパティウィンドウを画面座標 (clientX, clientY) に開く。
  public onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly caution: HTMLElement;
  private readonly chartView: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly line: HTMLElement;
  private readonly route: HTMLElement;
  private readonly diagram: HTMLElement;
  private readonly rings: HTMLElement;
  private readonly center: Button;
  private readonly centerName: HTMLElement;
  private readonly search: OrbitalObjectSearch;
  private readonly card: OrbitalObjectCard;
  private readonly kindButtons = new Map<ChartKind, Button>();
  private readonly stations = new Map<string, StationView>();
  private readonly marks = new Map<string, MarkView>();
  private readonly unsubscribeCollapse: () => void;
  // 図に出さない種類。プレイヤーの選択で、マップの表示の選択とは独立に持つ。
  private readonly hidden = new Set<ChartKind>();
  private centerId: string | null = null;
  // 札に中身を開いている束の代表の id。束が消えるかフォーカスが動けば閉じる。
  private openBundleId: string | null = null;
  private lastFocusId: string | null = null;

  // 見出し・路線図・軌道図・札・検索面を組んで root の右レールへ置く。隠した状態で始まる。
  public constructor(root: HTMLElement, collapse: PanelCollapse, private readonly bodies: CelestialBodies) {
    injectOnce('orbital-object-panel', ORBITAL_OBJECT_PANEL_STYLE);
    this.panel = document.createElement('div');
    this.panel.id = 'hud-orbital-objects';
    this.panel.className = 'panel editorial-index';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 見出し: 記号・題名・接近の注意・検索ボタン。開閉ボタンは折りたたみの配線が足す。
    const head = document.createElement('div');
    head.className = 'oo-head';
    const code = document.createElement('span');
    code.className = 'ui-section-code';
    code.setAttribute('aria-hidden', 'true');
    code.textContent = 'OBJ';
    const title = document.createElement('h3');
    title.className = 'editorial-panel-title';
    title.textContent = 'ORBITAL OBJECTS';
    this.caution = document.createElement('span');
    this.caution.className = 'oo-caution hidden';
    const searchButton = new Button('', () => this.openSearch(), SEARCH_ICON, 'icon');
    searchButton.element.setAttribute('aria-label', '名前で探す');
    head.append(code, title, this.caution, searchButton.element);
    this.panel.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'oo-body';
    this.chartView = document.createElement('div');
    this.chartView.className = 'oo-chart-view';

    // 図の面: 路線図・種類の選択・軌道図・札の順に縦へ積む。
    this.strip = document.createElement('div');
    this.strip.className = 'oo-strip';
    this.strip.setAttribute('aria-label', '主星と惑星の路線図');
    this.line = document.createElement('div');
    this.line.className = 'oo-line';
    this.route = document.createElement('div');
    this.route.className = 'oo-route';
    this.strip.append(this.line, this.route);

    const kinds = document.createElement('div');
    kinds.className = 'oo-kinds';
    kinds.setAttribute('role', 'group');
    kinds.setAttribute('aria-label', '図に出す種類');
    for (const [kind, label] of CHART_KINDS) {
      const button = new Button(label, () => this.toggleKind(kind), undefined, 'dense');
      button.setOn(true);
      this.kindButtons.set(kind, button);
      kinds.appendChild(button.element);
    }

    this.diagram = document.createElement('div');
    this.diagram.className = 'oo-diagram';
    this.rings = document.createElement('div');
    this.center = new Button('', () => { if (this.centerId !== null) this.pick(this.centerId); }, undefined, 'icon');
    this.center.element.classList.add('oo-center');
    this.center.element.style.left = '50%';
    this.center.element.style.top = '50%';
    this.bindCenter();
    this.centerName = document.createElement('span');
    this.centerName.className = 'oo-center-name';
    this.diagram.append(this.rings, this.center.element, this.centerName);

    this.card = new OrbitalObjectCard(this.actions, {
      target: (id) => this.onNavTarget?.(id),
      control: (id) => this.onControl?.(id),
      detail: (id, x, y) => this.onSelectRight?.(id, x, y),
      closeBundle: () => { this.openBundleId = null; },
    });
    this.chartView.append(this.strip, kinds, this.diagram, this.card.element);

    // 検索面と案内は図の面と並べ、本文ごと畳めるようにする。
    this.search = new OrbitalObjectSearch(this.actions, () => this.closeSearch());
    this.body.append(this.chartView, this.search.element, buildHelp());
    this.panel.appendChild(this.body);
    this.unsubscribeCollapse = collapse.wire({
      toggleRoot: head,
      toggleId: 'hud-orbital-objects-toggle',
      toggleClassName: 'oo-collapse',
      target: this.body,
      labels: COLLAPSE_LABELS,
      storageId: 'hud-orbital-objects',
      extraHitEls: [title],
    });
    hudRail(root, 'right').appendChild(this.panel);
    this.setVisible(false);
  }

  // パネルを出し入れする。
  public setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // パネルを取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
    this.unsubscribeCollapse();
    this.panel.remove();
  }

  // 今フレームの候補で、見出しの注意・路線図・軌道図・札(検索中は一致行)を書き直す。
  // focusId はマップ視点のフォーカス、targetId は航法ターゲット。
  public sync(
    items: readonly ListedObject[], focusId: string | null, targetId: string | null,
    viewer: OrbitingObject | null, displayTime: number,
  ): void {
    const approaching = items.filter((item) => isApproachingEnemy(item, viewer, displayTime)).length;
    setText(this.caution, approaching > 0 ? `△ 接近 ${approaching}` : '');
    this.caution.classList.toggle('hidden', approaching === 0);
    if (focusId !== this.lastFocusId) this.openBundleId = null;
    this.lastFocusId = focusId;
    // 本文が畳まれている間は不可視なので、図を組まない。次に開いたフレームで組み直す。
    if (this.body.classList.contains('collapsed')) return;
    if (this.search.isOpen) {
      this.search.sync(items, viewer, this.bodies, displayTime);
      return;
    }
    const chart = buildOrbitalObjectChart(items, focusId, targetId, viewer, this.hidden, this.bodies, displayTime);
    this.centerId = chart.center?.id ?? null;
    this.syncStations(chart.stations);
    this.syncDiagram(chart.marks, chart.rings, chart.center, focusId);
    const focus = items.find((item) => item.id === focusId) ?? null;
    const bundle = this.openBundleId === null ? null : this.marks.get(this.openBundleId)?.members ?? null;
    if (bundle === null) this.openBundleId = null;
    this.card.sync(focus, chart.center, bundle, targetId, viewer, this.bodies, displayTime);
  }

  // 図・検索面の要素を、押す・右クリック・F/T で対象を操作できるようにする。
  private readonly actions: OrbitalObjectActions = {
    bind: (el, id) => bindObjectKeys(el, () => id, this.handlers),
    pick: (id) => this.pick(id),
  };

  private readonly handlers: ObjectKeyHandlers = {
    focus: (id) => this.pick(id),
    target: (id) => this.onNavTarget?.(id),
    detail: (id, x, y) => this.onSelectRight?.(id, x, y),
    control: (id) => this.onControl?.(id),
  };

  // 中心天体の記号は系が変わっても同じ要素を使うので、操作する id はその時点の中心を引く。
  private bindCenter(): void {
    bindObjectKeys(this.center.element, () => this.centerId, this.handlers);
  }

  // id の対象へフォーカスを移す。検索中なら図へ戻る。
  private pick(id: string): void {
    this.onFocus?.(id);
    if (this.search.isOpen) this.closeSearch();
  }

  // 図を隠して検索面を出す。
  private openSearch(): void {
    this.chartView.classList.add('hidden');
    this.search.open();
  }

  // 検索面を閉じて図へ戻る。
  private closeSearch(): void {
    this.search.close();
    this.chartView.classList.remove('hidden');
  }

  // 種類 kind を図に出すかどうかを切り替える。
  private toggleKind(kind: ChartKind): void {
    if (this.hidden.has(kind)) this.hidden.delete(kind);
    else this.hidden.add(kind);
    this.kindButtons.get(kind)?.setOn(!this.hidden.has(kind));
  }

  // 駅を等間隔に置き、根から表示中の系の駅までを経路として強調する。
  private syncStations(stations: readonly ChartStation[]): void {
    const seen = new Set<string>();
    const step = stations.length > 1 ? 100 / stations.length : 0;
    let routeEnd = 0;
    stations.forEach((station, i) => {
      const id = station.item.id;
      seen.add(id);
      let view = this.stations.get(id);
      if (view === undefined) {
        view = this.buildStation(station.item);
        this.stations.set(id, view);
      }
      const at = step * (i + 0.5);
      setStyle(view.button.element, 'left', `${at}%`);
      if (station.onRoute) routeEnd = at;
      const current = station.onRoute && !stations.slice(i + 1).some((s) => s.onRoute);
      view.button.element.classList.toggle('on-route', station.onRoute);
      view.button.element.classList.toggle('is-current', current);
      // 駅の間隔に収まるよう、名前は先頭2文字で示す。
      setText(view.name, station.item.name.slice(0, 2));
      view.badge.replaceChildren(
        station.crafts > 0 ? `▲${station.crafts}` : '',
        ...(station.caution ? [buildSpan('oo-near', '△')] : []),
      );
    });
    for (const [id, view] of this.stations) {
      if (seen.has(id)) continue;
      view.button.element.remove();
      this.stations.delete(id);
    }
    const start = step * 0.5;
    setStyle(this.line, 'left', `${start}%`);
    setStyle(this.line, 'right', `${start}%`);
    setStyle(this.route, 'left', `${start}%`);
    setStyle(this.route, 'width', `${Math.max(0, routeEnd - start)}%`);
  }

  // item の駅を組んで路線図へ置く。艦の数と注意の欄・点・名前の3段で、押すとフォーカス。
  private buildStation(item: ListedObject): StationView {
    const button = new Button('', () => this.pick(item.id));
    // 駅の位置は毎フレーム syncStations が決めるので、ここでは中身だけを組む。
    button.element.classList.add('oo-station');
    button.element.setAttribute('aria-label', `${item.name}へフォーカス`);
    const badge = buildSpan('oo-station-badge', '');
    const dot = buildSpan('oo-station-dot', '');
    const name = buildSpan('oo-station-name', '');
    button.element.replaceChildren(badge, dot, name);
    this.strip.appendChild(button.element);
    bindObjectKeys(button.element, () => item.id, this.handlers);
    return { button, badge, name };
  }

  // 円・中心天体・記号を書き直す。記号は束の代表の id ごとに要素を使い回す。
  private syncDiagram(
    marks: readonly ChartMark[], rings: readonly number[], center: ListedObject | null, focusId: string | null,
  ): void {
    // 円は数だけ揃え、半径は毎回当て直す。
    while (this.rings.children.length < rings.length) {
      const ring = document.createElement('div');
      ring.className = 'oo-ring';
      this.rings.appendChild(ring);
    }
    while (this.rings.children.length > rings.length) this.rings.lastElementChild!.remove();
    rings.forEach((r, i) => {
      const ring = this.rings.children[i] as HTMLElement;
      setStyle(ring, 'left', `${(0.5 - r) * 100}%`);
      setStyle(ring, 'top', `${(0.5 - r) * 100}%`);
      setStyle(ring, 'width', `${r * 200}%`);
      setStyle(ring, 'height', `${r * 200}%`);
    });

    // 中心天体は系が変わったときだけ記号を差し替える。
    this.center.element.classList.toggle('hidden', center === null);
    if (center !== null) {
      const markup = glyphMarkup(center);
      if (this.center.element.dataset['glyph'] !== markup) {
        this.center.element.innerHTML = markup;
        this.center.element.dataset['glyph'] = markup;
      }
      this.center.element.setAttribute('aria-label', `${center.name}へフォーカス`);
      this.center.element.classList.toggle('is-focus', center.id === focusId);
    }
    setText(this.centerName, center?.name ?? '');

    // 記号は代表の id ごとに使い回し、今フレーム現れなかったものを最後に取り除く。
    const seen = new Set<string>();
    for (const mark of marks) {
      const lead = mark.members[0]!;
      seen.add(lead.id);
      let view = this.marks.get(lead.id);
      if (view === undefined) {
        view = this.buildMark(lead);
        this.marks.set(lead.id, view);
      }
      view.members = mark.members;
      const el = view.button.element;
      setStyle(el, 'left', `${mark.x * 100}%`);
      setStyle(el, 'top', `${mark.y * 100}%`);
      const focused = mark.members.some((m) => m.id === focusId);
      for (const target of [el, view.label]) {
        applyRoleClass(target, mark.role);
        target.classList.toggle('is-focus', focused);
      }
      el.setAttribute('aria-label', mark.members.length > 1
        ? `${lead.name} ほか ${mark.members.length - 1} 件を開く` : `${lead.name}へフォーカス`);
      view.label.classList.toggle('hidden', mark.label === null);
      setText(view.label, mark.label ?? '');
      const right = mark.x > 0.6;
      setStyle(view.label, 'left', right ? '' : `calc(${mark.x * 100}% + 16px)`);
      setStyle(view.label, 'right', right ? `calc(${(1 - mark.x) * 100}% + 16px)` : '');
      setStyle(view.label, 'top', `${mark.y * 100}%`);
    }
    for (const [id, view] of this.marks) {
      if (seen.has(id)) continue;
      view.button.element.remove();
      view.label.remove();
      this.marks.delete(id);
    }
  }

  // 軌道図の記号1つ。単独なら押すとフォーカス、束なら札に中身を開く。
  private buildMark(lead: ListedObject): MarkView {
    const view: MarkView = {
      button: new Button('', () => {
        if (view.members.length > 1) this.openBundleId = lead.id;
        else this.pick(lead.id);
      }, glyphMarkup(lead), 'icon'),
      label: buildSpan('oo-label', ''),
      members: [lead],
    };
    // 束の中身は毎フレーム入れ替わるので、押したときに view から読む。
    view.button.element.classList.add('oo-mark');
    bindObjectKeys(view.button.element, () => lead.id, this.handlers);
    this.diagram.append(view.button.element, view.label);
    return view;
  }
}

// 対象を操作する4つの口。
interface ObjectKeyHandlers {
  focus(id: string): void;
  target(id: string): void;
  detail(id: string, clientX: number, clientY: number): void;
  control(id: string): void;
}

// el に、右クリック(長押し)=詳細、ダブルクリック=操作対象にする、F=フォーカス、T=ターゲットを張る。
// idOf はその時点で el が指す対象。null なら何もしない。
function bindObjectKeys(el: HTMLElement, idOf: () => string | null, handlers: ObjectKeyHandlers): void {
  el.setAttribute('aria-keyshortcuts', 'F T');
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const id = idOf();
    if (id !== null) handlers.detail(id, e.clientX, e.clientY);
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const id = idOf();
    if (id !== null) handlers.control(id);
  });
  el.addEventListener('keydown', (e) => {
    // 修飾キー付きと IME 確定中はブラウザ/IME 自身の処理に譲る。それ以外の打鍵は機体操作へ流さない。
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    e.stopPropagation();
    const id = idOf();
    if (id === null) return;
    const key = e.key.toLowerCase();
    if (key === 'f') { e.preventDefault(); handlers.focus(id); }
    if (key === 't') { e.preventDefault(); handlers.target(id); }
  });
}

// 操作の案内の1行。ホバーに頼らず常に見せる。
function buildHelp(): HTMLElement {
  const help = document.createElement('div');
  help.className = 'oo-help';
  const focusHint = buildSpan('', ' フォーカス');
  focusHint.prepend(createKeyCap('F'));
  const targetHint = buildSpan('', ' ターゲット');
  targetHint.prepend(createKeyCap('T'));
  help.append(buildSpan('', '押す フォーカス'), buildSpan('', '長押し・右クリック 詳細'), focusHint, targetHint);
  return help;
}

// el のインラインの位置・寸法を、変わったときだけ書く。
function setStyle(el: HTMLElement, prop: 'left' | 'right' | 'top' | 'width' | 'height', value: string): void {
  if (el.style[prop] !== value) el.style[prop] = value;
}

// HUD のスクリーン投影マーカー管理(表示機構のみ。何をどこに出すかは各マーカーの持ち主が
// 決める)。マーカー DOM 要素の生成・更新と、その寿命を担う。
// Game が所有し、マーカーを出す各モジュールへ参照を配る。resolveCollisions は全マーカーが
// 出揃った後に一度だけ呼ぶ必要があるため、game.sync の最後で呼ばれる。
//
// setPosition/setDirection は、3D空間上の「位置」「方向」を示すマーカーの
// 投影手順(project → set)を一元化したもの。headingRotationDeg は進行方向(ECI 速度)を
// 向くグリフの回転角を求める。camera-system.ts が MarkerManager に依存しているため、
// ProjectFn/ScaleFn 型を直接 import せず同形の関数型で受ける(循環 import を避ける)。
import { Vec3, addScaled, len, norm, sub } from '../../math/vec3';
import type { View } from '../view/view';
import { Projected } from '../../math/projection';
import { GroupedMarkers } from './grouped-markers';
import { LeadMarkers } from './lead-markers';
import { isOccluded } from '../../physics/occlusion';
import { LabelDeclutter, canHideIconClass, isCombatClass } from './label-declutter';
import { LabelLayout } from './label-layout';
import { strongestAttractor } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';

// 方向マーカーを投影する仮想距離 [m]。実在の位置ではなく方向のみを示す。
export const MARKER_DIR_DIST = 5e4;

// マーカーラベル優先度 (数値が大きいものが優先。天体 > 船・エンティティ)
export const MARKER_PRIORITY = {
  STAR_PLANET: 5000,
  DWARF_PLANET: 4000,
  SATELLITE_SMALL_BODY: 3000,
  LAGRANGE: 2000,
  PRIMARY_TARGET: 900,
  IMPACT: 850,
  BASE: 700,
  PLAYER: 600,
  ENEMY: 500,
  AMMO: 300,
  MANEUVER_NODE: 150,
  ORBITAL_NODE: 100,
  PROTEIN_SITE: 50,
} as const;

const MARKER_CLUSTER_PX = 40; // これより画面上で近いマーカー同士は1つの代表にまとめる [px]

// 画面外の対象を指す方位マーカーを置く円の半径(画面短辺の半分に対する比)
const MARKER_BEARING_RING_RATIO = 0.8;

type ProjectFn = (worldPos: Vec3) => Projected;
type ScaleFn = (worldPos: Vec3) => number;

interface MarkerRecord {
  key: string;
  root: HTMLElement;
  sym: HTMLElement;
  lbl: HTMLElement;
  fixedLabel: boolean;
  hidden: boolean;
  occlusionHidden: boolean;
  x: number;
  y: number;
  priority: number;
  // カメラからの距離。setPosition/setNodePosition が worldPos を持つ呼び出し元でのみ
  // 埋まる(undefined なら resolveCollisions の depth-guard を評価しない)。
  dist: number | undefined;
  // 間引きの可否を決める種別。className は要素の生成時にしか書かないので、生成時に確定させる。
  readonly canHideIconClass: boolean;
  readonly combatClass: boolean;
  // 直前フレームで優先度間引きにより隠れていたか(resolveCollisions のヒステリシス用)。
  prevLabelHidden: boolean;
}

// マーカーの種別ごとの既定優先度(値が大きいほど重なったとき残す)。呼び出し側が
// 個別の優先度を渡さなかったときに使う。
function defaultPriorityForClass(key: string, cls: string): number {
  if (cls.includes('mk-poi')) {
    return key.includes('-l') ? MARKER_PRIORITY.LAGRANGE : MARKER_PRIORITY.SATELLITE_SMALL_BODY;
  }
  if (cls.includes('mk-target')) return MARKER_PRIORITY.PRIMARY_TARGET;
  if (cls.includes('mk-impact')) return MARKER_PRIORITY.IMPACT;
  if (cls.includes('mk-base')) return MARKER_PRIORITY.BASE;
  if (cls.includes('mk-self') || cls.includes('mk-ally')) return MARKER_PRIORITY.PLAYER;
  if (cls.includes('mk-enemy')) return MARKER_PRIORITY.ENEMY;
  if (cls.includes('mk-ammo') || cls.includes('mk-fuel')) return MARKER_PRIORITY.AMMO;
  if (cls.includes('mk-mnode') || cls.includes('mk-burn')) return MARKER_PRIORITY.MANEUVER_NODE;
  if (cls.includes('mk-node') || cls.includes('mk-boardpass')) return MARKER_PRIORITY.ORBITAL_NODE;
  return 0;
}

// 指定タグの要素を作って id/class を設定し、parent へ追加して返す。
function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

export class MarkerManager {
  private markerDictionary = new Map<string, MarkerRecord>();
  private readonly occlusionFadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly declutter = new LabelDeclutter();
  private readonly labelLayout: LabelLayout;

  // 単独のオブジェクトでは決められないマーカー集合。敵マーカーは「画面上で近接するものを
  // まとめる」ために集合全体を、LEAD マーカーは自機と敵の両方を必要とする。
  // TODO: この2つは「表示機構」であるこのクラスとは別の分類にあたる。適切な所有者を決めて移す。
  readonly combatMarkers: GroupedMarkers;
  readonly leadMarkers: LeadMarkers;

  // root: マーカー要素を追加する親(#hud)。svgOverlay: ラベル引き出し線を描く SVG。
  constructor(
    private root: HTMLElement,
    svgOverlay: SVGSVGElement,
  ) {
    this.labelLayout = new LabelLayout(svgOverlay);
    this.combatMarkers = new GroupedMarkers(this, MARKER_CLUSTER_PX);
    this.leadMarkers = new LeadMarkers(this);
  }

  // マーカー(スクリーン座標)。visible=false で非表示。
  set(
    key: string,
    cls: string,
    sym: string,
    x: number,
    y: number,
    visible: boolean,
    label = '',
    opacity = 1,
    color?: string,
    rotationDeg?: number,
    symMarkup = false,
    fixedLabel = false,
    priority?: number,
    dist?: number,
  ): void {
    let m = this.markerDictionary.get(key);
    const itemPriority = priority ?? defaultPriorityForClass(key, cls);
    if (!m) {
      const root = el('div', `mk-${key}`, this.root, `mk ${cls}`);
      const symEl = el('span', `mk-${key}-s`, root, 'sym');
      const lblEl = el('span', `mk-${key}-l`, root, 'lbl');
      m = {
        key, root, sym: symEl, lbl: lblEl, fixedLabel, hidden: !visible, occlusionHidden: false,
        x, y, priority: itemPriority, dist,
        canHideIconClass: canHideIconClass(cls), combatClass: isCombatClass(cls),
        prevLabelHidden: false,
      };
      this.markerDictionary.set(key, m);
    }
    this.cancelOcclusionFade(key);
    m.occlusionHidden = false;
    m.fixedLabel = fixedLabel;
    m.hidden = !visible;
    m.x = x;
    m.y = y;
    m.priority = itemPriority;
    m.dist = dist;
    m.sym.classList.remove('priority-hidden');
    m.lbl.classList.remove('priority-hidden');
    m.root.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    m.root.style.left = `${x.toFixed(1)}px`;
    m.root.style.top = `${y.toFixed(1)}px`;
    m.root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    if (symMarkup) {
      if (m.sym.innerHTML !== sym) m.sym.innerHTML = sym;
    } else if (m.sym.textContent !== sym) m.sym.textContent = sym;
    if (label.includes('<')) {
      if (m.lbl.innerHTML !== label) m.lbl.innerHTML = label;
    } else if (m.lbl.textContent !== label) {
      m.lbl.textContent = label;
    }
    if (fixedLabel) m.lbl.style.transform = 'none';

    if (color) {
      m.root.style.color = color;
    } else {
      m.root.style.color = '';
    }
    m.root.style.textShadow = '';

    // シンボルの中心合わせは CSS が持つ(.mk 枠が投影点に中心揃え、.sym は inset:0 の
    // flex 中央寄せ)。ここで平行移動を足すと二重にかかって像からずれるので、回転だけを扱う。
    // rotationDeg が undefined のときは前回の回転角を維持する(向きが数値的に不定な瞬間に
    // 0° へスナップして戻るちらつきを防ぐため)。回転させない種別はそもそも渡さないので、
    // その場合は初期値の無回転のまま変わらない。
    if (rotationDeg !== undefined) m.sym.style.transform = `rotate(${rotationDeg}deg)`;
  }

  // 3D空間上の「位置」を示すマーカー(敵機・補給・ノードなど、実在の座標そのもの)。
  // worldPos を project して set するだけの手順を一元化する。
  setPosition(
    key: string,
    cls: string,
    sym: string,
    worldPos: Vec3,
    project: ProjectFn,
    label = '',
    opacity = 1,
    color?: string,
    rotationDeg?: number,
    symMarkup = false,
    fixedLabel = false,
    priority?: number,
    cameraPos?: Vec3,
  ): void {
    const p = project(worldPos);
    const dist = cameraPos === undefined ? undefined : len(sub(worldPos, cameraPos));
    this.set(key, cls, sym, p.x, p.y, p.front, label, opacity, color, rotationDeg, symMarkup, fixedLabel, priority, dist);
  }

  // 遮蔽判定を行い、天体に遮蔽されている場合は fadeOut、表示されている場合は setPosition するヘルパー。
  setNodePosition(
    key: string,
    cls: string,
    sym: string,
    worldPos: Vec3,
    project: ProjectFn,
    cameraPos: Vec3,
    celestialBodies: readonly CelestialMotion[],
    celestialBodiesPivot: number,
    occludeByBodies: boolean,
    label = '',
    priority?: number,
  ): void {
    if (occludeByBodies && isOccluded(cameraPos, worldPos, celestialBodies, celestialBodiesPivot)) {
      this.fadeOut(key);
    } else {
      this.setPosition(key, cls, sym, worldPos, project, label, 1, undefined, undefined, false, false, priority, cameraPos);
    }
  }

  // 3D空間上の「方向」を示すマーカー(プログレード/ボアサイト/BURN など、実在の位置を
  // 持たない)。origin から dir(単位ベクトル)方向へ MARKER_DIR_DIST だけ離れた仮想点を
  // 投影する。origin は自機位置で統一する。
  setDirection(
    key: string,
    cls: string,
    sym: string,
    origin: Vec3,
    dir: Vec3,
    project: ProjectFn,
    label = '',
    opacity = 1,
    color?: string,
    rotationDeg?: number,
    symMarkup = false,
    fixedLabel = false,
    priority?: number,
  ): void {
    const p = project(addScaled(origin, norm(dir), MARKER_DIR_DIST));
    this.set(key, cls, sym, p.x, p.y, p.front, label, opacity, color, rotationDeg, symMarkup, fixedLabel, priority);
  }

  // worldPos にいる対象の進行方向(最も強く引く天体に対する相対速度)を、上向きグリフをその方向へ
  // 向ける rotationDeg に変換する(atan2 は 0=右方向を返すため +90 して補正する)。
  // set/setPosition の rotationDeg 引数へそのまま渡せる。速度が視線とほぼ平行で
  // 投影差が縮退し方位を定められないときは undefined を返す。
  headingRotationDeg(
    worldPos: Vec3,
    vel: Vec3,
    project: ProjectFn,
    scale: ScaleFn,
    celestialBodies: readonly CelestialMotion[] = [],
    celestialBodiesPivot = 0,
  ): number | undefined {
    const center = celestialBodies.length > 0
      ? strongestAttractor(worldPos, celestialBodies, celestialBodiesPivot) : null;
    const relVel = center ? sub(vel, center.stateAt(celestialBodiesPivot).v) : vel;
    const probe = Math.max(1, scale(worldPos) * 2);
    const p0 = project(worldPos);
    const p1 = project(addScaled(worldPos, norm(relVel), probe));
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    if (Math.hypot(dx, dy) < 0.1) return undefined;
    return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  }

  // 画面外(背面を含む)の対象を、画面中心から見た方位として画面端の円周上に置く。
  // 画面内に居るあいだは隠す — 実位置を指す setPosition と対で使い、そちらが front=false や
  // 画面外へ出て見えなくなったぶんを補う。
  // sym は**上向きの記号**を渡すこと(方位角に 90° 足して回すため)。
  setBearing(
    key: string,
    cls: string,
    sym: string,
    p: Projected,
    label = '',
    opacity = 0.6,
    color?: string,
  ): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (p.front && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) {
      this.hide(key);
      return;
    }
    const cx = w / 2;
    const cy = h / 2;
    // 背面の対象は投影が反転しているので、方位も反転させる
    const sign = p.front ? 1 : -1;
    const ang = Math.atan2(sign * (p.y - cy), sign * (p.x - cx));
    const ring = Math.min(cx, cy) * MARKER_BEARING_RING_RATIO;
    this.set(
      key, cls, sym,
      cx + ring * Math.cos(ang), cy + ring * Math.sin(ang), true,
      label, opacity, color,
      (ang * 180) / Math.PI + 90,
    );
  }

  // hide と remove の使い分け:
  // hide   = キーが有限で使い回すマーカー(方向マーカー・補給スロットなど)。
  //          要素を消さずプールに残し、次に出すときの再生成コストを省く。
  // remove = 対象ごとにキーが増え続けるマーカー(敵・LEAD など)。対象が消えたら
  //          要素ごと捨てないと DOM とラベル衝突判定の走査対象が単調増加する。
  // そのキーのマーカーを直前のフレームで画面へ出したか。遮蔽で薄れている途中も出していない扱い。
  shows(key: string): boolean {
    const m = this.markerDictionary.get(key);
    return m !== undefined && !m.hidden && !m.occlusionHidden && !this.occlusionFadeTimers.has(key);
  }

  hide(key: string): void {
    const m = this.markerDictionary.get(key);
    if (!m) return;
    this.cancelOcclusionFade(key);
    m.occlusionHidden = false;
    m.hidden = true;
    m.root.style.display = 'none';
  }

  // 天体遮蔽で見えなくなるマーカーを、いきなり消さずに約300msで透明化する。
  // フェード完了後は通常の hide と同じく衝突判定の対象から外す。
  fadeOut(key: string): void {
    const m = this.markerDictionary.get(key);
    if (!m || m.occlusionHidden || m.hidden || this.occlusionFadeTimers.has(key)) return;
    m.root.style.display = 'block';
    m.hidden = false;
    m.root.style.opacity = '0';
    const timer = setTimeout(() => {
      this.occlusionFadeTimers.delete(key);
      const current = this.markerDictionary.get(key);
      if (current !== m || current.root.style.opacity !== '0') return;
      current.occlusionHidden = true;
      current.hidden = true;
      current.root.style.display = 'none';
    }, 300);
    this.occlusionFadeTimers.set(key, timer);
  }

  // マーカーを DOM ごと削除する。
  remove(key: string): void {
    const m = this.markerDictionary.get(key);
    if (!m) return;
    this.cancelOcclusionFade(key);
    m.root.remove();
    this.markerDictionary.delete(key);
  }

  // マーカーの要素を一括で片付ける。root 自体は Hud の所有物なので中身を空にするだけにとどめる。
  dispose(): void {
    // 破棄後に発火して片付けた要素を触りにいかないよう、保留中のフェードは先に解除する。
    for (const timer of this.occlusionFadeTimers.values()) clearTimeout(timer);
    this.occlusionFadeTimers.clear();
    for (const m of this.markerDictionary.values()) m.root.remove();
    this.markerDictionary.clear();
    this.labelLayout.dispose();
  }

  private cancelOcclusionFade(key: string): void {
    const timer = this.occlusionFadeTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.occlusionFadeTimers.delete(key);
  }

  // 全マーカーの優先度に基づくアイコン/ラベル間引きと、残ったラベルどうしの衝突緩和。
  // マップビューでのみ優先度間引きを行う。戦闘ビューでは照準や敵アイコン等を隠さない。
  resolveCollisions(view: View): void {
    const activeRecords = this.collectActiveMarkerRecords();
    const hidden = this.declutter.compute(activeRecords, view === 'map');
    // 間引きの結果を priority-hidden クラスのトグル(CSS フェード)で反映し、
    // 次フレームのヒステリシスが読む直前の状態として書き戻す。
    for (const m of activeRecords) {
      m.prevLabelHidden = hidden.labels.has(m.key);
      m.sym.classList.toggle('priority-hidden', hidden.icons.has(m.key));
      m.lbl.classList.toggle('priority-hidden', m.prevLabelHidden);
    }
    this.labelLayout.sync(activeRecords, hidden.labels);
  }

  // 現在表示中(hidden/occlusionHidden/フェードアウト完了のいずれでもない)のマーカーを集める。
  private collectActiveMarkerRecords(): MarkerRecord[] {
    const activeRecords: MarkerRecord[] = [];
    for (const m of this.markerDictionary.values()) {
      if (m.hidden || m.occlusionHidden || m.root.style.opacity === '0') continue;
      activeRecords.push(m);
    }
    return activeRecords;
  }
}

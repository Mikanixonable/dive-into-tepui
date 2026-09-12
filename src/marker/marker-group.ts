// 持ち主1人ぶんのマーカー群。毎フレームの宣言の列を受け取り、前フレームとの差分で要素を作り、
// 置き直し、宣言から外れたものを片付ける。遮蔽で畳む宣言だけは、透明になりきるまでの時間を
// sync が受け取る実時刻で測る。
import type { MarkerDeclaration } from './marker-declaration';
import type { MarkerSink } from './marker-sink';

// 遮蔽で畳むマーカーが透明になりきるまでの時間 [ms]。CSS の遷移と合わせる。
const OCCLUSION_FADE_MS = 300;

// 要素1つぶんの、いま画面に出している状態。
export interface MarkerRecord {
  readonly id: string;
  readonly root: HTMLElement;
  readonly sym: HTMLElement;
  readonly lbl: HTMLElement;
  fixedLabel: boolean;
  hidden: boolean;
  x: number;
  y: number;
  priority: number;
  dist: number | undefined;
  iconHidable: boolean;
  clustered: boolean;
  // 遮蔽で畳み始めた実時刻 [ms]。畳んでいる途中でなければ null。
  fadeStartMs: number | null;
  // 遮蔽で畳み終えたか。
  fadedOut: boolean;
  // 直前フレームで優先度間引きによりラベルが隠れていたか(ヒステリシス用)。
  prevLabelHidden: boolean;
}

// 指定タグの要素を作って id/class を設定し、parent へ追加して返す。
function el(tag: string, id: string, parent: HTMLElement, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  e.className = className;
  parent.appendChild(e);
  return e;
}

export class MarkerGroup implements MarkerSink {
  private readonly records = new Map<string, MarkerRecord>();
  private readonly declaredScratch = new Set<string>();

  // root へ要素を足す群を作る。onDispose はこの群を畳んだことを装置へ伝える先。
  public constructor(
    private readonly root: HTMLElement,
    private readonly onDispose: (group: MarkerGroup) => void,
  ) {}

  // このフレームに出すマーカーを宣言し直す。列から外れた宣言の要素は片付ける。
  // nowMs はフレームの実時刻 [ms]。空配列を渡せばこの群のマーカーは残らず消える。
  public sync(items: readonly MarkerDeclaration[], nowMs: number): void {
    const declared = this.declaredScratch;
    declared.clear();
    for (const item of items) {
      declared.add(item.id);
      this.place(item, nowMs);
    }
    for (const [id, m] of this.records) {
      if (declared.has(id)) continue;
      m.root.remove();
      this.records.delete(id);
    }
  }

  // その id のマーカーをこのフレームに画面へ出しているか。遮蔽で薄れている途中も出していない扱い。
  public shows(id: string): boolean {
    const m = this.records.get(id);
    return m !== undefined && !m.hidden && !m.fadedOut && m.fadeStartMs === null;
  }

  // 画面に出ているマーカーを out へ積む。
  public collectActive(out: MarkerRecord[]): void {
    for (const m of this.records.values()) {
      if (m.hidden || m.fadedOut || m.fadeStartMs !== null) continue;
      out.push(m);
    }
  }

  // この群の要素を残らず取り除く。呼んだ後のこの群は使えない。
  public dispose(): void {
    for (const m of this.records.values()) m.root.remove();
    this.records.clear();
    this.onDispose(this);
  }

  // 宣言1件ぶんの要素を、このフレームの値へ合わせる。遮蔽の宣言は要素を作らない —
  // 一度も描いていないマーカーは、畳んで見せる姿を持たない。
  private place(item: MarkerDeclaration, nowMs: number): void {
    const known = this.records.get(item.id);
    if (item.occluded === true) {
      if (known !== undefined) this.fade(known, nowMs);
      return;
    }
    const m = known ?? this.create(item);
    m.fadeStartMs = null;
    m.fadedOut = false;
    m.fixedLabel = item.fixedLabel === true;
    m.hidden = !item.front;
    m.x = item.x;
    m.y = item.y;
    m.priority = item.priority;
    m.dist = item.dist;
    m.iconHidable = item.iconHidable !== false;
    m.clustered = item.clustered === true;
    m.sym.classList.remove('priority-hidden');
    m.lbl.classList.remove('priority-hidden');
    m.root.style.display = item.front ? 'block' : 'none';
    if (!item.front) return;
    this.draw(m, item);
  }

  // 画面に出す1件ぶんの位置・字形・ラベル・色を要素へ書く。
  private draw(m: MarkerRecord, item: MarkerDeclaration): void {
    const opacity = item.opacity ?? 1;
    const label = item.label ?? '';
    m.root.style.left = `${item.x.toFixed(1)}px`;
    m.root.style.top = `${item.y.toFixed(1)}px`;
    m.root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    if (item.markup === true) {
      if (m.sym.innerHTML !== item.sym) m.sym.innerHTML = item.sym;
    } else if (m.sym.textContent !== item.sym) m.sym.textContent = item.sym;
    if (label.includes('<')) {
      if (m.lbl.innerHTML !== label) m.lbl.innerHTML = label;
    } else if (m.lbl.textContent !== label) {
      m.lbl.textContent = label;
    }
    if (m.fixedLabel) m.lbl.style.transform = 'none';
    m.root.style.color = item.color ?? '';
    m.root.style.textShadow = '';
    // 回転だけを扱う — シンボルの中心合わせは CSS が持つので、平行移動を足すと二重にかかる。
    // rotationDeg が undefined なら前回の角度を保つ(向きが不定な瞬間に 0° へ戻るちらつきを防ぐ)。
    if (item.rotationDeg !== undefined) m.sym.style.transform = `rotate(${item.rotationDeg}deg)`;
  }

  // 遮蔽で畳む。透明化は CSS の遷移に任せ、遷移が終わる時刻を過ぎたフレームで伏せる。
  private fade(m: MarkerRecord, nowMs: number): void {
    if (m.fadeStartMs !== null) {
      if (nowMs - m.fadeStartMs < OCCLUSION_FADE_MS) return;
      m.fadeStartMs = null;
      m.fadedOut = true;
      m.hidden = true;
      m.root.style.display = 'none';
      return;
    }
    if (m.fadedOut || m.hidden) return;
    m.root.style.display = 'block';
    m.root.style.opacity = '0';
    m.fadeStartMs = nowMs;
  }

  // 宣言1件ぶんの要素(枠・シンボル・ラベル)を作って記録する。
  private create(item: MarkerDeclaration): MarkerRecord {
    const root = el('div', `mk-${item.id}`, this.root, `mk ${item.cls}`);
    const m: MarkerRecord = {
      id: item.id,
      root,
      sym: el('span', `mk-${item.id}-s`, root, 'sym'),
      lbl: el('span', `mk-${item.id}-l`, root, 'lbl'),
      fixedLabel: false,
      hidden: true,
      x: item.x,
      y: item.y,
      priority: item.priority,
      dist: item.dist,
      iconHidable: true,
      clustered: false,
      fadeStartMs: null,
      fadedOut: false,
      prevLabelHidden: false,
    };
    this.records.set(item.id, m);
    return m;
  }
}

// HUD のスクリーン投影マーカー管理(表示機構のみ。何をどこに出すかは各マーカーの持ち主が
// 決める)。マーカー DOM 要素の生成・更新と、ラベル衝突回避のための SVG 引き出し線描画を担う。
// Game が所有し、マーカーを出す各モジュールへ参照を配る。resolveCollisions は全マーカーが
// 出揃った後に一度だけ呼ぶ必要があるため、game.sync の最後で呼ばれる。
//
// setPosition/setDirection は、3D空間上の「位置」「方向」を示すマーカーの
// 投影手順(project → set)を一元化したもの。headingRotationDeg は進行方向(ECI 速度)を
// 向くグリフの回転角を求める。camera-system.ts が MarkerManager に依存しているため、
// ProjectFn/ScaleFn 型を直接 import せず同形の関数型で受ける(循環 import を避ける)。
import { Vec3, addScaled, norm } from '../../physics/vec3';
import { Projected } from '../../physics/projection';
import * as C from '../const';
import { FILL_4 } from '../theme';

type ProjectFn = (worldPos: Vec3) => Projected;
type ScaleFn = (worldPos: Vec3) => number;

interface MarkerRecord {
  root: HTMLElement;
  sym: HTMLElement;
  lbl: HTMLElement;
  fixedLabel: boolean;
}

interface ActiveLabel {
  m: MarkerRecord;
  ox: number;
  oy: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
}

// ラベルの概算矩形を入れる画面空間グリッドのセル幅。ラベルの幅は文字数に
// よって変わるため、各ラベルは矩形がまたがる全セルへ登録する。
const COLLISION_BUCKET_SIZE = 64;
const COLLISION_PADDING = 4;

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
  private readonly activeScratch: ActiveLabel[] = [];
  private activeCount = 0;
  private candidateStamp = new Int32Array(0);
  private readonly candidatesScratch: number[] = [];
  // セル添字 (cellX, cellY) を x → y の二段の Map で引く。添字をそのまま鍵にするので、
  // 別のセルが同じ鍵を共有することはない。
  private readonly collisionBuckets = new Map<number, Map<number, number[]>>();
  private readonly bucketPool: number[][] = [];
  private readonly bucketRowPool: Map<number, number[]>[] = [];
  private readonly svgLinePool: SVGLineElement[] = [];

  // root: マーカー要素を追加する親(#hud)。svgOverlay: ラベル引き出し線を描く SVG。
  constructor(
    private root: HTMLElement,
    private svgOverlay: SVGSVGElement,
  ) {}

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
  ): void {
    let m = this.markerDictionary.get(key);
    if (!m) {
      const root = el('div', `mk-${key}`, this.root, `mk ${cls}`);
      const symEl = el('span', `mk-${key}-s`, root, 'sym');
      const lblEl = el('span', `mk-${key}-l`, root, 'lbl');
      m = { root, sym: symEl, lbl: lblEl, fixedLabel };
      this.markerDictionary.set(key, m);
    }
    m.fixedLabel = fixedLabel;
    m.root.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    m.root.style.left = `${x.toFixed(1)}px`;
    m.root.style.top = `${y.toFixed(1)}px`;
    m.root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    if (symMarkup) {
      if (m.sym.innerHTML !== sym) m.sym.innerHTML = sym;
    } else if (m.sym.textContent !== sym) m.sym.textContent = sym;
    if (m.lbl.textContent !== label) m.lbl.textContent = label;
    if (fixedLabel) m.lbl.style.transform = 'none';

    if (color) {
      m.root.style.color = color;
      m.root.style.textShadow = `0 0 4px ${color}`;
    } else {
      m.root.style.color = '';
      m.root.style.textShadow = '';
    }

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
  ): void {
    const p = project(worldPos);
    this.set(key, cls, sym, p.x, p.y, p.front, label, opacity, color, rotationDeg, symMarkup, fixedLabel);
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
  ): void {
    const p = project(addScaled(origin, norm(dir), C.MARKER_DIR_DIST));
    this.set(key, cls, sym, p.x, p.y, p.front, label, opacity, color, rotationDeg, symMarkup, fixedLabel);
  }

  // worldPos にいる対象の進行方向(ECI 速度 vel)を、上向きグリフをその方向へ向ける
  // rotationDeg に変換する(atan2 は 0=右方向を返すため +90 して補正する)。
  // set/setPosition の rotationDeg 引数へそのまま渡せる。速度が視線とほぼ平行で
  // 投影差が縮退し方位を定められないときは undefined を返す。
  headingRotationDeg(worldPos: Vec3, vel: Vec3, project: ProjectFn, scale: ScaleFn): number | undefined {
    const probe = scale(worldPos) * C.MARKER_HEADING_PROBE_PX;
    const p0 = project(worldPos);
    const p1 = project(addScaled(worldPos, norm(vel), probe));
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    if (Math.hypot(dx, dy) < C.MARKER_HEADING_DEGENERATE_PX) return undefined;
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
    const ring = Math.min(cx, cy) * C.MARKER_BEARING_RING_RATIO;
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
  hide(key: string): void {
    const m = this.markerDictionary.get(key);
    if (m) m.root.style.display = 'none';
  }

  // マーカーを DOM ごと削除する。
  remove(key: string): void {
    const m = this.markerDictionary.get(key);
    if (!m) return;
    m.root.remove();
    this.markerDictionary.delete(key);
  }

  // 全マーカーのラベルどうしの重なりを緩和し、ずらした分だけ引き出し線を描く。
  resolveCollisions(): void {
    const active = this.activeScratch;
    this.activeCount = 0;

    // 表示中のマーカーと、そのラベルの推定矩形を集める
    for (const m of this.markerDictionary.values()) {
      if (m.root.style.display === 'none' || !m.lbl.textContent || m.fixedLabel) {
        m.lbl.style.transform = 'translateX(-50%)';
        continue;
      }
      const xStr = m.root.style.left;
      const yStr = m.root.style.top;
      if (!xStr || !yStr) continue;
      const x = parseFloat(xStr);
      const y = parseFloat(yStr);

      const textLen = m.lbl.textContent.length;
      const w = textLen * 6.5 + 4; // 概算幅 [px]
      const h = 14;

      // ラベル中心の既定位置は、シンボル中心 (x, y) の 12px + h/2 下
      const index = this.activeCount++;
      const a = active[index] ?? (active[index] = { m, ox: 0, oy: 0, w: 0, h: 0, dx: 0, dy: 0 });
      a.m = m;
      a.ox = x;
      a.oy = y + 12 + h / 2;
      a.w = w;
      a.h = h;
      a.dx = 0;
      a.dy = 0;
    }

    // 重なったラベルどうしを反発させて緩和する
    const ITER = 5;
    if (this.candidateStamp.length < this.activeCount) this.candidateStamp = new Int32Array(this.activeCount);
    this.candidateStamp.fill(0, 0, this.activeCount);
    const candidateStamp = this.candidateStamp;
    const candidates = this.candidatesScratch;
    for (let iter = 0; iter < ITER; iter++) {
      // 現在の押し出し位置からグリッドを作り直す。ラベルが前の反復で別セルへ
      // 移動しても候補から漏れないよう、反復をまたいでバケットを再利用しない。
      for (const row of this.collisionBuckets.values()) {
        for (const bucket of row.values()) {
          bucket.length = 0;
          this.bucketPool.push(bucket);
        }
        row.clear();
        this.bucketRowPool.push(row);
      }
      this.collisionBuckets.clear();
      const buckets = this.collisionBuckets;
      for (let i = 0; i < this.activeCount; i++) {
        const a = active[i]!;
        const cx = a.ox + a.dx;
        const cy = a.oy + a.dy;
        const halfW = a.w / 2 + COLLISION_PADDING;
        const halfH = a.h / 2 + COLLISION_PADDING;
        const minCellX = Math.floor((cx - halfW) / COLLISION_BUCKET_SIZE);
        const maxCellX = Math.floor((cx + halfW) / COLLISION_BUCKET_SIZE);
        const minCellY = Math.floor((cy - halfH) / COLLISION_BUCKET_SIZE);
        const maxCellY = Math.floor((cy + halfH) / COLLISION_BUCKET_SIZE);

        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
            let row = buckets.get(cellX);
            if (!row) {
              row = this.bucketRowPool.pop() ?? new Map<number, number[]>();
              buckets.set(cellX, row);
            }
            let bucket = row.get(cellY);
            if (!bucket) {
              bucket = this.bucketPool.pop() ?? [];
              row.set(cellY, bucket);
            }
            bucket.push(i);
          }
        }
      }

      for (let i = 0; i < this.activeCount; i++) {
        const a = active[i]!;
        const ax = a.ox + a.dx;
        const ay = a.oy + a.dy;

        // ラベルの押し出し判定に必要なセルだけを辿る。矩形をまたがる全セルへ
        // 登録しているため、重なり得る2矩形は少なくとも1セルを共有する。
        const halfW = a.w / 2 + COLLISION_PADDING;
        const halfH = a.h / 2 + COLLISION_PADDING;
        const minCellX = Math.floor((ax - halfW) / COLLISION_BUCKET_SIZE);
        const maxCellX = Math.floor((ax + halfW) / COLLISION_BUCKET_SIZE);
        const minCellY = Math.floor((ay - halfH) / COLLISION_BUCKET_SIZE);
        const maxCellY = Math.floor((ay + halfH) / COLLISION_BUCKET_SIZE);

        candidates.length = 0;
        const stamp = i + 1;
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const row = buckets.get(cellX);
          if (!row) continue;
          for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
            const bucket = row.get(cellY);
            if (!bucket) continue;
            for (const j of bucket) {
              if (j > i && candidateStamp[j] !== stamp) {
                candidateStamp[j] = stamp;
                candidates.push(j);
              }
            }
          }
        }

        // バケットの巡回順はセル配置に依存するため、元の全ペア走査と同じ
        // i→j の順序に戻す。押し出しの累積結果を従来から変えにくくするため。
        candidates.sort((left, right) => left - right);
        for (const j of candidates) {
          const b = active[j]!;
          const bx = b.ox + b.dx;
          const by = b.oy + b.dy;
          const minDistX = (a.w + b.w) / 2 + COLLISION_PADDING;
          const minDistY = (a.h + b.h) / 2 + COLLISION_PADDING;
          const dx = ax - bx;
          const dy = ay - by;
          if (Math.abs(dx) < minDistX && Math.abs(dy) < minDistY) {
            const ex = minDistX - Math.abs(dx);
            const ey = minDistY - Math.abs(dy);
            if (ex < ey) {
              const push = (ex / 2 + 0.5) * Math.sign(dx || 1);
              a.dx += push;
              b.dx -= push;
            } else {
              const push = (ey / 2 + 0.5) * Math.sign(dy || 1);
              a.dy += push;
              b.dy -= push;
            }
          }
        }
      }
    }

    // ずらした位置を反映し、シンボルとの引き出し線を引く
    let lineIndex = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const a = active[i]!;
      if (Math.abs(a.dx) > 1 || Math.abs(a.dy) > 1) {
        a.m.lbl.style.transform = `translate(calc(-50% + ${a.dx}px), ${a.dy}px)`;
        const line = this.svgLinePool[lineIndex] ?? document.createElementNS('http://www.w3.org/2000/svg', 'line');
        if (lineIndex === this.svgLinePool.length) this.svgLinePool.push(line);
        line.style.display = '';
        line.setAttribute('x1', a.ox.toString());
        line.setAttribute('y1', (a.oy - 12 - a.h / 2).toString());
        line.setAttribute('x2', (a.ox + a.dx).toString());
        line.setAttribute('y2', (a.oy + a.dy - a.h / 2).toString());
        line.setAttribute('stroke', FILL_4);
        line.setAttribute('stroke-width', '1');
        // 既存ノードの appendChild は同じノードを移動するだけなので、active 順を保つ。
        this.svgOverlay.appendChild(line);
        lineIndex++;
      } else {
        a.m.lbl.style.transform = 'translateX(-50%)';
      }
    }
    for (; lineIndex < this.svgLinePool.length; lineIndex++) this.svgLinePool[lineIndex]!.style.display = 'none';
  }
}

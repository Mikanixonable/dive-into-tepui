// HUD のスクリーン投影マーカー管理(表示機構のみ。何をどこに出すかは各マーカーの持ち主が
// 決める)。マーカー DOM 要素の生成・更新と、ラベル衝突回避のための SVG 引き出し線描画を担う。
// Game が所有し、マーカーを出す各モジュールへ参照を配る。resolveCollisions は全マーカーが
// 出揃った後に一度だけ呼ぶ必要があるため、game.sync の最後で呼ばれる。
//
// setPosition/setDirection は、3D空間上の「位置」「方向」を示すマーカーの
// 投影手順(project → set)を一元化したもの。camera-system.ts が MarkerManager に
// 依存しているため、ProjectFn 型を直接 import せず同形の関数型で受ける
// (循環 import を避ける)。
import { Vec3, addScaled, norm } from '../../physics/vec3';
import { Projected } from '../../physics/projection';
import * as C from '../const';

type ProjectFn = (worldPos: Vec3) => Projected;

function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

export class MarkerManager {
  private markerDictionary = new Map<string, { root: HTMLElement; sym: HTMLElement; lbl: HTMLElement }>();

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
    rotationDeg?: number
  ): void {
    let m = this.markerDictionary.get(key);
    if (!m) {
      const root = el('div', `mk-${key}`, this.root, `mk ${cls}`);
      const symEl = el('span', `mk-${key}-s`, root, 'sym');
      const lblEl = el('span', `mk-${key}-l`, root, 'lbl');
      m = { root, sym: symEl, lbl: lblEl };
      this.markerDictionary.set(key, m);
    }
    m.root.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    m.root.style.left = `${x.toFixed(1)}px`;
    m.root.style.top = `${y.toFixed(1)}px`;
    m.root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    if (m.sym.textContent !== sym) m.sym.textContent = sym;
    if (m.lbl.textContent !== label) m.lbl.textContent = label;

    if (color) {
      m.root.style.color = color;
      m.root.style.textShadow = `0 0 4px ${color}`;
    } else {
      m.root.style.color = '';
      m.root.style.textShadow = '';
    }

    // シンボルの中心合わせは CSS が持つ(.mk 枠が投影点に中心揃え、.sym は inset:0 の
    // flex 中央寄せ)。ここで平行移動を足すと二重にかかって像からずれるので、回転だけを扱う。
    m.sym.style.transform = rotationDeg !== undefined ? `rotate(${rotationDeg}deg)` : '';
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
  ): void {
    const p = project(worldPos);
    this.set(key, cls, sym, p.x, p.y, p.front, label, opacity, color, rotationDeg);
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
  ): void {
    this.setPosition(key, cls, sym, addScaled(origin, norm(dir), C.MARKER_DIR_DIST), project, label, opacity, color, rotationDeg);
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

  remove(key: string): void {
    const m = this.markerDictionary.get(key);
    if (!m) return;
    m.root.remove();
    this.markerDictionary.delete(key);
  }

  resolveCollisions(): void {
    const active: { m: any; ox: number; oy: number; w: number; h: number; dx: number; dy: number }[] = [];

    // 1. Gather active markers and their estimated label bounding boxes
    for (const m of this.markerDictionary.values()) {
      if (m.root.style.display === 'none' || !m.lbl.textContent) {
        m.lbl.style.transform = 'translateX(-50%)';
        continue;
      }
      const xStr = m.root.style.left;
      const yStr = m.root.style.top;
      if (!xStr || !yStr) continue;
      const x = parseFloat(xStr);
      const y = parseFloat(yStr);

      const textLen = m.lbl.textContent.length;
      const w = textLen * 6.5 + 4; // approx width
      const h = 14;

      // Default label center is 12px + h/2 below the symbol center (x, y)
      active.push({ m, ox: x, oy: y + 12 + h / 2, w, h, dx: 0, dy: 0 });
    }

    // 2. Simple relaxation to push overlapping labels apart
    const ITER = 5;
    for (let iter = 0; iter < ITER; iter++) {
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!;
          const b = active[j]!;
          const ax = a.ox + a.dx;
          const ay = a.oy + a.dy;
          const bx = b.ox + b.dx;
          const by = b.oy + b.dy;
          const minDistX = (a.w + b.w) / 2 + 4;
          const minDistY = (a.h + b.h) / 2 + 4;
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

    // 3. Apply positions and draw SVG lines
    this.svgOverlay.innerHTML = '';
    for (const a of active) {
      if (Math.abs(a.dx) > 1 || Math.abs(a.dy) > 1) {
        a.m.lbl.style.transform = `translate(calc(-50% + ${a.dx}px), ${a.dy}px)`;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', a.ox.toString());
        line.setAttribute('y1', (a.oy - 12 - a.h / 2).toString());
        line.setAttribute('x2', (a.ox + a.dx).toString());
        line.setAttribute('y2', (a.oy + a.dy - a.h / 2).toString());
        line.setAttribute('stroke', 'rgba(255,255,255,0.4)');
        line.setAttribute('stroke-width', '1');
        this.svgOverlay.appendChild(line);
      } else {
        a.m.lbl.style.transform = 'translateX(-50%)';
      }
    }
  }
}

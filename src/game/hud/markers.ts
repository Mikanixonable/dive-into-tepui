// HUD のスクリーン投影マーカー管理(旧 Hud.marker/hideMarker/resolveMarkerCollisions)。
// マーカー DOM 要素の生成・更新と、ラベル衝突回避のための SVG 引き出し線描画を担う。

function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

export class MarkerManager {
  private markers = new Map<string, { root: HTMLElement; sym: HTMLElement; lbl: HTMLElement }>();

  // root: マーカー要素を追加する親(#hud)。svgOverlay: ラベル引き出し線を描く SVG。
  constructor(
    private root: HTMLElement,
    private svgOverlay: SVGSVGElement,
  ) {}

  // マーカー(スクリーン座標)。visible=false で非表示。
  marker(
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
    let m = this.markers.get(key);
    if (!m) {
      const root = el('div', `mk-${key}`, this.root, `mk ${cls}`);
      const symEl = el('span', `mk-${key}-s`, root, 'sym');
      const lblEl = el('span', `mk-${key}-l`, root, 'lbl');
      m = { root, sym: symEl, lbl: lblEl };
      this.markers.set(key, m);
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

    if (rotationDeg !== undefined) {
      m.sym.style.transform = `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
      m.sym.style.display = 'inline-block';
    } else {
      m.sym.style.transform = 'translate(-50%, -50%)'; // default translation for sym
    }
  }

  hideMarker(key: string): void {
    const m = this.markers.get(key);
    if (m) m.root.style.display = 'none';
  }

  resolveMarkerCollisions(): void {
    const active: { m: any; ox: number; oy: number; w: number; h: number; dx: number; dy: number }[] = [];

    // 1. Gather active markers and their estimated label bounding boxes
    for (const m of this.markers.values()) {
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

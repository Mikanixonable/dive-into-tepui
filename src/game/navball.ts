// 画面下部中央の Navball(姿勢儀)。機体座標系(+X 右, +Y 上, +Z 機首)で
// 見た各基準方向を球面上に描画する。球の中心 = 機首方向。
// 地球方向の半球を青く塗り分けるので、水平線でピッチ・ロールが直感的に分かる。
// 球面はピクセル走査で毎フレーム描き直す(地球方向との内積 1 回/px なので軽い)。
import { Quat, qRotate } from '../physics/attitude';
import { Vec3, v3 } from '../physics/vec3';

const CSS_SIZE = 152; // 表示サイズ [css px]
const N = 304; // canvas 解像度(2x でにじみを防ぐ)
const R = N / 2 - 8; // 球の半径 [backing px]

export interface NavballDirs {
  earthDown: Vec3; // 地球中心方向(ワールド)
  prograde: Vec3;
  normal: Vec3;
  radialOut: Vec3;
  target: Vec3 | null; // ターゲット方向(いなければ null)
}

// ワールド → 機体座標系(q の共役で回転)
function worldToBody(q: Quat, v: Vec3): Vec3 {
  return qRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

interface Mark {
  dir: Vec3; // 機体座標系
  glyph: string;
  label: string;
  color: string;
}

export class Navball {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: ImageData;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = N;
    this.canvas.height = N;
    this.canvas.style.cssText =
      `position:fixed; bottom:32px; left:50%; transform:translateX(-50%);` +
      `width:${CSS_SIZE}px; height:${CSS_SIZE}px; pointer-events:none; z-index:9;`;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(N, N);
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? 'block' : 'none';
  }

  update(q: Quat, dirs: NavballDirs): void {
    const down = worldToBody(q, dirs.earthDown);
    const pro = worldToBody(q, dirs.prograde);
    const nrm = worldToBody(q, dirs.normal);
    const rout = worldToBody(q, dirs.radialOut);
    const tgt = dirs.target ? worldToBody(q, dirs.target) : null;

    this.paintSphere(down);

    const marks: Mark[] = [
      { dir: pro, glyph: '⊙', label: 'PRO', color: '#9dff6b' },
      { dir: v3(-pro.x, -pro.y, -pro.z), glyph: '⊗', label: 'RET', color: '#9dff6b' },
      { dir: nrm, glyph: '▲', label: 'NRM', color: '#d08cff' },
      { dir: v3(-nrm.x, -nrm.y, -nrm.z), glyph: '▽', label: 'ANM', color: '#d08cff' },
      { dir: rout, glyph: '◎', label: 'OUT', color: '#7de8ff' },
      { dir: v3(-rout.x, -rout.y, -rout.z), glyph: '◉', label: 'IN', color: '#7de8ff' },
    ];
    if (tgt) {
      marks.push({ dir: tgt, glyph: '◇', label: 'TGT', color: '#ff7ab0' });
      marks.push({ dir: v3(-tgt.x, -tgt.y, -tgt.z), glyph: '◆', label: 'ATG', color: '#ff7ab0' });
    }
    for (const m of marks) this.drawMark(m);
    this.drawCrosshair();
  }

  // 球面本体: px ごとに機体座標系の方向 nb を求め、地球方向との内積で
  // 「地面(青)/宇宙(灰)」を塗り分ける。水平線と ±30° ピッチ線も描く。
  private paintSphere(down: Vec3): void {
    const data = this.img.data;
    const c = N / 2;
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const idx = (py * N + px) * 4;
        const nx = (px - c) / R;
        const ny = (c - py) / R;
        const rr = nx * nx + ny * ny;
        if (rr > 1) {
          data[idx + 3] = 0;
          continue;
        }
        const nz = Math.sqrt(1 - rr);
        const s = nx * down.x + ny * down.y + nz * down.z; // 地球方向成分
        // 縁を暗く落として球らしく見せる
        const shade = 0.4 + 0.6 * nz;
        let r: number;
        let g: number;
        let b: number;
        if (Math.abs(s) < 0.012) {
          r = g = b = 235; // 水平線
        } else if (Math.abs(Math.abs(s) - 0.5) < 0.006) {
          r = g = b = 150; // ±30° ピッチ線
        } else if (s > 0) {
          r = 38; g = 92; b = 198; // 地球側 = 青
        } else {
          r = 58; g = 62; b = 70; // 宇宙側 = 暗灰
        }
        data[idx] = r * shade;
        data[idx + 1] = g * shade;
        data[idx + 2] = b * shade;
        data[idx + 3] = 225;
      }
    }
    this.ctx.clearRect(0, 0, N, N);
    this.ctx.putImageData(this.img, 0, 0);
    // 外周リング
    this.ctx.strokeStyle = 'rgba(90,190,220,0.55)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(c, c, R + 3, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  // 前方半球(z>0)ならその位置に、裏側なら縁に減光して描く
  private drawMark(m: Mark): void {
    const ctx = this.ctx;
    const c = N / 2;
    const d = m.dir;
    let x: number;
    let y: number;
    let alpha: number;
    if (d.z > 0.02) {
      x = c + d.x * R;
      y = c - d.y * R;
      alpha = 1;
    } else {
      const l = Math.hypot(d.x, d.y);
      if (l < 1e-6) return; // 真後ろ: 表示不能
      x = c + (d.x / l) * R * 0.96;
      y = c - (d.y / l) * R * 0.96;
      alpha = 0.3;
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = m.color;
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px monospace';
    ctx.fillText(m.glyph, x, y + 9);
    ctx.font = '11px monospace';
    ctx.fillText(m.label, x, y + 24);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // 中央固定の機首マーカー(KSP 風の V 字 + 中心点)
  private drawCrosshair(): void {
    const ctx = this.ctx;
    const c = N / 2;
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c - 26, c);
    ctx.lineTo(c - 10, c);
    ctx.lineTo(c, c + 10);
    ctx.lineTo(c + 10, c);
    ctx.lineTo(c + 26, c);
    ctx.stroke();
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(c - 1.5, c - 1.5, 3, 3);
  }
}

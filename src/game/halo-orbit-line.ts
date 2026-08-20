// CollinearFrame と面外振幅 Az からラグランジュ点(L1/L2)まわりのハロー軌道(閉じた3次元ループ)を描画する。
// 頂点はラグランジュ点(CollinearFrame.origin)相対座標として保持し、フローティングオリジンの
//Object3D 平行移動(setTransform)でラグランジュ点の ECI 位置へ置く。
import * as THREE from 'three/webgpu';
import { CollinearFrame, CollinearPoint, collinearFrame, haloAmplitudeX, haloOrbitOffsetsFor } from '../physics/halo';
import type { Ephemeris } from '../physics/ephemeris';
import type { OrbitingId } from '../physics/attractor';
import { Vec3 } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';
import { LineStyle } from '../render/line-style';

const MAX_VERTICES = 1024;
const BAKE_SAMPLES = 256;
const TOL_AX_REL = 1e-3;
const TOL_PLANE = Math.cos((0.15 * Math.PI) / 180);

export class HaloOrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  private snapFrame: CollinearFrame | null = null;
  private snapPoint: CollinearPoint = 'L1';
  private snapAz = 0;
  private snapAx = 0;
  private revision: object = {};
  private bakedOffsets: Vec3[] = [];

  constructor(style: LineStyle) {
    this.curve = new Curve({ style, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  setRenderOrder(renderOrder: number): void {
    this.curve.setRenderOrder(renderOrder);
  }

  // t∈[0,1](軌道1周)を、regen 時に焼き込んだ数値修正済み軌道のサンプル列から線形補間する。
  private readonly sampler: CurveSampler = (t, out) => {
    const pts = this.bakedOffsets;
    const n = pts.length;
    if (n === 0) return;
    const f = (((t % 1) + 1) % 1) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const frac = f - Math.floor(f);
    const a = pts[i0] as Vec3;
    const b = pts[i1] as Vec3;
    out.set(a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac, a.z + (b.z - a.z) * frac);
  };

  sync(
    secondary: OrbitingId,
    point: CollinearPoint,
    az: number,
    displayTime: number,
    ephemeris: Ephemeris,
    fo: FloatingOrigin,
    camera: THREE.Camera,
    force = false,
  ): void {
    let frame: CollinearFrame;
    let ax: number;
    try {
      frame = collinearFrame(secondary, point, displayTime, ephemeris);
      ax = haloAmplitudeX(frame, point, Math.abs(az));
      if (isNaN(ax) || ax <= 0) {
        this.curve.setVisible(false);
        return;
      }
    } catch {
      this.snapFrame = null;
      this.curve.setVisible(false);
      return;
    }

    this.curve.setTransform(fo.RtoThreeV3(frame.origin));

    if (this.needsRegen(frame, point, az, ax, force)) {
      this.revision = {};
      this.snapFrame = frame;
      this.snapPoint = point;
      this.snapAz = az;
      this.snapAx = ax;
      this.bakedOffsets = haloOrbitOffsetsFor(frame, point, az, BAKE_SAMPLES);
    }

    if (this.bakedOffsets.length === 0) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setCurve(this.sampler, { revision: this.revision, camera });
    this.curve.setVisible(true);
  }

  private needsRegen(
    frame: CollinearFrame, point: CollinearPoint, az: number, ax: number, force: boolean,
  ): boolean {
    if (!this.snapFrame) return true;
    if (force) return true;
    if (this.snapPoint !== point) return true;
    if (Math.abs(this.snapAz - az) > 1) return true;
    if (Math.abs(this.snapAx - ax) / (this.snapAx || 1) > TOL_AX_REL) return true;
    const s = this.snapFrame;
    if (frame.xHat.x * s.xHat.x + frame.xHat.y * s.xHat.y + frame.xHat.z * s.xHat.z < TOL_PLANE) return true;
    if (frame.zHat.x * s.zHat.x + frame.zHat.y * s.zHat.y + frame.zHat.z * s.zHat.z < TOL_PLANE) return true;
    return false;
  }

  dispose(): void {
    this.curve.dispose();
  }
}

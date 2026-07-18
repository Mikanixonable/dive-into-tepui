// 軌道計画モード(マップモード)の視点・表示状態: マップ地球中心カメラ・
// フォーカス対象(地球/月/太陽/ラグランジュ点等)ラベル・太陽回転系表示・
// 未来スライダー。「マップモード中の見た目と視点」の担当で、mapMode 中のみ意味を持つ。
// game.ts を import しない — 依存はコンストラクタ注入(hud)・引数(Vec3/project等)のみ。
import * as THREE from 'three/webgpu';
import { moonPosition, sunPosition, emLagrangePoints, seLagrangePoints } from '../physics/ephemeris';
import { Vec3, sub, v3 } from '../physics/vec3';
import * as C from './const';
import { Hud } from './hud';
import { MouseDelta } from './input';
import { MapLabel, ProjectFn } from './planner';

// drawLabels() / displayTime() が必要とする、Game 側の現在状態のスナップショット。
export interface MapViewCtx {
  simTime: number;
  sunPhase0: number;
  moonPhase0: number;
  duration: number; // predictDurationSec()
}

export class MapView {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0.7;
  pitch = 0.45;
  dist = 4.5e7;
  focus: string = 'earth';
  // Stored in the floating-origin render frame. It is applied to both the
  // camera and its target, so middle-drag is a true parallel translation.
  readonly pan = new THREE.Vector3();
  frameRotating = false;
  sliderT = 0; // 0..1(0 でゴーストマーカー非表示)
  labels: MapLabel[] = [];

  constructor(private readonly hud: Hud) {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1e4,
      C.MAP_CAMERA_FAR,
    );
  }

  reset(): void {
    this.focus = 'earth';
    this.yaw = 0.7;
    this.pitch = 0.45;
    this.dist = 4.5e7;
    this.pan.set(0, 0, 0);
    this.hud.hint('マップ視点をリセット');
  }

  // マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点など)ラベルを更新し、
  // HUD マーカーとして描画する。
  drawLabels(o: Vec3, ctx: MapViewCtx, project: ProjectFn): void {
    const t = this.sliderT > 0 ? this.displayTime(ctx.simTime, ctx.duration) : ctx.simTime;
    const mPos = moonPosition(t, ctx.moonPhase0);
    const sPos = sunPosition(t, ctx.sunPhase0);
    const emL = emLagrangePoints(t, ctx.moonPhase0);
    const seL = seLagrangePoints(t, ctx.sunPhase0);

    this.labels = [
      { id: 'earth', name: '地球', pos: v3(0, 0, 0) },
      { id: 'moon', name: '月', pos: mPos },
      { id: 'sun', name: '太陽', pos: sPos },
      { id: 'em-l1', name: '地球-月 L1', pos: emL.L1 },
      { id: 'em-l2', name: '地球-月 L2', pos: emL.L2 },
      { id: 'em-l3', name: '地球-月 L3', pos: emL.L3 },
      { id: 'em-l4', name: '地球-月 L4', pos: emL.L4 },
      { id: 'em-l5', name: '地球-月 L5', pos: emL.L5 },
      { id: 'se-l1', name: '太陽-地球 L1', pos: seL.L1 },
      { id: 'se-l2', name: '太陽-地球 L2', pos: seL.L2 },
    ];

    for (const lbl of this.labels) {
      const wp = sub(lbl.pos, o);
      const p = project(wp);
      if (p && p.front) {
        this.hud.marker(lbl.id, 'poi', '●', p.x, p.y, true, lbl.name);
      } else {
        this.hud.marker(lbl.id, 'poi', '●', 0, 0, false, lbl.name);
      }
    }
  }

  // ゴーストスライダーの表示時刻(sliderT > 0 のときだけ意味を持つ。
  // 呼び出し側で mapMode / sliderT > 0 のガードを行う)。
  displayTime(simTime: number, duration: number): number {
    return simTime + this.sliderT * duration;
  }

  // 毎フレーム、マップカメラの位置・向きをマウス/矢印キー操作から更新する。
  // o: フローティングオリジン(自機位置)、sunAz: 太陽回転系表示の追従角。
  updateCamera(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    o: Vec3,
    sunAz: number,
  ): void {
    // 戦闘ビューは yaw -= dx*0.005 なので、符号を反転させて左右の回転方向を揃える
    this.yaw += mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(
      -1.4,
      Math.min(1.4, this.pitch + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
    );
    this.dist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      // Convert pixels to map-world metres at the current target plane.
      // The camera basis makes the gesture independent of orbit yaw/pitch.
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
      const metersPerPixel =
        (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))) /
        Math.max(1, window.innerHeight);
      this.pan.addScaledVector(right, -mouse.panDx * metersPerPixel);
      this.pan.addScaledVector(up, mouse.panDy * metersPerPixel);
    }
    const cp = Math.cos(this.pitch);
    // 太陽回転系表示: 太陽の実際の方位ドリフトぶんカメラ方位を追従させ、
    // 画面上で太陽方向がほぼ固定されて見えるようにする(予測サンプルの回転補正と
    // 組み合わせて、t=simTime では回転量ゼロで整合する)。
    const displayYaw = this.yaw + (this.frameRotating ? sunAz : 0);
    // 地球中心はフローティングオリジンで -o
    let focusRel = v3(-o.x, -o.y, -o.z);
    if (this.focus !== 'earth') {
      const lbl = this.labels.find(l => l.id === this.focus);
      if (lbl) {
        focusRel = sub(lbl.pos, o);
      }
    }
    const targetX = focusRel.x + this.pan.x;
    const targetY = focusRel.y + this.pan.y;
    const targetZ = focusRel.z + this.pan.z;
    this.camera.position.set(
      targetX + cp * Math.cos(displayYaw) * this.dist,
      targetY + Math.sin(this.pitch) * this.dist,
      targetZ + cp * Math.sin(displayYaw) * this.dist,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(targetX, targetY, targetZ);
    const aspect = window.innerWidth / window.innerHeight;
    if (Math.abs(this.camera.aspect - aspect) > 1e-6) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}

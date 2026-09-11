// 照準ズーム視点: 機体位置から機首方向を狙う固定カメラ(画面中心 = 照準先)。
// 視点は毎フレーム機体の位置と姿勢から求め直す。
import { addScaled, norm, v3 } from '../../math/vec3';
import { LOCAL_FORWARD, LOCAL_UP, qRotate } from '../../math/quat';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { Viewpoint } from '../../math/projection';
import type { Viewport } from '../../render/viewport';

const ZOOM_FOV = 6; // 照準ズームの垂直画角 [deg]

export class GunsightCamera {
  // 直近の update が求めた視点。
  public viewpoint: Viewpoint;

  // 機体を狙う前の視点を、原点を向いた形で組む。アスペクト比だけが viewport から決まる。
  public constructor(viewport: Viewport) {
    this.viewpoint = {
      position: v3(),
      up: v3(0, 1, 0),
      lookTarget: v3(),
      fovDeg: ZOOM_FOV,
      aspect: viewport.width / viewport.height,
    };
  }

  // 操作対象の位置と姿勢から視点を求め、viewpoint へ書き戻す。
  public update(controlled: Controllable, viewport: Viewport): void {
    const boreFwd = qRotate(controlled.motion.att.q, LOCAL_FORWARD);
    const boreUp = qRotate(controlled.motion.att.q, LOCAL_UP);
    const center = controlled.motion.state.r;
    // 機体の中心から機首方向を見る。上方向は機体の上。
    this.viewpoint = {
      position: center,
      up: norm(boreUp),
      lookTarget: addScaled(center, norm(boreFwd), 1000),
      fovDeg: ZOOM_FOV,
      aspect: viewport.width / viewport.height,
    };
  }
}

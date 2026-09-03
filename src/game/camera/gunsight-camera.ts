// 照準ズーム視点: 機体位置から機首方向を狙う固定カメラ(画面中心 = 照準先)。
// yaw/pitch/dist のような内部状態を持たず、機体姿勢のみから毎フレーム視点を求める。
import { addScaled, norm, v3 } from '../../math/vec3';
import { LOCAL_FORWARD, LOCAL_UP, qRotate } from '../../math/quat';
import { Player } from '../player/player';
import { Viewpoint } from '../../math/projection';

const ZOOM_FOV = 6; // [Z]キー長押し時の照準ズーム画角 [deg]

export class GunsightCamera {
  viewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: ZOOM_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  // 機体姿勢のみから視点を求め、viewpoint へ書き戻す。
  update(player: Player): void {
    const boreFwd = qRotate(player.att.q, LOCAL_FORWARD);
    const boreUp = qRotate(player.att.q, LOCAL_UP);
    const center = player.state.r;
    this.viewpoint = {
      position: center,
      up: norm(boreUp),
      lookTarget: addScaled(center, norm(boreFwd), 1000),
      fovDeg: ZOOM_FOV,
      aspect: window.innerWidth / window.innerHeight,
    };
  }
}



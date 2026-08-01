// 照準ズーム視点: 機体位置から機首方向を狙う固定カメラ(画面中心 = 照準先)。
// yaw/pitch/dist のような内部状態を持たず、機体姿勢のみから毎フレーム視点を求める。
import { addScaled, norm, v3 } from '../../physics/vec3';
import { qRotate } from '../../physics/attitude';
import * as C from '../const';
import { Player } from '../player/player';
import { ViewFrame } from '../../physics/projection';

export class GunsightCamera {
  view: ViewFrame = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.ZOOM_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  // 機体姿勢のみから視点を求め、view へ書き戻す。
  update(player: Player): void {
    const boreFwd = qRotate(player.att.q, v3(0, 0, 1));
    const boreUp = qRotate(player.att.q, v3(0, 1, 0));
    const center = player.state.r;
    this.view = {
      position: center,
      up: norm(boreUp),
      lookTarget: addScaled(center, norm(boreFwd), 1000),
      fovDeg: C.ZOOM_FOV,
      aspect: window.innerWidth / window.innerHeight,
    };
  }
}



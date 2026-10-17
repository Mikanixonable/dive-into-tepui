// 動く絵の道具が共有する、カメラを動かす列。

// カメラの 1 フレームの動き [描画バッファの画素]。ラスタライズが変わる画素の 1 未満から、走査のダウンサンプリングが
// 一巡する走査の画素の幅(1/4 の解像度で 4 px)まで。
export const MOTION_SPEEDS_PX = [0.25, 1, 4];

// 動きの向き(x は右、y は上)。画素の格子に沿う向きは走査の格子の決まった位相だけを踏むので、横から 30° 傾ける。
const MOTION_DIRECTION = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];

// 列の最初から frame フレーム目までの、1 フレーム speed [px] の動きの累計 [描画バッファの画素]。x は右、y は上。
export function motionOffsetPx(frame, speed) {
  return MOTION_DIRECTION.map((component) => frame * speed * component);
}

// 列。frame(k) は k 番目のフレームの、列の最初からのカメラの並進・カメラを中心とする回転・周回の中心を中心とする回転
// [描画バッファの画素](MotionSequence.moveCamera の引数)。
export const CAMERA_MOTION_SEQUENCES = [
  ...MOTION_SPEEDS_PX.map((speed) => ({
    name: `translate-${speed}px`,
    frame: (k) => ({ translation: motionOffsetPx(k, speed), rotation: [0, 0], orbit: [0, 0] }),
  })),
  ...MOTION_SPEEDS_PX.map((speed) => ({
    name: `rotate-${speed}px`,
    frame: (k) => ({ translation: [0, 0], rotation: motionOffsetPx(k, speed), orbit: [0, 0] }),
  })),
  ...MOTION_SPEEDS_PX.map((speed) => ({
    name: `orbit-${speed}px`,
    frame: (k) => ({ translation: [0, 0], rotation: [0, 0], orbit: motionOffsetPx(k, speed) }),
  })),
];

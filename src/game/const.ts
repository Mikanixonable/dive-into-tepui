// ゲームバランス・チューニング定数
export { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../physics/orbital';

export const REENTRY_ALT = 80e3; // 機体はこれ以下で大気圏突入・焼失 [m]
export const DEBRIS_REENTRY_ALT = 95e3; // 弾・薬莢・破片の消滅高度 [m]

// エンジン出力 3 段階 [m/s^2]。[1]/[2]/[3] キーで切替、既定は中段(旧 THRUST_ACCEL 相当)。
export const THROTTLE_LEVELS = [1.4, 3.0, 6.0];
export const THROTTLE_DEFAULT_IDX = 1;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]
export const MAX_ANG_VEL = 1.6; // 手動回転の角速度上限 [rad/s]
export const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 微調整モード([V]キーでトグル): 角加速度・角速度上限を絞り、小刻みな姿勢調整を可能にする
export const FINE_ATTITUDE_SCALE = 0.16;

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]
export const ZOOM_FOV = 6; // [Z]キー長押し時の照準ズーム画角 [deg]
export const ZOOM_LERP_RATE = 9; // 画角遷移の追従速度 [1/s]

export const MUZZLE_SPEED = 800; // 機関砲初速 [m/s]
export const FIRE_INTERVAL = 0.14; // 発射間隔 [s]
export const BULLET_SPREAD = 0.002; // 散布界 [rad]
export const BULLET_LIFETIME = 240; // [sim s]
export const RECOIL_DV = 0.04; // 反動 [m/s]
export const SELF_HIT_GRACE = 2.0; // 自弾が自機に当たり得るまでの猶予 [sim s]

export const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;
export const MAX_DEBRIS = 160;

export const WARP_LEVELS = [1, 4, 16, 64, 256, 1024, 4096];
export const MAX_PHYS_WARP = 4; // 推進・射撃が可能な最大タイムワープ

export const PLAYER_RADIUS = 5; // 当たり判定 [m]
export const ENEMY_RADIUS = 9;

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 51.6; // 自機初期軌道傾斜角 [deg]

// ゲームバランス・チューニング定数
export { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../physics/orbital';

export const REENTRY_ALT = 80e3; // 敵機はこれ以下で大気圏突入・焼失 [m](熱モデルなしの簡易処理)
export const PLAYER_MIN_ALT = 45e3; // 自機の構造限界高度 [m](通常は加熱・動圧で先に喪失する)
export const DEBRIS_REENTRY_ALT = 95e3; // 弾・薬莢・破片の消滅高度 [m]

// --- 大気抵抗(弾道係数の逆数 Cd·A/m [m^2/kg]) ---
export const SHIP_BCINV = 3.3e-3; // 機体: Cd≈2.2, A≈12m², m≈8t
export const BULLET_BCINV = 2e-4; // 弾丸: 高弾道係数でほとんど減速しない
export const SMALL_DEBRIS_BCINV = 8e-3; // 薬莢・破片

// --- 空力加熱・構造限界(自機のみ) ---
export const SG_CONST = 1.7415e-4; // Sutton–Graves 定数(地球) [kg^0.5/m]
export const NOSE_RADIUS = 0.6; // 機首曲率半径 [m]
export const HEAT_ABSORB_AREA = 4; // よどみ点熱流束を受ける実効面積 [m^2]
export const RAD_AREA = 70; // 放射冷却面積 [m^2]
export const HULL_EMISS = 0.85; // 放射率
export const STEFAN_BOLTZMANN = 5.670374419e-8; // [W/m^2/K^4]
export const HEAT_CAPACITY = 1.5e6; // 外殻の熱容量 [J/K]
export const ENV_TEMP = 255; // 放射平衡の環境温度 [K]
export const HULL_START_TEMP = 273; // 初期機体温度 [K]
export const MAX_HULL_TEMP = 1300; // 超過で熱防御飽和 → 機体喪失 [K]
export const MAX_DYN_PRESSURE = 35e3; // 超過で空力破壊 [Pa]

// --- 地球の影 ---
export const SHADOW_PENUMBRA = 6e4; // 影の縁のぼかし幅 [m]
export const SUN_INTENSITY = 2.2; // 太陽光の基準強度
export const AMBIENT_INTENSITY = 0.25; // 環境光の基準強度
export const SHADOW_MIN_SUN = 0.04; // 影の中に残す太陽光の割合(星明かり・地球照ぶん)
export const SHADOW_MIN_AMBIENT = 0.35; // 影の中に残す環境光の割合

// 並進推力(WSADQE の全 6 方向、前後左右上下を問わず共通)出力 3 段階 [m/s^2]。
// [1]/[2]/[3] キーで切替。並進とエンジンは統合されており、方向キーが押されて
// いる間だけ、選択中の段の加速度がその方向へ出る(常時噴射のカットオフ段はない)。
export const THROTTLE_LEVELS = [5.0, 10.0, 15.0];
export const THROTTLE_DEFAULT_IDX = 0;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]
export const MAX_ANG_VEL = 1.6; // 手動回転の角速度上限 [rad/s]
export const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 微調整モード([V]キーでトグル): 角加速度・角速度上限を絞り、小刻みな姿勢調整を可能にする
export const FINE_ATTITUDE_SCALE = 0.032;

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]
export const ZOOM_FOV = 6; // [Z]キー長押し時の照準ズーム画角 [deg]
export const ZOOM_LERP_RATE = 9; // 画角遷移の追従速度 [1/s]
export const ZOOM_MUZZLE_FLASH_SCALE = 0.02; // ズーム中のマズルフラッシュ最大不透明度倍率(完全には消さない)

// キーボードでの視点回転(矢印キー)[rad/s]。マウスドラッグと同じ感覚になるよう
// yaw は 0.005 rad/px 換算に合わせた速度を割り当てる。
export const CAM_KEY_YAW_RATE = 1.4;
export const CAM_KEY_PITCH_RATE = 1.0;

// 進行方向ホールド([C]キー): 機首をプログレードへ向けるオートパイロットの PD ゲイン
export const PROGRADE_HOLD_KP = 3.2; // 姿勢誤差角に対する比例ゲイン
export const PROGRADE_HOLD_KD = 2.6; // 角速度に対する減衰ゲイン

export const MUZZLE_SPEED = 800; // 機関砲初速 [m/s]
export const FIRE_INTERVAL = 0.112; // 発射間隔 [s]
export const SPINUP_TIME = 0.3; // 発射開始から実際に撃ち始めるまでの起動遅延 [s]
export const BULLET_SPREAD = 0.002; // 散布界 [rad]
export const BULLET_LIFETIME = 240; // [sim s]
export const RECOIL_DV = 0.04; // 反動 [m/s]
export const SELF_HIT_GRACE = 2.0; // 自弾が自機に当たり得るまでの猶予 [sim s]

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
// 最新の 1 点のみ表示する(複数出ると照準の目安として紛らわしいため)。
export const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
export const MAX_BOARD_MARKS = 1;
export const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

// --- 弾薬・マガジン ---
// マガジンの厚みを倍にしたぶん装弾数も倍(32発)にしたので、同程度の総弾薬量を
// 半分程度のマガジン数(=物理的に短いチェーン)で賄える。
export const MAG_ROUNDS = 32; // 1 マガジンの装弾数
export const INITIAL_MAGS = 12; // ゲーム開始時に連結されているマガジン数
export const MAG_PICKUP_MAGS = 4; // 補給 1 個の取り込みで増えるマガジン数
export const MAG_PICKUP_RADIUS = 60; // 取り込み距離 [m](ゲームプレイ上の吸収判定。物理サイズではない)
export const MAG_PICKUP_PHYS_RADIUS = 1.3; // 補給マガジン束の物理接触用の半径 [m](見た目に近い実寸)
export const AMMO_LOW_MAGS = 3; // 残りマガジンがこれ未満になると付近の軌道に補給を投入
export const MAX_MAG_PICKUPS = 2; // 同時に存在する補給の最大数
export const RESUPPLY_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
export const BELT_MAX_VISIBLE = 12; // ベルト描画の最大リンク数
export const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]
export const EJECTED_MAG_MASS = 20; // 同、物理接触用の質量(実質量ではなくゲーム内衝突用の値)

// マガジンチェーンの可動域: 機関銃のベルトと同様、接合部の折れ曲がり(隣接リンクの
// 進行方向の変化=ピッチ/ヨー方向)は距離拘束のみで自由に許容するが、チェーン軸まわりの
// ロール(ねじれ)は角度上限で制限し、暴れた見た目にならないようにする。
export const MAG_CHAIN_MAX_ROLL_DEG = 35;
export const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
export const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]
// 各リンクを前後2点の中点(または根本側は固定方向の延長点)へわずかに
// 引き寄せる、曲げ剛性の簡易近似(かすかな直線復元力)。外力が止むと
// ゆっくりまっすぐに戻る。距離拘束の反復1回あたりの引き寄せ割合(0..1)。
export const MAG_CHAIN_STRAIGHTEN = 0.03; // 根本(2本目)での基準の強さ
// 根本から1本離れるごとにこの倍率で弱くなる(0..1、実際の梁のように
// 固定端に近いほど強く、先端に近いほど自由に揺れる)。
export const MAG_CHAIN_STRAIGHTEN_FALLOFF = 0.8;

export const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;
export const MAX_DEBRIS = 160;

export const WARP_LEVELS = [1, 4, 16, 64, 256, 1024, 4096];
export const MAX_PHYS_WARP = 4; // 推進・射撃が可能な最大タイムワープ

export const PLAYER_RADIUS = 5; // 被弾(弾丸ヒット)判定 [m]。実機体より大きめの当たり判定
export const PLAYER_HULL_RADIUS = 2.6; // 薬莢・破片等との物理接触に使う実寸に近い半径 [m]。
// PLAYER_RADIUS(被弾判定、余裕を持たせた大きめの値)をそのまま物理接触に使うと、
// 砲口(機体中心から距離約2.9m)で生まれた薬莢が生成直後に弾き飛ばされてしまう。
export const ENEMY_RADIUS = 90; // 視認性を高めるため従来比 10 倍の大型機体
export const ENEMY_SCALE = 10; // buildEnemyShip() の見た目メッシュに掛けるスケール

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 51.6; // 自機初期軌道傾斜角 [deg]

// --- 軌道計画モード([M]) ---
export const MAP_MIN_DIST = 9e6; // マップカメラ距離 [m]
export const MAP_MAX_DIST = 2.6e8;
export const NODE_DV_RATE = 30; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 2.5; // 微調整モード時
export const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]
export const NODE_MIN_DV = 0.5; // これ未満のノードは確定時に破棄 [m/s]
// マニューバ達成判定(計画軌道への接近許容)
export const NODE_TOL_SMA = 0.02; // 長半径の相対誤差
export const NODE_TOL_ECC = 0.02; // 離心率差
export const NODE_TOL_PLANE_DEG = 2.0; // 軌道面の角度差 [deg]
// [N] 自動ワープ: 残り時間 / MARGIN 以下の最大ワープを選び、STOP 秒前に解除
export const AUTOWARP_MARGIN = 15;
export const AUTOWARP_STOP = 20;

export const STAGE1_CLEARED_KEY = 'tepui.stage1.cleared'; // localStorage キー

// --- 第零ステージ(近接戦闘訓練): RCS・並進操作に慣れるためのアーケード的
// スコアアタック。色分けされた集団が自機周囲 5km 以内に密集し、制限時間内の
// 撃墜数を競う。いつでも選択可能(解放条件なし)。---
export const STAGE0_GROUP_ACCENTS = [0xff4a3d, 0x3dc6ff, 0x3dff8f, 0xffe23d, 0xbf3dff]; // 赤/青/緑/黄/紫
export const STAGE0_GROUP_LABELS = ['RED', 'BLUE', 'GREEN', 'AMBER', 'VIOLET'];
export const STAGE0_PER_GROUP = 10; // グループあたりの機数(総計 STAGE0_GROUP_ACCENTS.length 倍)
export const STAGE0_ENEMY_HP = 1; // 一撃撃破の軽量機(操作練習向けにテンポ重視)
export const STAGE0_MAX_RANGE = 5000; // 自機からの配置半径の上限 [m]
export const STAGE0_TIME_LIMIT = 300; // 制限時間 [実秒]
export const STAGE0_AMMO_PICKUPS = 4; // 開始時に浮かべておく補給マガジンの数
export const STAGE0_AMMO_MIN_DIST = 300; // 補給の配置距離 [m](自機から)
export const STAGE0_AMMO_MAX_DIST = 900;

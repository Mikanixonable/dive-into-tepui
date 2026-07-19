// ゲームバランス・チューニング定数
export { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../physics/orbital';

export const REENTRY_ALT = 80e3; // 敵機はこれ以下で大気圏突入・焼失 [m](熱モデルなしの簡易処理)
export const PLAYER_MIN_ALT = 45e3; // 自機の構造限界高度 [m](通常は加熱・動圧で先に喪失する)
export const DEBRIS_REENTRY_ALT = 95e3; // 弾・薬莢・破片の消滅高度 [m]

// 高度低下警告のしきい値(降順)。EMA 高度がこれを下回るたびに一度だけ警告する [m]
export const ALT_WARN_THRESHOLDS = [120e3, 100e3, 80e3];

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
export const HULL_TEMP_FLOOR = 120; // 放射冷却で下がりきる機体温度の下限 [K]

// --- 高度低下警告(EMA平滑化) ---
export const ALT_EMA_TIME_CONST = 3; // 高度・降下率EMAの時定数 [s]
export const ALT_DESCEND_WARN_RATE = -3; // この降下率(EMA)を下回ると警告 [m/s]
export const ALT_DESCEND_CLEAR_RATE = -1; // この降下率(EMA)まで戻ると警告解除 [m/s]
export const ALT_WARN_HYSTERESIS = 5e3; // しきい値の再警告までのヒステリシス幅 [m]

// --- 地球の影 ---
export const SHADOW_PENUMBRA = 6e4; // 影の縁のぼかし幅 [m]
export const SUN_INTENSITY = 2.2; // 太陽光の基準強度
export const AMBIENT_INTENSITY = 0.25; // 環境光の基準強度
export const SHADOW_MIN_SUN = 0.04; // 影の中に残す太陽光の割合(星明かり・地球照ぶん)
export const SHADOW_MIN_AMBIENT = 0.35; // 影の中に残す環境光の割合

// 並進推力(WSADQE の全 6 方向、前後左右上下を問わず共通)出力 3 段階 [m/s^2]。
// [1]/[2]/[3] キーで切替。並進とエンジンは統合されており、方向キーが押されて
// いる間だけ、選択中の段の加速度がその方向へ出る(常時噴射のカットオフ段はない)。
export const THROTTLE_LEVELS = [5.0, 20.0, 100.0];//エンジン出力、スロットル
export const THROTTLE_DEFAULT_IDX = 1;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]
export const MAX_ANG_VEL = 1.6; // 手動回転の角速度上限 [rad/s]
export const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 手動回転RCSの出力ランプ: 長押し開始時は RCS_MANUAL_OUTPUT_MIN、
// RCS_MANUAL_RAMP_TIME 秒かけて (MIN + RAMP) まで段階的に増加する
export const RCS_MANUAL_OUTPUT_MIN = 0.3;
export const RCS_MANUAL_OUTPUT_RAMP = 1.0;
export const RCS_MANUAL_RAMP_TIME = 3.0; // [s]
export const RCS_DAMP_PUFF_EPS = 0.04; // RCS制動パフ/音を出す角速度しきい値 [rad/s]

// 微調整モード([V]キーでトグル、射撃中は自動でON): 角加速度・角速度上限を絞り、
// 通常時の半分の出力で小刻みな姿勢調整を可能にする
export const FINE_ATTITUDE_SCALE = 0.5;

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

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]
export const FIRE_INTERVAL = 0.06; // 発射間隔 [s] 
export const SPINUP_TIME = 0.15; // 発射開始から実際に撃ち始めるまでの起動遅延 [s] (元の0.3の半分)
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
export const INITIAL_MAGS = 3; // ゲーム開始時に連結されているマガジン数
export const MAG_PICKUP_MAGS = 4; // 補給 1 個の取り込みで増えるマガジン数
export const MAG_PICKUP_RADIUS = 100; // 取り込み距離 [m](ゲームプレイ上の吸収判定。物理サイズではない)
export const MAG_PICKUP_PHYS_RADIUS = 1.3; // 補給マガジン束の物理接触用の半径 [m](見た目に近い実寸)
export const AMMO_LOW_MAGS = 7; // 残りマガジンがこれ未満になると付近の軌道に補給を投入(5以下で発動)
export const MAX_MAG_PICKUPS = 3; // 同時に存在する補給の最大数
export const RESUPPLY_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
export const AMMO_RESUPPLY_MIN_DIST = 1250; // 補給投入位置(自機軌道上の位相シフト距離)下限 [m]
export const AMMO_RESUPPLY_MAX_DIST = 2500; // 同上限 [m]
export const AMMO_DESPAWN_DIST = 50000; // これ以上自機から離れた補給マガジンをデスポーンさせる距離 [m]
export const TARGET_LOCK_PICK_PX_SQ = 600; // 右クリックによるターゲット固定のヒット判定半径の2乗 [px^2](~24px半径)
export const RELOAD_TIME = 1.0; // 手動/自動リロード(バレル交換)のクールダウン [s](元の3.0の半分)
export const BELT_MAX_VISIBLE = 18; // ベルト描画の最大リンク数
export const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]
export const EJECTED_MAG_MASS = 20; // 同、物理接触用の質量(実質量ではなくゲーム内衝突用の値)

// マガジンチェーンの可動域: 各つなぎ目(リンク間接合部)で許容する最大折れ角。
// ロール(チェーン軸まわりのねじれ)・ピッチ(上下方向の折れ)・ヨー(左右方向の折れ)
// をそれぞれ独立に制限する。いずれも隣接リンク間の相対角度 [deg]。
export const MAG_CHAIN_MAX_ROLL_DEG = 15;  // ロール上限
export const MAG_CHAIN_MAX_PITCH_DEG = 30; // ピッチ上限(上下方向の折れ)
export const MAG_CHAIN_MAX_YAW_DEG = 10;   // ヨー上限(左右方向の折れ)
export const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
export const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]
// 各リンクを前後2点の中点(または根本側は固定方向の延長点)へわずかに
// 引き寄せる、曲げ剛性の簡易近似(かすかな直線復元力)。外力が止むと
export const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;
export const MAX_DEBRIS = 160;
export const DEBRIS_SIZE_MIN = 1.5; // 撃破デブリの破片サイズ下限
export const DEBRIS_SIZE_MAX = 6.0; // 撃破デブリの破片サイズ上限
export const CASING_CLANK_COOLDOWN = 0.07; // 薬莢-機体接触音のレート制限 [実 s]

// --- 被弾・撃破エフェクト(フラッシュ/破片) ---
export const BULLET_HIT_FLASH_SIZE0 = 1.5;
export const BULLET_HIT_FLASH_SIZE1 = 6;
export const BULLET_HIT_FLASH_DURATION = 0.25; // [s]
export const PLASMA_HIT_FLASH_SIZE0 = 2;
export const PLASMA_HIT_FLASH_SIZE1 = 8;
export const PLASMA_HIT_FLASH_DURATION = 0.3; // [s]
export const HIT_FRAG_COUNT = 3; // 被弾時に飛散させる欠片の数
export const HIT_FRAG_SIZE_MIN = 0.18;
export const HIT_FRAG_SIZE_MAX = 0.5;
export const HIT_FRAG_SPEED = 5.5; // [m/s]
export const DESTROY_FLASH1_SIZE0 = 10; // 撃破時フラッシュ(芯)のサイズ下限。ENEMY_SCALE 倍される
export const DESTROY_FLASH1_SIZE1 = 110;
export const DESTROY_FLASH1_DURATION = 1.1; // [s]
export const DESTROY_FLASH2_SIZE0 = 6; // 撃破時フラッシュ(外殻)のサイズ下限
export const DESTROY_FLASH2_SIZE1 = 40;
export const DESTROY_FLASH2_DURATION = 0.5; // [s]

export const WARP_LEVELS = [1, 4, 16, 64, 256, 1024, 4096];
export const MAX_PHYS_WARP = 4; // 推進・射撃が可能な最大タイムワープ

export const PLAYER_RADIUS = 5; // 被弾(弾丸ヒット)判定 [m]。実機体より大きめの当たり判定
export const PLAYER_HULL_RADIUS = 2.6; // 薬莢・破片等との物理接触に使う実寸に近い半径 [m]。
// PLAYER_RADIUS(被弾判定、余裕を持たせた大きめの値)をそのまま物理接触に使うと、
// 砲口(機体中心から距離約2.9m)で生まれた薬莢が生成直後に弾き飛ばされてしまう。
export const ENEMY_RADIUS = 180; // 視認性を高めるため従来比 10 倍の大型機体、さらに2倍
export const ENEMY_SCALE = 20; // buildEnemyShip() の見た目メッシュに掛けるスケール

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 97.0; // 自機初期軌道傾斜角 [deg]

// --- 軌道計画モード([M]) ---
export const MAP_MIN_DIST = 9e6; // マップカメラ距離 [m]
// 月軌道(平均距離 3.844e8m)全体+マージンが収まるまでカメラを引けるようにする
// 太陽地球系のラグランジュ点 L1/L2 (約1.5e9m) が視界に収まるように上限を拡大。
export const MAP_MAX_DIST = 4.5e9;
export const MAP_CAMERA_FAR = 1.5e10; // マップカメラの far(MAP_MAX_DIST + 十分な余裕)
export const NODE_DV_RATE = 30; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 2.5; // 微調整モード時
export const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]
export const MAP_LABEL_PICK_PX = 20; // マップラベル(ラグランジュ点等)のクリック判定許容距離 [px]
// 戦闘ビューのBURNガイド軌道: 直近ノードの実行時刻の少し先まで予測を描く。
// 最短でも NODE_GUIDE_MIN_DURATION 秒ぶん、ノード時刻より NODE_GUIDE_DURATION_MARGIN 秒先まで
export const NODE_GUIDE_MIN_DURATION = 60; // [s]
export const NODE_GUIDE_DURATION_MARGIN = 120; // [s]
export const NODE_MIN_DV = 0.5; // これ未満のノードは軌道計画モードを抜けるときに破棄 [m/s]
export const MAX_PLAN_NODE_MARKERS = 12; // 画面上に表示するノードマーカーの上限(HUD要素数の上限)
// マップモードの DOM ギズモ(mapgizmo.ts): 選択中ノードの Δv アーム(6方向ハンドル)
export const NODE_GIZMO_HANDLE_PX = 42; // ノードからアームハンドルを離す距離 [px]
export const NODE_GIZMO_DRAG_THRESHOLD_PX = 4; // ノードハンドルのクリック/ドラッグ判定しきい値 [px]
// ノード実行目標の凍結しきい値 [s]: 残り時間がこれを切ったらバーン目標
// (実行後の目標速度・目標軌道要素)を固定し、以降の予測リフレッシュでは
// 更新しない。目標を毎回「現在状態+全Δv」で再計算すると、噴射するほど
// 目標が先へ逃げていく(残Δvが減らない)ため、実噴射前に凍結する必要がある。
export const NODE_TARGET_FREEZE_S = 30;
// マニューバ達成判定(計画軌道への接近許容)
export const NODE_TOL_SMA = 0.02; // 長半径の相対誤差
export const NODE_TOL_ECC = 0.02; // 離心率差
export const NODE_TOL_PLANE_DEG = 2.0; // 軌道面の角度差 [deg]

// --- 数値予測(軌道計画モードのポリライン、predict.ts) ---
export const PREDICT_DUR_DAY = 86400; // 1日
export const PREDICT_DUR_WEEK = 7 * 86400; // 7日
export const PREDICT_DUR_MONTH = 28 * 86400; // 28日
export const PREDICT_MAX_SAMPLES = 2000; // 保持する予測サンプル数の上限
// 予測の再計算頻度: ノード追加・削除・Δv変更・期間/系変更時は最短でこの間隔(高頻度キー
// 操作を約5Hzに間引く)、それ以外は変化がなくてもこの間隔ごとに再計算する(摂動により
// 「現在の軌道」自体がドリフトしていくため)。
export const PREDICT_DIRTY_THROTTLE_MS = 200;
export const PREDICT_REFRESH_INTERVAL_MS = 2000;
// [N] 自動ワープ: 残り時間 / MARGIN 以下の最大ワープを選び、STOP 秒前に解除。
// ワープ段は 4 倍刻み(1/4/16/64/256/1024/4096)なので、1 段降りるごとに
// 実時間で約 MARGIN×0.75 秒かかる計算になる。全体(最大ワープから解除まで)を
// 概ね20実秒以内に収めるよう、以前の15から大きく下げてある。
export const AUTOWARP_MARGIN = 4;
export const AUTOWARP_STOP = 20;

export const STAGE1_CLEARED_KEY = 'tepui.stage1.cleared'; // localStorage キー

// --- 第零ステージ(近接戦闘訓練) ---
export const STAGE0_GROUP_ACCENTS = [0xff4a3d, 0x3dc6ff, 0x3dff8f, 0xffe23d, 0xbf3dff]; // 赤/青/緑/黄/紫
export const STAGE0_GROUP_LABELS = ['RED', 'BLUE', 'GREEN', 'AMBER', 'VIOLET'];
export const STAGE0_PER_GROUP = 10; // グループあたりの機数
export const STAGE0_ENEMY_HP = 1; // 一撃撃破の軽量機
export const STAGE0_MAX_RANGE = 5000; // 自機からの配置半径の上限 [m]
export const STAGE0_TIME_LIMIT = 30000; // 制限時間 [実秒]
export const STAGE0_AMMO_PICKUPS = 4; // 開始時に浮かべておく補給マガジンの数
export const STAGE0_AMMO_MIN_DIST = 300; // 補給の配置距離 [m](自機から)
export const STAGE0_AMMO_MAX_DIST = 900;
// 5グループの配置: 各グループ中心を安全半径(STAGE0_MAX_RANGE * SAFE_RANGE_FACTOR)
// の CENTER_DIST_MIN〜+RANGE の位置に置き、各機はそこから ALONG/NORMAL/RADIAL
// 方向にランダムに散らす
export const STAGE0_SAFE_RANGE_FACTOR = 0.94; // マージンを残して確実に配置半径内に収める
export const STAGE0_GROUP_CENTER_DIST_MIN = 0.52; // 安全半径に対する比率
export const STAGE0_GROUP_CENTER_DIST_RANGE = 0.14;
export const STAGE0_GROUP_RADIAL_FACTOR = 0.1; // 動径方向のグループ中心ばらつき(安全半径比)
export const STAGE0_JITTER_ALONG = 500; // 各機の進行方向ばらつき [m]
export const STAGE0_JITTER_NORMAL = 500; // 各機の軌道面法線方向ばらつき [m]
export const STAGE0_JITTER_RADIAL = 350; // 各機の動径方向ばらつき [m]

// --- ステージ00(無限耐久サバイバル) ---
export const STAGE00_MAX_RANGE = 15000; // 自機からの配置半径の上限(デスポーン距離) [m]
export const STAGE00_AMMO_MIN_DIST = 50; // 補給の配置距離 [m](自機から)
export const STAGE00_AMMO_MAX_DIST = 200;
export const STAGE00_SPAWN_DELAY = 10; // 弾取得からスポーンまでの遅延 [s]
export const STAGE00_FORMATION_SPACING = 200; // 編隊の機体間隔 [m]
export const STAGE00_ALT_OFFSET_MIN = -1000; // 自機よりどれくらい低くするか [m]
export const STAGE00_ALT_OFFSET_MAX = -200;
export const STAGE00_SPAWN_INTERVAL = 30.0; // 波状攻撃の間隔 [s]
export const STAGE00_SPAWN_DIST_MIN = 10000; // 敵集団のスポーン距離(従来比2倍)
export const STAGE00_SPAWN_DIST_MAX = 14000;
export const STAGE00_FLYBY_SPEED = 200.0; // フライパスの相対速度 [m/s]
export const STAGE00_WAVE_BASE_SHIPS = 5; // 第1波の機数
export const STAGE00_WAVE_SHIPS_PER_WAVE = 2; // 波が進むごとに増える機数
export const STAGE00_PLACEMENT_JITTER = 1000; // 編隊配置の位置ばらつき [m]
export const STAGE00_FLYBY_MISS_DIST_MIN = 1000; // フライパスのすれ違い距離下限 [m]
export const STAGE00_FLYBY_MISS_DIST_RANGE = 1000; // 同、上限までの幅 [m]
export const STAGE00_FLYBY_SPEED_RAMP = 10; // 波が進むごとのフライパス速度増加 [m/s]
export const STAGE00_FLYBY_LATERAL_SPREAD = 20; // フライパス初速の横ブレ最大 [m/s]

export const PLAYER_MAX_HP = 1000;
export const HP_REGEN_RATE = 1; // HP自動回復速度 [HP/s]
export const PLAYER_HIT_DAMAGE = 1.25; // 自機が被弾(自弾・プラズマ弾とも)した際のダメージ [HP]
export const ENEMY_HIT_DAMAGE = 1; // 敵機が被弾した際のダメージ [HP]
export const PLASMA_BULLET_SPEED = 800 * 2 / 3; // MUZZLE_SPEED の約 2/3
export const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
export const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s] (3倍に増加)
export const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
export const ENEMY_AI_MIN_RANGE = 50; // これより近いと射撃しない(至近距離) [m]
export const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 同一集団内で同時に攻撃する最大機数
export const ENEMY_ATTACK_CHANCE = 0.6; // 各機が攻撃(バースト)を開始する確率
export const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト射撃弾数の候補
export const PLASMA_SPREAD_DEG = 0.05; // プラズマ弾の散布角 [deg]

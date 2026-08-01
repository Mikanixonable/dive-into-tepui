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

// 並進推力(WSADQE の全 6 方向で共通)の出力 3 段階 [m/s^2]。[1]/[2]/[3] キーで切替、
// 方向キーが押されている間だけ選択中の段の加速度がその方向へ出る。
export const THROTTLE_LEVELS = [5.0, 20.0, 100.0];//エンジン出力、スロットル
export const THROTTLE_DEFAULT_IDX = 1;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]
export const MAX_ANG_VEL = 1.6; // 手動回転の角速度上限 [rad/s]
export const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 手動回転RCSの出力ランプ: 押し始めは MIN、RAMP_TIME 秒かけて (MIN + RAMP) まで増加する
export const RCS_MANUAL_OUTPUT_MIN = 0.3;
export const RCS_MANUAL_OUTPUT_RAMP = 1.0;
export const RCS_MANUAL_RAMP_TIME = 3.0; // [s]
export const RCS_PUFF_TORQUE_EPS = 0.15; // RCSパフを表示する実トルクしきい値 [rad/s^2](inertia=1前提)

// 微調整モード([V]キーでトグル、射撃中は自動でON)で角加速度・角速度上限に掛ける倍率
export const FINE_ATTITUDE_SCALE = 0.5;

// 戦闘視点カメラの near/far [m]。near は LEO 高度からの地平線距離(~2,400km)での深度誤差が
// 十分小さく、対数深度バッファなしで z-fighting を避けられる値。far は星空シェル・
// 太陽ビルボード・月表示距離を余裕を持って内側に収める。
export const COMBAT_CAMERA_NEAR = 2;
export const COMBAT_CAMERA_FAR = 6e7;

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]
export const ZOOM_FOV = 6; // [Z]キー長押し時の照準ズーム画角 [deg]
export const ZOOM_LERP_RATE = 9; // 画角遷移の追従速度 [1/s]
export const ZOOM_MUZZLE_FLASH_SCALE = 0.02; // ズーム中のマズルフラッシュ最大不透明度倍率(完全には消さない)

// キーボードでの視点回転(矢印キー)[rad/s]。マウスドラッグと同じ感覚になる値。
export const CAM_KEY_YAW_RATE = 1.4;
export const CAM_KEY_PITCH_RATE = 1.0;
export const CAM_DRAG_ROTATE_RATE = 0.005; // マウスドラッグ [rad/px]

// 進行方向ホールド([C]キー): 機首をプログレードへ向けるオートパイロットの PD ゲイン
export const PROGRADE_HOLD_KP = 3.2; // 姿勢誤差角に対する比例ゲイン
export const PROGRADE_HOLD_KD = 2.6; // 角速度に対する減衰ゲイン

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]
export const FIRE_INTERVAL = 0.06; // 発射間隔 [s] 
export const SPINUP_TIME = 0.15; // 発射開始から実際に撃ち始めるまでの起動遅延 [s]
export const BULLET_SPREAD = 0.002; // 散布界 [rad]
// 弾の消滅は距離が主、寿命は保険。弾は1発ずつ独立したドローコールなので生存数が描画コストへ
// 直結する。自機の目の前で消えないよう、交戦圏 STAGE00_MAX_RANGE と同じ距離を採る。
export const BULLET_MAX_DIST = 30e3; // 自機からこれ以上離れた弾を消す [m]
export const BULLET_LIFETIME = 240; // 保険としての寿命 [sim s]
export const RECOIL_DV = 0.04; // 反動 [m/s]
export const SELF_HIT_GRACE = 2.0; // 自弾が自機に当たり得るまでの猶予 [sim s]

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
// 最新の 1 点のみ表示する(複数出ると照準の目安として紛らわしいため)。
export const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
export const MAX_BOARD_MARKS = 1;
export const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

// --- 弾薬・マガジン ---
export const MAG_ROUNDS = 32; // 1 マガジンの装弾数
export const INITIAL_MAGS = 3; // ゲーム開始時に連結されているマガジン数
export const AMMO_PICKUP_MAGS = 6; // 補給 1 個の取り込みで増えるマガジン数
export const AMMO_PICKUP_RADIUS = 100; // 取り込み距離 [m](ゲームプレイ上の吸収判定。物理サイズではない)
export const AMMO_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m](見た目に近い実寸)
export const LOGISTICS_LOW_MAGS = 7; // 残りマガジンがこれ未満になると付近の軌道に補給を投入
export const MAX_AMMO = 3; // 同時に存在する補給の最大数
export const LOGISTICS_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
export const LOGISTICS_MIN_DIST = 625; // 補給投入位置(自機軌道上の位相シフト距離)下限 [m]
export const LOGISTICS_MAX_DIST = 1250; // 同上限 [m]
export const LOGISTICS_DESPAWN_DIST = 50000; // これ以上自機から離れた補給マガジンをデスポーンさせる距離 [m]
export const TARGET_LOCK_PICK_PX_SQ = 600; // 右クリックによるターゲット固定のヒット判定半径の2乗 [px^2](~24px半径)
export const RELOAD_TIME = 1.0; // 手動/自動リロード(バレル交換)のクールダウン [s]
export const MAGS_PER_BARREL = 3; // バレル交換までに消費できるマガジン数
export const BELT_MAX_VISIBLE = 18; // ベルト描画の最大リンク数
export const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]
export const BARREL_MASS = 20; // バレルの物理接触用の質量(実質量ではなくゲーム内衝突用の値)
export const MAGAZINE_FRAME_MASS = 20; // 空マガジンの物理接触用の質量(同上)

// マガジンチェーン(ベルト)の可動域: 各つなぎ目で許容する最大折れ角。ロール・ピッチ・ヨーを
// それぞれ独立に制限する。いずれも隣接リンク間の相対角度 [deg]。
export const MAG_CHAIN_MAX_ROLL_DEG = 15;  // ロール上限
export const MAG_CHAIN_MAX_PITCH_DEG = 45; // ピッチ上限(上下方向の折れ)
export const MAG_CHAIN_MAX_YAW_DEG = 15;   // ヨー上限(左右方向の折れ)
export const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
export const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]
export const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
export const CASING_MASS = 1; // 薬莢の物理接触用の質量(実物同様に軽い)
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;
export const MAX_DEBRIS = 160;

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
export const DESTROY_FRAG_SIZE_MIN = 1.5; // 撃破デブリの破片サイズ下限。ENEMY_SCALE 倍される
export const DESTROY_FRAG_SIZE_MAX = 6.0;

export const SIM_SPEED_LEVELS = [1, 4, 16, 64, 256, 1024, 4096];
export const MAX_PHYS_SIM_SPEED = 4; // 推進・射撃・衝突解決・敵AIが有効な最大タイムワープ(SimSpeedManager の can* が参照)

export const SUBSTEP_MAX_DT = 20; // 1サブステップの最大秒数 [s](Simulator.stepSimulation のサブステップ分割数の算出に使う)
export const SUBSTEP_MAX_COUNT = 64; // 1フレームあたりのサブステップ数上限(高倍率ワープ時に計算量が爆発しないための歯止め)

export const PLAYER_RADIUS = 5; // 被弾(弾丸ヒット)判定 [m]。実機体より大きめの当たり判定
export const PLAYER_HULL_RADIUS = 2.6; // 薬莢・破片等との物理接触に使う実寸に近い半径 [m]。
// PLAYER_RADIUS(被弾判定、余裕を持たせた大きめの値)をそのまま物理接触に使うと、
// 砲口(機体中心から距離約2.9m)で生まれた薬莢が生成直後に弾き飛ばされてしまう。
export const ENEMY_RADIUS = 180; // 視認性のため実機体よりかなり大きい当たり判定
export const ENEMY_SCALE = 20; // buildEnemyShip() の見た目メッシュに掛けるスケール
export const ENEMY_ORBIT_LINE_COLOR = 0x565b63; // 敵軌道線の既定色(個体色 accent とは独立)

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 97.0; // 自機初期軌道傾斜角 [deg]

// --- HUD マーカー ---
export const MARKER_DIR_DIST = 5e4; // 方向マーカーを投影する仮想距離 [m](実在の位置ではなく方向のみを示す)
export const MARKER_CLUSTER_PX = 40; // これより画面上で近いマーカー同士は1つの代表にまとめる [px]
// 画面外の対象を指す方位マーカーを置く円の半径(画面短辺の半分に対する比)
export const MARKER_BEARING_RING_RATIO = 0.8;
export const LEAD_HOLD_SEC = 20; // ターゲットを外した後も LEAD マーカーを出し続ける時間 [s]
export const LEAD_MAX_TIME = 25; // これより先にしか当たらない見越し解は表示しない [s]

// --- 軌道計画モード([M]) ---
export const OVERVIEW_CAMERA_MIN_DIST = 9e6; // 広範囲視点カメラの注視点までの距離 [m]
// 太陽地球系のラグランジュ点 L1/L2(約1.5e9m)まで視界に収められる引きの上限。
export const OVERVIEW_CAMERA_MAX_DIST = 4.5e9;
export const OVERVIEW_CAMERA_FAR = 1.5e10; // 広範囲視点カメラの far(OVERVIEW_CAMERA_MAX_DIST + 十分な余裕)
export const NODE_DV_RATE = 300; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 30; // 微調整モード時
export const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]
export const FOCUS_LABEL_PICK_PX = 20; // 注視候補ラベル(ラグランジュ点等)のクリック判定許容距離 [px]
export const NODE_MIN_DV = 0.5; // これ未満のノードは軌道計画モードを抜けるときに破棄 [m/s]
export const MAX_PLAN_NODE_MARKERS = 12; // 画面上に表示するノードマーカーの上限(HUD要素数の上限)
// マップモードの DOM ギズモ(node-gizmo.ts): 選択中ノードの Δv アーム(6方向ハンドル)
export const NODE_GIZMO_HANDLE_PX = 42; // ノードからアームハンドルを離す距離 [px]
export const NODE_GIZMO_DRAG_THRESHOLD_PX = 4; // ノードハンドルのクリック/ドラッグ判定しきい値 [px]
// マニューバ達成判定(計画軌道への接近許容)
export const NODE_TOL_SMA = 0.02; // 長半径の相対誤差
export const NODE_TOL_ECC = 0.02; // 離心率差
export const NODE_TOL_PLANE_DEG = 2.0; // 軌道面の角度差 [deg]

// --- 数値予測(軌道計画モードのポリライン、plan/plan-arc.ts) ---
export const PREDICT_DUR_DAY = 86400; // 1日
export const PREDICT_DUR_WEEK = 7 * 86400; // 7日
export const PREDICT_DUR_MONTH = 28 * 86400; // 28日
export const PREDICT_MAX_SAMPLES = 2000; // 保持する予測サンプル数の上限
// 予測軌道を再計算する最短間隔。編集操作は高頻度なのでここまで間引く(約5Hz)。
export const PREDICT_DIRTY_THROTTLE_MS = 200;
// 周期を持たない軌道(双曲線・放物線)で、末尾区間を伸ばす長さ [s]。
export const APERIODIC_ARC_DURATION = PREDICT_DUR_DAY;

// --- エンティティの過去・未来状態列(physics/orbit-entity.ts の OrbitEntity.history/Predictor) ---
export const PREDICT_SAMPLES_PER_REV = 32; // 1周回あたりの保持サンプル数(補間誤差 30m 程度に収まる実測値)
export const SHIP_HISTORY_DURATION = 5580; // Ship の過去列の保持時間 [s]。LEO(420km)の公転周期に近似
export const PREDICT_DURATION = 3 * 3600; // 予測する未来の長さ [s](LEO で約2周回)
export const PREDICT_STEP_BUDGET = 500; // Predictor が1フレームに配る予測ステップ数の上限
export const PREDICT_MIN_STEP_DT = SUBSTEP_MAX_DT; // 予測刻みの下限(本体シミュレーションより細かくする理由がないため同じ値)
export const PREDICT_RESET_DIST = 500; // 予測位置と実位置がこれを超えて乖離したら予測列を破棄 [m](補間誤差 30m より十分大きい)
// [N] 自動ワープ: 残り時間 / MARGIN 以下の最大シミュレーション速度を選び、STOP 秒前に解除。
// 最大速度から解除までが概ね20実秒に収まる値。
export const AUTOWARP_MARGIN = 4;
export const AUTOWARP_STOP = 20;

// --- 第零ステージ(近接戦闘訓練) ---
export const STAGE0_GROUP_ACCENTS = [0xff4a3d, 0x3dc6ff, 0x3dff8f, 0xffe23d, 0xbf3dff]; // 赤/青/緑/黄/紫
export const STAGE0_GROUP_LABELS = ['RED', 'BLUE', 'GREEN', 'AMBER', 'VIOLET'];
export const STAGE0_PER_GROUP = 10; // グループあたりの機数
export const STAGE0_ENEMY_HP = 1; // 一撃撃破の軽量機
export const STAGE0_MAX_RANGE = 5000; // 自機からの配置半径の上限 [m]
// 制限時間 [実秒]。選択画面の説明(stage0.ts の selectSub)とブリーフィングはこの値から
// 生成されるので、変更すればどちらも自動的に追随する。
export const STAGE0_TIME_LIMIT = 120;
export const STAGE0_LOGISTICS_INITIAL_AMMO = 4; // 開始時に浮かべておく補給の数
export const STAGE0_LOGISTICS_MIN_DIST = 150; // 補給の配置距離 [m](自機から)
export const STAGE0_LOGISTICS_MAX_DIST = 450;
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
export const STAGE00_MAX_RANGE = 30000; // 自機からの配置半径の上限(デスポーン距離) [m]
export const STAGE00_LOGISTICS_MIN_DIST = 25; // 補給の配置距離 [m](自機から)
export const STAGE00_LOGISTICS_MAX_DIST = 100;
export const STAGE00_SPAWN_DELAY = 10; // 弾取得からスポーンまでの遅延 [s]
export const STAGE00_FORMATION_SPACING = 200; // 編隊の機体間隔 [m]
export const STAGE00_ALT_OFFSET_MIN = -1000; // 自機よりどれくらい低くするか [m]
export const STAGE00_ALT_OFFSET_MAX = -200;
export const STAGE00_SPAWN_INTERVAL = 30.0; // 波状攻撃の間隔 [s]
export const STAGE00_SPAWN_DIST_MIN = 10000; // 敵集団のスポーン距離
export const STAGE00_SPAWN_DIST_MAX = 14000;
export const STAGE00_FLYBY_SPEED = 200.0; // フライパスの相対速度 [m/s]
export const STAGE00_WAVE_BASE_SHIPS = 5; // 第1波の機数
export const STAGE00_WAVE_SHIPS_PER_WAVE = 2; // 波が進むごとに増える機数
export const STAGE00_WAVE_MAX_SHIPS = 30; // 1ウェーブの最大機数上限
export const STAGE00_PLACEMENT_JITTER = 1000; // 編隊配置の位置ばらつき [m]
export const STAGE00_FLYBY_MISS_DIST_MIN = 1000; // フライパスのすれ違い距離下限 [m]
export const STAGE00_FLYBY_MISS_DIST_RANGE = 1000; // 同、上限までの幅 [m]
export const STAGE00_FLYBY_SPEED_RAMP = 10; // 波が進むごとのフライパス速度増加 [m/s]
// フライパス速度の上限 [m/s]。ステージ00は無限に続き波数に上限がないため、これが無いと
// 相対速度が際限なく上がり、フライパスの Δv だけで敵の軌道が壊れる(近地点が地中に落ちる)。
// 400 m/s なら 30km の交戦圏を約75秒で通過する — 演出として十分速く、軌道も壊れない。
export const STAGE00_FLYBY_SPEED_MAX = 400.0;
// 敵の軌道が保つべき近地点高度の余裕 [m](大気圏突入高度 REENTRY_ALT に加算する)。
// スポーン時の Δv はこの高度を割らない範囲まで縮められる(stage00.ts の limitFlybyDv)。
export const STAGE00_MIN_PERIGEE_MARGIN = 40e3;
export const STAGE00_FLYBY_LATERAL_SPREAD = 20; // フライパス初速の横ブレ最大 [m/s]

export const PLAYER_MAX_HP = 1000;
export const HP_REGEN_RATE = 1; // HP自動回復速度 [HP/s]
export const PLAYER_HIT_DAMAGE = 1.25; // 自機が被弾(自弾・プラズマ弾とも)した際のダメージ [HP]
export const ENEMY_HIT_DAMAGE = 1; // 敵機が被弾した際のダメージ [HP]
export const PLASMA_BULLET_SPEED = MUZZLE_SPEED * 2 / 3; // MUZZLE_SPEED の 2/3
export const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
export const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
export const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
export const ENEMY_AI_MIN_RANGE = 50; // これより近いと射撃しない(至近距離) [m]
export const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 同一集団内で同時に攻撃する最大機数
export const ENEMY_ATTACK_CHANCE = 0.6; // 各機が攻撃(バースト)を開始する確率
export const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト射撃弾数の候補
export const PLASMA_SPREAD_DEG = 0.05; // プラズマ弾の散布角 [deg]

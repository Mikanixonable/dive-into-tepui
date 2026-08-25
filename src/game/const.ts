// ゲームバランス・チューニング定数
import { LINE_RENDER_ORDER, type LineStyle } from '../render/line-style';
import { v3 } from '../physics/vec3';
export { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../physics/solar-system';

// 軌道上へ配置できる自機の上限隻数。
export const MAX_PLACED_SHIPS = 50;

// --- 基地ドッキング ---
export const BASE_MAX_VESSELS = 4;      // 基地が保有・格納できる艦艇の最大数
export const DOCK_CAPTURE_REL_V = 20;   // [m/s]
// 艦首(+Z)の船体外側に置く単一の接続ポート。位置は姿勢から導出し、保存しない。
export const SHIP_PORT_OFFSET = v3(0, 0, 3.0);
export const PORT_DOCK_MAX_DIST = 50;          // [m] 船対船ポート間の最大捕捉距離
export const PORT_DOCK_MIN_ALIGNMENT = 0.5;    // ポート軸の最小内積 (cos 60°)
export const DOCK_GUIDE_SHOW_DIST = 300;       // [m] ガイドを表示するポート接続点までの距離
export const HATCH_DOCK_MAX_DIST = 80;        // 基地ハッチ前での最大ドッキング距離 [m]
export const HATCH_DOCK_MIN_ALIGNMENT = 0.5;  // ハッチ正面コーンの最小内積 (cos 60° = 0.5)
export const SLOT_DOCK_MAX_DIST = 50;         // 各ドックスロット前での最大ドッキング距離 [m]
export const SLOT_DOCK_MIN_ALIGNMENT = 0.5;   // スロット正面コーンの最小内積 (cos 60° = 0.5)

// --- 基地操縦 ---
export const BASE_THRUST = 4e8;        // 基地の総推力 [N]（1e6 kg で 400 m/s² — 船の全開加速度と同等）
export const BASE_TORQUE = 1.4e8;      // 基地のトルク [N·m]（慣性 1e8 で 1.4 rad/s² — 船の角加速度と同等）
export const BASE_FUEL_RATE = 0.5;     // 基地の燃料消費レート
export const BASE_MAX_FUEL = 50000;    // 基地の最大燃料
export const BASE_INERTIA_X = 1e8;     // 基地の慣性モーメント（ほぼ対称の大質量構造物）
export const BASE_INERTIA_Y = 1e8;
export const BASE_INERTIA_Z = 1.2e8;   // 長軸方向はやや大きい


// ラグランジュ点配置(ハロー/リサジュー)の既定振幅 [km]。
// 副天体ごとに主天体との距離が3桁近く違うため、妥当なオーダーを副天体ごとに別々に持つ。
export const HALO_AX_MOON_KM = 8000;
export const HALO_AZ_MOON_KM = 5000;
export const HALO_AX_EARTH_KM = 200000;
export const HALO_AZ_EARTH_KM = 120000;
export const HALO_AX_JUPITER_KM = 7000000;
export const HALO_AZ_JUPITER_KM = 4000000;

export const REENTRY_ALT = 80e3; // 敵の軌道の近地点余裕を測る基準高度 [m](wave-attack.ts)

// 高度低下警告のしきい値(降順)。EMA 高度がこれを下回るたびに一度だけ警告する [m]
export const ALT_WARN_THRESHOLDS = [120e3, 100e3, 80e3];

// --- 大気抵抗(弾道係数の逆数 Cd·A/m [m^2/kg]) ---
export const SHIP_BCINV = 3.3e-3; // 機体: Cd≈2.2, A≈12m², m≈8t
export const BULLET_BCINV = 2e-4; // 弾丸: 高弾道係数でほとんど減速しない
export const SMALL_DEBRIS_BCINV = 8e-3; // 薬莢・破片

// --- 太陽輻射圧(輻射圧係数 × 断面積質量比 C_R·A/m [m^2/kg]) ---
// 大気抵抗が消える高軌道・ラグランジュ点領域では、これが唯一残る非重力摂動になる。
export const SHIP_SRP_COEFF = 1.56e-2; // 機体: C_R≈1.3, A≈12m², m=PLAYER_MASS
export const SMALL_DEBRIS_SRP_COEFF = 4.7e-3; // 薬莢・破片・弾薬

// --- 熱(physics/thermal.ts の比量モデルへ渡す種別ごとの値) ---
// 弾道係数 bcInv に織り込まれている抗力係数。よどみ点の曲率半径と断面積の比を bcInv から
// 戻すのに使う。物体ごとに変えると bcInv の意味が種別で変わってしまうので、1つに固定する。
export const DRAG_COEFFICIENT = 2.2;
// 断面積のうち、よどみ点の加熱を実際に受ける割合。
export const STAGNATION_AREA_FRACTION = 0.6;
// 艦(自機・敵機)。材質密度は宇宙機の実効密度で、曲率半径 0.6 m を与える値。
export const SHIP_BULK_DENSITY = 833; // [kg/m^3]
// PLAYER_MASS と掛けて外殻の熱容量 0.1 MJ/K。射撃・被弾の発熱量はこれを基準に決めてある。
export const SHIP_SPECIFIC_HEAT = 100; // [J/(kg·K)]
// 艦体自体の放熱面積 70 m² を PLAYER_MASS で割った値。放熱板の展開ぶんはこれに上乗せする。
export const SHIP_RADIATING_AREA_PER_MASS = 0.07; // [m^2/kg]
// 敵機は熱防御を持たないので、艦より低い温度で構造が保たなくなる。降下してくる艦がこの温度に
// 達するのは、地球の大気では高度 80 km 付近。
export const ENEMY_MAX_TEMP = 500; // [K]

// 破片・薬莢・弾薬。アルミ合金相当の材質。
export const SMALL_DEBRIS_BULK_DENSITY = 2700; // [kg/m^3]
export const SMALL_DEBRIS_SPECIFIC_HEAT = 900; // [J/(kg·K)]
// 球とみなした断面積比(bcInv/Cd)の 4 倍。
export const SMALL_DEBRIS_RADIATING_AREA_PER_MASS = 0.01455; // [m^2/kg]
// アルミ合金の融点。降下してくる破片がこの温度に達するのは、地球の大気では高度 60 km 付近
// — 平衡温度はもっと高いところで既にこれを超えるが、再突入は速すぎて平衡に達しない。
export const SMALL_DEBRIS_MAX_TEMP = 933; // [K]

// --- 空力加熱・構造限界 ---
export const SG_CONST = 1.7415e-4; // Sutton–Graves 定数(地球) [kg^0.5/m]
export const HULL_EMISS = 0.85; // 放射率
export const ENV_TEMP = 255; // 放射平衡の環境温度 [K]
export const HULL_START_TEMP = 273; // 初期機体温度 [K]
export const MAX_HULL_TEMP = 1300; // 超過で熱防御飽和 → 機体喪失 [K]
export const MAX_DYN_PRESSURE = 35e3; // 超過で空力破壊 [Pa]
// 加熱の理由を「空力」と「内部」に分ける動圧 [Pa]。地球の大気では高度 133 km 相当で、これを
// 下回る動圧では空力加熱が放射冷却に対して桁で小さい。
export const AERO_HEATING_MIN_Q = 1;

// --- 再突入の燃焼エフェクト ---
export const REENTRY_GLOW_MIN_Q = 200; // 燃焼エフェクトが出始める動圧 [Pa]
export const REENTRY_GLOW_FULL_Q = 2e4; // 燃焼エフェクトが最大強度になる動圧 [Pa]

// --- 射撃による発熱 ---
export const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりの投入熱量 [J]

// --- ラジエーター(上下2枚、個別展開) ---
export const RADIATOR_FOLD_COUNT = 6; // 蛇腹の折り数(1枚あたり)
export const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]
export const RADIATOR_SOLAR_ABSORB = 0.15; // 日照面の太陽光吸収率
// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃(PLAYER_BULLET_DAMAGE)より軽い。損耗はドックで修理するまで戻らない。
export const RADIATOR_BULLET_DAMAGE = 0.25;
export const RADIATOR_CONTACT_DEPLOY = 0.15; // これ以上展開していると被弾対象になる展開度

// --- 被弾による発熱 ---
export const BULLET_IMPACT_HEAT = 3.0e5; // 自機が被弾1発あたりに受ける熱量 [J]

// --- 太陽電池による発電 ---
export const SOLAR_PANEL_AREA = 7.2; // 発電面積 [m^2](左右2枚合計)
export const SOLAR_PANEL_EFFICIENCY = 0.25; // 太陽光→電力の変換効率
export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]

// --- 高度低下警告(EMA平滑化) ---
export const ALT_EMA_TIME_CONST = 3; // 高度・降下率EMAの時定数 [s]
export const ALT_DESCEND_WARN_RATE = -3; // この降下率(EMA)を下回ると警告 [m/s]
export const ALT_DESCEND_CLEAR_RATE = -1; // この降下率(EMA)まで戻ると警告解除 [m/s]
export const ALT_WARN_HYSTERESIS = 5e3; // しきい値の再警告までのヒステリシス幅 [m]

// 並進推力(WSADQE の全 6 方向で共通)の出力 4 段階 [m/s^2]。[1]/[2]/[3]/[4] キーで切替、
// 方向キーが押されている間だけ選択中の段の加速度がその方向へ出る。4段目は3段目の4倍。
export const THROTTLE_LEVELS = [5.0, 20.0, 100.0, 400.0];//エンジン出力、スロットル
export const THROTTLE_LABELS = ['弱', '中', '強', '最強'] as const;
// 自機の質量 [kg]。既定パーツのスラスター推力はこの質量で THROTTLE_LEVELS の最大値の
// 加速度になるよう決めてあるので、両者を別々に動かすと表示と実挙動がずれる。
export const PLAYER_MASS = 1000;
export const THROTTLE_DEFAULT_IDX = 1;

// 分離式ブースターの標準段。自機 1,000 kg と並べたとき、1段あたりの乾燥+満載質量
// 1,000 kg、推力 0.6 MN で約 300 m/s² となるようにする。燃料 800 kg を 80 kg/s
// で燃やし切るので、通常のフレーム刻みでも十数秒の燃焼と最後の燃料切れを扱える。
export const BOOSTER_DEFAULT_DRY_MASS = 200; // [kg]
export const BOOSTER_DEFAULT_MAX_FUEL = 800; // [kg]
export const BOOSTER_DEFAULT_THRUST = 6e5; // [N]
export const BOOSTER_DEFAULT_FUEL_RATE = 80; // [kg/s]
export const BOOSTER_MAX_ATTACHED = 4;
export const BOOSTER_MOUNT_Z = -4.0; // 船体中心から最初の段の前端まで [m]
export const BOOSTER_SEPARATION_SPEED = 8; // 爆砕ボルトによる相対分離速度 [m/s]
export const BOOSTER_COLLISION_GRACE = 0.5; // 分離直後に接続面同士が再衝突しない猶予 [s]
export const BOOSTER_COLLISION_RADIUS = 4.2; // 長さ8mの段を包む接触球 [m]
export const BOOSTER_HARDWARE_LIFETIME = 2.4; // 段間カバー/爆砕ボルトの飛散表示時間 [s]
export const MAX_DETACHED_BOOSTERS = 64;
// 並進方向キーをこの秒数以内に連打すると、押しっぱなし相当にラッチ/解除する [s]
export const THRUST_LATCH_DOUBLE_TAP_SEC = 0.3;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]
export const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 自機の主慣性モーメント(相対値、3軸とも異なる非対称形にしてジャニベコフ効果を起こす)
export const PLAYER_INERTIA_PITCH = 1.0; // ピッチ軸(X)。3軸中の中間値 = 不安定軸
export const PLAYER_INERTIA_YAW = 1.6; // ヨー軸(Y)
export const PLAYER_INERTIA_ROLL = 0.5; // ロール軸(Z、機体前後)。細長い形状に見合って最小

// 手動回転RCSの出力ランプ: 押し始めは MIN、RAMP_TIME 秒かけて (MIN + RAMP) まで増加する
export const RCS_MANUAL_OUTPUT_MIN = 0.3;
export const RCS_MANUAL_OUTPUT_RAMP = 1.0;
export const RCS_MANUAL_RAMP_TIME = 3.0; // [s]
export const RCS_PUFF_TORQUE_EPS = 0.15; // RCSパフを表示する実トルクしきい値 [rad/s^2](inertia=1前提)

// 微調整モード([V]キーでトグル、射撃中は自動でON)で角加速度に掛ける倍率
export const FINE_ATTITUDE_SCALE = 0.5;

// 戦闘視点カメラの near/far [m]。反転 32bit 深度では復元誤差が距離に比例し near に依らないので、
// near は精度のためではなく「カメラが物へめり込む手前で切り取られない」値として置く。far は球
// として描かれる天体のうち見かけ直径が 2px を超える最遠のもの — 直径 1.4e9 m の恒星を LOD 上限で
// 見た 1.4e12 m — が入る距離。far を広げる費用は事実上ゼロ。
export const COMBAT_CAMERA_NEAR = 2;
export const COMBAT_CAMERA_FAR = 2e12;

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]
export const ZOOM_FOV = 6; // [Z]キー長押し時の照準ズーム画角 [deg]
export const ZOOM_LERP_RATE = 9; // 画角遷移の追従速度 [1/s]
export const ZOOM_MUZZLE_FLASH_SCALE = 0.02; // ズーム中のマズルフラッシュ最大不透明度倍率(完全には消さない)

// キーボードでの視点回転(矢印キー)[rad/s]。マウスドラッグと同じ感覚になる値。
export const CAM_KEY_YAW_RATE = 1.4;
export const CAM_KEY_PITCH_RATE = 1.0;
export const CAM_DRAG_ROTATE_RATE = 0.005; // マウスドラッグ [rad/px]
export const CAM_KEY_ROLL_RATE = 1.4; // テンキー0/1での視点ロール [rad/s]
export const CAM_KEY_PAN_RATE = 600; // @/:/;/]での視点平行移動、中クリックドラッグと同じ px/s 換算で加算

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
export const SELF_CONTACT_GRACE = 2.0; // 自弾が自機に当たり得るまでの猶予 [sim s]
export const BULLET_MASS = 0.1; // 弾の剛体接触用質量 [kg](実体弾・プラズマ弾とも共通)
export const BULLET_RADIUS = 0.02; // 弾の剛体接触用半径 [m]
export const BULLET_CLOSE_PASS_DIST = 40; // 敵弾が艦の至近を通過したとみなす距離 [m]

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
export const MAP_AMMO_FADE_START = 5e7;
export const MAP_AMMO_FADE_END = 1e8;
export const MAP_PLANET_SHIP_LABEL_START = 5e8;
export const MAP_PLANET_SHIP_LABEL_END = 1e9;
export const AMMO_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m](見た目に近い実寸)
export const LOGISTICS_LOW_MAGS = 7; // 残りマガジンがこれ未満になると付近の軌道に補給を投入
export const MAX_ACTIVE_AMMO_PICKUPS = 3; // 同時に存在する補給の最大数
export const RCS_FUEL_PICKUP_AMOUNT = 1000; // 補給 1 個の取り込みで増える RCS 燃料 [kg]
export const RCS_FUEL_PICKUP_RADIUS = 100; // 取り込み距離 [m]
export const RCS_FUEL_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m]
export const LOGISTICS_LOW_FUEL_RATIO = 0.3; // この割合未満になると燃料補給を投入
export const MAX_ACTIVE_RCS_FUEL_PICKUPS = 3; // 同時に存在する燃料補給の最大数
export const LOGISTICS_CHECK_INTERVAL = 20; // 補給投入判定の間隔 [sim s]
export const LOGISTICS_MIN_DIST = 625; // 補給投入位置(自機軌道上の位相シフト距離)下限 [m]
export const LOGISTICS_MAX_DIST = 1250; // 同上限 [m]
export const LOGISTICS_DESPAWN_DIST = 50000; // これ以上自機から離れた補給マガジンをデスポーンさせる距離 [m]
export const TARGET_LOCK_PICK_PX_SQ = 600; // 右クリックによるターゲット固定のヒット判定半径の2乗 [px^2](~24px半径)
export const MAP_PICK_PX_SQ = 600; // マップ上の被選択物(MapPickable)の右クリック判定半径の2乗 [px^2]
export const ORBIT_LINE_PICK_PX_SQ = 600; // 軌道線(公転軌道・船の軌道・軌道ガイド)の右クリック判定半径の2乗 [px^2]
// pointer:coarse(タッチ等)向けの上記3定数の緩和版。~44px半径。
export const TARGET_LOCK_PICK_PX_SQ_COARSE = 1936;
export const MAP_PICK_PX_SQ_COARSE = 1936;
export const ORBIT_LINE_PICK_PX_SQ_COARSE = 1936;
export const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い [px]
// 右ドラッグ後でもクリック扱いを許す、意図的に CLICK_MOVE_THRESHOLD より緩い閾値。
export const RIGHT_CLICK_MOVE_THRESHOLD = 50; // [px]
export const TOUCH_LONG_PRESS_MS = 500; // タッチの長押しを右クリックとみなすまでの静止時間 [ms]
export const TOUCH_LONG_PRESS_FEEDBACK_MS = 300; // 長押し成立前に視覚フィードバックを出すまでの時間 [ms]
export const TOUCH_DOUBLE_TAP_MS = 400; // タッチの連続タップをダブルタップとみなす時間差の上限 [ms]
export const TOUCH_DOUBLE_TAP_PX = 24; // 同上、タップ間の許容移動距離 [px]
export const RELOAD_TIME = 1.0; // 手動/自動リロード(バレル交換)のクールダウン [s]
export const MAGS_PER_BARREL = 3; // バレル交換までに消費できるマガジン数
export const BELT_MAX_VISIBLE = 18; // ベルト描画の最大リンク数
export const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]

// マガジンチェーン(ベルト)の可動域: 各つなぎ目で許容する最大折れ角。ロール・ピッチ・ヨーを
// それぞれ独立に制限する。いずれも隣接リンク間の相対角度 [deg]。
export const MAG_CHAIN_MAX_ROLL_DEG = 15;  // ロール上限
export const MAG_CHAIN_MAX_PITCH_DEG = 45; // ピッチ上限(上下方向の折れ)
export const MAG_CHAIN_MAX_YAW_DEG = 15;   // ヨー上限(左右方向の折れ)
export const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
export const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]
export const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;
export const MAX_DEBRIS = 600;
export const MAX_FLASHES = 128; // 同時に存在しうるフラッシュ(発砲・命中・撃破・ガス)の上限。超過分は描画されない

// --- 高負荷デバッグステージ(stage-debug-load.ts)---
// 破片は衛星の破壊直後の雲を想定し、自機の周囲に留める。
export const DEBUG_LOAD_DEBRIS_COUNT = 500;
export const DEBUG_LOAD_DEBRIS_MAX_DIST = 250000; // [m]
export const DEBUG_LOAD_PLACEMENT_MIN_DIST = 5000; // 自機からの配置距離下限 [m]
export const DEBUG_LOAD_RNG_SEED = 20260810;

// --- 重力源の絞り込み(game/simulation/attractors.ts) ---
// 位置に依らず常に加算する重力源の本数。mu の重い順にこの数を採る。既定のレジストリでは
// 月が14位なので、これを下回ると地球圏外の艦で月の寄与が消える。
export const GRAVITY_ALWAYS_COUNT = 15;
// グリッドへ載せた天体を落としてよい引力の上限 [m/s^2]。セル一辺は、載せた天体の引力が
// この値まで落ちる距離として天体構成から導かれる。
export const GRAVITY_NEGLIGIBLE_ACCEL = 1e-8;

// --- 弧が引く天体の絞り込み(game/simulation/arc-bodies.ts) ---
// 一覧の外にある天体が「いつまで効き得ないか」を見積もるときの、相対速さの安全率と下限 [m/s]。
// 見積りは保守的でありさえすればよく、精密である必要はない — 外れても訪問が1回増えるだけで、
// 逆に短く見積もりすぎることだけが取りこぼしになる。下限は、相対速度がいま 0 の天体にも
// 有限の期限を与えるために要る。
export const ARC_BODY_CLOSING_SAFETY = 2;
export const ARC_BODY_CLOSING_MARGIN = 2000;
// 一覧へ入れておく先読み時間を、そのときの刻み幅の何歩ぶんに取るか。次の1歩で表面へ届きうる
// 天体が一覧の外に残ると、その歩の掃引到達判定がその天体を見ないまま通り抜ける。
export const ARC_BODY_LEAD_STEPS = 4;

export const SIM_SPEED_LEVELS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 131072, 524288, 2097152, 8388608, 33554432];
export const MAX_PHYS_SIM_SPEED = 4; // 推進・射撃・衝突解決・敵AIが有効な最大タイムワープ(SimSpeedManager の can* が参照)

export const SUBSTEP_MAX_DT = 20; // 1サブステップの最大秒数 [s](Simulator.advance のサブステップ分割数の算出に使う)
// 1フレームに許すサブステップ数の上限。これを超える時間送りが要求されたら刻み幅の側を伸ばす。
// 刻み幅の上限が固定値だけだと substep 数がワープ倍率に正比例し、高ワープでは1フレームの値段が
// そのまま倍率に比例して増える。再突入中の細分化はこれに優先する(加熱と動圧の積分結果が艦の
// 生死を決め、それをプレイヤーが観測するため)。
// 64 は最高ワープ(×65536)の LEO で1周あたり54歩。そこでの数値的な軌道減衰は 0.42 km/日で、
// 同じ高度で大気抵抗が実際に削る 14 km/日 の 3% — 艦が焼ける時期は高ワープでも変わらない。
// 1周27歩(K=32)まで粗くすると数値減衰が実ドラッグと同等になり、待つだけで艦が倍の速さで落ちる。
export const SUBSTEP_MAX_COUNT = 64;

// 大気の中で刻みを縛る2つの上限(game/simulation/time-step.ts の atmosphericMaxStep)。
// 抗力は陽的 RK4 にとって剛い項で、逆時定数 λ = ½ρ·s·bcInv が刻みに対して大きくなると、
// 段ごとの抗力が増幅して1歩で発散する(抗力は速さの2乗なので振動ではなく暴走になる)。
// DRAG_STEP_MAX_SPEED_LOSS は λ·dt の上限 = 1歩で抗力が奪ってよい対気速度の割合。
// RK4 の実軸上の安定限界は λ·dt ≒ 2.78 だが、縛っているのは安定性ではなく精度である:
// GTO からの再突入で外殻温度の最大は、刻み 0.25 s の基準 976 K に対し λ·dt = 1 で 1050 K
// (+7.6%)、0.5 で 991 K(+1.5%)。限界 1300 K に対して 7.6% は艦の生死を変える。
export const DRAG_STEP_MAX_SPEED_LOSS = 0.5;
// もう1つは剛性と無関係に効く。RK4 の中間段は現在の速度と加速度からの直線外挿なので、
// 重力だけで動径方向に g·dt²/4 沈む。刻み 204.8 s ではこれが 99.6 km になり、高度 91.5 km
// (λ·dt = 0.006 で剛性は全く問題ない)でも段が地面の下を標本して海面密度を拾う。
// DRAG_STEP_MAX_SCALE_HEIGHTS は、その沈み込みが密度を e^N 倍までしか変えないよう縛る。
export const DRAG_STEP_MAX_SCALE_HEIGHTS = 0.5;

// --- 接触判定(game/simulation/ の接触解決) ---
// 剛体接触の反発係数。天体の表面でも物体どうしでも同じ値を使う。
export const CONTACT_RESTITUTION = 0.4;
// 1 substep あたりに解決する接触の上限。TOI(接触時刻)昇順で解決し、これを超えた分は
// 次の substep へ持ち越す(次回呼び出し時に空間グリッドから改めて列挙し直されるので、
// 明示的な繰越処理は不要)。
export const CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP = 8;
// 接触用27近傍グリッドのセル一辺の下限 [m]。全参加者の半径も相対変位も 0 という退化ケースで
// 一辺が 0 になるのを避けるためだけの値で、そのとき接触しうる距離自体が 0 なのでどんな正数でも
// 判定は正しい。セルを細かく取っても空セルは持たない構造なので、最小の実用値として 1m を取る。
export const CONTACT_GRID_CELL_SIZE_FLOOR = 1;

export const PLAYER_HULL_RADIUS = 2.6; // 剛体接触(被弾判定を含む)に使う実寸に近い半径 [m]。
export const ENEMY_RADIUS = 180; // 視認性のため実機体よりかなり大きい当たり判定
export const ENEMY_SCALE = 20; // buildEnemyShip() の見た目メッシュに掛けるスケール
export const ENEMY_MAX_HP = 6;

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 97.0; // 自機初期軌道傾斜角 [deg]

// --- HUD マーカー ---
export const MARKER_DIR_DIST = 5e4; // 方向マーカーを投影する仮想距離 [m](実在の位置ではなく方向のみを示す)
export const MARKER_CLUSTER_PX = 40; // これより画面上で近いマーカー同士は1つの代表にまとめる [px]
// 優先度間引きで一度隠したラベル/アイコンを再び出す画面距離のしきい値(MARKER_CLUSTER_PX より
// 緩い値)。同じ値だと境界ちょうどで距離が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に画面距離が急変する組で顕著)。
export const MARKER_CLUSTER_RELEASE_PX = 60;
// 画面上で近接する2対象(マーカー・天体ラベル・ラグランジュ点ラベルいずれも)のカメラからの
// 距離比がこれ以上なら、優先度に関わらず遠い側を隠す(奥にあるだけの対象が手前の対象を
// 消してしまう逆転を防ぐ)。
export const DEPTH_GUARD_RATIO = 3;
// 一度 DEPTH_GUARD で隠した対象を再び出す距離比のしきい値(ENTER より緩い値)。同じ値だと
// しきい値ちょうどで距離比が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に距離比が急変する組で顕著)。
export const DEPTH_GUARD_EXIT_RATIO = 2;
// 天体ラベルからこれより画面上で近いラグランジュ点ラベルは、天体ラベルを優先して隠す [px]
export const FOCUS_LABEL_PRIORITY_PX = 40;
// 位置の点(アイコン)側の混雑判定。名前(FOCUS_LABEL_PRIORITY_PX)より小さい値にし、名前だけが
// 間引かれて点は残る距離帯を作る。
export const FOCUS_ICON_PRIORITY_PX = 16;

// マーカーラベル優先度 (数値が大きいものが優先。天体 > 船・エンティティ)
export const MARKER_PRIORITY = {
  STAR_PLANET: 5000,
  DWARF_PLANET: 4000,
  SATELLITE_SMALL_BODY: 3000,
  LAGRANGE: 2000,
  PRIMARY_TARGET: 900,
  IMPACT: 850,
  BASE: 700,
  PLAYER: 600,
  ENEMY: 500,
  AMMO: 300,
  MANEUVER_NODE: 150,
  ORBITAL_NODE: 100,
} as const;

// 共線点(L1/L2/L3)を持たせる下限。副天体の半径を単位とした L1 までの距離で、これを下回る系は
// L1 が表面すれすれに来てハロー軌道の振幅が収まらない(フォボス 1.5・イオ 5.8 が落ちる)。
export const LAGRANGE_MIN_CLEARANCE_RATIO = 10;
// 画面外の対象を指す方位マーカーを置く円の半径(画面短辺の半分に対する比)
export const MARKER_BEARING_RING_RATIO = 0.8;
export const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]
export const MARKER_HEADING_PROBE_PX = 20; // 進行方向を測るための投影プローブ距離 [px]
// 投影差がこれ未満なら視線とほぼ平行とみなし、進行方向を定めない [px]
export const MARKER_HEADING_DEGENERATE_PX = 4;
export const LEAD_MAX_TIME = 25; // これより先にしか当たらない見越し解は表示しない [s]

// --- 軌道計画モード([M]) ---
export const OVERVIEW_CAMERA_MIN_DIST = 1e3; // 広範囲視点カメラの注視点までの距離 [m]
export const OVERVIEW_CAMERA_FOV_MIN = 15; // 広範囲視点の最小垂直画角 [deg]
export const OVERVIEW_CAMERA_FOV_MAX = 120; // 広範囲視点の最大垂直画角 [deg]
export const OVERVIEW_CAMERA_FOV_STEP = 1; // HUD から入力する画角の刻み [deg]
// 冥王星(遠日点約70AU)やエリス(遠日点約97AU)、散乱円盤の遠日点(数百AU)まで
// 視界に収められる引きの上限。
export const OVERVIEW_CAMERA_MAX_DIST = 1e14;
// 広範囲視点の near は固定値ではなく、注視点までの距離をこの比で割った値を毎フレーム使う
// (near = dist / OVERVIEW_CAMERA_NEAR_RATIO)。比を大きくすると near が注視点に近づいて
// 手前がクリップされにくくなる。反転 32bit 深度では分解能が near に依らないので、
// この比が深度精度と取引になることはない。
export const OVERVIEW_CAMERA_NEAR_RATIO = 1000;
// near = dist / OVERVIEW_CAMERA_NEAR_RATIO の比例則は dist の上限では星球シェル・
// 天球グリッド(CELESTIAL_SHELL_RADIUS)より大きくなる(dist=1e14 で near=1e11)。
// near クリップは光軸からの角度 θ に対して球殻上の点を R·cosθ まで切り詰めるので、
// R そのものでなく画面対角の半視野角 θ_diag での R·cosθ_diag を上限に取らないと、
// 画面中心だけ残して周辺・四隅の星が消える(MapCamera.near 参照)。
// 1 未満のこの係数はその余弦にさらに掛ける安全マージン。
export const OVERVIEW_CAMERA_NEAR_SHELL_MARGIN = 0.9;
// 広範囲視点の far も near と同様に固定値ではなく dist に連動させる
// (far = clamp(dist × OVERVIEW_CAMERA_FAR_RATIO, OVERVIEW_CAMERA_FAR_MIN, OVERVIEW_CAMERA_FAR_MAX))。
// far を dist に比例させないと、太陽・木星のような遠方天体は引いたカメラでは
// far 平面の外に出て消える。逆に近距離域で far を大きく取ることの費用は、反転 32bit 深度では
// 事実上ゼロ。
export const OVERVIEW_CAMERA_FAR_RATIO = 100;
// 最小ズーム(dist = OVERVIEW_CAMERA_MIN_DIST)でも月(3.8e8m)や星球シェルが
// far の外に出ないための下限。
export const OVERVIEW_CAMERA_FAR_MIN = 1.5e10;
// OVERVIEW_CAMERA_MAX_DIST × OVERVIEW_CAMERA_FAR_RATIO と等しい値。これより小さいと
// 最大ズームアウト付近で far = dist × FAR_RATIO の比例則がこの上限に張り付いてしまい、
// 注視点より奥にある軌道線・天体が far 平面でクリップされる。
export const OVERVIEW_CAMERA_FAR_MAX = 1e16;
// 星球シェル・天球グリッドの表示半径。マップの広範囲視点カメラの far は dist に連動して
// 毎フレーム変わるため、そこに結びつけると星殻半径も毎フレーム変動してしまう。
// far とは独立に固定する。
// far の下限(OVERVIEW_CAMERA_FAR_MIN)より 10% 内側に取る — 等しいと最小ズームで
// 殻のジオメトリが far 平面上に乗り、視線方向の星・グリッドがクリップされる。
export const CELESTIAL_SHELL_RADIUS = 1.35e10;
export const NODE_DV_RATE = 300; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 30; // 微調整モード時
export const NODE_PICK_PX = 30; // 軌道クリック判定の許容距離 [px]
// 折れ線が自分自身に重なる(周回を跨いで表示期間が延びた)場合、最短画面距離からこの
// 許容差以内の候補のうち最も早い時刻のものを選ぶ [px]
export const NEAREST_SAMPLE_TIE_PX = 3;
export const NODE_MIN_DV = 0.5; // これ未満のノードは軌道計画モードを抜けるときに破棄 [m/s]
export const MAX_PLAN_NODE_MARKERS = 12; // 画面上に表示するノードマーカーの上限(HUD要素数の上限)
// マップモードの DOM ギズモ(node-gizmo.ts): 選択中ノードの Δv アーム(6方向ハンドル)
export const NODE_GIZMO_HANDLE_PX = 42; // ノードからアームハンドルを離す距離 [px]
export const NODE_GIZMO_DRAG_THRESHOLD_PX = 4; // ノードハンドルのクリック/ドラッグ判定しきい値 [px]
// Δv アームドラッグ・長押しボタンによる連続加算(plan-editor.ts の applyDv 系)
export const DV_DRAG_LATCH_PX = 60; // これを超えるアーム基点からの変位でドラッグがラッチ状態に入る [px]
export const DV_LATCH_RATE_PER_PX = 3.0; // ラッチ中、閾値超過1pxあたりのΔv加算レート [m/s per 実秒 per px]
export const DV_RATE_MIN = 1; // 長押し開始時のΔv加算レート [m/s per 実秒]
export const DV_RATE_MAX = 400; // 長押し継続後に到達するΔv加算レート [m/s per 実秒]
export const DV_RATE_RAMP_SEC = 3.0; // DV_RATE_MIN から DV_RATE_MAX への指数的ランプ時間 [s]
// マニューバ達成判定(計画軌道への接近許容)
export const NODE_TOL_SMA = 0.02 / 3; // 長半径の相対誤差
export const NODE_TOL_ECC = 0.02 / 3; // 離心率差
export const NODE_TOL_PLANE_DEG = 2.0 / 3; // 軌道面の角度差 [deg]
// ノード実行時刻の何秒前から「実行の窓」とみなすか [s]。噴射準備の通知・達成判定の開始・
// 自動ワープの解除がこの1点を共有する。
export const NODE_APPROACH_LEAD = 10;
// 実行時刻をこれだけ過ぎたノードは計画から落とす [s]。多少の遅れなら噴射できる猶予。
export const NODE_EXPIRE_GRACE = 60;

// --- 軌道計画の自動実行(plan-executor.ts) ---
export const PLAN_EXECUTOR_DV_EPS = 0.05; // これ未満のΔvは燃焼不要とみなす [m/s]
export const PLAN_EXECUTOR_ARM_ANGLE_DEG = 2.0; // 姿勢誤差がこれを切ったら点火を許可する [deg]
export const PLAN_EXECUTOR_TRIM_DV = 5.0; // 残り射影がこれを下回ったら最低出力段へ落とす [m/s]

// --- 未来表示の時刻(display-window-manager.ts のスライダー) ---
export const DISPLAY_DUR_DAY = 86400; // 1日
export const DISPLAY_DUR_TEN_DAY = 10 * 86400; // 10日
export const DISPLAY_DUR_MONTH = 30 * 86400; // 1ヶ月
export const DISPLAY_DUR_THREE_MONTH = 90 * 86400; // 3ヶ月
export const DISPLAY_DURATION_MAX = 365 * 86400; // 手動レンジで指定できる表示期間の上限 [s](1年)
// 手動レンジで指定できる表示期間の下限 [s]。表示期間は予測列の保持窓でもあり、0 では
// サンプルが1件も残らず、どの時刻も引けない列になる。
export const DISPLAY_DURATION_MIN = 3600;

// --- 軌道計画の折れ線(plan/plan-path.ts) ---
// 計画軌道の折れ線を破線で描くときの、破線1本・間隔の画面上の長さ [px] と不透明度。
// 実距離ではなく画面ピクセルで持つのは、マップの倍率が数桁変わるため実距離で固定すると
// 拡大時は数本の線分に、縮小時はサブピクセルになって実線と区別できなくなるため。
export const PLAN_ARC_DASH_PX = 8;
export const PLAN_ARC_GAP_PX = 6;
export const PLAN_ARC_OPACITY = 0.85;
// 周期を持たない軌道(双曲線・放物線)で、1周期の代わりに区間の長さとして使う値 [s]。
export const APERIODIC_ARC_DURATION = 86400;
// 近地点・遠地点アイコン(plan/plan-display.ts)を出す離心率相当値の下限。両方見つかった
// ときの (遠地点距離-近地点距離)/(遠地点距離+近地点距離) と比較する — これ未満は円に
// 近くアプシスの方向が不定になるので両方隠す。
export const APSIS_MIN_ECC = 0.01;
// 計画軌道上の UTC 暦目盛(plan/plan-display.ts)の間隔・本数を決める値。時・日・月のどの
// 単位で刻むかは画面上の間隔で選ぶため、固定した時間間隔ではなく画面距離基準で間引く。
export const PLAN_TICK_MIN_PX = 40; // 目盛同士の最小画面間隔 [px]
export const PLAN_TICK_LABEL_MIN_PX = 90; // ラベルを付ける最小画面間隔 [px]
export const PLAN_TICK_MAX_COUNT = 400; // 日・月・年階級の目盛候補の上限本数
// 時階級(1/3/6/12時間ごと)の目盛候補の上限本数。時階級の各刻みは互いに包含関係にある
// (1時間ごとの列挙は3/6/12時間ごとの境界をすべて含む)ため、この上限に収まる限り常に
// 最も細かい1時間ごとで列挙し、実際に画面へ出す粒度は sync 側の画面距離判定(間引き)に
// 委ねる — そうしないと区間の長さだけで階級が丸ごと切り替わり、ズームに対して連続に
// 見えなくなる。PLAN_TICK_MAX_COUNT より大きく取り、既定の最長表示区間(28日)でも
// 1時間ごとの候補が丸ごと落ちないようにする。
export const PLAN_TICK_HOUR_FAMILY_MAX_COUNT = 1200;
// 目盛点の半径 [px]。単位切替後も平均的な目盛の大きさが変わらないよう、絶対の階層ではなく
// 現在表示中の最細目盛からの相対階層(0/1/2以上)で半径を引く。
export const PLAN_TICK_RADIUS_PX = [1.5, 2.5, 3.5] as const;

// --- エンティティの過去・未来状態列(physics/dynamic-trajectory.ts の DynamicTrajectory、
// game/simulation/predicted-arc.ts の PredictedArc/Predictor) ---
export const TRAJECTORY_SAMPLES_PER_REV = 32; // 1周回あたりの保持サンプル数(補間誤差 30m 程度に収まる実測値)
export const DEFAULT_HISTORY_DURATION = 10 * 86400; // 過去列を持つ種別(Ship・Base)の既定保持時間 [s]
// 過去表示の要求で伸ばせる保持時間の上限 [s]。保持サンプル数は間引きにより
// ARC_MAX_SAMPLES で頭打ちなので、この値が決めるのは間引きの粗さ(補間精度)の下限。
export const HISTORY_DURATION_MAX = DISPLAY_DURATION_MAX;
// 1周回あたりの予測列の積分ステップ数。刻み幅をその場の周期に比例させることで、低軌道でも
// 遠方の長周期軌道でも精度が一定になる。同時にこれは遅い軌道のコスト上限でもあり、既定の
// 表示期間では GEO 以遠でこの項が採用値になって、下限だけで刻む場合の 1/14(GEO)〜1/558(日心)
// までステップ数が落ちる。離心軌道では1周の中でも刻みが変わる(モルニヤで近地点 20s /
// 遠地点 331s)ので、定数刻みでは届かない「安くて同じ精度」の側に出られる。
// 300 での形状誤差は GEO 28日 0.14km・モルニヤ1日 0.08km(実測)と、どのズームでもマップ
// 1px 未満に収まる(LEO と低月周回では period/300 が ARC_MIN_STEP_DT を割るので、そちらの
// 床が採用値になってこの値に依らない)。
export const ARC_STEPS_PER_REV = 300;
// 消費されない弧(計画の区間)の積分ステップ数・保持サンプル数の上限。
// 弧の長さは表示期間(最大1年)に追従するので、1周回基準の刻みのままではステップ数もメモリも
// 青天井になる。長い期間ではこれらが刻み幅と間引き間隔を決め、軌道の形の精度と引き換えに
// 費用を頭打ちにする。刻み幅を決めるのは span > ARC_MAX_STEPS × ARC_MIN_STEP_DT(≒4.6日)の
// ときだけ。ARC_MAX_SAMPLES は実状態の履歴の間引き(trajectorySampleInterval)でも使う。
export const ARC_MAX_STEPS = 20000;
export const ARC_MAX_SAMPLES = 10000;
// 積分済みのサンプル列が、要求区間の求める間引き間隔に対して何倍まで粗くてよいか
// (PredictedArc.represents 用)。表示期間を短くしたときは積分結果を捨てず答える範囲だけを
// 狭めるが、狭めた区間に残るサンプルが数点まで減ると、折れ線上のクリック候補が飛び飛びの
// 点になる。これを超えて粗ければ弧を作り直す。
export const ARC_MAX_SAMPLE_COARSENING = 8;
// Predictor が1フレームに配る積分ステップ数の上限。1歩 ≈ 0.025〜0.055ms(弧が保持する
// 一覧ぶんの天体解決+掃引到達判定、ブラウザ実測)なので、成長中の予測・計画が1フレームに
// 使うのは ~15〜33ms まで。ここへ払った時間は積分側から返ってくる — 消費される弧の1歩は
// simDt/SUBSTEP_MAX_COUNT 秒ぶんを覆い、高ワープではその区間の実シミュレーションのサブステップ
// 数百回ぶんの積分を1歩で肩代わりする。消費されている個体を追い抜かせないだけで1体あたり
// SUBSTEP_MAX_COUNT(=64)歩/フレームが要り、ホライズンへ伸ばすぶんはその上に乗る。
export const ARC_STEP_BUDGET = 600;
// 消費されない弧(計画の区間)の刻みの下限 [s]。消費されない弧は状態を
// 決めず線としてだけ読まれるので、実シミュレーションより粗く刻むこと自体が目的である —
// 細かくすれば届く先が近くなるだけで、折れ線の誤差は間引き補間が支配しているので見える精度は
// 増えない。これ以上粗くできない理由は、この下限が周期由来の刻み(period/ARC_STEPS_PER_REV)を
// 上書きする側にあることにある: 自然な刻みが下限を割るのは周期の短い領域 — LEO と、離心軌道の
// 近地点通過 — で、そこはまさに細かく刻む必要がある場所である。表示期間の遠端に残る形状誤差
// (tests/perf/exp9-step-retune.ts の実測)は 40s で LEO 0.2m・低月周回 0.0m・モルニヤ 105m、
// 60s で 1.7m・0.1m・533m。
// 刻みの下限は同時に、天体接近時(下の ARC_APPROACH_SAFETY)の接近項が幾何級数的に潰れるのも防ぐ。
export const ARC_MIN_STEP_DT = 40;
// 天体接近時、1ステップで表面までの残距離を跨がないための安全率。動径接近率(表面までの
// 距離の減り方)に掛かる上限係数で、相対速さそのものではなく接近している成分だけを見る
// — でないと円軌道でも常に効いて粗化項(ARC_MAX_STEPS)を不当に上書きしてしまう。
export const ARC_APPROACH_SAFETY = 0.5;
// 消費される弧が、消費前線の近くで毎歩サンプルを残す歩数。この範囲では at() の補間誤差が
// 1歩ぶん(20s 刻みで 4.5mm)まで落ちる。前線がここを抜けると周期基準の間引きへ移り、
// 補間誤差は LEO で 20〜26m になる。512 は ×1 で 512×20s = 2.8 時間ぶん、最高ワープで
// 512×34.1s = 8フレームぶんの前線をこの精度で覆う。
export const ARC_FINE_STEPS = 512;
// 消費される弧が、消費前線より過去側にも保持しておく余裕 [s]。保持窓の左端が前線に一致すると
// at(前線) を挟む補間区間が消える。予測線の下端は simTime なので、余分に保持しても描画は変わらない。
export const ARC_RETAIN_MARGIN = 300;
// 1フレームの予測予算のうち、操作艦の弧+計画軌道の弧(interactive 枠)に割ける割合の上限。
// 優先はするが独占はさせない — 計画の弧は他個体の予測を重力源・衝突判定の相手として読むため、
// 編集直後の計画にこの枠を丸ごと食わせると、その依存先(background 側)の予測の成長が止まる。
export const ARC_INTERACTIVE_RATIO = 0.5;
// background のラウンドロビンで1体に必ず渡すステップ数の下限。予測列の history に最初の
// 保持サンプルが積まれるまでは at() がほぼ全時刻で null を返し、実シミュレーションが消費
// できずに積分して弧を捨てるので、その1サンプル分(sampleInterval / 刻み幅 ≒ 10 ステップ)を
// 下回る配分は作り直しを繰り返す。
export const ARC_MIN_ITEM_STEPS = 16;
// [N] 自動ワープ: 残り時間 / MARGIN 以下の最大シミュレーション速度を選び、STOP 秒前に解除。
export const AUTOWARP_MARGIN = 2;
export const AUTOWARP_STOP = 10;

// simTime=0 の物理元期。遠未来UTCは定義できないため、天体力学ではTDBとして解釈する。
// HUDは同じ暦フィールドを作中日時ラベルとして表示する。
export const SIM_EPOCH_TDB = '20115-05-14T06:00:00';

// --- 第零ステージ(近接戦闘訓練) ---
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
export const PLAYER_BULLET_DAMAGE = 1.25; // 自機が被弾(自弾・プラズマ弾とも)した際のダメージ [HP]
export const ENEMY_BULLET_DAMAGE = 1; // 既定の機関砲が 1 発で与えるダメージ [HP]。武器部品の damage の初期値

// --- 剛体接触による装甲ダメージ ---
// 接触の瞬間の接近速度(法線方向の相対速度)のしきい値 [m/s]。これ未満なら無傷、これ以上で
// パーツの最大 HP 分、間は線形。
export const COLLISION_DAMAGE_MIN_CLOSING_SPEED = 50;
export const COLLISION_DAMAGE_FULL_CLOSING_SPEED = 500;
export const PLASMA_BULLET_SPEED = MUZZLE_SPEED * 2 / 3; // MUZZLE_SPEED の 2/3
export const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
export const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
export const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
export const ENEMY_AI_MIN_RANGE = 50; // これより近いと射撃しない(至近距離) [m]
export const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 同一集団内で同時に攻撃する最大機数
export const ENEMY_ATTACK_CHANCE = 0.6; // 各機が攻撃(バースト)を開始する確率
export const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト射撃弾数の候補
export const PLASMA_SPREAD_DEG = 0.05; // プラズマ弾の散布角 [deg]

// 色管理 (Colors)
// ゲーム世界の識別色(方位マーカー・陣営ごとの軌道線・ステージ演出)のみ。UI の色は theme.ts、
// 「どう見えるか」だけを決めるエフェクトの色は render/vfx-style.ts が持つ。
// 軌道3軸(prograde/normal/radial)だけは theme.ts の AXIS_* を使う。Δv 編集の 3D ギズモと
// 方位マーカーは同じ軸を指すので、同じ軸に二系統の色を持たせない。
export const COLOR_MARKER_BORESIGHT = '#dfe3e8';
export const COLOR_MARKER_TGTDIR = '#ff7ab0';
export const COLOR_MARKER_NODE = '#8b93a0';
export const COLOR_MARKER_BOARDPASS = '#ffffff';
export const COLOR_MARKER_SELF = '#dfe3e8';
export const COLOR_MARKER_PLANNED = '#8fd0ff';
export const COLOR_MARKER_ALLY = '#ffffff';
export const COLOR_MARKER_ENEMY = '#ffffff';
export const COLOR_MARKER_HP_EMPTY = 'rgba(120, 125, 130, .2)';
export const COLOR_PLAYER_ORBIT_LINE_INACTIVE = '#ffffff'; // マップビューで操作対象でない自艦の軌道線
export const COLOR_ENEMY_ORBIT_LINE = '#565b63';
export const COLOR_BASE_ORBIT_LINE = '#4f8f7d'; // 拠点(味方施設)の軌道線。落ち着いた緑がかった色で他線と区別
export const COLOR_STAGE0_GROUP_ACCENTS = ['#ff4a3d', '#3dc6ff', '#3dff8f', '#ffe23d', '#bf3dff'];

// 役割ごとの軌道線の見た目(色・不透明度・描画順)を一括して決める表。
export const LINE_STYLE = {
  enemyOrbit: { color: COLOR_ENEMY_ORBIT_LINE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
  baseOrbit: { color: COLOR_BASE_ORBIT_LINE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
} as const satisfies Record<string, LineStyle>;

// 惑星・衛星の参照軌道線のフェード距離 [m]。カメラから天体までの距離がこれ未満なら非表示、
// FAR 以上なら完全表示、その間は距離に応じて線形にフェードインする。
export const PLANET_ORBIT_LINE_FADE_NEAR_DIST = 1e9; // 100万km
export const PLANET_ORBIT_LINE_FADE_FAR_DIST = 1e10; // 1000万km
export const SATELLITE_ORBIT_LINE_FADE_NEAR_DIST = 5e8; // 50万km
export const SATELLITE_ORBIT_LINE_FADE_FAR_DIST = 1e9; // 100万km
// 参照軌道線が完全表示のときの不透明度。
export const REFERENCE_LINE_OPACITY = 0.3;

// マップのハロー軌道ガイド(halo-guide-lines.ts)の線色。静止軌道リング(0x8b93a0)と同じ
// 控えめな系統だが、ファミリーごとに色相を変えて重なっても見分けられるようにする。
export const COLOR_HALO_GUIDE_LINE = 0x6fa3c9; // ハロー族(s に沿った不透明度グラデーションの基準色)
export const COLOR_PLANAR_LYAPUNOV_LINE = 0x7fb88a;
export const COLOR_VERTICAL_LYAPUNOV_LINE = 0xc9a969;
export const COLOR_LISSAJOUS_LINE = 0xb08bc9;
export const COLOR_DRO_LINE = 0x6fc9b8;

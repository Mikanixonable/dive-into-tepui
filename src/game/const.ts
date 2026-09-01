// ゲームバランス・チューニング定数
import type { GuideGroupId } from './celestial/orbit-guide/orbit-guide-settings';

// --- 基地ドッキング ---
export const BASE_MAX_VESSELS = 4;      // 基地が保有・格納できる艦艇の最大数

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

// --- 砲身。鋼の砲身1本ぶんで、外殻とは別に温度を持つ ---
// BARREL_MASS と掛けて砲身の熱容量 0.15 MJ/K。射撃発熱はこれを基準に決めてある。
export const BARREL_SPECIFIC_HEAT = 500; // [J/(kg·K)]
// 砲身の表面積 14 m² を BARREL_MASS で割った値。
export const BARREL_RADIATING_AREA_PER_MASS = 0.047; // [m^2/kg]

// --- ラジエーター(上下2枚、個別展開) ---
export const RADIATOR_FOLD_COUNT = 6; // 蛇腹の折り数(1枚あたり)
export const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]

// --- 太陽電池による発電 ---
export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]

// --- 高度低下警告(EMA平滑化) ---

// 並進推力(WSADQE の全 6 方向で共通)の出力 4 段階 [m/s^2]。[1]/[2]/[3]/[4] キーで切替、
// 方向キーが押されている間だけ選択中の段の加速度がその方向へ出る。4段目は3段目の4倍。
export const THROTTLE_LEVELS = [5.0, 20.0, 100.0, 400.0];//エンジン出力、スロットル
export const THROTTLE_LABELS = ['弱', '中', '強', '最強'] as const;
// 自機の質量 [kg]。既定パーツのスラスター推力はこの質量で THROTTLE_LEVELS の最大値の
// 加速度になるよう決めてあるので、両者を別々に動かすと表示と実挙動がずれる。
export const PLAYER_MASS = 1000;

export const MAX_ANG_ACCEL = 1.4; // 姿勢制御の角加速度 [rad/s^2]

// 自機の主慣性モーメント(相対値、3軸とも異なる非対称形にしてジャニベコフ効果を起こす)
export const PLAYER_INERTIA_PITCH = 1.0; // ピッチ軸(X)。3軸中の中間値 = 不安定軸
export const PLAYER_INERTIA_YAW = 1.6; // ヨー軸(Y)
export const PLAYER_INERTIA_ROLL = 0.5; // ロール軸(Z、機体前後)。細長い形状に見合って最小

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]

// キーボードでの視点回転(矢印キー)[rad/s]。マウスドラッグと同じ感覚になる値。
export const CAM_KEY_YAW_RATE = 1.4;
export const CAM_KEY_PITCH_RATE = 1.0;

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]
export const FIRE_INTERVAL = 0.06; // 発射間隔 [s] 
// 弾の消滅は距離が主、寿命は保険。弾は1発ずつ独立したドローコールなので生存数が描画コストへ
// 直結する。自機の目の前で消えないよう、交戦圏 STAGE00_MAX_RANGE と同じ距離を採る。
export const BULLET_MASS = 0.1; // 弾の剛体接触用質量 [kg](実体弾・プラズマ弾とも共通)
export const BULLET_RADIUS = 0.02; // 弾の剛体接触用半径 [m]

// --- 弾薬・マガジン ---
export const MAG_ROUNDS = 32; // 1 マガジンの装弾数
export const INITIAL_MAGS = 3; // ゲーム開始時に連結されているマガジン数
export const AMMO_PICKUP_RADIUS = 100; // 取り込み距離 [m](ゲームプレイ上の吸収判定。物理サイズではない)
export const AMMO_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m](見た目に近い実寸)
export const MAX_ACTIVE_AMMO_PICKUPS = 3; // 同時に存在する補給の最大数
export const RCS_FUEL_PICKUP_AMOUNT = 1000; // 補給 1 個の取り込みで増える RCS 燃料 [kg]
export const RCS_FUEL_PICKUP_RADIUS = 100; // 取り込み距離 [m]
// pointer:coarse(タッチ等)向けの上記3定数の緩和版。~44px半径。
export const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い [px]
// 右ドラッグ後でもクリック扱いを許す、意図的に CLICK_MOVE_THRESHOLD より緩い閾値。
export const BELT_MAX_VISIBLE = 18; // ベルト描画の最大リンク数
export const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]

// マガジンチェーン(ベルト)の可動域: 各つなぎ目で許容する最大折れ角。ロール・ピッチ・ヨーを
// それぞれ独立に制限する。いずれも隣接リンク間の相対角度 [deg]。
export const MAX_BULLETS = 400;
export const MAX_CASINGS = 260;

// --- 高負荷デバッグステージ(stage-debug-load.ts)---
// 破片は衛星の破壊直後の雲を想定し、自機の周囲に留める。
export const DEBUG_LOAD_DEBRIS_COUNT = 500;
export const DEBUG_LOAD_DEBRIS_MAX_DIST = 250000; // [m]
export const DEBUG_LOAD_PLACEMENT_MIN_DIST = 5000; // 自機からの配置距離下限 [m]
export const DEBUG_LOAD_RNG_SEED = 20260810;

// --- 重力源の絞り込み(game/dynamic/attractors.ts) ---
// グリッドへ載せた天体を落としてよい引力の上限 [m/s^2]。セル一辺は、載せた天体の引力が
// この値まで落ちる距離として天体構成から導かれる。
export const GRAVITY_NEGLIGIBLE_ACCEL = 1e-8;

// --- 弧が引く天体の絞り込み(game/dynamic/arc-celestial-bodies.ts) ---

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

// 大気の中で刻みを縛る2つの上限(game/dynamic/time-step.ts の atmosphericMaxStep)。
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

// --- 接触判定(game/dynamic/ の接触解決) ---
// 剛体接触の反発係数。天体の表面でも物体どうしでも同じ値を使う。
export const CONTACT_RESTITUTION = 0.4;
// 接触用27近傍グリッドのセル一辺の下限 [m]。全参加者の半径も相対変位も 0 という退化ケースで
// 一辺が 0 になるのを避けるためだけの値で、そのとき接触しうる距離自体が 0 なのでどんな正数でも
// 判定は正しい。セルを細かく取っても空セルは持たない構造なので、最小の実用値として 1m を取る。
export const CONTACT_GRID_CELL_SIZE_FLOOR = 1;

export const PLAYER_HULL_RADIUS = 2.6; // 剛体接触(被弾判定を含む)に使う実寸に近い半径 [m]。

export const INITIAL_ALT = 420e3; // 自機初期高度 [m]
export const INITIAL_INC_DEG = 97.0; // 自機初期軌道傾斜角 [deg]

// --- HUD マーカー ---
export const MARKER_DIR_DIST = 5e4; // 方向マーカーを投影する仮想距離 [m](実在の位置ではなく方向のみを示す)
// 画面上で近接する2対象(マーカー・天体ラベル・ラグランジュ点ラベルいずれも)のカメラからの
// 距離比がこれ以上なら、優先度に関わらず遠い側を隠す(奥にあるだけの対象が手前の対象を
// 消してしまう逆転を防ぐ)。
export const DEPTH_GUARD_RATIO = 3;
// 一度 DEPTH_GUARD で隠した対象を再び出す距離比のしきい値(ENTER より緩い値)。同じ値だと
// しきい値ちょうどで距離比が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に距離比が急変する組で顕著)。
export const DEPTH_GUARD_EXIT_RATIO = 2;

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
  PROTEIN_SITE: 50,
} as const;

// 共線点(L1/L2/L3)を持たせる下限。副天体の半径を単位とした L1 までの距離で、これを下回る系は
// L1 が表面すれすれに来てハロー軌道の振幅が収まらない(フォボス 1.5・イオ 5.8 が落ちる)。
export const LAGRANGE_MIN_CLEARANCE_RATIO = 10;

// --- 軌道計画モード([M]) ---
export const OVERVIEW_CAMERA_MIN_DIST = 1e3; // 広範囲視点カメラの注視点までの距離 [m]
export const OVERVIEW_CAMERA_FOV_MIN = 15; // 広範囲視点の最小垂直画角 [deg]
export const OVERVIEW_CAMERA_FOV_MAX = 120; // 広範囲視点の最大垂直画角 [deg]
// 星球シェル・天球グリッドの表示半径。マップの広範囲視点カメラの far は dist に連動して
// 毎フレーム変わるため、そこに結びつけると星殻半径も毎フレーム変動してしまう。
// far とは独立に固定する。
// far の下限(OVERVIEW_CAMERA_FAR_MIN)より 10% 内側に取る — 等しいと最小ズームで
// 殻のジオメトリが far 平面上に乗り、視線方向の星・グリッドがクリップされる。
export const NODE_DV_RATE = 300; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 30; // 微調整モード時
// ノード実行時刻の何秒前から「実行の窓」とみなすか [s]。噴射準備の通知・達成判定の開始・
// 自動ワープの解除がこの1点を共有する。
export const NODE_APPROACH_LEAD = 10;

// --- 未来表示の時刻(display-window-manager.ts のスライダー) ---
export const DISPLAY_DURATION_MAX = 365 * 86400; // 手動レンジで指定できる表示期間の上限 [s](1年)

// --- 軌道計画の折れ線(plan/plan-path.ts) ---
// 周期を持たない軌道(双曲線・放物線)で、1周期の代わりに区間の長さとして使う値 [s]。
export const APERIODIC_ARC_DURATION = 86400;

// --- エンティティの過去・未来状態列(physics/dynamic-trajectory.ts の DynamicTrajectory、
// game/dynamic/predicted-arc.ts の PredictedArc/Predictor) ---
export const TRAJECTORY_SAMPLES_PER_REV = 32; // 1周回あたりの保持サンプル数(補間誤差 30m 程度に収まる実測値)
export const DEFAULT_HISTORY_DURATION = 10 * 86400; // 過去列を持つ種別(Ship・Base)の既定保持時間 [s]
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
// 1フレームの予測予算のうち、操作艦の弧+計画軌道の弧(interactive 枠)に割ける割合の上限。
// 優先はするが独占はさせない — 計画の弧は他個体の予測を重力源・衝突判定の相手として読むため、
// 編集直後の計画にこの枠を丸ごと食わせると、その依存先(background 側)の予測の成長が止まる。
export const ARC_INTERACTIVE_RATIO = 0.5;
// background のラウンドロビンで1体に必ず渡すステップ数の下限。予測列の history に最初の
// 保持サンプルが積まれるまでは at() がほぼ全時刻で null を返し、実シミュレーションが消費
// できずに積分して弧を捨てるので、その1サンプル分(sampleInterval / 刻み幅 ≒ 10 ステップ)を
// 下回る配分は作り直しを繰り返す。
export const ARC_MIN_ITEM_STEPS = 16;

// --- 第零ステージ(近接戦闘訓練) ---
export const STAGE0_PER_GROUP = 10; // グループあたりの機数
export const STAGE0_MAX_RANGE = 5000; // 自機からの配置半径の上限 [m]

// --- ステージ00(無限耐久サバイバル) ---
export const STAGE00_MAX_RANGE = 30000; // 自機からの配置半径の上限(デスポーン距離) [m]
export const STAGE00_LOGISTICS_MIN_DIST = 12.5; // 補給の配置距離 [m](自機から)
export const STAGE00_LOGISTICS_MAX_DIST = 50;

export const ENEMY_BULLET_DAMAGE = 1; // 既定の機関砲が 1 発で与えるダメージ [HP]。武器部品の damage の初期値

// --- 剛体接触による装甲ダメージ ---

// 色管理 (Colors)
// ゲーム世界の識別色(方位マーカー・陣営ごとの軌道線・ステージ演出)のみ。UI の色は theme.ts、
// 「どう見えるか」だけを決めるエフェクトの色は render/vfx-style.ts が持つ。
// 軌道3軸(prograde/normal/radial)だけは theme.ts の AXIS_* を使う。Δv 編集の 3D ギズモと
// 方位マーカーは同じ軸を指すので、同じ軸に二系統の色を持たせない。
export const COLOR_MARKER_NODE = '#8b93a0';
export const COLOR_MARKER_FUEL = '#ffcf70';
export const COLOR_MARKER_ALLY = '#ffffff';
export const COLOR_MARKER_ENEMY = '#ffffff';
export const COLOR_ENEMY_ORBIT_LINE = '#565b63';
export const COLOR_BASE_ORBIT_LINE = '#4f8f7d'; // 拠点(味方施設)の軌道線。落ち着いた緑がかった色で他線と区別
// ゼロ速度曲線(ガイドタブ5.3節)。軌道ガイド線の青・橙・緑・紫、静止軌道リングの灰色と
// 見分けがつく控えめな薔薇色。
export const COLOR_STAGE0_GROUP_ACCENTS = ['#ff4a3d', '#3dc6ff', '#3dff8f', '#ffe23d', '#bf3dff'];

// 軌道ガイド(orbit-guide-lines.ts)の群ごとの基準色相。群の中の種類は明度違いで分ける
// (guideKindDefaultColors)。静止軌道リング(0x8b93a0)と同じ控えめな系統でまとめる。
const GUIDE_GROUP_HUE: Readonly<Record<GuideGroupId, number>> = {
  collinear: 0x6fa3c9, // 青(旧ハロー色を踏襲)
  triangular: 0xc9a969, // 橙
  secondary: 0x6fc9b8, // 緑(DRO/DPO/LPO)
  resonant: 0xb08bc9, // 紫
};

// color を towards との線形補間で t(0..1)だけ明るく/暗くした 0xRRGGBB を返す。
function lerpColor(color: number, towards: number, t: number): number {
  const r0 = (color >> 16) & 0xff, g0 = (color >> 8) & 0xff, b0 = color & 0xff;
  const r1 = (towards >> 16) & 0xff, g1 = (towards >> 8) & 0xff, b1 = towards & 0xff;
  return (Math.round(r0 + (r1 - r0) * t) << 16) | (Math.round(g0 + (g1 - g0) * t) << 8) | Math.round(b0 + (b1 - b0) * t);
}

// 群の色相を、群内での種類の並び順(index/count)に応じた明度違いへ展開する。
function guideKindShade(group: GuideGroupId, index: number, count: number): number {
  const base = GUIDE_GROUP_HUE[group];
  if (count <= 1) return base;
  return lerpColor(base, 0xffffff, 0.15 + 0.5 * (index / (count - 1)));
}

// GuideKindSettings の既定色(始・終)。始は上の shade、終はそこからさらに明るい側を採る。
export function guideKindDefaultColors(group: GuideGroupId, index: number, count: number): readonly [number, number] {
  const start = guideKindShade(group, index, count);
  return [start, lerpColor(start, 0xffffff, 0.35)];
}

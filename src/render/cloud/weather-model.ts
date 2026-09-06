// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流と
// 辿るグラフを TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ空が出る。値はすべて
// 見えのための調整値。
import {
  abs, clamp, cos, dot, exp, float, fract, inverseSqrt, max, min, mix, normalize, sin, smoothstep, tanh,
  uniform,
  vec2, vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { AirMass } from './air-mass';
import { BakedField } from './baked-field';
import { CirculatingNoise, coarsenessFor } from './circulating-noise';
import type { NoiseOctave } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { ConvectiveActivity } from './convective-activity';
import { Cyclones } from './cyclones';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { FRICTION_RATE, balancedWind, isobarAt, windStep } from './wind-law';
import type { ClimateMap } from './climate-map';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、風は東向き・北向きの成分 [m/s]、
// 上昇流は [m/s](地形と気圧による、負なら下降)、湿度は 0..1(humidity が地表付近、
// upperHumidity が上層)、対流は対流セルの強弱(0 中心の高周波、x が粒・y が網目)、対流の活発度は
// その強弱がどれだけ強く現れるか 0..1、圧縮は気団の境目の押し縮まり(1 で何も起きていない)、
// 帯は気団の折り目に立つ雲の帯の強さ 0..1(温帯では前線、眼を持つ渦のまわりでは雨帯。1 で飽和)、
// 暖気の流入は出身地からの緯度の差 [rad](負で寒気)、金床は平らな天蓋の濃さ 0..1、圏界面は
// その緯度の対流の天井 [m]。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly wind: Vec2Node;
  readonly lift: FloatNode;
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: Vec2Node;
  readonly convectiveActivity: FloatNode;
  readonly compression: FloatNode;
  readonly band: FloatNode;
  readonly warmth: FloatNode;
  readonly anvil: FloatNode;
  readonly tropopause: FloatNode;
};

// 気圧の写しから読んだ、風を解くのに要る量。gradient は勾配の接ベクトル [hPa/rad]、isobar は
// 等圧線方向の単位接ベクトル、bend は等圧線方向の 2 階微分 [hPa/rad²]。
type PressureField = {
  readonly pressure: FloatNode;
  readonly gradient: Vec3Node;
  readonly isobar: Vec3Node;
  readonly bend: FloatNode;
};

// 風で流したあとの場。地表付近と上層の湿度は 0..1、対流は 0 中心の高周波(x が粒、y が網目)。
type AdvectedFields = {
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: Vec2Node;
};

// ノイズの段の表。周波数は 1 rad あたりの山の数で、角波長 [km] は 6371 ÷ 周波数。
// 気圧は 1 段しか持たない。総観規模より細かい構造を実際に持たないうえ、上昇流が気圧そのものの
// 関数なので、段を増やすとノイズの格子が雲へそのまま出る。
const PRESSURE_NOISE: readonly NoiseOctave[] = [
  { frequency: 1.2, amplitude: 1 }, // 5300 km
];
// 地表付近は湿度と対流の 2 枚で周波数を分担する。湿度の基準の段(800 km)が雲塊の配置を、中間の段
// (400〜100 km)が雲塊を 100〜300 km の塊へ割る境目を、対流(48 km と 24 km)が積雲の粒の細かさを
// 決める。**中間の段は基準の段より厚く取る** — 100 km から数百 km までの濃淡は薄い雲ではなく厚い雲
// が持つ(`DEVELOP/SPEC/RENDERING.md`「数百キロから 100 km までの濃淡は薄い雲より厚い雲の側が
// 強い」)ので、この帯の取り分は上層から回す。薄いと雲塊は一様な灰色の網目に広がり、実写が白い塊と
// 黒い隙間で持つ 100〜300 km の濃淡が出ない。**厚くした分だけ薄くなるのは先頭の 2 段でよい** —
// 数千 km の晴れと曇りは平年の雲量が別に持つので、気団の規模の濃淡をノイズだけで背負わせない。
// **対流が載るかどうかは写しの texel が決める** — 24 km/texel より粗い写しでは 2 段とも落ちて湿度
// だけの滑らかな塊になり、6 km/texel まで寄れば 2 段とも乗る。上層の濃淡は千 km 級の板(1700 km と
// 800 km の段)がいちばん強く、そこから 400 km・200 km・100 km へ向かって痩せる。薄い雲は大半が
// 下地の透ける靄なので、いちばん細かい段が縁ではなく繊維の濃淡として直に見える。**板の段は地表付近
// の雲塊の配置(800 km)と同じ所まで下ろす** — 数千 km に置くと薄い雲が空をまたぐ 1 枚の幕になり、
// 下の雲塊よりも大きな濃淡を持つ(`DEVELOP/SPEC/RENDERING.md`「板は空をまたぐほど大きくはならず、
// いちばん大きな濃淡でも厚い雲の雲塊の数倍に収まる」)。**数百 km 以下の 3 段は板の段の半分以下に
// 取る** — 厚く取ると板が数百 km の斑に割れ、筋の向きも斑ごとに揃って空の広い範囲で縞になる。
// 薄く取った分だけ薄い雲はその尺度でなだらかになり、下の厚い雲が割れて見える。いちばん細かい段は
// 地表付近の湿度と同じ周波数に留める — 湿度の写しの粗さは 2 つの表のいちばん細かい段が決めるので、
// 上層だけ細かくすると写しの texel 数が増える。
// **地表付近の表の先頭には気団・気候の規模(3200 km)の段を置く** — 晴れと曇りの境がこの規模でも
// 移る。取り分は基準の段(800 km)より小さく取る — 大きく取ると惑星規模の濃淡が実写の数倍になり、
// 空が数個の巨大な塊に割れる。上層で同じ役をするのは平年の雲量なので、ノイズの先頭は千 km 級に
// 留める。
const HUMIDITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 2, amplitude: 0.4 }, // 3200 km
  { frequency: 8, amplitude: 0.8 }, // 800 km
  { frequency: 16, amplitude: 1.5 }, // 400 km
  { frequency: 32, amplitude: 1.35 }, // 200 km
  { frequency: 64, amplitude: 1.0 }, // 100 km
];
const CONVECTION_NOISE: readonly NoiseOctave[] = [
  { frequency: 133, amplitude: 1 }, // 48 km
  { frequency: 266, amplitude: 0.65 }, // 24 km
];
const UPPER_HUMIDITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 3.75, amplitude: 0.45 }, // 1700 km
  { frequency: 8, amplitude: 0.7 }, // 800 km
  { frequency: 16, amplitude: 0.28 }, // 400 km
  { frequency: 32, amplitude: 0.18 }, // 200 km
  { frequency: 64, amplitude: 0.23 }, // 100 km
];
// 場の振れ幅。CirculatingNoise が段の振幅の総和で割って返すので、段数を変えてもここは動かない。
const PRESSURE_NOISE_AMPLITUDE = 18;
const HUMIDITY_NOISE_AMPLITUDE = 0.5625;
const CONVECTION_NOISE_AMPLITUDE = 0.30;
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.65625;

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限で、低気圧側は圧力の尺度
// [hPa] ごとに e 倍に伸びる。上昇は狭く強く、下降は広く弱いので、写像は原点で非対称に取る。
// 利得を上げると低気圧が湿度へ飽和した円盤を書き、流入が巻き込んだ渦をその上から塗り潰す
// — 渦の見えは、滑らかな円盤ではなく、流入が既にある雲を縮める分から出る。尺度は、並の低気圧の
// 芯(24 hPa)で 0.03 m/s になる長さ。
const PRESSURE_LIFT_GAIN = 0.02;
const PRESSURE_LIFT_SCALE = 27;
// 上昇流の頭打ち [m/s]。急な斜面へ強い風が当たる所と深い谷の芯では上昇流が並の何倍にもなり、
// 線形のままだと湿度が 0/1 で切れて硬い縁の白い塊になる。漸近させて、並の上昇流はほぼ素通しにする。
const LIFT_LIMIT = 0.06;
// 前線の帯。気団の圧縮が効き始めを超えてから幅ぶん進む所まで、帯の強さが 0 から 1 へ渡る。前線は
// 低気圧を囲む閉じた流れ(猫の目)の縁に沿う浅い弧に立つ。効き始めは、低気圧から離れた 35〜60° の
// 帯が背景として持つ圧縮(90 パーセンタイルの実測 1.19〜1.28)の 2 割上に取る — ここを下げると
// 気団の境目ではなく空の半分が前線になる。**幅は、折り目の丘そのものが飽和する狭さに取る** —
// 圧縮の稜線は線ではなく幅 500〜600 km の丘で、その頂点(99 パーセンタイルの実測 2.3〜2.7)だけを
// 飽和させると、帯は丘の芯を走る細い筋になっていちばん白い所が帯の幅を持たない
// (`DEVELOP/SPEC/RENDERING.md`「いちばん白い芯も帯の幅いっぱいを占め」)。上端は、35〜60° の帯の
// 4%(北)・7%(南)が飽和する高さ。**幅を狭めても帯が湿度へ足す総量は動かない** — 飽和する面が
// 広がった分だけ半端な強さの裾が痩せるので、同じ量が細い筋から幅のある面へ移るだけになる。
const FRONT_ONSET = 1.45;
const FRONT_WIDTH = 0.35;
// 雨帯。眼を持つ渦が周りの気団を巻き込んで折り畳んだ筋で、圧縮は前線の帯より桁が大きい(台風の芯から
// ±1180 km では 45% が 2 を超え、腕の稜線は 5〜9)。効き始めは稜線の下端に置き、幅は稜線の中でいちばん
// 押し縮まった区間だけが帯として飽和して、腕の先へ向けて連続に薄れる長さに取る — 芯のまわりのシアの丘
// (2〜4)と、渦から離れた熱帯の背景(99.9 パーセンタイルの実測 3.2)には掛からない。ここを狭めると
// 稜線が丸ごと飽和し、腕は太い真っ白な帯になって被覆率が実写の 2 倍を超える(`DEVELOP/SPEC/
// RENDERING.md`「雨帯は、渦が周りの気団を巻き込んで折り畳んだ筋に沿う」)。
const RAINBAND_ONSET = 5;
const RAINBAND_WIDTH = 4;
// 帯が飽和した所で立つ上昇流 [m/s]。頭打ち(LIFT_LIMIT)と同じ高さに取る — 帯の中は深い谷の芯と
// 同じだけ持ち上がる。
const BAND_LIFT = 0.06;
// 帯が飽和した所で地表付近の湿度へ足す底上げ。被覆率の伝達関数の幅(0.22)の 1.4 倍で、帯の芯
// (強さ 1)では帯の上昇流が偏差を増幅する分(VORTEX_CONTRAST)と合わせて被覆率が上端へ届き、途切れない
// 帯になる(`DEVELOP/SPEC/RENDERING.md`「前線の帯そのものが、その空でいちばん厚い雲になる」)。
// 帯の外へ落ちていく縁では底上げも比例して痩せ、移流した湿度の濃淡が階調として残る。
const BAND_HUMIDITY = 0.3;
// 前線が立つ緯度の門。**前線と、その両側の気団の性質はどちらもこの門を通る** — 前線の伝達関数
// (効き始め 1.45)は温帯だけに掛け、熱帯では貿易風の収束が緯線に沿った圧縮の環を作るので、代わりに
// 雨帯の伝達関数(効き始め 4)が眼を持つ渦の腕の稜線だけを拾う。気団の流入も、熱帯では貿易風が
// どこでも高緯度から吹き込むので、門が無いと熱帯全体が一律に乾く。
const FRONT_LATITUDE_START = THREE.MathUtils.degToRad(20);
const FRONT_LATITUDE_FULL = THREE.MathUtils.degToRad(35);
// 風が斜面を駆け上がる分の利得。等倍だと、偏西風や貿易風が山脈へ当たり続けるだけで上昇流が
// 頭打ちに達し、気候と無関係な地形の縞が年中貼り付く。慢性的な湿潤・乾燥は平年の雲量が持つので、
// ここは低気圧が山へぶつかったときだけ効く高さへ落とす。
const TERRAIN_LIFT_GAIN = 0.35;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
// 地形の上昇流は釣り合い風(帯の平均風を含まない)から出るので、低気圧が海から吹き込むときだけ効く。
const LAND_HEIGHT_BIAS = 800;
// 上昇流の利得 [per m/s]。上向きは地表付近と上層の両方を湿らせ、下向きは地表付近だけを乾かす。
// **地表付近の上向きの湿りは、足す分(ここ)と、移流した湿度の偏差を増幅する分(VORTEX_CONTRAST)に
// 分けて持つ。** 足すだけでは渦の上に飽和した円盤を塗り、流入が巻き込んだ筋を消す — 増幅は
// 螺旋を残し、湿った筋をより白く、乾いた隙間をより晴らす。**下降の利得は上昇より小さく取る。**
// 沈降は自由大気を乾かすが、その下の海洋境界層は湿ったまま層積雲を保つ — 同じ利得で乾かすと、
// 亜熱帯高圧帯の下の海が丸ごと晴れる。
const LIFT_HUMIDITY = 1.3;
const SUBSIDENCE_DRYING = 1.0;
const UPPER_LIFT_HUMIDITY = 0.7;
// 上昇流が、移流した地表付近の湿度の偏差(源の底上げ HUMIDITY_BASE からの揺れ)を増幅する利得。
// 頭打ち(LIFT_LIMIT)に張り付いた所で偏差は (1 + 利得) 倍 — 1 で 2 倍になる。
const VORTEX_CONTRAST = 1.0;
// 沈降が上層を乾かす利得 [per m/s]。上層には境界層のような湿りの溜まりが無いので、地表付近より
// 強く乾く — 高気圧の吹きおろす所では薄い雲も消える。
const UPPER_SUBSIDENCE_DRYING = 2;

// 圏界面の高さ [m] とその緯度依存。熱帯で 16〜17 km、極で 9 km 前後で、亜熱帯のジェットの下で
// 段をなして下がる(NCAR ACOM「Cloud Tops and Tropopause」)。深い対流はここに当たって横へ広がる
// ので、対流の天井そのものになる。
const TROPOPAUSE_EQUATOR = 17000;
const TROPOPAUSE_POLE = 9000;
const TROPOPAUSE_STEP_START = THREE.MathUtils.degToRad(15);
const TROPOPAUSE_STEP_END = THREE.MathUtils.degToRad(60);

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。緯度の 6 倍の余弦なので、緯度に
// ついての微分は sin(6 φ) × 6 × 振幅 [hPa/rad]。
const PRESSURE_BAND_AMPLITUDE = 8;

// 大循環の帯の角速度 [°/日] を、この天体の表面での速さ [m/s] へ直す係数。
const BAND_RATE_TO_SPEED = (THREE.MathUtils.degToRad(1) / 86400) * R_EARTH;

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの texel(全球で 6.1e-3 rad)より粗い。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取る刻み [rad]。写しは半精度で、2 階差分に乗る量子化の雑音は刻みの二乗で
// 効く。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;
// 風が等圧線を横切る角の上限 [rad]。湿度を流す風と対流を流す風で別に持つ。湿度の風の上限は中緯度で
// 摩擦が作る角そのもの(45° で 30°)で、熱帯の外では 45° より低緯度の流れが高気圧性に曲がる所でだけ
// 効く(実測: 45°N の低気圧の撮影で風の写しが動くのは texel の 2.6%、それも 5 LSB 以下で、35〜60° の
// 帯の平均は動かない)。対流の風は中緯度で摩擦が作る 60° より内側の 50° に常に抑えられ、湿度の風と
// 向きが 20° 離れたままになる — 2 枚の移流場は同じ向きへ筋を引かず交差する。熱帯(15°)では上限が
// 57° と 78° の流入を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);
const CONVECTION_CROSSING_LIMIT = THREE.MathUtils.degToRad(50);

// 移流の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
// **背景の雲がどれだけ伸びるかを決めるのはここ。** 伸びは 1 歩のあいだに風が空間で変わる量から出る
// ので、風そのものを速くしても増えず、歩を長く取ったぶんだけ増える。
const ADVECTION_PERIOD = 20 * 3600;
// 対流を流す 1 歩を、湿度の 1 歩の何倍の長さに取るか。1 周期の変位が写しに載る粒(48〜24 km)より
// 大きいと、粒は流れの向きへ伸びる。
const CONVECTION_ADVECTION = 1.3;
// 上層の湿度の 1 歩を、地表付近の 1 歩の何倍に取るか。巻雲の繊維は、同じ風の場でも地表付近の
// 雲より長く引き伸ばされる。長く取りすぎると、筋が空の広い範囲で同じ向きに揃った縞になる(実測:
// 200〜400 km の尺度で見た向きの揃いが実写の 1.5〜2 倍)— 筋は板の縁や渦のまわりで向きを変えるもの。
const UPPER_ADVECTION = 1.6;
// 対流の 1 歩が渦のまわりを巻く角の上限 [rad]。台風の芯では流れが 3 周ぶん巻き、半径ごとに違う角だけ
// 捻れた粒が髪のような筋へ潰れる。1 歩をここへ漸近するまで縮めると、縮むのは芯から 600 km の内側だけで、
// 巻きの浅い背景(0.9 rad)は 6% しか変わらない。
const CONVECTION_WINDING = 2.5;
// 渦の目。移流の後の湿度をこれだけ下げる。目は渦とともに動く定常の構造なので、風に流さない。
// 眼壁は上昇流が頭打ちに張り付いて飽和し、その上に金床の天蓋(ANVIL_HUMIDITY)が乗るので、
// 両方を貫く深さが要る。上層を深く引くのは、薄い雲の穴を厚い雲の目よりひとまわり広く開けるため。
const EYE_DRYNESS = 0.8;
const UPPER_EYE_DRYNESS = 2;
// 金床の天蓋が地表付近の湿度へ足す高さ。天蓋の下の円盤は隙間なく埋まるべきなので、並の湿度からでも
// 雲量が飽和する分を足す。目はこの後に引くので、天蓋を貫いて開く深さは EYE_DRYNESS が持つ。
const ANVIL_HUMIDITY = 0.5;
// 暖気の流入が地表付近の湿度へ効く利得 [per rad]。36 h の追跡で気団は最大 0.3 rad ぶんの緯度を
// 越えてくるので、並の流入(0.26 rad)で伝達関数の幅の半分ほど動く高さに取る。**この項は
// 平均が 0 ではない** — 暖気の流入する所のほうが広いので、底上げをそのぶん下げて釣り合わせる。
const WARM_HUMIDITY = 0.6;
// 湿度の底上げ(移流前の源が持つ、平年の雲量を抜きにした値)と、移流後に足す平年の雲量の重み。
// 地表付近と上層で別に持つ。重みは、雲量の地理的な差が凝結のしきい値をまたぐ幅に取る — 小さく
// 取ると砂漠にも海と同じだけ雲が湧き、大きく取ると雲の多い海が覆われたまま動かなくなって、
// 平年の雲量図がそのまま貼り付く。底上げは層ごとに合わせる量が違う。地表付近は、重みを変えても
// 平年並みの土地の湿度が動かないように取る(平年の雲量の中央値 0.70 ぶんを差し引き、さらに前線の
// 上昇流と暖気の流入が平均で足す分を差し引く)。上層は、±60° の薄い雲の明るさ(1 − e^−τ)の平均が
// 実写(0.13 付近)に合う高さに実測で取る。
const HUMIDITY_BASE = 0.405;
const MEAN_CLOUDINESS_WEIGHT = 0.30;
const UPPER_HUMIDITY_BASE = 0.42;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.24;
// 平年の雲量を湿度へ渡す S 字の裾と肩。**線形では乾燥帯だけを強く晴らせない** — 砂漠を晴らす
// 重みでは、雲の多い海が覆われたまま動かなくなる。裾は砂漠(0.14)より下、肩は年中曇りの海
// (0.89)の側へ置き、あいだを広く渡す — 幅を狭めると、乾いた大陸(0.43〜0.51)や貿易風帯の海
// (0.50〜0.65)まで裾へ落ちて、砂漠でない土地まで丸ごと雲を失う。
const MEAN_CLOUDINESS_DRY = 0.10;
const MEAN_CLOUDINESS_WET = 0.85;

export class WeatherModel {
  private readonly circulation = new Circulation(SURFACE_BANDS);
  private readonly upperCirculation = new Circulation(UPPER_BANDS);
  private readonly cyclones = new Cyclones();
  // ノイズは焼く先の texel で標本化できない段を畳むので、写しの持ち方が決まってから組む。
  private readonly pressureNoise: CirculatingNoise;
  private readonly humidityNoise: CirculatingNoise;
  private readonly convectionNoise: CirculatingNoise;
  private readonly upperHumidityNoise: CirculatingNoise;
  private readonly pressure: BakedField;
  private readonly humiditySource: BakedField;
  private readonly convectionSource: BakedField;
  private readonly convectiveActivity: ConvectiveActivity;
  private readonly airMass: AirMass;
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方。
  public constructor(private readonly climate: ClimateMap, projection: FieldProjection) {
    const texel = projection.texelAngle;
    // 湿度は雲塊の配置しか持たないので投影より粗くて足りることがあり、同じ細かさを要る対流とは
    // 写しを分ける。
    const humidityCoarseness = coarsenessFor(projection, HUMIDITY_NOISE, UPPER_HUMIDITY_NOISE);
    const convectionCoarseness = coarsenessFor(projection, CONVECTION_NOISE);
    const humidityTexel = texel.mul(humidityCoarseness);
    const convectionTexel = texel.mul(convectionCoarseness);
    this.pressureNoise = new CirculatingNoise(this.circulation, PRESSURE_NOISE, texel);
    this.humidityNoise = new CirculatingNoise(this.circulation, HUMIDITY_NOISE, humidityTexel);
    this.convectionNoise = new CirculatingNoise(this.circulation, CONVECTION_NOISE, convectionTexel);
    this.upperHumidityNoise = new CirculatingNoise(
      this.upperCirculation, UPPER_HUMIDITY_NOISE, humidityTexel);
    // 気圧の写しだけは段ではなく、読む側の中心差分の刻み(GRADIENT_STEP)が細かさを決める。
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, 1, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
    this.humiditySource = new BakedField(
      'humiditySource', THREE.RGFormat, projection, humidityCoarseness,
      (direction) => vec4(this.humiditySourceAt(direction), 0, 1));
    this.convectionSource = new BakedField(
      'convectionSource', THREE.RGFormat, projection, convectionCoarseness,
      (direction) => vec4(this.convectionSourceAt(direction), 0, 1));
    this.convectiveActivity = new ConvectiveActivity(this.circulation, projection);
    this.airMass = new AirMass(projection, (direction) => this.traceFlowAt(direction));
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.pressure.render(renderer);
    // 気団は気圧の写しを読んで遡るので、気圧の後に焼く。
    this.airMass.bake(renderer);
    this.humiditySource.render(renderer);
    this.convectionSource.render(renderer);
    this.convectiveActivity.bake(renderer);
  }

  // 時刻 [s] を uniform へ写す。
  public syncTime(seconds: number): void {
    this.circulation.syncTime(seconds);
    this.upperCirculation.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    const { pressure, gradient, isobar, bend } = this.pressureFieldAt(direction, east, north);

    // 湿度と対流は、摩擦の違う 2 本の風で流す。上層の湿度はそこへ上層の帯の平均風を足した風で流す
    // — 巻雲の繊維はジェットに沿って伸びるので、地表付近の風で流すと向きが揃わない。
    const wind = balancedWind(gradient, isobar, bend, latitude, FRICTION_RATE, WIND_CROSSING_LIMIT);
    const convectionWind = balancedWind(
      gradient, isobar, bend, latitude, CONVECTION_FRICTION, CONVECTION_CROSSING_LIMIT,
    );
    const upperMean = this.upperCirculation.meanWindAt(direction);
    const upperWind: BalancedWind = {
      velocity: wind.velocity
        .add(east.mul(upperMean.x.mul(cos(latitude)).mul(BAND_RATE_TO_SPEED)))
        .add(north.mul(upperMean.y.mul(BAND_RATE_TO_SPEED))),
      turn: wind.turn,
    };

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分と、気団の境目が押し上げる分。
    const windComponents = eastNorthComponents(wind.velocity, east, north);
    const airMass = this.airMass.at(direction, latitude);
    const extratropical = smoothstep(FRONT_LATITUDE_START, FRONT_LATITUDE_FULL, abs(latitude));
    const warmth = airMass.warmth.mul(extratropical);
    const terrainLift = dot(windComponents, this.climate.slope(direction, LAND_HEIGHT_BIAS)).mul(TERRAIN_LIFT_GAIN);
    // 折り目の帯: 温帯では前線の伝達関数が、熱帯では雨帯の伝達関数が、圧縮の稜線を帯の強さへ写す。
    const front = smoothstep(FRONT_ONSET, FRONT_ONSET + FRONT_WIDTH, airMass.compression).mul(extratropical);
    const rainband = smoothstep(RAINBAND_ONSET, RAINBAND_ONSET + RAINBAND_WIDTH, airMass.compression)
      .mul(extratropical.oneMinus());
    const band = min(front.add(rainband), 1);
    const bandLift = band.mul(BAND_LIFT);
    const lift = limitLift(terrainLift.add(liftFromPressure(pressure)).add(bandLift));

    // 湿度は、風で流した写しへ、その場の平年の雲量と上昇流と金床を足し、渦の目のぶんを引いたもの。
    // 写しの偏差は上昇流が増幅する。写し以外は移流を通らないので、気候と地形と渦に貼り付いたまま
    // 歪まない。
    const advected = this.advected(direction, wind, upperWind, convectionWind);
    const meanCloudiness = this.climate.meanCloudiness(direction);
    const eye = this.cyclones.eyeAt(direction);
    const anvil = this.cyclones.anvilAt(direction);
    const deviation = advected.humidity.sub(HUMIDITY_BASE);
    const humidity = clamp(
      advected.humidity.add(deviation.mul(max(lift, 0).div(LIFT_LIMIT)).mul(VORTEX_CONTRAST))
        .add(cloudinessBias(meanCloudiness).mul(MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(LIFT_HUMIDITY)).add(min(lift, 0).mul(SUBSIDENCE_DRYING))
        .add(warmth.mul(WARM_HUMIDITY)).add(band.mul(BAND_HUMIDITY))
        .add(anvil.mul(ANVIL_HUMIDITY)).sub(eye.mul(EYE_DRYNESS)), 0, 1);
    const upperHumidity = clamp(
      advected.upperHumidity.add(cloudinessBias(meanCloudiness).mul(UPPER_MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)).add(min(lift, 0).mul(UPPER_SUBSIDENCE_DRYING))
        .sub(eye.mul(UPPER_EYE_DRYNESS)), 0, 1);

    return {
      pressure,
      wind: windComponents,
      lift,
      humidity,
      upperHumidity,
      convection: advected.convection,
      convectiveActivity: this.convectiveActivity.at(
        direction, lift, warmth, this.climate.landFraction(direction), band),
      compression: airMass.compression,
      band,
      warmth,
      anvil,
      tropopause: tropopauseAt(latitude),
    };
  }

  // 単位方向 direction(接平面の東 east・北 north)における気圧の写しの読み。4 点差分から勾配を、
  // 等圧線方向の 2 点差分からその向きの 2 階微分を取る。
  private pressureFieldAt(direction: Vec3Node, east: Vec3Node, north: Vec3Node): PressureField {
    const pressure = this.pressure.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressure.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.pressure.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.pressure.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.pressure.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    // 曲がりは等圧線に沿って測る — 勾配の向きに測ると、谷の深さそのものを曲がりとして拾う。
    const isobar = isobarAt(direction, gradient);
    const isobarStep = isobar.mul(BEND_STEP);
    const pressureAhead = this.pressure.at(normalize(direction.add(isobarStep))).r;
    const pressureBehind = this.pressure.at(normalize(direction.sub(isobarStep))).r;
    return { pressure, gradient, isobar, bend: pressureAhead.add(pressureBehind).sub(pressure.mul(2)).div(BEND_STEP ** 2) };
  }

  // 単位方向 direction における気団を遡らせる風(東向き・北向きの成分 [m/s])。
  public traceWindAt(direction: Vec3Node): Vec2Node {
    return eastNorthComponents(this.traceFlowAt(direction).velocity, eastAt(direction), northAt(direction));
  }

  // 気団を風上へ遡らせる風。**経度に依らない流れをすべて落とし、渦と総観規模の擾乱だけで遡る。**
  // 気圧の勾配からは大循環の気圧帯を差し引き、帯の平均風は東向きの成分だけを足す — どちらも
  // 南北の成分は経度に依らないので、残すと収束する緯度に緯線に沿った圧縮の環と、緯度で決まる
  // 気団の流入の偏りができる。東西の流れが緯度で変わる分は残す。渦の作った気団の境目を
  // 南西–北東へ傾けるのがそれで、経度に依らない流れでも圧縮は作らない。
  // **移流の風には平均風を足さない** — 2 位相移流へ入れると、位相 A と B が数百 km ずれた別の
  // 模様を混ぜることになり、背景が全域でぼける。
  private traceFlowAt(direction: Vec3Node): BalancedWind {
    const east = eastAt(direction);
    const north = northAt(direction);
    const latitude = latitudeOf(direction);
    const { gradient, bend } = this.pressureFieldAt(direction, east, north);
    // 気圧帯は緯度だけの関数なので、その勾配は解析的に差し引ける。
    const eddy = gradient.sub(north.mul(sin(latitude.mul(6)).mul(6 * PRESSURE_BAND_AMPLITUDE)));
    const wind = balancedWind(
      eddy, isobarAt(direction, eddy), bend, latitude, FRICTION_RATE, WIND_CROSSING_LIMIT,
    );
    return {
      velocity: wind.velocity.add(east.mul(this.meanWindAt(direction).x)),
      turn: wind.turn,
    };
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE))
      .add(this.cyclones.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。ここへ入れたものが風で流れる。
  //
  // **平年の雲量はここへ入れない。** 移流の変位は雲を筋に引くのに要る大きさなので、通すと気候の
  // 分布がその変位ぶん歪んで読めなくなる — 慢性的な湿潤・乾燥は場所に貼り付いているべきもので、
  // 流れていくものではない。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return vec2(
      float(HUMIDITY_BASE).add(this.humidityNoise.at(direction).mul(HUMIDITY_NOISE_AMPLITUDE)),
      float(UPPER_HUMIDITY_BASE).add(this.upperHumidityNoise.at(direction).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE)),
    );
  }

  // 単位方向 direction における大循環の平均風(東向き・北向きの成分 [m/s])。
  public meanWindAt(direction: Vec3Node): Vec2Node {
    // 東西は緯線に沿って進むので、同じ角速度でも高緯度ほど遅い。
    const mean = this.circulation.meanWindAt(direction);
    return vec2(mean.x.mul(cos(latitudeOf(direction))), mean.y).mul(BAND_RATE_TO_SPEED);
  }

  // 移流前の対流の強弱(0 中心の高周波)。x が粒(細胞の芯)、y が網目(細胞の壁)で、**同じ
  // 勾配ノイズから出るので 1 回の評価で両方が積める。** 湿度と別の写しへ焼き、別の風で流す。
  public convectionSourceAt(direction: Vec3Node): Vec2Node {
    return this.convectionNoise.pairAt(direction).mul(CONVECTION_NOISE_AMPLITUDE);
  }

  // 移流前の写しを風で流したもの。周期の半分ずれた 2 位相を三角波で混ぜるので、流れの変位が
  // 周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。地表付近の湿度・上層の湿度・
  // 対流は向きも速さも違う風で流すので、伸びた先でも 3 枚の向きが揃わない。
  private advected(
    direction: Vec3Node, wind: BalancedWind, upperWind: BalancedWind, convectionWind: BalancedWind,
  ): AdvectedFields {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // seconds 秒だけ flow に流された点の source。負に取れば風上へ遡る。
    const sourceAt = (source: BakedField, flow: BalancedWind, seconds: FloatNode): Vec4Node =>
      source.at(normalize(direction.add(windStep(flow, direction, seconds).div(R_EARTH))));
    // 遡る秒数 [s](負)。位相が周期の終わりへ近づくほど遠くまで遡る。
    const stepA = phaseA.mul(-ADVECTION_PERIOD);
    const stepB = phaseB.mul(-ADVECTION_PERIOD);
    // 対流の 1 歩の倍率。巻きが CONVECTION_WINDING を超える渦の中だけ縮み、超えない所では
    // CONVECTION_ADVECTION 倍のまま。
    const winding = abs(convectionWind.turn).mul(ADVECTION_PERIOD * CONVECTION_ADVECTION / CONVECTION_WINDING);
    const convectionStep = inverseSqrt(winding.mul(winding).add(1)).mul(CONVECTION_ADVECTION);
    const humidity = this.humiditySource;
    const convection = this.convectionSource;
    return {
      humidity: mix(sourceAt(humidity, wind, stepB).x, sourceAt(humidity, wind, stepA).x, weightA),
      upperHumidity: mix(
        sourceAt(humidity, upperWind, stepB.mul(UPPER_ADVECTION)).y,
        sourceAt(humidity, upperWind, stepA.mul(UPPER_ADVECTION)).y, weightA),
      convection: mix(
        sourceAt(convection, convectionWind, stepB.mul(convectionStep)).rg,
        sourceAt(convection, convectionWind, stepA.mul(convectionStep)).rg, weightA),
    };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.pressure.dispose();
    this.humiditySource.dispose();
    this.convectionSource.dispose();
    this.convectiveActivity.dispose();
    this.airMass.dispose();
  }
}

// 接ベクトル v の東向き・北向きの成分。
function eastNorthComponents(v: Vec3Node, east: Vec3Node, north: Vec3Node): Vec2Node {
  return vec2(dot(v, east), dot(v, north));
}

// 平年の雲量 0..1 が湿度へ渡す偏り ±0.5。乾燥帯で −0.5、年中曇りの土地で +0.5 に振り切る。
function cloudinessBias(meanCloudiness: FloatNode): FloatNode {
  return smoothstep(MEAN_CLOUDINESS_DRY, MEAN_CLOUDINESS_WET, meanCloudiness).sub(0.5);
}

// 緯度 [rad] における圏界面の高さ [m]。
function tropopauseAt(latitude: FloatNode): FloatNode {
  const drop = smoothstep(TROPOPAUSE_STEP_START, TROPOPAUSE_STEP_END, abs(latitude));
  return drop.mul(TROPOPAUSE_POLE - TROPOPAUSE_EQUATOR).add(TROPOPAUSE_EQUATOR);
}

// 気圧の偏差 [hPa] が生む上昇流 [m/s]。低気圧で正、高気圧で負。
function liftFromPressure(pressure: FloatNode): FloatNode {
  return exp(pressure.div(-PRESSURE_LIFT_SCALE)).sub(1).mul(PRESSURE_LIFT_GAIN);
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}

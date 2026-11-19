// 生成モデルの調整値をいじるスライダーの表。値そのものの正本は
// src/render/earth-weather/cloud-tuning.ts の CLOUD_TUNING_DEFAULTS で、ここはつまみの表示名と
// 属するサブタブと章、ホバー説明、目盛りだけを持つ。
import type { CloudTuningId } from '../../src/render/earth-weather/cloud-tuning';

// スライダーを置くサブタブ(分野)。並びはモデルの段の流れ(気象 → 移流 → 凝結、対流は横断)。
export const GENERATION_PARAM_TABS = [
  { id: 'weather', label: '気象' },
  { id: 'front', label: '前線' },
  { id: 'source', label: '上昇源' },
  { id: 'humidity', label: '湿度' },
  { id: 'transport', label: '移流' },
  { id: 'coverage', label: '被覆率' },
  { id: 'layer', label: '層・塔' },
  { id: 'ice', label: '氷雲' },
  { id: 'cell', label: 'セル径' },
  { id: 'convection', label: '対流' },
] as const;

export type GenerationParamTab = typeof GENERATION_PARAM_TABS[number]['id'];

export interface GenerationParamSpec {
  readonly label: string;
  // 属するサブタブ。
  readonly tab: GenerationParamTab;
  // サブタブの中の章の名前。同じ名前の項目がまとまり、初めて現れた順に並ぶ。
  readonly section: string;
  // ホバーで出す説明。何を決める値か・上げると何が起きるか・単位を、コードの該当箇所から書く。
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

// range は値を動かしてよい幅であって、物理的に正しい範囲ではない。
export const GENERATION_PARAMS: Record<CloudTuningId, GenerationParamSpec> = {
  // 気象 — 気圧と上昇流
  pressureNoiseAmplitude: {
    label: '気圧の振幅 [hPa]', tab: 'weather', section: '気圧と上昇流',
    description: '気圧の偏差へ足す大きなノイズ(波長約 5300 km)の振れ幅 [hPa]。上げると気圧の谷と峰の起伏が強まり、そこから出る上昇流も変わる。',
    min: 0, max: 40, step: 0.5,
  },
  pressureBandAmplitude: {
    label: '大循環の気圧帯 [hPa]', tab: 'weather', section: '気圧と上昇流',
    description: '大循環の気圧帯の振幅 [hPa]。赤道と ±60° を低く、±30° と極を高くする、緯度方向の縞の強さを決める。',
    min: 0, max: 20, step: 0.25,
  },
  pressureLiftGain: {
    label: '上昇流の利得', tab: 'weather', section: '気圧と上昇流',
    description: '気圧の偏差から出る上昇流の利得 [m/s]で、高気圧側の吹きおろしの上限になる。上げすぎると低気圧が飽和した円盤になり、渦を塗り潰す。',
    min: 0, max: 0.08, step: 0.001,
  },
  pressureLiftScale: {
    label: '上昇流の尺度 [hPa]', tab: 'weather', section: '気圧と上昇流',
    description: '低気圧側の上昇流が、気圧の落ち込みこの [hPa] ごとに e 倍へ伸びる尺度。小さいほど、谷が深いほど上昇流が急に強まる。',
    min: 5, max: 80, step: 1,
  },
  liftLimit: {
    label: '上昇流の頭打ち [m/s]', tab: 'weather', section: '気圧と上昇流',
    description: '上昇流を漸近させる上限 [m/s]。急な斜面や深い谷の芯で湿度が 0/1 で切れ、硬い縁の白い塊になるのを丸めて防ぐ。',
    min: 0.01, max: 0.2, step: 0.002,
  },
  terrainLiftGain: {
    label: '地形の上昇の利得', tab: 'weather', section: '気圧と上昇流',
    description: '風が斜面を駆け上がる分が上昇流になる利得。等倍だと山脈へ当たる風だけで頭打ちになり、地形の縞が年中貼り付く。',
    min: 0, max: 1.2, step: 0.02,
  },

  // 前線 — 前線系全体
  frontArmWidth: {
    label: '前線の帯の半値幅 [半径]', tab: 'front', section: '前線系全体',
    description: '前線の腕に垂直な方向の帯の幅(谷の短軸の半径の倍率)。大きいほど寒冷・温暖・閉塞のどの腕も太い帯になる。',
    min: 0.05, max: 1, step: 0.01,
  },
  frontBandSkew: {
    label: '前線の帯の偏り', tab: 'front', section: '前線系全体',
    description: '帯の幅の左右差。進行側(循環の向き)は幅が 1+値 倍に広がり、追い越される側は 1−値 倍に窄まる。0 で左右対称。',
    min: 0, max: 0.9, step: 0.01,
  },
  frontEdgeSpeed: {
    label: '循環の縁の速さ [m/s]', tab: 'front', section: '前線系全体',
    description: '前線の腕が届く外縁を決める循環の風速 [m/s]。腕は循環の風がこの速さを下回る半径まで届く。小さいほど腕が遠くまで延びる。',
    min: 0.5, max: 10, step: 0.1,
  },
  frontWarmRatio: {
    label: '温暖前線の長さ比', tab: 'front', section: '前線系全体',
    description: '温暖前線が届く長さの、寒冷前線に対する比。温暖前線は寒冷前線より短く、閉塞点から浅い弧を描く。',
    min: 0.3, max: 1, step: 0.01,
  },

  // 前線 — 寒冷前線
  frontColdAngleDeg: {
    label: '寒冷前線の根元の向き [°]', tab: 'front', section: '寒冷前線',
    description: '寒冷前線の根元の向き [°]。下流(東)から循環の向き(反時計)を正に取る。三点が出ると三点の向きへ寄る。',
    min: -160, max: -40, step: 1,
  },
  frontColdTipAngleDeg: {
    label: '寒冷前線の先端の向き [°]', tab: 'front', section: '寒冷前線',
    description: '寒冷前線の先端の向き [°]。腕の向きは根元からこの向きへ半径に沿って曲がる。閉塞が進むと追いつきの角が上乗せされる。',
    min: -180, max: 0, step: 1,
  },
  frontColdBend: {
    label: '寒冷前線の曲がり [冪]', tab: 'front', section: '寒冷前線',
    description: '寒冷前線の向きが根元から先端へ変わる進み方の冪。大きいほど根元の向きが長く続き、先端に近い所で急に曲がる。',
    min: 0.5, max: 4, step: 0.05,
  },

  // 前線 — 温暖前線
  frontWarmAngleDeg: {
    label: '温暖前線の根元の向き [°]', tab: 'front', section: '温暖前線',
    description: '温暖前線の根元の向き [°]。下流(東)から循環の向き(反時計)を正に取る。三点が出ると三点の向きへ寄る。',
    min: -30, max: 60, step: 1,
  },
  frontWarmTipAngleDeg: {
    label: '温暖前線の先端の向き [°]', tab: 'front', section: '温暖前線',
    description: '温暖前線の先端の向き [°]。下流(東)から反時計を正に取り、腕の向きは根元からこの向きへ半径に沿って曲がる。',
    min: 0, max: 120, step: 1,
  },
  frontWarmBend: {
    label: '温暖前線の曲がり [冪]', tab: 'front', section: '温暖前線',
    description: '温暖前線の向きが根元から先端へ変わる進み方の冪。大きいほど根元の向きが長く続き、先端に近い所で急に曲がる。',
    min: 0.5, max: 4, step: 0.05,
  },

  // 前線 — 閉塞・三点
  frontTripleRadius: {
    label: '閉塞点の半径 [半径]', tab: 'front', section: '閉塞・三点',
    description: '閉塞が進み切ったときの三点(閉塞点)の、芯からの距離(谷の短軸の半径の倍率)。閉塞の進みに比例して芯の外へ出る。',
    min: 0, max: 4, step: 0.05,
  },
  frontTripleAngleDeg: {
    label: '閉塞点の向き [°]', tab: 'front', section: '閉塞・三点',
    description: '三点の向き [°]。下流(東)から反時計を正に取り、閉塞の腕の根元と、三点へ繋がる寒冷・温暖の腕の根元の向きを決める。',
    min: -90, max: 0, step: 1,
  },
  frontOccSwingDeg: {
    label: '閉塞前線の振り [°]', tab: 'front', section: '閉塞・三点',
    description: '閉塞の腕が三点から芯へ向かうにつれて循環側へ振れる角 [°]。芯に近い所で三点の向きからこの角だけずれる。',
    min: 0, max: 180, step: 5,
  },
  frontOccBend: {
    label: '閉塞前線の曲がり [冪]', tab: 'front', section: '閉塞・三点',
    description: '閉塞の腕の振れが、三点から芯へ向かって増える進み方の冪。1 で直線的に振れ、大きいほど芯の近くで急に振れる。',
    min: 0.5, max: 3, step: 0.05,
  },

  // 前線 — 尾(熱帯の渦)
  frontTailLatitudeStartDeg: {
    label: '尾の緯度の門(始) [°]', tab: 'front', section: '熱帯の渦の尾',
    description: '熱帯の渦の尾が立ち始める緯度 [°]。この緯度までは尾の帯が 0 で、終の緯度へ向けて滑らかに立ち上がる。',
    min: 0, max: 40, step: 0.5,
  },
  frontTailLatitudeFullDeg: {
    label: '尾の緯度の門(終) [°]', tab: 'front', section: '熱帯の渦の尾',
    description: '熱帯の渦の尾が全開になる緯度 [°]。温帯へ近づくにつれて尾が育ち、この緯度で帯の強さが深さ通りになる。',
    min: 5, max: 45, step: 0.5,
  },

  // 前線 — 雨帯と帯の効き
  rainbandOnset: {
    label: '雨帯の開始閾値', tab: 'front', section: '雨帯と帯の効き',
    description: '雨帯が立ち始める気団の圧縮の値。腕の稜線(5〜9)だけを拾い、芯のまわりのシアの丘(2〜4)や熱帯の背景を拾わない高さに置く。',
    min: 1, max: 12, step: 0.1,
  },
  rainbandWidth: {
    label: '雨帯の遷移幅', tab: 'front', section: '雨帯と帯の効き',
    description: '雨帯が 0 から飽和へ立ち上がる気団の圧縮の幅。稜線の最も押し縮まった区間だけが飽和する幅に取り、狭めると腕が太い真っ白な帯になる。',
    min: 0.5, max: 10, step: 0.1,
  },
  bandLift: {
    label: '帯の上昇流 [m/s]', tab: 'front', section: '雨帯と帯の効き',
    description: '前線や雨帯の帯が飽和した所で立つ上昇流 [m/s]。深い谷の芯と同じだけ持ち上げるよう、上昇流の頭打ちに揃えてある。',
    min: 0, max: 0.15, step: 0.002,
  },

  // 上昇源 — 過渡源
  transientGain: {
    label: '過渡源の強さ', tab: 'source', section: '過渡源',
    description: '平地や海上に数時間〜日持続する、200〜800 km の過渡的な上昇源が供給する湿りの強さ。',
    min: 0, max: 1, step: 0.01,
  },
  transientActivityOnset: {
    label: '過渡源の門(始)', tab: 'source', section: '過渡源',
    description: '過渡源の活動度の門の始め。ノイズ(−1〜1 を 0〜1 へ写したもの)がこの値を渡り始めると源が 0 から立つ。',
    min: 0, max: 1, step: 0.01,
  },
  transientActivityFull: {
    label: '過渡源の門(終)', tab: 'source', section: '過渡源',
    description: '過渡源の活動度の門の終わり。ノイズがこの値に達すると源が全開になる。始との間が狭いほど源の縁が硬い。',
    min: 0, max: 1, step: 0.01,
  },

  // 上昇源 — 日射加熱
  landHeatingGain: {
    label: '日射加熱の強さ', tab: 'source', section: '日射加熱',
    description: '島や陸の日射加熱が供給する湿りの強さ。地方太陽時で昼過ぎを中心にした窓(9 時〜18 時)の間だけ、陸らしさに応じて足される。',
    min: 0, max: 1.5, step: 0.01,
  },

  // 上昇源 — 地形性上昇
  orographicGain: {
    label: '地形性上昇→湿度', tab: 'source', section: '地形性上昇',
    description: '風が地形を越えて駆け上がる成分(回された後の風)を湿りの供給へ換算する利得。陸だけに効き、堰き止められた所では上りが消える。',
    min: 0, max: 8, step: 0.05,
  },
  reliefLength: {
    label: '地形の裾野 [m]', tab: 'source', section: '地形性上昇',
    description: '細かい勾配から地形の比高を見積もる裾野の半幅 [m]。勾配 × この長さを高さと見なし、風の迂回と山地の判定に使う。',
    min: 5000, max: 100000, step: 1000,
  },

  // 上昇源 — プルームの減衰
  plumeDecaySeconds: {
    label: 'プルームの時定数 [s]', tab: 'source', section: 'プルームの減衰',
    description: '上昇源が供給した湿りが風下へ運ばれる間の減衰の時定数 [s]。プルームがどこまで尾を引くかを決める。',
    min: 3600, max: 72000, step: 900,
  },

  // 上昇源 — 雨陰
  rainoutGain: {
    label: '降水の乾き', tab: 'source', section: '雨陰',
    description: '風上の降水が湿度から奪う乾きの利得。地形へ吹き付ける上り成分 × 周囲の湿りを乾きへ換算し、高い地形ほど風下が乾く。',
    min: 0, max: 8, step: 0.05,
  },
  rainoutDecaySeconds: {
    label: '雨陰の時定数 [s]', tab: 'source', section: '雨陰',
    description: '降水で生じた乾きが風下へ残る時定数 [s]。プルームより長く取り、乾いた空気が海上で湿りを取り戻すまでの時間を表す。',
    min: 3600, max: 200000, step: 1800,
  },

  // 湿度 — 上昇・沈降の寄与
  surfaceSubsidenceDrying: {
    label: '地表の沈降→乾き', tab: 'humidity', section: '上昇・沈降の寄与',
    description: '沈降が地表付近の湿度を乾かす利得。上昇側より弱く取る — 同じ利得だと亜熱帯高圧帯の下の海が丸ごと晴れる。',
    min: 0, max: 4, step: 0.05,
  },
  upperLiftHumidity: {
    label: '上層の上昇→湿度', tab: 'humidity', section: '上昇・沈降の寄与',
    description: '上昇流が上層の湿度へ足す利得。正の上昇流に比例して上層が湿り、薄い雲が出やすくなる。',
    min: 0, max: 3, step: 0.05,
  },
  upperSubsidenceDrying: {
    label: '上層の沈降→乾き', tab: 'humidity', section: '上昇・沈降の寄与',
    description: '沈降が上層を乾かす利得 [per m/s]。地表付近より強く取り、高気圧の吹きおろす所では薄い雲も消える。',
    min: 0, max: 6, step: 0.1,
  },
  vortexContrast: {
    label: '渦の湿度の増幅', tab: 'humidity', section: '上昇・沈降の寄与',
    description: '上昇流が地表付近の湿度の偏差(基底からの揺れ)を増幅する利得。上昇流が頭打ちの所で偏差が 1+値 倍になる。',
    min: 0, max: 4, step: 0.05,
  },

  // 湿度 — 暖気と渦の寄与
  warmHumidity: {
    label: '暖気流入→湿度', tab: 'humidity', section: '暖気と渦の寄与',
    description: '暖気の流入が地表付近の湿度へ寄与する伝達利得 [per rad]。閉塞した芯の内側では暖域が切り離されて止まる。',
    min: 0, max: 2, step: 0.02,
  },
  anvilHumidity: {
    label: '金床→湿度', tab: 'humidity', section: '暖気と渦の寄与',
    description: '金床(渦の芯が敷く平らな天蓋)が地表付近の湿度へ足す高さ。天蓋の芯で雲量が飽和する分を、天蓋の濃さに応じて足す。',
    min: 0, max: 0.8, step: 0.01,
  },
  surfaceEyeDryness: {
    label: '目の乾き(地表)', tab: 'humidity', section: '暖気と渦の寄与',
    description: '渦の目が地表付近の湿度から引く深さ。眼壁の飽和と金床の天蓋の両方を貫く深さに取る。',
    min: 0, max: 2.5, step: 0.02,
  },
  upperEyeDryness: {
    label: '目の乾き(上層)', tab: 'humidity', section: '暖気と渦の寄与',
    description: '渦の目が上層の湿度から引く深さ。地表より深く引き、薄い雲の穴を厚い雲の目よりひとまわり広く開ける。',
    min: 0, max: 6, step: 0.05,
  },

  // 湿度 — 平年の雲量
  surfaceMeanCloudinessWeight: {
    label: '平年雲量の重み(地表)', tab: 'humidity', section: '平年の雲量',
    description: '移流後の地表付近の湿度へ足す平年の雲量の重み。小さいと砂漠にも海と同じだけ雲が湧き、大きいと平年の雲量図が貼り付く。',
    min: 0, max: 0.6, step: 0.005,
  },
  upperMeanCloudinessWeight: {
    label: '平年雲量の重み(上層)', tab: 'humidity', section: '平年の雲量',
    description: '移流後の上層の湿度へ足す平年の雲量の重み。薄い雲の分布を平年の雲量図へどれだけ従わせるかを決める。',
    min: 0, max: 0.6, step: 0.005,
  },
  meanCloudinessDry: {
    label: '平年雲量の裾', tab: 'humidity', section: '平年の雲量',
    description: '平年の雲量を湿度の偏りへ渡す S 字の裾。この雲量以下は乾燥帯として −0.5 に振り切る。砂漠(0.14)の下に置く。',
    min: 0, max: 0.4, step: 0.005,
  },
  meanCloudinessWet: {
    label: '平年雲量の肩', tab: 'humidity', section: '平年の雲量',
    description: '平年の雲量を湿度の偏りへ渡す S 字の肩。この雲量以上は年中曇りの土地として +0.5 に振り切る。',
    min: 0.5, max: 1, step: 0.005,
  },

  // 湿度 — 圏界面
  tropopauseEquator: {
    label: '圏界面(赤道) [m]', tab: 'humidity', section: '圏界面',
    description: '赤道の圏界面の高さ [m]。深い対流が当たる天井で、塔の高さの上限と氷雲の放出の基準になる。',
    min: 12000, max: 20000, step: 100,
  },
  tropopausePole: {
    label: '圏界面(極) [m]', tab: 'humidity', section: '圏界面',
    description: '極の圏界面の高さ [m]。緯度 15°〜60° にかけて赤道の値からこの値へ段をなして下がる。',
    min: 6000, max: 14000, step: 100,
  },

  // 移流 — 源の湿度
  surfaceHumidityBase: {
    label: '基底湿度(地表)', tab: 'transport', section: '源の湿度',
    description: '移流前の地表付近の基底湿度。平年の雲量の重みを弱めた分の平均をここで埋める。上げると全体の被覆が増える。',
    min: 0, max: 0.7, step: 0.005,
  },
  upperHumidityBase: {
    label: '基底湿度(上層)', tab: 'transport', section: '源の湿度',
    description: '移流前の上層の基底湿度。巻雲の靄が立つ閾値との差で薄い雲の量が決まり、上げると巻雲が増える。',
    min: 0, max: 0.7, step: 0.005,
  },
  surfaceHumidityNoiseAmplitude: {
    label: '湿度の振れ(地表)', tab: 'transport', section: '源の湿度',
    description: '移流前の地表付近の湿度ノイズの振れ幅。上げると湿った塊と乾いた塊の差が大きくなる。',
    min: 0, max: 1, step: 0.01,
  },
  upperHumidityNoiseAmplitude: {
    label: '湿度の振れ(上層)', tab: 'transport', section: '源の湿度',
    description: '移流前の上層の湿度ノイズの振れ幅。細かい段を足したぶんを補正込みで、全球の写しの振れ幅を保つ値。',
    min: 0, max: 1.2, step: 0.01,
  },
  convectionNoiseAmplitude: {
    label: '対流の振れ', tab: 'transport', section: '源の湿度',
    description: '移流前の対流ノイズ(粒と網目)の振れ幅。被覆率を千切る粒の強さの元になり、大きいほど粒の起伏が強まる。',
    min: 0, max: 0.8, step: 0.01,
  },

  // 移流 — 流し方
  upperAdvection: {
    label: '上層の移流の倍率', tab: 'transport', section: '流し方',
    description: '上層の湿度を流す一歩を、地表付近の一歩の何倍の長さに取るか。大きいほど巻雲の繊維が長く引き伸ばされる。',
    min: 0.5, max: 4, step: 0.05,
  },
  convectionAdvection: {
    label: '対流の移流の倍率', tab: 'transport', section: '流し方',
    description: '対流を流す一歩を、湿度の一歩の何倍の長さに取るか。対流の粒と網目が風にどれだけ引き伸ばされるかを決める。',
    min: 0.5, max: 4, step: 0.05,
  },
  convectionWinding: {
    label: '対流の巻きの上限 [rad]', tab: 'transport', section: '流し方',
    description: '対流の一歩が渦のまわりを巻く角の上限 [rad]。これを超えて強く巻く渦の中だけ、歩幅を縮める。',
    min: 0.5, max: 6, step: 0.1,
  },

  // 被覆率 — 立ち上がり
  coverageOnset: {
    label: '被覆率の閾値', tab: 'coverage', section: '被覆率の立ち上がり',
    description: '被覆率が立ち上がり始める湿度の閾値。上げると同じ湿度で雲が減る。実写統計の平均被覆率に整合するよう調整する値。',
    min: 0.2, max: 0.8, step: 0.005,
  },
  coverageWidth: {
    label: '被覆率の遷移幅', tab: 'coverage', section: '被覆率の立ち上がり',
    description: '湿度が閾値を超えた量をこの幅で正規化して被覆率にする。小さいほど立ち上がりが急で、粒の塊が白く隙間が黒く割れる。',
    min: 0.05, max: 0.5, step: 0.005,
  },
  coverageDispersion: {
    label: '覆いの散らばり', tab: 'coverage', section: '被覆率の立ち上がり',
    description: '雲粒の密度の揺らぎをガンマ分布で混ぜるときの散らばり。裾が代数的になるので、覆われた空の階調が上端で潰れない。',
    min: 0.5, max: 6, step: 0.05,
  },
  coverageExcessPower: {
    label: '超過量の冪', tab: 'coverage', section: '被覆率の立ち上がり',
    description: '晴天率の核が超過量へ掛ける冪。大きいほど湿度の波への被覆率の応答が急になり、長波長の被覆パワーが育つ。',
    min: 0.5, max: 4, step: 0.05,
  },
  convectionGain: {
    label: '対流→湿度の重み', tab: 'coverage', section: '被覆率の立ち上がり',
    description: '湿度へ足す対流(粒)の重み。伝達関数の幅に対して、被覆率をどれだけ深く千切るかを決める。',
    min: 0, max: 3, step: 0.05,
  },

  // 被覆率 — 千切れ方
  bandGrainFade: {
    label: '帯の粒の弱め', tab: 'coverage', section: '千切れ方',
    description: '前線帯・雨帯の中で粒の重みを弱める割合。1 で帯の芯の粒が消え、帯が点描でなく隙間なく連なる面になる。',
    min: 0, max: 1, step: 0.01,
  },
  cellGrainDepth: {
    label: 'セル径→千切りの深さ', tab: 'coverage', section: '千切れ方',
    description: '対流セルの径が被覆率を千切る深さへ効く強さ [per log2(km)]。小さいセルほど深く千切る。0 でセル径は千切りに影響しない。',
    min: 0, max: 0.6, step: 0.01,
  },
  cellGrainFloor: {
    label: 'セル径の変調の下限', tab: 'coverage', section: '千切れ方',
    description: 'セル径による千切りの変調(倍率)の下限。大きなセルや板の空でも、千切りの深さがこの倍率を下回らない。',
    min: 0.1, max: 1, step: 0.01,
  },

  // 被覆率 — 雲頂の効く覆い
  deepCoverageOnset: {
    label: '深い雲の閾値', tab: 'coverage', section: '雲頂の効く覆い',
    description: '雲頂の高さが積雲の量へ効き始める被覆率。これより覆いの薄い柱は、被覆率だけが量を決める。',
    min: 0.3, max: 0.9, step: 0.01,
  },
  deepCoverageFull: {
    label: '深い雲の飽和', tab: 'coverage', section: '雲頂の効く覆い',
    description: '雲頂の高さが積雲の量へ効ききる被覆率。閾値からこの被覆率までの間で、雲頂の量が連続に混ざる。',
    min: 0.6, max: 1, step: 0.005,
  },

  // 層・塔 — 層状の雲の高さ
  cloudBaseHeight: {
    label: '雲底の高さ [m]', tab: 'layer', section: '層状の雲の高さ',
    description: '層状の雲の雲底の高さ [m]。層状の雲の高さは、ここへ上昇流などが決める厚みを積んで出る。',
    min: 0, max: 3000, step: 50,
  },
  layerTopSpan: {
    label: '層状の厚み [m]', tab: 'layer', section: '層状の雲の高さ',
    description: '層状の雲が雲底から伸びうる厚み [m]。上限は前線の乱層雲(4〜8 km)に取り、塔は対流の峰が別に立てる。',
    min: 2000, max: 12000, step: 100,
  },
  cloudTopLift: {
    label: '雲頂←上昇流', tab: 'layer', section: '層状の雲の高さ',
    description: '雲頂の高さへ効く上昇流の重み [per m/s]。上げると上昇流の強い所の層状の雲が高くなる。',
    min: 0, max: 150, step: 1,
  },
  cloudTopRelief: {
    label: '雲頂←対流', tab: 'layer', section: '層状の雲の高さ',
    description: '雲頂の高さへ効く対流の起伏の重み。同じ cap の中で雲頂が 1〜7 km に散る幅を決め、低気圧の上が一様な台地になるのを防ぐ。',
    min: 0, max: 80, step: 1,
  },
  cloudTopBias: {
    label: '雲頂の底', tab: 'layer', section: '層状の雲の高さ',
    description: '雲頂の高さを決める式から引く底。上げると全体の層状の雲が低くなり、上昇流の無い所の低い積雲が多数派になる。',
    min: 0, max: 5, step: 0.05,
  },
  warmTop: {
    label: '雲頂←暖気流入', tab: 'layer', section: '層状の雲の高さ',
    description: '暖気の流入が層状の雲を持ち上げる重み [per rad]。前線の暖気側で乱層雲の高さ(4〜8 km)へ届く。',
    min: 0, max: 8, step: 0.1,
  },
  bandTop: {
    label: '雲頂←帯', tab: 'layer', section: '層状の雲の高さ',
    description: '前線・雨帯の帯が層状の雲を持ち上げる量。帯の内側で乱層雲から積乱雲の高度(5〜7 km)に達する。',
    min: 0, max: 8, step: 0.1,
  },

  // 層・塔 — 塔
  towerOnset: {
    label: '塔の峰の閾値', tab: 'layer', section: '塔',
    description: '塔が立つ粒の峰(粒 × 活発度)の縁。この値を越えた所から塔が立ち始め、遷移幅の間で全開へ向かう。',
    min: 0, max: 0.1, step: 0.001,
  },
  towerWidth: {
    label: '塔の峰の遷移幅', tab: 'layer', section: '塔',
    description: '塔が 0 から全開へ立つ峰の幅。峰の標準偏差(約 0.1)と同じ程度に広く取らないと、塔が 1 texel の針になって数えるほどしか立たない。',
    min: 0.02, max: 0.3, step: 0.005,
  },
  towerDeepGain: {
    label: '深い対流→塔の峰', tab: 'layer', section: '塔',
    description: '深い対流の起こりやすさが、塔の立つ峰へ足す高さ。日射で温まった陸の午後や暖かい海は、粒の峰が低くても塔が立つ。',
    min: 0, max: 0.3, step: 0.005,
  },
  towerDeepMoist: {
    label: '深い対流→塔の湿り', tab: 'layer', section: '塔',
    description: '深い対流の起こりやすさが、塔の立つ湿りの門へ足す湿度。暖かい海の湿った境界層と昼の陸の湿りが門を開く。',
    min: 0, max: 0.6, step: 0.01,
  },
  towerLiftGate: {
    label: '塔の沈降の門 [m/s]', tab: 'layer', section: '塔',
    description: '塔を閉じる沈降の門 [m/s]。下降流がこの値を超える高気圧の吹きおろす所では、粒の峰が立っても塔が立たない。',
    min: 0, max: 0.03, step: 0.0005,
  },

  // 層・塔 — 層積雲
  stratocumulusSubsidenceScale: {
    label: '層積雲の沈降門', tab: 'layer', section: '層積雲',
    description: '沈降が層積雲の門を開く尺度 [per m/s]。大きいほど、弱い吹きおろしでも門が開く。',
    min: 20, max: 600, step: 5,
  },
  stratocumulusHumidityOnset: {
    label: '層積雲の湿度閾値', tab: 'layer', section: '層積雲',
    description: '層積雲の門が開き始める地表付近の湿度。これ以上の湿りで海洋性層積雲の門が立ち、板へ寄っていく。',
    min: 0, max: 0.7, step: 0.005,
  },
  stratocumulusHumidityWidth: {
    label: '層積雲の湿度幅', tab: 'layer', section: '層積雲',
    description: '層積雲の湿度の門が 0 から全開まで開く湿度の幅。小さいほど湿度の閾値で門が急に開く。',
    min: 0.02, max: 0.6, step: 0.01,
  },
  stratocumulusCloudinessOnset: {
    label: '層積雲の雲量閾値', tab: 'layer', section: '層積雲',
    description: '層積雲の門が開き始める平年の雲量。平年の雲量が高い海ほど、閉じた細胞の板へ寄る。',
    min: 0, max: 0.8, step: 0.005,
  },
  stratocumulusCloudinessWidth: {
    label: '層積雲の雲量幅', tab: 'layer', section: '層積雲',
    description: '層積雲の平年の雲量の門が 0 から全開まで開く雲量の幅。小さいほど雲量の閾値で門が急に開く。',
    min: 0.02, max: 0.6, step: 0.01,
  },
  stratocumulusActivityOnset: {
    label: '層積雲の活発度閾値', tab: 'layer', section: '層積雲',
    description: '対流の活発度がこの値を超えると層積雲の門が閉じ始める。低活発度の空ほど板へ寄る。',
    min: 0, max: 0.8, step: 0.005,
  },
  stratocumulusActivityWidth: {
    label: '層積雲の活発度幅', tab: 'layer', section: '層積雲',
    description: '活発度が上がって層積雲の門が全開から閉じきるまでの活発度の幅。小さいほど門が急に閉じる。',
    min: 0.02, max: 0.9, step: 0.01,
  },
  stratocumulusDeckAdd: {
    label: '層積雲の板の高さ', tab: 'layer', section: '層積雲',
    description: '層積雲の板へ足す湿度の高さ。門が部分的にしか開かない所でも板が一面へ繋がるよう、伝達関数の幅の 1.5 倍強に取る。',
    min: 0, max: 0.8, step: 0.005,
  },

  // 層・塔 — 対流の形
  shapeNetworkHumidity: {
    label: '形(網目側)', tab: 'layer', section: '対流の形(網目と粒)',
    description: '対流の形が網目から粒へ渡り始める湿度。雲の少ない所では細胞の壁(網目)、多い所では芯(粒)が見える。',
    min: 0.1, max: 0.7, step: 0.005,
  },
  shapeGrainHumidity: {
    label: '形(粒側)', tab: 'layer', section: '対流の形(網目と粒)',
    description: '対流の形が粒へ渡り終わる湿度。形は粒を足す前の湿度で決めるので、粒ごとに形が変わらない。',
    min: 0.4, max: 0.95, step: 0.005,
  },

  // 氷雲 — 巻雲の靄
  hazeOnset: {
    label: '靄の閾値', tab: 'ice', section: '巻雲の靄',
    description: '巻雲の靄が立つ上層湿度の閾値。基準の上層湿度より上に取り、全球に一様な薄い幕が乗って乾燥帯が晴れなくなるのを防ぐ。',
    min: 0.1, max: 0.7, step: 0.005,
  },
  hazeGain: {
    label: '靄の利得', tab: 'ice', section: '巻雲の靄',
    description: '上層湿度が閾値を超えた量に比例して、広域に薄い幕を作る利得。靄と筋の利得は同じ率で動かすと薄い雲が一様に薄くなる。',
    min: 0, max: 2, step: 0.02,
  },
  hazeCloudinessOnset: {
    label: '靄の雲量の門(始)', tab: 'ice', section: '巻雲の靄',
    description: '靄が立ち始める平年の雲量。これより乾いた気候の空では靄を抑え、全球に一様な薄い幕が乗るのを防ぐ。',
    min: 0, max: 0.6, step: 0.01,
  },
  hazeCloudinessFull: {
    label: '靄の雲量の門(終)', tab: 'ice', section: '巻雲の靄',
    description: '靄をそのまま信じる平年の雲量。始との間で、乾いた気候から湿った気候へ靄が連続に効いてくる。',
    min: 0, max: 0.8, step: 0.01,
  },

  // 氷雲 — 靄の斑と筋
  cirrusPatchOnset: {
    label: '靄の斑の門(始)', tab: 'ice', section: '靄の斑と筋',
    description: '靄の斑の門の裾(斑の場 −1〜1 の値)。湿った広域が全て幕にならないよう、百キロ級の透き間を空ける。筋には掛けない。',
    min: -1, max: 0.5, step: 0.01,
  },
  cirrusPatchFull: {
    label: '靄の斑の門(終)', tab: 'ice', section: '靄の斑と筋',
    description: '靄の斑の門の肩(斑の場 −1〜1 の値)。裾との間で湿度の縁ほど斑が効き、薄い雲のある所と無い所が入り交じる。',
    min: -0.5, max: 1, step: 0.01,
  },
  streakOnset: {
    label: '筋の閾値', tab: 'ice', section: '靄の斑と筋',
    description: '巻雲の筋が立つ上層湿度の閾値。筋は超過量の二乗に比例し、湿度のピーク部にだけ密な筋状構造を作る。',
    min: 0.1, max: 0.8, step: 0.005,
  },
  streakGain: {
    label: '筋の利得', tab: 'ice', section: '靄の斑と筋',
    description: '筋の項の利得。上層湿度の閾値超過量の二乗に掛かる。靄の利得と同じ率で動かすと薄い雲だけが一様に薄くなる。',
    min: 0, max: 6, step: 0.05,
  },

  // 氷雲 — 巻雲の厚みの上限
  translucentKnee: {
    label: '薄い雲の膝', tab: 'ice', section: '巻雲の厚みの上限',
    description: '筋の項を割る値(二乗の厚みが筋の利得を傾きにした直線と交わる超過量)。小さいほど筋が濃くなる。',
    min: 0.05, max: 1, step: 0.01,
  },
  translucentLimit: {
    label: '薄い雲の上限', tab: 'ice', section: '巻雲の厚みの上限',
    description: '巻雲の光学的厚みの上限。tanh で頭打ちにして、下地が常に e^−τ だけ透けることを保証する — 巻雲は不透明にならない。',
    min: 0.2, max: 2, step: 0.01,
  },

  // セル径 — 積雲のセル径
  cellClosedKm: {
    label: 'セル径(閉じた細胞) [km]', tab: 'cell', section: '積雲のセル径',
    description: '閉じた細胞(層積雲の板)のセル径 [km]。層積雲の門が開いた所ほど、この径へ寄る。',
    min: 30, max: 150, step: 1,
  },
  cellOpenKm: {
    label: 'セル径(開いた細胞) [km]', tab: 'cell', section: '積雲のセル径',
    description: '開いた細胞(寒気噴出・fetch が長い海)のセル径 [km]。寒気の流入が海を渡った時間の割合に応じて効く。',
    min: 10, max: 60, step: 1,
  },
  cellOpenWarmthOnset: {
    label: '開いた細胞の寒気の裾 [rad]', tab: 'cell', section: '積雲のセル径',
    description: '開いた細胞が立ち始める寒気の流入 [rad]。暖気流入の符号を反転した値で測り、この深さから開いた細胞の門が開く。',
    min: -0.2, max: 0.3, step: 0.01,
  },
  cellOpenWarmthFull: {
    label: '開いた細胞の寒気の肩 [rad]', tab: 'cell', section: '積雲のセル径',
    description: '開いた細胞の門がそのまま信じられる寒気の流入の深さ [rad]。裾との間で門が連続に開く。',
    min: 0.05, max: 0.6, step: 0.01,
  },
  cellLandKm: {
    label: 'セル径(陸の孤立対流) [km]', tab: 'cell', section: '積雲のセル径',
    description: '陸上の孤立対流のセル径 [km]。陸らしさ × 対流の活発度の門で効き、陸では小さな粒の空になる。',
    min: 1, max: 12, step: 0.25,
  },
  cellClusterKm: {
    label: 'セル径(熱帯の集団) [km]', tab: 'cell', section: '積雲のセル径',
    description: '熱帯の集団のセル径 [km]。平年の雲量と湿度が高く、対流の活発度が低い所で効く。',
    min: 60, max: 240, step: 5,
  },
  cellBandKm: {
    label: 'セル径(前線帯の粒) [km]', tab: 'cell', section: '積雲のセル径',
    description: '前線帯に埋まった粒のセル径 [km]。前線・雨帯の帯の強さに応じて効き、帯の中の粒の大きさを決める。',
    min: 15, max: 90, step: 1,
  },
  cellMarineKm: {
    label: 'セル径(既定・中緯度の海) [km]', tab: 'cell', section: '積雲のセル径',
    description: '既定(中緯度の海)のセル径 [km]。千切りの変調と細部の小さなセルの基準を兼ね、この径で千切りの変調が 1 になる。',
    min: 20, max: 120, step: 1,
  },
  cellResidualWeight: {
    label: 'セル径の残余重み', tab: 'cell', section: '積雲のセル径',
    description: 'どの門も開かない所へ常時足す、既定の径の小さな重み。ゼロ除算を避け、既定の径へ滑らかに戻す。',
    min: 0.01, max: 1, step: 0.01,
  },

  // セル径 — 巻雲の要素径
  cirrusCellFiberKm: {
    label: '巻雲の要素径(繊維) [km]', tab: 'cell', section: '巻雲の要素径',
    description: '繊維(ジェットの下の揃った流れ)の要素径 [km]。揃い度と上層の風速が高い所で効く。',
    min: 0.5, max: 8, step: 0.25,
  },
  cirrusCellMackerelKm: {
    label: '巻雲の要素径(鱗) [km]', tab: 'cell', section: '巻雲の要素径',
    description: '鱗(撹乱した上層)の要素径 [km]。対流の活発度 × 陸らしさの門で効き、陸の上の巻雲のピッチを決める。',
    min: 1, max: 10, step: 0.25,
  },
  cirrusCellAnvilKm: {
    label: '巻雲の要素径(金床残滓) [km]', tab: 'cell', section: '巻雲の要素径',
    description: '金床残滓(渦の芯が敷いた天蓋)の要素径 [km]。金床の濃さに応じて効き、天蓋まわりの巻雲の大きさを決める。',
    min: 20, max: 200, step: 5,
  },
  cirrusCellSheetKm: {
    label: '巻雲の要素径(板) [km]', tab: 'cell', section: '巻雲の要素径',
    description: '既定(無撹乱の板)の巻雲の要素径 [km]。どの型の門も開かない所の径になり、残余の重みで滑らかに戻る。',
    min: 8, max: 60, step: 1,
  },
  cirrusCellResidualWeight: {
    label: '巻雲の要素径の残余重み', tab: 'cell', section: '巻雲の要素径',
    description: 'どの門も開かない所へ常時足す、既定の板の径の小さな重み。ゼロ除算を避け、既定の径へ滑らかに戻す。',
    min: 0.01, max: 1, step: 0.01,
  },
  cirrusFiberWindOnset: {
    label: '繊維の風速の裾 [m/s]', tab: 'cell', section: '巻雲の要素径',
    description: '繊維が揃い始める上層の風速 [m/s]。筋の揃い度の門より強い側で立ち、ジェットの下だけを拾う。',
    min: 5, max: 40, step: 1,
  },
  cirrusFiberWindFull: {
    label: '繊維の風速の肩 [m/s]', tab: 'cell', section: '巻雲の要素径',
    description: '繊維の門をそのまま信じる上層の風速 [m/s]。裾との間で、風速に応じて繊維の径が連続に効く。',
    min: 20, max: 80, step: 1,
  },

  // 対流 — 活発度
  instabilityAmplitude: {
    label: '気団の不安定の振れ', tab: 'convection', section: '活発度',
    description: '気団の対流のしやすさのノイズ(250〜1000 km)の、活発度への振れ幅。気団だけでは活発度が中間の階調に留まる高さに取る。',
    min: 0, max: 2.5, step: 0.05,
  },
  liftActivity: {
    label: '上昇流→活発度', tab: 'convection', section: '活発度',
    description: '上昇流が対流の活発度へ渡る伝達利得 [per m/s]。並の低気圧(0.02 m/s)で気団によらず 1 へ届く高さに取る。',
    min: 0, max: 60, step: 0.5,
  },
  coldActivity: {
    label: '寒気流入→活発度', tab: 'convection', section: '活発度',
    description: '寒気の流入が活発度へ寄与する利得 [per rad]。並の寒気の吹き出し(−0.26 rad)で活発度が半分ぶん上がる高さに取る。',
    min: 0, max: 5, step: 0.05,
  },
  landActivity: {
    label: '陸→活発度', tab: 'convection', section: '活発度',
    description: '陸が基準として活発度へ足す分(陸らしさに掛けて常時)。粒の細かさとセル径に効き、雲の量は変えない。活発度は 1 で頭打ちなので、上げても飽和して効かなくなりやすい。',
    min: 0, max: 1, step: 0.01,
  },
  surfaceActivity: {
    label: '地表の駆動→活発度', tab: 'convection', section: '活発度',
    description: '地表の駆動(深い対流の起こりやすさ 0〜1)が活発度へ渡る利得。日射で温まった陸と山地、暖かい海が粒へ千切れる。',
    min: 0, max: 1.5, step: 0.01,
  },
  bandActivity: {
    label: '帯→活発度', tab: 'convection', section: '活発度',
    description: '前線・雨帯の帯が活発度へ寄与する利得。帯が飽和した所で活発度が半分ぶん上がる高さに取り、粒立った塔が列をなす。',
    min: 0, max: 1.5, step: 0.01,
  },
  activityBase: {
    label: '活発度の基準', tab: 'convection', section: '活発度',
    description: '上昇流などが無いときの基準の活発度。活発度は他の寄与の和にこの値を足して、床と 1 のあいだへ収める。',
    min: 0, max: 1, step: 0.01,
  },
  activityMin: {
    label: '活発度の床', tab: 'convection', section: '活発度',
    description: '活発度の下限。上昇流が無くても沈降していても、活発度がこの値を下回らず、板へ寄りきらない。',
    min: 0, max: 1, step: 0.01,
  },

  // 対流 — 地表の駆動(日射・湿り・比高)
  shallowLagHours: {
    label: '浅い積雲の遅れ [h]', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '日射のピークから浅い積雲が立つまでの遅れ [時]。浅い積雲は正午過ぎにいちばん多い。',
    min: 0, max: 6, step: 0.25,
  },
  deepLagHours: {
    label: '深い対流の遅れ [h]', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '日射のピークから深い対流が立つまでの遅れ [時]。深い対流は午後遅くにいちばん多い。',
    min: 0, max: 8, step: 0.25,
  },
  mountainPhaseAdvanceHours: {
    label: '山地で早まる時間 [h]', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '山地で斜面の加熱により対流が立つのが早まる時間 [時]。山地の度合いに応じて、上の遅れから差し引かれる。',
    min: 0, max: 5, step: 0.25,
  },
  wetnessCloudinessOnset: {
    label: '陸の湿りの雲量の裾', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '陸の湿りを平年の雲量から読む S 字の裾。乾いた陸は日射が強くても雲が立たないので、湿りが駆動の門を担う。',
    min: 0, max: 0.6, step: 0.01,
  },
  wetnessCloudinessFull: {
    label: '陸の湿りの雲量の肩', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '陸の湿りを平年の雲量から読む S 字の肩。この雲量以上の陸は十分に湿っていると見なす。',
    min: 0.1, max: 0.9, step: 0.01,
  },
  reliefOnset: {
    label: '山地の比高の裾 [m]', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '山地と見なし始める比高 [m]。標高の高さではなく斜面の起伏に従うので、最高峰の平らな頂上は含まない。',
    min: 0, max: 1500, step: 25,
  },
  reliefFull: {
    label: '山地の比高の肩 [m]', tab: 'convection', section: '地表の駆動(日射・湿り・比高)',
    description: '完全に山地と見なす比高 [m]。裾との間で山地の度合いが連続に増え、山地ほど対流が強く早く立つ。',
    min: 200, max: 3000, step: 25,
  },

  // 対流 — 浅い積雲の駆動
  shallowNightFloor: {
    label: '陸の夜の駆動の床', tab: 'convection', section: '浅い積雲の駆動',
    description: '陸の浅い積雲の駆動が夜に下がる床(昼を 1 とした比)。陸の駆動は日射の立方根に従い、夜はここまで下がる。',
    min: 0, max: 1, step: 0.01,
  },
  shallowDriveMean: {
    label: '浅い積雲の駆動の基準', tab: 'convection', section: '浅い積雲の駆動',
    description: '浅い積雲の駆動の基準(海の駆動で、湿った陸の日平均にほぼ等しい)。駆動がこれを上回る昼の陸で湿度が足され、下回る夜に引かれる。',
    min: 0.05, max: 1, step: 0.01,
  },
  oceanDiurnal: {
    label: '海の日変化の振れ', tab: 'convection', section: '浅い積雲の駆動',
    description: '海の浅い積雲の駆動の日変化の振れ幅(基準比)。地方太陽時の 13 時ごろに最大になる。',
    min: 0, max: 1, step: 0.01,
  },
  shallowForcingGain: {
    label: '駆動→湿度の利得', tab: 'convection', section: '浅い積雲の駆動',
    description: '浅い積雲の駆動の、基準からの偏りが地表付近の湿度へ渡る利得。上げると陸の昼夜の雲量差が大きくなる。',
    min: 0, max: 0.8, step: 0.01,
  },

  // 対流 — 深い対流の駆動
  landDeepScale: {
    label: '陸の平地の深い対流の強さ', tab: 'convection', section: '深い対流の駆動',
    description: '陸の平地の深い対流の駆動の強さ。山地の強さを 1 とした比で、日射と湿りに応じた午後の駆動へ掛かる。',
    min: 0, max: 1, step: 0.01,
  },
  oceanDeepScale: {
    label: '暖かい海の深い対流の強さ', tab: 'convection', section: '深い対流の駆動',
    description: '暖かい海の深い対流の駆動の強さ。山地の強さを 1 とした比で、暖かい海の門が開いた所にだけ掛かる。',
    min: 0, max: 1, step: 0.01,
  },
  oceanDeepDiurnal: {
    label: '海の深い対流の早朝の振れ', tab: 'convection', section: '深い対流の駆動',
    description: '海の深い対流の駆動の日変化の振れ幅。地方太陽時の 5 時ごろの早朝に最大になる。',
    min: 0, max: 1, step: 0.01,
  },
  warmSeaTemperatureOnset: {
    label: '暖かい海の温度の裾 [K]', tab: 'convection', section: '深い対流の駆動',
    description: '深い対流が増え始める平年の気温 [K]。海面水温が約 26℃ から増える性質の代用で、これ以下の海では深い対流が立たない。',
    min: 280, max: 305, step: 0.5,
  },
  warmSeaTemperatureFull: {
    label: '暖かい海の温度の肩 [K]', tab: 'convection', section: '深い対流の駆動',
    description: '暖かい海の門が全開になる平年の気温 [K]。約 29.5℃ に向けて深い対流が増える性質の代用。',
    min: 285, max: 310, step: 0.5,
  },
};

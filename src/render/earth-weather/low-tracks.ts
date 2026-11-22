// 中緯度の低気圧の谷の生の配置を、時刻の閉じた関数で答える。上層のロスビー波の
// 谷の下流側、蛇行の振幅の強いストームトラックの海域に生まれ、波とともに東へ運ばれて
// トラックの終端で埋まる。進路と一生は(枡, 世代)ごとの乱数で決まり、どの時刻へ飛んでも
// 同じ配置になる。ここが答えるのは吸収を考えない生の配置 — 近づきすぎた中心どうしの吸収は
// cyclone-tracks が全ての低気圧の生の配置の上で行う。
import * as THREE from 'three/webgpu';
import { mulberry32, randSym } from '../../math/random';
import {
  WAVE_TROUGH_WIDTH, stormTrackCountAt, stormTrackIndexAt, waveAmplitudeAt, waveAnchoredSlot,
  waveDriftDegAt, waveTroughLongitude,
} from './rossby-wave';
import { woundOf } from './wind-law';
import { FEATURE_REACH } from './pressure-feature';
import { vortexPresence } from './vortex-absorption';
import type { RawVortex } from './vortex-absorption';
import { courseAt, DAY, DEGREE, uniformIn, waypoint } from './tracks';
import type { Course, Range } from './tracks';

// 中緯度の低気圧。同時に持つ枡の数(偶数番が北、奇数番が南)。枡は上層のロスビー波の谷へ
// 錨づき、半球あたりの枡の数は谷の数(WAVE_NUMBER)より多い — 世代ごとに同じ谷へ複数の枡が
// 並び、発生の門を通った世代にはトラックの下流へ低気圧が連なる。
export const LOW_COUNT = 32;
// 1 つの枡が候補を立て直す周期 [s] と寿命の幅 [s]。寿命は周期より短く、生まれる時刻を周期の中で
// 揺らす余地(周期 − 寿命)を残す — 同じ枡の低気圧が毎回同じ間隔で現れない。同じ枡で前の低気圧が
// 消えてから次が生まれるまでに必ず空く時間 [s] を、その余地の両端から取る — 深さ 0 の谷が
// 入れ替わる瞬間に中心が極側の東端から亜熱帯の西端へ移るので、居ない時間を挟んで 1 つの谷が
// 跳んだと読めなくする。寿命は区間比の冪(幾何一様)で右裾に引く — 中央値が √(min·max) ≈ 4.5 日、
// 短い系が多く 10 日に届くものはまれ(気候統計: 中央値 ~4.5 日、幅 2〜10 日)。
const LOW_PERIOD = 11 * DAY;
const LOW_LIFETIME: Range = [2 * DAY, 10 * DAY];
const LOW_REBIRTH_GAP = 6 * 3600;
// 家族の後続(2 次低気圧)が、一次の低気圧が埋まってから立つまでの間 [s] とその揺れの幅 [s]。
// 深さが 0 へ降りてから中心が動くので、候補の交代で谷が跳んで見えることはない — 間は時間の
// 刻み(1 時間)より長く取り、どの観測の刻みでも交代のあいだの不在が必ず見える幅にする。
// 後続は周期の残りに一生が収まるときだけ生まれる。
const LOW_HANDOFF_GAP = 3 * 3600;
const LOW_HANDOFF_JITTER = 3 * 3600;
// 生まれる緯度の幅 [°]。亜熱帯の縁に生まれる
// (`DEVELOP/SPEC/RENDERING.md`「中緯度の低気圧は生まれ、東へ走り、極側で止まって消える」)。
const LOW_BIRTH_LATITUDE: Range = [32, 45];
// 枡の経度は上層のロスビー波の谷へ錨づく — 地表の低気圧は上層の谷の下流側で発達する。
// 谷からの下流への距離 [°]、同じ谷へ並ぶ枡どうしの下流方向の間隔 [°]、生まれる経度の
// 揺れ(谷の間隔 WAVE_TROUGH_WIDTH に対する比、±)。間隔でずらすので、同じ谷から生まれた
// 低気圧は重ならずにトラックへ連なる。
const WAVE_LOW_DOWNSTREAM = 25;
const LOW_RANK_SPACING = 20;
const LOW_LONGITUDE_JITTER = 0.08;
// 発生の門。生まれる点での蛇行振幅(緯度包絡 × ストームトラック重み)がこの門を超えたときだけ
// 低気圧が立つ — 谷がトラックの海域を通る世代だけ発生するので、発生は海域へ偏り、位相の外れた
// 時期は半球じゅうで低気圧が減る。南半球は帯が広く重なり振幅の経度差が小さいので、門を高く
// 取って同じくらいの選択率に揃える。門の揺れ(±の比)で、門の境目の出入りを硬くしない。
const LOW_GENESIS_AMPLITUDE_NORTH = 0.45;
const LOW_GENESIS_AMPLITUDE_SOUTH = 0.68;
const LOW_GATE_JITTER = 0.15;
// 家族(2 次低気圧)。一次の低気圧が立った世代のうち、より強い振幅の門を超えた所で、この確率の
// 後続を周期の残りへ立てる — 群発日の増分の約半分を 2 次低気圧が担うという観測へ寄せる。
const LOW_FAMILY_AMPLITUDE = 0.65;
const LOW_FAMILY_PROBABILITY = 0.45;
// 一生を平均した自力の速さの幅 [m/s]、南半球の倍率、減速の指数の幅。速さも区間比の冪で右裾に
// 引く — 速いものほど珍しい。波ドリフト(緯度 40° で ~3 m/s)を足して、平均の東進はおおよそ
// 10〜15 m/s(南半球はやや速く 12〜18)に乗る。道のりの進みは 1 − (1 − life)^指数 で、
// 消えるときに止まる — 若いうち速く、発達しきると足を緩める。
const LOW_SPEED: Range = [6.5, 11];
const LOW_SH_SPEED = 1.15;
const LOW_BRAKE: Range = [1.5, 2.0];
// 折れ曲がり点での極側への進みの割合の揺れ(±)。
const LOW_TURN_JITTER = 0.05;
// 最深の最小値と幅 [hPa]。u² で右裾に引く — 弱い系が多く、深い爆弾低気圧はまれ。
const LOW_DEPTH_MIN = 12;
const LOW_DEPTH_SPAN = 28;
// 生まれる半径の幅 [m]、深い系ほど広く取る下限を支える深さ [hPa]、半径の上限 [m]。
// **眼を持たない範囲で取る** — 半径を √(最深 / この深さ) 倍へ下から支えるので、最深 40 hPa でも
// 芯で風が等圧線を横切る角は眼の開く門(16°)より開いている。上限は谷の裾野の影響限界
// (消えるとき短軸 1800 km)を越えないよう抑える。
const LOW_BIRTH_RADIUS: Range = [550e3, 850e3];
const LOW_DEEP_RADIUS = 28;
const LOW_RADIUS_MAX = 900e3;
const LOW_GROWTH: Range = [0.5, 1.0];
// 深さの山の偏り。深さ = 最深 × sin(π × life^偏り) で、最盛期が life 0.42 へ寄る。
const LOW_PEAK_SKEW = 0.8;
// 閉塞が始まり、追いつき切るまでの一生の中の位置。深さの山(life 0.42)を越えてから寒冷前線が
// 温暖前線へ追いつき始め、一生の 3/4 までに暖域の舌が芯から切り離される。
const LOW_OCCLUSION_ONSET = 0.45;
const LOW_OCCLUSION_FULL = 0.75;
// 生まれてから深さの山が立ち始めるまでの時間 [s]。山の式は生まれた直後の傾きが発散するので、
// 発達はこの時間かけて立ち上げる — 短い一生で深い系がいきなり 1 時間に数 hPa 深くならない。
const LOW_DEPTH_RAMP = 18 * 3600;
// 長軸/短軸の比。前線の向きへ伸びた楕円。
const LOW_ELONGATION = 1.3;
// 乱数の種に足す塩。一次の種(世代 × LOW_COUNT + 番号)がここへ届くのに ~1.6 万年かかる先に
// 取る(2²⁴ ÷ LOW_COUNT 世代 × 周期 11 日)。種どうしの交差が先に起きる時点 — 一次の種が熱帯の
// 帯(2²⁰)へ届く ~987 年 — より十分に遠い。
const LOW_SECONDARY_SEED_SALT = 1 << 24;
// 閉塞し切った境目が渦の死後に停滞前線として残る期間 [s]。低気圧が消えたあとも
// 数日残ってやがて薄れる (`DEVELOP/SPEC/RENDERING.md`「閉塞し切った境目は、渦が埋まる
// あいだも芯へ縮まずに残り、低気圧が消えたあとも停滞前線として数日残る」)。
const LOW_REMNANT: Range = [1.5 * DAY, 4 * DAY];

// ストームトラックの軸(海域)ごとの、進路の折れ方と消える緯度の帯。北上はトラックの北東
// 傾斜(南半球では南東傾斜)で、傾きは海域ごとに違う — 発生した帯に応じて折れ方を変える。
// 消える緯度はトラックの終端 — 北半球は湾奥や欧州〜高緯度の海、南半球は南極の縁。
// 表は半球ごとに rossby-wave の bump 表と同じ並びで、発生経度へいちばん強い bump の
// 番号(stormTrackIndexAt)の行を引く。bump を足したらこちらにも行を足す — 本数が
// 合わなければ初期化で止める。
interface TrackAxis {
  readonly endLatitude: Range; // 消える緯度の帯 [°](絶対値)
  readonly turnPoleward: number; // 折れ曲がりの時点での極側への進みの割合
  readonly turnEastward: number; // 折れ曲がりの時点での東への進みの割合
}
// 行の本数を bump 表と突き合わせる — ずれがあると発生した帯の折れ方が黙って別海域の
// ものになるので、読み込みの時点で止める。
function trackAxes(hemisphere: number, axes: readonly TrackAxis[]): readonly TrackAxis[] {
  if (axes.length !== stormTrackCountAt(hemisphere)) {
    throw new Error(`TRACK_AXES の本数が半球 ${hemisphere} の bump 数と合わない`);
  }
  return axes;
}
const NORTH_TRACK_AXES = trackAxes(1, [
  // 北西太平洋 — 強く北東へ折れ、日付変更線〜アラスカ湾で埋まる。
  { endLatitude: [55, 65], turnPoleward: 0.45, turnEastward: 0.55 },
  // 北大西洋西岸 — アイスランド〜欧州へ向かう。
  { endLatitude: [56, 67], turnPoleward: 0.4, turnEastward: 0.6 },
  // 欧州〜地中海の二次的な帯 — より東向きに進み、シベリア・北欧で埋まる。
  { endLatitude: [55, 66], turnPoleward: 0.3, turnEastward: 0.65 },
]);
const SOUTH_TRACK_AXES = trackAxes(-1, [
  // 南大西洋〜南インド洋の広い帯 — 南極の縁へらせん状に降りる。
  { endLatitude: [60, 67], turnPoleward: 0.35, turnEastward: 0.6 },
  // 南西太平洋。
  { endLatitude: [60, 67], turnPoleward: 0.35, turnEastward: 0.6 },
]);

// 経度 longitudeDeg [°]・半球 hemisphere (北 +1 / 南 −1) で発生した低気圧が乗るトラックの軸。
// 発生経度へいちばん強い bump の番号の行を引く。
function trackAxisAt(longitudeDeg: number, hemisphere: number): TrackAxis {
  const axes = hemisphere >= 0 ? NORTH_TRACK_AXES : SOUTH_TRACK_AXES;
  return axes[stormTrackIndexAt(longitudeDeg * DEGREE, hemisphere)]!;
}

// 中緯度の低気圧 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、
// 生まれる時刻 birthSeconds [s](波の錨がこの時刻の谷の位相へ置かれる)、進路
// course(緯度は半球の符号を含む)、減速の指数 brake、最深 peakDepth [hPa]、生まれる半径
// birthRadius [m]、消えるまでに半径が増える割合 growth。
interface LowTrack {
  readonly onset: number;
  readonly lifetime: number;
  readonly birthSeconds: number;
  readonly course: Course;
  readonly brake: number;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
  // 閉塞し切った境目が残る期間 [s]。渦が消えてから停滞前線として残る時間で、
  // 配置が放出されるのは life < 1 + remnant/lifetime まで。
  readonly remnant: number;
}

// lowTrackOf の結果の表。一生は (枡, 世代, 候補, 天体の半径) の閉じた関数なので、同じ引数では
// 組み直さずに使い回す。時刻が進めば世代も進むので、表があふれたら古く入れたものから捨てる。
const LOW_TRACK_CACHE_SIZE = 512;
const lowTrackCache = new Map<string, LowTrack | null>();

// lowTrackOf と同じ値を、表を通して返す。
function cachedLowTrackOf(
  index: number, generation: number, candidate: number, surfaceRadius: number,
): LowTrack | null {
  const key = `${surfaceRadius}/${generation}/${index}/${candidate}`;
  const cached = lowTrackCache.get(key);
  if (cached !== undefined) return cached;
  const track = lowTrackOf(index, generation, candidate, surfaceRadius);
  if (lowTrackCache.size >= LOW_TRACK_CACHE_SIZE) lowTrackCache.delete(lowTrackCache.keys().next().value!);
  lowTrackCache.set(key, track);
  return track;
}

// 枡 index に世代 generation で生まれる低気圧の候補 candidate(0 は一次、1 は家族の後続)。
// 発生を認めないとき(振幅の門を超えない、周期の残りに収まらない)は null。乱数は
// (枡, 世代, 候補) ごとに 1 列で、引く順が一生を決める — 時刻の閉じた関数のまま保つ。
// surfaceRadius [m] は天体の半径で、走る速さ [m/s] を経度の進み [°] へ直すのに要る。
function lowTrackOf(
  index: number, generation: number, candidate: number, surfaceRadius: number,
): LowTrack | null {
  const hemisphere = index % 2 === 0 ? 1 : -1;
  const slot = Math.floor(index / 2);
  const rand = mulberry32(
    generation * LOW_COUNT + index + candidate * LOW_SECONDARY_SEED_SALT,
  );
  const lifetime = LOW_LIFETIME[0] * (LOW_LIFETIME[1] / LOW_LIFETIME[0]) ** rand();
  let onset: number;
  if (candidate === 0) {
    onset = LOW_REBIRTH_GAP / 2 + rand() * (LOW_PERIOD - lifetime - LOW_REBIRTH_GAP);
  } else {
    // 家族の後続は、一次の低気圧が立って埋まったあと、同じ世代の残りにだけ置く。
    const primary = cachedLowTrackOf(index, generation, 0, surfaceRadius);
    if (primary === null) return null;
    onset = primary.onset + primary.lifetime + LOW_HANDOFF_GAP + rand() * LOW_HANDOFF_JITTER;
    if (onset + lifetime + LOW_REBIRTH_GAP / 2 > LOW_PERIOD) return null;
  }
  const birthLatitude = uniformIn(LOW_BIRTH_LATITUDE, rand);
  // この世代で枡が座る波の谷の番号と、同じ谷へ並ぶ枡の中での順番。生まれる時刻 [s] =
  // 世代の周期の頭から onset だけ遅れ、枡の位相ずらし分だけ早い。
  const { index: troughIndex, rank } = waveAnchoredSlot(slot, generation);
  const birthSeconds = (generation - index / LOW_COUNT) * LOW_PERIOD + onset;
  const birthLongitude = waveTroughLongitude(troughIndex, birthSeconds, hemisphere) / DEGREE
    + WAVE_LOW_DOWNSTREAM + rank * LOW_RANK_SPACING
    + randSym(LOW_LONGITUDE_JITTER * WAVE_TROUGH_WIDTH, rand);
  // 発生は生まれる点での蛇行振幅で門をくぐる。一次は通常の門、後続はより強い門と確率の両方。
  // 緯度は半球の符号を付けて渡す — ストームトラックの帯は半球ごとに別の束を持つ。
  const amplitude = waveAmplitudeAt(
    hemisphere * birthLatitude * DEGREE, birthLongitude * DEGREE, birthSeconds);
  if (candidate === 0) {
    const base = hemisphere > 0 ? LOW_GENESIS_AMPLITUDE_NORTH : LOW_GENESIS_AMPLITUDE_SOUTH;
    const gate = base * (1 + randSym(LOW_GATE_JITTER, rand));
    if (amplitude < gate) return null;
  } else if (amplitude < LOW_FAMILY_AMPLITUDE || rand() >= LOW_FAMILY_PROBABILITY) {
    return null;
  }
  // 発生した帯の軸から、折れ方と消える緯度の帯を決める。
  const axis = trackAxisAt(birthLongitude, hemisphere);
  const endLatitude = uniformIn(axis.endLatitude, rand);
  const speed = LOW_SPEED[0] * (LOW_SPEED[1] / LOW_SPEED[0]) ** rand()
    * (hemisphere < 0 ? LOW_SH_SPEED : 1);
  const peakDepth = LOW_DEPTH_MIN + LOW_DEPTH_SPAN * rand() ** 2;
  const birthRadius = Math.min(
    LOW_RADIUS_MAX,
    uniformIn(LOW_BIRTH_RADIUS, rand) * Math.max(1, Math.sqrt(peakDepth / LOW_DEEP_RADIUS)),
  );
  const growth = uniformIn(LOW_GROWTH, rand);
  const brake = uniformIn(LOW_BRAKE, rand);
  const remnant = uniformIn(LOW_REMNANT, rand);
  // 東への進み [°]: 平均の速さで寿命のあいだ走った道のりを、進路の中ほどの緯度の緯線で測る。
  const poleward = endLatitude - birthLatitude;
  const midLatitude = (birthLatitude + endLatitude) / 2;
  const eastward = (speed * lifetime) / (surfaceRadius * Math.cos(midLatitude * DEGREE)) / DEGREE;
  // 先に東へ走り、あとでトラックの傾きに沿って極側へ折れる。
  const turnPoleward = axis.turnPoleward + randSym(LOW_TURN_JITTER, rand);
  const course = {
    origin: waypoint(hemisphere * birthLatitude, birthLongitude),
    turn: waypoint(
      hemisphere * (birthLatitude + turnPoleward * poleward),
      birthLongitude + axis.turnEastward * eastward,
    ),
    terminus: waypoint(hemisphere * endLatitude, birthLongitude + eastward),
  };
  return { onset, lifetime, birthSeconds, course, brake, peakDepth, birthRadius, growth, remnant };
}

// 深さの山の立ち上がり込みで、一生の中の位置 life の深さ [hPa]。
function lowDepthAt(track: LowTrack, life: number): number {
  return track.peakDepth * Math.sin(Math.PI * life ** LOW_PEAK_SKEW)
    * THREE.MathUtils.smoothstep(life * track.lifetime, 0, LOW_DEPTH_RAMP);
}

// 前線を駆動する深さ [hPa]。閉塞が追いつき切る(life = LOW_OCCLUSION_FULL)までは谷の深さと
// 同じ — 前線は渦とともに育つ。追いつき切った境目は渦が埋まるあいだも芯へ縮まず、谷が
// 消えてからも停滞前線として数日残る — 渦の深さとは別の、遅れて薄れる寿命を持つ。
function lowFrontDepthAt(track: LowTrack, life: number): number {
  if (life <= LOW_OCCLUSION_FULL) return lowDepthAt(track, life);
  const lifeEnd = 1 + track.remnant / track.lifetime;
  const fade = Math.cos(
    (Math.PI / 2) * (life - LOW_OCCLUSION_FULL) / (lifeEnd - LOW_OCCLUSION_FULL));
  return lowDepthAt(track, LOW_OCCLUSION_FULL) * Math.max(fade, 0);
}

// 積算の巻き上げ角 [rad]。生まれてからの、谷の循環が気団の境目を巻き上げてきた総量 —
// 深さと半径と緯度の履歴から角速度を台形で積む(wind-law.ts の woundOf)。
function lowWoundOf(track: LowTrack, life: number, rotationPeriod: number): number {
  return woundOf(life, track.lifetime, FEATURE_REACH, rotationPeriod, (l) => ({
    depth: lowDepthAt(track, l),
    radius: track.birthRadius * (1 + track.growth * l),
    latitude: courseAt(track.course, 1 - (1 - l) ** track.brake).latitude * DEGREE,
  }));
}

// 中緯度の低気圧 index(0..LOW_COUNT − 1)の、時刻 seconds [s] における生の配置(吸収を考えない
// 値)。同じ時刻に生きている候補は高々 1 つなので、一次から順に最初の生きている候補を返す。
export function rawLowPlacementAt(
  index: number, seconds: number, surfaceRadius: number, rotationPeriod: number,
): RawVortex | null {
  // 枡ごとに周期の位相をずらし、同じ半球の枡が揃って生まれ直さないようにする。
  const age = seconds / LOW_PERIOD + index / LOW_COUNT;
  const generation = Math.floor(age);
  const periodSeconds = (age - generation) * LOW_PERIOD;
  const trackAt = (candidate: number): { track: LowTrack; life: number } | null => {
    const track = cachedLowTrackOf(index, generation, candidate, surfaceRadius);
    if (track === null) return null;
    return { track, life: (periodSeconds - track.onset) / track.lifetime };
  };
  // 生きている渦があればそれを出す。無ければ閉塞し切った境目の名残(停滞前線)を探す —
  // 生きている低気圧のある枡では、新しい渦の姿を優先する。
  for (let candidate = 0; candidate <= 1; candidate++) {
    const found = trackAt(candidate);
    if (found !== null && found.life >= 0 && found.life <= 1) {
      return lowVortexAt(found.track, found.life, seconds, rotationPeriod);
    }
  }
  for (let candidate = 0; candidate <= 1; candidate++) {
    const found = trackAt(candidate);
    if (found === null || found.life <= 1) continue;
    // 名残が残っているあいだに次の候補が生まれるなら、その誕生の前に名残は下がる —
    // 境目は新しい渦の前線へ引き継がれる。残したままだと、枡の系列が終端の名残から
    // 新しい渦の発生位置へ跳んで見えるので、交代のあいだの不在を LOW_HANDOFF_GAP で保つ。
    let end = 1 + found.track.remnant / found.track.lifetime;
    for (let next = candidate + 1; next <= 1; next++) {
      const later = trackAt(next)?.track;
      if (later !== undefined) {
        end = Math.min(
          end, (later.onset - LOW_HANDOFF_GAP - found.track.onset) / found.track.lifetime);
      }
    }
    if (found.life <= end) {
      return lowVortexAt(found.track, found.life, seconds, rotationPeriod);
    }
  }
  return null;
}

// 中緯度の低気圧の一生 track の、一生の中の位置 life における生の配置。life が 1 を
// 越えると渦は終端で深さ 0 に埋まり、残るのは停滞前線だけ — 波の運びと巻き上げは
// 止まり、境目の深さだけがゆっくり薄れていく。
function lowVortexAt(
  track: LowTrack, life: number, seconds: number, rotationPeriod: number,
): RawVortex {
  const vortexLife = Math.min(life, 1);
  const point = courseAt(track.course, 1 - (1 - vortexLife) ** track.brake);
  // 錨は波とともに運ばれる — 渦の死後に残る停滞前線は波の運びをやめて停滞する。
  const driftSeconds = Math.min(seconds, track.birthSeconds + track.lifetime);
  return {
    placement: {
      latitude: point.latitude * DEGREE,
      // 生まれた時刻からのドリフトの差を進路へ足す — 波が停滞・逆行する局面では
      // 錨ごと止まる・戻る。
      longitude: (point.longitude
        + waveDriftDegAt(driftSeconds) - waveDriftDegAt(track.birthSeconds)) * DEGREE,
      depth: lowDepthAt(track, vortexLife),
      radius: track.birthRadius * (1 + track.growth * vortexLife),
      elongation: LOW_ELONGATION,
      occlusion: THREE.MathUtils.smoothstep(vortexLife, LOW_OCCLUSION_ONSET, LOW_OCCLUSION_FULL),
      fronts: 'pair',
      frontDepth: lowFrontDepthAt(track, life),
      wound: lowWoundOf(track, vortexLife, rotationPeriod),
    },
    presence: vortexPresence(vortexLife, track.lifetime),
  };
}

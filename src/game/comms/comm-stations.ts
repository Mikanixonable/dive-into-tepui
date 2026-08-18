// ゲーム開始時点で存在する2つの通信基地(月面基地と近直線ハロー軌道の基地)の位置を、
// 天体暦から毎回引き直す。どちらも月とともに動くので、固定座標では持てない。
import type { Ephemeris } from '../../physics/ephemeris';
import { add, norm, scale, sub } from '../../physics/vec3';
import { COMM_STATION_RANGE } from '../vessel/vessel-parts';
import type { CommRelay } from './coverage';

// 月面基地は地球を向いた表側に置く。裏側は自分自身の月に遮られて圏外になる(§13-4)。
export const MOON_BASE_RELAY_ID = 'comm-station-moon-surface';
// 近直線ハロー軌道の基地。ハロー軌道そのものは積分しておらず、地球-月 L2 で代表させる。
export const NRHO_BASE_RELAY_ID = 'comm-station-nrho';

// 月を持たないレジストリ(独自天体系のデバッグステージ)では通信基地を1つも置かない。
export function initialCommStations(ephemeris: Ephemeris, t: number): readonly CommRelay[] {
  if (!('moon' in ephemeris.registry) || !('earth' in ephemeris.registry)) return [];
  const moon = ephemeris.attractorAt('moon', t);
  const toEarth = norm(sub(ephemeris.positionOf('earth', t), moon.state.r));
  const relay = (id: string, pos: CommRelay['pos']): CommRelay =>
    ({ id, pos, range: COMM_STATION_RANGE, isGround: true });
  return [
    relay(MOON_BASE_RELAY_ID, add(moon.state.r, scale(toEarth, moon.radius))),
    relay(NRHO_BASE_RELAY_ID, ephemeris.lagrangeAt('moon', t).L2),
  ];
}

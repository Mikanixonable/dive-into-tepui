// 軌道上の実体に共通する軌道要素の行(基準天体・高度・速度・AP/PE/INC/PRD)。
// 「軌道」グループにまとめ、プロパティウィンドウ先頭の折り畳みセクションへ描かれる。
import { fmtDist, fmtSpeed, fmtTime } from '../../hud/utils';
import { orbitInfo } from '../hud/orbit/orbit-info';
import { autoOrbitReference } from '../orbit-reference';
import { getApsisLabelSpec, ORBIT_ELEMENT_LABELS } from '../hud/orbit/orbit-labels';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

// simTime は天体位置を厳密に引く時刻。
export function orbitRows(
  entity: DynamicEntity, celestialSystem: CelestialSystem, simTime: number,
): PropertyRow[] {
  const celestialBodies = celestialSystem.celestialMotions;
  const oi = orbitInfo(
    entity, autoOrbitReference(entity.state.r, celestialBodies, simTime), simTime,
    (id: string) => celestialSystem.nameOf(id));
  const apSpec = getApsisLabelSpec('ap', oi.centerId);
  const peSpec = getApsisLabelSpec('pe', oi.centerId);
  const group = '軌道';
  return [
    { key: 'center', label: '基準天体', value: oi.centerName, group },
    { key: 'alt', label: ORBIT_ELEMENT_LABELS.alt.full, value: fmtDist(oi.alt), group },
    { key: 'spd', label: ORBIT_ELEMENT_LABELS.spd.full, value: fmtSpeed(oi.spd), group },
    { key: 'ap', label: apSpec.full, value: fmtDist(oi.apAlt), group },
    { key: 'pe', label: peSpec.full, value: fmtDist(oi.peAlt), group },
    {
      key: 'inc', label: ORBIT_ELEMENT_LABELS.inc.full,
      value: isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---', group,
    },
    { key: 'prd', label: ORBIT_ELEMENT_LABELS.prd.full, value: fmtTime(oi.period), group },
  ];
}

import modernPackUrl from '../assets/ephemeris/modern-2026-10y.epk';
import farFuturePackUrl from '../assets/ephemeris/far-future-20115-10y.epk';
import { AbsoluteEphemeris } from './absolute-ephemeris';
import { EphemerisProfileId, profileAt } from './ephemeris-profile';
import { loadPackedAbsoluteEphemeris } from './packed-absolute-ephemeris';

const PACK_URLS: Readonly<Record<EphemerisProfileId, string>> = {
  'modern-de440': modernPackUrl,
  'far-future-20000': farFuturePackUrl,
};

export async function loadAbsoluteEphemeris(
  profileId: EphemerisProfileId,
  epochJdTdb: number,
  requiredEndJdTdb = epochJdTdb,
): Promise<AbsoluteEphemeris> {
  const profile = profileAt(epochJdTdb, profileId);
  profileAt(requiredEndJdTdb, profileId);
  const response = await fetch(PACK_URLS[profileId]);
  if (!response.ok) throw new Error(`天体暦packの取得に失敗: ${response.status} ${response.statusText}`);
  const source = await loadPackedAbsoluteEphemeris(new Uint8Array(await response.arrayBuffer()));
  const expectedSha256 = profile.packId.slice(profile.packId.lastIndexOf('@') + 1);
  if (source.decoded.manifest.payloadSha256 !== expectedSha256) {
    throw new Error(
      `天体暦packの識別子がcatalogと不一致: expected ${profile.packId}, ` +
      `actual ${String(source.decoded.manifest.payloadSha256)}`,
    );
  }
  if (epochJdTdb < source.validStartJdTdb || requiredEndJdTdb > source.validEndJdTdb) {
    throw new RangeError(
      `天体暦packが要求期間を覆わない: request=[${epochJdTdb}, ${requiredEndJdTdb}], ` +
      `pack=[${source.validStartJdTdb}, ${source.validEndJdTdb}]`,
    );
  }
  return source;
}

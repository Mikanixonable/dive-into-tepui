import modernPackUrl from '../assets/ephemeris/modern-2026-10y.epk';
import farFuturePackUrl from '../assets/ephemeris/far-future-20115-10y.epk';
import { AbsoluteEphemeris } from './absolute-ephemeris';
import { EphemerisProfileId, profileAt } from './ephemeris-profile';
import { SECONDS_PER_DAY, TdbJulianDate } from './time';
import { loadPackedAbsoluteEphemeris } from './packed-absolute-ephemeris';

const PACK_URLS: Readonly<Record<EphemerisProfileId, string>> = {
  'modern-de440': modernPackUrl,
  'far-future-20000': farFuturePackUrl,
};

// 応答本文をチャンク単位で読み、Content-Length に対する受信比率を都度 onProgress へ渡す。
async function readWithProgress(response: Response, onProgress?: (ratio: number) => void): Promise<Uint8Array> {
  const total = Number(response.headers.get('content-length'));
  if (!response.body || !onProgress || !Number.isFinite(total) || total <= 0) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received / total);
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

// onProgress は fetch の受信バイト量から算出した 0..1 の比率を渡す。Content-Length が
// 得られない応答では呼ばない(偽の途中経過を出さないため)。
// epoch はこのランの元期(simTime=0)。プロファイルの選択と要求期間の検査は絶対時刻
// (JD_TDB)で行い、読み込んだ pack は元期起点の simTime で答えるようになる。
export async function loadAbsoluteEphemeris(
  profileId: EphemerisProfileId,
  epoch: TdbJulianDate,
  requiredEndJdTdb = epoch.value,
  onProgress?: (ratio: number) => void,
): Promise<AbsoluteEphemeris> {
  const profile = profileAt(epoch.value, profileId);
  profileAt(requiredEndJdTdb, profileId);
  const response = await fetch(PACK_URLS[profileId]);
  if (!response.ok) throw new Error(`天体暦packの取得に失敗: ${response.status} ${response.statusText}`);
  const buffer = await readWithProgress(response, onProgress);
  const source = await loadPackedAbsoluteEphemeris(buffer, epoch);
  const expectedSha256 = profile.packId.slice(profile.packId.lastIndexOf('@') + 1);
  if (source.decoded.manifest.payloadSha256 !== expectedSha256) {
    throw new Error(
      `天体暦packの識別子がcatalogと不一致: expected ${profile.packId}, ` +
      `actual ${String(source.decoded.manifest.payloadSha256)}`,
    );
  }
  // pack はもう simTime で話すので、要求期間のほうを元期起点へ寄せて比べる。
  const requiredEndSimTime = (requiredEndJdTdb - epoch.value) * SECONDS_PER_DAY;
  if (source.validStartSimTime > 0 || requiredEndSimTime > source.validEndSimTime) {
    throw new RangeError(
      `天体暦packが要求期間を覆わない: request=[0, ${requiredEndSimTime}] simTime, ` +
      `pack=[${source.validStartSimTime}, ${source.validEndSimTime}] simTime`,
    );
  }
  return source;
}

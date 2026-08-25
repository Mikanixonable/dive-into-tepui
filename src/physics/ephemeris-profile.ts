// 天体暦の「どの年代を、どの根拠データで扱うか」を表す純粋な宣言。
// 位置データそのものやゲームモードの選択はここへ持ち込まない。

export type EphemerisProfileId = 'modern-de440' | 'far-future-20000';

export type EphemerisProfile = {
  readonly id: EphemerisProfileId;
  readonly sourceModel: string;
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;
  readonly highAccuracyStartJdTdb: number;
  readonly highAccuracyEndJdTdb: number;
  readonly orientationModelId: string;
  /** Published pack payload identity; changing coefficients invalidates saves. */
  readonly packId: string;
};

// 有効期間はモデル一般の年代ではなく、同梱済みpackが実際に覆う期間そのもの。
// 開始時刻を期間外へ変更するときは生成ツールで10年packを再生成し、この宣言も更新する。
export const EPHEMERIS_PROFILES: Readonly<Record<EphemerisProfileId, EphemerisProfile>> = {
  'modern-de440': {
    id: 'modern-de440',
    sourceModel: 'JPL DE440',
    validStartJdTdb: 2461041.5, // 2026-01-01T00:00:00 TDB
    validEndJdTdb: 2464694.0, // 10 Julian years later
    highAccuracyStartJdTdb: 2461041.5,
    highAccuracyEndJdTdb: 2464694.0,
    orientationModelId: 'iau-pck-modern',
    packId: 'modern-de440@343c7b46a1b77c46b6f986d263666a62c227ac735209ae3b6ce89a751b286505',
  },
  'far-future-20000': {
    id: 'far-future-20000',
    sourceModel: 'Tepui long-term integration anchored to JPL DE441',
    validStartJdTdb: 9068045.75, // 20115-05-14T06:00:00 TDB
    validEndJdTdb: 9071698.25, // 10 Julian years later
    highAccuracyStartJdTdb: 9068045.75,
    highAccuracyEndJdTdb: 9071698.25,
    orientationModelId: 'iau-long-term-canonical',
    packId: 'far-future-20000@a6eb7528b6b76818466fdb13d514817c223eb58ebcc14e85ae1a7f33cf343496',
  },
};

export class UnsupportedEphemerisEpochError extends RangeError {
  constructor(readonly jdTdb: number, readonly requestedProfile?: EphemerisProfileId) {
    super(requestedProfile === undefined
      ? `JD_TDB=${jdTdb} を高精度に扱える天体暦プロファイルが無い`
      : `JD_TDB=${jdTdb} は天体暦プロファイル ${requestedProfile} の有効期間外`);
    this.name = 'UnsupportedEphemerisEpochError';
  }
}

// jdTdb を高精度に扱えるプロファイル。無ければ null(この時代は CELESTIAL.md 2.2 の
// とおり解析暦だけで扱う、正常な状態)。有効期間は重ならない。将来重なるプロファイルを
// 追加するときは、暗黙の優先順位ではなく呼び出し側に requestedProfile を要求するよう変更する。
export function profileAtOrNull(jdTdb: number): EphemerisProfile | null {
  if (!Number.isFinite(jdTdb)) throw new TypeError(`JD_TDB は有限値でなければならない: ${jdTdb}`);
  for (const profile of Object.values(EPHEMERIS_PROFILES)) {
    if (jdTdb >= profile.validStartJdTdb && jdTdb <= profile.validEndJdTdb) return profile;
  }
  return null;
}

// jdTdb を高精度に扱えるプロファイル。無ければ例外(requestedProfile を指定すれば、
// その1つが範囲を覆っているかだけを問う)。
export function profileAt(
  jdTdb: number,
  requestedProfile?: EphemerisProfileId,
): EphemerisProfile {
  if (requestedProfile !== undefined) {
    // その1つのプロファイルが覆っているかだけを問う(他のプロファイルへは回さない)。
    if (!Number.isFinite(jdTdb)) throw new TypeError(`JD_TDB は有限値でなければならない: ${jdTdb}`);
    const profile = EPHEMERIS_PROFILES[requestedProfile];
    if (jdTdb < profile.validStartJdTdb || jdTdb > profile.validEndJdTdb) {
      throw new UnsupportedEphemerisEpochError(jdTdb, requestedProfile);
    }
    return profile;
  }
  const profile = profileAtOrNull(jdTdb);
  if (profile === null) throw new UnsupportedEphemerisEpochError(jdTdb);
  return profile;
}

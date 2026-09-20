// cloud-lab 専用の調整 metadata。runtime の src/render/cloud から import しない。

export const CLOUD_LAB_REGIMES = Object.freeze([
  'trade-cumulus',
  'marine-stratocumulus',
  'temperate-front',
  'deep-convection-mcs',
  'upper-cirrus',
  'high-latitude-mixed-phase',
] as const);

export const CLOUD_LAB_CALIBRATION = Object.freeze({
  mesoOrganizationHours: Object.freeze([4, 24]),
  cloudCellLifetimeMinutes: Object.freeze([30, 180]),
  subGridDetailMinutes: Object.freeze([15, 45]),
  anvilResidualHours: Object.freeze([4, 10]),
  referenceCameraDistancesKm: Object.freeze([70, 100, 400]),
  metrics: Object.freeze(['cloudFraction', 'spatialScale', 'advectionSpeed', 'temporalCorrelation']),
});

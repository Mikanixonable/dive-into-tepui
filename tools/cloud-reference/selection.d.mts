export interface CloudReferenceSelector {
  readonly productPrefix: string;
  readonly filenamePrefix: string;
  readonly scanMinute: string;
}

export function plannedNetcdfSelectors(referenceCase: {
  readonly id: string;
  readonly source: { readonly provider: string; readonly product: string };
  readonly series: { readonly start: string; readonly end: string; readonly intervalMinutes: number };
}): readonly CloudReferenceSelector[];

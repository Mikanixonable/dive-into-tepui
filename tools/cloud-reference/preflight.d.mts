export interface CloudReferencePreflightObject {
  readonly key: string;
  readonly sizeBytes: number;
}

export function parseListObjectsV2Xml(xml: string): {
  readonly objects: readonly CloudReferencePreflightObject[];
  readonly isTruncated: boolean;
  readonly continuationToken: string | null;
};

export function preflightReferenceCases(
  cases: readonly {
    readonly id: string;
    readonly source: { readonly provider: string; readonly product: string };
    readonly series: { readonly start: string; readonly end: string; readonly intervalMinutes: number };
  }[],
  options?: {
    readonly fetchImplementation?: (url: URL) => Promise<{ readonly ok: boolean; readonly text: () => Promise<string> }>;
    readonly concurrency?: number;
    readonly maxKeys?: number;
  },
): Promise<{
  readonly complete: boolean;
  readonly total: {
    readonly expectedFileCount: number;
    readonly exactSelectorCount: number;
    readonly bytes: number;
    readonly missingCount: number;
    readonly duplicateCount: number;
  };
}>;

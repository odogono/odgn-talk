import type { Report } from '../src/group';

// These tests exercise execution outcomes. The accounting suite asserts the
// additional records against the complete, unfiltered public report stream.
export const operationalReports = (reports: readonly Report[]) =>
  reports.filter(
    r =>
      r.kind !== 'run started' &&
      r.kind !== 'run discarded' &&
      r.kind !== 'run accounting' &&
      r.kind !== 'causal work',
  );

export const operationalResult = <T extends { reports: Report[] }>(
  result: T,
) => ({ ...result, reports: operationalReports(result.reports) });

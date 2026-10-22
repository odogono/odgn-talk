import type {
  EffectResult,
  Grant,
  SegmentContext,
  SegmentCoordinator,
  SegmentLifecycle,
} from './capabilities';
import { hostDetail } from './errors';
import type { EffectFailure } from './group';
import type { RunRecord } from './machine';

/** Where the participant's Run is, passed at each hook since it moves on. */
export type ParticipantSite = {
  group: SegmentContext<unknown>['group'];
  now: SegmentContext<unknown>['now'];
  records: RunRecord[];
  runId: string;
  scriptName: string;
  segmentId: string;
};

/** How a Segment ended for its participant. */
export type SegmentEnding =
  | { kind: 'none' | 'committed' | 'rolled back' }
  | { failure: EffectFailure; kind: 'effect failed' };

/**
 * A Run's Segment participant: the one Host party engaged in the Segment's
 * Segment-bound effects (ADRs 0048, 0069). It owns enrollment, the first
 * enrolled Grant's naming, lifecycle result classification, failure
 * attribution and the order a Segment ends in. The Run keeps its Script
 * Variables, and restores them when an ending reports a rollback.
 */
export class SegmentParticipant {
  // The Segment Coordinator and the Grants enrolled in it, in enrollment
  // order. A Grant with no coordinator is its own (ADR 0069).
  private current: {
    coordinator?: SegmentCoordinator;
    enrolled: { grant: Grant<unknown>; grantName: string }[];
    hooks: SegmentLifecycle<unknown>;
  } | null = null;
  private abandonment: EffectFailure | null = null;
  private unknown = false;

  get active(): boolean {
    return this.current !== null;
  }

  /** Some effect's state may differ from what the Run believes. */
  get effectStateUnknown(): boolean {
    return this.unknown;
  }

  /** The participant's first enrolled Grant, which the Trace names. */
  get name(): string {
    return this.current!.enrolled[0]!.grantName;
  }

  enrolled(grantName: string): boolean {
    return !!this.current?.enrolled.some(g => g.grantName === grantName);
  }

  /**
   * The participant a Segment-bound call through this Grant conflicts with,
   * checked before the call's Host work.
   */
  conflict(grantName: string, grant: Grant<unknown>): string | null {
    const current = this.current;
    if (!current) {
      return null;
    }
    const shares = current.coordinator
      ? grant.coordinator === current.coordinator
      : this.name === grantName;
    return shares ? null : this.name;
  }

  /**
   * Enrolls a Grant for a Segment-bound call. A later Grant of the same
   * coordinator joins with no hook; the first begins the participant. A
   * failed begin leaves no participant. An unknown one keeps the possibly
   * acquired participant for the Run's terminal ending, which abandons
   * existing scopes before attempting rollback exactly once.
   */
  enroll(
    grantName: string,
    grant: Grant<unknown>,
    site: ParticipantSite,
  ): EffectResult['status'] {
    if (this.current) {
      if (!this.enrolled(grantName)) {
        this.current.enrolled.push({ grantName, grant });
      }
      return 'ok';
    }
    this.current = {
      enrolled: [{ grantName, grant }],
      hooks: grant.coordinator ?? grant.capability.lifecycle!,
      ...(grant.coordinator ? { coordinator: grant.coordinator } : {}),
    };
    const { status } = this.lifecycle('begin', site);
    if (status === 'failed') {
      this.current = null;
    }
    if (status === 'unknown') {
      this.unknown = true;
    }
    return status;
  }

  /** An enrolled Grant's scope failed to abandon; the first such failure wins. */
  abandonFailed(failure: EffectFailure) {
    if (this.enrolled(failure.grant)) {
      this.abandonment ??= failure;
    }
  }

  /**
   * Ends the Segment for the participant. Scopes are abandoned first, then
   * the participant rolls back, or commits unless an enrolled Grant's scope
   * failed to abandon. A failed commit rolls back too, and the Segment's
   * effect failure names the abandonment before the commit.
   */
  end(
    ending: 'commit' | 'rollback',
    siteOf: () => ParticipantSite,
    abandonScopes: () => void,
  ): SegmentEnding {
    abandonScopes();
    if (!this.current) {
      return { kind: 'none' };
    }
    const site = siteOf();
    if (ending === 'rollback') {
      this.rollback(site);
      return { kind: 'rolled back' };
    }
    const abandonment = this.abandonment;
    const result = abandonment ? null : this.lifecycle('commit', site);
    if (result?.status === 'ok') {
      this.clear();
      return { kind: 'committed' };
    }
    const failure = abandonment ?? this.failure('commit', result!, site);
    if (result?.status === 'unknown') {
      this.unknown = true;
    }
    this.rollback(site);
    return { kind: 'effect failed', failure };
  }

  private rollback(site: ParticipantSite) {
    if (this.lifecycle('rollback', site).status !== 'ok') {
      this.unknown = true;
    }
    this.clear();
  }

  private clear() {
    this.current = null;
    this.abandonment = null;
  }

  private lifecycle(
    phase: 'begin' | 'commit' | 'rollback',
    site: ParticipantSite,
  ): EffectResult {
    const current = this.current!;
    const first = current.enrolled[0]!;
    const context: SegmentContext<unknown> = {
      group: site.group,
      binding: first.grant.binding,
      scriptName: site.scriptName,
      runId: site.runId,
      grantName: first.grantName,
      grants: current.enrolled.map(g => ({
        grantName: g.grantName,
        binding: g.grant.binding,
      })),
      segmentId: site.segmentId,
      now: site.now,
    };
    let result: EffectResult;
    try {
      const returned = current.hooks[phase](context);
      const status = returned?.status;
      const detail = returned?.detail;
      if (
        !['ok', 'failed', 'unknown'].includes(status) ||
        (detail !== undefined && typeof detail !== 'string')
      ) {
        throw new Error('Malformed lifecycle result');
      }
      result = { status, ...(detail === undefined ? {} : { detail }) };
    } catch (error) {
      result = { status: 'unknown', detail: hostDetail(error) };
    }
    site.records.push({
      kind: 'effect',
      grant: first.grantName,
      segment: site.segmentId,
      phase,
      status: result.status,
    });
    if (result.status !== 'ok') {
      site.records.push({
        kind: 'effect-failure',
        grant: first.grantName,
        segment: site.segmentId,
        phase,
        status: result.status,
        detail: result.detail ?? '',
      });
    }
    return result;
  }

  private failure(
    phase: EffectFailure['phase'],
    result: EffectResult,
    site: ParticipantSite,
  ): EffectFailure {
    return {
      script: site.scriptName,
      run: site.runId,
      grant: this.name,
      segment: site.segmentId,
      phase,
      status: result.status as 'failed' | 'unknown',
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  }
}

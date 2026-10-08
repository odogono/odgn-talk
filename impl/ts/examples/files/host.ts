import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineCapability,
  nothing,
  ScriptError,
  shape,
  type Call,
  type EffectResult,
  type Group,
  type SegmentContext,
} from '../../src/index';

export type FileHostOptions = {
  /** Host-only publication seam. `failed` must mean the destination did not change. */
  publish?: (staging: string, destination: string) => EffectResult;
};
type File = { destination: string; fd?: number; path: string; ready: boolean };
type Participant = { destination?: string; file?: File };
type Owner = Pick<
  SegmentContext<undefined>,
  'scriptName' | 'runId' | 'grantName' | 'segmentId'
>;
const slotKey = (owner: Owner) =>
  JSON.stringify([owner.scriptName, owner.runId, owner.grantName, 'file']);
const participantKey = (owner: Owner) =>
  JSON.stringify([
    owner.scriptName,
    owner.runId,
    owner.grantName,
    owner.segmentId,
  ]);
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;

// Local POSIX rename failures which leave the destination unchanged. EIO and
// unrecognized failures are uncertain. Network filesystems are outside this Host contract.
const definiteRenameErrors = new Set([
  'EACCES',
  'EBUSY',
  'EDQUOT',
  'EEXIST',
  'EINVAL',
  'EISDIR',
  'ELOOP',
  'EMLINK',
  'ENAMETOOLONG',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
  'EXDEV',
]);
const publishFile = (source: string, destination: string): EffectResult => {
  try {
    renameSync(source, destination);
    return { status: 'ok' };
  } catch (error) {
    const code = errorCode(error);
    return {
      status:
        typeof code === 'string' && definiteRenameErrors.has(code)
          ? 'failed'
          : 'unknown',
      detail: String(error),
    };
  }
};

/** A private, disposable Bun Example Host, not a general filesystem Capability. */
export const createFileHost = (
  mode: 'immediate' | 'staged',
  options: FileHostOptions = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-files-'));
  const staged = mode === 'staged';
  const publish = options.publish ?? publishFile;
  const slots = new WeakMap<Group, Map<string, File>>();
  const participants = new WeakMap<Group, Map<string, Participant>>();
  // The binding is shared: preempted Runs in different Groups must not race on
  // one destination. Group object identity namespaces both ownership maps.
  const reservations = new Map<string, object>();
  const files = new Set<File>();
  let disposed = false;
  const participant = (
    context: Owner & Pick<SegmentContext<undefined>, 'group'>,
  ) => {
    const current = participants
      .get(context.group)
      ?.get(participantKey(context));
    if (!current) {
      throw new Error('Missing file participant');
    }
    return current;
  };
  const fileFor = (call: Call<undefined>) => {
    const file = slots.get(call.group)?.get(slotKey(call));
    if (!file || file.fd === undefined) {
      throw new ScriptError(
        'file not open',
        'Open an output file before writing',
      );
    }
    return file;
  };
  const discard = (file: File) => {
    if (file.fd !== undefined) {
      closeSync(file.fd);
      file.fd = undefined;
    }
    try {
      unlinkSync(file.path);
    } catch (error) {
      // An uncertain publisher may already have moved the staging file.
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
    files.delete(file);
  };
  const finish = (context: SegmentContext<undefined>, current: Participant) => {
    if (current.destination) {
      reservations.delete(current.destination);
    }
    participants.get(context.group)!.delete(participantKey(context));
  };
  const capability = defineCapability<undefined>(
    'fileOutput',
    {
      open: {
        mode: 'immediate',
        args: [shape.text],
        result: shape.nothing,
        cost: { fuel: 1 },
        scope: { opens: 'file', abandon: 'close' },
        segmentBound: staged,
        errors: [
          { code: 'invalid destination' },
          { code: 'destination conflict' },
          { code: 'destination busy' },
        ],
        do: (call, name) => {
          if (disposed) {
            throw new Error('File Host disposed');
          }
          const destination = name.asText()!;
          // Only plain filenames. Scripts cannot name staging files, directories,
          // absolute paths or parent paths; no untrusted directory entries exist.
          if (!/^[\dA-Za-z][\w.-]*$/.test(destination)) {
            throw new ScriptError(
              'invalid destination',
              'Use a plain output filename',
            );
          }
          const current = staged ? participant(call) : undefined;
          if (current?.destination && current.destination !== destination) {
            throw new ScriptError(
              'destination conflict',
              'Only one staged destination per Segment',
            );
          }
          const reserved = reservations.get(destination);
          if (reserved && reserved !== current) {
            throw new ScriptError(
              'destination busy',
              'Another Run owns this destination',
            );
          }
          const file = current?.file ?? {
            destination,
            path: join(
              directory,
              staged ? `.stage-${randomUUID()}` : destination,
            ),
            ready: false,
          };
          // A failed opener acquires nothing. Reopening the same staged file
          // truncates its provisional bytes, just like ordinary open.
          const fd = openSync(
            file.path,
            current?.file || !staged ? 'w' : 'wx',
            0o600,
          );
          file.fd = fd;
          file.ready = false;
          files.add(file);
          const owned = slots.get(call.group) ?? new Map<string, File>();
          owned.set(slotKey(call), file);
          slots.set(call.group, owned);
          if (current) {
            current.destination = destination;
            current.file = file;
          }
          reservations.set(destination, current ?? file);
          return nothing;
        },
      },
      write: {
        mode: 'immediate',
        args: [shape.text],
        result: shape.nothing,
        cost: { fuel: 1 },
        segmentBound: staged,
        errors: [{ code: 'file not open' }],
        do: (call, content) => {
          const file = fileFor(call);
          const bytes = Buffer.from(content.asText()!, 'utf8');
          let offset = 0;
          while (offset < bytes.length) {
            const written = writeSync(
              file.fd!,
              bytes,
              offset,
              bytes.length - offset,
            );
            if (written === 0) {
              throw new Error('File write made no progress');
            }
            offset += written;
          }
          return nothing;
        },
      },
      close: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        scope: { closes: 'file' },
        segmentBound: staged,
        do: call => {
          const file = fileFor(call);
          closeSync(file.fd!);
          file.fd = undefined;
          slots.get(call.group)!.delete(slotKey(call));
          if (staged) {
            if (call.automatic) {
              discard(file);
              participant(call).file = undefined;
            } else {
              file.ready = true;
            }
          } else {
            files.delete(file);
            reservations.delete(file.destination);
          }
          return nothing;
        },
      },
    },
    staged
      ? {
          begin: context => {
            if (disposed) {
              return { status: 'failed', detail: 'File Host disposed' };
            }
            const owned =
              participants.get(context.group) ?? new Map<string, Participant>();
            owned.set(participantKey(context), {});
            participants.set(context.group, owned);
            return { status: 'ok' };
          },
          commit: context => {
            const current = participant(context);
            const file = current.file;
            if (file) {
              if (!file.ready || file.fd !== undefined) {
                return {
                  status: 'failed',
                  detail: 'Output file was not closed',
                };
              }
              const result = publish(
                file.path,
                join(directory, file.destination),
              );
              if (result.status !== 'ok') {
                return result;
              }
              files.delete(file);
            }
            finish(context, current);
            return { status: 'ok' };
          },
          rollback: context => {
            const current = participant(context);
            if (current.file) {
              discard(current.file);
            }
            finish(context, current);
            return { status: 'ok' };
          },
        }
      : undefined,
  );
  return {
    directory,
    grant: capability.grant('all', undefined),
    /** Host diagnostics: Scripts never receive descriptors or paths. */
    openHandles: () =>
      [...files].flatMap(file => (file.fd === undefined ? [] : [file.fd])),
    /** Stop and pump all Scripts using this Host before disposing it. */
    dispose: () => {
      if (disposed) {
        return;
      }
      for (const file of files) {
        if (file.fd !== undefined) {
          closeSync(file.fd);
          file.fd = undefined;
        }
      }
      rmSync(directory, { recursive: true, force: true });
      files.clear();
      reservations.clear();
      disposed = true;
    },
  };
};

// The Session Host of chapter 12, for a REPL or Playground.
export {
  SessionObjects,
  parseEnvelope,
  type Envelope,
  type ObjectReference,
} from './objects';
export {
  MOCK_ARGUMENTS,
  type DebugAction,
  type SourcePlacement,
  SessionHost,
  type Mock,
  type SessionEnvironment,
  type UserPrompt,
  type Waiting,
} from './host';
export {
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type Replayed,
  type ReplayOptions,
  type TranscriptItem,
} from './transcript';
export type { Setup } from '../setup';

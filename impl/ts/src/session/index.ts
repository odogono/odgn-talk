// The Session Host of chapter 12, for a REPL or Playground.
export {
  MOCK_ARGUMENTS,
  SessionHost,
  type Mock,
  type SessionEnvironment,
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

//! The Session Host and Session Transcripts (chapter 12), over talk.h.
pub const transcript = @import("transcript.zig");
/// The in-memory Stores, which the native Script Runner also grants.
pub const store = @import("store.zig");
/// A Transcript replayed through a Session.
pub const replay = @import("replay.zig");
const session = @import("session.zig");
pub const Session = session.Session;
pub const Driver = session.Driver;
pub const Instant = session.Instant;
pub const Answer = session.Answer;
pub const user_busy = session.user_busy;
pub const Waiting = session.Waiting;
pub const Resume = session.Resume;
pub const Prompt = session.Prompt;
pub const Clock = session.Clock;
pub const Limits = session.Limits;

test {
    _ = transcript;
    _ = session;
    _ = replay;
}

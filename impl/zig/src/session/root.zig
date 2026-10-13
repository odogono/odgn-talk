//! The Session Host and Session Transcripts (chapter 12), over talk.h.
pub const transcript = @import("transcript.zig");
const session = @import("session.zig");
pub const Session = session.Session;
pub const Driver = session.Driver;
pub const Instant = session.Instant;
pub const Answer = session.Answer;
pub const user_busy = session.user_busy;

test {
    _ = transcript;
    _ = session;
}

//! The reactor's image (`talk.wasm`): the Core's Message Layer, and the
//! Session Host it serves as `session-v1` (ADR 0180). The Session Host is
//! an ordinary Host over talk.h, so it sits here, beside the Core, rather
//! than in it.
const northtalk = @import("northtalk");
pub const session_v1 = @import("session_v1.zig");

var image: session_v1.Image = .{};

/// The Message Layer's extension (`message.Extension`), found by name.
pub const message_extension: northtalk.message.Extension = image.extension();

comptime {
    // The Core's exports: talk.h's, and the Message Layer's.
    _ = northtalk;
}

test {
    _ = session_v1;
    _ = @import("session_v1_test.zig");
}

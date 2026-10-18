//! Extend must reject local calls into an inherited deciding Handler's veto.
const std = @import("std");
const machine = @import("machine.zig");
const testing = std.testing;

test "Extend rejects inherited vetoes through command and function-style calls" {
    for ([_][]const u8{
        "on caller\n guarded\nend caller",
        "on caller\n return guarded()\nend caller",
        "on caller\n return given: guarded()\nend caller",
        "on caller, deciding\n guarded\nend caller",
        "on caller\n helper\nend caller\non helper\n guarded\nend helper",
    }) |source| {
        for ([_]bool{ false, true }) |in_extension| {
            var trace: std.Io.Writer.Allocating = .init(testing.allocator);
            defer trace.deinit();
            var g: machine.Group = .init(testing.allocator, &trace.writer);
            defer g.deinit();
            const guarded = "on guarded, deciding\n veto\nend guarded";
            const s = (try g.load("s", if (in_extension) "" else guarded, .{})).loaded;
            if (in_extension) try testing.expectEqual(.extended, try g.extend(s, guarded));
            const identity = s.identity;
            const extensions = s.extensions.items.len;
            try testing.expectEqual(.refused, try g.extend(s, source));
            try testing.expectEqual(identity, s.identity);
            try testing.expectEqual(extensions, s.extensions.items.len);
            const expected = if (in_extension)
                "diag s+2 code=\"veto outside a decision\" pos=2:2\n"
            else
                "diag s+1 code=\"veto outside a decision\" pos=2:2\n";
            try testing.expect(std.mem.endsWith(u8, trace.written(), expected));
            try testing.expectEqual(.extended, try g.extend(s, "on safe\n return 7\nend safe"));
        }
    }
}

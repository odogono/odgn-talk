//! Short admission/allocator critical sections; never held across a Host callback.
const std = @import("std");
pub const Lock = struct {
    held: std.atomic.Value(bool) = .init(false),
    pub fn lock(l: *Lock) void {
        while (l.held.cmpxchgWeak(false, true, .acquire, .monotonic) != null) std.atomic.spinLoopHint();
    }
    pub fn unlock(l: *Lock) void {
        l.held.store(false, .release);
    }
};

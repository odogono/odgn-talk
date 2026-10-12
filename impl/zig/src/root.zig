//! The NorthTalk Zig Core. Hosts use it through include/talk.h; see README.md.

pub const unicode = @import("unicode/unicode.zig");
pub const decimal = @import("decimal/decimal.zig");
pub const value = @import("value.zig");
pub const display = @import("display.zig");
pub const encoding = @import("encoding.zig");
pub const syntax = @import("syntax/syntax.zig");
pub const check = @import("check/check.zig");
pub const lower = @import("lower/lower.zig");
pub const machine = @import("machine/machine.zig");
pub const corpus_trace = @import("corpus/trace.zig");
pub const corpus_case = @import("corpus/case.zig");
pub const corpus_disassembly = @import("corpus/disassembly.zig");
pub const corpus_replay = @import("corpus/replay.zig");
pub const talk = @import("talk.zig");

/// Tables generated from the Spec's Data Files by tools/zig/generate.ts and
/// tools/unicode/generate.ts. Never edit them by hand.
pub const generated = struct {
    pub const corpus = @import("generated/corpus.zig");
    pub const costs = @import("generated/costs.zig");
    pub const diagnostics = @import("generated/diagnostics.zig");
    pub const errors = @import("generated/errors.zig");
    pub const grammar = @import("generated/grammar.zig");
    pub const limits = @import("generated/limits.zig");
    pub const machine = @import("generated/machine.zig");
    pub const opcodes = @import("generated/opcodes.zig");
    pub const rates = @import("generated/rates.zig");
    pub const stdlib = @import("generated/stdlib.zig");
    pub const unicode = @import("generated/unicode.zig");
    pub const units = @import("generated/units.zig");
    pub const version = @import("generated/version.zig");
};

comptime {
    // Keeps talk.h's exports in every build.
    _ = talk;
}

test {
    _ = unicode;
    _ = decimal;
    _ = value;
    _ = display;
    _ = encoding;
    _ = syntax;
    _ = check;
    _ = lower;
    _ = machine;
    _ = @import("machine/chunks.zig");
    _ = @import("machine/binary.zig");
    _ = @import("machine/convert.zig");
    _ = @import("machine/matcher.zig");
    _ = @import("machine/capabilities.zig");
    _ = @import("machine/standard.zig");
    _ = @import("pattern.zig");
    _ = corpus_trace;
    _ = corpus_case;
    _ = corpus_disassembly;
    _ = corpus_replay;
    _ = @import("dates.zig");
    _ = talk;
}

//! The Core's text primitives under the pinned Unicode version: UTF-8, NFC,
//! Characters (extended grapheme clusters), simple case folding and words.
//! Everything observable comes from the generated tables, never from `std`.

pub const version = @import("../generated/unicode.zig").unicode_version;

pub const utf8 = @import("utf8.zig");
pub const properties = @import("properties.zig");
pub const normalize = @import("normalize.zig");
pub const grapheme = @import("grapheme.zig");
pub const case = @import("case.zig");
pub const words = @import("words.zig");

pub const nfc = normalize.nfc;
pub const fold = case.fold;
pub const foldText = case.foldText;

test {
    _ = utf8;
    _ = properties;
    _ = normalize;
    _ = grapheme;
    _ = case;
    _ = words;
    _ = @import("conformance_test.zig");
    _ = @import("policy_test.zig");
}

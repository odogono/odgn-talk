//! The front end's syntax: the modal lexer of chapter 1, and the lossless
//! tree the parser of chapter 2 builds.
pub const lexer = @import("lexer.zig");
pub const ast = @import("ast.zig");
pub const parser = @import("parser.zig");

test {
    _ = lexer;
    _ = ast;
    _ = parser;
}

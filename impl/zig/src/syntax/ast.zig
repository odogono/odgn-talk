//! The syntax tree. Its shape is the Zig Core's own (chapter 2, Outside
//! parity): what is normative is the parse, as the lowering shows it. Every
//! node names its tokens by index into `Tree.tokens`, which hold every byte
//! of the source in order, so the tree reconstructs the source exactly.
const std = @import("std");
const lexer = @import("lexer.zig");

/// An index into `Tree.tokens`.
pub const Tok = u32;

pub const Tree = struct {
    source: []const u8,
    /// Every token, in source order, line breaks and the final `eof`
    /// included. A fenced literal with holes is split into pieces around its
    /// holes' tokens, so each token's text, with the trivia before it, follows
    /// the last.
    tokens: []const lexer.Token,
    declarations: []const Declaration,
    /// Fenced literals' decoded pieces, by opening offset.
    shared: *const lexer.Shared,

    pub fn token(self: *const Tree, t: Tok) lexer.Token {
        return self.tokens[t];
    }

    pub fn text(self: *const Tree, t: Tok) []const u8 {
        return self.tokens[t].text(self.source);
    }

    /// The source, rebuilt from the tokens and the trivia between them.
    pub fn reconstruct(self: *const Tree, w: *std.Io.Writer) std.Io.Writer.Error!void {
        var at: usize = 0;
        for (self.tokens) |t| {
            try w.writeAll(self.source[at..t.end]);
            at = t.end;
        }
        try w.writeAll(self.source[at..]);
    }
};

pub const Declaration = struct {
    /// `private`, if written.
    private: ?Tok,
    data: union(enum) {
        handler: Handler,
        function: Function,
        constant: Constant,
        script_variable: ScriptVariable,
        use: Use,
    },
};

pub const Handler = struct {
    on: Tok,
    /// `on any message`: the Fallback Handler.
    fallback: bool,
    /// The message name, or `any` for the Fallback Handler.
    name: Tok,
    /// The Argument Labels, in order; with them the name makes the Selector.
    labels: []const Tok,
    params: []const *Pattern,
    guard: ?Guard,
    /// `queued`, `dropping`, `replacing`, `deciding` and `during`, in order.
    suffixes: []const Tok,
    /// The Name after `during`.
    during: ?Tok,
    body: Block,
    finally: ?Finally,
    end: Tok,
};

pub const Finally = struct { keyword: Tok, body: Block };

pub const Guard = struct { where: Tok, condition: *Expr };

pub const Function = struct {
    keyword: Tok,
    name: Tok,
    params: []const Parameter,
    body: Block,
    end: Tok,
};

pub const Parameter = struct { name: Tok, default: ?*Expr };

pub const Constant = struct { keyword: Tok, name: Tok, value: *Expr };

pub const ScriptVariable = struct { keyword: Tok, name: Tok, value: ?*Expr };

pub const Use = struct { keyword: Tok, names: []const Tok, library: Tok, rename: ?Tok };

pub const Block = []const *Stmt;

pub const Stmt = struct {
    /// The statement's first token.
    first: Tok,
    data: Data,

    pub const Data = union(enum) {
        put: Put,
        let: Let,
        set: Set,
        arithmetic: Arithmetic,
        delete: *Expr,
        send: Send,
        ask: Operation,
        tell: Operation,
        tell_block: TellBlock,
        @"return": ?*Expr,
        veto: ?*Expr,
        pass: Pass,
        exit_repeat,
        next_repeat,
        throw: *Expr,
        replace: Replace,
        choose: Choose,
        call: CallStatement,
        command: Command,
        wait: *Expr,
        wait_for: WaitFor,
        wait_block: WaitBlock,
        join: Join,
        @"if": If,
        repeat: Repeat,
        match: Match,
        @"try": Try,
        timeout: Timeout,
    };
};

pub const Put = struct {
    spread: bool,
    value: *Expr,
    place: enum { into, after, before },
    place_token: Tok,
    target: *Expr,
};

pub const Let = struct { pattern: *Pattern, value: *Expr };

pub const Set = struct { target: *Expr, value: *Expr };

/// `add e to c`, `subtract e from c`, `multiply c by e`, `divide c by e`.
pub const Arithmetic = struct {
    op: enum { add, subtract, multiply, divide },
    target: *Expr,
    value: *Expr,
};

pub const ListItem = struct { spread: ?Tok, value: *Expr };

pub const Send = struct {
    /// The message's name, or null for a computed one.
    name: ?Tok,
    computed: ?*Expr,
    /// Labels, in the target-first form only.
    labels: []const Tok,
    args: []const ListItem,
    target: *Expr,
    target_first: bool,
    wait: ?Tok,
};

/// A one-line `ask` or `tell`, or a line of a `tell` block.
pub const Operation = struct {
    target: ?*Expr,
    operation: Tok,
    args: []const *Expr,
    /// An `ask`'s Result Target, `into name` (ADR 0112).
    into: ?Tok = null,
    wait: ?Tok,
};

pub const TellBlock = struct { target: *Expr, lines: []const Operation, end: Tok };

pub const Pass = struct {
    /// `pass any message`.
    any: bool,
    name: Tok,
    labels: []const Tok,
};

pub const Replace = struct {
    keyword: Tok,
    first: ?Tok,
    pattern: *Expr,
    target: *Expr,
    value: *Expr,
};

pub const Choose = struct { name: Tok, args: []const *Expr };

pub const CallStatement = struct { call: *Expr, wait: ?Tok };

pub const Command = struct {
    name: Tok,
    labels: []const Tok,
    args: []const *Expr,
    wait: ?Tok,
};

pub const Event = struct {
    name: Tok,
    labels: []const Tok,
    patterns: []const *Pattern,
    from: ?*Expr,
};

/// A one-line `wait for`. Its Guard comes after any timeout (ADR 0109).
pub const WaitFor = struct { event: Event, timeout: ?*Expr, guard: ?Guard };

pub const WaitBranch = struct {
    keyword: Tok,
    data: union(enum) {
        when: struct { event: Event, guard: ?Guard },
        after: *Expr,
    },
    body: Block,
};

pub const WaitBlock = struct { branches: []const WaitBranch, end: Tok };

pub const Join = struct { body: Block, end: Tok };

pub const Arm = struct { keyword: Tok, condition: *Expr, body: Block };

pub const If = struct {
    /// The `if` and each `else if`.
    arms: []const Arm,
    @"else": ?Block,
    one_line: bool,
    end: ?Tok,
};

pub const Repeat = struct {
    head: union(enum) {
        for_each: struct { pattern: *Pattern, source: *Expr },
        @"while": *Expr,
        until: *Expr,
        forever,
        times: *Expr,
    },
    collecting: ?Collecting,
    body: Block,
    end: Tok,
};

pub const Collecting = struct { keyword: Tok, value: *Expr, into: Tok };

pub const Match = struct {
    subject: *Expr,
    ignoring: ?Tok,
    branches: []const When,
    @"else": ?Block,
    end: Tok,
};

pub const When = struct {
    keyword: Tok,
    /// `when contains <…>`: a search, not a whole match.
    contains: bool,
    pattern: *Pattern,
    guard: ?Guard,
    body: Block,
};

pub const Try = struct {
    body: Block,
    offers: []const Offer,
    catches: []const Catch,
    finally: ?Finally,
    end: Tok,
};

pub const Offer = struct { keyword: Tok, name: Tok, params: []const Tok, body: Block };

pub const Catch = struct {
    keyword: Tok,
    pattern: *Pattern,
    /// `before unwind`: a Recovery Catch.
    recovery: ?Tok,
    guard: ?Guard,
    body: Block,
};

pub const Timeout = struct { duration: *Expr, body: Block, end: Tok };

/// A kind after `is a`, `can be`, `as` or in a Text Pattern: a Name,
/// `function`, or `civil date` (two tokens).
pub const Kind = struct { name: Tok, civil_date: bool };

/// The words that are values: `true`, `false`, `nothing`, `it` and `me`.
pub const Word = enum { true, false, nothing, it, me };

pub const BinaryOp = enum {
    otherwise,
    @"or",
    @"and",
    equal,
    not_equal,
    less,
    greater,
    less_equal,
    greater_equal,
    contains,
    matches,
    begins_with,
    ends_with,
    is_in,
    concat,
    range,
    add,
    subtract,
    multiply,
    divide,
    mod,
    div,
    power,
};

pub const Expr = struct {
    /// The construct's position for the source map (chapter 8): its
    /// operator, literal, name, opening bracket, chunk word, `the` or `'s`.
    pos: Tok,
    /// The tree's depth from here, bounded so that walking it is safe.
    depth: u16,
    data: Data,

    pub const Data = union(enum) {
        number: Tok,
        quantity: struct { number: Tok, unit: Tok },
        /// Quoted, raw or hole-free backtick text.
        text: Tok,
        /// A backtick literal with holes: its first piece's token, and each
        /// hole's expression.
        template: struct { open: Tok, holes: []const *Expr },
        word: Word,
        target,
        name: Tok,
        /// A Whose Key: `amount` as the first token of a Whose Clause's
        /// condition, read as `the amount of it`.
        whose_key: Tok,
        group: *Expr,
        binary: Binary,
        /// `is a`, `is not a`.
        is_kind: struct { value: *Expr, kind: Kind, negated: bool, ignoring: ?Tok },
        is_empty: struct { value: *Expr, negated: bool, ignoring: ?Tok },
        can_be: struct { value: *Expr, kind: Kind, ignoring: ?Tok },
        not: *Expr,
        negate: *Expr,
        /// `as`, to a kind or a Unit.
        conversion: struct { value: *Expr, kind: ?Kind, unit: ?Tok },
        /// `the k of x`, `x's k`, `the "k" of x`, `the (k) of x`.
        key: struct { base: *Expr, key: ?Tok, computed: ?*Expr },
        /// `the optional k of x`, `the optional "k" of x`, `the optional
        /// (k) of x`: a map-only read. `code points` is a literal key here.
        optional_key: struct { base: *Expr, key: ?Tok, code_points: bool, computed: ?*Expr },
        property: struct { base: *Expr, name: Tok, code_points: bool, delimiter: ?*Expr, delimited: ?Tok },
        chunk: Chunk,
        /// An Object Element Reference (#1143): `element s of o`, at
        /// `element`, or `the first element of o`, at `the`, whose ordinal
        /// stands for its integer selector.
        element: struct { index: ?*Expr, ordinal: ?Tok, of: *Expr },
        /// An Element Count, `the number of elements of o`, at `the`.
        element_count: *Expr,
        whose: Whose,
        list: []const ListItem,
        map: []const MapEntry,
        text_pattern: *TextPattern,
        build: []const BuildField,
        match_search: struct { pattern: *Expr, source: *Expr },
        replace: Replace,
        call: struct { name: Tok, args: []const *Expr },
        lambda: Lambda,
        /// `^n` in a parenthesised Binary Pattern size.
        pin: Tok,
    };
};

pub const Binary = struct {
    op: BinaryOp,
    left: *Expr,
    right: *Expr,
    /// `is not`, `does not`, and their spelt-out comparisons.
    negated: bool,
    ignoring: ?Tok,
};

pub const ChunkKind = enum { character, word, line, item, byte, code_point };

pub const Chunk = struct {
    kind: ChunkKind,
    /// The index, or for an ordinal chunk, the ordinal word.
    index: ?*Expr,
    ordinal: ?Tok,
    of: *Expr,
    /// On the outermost Chunk Expression of an `of` chain only.
    delimiter: ?*Expr,
    delimited: ?Tok,
};

pub const Whose = struct {
    whose: Tok,
    /// `every K of x`, or an ordinal Chunk Expression.
    every: bool,
    /// For `every`: its chunk word, kind, source and delimiter.
    word: Tok,
    kind: ChunkKind,
    source: *Expr,
    delimiter: ?*Expr,
    delimited: ?Tok,
    /// For an ordinal: the ordinal chunk.
    ordinal: ?*Expr,
    condition: *Expr,
};

pub const MapEntry = struct { key: Tok, value: *Expr };

pub const BuildField = struct { first: Tok, value: *Expr, type: ?FieldType };

pub const Lambda = struct {
    given: Tok,
    params: []const *Pattern,
    body: union(enum) { expr: *Expr, block: Block },
    end: ?Tok,
};

pub const Pattern = struct {
    first: Tok,
    /// `as name`, binding the whole value.
    bind_as: ?Tok,
    data: union(enum) {
        name: Tok,
        wildcard,
        pin: Tok,
        /// A text, `-`? number with an optional Unit, `true`, `false` or
        /// `nothing`.
        literal: struct { minus: ?Tok, value: Tok, unit: ?Tok },
        list: []const ListPatternItem,
        map: []const MapPatternEntry,
        text: *TextPattern,
        binary: []const BinaryField,
    },
};

pub const ListPatternItem = union(enum) {
    pattern: *Pattern,
    /// `...` or `...name`.
    rest: struct { ellipsis: Tok, name: ?Tok },
};

pub const MapPatternEntry = struct {
    key: Tok,
    /// Null for the shorthand `{name}`.
    pattern: ?*Pattern,
};

pub const TextPattern = struct {
    open: Tok,
    elements: []const *PatternElement,
    close: Tok,
};

pub const PatternElement = struct {
    first: Tok,
    data: union(enum) {
        text: Tok,
        count: struct { number: Tok, atom: *PatternElement },
        group: *TextPattern,
        splice: *Expr,
        capture: struct { name: Tok, alternation: *PatternElement },
        anchor: struct { first: Tok, second: Tok },
        class: struct { case: Tok, letters: Tok },
        repetition: struct { kind: enum { one_or_more, zero_or_more, optional }, atom: *PatternElement },
        typed: struct { article: Tok, kind: Kind },
        keyword: Tok,
        alternation: []const *PatternElement,
        modified: struct { atom: *PatternElement, modifier: Modifier },
    },

    pub const Modifier = union(enum) {
        as: struct { keyword: Tok, kind: Kind },
        lazily: Tok,
        ignoring: Tok,
    };
};

pub const BinaryField = struct {
    first: Tok,
    data: union(enum) {
        rest: struct { name: ?Tok, as_text: bool },
        literal: Tok,
        field: struct { name: Tok, type: FieldType },
    },
};

pub const FieldType = union(enum) {
    integer: struct { name: Tok, order: ?Tok },
    sized: struct { size: Size, unit: Tok, as_text: bool },
};

pub const Size = union(enum) {
    number: Tok,
    pin: Tok,
    name: Tok,
    expr: *Expr,
};

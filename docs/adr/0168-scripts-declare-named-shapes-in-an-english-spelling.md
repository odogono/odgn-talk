---
status: accepted
---

# Scripts declare named Shapes in an English spelling

Shapes can only be written in the Host Manifest's data spelling, which end users won't write by hand, so Scripts rarely use `conforms`, `check` and `explain` ([#2054](https://github.com/odogono/odgn-talk/issues/2054), [#2055](https://github.com/odogono/odgn-talk/issues/2055)). A Script now declares a named Shape in a readable spelling that lowers to that data, and tests a value against it with `is a` / `is an`, which end users already know from `is a number`.

```talk
shape Line is {sku: text, qty: number}
shape Invoice is {type: text, amount: GBP, ref: optional text, lines: list of Line}

on file msg
  if msg is an Invoice then store msg
  put check(msg, Invoice) into inv
end file
```

**What a name is**

- `shape Name is <Shape Expression>` is a top-level declaration, like `constant`. `shape` is a contextual keyword there and an ordinary Name everywhere else.
- The name is a Constant whose value is the Shape's canonical data ([chapter 9](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint)). So the Shape check Built-ins take it unchanged, the Variables window and `explain` show the data, and `private shape` and `use … from` follow the Constant rules. A Library may export Shapes: a Shape is data, and Libraries stay stateless.
- We rejected a separate Shape namespace. It would be a second model of names, visible only to `is a` and the Built-ins.

**The spelling**

| Written | Lowers to |
| --- | --- |
| `text`, `number`, `civil date`, `function`, … | the kind name |
| `any`, `value` | `"any"`, `"value"` |
| a Unit, such as `GBP` or `m/s` | `{quantity: unit}` |
| `a quantity of length` | `{unitKind: "length"}` |
| `object of Button` | `{object: "Button"}` |
| `list of S` | `{list: S}` |
| `optional S` | `{optional: S}` |
| `S or T or U` | `{oneOf: [S, T, U]}` |
| `{k: S, k2: optional S}` | `{map: [{key: "k", shape: S}, {key: "k2", shape: S, optional: true}]}` |
| `{k: S, ...}` | the same map, with `open: true` |
| another named Shape | its data, inlined |

- `or` binds loosest, and brackets group: `list of (text or number)`.
- `optional` straight after a map field's `:` marks the field optional, rather than wrapping its Shape; `(optional S)` wraps it.
- A Shape may name another, declared above or below it, or imported. The loader inlines the data. Data can't be recursive, so a cycle is an error.
- `list` and `object` without `of` are kind names, and `a` before anything but `quantity of` is a Name.
- Literal-value Shapes ([#861](https://github.com/odogono/odgn-talk/issues/861)) are left to a follow-up. A text literal in a Shape Expression is a syntax error for now, which keeps the spelling free for them.

**`is a` and names**

- After `is a` or `is an`, a Name is read as a kind or Unit first, then as a named Shape in scope. Anything else is still `unknown kind`. `is not an X` negates.
- Only a name declared with `shape` works after `is a`. Shape data in a variable or a plain Constant goes through `conforms(x, v)`. So `is a` is resolved at load, and the formatter and the LSP know what it names.
- A Shape named like a kind, a Unit or a Unit Kind is `bad shape`, so a name after `is a` never has two meanings. Any other clash is the usual `name clash`.
- `x is an X` is `conforms(x, X)`: it accepts the same values and charges the same Fuel, with no new cost row. `is a <kind>` is unchanged.

**Load errors**

A malformed declaration is the load diagnostic `bad shape`, reported at the offending token. It isn't `invalid shape`, the run-time error the Shape check Built-ins raise, because a code names one thing across the catalogues; `bad shape` follows `bad number` and `bad suffixes`. It covers a cycle, a name that is no kind, Unit or Shape in scope, an unknown Unit Kind, a duplicate map key, and a Shape named like a kind, Unit or Unit Kind. An `object of K` is checked against the Host Manifest's Object Kinds only when the unit loads with one; a Library loads without one, so it isn't checked there. A declaration that the loader accepts always lowers to data the Shape check Built-ins accept.

**Consequences**

- Grammar: `ShapeDecl` and the Shape Expression productions, the contextual keyword `shape`, `optional` in Shape position, and two second-token decisions (`list of`, `object of`; `a quantity of`).
- Tooling: the LSP hovers a Shape name with its source spelling and completes kinds and Shape names after `is a` and in Shape arguments; the formatter prints one canonical spelling.
- Delivery is staged, as [ADR 0057](0057-a-send-may-compute-its-message-name.md) did: the Spec, grammar and reference parser land first, with their parser cases in `tools/grammar/staged.talk`. The Core PRs ([#2105](https://github.com/odogono/odgn-talk/issues/2105), [#2106](https://github.com/odogono/odgn-talk/issues/2106)) bring the corpus cases, move the staged cases into `broken.talk` and turn the Spec's `text` examples into `talk`.

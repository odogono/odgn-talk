// PROTOTYPE (throwaway, issue #48): the load-time checks a Join needs, run on
// a parse tree that parsed cleanly. The rest of the checker (Grants, captured
// locals, may-suspend flags) is still out of scope, so two rules are only
// approximated:
//   * A Join Member is `send … and wait` or `ask … and wait` reached directly in
//     the Join body. Without Operation Declarations the prototype can't tell a
//     suspending Operation from an immediate one, so it trusts the `and wait`,
//     which ADR 0019's both-ways check would have verified.
//   * A Command Call written without `and wait` is assumed not to suspend.

import type { Node } from "./parser";

export interface Diagnostic {
  line: number;
  col: number;
  msg: string;
}

// Statement lists that belong to a statement, in source order.
function childBlocks(n: Node): Node[][] {
  const out: Node[][] = [];
  if (Array.isArray(n.body)) out.push(n.body);
  if (Array.isArray(n.then)) out.push(n.then);
  if (Array.isArray(n.else)) out.push(n.else);
  for (const b of n.branches ?? []) out.push(b.body);
  for (const c of n.catches ?? []) out.push(c.body);
  if (Array.isArray(n.finally)) out.push(n.finally);
  return out;
}

function at(n: Node, msg: string): Diagnostic {
  return { line: n.tok?.line ?? 0, col: n.tok?.col ?? 0, msg };
}

function containsMember(stmts: Node[]): Node | null {
  for (const s of stmts) {
    if ((s.k === "Send" || s.k === "Ask") && s.wait) return s;
    if (s.k === "Join") continue;
    for (const b of childBlocks(s)) {
      const m = containsMember(b);
      if (m) return m;
    }
  }
  return null;
}

// Check one Join's body. `loops` counts `repeat`s opened inside the Join, so
// `exit repeat` and `next repeat` can't leave it.
function checkBody(stmts: Node[], loops: number, out: Diagnostic[], members: { n: number }) {
  for (const s of stmts) {
    switch (s.k) {
      case "Send":
      case "Ask":
        if (s.wait) members.n++;
        break;
      case "Join":
        out.push(at(s, "a Join inside a Join: start every call from the outer one"));
        continue;
      case "Wait":
      case "WaitFor":
      case "WaitForBlock":
        out.push(at(s, "`wait` inside a Join: the Join's `end wait` is its only Suspension Point"));
        continue;
      case "Command":
        if (s.wait) out.push(at(s, `\`${s.name} … and wait\` runs in this Run, so it can't be a Join Member: \`send ${s.name} … to me and wait\` instead`));
        break;
      case "CallStatement":
        if (s.wait) out.push(at(s, "a Function Value called with `and wait` inside a Join: a local one runs in this Run, so it can't be a Join Member"));
        break;
      case "Return":
        out.push(at(s, "`return` inside a Join would leave with calls started and not waited for"));
        break;
      case "Pass":
        out.push(at(s, "`pass` inside a Join would leave with calls started and not waited for"));
        break;
      case "ExitRepeat":
      case "NextRepeat":
        if (loops === 0) out.push(at(s, `\`${s.k === "ExitRepeat" ? "exit" : "next"} repeat\` inside a Join can only reach a \`repeat\` inside the same Join`));
        break;
      case "Try": {
        const m = containsMember(s.body);
        if (m) out.push(at(m, "a Join Member inside `try`: its answer, or its failure, arrives at `end wait`, not here, so this `catch` would only see failures to start it"));
        break;
      }
    }
    for (const b of childBlocks(s)) checkBody(b, loops + (s.k === "Repeat" ? 1 : 0), out, members);
  }
}

// Every Join in a tree, including those in block Lambdas and nested Joins.
function joins(n: any, out: Node[]) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) joins(x, out);
    return;
  }
  if (n.k === "Join") out.push(n);
  for (const [k, v] of Object.entries(n)) if (k !== "tok") joins(v, out);
}

export function check(ast: Node[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const found: Node[] = [];
  joins(ast, found);
  for (const j of found) {
    const members = { n: 0 };
    checkBody(j.body, 0, out, members);
    if (members.n === 0) out.push(at(j, "a Join with no `send … and wait` or `ask … and wait` in it"));
  }
  // ADR 0019: checker diagnostics are normative in source order.
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

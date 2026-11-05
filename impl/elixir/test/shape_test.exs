defmodule NorthTalk.ShapeTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{LoadError, Map, Result, ScriptError}

  @source """
  shape Line is {sku: text, qty: number}
  shape Money is GBP or USD
  shape Invoice is {type: text, amount: Money, ref: optional text, ...}

  on check v
    return v is a Line
  end check

  on billed
    return {type: "inv", amount: 5 GBP} is an Invoice and {type: "inv", amount: 5 EUR} is not an Invoice
  end billed

  on classify msg where msg is an Invoice
    return "invoice"
  end classify

  on classify msg
    return "other"
  end classify

  on route item is a Line to place is a number
    return place
  end route

  on invoice
    return Invoice
  end invoice
  """

  setup do
    owner = start_supervised!({NorthTalk, []})
    group = NorthTalk.new_group!(owner, "g", [])
    "s" = NorthTalk.load!(group, "s", @source, [])
    %{group: group}
  end

  test "is a tests a Host value against a named Shape", %{group: group} do
    line = %Map{entries: [{"sku", "a"}, {"qty", 2}]}
    assert {:ok, %Result{value: true}} = NorthTalk.request(group, "s", "check", [line])
    assert {:ok, %Result{value: false}} = NorthTalk.request(group, "s", "check", [%{"sku" => 1}])
  end

  test "a named Shape reaches another and checks Units", %{group: group} do
    assert {:ok, %Result{value: true}} = NorthTalk.request(group, "s", "billed")
  end

  test "a where clause dispatches on a named Shape", %{group: group} do
    assert {:ok, %Result{value: "other"}} = NorthTalk.request(group, "s", "classify", ["x"])
  end

  test "a Clause Shape picks a clause, and a mismatch is unhandled", %{group: group} do
    line = %Map{entries: [{"sku", "a"}, {"qty", 2}]}
    assert {:ok, %Result{value: 4}} = NorthTalk.request(group, "s", "route:to:", [line, 4])
    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, "s", "route:to:", [line, "e4"])
  end

  test "is not a in a Handler head is a negated shape load error", %{group: group} do
    assert {:error, %LoadError{diagnostics: [%{"code" => "negated shape"} | _]}} =
             NorthTalk.load(group, "neg", "on h x is not a number\n  return x\nend h\n")
  end

  test "a Shape name evaluates to its canonical Shape data", %{group: group} do
    assert {:ok, %Result{value: %Map{entries: [{"map", [_, _, _]}, {"open", true}]}}} =
             NorthTalk.request(group, "s", "invoice")
  end

  test "a Shape cycle is a bad shape load error", %{group: group} do
    assert {:error, %LoadError{diagnostics: [%{"code" => "bad shape"} | _]}} =
             NorthTalk.load(group, "bad", "shape Tree is {children: list of Branch}\nshape Branch is Tree or text\n")
  end
end

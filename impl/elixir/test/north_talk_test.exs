defmodule NorthTalkTest do
  use ExUnit.Case, async: true
  alias NorthTalk.{Delivery, Group, HostError, LoadError, Result, ScriptError}

  defp owner(opts \\ []), do: start_supervised!({NorthTalk, opts}, id: make_ref())
  defp group(opts \\ []), do: NorthTalk.new_group!(owner(opts))

  test "a supervised owner validates hello and drives several isolated Groups" do
    owner = owner()
    assert {:ok, %{"core" => "zig/" <> _, "features" => features}} = NorthTalk.info(owner)
    assert "paused-inputs-v1" in features
    one = NorthTalk.new_group!(owner)
    two = NorthTalk.new_group!(owner)
    assert %Group{owner: ^owner} = one

    for {group, value} <- [{one, 1}, {two, 2}] do
      NorthTalk.load_script!(group, "s", "on ping\nreturn #{value}\nend ping")
    end

    assert %Result{value: %Decimal{coef: 1}} = NorthTalk.request!(one, "s", "ping")
    assert %Result{value: %Decimal{coef: 2}} = NorthTalk.request!(two, "s", "ping")
    assert {:error, %HostError{code: "wrong group"}} = NorthTalk.load_script(%{one | token: make_ref()}, "x", "")
  end

  test "Libraries compile and load without exposing protocol identities" do
    group = group()
    NorthTalk.load_library!(group, "util", "function scale n\nreturn n * 2\nend scale")

    NorthTalk.load_library!(group, "more", "use scale from util\nfunction triple n\nreturn scale(n) + n\nend triple",
      imports: ["util"]
    )

    NorthTalk.load_script!(group, "s", "use triple from more\non go\nreturn triple(5)\nend go")
    assert %Result{value: %Decimal{coef: 15}} = NorthTalk.request!(group, "s", "go")
    assert {:error, %HostError{code: "unknown library"}} = NorthTalk.load_library(group, "x", "", imports: ["absent"])
  end

  test "basic values survive the real reactor with decimal scale and NFC text" do
    group = group()
    NorthTalk.load_script!(group, "s", "on echo value\nreturn value\nend echo")

    for value <- [
          nil,
          true,
          false,
          [],
          %{},
          Decimal.new("1.2300"),
          Decimal.new("9007199254740992"),
          Decimal.new("1E+5"),
          Decimal.new("-0.00"),
          %{"$dec" => [Decimal.new("2.50"), "é"]}
        ] do
      expected = if value == Decimal.new("1E+5"), do: Decimal.new("100000"), else: value
      expected = if value == Decimal.new("-0.00"), do: Decimal.new("0.00"), else: expected
      assert %Result{value: ^expected} = NorthTalk.request!(group, "s", "echo", [value])
    end

    assert %Result{value: "é"} = NorthTalk.request!(group, "s", "echo", ["e\u0301"])
    assert %Result{value: %Decimal{coef: 42}} = NorthTalk.request!(group, "s", "echo", [42])

    for value <- [1.2, [1.2], %{a: 1}, %{"a" => 1, "b" => 2}, Decimal.new("NaN"), <<255>>] do
      assert {:error, %HostError{code: "invalid value"}} = NorthTalk.request(group, "s", "echo", [value])
    end

    assert %Result{value: nil} = NorthTalk.request!(group, "s", "echo", [nil])
  end

  test "manual drive separates acceptance from completion and preserves reports across slices" do
    group = group(drive: :manual, fuel_slice: 1000)
    NorthTalk.load_script!(group, "s", "on echo value\nwait 1 s\nreturn value\nend echo")
    assert {:ok, %Delivery{id: id} = receipt} = NorthTalk.request_async(group, "s", "echo", ["done"])
    waiter = Task.async(fn -> NorthTalk.await(receipt) end)
    now = ~U[2026-10-15 12:00:00Z]
    assert {:ok, first} = NorthTalk.pump(group, now)
    assert first["reports"] != []
    assert Task.yield(waiter, 10) == nil
    for _ <- 1..20, do: NorthTalk.pump!(group, DateTime.add(now, 1))
    assert {:ok, %Result{delivery: ^id, value: "done", report: report, reports: reports}} = Task.await(waiter)
    assert report["fuel"] > 0
    assert Enum.any?(reports, &(&1["kind"] == "run accounting"))
    assert {:error, %HostError{code: "clock backwards"}} = NorthTalk.pump(group, now)
    assert {:error, %HostError{code: "unknown delivery"}} = NorthTalk.await(receipt)
  end

  test "deliver returns acceptance and automatic driving wakes at a wait deadline" do
    group = group(fuel_slice: 1000)
    NorthTalk.load_script!(group, "s", "on nap\nwait 0.02 s\nreturn 7\nend nap")
    assert {:ok, %Delivery{id: id} = receipt} = NorthTalk.deliver(group, "s", "nap")
    assert {:ok, %Result{delivery: ^id, outcome: "completed", value: %Decimal{coef: 7}}} = NorthTalk.await(receipt)
    assert {:error, %HostError{code: "automatic drive"}} = NorthTalk.pump(group, ~U[2026-10-15 12:00:00Z])
  end

  test "load failures, Script errors, unhandled deliveries and bang variants" do
    group = group()

    assert {:error, %LoadError{diagnostics: [%{"line" => _, "col" => _, "code" => _} | _]}} =
             NorthTalk.load_script(group, "bad", "on broken")

    assert_raise LoadError, fn -> NorthTalk.load_script!(group, "bad", "on broken") end
    NorthTalk.load_script!(group, "s", "on broken\nreturn 1 / 0\nend broken")

    assert {:error, %ScriptError{code: "division by zero", delivery: id, report: report}} =
             NorthTalk.request(group, "s", "broken")

    assert is_binary(id)
    assert report["at"]["line"] == 2
    assert_raise ScriptError, fn -> NorthTalk.request!(group, "s", "broken") end
    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, "s", "missing")
    NorthTalk.load_script!(group, "passing", "on ping\npass ping\nend ping")
    assert {:error, %ScriptError{outcome: "unhandled"}} = NorthTalk.request(group, "passing", "ping")
  end

  test "a Limit Fault carries accounting and leaves the instance usable" do
    group = group(fuel_slice: 1000)
    NorthTalk.load_script!(group, "s", "on spin\nrepeat forever\nend repeat\nend spin\non ping\nreturn 42\nend ping")

    assert {:error, %ScriptError{outcome: "limit fault", report: report}} =
             NorthTalk.request(group, "s", "spin", [], limits: [fuel_per_run: 100])

    assert report["limit"] == "fuel"
    assert {:error, %HostError{code: "invalid value"}} = NorthTalk.request(group, "s", "ping", [], limits: [fuel: 100])

    assert {:error, %HostError{code: "invalid value"}} =
             NorthTalk.request(group, "s", "ping", [], limits: [call_depth: 10])

    assert %Result{value: %Decimal{coef: 42}} = NorthTalk.request!(group, "s", "ping")
  end

  test "independent instances and Groups progress while another Handler waits" do
    first = owner()
    waiting = NorthTalk.new_group!(first)
    peer = NorthTalk.new_group!(first)
    other = group()
    NorthTalk.load_script!(waiting, "s", "on nap\nwait 0.1 s\nreturn 1\nend nap")
    for group <- [peer, other], do: NorthTalk.load_script!(group, "s", "on ping\nreturn 2\nend ping")
    receipt = NorthTalk.request_async!(waiting, "s", "nap")
    assert %Result{value: %Decimal{coef: 2}} = NorthTalk.request!(peer, "s", "ping")
    assert %Result{value: %Decimal{coef: 2}} = NorthTalk.request!(other, "s", "ping")
    assert {:ok, %Result{value: %Decimal{coef: 1}}} = NorthTalk.await(receipt)
  end

  test "closing the owner releases pending awaiters" do
    owner = owner(drive: :manual)
    group = NorthTalk.new_group!(owner)
    NorthTalk.load_script!(group, "s", "on ping\nreturn 1\nend ping")
    receipt = NorthTalk.request_async!(group, "s", "ping")
    waiter = Task.async(fn -> NorthTalk.await(receipt) end)
    NorthTalk.close(owner)
    assert {:error, %HostError{delivery: id}} = Task.await(waiter)
    assert id == receipt.id
  end

  test "automatic execution yields across Fuel Slices and retains prior accounting" do
    group = group(fuel_slice: 20)

    NorthTalk.load_script!(
      group,
      "s",
      "on count\nput 0 into n\nrepeat 100 times\nput n + 1 into n\nend repeat\nreturn n\nend count"
    )

    assert %Result{value: %Decimal{coef: 100}, reports: reports} = NorthTalk.request!(group, "s", "count")
    accounting = Enum.filter(reports, &(&1["kind"] == "run accounting"))
    assert length(accounting) > 1
    assert List.last(accounting)["fuel"] > hd(accounting)["fuel"]
  end

  test "forget releases observation without cancelling a Delivery" do
    group = group(drive: :manual)

    NorthTalk.load_script!(
      group,
      "s",
      "script variable n = 0\non increment\nput n + 1 into n\nend increment\non read\nreturn n\nend read"
    )

    receipt = NorthTalk.deliver!(group, "s", "increment")
    assert {:ok, :forgotten} = NorthTalk.forget(receipt)
    assert {:error, %HostError{code: "unknown delivery"}} = NorthTalk.await(receipt)
    read = NorthTalk.request_async!(group, "s", "read")
    NorthTalk.pump!(group, ~U[2026-10-15 12:00:00Z])
    assert {:ok, %Result{value: %Decimal{coef: 1}}} = NorthTalk.await(read)
  end

  test "unsupported results preserve the completed report and do not repeat effects" do
    group = group()

    NorthTalk.load_script!(
      group,
      "s",
      "script variable n = 0\non unsupported\nput n + 1 into n\nreturn {a: n, b: n}\nend unsupported\non read\nreturn n\nend read"
    )

    assert {:error, %HostError{code: "invalid value", delivery: id, report: report}} =
             NorthTalk.request(group, "s", "unsupported")

    assert id == report["delivery"]
    assert report["outcome"] == "completed"
    assert %Result{value: %Decimal{coef: 1}} = NorthTalk.request!(group, "s", "read")
  end

  test "a Delivery's outcome is not retained once settled without awaiters" do
    group = group(drive: :manual)
    NorthTalk.load_script!(group, "s", "on go\nreturn 1\nend go")
    receipt = NorthTalk.deliver!(group, "s", "go")
    NorthTalk.pump!(group, ~U[2026-10-15 12:00:00Z])
    assert {:error, %HostError{code: "unknown delivery"}} = NorthTalk.await(receipt)
  end

  test "reports belong only to their own Delivery" do
    group = group(drive: :manual)
    NorthTalk.load_script!(group, "s", "on go\nreturn 1\nend go")
    first = NorthTalk.request_async!(group, "s", "go")
    second = NorthTalk.request_async!(group, "s", "go")
    NorthTalk.pump!(group, ~U[2026-10-15 12:00:00Z])

    for receipt <- [first, second] do
      assert {:ok, %Result{reports: reports}} = NorthTalk.await(receipt)
      assert reports != []
      runs = for %{"kind" => "run end", "run" => run} <- reports, do: run
      assert length(runs) == 1
      assert Enum.all?(reports, &(&1["run"] in [nil | runs]))
    end
  end
end

defmodule TalkHost.SessionTest do
  use ExUnit.Case, async: false
  alias TalkHost.{Session, Transport}

  @now "2026-10-10T12:00:00Z"

  test "fresh WASI instances stay within 16 MiB after a small Script and Pump" do
    memory = TalkHost.Measure.memory(fn -> Transport.Wasi.start(opt_level: :speed) end, 3)
    assert memory["maxBytes"] <= 16 * 1024 * 1024, inspect(memory)
  end

  transports = [Transport.Sidecar, Transport.Wasi] ++
    if(File.exists?(TalkHost.Artifacts.c_host()), do: [Transport.Bridge], else: [])

  for mod <- transports do
    test "#{inspect(mod)} answers an Operation inside a Pump" do
      {:ok, t} = unquote(mod).start([])

      s =
        Session.new(t,
          ops: %{"echo" => fn %{"args" => [x]} -> %{"result" => x, "charged" => 0} end}
        )

      {s, hello} = Session.ok!(s, "hello", %{"protocol" => 1})
      if unquote(mod) == TalkHost.Transport.Sidecar do
        assert hello["core"] =~ ~r{^zig/}
      else
        expected = if System.get_env("TALK_WASM"), do: ~r{^(go|zig)/}, else: ~r{^zig/}
        assert hello["core"] =~ expected
      end

      {s, _} =
        Session.ok!(s, "define-capability", %{
          "name" => "api",
          "ops" => [%{"name" => "echo", "mode" => "immediate", "args" => ["any"], "result" => "any"}]
        })

      {s, %{"grant" => grant}} = Session.ok!(s, "grant", %{"capability" => "api", "ops" => "all"})
      {s, _} = Session.ok!(s, "new-group", %{"group" => "g", "name" => "g"})

      {s, _} =
        Session.ok!(s, "load", %{
          "group" => "g",
          "name" => "s",
          "grants" => %{"api" => grant},
          "source" =>
            "on go\n  ask api to echo {items: [1, \"hello\", true], count: 1}\n  return it's count + 1\nend go\n"
        })

      {s, _} = Session.ok!(s, "deliver", %{"group" => "g", "to" => %{"script" => "s"}, "message" => %{"name" => "go"}})
      {_s, pump} = Session.ok!(s, "pump", %{"group" => "g", "now" => @now})
      assert [%{"outcome" => "completed", "result" => 2}] = Session.run_ends(pump)
      Transport.stop(t)
    end
  end
end

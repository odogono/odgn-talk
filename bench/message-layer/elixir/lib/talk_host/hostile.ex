defmodule TalkHost.Hostile do
  @moduledoc """
  Hostile input for the fault suite: pathological Script sources, seeded
  mutations of the Conformance Corpus's Scripts, and malformed frames.
  Everything is deterministic for a given seed.
  """

  @doc "Sources built to stress the lexer, parser and checker."
  def pathological do
    deep = 100_000

    [
      "on go\n  return #{String.duplicate("(", deep)}1#{String.duplicate(")", deep)}\nend go\n",
      "on go\n  return #{String.duplicate("[", deep)}#{String.duplicate("]", deep)}\nend go\n",
      "on go\n  return #{String.duplicate("{a: ", deep)}1#{String.duplicate("}", deep)}\nend go\n",
      "on go\n  return #{String.duplicate("-", deep)}1\nend go\n",
      "on go\n  return #{String.duplicate("1 + ", deep)}1\nend go\n",
      "on go\n  return #{String.duplicate("f(", deep)}1#{String.duplicate(")", deep)}\nend go\n",
      "on go\n" <> String.duplicate("if true then\n", 10_000) <> String.duplicate("end if\n", 10_000) <> "end go\n",
      "on go\n" <>
        String.duplicate("repeat forever\n", 10_000) <> String.duplicate("end repeat\n", 10_000) <> "end go\n",
      "on go\n  return \"#{String.duplicate("x", 10 * 1024 * 1024)}\"\nend go\n",
      "on go\n  put 1 into #{String.duplicate("a", 1024 * 1024)}\nend go\n",
      "on go\n  return #{String.duplicate("9", 1_000_000)}\nend go\n",
      "on go\n  return 1e999999999\nend go\n",
      "on go\n  return 0.#{String.duplicate("0", 1_000_000)}1\nend go\n",
      Enum.map_join(1..100_000, fn i -> "on h#{i}\nend h#{i}\n" end),
      Enum.map_join(1..20_000, fn i -> "function f#{i} n\n  return f#{i + 1}(n)\nend f#{i}\n" end) <>
        "on go\n  return f1(1)\nend go\n",
      "on go\n  return \"unterminated\nend go\n",
      "on go\n  -- a comment that never ends",
      "\uFEFFon go\n  return 1\nend go\n",
      "on go\r  return 1\rend go\r",
      "on go\n  return \"a\u0000b\"\nend go\n",
      "on go\n  return \"" <> List.to_string([0x202E, 0x2066, 0x200D, 0xFFFF]) <> "\"\nend go\n",
      String.duplicate("end ", 100_000),
      String.duplicate("\n", 1_000_000),
      ""
    ] ++ Enum.map(1..20, &random_text/1)
  end

  defp random_text(seed) do
    :rand.seed(:exsss, {seed, 17, 31})

    for _ <- 1..65_536, into: "" do
      case :rand.uniform(10) do
        n when n <= 6 -> <<Enum.random(32..126)>>
        7 -> "\n"
        8 -> Enum.random(["on ", "end ", "if ", "then ", "repeat ", "ask ", "(", ")", "[", "]", "\""])
        _ -> <<Enum.random(Enum.concat([0x80..0x7FF, 0x4E00..0x4FFF, 0x1F300..0x1F5FF]))::utf8>>
      end
    end
  end

  @tokens ~w|( ) [ ] { } " ' end on function repeat if then else ask tell to wait send it with try catch
             throw return & : , . .. -- 1e999999 0. 9999999999999999999999 « » \\ 🙂 é|
  @tokens @tokens ++ ["\n", "\t", " ", "\u0000", "\u00A0"]

  @doc "`count` mutations of the corpus's Scripts, each with one to five edits."
  def mutated(count, seed) do
    corpus =
      Path.join(TalkHost.Artifacts.root(), "corpus/**/*.talk")
      |> Path.wildcard()
      |> Enum.sort()
      |> Enum.map(&File.read!/1)

    :rand.seed(:exsss, {seed, 101, 7})

    for _ <- 1..count do
      source = Enum.random(corpus)
      Enum.reduce(1..:rand.uniform(5), source, fn _, s -> mutate(s) end)
    end
  end

  defp mutate(""), do: Enum.random(@tokens)

  defp mutate(s) do
    n = byte_size(s)
    at = :rand.uniform(n) - 1
    len = min(:rand.uniform(20), n - at)

    case :rand.uniform(4) do
      1 -> binary_part(s, 0, at) <> binary_part(s, at + len, n - at - len)
      2 -> binary_part(s, 0, at + len) <> binary_part(s, at, n - at)
      3 -> binary_part(s, 0, at) <> Enum.random(@tokens) <> binary_part(s, at, n - at)
      4 -> binary_part(s, at, n - at) <> binary_part(s, 0, at)
    end
    |> valid_utf8()
  end

  # A JSON string must be valid UTF-8, so a cut through a character becomes
  # U+FFFD. Invalid UTF-8 is sent separately, as a malformed frame.
  defp valid_utf8(s) do
    case :unicode.characters_to_binary(s) do
      bin when is_binary(bin) -> bin
      {_, good, rest} -> good <> "�" <> valid_utf8(binary_part(rest, 1, byte_size(rest) - 1))
    end
  end

  @doc "Frames that break JSON, the message shapes or the Value Encoding."
  def frames do
    deep = 100_000

    [
      {"empty", ""},
      {"truncated", "{"},
      {"stray close", "}"},
      {"null", "null"},
      {"array", "[]"},
      {"number", "1"},
      {"string", ~s("hello")},
      {"invalid UTF-8", <<"{\"m\":\"hello\",\"ref\":1,\"x\":\"", 0xFF, 0xFE, "\"}">>},
      {"lone surrogate", ~s({"m":"add","ref":1,"a":"\\ud800","b":1})},
      {"no ref", ~s({"m":"hello","protocol":1})},
      {"no m", ~s({"ref":1})},
      {"m not text", ~s({"m":1,"ref":1})},
      {"ref not integer", ~s({"m":"hello","ref":"x","protocol":1})},
      {"ref out of range", ~s({"m":"hello","ref":1e400,"protocol":1})},
      {"negative ref", ~s({"m":"hello","ref":-1,"protocol":1})},
      {"duplicate keys", ~s({"m":"hello","m":"add","ref":1,"protocol":1})},
      {"unknown message", ~s({"m":"nope","ref":1})},
      {"result with nothing pending", ~s({"m":"op-result","ref":1,"result":1})},
      {"deep JSON arrays",
       ~s({"m":"add","ref":1,"a":#{String.duplicate("[", deep)}#{String.duplicate("]", deep)},"b":1})},
      {"deep JSON objects",
       ~s({"m":"add","ref":1,"a":#{String.duplicate(~s({"a":), deep)}1#{String.duplicate("}", deep)},"b":1})},
      {"huge number", ~s({"m":"add","ref":1,"a":1e999999,"b":1})},
      {"long digits", ~s({"m":"add","ref":1,"a":#{String.duplicate("9", 1_000_000)},"b":1})},
      {"bad $dec", ~s({"m":"add","ref":1,"a":{"$dec":"abc"},"b":1})},
      {"bad $bytes", ~s({"m":"add","ref":1,"a":{"$bytes":"!!!"},"b":1})},
      {"bad $instant", ~s({"m":"add","ref":1,"a":{"$instant":"yesterday"},"b":1})},
      {"unknown tag", ~s({"m":"add","ref":1,"a":{"$nope":1},"b":1})},
      {"object of a missing Group", ~s({"m":"add","ref":1,"a":{"$object":["k","1"]},"b":1})},
      {"source not text", ~s({"m":"load","ref":1,"group":"g","name":"x","source":123})},
      {"missing Group", ~s({"m":"pump","ref":1,"group":"nope","now":"2026-10-10T12:00:00Z"})},
      {"a Group for the frames below", ~s({"m":"new-group","ref":1,"group":"frames","name":"frames"})},
      {"bad now", ~s({"m":"pump","ref":1,"group":"frames","now":"yesterday"})},
      {"clock forwards", ~s({"m":"pump","ref":1,"group":"frames","now":"2026-10-10T12:00:00Z"})},
      {"clock backwards", ~s({"m":"pump","ref":1,"group":"frames","now":"2000-01-01T00:00:00Z"})},
      {"bad limits",
       ~s({"m":"load","ref":1,"group":"frames","name":"x","source":"on go\\nend go","limits":{"fuelPerRun":-1}})},
      {"huge limits",
       ~s({"m":"load","ref":1,"group":"frames","name":"y","source":"on go\\nend go","limits":{"fuelPerRun":1e300}})},
      {"16 MiB of whitespace",
       " " <> String.duplicate(" ", 16 * 1024 * 1024) <> ~s({"m":"hello","ref":1,"protocol":1})},
      {"a frame over the 64 MiB frame limit",
       ~s({"m":"hello","ref":1,"protocol":1}) <> String.duplicate(" ", 64 * 1024 * 1024)}
    ]
  end
end

defmodule TalkHost.Session do
  @moduledoc """
  The Host's side of the Message Layer over one transport.

  `request/3` sends one message and returns its final reply. When the Core
  replies with a `need` (an `op` or `prop` reached inside a Pump), the
  Session answers it from `:ops` or `:props` under the same `ref` and keeps
  going, so the caller only sees `ok` or `err`.

  An `:ops` handler takes the `op` need and returns the `op-result` fields,
  such as `%{"result" => value}`. A `:props` handler does the same for `prop`.
  `:meta` holds whatever the caller wants to keep beside the session.
  """
  alias TalkHost.Transport

  defstruct [:transport, ref: 0, ops: %{}, props: nil, meta: %{}]

  def new(transport, opts \\ []) do
    %__MODULE__{transport: transport, ops: Keyword.get(opts, :ops, %{}), props: opts[:props]}
  end

  @doc """
  Sends `m` with `fields`. Returns `{session, reply}`, where the reply is the
  decoded JSON, `{:lost, reason}` or `{:refused, reason}`.
  """
  def request(%__MODULE__{} = s, m, fields \\ %{}) do
    s = %{s | ref: s.ref + 1}
    {s, exchange(s, Map.merge(fields, %{"m" => m, "ref" => s.ref}))}
  end

  @doc "Like `request/3`, but expects `ok` and returns its body."
  def ok!(s, m, fields \\ %{}) do
    case request(s, m, fields) do
      {s, %{"ok" => ok}} -> {s, ok}
      {_, other} -> raise "#{m} failed: #{inspect(other, limit: 20, printable_limit: 400)}"
    end
  end

  @doc "Sends a raw frame, bypassing encoding, and decodes whatever comes back."
  def raw(%__MODULE__{transport: t}, frame) do
    case Transport.exchange(t, frame) do
      {:ok, reply} -> JSON.decode!(reply)
      {:refused, reason} -> {:refused, reason}
      {:error, reason} -> {:lost, reason}
    end
  end

  defp exchange(s, message) do
    case Transport.exchange(s.transport, JSON.encode!(message)) do
      {:ok, reply} ->
        case JSON.decode!(reply) do
          %{"need" => need} -> exchange(s, answer(s, need))
          reply -> reply
        end

      {:refused, reason} ->
        {:refused, reason}

      {:error, reason} ->
        {:lost, reason}
    end
  end

  defp answer(s, %{"m" => "op", "operation" => op} = need) do
    handler = Map.get(s.ops, op) || fn _ -> %{"hostError" => %{"detail" => "no #{op}"}} end
    Map.merge(handler.(need), %{"m" => "op-result", "ref" => s.ref})
  end

  defp answer(s, %{"m" => "prop"} = need) do
    fields = if s.props, do: s.props.(need), else: %{"hostError" => %{"detail" => "no props"}}
    Map.merge(fields, %{"m" => "prop-result", "ref" => s.ref})
  end

  @doc "The `run end` reports in a `pump` reply."
  def run_ends(%{"reports" => reports}), do: Enum.filter(reports, &(&1["kind"] == "run end"))
  def run_ends(_), do: []
end

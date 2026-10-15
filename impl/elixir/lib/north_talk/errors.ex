defmodule NorthTalk.HostError do
  @moduledoc """
  Host misuse the Core refused, with a code from the Host error catalogue
  (spec/09-embedding.md#host-error-catalogue), or a failure on the Host's side
  such as a lost instance (`"instance lost"`) or a value with no NorthTalk
  form (`"invalid value"`).
  """
  defexception [:code, :detail]

  @impl true
  def message(%{code: code, detail: detail}) when detail in [nil, "", code], do: code
  def message(%{code: code, detail: detail}), do: "#{code}: #{detail}"
end

defmodule NorthTalk.LoadError do
  @moduledoc "A Script or Library that failed to load, with the Core's diagnostics."
  defexception diagnostics: []

  @impl true
  def message(%{diagnostics: diagnostics}) do
    Enum.map_join(diagnostics, "; ", fn d -> "#{d["unit"]}:#{d["line"]}:#{d["col"]}: #{d["message"]}" end)
  end
end

defmodule NorthTalk.ScriptError do
  @moduledoc """
  A Run that ended without completing. `outcome` is the `run end` report's,
  such as `"errored"`, `"unhandled"`, `"cancelled"` or `"faulted"`; `error` is
  its error, if any. `report` is the whole `run end` report.
  """
  defexception [:outcome, :error, :delivery, :report]

  @impl true
  def message(%{outcome: outcome, error: %{"code" => code} = error}),
    do: "#{outcome}: #{code}#{if m = error["message"], do: " (#{m})"}"

  def message(%{outcome: outcome}), do: outcome
end

defmodule NorthTalk.Result do
  @moduledoc """
  A completed Run: its `value`, its `delivery` id and its `run end` report,
  which carries the Fuel and allocation it used.
  """
  defstruct [:value, :delivery, :report]
end

defmodule NorthTalk.HostError do
  @moduledoc "A Host admission, compatibility, transport or unsupported-value failure."
  defexception [:code, :detail, :delivery, :call, :report, reports: []]
  @impl true
  def message(e), do: "#{e.code}: #{inspect(e.detail)}"
end

defmodule NorthTalk.LoadError do
  @moduledoc "Load-time diagnostics, with their original source locations."
  defexception diagnostics: []
  @impl true
  def message(e), do: "NorthTalk load failed: #{inspect(e.diagnostics)}"
end

defmodule NorthTalk.ScriptError do
  @moduledoc "An unsuccessful Handler outcome, preserving Script error data and accounting."
  defexception [:code, :message, :data, :delivery, :run, :outcome, :report, reports: []]
end

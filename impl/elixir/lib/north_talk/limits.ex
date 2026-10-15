defmodule NorthTalk.Limits do
  @moduledoc false
  alias NorthTalk.HostError

  @fields [
    fuel_per_run: "fuelPerRun",
    alloc_per_run: "allocPerRun",
    max_wait_ms: "maxWaitMs",
    max_join: "maxJoin",
    persistent_state: "persistentState",
    call_depth: "callDepth",
    pattern_size: "patternSize",
    mailbox_depth: "mailboxDepth",
    cleanup_budget: "cleanupBudget"
  ]
  @overrides [:fuel_per_run, :alloc_per_run, :max_wait_ms, :max_join]

  def options(opts, context) do
    if Keyword.has_key?(opts, :limits) do
      input = Keyword.fetch!(opts, :limits)

      unless is_list(input) and Keyword.keyword?(input) do
        raise HostError, code: "invalid value", detail: "limits must be a keyword list"
      end

      limits =
        Enum.map(input, fn {key, value} ->
          field = @fields[key]

          unless field && (context == :load or key in @overrides) && is_integer(value) && value >= 0 do
            raise HostError, code: "invalid value", detail: "invalid #{context} limit: #{inspect(key)}"
          end

          {field, if(value < NorthTalk.Value.safe_integer(), do: value, else: Integer.to_string(value))}
        end)

      Keyword.put(opts, :limits, Map.new(limits))
    else
      opts
    end
  end
end

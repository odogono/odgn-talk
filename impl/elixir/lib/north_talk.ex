defmodule NorthTalk do
  @moduledoc """
  Elixir Handler requests through a supervised Instance Owner and the Zig reactor.
  See the package README for automatic/manual driving and supported values.
  """
  alias NorthTalk.{Delivery, Group, HostError, Limits, Owner, Value}

  defdelegate start_link(opts \\ []), to: Owner
  defdelegate child_spec(opts), to: Owner

  @doc "Closes the instance and its Groups. Pending awaiters receive a HostError."
  def close(owner), do: GenServer.stop(owner)

  @doc "The validated hello reply, including the Core's feature markers."
  def info(owner), do: call(owner, :info)

  def new_group(owner, opts \\ []), do: call(owner, {:new_group, opts})

  def load_script(%Group{} = group, name, source, opts \\ []) do
    group_call(group, {:load, name, source, Limits.options(opts, :load)})
  rescue
    e in HostError -> {:error, e}
  end

  @doc "Compiles and adds a Library to this Group; imports name Libraries already loaded there."
  def load_library(%Group{} = group, name, source, opts \\ []) do
    group_call(group, {:library, name, source, opts})
  end

  @doc "Returns a receipt when accepted. Only callers already awaiting it receive the outcome."
  def deliver(%Group{} = group, script, handler, args \\ [], opts \\ []) do
    enqueue(group, "deliver", script, handler, args, opts)
  end

  @doc "Accepts a Request without awaiting it; useful with manual driving."
  def request_async(%Group{} = group, script, handler, args \\ [], opts \\ []) do
    enqueue(group, "request", script, handler, args, opts)
  end

  @doc "Accepts a Request and awaits its terminal outcome. Manual owners require another caller to Pump."
  def request(group, script, handler, args \\ [], opts \\ []) do
    with {:ok, receipt} <- request_async(group, script, handler, args, opts), do: await(receipt)
  end

  @doc "Awaits and consumes completion. All callers already waiting receive the same outcome."
  def await(%Delivery{group: group, id: id}) do
    case group_call(group, {:await, id}) do
      {:error, %HostError{} = error} -> {:error, %{error | delivery: id}}
      result -> result
    end
  end

  @doc "Discards a receipt's retained outcome without cancelling execution."
  def forget(%Delivery{group: group, id: id}), do: group_call(group, {:forget, id})

  @doc "Pumps a manually driven Group at a DateTime Clock reading, returning the complete Pump reply."
  def pump(%Group{} = group, %DateTime{} = now), do: group_call(group, {:pump, now})

  def new_group!(owner, opts \\ []), do: unwrap(new_group(owner, opts))
  def load_script!(group, name, source, opts \\ []), do: unwrap(load_script(group, name, source, opts))
  def load_library!(group, name, source, opts \\ []), do: unwrap(load_library(group, name, source, opts))
  def deliver!(group, script, handler, args \\ [], opts \\ []), do: unwrap(deliver(group, script, handler, args, opts))

  def request_async!(group, script, handler, args \\ [], opts \\ []),
    do: unwrap(request_async(group, script, handler, args, opts))

  def request!(group, script, handler, args \\ [], opts \\ []), do: unwrap(request(group, script, handler, args, opts))

  def await!(receipt), do: unwrap(await(receipt))
  def pump!(group, now), do: unwrap(pump(group, now))

  defp unwrap({:ok, result}), do: result
  defp unwrap({:error, error}), do: raise(error)

  defp enqueue(group, kind, script, handler, args, opts) when is_list(args) do
    encoded = Enum.map(args, &Value.encode/1)
    group_call(group, {:enqueue, kind, script, handler, encoded, Limits.options(opts, :delivery)})
  rescue
    e in HostError -> {:error, e}
  end

  defp group_call(%Group{owner: owner} = group, request), do: call(owner, {:group, group, request})

  defp call(owner, request) do
    GenServer.call(owner, request, :infinity)
  catch
    :exit, reason -> {:error, %HostError{code: "instance lost", detail: reason}}
  end
end

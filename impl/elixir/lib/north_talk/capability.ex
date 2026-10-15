defmodule NorthTalk.Capability do
  @moduledoc """
  A Capability: named Operations a Script calls with `ask` and `tell`, each
  answered by an Elixir function.

      defmodule MyApp.Inventory do
        use NorthTalk.Capability, name: "inventory", timeout: 2_000

        operation "count", args: ["text"], result: "number", cost: 1
        def count([sku], _call), do: {:ok, MyApp.Stock.count(sku)}

        operation "reserve", mode: :suspending, args: ["text"], result: "text", cost: 5,
          errors: [%{code: "sold out"}]
        def reserve([sku], call) do
          MyApp.Orders.reserve_later(sku, call.id)
          {:defer, call.id}
        end
      end

  Each `operation/2` names an Operation and declares it. Its callback is the
  function of the same name and arity 2, or the one `function:` names. It
  gets the Script's arguments as a list, already converted by
  `NorthTalk.Value`, and a `NorthTalk.Call`.

  ## Declarations

    * `:mode` - `:immediate` (the default), `:suspending` or `:fire_and_forget`.
    * `:args`, `:result` - Shapes, in the Host Manifest's data spelling, such
      as `"text"` or `%{"list" => "number"}`.
    * `:cost` - Fuel as an integer, or `%{fuel: f, alloc: a}`.
    * `:max_pending` - for a suspending Operation, the wait in milliseconds
      before the Core times the call out.
    * `:errors` - the declared failures, as `%{code: c, fields: [...]}`.
      Omitted, any code may be raised.
    * `:description`, `:examples` - documentation for tooling.

  ## Results

  A callback returns:

    * `{:ok, value}` - the Operation's result. For a suspending Operation it
      answers the call.
    * `{:error, failure}` - a declared failure, raised in the Script. A failure
      is a code, or `%{code: c, message: m, data: map}`.
    * `:noreply` - for a fire-and-forget Operation, which has no result.
    * `{:defer, ref}` - for a suspending Operation, settled later by
      `NorthTalk.answer/3` or `NorthTalk.fail/3` with the same `ref`, which
      must be unique among the owner's deferred calls.

  Anything else, a raise, an exit or a timeout is a Host failure: the Script
  raises `host error` and the detail goes in a `call failed` report.

  ## Where callbacks run

  Every callback runs in its own monitored Task, never in the Instance Owner.
  The owner waits for an immediate or fire-and-forget callback, up to the
  Capability's `:timeout`, 5 s by default, before the Run carries on, so
  these must not call their own owner. A suspending callback runs while the
  owner carries on, with no timeout of its own: the call waits until it is
  settled, or until the Core abandons it, at its `max_pending`, the Script's
  wait limit or when its Run ends. Abandoning a call kills its Task or
  forgets its deferred ref, and so does the owner's shutdown. A suspending
  callback may call its owner, but must not wait for a Run that needs this
  call settled to progress.
  """

  @enforce_keys [:name]
  defstruct [:name, timeout: 5_000, operations: %{}]

  @type failure :: String.t() | %{required(:code) => String.t(), optional(atom) => term}
  @type result :: {:ok, term} | {:error, failure} | :noreply | {:defer, term}

  @modes %{immediate: "immediate", suspending: "suspending", fire_and_forget: "fire-and-forget"}

  defmacro __using__(opts) do
    quote do
      import NorthTalk.Capability, only: [operation: 1, operation: 2]
      Module.register_attribute(__MODULE__, :north_talk_operations, accumulate: true)
      @north_talk_capability unquote(opts)
      @before_compile NorthTalk.Capability
    end
  end

  @doc "Declares an Operation of the Capability being defined."
  defmacro operation(name, opts \\ []) do
    quote do
      @north_talk_operations {unquote(name), unquote(opts)}
    end
  end

  defmacro __before_compile__(env) do
    opts = Module.get_attribute(env.module, :north_talk_capability)
    ops = env.module |> Module.get_attribute(:north_talk_operations) |> Enum.reverse()

    for {name, op_opts} <- ops do
      fun = Keyword.get(op_opts, :function, String.to_atom(name))

      unless Module.defines?(env.module, {fun, 2}) do
        raise CompileError,
          file: env.file,
          description: "Operation #{inspect(name)} needs #{inspect(env.module)}.#{fun}/2"
      end
    end

    quote do
      @doc false
      def __capability__ do
        NorthTalk.Capability.build(
          unquote(Keyword.fetch!(opts, :name)),
          for {name, op_opts} <- unquote(Macro.escape(ops)) do
            fun = Keyword.get(op_opts, :function, String.to_atom(name))
            {name, op_opts, {__MODULE__, fun}}
          end,
          unquote(Keyword.delete(opts, :name))
        )
      end
    end
  end

  @doc """
  A Capability from plain functions, for tests and quick experiments.
  `operations` maps each Operation's name to `{declaration, fun}`, where `fun`
  takes the arguments and a `NorthTalk.Call`.
  """
  def from_functions(name, operations, opts \\ []) do
    build(name, Enum.map(operations, fn {op, {decl, fun}} when is_function(fun, 2) -> {op, decl, fun} end), opts)
  end

  @doc false
  def build(name, operations, opts) do
    ops =
      Map.new(operations, fn {op, decl, fun} ->
        {op, %{mode: Keyword.get(decl, :mode, :immediate), declaration: declaration(op, decl), fun: fun}}
      end)

    %__MODULE__{name: name, timeout: Keyword.get(opts, :timeout, 5_000), operations: ops}
  end

  @doc "The Capability a module or a `from_functions/3` value stands for."
  def resolve(%__MODULE__{} = capability), do: capability
  def resolve(module) when is_atom(module), do: module.__capability__()

  @doc false
  def declarations(%__MODULE__{operations: ops}), do: Enum.map(ops, fn {_, op} -> op.declaration end)

  @doc false
  def invoke(%{fun: {module, fun}}, args, call), do: apply(module, fun, [args, call])
  def invoke(%{fun: fun}, args, call), do: fun.(args, call)

  defp declaration(name, decl) do
    mode = Keyword.get(decl, :mode, :immediate)
    unless Map.has_key?(@modes, mode), do: raise(ArgumentError, "unknown mode #{inspect(mode)}")

    [
      {"name", name},
      {"mode", @modes[mode]},
      {"args", Keyword.get(decl, :args, [])},
      {"result", decl[:result]},
      {"cost", cost(Keyword.get(decl, :cost, 0))},
      {"maxPending", decl[:max_pending]},
      {"errors", decl[:errors] && Enum.map(decl[:errors], &error_decl/1)},
      {"description", decl[:description]},
      {"examples", decl[:examples]}
    ]
    |> Enum.reject(fn {_, v} -> is_nil(v) end)
    |> Map.new()
  end

  defp cost(fuel) when is_integer(fuel), do: %{"fuel" => fuel}
  defp cost(%{} = c), do: %{"fuel" => c[:fuel] || 0, "alloc" => c[:alloc] || 0}

  defp error_decl(%{code: code} = e), do: %{"code" => code, "fields" => Map.get(e, :fields, [])}
end

defmodule NorthTalk.Call do
  @moduledoc """
  One Operation call, as its callback sees it: the call `id`, unique within
  its Group, the `group` and `script` making it, the `grant` name the Script
  used and that Grant's `binding`, the `capability` and `operation`, the
  `mode`, and `now`, the Pump's Clock reading as `$instant` text.
  """
  defstruct [:id, :owner, :group, :script, :grant, :binding, :capability, :operation, :mode, :now]
end

defmodule NorthTalk.Grant do
  @moduledoc """
  A Grant of some of a Capability's Operations, with the Host's own
  `binding`, which every call through it reads. Pass it to `NorthTalk.load/4`
  under the name the Script uses: `grants: %{"stock" => grant}`. One Grant may
  be given to many Scripts, and one Capability granted under several names
  with different bindings.
  """
  defstruct [:owner, :handle, :capability, :binding]
end

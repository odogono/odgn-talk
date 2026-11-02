defmodule NorthTalk.ObjectKind do
  @moduledoc """
  An Object Kind: the properties, and optionally the Object Collection, of the
  Host Objects made with it. Define it once per owner with
  `NorthTalk.define_object_kind/2`, then make its Objects with
  `NorthTalk.object/5`.

      kind =
        NorthTalk.ObjectKind.new("door",
          props: %{
            "isLocked" => [shape: "truth", get: &Doors.locked?/1, set: &Doors.set_locked/2, get_cost: 1]
          },
          elements: [
            shape: %{"object" => "key"},
            count: &Doors.key_count/1,
            at: &Doors.key_at/2,
            find: &Doors.key_named/2
          ]
        )

  Every callback takes the Object's `native` term first, as given to
  `NorthTalk.object/5`, and runs in a Task, up to the Kind's `:timeout`
  (5 s by default), as an immediate Operation's callback does:

    * a property's `get` takes `native` and returns `{:ok, value}`;
    * its `set`, if any, takes `native` and the new value and returns `:ok`.
      A property with no `set` is read-only;
    * the collection's `count` takes `native` and returns `{:ok, n}`; `at`
      takes `native` and an index, from 1 at the front or -1 at the back, and
      `find` takes `native` and a name. Each returns `{:ok, object}`, or
      `{:ok, nil}` when no member matches.

  Any callback may return `{:error, failure}`, a failure as an Operation's;
  the Script sees it with `capability` the Kind's name. A raise, an exit, a
  timeout or anything else is a Host failure.

  `shape` is a Shape as an Operation declares it, `"value"` by default for a
  property. Each cost is a Fuel count, or `%{fuel: f, alloc: a}`, 0 by
  default. A collection's `shape` is an Object Shape, or a choice of them.
  `:parent_kinds` lists the Kinds an Object of this Kind may sit under, for the
  Host Manifest only.
  """

  @type cost :: non_neg_integer() | %{optional(:fuel) => non_neg_integer(), optional(:alloc) => non_neg_integer()}
  @type t :: %__MODULE__{
          name: String.t(),
          props: %{String.t() => map()},
          elements: map() | nil,
          parent_kinds: [String.t()],
          timeout: timeout()
        }
  @enforce_keys [:name]
  defstruct [:name, :elements, props: %{}, parent_kinds: [], timeout: 5_000]

  @doc """
  An Object Kind named `name`. Options: `:props`, a map of property name to
  its options (`:shape`, `:get`, `:set`, `:get_cost`, `:set_cost`),
  `:elements` (`:shape`, `:count`, `:at`, `:find`, `:count_cost`, `:at_cost`,
  `:find_cost`), `:parent_kinds` and `:timeout`. A missing callback or an
  invalid cost raises `ArgumentError`.
  """
  def new(name, opts \\ []) when is_binary(name) do
    props = Map.new(Keyword.get(opts, :props, %{}), fn {prop, o} -> {to_string(prop), prop(name, prop, o)} end)

    %__MODULE__{
      name: name,
      props: props,
      elements: if(e = opts[:elements], do: elements(name, e)),
      parent_kinds: Keyword.get(opts, :parent_kinds, []),
      timeout: Keyword.get(opts, :timeout, 5_000)
    }
  end

  defp prop(kind, prop, o) do
    get = o[:get]
    set = o[:set]
    unless is_function(get, 1), do: raise(ArgumentError, "#{kind}.#{prop} needs a get function of arity 1")
    unless set == nil or is_function(set, 2), do: raise(ArgumentError, "#{kind}.#{prop}'s set takes 2 arguments")

    %{
      shape: Keyword.get(o, :shape, "value"),
      get: get,
      set: set,
      get_cost: cost(kind, Keyword.get(o, :get_cost, 0)),
      set_cost: cost(kind, Keyword.get(o, :set_cost, 0))
    }
  end

  defp elements(kind, e) do
    for {cb, arity} <- [count: 1, at: 2, find: 2], not is_function(e[cb], arity) do
      raise ArgumentError, "#{kind}'s elements need a #{cb} function of arity #{arity}"
    end

    unless e[:shape], do: raise(ArgumentError, "#{kind}'s elements need a shape")

    %{
      shape: e[:shape],
      count: e[:count],
      at: e[:at],
      find: e[:find],
      count_cost: cost(kind, Keyword.get(e, :count_cost, 0)),
      at_cost: cost(kind, Keyword.get(e, :at_cost, 0)),
      find_cost: cost(kind, Keyword.get(e, :find_cost, 0))
    }
  end

  defp cost(_, n) when is_integer(n) and n >= 0, do: %{"fuel" => n, "alloc" => 0}

  defp cost(kind, %{} = c) do
    fuel = Map.get(c, :fuel, 0)
    alloc = Map.get(c, :alloc, 0)

    if is_integer(fuel) and fuel >= 0 and is_integer(alloc) and alloc >= 0,
      do: %{"fuel" => fuel, "alloc" => alloc},
      else: raise(ArgumentError, "#{kind}: #{inspect(c)} is not a cost")
  end

  defp cost(kind, other), do: raise(ArgumentError, "#{kind}: #{inspect(other)} is not a cost")

  @doc false
  def declaration(%__MODULE__{} = kind) do
    props =
      kind.props
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {name, p} ->
        %{
          "name" => name,
          "shape" => p.shape,
          "readOnly" => p.set == nil,
          "getCost" => p.get_cost,
          "setCost" => p.set_cost
        }
      end)

    decl = %{"name" => kind.name, "props" => props, "parentKinds" => kind.parent_kinds}

    case kind.elements do
      nil ->
        decl

      e ->
        Map.put(decl, "elements", %{
          "shape" => e.shape,
          "countCost" => e.count_cost,
          "atCost" => e.at_cost,
          "findCost" => e.find_cost
        })
    end
  end

  @doc false
  def invoke(fun, args), do: apply(fun, args)
end

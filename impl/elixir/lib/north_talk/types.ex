defmodule NorthTalk.Bytes do
  @moduledoc """
  NorthTalk Bytes. An Elixir binary is text, so Bytes are wrapped to keep the
  two kinds apart.
  """
  @type t :: %__MODULE__{data: binary()}
  @enforce_keys [:data]
  defstruct [:data]

  def new(data) when is_binary(data), do: %__MODULE__{data: data}
end

defmodule NorthTalk.Quantity do
  @moduledoc """
  A Quantity: an `amount`, an integer or a `Decimal`, in a `unit`, as text in
  normal form with every word Unit singular, such as `"GBP"` or `"day"`. The
  Core refuses a Unit not in normal form.
  """
  @type t :: %__MODULE__{amount: integer() | Decimal.t(), unit: String.t()}
  @enforce_keys [:amount, :unit]
  defstruct [:amount, :unit]

  def new(amount, unit), do: %__MODULE__{amount: amount, unit: unit}
end

defmodule NorthTalk.Range do
  @moduledoc "A range from `from` to `to`, both values."
  @type t :: %__MODULE__{from: term(), to: term()}
  @enforce_keys [:from, :to]
  defstruct [:from, :to]

  def new(from, to), do: %__MODULE__{from: from, to: to}
end

defmodule NorthTalk.Pattern do
  @moduledoc """
  A Text Pattern, by its canonical source, such as `<"ID-", 4 digits>`. The
  Core re-parses it on input.
  """
  @type t :: %__MODULE__{source: String.t()}
  @enforce_keys [:source]
  defstruct [:source]

  def new(source), do: %__MODULE__{source: source}
end

defmodule NorthTalk.Instant do
  @moduledoc """
  An Instant: a point on the global timeline, as whole microseconds since the
  Unix epoch, in UTC ([ADR 0091](../../docs/adr/0091-time-has-microsecond-resolution.md)).
  A `DateTime` is accepted on input, truncated toward the past to the
  microsecond, and `to_datetime/1` is exact.
  """
  @type t :: %__MODULE__{unix_us: integer()}
  @enforce_keys [:unix_us]
  defstruct [:unix_us]

  def from_datetime(%DateTime{} = dt),
    do: %__MODULE__{unix_us: DateTime.to_unix(dt, :microsecond)}

  @doc "The `DateTime`, in UTC, with microsecond precision."
  def to_datetime(%__MODULE__{unix_us: us}), do: DateTime.from_unix!(us, :microsecond)

  @doc false
  def format(%__MODULE__{unix_us: us}) do
    seconds = Integer.floor_div(us, 1_000_000)
    base = seconds |> DateTime.from_unix!() |> DateTime.to_iso8601() |> String.trim_trailing("Z")
    base <> NorthTalk.CivilDate.fraction(Integer.mod(us, 1_000_000)) <> "Z"
  end

  @doc false
  def parse(text) do
    with [_, civil] <- Regex.run(~r/\A(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?)Z\z/, text),
         {:ok, %{microsecond: us} = c} <- NorthTalk.CivilDate.parse(civil),
         {:ok, naive} <- NaiveDateTime.new(c.year, c.month, c.day, c.hour, c.minute, c.second) do
      instant = %__MODULE__{unix_us: DateTime.to_unix(DateTime.from_naive!(naive, "Etc/UTC"), :microsecond) + us}
      if format(instant) == text, do: {:ok, instant}, else: :error
    else
      _ -> :error
    end
  end
end

defmodule NorthTalk.CivilDate do
  @moduledoc """
  A Civil Date: a calendar date with an optional time of day to the
  microsecond, and no zone. A date-only value has `nil` time fields. `Date`
  and `NaiveDateTime` are accepted on input, a `NaiveDateTime` truncated
  toward the past to the microsecond.
  """
  @type t :: %__MODULE__{
          year: integer(),
          month: integer(),
          day: integer(),
          hour: integer() | nil,
          minute: integer() | nil,
          second: integer() | nil,
          microsecond: integer() | nil
        }
  @enforce_keys [:year, :month, :day]
  defstruct [:year, :month, :day, :hour, :minute, :second, :microsecond]

  def from_date(%Date{year: y, month: m, day: d}), do: %__MODULE__{year: y, month: m, day: d}

  def from_naive(%NaiveDateTime{microsecond: {us, _}} = n) do
    %__MODULE__{
      year: n.year,
      month: n.month,
      day: n.day,
      hour: n.hour,
      minute: n.minute,
      second: n.second,
      microsecond: us
    }
  end

  @doc false
  def format(%__MODULE__{hour: nil} = c), do: date(c)

  def format(%__MODULE__{} = c),
    do: date(c) <> "T" <> Enum.map_join([c.hour, c.minute, c.second], ":", &pad(&1, 2)) <> fraction(c.microsecond)

  defp date(c), do: "#{pad(c.year, 4)}-#{pad(c.month, 2)}-#{pad(c.day, 2)}"
  defp pad(n, width), do: n |> Integer.to_string() |> String.pad_leading(width, "0")

  @doc false
  # The shortest fraction of a second given in microseconds: none for whole
  # seconds.
  def fraction(0), do: ""
  def fraction(us), do: "." <> (us |> pad(6) |> String.trim_trailing("0"))

  @doc false
  def parse(text) do
    case Regex.run(~r/\A(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?)?\z/, text) do
      [_, y, m, d | time] ->
        [y, m, d] = Enum.map([y, m, d], &String.to_integer/1)
        c = %__MODULE__{year: y, month: m, day: d}

        c =
          case time do
            [] ->
              c

            [h, mi, s | f] ->
              us = String.to_integer(String.pad_trailing(List.first(f, "0"), 6, "0"))
              [h, mi, s] = Enum.map([h, mi, s], &String.to_integer/1)
              %{c | hour: h, minute: mi, second: s, microsecond: us}
          end

        if y >= 1 and match?({:ok, _}, Date.new(y, m, d)) and
             (c.hour == nil or (c.hour < 24 and c.minute < 60 and c.second < 60)),
           do: {:ok, c},
           else: :error

      nil ->
        :error
    end
  end
end

defmodule NorthTalk.Object do
  @moduledoc """
  An opaque Host Object handle: its Object Kind and id. One that came from a
  Group remembers it, and is refused in any other with `wrong group`.
  """
  @type t :: %__MODULE__{kind: String.t(), id: String.t(), group: String.t() | nil}
  @enforce_keys [:kind, :id]
  defstruct [:kind, :id, :group]
end

defmodule NorthTalk.Function do
  @moduledoc """
  A handle to a Function Value a Script gave the Host, bound to its Group
  and Instance Owner. `home` is its Home Script and `display` its display
  form.

  Call it with `NorthTalk.call/4` through its own Group. The handle is held
  until `NorthTalk.release/1`, or until its Group or owner closes; there are
  no finalisers. Using it after that, through another Group or through a dead
  owner, is a `NorthTalk.HostError`.
  """
  @type t :: %__MODULE__{owner: pid(), group: String.t(), id: reference(), home: String.t(), display: String.t()}
  @enforce_keys [:owner, :group, :id]
  defstruct [:owner, :group, :id, :home, :display]

  defimpl Inspect do
    def inspect(f, _opts), do: "#NorthTalk.Function<#{f.display} in #{f.group}>"
  end
end

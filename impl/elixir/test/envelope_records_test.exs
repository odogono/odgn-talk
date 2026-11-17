defmodule NorthTalk.EnvelopeRecordsTest do
  use ExUnit.Case, async: true

  alias NorthTalk.Generated.Envelope
  alias NorthTalk.Generated.Envelope.Records

  # Every JSON-layout vector fills its generated struct through the record's
  # field descriptors, with no field left over (ADR 0183).
  @vectors "../testdata/envelope-frames.json"
           |> File.read!()
           |> Jason.decode!()

  defp record(%{"view" => view}), do: {"view", view}
  defp record(%{"message" => message}), do: {"json message", message}

  defp record(%{"tag" => tag}) do
    case Enum.find(Envelope.messages(), &(&1.tag == tag)) do
      %{layouts: [:fields, :json], name: name} -> {"message", name}
      _ -> nil
    end
  end

  defp fill(module, tree) do
    fields = module.fields()

    pairs =
      for {name, value} <- Map.delete(tree, "m") do
        field = Enum.find(fields, &(&1.name == name)) || flunk("#{inspect(module)} lacks #{name}")
        {field.key, nest(field, value)}
      end

    for field <- fields, field.required, do: assert(Map.has_key?(tree, field.name), "missing #{field.name}")
    struct!(module, pairs)
  end

  defp nest(%{kind: :views, view: view}, items) do
    module = Records.records() |> Map.fetch!({"view", view})
    Enum.map(items, &fill(module, &1))
  end

  defp nest(_field, value), do: value

  test "JSON vectors fill the generated records" do
    checked =
      for vector <- @vectors, key = record(vector), key != nil do
        module = Map.fetch!(Records.records(), key)
        assert %{__struct__: ^module} = fill(module, Jason.decode!(vector["tree"]))
      end

    assert length(checked) > 0
  end
end

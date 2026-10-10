defmodule TalkHost.Artifacts do
  @moduledoc """
  The Go Core builds this Host loads, kept in the repository's `.cache/`.
  `build!/0` makes them with the commands in impl/go/README.md.
  """

  def root, do: Path.expand("../../..", File.cwd!())
  def wasm, do: Path.join(root(), ".cache/messagelayer.wasm")
  def sidecar, do: Path.join(root(), ".cache/messagelayer")
  def linux_sidecar, do: Path.join(root(), ".cache/messagelayer-linux-#{linux_arch()}")

  def build! do
    File.mkdir_p!(Path.join(root(), ".cache"))
    out = fn path -> Path.relative_to(path, Path.join(root(), "impl/go"), force: true) end

    go!(%{"GOOS" => "wasip1", "GOARCH" => "wasm"}, [
      "-buildmode=c-shared",
      "-ldflags=-s -w",
      "-o",
      out.(wasm()),
      "./cmd/messagelayer-wasi"
    ])

    go!(%{}, ["-o", out.(sidecar()), "./cmd/messagelayer"])

    go!(%{"CGO_ENABLED" => "0", "GOOS" => "linux", "GOARCH" => linux_arch()}, [
      "-o",
      out.(linux_sidecar()),
      "./cmd/messagelayer"
    ])
  end

  defp go!(env, args) do
    args = ["-C", Path.join(root(), "impl/go"), "build", "-trimpath", "-buildvcs=false" | args]
    {_, 0} = System.cmd("go", args, env: env, into: IO.stream())
  end

  defp linux_arch do
    case :erlang.system_info(:system_architecture) |> to_string() do
      "aarch64" <> _ -> "arm64"
      "arm64" <> _ -> "arm64"
      _ -> "amd64"
    end
  end
end

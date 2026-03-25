defmodule SymphonyElixir.Caddy do
  @moduledoc "Caddy reverse proxy admin API client."

  require Logger

  @caddy_admin_url "http://caddy:2019"

  @spec configure_domain(String.t()) :: :ok | {:error, term()}
  def configure_domain(domain) when is_binary(domain) do
    config = %{
      "apps" => %{
        "http" => %{
          "servers" => %{
            "srv0" => %{
              "listen" => [":443", ":80"],
              "routes" => [
                %{
                  "match" => [%{"host" => [domain]}],
                  "handle" => [
                    %{
                      "handler" => "reverse_proxy",
                      "upstreams" => [%{"dial" => "symphony:4000"}]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }

    case Req.post("#{@caddy_admin_url}/load", json: config) do
      {:ok, %{status: status}} when status in 200..299 ->
        Logger.info("Caddy configured for domain: #{domain}")
        :ok

      {:ok, %{status: status, body: body}} ->
        Logger.error("Caddy config failed: #{status} #{inspect(body)}")
        {:error, {:caddy_error, status, body}}

      {:error, reason} ->
        Logger.error("Caddy request failed: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @spec remove_domain() :: :ok | {:error, term()}
  def remove_domain do
    config = %{
      "apps" => %{
        "http" => %{
          "servers" => %{
            "srv0" => %{
              "listen" => [":80"],
              "routes" => [
                %{
                  "handle" => [
                    %{
                      "handler" => "reverse_proxy",
                      "upstreams" => [%{"dial" => "symphony:4000"}]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }

    case Req.post("#{@caddy_admin_url}/load", json: config) do
      {:ok, %{status: status}} when status in 200..299 ->
        Logger.info("Caddy domain removed, reverted to HTTP-only")
        :ok

      {:ok, %{status: status, body: body}} ->
        Logger.error("Caddy config removal failed: #{status} #{inspect(body)}")
        {:error, {:caddy_error, status, body}}

      {:error, reason} ->
        Logger.error("Caddy request failed: #{inspect(reason)}")
        {:error, reason}
    end
  end
end

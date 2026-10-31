Self-signed certificates for the `http.fetch` Host tests (ADR 0151), valid
for 100 years. `local` names `localhost` and `127.0.0.1`; `other` names only
`other.example`, so a request to `127.0.0.1` fails host name verification.
They secure nothing: the keys are public test fixtures.

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout local.key -out local.crt -days 36500 -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
      -addext "basicConstraints=critical,CA:TRUE"

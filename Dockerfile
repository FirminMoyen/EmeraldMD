# syntax=docker/dockerfile:1
#
# The self-hosted EmeraldMD server (crates/emerald-server). Build from the
# repository root:
#
#   docker build -t emeraldmd-server .
#
# See docs/self-hosting.md for configuration and running behind HTTPS.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Only the server is compiled; the desktop crate's manifest is needed because
# it is a workspace member.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p emerald-server \
    && cp target/release/emeraldmd-server /usr/local/bin/emeraldmd-server

# glibc and libgcc only, no shell; runs as the unprivileged "nonroot" user
# (uid 65532) unless `--user` says otherwise.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /usr/local/bin/emeraldmd-server /usr/local/bin/emeraldmd-server
ENV EMERALDMD_BIND=0.0.0.0:8484
EXPOSE 8484
# The image has no shell or curl: the binary asks itself for GET /healthz on
# the configured address. Indexing large vaults can take a while at start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/emeraldmd-server", "healthcheck"]
# SIGTERM stops gracefully; SIGHUP reloads the config (`docker kill -s HUP`).
ENTRYPOINT ["/usr/local/bin/emeraldmd-server"]
CMD ["serve"]

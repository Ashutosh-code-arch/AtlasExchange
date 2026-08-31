# syntax=docker/dockerfile:1.7

FROM grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839 AS config-validation

COPY infra/observability/alloy/config.alloy /etc/alloy/config.alloy

RUN ATLAS_METRICS_TARGET=atlas-api-staging:10000 \
    METRICS_BEARER_TOKEN=validation-only-not-a-runtime-secret \
    GRAFANA_CLOUD_PROMETHEUS_URL=https://prometheus.example.invalid/api/prom/push \
    GRAFANA_CLOUD_PROMETHEUS_USERNAME=validation-only \
    GRAFANA_CLOUD_METRICS_TOKEN=validation-only-not-a-runtime-secret \
    /bin/alloy validate /etc/alloy/config.alloy

FROM config-validation AS runtime

ARG ATLAS_IMAGE_VERSION=0.2.0-local
ARG ATLAS_IMAGE_REVISION=unknown
ARG ATLAS_IMAGE_CREATED=1970-01-01T00:00:00.000Z
ARG ATLAS_IMAGE_SOURCE=https://github.com/Ashutosh-code-arch/AtlasExchange

LABEL org.opencontainers.image.title="Atlas Metrics Collector" \
      org.opencontainers.image.description="Private Atlas staging metrics collector" \
      org.opencontainers.image.source="${ATLAS_IMAGE_SOURCE}" \
      org.opencontainers.image.version="${ATLAS_IMAGE_VERSION}" \
      org.opencontainers.image.revision="${ATLAS_IMAGE_REVISION}" \
      org.opencontainers.image.created="${ATLAS_IMAGE_CREATED}"

RUN mkdir -p /var/lib/alloy/data \
    && chown -R 65532:65532 /etc/alloy /var/lib/alloy

USER 65532:65532

EXPOSE 12345

ENTRYPOINT ["/bin/alloy"]

CMD ["run", "/etc/alloy/config.alloy", "--storage.path=/var/lib/alloy/data", "--server.http.listen-addr=0.0.0.0:12345", "--server.http.enable-pprof=false", "--server.http.disable-support-bundle", "--disable-reporting"]

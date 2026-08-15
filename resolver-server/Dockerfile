# Minimal image for the extraction service.
FROM python:3.12-slim

# ffmpeg is NOT required: this service only reads metadata, it never muxes.
# Muxing happens in the user's browser via ffmpeg.wasm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Run unprivileged.
RUN useradd --create-home --shell /usr/sbin/nologin resolver
USER resolver

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]

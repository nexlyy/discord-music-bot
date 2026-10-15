FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
  && useradd -u 1000 -m app \
  && python -m venv /venv && chown -R app:app /venv
ENV PATH=/venv/bin:$PATH CACHE_DIR=/cache PYTHONUNBUFFERED=1
USER app
RUN pip install --no-cache-dir yt-dlp==2026.8.19
WORKDIR /app
COPY app.py .
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=4)"
# SoundCloud часто меняет плеер — при каждом старте пробуем обновить yt-dlp (если не вышло, работает установленный).
CMD ["sh", "-c", "timeout 90 pip install -q --no-cache-dir -U yt-dlp >/dev/null 2>&1; exec python app.py"]

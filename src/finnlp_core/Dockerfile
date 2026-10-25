FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/finnlp

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

# Pin upstream FinNLP source so builds do not silently track changes on main.
ARG FINNLP_COMMIT=be4dfd5c2526e88bbb1307d444086c46a4b47e3a
RUN git init /opt/finnlp \
    && git -C /opt/finnlp remote add origin https://github.com/AI4Finance-Foundation/FinNLP.git \
    && git -C /opt/finnlp fetch --depth=1 origin ${FINNLP_COMMIT} \
    && git -C /opt/finnlp checkout --detach FETCH_HEAD \
    && rm -rf /opt/finnlp/.git

COPY app.py ./

RUN useradd --system --uid 10001 --create-home appuser \
    && chown -R appuser:appuser /app /opt/finnlp
USER 10001:10001

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

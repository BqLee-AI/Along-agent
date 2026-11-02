# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 USE_TORCH=0 USE_TF=0 TOKENIZERS_PARALLELISM=false \
    HF_HOME=/tmp/huggingface
WORKDIR /app
# Named build context "wheels" is the external D-cache wheelhouse, never model assets.
COPY requirements.txt /app/requirements.txt
RUN --mount=type=bind,from=wheels,target=/wheels,ro \
    python -m pip install --no-cache-dir --no-index --find-links=/wheels --require-hashes -r requirements.txt
COPY manifest.py build_manifest.py licenses.py service.py serve.py test_service.py /app/
COPY third-party/ /app/third-party/
RUN python licenses.py > /app/dependency-licenses.json
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["python", "serve.py"]

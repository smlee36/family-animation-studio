# B200 (Blackwell, sm_100) video-generation image.
#
# Base is an NGC PyTorch container because it is the only distribution channel
# that reliably ships a torch built with sm_100 kernels together with a matching
# CUDA 12.8+ userspace. Do not swap this for a plain python base image and
# `pip install torch` unless you pin the cu128/cu129 wheel index.
#
# The tag below is a build argument on purpose: NGC publishes monthly and the
# right tag is "the newest one at the time you build". Check
# https://catalog.ngc.nvidia.com/orgs/nvidia/containers/pytorch/tags and pass
#   --build-arg NGC_TAG=<newer-tag>
# Whatever you choose, scripts/00_preflight.sh verifies at runtime that the
# resulting torch really has sm_100 kernels, so a wrong tag fails loudly and
# early rather than silently falling back to PTX JIT.
ARG NGC_TAG=25.08-py3
FROM nvcr.io/nvidia/pytorch:${NGC_TAG}

ARG DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_ENABLE_HXFER=1 \
    # Keep model/output state on a mounted volume, never in the image layer.
    B200_WORKDIR=/work \
    COMFY_DIR=/work/ComfyUI \
    MODELS_DIR=/work/models

RUN apt-get update && apt-get install -y --no-install-recommends \
        git git-lfs curl ca-certificates tmux ffmpeg libgl1 libglib2.0-0 \
        aria2 jq \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# hf_transfer gives a large speedup on the multi-tens-of-GB weight pulls.
RUN pip install --no-cache-dir "huggingface_hub[cli,hf_transfer]" pyyaml websocket-client requests

WORKDIR /work
COPY scripts/ /opt/b200/scripts/
COPY pipeline/ /opt/b200/pipeline/
COPY config/ /opt/b200/config/
COPY workflows/ /opt/b200/workflows/
RUN chmod +x /opt/b200/scripts/*.sh

ENV PATH="/opt/b200/scripts:${PATH}" \
    PYTHONPATH="/opt/b200:${PYTHONPATH}"

EXPOSE 8188
CMD ["/bin/bash"]

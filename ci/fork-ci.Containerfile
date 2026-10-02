FROM --platform=linux/arm64 oven/bun:1.4.2@sha256:3121e24dc54514f0e37bcc996a9e6df64519b4caff03a33bbb9993baca7c403b
RUN test "$(uname -m)" = aarch64 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates cmake curl fd-find git imagemagick jq libcairo2-dev libgif-dev libjpeg-dev libpango1.0-dev libpcre2-dev librsvg2-dev libssl-dev ninja-build pkg-config python3 ripgrep unzip zip libpipewire-0.3-dev libclang1-19 libclang-common-19-dev openssh-client rsync && ln -s /usr/bin/fdfind /usr/local/bin/fd && ln -s /usr/bin/convert /usr/local/bin/magick && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH LIBCLANG_PATH=/usr/lib/llvm-19/lib
RUN curl -fsSL https://sh.rustup.rs -o /root/rustup-init.sh && sh /root/rustup-init.sh -y --profile minimal --default-toolchain nightly-2026-08-12 --component clippy,rustfmt,rust-analyzer && rustup target add --toolchain nightly-2026-08-12 x86_64-unknown-linux-gnu x86_64-pc-windows-msvc aarch64-pc-windows-msvc && rm /root/rustup-init.sh && chmod -R a+rX /opt/rustup /opt/cargo
RUN useradd --uid 1000 --create-home builder
USER builder
WORKDIR /source

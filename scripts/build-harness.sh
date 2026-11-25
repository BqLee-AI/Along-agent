#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Fixed path matches cjpm's binary dependency manifest; no global SDK or hooks.
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
source /opt/along-toolchain/cangjie/envsetup.sh
cd "$root/apps/harness"
cjpm build --skip-script -o along-harness
install -d /out/bin /out/lib /out/notices/sdk /out/notices/stdx
install -m 755 target/release/bin/along-harness /out/bin/along-harness
sdk=/opt/along-toolchain/cangjie
stdx=/opt/along-toolchain/stdx
export LD_LIBRARY_PATH="$stdx/linux_x86_64_cjnative/dynamic/stdx:$sdk/runtime/lib/linux_x86_64_cjnative"
while read -r name arrow path rest; do
  if [[ "$arrow" == '=>' && "$path" == /opt/along-toolchain/* ]]; then
    cp -L "$path" "/out/lib/$name"
  fi
done < <(ldd /out/bin/along-harness)
# Retain official SDK/stdx licenses and their bundled third-party notices, not SDK binaries.
cp -a "$sdk/LICENSE" "$sdk/Open_Source_Software_Notice.docx" /out/notices/sdk/
find "$stdx" -maxdepth 2 -type f \( -iname '*license*' -o -iname '*notice*' \) -exec cp -a '{}' /out/notices/stdx/ \;
LD_LIBRARY_PATH=/out/lib ldd /out/bin/along-harness
cp artifacts.lock /out/artifacts.lock
find src -type f -name '*.cj' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > /out/source.sha256
sha256sum cjpm.toml cjpm.lock artifacts.lock >> /out/source.sha256
(cd /out && sha256sum bin/along-harness > binary.sha256)

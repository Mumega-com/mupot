#!/bin/sh
# Reproducible local development bundle. Does not install or launch anything.
set -eu
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
crate_dir="$(dirname "$script_dir")"
if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'The macOS bundle can only be built on macOS.' >&2
  exit 1
fi
cd "$crate_dir"
cargo build --release --locked --features gui
bundle_dir="$crate_dir/dist/Mupot Connect.app"
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
# Replace the executable by rename so an already-running preview keeps its
# existing executable inode while the next launch receives the updated build.
temporary_executable="$(mktemp "$bundle_dir/Contents/MacOS/.mumachine.XXXXXX")"
cp target/release/mumachine "$temporary_executable"
chmod 755 "$temporary_executable"
mv -f "$temporary_executable" "$bundle_dir/Contents/MacOS/mumachine"
cp assets/Info.plist "$bundle_dir/Contents/Info.plist"
iconset_dir="$crate_dir/dist/Mupot Connect.iconset"
mkdir -p "$iconset_dir"
for icon_size in 16 32 128 256 512; do
  doubled_size=$((icon_size * 2))
  sips -z "$icon_size" "$icon_size" "$crate_dir/../../src/dashboard/brand/mupot-mark-64.png" --out "$iconset_dir/icon_${icon_size}x${icon_size}.png" >/dev/null
  sips -z "$doubled_size" "$doubled_size" "$crate_dir/../../src/dashboard/brand/mupot-mark-64.png" --out "$iconset_dir/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset_dir" -o "$bundle_dir/Contents/Resources/MupotConnect.icns"
codesign --force --sign - "$bundle_dir"
codesign --verify --strict "$bundle_dir"
ditto -c -k --sequesterRsrc --keepParent "$bundle_dir" "$crate_dir/dist/Mupot Connect-macos.zip"
printf 'Local ad-hoc signed bundle: %s\n' "$bundle_dir"
printf 'Download archive: %s\n' "$crate_dir/dist/Mupot Connect-macos.zip"

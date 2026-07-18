#!/usr/bin/env bash
# Regenerate the Android launcher icons (Cortex 25c 皮层弧 C) from the committed
# source PNGs into gen/android's res tree.
#
# Why this exists: `tauri android init` regenerates gen/android from scratch and
# ships the default green Tauri placeholder icon. gen/android is gitignored, so the
# only durable way to keep the Cortex icon is to re-apply it after every init.
# android-release.sh calls this right after the init step. Pure ImageMagick — no
# network, no chrome, fully deterministic.
#
# Sources (tracked, under src-tauri/icons/):
#   icon-source.png      1024x1024 square full-bleed indigo tile + white mark (legacy)
#   icon-foreground.png  1024x1024 transparent, white mark centered in the adaptive safe zone
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI="$HERE/../src-tauri"
ICONS="$TAURI/icons"
RES="$TAURI/gen/android/app/src/main/res"
BG_COLOR="#ffffff"                     # adaptive background (white 25c variant)

SRC="$ICONS/icon-source.png"           # square white tile + colored mark
FG="$ICONS/icon-foreground.png"        # transparent colored mark (ink core + indigo arcs)
[ -f "$SRC" ] || { echo "error: missing $SRC" >&2; exit 1; }
[ -f "$FG" ]  || { echo "error: missing $FG" >&2; exit 1; }
[ -d "$RES" ] || { echo "error: $RES not found — run 'tauri android init' first" >&2; exit 1; }

# density -> legacy launcher px (48dp base) / adaptive foreground px (108dp base)
densities=(mdpi hdpi xhdpi xxhdpi xxxhdpi)
launcher_px=(48 72 96 144 192)
foreground_px=(108 162 216 324 432)

round_tile() {  # <src> <size> <out>  — rounded-square (radius 22%)
  local src="$1" sz="$2" out="$3" r
  r=$(awk "BEGIN{printf \"%d\", $sz*0.22}")
  convert -size "${sz}x${sz}" xc:black -fill white -draw "roundrectangle 0,0,$((sz-1)),$((sz-1)),$r,$r" /tmp/_mask_$$.png
  convert \( "$src" -resize "${sz}x${sz}" \) /tmp/_mask_$$.png -alpha off -compose CopyOpacity -composite "$out"
  rm -f /tmp/_mask_$$.png
}
circle_tile() { # <src> <size> <out>  — circle-masked
  local src="$1" sz="$2" out="$3" c
  c=$(( sz/2 ))
  convert -size "${sz}x${sz}" xc:black -fill white -draw "circle $c,$c $c,0" /tmp/_cmask_$$.png
  convert \( "$src" -resize "${sz}x${sz}" \) /tmp/_cmask_$$.png -alpha off -compose CopyOpacity -composite "$out"
  rm -f /tmp/_cmask_$$.png
}

for i in "${!densities[@]}"; do
  d="${densities[$i]}"; lp="${launcher_px[$i]}"; fp="${foreground_px[$i]}"
  dir="$RES/mipmap-$d"; mkdir -p "$dir"
  round_tile  "$SRC" "$lp" "$dir/ic_launcher.png"
  circle_tile "$SRC" "$lp" "$dir/ic_launcher_round.png"
  convert "$FG" -resize "${fp}x${fp}" "$dir/ic_launcher_foreground.png"
done

# Solid indigo adaptive background (replaces the green grid placeholder).
cat > "$RES/drawable/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="$BG_COLOR" android:pathData="M0,0h108v108h-108z" />
</vector>
XML

# Bind foreground + background as an adaptive icon (API 26+); legacy raster is the fallback.
mkdir -p "$RES/mipmap-anydpi-v26"
for name in ic_launcher ic_launcher_round; do
  cat > "$RES/mipmap-anydpi-v26/$name.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML
done

echo "Applied Cortex 25c launcher icons to $RES"

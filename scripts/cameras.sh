#!/usr/bin/env bash
# Local live-HLS "cameras".
#
# Why generate our own instead of pointing at a public test stream: the public
# ones are VOD. hls.js buffers a VOD asset end-to-end, so you cannot starve it,
# and none of the live-edge behaviour this project is about actually occurs.
# These are genuine live streams — sliding-window playlist, 1s segments, no
# EXT-X-ENDLIST — with a wall-clock timecode burned into the picture so a stale
# tile is visible to the eye, not just to the instrumentation.
#
#   ./scripts/cameras.sh start [N]   default 4
#   ./scripts/cameras.sh freeze 2    SIGSTOP the encoder — the camera stops
#                                    sending. Player starves at the live edge.
#   ./scripts/cameras.sh thaw 2      SIGCONT
#   ./scripts/cameras.sh status
#   ./scripts/cameras.sh stop
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="$ROOT/public/live"
PIDS="$LIVE/.pids"

need_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found — brew install ffmpeg" >&2; exit 1; }
}

start_one() {
  local n="$1"
  local dir="$LIVE/cam$n"
  mkdir -p "$dir"
  rm -f "$dir"/*.ts "$dir"/*.m3u8 2>/dev/null || true
  # -re paces output at realtime, which is what makes this a live source rather
  # than a file written as fast as the CPU allows.
  ffmpeg -hide_banner -loglevel error -re \
    -f lavfi -i "testsrc2=size=640x360:rate=25" \
    -vf "drawtext=text='CAM $n  %{localtime\:%H\\\\\:%M\\\\\:%S}':fontsize=26:fontcolor=white:x=18:y=18:box=1:boxcolor=black@0.55" \
    -c:v libx264 -preset veryfast -tune zerolatency -g 25 -sc_threshold 0 -pix_fmt yuv420p \
    -f hls -hls_time 1 -hls_list_size 4 \
    -hls_flags delete_segments+omit_endlist+independent_segments \
    "$dir/index.m3u8" > "$dir/ffmpeg.log" 2>&1 &
  echo "$n $!" >> "$PIDS"
  echo "cam$n → public/live/cam$n/index.m3u8 (pid $!)"
}

pid_of() { [ -f "$PIDS" ] && awk -v n="$1" '$1==n {print $2}' "$PIDS" | tail -1; }

case "${1:-}" in
  start)
    need_ffmpeg
    "$0" stop >/dev/null 2>&1 || true
    mkdir -p "$LIVE"; : > "$PIDS"
    for i in $(seq 1 "${2:-4}"); do start_one "$i"; done
    echo "waiting for first segments…"; sleep 6
    "$0" status
    ;;
  stop)
    if [ -f "$PIDS" ]; then
      while read -r _ pid; do [ -n "${pid:-}" ] && kill -CONT "$pid" 2>/dev/null || true
                               [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done < "$PIDS"
      rm -f "$PIDS"
    fi
    pkill -f "testsrc2=size=640x360" 2>/dev/null || true
    echo "cameras stopped"
    ;;
  freeze)
    pid="$(pid_of "${2:?usage: cameras.sh freeze <n>}")"
    [ -n "$pid" ] || { echo "no such camera" >&2; exit 1; }
    kill -STOP "$pid"; echo "cam$2 frozen (encoder SIGSTOPped — segments stop being produced)"
    ;;
  thaw)
    pid="$(pid_of "${2:?usage: cameras.sh thaw <n>}")"
    [ -n "$pid" ] || { echo "no such camera" >&2; exit 1; }
    kill -CONT "$pid"; echo "cam$2 resumed"
    ;;
  status)
    [ -f "$PIDS" ] || { echo "no cameras running"; exit 0; }
    while read -r n pid; do
      state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      segs="$(ls -1 "$LIVE/cam$n"/*.ts 2>/dev/null | wc -l | tr -d ' ')"
      printf 'cam%s  pid=%-7s state=%-4s segments=%s\n' "$n" "$pid" "${state:-gone}" "$segs"
    done < "$PIDS"
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac

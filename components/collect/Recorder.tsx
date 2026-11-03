"use client";

import { useEffect, useRef, useState } from "react";

const MAX_SECONDS = 60;
const HOLD_MS = 500; // pressed longer than this: release stops (hold to record); shorter: tap to start, tap to stop
// What MediaRecorder can make: Chrome and Android give webm/opus, iOS Safari mp4/aac. Scribe takes both.
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/aac", "audio/ogg;codecs=opus"];

export interface VoiceNote {
  blob: Blob;
  type: string;
  seconds: number;
}

function pickType(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function Recorder({ note, onChange }: { note: VoiceNote | null; onChange: (note: VoiceNote | null) => void }) {
  const [state, setState] = useState<"idle" | "starting" | "recording">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const pressedAt = useRef(0);
  const started = useRef(0);
  const timer = useRef<number | null>(null);
  const url = useRef<string | null>(null);
  const [playback, setPlayback] = useState<string | null>(null);

  useEffect(() => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = note ? URL.createObjectURL(note.blob) : null;
    queueMicrotask(() => setPlayback(url.current));
  }, [note]);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  async function start() {
    setError(null);
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = pickType();
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const kind = rec.mimeType || type || "audio/webm";
        const length = Math.min(MAX_SECONDS, Math.round((performance.now() - started.current) / 100) / 10);
        onChange(chunks.length ? { blob: new Blob(chunks, { type: kind }), type: kind, seconds: length } : null);
        setState("idle");
      };
      recorder.current = rec;
      started.current = performance.now();
      rec.start(250);
      setSeconds(0);
      setState("recording");
      timer.current = window.setInterval(() => {
        const elapsed = (performance.now() - started.current) / 1000;
        setSeconds(Math.floor(elapsed));
        if (elapsed >= MAX_SECONDS) stop();
      }, 200);
    } catch (e) {
      setState("idle");
      setError(e instanceof Error && e.name === "NotAllowedError" ? "Microphone permission was denied." : "This browser cannot record audio.");
    }
  }

  function stop() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function down() {
    pressedAt.current = performance.now();
    if (state === "idle") void start();
  }

  function up() {
    const held = performance.now() - pressedAt.current;
    // Released after a hold: stop. A quick tap that started recording keeps going until the next tap.
    if (state === "recording" && (held >= HOLD_MS || performance.now() - started.current > HOLD_MS)) stop();
  }

  const recording = state === "recording";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onPointerDown={down}
          onPointerUp={up}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), recording ? stop() : void start())}
          aria-pressed={recording}
          aria-label={recording ? "Stop recording" : note ? "Record again" : "Record a voice note"}
          data-testid="record"
          className={`flex h-14 w-14 flex-none touch-none items-center justify-center rounded-full border ${
            recording ? "rec-live border-crit bg-crit/20" : "border-line-strong bg-raised"
          }`}
        >
          <span className={`block ${recording ? "h-4 w-4 rounded-[3px] bg-crit" : "h-5 w-5 rounded-full bg-crit"}`} />
        </button>
        <div className="min-w-0 text-[13px]">
          {recording ? (
            <p data-testid="recording">
              <span className="font-mono text-crit">● {String(seconds).padStart(2, "0")}s</span>
              <span className="text-muted"> / {MAX_SECONDS}s · release, or tap again, to stop</span>
            </p>
          ) : state === "starting" ? (
            <p className="text-muted">Asking for the microphone…</p>
          ) : note ? (
            <p>
              Voice note · <span className="font-mono">{note.seconds.toFixed(1)}s</span>{" "}
              <span className="text-faint">{note.type.split(";")[0]}</span>
            </p>
          ) : (
            <p className="text-muted">Hold to record, or tap to start and tap to stop. Up to a minute.</p>
          )}
          {error && <p className="text-crit" role="alert">{error}</p>}
        </div>
      </div>
      {note && playback && !recording && (
        <div className="flex items-center gap-2">
          <audio controls src={playback} className="h-9 w-full min-w-0" data-testid="playback" />
          <button type="button" onClick={() => onChange(null)} className="btn btn-sm btn-ghost flex-none">
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

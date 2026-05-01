/**
 * VoiceChat.tsx — Real-time voice chat using OpenAI Realtime API via WebRTC
 *
 * Flow (unified interface):
 * 1. Create RTCPeerConnection
 * 2. Get microphone audio track
 * 3. Create SDP offer
 * 4. POST SDP to /api/voice/session (our backend relays to OpenAI)
 * 5. Set SDP answer → WebRTC connection established
 * 6. Audio streams bidirectionally via WebRTC
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { logger } from "../../lib/logger";
import { PhoneOff, Mic, MicOff, Volume2 } from "lucide-react";

interface VoiceChatProps {
  open: boolean;
  onClose: () => void;
}

type ConnectionState = "idle" | "connecting" | "connected" | "error";

export default function VoiceChat({ open, onClose }: VoiceChatProps) {
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string>("");
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [aiText, setAiText] = useState<string>("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Format duration as mm:ss
  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  // Cleanup all resources
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (dcRef.current) {
      try { dcRef.current.close(); } catch {}
      dcRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
  }, []);

  // Start the voice session
  const startSession = useCallback(async () => {
    setState("connecting");
    setError("");
    setTranscript("");
    setAiText("");
    setDuration(0);

    try {
      // P6 FIX: Check microphone availability before attempting connection
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持语音功能');
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasAudioInput = devices.some(d => d.kind === 'audioinput');
        if (hasAudioInput === false) {
          throw new Error('未检测到麦克风设备，请连接麦克风后重试');
        }
      } catch (enumErr: any) {
        if (enumErr.message && enumErr.message.includes('未检测到')) throw enumErr;
        // enumerateDevices may fail in some browsers, continue anyway
      }

      // 1. Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // 2. Set up remote audio playback
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      // 3. Get microphone and add track
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = ms;
      pc.addTrack(ms.getTracks()[0]);

      // 4. Create data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        logger.debug("[VoiceChat] Data channel open");
      };

      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          // Handle transcription of user's speech
          if (event.type === "conversation.item.input_audio_transcription.completed") {
            setTranscript(event.transcript || "");
          }
          // Handle AI response text (streaming)
          if (event.type === "response.audio_transcript.delta") {
            setAiText((prev) => prev + (event.delta || ""));
          }
          // When response is done, clear AI text after delay for next turn
          if (event.type === "response.done") {
            setTimeout(() => {
              setAiText("");
              setTranscript("");
            }, 3000);
          }
        } catch {
          // Non-JSON message, ignore
        }
      };

      // 5. Create and set local SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 6. Send SDP to our backend (which relays to OpenAI with RangerAI config)
      const response = await fetch("/api/voice/session", {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Content-Type": "application/sdp",
        },
      });

      if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData.detail || errData.error || errorMsg;
        } catch {
          errorMsg = await response.text();
        }
        throw new Error(errorMsg);
      }

      // 7. Set remote SDP answer
      const sdpAnswer = await response.text();
      await pc.setRemoteDescription({
        type: "answer",
        sdp: sdpAnswer,
      });

      // Connected!
      setState("connected");

      // Start duration timer
      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          cleanup();
          setState("idle");
          onClose();
        }
      };

    } catch (e: any) {
      logger.error("[VoiceChat] Error:", e);
      setState("error");
      setError(e.message || "连接失败");
      cleanup();
    }
  }, [cleanup, onClose]);

  // Stop the voice session
  const stopSession = useCallback(() => {
    cleanup();
    setState("idle");
  }, [cleanup]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (streamRef.current) {
      const track = streamRef.current.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsMuted(!track.enabled);
      }
    }
  }, []);

  // Handle close
  const handleClose = useCallback(() => {
    stopSession();
    onClose();
  }, [stopSession, onClose]);

  // Auto-start when opened
  useEffect(() => {
    if (open && state === "idle") {
      startSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-sm">
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
      >
        <PhoneOff className="w-6 h-6 text-white" />
      </button>

      {/* Main content */}
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-6">
        {/* Voice animation / status icon */}
        <div className={`w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300 ${
          state === "connected"
            ? "bg-emerald-500/20 ring-4 ring-emerald-500/40 animate-pulse"
            : state === "connecting"
            ? "bg-blue-500/20 ring-4 ring-blue-500/40"
            : state === "error"
            ? "bg-red-500/20 ring-4 ring-red-500/40"
            : "bg-gray-500/20 ring-4 ring-gray-500/40"
        }`}>
          <Volume2 className={`w-16 h-16 ${
            state === "connected" ? "text-emerald-400" :
            state === "connecting" ? "text-blue-400" :
            state === "error" ? "text-red-400" :
            "text-gray-400"
          }`} />
        </div>

        {/* Title */}
        <h2 className="text-2xl font-bold text-white">Ranger Voice</h2>

        {/* Status */}
        <div className="text-center">
          {state === "connecting" && (
            <p className="text-blue-400 text-lg animate-pulse">正在连接...</p>
          )}
          {state === "connected" && (
            <p className="text-emerald-400 text-lg font-mono">{formatDuration(duration)}</p>
          )}
          {state === "error" && (
            <div className="space-y-2">
              <p className="text-red-400 text-lg">连接失败</p>
              <p className="text-red-300/70 text-sm max-w-xs break-words">{error}</p>
            </div>
          )}
        </div>

        {/* Transcript display */}
        {state === "connected" && (transcript || aiText) && (
          <div className="w-full space-y-2 max-h-40 overflow-y-auto">
            {transcript && (
              <div className="bg-white/5 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1">你说：</p>
                <p className="text-white text-sm">{transcript}</p>
              </div>
            )}
            {aiText && (
              <div className="bg-emerald-500/10 rounded-lg p-3">
                <p className="text-xs text-emerald-400 mb-1">AI：</p>
                <p className="text-white text-sm">{aiText}</p>
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-6 mt-4">
          {state === "connected" && (
            <>
              {/* Mute button */}
              <button
                onClick={toggleMute}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
                  isMuted
                    ? "bg-red-500/20 hover:bg-red-500/30"
                    : "bg-white/10 hover:bg-white/20"
                }`}
              >
                {isMuted ? (
                  <MicOff className="w-6 h-6 text-red-400" />
                ) : (
                  <Mic className="w-6 h-6 text-white" />
                )}
              </button>

              {/* Hang up button */}
              <button
                onClick={handleClose}
                className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center transition-all shadow-lg shadow-red-600/30"
              >
                <PhoneOff className="w-7 h-7 text-white" />
              </button>
            </>
          )}

          {state === "error" && (
            <div className="flex gap-4">
              <button
                onClick={startSession}
                className="px-6 py-3 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-all"
              >
                重试
              </button>
              <button
                onClick={handleClose}
                className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white font-medium transition-all"
              >
                关闭
              </button>
            </div>
          )}

          {state === "connecting" && (
            <button
              onClick={handleClose}
              className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white font-medium transition-all"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

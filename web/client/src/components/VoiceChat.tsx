/**
 * VoiceChat.tsx — Real-time voice chat component using OpenAI Realtime API + WebRTC
 *
 * Provides a full-duplex voice conversation interface with:
 * - WebRTC audio streaming to OpenAI Realtime API
 * - Real-time audio visualization (waveform)
 * - Live transcription display
 * - Call controls (mute, end call)
 * - Connection state management
 * - Web search function calling support (with transition speech)
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { logger } from "../lib/logger";
import { Mic, MicOff, Phone, PhoneOff, Volume2, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

// --- Types ---
type CallState = "idle" | "connecting" | "connected" | "error";

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
  id: string;
  final: boolean;
}

interface VoiceChatProps {
  open: boolean;
  onClose: () => void;
}

// --- Audio Visualizer ---
function AudioVisualizer({ analyser, isActive, color = "#22c55e" }: {
  analyser: AnalyserNode | null;
  isActive: boolean;
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    if (!analyser || !canvasRef.current || !isActive) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.beginPath();
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [analyser, isActive, color]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={60}
      className="rounded-lg"
      style={{ opacity: isActive ? 1 : 0.3 }}
    />
  );
}

// --- Main Component ---
export default function VoiceChat({ open, onClose }: VoiceChatProps) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [callDuration, setCallDuration] = useState(0);
  const [isSearching, setIsSearching] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Track which call_ids we've already handled to prevent duplicates
  const handledCallIds = useRef<Set<string>>(new Set());

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  // Call duration timer
  useEffect(() => {
    if (callState === "connected") {
      setCallDuration(0);
      timerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [callState]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  // --- Execute web search and return result to the model ---
  const executeWebSearch = useCallback(async (query: string, callId: string) => {
    // Prevent duplicate calls for the same call_id
    if (handledCallIds.current.has(callId)) {
      logger.debug("[VoiceChat] Skipping duplicate function call:", callId);
      return;
    }
    handledCallIds.current.add(callId);

    setIsSearching(true);
    setTranscript((prev) => [
      ...prev,
      { role: "system", text: `正在搜索: ${query}`, id: `search-${callId}`, final: true },
    ]);

    try {
      const response = await fetch("/api/voice/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("auth_token") || ""}`,
        },
        body: JSON.stringify({ query }),
      });

      let resultText: string;
      if (!response.ok) {
        resultText = "搜索请求失败，请稍后再试。";
      } else {
        const data = await response.json();
        resultText = data.result || "未找到相关搜索结果。";
      }

      // Send function call output back to the model via data channel
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: resultText,
          },
        }));

        dc.send(JSON.stringify({
          type: "response.create",
        }));

        setTranscript((prev) =>
          prev.map((entry) =>
            entry.id === `search-${callId}`
              ? { ...entry, text: `搜索完成: ${query}` }
              : entry
          )
        );
      }
    } catch (e: any) {
      logger.error("[VoiceChat] Web search failed:", e);
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: "搜索失败，无法获取实时信息。请根据已知信息回答。",
          },
        }));
        dc.send(JSON.stringify({
          type: "response.create",
        }));
      }
    } finally {
      setIsSearching(false);
    }
  }, []);

  // --- Start Call ---
  const startCall = useCallback(async () => {
    setCallState("connecting");
    setError(null);
    setTranscript([]);
    handledCallIds.current.clear();

    try {
      // P6 FIX: Check microphone availability before attempting connection
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持语音功能');
      }
      try {
        const devList = await navigator.mediaDevices.enumerateDevices();
        const hasMic = devList.some(d => d.kind === 'audioinput');
        if (hasMic === false) {
          throw new Error('未检测到麦克风设备，请连接麦克风后重试');
        }
      } catch (enumErr: any) {
        if (enumErr.message && enumErr.message.includes('未检测到')) throw enumErr;
      }

      // P6 FIX: Check microphone availability before attempting connection
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持语音功能');
      }
      try {
        const devList = await navigator.mediaDevices.enumerateDevices();
        const hasMic = devList.some(d => d.kind === 'audioinput');
        if (hasMic === false) {
          throw new Error('未检测到麦克风设备，请连接麦克风后重试');
        }
      } catch (enumErr: any) {
        if (enumErr.message && enumErr.message.includes('未检测到')) throw enumErr;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 24000,
        },
      });
      localStreamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;
      const localSource = audioCtx.createMediaStreamSource(stream);
      const localAnalyser = audioCtx.createAnalyser();
      localAnalyser.fftSize = 256;
      localSource.connect(localAnalyser);
      localAnalyserRef.current = localAnalyser;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      remoteAudioRef.current = remoteAudio;
      pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        remoteAudio.srcObject = remoteStream;
        const remoteSource = audioCtx.createMediaStreamSource(remoteStream);
        const remoteAnalyser = audioCtx.createAnalyser();
        remoteAnalyser.fftSize = 256;
        remoteSource.connect(remoteAnalyser);
        remoteAnalyserRef.current = remoteAnalyser;
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        dc.send(JSON.stringify({
          type: "session.update",
          session: {
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe",
            },
          },
        }));
      };

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleRealtimeEvent(msg);
        } catch {
          // ignore non-JSON messages
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch("/api/voice/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("auth_token") || ""}`,
        },
        body: JSON.stringify({ sdp: offer.sdp }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || err.detail || `HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      let answerSdp: string;
      if (contentType.includes("application/sdp")) {
        answerSdp = await response.text();
      } else {
        const data = await response.json();
        answerSdp = data.sdp || data;
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setCallState("connected");
    } catch (e: any) {
      logger.error("[VoiceChat] Failed to start call:", e);
      setError(e.message || "Failed to start voice call");
      setCallState("error");
      cleanup();
    }
  }, []);

  // --- Handle Realtime Events ---
  const handleRealtimeEvent = useCallback((msg: any) => {
    switch (msg.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) {
          setTranscript((prev) => [
            ...prev,
            { role: "user", text: msg.transcript.trim(), id: msg.item_id || crypto.randomUUID(), final: true },
          ]);
        }
        break;

      case "response.audio_transcript.delta":
        setTranscript((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !last.final && last.id === msg.response_id) {
            return [...prev.slice(0, -1), { ...last, text: last.text + (msg.delta || "") }];
          }
          return [...prev, { role: "assistant", text: msg.delta || "", id: msg.response_id || crypto.randomUUID(), final: false }];
        });
        break;

      case "response.audio_transcript.done":
        setTranscript((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !last.final) {
            return [...prev.slice(0, -1), { ...last, text: msg.transcript || last.text, final: true }];
          }
          return prev;
        });
        break;

      case "response.function_call_arguments.done":
        // Model wants to call a function
        logger.debug("[VoiceChat] Function call:", msg.name, msg.arguments, "call_id:", msg.call_id);
        if (msg.name === "web_search" && msg.call_id) {
          try {
            const args = JSON.parse(msg.arguments);
            if (args.query) {
              executeWebSearch(args.query, msg.call_id);
            }
          } catch (e) {
            logger.error("[VoiceChat] Failed to parse function call args:", e);
          }
        }
        break;

      case "error":
        logger.error("[VoiceChat] Realtime error:", msg.error);
        setError(msg.error?.message || "Realtime API error");
        break;

      default:
        break;
    }
  }, [executeWebSearch]);

  const endCall = useCallback(() => {
    cleanup();
    setCallState("idle");
  }, []);

  const cleanup = useCallback(() => {
    if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach((t) => t.stop()); localStreamRef.current = null; }
    if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = null; remoteAudioRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    handledCallIds.current.clear();
  }, []);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (open && callState === "idle") {
      startCall();
    }
    if (!open && callState !== "idle") {
      endCall();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-[360px] bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center">
          <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Volume2 className="w-8 h-8 text-white" />
          </div>
          <h3 className="text-lg font-semibold text-white">Ranger Voice</h3>
          <p className="text-sm text-zinc-400 mt-1">
            {callState === "connecting" && "正在连接..."}
            {callState === "connected" && (
              <>
                {formatDuration(callDuration)}
                {isSearching && (
                  <span className="ml-2 inline-flex items-center gap-1 text-amber-400">
                    <Search className="w-3 h-3 animate-pulse" />
                    搜索中
                  </span>
                )}
              </>
            )}
            {callState === "error" && "连接失败"}
            {callState === "idle" && "准备就绪"}
          </p>
        </div>

        {/* Visualizers */}
        {callState === "connected" && (
          <div className="px-6 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 w-8">你</span>
              <AudioVisualizer analyser={localAnalyserRef.current} isActive={!isMuted} color="#22c55e" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 w-8">AI</span>
              <AudioVisualizer analyser={remoteAnalyserRef.current} isActive={true} color="#3b82f6" />
            </div>
          </div>
        )}

        {/* Connecting spinner */}
        {callState === "connecting" && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <div
            ref={transcriptRef}
            className="mx-6 mt-4 max-h-40 overflow-y-auto space-y-2 scrollbar-thin scrollbar-thumb-zinc-700"
          >
            {transcript.map((entry) => (
              <div
                key={entry.id}
                className={`text-sm px-3 py-1.5 rounded-lg ${
                  entry.role === "user"
                    ? "bg-emerald-500/10 text-emerald-300 ml-8"
                    : entry.role === "system"
                    ? "bg-amber-500/10 text-amber-300 mx-4 text-center text-xs"
                    : "bg-blue-500/10 text-blue-300 mr-8"
                }`}
              >
                {entry.text}
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center justify-center gap-6 px-6 py-6 mt-4">
          {callState === "connected" && (
            <Button
              variant="outline"
              size="icon"
              className={`w-14 h-14 rounded-full border-2 transition-all ${
                isMuted
                  ? "border-red-500 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                  : "border-zinc-600 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
              onClick={toggleMute}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </Button>
          )}

          {callState === "connected" || callState === "connecting" ? (
            <Button
              variant="destructive"
              size="icon"
              className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 shadow-lg shadow-red-600/30"
              onClick={endCall}
            >
              <PhoneOff className="w-7 h-7" />
            </Button>
          ) : callState === "error" ? (
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="rounded-full border-zinc-600 text-zinc-300"
                onClick={onClose}
              >
                关闭
              </Button>
              <Button
                className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={startCall}
              >
                重试
              </Button>
            </div>
          ) : (
            <Button
              size="icon"
              className="w-16 h-16 rounded-full bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-600/30"
              onClick={startCall}
            >
              <Phone className="w-7 h-7 text-white" />
            </Button>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={() => { endCall(); onClose(); }}
          className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

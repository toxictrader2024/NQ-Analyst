/**
 * useTTS — OpenAI TTS (server-side) with browser Web Speech API fallback
 * Persists mute state in localStorage so it survives page reloads.
 *
 * OpenAI voices per personality:
 *   shark  → onyx  (deep, authoritative, cocky)
 *   oracle → nova  (sharp, confident female)
 *   suit   → echo  (calm, professional male)
 */
import { useState, useCallback, useRef } from "react";

const STORAGE_KEY = "nq_tts_muted";

// OpenAI voice mapping
const OPENAI_VOICES: Record<string, string> = {
  shark:  "onyx",
  suit:   "echo",
  oracle: "nova",
};

function cleanText(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[-•*]\s/g, "")
    .replace(/_{1,2}(.*?)_{1,2}/g, "$1")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

export function useTTS() {
  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      if (next) {
        // Stop any playing audio
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        window.speechSynthesis?.cancel();
      }
      return next;
    });
  }, []);

  const speak = useCallback(async (text: string, personality = "shark") => {
    if (muted) return;
    const cleaned = cleanText(text);
    if (!cleaned) return;

    // Stop any currently playing audio
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    window.speechSynthesis?.cancel();

    const voice = OPENAI_VOICES[personality] || "onyx";

    try {
      // Call our server proxy endpoint (avoids exposing API key in client)
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleaned, voice }),
      });

      if (!res.ok) throw new Error("TTS API failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      // Catch browser autoplay block — requires prior user interaction
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.warn("[TTS] Autoplay blocked by browser — user must interact with page first:", err);
          // Queue for next user click
          const unlock = () => { audio.play().catch(() => {}); document.removeEventListener("click", unlock); };
          document.addEventListener("click", unlock, { once: true });
        });
      }
    } catch (err) {
      // Fallback to browser TTS
      console.warn("OpenAI TTS failed, falling back to browser:", err);
      if (window.speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(cleaned);
        utterance.rate = personality === "shark" ? 1.05 : 0.95;
        utterance.pitch = personality === "oracle" ? 1.2 : 0.9;
        window.speechSynthesis.speak(utterance);
      }
    }
  }, [muted]);

  return { muted, toggleMute, speak };
}

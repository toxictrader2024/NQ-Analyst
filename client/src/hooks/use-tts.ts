/**
 * useTTS — browser Web Speech API text-to-speech hook
 * Persists mute state in localStorage so it survives page reloads.
 */
import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "nq_tts_muted";

// Pick a voice that sounds good per personality
const VOICE_HINTS: Record<string, { lang: string; gender: "male" | "female"; rate: number; pitch: number }> = {
  shark:  { lang: "en-US", gender: "male",   rate: 1.05, pitch: 0.85 }, // deep, fast
  suit:   { lang: "en-US", gender: "male",   rate: 0.95, pitch: 1.0  }, // calm, measured
  oracle: { lang: "en-US", gender: "female", rate: 1.0,  pitch: 1.1  }, // sharp female
};

function pickVoice(personality: string): SpeechSynthesisVoice | null {
  const hint = VOICE_HINTS[personality] || VOICE_HINTS.shark;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // Try to match lang + gender keyword in name
  const genderKeywords = hint.gender === "female"
    ? ["female", "woman", "zira", "samantha", "karen", "victoria", "moira", "tessa", "fiona"]
    : ["male", "man", "david", "mark", "daniel", "alex", "fred", "lee", "james"];

  // First pass: lang match + gender hint
  let match = voices.find(v =>
    v.lang.startsWith(hint.lang.split("-")[0]) &&
    genderKeywords.some(k => v.name.toLowerCase().includes(k))
  );

  // Second pass: just lang match
  if (!match) match = voices.find(v => v.lang.startsWith(hint.lang.split("-")[0]));

  // Fallback: first voice
  return match || voices[0];
}

export function useTTS() {
  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
  });

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      if (next) window.speechSynthesis?.cancel(); // stop any current speech
      return next;
    });
  }, []);

  const speak = useCallback((text: string, personality = "shark") => {
    if (muted) return;
    if (!window.speechSynthesis) return;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const hint = VOICE_HINTS[personality] || VOICE_HINTS.shark;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate  = hint.rate;
    utterance.pitch = hint.pitch;
    utterance.volume = 1;

    const doSpeak = () => {
      const voice = pickVoice(personality);
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    };

    // Voices may not be loaded yet
    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = () => { doSpeak(); };
    } else {
      doSpeak();
    }
  }, [muted]);

  return { muted, toggleMute, speak };
}

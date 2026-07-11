import { Injectable, signal } from '@angular/core';

// The SpeechRecognition / SpeechSynthesis APIs are not consistently present in
// TypeScript's DOM lib across configurations (and are still vendor-prefixed in
// some browsers), so we declare a minimal shape of what we actually use here
// rather than relying on lib.dom.d.ts.
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

const TTS_STORAGE_KEY = 'engine-tts-enabled';

/**
 * Thin wrapper around the browser's Web Speech API (speech-to-text via
 * SpeechRecognition, text-to-speech via speechSynthesis). Everything here is
 * feature-detected — call isSupported() / isSpeechSynthesisSupported() before
 * relying on the corresponding behavior.
 */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  /** True while speech recognition is actively listening. */
  readonly listening = signal(false);
  /** Whether spoken replies (TTS) are enabled. Persisted in localStorage. */
  readonly ttsEnabled = signal<boolean>(this.readTtsPreference());

  private recognition: SpeechRecognitionLike | null = null;

  private get recognitionCtor(): SpeechRecognitionConstructor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as SpeechWindow;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  /** Feature-detect speech-to-text (microphone) support. */
  isSupported(): boolean {
    return !!this.recognitionCtor;
  }

  /** Feature-detect speech synthesis (spoken replies) support. */
  isSpeechSynthesisSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /**
   * Begin listening for speech. Interim (in-progress) transcripts are
   * reported via onInterim on every recognizer update; finalized phrases are
   * reported once via onFinal. onEnd fires whenever recognition stops, for
   * any reason (manual stop, silence timeout, or error).
   */
  startListening(onInterim: (text: string) => void, onFinal: (text: string) => void, onEnd: () => void): void {
    const Ctor = this.recognitionCtor;
    if (!Ctor) return;

    this.stopListening();

    const recognition = new Ctor();
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          onFinal(transcript);
        } else {
          interim += transcript;
        }
      }
      if (interim) onInterim(interim);
    };

    recognition.onerror = () => {
      this.listening.set(false);
    };

    recognition.onend = () => {
      this.listening.set(false);
      this.recognition = null;
      onEnd();
    };

    this.recognition = recognition;
    this.listening.set(true);
    recognition.start();
  }

  /** Stop listening, if currently active. Safe to call unconditionally. */
  stopListening(): void {
    const recognition = this.recognition;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Some browsers throw if stop() is called on an already-stopped recognizer.
      }
    }
    this.listening.set(false);
  }

  /** Speak the given text aloud, stripping markdown formatting first. */
  speak(text: string): void {
    if (!this.isSpeechSynthesisSupported()) return;
    const clean = this.stripMarkdown(text).trim();
    if (!clean) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    window.speechSynthesis.speak(utterance);
  }

  /** Immediately stop any in-progress or queued speech. */
  cancelSpeech(): void {
    if (this.isSpeechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
  }

  toggleTts(): void {
    this.setTtsEnabled(!this.ttsEnabled());
  }

  setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled.set(enabled);
    try {
      localStorage.setItem(TTS_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // localStorage may be unavailable (private browsing, etc.) — non-fatal.
    }
    if (!enabled) this.cancelSpeech();
  }

  private readTtsPreference(): boolean {
    try {
      return localStorage.getItem(TTS_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Strip common markdown syntax so TTS doesn't read out symbols/punctuation noise. */
  private stripMarkdown(input: string): string {
    return input
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/^>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/[-*_]{3,}/g, ' ')
      .replace(/\|/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}

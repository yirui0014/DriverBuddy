// ============================================================================
// File: VoiceChat.jsx
// Purpose: Provides the voice-based conversational interface for DriveBuddy.
// Enables drivers to interact with the AI co-pilot via speech input
// and audio output. Handles audio recording, speech-to-text, sending
// queries to the backend agent, and text-to-speech response playback.
// Dependencies: React Hooks, Web Speech API, DriveBuddy backend API (LangChain)
// ============================================================================
import React, { useState, useRef, useEffect, useMemo } from "react";
import "./VoiceChat.css";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const SYSTEM_INSTRUCTION = `
You are DriveBuddy, a friendly co-pilot for drivers.
Keep replies conversational, supportive, and VERY short (<=2 sentences).
Avoid distracting tasks. Encourage and energize gently.
Do not use the words "sleep" or "pull over". If suggesting a break, prefer "rest" and "nearby rest stop".
`;

/* ---------- Shared Audio Manager (used by both VoiceChat and GPS) ---------- */
function createAudioManager() {
  const mgr = {
    voice: null,
    lang: "en-US",
    speaking: false,
    channel: null, // "nav" | "chat"
    queue: [],
    _synth() { return window.speechSynthesis; },
    setVoice(v) { this.voice = v || null; this.lang = v?.lang || "en-US"; },
    async speak(text, channel = "chat") {
      return new Promise((resolve) => {
        if (!text) return resolve();
        if (this.speaking) {
          if (channel === "nav" && this.channel === "chat") {
            try { this._synth().cancel(); } catch {}
            this.speaking = false;
            this.channel = null;
          } else {
            this.queue.push({ text, channel, resolve });
            this._drain();
            return;
          }
        }
        this._actuallySpeak(text, channel, resolve);
      });
    },
    _actuallySpeak(text, channel, resolve) {
      try {
        window.__drivebuddyAbortSTT?.(); // don’t capture our own TTS
        if (this._synth().speaking) this._synth().cancel();
        if (this._synth().paused) this._synth().resume();

        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) u.voice = this.voice;
        u.lang = this.lang || "en-US";
        this.speaking = true;
        this.channel = channel;

        u.onend = u.onerror = () => {
          this.speaking = false;
          this.channel = null;
          resolve();
          this._drain();
        };
        this._synth().speak(u);
      } catch {
        this.speaking = false;
        this.channel = null;
        resolve();
        this._drain();
      }
    },
    _drain() {
      if (this.speaking) return;
      const next = this.queue.shift();
      if (!next) return;
      this._actuallySpeak(next.text, next.channel, next.resolve);
    }
  };
  return mgr;
}
window.DriveBuddyAudio = window.DriveBuddyAudio || createAudioManager();
/* ------------------------------------------------------------------------ */

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "db-" + Math.random().toString(36).slice(2);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => {
  if (ms == null) return "--:--";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};

function useCountdown(ms, running = true) {
  const [left, setLeft] = useState(ms ?? null);
  const targetRef = useRef(null);
  useEffect(() => {
    if (ms == null || !running) {
      setLeft(null);
      targetRef.current = null;
      return;
    }
    targetRef.current = Date.now() + ms;
    setLeft(ms);
    const id = setInterval(() => setLeft(Math.max(0, (targetRef.current ?? 0) - Date.now())), 1000);
    return () => clearInterval(id);
  }, [ms, running]);
  return left;
}

async function getGeoOnce() {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    navigator.geolocation.getCurrentPosition(
      (pos) => done({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: true, timeout: 3000, maximumAge: 60000 }
    );
  });
}

/** ---------------- Core VoiceChat logic ----------------
 * uiMode: "full" (default) shows controls + conversation;
 *         "mic"  shows only the mic button (all logic still active).
 */
function VoiceCore({ onState, uiMode = "full" }) {
  const [listening, setListening] = useState(false);
  const [lastUserMsg, setLastUserMsg] = useState("");
  const [lastBotMsg, setLastBotMsg] = useState("");

  const [voices, setVoices] = useState([]);
  const [gender, setGender] = useState("female");
  const [selectedVoice, setSelectedVoice] = useState("");
  const [testText, setTestText] = useState("Test voice. Drive safe.");

  const recognitionRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const threadIdRef = useRef(uuid());

  const inEngagementRef = useRef(false);
  const drowsyModeRef = useRef(false);
  const convoTimeoutRef = useRef(null);

  const scheduleActiveRef = useRef(false);
  const nextTimerRef = useRef(null);

  const isStartingRef = useRef(false);
  const cooldownRef = useRef(null);

  const [nextMsSeed, setNextMsSeed] = useState(null); // 15-min cadence
  const [engMsSeed, setEngMsSeed] = useState(null);   // 2-min chat
  const nextLeft = useCountdown(nextMsSeed, !!nextMsSeed && !inEngagementRef.current);
  const engLeft = useCountdown(engMsSeed, !!engMsSeed);


  const inConfirmationRef = useRef(false);
  const [confirmListening, setConfirmListening] = useState(false);


  // Ask mic permission once
  useEffect(() => {
    let stream;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
      } catch {}
    })();
    return () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {} };
  }, []);

  useEffect(() => {
    onState?.({
      session: threadIdRef.current,
      listening,
      lastUserMsg,
      lastBotMsg,
      nextLeft,
      engLeft,
      scheduled: scheduleActiveRef.current,
      inEngagement: inEngagementRef.current,
    });
    VoiceChatAPI.last = {
      listening,
      nextLeft,
      engLeft,
      scheduled: scheduleActiveRef.current,
      inEngagement: inEngagementRef.current,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, lastUserMsg, lastBotMsg, nextLeft, engLeft]);

  function unlockIOSAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        if (!window.__drivebuddyAC) window.__drivebuddyAC = new AC();
        if (window.__drivebuddyAC.state === "suspended") window.__drivebuddyAC.resume();
      }
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      if (!audioUnlockedRef.current) {
        const u = new SpeechSynthesisUtterance("Ready");
        u.volume = 0.01;
        window.speechSynthesis.speak(u);
      }
      audioUnlockedRef.current = true;
    } catch {}
  }

  // Voices + share voice with Audio Manager
  useEffect(() => {
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      const english = all.filter((v) => v.lang?.toLowerCase().startsWith("en"));
      setVoices(english);
      if (!selectedVoice && english.length) setSelectedVoice(english[0].name);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const filteredVoices = useMemo(() => {
    const maleHints = /(^|[\s-])(male|alex|daniel|george|liam|fred|tom|matt)([\s-]|$)/i;
    const femaleHints = /(^|[\s-])(female|samantha|olivia|victoria|karen|susan|eva|zira)([\s-]|$)/i;
    const guess = voices.filter((v) =>
      (gender === "male" ? maleHints : femaleHints).test(v.name.toLowerCase())
    );
    return guess.length ? guess : voices;
  }, [voices, gender]);
  useEffect(() => {
    if (!filteredVoices.length) return;
    const still = filteredVoices.find((v) => v.name === selectedVoice);
    if (!still) setSelectedVoice(filteredVoices[0].name);
    const vObj =
      filteredVoices.find((v) => v.name === (still?.name || selectedVoice)) ||
      filteredVoices[0];
    window.DriveBuddyAudio?.setVoice(vObj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, voices, selectedVoice, filteredVoices]);

  // STT helpers
  function stopListening() {
    try { if (recognitionRef.current) recognitionRef.current.onresult = null; } catch {}
    try { if (recognitionRef.current) recognitionRef.current.onerror = null; } catch {}
    try { if (recognitionRef.current) recognitionRef.current.onend = null; } catch {}
    try { recognitionRef.current?.stop?.(); } catch {}
    try { recognitionRef.current?.abort?.(); } catch {}
    recognitionRef.current = null;            // ✅ DO NOT reassign the ref itself
    isStartingRef.current = false;
    setListening(false);
    clearTimeout(cooldownRef.current);
    cooldownRef.current = setTimeout(() => { cooldownRef.current = null; }, 250);
  }
  window.__drivebuddyAbortSTT = () => { try { recognitionRef.current?.abort?.(); } catch {} };

  async function speakText(text) {
    unlockIOSAudio();
    await window.DriveBuddyAudio?.speak(text, "chat");
  }

  const startListening = () => {
    unlockIOSAudio();
    if (isStartingRef.current) return;
    if (cooldownRef.current) return;
    if (recognitionRef.current) stopListening();

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Speech Recognition not supported in this browser"); return; }

    isStartingRef.current = true;

    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = async (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || "";
      setLastUserMsg(transcript);
      await getAIResponse(transcript);
    };

    rec.onnomatch = () => stopListening();
    rec.onspeechend = () => { try { rec.stop(); } catch {} };
    rec.onaudioend = () => stopListening();
    rec.onerror = () => stopListening();
    rec.onend = () => stopListening();

    try {
      rec.start();
      recognitionRef.current = rec;
      setListening(true);
    } catch {
      stopListening();
    } finally {
      isStartingRef.current = false;
    }
  };

  async function callLLM(prompt) {
    // include GEO tag (weather/tool context) just like full chat
    let tag = "";
    try {
      const g = await getGeoOnce();
      if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
        tag = `[GEO: lat=${g.lat} lon=${g.lon}] `;
      }
    } catch {}
    const raw = `${tag}${prompt}`;

    const res = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: raw, thread_id: threadIdRef.current }),
    });
    const data = await res.json();
    if (Array.isArray(data)) return data.map((b) => b?.text || "").join(" ").trim() || "Okay.";
    if (typeof data === "string") return data.trim() || "Okay.";
    if (data?.text) return String(data.text).trim();
    return "Okay.";
  }

  async function speakThenListen(text) {
    await wait(250);
    await speakText(text);
    await wait(450);
    startListening(); // auto-restart like the full chat
  }

  async function getAIResponse(text) {
    try {
      let reply = (await callLLM(text)) || "Okay.";
      const words = reply.split(/\s+/);
      if (words.length > 30) reply = words.slice(0, 30).join(" ") + ".";
      setLastBotMsg(reply);
      await speakThenListen(reply);
    } catch {
      setLastBotMsg("Sorry, I had trouble responding.");
      await speakThenListen("Sorry, I had trouble responding.");
    }
  }

  // Engagement / scheduler (unchanged)
  async function startEngagement(reason = "scheduled", risk = null) {
    clearTimeout(nextTimerRef.current);
    inEngagementRef.current = true;
    drowsyModeRef.current = reason === "drowsy";
    setEngMsSeed(2 * 60 * 1000);

    const riskLine = risk && typeof risk.index === "number"
      ? `Current risk index: ${risk.index} (${risk.band}).`
      : "";

  // Speak the risk index directly (if present)
  if (reason === "drowsy" && riskLine) {
    await speakText(riskLine);
    await wait(800); // short pause before conversation starts
  }
    const kickoff =
      reason === "drowsy"
        ? `${SYSTEM_INSTRUCTION}
${riskLine}
Start a quick, upbeat 2-minute conversation to re-energize the driver.
Use very brief, safe prompts (e.g., light questions, quick energizers). Keep each reply <=2 sentences. Begin now with one friendly line.`
        : `${SYSTEM_INSTRUCTION}
It's a scheduled 15-minute check-in. Start a short, positive 2-minute chat to keep energy up.
Keep replies <=2 sentences. Start now with one friendly line.`;

    try {
      const first = await callLLM(kickoff);
      setLastBotMsg(first);
      await speakThenListen(first);
    } catch {
      await speakThenListen("Hey, quick check-in. How are you feeling?");
    }

    clearTimeout(convoTimeoutRef.current);
    convoTimeoutRef.current = setTimeout(() => endEngagement(), 2 * 60 * 1000);
  }

  function endEngagement() {
    if (!inEngagementRef.current) return;
    inEngagementRef.current = false;
    drowsyModeRef.current = false;
    setEngMsSeed(null);
    window.DriveBuddyAudio?.speak("Alright, I'll be quiet now. I'm here if you need me.", "chat");
    if (scheduleActiveRef.current) scheduleNext(15 * 60 * 1000);
  }

  function scheduleNext(ms) {
    clearTimeout(nextTimerRef.current);
    setNextMsSeed(ms);
    nextTimerRef.current = setTimeout(() => startEngagement("scheduled"), ms);
  }
  function startScheduler() {
    if (scheduleActiveRef.current) return;
    scheduleActiveRef.current = true;
    scheduleNext(15 * 60 * 1000);
    window.DriveBuddyAudio?.speak("15-minute check-ins enabled.", "chat");
  }
  function stopScheduler() {
    scheduleActiveRef.current = false;
    clearTimeout(nextTimerRef.current);
    setNextMsSeed(null);
    window.DriveBuddyAudio?.speak("Check-ins paused.", "chat");
  }

useEffect(() => {
  const onDrowsy = async (evt) => {
    if (inConfirmationRef.current) return; // prevent loop
    inConfirmationRef.current = true;

    try {
      const geo = await getGeoOnce();
      let didSpeak = false;
      let rerouteApproved = false;

      if (geo) {
        const qs = new URLSearchParams({ lat: String(geo.lat), lng: String(geo.lon) });
        const r = await fetch(`${API_BASE}/tools/reststop?${qs.toString()}`);
        const data = await r.json();

        if (data?.found && data.best) {
          const best = data.best;
          const msg = `I found ${best.name}, about ${(best.dist_m / 1000).toFixed(1)} km away, roughly ${Math.round((best.duration_s ?? best.dist_m / 15) / 60)} minutes drive. Do you want me to reroute you there?`;

          await window.DriveBuddyAudio?.speak(msg, "chat");
          didSpeak = true;

          rerouteApproved = await new Promise((resolve) => {
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SR) return resolve(false);

            const rec = new SR();
            rec.lang = "en-US";
            rec.interimResults = false;
            rec.maxAlternatives = 1;

            let decided = false;
            const decide = (val) => {
              if (decided) return;
              decided = true;
              try { rec.stop(); } catch {}
              setConfirmListening(false);
              resolve(val);
            };

            rec.onresult = (ev) => {
              const transcript = ev.results?.[0]?.[0]?.transcript?.toLowerCase() || "";
              console.log("[reststop confirm transcript]", transcript);
              if (/\b(yes|yeah|yep|sure|ok|okay|please|go ahead)\b/i.test(transcript)) {
                decide(true);
              } else {
                decide(false);
              }
            };

            rec.onerror = () => decide(false);
            rec.onend = () => decide(false);

            try { rec.start(); setConfirmListening(true); } catch { decide(false); }

            setTimeout(() => decide(false), 5000);
          });

          if (rerouteApproved) {
            window.dispatchEvent(new CustomEvent("drivebuddy:reroute", { detail: { ...best, soft: true } }));
            await window.DriveBuddyAudio?.speak("Okay, rerouting now.", "chat");
          } else {
            await window.DriveBuddyAudio?.speak("Alright, I won’t reroute. I’ll stay with you.", "chat");
          }
        } else {
          await window.DriveBuddyAudio?.speak("I couldn’t find a safe place to stop within 10 kilometers, but don’t worry—I’ll keep you company for two minutes.", "chat");
          didSpeak = true;
        }
      }

      if (!inEngagementRef.current) {
        if (didSpeak) await new Promise((res) => setTimeout(res, 1200));
        const risk = evt?.detail || null;
        startEngagement("drowsy", risk);
      }
    } finally {
      inConfirmationRef.current = false;
    }
  };

  window.addEventListener("drivebuddy:drowsy", onDrowsy);
  return () => window.removeEventListener("drivebuddy:drowsy", onDrowsy);
}, []);



  VoiceChatAPI.startScheduler = startScheduler;
  VoiceChatAPI.stopScheduler = stopScheduler;
  VoiceChatAPI.triggerDrowsy = () =>
    window.dispatchEvent(new CustomEvent("drivebuddy:drowsy"));

  /* ---------- UI ---------- */
  const showControls = uiMode !== "mic";       // hide voice/gender/test when mic-only
  const showConversation = uiMode !== "mic";   // hide “You/Buddy” pane when mic-only

  return (
    <>
      {/* Mic button (same behavior in both modes) */}
      <button
        className={`mic-button ${listening ? "listening" : ""}`}
        onClick={() => (listening ? stopListening() : startListening())}
        aria-label={listening ? "Stop listening" : "Start voice chat"}
        title={listening ? "Tap to stop" : "Tap to speak"}
      >
        🎤
      </button>

      {showControls && (
        <div className="controls">
          <div className="control-group">
            <label htmlFor="gender">Gender</label>
            <select id="gender" value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="voice">Voice</label>
            <select
              id="voice"
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              disabled={!filteredVoices.length}
            >
              {filteredVoices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="testText">Test phrase</label>
            <input
              id="testText"
              type="text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
            />
            <button
              className="basic test-btn"
              onClick={() => {
                const u = new SpeechSynthesisUtterance(testText || "Test voice. Drive safe.");
                if (window.DriveBuddyAudio?.voice) u.voice = window.DriveBuddyAudio.voice;
                u.lang = window.DriveBuddyAudio?.lang || "en-US";
                window.speechSynthesis.speak(u);
              }}
            >
              ▶️ Test Voice
            </button>
          </div>
        </div>
      )}

      {showConversation && (
        <div className="conversation" role="status" aria-live="polite">
          <p><b>You:</b> {lastUserMsg}</p>
          <p><b>Buddy:</b> {lastBotMsg}</p>
          <p style={{ fontSize: 12, color: "#9aa4b2" }}>
            Session: <code>{threadIdRef.current}</code> (resets on reload)
          </p>
        </div>
      )}
    </>
  );
}

/** --------- Timer panel (top-right card) ---------- */
function TimerPanelInner() {
  const [snap, setSnap] = useState({
    nextLeft: null, engLeft: null, scheduled: false, inEngagement: false, listening: false,
  });
  useEffect(() => {
    const id = setInterval(() => setSnap(
      VoiceChatAPI.last || { nextLeft: null, engLeft: null, scheduled: false, inEngagement: false, listening: false }
    ), 500);
    return () => clearInterval(id);
  }, []);
  const live = snap.inEngagement;
  const nextLive = snap.scheduled && !live;

  return (
    <>
      <h3 style={{ margin: "0 0 6px" }}>Status</h3>
      <div className={`mic-indicator ${snap.listening ? "on" : "off"}`}
           title={snap.listening ? "Microphone is listening" : "Microphone idle"}>
        <span className="dot" aria-hidden="true" />
        <span className="label">{snap.listening ? "Mic: Listening" : "Mic: Idle"}</span>
      </div>
      <div className="timers" style={{ marginTop: 10 }}>
        <div className={`timer ${live ? "live" : ""}`}>
          <h4>Chat ends in</h4>
          <div className="count">{fmt(snap.engLeft)}</div>
        </div>
        <div className="timer">
          <h4>Next check-in</h4>
          <div className="count" style={{ opacity: nextLive ? 1 : 0.6 }}>
            {fmt(snap.nextLeft)}
          </div>
        </div>
      </div>
      <p className="small-note">
        {live ? "Active 2-minute engagement."
              : snap.scheduled ? "Scheduler armed (15-minute cadence)."
              : "Scheduler is off."}
      </p>
    </>
  );
}

/** simple internal bus for sharing state to TimerPanel */
const VoiceChatAPI = {
  startScheduler: () => {},
  stopScheduler: () => {},
  triggerDrowsy: () => {},
  set last(v) { this._last = v; },
  get last() { return this._last; },
};

export default {
  // Full panel (unchanged)
  Controls: (props) => <VoiceCore uiMode="full" onState={(s) => (VoiceChatAPI.last = s)} {...props} />,
  // Mic-only (all logic retained, UI hidden)
  MicOnly: (props) => <VoiceCore uiMode="mic" onState={(s) => (VoiceChatAPI.last = s)} {...props} />,
  TimerPanel: TimerPanelInner,
};

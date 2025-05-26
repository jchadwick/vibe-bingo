import React, { useState, useRef, useEffect } from 'react';
import initWhisper, { SessionBuilder, DecodingOptionsBuilder, Task } from 'whisper-wasm';

const BINGO_COLUMNS = [
    { letter: 'B', range: [1, 15] },
    { letter: 'I', range: [16, 30] },
    { letter: 'N', range: [31, 45] },
    { letter: 'G', range: [46, 60] },
    { letter: 'O', range: [61, 75] },
];

const STORAGE_KEY = 'bingo-game-state-v1';

function getAllNumbers() {
    return Array.from({ length: 75 }, (_, i) => i + 1);
}

function getColumnNumbers() {
    return BINGO_COLUMNS.map(col =>
        Array.from({ length: col.range[1] - col.range[0] + 1 }, (_, i) => col.range[0] + i)
    );
}

function getBingoBoard() {
    // For display only, not a player card
    return getColumnNumbers();
}

function getBingoLabel(num) {
    for (let i = 0; i < BINGO_COLUMNS.length; i++) {
        const { letter, range } = BINGO_COLUMNS[i];
        if (num >= range[0] && num <= range[1]) return `${letter}${num}`;
    }
    return num;
}

const board = getBingoBoard();

function Basket({ rolling, currentNumber }) {
    return (
        <div className={`basket ${rolling ? 'rolling' : ''}`}>
            <div className="basket-ball">
                {currentNumber ? getBingoLabel(currentNumber) : '?'}
            </div>
        </div>
    );
}

function BingoBoard({ calledNumbers, layout }) {
    // layout: 'vertical' (default) or 'horizontal'
    if (layout === 'horizontal') {
        // BINGO as vertical header, numbers as rows
        return (
            <div className="bingo-board-horizontal">
                <div className="bingo-board-h-letters">
                    {BINGO_COLUMNS.map(col => (
                        <div key={col.letter} className="bingo-board-h-letter">{col.letter}</div>
                    ))}
                </div>
                <div className="bingo-board-h-rows">
                    {board.map((col, colIdx) => (
                        <div key={colIdx} className="bingo-board-h-row">
                            {col.map((num, rowIdx) => (
                                <div
                                    key={rowIdx}
                                    className={`bingo-board-h-cell${calledNumbers.includes(num) ? ' called' : ''}`}
                                >
                                    {num}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    // Default vertical table
    return (
        <table className="bingo-board">
            <thead>
                <tr>
                    {BINGO_COLUMNS.map(col => (
                        <th key={col.letter}>{col.letter}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {[...Array(15)].map((_, rowIdx) => (
                    <tr key={rowIdx}>
                        {board.map((col, colIdx) => {
                            const num = col[rowIdx];
                            if (!num) return <td key={colIdx}></td>;
                            const called = calledNumbers.includes(num);
                            return (
                                <td key={colIdx} className={called ? 'called' : ''}>
                                    {num}
                                </td>
                            );
                        })}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}


function useResponsiveLayout() {
    // Returns 'horizontal' if wide, else 'vertical'
    const [layout, setLayout] = useState(
        window.innerWidth >= 700 ? 'horizontal' : 'vertical'
    );
    useEffect(() => {
        const onResize = () => {
            setLayout(window.innerWidth >= 700 ? 'horizontal' : 'vertical');
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    return layout;
}

export default function App() {
    // Try to load from localStorage
    const loadState = () => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (
                Array.isArray(parsed.called) &&
                Array.isArray(parsed.remaining) &&
                (typeof parsed.current === 'number' || parsed.current === null)
            ) {
                return parsed;
            }
        } catch {
            // Ignore errors, treat as no saved state
        }
        return null;
    };

    const initial = loadState();
    const [remaining, setRemaining] = useState(initial ? initial.remaining : getAllNumbers());
    const [called, setCalled] = useState(initial ? initial.called : []);
    const [current, setCurrent] = useState(initial ? initial.current : null);
    const [rolling, setRolling] = useState(false);
    const rollingTimeout = useRef(null);
    const layout = useResponsiveLayout();
    const ttsTimeout = useRef(null);
    const autoTimer = useRef(null);
    const [autoRunning, setAutoRunning] = useState(false);
    const [intervalSec, setIntervalSec] = useState(10);
    const [listening, setListening] = useState(false);
    const [recognitionSupported, setRecognitionSupported] = useState(false);
    const recognitionRef = useRef(null);
    // Whisper WASM state
    const [whisperMode, setWhisperMode] = useState('webspeech'); // 'webspeech' | 'whisper'
    const [whisperReady, setWhisperReady] = useState(false);
    const [whisperLoading, setWhisperLoading] = useState(false);
    const [whisperSession, setWhisperSession] = useState(null);
    const [whisperListening, setWhisperListening] = useState(false);
    const whisperStreamRef = useRef(null);
    const whisperAudioCtxRef = useRef(null);
    const whisperBufferRef = useRef([]);
    const whisperProcessingRef = useRef(false);
    const [whisperDebug, setWhisperDebug] = useState('');
    const whisperDebugTimeout = useRef(null);
    const bingoCooldownRef = useRef(0);
    // Add state for confirmation mode and last checked number
    const [confirmationMode, setConfirmationMode] = useState(false);
    const [lastChecked, setLastChecked] = useState(null); // { label: string, valid: boolean }
    const confirmationRecognitionRef = useRef(null);

    // Save to localStorage on every change
    useEffect(() => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ called, remaining, current })
        );
    }, [called, remaining, current]);

    const rollNext = () => {
        if (rolling || remaining.length === 0) return;
        setRolling(true);
        let ticks = 0;
        const maxTicks = 15;
        const tick = () => {
            if (ticks < maxTicks) {
                const rand = remaining[Math.floor(Math.random() * remaining.length)];
                setCurrent(rand);
                ticks++;
                rollingTimeout.current = setTimeout(tick, 50 + ticks * 10);
            } else {
                const idx = Math.floor(Math.random() * remaining.length);
                const num = remaining[idx];
                setCurrent(num);
                setCalled([...called, num]);
                setRemaining(remaining.filter((n, i) => i !== idx));
                setRolling(false);
                // TTS: Speak the called number
                speakNumber(num);
            }
        };
        tick();
    };

    // TTS function: say number twice with 2s pause
    function speakNumber(num) {
        if (!('speechSynthesis' in window)) return;
        const label = getBingoLabel(num);
        // Split label for clarity (e.g., 'B12' -> 'B 12')
        const match = label.match(/^([A-Z])(\d+)$/);
        const bingoLabel = match ? `${match[1]} ${match[2]}` : label;
        // Remove classic call and hype phrase
        const toSpeak = bingoLabel;
        window.speechSynthesis.cancel(); // Stop any ongoing speech
        if (ttsTimeout.current) {
            clearTimeout(ttsTimeout.current);
            ttsTimeout.current = null;
        }
        // Randomize pitch/rate for fun
        const randomPitch = 0.9 + Math.random() * 0.4; // 0.9–1.3
        const randomRate = 0.85 + Math.random() * 0.3; // 0.85–1.15
        // Speak first time
        const utter1 = new window.SpeechSynthesisUtterance(toSpeak);
        utter1.rate = randomRate;
        utter1.pitch = randomPitch;
        window.speechSynthesis.speak(utter1);
        // Schedule second utterance after 2s
        ttsTimeout.current = setTimeout(() => {
            window.speechSynthesis.cancel();
            const utter2 = new window.SpeechSynthesisUtterance(toSpeak);
            utter2.rate = randomRate;
            utter2.pitch = randomPitch;
            window.speechSynthesis.speak(utter2);
            ttsTimeout.current = null;
        }, 2000);
    }

    // TTS: Announce BINGO
    function announceBingo() {
        // Stop any rolling/call in progress
        if (rollingTimeout.current) {
            clearTimeout(rollingTimeout.current);
            rollingTimeout.current = null;
        }
        if (rolling) setRolling(false);
        const now = Date.now();
        if (now < bingoCooldownRef.current) return;
        bingoCooldownRef.current = now + 5000; // 5 seconds cooldown
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        if (ttsTimeout.current) {
            clearTimeout(ttsTimeout.current);
            ttsTimeout.current = null;
        }
        pauseAuto();
        const utter = new window.SpeechSynthesisUtterance('We have a BINGO!');
        utter.rate = 0.9;
        utter.pitch = 1.1;
        window.speechSynthesis.speak(utter);
    }

    // Start/pause auto rolling
    function startAuto() {
        if (autoRunning || rolling || remaining.length === 0) return;
        setAutoRunning(true);
        // Immediately roll and announce the next number
        if (!rolling && remaining.length > 0) {
            rollNext();
        }
    }

    function pauseAuto() {
        setAutoRunning(false);
        if (autoTimer.current) {
            clearTimeout(autoTimer.current);
            autoTimer.current = null;
        }
    }

    // Effect: handle auto rolling
    useEffect(() => {
        if (!autoRunning) {
            if (autoTimer.current) {
                clearTimeout(autoTimer.current);
                autoTimer.current = null;
            }
            return;
        }
        if (rolling || remaining.length === 0) return;
        // Schedule next roll
        autoTimer.current = setTimeout(() => {
            if (!rolling && remaining.length > 0) {
                rollNext();
            }
        }, intervalSec * 1000);
        return () => {
            if (autoTimer.current) clearTimeout(autoTimer.current);
        };
    }, [autoRunning, rolling, remaining.length, intervalSec]);

    // Pause auto on manual roll or reset
    useEffect(() => {
        if (remaining.length === 0) pauseAuto();
    }, [remaining.length]);

    // Cleanup auto timer on unmount
    useEffect(() => {
        return () => {
            if (ttsTimeout.current) clearTimeout(ttsTimeout.current);
            window.speechSynthesis.cancel();
            if (autoTimer.current) clearTimeout(autoTimer.current);
        };
    }, []);

    const resetGame = () => {
        setRemaining(getAllNumbers());
        setCalled([]);
        setCurrent(null);
        localStorage.removeItem(STORAGE_KEY);
        pauseAuto();
    };

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (rollingTimeout.current) clearTimeout(rollingTimeout.current);
        };
    }, []);

    useEffect(() => {
        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            setRecognitionSupported(true);
            recognitionRef.current = new SpeechRecognition();
            recognitionRef.current.continuous = true;
            recognitionRef.current.interimResults = false;
            recognitionRef.current.lang = 'en-US';
            recognitionRef.current.onresult = (event) => {
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        const transcript = event.results[i][0].transcript.trim().toLowerCase();
                        setWhisperDebug(transcript);
                        if (whisperDebugTimeout.current) clearTimeout(whisperDebugTimeout.current);
                        whisperDebugTimeout.current = setTimeout(() => setWhisperDebug(''), 10000);
                        if (transcript.includes('bingo')) {
                            announceBingo();
                        }
                    }
                }
            };
            recognitionRef.current.onend = () => {
                // If still supposed to be listening, restart
                if (listening) {
                    try { recognitionRef.current.start(); } catch { /* ignore start errors */ }
                }
            };
        }
    }, []); // Only run once

    // Start/stop listening
    const toggleListening = () => {
        if (!recognitionSupported) return;
        if (!listening) {
            try {
                recognitionRef.current.start();
                setListening(true);
            } catch { /* ignore start errors */ }
        } else {
            recognitionRef.current.stop();
            setListening(false);
        }
    };

    // Stop listening on unmount
    useEffect(() => {
        return () => {
            if (recognitionRef.current) recognitionRef.current.stop();
        };
    }, []);

    // Load Whisper WASM and tiny model on demand
    useEffect(() => {
        if (whisperMode !== 'whisper' || whisperSession) return;
        setWhisperLoading(true);
        (async () => {
            try {
                await initWhisper();
                // Fetch tiny model and tokenizer (from CDN or local, here we use a placeholder URL)
                const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';
                const tokenizerUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/tokenizer.bin';
                const [modelRes, tokenizerRes] = await Promise.all([
                    fetch(modelUrl),
                    fetch(tokenizerUrl)
                ]);
                const modelBytes = new Uint8Array(await modelRes.arrayBuffer());
                const tokenizerBytes = new Uint8Array(await tokenizerRes.arrayBuffer());
                const builder = new SessionBuilder();
                builder.setModel(modelBytes);
                builder.setTokenizer(tokenizerBytes);
                const session = await builder.build();
                setWhisperSession(session);
                setWhisperReady(true);
            } catch {
                setWhisperReady(false);
            } finally {
                setWhisperLoading(false);
            }
        })();
    }, [whisperMode, whisperSession]);

    // Whisper real-time listening logic
    const startWhisperListening = async () => {
        if (whisperListening || !whisperSession) return;
        setWhisperListening(true);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        whisperStreamRef.current = stream;
        const audioCtx = new window.AudioContext({ sampleRate: 16000 });
        whisperAudioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(audioCtx.destination);
        processor.onaudioprocess = (e) => {
            if (!whisperListening) return;
            const input = e.inputBuffer.getChannelData(0);
            // Buffer audio in 2s chunks (32000 samples)
            whisperBufferRef.current = whisperBufferRef.current.concat(Array.from(input));
            if (whisperBufferRef.current.length >= 32000) {
                if (!whisperProcessingRef.current) {
                    const chunk = whisperBufferRef.current.slice(0, 32000);
                    whisperBufferRef.current = whisperBufferRef.current.slice(16000); // 1s overlap
                    processWhisperChunk(chunk);
                }
            }
        };
    };

    const stopWhisperListening = () => {
        setWhisperListening(false);
        if (whisperStreamRef.current) {
            whisperStreamRef.current.getTracks().forEach(track => track.stop());
            whisperStreamRef.current = null;
        }
        if (whisperAudioCtxRef.current) {
            whisperAudioCtxRef.current.close();
            whisperAudioCtxRef.current = null;
        }
        whisperBufferRef.current = [];
    };

    const processWhisperChunk = async (floatChunk) => {
        whisperProcessingRef.current = true;
        // Convert Float32Array [-1,1] to Int16 PCM
        const pcm = new Int16Array(floatChunk.length);
        for (let i = 0; i < floatChunk.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, floatChunk[i] * 32767));
        }
        if (whisperSession) {
            const options = new DecodingOptionsBuilder()
                .setTask(Task.Transcribe)
                .setLanguage('en')
                .build();
            const result = await whisperSession.run(new Uint8Array(pcm.buffer), options);
            const text = result.segments?.map(seg => seg.text).join(' ').toLowerCase() || '';
            setWhisperDebug(text);
            if (whisperDebugTimeout.current) clearTimeout(whisperDebugTimeout.current);
            whisperDebugTimeout.current = setTimeout(() => setWhisperDebug(''), 10000);
            if (fuzzyBingoMatch(text)) announceBingo();
        }
        whisperProcessingRef.current = false;
    };

    // Cleanup debug timeout on unmount
    useEffect(() => {
        return () => {
            if (whisperDebugTimeout.current) clearTimeout(whisperDebugTimeout.current);
        };
    }, []);

    // Fuzzy match for 'bingo' (allow 1 typo, or common variants)
    function fuzzyBingoMatch(text) {
        if (text.includes('bingo')) return true;
        // Common misrecognitions
        const variants = ['bengo', 'bing o', 'bingoo', 'bing', 'bigo', 'bigo!', 'bing o!'];
        for (const v of variants) {
            if (text.includes(v)) return true;
        }
        // Levenshtein distance <= 1 for any word in text
        const words = text.split(/\s+/);
        for (const word of words) {
            if (levenshtein(word, 'bingo') <= 1) return true;
        }
        return false;
    }

    // Levenshtein distance helper
    function levenshtein(a, b) {
        const dp = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
                else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[a.length][b.length];
    }

    // Helper: parse spoken bingo label (e.g., "B 12", "N43")
    function parseBingoLabel(text) {
        let t = text.trim().toUpperCase();
        // Replace 'ZERO' and '0' at the start with 'O'
        t = t.replace(/^(ZERO|0)\b/, 'O');
        // Match with or without BINGO letter
        let match = t.match(/^([BINGO])\s*-?\s*(\d{1,2})$/);
        if (match) {
            const letter = match[1];
            const num = parseInt(match[2], 10);
            if (isNaN(num) || num < 1 || num > 75) return null;
            // Validate number in range for the letter
            const col = BINGO_COLUMNS.find(c => c.letter === letter);
            if (!col || num < col.range[0] || num > col.range[1]) return null;
            return `${letter}${num}`;
        }
        // Match just a number (1-75)
        match = t.match(/^(\d{1,2})$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (isNaN(num) || num < 1 || num > 75) return null;
            // Assign correct BINGO letter
            for (const col of BINGO_COLUMNS) {
                if (num >= col.range[0] && num <= col.range[1]) {
                    return `${col.letter}${num}`;
                }
            }
        }
        return null;
    }

    // Confirmation mode: start/stop listening
    useEffect(() => {
        if (!confirmationMode) {
            if (confirmationRecognitionRef.current) {
                confirmationRecognitionRef.current.stop();
                confirmationRecognitionRef.current = null;
            }
            return;
        }
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;
        const recog = new SpeechRecognition();
        recog.continuous = true;
        recog.interimResults = false;
        recog.lang = 'en-US';
        recog.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    const transcript = event.results[i][0].transcript.trim();
                    const parsed = parseBingoLabel(transcript);
                    if (parsed) {
                        // Check if this label is in called
                        const valid = called.some(n => getBingoLabel(n) === parsed);
                        setLastChecked({ label: parsed, valid });
                        // TTS announce Yes/No
                        if ('speechSynthesis' in window) {
                            window.speechSynthesis.cancel();
                            const utter = new window.SpeechSynthesisUtterance(valid ? 'Yes' : 'No');
                            utter.rate = 1.0;
                            utter.pitch = valid ? 1.2 : 0.8;
                            utter.volume = 1.0;
                            window.speechSynthesis.speak(utter);
                        }
                    } else {
                        setLastChecked({ label: transcript, valid: null });
                    }
                }
            }
        };
        recog.onend = () => {
            if (confirmationMode) {
                try { recog.start(); } catch { /* ignore */ }
            }
        };
        try { recog.start(); } catch { /* ignore */ }
        confirmationRecognitionRef.current = recog;
        return () => {
            recog.stop();
            confirmationRecognitionRef.current = null;
        };
    }, [confirmationMode, called]);

    return (
        <div className="app-container">
            <h1>Bingo Caller</h1>
            {/* Main board row: basket and grid side by side */}
            <div className="main-board-row">
                <Basket rolling={rolling} currentNumber={current} />
                <BingoBoard calledNumbers={called} layout={layout} />
            </div>
            {/* Number History Bar */}
            {called.length > 0 && (
                <div className="number-history-bar">
                    <div className="number-history-scroll">
                        {[...called].reverse().map((num, idx) => {
                            const label = getBingoLabel(num) || num;
                            return (
                                <div key={idx} className="number-history-chip">
                                    <span className="number-history-label">{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            {!confirmationMode && (
                <div className="button-row">
                    <button
                        className={`confirm-mode-btn${confirmationMode ? ' active' : ''}`}
                        onClick={() => setConfirmationMode(v => !v)}
                    >
                        {confirmationMode ? 'Exit Confirmation Mode' : 'Confirmation Mode'}
                    </button>
                    {whisperMode === 'whisper' && (
                        <button
                            className={`whisper-btn${whisperListening ? ' recording' : ''}`}
                            onClick={whisperListening ? stopWhisperListening : startWhisperListening}
                            disabled={!whisperReady || whisperLoading}
                        >
                            {whisperLoading ? 'Loading Whisper...' : whisperListening ? 'Stop Whisper Listening' : 'Start Whisper Listening'}
                        </button>
                    )}
                    <button
                        className="startpause-btn"
                        onClick={autoRunning ? pauseAuto : startAuto}
                        disabled={rolling || remaining.length === 0}
                    >
                        {autoRunning ? 'Pause' : 'Start'}
                    </button>
                    <button className="roll-btn" onClick={rollNext} disabled={rolling || remaining.length === 0}>
                        {remaining.length === 0 ? 'All Numbers Called' : rolling ? 'Rolling...' : 'Roll Next Number'}
                    </button>
                    <button className="reset-btn" onClick={resetGame} disabled={rolling}>
                        Reset Game
                    </button>
                    <button className="bingo-btn" onClick={announceBingo}>
                        BINGO!
                    </button>
                </div>
            )}
            {/* Settings row at the bottom */}
            <div className="settings-row">
                <label className="mode-label">
                    Listen mode:
                    <select value={whisperMode} onChange={e => setWhisperMode(e.target.value)}>
                        <option value="webspeech">Web Speech API</option>
                        <option value="whisper">Whisper (WASM)</option>
                    </select>
                </label>
                <label className="interval-label">
                    Interval:
                    <input
                        type="number"
                        min="3"
                        max="60"
                        value={intervalSec}
                        onChange={e => setIntervalSec(Math.max(3, Math.min(60, Number(e.target.value))))}
                        className="interval-input"
                        disabled={autoRunning}
                    />
                    s
                </label>
                <button
                    className={`listen-btn small-btn${listening ? ' listening' : ''}`}
                    onClick={toggleListening}
                    disabled={!recognitionSupported || whisperMode !== 'webspeech'}
                    title={recognitionSupported ? (listening ? 'Stop Listening' : 'Start Listening for "BINGO!"') : 'Speech recognition not supported'}
                >
                    {listening ? 'Stop Listening' : 'Listen for "BINGO!"'}
                </button>
            </div>
            {(whisperListening || listening) && (
                <div className="whisper-debug">
                    <b>Transcript:</b> {whisperDebug ? whisperDebug : 'Listening...'}
                </div>
            )}
            {/* Confirmation feedback */}
            {confirmationMode && (
                <div className="confirmation-feedback">
                    <div className="confirmation-status">
                        {lastChecked ? (
                            lastChecked.valid === true ? (
                                <span className="confirm-good">✔</span>
                            ) : lastChecked.valid === false ? (
                                <span className="confirm-bad">✖</span>
                            ) : (
                                <span className="confirm-unknown">?</span>
                            )
                        ) : <span className="confirm-wait">Say a number...</span>}
                    </div>
                    {lastChecked && (
                        <div className="confirmation-label">{lastChecked.label}</div>
                    )}
                </div>
            )}
            {/* Confirmation mode controls */}
            {confirmationMode && (
                <div className="confirmation-controls">
                    <button
                        className="good-bingo-btn"
                        onClick={() => {
                            if ('speechSynthesis' in window) {
                                window.speechSynthesis.cancel();
                                const utter = new window.SpeechSynthesisUtterance("That's a good bingo!");
                                utter.rate = 1.0;
                                utter.pitch = 1.1;
                                utter.volume = 1.0;
                                window.speechSynthesis.speak(utter);
                            }
                        }}
                    >
                        Good Bingo
                    </button>
                    <button
                        className="reset-btn"
                        onClick={() => {
                            setConfirmationMode(false);
                            resetGame();
                        }}
                    >
                        Reset Board
                    </button>
                    <button
                        className="exit-confirm-btn"
                        onClick={() => setConfirmationMode(false)}
                    >
                        Exit Confirmation
                    </button>
                </div>
            )}
            <style>{`
        .app-container {
          font-family: system-ui, sans-serif;
          text-align: center;
          padding: 2rem;
          background: #f7fafc;
          min-height: 100vh;
        }
        .basket {
          margin: 1.5rem auto;
          width: 120px;
          height: 120px;
          border-radius: 50%;
          background: #e0e0e0;
          box-shadow: 0 4px 16px #bbb;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }
        .basket-ball {
          width: 80px;
          height: 80px;
          background: radial-gradient(circle at 30% 30%, #fff 60%, #f44336 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 2rem;
          font-weight: bold;
          color: #222;
          box-shadow: 0 2px 8px #aaa;
          transition: transform 0.2s;
        }
        .basket.rolling .basket-ball {
          animation: bounce 0.5s infinite alternate, spin 0.7s linear infinite;
        }
        @keyframes bounce {
          0% { transform: translateY(0); }
          100% { transform: translateY(-20px); }
        }
        @keyframes spin {
          0% { filter: hue-rotate(0deg); }
          100% { filter: hue-rotate(360deg); }
        }
        .button-row {
          display: flex;
          justify-content: center;
          gap: 1rem;
          margin: 1rem 0;
        }
        .roll-btn, .reset-btn {
          padding: 0.75rem 2rem;
          font-size: 1.2rem;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .roll-btn {
          background: #1976d2;
          color: #fff;
        }
        .roll-btn:disabled {
          background: #aaa;
          cursor: not-allowed;
        }
        .reset-btn {
          background: #fff;
          color: #1976d2;
          border: 2px solid #1976d2;
        }
        .reset-btn:disabled {
          background: #eee;
          color: #aaa;
          border-color: #aaa;
          cursor: not-allowed;
        }
        .bingo-btn {
          background: #43a047;
          color: #fff;
          border: 2px solid #388e3c;
          margin-left: 0.5rem;
        }
        .bingo-btn:active {
          background: #388e3c;
        }
        .bingo-board {
          margin: 2rem auto;
          border-collapse: collapse;
          background: #fff;
          box-shadow: 0 2px 8px #ccc;
        }
        .bingo-board th, .bingo-board td {
          width: 40px;
          height: 40px;
          text-align: center;
          font-size: 1.1rem;
          border: 1px solid #ddd;
        }
        .bingo-board th {
          background: #1976d2;
          color: #fff;
        }
        .bingo-board td.called {
          background: #ffe082;
          font-weight: bold;
          color: #d84315;
        }
        /* Responsive horizontal board */
        .bingo-board-horizontal {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          margin: 2rem auto;
          background: #fff;
          box-shadow: 0 2px 8px #ccc;
          border-radius: 8px;
          overflow-x: auto;
          max-width: 100vw;
        }
        .bingo-board-h-letters {
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          align-items: center;
          background: #1976d2;
          color: #fff;
          border-top-left-radius: 8px;
          border-bottom-left-radius: 8px;
        }
        .bingo-board-h-letter {
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.1rem;
          font-weight: bold;
          border-bottom: 1px solid #1565c0;
        }
        .bingo-board-h-letter:last-child {
          border-bottom: none;
        }
        .bingo-board-h-rows {
          display: flex;
          flex-direction: column;
        }
        .bingo-board-h-row {
          display: flex;
        }
        .bingo-board-h-cell {
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #ddd;
          font-size: 1.1rem;
        }
        .bingo-board-h-cell.called {
          background: #ffe082;
          font-weight: bold;
          color: #d84315;
        }
        .called-numbers {
          margin: 2rem auto;
          max-width: 500px;
          background: #fffde7;
          border-radius: 8px;
          padding: 1rem;
          box-shadow: 0 2px 8px #eee;
        }
        .called-list {
          font-size: 1.1rem;
          word-break: break-all;
        }
        @media (max-width: 699px) {
          .bingo-board-horizontal {
            display: none;
          }
        }
        @media (min-width: 700px) {
          .bingo-board {
            display: none;
          }
        }
        .startpause-btn {
          background: #ffb300;
          color: #fff;
          border: 2px solid #ffa000;
          margin-right: 0.5rem;
        }
        .startpause-btn:active {
          background: #ffa000;
        }
        .interval-label {
          display: inline-flex;
          align-items: center;
          margin-right: 1rem;
          font-size: 1rem;
          font-weight: 500;
        }
        .interval-input {
          width: 3.5em;
          margin: 0 0.3em;
          font-size: 1rem;
          padding: 0.2em 0.4em;
          border-radius: 4px;
          border: 1px solid #bbb;
          text-align: right;
        }
        .listen-btn {
          background: #1976d2;
          color: #fff;
          border: 2px solid #1976d2;
          margin-right: 0.5rem;
          transition: background 0.2s, color 0.2s;
        }
        .listen-btn.listening {
          background: #d32f2f;
          color: #fffde7;
          border-color: #b71c1c;
          font-weight: bold;
        }
        .listen-btn:disabled {
          background: #aaa;
          color: #eee;
          border-color: #aaa;
          cursor: not-allowed;
        }
        .mode-label {
          display: inline-flex;
          align-items: center;
          margin-right: 1rem;
          font-size: 1rem;
          font-weight: 500;
        }
        .whisper-btn {
          background: #6d4cff;
          color: #fff;
          border: 2px solid #4527a0;
          margin-right: 0.5rem;
          transition: background 0.2s, color 0.2s;
        }
        .whisper-btn.recording {
          background: #d32f2f;
          color: #fffde7;
          border-color: #b71c1c;
          font-weight: bold;
        }
        .whisper-btn:disabled {
          background: #aaa;
          color: #eee;
          border-color: #aaa;
          cursor: not-allowed;
        }
        .whisper-debug {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(30,30,30,0.95);
          color: #fffde7;
          font-size: 1rem;
          padding: 0.5rem 1rem;
          text-align: left;
          z-index: 1000;
          border-top: 2px solid #6d4cff;
          font-family: monospace;
          opacity: 0.95;
          pointer-events: none;
        }
        .number-history-bar {
          margin: 0.5rem auto 1.5rem auto;
          max-width: 90vw;
          overflow-x: auto;
          padding: 0.25rem 0.5rem;
        }
        .number-history-scroll {
          display: flex;
          gap: 0.75rem;
          overflow-x: auto;
          scrollbar-width: thin;
          scrollbar-color: #bdbdbd #f7fafc;
        }
        .number-history-chip {
          min-width: 48px;
          height: 48px;
          background: radial-gradient(circle at 30% 30%, #fff 60%, #1976d2 100%);
          color: #fff;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.25rem;
          font-weight: 700;
          box-shadow: 0 1px 4px #bbb;
          border: 2px solid #1976d2;
          transition: transform 0.1s;
          user-select: none;
          overflow: visible;
          text-align: center;
        }
        .number-history-label {
          width: 100%;
          text-align: center;
          color: #222;
          font-size: 0.95em;
          font-weight: 700;
          letter-spacing: 0.5px;
          line-height: 1;
        }
        .number-history-chip:first-child {
          background: radial-gradient(circle at 30% 30%, #fff 60%, #43a047 100%);
          border-color: #43a047;
          color: #fffde7;
          transform: scale(1.12);
        }
        .number-history-scroll::-webkit-scrollbar {
          height: 6px;
        }
        .number-history-scroll::-webkit-scrollbar-thumb {
          background: #bdbdbd;
          border-radius: 3px;
        }
        .number-history-scroll::-webkit-scrollbar-track {
          background: #f7fafc;
        }
        .main-board-row {
          display: flex;
          flex-direction: row;
          justify-content: center;
          align-items: flex-start;
          gap: 2.5rem;
          margin: 0 auto 1.5rem auto;
          width: 100%;
          max-width: 900px;
        }
        @media (max-width: 699px) {
          .main-board-row {
            flex-direction: column;
            align-items: center;
            gap: 1.5rem;
          }
        }
        .settings-row {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 2rem;
          margin: 2.5rem auto 0 auto;
          padding-bottom: 1.5rem;
        }
        @media (max-width: 699px) {
          .settings-row {
            flex-direction: column;
            gap: 1rem;
          }
        }
        .confirm-mode-btn {
          background: #fff;
          color: #1976d2;
          border: 2px solid #1976d2;
          font-weight: bold;
          border-radius: 8px;
          padding: 0.6em 1.2em;
          margin-right: 0.5rem;
          transition: background 0.2s, color 0.2s;
        }
        .confirm-mode-btn.active {
          background: #1976d2;
          color: #fff;
        }
        .confirmation-feedback {
          margin: 1.5rem auto 0 auto;
          text-align: center;
        }
        .confirmation-status {
          font-size: 2.5rem;
          font-weight: bold;
          margin-bottom: 0.5rem;
        }
        .confirm-good {
          color: #43a047;
        }
        .confirm-bad {
          color: #d32f2f;
        }
        .confirm-unknown {
          color: #ffb300;
        }
        .confirm-wait {
          color: #888;
        }
        .confirmation-label {
          font-size: 1.3rem;
          font-weight: 500;
          color: #1976d2;
        }
        .listen-btn.small-btn {
          font-size: 0.95em;
          padding: 0.3em 0.8em;
          border-width: 1.5px;
          margin-left: 0.5rem;
        }
        .confirmation-controls {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 1.5rem;
          margin: 2.5rem auto 0 auto;
        }
        .good-bingo-btn {
          background: #43a047;
          color: #fff;
          border: 2px solid #388e3c;
          border-radius: 8px;
          font-weight: bold;
          padding: 0.6em 1.2em;
          font-size: 1.1em;
          transition: background 0.2s, color 0.2s;
        }
        .good-bingo-btn:active {
          background: #388e3c;
        }
        .exit-confirm-btn {
          background: #fff;
          color: #1976d2;
          border: 2px solid #1976d2;
          border-radius: 8px;
          font-weight: bold;
          padding: 0.6em 1.2em;
          font-size: 1.1em;
          transition: background 0.2s, color 0.2s;
        }
        .exit-confirm-btn:active {
          background: #1976d2;
          color: #fff;
        }
      `}</style>
        </div>
    );
}

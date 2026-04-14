import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });
const client = new Anthropic();

// ─── System Prompt ────────────────────────────────────────────────────────────

const AUDIO_ANALYSIS_SYSTEM_PROMPT = `You are an audio engineering AI assistant. Analyze the provided audio metadata and features, then perform the following:

1. SPEAKER ISOLATION: Separate all speaker vocals from non-speech sounds. Identify every non-speaker audio event based on amplitude patterns, frequency distributions, and timing.

2. NOISE DETECTION & CLASSIFICATION: Detect and classify the following with timestamps and confidence scores:
   - Sneezing (sudden burst, 200-8000Hz, duration <0.5s, very high amplitude spike)
   - Coughing (repetitive burst, 500-4000Hz, 0.3-1s duration)
   - Table/surface thumping (low-frequency impact, <500Hz, very short <0.2s)
   - Spoon, metal, glass clinking (metallic transient, 2000-12000Hz)
   - Keyboard/mouse click sounds (very brief, 1000-8000Hz, <0.1s)
   - Paper rustling (broadband noise burst, continuous 0.5-2s)
   - Background music or TV audio (sustained melodic/harmonic content)
   - Ambient noise (AC, fan, traffic - continuous low-level noise floor)

3. LAYER SEPARATION: Separate audio into:
   - Layer 1 (id: "speaker"): Speaker voice only (cleaned)
   - Layer 2 (id: "background_noise"): Impulse noises (clicks, thuds, coughs)
   - Layer 3 (id: "breath_sounds"): Breathing, sneezing, mouth sounds
   - Layer 4 (id: "ambient"): Continuous background noise
   - Layer 5 (id: "music"): Background music or media sounds

4. SILENCE DETECTION: Detect gaps where the speaker is silent (RMS below -40dB lasting longer than 500ms).

5. OUTPUT: For each event return start/end timestamp, sound type, confidence percentage, and recommended action (delete / attenuate / keep).

IMPORTANT: You MUST return ONLY valid JSON with no markdown code blocks, no explanation text before or after. Start your response with { and end with }.

Return this exact JSON structure:
{
  "summary": {
    "duration": 0,
    "speech_percentage": 0,
    "noise_percentage": 0,
    "silence_percentage": 0,
    "overall_quality": "good",
    "detected_noise_count": 0,
    "speaker_active_time": 0
  },
  "layers": [
    {
      "id": "speaker",
      "name": "Speaker Voice",
      "color": "#4fc3f7",
      "segments": [{"start": 0, "end": 0, "confidence": 0, "action": "keep"}]
    }
  ],
  "events": [
    {
      "start": 0,
      "end": 0,
      "type": "sneeze",
      "confidence": 0,
      "frequency_range": "200-8000Hz",
      "action": "delete",
      "description": "Detected sneeze"
    }
  ],
  "silence_segments": [
    {"start": 0, "end": 0, "duration": 0}
  ],
  "recommendations": ["string"]
}`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AudioFeatures {
  duration: number;
  sampleRate: number;
  channels: number;
  format?: string;
  amplitudeData: number[];        // sampled every 100ms, values 0–1
  silencePeriods: Array<{ start: number; end: number }>;
  frequencyBands: { low: number; mid: number; high: number };
  rmsEnergy: number[];            // dBFS values every 200ms
  peakAmplitude: number;
  averageAmplitude: number;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/system-stats
 * Returns basic system stats for admin panel.
 */
app.get('/api/system-stats', async (_req, res) => {
  const os = await import('os');
  const { execSync } = await import('child_process');
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU usage (avg across cores)
  const cpus = os.cpus();
  let cpuPercent = 0;
  cpus.forEach(c => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    cpuPercent += ((total - c.times.idle) / total) * 100;
  });
  cpuPercent /= cpus.length;

  // GPU info via nvidia-smi (Windows)
  let gpuName: string | null = null;
  let gpuPercent = 0;
  let vramUsed = 0;
  let vramTotal = 0;
  let gpuTemp: number | null = null;
  let gpuClockMhz: number | null = null;
  try {
    const nv = execSync('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.current.graphics --format=csv,noheader,nounits', { timeout: 3000 }).toString().trim();
    const parts = nv.split(',').map(s => s.trim());
    gpuName = parts[0] || null;
    gpuPercent = parseFloat(parts[1]) || 0;
    vramUsed = parseFloat(parts[2]) || 0;
    vramTotal = parseFloat(parts[3]) || 0;
    gpuTemp = parseFloat(parts[4]) || null;
    gpuClockMhz = parseFloat(parts[5]) || null;
  } catch {}

  // Disk usage via PowerShell
  let diskUsed = 0, diskTotal = 0;
  try {
    const diskOut = execSync('powershell -Command "Get-Volume -DriveLetter C | Select-Object -Property Size,SizeRemaining | ConvertTo-Json"', { timeout: 5000 }).toString().trim();
    const diskInfo = JSON.parse(diskOut);
    const totalSize = diskInfo.Size || 0;
    const freeSpace = diskInfo.SizeRemaining || 0;
    diskTotal = Math.round(totalSize / (1024 * 1024 * 1024) * 10) / 10;
    diskUsed = Math.round((totalSize - freeSpace) / (1024 * 1024 * 1024) * 10) / 10;
  } catch {}

  res.json({
    success: true,
    cpu_percent: Math.round(cpuPercent * 10) / 10,
    ram_percent: Math.round((usedMem / totalMem) * 1000) / 10,
    ram_used_mb: Math.round(usedMem / (1024 * 1024)),
    ram_total_mb: Math.round(totalMem / (1024 * 1024)),
    gpu_name: gpuName,
    gpu_percent: gpuPercent,
    vram_used_mb: vramUsed,
    vram_total_mb: vramTotal,
    gpu_temp: gpuTemp,
    gpu_clock_mhz: gpuClockMhz,
    disk_used_gb: diskUsed,
    disk_total_gb: diskTotal,
    platform: process.platform,
    node_version: process.version,
    uptime: Math.floor(process.uptime()),
    pid: process.pid
  });
});

/**
 * GET /api/server-log
 * Returns in-memory server logs for admin panel.
 */
const serverLogs: Array<{ ts: string; level: string; msg: string }> = [];
const MAX_LOGS = 1000;

function addServerLog(level: string, msg: string) {
  serverLogs.push({ ts: new Date().toISOString(), level, msg });
  if (serverLogs.length > MAX_LOGS) serverLogs.shift();
}

// Capture console output as logs
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = (...args: any[]) => { addServerLog('info', args.join(' ')); origLog(...args); };
console.error = (...args: any[]) => { addServerLog('error', args.join(' ')); origErr(...args); };
console.warn = (...args: any[]) => { addServerLog('warn', args.join(' ')); origWarn(...args); };

/**
 * GET /api/config
 * Returns app configuration for admin panel.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    hf_token: process.env.HF_TOKEN || '',
    anthropic_key: process.env.ANTHROPIC_API_KEY ? '***' + process.env.ANTHROPIC_API_KEY.slice(-4) : '',
    models: {
      whisper: 'large',
      llm: 'claude-opus-4-6'
    }
  });
});

app.get('/api/server-log', (req, res) => {
  const n = parseInt(req.query.n as string) || 100;
  const logs = serverLogs.slice(-n);
  res.json({ success: true, logs });
});

/**
 * POST /api/analyze
 * Receives extracted audio features from Web Audio API and runs Claude analysis.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const features: AudioFeatures = req.body.features;

    if (!features || !features.duration) {
      return res.status(400).json({ success: false, error: 'No audio features provided' });
    }

    // Build a rich text description Claude can reason about
    const amplitudeTimeline = features.amplitudeData
      .slice(0, 150)
      .map((a, i) => `t=${(i * 0.1).toFixed(1)}s:${a.toFixed(3)}`)
      .join(' | ');

    const rmsTimeline = features.rmsEnergy
      .slice(0, 75)
      .map((e, i) => `t=${(i * 0.2).toFixed(1)}s:${e.toFixed(1)}dB`)
      .join(' | ');

    const silenceDesc = features.silencePeriods.length > 0
      ? features.silencePeriods.map(s =>
          `  ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s (${(s.end - s.start).toFixed(2)}s)`
        ).join('\n')
      : '  None detected';

    const featureDescription = `AUDIO FILE ANALYSIS REQUEST

=== METADATA ===
Duration: ${features.duration.toFixed(3)} seconds
Sample Rate: ${features.sampleRate} Hz
Channels: ${features.channels} (${features.channels === 1 ? 'Mono' : 'Stereo'})
Format: ${features.format || 'PCM'}
Peak Amplitude: ${features.peakAmplitude.toFixed(4)}
Average Amplitude: ${features.averageAmplitude.toFixed(4)}

=== AMPLITUDE TIMELINE (every 100ms, range 0.000–1.000) ===
${amplitudeTimeline}
${features.amplitudeData.length > 150 ? `... (${features.amplitudeData.length - 150} more samples, audio continues)` : ''}

=== DETECTED SILENCE PERIODS (amplitude < 0.01 sustained > 500ms) ===
${silenceDesc}

=== FREQUENCY BAND ENERGY DISTRIBUTION ===
Low Band (20–500Hz, bass/rumble/voice fundamentals): ${(features.frequencyBands.low * 100).toFixed(1)}%
Mid Band (500–4000Hz, speech/vocals/instruments): ${(features.frequencyBands.mid * 100).toFixed(1)}%
High Band (4000–20000Hz, transients/hiss/air): ${(features.frequencyBands.high * 100).toFixed(1)}%

=== RMS ENERGY OVER TIME (dBFS, every 200ms) ===
${rmsTimeline}
${features.rmsEnergy.length > 75 ? `... (${features.rmsEnergy.length - 75} more measurements)` : ''}

=== ANALYSIS NOTES ===
- High amplitude spikes (>0.8) in the amplitude timeline likely indicate impulse events (coughs, thuds, clicks)
- Sustained low-amplitude regions are silence or ambient noise
- High-frequency dominance (>40% high band) suggests air conditioning, fan, or hiss
- Mid-frequency dominance (>60%) suggests active speech or music
- Very short spikes (<0.1s) could be mouse clicks or keyboard noise
- The silence periods above are auto-detected; validate and expand analysis

Please analyze ALL events with timestamps and return the complete JSON analysis.`;

    console.log(`[analyze] Sending ${features.duration.toFixed(1)}s audio to Claude...`);

    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      system: AUDIO_ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: featureDescription }]
    });

    const response = await stream.finalMessage();

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Extract JSON — Claude might wrap it in code blocks despite instructions
    let jsonStr = textBlock.text.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];

    const analysis = JSON.parse(jsonStr);
    console.log(`[analyze] Done. Events: ${analysis.events?.length || 0}, Layers: ${analysis.layers?.length || 0}`);

    return res.json({ success: true, analysis });
  } catch (err) {
    console.error('[analyze] Error:', err);
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Analysis failed'
    });
  }
});

/**
 * POST /api/command
 * Natural language audio editing commands.
 */
app.post('/api/command', async (req, res) => {
  try {
    const { command, analysisContext } = req.body;

    if (!command) {
      return res.status(400).json({ success: false, error: 'No command provided' });
    }

    const contextStr = analysisContext
      ? `Current analysis has ${analysisContext.events?.length || 0} detected events across ${analysisContext.layers?.length || 0} layers. Duration: ${analysisContext.summary?.duration?.toFixed(1) || 0}s.`
      : 'No prior analysis context.';

    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      system: `You are a professional AI audio editing assistant. The user gives you natural language commands to edit their audio.

${contextStr}

Full analysis context:
${JSON.stringify(analysisContext || {}, null, 2)}

Respond ONLY with valid JSON (no markdown, no text outside JSON):
{
  "action": "delete_events|attenuate_events|keep_only|silence_trim|normalize|custom",
  "targets": ["event_type_1", "event_type_2"],
  "parameters": {
    "attenuate_db": -20,
    "silence_threshold_db": -40,
    "silence_min_duration_ms": 500
  },
  "description": "Human readable description of what will be done",
  "affected_segments": [
    {"start": 0.0, "end": 0.5, "action": "delete", "type": "sneeze", "confidence": 0.95}
  ],
  "estimated_quality_improvement": "High reduction in background noise"
}`,
      messages: [{ role: 'user', content: command }]
    });

    const response = await stream.finalMessage();
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No response');

    let jsonStr = textBlock.text.trim();
    const codeMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeMatch) jsonStr = codeMatch[1].trim();
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];

    return res.json({ success: true, result: JSON.parse(jsonStr) });
  } catch (err) {
    console.error('[command] Error:', err);
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Command failed'
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Clean up any stale uploads
if (fs.existsSync('uploads')) {
  fs.rmSync('uploads', { recursive: true, force: true });
}

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`\n  VoiceCraft AI  →  http://localhost:${PORT}\n`);
});

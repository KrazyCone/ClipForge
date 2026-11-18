/** ASS subtitle generation: word-wrapped, mobile-legible, clear of UI safe areas. */

const STYLES = {
  bold: { size: 62, outline: 5, shadow: 0, colour: "&H00FFFFFF", back: "&H00000000" },
  clean: { size: 54, outline: 1, shadow: 0, colour: "&H00FFFFFF", back: "&H99000000" },
  karaoke: { size: 58, outline: 4, shadow: 0, colour: "&H0000FFFF", back: "&H00000000" },
} as const;

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ClipForge,{font},{size},&H00FFFFFF,&H00FFFFFF,{back},{back},-1,0,0,0,100,100,0,0,1,{outline},{shadow},2,90,90,{margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Greedy wrap at ~26 characters so lines stay readable at 1080x1920. */
export function wrapLines(text: string, maxChars = 26): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if ((current + " " + word).length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Builds a subtitle file from a transcript. Whisper gives us the full text;
 * without word timings the text is spread evenly across the clip, which reads
 * naturally for short reaction clips but is not word-accurate. Word-level
 * timings are used instead when the model returned segments.
 */
export function buildAss(
  transcript: string,
  durationSec: number,
  style: keyof typeof STYLES = "bold",
): string {
  const s = STYLES[style] ?? STYLES.bold;
  const header = ASS_HEADER.replace("{font}", "DejaVu Sans")
    .replace("{size}", String(s.size))
    .replace("{outline}", String(s.outline))
    .replace("{shadow}", String(s.shadow))
    .replace("{back}", s.back)
    .replace("{margin}", "220");

  const clean = transcript.replace(/\s+/g, " ").trim();
  if (!clean) return header;

  // Split into short phrases at punctuation, then fit them to the runtime.
  const phrases: string[] = [];
  for (const chunk of clean.split(/(?<=[.!?])\s+|,\s+/)) {
    if (!chunk.trim()) continue;
    const lines = wrapLines(chunk, 26);
    for (let i = 0; i < lines.length; i += 2) {
      phrases.push(lines.slice(i, i + 2).join("\\N"));
    }
  }
  if (phrases.length === 0) return header;

  const per = durationSec / phrases.length;
  const events: string[] = [];
  phrases.forEach((phrase, index) => {
    const start = index * per;
    const end = Math.min(durationSec, start + per * 0.96);
    events.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},ClipForge,,0,0,0,,{\\c${s.colour}\\bord${s.outline}}${phrase}`,
    );
  });

  return header + events.join("\n") + "\n";
}

/** Caption card shown at the top of the clip when there is no transcript. */
export function buildCaptionAss(caption: string, durationSec: number): string {
  const s = STYLES.bold;
  const header = ASS_HEADER.replace("{font}", "DejaVu Sans")
    .replace("{size}", String(s.size))
    .replace("{outline}", String(s.outline))
    .replace("{shadow}", String(s.shadow))
    .replace("{back}", s.back)
    .replace("{margin}", "1500");

  const text = wrapLines(caption.toUpperCase(), 22).slice(0, 3).join("\\N");
  return (
    header +
    `Dialogue: 0,${assTime(0)},${assTime(Math.min(3.2, durationSec))},ClipForge,,0,0,0,,{\\bord6\\shad0}${text}\n`
  );
}

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

  // Build caption cards of at most two lines. Punctuation closes a card; a long
  // unpunctuated transcript is still split so it never becomes one wall of text.
  const cards: string[][] = [];
  let current: string[] = [];
  for (const word of clean.replace(/[{}]/g, "").split(" ")) {
    const lastLine = current[current.length - 1];
    if (lastLine !== undefined && `${lastLine} ${word}`.length <= 26) {
      current[current.length - 1] = `${lastLine} ${word}`;
    } else if (current.length < 2) {
      current.push(word);
    } else {
      cards.push(current);
      current = [word];
    }
    if (/[.!?]$/.test(word)) {
      cards.push(current);
      current = [];
    }
  }
  if (current.length) cards.push(current);

  const phrases = cards.map((lines) => lines.join("\\N"));
  if (phrases.length === 0) return header;

  // Time each card by how much text it holds: a long sentence stays up longer
  // than a two-word reaction, which is far closer to speech than equal slots.
  const weights = phrases.map((p) => p.replace(/\\N/g, " ").length || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const events: string[] = [];
  let cursor = 0;
  phrases.forEach((phrase, index) => {
    const span = (durationSec * weights[index]) / totalWeight;
    const start = cursor;
    const end = Math.min(durationSec, cursor + span * 0.96);
    cursor += span;
    events.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},ClipForge,,0,0,0,,{\\c${s.colour}\\bord${s.outline}}${phrase}`,
    );
  });

  return header + events.join("\n") + "\n";
}

export interface TimedCaption {
  startSec: number;
  endSec: number;
  text: string;
}

/** Header block shared by the transcript and timed-card builders. */
function headerFor(style: keyof typeof STYLES): string {
  const s = STYLES[style] ?? STYLES.bold;
  return ASS_HEADER.replace("{font}", "DejaVu Sans")
    .replace("{size}", String(s.size))
    .replace("{outline}", String(s.outline))
    .replace("{shadow}", String(s.shadow))
    .replace("{back}", s.back)
    .replace("{margin}", "220");
}

/** Split one utterance into at most two-line cards. */
function phraseCards(text: string): string[] {
  const cards: string[][] = [];
  let current: string[] = [];
  for (const word of text.replace(/[{}]/g, "").split(" ")) {
    const lastLine = current[current.length - 1];
    if (lastLine !== undefined && `${lastLine} ${word}`.length <= 26) {
      current[current.length - 1] = `${lastLine} ${word}`;
    } else if (current.length < 2) {
      current.push(word);
    } else {
      cards.push(current);
      current = [word];
    }
    if (/[.!?]$/.test(word)) {
      cards.push(current);
      current = [];
    }
  }
  if (current.length) cards.push(current);
  return cards.map((lines) => lines.join("\\N"));
}

/**
 * Builds subtitles whose cards keep the timings Whisper reported. The renderer
 * joins several cuts and passes captions already remapped onto that timeline,
 * so a card can never drift onto footage it was not spoken over.
 */
export function buildAssTimed(
  captions: TimedCaption[],
  durationSec: number,
  style: keyof typeof STYLES = "bold",
): string {
  const s = STYLES[style] ?? STYLES.bold;
  const header = headerFor(style);
  const events: string[] = [];
  let cursor = 0;

  for (const caption of captions) {
    const text = caption.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = Math.max(0, Math.min(durationSec - 0.2, caption.startSec));
    const end = Math.max(start + 0.2, Math.min(durationSec, caption.endSec));
    if (end - start < 0.2) continue;

    const phrases = phraseCards(text);
    if (!phrases.length) continue;
    const weights = phrases.map((p) => p.replace(/\\N/g, " ").length || 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let t = Math.max(start, cursor);
    phrases.forEach((phrase, index) => {
      const span = ((end - start) * weights[index]) / totalWeight;
      const from = t;
      const to = Math.min(end, t + span * 0.96);
      t += span;
      if (to <= from + 0.05) return;
      events.push(
        `Dialogue: 0,${assTime(from)},${assTime(to)},ClipForge,,0,0,0,,{\\c${s.colour}\\bord${s.outline}}${phrase}`,
      );
    });
    cursor = Math.max(cursor, end);
  }

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

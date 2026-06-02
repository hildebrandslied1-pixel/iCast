import PDFDocument from "pdfkit";

export interface TranscriptPdfOptions {
  podcastTitle: string;
  episodeTitle: string;
  pubDate?: Date | null;
  duration?: string | null;
  transcript: string;
  episodeId?: number;
}

export async function generateTranscriptPdf(opts: TranscriptPdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { podcastTitle, episodeTitle, pubDate, duration, transcript, episodeId } = opts;

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 70, bottom: 70, left: 60, right: 60 },
      bufferPages: true,
      info: {
        Title:    episodeTitle,
        Author:   podcastTitle,
        Subject:  "Podcast Transcript",
        Creator:  "iCast AI System",
        Keywords: "podcast transcript icast",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data",  (c: Buffer) => chunks.push(c));
    doc.on("end",   () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W       = doc.page.width - 120;
    const DARK    = "#0f0f0f";
    const ACCENT  = "#1a1a2e";
    const ACCENT2 = "#16213e";
    const GOLD    = "#c9a84c";
    const MUTED   = "#555566";
    const RULE    = "#ddddee";
    const BG_BAND = "#f5f5fa";
    const WHITE   = "#ffffff";

    // ── Full-width header band ─────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 110).fill(ACCENT);

    // Pattern lines in header
    for (let i = 0; i < 6; i++) {
      doc.moveTo(0, 18 + i * 16).lineTo(doc.page.width, 18 + i * 16)
        .lineWidth(0.3).strokeColor("#ffffff").opacity(0.07).stroke().opacity(1);
    }

    // iCast brand in header
    doc.font("Helvetica-Bold").fontSize(22).fillColor(WHITE)
      .text("iCast", 60, 22, { characterSpacing: 3 });

    doc.font("Helvetica").fontSize(8).fillColor(GOLD)
      .text("PODCAST INTELLIGENCE SYSTEM", 60, 50, { characterSpacing: 2.5 });

    // Classification badge
    doc.roundedRect(doc.page.width - 180, 20, 120, 26, 3).fill(GOLD);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(ACCENT)
      .text("OFFICIAL TRANSCRIPT", doc.page.width - 175, 29, { width: 110, align: "center" });

    // Thin gold rule
    doc.moveTo(60, 75).lineTo(doc.page.width - 60, 75)
      .lineWidth(1).strokeColor(GOLD).stroke();

    doc.font("Helvetica").fontSize(8).fillColor(RULE)
      .text("Classification: Public  ·  iCast AI System", 60, 82, { characterSpacing: 1 });

    // ── Metadata block ────────────────────────────────────────────────────
    const metaTop = 130;
    doc.rect(60, metaTop, W, 110).fill(BG_BAND);

    // Left border accent
    doc.rect(60, metaTop, 4, 110).fill(ACCENT2);

    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("PODCAST", 75, metaTop + 12, { characterSpacing: 1.5 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(DARK)
      .text(podcastTitle, 75, metaTop + 26, { width: W - 20 });

    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("EPISODE", 75, metaTop + 52, { characterSpacing: 1.5 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(DARK)
      .text(episodeTitle, 75, metaTop + 66, { width: W - 20 });

    // Metadata pills
    const pillTop = metaTop + 88;
    const dateStr = pubDate
      ? pubDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : "—";
    const durStr = duration ?? "—";
    const docId  = episodeId
      ? `TRX-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${episodeId.toString().padStart(3, "0")}`
      : `TRX-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

    const pills = [
      { label: "DATE",     value: dateStr },
      { label: "DURATION", value: durStr  },
      { label: "DOC ID",   value: docId   },
    ];
    let pillX = 75;
    for (const p of pills) {
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(p.label, pillX, pillTop, { characterSpacing: 1 });
      doc.font("Courier").fontSize(9).fillColor(ACCENT2)
        .text(p.value, pillX, pillTop + 11);
      pillX += 150;
    }

    // ── Section header ────────────────────────────────────────────────────
    const secTop = metaTop + 125;

    doc.moveTo(60, secTop).lineTo(60 + W, secTop)
      .lineWidth(1.5).strokeColor(ACCENT).stroke();

    doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT)
      .text("TRANSCRIPT CONTENT", 60, secTop + 8, { characterSpacing: 2.5 });

    doc.moveTo(60, secTop + 24).lineTo(60 + W, secTop + 24)
      .lineWidth(0.5).strokeColor(RULE).stroke();

    // ── Body text ─────────────────────────────────────────────────────────
    doc.font("Helvetica").fontSize(10.5).fillColor(DARK).moveDown(0.5);
    doc.y = secTop + 32;

    const paragraphs = transcript
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, " ").trim())
      .filter(Boolean);

    // Timestamp pattern: [HH:MM:SS] or [MM:SS]
    const tsPattern = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/;

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];

      // Extract optional timestamp
      const tsMatch = para.match(tsPattern);
      const timestamp = tsMatch?.[1];
      const textBody  = tsMatch ? para.slice(tsMatch[0].length) : para;

      // Speaker label heuristic
      const speakerMatch = textBody.match(/^([A-Z][A-Z\s\-\.]{1,30}):\s*/);

      if (timestamp) {
        doc.font("Courier").fontSize(8).fillColor(MUTED)
          .text(`[${timestamp}]`, { continued: Boolean(speakerMatch) });
      }

      if (speakerMatch) {
        const speaker = speakerMatch[1];
        const rest    = textBody.slice(speakerMatch[0].length);
        if (!timestamp) {
          doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT2).text(speaker + ":", { continued: false });
        } else {
          doc.font("Helvetica-Bold").fontSize(9).fillColor(ACCENT2)
            .text("  " + speaker + ":", { continued: false });
        }
        doc.font("Helvetica").fontSize(10.5).fillColor(DARK)
          .text(rest, { lineGap: 2, paragraphGap: 5, width: W });
      } else {
        doc.font("Helvetica").fontSize(10.5).fillColor(DARK)
          .text(textBody, { lineGap: 2, paragraphGap: 8, width: W });
      }

      if (i < paragraphs.length - 1) doc.moveDown(0.3);
    }

    // ── Footer on every page ──────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    const totalPages = range.count;

    for (let p = range.start; p < range.start + totalPages; p++) {
      doc.switchToPage(p);

      const bottom = doc.page.height - 55;

      // Footer rule
      doc.moveTo(60, bottom).lineTo(60 + W, bottom)
        .lineWidth(0.5).strokeColor(RULE).stroke();

      // Footer content
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text("Generated by iCast AI System", 60, bottom + 8,
              { width: W / 2, align: "left", characterSpacing: 0.3 });
      doc.text(`Page ${p + 1} of ${totalPages}`, 60, bottom + 8,
               { width: W, align: "right" });

      doc.font("Courier").fontSize(7).fillColor(MUTED)
        .text(`DOC-${episodeId ?? "0"}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
              60, bottom + 20, { width: W, align: "center" });

      // Bottom accent strip
      doc.rect(0, doc.page.height - 8, doc.page.width, 8).fill(ACCENT);
    }

    doc.end();
  });
}
